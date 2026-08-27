// lib/espn.js
// ---------------------------------------------------------------------------
// Shared engine for every sport. Nothing here is sport-specific on its own —
// each sport passes in a small config (see ../sports/*.js) that says which
// ESPN league to hit, what the on-surface spots are, and how to read a player's
// bio. The heavy lifting (resilient fetch, caching, resolving depth charts and
// match lineups) lives here so all four sports share one battle-tested core.
//
// Two ways a lineup gets built:
//   • "depth"  (NHL, NBA) — ESPN serves a real ranked depth chart per position.
//   • "match"  (MLS)      — ESPN has no soccer depth chart, so we read the
//                            team's most recent match: the actual starting XI
//                            and formation, with the rest of the roster as depth.
// ---------------------------------------------------------------------------

const fs = require("fs");
const os = require("os");
const path = require("path");

// Counters surfaced on /healthz so free-tier hiccups aren't guesswork.
const stats = { started: Date.now(), requests: 0, cacheHits: 0, upstreamOk: 0, upstreamFail: 0, rateLimited: 0 };

// ---------------------------------------------------------------------------
// RESILIENT FETCH — timeout, retry on 5xx/network, and a response size cap so a
// hung or oversized upstream can't stall a request or blow up memory.
// (Lifted from the NFL app, which has run this in production.)
// ---------------------------------------------------------------------------
async function fetchText(url, { ua = "sports-depth-chart-app", timeout = 15000, retries = 2, maxBytes = 40 * 1024 * 1024 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": ua, Accept: "application/json" }, signal: AbortSignal.timeout(timeout) });
      if (!res.ok) {
        if (res.status >= 500 && attempt < retries) { lastErr = new Error(`HTTP ${res.status}`); continue; }
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
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
async function fetchJson(url, opts) { return JSON.parse(await fetchText(url, opts)); }

// ---------------------------------------------------------------------------
// CACHING — TTL freshness + single-flight (a burst of identical requests shares
// ONE in-flight fetch) + NO negative caching (a thrown fetch is never stored).
// ---------------------------------------------------------------------------
function cached(store, key, ttlMs, fn) {
  const hit = store.get(key);
  if (hit) {
    if ("value" in hit && (ttlMs === Infinity || Date.now() - hit.time < ttlMs)) return Promise.resolve(hit.value);
    if (hit.promise) return hit.promise;
  }
  const promise = (async () => {
    const value = await fn();
    store.set(key, { time: Date.now(), value });
    return value;
  })();
  store.set(key, { ...(store.get(key) || {}), promise });
  promise.catch(() => {
    const cur = store.get(key);
    if (!cur || cur.promise !== promise) return;
    if ("value" in cur) delete cur.promise;
    else store.delete(key);
  });
  return promise;
}

// Best-effort last-good copy on disk, so a cold start (or downed upstream) can
// still serve something instead of a bare error.
const DISK_DIR = path.join(os.tmpdir(), "sports-depth-cache");
function diskPath(key) { return path.join(DISK_DIR, key.replace(/[^\w.-]/g, "_") + ".json"); }
function writeDisk(key, data) { try { fs.mkdirSync(DISK_DIR, { recursive: true }); fs.writeFileSync(diskPath(key), JSON.stringify(data)); } catch {} }
function readDisk(key) { try { return JSON.parse(fs.readFileSync(diskPath(key), "utf8")); } catch { return null; } }

// ---------------------------------------------------------------------------
// ESPN endpoint builders
// ---------------------------------------------------------------------------
const core = "https://sports.core.api.espn.com/v2/sports";
const site = "https://site.api.espn.com/apis/site/v2/sports";
const depthUrl = (s, l, year, id) => `${core}/${s}/leagues/${l}/seasons/${year}/teams/${id}/depthcharts`;
const rosterUrl = (s, l, id) => `${site}/${s}/${l}/teams/${id}/roster`;
const scheduleUrl = (s, l, id) => `${site}/${s}/${l}/teams/${id}/schedule`;
const summaryUrl = (s, l, ev) => `${site}/${s}/${l}/summary?event=${ev}`;
const idFromRef = (ref) => (/athletes\/(\d+)/.exec(ref || "") || [])[1] || null;

// ---------------------------------------------------------------------------
// ROSTER → a map of playerId -> tidy bio. Handles both shapes ESPN returns:
// grouped (athletes:[{position,items:[…]}]) and flat (athletes:[…]).
// ---------------------------------------------------------------------------
function injuryStatus(a) {
  const inj = (a.injuries || [])[0];
  if (!inj) return null;
  return inj.status || inj.type?.description || inj.type?.name || null;
}
function flatAthletes(roster) {
  const list = roster.athletes || [];
  if (list.length && list[0] && Array.isArray(list[0].items)) return list.flatMap((g) => g.items || []);
  return list;
}
function buildRosterMap(roster, cfg) {
  const map = new Map();
  for (const a of flatAthletes(roster)) {
    const { extra, pos } = cfg.bio ? cfg.bio(a) : { extra: "", pos: a.position?.abbreviation || "" };
    map.set(String(a.id), {
      id: String(a.id),
      name: a.fullName || a.displayName || "Unknown",
      jersey: a.jersey || "",
      injury: injuryStatus(a),
      age: typeof a.age === "number" ? a.age : null,
      height: a.displayHeight || "",
      weight: a.displayWeight || "",
      exp: a.experience && typeof a.experience.years === "number" ? a.experience.years : null,
      extra: extra || "",
      pos: pos || (a.position?.abbreviation || ""),
    });
  }
  return map;
}

// Turn a depth-chart position bucket into a rank-ordered list of resolved players.
function rankedPlayers(posBucket, rosterMap) {
  const out = [];
  for (const a of (posBucket?.athletes || []).slice().sort((x, y) => (x.rank || 99) - (y.rank || 99))) {
    const id = idFromRef(a.athlete && a.athlete.$ref);
    const bio = id && rosterMap.get(id);
    if (!bio) continue; // player no longer on the roster (traded/waived) — skip
    out.push({ rank: a.rank || out.length + 1, ...bio });
  }
  return out;
}

// ---------------------------------------------------------------------------
// BUILDER A: "depth" sports (NHL, NBA) — ESPN's ranked depth chart per position.
// ---------------------------------------------------------------------------
async function resolveDepthLineup(cfg, team) {
  const { sport, league } = cfg.espn;
  const nowY = new Date().getUTCFullYear();
  // Prefer the newest season that actually has a depth chart (auto-tracks the
  // Oct season rollover for leagues ESPN labels by end-year).
  let depth = null;
  for (const year of [nowY + 1, nowY, nowY - 1]) {
    try {
      const d = await fetchJson(depthUrl(sport, league, year, team.id));
      if (d && (d.items || []).length && d.items[0].positions) { depth = d; break; }
    } catch {}
  }
  if (!depth) throw new Error(`No depth chart available for ${team.name}.`);
  const positions = depth.items[0].positions || {};
  const rosterMap = buildRosterMap(await fetchJson(rosterUrl(sport, league, team.id)), cfg);

  const chips = [];
  for (const spec of cfg.layout) {
    const bucket = positions[spec.posKey];
    const players = rankedPlayers(bucket, rosterMap);
    if (!players.length) continue;
    const faceIdx = Math.min((spec.faceRank || 1) - 1, players.length - 1);
    chips.push({
      key: spec.key, label: spec.label, group: spec.group, x: spec.x, y: spec.y,
      face: players[faceIdx],
      players, // full ranked depth for the popover
    });
  }
  return { formation: null, subtitle: "Starting Lineup", chips };
}

// ---------------------------------------------------------------------------
// BUILDER B: "match" sport (MLS) — read the most recent match for the real
// starting XI + formation; the rest of the roster (by line) is the depth.
// ---------------------------------------------------------------------------
// A player's on-pitch slot from their ESPN position code (e.g. "CD-R", "AM-L",
// "RB", "LM"). ESPN's `formationPlace` is just internal slot numbering and does
// NOT follow back→front / left→right order, so we parse the position instead.
//   band: 0 GK, 1 defense, 2 defensive-mid, 3 midfield, 4 attacking-mid, 5 forward
//   side: -1 left, 0 center, +1 right
function soccerSlot(posAbbr) {
  const raw = (posAbbr || "").toUpperCase().trim();
  const suf = (/-(L|R|C)$/.exec(raw) || [])[1] || "";
  const base = raw.replace(/-(L|R|C)$/, "");
  let side = suf === "L" ? -1 : suf === "R" ? 1 : 0;
  let band, wide = false, center = false;
  if (/^G/.test(base)) band = 0;
  else if (["RB", "LB", "RWB", "LWB"].includes(base)) { band = 1; wide = true; side = base[0] === "L" ? -1 : 1; }
  else if (["CB", "CD", "SW", "D", "FB", "WB"].includes(base)) { band = 1; center = true; }
  else if (["DM", "CDM"].includes(base)) { band = 2; center = true; }
  else if (["AM", "CAM", "SS"].includes(base)) { band = 4; }
  else if (["LW", "RW"].includes(base)) { band = 5; wide = true; side = base[0] === "L" ? -1 : 1; }
  else if (["RF", "LF", "CF", "ST", "F", "S"].includes(base)) { band = 5; if (base[0] === "L") side = -1; else if (base[0] === "R") side = 1; }
  else if (["LM", "RM"].includes(base)) { band = 3; wide = true; side = base[0] === "L" ? -1 : 1; }
  else if (["CM", "M", "MF"].includes(base)) { band = 3; center = true; }
  else band = 3;
  // xhint in [-1,1]: side scaled by role width, so fullbacks/wingers sit outside
  // center-backs/central mids on the same line.
  const mag = wide ? 1.0 : center ? 0.35 : 0.7;
  return { band, side, xhint: side * mag };
}
const BAND_GROUP = { 0: "Goalkeeper", 1: "Defense", 2: "Midfield", 3: "Midfield", 4: "Midfield", 5: "Forward" };
// Broad line used for the depth popover (GK / Defense / Midfield / Forward).
const soccerGroup = (posAbbr, parentName) => {
  const p = (parentName || "").toLowerCase();
  if (p.includes("goal")) return "Goalkeeper";
  if (p.includes("defender") || p.includes("back")) return "Defense";
  if (p.includes("midfield")) return "Midfield";
  if (p.includes("forward") || p.includes("striker")) return "Forward";
  return BAND_GROUP[soccerSlot(posAbbr).band] || "Midfield";
};
// Lay the 11 starters out on the pitch: group them into the lines their
// positions imply, then space those lines back (own goal, y≈6) to front
// (attacking, y≈44), and spread each line left→right.
function placeStarters(entries) {
  const xspan = (n) => (n >= 4 ? [12, 88] : n === 3 ? [22, 78] : n === 2 ? [34, 66] : [50, 50]);
  const outfield = [...new Set(entries.map((e) => e.band))].filter((b) => b !== 0).sort((a, b) => a - b);
  const yFor = (band) => {
    if (band === 0) return 11; // GK — kept clear of the team name band
    const k = outfield.indexOf(band), B = outfield.length;
    return B <= 1 ? 30 : 19 + (47 - 19) * (k / (B - 1));
  };
  const byBand = {};
  entries.forEach((e) => (byBand[e.band] = byBand[e.band] || []).push(e));
  for (const arr of Object.values(byBand)) {
    arr.sort((a, b) => (a.xhint ?? a.side) - (b.xhint ?? b.side) || a.fp - b.fp);
    const [lo, hi] = xspan(arr.length), n = arr.length;
    arr.forEach((e, i) => { e.x = n === 1 ? 50 : lo + (hi - lo) * (i / (n - 1)); e.y = yFor(e.band); });
  }
  return entries;
}

async function resolveMatchLineup(cfg, team) {
  const { sport, league } = cfg.espn;
  const rosterJson = await fetchJson(rosterUrl(sport, league, team.id));
  const rosterMap = buildRosterMap(rosterJson, cfg);
  // Depth-by-line from the full roster (used for the popover behind each spot).
  const byGroup = { Goalkeeper: [], Defense: [], Midfield: [], Forward: [] };
  for (const a of flatAthletes(rosterJson)) {
    const g = soccerGroup(a.position?.abbreviation, a.position?.parent?.name || a.position?.name);
    const bio = rosterMap.get(String(a.id));
    if (bio) byGroup[g].push({ rank: byGroup[g].length + 1, ...bio });
  }

  // Most recent completed match → its lineup + formation. ESPN's schedule is
  // NOT date-sorted, so sort by date and take the genuinely latest game.
  let lineup = null, oppName = "", when = null;
  try {
    const sched = await fetchJson(scheduleUrl(sport, league, team.id));
    const done = (sched.events || []).filter((e) => e.competitions?.[0]?.status?.type?.completed)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    const last = done[0];
    if (last) {
      when = last.date || null;
      const sum = await fetchJson(summaryUrl(sport, league, last.id));
      const mine = (sum.rosters || []).find((r) => String(r.team?.id) === String(team.id));
      const opp = (sum.rosters || []).find((r) => String(r.team?.id) !== String(team.id));
      oppName = opp?.team?.shortDisplayName || opp?.team?.displayName || "";
      if (mine && (mine.roster || []).some((x) => x.starter)) lineup = mine;
    }
  } catch {}

  let chips = [], formation = null;
  if (lineup) {
    formation = lineup.formation || null;
    const entries = (lineup.roster || []).filter((x) => x.starter).map((s) => {
      const id = String(s.athlete?.id || idFromRef(s.athlete?.$ref) || "");
      const bio = rosterMap.get(id) || { id, name: s.athlete?.displayName || "—", jersey: s.jersey || "", injury: null, age: null, height: "", weight: "", exp: null, extra: "", pos: s.position?.abbreviation || "" };
      const posAbbr = s.position?.abbreviation || bio.pos || "";
      const { band, side, xhint } = soccerSlot(posAbbr);
      return { bio, posAbbr, band, side, xhint, fp: Number(s.formationPlace) || 99, grp: soccerGroup(posAbbr, s.position?.parent?.name) };
    });
    placeStarters(entries);
    entries.sort((a, b) => a.band - b.band || a.x - b.x);
    chips = entries.map((e, i) => {
      const rest = (byGroup[e.grp] || []).filter((p) => p.id !== e.bio.id);
      return { key: `p${i}`, label: (e.posAbbr || e.grp).toUpperCase(), group: e.grp, x: e.x, y: e.y, face: { rank: 1, ...e.bio }, players: [{ rank: 1, ...e.bio }, ...rest.map((p, k) => ({ ...p, rank: k + 2 }))] };
    });
    return { formation, subtitle: `${formation || "XI"} · last match${oppName ? ` vs ${oppName}` : ""}`, chips, updatedMatch: when };
  }

  // Fallback (no match lineup available): a projected 4-3-3 from the roster by line.
  const plan = [["Goalkeeper", 0, 1], ["Defense", 1, 4], ["Midfield", 3, 3], ["Forward", 5, 3]];
  const entries = [];
  for (const [grp, band, n] of plan) {
    for (let k = 0; k < n; k++) {
      const p = byGroup[grp][k]; if (!p) continue;
      const side = k === 0 ? -1 : k === n - 1 ? 1 : 0;
      entries.push({ bio: p, posAbbr: p.pos || "", band, side, xhint: side, fp: k, grp });
    }
  }
  placeStarters(entries);
  entries.sort((a, b) => a.band - b.band || a.x - b.x);
  chips = entries.map((e, i) => {
    const rest = byGroup[e.grp].filter((q) => q.id !== e.bio.id);
    return { key: `p${i}`, label: (e.posAbbr || e.grp).toUpperCase(), group: e.grp, x: e.x, y: e.y, face: { rank: 1, ...e.bio }, players: [{ rank: 1, ...e.bio }, ...rest.map((q, j) => ({ ...q, rank: j + 2 }))] };
  });
  return { formation: "4-3-3", subtitle: "Projected XI · 4-3-3", chips };
}

// ---------------------------------------------------------------------------
// BUILDER C: "statrank" sport (NHL) — ESPN's hockey depth chart is unmaintained
// (it lists retired players), but the roster is current and per-player season
// stats are available. So we take the REAL roster and rank each position by last
// season's production: skaters by points, goalies by games played. The lineup
// is 100% real data; only the LINE ORDER is a (clearly labeled) projection.
// ---------------------------------------------------------------------------
const statStore = new Map();
async function statScores(sport, league, season, ids) {
  const map = new Map();
  const cap = 8;
  let i = 0;
  async function worker() {
    while (i < ids.length) {
      const id = ids[i++];
      try {
        map.set(id, await cached(statStore, `${league}:${season}:${id}`, Infinity, async () => {
          const st = await fetchJson(`${core}/${sport}/leagues/${league}/seasons/${season}/types/2/athletes/${id}/statistics`);
          const cats = st.splits?.categories || [];
          const get = (cn, sn) => { const c = cats.find((c) => c.name === cn); const s = (c?.stats || []).find((s) => s.name === sn); return s ? Number(s.value) : null; };
          return { points: get("offensive", "points"), games: get("general", "games") };
        }));
      } catch { map.set(id, { points: null, games: null }); } // transient miss → not cached, treated as unranked
    }
  }
  await Promise.all(Array.from({ length: cap }, worker));
  return map;
}
const seasonLabel = (y) => `${y - 1}-${String(y).slice(2)}`;

async function resolveStatRankedLineup(cfg, team) {
  const { sport, league } = cfg.espn;
  const rosterJson = await fetchJson(rosterUrl(sport, league, team.id));
  const rosterMap = buildRosterMap(rosterJson, cfg);
  const wanted = new Set(cfg.layout.map((s) => s.posKey));
  const buckets = {};
  for (const a of flatAthletes(rosterJson)) {
    const pk = (a.position?.abbreviation || "").toLowerCase();
    if (!wanted.has(pk)) continue;
    const bio = rosterMap.get(String(a.id));
    if (bio) (buckets[pk] = buckets[pk] || []).push(bio);
  }
  let season = cfg.statSeason || new Date().getUTCFullYear();
  const ids = Object.values(buckets).flat().map((b) => b.id);
  let scores = await statScores(sport, league, season, ids);
  if (![...scores.values()].some((s) => s.points != null || s.games != null)) {
    season -= 1; // nothing for this label — fall back a year (calendar-edge safety)
    scores = await statScores(sport, league, season, ids);
  }
  for (const pk of Object.keys(buckets)) {
    const isG = pk === "g";
    buckets[pk].sort((x, y) => {
      const sx = scores.get(x.id) || {}, sy = scores.get(y.id) || {};
      const vx = (isG ? sx.games : sx.points) ?? -1, vy = (isG ? sy.games : sy.points) ?? -1;
      return vy - vx;
    });
  }
  const chips = [];
  for (const spec of cfg.layout) {
    const players = (buckets[spec.posKey] || []).map((b, i) => ({ rank: i + 1, ...b }));
    if (!players.length) continue;
    const faceIdx = Math.min((spec.faceRank || 1) - 1, players.length - 1);
    chips.push({ key: spec.key, label: spec.label, group: spec.group, x: spec.x, y: spec.y, face: players[faceIdx], players });
  }
  return { formation: null, subtitle: `Projected lines · by ${seasonLabel(season)} production`, chips };
}

// ---------------------------------------------------------------------------
// PUBLIC: build one team's lineup payload (cached per team, daily).
// ---------------------------------------------------------------------------
async function buildLineup(cfg, team) {
  const src = cfg.kind === "match" ? await resolveMatchLineup(cfg, team)
    : cfg.kind === "statrank" ? await resolveStatRankedLineup(cfg, team)
      : await resolveDepthLineup(cfg, team);
  return {
    sport: cfg.key,
    surface: cfg.surface,
    team: { id: team.id, name: team.name, abbr: team.abbr, color: team.color, alt: team.alt, logo: team.logo },
    formation: src.formation,
    subtitle: src.subtitle,
    chips: src.chips,
    updated: new Date().toISOString(),
  };
}

module.exports = {
  stats, fetchText, fetchJson, cached, writeDisk, readDisk, buildLineup,
  // exported for possible reuse/testing
  buildRosterMap, rankedPlayers, soccerSlot, soccerGroup, placeStarters,
};
