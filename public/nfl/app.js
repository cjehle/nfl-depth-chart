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

// Quick lookup + small state.
const TEAM_BY_ID = new Map(window.NFL_TEAMS.map((t) => [String(t.id), t]));
const ageCache = new Map();          // `${id}:${season}` -> age|null
const sideCache = { offense: { key: null, data: null }, defense: { key: null, data: null } };
let popoverGen = 0;                  // bumped each time a popover opens (stale-write guard)
let renderGen = 0;                   // bumped each render (guards against out-of-order fetches)
let lastFocused = null;              // element to restore focus to when the modal closes

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function logoUrl(abbr) { return `https://a.espncdn.com/i/teamlogos/nfl/500/${abbr.toLowerCase()}.png`; }

function hexToRgba(hex, alpha) {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16), g = parseInt(h.substring(2, 4), 16), b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function injuryClass(status) {
  if (!status) return null;
  const s = status.toLowerCase();
  if (s.includes("out") || s.includes("ir") || s.includes("reserve") || s.includes("pup")) return "out";
  if (s.includes("question") || s.includes("doubt")) return "questionable";
  return "other";
}

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
function makeChip(posAbbr, players, sideLabel, onMoved, teamColor) {
  const starter = players[0];
  const chip = document.createElement("div");
  chip.className = "chip";
  chip.tabIndex = 0;
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

  const open = () => openDepth(`${sideLabel} — ${posAbbr}`, players);
  chip.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  makeDraggable(chip, open, onMoved);
  return chip;
}

// Drag within the chip's own half (can't cross the line of scrimmage). A tiny
// move counts as a click; a real move fires onMoved so the spot is remembered.
function makeDraggable(chip, onClick, onMoved) {
  let dragging = false, moved = false, startX = 0, startY = 0, cx0 = 0, cy0 = 0;
  chip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    dragging = true; moved = false; startX = e.clientX; startY = e.clientY;
    const box = chip.parentElement.getBoundingClientRect();
    const c = chip.getBoundingClientRect();
    cx0 = c.left + c.width / 2 - box.left; cy0 = c.top + c.height / 2 - box.top;
    try { chip.setPointerCapture(e.pointerId); } catch {}
    chip.classList.add("dragging");
  });
  chip.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
    const box = chip.parentElement.getBoundingClientRect();
    const hw = chip.offsetWidth / 2, hh = chip.offsetHeight / 2;
    chip.style.left = Math.max(hw, Math.min(box.width - hw, cx0 + dx)) + "px";
    chip.style.top = Math.max(hh, Math.min(box.height - hh, cy0 + dy)) + "px";
  });
  const finish = (e) => {
    if (!dragging) return;
    dragging = false;
    chip.classList.remove("dragging");
    try { chip.releasePointerCapture(e.pointerId); } catch {}
    if (moved) { if (onMoved) onMoved(); } else onClick();
  };
  chip.addEventListener("pointerup", finish);
  chip.addEventListener("pointercancel", finish);
}

// ---------------------------------------------------------------------------
// RENDER — field view
// ---------------------------------------------------------------------------
function renderSide(container, chips, sideLabel, sig, teamColor) {
  container.innerHTML = "";
  if (!chips.length) {
    container.innerHTML = `<p class="status">No lineup available for this team/season.</p>`;
    return;
  }
  const saved = layouts[sig] || {};
  chips.forEach((ch, i) => {
    const chipKey = `${ch.label}#${i}`;
    const chip = makeChip(ch.label, ch.players, sideLabel, () => persistChip(sig, chipKey, chip), teamColor);
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
function renderList(offChips, defChips, offTitle, defTitle) {
  const el = document.getElementById("list-view");
  el.innerHTML = "";
  el.appendChild(listSection(defTitle, defChips, "defense"));
  el.appendChild(listSection(offTitle, offChips, "offense"));
}
function listSection(title, chips, sideName) {
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
  const sideLabel = sideName === "offense" ? "O" : "D";
  for (const ch of chips) {
    const p = ch.players[0];
    const btn = document.createElement("button");
    btn.className = "list-row";
    btn.setAttribute("aria-label", `${p.name}, ${ch.label}. Open depth chart.`);
    const badgeClass = injuryClass(p.injury);
    const badge = badgeClass ? `<span class="badge ${badgeClass}">${esc(p.injury)}</span>` : "";
    const depth = ch.players.length - 1 > 0 ? `<span class="list-depth">+${ch.players.length - 1}</span>` : "";
    btn.innerHTML = `
      <span class="list-pos">${esc(ch.label)}</span>
      <span class="list-name">${esc(p.name)} <span class="list-num">#${esc(p.jersey || "--")}</span></span>
      ${badge}${depth}
    `;
    btn.addEventListener("click", () => openDepth(`${sideLabel} — ${ch.label}`, ch.players));
    sec.appendChild(btn);
  }
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
    btn.setAttribute("aria-label", `${p.name}, ${label}. Open depth chart.`);
    const depth = players.length - 1 > 0 ? `<span class="list-depth">+${players.length - 1}</span>` : "";
    btn.innerHTML = `
      <span class="list-pos">${esc(label)}</span>
      <span class="list-name">${esc(p.name)} <span class="list-num">#${esc(p.jersey || "--")}</span></span>
      ${depth}
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
const backdrop = document.createElement("div");
backdrop.className = "backdrop hidden";
document.body.appendChild(backdrop);

function setBackgroundInert(on) {
  document.querySelectorAll(".topbar, .field-scroll, #list-view, .status").forEach((el) => {
    if (!el) return;
    el.inert = on;             // modern browsers
    if (on) el.setAttribute("aria-hidden", "true"); else el.removeAttribute("aria-hidden");
  });
}

function openDepth(title, players) {
  const gen = ++popoverGen;
  const season = players[0] && players[0].season;
  const now = window.currentNflSeason();
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
    li.innerHTML = `
      <div class="p-main">
        <span class="rank">${i + 1}</span>
        <span class="p-num">#${esc(p.jersey || "--")}</span>
        <span class="p-name">${esc(p.name)}</span>
        <span class="p-ovr">${ovrText}</span>
        <span class="p-age" data-id="${esc(p.id || "")}">${ageText}</span>
        ${badge}
      </div>
      ${bio ? `<div class="p-bio">${bio}</div>` : ""}
    `;
    popoverList.appendChild(li);
  });

  lastFocused = document.activeElement;
  popover.classList.remove("hidden");
  backdrop.classList.remove("hidden");
  setBackgroundInert(true);
  popoverClose.focus();
  fillAges(players, gen);
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
  if (lastFocused && lastFocused.focus) lastFocused.focus();
}
popoverClose.addEventListener("click", closeDepth);
backdrop.addEventListener("click", closeDepth);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDepth(); });
// Trap focus inside the dialog (only the close button is interactive).
popover.addEventListener("keydown", (e) => {
  if (e.key === "Tab") { e.preventDefault(); popoverClose.focus(); }
});

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
let viewMode = "field"; // or "list"

// One half's header band: team logo (built as DOM, no inline handlers), name, etc.
function relTime(iso) {
  if (!iso) return "just now";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
  return `${Math.round(s / 86400)} d ago`;
}
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
    img.src = logoUrl(team.abbr);
    img.alt = "";
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

async function render(fresh) {
  const gen = ++renderGen; // if a newer render starts, this one won't paint stale data
  closeDepth();
  statusEl.textContent = fresh ? "⟳ Refreshing…" : "⟳ Loading latest lineups…";
  document.getElementById("field").classList.add("loading");

  const offenseId = offenseSelect.value, defenseId = defenseSelect.value;
  const personnel = personnelSelect.value, formation = formationSelect.value;
  const offenseYear = offenseSeasonSelect.value, defenseYear = defenseSeasonSelect.value;
  writeState();

  try {
    const [offData, defData] = await Promise.all([
      getSideData("offense", offenseId, offenseYear, fresh),
      getSideData("defense", defenseId, defenseYear, fresh),
    ]);
    if (gen !== renderGen) return; // a newer selection superseded this fetch

    const offChips = buildOffense(offData.offense, personnel);
    const defChips = buildDefense(defData.defense, formation);

    const offTitle = `${offData.team} OFFENSE · ${OFFENSE_PERSONNEL[personnel].short} (${offData.season})`;
    const defTitle = `${defData.team} DEFENSE · ${DEFENSE_FORMATION[formation].short} (${defData.season})`;

    decorateHalf(defenseId, "DEFENSE", DEFENSE_FORMATION[formation].short, defData.season, defData.record, defData.next,
      document.getElementById("defense-formation"), document.getElementById("defense-tint"));
    decorateHalf(offenseId, "OFFENSE", OFFENSE_PERSONNEL[personnel].short, offData.season, offData.record, offData.next,
      document.getElementById("offense-formation"), document.getElementById("offense-tint"));

    const offSig = `off:${offenseId}:${offData.season}:${personnel}`;
    const defSig = `def:${defenseId}:${defData.season}:${formation}`;
    const offColor = (TEAM_BY_ID.get(offenseId) || {}).color;
    const defColor = (TEAM_BY_ID.get(defenseId) || {}).color;
    renderSide(document.getElementById("defense-players"), defChips, `${defData.teamAbbr} D`, defSig, defColor);
    renderSide(document.getElementById("offense-players"), offChips, `${offData.teamAbbr} O`, offSig, offColor);
    renderList(offChips, defChips, offTitle, defTitle);
    renderSpecialTeams(offData, defData);
    render._sigs = [offSig, defSig];

    statusEl.textContent = "";
    const u = document.getElementById("updated");
    if (u) u.textContent = "Updated " + relTime(offData.fetchedAt || defData.fetchedAt);
  } catch (err) {
    statusEl.textContent = "Couldn't load right now. ";
    const b = document.createElement("button");
    b.className = "retry"; b.textContent = "Retry";
    b.addEventListener("click", () => render(true));
    statusEl.appendChild(b);
  } finally {
    document.getElementById("field").classList.remove("loading");
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
function setView(mode) { viewMode = mode; applyView(); writeState(); }

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
  let saved = new URLSearchParams();
  try { saved = new URLSearchParams(localStorage.getItem("nfl.controls") || ""); } catch {}
  const get = (k) => url.get(k) ?? saved.get(k) ?? null;
  const setSel = (sel, v) => { if (v != null && [...sel.options].some((o) => o.value === v)) sel.value = v; };
  setSel(offenseSelect, get("ot")); setSel(personnelSelect, get("op")); setSel(offenseSeasonSelect, get("os"));
  setSel(defenseSelect, get("dt")); setSel(formationSelect, get("df")); setSel(defenseSeasonSelect, get("ds"));
  const v = get("v");
  // Phones default to List (no sideways scrolling); desktop defaults to Field.
  viewMode = ["field", "list", "special"].includes(v) ? v : (window.matchMedia("(max-width: 760px)").matches ? "list" : "field");
}

// ---------------------------------------------------------------------------
// Dropdown fillers
// ---------------------------------------------------------------------------
function fillDropdown(sel) {
  const teams = [...window.NFL_TEAMS].sort((a, b) => a.name.localeCompare(b.name)); // alphabetical
  for (const team of teams) {
    const opt = document.createElement("option");
    opt.value = team.id; opt.textContent = team.name;
    sel.appendChild(opt);
  }
  sel.value = String(window.DEFAULT_TEAM_ID);
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
  const cur = window.currentNflSeason();
  for (let y = cur; y >= window.SEASON.OLDEST; y--) {
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
  render(true);
}, 240000);
