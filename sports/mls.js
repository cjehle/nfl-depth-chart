// sports/mls.js — MLS config. ESPN has NO soccer depth chart, so this is a
// "match" sport: we build each team's TYPICAL starting XI from its last several
// matches (who starts most often, in the most common formation), so one rotated
// or cup game can't distort the lineup. The rest of the roster (by line) is depth.
const TEAMS = require("../data/teams.json").mls;

module.exports = {
  key: "mls",
  name: "MLS",
  emoji: "⚽",
  title: "MLS Starting XIs on the Pitch",
  tagline: "Two teams' typical starting XIs from recent matches, in their usual formation — click any player for the depth at that line.",
  surface: "pitch",
  espn: { sport: "soccer", league: "usa.1" },
  kind: "match",
  note: "Typical starting XI & formation from recent matches · EA FC ratings · via ESPN",
  defaults: { a: "182", b: "20232" }, // Chicago Fire vs Inter Miami
  teams: TEAMS,
  bio: (a) => ({
    extra: a.citizenship || [a.birthPlace?.city, a.birthPlace?.country].filter(Boolean).join(", "),
    pos: a.position?.abbreviation || "",
  }),
  // layout is dynamic (computed from each match's formation) — see lib/espn.js
};
