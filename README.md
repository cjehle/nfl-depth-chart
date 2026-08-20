# 🏈 NFL Depth Chart — Starters on the Field

A web app that puts a team's **starting defense on top** and its **starting offense on the bottom**
of a football field, meeting at the line of scrimmage. Click any position for the full depth chart.
Data is **live** — lineups and injuries come straight from ESPN, so nothing is ever a stale snapshot.

Defaults to the **Buffalo Bills** on both sides, but you can set any matchup and browse past seasons.

## Features

- **Field or List view** — a diagram, or a keyboard/screen-reader-friendly list (default on phones).
- **Click / tap / Enter** any position → full depth chart popover with each player's **age** and an
  **OVR** rating (Madden — a free stand-in for PFF; PFF has no public API).
- **Drag players** around their half of the field (they can't cross the line of scrimmage); your
  arrangement is remembered. **Reset positions** clears it.
- **Offensive personnel** — 11 / 12 / 10 / 21 / 13.
- **Defensive formation** — Base / Nickel / Dime / Quarter-Prevent / Goal Line.
- **Season picker per side** — the current season plus real history back to 2020.
- **Team colors + logos**, injury badges, and a season label per side.
- **Shareable** — the whole matchup lives in the URL, so a bookmarked/pasted link restores the view.
- **Accessible** — keyboard-navigable chips, a real focus-trapped modal, WCAG-contrast colors,
  44px tap targets, `prefers-reduced-motion` support.

## Run it locally

Needs [Node.js](https://nodejs.org) 20+ (you have it via nvm). **No `npm install`** — zero
dependencies. From this folder:

```bash
node server.js
```

Then open `http://localhost:3000`. `Ctrl + C` to stop. Run the tests with:

```bash
npm test
```

## Make it a public website

See **[DEPLOY.md](DEPLOY.md)** — buy the domain, push to GitHub, deploy free on Render, point DNS.
(You do the account/payment clicks; the code is already configured via `render.yaml`.)

## How updates work

The app doesn't store data — every visit fetches current info and caches it briefly before
re-checking:

| Data | Re-checks | Env var |
|------|-----------|---------|
| Depth chart + injuries | daily | `DEPTH_TTL_HOURS` (24) |
| Madden ratings | monthly | `MADDEN_TTL_DAYS` (30) |

The **Refresh** button forces an immediate re-pull.

## About past seasons

ESPN only serves the *current* roster, so past seasons come from the open **nflverse** historical
depth charts (opening-week lineup for the year). Age is computed **as of that season** and labeled as
such. Historical **Madden** comes from that season's game where EA still serves it:

| Season | Depth chart | Madden |
|--------|-------------|--------|
| current | ESPN (live) | current game |
| 2025 | nflverse (newer format) | Madden 26 ✅ |
| 2024 | nflverse | — (EA endpoint empty) |
| 2021–2023 | nflverse | Madden 22–24 ✅ |
| 2020 | nflverse | — (EA endpoint down) |

Injuries are current-only; past seasons show none. When a rating isn't available the popup says so
rather than showing a wrong/current number.

## Endpoints

- `GET /api/depth?team=<id>&year=<season>&fresh=1` — tidy lineup JSON.
- `GET /api/ages?ids=1,2,3&year=<season>` — ages for a batch of players.
- `GET /healthz` — liveness + counters (no upstream calls; used by Render's health check).

## Files

| File | Job |
|------|-----|
| `server.js` | Web server: serves the page, fetches + merges + caches ESPN/nflverse/EA data. |
| `lib/util.js` | Pure helpers (CSV, name matching, ages, position mapping, lineup shaping). |
| `teams.js` | 32 teams + shared season constants (used by server **and** browser). |
| `public/index.html`, `public/style.css`, `public/app.js` | The page. |
| `test/util.test.js` | Unit tests for the pure helpers (`npm test`). |
| `render.yaml`, `DEPLOY.md` | Deploy config + step-by-step guide. |

## Notes

- Free hosting tiers sleep after ~15 min idle → the first visit after a lull takes ~30s to wake
  (and refreshes data), then it's fast. A free pinger hitting `/healthz` keeps it awake.
- The app is hardened for public use: security headers + CSP, gzip, ETag/304, per-IP rate limiting,
  request size caps, timeouts/retries, and a last-good disk cache so a brief upstream outage doesn't
  take the site down.
- Data sources are unofficial (ESPN, EA, nflverse). If one changes shape, that piece degrades to
  "—" and the rest keeps working.
