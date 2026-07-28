// teams.js
// The 32 NFL teams with their ESPN team IDs. These IDs are what ESPN's API
// uses to look up a specific team's roster and depth chart.
//
// This file is written so it works in BOTH places:
//   - the server (Node), via `module.exports`
//   - the browser (the page), via a global `window.NFL_TEAMS`
// so we only have to maintain the list once.

// `color` is each team's primary color (used for the field tint + header band).
// Logos are derived from `abbr` — see logoUrl() in app.js.
const NFL_TEAMS = [
  { id: 22, abbr: "ARI", name: "Arizona Cardinals", color: "#a40227" },
  { id: 1, abbr: "ATL", name: "Atlanta Falcons", color: "#a71930" },
  { id: 33, abbr: "BAL", name: "Baltimore Ravens", color: "#29126f" },
  { id: 2, abbr: "BUF", name: "Buffalo Bills", color: "#00338d" },
  { id: 29, abbr: "CAR", name: "Carolina Panthers", color: "#0085ca" },
  { id: 3, abbr: "CHI", name: "Chicago Bears", color: "#0b1c3a" },
  { id: 4, abbr: "CIN", name: "Cincinnati Bengals", color: "#fb4f14" },
  { id: 5, abbr: "CLE", name: "Cleveland Browns", color: "#472a08" },
  { id: 6, abbr: "DAL", name: "Dallas Cowboys", color: "#002a5c" },
  { id: 7, abbr: "DEN", name: "Denver Broncos", color: "#0a2343" },
  { id: 8, abbr: "DET", name: "Detroit Lions", color: "#0076b6" },
  { id: 9, abbr: "GB", name: "Green Bay Packers", color: "#204e32" },
  { id: 34, abbr: "HOU", name: "Houston Texans", color: "#00143f" },
  { id: 11, abbr: "IND", name: "Indianapolis Colts", color: "#003b75" },
  { id: 30, abbr: "JAX", name: "Jacksonville Jaguars", color: "#007487" },
  { id: 12, abbr: "KC", name: "Kansas City Chiefs", color: "#e31837" },
  { id: 13, abbr: "LV", name: "Las Vegas Raiders", color: "#000000" },
  { id: 24, abbr: "LAC", name: "Los Angeles Chargers", color: "#0080c6" },
  { id: 14, abbr: "LAR", name: "Los Angeles Rams", color: "#003594" },
  { id: 15, abbr: "MIA", name: "Miami Dolphins", color: "#008e97" },
  { id: 16, abbr: "MIN", name: "Minnesota Vikings", color: "#4f2683" },
  { id: 17, abbr: "NE", name: "New England Patriots", color: "#002a5c" },
  { id: 18, abbr: "NO", name: "New Orleans Saints", color: "#9f8958" },
  { id: 19, abbr: "NYG", name: "New York Giants", color: "#003c7f" },
  { id: 20, abbr: "NYJ", name: "New York Jets", color: "#115740" },
  { id: 21, abbr: "PHI", name: "Philadelphia Eagles", color: "#06424d" },
  { id: 23, abbr: "PIT", name: "Pittsburgh Steelers", color: "#000000" },
  { id: 25, abbr: "SF", name: "San Francisco 49ers", color: "#aa0000" },
  { id: 26, abbr: "SEA", name: "Seattle Seahawks", color: "#002a5c" },
  { id: 27, abbr: "TB", name: "Tampa Bay Buccaneers", color: "#bd1c36" },
  { id: 10, abbr: "TEN", name: "Tennessee Titans", color: "#4495d2" },
  { id: 28, abbr: "WSH", name: "Washington Commanders", color: "#5a1414" },
];

// Buffalo is the default team for both dropdowns.
const DEFAULT_TEAM_ID = 2;

// Export for Node (the server) if module.exports exists...
if (typeof module !== "undefined" && module.exports) {
  module.exports = { NFL_TEAMS, DEFAULT_TEAM_ID };
}
// ...and expose to the browser page as a global.
if (typeof window !== "undefined") {
  window.NFL_TEAMS = NFL_TEAMS;
  window.DEFAULT_TEAM_ID = DEFAULT_TEAM_ID;
}
