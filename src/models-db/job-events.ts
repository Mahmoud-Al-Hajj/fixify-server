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

// An event in a user's notification feed, with what the feed shows about its
// request and whether it is unread for that user.
export interface FeedEvent extends JobEvent {
  requestId: string;
  customerId: string;
  providerId: string;
  categoryName: string;
  otherPartyName: string;
  unread: boolean;
}

interface FeedEventRow extends JobEventRow {
  request_id: string;
  customer_id: string;
  provider_id: string;
  category_name: string;
  other_name: string;
  unread: number;
}

// Unread for the user `me`: after notifications_read_at, strictly; everything
// when it is NULL. The feed's flag and the count use this same expression.
const UNREAD = `(me.notifications_read_at IS NULL
  OR e.created_at > me.notifications_read_at)`;

// Events on the user's requests made by someone else (own actions are not
// notifications): one branch for requests they booked, one for requests they
// serve, joined to the other party and the category. A user is never both
// parties of one request (booking refuses self), so the branches never
// overlap. Served by the users and categories primary keys,
// idx_req_customer_status / idx_req_provider_status and
// idx_events_request_time.
const feedBranch = (mine: string, other: string) => `
  SELECT e.id, e.actor_user_id, e.event_type, e.payload, e.created_at,
         e.request_id, r.customer_id, r.provider_id,
         c.name AS category_name, other.full_name AS other_name,
         ${UNREAD} AS unread
  FROM users me
  JOIN requests r ON r.${mine} = me.id
  JOIN job_events e ON e.request_id = r.id
  JOIN categories c ON c.id = r.category_id
  JOIN users other ON other.id = r.${other}
  WHERE me.id = ? AND NOT (e.actor_user_id <=> me.id)`;

// The two branches are fixed strings; only the user id and the limit are
// parameters.
const FEED_SQL = `(${feedBranch("customer_id", "provider_id")})
  UNION ALL
  (${feedBranch("provider_id", "customer_id")})
  ORDER BY created_at DESC, id DESC
  LIMIT ?`;

export async function listFeedForUser(
  userId: string,
  limit: number
): Promise<FeedEvent[]> {
  const [rows] = await pool.query<FeedEventRow[]>(FEED_SQL, [
    userId,
    userId,
    limit,
  ]);
  return rows.map((row) => ({
    id: row.id,
    actorUserId: row.actor_user_id,
    type: row.event_type,
    payload: parsePayload(row.payload),
    createdAt: formatMysqlDateTime(row.created_at),
    requestId: row.request_id,
    customerId: row.customer_id,
    providerId: row.provider_id,
    categoryName: row.category_name,
    otherPartyName: row.other_name,
    unread: Boolean(row.unread),
  }));
}

const unreadBranch = (mine: string) => `
  SELECT e.id
  FROM users me
  JOIN requests r ON r.${mine} = me.id
  JOIN job_events e ON e.request_id = r.id
  WHERE me.id = ? AND NOT (e.actor_user_id <=> me.id) AND ${UNREAD}`;

const UNREAD_COUNT_SQL = `SELECT COUNT(*) AS unread FROM (
  ${unreadBranch("customer_id")}
  UNION ALL
  ${unreadBranch("provider_id")}
) t`;

// Every unread event, not only the newest page; same filters as the feed.
export async function countUnreadForUser(userId: string): Promise<number> {
  const [rows] = await pool.query<Array<RowDataPacket & { unread: number }>>(
    UNREAD_COUNT_SQL,
    [userId, userId]
  );
  return Number(rows[0]?.unread ?? 0);
}
