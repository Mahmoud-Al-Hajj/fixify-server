import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "../config/logger";

// Photos live on disk under UPLOADS_DIR; a table row holds only the path
// relative to it, which the server generates, never a client filename.
export const UPLOADS_DIR = path.resolve("uploads");

export interface Photo {
  buffer: Buffer;
  extension: "jpg" | "png";
}

// Writes each photo under a server-generated name in dir (relative to
// UPLOADS_DIR) and returns the stored paths.
export async function storePhotos(
  dir: string,
  photos: readonly Photo[]
): Promise<string[]> {
  await mkdir(path.join(UPLOADS_DIR, dir), { recursive: true });
  return Promise.all(
    photos.map(async (photo) => {
      const url = `${dir}/${randomUUID()}.${photo.extension}`;
      await writeFile(path.join(UPLOADS_DIR, url), photo.buffer);
      return url;
    })
  );
}

// Photos are written before the transaction that records them; if it fails
// they are removed again, so no file is left without its row.
export async function removePhotos(urls: readonly string[]): Promise<void> {
  const results = await Promise.allSettled(
    urls.map((url) => unlink(path.join(UPLOADS_DIR, url)))
  );
  for (const result of results) {
    if (result.status === "rejected") {
      logger.error("could not remove orphaned photo", {
        error: String(result.reason),
      });
    }
  }
}

export function photoFilePath(url: string): string {
  return path.join(UPLOADS_DIR, url);
}
