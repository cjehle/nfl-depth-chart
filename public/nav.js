// nav.js — shared across every page. Highlights the current sport in the nav
// and registers the service worker (offline app-shell + last-lineup caching).
(function () {
  var seg = (location.pathname.replace(/\/+$/, "") || "/").split("/").filter(Boolean)[0] || "";
  document.querySelectorAll(".site-nav a[data-s]").forEach(function (a) {
    if (a.getAttribute("data-s") === seg) a.classList.add("active");
  });
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js").catch(function () { /* offline support is best-effort */ });
    });
  }
})();
