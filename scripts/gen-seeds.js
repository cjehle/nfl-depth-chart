// scripts/gen-seeds.js — build each sport's DEFAULT matchup once and save it to
// data/seed/<key>.json (committed). These are the "last-good" fallback the server
// serves if a cold start coincides with an upstream outage (Render's /tmp cache is
// wiped on every restart) — the ONLY durable copy across cold starts, so it must
// exist for every sport. Static baseline — refresh anytime: `npm run gen-seeds`.
//
// Filenames are derived from the SAME lineupKey/safeKey the server uses at read time
// (imported, not reimplemented), so the two can never drift apart again. The sport
// list is derived from sports/*.js, so a newly-added sport gets a seed automatically.
const fs = require("fs");
const path = require("path");
const { buildLineup, safeKey, lineupKey } = require("../lib/espn.js");
const nfl = require("../lib/nfl.js");
const SEED = path.join(__dirname, "..", "data", "seed");
const SPORTS_DIR = path.join(__dirname, "..", "sports");
// Every sport config (exclude the shared soccer factory, which isn't a sport itself).
const SPORTS = fs.readdirSync(SPORTS_DIR).filter((f) => f.endsWith(".js") && f !== "_soccer.js").map((f) => f.slice(0, -3)).sort();

(async () => {
  fs.mkdirSync(SEED, { recursive: true });
  // Comparable "content" size for both shapes: surface lineups carry chips[], the NFL
  // envelope carries offense/defense/specialTeams position groups.
  const contentCount = (d) => {
    if (!d) return 0;
    if (Array.isArray(d.chips)) return d.chips.length;
    let n = 0; const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === "object") { if (Array.isArray(o.players)) n++; else for (const k in o) walk(o[k]); } };
    walk(d.offense); walk(d.defense); walk(d.specialTeams); return n;
  };
  // Shrink-guard: seeds are the ONLY durable cold-start fallback, so never replace a
  // committed seed with a SMALLER build (a transient ESPN outage would otherwise gut it).
  // A brand-new seed (no prior file) always writes. Refusal sets a non-zero exit.
  const write = (key, data) => {
    const f = safeKey(key), file = path.join(SEED, f);
    const newN = contentCount(data);
    let oldN = 0; try { oldN = contentCount(JSON.parse(fs.readFileSync(file, "utf8"))); } catch {}
    if (oldN > 0 && newN < oldN) { console.error(`  skip seed ${f}: ${newN} < committed ${oldN} (transient outage?) — keeping last-good`); process.exitCode = 1; return; }
    fs.writeFileSync(file, JSON.stringify(data));
    console.error(`  seed ${f} (${newN} ${Array.isArray(data.chips) ? "chips" : "slots"})`);
  };

  // NFL: write under the SEASON-AGNOSTIC key (nfl:<team>) that getTeamData reads for
  // the current season, so the seed keeps matching after every season rollover.
  try { const y = nfl.currentNflSeason(); const d = await nfl.getTeamData("2", y, false); write("nfl:2", d); }
  catch (e) { console.error("  nfl seed failed:", e.message); }

  for (const s of SPORTS) {
    let cfg; try { cfg = require(`../sports/${s}.js`); } catch (e) { console.error(`  skip ${s}: ${e.message}`); continue; }
    if (!Array.isArray(cfg.teams) || !cfg.teams.length) continue;
    const sides = cfg.dualUnit
      ? [[cfg.defaults.a, cfg.units[0]], [cfg.defaults.b, cfg.units[1]]]
      : [[cfg.defaults.a, ""], [cfg.defaults.b, ""]];
    for (const [id, unit] of sides) {
      const t = cfg.teams.find((x) => String(x.id) === String(id));
      if (!t) continue;
      // Same key the runtime builds (default: no year/formation) → identical filename.
      try { write(lineupKey(s, id, unit, "", ""), await buildLineup(cfg, t, unit || undefined)); }
      catch (e) { console.error(`  ${s}:${id} seed failed:`, e.message); }
    }
  }
  console.error(`Seeds written to data/seed/ for NFL + ${SPORTS.length} sports. Commit them: git add data/seed && git commit`);
})();
