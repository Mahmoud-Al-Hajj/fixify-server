import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import type { DiagnosisResult } from "./gemini";
import {
  DIAGNOSIS_FAILURE,
  DiagnosisError,
  type DiagnosisFailureKind,
} from "./diagnosis-failure";
import {
  hedgedDiagnose,
  HedgeFailedError,
  type DiagnoseAttempt,
  type HedgedDiagnosis,
} from "./hedged-diagnose";

// Fake time: every setTimeout (the hedge's and the fake attempts') is driven
// by advance().
let clock = 0;
beforeEach(() => {
  clock = 0;
  mock.timers.enable({ apis: ["setTimeout"] });
});
afterEach(() => mock.timers.reset());

async function advance(ms: number): Promise<void> {
  clock += ms;
  mock.timers.tick(ms);
  // Let the promise callbacks the timers triggered run (setImmediate is real).
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

const resultFrom = (model: string): DiagnosisResult => ({
  model,
  diagnosis: {
    title: "Likely worn seal",
    confidence: "medium",
    category: "Plumber",
    serviceType: "repair",
    durationMinutes: 60,
    explanation: "The seal is probably worn.",
    isUrgent: true,
    safetyNote: null,
    suggestedParts: [],
  },
  outputText: "{}",
  interactionStatus: "completed",
  usage: { input: null, output: null, thinking: null },
});

const failure = (kind: DiagnosisFailureKind) =>
  new DiagnosisError(kind, `fake ${kind}`);

// An attempt that answers (or fails) `after` ms after it starts, unless it is
// aborted first. Records when it started and its signal.
function fakeAttempt(
  after: number,
  outcome: { answer: string } | { fail: unknown }
) {
  const seen = {
    startedAt: null as number | null,
    signal: null as AbortSignal | null,
  };
  const attempt: DiagnoseAttempt = (signal) => {
    seen.startedAt = clock;
    seen.signal = signal;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if ("answer" in outcome) resolve(resultFrom(outcome.answer));
        else reject(outcome.fail);
      }, after);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      });
    });
  };
  return { attempt, seen };
}

function track(promise: Promise<HedgedDiagnosis>) {
  const state: { value?: HedgedDiagnosis; error?: unknown } = {};
  promise.then(
    (value) => (state.value = value),
    (error: unknown) => (state.error = error)
  );
  return state;
}

function hedgeFailure(error: unknown): HedgeFailedError {
  assert.ok(error instanceof HedgeFailedError, "expected a HedgeFailedError");
  return error;
}

test("a fast primary wins and the fallback never starts", async () => {
  const a = fakeAttempt(1_000, { answer: "main" });
  const b = fakeAttempt(1_000, { answer: "fallback" });
  const state = track(hedgedDiagnose(a.attempt, b.attempt));
  await advance(1_000);
  assert.equal(state.value?.winner, "primary");
  assert.equal(state.value?.result.model, "main");
  assert.equal(state.value?.hedged, false);
  await advance(60_000);
  assert.equal(b.seen.startedAt, null);
});

test("a slow primary: the fallback starts at 12 s, wins, and the primary is aborted", async () => {
  const a = fakeAttempt(30_000, { answer: "main" });
  const b = fakeAttempt(3_000, { answer: "fallback" });
  const state = track(hedgedDiagnose(a.attempt, b.attempt));
  await advance(11_999);
  assert.equal(b.seen.startedAt, null);
  await advance(1);
  assert.equal(b.seen.startedAt, 12_000);
  await advance(3_000);
  assert.equal(state.value?.winner, "fallback");
  assert.equal(state.value?.result.model, "fallback");
  assert.equal(state.value?.hedged, true);
  assert.equal(a.seen.signal?.aborted, true);
});

test("a primary 503 starts the fallback at once", async () => {
  const a = fakeAttempt(2_000, {
    fail: failure(DIAGNOSIS_FAILURE.PROVIDER_ERROR),
  });
  const b = fakeAttempt(1_000, { answer: "fallback" });
  const state = track(hedgedDiagnose(a.attempt, b.attempt));
  await advance(2_000);
  assert.equal(b.seen.startedAt, 2_000);
  await advance(1_000);
  assert.equal(state.value?.winner, "fallback");
  assert.equal(state.value?.hedged, true);
});

test("a primary bad request fails without starting the fallback", async () => {
  const a = fakeAttempt(2_000, {
    fail: failure(DIAGNOSIS_FAILURE.BAD_REQUEST),
  });
  const b = fakeAttempt(1_000, { answer: "fallback" });
  const state = track(hedgedDiagnose(a.attempt, b.attempt));
  await advance(2_000);
  const error = hedgeFailure(state.error);
  assert.deepEqual(
    error.failures.map((f) => [f.attempt, f.kind]),
    [["primary", "bad_request"]]
  );
  assert.equal(error.hedged, false);
  await advance(60_000);
  assert.equal(b.seen.startedAt, null);
});

test("both attempts fail: the analysis fails with both kinds", async () => {
  const a = fakeAttempt(1_000, {
    fail: failure(DIAGNOSIS_FAILURE.PROVIDER_ERROR),
  });
  const b = fakeAttempt(500, { fail: failure(DIAGNOSIS_FAILURE.RATE_LIMITED) });
  const state = track(hedgedDiagnose(a.attempt, b.attempt));
  await advance(1_000);
  assert.equal(state.error, undefined);
  await advance(500);
  const error = hedgeFailure(state.error);
  assert.deepEqual(
    error.failures.map((f) => [f.attempt, f.kind]),
    [
      ["primary", "provider_error"],
      ["fallback", "rate_limited"],
    ]
  );
  assert.equal(error.timedOut, false);
  assert.equal(error.hedged, true);
  assert.equal(error.kind, "rate_limited");
});

test("no fallback: only the primary runs, slow or failing", async () => {
  const slow = fakeAttempt(20_000, { answer: "main" });
  const answered = track(hedgedDiagnose(slow.attempt, null));
  await advance(20_000);
  assert.equal(answered.value?.winner, "primary");
  assert.equal(answered.value?.hedged, false);

  const failing = fakeAttempt(1_000, {
    fail: failure(DIAGNOSIS_FAILURE.PROVIDER_ERROR),
  });
  const failed = track(hedgedDiagnose(failing.attempt, null));
  await advance(1_000);
  const error = hedgeFailure(failed.error);
  assert.equal(error.hedged, false);
  assert.equal(error.kind, "provider_error");
});

test("at 45 s the analysis times out and both attempts are aborted", async () => {
  const a = fakeAttempt(100_000, { answer: "main" });
  const b = fakeAttempt(100_000, { answer: "fallback" });
  const state = track(hedgedDiagnose(a.attempt, b.attempt));
  await advance(44_999);
  assert.equal(state.error, undefined);
  await advance(1);
  const error = hedgeFailure(state.error);
  assert.equal(error.timedOut, true);
  assert.equal(error.kind, "timeout");
  assert.equal(a.seen.signal?.aborted, true);
  assert.equal(b.seen.signal?.aborted, true);
});

test("an unexpected error in the primary counts as crashed and starts the fallback", async () => {
  const a = fakeAttempt(1_000, { fail: new TypeError("boom") });
  const b = fakeAttempt(1_000, { answer: "fallback" });
  const state = track(hedgedDiagnose(a.attempt, b.attempt));
  await advance(1_000);
  assert.equal(b.seen.startedAt, 1_000);
  await advance(1_000);
  assert.equal(state.value?.winner, "fallback");
});
