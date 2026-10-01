export async function onRequestGet({ params, env }) {
  const id = String(params.id || '').replace(/\.jpg$/, '');
  if (!env.DB || !/^[A-Za-z0-9]{6,12}$/.test(id)) return new Response('not found', { status: 404 });
  const row = await env.DB.prepare('SELECT img FROM cards WHERE id = ?1').bind(id).first().catch(() => null);
  if (!row?.img) return new Response('not found', { status: 404 });
  return new Response(new Uint8Array(row.img), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' } });
}
