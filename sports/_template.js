// sports/_template.js — COPY ME to add a new surface sport.
// ---------------------------------------------------------------------------
// This file is NOT loaded as a sport (the "_" prefix excludes it, like _soccer.js).
// To add a sport: copy this to sports/<key>.js, fill it in, then wire it up in
// server.js + the shells + a seed — see OPERATIONS.md §9 and the checklist at the
// bottom of this file. sports/README.md documents every field in detail; run
// `node --test test/extensibility.test.js` to check your config before deploying.
//
// Pick your `kind` — it selects the builder in lib/espn.js buildLineup():
//   "depth"    — ESPN publishes a real ranked depth chart (MLB, NBA-when-available).
//   "match"    — soccer: typical XI + formation from recent completed matches (use the
//                _soccer.js factory instead of this template for a soccer league).
//   "statrank" — no depth feed; rank the roster by production (NHL lines).
//   "boxstart" — typical starters from recent box scores (NBA/WNBA); falls back per boxFallback.
//   "roster"   — no lineup exists; show the roster by position/class, labeled NOT verified.
// ---------------------------------------------------------------------------
const TEAMS = require("../data/<key>-teams.json"); // generate via: node scripts/gen-teams.js (see scripts/README.md)

module.exports = {
  // ---- identity (all required) ----
  key: "<key>",                 // MUST equal the filename (sports/<key>.js). Routes/OG/loader key off this.
  name: "<Display Name>",       // e.g. "NBA"
  emoji: "🏟️",
  title: "<Page H1 / OG title>",
  tagline: "<one sentence under the H1>",
  surface: "court",             // rink | court | pitch | diamond | field — sets the client background + coordinate frame
  espn: { sport: "<espn-sport>", league: "<espn-league>" }, // e.g. { sport:"basketball", league:"nba" }
  kind: "depth",                // see the list above — MUST be one of match|statrank|boxstart|roster|depth

  // ---- the default landing matchup (required; ids MUST exist in TEAMS) ----
  defaults: { a: "<teamId>", b: "<teamId>" }, // 'a' is required; 'b' omitted/ignored when singleTeam
  teams: TEAMS,

  // ---- per-athlete bio (required): map an ESPN athlete → the small bio the popover shows ----
  bio: (a) => ({ extra: (a.college && a.college.name) || "", pos: a.position?.abbreviation || "" }),

  // ---- required for kind "boxstart" and "roster": map a position string → a bucket ----
  // bucket: (pos) => { const a=(pos||"").toUpperCase(); if(a==="C")return "center"; return "guard"; },

  // ---- field placement: required EXCEPT for kind "match" (client lays out the pitch) ----
  // Single-unit layout (most sports). x/y are 0–100 percentages on the surface.
  // `posKey` feeds the depth/statrank builders; `bucket`+`faceRank` feed box-score/roster builders.
  layout: [
    // { key: "PG", label: "Point Guard", posKey: "pg", bucket: "guard", group: "Guards", x: 50, y: 50 },
  ],

  // ---- common optional flags (omit if not applicable) ----
  // history: true,             // offer a past-season selector (only match/boxstart/depth support it)
  // singleTeam: true,          // show ONE team across the whole surface (e.g. MLB diamond)
  // seasonEndYear: true,       // ESPN labels this sport's season by its END year (NBA 2027 = 2026-27)
  // note: "…",                 // legend line under the controls
  // formations: ["Balanced","Small ball"], formationMode: "court", // client re-places a fixed roster
  // boxFallback: "depth",      // boxstart only: fall back to the depth chart when box data is thin
  // classYears: true,          // college: players carry FR/SO/JR/SR instead of age
  // rosterLabel: "roster by position", // honesty label when it's not a verified lineup

  // ---- dual-unit sports only (two units on one screen) ----
  // dualUnit: true, units: ["offense","defense"], unitLabels: ["Offense","Defense"],
  // For a dual-unit ROSTER sport with formation packages (like CFB), also add:
  //   layouts: { offense: [...], defense: [...] },  packages: { offense: {...}, defense: {...} },
  //   unitFormations: {...}, unitFormationLabels: {...}, formationMode: "unit",
};

// ---------------------------------------------------------------------------
// AFTER writing sports/<key>.js, wire it up (server.js silently skips a config that
// isn't registered, and a page 404s without a route). Full detail: OPERATIONS.md §9.
//   1. Add "<key>" to the SURFACE loader array in server.js.
//   2. Add "/<key>": { rel: "surface/index.html", og: "<key>" } to PAGE_ROUTES in server.js.
//   3. Add a "<key>: { title, desc, img, path }" entry to the OG map in server.js.
//   4. Add the sport's <a> link to the nav in public/{index,nfl,surface}/index.html + the landing grid.
//   5. Commit a seed: `npm run gen-seeds` (writes data/seed/<key>_<default>.json).
//   6. Run `npm test` — test/extensibility.test.js verifies steps 1–3 and the config shape.
// ---------------------------------------------------------------------------
