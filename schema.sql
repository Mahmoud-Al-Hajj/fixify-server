

CREATE DATABASE IF NOT EXISTS fixify
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE fixify;


CREATE TABLE users (
  id                   CHAR(36) CHARACTER SET ascii NOT NULL,
  full_name            VARCHAR(120) NOT NULL,
  email                VARCHAR(255) NOT NULL,
  phone                VARCHAR(30)  NOT NULL,
  password_hash        CHAR(60) CHARACTER SET ascii NOT NULL,
  avatar_url           VARCHAR(500),
  push_token           VARCHAR(255),
  reset_token_hash     CHAR(64) CHARACTER SET ascii,
  reset_expires_at     DATETIME(3),

  notifications_read_at DATETIME(3),

  created_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                   ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


CREATE TABLE providers (
  id               CHAR(36) CHARACTER SET ascii NOT NULL,
  bio              VARCHAR(1000),
  years_experience TINYINT UNSIGNED,
  area             VARCHAR(80),
  is_accepting     TINYINT(1)  NOT NULL DEFAULT 1,
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                               ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT fk_providers_user FOREIGN KEY (id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chk_providers_years CHECK (years_experience BETWEEN 0 AND 70),
  KEY idx_providers_area (area)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


CREATE TABLE categories (
  id   SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(60) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_categories_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


CREATE TABLE provider_categories (
  provider_id CHAR(36) CHARACTER SET ascii NOT NULL,
  category_id SMALLINT UNSIGNED NOT NULL,
  base_rate   DECIMAL(10,2),
  PRIMARY KEY (provider_id, category_id),
  CONSTRAINT fk_pc_provider FOREIGN KEY (provider_id)
    REFERENCES providers(id) ON DELETE CASCADE,
  CONSTRAINT fk_pc_category FOREIGN KEY (category_id)
    REFERENCES categories(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


CREATE TABLE provider_availability (
  provider_id CHAR(36) CHARACTER SET ascii NOT NULL,
  weekday     TINYINT UNSIGNED NOT NULL,
  start_time  TIME NOT NULL,
  end_time    TIME NOT NULL,
  PRIMARY KEY (provider_id, weekday, start_time),
  CONSTRAINT fk_avail_provider FOREIGN KEY (provider_id)
    REFERENCES providers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- NEW: one row per issue the customer describes in the chat-style intake.
-- Holds the AI status and the raw structured diagnosis (audit record).
CREATE TABLE intake_sessions (
  id            CHAR(36) CHARACTER SET ascii NOT NULL,
  customer_id   CHAR(36) CHARACTER SET ascii NOT NULL,
  ai_status     VARCHAR(10) NOT NULL DEFAULT 'pending',
  ai_diagnosis  JSON,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                            ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT fk_is_customer FOREIGN KEY (customer_id)
    REFERENCES users(id) ON DELETE CASCADE,
  KEY idx_is_customer_time (customer_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- NEW: the turns of the intake conversation (customer text and AI replies).
CREATE TABLE intake_messages (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id  CHAR(36) CHARACTER SET ascii NOT NULL,
  sender      VARCHAR(10) NOT NULL,
  body        VARCHAR(2000),
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT fk_im_session FOREIGN KEY (session_id)
    REFERENCES intake_sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- NEW: images attached to a customer message (files live in object storage).
CREATE TABLE intake_photos (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  message_id  BIGINT UNSIGNED NOT NULL,
  url         VARCHAR(500) NOT NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT fk_ip_message FOREIGN KEY (message_id)
    REFERENCES intake_messages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


CREATE TABLE requests (
  id             CHAR(36) CHARACTER SET ascii NOT NULL,
  customer_id    CHAR(36) CHARACTER SET ascii NOT NULL,
  provider_id    CHAR(36) CHARACTER SET ascii NOT NULL,
  category_id    SMALLINT UNSIGNED NOT NULL,
  intake_session_id CHAR(36) CHARACTER SET ascii,          -- NEW: NULL when booked via plain search
  service_type   VARCHAR(12),
  description    VARCHAR(2000) NOT NULL,
  address_text   VARCHAR(300)  NOT NULL,

  requested_start            DATETIME(3),

  estimated_duration_minutes SMALLINT UNSIGNED,

  is_urgent      TINYINT(1)  NOT NULL DEFAULT 0,

  status         VARCHAR(12) NOT NULL DEFAULT 'pending',

  price          DECIMAL(10,2),
  price_status   VARCHAR(10) NOT NULL DEFAULT 'none',
  paid_at        DATETIME(3),

  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  responded_at   DATETIME(3),
  completed_at   DATETIME(3),

  PRIMARY KEY (id),

  UNIQUE KEY uq_req_id_provider (id, provider_id),
  UNIQUE KEY uq_req_intake_session (intake_session_id),   -- NEW: one diagnosis -> at most one job

  CONSTRAINT fk_req_customer FOREIGN KEY (customer_id) REFERENCES users(id),
  CONSTRAINT fk_req_provider FOREIGN KEY (provider_id) REFERENCES providers(id),
  CONSTRAINT fk_req_category FOREIGN KEY (category_id) REFERENCES categories(id),
  CONSTRAINT fk_req_intake_session FOREIGN KEY (intake_session_id)
    REFERENCES intake_sessions(id),                        -- NEW

  KEY idx_req_provider_status (provider_id, status, created_at),
  KEY idx_req_customer_status (customer_id, status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- NEW: parts / materials the provider needs for a job.
-- AI suggestions are inserted with source = 'ai'; provider edits set source = 'provider'.
CREATE TABLE request_items (
  id                    CHAR(36) CHARACTER SET ascii NOT NULL,
  request_id            CHAR(36) CHARACTER SET ascii NOT NULL,
  name                  VARCHAR(120) NOT NULL,
  quantity              SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  unit                  VARCHAR(20),
  estimated_unit_price  DECIMAL(10,2),
  source                VARCHAR(10) NOT NULL DEFAULT 'ai',
  created_at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT fk_ri_request FOREIGN KEY (request_id)
    REFERENCES requests(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


CREATE TABLE visits (
  id              CHAR(36) CHARACTER SET ascii NOT NULL,
  request_id      CHAR(36) CHARACTER SET ascii NOT NULL,

  provider_id     CHAR(36) CHARACTER SET ascii NOT NULL,

  status          VARCHAR(12) NOT NULL DEFAULT 'scheduled',

  scheduled_start DATETIME(3) NOT NULL,
  scheduled_end   DATETIME(3) NOT NULL,

  proposed_start  DATETIME(3),
  proposed_by     CHAR(36) CHARACTER SET ascii,

  actual_start    DATETIME(3),

  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                              ON UPDATE CURRENT_TIMESTAMP(3),

  active_slot     DATETIME(3) GENERATED ALWAYS AS (
                    CASE WHEN status = 'cancelled'
                         THEN NULL ELSE scheduled_start END) STORED,

  PRIMARY KEY (id),
  UNIQUE KEY uq_visits_provider_active_slot (provider_id, active_slot),

  CONSTRAINT fk_visits_request FOREIGN KEY (request_id, provider_id)
    REFERENCES requests(id, provider_id) ON DELETE CASCADE,
  CONSTRAINT fk_visits_proposed_by FOREIGN KEY (proposed_by)
    REFERENCES users(id),

  KEY idx_visits_provider_time (provider_id, scheduled_start, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


CREATE TABLE job_events (
  id            CHAR(36) CHARACTER SET ascii NOT NULL,
  request_id    CHAR(36) CHARACTER SET ascii NOT NULL,
  actor_user_id CHAR(36) CHARACTER SET ascii,
  event_type    VARCHAR(40) NOT NULL,
  payload       JSON,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT fk_events_request FOREIGN KEY (request_id)
    REFERENCES requests(id) ON DELETE CASCADE,
  CONSTRAINT fk_events_actor FOREIGN KEY (actor_user_id)
    REFERENCES users(id) ON DELETE SET NULL,
  KEY idx_events_request_time (request_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


CREATE TABLE request_photos (
  id         CHAR(36) CHARACTER SET ascii NOT NULL,
  request_id CHAR(36) CHARACTER SET ascii NOT NULL,
  url        VARCHAR(500) NOT NULL,
  kind       VARCHAR(10)  NOT NULL,
  created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT fk_photos_request FOREIGN KEY (request_id)
    REFERENCES requests(id) ON DELETE CASCADE,
  KEY idx_photos_request_kind (request_id, kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


CREATE TABLE reviews (
  id         CHAR(36) CHARACTER SET ascii NOT NULL,
  request_id CHAR(36) CHARACTER SET ascii NOT NULL,
  rating     TINYINT UNSIGNED NOT NULL,
  comment    VARCHAR(1000),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_reviews_request (request_id),
  CONSTRAINT fk_reviews_request FOREIGN KEY (request_id)
    REFERENCES requests(id),
  CONSTRAINT chk_reviews_rating CHECK (rating BETWEEN 1 AND 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DELIMITER $$
CREATE TRIGGER trg_reviews_completed BEFORE INSERT ON reviews
FOR EACH ROW
BEGIN
  IF (SELECT status FROM requests WHERE id = NEW.request_id) <> 'completed' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Review allowed only on completed requests';
  END IF;
END$$
DELIMITER ;


INSERT INTO categories (name) VALUES
  ('Electrician'), ('Plumber'), ('AC & Refrigeration'), ('Carpenter'),
  ('Painter'), ('Appliance Repair'), ('Generator & Solar'), ('Aluminium & Glass'),
  ('Tiling & Masonry'), ('Locksmith'), ('Satellite & Internet'), ('Cleaning'),
  ('Moving & Delivery'), ('Pest Control'), ('Welding & Metalwork');


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

-- NEW
ALTER TABLE intake_sessions
  ADD CONSTRAINT chk_is_ai_status CHECK (ai_status IN ('pending','done','failed'));

-- NEW
ALTER TABLE intake_messages
  ADD CONSTRAINT chk_im_sender CHECK (sender IN ('customer','ai'));

-- NEW
ALTER TABLE request_items
  ADD CONSTRAINT chk_ri_quantity CHECK (quantity > 0),
  ADD CONSTRAINT chk_ri_price CHECK (
    estimated_unit_price IS NULL OR estimated_unit_price >= 0),
  ADD CONSTRAINT chk_ri_source CHECK (source IN ('ai','provider'));