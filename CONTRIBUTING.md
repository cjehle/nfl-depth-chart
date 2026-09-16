# CONTRIBUTING — read before you touch the code

This is the code-editor's checklist. [CLAUDE.md](CLAUDE.md) is the mental model; the operator
runbook is [OPERATIONS.md](OPERATIONS.md). **This site is effectively unpatchable after handoff —
favor additive changes, and when unsure, don't.**

## The invariants (breaking one silently breaks production)
1. **Zero runtime dependencies.** No `npm install`, no `require` of a package. `package.json`
   stays dependency-free. (Enforced: `test/extensibility.test.js`.)
2. **No build step.** Source is what runs. Don't introduce a bundler/transpiler/`.env` loader.
3. **Strict CSP — no inline JS.** No inline `<script>` (external `src=` or JSON island only) and
   no `on*=` handlers in the HTML shells. The one inline `<style>` is the injected critical CSS,
   allowed only because `CRITICAL_CSS_HASH` (sha256 of the exact string, computed at module load
   in `server.js`) is in `style-src`. If you change that CSS string, the hash recomputes itself —
   never hardcode a hash. (Enforced: `test/extensibility.test.js`.)
4. **Bump `public/sw.js` `VERSION` on any `public/` change** (it's the service-worker cache key;
   stale clients otherwise keep old assets). Server-only changes don't need it.
5. **No hardcoded years/editions.** Derive from the clock. A literal season/edition is a time-bomb.
6. **Every cache Map has a cap or TTL.** Don't add an unbounded store or a leaking `setInterval`.
7. **Never fabricate data.** If a real lineup can't be built, degrade honestly (stale banner, or
   "roster by position — not verified starters"); never present invented data as real.
8. **Two engines are separate.** `lib/nfl.js` (NFL) and `lib/espn.js` (everything else) don't
   share a code path — a fix in one is not automatically in the other.

## Before you commit
- `npm test` (all must pass — it's also the gate the monthly cron uses before it commits).
- `node --check` any file you edited.
- If you touched `public/`, bump `sw.js` `VERSION`.
- If you added/changed a sport, `node --test test/extensibility.test.js` and follow
  [OPERATIONS.md §9](OPERATIONS.md) + [sports/README.md](sports/README.md).

## Deploying (full detail: OPERATIONS.md §1/§1a)
Edit in **Source** → `rsync` to the **Deploy** repo → push → Render auto-deploys. **Never clobber**
the Deploy copies of `render.yaml`, `data/ratings/`, `data/seed/`, or `.github/` (the cron owns
them). Verify on the `onrender.com` mirror. Generators: [scripts/README.md](scripts/README.md).

## Adding a sport in one line
Copy `sports/_template.js` → `sports/<key>.js`, fill it in, do the 6 wiring steps at the bottom of
the template (and in OPERATIONS.md §9), `npm run gen-seeds`, `npm test`, deploy.
