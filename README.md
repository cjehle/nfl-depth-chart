# 🏈 NFL Depth Chart — Starters on the Field

A little web app that puts a team's **starting defense** on the top of a football field and a
team's **starting offense** on the bottom, meeting at the line of scrimmage. **Click any position**
to see the full depth chart (the backups) behind that starter. Data comes **live from ESPN**, so
lineups and **injuries** stay current.

Each half shows the team's **color and logo** in its header band, plus a **"last updated"** time.
The offense is drawn as a **2-tight-end set** (no fullback). Hit **Refresh** to force a brand-new
pull from ESPN.

More dropdowns let you change the on-field grouping and the season:

- **Offensive personnel** — 11 (1 RB, 1 TE, 3 WR), 12 (1 RB, 2 TE, 2 WR), 10 (1 RB, 0 TE, 4 WR),
  21 (2 RB, 1 TE, 2 WR), 13 (1 RB, 3 TE, 1 WR).
- **Defensive formation** — Base (3-4 / 4-3), Nickel (5 DB), Dime (6 DB), Quarter / Prevent (7 DB),
  Goal Line (heavy front).
- **Season** (per side) — the current season, or any past season back to 2020.

### About past seasons
ESPN's API only serves the *current* roster (asking it for 2023 just returns today's team), so past
seasons come from the open **nflverse** historical depth charts. Each shows that team's opening-week
lineup for the year, and in a player's popup **age is computed as of that season** and clearly labeled.

Historical **Madden ratings** are shown too, from that season's Madden game:

| Season | Depth chart | Madden rating |
|--------|-------------|---------------|
| 2025 | nflverse (newer format) | Madden 26 (that season's game) ✅ |
| 2024 | nflverse | not available — EA endpoint is empty, shows "—" |
| 2023 | nflverse | Madden 24 ✅ |
| 2022 | nflverse | Madden 23 ✅ |
| 2021 | nflverse | Madden 22 ✅ |
| 2020 | nflverse | not available — EA endpoint is down, shows "—" |

**Injuries** are current-only (no historical version exists), so past seasons show none. When a rating
isn't available for a season, the popup says so rather than showing a wrong/current number.

ESPN only publishes each team's **base** depth chart, so the sub-packages are *constructed* by the
usual convention: for defense we drop linebackers and bring on the next defensive backs down the
chart (or, for goal line, extra linemen); for offense we field the right number of WRs / TEs / RBs
from each position's depth. Every grouping still adds up to 11 players.

You can also **drag players** to rearrange them — but each player is locked to its own half of the
field, so nobody can cross the line of scrimmage. Click **Reset positions** to snap everyone back.

Both team pickers start on the **Buffalo Bills** (Bills offense vs Bills defense), but you can set
any matchup, e.g. Bills offense vs Chiefs defense.

The controls are grouped into an **Offense row** and a **Defense row**, and the whole thing is
**mobile-friendly** — on a phone the controls stack and the field scrolls sideways so players stay
readable.

## How to run it

You need [Node.js](https://nodejs.org) (you already have it via nvm). There is **nothing to install** —
no `npm install`. From this folder:

```bash
node server.js
```

Then open your browser to:

```
http://localhost:3000
```

To stop the server, press `Ctrl + C` in the terminal.

## How updates work (important to understand)

This app is **live** — it does not store a snapshot of the data. Every time someone loads the page,
the server fetches the current depth chart, injuries, and ratings straight from ESPN and EA. To be
polite to those services, it remembers ("caches") each answer for a while before re-checking:

| Data | How often it re-checks | Controlled by |
|------|------------------------|---------------|
| Team depth-chart changes | daily | `DEPTH_TTL_HOURS` (default 24) |
| Injuries | daily (same fetch as depth chart) | `DEPTH_TTL_HOURS` (default 24) |
| Madden ratings | monthly | `MADDEN_TTL_DAYS` (default 30) |

So the live site refreshes itself on that schedule automatically — no database, no manual step. The
**Refresh** button forces an immediate re-pull any time. (Team changes and injuries share one window
because ESPN returns them together; set `DEPTH_TTL_HOURS` lower if you want injuries even fresher.)

## Deploy it (get a public link to share)

The easiest free host for a little Node app like this is **[Render](https://render.com)**. It runs
`node server.js` for you and gives you an `https://…onrender.com` link. One-time setup:

1. **Put the code on GitHub.** From this folder:
   ```bash
   git init && git add -A && git commit -m "NFL depth chart app"
   ```
   Create an empty repo on github.com, then follow its "push an existing repository" commands.
2. **Create the Render service.** Sign in to Render → **New → Web Service** → connect your GitHub
   repo. Render reads `render.yaml` automatically (Node runtime, free plan, the update-schedule env
   vars above). If it asks, the start command is `node server.js`.
3. Click **Deploy**. In ~a minute you'll get a public link — share that with coworkers.

Notes:
- The free plan **sleeps after ~15 min idle**, so the first visit after a quiet spell takes ~30s to
  wake up, then it's fast. (Waking up also re-pulls fresh data.)
- To change how often it updates later, edit the env vars in the Render dashboard — no code change.
- Replit or Railway work too; Render is the simplest for an always-on Node server.

## What each file does

| File | Job |
|------|-----|
| `server.js` | A tiny web server. Serves the page and fetches + cleans up the ESPN data. |
| `teams.js` | The list of all 32 NFL teams and their ESPN IDs (used by the dropdowns). |
| `public/index.html` | The page structure (dropdowns, the field, the popover). |
| `public/style.css` | How it all looks (the green field, player chips, injury badges). |
| `public/app.js` | The browser logic: draws the field and handles clicking a position. |
| `package.json` | Tells a host how to start the app (`node server.js`) and which Node version. |
| `render.yaml` | Lets Render auto-configure the deploy, including the update-schedule settings. |

## Where the data comes from

Two free, public ESPN endpoints (no account or key needed):

- **Depth chart** (who's a starter vs backup, and the base formation like "Base 3-4 D")
- **Roster** (names, jersey numbers, and injury status)

The server combines them into a tidy shape the page can draw.

Clicking a position opens the full depth chart, and each player shows **age** (from ESPN) and an
**OVR** rating. Real PFF grades are proprietary/paid with no public API, so OVR is the free,
all-position stand-in: **Madden NFL overall ratings** from EA's public ratings API, matched to each
player by name. Players Madden doesn't rate show "—".

## Notes / good to know

- Only Buffalo runs a true **3-4** base defense. Other teams show whatever base defense ESPN lists
  (often a 4-3) — the formation name shown under the field tells you which.
- Data is cached for ~10 minutes so clicking around is fast. Restarting `node server.js` always
  pulls brand-new data.

## Ideas for later

- Deploy it to a free public URL so coworkers can just click a link.
- Add team colors and logos to the player chips.
- Add special teams, or a side-by-side two-team compare mode.
