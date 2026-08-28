# Site optimizations

## Batch 10 — 2026-08-27 (data-rich player popover)

The depth popover now shows far more about each player:
- **Headshots** — ESPN player photo (`a.espncdn.com/i/headshots/…` from the athlete
  id already in every chip), circular, with a jersey-tile fallback when a photo 404s.
- **Season stat line** for the starter — lazy `GET /api/player-stats?sport=&id=&year=`
  parses the ESPN athlete statistics per sport: NBA/WNBA/CBB PPG·RPG·APG, MLB
  AVG·HR·RBI (ERA·W-L·K for pitchers), NHL G·A·PTS (GAA·SV% for goalies), NFL/CFB
  yds·TD·CMP% (auto-picks passing/rushing/receiving). Soccer has no upstream athlete
  stats, so it shows none.
- **Full injury detail** — status + what it is + expected return, from the roster
  data already fetched (no extra call).
- **Richer bio** — experience years now rendered; height/weight/age/class/college.
- **"↗ ESPN" profile link** per player, built from the athlete id.

Still queued from the same list: player-vs-player compare drawer, responsive chip
scaling, desktop-surface default, mobile controls wrap; then the formation filter.

## Batch 9 — 2026-08-27 (quality-audit fixes)

Resolved the issues the live league audit surfaced:
- **CBB always shows 5 (distinct) players.** The offseason roster fallback now
  backfills a court slot whose position bucket is empty from surplus players (extra
  guards fill a wing, etc.) and gives each slot its own depth list, so no team
  renders 3-4 chips or duplicate PG/SG dropdowns. `resolveRosterLineup` court path.
- **Soccer rating name-matching hardened.** `ratings.ratingFor` now folds special
  letters (ı ł ø …) and hyphens and does an unambiguous token-subset match, so
  Vinícius Júnior (89), Alisson (89), Kenan Yıldız (79) and Kim Min-jae (82) — all
  present in EA FC under longer/short names — now resolve.
- **NBA offseason subtitle** reads "projected starting five · ESPN depth chart"
  instead of "Starting Lineup" (matches the depth-chart fallback reality).
- **NHL empty jersey** no longer renders a bare "#": the jersey helper omits it.
- **NFL preseason** is labeled ("Next: vs PIT · Preseason") so a preseason record
  isn't mistaken for regular season.

## Batch 8 — 2026-08-27 (conference filter + audit fixes)

- **Conference filter** on the college sports (CBB, CFB, College Hockey). A "Conf"
  dropdown next to each team dropdown filters the team list to that conference;
  picking a team syncs the conference shown (bidirectional). CBB team list rebuilt
  with complete conference labels for all 362 D1 teams (31 conferences) from the
  standings endpoint — `gen-teams` now uses `fromListWithConf`. CFB/MCH already
  carried conferences.
- **Live quality-audit fix:** past-season lineups no longer show the *current*
  season's team record/rank/next-game (they were echoing live values) — those are
  nulled for historical views since a season-specific record isn't fetched.

## Batch 7 — 2026-08-27 (historical ratings + soccer spacing)

- **Historical video-game ratings (MLB).** A past MLB season now shows *that
  season's* MLB The Show ratings, not today's. MLB The Show publishes per-year
  data (`mlbNN.theshow.com`), so `npm run gen-ratings-history` builds
  `data/ratings/mlb-YYYY.json` for the last 5 seasons; `ratings.ratingFor/publisher`
  take a year. **Only MLB** — EA FC (soccer) and Madden (NFL) expose only the
  current edition, so their past seasons stay badge-less (no fabricated OVRs).
- **Soccer half-field spacing.** `placeStarters` now spreads each line nearly
  full-width and stretches the lines from the GK to the attack across most of the
  half, with a small alternate-player vertical stagger so long names don't collide;
  the pitch is taller (aspect 0.64) for more room. Formations read clearly and every
  name is legible.

## Batch 6 — 2026-08-27 (historical seasons)

A **"Season" selector (last 5 years)** on the sports with rich historical ESPN
data — MLB, NBA, WNBA, CBB, and every soccer league (NFL already had past seasons).
NHL and college football/hockey stay current-only (their historical views would be
misleading — old stats re-ranking today's roster, etc.).

- Threads a `season` param through `getLineup → buildLineup → the depth / boxstart
  / match builders`. `/api/lineup?...&year=YYYY` (clamped to the last ~6 seasons).
- **Depth (MLB/NBA):** past-season depth chart; players no longer on the roster are
  resolved via their athlete `$ref` (bounded + cached).
- **Box-score (NBA/WNBA/CBB):** rebuilds the five from that season's box scores (no
  current-roster gate), bios from the box data.
- **Match (soccer):** typical XI from that season's schedule (`?season=`).
- Current video-game ratings are **suppressed** for past seasons (a 2022 XI with
  2026 OVRs would be wrong — historical ratings are a separate step). Season labels
  are correct per league ("2023-24" for NBA/CBB, "2024" for calendar sports).

## Batch 5 — 2026-08-27 (view polish)

- **Baseball → single team on the diamond** (Cubs default): the nine fielders across
  a full diamond (outfield fanned, infield around the bases, mound, catcher at home),
  second-team controls hidden.
- **Basketball courts:** three perimeter players on the three-point line + two bigs
  in the paint; layout reordered so the List view reads Guards → Forwards → Center.
- **College football field:** formation spacing now mirrors the NFL page (lines at
  the LoS, backfield/secondary spread toward the end zones).

## Batch 4 — 2026-08-27 (International Soccer)

Added **8 top soccer leagues**, grouped under an **"International Soccer"** folder
(a `<details>` dropdown) in the nav + a section on the hub. Each reuses the existing
MLS-style `match` builder + pitch surface via a shared factory (`sports/_soccer.js`),
so a league is just a one-line config + a committed team list:

- **Premier League, La Liga, Bundesliga, Serie A, Ligue 1, NWSL** — with per-league
  EA FC ratings (one `gen-ratings` pass now buckets EA FC into per-league maps:
  `data/ratings/{epl,laliga,bundesliga,seriea,ligue1,nwsl,mls}.json`, keyed per
  league so a same-named player from another league can't be mismatched).
- **Liga MX & Champions League** — lineups only (EA FC has no Liga MX license, and
  UCL has no per-league map), so no OVR badge — same honest pattern as elsewhere.

Marquee defaults: Man City–Liverpool, Real Madrid–Barcelona, Bayern–Dortmund,
Inter–Juventus, PSG–Marseille, América–Guadalajara, Portland–Kansas City,
Real Madrid–Man City (UCL). Also fixed "last 1 match" pluralization in subtitles.

## Batch 3 — 2026-08-27 (college additions)

- **College hockey → NHL draft status.** Every college-hockey player now shows
  whether they were drafted and by whom — "🏒 NHL Draft · DET · R7 #187 (2020)"
  in the depth popover (with a compact "DET R7" chip in the list), or "Undrafted".
  Built from the NHL's public draft API into a committed map (`data/draft/nhl.json`,
  2406 players, 2015-2025) via `npm run gen-draft` — zero runtime NHL fetching.
  `lib/draft.js`, `sports/mch.js` (`draftStatus:true`), `lib/espn.js`, clients.
- **College football ratings — wired, awaiting EA.** EA College Football uses the
  same drop-api shape as Madden, but EA does **not** publish those ratings to the
  public API yet (the endpoint returns 0 items). CFB is fully wired to it
  (`gen-ratings` writes an empty `cfb.json`; `ratings.publisher()` shows no badge
  until the map has data), so the moment EA populates it, a `npm run gen-ratings`
  re-run lights up CFB OVR badges with **no code change**.
- **College basketball ratings — none available.** There is no current college-
  basketball video game with published ratings (2K College Hoops / EA College
  Hoops were discontinued ~2010), and no stable public source, so CBB carries no
  ratings. Left out honestly rather than scraping a fragile source.

## Batch 2 — 2026-08-27 (second 10)

A fresh round after a 9-dimension code audit. All verified locally and grounded
in the code.

1. **CDN-cacheable lineup/depth APIs (stale-while-revalidate).** `/api/lineup` and
   `/api/depth` now send `Cache-Control: public, s-maxage=120, stale-while-revalidate=600`
   (+ always `Vary: Accept-Encoding`). Cloudflare serves most hits from the edge,
   keeping the cold Render origin and ESPN off the critical path. `server.js`.
2. **Per-route `<title>` + `<meta name=description>`.** These were byte-identical
   across the 8 surface sports; now `headFor()` injects the unique title+description
   from the OG map, and the static HTML no longer carries its own. Also removed a
   duplicate `theme-color`. `server.js › headFor`, the three `index.html` heads.
3. **Share / copy-link button.** New "↗ Share" on the surface + NFL pages using
   `navigator.share()` with a clipboard fallback and a status-region confirmation.
   The URL already carries `?a=&b=&v=`. `public/*/index.html`, `public/*/app.js`.
4. **Skip-to-content link + visible focus ring.** A keyboard skip link on every
   page (WCAG 2.4.1) targeting `#main`, plus a global `:focus-visible` ring (2.4.7).
   `public/shared.css`, the three `index.html`.
5. **"Lineup as of <date>".** Builders already compute the game/match date a lineup
   is derived from (`updatedMatch`) but it was dropped; now surfaced as `asOf` and
   shown by the "Updated" chip, so a months-old offseason lineup can't look fresh.
   `lib/espn.js › buildLineup`, `public/surface/app.js`.
6. **Rate limiter keyed off `CF-Connecting-IP`.** Was using the spoofable/shared
   last hop of `X-Forwarded-For`; now prefers Cloudflare's trusted client IP, then
   the leftmost XFF, then the socket. `server.js › clientIp`.
7. **CI workflow.** `.github/workflows/ci.yml` runs `npm test` + `node --check`
   over all JS on push/PR (Node 20 & 22), so a typo can't reach Render unguarded.
8. **Enriched `/healthz`.** Now reports `process.memoryUsage()`, cache sizes, and a
   per-lineup freshness map (age in seconds) — real ops visibility on the ephemeral
   free tier. `server.js`, `lib/espn.js › cacheStats`.
9. **Next-game opponent + date in the team band.** `team.nextEvent` was fetched
   with the record and discarded; now parsed and shown as "Next: @SEA · Sun" on
   surface + NFL bands. `lib/espn.js › teamRecord/parseNext`, `lib/nfl.js`, clients.
10. **Service worker + installability.** `public/sw.js` precaches the app shell,
    serves navigations network-first and `/api/*` + static assets
    stale-while-revalidate (instant last-known lineup offline). Manifest gains
    `id`, `lang`, a maskable icon and app shortcuts. `public/sw.js`, `public/nav.js`,
    `public/manifest.webmanifest`.

Runners-up captured for later: cache compressed bytes per entry; per-sport
schema-drift detection on `/healthz`; per-host circuit breaker in `fetchText`;
unit tests for the lineup builders; MLB probable starting pitcher; safe-area
insets; BreadcrumbList/ItemList JSON-LD; position/role glossary.

---

## Batch 1 — 2026-08-27 (first 10)

Two batches shipped together: **accuracy** (lineups now reflect who actually
plays) and **page optimizations** (10 improvements to speed, SEO, a11y & polish).
Everything is additive and reversible — no behavior was removed except Golf
(removed on request) and the fragile "single last match" MLS logic.

## Accuracy — "typical, not exactly current" everywhere it's reliable

- **MLS → typical XI over the last 8 matches.** The old code used each team's
  *single most recent match*, so one rotated/cup game wrecked the chart (the
  Fire's Lewandowski & Gutman were missing because the last game was a rotation).
  Now we rank players by how often they start, fill the team's most common recent
  formation line-by-line, and place them. `lib/espn.js › resolveMatchLineup`.
- **NBA / WNBA / CBB → typical starting five from recent box scores.** ESPN has
  no depth chart for WNBA/CBB and its NBA chart can be stale. Box scores flag who
  started, so we take the five that start most (last-5-games weighted so injuries
  /returns are tracked), drop anyone no longer on the roster, and fall back
  cleanly (NBA → ESPN depth chart; WNBA/CBB → roster by class) when box data is
  thin (e.g. the offseason). `lib/espn.js › resolveBoxStartLineup`. This is why
  Caitlin Clark now shows for the Fever instead of a roster-order guard.
- **Unchanged (already the right "typical" view):** NFL & MLB use ESPN's real
  depth chart (typical starter *per position* — MLB's 5-man rotation would break
  a box-score approach); NHL projects lines from season production; CFB / College
  Hockey show the roster by position/class (no reliable box-score starters, and
  the CFB season is just starting).

## 10 page optimizations (applied automatically)

1. **Video-game overall ratings in the lineup & popover.** MLS shows EA Sports FC
   ratings, MLB shows MLB The Show ratings, as a gold "OVR" badge on each chip,
   list row and depth popover (matching the NFL page's Madden OVR). Ratings come
   from committed maps (`data/ratings/*.json`) built by `npm run gen-ratings`, so
   the live server never pages EA/Sony. *(NBA/WNBA = 2K and NHL/CFB have no
   publicly accessible ratings feed, so they carry no badge — by design.)*
2. **`sitemap.xml`** generated from the canonical routes (can't drift) — better
   crawlability.
3. **`robots.txt`** allowing all crawlers and pointing at the sitemap.
4. **Canonical `<link>` per page** — kills duplicate-URL SEO dilution.
5. **JSON-LD structured data** (`WebSite` schema) injected per route for richer
   search results. (Non-executable, so it's exempt from the script-src CSP.)
6. **`preconnect` + `dns-prefetch` to `a.espncdn.com`** — team logos start
   loading a round-trip sooner, so crests paint faster.
7. **Long-lived caching for images/icons/fonts** (`max-age=604800`) while code
   assets stay `must-revalidate` — repeat visits pull far less over the wire, but
   a deploy is still picked up immediately.
8. **HSTS header** (`Strict-Transport-Security`, 1 year) — forces HTTPS; safe
   behind Cloudflare, ignored on plain-http localhost.
9. **`theme-color`** meta — themed browser UI / PWA polish.
10. **Friendly empty-state + `prefers-reduced-motion` support.** Teams with no
    published lineup (e.g. Miami OH hockey) now show a clear "No lineup published
    yet — this page updates itself, check back" card instead of a blank surface;
    and users who ask their OS for reduced motion get all transitions/animations
    disabled.

*(Already present before this pass, so not counted: gzip compression, ETag/304,
CSP + security headers, deep-linkable `?a=&b=&v=` URLs, mobile→list default,
ARIA labels, injury badges, 4-min auto-refresh, alphabetical dropdowns, swap
button.)*

## Refreshing the rating maps
`npm run gen-ratings` (pages EA/Sony once, resiliently — retries flaky pages,
never abandons the run), then commit `data/ratings/`. Run occasionally (ratings
change with roster moves / game updates); the live server only reads the file.
Latest run: **831 MLS** players (EA FC) · **2029 MLB** players (The Show, Live).
