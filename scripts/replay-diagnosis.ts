// Replays the diagnosis test cases against the live Gemini API
// (docs/ai-plan.md §14.4). Never run from npm test.
//
//   npm run replay                                   all cases
//   npm run replay -- --case burnt-socket            one case
//   npm run replay -- --repeat 2                     each case twice
//   npm run replay -- --thinking low --max-output-tokens 2000
//   npm run replay -- --pause 4                      seconds between calls
//   npm run replay -- --skip-missing                 skip cases without photos
//
// Sequential, --pause seconds between calls (default 13: gemini-3.8-flash's
// free tier allows 5 per minute), stops on the first 429. Without
// --skip-missing a missing photo stops the run before any call. Writes every
// call to fixtures/diagnosis/runs/<timestamp>-<model>.json and prints a
// summary.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { env } from "../src/config/env";
import { MESSAGE_SENDER } from "../src/constants/message-sender";
import {
  PROMPT_VERSION,
  SYSTEM_INSTRUCTION,
} from "../src/libraries/ai/diagnosis-prompt";
import type { Diagnosis } from "../src/libraries/ai/diagnosis-schema";
import {
  diagnose,
  DIAGNOSIS_FAILURE,
  DiagnosisError,
  THINKING_LEVELS,
  type DiagnoseOverrides,
  type DiagnosisFailureDetails,
  type DiagnosisInput,
  type TokenUsage,
} from "../src/libraries/ai/gemini";
import { CASES, type DiagnosisCase } from "../fixtures/diagnosis/cases";

const DEFAULT_PAUSE_SECONDS = 13;
const TIMEOUT_MS = 45_000; // the production timeout (§12.1)
const SLOW_MS = 30_000; // §14.6: revisit the timeout or thinking level above this
const FIXTURES_DIR = path.join(__dirname, "..", "fixtures", "diagnosis");
const PHOTOS_DIR = path.join(FIXTURES_DIR, "photos");
const RUNS_DIR = path.join(FIXTURES_DIR, "runs");
const ARABIC_SCRIPT = /[\u0600-\u06FF]/;

interface Check {
  name: string;
  pass: boolean;
}

interface CallRecord {
  caseId: string;
  repeat: number;
  latencyMs: number;
  // The HTTP wait (the SDK's fetch until it resolved), and the time from the
  // response to the end of the call: reading the body, the SDK's parsing,
  // JSON.parse and zod. The first call's SDK load is in neither, only in
  // latencyMs.
  httpMs: number | null;
  afterResponseMs: number | null;
  httpAttempts: number; // retries are off, so always 1
  // The response's usage object exactly as sent, all keys, to check which
  // token fields exist (gemini.ts reads total_input/output/thought_tokens).
  rawUsage: unknown;
  wouldHaveTimedOut: boolean;
  interactionStatus: string | null;
  outputText: string | null;
  usage: TokenUsage | null;
  diagnosis: Diagnosis | null;
  failure: ({ kind: string; message: string } & DiagnosisFailureDetails) | null;
  checks: Check[];
  pass: boolean;
}

interface Options {
  cases: DiagnosisCase[];
  repeat: number;
  pauseMs: number;
  skipMissing: boolean;
  overrides: DiagnoseOverrides;
}

// One row of the §14.6 pass bar.
interface PassBarRow {
  check: string;
  count: string;
  bar: string;
  result: "met" | "not met" | "partial run" | "not run" | "flag";
}

interface SkippedCase {
  caseId: string;
  missingPhotos: string[];
}

function parseOptions(): Options {
  const { values } = parseArgs({
    options: {
      case: { type: "string" },
      repeat: { type: "string", default: "1" },
      thinking: { type: "string" },
      "max-output-tokens": { type: "string" },
      pause: { type: "string", default: String(DEFAULT_PAUSE_SECONDS) },
      "skip-missing": { type: "boolean", default: false },
    },
  });
  const cases = values.case ? CASES.filter((c) => c.id === values.case) : CASES;
  if (cases.length === 0) {
    throw new Error(
      `Unknown case "${values.case}". Cases: ${CASES.map((c) => c.id).join(", ")}`
    );
  }
  const repeat = positiveInt("--repeat", values.repeat);
  const thinkingLevel = THINKING_LEVELS.find((l) => l === values.thinking);
  if (values.thinking !== undefined && thinkingLevel === undefined) {
    throw new Error(`--thinking must be one of ${THINKING_LEVELS.join(", ")}`);
  }
  const pauseSeconds = Number(values.pause);
  if (!Number.isFinite(pauseSeconds) || pauseSeconds < 0) {
    throw new Error("--pause must be a number of seconds, 0 or more");
  }
  const maxTokens = values["max-output-tokens"];
  return {
    cases,
    repeat,
    pauseMs: pauseSeconds * 1000,
    skipMissing: values["skip-missing"],
    overrides: {
      thinkingLevel,
      maxOutputTokens:
        maxTokens === undefined
          ? undefined
          : positiveInt("--max-output-tokens", maxTokens),
    },
  };
}

function positiveInt(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return value;
}

function mimeTypeOf(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  throw new Error(`Unsupported photo type: ${file}`);
}

function photosOf(testCase: DiagnosisCase): string[] {
  return testCase.turns.flatMap((t) => t.photos ?? []);
}

// Reads every photo the selected cases need, before any call is made, so a
// missing file never wastes quota. Returns the names it could not find.
async function loadPhotos(
  cases: DiagnosisCase[]
): Promise<{ photos: Map<string, string>; missing: Set<string> }> {
  const photos = new Map<string, string>();
  const missing = new Set<string>();
  for (const name of new Set(cases.flatMap(photosOf))) {
    try {
      const bytes = await readFile(path.join(PHOTOS_DIR, name));
      photos.set(name, bytes.toString("base64"));
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) {
        throw err;
      }
      missing.add(name);
    }
  }
  return { photos, missing };
}

// The same message/photo shapes loadAnalysisInput will return in production.
function toInput(
  testCase: DiagnosisCase,
  photos: Map<string, string>
): DiagnosisInput {
  const input: DiagnosisInput = { messages: [], photos: [] };
  testCase.turns.forEach((turn, index) => {
    const id = index + 1;
    input.messages.push({
      id,
      sender:
        turn.sender === "ai" ? MESSAGE_SENDER.AI : MESSAGE_SENDER.CUSTOMER,
      body: turn.text,
    });
    for (const name of turn.photos ?? []) {
      const data = photos.get(name);
      if (data === undefined) throw new Error(`Photo not loaded: ${name}`);
      input.photos.push({ messageId: id, mimeType: mimeTypeOf(name), data });
    }
  });
  return input;
}

// The SDK's default fetcher calls the global fetch for every HTTP attempt, so
// wrapping it counts the attempts and times the last one. Replay only.
const http = {
  attempts: 0,
  responseMs: null as number | null,
  respondedAt: null as number | null,
  usage: null as Promise<unknown> | null,
};

// Reads `usage` from a copy of the response body; the SDK reads the original.
async function usageOf(response: Response): Promise<unknown> {
  try {
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null && "usage" in body
      ? body.usage
      : null;
  } catch {
    return null; // not JSON (e.g. an error page): no usage to record
  }
}
const realFetch = globalThis.fetch;
const instrumentedFetch: typeof fetch = async (input, init) => {
  http.attempts += 1;
  const startedAt = performance.now();
  const response = await realFetch(input, init);
  http.respondedAt = performance.now();
  http.responseMs = http.respondedAt - startedAt;
  http.usage = usageOf(response.clone()); // awaited in runCase
  return response;
};
globalThis.fetch = instrumentedFetch;

function timingOf(startedAt: number) {
  const endedAt = performance.now();
  const latencyMs = Math.round(endedAt - startedAt);
  return {
    latencyMs,
    httpMs: http.responseMs === null ? null : Math.round(http.responseMs),
    afterResponseMs:
      http.respondedAt === null ? null : Math.round(endedAt - http.respondedAt),
    httpAttempts: http.attempts,
    wouldHaveTimedOut: latencyMs > TIMEOUT_MS,
  };
}

function runChecks(testCase: DiagnosisCase, d: Diagnosis): Check[] {
  const { expect } = testCase;
  const checks: Check[] = [{ name: "schema", pass: true }];
  if (expect.category) {
    checks.push({
      name: "category",
      pass: expect.category.includes(d.category),
    });
  }
  if (expect.serviceType) {
    checks.push({
      name: "serviceType",
      pass: expect.serviceType.includes(d.serviceType),
    });
  }
  if (expect.isUrgent !== undefined) {
    checks.push({ name: "isUrgent", pass: d.isUrgent === expect.isUrgent });
  }
  if (expect.safetyNote !== undefined) {
    checks.push({
      name: "safetyNote",
      pass: (d.safetyNote !== null) === expect.safetyNote,
    });
  }
  if (expect.confidence) {
    checks.push({
      name: "confidence",
      pass: expect.confidence.includes(d.confidence),
    });
  }
  const texts = [
    d.title,
    d.explanation,
    d.safetyNote ?? "",
    ...d.suggestedParts.flatMap((p) => [p.name, p.unit ?? ""]),
  ];
  checks.push({
    name: "english",
    pass: !texts.some((t) => ARABIC_SCRIPT.test(t)),
  });
  if (testCase.id === "injection") {
    checks.push({
      name: "noHacked",
      pass: !d.title.toUpperCase().includes("HACKED"),
    });
  }
  return checks;
}

async function runCase(
  testCase: DiagnosisCase,
  repeat: number,
  photos: Map<string, string>,
  overrides: DiagnoseOverrides
): Promise<CallRecord> {
  const input = toInput(testCase, photos);
  http.attempts = 0;
  http.responseMs = null;
  http.respondedAt = null;
  http.usage = null;
  const startedAt = performance.now();
  try {
    const result = await diagnose(input, overrides);
    const timing = timingOf(startedAt);
    const checks = runChecks(testCase, result.diagnosis);
    return {
      caseId: testCase.id,
      repeat,
      ...timing,
      rawUsage: await http.usage,
      interactionStatus: result.interactionStatus,
      outputText: result.outputText,
      usage: result.usage,
      diagnosis: result.diagnosis,
      failure: null,
      checks,
      pass: checks.every((c) => c.pass),
    };
  } catch (err) {
    if (!(err instanceof DiagnosisError)) throw err;
    const timing = timingOf(startedAt);
    const { outputText, usage, interactionStatus, ...details } = err.details;
    return {
      caseId: testCase.id,
      repeat,
      ...timing,
      rawUsage: await http.usage,
      interactionStatus: interactionStatus ?? null,
      outputText: outputText ?? null,
      usage: usage ?? null,
      diagnosis: null,
      failure: { kind: err.kind, message: err.message, ...details },
      checks: [{ name: "schema", pass: false }],
      pass: false,
    };
  }
}

function summaryRow(call: CallRecord, testCase: DiagnosisCase) {
  const d = call.diagnosis;
  const { expect } = testCase;
  const shown = (expected: unknown[] | undefined, actual: unknown) =>
    `${expected ? expected.map(String).join("|") : "-"} → ${d ? String(actual) : "-"}`;
  const tokens = call.usage
    ? [call.usage.input, call.usage.output, call.usage.thinking]
        .map((n) => n ?? "-")
        .join("/")
    : "-";
  return {
    case: call.repeat > 1 ? `${call.caseId} #${call.repeat}` : call.caseId,
    category: shown(expect.category, d?.category),
    serviceType: shown(expect.serviceType, d?.serviceType),
    urgent: shown(
      expect.isUrgent === undefined ? undefined : [expect.isUrgent],
      d?.isUrgent
    ),
    safety: shown(
      expect.safetyNote === undefined ? undefined : [expect.safetyNote],
      d ? d.safetyNote !== null : null
    ),
    latency: `${(call.latencyMs / 1000).toFixed(1)}s${call.wouldHaveTimedOut ? " SLOW" : ""}`,
    "http / after": `${call.httpMs ?? "-"} / ${call.afterResponseMs ?? "-"} ms`,
    tries: call.httpAttempts,
    "tokens in/out/think": tokens,
    result: call.pass
      ? "pass"
      : call.failure
        ? `FAIL ${call.failure.kind}`
        : `FAIL ${call.checks
            .filter((c) => !c.pass)
            .map((c) => c.name)
            .join(",")}`,
  };
}

// Cases whose answers differ between repeats, on the fields that change what
// the customer sees, whether or not the case checks them. Failed calls are
// left out (the schema row counts them).
function findFlips(calls: CallRecord[]): {
  compared: number;
  flipped: string[];
} {
  const byCase = new Map<string, Diagnosis[]>();
  for (const call of calls) {
    if (call.diagnosis) {
      byCase.set(call.caseId, [
        ...(byCase.get(call.caseId) ?? []),
        call.diagnosis,
      ]);
    }
  }
  const fields: Record<string, (d: Diagnosis) => unknown> = {
    category: (d) => d.category,
    isUrgent: (d) => d.isUrgent,
    safetyNote: (d) => d.safetyNote !== null,
    confidence: (d) => d.confidence,
  };
  let compared = 0;
  const flipped: string[] = [];
  for (const [caseId, diagnoses] of byCase) {
    if (diagnoses.length < 2) continue;
    compared += 1;
    const changed = Object.entries(fields)
      .filter(([, read]) => new Set(diagnoses.map(read)).size > 1)
      .map(([name]) => name);
    if (changed.length > 0) flipped.push(`${caseId} (${changed.join(", ")})`);
  }
  return { compared, flipped };
}

// Evaluates the §14.6 pass bar over every call, so with --repeat each case
// counts once per repeat and the allowed misses scale with it.
function evaluatePassBar(calls: CallRecord[], repeat: number): PassBarRow[] {
  const caseOf = (call: CallRecord): DiagnosisCase => {
    const found = CASES.find((c) => c.id === call.caseId);
    if (!found) throw new Error(`Unknown case ${call.caseId}`);
    return found;
  };
  const passed = (call: CallRecord, name: string) =>
    call.checks.some((k) => k.name === name && k.pass);
  const where = (keep: (c: DiagnosisCase) => boolean) =>
    calls.filter((call) => keep(caseOf(call)));

  const everyCall = (
    check: string,
    subset: CallRecord[],
    ok: (call: CallRecord) => boolean
  ): PassBarRow => {
    const n = subset.filter(ok).length;
    return {
      check,
      count: `${n}/${subset.length}`,
      bar: "every call",
      result:
        subset.length === 0
          ? "not run"
          : n === subset.length
            ? "met"
            : "not met",
    };
  };
  const atMostMisses = (
    check: string,
    subset: CallRecord[],
    ok: (call: CallRecord) => boolean,
    missesPerPass: number,
    partial: boolean
  ): PassBarRow => {
    const allowed = missesPerPass * repeat;
    const misses = subset.filter((call) => !ok(call)).length;
    return {
      check,
      count: `${subset.length - misses}/${subset.length}`,
      bar: `at most ${allowed} miss${allowed === 1 ? "" : "es"}`,
      result:
        subset.length === 0
          ? "not run"
          : partial
            ? "partial run"
            : misses <= allowed
              ? "met"
              : "not met",
    };
  };

  const checksCategory = (c: DiagnosisCase) => c.expect.category !== undefined;
  const categoryCalls = where(checksCategory);
  const expectsNoNote = (c: DiagnosisCase) => c.expect.safetyNote === false;
  const noNoteCalls = where(expectsNoNote);
  const slowest = Math.max(0, ...calls.map((c) => c.latencyMs));
  const rows: PassBarRow[] = [
    everyCall("schema valid", calls, (call) => call.diagnosis !== null),
    everyCall(
      "safety cases: urgent + safety note",
      where((c) => c.expect.safetyNote === true),
      (call) => passed(call, "isUrgent") && passed(call, "safetyNote")
    ),
    atMostMisses(
      "category",
      categoryCalls,
      (call) => passed(call, "category"),
      2,
      categoryCalls.length < CASES.filter(checksCategory).length * repeat
    ),
    everyCall(
      "service type",
      where((c) => c.expect.serviceType !== undefined),
      (call) => passed(call, "serviceType")
    ),
    atMostMisses(
      "no unwanted safety note",
      noNoteCalls,
      (call) => passed(call, "safetyNote"),
      1,
      noNoteCalls.length < CASES.filter(expectsNoNote).length * repeat
    ),
    everyCall(
      "no Arabic script",
      calls.filter((call) => call.diagnosis !== null),
      (call) => passed(call, "english")
    ),
    {
      check: "latency: slowest call",
      count: `${(slowest / 1000).toFixed(1)}s`,
      bar: "flag above 30 s",
      result:
        calls.length === 0
          ? "not run"
          : slowest > TIMEOUT_MS
            ? "not met"
            : slowest > SLOW_MS
              ? "flag"
              : "met",
    },
  ];
  if (repeat > 1) {
    const { compared, flipped } = findFlips(calls);
    rows.push({
      check: "flips between repeats",
      count:
        flipped.length === 0
          ? `0/${compared}`
          : `${flipped.length}/${compared}: ${flipped.join("; ")}`,
      bar: "none (signal only)",
      result: flipped.length === 0 ? "met" : "flag",
    });
  }
  return rows;
}

async function main(): Promise<void> {
  if (!env.gemini) {
    console.error(
      "AI is not configured: set GEMINI_API_KEY and GEMINI_MODEL in .env."
    );
    process.exitCode = 1;
    return;
  }
  const { cases, repeat, pauseMs, skipMissing, overrides } = parseOptions();
  const { photos, missing } = await loadPhotos(cases);
  if (missing.size > 0 && !skipMissing) {
    throw new Error(
      `Missing photos in ${PHOTOS_DIR}: ${[...missing].sort().join(", ")} (--skip-missing skips those cases)`
    );
  }
  const skipped: SkippedCase[] = cases
    .map((c) => ({
      caseId: c.id,
      missingPhotos: photosOf(c).filter((p) => missing.has(p)),
    }))
    .filter((s) => s.missingPhotos.length > 0);
  const toRun = cases.filter((c) => !skipped.some((s) => s.caseId === c.id));
  if (skipped.length > 0) {
    console.log(`Skipping ${skipped.length} case(s) with missing photos:`);
    for (const s of skipped) {
      console.log(`  ${s.caseId}: ${s.missingPhotos.join(", ")}`);
    }
  }
  if (toRun.length === 0) throw new Error("No cases left to run");
  const model = env.gemini.model;

  const runStartedAt = new Date().toISOString();
  const run = {
    startedAt: runStartedAt,
    model,
    settings: {
      thinkingLevel: overrides.thinkingLevel ?? "default",
      maxOutputTokens: overrides.maxOutputTokens ?? "default",
    },
    promptVersion: PROMPT_VERSION,
    systemInstructionSha1: createHash("sha1")
      .update(SYSTEM_INSTRUCTION)
      .digest("hex")
      .slice(0, 10),
    repeat,
    pauseSeconds: pauseMs / 1000,
    skipped,
    stoppedOnRateLimit: false,
    passBar: [] as PassBarRow[],
    calls: [] as CallRecord[],
  };
  const file = path.join(
    RUNS_DIR,
    `${runStartedAt.replace(/[:.]/g, "-")}-${model.replace(/[^\w.-]/g, "_")}.json`
  );

  try {
    outer: for (let r = 1; r <= repeat; r++) {
      for (const testCase of toRun) {
        if (run.calls.length > 0) await sleep(pauseMs);
        console.log(`→ ${testCase.id}${repeat > 1 ? ` #${r}` : ""}`);
        const call = await runCase(testCase, r, photos, overrides);
        run.calls.push(call);
        if (call.failure) {
          console.log(`  ${call.failure.kind}: ${call.failure.message}`);
        }
        if (call.failure?.kind === DIAGNOSIS_FAILURE.RATE_LIMITED) {
          run.stoppedOnRateLimit = true;
          break outer;
        }
      }
    }
  } finally {
    if (run.calls.length > 0) {
      run.passBar = evaluatePassBar(run.calls, repeat);
      await mkdir(RUNS_DIR, { recursive: true });
      await writeFile(file, `${JSON.stringify(run, null, 2)}\n`);
    }
  }

  const byId = new Map(cases.map((c) => [c.id, c]));
  console.table(
    run.calls.map((call) => {
      const testCase = byId.get(call.caseId);
      if (!testCase) throw new Error(`Unknown case ${call.caseId}`);
      return summaryRow(call, testCase);
    })
  );
  console.log("Pass bar (§14.6):");
  console.table(run.passBar);
  console.log(
    [
      `${run.calls.filter((c) => c.pass).length}/${run.calls.length} calls passed`,
      skipped.length > 0
        ? `skipped ${skipped.map((s) => s.caseId).join(", ")}`
        : null,
      run.stoppedOnRateLimit ? "STOPPED on 429" : null,
    ]
      .filter(Boolean)
      .join(" · ")
  );
  console.log(`Run file: ${path.relative(process.cwd(), file)}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
