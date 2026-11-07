import type { DiagnosisResult } from "./gemini";
import {
  CALLER_FAILURE,
  DIAGNOSIS_FAILURE,
  DiagnosisError,
  type AnalysisFailureKind,
} from "./diagnosis-failure";

// docs/ai-plan.md §12.1–12.2: the fallback model starts when the main one is
// slow or fails; the whole analysis still has 45 s.
export const HEDGE_AFTER_MS = 12_000;
export const ANALYSIS_TIMEOUT_MS = 45_000;

// One diagnosis call against one model. The signal aborts it when the other
// attempt wins or the time runs out.
export type DiagnoseAttempt = (signal: AbortSignal) => Promise<DiagnosisResult>;

export type AttemptName = "primary" | "fallback";

export interface HedgedDiagnosis {
  result: DiagnosisResult;
  winner: AttemptName;
  hedged: boolean; // whether the fallback was started
}

export interface AttemptFailure {
  attempt: AttemptName;
  kind: AnalysisFailureKind;
  error: unknown;
}

// Every started attempt failed, or the time ran out first.
export class HedgeFailedError extends Error {
  constructor(
    readonly failures: AttemptFailure[],
    readonly timedOut: boolean,
    readonly hedged: boolean
  ) {
    super(timedOut ? "Diagnosis timed out" : "Every diagnosis attempt failed");
    this.name = "HedgeFailedError";
  }

  // The kind to log for the analysis as a whole.
  get kind(): AnalysisFailureKind {
    if (this.timedOut) return CALLER_FAILURE.TIMEOUT;
    return this.failures.at(-1)?.kind ?? CALLER_FAILURE.CRASHED;
  }
}

function failureKind(err: unknown): AnalysisFailureKind {
  return err instanceof DiagnosisError ? err.kind : CALLER_FAILURE.CRASHED;
}

// A bad request means our request or schema is wrong, so the fallback model
// would fail the same way.
function isBadRequest(err: unknown): boolean {
  return (
    err instanceof DiagnosisError && err.kind === DIAGNOSIS_FAILURE.BAD_REQUEST
  );
}

// Runs the primary attempt, and the fallback when the primary has not
// answered after hedgeAfterMs or fails with anything but a bad request. The
// first valid diagnosis wins and the other attempt is aborted. Without a
// fallback only the primary runs. Pure apart from the attempts and timers.
export function hedgedDiagnose(
  primary: DiagnoseAttempt,
  fallback: DiagnoseAttempt | null,
  { hedgeAfterMs = HEDGE_AFTER_MS, timeoutMs = ANALYSIS_TIMEOUT_MS } = {}
): Promise<HedgedDiagnosis> {
  return new Promise((resolve, reject) => {
    const aborts = {
      primary: new AbortController(),
      fallback: new AbortController(),
    };
    const failures: AttemptFailure[] = [];
    let running = 0;
    let hedged = false;
    let settled = false;

    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      clearTimeout(deadline);
      aborts.primary.abort();
      aborts.fallback.abort();
      outcome();
    };

    // Never rejects: every outcome goes through settle, and a loser's error
    // after the race is decided is ignored.
    const run = async (name: AttemptName, attempt: DiagnoseAttempt) => {
      running += 1;
      try {
        const result = await attempt(aborts[name].signal);
        settle(() => resolve({ result, winner: name, hedged }));
      } catch (err) {
        running -= 1;
        if (settled) return;
        failures.push({ attempt: name, kind: failureKind(err), error: err });
        if (name === "primary") {
          if (isBadRequest(err)) clearTimeout(hedgeTimer);
          else startFallback();
        }
        if (running === 0) {
          settle(() => reject(new HedgeFailedError(failures, false, hedged)));
        }
      }
    };

    const startFallback = () => {
      clearTimeout(hedgeTimer);
      if (!fallback || hedged || settled) return;
      hedged = true;
      void run("fallback", fallback);
    };

    const hedgeTimer = setTimeout(startFallback, hedgeAfterMs);
    const deadline = setTimeout(
      () => settle(() => reject(new HedgeFailedError(failures, true, hedged))),
      timeoutMs
    );
    void run("primary", primary);
  });
}
