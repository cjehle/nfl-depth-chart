// lib/draft.js — NHL draft status looked up from a committed map
// (data/draft/nhl.json, name -> {y,r,o,t}), built by `npm run gen-draft`. Used by
// the college-hockey page to show whether a player was drafted (and by whom).
// Zero runtime NHL fetching.
const fs = require("fs");
const path = require("path");
const { normName } = require("./nfl-util.js");

let MAP = undefined;
function load() {
  if (MAP !== undefined) return MAP;
  try { MAP = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "draft", "nhl.json"), "utf8")); }
  catch { MAP = null; }
  return MAP;
}

// Draft record for a player name, or null if the map is missing.
// Returns { drafted:true, year, round, overall, team, label } when found,
// or { drafted:false, label:"Undrafted" } when not in the map.
function draftFor(name) {
  const m = load();
  if (!m || !name) return null;
  const d = m[normName(name)];
  if (!d) return { drafted: false, label: "Undrafted" };
  return { drafted: true, year: d.y, round: d.r, overall: d.o, team: d.t, label: `${d.t} · R${d.r} #${d.o} (${d.y})` };
}

module.exports = { draftFor };
