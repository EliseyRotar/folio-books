-- Folio — Cloudflare D1 schema
--
-- Two tables, two audiences:
--
-- 1. cabinet: one plaintext JSON document per device. Everything you saved
--    (accounts, credentials, shelf) lives here, visible on the desk and
--    readable directly in D1. Only /api/cabinet touches it, and only with a
--    device id.
--
-- 2. catalog + catalog_chunk: the PUBLIC shelf. Metadata only in `catalog`
--    (title, author, isbn, platform, cover, page count) — never credentials,
--    never account rows, never device ids. The PDF itself is split into
--    base64 chunks so the Pages Function stays under the CPU limit and the
--    reader can pull it page-range by page-range.

CREATE TABLE IF NOT EXISTS cabinet (
  device     TEXT PRIMARY KEY NOT NULL,
  doc        TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cabinet_updated ON cabinet (updated_at);

CREATE TABLE IF NOT EXISTS catalog (
  id           TEXT PRIMARY KEY NOT NULL,   -- public slug, random
  title        TEXT NOT NULL DEFAULT '',
  author       TEXT NOT NULL DEFAULT '',
  isbn         TEXT NOT NULL DEFAULT '',
  platform     TEXT NOT NULL DEFAULT '',
  cover        TEXT NOT NULL DEFAULT '',    -- data URI or https URL
  filename     TEXT NOT NULL DEFAULT '',
  pages        INTEGER NOT NULL DEFAULT 0,
  size         INTEGER NOT NULL DEFAULT 0,  -- PDF bytes
  chunks       INTEGER NOT NULL DEFAULT 0,  -- rows in catalog_chunk
  has_pdf      INTEGER NOT NULL DEFAULT 0,  -- 0 = metadata only
  delete_key   TEXT NOT NULL DEFAULT '',    -- publisher's key, never listed
  published_at INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_catalog_pub ON catalog (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_catalog_isbn ON catalog (isbn);

CREATE TABLE IF NOT EXISTS catalog_chunk (
  book_id TEXT NOT NULL,
  idx     INTEGER NOT NULL,
  data    TEXT NOT NULL,   -- base64 of raw PDF bytes
  PRIMARY KEY (book_id, idx)
);
