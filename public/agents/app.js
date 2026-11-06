
const API = "https://agents.getkickback.fun";
const hl = new URLSearchParams(location.search).get("r");
const short = a => a ? a.slice(0, 6) + "…" + a.slice(-4) : "";
const ago = t => { const s = Math.max(1, Math.floor(Date.now() / 1000 - t)); return s < 60 ? s + "s ago" : s < 3600 ? Math.floor(s / 60) + "m ago" : s < 86400 ? Math.floor(s / 3600) + "h ago" : Math.floor(s / 86400) + "d ago"; };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function count(el, to, fmt) { const from = +el.dataset.v || 0; el.dataset.v = to; const t0 = performance.now();
  const f = now => { const k = Math.min(1, (now - t0) / 900), v = from + (to - from) * (1 - Math.pow(1 - k, 3)); el.textContent = fmt(v); if (k < 1) requestAnimationFrame(f); }; requestAnimationFrame(f); }
async function load() {
  try {
    const s = await (await fetch(API + "/stats")).json();
    count(document.getElementById("s-scans"), s.scans, v => Math.round(v));
    count(document.getElementById("s-agents"), s.priorsAgents, v => Math.round(v));
    count(document.getElementById("s-payers"), s.payers, v => Math.round(v));
    count(document.getElementById("s-earned"), s.earnedUsdg, v => "$" + v.toFixed(2));
    if (s.latest?.length) document.getElementById("rcpts").innerHTML = s.latest.map(r => `
      <div class="r${r.id === hl ? " hl" : ""}" id="r-${esc(r.id)}">
        <span class="who">${r.agentId != null ? `<a href="https://priors.trade/agent?id=${+r.agentId}">agent #${+r.agentId}</a>` : esc(short(r.payer))}${r.score != null ? ` · score ${+r.score}` : ""}</span>
        <span class="what">scan paid ${ago(r.time)}${r.foundUsd != null ? ` · found $${(+r.foundUsd).toFixed(2)} in rewards` : ""}</span>
        <span class="amt">${r.tx ? `<a href="https://robin.etherscan.io/tx/${esc(r.tx)}" style="color:inherit">0.05 USDG ↗</a>` : "0.05 USDG"}</span>
      </div>`).join("");
    if (hl) document.getElementById("r-" + hl)?.scrollIntoView({ block: "center" });
  } catch (e) {}
}
load(); setInterval(load, 30000);
