// Folio Desktop — the reading-room wizard.
// Three steps: Connect → Shelf → Download. Wires together the plaintext
// Cabinet (accounts, tokens, shelf — no encryption, no passphrase), the
// per-platform engines, and the always-on catalog publisher. Connecting
  // PUBLISHES metadata on connect and auto-harvests every PDF in a quiet
  // background queue (persisted — resumes after the tab closes). Manual
  // Download / Download all buttons still work and log verbosely.

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

  // ================= wizard =================
  let step = 1;

  function goStep(n) {
    step = n;
    for (const i of [1, 2, 3]) $("step-" + i).hidden = i !== n;
    document.querySelectorAll("#wiz-nav li").forEach((li) => {
      const s = Number(li.dataset.step);
      li.classList.toggle("on", s === n);
      li.classList.toggle("done", s < n);
    });
    if (n === 2) renderShelf();
    if (n === 3) renderQueue();
  }

  // ================= top / sync =================
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

  // ================= step 1 — accounts =================
  function accountRow(a) {
    const eng = ENG[a.platform];
    const label = eng ? eng.meta.label : a.platform;
    const n = (C.data().books || []).filter((b) => b.accountId === a.id).length;
    const dl = document.createElement("div");
    dl.className = "accrow";
    dl.innerHTML =
      `<div class="acc-main"><b>${F.esc(label)}</b>
         <span class="small muted">${F.esc(a.sub || "")} · ${n} book(s)</span></div>
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
    $("acc-empty").hidden = d.accounts.length > 0;
    for (const a of d.accounts) el.appendChild(accountRow(a));
  }

  // ================= shelf =================
  function coversOfSync(b) {
    const list = Array.isArray(b.covers) ? b.covers.slice() : [];
    if (b.cover && !list.includes(b.cover)) list.push(b.cover);
    if (b.isbn) for (const u of F.staticCovers(b.isbn)) if (!list.includes(u)) list.push(u);
    return list;
  }

  function bookRow(b) {
    const eng = ENG[b.platform];
    const pub = Folio.publish && Folio.publish.entryFor(b);
    const el = document.createElement("div");
    el.className = "bookrow shelf-row";
    const meta = document.createElement("div");
    meta.className = "meta";
    const h = document.createElement("h4");
    h.textContent = b.title;
    const sub = document.createElement("div");
    sub.className = "isbn";
    sub.textContent = (eng ? eng.meta.label : b.platform) + (b.isbn ? " · " + b.isbn : "");
    const post = document.createElement("div");
    post.className = "post";
    post.textContent = pub && pub.hasPdf
      ? "stored in catalog"
      : (pub ? "in catalog · metadata only" : "in-browser");
    meta.append(h, sub, post);

    const actions = document.createElement("div");
    actions.className = "book-actions";
    const dl = document.createElement("button");
    dl.className = "btn btn-sm btn-primary";
    dl.textContent = "Download";
    dl.addEventListener("click", () => doDownload(b, dl));
    const rm = document.createElement("button");
    rm.className = "btn btn-sm";
    rm.textContent = "Remove";
    rm.addEventListener("click", () => {
      C.mutate((d) => { d.books = d.books.filter((x) => x !== b); });
      renderShelf();
    });
    actions.append(dl, rm);

    el.append(F.coverEl(coversOfSync(b)), meta, actions);
    return el;
  }

  function renderShelf() {
    const el = $("shelf");
    el.innerHTML = "";
    const d = C.data();
    const books = d.books || [];
    const hasDiBooK = !!(ENG.dibook && (d.accounts || []).some((a) => a.platform === "dibook"));
    $("isbn-form").hidden = !hasDiBooK;
    $("shelf-empty").hidden = books.length > 0;
    $("shelf-count").textContent = books.length + (books.length === 1 ? " book" : " books");
    const dlAll = $("dl-all");
    const pending = books.filter((b) => {
      const pub = Folio.publish.entryFor(b);
      return !(pub && pub.hasPdf);
    }).length;
    dlAll.disabled = pending === 0;
    dlAll.textContent = pending ? "Download all (" + pending + ") →" : "All stored ✓";
    for (const b of books) el.appendChild(bookRow(b));
  }

  // ================= step 1 — connect form =================
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
        f.autocomplete = c.autocomplete || "off";
        f.spellcheck = false;
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

  // Field visibility driven by the first <select> in the form. A field
  // declares what it wants to be shown for via `depends`.
  function applyCredVisibility() {
    const driver = document.querySelector("#cred-fields select");
    document.querySelectorAll("#cred-fields [data-depends]").forEach((s) => {
      const field = s.closest(".field");
      if (!field) return;
      const want = s.dataset.depends;
      field.style.display = (!want || (driver && driver.value === want)) ? "" : "none";
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
      let accId = "";
      const shelfDupes = new Set();   // platform:id already on the shelf
      C.mutate((d) => {
        // Same platform + same account label already connected → reuse it
        // (fresh secrets) instead of creating a second account row.
        const same = d.accounts.find((x) =>
          x.platform === key &&
          (x.label || "") === (account.label || "") &&
          (x.sub || "") === (account.sub || ""));
        if (same) {
          accId = same.id;
          Object.assign(same, account, { id: accId });
          d.secrets[accId] = stored;
        } else {
          accId = newId();
          d.accounts.push(Object.assign({ id: accId, platform: key, addedAt: Date.now() }, account));
          d.secrets[accId] = stored;
        }
        for (const b of books) {
          // one shelf row per platform+bookId — a re-connect must not duplicate
          if (d.books.some((x) => x.platform === key && String(x.id) === String(b.id))) { shelfDupes.add(key + ":" + b.id); continue; }
          d.books.push({ id: b.id, platform: key, accountId: accId, title: b.title, cover: b.cover || "", isbn: b.isbn || "", meta: b.meta || {}, addedAt: Date.now() });
        }
      });
      // Cover candidates: platform cover, ISBN sources, Google title search.
      F.dim("Fetching covers…");
      for (const b of books) {
        try {
          const covers = await F.coversOf({ title: b.title, isbn: b.isbn, cover: b.cover });
          if (covers.length) C.mutate((d) => {
            const r = d.books.find((x) => x.id === b.id && x.platform === key);
            if (r) r.covers = covers;
          });
        } catch (_) {}
      }
      F.ok("Saved to your Cabinet. " + (books.length - shelfDupes.size) + " new book(s)" +
        (shelfDupes.size ? " (" + shelfDupes.size + " already on the shelf — skipped)" : "") + ".");
      renderAll();
      C.sync("push");

      // Cabinet rows (they carry platform + accountId — engine books don't).
      // Shelves already holding one of these books also take part, so their
      // catalog metadata gets (re)published if a previous session missed it.
      const rows = (C.data().books || []).filter((x) =>
        x.accountId === accId || shelfDupes.has(x.platform + ":" + x.id));

      // Catalog metadata first, then quietly harvest every PDF in the
      // background — no step-hop, no per-book chatter; the queue chip is
      // the only progress surface and the queue survives a closed tab.
      await autoPublish(rows);
      const { added } = enqueue(pendingBooks(), { bg: true });
      if (added) F.dim("Background harvest started — " + added + " title(s) downloading (queue chip shows progress).");
      goStep(2);
    } catch (e) {
      F.err(e.message);
    }
    btn.disabled = false;
    btn.textContent = "Connect";
  }

  // ================= catalog publishing (always on) =================
  async function autoPublish(books) {
    const fresh = books.filter((b) => !Folio.publish.entryFor(b));
    if (!fresh.length) return;
    F.dim("Publishing " + fresh.length + " title(s) to the public catalog…");
    try {
      const n = await Folio.publish.autoPublish(fresh, (done, total, b, err) => {
        if (err) { F.log("catalog: " + (b && b.title ? "“" + b.title + "” " : "") + err, "err"); return; }
        if (done === total) F.ok("Catalog: " + done + " title(s) listed — PDFs follow in the background.");
      });
      if (n) renderShelf();
    } catch (e) {
      F.log("catalog: " + e.message, "err");
    }
  }

  // ================= download queue =================
  const queue = [];   // { key, b, state: queued|running|done|error, stage: dl|up, cur, tot, err, el, bg }
  let pumping = false;

  const qKey = (b) => b.platform + ":" + b.id;

  // Persist the queue so a closed tab can resume on the next visit.
  function saveQueue() {
    try {
      const rows = queue
        .filter((i) => i.state !== "done")
        .map((i) => ({ k: i.key, s: i.state, e: i.err || "", bg: i.bg ? 1 : 0 }));
      if (rows.length) localStorage.setItem("folio.queue", JSON.stringify(rows));
      else localStorage.removeItem("folio.queue");
    } catch (_) {}
  }

  function restoreQueue() {
    let rows = [];
    try { rows = JSON.parse(localStorage.getItem("folio.queue") || "[]"); } catch (_) {}
    if (!rows.length) return 0;
    const books = C.data().books || [];
    let n = 0;
    for (const r of rows) {
      if (queue.some((i) => i.key === r.k)) continue;
      const b = books.find((x) => qKey(x) === r.k);
      if (!b) continue;
      if (!harvestable(b)) continue; // stored, or a shared catalog entry
      const dead = missingSessionReason(b);
      if (r.s === "error" && dead) {
        queue.push({ key: r.k, b, state: "error", stage: "dl", cur: 0, tot: 0, err: r.e || dead, bg: !!r.bg });
        continue;
      }
      // running rows were interrupted by the tab closing — queue them again;
      // prior transient errors also get another automatic chance.
      queue.push({ key: r.k, b, state: "queued", stage: "dl", cur: 0, tot: 0, err: "", bg: !!r.bg });
      n++;
    }
    if (queue.length) renderQueue();
    if (n) {
      F.dim("Resuming " + n + " background download(s)…");
      pump();
    }
    return n;
  }

  // Why this book can't run right now ("" = fine to queue).
  function missingSessionReason(b) {
    const d = C.data();
    const acc = (d.accounts || []).find((a) => a.id === b.accountId);
    if (!acc) return "account removed — reconnect it in step 01";
    const s = d.secrets[acc.id];
    if (!s) return "session missing — reconnect it in step 01";
    const keyish = ["token", "cookie"].filter((k) => k in s);
    if (keyish.length) {
      return keyish.every((k) => !String(s[k] == null ? "" : s[k]).trim())
        ? labelOf(b) + " session missing — reconnect it in step 01"
        : "";
    }
    return Object.values(s).some((v) => String(v == null ? "" : v).trim())
      ? ""
      : labelOf(b) + " session missing — reconnect it in step 01";
  }

  function labelOf(b) {
    return (ENG[b.platform] && ENG[b.platform].meta && ENG[b.platform].meta.label) || b.platform;
  }

  // Should this book be downloaded/published at all?
  //   * catalog copy already has the PDF → nothing to do;
  //   * catalog entry belongs to another session (no deleteKey) → the book
  //     is already listed; never re-add or re-upload it (dedup rule).
  function harvestable(b) {
    const pub = Folio.publish.entryFor(b);
    if (!pub) return true;
    if (pub.hasPdf) return false;
    return !!pub.deleteKey;
  }

  function enqueue(books, opts) {
    const bg = !!(opts && opts.bg);
    let added = 0;
    let skipped = 0;
    for (const b of books || []) {
      const k = qKey(b);
      if (!harvestable(b)) continue;
      const reason = missingSessionReason(b);
      const old = queue.find((i) => i.key === k);
      if (old && (old.state === "queued" || old.state === "running")) continue;
      if (reason) {
        // dead on arrival — show it in the queue with the reason, don't run it
        if (old) { old.state = "error"; old.err = reason; old.b = b; }
        else queue.push({ key: k, b, state: "error", stage: "dl", cur: 0, tot: 0, err: reason, bg });
        skipped++;
        continue;
      }
      if (old) {
        old.state = "queued"; old.err = ""; old.cur = 0; old.tot = 0; old.b = b; old.retry = 0; old.bg = bg || !!old.bg;
      } else {
        queue.push({ key: k, b, state: "queued", stage: "dl", cur: 0, tot: 0, err: "", bg });
      }
      added++;
    }
    if (added) { renderQueue(); pump(); }
    if (skipped) F.dim(skipped + " book(s) skipped — reconnect their platform in step 01.");
    return { added, skipped };
  }

  function queueCounts() {
    const total = queue.length;
    const done = queue.filter((i) => i.state === "done").length;
    const err = queue.filter((i) => i.state === "error").length;
    const active = queue.filter((i) => i.state === "running" || i.state === "queued").length;
    return { total, done, err, active };
  }

  function updateChip() {
    const chip = $("queue-chip");
    const { total, done, active } = queueCounts();
    if (!active) { chip.hidden = true; return; }
    chip.hidden = false;
    chip.textContent = "queue " + (done + "/" + total);
  }

  function pendingBooks() {
    return (C.data().books || []).filter((b) => {
      if (!harvestable(b)) return false;
      return !queue.some((i) => i.key === qKey(b) && (i.state === "queued" || i.state === "running"));
    });
  }

  const STATE_LABEL = {
    queued: "queued",
    running: "working",
    done: "stored ✓",
    error: "failed"
  };

  function queueRow(it) {
    const el = document.createElement("div");
    el.className = "qrow state-" + it.state;
    el.innerHTML =
      `<div class="q-cover"></div>
       <div class="q-main">
         <div class="q-title"></div>
         <div class="q-bar"><i style="width:0%"></i></div>
         <div class="q-sub mono"></div>
       </div>
       <div class="q-state mono"></div>`;
    el.querySelector(".q-cover").replaceWith(F.coverEl(coversOfSync(it.b)));
    el.querySelector(".q-title").textContent = it.b.title;
    it.el = el;
    paintRow(it);
    return el;
  }

  function paintRow(it) {
    if (!it.el || !it.el.isConnected) return;
    const pct = it.tot ? Math.round((it.cur / it.tot) * 100) : (it.state === "done" ? 100 : 0);
    it.el.className = "qrow state-" + it.state;
    it.el.querySelector(".q-bar > i").style.width = pct + "%";
    const state = it.el.querySelector(".q-state");
    state.textContent = STATE_LABEL[it.state] || it.state;
    const sub = it.el.querySelector(".q-sub");
    if (it.state === "error") sub.textContent = it.err || "failed";
    else if (it.state === "running") {
      sub.textContent = it.stage === "up"
        ? "uploading part " + it.cur + "/" + it.tot
        : (it.tot ? "page " + it.cur + "/" + it.tot : "downloading…");
    } else if (it.state === "done") sub.textContent = "in the public catalog";
    else sub.textContent = "";
  }

  function renderQueue() {
    saveQueue();
    const el = $("qlist");
    el.innerHTML = "";
    for (const it of queue) el.appendChild(queueRow(it));
    const { total, err } = queueCounts();
    const pend = pendingBooks();
    $("q-empty").hidden = total > 0;
    $("q-retry").hidden = !err;
    $("q-all").hidden = !pend.length;
    $("q-count").textContent = total
      ? queue.filter((i) => i.state === "done").length + " / " + total + " stored"
      : "";
    updateChip();
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    for (;;) {
      const it = queue.find((i) => i.state === "queued");
      if (!it) break;
      await runItem(it);
    }
    pumping = false;
    renderQueue();
    const { done, err } = queueCounts();
    if (done || err) {
      F.ok("Queue finished — " + done + " book(s) stored in the catalog" + (err ? ", " + err + " failed" : "") + ".");
    }
  }

  async function runItem(it) {
    const b = it.b;
    const eng = ENG[b.platform];
    const acc = (C.data().accounts || []).find((a) => a.id === b.accountId);
    it.state = "running";
    it.stage = "dl";
    renderQueue();

    if (!eng) { fail(it, "unknown platform"); return; }
    if (!acc) { fail(it, "account is gone — reconnect it in step 01"); return; }
    const secrets = C.data().secrets[acc.id];
    const missing = missingSessionReason(b);
    if (!secrets || missing) { fail(it, missing || "session missing — reconnect it in step 01"); return; }

    // background items run silently — no per-book log chatter; errors still surface
    const ectx = it.bg
      ? { log: () => {}, ok: () => {}, dim: () => {}, err: (t) => F.log(t, "err") }
      : ctx;
    if (!it.bg) F.log("Folio · pulling “" + b.title + "”", "dim");
    try {
      const onProgress = (cur, tot) => { it.cur = cur; it.tot = tot; paintRow(it); };
      const { filename, bytes, pages } = await eng.download(b, secrets, ectx, onProgress);
      if (!bytes) throw new Error("download produced nothing");

      it.stage = "up";
      it.cur = 0; it.tot = 0;
      paintRow(it);
      if (!it.bg) F.dim("Catalog: uploading " + filename + " (" + F.fmtBytes(bytes.byteLength) + ")…");
      const upload = () => Folio.publish.publishPdf(b, bytes, filename, pages || (b.meta && b.meta.count) || 0,
        (c, t) => { it.cur = c; it.tot = t; paintRow(it); });
      let rec;
      try {
        rec = await upload();
      } catch (e) {
        // a dropped connection mid-upload must not throw away the download
        if (!/Failed to fetch|NetworkError|publish failed|\((408|425|429|5\d\d)\)/.test(e.message || "")) throw e;
        F.err("upload interrupted (" + e.message + ") — retrying the upload in 15s…");
        await new Promise((r) => setTimeout(r, 15000));
        rec = await upload();
      }

      it.state = "done";
      if (rec && !rec.deleteKey && !rec.hasPdf) {
        if (!it.bg) F.dim("“" + b.title + "” is already listed in the catalog by another session — upload skipped.");
      } else if (!it.bg) {
        F.ok("“" + b.title + "” stored in the catalog.");
      }
      renderShelf();
    } catch (e) {
      // Transient relay/edge throttling — wait out the burst window and try
      // this book once more before giving up on it.
      const transient = /relay HTTP (5\d\d|429)|upstream HTTP 5\d\d|relay is unreachable|Failed to fetch|NetworkError/.test(e.message);
      if (transient && !it.retry) {
        it.retry = 1;
        F.err(e.message + " — waiting 60s, then retrying “" + b.title + "” once…");
        await new Promise((r) => setTimeout(r, 60000));
        return runItem(it);
      }
      fail(it, e.message);
      if (eng.meta && eng.meta.needsRelay && !(await F.relayAvailable().catch(() => false))) {
        F.dim("Hint: this platform needs the Folio relay — deploy on Cloudflare Pages.");
      }
    }
    paintRow(it);
  }

  function fail(it, msg) {
    it.state = "error";
    it.err = msg;
    F.err(it.b.title + ": " + msg);
  }

  // ================= manual save (shelf button) =================
  async function doDownload(b, btn) {
    const eng = ENG[b.platform];
    const acc = (C.data().accounts || []).find((a) => a.id === b.accountId);
    if (!acc) { F.err("Account for this book is gone — reconnect it."); return; }
    const secrets = C.data().secrets[acc.id];
    if (btn) { btn.disabled = true; btn.textContent = "Working…"; }
    F.log("Folio · saving “" + b.title + "”", "dim");
    try {
      const onProgress = (cur, tot) => { if (btn) btn.textContent = cur + "/" + tot; };
      const { filename, blob, bytes, pages } = await eng.download(b, secrets, ctx, onProgress);
      const out = blob || (bytes ? new Blob([bytes], { type: "application/pdf" }) : null);
      if (!out) throw new Error("download produced nothing");
      F.saveBlob(out, filename);
      F.ok("Saved " + filename);
      if (bytes) {
        F.dim("Catalog: uploading…");
        try {
          const rec = await Folio.publish.publishPdf(b, bytes, filename, pages || 0);
          if (rec && !rec.deleteKey && !rec.hasPdf) {
            F.dim("“" + b.title + "” is already listed in the catalog by another session — upload skipped.");
          } else {
            F.ok("“" + b.title + "” stored in the catalog.");
          }
        } catch (e) {
          F.log("catalog upload failed: " + e.message, "err");
        }
        renderShelf();
      }
    } catch (e) {
      F.err(e.message);
    }
    if (btn) { btn.disabled = false; btn.textContent = "Download"; }
  }

  // ================= tutorial =================
  function renderTutorial() {
    const host = $("tutorial");
    if (!host) return;
    const eng = ENG[engSelect().value];
    const steps = (eng && eng.meta && eng.meta.tutorial) || [];
    if (!steps.length) { host.hidden = true; host.innerHTML = ""; return; }
    host.hidden = false;
    host.innerHTML =
      `<h3>How to connect ${F.esc(eng.meta.label)} <span class="small muted">(5 steps)</span></h3>` +
      `<ol class="steps">` +
      steps.map((t) => `<li>${t}</li>`).join("") +
      `</ol>`;
  }

  // ================= add by ISBN =================
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
        try {
          const covers = await F.coversOf({ title: book.title, isbn: book.isbn });
          if (covers.length) C.mutate((d) => {
            const r = d.books.find((x) => x.id === book.id && x.platform === "dibook");
            if (r) r.covers = covers;
          });
        } catch (_) {}
        F.ok("“" + book.title + "” added to the shelf.");
        const row = C.data().books.find((x) => x.id === book.id && x.platform === "dibook");
        if (row) await autoPublish([row]);
        renderShelf();
      } catch (e) { F.err(e.message); }
    });
  }

  // ================= boot =================
  function renderAll() {
    renderTop();
    renderAccounts();
    renderShelf();
    refreshSync();
    updateChip();
  }

  function init() {
    F.bindLog($("log"));
    $("connect-btn").addEventListener("click", onConnect);
    engSelect().addEventListener("change", () => { renderCredFields(); renderTutorial(); });
    $("cred-fields").addEventListener("change", applyCredVisibility);
    bindIsbn();

    document.querySelectorAll("#wiz-nav li").forEach((li) => {
      li.addEventListener("click", () => goStep(Number(li.dataset.step)));
    });
    $("to-connect").addEventListener("click", () => goStep(1));
    $("empty-connect").addEventListener("click", () => goStep(1));
    $("to-shelf").addEventListener("click", () => goStep(2));
    $("queue-chip").addEventListener("click", () => goStep(3));
    $("dl-all").addEventListener("click", () => {
      const { added, skipped } = enqueue((C.data().books || []).filter((b) => harvestable(b)));
      if (!added) {
        F.dim(skipped ? "Nothing to queue — reconnect the platforms first (step 01)." : "Everything is already stored in the catalog.");
        return;
      }
      goStep(3);
    });
    $("q-all").addEventListener("click", () => { enqueue(pendingBooks()); });
    $("q-retry").addEventListener("click", () => {
      queue.forEach((i) => { if (i.state === "error") { i.state = "queued"; i.err = ""; i.retry = 0; } });
      renderQueue(); pump();
    });

    renderPlatformChoices();
    renderTutorial();

    $("desk").style.display = "";
    restoreQueue();
    renderAll();

    const accounts = (C.data().accounts || []).length;
    // never auto-hop to the queue — the chip reports progress; chip click opens it
    goStep(accounts ? 2 : 1);

    C.sync("push").then(refreshSync);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
