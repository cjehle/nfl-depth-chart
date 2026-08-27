// scripts/gen-teams.js — regenerate the static team lists in data/*-teams.json.
// Zero dependencies (Node 20+ global fetch). Run: `npm run gen-teams`.
// Only needed after league realignment / expansion. Each list is written only if
// the fetch returns a sane number of teams, so a glitchy upstream pull can never
// blank a dropdown — it keeps the existing file instead.
const fs = require("fs");
const path = require("path");
const H = { "User-Agent": "Mozilla/5.0", Accept: "application/json" };
const DATA = path.join(__dirname, "..", "data");
const core = "https://sports.core.api.espn.com/v2/sports";
const site = "https://site.api.espn.com/apis/site/v2/sports";
const j = async (u) => { const r = await fetch(u, { headers: H }); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); };
const jt = async (u) => { try { return await j(u); } catch (e) { return { __e: String(e) }; } };
const norm = (t, conf) => ({ id: String(t.id), abbr: t.abbreviation || t.shortDisplayName, name: t.displayName, short: t.shortDisplayName || t.name, color: t.color ? `#${t.color}` : null, alt: t.alternateColor ? `#${t.alternateColor}` : null, logo: (t.logos && t.logos[0] && t.logos[0].href) || null, ...(conf ? { conf } : {}) });
const hslHex = (h, s, l) => { s /= 100; l /= 100; const k = (n) => (n + h / 30) % 12; const a = s * Math.min(l, 1 - l); const f = (n) => { const c = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); return Math.round(255 * c).toString(16).padStart(2, "0"); }; return `#${f(0)}${f(8)}${f(4)}`; };

function save(file, teams, min) {
  const p = path.join(DATA, file);
  if (!Array.isArray(teams) || teams.length < min) { console.error(`  SKIP ${file}: only ${teams ? teams.length : 0} teams (< ${min}) — keeping existing`); return; }
  fs.writeFileSync(p, JSON.stringify(teams, null, 1));
  console.error(`  wrote ${file}: ${teams.length}`);
}

async function fromList(sport, league) {
  const d = await jt(`${site}/${sport}/${league}/teams?limit=1000`);
  try { return d.sports[0].leagues[0].teams.map((x) => norm(x.team)).sort((a, b) => a.name.localeCompare(b.name)); } catch { return []; }
}
async function fromIds(sport, league, ids) { // NBA's list endpoint is flaky; fetch per id
  const out = [];
  for (const id of ids) { const d = await jt(`${site}/${sport}/${league}/teams/${id}`); if (!d.__e && d.team) out.push(norm(d.team)); }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
async function fromConferences(sport, league, confMap, { hashColors = false, season = 2025 } = {}) {
  const out = [], seen = new Set();
  for (const [cid, label] of Object.entries(confMap)) {
    const g = await jt(`${core}/${sport}/leagues/${league}/seasons/${season}/types/2/groups/${cid}`);
    if (g.__e || !g.teams?.$ref) continue;
    const tl = await jt(g.teams.$ref + (g.teams.$ref.includes("?") ? "&" : "?") + "limit=60");
    for (const it of (tl.items || [])) { const t = await jt(it.$ref); if (t.__e || seen.has(String(t.id))) continue; seen.add(String(t.id)); out.push(norm(t, label)); }
  }
  if (hashColors) for (const t of out) { if (!t.color) { const h = (Number(t.id) * 137) % 360; t.color = hslHex(h, 60, 40); t.alt = "#f0f4f8"; } }
  return out.sort((a, b) => a.conf.localeCompare(b.conf) || a.name.localeCompare(b.name));
}

(async () => {
  console.error("Regenerating team lists…");
  save("nhl-teams.json", await fromList("hockey", "nhl"), 30);
  save("mls-teams.json", await fromList("soccer", "usa.1"), 26);
  save("mlb-teams.json", await fromList("baseball", "mlb"), 28);
  save("wnba-teams.json", await fromList("basketball", "wnba"), 10);
  save("nba-teams.json", await fromIds("basketball", "nba", Array.from({ length: 30 }, (_, i) => i + 1)), 28);
  // College football: all FBS conferences (~134 teams). Group IDs verified against
  // ESPN's 2026 season. Pac-12 is included even while small (rebuilding).
  save("cfb-teams.json", await fromConferences("football", "college-football",
    { 1: "ACC", 151: "American", 4: "Big 12", 5: "Big Ten", 12: "C-USA", 18: "Independents", 15: "MAC", 17: "Mountain West", 9: "Pac-12", 8: "SEC", 37: "Sun Belt" },
    { season: 2026 }), 120);
  // College basketball: every D1 team (~362) straight from the teams endpoint.
  save("cbb-teams.json", await fromList("basketball", "mens-college-basketball"), 300);
  save("mch-teams.json", await fromConferences("hockey", "mens-college-hockey", { 52: "Hockey East", 62: "Big Ten", 63: "NCHC", 54: "CCHA", 61: "Atlantic Hockey", 53: "ECAC" }, { hashColors: true }), 40);
  console.error("Done. Review `git diff data/` before committing.");
})();
