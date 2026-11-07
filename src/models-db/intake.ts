import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import { pool } from "./pool";
import { formatMysqlDateTime } from "./format-datetime";
import { AI_STATUS, type AiStatus } from "../constants/ai-status";
import {
  MESSAGE_SENDER,
  type MessageSender,
} from "../constants/message-sender";

// intake_sessions, intake_messages and intake_photos: one aggregate, always
// written and read together.

// requestId/providerId: the request booked from this session, if any.
// aiDiagnosis is the stored JSON, parsed but not validated.
export interface IntakeSession {
  id: string;
  customerId: string;
  aiStatus: AiStatus;
  aiDiagnosis: unknown;
  analysisAttempts: number;
  requestId: string | null;
  providerId: string | null;
  createdAt: string;
}

interface IntakeSessionRow extends RowDataPacket {
  id: string;
  customer_id: string;
  ai_status: string;
  ai_diagnosis: string | null;
  analysis_attempts: number;
  request_id: string | null;
  provider_id: string | null;
  created_at: string;
}

// photos[].url is the storage path relative to the uploads directory.
export interface IntakeMessage {
  id: number;
  sender: MessageSender;
  body: string | null;
  createdAt: string;
  photos: Array<{ id: number; url: string }>;
}

interface IntakeMessageRow extends RowDataPacket {
  id: number;
  sender: string;
  body: string | null;
  created_at: string;
}

interface IntakePhotoRow extends RowDataPacket {
  id: number;
  message_id: number;
  url: string;
}

export async function insertIntakeSession(
  conn: PoolConnection,
  input: { id: string; customerId: string }
): Promise<void> {
  await conn.query(
    `INSERT INTO intake_sessions (id, customer_id) VALUES (?, ?)`,
    [input.id, input.customerId]
  );
}

// Returns the new message id (BIGINT auto-increment, so turns keep order).
export async function insertIntakeMessage(
  conn: PoolConnection,
  input: { sessionId: string; sender: MessageSender; body: string | null }
): Promise<number> {
  const [result] = await conn.query<ResultSetHeader>(
    `INSERT INTO intake_messages (session_id, sender, body) VALUES (?, ?, ?)`,
    [input.sessionId, input.sender, input.body]
  );
  return result.insertId;
}

// urls are storage paths relative to the uploads directory.
export async function insertIntakePhotos(
  conn: PoolConnection,
  messageId: number,
  urls: readonly string[]
): Promise<void> {
  if (urls.length === 0) return;
  await conn.query(`INSERT INTO intake_photos (message_id, url) VALUES ?`, [
    urls.map((url) => [messageId, url]),
  ]);
}

// Served by the primary key and uq_req_intake_session.
export async function findIntakeSession(
  id: string
): Promise<IntakeSession | null> {
  const [rows] = await pool.query<IntakeSessionRow[]>(
    `SELECT s.id, s.customer_id, s.ai_status, s.ai_diagnosis,
            s.analysis_attempts, s.created_at,
            r.id AS request_id, r.provider_id
     FROM intake_sessions s
     LEFT JOIN requests r ON r.intake_session_id = s.id
     WHERE s.id = ?`,
    [id]
  );
  const row = rows[0];
  return row
    ? {
        id: row.id,
        customerId: row.customer_id,
        aiStatus: row.ai_status as AiStatus,
        aiDiagnosis:
          row.ai_diagnosis === null ? null : JSON.parse(row.ai_diagnosis),
        analysisAttempts: row.analysis_attempts,
        requestId: row.request_id,
        providerId: row.provider_id,
        createdAt: formatMysqlDateTime(row.created_at),
      }
    : null;
}

// Locks the session row for the rest of the transaction. Must be the
// transaction's first read: InnoDB fixes its snapshot at the first plain
// read, so a read before the lock could miss rows committed while waiting.
// aiDiagnosis is parsed but not validated, as in IntakeSession. Served by the
// primary key.
export async function lockIntakeSession(
  conn: PoolConnection,
  id: string
): Promise<Pick<
  IntakeSession,
  "customerId" | "aiStatus" | "aiDiagnosis"
> | null> {
  const [rows] = await conn.query<
    Array<
      RowDataPacket & {
        customer_id: string;
        ai_status: string;
        ai_diagnosis: string | null;
      }
    >
  >(
    `SELECT customer_id, ai_status, ai_diagnosis FROM intake_sessions
     WHERE id = ? FOR UPDATE`,
    [id]
  );
  const row = rows[0];
  return row
    ? {
        customerId: row.customer_id,
        aiStatus: row.ai_status as AiStatus,
        aiDiagnosis:
          row.ai_diagnosis === null ? null : JSON.parse(row.ai_diagnosis),
      }
    : null;
}

// Whether a request was booked from the session, and how many photos it
// holds. Read after lockIntakeSession, in the same transaction. Served by
// uq_req_intake_session, fk_im_session and fk_ip_message.
export async function readSessionFreeze(
  conn: PoolConnection,
  id: string
): Promise<{ booked: boolean; photoCount: number }> {
  const [rows] = await conn.query<
    Array<RowDataPacket & { booked: number; photo_count: number }>
  >(
    `SELECT EXISTS (SELECT 1 FROM requests WHERE intake_session_id = ?) AS booked,
            (SELECT COUNT(*) FROM intake_photos p
             JOIN intake_messages m ON m.id = p.message_id
             WHERE m.session_id = ?) AS photo_count`,
    [id, id]
  );
  const row = rows[0];
  return {
    booked: Number(row?.booked) === 1,
    photoCount: Number(row?.photo_count ?? 0),
  };
}

// The conversation in order (by id, not created_at). Served by fk_im_session
// and fk_ip_message. Pass the transaction's connection when reading inside
// one.
export async function listIntakeMessages(
  sessionId: string,
  db: Pool | PoolConnection = pool
): Promise<IntakeMessage[]> {
  const [messages] = await db.query<IntakeMessageRow[]>(
    `SELECT id, sender, body, created_at FROM intake_messages
     WHERE session_id = ? ORDER BY id`,
    [sessionId]
  );
  if (messages.length === 0) return [];
  const [photos] = await db.query<IntakePhotoRow[]>(
    `SELECT id, message_id, url FROM intake_photos
     WHERE message_id IN (?) ORDER BY id`,
    [messages.map((message) => message.id)]
  );
  return messages.map((message) => ({
    id: message.id,
    sender: message.sender as MessageSender,
    body: message.body,
    createdAt: formatMysqlDateTime(message.created_at),
    photos: photos
      .filter((photo) => photo.message_id === message.id)
      .map((photo) => ({ id: photo.id, url: photo.url })),
  }));
}

// A photo's storage path, only if it belongs to this session. Served by the
// primary keys.
export async function findIntakePhotoUrl(
  photoId: number,
  sessionId: string
): Promise<string | null> {
  const [rows] = await pool.query<IntakePhotoRow[]>(
    `SELECT p.id, p.message_id, p.url
     FROM intake_photos p
     JOIN intake_messages m ON m.id = p.message_id
     WHERE p.id = ? AND m.session_id = ?`,
    [photoId, sessionId]
  );
  return rows[0]?.url ?? null;
}

// Whether the customer has written at least one message with text (the edge
// trims bodies and rejects blank ones). Served by fk_im_session.
export async function sessionHasCustomerText(
  sessionId: string
): Promise<boolean> {
  const [rows] = await pool.query<Array<RowDataPacket & { has_text: number }>>(
    `SELECT EXISTS (SELECT 1 FROM intake_messages
                    WHERE session_id = ? AND sender = ? AND body IS NOT NULL)
            AS has_text`,
    [sessionId, MESSAGE_SENDER.CUSTOMER]
  );
  return Number(rows[0]?.has_text) === 1;
}

// Starts an analysis if the session is the customer's, not already pending,
// under the attempts cap and not booked; one statement, so the guard cannot
// race. false means refused: re-read the session to learn why. Served by the
// primary key and uq_req_intake_session.
export async function startAnalysisAttempt(
  sessionId: string,
  customerId: string,
  maxAttempts: number
): Promise<boolean> {
  const [result] = await pool.query<ResultSetHeader>(
    `UPDATE intake_sessions
        SET ai_status = ?, analysis_attempts = analysis_attempts + 1
      WHERE id = ? AND customer_id = ?
        AND ai_status <> ?
        AND analysis_attempts < ?
        AND NOT EXISTS (SELECT 1 FROM requests WHERE intake_session_id = ?)`,
    [
      AI_STATUS.PENDING,
      sessionId,
      customerId,
      AI_STATUS.PENDING,
      maxAttempts,
      sessionId,
    ]
  );
  return result.affectedRows === 1;
}

// Settles a pending analysis as done. false means it was already settled (by
// the timeout or the startup sweep) and the diagnosis must be discarded.
export async function markAnalysisDone(
  conn: PoolConnection,
  sessionId: string,
  aiDiagnosis: Record<string, unknown>
): Promise<boolean> {
  const [result] = await conn.query<ResultSetHeader>(
    `UPDATE intake_sessions SET ai_status = ?, ai_diagnosis = ?
      WHERE id = ? AND ai_status = ?`,
    [AI_STATUS.DONE, JSON.stringify(aiDiagnosis), sessionId, AI_STATUS.PENDING]
  );
  return result.affectedRows === 1;
}

// ai_diagnosis is left as it is: a failed re-run does not erase the earlier
// audit record.
export async function markAnalysisFailed(sessionId: string): Promise<void> {
  await pool.query(
    `UPDATE intake_sessions SET ai_status = ? WHERE id = ? AND ai_status = ?`,
    [AI_STATUS.FAILED, sessionId, AI_STATUS.PENDING]
  );
}

// Startup only: with one server process, nothing is running an analysis yet
// (docs/ai-plan.md §12.5). Returns how many sessions it settled. Scans the
// table; it runs once at boot, not on a hot path.
export async function failPendingAnalyses(): Promise<number> {
  const [result] = await pool.query<ResultSetHeader>(
    `UPDATE intake_sessions SET ai_status = ? WHERE ai_status = ?`,
    [AI_STATUS.FAILED, AI_STATUS.PENDING]
  );
  return result.affectedRows;
}
