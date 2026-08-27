// scripts/gen-draft.js — build a committed NHL-draft map (normalized name ->
// { y:year, r:round, o:overallPick, t:teamAbbrev }) so the live server can show
// each college-hockey player's NHL draft status with zero runtime NHL fetching.
// Source: the NHL's public api-web draft-picks endpoint. Run `npm run gen-draft`,
// then commit data/draft/. Zero deps (Node 20+).
const fs = require("fs");
const path = require("path");
const { normName } = require("../lib/nfl-util.js");
const H = { "User-Agent": "Mozilla/5.0", Accept: "application/json" };
const OUT = path.join(__dirname, "..", "data", "draft");
const val = (v) => (v && typeof v === "object" ? v.default : v) || "";
const j = async (u) => { for (let i = 0; i < 4; i++) { try { const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(15000) }); if (r.ok) return r.json(); } catch (e) {} await new Promise((r) => setTimeout(r, 500 * (i + 1))); } return null; };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const map = {};
  // College players span ~10 draft classes; pull the last 11 completed drafts.
  const END = 2025, START = 2015;
  let picks = 0;
  for (let y = START; y <= END; y++) {
    const d = await j(`https://api-web.nhle.com/v1/draft/picks/${y}/all`);
    if (!d || !Array.isArray(d.picks)) { console.error(`  ${y}: no data (skipped)`); continue; }
    for (const p of d.picks) {
      const nm = normName(`${val(p.firstName)} ${val(p.lastName)}`);
      if (!nm) continue;
      // Keep the earliest (only) draft record per name; names collide rarely.
      if (map[nm] == null) { map[nm] = { y, r: p.round, o: p.overallPick, t: p.teamAbbrev || val(p.teamName) }; picks++; }
    }
    console.error(`  ${y}: ${d.picks.length} picks`);
    await new Promise((r) => setTimeout(r, 120));
  }
  fs.writeFileSync(path.join(OUT, "nhl.json"), JSON.stringify(map));
  console.error(`nhl.json: ${picks} drafted players (${START}-${END}). Commit data/draft/.`);
})();
