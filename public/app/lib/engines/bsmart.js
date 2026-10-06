// Folio engine — bSmart (EdAtlas / Deascuola / DigiBook24 / Pearson Italia).
//
// Ported 1:1 from tools/bSmart-downloader (the vendored, working CLI):
//
//   1. `_bsw_session_v1_production` cookie  ->  GET /api/v5/user
//      that response carries `auth_token`;
//   2. EVERY later call uses the `auth_token` header — not the cookie
//      (the cookie is only ever sent to /api/v5/user);
//   3. shelf  = /api/v6/books?page_thumb_size=medium&per_page=25000
//              + /api/v5/books/preactivations (merged, de-duped by id);
//   4. before downloading, the FRESH book info is fetched from
//      /api/v6/books/by_book_id/{id} — its current_edition.revision is the
//      one used in the resources URL (never trust the shelf's stale copy);
//   5. resources are paged, then `info.map(e => e.assets).flat()` and
//      filtered on `use == "page_pdf"` (NOT on `r.type`);
//   6. an asset is decrypted when `asset.encrypted !== false` — i.e. anything
//      except an explicit false means encrypted, exactly like the CLI;
//   7. the AES key is pulled out of the my.bsmart.it JS bundle;
//   8. each single-page PDF is copied into one output PDF.
//
// Everything runs in this tab. The cookie never leaves your device: it is
// only forwarded through the Folio relay straight to bSmart's own API.

Folio.engines = Folio.engines || {};

Folio.engines.bsmart = {
  id: "bsmart",
  meta: {
    label: "bSmart",
    publisher: "EdAtlas / Deascuola / DigiBook24 / Pearson Italia",
    country: "IT",
    status: "beta",
    connectable: true,
    needsRelay: true,
    desc: "Cookie-based: paste one session cookie, your shelf syncs, every page merges to a single PDF in this tab.",
    tutorial: [
      "Open <b>my.bsmart.it</b> (or your school’s own bSmart site) and log in as usual.",
      "Press <b>F12</b> → <b>Application</b> (Chrome/Edge) or <b>Storage</b> (Firefox) → <b>Cookies</b> → <code>my.bsmart.it</code>.",
      "Find the cookie <code>_bsw_session_v1_production</code>, double-click its <b>Value</b> and copy it.",
      "Paste it below. Leave the site selector on <b>bsmart.it</b> unless your school uses DigiBook24.",
      "Press <b>Connect</b> — your shelf appears, and <b>Download</b> rebuilds any book as one PDF right here."
    ]
  },
  creds: [
    {
      k: "site", type: "select", label: "Site",
      options: { bsmart: "bsmart.it (www.bsmart.it)", digibook24: "DigiBook24 (web.digibook24.com)", custom: "Custom base domain" },
      hint: "Picked automatically for most schools. Choose Custom only if your school runs its own domain."
    },
    { k: "base", type: "text", label: "Custom base domain", placeholder: "school.bsmart.it", depends: "custom", hint: "Used only when Site = Custom base domain.", autocomplete: "off" },
    { k: "cookie", type: "text", label: "Session cookie (_bsw_session_v1_production)", hint: "Follow the tutorial above — five steps, no extensions.", autocomplete: "off" }
  ],

  // per-cookie auth_token cache (in memory only, never saved to the Cabinet)
  _tokens: {},

  baseOf(s) {
    const custom = (s.base || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (s.site === "custom") return custom || "www.bsmart.it";
    if (s.site === "digibook24") return "web.digibook24.com";
    return "www.bsmart.it";
  },

  _cookieHeaders(s) {
    const v = (s.cookie || "").trim();
    if (!v) throw new Error("Missing session cookie — follow the bSmart tutorial above.");
    return { cookie: "_bsw_session_v1_production=" + v };
  },

  // step 1: cookie -> auth_token (cached; re-run on 401)
  async _auth(s) {
    const cacheKey = (s.cookie || "").trim();
    if (this._tokens[cacheKey]) return this._tokens[cacheKey];
    const base = this.baseOf(s);
    const res = await Folio.api("https://" + base + "/api/v5/user", { headers: this._cookieHeaders(s) }, { viaProxy: true });
    if (res.status !== 200) throw new Error("Cookie rejected (HTTP " + res.status + ") — grab a fresh _bsw_session_v1_production value and try again.");
    const me = await res.json().catch(() => null);
    if (!me || !me.auth_token) throw new Error("Cookie rejected — that value doesn’t look like a bSmart session.");
    this._tokens[cacheKey] = me.auth_token;
    return me.auth_token;
  },

  _headers(s) {
    const cacheKey = (s.cookie || "").trim();
    return { auth_token: this._tokens[cacheKey] || "" };
  },

  // step 2..n: everything with auth_token, one transparent refresh on 401
  async _req(url, s, retried) {
    let headers = this._headers(s);
    if (!headers.auth_token) await this._auth(s);
    headers = this._headers(s);
    const res = await Folio.api(url, { headers }, { viaProxy: true });
    if ((res.status === 401 || res.status === 403) && !retried) {
      delete this._tokens[(s.cookie || "").trim()];
      await this._auth(s);
      return this._req(url, s, true);
    }
    if (res.status !== 200) throw new Error("bSmart API " + res.status + " for " + shortUrl(url));
    return res;
  },

  async connect(secrets, ctx) {
    const s = Object.assign({}, secrets, { site: secrets.site || "bsmart" });
    const base = this.baseOf(s);

    ctx.log("→ " + base + "/api/v5/user");
    await this._auth(s);

    ctx.log("→ " + base + "/api/v6/books");
    const books = await (await this._req("https://" + base + "/api/v6/books?page_thumb_size=medium&per_page=25000", s)).json();

    // preactivations: school-provided titles that don't live in the library yet
    let pre = [];
    try {
      pre = await (await this._req("https://" + base + "/api/v5/books/preactivations", s)).json();
    } catch (_) { /* optional endpoint */ }

    const seen = new Set();
    const all = [];
    for (const b of (books || [])) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      all.push(b);
    }
    for (const p of (pre || [])) {
      if (p && p.no_bsmart === false) {
        for (const b of (p.books || [])) {
          if (!b || seen.has(b.id)) continue;
          seen.add(b.id);
          all.push(b);
        }
      }
    }

    const list = all.map((b) => ({
      id: String(b.id),
      title: b.title || b.name || "Untitled",
      cover: b.cover || b.thumb || b.image || "",
      isbn: b.isbn || b.ean || "",
      meta: {
        author: b.author || (b.authors && b.authors[0]) || "",
        revision: revOf(b.current_edition)
      }
    }));

    ctx.ok("Shelf loaded — " + list.length + " book(s).");
    return {
      account: { auth: "cookie", label: base, sub: all.length + " titles" },
      secrets: { site: s.site, base: s.site === "custom" ? base : "", cookie: (secrets.cookie || "").trim() },
      books: list
    };
  },

  // fresh book info -> the revision the resources endpoint actually wants
  async _bookInfo(b, s) {
    const info = await (await this._req("https://" + this.baseOf(s) + "/api/v6/books/by_book_id/" + encodeURIComponent(b.id), s)).json().catch(() => null);
    if (!info || !info.current_edition) throw new Error("bSmart doesn’t know this book id — reconnect to resync your shelf.");
    return info;
  },

  // paged resources -> flatten every group's assets -> page PDFs only
  async _pageAssets(info, s) {
    const base = this.baseOf(s);
    // revision 0 is a real value — never use `||` here (it turned revision
    // 0 books into ".../undefined/resources" and a hard 404).
    const rev = revOf(info.current_edition);
    if (rev === null) throw new Error("bSmart returned no edition revision for this book — reconnect to resync your shelf.");
    const groups = [];
    for (let page = 1; ; page++) {
      const part = await (await this._req(
        "https://" + base + "/api/v5/books/" + encodeURIComponent(info.id) + "/" + encodeURIComponent(rev) +
        "/resources?per_page=500&page=" + page, s)).json().catch(() => null);
      if (!Array.isArray(part)) break;
      groups.push(...part);
      if (part.length < 500) break;
    }
    const assets = groups.map((g) => (g && g.assets) || []).flat().filter(Boolean);
    return assets.filter((a) => a.use === "page_pdf" && a.url);
  },

  // AES key hidden in the my.bsmart.it bundle (same page the CLI uses)
  async _bundleKey() {
    const page = await (await Folio.api("https://my.bsmart.it/", { headers: { "user-agent": "Mozilla/5.0" } }, { viaProxy: true })).text();
    const scripts = [...page.matchAll(/<script[^>]+src="([^"]+\.js[^"]*)"[^>]*>/g)]
      .map((m) => m[1]).filter((src) => src.startsWith("/"));
    if (!scripts.length) throw new Error("bSmart bundle not found on my.bsmart.it — the site may have changed.");
    for (const src of scripts) {
      const text = await (await Folio.api("https://my.bsmart.it" + src, { headers: { "user-agent": "Mozilla/5.0" } }, { viaProxy: true })).text();
      const m = text.match(/var\s+([A-Za-z_$][\w$]*)=String\.fromCharCode\(([^)]*)\),([A-Za-z_$][\w$]*)=["']constructor["'];\3\[\3\]\[\3\]\((.*?)\)\(\)/s);
      if (!m) continue;
      const [, charVar, charCodes, , expression] = m;
      const source = charCodes.split(",").map((e) => String.fromCharCode(parseInt(e.trim(), 10)));
      const idxRe = new RegExp(charVar + "\\[(\\d+)\\]", "g");
      const snippet = [...expression.matchAll(idxRe)].map((x) => source[parseInt(x[1], 10)]).join("");
      const keyM = snippet.match(/['"]((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)['"]/);
      if (keyM) return Folio.b64ToBytes(keyM[1]);
    }
    throw new Error("Could not extract the bSmart encryption key from the current bundle.");
  },

  // msgpack header -> AES-CBC(256..start), 16-byte IV prefix, PKCS#7 unpad,
  // rest appended verbatim — identical to tools/bSmart-downloader/src/crypto.js
  async _decrypt(file, key) {
    try {
      const header = Folio.msgpack.decode(file, 0).v;
      const start = Number(header.start);
      if (!(start > 256 && start <= file.length)) throw new Error("bad msgpack header");
      const first = file.slice(256, start);
      const iv = first.slice(0, 16);
      const ct = first.slice(16);
      const k = await crypto.subtle.importKey("raw", key, { name: "AES-CBC" }, false, ["decrypt"]);
      const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv }, k, ct));
      const pad = pt[pt.length - 1];
      const un = (pad > 0 && pad <= 16 && pt.slice(pt.length - pad).every((x) => x === pad))
        ? pt.slice(0, pt.length - pad)
        : pt;
      const rest = file.slice(start);
      const out = new Uint8Array(un.length + rest.length);
      out.set(un); out.set(rest, un.length);
      return out;
    } catch (e) {
      throw new Error("page decrypt failed: " + (e.message || e));
    }
  },

  async download(book, s, ctx, onProgress) {
    const base = this.baseOf(s);

    ctx.log("→ book info (fresh revision)");
    const info = await this._bookInfo(book, s);

    ctx.log("→ page assets");
    const assets = await this._pageAssets(info, s);
    if (!assets.length) throw new Error("No page PDFs in this book — it may still be activating on bSmart.");

    // only pay for the key if at least one page is encrypted
    const needsKey = assets.some((a) => a.encrypted !== false);
    let key = null;
    if (needsKey) {
      ctx.log("→ extracting the bSmart key from the site bundle…");
      key = await this._bundleKey();
      ctx.ok("Key ready.");
    }

    await Folio.ensure({ pdflib: true });
    const parts = [];
    for (let i = 0; i < assets.length; i++) {
      const a = assets[i];
      const url = /^https?:\/\//.test(a.url) ? a.url : "https://" + base + a.url;
      if (onProgress) onProgress(i, assets.length);
      // gentle pacing — rapid sequential relay calls trip edge throttling
      if (i) await new Promise((r) => setTimeout(r, 220 + Math.random() * 200));
      // per-page retry: a relay burst that outlasts the built-in backoff
      // shouldn't sink the whole book — wait out the window and try again.
      let res = null;
      let pageErr = null;
      for (let t = 0; t < 3; t++) {
        if (t) {
          const wait = t * 15000;
          ctx.log("page " + (i + 1) + "/" + assets.length + ": " + pageErr + " — waiting " + (wait / 1000) + "s, retrying…");
          await new Promise((r) => setTimeout(r, wait));
        }
        try {
          // assets are fetched with no auth headers — same as the CLI
          res = await Folio.api(url, {}, { viaProxy: true });
          if (res.status >= 500) {
            pageErr = "upstream HTTP " + res.status;
            res = null;
            continue;
          }
          break;
        } catch (e) {
          if (/not allowed/i.test(e.message || "")) {
            throw new Error("Asset host “" + safeHost(url) + "” isn’t in the relay allowlist yet — add it to functions/api/proxy.js.");
          }
          const transient = /relay HTTP (5\d\d|429)|upstream HTTP 5\d\d|relay is unreachable/.test(e.message || "");
          if (!transient) throw e;
          pageErr = e.message || String(e);
          res = null;
        }
      }
      if (!res) throw new Error("Could not fetch page " + (i + 1) + " of " + assets.length + ": " + pageErr);
      if (res.status !== 200) throw new Error("Page " + (i + 1) + "/" + assets.length + " returned HTTP " + res.status);
      let file = new Uint8Array(await res.arrayBuffer());
      if (a.encrypted !== false) {
        if (!key) throw new Error("This page is encrypted but no key was extracted.");
        file = await this._decrypt(file, key);
      }
      parts.push({ bytes: file, label: String(a.filename || a.id || i) });
    }
    if (onProgress) onProgress(assets.length, assets.length);

    ctx.log("Merging " + parts.length + " page PDF(s)…");
    const { bytes, pages } = await Folio.pdf.merge(parts, { chunk: 40 });
    const title = info.title || book.title || "bSmart book";
    ctx.ok("Assembly complete — " + pages + " page(s), " + Folio.fmtBytes(bytes.byteLength));
    return { filename: Folio.sanitizeName(title) + ".pdf", bytes, pages };
  }
};

function shortUrl(u) {
  try { const x = new URL(u); return x.hostname + x.pathname; } catch (_) { return u; }
}
function safeHost(u) {
  try { return new URL(u).hostname; } catch (_) { return "unknown"; }
}
// `revision: 0` is valid — resolve with nullish checks, never `||`.
function revOf(ed) {
  if (!ed) return null;
  if (ed.revision !== undefined && ed.revision !== null) return ed.revision;
  if (ed.id !== undefined && ed.id !== null) return ed.id;
  return null;
}
