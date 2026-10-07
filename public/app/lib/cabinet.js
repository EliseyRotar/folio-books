// Folio — the Cabinet (plaintext, no Cabinet).
//
// There is no Cabinet, no passphrase, no "create/unlock/lock". Your accounts,
// their credentials, session tokens and the books you've collected live here
// as *visible plaintext*: mirrored to Cloudflare D1 (plain JSON rows you can
// read in the database), cached on this device for offline, and shown in the
// app's Cabinet. Open the page and the desk is right there — nothing is
// sealed, obfuscated or hidden. By design.

window.Folio = window.Folio || {};
const C = (Folio.cabinet = {});

const LS_PREFIX = "folio.cabinet.";
let _doc = null; // the opened plaintext cabinet (never plaintext)
let _cloud = { exists: false, updatedAt: 0 };

C.deviceId = function deviceId() {
  let id = localStorage.getItem("folio.device");
  if (!id) { id = "d_" + (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now().toString(36)); localStorage.setItem("folio.device", id); }
  return id;
};


  // ----- book covers -------------------------------------------------
  // Covers are candidate URL lists (F.coversOf in common.js) — the shelf
  // and the catalog try them in order and fall back to a silhouette. No
  // bytes are cached in the Cabinet.

  function defaultData() {

  return {
    device: C.deviceId(),
    profile: { name: "" },   // visible
    accounts: [],            // visible: { id, platform, label, addedAt }
    secrets: {},             // visible: accountId -> plaintext credentials
    books: []                // visible shelf
  };
}

function lsKey() { return LS_PREFIX + C.deviceId(); }

function loadLocal() {
  try { const raw = localStorage.getItem(lsKey()); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
}

function saveLocal() {
  try { localStorage.setItem(lsKey(), JSON.stringify(_doc)); } catch (_) { /* private mode — memory only */ }
}

// ---- plaintext store --------------------------------------------------
C.data = function data() {
  if (!_doc) { _doc = loadLocal() || defaultData(); if (dedupDoc(_doc)) saveLocal(); }
  return _doc;
};

// One-time migration: older builds pushed accounts/books unconditionally on
// every connect, so the same account (or the same title) could land twice.
// Collapse to: one account per platform+label+sub, one book per
// platform+bookId — secrets and accountIds re-pointed at the survivors.
function dedupDoc(d) {
  let changed = false;
  const accounts = d.accounts || [];
  const keeper = new Map();   // platform|label|sub -> surviving account
  const remap = new Map();    // dropped account id -> survivor id
  for (const a of accounts) {
    const k = a.platform + "|" + (a.label || "") + "|" + (a.sub || "");
    const keep = keeper.get(k);
    if (!keep) { keeper.set(k, a); continue; }
    changed = true;
    const older = (a.addedAt || 0) <= (keep.addedAt || 0) ? a : keep;
    const loser = older === a ? keep : a;
    keeper.set(k, older);
    remap.set(loser.id, older.id);
  }
  if (remap.size) {
    d.accounts = accounts.filter((a) => !remap.has(a.id));
    for (const [dead, live] of remap) {
      if (d.secrets && d.secrets[dead]) {
        if (!d.secrets[live]) d.secrets[live] = d.secrets[dead];
        delete d.secrets[dead];
      }
    }
  }
  const books = d.books || [];
  const byKey = new Map();
  const out = [];
  for (const b of books) {
    if (b.accountId && remap.has(b.accountId)) { b.accountId = remap.get(b.accountId); changed = true; }
    const k = b.platform + ":" + b.id;
    const keep = byKey.get(k);
    if (!keep) { byKey.set(k, b); out.push(b); continue; }
    changed = true;
    // merge the duplicate into the first row: union covers, fill gaps
    const covers = Array.isArray(keep.covers) ? keep.covers.slice() : (keep.cover ? [keep.cover] : []);
    const extra = Array.isArray(b.covers) ? b.covers : (b.cover ? [b.cover] : []);
    for (const c of extra) if (c && !covers.includes(c)) covers.push(c);
    if (covers.length) keep.covers = covers;
    if (!keep.cover && b.cover) keep.cover = b.cover;
    if (!keep.isbn && b.isbn) keep.isbn = b.isbn;
    if (!keep.meta || !keep.meta.count) keep.meta = b.meta || keep.meta;
    if ((b.addedAt || 0) < (keep.addedAt || 0)) keep.addedAt = b.addedAt;
  }
  d.books = out;
  return changed;
}

C.mutate = function mutate(fn) { fn(C.data()); saveLocal(); };
C.status = () => "open";               // always open — no lock, no unlock
C.createdAt = () => Date.now();

async function cloudGet() {
  try {
    const r = await fetch("/api/cabinet?device=" + encodeURIComponent(C.deviceId()));
    const j = await r.json();
    _cloud = { exists: !!(j && j.exists), updatedAt: (j && j.updatedAt) || 0 };
    return j;
  } catch (_) { _cloud = { exists: false, updatedAt: 0 }; return null; }
}

async function cloudSet() {
  try {
    await fetch("/api/cabinet", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ device: C.deviceId(), doc: JSON.stringify(C.data()), updatedAt: Date.now() })
    });
    _cloud = { exists: true, updatedAt: Date.now() };
  } catch (_) { /* D1 not deployed — the local cabinet is still the truth */ }
}

async function cloudDel() { await fetch("/api/cabinet?device=" + encodeURIComponent(C.deviceId()), { method: "DELETE" }).catch(() => {}); _cloud = { exists: false, updatedAt: 0 }; }

// push: local -> D1. pull: D1 -> local (if the cloud copy is newer).
C.syncState = () => (_cloud.updatedAt >= (C.data().addedAt || 0) ? "synced" : "local");
C.sync = async function sync(kind) {
  if (kind === "push") { await cloudSet(); return; }
  try {
    const j = await cloudGet();
    if (j && j.exists && j.doc) {
      const remote = JSON.parse(j.doc);
      if ((remote.updatedAt || 0) > (C.data().updatedAt || 0)) {
        _doc = Object.assign(defaultData(), remote, { device: C.deviceId() });
        dedupDoc(_doc);
        saveLocal();
      } else {
        await cloudSet(); // cloud older → push ours
      }
    }
  } catch (_) { await cloudSet(); }
};
