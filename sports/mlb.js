// sports/mlb.js — Major League Baseball. ESPN serves a real, current depth
// chart per position, so this is a "depth" sport (like NBA). Shown on a diamond.
const TEAMS = require("../data/mlb-teams.json");

module.exports = {
  key: "mlb",
  name: "MLB",
  emoji: "⚾",
  title: "MLB Lineups on the Diamond",
  tagline: "Two teams' lineups on the diamond — click any position for the full depth chart there.",
  surface: "diamond",
  espn: { sport: "baseball", league: "mlb" },
  kind: "depth",
  note: "Age, bio & depth chart via ESPN",
  defaults: { a: "16", b: "8" }, // Chicago Cubs vs Milwaukee Brewers
  teams: TEAMS,
  bio: (a) => ({
    extra: `B/T ${a.bats?.abbreviation || "–"}/${a.throws?.abbreviation || "–"}`,
    pos: a.position?.abbreviation || "",
  }),
  // The 9 fielders arranged as a diamond: outfield up top, infield around the
  // bases, battery (P/C) down the middle toward the center. (DH bats only, so
  // it's not shown on the field — it's still in the List view / depth chart.)
  // Real diamond shape: outfield fan up top, middle infielders flanking second,
  // corners lower, pitcher on the mound, catcher at home (toward center). Short
  // labels keep the chips single-line so they don't overlap.
  layout: [
    { key: "CF", label: "CF", posKey: "cf", group: "Outfield", x: 50, y: 7 },
    { key: "LF", label: "LF", posKey: "lf", group: "Outfield", x: 17, y: 14 },
    { key: "RF", label: "RF", posKey: "rf", group: "Outfield", x: 83, y: 14 },
    { key: "SS", label: "SS", posKey: "ss", group: "Infield", x: 39, y: 27 },
    { key: "2B", label: "2B", posKey: "2b", group: "Infield", x: 61, y: 27 },
    { key: "3B", label: "3B", posKey: "3b", group: "Infield", x: 26, y: 38 },
    { key: "1B", label: "1B", posKey: "1b", group: "Infield", x: 74, y: 38 },
    { key: "P", label: "P", posKey: "p", group: "Battery", x: 50, y: 39 },
    { key: "C", label: "C", posKey: "c", group: "Battery", x: 50, y: 49 },
  ],
};
