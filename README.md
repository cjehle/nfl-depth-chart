# Depth Charts — all sports, one site 🏟️

Two teams' **starting lineups** on the field / ice / court / pitch, live from ESPN.
Click any player for the **full depth chart** behind them. One small Node server
(zero dependencies, no build step) serves every sport by route.

> **Operating, deploying, or handing this site off?** Read **[OPERATIONS.md](OPERATIONS.md)** —
> it is the authoritative runbook (two-repo topology, deploy steps + no-clobber list,
> environment variables, crons, monitoring, turning on ads, adding a sport, and the
> things only the account owner can do). **[DURABILITY.md](DURABILITY.md)** and
> **[OPTIMIZATIONS.md](OPTIMIZATIONS.md)** cover the "runs for years untouched" design
> and the performance work.

## Sports

| Route | Sport | View |
|-------|-------|------|
| `/`     | Landing | Pick a sport; a "Jump back in" strip deep-links to teams you've opened |
| `/nfl`  | 🏈 NFL | Offense vs defense on the field — personnel packages, formations, past seasons (2020+), Madden OVR, special teams |
| `/mlb`  | ⚾ MLB | Lineup + rotation, with MLB The Show OVR |
| `/nba`  | 🏀 NBA | Starting five on the court (ESPN's real depth chart) |
| `/wnba` | 🏀 WNBA | Starting five on the court |
| `/nhl`  | 🏒 NHL | Starting lines on the rink (ranked by last season's production) |
| `/mls`  | ⚽ MLS | Real starting XI in its most recent formation, on the pitch |
| `/cfb`  | 🎓 College FB | Offense vs defense (ESPN's CFB depth page) |
| `/cbb`  | 🎓 College BB | Starting five |
| `/mch`  | 🎓 College Hockey | Starting lines |
| soccer  | ⚽ EPL · La Liga · Bundesliga · Serie A · Ligue 1 · Liga MX · NWSL · Champions League | Starting XI + formation, under the **Intl Soccer** nav folder |

Each sport is one small config in `sports/*.js`; adding a sport is a config file plus a
committed seed (see OPERATIONS.md → "Add a sport").

## Run it

Node 20+ (no `npm install` — zero dependencies):

```bash
npm start
```

Then open **http://localhost:3000**. Tests:

```bash
npm test
```

## How it works

- **`server.js`** — one HTTP server (gzip/brotli, ETag + in-memory JSON cache, strict
  CSP + security headers, per-IP rate limiting, disk last-good fallback, background
  prewarm). Routes the pages and the API surfaces:
  - **NFL:** `GET /api/depth?team=&year=&fresh=` and `GET /api/ages?ids=&year=`
  - **Others:** `GET /api/config?sport=` and `GET /api/lineup?sport=&team=&fresh=`
  - **Shared:** `GET /api/player-stats?sport=&id=&year=`, `GET /healthz` (add
    `?strict=1` for the monitored deep check), `/api/metric` + `/api/metrics-summary`
    + `/dashboard` (first-party analytics).
- **`lib/nfl.js`** — the NFL engine (ESPN live + nflverse history + EA Madden).
- **`lib/espn.js`** — the shared engine for every surface sport (lineup builders:
  `depth` = ESPN's ranked chart, `match` = last match's XI/formation for soccer,
  `statrank` = roster ranked by production for hockey).
- **`lib/metrics.js`** — bounded, first-party analytics (no third party).
- **`sports/*.js`** — one small per-sport config each.
- **`scripts/gen-*.js`** — offline generators for team lists, video-game rating maps,
  draft data, and the committed default-lineup **seeds** (the durable cold-start
  fallback). All self-guard against overwriting good data with a bad pull.
- **`public/`** — `index.html` (landing), `nfl/` (the NFL app), `surface/` (every
  other sport), the shared `nav.js` / `shared.css` / `common.js`, `metrics.js`,
  `ads.js` (dormant unless configured), and `sw.js` (offline app-shell + last-lineup
  service worker).

## Hosting

Runs on Render's free plan (one service, reads `render.yaml`) behind Cloudflare, at
**billsdepthchart.com** (Render mirror: **nfl-depth-chart.onrender.com**). The public URL
is env-driven (`SITE_URL`). Full setup, the source→deploy topology, and the automated
monthly data refresh are in **[OPERATIONS.md](OPERATIONS.md)**.

## Data notes

All data is ESPN's public JSON (no key). Honest caveats:
- **NBA/WNBA/MLS/soccer** — real starters (depth chart / last-match XI).
- **NHL / College Hockey** — ESPN's hockey depth feed returns retired players, so lines
  are **projected from last season's production**; real players + stats, labeled as such.
- **CFB/CBB** — ESPN's college depth pages, tested from Render (the dev machine's
  corporate proxy blocks `cdn.espn.com`). A sport ships only when it builds a real
  lineup — never a fabricated one — otherwise it falls back to its committed seed.
- **OVR badges** — video-game overalls (Madden / MLB The Show / EA FC), refreshed
  monthly and matched by name; a badge is shown only when the match is unambiguous.
