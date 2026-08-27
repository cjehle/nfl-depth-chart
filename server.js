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
const { stats, cached, buildLineup, writeDisk, readDisk } = require("./lib/espn.js");
const nfl = require("./lib/nfl.js");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const LINEUP_TTL = (Number(process.env.LINEUP_TTL_HOURS) || 12) * 3600e3;

// Surface sports (rink/court/pitch), each a small config module.
const SURFACE = {
  nhl: require("./sports/nhl.js"), nba: require("./sports/nba.js"), mls: require("./sports/mls.js"),
  cbb: require("./sports/cbb.js"), cfb: require("./sports/cfb.js"),
};
const surfaceTeamSets = Object.fromEntries(Object.entries(SURFACE).map(([k, cfg]) => [k, new Map(cfg.teams.map((t) => [String(t.id), t]))]));
function publicConfig(sport) {
  const cfg = SURFACE[sport];
  return {
    sport: cfg.key, name: cfg.name, emoji: cfg.emoji, title: cfg.title, tagline: cfg.tagline,
    surface: cfg.surface, note: cfg.note, defaults: cfg.defaults, dualUnit: !!cfg.dualUnit,
    teams: cfg.teams.map((t) => ({ id: String(t.id), abbr: t.abbr, name: t.name, short: t.short, color: t.color, alt: t.alt, logo: t.logo, conf: t.conf })),
  };
}

// Surface lineup cache (TTL + single-flight + disk last-good), keyed by sport+team.
const lineupStore = new Map();
async function getLineup(sport, teamId, fresh, unit) {
  const key = `${sport}:${teamId}:${unit || ""}`;
  const existing = lineupStore.get(key);
  if (fresh) { if (existing && "value" in existing && Date.now() - existing.time > 60000) lineupStore.delete(key); }
  else if (existing && "value" in existing) stats.cacheHits++;
  try {
    return await cached(lineupStore, key, LINEUP_TTL, async () => {
      const data = await buildLineup(SURFACE[sport], surfaceTeamSets[sport].get(String(teamId)), unit);
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
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
  "Content-Security-Policy": [
    "default-src 'self'",
    "img-src 'self' data: https://*.espncdn.com",
    "style-src 'self'", "script-src 'self'", "connect-src 'self'",
    "base-uri 'none'", "frame-ancestors 'none'", "form-action 'none'",
  ].join("; "),
};
function respond(req, res, status, body, contentType, extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const headers = { "Content-Type": contentType, ...SECURITY_HEADERS, ...extra };
  const gzip = /\bgzip\b/.test(req.headers["accept-encoding"] || "") && /text|json|javascript|svg/.test(contentType) && buf.length > 512;
  const isHead = req.method === "HEAD";
  if (gzip) {
    const gz = zlib.gzipSync(buf);
    res.writeHead(status, { ...headers, "Content-Encoding": "gzip", Vary: "Accept-Encoding", "Content-Length": gz.length });
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
  respond(req, res, 200, entry.body, entry.mime, { ETag: entry.etag, "Cache-Control": "public, max-age=0, must-revalidate" });
}
const servePage = (req, res, rel) => serveFile(req, res, path.join(PUBLIC_DIR, rel));

const buckets = new Map();
function rateLimited(ip) {
  const now = Date.now(), cap = 120, refill = 2;
  let b = buckets.get(ip);
  if (!b) { if (buckets.size > 10000) for (const [k, v] of buckets) if (v.tokens >= cap) buckets.delete(k); b = { tokens: cap, last: now }; buckets.set(ip, b); }
  b.tokens = Math.min(cap, b.tokens + ((now - b.last) / 1000) * refill); b.last = now;
  if (b.tokens < 1) return true; b.tokens -= 1; return false;
}
const isNumericId = (s) => /^\d+$/.test(s || "");
// Home is the all-sports hub; each sport has its own route. (/all kept as an alias.)
const PAGE_ROUTES = { "/": "index.html", "/all": "index.html", "/nfl": "nfl/index.html", "/nhl": "surface/index.html", "/nba": "surface/index.html", "/mls": "surface/index.html", "/cfb": "surface/index.html", "/cbb": "surface/index.html" };

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  stats.requests++;
  const urlPath = req.url.split("?")[0].replace(/\/+$/, "") || "/";
  const done = (s) => console.log(`${req.method} ${req.url} ${s} ${Date.now() - t0}ms`);
  try {
    if (urlPath === "/healthz") { sendJson(req, res, 200, { status: "ok", uptimeSec: Math.round((Date.now() - stats.started) / 1000), ...stats }); return done(200); }

    if (urlPath.startsWith("/api/")) {
      if (req.method !== "GET" && req.method !== "HEAD") { sendJson(req, res, 405, { error: "Method not allowed" }); return done(405); }
      const xff = req.headers["x-forwarded-for"];
      const ip = (xff ? xff.split(",").pop().trim() : req.socket.remoteAddress) || "unknown";
      if (rateLimited(ip)) { stats.rateLimited++; sendJson(req, res, 429, { error: "Too many requests" }); return done(429); }
      const params = new URL(req.url, `http://localhost:${PORT}`).searchParams;

      // ---- NFL ----
      if (urlPath === "/api/depth") {
        const teamId = params.get("team") || "2";
        if (!isNumericId(teamId) || !nfl.TEAM_BY_ID.has(teamId)) { sendJson(req, res, 400, { error: "Unknown team" }); return done(400); }
        const cur = nfl.currentNflSeason();
        let year = Number(params.get("year")) || cur;
        year = Math.min(cur, Math.max(nfl.SEASON.OLDEST, year));
        try { sendJson(req, res, 200, await nfl.getTeamData(teamId, year, params.get("fresh") === "1")); return done(200); }
        catch (err) { console.error("depth error:", err.message); sendJson(req, res, 502, { error: "Couldn't load lineup data right now. Please try again." }); return done(502); }
      }
      if (urlPath === "/api/ages") {
        const year = Number(params.get("year")) || nfl.currentNflSeason();
        const ids = (params.get("ids") || "").split(",").filter(isNumericId).slice(0, 40);
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
        const unit = unitParam === "defense" ? "defense" : unitParam === "offense" ? "offense" : null;
        try { sendJson(req, res, 200, await getLineup(sport, teamId, params.get("fresh") === "1", unit)); return done(200); }
        catch (err) { console.error(`[${sport}] lineup error:`, err.message); sendJson(req, res, 502, { error: "Couldn't load lineup data right now. Please try again." }); return done(502); }
      }
      sendJson(req, res, 404, { error: "Not found" }); return done(404);
    }

    if (req.method !== "GET" && req.method !== "HEAD") { respond(req, res, 405, "Method not allowed", "text/plain"); return done(405); }

    // Page routes vs static assets
    if (PAGE_ROUTES[urlPath]) { servePage(req, res, PAGE_ROUTES[urlPath]); return done(res.statusCode); }
    serveFile(req, res, path.normalize(path.join(PUBLIC_DIR, urlPath)));
    done(res.statusCode);
  } catch (err) {
    console.error("unhandled:", err && err.message);
    if (!res.headersSent) sendJson(req, res, 500, { error: "Server error" });
    done(500);
  }
});

server.listen(PORT, () => { console.log(`\n🏟️  All-Sports Depth Charts running!  Open  http://localhost:${PORT}\n`); });
