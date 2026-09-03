// lib/metrics.js — first-party, zero-dependency, privacy-preserving web analytics.
//
// No third parties, no cookies, no PII: the client beacon sends only anonymous aggregate
// signals (route, coarse source/device, timing numbers, an ephemeral per-tab session id).
// Everything here is bounded memory so it can run for years on the 512MB free tier:
//   - daily buckets, only the last DAYS_KEPT are retained;
//   - timing metrics use FIXED-bucket histograms (percentiles are computed from bucket
//     counts, so memory never grows with traffic);
//   - the session map is capped + pruned by idle time.
// State is snapshotted to disk (METRICS_DIR, default os.tmpdir) and reloaded on boot, so it
// survives soft restarts; a full Render free-tier spin-down (idle ~15m, ephemeral disk)
// still resets history — point METRICS_DIR at a persistent disk to keep it permanently.

const fs = require("fs");
const os = require("os");
const path = require("path");

const DAYS_KEPT = 90;
const SESSION_IDLE_MS = 30 * 60 * 1000; // a session ends after 30 min of inactivity
const SESSIONS_CAP = 20000;             // hard bound on the live session map
const REALTIME_MS = 5 * 60 * 1000;      // "active now" window
const DIR = process.env.METRICS_DIR || path.join(os.tmpdir(), "sports-depth-metrics");
const FILE = path.join(DIR, "metrics.json");

const SOURCES = ["direct", "search", "social", "other"];
const DEVICES = ["mobile", "tablet", "desktop"];
const MAX_PATHS = 60;   // bounded label cardinality; overflow folds into "(other)"
const MAX_CONNS = 12;

// Fixed histogram bucket edges (upper bounds) per timing metric. Percentiles interpolate
// within the bucket holding the target rank — the standard RUM approach, O(1) memory.
const EDGES = {
  ttfb: [50, 100, 200, 400, 600, 800, 1200, 1800, 2500, 4000, 8000],
  fcp: [500, 1000, 1500, 1800, 2200, 2800, 3500, 4500, 6000, 8000, 12000],
  lcp: [500, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 7000, 10000, 15000],
  load: [500, 1000, 1500, 2500, 3500, 5000, 7000, 10000, 15000, 20000, 30000],
  inp: [50, 100, 150, 200, 300, 400, 500, 700, 1000, 1500, 2500],
  cls: [0.01, 0.03, 0.05, 0.08, 0.1, 0.15, 0.25, 0.4, 0.6, 0.9, 1.5], // Core Web Vitals thresholds around 0.1 / 0.25
  dwell: [1, 3, 5, 10, 20, 30, 60, 120, 300, 600, 1200], // seconds on page
};
const VITALS = ["ttfb", "fcp", "lcp", "load", "inp", "cls"];

function newHist(edges) { return { e: edges, c: new Array(edges.length + 1).fill(0) }; }
function histAdd(h, v) {
  if (typeof v !== "number" || !isFinite(v) || v < 0) return;
  let i = 0; while (i < h.e.length && v > h.e[i]) i++;
  h.c[i]++;
}
function histCount(h) { return h.c.reduce((a, b) => a + b, 0); }
// Approximate percentile from bucket counts (linear interp across the containing bucket).
function histPct(h, p) {
  const n = histCount(h); if (!n) return null;
  const target = p * n;
  let cum = 0;
  for (let i = 0; i < h.c.length; i++) {
    const prev = cum; cum += h.c[i];
    if (cum >= target) {
      const lo = i === 0 ? 0 : h.e[i - 1];
      const hi = i < h.e.length ? h.e[i] : h.e[h.e.length - 1] * 1.5;
      const frac = h.c[i] ? (target - prev) / h.c[i] : 0;
      return +(lo + (hi - lo) * frac).toFixed(3);
    }
  }
  return h.e[h.e.length - 1];
}
function mergeHist(a, b) { const o = newHist(a.e); for (let i = 0; i < o.c.length; i++) o.c[i] = (a.c[i] || 0) + (b.c[i] || 0); return o; }

function todayKey(now) { return new Date(now).toISOString().slice(0, 10); }

function newDay() {
  const d = {
    views: 0, sessions: 0, newVisitors: 0, returningVisitors: 0,
    multiPageSessions: 0, sumSessionSec: 0, finishedSessions: 0,
    byPath: {}, bySource: {}, byDevice: {}, byConn: {},
    vit: {},
  };
  for (const k of Object.keys(EDGES)) d.vit[k] = newHist(EDGES[k]);
  return d;
}

const state = { days: {}, sessions: new Map() };

function pruneDays() {
  const keys = Object.keys(state.days).sort();
  while (keys.length > DAYS_KEPT) delete state.days[keys.shift()];
}
function getDay(now) {
  const k = todayKey(now);
  if (!state.days[k]) { state.days[k] = newDay(); pruneDays(); }
  return state.days[k];
}
function bump(obj, key, cap) {
  if (obj[key] != null) { obj[key]++; return; }
  if (cap && Object.keys(obj).length >= cap) { obj["(other)"] = (obj["(other)"] || 0) + 1; return; }
  obj[key] = 1;
}
// Finalize an ended session into its day's duration rollup.
function finalizeSession(s) {
  const day = state.days[s.day]; if (!day) return;
  day.finishedSessions++;
  day.sumSessionSec += Math.min(4 * 3600, Math.max(0, (s.lastTs - s.firstTs) / 1000));
}
function pruneSessions(now) {
  for (const [sid, s] of state.sessions) {
    if (now - s.lastTs > SESSION_IDLE_MS) { finalizeSession(s); state.sessions.delete(sid); }
  }
  // Hard cap: evict oldest-seen sessions (finalizing them) if still over.
  if (state.sessions.size > SESSIONS_CAP) {
    const sorted = [...state.sessions.entries()].sort((a, b) => a[1].lastTs - b[1].lastTs);
    for (let i = 0; i < sorted.length && state.sessions.size > SESSIONS_CAP; i++) {
      finalizeSession(sorted[i][1]); state.sessions.delete(sorted[i][0]);
    }
  }
}

const clampNum = (v, max) => (typeof v === "number" && isFinite(v) && v >= 0 ? Math.min(v, max) : null);

// Ingest one beacon event. Returns true if counted. Never throws.
function record(ev, now = Date.now()) {
  try {
    if (!ev || typeof ev !== "object") return false;
    const day = getDay(now);
    day.views++;

    const p = typeof ev.p === "string" && ev.p ? ev.p.slice(0, 32) : "(unknown)";
    bump(day.byPath, p, MAX_PATHS);
    bump(day.bySource, SOURCES.includes(ev.ref) ? ev.ref : "other", 0);
    bump(day.byDevice, DEVICES.includes(ev.dev) ? ev.dev : "desktop", 0);
    if (typeof ev.conn === "string" && /^[a-z0-9-]{1,8}$/.test(ev.conn)) bump(day.byConn, ev.conn, MAX_CONNS);

    const dwell = clampNum(ev.dwell, 4 * 3600); // seconds
    if (dwell != null) histAdd(day.vit.dwell, dwell);
    const vit = ev.vit || {};
    for (const k of VITALS) { const val = clampNum(vit[k], k === "cls" ? 10 : 120000); if (val != null) histAdd(day.vit[k], val); }

    // Sessions (anonymous per-tab id). First sighting = a new session.
    const sid = typeof ev.sid === "string" && /^[a-z0-9]{6,40}$/.test(ev.sid) ? ev.sid : null;
    if (sid) {
      let s = state.sessions.get(sid);
      if (!s) {
        s = { day: todayKey(now), firstTs: now, lastTs: now, pv: 1 };
        state.sessions.set(sid, s);
        day.sessions++;
        if (ev.nv) day.newVisitors++; else day.returningVisitors++;
        pruneSessions(now);
      } else {
        s.lastTs = now; s.pv++;
        if (s.pv === 2) { const d2 = state.days[s.day]; if (d2) d2.multiPageSessions++; }
      }
    }
    return true;
  } catch { return false; }
}

// ---- summary (dashboard payload) ----
function windowKeys(days) {
  const keys = Object.keys(state.days).sort();
  return keys.slice(-days);
}
function sumField(keys, f) { return keys.reduce((a, k) => a + (state.days[k][f] || 0), 0); }
function topN(obj, n) { return Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ k, v })); }
function mergeMaps(keys, field) {
  const out = {};
  for (const k of keys) for (const [kk, vv] of Object.entries(state.days[k][field] || {})) out[kk] = (out[kk] || 0) + vv;
  return out;
}
function vitalsFor(keys) {
  const out = {};
  for (const m of Object.keys(EDGES)) {
    let h = newHist(EDGES[m]);
    for (const k of keys) if (state.days[k].vit[m]) h = mergeHist(h, state.days[k].vit[m]);
    out[m] = { p50: histPct(h, 0.5), p75: histPct(h, 0.75), p95: histPct(h, 0.95), n: histCount(h) };
  }
  return out;
}
function kpisFor(keys, active) {
  const views = sumField(keys, "views"), sessions = sumField(keys, "sessions");
  const multi = sumField(keys, "multiPageSessions");
  // Session duration = finalized (idle >30m) rollups PLUS in-progress sessions' elapsed
  // time so far, so the average is meaningful immediately instead of reading 0s until the
  // first session ages out — the common case on a low-traffic site.
  const inWin = new Set(keys);
  let sumDur = sumField(keys, "sumSessionSec"), count = sumField(keys, "finishedSessions");
  if (active) for (const [day, a] of Object.entries(active)) if (inWin.has(day)) { sumDur += a.sum; count += a.count; }
  const nv = sumField(keys, "newVisitors"), rv = sumField(keys, "returningVisitors");
  return {
    views, sessions,
    pagesPerSession: sessions ? +(views / sessions).toFixed(2) : 0,
    bounceRatePct: sessions ? +(100 * (1 - multi / sessions)).toFixed(1) : 0,
    avgSessionSec: count ? Math.round(sumDur / count) : 0,
    newVisitors: nv, returningVisitors: rv,
    newVisitorPct: (nv + rv) ? +(100 * nv / (nv + rv)).toFixed(1) : 0,
  };
}
function summary(now = Date.now()) {
  pruneSessions(now);
  const active = [...state.sessions.values()].filter((s) => now - s.lastTs <= REALTIME_MS).length;
  const k30 = windowKeys(30), k7 = windowKeys(7), kToday = [todayKey(now)].filter((k) => state.days[k]);
  // In-progress session durations (elapsed so far), grouped by their start day.
  const activeDur = {};
  for (const s of state.sessions.values()) {
    const d = Math.min(4 * 3600, Math.max(0, (s.lastTs - s.firstTs) / 1000));
    (activeDur[s.day] = activeDur[s.day] || { sum: 0, count: 0 }).sum += d;
    activeDur[s.day].count += 1;
  }
  const series = windowKeys(30).map((k) => ({
    day: k, views: state.days[k].views, sessions: state.days[k].sessions,
  }));
  const vitalScore = (m, p75) => {
    if (p75 == null) return "na";
    const g = { lcp: [2500, 4000], inp: [200, 500], cls: [0.1, 0.25], fcp: [1800, 3000], ttfb: [800, 1800] }[m];
    if (!g) return "na";
    return p75 <= g[0] ? "good" : p75 <= g[1] ? "needs-improvement" : "poor";
  };
  const vit = vitalsFor(k30);
  const webVitals = {};
  for (const m of Object.keys(vit)) webVitals[m] = { ...vit[m], rating: vitalScore(m, vit[m].p75) };
  return {
    generatedAt: new Date(now).toISOString(),
    realtimeActive: active,
    today: kpisFor(kToday, activeDur),
    last7: kpisFor(k7, activeDur),
    last30: kpisFor(k30, activeDur),
    series,
    topPages: topN(mergeMaps(k30, "byPath"), 12),
    sources: mergeMaps(k30, "bySource"),
    devices: mergeMaps(k30, "byDevice"),
    connections: topN(mergeMaps(k30, "byConn"), 6),
    webVitals,
    daysTracked: Object.keys(state.days).length,
  };
}

// ---- persistence (survives soft restarts; ephemeral disk resets on spin-down) ----
function save() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const sessions = [...state.sessions.entries()].map(([sid, s]) => [sid, s]);
    fs.writeFileSync(FILE, JSON.stringify({ v: 1, days: state.days, sessions }));
    return true;
  } catch { return false; }
}
function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (raw && raw.days) {
      // Re-hydrate; tolerate schema drift by only keeping known day fields/histograms.
      for (const [k, d] of Object.entries(raw.days)) {
        const nd = newDay();
        Object.assign(nd, { views: d.views | 0, sessions: d.sessions | 0, newVisitors: d.newVisitors | 0, returningVisitors: d.returningVisitors | 0, multiPageSessions: d.multiPageSessions | 0, sumSessionSec: d.sumSessionSec || 0, finishedSessions: d.finishedSessions | 0, byPath: d.byPath || {}, bySource: d.bySource || {}, byDevice: d.byDevice || {}, byConn: d.byConn || {} });
        if (d.vit) for (const m of Object.keys(nd.vit)) if (d.vit[m] && Array.isArray(d.vit[m].c) && d.vit[m].c.length === nd.vit[m].c.length) nd.vit[m].c = d.vit[m].c;
        state.days[k] = nd;
      }
      pruneDays();
    }
    if (Array.isArray(raw.sessions)) for (const [sid, s] of raw.sessions) if (sid && s) state.sessions.set(sid, s);
    return true;
  } catch { return false; }
}

module.exports = { record, summary, save, load, _state: state, _hist: { newHist, histAdd, histPct } };
