// Folio — Pages Function: publish to the public catalog.
//
// Metadata always lands in D1. The PDF itself prefers the R2 bucket when
// one is bound (`?step=up` / `?step=upfin`, raw binary parts at
// book/{id}/{idx}); without R2 it falls back to base64 rows in
// catalog_chunk. Either way the reader talks to /api/pdf unchanged.
//
//   POST ?step=create   { title, author?, isbn?, platform?, cover?, filename?, pages? }
//                       -> { ok, id, deleteKey, storage: "r2" | "d1" }
//   POST ?step=up       binary part, ?id=&idx=, header x-folio-key  (R2 only)
//   POST ?step=upfin    { id, deleteKey, size, chunks, pages, filename } -> seals an R2 book
//   POST ?step=chunk    { id, deleteKey, idx, data }   data = base64 PDF bytes (D1 fallback)
//   POST ?step=final    { id, deleteKey, size, chunks } marks a D1 book readable
//   POST ?step=delete   { id, deleteKey } removes it and its parts/chunks
//
// Metadata-only publishes are legal too: books appear in the list as soon as
// create runs, and gain "view in browser" once upfin/final runs.

const MAX_TITLE = 300;
const MAX_TEXT = 400;
const MAX_COVER = 220_000;        // bytes of the data URI / URL string / JSON list
const MAX_CHUNK = 400_000;        // base64 chars per D1 upload
const MAX_CHUNKS = 1500;          // D1 ceiling per book
const CHUNK_LIMIT = 400_000;      // raw bytes guard when decoding
const MAX_PART = 32 * 1024 * 1024;   // one R2 part
const MAX_PARTS = 64;                // 64 x 16 MB = 1 GB ceiling

export async function onRequestPost(context) {
  const db = context.env.DB;
  if (!db) return json({ ok: false, error: "D1 not bound — catalog unavailable" }, 500);

  const url = new URL(context.request.url);
  const step = url.searchParams.get("step") || "create";

  if (step === "up") return upPart(context, url);

  let body;
  try { body = await context.request.json(); } catch (_) { return json({ ok: false, error: "invalid JSON" }, 400); }

  if (step === "create") return create(context, body);
  if (step === "chunk") return chunk(db, body);
  if (step === "final") return final(db, body);
  if (step === "upfin") return upFin(context, body);
  if (step === "delete") return remove(context, body);
  return json({ ok: false, error: "unknown step" }, 400);
}

// cheap client probe: which storage will new PDFs use?
export async function onRequestGet(context) {
  return json({ ok: true, storage: context.env.BOOKS ? "r2" : "d1" });
}

// --- metadata ------------------------------------------------------------
async function create(context, b) {
  const db = context.env.DB;
  const title = clean(b.title, MAX_TITLE);
  if (!title) return json({ ok: false, error: "title required" }, 400);
  const isbn = String(b.isbn == null ? "" : b.isbn).replace(/[^0-9Xx]/gi, "").slice(0, 32);

  // One catalog row per book. If the same ISBN (or the same normalized
  // title) is already listed — by another account, device or platform —
  // report the existing row instead of inserting a duplicate. The original
  // deleteKey is never handed out, so foreign rows stay read-only.
  const hit = await findExisting(db, isbn, title);
  if (hit) return json({ ok: true, id: hit.id, storage: hit.storage, hasPdf: !!hit.has_pdf, existing: true });

  const now = Date.now();
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const deleteKey = crypto.randomUUID().replace(/-/g, "");

  await db.prepare(
    `INSERT INTO catalog (id, title, author, isbn, platform, cover, filename, pages, size,
                          chunks, has_pdf, storage, delete_key, published_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,0,0,0,?9,?10,?11,?11)`
  ).bind(
    id,
    title,
    clean(b.author, MAX_TEXT),
    clean(b.isbn, 32),
    clean(b.platform, 40),
    cover(b.cover),
    clean(b.filename, 180),
    int(b.pages),
    context.env.BOOKS ? "r2" : "d1",
    deleteKey,
    now
  ).run();

  return json({ ok: true, id, deleteKey, storage: context.env.BOOKS ? "r2" : "d1" });
}

// Existing row with the same ISBN, else the same title (normalized exactly
// like the client: whitespace collapsed, lowercased).
async function findExisting(db, isbn, title) {
  if (isbn) {
    const row = await db.prepare(
      "SELECT id, has_pdf, storage FROM catalog WHERE replace(replace(lower(isbn),'-',''),' ','') = ?1 LIMIT 1"
    ).bind(isbn.toLowerCase()).first();
    if (row) return row;
  }
  const nt = normTitle(title);
  if (!nt) return null;
  const rows = await db.prepare(
    "SELECT id, has_pdf, storage, title FROM catalog WHERE title <> '' LIMIT 5000"
  ).all();
  for (const r of rows.results || []) {
    if (normTitle(r.title) === nt) return r;
  }
  return null;
}
function normTitle(s) {
  return String(s || "").replace(/[\t\n\r\f\v]+/g, " ").replace(/ {2,}/g, " ").trim().toLowerCase();
}

// --- R2 parts ------------------------------------------------------------
async function upPart(context, url) {
  const books = context.env.BOOKS;
  if (!books) return json({ ok: false, error: "R2 not bound" }, 500);

  const db = context.env.DB;
  const id = (url.searchParams.get("id") || "").slice(0, 40);
  const idx = Number(url.searchParams.get("idx"));
  const key = clean(context.request.headers.get("x-folio-key"), 64);
  const len = Number(context.request.headers.get("content-length") || 0);

  if (!id || !key) return json({ ok: false, error: "id + key required" }, 400);
  if (!Number.isInteger(idx) || idx < 0 || idx >= MAX_PARTS) return json({ ok: false, error: "bad index" }, 400);
  if (len && len > MAX_PART) return json({ ok: false, error: "part too large" }, 413);

  const row = await db.prepare("SELECT delete_key FROM catalog WHERE id = ?").bind(id).first();
  if (!row) return json({ ok: false, error: "not found" }, 404);
  if (row.delete_key !== key) return json({ ok: false, error: "bad deleteKey" }, 403);
  if (!context.request.body) return json({ ok: false, error: "empty body" }, 400);

  await books.put("book/" + id + "/" + idx, context.request.body, {
    httpMetadata: { contentType: "application/octet-stream" }
  });
  return json({ ok: true, id, idx });
}

async function upFin(context, b) {
  const books = context.env.BOOKS;
  if (!books) return json({ ok: false, error: "R2 not bound" }, 500);

  const db = context.env.DB;
  const id = clean(b.id, 40);
  const key = clean(b.deleteKey, 64);
  if (!id || !key) return json({ ok: false, error: "id + deleteKey required" }, 400);

  const row = await db.prepare("SELECT delete_key FROM catalog WHERE id = ?").bind(id).first();
  if (!row) return json({ ok: false, error: "not found" }, 404);
  if (row.delete_key !== key) return json({ ok: false, error: "bad deleteKey" }, 403);

  const listed = await books.list({ prefix: "book/" + id + "/" });
  const parts = (listed.objects || []).filter((o) => !o.key.endsWith("/"));
  if (!parts.length) return json({ ok: false, error: "no uploaded parts" }, 400);

  const chunks = parts.length;
  const size = parts.reduce((n, o) => n + (o.size || 0), 0);
  const pages = clampInt(b.pages, 0, 20000);
  const filename = clean(b.filename, 180);

  await db.prepare(
    `UPDATE catalog SET chunks = ?2, size = ?3, pages = ?4, filename = ?5,
                        has_pdf = 1, storage = 'r2', updated_at = ?6 WHERE id = ?1`
  ).bind(id, chunks, size, pages, filename, Date.now()).run();

  return json({ ok: true, id, chunks, size, pages, storage: "r2" });
}

// --- D1 fallback ---------------------------------------------------------
async function chunk(db, b) {
  const id = clean(b.id, 40);
  const key = clean(b.deleteKey, 64);
  const idx = Number(b.idx);
  const data = typeof b.data === "string" ? b.data : "";
  if (!id || !key) return json({ ok: false, error: "id + deleteKey required" }, 400);
  if (!Number.isInteger(idx) || idx < 0 || idx >= MAX_CHUNKS) return json({ ok: false, error: "bad index" }, 400);
  if (!data || data.length > MAX_CHUNK) return json({ ok: false, error: "bad chunk size" }, 400);

  const row = await db.prepare("SELECT delete_key FROM catalog WHERE id = ?").bind(id).first();
  if (!row) return json({ ok: false, error: "not found" }, 404);
  if (row.delete_key !== key) return json({ ok: false, error: "bad deleteKey" }, 403);

  // guard decoded size without allocating the whole book
  const approx = Math.floor(data.length * 0.75);
  if (approx > CHUNK_LIMIT) return json({ ok: false, error: "chunk too large" }, 413);

  await db.prepare(
    `INSERT INTO catalog_chunk (book_id, idx, data) VALUES (?1, ?2, ?3)
     ON CONFLICT(book_id, idx) DO UPDATE SET data = excluded.data`
  ).bind(id, idx, data).run();

  return json({ ok: true, id, idx });
}

async function final(db, b) {
  const id = clean(b.id, 40);
  const key = clean(b.deleteKey, 64);
  if (!id || !key) return json({ ok: false, error: "id + deleteKey required" }, 400);

  const row = await db.prepare("SELECT delete_key FROM catalog WHERE id = ?").bind(id).first();
  if (!row) return json({ ok: false, error: "not found" }, 404);
  if (row.delete_key !== key) return json({ ok: false, error: "bad deleteKey" }, 403);

  const counted = await db.prepare("SELECT COUNT(*) AS n FROM catalog_chunk WHERE book_id = ?").bind(id).first();
  const chunks = Math.min(Number(counted?.n) || 0, MAX_CHUNKS);
  if (!chunks) return json({ ok: false, error: "no uploaded chunks" }, 400);
  const size = clampInt(b.size, 0, 400 * 1024 * 1024);
  const pages = clampInt(b.pages, 0, 20000);
  const filename = clean(b.filename, 180);

  await db.prepare(
    `UPDATE catalog SET chunks = ?2, size = ?3, pages = ?4, filename = ?5,
                        has_pdf = 1, storage = 'd1', updated_at = ?6 WHERE id = ?1`
  ).bind(id, chunks, size, pages, filename, Date.now()).run();

  return json({ ok: true, id, chunks, size, pages, storage: "d1" });
}

// --- delete --------------------------------------------------------------
async function remove(context, b) {
  const db = context.env.DB;
  const id = clean(b.id, 40);
  const key = clean(b.deleteKey, 64);
  if (!id || !key) return json({ ok: false, error: "id + deleteKey required" }, 400);

  const row = await db.prepare("SELECT delete_key FROM catalog WHERE id = ?").bind(id).first();
  if (!row) return json({ ok: false, error: "not found" }, 404);
  if (row.delete_key !== key) return json({ ok: false, error: "bad deleteKey" }, 403);

  if (context.env.BOOKS) {
    try {
      const listed = await context.env.BOOKS.list({ prefix: "book/" + id + "/" });
      const keys = (listed.objects || []).map((o) => o.key);
      if (keys.length) await context.env.BOOKS.delete(keys);
    } catch (_) { /* best effort */ }
  }
  await db.prepare("DELETE FROM catalog_chunk WHERE book_id = ?").bind(id).run();
  await db.prepare("DELETE FROM catalog WHERE id = ?").bind(id).run();
  return json({ ok: true, id });
}

// --- guards -------------------------------------------------------------
function clean(v, max) {
  const s = String(v == null ? "" : v).trim().slice(0, max);
  return s;
}
function cover(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return "";
  if (s.length > MAX_COVER) return "";
  if (/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s)) return s;
  if (/^https:\/\//.test(s)) return s;
  // JSON array of candidate cover URLs (the client tries them in order)
  if (s.startsWith("[")) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) {
        const urls = arr.filter((u) => typeof u === "string" && /^https:\/\//.test(u) && u.length <= 2000).slice(0, 6);
        if (urls.length) return JSON.stringify(urls);
      }
    } catch (_) {}
    return "";
  }
  return "";
}
function int(v) { return clampInt(v, 0, 20000); }
function clampInt(v, lo, hi) { const n = Math.floor(Number(v) || 0); return Math.max(lo, Math.min(hi, n)); }

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
