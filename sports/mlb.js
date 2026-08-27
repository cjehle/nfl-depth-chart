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
  // Defensive positions on the diamond (own outfield at top, battery toward center).
  layout: [
    { key: "LF", label: "Left Field", posKey: "lf", group: "Outfield", x: 18, y: 12 },
    { key: "CF", label: "Center Field", posKey: "cf", group: "Outfield", x: 50, y: 8 },
    { key: "RF", label: "Right Field", posKey: "rf", group: "Outfield", x: 82, y: 12 },
    { key: "3B", label: "Third Base", posKey: "3b", group: "Infield", x: 20, y: 30 },
    { key: "SS", label: "Shortstop", posKey: "ss", group: "Infield", x: 38, y: 24 },
    { key: "2B", label: "Second Base", posKey: "2b", group: "Infield", x: 62, y: 24 },
    { key: "1B", label: "First Base", posKey: "1b", group: "Infield", x: 80, y: 30 },
    { key: "P", label: "Pitcher", posKey: "p", group: "Battery", x: 50, y: 38 },
    { key: "C", label: "Catcher", posKey: "c", group: "Battery", x: 50, y: 48 },
    { key: "DH", label: "Designated Hitter", posKey: "dh", group: "DH", x: 26, y: 46 },
  ],
};
