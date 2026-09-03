// sports/mch.js — Men's College Hockey. No depth chart exists (like other
// college sports), so this shows the real roster by position on the rink.
// ESPN gives F/D/G only (no line split) and no class year, so it's ordered by
// name and clearly labeled "roster by position — not verified starters."
const TEAMS = require("../data/mch-teams.json");

module.exports = {
  key: "mch",
  name: "College Hockey",
  emoji: "🏒",
  title: "College Hockey Rosters on the Ice",
  tagline: "A team's roster by position on the rink — click any player for their NHL draft status. Roster order, not verified lines.",
  surface: "rink",
  espn: { sport: "hockey", league: "mens-college-hockey" },
  kind: "roster",
  classYears: true,
  draftStatus: true, // attach each player's NHL draft status (committed map, data/draft/nhl.json)
  rosterLabel: "roster by position",
  note: "Roster by position + NHL draft status · via ESPN & NHL",
  defaults: { a: "130", b: "193" }, // Michigan (populated) vs Miami (OH). Lead with Michigan: ESPN publishes no Miami OH hockey roster, so the known-empty side is team B (shows the "no lineup" empty state) instead of the first thing visitors see.
  teams: TEAMS,
  bucket: (pos) => { const a = (pos || "").toUpperCase(); if (a.startsWith("G")) return "goalie"; if (a.startsWith("D")) return "defense"; return "forward"; },
  bio: (a) => ({ extra: [a.birthPlace?.city, a.birthPlace?.state || a.birthPlace?.country].filter(Boolean).join(", "), pos: a.position?.abbreviation || "" }),
  layout: [
    { key: "F1", label: "Forward", bucket: "forward", faceRank: 1, group: "Forwards", x: 26, y: 42 },
    { key: "F2", label: "Forward", bucket: "forward", faceRank: 2, group: "Forwards", x: 50, y: 47 },
    { key: "F3", label: "Forward", bucket: "forward", faceRank: 3, group: "Forwards", x: 74, y: 42 },
    { key: "D1", label: "Defense", bucket: "defense", faceRank: 1, group: "Defense", x: 37, y: 24 },
    { key: "D2", label: "Defense", bucket: "defense", faceRank: 2, group: "Defense", x: 63, y: 24 },
    { key: "G", label: "Goalie", bucket: "goalie", faceRank: 1, group: "Goalie", x: 50, y: 12 },
  ],
};
