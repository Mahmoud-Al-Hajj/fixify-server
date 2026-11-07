-- 003: 'none' = not analysed yet, and it becomes the default. A session is
-- created with the customer's first message, long before any analysis, so
-- 'pending' now means only "analysis running". One ALTER, so the CHECK is
-- never missing: MariaDB DDL does not roll back.

ALTER TABLE intake_sessions
  DROP CONSTRAINT chk_is_ai_status,
  ALTER COLUMN ai_status SET DEFAULT 'none',
  ADD CONSTRAINT chk_is_ai_status
    CHECK (ai_status IN ('none','pending','done','failed'));

UPDATE intake_sessions SET ai_status = 'none'
WHERE ai_status = 'pending' AND ai_diagnosis IS NULL;
