// Folio Desktop — the reading-room dashboard.
// Wires three layers together: the plaintext Cabinet (accounts, tokens,
// credentials, shelf — no Cabinet, no encryption, no passphrase), the
// per-platform engines, and the shelf UI.

(function () {
  const F = Folio;
  const C = Folio.cabinet;
  const ENG = Folio.engines || {};

  const $ = (id) => document.getElementById(id);
  const newId = () => "a_" + (crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : String(Math.random()).slice(2, 10));

  const ctx = {
    log: (t, c) => F.log(t, c),
    ok: (t) => F.log(t, "ok"),
    err: (t) => F.log(t, "err"),
    dim: (t) => F.log(t, "dim")
  };

    function deskView() { return $("desk"); }

  // ----- views ------------------------------------------------------
  function enterView(kind) {
    deskView().style.display = "";
  }

  // ----- profile / sync chip ----------------------------------------
  function renderTop() {
    const d = C.data();
    $("profile-name").textContent = d.profile.name ? d.profile.name : "Your Cabinet";
    refreshSync();
  }

  function refreshSync() {
    const chip = $("sync-chip");
    const m = {
      synced: ["green", "synced · plaintext cloud backup"],
      local: ["ink", "local only — set up Cloudflare Pages to sync"],
      "cloud-available": ["blue", "cloud has a newer copy — restore"]
    };
    const [cls, txt] = m[C.syncState()] || ["ink", "…"];
    chip.textContent = txt;
    chip.className = "chip " + cls;
    $("sync-live").style.display = C.syncState() === "synced" ? "" : "none";
  }

  // ----- accounts ----------------------------------------------------
  function accountRow(a) {
    const eng = ENG[a.platform];
    const label = eng ? eng.meta.label : a.platform;
    const dl = document.createElement("div");
    dl.className = "accrow";
    dl.innerHTML =
      `<div class="acc-main"><b>${F.esc(label)}</b>
         <span class="small muted">${F.esc(a.sub || "")}</span></div>
       <div class="acc-side">
         <span class="badge badge-ok">${F.esc(a.auth)}</span>
         <button class="btn btn-sm" data-rm="${a.id}">Forget</button>
       </div>`;
    dl.querySelector("[data-rm]").addEventListener("click", () => {
      if (!confirm("Remove this account and erase its saved credentials from your Cabinet?")) return;
      C.mutate((d) => {
        d.accounts = d.accounts.filter((x) => x.id !== a.id);
        delete d.secrets[a.id];
        d.books = d.books.filter((b) => b.accountId !== a.id);
      });
      renderAll();
    });
    return dl;
  }

  function renderAccounts() {
    const el = $("accounts");
    el.innerHTML = "";
    const d = C.data();
    if (!d.accounts.length) {
      el.innerHTML = `<p class="small muted">No accounts yet — connect a platform below. Credentials are sealed into your plaintext Cabinet on this device.</p>`;
      return;
    }
    for (const a of d.accounts) el.appendChild(accountRow(a));
  }

  // ----- shelf -------------------------------------------------------
  function coverTag(b) {
    if (b.cover) {
      return `<img src="${F.esc(b.cover)}" alt="" loading="lazy">`;
    }
    return `<div class="cover-ph" aria-hidden="true">${F.esc(initials(b.title))}</div>`;
  }

  function swapCover(img, b) {
    const ph = document.createElement("div");
    ph.className = "cover-ph";
    ph.setAttribute("aria-hidden", "true");
    ph.textContent = initials(b.title);
    img.replaceWith(ph);
  }

  function initials(t) {
    const w = String(t || "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
    return w.map((x) => x[0]).join("").toUpperCase() || "?";
  }

  function bookRow(b) {
    const eng = ENG[b.platform];
    const pub = Folio.publish && Folio.publish.entryFor(b);
    const el = document.createElement("div");
    el.className = "bookrow shelf-row";
    el.innerHTML =
      coverTag(b) +
      `<div class="meta"><h4>${F.esc(b.title)}</h4>` +
      `<div class="isbn">${eng ? eng.meta.label : b.platform}${b.isbn ? " · " + F.esc(b.isbn) : ""}</div>` +
      `<div class="post">${b.meta && b.meta.count ? b.meta.count + " pages" : "in-browser"}` +
      (pub ? ` · <a href="read.html?id=${encodeURIComponent(pub.id)}" target="_blank" rel="noopener">in catalog</a>` : "") +
      `</div></div>` +
      `<div class="book-actions"><button class="btn btn-sm btn-primary" data-dl="${b.id}" data-platform="${b.platform}">Download</button>` +
      `<button class="btn btn-sm data-rmbk" data-rm="${b.id}">Remove</button></div>`;
    el.querySelector("[data-dl]").addEventListener("click", () => doDownload(b));
    const img = el.querySelector("img");
    if (img) img.addEventListener("error", () => swapCover(img, b));
    el.querySelector("[data-rm]").addEventListener("click", () => {
      C.mutate((d) => { d.books = d.books.filter((x) => x !== b); });
      renderAll();
    });
    return el;
  }

  function renderShelf() {
    const el = $("shelf");
    el.innerHTML = "";
    const d = C.data();
    const books = d.books || [];
    const hasDiBooK = !!(ENG.dibook && (d.accounts || []).some((a) => a.platform === "dibook"));
    $("isbn-form").style.display = hasDiBooK ? "" : "none";
    if (!books.length) {
      el.innerHTML = `<p class="small muted">Your shelf is empty. Connect an account, then pick a book to download — it merges right here in the tab.</p>`;
      return;
    }
    for (const b of books) el.appendChild(bookRow(b));
  }

  // ----- connect form ------------------------------------------------
  const engSelect = () => $("platform");
  function connectable() {
    return Object.keys(ENG).filter((k) => ENG[k].meta && ENG[k].meta.connectable);
  }

  function renderPlatformChoices() {
    const sel = engSelect();
    sel.innerHTML = "";
    const keys = connectable();
    for (const k of keys) {
      const o = document.createElement("option");
      o.value = k;
      o.textContent = ENG[k].meta.label + (ENG[k].meta.status === "beta" ? "  (beta)" : "");
      sel.appendChild(o);
    }
    if (keys.length) renderCredFields();
  }

  function renderCredFields() {
    const eng = ENG[engSelect().value];
    const host = $("cred-fields");
    host.innerHTML = "";
    if (!eng) return;
    for (const c of eng.creds || []) {
      const wrap = document.createElement("div");
      wrap.className = "field";
      const f = document.createElement(c.type === "select" ? "select" : "input");
      const label = document.createElement("label");
      label.textContent = c.label;
      wrap.appendChild(label);
      if (c.type === "select") {
        f.className = "mono";
        for (const [k, v] of Object.entries(c.options || {})) {
          const o = document.createElement("option");
          o.value = k; o.textContent = v;
          f.appendChild(o);
        }
      } else {
        f.type = c.type;
        f.placeholder = c.placeholder || "";
        f.autocomplete = "off";
        if (c.type === "email") f.autocomplete = "email";
      }
      f.dataset.k = c.k;
      f.dataset.depends = c.depends || "";
      f.id = "cf-" + c.k;
      wrap.appendChild(f);
      if (c.hint) {
        const h = document.createElement("div");
        h.className = "hint";
        h.textContent = c.hint;
        wrap.appendChild(h);
      }
      host.appendChild(wrap);
    }
    applyCredVisibility();
  }

  function applyCredVisibility() {
    const modeSel = document.querySelector('#cred-fields [data-k="mode"]');
    if (!modeSel) return;
    document.querySelectorAll("#cred-fields [data-depends]").forEach((s) => {
      const field = s.closest(".field");
      if (!field) return;
      if (!s.dataset.depends) { field.style.display = ""; return; }
      field.style.display = s.dataset.depends === modeSel.value ? "" : "none";
    });
  }

  function gatherSecrets() {
    const out = {};
    document.querySelectorAll("#cred-fields [data-k]").forEach((f) => {
      out[f.dataset.k] = f.value;
    });
    return out;
  }

  async function onConnect() {
    const key = engSelect().value;
    const eng = ENG[key];
    if (!eng) return;
    const secrets = gatherSecrets();
    const btn = $("connect-btn");
    btn.disabled = true;
    btn.textContent = "Connecting…";
    F.log("Folio · " + eng.meta.label, "dim");
    try {
      const { account, secrets: stored, books } = await eng.connect(secrets, ctx);
      const accId = newId();
      C.mutate((d) => {
        d.accounts.push(Object.assign({ id: accId, platform: key, addedAt: Date.now() }, account));
        d.secrets[accId] = stored;
        for (const b of books) {
          d.books.push({ id: b.id, platform: key, accountId: accId, title: b.title, cover: b.cover || "", isbn: b.isbn || "", meta: b.meta || {}, addedAt: Date.now() });
        }
      });
      // Cover fallback: fill in any book the engine shipped without a cover.
      for (const b of books) {
        if (b.cover) continue;
        const row = C.data().books.find((x) => x.id === b.id && x.platform === key);
        if (!row) continue;
        const cover = await C.coverIsbn(b.isbn);
        if (cover) C.mutate((d) => { const r = d.books.find((x) => x.id === b.id && x.platform === key); if (r) r.cover = cover; });
      }
      F.ok("Saved to your Cabinet. " + books.length + " book(s) on the shelf.");
      renderAll();
      C.sync("push");
      autoPublish(books);
    } catch (e) {
      F.err(e.message);
    }
    btn.disabled = false;
    btn.textContent = "Connect";
  }

  // ----- catalog publishing -------------------------------------------
  // Metadata-only rows are posted in the background the moment a shelf
  // lands; the PDF joins the catalog only after you download it yourself.
  async function autoPublish(books) {
    if (!Folio.publish || !Folio.publish.enabled()) return;
    const fresh = books.filter((b) => !Folio.publish.entryFor(b));
    if (!fresh.length) return;
    F.dim("Publishing " + fresh.length + " title(s) to the public catalog…");
    try {
      const n = await Folio.publish.autoPublish(fresh, (done, total, b, err) => {
        if (err) { F.log("catalog: " + (b && b.title ? "“" + b.title + "” " : "") + err, "err"); return; }
        if (done === total) F.ok("Catalog: " + done + " title(s) published (metadata only — PDFs join after you download).");
      });
      if (n) renderShelf();
    } catch (e) {
      F.log("catalog: " + e.message, "err");
    }
  }

  async function publishPdf(b, bytes, filename, pages) {
    if (!Folio.publish || !Folio.publish.enabled()) return;
    const size = bytes.byteLength || bytes.length || 0;
    F.dim("Catalog: uploading " + filename + " (" + F.fmtBytes(size) + ")…");
    try {
      await Folio.publish.publishPdf(b, bytes, filename, pages);
      F.ok("Catalog: “" + b.title + "” is now readable in the browser.");
      renderShelf();
    } catch (e) {
      F.log("catalog upload failed: " + e.message, "err");
    }
  }

  function bindPublishToggle() {
    const box = $("autopublish");
    if (!box) return;
    box.checked = Folio.publish ? Folio.publish.enabled() : true;
    box.addEventListener("change", () => {
      if (Folio.publish) Folio.publish.setEnabled(box.checked);
      F.log(box.checked
        ? "Auto-publish on — new shelves and downloaded PDFs go to the public catalog."
        : "Auto-publish off — nothing new leaves this device.", "dim");
    });
  }

  // ----- tutorial ------------------------------------------------------
  function renderTutorial() {
    const host = $("tutorial");
    if (!host) return;
    const eng = ENG[engSelect().value];
    const steps = (eng && eng.meta && eng.meta.tutorial) || [];
    if (!steps.length) { host.style.display = "none"; host.innerHTML = ""; return; }
    host.style.display = "";
    host.innerHTML =
      `<h3>How to connect ${F.esc(eng.meta.label)} <span class="small muted">(5 steps)</span></h3>` +
      `<ol class="steps">` +
      steps.map((t) => `<li>${t}</li>`).join("") +
      `</ol>`;
  }

  // ----- add by ISBN (engines without an index endpoint) --------------
  function bindIsbn() {
    $("isbn-go").addEventListener("click", async () => {
      const isbn = $("isbn").value.trim();
      if (!isbn) return;
      const eng = ENG.dibook;
      const acc = C.data().accounts.find((a) => a.platform === "dibook");
      if (!acc) { F.err("Connect a DiBooK account first."); return; }
      try {
        const book = await eng.addBook(C.data().secrets[acc.id], isbn, ctx);
        C.mutate((d) => { d.books.push({ id: book.id, platform: "dibook", accountId: acc.id, title: book.title, cover: "", isbn: book.isbn, meta: { count: book.count }, addedAt: Date.now() }); });
        const cover = await C.coverIsbn(book.isbn);
        if (cover) C.mutate((d) => { const r = d.books.find((x) => x.id === book.id && x.platform === "dibook"); if (r) r.cover = cover; });
        F.ok("“" + book.title + "” added to the shelf.");
        renderShelf();
      } catch (e) { F.err(e.message); }
    });
  }

  // ----- download ----------------------------------------------------
  let downloading = false;
  async function doDownload(b) {
    if (downloading) return;
    downloading = true;
    renderShelf();
    const eng = ENG[b.platform];
    const acc = (C.data().accounts || []).find((a) => a.id === b.accountId);
    if (!acc) { F.err("Account for this book is gone — reconnect it."); downloading = false; return; }
    const secrets = C.data().secrets[acc.id];
    const btn = document.querySelector(`[data-dl][data-platform="${b.platform}"]`);
    if (btn) { btn.disabled = true; btn.textContent = "Working…"; }
    F.log("Folio · downloading “" + b.title + "”", "dim");
    try {
      const onProgress = (cur, tot) => { if (btn) btn.textContent = "page " + cur + "/" + tot; };
      const { filename, blob, bytes, pages } = await eng.download(b, secrets, ctx, onProgress);
      const out = blob || (bytes ? new Blob([bytes], { type: "application/pdf" }) : null);
      if (!out) throw new Error("download produced nothing");
      F.saveBlob(out, filename);
      F.ok("Saved " + filename);
      if (bytes) publishPdf(b, bytes, filename, pages || (b.meta && b.meta.count) || 0);
    } catch (e) {
      F.err(e.message);
      if (eng.meta.needsRelay && !(await Folio.relayAvailable().catch(() => false))) {
        F.dim("Hint: this platform needs the Folio relay. Deploy to Cloudflare Pages and it works from the same button.");
      }
    }
    if (btn) { btn.disabled = false; btn.textContent = "Download"; }
    downloading = false;
  }

  // ----- Cabinet actions -----------------------------------------------
  // No Cabinet, no lock, no gate — the Cabinet is a plaintext store that is
  // already open. No gate handlers remain: the desk boots straight in.

  // ----- boot --------------------------------------------------------
  function renderAll() {
    renderTop();
    renderAccounts();
    renderShelf();
    refreshSync();
  }

  function init() {
    F.bindLog($("log"));
    $("connect-btn").addEventListener("click", onConnect);
    engSelect().addEventListener("change", () => { renderCredFields(); renderTutorial(); });
    $("cred-fields").addEventListener("change", (e) => { if (e.target.dataset.k === "mode") applyCredVisibility(); });
    bindIsbn();
    bindPublishToggle();
    renderPlatformChoices();
    renderTutorial();

    // Cabinet is plaintext and always open — no Cabinet, no gate, no lock.
    enterView("desk");
    renderAll();
    C.sync("push").then(refreshSync);
  }

  document.addEventListener("DOMContentLoaded", init);
})();