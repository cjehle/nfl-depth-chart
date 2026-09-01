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
  const write = (key, data) => { const f = safeKey(key); fs.writeFileSync(path.join(SEED, f), JSON.stringify(data)); console.error(`  seed ${f} (${(data.chips || []).length} chips)`); };

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
