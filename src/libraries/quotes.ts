import { randomUUID } from "node:crypto";
import type { PoolConnection } from "mysql2/promise";
import { withTransaction } from "../models-db/pool";
import {
  updateQuoteState,
  updateRevisedQuote,
  type Request,
} from "../models-db/requests";
import { insertVisit, hasOverlappingVisit } from "../models-db/visits";
import { lockProviderForUpdate } from "../models-db/providers";
import { DEFAULT_VISIT_MINUTES } from "../constants/booking";
import { insertJobEvent } from "../models-db/job-events";
import { wallClockToDate, beirutNow } from "../models-db/format-datetime";
import { JOB_EVENT_TYPE } from "../constants/job-event-type";
import { PRICE_STATUS, type PriceStatus } from "../constants/price-status";
import {
  REQUEST_STATUS,
  REQUEST_ACTOR_ROLE,
  type RequestStatus,
  type RequestActorRole,
} from "../constants/request-status";
import { OPEN_VISIT_STATUSES } from "../constants/visit-status";
import {
  ConflictError,
  ForbiddenError,
  InvalidTransitionError,
  ValidationError,
} from "../constants/errors";
import { assertRequestTransition } from "./request-state-machine";
import {
  loadRequestForActor,
  rereadRequest,
  CHANGED_CONCURRENTLY_MESSAGE,
} from "./requests";

// Legal quote moves, and while the request is in which status. Pending moves are the initial quote. In-progress moves are a revised
// quote for extra work found mid-job; declining a revision keeps the agreed
// price, so it also lands on accepted.
const QUOTE_RULES: ReadonlyArray<{
  from: PriceStatus;
  to: PriceStatus;
  during: readonly RequestStatus[];
}> = [
  {
    from: PRICE_STATUS.NONE,
    to: PRICE_STATUS.PROPOSED,
    during: [REQUEST_STATUS.PENDING],
  },
  {
    from: PRICE_STATUS.DECLINED,
    to: PRICE_STATUS.PROPOSED,
    during: [REQUEST_STATUS.PENDING],
  },
  {
    from: PRICE_STATUS.PROPOSED,
    to: PRICE_STATUS.ACCEPTED,
    during: [REQUEST_STATUS.PENDING, REQUEST_STATUS.IN_PROGRESS],
  },
  {
    from: PRICE_STATUS.PROPOSED,
    to: PRICE_STATUS.DECLINED,
    during: [REQUEST_STATUS.PENDING],
  },
  {
    from: PRICE_STATUS.ACCEPTED,
    to: PRICE_STATUS.PROPOSED,
    during: [REQUEST_STATUS.IN_PROGRESS],
  },
];

// role is who may take the action at all (checked before any state, so a
// wrong role is always 403). targetFor picks the price_status it moves to. While in progress, a
// move to accepted answers a revision, whether it is accepted or declined.
async function loadForQuoteAction(
  requestId: string,
  actorUserId: string,
  role: RequestActorRole,
  targetFor: (request: Request) => PriceStatus
): Promise<{ request: Request; actorRole: RequestActorRole }> {
  const { request, actorRole } = await loadRequestForActor(
    requestId,
    actorUserId
  );
  const targetPriceStatus = targetFor(request);
  const move = `quote from '${request.priceStatus}' to '${targetPriceStatus}'`;
  if (actorRole !== role) {
    throw new ForbiddenError(`A ${actorRole} may not move a ${move}`);
  }
  if (
    request.status === REQUEST_STATUS.IN_PROGRESS &&
    targetPriceStatus === PRICE_STATUS.ACCEPTED &&
    request.revisedPrice === null
  ) {
    throw new ConflictError("No revised quote is waiting.");
  }
  const rule = QUOTE_RULES.find(
    (r) => r.from === request.priceStatus && r.to === targetPriceStatus
  );
  if (!rule) {
    throw new InvalidTransitionError(`Cannot move ${move}`);
  }
  if (!rule.during.includes(request.status)) {
    throw new InvalidTransitionError(
      `Cannot move ${move} while the request is '${request.status}'`
    );
  }
  return { request, actorRole };
}

async function applyQuoteState(
  conn: PoolConnection,
  request: Request,
  change: {
    toStatus: Request["status"];
    toPriceStatus: PriceStatus;
    newPrice: string | null;
    markResponded: boolean;
  }
): Promise<void> {
  const updated = await updateQuoteState(conn, {
    id: request.id,
    fromStatus: request.status,
    fromPriceStatus: request.priceStatus,
    fromPrice: request.price,
    ...change,
  });
  if (!updated) {
    throw new ConflictError(CHANGED_CONCURRENTLY_MESSAGE);
  }
}

async function applyRevision(
  conn: PoolConnection,
  request: Request,
  change: {
    toPriceStatus: PriceStatus;
    newRevisedPrice: string | null;
    applyRevision: boolean;
  }
): Promise<void> {
  const updated = await updateRevisedQuote(conn, {
    id: request.id,
    status: request.status,
    fromPriceStatus: request.priceStatus,
    fromRevisedPrice: request.revisedPrice,
    ...change,
  });
  if (!updated) {
    throw new ConflictError(CHANGED_CONCURRENTLY_MESSAGE);
  }
}

// A proposal while in progress is a revision: it needs a reason and waits in
// revised_price, leaving the agreed price in place.
function pendingRevision(request: Request): string {
  if (request.revisedPrice === null) {
    throw new Error("A proposed revision has no revised price");
  }
  return request.revisedPrice;
}

export async function proposeQuote(
  requestId: string,
  actorUserId: string,
  price: string,
  reason: string | null
): Promise<Request> {
  const { request } = await loadForQuoteAction(
    requestId,
    actorUserId,
    REQUEST_ACTOR_ROLE.PROVIDER,
    () => PRICE_STATUS.PROPOSED
  );
  const revising = request.status === REQUEST_STATUS.IN_PROGRESS;
  if (revising !== (reason !== null)) {
    throw new ValidationError(
      revising
        ? "A revised quote needs a reason"
        : "A reason is only given for a revised quote"
    );
  }

  await withTransaction(async (conn) => {
    if (reason === null) {
      await applyQuoteState(conn, request, {
        toStatus: request.status,
        toPriceStatus: PRICE_STATUS.PROPOSED,
        newPrice: price,
        markResponded: true,
      });
    } else {
      await applyRevision(conn, request, {
        toPriceStatus: PRICE_STATUS.PROPOSED,
        newRevisedPrice: price,
        applyRevision: false,
      });
    }
    await insertJobEvent(conn, {
      id: randomUUID(),
      requestId: request.id,
      actorUserId,
      eventType: JOB_EVENT_TYPE.QUOTE_PROPOSED,
      payload: reason === null ? { price } : { revisedPrice: price, reason },
    });
  });

  return rereadRequest(request.id);
}

export async function declineQuote(
  requestId: string,
  actorUserId: string
): Promise<Request> {
  // Declining a revision keeps the agreed price: back to accepted.
  const { request } = await loadForQuoteAction(
    requestId,
    actorUserId,
    REQUEST_ACTOR_ROLE.CUSTOMER,
    (r) =>
      r.status === REQUEST_STATUS.IN_PROGRESS
        ? PRICE_STATUS.ACCEPTED
        : PRICE_STATUS.DECLINED
  );
  const declinedRevision =
    request.status === REQUEST_STATUS.IN_PROGRESS
      ? pendingRevision(request)
      : null;

  await withTransaction(async (conn) => {
    if (declinedRevision === null) {
      await applyQuoteState(conn, request, {
        toStatus: request.status,
        toPriceStatus: PRICE_STATUS.DECLINED,
        newPrice: null,
        markResponded: false,
      });
    } else {
      await applyRevision(conn, request, {
        toPriceStatus: PRICE_STATUS.ACCEPTED,
        newRevisedPrice: null,
        applyRevision: false,
      });
    }
    await insertJobEvent(conn, {
      id: randomUUID(),
      requestId: request.id,
      actorUserId,
      eventType: JOB_EVENT_TYPE.QUOTE_DECLINED,
      payload:
        declinedRevision === null ? null : { declinedPrice: declinedRevision },
    });
  });

  return rereadRequest(request.id);
}

export async function acceptQuote(
  requestId: string,
  actorUserId: string
): Promise<Request> {
  const { request, actorRole } = await loadForQuoteAction(
    requestId,
    actorUserId,
    REQUEST_ACTOR_ROLE.CUSTOMER,
    () => PRICE_STATUS.ACCEPTED
  );
  if (request.status === REQUEST_STATUS.IN_PROGRESS) {
    const revisedPrice = pendingRevision(request);
    await withTransaction(async (conn) => {
      await applyRevision(conn, request, {
        toPriceStatus: PRICE_STATUS.ACCEPTED,
        newRevisedPrice: null,
        applyRevision: true,
      });
      await insertJobEvent(conn, {
        id: randomUUID(),
        requestId: request.id,
        actorUserId,
        eventType: JOB_EVENT_TYPE.QUOTE_ACCEPTED,
        payload: { price: revisedPrice },
      });
    });
    return rereadRequest(request.id);
  }
  // Checked against the caller's actual role, not an assumed one: the request
  // state machine stays authoritative even if the quote rules change.
  assertRequestTransition(request.status, REQUEST_STATUS.SCHEDULED, actorRole);

  if (request.requestedStart === null) {
    throw new ConflictError(
      "requestedStart must be set on the request before a quote can be accepted"
    );
  }
  const price = request.price;
  if (price === null) {
    throw new Error("A proposed quote has no price");
  }

  const scheduledStart = wallClockToDate(request.requestedStart);
  if (scheduledStart <= beirutNow()) {
    throw new ConflictError(
      "The requested start time has passed; cancel this request and book a new time"
    );
  }
  // COALESCE(estimated_duration_minutes, 60): a job nobody estimated gets the
  // default visit length.
  const visitMinutes =
    request.estimatedDurationMinutes ?? DEFAULT_VISIT_MINUTES;
  const scheduledEnd = new Date(
    scheduledStart.getTime() + visitMinutes * 60_000
  );

  await withTransaction(async (conn) => {
    // The lock comes first: the overlap read below then sees every visit a
    // competing booking for this provider committed before we got the lock.
    await lockProviderForUpdate(conn, request.providerId);
    if (
      await hasOverlappingVisit(
        conn,
        request.providerId,
        scheduledStart,
        scheduledEnd,
        OPEN_VISIT_STATUSES
      )
    ) {
      throw new ConflictError(
        "That time overlaps another booking with this provider. Please choose another time."
      );
    }
    await applyQuoteState(conn, request, {
      toStatus: REQUEST_STATUS.SCHEDULED,
      toPriceStatus: PRICE_STATUS.ACCEPTED,
      newPrice: null,
      markResponded: false,
    });
    await insertVisit(conn, {
      id: randomUUID(),
      requestId: request.id,
      providerId: request.providerId,
      scheduledStart,
      scheduledEnd,
    });
    await insertJobEvent(conn, {
      id: randomUUID(),
      requestId: request.id,
      actorUserId,
      eventType: JOB_EVENT_TYPE.QUOTE_ACCEPTED,
      payload: { price },
    });
  });

  return rereadRequest(request.id);
}
