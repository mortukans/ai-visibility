// One source of truth for the database schema, shared by the SQLite store and the
// D1 store. The same statements also live in migrations/0001_init.sql for Cloudflare
// (`wrangler d1 migrations apply`). All are idempotent (IF NOT EXISTS).

export const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
     id             INTEGER PRIMARY KEY,
     email          TEXT NOT NULL UNIQUE,
     openrouter_key TEXT,
     alert_webhook  TEXT,
     created_at     TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS api_keys (
     id         INTEGER PRIMARY KEY,
     user_id    INTEGER NOT NULL REFERENCES users(id),
     key_hash   TEXT NOT NULL UNIQUE,
     label      TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sites (
     id          INTEGER PRIMARY KEY,
     user_id     INTEGER NOT NULL REFERENCES users(id),
     brand       TEXT NOT NULL,
     domain      TEXT NOT NULL,
     aliases     TEXT NOT NULL,
     competitors TEXT NOT NULL,
     models      TEXT NOT NULL,
     created_at  TEXT NOT NULL,
     UNIQUE (user_id, brand, domain)
   )`,
  `CREATE TABLE IF NOT EXISTS questions (
     id         INTEGER PRIMARY KEY,
     site_id    INTEGER NOT NULL REFERENCES sites(id),
     text       TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS runs (
     id                 INTEGER PRIMARY KEY,
     site_id            INTEGER NOT NULL REFERENCES sites(id),
     created_at         TEXT NOT NULL,
     total_answers      INTEGER NOT NULL,
     brand_mention_rate REAL NOT NULL,
     domain_cite_rate   REAL NOT NULL,
     share_of_voice     REAL NOT NULL,
     avg_rank           REAL
   )`,
  `CREATE TABLE IF NOT EXISTS mentions (
     id                INTEGER PRIMARY KEY,
     run_id            INTEGER NOT NULL REFERENCES runs(id),
     question          TEXT NOT NULL,
     model             TEXT NOT NULL,
     brand_mentioned   INTEGER NOT NULL,
     domain_cited      INTEGER NOT NULL,
     rank              INTEGER,
     competitors_found TEXT NOT NULL,
     cited_urls        TEXT NOT NULL,
     error             TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_sites_user ON sites(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_questions_site ON questions(site_id)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_site ON runs(site_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_mentions_run ON mentions(run_id)`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
     bucket   TEXT PRIMARY KEY,
     count    INTEGER NOT NULL,
     reset_at INTEGER NOT NULL
   )`,
];
