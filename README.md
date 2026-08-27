# Depth Charts — all sports, one site 🏟️

Two teams' **starting lineups** on the field / ice / court / pitch, live from ESPN.
Click any player for the **full depth chart** behind them. One small Node server
(no dependencies) serves every sport by route:

| Route | Sport | View |
|-------|-------|------|
| `/`     | Landing | Pick a sport |
| `/nfl`  | 🏈 NFL | Offense vs defense on the field — personnel packages, formations, past seasons (2020+), Madden OVR, special teams |
| `/nhl`  | 🏒 NHL | Starting lines on the rink (ranked by last season's production) |
| `/nba`  | 🏀 NBA | Starting five on the court (ESPN's real depth chart) |
| `/mls`  | ⚽ MLS | Real starting XI in its most recent formation, on the pitch |
| `/cfb`  | 🎓 College FB | Coming soon — see **CFB status** below |

## Run it

Node 20+ (no `npm install` needed — zero dependencies):

```bash
npm start
```

Then open **http://localhost:3000**.

## How it works

- **`server.js`** — one HTTP server (gzip, ETag caching, security headers, per-IP
  rate limiting, disk last-good fallback). Routes pages (`/nfl` … `/mls`) and two
  API surfaces:
  - **NFL:** `GET /api/depth?team=&year=&fresh=` and `GET /api/ages?ids=&year=`
  - **Others:** `GET /api/config?sport=` and `GET /api/lineup?sport=&team=&fresh=`
  - `GET /healthz`
- **`lib/nfl.js`** — the NFL engine (ESPN live + nflverse history + EA Madden).
- **`lib/espn.js`** — the shared engine for NHL/NBA/MLS (three lineup builders:
  `depth` = ESPN's ranked chart, `match` = last match's XI/formation for soccer,
  `statrank` = roster ranked by production for hockey).
- **`sports/{nhl,nba,mls}.js`** — small per-sport configs.
- **`public/`** — `index.html` (landing), `nfl/` (the NFL app), `surface/` (the
  NHL/NBA/MLS app), plus shared `nav.js` + `shared.css`.

## Deploying (your accounts, your logins)

One free service covers the whole site:

1. Create an empty GitHub repo (e.g. `depth-charts`).
2. Push this folder to it (SSH already set up on this machine).
3. In Render: **New ▸ Blueprint** → pick the repo → **Apply** (reads `render.yaml`).
   Free plan, no payment.
4. Point a domain (e.g. `depthchart.com`) at it in Cloudflare (free), same as the
   Bills site.

## Data notes

All data is ESPN's public JSON (no key). Honest caveats:
- **NBA/MLS** — real starters (NBA depth chart / MLS last-match XI).
- **NHL** — ESPN's hockey depth feed is broken (returns retired players), so lines
  are **projected from last season's production**; real players + stats, labeled.
- **CFB** — ESPN has no CFB depth API, and CollegeFootballData has no depth chart
  (its usage data is offense-skill-only). The one real source is ESPN's own CFB
  depth page (`cdn.espn.com`), which is blocked on the dev machine's corporate
  proxy — so it gets tested **after deploy** from Render. If it works, CFB ships;
  if not, it stays "coming soon" rather than fabricating a lineup.
