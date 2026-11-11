-- Hardening: per-user alert webhook + a rate-limit table.
-- Apply with: wrangler d1 migrations apply ai-visibility --remote
-- Kept in sync with src/store/schema.ts.

ALTER TABLE users ADD COLUMN alert_webhook TEXT;

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket   TEXT PRIMARY KEY,
  count    INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
