// scripts/gen-seeds.js — build each sport's DEFAULT matchup once and save it to
// data/seed/<key>.json (committed). These are the "last-good" fallback the server
// serves if a cold start coincides with an upstream outage (Render's /tmp cache
// is wiped on every restart). Static baseline — refresh anytime: `npm run gen-seeds`.
const fs = require("fs");
const path = require("path");
const { buildLineup } = require("../lib/espn.js");
const nfl = require("../lib/nfl.js");
const SEED = path.join(__dirname, "..", "data", "seed");
const safe = (k) => k.replace(/[^\w.-]/g, "_") + ".json";
const SPORTS = ["nhl", "nba", "mls", "cbb", "cfb", "mlb", "mch", "wnba"];

(async () => {
  fs.mkdirSync(SEED, { recursive: true });
  const write = (key, data) => { fs.writeFileSync(path.join(SEED, safe(key)), JSON.stringify(data)); console.error(`  seed ${safe(key)} (${(data.chips || []).length} chips)`); };

  try { const y = nfl.currentNflSeason(); const d = await nfl.getTeamData("2", y, false); fs.writeFileSync(path.join(SEED, safe(`nfl:2:${y}`)), JSON.stringify(d)); console.error(`  seed ${safe(`nfl:2:${y}`)} (NFL)`); }
  catch (e) { console.error("  nfl seed failed:", e.message); }

  for (const s of SPORTS) {
    const cfg = require(`../sports/${s}.js`);
    const sides = cfg.dualUnit ? [[cfg.defaults.a, cfg.units[0]], [cfg.defaults.b, cfg.units[1]]] : [[cfg.defaults.a, ""], [cfg.defaults.b, ""]];
    for (const [id, unit] of sides) {
      const t = cfg.teams.find((x) => String(x.id) === String(id));
      if (!t) continue;
      try { write(`${s}:${id}:${unit}`, await buildLineup(cfg, t, unit || undefined)); }
      catch (e) { console.error(`  ${s}:${id} seed failed:`, e.message); }
    }
  }
  console.error("Seeds written to data/seed/. Commit them: git add data/seed && git commit");
})();
