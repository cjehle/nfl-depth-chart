# sports/ — the per-sport config schema

Each `sports/<key>.js` exports one config object. `server.js` loads a fixed list of them into
`SURFACE` (a broken/invalid config is **silently skipped**, so validate with
`node --test test/extensibility.test.js`). `_soccer.js` is a shared factory for soccer leagues;
`_template.js` is a fully-commented starter — **copy it** to add a sport. To wire a new sport up,
see [OPERATIONS.md §9](../OPERATIONS.md). NFL is a separate engine and is **not** configured here.

## Fields

### Identity (required)
| Field | Type | Notes |
|-------|------|-------|
| `key` | string | **Must equal the filename** (`sports/<key>.js`). Routes, OG, loader all key off it. |
| `name` `emoji` `title` `tagline` | string | Display copy (nav, H1, OG). |
| `surface` | string | `rink` \| `court` \| `pitch` \| `diamond` \| `field` — client background + coordinate frame. |
| `espn` | `{ sport, league }` | ESPN API slugs, e.g. `{ sport:"basketball", league:"nba" }`. |
| `kind` | string | Selects the builder — one of `match` \| `statrank` \| `boxstart` \| `roster` \| `depth`. See recipe below. |
| `defaults` | `{ a, b }` | The landing matchup. `a` required; both **must be ids present in `teams`**. |
| `teams` | array | `[{ id, name, conf?, abbr?, color? }]` — usually `require("../data/<key>-teams.json")`. Non-empty. |
| `bio` | `(athlete) => ({ extra, pos })` | Maps an ESPN athlete to the popover bio line. |

### Placement (required except `kind:"match"`)
| Field | Type | Notes |
|-------|------|-------|
| `layout` | array | Single-unit spots: `{ key, label, posKey?, bucket?, faceRank?, group, x, y }`. `x`/`y` are 0–100 %. `posKey` feeds depth/statrank; `bucket`+`faceRank` feed box-score/roster. |
| `layouts` | `{ offense, defense }` | Dual-unit **roster** sports (CFB) — one layout per unit. |
| soccer (`match`) | — | No layout; `placeStarters()` lays out the pitch from the formation. |

### Builder-specific (required where noted)
| Field | Required for | Notes |
|-------|-------------|-------|
| `bucket` | `boxstart`, `roster` | `(pos) => "guard"|"forward"|…|null` — maps a position code to a group; `null` drops it. |
| `boxFallback` | (optional, `boxstart`) | `"depth"` → fall back to the ESPN depth chart when box data is thin (offseason). |
| `packages` `layouts` `unitFormations` `unitFormationLabels` | dual-unit `roster` (CFB) | Per-unit formation packages the client can pick. |

### Common optional flags
| Field | Effect |
|-------|--------|
| `history: true` | Offer a past-season selector (supported by `match`/`boxstart`/`depth`). |
| `singleTeam: true` | Show ONE team across the whole surface (MLB diamond). |
| `seasonEndYear: true` | ESPN labels this sport's season by its END year (NBA 2027 = 2026-27). |
| `dualUnit: true` + `units:[…2…]` + `unitLabels:[…2…]` | Two units on one screen (NHL lines, CFB off/def). |
| `formations:[…]` + `formationMode` | A formation dropdown; `formationMode` = `court` (client re-places) \| `server` (server re-arranges) \| `unit` (per-unit packages). |
| `classYears: true` | College — players carry FR/SO/JR/SR instead of age. |
| `defaultVsNext: true` | On a brand-new visit, open team A against its **next scheduled opponent** (from `next.oppId`) instead of the static `defaults.b`. Falls back to `defaults.b` in the offseason; never overrides a returning visitor's saved matchup. (Two-team sports only.) |
| `note` / `rosterLabel` | Legend line / honesty label when it's not a verified lineup. |

## Per-`kind` minimum recipe
- **`match`** (soccer): identity + `defaults` + `teams` + `bio`. No `layout`/`bucket`. Usually built via `_soccer.js`. `history` typical, `formations` optional.
- **`statrank`** (NHL): identity + `layout` + `defaults` + `teams` + `bio`. Usually `dualUnit` (`units:["line1","line2"]`).
- **`boxstart`** (NBA/WNBA): identity + `layout` + **`bucket`** + `defaults` + `teams` + `bio`. `boxFallback:"depth"` optional, `seasonEndYear` if applicable.
- **`roster`** (CBB/College Hockey): identity + `layout` + **`bucket`** + `classYears:true` + `defaults` + `teams` + `bio`. Dual-unit roster (CFB) adds `units`/`unitLabels`/`layouts`/`packages`/`unitFormations`.
- **`depth`** (MLB): identity + `layout` (with `posKey`) + `defaults` + `teams` + `bio`. `singleTeam`/`history` as applicable.

The public, client-visible subset of a config is whatever `publicConfig()` in `server.js` forwards
(see [CONTRACTS.md §4](../CONTRACTS.md)) — everything else (`bucket`, `bio`, `layout`, `packages`)
is server-only.
