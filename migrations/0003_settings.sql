-- Bot settings (currently just the language chosen with /lang).
-- Run once on databases created before this migration:
--   npm run db:migrate:3
-- New installs get this table from schema.sql and must NOT run this.

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
