// scripts/gen-nfl-history.js — pre-bake COMPLETED NFL seasons into committed snapshots.
//
// A finished season's depth chart never changes, yet serving one at runtime pulls a ~50MB
// nflverse CSV from github.com and parses it in memory — the single biggest memory spike on
// a 512MB free-tier instance, plus a hardcoded third-party URL that will drift over a decade.
// This bakes each completed season × team into data/seed/nfl_<teamId>_<year>.json (the SAME
// key getTeamData reads via readDisk), so the server serves the committed snapshot and never
// touches nflverse for past seasons. Unbaked seasons still fall through to the live build,
// so this is a pure optimization layer — safe to run partially, safe to delete.
//
// Idempotent + cheap to re-run: an already-committed (team,year) file is skipped BEFORE any
// fetch, so a fully-baked year triggers NO network I/O. That lets the monthly cron bake each
// season exactly once, the month after it completes, with no work the rest of the time.
//
// Usage:  node scripts/gen-nfl-history.js            # bake every completed season, skip existing
//         node scripts/gen-nfl-history.js --year=2024 # only that season
//         node scripts/gen-nfl-history.js --force      # rebuild even if committed (honors shrink-guard)
const fs = require("fs");
const path = require("path");
const nfl = require("../lib/nfl.js");
const { safeKey } = require("../lib/espn.js");

const SEED = path.join(__dirname, "..", "data", "seed");
const FORCE = process.argv.includes("--force");
const yearArg = (process.argv.find((a) => a.startsWith("--year=")) || "").split("=")[1];

// Total players across the envelope's units — the shrink/empty guard's "content" measure.
const contentCount = (d) => {
  let n = 0;
  const walk = (o) => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === "object") { if (Array.isArray(o.players)) n += o.players.length; else for (const k in o) walk(o[k]); }
  };
  if (d) { walk(d.offense); walk(d.defense); walk(d.specialTeams); }
  return n;
};

(async () => {
  fs.mkdirSync(SEED, { recursive: true });
  const cur = nfl.currentNflSeason();
  const years = yearArg
    ? [Number(yearArg)]
    : [];
  if (!yearArg) for (let y = nfl.SEASON.OLDEST; y < cur; y++) years.push(y); // only COMPLETED seasons
  let wrote = 0, skipped = 0, empty = 0, refused = 0, failed = 0;

  for (const year of years) {
    if (!Number.isInteger(year) || year < nfl.SEASON.OLDEST || year >= cur) {
      console.error(`  skip year ${year}: not a completed season in [${nfl.SEASON.OLDEST}, ${cur - 1}]`);
      continue;
    }
    for (const team of nfl.NFL_TEAMS) {
      const file = path.join(SEED, safeKey(`nfl:${team.id}:${year}`));
      if (!FORCE && fs.existsSync(file)) { skipped++; continue; } // already baked → no build, no fetch
      let env;
      try { env = await nfl.buildTeamData(team.id, year); } // past-season path: nflverse + cached players/madden, no ESPN
      catch (e) { console.error(`  ${year} ${team.abbr}: build failed — ${e.message}`); failed++; continue; }
      const newN = contentCount(env);
      if (newN === 0) { console.error(`  ${year} ${team.abbr}: empty build (0 players) — not writing`); empty++; continue; }
      // Shrink-guard (matters with --force): never replace a committed snapshot with a thinner one.
      let oldN = 0; try { oldN = contentCount(JSON.parse(fs.readFileSync(file, "utf8"))); } catch {}
      if (oldN > 0 && newN < oldN) { console.error(`  ${year} ${team.abbr}: ${newN} < committed ${oldN} — keeping last-good`); refused++; continue; }
      fs.writeFileSync(file, JSON.stringify(env));
      wrote++;
      if (wrote % 16 === 0) console.error(`  …${wrote} written (through ${year})`);
    }
    console.error(`  season ${year} done`);
  }
  console.error(`\nNFL history: wrote ${wrote}, skipped ${skipped} (already baked), empty ${empty}, refused ${refused}, failed ${failed}.`);
  console.error(`Commit them:  git add data/seed && git commit -m "chore(nfl-history): pre-baked completed seasons"`);
  // Refusal / empty on an EXISTING season is a real signal (flaky nflverse) → non-zero exit so
  // the monthly cron's "refused" alert fires. Missing-team builds (failed) are expected for some
  // team/season combos and do NOT fail the run.
  if (refused > 0 || (empty > 0 && FORCE)) process.exitCode = 1;
  process.exit(process.exitCode || 0);
})();
