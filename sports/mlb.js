// sports/mlb.js — Major League Baseball. ESPN serves a real, current depth
// chart per position, so this is a "depth" sport (like NBA). Shown on a diamond.
const TEAMS = require("../data/mlb-teams.json");

module.exports = {
  key: "mlb",
  name: "MLB",
  emoji: "⚾",
  title: "MLB Lineups on the Diamond",
  tagline: "One team's lineup on the diamond — click any position for the full depth chart there.",
  surface: "diamond",
  espn: { sport: "baseball", league: "mlb" },
  kind: "depth",
  singleTeam: true, // baseball shows ONE team's nine across the full diamond (not two)
  note: "Age, bio & depth chart via ESPN",
  defaults: { a: "16", b: "8" }, // Chicago Cubs (single-team default) — b kept for parity
  teams: TEAMS,
  bio: (a) => ({
    extra: `B/T ${a.bats?.abbreviation || "–"}/${a.throws?.abbreviation || "–"}`,
    pos: a.position?.abbreviation || "",
  }),
  // The nine fielders across a FULL diamond (single team): outfield fanned across
  // the top, infielders around the bases, pitcher on the mound, catcher at home
  // plate near the bottom. (The DH bats only, so it isn't on the field — still in
  // the List view / depth chart.) Home plate ≈ (50,80); the infield diamond's
  // vertices are 1B (74,56), 2B (50,32), 3B (26,56).
  layout: [
    { key: "CF", label: "CF", posKey: "cf", group: "Outfield", x: 50, y: 12 },
    { key: "LF", label: "LF", posKey: "lf", group: "Outfield", x: 20, y: 20 },
    { key: "RF", label: "RF", posKey: "rf", group: "Outfield", x: 80, y: 20 },
    { key: "SS", label: "SS", posKey: "ss", group: "Infield", x: 38, y: 40 },
    { key: "2B", label: "2B", posKey: "2b", group: "Infield", x: 62, y: 40 },
    { key: "3B", label: "3B", posKey: "3b", group: "Infield", x: 26, y: 53 },
    { key: "1B", label: "1B", posKey: "1b", group: "Infield", x: 74, y: 53 },
    { key: "P", label: "P", posKey: "p", group: "Battery", x: 50, y: 58 },
    { key: "C", label: "C", posKey: "c", group: "Battery", x: 50, y: 86 },
  ],
};
