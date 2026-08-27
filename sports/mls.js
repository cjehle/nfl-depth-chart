// sports/mls.js — MLS config. ESPN has NO soccer depth chart, so this is a
// "match" sport: we read the team's most recent match for the real starting XI
// and formation, and use the rest of the roster (by line) as depth.
const TEAMS = require("../data/teams.json").mls;

module.exports = {
  key: "mls",
  name: "MLS",
  emoji: "⚽",
  title: "MLS Starting XIs on the Pitch",
  tagline: "Two teams' most-recent starting XIs, in their real formation — click any player for the depth at that line.",
  surface: "pitch",
  espn: { sport: "soccer", league: "usa.1" },
  kind: "match",
  note: "Starting XI & formation from each team's last match · via ESPN",
  defaults: { a: "182", b: "20232" }, // Chicago Fire vs Inter Miami
  teams: TEAMS,
  bio: (a) => ({
    extra: a.citizenship || [a.birthPlace?.city, a.birthPlace?.country].filter(Boolean).join(", "),
    pos: a.position?.abbreviation || "",
  }),
  // layout is dynamic (computed from each match's formation) — see lib/espn.js
};
