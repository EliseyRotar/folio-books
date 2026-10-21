// Folio engine — MyLim (Loescher).
// Auth: JWT from Local Storage. Books are already clean PDFs with real
// tables of contents — search, hide the demos, download. Direct CORS-open
// API, fully client-side.

Folio.engines = Folio.engines || {};

Folio.engines.mylim = {
  id: "mylim",
  meta: {
    label: "MyLim",
    publisher: "Loescher",
    country: "IT",
    status: "needs-testing",
    connectable: true,
    needsRelay: false,
    desc: "Paste your MyLim JWT. Your books are served as ready-made PDFs with real tables of contents."
  },
  creds: [
    { k: "token", type: "password", label: "JWT", hint: "Application → Local Storage → https://mylim.loescher.it → token" }
  ],

  async connect(secrets, ctx) {
    const tok = (secrets.token || "").trim();
    if (!tok) throw new Error("Paste your JWT first.");
    ctx.log("→ GET /mialim2/api/v1/book/sommari/");
    const booksRaw = await (await Folio.api("https://loeda.loescher.it/mialim2/api/v1/book/sommari/", {
      headers: { Authorization: "JWT " + tok }
    })).json();

    const books = [];
    for (const b of booksRaw || []) {
      const o = b.opera || {};
      if (!o.isbn) continue;
      books.push({ id: String(o.isbn), title: o.nome || "Untitled", cover: o.copertina || "", isbn: o.isbn, meta: { isDemo: b.tipologia === "d" } });
    }
    ctx.ok("Shelf loaded — " + books.length + " entrie(s).");

    return {
      account: { auth: "token", label: "token " + tok.slice(0, 8) + "…", sub: "mialim" },
      secrets: { token: tok },
      books
    };
  },

  async download(book, s, ctx) {
    ctx.dim("→ " + book.title + " (" + book.id + ")");
    const info = await (await Folio.api("https://loeda.loescher.it/mialim2/api/v1/book/pdf/" + book.id + "/", {
      headers: { Authorization: "JWT " + s.token }
    })).json();
    if (!info.url) throw new Error("No PDF url returned.");
    ctx.log("→ fetching " + info.url);
    const res = await Folio.api(info.url, { headers: { Authorization: "JWT " + s.token } });
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { filename: Folio.sanitizeName(book.title) + ".pdf", bytes };
  }
};