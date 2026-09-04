// lib/nfl.js
// ---------------------------------------------------------------------------
// The NFL engine, ported from the standalone Bills Depth Chart app into this
// unified site. It keeps NFL's richer model — offense vs defense, personnel &
// formation packages (client side), past seasons via nflverse, and Madden OVR —
// while reusing the shared fetch/cache helpers in espn.js.
//
// Exposes:
//   getTeamData(teamId, year, fresh) -> the lineup envelope for /api/depth
//   getAthlete(id)                    -> { dob } for /api/ages
//   NFL_TEAMS, SEASON, currentNflSeason, ageFromDob (re-exported)
// ---------------------------------------------------------------------------

const { fetchText, fetchJson, cached, writeDisk, readDisk, stats, injuryDetail } = require("./espn.js");
const { NFL_TEAMS, SEASON, currentNflSeason } = require("../public/nfl/teams.js");
const {
  parseCsv, splitCsvLine, normName, ageFromDob, offenseKey, defenseCat, groupBy, splitIntoSpots, assembleUnit,
} = require("./nfl-util.js");

const TEAM_BY_ID = new Map(NFL_TEAMS.map((t) => [String(t.id), t]));
const NFLVERSE_CLUB = { LAR: "LA", WSH: "WAS" };
const DEPTH_TTL = (Number(process.env.DEPTH_TTL_HOURS) || 24) * 3600e3;
const MADDEN_TTL = (Number(process.env.MADDEN_TTL_DAYS) || 30) * 86400e3;
const BIG = 100 * 1024 * 1024; // nflverse CSVs can be ~50MB

// ESPN endpoints
const depthChartUrl = (year, teamId) =>
  `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${year}/teams/${teamId}/depthcharts`;
const rosterUrl = (teamId) =>
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${teamId}/roster`;
const athleteUrl = (id) =>
  `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/athletes/${id}`;
const athleteIdFromRef = (ref) => (/athletes\/(\d+)/.exec(ref || "") || [])[1] || null;

// ---------------------------------------------------------------------------
// Unified builder — every source normalizes into { unit, key, abbr, slot, rank, player }
// ---------------------------------------------------------------------------
function makeEnvelope(team, season, entries) {
  const pick = (u) => entries.filter((e) => e.unit === u);
  const off = pick("offense"), def = pick("defense"), st = pick("st");
  return {
    team: team.name, teamAbbr: team.abbr, season, fetchedAt: new Date().toISOString(),
    record: null, next: null,
    offense: off.length ? { formation: "Offense", positions: assembleUnit(off, "offense") } : null,
    defense: def.length ? { formation: "Defense", positions: assembleUnit(def, "defense") } : null,
    specialTeams: st.length ? { formation: "Special Teams", positions: assembleUnit(st, "offense") } : null,
  };
}

// SOURCE 1: current season, live from ESPN
function buildRosterMap(roster, maddenMap) {
  const map = new Map();
  for (const group of roster.athletes || []) {
    for (const a of group.items || []) {
      const injuries = a.injuries || [];
      const name = a.fullName || a.displayName || "Unknown";
      map.set(String(a.id), {
        name, jersey: a.jersey || "", injury: injuries.length ? injuries[0].status : null,
        injuryDetail: injuryDetail(a), // richer what/return info for the popover (parity with surface)
        overall: maddenMap ? maddenMap.get(normName(name)) ?? null : null,
        // Age ships in the roster payload (site-v2 roster carries it), so capture it here:
        // the client then skips the separate /api/ages fan-out entirely for current lineups.
        age: typeof a.age === "number" ? a.age : null,
        height: a.displayHeight || "", weight: a.displayWeight || "",
        college: (a.college && a.college.name) || "",
        exp: a.experience && typeof a.experience.years === "number" ? a.experience.years : null,
      });
    }
  }
  return map;
}
function espnGroupEntries(group, knownById, season) {
  const isSt = /Special/i.test(group.name);
  const unit = isSt ? "st" : /\bD\b/.test(group.name) ? "defense" : "offense";
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
        player: {
          rank: a.rank, id: id || null, season, name: known.name, jersey: known.jersey || "",
          injury: known.injury || null, injuryDetail: known.injuryDetail || null, overall: known.overall ?? null, age: known.age ?? null,
          height: known.height || "", weight: known.weight || "", college: known.college || "", exp: known.exp ?? null,
        },
      });
    }
  }
  return entries;
}
async function espnSource(team, teamId) {
  const cur = currentNflSeason();
  // The roster + Madden map don't depend on the depth-chart probe result, so kick
  // them off NOW to overlap the probe's ESPN round trip(s) rather than waiting in
  // series after it. (.catch keeps them safely abandonable if the probe throws first.)
  const rosterP = fetchJson(rosterUrl(teamId)).catch(() => null);
  const maddenP = maddenMapSafe();
  let depth = null, usedYear = cur;
  for (const year of [cur, cur - 1]) {
    try { const d = await fetchJson(depthChartUrl(year, teamId)); if (d && (d.items || []).length) { depth = d; usedYear = year; break; } }
    catch (_) {}
  }
  if (!depth) throw new Error(`No current depth chart available for ${team.name}.`);
  const [roster, madden] = await Promise.all([rosterP, maddenP]);
  if (!roster) throw new Error(`No roster available for ${team.name}.`);
  const knownById = buildRosterMap(roster, madden);
  const entries = depth.items.flatMap((g) => espnGroupEntries(g, knownById, usedYear));
  return { entries, usedYear };
}

// SOURCE 2: 2020-2024, nflverse older weekly format
const nflverseStore = new Map();
const OLD_CSV_COLS = ["club_code", "game_type", "week", "formation", "depth_position", "depth_team", "full_name", "first_name", "last_name", "jersey_number", "gsis_id"];
function getNflverseSeason(year) {
  return cached(nflverseStore, year, Infinity, async () => {
    const url = `https://github.com/nflverse/nflverse-data/releases/download/depth_charts/depth_charts_${year}.csv`;
    let text = await fetchText(url, { timeout: 45000, maxBytes: BIG });
    // Single-pass, REG-only, column-filtered scan (mirrors getNewFormatSeason) instead of
    // parseCsv materializing a full all-fields row array for a ~50MB file: keep only the
    // ~11 needed columns and drop non-REG rows in ONE pass, so peak memory is the kept
    // slices — not the entire file exploded into arrays-of-every-field plus mapped objects
    // (a ~250-350MB transient on a 512MB box). Same nflverse source + line-based parsing as
    // getNewFormatSeason, and splitCsvLine already handles quoted commas + trailing \r.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
    const headerEnd = text.indexOf("\n");
    if (headerEnd === -1) return [];
    const header = splitCsvLine(text.slice(0, headerEnd));
    const idx = Object.fromEntries(OLD_CSV_COLS.map((c) => [c, header.indexOf(c)]));
    const gt = idx.game_type; // oldFormatSource keeps only REG rows anyway
    const rows = [];
    for (let i = headerEnd + 1; i < text.length;) {
      const nl = text.indexOf("\n", i); const end = nl === -1 ? text.length : nl;
      if (end > i) {
        const c = splitCsvLine(text.slice(i, end));
        if (gt === -1 || c[gt] === "REG") {
          const row = {};
          for (const col of OLD_CSV_COLS) { const j = idx[col]; if (j !== -1) row[col] = c[j]; }
          rows.push(row);
        }
      }
      if (nl === -1) break; i = end + 1;
    }
    return rows;
  }, 6); // bound: retain only the ~6 seasons actually browsed (was unbounded/Infinity)
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
    return { rank, id: m.espn_id || null, season: year, name, jersey: r.jersey_number || m.jersey || "", injury: null, overall: ovrFromMadden(madden, name, nick), age: ageFromDob(m.dob, year), height: m.height || "", weight: m.weight || "", college: m.college || "", exp: m.rookieSeason ? Math.max(0, year - m.rookieSeason) : null };
  };
  const entries = [];
  for (const [key, group] of groupBy(wk.filter((r) => r.formation === "Offense"), (r) => offenseKey(r.depth_position))) {
    splitIntoSpots(group, mkPlayer).forEach((sp) => sp.players.forEach((pl) => entries.push({ unit: "offense", key, abbr: key.toUpperCase(), slot: sp.slot, rank: pl.rank, player: pl })));
  }
  for (const [code, group] of groupBy(wk.filter((r) => r.formation === "Defense"), (r) => r.depth_position)) {
    if (!defenseCat(code)) continue;
    splitIntoSpots(group, mkPlayer).forEach((sp) => sp.players.forEach((pl) => entries.push({ unit: "defense", key: code.toLowerCase(), abbr: code.trim().toUpperCase(), slot: sp.slot, rank: pl.rank, player: pl })));
  }
  for (const [code, group] of groupBy(wk.filter((r) => r.formation === "Special Teams"), (r) => r.depth_position)) {
    splitIntoSpots(group, mkPlayer).forEach((sp) => sp.players.forEach((pl) => entries.push({ unit: "st", key: code.toLowerCase(), abbr: code.trim().toUpperCase(), slot: sp.slot, rank: pl.rank, player: pl })));
  }
  return { entries, usedYear: year };
}

// SOURCE 3: 2025+, nflverse newer (ESPN-shaped) format
const newFormatStore = new Map();
function getNewFormatSeason(year) {
  return cached(newFormatStore, year, Infinity, async () => {
    const url = `https://github.com/nflverse/nflverse-data/releases/download/depth_charts/depth_charts_${year}.csv`;
    const text = await fetchText(url, { timeout: 60000, maxBytes: BIG });
    const headerEnd = text.indexOf("\n");
    const header = splitCsvLine(text.slice(0, headerEnd));
    const col = (name) => header.indexOf(name);
    const opener = `${year}-08-15`; // earliest plausible opener snapshot (lenient vs a hardcoded date)
    let target = null;
    for (let i = headerEnd + 1; i < text.length;) {
      const nl = text.indexOf("\n", i); const end = nl === -1 ? text.length : nl;
      const comma = text.indexOf(",", i);
      if (comma !== -1 && comma < end) { const dt = text.slice(i, comma); if (dt >= opener && (target === null || dt < target)) target = dt; }
      if (nl === -1) break; i = end + 1;
    }
    if (!target) throw new Error(`No ${year} in-season snapshot found.`);
    const want = ["team", "player_name", "espn_id", "gsis_id", "pos_grp", "pos_abb", "pos_slot", "pos_rank"];
    const idx = Object.fromEntries(want.map((w) => [w, col(w)]));
    const rows = [];
    for (let i = headerEnd + 1; i < text.length;) {
      const nl = text.indexOf("\n", i); const end = nl === -1 ? text.length : nl;
      if (text.startsWith(target + ",", i)) { const c = splitCsvLine(text.slice(i, end)); const row = {}; for (const w of want) row[w] = c[idx[w]]; rows.push(row); }
      if (nl === -1) break; i = end + 1;
    }
    return rows;
  }, 6); // bound: retain only the ~6 seasons actually browsed (was unbounded/Infinity)
}
async function newFormatSource(team, year) {
  const club = NFLVERSE_CLUB[team.abbr] || team.abbr;
  const [rows, meta, madden] = await Promise.all([getNewFormatSeason(year), getPlayersMeta(), getSeasonMadden(year)]);
  const teamRows = rows.filter((r) => r.team === club || r.team === team.abbr);
  if (!teamRows.length) throw new Error(`No ${year} depth chart for ${team.name}.`);
  const nick = team.name.split(" ").pop();
  const mk = (r) => {
    const m = meta.get(r.gsis_id) || {};
    return { rank: Number(r.pos_rank) || 1, id: r.espn_id || m.espn_id || null, season: year, name: r.player_name || "—", jersey: m.jersey || "", injury: null, overall: ovrFromMadden(madden, r.player_name, nick), age: ageFromDob(m.dob, year), height: m.height || "", weight: m.weight || "", college: m.college || "", exp: m.rookieSeason ? Math.max(0, year - m.rookieSeason) : null };
  };
  const entries = [];
  for (const r of teamRows) {
    const isSt = /Special/i.test(r.pos_grp);
    const unit = isSt ? "st" : /\bD\b/.test(r.pos_grp) ? "defense" : "offense";
    const abbr = r.pos_abb || "";
    const key = unit === "offense" ? offenseKey(abbr) || abbr.toLowerCase() : abbr.toLowerCase();
    if (!key) continue;
    entries.push({ unit, key, abbr, slot: Number(r.pos_slot), rank: Number(r.pos_rank) || 1, player: mk(r) });
  }
  return { entries, usedYear: year };
}

// nflverse players.csv -> bio, keyed by gsis id
const playersMetaStore = new Map();
function fmtHeight(inches) { const n = Number(inches); if (!n || isNaN(n)) return ""; return `${Math.floor(n / 12)}' ${n % 12}"`; }
function getPlayersMeta() {
  return cached(playersMetaStore, "v", Infinity, async () => {
    const url = "https://github.com/nflverse/nflverse-data/releases/download/players/players.csv";
    const cols = ["gsis_id", "birth_date", "espn_id", "jersey_number", "height", "weight", "college_name", "rookie_season"];
    const rows = parseCsv(await fetchText(url, { timeout: 45000, maxBytes: BIG }), cols);
    const map = new Map();
    for (const r of rows) if (r.gsis_id) map.set(r.gsis_id, {
      dob: r.birth_date || null, espn_id: r.espn_id || null, jersey: r.jersey_number || "",
      height: fmtHeight(r.height), weight: r.weight ? `${r.weight} lbs` : "",
      college: (r.college_name || "").split(/[;,]/)[0].trim(),
      rookieSeason: r.rookie_season ? Number(r.rookie_season) : null,
    });
    return map;
  });
}

// Madden ratings
const maddenStore = new Map();
function getMaddenMap() {
  return cached(maddenStore, "v", MADDEN_TTL, async () => {
    const page = async (offset) => JSON.parse(await fetchText(`https://drop-api.ea.com/rating/madden-nfl?locale=en&limit=100&offset=${offset}`, { ua: "Mozilla/5.0" }));
    const first = await page(0);
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
async function maddenMapSafe() { try { return await getMaddenMap(); } catch { return new Map(); } }
const seasonMaddenStore = new Map();
function getSeasonMadden(year) {
  return cached(seasonMaddenStore, year, Infinity, async () => {
    const map = new Map();
    // The live EA feed only ever serves the CURRENT edition, so apply it ONLY to the
    // current season. A completed 2025+ season viewed in a later year gets no Madden
    // badge rather than stamping today's OVRs onto an old depth chart (matches the
    // soccer/NFL "no historical map → no badge" policy and stays correct every year).
    if (year >= currentNflSeason()) { for (const [k, v] of await maddenMapSafe()) map.set(k, v); return map; }
    if (year >= 2021 && year <= 2023) {
      const m = year - 1999; let got = false;
      for (const offset of [0, 1000]) {
        try {
          const docs = (JSON.parse(await fetchText(`https://ratings-api.ea.com/v2/entities/m${m}-ratings?limit=1000&offset=${offset}`, { ua: "Mozilla/5.0" })).docs) || [];
          got = true;
          for (const d of docs) {
            const name = normName(d.fullNameForSearch || `${d.firstName} ${d.lastName}`);
            const nick = (d.team || "").toLowerCase();
            if (name && typeof d.overall_rating === "number") { map.set(`${name}|${nick}`, d.overall_rating); if (!map.has(name)) map.set(name, d.overall_rating); }
          }
          if (docs.length < 1000) break;
        } catch (_) {}
      }
      if (!got) throw new Error(`Madden ${m} ratings unavailable`);
    }
    return map;
  }, 6).catch(() => new Map()); // bound: retain only the ~6 seasons actually browsed
}
function ovrFromMadden(map, name, nick) { const n = normName(name); return map.get(`${n}|${(nick || "").toLowerCase()}`) ?? map.get(n) ?? null; }

// Age lookup for the current season
const athleteStore = new Map();
function getAthlete(id) {
  // Bounded by cached()'s cap (evicts oldest — birthdays don't change, safe to drop)
  // instead of the old all-or-nothing clear() at 5000.
  return cached(athleteStore, id, Infinity, async () => { const d = await fetchJson(athleteUrl(id)); return { dob: d.dateOfBirth || null }; }, 3000);
}

// Current-season W–L record (shown in the team band); cached ~6h. Skipped for
// past seasons (the roster/record endpoint only reflects the current year).
const nflRecordStore = new Map();
function nflParseNext(team, myId) {
  const comp = (team?.nextEvent || [])[0]?.competitions?.[0];
  if (!comp || !Array.isArray(comp.competitors)) return null;
  const mine = comp.competitors.find((c) => String(c.team?.id || c.id) === String(myId));
  const opp = comp.competitors.find((c) => c !== mine);
  if (!opp) return null;
  return {
    opp: opp.team?.abbreviation || opp.team?.shortDisplayName || opp.team?.displayName || "",
    homeAway: mine?.homeAway === "away" ? "@" : "vs",
    date: comp.date || (team.nextEvent[0] && team.nextEvent[0].date) || null,
    pre: Number(team.nextEvent[0]?.seasonType?.type) === 1, // preseason
  };
}
function nflRecord(teamId) {
  return cached(nflRecordStore, teamId, 6 * 3600e3, async () => {
    try {
      const d = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${teamId}`);
      return { record: d.team?.record?.items?.[0]?.summary || null, next: nflParseNext(d.team, teamId) };
    } catch { return { record: null, next: null }; }
  }).catch(() => ({ record: null, next: null }));
}

// Dispatch by season
async function buildTeamData(teamId, year) {
  const team = TEAM_BY_ID.get(String(teamId));
  if (!team) throw new Error(`Unknown team id: ${teamId}`);
  const cur = currentNflSeason();
  let src, ctxP = null;
  if (year >= cur) {
    // Current-season W-L record + next game don't depend on the depth build, so kick the
    // fetch off NOW and let it run behind espnSource's own multi-round-trip work instead
    // of a serial round trip at the tail. (.catch keeps it abandonable if the build throws.)
    ctxP = nflRecord(teamId).catch(() => ({ record: null, next: null }));
    src = await espnSource(team, teamId);
  }
  else if (year >= SEASON.NEW_FORMAT_FROM) src = await newFormatSource(team, year);
  else if (year >= SEASON.OLDEST) src = await oldFormatSource(team, year);
  else throw new Error(`Historical depth charts for ${year} aren't available.`);
  const env = makeEnvelope(team, src.usedYear, src.entries);
  if (src.usedYear >= cur && ctxP) { const ctx = await ctxP; env.record = ctx.record; env.next = ctx.next; }
  return env;
}

const teamStore = new Map();
async function getTeamData(teamId, year, fresh) {
  const key = `nfl:${teamId}:${year}`; // in-memory key keeps the year (distinguishes seasons)
  // Disk/seed key for the CURRENT season is year-less, so the committed seed keeps
  // matching after the season rolls over (currentNflSeason() advances every fall) —
  // otherwise the flagship page's cold-start fallback would silently go dark in ~March.
  const diskK = year >= currentNflSeason() ? `nfl:${teamId}` : `nfl:${teamId}:${year}`;
  const existing = teamStore.get(key);
  // Keep boot-primed seeds/last-good (inserted with time:0) so fresh=1 serves them via
  // stale-while-revalidate instead of deleting them and blocking on a cold rebuild —
  // otherwise the flagship page's cold-start priming never actually reaches the client
  // (which always sends fresh=1). A normal warm entry (real timestamp) still rebuilds.
  if (fresh) { if (existing && "value" in existing && existing.time !== 0 && Date.now() - existing.time > 60000) teamStore.delete(key); }
  else if (existing && "value" in existing) stats.cacheHits++;
  try {
    return await cached(teamStore, key, DEPTH_TTL, async () => { const data = await buildTeamData(teamId, year); writeDisk(diskK, data); return data; }, 400);
  } catch (err) {
    const hit = readDisk(diskK);
    if (hit) { console.error(`serving ${hit.source} for ${diskK}: ${err.message}`); return { ...hit.data, stale: true, source: hit.source }; }
    throw err;
  }
}

// Boot-time cache primer: load the committed seed / last-good for a team into the
// in-memory store as a {time:0} entry so the VERY FIRST request after a cold start
// serves instantly (cached() treats time:0 as stale-but-usable → serves now, rebuilds
// in the background) instead of blocking on the multi-second ESPN roster+schedule
// fetch. Byte-identical to the ESPN-failure fallback the client already renders (stale
// banner + source). No-op if a live entry already exists or no seed is on disk.
function primeTeamData(teamId, year) {
  const key = `nfl:${teamId}:${year}`;
  if (teamStore.has(key)) return false;
  const diskK = year >= currentNflSeason() ? `nfl:${teamId}` : `nfl:${teamId}:${year}`;
  const hit = readDisk(diskK);
  if (!hit) return false;
  teamStore.set(key, { time: 0, value: { ...hit.data, stale: true, source: hit.source } });
  return true;
}

module.exports = {
  getTeamData, primeTeamData, getAthlete, ageFromDob,
  NFL_TEAMS, SEASON, currentNflSeason,
  TEAM_BY_ID,
};
