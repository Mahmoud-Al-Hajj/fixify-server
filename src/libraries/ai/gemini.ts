import type { GoogleGenAI } from "@google/genai" with {
  "resolution-mode": "import",
};
import { env } from "../../config/env";
import {
  buildContent,
  SYSTEM_INSTRUCTION,
  type PromptMessage,
  type PromptPhoto,
} from "./diagnosis-prompt";
import {
  DIAGNOSIS_JSON_SCHEMA,
  diagnosisSchema,
  type Diagnosis,
} from "./diagnosis-schema";

// The only file that knows about Gemini: one Interactions call, then
// JSON.parse and zod. Retries and the timeout belong to the caller.

export const DIAGNOSIS_FAILURE = {
  RATE_LIMITED: "rate_limited",
  PROVIDER_ERROR: "provider_error",
  BAD_REQUEST: "bad_request",
  BLOCKED: "blocked",
  INVALID_OUTPUT: "invalid_output",
} as const;

export type DiagnosisFailureKind =
  (typeof DIAGNOSIS_FAILURE)[keyof typeof DIAGNOSIS_FAILURE];

export const THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface DiagnosisInput {
  messages: PromptMessage[];
  photos: PromptPhoto[];
}

// Production passes none; the replay script uses them to compare settings.
export interface DiagnoseOverrides {
  model?: string;
  thinkingLevel?: ThinkingLevel;
  maxOutputTokens?: number;
}

export interface TokenUsage {
  input: number | null;
  output: number | null;
  thinking: number | null;
}

export interface DiagnosisResult {
  model: string;
  diagnosis: Diagnosis;
  outputText: string;
  interactionStatus: string;
  usage: TokenUsage;
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

// One client for the process. The promise is cached, not the client, so
// concurrent first calls share one import and one client.
let clientPromise: Promise<GoogleGenAI> | null = null;

async function createClient(apiKey: string): Promise<GoogleGenAI> {
  // The SDK's type declarations are ESM-only, so this CommonJS project loads
  // it with a dynamic import.
  const sdk = await import("@google/genai");
  return new sdk.GoogleGenAI({ apiKey });
}

export async function diagnose(
  input: DiagnosisInput,
  overrides: DiagnoseOverrides = {}
): Promise<DiagnosisResult> {
  if (!env.gemini) {
    throw new Error(
      "AI is not configured: set GEMINI_API_KEY and GEMINI_MODEL"
    );
  }
  clientPromise ??= createClient(env.gemini.apiKey);
  const client = await clientPromise;
  const model = overrides.model ?? env.gemini.model;

  let interaction;
  try {
    interaction = await client.interactions.create(
      {
        model,
        system_instruction: SYSTEM_INSTRUCTION,
        input: buildContent(input.messages, input.photos),
        response_format: {
          type: "text",
          mime_type: "application/json",
          schema: DIAGNOSIS_JSON_SCHEMA,
        },
        ...generationConfig(overrides),
        store: false,
      },
      // The SDK retries 429 and 5xx by default; §12.2 allows no retry on 429,
      // and our own single retry is added by the caller (intake-analysis.ts).
      { retries: { strategy: "none" } }
    );
  } catch (err) {
    throw classifyCallError(err);
  }

  const outputText = interaction.output_text ?? "";
  const usage: TokenUsage = {
    input: interaction.usage?.total_input_tokens ?? null,
    output: interaction.usage?.total_output_tokens ?? null,
    thinking: interaction.usage?.total_thought_tokens ?? null,
  };
  const details: DiagnosisFailureDetails = {
    interactionStatus: interaction.status,
    outputText,
    usage,
  };

  // "incomplete" means the output was cut short (e.g. by the token cap):
  // that is invalid output, not a block, even when nothing came back.
  if (outputText.trim() === "" && interaction.status !== "incomplete") {
    throw new DiagnosisError(
      DIAGNOSIS_FAILURE.BLOCKED,
      `No output (status ${interaction.status})`,
      details
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(outputText);
  } catch (err) {
    throw new DiagnosisError(
      DIAGNOSIS_FAILURE.INVALID_OUTPUT,
      `Output is not valid JSON (status ${interaction.status})`,
      details,
      { cause: err }
    );
  }

  const result = diagnosisSchema.safeParse(parsed);
  if (!result.success) {
    throw new DiagnosisError(
      DIAGNOSIS_FAILURE.INVALID_OUTPUT,
      "Output does not match the diagnosis schema",
      {
        ...details,
        issuePaths: result.error.issues.map((i) => i.path.join(".")),
      }
    );
  }

  return {
    model,
    diagnosis: result.data,
    outputText,
    interactionStatus: interaction.status,
    usage,
  };
}

function generationConfig(overrides: DiagnoseOverrides) {
  const { thinkingLevel, maxOutputTokens } = overrides;
  if (thinkingLevel === undefined && maxOutputTokens === undefined) return {};
  return {
    generation_config: {
      thinking_level: thinkingLevel,
      max_output_tokens: maxOutputTokens,
    },
  };
}

// The SDK's error classes are not exported, so errors are recognised by their
// numeric status, and connection failures by name. Anything else (including
// an abort) is rethrown untouched for the caller to treat as a crash.
function classifyCallError(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  if ("status" in err && typeof err.status === "number") {
    const httpStatus = err.status;
    const kind =
      httpStatus === 429
        ? DIAGNOSIS_FAILURE.RATE_LIMITED
        : httpStatus >= 400 && httpStatus < 500
          ? DIAGNOSIS_FAILURE.BAD_REQUEST
          : DIAGNOSIS_FAILURE.PROVIDER_ERROR;
    return new DiagnosisError(
      kind,
      `${httpStatus} ${providerMessage(err)}`,
      { httpStatus },
      { cause: err }
    );
  }
  if (
    err.name === "APIConnectionError" ||
    err.name === "APIConnectionTimeoutError"
  ) {
    return new DiagnosisError(
      DIAGNOSIS_FAILURE.PROVIDER_ERROR,
      err.message,
      {},
      { cause: err }
    );
  }
  return err;
}

// The SDK's own message is generic; Google's reason (e.g. "API key not
// valid") is in the response body, as { error: { message } } or an array of
// those.
function providerMessage(err: Error): string {
  if (!("body" in err) || typeof err.body !== "string") return err.message;
  let payload: unknown;
  try {
    payload = JSON.parse(err.body);
  } catch {
    return err.message;
  }
  const entry: unknown = Array.isArray(payload) ? payload[0] : payload;
  return isRecord(entry) &&
    isRecord(entry.error) &&
    typeof entry.error.message === "string"
    ? entry.error.message
    : err.message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
