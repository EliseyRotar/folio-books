// Folio — Pages Function: stream a published PDF out of D1 chunks.
//
// The reader never gets the whole book in one response (Workers CPU/memory
// limits). It asks for one chunk at a time and stitches them into a Blob in
// the tab, which also lets it show a real progress bar.
//
//   GET ?id=book&page=info        -> { ok, size, chunks, pages, filename, title, platform }
//   GET ?id=book&page=0           -> one chunk, application/octet-stream
//
// Response headers on a chunk: x-folio-index, x-folio-chunks, x-folio-size,
// x-folio-filename — enough for the viewer to validate before assembling.

export async function onRequestGet(context) {
  const db = context.env.DB;
  if (!db) return json({ ok: false, error: "D1 not bound" }, 500);

  const url = new URL(context.request.url);
  const id = (url.searchParams.get("id") || "").trim().slice(0, 40);
  const page = url.searchParams.get("page");

  if (!id) return json({ ok: false, error: "id required" }, 400);

  try {
    const meta = await db.prepare(
      `SELECT id, title, filename, pages, size, chunks, has_pdf
         FROM catalog WHERE id = ?`
    ).bind(id).first();

    if (!meta) return json({ ok: false, error: "not found" }, 404);

    if (page === "info" || page === null) {
      return json({
        ok: true,
        id: meta.id,
        title: meta.title || "",
        filename: meta.filename || (slug(meta.title) + ".pdf"),
        pages: meta.pages || 0,
        size: meta.size || 0,
        chunks: meta.chunks || 0,
        hasPdf: !!meta.has_pdf
      });
    }

    if (!meta.has_pdf) return json({ ok: false, error: "no pdf yet — metadata only" }, 404);

    const idx = Number(page);
    if (!Number.isInteger(idx) || idx < 0 || idx >= (meta.chunks || 0)) {
      return json({ ok: false, error: "bad chunk index" }, 400);
    }

    const row = await db.prepare(
      "SELECT data FROM catalog_chunk WHERE book_id = ? AND idx = ?"
    ).bind(id, idx).first();

    if (!row || !row.data) return json({ ok: false, error: "chunk missing" }, 404);

    const bytes = b64decode(row.data);

    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(bytes.byteLength),
        "cache-control": "private, max-age=0",
        "x-folio-index": String(idx),
        "x-folio-chunks": String(meta.chunks || 0),
        "x-folio-size": String(meta.size || 0),
        "x-folio-filename": encodeURIComponent(meta.filename || "book.pdf")
      }
    });
  } catch (e) {
    return json({ ok: false, error: "pdf read failed: " + (e.message || e) }, 500);
  }
}

function b64decode(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function slug(t) {
  return String(t || "book").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "book";
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
