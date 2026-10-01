import { cached, json } from '../_lib/cache.js';
const KEEP = ['user', 'limit', 'continuation', 'startTimestamp', 'endTimestamp'];
export async function onRequestGet({ request, env }) {
  if (!env.RELAY_KEY) return json({ error: 'no key' }, 503);
  const q = new URL(request.url).searchParams, out = new URLSearchParams();
  for (const k of KEEP) if (q.has(k)) out.set(k, q.get(k));
  if (!out.get('user')) return json({ error: 'user required' }, 400);
  const end = +out.get('endTimestamp') || 0, ttl = end && end < Date.now() / 1000 - 3600 ? 7 * 86400 : 0;
  const ctx = arguments[0];
  return cached(ctx, 'relay3', out.toString(), ttl, async () => {
    const r = await fetch('https://api.relay.link/requests/v3?' + out, { headers: { 'x-api-key': env.RELAY_KEY } });
    return { status: r.status, text: await r.text() };
  }, t => t.includes('"requests"'));
}
