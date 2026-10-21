// Folio i18n — the site speaks the visitor's language.
//
// Detection: browser locale starting with "it" → Italian; anything else →
// English (the markup itself stays English). "folio.lang" (or ?lang=it|en)
// overrides detection for testing/sharing a link.
//
// How it translates: an EN→IT dictionary (assets/js/it.js) whose keys are
// the normalized English strings exactly as they render. A walker replaces
// matched text/attributes in place; a MutationObserver re-scans whenever the
// app renders new UI (shelf rows, queue, logs), so dynamic strings are
// covered too. Keys containing {tokens} compile to regexes for lines like
// "page 5/178". English visitors pay ~2 KB (the dictionary is only loaded
// for Italian).
(function () {
  var q = null;
  try { q = new URLSearchParams(location.search).get("lang"); } catch (e) {}
  if (q === "it" || q === "en") { try { localStorage.setItem("folio.lang", q); } catch (e) {} }
  var stored = null;
  try { stored = localStorage.getItem("folio.lang"); } catch (e) {}
  var nav = (navigator.languages && navigator.languages[0]) || navigator.language || "en";
  var lang = stored || (String(nav).toLowerCase().indexOf("it") === 0 ? "it" : "en");
  if (lang !== "it" && lang !== "en") lang = "en";
  document.documentElement.lang = lang;

  var I = {
    lang: lang,
    t: function (k) { return k; },
    T: function (k, v) { return v ? k : k; },
    ready: false
  };
  window.I18N = I;

  // Load the dictionary. During parsing document.write injects it.js into
  // the script stream — parsed before DOMContentLoaded, so Italian visitors
  // never see English first. Otherwise (late load) fetch async.
  function loadDict(cb) {
    if (lang !== "it") { cb(null); return; }
    if (window.FOLIO_IT) { cb(window.FOLIO_IT); return; }
    if (document.readyState === "loading") {
      document.write('<script src="/assets/js/it.js"><\/script>');
      document.addEventListener("DOMContentLoaded", function () { cb(window.FOLIO_IT || null); });
      return;
    }
    var s = document.createElement("script");
    s.src = "/assets/js/it.js";
    s.onload = function () { cb(window.FOLIO_IT || null); };
    s.onerror = function () { cb(null); };
    document.head.appendChild(s);
  }

  function norm(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }
  function escRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  function compile(ken, vit) {
    var names = [], src = "^", last = 0, re = /\{(\w+)\}/g, m;
    while ((m = re.exec(ken))) {
      src += escRe(ken.slice(last, m.index)) + "([\\s\\S]*?)";
      names.push(m[1]);
      last = re.lastIndex;
    }
    src += escRe(ken.slice(last)) + "$";
    return { re: new RegExp(src), names: names, vit: vit };
  }

  loadDict(function (IT) {
    if (!IT) return;

    var direct = new Map();
    var tpls = [];
    for (var k in IT) {
      var v = IT[k];
      if (typeof v !== "string") continue;
      if (k.indexOf("{") >= 0) tpls.push(compile(k, v));
      else direct.set(norm(k), v);
    }

    // text (already normalized) → Italian, via exact key then template keys.
    function resolve(text) {
      if (!text) return null;
      var d = direct.get(text);
      if (d != null) return d;
      for (var i = 0; i < tpls.length; i++) {
        var t = tpls[i];
        var m = t.re.exec(text);
        if (m) {
          var map = {};
          for (var j = 0; j < t.names.length; j++) map[t.names[j]] = m[j + 1] != null ? m[j + 1] : "";
          return t.vit.replace(/\{(\w+)\}/g, function (_, n) { return map[n] != null ? map[n] : ""; });
        }
      }
      return null;
    }

    function strip(v) { return String(v).replace(/<[^>]*>/g, ""); }

    // JS-facing helpers (confirm dialogs, rare dynamic labels).
    I.t = function (k) { var r = resolve(norm(k)); return r != null ? strip(r) : k; };
    I.T = function (k, vars) {
      var r = resolve(norm(k));
      if (r == null) r = k;
      if (vars) r = r.replace(/\{(\w+)\}/g, function (_, n) { return vars[n] != null ? vars[n] : ""; });
      return r;
    };

    var ATTRS = ["placeholder", "title", "aria-label", "alt"];
    var SKIP = /^(SCRIPT|STYLE|NOSCRIPT|CODE|PRE|TEXTAREA)$/;

    // Block-level structure the walker must never replace wholesale: lists,
    // tables, cards, multi-column layouts keep their markup and get
    // translated from the inside instead (each child carries its own key).
    // Without this guard a container key (full section text as one string)
    // would flatten the whole block into a single run-on text node.
    var STRUCT = "div,p,li,ul,ol,dl,dt,dd,h1,h2,h3,h4,h5,h6,table,thead,tbody,tfoot,tr,td,th,section,article,header,footer,nav,main,aside,details,summary,figure,figcaption,blockquote,form,fieldset,hr";
    function hasStruct(el) {
      var tag = (el.tagName || "").toLowerCase();
      if (("," + STRUCT + ",").indexOf("," + tag + ",") >= 0) return true;
      return !!el.querySelector(STRUCT);
    }

    function scanNode(el) {
      if (!el || el.nodeType !== 1) return;
      if (SKIP.test(el.tagName || "")) return;

      // attributes
      for (var a = 0; a < ATTRS.length; a++) {
        var raw = el.getAttribute ? el.getAttribute(ATTRS[a]) : null;
        if (!raw) continue;
        var av = resolve(norm(raw));
        if (av != null && av.indexOf("<") < 0 && av !== raw) el.setAttribute(ATTRS[a], av);
      }

      var kids = el.childNodes;
      var hasElem = false, i;
      for (i = 0; i < kids.length; i++) if (kids[i].nodeType === 1) { hasElem = true; break; }

      // whole-element HTML replace — mixed-content paragraphs carry the full
      // Italian markup (links etc.) under their key (marked in the build or
      // produced by resolve for keys whose IT value contains tags).
      if (hasElem) {
        var fullRaw = norm(el.textContent);
        var full = resolve(fullRaw);
        if (full != null && full.indexOf("<") >= 0 && !hasStruct(el)) {
          el.innerHTML = full;
          return;
        }
      }

      // plain text-node children (leaf elements and mixed elements alike)
      for (i = 0; i < kids.length; i++) {
        var n = kids[i];
        if (n.nodeType !== 3) continue;
        var tv = resolve(norm(n.data));
        if (tv != null && tv.indexOf("<") < 0 && tv !== n.data) {
          // keep the node's own boundary whitespace so split headings
          // ("One shelf for" + "every" + "textbook…") don't glue together
          var lead = /^[ \t\r\n]*/.exec(n.data)[0];
          var trail = /[ \t\r\n]*$/.exec(n.data)[0];
          n.data = lead + tv + trail;
        }
      }

      // heavily marked-up blocks (tutorials: "Open <b>my.bsmart.it</b> …")
      // expose only full-sentence keys — prefer the element's full text so
      // the block can't end up half-English. Functional elements (links,
      // buttons — themselves or descendants) keep the fragment path so
      // markup survives, and elements with structural children (li/div/table
      // …) recurse so the layout survives — only inline-markup nodes are
      // flattened here.
      if (hasElem && full != null && full !== fullRaw && !hasStruct(el) &&
          !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(el.tagName || "") &&
          !el.querySelector("a,button,input,select,textarea")) {
        el.textContent = full;
        return;
      }

      for (i = 0; i < kids.length; i++) if (kids[i].nodeType === 1) scanNode(kids[i]);
    }

    function scanTitle() {
      var tv = resolve(norm(document.title));
      if (tv != null && tv.indexOf("<") < 0) document.title = tv;
    }

    var timer = 0;
    function rescan() {
      if (timer) return;
      timer = setTimeout(function () {
        timer = 0;
        scanTitle();
        if (document.body) scanNode(document.body);
      }, 80);
    }

    function start() {
      I.ready = true;
      scanTitle();
      if (document.body) scanNode(document.body);
      try {
        new MutationObserver(function (muts) {
          for (var i = 0; i < muts.length; i++) {
            var m = muts[i];
            if (m.addedNodes.length || m.attributeName) { rescan(); return; }
          }
        }).observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ATTRS
        });
      } catch (e) { /* no observer — initial pass still applied */ }
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
  });
})();
