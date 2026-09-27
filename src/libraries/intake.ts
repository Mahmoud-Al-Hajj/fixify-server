import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { withTransaction } from "../models-db/pool";
import {
  insertIntakeSession,
  insertIntakeMessage,
  insertIntakePhotos,
  findIntakeSession,
  type IntakeSession,
} from "../models-db/intake";
import { MESSAGE_SENDER } from "../constants/message-sender";
import { ValidationError } from "../constants/errors";
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

export async function createIntakeSession(
  customerId: string,
  turn: CustomerTurn
): Promise<IntakeSession> {
  if (turn.body === null && turn.photos.length === 0) {
    throw new ValidationError("Send a message, a photo, or both");
  }
  const sessionId = randomUUID();
  const urls = await storePhotos(turn);
  try {
    await withTransaction(async (conn) => {
      await insertIntakeSession(conn, { id: sessionId, customerId });
      const messageId = await insertIntakeMessage(conn, {
        sessionId,
        sender: MESSAGE_SENDER.CUSTOMER,
        body: turn.body,
      });
      await insertIntakePhotos(conn, messageId, urls);
    });
  } catch (err) {
    await removePhotos(urls);
    throw err;
  }
  const session = await findIntakeSession(sessionId);
  if (!session) {
    throw new Error("Intake session was created but could not be re-read");
  }
  return session;
}
