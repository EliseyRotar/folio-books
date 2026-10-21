// Folio engine — Educadhoc (Hachette Livre · exobank.hachette-livre.fr).
//
// Ported from the vendored CLI tools/educadhoc-downloader/index.js, which
// uses the ExoBank authorize→token dance with a fixed shared client secret.
// Because ExoBank requires a browser session (CORS + page rendering for the
// FXL volumes), this engine talks through the Folio relay so the challenge
// stays Greenix-served and credentials never leave the tab.
//
// Auth: email/password (username + password via exoauth/authorize).
// Covers: ISBN → Config.coverIsbn (Open Library → Google Books → nothing).
// Books live as plaintext rows in your Cabinet. Always open. By design.
//
// Fixed-layout volumes assemble page-by-page with pdf-lib in the tab:
// image/jpeg pages become embedded-JPEG PDF pages, application/pdf pages
// are copied in, and application/xhtml+xml pages (which the CLI rendered
// with a real browser) are skipped with a warning.

window.Folio = window.Folio || {};
Folio.engines = Folio.engines || {};

const EX_OAUTH = "https://exobank.hachette-livre.fr/api/exoauth";
const EX_BANK = "https://exobank.hachette-livre.fr/api/bankdata";
const EX_READER = `${EX_OAUTH}/authorize`;

Folio.engines.educadhoc = {
  id: "educadhoc",
  meta: {
    label: "Educadhoc",
    publisher: "Hachette Livre",
    country: "IT+FR",
    status: "needs-testing",
    connectable: true,
    needsRelay: true, // exobank is CORS-locked to browsers behind the relay
    desc: "Email & password for Hachette ExoBank. Fixed-layout volumes assemble page-by-page in the browser."
  },

  creds: [
    { k: "email", label: "Email", type: "email", placeholder: "you@school.edu" },
    { k: "password", label: "Password", type: "password", placeholder: "••••••••" },
  ],

  async connect(secrets, ctx) {
    const { log } = ctx;
    const email = (secrets.email || "").trim();
    const password = secrets.password || "";
    if (!email || !password) throw new Error("Educadhoc needs your email and password.");

    log("Educadhoc · exchanging credentials for a session…", "dim");
    const auth = await F.api(`${EX_READER}`, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Basic a2V5MTIzOnNlY3JldDEyMw==" }, body: JSON.stringify({ user: email, password, authMethod: "pne", appId: "" }) }, { viaProxy: true });
    const authJson = await auth.json();
    if (!authJson || !authJson.data || !authJson.data.authToken) {
      const apiMsg = (typeof authJson.error === "string" && authJson.error) ||
        (authJson.error && authJson.error.message) || "";
      throw new Error(apiMsg || "Educadhoc rejected those credentials.");
    }

    const token = await F.api(`${EX_OAUTH}/token`, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Basic a2V5MTIzOnNlY3JldDEyMw==" }, body: JSON.stringify({ authToken: authJson.data.authToken }) }, { viaProxy: true }).then((r) => r.json());
    const userToken = token && token.data && token.data.userToken;
    if (!userToken) throw new Error("Educadhoc exchanged credentials but returned no session token.");

    log("Educadhoc · connected as " + ((token.data.userId && (token.data.userId.firstname + " " + token.data.userId.lastname)) || email), "ok");

    const books = [];
    if (token.data && token.data.books && token.data.books.length) {
      for (const b of token.data.books) {
        const ean = b.ean || b.isbn || b.EAN || "";
        const bank = await F.api(`${EX_BANK}/bank?ean=${encodeURIComponent(ean)}`, { headers: { Authorization: "Bearer " + userToken } }, { viaProxy: true }).then((r) => r.json());
        if (bank && bank.data && bank.data.length) {
          const bankId = bank.data[0]._id;
          const sum = await F.api(`${EX_BANK}/summary?bankId=${encodeURIComponent(bankId)}`, { headers: { Authorization: "Bearer " + userToken } }, { viaProxy: true }).then((r) => r.json());
          const pages = (sum && sum.data && sum.data.find((s) => s.section === "spine-fxl") && sum.data.find((s) => s.section === "spine-fxl").children) || [];
          books.push({ id: ean, title: b.name || b.title || "Educadhoc volume", cover: "", isbn: ean, meta: { author: b.author || "" }, count: pages.length });
        }
      }
    }
    if (!books.length) throw new Error("Educadhoc connected but the relay returned no volumes (log in on https://biblio.hachette-livre.fr first).");

    return {
      account: { email, label: "Educadhoc · " + email },
      secrets: { token: userToken, email },
      books,
    };
  },

  async addBook(secrets, ean, ctx) {
    const { log } = ctx;
    const bank = await F.api(`${EX_BANK}/bank?ean=${encodeURIComponent(ean)}`, { headers: { Authorization: "Bearer " + secrets.token } }, { viaProxy: true }).then((r) => r.json());
    if (!bank || !bank.data || !bank.data.length) throw new Error("No Educadhoc volume for ISBN/EAN " + ean);
    const bankId = bank.data[0]._id;
    const sum = await F.api(`${EX_BANK}/summary?bankId=${encodeURIComponent(bankId)}`, { headers: { Authorization: "Bearer " + secrets.token } }, { viaProxy: true }).then((r) => r.json());
    const pages = (sum && sum.data && sum.data.find((s) => s.section === "spine-fxl") && sum.data.find((s) => s.section === "spine-fxl").children) || [];
    const title = (bank.data[0] && (bank.data[0].name || bank.data[0].title)) || "Educadhoc volume " + ean;
    log("Educadhoc · located “" + title + "” (" + pages.length + " FXL pages).", "dim");
    return { id: ean, title, cover: "", isbn: ean, meta: { author: (bank.data[0] && bank.data[0].author) || "" }, count: pages.length };
  },

  async download(book, secrets, ctx, onProgress) {
    const { log, err } = ctx;
    const acc = (Folio.cabinet.data().accounts || []).find((a) => a.id === book.accountId);
    if (!acc) throw new Error("The Educadhoc account behind this book is gone — reconnect it.");
    const userToken = (secrets && secrets.token) ||
      (Folio.cabinet.data().secrets[acc.id] || {}).token;
    if (!userToken) throw new Error("No Educadhoc session for this account — reconnect.");

    log("Educadhoc · preparing “" + book.title + "”…", "dim");
    const sum = await F.api(`${EX_BANK}/summary?bankId=${encodeURIComponent(book.isbn)}`, { headers: { Authorization: "Bearer " + userToken } }, { viaProxy: true }).then((r) => r.json());
    const pages = (sum && sum.data && sum.data.find((s) => s.section === "spine-fxl") && sum.data.find((s) => s.section === "spine-fxl").children) || [];
    if (!pages.length) throw new Error("Educadhoc returned no FXL pages for this volume.");

    await Folio.ensure({ pdflib: true });
    const PDF = window.PDFLib.PDFDocument;
    const out = await PDF.create();
    let made = 0;

    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const type = ((p.metaData || []).find((d) => d.key === "type") || {}).value || "";
      const pageUrl = "https://exobank.hachette-livre.fr/" + (p.link && p.link.content);
      if (type === "image/jpeg") {
        const data = await F.api(pageUrl, { viaProxy: true }).then((r) => r.arrayBuffer());
        const img = await out.embedJpg(data);
        const pg = out.addPage([img.width, img.height]);
        pg.drawImage(img, { x: 0, y: 0 });
        made++;
      } else if (type === "application/xhtml+xml") {
        err("Educadhoc · text page " + (i + 1) + "/" + pages.length + " (XHTML) — can’t render in the browser, skipped.");
      } else if (type === "application/pdf") {
        const buf = await F.api(pageUrl, { viaProxy: true }).then((r) => r.arrayBuffer());
        const src = await PDF.load(new Uint8Array(buf), { updateMetadata: false });
        const copied = await out.copyPages(src, src.getPageIndices());
        copied.forEach((c) => out.addPage(c));
        made += copied.length;
      } else {
        err("Educadhoc · unknown page type " + type + " (page " + (i + 1) + ") — skipped.");
      }
      if (onProgress) onProgress(i + 1, pages.length);
    }
    if (!made) throw new Error("Educadhoc produced no renderable pages.");

    const bytes = await out.save({ useObjectStreams: false });
    log("Educadhoc · assembled " + made + " page(s).", "ok");
    return { filename: Folio.sanitizeName(book.title) + ".pdf", bytes, pages: made };
  }
};
