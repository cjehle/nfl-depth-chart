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
  one sport, only that sport shows "no lineup"; the others are unaffected.
- **Bounded memory.** All caches are keyed by a finite set (teams, files, athletes) and
  the rate-limiter evicts idle entries, so memory can't grow without bound over time.

## Freshness
Each page load asks for fresh data; the server coalesces that to at most one upstream
pull per team per ~60s (fast + can't get your IP throttled). Pages also auto-refresh
every 4 minutes while open, and the daily Action warms every sport.

## Sports (9)
NFL · MLB · NBA · NHL · MLS · WNBA · College Football · College Basketball · College Hockey.
NFL uses ESPN's real depth chart (+ nflverse history + Madden). NBA/MLB use ESPN's real
depth chart. MLS uses each team's last-match XI. NHL projects lines from last season's
production. College + WNBA show real rosters by position (ESPN has no depth chart for
those). See the per-sport notes in the code.

## Self-updating (no one has to touch it)
- **Data updates itself.** Every page load pulls fresh data (coalesced to ≤1 upstream
  call per team per ~60s); pages also auto-refresh every 4 min while open.
- **It survives cold starts.** On boot the server pre-warms every sport's default
  matchup, so the first visitor after a free-tier spin-down gets an instant page.
- **A daily GitHub Action** warms all sports and, if the site is ever unreachable,
  **fails the run so GitHub emails you** — a free uptime alert.
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
   Enable**, or just push any commit (resets the clock).
4. **Roll back a bad change:** `git revert HEAD && git push`, or Render dashboard → an
   older deploy → **Redeploy**.
5. **A sport shows "no lineup" for a while:** almost always an upstream (ESPN) format
   change — a one-file fix in `sports/<sport>.js` or `lib/espn.js` / `lib/nfl.js`. The
   rest of the site is unaffected in the meantime.
6. **Refresh the team dropdowns** (only needed after league realignment / a new team):
   re-run the small enumeration scripts that built `data/*-teams.json` (kept in the
   project's scratch history) or hand-edit the JSON — id, name, color, logo.
7. **Optional keys** (set as env vars in Render; never in code): `DATAGOLF_KEY` turns on
   the Golf rankings page; `ANALYTICS_TOKEN` turns on Cloudflare Web Analytics.

## Change / run it yourself
- **Change anything:** edit files → `git commit` → `git push origin main` → Render redeploys in ~1–2 min.
- **Run locally:** `npm start` → http://localhost:3000. **Tests:** `npm test` (must stay green).

## Cost
$0 on the current free tiers (Render + Cloudflare + GitHub Actions). Optional paid
add-ons only if *you* choose them: Render always-on (no cold start), a `DATAGOLF_KEY`
(golf rankings), an `ANALYTICS_TOKEN` (Cloudflare Web Analytics).
