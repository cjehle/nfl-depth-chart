// server.js
// ---------------------------------------------------------------------------
// A tiny web server with NO external libraries (no `npm install` needed).
// Node 20+ has everything built in (fetch, zlib, crypto).
//
// Jobs:
//   1. Serve the web page (files in ./public + the shared teams.js).
//   2. GET /api/depth?team=&year=&fresh=  -> tidy lineup JSON for a team+season.
//   3. GET /api/ages?ids=&year=           -> ages for a batch of players.
//   4. GET /healthz                        -> liveness + counters (no upstream).
//
// Data sources: current season = ESPN (live). 2025 = nflverse's newer format.
// 2020-2024 = nflverse's older weekly format. Madden ratings from EA.
//
// Run it with:  node server.js   (then open http://localhost:3000)
// ---------------------------------------------------------------------------

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");
const crypto = require("crypto");
const { NFL_TEAMS, SEASON, currentNflSeason } = require("./teams.js");
const {
  parseCsv, splitCsvLine, normName, ageFromDob, offenseKey, defenseCat, groupBy, splitIntoSpots,
} = require("./lib/util.js");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const TEAMS_FILE = path.join(__dirname, "teams.js");
const TEAM_BY_ID = new Map(NFL_TEAMS.map((t) => [String(t.id), t]));
// nflverse club codes match our abbreviations except these two.
const NFLVERSE_CLUB = { LAR: "LA", WSH: "WAS" };

// How often we re-check for updates (see README). Overridable via env vars.
const DEPTH_TTL = (Number(process.env.DEPTH_TTL_HOURS) || 24) * 3600e3;   // daily
const MADDEN_TTL = (Number(process.env.MADDEN_TTL_DAYS) || 30) * 86400e3; // monthly
const DISK_CACHE_DIR = path.join(os.tmpdir(), "nfl-depth-cache");

// Simple counters surfaced on /healthz so free-tier issues aren't guesswork.
const stats = { started: Date.now(), requests: 0, cacheHits: 0, upstreamOk: 0, upstreamFail: 0, rateLimited: 0 };

// ---------------------------------------------------------------------------
// RESILIENT FETCH — timeout, retry on 5xx/network, and a response size cap so a
// hung or oversized upstream can't stall the request or blow up memory.
// ---------------------------------------------------------------------------
async function fetchText(url, { ua = "nfl-depth-chart-app", timeout = 15000, retries = 2, maxBytes = 80 * 1024 * 1024 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": ua }, signal: AbortSignal.timeout(timeout) });
      if (!res.ok) {
        if (res.status >= 500 && attempt < retries) { lastErr = new Error(`HTTP ${res.status}`); continue; }
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      // Reject oversized bodies BEFORE allocating them: check Content-Length,
      // then stream and stop the moment we cross the cap (don't buffer it all).
      const declared = Number(res.headers.get("content-length"));
      if (declared && declared > maxBytes) { await res.body?.cancel?.(); const e = new Error(`Response too large (${declared} bytes)`); e.noRetry = true; throw e; }
      const reader = res.body.getReader();
      const chunks = []; let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) { await reader.cancel(); const e = new Error(`Response exceeded ${maxBytes} bytes`); e.noRetry = true; throw e; }
        chunks.push(value);
      }
      stats.upstreamOk++;
      return Buffer.concat(chunks).toString("utf8");
    } catch (err) {
      lastErr = err;
      if (err.noRetry || attempt >= retries) break;
    }
  }
  stats.upstreamFail++;
  throw lastErr;
}
async function fetchJson(url, opts) {
  return JSON.parse(await fetchText(url, opts));
}

// ---------------------------------------------------------------------------
// CACHING — one helper gives every cache: TTL freshness, single-flight (a burst
// of identical requests shares ONE in-flight fetch), and NO negative caching
// (a thrown fetch is never stored, so one hiccup doesn't stick).
// ---------------------------------------------------------------------------
function cached(store, key, ttlMs, fn) {
  const hit = store.get(key);
  if (hit) {
    if ("value" in hit && (ttlMs === Infinity || Date.now() - hit.time < ttlMs)) return Promise.resolve(hit.value);
    if (hit.promise) return hit.promise; // a fetch is already in flight
  }
  const promise = (async () => {
    const value = await fn();
    store.set(key, { time: Date.now(), value });
    return value;
  })();
  store.set(key, { ...(store.get(key) || {}), promise });
  promise.catch(() => {
    const cur = store.get(key);
    if (!cur || cur.promise !== promise) return; // a newer flight replaced us — leave it alone
    if ("value" in cur) delete cur.promise; // keep the last good value, drop the failed promise
    else store.delete(key);                 // nothing good cached -> don't remember the failure
  });
  return promise;
}

// Best-effort last-good copy on disk, so a cold start (or a downed upstream)
// can still serve something instead of a bare error.
function diskPath(key) { return path.join(DISK_CACHE_DIR, key.replace(/[^\w.-]/g, "_") + ".json"); }
function writeDisk(key, data) {
  try { fs.mkdirSync(DISK_CACHE_DIR, { recursive: true }); fs.writeFileSync(diskPath(key), JSON.stringify(data)); }
  catch (_) { /* best effort */ }
}
function readDisk(key) {
  try { return JSON.parse(fs.readFileSync(diskPath(key), "utf8")); } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// ESPN endpoints
// ---------------------------------------------------------------------------
const depthChartUrl = (year, teamId) =>
  `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${year}/teams/${teamId}/depthcharts`;
const rosterUrl = (teamId) =>
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${teamId}/roster`;
const athleteUrl = (id) =>
  `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/athletes/${id}`;

const athleteIdFromRef = (ref) => (/athletes\/(\d+)/.exec(ref || "") || [])[1] || null;

// ---------------------------------------------------------------------------
// THE UNIFIED BUILDER
// Every data source normalizes into the same list of "entries":
//   { unit:'offense'|'defense', key, abbr, slot, rank, player }
// assembleUnit() then shapes those into the payload the browser draws. Offense
// keeps one position-key with multiple slots (WR = 3 receivers); defense makes
// one position per on-field starter (so each shows up as its own chip) and
// tags it with its bucket (DL/LB/CB/S/NB) so the client never has to guess.
// ---------------------------------------------------------------------------
function assembleUnit(entries, kind) {
  const positions = {};
  if (kind === "offense") {
    for (const [key, es] of groupBy(entries, (e) => e.key)) {
      const spots = [];
      for (const [slot, ses] of groupBy(es, (e) => String(e.slot))) {
        ses.sort((a, b) => a.rank - b.rank);
        spots.push({ slot: Number(slot), players: ses.map((e) => e.player) });
      }
      spots.sort((a, b) => a.slot - b.slot);
      positions[key] = { abbr: es[0].abbr, spots };
    }
  } else {
    for (const [k, es] of groupBy(entries, (e) => `${e.key}__${e.slot}`)) {
      es.sort((a, b) => a.rank - b.rank);
      const abbr = es[0].abbr;
      const cat = defenseCat(abbr) || defenseCat(es[0].key);
      if (!cat) continue;
      positions[k] = { abbr, cat, spots: [{ slot: 1, players: es.map((e) => e.player) }] };
    }
  }
  return positions;
}

function makeEnvelope(team, season, entries) {
  const off = entries.filter((e) => e.unit === "offense");
  const def = entries.filter((e) => e.unit === "defense");
  return {
    team: team.name,
    teamAbbr: team.abbr,
    season,
    fetchedAt: new Date().toISOString(),
    offense: off.length ? { formation: "Offense", positions: assembleUnit(off, "offense") } : null,
    defense: def.length ? { formation: "Defense", positions: assembleUnit(def, "defense") } : null,
  };
}

// ---------------------------------------------------------------------------
// SOURCE 1: CURRENT season, live from ESPN
// ---------------------------------------------------------------------------
function buildRosterMap(roster, maddenMap) {
  const map = new Map();
  for (const group of roster.athletes || []) {
    for (const a of group.items || []) {
      const injuries = a.injuries || [];
      const name = a.fullName || a.displayName || "Unknown";
      map.set(String(a.id), {
        name,
        jersey: a.jersey || "",
        injury: injuries.length ? injuries[0].status : null,
        overall: maddenMap ? maddenMap.get(normName(name)) ?? null : null,
      });
    }
  }
  return map;
}

function espnGroupEntries(group, knownById, season) {
  if (/Special/i.test(group.name)) return [];
  const unit = /\bD\b/.test(group.name) ? "defense" : "offense";
  const entries = [];
  for (const [posKey, posData] of Object.entries(group.positions || {})) {
    const abbr = (posData.position && posData.position.abbreviation) || posKey.toUpperCase();
    const key = unit === "offense" ? offenseKey(posKey) || posKey.toLowerCase() : posKey.toLowerCase();
    for (const a of posData.athletes || []) {
      const id = athleteIdFromRef(a.athlete && a.athlete.$ref);
      const known = (id && knownById.get(id)) || {};
      if (!known.name) continue;
      entries.push({
        unit, key, abbr, slot: a.slot, rank: a.rank,
        player: { rank: a.rank, id: id || null, season, name: known.name, jersey: known.jersey || "", injury: known.injury || null, overall: known.overall ?? null },
      });
    }
  }
  return entries;
}

async function espnSource(team, teamId) {
  const cur = currentNflSeason();
  let depth = null, usedYear = cur;
  for (const year of [cur, cur - 1]) { // fall back to last year if this year 404s/5xxs/empty
    try {
      const d = await fetchJson(depthChartUrl(year, teamId));
      if (d && (d.items || []).length) { depth = d; usedYear = year; break; }
    } catch (_) { /* try the prior year */ }
  }
  if (!depth) throw new Error(`No current depth chart available for ${team.name}.`);
  const [roster, madden] = await Promise.all([fetchJson(rosterUrl(teamId)), maddenMapSafe()]);
  const knownById = buildRosterMap(roster, madden);
  const entries = depth.items.flatMap((g) => espnGroupEntries(g, knownById, usedYear));
  return { entries, usedYear };
}

// ---------------------------------------------------------------------------
// SOURCE 2: PAST seasons 2020-2024, nflverse's older weekly format
// ---------------------------------------------------------------------------
const nflverseStore = new Map();
const OLD_CSV_COLS = ["club_code", "game_type", "week", "formation", "depth_position", "depth_team", "full_name", "first_name", "last_name", "jersey_number", "gsis_id"];

function getNflverseSeason(year) {
  return cached(nflverseStore, year, Infinity, async () => {
    const url = `https://github.com/nflverse/nflverse-data/releases/download/depth_charts/depth_charts_${year}.csv`;
    return parseCsv(await fetchText(url, { timeout: 45000 }), OLD_CSV_COLS);
  });
}

async function oldFormatSource(team, year) {
  const club = NFLVERSE_CLUB[team.abbr] || team.abbr;
  const [rows, meta, madden] = await Promise.all([getNflverseSeason(year), getPlayersMeta(), getSeasonMadden(year)]);
  const teamRows = rows.filter((r) => r.club_code === club && r.game_type === "REG");
  if (!teamRows.length) throw new Error(`No ${year} depth chart for ${team.name}.`);
  const week = Math.min(...teamRows.map((r) => Number(r.week)).filter((n) => n > 0));
  const wk = teamRows.filter((r) => Number(r.week) === week);
  const nick = team.name.split(" ").pop();

  const mkPlayer = (r, rank) => {
    const m = meta.get(r.gsis_id) || {};
    const name = r.full_name || `${r.first_name} ${r.last_name}`.trim() || "—";
    return { rank, id: m.espn_id || null, season: year, name, jersey: r.jersey_number || m.jersey || "", injury: null, overall: ovrFromMadden(madden, name, nick), age: ageFromDob(m.dob, year) };
  };

  const entries = [];
  for (const [key, group] of groupBy(wk.filter((r) => r.formation === "Offense"), (r) => offenseKey(r.depth_position))) {
    splitIntoSpots(group, mkPlayer).forEach((sp) =>
      sp.players.forEach((pl) => entries.push({ unit: "offense", key, abbr: key.toUpperCase(), slot: sp.slot, rank: pl.rank, player: pl })));
  }
  for (const [code, group] of groupBy(wk.filter((r) => r.formation === "Defense"), (r) => r.depth_position)) {
    if (!defenseCat(code)) continue;
    splitIntoSpots(group, mkPlayer).forEach((sp) =>
      sp.players.forEach((pl) => entries.push({ unit: "defense", key: code.toLowerCase(), abbr: code.trim().toUpperCase(), slot: sp.slot, rank: pl.rank, player: pl })));
  }
  return { entries, usedYear: year };
}

// ---------------------------------------------------------------------------
// SOURCE 3: 2025+, nflverse's newer (ESPN-shaped) format. The file is large and
// holds many dated snapshots; we scan it (without materializing every line) and
// keep only the snapshot nearest that season's opener.
// ---------------------------------------------------------------------------
const newFormatStore = new Map();

function getNewFormatSeason(year) {
  return cached(newFormatStore, year, Infinity, async () => {
    const url = `https://github.com/nflverse/nflverse-data/releases/download/depth_charts/depth_charts_${year}.csv`;
    const text = await fetchText(url, { timeout: 60000 });
    const headerEnd = text.indexOf("\n");
    const header = splitCsvLine(text.slice(0, headerEnd));
    const col = (name) => header.indexOf(name);

    // Pass 1: find the earliest snapshot on/after the opener, scanning line starts only.
    // (The dt timestamp is always the first column, so we compare line prefixes.)
    const opener = `${year}-09-04`;
    let target = null;
    for (let i = headerEnd + 1; i < text.length; ) {
      const nl = text.indexOf("\n", i);
      const end = nl === -1 ? text.length : nl;
      const comma = text.indexOf(",", i);
      if (comma !== -1 && comma < end) {
        const dt = text.slice(i, comma);
        if (dt >= opener && (target === null || dt < target)) target = dt;
      }
      if (nl === -1) break;
      i = end + 1;
    }
    if (!target) throw new Error(`No ${year} in-season snapshot found.`);

    // Pass 2: parse only the target snapshot's rows.
    const want = ["team", "player_name", "espn_id", "gsis_id", "pos_grp", "pos_abb", "pos_slot", "pos_rank"];
    const idx = Object.fromEntries(want.map((w) => [w, col(w)]));
    const rows = [];
    for (let i = headerEnd + 1; i < text.length; ) {
      const nl = text.indexOf("\n", i);
      const end = nl === -1 ? text.length : nl;
      if (text.startsWith(target + ",", i)) {
        const c = splitCsvLine(text.slice(i, end));
        const row = {};
        for (const w of want) row[w] = c[idx[w]];
        rows.push(row);
      }
      if (nl === -1) break;
      i = end + 1;
    }
    return rows;
  });
}

async function newFormatSource(team, year) {
  const club = NFLVERSE_CLUB[team.abbr] || team.abbr;
  const [rows, meta, madden] = await Promise.all([getNewFormatSeason(year), getPlayersMeta(), getSeasonMadden(year)]);
  const teamRows = rows.filter((r) => r.team === club || r.team === team.abbr);
  if (!teamRows.length) throw new Error(`No ${year} depth chart for ${team.name}.`);
  const nick = team.name.split(" ").pop();

  const mk = (r) => {
    const m = meta.get(r.gsis_id) || {};
    return { rank: Number(r.pos_rank) || 1, id: r.espn_id || m.espn_id || null, season: year, name: r.player_name || "—", jersey: m.jersey || "", injury: null, overall: ovrFromMadden(madden, r.player_name, nick), age: ageFromDob(m.dob, year) };
  };

  const entries = [];
  for (const r of teamRows) {
    if (/Special/i.test(r.pos_grp)) continue;
    const unit = /\bD\b/.test(r.pos_grp) ? "defense" : "offense";
    const abbr = r.pos_abb || "";
    const key = unit === "offense" ? offenseKey(abbr) || abbr.toLowerCase() : abbr.toLowerCase();
    if (!key) continue;
    entries.push({ unit, key, abbr, slot: Number(r.pos_slot), rank: Number(r.pos_rank) || 1, player: mk(r) });
  }
  return { entries, usedYear: year };
}

// ---------------------------------------------------------------------------
// nflverse players.csv -> birthdays + espn ids + jerseys, keyed by gsis id.
// ---------------------------------------------------------------------------
const playersMetaStore = new Map();
function getPlayersMeta() {
  return cached(playersMetaStore, "v", Infinity, async () => {
    const url = "https://github.com/nflverse/nflverse-data/releases/download/players/players.csv";
    const rows = parseCsv(await fetchText(url, { timeout: 45000 }), ["gsis_id", "birth_date", "espn_id", "jersey_number"]);
    const map = new Map();
    for (const r of rows) if (r.gsis_id) map.set(r.gsis_id, { dob: r.birth_date || null, espn_id: r.espn_id || null, jersey: r.jersey_number || "" });
    return map;
  });
}

// ---------------------------------------------------------------------------
// MADDEN RATINGS (free stand-in for a PFF grade)
// ---------------------------------------------------------------------------
const maddenStore = new Map();
function getMaddenMap() {
  return cached(maddenStore, "v", MADDEN_TTL, async () => {
    const page = async (offset) => JSON.parse(await fetchText(`https://drop-api.ea.com/rating/madden-nfl?locale=en&limit=100&offset=${offset}`, { ua: "Mozilla/5.0" }));
    const first = await page(0); // throws if EA is down -> not cached, retried next time
    const map = new Map();
    const add = (items) => { for (const it of items || []) { const k = normName(`${it.firstName} ${it.lastName}`); if (k && !map.has(k)) map.set(k, it.overallRating); } };
    add(first.items);
    const offsets = [];
    for (let o = 100; o < (first.totalItems || 0); o += 100) offsets.push(o);
    const pages = await Promise.all(offsets.map((o) => page(o).catch(() => ({ items: [] }))));
    pages.forEach((p) => add(p.items));
    return map;
  });
}
// Never let a Madden hiccup break a whole team fetch — ratings are a bonus.
async function maddenMapSafe() { try { return await getMaddenMap(); } catch { return new Map(); } }

// Historical Madden by season. 2025+ uses the current game; 2021-2023 use EA's
// per-game endpoints; 2020 (M21) and 2024 (M25) aren't served -> empty.
const seasonMaddenStore = new Map();
function getSeasonMadden(year) {
  return cached(seasonMaddenStore, year, Infinity, async () => {
    const map = new Map();
    if (year >= 2025) {
      // Madden 26 (the current game) is the 2025-season game.
      for (const [k, v] of await maddenMapSafe()) map.set(k, v);
      return map;
    }
    if (year >= 2021 && year <= 2023) {
      const m = year - 1999; // 2021->22, 2022->23, 2023->24
      let got = false;
      for (const offset of [0, 1000]) {
        try {
          const docs = (JSON.parse(await fetchText(`https://ratings-api.ea.com/v2/entities/m${m}-ratings?limit=1000&offset=${offset}`, { ua: "Mozilla/5.0" })).docs) || [];
          got = true;
          for (const d of docs) {
            const name = normName(d.fullNameForSearch || `${d.firstName} ${d.lastName}`);
            const nick = (d.team || "").toLowerCase();
            if (name && typeof d.overall_rating === "number") {
              map.set(`${name}|${nick}`, d.overall_rating);
              if (!map.has(name)) map.set(name, d.overall_rating);
            }
          }
          if (docs.length < 1000) break;
        } catch (_) { /* partial is fine */ }
      }
      if (!got) throw new Error(`Madden ${m} ratings unavailable`); // don't cache a total failure
    }
    return map; // 2020 / 2024 legitimately empty (and safe to cache)
  }).catch(() => new Map());
}
function ovrFromMadden(map, name, nick) {
  const n = normName(name);
  return map.get(`${n}|${(nick || "").toLowerCase()}`) ?? map.get(n) ?? null;
}

// ---------------------------------------------------------------------------
// AGE LOOKUP for the CURRENT season (past seasons already carry age). ESPN's
// per-athlete endpoint has the birth date; cached forever within a run.
// ---------------------------------------------------------------------------
const athleteStore = new Map();
function getAthlete(id) {
  // Let fetch failures THROW so cached() doesn't remember a transient miss as a
  // permanent null age; only a real response with no birth date caches null.
  return cached(athleteStore, id, Infinity, async () => {
    const d = await fetchJson(athleteUrl(id));
    return { dob: d.dateOfBirth || null };
  });
}

// ---------------------------------------------------------------------------
// DISPATCH: pick the right source for the requested season.
// ---------------------------------------------------------------------------
async function buildTeamData(teamId, year) {
  const team = TEAM_BY_ID.get(String(teamId));
  if (!team) throw new Error(`Unknown team id: ${teamId}`);
  const cur = currentNflSeason();
  let src;
  if (year >= cur) src = await espnSource(team, teamId);
  else if (year >= SEASON.NEW_FORMAT_FROM) src = await newFormatSource(team, year);
  else if (year >= SEASON.OLDEST) src = await oldFormatSource(team, year);
  else throw new Error(`Historical depth charts for ${year} aren't available.`);
  return makeEnvelope(team, src.usedYear, src.entries);
}

// TTL + single-flight + disk last-good. `fresh` bypasses the cache, but only if
// the last pull is older than a minute (so it can't be spammed as an amplifier).
const teamStore = new Map();
async function getTeamData(teamId, year, fresh) {
  const key = `${teamId}:${year}`;
  const existing = teamStore.get(key);
  if (fresh) {
    // Only bust a COMPLETED value older than a minute. Never delete an in-flight
    // entry (that would break single-flight) or spam upstreams on rapid refresh.
    if (existing && "value" in existing && Date.now() - existing.time > 60000) teamStore.delete(key);
  } else if (existing && "value" in existing) {
    stats.cacheHits++;
  }
  try {
    return await cached(teamStore, key, DEPTH_TTL, async () => {
      const data = await buildTeamData(teamId, year);
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
// HTTP LAYER
// ---------------------------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
  "Content-Security-Policy": [
    "default-src 'self'",
    "img-src 'self' data: https://a.espncdn.com",
    "style-src 'self'",
    "script-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join("; "),
};

// Send a response with security headers, and gzip when it's worth it.
function respond(req, res, status, body, contentType, extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const headers = { "Content-Type": contentType, ...SECURITY_HEADERS, ...extra };
  const gzip = /\bgzip\b/.test(req.headers["accept-encoding"] || "") && /text|json|javascript|svg/.test(contentType) && buf.length > 512;
  const isHead = req.method === "HEAD";
  if (gzip) {
    const gz = zlib.gzipSync(buf);
    res.writeHead(status, { ...headers, "Content-Encoding": "gzip", Vary: "Accept-Encoding", "Content-Length": gz.length });
    res.end(isHead ? undefined : gz);
  } else {
    res.writeHead(status, { ...headers, "Content-Length": buf.length });
    res.end(isHead ? undefined : buf);
  }
}
const sendJson = (req, res, status, obj, extra) => respond(req, res, status, JSON.stringify(obj), MIME[".json"], extra);

// Small in-memory static cache with ETag; re-reads a file only if its mtime changed.
const staticCache = new Map();
function serveStatic(req, res) {
  let urlPath = req.url.split("?")[0];
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = urlPath === "/teams.js" ? TEAMS_FILE : path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!(filePath === TEAMS_FILE || filePath.startsWith(PUBLIC_DIR + path.sep))) {
    return respond(req, res, 403, "Forbidden", "text/plain");
  }
  let stat;
  try { stat = fs.statSync(filePath); } catch (_) { return respond(req, res, 404, "Not found", "text/plain"); }

  let entry = staticCache.get(filePath);
  if (!entry || entry.mtimeMs !== stat.mtimeMs) {
    const body = fs.readFileSync(filePath);
    entry = { body, mtimeMs: stat.mtimeMs, etag: '"' + crypto.createHash("sha1").update(body).digest("hex").slice(0, 16) + '"', mime: MIME[path.extname(filePath)] || "application/octet-stream" };
    staticCache.set(filePath, entry);
  }
  if (req.headers["if-none-match"] === entry.etag) {
    res.writeHead(304, { ETag: entry.etag, ...SECURITY_HEADERS });
    return res.end();
  }
  respond(req, res, 200, entry.body, entry.mime, { ETag: entry.etag, "Cache-Control": "public, max-age=300" });
}

// Very small per-IP token bucket to blunt abuse of the fetch-triggering endpoints.
const buckets = new Map();
function rateLimited(ip) {
  const now = Date.now(), cap = 120, refill = 2; // ~2 req/sec sustained, burst 120
  let b = buckets.get(ip);
  if (!b) {
    // Bound memory: when the map gets large, drop idle (full-token) buckets so a
    // flood of distinct IPs can't grow it without limit.
    if (buckets.size > 10000) for (const [k, v] of buckets) if (v.tokens >= cap) buckets.delete(k);
    b = { tokens: cap, last: now };
    buckets.set(ip, b);
  }
  b.tokens = Math.min(cap, b.tokens + ((now - b.last) / 1000) * refill);
  b.last = now;
  if (b.tokens < 1) return true;
  b.tokens -= 1;
  return false;
}

const isNumericId = (s) => /^\d+$/.test(s || "");

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  stats.requests++;
  const urlPath = req.url.split("?")[0];
  const done = (status) => console.log(`${req.method} ${req.url} ${status} ${Date.now() - t0}ms`);

  try {
    // Liveness — no upstream calls, safe for a keep-warm pinger.
    if (urlPath === "/healthz") {
      sendJson(req, res, 200, { status: "ok", uptimeSec: Math.round((Date.now() - stats.started) / 1000), season: currentNflSeason(), ...stats });
      return done(200);
    }

    if (urlPath.startsWith("/api/")) {
      if (req.method !== "GET" && req.method !== "HEAD") { sendJson(req, res, 405, { error: "Method not allowed" }); return done(405); }
      // Use the RIGHTMOST X-Forwarded-For hop (the one the trusted proxy/Render
      // appends) — the leftmost value is client-supplied and easily spoofed.
      const xff = req.headers["x-forwarded-for"];
      const ip = (xff ? xff.split(",").pop().trim() : req.socket.remoteAddress) || "unknown";
      if (rateLimited(ip)) { stats.rateLimited++; sendJson(req, res, 429, { error: "Too many requests" }); return done(429); }
      const params = new URL(req.url, `http://localhost:${PORT}`).searchParams;

      if (urlPath === "/api/depth") {
        const teamId = params.get("team") || "2";
        if (!isNumericId(teamId) || !TEAM_BY_ID.has(teamId)) { sendJson(req, res, 400, { error: "Unknown team" }); return done(400); }
        const cur = currentNflSeason();
        let year = Number(params.get("year")) || cur;
        year = Math.min(cur, Math.max(SEASON.OLDEST, year));
        try {
          const data = await getTeamData(teamId, year, params.get("fresh") === "1");
          sendJson(req, res, 200, data);
          return done(200);
        } catch (err) {
          console.error("depth error:", err.message);
          sendJson(req, res, 502, { error: "Couldn't load lineup data right now. Please try again." });
          return done(502);
        }
      }

      if (urlPath === "/api/ages") {
        const year = Number(params.get("year")) || currentNflSeason();
        const ids = (params.get("ids") || "").split(",").filter(isNumericId).slice(0, 40);
        const ages = {};
        await Promise.all(ids.map(async (id) => {
          try { ages[id] = ageFromDob((await getAthlete(id)).dob, year); }
          catch { ages[id] = null; } // transient upstream miss -> null now, retried later
        }));
        sendJson(req, res, 200, { ages }, { "Cache-Control": "public, max-age=86400" });
        return done(200);
      }

      sendJson(req, res, 404, { error: "Not found" });
      return done(404);
    }

    if (req.method !== "GET" && req.method !== "HEAD") { respond(req, res, 405, "Method not allowed", "text/plain"); return done(405); }
    serveStatic(req, res);
    done(res.statusCode);
  } catch (err) {
    console.error("unhandled:", err && err.message);
    if (!res.headersSent) sendJson(req, res, 500, { error: "Server error" });
    done(500);
  }
});

server.listen(PORT, () => {
  console.log(`\n🏈  NFL Depth Chart running!  Open  http://localhost:${PORT}\n`);
});
