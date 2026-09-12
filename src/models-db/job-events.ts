import type { PoolConnection } from "mysql2/promise";
import type { JobEventType } from "../constants/job-event-type";

export interface InsertJobEventInput {
  id: string;
  requestId: string;
  actorUserId: string;
  eventType: JobEventType;
}

// Append-only: job_events rows are never updated or deleted. payload is left
// to its column default (NULL) until an event type needs one.
export async function insertJobEvent(
  conn: PoolConnection,
  input: InsertJobEventInput
): Promise<void> {
  await conn.query(
    `INSERT INTO job_events (id, request_id, actor_user_id, event_type)
     VALUES (?, ?, ?, ?)`,
    [input.id, input.requestId, input.actorUserId, input.eventType]
  );
}
