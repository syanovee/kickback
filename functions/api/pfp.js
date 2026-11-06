// X avatar by handle, cached at the edge: fxtwitter first, unavatar as a fallback.
// Only pictures from X's image host or unavatar, only image types, served so a browser can never run them as a page.
const IMG = /^image\/(jpeg|png|webp|gif)$/i, MAX = 2_000_000;
const okHost = u => { try { const h = new URL(u); return h.protocol === 'https:' && /^(pbs\.twimg\.com|abs\.twimg\.com|unavatar\.io)$/.test(h.hostname); } catch { return false; } };
async function grab(u) {
  if (!okHost(u)) return null;
  const r = await fetch(u);
  if (r.url && !okHost(r.url)) return null;   // followed a redirect somewhere else
  const ct = (r.headers.get('Content-Type') || '').split(';')[0].trim();
  if (!r.ok || !IMG.test(ct) || +(r.headers.get('Content-Length') || 0) > MAX) return null;
  const buf = await r.arrayBuffer(); if (buf.byteLength > MAX) return null;
  return { buf, ct };
}
export async function onRequestGet(ctx) {
  const h = (new URL(ctx.request.url).searchParams.get('h') || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 15);
  if (!h) return new Response('bad handle', { status: 400 });
  const key = new Request('https://kb.cache/pfp/' + h.toLowerCase());
  const hit = await caches.default.match(key); if (hit) return hit;
  let img = null;
  try {
    const j = await fetch('https://api.fxtwitter.com/' + h, { headers: { 'User-Agent': 'kickback' } }).then(r => r.ok ? r.json() : null);
    const u = j?.user?.avatar_url; if (typeof u === 'string') img = await grab(u.replace('_normal', '_400x400'));
  } catch {}
  if (!img) { try { img = await grab('https://unavatar.io/x/' + h + '?fallback=false'); } catch {} }
  if (!img) return new Response('not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });   // a miss is often just a slow lookup, so let the next try go through
  const res = new Response(img.buf, { headers: { 'Content-Type': img.ct, 'Cache-Control': 'public, max-age=86400',
    'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff' } });
  ctx.waitUntil(caches.default.put(key, res.clone()));
  return res;
}
