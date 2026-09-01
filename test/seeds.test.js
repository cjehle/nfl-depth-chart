// Seeds are the ONLY durable last-good fallback across Render cold starts (its /tmp
// is wiped on every restart), so the committed data/seed/*.json must be reachable by
// the SAME key the runtime reads. These filenames silently drifted once already
// (runtime nba_13___.json vs committed nba_13_.json) and killed the fallback for every
// surface sport; this test makes that regression impossible to reintroduce quietly.
// Network-free: run with `npm test` (node --test).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { safeKey, lineupKey } = require("../lib/espn.js");

const SEED = path.join(__dirname, "..", "data", "seed");
const hasSeed = (key) => fs.existsSync(path.join(SEED, safeKey(key)));
// The sport list is derived the same way gen-seeds derives it (sports/*.js minus the
// shared soccer factory), so a newly-added sport is automatically covered here too.
const SPORTS = fs.readdirSync(path.join(__dirname, "..", "sports"))
  .filter((f) => f.endsWith(".js") && f !== "_soccer.js").map((f) => f.slice(0, -3));

test("safeKey trims trailing empty segments (stable default-lineup filenames)", () => {
  assert.equal(safeKey("nba:13:::"), "nba_13.json");
  assert.equal(safeKey("nhl:2:line1::"), "nhl_2_line1.json");
  assert.equal(safeKey("cfb:193:offense::"), "cfb_193_offense.json");
  assert.equal(safeKey("nfl:2"), "nfl_2.json");
  assert.equal(safeKey("nba:13::2024:"), "nba_13__2024.json"); // middle empties preserved
});

test("every surface sport's default matchup has a committed seed at the runtime key", () => {
  for (const s of SPORTS) {
    let cfg; try { cfg = require(`../sports/${s}.js`); } catch { continue; }
    if (!Array.isArray(cfg.teams) || !cfg.teams.length) continue;
    const sides = cfg.dualUnit
      ? [[cfg.defaults.a, cfg.units[0]], [cfg.defaults.b, cfg.units[1]]]
      : [[cfg.defaults.a, ""], [cfg.defaults.b, ""]];
    for (const [id, unit] of sides) {
      const key = lineupKey(s, id, unit, "", "");
      assert.ok(hasSeed(key), `missing committed seed ${safeKey(key)} for ${s}:${id} — run \`npm run gen-seeds\` and commit data/seed/`);
    }
  }
});

test("NFL default has a season-agnostic committed seed (survives every season rollover)", () => {
  const { DEFAULT_TEAM_ID } = require("../public/nfl/teams.js");
  const id = DEFAULT_TEAM_ID || "2";
  assert.ok(hasSeed(`nfl:${id}`), `missing season-agnostic NFL seed ${safeKey(`nfl:${id}`)} — run \`npm run gen-seeds\``);
});
