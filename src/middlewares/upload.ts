import multer from "multer";
import type { Request, Response, NextFunction } from "express";
import { ValidationError } from "../constants/errors";
import type { Photo } from "../libraries/intake";

export const MAX_PHOTOS = 5;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type PhotoLocals = { photos: Photo[] };

const parse = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES, files: MAX_PHOTOS, fields: 1 },
}).array("photos", MAX_PHOTOS);

// Parses a multipart body: text fields go to req.body (validated next by
// validateBody), photos to res.locals.photos. A photo's type is decided by its
// first bytes, never by the client's filename or content type.
export function uploadPhotos(
  req: Request,
  res: Response<unknown, PhotoLocals>,
  next: NextFunction
): void {
  parse(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      next(Object.assign(err, { status: 413, type: "entity.too.large" }));
      return;
    }
    if (err) {
      next(
        new ValidationError(
          err instanceof Error ? err.message : "Malformed multipart body"
        )
      );
      return;
    }
    const files = Array.isArray(req.files) ? req.files : [];
    const photos: Photo[] = [];
    for (const { buffer } of files) {
      if (buffer.subarray(0, 3).equals(JPEG_MAGIC)) {
        photos.push({ buffer, extension: "jpg" });
      } else if (buffer.subarray(0, 8).equals(PNG_MAGIC)) {
        photos.push({ buffer, extension: "png" });
      } else {
        next(new ValidationError("Only JPEG and PNG photos are accepted"));
        return;
      }
    }
    res.locals.photos = photos;
    next();
  });
}
