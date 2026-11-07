-- 005: a revised price exists only while it waits for the customer on an
-- in-progress job. Cancelling withdraws it first (withdrawPendingRevision),
-- so no closed job keeps an unanswered revision. CHECKs are evaluated per
-- statement, so the withdrawal runs before the status UPDATE.
-- To undo: ALTER TABLE requests DROP CONSTRAINT chk_req_revision;

ALTER TABLE requests
  ADD CONSTRAINT chk_req_revision CHECK (
    revised_price IS NULL OR
    (price_status = 'proposed' AND status = 'in_progress'));
