// Folio — shared browser toolkit.
// All downloading happens here in the page. Credentials stay in this tab
// (optionally sealed into your plaintext Cabinet stored on your device).

window.Folio = window.Folio || {};
const F = Folio;

// The Cloudflare Pages relay lives on the same origin at /api/proxy.
// When previewing the static site without the relay, engines that need
// it report a clear, actionable error instead of failing silently.
F.PROXY_HOST = "/api/proxy";

F.bytesToB64 = (bytes) => {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
};

F.b64ToBytes = (b64) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

function initFromOpts(opts) {
  const init = { method: opts.method || "GET", headers: opts.headers || {}, redirect: "follow" };
  if ("body" in opts) init.body = opts.body;
  return init;
}

// Fetch a book-platform resource. `viaProxy: true` routes it through the
// relay so CORS-locked backends are reachable from the browser page.
F.api = async function api(url, opts = {}, { viaProxy } = {}) {
  if (!viaProxy) return fetch(url, initFromOpts(opts));
  return relay(url, opts);
};

// Global burst pause: Cloudflare's edge answers clusters of 503 that can
// last minutes. Each throttle failure extends one shared pause (8s up to
// 3 min); every relay call waits it out first and then probes, so a single
// burst window doesn't sink every queued book. Any real answer resets it.
let relayFails = 0;
let relayPauseUntil = 0;

async function relay(url, opts) {
  // Retry 429/5xx/network failures; the growing global pause does the
  // window-riding, the per-call delays just space the probes. 4xx answers
  // are permanent — surface them immediately.
  const delays = [800, 2000, 4000, 7000];
  let lastErr;
  for (let attempt = 0; ; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, delays[Math.min(attempt - 1, delays.length - 1)] + Math.random() * 500));
    if (Date.now() < relayPauseUntil) await new Promise((r) => setTimeout(r, relayPauseUntil - Date.now()));
    let res;
    try {
      res = await fetch(F.PROXY_HOST, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          method: opts.method || "GET",
          headers: opts.headers || {},
          bodyBase64: opts.body ? F.bytesToB64(opts.body) : undefined
        })
      });
    } catch (_) {
      lastErr = new Error("The Folio relay is unreachable. Deploy on Cloudflare Pages for full coverage.");
      if (attempt >= delays.length) throw lastErr;
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error("relay HTTP " + res.status + " — throttled, riding it out");
      relayFails = Math.min(relayFails + 1, 6);
      relayPauseUntil = Date.now() + Math.min(180000, 8000 * Math.pow(2, relayFails - 1));
      if (attempt >= delays.length) throw lastErr;
      continue;
    }
    relayFails = 0;
    relayPauseUntil = 0;
    if (!res.ok) throw new Error("relay HTTP " + res.status);
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || "relay error " + j.status);
    // Upstream throttling (the CDN behind the relay answering 5xx) — retry too.
    if (j.status >= 500 && attempt < delays.length) {
      lastErr = new Error("upstream HTTP " + j.status);
      continue;
    }
    const ct = (j.headers && (j.headers["content-type"] || j.headers["Content-Type"])) || "application/octet-stream";
    const bytes = j.dataBase64 ? F.b64ToBytes(j.dataBase64) : new Uint8Array(0);
    return new Response(bytes, { status: j.status || 200, headers: { "content-type": ct, "x-folio-proxied": "1" } });
  }
}

// Detect whether the relay is deployed on this origin (one cheap call).
F.relayAvailable = async function relayAvailable() {
  try {
    const r = await fetch(F.PROXY_HOST + "?url=https://example.com", { method: "GET" });
    const j = await r.json();
    // host-not-allowed is proof the relay is alive; "not found" means a
    // static host without Functions.
    return j && (j.ok === false || typeof j.ok === "boolean");
  } catch (_) {
    return false;
  }
};

let _logEl = null;
F.bindLog = (el) => { _logEl = el; if (el) el.scrollTop = el.scrollHeight; };
F.log = (txt, cls) => {
  if (!_logEl) return;
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = txt + "\n";
  _logEl.appendChild(span);
  _logEl.scrollTop = _logEl.scrollHeight;
};
F.ok = (t) => F.log(t, "ok");
F.err = (t) => F.log(t, "err");
F.dim = (t) => F.log(t, "dim");

F.saveBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
};

F.sanitizeName = (s) => (s || "book").replace(/[\\/:*?"<>|]+/g, "_").trim() || "book";

F.fmtBytes = (n) => {
  if (!Number.isFinite(n)) return "?";
  if (n < 1024) return n + " B";
  const u = ["KB", "MB", "GB"];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(1) + " " + u[i];
};

F.loadScript = (src) => new Promise((resolve, reject) => {
  const s = document.createElement("script");
  s.src = src;
  s.onload = () => resolve();
  s.onerror = () => reject(new Error("Failed to load " + src));
  document.head.appendChild(s);
});

// Load the heavy CDN libraries once, on demand.
F.libs = { sql: null, jszip: false, pdflib: false };
F.ensure = async function ensure({ sql, jszip, pdflib }) {
  const jobs = [];
  if (sql && !F.libs.sql) {
    jobs.push(F.loadScript("https://cdn.jsdelivr.net/npm/sql.js@1.11.0/dist/sql-wasm.js")
      .then(async () => {
        F.libs.sql = await initSqlJs({ locateFile: (f) => "https://cdn.jsdelivr.net/npm/sql.js@1.11.0/dist/" + f });
      }));
    await Promise.all(jobs.splice(0, jobs.length));
  }
  if (jszip && !F.libs.jszip) {
    jobs.push(F.loadScript("https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js").then(() => { F.libs.jszip = true; }));
  }
  if (pdflib && !F.libs.pdflib) {
    jobs.push(F.loadScript("https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js").then(() => { F.libs.pdflib = true; }));
  }
  await Promise.all(jobs);
};

F.esc = (s) => String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ----- covers ------------------------------------------------------------
// A shelf row carries an ordered list of candidate cover URLs. The first
// that actually renders a real image (>=10px — Amazon serves a 1x1 pixel
// for unknown ISBNs) wins; if every candidate fails we show a book
// silhouette, never letters.

const BOOK_SVG =
  '<svg viewBox="0 0 24 24" width="55%" height="55%" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">' +
  '<path d="M4 4.5h6.2c1 0 1.8.8 1.8 1.8V20a2.2 2.2 0 0 0-2.2-2.2H4V4.5Z"/>' +
  '<path d="M20 4.5h-6.2c-1 0-1.8.8-1.8 1.8V20a2.2 2.2 0 0 1 2.2-2.2H20V4.5Z"/>' +
  '<path d="M12 6.3v11.5"/></svg>';

F.coverPh = function coverPh(phClass) {
  const d = document.createElement("div");
  d.className = "cover-ph" + (phClass ? " " + phClass : "");
  d.setAttribute("aria-hidden", "true");
  d.innerHTML = BOOK_SVG;
  return d;
};

// ISBN -> ordered https candidates (no API keys, all hotlinkable).
F.staticCovers = function staticCovers(isbn) {
  const id = String(isbn || "").replace(/[^0-9Xx]/g, "");
  if (id.length !== 10 && id.length !== 13) return [];
  const isbn13 = id.length === 13 ? id : isbn13of(id);
  const isbn10 = id.length === 10 ? id : isbn10of(id);
  const out = [
    "https://covers.openlibrary.org/b/isbn/" + isbn13 + "-L.jpg?default=false",
    isbn10 ? "https://images-na.ssl-images-amazon.com/images/P/" + isbn10 + ".01.LZZZZZZZ.jpg" : "",
    isbn10 ? "https://books.google.com/books/content?vid=ISBN" + isbn10 + "&printsec=frontcover&img=1&zoom=2" : "",
    "https://covers.openlibrary.org/b/isbn/" + isbn10 + "-L.jpg?default=false"
  ].filter(Boolean);
  // de-dupe (isbn10 === isbn13 impossible, but cheap to guard)
  return [...new Set(out)];
};

function isbn13of(i10) {
  const core = "978" + i10.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 ? 3 : 1);
  return core + String((10 - (sum % 10)) % 10);
}
function isbn10of(i13) {
  if (i13.length !== 13) return "";
  const core = i13.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(core[i]) * (10 - i);
  const chk = (11 - (sum % 11)) % 11;
  return core + (chk === 10 ? "X" : String(chk));
}

// Ordered candidates for one book: platform cover, then ISBN sources, then
// (only when nothing else exists) a title search — Open Library first, Google
// Books as a backup. Title searches are serialized (keyless APIs rate-limit
// hard), de-duped per title, and cached in localStorage forever.
let _titleQ = Promise.resolve();
const _titleInflight = new Map();

function titleSearch(title) {
  const k = String(title || "").trim().toLowerCase().slice(0, 120);
  if (!k) return Promise.resolve("");
  try {
    const cached = localStorage.getItem("folio.coverT:" + k);
    if (cached) return Promise.resolve(cached === "-none-" ? "" : cached);
  } catch (_) {}
  if (_titleInflight.has(k)) return _titleInflight.get(k);

  const job = _titleQ.then(async () => {
    let url = "";
    // Same-origin cached lookup first — never hammer keyless APIs from
    // the visitor's own IP.
    try {
      const r = await fetch("/api/cover?q=" + encodeURIComponent(title.slice(0, 200)));
      if (r.ok) {
        const j = await r.json().catch(() => null);
        if (j && j.ok && j.url) url = j.url;
      }
    } catch (_) {}
    if (!url) {
      // static-host fallback: Open Library directly (no key, generous limits)
      try {
        const r = await fetch("https://openlibrary.org/search.json?limit=1&fields=cover_i,title&q=" +
          encodeURIComponent(title.slice(0, 140)));
        const j = await r.json();
        const cid = j && j.docs && j.docs[0] && j.docs[0].cover_i;
        if (cid) url = "https://covers.openlibrary.org/b/id/" + cid + "-L.jpg";
      } catch (_) {}
    }
    try { localStorage.setItem("folio.coverT:" + k, url || "-none-"); } catch (_) {}
    // breathing room between lookups
    await new Promise((res) => setTimeout(res, 250));
    return url;
  }).catch(() => "");

  _titleQ = job;
  const tracked = job.finally(() => _titleInflight.delete(k));
  _titleInflight.set(k, tracked);
  return tracked;
}

F.coversOf = async function coversOf(b) {
  const list = [];
  const push = (u) => { if (u && typeof u === "string" && !list.includes(u)) list.push(u); };
  if (Array.isArray(b.covers)) b.covers.forEach(push);
  push(b.cover);
  if (b.cover && b.cover.startsWith("[")) {
    try { JSON.parse(b.cover).forEach(push); } catch (_) {}
  }
  if (b.isbn) F.staticCovers(b.isbn).forEach(push);
  if (!list.length && b.title) push(await titleSearch(b.title));
  return list;
};

// <img> that walks the candidate list; falls back to the silhouette.
F.coverEl = function coverEl(covers, phClass) {
  const list = (covers || []).filter((u) => typeof u === "string" && u);
  if (!list.length) return F.coverPh(phClass);
  const img = document.createElement("img");
  img.alt = "";
  img.loading = "lazy";
  let i = 0;
  const next = () => {
    i++;
    if (i < list.length) img.src = list[i];
    else img.replaceWith(F.coverPh(phClass));
  };
  img.addEventListener("error", next);
  img.addEventListener("load", () => { if (img.naturalWidth < 10 || img.naturalHeight < 10) next(); });
  img.src = list[0];
  return img;
};

// Normalize a catalog/shelf record's cover field (URL, data URI or a JSON
// list) plus ISBN sources into one candidate list.
F.coversList = function coversList(b) {
  const list = [];
  const push = (u) => { if (u && typeof u === "string" && !list.includes(u)) list.push(u); };
  if (Array.isArray(b.covers)) b.covers.forEach(push);
  if (typeof b.cover === "string" && b.cover.startsWith("[")) {
    try { JSON.parse(b.cover).forEach(push); } catch (_) {}
  } else {
    push(b.cover);
  }
  if (b.isbn) F.staticCovers(b.isbn).forEach(push);
  return list;
};