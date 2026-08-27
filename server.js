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
const { stats, cached, buildLineup, writeDisk, readDisk, cacheStats } = require("./lib/espn.js");
// Load the NFL engine defensively: if it ever fails to load, the NFL routes are
// disabled but the rest of the site still runs.
let nfl = null;
try { nfl = require("./lib/nfl.js"); } catch (e) { console.error("NFL engine failed to load (NFL routes disabled):", e && e.message); }

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
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
    surface: cfg.surface, note: cfg.note, defaults: cfg.defaults, dualUnit: !!cfg.dualUnit, singleTeam: !!cfg.singleTeam, history: !!cfg.history, seasonEndYear: !!cfg.seasonEndYear, units: cfg.units || null, unitLabels: cfg.unitLabels || null,
    teams: cfg.teams.map((t) => ({ id: String(t.id), abbr: t.abbr, name: t.name, short: t.short, color: t.color, alt: t.alt, logo: t.logo, conf: t.conf })),
  };
}

// Edge cache policy for lineup/depth JSON: a CDN (Cloudflare) may serve a cached
// copy for ~2 min and keep serving a stale one for 10 min while it revalidates in
// the background. Keeps the cold Render origin + ESPN off most requests' critical
// path; the client still auto-refreshes every 4 min, so users stay current.
const LINEUP_CACHE = "public, s-maxage=120, stale-while-revalidate=600";
// Surface lineup cache (TTL + single-flight + disk last-good), keyed by sport+team.
const lineupStore = new Map();
async function getLineup(sport, teamId, fresh, unit, year) {
  const key = `${sport}:${teamId}:${unit || ""}:${year || ""}`;
  const existing = lineupStore.get(key);
  if (fresh) { if (existing && "value" in existing && Date.now() - existing.time > 60000) lineupStore.delete(key); }
  else if (existing && "value" in existing) stats.cacheHits++;
  try {
    return await cached(lineupStore, key, LINEUP_TTL, async () => {
      const data = await buildLineup(SURFACE[sport], surfaceTeamSets[sport].get(String(teamId)), unit, year || null);
      writeDisk(key, data);
      return data;
    });
  } catch (err) {
    const disk = readDisk(key);
    if (disk) { console.error(`serving last-good for ${key}: ${err.message}`); return disk; }
    throw err;
  }
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
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  // Tell browsers to stick to HTTPS for a year (safe behind Cloudflare; ignored on plain-http localhost).
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
  "Content-Security-Policy": [
    "default-src 'self'",
    "img-src 'self' data: https://*.espncdn.com",
    "style-src 'self'", "script-src 'self' https://static.cloudflareinsights.com", "connect-src 'self' https://cloudflareinsights.com",
    "base-uri 'none'", "frame-ancestors 'none'", "form-action 'none'",
  ].join("; "),
};
function respond(req, res, status, body, contentType, extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const headers = { "Content-Type": contentType, ...SECURITY_HEADERS, ...extra };
  const compressible = /text|json|javascript|svg/.test(contentType);
  const gzip = /\bgzip\b/.test(req.headers["accept-encoding"] || "") && compressible && buf.length > 512;
  const isHead = req.method === "HEAD";
  // Always Vary on Accept-Encoding for compressible types so a shared/CDN cache
  // never hands a gzipped body to a client that didn't ask for it (cache mixing).
  if (compressible) headers["Vary"] = "Accept-Encoding";
  if (gzip) {
    const gz = zlib.gzipSync(buf);
    res.writeHead(status, { ...headers, "Content-Encoding": "gzip", "Content-Length": gz.length });
    res.end(isHead ? undefined : gz);
  } else { res.writeHead(status, { ...headers, "Content-Length": buf.length }); res.end(isHead ? undefined : buf); }
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
    entry = { body, mtimeMs: stat.mtimeMs, etag: '"' + crypto.createHash("sha1").update(body).digest("hex").slice(0, 16) + '"', mime: MIME[path.extname(filePath)] || "application/octet-stream" };
    staticCache.set(filePath, entry);
  }
  if (req.headers["if-none-match"] === entry.etag) { res.writeHead(304, { ETag: entry.etag, ...SECURITY_HEADERS }); return res.end(); }
  // Images/icons/fonts rarely change → cache them hard (7 days). Code assets
  // (js/css) get revalidated every load so a deploy is picked up immediately.
  const ext = path.extname(filePath);
  const longLived = /\.(png|jpe?g|gif|svg|ico|webp|avif|woff2?)$/i.test(ext);
  const cc = longLived ? "public, max-age=604800" : "public, max-age=0, must-revalidate";
  respond(req, res, 200, entry.body, entry.mime, { ETag: entry.etag, "Cache-Control": cc });
}
// ---- Per-route <head> injection: social share cards, icons, PWA, analytics ----
const SITE = process.env.SITE_URL || "https://billsdepthchart.com";
const escHtml = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const OG = {
  home: { title: "Depth Charts — every team's starting lineup", desc: "Starting lineups across the NFL, college football, NBA, college hoops, NHL & MLS — click any player for the full depth chart.", img: "/og/home.png", path: "/all" },
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
  ligamx: { title: "Liga MX Starting XIs on the Pitch", desc: "Any Liga MX team's typical starting XI in its usual formation, with EA FC ratings. Live from ESPN.", img: "/og/mls.png", path: "/ligamx" },
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
    // ESPN's logo CDN so team crests appear sooner.
    `<link rel="canonical" href="${SITE}${o.path}">`,
    `<link rel="preconnect" href="https://a.espncdn.com" crossorigin>`,
    `<link rel="dns-prefetch" href="https://a.espncdn.com">`,
    // Structured data (not executed, so it's exempt from script-src CSP).
    `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "WebSite", name: "Depth Charts", url: SITE + o.path, description: o.desc })}</script>`,
  ];
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
    pageCache.set(cacheKey, entry);
  }
  if (req.headers["if-none-match"] === entry.etag) { res.writeHead(304, { ETag: entry.etag, ...SECURITY_HEADERS }); return res.end(); }
  respond(req, res, 200, entry.body, MIME[".html"], { ETag: entry.etag, "Cache-Control": "public, max-age=0, must-revalidate" });
}

// Trusted client IP for rate limiting. Behind Cloudflare→Render, `CF-Connecting-IP`
// is the real visitor IP and is set by Cloudflare (not spoofable end-to-end);
// prefer it. Fall back to the first (leftmost = original client) X-Forwarded-For
// hop, then the socket address. Using the leftmost XFF — not the attacker-
// appendable rightmost — avoids both spoofing and shared-proxy mis-attribution.
function clientIp(req) {
  const cf = req.headers["cf-connecting-ip"];
  if (cf) return String(cf).trim();
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}
const buckets = new Map();
function rateLimited(ip) {
  const now = Date.now(), cap = 120, refill = 2;
  let b = buckets.get(ip);
  if (!b) { if (buckets.size > 10000) for (const [k, v] of buckets) if (Math.min(cap, v.tokens + ((now - v.last) / 1000) * refill) >= cap) buckets.delete(k); b = { tokens: cap, last: now }; buckets.set(ip, b); }
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
};

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
      sendJson(req, res, 200, {
        status: "ok",
        uptimeSec: Math.round((now - stats.started) / 1000),
        ...stats,
        memoryMB: { rss: mb(mem.rss), heapUsed: mb(mem.heapUsed) },
        caches: { lineups: lineupStore.size, buckets: buckets.size, static: staticCache.size, pages: pageCache.size, ...cacheStats() },
        lineupAgeSec: lineups,
      });
      return done(200);
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
        try { sendJson(req, res, 200, await nfl.getTeamData(teamId, year, params.get("fresh") === "1"), { "Cache-Control": LINEUP_CACHE }); return done(200); }
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
        try { sendJson(req, res, 200, await getLineup(sport, teamId, params.get("fresh") === "1", unit, year), { "Cache-Control": LINEUP_CACHE }); return done(200); }
        catch (err) { console.error(`[${sport}] lineup error:`, err.message); sendJson(req, res, 502, { error: "Couldn't load lineup data right now. Please try again." }); return done(502); }
      }
      sendJson(req, res, 404, { error: "Not found" }); return done(404);
    }

    if (req.method !== "GET" && req.method !== "HEAD") { respond(req, res, 405, "Method not allowed", "text/plain"); return done(405); }

    // SEO: robots + sitemap (generated from the canonical routes, so they can't drift).
    if (urlPath === "/robots.txt") {
      respond(req, res, 200, `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`, "text/plain; charset=utf-8", { "Cache-Control": "public, max-age=86400" });
      return done(200);
    }
    if (urlPath === "/sitemap.xml") {
      const urls = ["/", ...Object.keys(PAGE_ROUTES).filter((p) => p !== "/" && p !== "/all")];
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((p) => `  <url><loc>${SITE}${p}</loc><changefreq>daily</changefreq></url>`).join("\n")}\n</urlset>\n`;
      respond(req, res, 200, xml, "application/xml; charset=utf-8", { "Cache-Control": "public, max-age=86400" });
      return done(200);
    }

    // Page routes vs static assets
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
async function prewarm() {
  const jobs = [];
  if (nfl) jobs.push(nfl.getTeamData("2", nfl.currentNflSeason(), false).catch(() => {}));
  for (const [sport, cfg] of Object.entries(SURFACE)) {
    const d = cfg.defaults || {};
    if (d.a) jobs.push(getLineup(sport, d.a, false, cfg.units ? cfg.units[0] : null).catch(() => {}));
    if (cfg.dualUnit && d.b) jobs.push(getLineup(sport, d.b, false, cfg.units ? cfg.units[1] : null).catch(() => {}));
  }
  await Promise.allSettled(jobs);
  console.log(`prewarm complete (${jobs.length} default lineups)`);
}

server.listen(PORT, () => {
  console.log(`\n🏟️  All-Sports Depth Charts running!  Open  http://localhost:${PORT}`);
  console.log(`   sports loaded: NFL${nfl ? "" : "(disabled)"}, ${Object.keys(SURFACE).join(", ")}\n`);
  setTimeout(() => { prewarm().catch(() => {}); }, 800); // don't block startup
});
