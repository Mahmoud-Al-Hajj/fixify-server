// How a diagnosis can fail. Kept apart from gemini.ts, which loads the config
// module, so the hedge and its tests can use these without an environment.

// Thrown by gemini.ts.
export const DIAGNOSIS_FAILURE = {
  RATE_LIMITED: "rate_limited",
  PROVIDER_ERROR: "provider_error",
  BAD_REQUEST: "bad_request",
  BLOCKED: "blocked",
  INVALID_OUTPUT: "invalid_output",
} as const;

export type DiagnosisFailureKind =
  (typeof DIAGNOSIS_FAILURE)[keyof typeof DIAGNOSIS_FAILURE];

// Added by the caller: the time ran out, or an attempt threw something other
// than a DiagnosisError.
export const CALLER_FAILURE = {
  TIMEOUT: "timeout",
  CRASHED: "crashed",
} as const;

export type AnalysisFailureKind =
  DiagnosisFailureKind | (typeof CALLER_FAILURE)[keyof typeof CALLER_FAILURE];

export interface TokenUsage {
  input: number | null;
  output: number | null;
  thinking: number | null;
}

export interface DiagnosisFailureDetails {
  httpStatus?: number;
  interactionStatus?: string;
  outputText?: string;
  usage?: TokenUsage;
  issuePaths?: string[];
}

export class DiagnosisError extends Error {
  constructor(
    readonly kind: DiagnosisFailureKind,
    message: string,
    readonly details: DiagnosisFailureDetails = {},
    options?: { cause: unknown }
  ) {
    super(message, options);
    this.name = "DiagnosisError";
  }
}
