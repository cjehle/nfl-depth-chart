const test = require("node:test");
const assert = require("node:assert");
const metrics = require("../lib/metrics.js");

test("histogram percentile is bounded and monotonic", () => {
  const { newHist, histAdd, histPct } = metrics._hist;
  const h = newHist([10, 20, 30, 40, 50]);
  for (const v of [5, 15, 15, 25, 35, 45, 55]) histAdd(h, v);
  const p50 = histPct(h, 0.5), p95 = histPct(h, 0.95);
  assert.ok(p50 >= 0 && p50 <= 60, `p50 in range: ${p50}`);
  assert.ok(p95 >= p50, `p95 (${p95}) >= p50 (${p50})`);
  assert.equal(histPct(newHist([1, 2]), 0.5), null, "empty histogram → null");
});

test("record + summary computes standard KPIs (views, sessions, pages/session, bounce, sources, vitals)", () => {
  const now = Date.UTC(2026, 5, 15, 12, 0, 0);
  const mk = (sid, nv) => ({ p: "/nfl", ref: "search", dev: "mobile", conn: "4g", sid, nv, dwell: 30, vit: { lcp: 1200, cls: 0.05, ttfb: 150, fcp: 900, inp: 80, load: 2000 } });
  // one multi-page session (3 views) + one single-page session (1 view = a bounce)
  metrics.record(mk("sessone", true), now);
  metrics.record(mk("sessone", true), now);
  metrics.record(mk("sessone", true), now);
  metrics.record(mk("sesstwo", false), now);

  const s = metrics.summary(now);
  assert.equal(s.last30.views, 4, "4 page views");
  assert.equal(s.last30.sessions, 2, "2 distinct sessions");
  assert.equal(s.last30.pagesPerSession, 2, "pages/session = views/sessions");
  assert.equal(s.last30.bounceRatePct, 50, "one of two sessions bounced");
  assert.equal(s.last30.newVisitorPct, 50, "one new, one returning");
  assert.equal(s.sources.search, 4, "all four views from search");
  assert.equal(s.devices.mobile, 4, "all four on mobile");
  assert.ok(s.topPages.some((p) => p.k === "/nfl" && p.v === 4), "top page /nfl with 4 views");
  assert.ok(s.webVitals.lcp.p75 != null && s.webVitals.lcp.rating === "good", "LCP p75 present + rated good (<=2500)");
  assert.equal(s.realtimeActive, 2, "both sessions active within the realtime window");
});

test("record ignores malformed input without throwing", () => {
  assert.doesNotThrow(() => { metrics.record(null); metrics.record("x"); metrics.record({ vit: "bad", sid: 123 }); });
});
