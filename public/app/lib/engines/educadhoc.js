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

window.Folio = window.Folio || {};
Folio.engines = Folio.engines || {};

const EX_OAUTH = "https://exobank.hachette-livre.fr/api/exoauth";
const EX_BANK = "https://exobank.hachette-livre.fr/api/bankdata";

const helper = (Folio.engines.__educadhoc || (Folio.engines.__educadhoc = {}));
const EX_READER = `${EX_OAUTH}/authorize`;

helper.meta = {
  key: "educadhoc",
  label: "Educadhoc",
  publisher: "Hachette Livre",
  platform: "IT+FR",
  status: "needs-testing",
  connectable: true,
  needsRelay: true, // exobank is CORS-locked to browsers behind the relay
};

helper.creds = [
  { k: "email", label: "Email", type: "email", placeholder: "you@school.edu" },
  { k: "password", label: "Password", type: "password", placeholder: "••••••••" },
];

helper.connect = async function connect(secrets, ctx) {
  const { log, err } = ctx;
  const email = (secrets.email || "").trim();
  const password = secrets.password || "";
  if (!email || !password) throw new Error("Educadhoc needs your email and password.");

  log("Educadhoc · exchanging credentials for a session…", "dim");
  const auth = await F.api(`${EX_READER}`, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Basic a2V5MTIzOnNlY3JldDEyMw==" }, body: JSON.stringify({ user: email, password, authMethod: "pne", appId: "" }) }, { viaProxy: true });
  const authJson = await auth.json();
  if (!authJson || !authJson.data || !authJson.data.authToken) throw new Error((authJson.error && authJson.error.message) || "Educadhoc rejected those credentials.");

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
};

helper.addBook = async function addBook(secrets, ean, ctx) {
  const { log } = ctx;
  const bank = await F.api(`${EX_BANK}/bank?ean=${encodeURIComponent(ean)}`, { headers: { Authorization: "Bearer " + secrets.token } }, { viaProxy: true }).then((r) => r.json());
  if (!bank || !bank.data || !bank.data.length) throw new Error("No Educadhoc volume for ISBN/EAN " + ean);
  const bankId = bank.data[0]._id;
  const sum = await F.api(`${EX_BANK}/summary?bankId=${encodeURIComponent(bankId)}`, { headers: { Authorization: "Bearer " + secrets.token } }, { viaProxy: true }).then((r) => r.json());
  const pages = (sum && sum.data && sum.data.find((s) => s.section === "spine-fxl") && sum.data.find((s) => s.section === "spine-fxl").children) || [];
  const title = (bank.data[0] && (bank.data[0].name || bank.data[0].title)) || "Educadhoc volume " + ean;
  log("Educadhoc · located “" + title + "” (" + pages.length + " FXL pages).", "dim");
  return { id: ean, title, cover: "", isbn: ean, meta: { author: (bank.data[0] && bank.data[0].author) || "" }, count: pages.length };
};

helper.download = async function download(book, secrets, ctx, onProgress) {
  const { log, err } = ctx;
  const eng = Folio.engines[book.platform];
  const acc = (Folio.cabinet.data().accounts || []).find((a) => a.id === book.accountId);
  if (!acc) throw new Error("The Educadhoc account behind this book is gone — reconnect it.");
  const userToken = (Folio.cabinet.data().secrets[acc.id] || {}).token;
  if (!userToken) throw new Error("No Educadhoc session for this account — reconnect.");

  log("Educadhoc · preparing “" + book.title + "”…", "dim");
  const sum = await F.api(`${EX_BANK}/summary?bankId=${encodeURIComponent(book.isbn)}`, { headers: { Authorization: "Bearer " + userToken } }, { viaProxy: true }).then((r) => r.json());
  const pages = (sum && sum.data && sum.data.find((s) => s.section === "spine-fxl") && sum.data.find((s) => s.section === "spine-fxl").children) || [];
  if (!pages.length) throw new Error("Educadhoc returned no FXL pages for this volume.");

  const parts = [];
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const type = (p.metaData || []).find((d) => d.key === "type");
    const typeV = (type && type.value) || "";
    if (typeV === "image/jpeg") {
      const img = await F.api("https://exobank.hachette-livre.fr/" + (p.link && p.link.content), { viaProxy: true }).then((r) => r.blob());
      parts.push(img);
    } else if (typeV === "application/xhtml+xml") {
      const html = await F.api("https://exobank.hachette-livre.fr/" + (p.link && p.link.content), { viaProxy: true }).then((r) => r.text());
      parts.push(html);
    } else if (typeV === "application/pdf") {
      const pdf = await F.api("https://exobank.hachette-livre.fr/" + (p.link && p.link.content), { viaProxy: true }).then((r) => r.blob());
      parts.push(pdf);
    } else {
      err("Educadhoc · unknown page type " + typeV + " (page " + (i + 1) + ") — skipped.");
      continue;
    }
    if (onProgress) onProgress(i + 1, pages.length);
  }
  if (!parts.length) throw new Error("Educadhoc produced no renderable pages.");

  const { filename, blob } = await Folio.renderer.assemble({ title: book.title, parts }, ctx);
  return { filename, blob };
};
