# scripts/ — the offline data generators

These run **offline** (by hand, or the monthly GitHub Action) and write **committed** data into
`data/`. They never run at request time. The server only ever *reads* what they commit, so the
site works even if every generator is broken — it just serves the last committed data. Every
generator **self-guards**: it refuses to overwrite good committed data with an empty/decimated
pull and exits non-zero, so a bad run is a no-op + an alert, never a bad commit.

| Script (`npm run …`) | Consumes | Emits (committed) | When to run | Self-guard |
|----------------------|----------|-------------------|-------------|-----------|
| `gen-teams` | ESPN team lists | `data/*-teams.json` | Only after realignment / a new sport | — (rare, eyeball output) |
| `gen-seeds` | ESPN live (all NFL teams + each sport's default) | `data/seed/<key>_<team>.json`, `data/seed/nfl_<team>.json` | To refresh the cold-start fallback baseline | shrink-guard + empty-guard (skip, keep last-good) |
| `gen-ratings` | EA (Madden/EA FC), Sony (MLB The Show) | `data/ratings/<key>.json` + `.manifest.json` | Monthly (cron) | refuses empty/<80% map → non-zero exit |
| `gen-ratings-history` | EA/Sony past editions | `data/ratings/<key>-<year>.json` | Monthly (cron); most years "frozen, skip" | refuses 0-player write |
| `gen-nfl-history` | nflverse CSVs (github) | `data/seed/nfl_<team>_<year>.json` (completed seasons) | Monthly (cron); idempotent, no-op once a season is baked | empty/shrink-guard; skips already-baked (no fetch) |
| `gen-draft` | NHL api-web | `data/draft/nhl.json` | Rare/manual (feeds the college-hockey draft badge) | shrink/empty-guard; clock-derived window |

## How they're automated
The **monthly** `refresh-ratings.yml` Action (in the **Deploy** repo's `.github/`) runs
`gen-ratings`, `gen-ratings-history`, `gen-seeds`, and `gen-nfl-history`, is `npm test`-gated, and
commits `data/ratings` + `data/seed` if anything changed. `gen-teams` and `gen-draft` are manual.
See [OPERATIONS.md §7](../OPERATIONS.md).

## Conventions if you add or edit a generator
- **Always self-guard**: never overwrite a good committed file with an empty/smaller result;
  `process.exitCode = 1` on refusal so the cron alerts. (Follow the pattern in `gen-seeds.js`/
  `gen-nfl-history.js`.)
- **Derive years/editions from the clock**, never hardcode (a hardcoded year is a time-bomb).
- The generators may fetch from third parties (ESPN/EA/Sony/nflverse/github); that is fine
  **offline**. Do not move any of this to the request path.
- After running one, review the `git diff` of `data/` before committing, and run `npm test`
  (`test/seeds.test.js` + `test/extensibility.test.js` gate the committed data's shape).
