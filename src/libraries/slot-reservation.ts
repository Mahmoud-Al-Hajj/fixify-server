import type { PoolConnection } from "mysql2/promise";
import { hasOverlappingVisit } from "../models-db/visits";
import { hasOverlappingPendingRequest } from "../models-db/requests";
import { lockProviderForUpdate } from "../models-db/providers";
import { OPEN_VISIT_STATUSES } from "../constants/visit-status";
import { DEFAULT_VISIT_MINUTES } from "../constants/booking";
import { ConflictError, ERROR_CODE } from "../constants/errors";

const OVERLAP_MESSAGE =
  "That time overlaps another booking with this provider. Please choose another time.";
const OWN_PENDING_OVERLAP_MESSAGE =
  "You already have a request with this provider at an overlapping time. Please choose another time.";

// The double-booking check (CLAUDE.md "Double-booking"). The provider lock is
// the transaction's first statement, so the overlap read sees every visit a
// competing booking committed before we got the lock. excludeVisitId: a visit
// being moved, which must not count as overlapping itself. overlapCode: left
// out (CONFLICT) by quote accept, reschedule accept and follow-up, where the
// client reads it as "this time was just taken"; only assertRequestTimeFree
// passes TIME_OVERLAP.
export async function reserveSlot(
  conn: PoolConnection,
  input: {
    providerId: string;
    start: Date;
    end: Date;
    excludeVisitId: string | null;
  },
  overlapCode?: string
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
    throw new ConflictError(OVERLAP_MESSAGE, overlapCode);
  }
}

// The guard for a time a customer proposes for a pending request (creation and
// change of requested start). A pending request holds no slot against other
// customers, so only an open visit or this customer's own pending request to
// this provider can clash. Same lock as reserveSlot, so two requests racing
// for one slot are serialized. Both refusals are TIME_OVERLAP, so the client
// can tell them from the other 409s. A request with no estimate counts as
// DEFAULT_VISIT_MINUTES; one booked before requestedStart was required has no
// time to check. excludeRequestId: the request being moved.
export async function assertRequestTimeFree(
  conn: PoolConnection,
  input: {
    customerId: string;
    providerId: string;
    requestedStart: Date | null;
    estimatedDurationMinutes: number | null;
    excludeRequestId: string | null;
  }
): Promise<void> {
  const start = input.requestedStart;
  if (start === null) return;
  const minutes = input.estimatedDurationMinutes ?? DEFAULT_VISIT_MINUTES;
  const end = new Date(start.getTime() + minutes * 60_000);
  await reserveSlot(
    conn,
    { providerId: input.providerId, start, end, excludeVisitId: null },
    ERROR_CODE.TIME_OVERLAP
  );
  if (
    await hasOverlappingPendingRequest(
      conn,
      input.customerId,
      input.providerId,
      start,
      end,
      input.excludeRequestId
    )
  ) {
    throw new ConflictError(
      OWN_PENDING_OVERLAP_MESSAGE,
      ERROR_CODE.TIME_OVERLAP
    );
  }
}
