// Folio — site chrome: current-nav marking, light/dark theme toggle and
// the IT/EN language switch. Theme and language are applied by tiny inline
// scripts in <head> before first paint (no flash); this file only wires
// the buttons and keeps the choices.

(function () {
  var KEY = "folio.theme";
  var LANG_KEY = "folio.lang";

  function current() {
    return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }

  function storedLang() {
    try { return localStorage.getItem(LANG_KEY) || ""; } catch (_) { return ""; }
  }

  function langNow() {
    var forced = storedLang();
    if (forced === "it" || forced === "en") return forced;
    var nav = (navigator.languages && navigator.languages[0]) || navigator.language || "en";
    return String(nav).toLowerCase().slice(0, 2) === "it" ? "it" : "en";
  }

  function apply(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem(KEY, theme); } catch (_) {}
    document.querySelectorAll("[data-theme-toggle]").forEach(function (b) {
      b.textContent = theme === "dark" ? "Light" : "Dark";
      b.setAttribute("aria-label", "Switch to " + (theme === "dark" ? "light" : "dark") + " mode");
      b.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
    });
  }

  function applyLangLabel() {
    var other = langNow() === "it" ? "EN" : "IT";
    document.querySelectorAll("[data-lang-toggle]").forEach(function (b) {
      b.textContent = other;
      b.setAttribute("aria-label", other === "EN" ? "Switch to English" : "Passa all’italiano");
      b.title = other === "EN" ? "English" : "Italiano";
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    // current nav item (robust inside nested dirs)
    // compare real paths: strip ".html", map "/x/index" to "/x", drop trailing "/"
    var norm = function (p) {
      return (p || "").replace(/\.html$/, "").replace(/\/index$/, "/").replace(/\/$/, "") || "/";
    };
    var here = norm(location.pathname);
    document.querySelectorAll(".nav-links a").forEach(function (a) {
      try {
        var url = new URL(a.href, location.href);
        if (norm(url.pathname) === here) a.setAttribute("aria-current", "page");
      } catch (_) {}
    });

    apply(current());
    applyLangLabel();

    document.querySelectorAll("[data-theme-toggle]").forEach(function (b) {
      b.addEventListener("click", function () {
        apply(current() === "dark" ? "light" : "dark");
      });
    });

    document.querySelectorAll("[data-lang-toggle]").forEach(function (b) {
      b.addEventListener("click", function () {
        try { localStorage.setItem(LANG_KEY, langNow() === "it" ? "en" : "it"); } catch (_) {}
        location.reload();
      });
    });
  });
})();
