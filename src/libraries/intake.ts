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
  type IntakeSession,
  type IntakeMessage,
} from "../models-db/intake";
import { MESSAGE_SENDER } from "../constants/message-sender";
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
} from "../constants/errors";
import { logger } from "../config/logger";

const UPLOADS_DIR = path.resolve("uploads");
const INTAKE_PHOTO_DIR = "intake";

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

// Stores the turn's photos, then its message and photo rows in one
// transaction, after `first` (creating the session, for a first turn). If
// the transaction fails the files are removed again.
async function recordCustomerTurn(
  sessionId: string,
  turn: CustomerTurn,
  first?: (conn: PoolConnection) => Promise<void>
): Promise<number> {
  if (turn.body === null && turn.photos.length === 0) {
    throw new ValidationError("Send a message, a photo, or both");
  }
  const urls = await storePhotos(turn);
  try {
    return await withTransaction(async (conn) => {
      if (first) await first(conn);
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
async function loadOwnSession(
  sessionId: string,
  customerId: string
): Promise<IntakeSession> {
  const session = await findIntakeSession(sessionId);
  if (!session) {
    throw new NotFoundError("Intake session not found");
  }
  if (session.customerId !== customerId) {
    throw new ForbiddenError("This intake session belongs to another customer");
  }
  return session;
}

export async function addCustomerMessage(
  sessionId: string,
  customerId: string,
  turn: CustomerTurn
): Promise<IntakeMessage> {
  const session = await loadOwnSession(sessionId, customerId);
  if (session.requestId !== null) {
    throw new ConflictError(
      "This problem has already been booked; describe a new one in a new session"
    );
  }
  const messageId = await recordCustomerTurn(sessionId, turn);
  const message = (await listIntakeMessages(sessionId)).find(
    (candidate) => candidate.id === messageId
  );
  if (!message) {
    throw new Error("Intake message was created but could not be re-read");
  }
  return message;
}

export async function getOwnSession(
  sessionId: string,
  customerId: string
): Promise<{ session: IntakeSession; messages: IntakeMessage[] }> {
  const session = await loadOwnSession(sessionId, customerId);
  return { session, messages: await listIntakeMessages(sessionId) };
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
