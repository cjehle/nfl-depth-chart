// scripts/gen-ratings.js — build committed video-game rating maps (normalized
// name -> overall) so the live server never has to page EA/Sony at runtime.
// Sources: EA Sports FC (MLS) + MLB The Show (MLB). NFL uses Madden live in
// lib/nfl.js already. NBA/WNBA (2K) and NHL have no accessible ratings feed.
// Run: `npm run gen-ratings`, then commit data/ratings/. Zero deps (Node 20+).
const fs = require("fs");
const path = require("path");
const { normName } = require("../lib/nfl-util.js");
const H = { "User-Agent": "Mozilla/5.0", Accept: "application/json" };
const OUT = path.join(__dirname, "..", "data", "ratings");
const j = async (u) => { const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error(r.status); return r.json(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One pass over the EA FC database, bucketed into PER-LEAGUE maps. Keeping each
// league separate means a same-named player from another league can't be borrowed
// (e.g. the LALIGA Lewandowski is a different person from the Fire's).
// Each `re` matches the TOP flight only; `not` excludes lower/women's divisions that
// share the league word (e.g. La Liga's 2nd tier is "LALIGA HYPERMOTION", Spain's
// women's league is "Liga F"). Without these guards a second-division namesake can
// win the folded-name index and show the wrong OVR on a top-flight starter.
const FC_LEAGUES = [
  { key: "mls", re: /major league soccer|\bmls\b/i },
  { key: "epl", re: /premier league/i, not: /women|wsl|national league|championship/i },
  { key: "laliga", re: /laliga|la liga/i, not: /hypermotion|laliga\s*2|segunda|liga f|women|femen/i },
  { key: "bundesliga", re: /bundesliga/i, not: /2\.?\s*bundesliga|bundesliga\s*2|frauen|women|ö\.|öster|austria/i },
  { key: "seriea", re: /serie a/i, not: /femm|women|serie b/i },
  { key: "ligue1", re: /ligue 1/i, not: /ligue 2|women|féminin|feminin/i },
  { key: "nwsl", re: /nwsl/i },
];
async function fcSoccer() {
  const maps = {}; for (const l of FC_LEAGUES) maps[l.key] = {};
  let offset = 0, total = Infinity, pages = 0, empty = 0, failed = 0;
  while (offset < total && pages < 400 && empty < 3) {
    let d = null;
    for (let attempt = 0; attempt < 4 && !d; attempt++) {          // retry a flaky page, don't abandon the run
      try { d = await j(`https://drop-api.ea.com/rating/ea-sports-fc?locale=en&limit=100&offset=${offset}`); }
      catch (e) { await sleep(600 * (attempt + 1)); }
    }
    if (!d) { console.error(`    FC page @${offset} failed after retries — skipping`); failed++; offset += 100; pages++; continue; }
    total = d.totalItems || total;
    const items = d.items || [];
    if (!items.length) { empty++; } else { empty = 0; }
    for (const p of items) {
      if (p.overallRating == null) continue;
      const ln = p.leagueName || "";
      const L = FC_LEAGUES.find((l) => l.re.test(ln) && !(l.not && l.not.test(ln)));
      if (!L) continue;
      // Key by BOTH common name and full name so ESPN's "Robert Lewandowski"
      // matches whether EA stored a short commonName or the full name.
      for (const nm of [normName(p.commonName || ""), normName(`${p.firstName || ""} ${p.lastName || ""}`)]) {
        if (nm && maps[L.key][nm] == null) maps[L.key][nm] = p.overallRating;
      }
    }
    offset += 100; pages++; if (pages % 25 === 0) console.error(`    …FC ${offset}/${total}`); await sleep(150);
  }
  for (const l of FC_LEAGUES) {
    fs.writeFileSync(path.join(OUT, `${l.key}.json`), JSON.stringify(maps[l.key]));
    console.error(`  ${l.key}.json: ${Object.keys(maps[l.key]).length} players`);
  }
  if (failed) console.error(`  (${failed} FC pages skipped after retries)`);
}

async function theShowMLB() {
  const map = {}; let page = 1, totalPages = 1, failed = 0;
  while (page <= totalPages && page <= 300) {
    let d = null;
    for (let attempt = 0; attempt < 4 && !d; attempt++) {           // retry a flaky page, don't abandon the run
      try { d = await j(`https://mlb26.theshow.com/apis/items.json?type=mlb_card&page=${page}`); }
      catch (e) { await sleep(600 * (attempt + 1)); }
    }
    if (!d) { console.error(`    Show page ${page} failed after retries — skipping`); failed++; page++; continue; }
    totalPages = d.total_pages || totalPages;
    for (const it of (d.items || [])) {
      if (it.series !== "Live") continue; // Live series = the player's current real rating
      if (it.ovr == null) continue;
      const nm = normName(it.name);
      if (nm && (map[nm] == null || it.ovr > map[nm])) map[nm] = it.ovr;
    }
    page++; if (page % 25 === 0) console.error(`    …Show ${page}/${totalPages}`); await sleep(150);
  }
  fs.writeFileSync(path.join(OUT, "mlb.json"), JSON.stringify(map));
  console.error(`  mlb.json: ${Object.keys(map).length} MLB players (scanned ${page - 1} Show pages${failed ? `, ${failed} skipped` : ""})`);
}

// EA Sports College Football (CFB). EA exposes the same drop-api shape as Madden/
// EA FC, but currently returns 0 items for this slug (ratings not published via
// the public API). We still write the (empty) map so the feature lights up the
// moment EA populates it and this script is re-run — no code change needed.
async function eaCFB() {
  const map = {}; let offset = 0, total = Infinity, pages = 0, empty = 0, failed = 0;
  while (offset < total && pages < 400 && empty < 3) {
    let d = null;
    for (let attempt = 0; attempt < 4 && !d; attempt++) {
      try { d = await j(`https://drop-api.ea.com/rating/ea-sports-college-football?locale=en&limit=100&offset=${offset}`); }
      catch (e) { await sleep(600 * (attempt + 1)); }
    }
    if (!d) { failed++; offset += 100; pages++; continue; }
    total = d.totalItems || 0;
    const items = d.items || [];
    if (!items.length) { empty++; } else { empty = 0; }
    for (const p of items) {
      if (p.overallRating == null) continue;
      for (const nm of [normName(p.commonName || ""), normName(`${p.firstName || ""} ${p.lastName || ""}`)]) {
        if (nm && map[nm] == null) map[nm] = p.overallRating;
      }
    }
    offset += 100; pages++; await sleep(150);
  }
  fs.writeFileSync(path.join(OUT, "cfb.json"), JSON.stringify(map));
  console.error(`  cfb.json: ${Object.keys(map).length} CFB players${Object.keys(map).length ? "" : " (EA hasn't published these to the public API yet — empty, will fill when they do)"}`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  console.error("Generating rating maps (this pages EA/Sony — run occasionally, not on the live server)…");
  await fcSoccer();
  await theShowMLB();
  await eaCFB();
  console.error("Done → data/ratings/. Commit them: git add data/ratings && git commit");
})();
