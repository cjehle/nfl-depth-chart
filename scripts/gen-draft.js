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
  // College players span ~10 draft classes; pull the last 11 COMPLETED drafts. Derive the
  // window from the clock (NHL draft is late June/early July) instead of a hardcoded year, so
  // a future manual re-run isn't frozen at a stale ceiling (the mlb26 time-bomb class).
  const now = new Date();
  const END = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1, START = END - 10;
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
  // Shrink/empty guard (mirrors gen-seeds/gen-ratings): never overwrite the committed map with
  // an empty or materially smaller one — a flaky NHL API at run time would otherwise gut it.
  const file = path.join(OUT, "nhl.json");
  let oldN = 0; try { oldN = Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))).length; } catch {}
  if (picks === 0 || (oldN > 0 && picks < oldN * 0.8)) {
    console.error(`  refusing to write: ${picks} picks vs committed ${oldN} (flaky NHL API?) — keeping last-good`);
    process.exitCode = 1; return;
  }
  fs.writeFileSync(file, JSON.stringify(map));
  console.error(`nhl.json: ${picks} drafted players (${START}-${END}). Commit data/draft/.`);
})();
