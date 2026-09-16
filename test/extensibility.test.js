// Extensibility guardrails for a context-free successor (human or AI). These are the
// invariants that a well-meaning edit — adding a sport, tweaking a config, editing a shell —
// would otherwise break SILENTLY (server.js skips a bad config; a missing route just 404s).
// All network-free + committed-data-only, so they run under `npm test` / `node --test` in CI.
// See CONTRIBUTING.md and sports/README.md for the human-readable version of these rules.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SPORTS_DIR = path.join(ROOT, "sports");
// Config files are every sports/*.js EXCEPT underscore-prefixed helpers (_soccer.js factory).
const sportFiles = fs.readdirSync(SPORTS_DIR).filter((f) => f.endsWith(".js") && !f.startsWith("_"));
const KINDS = ["match", "statrank", "boxstart", "roster", "depth"]; // the arms buildLineup dispatches on (lib/espn.js)

test("zero-dependency invariant: package.json declares no runtime/dev deps", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.strictEqual(Object.keys(pkg.dependencies || {}).length, 0, "no `dependencies` — this site must stay zero-dependency (no npm install, no supply chain)");
  assert.strictEqual(Object.keys(pkg.devDependencies || {}).length, 0, "no `devDependencies` either");
});

test("every sports/*.js config is structurally valid (else server.js silently skips it)", () => {
  assert.ok(sportFiles.length >= 16, "expected at least the 16 shipping surface sports");
  for (const f of sportFiles) {
    const key = f.slice(0, -3);
    const cfg = require(path.join(SPORTS_DIR, f));
    const ids = new Set((cfg.teams || []).map((t) => String(t.id)));
    const m = (msg) => `${f}: ${msg}`;
    assert.strictEqual(cfg.key, key, m("`key` must equal the filename (routes/OG/loader key off it)"));
    for (const s of ["name", "emoji", "title", "tagline", "surface"]) assert.ok(cfg[s] && typeof cfg[s] === "string", m(`\`${s}\` must be a non-empty string`));
    assert.ok(cfg.espn && cfg.espn.sport && cfg.espn.league, m("`espn.sport` + `espn.league` required (upstream slug)"));
    assert.ok(KINDS.includes(cfg.kind), m(`\`kind\` must be one of ${KINDS.join("|")} (got ${JSON.stringify(cfg.kind)})`));
    assert.ok(cfg.defaults && cfg.defaults.a != null, m("`defaults.a` required (the landing matchup)"));
    assert.ok(ids.has(String(cfg.defaults.a)), m(`\`defaults.a\` (${cfg.defaults.a}) must be an id in \`teams\``));
    if (cfg.defaults.b != null) assert.ok(ids.has(String(cfg.defaults.b)), m(`\`defaults.b\` (${cfg.defaults.b}) must be an id in \`teams\``));
    assert.ok(Array.isArray(cfg.teams) && cfg.teams.length > 0, m("`teams` must be a non-empty array"));
    assert.ok(cfg.teams.every((t) => t && t.id != null && t.name), m("every team needs `id` + `name`"));
    assert.strictEqual(typeof cfg.bio, "function", m("`bio(athlete)` must be a function"));
    if (cfg.kind === "boxstart" || cfg.kind === "roster") assert.strictEqual(typeof cfg.bucket, "function", m(`\`bucket(pos)\` required for kind="${cfg.kind}"`));
    if (cfg.dualUnit) {
      assert.ok(Array.isArray(cfg.units) && cfg.units.length === 2, m("dualUnit needs `units` (2)"));
      assert.ok(Array.isArray(cfg.unitLabels) && cfg.unitLabels.length === 2, m("dualUnit needs `unitLabels` (2)"));
    }
    if (cfg.kind === "roster" && cfg.dualUnit) {
      assert.ok(cfg.layouts && cfg.layouts.offense && cfg.layouts.defense, m("dual-unit roster (CFB) needs `layouts.offense` + `layouts.defense`"));
      assert.ok(cfg.packages, m("dual-unit roster (CFB) needs `packages`"));
    }
    // Every sport needs SOME field placement, except soccer (`match`) which the client lays out.
    assert.ok(cfg.layout || cfg.layouts || cfg.kind === "match", m("needs `layout` or `layouts` (or kind=match)"));
  }
});

test("every surface sport is fully wired in server.js (SURFACE loader + PAGE_ROUTE + OG)", () => {
  const srv = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const loader = srv.slice(srv.indexOf("const SURFACE"), srv.indexOf("const SURFACE") + 500);
  for (const f of sportFiles) {
    const key = f.slice(0, -3);
    assert.ok(new RegExp(`"${key}"`).test(loader), `server.js SURFACE loader list is missing "${key}"`);
    assert.ok(srv.includes(`"/${key}":`), `server.js PAGE_ROUTES is missing "/${key}"`);
    assert.ok(new RegExp(`\\n\\s*${key}:\\s*\\{`).test(srv), `server.js OG map is missing a "${key}:" entry`);
  }
});

test("HTML shells keep the strict-CSP discipline: no inline <script>/<style>/on*= handlers", () => {
  const shells = ["index.html", "nfl/index.html", "surface/index.html", "dashboard/index.html"]
    .map((p) => path.join(ROOT, "public", p)).filter((p) => fs.existsSync(p));
  assert.ok(shells.length >= 3, "expected the landing + nfl + surface shells");
  for (const p of shells) {
    const html = fs.readFileSync(p, "utf8");
    // A <script> is allowed ONLY with a src= (external, CSP 'self') or as a JSON data island.
    const scriptTags = html.match(/<script\b[^>]*>/gi) || [];
    for (const tag of scriptTags) {
      const ok = /\bsrc=/.test(tag) || /type=["']application\/(ld\+)?json["']/.test(tag);
      assert.ok(ok, `${path.relative(ROOT, p)}: inline <script> without src is forbidden by the strict CSP → ${tag}`);
    }
    assert.ok(!/<style\b/i.test(html), `${path.relative(ROOT, p)}: inline <style> in the static shell (critical CSS is injected server-side with a matching CSP hash — don't hand-add one)`);
    assert.ok(!/\son[a-z]+\s*=/i.test(html), `${path.relative(ROOT, p)}: inline event handler (on*=) is forbidden by the strict CSP`);
  }
});
