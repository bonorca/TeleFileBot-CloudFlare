-- Album support: one summary message per Telegram album (media group).
-- Run once on databases created before this migration:
--   npm run db:migrate:2
-- New installs get these from schema.sql and must NOT run this.

ALTER TABLE files ADD COLUMN media_group_id TEXT DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_media_group_id ON files(media_group_id);

CREATE TABLE IF NOT EXISTS media_groups (
  group_id       TEXT    PRIMARY KEY,
  caption        TEXT    DEFAULT '',
  seq            INTEGER DEFAULT 0,     -- bumped by every processed item
  dup_count      INTEGER DEFAULT 0,     -- items skipped as duplicates
  summary_msg_id INTEGER,               -- NULL: none yet, -1: being sent
  created_at     TEXT    DEFAULT (datetime('now'))
);
