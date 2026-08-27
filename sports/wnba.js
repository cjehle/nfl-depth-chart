// sports/wnba.js — WNBA. ESPN serves no WNBA depth chart, so this shows the
// real roster by position on the court (ordered by experience), with age +
// college. Clearly labeled "roster by position — not verified starters."
const TEAMS = require("../data/wnba-teams.json");

module.exports = {
  key: "wnba",
  name: "WNBA",
  emoji: "🏀",
  title: "WNBA Rosters on the Court",
  tagline: "A team's roster by position on the court — click any spot for everyone there. Roster order, not verified starters.",
  surface: "court",
  espn: { sport: "basketball", league: "wnba" },
  kind: "roster",
  rosterLabel: "roster by position",
  note: "Roster by position · not a verified depth chart · via ESPN",
  defaults: { a: "19", b: "5" }, // Chicago Sky vs Indiana Fever
  teams: TEAMS,
  bucket: (pos) => { const a = (pos || "").toUpperCase(); if (a === "C") return "center"; if (a === "G" || a.endsWith("G")) return "guard"; return "forward"; },
  bio: (a) => ({ extra: (a.college && a.college.name) || "", pos: a.position?.abbreviation || "" }),
  layout: [
    { key: "C", label: "Center", bucket: "center", faceRank: 1, group: "Center", x: 50, y: 14 },
    { key: "PF", label: "Forward", bucket: "forward", faceRank: 2, group: "Forwards", x: 27, y: 22 },
    { key: "SF", label: "Forward", bucket: "forward", faceRank: 1, group: "Forwards", x: 74, y: 28 },
    { key: "SG", label: "Guard", bucket: "guard", faceRank: 2, group: "Guards", x: 20, y: 42 },
    { key: "PG", label: "Guard", bucket: "guard", faceRank: 1, group: "Guards", x: 55, y: 47 },
  ],
};
