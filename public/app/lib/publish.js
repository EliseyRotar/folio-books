// Folio Publisher — puts books on the public catalog.
//
// Design rules (the same ones the server enforces):
//   * only metadata travels on auto-publish: title, author, isbn, platform,
//     cover, page count. No account ids, no secrets, no device id.
//   * the PDF itself is uploaded only after YOU download the book, split into
//     ~192 KB base64 chunks so no single request is heavy.
//   * each publish gets a delete key kept in this browser — press "Unpublish"
//     on the catalog and it's gone, including every chunk.
//
// Everything here is fire-and-forget background work: the shelf stays usable
// while uploads run, and failures just log a line.

(function () {
  const F = Folio;
  const PUB = {};
  Folio.publish = PUB;

  const LS_KEY = "folio.published.v1";      // { "<platform>:<bookId>": { id, deleteKey, hasPdf } }
  const PUB_KEY = "folio.autopublish";      // "1" | "0"

  // ----- toggles & local index ---------------------------------------
  PUB.enabled = function enabled() {
    try { return localStorage.getItem(PUB_KEY) !== "0"; } catch (_) { return true; }
  };
  PUB.setEnabled = function setEnabled(v) {
    try { localStorage.setItem(PUB_KEY, v ? "1" : "0"); } catch (_) {}
  };

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

  PUB.forget = function forget(b) {
    const m = readMap();
    delete m[bk(b)];
    writeMap(m);
  };

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

  // ----- metadata ------------------------------------------------------
  // One row per book. Cheap, runs on connect for every title on the shelf.
  PUB.publishMeta = async function publishMeta(b, force) {
    if (!PUB.enabled()) return null;
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
    remember(b, { id: rec.id, deleteKey: rec.deleteKey, hasPdf: false });
    return readMap()[key];
  };

  function coverOf(b) {
    const c = b.cover || (b.meta && b.meta.cover) || "";
    if (!c) return "";
    if (/^https:\/\//.test(c)) return c;
    if (/^data:image\//.test(c)) return c.length <= 220000 ? c : "";
    return "";
  }

  // ----- PDF -----------------------------------------------------------
  // Uploads a finished PDF in ~192 KB chunks, then flips has_pdf.
  PUB.publishPdf = async function publishPdf(b, bytes, filename, pages) {
    if (!PUB.enabled()) return null;
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let rec = readMap()[bk(b)];
    if (!rec) rec = await PUB.publishMeta(b, true);
    if (!rec) return null;

    const CHUNK = 192 * 1024;
    const total = Math.ceil(buf.length / CHUNK) || 1;

    for (let i = 0; i < total; i++) {
      const slice = buf.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, buf.length));
      await api("chunk", { id: rec.id, deleteKey: rec.deleteKey, idx: i, data: toB64(slice) });
      if (typeof rec.onProgress === "function") rec.onProgress(i + 1, total);
    }

    await api("final", {
      id: rec.id,
      deleteKey: rec.deleteKey,
      size: buf.length,
      chunks: total,
      pages: pages || 0
    });

    const m = readMap();
    const cur = m[bk(b)] || rec;
    cur.hasPdf = true;
    if (filename) cur.filename = filename;
    if (pages) cur.pages = pages;
    m[bk(b)] = cur;
    writeMap(m);
    return cur;
  };

  PUB.unpublish = async function unpublish(b) {
    const rec = readMap()[bk(b)];
    if (!rec) return false;
    await api("delete", { id: rec.id, deleteKey: rec.deleteKey });
    PUB.forget(b);
    return true;
  };

  // ----- bulk ----------------------------------------------------------
  // Called after a successful connect: every new title gets a metadata row
  // so the catalog fills itself without the visitor doing anything else.
  PUB.autoPublish = async function autoPublish(books, onStep) {
    if (!PUB.enabled()) return 0;
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

  // ----- helpers -------------------------------------------------------
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function toB64(u8) {
    let out = "";
    const n = u8.length;
    for (let i = 0; i < n; i += 3) {
      const a = u8[i], b = i + 1 < n ? u8[i + 1] : 0, c = i + 2 < n ? u8[i + 2] : 0;
      out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)] +
             (i + 1 < n ? B64[((b & 15) << 2) | (c >> 6)] : "=") +
             (i + 2 < n ? B64[c & 63] : "=");
    }
    return out;
  }
  PUB.toB64 = toB64;
})();
