-- 011: put DEFAULT 0 back on request_items.sort_order (010 dropped it). The code
-- deployed before 010 inserts without the column and fails in strict mode without
-- a default; the new code always supplies a position. Safe to run twice.
-- To undo: ALTER TABLE request_items ALTER COLUMN sort_order DROP DEFAULT;

ALTER TABLE request_items ALTER COLUMN sort_order SET DEFAULT 0;
