import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PoolConnection } from "mysql2/promise";
import { withTransaction } from "../models-db/pool";
import {
  insertIntakeSession,
  insertIntakeMessage,
  insertIntakePhotos,
  findIntakeSession,
  listIntakeMessages,
  findIntakePhotoUrl,
  lockIntakeSession,
  readSessionFreeze,
  type IntakeSession,
  type IntakeMessage,
} from "../models-db/intake";
import { MESSAGE_SENDER } from "../constants/message-sender";
import { AI_STATUS } from "../constants/ai-status";
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  ERROR_CODE,
} from "../constants/errors";
import { logger } from "../config/logger";
import { storedDiagnosisSchema, type Diagnosis } from "./ai/diagnosis-schema";

export const UPLOADS_DIR = path.resolve("uploads");
export const INTAKE_PHOTO_DIR = "intake";
// Disk space, not the AI: only the newest few photos go to the model.
const MAX_PHOTOS_PER_SESSION = 20;

export interface Photo {
  buffer: Buffer;
  extension: "jpg" | "png";
}

export interface CustomerTurn {
  body: string | null;
  photos: readonly Photo[];
}

// Writes each photo under a server-generated name and returns the paths
// relative to UPLOADS_DIR, which is what intake_photos.url stores.
async function storePhotos(turn: CustomerTurn): Promise<string[]> {
  await mkdir(path.join(UPLOADS_DIR, INTAKE_PHOTO_DIR), { recursive: true });
  return Promise.all(
    turn.photos.map(async (photo) => {
      const url = `${INTAKE_PHOTO_DIR}/${randomUUID()}.${photo.extension}`;
      await writeFile(path.join(UPLOADS_DIR, url), photo.buffer);
      return url;
    })
  );
}

// Photos are written before the transaction; if it fails they are removed
// again, so no file is left without its row.
async function removePhotos(urls: readonly string[]): Promise<void> {
  const results = await Promise.allSettled(
    urls.map((url) => unlink(path.join(UPLOADS_DIR, url)))
  );
  for (const result of results) {
    if (result.status === "rejected") {
      logger.error("could not remove orphaned intake photo", {
        error: String(result.reason),
      });
    }
  }
}

// Stores the turn's photos, then, in one transaction, runs `prepare` (create
// the session, or lock and check it) and inserts the message and photo rows.
// If the transaction fails or refuses the turn, the files are removed again.
async function recordCustomerTurn(
  sessionId: string,
  turn: CustomerTurn,
  prepare: (conn: PoolConnection) => Promise<void>
): Promise<number> {
  if (turn.body === null && turn.photos.length === 0) {
    throw new ValidationError("Send a message, a photo, or both");
  }
  const urls = await storePhotos(turn);
  try {
    return await withTransaction(async (conn) => {
      await prepare(conn);
      const messageId = await insertIntakeMessage(conn, {
        sessionId,
        sender: MESSAGE_SENDER.CUSTOMER,
        body: turn.body,
      });
      await insertIntakePhotos(conn, messageId, urls);
      return messageId;
    });
  } catch (err) {
    await removePhotos(urls);
    throw err;
  }
}

export async function createIntakeSession(
  customerId: string,
  turn: CustomerTurn
): Promise<IntakeSession> {
  const sessionId = randomUUID();
  await recordCustomerTurn(sessionId, turn, (conn) =>
    insertIntakeSession(conn, { id: sessionId, customerId })
  );
  const session = await findIntakeSession(sessionId);
  if (!session) {
    throw new Error("Intake session was created but could not be re-read");
  }
  return session;
}

// An intake session belongs to its customer; nobody else reaches it by id.
// Another customer's session is reported as not found, so its existence is
// not revealed.
export async function loadOwnSession(
  sessionId: string,
  customerId: string
): Promise<IntakeSession> {
  const session = await findIntakeSession(sessionId);
  if (!session || session.customerId !== customerId) {
    throw new NotFoundError("Intake session not found");
  }
  return session;
}

// Add-message's refusals, checked under the session lock so that a booking,
// an analysis start or a concurrent message cannot slip in between the check
// and the insert (ai-plan §2.7, §12.3).
async function lockSessionForTurn(
  conn: PoolConnection,
  sessionId: string,
  customerId: string,
  newPhotos: number
): Promise<void> {
  const session = await lockIntakeSession(conn, sessionId);
  if (!session || session.customerId !== customerId) {
    throw new NotFoundError("Intake session not found");
  }
  const { booked, photoCount } = await readSessionFreeze(conn, sessionId);
  if (booked) {
    throw new ConflictError(
      "This problem has already been booked; describe a new one in a new session",
      ERROR_CODE.SESSION_ALREADY_BOOKED
    );
  }
  if (session.aiStatus === AI_STATUS.PENDING) {
    throw new ConflictError(
      "Wait for the diagnosis to finish before adding more",
      ERROR_CODE.ANALYSIS_PENDING
    );
  }
  if (photoCount + newPhotos > MAX_PHOTOS_PER_SESSION) {
    throw new ValidationError(
      `A problem can have at most ${MAX_PHOTOS_PER_SESSION} photos; this one already has ${photoCount}`,
      ERROR_CODE.SESSION_PHOTO_CAP_REACHED
    );
  }
}

export async function addCustomerMessage(
  sessionId: string,
  customerId: string,
  turn: CustomerTurn
): Promise<IntakeMessage> {
  const messageId = await recordCustomerTurn(sessionId, turn, (conn) =>
    lockSessionForTurn(conn, sessionId, customerId, turn.photos.length)
  );
  const message = (await listIntakeMessages(sessionId)).find(
    (candidate) => candidate.id === messageId
  );
  if (!message) {
    throw new Error("Intake message was created but could not be re-read");
  }
  return message;
}

// The diagnosis is shown only while the session is done; during a re-run or
// after a failed one, the column still holds the earlier result.
export async function getOwnSession(
  sessionId: string,
  customerId: string
): Promise<{
  session: IntakeSession;
  messages: IntakeMessage[];
  diagnosis: Diagnosis | null;
}> {
  const session = await loadOwnSession(sessionId, customerId);
  return {
    session,
    messages: await listIntakeMessages(sessionId),
    diagnosis: currentDiagnosis(session),
  };
}

// A stored value that no longer matches the schema (e.g. an earlier prompt
// version's shape) is logged and treated as no diagnosis.
function currentDiagnosis(session: IntakeSession): Diagnosis | null {
  if (session.aiStatus !== AI_STATUS.DONE) return null;
  const stored = storedDiagnosisSchema.safeParse(session.aiDiagnosis);
  if (!stored.success) {
    logger.warn("stored diagnosis does not match the schema", {
      sessionId: session.id,
      issuePaths: stored.error.issues.map((i) => i.path.join(".")),
    });
    return null;
  }
  return stored.data.diagnosis;
}

// Readable by the session's customer, or by the provider assigned to the
// request booked from it. Returns the file's absolute path.
export async function getIntakePhotoPath(
  sessionId: string,
  photoId: number,
  userId: string
): Promise<string> {
  const session = await findIntakeSession(sessionId);
  if (!session) {
    throw new NotFoundError("Intake session not found");
  }
  if (session.customerId !== userId && session.providerId !== userId) {
    throw new ForbiddenError("You may not view this photo");
  }
  const url = await findIntakePhotoUrl(photoId, sessionId);
  if (url === null) {
    throw new NotFoundError("Photo not found");
  }
  return path.join(UPLOADS_DIR, url);
}
