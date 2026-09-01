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

// "Updated N ago" relative time from an ISO timestamp.
function relTime(iso) {
  if (!iso) return "just now";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
  return `${Math.round(s / 86400)} d ago`;
}
