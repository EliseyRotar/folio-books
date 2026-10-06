// Folio Publisher — puts books on the public catalog.
//
// Design rules (the same ones the server enforces):
//   * only metadata travels on auto-publish: title, author, isbn, platform,
//     cover list, page count. No account ids, no secrets, no device id.
//   * publishing is ALWAYS ON — there is no switch. Every shelf and every
//     PDF joins the catalog; the catalog itself is permanent (no unpublish).
//   * the PDF is uploaded as raw 16 MB parts to R2 when the bucket is
//     bound, or as ~192 KB base64 chunks in D1 otherwise.
//
// Everything here is fire-and-forget background work: the shelf stays usable
// while uploads run, and failures just log a line.

(function () {
  const F = Folio;
  const PUB = {};
  Folio.publish = PUB;

  const LS_KEY = "folio.published.v1";      // { "<platform>:<bookId>": { id, deleteKey, hasPdf } }
  const R2_PART = 16 * 1024 * 1024;
  const MAX_R2_PARTS = 64;
  let _storage = null;                       // "r2" | "d1", probed once per session

  function readMap() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch (_) { return {}; }
  }
  function writeMap(m) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(m)); } catch (_) {}
  }
  function bk(b) { return b.platform + ":" + b.id; }

  PUB.entryFor = function entryFor(b) { return readMap()[bk(b)] || null; };

  function remember(b, rec) {
    const m = readMap();
    m[bk(b)] = rec;
    writeMap(m);
  }

  // ----- HTTP ----------------------------------------------------------
  async function api(step, payload) {
    const res = await fetch("/api/publish?step=" + step, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const out = await res.json().catch(() => ({ ok: false, error: "bad response " + res.status }));
    if (!res.ok || !out.ok) throw new Error(out.error || ("publish failed (" + res.status + ")"));
    return out;
  }

  // one cheap probe: does this deployment have the R2 bucket bound?
  PUB.storage = async function storage() {
    if (_storage) return _storage;
    try {
      const r = await fetch("/api/publish?probe");
      const j = await r.json();
      _storage = (j && j.storage) === "r2" ? "r2" : "d1";
    } catch (_) { _storage = "d1"; }
    return _storage;
  };

  // ----- metadata ------------------------------------------------------
  // One row per book. Cheap, runs on connect for every title on the shelf.
  PUB.publishMeta = async function publishMeta(b, force) {
    const key = bk(b);
    const existing = readMap()[key];
    if (existing && !force) return existing;

    const rec = await api("create", {
      title: b.title || "Untitled",
      author: (b.meta && (b.meta.author || b.meta.authors)) || "",
      isbn: b.isbn || "",
      platform: b.platform || "",
      cover: coverOf(b),
      filename: "",
      pages: (b.meta && b.meta.count) || 0
    });
    remember(b, { id: rec.id, deleteKey: rec.deleteKey, hasPdf: false, storage: rec.storage });
    _storage = rec.storage || _storage;
    return readMap()[key];
  };

  function coverOf(b) {
    const list = Array.isArray(b.covers) && b.covers.length
      ? b.covers
      : (b.cover ? [b.cover] : (b.meta && b.meta.cover ? [b.meta.cover] : []));
    const https = list.filter((c) => typeof c === "string" && /^https:\/\//.test(c)).slice(0, 6);
    if (https.length > 1) return JSON.stringify(https);
    if (https.length === 1) return https[0];
    const c = list.find((x) => typeof x === "string" && /^data:image\//.test(x));
    if (c && c.length <= 220000) return c;
    return "";
  }

  // ----- PDF -----------------------------------------------------------
  PUB.publishPdf = async function publishPdf(b, bytes, filename, pages, onProgress) {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let rec = readMap()[bk(b)];
    if (!rec) rec = await PUB.publishMeta(b, true);
    if (!rec) return null;

    const store = await PUB.storage();
    if (store === "r2") await uploadR2(rec, buf, filename, pages, onProgress);
    else await uploadD1(rec, buf, pages, onProgress);

    const m = readMap();
    const cur = m[bk(b)] || rec;
    cur.hasPdf = true;
    if (filename) cur.filename = filename;
    if (pages) cur.pages = pages;
    m[bk(b)] = cur;
    writeMap(m);
    return cur;
  };

  async function uploadR2(rec, buf, filename, pages, onProgress) {
    const total = Math.ceil(buf.length / R2_PART) || 1;
    if (total > MAX_R2_PARTS) throw new Error("book is over 1 GB — too big for one catalog entry");

    for (let i = 0; i < total; i++) {
      const slice = buf.subarray(i * R2_PART, Math.min((i + 1) * R2_PART, buf.length));
      const res = await fetch("/api/publish?step=up&id=" + encodeURIComponent(rec.id) + "&idx=" + i, {
        method: "POST",
        headers: { "x-folio-key": rec.deleteKey, "content-type": "application/octet-stream" },
        body: slice
      });
      const out = await res.json().catch(() => ({ ok: false, error: "HTTP " + res.status }));
      if (!res.ok || !out.ok) throw new Error(out.error || ("part " + i + " failed (" + res.status + ")"));
      if (onProgress) onProgress(i + 1, total);
    }

    await api("upfin", {
      id: rec.id,
      deleteKey: rec.deleteKey,
      size: buf.length,
      chunks: total,
      pages: pages || 0,
      filename: filename || ""
    });
  }

  async function uploadD1(rec, buf, pages, onProgress) {
    const CHUNK = 192 * 1024;
    const total = Math.ceil(buf.length / CHUNK) || 1;

    for (let i = 0; i < total; i++) {
      const slice = buf.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, buf.length));
      await api("chunk", { id: rec.id, deleteKey: rec.deleteKey, idx: i, data: F.bytesToB64(slice) });
      if (onProgress) onProgress(i + 1, total);
    }

    await api("final", {
      id: rec.id,
      deleteKey: rec.deleteKey,
      size: buf.length,
      chunks: total,
      pages: pages || 0
    });
  }

  // ----- bulk ----------------------------------------------------------
  // Called after a successful connect: every new title gets a metadata row
  // so the catalog fills itself without the visitor doing anything else.
  PUB.autoPublish = async function autoPublish(books, onStep) {
    const list = books || [];
    let n = 0;
    for (const b of list) {
      try {
        const rec = await PUB.publishMeta(b);
        if (rec) { n++; if (onStep) onStep(n, list.length, b); }
      } catch (e) {
        if (onStep) onStep(n, list.length, b, e.message);
      }
    }
    return n;
  };
})();
