// Folio — Pages Function: the PUBLIC catalog.
//
// Returns book metadata only: title, author, isbn, platform, cover, page
// count, size, publish time, and the public slug. Never returns secrets,
// credentials, account rows, device ids, delete keys or the cabinet doc.
// This is what catalog.html and the landing pages consume.

export async function onRequestGet(context) {
  const db = context.env.DB;
  if (!db) return json({ ok: false, error: "D1 not bound — catalog unavailable" }, 500);

  const url = new URL(context.request.url);
  const one = url.searchParams.get("id");

  try {
    if (one) {
      const row = await db.prepare(
        `SELECT id, title, author, isbn, platform, cover, filename, pages, size, chunks,
                has_pdf, published_at
           FROM catalog WHERE id = ?`
      ).bind(one).first();
      if (!row) return json({ ok: false, error: "not found" }, 404);
      return json({ ok: true, book: shape(row) });
    }

    const rows = await db.prepare(
      `SELECT id, title, author, isbn, platform, cover, filename, pages, size, chunks,
              has_pdf, published_at
         FROM catalog
        ORDER BY published_at DESC
        LIMIT 500`
    ).all();

    const books = (rows.results || []).map(shape);
    return json({ ok: true, count: books.length, books });
  } catch (e) {
    return json({ ok: false, error: "catalog read failed: " + (e.message || e) }, 500);
  }
}

function shape(r) {
  return {
    id: r.id,
    title: r.title || "",
    author: r.author || "",
    isbn: r.isbn || "",
    platform: r.platform || "",
    cover: r.cover || "",
    filename: r.filename || "",
    pages: r.pages || 0,
    size: r.size || 0,
    chunks: r.chunks || 0,
    hasPdf: !!r.has_pdf,
    publishedAt: r.published_at || 0
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=60" } });
}
