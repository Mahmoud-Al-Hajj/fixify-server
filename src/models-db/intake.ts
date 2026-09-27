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

export interface IntakeSession {
  id: string;
  customerId: string;
  aiStatus: AiStatus;
  createdAt: string;
}

interface IntakeSessionRow extends RowDataPacket {
  id: string;
  customer_id: string;
  ai_status: string;
  created_at: string;
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

export async function findIntakeSession(
  id: string
): Promise<IntakeSession | null> {
  const [rows] = await pool.query<IntakeSessionRow[]>(
    `SELECT id, customer_id, ai_status, created_at
     FROM intake_sessions WHERE id = ?`,
    [id]
  );
  const row = rows[0];
  return row
    ? {
        id: row.id,
        customerId: row.customer_id,
        aiStatus: row.ai_status as AiStatus,
        createdAt: formatMysqlDateTime(row.created_at),
      }
    : null;
}
