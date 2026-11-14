-- TeleFileBot — D1 Database Schema

CREATE TABLE IF NOT EXISTS files (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name      TEXT    NOT NULL,
  file_id        TEXT    NOT NULL,
  file_unique_id TEXT    NOT NULL UNIQUE,
  file_size      INTEGER DEFAULT 0,
  mime_type      TEXT    DEFAULT '',
  message_id     INTEGER NOT NULL,
  uploaded_at    TEXT    DEFAULT (datetime('now')),
  tags           TEXT    DEFAULT ''
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_file_name      ON files(file_name);
CREATE INDEX IF NOT EXISTS idx_file_unique_id ON files(file_unique_id);
CREATE INDEX IF NOT EXISTS idx_tags           ON files(tags);
CREATE INDEX IF NOT EXISTS idx_uploaded_at    ON files(uploaded_at);
CREATE INDEX IF NOT EXISTS idx_mime_type      ON files(mime_type);