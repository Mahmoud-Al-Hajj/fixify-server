import { randomUUID } from "node:crypto";
import type { PoolConnection } from "mysql2/promise";
import { pool } from "../models-db/pool";
import {
  insertRequest,
  findRequestById,
  updateRequestStatus,
  markRequestPaid as markRequestPaidModel,
  listRequestsForCustomer as listRequestsForCustomerModel,
  listRequestsForProvider as listRequestsForProviderModel,
  type Request,
  type InsertRequestInput,
} from "../models-db/requests";
import {
  findProviderAcceptance,
  providerAcceptsCategory,
} from "../models-db/providers";
import {
  findVisitsForRequest,
  findOpenVisitsForRequests,
  updateVisitStatus,
  cancelOpenVisitsForRequest,
  type Visit,
} from "../models-db/visits";
import { insertJobEvent } from "../models-db/job-events";
import { findReviewForRequest } from "../models-db/reviews";
import { VISIT_STATUS, type VisitStatus } from "../constants/visit-status";
import { JOB_EVENT_TYPE, type JobEventType } from "../constants/job-event-type";
import {
  REQUEST_STATUS,
  type RequestStatus,
} from "../constants/request-status";
import {
  NotFoundError,
  ForbiddenError,
  ValidationError,
  ConflictError,
  InvalidTransitionError,
} from "../constants/errors";
import {
  REQUEST_ACTOR_ROLE,
  assertRequestTransition,
  type RequestActorRole,
} from "./request-state-machine";
import {
  OPEN_VISIT_STATUSES,
  assertVisitTransition,
} from "./visit-state-machine";

export type CreateRequestInput = Omit<InsertRequestInput, "id">;

export async function createRequest(
  input: CreateRequestInput
): Promise<Request> {
  if (input.customerId === input.providerId) {
    throw new ValidationError("You cannot request service from yourself");
  }

  const provider = await findProviderAcceptance(input.providerId);
  if (!provider) {
    throw new NotFoundError("Provider not found");
  }

  // The category check runs before is_accepting: a wrong category is a
  // permanent input error, a paused provider is temporary state. Reporting
  // the 409 first would send the client away to retry a request that can
  // never succeed.
  const offersCategory = await providerAcceptsCategory(
    input.providerId,
    input.categoryId
  );
  if (!offersCategory) {
    throw new ValidationError("Provider does not offer this category");
  }
  if (!provider.isAccepting) {
    throw new ConflictError(
      "This provider is not currently accepting requests"
    );
  }

  const id = randomUUID();

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    try {
      await insertRequest(conn, { id, ...input });
      await insertJobEvent(conn, {
        id: randomUUID(),
        requestId: id,
        actorUserId: input.customerId,
        eventType: JOB_EVENT_TYPE.REQUEST_CREATED,
        payload: null,
      });
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  } finally {
    conn.release();
  }

  const created = await findRequestById(id);
  if (!created) {
    throw new Error("Request was created but could not be re-read");
  }
  return created;
}

export function resolveActorRole(
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

export async function getRequestForActor(
  requestId: string,
  actorUserId: string
): Promise<{ request: Request; visits: Visit[]; hasReview: boolean }> {
  const request = await findRequestById(requestId);
  if (!request) {
    throw new NotFoundError("Request not found");
  }
  resolveActorRole(request, actorUserId);
  const visits = await findVisitsForRequest(request.id);
  const review = await findReviewForRequest(request.id);
  return { request, visits, hasReview: review !== null };
}

async function attachNextVisits(
  requests: Request[]
): Promise<Array<{ request: Request; nextVisit: Visit | null }>> {
  const openVisits = await findOpenVisitsForRequests(
    requests.map((request) => request.id),
    OPEN_VISIT_STATUSES
  );
  // Rows arrive ordered by request, then scheduled_start, so the first one
  // seen for each request is its next visit.
  const nextVisitByRequest = new Map<string, Visit>();
  for (const visit of openVisits) {
    if (!nextVisitByRequest.has(visit.requestId)) {
      nextVisitByRequest.set(visit.requestId, visit);
    }
  }
  return requests.map((request) => ({
    request,
    nextVisit: nextVisitByRequest.get(request.id) ?? null,
  }));
}

const CHANGED_CONCURRENTLY_MESSAGE =
  "Request was changed by another action; reload it and try again";

interface TransitionSideEffects {
  eventPayload: Readonly<Record<string, string>> | null;
  // Runs inside the transaction after the conditional request update, so the
  // request row is already locked when visits are touched. Every transition
  // takes that lock first, which is what serialises e.g. a start racing a
  // cancel on the same request.
  applyVisitChanges?: (conn: PoolConnection) => Promise<void>;
}

interface TransitionInput {
  requestId: string;
  actorUserId: string;
  targetStatus: RequestStatus;
  eventType: JobEventType;
  markResponded: boolean;
  markCompleted: boolean;
  // Runs after the request transition is validated and before the
  // transaction opens, so a visit-state problem is reported without writing
  // anything. Omitted when the action touches no visits and has no payload.
  prepare?: (request: Request) => Promise<TransitionSideEffects>;
}

async function transitionRequest(input: TransitionInput): Promise<Request> {
  const request = await findRequestById(input.requestId);
  if (!request) {
    throw new NotFoundError("Request not found");
  }
  const actorRole = resolveActorRole(request, input.actorUserId);
  assertRequestTransition(request.status, input.targetStatus, actorRole);
  const sideEffects: TransitionSideEffects = input.prepare
    ? await input.prepare(request)
    : { eventPayload: null };

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    try {
      const updated = await updateRequestStatus(conn, {
        id: request.id,
        fromStatus: request.status,
        toStatus: input.targetStatus,
        markResponded: input.markResponded,
        markCompleted: input.markCompleted,
      });
      if (!updated) {
        throw new InvalidTransitionError(CHANGED_CONCURRENTLY_MESSAGE);
      }
      if (sideEffects.applyVisitChanges) {
        await sideEffects.applyVisitChanges(conn);
      }
      await insertJobEvent(conn, {
        id: randomUUID(),
        requestId: request.id,
        actorUserId: input.actorUserId,
        eventType: input.eventType,
        payload: sideEffects.eventPayload,
      });
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  } finally {
    conn.release();
  }

  const transitioned = await findRequestById(request.id);
  if (!transitioned) {
    throw new Error("Request was transitioned but could not be re-read");
  }
  return transitioned;
}

export async function rejectRequest(
  requestId: string,
  actorUserId: string
): Promise<Request> {
  return transitionRequest({
    requestId,
    actorUserId,
    targetStatus: REQUEST_STATUS.REJECTED,
    eventType: JOB_EVENT_TYPE.REQUEST_REJECTED,
    markResponded: true,
    markCompleted: false,
  });
}

export async function cancelRequest(
  requestId: string,
  actorUserId: string
): Promise<Request> {
  return transitionRequest({
    requestId,
    actorUserId,
    targetStatus: REQUEST_STATUS.CANCELLED,
    eventType: JOB_EVENT_TYPE.REQUEST_CANCELLED,
    markResponded: false,
    markCompleted: false,
    // Every open visit is cancelled with the request, which releases its
    // slot. A pending request has no visits, so this is a no-op there.
    prepare: async (request) => ({
      eventPayload: { from: request.status },
      applyVisitChanges: (conn) =>
        cancelOpenVisitsForRequest(conn, request.id, OPEN_VISIT_STATUSES),
    }),
  });
}

async function applyVisitTransition(
  conn: PoolConnection,
  visit: Visit,
  toStatus: VisitStatus,
  markActualStart: boolean
): Promise<void> {
  const updated = await updateVisitStatus(conn, {
    id: visit.id,
    fromStatus: visit.status,
    toStatus,
    markActualStart,
  });
  if (!updated) {
    throw new InvalidTransitionError(CHANGED_CONCURRENTLY_MESSAGE);
  }
}

export async function startRequest(
  requestId: string,
  actorUserId: string
): Promise<Request> {
  return transitionRequest({
    requestId,
    actorUserId,
    targetStatus: REQUEST_STATUS.IN_PROGRESS,
    eventType: JOB_EVENT_TYPE.REQUEST_STARTED,
    markResponded: false,
    markCompleted: false,
    prepare: async (request) => {
      // Visits come back ordered by scheduled_start, so this is the earliest
      // visit still waiting to start.
      const visit = (await findVisitsForRequest(request.id)).find(
        (candidate) =>
          candidate.status === VISIT_STATUS.SCHEDULED ||
          candidate.status === VISIT_STATUS.EN_ROUTE
      );
      if (!visit) {
        throw new ConflictError("This request has no scheduled visit to start");
      }
      assertVisitTransition(visit.status, VISIT_STATUS.IN_PROGRESS);
      return {
        eventPayload: { visitId: visit.id },
        applyVisitChanges: (conn) =>
          applyVisitTransition(conn, visit, VISIT_STATUS.IN_PROGRESS, true),
      };
    },
  });
}

export async function completeRequest(
  requestId: string,
  actorUserId: string
): Promise<Request> {
  return transitionRequest({
    requestId,
    actorUserId,
    targetStatus: REQUEST_STATUS.COMPLETED,
    eventType: JOB_EVENT_TYPE.REQUEST_COMPLETED,
    markResponded: false,
    markCompleted: true,
    prepare: async (request) => {
      const visits = await findVisitsForRequest(request.id);
      const inProgress = visits.filter(
        (candidate) => candidate.status === VISIT_STATUS.IN_PROGRESS
      );
      const visit = inProgress[0];
      if (!visit || inProgress.length > 1) {
        throw new ConflictError(
          "A request can only be completed with exactly one visit in progress"
        );
      }
      // Other open visits (e.g. a scheduled follow-up) block completion
      // rather than being cancelled silently.
      const otherOpen = visits.some(
        (candidate) =>
          candidate.id !== visit.id &&
          OPEN_VISIT_STATUSES.includes(candidate.status)
      );
      if (otherOpen) {
        throw new ConflictError(
          "This request still has other open visits; finish or cancel them before completing it"
        );
      }
      assertVisitTransition(visit.status, VISIT_STATUS.DONE);
      return {
        eventPayload: { visitId: visit.id },
        applyVisitChanges: (conn) =>
          applyVisitTransition(conn, visit, VISIT_STATUS.DONE, false),
      };
    },
  });
}

// Not a state transition: paid_at is an independent fact recorded after the
// job is completed, so this doesn't go through transitionRequest or the state
// machine. The pre-checks pick the right message; the guarded UPDATE is what
// actually prevents a second write if two calls race.
export async function markRequestPaid(
  requestId: string,
  actorUserId: string
): Promise<Request> {
  const request = await findRequestById(requestId);
  if (!request) {
    throw new NotFoundError("Request not found");
  }
  const actorRole = resolveActorRole(request, actorUserId);
  if (actorRole !== REQUEST_ACTOR_ROLE.PROVIDER) {
    throw new ForbiddenError("Only the provider can mark a request as paid");
  }
  if (request.status !== REQUEST_STATUS.COMPLETED) {
    throw new ConflictError(
      "A request can only be marked paid once it is completed"
    );
  }
  if (request.paidAt !== null) {
    throw new ConflictError("This request is already marked as paid");
  }
  const price = request.price;
  if (price === null) {
    throw new Error("A completed request has no price");
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    try {
      const updated = await markRequestPaidModel(
        conn,
        request.id,
        REQUEST_STATUS.COMPLETED
      );
      if (!updated) {
        throw new ConflictError(CHANGED_CONCURRENTLY_MESSAGE);
      }
      await insertJobEvent(conn, {
        id: randomUUID(),
        requestId: request.id,
        actorUserId,
        eventType: JOB_EVENT_TYPE.REQUEST_PAID,
        payload: { price },
      });
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  } finally {
    conn.release();
  }

  const paid = await findRequestById(request.id);
  if (!paid) {
    throw new Error("Request was marked paid but could not be re-read");
  }
  return paid;
}

export async function listRequestsForCustomer(
  customerId: string
): Promise<Array<{ request: Request; nextVisit: Visit | null }>> {
  return attachNextVisits(await listRequestsForCustomerModel(customerId));
}

export async function listRequestsForProvider(
  providerId: string
): Promise<Array<{ request: Request; nextVisit: Visit | null }>> {
  return attachNextVisits(await listRequestsForProviderModel(providerId));
}
