// metrics.js — tiny first-party RUM beacon. Anonymous + aggregate only: no cookies, no
// PII, no third parties, only a coarse source/device + timing numbers + an ephemeral
// per-tab session id. One beacon per page, sent on the first "hidden" via sendBeacon (the
// reliable moment: dwell is known and LCP/CLS/INP have finalized). Fully feature-detected;
// never throws, never blocks. CSP-safe (external script under script-src 'self').
(function () {
  "use strict";
  if (!("sendBeacon" in navigator)) return;

  // Ephemeral per-tab session id (sessionStorage) + first-ever-visit flag (localStorage).
  var sid, newVisitor = false;
  try {
    sid = sessionStorage.getItem("sdc_sid");
    if (!sid) { sid = (Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 32); sessionStorage.setItem("sdc_sid", sid); }
  } catch (e) { sid = (Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 32); }
  try { if (!localStorage.getItem("sdc_v")) { newVisitor = true; localStorage.setItem("sdc_v", "1"); } } catch (e) {}

  // Coarse referrer source — CATEGORY only, never the referring URL (privacy).
  function source() {
    var r = document.referrer;
    if (!r) return "direct";
    try {
      var h = new URL(r).host;
      if (h === location.host) return "direct";
      if (/(^|\.)(google|bing|duckduckgo|yahoo|ecosia|baidu|yandex|brave)\./.test(h)) return "search";
      if (/(^|\.)(t\.co|twitter|x\.com|facebook|fb\.com|instagram|reddit|linkedin|youtube|pinterest|tiktok|threads|mastodon)/.test(h)) return "social";
      return "other";
    } catch (e) { return "other"; }
  }
  function device() { var w = window.innerWidth || screen.width || 1024; return w < 768 ? "mobile" : w < 1024 ? "tablet" : "desktop"; }

  // ---- Core Web Vitals via PerformanceObserver (all guarded) ----
  var lcp = null, cls = 0, inp = 0;
  function observe(type, cb, opts) {
    try { var po = new PerformanceObserver(function (l) { l.getEntries().forEach(cb); }); po.observe(Object.assign({ type: type, buffered: true }, opts || {})); return po; } catch (e) { return null; }
  }
  observe("largest-contentful-paint", function (e) { lcp = e.startTime; });
  // CLS with the standard session-window (max 1s-gap / 5s-window cluster).
  var clsVal = 0, clsStart = 0, clsPrev = 0;
  observe("layout-shift", function (e) {
    if (e.hadRecentInput) return;
    if (clsVal && (e.startTime - clsPrev > 1000 || e.startTime - clsStart > 5000)) clsVal = 0, clsStart = e.startTime;
    if (!clsVal) clsStart = e.startTime;
    clsPrev = e.startTime; clsVal += e.value; if (clsVal > cls) cls = clsVal;
  });
  // INP ≈ the worst interaction latency this visit (a common single-number simplification).
  observe("event", function (e) { if (e.interactionId && e.duration > inp) inp = e.duration; }, { durationThreshold: 40 });
  observe("first-input", function (e) { var d = e.processingStart - e.startTime; if (d > inp) inp = d; });

  function navTiming() {
    try {
      var n = performance.getEntriesByType("navigation")[0];
      var fcpE = performance.getEntriesByType("paint").filter(function (p) { return p.name === "first-contentful-paint"; })[0];
      return {
        ttfb: n ? Math.round(n.responseStart) : null,
        fcp: fcpE ? Math.round(fcpE.startTime) : null,
        load: n && n.loadEventEnd ? Math.round(n.loadEventEnd) : null,
      };
    } catch (e) { return {}; }
  }

  // ---- dwell: accumulate visible time across tab switches ----
  var visibleSince = document.visibilityState === "visible" ? performance.now() : 0;
  var dwellMs = 0;
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") { if (visibleSince) { dwellMs += performance.now() - visibleSince; visibleSince = 0; } send(); }
    else if (!visibleSince) visibleSince = performance.now();
  });

  var sent = false;
  function send() {
    if (sent) return; sent = true;
    if (visibleSince) { dwellMs += performance.now() - visibleSince; visibleSince = 0; }
    var t = navTiming();
    var conn = ""; try { conn = (navigator.connection && navigator.connection.effectiveType) || ""; } catch (e) {}
    var payload = {
      p: location.pathname.replace(/\/+$/, "").toLowerCase() || "/",
      ref: source(), sid: sid, nv: newVisitor, dev: device(), conn: conn,
      dwell: Math.round(dwellMs / 1000),
      vit: { ttfb: t.ttfb, fcp: t.fcp, load: t.load, lcp: lcp != null ? Math.round(lcp) : null, cls: +cls.toFixed(3), inp: inp ? Math.round(inp) : null },
    };
    try { navigator.sendBeacon("/api/metric", JSON.stringify(payload)); } catch (e) {}
  }
  // pagehide is the reliable terminal event on mobile Safari (where unload doesn't fire).
  addEventListener("pagehide", send, { capture: true });
})();
