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
      // Don't retry a timeout (AbortError) — it just multiplies the wait; retry
      // only transient 5xx/network. This caps a hung host at one `timeout`.
      if (err.noRetry || err.name === "AbortError" || attempt >= retries) break;
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

// Last-good copy on disk (os.tmpdir) so a downed upstream still serves something.
// Render's tmp is EPHEMERAL — wiped on every deploy/spin-down — so we ALSO fall
// back to a committed seed in data/seed/, which survives cold starts. Seeds are a
// static baseline (refresh with `npm run gen-seeds`); tmp holds the fresher copy.
const safeKey = (key) => key.replace(/[^\w.-]/g, "_") + ".json";
const DISK_DIR = path.join(os.tmpdir(), "sports-depth-cache");
const SEED_DIR = path.join(__dirname, "..", "data", "seed");
function diskPath(key) { return path.join(DISK_DIR, safeKey(key)); }
function writeDisk(key, data) { try { fs.mkdirSync(DISK_DIR, { recursive: true }); fs.writeFileSync(diskPath(key), JSON.stringify(data)); } catch {} }
function readDisk(key) {
  try { return JSON.parse(fs.readFileSync(diskPath(key), "utf8")); } catch {}
  try { return JSON.parse(fs.readFileSync(path.join(SEED_DIR, safeKey(key)), "utf8")); } catch { return null; }
}

// ---------------------------------------------------------------------------
// ESPN endpoint builders
// ---------------------------------------------------------------------------
const ratings = require("./ratings.js");
const draft = require("./draft.js");
const core = "https://sports.core.api.espn.com/v2/sports";
const site = "https://site.api.espn.com/apis/site/v2/sports";
const depthUrl = (s, l, year, id) => `${core}/${s}/leagues/${l}/seasons/${year}/teams/${id}/depthcharts`;
const rosterUrl = (s, l, id) => `${site}/${s}/${l}/teams/${id}/roster`;
const scheduleUrl = (s, l, id, season) => `${site}/${s}/${l}/teams/${id}/schedule${season ? `?season=${season}` : ""}`;
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
// Historical variant: when a depth-chart player isn't on the CURRENT roster (a
// past season), resolve their bio by fetching the athlete $ref (cached). Bounded
// to the top few per position so a past-season lineup can't fan out to hundreds
// of fetches.
const histAthleteStore = new Map();
function resolveAthleteRef(ref, cfg) {
  return cached(histAthleteStore, ref, 30 * 86400e3, async () => {
    const a = await fetchJson(ref, { timeout: 6000, retries: 1 });
    const { extra, pos } = cfg.bio ? cfg.bio(a) : { extra: "", pos: a.position?.abbreviation || "" };
    return {
      id: String(a.id), name: a.displayName || a.fullName || "—", jersey: a.jersey || "",
      injury: null, age: typeof a.age === "number" ? a.age : null,
      height: a.displayHeight || "", weight: a.displayWeight || "", exp: null,
      extra: extra || "", pos: pos || (a.position?.abbreviation || ""),
    };
  }).catch(() => null);
}
async function rankedPlayersResolved(posBucket, rosterMap, cfg, cap = 6) {
  const out = [];
  const list = (posBucket?.athletes || []).slice().sort((x, y) => (x.rank || 99) - (y.rank || 99)).slice(0, cap);
  for (const a of list) {
    const ref = a.athlete && a.athlete.$ref, id = idFromRef(ref);
    let bio = id && rosterMap.get(id);
    if (!bio && ref) bio = await resolveAthleteRef(ref, cfg); // past-season player: fetch their bio
    if (!bio) continue;
    out.push({ rank: a.rank || out.length + 1, ...bio });
  }
  return out;
}

// ---------------------------------------------------------------------------
// BUILDER A: "depth" sports (NHL, NBA) — ESPN's ranked depth chart per position.
// ---------------------------------------------------------------------------
async function resolveDepthLineup(cfg, team, season) {
  const { sport, league } = cfg.espn;
  // ESPN labels some leagues by the season's END year (NBA: label 2027 = the
  // 2026-27 season), and keeps completed seasons populated forever. So for those,
  // roll the label over in the fall (like the NFL helper) — otherwise Oct–Dec we'd
  // serve LAST season's chart. MLB is single-calendar-year, so it uses nowY as-is.
  const now = new Date();
  const cur = cfg.seasonEndYear
    ? (now.getUTCMonth() >= 8 ? now.getUTCFullYear() + 1 : now.getUTCFullYear())
    : now.getUTCFullYear();
  // A specific past season is used as-is; "current" probes this + last year.
  const years = season ? [season] : [cur, cur - 1];
  const historical = !!season;
  let depth = null, usedYear = null;
  for (const year of years) {
    try {
      const d = await fetchJson(depthUrl(sport, league, year, team.id));
      if (d && (d.items || []).length && d.items[0].positions && Object.keys(d.items[0].positions).length) { depth = d; usedYear = year; break; }
    } catch {}
  }
  if (!depth) throw new Error(`No depth chart available for ${team.name}.`);
  const positions = depth.items[0].positions || {};
  const rosterMap = buildRosterMap(await fetchJson(rosterUrl(sport, league, team.id)), cfg);

  const chips = [];
  for (const spec of cfg.layout) {
    const bucket = positions[spec.posKey];
    // Historical: resolve past-season players not on the current roster via their refs.
    const players = historical ? await rankedPlayersResolved(bucket, rosterMap, cfg) : rankedPlayers(bucket, rosterMap);
    if (!players.length) continue;
    const faceIdx = Math.min((spec.faceRank || 1) - 1, players.length - 1);
    chips.push({
      key: spec.key, label: spec.label, group: spec.group, x: spec.x, y: spec.y,
      face: players[faceIdx],
      players, // full ranked depth for the popover
    });
  }
  const label = historical ? `${cfg.seasonEndYear ? seasonLabel(usedYear) : usedYear} depth chart` : "Starting Lineup";
  return { formation: null, subtitle: label, chips };
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
  // Spread each line nearly the full width, and space the lines from the GK
  // (own goal) to the attack across most of the half, so the 11 names don't
  // overlap and the formation reads clearly.
  const xspan = (n) => (n >= 5 ? [6, 94] : n === 4 ? [8, 92] : n === 3 ? [18, 82] : n === 2 ? [32, 68] : [50, 50]);
  const outfield = [...new Set(entries.map((e) => e.band))].filter((b) => b !== 0).sort((a, b) => a - b);
  const yFor = (band) => {
    if (band === 0) return 8; // GK — kept clear of the team name band
    const k = outfield.indexOf(band), B = outfield.length;
    return B <= 1 ? 30 : 16 + (50 - 16) * (k / (B - 1)); // back line ≈16 → front line ≈50
  };
  const byBand = {};
  entries.forEach((e) => (byBand[e.band] = byBand[e.band] || []).push(e));
  for (const arr of Object.values(byBand)) {
    arr.sort((a, b) => (a.xhint ?? a.side) - (b.xhint ?? b.side) || a.fp - b.fp);
    const [lo, hi] = xspan(arr.length), n = arr.length;
    // Nudge alternate players in a crowded line vertically so long names clear each other.
    arr.forEach((e, i) => {
      e.x = n === 1 ? 50 : lo + (hi - lo) * (i / (n - 1));
      const stagger = n >= 4 ? (i % 2 === 1 ? 3.2 : 0) : 0;
      e.y = yFor(e.band) + stagger;
    });
  }
  return entries;
}

async function resolveMatchLineup(cfg, team, season) {
  const { sport, league } = cfg.espn;
  const historical = !!season;
  const rosterJson = await fetchJson(rosterUrl(sport, league, team.id));
  const rosterMap = buildRosterMap(rosterJson, cfg);
  // Depth-by-line from the full roster (used for the popover behind each spot).
  const byGroup = { Goalkeeper: [], Defense: [], Midfield: [], Forward: [] };
  for (const a of flatAthletes(rosterJson)) {
    const g = soccerGroup(a.position?.abbreviation, a.position?.parent?.name || a.position?.name);
    const bio = rosterMap.get(String(a.id));
    if (bio) byGroup[g].push({ rank: byGroup[g].length + 1, ...bio });
  }

  // Build a TYPICAL first-choice XI from the last several completed league
  // matches. A single match is unreliable — one rotated/rest game (a striker
  // benched, a cup rotation) makes the whole chart look wrong. Instead we rank
  // players by how often they've started recently, fill the team's most common
  // formation line-by-line, and place them by position. ESPN's schedule isn't
  // date-sorted, so we sort by date and take the genuinely latest games.
  let chips = [], formation = null, when = null, nMatches = 0;
  try {
    const sched = await fetchJson(scheduleUrl(sport, league, team.id, season));
    const done = (sched.events || []).filter((e) => e.competitions?.[0]?.status?.type?.completed)
      .sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 8);
    if (done.length) {
      when = done[0].date || null;
      // Pull each match's box in parallel; any that fail are simply skipped.
      const sums = await Promise.all(done.map((e) => fetchJson(summaryUrl(sport, league, e.id)).catch(() => null)));
      const agg = new Map(); // athlete id -> { starts, lastIdx (0 = most recent), posCounts, fp, name }
      const formCount = {};
      sums.forEach((sum, idx) => {
        const mine = (sum?.rosters || []).find((r) => String(r.team?.id) === String(team.id));
        const starters = (mine?.roster || []).filter((x) => x.starter);
        if (!starters.length) return;
        nMatches++;
        if (mine.formation) formCount[mine.formation] = (formCount[mine.formation] || 0) + 1;
        for (const s of starters) {
          const id = String(s.athlete?.id || idFromRef(s.athlete?.$ref) || "");
          if (!id) continue;
          const rec = agg.get(id) || { id, starts: 0, lastIdx: 99, posCounts: {}, fp: 99, name: s.athlete?.displayName || "" };
          rec.starts++;
          rec.lastIdx = Math.min(rec.lastIdx, idx);
          const pa = (s.position?.abbreviation || "").toUpperCase();
          if (pa) rec.posCounts[pa] = (rec.posCounts[pa] || 0) + 1;
          rec.fp = Math.min(rec.fp, Number(s.formationPlace) || 99);
          agg.set(id, rec);
        }
      });
      if (nMatches) {
        // Most common recent formation → line counts. First digit = defenders,
        // last = forwards, everything between collapses into midfield.
        formation = Object.entries(formCount).sort((a, b) => b[1] - a[1])[0]?.[0] || "4-3-3";
        const digits = (formation.match(/\d+/g) || ["4", "3", "3"]).map(Number);
        const defN = digits[0] || 4, fwdN = digits[digits.length - 1] || 3;
        let midN = 10 - defN - fwdN;
        if (midN < 0) midN = digits.slice(1, -1).reduce((s, d) => s + d, 0) || 3;
        // Classify each regular by the position they most often started in, and
        // score them by starts (recency breaks ties — smaller lastIdx wins). For
        // the CURRENT season, drop anyone no longer on the roster (transferred out,
        // e.g. Cuypers) so the XI reflects today's squad; a past season keeps that
        // season's players.
        const players = [...agg.values()]
          .filter((r) => historical || rosterMap.has(r.id))
          .map((r) => {
            const modePos = Object.entries(r.posCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
            const slot = soccerSlot(modePos);
            return { ...r, modePos, side: slot.side, xhint: slot.xhint, grp: soccerGroup(modePos), score: r.starts * 100 - r.lastIdx };
          });
        const byGrp = { Goalkeeper: [], Defense: [], Midfield: [], Forward: [] };
        for (const p of players) (byGrp[p.grp] || byGrp.Midfield).push(p);
        for (const k of Object.keys(byGrp)) byGrp[k].sort((a, b) => b.score - a.score);
        const chosen = [], have = new Set();
        const take = (grp, n) => { for (let i = 0; i < n && byGrp[grp][i]; i++) if (!have.has(byGrp[grp][i].id)) { chosen.push(byGrp[grp][i]); have.add(byGrp[grp][i].id); } };
        take("Goalkeeper", 1); take("Defense", defN); take("Midfield", midN); take("Forward", fwdN);
        // Backfill to 11 from the best remaining players (covers formation quirks
        // and thin position groups) so the pitch is always full.
        if (chosen.length < 11) {
          players.filter((p) => !have.has(p.id)).sort((a, b) => b.score - a.score)
            .slice(0, 11 - chosen.length).forEach((p) => { chosen.push(p); have.add(p.id); });
        }
        // Force each player's vertical line to the group we slotted them into
        // (match-to-match position labels are noisy), keeping their L/R hint.
        const bandForGrp = { Goalkeeper: 0, Defense: 1, Midfield: 3, Forward: 5 };
        const entries = chosen.map((p) => {
          const bio = rosterMap.get(p.id) || { id: p.id, name: p.name || "—", jersey: "", injury: null, age: null, height: "", weight: "", exp: null, extra: "", pos: p.modePos };
          return { bio, posAbbr: p.modePos, band: bandForGrp[p.grp] ?? 3, side: p.side, xhint: p.xhint, fp: p.fp, grp: p.grp };
        });
        placeStarters(entries);
        entries.sort((a, b) => a.band - b.band || a.x - b.x);
        chips = entries.map((e, i) => {
          const rest = (byGroup[e.grp] || []).filter((p) => p.id !== e.bio.id);
          return { key: `p${i}`, label: (e.posAbbr || e.grp).toUpperCase(), group: e.grp, x: e.x, y: e.y, face: { rank: 1, ...e.bio }, players: [{ rank: 1, ...e.bio }, ...rest.map((p, k) => ({ ...p, rank: k + 2 }))] };
        });
      }
    }
  } catch {}
  if (chips.length) {
    const scope = historical ? `${season} season` : `last ${nMatches} match${nMatches === 1 ? "" : "es"}`;
    return { formation, subtitle: `${formation} · typical XI (${scope})`, chips, updatedMatch: when };
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

async function resolveStatRankedLineup(cfg, team, unit) {
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
  // Line 1 vs line 2: shift the face one line deeper (forwards/goalie +1, a D
  // pair is 2 players so +2). The full ranked list stays in the popover.
  const lineIdx = unit === "line2" ? 1 : 0;
  const chips = [];
  for (const spec of cfg.layout) {
    const players = (buckets[spec.posKey] || []).map((b, i) => ({ rank: i + 1, ...b }));
    if (!players.length) continue;
    const base = (spec.faceRank || 1) - 1 + (spec.group === "Defense" ? lineIdx * 2 : lineIdx);
    const faceIdx = Math.min(base, players.length - 1);
    chips.push({ key: spec.key, label: spec.label, group: spec.group, x: spec.x, y: spec.y, face: players[faceIdx], players });
  }
  const lineWord = cfg.dualUnit ? `${unit === "line2" ? "2nd" : "1st"} line · ` : "";
  return { formation: null, subtitle: `${lineWord}by ${seasonLabel(season)} production`, chips };
}

// ---------------------------------------------------------------------------
// BUILDER D: "roster" sports (college football + basketball). No depth chart
// exists anywhere for college, so we show the REAL roster grouped by position,
// ordered by class (seniors first), and clearly label it "roster by class — not
// verified starters." Football is dual-unit: one team's offense vs another's
// defense (pass unit="offense"|"defense").
// ---------------------------------------------------------------------------
const CLASS_ABBR = { 1: "FR", 2: "SO", 3: "JR", 4: "SR", 5: "GR" };
function collegePlayer(a, cfg) {
  const years = a.experience && typeof a.experience.years === "number" ? a.experience.years : 0;
  const { extra } = cfg.bio ? cfg.bio(a) : { extra: "" };
  return {
    id: String(a.id), name: a.fullName || a.displayName || "Unknown", jersey: a.jersey || "",
    injury: injuryStatus(a),
    age: typeof a.age === "number" ? a.age : null, // pro roster sports (WNBA) have age; college doesn't
    classYear: cfg.classYears ? (a.experience?.abbreviation || CLASS_ABBR[years] || "") : "",
    classOrder: years,
    height: a.displayHeight || "", weight: a.displayWeight || "", exp: null,
    extra: extra || "", pos: a.position?.abbreviation || "",
  };
}
async function resolveRosterLineup(cfg, team, unit) {
  const { sport, league } = cfg.espn;
  const players = flatAthletes(await fetchJson(rosterUrl(sport, league, team.id))).map((a) => collegePlayer(a, cfg));
  const buckets = {};
  for (const p of players) { const b = cfg.bucket(p.pos); if (!b) continue; (buckets[b] = buckets[b] || []).push(p); }
  for (const k of Object.keys(buckets)) buckets[k].sort((x, y) => (y.classOrder - x.classOrder) || x.name.localeCompare(y.name));
  const layout = cfg.dualUnit ? cfg.layouts[unit === "defense" ? "defense" : "offense"] : cfg.layout;
  const chips = [];
  for (const spec of layout) {
    const list = (buckets[spec.bucket] || []).map((p, i) => ({ rank: i + 1, ...p }));
    if (!list.length) continue;
    const faceIdx = Math.min((spec.faceRank || 1) - 1, list.length - 1);
    chips.push({ key: spec.key, label: spec.label, group: spec.group, x: spec.x, y: spec.y, face: list[faceIdx], players: list });
  }
  const unitWord = cfg.dualUnit ? (unit === "defense" ? "Defense" : "Offense") + " · " : "";
  return { formation: null, subtitle: `${unitWord}${cfg.rosterLabel || "roster by class"}`, chips };
}

// ---------------------------------------------------------------------------
// BUILDER E: "boxstart" sports (NBA, WNBA, CBB) — box scores flag who started,
// so we derive the TYPICAL starting five from the last several completed games
// (how often each player started, recency breaks ties) and place them on the
// court by broad role. Players no longer on the roster are dropped (graduated /
// traded), so an offseason team shows its returning regulars. If too few
// returning starters remain (early season / sparse data), we fall back —
// `boxFallback: "depth"` → ESPN depth chart (NBA), otherwise roster-by-position.
// This is why the Fever now show Caitlin Clark instead of a roster-order guard.
// ---------------------------------------------------------------------------
async function resolveBoxStartLineup(cfg, team, season) {
  const { sport, league } = cfg.espn;
  const historical = !!season;
  const rosterJson = await fetchJson(rosterUrl(sport, league, team.id));
  const rosterMap = buildRosterMap(rosterJson, cfg);
  // Display bios (class year for college), and the roster grouped into the
  // court's buckets for the depth popover behind each spot. (Rebuilt from the
  // box scores below when showing a past season.)
  const bioFor = new Map(), byBucket = {};
  for (const a of flatAthletes(rosterJson)) {
    const bio = cfg.classYears ? collegePlayer(a, cfg) : rosterMap.get(String(a.id));
    if (!bio) continue;
    bioFor.set(String(a.id), bio);
    const b = cfg.bucket(bio.pos); if (b) (byBucket[b] = byBucket[b] || []).push(bio);
  }
  if (cfg.classYears) for (const k of Object.keys(byBucket)) byBucket[k].sort((x, y) => (y.classOrder - x.classOrder) || x.name.localeCompare(y.name));
  const fallback = () => (cfg.boxFallback === "depth" ? resolveDepthLineup(cfg, team, season) : resolveRosterLineup(cfg, team));

  let when = null, nGames = 0; const agg = new Map(); // id -> { starts, lastIdx, pos, name }
  try {
    const sched = await fetchJson(scheduleUrl(sport, league, team.id, season));
    const done = (sched.events || []).filter((e) => e.competitions?.[0]?.status?.type?.completed)
      .sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, historical ? 15 : 10);
    if (done.length) {
      when = done[0].date || null;
      const sums = await Promise.all(done.map((e) => fetchJson(summaryUrl(sport, league, e.id)).catch(() => null)));
      sums.forEach((sum, idx) => {
        const mine = (sum?.boxscore?.players || []).find((t) => String(t.team?.id) === String(team.id));
        const starters = (mine?.statistics?.[0]?.athletes || []).filter((a) => a.starter);
        if (!starters.length) return;
        nGames++;
        for (const s of starters) {
          const id = String(s.athlete?.id || ""); if (!id) continue;
          const rec = agg.get(id) || { id, starts: 0, recent: 0, lastIdx: 99, pos: "", name: s.athlete?.displayName || "" };
          rec.starts++; if (idx < 5) rec.recent++; rec.lastIdx = Math.min(rec.lastIdx, idx);
          if (s.athlete?.position?.abbreviation) rec.pos = s.athlete.position.abbreviation;
          agg.set(id, rec);
        }
      });
    }
  } catch {}
  if (historical) {
    // Past season: rebuild bios/depth from the box scores themselves (those
    // players usually aren't on the current roster). No current-roster gate.
    bioFor.clear(); for (const k of Object.keys(byBucket)) delete byBucket[k];
    const starts = [...agg.values()].sort((a, b) => b.starts - a.starts);
    for (const r of starts) {
      const bio = { id: r.id, name: r.name || "—", jersey: "", injury: null, age: null, height: "", weight: "", exp: null, extra: "", pos: r.pos, classYear: "", classOrder: 0 };
      bioFor.set(r.id, bio);
      const b = cfg.bucket(r.pos) || "guard"; (byBucket[b] = byBucket[b] || []).push(bio);
    }
  } else {
    for (const id of [...agg.keys()]) if (!bioFor.has(id)) agg.delete(id); // keep only current roster
  }
  if (agg.size < 4) return fallback(); // not enough starters to trust

  // Recency-weighted score: starts in the last 5 games dominate (tracks the
  // CURRENT five through injuries/returns), total starts + recency break ties.
  const scored = [...agg.values()]
    .map((r) => ({ ...r, bucket: cfg.bucket(bioFor.get(r.id).pos) || "guard", score: (r.recent || 0) * 1000 + r.starts * 10 - r.lastIdx }))
    .sort((a, b) => b.score - a.score);
  const five = scored.slice(0, cfg.layout.length); // the starting five as a SET — no real starter is dropped for a bucket match

  // Place the five on the court: each player takes the closest still-open slot
  // (perimeter → interior), so three-guard / small-ball fives land sensibly.
  const PERIM = { PG: 0, SG: 1, SF: 2, PF: 3, C: 4 };          // outside → inside
  const playerPerim = { guard: 0.5, forward: 3, center: 4 };
  const slotPref = (bkt) => [...cfg.layout]
    .map((s, i) => ({ key: s.key, d: Math.abs((PERIM[s.key] ?? 2.5) - (playerPerim[bkt] ?? 2)), i }))
    .sort((a, b) => a.d - b.d || a.i - b.i).map((s) => s.key);
  const open = new Set(cfg.layout.map((s) => s.key)), pickFor = {};
  for (const p of five) {
    const key = slotPref(p.bucket).find((k) => open.has(k)) ?? [...open][0];
    if (key == null) break;
    pickFor[key] = p; open.delete(key);
  }
  const BLABEL = { guard: "Guard", forward: "Forward", center: "Center" };
  const BGROUP = { guard: "Guards", forward: "Forwards", center: "Center" };
  const chips = cfg.layout.map((spec) => {
    const star = pickFor[spec.key]; if (!star) return null;
    const faceBio = { rank: 1, ...bioFor.get(star.id) };
    const list = byBucket[star.bucket] || [];                 // depth = the player's own position group
    const rest = list.filter((p) => p.id !== faceBio.id).map((p, k) => ({ ...p, rank: k + 2 }));
    // Label by the PLAYER's position; keep the slot's specific label only when it
    // matches (so a spare guard placed at a wing reads "Guard", not "Forward").
    const matched = star.bucket === spec.bucket;
    return { key: spec.key, label: matched ? spec.label : (BLABEL[star.bucket] || spec.label), group: matched ? spec.group : (BGROUP[star.bucket] || spec.group), x: spec.x, y: spec.y, face: faceBio, players: [faceBio, ...rest] };
  }).filter(Boolean);
  if (chips.length < 3) return fallback();
  const scope = historical ? `${cfg.seasonEndYear ? seasonLabel(season) : season} season` : `last ${nGames} game${nGames === 1 ? "" : "s"}`;
  return { formation: null, subtitle: `typical starting five · ${scope}`, chips, updatedMatch: when };
}

// ---------------------------------------------------------------------------
// Team context: W–L record (all sports) + AP rank (college). Cached ~6h so
// fresh-on-load lineup pulls don't refetch these on every request.
// ---------------------------------------------------------------------------
const CONTEXT_TTL = 6 * 3600e3;
const recordStore = new Map();
// Parse the team's upcoming game from the team endpoint's nextEvent (already in
// the same payload as the record) → { opp, homeAway: "vs"|"@", date } or null.
function parseNext(team, myId) {
  const comp = (team?.nextEvent || [])[0]?.competitions?.[0];
  if (!comp || !Array.isArray(comp.competitors)) return null;
  const mine = comp.competitors.find((c) => String(c.team?.id || c.id) === String(myId));
  const opp = comp.competitors.find((c) => c !== mine);
  if (!opp) return null;
  return {
    opp: opp.team?.abbreviation || opp.team?.shortDisplayName || opp.team?.displayName || "",
    homeAway: mine?.homeAway === "away" ? "@" : "vs",
    date: comp.date || (team.nextEvent[0] && team.nextEvent[0].date) || null,
  };
}
// Team context (record + next game), cached ~6h. Returns { record, next }.
function teamRecord(sport, league, teamId) {
  return cached(recordStore, `${league}:${teamId}`, CONTEXT_TTL, async () => {
    try {
      const d = await fetchJson(`${site}/${sport}/${league}/teams/${teamId}`, { timeout: 5000, retries: 0 });
      return { record: d.team?.record?.items?.[0]?.summary || null, next: parseNext(d.team, teamId) };
    } catch { return { record: null, next: null }; }
  }).catch(() => ({ record: null, next: null }));
}
const rankStore = new Map();
function rankingsMap(sport, league) {
  return cached(rankStore, league, CONTEXT_TTL, async () => {
    try {
      const d = await fetchJson(`${site}/${sport}/${league}/rankings`, { timeout: 5000, retries: 0 });
      const poll = (d.rankings || []).find((r) => /ap/i.test(`${r.shortName || ""}${r.name || ""}`)) || (d.rankings || [])[0];
      const m = new Map();
      for (const r of (poll?.ranks || [])) { const id = String(r.team?.id || ""); if (id) m.set(id, r.current); }
      return m;
    } catch { return new Map(); }
  }).catch(() => new Map());
}

// ---------------------------------------------------------------------------
// PUBLIC: build one team's lineup payload (cached per team, daily).
// ---------------------------------------------------------------------------
async function buildLineup(cfg, team, unit, season) {
  const isCollege = cfg.key === "cfb" || cfg.key === "cbb";
  // Historical is only supported on the season-aware builders (match/boxstart/depth).
  const hist = cfg.history ? season : null;
  const [src, ctx, ranks] = await Promise.all([
    cfg.kind === "match" ? resolveMatchLineup(cfg, team, hist)
      : cfg.kind === "statrank" ? resolveStatRankedLineup(cfg, team, unit)
        : cfg.kind === "boxstart" ? resolveBoxStartLineup(cfg, team, hist)
          : cfg.kind === "roster" ? resolveRosterLineup(cfg, team, unit)
            : resolveDepthLineup(cfg, team, hist),
    teamRecord(cfg.espn.sport, cfg.espn.league, team.id),
    isCollege ? rankingsMap(cfg.espn.sport, cfg.espn.league) : Promise.resolve(new Map()),
  ]);
  const record = ctx && ctx.record, next = ctx && ctx.next;
  // Attach video-game overall ratings (MLS → EA FC, MLB → The Show, CFB → EA
  // College Football when EA publishes it) from committed maps — zero runtime
  // fetching. NFL/Madden is handled in lib/nfl.js.
  // Video-game ratings. For a past season, use that season's map when we have one
  // (MLB The Show is per-year); sports whose game exposes only the current edition
  // (soccer/EA FC, NFL/Madden) have no historical map, so a past season shows no
  // badge rather than stamping today's OVRs onto an old lineup.
  const ratingLabel = ratings.publisher(cfg.key, hist);
  if (ratingLabel) {
    for (const c of src.chips || []) {
      if (c.face) c.face.overall = ratings.ratingFor(cfg.key, c.face.name, hist);
      for (const p of c.players || []) p.overall = ratings.ratingFor(cfg.key, p.name, hist);
    }
  }
  // College hockey: attach each player's NHL draft status from the committed map.
  if (cfg.draftStatus) {
    for (const c of src.chips || []) {
      if (c.face) c.face.draft = draft.draftFor(c.face.name);
      for (const p of c.players || []) p.draft = draft.draftFor(p.name);
    }
  }
  return {
    sport: cfg.key,
    surface: cfg.surface,
    dualUnit: !!cfg.dualUnit,
    unit: unit || null,
    ratingLabel: ratingLabel || null,
    draftStatus: !!cfg.draftStatus,
    season: hist || null, // non-null when showing a past season
    // For a past season, don't surface the CURRENT record/rank/next-game (they'd be
    // wrong for that season); a season-specific record isn't fetched, so show none.
    team: { id: team.id, name: team.name, abbr: team.abbr, color: team.color, alt: team.alt, logo: team.logo, record: hist ? null : (record || null), rank: hist ? null : (ranks.get(String(team.id)) || null), next: hist ? null : (next || null) },
    formation: src.formation,
    subtitle: src.subtitle,
    asOf: src.updatedMatch || null, // date of the game(s) the lineup is derived from (null for live depth charts)
    chips: src.chips,
    updated: new Date().toISOString(),
  };
}

// Cache sizes for /healthz observability (read-only snapshot of the ~6h context caches).
function cacheStats() {
  return { record: recordStore.size, rank: rankStore.size };
}

module.exports = {
  stats, fetchText, fetchJson, cached, writeDisk, readDisk, buildLineup, cacheStats,
  // exported for possible reuse/testing
  buildRosterMap, rankedPlayers, soccerSlot, soccerGroup, placeStarters,
};
