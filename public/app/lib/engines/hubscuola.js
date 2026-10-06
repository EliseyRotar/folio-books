// Folio engine — HUB Scuola / Young / Kids (Mondadori Education).
// Auth: email & password (JSONP login → internalLogin) OR session token.
// Download: publication.zip → SQLite chapter index → per-chapter zips →
// in-browser merge to a single PDF. Runs fully client-side; the CORS-open
// HUB API is fetched directly.

Folio.engines = Folio.engines || {};

Folio.engines.hubscuola = {
  id: "hubscuola",
  meta: {
    label: "HUB Scuola / Young / Kids",
    publisher: "Mondadori Education",
    country: "IT",
    status: "needs-testing",
    connectable: true,
    needsRelay: false,
    desc: "Two ways in — email & password, or a session token. Your library loads, any volume merges to a single PDF."
  },
  creds: [
    { k: "mode", type: "select", label: "Access mode", options: { "email-password": "Email & password", token: "Session token" } },
    { k: "email", type: "email", label: "Email", depends: "email-password" },
    { k: "password", type: "password", label: "Password", depends: "email-password" },
    { k: "token", type: "password", label: "Session token", depends: "token", hint: "Network → ms-api.hubscuola.it → Token-Session header" },
    { k: "platform", type: "select", label: "Platform", options: { young: "HUB Young", kids: "HUB Kids", scuola: "HUB Scuola" } }
  ],

  async connect(secrets, ctx) {
    const platform = secrets.platform || "young";
    let tok = "";

    if (secrets.mode === "email-password") {
      ctx.log("→ Mondadori login (bce.mondadorieducation.it)");
      const u = "https://bce.mondadorieducation.it/app/mondadorieducation/login/loginJsonp?username=" +
        encodeURIComponent(secrets.email) + "&password=" + encodeURIComponent(secrets.password);
      const res = await Folio.api(u, { headers: { Accept: "application/json" } });
      const body = await res.json();
      if (body.result && body.result !== "OK") {
        throw new Error((body.error || "login rejected") + (body.data && body.data.length ? " — " + body.data : ""));
      }
      const d = body.data || {};
      ctx.log("→ ms-api.hubscuola.it/user/internalLogin");
      const r2 = await (await Folio.api("https://ms-api.hubscuola.it/user/internalLogin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: d.username, sessionId: d.sessionId, jwt: d.hubEncryptedUser })
      })).json();
      if (!r2.tokenId) throw new Error("internalLogin did not return a tokenId");
      tok = r2.tokenId;
      ctx.ok("Authenticated — tokenId " + tok.slice(0, 12) + "…");
    } else {
      tok = (secrets.token || "").trim();
      if (!tok) throw new Error("Paste your session token.");
      ctx.ok("Using pasted session token.");
    }

    ctx.log("→ GET /getLibrary/" + platform);
    const lib = await (await Folio.api("https://ms-api.hubscuola.it/getLibrary/" + platform, {
      headers: { "Token-Session": tok, "Content-Type": "application/json" }
    })).json();

    const books = Folio.engines.hubscuola._extract(lib).map((b) => ({
      id: String(b.id),
      title: b.title,
      isbn: b.isbn || "",
      cover: Folio.engines.hubscuola._withToken(b.cover, tok)
    }));
    ctx.ok("Library loaded — " + books.length + " book(s).");

    return {
      account: {
        auth: secrets.mode === "email-password" ? "email-password" : "token",
        label: secrets.mode === "email-password" ? (secrets.email || "").trim() : "token " + tok.slice(0, 8) + "…",
        sub: platform.toUpperCase()
      },
      secrets: {
        mode: secrets.mode,
        email: secrets.mode === "email-password" ? (secrets.email || "").trim() : "",
        token: tok,
        platform
      },
      books
    };
  },

  _withToken(url, tok) {
    if (!url || !tok) return url;
    return url + (url.includes("?") ? "&" : "?") + "tokenId=" + encodeURIComponent(tok);
  },

  _extract(lib) {
    const out = [];
    let arr = lib;
    while (arr && typeof arr === "object" && !Array.isArray(arr)) {
      const keys = Object.keys(arr).filter((k) => Array.isArray(arr[k]));
      if (!keys.length) break;
      arr = arr[keys[0]];
    }
    for (const it of Array.isArray(arr) ? arr : []) {
      const rec = it.volume || it;
      const id = rec.volumeId || rec.id || rec.vid || it.volumeId || it.id || null;
      const title = it.title || rec.title || rec.coverTitle || null;
      const cover = it.coverBig || it.thumbnail || it.cover ||
        rec.coverBig || rec.thumbnail || rec.cover || rec.coverImage || null;
      const isbnRaw = rec.isbn || rec.isbn13 || rec.isbn_13 || it.isbn ||
        (rec.identifiers && (rec.identifiers.isbn13 || rec.identifiers.isbn)) || null;
      const isbn = isbnRaw ? String(isbnRaw).replace(/[^0-9Xx]/g, "") : "";
      if (id) out.push({ id: String(id), title: title || "Untitled", cover, isbn });
    }
    return out;
  },

  async download(book, s, ctx, onProgress) {
    const platform = s.platform;
    if (!s.token) throw new Error("No session saved for this account — reconnect it first.");
    const headers = { "Token-Session": s.token, "Content-Type": "application/json" };
    let title = book.title;

    await Folio.ensure({ sql: true, jszip: true, pdflib: true });

    try {
      const pub = await (await Folio.api("https://ms-api.hubscuola.it/me" + platform + "/publication/" + book.id, { headers })).json();
      if (pub && pub.title) title = pub.title;
    } catch (_) { /* fall back to library title */ }
    ctx.ok("Title: " + title);

    ctx.log("→ downloadPackage " + book.id + " /publication.zip");
    const pubRes = await Folio.api(
      "https://ms-mms.hubscuola.it/downloadPackage/" + book.id + "/publication.zip?tokenId=" + encodeURIComponent(s.token),
      { headers });
    if (!pubRes.ok) {
      throw new Error("publication.zip → HTTP " + pubRes.status +
        (pubRes.status === 401 || pubRes.status === 403
          ? " — session expired, reconnect this account." : ""));
    }
    const pubBuf = new Uint8Array(await pubRes.arrayBuffer());
    if (pubBuf.byteLength < 1000) throw new Error("publication.zip is only " + pubBuf.byteLength + " B — not a real package.");
    ctx.dim("publication.zip — " + Folio.fmtBytes(pubBuf.byteLength));

    const zip = await JSZip.loadAsync(pubBuf);
    const dbName = Object.keys(zip.files).find((n) => /publication\.db$/i.test(n)) ||
      Object.keys(zip.files).find((n) => /\.db$/i.test(n) && !zip.files[n].dir);
    if (!dbName) throw new Error("No SQLite index inside the package.");
    const dbBytes = await zip.file(dbName).async("uint8array");

    const db = new Folio.libs.sql.Database(dbBytes);
    const stmt = db.prepare("SELECT offline_value FROM offline_tbl WHERE offline_path=?");
    stmt.bind(["me" + platform + "/publication/" + book.id]);
    let row = null;
    while (stmt.step()) row = stmt.get();
    stmt.free();
    db.close();
    if (!row) throw new Error("No chapter index for this volume (try a different platform: young/kids/scuola).");
    const index = JSON.parse(row[0]);
    const chapters = (index.indexContents && index.indexContents.chapters) || [];
    if (!chapters.length) throw new Error("Chapter list is empty.");
    ctx.ok("Chapters: " + chapters.length);

    const parts = [];
    for (let ci = 0; ci < chapters.length; ci++) {
      const ch = chapters[ci];
      const chUrl = "https://ms-mms.hubscuola.it/public/" + book.id + "/" + encodeURIComponent(ch.chapterId) + ".zip?tokenId=" +
        encodeURIComponent(s.token) + "&app=v2";
      ctx.dim("chapter " + (ci + 1) + "/" + chapters.length);
      const chRes = await Folio.api(chUrl, { headers });
      if (!chRes.ok) throw new Error("chapter " + ch.chapterId + " → HTTP " + chRes.status);
      const chBuf = new Uint8Array(await chRes.arrayBuffer());
      const chZip = await JSZip.loadAsync(chBuf);
      const pdfs = Object.keys(chZip.files)
        .filter((n) => n.toLowerCase().endsWith(".pdf") && !chZip.files[n].dir)
        .sort();
      for (const name of pdfs) {
        parts.push({ bytes: await chZip.file(name).async("uint8array"), label: name });
      }
    }

    ctx.log("Merging " + parts.length + " page PDF(s)…");
    const { bytes, pages } = await Folio.pdf.merge(parts, { chunk: 100, onProgress });
    ctx.ok("Assembly complete — " + pages + " page(s), " + Folio.fmtBytes(bytes.byteLength));
    return { filename: Folio.sanitizeName(title) + ".pdf", bytes };
  }
};