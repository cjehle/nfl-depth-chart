// sports/cbb.js — Men's College Basketball. No depth chart exists for college,
// so this shows the real roster by position, ordered by class (seniors first),
// clearly labeled as roster order — not verified starters.
const TEAMS = require("../data/cbb-teams.json");

module.exports = {
  key: "cbb",
  name: "College Basketball",
  emoji: "🏀",
  title: "College Hoops Rosters on the Court",
  tagline: "A team's roster by position on the court — click any spot for everyone there. Roster order (seniors first), not verified starters.",
  surface: "court",
  espn: { sport: "basketball", league: "mens-college-basketball" },
  kind: "roster",
  classYears: true,
  note: "Roster by class (seniors first) · not a verified depth chart · via ESPN",
  defaults: { a: "305", b: "193" }, // DePaul (home) vs Miami (OH)
  teams: TEAMS,
  bucket: (pos) => { const a = (pos || "").toUpperCase(); if (a === "C") return "center"; if (a === "G" || a.endsWith("G")) return "guard"; return "forward"; },
  bio: (a) => ({ extra: [a.birthPlace?.city, a.birthPlace?.state].filter(Boolean).join(", "), pos: a.position?.abbreviation || "" }),
  layout: [
    { key: "C", label: "Center", bucket: "center", faceRank: 1, group: "Center", x: 50, y: 14 },
    { key: "PF", label: "Forward", bucket: "forward", faceRank: 2, group: "Forwards", x: 27, y: 22 },
    { key: "SF", label: "Forward", bucket: "forward", faceRank: 1, group: "Forwards", x: 74, y: 28 },
    { key: "SG", label: "Guard", bucket: "guard", faceRank: 2, group: "Guards", x: 20, y: 42 },
    { key: "PG", label: "Guard", bucket: "guard", faceRank: 1, group: "Guards", x: 55, y: 47 },
  ],
};
