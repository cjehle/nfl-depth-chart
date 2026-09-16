# OPERATIONS.md — run, change, ship & operate this site

This is the **runbook** (the "how"). `DURABILITY.md` is the "why it survives untouched";
`OPTIMIZATIONS.md` is the perf log. If you are a new maintainer, **read this first.**

---

## 0. Two-repo topology (READ THIS FIRST — it's the thing most likely to strand you)

There are **two** copies of this project and they are **not identical**:

| Role | Path | Git remote | What's special |
|------|------|-----------|----------------|
| **Source / dev** (edit here) | `Sports Depth Charts/` | local git, **no remote** | where you make changes + run tests |
| **Deploy** (ships here) | `Monthly Budget Insights/nfl-depth-chart/` | `git@github.com:cjehle/nfl-depth-chart.git` | the ONLY repo connected to GitHub → **Render auto-deploys** it → **Cloudflare** fronts it at `billsdepthchart.com`. Also holds the cron workflows in `.github/workflows/`. |

You edit in **Source**, then **sync to Deploy**, then push Deploy. Render redeploys on push.
Live URLs: `https://billsdepthchart.com` (prod) and `https://nfl-depth-chart.onrender.com`
(origin mirror — use it to verify because some corporate networks block the custom domain).

The Deploy repo's copies of a few files are the **source of truth for production** and must
never be overwritten from Source — see the no-clobber list below.

---

## 1. Deploy runbook (Source → live)

```bash
SRC="…/Sports Depth Charts"
DEP="…/Monthly Budget Insights/nfl-depth-chart"

# 1. Test in Source first
cd "$SRC" && npm test        # 37 tests, all must pass
# 2. If ANY file under public/ changed, bump the service-worker version (see §2).
# 3. Sync code dirs (NO --delete) + root files. NOTE: .github is deliberately NOT synced,
#    so the Deploy-only cron workflows are never touched.
for d in lib public sports scripts data test; do rsync -a --exclude='.git' "$SRC/$d/" "$DEP/$d/"; done
for f in server.js package.json render.yaml run-all.sh *.md; do cp "$SRC/$f" "$DEP/$f"; done  # *.md = all root docs (README, OPERATIONS, HANDOFF, CLAUDE, ARCHITECTURE, CONTRACTS, CONTRIBUTING, …)
# 4. Restore the no-clobber files in Deploy (see §1a) — the sync above overwrote them.
#    (Run `git -C "$DEP" fetch origin && git -C "$DEP" rebase origin/main` FIRST if the cron
#     may have pushed since your last pull, so HEAD holds the freshest ratings/seeds.)
git -C "$DEP" checkout -- render.yaml data/ratings data/seed
# 5. Commit both, rebase (the crons push commits to Deploy), push Deploy.
git -C "$SRC" add -A && git -C "$SRC" commit -m "…"
git -C "$DEP" add -A && git -C "$DEP" commit -m "…"
git -C "$DEP" fetch origin && git -C "$DEP" rebase origin/main && git -C "$DEP" push origin main
# 6. Render redeploys in ~1–2 min. Verify: curl https://nfl-depth-chart.onrender.com/sw.js | grep VERSION
```

### 1a. No-clobber files (overwriting these breaks prod)
- **`render.yaml`** — the Deploy copy carries the live service name (`nfl-depth-chart`) and
  `envVars` (`DEPTH_TTL_HOURS`, `MADDEN_TTL_DAYS`). The Source copy has neither. Always
  `git checkout -- render.yaml` in Deploy after syncing. (Source `render.yaml` is **not** an
  accurate record of prod config — set config in the Render dashboard, see §3.)
- **`data/ratings/` (rating maps + `.manifest.json`)** and **`data/seed/` (default-lineup
  seeds)** — both are regenerated + committed by the monthly `refresh-ratings.yml` cron *in the
  Deploy repo*. A stale Source copy would revert the cron's fresh data, so restore the whole
  `data/ratings` and `data/seed` directories from Deploy's HEAD after every sync (step 4). They
  are identical to Source today; they diverge the first time the cron runs.
- **`.github/workflows/`** — `refresh.yml`, `refresh-ratings.yml`, `ci.yml` exist **only in
  Deploy**. Never `rsync .github` from Source, and never with `--delete` — you'd delete the
  crons. (The runbook above simply doesn't sync `.github` at all.)

---

## 2. Service-worker version bump (easy to forget, causes stale pages)
Any change to a file under `public/` → bump `VERSION` in `public/sw.js` in the same commit,
date-stamped (e.g. `"v14-2026-09-08"`). It's the cache key; without a bump, returning visitors
keep the old cached shell/assets. Precached assets: `shared.css, nav.js, common.js, metrics.js,
ads.js, surface/style.css, surface/app.js, nfl/style.css, nfl/app.js, manifest, icons`.

---

## 3. Environment variables (set in Render → Environment; never commit secrets)

| Var | What it does | Default | Read at |
|-----|--------------|---------|---------|
| `PORT` | HTTP port | 3000 | server.js |
| `SITE_URL` | Canonical origin for og:url / `<link canonical>` / sitemap / robots | `https://billsdepthchart.com` | server.js |
| `DEPTH_TTL_HOURS` | How often NFL depth is re-fetched from ESPN | 24 | lib/nfl.js |
| `MADDEN_TTL_DAYS` | How often Madden ratings are re-checked | 30 | lib/nfl.js |
| `LINEUP_TTL_HOURS` | Surface-sport lineup cache TTL | 12 | server.js |
| `MAX_UPSTREAM` | Global cap on concurrent outbound ESPN fetches | 24 | lib/espn.js |
| `TRUST_PROXY` | Honor `X-Forwarded-For` for rate-limit IP (only behind a proxy you control) | off | server.js |
| `ANALYTICS_TOKEN` | If set, injects the Cloudflare Web Analytics beacon **and** adds its two `cloudflareinsights` origins to the CSP; unset = beacon off AND zero CSP footprint (gated like ads on `ADS_ON`) | off | server.js |
| `METRICS_TOKEN` | If set, gates `/dashboard` + `/api/metrics-summary` behind `?key=<token>` (404 without). Empty = public. | "" (public) | server.js |
| `METRICS_DIR` | Where first-party analytics snapshots to disk | os.tmpdir | lib/metrics.js |
| `ADSENSE_CLIENT` | `ca-pub-…` publisher id. Ads stay OFF until this is a valid id. | off | server.js |
| `ADSENSE_SLOT_FEED` / `_BANNER` / `_LANDING` | AdSense ad-unit ids for the 3 slots | "" | server.js |

---

## 4. Turn ON display ads (AdSense) — currently dormant
Ads are fully built but inert (strict CSP stays strict, no slots, no requests) until enabled:
1. Get your AdSense account approved; create **3 Display ad units** (feed / banner / landing).
2. In Render → Environment, set `ADSENSE_CLIENT=ca-pub-…` + the 3 `ADSENSE_SLOT_*` ids → Save.
3. On next load the server widens the CSP for Google's ad domains, serves `/ads.txt`, and the
   client shows a consent banner; ads load **only after the visitor clicks "Allow ads."**
   Nothing changes for visitors who decline.
- EEA/UK note: the built consent gate is a privacy baseline, not an IAB-TCF-certified CMP. For
  personalized ads to EEA users, add Google Funding Choices (or another certified CMP).

## 5. Cloudflare "Cache Everything" rule — edge-cache + hides the free-tier cold-start splash
On Render's free tier the service spins down after ~15 min idle; the next visitor gets Render's
"waking up…" holding page for ~30–60s. Cloudflare hides that from real users: the origin sends
`Cache-Control: s-maxage=300, stale-while-revalidate=86400` on pages (and `s-maxage=120, swr=600`
on `/api`), so with a Cache Rule in place Cloudflare serves the cached copy — including a STALE
copy during a cold origin, via stale-while-revalidate — instead of the splash. But **Cloudflare
does not edge-cache HTML by default**, so the rule is required.

Set it up: Cloudflare → the `billsdepthchart.com` zone → **Caching → Cache Rules → Create rule**:
- **When incoming requests match:** `Hostname equals billsdepthchart.com` (i.e. everything).
- **Then / Cache eligibility:** **Eligible for cache** (Cache Everything).
- **Edge TTL:** **Use cache-control header if present** (respect origin). **Save / Deploy.**

**Safe hostname-wide** because the origin sets the right per-route TTLs itself: pages 5 min, `/api`
2 min, and the endpoints that must stay live — `/healthz`, `/healthz?strict=1`, `/api/metrics-summary`
— send `Cache-Control: no-store`, so Cloudflare never caches them (a cached `/healthz` would blind
the uptime monitor / keep-warm in §8/§12). `POST /api/metric` is never edge-cached; `?fresh=1` is a
distinct cache key so a forced refresh still bypasses any cached lineup; `sw.js`/JS/CSS send
`max-age=0, must-revalidate` so a deploy is never served stale from the edge. Until the rule exists
this is all inert (harmless).

## 6. Analytics dashboard (`/dashboard`)
First-party, privacy-preserving, no cookies/PII. Beacon `public/metrics.js` → `POST /api/metric`
→ aggregated in `lib/metrics.js` → shown at `/dashboard` (reads `/api/metrics-summary`).
- **Make it private:** set `METRICS_TOKEN` in Render → open with `?key=<token>` (404 without).
- **Keep history across restarts:** state snapshots to `METRICS_DIR` (default tmpdir, wiped on
  a Render free-tier spin-down). Attach a Render persistent disk and point `METRICS_DIR` at it.
- Numbers count only real JS-running visitors (RUM) and grow from zero.

## 7. Scheduled refreshes (crons) + the 60-day pause
Three GitHub Actions in the **Deploy** repo (they live ONLY there — never rsync `.github`):
- `refresh.yml` — daily 13:00 UTC — **keep-warm + alarm, no commits.** Curls the live site with
  `fresh=1` across every sport (so the origin re-pulls ESPN even with zero visitors), then fails
  the run — emailing you — if the site is unreachable, or if `/healthz?strict=1` is degraded on
  all three spaced checks. A free uptime + drift alarm.
- `refresh-ratings.yml` — monthly (1st, 09:00 UTC) — regenerates the video-game rating maps, the
  default-lineup seeds, **and pre-baked NFL history** (`gen-nfl-history` bakes any newly-completed
  season into `data/seed/nfl_<team>_<year>.json`; a no-op once a season is baked, so it only does
  work the month after a season ends). `npm test`-gated, commits `data/ratings` + `data/seed` if
  changed. Every generator self-guards (refuses to overwrite good data with a smaller/empty pull →
  non-zero exit), and a refusal fails the run so you're emailed. A bad month is a no-op + an alert.
- `ci.yml` — runs `npm test` on push.

**GitHub auto-disables scheduled workflows after ~60 days of no repo activity — this is the site's
single biggest unattended-operation risk.** The catch: a commit pushed by the monthly cron
authenticates as `github-actions[bot]` via `GITHUB_TOKEN`, and **bot / `GITHUB_TOKEN` pushes do NOT
count as the activity that resets the 60-day clock.** So the crons cannot keep *themselves* alive:
left completely untouched, both schedules pause ~60 days after the last real-human (or PAT) push.
The site keeps serving (live ESPN per request + prewarm + committed seed / last-good fallback), but
seeds and ratings freeze. `GET /healthz?strict=1` flags rating maps >400 days old (503), so a
monitor catches the drift. **To keep the crons alive unattended you need one of: an external
monthly trigger, a PAT-authenticated push, or a periodic manual re-enable — see §12 (Handoff).** To
re-enable after a pause: GitHub repo → Actions → the workflow → "Enable" (or push any commit as
yourself).

## 8. Monitoring
`GET /healthz` always returns 200 (so Render's liveness probe never kills a serving-but-degraded
instance). Point an external uptime monitor at **`/healthz?strict=1`** — that returns 503 only
when the rolling window shows a real problem (upstream error rate, empty/degraded builds, or a
rating map >400 days old). As of 2026-09-15 the NFL engine also feeds the empty/degraded-build
ring (it previously did not), so strict=1 now catches NFL-only drift too, not just the surface
sports. **Caveat (be honest):** the empty/degraded-build signal only fires when the server is
actually *building* lineups — i.e. under real visitor traffic or a cold-start prewarm. Under the
recommended keep-warm monitor with near-zero traffic, few builds happen, so that particular signal
can go quiet; the always-on backstops that still work are (a) the committed seed / last-good
fallback (users keep seeing plausible data through any drift) and (b) the rating-map >400-day
staleness 503. So strict=1 is the best single alarm, not a complete one — the seed fallback is what
actually keeps the site *serving* correctly through provider drift.

## 9. Add a new sport
1. Add `sports/<key>.js` (or, for a soccer league, `require('./_soccer.js')(…)`).
2. Register `<key>` in the `SURFACE` loader loop in `server.js`.
3. Add `PAGE_ROUTES['/<key>']` + an `OG['<key>']` entry (+ optional `THEME`/nav link).
4. Generate committed data: `npm run gen-teams` then `npm run gen-seeds` (see `scripts/` +
   `package.json`), so the cold-start fallback works.
5. Add the sport to the nav in the three shells + `public/index.html` landing grid.
6. Add its default matchup to the `refresh.yml` warm list in the Deploy repo.

## 10. Local dev & tests
```bash
npm start        # or: PORT=8787 node server.js
npm test         # node --test, 37 tests
./run-all.sh     # convenience launcher
```

## 11. Externals that must stay alive (if these lapse, the site dies)
- **Domain** `billsdepthchart.com` — keep it renewed (registrar/DNS = Cloudflare).
- **Render** free web service `nfl-depth-chart` — connected to the GitHub repo; free tier is
  fine (spins down when idle, cold-starts on demand).
- **GitHub** repo `cjehle/nfl-depth-chart` — holds the code + the crons; the push target.
- **Cloudflare** zone for the domain (DNS + CDN + optional Web Analytics).
No paid services are required for the core site to run.

---

## 12. Handoff — before you step away (owner-only actions)
Everything a maintainer can do *from the code* is already in this file. The items below need the
**account owner** and cannot be done from the repo — do them while you still have access. If you
do only one thing, do **#1**: it turns a silent multi-month failure into an email.

1. **[Highest priority] Put an external uptime monitor on `/healthz?strict=1`.** This is the one
   alarm that catches silent ESPN drift *and* a cron pause. Any free monitor works (UptimeRobot,
   Cloudflare Health Checks, BetterStack, or a cron on another machine): HTTP(s) monitor on
   `https://billsdepthchart.com/healthz?strict=1`, **interval 5 min**, alert on any non-200. Without
   it the site can degrade for months with no signal. (The daily `refresh.yml` also emails on
   failure — but only while that cron is still enabled; see the 60-day caveat in §7.)
   - **Doubles as keep-warm (kills the cold-start splash from §5).** The endpoint is `no-store`, so
     the monitor's request always reaches the origin — a 5-min ping (< Render's ~15-min idle
     spin-down) keeps the instance warm, so real visitors stop hitting the "waking up…" page. One
     monitor = alerting **and** no splash, free.
   - ⚠️ Free-hours caveat: keeping a free Render service warm 24/7 ≈ 730 of the ~750 free
     instance-hours/month — it fits for this single service but sits near the cap. If that's too
     tight, ping only waking hours (e.g. every 10 min 07:00–01:00) for ~500 hrs/month with only
     dead-of-night cold starts, or move to Render Starter (~$7/mo) to drop spin-down entirely.
2. **Keep the crons from auto-disabling (§7).** Pick one, most durable first:
   - Add an **external monthly trigger** you control (another server's cron, a Cloudflare Worker
     Cron, etc.) that calls the GitHub API to `workflow_dispatch` / `repository_dispatch` the repo.
     An external trigger counts as activity and keeps the schedules enabled indefinitely.
   - Or have the monthly cron push with a **fine-grained PAT (`contents: write`)** stored as a repo
     secret instead of the default `GITHUB_TOKEN` — a PAT push is a real-user push and resets the
     60-day clock.
   - Or, low-tech: a calendar reminder to open Actions → "Enable" (or push any commit) every ~50
     days.
3. **Renewals / ownership on the accounts you control:** domain `billsdepthchart.com` auto-renew
   **ON** (registrar), Cloudflare zone intact, Render service on an account that won't be reclaimed.
   If the site should outlive your access, transfer the domain + GitHub + Render + Cloudflare to a
   successor (or a shared/org account) **now**, while you can.
4. **(Optional) Ads / analytics privacy** per §4 and §6 — both are inert until configured, so
   skipping them is safe.

## 13. Known limitations & deliberately-held improvements
Audited and consciously **not** changed, recorded so a future maintainer doesn't rediscover them
as "bugs":

- **Crons can't self-sustain past 60 days** (§7/§12) — the top operational limitation; needs an
  external trigger or PAT. Not fixable from code alone.
- **`/healthz?strict=1` needs an external watcher** (§8/§12) — the endpoint exists; nothing pages
  you unless a monitor calls it.
- **Held perf — group-depth payload de-duplication.** `/api/depth` + `/api/lineup` repeat a
  player's full object across the on-field face and the depth list. De-duping (send each player
  once, reference by id) would shrink payloads but changes the client↔server data contract — too
  risky for a possibly-final deploy. Compression (gzip level 6 / brotli quality 6) already absorbs
  most of the repetition on the wire. Revisit only with the ability to test + redeploy.
- **Held perf — face-object de-duplication:** same reasoning, smaller payoff.
- **~~Held perf — streaming the ~52 MB nflverse history file~~ — RESOLVED (2026-09-15).** Completed
  NFL seasons are now **pre-baked** into committed `data/seed/nfl_<team>_<year>.json` by
  `scripts/gen-nfl-history.js`, and `getTeamData` serves those immutable snapshots for past seasons
  instead of the runtime ~50 MB nflverse fetch+parse (`lib/nfl.js`). This removed the biggest
  free-tier memory spike AND the hardcoded `github.com/nflverse` dependency from the request path.
  The live nflverse build remains as a fallback for any season that isn't baked yet (zero
  regression), and the monthly cron auto-bakes each new season the month after it completes. A
  streaming parse is now only relevant to that fallback path, which normal traffic never hits.
- **NFL low-severity audit findings left as-is:** NFL is "final," so several low-severity findings
  were logged and judged not worth churning a finalized surface. If you reopen NFL, **re-run the
  audit** rather than trusting a stale list here.
- **AdSense consent gate is a baseline, not an IAB-TCF-certified CMP** (§4) — fine for non-EEA;
  add a certified CMP before serving personalized ads to EEA/UK users.

### 13a. Pre-handoff durability pass (2026-09-15)
A 4-dimension adversarial audit (time-bombs, external-dep drift, resource leaks, latent
correctness) ran before the owner lost edit access. **Fixed** (safe, reversible, verified):
- **NFL silent-drift guard** — an ESPN field-rename that still returns HTTP 200 used to yield an
  empty NFL envelope that got cached as *fresh* and overwrote last-good, invisibly. `getTeamData`
  now refuses to persist/serve an all-null build (serves the committed seed instead) and feeds the
  drift ring so `/healthz?strict=1` can flag it (`lib/nfl.js`, `lib/espn.js`).
- **All 32 NFL teams seeded** (was only the Bills) so any team page degrades to a committed
  last-good on an ESPN outage + cold start instead of a hard 502 (`scripts/gen-seeds.js` + committed
  `data/seed/nfl_<id>.json`). All committed baselines (seeds + ratings) were also refreshed to
  freshest state on this date.
- **Honest historical labels** — soccer/WNBA/CBB past-season views that ESPN lacks data for now
  read "current roster · no <year> data" instead of silently presenting today's squad as that
  season (`lib/espn.js`).
- **gen-draft time-bomb + guard** — its draft window now derives from the clock (was hardcoded
  `END=2025`) and it won't overwrite the committed map with an empty/decimated pull.

**Documented, intentionally NOT changed** (real but low-impact, and a wrong edit is unrecoverable
now that the site is unpatchable — doing nothing is safer):
- **Empty-build drift alarm is traffic-dependent** — see §8; the seed fallback + ratings-staleness
  503 are the durable backstops.
- **NFL seasons completed after 2025 aren't pre-baked** — no one will run `gen-nfl-history` post-
  handoff unless the monthly cron stays alive (§7). Such a year falls back to a live nflverse fetch:
  works when nflverse is up (a transient ~50 MB spike), or returns an isolated 502 for that one
  season if nflverse has moved. Current-season NFL + all other sports are unaffected.
- **Ratings-staleness alarm depends on `data/ratings/.manifest.json`** being present with a per-sport
  `generatedAt`; if that file were ever lost, staleness stops being detectable (the site still
  serves; only OVR badges would silently age). It is git-tracked and rsync-preserved today.
- **`os.tmpdir()` last-good cache is never pruned** — bounded in practice (deterministic per-key
  filenames overwrite in place; Render free-tier spin-down wipes `/tmp`), so it plateaus rather than
  grows. An auto-pruner was rejected as too risky (unrecoverable delete surface) for an unpatchable
  site.
- **Historical MLB The Show 2023 ratings** couldn't be captured (old edition host unreachable), so
  2023 MLB past-season views show no OVR badge (cosmetic). The monthly `gen-ratings-history` will
  keep skipping it.
</content>
