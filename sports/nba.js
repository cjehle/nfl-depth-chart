// sports/nba.js — NBA config. ESPN serves a real ranked depth chart
// (positions pg/sg/sf/pf/c), so this is a "depth" sport.
const TEAMS = require("../data/teams.json").nba;

module.exports = {
  key: "nba",
  name: "NBA",
  emoji: "🏀",
  title: "NBA Starting Fives on the Court",
  tagline: "Two teams' starting fives on the court — click any player for the full depth chart at that position.",
  surface: "court",
  espn: { sport: "basketball", league: "nba" },
  kind: "depth",
  note: "Age, bio & depth chart via ESPN",
  defaults: { a: "13", b: "2" }, // Lakers vs Celtics
  teams: TEAMS,
  bio: (a) => ({ extra: (a.college && a.college.name) || "", pos: a.position?.abbreviation || "" }),
  // Half-court spots for one team (own basket at top, ball brought up toward center).
  layout: [
    { key: "C", label: "Center", posKey: "c", group: "Center", x: 50, y: 18 },
    { key: "PF", label: "Power Forward", posKey: "pf", group: "Forwards", x: 28, y: 27 },
    { key: "SF", label: "Small Forward", posKey: "sf", group: "Forwards", x: 74, y: 32 },
    { key: "SG", label: "Shooting Guard", posKey: "sg", group: "Guards", x: 20, y: 45 },
    { key: "PG", label: "Point Guard", posKey: "pg", group: "Guards", x: 56, y: 49 },
  ],
};
