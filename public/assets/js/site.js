// Folio — site chrome: current-nav marking + light/dark theme toggle.
// The theme is applied by a tiny inline script in <head> before first paint
// (no flash); this file only wires the button and keeps the choice.

(function () {
  var KEY = "folio.theme";

  function current() {
    return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }

  function apply(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem(KEY, theme); } catch (_) {}
    document.querySelectorAll("[data-theme-toggle]").forEach(function (b) {
      b.textContent = theme === "dark" ? "Dark" : "Light";
      b.setAttribute("aria-label", "Switch to " + (theme === "dark" ? "light" : "dark") + " mode");
      b.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
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

    document.querySelectorAll("[data-theme-toggle]").forEach(function (b) {
      b.addEventListener("click", function () {
        apply(current() === "dark" ? "light" : "dark");
      });
    });
  });
})();
