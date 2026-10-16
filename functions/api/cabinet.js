// Folio — Pages Function: the Cabinet API.
//
// The "Cabinet" is your plaintext account + book ledger. No Cabinet, no
// encryption, no passphrase. Credentials for every saved account and every
// book you've collected are stored as visible JSON in Cloudflare D1 and
// mirrored to this browser as the single source of truth. The doorstep of
// the Cabinet is gone; what you enter is the desk.

const MAX_DOC = 2 * 1024 * 1024; // 2 MB of plaintext per device

export async function onRequestGet(context) {
  const db = context.env.DB;
  if (!db) return json({ ok: false, error: "D1 not bound — Cabinet unavailable" }, 500);

  const device = (new URL(context.request.url).searchParams.get("device") || "").trim();
  if (!device) return json({ ok: false, error: "missing device id" }, 400);

  const row = await db.prepare(
    "SELECT device, doc, updated_at FROM cabinet WHERE device = ?"
  ).bind(device).first();

  if (!row) return json({ ok: true, exists: false, device });

  return json({
    ok: true,
    exists: true,
    device,
    doc: row.doc,
    updatedAt: row.updated_at
  });
}

export async function onRequestPost(context) {
  const db = context.env.DB;
  if (!db) return json({ ok: false, error: "D1 not bound — Cabinet unavailable" }, 500);

  let body;
  try {
    body = await context.request.json();
  } catch (_) {
    return json({ ok: false, error: "invalid JSON" }, 400);
  }

  const device = String(body.device || "").trim();
  const doc = String(body.doc || "").trim();
  if (!device) return json({ ok: false, error: "missing device id" }, 400);
  if (!doc) return json({ ok: false, error: "missing cabinet doc" }, 400);
  if (doc.length > MAX_DOC) return json({ ok: false, error: "cabinet too large" }, 413);

  const updatedAt = Number(body.updatedAt) || Date.now();

  try {
    await db.prepare(
      `INSERT INTO cabinet (device, doc, updated_at, created_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(device) DO UPDATE SET
         doc = excluded.doc,
         updated_at = excluded.updated_at`
    ).bind(device, doc, updatedAt, Date.now()).run();
  } catch (e) {
    return json({ ok: false, error: "d1 write failed: " + (e && e.message ? e.message : String(e)), len: doc.length }, 500);
  }

  return json({ ok: true, device, updatedAt });
}

export async function onRequestDelete(context) {
  const db = context.env.DB;
  if (!db) return json({ ok: false, error: "D1 not bound — Cabinet unavailable" }, 500);

  const device = (new URL(context.request.url).searchParams.get("device") || "").trim();
  if (!device) return json({ ok: false, error: "missing device id" }, 400);

  await db.prepare("DELETE FROM cabinet WHERE device = ?").bind(device).run();
  return json({ ok: true });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
