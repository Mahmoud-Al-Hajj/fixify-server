-- 001: add the CHECK constraints defined in schema.sql that are missing from
-- databases created before schema.sql was made to load on MariaDB 10.4.
-- MariaDB syntax; to remove one: ALTER TABLE t DROP CONSTRAINT name.

ALTER TABLE provider_categories
  ADD CONSTRAINT chk_pc_base_rate
    CHECK (base_rate IS NULL OR base_rate >= 0);

ALTER TABLE requests
  ADD CONSTRAINT chk_req_status CHECK (status IN (
    'pending','scheduled','in_progress','completed',
    'rejected','cancelled')),
  ADD CONSTRAINT chk_req_service_type CHECK (
    service_type IS NULL OR service_type IN
    ('repair','installation','maintenance','inspection','other')),
  ADD CONSTRAINT chk_req_price_status CHECK (
    price_status IN ('none','proposed','accepted','declined')),
  ADD CONSTRAINT chk_req_price CHECK (price IS NULL OR price >= 0),
  ADD CONSTRAINT chk_req_duration CHECK (
    estimated_duration_minutes IS NULL OR
    estimated_duration_minutes BETWEEN 15 AND 1440);

ALTER TABLE visits
  ADD CONSTRAINT chk_visits_status CHECK (status IN
    ('scheduled','en_route','in_progress','done','cancelled')),
  ADD CONSTRAINT chk_visits_window
    CHECK (scheduled_end > scheduled_start);

ALTER TABLE provider_availability
  ADD CONSTRAINT chk_avail_weekday CHECK (weekday BETWEEN 0 AND 6),
  ADD CONSTRAINT chk_avail_window  CHECK (end_time > start_time);

ALTER TABLE request_photos
  ADD CONSTRAINT chk_photos_kind
    CHECK (kind IN ('before','after','extra'));

ALTER TABLE intake_sessions
  ADD CONSTRAINT chk_is_ai_status CHECK (ai_status IN ('pending','done','failed'));

ALTER TABLE intake_messages
  ADD CONSTRAINT chk_im_sender CHECK (sender IN ('customer','ai'));

ALTER TABLE request_items
  ADD CONSTRAINT chk_ri_quantity CHECK (quantity > 0),
  ADD CONSTRAINT chk_ri_price CHECK (
    estimated_unit_price IS NULL OR estimated_unit_price >= 0),
  ADD CONSTRAINT chk_ri_source CHECK (source IN ('ai','provider'));
