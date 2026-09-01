// Tests for cached() — the process-wide caching primitive behind every lineup/stat
// response — and its evict() cap. Two invariants here are operational, not cosmetic:
//   • no-negative-caching: a thrown fn must NOT be stored (else an error poisons the
//     key and every future request replays the failure).
//   • bounded eviction: the store can't grow without bound (OOM on the 512MB tier).
// Plus SWR: a stale-but-present value is served instantly while a single-flight
// rebuild runs, and a FAILED rebuild retains the stale value. All network-free.
const test = require("node:test");
const assert = require("node:assert");
const { cached } = require("../lib/espn.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("single-flight: concurrent cold misses share ONE build", async () => {
  const store = new Map();
  let calls = 0;
  const fn = async () => { calls++; await sleep(20); return "v" + calls; };
  const [a, b, c] = await Promise.all([
    cached(store, "k", 1000, fn), cached(store, "k", 1000, fn), cached(store, "k", 1000, fn),
  ]);
  assert.equal(calls, 1, "fn must run exactly once for a burst");
  assert.equal(a, "v1"); assert.equal(b, "v1"); assert.equal(c, "v1");
});

test("fresh hit is served from cache without rebuilding", async () => {
  const store = new Map();
  let calls = 0;
  const fn = async () => { calls++; return "x"; };
  await cached(store, "k", 1000, fn);
  await cached(store, "k", 1000, fn);
  assert.equal(calls, 1);
});

test("no negative caching: a thrown fn is not stored and the next call retries", async () => {
  const store = new Map();
  let calls = 0;
  const fn = async () => { calls++; if (calls === 1) throw new Error("boom"); return "ok"; };
  await assert.rejects(() => cached(store, "k", 1000, fn), /boom/);
  assert.equal(store.has("k"), false, "a failed cold build must leave no placeholder");
  assert.equal(await cached(store, "k", 1000, fn), "ok", "next call retries and succeeds");
  assert.equal(calls, 2);
});

test("stale-while-revalidate: expired value served instantly, refreshed in background", async () => {
  const store = new Map();
  let calls = 0;
  const fn = async () => { calls++; await sleep(30); return "gen" + calls; };
  assert.equal(await cached(store, "k", 20, fn), "gen1"); // cold build
  await sleep(40); // now stale (ttl 20ms)
  const t0 = Date.now();
  const v = await cached(store, "k", 20, fn); // must return the stale value immediately
  assert.equal(v, "gen1");
  assert.ok(Date.now() - t0 < 20, "stale serve must not block on the rebuild");
  assert.equal(calls, 2, "a background rebuild must have started");
  await sleep(60);
  assert.equal(store.get("k").value, "gen2", "background rebuild updated the store");
});

test("a FAILED background refresh keeps the stale value", async () => {
  const store = new Map();
  let calls = 0;
  const fn = async () => { calls++; await sleep(15); if (calls >= 2) throw new Error("down"); return "good"; };
  assert.equal(await cached(store, "k", 15, fn), "good");
  await sleep(25); // stale
  assert.equal(await cached(store, "k", 15, fn), "good", "stale served while the refresh runs");
  await sleep(40); // refresh rejects here
  assert.equal(store.get("k").value, "good", "the stale value must survive a failed refresh");
});

test("evict cap: store never exceeds the cap and the just-written key survives", async () => {
  const store = new Map();
  for (let i = 0; i < 8; i++) await cached(store, "k" + i, 100000, async () => "v" + i, 3);
  assert.ok(store.size <= 3, `size ${store.size} must be <= cap 3`);
  assert.ok(store.has("k7"), "the most-recently-written key must not be evicted");
});

test("eviction never orphans an in-flight build", async () => {
  const store = new Map();
  // Start a slow build, then pile on other keys under a tiny cap to force eviction
  // while it's still in flight; the in-flight promise must still resolve correctly.
  const slow = cached(store, "keep", 100000, async () => { await sleep(50); return "KEPT"; }, 2);
  for (let i = 0; i < 5; i++) await cached(store, "n" + i, 100000, async () => "n" + i, 2);
  assert.equal(await slow, "KEPT", "the in-flight build must not be dropped mid-flight");
});
