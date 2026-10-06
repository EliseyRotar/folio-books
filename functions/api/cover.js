// Folio — Pages Function: title → cover URL.
//
// One cached, same-origin lookup so the catalog never hammers keyless cover
// APIs from every visitor's browser (Google rate-limits client IPs almost
// immediately). Order: Cache API → Open Library search → Google Books.
// Positive results cache for 30 days, misses for an hour.
//
//   GET ?q=<title>  -> { ok, url } | { ok: false, error }

const TTL_HIT = 60 * 60 * 24 * 30;
const TTL_MISS = 60 * 60;
const UA = "Folio-Reader/1.0 (+https://folio-books.pages.dev)";

export async function onRequestGet(context) {
  const q = (new URL(context.request.url).searchParams.get("q") || "").trim().slice(0, 200);
  if (!q) return json({ ok: false, error: "q required" }, 400);

  const cache = globalThis.caches && caches.default;
  const key = new Request("https://folio.internal/cover?q=" + encodeURIComponent(q.toLowerCase()));

  if (cache) {
    const hit = await cache.match(key);
    if (hit) {
      const body = await hit.json().catch(() => ({ ok: false }));
      return json(body, 200, hit.headers.get("x-folio-ttl") === "miss" ? "HIT-NEG" : "HIT");
    }
  }

  let url = "";
  try {
    const r = await fetch("https://openlibrary.org/search.json?limit=1&fields=cover_i,title&q=" +
      encodeURIComponent(q), { headers: { "user-agent": UA } });
    const j = await r.json();
    const cid = j && j.docs && j.docs[0] && j.docs[0].cover_i;
    if (cid) url = "https://covers.openlibrary.org/b/id/" + cid + "-L.jpg";
  } catch (_) {}

  if (!url) {
    try {
      const r = await fetch("https://www.googleapis.com/books/v1/volumes?maxResults=1&q=" +
        encodeURIComponent("intitle:" + q), { headers: { "user-agent": UA } });
      if (r.ok) {
        const j = await r.json();
        const links = j && j.items && j.items[0] && j.items[0].volumeInfo && j.items[0].volumeInfo.imageLinks;
        if (links) url = String(links.thumbnail || links.medium || links.small || "").replace(/^http:/, "https:");
      }
    } catch (_) {}
  }

  const body = url ? { ok: true, url } : { ok: false, error: "no cover found" };
  if (cache) {
    const res = new Response(JSON.stringify(body), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=" + (url ? TTL_HIT : TTL_MISS),
        "x-folio-ttl": url ? "hit" : "miss"
      }
    });
    context.waitUntil(cache.put(key, res.clone()));
  }
  return json(body, 200, url ? "MISS" : "MISS-NEG");
}

function json(obj, status, via) {
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (via) headers["x-folio-cache"] = via;
  return new Response(JSON.stringify(obj), { status, headers });
}
