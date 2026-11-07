import { JOB_EVENT_TYPE, type JobEventType } from "../constants/job-event-type";
import {
  REQUEST_ACTOR_ROLE,
  type RequestActorRole,
} from "../constants/request-status";

// The public view of a job event, shared by the timeline and the notification
// feed. Payloads are an audit record; only the fields listed here ever leave
// the server. Exhaustive over JobEventType, so a new event type does not
// compile until it is listed. request_created lists nothing: its intake
// fields (intakeSessionId, aiStatusAtBooking, usedDiagnosis, partsSeeded) are
// internal.
export const PUBLIC_DETAILS: Record<JobEventType, readonly string[]> = {
  [JOB_EVENT_TYPE.REQUEST_CREATED]: [],
  [JOB_EVENT_TYPE.REQUEST_REJECTED]: [],
  [JOB_EVENT_TYPE.REQUEST_CANCELLED]: ["from"],
  [JOB_EVENT_TYPE.REQUEST_STARTED]: ["visitId"],
  [JOB_EVENT_TYPE.REQUEST_COMPLETED]: ["visitId"],
  [JOB_EVENT_TYPE.REQUEST_PAID]: ["price"],
  [JOB_EVENT_TYPE.REQUESTED_START_CHANGED]: ["from", "to"],
  [JOB_EVENT_TYPE.QUOTE_PROPOSED]: ["price", "revisedPrice", "reason"],
  [JOB_EVENT_TYPE.QUOTE_ACCEPTED]: ["price"],
  [JOB_EVENT_TYPE.QUOTE_DECLINED]: ["declinedPrice"],
  [JOB_EVENT_TYPE.REVIEW_CREATED]: ["reviewId"],
  [JOB_EVENT_TYPE.REQUEST_ITEMS_UPDATED]: ["added", "updated", "removed"],
  [JOB_EVENT_TYPE.VISIT_RESCHEDULE_PROPOSED]: ["visitId", "proposedStart"],
  [JOB_EVENT_TYPE.VISIT_RESCHEDULED]: ["visitId", "from", "to"],
  [JOB_EVENT_TYPE.VISIT_RESCHEDULE_DECLINED]: ["visitId", "proposedStart"],
  [JOB_EVENT_TYPE.VISIT_RESCHEDULE_WITHDRAWN]: ["visitId", "proposedStart"],
  [JOB_EVENT_TYPE.VISIT_ADDED]: [
    "visitId",
    "scheduledStart",
    "finishedVisitId",
  ],
  [JOB_EVENT_TYPE.PHOTOS_ADDED]: ["kind", "count"],
};

export type EventDetails = Record<string, string | number | boolean>;

// The listed fields that are present and plain values; null when there are
// none (or the type is unknown, which no writer produces).
export function publicDetails(
  type: string,
  payload: Readonly<Record<string, unknown>> | null
): EventDetails | null {
  if (payload === null || !Object.hasOwn(PUBLIC_DETAILS, type)) return null;
  const details: EventDetails = {};
  for (const key of PUBLIC_DETAILS[type as JobEventType]) {
    const value = payload[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      details[key] = value;
    }
  }
  return Object.keys(details).length > 0 ? details : null;
}

// Who acted, as a role on the request; never a user id. null when the account
// is gone (job_events.actor_user_id is SET NULL on delete).
export function actorRole(
  actorUserId: string | null,
  request: { customerId: string; providerId: string }
): RequestActorRole | null {
  if (actorUserId === request.customerId) return REQUEST_ACTOR_ROLE.CUSTOMER;
  if (actorUserId === request.providerId) return REQUEST_ACTOR_ROLE.PROVIDER;
  return null;
}

export interface EventEntry {
  id: string;
  type: string;
  at: string;
  actor: RequestActorRole | null;
  details: EventDetails | null;
}

// A stored event in its public shape, for a request's two parties.
export function toEventEntry(
  event: {
    id: string;
    actorUserId: string | null;
    type: string;
    payload: Readonly<Record<string, unknown>> | null;
    createdAt: string;
  },
  request: { customerId: string; providerId: string }
): EventEntry {
  return {
    id: event.id,
    type: event.type,
    at: event.createdAt,
    actor: actorRole(event.actorUserId, request),
    details: publicDetails(event.type, event.payload),
  };
}
