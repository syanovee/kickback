// getkickback.fun/w/<wallet> : a shareable link that opens Kickback and scans that wallet right away.
// Link previews (X, Telegram, Discord) get the wallet's own card and total; people get sent straight to the scan.
const ok = s => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) || /^0x[0-9a-fA-F]{40}$/.test(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = v => '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export async function onRequestGet({ params, request, env }) {
  const a = String(params.addr || ''), origin = new URL(request.url).origin;
  if (!ok(a)) return Response.redirect(origin + '/', 302);
  const w = a.startsWith('0x') ? a.toLowerCase() : a, to = origin + '/?wallet=' + encodeURIComponent(a) + '&go';
  const prod = /(^|\.)getkickback\.fun$/.test(new URL(request.url).hostname);
  let card = null, total = 0;
  if (env.DB) {
    card = await env.DB.prepare(`SELECT ts, total FROM ${prod ? 'wcard' : 'wcard_test'} WHERE w = ?1`).bind(w).first().catch(() => null);
    if (card) total = card.total;
    else {
      const r = await env.DB.prepare(`SELECT COALESCE(total_final,total) AS t FROM ${prod ? 'scan_log' : 'scan_log_test'} WHERE wallets = ?1 AND COALESCE(total_final,total) > 0
        AND COALESCE(flags,'') NOT LIKE '%tease%' AND COALESCE(flags,'') NOT LIKE '%studio%' AND COALESCE(flags,'') NOT LIKE '%embed%' AND COALESCE(flags,'') NOT LIKE '%event-only%'
        ORDER BY ts DESC LIMIT 1`).bind(w).first().catch(() => null);
      total = r?.t || 0;
    }
  }
  const short = a.slice(0, 4) + '…' + a.slice(-4);
  const title = total >= 1 ? `${short} got ${usd(total)} in holder rewards` : 'Kickback · your bags paid you';
  const desc = 'Your bags paid you too. Paste any wallet on Kickback and see every holder reward, each with its transaction.' + (total >= 1 ? ' Total from the last check of this wallet.' : '');
  const img = card ? `${origin}/api/wcard?w=${encodeURIComponent(w)}&v=${card.ts}` : `${origin}/og.png`;
  const [iw, ih] = card ? [1200, 675] : [1200, 630];
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Kickback</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Kickback">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(origin + '/w/' + a)}"><meta property="og:image" content="${esc(img)}">
<meta property="og:image:width" content="${iw}"><meta property="og:image:height" content="${ih}"><meta property="og:image:alt" content="${esc(title)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(img)}"><meta name="twitter:image:alt" content="${esc(title)}">
<meta http-equiv="refresh" content="0;url=${esc(to)}">
<style>body{background:#141210;color:#fff6ea;font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0}a{color:#ff8a3d}</style>
</head><body><a href="${esc(to)}">Open on Kickback →</a></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
}
