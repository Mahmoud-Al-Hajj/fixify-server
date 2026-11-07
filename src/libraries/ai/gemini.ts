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
import {
  DIAGNOSIS_FAILURE,
  DiagnosisError,
  type DiagnosisFailureDetails,
  type TokenUsage,
} from "./diagnosis-failure";

// The only file that knows about Gemini: one Interactions call, then
// JSON.parse and zod. The hedge and the timeout belong to the caller.

export const THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

// The settings chosen in docs/ai-plan.md §14.7. max_output_tokens includes
// thinking tokens.
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "low";
export const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

export interface DiagnosisInput {
  messages: PromptMessage[];
  photos: PromptPhoto[];
}

// Production passes only the model (the hedge's fallback); the replay script
// uses the rest to compare settings.
export interface DiagnoseOverrides {
  model?: string;
  thinkingLevel?: ThinkingLevel;
  maxOutputTokens?: number;
}

export interface DiagnosisResult {
  model: string;
  diagnosis: Diagnosis;
  outputText: string;
  interactionStatus: string;
  usage: TokenUsage;
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

// `signal` aborts the call (the hedge's other attempt won, or the time ran
// out); the aborted call rejects with the SDK's own error, not a
// DiagnosisError.
export async function diagnose(
  input: DiagnosisInput,
  overrides: DiagnoseOverrides = {},
  signal?: AbortSignal
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
        generation_config: {
          thinking_level: overrides.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
          max_output_tokens:
            overrides.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        },
        store: false,
      },
      // The SDK retries 429 and 5xx by default; §12.2 allows none: the
      // caller hedges to the fallback model instead (hedged-diagnose.ts).
      { retries: { strategy: "none" }, signal }
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

// The SDK's error classes are not exported, so errors are recognised by their
// numeric status, and connection failures by name. Only 400 means our request
// or schema is wrong, which the fallback model would repeat; other 4xx (e.g.
// an unknown model name) are provider errors, so the hedge tries the fallback.
// Anything else (including an abort) is rethrown untouched for the caller.
function classifyCallError(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  if ("status" in err && typeof err.status === "number") {
    const httpStatus = err.status;
    const kind =
      httpStatus === 429
        ? DIAGNOSIS_FAILURE.RATE_LIMITED
        : httpStatus === 400
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
