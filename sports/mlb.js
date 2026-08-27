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
  layout: [
    { key: "CF", label: "Center Field", posKey: "cf", group: "Outfield", x: 50, y: 7 },
    { key: "LF", label: "Left Field", posKey: "lf", group: "Outfield", x: 15, y: 14 },
    { key: "RF", label: "Right Field", posKey: "rf", group: "Outfield", x: 85, y: 14 },
    { key: "SS", label: "Shortstop", posKey: "ss", group: "Infield", x: 37, y: 25 },
    { key: "2B", label: "Second Base", posKey: "2b", group: "Infield", x: 63, y: 25 },
    { key: "P", label: "Pitcher", posKey: "p", group: "Battery", x: 50, y: 34 },
    { key: "3B", label: "Third Base", posKey: "3b", group: "Infield", x: 18, y: 36 },
    { key: "1B", label: "First Base", posKey: "1b", group: "Infield", x: 82, y: 36 },
    { key: "C", label: "Catcher", posKey: "c", group: "Battery", x: 50, y: 47 },
  ],
};
