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
  tags           TEXT    DEFAULT '',
  category       TEXT    DEFAULT '',
  media_group_id TEXT    DEFAULT ''
);

-- One row per Telegram album, used to send a single summary message
CREATE TABLE IF NOT EXISTS media_groups (
  group_id       TEXT    PRIMARY KEY,
  caption        TEXT    DEFAULT '',
  seq            INTEGER DEFAULT 0,     -- bumped by every processed item
  dup_count      INTEGER DEFAULT 0,     -- items skipped as duplicates
  summary_msg_id INTEGER,               -- NULL: none yet, -1: being sent
  created_at     TEXT    DEFAULT (datetime('now'))
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_file_name      ON files(file_name);
CREATE INDEX IF NOT EXISTS idx_file_unique_id ON files(file_unique_id);
CREATE INDEX IF NOT EXISTS idx_tags           ON files(tags);
CREATE INDEX IF NOT EXISTS idx_uploaded_at    ON files(uploaded_at);
CREATE INDEX IF NOT EXISTS idx_mime_type      ON files(mime_type);
CREATE INDEX IF NOT EXISTS idx_category       ON files(category);
CREATE INDEX IF NOT EXISTS idx_media_group_id ON files(media_group_id);

-- Bot settings, e.g. key 'lang' = 'en' | 'zh' (set with /lang)
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
