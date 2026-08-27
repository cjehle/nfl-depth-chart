// nav.js — shared across every page. Highlights the current sport in the nav
// and registers the service worker (offline app-shell + last-lineup caching).
(function () {
  var seg = (location.pathname.replace(/\/+$/, "") || "/").split("/").filter(Boolean)[0] || "";
  document.querySelectorAll(".site-nav a[data-s]").forEach(function (a) {
    if (a.getAttribute("data-s") === seg) a.classList.add("active");
  });
  // If the active page is inside the "International Soccer" folder, mark the
  // folder summary active too; and close the folder when clicking outside it.
  document.querySelectorAll(".nav-folder").forEach(function (folder) {
    if (folder.querySelector('a[data-s="' + seg + '"]')) {
      var sum = folder.querySelector("summary");
      if (sum) sum.classList.add("active");
    }
    document.addEventListener("click", function (e) { if (!folder.contains(e.target)) folder.open = false; });
  });
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js").catch(function () { /* offline support is best-effort */ });
    });
  }
})();
