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
  /(^|\.)pearson\.com$/i,
  /(^|\.)pearson\.it$/i,
  /(^|\.)hachette-livre\.fr$/i,
  /(^|\.)sanoma\.it$/i,
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
  const upstreamMethod = String(method || "GET").toUpperCase();
  if (!["GET", "POST", "HEAD"].includes(upstreamMethod)) {
    return json({ ok: false, error: "method not allowed (GET, POST, HEAD)" }, 405);
  }
  if (!hostAllowed(url)) {
    return json({ ok: false, error: "host not allowed by Folio proxy", host: safeHost(url) }, 403);
  }

  try {
    const init = {
      method: upstreamMethod,
      redirect: "manual",
      headers: typeof headers === "object" && headers
        ? sanitizeHeaders(headers)
        : undefined
    };

    if (bodyBase64) {
      init.body = fromBase64(bodyBase64);
    }

    // Follow redirects manually so every hop is re-checked against the
    // allowlist — a followed redirect must not open the relay to a host
    // the first URL would never have passed.
    const MAX_REDIRECTS = 3;
    let currentUrl = url;
    let upstream;
    for (let hop = 0; ; hop++) {
      upstream = await fetch(currentUrl, init);
      const loc = upstream.headers.get("location");
      if (upstream.status >= 300 && upstream.status < 400 && loc && hop < MAX_REDIRECTS) {
        let next;
        try {
          next = new URL(loc, currentUrl).toString();
        } catch (_) {
          return json({ ok: false, error: "invalid redirect location" }, 502);
        }
        if (!hostAllowed(next)) {
          return json({ ok: false, error: "redirect host not allowed by Folio proxy", host: safeHost(next) }, 403);
        }
        currentUrl = next;
        if (upstream.status === 303 || ((upstream.status === 301 || upstream.status === 302) && init.method === "POST")) {
          init.method = "GET";
          delete init.body;
        }
        continue;
      }
      break;
    }

    const buf = new Uint8Array(await upstream.arrayBuffer());

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