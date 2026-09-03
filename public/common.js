// common.js — pure, app-agnostic browser helpers shared by BOTH client apps
// (public/nfl/app.js and public/surface/app.js). Loaded as a classic <script defer>
// BEFORE each app.js, so these become the single definition both apps use.
//
// These were previously copy-pasted into each app and had already drifted — the
// injuryClass severity map, in particular, disagreed between the two pages (a
// suspended player showed red on one and grey on the other). One definition here
// keeps them in lockstep by construction. Kept deliberately small + dependency-free;
// stateful/DOM-coupled helpers (drag, view/state) stay per-app.

// Escape untrusted text for HTML interpolation.
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// A team hex color → rgba() tint, tolerant of a missing/short hex.
function hexToRgba(hex, alpha) {
  const h = String(hex || "#333333").replace("#", "");
  const r = parseInt(h.substring(0, 2), 16), g = parseInt(h.substring(2, 4), 16), b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r || 40}, ${g || 40}, ${b || 40}, ${alpha})`;
}

// Injury/availability status → severity class for the badge color. Superset of what
// both apps used, so "suspended", "day-to-day", and "pup" now render the SAME
// severity everywhere: out=red, questionable=yellow, other=grey.
function injuryClass(status) {
  if (!status) return null;
  const s = String(status).toLowerCase();
  if (s.includes("out") || s.includes("ir") || s.includes("reserve") || s.includes("susp") || s.includes("pup")) return "out";
  if (s.includes("question") || s.includes("doubt") || s.includes("day")) return "questionable";
  return "other";
}

// Rewrite an ESPN headshot/team-logo URL through ESPN's image combiner at a target pixel
// size, so a 34-46px avatar or a 20px crest pulls a ~1-11KB image instead of the 230-270KB
// full-res original (~96% less mobile data). Only rewrites espncdn headshot/teamlogo URLs;
// anything else (or an already-combiner URL) is returned untouched. CSP img-src allows *.espncdn.com.
function sized(url, px) {
  if (!url || typeof url !== "string") return url;
  const m = url.match(/^https:\/\/a\.espncdn\.com(\/i\/(?:headshots|teamlogos)\/.+)$/);
  return m ? `https://a.espncdn.com/combiner/i?img=${m[1]}&w=${px}&h=${px}` : url;
}

// A broken player headshot hides itself. Inline `onerror=` attributes are blocked by
// our CSP (script-src 'self', no unsafe-inline), so one delegated capture-phase listener
// handles it for every popover/compare image (error events don't bubble → capture).
addEventListener("error", (e) => {
  const t = e.target;
  if (t instanceof HTMLImageElement && /\b(p-photo|cmp-photo|list-photo)\b/.test(t.className)) t.style.visibility = "hidden";
}, true);

// In-feed ad slot (List view), shared by both apps. Inserted ONCE per page load after the
// first list section — only when the server enabled ads (#sdc-ads island present). ads.js
// reserves + lazily fills it after consent. Once-per-page is deliberate: the 4-min silent
// auto-refresh rebuilds the list, and re-pushing an ad on a non-user-initiated refresh
// would violate AdSense's no-auto-refresh policy. If ads are off, this is a no-op.
let _feedAdInserted = false;
function insertFeedAd(listEl) {
  if (_feedAdInserted || !listEl || !document.getElementById("sdc-ads")) return;
  const ad = document.createElement("div");
  ad.className = "ad-slot ad-feed";
  ad.setAttribute("data-ad-slot-name", "feed");
  const first = listEl.firstElementChild;
  if (first && first.nextSibling) listEl.insertBefore(ad, first.nextSibling); else listEl.appendChild(ad);
  _feedAdInserted = true;
  if (window.__adsScan) window.__adsScan();
}

// "Updated N ago" relative time from an ISO timestamp.
function relTime(iso) {
  if (!iso) return "just now";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
  return `${Math.round(s / 86400)} d ago`;
}
