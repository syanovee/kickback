const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = v => '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export async function onRequestGet({ params, env, request }) {
  const id = String(params.id || '');
  const origin = new URL(request.url).origin;
  const row = (env.DB && /^[A-Za-z0-9]{6,12}$/.test(id)) ? await env.DB.prepare('SELECT w, total, handle, kind FROM cards WHERE id = ?1').bind(id).first().catch(() => env.DB.prepare('SELECT w, total, handle FROM cards WHERE id = ?1').bind(id).first().catch(() => null)) : null;
  if (!row) return Response.redirect(origin + '/', 302);
  const who = row.handle ? '@' + row.handle : 'This wallet';
  const kn = row.kind === 'knots';
  const title = kn ? `${who} earned ${usd(row.total)} in STONK from holding KNOTS` : `${who} got ${usd(row.total)} in holder rewards`;
  const desc = kn ? 'See how much STONK you earned from holding KNOTS, every payout with its tx.' : 'Your bags paid you too. Paste any wallet on Kickback and see every holder reward, each with its transaction.';
  const img = `${origin}/c/${id}.jpg`, to = `${origin}/${kn ? 'knots/' : ''}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Kickback</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Kickback">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(origin + '/s/' + id)}"><meta property="og:image" content="${esc(img)}">
<meta property="og:image:width" content="2400"><meta property="og:image:height" content="1350"><meta property="og:image:type" content="image/jpeg"><meta property="og:image:alt" content="${esc(title)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(img)}"><meta name="twitter:image:alt" content="${esc(title)}">
<style>body{background:#141210;color:#fff6ea;font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0}a{color:#ff8a3d}</style>
</head><body><a href="${esc(to)}">Check your wallet on Kickback →</a><script>location.replace(${JSON.stringify(to)})</script></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
}
