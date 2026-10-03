// X avatar by handle, cached at the edge: fxtwitter first, unavatar as a fallback
export async function onRequestGet(ctx) {
  const h = (new URL(ctx.request.url).searchParams.get('h') || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 15);
  if (!h) return new Response('bad handle', { status: 400 });
  const key = new Request('https://kb.cache/pfp/' + h.toLowerCase());
  const hit = await caches.default.match(key); if (hit) return hit;
  let img = null;
  try {
    const j = await fetch('https://api.fxtwitter.com/' + h, { headers: { 'User-Agent': 'kickback' } }).then(r => r.ok ? r.json() : null);
    const u = j?.user?.avatar_url; if (u) { const r = await fetch(u.replace('_normal', '_400x400')); if (r.ok) img = r; }
  } catch {}
  if (!img) { try { const r = await fetch('https://unavatar.io/x/' + h + '?fallback=false'); if (r.ok) img = r; } catch {} }
  if (!img) return new Response('not found', { status: 404, headers: { 'Cache-Control': 'public, max-age=600' } });
  const res = new Response(img.body, { headers: { 'Content-Type': img.headers.get('Content-Type') || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' } });
  ctx.waitUntil(caches.default.put(key, res.clone()));
  return res;
}
