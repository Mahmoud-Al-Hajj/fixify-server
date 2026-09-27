import type {
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import { pool } from "./pool";
import { formatMysqlDateTime } from "./format-datetime";
import type { AiStatus } from "../constants/ai-status";
import type { MessageSender } from "../constants/message-sender";

// intake_sessions, intake_messages and intake_photos: one aggregate, always
// written and read together.

// requestId/providerId: the request booked from this session, if any.
export interface IntakeSession {
  id: string;
  customerId: string;
  aiStatus: AiStatus;
  requestId: string | null;
  providerId: string | null;
  createdAt: string;
}

interface IntakeSessionRow extends RowDataPacket {
  id: string;
  customer_id: string;
  ai_status: string;
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
    `SELECT s.id, s.customer_id, s.ai_status, s.created_at,
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
        requestId: row.request_id,
        providerId: row.provider_id,
        createdAt: formatMysqlDateTime(row.created_at),
      }
    : null;
}

// The conversation in order (by id, not created_at). Served by fk_im_session
// and fk_ip_message.
export async function listIntakeMessages(
  sessionId: string
): Promise<IntakeMessage[]> {
  const [messages] = await pool.query<IntakeMessageRow[]>(
    `SELECT id, sender, body, created_at FROM intake_messages
     WHERE session_id = ? ORDER BY id`,
    [sessionId]
  );
  if (messages.length === 0) return [];
  const [photos] = await pool.query<IntakePhotoRow[]>(
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
