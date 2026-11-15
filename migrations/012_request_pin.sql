-- 012: the customer's map pin and address details on a request. Old rows stay
-- NULL. A pin is both coordinates or neither; the Lebanon box is checked at the
-- edge only (routes/requests.schema.ts), not here. Not re-runnable (ADD COLUMN).
-- Apply before deploying the code that reads it, or every request read fails.
-- To undo: ALTER TABLE requests DROP CONSTRAINT chk_req_pin,
--   DROP COLUMN address_details, DROP COLUMN longitude, DROP COLUMN latitude;

ALTER TABLE requests
  ADD COLUMN latitude        DECIMAL(9,6) NULL AFTER address_text,
  ADD COLUMN longitude       DECIMAL(9,6) NULL AFTER latitude,
  ADD COLUMN address_details VARCHAR(300) NULL AFTER longitude,
  ADD CONSTRAINT chk_req_pin CHECK (
    (latitude IS NULL) = (longitude IS NULL) AND
    (latitude IS NULL OR latitude BETWEEN -90 AND 90) AND
    (longitude IS NULL OR longitude BETWEEN -180 AND 180));
