// Folio — Pages Function: publish to the public catalog.
//
// Three writes, all credential-free by construction: this Function never
// reads the cabinet table and only accepts the whitelisted metadata fields
// below. Anything else in the body is dropped before it touches D1.
//
//   POST ?step=create   { title, author?, isbn?, platform?, cover?, filename?, pages? }
//                       -> { ok, id, deleteKey }
//   POST ?step=chunk    { id, deleteKey, idx, data }   data = base64 PDF bytes
//   POST ?step=final    { id, deleteKey, size, chunks } marks the book readable
//   POST ?step=delete   { id, deleteKey } removes it and its chunks
//
// Metadata-only publishes are legal too: books appear in the list as soon as
// create runs, and gain "view in browser" once final runs.

const MAX_TITLE = 300;
const MAX_TEXT = 400;
const MAX_COVER = 220_000;        // bytes of the data URI / URL string
const MAX_CHUNK = 400_000;        // base64 chars per upload
const MAX_CHUNKS = 1500;          // ~360 MB ceiling per book
const CHUNK_LIMIT = 400_000;      // raw bytes guard when decoding

export async function onRequestPost(context) {
  const db = context.env.DB;
  if (!db) return json({ ok: false, error: "D1 not bound — catalog unavailable" }, 500);

  const step = new URL(context.request.url).searchParams.get("step") || "create";

  let body;
  try { body = await context.request.json(); } catch (_) { return json({ ok: false, error: "invalid JSON" }, 400); }

  if (step === "create") return create(db, body);
  if (step === "chunk") return chunk(db, body);
  if (step === "final") return final(db, body);
  if (step === "delete") return remove(db, body);
  return json({ ok: false, error: "unknown step" }, 400);
}

async function create(db, b) {
  const title = clean(b.title, MAX_TITLE);
  if (!title) return json({ ok: false, error: "title required" }, 400);

  const now = Date.now();
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const deleteKey = crypto.randomUUID().replace(/-/g, "");

  await db.prepare(
    `INSERT INTO catalog (id, title, author, isbn, platform, cover, filename, pages, size,
                          chunks, has_pdf, delete_key, published_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,0,0,0,?9,?10,?10)`
  ).bind(
    id,
    title,
    clean(b.author, MAX_TEXT),
    clean(b.isbn, 32),
    clean(b.platform, 40),
    cover(b.cover),
    clean(b.filename, 180),
    int(b.pages),
    deleteKey,
    now
  ).run();

  return json({ ok: true, id, deleteKey });
}

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
  const size = clampInt(b.size, 0, 400 * 1024 * 1024);
  const pages = clampInt(b.pages, 0, 20000);

  await db.prepare(
    `UPDATE catalog SET chunks = ?2, size = ?3, pages = ?4, has_pdf = 1, updated_at = ?5 WHERE id = ?1`
  ).bind(id, chunks, size, pages, Date.now()).run();

  return json({ ok: true, id, chunks, size, pages });
}

async function remove(db, b) {
  const id = clean(b.id, 40);
  const key = clean(b.deleteKey, 64);
  if (!id || !key) return json({ ok: false, error: "id + deleteKey required" }, 400);

  const row = await db.prepare("SELECT delete_key FROM catalog WHERE id = ?").bind(id).first();
  if (!row) return json({ ok: false, error: "not found" }, 404);
  if (row.delete_key !== key) return json({ ok: false, error: "bad deleteKey" }, 403);

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
  const ok = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s) || /^https:\/\//.test(s);
  return ok && s.length <= MAX_COVER ? s : "";
}
function int(v) { return clampInt(v, 0, 20000); }
function clampInt(v, lo, hi) { const n = Math.floor(Number(v) || 0); return Math.max(lo, Math.min(hi, n)); }

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
