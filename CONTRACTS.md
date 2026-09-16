# CONTRACTS.md — the runtime data contracts

The shapes the server emits and the client consumes. These are **implicit** (no build step, no
schema library) — this file + [lib/types.js](lib/types.js) (JSDoc `@typedef`s) are the contract.
If you change a producer, change every consumer + the seeds + this doc. Guardrails live in
`test/extensibility.test.js` and `test/seeds.test.js`.

## 1. Surface envelope — `lib/espn.js buildLineup()` return, served by `GET /api/lineup`
```jsonc
{
  "sport": "nhl",            // cfg.key
  "surface": "rink",         // rink|court|pitch|diamond|field — client background + coord frame
  "dualUnit": true,          // two units on one screen (NHL lines, CFB off/def)
  "unit": "line1",           // which unit this payload is (null if single-unit)
  "ratingLabel": "EA FC",    // OVR badge label, or null (no ratings map for this league)
  "draftStatus": false,      // whether players carry a draft badge (college hockey)
  "season": null,            // non-null when showing a PAST season
  "team": { "abbr": "BUF", "name": "Sabres", "color": "…", "logo": "…" },
  "record": "…", "next": { … },      // W-L + next game (may be null)
  "formation": "4-3-3", "subtitle": "…",  // shown under the surface
  "updated": "<iso>",                 // freshness stamp
  "chips": [                          // the players placed on the surface
    {
      "key": "LW", "label": "Left Wing", "group": "Forwards",
      "x": 26, "y": 42,               // 0–100 % position on the surface
      "face": { /* Player */ },       // the on-surface starter
      "players": [ { /* Player */ }, … ]  // full depth at that spot (face is players[0] or the healthy pick)
    }
  ],
  "stale": true, "source": "seed"     // ONLY when served from seed/last-good (else absent)
}
```
`singleTeam` sports (MLB) send one team's chips across the whole surface; `dualUnit` sports send
one unit per request (the client fetches both).

## 2. NFL envelope — `lib/nfl.js makeEnvelope()`, served by `GET /api/depth`
```jsonc
{
  "team": "Buffalo Bills", "teamAbbr": "BUF",
  "season": 2026, "fetchedAt": "<iso>",
  "record": "…", "next": { … },
  "offense":      { "formation": "Offense",       "positions": { /* PositionGroups */ } },
  "defense":      { "formation": "Defense",        "positions": { … } },
  "specialTeams": { "formation": "Special Teams",  "positions": { … } },
  "stale": true, "source": "seed"     // ONLY when served from seed/last-good
}
// positions: { "<key>": { "abbr": "WR", "cat": "…"?, "spots": [ { "slot": 1, "players": [ /* Player */ ] } ] } }
```
A unit is `null` when it has no players. `getTeamData` refuses to persist/serve an envelope whose
offense **and** defense **and** specialTeams are all null (silent-drift guard).

## 3. Player object (both envelopes; fields vary by sport)
```jsonc
{
  "rank": 1, "id": "3918298",      // ESPN athlete id (headshot/profile derived from it client-side)
  "name": "Josh Allen", "jersey": "17",
  "pos": "QB",                     // surface only
  "overall": 92,                   // video-game OVR, or null
  "age": 29,                       // OR "classYear":"SR" for college (classYears sports)
  "height": "6' 5\"", "weight": "237 lbs", "college": "Wyoming",
  "exp": 8,                        // years pro (NFL), or null
  "injury": "Questionable", "injuryDetail": { … },   // when ESPN reports one
  "extra": "…",                    // sport-specific bio line (from cfg.bio())
  "draft": { … }                   // NHL-draft badge (draftStatus sports)
}
```
**Headshots/profile URLs are NOT in the payload** — the client rebuilds them from `id` +
`CONFIG.webSlug` (`photoFor`/`espnFor` in `surface/app.js`). Don't re-add them (they were ~40% of
the payload).

## 4. Public config island — `publicConfig()`, served by `GET /api/config` + inlined as `#sdc-config`
`{ sport, name, emoji, title, tagline, webSlug, surface, note, defaults, dualUnit, singleTeam,
history, seasonEndYear, formations, formationMode, unitFormations, unitFormationLabels, units,
unitLabels, teams:[{ id, name, conf }] }`. Only fields the client reads — team abbr/color/logo come
from the lineup payload, not here.

## 5. `/api` surface
| Route | Returns |
|-------|---------|
| `GET /api/depth?team=&year=&fresh=` | NFL envelope (§2) |
| `GET /api/lineup?sport=&team=&unit=&year=&formation=&fresh=` | surface envelope (§1) |
| `GET /api/config?sport=` | public config (§4) |
| `GET /api/player-stats?sport=&id=&year=` | `{ line: [{ k, v }] }` (lazy stat line; `{line:[]}` = none) |
| `GET /api/ages?ids=&year=` | `{ <id>: age }` (NFL only) |
| `GET /healthz` (`?strict=1`) | health JSON; plain always 200, strict 503 when degraded |
| `POST /api/metric` · `GET /api/metrics-summary` | first-party analytics (see lib/metrics.js) |

`?fresh=1` bypasses the cache; it is a distinct edge-cache key. Every JSON response is
memoized + ETag'd + gzip-6/brotli-6 by `sendCachedJson`.
