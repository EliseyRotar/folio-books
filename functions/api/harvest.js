// Folio — Pages Function: background-harvest job queue (GitHub Actions).
//
// The browser can't keep a tab open forever; long jobs get enqueued here
// and a free GitHub Actions runner (public repo = unlimited minutes)
// picks them up every ~15 minutes, downloads the book headlessly and
// stores the PDF in R2 (10 GB free tier — hard-capped below).
//
// Auth: header x-harvest-token must equal the HARVEST_TOKEN env secret.
//
//   POST ?action=enqueue   { platform, bookId, title?, secrets }
//   POST ?action=claim     { limit? }              -> queued jobs, flips to running
//   POST ?action=complete  { id, ok, size?, key?, error?, catalogId? }
//   GET  ?action=list                            -> all jobs (token via header)
//   GET  ?action=quota                           -> { used, cap }
//
// secrets = the platform credentials needed to download that one book;
// purged from the row once the job reaches a terminal state.

const CAP_BYTES = 9 * 1024 * 1024 * 1024; // 9 GiB — headroom under R2's 10 GB free tier
const MAX_TITLE = 300;
const MAX_SECRETS = 8000;
const MAX_ATTEMPTS = 3;

export async function onRequestPost(context) {
  const auth = await checkAuth(context);
  if (auth) return auth;

  const url = new URL(context.request.url);
  const action = url.searchParams.get("action") || "";
  const db = context.env.DB;
  if (!db) return json({ ok: false, error: "D1 not bound" }, 500);

  let body = {};
  try { body = await context.request.json(); } catch (_) {}

  if (action === "enqueue") return enqueue(db, body);
  if (action === "claim") return claim(db, body);
  if (action === "complete") return complete(db, body);
  return json({ ok: false, error: "unknown action" }, 400);
}

export async function onRequestGet(context) {
  const auth = await checkAuth(context);
  if (auth) return auth;

  const url = new URL(context.request.url);
  const action = url.searchParams.get("action") || "list";
  const db = context.env.DB;
  if (!db) return json({ ok: false, error: "D1 not bound" }, 500);

  if (action === "list") {
    const rows = await db.prepare(
      `SELECT id, platform, book_id, title, state, attempts, error, size, key, catalog_id, created_at, updated_at
       FROM harvest_jobs ORDER BY created_at DESC LIMIT 200`
    ).all();
    return json({ ok: true, jobs: rows.results || [] });
  }
  if (action === "quota") {
    const row = await db.prepare(
      "SELECT COALESCE(SUM(size),0) AS used FROM harvest_jobs WHERE state = 'done'"
    ).first();
    return json({ ok: true, used: Number(row?.used) || 0, cap: CAP_BYTES });
  }
  return json({ ok: false, error: "unknown action" }, 400);
}

// --- auth ----------------------------------------------------------------
async function checkAuth(context) {
  const token = context.env.HARVEST_TOKEN;
  if (!token) return json({ ok: false, error: "harvest not configured" }, 503);
  const got =
    context.request.headers.get("x-harvest-token") ||
    new URL(context.request.url).searchParams.get("t") ||
    "";
  if (!timingSafeEqual(got, token)) return json({ ok: false, error: "bad token" }, 403);
  return null;
}
function timingSafeEqual(a, b) {
  const x = String(a), y = String(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

// --- enqueue -------------------------------------------------------------
async function enqueue(db, b) {
  const platform = String(b.platform || "").trim().slice(0, 40);
  const bookId = String(b.bookId || b.book_id || "").trim().slice(0, 80);
  const title = String(b.title || "").trim().slice(0, MAX_TITLE);
  const secrets = typeof b.secrets === "string" ? b.secrets : JSON.stringify(b.secrets || {});
  if (!platform || !bookId) return json({ ok: false, error: "platform + bookId required" }, 400);
  if (secrets.length > MAX_SECRETS) return json({ ok: false, error: "secrets too large" }, 400);

  // hard storage cap — never queue more than the free tier can hold
  const used = await db.prepare(
    "SELECT COALESCE(SUM(size),0) AS used FROM harvest_jobs WHERE state = 'done'"
  ).first();
  if (Number(used?.used || 0) >= CAP_BYTES) {
    return json({ ok: false, error: "storage cap reached (9 GB) — delete old books first" }, 413);
  }

  // same book already queued/running? reuse the row
  const dupe = await db.prepare(
    "SELECT id FROM harvest_jobs WHERE platform = ?1 AND book_id = ?2 AND state IN ('queued','running') LIMIT 1"
  ).bind(platform, bookId).first();
  if (dupe) return json({ ok: true, id: dupe.id, existing: true });

  const now = Date.now();
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  await db.prepare(
    `INSERT INTO harvest_jobs (id, platform, book_id, title, state, secrets, created_at, updated_at)
     VALUES (?1,?2,?3,?4,'queued',?5,?6,?6)`
  ).bind(id, platform, bookId, title, secrets, now).run();

  return json({ ok: true, id });
}

// --- claim (workflow) ----------------------------------------------------
async function claim(db, b) {
  const limit = Math.max(1, Math.min(5, Number(b.limit) || 2));
  const stale = Date.now() - 30 * 60 * 1000; // running > 30 min = crashed runner
  await db.prepare(
    `UPDATE harvest_jobs SET state = 'queued', updated_at = ?1
     WHERE state = 'running' AND updated_at < ?1`
  ).bind(stale).run();

  const rows = await db.prepare(
    "SELECT * FROM harvest_jobs WHERE state = 'queued' ORDER BY created_at LIMIT ?1"
  ).bind(limit).all();
  const jobs = [];
  for (const row of rows.results || []) {
    await db.prepare(
      "UPDATE harvest_jobs SET state = 'running', attempts = attempts + 1, updated_at = ?2 WHERE id = ?1 AND state = 'queued'"
    ).bind(row.id, Date.now()).run();
    jobs.push(row);
  }
  return json({ ok: true, jobs });
}

// --- complete (workflow) -------------------------------------------------
async function complete(db, b) {
  const id = String(b.id || "").slice(0, 40);
  if (!id) return json({ ok: false, error: "id required" }, 400);
  const row = await db.prepare("SELECT attempts FROM harvest_jobs WHERE id = ?").bind(id).first();
  if (!row) return json({ ok: false, error: "not found" }, 404);

  const ok = !!b.ok;
  const size = Math.max(0, Math.floor(Number(b.size) || 0));
  const key = String(b.key || "").slice(0, 200);
  const error = String(b.error || "").slice(0, 500);
  const catalogId = String(b.catalogId || b.catalog_id || "").slice(0, 40);
  const now = Date.now();

  if (ok) {
    await db.prepare(
      `UPDATE harvest_jobs SET state='done', size=?2, key=?3, error='', catalog_id=?4, secrets='', updated_at=?5 WHERE id=?1`
    ).bind(id, size, key, catalogId, now).run();
    return json({ ok: true, id, state: "done" });
  }

  // failure: retry up to MAX_ATTEMPTS, then terminal — secrets purged
  const attempts = Number(row.attempts) || 1;
  if (attempts >= MAX_ATTEMPTS) {
    await db.prepare(
      "UPDATE harvest_jobs SET state='error', error=?2, secrets='', updated_at=?3 WHERE id=?1"
    ).bind(id, error, now).run();
    return json({ ok: true, id, state: "error" });
  }
  await db.prepare(
    "UPDATE harvest_jobs SET state='queued', error=?2, updated_at=?3 WHERE id=?1"
  ).bind(id, error, now).run();
  return json({ ok: true, id, state: "queued", attempts });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
