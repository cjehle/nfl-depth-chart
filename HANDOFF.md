# ⚠️ HANDOFF — read this before you lose edit access

_Last updated 2026-09-15. Live site: **https://billsdepthchart.com** (origin mirror:
https://nfl-depth-chart.onrender.com). Full runbook: [OPERATIONS.md](OPERATIONS.md)._

The site is **live and verified working end-to-end** (all 17 sports, NFL current + past
seasons, ratings, offline mode). It is built to run for years untouched. Everything that
can be handled **in code** has been. The items below are the ones that **only the account
owner can do** — I (or any future AI/maintainer) cannot log into your accounts, create
accounts, make a token, or set up a monitor for you. Do these while you still have access.

---

## The 3 things that actually matter (ranked)

### 1. Put an external uptime monitor on `/healthz?strict=1` — 3 minutes, do this first
This is the single most valuable action. It's the only signal that catches a silent
problem while no one is watching, **and** it doubles as a keep-warm that removes the
free-tier "waking up…" cold-start page.

- Sign up at **uptimerobot.com** (free) → **+ New monitor**
- Type: **HTTP(s)** · URL: `https://billsdepthchart.com/healthz?strict=1` · Interval: **5 minutes** · Alert contact: your email
- Save. That's it. It emails you if the site goes down or degrades, and the 5-min ping keeps the instance warm.
- (Free-tier note: 24/7 warming uses ~730 of Render's ~750 free instance-hours/month — fine for this one service. If you'd rather not run near the cap, use a 10-min interval during waking hours only.)

### 2. Keep the GitHub Actions crons alive past ~60 days
GitHub **auto-disables scheduled workflows after ~60 days of no repo activity**, and the
crons' own bot commits do **not** reset that clock. If they pause, the site keeps serving
(it self-heals from committed data), but ratings/seeds stop auto-refreshing. Pick one:
- **Best:** an external monthly trigger you control (a Cloudflare Worker Cron, or a cron on any always-on box) that calls the GitHub API to `workflow_dispatch` the `Refresh ratings` workflow. An external trigger counts as activity and keeps the schedules enabled indefinitely.
- **Or:** give the monthly cron a fine-grained **PAT** (`contents: write`) as a repo secret so its push counts as a real-user push (resets the clock).
- **Or, low-tech:** a recurring calendar reminder to open the repo's **Actions** tab and hit **Enable** (or push any commit) every ~50 days.

### 3. Renewals + ownership — so the site outlives your access
- **Domain `billsdepthchart.com`:** set **auto-renew ON** at the registrar (Cloudflare).
- **If the site should survive you losing this account:** transfer the **domain, the GitHub repo (`cjehle/nfl-depth-chart`), the Render service, and the Cloudflare zone** to a successor or a shared/org account **now**. Once you're locked out you can't hand them over.
- No paid services are required for the core site to keep running.

---

## Optional (nice-to-have, not required)
- **Kill the cold-start splash entirely:** Cloudflare → the `billsdepthchart.com` zone → Caching → Cache Rules → Create → *When* `Hostname equals billsdepthchart.com` → *Then* **Eligible for cache** + Edge TTL **"Use cache-control header if present"**. (Safe hostname-wide; health/metrics endpoints send `no-store`.) See OPERATIONS.md §5.
- **Turn on ads:** set `ADSENSE_CLIENT` + slot env vars in Render (OPERATIONS.md §4). Dormant until you do.

---

## What you do NOT need to worry about (already handled in code)
- **Self-healing data:** every page falls back to a committed snapshot (`data/seed/`) + last-good disk copy when ESPN is down, and says so honestly ("showing a saved lineup"). All 32 NFL teams + every sport's default are seeded; completed NFL seasons (2020–2025) are pre-baked. Baselines were refreshed to freshest state on 2026-09-15.
- **NFL Madden ratings self-update forever:** they're fetched live from EA's edition-agnostic endpoint every ~30 days — no cron, no edition hardcode, no action needed.
- **Auto-refresh cron:** the monthly `Refresh ratings` workflow re-scrapes ratings, refreshes seeds, and bakes each new NFL season automatically (as long as it stays enabled — see #2).
- **Silent-drift protection:** if ESPN ever renames a field but still returns HTTP 200, the server refuses to cache/serve an empty NFL build (it serves the last-good snapshot instead) and now records it so `/healthz?strict=1` can flag it.
- **No time-bombs:** date/edition logic (Madden, MLB The Show, nflverse format, draft window) derives from the clock, not hardcoded years.
- **Bounded resources:** every cache/map/histogram has a hard cap or TTL; nothing grows unbounded over long uptime.

## Known limitations (recorded, intentionally not "fixed" — see OPERATIONS.md §13)
Small, low-impact, and each would carry more regression risk to change than to leave —
documented so a future maintainer doesn't mistake them for bugs. Summary: a few historical
season/team combinations ESPN lacks data for show the current roster labeled "current
roster · no <year> data" rather than that past season; NFL seasons completed *after* 2025
fall back to a live nflverse fetch (works when nflverse is up) until the monthly cron bakes
them; the empty-build drift alarm only fires when the site is actually building lineups
(real traffic or a cold start), so the seed fallback + ratings-staleness alarm are the
durable backstops.
