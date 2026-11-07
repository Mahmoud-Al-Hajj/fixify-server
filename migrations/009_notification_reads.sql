-- 009: per-notification read marks, alongside users.notifications_read_at (the
-- "mark all" watermark). An event is unread for a user when it is after the
-- watermark AND has no row here. New table only, so it cannot fail on existing rows.
-- To undo: DROP TABLE notification_reads;

CREATE TABLE notification_reads (
  user_id  CHAR(36) CHARACTER SET ascii NOT NULL,
  event_id CHAR(36) CHARACTER SET ascii NOT NULL,
  read_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, event_id),
  CONSTRAINT fk_reads_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_reads_event FOREIGN KEY (event_id)
    REFERENCES job_events(id) ON DELETE CASCADE,
  KEY idx_reads_event (event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
