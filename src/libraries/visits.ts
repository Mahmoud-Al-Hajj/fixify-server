import { randomUUID } from "node:crypto";
import type { PoolConnection } from "mysql2/promise";
import { withTransaction } from "../models-db/pool";
import {
  findVisitsForRequest,
  hasOverlappingVisit,
  proposeVisitStart,
  moveVisitToProposedStart,
  clearVisitProposal,
  type Visit,
} from "../models-db/visits";
import {
  lockProviderForUpdate,
  listAvailability,
} from "../models-db/providers";
import { insertJobEvent } from "../models-db/job-events";
import { wallClockToDate, beirutNow } from "../models-db/format-datetime";
import type { Request } from "../models-db/requests";
import { JOB_EVENT_TYPE } from "../constants/job-event-type";
import { REQUEST_ACTOR_ROLE } from "../constants/request-status";
import { OPEN_VISIT_STATUSES } from "../constants/visit-status";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../constants/errors";
import {
  loadRequestForActor,
  getRequestForActor,
  CHANGED_CONCURRENTLY_MESSAGE,
} from "./requests";
import { fitsWorkingHours } from "./slot-rules";
import {
  assertRescheduleAction,
  RESCHEDULE_ACTION,
  type RescheduleAction,
} from "./visit-rules";

const OVERLAP_MESSAGE =
  "That time overlaps another booking with this provider. Please choose another time.";

// The double-booking check (CLAUDE.md "Double-booking"). The provider lock is
// the transaction's first statement, so the overlap read sees every visit a
// competing booking committed before we got the lock. excludeVisitId: a visit
// being moved, which must not count as overlapping itself.
export async function reserveSlot(
  conn: PoolConnection,
  input: {
    providerId: string;
    start: Date;
    end: Date;
    excludeVisitId: string | null;
  }
): Promise<void> {
  await lockProviderForUpdate(conn, input.providerId);
  if (
    await hasOverlappingVisit(
      conn,
      input.providerId,
      input.start,
      input.end,
      OPEN_VISIT_STATUSES,
      input.excludeVisitId
    )
  ) {
    throw new ConflictError(OVERLAP_MESSAGE);
  }
}

type RequestDetails = Awaited<ReturnType<typeof getRequestForActor>>;

// The visit, reached only through a request the caller is a party to.
async function loadVisitForActor(
  requestId: string,
  visitId: string,
  actorUserId: string
) {
  const { request, actorRole } = await loadRequestForActor(
    requestId,
    actorUserId
  );
  const visit = (await findVisitsForRequest(request.id)).find(
    (candidate) => candidate.id === visitId
  );
  if (!visit) {
    throw new NotFoundError("Visit not found");
  }
  return { request, actorRole, visit };
}

function openProposal(visit: Visit): { start: Date; by: string } | null {
  return visit.proposedStart === null || visit.proposedBy === null
    ? null
    : { start: wallClockToDate(visit.proposedStart), by: visit.proposedBy };
}

// A rescheduled visit keeps its length.
function endAfterMove(visit: Visit, start: Date): Date {
  const length =
    wallClockToDate(visit.scheduledEnd).getTime() -
    wallClockToDate(visit.scheduledStart).getTime();
  return new Date(start.getTime() + length);
}

function checkAction(
  action: RescheduleAction,
  request: Request,
  visit: Visit,
  actorUserId: string,
  newStart: Date | null
): { start: Date; by: string } | null {
  const proposal = openProposal(visit);
  assertRescheduleAction({
    action,
    requestStatus: request.status,
    visitStatus: visit.status,
    proposal,
    actorUserId,
    now: beirutNow(),
    newStart,
  });
  return proposal;
}

// Either party proposes a new start; the visit keeps its length. A customer's
// time must fit the provider's working hours; the provider may choose any.
// Overlaps are checked only at accept, under the provider lock.
export async function proposeReschedule(
  requestId: string,
  visitId: string,
  actorUserId: string,
  start: Date
): Promise<RequestDetails> {
  const { request, actorRole, visit } = await loadVisitForActor(
    requestId,
    visitId,
    actorUserId
  );
  checkAction(RESCHEDULE_ACTION.PROPOSE, request, visit, actorUserId, start);
  const end = endAfterMove(visit, start);
  if (
    actorRole === REQUEST_ACTOR_ROLE.CUSTOMER &&
    !fitsWorkingHours(await listAvailability([request.providerId]), start, end)
  ) {
    throw new ValidationError(
      "That time is outside the provider's working hours"
    );
  }

  await withTransaction(async (conn) => {
    const proposed = await proposeVisitStart(conn, {
      id: visit.id,
      requestId: request.id,
      proposedStart: start,
      proposedBy: actorUserId,
    });
    if (!proposed) {
      throw new ConflictError(CHANGED_CONCURRENTLY_MESSAGE);
    }
    await insertJobEvent(conn, {
      id: randomUUID(),
      requestId: request.id,
      actorUserId,
      eventType: JOB_EVENT_TYPE.VISIT_RESCHEDULE_PROPOSED,
      payload: {
        visitId: visit.id,
        proposedStart: start.toISOString().slice(0, 23),
      },
    });
  });

  return getRequestForActor(request.id, actorUserId);
}

// The other party accepts: the visit moves under the same provider lock and
// overlap check as quote acceptance, keeping its length.
export async function acceptReschedule(
  requestId: string,
  visitId: string,
  actorUserId: string
): Promise<RequestDetails> {
  const { request, visit } = await loadVisitForActor(
    requestId,
    visitId,
    actorUserId
  );
  const proposal = checkAction(
    RESCHEDULE_ACTION.ACCEPT,
    request,
    visit,
    actorUserId,
    null
  );
  if (proposal === null || visit.proposedStart === null) {
    throw new Error("A reschedule was accepted with no open proposal");
  }
  const to = visit.proposedStart;
  const end = endAfterMove(visit, proposal.start);

  await withTransaction(async (conn) => {
    await reserveSlot(conn, {
      providerId: request.providerId,
      start: proposal.start,
      end,
      excludeVisitId: visit.id,
    });
    const moved = await moveVisitToProposedStart(conn, {
      id: visit.id,
      scheduledEnd: end,
      proposedStart: proposal.start,
      proposedBy: proposal.by,
    });
    if (!moved) {
      throw new ConflictError(CHANGED_CONCURRENTLY_MESSAGE);
    }
    await insertJobEvent(conn, {
      id: randomUUID(),
      requestId: request.id,
      actorUserId,
      eventType: JOB_EVENT_TYPE.VISIT_RESCHEDULED,
      payload: { visitId: visit.id, from: visit.scheduledStart, to },
    });
  });

  return getRequestForActor(request.id, actorUserId);
}

// Declined by the other party or withdrawn by the proposer: one guarded
// UPDATE closes the proposal and the visit stays where it was. The action
// (from the endpoint) is checked against the actor; the event records which
// one it was.
export async function closeReschedule(
  action: typeof RESCHEDULE_ACTION.DECLINE | typeof RESCHEDULE_ACTION.WITHDRAW,
  requestId: string,
  visitId: string,
  actorUserId: string
): Promise<RequestDetails> {
  const { request, visit } = await loadVisitForActor(
    requestId,
    visitId,
    actorUserId
  );
  const proposal = checkAction(action, request, visit, actorUserId, null);
  if (proposal === null || visit.proposedStart === null) {
    throw new Error("A reschedule was answered with no open proposal");
  }
  const proposedStart = visit.proposedStart;

  await withTransaction(async (conn) => {
    const cleared = await clearVisitProposal(conn, {
      id: visit.id,
      proposedStart: proposal.start,
      proposedBy: proposal.by,
    });
    if (!cleared) {
      throw new ConflictError(CHANGED_CONCURRENTLY_MESSAGE);
    }
    await insertJobEvent(conn, {
      id: randomUUID(),
      requestId: request.id,
      actorUserId,
      eventType:
        proposal.by === actorUserId
          ? JOB_EVENT_TYPE.VISIT_RESCHEDULE_WITHDRAWN
          : JOB_EVENT_TYPE.VISIT_RESCHEDULE_DECLINED,
      payload: { visitId: visit.id, proposedStart },
    });
  });

  return getRequestForActor(request.id, actorUserId);
}
