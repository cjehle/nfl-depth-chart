// server.js
// ---------------------------------------------------------------------------
// ONE server for the whole site (all sports), no external libraries.
//
//   http://localhost:3000/        landing page (pick a sport)
//   http://localhost:3000/nfl     NFL — offense vs defense, personnel, seasons, Madden
//   http://localhost:3000/nhl     NHL — starting lines on the rink
//   http://localhost:3000/nba     NBA — starting five on the court
//   http://localhost:3000/mls     MLS — starting XI on the pitch
//
// APIs:
//   NFL:      GET /api/depth?team=&year=&fresh=   GET /api/ages?ids=&year=
//   others:   GET /api/config?sport=              GET /api/lineup?sport=&team=&fresh=
//   GET /healthz
//
// Run:  node server.js
// ---------------------------------------------------------------------------

const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { stats, cached, buildLineup, writeDisk, readDisk, cacheStats, fetchJson, lineupKey, recentUpstream } = require("./lib/espn.js");
const ratings = require("./lib/ratings.js"); // coverageSnapshot() for /healthz staleness
const metrics = require("./lib/metrics.js"); // first-party privacy-preserving analytics (ingest + dashboard summary)
// Load the NFL engine defensively: if it ever fails to load, the NFL routes are
// disabled but the rest of the site still runs.
let nfl = null;
try { nfl = require("./lib/nfl.js"); } catch (e) { console.error("NFL engine failed to load (NFL routes disabled):", e && e.message); }
// lib/nfl.js re-exports NFL_TEAMS/SEASON/currentNflSeason but NOT DEFAULT_TEAM_ID, so
// read it straight from the teams module (the same source nfl.js uses) for the NFL data
// island + preload. Defensive: if it ever fails to load, fall back to Buffalo (2) so the
// island/preload still emit rather than throwing during head injection.
let DEFAULT_TEAM_ID = 2;
try { ({ DEFAULT_TEAM_ID } = require("./public/nfl/teams.js")); } catch (e) { console.error("teams.js load failed (DEFAULT_TEAM_ID=2 fallback):", e && e.message); }

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
// Optional gate for the analytics dashboard + its summary API. Empty (the default) = the
// dashboard is PUBLIC (aggregate, no PII). Set METRICS_TOKEN to require ?key=<token> and
// 404 without it. The ingest endpoint (/api/metric) is always open — it must accept beacons.
const METRICS_TOKEN = process.env.METRICS_TOKEN || "";
const LINEUP_TTL = (Number(process.env.LINEUP_TTL_HOURS) || 12) * 3600e3;

// Surface sports (rink/court/pitch/diamond/field). Loaded one-by-one so a single
// broken config can never take down the whole server — it's just skipped.
const SURFACE = {};
for (const key of ["nhl", "nba", "mls", "cbb", "cfb", "mlb", "mch", "wnba", "epl", "laliga", "bundesliga", "seriea", "ligue1", "ligamx", "nwsl", "ucl"]) {
  try {
    const cfg = require(`./sports/${key}.js`);
    if (!Array.isArray(cfg.teams) || !cfg.teams.length) throw new Error("missing/empty teams array");
    SURFACE[key] = cfg; // only register a fully-valid config (so startup can't throw later)
  } catch (e) { console.error(`sport "${key}" failed to load (skipped):`, e && e.message); }
}
const surfaceTeamSets = Object.fromEntries(Object.entries(SURFACE).map(([k, cfg]) => [k, new Map(cfg.teams.map((t) => [String(t.id), t]))]));
function publicConfig(sport) {
  const cfg = SURFACE[sport];
  return {
    sport: cfg.key, name: cfg.name, emoji: cfg.emoji, title: cfg.title, tagline: cfg.tagline,
    // ESPN web slug (soccer leagues all map to "soccer"): lets the client derive headshot +
    // player-page URLs from an athlete id, so the lineup payload no longer ships them.
    webSlug: cfg.espn && (cfg.espn.sport === "soccer" ? "soccer" : cfg.espn.league),
    surface: cfg.surface, note: cfg.note, defaults: cfg.defaults, dualUnit: !!cfg.dualUnit, singleTeam: !!cfg.singleTeam, history: !!cfg.history, seasonEndYear: !!cfg.seasonEndYear, formations: cfg.formations || null, formationMode: cfg.formationMode || null, unitFormations: cfg.unitFormations || null, unitFormationLabels: cfg.unitFormationLabels || null, units: cfg.units || null, unitLabels: cfg.unitLabels || null,
    // Only the fields the client actually reads: id + name (pickers), conf (optgroups +
    // conference filter). The rendered team's abbr/color/logo come from the LINEUP payload,
    // not here — so dropping them keeps the inlined config data-island small (biggest win
    // on CBB's 362-team page, ~56% smaller brotli) without changing anything on screen.
    teams: cfg.teams.map((t) => ({ id: String(t.id), name: t.name, conf: t.conf })),
  };
}

// Edge cache policy for lineup/depth JSON: a CDN (Cloudflare) may serve a cached
// copy for ~2 min and keep serving a stale one for 10 min while it revalidates in
// the background. Keeps the cold Render origin + ESPN off most requests' critical
// path; the client still auto-refreshes every 4 min, so users stay current.
const LINEUP_CACHE = "public, s-maxage=120, stale-while-revalidate=600";
// Per-generation JSON memo: serialize + hash + compress a lineup/depth payload ONCE,
// keyed by the cached data object itself (WeakMap → GC'd with the object, bounded by
// the existing store caps, never extends a lifetime). Repeat sends of the same
// generation are a lookup + buffer write — no re-stringify, no re-hash, no sync gzip.
// The ETag hashes stable parts only (NOT volatile `updated`/`fetchedAt`), so a no-op
// rebuild yields the same tag and the client's 4-min refresh / a CDN revalidation gets
// a 304 (headers only) instead of re-downloading identical JSON. Brotli-11 lands async
// (gzip serves the first hit) so no request blocks on it — same pattern as static/pages.
const jsonMemo = new WeakMap();
function sendCachedJson(req, res, data, parts, headers) {
  let m = jsonMemo.get(data);
  if (!m) {
    // Cheap up front: only the stable-parts ETag (small array stringify + sha1). Body +
    // gzip + brotli are built lazily below — never on a request that 304s.
    const etag = 'W/"' + crypto.createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 20) + '"';
    m = { etag, buf: undefined, gz: undefined, br: undefined };
    jsonMemo.set(data, m);
  }
  // Conditional check BEFORE serializing/compressing: a no-op rebuild (same stable parts,
  // only volatile updated/fetchedAt changed) 304s here with zero stringify/gzip/brotli work
  // — the steady state for the client's 4-min refresh and CDN revalidations.
  if (req.headers["if-none-match"] === m.etag) { res.writeHead(304, { ETag: m.etag, ...SECURITY_HEADERS, ...headers }); res.end(); return 304; }
  if (m.buf === undefined) {
    m.buf = Buffer.from(JSON.stringify(data));
    if (m.buf.length > 512) {
      m.gz = zlib.gzipSync(m.buf, { level: 9 });
      zlib.brotliCompress(m.buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }, (err, b) => { if (!err) m.br = b; });
    }
  }
  respond(req, res, 200, m.buf, MIME[".json"], { ...headers, ETag: m.etag, gz: m.gz, br: m.br });
  return 200;
}
// Surface lineup cache (TTL + single-flight + disk last-good), keyed by sport+team.
const lineupStore = new Map();
async function getLineup(sport, teamId, fresh, unit, year, formation) {
  const key = lineupKey(sport, teamId, unit, year, formation);
  const existing = lineupStore.get(key);
  // fresh=1 (the client always sends it) drops a >60s-old entry so the next read rebuilds.
  // EXCEPT a boot-primed seed / last-good, which is inserted with time:0 — deleting that
  // would defeat the cold-start priming (first hit after a Render spin-down would block on
  // a full ESPN rebuild instead of serving the seed instantly). Keep time:0 entries so
  // cached() serves them via stale-while-revalidate and refreshes in the background; a
  // normal warm entry (real timestamp) still rebuilds as before.
  if (fresh) { if (existing && "value" in existing && existing.time !== 0 && Date.now() - existing.time > 60000) lineupStore.delete(key); }
  else if (existing && "value" in existing) stats.cacheHits++;
  try {
    return await cached(lineupStore, key, LINEUP_TTL, async () => {
      const data = await buildLineup(SURFACE[sport], surfaceTeamSets[sport].get(String(teamId)), unit, year || null, formation || null);
      // Completeness gate: a build with far fewer chips than expected (partial ESPN
      // drift) must NOT be persisted as last-good — that would poison the durable
      // cold-start fallback. Prefer the committed disk copy when we have one; otherwise
      // serve the thin build (never leave a surface empty) but still don't write it.
      const n = (data.chips || []).length, exp = data.expectedSlots || 0;
      if (exp && n < 0.6 * exp) {
        const hit = readDisk(key);
        if (hit) { console.error(`degraded build ${key}: ${n}/${exp} chips — serving ${hit.source}`); return { ...hit.data, stale: true, source: hit.source }; }
        return data;
      }
      writeDisk(key, data);
      return data;
    }, 600); // bound: ~1000 teams × units × seasons × formations is unbounded otherwise
  } catch (err) {
    // Upstream failed on a cold key (no in-memory value) → serve the durable copy:
    // this instance's last-good, else the committed seed. Tag it stale so the client
    // can say so honestly instead of passing a canned snapshot off as live.
    const hit = readDisk(key);
    if (hit) { console.error(`serving ${hit.source} for ${key}: ${err.message}`); return { ...hit.data, stale: true, source: hit.source }; }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Lazy per-player season stat line (fetched only when a depth popover opens).
// ESPN publishes athlete season stats for the US pro/college sports but not for
// soccer, so soccer returns an empty line. Cached ~6h per player/season.
// ---------------------------------------------------------------------------
const statStore = new Map();
const numOf = (x) => parseFloat(String(x == null ? "" : x).replace(/,/g, "")) || 0;
const compact = (pairs) => pairs.filter(([, v]) => v != null && v !== "" && String(v) !== "-").map(([k, v]) => ({ k, v: String(v) }));
function statLine(group, m) {
  if (group === "basketball") return compact([["PPG", m.avgPoints], ["RPG", m.avgRebounds], ["APG", m.avgAssists]]);
  if (group === "hockey") {
    if (numOf(m.shotsAgainst) > 0) return compact([["GAA", m.avgGoalsAgainst], ["SV%", m.savePct], ["GP", m.games]]);
    return compact([["G", m.goals], ["A", m.assists], ["PTS", m.points]]);
  }
  if (group === "baseball") {
    if (numOf(m.inningsPitched) > 0 && numOf(m.atBats) < 20) return compact([["ERA", m.ERA], ["W-L", `${m.wins || 0}-${m.losses || 0}`], ["K", m.strikeouts]]);
    return compact([["AVG", m.avg], ["HR", m.homeRuns], ["RBI", m.RBIs]]);
  }
  if (group === "football") {
    const py = numOf(m.passingYards), ry = numOf(m.rushingYards), rcy = numOf(m.receivingYards);
    if (py > 0 && py >= ry && py >= rcy) return compact([["YDS", m.passingYards], ["TD", m.passingTouchdowns], ["CMP%", m.completionPct]]);
    if (ry > 0 && ry >= rcy) return compact([["RUSH", m.rushingYards], ["TD", m.rushingTouchdowns]]);
    if (rcy > 0) return compact([["REC", m.receptions], ["YDS", m.receivingYards], ["TD", m.receivingTouchdowns]]);
  }
  return [];
}
async function playerStats(sportKey, id, year) {
  const espnMap = SURFACE[sportKey] ? SURFACE[sportKey].espn : (sportKey === "nfl" ? { sport: "football", league: "nfl" } : null);
  if (!espnMap || espnMap.sport === "soccer") return { line: [] }; // no soccer athlete stats upstream
  const group = espnMap.sport;
  const key = `${sportKey}:${id}:${year || ""}`;
  return cached(statStore, key, 6 * 3600e3, async () => {
    // Probe the CURRENT season first. ESPN labels NBA/NHL seasons by their END year
    // (2027 = the 2026-27 season) and rolls over in the fall — matching the lineup
    // builders — so mid-season we must ask for the end-year, not the raw calendar year,
    // or the popover shows LAST season's PPG/GAA next to a current-season lineup.
    const now = new Date(), nowY = now.getUTCFullYear();
    const cfg = SURFACE[sportKey];
    const cur = cfg && cfg.seasonEndYear ? (now.getUTCMonth() >= 8 ? nowY + 1 : nowY) : nowY;
    const years = year ? [year] : [cur, cur - 1, cur - 2];
    for (const yr of years) {
      try {
        const d = await fetchJson(`https://sports.core.api.espn.com/v2/sports/${espnMap.sport}/leagues/${espnMap.league}/seasons/${yr}/types/2/athletes/${id}/statistics`, { timeout: 6000, retries: 0 });
        const cats = d && d.splits && d.splits.categories;
        if (cats && cats.length) {
          const m = {};
          for (const c of cats) for (const s of (c.stats || [])) if (s.name && m[s.name] == null) m[s.name] = s.displayValue;
          const line = statLine(group, m);
          if (line.length) return { season: yr, line };
        }
      } catch {}
    }
    return { line: [] };
  }, 2000).catch(() => ({ line: [] })); // bound: one entry per player/season viewed
}


// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon", ".png": "image/png", ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};
// ---- Critical (above-the-fold) CSS, inlined in <head> for the app routes ----
// A small, self-contained sheet (NOT read from the stylesheets) that paints the dark
// background, top nav, topbar, view toggle, and the surface/field aspect box before the
// full stylesheet arrives — so a cold load doesn't flash white or reflow the field in.
// The full <link rel=stylesheet> sheets still load and override these; this is only the
// first-paint layer. Keep it hand-written and ~1.5-3KB. It's injected as an inline
// <style>, so to satisfy the strict style-src CSP its sha256 is computed here at module
// load and ADDED to the style-src directive below — the hash is DERIVED from this exact
// string and so can never drift from what's actually served.
const CRITICAL_CSS = `
*{box-sizing:border-box}
html,body{margin:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0b1f12;color:#eaf2ec}
.site-nav{display:flex;align-items:center;gap:10px;padding:10px 16px;background:#081109;border-bottom:1px solid #1c3b28}
.site-nav .site-brand{color:#eaf2ec;font-weight:800;text-decoration:none;font-size:15px}
.site-nav .site-links{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}
.topbar{max-width:900px;margin:0 auto;padding:18px 16px 6px}
.topbar h1{margin:0 0 4px;font-size:22px}
.view-toggle-row{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}
.view-toggle{display:flex;flex:1;background:#0c2416;border:1px solid #1c3b28;border-radius:10px;overflow:hidden}
.view-toggle button{flex:1;padding:10px 8px;background:transparent;color:#9fbcac;border:0;font-size:14px;font-weight:600}
.surface{position:relative;width:100%;min-width:520px;aspect-ratio:.82;border-radius:14px;background:#0f2a1a}
.field{position:relative;max-width:900px;margin:8px auto 40px;border:4px solid #ffffff33;border-radius:10px;background:#1b6e37}
`.trim();
const CRITICAL_CSS_HASH = "sha256-" + crypto.createHash("sha256").update(CRITICAL_CSS).digest("base64");

// ---- Display ads (Google AdSense) ----------------------------------------------------
// Entirely OFF until a valid publisher id is set, so the strict CSP / privacy posture /
// Web Vitals stay exactly as-is unless you opt in. In Render, set:
//   ADSENSE_CLIENT=ca-pub-XXXXXXXXXXXXXXXX   (+ ADSENSE_SLOT_FEED / _BANNER / _LANDING from
// your AdSense ad units). When set, the CSP below is widened for the ad domains, an ads
// config island is injected, /ads.txt is served, and the client loads ads AFTER consent.
const ADSENSE_CLIENT = (process.env.ADSENSE_CLIENT || "").trim();
const ADS_ON = /^ca-pub-\d{10,20}$/.test(ADSENSE_CLIENT);
const ADSENSE_SLOTS = { feed: (process.env.ADSENSE_SLOT_FEED || "").trim(), banner: (process.env.ADSENSE_SLOT_BANNER || "").trim(), landing: (process.env.ADSENSE_SLOT_LANDING || "").trim() };
// Ad-network origins added to the CSP ONLY when ADS_ON (kept as tight as AdSense allows).
const AD_CSP = {
  script: ["https://pagead2.googlesyndication.com", "https://partner.googleadservices.com", "https://tpc.googlesyndication.com", "https://www.googletagservices.com", "https://adservice.google.com"],
  frame: ["https://googleads.g.doubleclick.net", "https://tpc.googlesyndication.com", "https://www.google.com"],
  img: ["https://*.googlesyndication.com", "https://*.g.doubleclick.net", "https://*.google.com", "https://*.gstatic.com"],
  connect: ["https://pagead2.googlesyndication.com", "https://googleads.g.doubleclick.net", "https://*.google.com"],
};
const CSP = (function () {
  const d = [
    "default-src 'self'",
    "img-src 'self' data: https://*.espncdn.com" + (ADS_ON ? " " + AD_CSP.img.join(" ") : ""),
    // 'self' keeps the linked stylesheets working; the hash whitelists the single inline
    // <style> block (CRITICAL_CSS) injected per app route — derived from the same constant.
    "style-src 'self' '" + CRITICAL_CSS_HASH + "'",
    "script-src 'self' https://static.cloudflareinsights.com" + (ADS_ON ? " " + AD_CSP.script.join(" ") : ""),
    "connect-src 'self' https://cloudflareinsights.com" + (ADS_ON ? " " + AD_CSP.connect.join(" ") : ""),
    "base-uri 'none'", "frame-ancestors 'none'", "form-action 'none'",
  ];
  if (ADS_ON) d.push("frame-src " + AD_CSP.frame.join(" ")); // AdSense renders ads in iframes
  return d.join("; ");
})();
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  // Tell browsers to stick to HTTPS for a year (safe behind Cloudflare; ignored on plain-http localhost).
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
  "Content-Security-Policy": CSP,
};
function respond(req, res, status, body, contentType, extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  // Precomputed compressed variants (static assets + rendered pages, compressed
  // once per mtime) ride in on `extra`; strip them out so they don't leak into headers.
  const { gz: preGz, br: preBr, ...hdrExtra } = extra;
  const headers = { "Content-Type": contentType, ...SECURITY_HEADERS, ...hdrExtra };
  const compressible = /text|json|javascript|svg/.test(contentType);
  const isHead = req.method === "HEAD";
  // Always Vary on Accept-Encoding for compressible types so a shared/CDN cache
  // never hands a compressed body to a client that didn't ask for it (cache mixing).
  if (compressible) headers["Vary"] = "Accept-Encoding";
  // Content negotiation: prefer Brotli, then gzip. Precomputed buffers cost nothing
  // per request (the hot path for static/pages); dynamic JSON with no precomputed
  // form falls back to inline gzip (as before). Brotli is only ever served precomputed.
  let enc = null, out = null;
  if (compressible && buf.length > 512) {
    const ae = req.headers["accept-encoding"] || "";
    if (preBr && /\bbr\b/.test(ae)) { enc = "br"; out = preBr; }
    else if (preGz && /\bgzip\b/.test(ae)) { enc = "gzip"; out = preGz; }
    else if (/\bgzip\b/.test(ae)) { enc = "gzip"; out = zlib.gzipSync(buf); }
  }
  if (enc) {
    res.writeHead(status, { ...headers, "Content-Encoding": enc, "Content-Length": out.length });
    res.end(isHead ? undefined : out);
  } else {
    res.writeHead(status, { ...headers, "Content-Length": buf.length });
    res.end(isHead ? undefined : buf);
  }
}
const sendJson = (req, res, status, obj, extra) => respond(req, res, status, JSON.stringify(obj), MIME[".json"], extra);

const staticCache = new Map();
function serveFile(req, res, filePath) {
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return respond(req, res, 403, "Forbidden", "text/plain");
  let stat;
  try { stat = fs.statSync(filePath); } catch { return respond(req, res, 404, "Not found", "text/plain"); }
  if (stat.isDirectory()) return respond(req, res, 404, "Not found", "text/plain");
  let entry = staticCache.get(filePath);
  if (!entry || entry.mtimeMs !== stat.mtimeMs) {
    const body = fs.readFileSync(filePath);
    const mime = MIME[path.extname(filePath)] || "application/octet-stream";
    entry = { body, mtimeMs: stat.mtimeMs, etag: '"' + crypto.createHash("sha1").update(body).digest("hex").slice(0, 16) + '"', mime };
    // Compress once per mtime (gzip 9 / brotli 11) so the hot path never re-compresses
    // identical bytes — only for compressible types large enough to benefit. gzip is
    // computed sync (~1ms); brotli-11 is ~30ms and single-threaded, so it's done ASYNC
    // and the first request(s) serve gzip until entry.br lands — no request ever blocks
    // the event loop on brotli (critical on Render's throttled cold-start CPU).
    if (/text|json|javascript|svg/.test(mime) && body.length > 512) {
      entry.gz = zlib.gzipSync(body, { level: 9 });
      zlib.brotliCompress(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }, (err, buf) => { if (!err) entry.br = buf; });
    }
    staticCache.set(filePath, entry);
  }
  if (req.headers["if-none-match"] === entry.etag) { res.writeHead(304, { ETag: entry.etag, ...SECURITY_HEADERS }); return res.end(); }
  // Images/icons/fonts rarely change → cache them hard (7 days). Code assets
  // (js/css) get revalidated every load so a deploy is picked up immediately.
  const ext = path.extname(filePath);
  const longLived = /\.(png|jpe?g|gif|svg|ico|webp|avif|woff2?)$/i.test(ext);
  const cc = longLived ? "public, max-age=604800" : "public, max-age=0, must-revalidate";
  respond(req, res, 200, entry.body, entry.mime, { ETag: entry.etag, "Cache-Control": cc, gz: entry.gz, br: entry.br });
}
// ---- Per-route <head> injection: social share cards, icons, PWA, analytics ----
const SITE = process.env.SITE_URL || "https://billsdepthchart.com";
const escHtml = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const OG = {
  home: { title: "Depth Charts — every team's starting lineup", desc: "Starting lineups for the NFL, MLB, NBA, NHL, WNBA, MLS, college football, hoops & hockey, plus Europe's top soccer leagues — click any player for the full depth chart.", img: "/og/home.png", path: "/all" },
  dashboard: { title: "Site Metrics — Depth Charts", desc: "First-party, privacy-preserving analytics for the depth-chart site.", img: "/og/home.png", path: "/dashboard" },
  nfl: { title: "NFL Depth Charts — starters on the field", desc: "Any NFL team's starting offense vs defense on a field. Personnel, formations, past seasons, Madden ratings. Live from ESPN.", img: "/og/nfl.png", path: "/nfl" },
  nhl: { title: "NHL Starting Lineups on the Ice", desc: "Two teams' starting lines on the rink — click any player for the depth chart. Live from ESPN.", img: "/og/nhl.png", path: "/nhl" },
  nba: { title: "NBA Starting Fives on the Court", desc: "Two teams' starting fives + full depth chart at every position. Live from ESPN.", img: "/og/nba.png", path: "/nba" },
  mls: { title: "MLS Starting XIs on the Pitch", desc: "Each team's typical starting XI from recent matches, in its usual formation, with EA FC ratings. Live from ESPN.", img: "/og/mls.png", path: "/mls" },
  cfb: { title: "College Football Rosters on the Field", desc: "All FBS teams — one team's offense vs another's defense, by position. Live from ESPN.", img: "/og/cfb.png", path: "/cfb" },
  cbb: { title: "College Basketball Starting Fives on the Court", desc: "All 360+ D1 teams — starting fives from recent box scores (roster by class in the offseason). Live from ESPN.", img: "/og/cbb.png", path: "/cbb" },
  mlb: { title: "MLB Lineups on the Diamond", desc: "Any team's lineup on the diamond + full depth chart at every position, with MLB The Show ratings. Live from ESPN.", img: "/og/mlb.png", path: "/mlb" },
  mch: { title: "College Hockey Rosters on the Ice", desc: "Hockey East, Big Ten, NCHC, CCHA, Atlantic Hockey & ECAC rosters by position on the rink.", img: "/og/mch.png", path: "/mch" },
  wnba: { title: "WNBA Starting Fives on the Court", desc: "Each WNBA team's typical starting five from recent box scores + full roster at every spot. Live from ESPN.", img: "/og/wnba.png", path: "/wnba" },
  // International soccer — reuse the home OG image (per-league images optional later).
  epl: { title: "Premier League Starting XIs on the Pitch", desc: "Any Premier League team's typical starting XI in its usual formation, with EA FC ratings. Live from ESPN.", img: "/og/mls.png", path: "/epl" },
  laliga: { title: "La Liga Starting XIs on the Pitch", desc: "Any La Liga team's typical starting XI in its usual formation, with EA FC ratings. Live from ESPN.", img: "/og/mls.png", path: "/laliga" },
  bundesliga: { title: "Bundesliga Starting XIs on the Pitch", desc: "Any Bundesliga team's typical starting XI in its usual formation, with EA FC ratings. Live from ESPN.", img: "/og/mls.png", path: "/bundesliga" },
  seriea: { title: "Serie A Starting XIs on the Pitch", desc: "Any Serie A team's typical starting XI in its usual formation, with EA FC ratings. Live from ESPN.", img: "/og/mls.png", path: "/seriea" },
  ligue1: { title: "Ligue 1 Starting XIs on the Pitch", desc: "Any Ligue 1 team's typical starting XI in its usual formation, with EA FC ratings. Live from ESPN.", img: "/og/mls.png", path: "/ligue1" },
  ligamx: { title: "Liga MX Starting XIs on the Pitch", desc: "Any Liga MX team's typical starting XI in its usual formation. Live from ESPN.", img: "/og/mls.png", path: "/ligamx" },
  nwsl: { title: "NWSL Starting XIs on the Pitch", desc: "Any NWSL team's typical starting XI in its usual formation, with EA FC ratings. Live from ESPN.", img: "/og/mls.png", path: "/nwsl" },
  ucl: { title: "Champions League Starting XIs on the Pitch", desc: "Any UEFA Champions League team's typical starting XI in its usual formation. Live from ESPN.", img: "/og/mls.png", path: "/ucl" },
};
const FAVICON = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>%F0%9F%8F%9F%EF%B8%8F</text></svg>";
function headFor(key) {
  const o = OG[key] || OG.home;
  const t = escHtml(o.title), d = escHtml(o.desc), img = SITE + o.img;
  const parts = [
    // Per-route title + description (the tags search engines weight most). These
    // are injected at <!--HEAD--> so every route is unique — the static HTML no
    // longer carries its own <title>/description.
    `<title>${t}</title>`,
    `<meta name="description" content="${d}">`,
    `<meta property="og:title" content="${t}">`,
    `<meta property="og:description" content="${d}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:url" content="${SITE}${o.path}">`,
    `<meta property="og:image" content="${img}">`,
    `<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${t}"><meta name="twitter:description" content="${d}"><meta name="twitter:image" content="${img}">`,
    `<link rel="icon" href="${FAVICON}">`,
    `<link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png">`,
    `<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">`,
    `<link rel="manifest" href="/manifest.webmanifest">`,
    // SEO + faster first paint: canonical URL, and pre-warm the connection to
    // ESPN's logo CDN so team crests appear sooner. No `crossorigin`: the headshots/
    // logos are plain credentialed <img> loads, and browsers partition socket reuse by
    // credentials mode — an anonymous (crossorigin) preconnect would warm a socket the
    // images can never reuse. dns-prefetch stays as a fallback for browsers ignoring preconnect.
    `<link rel="canonical" href="${SITE}${o.path}">`,
    `<link rel="preconnect" href="https://a.espncdn.com">`,
    `<link rel="dns-prefetch" href="https://a.espncdn.com">`,
    // Structured data (not executed, so it's exempt from script-src CSP).
    `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "WebSite", name: "Depth Charts", url: SITE + o.path, description: o.desc })}</script>`,
  ];
  // Critical CSS: inline the small above-the-fold sheet on the app routes (NFL + every
  // surface sport) so the first paint has the dark background, nav, topbar, view toggle
  // and the field/surface aspect box before the full stylesheet loads. Whitelisted in CSP
  // by CRITICAL_CSS_HASH (derived from the same constant, so it can never drift).
  if (key === "nfl" || SURFACE[key]) parts.push(`<style>${CRITICAL_CSS}</style>`);
  // Preload the first data request the client will make, so the fetch starts during HTML
  // parse instead of after app.js runs. The href must byte-match the client's exact URL
  // (same params, same order) or the browser warms a response the app never reuses.
  // Same-origin fetch preload → NO crossorigin attribute.
  if (SURFACE[key]) {
    const cfg = SURFACE[key], d = cfg.defaults || {};
    // Client side-A request order: sport, team, fresh, then unit (only for dual-unit sports).
    const unit = cfg.dualUnit && cfg.units && cfg.units[0] ? cfg.units[0] : null;
    const href = `/api/lineup?sport=${key}&team=${d.a}&fresh=1${unit ? `&unit=${unit}` : ""}`;
    parts.push(`<link rel="preload" as="fetch" href="${escHtml(href)}">`);
  }
  if (key === "nfl" && nfl) {
    // Client NFL request order: team, year, fresh. year is server-computed here (the same
    // value the client will ask for) so the preload matches without a redeploy each fall.
    const href = `/api/depth?team=${DEFAULT_TEAM_ID}&year=${nfl.currentNflSeason()}&fresh=1`;
    parts.push(`<link rel="preload" as="fetch" href="${escHtml(href)}">`);
    // Non-executed JSON data island so nfl/app.js reads its team list + defaults + season
    // synchronously at startup (mirrors the surface #sdc-config island), letting the NFL
    // shell drop the /nfl/teams.js <script>. Escape "<" so a value can't break out.
    parts.push(`<script type="application/json" id="sdc-nfl-teams">${JSON.stringify({ teams: nfl.NFL_TEAMS, defaultId: DEFAULT_TEAM_ID, season: nfl.SEASON }).replace(/</g, "\\u003c")}</script>`);
  }
  // Inline the per-sport config as a non-executed JSON data island so the client can
  // read it synchronously at startup — this removes the serial config round-trip
  // (HTML → run app.js → fetch /api/config → then fetch lineup) from every surface
  // load. Same CSP-safe technique as the ld+json above (script-src 'self', not executed);
  // the config rides inside the already-brotli'd page. Escape "<" so a value can't break
  // out of the <script>. The client keeps a fetch fallback if the island is ever absent.
  if (SURFACE[key]) parts.push(`<script type="application/json" id="sdc-config">${JSON.stringify(publicConfig(key)).replace(/</g, "\\u003c")}</script>`);
  // Ads config island (non-executed JSON) + AdSense site-verification meta — only when ads
  // are enabled AND not on the dashboard. ads.js reads this to know the client + slot ids;
  // the actual AdSense loader is injected client-side AFTER consent (never pre-consent).
  if (ADS_ON && key !== "dashboard") {
    parts.push(`<meta name="google-adsense-account" content="${escHtml(ADSENSE_CLIENT)}">`);
    parts.push(`<script type="application/json" id="sdc-ads">${JSON.stringify({ client: ADSENSE_CLIENT, slots: ADSENSE_SLOTS }).replace(/</g, "\\u003c")}</script>`);
  }
  if (process.env.ANALYTICS_TOKEN) parts.push(`<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"${process.env.ANALYTICS_TOKEN}"}'></script>`);
  return parts.join("\n    ");
}
const pageCache = new Map();
function renderPage(req, res, rel, ogKey) {
  const filePath = path.join(PUBLIC_DIR, rel);
  let stat; try { stat = fs.statSync(filePath); } catch { return respond(req, res, 404, "Not found", "text/plain"); }
  const cacheKey = rel + "|" + ogKey;
  let entry = pageCache.get(cacheKey);
  if (!entry || entry.mtimeMs !== stat.mtimeMs) {
    const html = fs.readFileSync(filePath, "utf8").replace("<!--HEAD-->", headFor(ogKey));
    const body = Buffer.from(html);
    entry = { body, mtimeMs: stat.mtimeMs, etag: '"' + crypto.createHash("sha1").update(body).digest("hex").slice(0, 16) + '"' };
    // Compress the rendered page once per mtime (per OG variant): gzip sync, brotli async
    // (first hits serve gzip until entry.br lands) so no request blocks on brotli-11.
    entry.gz = zlib.gzipSync(body, { level: 9 });
    zlib.brotliCompress(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }, (err, buf) => { if (!err) entry.br = buf; });
    pageCache.set(cacheKey, entry);
  }
  if (req.headers["if-none-match"] === entry.etag) { res.writeHead(304, { ETag: entry.etag, ...SECURITY_HEADERS }); return res.end(); }
  // Browsers still revalidate every load (max-age=0 → cheap 304 via ETag), but a shared
  // edge cache (Cloudflare, with a "Cache Everything" rule for HTML) may hold the page
  // for 5 min and serve a day-stale copy while it revalidates in the background — so the
  // marquee cold-start case (first HTML view after a Render spin-down) is served from the
  // edge instead of waking a spun-down origin. NOTE: Cloudflare does not cache text/html
  // by default; this header is inert until a Cache Rule enables it. Bounded staleness is
  // fine here — lineups load via /api, and the SW already SWRs navigations.
  respond(req, res, 200, entry.body, MIME[".html"], { ETag: entry.etag, "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=86400", gz: entry.gz, br: entry.br });
}

// Trusted client IP for rate limiting. Cloudflare sets CF-Connecting-IP to the real
// visitor and strips any inbound copy, so it can't be spoofed end-to-end — prefer it.
// X-Forwarded-For is only honored when TRUST_PROXY is set (i.e. a proxy YOU control
// puts the client IP there and strips client-supplied values). On the raw Render
// origin (the …onrender.com mirror, no Cloudflare) XFF is fully attacker-supplied, so
// trusting it would let anyone mint a fresh bucket per request and bypass the limiter;
// there we fall back to the socket address instead.
const TRUST_PROXY = process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true";
function clientIp(req) {
  const cf = req.headers["cf-connecting-ip"];
  if (cf) return String(cf).trim();
  if (TRUST_PROXY) { const xff = req.headers["x-forwarded-for"]; if (xff) return String(xff).split(",")[0].trim(); }
  return req.socket.remoteAddress || "unknown";
}
const buckets = new Map();
const BUCKET_CAP = 10000;
function rateLimited(ip) {
  const now = Date.now(), cap = 120, refill = 2;
  let b = buckets.get(ip);
  if (!b) {
    // Hard-bound the map: a flood of unique IPs never refills to cap, so a "delete only
    // buckets at cap" predicate would never fire and the Map would grow unbounded (OOM
    // on the 512MB tier). Evict the oldest-inserted entry per new insert — one-shot
    // flood IPs are exactly those, so the map stays pinned at its ceiling.
    if (buckets.size >= BUCKET_CAP) { const oldest = buckets.keys().next().value; if (oldest !== undefined) buckets.delete(oldest); }
    b = { tokens: cap, last: now }; buckets.set(ip, b);
  }
  b.tokens = Math.min(cap, b.tokens + ((now - b.last) / 1000) * refill); b.last = now;
  if (b.tokens < 1) return true; b.tokens -= 1; return false;
}
const isNumericId = (s) => /^\d+$/.test(s || "");
// Home is the all-sports hub; each sport has its own route. (/all kept as an alias.)
const PAGE_ROUTES = {
  "/": { rel: "index.html", og: "home" }, "/all": { rel: "index.html", og: "home" },
  "/nfl": { rel: "nfl/index.html", og: "nfl" },
  "/nhl": { rel: "surface/index.html", og: "nhl" }, "/nba": { rel: "surface/index.html", og: "nba" }, "/mls": { rel: "surface/index.html", og: "mls" },
  "/cfb": { rel: "surface/index.html", og: "cfb" }, "/cbb": { rel: "surface/index.html", og: "cbb" },
  "/mlb": { rel: "surface/index.html", og: "mlb" }, "/mch": { rel: "surface/index.html", og: "mch" },
  "/wnba": { rel: "surface/index.html", og: "wnba" },
  // International soccer (all use the shared surface page + match builder)
  "/epl": { rel: "surface/index.html", og: "epl" }, "/laliga": { rel: "surface/index.html", og: "laliga" },
  "/bundesliga": { rel: "surface/index.html", og: "bundesliga" }, "/seriea": { rel: "surface/index.html", og: "seriea" },
  "/ligue1": { rel: "surface/index.html", og: "ligue1" }, "/ligamx": { rel: "surface/index.html", og: "ligamx" },
  "/nwsl": { rel: "surface/index.html", og: "nwsl" }, "/ucl": { rel: "surface/index.html", og: "ucl" },
  "/dashboard": { rel: "dashboard/index.html", og: "dashboard" }, // analytics dashboard (noindex; excluded from sitemap)
};

// Health verdict from the ROLLING upstream window (not cumulative-since-boot, so a
// bad last 15 min isn't drowned by a month of history). Volume-gated so a couple of
// early hiccups don't flip it. This catches the scariest 10-year failure: ESPN drifts,
// still returns 200, builders fall through to empty lineups → an operator can SEE it.
function healthVerdict() {
  const r = recentUpstream();
  const reasons = [];
  if (r.total >= 8 && r.errorRate >= 0.5) reasons.push(`upstream error rate ${Math.round(r.errorRate * 100)}% (${r.fail}/${r.total}) over ~15m`);
  else if (r.total >= 8 && r.ok === 0) reasons.push(`no upstream success in ${r.fail} recent attempts`);
  // Silent-drift signal: fetches "succeed" (200) but builders produce EMPTY or THIN
  // (degraded) lineups — the ESPN-schema-drift failure the fallback machinery exists for.
  // The degraded rate catches PARTIAL drift that empty-only counting would miss.
  if (r.built >= 8 && r.degradedRate >= 0.5) reasons.push(`degraded-build rate ${Math.round(r.degradedRate * 100)}% (${r.empty + r.degraded}/${r.built} empty-or-thin) over ~15m`);
  // Stale rankings: a rated map far past its refresh cadence (the auto-refresh cron may
  // have silently stopped). Generous threshold so a missed cycle, not a late day, trips it.
  const rc = ratings.coverageSnapshot();
  const stale = Object.entries(rc).filter(([, v]) => v.count > 0 && v.ageDays != null && v.ageDays > 400).map(([s, v]) => `${s}(${v.ageDays}d)`);
  if (stale.length) reasons.push(`rating maps stale >400d: ${stale.join(", ")}`);
  return { status: reasons.length ? "degraded" : "ok", reasons, recentUpstream: r, ratings: rc };
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  stats.requests++;
  const urlPath = req.url.split("?")[0].replace(/\/+$/, "") || "/";
  const done = (s) => console.log(`${req.method} ${req.url} ${s} ${Date.now() - t0}ms`);
  try {
    if (urlPath === "/healthz") {
      const now = Date.now();
      const mem = process.memoryUsage();
      const mb = (n) => Math.round(n / 1048576);
      // Freshness of each warmed lineup (age in seconds since it was cached).
      const lineups = {};
      for (const [k, v] of lineupStore) if (v && v.time) lineups[k] = Math.round((now - v.time) / 1000);
      const v = healthVerdict();
      // Plain /healthz ALWAYS returns 200 (Render's liveness probe must not kill a
      // serving-but-degraded instance). An external monitor asks for ?strict=1, which
      // returns 503 only when degraded — so a silent drift raises a real alert.
      const strict = /[?&]strict=1(\b|&|$)/.test(req.url);
      sendJson(req, res, strict && v.status === "degraded" ? 503 : 200, {
        status: v.status,
        ...(v.reasons.length ? { degradedReasons: v.reasons } : {}),
        uptimeSec: Math.round((now - stats.started) / 1000),
        ...stats,
        recentUpstream: v.recentUpstream,
        ratings: v.ratings,        // per-league OVR-map coverage + age (staleness)
        sports: prewarmStatus,     // per-sport default-matchup completeness (chips vs expected)
        memoryMB: { rss: mb(mem.rss), heapUsed: mb(mem.heapUsed) },
        caches: { lineups: lineupStore.size, buckets: buckets.size, static: staticCache.size, pages: pageCache.size, ...cacheStats() },
        lineupAgeSec: lineups,
      });
      return done(res.statusCode);
    }

    // ---- analytics ingest (POST beacon) — handled before the GET-only /api guard ----
    if (urlPath === "/api/metric") {
      if (req.method !== "POST") { res.writeHead(405, SECURITY_HEADERS); return res.end(); }
      if (rateLimited(clientIp(req))) { stats.rateLimited++; res.writeHead(429, SECURITY_HEADERS); return res.end(); }
      let body = "", aborted = false;
      req.on("data", (c) => { body += c; if (body.length > 4096) { aborted = true; req.destroy(); } }); // cap payload
      req.on("end", () => {
        if (!aborted) { try { metrics.record(JSON.parse(body)); } catch {} }
        if (!res.headersSent) { res.writeHead(204, { ...SECURITY_HEADERS, "Cache-Control": "no-store" }); res.end(); }
      });
      req.on("error", () => {}); // client abort mid-beacon is fine
      return; // async; no access-log line for high-volume beacons
    }
    // ---- analytics summary (dashboard data) ----
    if (urlPath === "/api/metrics-summary") {
      if (req.method !== "GET" && req.method !== "HEAD") { sendJson(req, res, 405, { error: "Method not allowed" }); return done(405); }
      if (METRICS_TOKEN && new URL(req.url, `http://localhost:${PORT}`).searchParams.get("key") !== METRICS_TOKEN) { sendJson(req, res, 404, { error: "Not found" }); return done(404); }
      sendJson(req, res, 200, metrics.summary(), { "Cache-Control": "no-store" }); return done(200);
    }

    if (urlPath.startsWith("/api/")) {
      if (req.method !== "GET" && req.method !== "HEAD") { sendJson(req, res, 405, { error: "Method not allowed" }); return done(405); }
      const ip = clientIp(req);
      if (rateLimited(ip)) { stats.rateLimited++; sendJson(req, res, 429, { error: "Too many requests" }); return done(429); }
      const params = new URL(req.url, `http://localhost:${PORT}`).searchParams;

      // ---- NFL ----
      if (urlPath === "/api/depth" || urlPath === "/api/ages") {
        if (!nfl) { sendJson(req, res, 503, { error: "NFL data temporarily unavailable" }); return done(503); }
      }
      if (urlPath === "/api/depth") {
        const teamId = params.get("team") || "2";
        if (!isNumericId(teamId) || !nfl.TEAM_BY_ID.has(teamId)) { sendJson(req, res, 400, { error: "Unknown team" }); return done(400); }
        const cur = nfl.currentNflSeason();
        let year = Number(params.get("year")) || cur;
        year = Math.min(cur, Math.max(nfl.SEASON.OLDEST, year));
        try { const d = await nfl.getTeamData(teamId, year, params.get("fresh") === "1"); return done(sendCachedJson(req, res, d, [d.offense, d.defense, d.specialTeams, d.team, d.season], { "Cache-Control": LINEUP_CACHE })); }
        catch (err) { console.error("depth error:", err.message); sendJson(req, res, 502, { error: "Couldn't load lineup data right now. Please try again." }); return done(502); }
      }
      if (urlPath === "/api/ages") {
        const year = Number(params.get("year")) || nfl.currentNflSeason();
        const ids = (params.get("ids") || "").split(",").filter(isNumericId).slice(0, 24);
        const ages = {};
        await Promise.all(ids.map(async (id) => { try { ages[id] = nfl.ageFromDob((await nfl.getAthlete(id)).dob, year); } catch { ages[id] = null; } }));
        sendJson(req, res, 200, { ages }, { "Cache-Control": "public, max-age=86400" }); return done(200);
      }

      // ---- surface sports (nhl/nba/mls) ----
      if (urlPath === "/api/config") {
        const sport = params.get("sport");
        if (!SURFACE[sport]) { sendJson(req, res, 400, { error: "Unknown sport" }); return done(400); }
        sendJson(req, res, 200, publicConfig(sport), { "Cache-Control": "public, max-age=600" }); return done(200);
      }
      if (urlPath === "/api/lineup") {
        const sport = params.get("sport");
        if (!SURFACE[sport]) { sendJson(req, res, 400, { error: "Unknown sport" }); return done(400); }
        const teamId = params.get("team") || SURFACE[sport].defaults.a;
        if (!isNumericId(teamId) || !surfaceTeamSets[sport].has(teamId)) { sendJson(req, res, 400, { error: "Unknown team" }); return done(400); }
        const unitParam = params.get("unit");
        const unit = ["offense", "defense", "line1", "line2"].includes(unitParam) ? unitParam : null;
        // Optional past-season year (only honored for history-enabled sports; clamped to the last ~6 seasons).
        let year = null;
        if (SURFACE[sport].history) {
          const y = Number(params.get("year")), nowY = new Date().getUTCFullYear();
          if (Number.isInteger(y) && y >= nowY - 6 && y <= nowY + 1) year = y;
        }
        const fp = params.get("formation");
        // A formation is valid if it's a whole-team option (soccer/basketball) OR a
        // per-unit package the current unit declares (CFB offense personnel / defense front).
        const cfgS = SURFACE[sport];
        const validForm = !!fp && ((cfgS.formations || []).includes(fp) || !!(cfgS.packages && cfgS.packages[unit] && cfgS.packages[unit][fp]));
        const formation = validForm ? fp : null;
        try { const d = await getLineup(sport, teamId, params.get("fresh") === "1", unit, year, formation); return done(sendCachedJson(req, res, d, [d.chips, d.team, d.formation, d.subtitle, d.season, unit], { "Cache-Control": LINEUP_CACHE })); }
        catch (err) { console.error(`[${sport}] lineup error:`, err.message); sendJson(req, res, 502, { error: "Couldn't load lineup data right now. Please try again." }); return done(502); }
      }
      if (urlPath === "/api/player-stats") {
        const sport = params.get("sport"), id = params.get("id");
        if ((!SURFACE[sport] && sport !== "nfl") || !isNumericId(id)) { sendJson(req, res, 400, { error: "bad request" }); return done(400); }
        const y = Number(params.get("year")); const yr = Number.isInteger(y) ? y : null;
        try { sendJson(req, res, 200, await playerStats(sport, id, yr), { "Cache-Control": "public, max-age=21600" }); return done(200); }
        catch { sendJson(req, res, 200, { line: [] }); return done(200); }
      }
      sendJson(req, res, 404, { error: "Not found" }); return done(404);
    }

    if (req.method !== "GET" && req.method !== "HEAD") { respond(req, res, 405, "Method not allowed", "text/plain"); return done(405); }

    // SEO: robots + sitemap (generated from the canonical routes, so they can't drift).
    // AdSense authorized-sellers file (only meaningful when ads are enabled).
    if (urlPath === "/ads.txt") {
      if (!ADS_ON) { respond(req, res, 404, "Not found", "text/plain"); return done(404); }
      respond(req, res, 200, `google.com, ${ADSENSE_CLIENT.replace(/^ca-/, "")}, DIRECT, f08c47fec0942fa0\n`, "text/plain; charset=utf-8", { "Cache-Control": "public, max-age=86400" });
      return done(200);
    }
    if (urlPath === "/robots.txt") {
      respond(req, res, 200, `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`, "text/plain; charset=utf-8", { "Cache-Control": "public, max-age=86400" });
      return done(200);
    }
    if (urlPath === "/sitemap.xml") {
      const urls = ["/", ...Object.keys(PAGE_ROUTES).filter((p) => p !== "/" && p !== "/all" && p !== "/dashboard")];
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((p) => `  <url><loc>${SITE}${p}</loc><changefreq>daily</changefreq></url>`).join("\n")}\n</urlset>\n`;
      respond(req, res, 200, xml, "application/xml; charset=utf-8", { "Cache-Control": "public, max-age=86400" });
      return done(200);
    }

    // Page routes vs static assets
    if (urlPath === "/dashboard" && METRICS_TOKEN && new URL(req.url, `http://localhost:${PORT}`).searchParams.get("key") !== METRICS_TOKEN) {
      respond(req, res, 404, "Not found", "text/plain"); return done(404); // gated dashboard: hide entirely without the key
    }
    if (PAGE_ROUTES[urlPath]) { renderPage(req, res, PAGE_ROUTES[urlPath].rel, PAGE_ROUTES[urlPath].og); return done(res.statusCode); }
    serveFile(req, res, path.normalize(path.join(PUBLIC_DIR, urlPath)));
    done(res.statusCode);
  } catch (err) {
    console.error("unhandled:", err && err.message);
    if (!res.headersSent) sendJson(req, res, 500, { error: "Server error" });
    done(500);
  }
});

// ---------------------------------------------------------------------------
// "Run forever" backstops. Every request is already wrapped in try/catch and
// every upstream call times out + falls back to a last-good disk copy, but these
// last-resort handlers make sure a stray error anywhere can never kill the
// process. (Render would restart a crash anyway; this avoids the restart.)
// ---------------------------------------------------------------------------
process.on("uncaughtException", (e) => console.error("uncaughtException (server kept alive):", (e && e.stack) || e));
process.on("unhandledRejection", (e) => console.error("unhandledRejection (server kept alive):", (e && e.stack) || e));
server.on("error", (e) => console.error("server error:", e && e.message));
server.keepAliveTimeout = 65000; // play nice behind proxies/load balancers
server.headersTimeout = 66000;

// Pre-warm the default matchup for every sport shortly after boot. Render's free
// tier spins down after inactivity and its disk is ephemeral, so after a cold
// start the caches are empty — this fills them in the background so the first
// visitor gets an instant, working page instead of waiting on (or erroring from)
// a slow first upstream call. Entirely best-effort; failures are ignored.
// Per-sport default-matchup completeness (chips vs expected), surfaced on /healthz so a
// single sport's endpoint drifting is visible even while the 15 others are fine (which
// the aggregate degraded-rate would never cross the global 50% threshold to reveal).
const prewarmStatus = {};
async function prewarm() {
  // Thunks, NOT started until a pool worker picks one up. Starting all ~19 builds in one
  // tick fans out each build's up-to-10 concurrent summary fetches simultaneously —
  // ~100-140 in-flight response buffers + JSON.parse trees at the peak, on a 512MB,
  // CPU-throttled cold boot. Draining through a small pool caps that transient spike and
  // the chance ESPN rate-limits the burst into degraded builds. Same idiom as statScores.
  const jobs = [];
  if (nfl) jobs.push(() => nfl.getTeamData("2", nfl.currentNflSeason(), false).catch(() => {}));
  const rec = (sport, p) => p.then((data) => {
    if (data && Array.isArray(data.chips)) {
      const chips = data.chips.length, expected = data.expectedSlots || chips || 1;
      prewarmStatus[sport] = { chips, expected, ok: chips >= 0.6 * expected };
    }
  }).catch(() => {});
  for (const [sport, cfg] of Object.entries(SURFACE)) {
    const d = cfg.defaults || {};
    if (d.a) jobs.push(() => rec(sport, getLineup(sport, d.a, false, cfg.units ? cfg.units[0] : null)));
    if (cfg.dualUnit && d.b) jobs.push(() => getLineup(sport, d.b, false, cfg.units ? cfg.units[1] : null).catch(() => {}));
  }
  const total = jobs.length;
  let i = 0;
  const worker = async () => { while (i < jobs.length) await jobs[i++](); }; // each thunk self-catches
  const CONCURRENCY = 6; // pool size; each build itself fans out up to ~10 summaries
  await Promise.allSettled(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
  console.log(`prewarm complete (${total} default lineups)`);
}

// Persist analytics across soft restarts. load() rehydrates the last snapshot; a periodic
// flush + a shutdown flush bound how much a crash/redeploy loses. Ephemeral /tmp still
// resets on a full free-tier spin-down — point METRICS_DIR at a persistent disk to keep it.
metrics.load();
const metricsFlush = setInterval(() => metrics.save(), 60000);
metricsFlush.unref();
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { try { metrics.save(); } catch {} process.exit(0); });

server.listen(PORT, () => {
  console.log(`\n🏟️  All-Sports Depth Charts running!  Open  http://localhost:${PORT}`);
  console.log(`   sports loaded: NFL${nfl ? "" : "(disabled)"}, ${Object.keys(SURFACE).join(", ")}\n`);
  // Prime the in-memory caches SYNCHRONOUSLY from committed seeds/last-good before any
  // request can be dispatched, so the first hit after a Render spin-down serves a ~0ms
  // local copy (with the fresh build landing in the background via SWR) instead of
  // blocking on a cold multi-second ESPN fetch — or 502-ing if ESPN is slow. A few ms of
  // readFileSync, once. prewarm() below still refreshes/repairs; this just closes the
  // very-first-request window prewarm's +800ms timer can't cover. Best-effort.
  try {
    if (nfl) nfl.primeTeamData("2", nfl.currentNflSeason());
    for (const [sport, cfg] of Object.entries(SURFACE)) {
      const d = cfg.defaults || {};
      const seed = (teamId, unit) => {
        const key = lineupKey(sport, teamId, unit, null, null); // matches getLineup's key for a default request
        if (lineupStore.has(key)) return;
        const hit = readDisk(key);
        if (hit) lineupStore.set(key, { time: 0, value: { ...hit.data, stale: true, source: hit.source } });
      };
      if (d.a) seed(d.a, cfg.units ? cfg.units[0] : null);
      if (cfg.dualUnit && d.b) seed(d.b, cfg.units ? cfg.units[1] : null);
    }
  } catch (e) { console.error("seed prime skipped:", e && e.message); }
  setTimeout(() => { prewarm().catch(() => {}); }, 800); // don't block startup
});
