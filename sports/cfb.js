// sports/cfb.js — College Football. No depth chart exists for college, so this
// shows the real roster by position, ordered by class (seniors first), labeled
// as roster order — not verified starters. Dual-unit: one team's offense faces
// another team's defense (like the NFL view).
const TEAMS = require("../data/cfb-teams.json");

const OL = /^(OL|OT|OG|C|G|T|LT|RT|LG|RG|OC|IOL)$/;
const DL = /^(DL|DE|DT|NT|EDGE|NG)$/;
const LB = /^(LB|ILB|OLB|MLB|WLB|SLB|MIKE|WILL|SAM)$/;
const DB = /^(DB|CB|S|FS|SS|SAF|NB|NCB)$/;

// Field-spot builder. Surface convention: higher y = closer to the line of
// scrimmage (offense on the bottom half, defense on the top). Each package below
// pulls the Nth-ranked player (faceRank) of a bucket into a fixed spot; the whole
// bucket rides along as that spot's depth list.
const P = (key, label, bucket, faceRank, group, x, y) => ({ key, label, bucket, faceRank, group, x, y });
const OLINE = [
  P("LT", "OL", "ol", 1, "O-Line", 30, 88), P("LG", "OL", "ol", 2, "O-Line", 41, 88),
  P("C", "OL", "ol", 3, "O-Line", 50, 88), P("RG", "OL", "ol", 4, "O-Line", 59, 88),
  P("RT", "OL", "ol", 5, "O-Line", 70, 88),
];
const DLINE4 = [P("DL1", "DL", "dl", 1, "D-Line", 20, 88), P("DL2", "DL", "dl", 2, "D-Line", 40, 88), P("DL3", "DL", "dl", 3, "D-Line", 60, 88), P("DL4", "DL", "dl", 4, "D-Line", 80, 88)];
const DLINE3 = [P("DL1", "DL", "dl", 1, "D-Line", 28, 88), P("DL2", "DL", "dl", 2, "D-Line", 50, 88), P("DL3", "DL", "dl", 3, "D-Line", 72, 88)];
const CB2 = [P("DB1", "DB", "db", 1, "Secondary", 9, 80), P("DB2", "DB", "db", 2, "Secondary", 91, 80)]; // outside corners

// Offense personnel groupings (1st digit = RBs, 2nd = TEs; the rest are WRs).
const OFF = {
  "11": [...OLINE, P("QB", "QB", "qb", 1, "Backfield", 50, 73), P("RB", "RB", "rb", 1, "Backfield", 50, 60), P("TE", "TE", "te", 1, "Receivers", 79, 86), P("WR1", "WR", "wr", 1, "Receivers", 9, 88), P("WR2", "WR", "wr", 2, "Receivers", 91, 88), P("WR3", "WR", "wr", 3, "Receivers", 23, 81)],
  "12": [...OLINE, P("QB", "QB", "qb", 1, "Backfield", 50, 73), P("RB", "RB", "rb", 1, "Backfield", 50, 60), P("TE1", "TE", "te", 1, "Receivers", 79, 86), P("TE2", "TE", "te", 2, "Receivers", 21, 86), P("WR1", "WR", "wr", 1, "Receivers", 9, 88), P("WR2", "WR", "wr", 2, "Receivers", 91, 88)],
  "21": [...OLINE, P("QB", "QB", "qb", 1, "Backfield", 50, 74), P("RB", "RB", "rb", 1, "Backfield", 44, 60), P("FB", "FB", "rb", 2, "Backfield", 56, 66), P("TE", "TE", "te", 1, "Receivers", 79, 86), P("WR1", "WR", "wr", 1, "Receivers", 9, 88), P("WR2", "WR", "wr", 2, "Receivers", 91, 88)],
  "10": [...OLINE, P("QB", "QB", "qb", 1, "Backfield", 50, 73), P("RB", "RB", "rb", 1, "Backfield", 50, 60), P("WR1", "WR", "wr", 1, "Receivers", 8, 88), P("WR2", "WR", "wr", 2, "Receivers", 92, 88), P("WR3", "WR", "wr", 3, "Receivers", 20, 82), P("WR4", "WR", "wr", 4, "Receivers", 80, 82)],
};
// Defensive fronts (DL–LB–DB counts).
const DEF = {
  "base": [...DLINE4, P("LB1", "LB", "lb", 1, "Linebackers", 28, 72), P("LB2", "LB", "lb", 2, "Linebackers", 50, 72), P("LB3", "LB", "lb", 3, "Linebackers", 72, 72), ...CB2, P("DB3", "DB", "db", 3, "Secondary", 38, 56), P("DB4", "DB", "db", 4, "Secondary", 62, 56)],
  "nickel": [...DLINE4, P("LB1", "LB", "lb", 1, "Linebackers", 35, 72), P("LB2", "LB", "lb", 2, "Linebackers", 65, 72), ...CB2, P("DB3", "DB", "db", 3, "Secondary", 30, 60), P("DB4", "DB", "db", 4, "Secondary", 70, 60), P("DB5", "DB", "db", 5, "Secondary", 50, 52)],
  "dime": [...DLINE4, P("LB1", "LB", "lb", 1, "Linebackers", 50, 72), ...CB2, P("DB3", "DB", "db", 3, "Secondary", 28, 64), P("DB4", "DB", "db", 4, "Secondary", 72, 64), P("DB5", "DB", "db", 5, "Secondary", 40, 52), P("DB6", "DB", "db", 6, "Secondary", 60, 52)],
  "3-4": [...DLINE3, P("LB1", "LB", "lb", 1, "Linebackers", 14, 72), P("LB2", "LB", "lb", 2, "Linebackers", 38, 72), P("LB3", "LB", "lb", 3, "Linebackers", 62, 72), P("LB4", "LB", "lb", 4, "Linebackers", 86, 72), ...CB2, P("DB3", "DB", "db", 3, "Secondary", 38, 56), P("DB4", "DB", "db", 4, "Secondary", 62, 56)],
};

module.exports = {
  key: "cfb",
  name: "College Football",
  emoji: "🏈",
  title: "College Football Rosters on the Field",
  tagline: "One team's offense vs another's defense — click any spot for everyone at that position. Roster order (seniors first), not verified starters.",
  surface: "field",
  espn: { sport: "football", league: "college-football" },
  kind: "roster",
  classYears: true,
  dualUnit: true,
  // Defense on top, offense on the bottom — same orientation as the NFL page.
  units: ["defense", "offense"],
  unitLabels: ["Defense", "Offense"],
  note: "Roster by class (seniors first) · not a verified depth chart · via ESPN",
  defaults: { a: "195", b: "193" }, // Ohio (Bobcats) defense (top) vs Miami (OH) offense (bottom)
  teams: TEAMS,
  bucket: (pos) => {
    const a = (pos || "").toUpperCase();
    if (a === "QB") return "qb";
    if (/^(RB|HB|FB|TB)$/.test(a)) return "rb";
    if (a.startsWith("WR")) return "wr";
    if (a === "TE") return "te";
    if (OL.test(a)) return "ol";
    if (DL.test(a)) return "dl";
    if (LB.test(a)) return "lb";
    if (DB.test(a)) return "db";
    return null; // K/P/LS/ATH etc. — not placed on the field
  },
  bio: (a) => ({ extra: [a.birthPlace?.city, a.birthPlace?.state].filter(Boolean).join(", "), pos: a.position?.abbreviation || "" }),
  // Formations, per unit (like the NFL page): offense picks a personnel grouping,
  // defense picks a front. The client shows one dropdown on each side's controls;
  // the server re-arranges that unit's roster into the chosen package.
  formationMode: "unit",
  unitFormations: { offense: ["11", "12", "21", "10"], defense: ["base", "nickel", "dime", "3-4"] },
  unitFormationLabels: { offense: "Personnel", defense: "Front" },
  packages: { offense: OFF, defense: DEF },
  // Default look for each unit when no formation is chosen: 11 personnel / 4-3 base.
  layouts: { offense: OFF["11"], defense: DEF["base"] },
};
