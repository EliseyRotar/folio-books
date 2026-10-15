CREATE TABLE IF NOT EXISTS harvest_jobs (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  book_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  key TEXT NOT NULL DEFAULT '',
  catalog_id TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL DEFAULT '',
  secrets TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS harvest_state ON harvest_jobs(state);
