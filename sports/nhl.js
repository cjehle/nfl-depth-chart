// sports/nhl.js — NHL config. ESPN serves a real ranked depth chart
// (positions c/lw/rw/d/g), so this is a "depth" sport.
const TEAMS = require("../data/teams.json").nhl;

const birthplace = (a) => {
  const b = a.birthPlace || {};
  return [b.city, b.state || b.country].filter(Boolean).join(", ");
};

module.exports = {
  key: "nhl",
  name: "NHL",
  emoji: "🏒",
  title: "NHL Starting Lineups on the Ice",
  tagline: "Two teams' starting lines on the rink — click any player for the full depth chart at that position.",
  surface: "rink",
  espn: { sport: "hockey", league: "nhl" },
  // ESPN's NHL depth chart is unmaintained (it returns retired players), so we
  // rank the real current roster by last season's production instead.
  kind: "statrank",
  note: "Lines projected from last season's production · roster & stats via ESPN",
  defaults: { a: "2", b: "1" }, // Buffalo Sabres vs Boston Bruins
  teams: TEAMS,
  bio: (a) => ({ extra: birthplace(a), pos: a.position?.abbreviation || "" }),
  // On-ice spots for one team (own net at top, attacking downward toward center).
  layout: [
    { key: "LW", label: "Left Wing", posKey: "lw", group: "Forwards", x: 26, y: 42 },
    { key: "C", label: "Center", posKey: "c", group: "Forwards", x: 50, y: 47 },
    { key: "RW", label: "Right Wing", posKey: "rw", group: "Forwards", x: 74, y: 42 },
    { key: "LD", label: "Defenseman", posKey: "d", group: "Defense", faceRank: 1, x: 37, y: 24 },
    { key: "RD", label: "Defenseman", posKey: "d", group: "Defense", faceRank: 2, x: 63, y: 24 },
    { key: "G", label: "Goalie", posKey: "g", group: "Goalie", x: 50, y: 12 },
  ],
};
