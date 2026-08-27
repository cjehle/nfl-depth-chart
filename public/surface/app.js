// app.js — runs in the browser. One generic client for every sport; all the
// sport-specific bits (title, surface, teams, defaults) come from /api/config.

// Which sport this page is (from the URL path: /nhl, /nba, /mls).
const SPORT = (location.pathname.replace(/\/+$/, "").split("/").filter(Boolean)[0]) || "nhl";
let CONFIG = null;                       // filled from /api/config on startup
let TEAM_BY_ID = new Map();              // id -> team {id,abbr,name,color,alt,logo}
const sideCache = { A: { key: null, data: null }, B: { key: null, data: null } };
let popoverGen = 0, renderGen = 0, lastFocused = null;
let viewMode = "field";
let CROSS_OK = true; // can pills be dragged across the center line? (false for CFB's field)

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function hexToRgba(hex, alpha) {
  const h = String(hex || "#333333").replace("#", "");
  const r = parseInt(h.substring(0, 2), 16), g = parseInt(h.substring(2, 4), 16), b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r || 40}, ${g || 40}, ${b || 40}, ${alpha})`;
}
function injuryClass(status) {
  if (!status) return null;
  const s = String(status).toLowerCase();
  if (s.includes("out") || s.includes("ir") || s.includes("reserve") || s.includes("susp")) return "out";
  if (s.includes("question") || s.includes("doubt") || s.includes("day")) return "questionable";
  return "other";
}
function expText(exp) {
  if (exp == null) return "";
  if (exp === 0) return "Rookie";
  return `${exp} yr${exp === 1 ? "" : "s"} pro`;
}
function bioLine(p) {
  const parts = [p.height, p.weight, p.extra].filter(Boolean);
  const e = expText(p.exp);
  if (e) parts.push(e);
  return parts.map(esc).join(" · ");
}
function relTime(iso) {
  if (!iso) return "just now";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
  return `${Math.round(s / 86400)} d ago`;
}

// ---------------------------------------------------------------------------
// FETCH (per-side cache: switching the view never refetches a team)
// ---------------------------------------------------------------------------
async function fetchLineup(teamId, fresh, unit) {
  // Always ask for fresh data so the lineup updates on every load. The server
  // coalesces this to at most one ESPN pull per team per ~60s (fast + polite).
  // A 20s client timeout means a stuck request drops to the Retry button instead
  // of hanging on the loading spinner forever.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(`/api/lineup?sport=${SPORT}&team=${teamId}&fresh=1${unit ? `&unit=${unit}` : ""}`, { signal: ctrl.signal });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
  } finally { clearTimeout(timer); }
}
async function getSide(side, teamId, fresh, unit) {
  const c = sideCache[side];
  const ck = `${teamId}:${unit || ""}`;
  if (!fresh && c.key === ck && c.data) return c.data;
  const data = await fetchLineup(teamId, fresh, unit);
  c.key = ck; c.data = data;
  return data;
}

// ---------------------------------------------------------------------------
// DRAG (within a chip's own half) + LAYOUT PERSISTENCE
// ---------------------------------------------------------------------------
function loadLayouts() { try { return JSON.parse(localStorage.getItem("sdc.layout") || "{}"); } catch { return {}; } }
function saveLayouts(o) { try { localStorage.setItem("sdc.layout", JSON.stringify(o)); } catch {} }
let layouts = loadLayouts();
function persistChip(sig, chipKey, chip) {
  const box = chip.parentElement;
  const left = (parseFloat(chip.style.left) / box.clientWidth) * 100;
  const top = (parseFloat(chip.style.top) / box.clientHeight) * 100;
  if (!isFinite(left) || !isFinite(top)) return;
  (layouts[sig] = layouts[sig] || {})[chipKey] = { left: left + "%", top: top + "%" };
  saveLayouts(layouts);
}
function makeDraggable(chip, onClick, onMoved) {
  let dragging = false, moved = false, sx = 0, sy = 0, cx0 = 0, cy0 = 0;
  chip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    dragging = true; moved = false; sx = e.clientX; sy = e.clientY;
    const box = chip.parentElement.getBoundingClientRect();
    const c = chip.getBoundingClientRect();
    cx0 = c.left + c.width / 2 - box.left; cy0 = c.top + c.height / 2 - box.top;
    try { chip.setPointerCapture(e.pointerId); } catch {}
    chip.classList.add("dragging");
  });
  chip.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
    const parent = chip.parentElement.getBoundingClientRect();
    const hw = chip.offsetWidth / 2, hh = chip.offsetHeight / 2;
    const nx = cx0 + dx, ny = cy0 + dy;
    if (CROSS_OK) {
      // Most sports: a pill can be dragged anywhere on the surface, including
      // across the center line. (Football keeps players on their own side.)
      const s = document.getElementById("surface").getBoundingClientRect();
      chip.style.left = Math.max((s.left - parent.left) + hw, Math.min((s.right - parent.left) - hw, nx)) + "px";
      chip.style.top = Math.max((s.top - parent.top) + hh, Math.min((s.bottom - parent.top) - hh, ny)) + "px";
    } else {
      chip.style.left = Math.max(hw, Math.min(parent.width - hw, nx)) + "px";
      chip.style.top = Math.max(hh, Math.min(parent.height - hh, ny)) + "px";
    }
  });
  const finish = (e) => {
    if (!dragging) return;
    dragging = false; chip.classList.remove("dragging");
    try { chip.releasePointerCapture(e.pointerId); } catch {}
    if (moved) { if (onMoved) onMoved(); } else onClick();
  };
  chip.addEventListener("pointerup", finish);
  chip.addEventListener("pointercancel", finish);
}

// ---------------------------------------------------------------------------
// A CLICKABLE, KEYBOARD-ACCESSIBLE PLAYER CHIP
// ---------------------------------------------------------------------------
function makeChip(chipData, teamAbbr, teamColor, onMoved) {
  const face = chipData.face;
  const chip = document.createElement("div");
  chip.className = "chip";
  chip.tabIndex = 0;
  chip.setAttribute("role", "button");
  chip.setAttribute("aria-label", `${face.name}, ${chipData.label}. Open depth chart.`);
  if (teamColor) chip.style.borderTopColor = teamColor;
  const badgeClass = injuryClass(face.injury);
  const badge = badgeClass ? `<span class="badge ${badgeClass}">${esc(face.injury)}</span>` : "";
  const depth = chipData.players.length - 1;
  const depthHtml = depth > 0 ? `<div class="depth-count">+${depth} behind</div>` : "";
  chip.innerHTML = `
    <div class="pos">${esc(chipData.label)} · #${esc(face.jersey || "--")}</div>
    <div class="name">${esc(face.name)}</div>
    ${badge}${depthHtml}
  `;
  const open = () => openDepth(`${teamAbbr} — ${chipData.label}`, chipData.players);
  chip.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  makeDraggable(chip, open, onMoved);
  return chip;
}

// ---------------------------------------------------------------------------
// RENDER — the surface (two teams: A on top, B mirrored on the bottom)
// ---------------------------------------------------------------------------
function renderTeamOnSurface(containerId, data, mirror, sig) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  if (!data.chips || !data.chips.length) {
    container.innerHTML = `<p class="status">No lineup available.</p>`;
    return;
  }
  const saved = layouts[sig] || {};
  data.chips.forEach((ch, i) => {
    const chipKey = `${ch.key}#${i}`;
    const chip = makeChip(ch, data.team.abbr, data.team.color, () => persistChip(sig, chipKey, chip));
    chip.style.left = ch.x + "%";
    chip.style.top = (mirror ? 100 - ch.y : ch.y) + "%";
    const pos = saved[chipKey];
    if (pos) { chip.style.left = pos.left; chip.style.top = pos.top; }
    container.appendChild(chip);
  });
}

function decorateBand(bandEl, tintEl, data, mirror) {
  const t = data.team;
  bandEl.textContent = "";
  if (t.logo) {
    const img = document.createElement("img");
    img.src = t.logo; img.alt = "";
    img.addEventListener("error", () => { img.style.display = "none"; });
    bandEl.appendChild(img);
  }
  const span = document.createElement("span");
  const rank = t.rank ? `#${t.rank} ` : "";
  const rec = t.record && !/^0-0/.test(t.record) ? ` (${t.record})` : "";
  span.textContent = `${rank}${t.name}${rec} · ${data.subtitle || ""}`;
  bandEl.appendChild(span);
  bandEl.style.background = hexToRgba(t.color, 0.92);
  tintEl.style.background = `linear-gradient(${mirror ? 0 : 180}deg, ${hexToRgba(t.color, 0.32)}, ${hexToRgba(t.color, 0.08)})`;
}

// ---------------------------------------------------------------------------
// RENDER — list view (grouped by line, per team; a11y + mobile friendly)
// ---------------------------------------------------------------------------
function renderList(dataA, dataB) {
  const el = document.getElementById("list-view");
  el.innerHTML = "";
  el.appendChild(listTeam(dataA));
  el.appendChild(listTeam(dataB));
}
function listTeam(data) {
  const sec = document.createElement("section");
  sec.className = "list-team";
  const h = document.createElement("h2");
  h.textContent = `${data.team.name} · ${data.subtitle || ""}`;
  h.style.borderLeftColor = data.team.color || "#666";
  sec.appendChild(h);
  // group chips by their line, in first-seen order
  const groups = [];
  const byGroup = new Map();
  for (const ch of data.chips) {
    if (!byGroup.has(ch.group)) { byGroup.set(ch.group, []); groups.push(ch.group); }
    byGroup.get(ch.group).push(ch);
  }
  for (const g of groups) {
    const gh = document.createElement("h3");
    gh.className = "list-group";
    gh.textContent = g;
    sec.appendChild(gh);
    for (const ch of byGroup.get(g)) {
      const face = ch.face;
      const btn = document.createElement("button");
      btn.className = "list-row";
      btn.setAttribute("aria-label", `${face.name}, ${ch.label}. Open depth chart.`);
      const badgeClass = injuryClass(face.injury);
      const badge = badgeClass ? `<span class="badge ${badgeClass}">${esc(face.injury)}</span>` : "";
      const depth = ch.players.length - 1 > 0 ? `<span class="list-depth">+${ch.players.length - 1}</span>` : "";
      btn.innerHTML = `
        <span class="list-pos">${esc(ch.label)}</span>
        <span class="list-name">${esc(face.name)} <span class="list-num">#${esc(face.jersey || "--")}</span></span>
        ${badge}${depth}`;
      btn.addEventListener("click", () => openDepth(`${data.team.abbr} — ${ch.label}`, ch.players));
      sec.appendChild(btn);
    }
  }
  return sec;
}

// ---------------------------------------------------------------------------
// THE DEPTH-CHART POPOVER (a real modal dialog)
// ---------------------------------------------------------------------------
const popover = document.getElementById("depth-popover");
const popoverTitle = document.getElementById("popover-title");
const popoverList = document.getElementById("popover-list");
const popoverNote = document.getElementById("popover-note");
const popoverClose = document.getElementById("popover-close");
const backdrop = document.createElement("div");
backdrop.className = "backdrop hidden";
document.body.appendChild(backdrop);

function setBackgroundInert(on) {
  document.querySelectorAll(".topbar, .surface-scroll, #list-view, .status").forEach((el) => {
    if (!el) return;
    el.inert = on;
    if (on) el.setAttribute("aria-hidden", "true"); else el.removeAttribute("aria-hidden");
  });
}
function openDepth(title, players) {
  ++popoverGen;
  popoverTitle.textContent = title;
  popoverNote.textContent = (CONFIG && CONFIG.note) || "";
  popoverList.innerHTML = "";
  players.forEach((p, i) => {
    const li = document.createElement("li");
    if (i === 0) li.className = "starter";
    const badgeClass = injuryClass(p.injury);
    const badge = badgeClass ? `<span class="badge ${badgeClass}">${esc(p.injury)}</span>` : "";
    const age = p.classYear ? p.classYear : (p.age != null ? `${p.age} yrs` : "");
    const bio = bioLine(p);
    li.innerHTML = `
      <div class="p-main">
        <span class="rank">${i + 1}</span>
        <span class="p-num">#${esc(p.jersey || "--")}</span>
        <span class="p-name">${esc(p.name)}</span>
        ${p.pos ? `<span class="p-pos">${esc(p.pos)}</span>` : ""}
        <span class="p-age">${age}</span>
        ${badge}
      </div>
      ${bio ? `<div class="p-bio">${bio}</div>` : ""}`;
    popoverList.appendChild(li);
  });
  lastFocused = document.activeElement;
  popover.classList.remove("hidden");
  backdrop.classList.remove("hidden");
  setBackgroundInert(true);
  popoverClose.focus();
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
popover.addEventListener("keydown", (e) => { if (e.key === "Tab") { e.preventDefault(); popoverClose.focus(); } });

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
const teamASelect = document.getElementById("teamA");
const teamBSelect = document.getElementById("teamB");
const statusEl = document.getElementById("status");

async function render(fresh) {
  const gen = ++renderGen;
  closeDepth();
  statusEl.textContent = fresh ? "⟳ Refreshing…" : "⟳ Loading lineups…";
  document.getElementById("surface").classList.add("loading");
  const idA = teamASelect.value, idB = teamBSelect.value;
  writeState();
  try {
    const unitA = CONFIG.dualUnit ? CONFIG.units[0] : null, unitB = CONFIG.dualUnit ? CONFIG.units[1] : null;
    const [dataA, dataB] = await Promise.all([getSide("A", idA, fresh, unitA), getSide("B", idB, fresh, unitB)]);
    if (gen !== renderGen) return;
    const sigA = `${CONFIG.sport}:A:${idA}`, sigB = `${CONFIG.sport}:B:${idB}`;
    decorateBand(document.getElementById("bandA"), document.getElementById("tintA"), dataA, false);
    decorateBand(document.getElementById("bandB"), document.getElementById("tintB"), dataB, true);
    renderTeamOnSurface("playersA", dataA, false, sigA);
    renderTeamOnSurface("playersB", dataB, true, sigB);
    renderList(dataA, dataB);
    render._sigs = [sigA, sigB];
    statusEl.textContent = "";
    const u = document.getElementById("updated");
    if (u) u.textContent = "Updated " + relTime(dataA.updated || dataB.updated);
  } catch (err) {
    statusEl.textContent = "Couldn't load right now. ";
    const b = document.createElement("button");
    b.className = "retry"; b.textContent = "Retry";
    b.addEventListener("click", () => render(true));
    statusEl.appendChild(b);
  } finally {
    document.getElementById("surface").classList.remove("loading");
  }
}

// ---- view toggle ----
function applyView() {
  document.querySelector(".surface-scroll").classList.toggle("hidden", viewMode !== "field");
  document.getElementById("scroll-hint").classList.toggle("hidden", viewMode !== "field");
  document.getElementById("list-view").classList.toggle("hidden", viewMode !== "list");
  document.querySelectorAll(".view-toggle button").forEach((b) => {
    const on = b.dataset.view === viewMode;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });
}
function setView(m) { viewMode = m; applyView(); writeState(); }

// ---- state (URL + localStorage; URL wins on load) ----
function writeState() {
  const p = new URLSearchParams({ a: teamASelect.value, b: teamBSelect.value, v: viewMode });
  try { history.replaceState(null, "", "?" + p.toString()); } catch {}
  try { localStorage.setItem(`sdc.${CONFIG.sport}.state`, p.toString()); } catch {}
}
function readState() {
  const url = new URLSearchParams(location.search);
  let saved = new URLSearchParams();
  try { saved = new URLSearchParams(localStorage.getItem(`sdc.${CONFIG.sport}.state`) || ""); } catch {}
  const get = (k) => url.get(k) ?? saved.get(k) ?? null;
  const setSel = (sel, v) => { if (v != null && [...sel.options].some((o) => o.value === v)) sel.value = v; };
  setSel(teamASelect, get("a")); setSel(teamBSelect, get("b"));
  const v = get("v");
  viewMode = ["field", "list"].includes(v) ? v : (window.matchMedia("(max-width: 760px)").matches ? "list" : "field");
}

function fillTeams(sel) {
  const teams = [...CONFIG.teams].sort((a, b) => a.name.localeCompare(b.name)); // alphabetical
  for (const t of teams) {
    const opt = document.createElement("option");
    opt.value = t.id; opt.textContent = t.name;
    sel.appendChild(opt);
  }
}

// ---- startup ----
(async function start() {
  try {
    CONFIG = await (await fetch(`/api/config?sport=${SPORT}`)).json();
  } catch {
    document.getElementById("status").textContent = "Could not load configuration.";
    return;
  }
  if (!CONFIG || CONFIG.error || !Array.isArray(CONFIG.teams) || !CONFIG.teams.length) {
    document.getElementById("status").textContent = "This sport is temporarily unavailable.";
    return;
  }
  TEAM_BY_ID = new Map(CONFIG.teams.map((t) => [String(t.id), t]));
  document.title = `${CONFIG.name} Starting Lineups`;
  document.getElementById("title").textContent = `${CONFIG.emoji} ${CONFIG.title}`;
  document.getElementById("tagline").textContent = CONFIG.tagline || "";
  document.getElementById("field-label").textContent = `${CONFIG.emoji} ${surfaceWord(CONFIG.surface)}`;
  document.getElementById("midlabel").textContent = midWord(CONFIG.surface);
  document.getElementById("surface").dataset.surface = CONFIG.surface;
  CROSS_OK = CONFIG.surface !== "field"; // football (CFB field) keeps players on their side; everything else can cross
  if (CONFIG.dualUnit && CONFIG.unitLabels) { // e.g. Offense/Defense (CFB) or 1st/2nd Line (NHL)
    document.getElementById("tagA").textContent = CONFIG.unitLabels[0];
    document.getElementById("tagB").textContent = CONFIG.unitLabels[1];
  }

  fillTeams(teamASelect); fillTeams(teamBSelect);
  teamASelect.value = CONFIG.defaults.a; teamBSelect.value = CONFIG.defaults.b;

  document.getElementById("refresh").addEventListener("click", () => render(true));
  document.getElementById("swap").addEventListener("click", () => {
    const a = teamASelect.value; teamASelect.value = teamBSelect.value; teamBSelect.value = a;
    sideCache.A = { key: null, data: null }; sideCache.B = { key: null, data: null };
    render(false);
  });
  [teamASelect, teamBSelect].forEach((s) => s.addEventListener("change", () => render(false)));
  document.querySelectorAll(".view-toggle button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));

  readState();
  applyView();
  render();

  // Keep the page live: quietly re-pull every 4 min (skips when the tab is
  // hidden, a depth chart is open, or a chip is mid-drag).
  setInterval(() => {
    if (document.visibilityState !== "visible") return;
    if (!popover.classList.contains("hidden")) return;
    if (document.querySelector(".chip.dragging")) return;
    render(true);
  }, 240000);
})();

function surfaceWord(s) { return s === "court" ? "Court" : s === "pitch" ? "Pitch" : s === "rink" ? "Ice" : s === "diamond" ? "Diamond" : "Field"; }
function midWord(s) { return s === "court" ? "HALF COURT" : s === "pitch" ? "MIDFIELD" : s === "rink" ? "CENTER ICE" : s === "field" ? "LINE OF SCRIMMAGE" : s === "diamond" ? "VS" : "MIDFIELD"; }
