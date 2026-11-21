import {
  findRequestNames,
  listRequestsForCustomer as listRequestsForCustomerModel,
  listRequestsForProvider as listRequestsForProviderModel,
  type Request,
  type NamedRequest,
} from "../models-db/requests";
import {
  findVisitsForRequest,
  findOpenVisitsForRequests,
  type Visit,
} from "../models-db/visits";
import {
  findAiStatusAtBooking,
  findLatestQuoteReason,
  listEventsForRequest,
} from "../models-db/job-events";
import { findReviewForRequest } from "../models-db/reviews";
import {
  findIntakeSession,
  listIntakeMessages,
  type IntakeMessage,
} from "../models-db/intake";
import { listRequestItems, type RequestItem } from "../models-db/request-items";
import { AI_STATUS, type AiStatus } from "../constants/ai-status";
import { OPEN_VISIT_STATUSES } from "../constants/visit-status";
import { PRICE_STATUS } from "../constants/price-status";
import { REQUEST_STATUS } from "../constants/request-status";
import { NotFoundError } from "../constants/errors";
import {
  currentStoredDiagnosis,
  toDiagnosisView,
  type DiagnosisView,
} from "./intake";
import { toEventEntry, type EventEntry } from "./event-entries";
import { loadRequestForActor } from "./request-access";

// What either party reads about their requests: one request with its visits,
// the full details (parts list, an open revision's reason), the timeline, the
// issue card, and the two lists. Nothing here writes.

export interface RequestDetails {
  request: NamedRequest;
  visits: Visit[];
  hasReview: boolean;
}

export interface RequestFullDetails extends RequestDetails {
  revisionReason: string | null;
  items: RequestItem[];
}

export interface RequestListEntry {
  request: NamedRequest;
  nextVisit: Visit | null;
}

export async function getRequestForActor(
  requestId: string,
  actorUserId: string
): Promise<RequestDetails> {
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
): Promise<RequestFullDetails> {
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

// What either party reads for a job: the request, the customer's intake
// conversation and its diagnosis, and the parts list. The provider reaches the
// intake only through this request. Late = the analysis was still pending at
// booking and is done now; sessions are frozen after booking, so nothing else
// can make it done later.
export async function getIssueCard(
  requestId: string,
  actorUserId: string
): Promise<IssueCard> {
  const { request } = await loadRequestForActor(requestId, actorUserId);
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
  const stored = currentStoredDiagnosis(session);
  return {
    request,
    aiStatus: session.aiStatus,
    diagnosis: stored === null ? null : await toDiagnosisView(stored),
    isLate:
      stored !== null &&
      (await findAiStatusAtBooking(request.id)) === AI_STATUS.PENDING,
    messages: await listIntakeMessages(session.id),
    items,
  };
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

export async function listRequestsForCustomer(
  customerId: string
): Promise<RequestListEntry[]> {
  return attachNextVisits(await listRequestsForCustomerModel(customerId));
}

export async function listRequestsForProvider(
  providerId: string
): Promise<RequestListEntry[]> {
  return attachNextVisits(await listRequestsForProviderModel(providerId));
}
