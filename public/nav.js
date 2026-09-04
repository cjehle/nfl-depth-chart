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
  // Landing page only: build a "Recently viewed" strip that deep-links back to
  // each sport the visitor has an open team saved for (from localStorage).
  if (document.body.classList.contains("landing")) {
    var strip = document.getElementById("resume-strip");
    if (strip) {
      // slug, label + emoji, and the localStorage read for each sport. NFL keeps
      // its own key/param (ot=); every surface sport uses sdc.<sport>.state (a=).
      var SPORTS = [
        ["nfl", "🏈 NFL"], ["mlb", "⚾ MLB"], ["nba", "🏀 NBA"], ["nhl", "🏒 NHL"],
        ["mls", "⚽ MLS"], ["wnba", "🏀 WNBA"], ["cfb", "🎓 CFB"], ["cbb", "🎓 CBB"],
        ["mch", "🎓 CHky"], ["epl", "Premier League"], ["laliga", "La Liga"],
        ["bundesliga", "Bundesliga"], ["seriea", "Serie A"], ["ligue1", "Ligue 1"],
        ["ligamx", "Liga MX"], ["nwsl", "NWSL"], ["ucl", "Champions League"]
      ];
      var any = false;
      SPORTS.forEach(function (s) {
        var slug = s[0], label = s[1], saved = null;
        try { saved = localStorage.getItem(slug === "nfl" ? "nfl.controls" : "sdc." + slug + ".state"); }
        catch (e) { saved = null; }
        if (!saved) return;
        var a = document.createElement("a");
        a.className = "resume-card";
        a.href = "/" + slug + "?" + saved;
        a.textContent = label;
        strip.appendChild(a);
        any = true;
      });
      if (any) {
        // Prepend the "Jump back in" label (the .resume-strip .resume-label rule already
        // exists in shared.css but nothing was populating it) so the pills read as a resume
        // strip, not a second nav row. insertBefore keeps it left of the already-added pills.
        var label = document.createElement("span");
        label.className = "resume-label";
        label.textContent = "Jump back in";
        strip.insertBefore(label, strip.firstChild);
        strip.hidden = false;
      }
    }
  }
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js").catch(function () { /* offline support is best-effort */ });
    });
  }
})();
