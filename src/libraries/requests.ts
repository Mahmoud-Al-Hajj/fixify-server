import { randomUUID } from "node:crypto";
import type { PoolConnection } from "mysql2/promise";
import { withTransaction } from "../models-db/pool";
import {
  insertRequest,
  findRequestById,
  updateRequestStatus,
  lockRequestForUpdate,
  markRequestPaid as markRequestPaidModel,
  withdrawPendingRevision,
  listRequestsForCustomer as listRequestsForCustomerModel,
  listRequestsForProvider as listRequestsForProviderModel,
  findRequestNames,
  updateRequestedStart,
  type Request,
  type NamedRequest,
  type InsertRequestInput,
} from "../models-db/requests";
import {
  findProviderAcceptance,
  providerAcceptsCategory,
  listAvailability,
  lockProviderForUpdate,
} from "../models-db/providers";
import {
  findVisitsForRequest,
  findOpenVisitsForRequests,
  updateVisitStatus,
  cancelOpenVisitsForRequest,
  type Visit,
} from "../models-db/visits";
import {
  insertJobEvent,
  findAiStatusAtBooking,
  findLatestQuoteReason,
  listEventsForRequest,
} from "../models-db/job-events";
import { beirutNow, wallClockToDate } from "../models-db/format-datetime";
import { findReviewForRequest } from "../models-db/reviews";
import {
  findIntakeSession,
  listIntakeMessages,
  lockIntakeSession,
  readSessionFreeze,
  type IntakeMessage,
} from "../models-db/intake";
import { findCategoryName } from "../models-db/categories";
import {
  listRequestItems,
  insertRequestItems,
  updateRequestItem,
  deleteRequestItems,
  type RequestItem,
} from "../models-db/request-items";
import { ITEM_SOURCE } from "../constants/item-source";
import { AI_STATUS, type AiStatus } from "../constants/ai-status";
import { MESSAGE_SENDER } from "../constants/message-sender";
import { BOOKING_SOURCE, DEFAULT_VISIT_MINUTES } from "../constants/booking";
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
  NotFoundError,
  ForbiddenError,
  ValidationError,
  ConflictError,
  ERROR_CODE,
} from "../constants/errors";
import { assertRequestTransition } from "./request-state-machine";
import {
  currentDiagnosis,
  toDiagnosisView,
  type DiagnosisView,
} from "./intake";
import { buildDescription, deriveBookingFields } from "./booking-from-session";
import { toEventEntry, type EventEntry } from "./event-entries";
import { fitsWorkingHours } from "./slot-rules";
import { assertRequestTimeFree } from "./slot-reservation";

// A request this service just wrote; missing only if deleted concurrently,
// which no endpoint does.
export async function rereadRequest(id: string): Promise<Request> {
  const request = await findRequestById(id);
  if (!request) {
    throw new Error("Request was written but could not be re-read");
  }
  return request;
}

export type CreateRequestInput = Omit<
  InsertRequestInput,
  "id" | "intakeSessionId"
>;

// The checks every booking runs before its transaction, whichever path it
// came through.
async function assertBookable(
  input: Pick<
    CreateRequestInput,
    "customerId" | "providerId" | "categoryId" | "requestedStart"
  >
): Promise<void> {
  if (input.customerId === input.providerId) {
    throw new ValidationError("You cannot request service from yourself");
  }
  if (input.requestedStart !== null && input.requestedStart <= beirutNow()) {
    throw new ValidationError("requestedStart must be in the future");
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
}

// A pending request holds no slot, but its time must not clash with an open
// visit of the provider or this customer's own pending request to them.
// Legacy requests with no requestedStart have no time to check.
async function assertTimeFree(
  conn: PoolConnection,
  input: Pick<
    CreateRequestInput,
    "customerId" | "providerId" | "requestedStart"
  > & {
    estimatedDurationMinutes: number | null;
  },
  excludeRequestId: string | null
): Promise<void> {
  if (input.requestedStart === null) return;
  const minutes = input.estimatedDurationMinutes ?? DEFAULT_VISIT_MINUTES;
  await assertRequestTimeFree(conn, {
    customerId: input.customerId,
    providerId: input.providerId,
    start: input.requestedStart,
    end: new Date(input.requestedStart.getTime() + minutes * 60_000),
    excludeRequestId,
  });
}

export async function createRequest(
  input: CreateRequestInput
): Promise<Request> {
  await assertBookable(input);
  const id = randomUUID();

  await withTransaction(async (conn) => {
    await assertTimeFree(conn, input, null);
    await insertRequest(conn, { id, ...input, intakeSessionId: null });
    await insertJobEvent(conn, {
      id: randomUUID(),
      requestId: id,
      actorUserId: input.customerId,
      eventType: JOB_EVENT_TYPE.REQUEST_CREATED,
      payload: null,
    });
  });

  return rereadRequest(id);
}

export type BookFromSessionInput = Pick<
  CreateRequestInput,
  | "customerId"
  | "providerId"
  | "categoryId"
  | "addressText"
  | "requestedStart"
  | "isUrgent"
> & { intakeSessionId: string };

// docs/ai-plan.md §13.3. The session lock is the transaction's first read, so
// a message or booking committed while waiting is seen. The service type,
// duration, description and parts come from the session, not the client.
export async function createRequestFromSession(
  input: BookFromSessionInput
): Promise<Request> {
  await assertBookable(input);
  const categoryName = await findCategoryName(input.categoryId);
  if (categoryName === null) {
    throw new Error("A category the provider offers could not be read");
  }
  const id = randomUUID();

  await withTransaction(async (conn) => {
    const session = await lockIntakeSession(conn, input.intakeSessionId);
    if (!session || session.customerId !== input.customerId) {
      throw new NotFoundError("Intake session not found");
    }
    // Before the first plain read (readSessionFreeze), so the overlap checks
    // below see every booking committed while we waited. Lock order: session,
    // then provider.
    await lockProviderForUpdate(conn, input.providerId);
    if ((await readSessionFreeze(conn, input.intakeSessionId)).booked) {
      throw new ConflictError(
        "This problem has already been booked; describe a new one in a new session",
        ERROR_CODE.SESSION_ALREADY_BOOKED
      );
    }
    const messages = await listIntakeMessages(input.intakeSessionId, conn);
    const description = buildDescription(
      messages
        .filter((message) => message.sender === MESSAGE_SENDER.CUSTOMER)
        .map((message) => message.body)
    );
    if (description === null) {
      throw new ValidationError(
        "Describe the problem in words before booking",
        ERROR_CODE.SESSION_HAS_NO_TEXT
      );
    }
    const derived = deriveBookingFields(
      {
        aiStatus: session.aiStatus,
        diagnosis: currentDiagnosis({ id: input.intakeSessionId, ...session }),
      },
      categoryName
    );
    await assertTimeFree(conn, { ...input, ...derived }, null);
    await insertRequest(conn, {
      ...input,
      id,
      serviceType: derived.serviceType,
      description,
      estimatedDurationMinutes: derived.estimatedDurationMinutes,
    });
    await insertRequestItems(
      conn,
      id,
      derived.parts.map((part) => ({
        id: randomUUID(),
        name: part.name,
        quantity: part.quantity,
        unit: part.unit,
        estimatedUnitPrice: null,
        source: ITEM_SOURCE.AI,
      }))
    );
    await insertJobEvent(conn, {
      id: randomUUID(),
      requestId: id,
      actorUserId: input.customerId,
      eventType: JOB_EVENT_TYPE.REQUEST_CREATED,
      payload: {
        source: BOOKING_SOURCE.INTAKE,
        intakeSessionId: input.intakeSessionId,
        aiStatusAtBooking: session.aiStatus,
        usedDiagnosis: derived.usedDiagnosis,
        partsSeeded: derived.parts.length,
      },
    });
  });

  return rereadRequest(id);
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

export async function getRequestForActor(
  requestId: string,
  actorUserId: string
): Promise<{ request: NamedRequest; visits: Visit[]; hasReview: boolean }> {
  const { request, actorRole } = await loadRequestForActor(
    requestId,
    actorUserId
  );
  const names = await findRequestNames(request.id, actorRole);
  if (!names) {
    throw new NotFoundError("Request not found");
  }
  const visits = await findVisitsForRequest(request.id);
  const review = await findReviewForRequest(request.id);
  return {
    request: { ...request, ...names },
    visits,
    hasReview: review !== null,
  };
}

// GET /requests/:id: the details plus the parts list and the reason for a
// revised quote that waits for the customer. There is no column for the
// reason; while a revision is open, the latest QUOTE_PROPOSED event is that
// revision. Items are read after the ownership check in getRequestForActor.
export async function getRequestDetailsForActor(
  requestId: string,
  actorUserId: string
): Promise<
  Awaited<ReturnType<typeof getRequestForActor>> & {
    revisionReason: string | null;
    items: RequestItem[];
  }
> {
  const details = await getRequestForActor(requestId, actorUserId);
  const { request } = details;
  const revisionOpen =
    request.status === REQUEST_STATUS.IN_PROGRESS &&
    request.priceStatus === PRICE_STATUS.PROPOSED &&
    request.revisedPrice !== null;
  const revisionReason = revisionOpen
    ? await findLatestQuoteReason(request.id)
    : null;
  const items = await listRequestItems(request.id);
  return { ...details, revisionReason, items };
}

// The job's history for either party, oldest first, in its public shape: no
// raw payloads, no user ids (event-entries.ts).
export async function getRequestTimeline(
  requestId: string,
  actorUserId: string
): Promise<EventEntry[]> {
  const { request } = await loadRequestForActor(requestId, actorUserId);
  const events = await listEventsForRequest(request.id);
  return events.map((event) => toEventEntry(event, request));
}

export interface IssueCard {
  request: Request;
  // null for a request booked through search, which has no session.
  aiStatus: AiStatus | null;
  diagnosis: DiagnosisView | null;
  isLate: boolean;
  messages: IntakeMessage[];
  items: RequestItem[];
}

// What the assigned provider reads for a job: the request, the customer's
// intake conversation and its diagnosis (reached only through the request),
// and the parts list. Late = the analysis was still pending at booking and is
// done now; sessions are frozen after booking, so nothing else can make it
// done later.
export async function getIssueCard(
  requestId: string,
  actorUserId: string
): Promise<IssueCard> {
  const { request, actorRole } = await loadRequestForActor(
    requestId,
    actorUserId
  );
  if (actorRole !== REQUEST_ACTOR_ROLE.PROVIDER) {
    throw new ForbiddenError(
      "Only the assigned provider can open the issue card"
    );
  }
  const items = await listRequestItems(request.id);
  if (request.intakeSessionId === null) {
    return {
      request,
      aiStatus: null,
      diagnosis: null,
      isLate: false,
      messages: [],
      items,
    };
  }
  const session = await findIntakeSession(request.intakeSessionId);
  if (!session) {
    throw new Error("A request's intake session could not be read");
  }
  const diagnosis = currentDiagnosis(session);
  return {
    request,
    aiStatus: session.aiStatus,
    diagnosis: diagnosis === null ? null : await toDiagnosisView(diagnosis),
    isLate:
      diagnosis !== null &&
      (await findAiStatusAtBooking(request.id)) === AI_STATUS.PENDING,
    messages: await listIntakeMessages(session.id),
    items,
  };
}

export type RequestItemInput = Omit<RequestItem, "id" | "source"> & {
  id?: string | undefined;
};

const PARTS_EDITABLE: readonly RequestStatus[] = [
  REQUEST_STATUS.PENDING,
  REQUEST_STATUS.SCHEDULED,
  REQUEST_STATUS.IN_PROGRESS,
];

// Replaces the parts list with the provider's version. New and edited items
// are marked source = 'provider'; unchanged items keep their source. One
// job_events row records the counts, only when something changed.
export async function saveRequestItems(
  requestId: string,
  actorUserId: string,
  input: readonly RequestItemInput[]
): Promise<RequestItem[]> {
  const { request, actorRole } = await loadRequestForActor(
    requestId,
    actorUserId
  );
  if (actorRole !== REQUEST_ACTOR_ROLE.PROVIDER) {
    throw new ForbiddenError(
      "Only the assigned provider can edit the parts list"
    );
  }
  await withTransaction(async (conn) => {
    const status = await lockRequestForUpdate(conn, request.id);
    if (status === null || !PARTS_EDITABLE.includes(status)) {
      throw new ConflictError(
        "The parts list can no longer change: the request is closed"
      );
    }
    const current = new Map(
      (await listRequestItems(request.id, conn)).map((i) => [i.id, i])
    );
    const unknown = input.filter((i) => i.id && !current.has(i.id));
    if (unknown.length > 0) {
      throw new ValidationError("Item id(s) not on this request");
    }
    const kept = new Set(input.map((i) => i.id));
    const removed = [...current.keys()].filter((id) => !kept.has(id));
    const added: RequestItem[] = [];
    const updated: RequestItem[] = [];
    for (const { id, ...fields } of input) {
      const before = id ? current.get(id) : undefined;
      const item = {
        ...fields,
        id: id ?? randomUUID(),
        source: ITEM_SOURCE.PROVIDER,
      };
      if (!before) {
        added.push(item);
      } else if (
        before.name !== item.name ||
        before.quantity !== item.quantity ||
        before.unit !== item.unit ||
        before.estimatedUnitPrice !== item.estimatedUnitPrice
      ) {
        updated.push(item);
      }
    }
    if (added.length + updated.length + removed.length === 0) return;
    await deleteRequestItems(conn, removed);
    await insertRequestItems(conn, request.id, added);
    for (const item of updated) {
      await updateRequestItem(conn, item);
    }
    await insertJobEvent(conn, {
      id: randomUUID(),
      requestId: request.id,
      actorUserId,
      eventType: JOB_EVENT_TYPE.REQUEST_ITEMS_UPDATED,
      payload: {
        added: added.length,
        updated: updated.length,
        removed: removed.length,
      },
    });
  });
  return listRequestItems(request.id);
}

async function attachNextVisits<T extends Request>(
  requests: T[]
): Promise<Array<{ request: T; nextVisit: Visit | null }>> {
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

// Always raised as a ConflictError (409 CONFLICT): the action was valid when
// checked but another write got there first, so reloading and retrying may
// succeed. InvalidTransitionError stays reserved for moves that are never
// allowed, whatever the timing.
export const CHANGED_CONCURRENTLY_MESSAGE =
  "Request was changed by another action; reload it and try again";

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

async function transitionRequest(input: TransitionInput): Promise<Request> {
  const { request, actorRole } = await loadRequestForActor(
    input.requestId,
    input.actorUserId
  );
  assertRequestTransition(request.status, input.targetStatus, actorRole);
  const sideEffects: TransitionSideEffects = input.prepare
    ? await input.prepare(request)
    : { eventPayload: null };

  await withTransaction(async (conn) => {
    if (sideEffects.beforeStatusUpdate) {
      await sideEffects.beforeStatusUpdate(conn);
    }
    const updated = await updateRequestStatus(conn, {
      id: request.id,
      fromStatus: request.status,
      toStatus: input.targetStatus,
      markResponded: input.markResponded,
      markCompleted: input.markCompleted,
      requireNoRevision: input.markCompleted,
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
      actorUserId: input.actorUserId,
      eventType: input.eventType,
      payload: sideEffects.eventPayload,
    });
  });

  return rereadRequest(request.id);
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
    // A revised quote still waiting is withdrawn; the agreed price stays.
    // Every open visit is cancelled with the request, which releases its
    // slot. A pending request has no visits, so this is a no-op there.
    prepare: async (request) => ({
      eventPayload: { from: request.status },
      beforeStatusUpdate: (conn) => withdrawPendingRevision(conn, request.id),
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
    throw new ConflictError(CHANGED_CONCURRENTLY_MESSAGE);
  }
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
  const next = visits.find((visit) => visit.status === VISIT_STATUS.SCHEDULED);
  if (!next) {
    throw new ConflictError("This request has no scheduled visit to start");
  }

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
      // Visits come back ordered by scheduled_start, so this is the earliest
      // visit still waiting to start.
      const visit = (await findVisitsForRequest(request.id)).find(
        (candidate) => candidate.status === VISIT_STATUS.SCHEDULED
      );
      if (!visit) {
        throw new ConflictError("This request has no scheduled visit to start");
      }
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
    await assertTimeFree(
      conn,
      {
        customerId: request.customerId,
        providerId: request.providerId,
        requestedStart: start,
        estimatedDurationMinutes: request.estimatedDurationMinutes,
      },
      request.id
    );
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
        to: start.toISOString().slice(0, 23),
      },
    });
  });

  return rereadRequest(request.id);
}

export async function listRequestsForCustomer(
  customerId: string
): Promise<Array<{ request: NamedRequest; nextVisit: Visit | null }>> {
  return attachNextVisits(await listRequestsForCustomerModel(customerId));
}

export async function listRequestsForProvider(
  providerId: string
): Promise<Array<{ request: NamedRequest; nextVisit: Visit | null }>> {
  return attachNextVisits(await listRequestsForProviderModel(providerId));
}
