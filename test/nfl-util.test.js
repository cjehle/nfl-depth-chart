// Locks the parse-fragile CSV + unit-assembly helpers in lib/nfl-util.js — the code that turns
// the ~50MB nflverse CSVs into every historical NFL depth chart. These had no direct coverage
// (engine.test.js only exercised offenseKey/defenseCat/normName/ageFromDob). Network-free.
const test = require("node:test");
const assert = require("node:assert");
const u = require("../lib/nfl-util.js");

test("splitCsvLine: quoted commas, doubled-quote escapes, trailing CR", () => {
  assert.deepEqual(u.splitCsvLine("a,b,c"), ["a", "b", "c"]);
  assert.deepEqual(u.splitCsvLine('a,"b,c",d'), ["a", "b,c", "d"]); // "b,c" keeps its comma
  assert.deepEqual(u.splitCsvLine('"he said ""hi""",x'), ['he said "hi"', "x"]); // "" → one literal "
  assert.deepEqual(u.splitCsvLine("a,b\r"), ["a", "b"]);                          // Windows trailing \r dropped
  assert.deepEqual(u.splitCsvLine(""), [""]);
});

test("parseCsv: header→objects, BOM strip, embedded newlines, blank-line skip, no trailing newline", () => {
  assert.deepEqual(u.parseCsv("a,b,c\n1,2,3\n4,5,6\n"),
    [{ a: "1", b: "2", c: "3" }, { a: "4", b: "5", c: "6" }]);
  // BOM on the first header + a newline INSIDE a quoted field must both be handled.
  assert.deepEqual(u.parseCsv("﻿a,b\n1,\"x\ny\"\n"), [{ a: "1", b: "x\ny" }]);
  // Blank lines are skipped; a trailing record with no final newline is still captured.
  assert.deepEqual(u.parseCsv("a,b\n1,2\n\n3,4"), [{ a: "1", b: "2" }, { a: "3", b: "4" }]);
});

test("parseCsv: `wanted` keeps ONLY the requested columns (memory win on the 39-col nflverse file)", () => {
  assert.deepEqual(u.parseCsv("a,b,c\n1,2,3\n", ["a", "c"]), [{ a: "1", c: "3" }]);
});

test("splitIntoSpots: N starters (depth_team=1) → N columns, depth players round-robin behind them", () => {
  const rows = [{ depth_team: "1" }, { depth_team: "1" }, { depth_team: "2" }];
  const spots = u.splitIntoSpots(rows, (r, rank) => ({ rank, dt: r.depth_team }));
  assert.equal(spots.length, 2);                         // two 1st-stringers → two on-field columns
  assert.deepEqual(spots.map((s) => s.slot), [1, 2]);
  assert.deepEqual(spots.map((s) => s.players.length), [2, 1]); // 3rd player rides behind column 1
});

test("assembleUnit: offense groups a key's slots; defense makes one position per starter, tagged with its bucket", () => {
  const off = u.assembleUnit([
    { key: "wr", abbr: "WR", slot: 1, rank: 1, player: { name: "A" } },
    { key: "wr", abbr: "WR", slot: 1, rank: 2, player: { name: "B" } },
  ], "offense");
  assert.deepEqual(Object.keys(off), ["wr"]);
  assert.equal(off.wr.spots[0].players.length, 2);       // both receivers land in the one WR slot

  const def = u.assembleUnit([{ key: "cb", abbr: "LCB", slot: 1, rank: 1, player: { name: "C" } }], "defense");
  const k = Object.keys(def)[0];
  assert.equal(k, "cb__1");                               // defense keys are `${key}__${slot}`
  assert.equal(def[k].cat, "CB");                         // LCB → CB bucket
});
