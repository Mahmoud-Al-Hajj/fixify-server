import type { PoolConnection } from "mysql2/promise";
import { ConflictError } from "../constants/errors";

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

function isActiveSlotConflict(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    err.code === "ER_DUP_ENTRY" &&
    err.message.includes(ACTIVE_SLOT_KEY)
  );
}

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
    if (isActiveSlotConflict(err)) {
      throw new ConflictError(
        "That time slot has already been booked with this provider. Please choose another time."
      );
    }
    throw err;
  }
}
