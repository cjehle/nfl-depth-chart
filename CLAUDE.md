# CLAUDE.md — start here (auto-loaded by Claude Code)

You are looking at a **zero-dependency Node HTTP server** that renders **starting lineups &
depth charts** for the NFL + 16 other sports, live from ESPN, at **billsdepthchart.com**. This
file is the 5-minute mental model. Deep detail lives in the docs indexed at the bottom.

> **⚠️ This site is effectively unpatchable — the original owner has stepped away.** It is
> built to run untouched for years. **Prefer additive changes. Run `npm test` before any
> deploy. DOCUMENT coupling rather than refactor it.** A clever refactor that breaks prod is
> unrecoverable; a doc or a test is free. When in doubt, don't.

## 60-second model: there are TWO engines
- **`lib/nfl.js`** — the NFL flagship. `getTeamData(teamId, year, fresh)` → an *envelope*
  (`makeEnvelope`). Sources, in order: pre-baked committed snapshot for **past** seasons
  (`data/seed/nfl_<team>_<year>.json`), live **ESPN** for the current season, live **EA Madden**
  for OVR badges, `nflverse` (github CSV) only as a fallback for unbaked past seasons.
- **`lib/espn.js`** — the shared engine for **every other sport**. `buildLineup(cfg, team, unit,
  season, formation)` dispatches on **`cfg.kind`**: `match` (soccer XI from recent matches) ·
  `statrank` (NHL lines by production) · `boxstart` (NBA/WNBA five from box scores) · `roster`
  (college by class) · `depth` (ESPN's ranked chart — MLB, default arm).
- **`server.js`** — one zero-dep HTTP server that routes both, applies the strict CSP + cache,
  and serves the pages. A sport is just a config object in `sports/<key>.js`.

## Request → build → envelope → client (the whole flow)
`http.createServer` → route dispatch (`PAGE_ROUTES` for HTML; `/api/depth`→`nfl.getTeamData`,
`/api/lineup`→`getLineup`→`buildLineup`, `/api/config`→`publicConfig`, `/api/player-stats`,
`/healthz`) → an **envelope** (see `CONTRACTS.md`) → `sendCachedJson` (WeakMap memo + ETag +
gzip-6/brotli-6 + `s-maxage`) → `public/{nfl,surface}/app.js` render it (headshots are rebuilt
client-side from player `id` + `CONFIG.webSlug`, not shipped in the payload).

## HARD INVARIANTS — do not break these
1. **Zero runtime dependencies.** `package.json` has no `dependencies`/`devDependencies`. No
   `npm install`, no build step (`render.yaml` build is a no-op). Locked by `test/extensibility.test.js`.
2. **Strict CSP, no inline JS.** The one inline `<style>` (critical CSS) is allowed only because
   its sha256 (`CRITICAL_CSS_HASH`) is computed from the exact string at module load and added to
   `style-src`. Never hand-edit served CSS without letting that recompute; never add an inline
   `<script>`/`on*=` handler to a shell. Locked by `test/extensibility.test.js`.
3. **Bump `VERSION` in `public/sw.js`** on ANY change under `public/` (it's the service-worker
   cache key). Server-only changes don't need it. (OPERATIONS.md §2)
4. **No hardcoded years/editions.** Season/edition math derives from the clock (a hardcoded year
   is a time-bomb — see the `mlb26` history in OPTIMIZATIONS/§13a).
5. **Seed filenames must match the runtime key** (`safeKey`/`lineupKey` in `lib/espn.js`). Locked
   by `test/seeds.test.js`.
6. **Every cache Map has a cap or TTL.** Don't add an unbounded store.
7. **Never fabricate data.** When a real lineup can't be built, degrade honestly (stale banner /
   "roster by position, not verified starters") — never pass invented data off as real.

## Deploy topology (one paragraph — full steps in OPERATIONS.md §1/§1a)
Two repos: you edit **Source** (`Sports Depth Charts/`, no git remote) → `rsync` to **Deploy**
(`…/nfl-depth-chart/`, the GitHub repo) → push → Render auto-deploys → Cloudflare fronts it.
**Never clobber the Deploy copies of `render.yaml`, `data/ratings/`, `data/seed/`, or `.github/`**
(the cron regenerates those). Verify live on the `onrender.com` mirror, not the custom domain.

## Gotchas that bite newcomers
- Adding a sport touches **several files**, and a broken config is **silently skipped** (server
  wraps each `require` in try/catch). Follow `OPERATIONS.md §9` + run `test/extensibility.test.js`.
- `/healthz` always returns 200; `/healthz?strict=1` is the one that flags degradation.
- The NFL and surface engines are **separate** — a fix in one is not automatically in the other.

## Doc index — read the one you need
| File | For |
|------|-----|
| **HANDOFF.md** | The 3 account-only actions to keep the site alive (owner handoff) |
| **ARCHITECTURE.md** | The detailed data-flow map + module ownership + `kind`→builder table |
| **CONTRACTS.md** | The exact envelope shapes, player object, `/api` surface, client seam |
| **sports/README.md** | The per-sport config schema, field by field, with a per-`kind` recipe |
| **scripts/README.md** | The offline data generators: what each consumes/emits + when to run |
| **CONTRIBUTING.md** | The pre-edit checklist (the invariants above, expanded) |
| **OPERATIONS.md** | The full runbook: deploy, env vars, crons, monitoring, add-a-sport |
| **DURABILITY.md** | Why it survives untouched + the known coupling catalog |
| **OPTIMIZATIONS.md** | The performance change log |
