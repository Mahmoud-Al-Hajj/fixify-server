import { randomUUID } from "node:crypto";
import { withTransaction } from "../models-db/pool";
import { lockRequestForUpdate } from "../models-db/requests";
import { insertJobEvent } from "../models-db/job-events";
import {
  countRequestPhotos,
  findRequestPhotoUrl,
  insertRequestPhotos,
  listRequestPhotos,
  type RequestPhoto,
} from "../models-db/request-photos";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../constants/errors";
import { JOB_EVENT_TYPE } from "../constants/job-event-type";
import type { PhotoKind } from "../constants/photo-kind";
import {
  REQUEST_ACTOR_ROLE,
  REQUEST_STATUS,
  type RequestStatus,
} from "../constants/request-status";
import { loadRequestForActor } from "./requests";
import {
  photoFilePath,
  removePhotos,
  storePhotos,
  type Photo,
} from "./photo-files";

const REQUEST_PHOTO_DIR = "request";
export const MAX_PHOTOS_PER_REQUEST = 30;

// From booking until after the job is done (late "after" photos are fine);
// never on a job that was not taken or was called off.
const PHOTOS_ALLOWED: readonly RequestStatus[] = [
  REQUEST_STATUS.SCHEDULED,
  REQUEST_STATUS.IN_PROGRESS,
  REQUEST_STATUS.COMPLETED,
];

// The assigned provider's before / after / extra photos. The files are
// written first; then one transaction locks the request row, checks its
// status and the cap, inserts the rows and the photos_added event. If it
// fails, the files are removed again.
export async function addRequestPhotos(
  requestId: string,
  actorUserId: string,
  kind: PhotoKind,
  photos: readonly Photo[]
): Promise<RequestPhoto[]> {
  const { request, actorRole } = await loadRequestForActor(
    requestId,
    actorUserId
  );
  if (actorRole !== REQUEST_ACTOR_ROLE.PROVIDER) {
    throw new ForbiddenError("Only the assigned provider can add job photos");
  }
  if (photos.length === 0) {
    throw new ValidationError("Attach at least one photo");
  }
  const stored = (await storePhotos(REQUEST_PHOTO_DIR, photos)).map((url) => ({
    id: randomUUID(),
    url,
  }));
  try {
    await withTransaction(async (conn) => {
      const status = await lockRequestForUpdate(conn, request.id);
      if (status === null || !PHOTOS_ALLOWED.includes(status)) {
        throw new ConflictError(
          "Photos can be added once the job is scheduled, and not to a rejected or cancelled job"
        );
      }
      const count = await countRequestPhotos(conn, request.id);
      if (count + stored.length > MAX_PHOTOS_PER_REQUEST) {
        throw new ValidationError(
          `A request holds at most ${MAX_PHOTOS_PER_REQUEST} photos; this one has ${count}`
        );
      }
      await insertRequestPhotos(conn, request.id, kind, stored);
      await insertJobEvent(conn, {
        id: randomUUID(),
        requestId: request.id,
        actorUserId,
        eventType: JOB_EVENT_TYPE.PHOTOS_ADDED,
        payload: { kind, count: stored.length },
      });
    });
  } catch (err) {
    await removePhotos(stored.map(({ url }) => url));
    throw err;
  }
  const added = new Set<string>(stored.map(({ id }) => id));
  return (await listRequestPhotos(request.id)).filter(({ id }) =>
    added.has(id)
  );
}

// Either party sees the job photos.
export async function listPhotosForActor(
  requestId: string,
  actorUserId: string
): Promise<RequestPhoto[]> {
  const { request } = await loadRequestForActor(requestId, actorUserId);
  return listRequestPhotos(request.id);
}

// Either party may load a photo of the request; returns the file's path.
export async function getRequestPhotoPath(
  requestId: string,
  photoId: string,
  actorUserId: string
): Promise<string> {
  const { request } = await loadRequestForActor(requestId, actorUserId);
  const url = await findRequestPhotoUrl(photoId, request.id);
  if (url === null) {
    throw new NotFoundError("Photo not found");
  }
  return photoFilePath(url);
}
