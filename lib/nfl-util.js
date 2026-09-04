// lib/util.js
// ---------------------------------------------------------------------------
// Pure, dependency-free helpers used by the server. They're kept here (separate
// from all the HTTP/fetch plumbing) so they can be unit-tested in isolation —
// see test/util.test.js.
// ---------------------------------------------------------------------------

// Split one CSV line into fields, honoring "quoted, with, commas" and doubled
// "" escapes, and dropping a trailing carriage return (Windows \r\n files).
function splitCsvLine(line) {
  const out = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { out.push(field); field = ""; }
    else field += ch;
  }
  out.push(field);
  return out.map((f) => (f.endsWith("\r") ? f.slice(0, -1) : f));
}

// Parse a CSV string into an array of row objects. Strips a UTF-8 BOM, handles quoted
// fields (including embedded newlines), and — when `wanted` is given (an array/Set of
// column names) — keeps ONLY those columns. Single pass: unwanted columns are never
// stored and no full field-array-per-row is materialized, so a huge file (players.csv:
// ~25k rows × 39 cols) doesn't allocate ~1M throwaway strings/arrays just to drop them.
function parseCsv(text, wanted) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  const want = wanted ? new Set(wanted) : null;
  const out = [];
  let header = null, keep = null; // header names + per-column keep flags (set after row 0)
  let field = "", col = 0, inQuotes = false, obj = header ? {} : [], nonEmpty = false;
  const pushField = () => {
    if (!header) obj.push(field);                                          // building the header row
    else if (col < header.length && (!keep || keep[col])) obj[header[col]] = field; // data row: kept cols only
    if (field !== "") nonEmpty = true;
    field = ""; col++;
  };
  const endRow = () => {
    pushField();
    if (!header) { header = obj; keep = want ? header.map((h) => want.has(h)) : null; }
    else if (nonEmpty || col > 1) out.push(obj); // skip blank lines (mirrors the old row.length gate)
    obj = header ? {} : []; col = 0; nonEmpty = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") pushField();
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; endRow(); }
    else field += ch;
  }
  if (field !== "" || col > 0) endRow(); // trailing record with no final newline
  return out;
}

// Normalize a player name so spellings line up across sources: lowercase, drop
// accents (José -> jose), strip punctuation and Jr./Sr./III suffixes.
function normName(s) {
  return (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // combining accent marks (José -> jose)
    .toLowerCase()
    .replace(/[.,'’]/g, "") // periods, commas, straight + curly apostrophes
    .replace(/\s+(jr|sr|iii|ii|iv|v)$/, "")
    .trim();
}

// How old a player was as of the start (Sept 1) of a given NFL season.
function ageFromDob(dob, year) {
  if (!dob) return null;
  const born = new Date(dob);
  if (isNaN(born.getTime())) return null;
  const ref = new Date(Date.UTC(year, 8, 1)); // Sept 1 of that season
  let age = ref.getUTCFullYear() - born.getUTCFullYear();
  const m = ref.getUTCMonth() - born.getUTCMonth();
  if (m < 0 || (m === 0 && ref.getUTCDate() < born.getUTCDate())) age--;
  return age >= 0 && age < 70 ? age : null;
}

// nflverse offense position code -> our field key (LT/LOT->lt, HB->rb, etc.).
function offenseKey(code) {
  const c = (code || "").trim().toUpperCase();
  if (c === "QB") return "qb";
  if (c === "RB" || c === "HB") return "rb";
  if (c === "FB") return "fb";
  if (c === "TE") return "te";
  if (c.startsWith("WR")) return "wr";
  if (c === "LT" || c === "LOT") return "lt";
  if (c === "LG") return "lg";
  if (c === "C") return "c";
  if (c === "RG") return "rg";
  if (c === "RT" || c === "ROT") return "rt";
  return null;
}

// Which defensive bucket a position code belongs to (DL/LB/CB/S/NB), or null.
function defenseCat(code) {
  const c = (code || "").trim().toUpperCase();
  if (!c || c === "LS") return null;
  if (["NB", "NCB", "NKL", "N"].includes(c)) return "NB"; // before CB (NCB ends in "CB")
  if (["LCB", "RCB", "CB"].includes(c) || c.endsWith("CB")) return "CB";
  if (["FS", "SS", "S", "SAF", "RS"].includes(c)) return "S";
  if (c.endsWith("LB") || ["MIKE", "WILL", "SAM"].includes(c)) return "LB";
  if (c.endsWith("DE") || c.endsWith("DT") || c.endsWith("DL") ||
      ["NT", "DL", "EDGE", "RUSH", "LE", "RE", "DE", "DT"].includes(c)) return "DL";
  return null;
}

// Group array rows into a Map by keyFn(row); rows whose key is falsy are dropped.
function groupBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

// Split a position's rows (which use nflverse "depth_team": 1=starter, 2/3=depth)
// into one column per starter, so a group like WR with three 1st-stringers
// becomes three on-field spots. `mkPlayer(row, rank)` builds each player object.
function splitIntoSpots(rows, mkPlayer) {
  rows = rows.slice().sort((a, b) => Number(a.depth_team) - Number(b.depth_team));
  const starterDepth = rows.length ? Number(rows[0].depth_team) : 1;
  const cols = Math.max(1, rows.filter((r) => Number(r.depth_team) === starterDepth).length);
  const spots = Array.from({ length: cols }, (_, i) => ({ slot: i + 1, players: [] }));
  rows.forEach((r, i) => spots[i % cols].players.push(mkPlayer(r, i + 1)));
  return spots.filter((s) => s.players.length);
}

// Shape a list of normalized entries { key, abbr, slot, rank, player } into the
// payload the browser draws. Offense keeps one position-key with multiple slots
// (WR = 3 receivers); defense makes one position per on-field starter and tags
// it with its bucket (DL/LB/CB/S/NB) so the client never has to guess.
function assembleUnit(entries, kind) {
  const positions = {};
  if (kind === "offense") {
    for (const [key, es] of groupBy(entries, (e) => e.key)) {
      const spots = [];
      for (const [slot, ses] of groupBy(es, (e) => String(e.slot))) {
        ses.sort((a, b) => a.rank - b.rank);
        spots.push({ slot: Number(slot), players: ses.map((e) => e.player) });
      }
      spots.sort((a, b) => a.slot - b.slot);
      positions[key] = { abbr: es[0].abbr, spots };
    }
  } else {
    for (const [k, es] of groupBy(entries, (e) => `${e.key}__${e.slot}`)) {
      es.sort((a, b) => a.rank - b.rank);
      const abbr = es[0].abbr;
      const cat = defenseCat(abbr) || defenseCat(es[0].key);
      if (!cat) continue;
      positions[k] = { abbr, cat, spots: [{ slot: 1, players: es.map((e) => e.player) }] };
    }
  }
  return positions;
}

module.exports = {
  splitCsvLine, parseCsv, normName, ageFromDob,
  offenseKey, defenseCat, groupBy, splitIntoSpots, assembleUnit,
};
