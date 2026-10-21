// Folio — Pages Function: title/isbn → cover URL (or the image itself).
//
// One cached, same-origin lookup so the catalog never hammers keyless cover
// APIs from every visitor's browser (Google rate-limits client IPs almost
// immediately).
//
//   GET ?q=<title>              -> { ok, url }           (JSON, legacy)
//   GET ?isbn=<isbn>            -> { ok, url }           (JSON)
//   GET ?isbn=<isbn>&img=1      -> 302 / cached image bytes  (<img> use)
//
// ISBN is tried first when present (Google Books volumes API → Open Library)
// — it resolves the exact edition instead of Google's first title guess.
// Title lookups pick the FIRST result whose title actually matches the
// query instead of blindly taking item #1. Positive results cache for 30
// days, misses for an hour.

const TTL_HIT = 60 * 60 * 24 * 30;
const TTL_MISS = 60 * 60;
const UA = "Folio-Reader/1.0 (+https://folio-books.pages.dev)";

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const isbn = (url.searchParams.get("isbn") || "").replace(/[^0-9Xx]/gi, "").slice(0, 17);
  const wantImg = url.searchParams.get("img") === "1";
  const q = (url.searchParams.get("q") || "").trim().slice(0, 200);

  if (wantImg && isbn) return coverImage(context, isbn);
  if (isbn) {
    // Same edge cache as the title path — keyless Google Books quota is
    // shared per egress IP, so every uncached ISBN lookup burns it.
    const cache = globalThis.caches && caches.default;
    const key = new Request("https://folio.internal/cover?isbn=" + encodeURIComponent(isbn));

    if (cache) {
      const hit = await cache.match(key);
      if (hit) {
        const body = await hit.json().catch(() => ({ ok: false }));
        return json(body, 200, hit.headers.get("x-folio-ttl") === "miss" ? "HIT-NEG" : "HIT");
      }
    }

    const body = (await resolveIsbn(isbn)) || { ok: false, error: "no cover for isbn" };
    if (cache) {
      const res = new Response(JSON.stringify(body), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=" + (body.ok ? TTL_HIT : TTL_MISS),
          "x-folio-ttl": body.ok ? "hit" : "miss"
        }
      });
      context.waitUntil(cache.put(key, res.clone()));
    }
    return json(body, 200, body.ok ? "MISS" : "MISS-NEG");
  }
  if (!q) return json({ ok: false, error: "q or isbn required" }, 400);

  const cache = globalThis.caches && caches.default;
  const key = new Request("https://folio.internal/cover?q=" + encodeURIComponent(q.toLowerCase()));

  if (cache) {
    const hit = await cache.match(key);
    if (hit) {
      const body = await hit.json().catch(() => ({ ok: false }));
      return json(body, 200, hit.headers.get("x-folio-ttl") === "miss" ? "HIT-NEG" : "HIT");
    }
  }

  let url2 = "";
  try {
    const r = await fetch("https://openlibrary.org/search.json?limit=1&fields=cover_i,title&q=" +
      encodeURIComponent(q), { headers: { "user-agent": UA } });
    const j = await r.json();
    const cid = j && j.docs && j.docs[0] && j.docs[0].cover_i;
    if (cid) url2 = "https://covers.openlibrary.org/b/id/" + cid + "-L.jpg";
  } catch (_) {}

  if (!url2) url2 = await googleByTitle(q);

  const body = url2 ? { ok: true, url: url2 } : { ok: false, error: "no cover found" };
  if (cache) {
    const res = new Response(JSON.stringify(body), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=" + (url2 ? TTL_HIT : TTL_MISS),
        "x-folio-ttl": url2 ? "hit" : "miss"
      }
    });
    context.waitUntil(cache.put(key, res.clone()));
  }
  return json(body, 200, url2 ? "MISS" : "MISS-NEG");
}

// ISBN → exact-edition cover. Google Books knows most school editions;
// Open Library is the backup.
async function resolveIsbn(isbn) {
  try {
    const r = await fetch("https://www.googleapis.com/books/v1/volumes?maxResults=1&q=" +
      encodeURIComponent("isbn:" + isbn), { headers: { "user-agent": UA } });
    if (r.ok) {
      const j = await r.json();
      const links = j && j.items && j.items[0] && j.items[0].volumeInfo && j.items[0].volumeInfo.imageLinks;
      const u = links && (links.thumbnail || links.medium || links.small || links.large);
      if (u) return { ok: true, url: String(u).replace(/^http:/, "https:") };
    }
  } catch (_) {}
  try {
    const r = await fetch("https://openlibrary.org/search.json?limit=1&fields=cover_i&isbn=" +
      encodeURIComponent(isbn), { headers: { "user-agent": UA } });
    const j = await r.json();
    const cid = j && j.docs && j.docs[0] && j.docs[0].cover_i;
    if (cid) return { ok: true, url: "https://covers.openlibrary.org/b/id/" + cid + "-L.jpg" };
  } catch (_) {}
  return null;
}

// Serve the image bytes for an ISBN (same-origin <img> candidate). The
// resolved URL and the image itself are both cached at the edge for 30 days.
async function coverImage(context, isbn) {
  const cache = globalThis.caches && caches.default;
  const key = new Request("https://folio.internal/coverimg/" + isbn.toLowerCase());

  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }

  const resolved = await resolveIsbn(isbn);
  if (!resolved) return new Response("no cover", { status: 404, headers: { "cache-control": "public, max-age=3600" } });

  const img = await fetch(resolved.url, { headers: { "user-agent": UA } });
  if (!img.ok) return new Response("cover fetch failed", { status: 502, headers: { "cache-control": "public, max-age=600" } });

  const res = new Response(img.body, {
    headers: {
      "content-type": img.headers.get("content-type") || "image/jpeg",
      "cache-control": "public, max-age=" + TTL_HIT
    }
  });
  if (cache && context.waitUntil) context.waitUntil(cache.put(key, res.clone()));
  return res;
}

// Google Books by title — but only accept a result whose title actually
// matches the query (normalized); the first hit alone often is a different
// edition/language of a same-named book.
async function googleByTitle(q) {
  try {
    const r = await fetch("https://www.googleapis.com/books/v1/volumes?maxResults=5&q=" +
      encodeURIComponent("intitle:" + q), { headers: { "user-agent": UA } });
    if (!r.ok) return "";
    const j = await r.json();
    const items = (j && j.items) || [];
    const want = normT(q);
    let fallback = "";
    for (const it of items) {
      const vi = it.volumeInfo || {};
      const links = vi.imageLinks;
      if (!links) continue;
      const u = String(links.thumbnail || links.medium || links.small || "").replace(/^http:/, "https:");
      if (!u) continue;
      if (normT(vi.title || "") === want) return u;
      if (!fallback) fallback = u;
    }
    return fallback;
  } catch (_) { return ""; }
}
function normT(s) {
  return String(s || "").replace(/[\t\n\r\f\v]+/g, " ").replace(/ {2,}/g, " ").trim().toLowerCase();
}

function json(obj, status, via) {
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (via) headers["x-folio-cache"] = via;
  return new Response(JSON.stringify(obj), { status, headers });
}
