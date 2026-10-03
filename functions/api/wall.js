// Public: cards pinned to the homepage, each with the real X post it was shared in. No wallets.
import { json } from '../_lib/cache.js';
export async function onRequestGet({ env }) {
  if (!env.DB) return json({ items: [] });
  let items = [];
  try { items = (await env.DB.prepare('SELECT w.id, w.tweet, w.author, w.posted, c.total FROM wall w JOIN cards c ON c.id = w.id ORDER BY COALESCE(w.posted, w.added) DESC LIMIT 24').all()).results || []; } catch {}
  return new Response(JSON.stringify({ items }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=120' } });
}
