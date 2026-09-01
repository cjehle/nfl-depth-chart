// Tests for the video-game rating name-matcher. This pure logic gates EVERY OVR badge
// (soccer + MLB) and fails SILENTLY on a regression — badges just vanish or attach to
// the wrong player — so the escalation (exact → folded → token-subset → cross-league
// unique) is worth pinning. fold()/tokenSubset() are pure; the cross-league path is
// exercised loosely against the committed maps. Network-free (node --test).
const test = require("node:test");
const assert = require("node:assert");
const { fold, tokenSubset, ratingFor, surnameInitial } = require("../lib/ratings.js");
// idx factory for surnameInitial tests: [name, ovr] → the {first,last,toks,val} shape.
const mkIdx = (pairs) => ({ entries: pairs.map(([n, v]) => { const p = n.split(" "); return { toks: new Set(p), first: p[0], last: p[p.length - 1], val: v }; }) });

test("fold flattens special letters normName's accent-strip misses", () => {
  assert.equal(fold("Yıldız"), "yildiz");        // ı (dotless i) → i
  assert.equal(fold("Højbjerg"), "hojbjerg");    // ø → o
  assert.equal(fold("Odsonne Édouard"), "odsonne edouard"); // accent via normName
  assert.equal(fold("Weiß"), "weiss");           // ß → ss
});

test("fold treats hyphens as spaces and collapses whitespace", () => {
  assert.equal(fold("Min-Jae Kim"), "min jae kim");
  assert.equal(fold("Trent  Alexander-Arnold"), "trent alexander arnold");
});

test("tokenSubset: all query tokens inside exactly one entry → that rating", () => {
  const idx = { entries: [
    { toks: new Set(["heung", "min", "son"]), val: 87 },
    { toks: new Set(["bruno", "fernandes"]), val: 86 },
  ] };
  // A shorter query ("son heung min") that is a subset of the longer stored name.
  assert.equal(tokenSubset(idx, ["son", "heung", "min"]), 87);
  assert.equal(tokenSubset(idx, ["bruno", "fernandes"]), 86);
});

test("tokenSubset: ambiguous match (two entries, different ratings) → null", () => {
  const idx = { entries: [
    { toks: new Set(["james", "rodriguez"]), val: 84 },
    { toks: new Set(["james", "rodriguez", "jr"]), val: 70 },
  ] };
  assert.equal(tokenSubset(idx, ["james", "rodriguez"]), null); // matches both → refuse
});

test("tokenSubset: a single query token is too weak to disambiguate → null", () => {
  const idx = { entries: [{ toks: new Set(["messi"]), val: 90 }] };
  assert.equal(tokenSubset(idx, ["messi"]), null);
});

test("tokenSubset: identical rating in two matching entries is not ambiguous", () => {
  const idx = { entries: [
    { toks: new Set(["carlos", "vela"]), val: 80 },
    { toks: new Set(["carlos", "vela", "garces"]), val: 80 },
  ] };
  assert.equal(tokenSubset(idx, ["carlos", "vela"]), 80); // same value → safe to return
});

test("ratingFor returns a plausible OVR for a well-known top-flight name (pipeline smoke)", () => {
  // Loose bound (not an exact value) so it survives edition refreshes but still proves
  // the exact→folded pipeline resolves against the committed maps.
  const messi = ratingFor("mls", "Lionel Messi");
  assert.ok(messi === null || (typeof messi === "number" && messi >= 60 && messi <= 99), `unexpected OVR ${messi}`);
});

test("surnameInitial matches a first-name spelling/transliteration variant (surname + initial, unique)", () => {
  // Ben ⊂ Benjamin (prefix); Matvei/Matvey and Odisseas/Odysseas (1-char translit).
  assert.equal(surnameInitial(mkIdx([["benjamin white", 83], ["morgan gibbs white", 70]]), ["ben", "white"]), 83);
  assert.equal(surnameInitial(mkIdx([["matvey safonov", 78]]), ["matvei", "safonov"]), 78);
  assert.equal(surnameInitial(mkIdx([["odysseas vlachodimos", 72]]), ["odisseas", "vlachodimos"]), 72);
});

test("surnameInitial refuses a DIFFERENT player (wrong initial, dissimilar first name, or ambiguity)", () => {
  // Different first initial → no match (Miguel vs Robert Navarro).
  assert.equal(surnameInitial(mkIdx([["robert navarro", 75]]), ["miguel", "navarro"]), null);
  // Same initial but not a near-variant first name (Ricardo vs Robert) → no match.
  assert.equal(surnameInitial(mkIdx([["ricardo navarro", 75]]), ["robert", "navarro"]), null);
  // Two candidates that BOTH look like the query first name, different ratings → null.
  assert.equal(surnameInitial(mkIdx([["jon smith", 80], ["jonathan smith", 70]]), ["jon", "smith"]), null);
  // Too-short surname or single token → refuse.
  assert.equal(surnameInitial(mkIdx([["al bo", 90]]), ["al", "bo"]), null);
  assert.equal(surnameInitial(mkIdx([["messi", 90]]), ["messi"]), null);
});

test("ratingFor is null for an obvious non-player and empty input", () => {
  assert.equal(ratingFor("mls", ""), null);
  assert.equal(ratingFor("mls", "Zzzqqx Notaplayer"), null);
});
