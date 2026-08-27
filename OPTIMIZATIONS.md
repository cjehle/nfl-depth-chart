# Site optimizations — 2026-08-27

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
