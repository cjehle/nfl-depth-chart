// Tests for the pure, dependency-free logic in the shared engine + sport configs.
// Run with:  npm test   (node --test)  — no network needed.
const test = require("node:test");
const assert = require("node:assert");
const { soccerSlot, soccerGroup, placeStarters } = require("../lib/espn.js");
const cfb = require("../sports/cfb.js");
const cbb = require("../sports/cbb.js");
const util = require("../lib/nfl-util.js");

test("soccerSlot classifies band + side", () => {
  assert.equal(soccerSlot("GK").band, 0);
  assert.equal(soccerSlot("CD-R").band, 1);
  assert.equal(soccerSlot("RB").band, 1);
  assert.equal(soccerSlot("RB").side, 1);
  assert.equal(soccerSlot("LB").side, -1);
  assert.equal(soccerSlot("AM-L").band, 4);
  assert.equal(soccerSlot("ST").band, 5);
  // a fullback should sit wider than a center-back on the same line
  assert.ok(soccerSlot("RB").xhint > soccerSlot("CD-R").xhint);
});

test("soccerGroup buckets to the four lines", () => {
  assert.equal(soccerGroup("GK"), "Goalkeeper");
  assert.equal(soccerGroup("CB"), "Defense");
  assert.equal(soccerGroup("CM"), "Midfield");
  assert.equal(soccerGroup("ST"), "Forward");
});

test("placeStarters spreads a back four left→right", () => {
  const e = [
    { band: 1, side: -1, xhint: -1, fp: 1 }, { band: 1, side: -1, xhint: -0.35, fp: 2 },
    { band: 1, side: 1, xhint: 0.35, fp: 3 }, { band: 1, side: 1, xhint: 1, fp: 4 },
  ];
  placeStarters(e);
  const xs = e.map((x) => x.x);
  assert.deepEqual(xs, [...xs].sort((a, b) => a - b)); // ascending = left→right
  assert.ok(xs[0] < 20 && xs[3] > 80);
});

test("cfb.bucket maps positions to O/D units", () => {
  assert.equal(cfb.bucket("QB"), "qb");
  assert.equal(cfb.bucket("OT"), "ol");
  assert.equal(cfb.bucket("C"), "ol");
  assert.equal(cfb.bucket("WR"), "wr");
  assert.equal(cfb.bucket("DE"), "dl");
  assert.equal(cfb.bucket("MLB"), "lb");
  assert.equal(cfb.bucket("CB"), "db");
  assert.equal(cfb.bucket("K"), null);
});

test("cbb.bucket maps to guard/forward/center", () => {
  assert.equal(cbb.bucket("PG"), "guard");
  assert.equal(cbb.bucket("G"), "guard");
  assert.equal(cbb.bucket("SF"), "forward");
  assert.equal(cbb.bucket("C"), "center");
});

test("nfl-util pure helpers", () => {
  assert.equal(util.offenseKey("HB"), "rb");
  assert.equal(util.defenseCat("NT"), "DL");
  assert.equal(util.normName("José Álvarez Jr."), "jose alvarez");
  assert.equal(util.ageFromDob("2000-09-01", 2025), 25);
});
