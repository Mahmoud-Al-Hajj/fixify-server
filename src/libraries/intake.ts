import { randomUUID } from "node:crypto";
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
import { findCategoryIdByName } from "../models-db/categories";
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
import {
  photoFilePath,
  removePhotos,
  storePhotos,
  type Photo,
} from "./photo-files";

export const INTAKE_PHOTO_DIR = "intake";
// Disk space, not the AI: only the newest few photos go to the model.
const MAX_PHOTOS_PER_SESSION = 20;

export interface CustomerTurn {
  body: string | null;
  photos: readonly Photo[];
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
  const urls = await storePhotos(INTAKE_PHOTO_DIR, turn.photos);
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
  diagnosis: DiagnosisView | null;
}> {
  const session = await loadOwnSession(sessionId, customerId);
  const diagnosis = currentDiagnosis(session);
  return {
    session,
    messages: await listIntakeMessages(sessionId),
    diagnosis: diagnosis === null ? null : await toDiagnosisView(diagnosis),
  };
}

// The diagnosis as the API returns it: the validated output, never edited,
// plus the id of its category, resolved by the server from the name so the
// client never maps names to ids. Response only; nothing stores it.
export type DiagnosisView = Diagnosis & { categoryId: number | null };

export async function toDiagnosisView(
  diagnosis: Diagnosis
): Promise<DiagnosisView> {
  if (diagnosis.category === null) return { ...diagnosis, categoryId: null };
  const categoryId = await findCategoryIdByName(diagnosis.category);
  if (categoryId === null) {
    // assertCategoriesMatchConstants guarantees a row for every name.
    throw new Error("A diagnosed category has no row in categories");
  }
  return { ...diagnosis, categoryId };
}

// A stored value that no longer matches the schema (e.g. an earlier prompt
// version's shape) is logged and treated as no diagnosis.
export function currentDiagnosis(
  session: Pick<IntakeSession, "id" | "aiStatus" | "aiDiagnosis">
): Diagnosis | null {
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
  return photoFilePath(url);
}
