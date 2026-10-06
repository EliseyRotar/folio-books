// Folio — Pages Function: textbook API relay.
//
// Browser pages are subject to CORS; many textbook servers do not send
// CORS headers. This Function relays requests to a curated allowlist of
// schoolbook backends so those platforms can be reached from the browser.
//
// It is a plain pipe: it forwards your method/headers/body byte-for-byte
// and returns the upstream bytes. It does not log, alter, or inspect the
// payload. Requests to hosts outside the allowlist are rejected.

const ALLOWED_HOST = [
  /(^|\.)hubscuola\.it$/i,
  /(^|\.)mondadorieducation\.it$/i,
  /(^|\.)ms-mms\.hubscuola\.it$/i,
  /(^|\.)loescher\.it$/i,
  /(^|\.)bsmart\.it$/i,
  /(^|\.)bsw\.it$/i,             // bSmart infrastructure / page-asset CDN
  /(^|\.)digibook24\.com$/i,     // DigiBook24 (same shelf, other front door)
  /(^|\.)digibook\.it$/i,
  /(^|\.)dibooklaterza\.it$/i,
  /(^|\.)pearson.*\.com$/i,
  /(^|\.)pearson\.it$/i,
  /(^|\.)sanoma.*$/i,
  /(^|\.)zanichelli\.it$/i,
  /(^|\.)educadhoc\.com$/i,
  /(^|\.)hoepli\.it$/i,
  /(^|\.)wsetglobal\.com$/i,
  /(^|\.)kitaboo\.com$/i,
  /(^|\.)blister\.it$/i,
  /(^|\.)ncert\.nic\.in$/i,
  /(^|\.)epathshala\.nic\.in$/i,
  /(^|\.)githubusercontent\.com$/i
];

function hostAllowed(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch (_) {
    return false;
  }
  return ALLOWED_HOST.some((re) => re.test(hostname));
}

function isProbablyBinary(ct) {
  if (!ct) return false;
  return !/text|json|xml|javascript|css|svg/.test(ct);
}

async function readBody(req) {
  const type = req.headers.get("content-type") || "";
  if (req.method === "GET") return { url: req.url };
  if (req.method !== "POST") return null;
  if (!type.includes("application/json")) return null;
  try {
    return await req.json();
  } catch (_) {
    return null;
  }
}

export async function onRequestPost(context) {
  return proxyRequest(context);
}

export async function onRequestGet(context) {
  return proxyRequest(context);
}

async function proxyRequest(context) {
  const { request } = context;
  let payload = null;

  if (request.method === "POST") {
    const type = request.headers.get("content-type") || "";
    if (!type.includes("application/json")) {
      return json({ ok: false, error: "send JSON: { url, method, headers, bodyBase64 }" }, 400);
    }
    try {
      payload = await request.json();
    } catch (_) {
      return json({ ok: false, error: "invalid JSON body" }, 400);
    }
  } else if (request.method === "GET") {
    const u = new URL(request.url).searchParams.get("url");
    if (!u) return json({ ok: false, error: "missing ?url=" }, 400);
    payload = { url: u };
  } else {
    return json({ ok: false, error: "method not allowed" }, 405);
  }

  const { url, method = "GET", headers = {}, bodyBase64 } = payload || {};

  if (!url || typeof url !== "string") {
    return json({ ok: false, error: "missing url" }, 400);
  }
  if (!hostAllowed(url)) {
    return json({ ok: false, error: "host not allowed by Folio proxy", host: safeHost(url) }, 403);
  }

  try {
    const init = {
      method,
      redirect: "follow",
      headers: typeof headers === "object" && headers
        ? sanitizeHeaders(headers)
        : undefined
    };

    if (bodyBase64) {
      init.body = fromBase64(bodyBase64);
    } else if (method !== "GET" && headers && headers["content-type"]) {
      // Allow a raw-string body sent as JSON string field.
    }

    const upstream = await fetch(url, init);
    const buf = new Uint8Array(await upstream.arrayBuffer());
    const isBin = isProbablyBinary(upstream.headers.get("content-type"));

    return json({
      ok: true,
      status: upstream.status,
      headers: pickedHeaders(upstream.headers),
      dataBase64: toBase64(buf)
    });
  } catch (e) {
    return json({ ok: false, error: "upstream error: " + (e.message || e) }, 502);
  }
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return "invalid-url";
  }
}

function sanitizeHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    const lk = k.toLowerCase();
    if (lk === "host" || lk === "origin" || lk === "referer" || lk.startsWith("access-control")) continue;
    out[lk] = String(v);
  }
  return out;
}

function pickedHeaders(h) {
  const out = {};
  for (const [k, v] of h.entries()) {
    const lk = k.toLowerCase();
    if (lk === "content-type" || lk === "content-length" || lk === "etag" || lk === "last-modified" || lk === "content-disposition") {
      out[k] = v;
    }
  }
  return out;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function toBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}