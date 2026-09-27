import type {
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import { pool, isDbError } from "./pool";
import { formatMysqlDateTime } from "./format-datetime";
import { ConflictError } from "../constants/errors";
import {
  VISIT_STATUS,
  OPEN_VISIT_STATUSES,
  type VisitStatus,
} from "../constants/visit-status";

// Beirut wall-clock, no offset. See pool.ts for the schema-wide convention.
export interface Visit {
  id: string;
  requestId: string;
  providerId: string;
  status: VisitStatus;
  scheduledStart: string;
  scheduledEnd: string;
  actualStart: string | null;
}

interface VisitRow extends RowDataPacket {
  id: string;
  request_id: string;
  provider_id: string;
  status: string;
  scheduled_start: string;
  scheduled_end: string;
  actual_start: string | null;
}

function mapRow(row: VisitRow): Visit {
  return {
    id: row.id,
    requestId: row.request_id,
    providerId: row.provider_id,
    status: row.status as VisitStatus,
    scheduledStart: formatMysqlDateTime(row.scheduled_start),
    scheduledEnd: formatMysqlDateTime(row.scheduled_end),
    actualStart: formatMysqlDateTime(row.actual_start),
  };
}

// Served by the index backing fk_visits_request (request_id, provider_id).
export async function findVisitsForRequest(
  requestId: string
): Promise<Visit[]> {
  const [rows] = await pool.query<VisitRow[]>(
    `SELECT id, request_id, provider_id, status, scheduled_start,
            scheduled_end, actual_start
     FROM visits WHERE request_id = ? ORDER BY scheduled_start ASC`,
    [requestId]
  );
  return rows.map(mapRow);
}

// One query for a whole request list rather than one per request. Ordered so
// the first row per request_id is that request's earliest open visit. Served
// by the same fk_visits_request (request_id, provider_id) index.
export async function findOpenVisitsForRequests(
  requestIds: readonly string[],
  openStatuses: readonly VisitStatus[]
): Promise<Visit[]> {
  if (requestIds.length === 0) return [];
  const [rows] = await pool.query<VisitRow[]>(
    `SELECT id, request_id, provider_id, status, scheduled_start,
            scheduled_end, actual_start
     FROM visits
     WHERE request_id IN (?) AND status IN (?)
     ORDER BY request_id, scheduled_start, id`,
    [requestIds, openStatuses]
  );
  return rows.map(mapRow);
}

// Open visits of these providers that overlap [from, to). Served by
// idx_visits_provider_time (provider_id, scheduled_start, status).
export async function listOpenVisitsForProviders(
  providerIds: readonly string[],
  from: Date,
  to: Date
): Promise<Visit[]> {
  if (providerIds.length === 0) return [];
  const [rows] = await pool.query<VisitRow[]>(
    `SELECT id, request_id, provider_id, status, scheduled_start,
            scheduled_end, actual_start
     FROM visits
     WHERE provider_id IN (?) AND status IN (?)
       AND scheduled_start < ? AND scheduled_end > ?
     ORDER BY scheduled_start`,
    [providerIds, OPEN_VISIT_STATUSES, to, from]
  );
  return rows.map(mapRow);
}

export interface UpdateVisitStatusInput {
  id: string;
  fromStatus: VisitStatus;
  toStatus: VisitStatus;
  markActualStart: boolean;
}

// Optimistic concurrency, same contract as updateRequestStatus: returns false
// when the visit is no longer in the status the caller validated against.
export async function updateVisitStatus(
  conn: PoolConnection,
  input: UpdateVisitStatusInput
): Promise<boolean> {
  const [result] = await conn.query<ResultSetHeader>(
    `UPDATE visits
     SET status = ?, actual_start = IF(?, CURRENT_TIMESTAMP(3), actual_start)
     WHERE id = ? AND status = ?`,
    [input.toStatus, input.markActualStart, input.id, input.fromStatus]
  );
  return result.affectedRows === 1;
}

// Cancelling releases each visit's slot: active_slot is generated as NULL for
// cancelled visits, and NULLs never collide in uq_visits_provider_active_slot.
export async function cancelOpenVisitsForRequest(
  conn: PoolConnection,
  requestId: string,
  openStatuses: readonly VisitStatus[]
): Promise<void> {
  await conn.query(
    `UPDATE visits SET status = ? WHERE request_id = ? AND status IN (?)`,
    [VISIT_STATUS.CANCELLED, requestId, openStatuses]
  );
}

// Whether an open visit of this provider overlaps [start, end). Run it inside
// the booking transaction after lockProviderForUpdate, so no competing booking
// can commit in between. Served by idx_visits_provider_time.
export async function hasOverlappingVisit(
  conn: PoolConnection,
  providerId: string,
  start: Date,
  end: Date,
  openStatuses: readonly VisitStatus[]
): Promise<boolean> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT 1 FROM visits
     WHERE provider_id = ? AND status IN (?)
       AND scheduled_start < ? AND scheduled_end > ?
     LIMIT 1`,
    [providerId, openStatuses, end, start]
  );
  return rows.length > 0;
}

export interface InsertVisitInput {
  id: string;
  requestId: string;
  providerId: string;
  // Beirut wall-clock digits encoded through the Date's UTC getters, the same
  // convention as requests.requested_start (see insertRequest).
  scheduledStart: Date;
  scheduledEnd: Date;
}

const ACTIVE_SLOT_KEY = "uq_visits_provider_active_slot";

// The unique key on (provider_id, active_slot) is the double-booking
// guarantee. There is deliberately no check-then-insert: it would race.
export async function insertVisit(
  conn: PoolConnection,
  input: InsertVisitInput
): Promise<void> {
  try {
    await conn.query(
      `INSERT INTO visits (id, request_id, provider_id, scheduled_start, scheduled_end)
       VALUES (?, ?, ?, ?, ?)`,
      [
        input.id,
        input.requestId,
        input.providerId,
        input.scheduledStart,
        input.scheduledEnd,
      ]
    );
  } catch (err) {
    if (isDbError(err, "ER_DUP_ENTRY", ACTIVE_SLOT_KEY)) {
      throw new ConflictError(
        "That time slot has already been booked with this provider. Please choose another time."
      );
    }
    throw err;
  }
}
