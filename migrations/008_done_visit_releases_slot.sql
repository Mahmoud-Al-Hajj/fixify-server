-- 008: a done visit releases its slot, like a cancelled one. Only open visits
-- block a booking (the overlap check and the suggested slots both ignore done
-- visits); a job finished before its scheduled start no longer holds that
-- start in uq_visits_provider_active_slot. More NULLs cannot create a
-- duplicate, so this cannot fail on existing rows.
-- To undo: the same MODIFY with WHEN status = 'cancelled' (fails if a done
-- visit now shares a start with an open visit of the same provider).

ALTER TABLE visits
  MODIFY COLUMN active_slot DATETIME(3) GENERATED ALWAYS AS (
    CASE WHEN status IN ('cancelled', 'done')
         THEN NULL ELSE scheduled_start END) STORED;
