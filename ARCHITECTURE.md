# ARCHITECTURE.md — how a request becomes a rendered lineup

The detailed map behind [CLAUDE.md](CLAUDE.md). Data shapes are in [CONTRACTS.md](CONTRACTS.md);
the config schema is in [sports/README.md](sports/README.md).

## Data flow

```
                 browser
                    │  GET /nfl , /nhl , /api/depth?… , /api/lineup?sport=…
                    ▼
   ┌──────────────────────────────────────────────────────────────┐
   │ server.js  (one zero-dep http.createServer)                    │
   │  • PAGE_ROUTES  → renderPage() → inject <!--HEAD--> (title/OG/  │
   │                    critical <style> + config island) → shell   │
   │  • /api/depth   → nfl.getTeamData(teamId, year, fresh)          │
   │  • /api/lineup  → getLineup() → espn.buildLineup(cfg, …)        │
   │  • /api/config  → publicConfig(sport)                           │
   │  • /api/player-stats , /api/ages , /healthz , /api/metric       │
   └───────────────┬───────────────────────────────┬────────────────┘
                   │ NFL flagship                   │ every other sport
                   ▼                                ▼
   ┌───────────────────────────┐    ┌──────────────────────────────────────┐
   │ lib/nfl.js                │    │ lib/espn.js  buildLineup(cfg,…)        │
   │ getTeamData→buildTeamData │    │  dispatch on cfg.kind:                 │
   │  past → data/seed snapshot│    │   match    → resolveMatchLineup        │
   │  cur  → ESPN live          │    │   statrank → resolveStatRankedLineup   │
   │  +EA Madden OVR (live)     │    │   boxstart → resolveBoxStartLineup     │
   │  nflverse CSV = fallback   │    │   roster   → resolveRosterLineup       │
   │ → makeEnvelope()           │    │   depth    → resolveDepthLineup (dflt) │
   └───────────────┬───────────┘    └───────────────┬──────────────────────┘
                   │                                 │  + ratings (lib/ratings.js) + draft (lib/draft.js) attach
                   ▼                                 ▼
             ┌───────────────────────────────────────────────┐
             │ envelope (see CONTRACTS.md) → sendCachedJson()  │
             │  WeakMap memo · ETag · gzip-6/brotli-6 · s-maxage│
             └───────────────────────┬───────────────────────┘
                                     ▼
                     public/{nfl,surface}/app.js render;
                     headshots rebuilt from id + CONFIG.webSlug
```

Resilience layers wrap the build path (`lib/espn.js` + `lib/nfl.js`): a per-key in-memory cache
with cap+TTL and single-flight coalescing; a disk **last-good** copy (`os.tmpdir`) and a committed
**seed** (`data/seed/`) served (flagged `stale`) when upstream fails; and a rolling drift ring
(`recordBuild`/`recentUpstream`) feeding `/healthz?strict=1`.

## Module ownership

| Path | Owns |
|------|------|
| `server.js` | HTTP, routing, strict CSP + security headers, response cache/compression, page render, `/healthz`, rate-limit |
| `lib/espn.js` | Surface engine (`buildLineup` + the 5 `resolve*Lineup` builders), `fetchText`/`fetchJson`, `cached()`, disk+seed fallback, drift ring, `safeKey`/`lineupKey` |
| `lib/nfl.js` | NFL engine (`getTeamData`→`makeEnvelope`), ESPN live + nflverse history + pre-baked seeds + EA Madden |
| `lib/ratings.js` | Video-game OVR name-matcher (reads committed `data/ratings/*.json`) |
| `lib/metrics.js` | First-party analytics (bounded, `/api/metric` → `/dashboard`) |
| `lib/draft.js` | NHL-draft badge map (college hockey) |
| `lib/nfl-util.js` | Pure NFL helpers (CSV parse, name-normalize, unit assembly) — unit-tested |
| `sports/*.js` | One per-sport config each; `_soccer.js` is the shared league factory; `_template.js` is the starter |
| `scripts/gen-*.js` | Offline data generators (see scripts/README.md) |
| `public/{index,nfl,surface,dashboard}` | The HTML shells + client apps; `sw.js` service worker; `nav.js`/`common.js`/`shared.css` shared |
| `data/{teams,seed,ratings,draft}` | Committed static data (team lists, cold-start seeds, OVR maps, draft map) |

## `cfg.kind` → builder (lib/espn.js)

| kind | builder | source | sports |
|------|---------|--------|--------|
| `match` | `resolveMatchLineup` | typical XI + formation from recent completed matches | MLS + all soccer leagues |
| `statrank` | `resolveStatRankedLineup` | roster ranked by last-season production | NHL |
| `boxstart` | `resolveBoxStartLineup` | typical starters from recent box scores (`boxFallback` when thin) | NBA, WNBA |
| `roster` | `resolveRosterLineup` | roster by position/class — **not** verified starters | CFB, CBB, College Hockey |
| `depth` | `resolveDepthLineup` (default) | ESPN's published ranked depth chart | MLB |

NFL is its own engine (`lib/nfl.js`), not a `kind`.

## The two envelope shapes (summary — full fields in CONTRACTS.md)
- **NFL** (`makeEnvelope`): `{ team, teamAbbr, season, offense, defense, specialTeams }`, each unit
  `{ formation, positions: { <key>: { abbr, spots:[{ slot, players:[…] }] } } }`.
- **Surface** (`buildLineup` return): `{ sport, surface, dualUnit, unit, ratingLabel, draftStatus,
  season, team, chips:[{ key, label, group, x, y, face, players:[…] }], … }`.

Both may carry `stale: true` + `source` when served from seed/last-good.
