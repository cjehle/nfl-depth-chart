// Committed rating-map integrity — a hard CI stop for a coverage collapse or value
// corruption, so a gutted/garbage map can't silently render an empty badge column.
// (The gen-ratings shrink-guard protects the PULL; this protects the committed FILE
// against a bad hand-edit, merge, guard bug, or EA schema flip.) Network-free.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { ratingFor } = require("../lib/ratings.js");

const DIR = path.join(__dirname, "..", "data", "ratings");
const load = (k) => JSON.parse(fs.readFileSync(path.join(DIR, `${k}.json`), "utf8"));
// Floors are DELIBERATELY well below today's counts (mlb 2037, mls 831, epl 611, laliga
// 811, bundesliga 536, seriea 580, ligue1 493, nwsl 367) so a normal edition refresh
// never trips them — only a collapse does. cfb is intentionally empty (EA not publishing).
const FLOORS = { mlb: 1500, mls: 400, epl: 400, laliga: 400, bundesliga: 300, seriea: 300, ligue1: 300, nwsl: 200 };

test("each rated map clears its conservative coverage floor", () => {
  for (const [k, floor] of Object.entries(FLOORS)) {
    const n = Object.keys(load(k)).length;
    assert.ok(n >= floor, `${k}.json collapsed to ${n} (floor ${floor}) — run \`npm run gen-ratings\` or investigate`);
  }
});

test("every OVR is an integer in a plausible band (40-99)", () => {
  for (const k of Object.keys(FLOORS)) {
    for (const [name, ovr] of Object.entries(load(k))) {
      assert.ok(Number.isInteger(ovr) && ovr >= 40 && ovr <= 99, `${k}.json: "${name}" has implausible OVR ${ovr}`);
    }
  }
});

test("marquee players still resolve to an in-band OVR (end-to-end pipeline)", () => {
  // Resolution-stability, not exact values, so edition refreshes don't churn the test.
  const anchors = [["mlb", "Aaron Judge"], ["mls", "Lionel Messi"], ["epl", "Erling Haaland"],
    ["laliga", "Robert Lewandowski"], ["seriea", "Lautaro Martinez"], ["ligue1", "Ousmane Dembele"]];
  let resolved = 0;
  for (const [lg, name] of anchors) { const v = ratingFor(lg, name); if (v != null) { assert.ok(v >= 60 && v <= 99, `${lg}/${name}=${v} out of band`); resolved++; } }
  assert.ok(resolved >= anchors.length - 2, `too many marquee anchors failed to resolve (${resolved}/${anchors.length}) — matcher or maps likely broke`);
});
