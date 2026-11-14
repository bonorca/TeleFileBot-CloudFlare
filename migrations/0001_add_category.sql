-- Adds auto-classification support to an existing TeleFileBot database.
-- Run once on databases created before the category column existed:
--   npm run db:migrate
-- New installs get the column from schema.sql and must NOT run this.

ALTER TABLE files ADD COLUMN category TEXT DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_category ON files(category);
