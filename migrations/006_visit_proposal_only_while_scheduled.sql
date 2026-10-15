-- 006: a reschedule proposal (proposed_start + proposed_by) is set as a pair,
-- and only on a scheduled visit. Starting, completing or cancelling a visit
-- clears it in the same UPDATE (updateVisitStatus, cancelOpenVisitsForRequest).
-- To undo: ALTER TABLE visits DROP CONSTRAINT chk_visits_proposal;

ALTER TABLE visits
  ADD CONSTRAINT chk_visits_proposal CHECK (
    (proposed_start IS NULL) = (proposed_by IS NULL) AND
    (proposed_start IS NULL OR status = 'scheduled'));
