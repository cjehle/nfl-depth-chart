// sports/wnba.js — WNBA. ESPN serves no WNBA depth chart, so this shows the
// real roster by position on the court (ordered by experience), with age +
// college. Clearly labeled "roster by position — not verified starters."
const TEAMS = require("../data/wnba-teams.json");

module.exports = {
  key: "wnba",
  name: "WNBA",
  emoji: "🏀",
  title: "WNBA Starting Fives on the Court",
  tagline: "Each team's typical starting five from recent box scores — click any spot for the full depth there.",
  surface: "court",
  espn: { sport: "basketball", league: "wnba" },
  // Typical starting five from recent box scores (ESPN has no WNBA depth chart);
  // falls back to roster-by-position if box data is unavailable.
  kind: "boxstart",
  rosterLabel: "roster by position",
  note: "Typical starting five (recent games) · via ESPN",
  defaults: { a: "19", b: "5" }, // Chicago Sky vs Indiana Fever
  teams: TEAMS,
  bucket: (pos) => { const a = (pos || "").toUpperCase(); if (a === "C") return "center"; if (a === "G" || a.endsWith("G")) return "guard"; return "forward"; },
  bio: (a) => ({ extra: (a.college && a.college.name) || "", pos: a.position?.abbreviation || "" }),
  layout: [
    { key: "C", label: "Center", bucket: "center", faceRank: 1, group: "Center", x: 50, y: 18 },
    { key: "PF", label: "Forward", bucket: "forward", faceRank: 2, group: "Forwards", x: 28, y: 27 },
    { key: "SF", label: "Forward", bucket: "forward", faceRank: 1, group: "Forwards", x: 74, y: 32 },
    { key: "SG", label: "Guard", bucket: "guard", faceRank: 2, group: "Guards", x: 20, y: 45 },
    { key: "PG", label: "Guard", bucket: "guard", faceRank: 1, group: "Guards", x: 56, y: 49 },
  ],
};
