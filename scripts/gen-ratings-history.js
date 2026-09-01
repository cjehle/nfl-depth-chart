// scripts/gen-ratings-history.js — build PER-SEASON MLB The Show rating maps for
// past years (data/ratings/mlb-YYYY.json), so a historical MLB lineup shows that
// season's video-game ratings. MLB The Show is the only game with per-year public
// data (mlbNN.theshow.com); EA FC (soccer) and Madden (NFL) expose only the current
// edition, so those sports get no historical ratings. Run `npm run gen-ratings-history`,
// then commit data/ratings/. Zero deps (Node 20+).
const fs = require("fs");
const path = require("path");
const { normName } = require("../lib/nfl-util.js");
const H = { "User-Agent": "Mozilla/5.0", Accept: "application/json" };
const OUT = path.join(__dirname, "..", "data", "ratings");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (u) => { for (let i = 0; i < 4; i++) { try { const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(20000) }); if (r.ok) return r.json(); } catch (e) {} await sleep(700 * (i + 1)); } return null; };

// The Show edition per calendar season: mlb{NN}.theshow.com hosts season 20NN.
async function showYear(year) {
  const file = path.join(OUT, `mlb-${year}.json`);
  // Past-season ratings NEVER change, so a completed season is frozen once captured:
  // skip it if we already have a non-empty map. This makes the historical archive grow
  // monotonically and immune to The Show retiring an old mlbNN host (which would else
  // re-pull as empty and overwrite a good file).
  try { if (Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))).length > 0) { console.error(`  mlb-${year}.json: frozen (already captured), skip`); return; } } catch {}
  const host = `mlb${String(year).slice(2)}.theshow.com`;
  const map = {}; let page = 1, totalPages = 1, failed = 0;
  while (page <= totalPages && page <= 300) {
    const d = await j(`https://${host}/apis/items.json?type=mlb_card&page=${page}`);
    if (!d) { failed++; page++; continue; }
    totalPages = d.total_pages || totalPages;
    for (const it of (d.items || [])) {
      if (it.series !== "Live") continue; // Live = that season's real rating
      if (it.ovr == null) continue;
      const nm = normName(it.name);
      if (nm && (map[nm] == null || it.ovr > map[nm])) map[nm] = it.ovr;
    }
    page++; await sleep(120);
  }
  // Never write an empty result over nothing meaningful (a fully-failed host yields {}).
  if (!Object.keys(map).length) { console.error(`  mlb-${year}.json: 0 players (host unreachable?) — not writing`); process.exitCode = 1; return; }
  fs.writeFileSync(file, JSON.stringify(map));
  console.error(`  mlb-${year}.json: ${Object.keys(map).length} players (${page - 1} pages${failed ? `, ${failed} skipped` : ""})`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const nowY = new Date().getUTCFullYear();
  const years = [nowY - 1, nowY - 2, nowY - 3, nowY - 4, nowY - 5]; // last 5 past seasons
  console.error(`Generating per-season MLB The Show ratings for ${years.join(", ")}…`);
  for (const y of years) await showYear(y);
  console.error("Done → data/ratings/mlb-YYYY.json. Commit them.");
})();
