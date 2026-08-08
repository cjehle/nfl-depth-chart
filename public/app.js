// app.js — runs in the browser. Talks to our server, draws the field.

// ---------------------------------------------------------------------------
// PERSONNEL / FORMATION OPTIONS (the two new dropdowns)
//
// Offensive "personnel" is written as two digits: (# running backs)(# tight
// ends). Whatever is left of the 5 skill spots becomes wide receivers. Every
// grouping also has the 5 offensive linemen + the QB.
// ---------------------------------------------------------------------------
const OFFENSE_PERSONNEL = {
  "11": { short: "11 personnel", label: "11 personnel · 1 RB, 1 TE, 3 WR", rb: 1, te: 1, wr: 3 },
  "12": { short: "12 personnel", label: "12 personnel · 1 RB, 2 TE, 2 WR", rb: 1, te: 2, wr: 2 },
  "10": { short: "10 personnel", label: "10 personnel · 1 RB, 0 TE, 4 WR", rb: 1, te: 0, wr: 4 },
  "21": { short: "21 personnel", label: "21 personnel · 2 RB, 1 TE, 2 WR", rb: 2, te: 1, wr: 2 },
  "13": { short: "13 personnel", label: "13 personnel · 1 RB, 3 TE, 1 WR", rb: 1, te: 3, wr: 1 },
};
const OFFENSE_PERSONNEL_ORDER = ["11", "12", "10", "21", "13"];

// Defensive formations change how many linebackers vs defensive backs are out
// there. ESPN only publishes each team's BASE defense, so the sub-packages are
// built by convention: drop linebackers and add defensive backs (or, for goal
// line, add defensive linemen), pulling the next players down the depth chart.
// `lbRemove` / `dlAdd` are relative to the team's base front (3-4 or 4-3).
const DEFENSE_FORMATION = {
  base:     { short: "Base",             label: "Base · 4-3 / 3-4",       lbRemove: 0, dlAdd: 0 },
  nickel:   { short: "Nickel",           label: "Nickel · 5 DB",          lbRemove: 1, dlAdd: 0 },
  dime:     { short: "Dime",             label: "Dime · 6 DB",            lbRemove: 2, dlAdd: 0 },
  quarter:  { short: "Quarter/Prevent",  label: "Quarter / Prevent · 7 DB", lbRemove: 3, dlAdd: 0 },
  goalline: { short: "Goal Line",        label: "Goal Line · heavy front", lbRemove: 0, dlAdd: 2 },
};
const DEFENSE_FORMATION_ORDER = ["base", "nickel", "dime", "quarter", "goalline"];

// ---------------------------------------------------------------------------
// COORDINATE SLOTS
// x = 0 (left) .. 100 (right). Here y means "closer to the line of scrimmage
// as y goes UP"; renderSide() flips it with (100 - y) because defense is drawn
// on top and offense on the bottom, and they meet in the middle.
// ---------------------------------------------------------------------------
const OL_SLOTS = { lt: 30, lg: 41, c: 50, rg: 59, rt: 70 }; // x for each lineman, y = 84
// WR order filled as needed: outside-left, outside-right, left slot, right slot.
const WR_SLOTS = [{ x: 7, y: 79 }, { x: 93, y: 79 }, { x: 23, y: 69 }, { x: 77, y: 69 }];
const TE_SLOTS = [{ x: 82, y: 84 }, { x: 18, y: 84 }, { x: 90, y: 76 }];
// Defensive back slots, filled in order: corners, safeties, nickel, extra backs.
const DB_SLOTS = [
  { x: 8, y: 24 }, { x: 92, y: 24 },   // corners
  { x: 38, y: 64 }, { x: 62, y: 64 },  // safeties
  { x: 18, y: 42 },                    // nickel
  { x: 82, y: 42 }, { x: 50, y: 74 }, { x: 30, y: 74 }, // dime / quarter backs
];

// Quick lookup: team id -> team info (name, abbr, color).
const TEAM_BY_ID = new Map(window.NFL_TEAMS.map((t) => [String(t.id), t]));

// Remember each player's age once we've looked it up, so we never fetch twice.
const ageCache = new Map(); // athleteId -> age (number) or null

// ESPN hosts every team logo at a predictable URL based on the abbreviation.
function logoUrl(abbr) {
  return `https://a.espncdn.com/i/teamlogos/nfl/500/${abbr.toLowerCase()}.png`;
}

// Turn "#rrggbb" into "rgba(r,g,b,alpha)" so we can make see-through tints.
function hexToRgba(hex, alpha) {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Escape text before dropping it into HTML (player names come from outside APIs).
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// Turn an injury status string into a CSS badge class.
function injuryClass(status) {
  if (!status) return null;
  const s = status.toLowerCase();
  if (s.includes("out") || s.includes("ir") || s.includes("reserve") || s.includes("pup"))
    return "out";
  if (s.includes("question") || s.includes("doubt")) return "questionable";
  return "other";
}

// ---------------------------------------------------------------------------
// BUILD THE TWO DROPDOWNS from the shared team list (window.NFL_TEAMS).
// ---------------------------------------------------------------------------
function fillDropdown(selectEl) {
  for (const team of window.NFL_TEAMS) {
    const opt = document.createElement("option");
    opt.value = team.id;
    opt.textContent = team.name;
    selectEl.appendChild(opt);
  }
  selectEl.value = String(window.DEFAULT_TEAM_ID); // default Buffalo
}

// ---------------------------------------------------------------------------
// FETCH one team's tidy data from our own server.
// ---------------------------------------------------------------------------
async function fetchTeam(teamId, year, fresh) {
  const res = await fetch(`/api/depth?team=${teamId}&year=${year}${fresh ? "&fresh=1" : ""}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

// ---------------------------------------------------------------------------
// HELPERS for building a lineup out of the depth-chart data
// ---------------------------------------------------------------------------
// Spread n items evenly across x, from minX to maxX.
function spreadX(n, minX, maxX) {
  if (n <= 1) return [(minX + maxX) / 2];
  const step = (maxX - minX) / (n - 1);
  return Array.from({ length: n }, (_, i) => minX + step * i);
}

// Flatten a position's slots into one depth list, starter first.
function flatten(pos) {
  if (!pos) return [];
  return pos.spots.flatMap((s) => s.players).slice().sort((a, b) => a.rank - b.rank);
}

// Which broad category a defensive position key belongs to.
function defCategory(key) {
  if (/^(lde|rde|nt|ldt|rdt|de|dt|dl)$/.test(key)) return "DL";
  if (/(lb$)|mike|will|sam/.test(key)) return "LB"; // wlb, slb, mlb, lilb, rilb, lolb...
  if (/^(lcb|rcb|cb)$/.test(key)) return "CB";
  if (/^(ss|fs|s)$/.test(key)) return "S";
  if (key === "nb") return "NB";
  return null;
}

// When we trim linebackers for sub-packages, keep the edge rushers first.
function lbRank(key) {
  return /^(wlb|slb|lolb|rolb|olb)$/.test(key) ? 0 : 1;
}

// Wide-receiver spots. ESPN lists 3 WR "slots" (WR1, WR2, slot) each with its
// own backups, so we use those directly — that keeps each chip's depth list
// short and real. If we need a 4th WR (10 personnel), we borrow the next-best
// receiver off the bench.
function wrSpots(pos, n) {
  if (!pos) return [];
  const slots = pos.spots
    .slice()
    .sort((a, b) => a.players[0].rank - b.players[0].rank)
    .map((s) => s.players);
  if (n > slots.length) {
    const starterRanks = new Set(slots.map((list) => list[0].rank));
    const extras = flatten(pos).filter((p) => !starterRanks.has(p.rank));
    let i = 0;
    while (slots.length < n && i < extras.length) slots.push([extras[i++]]);
  }
  return slots.slice(0, n);
}

// ---------------------------------------------------------------------------
// BUILD THE OFFENSE for the chosen personnel grouping.
// Returns a list of chips: { label, players (depth list), x, y }.
// ---------------------------------------------------------------------------
function buildOffense(unit, code) {
  if (!unit) return [];
  const cfg = OFFENSE_PERSONNEL[code] || OFFENSE_PERSONNEL["11"];
  const P = unit.positions;
  const chips = [];
  const add = (label, players, x, y) => {
    if (players && players.length) chips.push({ label, players, x, y });
  };

  // Offensive line (always 5) + QB.
  for (const [key, x] of Object.entries(OL_SLOTS)) {
    if (P[key]) add(P[key].abbr, flatten(P[key]), x, 84);
  }
  if (P.qb) add("QB", flatten(P.qb), 50, 69);

  // Wide receivers: one chip per WR slot (each keeps its own short depth list).
  wrSpots(P.wr, cfg.wr).forEach((players, i) => {
    if (WR_SLOTS[i]) add("WR", players, WR_SLOTS[i].x, WR_SLOTS[i].y);
  });

  // Tight ends: the top N of the TE room.
  const te = flatten(P.te);
  for (let i = 0; i < cfg.te && i < TE_SLOTS.length; i++) {
    if (te[i]) add("TE", te.slice(i), TE_SLOTS[i].x, TE_SLOTS[i].y);
  }

  // Running backs. 21 personnel puts a fullback (or a 2nd back) in the backfield.
  const rb = flatten(P.rb);
  if (cfg.rb <= 1) {
    add("RB", rb, 50, 50);
  } else {
    add("RB", rb, 58, 49);
    const fb = flatten(P.fb);
    if (fb.length) add("FB", fb, 42, 57);
    else if (rb[1]) add("RB", rb.slice(1), 42, 57);
  }
  return chips;
}

// ---------------------------------------------------------------------------
// BUILD THE DEFENSE for the chosen formation.
// Base = the team's real base 11. Sub-packages swap linebackers for defensive
// backs; goal line adds linemen. Extra players come from down the depth chart.
// ---------------------------------------------------------------------------
function buildDefense(unit, code) {
  if (!unit) return [];
  const cfg = DEFENSE_FORMATION[code] || DEFENSE_FORMATION.base;
  const P = unit.positions;

  // Group base positions by category, keeping each position's depth list.
  const cats = { DL: [], LB: [], CB: [], S: [], NB: [] };
  for (const [key, pos] of Object.entries(P)) {
    // Past-season (nflverse) positions carry their own category; current-season
    // (ESPN) positions are classified from their key.
    const cat = pos.cat || defCategory(key);
    if (cat && cats[cat]) cats[cat].push({ key, abbr: pos.abbr, players: flatten(pos) });
  }

  const asSpot = (x) => ({ label: x.abbr, players: x.players });
  const backups = (arr) =>
    arr.map((x) => (x.players[1] ? { label: x.abbr, players: x.players.slice(1) } : null))
       .filter(Boolean);

  // Defensive line: base starters, then backups (used only for goal line).
  const dlPool = [...cats.DL.map(asSpot), ...backups(cats.DL)];
  const dlCount = cats.DL.length + cfg.dlAdd;

  // Linebackers: edge/outside first so trimming keeps the pass rush.
  const lbSorted = cats.LB.slice().sort((a, b) => lbRank(a.key) - lbRank(b.key));
  const lbPool = [...lbSorted.map(asSpot), ...backups(lbSorted)];
  const lbCount = Math.max(0, cats.LB.length - cfg.lbRemove);

  // Defensive backs: corners + safeties, then the nickel, then extra backs
  // pulled from corner/safety depth. Whatever it takes to get back to 11.
  const cbSorted = cats.CB.slice().sort((a, b) => a.key.localeCompare(b.key)); // lcb before rcb
  const dbPool = [
    ...cbSorted.map(asSpot),
    ...cats.S.map(asSpot),
    ...cats.NB.map(asSpot),
    ...backups([...cbSorted, ...cats.S]),
  ];
  const dbCount = Math.max(0, 11 - dlCount - lbCount);

  // Place everyone.
  const chips = [];
  const dlXs = spreadX(dlCount, dlCount >= 5 ? 18 : 32, dlCount >= 5 ? 82 : 68);
  dlPool.slice(0, dlCount).forEach((s, i) => chips.push({ ...s, x: dlXs[i], y: 15 }));

  const lbXs = spreadX(lbCount, lbCount >= 4 ? 18 : 28, lbCount >= 4 ? 82 : 72);
  lbPool.slice(0, lbCount).forEach((s, i) => chips.push({ ...s, x: lbXs[i], y: 36 }));

  dbPool.slice(0, dbCount).forEach((s, i) => {
    const slot = DB_SLOTS[i] || { x: 50, y: 80 };
    chips.push({ ...s, x: slot.x, y: slot.y });
  });

  return chips;
}

// ---------------------------------------------------------------------------
// Build one clickable player chip for a starter.
// ---------------------------------------------------------------------------
function makeChip(posAbbr, players, sideLabel) {
  const starter = players[0];
  const chip = document.createElement("div");
  chip.className = "chip";

  const badgeClass = injuryClass(starter.injury);
  const badgeHtml = badgeClass
    ? `<span class="badge ${badgeClass}">${esc(starter.injury)}</span>`
    : "";
  const depthCount = players.length - 1;
  const depthHtml = depthCount > 0 ? `<div class="depth-count">+${depthCount} behind</div>` : "";

  chip.innerHTML = `
    <div class="pos">${esc(posAbbr)} · #${esc(starter.jersey || "--")}</div>
    <div class="name">${esc(starter.name)}</div>
    ${badgeHtml}
    ${depthHtml}
  `;

  // You can drag a chip around its own half of the field; a plain click (no
  // real movement) opens the full depth chart for that spot.
  makeDraggable(chip, () => openDepth(`${sideLabel} — ${posAbbr}`, players));
  return chip;
}

// ---------------------------------------------------------------------------
// DRAGGING A CHIP
// A chip can only move inside its own container (its half of the field), so it
// physically cannot cross the line of scrimmage — offense stays below, defense
// stays above. If the pointer barely moved, we treat it as a click instead.
// ---------------------------------------------------------------------------
function makeDraggable(chip, onClick) {
  let dragging = false;
  let moved = false;
  let startX = 0, startY = 0;   // where the pointer went down
  let centerX = 0, centerY = 0; // chip center at drag start (px, within container)

  chip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    dragging = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    const box = chip.parentElement.getBoundingClientRect(); // the .players half
    const c = chip.getBoundingClientRect();
    centerX = c.left + c.width / 2 - box.left;
    centerY = c.top + c.height / 2 - box.top;
    // Capture keeps the drag working even if the pointer slips off the chip.
    try { chip.setPointerCapture(e.pointerId); } catch (_) {}
    chip.classList.add("dragging");
  });

  chip.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;

    const box = chip.parentElement.getBoundingClientRect();
    const halfW = chip.offsetWidth / 2;
    const halfH = chip.offsetHeight / 2;
    // Clamp the chip's center so the whole chip stays inside its half.
    const cx = Math.max(halfW, Math.min(box.width - halfW, centerX + dx));
    const cy = Math.max(halfH, Math.min(box.height - halfH, centerY + dy));
    chip.style.left = cx + "px";
    chip.style.top = cy + "px";
  });

  const finish = (e) => {
    if (!dragging) return;
    dragging = false;
    chip.classList.remove("dragging");
    try { chip.releasePointerCapture(e.pointerId); } catch (_) {}
    if (!moved) onClick(); // it was a click, not a drag
  };
  chip.addEventListener("pointerup", finish);
  chip.addEventListener("pointercancel", finish);
}

// ---------------------------------------------------------------------------
// Draw a pre-built list of chips into a half of the field.
// Each chip carries its own {x, y}; we flip y with (100 - y) because defense is
// on top and offense on the bottom, so both lines meet at the middle.
// ---------------------------------------------------------------------------
function renderSide(container, chips, sideLabel) {
  container.innerHTML = "";
  if (!chips.length) {
    container.innerHTML = `<p class="status">No lineup available.</p>`;
    return;
  }
  for (const ch of chips) {
    const chip = makeChip(ch.label, ch.players, sideLabel);
    chip.style.left = ch.x + "%";
    chip.style.top = 100 - ch.y + "%";
    container.appendChild(chip);
  }
}

// ---------------------------------------------------------------------------
// THE DEPTH-CHART POPOVER
// ---------------------------------------------------------------------------
const popover = document.getElementById("depth-popover");
const popoverTitle = document.getElementById("popover-title");
const popoverList = document.getElementById("popover-list");
const popoverNote = document.querySelector(".popover-note");

// A dark backdrop we can click to close the popover.
const backdrop = document.createElement("div");
backdrop.className = "backdrop hidden";
document.body.appendChild(backdrop);

function openDepth(title, players) {
  const season = players[0] && players[0].season;
  const now = new Date().getFullYear();
  popoverTitle.textContent = season ? `${title} · ${season}` : title;

  // Make it clear that age (and the Madden rating) reflect the chosen season.
  if (season && season !== now) {
    const hasOvr = players.some((p) => p.overall != null);
    popoverNote.textContent = hasOvr
      ? `Age & OVR are as of the ${season} season (Madden ${season - 1999}).`
      : `Age is as of the ${season} season. Madden ratings aren't available for ${season}.`;
  } else {
    popoverNote.textContent = "OVR = current Madden NFL rating (EA) · Age via ESPN";
  }

  popoverList.innerHTML = "";

  players.forEach((p, i) => {
    const li = document.createElement("li");
    if (i === 0) li.className = "starter"; // highlight the starter
    const badgeClass = injuryClass(p.injury);
    const badge = badgeClass ? `<span class="badge ${badgeClass}">${esc(p.injury)}</span>` : "";
    const ageKey = `${p.id}:${p.season || ""}`;
    // Past seasons already include age; current season fetches it lazily.
    const knownAge = p.age != null ? p.age
      : (p.id && ageCache.has(ageKey) ? ageCache.get(ageKey) : undefined);
    const ageText = knownAge != null ? `${knownAge} yrs` : "—";
    const ovrText = p.overall != null ? `${p.overall} OVR` : "—";
    li.innerHTML = `
      <span class="rank">${i + 1}</span>
      <span class="p-num">#${esc(p.jersey || "--")}</span>
      <span class="p-name">${esc(p.name)}</span>
      <span class="p-ovr">${ovrText}</span>
      <span class="p-age" data-id="${esc(p.id || "")}">${ageText}</span>
      ${badge}
    `;
    popoverList.appendChild(li);
  });

  popover.classList.remove("hidden");
  backdrop.classList.remove("hidden");
  fillAges(players); // fetch any ages we don't already have
}

// Look up ages for the players in the open popover (lazy + cached), then drop
// each one into its row when it arrives.
async function fillAges(players) {
  await Promise.all(
    players.map(async (p) => {
      if (!p.id || p.age != null) return; // already known (past seasons) or no id
      // Cache key includes the season so age reflects the year being viewed.
      const key = `${p.id}:${p.season || ""}`;
      if (!ageCache.has(key)) {
        try {
          const res = await fetch(`/api/player?id=${p.id}&year=${p.season || ""}`);
          ageCache.set(key, (await res.json()).age);
        } catch (_) {
          ageCache.set(key, null);
        }
      }
      const age = ageCache.get(key);
      popoverList
        .querySelectorAll(`.p-age[data-id="${p.id}"]`)
        .forEach((el) => { el.textContent = age != null ? `${age} yrs` : "—"; });
    })
  );
}

function closeDepth() {
  popover.classList.add("hidden");
  backdrop.classList.add("hidden");
}
document.getElementById("popover-close").addEventListener("click", closeDepth);
backdrop.addEventListener("click", closeDepth);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDepth();
});

// ---------------------------------------------------------------------------
// MAIN: load the currently selected teams and draw the field.
// ---------------------------------------------------------------------------
const offenseSelect = document.getElementById("offense-team");
const defenseSelect = document.getElementById("defense-team");
const personnelSelect = document.getElementById("personnel-select");
const formationSelect = document.getElementById("formation-select");
const offenseSeasonSelect = document.getElementById("offense-season");
const defenseSeasonSelect = document.getElementById("defense-season");
const statusEl = document.getElementById("status");

// Fill in one half's colored header band: team logo, name, formation, and the
// time the data was pulled. Also washes the half with the team's color.
function decorateHalf(teamId, unitWord, formationName, season, fetchedAt, labelEl, tintEl) {
  const team = TEAM_BY_ID.get(String(teamId));
  const color = (team && team.color) || "#333333";

  labelEl.style.background = hexToRgba(color, 0.92);
  labelEl.innerHTML = `
    <img src="${team ? logoUrl(team.abbr) : ""}" alt="" onerror="this.style.display='none'">
    <span>${team ? team.name : ""} ${unitWord} · ${formationName || ""} (${season || ""})</span>`;

  tintEl.style.background = `linear-gradient(${hexToRgba(color, 0.3)}, ${hexToRgba(color, 0.1)})`;
}

async function render(fresh) {
  closeDepth();
  statusEl.textContent = fresh
    ? "Refreshing from ESPN…"
    : "Loading latest lineups from ESPN…";

  const offenseId = offenseSelect.value;
  const defenseId = defenseSelect.value;
  const personnel = personnelSelect.value;
  const formation = formationSelect.value;
  const offenseYear = offenseSeasonSelect.value;
  const defenseYear = defenseSeasonSelect.value;

  try {
    // Fetch both sides at the same time (each with its own season).
    const [offData, defData] = await Promise.all([
      fetchTeam(offenseId, offenseYear, fresh),
      fetchTeam(defenseId, defenseYear, fresh),
    ]);

    // Build each lineup for the chosen personnel / formation.
    const offChips = buildOffense(offData.offense, personnel);
    const defChips = buildDefense(defData.defense, formation);

    decorateHalf(defenseId, "DEFENSE", DEFENSE_FORMATION[formation].short,
      defData.season, defData.fetchedAt,
      document.getElementById("defense-formation"), document.getElementById("defense-tint"));
    decorateHalf(offenseId, "OFFENSE", OFFENSE_PERSONNEL[personnel].short,
      offData.season, offData.fetchedAt,
      document.getElementById("offense-formation"), document.getElementById("offense-tint"));

    renderSide(document.getElementById("defense-players"), defChips, `${defData.teamAbbr} D`);
    renderSide(document.getElementById("offense-players"), offChips, `${offData.teamAbbr} O`);

    statusEl.textContent = "";
  } catch (err) {
    statusEl.textContent = "Could not load data: " + err.message;
  }
}

// Fill a personnel / formation dropdown from its config.
function fillOptions(selectEl, order, cfgMap, defaultKey) {
  for (const key of order) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = cfgMap[key].label;
    selectEl.appendChild(opt);
  }
  selectEl.value = defaultKey;
}

// Fill a season dropdown: the current season (live from ESPN) plus real
// historical seasons back to 2020 (from nflverse).
function fillSeasons(selectEl) {
  const now = new Date().getFullYear();
  const years = [now, 2025, 2024, 2023, 2022, 2021, 2020];
  for (const y of years) {
    const opt = document.createElement("option");
    opt.value = y;
    opt.textContent = y === now ? `${y} (current)` : `${y}`;
    selectEl.appendChild(opt);
  }
  selectEl.value = String(now);
}

// Refresh forces a brand-new pull from ESPN (skips the server's cache).
document.getElementById("refresh").addEventListener("click", () => render(true));
// Reset redraws everyone at their default spots (undoes any dragging).
document.getElementById("reset").addEventListener("click", () => render(false));
// Switching teams / personnel / formation just re-renders (cached, fast).
offenseSelect.addEventListener("change", () => render(false));
defenseSelect.addEventListener("change", () => render(false));
personnelSelect.addEventListener("change", () => render(false));
formationSelect.addEventListener("change", () => render(false));
offenseSeasonSelect.addEventListener("change", () => render(false));
defenseSeasonSelect.addEventListener("change", () => render(false));

// ---- start up ----
fillDropdown(offenseSelect);
fillDropdown(defenseSelect);
fillOptions(personnelSelect, OFFENSE_PERSONNEL_ORDER, OFFENSE_PERSONNEL, "11");
fillOptions(formationSelect, DEFENSE_FORMATION_ORDER, DEFENSE_FORMATION, "base");
fillSeasons(offenseSeasonSelect);
fillSeasons(defenseSeasonSelect);
render();
