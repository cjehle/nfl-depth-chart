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
let ratingLabel = null; // video-game ratings source for this sport (e.g. "EA FC"), or null
let draftStatus = false; // does this sport carry NHL draft status? (college hockey)
let seasonYear = null;   // selected past season (null = current)
let compareMode = false;                 // tap-two-players-to-compare mode
const pinned = { A: null, B: null };     // {face, teamName} pinned per side
let formationValue = null;               // soccer formation override (server re-arranges)
let courtSet = null;                     // basketball court alignment set (client re-places)
const sideForm = { A: null, B: null };   // CFB per-unit package (A=defense front, B=offense personnel); server re-arranges
// Client-side court alignment presets (basketball), keyed by chip slot.
const COURT_SETS = {
  "Balanced": { PG: [50, 50], SG: [84, 40], SF: [16, 40], PF: [38, 23], C: [55, 16] },
  "Small ball": { PG: [50, 52], SG: [86, 44], SF: [14, 44], PF: [72, 30], C: [50, 15] },
  "Two bigs": { PG: [50, 52], SG: [84, 43], SF: [16, 43], PF: [38, 20], C: [60, 14] },
  "Three guard": { PG: [50, 52], SG: [80, 46], SF: [20, 46], PF: [36, 25], C: [60, 17] },
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
// esc(), hexToRgba(), injuryClass(), relTime() now live in /common.js (shared with the
// NFL app, loaded via <script src="/common.js" defer> before this file).
// Jersey number as "#N", or "" when the player has none (avoids a bare "#").
function jnum(j) { return j ? `#${esc(j)}` : ""; }
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
// Short calendar date like "Aug 12" (for the game a lineup is derived from).
function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
// Compact next-game string like "Next: vs LAR · Sun" from team.next, or "".
function nextGame(next) {
  if (!next || !next.opp) return "";
  const day = next.date ? new Date(next.date).toLocaleDateString(undefined, { weekday: "short" }) : "";
  return `Next: ${next.homeAway} ${next.opp}${day ? " · " + day : ""}`;
}
// NHL draft status pill for the depth popover (college hockey), or "".
function draftPill(d) {
  if (!d) return "";
  if (d.drafted) return `<div class="p-draft drafted">🏒 NHL Draft · ${esc(d.label)}</div>`;
  return `<div class="p-draft undrafted">🏒 NHL Draft · Undrafted</div>`;
}

// ---------------------------------------------------------------------------
// FETCH (per-side cache: switching the view never refetches a team)
// ---------------------------------------------------------------------------
// The formation to send to the server for a given side. Soccer ("server") shares
// one whole-team formation across both sides; CFB ("unit") has an independent
// package per side; basketball ("court") re-places client-side, so nothing is sent.
function sideFormation(side) {
  if (CONFIG.formationMode === "server") return formationValue || null;
  if (CONFIG.formationMode === "unit") return sideForm[side] || null;
  return null;
}
async function fetchLineup(teamId, fresh, unit, year, formation) {
  // Always ask for fresh data so the lineup updates on every load. The server
  // coalesces this to at most one ESPN pull per team per ~60s (fast + polite).
  // A 20s client timeout means a stuck request drops to the Retry button instead
  // of hanging on the loading spinner forever. (Past seasons can be slower — a
  // longer timeout so historical box-score builds don't drop to Retry.)
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), year ? 30000 : 20000);
  try {
    const fParam = formation ? `&formation=${encodeURIComponent(formation)}` : "";
    const res = await fetch(`/api/lineup?sport=${SPORT}&team=${teamId}&fresh=1${unit ? `&unit=${unit}` : ""}${year ? `&year=${year}` : ""}${fParam}`, { signal: ctrl.signal });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
  } finally { clearTimeout(timer); }
}
async function getSide(side, teamId, fresh, unit, year) {
  const form = sideFormation(side);
  const c = sideCache[side];
  const ck = `${teamId}:${unit || ""}:${year || ""}:${form || ""}`;
  if (!fresh && c.key === ck && c.data) return c.data;
  const data = await fetchLineup(teamId, fresh, unit, year, form);
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
  let left = (parseFloat(chip.style.left) / box.clientWidth) * 100;
  let top = (parseFloat(chip.style.top) / box.clientHeight) * 100;
  if (!isFinite(left) || !isFinite(top)) return;
  // Never store a position outside the chip's own half on a two-team surface — that
  // is exactly what strands a chip over the other team.
  if (!CONFIG.singleTeam) { left = Math.max(0, Math.min(100, left)); top = Math.max(0, Math.min(100, top)); }
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
function makeChip(chipData, teamAbbr, teamColor, onMoved, side, teamName) {
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
  const ovr = face.overall != null ? `<div class="chip-ovr" title="${esc(ratingLabel || "")} overall rating">${face.overall}</div>` : "";
  chip.innerHTML = `
    <div class="pos">${esc(chipData.label)}${face.jersey ? " · " + jnum(face.jersey) : ""}</div>
    <div class="name">${esc(face.name)}</div>
    ${ovr}${badge}${depthHtml}
  `;
  const open = () => activateChip(chipData, teamAbbr, side, teamName);
  chip.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  makeDraggable(chip, open, onMoved);
  return chip;
}
// A chip click either opens the depth popover, or — in Compare mode — pins that
// player (as their team's side) into the compare drawer.
function activateChip(chipData, teamAbbr, side, teamName) {
  if (compareMode && side) pinPlayer(chipData.face, teamName || teamAbbr, side);
  else openDepth(`${teamAbbr} — ${chipData.label}`, chipData.players);
}

// ---------------------------------------------------------------------------
// RENDER — the surface (two teams: A on top, B mirrored on the bottom)
// ---------------------------------------------------------------------------
function renderTeamOnSurface(containerId, data, mirror, sig) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  if (!data.chips || !data.chips.length) {
    container.innerHTML = `<div class="empty-lineup"><strong>No lineup published yet</strong>
      <span>${esc(data.team && data.team.name || "This team")} isn't posted by our data source right now — it usually fills in closer to game day. This page updates itself, so check back.</span></div>`;
    return;
  }
  const saved = layouts[sig] || {};
  const side = containerId === "playersA" ? "A" : "B";
  data.chips.forEach((ch, i) => {
    const chipKey = `${ch.key}#${i}`;
    const chip = makeChip(ch, data.team.abbr, data.team.color, () => persistChip(sig, chipKey, chip), side, data.team.name);
    let cx = ch.x, cy = ch.y;
    const set = courtSet && CONFIG.formationMode === "court" && COURT_SETS[courtSet]; // basketball alignment
    if (set && set[ch.key]) { cx = set[ch.key][0]; cy = set[ch.key][1]; }
    chip.style.left = cx + "%";
    chip.style.top = (mirror ? 100 - cy : cy) + "%";
    const pos = saved[chipKey];
    if (pos) {
      const L = parseFloat(pos.left), T = parseFloat(pos.top);
      // Honor a saved (dragged) position only if it sits inside this team's own half.
      // A stale out-of-half position — from the old cross-midline drag that stranded
      // and froze a chip over the OTHER team — is discarded (the chip falls back to its
      // formation spot) and purged, so corrupted saved layouts self-heal on load.
      if (CONFIG.singleTeam || (L >= 0 && L <= 100 && T >= 0 && T <= 100)) {
        chip.style.left = pos.left; chip.style.top = pos.top;
      } else { delete saved[chipKey]; saveLayouts(layouts); }
    }
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
  // Upcoming opponent (already in the payload) as a subtle secondary line.
  const ng = nextGame(t.next);
  if (ng) { const n = document.createElement("span"); n.className = "band-next"; n.textContent = ng; bandEl.appendChild(n); }
  bandEl.style.background = hexToRgba(t.color, 0.92);
  tintEl.style.background = `linear-gradient(${mirror ? 0 : 180}deg, ${hexToRgba(t.color, 0.32)}, ${hexToRgba(t.color, 0.08)})`;
}

// ---------------------------------------------------------------------------
// RENDER — list view (grouped by line, per team; a11y + mobile friendly)
// ---------------------------------------------------------------------------
function renderList(dataA, dataB) {
  const el = document.getElementById("list-view");
  el.innerHTML = "";
  el.appendChild(listTeam(dataA, "A"));
  if (!dataB) return; // single-team sports (baseball) show only one lineup
  el.appendChild(listTeam(dataB, "B"));
}
function listTeam(data, side) {
  const sec = document.createElement("section");
  sec.className = "list-team";
  const t = data.team;
  const h = document.createElement("h2");
  // Match the field band's context — AP rank + W-L record — so List/mobile users (the
  // majority) don't lose the record/ranking the payload already carries.
  const rank = t.rank ? `#${t.rank} ` : "";
  const rec = t.record && !/^0-0/.test(t.record) ? ` (${t.record})` : "";
  h.textContent = `${rank}${t.name}${rec} · ${data.subtitle || ""}`;
  h.style.borderLeftColor = t.color || "#666";
  sec.appendChild(h);
  const ng = nextGame(t.next);
  if (ng) { const m = document.createElement("div"); m.className = "list-meta"; m.textContent = ng; sec.appendChild(m); }
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
      const ovr = face.overall != null ? `<span class="list-ovr" title="${esc(ratingLabel || "")} overall rating">${face.overall}</span>` : "";
      const dr = face.draft && face.draft.drafted ? `<span class="list-draft" title="NHL Draft: ${esc(face.draft.label)}">${esc(face.draft.team)} R${face.draft.round}</span>` : "";
      btn.innerHTML = `
        <span class="list-pos">${esc(ch.label)}</span>
        <span class="list-name">${esc(face.name)} <span class="list-num">${jnum(face.jersey)}</span></span>
        ${ovr}${dr}${badge}${depth}`;
      btn.addEventListener("click", () => activateChip(ch, data.team.abbr, side, data.team.name));
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
  document.querySelectorAll(".site-nav, .topbar, .surface-scroll, #list-view, .status").forEach((el) => {
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
  const gen = popoverGen;
  players.forEach((p, i) => {
    const li = document.createElement("li");
    if (i === 0) li.className = "starter";
    const badgeClass = injuryClass(p.injury);
    const badge = badgeClass ? `<span class="badge ${badgeClass}">${esc(p.injury)}</span>` : "";
    const age = p.classYear ? p.classYear : (p.age != null ? `${p.age} yrs` : "");
    const bio = bioLine(p);
    const ovr = p.overall != null ? `<span class="p-ovr" title="${esc(ratingLabel || "")} overall rating">${p.overall}<i>OVR</i></span>` : "";
    const draftHtml = draftPill(p.draft);
    const photo = p.photo ? `<img class="p-photo" src="${esc(p.photo)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : `<span class="p-photo p-photo-blank">${esc(jnum(p.jersey) || "")}</span>`;
    const link = p.espnUrl ? `<a class="p-espn" href="${esc(p.espnUrl)}" target="_blank" rel="noopener noreferrer" title="Full profile on ESPN" aria-label="${esc(p.name)} on ESPN">↗</a>` : "";
    // Full injury detail (what + expected return), when ESPN has it.
    const inj = p.injuryDetail && (p.injuryDetail.detail || p.injuryDetail.ret)
      ? `<div class="p-injury">⚕ ${esc(p.injury || "Injured")}${p.injuryDetail.detail ? " · " + esc(p.injuryDetail.detail) : ""}${p.injuryDetail.ret ? " · back " + fmtDate(p.injuryDetail.ret) : ""}</div>` : "";
    li.innerHTML = `
      <div class="p-main">
        <span class="rank">${i + 1}</span>
        ${photo}
        <span class="p-name">${esc(p.name)}${p.jersey ? ` <span class="p-num">${jnum(p.jersey)}</span>` : ""}</span>
        ${p.pos ? `<span class="p-pos">${esc(p.pos)}</span>` : ""}
        <span class="p-age">${age}</span>
        ${ovr}
        ${badge}
        ${link}
      </div>
      ${i === 0 ? `<div class="p-stats" data-loading>…</div>` : ""}
      ${draftHtml}
      ${inj}
      ${bio ? `<div class="p-bio">${bio}</div>` : ""}`;
    popoverList.appendChild(li);
    if (i === 0 && p.id) loadPlayerStats(li.querySelector(".p-stats"), p.id, gen);
  });
  lastFocused = document.activeElement;
  popover.classList.remove("hidden");
  backdrop.classList.remove("hidden");
  setBackgroundInert(true);
  popoverClose.focus();
}
// Lazily fetch the starter's season stat line and render it in the popover.
async function loadPlayerStats(el, id, gen) {
  if (!el) return;
  try {
    const q = `/api/player-stats?sport=${SPORT}&id=${encodeURIComponent(id)}${seasonYear ? `&year=${seasonYear}` : ""}`;
    const d = await (await fetch(q, { signal: AbortSignal.timeout(12000) })).json();
    if (gen !== popoverGen || !el.isConnected) return; // popover changed/closed
    if (d && Array.isArray(d.line) && d.line.length) {
      el.removeAttribute("data-loading");
      el.innerHTML = d.line.map((s) => `<span class="stat"><b>${esc(s.v)}</b> ${esc(s.k)}</span>`).join("");
    } else { el.remove(); }
  } catch { if (el.isConnected) el.remove(); }
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
// Keep focus inside the dialog, but as a proper WRAP-AROUND cycle so every control —
// including each player's ESPN ↗ link — is keyboard-reachable (the old trap slammed
// focus back to Close on every Tab, hiding those links from keyboard/AT users).
popover.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  const f = [...popover.querySelectorAll('button, a[href], select, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && el.offsetParent !== null);
  if (!f.length) { e.preventDefault(); popoverClose.focus(); return; }
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  // else: let the browser move focus naturally to the next control in the dialog
});

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
const teamASelect = document.getElementById("teamA");
const teamBSelect = document.getElementById("teamB");
const statusEl = document.getElementById("status");

// Build ONLY the currently-visible view's DOM. The other view is constructed
// lazily the first time the user switches to it (setView). On phones the default
// is List, so first paint skips building the entire hidden Field surface — dozens
// of chips plus ~5 drag listeners each — which is the biggest avoidable main-thread
// cost on the exact device that defaults to List.
function buildActiveView() {
  const st = render._state; if (!st) return;
  if (viewMode === "list") {
    if (!st.builtList) { renderList(st.dataA, st.dataB); st.builtList = true; }
  } else {
    if (!st.builtField) {
      decorateBand(document.getElementById("bandA"), document.getElementById("tintA"), st.dataA, false);
      renderTeamOnSurface("playersA", st.dataA, false, st.sigA);
      if (!st.single) {
        decorateBand(document.getElementById("bandB"), document.getElementById("tintB"), st.dataB, true);
        renderTeamOnSurface("playersB", st.dataB, true, st.sigB);
      }
      st.builtField = true;
    }
  }
}
// Honest degradation cue: when the server served a saved copy because ESPN was
// unreachable, say so plainly instead of passing canned data off as live.
function setStaleBanner(source) {
  const el = document.getElementById("stale-banner"); if (!el) return;
  if (!source) { el.classList.add("hidden"); el.textContent = ""; return; }
  el.textContent = "⚠ Showing a saved lineup — live data is temporarily unavailable. This page keeps retrying and will refresh itself.";
  el.classList.remove("hidden");
}
function updateUpdatedLabel(dataA, dataB) {
  const u = document.getElementById("updated");
  if (!u) return;
  // "as of" = the game/match date the lineup is derived from (may be days old in a
  // break), so an old typical lineup can't masquerade as freshly updated.
  const asOf = fmtDate((dataA && dataA.asOf) || (dataB && dataB.asOf));
  u.textContent = "Updated " + relTime((dataA && dataA.updated) || (dataB && dataB.updated)) + (asOf ? ` · lineup as of ${asOf}` : "");
}
// render(fresh) — user-initiated (shows loading, rebuilds the active view).
// render(true, true) — the background auto-refresh: silent (no loading flash), and
// if the data is byte-identical to what's shown it only refreshes the timestamp.
async function render(fresh, auto) {
  const gen = ++renderGen;
  closeDepth();
  const surfaceEl = document.getElementById("surface");
  if (!auto) { statusEl.textContent = fresh ? "⟳ Refreshing…" : "⟳ Loading lineups…"; surfaceEl.classList.add("loading"); }
  const idA = teamASelect.value, idB = teamBSelect.value;
  writeState();
  try {
    const single = !!CONFIG.singleTeam;
    let dataA, dataB = null;
    if (single) {
      dataA = await getSide("A", idA, fresh, null, seasonYear);
    } else {
      const unitA = CONFIG.dualUnit ? CONFIG.units[0] : null, unitB = CONFIG.dualUnit ? CONFIG.units[1] : null;
      [dataA, dataB] = await Promise.all([getSide("A", idA, fresh, unitA, seasonYear), getSide("B", idB, fresh, unitB, seasonYear)]);
    }
    if (gen !== renderGen) return;
    // Be honest when the server had to fall back to a saved copy (upstream down).
    setStaleBanner((dataA && dataA.stale && dataA.source) || (dataB && dataB.stale && dataB.source) || null);

    // Auto-refresh that returns identical data → refresh only the "Updated N ago"
    // label and skip the DOM teardown/rebuild entirely (lineups rarely change
    // between pulls; rebuilding every 4 min is wasted reflow + battery on mobile).
    const stamp = `${(dataA && dataA.updated) || ""}|${(dataB && dataB.updated) || ""}`;
    const prev = render._state;
    const unchanged = auto && prev && prev.stamp === stamp && prev.idA === idA && prev.idB === idB;

    ratingLabel = (dataA && dataA.ratingLabel) || (dataB && dataB.ratingLabel) || null;
    draftStatus = !!((dataA && dataA.draftStatus) || (dataB && dataB.draftStatus));
    const sigA = `${CONFIG.sport}:A:${idA}`, sigB = single ? null : `${CONFIG.sport}:B:${idB}`;
    render._sigs = single ? [sigA] : [sigA, sigB];
    if (unchanged) {
      prev.stamp = stamp; // (already equal) keep for the next comparison
    } else {
      render._state = { single, dataA, dataB, sigA, sigB, idA, idB, stamp, builtField: false, builtList: false };
      buildActiveView(); // build the visible view now; the other builds on switch
    }
    updateUpdatedLabel(dataA, dataB);
    statusEl.textContent = "";
  } catch (err) {
    if (!auto) {
      statusEl.textContent = "Couldn't load right now. ";
      const b = document.createElement("button");
      b.className = "retry"; b.textContent = "Retry";
      b.addEventListener("click", () => render(true));
      statusEl.appendChild(b);
    }
  } finally {
    surfaceEl.classList.remove("loading");
  }
}

// ---- share the current matchup (URL already carries ?a=&b=&v= via writeState) ----
async function shareMatchup(btn) {
  const url = location.href;
  const title = document.title;
  try {
    if (navigator.share) { await navigator.share({ title, url }); return; }
    await navigator.clipboard.writeText(url);
    flashStatus("Link copied to clipboard");
  } catch (e) {
    if (e && e.name === "AbortError") return; // user dismissed the native sheet
    try { await navigator.clipboard.writeText(url); flashStatus("Link copied to clipboard"); }
    catch { flashStatus("Copy this page's URL to share"); }
  }
}
function flashStatus(msg) {
  const s = document.getElementById("status");
  if (!s) return;
  s.textContent = msg;
  clearTimeout(flashStatus._t);
  flashStatus._t = setTimeout(() => { if (s.textContent === msg) s.textContent = ""; }, 2500);
}

// ---- compare two players (one per team) ----
function setCompareMode(on) {
  compareMode = on;
  const btn = document.getElementById("compare");
  if (btn) { btn.classList.toggle("active", on); btn.setAttribute("aria-pressed", String(on)); }
  if (!on) { pinned.A = null; pinned.B = null; }
  document.getElementById("compare-drawer").classList.toggle("hidden", !on);
  document.body.classList.toggle("cmp-open", on); // reserve bottom space so the fixed drawer never hides the last players (phones)
  if (on) { renderCompare(); flashStatus("Compare: tap a player on each side"); }
}
function pinPlayer(face, teamName, side) {
  pinned[side] = { face, teamName };
  renderCompare();
}
function compareCol(pin, sideLabel) {
  if (!pin) return `<div class="cmp-col cmp-empty"><span>Tap a ${sideLabel} player</span></div>`;
  const p = pin.face;
  const photo = p.photo ? `<img class="cmp-photo" src="${esc(p.photo)}" alt="" onerror="this.style.visibility='hidden'">` : `<span class="cmp-photo"></span>`;
  const ovr = p.overall != null ? `<span class="cmp-ovr">${p.overall}<i>OVR</i></span>` : "";
  const bits = [p.pos, p.classYear || (p.age != null ? p.age + " yrs" : ""), p.height].filter(Boolean).join(" · ");
  return `<div class="cmp-col" data-id="${esc(p.id || "")}">
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
  if (!compareMode) { d.classList.add("hidden"); return; }
  d.classList.remove("hidden");
  d.innerHTML = `<button class="cmp-close" aria-label="Close compare">✕</button>
    <div class="cmp-grid">${compareCol(pinned.A, "top")}<div class="cmp-vs">vs</div>${compareCol(pinned.B, "bottom")}</div>`;
  d.querySelector(".cmp-close").addEventListener("click", () => setCompareMode(false));
  // Fetch both stat lines, then bold the better value on each shared stat.
  const cols = d.querySelectorAll(".cmp-col[data-id]");
  const lines = await Promise.all([...cols].map(async (col) => {
    const id = col.getAttribute("data-id"); const el = col.querySelector(".cmp-stats");
    if (!id) { el.remove(); return null; }
    try {
      const r = await (await fetch(`/api/player-stats?sport=${SPORT}&id=${encodeURIComponent(id)}${seasonYear ? `&year=${seasonYear}` : ""}`, { signal: AbortSignal.timeout(12000) })).json();
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
function setView(m) {
  viewMode = m;
  const dc = window.matchMedia("(max-width: 760px)").matches ? "m" : "d";
  try { localStorage.setItem("sdc.view." + dc, m); } catch {}
  buildActiveView(); // construct the newly-shown view if it wasn't built yet (build while hidden, then reveal)
  applyView(); writeState();
}

// ---- state (URL + localStorage; URL wins on load) ----
function writeState() {
  const p = new URLSearchParams({ a: teamASelect.value, b: teamBSelect.value, v: viewMode });
  if (seasonYear) p.set("s", String(seasonYear));
  if (CONFIG.formationMode === "unit") {
    if (sideForm.A) p.set("fa", sideForm.A);
    if (sideForm.B) p.set("fb", sideForm.B);
  } else {
    const f = CONFIG.formationMode === "court" ? courtSet : formationValue;
    if (f) p.set("f", f);
  }
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
  const seasonSel = document.getElementById("season");
  if (seasonSel) { const s = get("s"); if (s != null && [...seasonSel.options].some((o) => o.value === s)) { seasonSel.value = s; seasonYear = s ? Number(s) : null; } }
  const fSel = document.getElementById("formation");
  if (fSel) { const f = get("f"); if (f != null && [...fSel.options].some((o) => o.value === f)) { fSel.value = f; if (CONFIG.formationMode === "court") courtSet = f || null; else formationValue = f || null; } }
  if (CONFIG.formationMode === "unit") {
    for (const [selId, key, side] of [["formUnitA", "fa", "A"], ["formUnitB", "fb", "B"]]) {
      const sel = document.getElementById(selId); const v = get(key);
      if (sel && v != null && [...sel.options].some((o) => o.value === v)) { sel.value = v; sideForm[side] = v || null; }
    }
  }
  // View: an explicit URL ?v= wins (shareable); otherwise a per-DEVICE saved
  // preference, else the device default (desktop → surface, mobile → list). Scoping
  // by device means choosing List on a phone doesn't hide the surface on desktop.
  const urlV = url.get("v");
  const dc = window.matchMedia("(max-width: 760px)").matches ? "m" : "d";
  let devPref = null; try { devPref = localStorage.getItem("sdc.view." + dc); } catch {}
  viewMode = ["field", "list"].includes(urlV) ? urlV : (["field", "list"].includes(devPref) ? devPref : (dc === "m" ? "list" : "field"));
}

function fillTeams(sel, conf) {
  sel.innerHTML = "";
  const teams = [...CONFIG.teams]
    .filter((t) => !conf || t.conf === conf)
    .sort((a, b) => a.name.localeCompare(b.name)); // alphabetical
  const mkOpt = (t) => { const o = document.createElement("option"); o.value = t.id; o.textContent = t.name; return o; };
  // Group by conference with native <optgroup> when teams carry one (CBB 362 / CFB 138 /
  // college hockey) so the huge pickers are scannable in a single interaction. Plain flat
  // list otherwise (NBA/MLB/soccer). option.value stays the team id, so state/sync are unaffected.
  if (!teams.some((t) => t.conf)) { for (const t of teams) sel.appendChild(mkOpt(t)); return; }
  const confs = [...new Set(teams.map((t) => t.conf || "Other"))].sort((a, b) => a.localeCompare(b));
  for (const c of confs) {
    const g = document.createElement("optgroup"); g.label = c;
    for (const t of teams.filter((t) => (t.conf || "Other") === c)) g.appendChild(mkOpt(t));
    sel.appendChild(g);
  }
}
// Conference filter helpers (college sports whose teams carry a `conf`).
const teamConf = (id) => (CONFIG.teams.find((t) => String(t.id) === String(id)) || {}).conf || "";
function fillConfs(sel) {
  const confs = [...new Set(CONFIG.teams.map((t) => t.conf).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  sel.innerHTML = "";
  const all = document.createElement("option"); all.value = ""; all.textContent = "All conferences"; sel.appendChild(all);
  for (const c of confs) { const o = document.createElement("option"); o.value = c; o.textContent = c; sel.appendChild(o); }
}
// Season options: "Current" (auto) + the previous 5 seasons. Two-calendar-year
// leagues (NBA/CBB) are labeled by end year ("2024-25"); the rest by calendar year.
function fillSeasons(sel) {
  const nowY = new Date().getUTCFullYear();
  const endYear = CONFIG.seasonEndYear;
  const cur = endYear ? (new Date().getUTCMonth() >= 8 ? nowY + 1 : nowY) : nowY;
  const label = (y) => (endYear ? `${y - 1}-${String(y).slice(2)}` : String(y));
  const opts = [["", "Current"]];
  for (let i = 1; i <= 5; i++) { const y = cur - i; opts.push([String(y), label(y)]); }
  for (const [val, txt] of opts) { const o = document.createElement("option"); o.value = val; o.textContent = txt; sel.appendChild(o); }
}

// ---- startup ----
(async function start() {
  try {
    // Prefer the inlined config data island (no round-trip); fall back to the API.
    const el = document.getElementById("sdc-config");
    if (el) { try { CONFIG = JSON.parse(el.textContent); } catch {} }
    if (!CONFIG) CONFIG = await (await fetch(`/api/config?sport=${SPORT}`)).json();
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
  // Each team owns its half of the surface (A on top, B on the bottom), so a chip
  // must stay in its own half — otherwise a dragged chip can be stranded over the
  // OTHER team and, once its out-of-half position is saved, stays frozen there on
  // every render. Only a lone team (single-team MLB, which fills the whole surface)
  // may be dragged anywhere.
  CROSS_OK = !!CONFIG.singleTeam;
  if (CONFIG.singleTeam) {
    // One team fills the whole surface: hide the second team's controls + swap.
    document.getElementById("surface").classList.add("single");
    const rowB = document.querySelector(".control-row.rowB"); if (rowB) rowB.style.display = "none";
    const swap = document.getElementById("swap"); if (swap) swap.style.display = "none";
    const tagA = document.getElementById("tagA"); if (tagA) tagA.style.display = "none";
  }
  if (CONFIG.dualUnit && CONFIG.unitLabels) { // e.g. Offense/Defense (CFB) or 1st/2nd Line (NHL)
    document.getElementById("tagA").textContent = CONFIG.unitLabels[0];
    document.getElementById("tagB").textContent = CONFIG.unitLabels[1];
  }

  fillTeams(teamASelect); fillTeams(teamBSelect);
  teamASelect.value = CONFIG.defaults.a; teamBSelect.value = CONFIG.defaults.b;

  // Past-season selector (only on sports with rich historical data).
  if (CONFIG.history) {
    const seasonSel = document.getElementById("season");
    const picker = document.querySelector(".season-picker");
    if (seasonSel && picker) {
      fillSeasons(seasonSel);
      picker.classList.remove("hidden");
      seasonSel.addEventListener("change", () => {
        seasonYear = seasonSel.value ? Number(seasonSel.value) : null;
        sideCache.A = { key: null, data: null }; sideCache.B = { key: null, data: null };
        render(false);
      });
    }
  }

  // Formation selector — soccer re-arranges the XI server-side into the picked
  // formation; basketball re-places the five client-side into a court set.
  if (CONFIG.formations && CONFIG.formations.length) {
    const fsel = document.getElementById("formation");
    const picker = fsel && fsel.closest(".formation-picker");
    if (fsel && picker) {
      const isCourt = CONFIG.formationMode === "court";
      document.getElementById("formation-label").textContent = isCourt ? "Court set" : "Formation";
      const auto = document.createElement("option"); auto.value = ""; auto.textContent = isCourt ? "Default" : "Auto"; fsel.appendChild(auto);
      for (const f of CONFIG.formations) { const o = document.createElement("option"); o.value = f; o.textContent = f; fsel.appendChild(o); }
      picker.classList.remove("hidden");
      fsel.addEventListener("change", () => {
        if (isCourt) courtSet = fsel.value || null;
        else { formationValue = fsel.value || null; sideCache.A = { key: null, data: null }; sideCache.B = { key: null, data: null }; }
        writeState();
        render(false);
      });
    }
  }

  // Per-unit formation (CFB): one dropdown on each side's controls — offense picks
  // a personnel grouping, defense picks a front. Each re-fetches only its own side.
  if (CONFIG.formationMode === "unit" && CONFIG.unitFormations && CONFIG.units) {
    const labels = CONFIG.unitFormationLabels || {};
    const wireUnit = (selId, labelId, side, unitName) => {
      const sel = document.getElementById(selId);
      const picker = sel && sel.closest(".formation-inline");
      const opts = CONFIG.unitFormations[unitName] || [];
      if (!sel || !picker || !opts.length) return;
      document.getElementById(labelId).textContent = labels[unitName] || "Formation";
      const auto = document.createElement("option"); auto.value = ""; auto.textContent = "Auto"; sel.appendChild(auto);
      for (const f of opts) { const o = document.createElement("option"); o.value = f; o.textContent = f; sel.appendChild(o); }
      picker.classList.remove("hidden");
      sel.addEventListener("change", () => {
        sideForm[side] = sel.value || null;
        sideCache[side] = { key: null, data: null };
        writeState();
        render(false);
      });
    };
    wireUnit("formUnitA", "formUnitA-label", "A", CONFIG.units[0]);
    wireUnit("formUnitB", "formUnitB-label", "B", CONFIG.units[1]);
  }

  // Conference filter (college sports whose teams carry a conference). The Conf
  // dropdown filters the Team dropdown; picking a team syncs the Conf shown.
  const hasConf = CONFIG.teams.some((t) => t.conf);
  const confA = document.getElementById("confA"), confB = document.getElementById("confB");
  const syncConf = (confSel, teamSel) => { if (confSel) confSel.value = teamConf(teamSel.value) || ""; };
  const refill = (teamSel, conf, prefer) => { fillTeams(teamSel, conf || null); if (prefer && [...teamSel.options].some((o) => o.value === String(prefer))) teamSel.value = String(prefer); };
  if (hasConf) {
    for (const [confSel, teamSel, side] of [[confA, teamASelect, "A"], [confB, teamBSelect, "B"]]) {
      if (!confSel) continue;
      confSel.closest(".conf-picker").classList.remove("hidden");
      fillConfs(confSel);
      confSel.value = teamConf(teamSel.value) || ""; // reflect the default team's conference
      confSel.addEventListener("change", () => {
        refill(teamSel, confSel.value, teamSel.value);
        sideCache[side] = { key: null, data: null };
        render(false);
      });
    }
  }

  document.getElementById("refresh").addEventListener("click", () => render(true));
  document.getElementById("swap").addEventListener("click", () => {
    const a = teamASelect.value, b = teamBSelect.value;
    if (hasConf) { refill(teamASelect, "", b); refill(teamBSelect, "", a); syncConf(confA, teamASelect); syncConf(confB, teamBSelect); }
    else { teamASelect.value = b; teamBSelect.value = a; }
    sideCache.A = { key: null, data: null }; sideCache.B = { key: null, data: null };
    render(false);
  });
  const shareBtn = document.getElementById("share");
  if (shareBtn) shareBtn.addEventListener("click", () => shareMatchup(shareBtn));
  const cmpBtn = document.getElementById("compare");
  if (cmpBtn) {
    if (CONFIG.singleTeam) cmpBtn.style.display = "none"; // compare needs two teams
    else cmpBtn.addEventListener("click", () => setCompareMode(!compareMode));
  }
  teamASelect.addEventListener("change", () => { syncConf(confA, teamASelect); render(false); });
  teamBSelect.addEventListener("change", () => { syncConf(confB, teamBSelect); render(false); });
  document.querySelectorAll(".view-toggle button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));

  readState();
  if (hasConf) { syncConf(confA, teamASelect); syncConf(confB, teamBSelect); }
  applyView();
  render();

  // Keep the page live: quietly re-pull every 4 min (skips when the tab is
  // hidden, a depth chart is open, or a chip is mid-drag).
  setInterval(() => {
    if (document.visibilityState !== "visible") return;
    if (!popover.classList.contains("hidden")) return;
    if (document.querySelector(".chip.dragging")) return;
    render(true, true); // silent background refresh: no loading flash, skips rebuild when unchanged
  }, 240000);
})();

function surfaceWord(s) { return s === "court" ? "Court" : s === "pitch" ? "Pitch" : s === "rink" ? "Ice" : s === "diamond" ? "Diamond" : "Field"; }
function midWord(s) { return s === "court" ? "HALF COURT" : s === "pitch" ? "MIDFIELD" : s === "rink" ? "CENTER ICE" : s === "field" ? "LINE OF SCRIMMAGE" : s === "diamond" ? "VS" : "MIDFIELD"; }
