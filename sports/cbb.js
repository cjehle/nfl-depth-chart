// sports/cbb.js — Men's College Basketball. No depth chart exists for college,
// so this shows the real roster by position, ordered by class (seniors first),
// clearly labeled as roster order — not verified starters.
const TEAMS = require("../data/cbb-teams.json");

module.exports = {
  key: "cbb",
  name: "College Basketball",
  emoji: "🏀",
  title: "College Hoops Starting Fives on the Court",
  tagline: "Each team's typical starting five from recent box scores (roster by class in the offseason) — click any spot for the full list there.",
  surface: "court",
  espn: { sport: "basketball", league: "mens-college-basketball" },
  // Typical starting five from recent box scores (drops graduated players);
  // falls back to roster-by-class in the offseason / when box data is thin.
  kind: "boxstart",
  classYears: true,
  note: "Typical starting five (recent games), else roster by class · via ESPN",
  defaults: { a: "305", b: "193" }, // DePaul (home) vs Miami (OH)
  teams: TEAMS,
  bucket: (pos) => { const a = (pos || "").toUpperCase(); if (a === "C") return "center"; if (a === "G" || a.endsWith("G")) return "guard"; return "forward"; },
  bio: (a) => ({ extra: [a.birthPlace?.city, a.birthPlace?.state].filter(Boolean).join(", "), pos: a.position?.abbreviation || "" }),
  layout: [
    { key: "C", label: "Center", bucket: "center", faceRank: 1, group: "Center", x: 50, y: 18 },
    { key: "PF", label: "Forward", bucket: "forward", faceRank: 2, group: "Forwards", x: 28, y: 27 },
    { key: "SF", label: "Forward", bucket: "forward", faceRank: 1, group: "Forwards", x: 74, y: 32 },
    { key: "SG", label: "Guard", bucket: "guard", faceRank: 2, group: "Guards", x: 20, y: 45 },
    { key: "PG", label: "Guard", bucket: "guard", faceRank: 1, group: "Guards", x: 56, y: 49 },
  ],
};
