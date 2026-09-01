// Locks the depth-chart future-proofing logic: injury-aware starter promotion and the
// expected-slot count that drives the thin-build completeness gate. Network-free.
const test = require("node:test");
const assert = require("node:assert");
const { healthyFaceIdx, expectedSlotCount } = require("../lib/espn.js");

test("healthyFaceIdx promotes past a season-ending-unavailable starter", () => {
  // Out / IR / Suspended / PUP → promote to the next available player at that spot.
  assert.equal(healthyFaceIdx([{ injury: "Out" }, { injury: null }], 0), 1);
  assert.equal(healthyFaceIdx([{ injury: "Injured Reserve" }, { injury: "Out" }, { injury: null }], 0), 2);
  assert.equal(healthyFaceIdx([{ injury: "Suspension" }, { injury: null }], 0), 1);
});

test("healthyFaceIdx does NOT churn the starter for day-to-day / questionable / doubtful", () => {
  assert.equal(healthyFaceIdx([{ injury: "Questionable" }, { injury: null }], 0), 0);
  assert.equal(healthyFaceIdx([{ injury: "Doubtful" }, { injury: null }], 0), 0);
  assert.equal(healthyFaceIdx([{ injury: "Day-To-Day" }, { injury: null }], 0), 0);
  assert.equal(healthyFaceIdx([{ injury: null }, { injury: "Out" }], 0), 0); // healthy starter stays
});

test("healthyFaceIdx keeps the ranked starter when EVERYONE at the spot is unavailable", () => {
  assert.equal(healthyFaceIdx([{ injury: "Out" }, { injury: "IR" }], 0), 0);
});

test("expectedSlotCount reflects each sport's on-surface size", () => {
  assert.equal(expectedSlotCount({ kind: "match" }), 11);                                  // soccer XI
  assert.equal(expectedSlotCount({ kind: "boxstart", layout: [1, 2, 3, 4, 5] }), 5);        // basketball five
  assert.equal(expectedSlotCount({ kind: "depth", layout: new Array(9) }), 9);              // baseball
  assert.equal(expectedSlotCount({ kind: "roster", layouts: { offense: new Array(11), defense: new Array(11) } }, "offense"), 11); // CFB per unit
});
