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

async function fcMLS() {
  const map = {}; let offset = 0, total = Infinity, pages = 0, empty = 0, failed = 0;
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
      // MLS league only — never borrow a same-named player from another league
      // (e.g. the LALIGA Lewandowski is a different person from the Fire's).
      if (!/major league soccer|\bmls\b/i.test(p.leagueName || "")) continue;
      if (p.overallRating == null) continue;
      // Key by BOTH common name and full name so ESPN's "Robert Lewandowski"
      // matches whether EA stored a short commonName or the full name.
      for (const nm of [normName(p.commonName || ""), normName(`${p.firstName || ""} ${p.lastName || ""}`)]) {
        if (nm && map[nm] == null) map[nm] = p.overallRating;
      }
    }
    offset += 100; pages++; if (pages % 25 === 0) console.error(`    …FC ${offset}/${total}`); await sleep(150);
  }
  fs.writeFileSync(path.join(OUT, "mls.json"), JSON.stringify(map));
  console.error(`  mls.json: ${Object.keys(map).length} MLS players (scanned ${pages} FC pages${failed ? `, ${failed} skipped` : ""})`);
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
  await fcMLS();
  await theShowMLB();
  await eaCFB();
  console.error("Done → data/ratings/. Commit them: git add data/ratings && git commit");
})();
