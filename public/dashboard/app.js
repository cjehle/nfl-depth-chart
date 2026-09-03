// dashboard/app.js — renders the metrics dashboard from /api/metrics-summary.
// Zero-dependency: DOM + inline SVG, no chart library. CSP-safe (no inline style attrs;
// geometry via SVG attributes, dynamic sizing via element.style.* CSSOM writes).
(function () {
  "use strict";
  var KEY = new URLSearchParams(location.search).get("key");
  var API = "/api/metrics-summary" + (KEY ? "?key=" + encodeURIComponent(KEY) : "");
  var rawLink = document.getElementById("raw-link"); if (rawLink) rawLink.href = API;
  var SVGNS = "http://www.w3.org/2000/svg";

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function svg(tag, attrs) { var e = document.createElementNS(SVGNS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function fmt(n) { return (n == null ? 0 : n).toLocaleString(); }
  function dur(sec) { sec = Math.round(sec || 0); if (sec < 60) return sec + "s"; var m = Math.floor(sec / 60); return m + "m " + (sec % 60) + "s"; }
  function ms(v) { return v == null ? "—" : (v >= 1000 ? (v / 1000).toFixed(2) + "s" : Math.round(v) + "ms"); }

  function tile(parent, label, value, sub) {
    var t = el("div", "tile");
    t.appendChild(el("div", "tile-val", value));
    t.appendChild(el("div", "tile-label", label));
    if (sub != null) t.appendChild(el("div", "tile-sub", sub));
    parent.appendChild(t);
  }

  function renderKPIs(d) {
    var g = document.getElementById("kpis"); clear(g);
    var k = d.last30 || {}, t = d.today || {}, w = d.last7 || {};
    tile(g, "Page views", fmt(k.views), "today " + fmt(t.views) + " · 7d " + fmt(w.views));
    tile(g, "Sessions", fmt(k.sessions), "today " + fmt(t.sessions) + " · 7d " + fmt(w.sessions));
    tile(g, "Pages / session", (k.pagesPerSession || 0).toFixed(2), "engagement depth");
    tile(g, "Bounce rate", (k.bounceRatePct || 0) + "%", "single-page sessions");
    tile(g, "Avg. session", dur(k.avgSessionSec), "duration");
    tile(g, "New visitors", (k.newVisitorPct || 0) + "%", fmt(k.newVisitors) + " new · " + fmt(k.returningVisitors) + " returning");
  }

  function renderVitals(d) {
    var g = document.getElementById("vitals"); clear(g);
    var v = d.webVitals || {};
    var defs = [["LCP", "lcp", ms], ["INP", "inp", ms], ["CLS", "cls", function (x) { return x == null ? "—" : x.toFixed(3); }], ["FCP", "fcp", ms], ["TTFB", "ttfb", ms]];
    defs.forEach(function (def) {
      var m = v[def[1]] || {}; var card = el("div", "tile vital " + (m.rating || "na"));
      card.appendChild(el("div", "tile-val", def[2](m.p75)));
      card.appendChild(el("div", "tile-label", def[0] + " · p75"));
      var badge = el("div", "vital-badge", (m.rating || "no data").replace("-", " "));
      card.appendChild(badge);
      card.appendChild(el("div", "tile-sub", "n=" + fmt(m.n || 0)));
      g.appendChild(card);
    });
  }

  function renderTrend(d) {
    var host = document.getElementById("trend"); clear(host);
    var s = d.series || [];
    if (!s.length) { host.appendChild(el("p", "dash-empty", "No daily data yet.")); return; }
    var W = 900, H = 220, padL = 40, padB = 26, padT = 10, padR = 10;
    var iw = W - padL - padR, ih = H - padT - padB;
    var maxV = Math.max(1, Math.max.apply(null, s.map(function (x) { return x.views; })));
    var maxS = Math.max(1, Math.max.apply(null, s.map(function (x) { return x.sessions; })));
    var bw = iw / s.length;
    var root = svg("svg", { viewBox: "0 0 " + W + " " + H, class: "trend-svg", role: "img", "aria-label": "Daily views and sessions" });
    // y gridlines + labels (views scale)
    for (var i = 0; i <= 4; i++) {
      var gy = padT + ih * (i / 4);
      root.appendChild(svg("line", { x1: padL, y1: gy, x2: W - padR, y2: gy, class: "grid" }));
      root.appendChild(svg("text", { x: 4, y: gy + 4, class: "axis" })).textContent = fmt(Math.round(maxV * (1 - i / 4)));
    }
    // views bars
    s.forEach(function (x, idx) {
      var h = (x.views / maxV) * ih, bx = padL + idx * bw;
      var r = svg("rect", { x: bx + bw * 0.12, y: padT + ih - h, width: bw * 0.76, height: Math.max(0, h), class: "bar-views", rx: 1 });
      r.appendChild(svg("title", {})).textContent = x.day + ": " + fmt(x.views) + " views, " + fmt(x.sessions) + " sessions";
      root.appendChild(r);
    });
    // sessions line
    var pts = s.map(function (x, idx) { return (padL + idx * bw + bw / 2) + "," + (padT + ih - (x.sessions / maxS) * ih); }).join(" ");
    root.appendChild(svg("polyline", { points: pts, class: "line-sessions" }));
    // first/last date labels
    root.appendChild(svg("text", { x: padL, y: H - 8, class: "axis" })).textContent = s[0].day.slice(5);
    var last = svg("text", { x: W - padR, y: H - 8, class: "axis end" }); last.textContent = s[s.length - 1].day.slice(5); root.appendChild(last);
    host.appendChild(root);
    var legend = el("div", "legend-row");
    var a = el("span", "lg"); a.appendChild(el("i", "sw sw-views")); a.appendChild(document.createTextNode(" Views"));
    var b = el("span", "lg"); b.appendChild(el("i", "sw sw-sessions")); b.appendChild(document.createTextNode(" Sessions"));
    legend.appendChild(a); legend.appendChild(b); host.appendChild(legend);
  }

  function renderBars(id, entries) {
    var host = document.getElementById(id); clear(host);
    if (!entries || !entries.length) { host.appendChild(el("p", "dash-empty", "No data yet.")); return; }
    var max = Math.max.apply(null, entries.map(function (e) { return e.v; })) || 1;
    entries.forEach(function (e) {
      var row = el("div", "bar-row");
      row.appendChild(el("span", "bar-label", e.k));
      var track = el("div", "bar-track");
      var fill = el("div", "bar-fill");
      fill.style.width = Math.max(2, (e.v / max) * 100) + "%"; // CSSOM (CSP-safe)
      track.appendChild(fill); row.appendChild(track);
      row.appendChild(el("span", "bar-val", fmt(e.v)));
      host.appendChild(row);
    });
  }
  function objToEntries(obj) { return Object.keys(obj || {}).map(function (k) { return { k: k, v: obj[k] }; }).sort(function (a, b) { return b.v - a.v; }); }

  function renderTiming(d) {
    var g = document.getElementById("timing"); clear(g);
    var v = d.webVitals || {};
    [["Page load", "load"], ["TTFB", "ttfb"], ["First paint (FCP)", "fcp"], ["Time on page", "dwell"]].forEach(function (def) {
      var m = v[def[1]] || {}; var t = el("div", "tile");
      var isDwell = def[1] === "dwell";
      var val = isDwell ? dur(m.p50) : ms(m.p50);
      t.appendChild(el("div", "tile-val", val));
      t.appendChild(el("div", "tile-label", def[0] + " · p50"));
      t.appendChild(el("div", "tile-sub", "p75 " + (isDwell ? dur(m.p75) : ms(m.p75)) + " · p95 " + (isDwell ? dur(m.p95) : ms(m.p95))));
      g.appendChild(t);
    });
  }

  function render(d) {
    document.getElementById("empty").classList.toggle("hidden", (d.last30 && d.last30.views) > 0);
    var rt = document.getElementById("realtime");
    rt.textContent = "● " + fmt(d.realtimeActive) + " active now";
    document.getElementById("updated").textContent = "Updated " + new Date(d.generatedAt).toLocaleTimeString();
    document.getElementById("range-note").textContent = " · " + fmt(d.daysTracked) + " day(s) tracked";
    renderKPIs(d); renderVitals(d); renderTrend(d);
    renderBars("pages", d.topPages); renderBars("sources", objToEntries(d.sources));
    renderBars("devices", objToEntries(d.devices)); renderBars("conns", d.connections);
    renderTiming(d);
  }

  function load() {
    fetch(API, { headers: { "Accept": "application/json" } })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(render)
      .catch(function () {
        var e = document.getElementById("empty");
        e.textContent = "Couldn't load metrics" + (KEY ? "" : " (this dashboard may require a ?key=…)") + ".";
        e.classList.remove("hidden");
      });
  }
  load();
  setInterval(function () { if (document.visibilityState === "visible") load(); }, 30000);
})();
