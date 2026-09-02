// app.js — runs in the browser. Talks to our server, draws the field.

// ---------------------------------------------------------------------------
// PERSONNEL / FORMATION OPTIONS
// Offensive "personnel" is (# RBs)(# TEs); the rest of the 5 skill spots are WRs.
// ---------------------------------------------------------------------------
const OFFENSE_PERSONNEL = {
  "11": { short: "11 personnel", label: "11 personnel · 1 RB, 1 TE, 3 WR", rb: 1, te: 1, wr: 3 },
  "12": { short: "12 personnel", label: "12 personnel · 1 RB, 2 TE, 2 WR", rb: 1, te: 2, wr: 2 },
  "10": { short: "10 personnel", label: "10 personnel · 1 RB, 0 TE, 4 WR", rb: 1, te: 0, wr: 4 },
  "21": { short: "21 personnel", label: "21 personnel · 2 RB, 1 TE, 2 WR", rb: 2, te: 1, wr: 2 },
  "13": { short: "13 personnel", label: "13 personnel · 1 RB, 3 TE, 1 WR", rb: 1, te: 3, wr: 1 },
};
const OFFENSE_PERSONNEL_ORDER = ["11", "12", "10", "21", "13"];

// Defensive formations swap linebackers for defensive backs (goal line adds a
// lineman). `lbRemove` / `dlAdd` are relative to the team's base front.
const DEFENSE_FORMATION = {
  base:     { short: "Base",            label: "Base · 4-3 / 3-4",         lbRemove: 0, dlAdd: 0 },
  nickel:   { short: "Nickel",          label: "Nickel · 5 DB",            lbRemove: 1, dlAdd: 0 },
  dime:     { short: "Dime",            label: "Dime · 6 DB",              lbRemove: 2, dlAdd: 0 },
  quarter:  { short: "Quarter/Prevent", label: "Quarter / Prevent · 7 DB", lbRemove: 3, dlAdd: 0 },
  goalline: { short: "Goal Line",       label: "Goal Line · heavy front",  lbRemove: 0, dlAdd: 2 },
};
const DEFENSE_FORMATION_ORDER = ["base", "nickel", "dime", "quarter", "goalline"];

// Special-teams position labels + the order we like to list them in.
const ST_LABELS = {
  pk: "Kicker", k: "Kicker", p: "Punter", ls: "Long Snapper", h: "Holder",
  kr: "Kick Returner", pr: "Punt Returner",
};
const ST_ORDER = ["pk", "k", "p", "ls", "h", "kr", "pr"];

// ---------------------------------------------------------------------------
// FIELD COORDINATES (all in one place). x = 0 (left)..100 (right). y means
// "closer to the line of scrimmage as y goes up"; renderSide flips with 100 - y.
// ---------------------------------------------------------------------------
const OFF = {
  olY: 84,
  ol: { lt: 30, lg: 41, c: 50, rg: 59, rt: 70 },
  qb: { x: 50, y: 69 },
  rb1: { x: 50, y: 50 },   // lone back
  rb2a: { x: 58, y: 49 },  // 21 personnel: two backs
  rb2b: { x: 42, y: 57 },
  wr: [{ x: 7, y: 79 }, { x: 93, y: 79 }, { x: 23, y: 69 }, { x: 77, y: 69 }],
  te: [{ x: 82, y: 84 }, { x: 18, y: 84 }, { x: 90, y: 76 }],
};
const DEF = {
  dlY: 15,
  lbY: 36,
  dlBounds: { few: [32, 68], many: [18, 82] }, // <5 vs >=5 linemen
  lbBounds: { few: [28, 72], many: [18, 82] }, // <4 vs >=4 backers
  db: [
    { x: 8, y: 24 }, { x: 92, y: 24 },   // corners
    { x: 38, y: 64 }, { x: 62, y: 64 },  // safeties
    { x: 18, y: 42 },                    // nickel
    { x: 82, y: 42 }, { x: 50, y: 74 }, { x: 30, y: 74 }, // dime / quarter backs
  ],
};

// Team roster + season config come from a NON-executed JSON data island the server
// inlines (<script type="application/json" id="sdc-nfl-teams">), so the page no longer
// needs the /nfl/teams.js <script>. If the island is missing/unparseable we fall back to
// the window.* globals teams.js used to set (defensive — keeps the page working either way).
const NFL_ISLAND = (() => {
  try { const el = document.getElementById("sdc-nfl-teams"); return el ? JSON.parse(el.textContent) : null; } catch { return null; }
})();
const NFL_TEAMS = (NFL_ISLAND && NFL_ISLAND.teams) || window.NFL_TEAMS;
const DEFAULT_TEAM_ID = (NFL_ISLAND && NFL_ISLAND.defaultId != null) ? NFL_ISLAND.defaultId : window.DEFAULT_TEAM_ID;
const SEASON = (NFL_ISLAND && NFL_ISLAND.season) || window.SEASON;
// The current NFL season year, computed client-side so the season rollover survives without a
// redeploy: Jan/Feb still belong to the prior year's season, everything else the current year.
const currentNflSeason = (now) => { const d = now || new Date(); return d.getMonth() < 2 ? d.getFullYear() - 1 : d.getFullYear(); };

// Quick lookup + small state.
const TEAM_BY_ID = new Map(NFL_TEAMS.map((t) => [String(t.id), t]));
let searchQuery = "";                // [A] player-search filter (lowercased)
let compareMode = false;             // [C] tap-two-players-to-compare mode
const pinned = { A: null, B: null }; // {face, teamName} pinned per side (A=offense, B=defense)
let popoverSeq = null;               // [D] ordered open sequence for prev/next stepping
let popoverIdx = -1;                 // index within popoverSeq of the open position
let pendingPos = null;               // [D] ?pos= deep-link to open once after the first render
const ageCache = new Map();          // `${id}:${season}` -> age|null
const sideCache = { offense: { key: null, data: null }, defense: { key: null, data: null } };
let popoverGen = 0;                  // bumped each time a popover opens (stale-write guard)
let renderGen = 0;                   // bumped each render (guards against out-of-order fetches)
let lastFocused = null;              // element to restore focus to when the modal closes

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function logoUrl(abbr) { return `https://a.espncdn.com/i/teamlogos/nfl/500/${abbr.toLowerCase()}.png`; }

// esc(), hexToRgba(), injuryClass(), relTime() now live in /common.js (shared with the
// surface app, loaded via <script src="/common.js" defer> before this file).

function spreadX(n, minX, maxX) {
  if (n <= 1) return [(minX + maxX) / 2];
  const step = (maxX - minX) / (n - 1);
  return Array.from({ length: n }, (_, i) => minX + step * i);
}

function flatten(pos) {
  if (!pos) return [];
  return pos.spots.flatMap((s) => s.players).slice().sort((a, b) => a.rank - b.rank);
}

// Keep outside/edge backers when trimming to a sub-package (uses the real abbr,
// which the server always provides — no key-guessing needed).
function isEdgeBacker(abbr) {
  return /^(WLB|SLB|OLB|LOLB|ROLB|SAM|WILL|EDGE|RUSH)$/.test((abbr || "").toUpperCase());
}

function wrSpots(pos, n) {
  if (!pos) return [];
  const slots = pos.spots.slice().sort((a, b) => a.players[0].rank - b.players[0].rank).map((s) => s.players);
  if (n > slots.length) {
    const starterRanks = new Set(slots.map((list) => list[0].rank));
    const extras = flatten(pos).filter((p) => !starterRanks.has(p.rank));
    let i = 0;
    while (slots.length < n && i < extras.length) slots.push([extras[i++]]);
  }
  return slots.slice(0, n);
}

// ---------------------------------------------------------------------------
// FETCH (with a per-side cache so switching personnel/formation — which are
// client-side transforms — never refetches the team that didn't change).
// ---------------------------------------------------------------------------
async function fetchTeam(teamId, year, fresh) {
  // Always ask for fresh data so the chart updates on every load. The server
  // coalesces this to at most one ESPN pull per team per ~60s, so it stays fast
  // and can't hammer ESPN even on rapid reloads.
  const res = await fetch(`/api/depth?team=${teamId}&year=${year}&fresh=1`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}
async function getSideData(sideName, teamId, year, fresh) {
  const key = `${teamId}:${year}`;
  const c = sideCache[sideName];
  if (!fresh && c.key === key && c.data) return c.data;
  const data = await fetchTeam(teamId, year, fresh);
  c.key = key; c.data = data;
  return data;
}

// ---------------------------------------------------------------------------
// BUILD LINEUPS -> chips: { label, players, x, y }
// ---------------------------------------------------------------------------
function buildOffense(unit, code) {
  if (!unit) return [];
  const cfg = OFFENSE_PERSONNEL[code] || OFFENSE_PERSONNEL["11"];
  const P = unit.positions;
  const chips = [];
  const add = (label, players, x, y) => { if (players && players.length) chips.push({ label, players, x, y }); };

  for (const [key, x] of Object.entries(OFF.ol)) if (P[key]) add(P[key].abbr, flatten(P[key]), x, OFF.olY);
  if (P.qb) add("QB", flatten(P.qb), OFF.qb.x, OFF.qb.y);

  wrSpots(P.wr, cfg.wr).forEach((players, i) => { if (OFF.wr[i]) add("WR", players, OFF.wr[i].x, OFF.wr[i].y); });

  const te = flatten(P.te);
  for (let i = 0; i < cfg.te && i < OFF.te.length; i++) if (te[i]) add("TE", te.slice(i), OFF.te[i].x, OFF.te[i].y);

  const rb = flatten(P.rb);
  if (cfg.rb <= 1) {
    add("RB", rb, OFF.rb1.x, OFF.rb1.y);
  } else {
    add("RB", rb, OFF.rb2a.x, OFF.rb2a.y);
    const fb = flatten(P.fb);
    if (fb.length) add("FB", fb, OFF.rb2b.x, OFF.rb2b.y);
    else if (rb[1]) add("RB", rb.slice(1), OFF.rb2b.x, OFF.rb2b.y);
  }
  return chips;
}

function buildDefense(unit, code) {
  if (!unit) return [];
  const cfg = DEFENSE_FORMATION[code] || DEFENSE_FORMATION.base;
  const P = unit.positions;

  const cats = { DL: [], LB: [], CB: [], S: [], NB: [] };
  for (const pos of Object.values(P)) {
    const cat = pos.cat; // server always tags defensive positions now
    if (cat && cats[cat]) cats[cat].push({ abbr: pos.abbr, players: flatten(pos) });
  }

  const asSpot = (x) => ({ label: x.abbr, players: x.players });
  const backups = (arr) => arr.map((x) => (x.players[1] ? { label: x.abbr, players: x.players.slice(1) } : null)).filter(Boolean);

  const dlPool = [...cats.DL.map(asSpot), ...backups(cats.DL)];
  const dlCount = cats.DL.length + cfg.dlAdd;

  const lbSorted = cats.LB.slice().sort((a, b) => (isEdgeBacker(a.abbr) ? 0 : 1) - (isEdgeBacker(b.abbr) ? 0 : 1));
  const lbPool = [...lbSorted.map(asSpot), ...backups(lbSorted)];
  const lbCount = Math.max(0, cats.LB.length - cfg.lbRemove);

  const cbSorted = cats.CB.slice().sort((a, b) => a.abbr.localeCompare(b.abbr)); // LCB before RCB
  const dbPool = [...cbSorted.map(asSpot), ...cats.S.map(asSpot), ...cats.NB.map(asSpot), ...backups([...cbSorted, ...cats.S])];
  const dbCount = Math.max(0, 11 - dlCount - lbCount);

  const chips = [];
  const dlXs = spreadX(dlCount, ...(dlCount >= 5 ? DEF.dlBounds.many : DEF.dlBounds.few));
  dlPool.slice(0, dlCount).forEach((s, i) => chips.push({ ...s, x: dlXs[i], y: DEF.dlY }));
  const lbXs = spreadX(lbCount, ...(lbCount >= 4 ? DEF.lbBounds.many : DEF.lbBounds.few));
  lbPool.slice(0, lbCount).forEach((s, i) => chips.push({ ...s, x: lbXs[i], y: DEF.lbY }));
  dbPool.slice(0, dbCount).forEach((s, i) => { const slot = DEF.db[i] || { x: 50, y: 80 }; chips.push({ ...s, x: slot.x, y: slot.y }); });
  return chips;
}

// ---------------------------------------------------------------------------
// LAYOUT PERSISTENCE (dragged positions), keyed by side+team+season+variant.
// ---------------------------------------------------------------------------
function loadLayouts() { try { return JSON.parse(localStorage.getItem("nfl.layout") || "{}"); } catch { return {}; } }
function saveLayouts(obj) { try { localStorage.setItem("nfl.layout", JSON.stringify(obj)); } catch {} }
let layouts = loadLayouts();

function persistChip(sig, chipKey, chip) {
  const box = chip.parentElement;
  const left = (parseFloat(chip.style.left) / box.clientWidth) * 100;
  const top = (parseFloat(chip.style.top) / box.clientHeight) * 100;
  if (!isFinite(left) || !isFinite(top)) return;
  (layouts[sig] = layouts[sig] || {})[chipKey] = { left: left + "%", top: top + "%" };
  saveLayouts(layouts);
}

// ---------------------------------------------------------------------------
// A CLICKABLE, KEYBOARD-ACCESSIBLE PLAYER CHIP
// ---------------------------------------------------------------------------
function makeChip(posAbbr, players, sideLabel, onMoved, teamColor, sideKey, teamName, posId) {
  const starter = players[0];
  const chip = document.createElement("div");
  chip.className = "chip";
  chip.tabIndex = 0;
  chip.dataset.name = (starter.name || "").toLowerCase(); // [A] search filters on this
  chip.setAttribute("role", "button");
  chip.setAttribute("aria-label", `${starter.name}, ${posAbbr}. Open depth chart.`);
  if (teamColor) chip.style.borderTopColor = teamColor; // team-colored accent bar

  const badgeClass = injuryClass(starter.injury);
  const badgeHtml = badgeClass ? `<span class="badge ${badgeClass}">${esc(starter.injury)}</span>` : "";
  const depthCount = players.length - 1;
  const depthHtml = depthCount > 0 ? `<div class="depth-count">+${depthCount} behind</div>` : "";
  chip.innerHTML = `
    <div class="pos">${esc(posAbbr)} · #${esc(starter.jersey || "--")}</div>
    <div class="name">${esc(starter.name)}</div>
    ${badgeHtml}
    ${depthHtml}
  `;

  const open = () => activateChip(players, `${sideLabel} — ${posAbbr}`, sideKey, teamName, starter, posId);
  chip.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  makeDraggable(chip, open, onMoved);
  return chip;
}
// A chip / list-row activation either opens the depth popover (stepping through the
// matchup's ordered position sequence so prev/next + deep-link work), or — in Compare
// mode — pins that player as their side (offense→A, defense→B) into the compare drawer.
function activateChip(players, title, sideKey, teamName, face, posId) {
  if (compareMode && sideKey) { pinPlayer(face || players[0], teamName, sideKey); return; }
  const seq = (render._state && render._state.seq) || [];
  const i = posId != null ? seq.findIndex((s) => s.posId === posId) : -1;
  if (i >= 0) openAt(seq, i); else openDepth(title, players);
}

// Drag within the chip's own half (can't cross the line of scrimmage). A tiny
// move counts as a click; a real move fires onMoved so the spot is remembered.
function makeDraggable(chip, onClick, onMoved) {
  let dragging = false, moved = false, startX = 0, startY = 0, cx0 = 0, cy0 = 0;
  // Geometry cached once at pointerdown so pointermove never reads layout (no reflow storm).
  let boxW = 0, boxH = 0, hw = 0, hh = 0, lastCX = 0, lastCY = 0;
  chip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    dragging = true; moved = false; startX = e.clientX; startY = e.clientY;
    const box = chip.parentElement.getBoundingClientRect();
    const c = chip.getBoundingClientRect();
    cx0 = c.left + c.width / 2 - box.left; cy0 = c.top + c.height / 2 - box.top;
    lastCX = cx0; lastCY = cy0;
    boxW = box.width; boxH = box.height; hw = chip.offsetWidth / 2; hh = chip.offsetHeight / 2;
    try { chip.setPointerCapture(e.pointerId); } catch {}
    chip.classList.add("dragging");
  });
  chip.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
    // Move via transform only (no left/top writes → no per-move layout). left/top stay at the
    // pre-drag values; we translate the CENTER by the clamped delta from the pointerdown center.
    lastCX = Math.max(hw, Math.min(boxW - hw, cx0 + dx));
    lastCY = Math.max(hh, Math.min(boxH - hh, cy0 + dy));
    chip.style.transform = "translate(-50%, -50%) translate(" + (lastCX - cx0) + "px, " + (lastCY - cy0) + "px)";
  });
  const finish = (e) => {
    if (!dragging) return;
    dragging = false;
    chip.classList.remove("dragging");
    try { chip.releasePointerCapture(e.pointerId); } catch {}
    if (moved) {
      // Bake the transform back into left/top so persistChip reads px, then reset the transform.
      chip.style.left = lastCX + "px";
      chip.style.top = lastCY + "px";
      chip.style.transform = "translate(-50%, -50%)";
      if (onMoved) onMoved();
    } else onClick();
  };
  chip.addEventListener("pointerup", finish);
  chip.addEventListener("pointercancel", finish);
}

// ---------------------------------------------------------------------------
// RENDER — field view
// ---------------------------------------------------------------------------
function renderSide(container, chips, sideLabel, sig, teamColor, sideKey, teamName, posPrefix) {
  container.innerHTML = "";
  if (!chips.length) {
    container.innerHTML = `<p class="status">No lineup available for this team/season.</p>`;
    return;
  }
  const saved = layouts[sig] || {};
  chips.forEach((ch, i) => {
    const chipKey = `${ch.label}#${i}`;
    const chip = makeChip(ch.label, ch.players, sideLabel, () => persistChip(sig, chipKey, chip), teamColor, sideKey, teamName, `${posPrefix}.${i}`);
    chip.style.left = ch.x + "%";
    chip.style.top = 100 - ch.y + "%";
    const pos = saved[chipKey];
    if (pos) { chip.style.left = pos.left; chip.style.top = pos.top; }
    container.appendChild(chip);
  });
}

// ---------------------------------------------------------------------------
// RENDER — list view (mobile-friendly, no horizontal scroll, a11y fallback)
// ---------------------------------------------------------------------------
function renderList(st) {
  const el = document.getElementById("list-view");
  el.innerHTML = "";
  // Defense first, then offense — matching the open-sequence order (seq) so prev/next
  // and deep-links line up with what the list shows.
  el.appendChild(listSection(st.defTitle, st.defChips, "defense", "B", (TEAM_BY_ID.get(st.defenseId) || {}).name, "def", `${st.defData.teamAbbr} D`));
  el.appendChild(listSection(st.offTitle, st.offChips, "offense", "A", (TEAM_BY_ID.get(st.offenseId) || {}).name, "off", `${st.offData.teamAbbr} O`));
}
// [F] a round headshot for a list row from the espn id (or a blank placeholder).
function listPhoto(id) {
  return id
    ? `<img class="list-photo" src="${esc(sized(`https://a.espncdn.com/i/headshots/nfl/players/full/${id}.png`, 40))}" width="34" height="34" decoding="async" loading="lazy" alt="">`
    : `<span class="list-photo list-photo-blank"></span>`;
}
function listSection(title, chips, sideName, sideKey, teamName, posPrefix, rowLabel) {
  const sec = document.createElement("section");
  sec.className = `list-section ${sideName}`;
  const h = document.createElement("h2");
  h.textContent = title;
  sec.appendChild(h);
  if (!chips.length) {
    const p = document.createElement("p");
    p.className = "status";
    p.textContent = "No lineup available for this team/season.";
    sec.appendChild(p);
    return sec;
  }
  chips.forEach((ch, i) => {
    const p = ch.players[0];
    const btn = document.createElement("button");
    btn.className = "list-row";
    btn.dataset.name = (p.name || "").toLowerCase(); // [A] search filters on this
    btn.setAttribute("aria-label", `${p.name}, ${ch.label}. Open depth chart.`);
    const badgeClass = injuryClass(p.injury);
    const badge = badgeClass ? `<span class="badge ${badgeClass}">${esc(p.injury)}</span>` : "";
    const depth = ch.players.length - 1 > 0 ? `<span class="list-depth">+${ch.players.length - 1}</span>` : "";
    const ovr = p.overall != null ? `<span class="list-ovr">${esc(p.overall)}</span>` : "";
    btn.innerHTML = `
      ${listPhoto(p.id)}
      <span class="list-pos">${esc(ch.label)}</span>
      <span class="list-name">${esc(p.name)} <span class="list-num">#${esc(p.jersey || "--")}</span></span>
      ${ovr}${badge}${depth}
    `;
    btn.addEventListener("click", () => activateChip(ch.players, `${rowLabel} — ${ch.label}`, sideKey, teamName, p, `${posPrefix}.${i}`));
    sec.appendChild(btn);
  });
  return sec;
}

// ---------------------------------------------------------------------------
// RENDER — special teams (both selected teams' kicking units)
// ---------------------------------------------------------------------------
function renderSpecialTeams(offData, defData) {
  const el = document.getElementById("st-view");
  el.innerHTML = "";
  el.appendChild(stSection(offData));
  if (defData.teamAbbr !== offData.teamAbbr || defData.season !== offData.season) {
    el.appendChild(stSection(defData));
  }
}
function stSection(data) {
  const sec = document.createElement("section");
  sec.className = "list-section";
  const h = document.createElement("h2");
  h.textContent = `${data.team} — Special Teams (${data.season})`;
  sec.appendChild(h);
  const unit = data.specialTeams;
  if (!unit || !Object.keys(unit.positions).length) {
    const p = document.createElement("p");
    p.className = "status";
    p.textContent = "No special-teams data for this team/season.";
    sec.appendChild(p);
    return sec;
  }
  const P = unit.positions;
  const keys = [
    ...ST_ORDER.filter((k) => P[k]),
    ...Object.keys(P).filter((k) => !ST_ORDER.includes(k)),
  ];
  for (const k of keys) {
    const players = flatten(P[k]); // starter first, then depth
    if (!players.length) continue;
    const label = ST_LABELS[k] || P[k].abbr;
    const p = players[0];
    const btn = document.createElement("button");
    btn.className = "list-row";
    btn.dataset.name = (p.name || "").toLowerCase(); // [A] search filters on this
    btn.setAttribute("aria-label", `${p.name}, ${label}. Open depth chart.`);
    const depth = players.length - 1 > 0 ? `<span class="list-depth">+${players.length - 1}</span>` : "";
    const ovr = p.overall != null ? `<span class="list-ovr">${esc(p.overall)}</span>` : "";
    btn.innerHTML = `
      ${listPhoto(p.id)}
      <span class="list-pos">${esc(label)}</span>
      <span class="list-name">${esc(p.name)} <span class="list-num">#${esc(p.jersey || "--")}</span></span>
      ${ovr}${depth}
    `;
    btn.addEventListener("click", () => openDepth(`${data.teamAbbr} ST — ${label}`, players));
    sec.appendChild(btn);
  }
  return sec;
}

// ---------------------------------------------------------------------------
// THE DEPTH-CHART POPOVER (a real modal dialog)
// ---------------------------------------------------------------------------
const popover = document.getElementById("depth-popover");
const popoverTitle = document.getElementById("popover-title");
const popoverList = document.getElementById("popover-list");
const popoverNote = document.querySelector(".popover-note");
const popoverClose = document.getElementById("popover-close");
const popoverPrev = document.getElementById("popover-prev");
const popoverNext = document.getElementById("popover-next");
const backdrop = document.createElement("div");
backdrop.className = "backdrop hidden";
document.body.appendChild(backdrop);

function setBackgroundInert(on) {
  document.querySelectorAll(".site-nav, .topbar, .field-scroll, #list-view, .status").forEach((el) => {
    if (!el) return;
    el.inert = on;             // modern browsers
    if (on) el.setAttribute("aria-hidden", "true"); else el.removeAttribute("aria-hidden");
  });
}

function openDepth(title, players) {
  const gen = ++popoverGen;
  // Reset the prev/next stepping + deep-link by default; openAt() re-enables them when the
  // popover is opened as part of a sequence. A direct open (e.g. special teams) has no nav.
  popoverSeq = null; popoverIdx = -1;
  if (popoverPrev) popoverPrev.hidden = true;
  if (popoverNext) popoverNext.hidden = true;
  setPosParam(null);
  const season = players[0] && players[0].season;
  const now = currentNflSeason();
  popoverTitle.textContent = season ? `${title} · ${season}` : title;

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
    if (i === 0) li.className = "starter";
    const badgeClass = injuryClass(p.injury);
    const badge = badgeClass ? `<span class="badge ${badgeClass}">${esc(p.injury)}</span>` : "";
    const key = `${p.id}:${p.season || ""}`;
    const knownAge = p.age != null ? p.age : (p.id && ageCache.has(key) ? ageCache.get(key) : undefined);
    const ageText = knownAge != null ? `${knownAge} yrs` : "—";
    const ovrText = p.overall != null ? `${p.overall} OVR` : "—";
    const bioParts = [p.height, p.weight, p.college].filter(Boolean);
    if (p.exp != null) bioParts.push(p.exp === 0 ? "Rookie" : `${p.exp} yr${p.exp === 1 ? "" : "s"} exp`);
    const bio = bioParts.map(esc).join(" · ");
    // Headshot + ESPN profile link built from the espn id (parity with the other 15
    // sports). img-src allows *.espncdn.com; a broken headshot just hides itself.
    const photo = p.id
      ? `<img class="p-photo" src="${esc(sized(`https://a.espncdn.com/i/headshots/nfl/players/full/${p.id}.png`, 96))}" alt="" loading="lazy" width="46" height="46" decoding="async">`
      : `<span class="p-photo p-photo-blank">#${esc(p.jersey || "")}</span>`;
    const link = p.id ? `<a class="p-espn" href="https://www.espn.com/nfl/player/_/id/${esc(p.id)}" target="_blank" rel="noopener noreferrer" title="Full profile on ESPN" aria-label="${esc(p.name)} on ESPN">↗</a>` : "";
    li.innerHTML = `
      <div class="p-main">
        <span class="rank">${i + 1}</span>
        ${photo}
        <span class="p-name">${esc(p.name)}${p.jersey ? ` <span class="p-num">#${esc(p.jersey)}</span>` : ""}</span>
        <span class="p-ovr">${ovrText}</span>
        <span class="p-age" data-id="${esc(p.id || "")}">${ageText}</span>
        ${badge}
        ${link}
      </div>
      ${i === 0 ? `<div class="p-stats" data-loading>…</div>` : ""}
      ${bio ? `<div class="p-bio">${bio}</div>` : ""}
    `;
    popoverList.appendChild(li);
    if (i === 0 && p.id) {
      loadPlayerStats(li.querySelector(".p-stats"), p.id, season, gen);
    } else if (p.id) {
      // [E] Every non-starter row is tap/keyboard-expandable for its own stat line — loaded
      // lazily at most once. Clicking the ESPN ↗ link is ignored (it opens the profile).
      li.classList.add("p-expandable");
      li.tabIndex = 0;
      li.setAttribute("role", "button");
      let loaded = false;
      const toggle = () => {
        if (loaded || li.querySelector(".p-stats")) return;
        loaded = true;
        const s = document.createElement("div");
        s.className = "p-stats"; s.setAttribute("data-loading", ""); s.textContent = "…";
        li.querySelector(".p-main").insertAdjacentElement("afterend", s);
        loadPlayerStats(s, p.id, season, gen);
      };
      li.addEventListener("click", (e) => { if (e.target.closest("a")) return; toggle(); });
      li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    }
  });

  lastFocused = document.activeElement;
  popover.classList.remove("hidden");
  backdrop.classList.remove("hidden");
  setBackgroundInert(true);
  popoverClose.focus();
  fillAges(players, gen);
}
// Lazily fetch the starter's season stat line (passing/rushing/receiving) — the
// backend already serves sport=nfl. Stale-guarded against a newer popover.
async function loadPlayerStats(el, id, season, gen) {
  if (!el) return;
  try {
    const now = currentNflSeason();
    const yr = season && season !== now ? season : "";
    const d = await (await fetch(`/api/player-stats?sport=nfl&id=${encodeURIComponent(id)}${yr ? `&year=${yr}` : ""}`, { signal: AbortSignal.timeout(12000) })).json();
    if (gen !== popoverGen || !el.isConnected) return;
    if (d && Array.isArray(d.line) && d.line.length) {
      el.removeAttribute("data-loading");
      el.innerHTML = d.line.map((s) => `<span class="stat"><b>${esc(s.v)}</b> ${esc(s.k)}</span>`).join("");
    } else { el.remove(); }
  } catch { if (el.isConnected) el.remove(); }
}

// Batch the age lookups for the open popover into one request, then fill rows —
// but only if this is still the popover the user is looking at (stale guard).
async function fillAges(players, gen) {
  const season = players[0] && players[0].season;
  const need = players.filter((p) => p.id && p.age == null && !ageCache.has(`${p.id}:${p.season || ""}`));
  if (need.length) {
    try {
      const ids = need.map((p) => p.id).join(",");
      const { ages } = await (await fetch(`/api/ages?ids=${ids}&year=${season || ""}`)).json();
      need.forEach((p) => ageCache.set(`${p.id}:${p.season || ""}`, ages[p.id] ?? null));
    } catch {
      need.forEach((p) => ageCache.set(`${p.id}:${p.season || ""}`, null));
    }
  }
  if (gen !== popoverGen) return; // a newer popover opened while we were fetching
  players.forEach((p) => {
    if (!p.id) return;
    const age = p.age != null ? p.age : ageCache.get(`${p.id}:${p.season || ""}`);
    popoverList.querySelectorAll(`.p-age[data-id="${p.id}"]`).forEach((el) => { el.textContent = age != null ? `${age} yrs` : "—"; });
  });
}

function closeDepth() {
  if (popover.classList.contains("hidden")) return;
  popover.classList.add("hidden");
  backdrop.classList.add("hidden");
  setBackgroundInert(false);
  popoverSeq = null; popoverIdx = -1;
  if (popoverPrev) popoverPrev.hidden = true;
  if (popoverNext) popoverNext.hidden = true;
  setPosParam(null);
  if (lastFocused && lastFocused.focus) lastFocused.focus();
}
// ---------------------------------------------------------------------------
// [D] POPOVER PREV/NEXT STEPPING + ?pos= DEEP-LINK
// The open sequence for the current matchup: defense chips then offense chips (list order),
// each with a stable posId so a shared ?pos= reopens the exact position on load.
// ---------------------------------------------------------------------------
function buildSeq(st) {
  const seq = [];
  st.defChips.forEach((ch, i) => seq.push({ title: `${st.defData.teamAbbr} D — ${ch.label}`, players: ch.players, posId: `def.${i}` }));
  st.offChips.forEach((ch, i) => seq.push({ title: `${st.offData.teamAbbr} O — ${ch.label}`, players: ch.players, posId: `off.${i}` }));
  return seq;
}
// Update ONLY the "pos" query param (leave every other param untouched) so an open
// position is shareable without disturbing the team/season/view state writeState() owns.
function setPosParam(id) {
  try {
    const u = new URLSearchParams(location.search);
    if (id) u.set("pos", id); else u.delete("pos");
    history.replaceState(null, "", "?" + u.toString());
  } catch {}
}
function openAt(seq, i) {
  if (!seq || i < 0 || i >= seq.length) return;
  openDepth(seq[i].title, seq[i].players); // resets nav; we re-enable it below
  popoverSeq = seq; popoverIdx = i;
  if (popoverPrev) popoverPrev.hidden = i <= 0;
  if (popoverNext) popoverNext.hidden = i >= seq.length - 1;
  setPosParam(seq[i].posId);
}
if (popoverPrev) popoverPrev.addEventListener("click", () => { if (popoverSeq) openAt(popoverSeq, popoverIdx - 1); });
if (popoverNext) popoverNext.addEventListener("click", () => { if (popoverSeq) openAt(popoverSeq, popoverIdx + 1); });
popoverClose.addEventListener("click", closeDepth);
backdrop.addEventListener("click", closeDepth);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDepth(); });
// Keep focus in the dialog as a wrap-around cycle so the in-popover ESPN links are
// keyboard-reachable (the popover now has interactive content beyond Close).
popover.addEventListener("keydown", (e) => {
  // [D] Left/Right arrows step through the matchup's positions (when opened as a sequence).
  if (e.key === "ArrowLeft" && popoverSeq && popoverIdx > 0) { e.preventDefault(); openAt(popoverSeq, popoverIdx - 1); return; }
  if (e.key === "ArrowRight" && popoverSeq && popoverIdx < popoverSeq.length - 1) { e.preventDefault(); openAt(popoverSeq, popoverIdx + 1); return; }
  if (e.key !== "Tab") return;
  const f = [...popover.querySelectorAll('button, a[href], select, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && el.offsetParent !== null);
  if (!f.length) { e.preventDefault(); popoverClose.focus(); return; }
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

// ---------------------------------------------------------------------------
// [A] PLAYER SEARCH — dim non-matching field chips / hide non-matching list rows.
// ---------------------------------------------------------------------------
function applySearch() {
  const q = searchQuery;
  document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("chip-dim", !!q && !(c.dataset.name || "").includes(q)));
  document.querySelectorAll(".list-row").forEach((r) => r.classList.toggle("search-hidden", !!q && !(r.dataset.name || "").includes(q)));
}

// ---------------------------------------------------------------------------
// [C] COMPARE MODE — tap one player on each side (offense=A, defense=B) to line
// their stat lines up side by side. Ported from the surface app.
// ---------------------------------------------------------------------------
function flashStatus(msg) {
  const s = document.getElementById("status");
  if (!s) return;
  s.textContent = msg;
  clearTimeout(flashStatus._t);
  flashStatus._t = setTimeout(() => { if (s.textContent === msg) s.textContent = ""; }, 2500);
}
function setCompareMode(on) {
  compareMode = on;
  const btn = document.getElementById("compare");
  if (btn) { btn.classList.toggle("active", on); btn.setAttribute("aria-pressed", String(on)); }
  if (!on) { pinned.A = null; pinned.B = null; }
  const d = document.getElementById("compare-drawer");
  if (d) d.classList.toggle("hidden", !on);
  document.body.classList.toggle("cmp-open", on); // reserve bottom space so the fixed drawer never hides the last players (phones)
  if (on) { renderCompare(); flashStatus("Compare: tap a player on each side"); }
}
function pinPlayer(face, teamName, side) {
  pinned[side] = { face, teamName };
  renderCompare();
}
function compareCol(pin, sideLabel) {
  if (!pin) return `<div class="cmp-col cmp-empty"><span>Tap ${sideLabel === "top" ? "an offense" : "a defense"} player</span></div>`;
  const p = pin.face;
  const src = p.id ? sized(`https://a.espncdn.com/i/headshots/nfl/players/full/${p.id}.png`, 120) : "";
  const photo = src ? `<img class="cmp-photo" src="${esc(src)}" alt="" width="56" height="56" decoding="async">` : `<span class="cmp-photo"></span>`;
  const ovr = p.overall != null ? `<span class="cmp-ovr">${p.overall}<i>OVR</i></span>` : "";
  const now = currentNflSeason();
  const yr = p.season && p.season !== now ? p.season : "";
  const bits = [p.age != null ? `${p.age} yrs` : "", p.height, p.weight].filter(Boolean).join(" · ");
  return `<div class="cmp-col" data-id="${esc(p.id || "")}" data-year="${esc(yr)}">
      ${photo}
      <div class="cmp-name">${esc(p.name)}</div>
      <div class="cmp-team">${esc(pin.teamName || "")}</div>
      ${ovr}
      <div class="cmp-bio">${esc(bits)}</div>
      <div class="cmp-stats" data-loading>…</div>
    </div>`;
}
async function renderCompare() {
  const d = document.getElementById("compare-drawer");
  if (!d) return;
  if (!compareMode) { d.classList.add("hidden"); return; }
  d.classList.remove("hidden");
  d.innerHTML = `<button class="cmp-close" aria-label="Close compare">✕</button>
    <div class="cmp-grid">${compareCol(pinned.A, "top")}<div class="cmp-vs">vs</div>${compareCol(pinned.B, "bottom")}</div>`;
  d.querySelector(".cmp-close").addEventListener("click", () => setCompareMode(false));
  // Fetch both stat lines, then bold the better value on each shared stat.
  const cols = d.querySelectorAll(".cmp-col[data-id]");
  const lines = await Promise.all([...cols].map(async (col) => {
    const id = col.getAttribute("data-id"); const yr = col.getAttribute("data-year"); const el = col.querySelector(".cmp-stats");
    if (!id) { el.remove(); return null; }
    try {
      const r = await (await fetch(`/api/player-stats?sport=nfl&id=${encodeURIComponent(id)}${yr ? `&year=${yr}` : ""}`, { signal: AbortSignal.timeout(12000) })).json();
      if (r && r.line && r.line.length) { el.removeAttribute("data-loading"); el.dataset.done = "1"; return { el, line: r.line }; }
      el.remove(); return null;
    } catch { el.remove(); return null; }
  }));
  const [a, b] = lines;
  const paint = (mine, other) => {
    if (!mine) return;
    mine.el.innerHTML = mine.line.map((s) => {
      const o = other && other.line.find((x) => x.k === s.k);
      const better = o && parseFloat(String(s.v).replace(/[^0-9.-]/g, "")) > parseFloat(String(o.v).replace(/[^0-9.-]/g, ""));
      return `<span class="stat${better ? " better" : ""}"><b>${esc(s.v)}</b> ${esc(s.k)}</span>`;
    }).join("");
  };
  paint(a, b); paint(b, a);
}

// ---------------------------------------------------------------------------
// [G] SKELETON PLACEHOLDERS — shown on a cold first load (user-initiated, no prior
// render._state). buildActiveView's innerHTML="" clears them when the real data lands.
// ---------------------------------------------------------------------------
function showSkeleton() {
  if (viewMode === "field") {
    ["defense-players", "offense-players"].forEach((id) => {
      const c = document.getElementById(id); if (!c) return;
      c.innerHTML = "";
      for (let i = 0; i < 4; i++) { const dchip = document.createElement("div"); dchip.className = "chip skeleton"; c.appendChild(dchip); }
    });
  } else {
    const el = document.getElementById(viewMode === "special" ? "st-view" : "list-view"); if (!el) return;
    el.innerHTML = "";
    for (let i = 0; i < 8; i++) { const row = document.createElement("div"); row.className = "list-row skeleton"; el.appendChild(row); }
  }
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
const offenseSelect = document.getElementById("offense-team");
const defenseSelect = document.getElementById("defense-team");
const personnelSelect = document.getElementById("personnel-select");
const formationSelect = document.getElementById("formation-select");
const offenseSeasonSelect = document.getElementById("offense-season");
const defenseSeasonSelect = document.getElementById("defense-season");
const statusEl = document.getElementById("status");
// Honest "saved data" cue when the server fell back to a seed/last-good copy (ESPN down).
function setStaleBanner(source) {
  const el = document.getElementById("stale-banner"); if (!el) return;
  if (!source) { el.classList.add("hidden"); el.textContent = ""; return; }
  el.textContent = "⚠ Showing a saved lineup — live data is temporarily unavailable. This page keeps retrying and will refresh itself.";
  el.classList.remove("hidden");
}
let viewMode = "field"; // or "list"

// One half's header band: team logo (built as DOM, no inline handlers), name, etc.
function nextGameText(next) {
  if (!next || !next.opp) return "";
  var day = "";
  if (next.date) { var d = new Date(next.date); if (!isNaN(d)) day = d.toLocaleDateString(undefined, { weekday: "short" }); }
  return "Next: " + next.homeAway + " " + next.opp + (day ? " · " + day : "") + (next.pre ? " · Preseason" : "");
}
function decorateHalf(teamId, unitWord, formationName, season, record, next, labelEl, tintEl) {
  const team = TEAM_BY_ID.get(String(teamId));
  const color = (team && team.color) || "#333333";
  labelEl.textContent = "";
  if (team) {
    const img = document.createElement("img");
    img.src = sized(logoUrl(team.abbr), 48); // 500px crest → 48px combiner (~96% smaller)
    img.alt = ""; img.width = 24; img.height = 24; img.decoding = "async"; // fixed box → no layout shift
    img.addEventListener("error", () => { img.style.display = "none"; });
    labelEl.appendChild(img);
  }
  const span = document.createElement("span");
  span.textContent = `${team ? team.name : ""} ${unitWord} · ${formationName || ""} (${season || ""})`;
  labelEl.appendChild(span);
  const ng = nextGameText(next);
  if (ng) { const n = document.createElement("span"); n.className = "band-next"; n.textContent = ng; labelEl.appendChild(n); }
  labelEl.style.background = hexToRgba(color, 0.92);
  tintEl.style.background = `linear-gradient(${hexToRgba(color, 0.3)}, ${hexToRgba(color, 0.1)})`;
}

function nflUpdatedLabel() {
  const st = render._state, u = document.getElementById("updated");
  if (u && st) u.textContent = "Updated " + relTime((st.offData && st.offData.fetchedAt) || (st.defData && st.defData.fetchedAt));
}
// Build ONLY the active view's DOM; the other two build lazily on switch. NFL has three
// containers (field halves, list, special teams) but a phone shows one at a time — so
// first paint (List by default) no longer builds ~44 field chips + special teams unseen.
function buildActiveView() {
  const st = render._state; if (!st) return;
  if (viewMode === "field") {
    if (!st.builtField) {
      decorateHalf(st.defenseId, "DEFENSE", DEFENSE_FORMATION[st.formation].short, st.defData.season, st.defData.record, st.defData.next,
        document.getElementById("defense-formation"), document.getElementById("defense-tint"));
      decorateHalf(st.offenseId, "OFFENSE", OFFENSE_PERSONNEL[st.personnel].short, st.offData.season, st.offData.record, st.offData.next,
        document.getElementById("offense-formation"), document.getElementById("offense-tint"));
      renderSide(document.getElementById("defense-players"), st.defChips, `${st.defData.teamAbbr} D`, st.defSig, st.defColor, "B", (TEAM_BY_ID.get(st.defenseId) || {}).name, "def");
      renderSide(document.getElementById("offense-players"), st.offChips, `${st.offData.teamAbbr} O`, st.offSig, st.offColor, "A", (TEAM_BY_ID.get(st.offenseId) || {}).name, "off");
      st.builtField = true;
    }
  } else if (viewMode === "list") {
    if (!st.builtList) { renderList(st); st.builtList = true; }
  } else if (viewMode === "special") {
    if (!st.builtSpecial) { renderSpecialTeams(st.offData, st.defData); st.builtSpecial = true; }
  }
  applySearch(); // [A] re-apply the active player filter after any (re)build
}
// render(fresh) — user-initiated (loading UI, rebuild). render(true,true) — the 4-min
// auto-refresh: silent, and when the data is unchanged it only refreshes the timestamp.
async function render(fresh, auto) {
  const gen = ++renderGen;
  closeDepth();
  const fieldEl = document.getElementById("field");
  if (!auto) { statusEl.textContent = fresh ? "⟳ Refreshing…" : "⟳ Loading latest lineups…"; fieldEl.classList.add("loading"); }
  if (!auto && !render._state) showSkeleton(); // [G] cold first load — placeholders while we fetch
  const offenseId = offenseSelect.value, defenseId = defenseSelect.value;
  const personnel = personnelSelect.value, formation = formationSelect.value;
  const offenseYear = offenseSeasonSelect.value, defenseYear = defenseSeasonSelect.value;
  writeState();
  try {
    const [offData, defData] = await Promise.all([
      getSideData("offense", offenseId, offenseYear, fresh),
      getSideData("defense", defenseId, defenseYear, fresh),
    ]);
    if (gen !== renderGen) return;
    setStaleBanner((offData.stale && offData.source) || (defData.stale && defData.source) || null);
    // Silent auto-refresh with identical data + selections → refresh the label only.
    const stamp = `${offData.fetchedAt || ""}|${defData.fetchedAt || ""}|${offenseId}|${defenseId}|${personnel}|${formation}|${offData.season}|${defData.season}`;
    if (auto && render._state && render._state.stamp === stamp) { nflUpdatedLabel(); statusEl.textContent = ""; return; }

    const offChips = buildOffense(offData.offense, personnel);
    const defChips = buildDefense(defData.defense, formation);
    render._state = {
      offData, defData, offChips, defChips,
      offTitle: `${offData.team} OFFENSE · ${OFFENSE_PERSONNEL[personnel].short} (${offData.season})`,
      defTitle: `${defData.team} DEFENSE · ${DEFENSE_FORMATION[formation].short} (${defData.season})`,
      offSig: `off:${offenseId}:${offData.season}:${personnel}`, defSig: `def:${defenseId}:${defData.season}:${formation}`,
      offColor: (TEAM_BY_ID.get(offenseId) || {}).color, defColor: (TEAM_BY_ID.get(defenseId) || {}).color,
      offenseId, defenseId, personnel, formation, stamp, builtField: false, builtList: false, builtSpecial: false,
    };
    render._sigs = [render._state.offSig, render._state.defSig];
    render._state.seq = buildSeq(render._state); // [D] ordered open sequence for prev/next + deep-link
    buildActiveView(); // build only the visible view; the others build on switch
    nflUpdatedLabel();
    statusEl.textContent = "";
    // [D] Deep-link: if the URL carried ?pos=, open that position once after the first render.
    if (pendingPos) {
      const idx = render._state.seq.findIndex((s) => s.posId === pendingPos);
      if (idx >= 0) openAt(render._state.seq, idx);
      pendingPos = null;
    }
  } catch (err) {
    if (!auto) {
      statusEl.textContent = "Couldn't load right now. ";
      const b = document.createElement("button");
      b.className = "retry"; b.textContent = "Retry";
      b.addEventListener("click", () => render(true));
      statusEl.appendChild(b);
    }
  } finally {
    fieldEl.classList.remove("loading");
  }
}

// ---------------------------------------------------------------------------
// VIEW TOGGLE (Field vs List) — list is the default on small screens.
// ---------------------------------------------------------------------------
function applyView() {
  document.querySelector(".field-scroll").classList.toggle("hidden", viewMode !== "field");
  document.getElementById("scroll-hint").classList.toggle("hidden", viewMode !== "field");
  document.getElementById("list-view").classList.toggle("hidden", viewMode !== "list");
  document.getElementById("st-view").classList.toggle("hidden", viewMode !== "special");
  document.querySelectorAll(".view-toggle button").forEach((b) => {
    const on = b.dataset.view === viewMode;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });
}
function setView(mode) {
  viewMode = mode;
  const dc = window.matchMedia("(max-width: 760px)").matches ? "m" : "d";
  try { localStorage.setItem("nfl.view." + dc, mode); } catch {}
  buildActiveView(); // construct the newly-shown view if it wasn't built yet
  applyView(); writeState();
}

// ---------------------------------------------------------------------------
// STATE in the URL (shareable) + localStorage (sticky). URL wins on load.
// ---------------------------------------------------------------------------
function writeState() {
  const p = new URLSearchParams({
    ot: offenseSelect.value, op: personnelSelect.value, os: offenseSeasonSelect.value,
    dt: defenseSelect.value, df: formationSelect.value, ds: defenseSeasonSelect.value, v: viewMode,
  });
  try { history.replaceState(null, "", "?" + p.toString()); } catch {}
  try { localStorage.setItem("nfl.controls", p.toString()); } catch {}
}
function readState() {
  const url = new URLSearchParams(location.search);
  pendingPos = url.get("pos"); // [D] deep-link only from the URL (never localStorage)
  let saved = new URLSearchParams();
  try { saved = new URLSearchParams(localStorage.getItem("nfl.controls") || ""); } catch {}
  const get = (k) => url.get(k) ?? saved.get(k) ?? null;
  const setSel = (sel, v) => { if (v != null && [...sel.options].some((o) => o.value === v)) sel.value = v; };
  setSel(offenseSelect, get("ot")); setSel(personnelSelect, get("op")); setSel(offenseSeasonSelect, get("os"));
  setSel(defenseSelect, get("dt")); setSel(formationSelect, get("df")); setSel(defenseSeasonSelect, get("ds"));
  // Explicit URL ?v= wins; else a per-device saved preference; else the device
  // default (desktop → Field, phone → List). Device-scoped so a phone's List
  // choice doesn't hide the field on desktop.
  const urlV = url.get("v");
  const dc = window.matchMedia("(max-width: 760px)").matches ? "m" : "d";
  let devPref = null; try { devPref = localStorage.getItem("nfl.view." + dc); } catch {}
  viewMode = ["field", "list", "special"].includes(urlV) ? urlV : (["field", "list", "special"].includes(devPref) ? devPref : (dc === "m" ? "list" : "field"));
}

// ---------------------------------------------------------------------------
// Dropdown fillers
// ---------------------------------------------------------------------------
function fillDropdown(sel) {
  const teams = [...NFL_TEAMS].sort((a, b) => a.name.localeCompare(b.name)); // alphabetical
  for (const team of teams) {
    const opt = document.createElement("option");
    opt.value = team.id; opt.textContent = team.name;
    sel.appendChild(opt);
  }
  sel.value = String(DEFAULT_TEAM_ID);
}
function fillOptions(sel, order, cfgMap, def) {
  for (const key of order) {
    const opt = document.createElement("option");
    opt.value = key; opt.textContent = cfgMap[key].label;
    sel.appendChild(opt);
  }
  sel.value = def;
}
function fillSeasons(sel) {
  const cur = currentNflSeason();
  for (let y = cur; y >= SEASON.OLDEST; y--) {
    const opt = document.createElement("option");
    opt.value = y; opt.textContent = y === cur ? `${y} (current)` : `${y}`;
    sel.appendChild(opt);
  }
  sel.value = String(cur);
}

// ---- wire up ----
document.getElementById("refresh").addEventListener("click", () => render(true));
(function () {
  const btn = document.getElementById("share");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    const url = location.href, title = document.title, s = document.getElementById("status");
    const flash = (m) => { if (!s) return; s.textContent = m; clearTimeout(flash._t); flash._t = setTimeout(() => { if (s.textContent === m) s.textContent = ""; }, 2500); };
    try {
      if (navigator.share) { await navigator.share({ title, url }); return; }
      await navigator.clipboard.writeText(url); flash("Link copied to clipboard");
    } catch (e) {
      if (e && e.name === "AbortError") return;
      try { await navigator.clipboard.writeText(url); flash("Link copied to clipboard"); } catch { flash("Copy this page's URL to share"); }
    }
  });
})();
document.getElementById("reset").addEventListener("click", () => {
  // Clear any dragged positions for the current matchup, then redraw defaults.
  (render._sigs || []).forEach((sig) => delete layouts[sig]);
  saveLayouts(layouts);
  render(false);
});
[offenseSelect, defenseSelect, personnelSelect, formationSelect, offenseSeasonSelect, defenseSeasonSelect]
  .forEach((sel) => sel.addEventListener("change", () => render(false)));
document.querySelectorAll(".view-toggle button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
// [A] Player search — filter the active view as the user types.
(function () {
  const input = document.getElementById("player-search");
  if (!input) return;
  input.addEventListener("input", () => { searchQuery = input.value.trim().toLowerCase(); applySearch(); });
})();
// [C] Compare mode toggle.
(function () {
  const btn = document.getElementById("compare");
  if (btn) btn.addEventListener("click", () => setCompareMode(!compareMode));
})();

// ---- start up ----
fillDropdown(offenseSelect);
fillDropdown(defenseSelect);
fillOptions(personnelSelect, OFFENSE_PERSONNEL_ORDER, OFFENSE_PERSONNEL, "11");
fillOptions(formationSelect, DEFENSE_FORMATION_ORDER, DEFENSE_FORMATION, "base");
fillSeasons(offenseSeasonSelect);
fillSeasons(defenseSeasonSelect);
readState();
applyView();
render();

// Keep the page live: quietly re-pull every 4 min (skips when hidden, a depth
// chart is open, or a chip is mid-drag).
setInterval(() => {
  if (document.visibilityState !== "visible") return;
  if (!popover.classList.contains("hidden")) return;
  if (document.querySelector(".chip.dragging")) return;
  render(true, true); // silent background refresh: no loading flash, skips rebuild when unchanged
}, 240000);
