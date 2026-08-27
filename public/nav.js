// nav.js — shared across every page. Highlights the current sport in the nav.
(function () {
  var seg = (location.pathname.replace(/\/+$/, "") || "/").split("/").filter(Boolean)[0] || "";
  document.querySelectorAll(".site-nav a[data-s]").forEach(function (a) {
    if (a.getAttribute("data-s") === seg) a.classList.add("active");
  });
})();
