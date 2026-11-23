import { findRequestById, type Request } from "../models-db/requests";
import {
  REQUEST_ACTOR_ROLE,
  type RequestActorRole,
} from "../constants/request-status";
import { NotFoundError, ForbiddenError } from "../constants/errors";

// How every service reaches an existing request: load it and check that the
// caller is its customer or its assigned provider (loadRequestForActor), and
// read it back after a write (rereadRequest). Shared by the request, quote,
// visit, review and photo services.

// A request this service just wrote; missing only if deleted concurrently,
// which no endpoint does.
export async function rereadRequest(id: string): Promise<Request> {
  const request = await findRequestById(id);
  if (!request) {
    throw new Error("Request was written but could not be re-read");
  }
  return request;
}

function resolveActorRole(
  request: Request,
  actorUserId: string
): RequestActorRole {
  if (request.customerId === actorUserId) {
    return REQUEST_ACTOR_ROLE.CUSTOMER;
  }
  if (request.providerId === actorUserId) {
    return REQUEST_ACTOR_ROLE.PROVIDER;
  }
  throw new ForbiddenError("You are not a party to this request");
}

// The one entry point for acting on an existing request: 404 if it doesn't
// exist, 403 if the caller is neither its customer nor its provider. Every
// request action goes through here, so a change to who may touch a request is
// made in one place. The resolved role is returned so callers check it rather
// than re-deriving or assuming it.
export async function loadRequestForActor(
  requestId: string,
  actorUserId: string
): Promise<{ request: Request; actorRole: RequestActorRole }> {
  const request = await findRequestById(requestId);
  if (!request) {
    throw new NotFoundError("Request not found");
  }
  return { request, actorRole: resolveActorRole(request, actorUserId) };
}

// Always raised as a ConflictError (409 CONFLICT): the action was valid when
// checked but another write got there first, so reloading and retrying may
// succeed. InvalidTransitionError stays reserved for moves that are never
// allowed, whatever the timing.
export const CHANGED_CONCURRENTLY_MESSAGE =
  "Request was changed by another action; reload it and try again";
