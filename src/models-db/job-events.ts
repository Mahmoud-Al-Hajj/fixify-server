import type { PoolConnection } from "mysql2/promise";
import type { JobEventType } from "../constants/job-event-type";

export interface InsertJobEventInput {
  id: string;
  requestId: string;
  actorUserId: string;
  eventType: JobEventType;
  // String values only: prices stay DECIMAL strings in the audit record and
  // are never serialised as JSON numbers.
  payload: Readonly<Record<string, string>> | null;
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
