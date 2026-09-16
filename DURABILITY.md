# This site runs forever on your own accounts — no Claude required

Nothing about Claude/Anthropic is in the running site. Claude only helped *write*
the code. Once it's on GitHub + Render it runs entirely on **your** infrastructure,
and it's built to keep running untouched for years.

## What runs where (all yours)
- **Code:** your GitHub repo `cjehle/nfl-depth-chart` (auto-deploys to Render on push to `main`).
- **Hosting:** your Render account (free web service).
- **Domain/DNS:** your Cloudflare (`billsdepthchart.com`).
- **Daily keep-warm:** a GitHub Action (`.github/workflows/refresh.yml`) on GitHub's runners — warms every sport once a day.

## Why it can't silently break
- **Zero dependencies.** `package.json` has no `dependencies` — no npm supply chain to
  rot, no `npm audit` churn, nothing to expire. Just Node's built-ins.
- **No API keys, no secrets, no logins.** It only calls *public* endpoints: ESPN
  (`site.api.espn.com`, `sports.core.api.espn.com`), nflverse on GitHub (historical
  NFL), and EA (Madden ratings). All env vars are optional and have defaults.
- **The process never dies.** Every request is wrapped in try/catch; a last-resort
  `uncaughtException` / `unhandledRejection` handler keeps the server alive no matter
  what; and `server.on("error")` logs instead of crashing.
- **One broken piece can't take down the rest.** Each sport config and the NFL engine
  are loaded independently — if any single one ever fails, it's skipped and every other
  sport keeps working.
- **Upstream outages degrade gracefully.** Upstream calls time out + retry, oversized
  responses are rejected before they can OOM, failed fetches are never negatively
  cached, and every successful pull is saved to disk — so if a data source is briefly
  down the site serves the last-good copy instead of erroring. If a source changes for
  one sport, only that sport shows "no lineup"; the others are unaffected. When a saved
  copy is served, the page shows an honest "Showing a saved lineup" banner rather than
  passing canned data off as live. **Every sport's default matchup ships a committed
  seed** (`data/seed/`, keyed by the same key the server reads — a test guards this), so
  even a cold start that coincides with a total ESPN outage still renders a real page.
- **You'll know if it silently drifts.** The scariest 10-year failure is ESPN changing
  its JSON shape while still returning `200` — fetches "succeed" but lineups come back
  empty. `/healthz` reports a rolling-window `ok|degraded` verdict (with upstream error
  rate, fallback-serve and empty-build counts), and `/healthz?strict=1` returns `503`
  when degraded so the daily Action emails you on a *sustained* drift, not just downtime.
- **Bounded memory.** Every cache has an explicit size cap with oldest-first eviction
  (lineups, stats, records, athletes) and the rate-limiter evicts idle entries, so memory
  stays bounded over months of uptime regardless of how many teams/seasons are browsed.
- **No date time-bombs.** Season/"current year" math is all derived from the clock (never
  hardcoded), and the NFL cold-start seed is keyed season-agnostically, so nothing breaks
  when the season rolls over year after year.

## Freshness
Each page load asks for fresh data; the server coalesces that to at most one upstream
pull per team per ~60s (fast + can't get your IP throttled). Pages also auto-refresh
every 4 minutes while open, and the daily Action warms every sport.

## Sports
NFL · MLB · NBA · NHL · MLS · WNBA · College Football (all FBS) · College Basketball
(all D1) · College Hockey · **International Soccer** (Premier League, La Liga, Bundesliga,
Serie A, Ligue 1, Liga MX, NWSL, Champions League — grouped under one nav folder,
all using the MLS-style match builder via `sports/_soccer.js`).
NFL uses ESPN's real depth chart (+ nflverse history + Madden). MLB uses ESPN's real
depth chart. **NBA/WNBA/CBB build a "typical starting five" from recent box scores**
(who starts most, last-5 weighted; drops off-roster players; falls back to the ESPN
depth chart for NBA or roster-by-class for WNBA/CBB when box data is thin). **MLS builds
a "typical XI" from the last ~8 matches** (most common formation, most-frequent starters)
so one rotated/cup game can't distort it. NHL projects lines from last season's
production. College football + hockey show rosters by position/class. See the per-sport
notes in the code.

## Video-game ratings
Each player's overall shows in the popover like the NFL page's Madden OVR: **MLS → EA
Sports FC, MLB → MLB The Show** (NFL → Madden, in `lib/nfl.js`). To avoid hammering
EA/Sony from the live server, ratings live in committed maps (`data/ratings/*.json`)
built by `npm run gen-ratings`; the server only reads them. NBA/WNBA (2K) and NHL/CFB
have no publicly accessible ratings feed, so they show no badge. **These maps stay
current on their own:** a monthly GitHub Action (`refresh-ratings.yml`) re-runs the
generators, runs the tests, and commits any changes — and the generators self-guard,
refusing to overwrite a good map with an empty or <80%-smaller one on a flaky pull (they
exit non-zero so the run fails and emails you rather than committing corruption). Each
run also writes `data/ratings/.manifest.json` (per-map count + date), which `/healthz`
surfaces as `ratings` and flags `degraded` (→ the daily strict alert emails you) if any
map goes >400 days stale — so a silently-stopped refresh becomes an actionable page.
Name-matching escalates exact → folded → token-subset → surname+initial → cross-league,
and a golden-corpus test locks that resolution so a matcher change can't silently drop
badges. You can still refresh by hand anytime: `npm run gen-ratings` then commit. **Past seasons:** MLB shows that
season's MLB The Show ratings from per-year maps (`data/ratings/mlb-YYYY.json`,
built by `npm run gen-ratings-history`); soccer/NFL keep current-edition ratings
only (no historical source). CFB is wired to EA College
Football but EA hasn't published those to the public API yet (empty `cfb.json`); it
auto-lights-up when they do and you re-run `gen-ratings`. College basketball has no
video game with public ratings.

## College hockey → NHL draft status
Each college-hockey player shows their NHL draft status (team, round, overall pick,
year — or "Undrafted") in the depth popover, from a committed map
(`data/draft/nhl.json`) built by `npm run gen-draft` off the NHL's public draft API.
Refresh after each June draft: `npm run gen-draft` then commit `data/draft/`.

## Self-updating (no one has to touch it)
- **Data updates itself.** Every page load pulls fresh data (coalesced to ≤1 upstream
  call per team per ~60s); pages also auto-refresh every 4 min while open.
- **It survives cold starts.** On boot the server pre-warms every sport's default
  matchup, so the first visitor after a free-tier spin-down gets an instant page.
- **A daily GitHub Action** warms all sports and emails you (by failing the run) if the
  site is ever unreachable **or stays degraded** (via `/healthz?strict=1`) — a free
  uptime + silent-drift alert.
- **The site does NOT depend on that Action, on the cron, or on Claude.** Even if the
  Action is disabled, the site keeps serving and updating on every visit.

## Operations runbook (keep it alive forever)
Nothing here needs code or Claude — it's account hygiene:
1. **Domain:** keep `billsdepthchart.com` renewed in Cloudflare (bought long — just don't
   let it lapse). If it ever lapses, the site still works at the `…onrender.com` URL.
2. **Render account:** stay signed up (free). If Render emails about the free service,
   click to keep it. Optional: upgrade to always-on to remove cold starts.
3. **GitHub Actions 60-day rule:** GitHub auto-disables *scheduled* workflows after 60
   days with no repo commits. If that happens you only lose the daily warm + uptime
   email — the site still runs. Re-enable anytime: repo → **Actions → Daily refresh →
   Enable**, or just push any commit (resets the clock). For a truly hands-off decade,
   also point a free external monitor (e.g. UptimeRobot) at
   `https://billsdepthchart.com/healthz?strict=1` — it doesn't age out and alerts on
   both downtime and sustained ESPN drift.
4. **Roll back a bad change:** `git revert HEAD && git push`, or Render dashboard → an
   older deploy → **Redeploy**.
5. **A sport shows "no lineup" for a while:** almost always an upstream (ESPN) format
   change — a one-file fix in `sports/<sport>.js` or `lib/espn.js` / `lib/nfl.js`. The
   rest of the site is unaffected in the meantime.
6. **Refresh the team dropdowns** (only after realignment / a new team): run
   `npm run gen-teams` (regenerates `data/*-teams.json` from ESPN; skips any list
   that comes back short, so a glitchy pull can't blank a dropdown), then commit
   `data/`. Refresh the cold-start fallback copies with `npm run gen-seeds`, then
   commit `data/seed/` — worth doing once a season (and after an NFL rollover) so the
   saved lineups stay recent. `npm test` fails if any sport's default seed is missing,
   so a drift here can't slip by unnoticed.
7. **Refresh video-game ratings** (occasionally): `npm run gen-ratings`, then commit
   `data/ratings/`. The live server never fetches these — it only reads the committed maps.
8. **Optional keys** (set as env vars in Render; never in code): `ANALYTICS_TOKEN` turns
   on Cloudflare Web Analytics.

## Change / run it yourself
- **Change anything:** edit files → `git commit` → `git push origin main` → Render redeploys in ~1–2 min.
- **Run locally:** `npm start` → http://localhost:3000. **Tests:** `npm test` (must stay green).

## Cost
$0 on the current free tiers (Render + Cloudflare + GitHub Actions). Optional paid
add-ons only if *you* choose them: Render always-on (no cold start) and an
`ANALYTICS_TOKEN` (Cloudflare Web Analytics).

## Known coupling when adding a sport (DOCUMENT, don't refactor)
Adding a sport touches several files, and each of these seams **fails silently** if you miss it —
a missing route 404s, a broken config is skipped, a new unit name yields no data. A single
registry would remove the coupling, but refactoring the request path on an unpatchable site is the
wrong trade; instead, know the seams (and let `test/extensibility.test.js` catch the wiring ones):

1. **`SURFACE` loader list is hardcoded** (`server.js` ~l.49) — a new `sports/<key>.js` is NOT
   loaded until `<key>` is added to that array. An invalid config is caught and **silently skipped**.
2. **`PAGE_ROUTES` + `OG` map are hardcoded** (`server.js`) — no `/<key>` route → the page 404s;
   no `OG` entry → `renderPage` has nothing to inject.
3. **The nav + landing grid are hardcoded in the HTML shells** (`public/index.html`,
   `public/nfl/index.html`, `public/surface/index.html`) — a new sport won't appear in the nav or
   the landing grid until you add its `<a>` by hand in each shell.
4. **The `/api/lineup` unit whitelist** is `["offense","defense","line1","line2"]`
   (`server.js` ~l.644) — a dual-unit sport using any OTHER unit names would have `unit` forced to
   `null`. Reuse those names or extend the whitelist.
5. **`buildLineup` dispatches on `cfg.kind` with a silent default** (`lib/espn.js` ~l.934) — an
   unknown/typo'd `kind` falls through to `resolveDepthLineup` instead of erroring, so a mis-typed
   kind produces wrong (not absent) output. `test/extensibility.test.js` asserts `kind` is one of
   the five known values.
6. **A committed seed is per-`sport:team:unit:year:formation` key** (`safeKey`/`lineupKey`) — the
   new sport's default matchup needs `npm run gen-seeds` or it has no cold-start fallback.

Steps 1–3 and 5 are asserted by `test/extensibility.test.js`; step 6 by `test/seeds.test.js`. The
authoritative add-a-sport checklist is [OPERATIONS.md](OPERATIONS.md) §9, the schema is
[sports/README.md](sports/README.md), and the copy-me starter is `sports/_template.js`.

## A documented non-issue: the season clock is LOCAL time on purpose
`currentNflSeason()` (`public/nfl/teams.js`) uses **local** time because that file is shared with
the browser, while the surface engine's season math (`lib/espn.js` `seasonEndYear` rollover,
`server.js` NFL year) uses UTC. This looks inconsistent but is intentional and immaterial: season
boundaries are month-granular, so the at-most ±1-day local-vs-UTC skew around a Feb/Mar or Aug/Sep
rollover never changes which season is shown. **Do not "fix" it by forcing `currentNflSeason` to
UTC** — it must stay local for the browser, and the two clocks serve different roles.
