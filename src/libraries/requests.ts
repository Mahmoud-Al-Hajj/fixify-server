import { randomUUID } from "node:crypto";
import type { PoolConnection } from "mysql2/promise";
import { withTransaction } from "../models-db/pool";
import {
  updateRequestStatus,
  lockRequestForUpdate,
  markRequestPaid as markRequestPaidModel,
  withdrawPendingRevision,
  updateRequestedStart,
  findRequestById,
  findExpiredPendingRequestIds,
  lockExpiredPendingRequest,
  type Request,
} from "../models-db/requests";
import { logger } from "../config/logger";
import { listAvailability } from "../models-db/providers";
import {
  findVisitsForRequest,
  updateVisitStatus,
  cancelOpenVisitsForRequest,
  type Visit,
} from "../models-db/visits";
import { insertJobEvent } from "../models-db/job-events";
import {
  beirutNow,
  formatWallClock,
  wallClockToDate,
} from "../models-db/format-datetime";
import {
  DEFAULT_VISIT_MINUTES,
  EXPIRY_BATCH_SIZE,
  PENDING_EXPIRY_HOURS,
} from "../constants/booking";
import {
  VISIT_STATUS,
  OPEN_VISIT_STATUSES,
  type VisitStatus,
} from "../constants/visit-status";
import { JOB_EVENT_TYPE, type JobEventType } from "../constants/job-event-type";
import { PRICE_STATUS } from "../constants/price-status";
import {
  REQUEST_STATUS,
  REQUEST_ACTOR_ROLE,
  type RequestStatus,
  type RequestActorRole,
} from "../constants/request-status";
import {
  ForbiddenError,
  ValidationError,
  ConflictError,
} from "../constants/errors";
import { assertRequestTransition } from "./request-state-machine";
import { fitsWorkingHours } from "./slot-rules";
import { assertStartNotTooEarly } from "./visit-rules";
import { assertRequestTimeFree } from "./slot-reservation";
import {
  loadRequestForActor,
  rereadRequest,
  CHANGED_CONCURRENTLY_MESSAGE,
} from "./request-access";

// A request's lifecycle after it is created: reject, cancel, start, complete
// (transitionRequest: the state machine check, the guarded status UPDATE, the
// visit changes and the job_events row in one transaction), the server's
// expiry of stale pending requests (the cancel transition, no actor), plus two changes
// that are not transitions: marking a completed job paid, and moving the
// requested start of a pending one. Creation is request-booking.ts, quotes
// are quotes.ts, reschedules and follow-up visits are visits.ts.

interface TransitionSideEffects {
  eventPayload: Readonly<Record<string, string>> | null;
  // Runs inside the transaction before the conditional request update, for a
  // change without which the new status would violate a CHECK. Its UPDATE of
  // the request row by primary key locks the row from then on, even when it
  // changes nothing (REPEATABLE READ).
  beforeStatusUpdate?: (conn: PoolConnection) => Promise<void>;
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

type TransitionChange = Pick<
  TransitionInput,
  "targetStatus" | "eventType" | "markResponded" | "markCompleted"
>;

// The transaction of a validated transition: the side effects, the guarded
// status UPDATE and the job_events row as one unit. actorUserId is null only
// for a transition the server makes itself.
async function commitTransition(
  request: Request,
  actorUserId: string | null,
  change: TransitionChange,
  sideEffects: TransitionSideEffects
): Promise<void> {
  await withTransaction(async (conn) => {
    if (sideEffects.beforeStatusUpdate) {
      await sideEffects.beforeStatusUpdate(conn);
    }
    const updated = await updateRequestStatus(conn, {
      id: request.id,
      fromStatus: request.status,
      toStatus: change.targetStatus,
      markResponded: change.markResponded,
      markCompleted: change.markCompleted,
      requireNoRevision: change.markCompleted,
    });
    if (!updated) {
      throw new ConflictError(CHANGED_CONCURRENTLY_MESSAGE);
    }
    if (sideEffects.applyVisitChanges) {
      await sideEffects.applyVisitChanges(conn);
    }
    await insertJobEvent(conn, {
      id: randomUUID(),
      requestId: request.id,
      actorUserId,
      eventType: change.eventType,
      payload: sideEffects.eventPayload,
    });
  });
}

async function transitionRequest(input: TransitionInput): Promise<Request> {
  const { request, actorRole } = await loadRequestForActor(
    input.requestId,
    input.actorUserId
  );
  assertRequestTransition(request.status, input.targetStatus, actorRole);
  const sideEffects: TransitionSideEffects = input.prepare
    ? await input.prepare(request)
    : { eventPayload: null };

  await commitTransition(request, input.actorUserId, input, sideEffects);
  return rereadRequest(request.id);
}

// A revised quote still waiting is withdrawn; the agreed price stays. Every
// open visit is cancelled with the request, which releases its slot. A
// pending request has no visits, so this is a no-op there.
function cancelSideEffects(
  request: Request,
  eventPayload: TransitionSideEffects["eventPayload"]
): TransitionSideEffects {
  return {
    eventPayload,
    beforeStatusUpdate: (conn) => withdrawPendingRevision(conn, request.id),
    applyVisitChanges: (conn) =>
      cancelOpenVisitsForRequest(conn, request.id, OPEN_VISIT_STATUSES),
  };
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
    prepare: async (request) =>
      cancelSideEffects(request, { from: request.status }),
  });
}

// One pending request whose time passed long ago: the cancel transition with
// no actor. The server is not a role on the request, so there is no
// assertRequestTransition role check; pending -> cancelled is a legal edge.
// Under the row lock it re-checks that the request is still pending and still
// past the cutoff, so a time the customer just moved forward is not expired.
async function expirePendingRequest(id: string, cutoff: Date): Promise<void> {
  const request = await findRequestById(id);
  if (!request || request.status !== REQUEST_STATUS.PENDING) {
    throw new ConflictError(CHANGED_CONCURRENTLY_MESSAGE);
  }
  const cancel = cancelSideEffects(request, null);
  await commitTransition(
    request,
    null,
    {
      targetStatus: REQUEST_STATUS.CANCELLED,
      eventType: JOB_EVENT_TYPE.REQUEST_EXPIRED,
      markResponded: false,
      markCompleted: false,
    },
    {
      ...cancel,
      beforeStatusUpdate: async (conn) => {
        if (!(await lockExpiredPendingRequest(conn, id, cutoff))) {
          throw new ConflictError(CHANGED_CONCURRENTLY_MESSAGE);
        }
        await cancel.beforeStatusUpdate?.(conn);
      },
    }
  );
}

// Cancels pending requests whose requested start passed PENDING_EXPIRY_HOURS
// before `now` (Beirut wall clock), up to EXPIRY_BATCH_SIZE per call; the next
// run takes the rest. One transaction per request, so one failure does not
// stop the others. Returns how many expired.
export async function expirePendingRequests(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - PENDING_EXPIRY_HOURS * 3_600_000);
  const ids = await findExpiredPendingRequestIds(cutoff, EXPIRY_BATCH_SIZE);
  let expired = 0;
  for (const id of ids) {
    try {
      await expirePendingRequest(id, cutoff);
      expired++;
    } catch (err) {
      if (err instanceof ConflictError) {
        logger.info("pending request changed before it could expire", {
          requestId: id,
        });
      } else {
        logger.error("failed to expire a pending request", {
          requestId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return expired;
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
    throw new ConflictError(CHANGED_CONCURRENTLY_MESSAGE);
  }
}

// Visits come back ordered by scheduled_start, so this is the earliest visit
// still waiting to start.
function nextScheduledVisit(visits: readonly Visit[]): Visit {
  const next = visits.find((visit) => visit.status === VISIT_STATUS.SCHEDULED);
  if (!next) {
    throw new ConflictError("This request has no scheduled visit to start");
  }
  return next;
}

// A job that is already in progress has finished its visit and has a
// follow-up scheduled: start that one. Not a request transition, so the
// state machine is not involved; the role rule matches its start(P).
async function startNextVisit(
  request: Request,
  actorRole: RequestActorRole,
  actorUserId: string
): Promise<Request> {
  if (actorRole !== REQUEST_ACTOR_ROLE.PROVIDER) {
    throw new ForbiddenError("Only the provider can start a visit");
  }
  const visits = await findVisitsForRequest(request.id);
  if (visits.some((visit) => visit.status === VISIT_STATUS.IN_PROGRESS)) {
    throw new ConflictError("A visit of this request is already in progress");
  }
  const next = nextScheduledVisit(visits);
  assertStartNotTooEarly(wallClockToDate(next.scheduledStart), beirutNow());

  // The request row first, the same lock order as cancel.
  await withTransaction(async (conn) => {
    const status = await lockRequestForUpdate(conn, request.id);
    if (status !== REQUEST_STATUS.IN_PROGRESS) {
      throw new ConflictError(CHANGED_CONCURRENTLY_MESSAGE);
    }
    await applyVisitTransition(conn, next, VISIT_STATUS.IN_PROGRESS, true);
    await insertJobEvent(conn, {
      id: randomUUID(),
      requestId: request.id,
      actorUserId,
      eventType: JOB_EVENT_TYPE.REQUEST_STARTED,
      payload: { visitId: next.id },
    });
  });

  return rereadRequest(request.id);
}

export async function startRequest(
  requestId: string,
  actorUserId: string
): Promise<Request> {
  const { request, actorRole } = await loadRequestForActor(
    requestId,
    actorUserId
  );
  if (request.status === REQUEST_STATUS.IN_PROGRESS) {
    return startNextVisit(request, actorRole, actorUserId);
  }
  return transitionRequest({
    requestId,
    actorUserId,
    targetStatus: REQUEST_STATUS.IN_PROGRESS,
    eventType: JOB_EVENT_TYPE.REQUEST_STARTED,
    markResponded: false,
    markCompleted: false,
    prepare: async (request) => {
      const visit = nextScheduledVisit(await findVisitsForRequest(request.id));
      assertStartNotTooEarly(
        wallClockToDate(visit.scheduledStart),
        beirutNow()
      );
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
      if (request.priceStatus === PRICE_STATUS.PROPOSED) {
        throw new ConflictError(
          "A revised quote is still waiting for the customer's answer"
        );
      }
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
          "This request still has a scheduled follow-up visit; start and complete it, or cancel the job."
        );
      }
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
  const { request, actorRole } = await loadRequestForActor(
    requestId,
    actorUserId
  );
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

  await withTransaction(async (conn) => {
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
  });

  return rereadRequest(request.id);
}

// The customer moves the time of a job not yet scheduled, e.g. after quote
// acceptance found the slot taken. It reserves nothing (acceptance still runs
// reserveSlot) and leaves the quote as it is. The same time again changes
// nothing, so a double tap or a retry gets the current request.
export async function changeRequestedStart(
  requestId: string,
  actorUserId: string,
  start: Date
): Promise<Request> {
  const { request, actorRole } = await loadRequestForActor(
    requestId,
    actorUserId
  );
  if (actorRole !== REQUEST_ACTOR_ROLE.CUSTOMER) {
    throw new ForbiddenError(
      "Only the customer can change the requested start"
    );
  }
  if (request.status !== REQUEST_STATUS.PENDING) {
    throw new ConflictError(
      "The requested start can only change before a quote is accepted"
    );
  }
  const from =
    request.requestedStart === null
      ? null
      : wallClockToDate(request.requestedStart);
  if (from !== null && from.getTime() === start.getTime()) {
    return request;
  }
  if (start <= beirutNow()) {
    throw new ValidationError("requestedStart must be in the future");
  }
  const minutes = request.estimatedDurationMinutes ?? DEFAULT_VISIT_MINUTES;
  const end = new Date(start.getTime() + minutes * 60_000);
  if (
    !fitsWorkingHours(await listAvailability([request.providerId]), start, end)
  ) {
    throw new ValidationError(
      "That time is outside the provider's working hours"
    );
  }

  await withTransaction(async (conn) => {
    // Provider lock first, then the request row (the guarded UPDATE): the
    // same order as quote acceptance.
    await assertRequestTimeFree(conn, {
      customerId: request.customerId,
      providerId: request.providerId,
      requestedStart: start,
      estimatedDurationMinutes: request.estimatedDurationMinutes,
      excludeRequestId: request.id,
    });
    const changed = await updateRequestedStart(conn, {
      id: request.id,
      status: REQUEST_STATUS.PENDING,
      fromRequestedStart: from,
      requestedStart: start,
    });
    if (!changed) {
      throw new ConflictError(CHANGED_CONCURRENTLY_MESSAGE);
    }
    await insertJobEvent(conn, {
      id: randomUUID(),
      requestId: request.id,
      actorUserId,
      eventType: JOB_EVENT_TYPE.REQUESTED_START_CHANGED,
      // from is absent only on a request booked before requestedStart was
      // required.
      payload: {
        ...(request.requestedStart === null
          ? {}
          : { from: request.requestedStart }),
        to: formatWallClock(start),
      },
    });
  });

  return rereadRequest(request.id);
}
