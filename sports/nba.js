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
  // Typical starting five from recent box scores; falls back to ESPN's depth
  // chart when box data is thin (early season). seasonEndYear drives that fallback.
  kind: "boxstart",
  boxFallback: "depth",
  seasonEndYear: true, // ESPN labels NBA seasons by END year (2027 = 2026-27); roll over in the fall
  note: "Typical starting five (recent games) · via ESPN",
  defaults: { a: "4", b: "25" }, // Chicago Bulls (home) vs Oklahoma City Thunder
  teams: TEAMS,
  bucket: (pos) => { const a = (pos || "").toUpperCase(); if (a === "C") return "center"; if (a === "G" || a.endsWith("G")) return "guard"; return "forward"; },
  bio: (a) => ({ extra: (a.college && a.college.name) || "", pos: a.position?.abbreviation || "" }),
  // Half-court spots for one team (own basket at top, ball brought up toward
  // center). posKey feeds the depth-chart fallback; bucket feeds box-score starters.
  layout: [
    { key: "C", label: "Center", posKey: "c", bucket: "center", group: "Center", x: 50, y: 18 },
    { key: "PF", label: "Power Forward", posKey: "pf", bucket: "forward", group: "Forwards", x: 28, y: 27 },
    { key: "SF", label: "Small Forward", posKey: "sf", bucket: "forward", group: "Forwards", x: 74, y: 32 },
    { key: "SG", label: "Shooting Guard", posKey: "sg", bucket: "guard", group: "Guards", x: 20, y: 45 },
    { key: "PG", label: "Point Guard", posKey: "pg", bucket: "guard", group: "Guards", x: 56, y: 49 },
  ],
};
