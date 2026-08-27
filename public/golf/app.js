// golf/app.js — renders the Data Golf world rankings as a table.
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const statusEl = document.getElementById("status");
const wrap = document.getElementById("golf-wrap");

function relTime(iso) {
  if (!iso) return "";
  const d = new Date(iso); if (isNaN(d)) return "";
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 3600) return "updated " + Math.round(s / 60) + " min ago";
  if (s < 86400) return "updated " + Math.round(s / 3600) + " hr ago";
  return "updated " + Math.round(s / 86400) + " d ago";
}

function renderTable(data) {
  const rows = data.rankings || [];
  if (!rows.length) { statusEl.textContent = "No rankings available right now."; return; }
  document.getElementById("updated").textContent = relTime(data.updated);
  const html = [
    '<table class="golf-table"><thead><tr>',
    '<th class="r">#</th><th>Player</th><th>Country</th><th>Tour</th><th class="r">DG Skill</th><th class="r">OWGR</th>',
    '</tr></thead><tbody>',
    ...rows.map((p) => `<tr>
      <td class="r rank">${esc(p.rank)}</td>
      <td class="name">${esc(p.name)}${p.am ? ' <span class="am">(Am)</span>' : ""}</td>
      <td class="muted">${esc(p.country || "")}</td>
      <td class="muted">${esc(p.tour || "")}</td>
      <td class="r">${p.skill != null ? esc(p.skill) : "—"}</td>
      <td class="r muted">${p.owgr != null ? esc(p.owgr) : "—"}</td>
    </tr>`),
    "</tbody></table>",
  ].join("");
  wrap.innerHTML = html;
  statusEl.textContent = "";
}

(async function start() {
  statusEl.textContent = "⟳ Loading rankings…";
  let data;
  try { data = await (await fetch("/api/golf-rankings")).json(); }
  catch { statusEl.textContent = "Couldn't load rankings right now."; return; }
  if (data.needKey) {
    statusEl.textContent = "";
    wrap.innerHTML = `<div class="golf-need-key">
      <h2>⛳ Almost there</h2>
      <p>Data Golf's world rankings need a free-to-wire but <strong>paid Data Golf API key</strong> (a Scratch Plus membership at <a href="https://datagolf.com" rel="noreferrer noopener">datagolf.com</a>).</p>
      <p>Once you have the key, add it to the site's <code>DATAGOLF_KEY</code> environment variable in Render and this page fills in automatically — no code change needed.</p>
    </div>`;
    return;
  }
  if (data.error) { statusEl.textContent = data.error; return; }
  renderTable(data);
})();
