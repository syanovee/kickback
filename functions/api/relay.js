import { cached, json } from '../_lib/cache.js';
import { charge } from '../_lib/budget.js';
const KEEP = ['user', 'limit', 'continuation', 'startTimestamp', 'endTimestamp'];
export async function onRequestGet({ request, env }) {
  if (!env.RELAY_KEY) return json({ error: 'no key' }, 503);
  const q = new URL(request.url).searchParams, out = new URLSearchParams();
  for (const k of KEEP) if (q.has(k)) out.set(k, q.get(k));
  // only the shapes the page sends: one wallet, a small page, plain numbers
  const user = out.get('user') || '';
  if (!/^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(user)) return json({ error: 'user required' }, 400);
  if (out.has('limit') && !(/^\d{1,3}$/.test(out.get('limit')) && +out.get('limit') >= 1 && +out.get('limit') <= 100)) return json({ error: 'bad limit' }, 400);
  for (const k of ['startTimestamp', 'endTimestamp']) if (out.has(k) && !/^\d{1,10}$/.test(out.get(k))) return json({ error: 'bad ' + k }, 400);
  if (out.has('continuation') && !/^[\x21-\x7e]{1,300}$/.test(out.get('continuation'))) return json({ error: 'bad continuation' }, 400);
  const end = +out.get('endTimestamp') || 0, ttl = end && end < Date.now() / 1000 - 3600 ? 7 * 86400 : 0;
  const ctx = arguments[0];
  // v3 started returning an empty list for Solana users (Oct 2026), v2 still works: try v3, fall back to v2
  return cached(ctx, 'relay4', out.toString(), ttl, async () => {
    if (await charge(ctx, 2)) return { status: 429, text: '{"error":"budget"}' };
    const h = { headers: { 'x-api-key': env.RELAY_KEY } };
    const r = await fetch('https://api.relay.link/requests/v3?' + out, h);
    const text = await r.text();
    let empty = false;
    try { const j = JSON.parse(text); empty = r.ok && Array.isArray(j.requests) && j.requests.length === 0 && !j.continuation; } catch {}
    if (r.ok && !empty) return { status: r.status, text };
    const out2 = new URLSearchParams(out);
    if (+out2.get('limit') > 50) out2.set('limit', '50');   // v2 caps limit at 50
    const r2 = await fetch('https://api.relay.link/requests/v2?' + out2, h);
    return { status: r2.status, text: await r2.text() };
  }, t => t.includes('"requests"'));
}
