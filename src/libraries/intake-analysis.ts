import { readFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { withTransaction } from "../models-db/pool";
import { beirutNow } from "../models-db/format-datetime";
import {
  findIntakeSession,
  insertIntakeMessage,
  listIntakeMessages,
  markAnalysisDone,
  markAnalysisFailed,
  sessionHasCustomerText,
  startAnalysisAttempt,
} from "../models-db/intake";
import { AI_STATUS, type AiStatus } from "../constants/ai-status";
import { MESSAGE_SENDER } from "../constants/message-sender";
import {
  ConflictError,
  ERROR_CODE,
  NotFoundError,
  ServiceUnavailableError,
  TooManyRequestsError,
  ValidationError,
} from "../constants/errors";
import { INTAKE_PHOTO_DIR, loadOwnSession } from "./intake";
import { UPLOADS_DIR } from "./photo-files";
import { diagnose, type DiagnosisInput } from "./ai/gemini";
import { hedgedDiagnose, HedgeFailedError } from "./ai/hedged-diagnose";
import { PROMPT_VERSION } from "./ai/diagnosis-prompt";
import type { StoredDiagnosis } from "./ai/diagnosis-schema";
import { CALLER_FAILURE, DiagnosisError } from "./ai/diagnosis-failure";

// The intake diagnosis (docs/ai-plan.md §2.4, §12): started by the customer,
// run in the background, settled as done or failed on the session row.

const MAX_ANALYSIS_ATTEMPTS = 3;
const MAX_PHOTOS_PER_ANALYSIS = 6;
const RAW_OUTPUT_LOG_BYTES = 2048;
const INTAKE_PHOTO_ROOT = path.resolve(UPLOADS_DIR, INTAKE_PHOTO_DIR);
const MIME_TYPE_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".png": "image/png",
};

type GeminiConfig = NonNullable<typeof env.gemini>;

// Checks in this order, so another customer's session gets the same answer
// as a missing one. The analysis itself is not awaited: the caller answers
// 202 and the client polls the session.
export async function startAnalysis(
  sessionId: string,
  customerId: string
): Promise<AiStatus> {
  const gemini = env.gemini;
  if (!gemini) {
    throw new ServiceUnavailableError(
      "The diagnosis is not available right now; choose a trade instead",
      ERROR_CODE.AI_NOT_CONFIGURED
    );
  }
  const session = await loadOwnSession(sessionId, customerId);
  if (!(await sessionHasCustomerText(sessionId))) {
    throw new ValidationError(
      "Describe the problem in words before asking for a diagnosis",
      ERROR_CODE.SESSION_HAS_NO_TEXT
    );
  }
  if (
    !(await startAnalysisAttempt(sessionId, customerId, MAX_ANALYSIS_ATTEMPTS))
  ) {
    throw await startRefusal(sessionId);
  }
  // attempt is for the logs only.
  void runAnalysis(sessionId, session.analysisAttempts + 1, gemini).catch(
    (err: unknown) => {
      logger.error("analysis crashed", {
        sessionId,
        kind: CALLER_FAILURE.CRASHED,
        error: errorMessage(err),
      });
    }
  );
  return AI_STATUS.PENDING;
}

// Why the guarded UPDATE changed nothing, read after the fact. If none of the
// reasons holds any more, the session was pending at the UPDATE and has
// settled since, so it is reported as pending.
async function startRefusal(sessionId: string): Promise<Error> {
  const session = await findIntakeSession(sessionId);
  if (!session) {
    return new NotFoundError("Intake session not found");
  }
  if (session.aiStatus !== AI_STATUS.PENDING) {
    if (session.requestId !== null) {
      return new ConflictError(
        "This problem has already been booked; describe a new one in a new session",
        ERROR_CODE.SESSION_ALREADY_BOOKED
      );
    }
    if (session.analysisAttempts >= MAX_ANALYSIS_ATTEMPTS) {
      return new TooManyRequestsError(
        `A problem can be diagnosed at most ${MAX_ANALYSIS_ATTEMPTS} times; choose a trade instead`,
        ERROR_CODE.ANALYSIS_CAP_REACHED
      );
    }
  }
  return new ConflictError(
    "A diagnosis is already running for this problem",
    ERROR_CODE.ANALYSIS_PENDING
  );
}

// Never rejects for a failed diagnosis: every failure ends as a failed
// session. It rejects only if marking the session failed throws too.
async function runAnalysis(
  sessionId: string,
  attempt: number,
  gemini: GeminiConfig
): Promise<void> {
  const startedAt = Date.now();
  const base = { sessionId, attempt, promptVersion: PROMPT_VERSION };
  try {
    const input = await loadAnalysisInput(sessionId);
    const fallbackModel = gemini.fallbackModel;
    const { result, winner, hedged } = await hedgedDiagnose(
      (signal) => diagnose(input, {}, signal),
      fallbackModel === null
        ? null
        : (signal) => diagnose(input, { model: fallbackModel }, signal)
    );
    const stored: StoredDiagnosis = {
      model: result.model,
      promptVersion: PROMPT_VERSION,
      completedAt: beirutNow().toISOString().slice(0, 23),
      diagnosis: result.diagnosis,
    };
    const settled = await withTransaction(async (conn) => {
      if (!(await markAnalysisDone(conn, sessionId, stored))) return false;
      await insertIntakeMessage(conn, {
        sessionId,
        sender: MESSAGE_SENDER.AI,
        body: result.diagnosis.explanation,
      });
      return true;
    });
    const outcome = {
      ...base,
      model: result.model,
      durationMs: Date.now() - startedAt,
      hedged,
      winner,
    };
    if (!settled) {
      logger.info(
        "analysis result discarded: session already settled",
        outcome
      );
      return;
    }
    logger.info("analysis done", {
      ...outcome,
      category: result.diagnosis.category,
      confidence: result.diagnosis.confidence,
      usage: result.usage,
    });
  } catch (err) {
    await markAnalysisFailed(sessionId);
    logFailure(
      { ...base, models: [gemini.model, gemini.fallbackModel] },
      Date.now() - startedAt,
      err
    );
  }
}

// The messages in order and the newest photos, read from the paths stored in
// intake_photos and only from inside the intake upload directory. A photo
// whose file is missing is left out rather than failing the analysis.
async function loadAnalysisInput(sessionId: string): Promise<DiagnosisInput> {
  const messages = await listIntakeMessages(sessionId);
  const newest = messages
    .flatMap((message) =>
      message.photos.map((photo) => ({ ...photo, messageId: message.id }))
    )
    .sort((a, b) => a.id - b.id)
    .slice(-MAX_PHOTOS_PER_ANALYSIS);
  const photos = await Promise.all(
    newest.map(async (photo) => {
      const mimeType = photoMimeType(photo.url);
      const bytes = await readPhotoIfPresent(intakePhotoFile(photo.url));
      if (bytes === null) {
        logger.warn("intake photo file missing; analysing without it", {
          sessionId,
          photoId: photo.id,
        });
        return null;
      }
      return {
        messageId: photo.messageId,
        mimeType,
        data: bytes.toString("base64"),
      };
    })
  );
  return {
    messages,
    photos: photos.filter((photo) => photo !== null),
  };
}

function intakePhotoFile(url: string): string {
  const file = path.resolve(UPLOADS_DIR, url);
  if (!file.startsWith(INTAKE_PHOTO_ROOT + path.sep)) {
    throw new Error("Intake photo path is outside the intake upload directory");
  }
  return file;
}

// null only when the file does not exist; any other read error is rethrown.
async function readPhotoIfPresent(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function photoMimeType(url: string): string {
  const mimeType = MIME_TYPE_BY_EXTENSION[path.extname(url).toLowerCase()];
  if (!mimeType) {
    throw new Error("Intake photo has an unexpected file extension");
  }
  return mimeType;
}

// docs/ai-plan.md §12.4: never the prompt, customer text or photos. Raw
// model output only at debug level, cut short.
function logFailure(
  base: Record<string, unknown>,
  durationMs: number,
  err: unknown
): void {
  if (!(err instanceof HedgeFailedError)) {
    logger.warn("analysis failed", {
      ...base,
      durationMs,
      kind: CALLER_FAILURE.CRASHED,
      error: errorMessage(err),
    });
    return;
  }
  const failures = err.failures.map((failure) => ({
    by: failure.attempt,
    kind: failure.kind,
    error: errorMessage(failure.error),
    details:
      failure.error instanceof DiagnosisError ? failure.error.details : {},
  }));
  logger.warn("analysis failed", {
    ...base,
    durationMs,
    kind: err.kind,
    hedged: err.hedged,
    failures: failures.map(({ by, kind, error, details }) => ({
      by,
      kind,
      error,
      httpStatus: details.httpStatus,
      issuePaths: details.issuePaths,
    })),
  });
  for (const { by, details } of failures) {
    if (details.outputText) {
      logger.debug("analysis raw output", {
        sessionId: base.sessionId,
        by,
        output: Buffer.from(details.outputText)
          .subarray(0, RAW_OUTPUT_LOG_BYTES)
          .toString(),
      });
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
