// server.js
// ---------------------------------------------------------------------------
// A tiny web server with NO external libraries (no `npm install` needed).
// Node 24 has everything built in, including `fetch` for calling other APIs.
//
// It does two jobs:
//   1. Serve the web page (the files in ./public) to your browser.
//   2. Provide a data endpoint  GET /api/depth?team=<id>  that talks to ESPN,
//      cleans up the messy data, and hands back tidy JSON the page can draw.
//
// Run it with:   node server.js
// Then open:     http://localhost:3000
// ---------------------------------------------------------------------------

const http = require("http");          // built-in web server
const fs = require("fs");              // built-in file reading (for the page files)
const path = require("path");          // built-in help with file paths
const { NFL_TEAMS } = require("./teams.js");

// Hosting platforms (Render, etc.) tell us which port to use via an env var.
// Locally it falls back to 3000.
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

// The current NFL season, and how far back the season dropdowns can go.
const CURRENT_YEAR = new Date().getFullYear();
const OLDEST_YEAR = 2020;

// A quick lookup: team id -> team info, so we can print names in the response.
const TEAM_BY_ID = new Map(NFL_TEAMS.map((t) => [String(t.id), t]));

// ---------------------------------------------------------------------------
// SIMPLE CACHE — this is what controls how often the app re-checks for updates.
// A team's depth chart AND its injuries both come from the same fetch, so one
// window covers both. Default: refresh at most once a DAY (override with the
// DEPTH_TTL_HOURS env var). After the window passes, the next visitor triggers
// a fresh pull; the Refresh button always forces one immediately.
// ---------------------------------------------------------------------------
const CACHE_MS = (Number(process.env.DEPTH_TTL_HOURS) || 24) * 60 * 60 * 1000;
const cache = new Map();         // teamId -> { time, data }

// ---------------------------------------------------------------------------
// ESPN ENDPOINTS
// ---------------------------------------------------------------------------
function depthChartUrl(year, teamId) {
  return `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${year}/teams/${teamId}/depthcharts`;
}
function rosterUrl(teamId) {
  return `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${teamId}/roster`;
}

// Small helper: fetch a URL and parse it as JSON, with a clear error if it fails.
async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "nfl-depth-chart-app" } });
  if (!res.ok) {
    throw new Error(`Request failed (${res.status}) for ${url}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// STEP 1: Build a lookup of every player on the roster.
// One roster call gives us name, jersey number, and injury info for everyone,
// keyed by the player's ESPN athlete id.
// ---------------------------------------------------------------------------
function buildRosterMap(roster, maddenMap) {
  const map = new Map();
  const groups = roster.athletes || []; // roster is grouped (offense/defense/st)
  for (const group of groups) {
    for (const a of group.items || []) {
      const injuries = a.injuries || [];
      // The most recent injury's status text, e.g. "Questionable" / "Out".
      const injuryStatus = injuries.length ? injuries[0].status : null;
      const name = a.fullName || a.displayName || "Unknown";
      map.set(String(a.id), {
        name,
        jersey: a.jersey || "",
        position: a.position ? a.position.abbreviation : "",
        injury: injuryStatus,                       // null if healthy
        rosterStatus: a.status ? a.status.name : "", // e.g. "Active", "Injured Reserve"
        // Madden overall rating (our free stand-in for a PFF grade), matched by name.
        overall: maddenMap ? maddenMap.get(normName(name)) ?? null : null,
      });
    }
  }
  return map;
}

// Pull the numeric athlete id out of a "$ref" URL like
//   http://.../athletes/4684527?lang=en&region=us   ->  "4684527"
function athleteIdFromRef(ref) {
  const match = /athletes\/(\d+)/.exec(ref || "");
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// STEP 2: Turn one ESPN depth-chart group (offense OR defense) into tidy data.
//
// ESPN encodes lineups with two numbers per player:
//   slot = which on-field spot (e.g. WR has slots 1, 2, 8 = three receivers)
//   rank = the order within that spot (rank 1 = starter, then the depth behind)
//
// So for each position we group players by `slot`, sort each slot by `rank`,
// and the result is: one entry per on-field spot, each with its starter first
// and the backups after. That's exactly the click-to-expand behavior.
// ---------------------------------------------------------------------------
function tidyGroup(group, knownById, season) {
  const positions = {};

  for (const [posKey, posData] of Object.entries(group.positions || {})) {
    const posInfo = posData.position || {};
    const bySlot = new Map(); // slot number -> array of players

    for (const entry of posData.athletes || []) {
      const id = athleteIdFromRef(entry.athlete && entry.athlete.$ref);
      const known = (id && knownById.get(id)) || {};
      const player = {
        rank: entry.rank,
        id: id || null, // ESPN athlete id, used to look up age on demand
        season,         // which NFL season this lineup is from (for age-as-of-that-year)
        name: known.name || "—",
        jersey: known.jersey || "",
        injury: known.injury || null,
        rosterStatus: known.rosterStatus || "",
        overall: known.overall ?? null, // Madden overall rating (or null if unrated)
      };
      const slot = entry.slot;
      if (!bySlot.has(slot)) bySlot.set(slot, []);
      bySlot.get(slot).push(player);
    }

    // Sort each slot's players by rank (starter first) and drop empty "—" fillers
    // that have no real name so the depth list stays meaningful.
    const spots = [];
    for (const [slot, players] of bySlot) {
      players.sort((a, b) => a.rank - b.rank);
      const real = players.filter((p) => p.name && p.name !== "—");
      if (real.length) spots.push({ slot, players: real });
    }
    spots.sort((a, b) => a.slot - b.slot);

    positions[posKey] = {
      abbr: posInfo.abbreviation || posKey.toUpperCase(),
      name: posInfo.displayName || posKey,
      spots, // one item per on-field spot; each spot: { slot, players: [starter, ...depth] }
    };
  }

  return { formation: group.name, positions };
}

// ---------------------------------------------------------------------------
// STEP 3: Build the payload for a team + season. The CURRENT season comes from
// ESPN (live, with injuries + Madden ratings). PAST seasons (2020-2024) come
// from nflverse's real historical depth charts. 2025 is a gap (nflverse changed
// its data format that year, and ESPN's "2025" is just the current roster).
// ---------------------------------------------------------------------------
const OLDEST_NFLVERSE_YEAR = 2020;
const NEWEST_NFLVERSE_YEAR = 2024;

async function buildTeamData(teamId, requestedYear) {
  const team = TEAM_BY_ID.get(String(teamId));
  if (!team) throw new Error(`Unknown team id: ${teamId}`);
  const year = requestedYear || CURRENT_YEAR;

  if (year >= CURRENT_YEAR) return buildEspnData(team, teamId);
  if (year === 2025) return buildNewFormatSeason(team, year); // nflverse's newer format
  if (year >= OLDEST_NFLVERSE_YEAR && year <= NEWEST_NFLVERSE_YEAR) {
    return buildPastSeasonData(team, year);
  }
  throw new Error(`Historical depth charts for ${year} aren't available.`);
}

// --- CURRENT season, live from ESPN ---------------------------------------
async function buildEspnData(team, teamId) {
  let depth = await getJson(depthChartUrl(CURRENT_YEAR, teamId));
  let usedYear = CURRENT_YEAR;
  if (!depth || !(depth.items || []).length) {
    depth = await getJson(depthChartUrl(CURRENT_YEAR - 1, teamId)); // early-offseason fallback
    usedYear = CURRENT_YEAR - 1;
  }
  if (!depth || !(depth.items || []).length) {
    throw new Error(`No depth chart available for ${team.name}.`);
  }
  const items = depth.items;
  const [roster, maddenMap] = await Promise.all([getJson(rosterUrl(teamId)), getMaddenMap()]);
  const knownById = buildRosterMap(roster, maddenMap);

  const offenseGroup = items.find((g) => !/\bD\b/.test(g.name) && !/Special/i.test(g.name));
  const defenseGroup = items.find((g) => /\bD\b/.test(g.name));
  return {
    team: team.name,
    teamAbbr: team.abbr,
    season: usedYear,
    fetchedAt: new Date().toISOString(),
    offense: offenseGroup ? tidyGroup(offenseGroup, knownById, usedYear) : null,
    defense: defenseGroup ? tidyGroup(defenseGroup, knownById, usedYear) : null,
  };
}

// --- PAST seasons, from nflverse historical depth charts -------------------
// nflverse club codes match our abbreviations except these two.
const NFLVERSE_CLUB = { LAR: "LA", WSH: "WAS" };
const nflverseCache = new Map(); // year -> parsed rows
let playersMeta = null;          // gsis_id -> { dob, espn_id }

async function getNflverseSeason(year) {
  if (nflverseCache.has(year)) return nflverseCache.get(year);
  const url = `https://github.com/nflverse/nflverse-data/releases/download/depth_charts/depth_charts_${year}.csv`;
  const res = await fetch(url, { headers: { "User-Agent": "nfl-depth-chart-app" } });
  if (!res.ok) throw new Error(`nflverse depth chart for ${year} unavailable (${res.status})`);
  const rows = parseCsv(await res.text());
  nflverseCache.set(year, rows);
  return rows;
}

// Player birthdays + ESPN ids (for age + headshots), keyed by nflverse gsis_id.
async function getPlayersMeta() {
  if (playersMeta) return playersMeta;
  const map = new Map();
  try {
    const url = "https://github.com/nflverse/nflverse-data/releases/download/players/players.csv";
    const res = await fetch(url, { headers: { "User-Agent": "nfl-depth-chart-app" } });
    for (const r of parseCsv(await res.text())) {
      if (r.gsis_id) {
        map.set(r.gsis_id, {
          dob: r.birth_date || null,
          espn_id: r.espn_id || null,
          jersey: r.jersey_number || "",
        });
      }
    }
  } catch (err) {
    console.error("nflverse players.csv unavailable:", err.message);
  }
  playersMeta = map;
  return map;
}

async function buildPastSeasonData(team, year) {
  const club = NFLVERSE_CLUB[team.abbr] || team.abbr;
  const [rows, meta, madden] = await Promise.all([
    getNflverseSeason(year), getPlayersMeta(), getSeasonMadden(year),
  ]);
  const teamRows = rows.filter((r) => r.club_code === club && r.game_type === "REG");
  if (!teamRows.length) throw new Error(`No ${year} depth chart for ${team.name}.`);

  // Use the earliest regular-season week we have (the opening-day lineup).
  const week = Math.min(...teamRows.map((r) => Number(r.week)).filter((n) => n > 0));
  const wk = teamRows.filter((r) => Number(r.week) === week);
  const nick = team.name.split(" ").pop();

  const mkPlayer = (r, rank) => {
    const m = meta.get(r.gsis_id) || {};
    const name = r.full_name || `${r.first_name} ${r.last_name}`.trim() || "—";
    return {
      rank,
      id: m.espn_id || null,
      season: year,
      name,
      jersey: r.jersey_number || m.jersey || "",
      injury: null, // injuries have no historical version
      overall: ovrFromMadden(madden, name, nick), // that season's Madden rating
      age: ageFromDob(m.dob, year),                // that season's age
    };
  };

  return {
    team: team.name,
    teamAbbr: team.abbr,
    season: year,
    fetchedAt: new Date().toISOString(),
    offense: buildPastOffense(wk.filter((r) => r.formation === "Offense"), mkPlayer),
    defense: buildPastDefense(wk.filter((r) => r.formation === "Defense"), mkPlayer),
  };
}

// --- Historical Madden ratings ---------------------------------------------
// Each NFL season maps to a Madden game (season Y -> "Madden Y-1999"). The 2025
// season uses the current Madden game (EA's live API). 2021-2023 come from EA's
// older per-game endpoints. 2020 (M21) and 2024 (M25) aren't served, so those
// seasons show no rating.
const seasonMaddenCache = new Map(); // year -> Map(key -> overall)

async function getSeasonMadden(year) {
  if (seasonMaddenCache.has(year)) return seasonMaddenCache.get(year);
  const map = new Map();
  try {
    if (year >= 2025) {
      // Current Madden game (Madden 26) is the 2025-season game.
      for (const [k, v] of await getMaddenMap()) map.set(k, v);
    } else if (year >= 2021 && year <= 2023) {
      const m = year - 1999; // 2021->22, 2022->23, 2023->24
      for (const offset of [0, 1000]) {
        const res = await fetch(
          `https://ratings-api.ea.com/v2/entities/m${m}-ratings?limit=1000&offset=${offset}`,
          { headers: { "User-Agent": "Mozilla/5.0" } }
        );
        if (!res.ok) break;
        const docs = (await res.json()).docs || [];
        for (const d of docs) {
          const name = normName(d.fullNameForSearch || `${d.firstName} ${d.lastName}`);
          const nick = (d.team || "").toLowerCase();
          if (name && typeof d.overall_rating === "number") {
            map.set(`${name}|${nick}`, d.overall_rating);      // name + team (avoids name clashes)
            if (!map.has(name)) map.set(name, d.overall_rating); // fallback: name only
          }
        }
        if (docs.length < 1000) break;
      }
    }
  } catch (err) {
    console.error(`Madden ratings for ${year} unavailable:`, err.message);
  }
  seasonMaddenCache.set(year, map);
  return map;
}

function ovrFromMadden(map, name, nick) {
  const n = normName(name);
  const byTeam = map.get(`${n}|${(nick || "").toLowerCase()}`);
  return byTeam ?? map.get(n) ?? null;
}

// --- 2025 season (nflverse's newer, ESPN-shaped format) --------------------
// This format mirrors ESPN's own structure (pos_grp / pos_abb / pos_slot /
// pos_rank), so it maps almost 1:1 onto our layout. The file is large and holds
// many dated snapshots, so we keep only the snapshot nearest the season opener.
const newFormatCache = new Map(); // year -> rows at the chosen snapshot

async function getNewFormatSeason(year) {
  if (newFormatCache.has(year)) return newFormatCache.get(year);
  const url = `https://github.com/nflverse/nflverse-data/releases/download/depth_charts/depth_charts_${year}.csv`;
  const res = await fetch(url, { headers: { "User-Agent": "nfl-depth-chart-app" } });
  if (!res.ok) throw new Error(`nflverse ${year} unavailable (${res.status})`);
  const text = await res.text();
  const lines = text.split("\n");
  const header = lines[0].split(",");
  const col = (name) => header.indexOf(name);
  const iDt = col("dt");

  // Pick the earliest snapshot on/after the season opener (~Sept).
  let target = null;
  const opener = `${year}-09-04`;
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].indexOf(",");
    if (c < 0) continue;
    const dt = lines[i].slice(0, c);
    if (dt >= opener && (target === null || dt < target)) target = dt;
  }
  if (!target) throw new Error(`No ${year} in-season snapshot found.`);

  const iTeam = col("team"), iName = col("player_name"), iEspn = col("espn_id"),
    iGsis = col("gsis_id"), iGrp = col("pos_grp"), iAbb = col("pos_abb"),
    iSlot = col("pos_slot"), iRank = col("pos_rank");
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].startsWith(target + ",")) continue; // dt is the first column
    const c = lines[i].split(",");
    rows.push({
      team: c[iTeam], player_name: c[iName], espn_id: c[iEspn], gsis_id: c[iGsis],
      pos_grp: c[iGrp], pos_abb: c[iAbb], pos_slot: c[iSlot], pos_rank: c[iRank],
    });
  }
  newFormatCache.set(year, rows);
  return rows;
}

async function buildNewFormatSeason(team, year) {
  const club = NFLVERSE_CLUB[team.abbr] || team.abbr;
  const [rows, meta, madden] = await Promise.all([
    getNewFormatSeason(year), getPlayersMeta(), getSeasonMadden(year),
  ]);
  const teamRows = rows.filter((r) => r.team === club || r.team === team.abbr);
  if (!teamRows.length) throw new Error(`No ${year} depth chart for ${team.name}.`);
  const nick = team.name.split(" ").pop();

  const mk = (r) => {
    const m = meta.get(r.gsis_id) || {};
    return {
      rank: Number(r.pos_rank) || 1,
      id: r.espn_id || m.espn_id || null,
      season: year,
      name: r.player_name || "—",
      jersey: m.jersey || "",
      injury: null,
      overall: ovrFromMadden(madden, r.player_name, nick),
      age: ageFromDob(m.dob, year),
    };
  };

  const isDef = (r) => /\bD\b/.test(r.pos_grp);
  const isSt = (r) => /Special/i.test(r.pos_grp);
  return {
    team: team.name,
    teamAbbr: team.abbr,
    season: year,
    fetchedAt: new Date().toISOString(),
    offense: buildNewFormatOffense(teamRows.filter((r) => !isDef(r) && !isSt(r)), mk),
    defense: buildNewFormatDefense(teamRows.filter(isDef), mk),
  };
}

// Offense: key by position abbreviation, with one spot per slot (so WR's three
// slots become three on-field receivers) — exactly like the ESPN path.
function buildNewFormatOffense(rows, mk) {
  if (!rows.length) return null;
  const positions = {};
  for (const [abb, group] of groupBy(rows, (r) => r.pos_abb)) {
    const key = abb.toLowerCase();
    const bySlot = new Map();
    for (const r of group) {
      if (!bySlot.has(r.pos_slot)) bySlot.set(r.pos_slot, []);
      bySlot.get(r.pos_slot).push(r);
    }
    const spots = [];
    for (const [slot, rs] of bySlot) {
      rs.sort((a, b) => Number(a.pos_rank) - Number(b.pos_rank));
      spots.push({ slot: Number(slot), players: rs.map(mk) });
    }
    spots.sort((a, b) => a.slot - b.slot);
    positions[key] = { abbr: abb, spots };
  }
  return { formation: "Offense", positions };
}

// Defense: one on-field spot per slot, tagged with its bucket (DL/LB/CB/S/NB).
function buildNewFormatDefense(rows, mk) {
  if (!rows.length) return null;
  const positions = {};
  for (const [slot, group] of groupBy(rows, (r) => r.pos_slot)) {
    group.sort((a, b) => Number(a.pos_rank) - Number(b.pos_rank));
    const abbr = group[0].pos_abb;
    const cat = defenseCat(abbr);
    if (!cat) continue;
    positions[`d${slot}`] = { abbr, cat, spots: [{ slot: 1, players: group.map(mk) }] };
  }
  return { formation: "Defense", positions };
}

// Split a position's rows (sorted by depth) into one "spot" per starter, so a
// group like WR (three 1st-stringers) becomes three on-field spots.
function splitIntoSpots(rows, mkPlayer) {
  rows.sort((a, b) => Number(a.depth_team) - Number(b.depth_team));
  const starterDepth = rows.length ? Number(rows[0].depth_team) : 1;
  const cols = Math.max(1, rows.filter((r) => Number(r.depth_team) === starterDepth).length);
  const spots = Array.from({ length: cols }, (_, i) => ({ slot: i + 1, players: [] }));
  rows.forEach((r, i) => spots[i % cols].players.push(mkPlayer(r, i + 1)));
  return spots.filter((s) => s.players.length);
}

function groupBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

// nflverse offense position code -> our field key.
function offenseKey(code) {
  const c = (code || "").trim().toUpperCase();
  if (c === "QB") return "qb";
  if (c === "RB" || c === "HB") return "rb";
  if (c === "FB") return "fb";
  if (c === "TE") return "te";
  if (c.startsWith("WR")) return "wr";
  if (c === "LT" || c === "LOT") return "lt";
  if (c === "LG") return "lg";
  if (c === "C") return "c";
  if (c === "RG") return "rg";
  if (c === "RT" || c === "ROT") return "rt";
  return null;
}

function buildPastOffense(rows, mkPlayer) {
  if (!rows.length) return null;
  const positions = {};
  for (const [key, group] of groupBy(rows, (r) => offenseKey(r.depth_position))) {
    positions[key] = { abbr: key.toUpperCase(), spots: splitIntoSpots(group, mkPlayer) };
  }
  return { formation: "Offense", positions };
}

// Which of our defensive buckets an nflverse code belongs to.
function defenseCat(code) {
  const c = (code || "").trim().toUpperCase();
  if (!c || c === "LS") return null;
  if (["NB", "NCB", "NKL", "N"].includes(c)) return "NB"; // before CB (NCB ends in "CB")
  if (["LCB", "RCB", "CB"].includes(c) || c.endsWith("CB")) return "CB";
  if (["FS", "SS", "S", "SAF", "RS"].includes(c)) return "S";
  if (c.endsWith("LB") || ["MIKE", "WILL", "SAM"].includes(c)) return "LB";
  if (c.endsWith("DE") || c.endsWith("DT") || c.endsWith("DL") ||
      ["NT", "DL", "EDGE", "RUSH", "LE", "RE", "DE", "DT"].includes(c)) return "DL";
  return null;
}

function buildPastDefense(rows, mkPlayer) {
  if (!rows.length) return null;
  const positions = {};
  let n = 0;
  for (const [code, group] of groupBy(rows, (r) => r.depth_position)) {
    const cat = defenseCat(code);
    if (!cat) continue;
    // One position entry per starter, so multi-starter codes (e.g. DT x2) split.
    splitIntoSpots(group, mkPlayer).forEach((spot) => {
      positions[`${code.toLowerCase()}_${n++}`] = {
        abbr: code.trim().toUpperCase(),
        cat, // tells the frontend how to bucket this (DL/LB/CB/S/NB)
        spots: [spot],
      };
    });
  }
  return { formation: "Defense", positions };
}

// Minimal CSV parser (handles quoted fields with commas/newlines).
function parseCsv(text) {
  const rows = [];
  let field = "", row = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift() || [];
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

// ---------------------------------------------------------------------------
// PLAYER LOOKUP
// Each athlete's own endpoint gives name, jersey, and birth date. We use it to
// (a) resolve names for PAST seasons and (b) compute age on demand. Cached
// forever within a run, since name/birthday don't change.
// ---------------------------------------------------------------------------
const athleteCache = new Map(); // athleteId -> { name, jersey, dob }

async function getAthlete(id) {
  if (!id) return { name: null, jersey: "", dob: null };
  if (athleteCache.has(id)) return athleteCache.get(id);
  let info = { name: null, jersey: "", dob: null };
  try {
    const d = await getJson(`https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/athletes/${id}`);
    info = { name: d.displayName || d.fullName || null, jersey: d.jersey || "", dob: d.dateOfBirth || null };
  } catch (_) {
    // leave blanks if ESPN doesn't have this athlete
  }
  athleteCache.set(id, info);
  return info;
}

// How old a player was as of the start (Sept 1) of a given NFL season.
function ageFromDob(dob, year) {
  if (!dob) return null;
  const born = new Date(dob);
  if (isNaN(born.getTime())) return null;
  const ref = new Date(Date.UTC(year, 8, 1)); // Sept 1 of that season
  let age = ref.getUTCFullYear() - born.getUTCFullYear();
  const m = ref.getUTCMonth() - born.getUTCMonth();
  if (m < 0 || (m === 0 && ref.getUTCDate() < born.getUTCDate())) age--;
  return age >= 0 && age < 70 ? age : null;
}

// ---------------------------------------------------------------------------
// MADDEN RATINGS (free stand-in for a PFF grade)
// PFF grades are proprietary/paid, so we use EA's public Madden ratings API as
// an all-position, free alternative. We fetch every player once (20 pages of
// 100), build a name -> overall-rating map, and cache it for a day.
// ---------------------------------------------------------------------------
let maddenMap = null;
let maddenMapTime = 0;
// Madden ratings change slowly, so refresh at most once a MONTH by default
// (override with the MADDEN_TTL_DAYS env var).
const MADDEN_TTL = (Number(process.env.MADDEN_TTL_DAYS) || 30) * 24 * 60 * 60 * 1000;

// Normalize a name so ESPN and Madden spellings line up (drop punctuation and
// Jr./Sr./III suffixes, lower-case).
function normName(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[.,'’]/g, "")
    .replace(/\s+(jr|sr|iii|ii|iv|v)$/, "")
    .trim();
}

async function getMaddenMap() {
  if (maddenMap && Date.now() - maddenMapTime < MADDEN_TTL) return maddenMap;
  const map = new Map();
  const page = async (offset) => {
    const url = `https://drop-api.ea.com/rating/madden-nfl?locale=en&limit=100&offset=${offset}`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`Madden API ${res.status}`);
    return res.json();
  };
  try {
    const first = await page(0);
    const add = (items) => {
      for (const it of items || []) {
        const key = normName(`${it.firstName} ${it.lastName}`);
        if (key && !map.has(key)) map.set(key, it.overallRating);
      }
    };
    add(first.items);
    const offsets = [];
    for (let o = 100; o < (first.totalItems || 0); o += 100) offsets.push(o);
    const pages = await Promise.all(offsets.map((o) => page(o).catch(() => ({ items: [] }))));
    pages.forEach((p) => add(p.items));
  } catch (err) {
    console.error("Madden ratings unavailable:", err.message); // app still works, grades just blank
  }
  maddenMap = map;
  maddenMapTime = Date.now();
  return map;
}

async function getPlayerInfo(id) {
  if (playerCache.has(id)) return playerCache.get(id);
  const url = `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/athletes/${id}`;
  let info = { age: null };
  try {
    const d = await getJson(url);
    info = { age: typeof d.age === "number" ? d.age : null };
  } catch (_) {
    // leave age null if ESPN doesn't have it
  }
  playerCache.set(id, info);
  return info;
}

// Use the cache if it's fresh, otherwise fetch and store.
// Passing forceFresh=true (the Refresh button) skips the cache entirely.
async function getTeamData(teamId, year, forceFresh) {
  const key = `${teamId}:${year}`;
  const hit = cache.get(key);
  if (!forceFresh && hit && Date.now() - hit.time < CACHE_MS) return hit.data;
  const data = await buildTeamData(teamId, year);
  cache.set(key, { time: Date.now(), data });
  return data;
}

// ---------------------------------------------------------------------------
// STATIC FILE SERVING (the web page itself)
// ---------------------------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function serveStatic(req, res) {
  // "/" means "give me the home page".
  let urlPath = req.url.split("?")[0];
  if (urlPath === "/") urlPath = "/index.html";

  // teams.js lives one level up (shared with the server) — let the page load it.
  const filePath =
    urlPath === "/teams.js"
      ? path.join(__dirname, "teams.js")
      : path.join(PUBLIC_DIR, urlPath);

  // Safety: never serve files outside our project folders.
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// THE SERVER
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  // The data endpoint the page calls.
  if (req.url.startsWith("/api/depth")) {
    const params = new URL(req.url, `http://localhost:${PORT}`).searchParams;
    const teamId = params.get("team") || "2"; // default Buffalo
    let year = Number(params.get("year")) || CURRENT_YEAR;
    year = Math.min(CURRENT_YEAR, Math.max(OLDEST_YEAR, year)); // keep in range
    const forceFresh = params.get("fresh") === "1";
    try {
      const data = await getTeamData(teamId, year, forceFresh);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error("Error building team data:", err.message);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Look up a single player's age (called when a depth-chart popover opens).
  if (req.url.startsWith("/api/player")) {
    const params = new URL(req.url, `http://localhost:${PORT}`).searchParams;
    const id = params.get("id");
    const year = Number(params.get("year")) || CURRENT_YEAR;
    res.writeHead(200, { "Content-Type": "application/json" });
    try {
      const info = await getAthlete(id);
      res.end(JSON.stringify({ age: ageFromDob(info.dob, year) }));
    } catch (err) {
      res.end(JSON.stringify({ age: null }));
    }
    return;
  }

  // Everything else = a page file.
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`\n🏈  NFL Depth Chart running!  Open  http://localhost:${PORT}\n`);
});
