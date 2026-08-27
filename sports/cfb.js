// sports/cfb.js — College Football. No depth chart exists for college, so this
// shows the real roster by position, ordered by class (seniors first), labeled
// as roster order — not verified starters. Dual-unit: one team's offense faces
// another team's defense (like the NFL view).
const TEAMS = require("../data/cfb-teams.json");

const OL = /^(OL|OT|OG|C|G|T|LT|RT|LG|RG|OC|IOL)$/;
const DL = /^(DL|DE|DT|NT|EDGE|NG)$/;
const LB = /^(LB|ILB|OLB|MLB|WLB|SLB|MIKE|WILL|SAM)$/;
const DB = /^(DB|CB|S|FS|SS|SAF|NB|NCB)$/;

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
  units: ["offense", "defense"],
  unitLabels: ["Offense", "Defense"],
  note: "Roster by class (seniors first) · not a verified depth chart · via ESPN",
  defaults: { a: "193", b: "193" }, // Miami (OH) offense vs Miami (OH) defense
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
  layouts: {
    offense: [
      { key: "LT", label: "OL", bucket: "ol", faceRank: 1, group: "O-Line", x: 30, y: 20 },
      { key: "LG", label: "OL", bucket: "ol", faceRank: 2, group: "O-Line", x: 41, y: 20 },
      { key: "C", label: "OL", bucket: "ol", faceRank: 3, group: "O-Line", x: 50, y: 20 },
      { key: "RG", label: "OL", bucket: "ol", faceRank: 4, group: "O-Line", x: 59, y: 20 },
      { key: "RT", label: "OL", bucket: "ol", faceRank: 5, group: "O-Line", x: 70, y: 20 },
      { key: "QB", label: "QB", bucket: "qb", faceRank: 1, group: "Backfield", x: 50, y: 33 },
      { key: "RB", label: "RB", bucket: "rb", faceRank: 1, group: "Backfield", x: 50, y: 43 },
      { key: "WR1", label: "WR", bucket: "wr", faceRank: 1, group: "Receivers", x: 9, y: 18 },
      { key: "WR2", label: "WR", bucket: "wr", faceRank: 2, group: "Receivers", x: 91, y: 18 },
      { key: "WR3", label: "WR", bucket: "wr", faceRank: 3, group: "Receivers", x: 22, y: 31 },
      { key: "TE", label: "TE", bucket: "te", faceRank: 1, group: "Receivers", x: 78, y: 24 },
    ],
    defense: [
      { key: "DL1", label: "DL", bucket: "dl", faceRank: 1, group: "D-Line", x: 20, y: 20 },
      { key: "DL2", label: "DL", bucket: "dl", faceRank: 2, group: "D-Line", x: 40, y: 20 },
      { key: "DL3", label: "DL", bucket: "dl", faceRank: 3, group: "D-Line", x: 60, y: 20 },
      { key: "DL4", label: "DL", bucket: "dl", faceRank: 4, group: "D-Line", x: 80, y: 20 },
      { key: "LB1", label: "LB", bucket: "lb", faceRank: 1, group: "Linebackers", x: 28, y: 32 },
      { key: "LB2", label: "LB", bucket: "lb", faceRank: 2, group: "Linebackers", x: 50, y: 32 },
      { key: "LB3", label: "LB", bucket: "lb", faceRank: 3, group: "Linebackers", x: 72, y: 32 },
      { key: "DB1", label: "DB", bucket: "db", faceRank: 1, group: "Secondary", x: 12, y: 44 },
      { key: "DB2", label: "DB", bucket: "db", faceRank: 2, group: "Secondary", x: 38, y: 44 },
      { key: "DB3", label: "DB", bucket: "db", faceRank: 3, group: "Secondary", x: 62, y: 44 },
      { key: "DB4", label: "DB", bucket: "db", faceRank: 4, group: "Secondary", x: 88, y: 44 },
    ],
  },
};
