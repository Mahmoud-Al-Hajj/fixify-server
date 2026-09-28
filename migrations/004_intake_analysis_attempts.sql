-- 004: how many analyses a session has started, failures included. The
-- analysis start's guarded UPDATE increments it and refuses at 3, so the cap
-- holds without a separate check-then-update (docs/ai-plan.md §2.1).
-- To undo: ALTER TABLE intake_sessions DROP COLUMN analysis_attempts;

ALTER TABLE intake_sessions
  ADD COLUMN analysis_attempts TINYINT UNSIGNED NOT NULL DEFAULT 0
    AFTER ai_diagnosis;
