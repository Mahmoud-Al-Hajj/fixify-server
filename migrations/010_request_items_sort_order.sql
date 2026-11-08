-- 010: request_items.sort_order, the position of a part in the provider's list.
-- Items saved together share one created_at, so the list order used to fall to
-- the random UUID. Existing rows are numbered per request in their old order
-- (created_at, id); updated_at is kept as it was.
-- The DEFAULT 0 stays on purpose: the code deployed before this change inserts
-- without sort_order, and must keep working between this migration and the
-- deploy. The new code always supplies a position.
-- To undo: ALTER TABLE request_items DROP COLUMN sort_order;

ALTER TABLE request_items
  ADD COLUMN sort_order SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER source;

UPDATE request_items ri
JOIN (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY request_id ORDER BY created_at, id) - 1 AS n
  FROM request_items
) numbered ON numbered.id = ri.id
SET ri.sort_order = numbered.n, ri.updated_at = ri.updated_at;

