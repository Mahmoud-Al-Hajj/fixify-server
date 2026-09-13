import { randomUUID } from "node:crypto";
import type { PoolConnection } from "mysql2/promise";
import { pool } from "../models-db/pool";
import {
  findRequestById,
  updateQuoteState,
  type Request,
} from "../models-db/requests";
import { insertVisit } from "../models-db/visits";
import { insertJobEvent } from "../models-db/job-events";
import { wallClockToDate } from "../models-db/format-datetime";
import { JOB_EVENT_TYPE } from "../constants/job-event-type";
import { PRICE_STATUS, type PriceStatus } from "../constants/price-status";
import { REQUEST_STATUS } from "../constants/request-status";
import {
  NotFoundError,
  ConflictError,
  InvalidTransitionError,
} from "../constants/errors";
import {
  assertRequestTransition,
  REQUEST_ACTOR_ROLE,
} from "./request-state-machine";
import { assertQuoteTransition } from "./quote-state-machine";
import { resolveActorRole } from "./requests";

// Quote actions are exposed only for pending requests for now. The in-progress
// edges in QUOTE_TRANSITIONS belong to revised quotes, which arrive with photo
// upload. Declining a revision will also have to restore the accepted price
// from the latest quote_accepted payload, because a revision overwrites
// requests.price.
async function loadForQuoteAction(
  requestId: string,
  actorUserId: string,
  targetPriceStatus: PriceStatus
): Promise<Request> {
  const request = await findRequestById(requestId);
  if (!request) {
    throw new NotFoundError("Request not found");
  }
  const actorRole = resolveActorRole(request, actorUserId);
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
  return request;
}

async function inTransaction(
  work: (conn: PoolConnection) => Promise<void>
): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    try {
      await work(conn);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  } finally {
    conn.release();
  }
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
    throw new InvalidTransitionError(
      "Request was changed by another action; reload it and try again"
    );
  }
}

async function reread(requestId: string): Promise<Request> {
  const request = await findRequestById(requestId);
  if (!request) {
    throw new Error("Request was updated but could not be re-read");
  }
  return request;
}

export async function proposeQuote(
  requestId: string,
  actorUserId: string,
  price: string
): Promise<Request> {
  const request = await loadForQuoteAction(
    requestId,
    actorUserId,
    PRICE_STATUS.PROPOSED
  );

  await inTransaction(async (conn) => {
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

  return reread(request.id);
}

export async function declineQuote(
  requestId: string,
  actorUserId: string
): Promise<Request> {
  const request = await loadForQuoteAction(
    requestId,
    actorUserId,
    PRICE_STATUS.DECLINED
  );

  await inTransaction(async (conn) => {
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

  return reread(request.id);
}

export async function acceptQuote(
  requestId: string,
  actorUserId: string
): Promise<Request> {
  const request = await loadForQuoteAction(
    requestId,
    actorUserId,
    PRICE_STATUS.ACCEPTED
  );
  // The quote table has already confirmed the actor is the customer.
  assertRequestTransition(
    request.status,
    REQUEST_STATUS.SCHEDULED,
    REQUEST_ACTOR_ROLE.CUSTOMER
  );

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
  const scheduledEnd = new Date(
    scheduledStart.getTime() + request.estimatedDurationMinutes * 60_000
  );

  await inTransaction(async (conn) => {
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

  return reread(request.id);
}
