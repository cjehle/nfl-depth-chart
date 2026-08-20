// test/util.test.js — run with `npm test` (uses Node's built-in test runner).
const { test } = require("node:test");
const assert = require("node:assert");
const {
  splitCsvLine, parseCsv, normName, ageFromDob, offenseKey, defenseCat, groupBy, splitIntoSpots, assembleUnit,
} = require("../lib/util.js");

test("splitCsvLine handles quotes, embedded commas, and trailing CR", () => {
  assert.deepStrictEqual(splitCsvLine("a,b,c"), ["a", "b", "c"]);
  assert.deepStrictEqual(splitCsvLine('a,"b,c",d'), ["a", "b,c", "d"]);
  assert.deepStrictEqual(splitCsvLine('a,"He said ""hi""",c'), ["a", 'He said "hi"', "c"]);
  assert.deepStrictEqual(splitCsvLine("a,b,c\r"), ["a", "b", "c"]); // trailing CR stripped
});

test("parseCsv strips BOM and maps rows to objects", () => {
  const rows = parseCsv("﻿name,pos\nJosh Allen,QB\nJames Cook,RB");
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].name, "Josh Allen");
  assert.strictEqual(rows[1].pos, "RB");
  assert.ok(!("﻿name" in rows[0]), "BOM must not corrupt the first column key");
});

test("parseCsv projects only wanted columns", () => {
  const rows = parseCsv("a,b,c\n1,2,3", ["a", "c"]);
  assert.deepStrictEqual(rows[0], { a: "1", c: "3" });
});

test("parseCsv handles quoted commas and \\r\\n line endings", () => {
  const rows = parseCsv('city,note\r\nBuffalo,"cold, snowy"\r\n');
  assert.strictEqual(rows[0].note, "cold, snowy");
});

test("normName lowercases, drops accents / punctuation / suffixes", () => {
  assert.strictEqual(normName("José Álvarez"), "jose alvarez");
  assert.strictEqual(normName("O'Cyrus Torrence"), "ocyrus torrence");
  assert.strictEqual(normName("James Cook III"), "james cook");
  assert.strictEqual(normName("C.J. Gardner-Johnson"), "cj gardner-johnson");
});

test("ageFromDob computes age as of Sept 1 of the season", () => {
  assert.strictEqual(ageFromDob("1996-05-21T07:00Z", 2020), 24); // Josh Allen
  assert.strictEqual(ageFromDob("1996-05-21T07:00Z", 2025), 29);
  assert.strictEqual(ageFromDob(null, 2025), null);
  assert.strictEqual(ageFromDob("not-a-date", 2025), null);
  // born after Sept 1 -> hasn't had birthday yet that season
  assert.strictEqual(ageFromDob("2000-12-01", 2020), 19);
});

test("offenseKey maps nflverse codes to our field keys", () => {
  assert.strictEqual(offenseKey("HB"), "rb");
  assert.strictEqual(offenseKey("LOT"), "lt");
  assert.strictEqual(offenseKey("WR1"), "wr");
  assert.strictEqual(offenseKey("QB"), "qb");
  assert.strictEqual(offenseKey("K"), null);
});

test("defenseCat buckets codes; NCB is nickel not corner", () => {
  assert.strictEqual(defenseCat("NCB"), "NB");
  assert.strictEqual(defenseCat("LCB"), "CB");
  assert.strictEqual(defenseCat("EDGE"), "DL");
  assert.strictEqual(defenseCat("LDE"), "DL");
  assert.strictEqual(defenseCat("MIKE"), "LB");
  assert.strictEqual(defenseCat("RILB"), "LB");
  assert.strictEqual(defenseCat("FS"), "S");
  assert.strictEqual(defenseCat("LS"), null); // long snapper ignored
});

test("groupBy groups and drops falsy keys", () => {
  const g = groupBy([{ k: "a" }, { k: "a" }, { k: null }, { k: "b" }], (r) => r.k);
  assert.strictEqual(g.get("a").length, 2);
  assert.strictEqual(g.get("b").length, 1);
  assert.ok(!g.has(null));
});

test("assembleUnit offense: one key, multiple slots, starter-first", () => {
  const entries = [
    { key: "wr", abbr: "WR", slot: 1, rank: 1, player: { name: "WR1a" } },
    { key: "wr", abbr: "WR", slot: 2, rank: 2, player: { name: "WR1b" } },
    { key: "wr", abbr: "WR", slot: 1, rank: 4, player: { name: "WR2a" } }, // depth behind slot 1
    { key: "qb", abbr: "QB", slot: 9, rank: 1, player: { name: "QB1" } },
  ];
  const pos = assembleUnit(entries, "offense");
  assert.strictEqual(pos.wr.spots.length, 2, "two WR slots -> two spots");
  assert.strictEqual(pos.wr.spots[0].players[0].name, "WR1a");
  assert.strictEqual(pos.wr.spots[0].players[1].name, "WR2a", "slot depth sorted by rank");
  assert.strictEqual(pos.qb.spots.length, 1);
});

test("assembleUnit defense: one position per starter, cat-tagged", () => {
  const entries = [
    { key: "dt", abbr: "DT", slot: 1, rank: 1, player: { name: "DT1" } },
    { key: "dt", abbr: "DT", slot: 1, rank: 2, player: { name: "DT1 backup" } },
    { key: "dt", abbr: "DT", slot: 2, rank: 1, player: { name: "DT2" } },
    { key: "ncb", abbr: "NCB", slot: 1, rank: 1, player: { name: "Nickel" } },
  ];
  const pos = assembleUnit(entries, "defense");
  assert.strictEqual(Object.keys(pos).length, 3, "two DT starters + one NCB = 3 positions");
  assert.strictEqual(pos["dt__1"].cat, "DL");
  assert.strictEqual(pos["dt__1"].spots[0].players.length, 2, "starter + backup in one spot");
  assert.strictEqual(pos["ncb__1"].cat, "NB", "NCB bucketed as nickel, not corner");
});

test("splitIntoSpots splits multi-starter groups into columns", () => {
  const rows = [
    { depth_team: "1", n: "WR1" }, { depth_team: "1", n: "WR2" }, { depth_team: "1", n: "WR3" },
    { depth_team: "2", n: "WR4" }, { depth_team: "2", n: "WR5" },
  ];
  const spots = splitIntoSpots(rows, (r, rank) => ({ name: r.n, rank }));
  assert.strictEqual(spots.length, 3, "three 1st-stringers -> three spots");
  assert.strictEqual(spots[0].players[0].name, "WR1");
  assert.strictEqual(spots[0].players.length, 2, "backups distributed round-robin");
});
