import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { pool } from "./pool";
import { formatMysqlDateTime } from "./format-datetime";
import { JOB_EVENT_TYPE, type JobEventType } from "../constants/job-event-type";
import { AI_STATUS, type AiStatus } from "../constants/ai-status";

export interface InsertJobEventInput {
  id: string;
  requestId: string;
  actorUserId: string;
  eventType: JobEventType;
  // Counts are numbers. Prices stay DECIMAL strings in the audit record and
  // are never serialised as JSON numbers (which would make them floats).
  payload: Readonly<Record<string, string | number | boolean>> | null;
}

// Append-only: job_events rows are never updated or deleted.
export async function insertJobEvent(
  conn: PoolConnection,
  input: InsertJobEventInput
): Promise<void> {
  await conn.query(
    `INSERT INTO job_events (id, request_id, actor_user_id, event_type, payload)
     VALUES (?, ?, ?, ?, ?)`,
    [
      input.id,
      input.requestId,
      input.actorUserId,
      input.eventType,
      input.payload === null ? null : JSON.stringify(input.payload),
    ]
  );
}

interface PayloadRow extends RowDataPacket {
  payload: string | null;
}

const AI_STATUSES: readonly string[] = Object.values(AI_STATUS);

// The session's ai_status when the request was booked from it, from the
// REQUEST_CREATED payload; null for a search booking (no payload). Served by
// idx_events_request_time (request_id prefix).
export async function findAiStatusAtBooking(
  requestId: string
): Promise<AiStatus | null> {
  const [rows] = await pool.query<PayloadRow[]>(
    `SELECT payload FROM job_events WHERE request_id = ? AND event_type = ?`,
    [requestId, JOB_EVENT_TYPE.REQUEST_CREATED]
  );
  const raw = rows[0]?.payload;
  if (raw === undefined || raw === null) return null;
  const payload: unknown = JSON.parse(raw);
  const status =
    typeof payload === "object" &&
    payload !== null &&
    "aiStatusAtBooking" in payload
      ? payload.aiStatusAtBooking
      : null;
  return typeof status === "string" && AI_STATUSES.includes(status)
    ? (status as AiStatus)
    : null;
}

// A stored event as the services read it; the payload is parsed but not
// filtered (the public view is libraries/event-entries.ts).
export interface JobEvent {
  id: string;
  actorUserId: string | null;
  type: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

interface JobEventRow extends RowDataPacket {
  id: string;
  actor_user_id: string | null;
  event_type: string;
  payload: string | null;
  created_at: string;
}

function parsePayload(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

// One request's events, oldest first; ties broken by id so the order is
// stable. Served by idx_events_request_time (request_id, created_at).
export async function listEventsForRequest(
  requestId: string
): Promise<JobEvent[]> {
  const [rows] = await pool.query<JobEventRow[]>(
    `SELECT id, actor_user_id, event_type, payload, created_at
     FROM job_events WHERE request_id = ? ORDER BY created_at, id`,
    [requestId]
  );
  return rows.map((row) => ({
    id: row.id,
    actorUserId: row.actor_user_id,
    type: row.event_type,
    payload: parsePayload(row.payload),
    createdAt: formatMysqlDateTime(row.created_at),
  }));
}
