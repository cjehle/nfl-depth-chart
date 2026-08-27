# This site runs forever on your own accounts — no Claude required

Nothing about Claude/Anthropic is in the running site. Claude only helped *write*
the code. Once it's on GitHub + Render, it runs entirely on **your** infrastructure.

## What runs where (all yours)
- **Code:** your GitHub repo `cjehle/nfl-depth-chart`.
- **Hosting:** your Render account (free web service, auto-deploys on every push to `main`).
- **Domain/DNS:** your Cloudflare (`billsdepthchart.com`; add `depthchart.com` the same way).
- **Keep-warm/refresh:** a GitHub Action in the repo (`.github/workflows/refresh.yml`), runs on GitHub's free runners.

## Why it can't silently break
- **Zero dependencies.** `package.json` has no `dependencies` — there's no npm
  supply chain to rot, no `npm audit` treadmill. Just Node's built-ins.
- **No API keys, no secrets, no logins.** The server only calls *public* endpoints:
  - ESPN: `site.api.espn.com`, `sports.core.api.espn.com`
  - nflverse (historical NFL): `github.com/nflverse`
  - EA Madden ratings: `drop-api.ea.com`, `ratings-api.ea.com`
- **All env vars are optional** (they have defaults): `PORT` (Render sets it),
  `DEPTH_TTL_HOURS`, `LINEUP_TTL_HOURS`, `MADDEN_TTL_DAYS`.
- **Resilient by design:** upstream calls time out + retry; a bad/oversized
  response can't hang or OOM it; every good pull is also saved to disk, so if a
  data source is briefly down the site serves the last-good copy instead of erroring.

## Freshness — updates every load
Each page load asks the server for fresh data. The server coalesces this to at
most **one upstream pull per team per ~60 seconds**, so rapid reloads stay instant
and can't get your IP throttled by ESPN. The daily GitHub Action also warms every
sport once a day so a first visitor never waits on a cold cache.

## Maintaining it without Claude
- **Change anything:** edit the files, `git commit`, `git push origin main`.
  Render redeploys automatically in ~1–2 minutes.
- **Run locally:** `npm start`, then open `http://localhost:3000`.
- **Roll back a bad deploy:** `git revert HEAD && git push` (or in Render, click
  an older deploy → "Redeploy").
- **The only realistic long-term maintenance** is if ESPN/nflverse/EA change their
  data format. If a sport stops loading, it's almost always one of those upstreams
  changing a field name — fixable in the relevant `lib/*.js` or `sports/*.js`.
  Nothing expires or requires renewal on its own.

## Cost
$0 on the current free tiers (Render + Cloudflare + GitHub Actions). The only
optional paid upgrade is Render's always-on tier (removes the ~30s cold start
after inactivity) — never required.
