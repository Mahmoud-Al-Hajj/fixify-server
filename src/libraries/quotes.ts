import { randomUUID } from "node:crypto";
import type { PoolConnection } from "mysql2/promise";
import { withTransaction } from "../models-db/pool";
import { updateQuoteState, type Request } from "../models-db/requests";
import { insertVisit, hasOverlappingVisit } from "../models-db/visits";
import { lockProviderForUpdate } from "../models-db/providers";
import { insertJobEvent } from "../models-db/job-events";
import { wallClockToDate, beirutNow } from "../models-db/format-datetime";
import { JOB_EVENT_TYPE } from "../constants/job-event-type";
import { PRICE_STATUS, type PriceStatus } from "../constants/price-status";
import {
  REQUEST_STATUS,
  type RequestActorRole,
} from "../constants/request-status";
import { OPEN_VISIT_STATUSES } from "../constants/visit-status";
import { ConflictError, InvalidTransitionError } from "../constants/errors";
import { assertRequestTransition } from "./request-state-machine";
import { assertQuoteTransition } from "./quote-state-machine";
import {
  loadRequestForActor,
  rereadRequest,
  CHANGED_CONCURRENTLY_MESSAGE,
} from "./requests";

// Quote actions are exposed only for pending requests for now. The in-progress
// edges in QUOTE_TRANSITIONS belong to revised quotes, which arrive with photo
// upload. Declining a revision will also have to restore the accepted price
// from the latest quote_accepted payload, because a revision overwrites
// requests.price.
async function loadForQuoteAction(
  requestId: string,
  actorUserId: string,
  targetPriceStatus: PriceStatus
): Promise<{ request: Request; actorRole: RequestActorRole }> {
  const { request, actorRole } = await loadRequestForActor(
    requestId,
    actorUserId
  );
  assertQuoteTransition(
    request.priceStatus,
    targetPriceStatus,
    actorRole,
    request.status
  );
  if (request.status !== REQUEST_STATUS.PENDING) {
    throw new InvalidTransitionError(
      `Cannot move quote from '${request.priceStatus}' to '${targetPriceStatus}' while the request is '${request.status}'`
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

export async function proposeQuote(
  requestId: string,
  actorUserId: string,
  price: string
): Promise<Request> {
  const { request } = await loadForQuoteAction(
    requestId,
    actorUserId,
    PRICE_STATUS.PROPOSED
  );

  await withTransaction(async (conn) => {
    await applyQuoteState(conn, request, {
      toStatus: request.status,
      toPriceStatus: PRICE_STATUS.PROPOSED,
      newPrice: price,
      markResponded: true,
    });
    await insertJobEvent(conn, {
      id: randomUUID(),
      requestId: request.id,
      actorUserId,
      eventType: JOB_EVENT_TYPE.QUOTE_PROPOSED,
      payload: { price },
    });
  });

  return rereadRequest(request.id);
}

export async function declineQuote(
  requestId: string,
  actorUserId: string
): Promise<Request> {
  const { request } = await loadForQuoteAction(
    requestId,
    actorUserId,
    PRICE_STATUS.DECLINED
  );

  await withTransaction(async (conn) => {
    await applyQuoteState(conn, request, {
      toStatus: request.status,
      toPriceStatus: PRICE_STATUS.DECLINED,
      newPrice: null,
      markResponded: false,
    });
    await insertJobEvent(conn, {
      id: randomUUID(),
      requestId: request.id,
      actorUserId,
      eventType: JOB_EVENT_TYPE.QUOTE_DECLINED,
      payload: null,
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
    PRICE_STATUS.ACCEPTED
  );
  // Checked against the caller's actual role, not an assumed one: the request
  // state machine stays authoritative even if the quote rules change.
  assertRequestTransition(request.status, REQUEST_STATUS.SCHEDULED, actorRole);

  if (
    request.requestedStart === null ||
    request.estimatedDurationMinutes === null
  ) {
    throw new ConflictError(
      "Both requestedStart and estimatedDurationMinutes must be set on the request before a quote can be accepted"
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
  const scheduledEnd = new Date(
    scheduledStart.getTime() + request.estimatedDurationMinutes * 60_000
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
    // The accepted price is recorded so a later declined revision can restore
    // it: a revision overwrites requests.price.
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
