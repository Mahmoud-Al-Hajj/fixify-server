-- 002: a revised quote proposed while the job is in_progress. It is held in
-- revised_price until the customer answers, so the agreed price in price
-- stays intact: accepting copies it into price, declining just clears it.

ALTER TABLE requests
  ADD COLUMN revised_price DECIMAL(10,2) NULL AFTER price,
  ADD CONSTRAINT chk_req_revised_price CHECK (
    revised_price IS NULL OR revised_price >= 0);
