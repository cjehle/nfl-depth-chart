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
for f in server.js package.json render.yaml run-all.sh README.md DURABILITY.md OPERATIONS.md OPTIMIZATIONS.md; do cp "$SRC/$f" "$DEP/$f"; done
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
| `ANALYTICS_TOKEN` | If set, injects the Cloudflare Web Analytics beacon | off | server.js |
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

## 5. Cloudflare "Cache Everything" rule (activates the HTML edge-cache)
Pages are sent with `s-maxage=300, stale-while-revalidate=86400`, **but Cloudflare does not
edge-cache HTML by default.** To let the edge absorb cold-start Render hits: Cloudflare →
Rules → Cache Rules → match the site's HTML routes → "Eligible for cache / Cache Everything"
(respect origin TTL). Until this rule exists, that optimization is inert (harmless).

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
- `refresh-ratings.yml` — monthly (1st, 09:00 UTC) — regenerates the video-game rating maps **and
  the default-lineup seeds**, `npm test`-gated, and commits both if they changed. Every generator
  self-guards (refuses to overwrite good data with a smaller/empty pull → non-zero exit), and a
  refusal fails the run so you're emailed. A bad month is a no-op + an alert, never a bad commit.
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
rating map >400 days old). That is the single alarm that catches silent ESPN drift.

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
   Cloudflare Health Checks, BetterStack, or a cron on another machine): GET
   `https://billsdepthchart.com/healthz?strict=1` every ~15–30 min, alert on any non-200. Without
   it the site can degrade for months with no signal. (The daily `refresh.yml` also emails on
   failure — but only while that cron is still enabled; see the 60-day caveat in §7.)
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
- **Held perf — streaming the ~52 MB nflverse history file:** currently read + parsed in memory in
  `lib/nfl.js` (guarded, single-pass CSV, and only for past-season NFL requests). A streaming parse
  would cut peak memory but adds complexity; act on it only if Render memory pressure actually
  appears.
- **NFL low-severity audit findings left as-is:** NFL is "final," so several low-severity findings
  were logged and judged not worth churning a finalized surface. If you reopen NFL, **re-run the
  audit** rather than trusting a stale list here.
- **AdSense consent gate is a baseline, not an IAB-TCF-certified CMP** (§4) — fine for non-EEA;
  add a certified CMP before serving personalized ads to EEA/UK users.
</content>
