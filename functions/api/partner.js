// Checks a partner key + the page origin it is used from, and counts scans per hour (limit per key).
import { json } from '../_lib/cache.js';
import { partners, originOk } from '../_partners.js';
export async function onRequestGet({ request, env }) {
  const u = new URL(request.url), key = u.searchParams.get('key') || '', origin = u.searchParams.get('origin') || '';
  const p = partners(env)[key];
  if (!p) return json({ ok: false, error: 'unknown key' }, 403);
  if (!originOk(p, origin)) return json({ ok: false, error: 'this key is not allowed on ' + origin }, 403);
  const name = p.name || 'partner', hour = Math.floor(Date.now() / 3600000), limit = p.hour || 300;
  if (env.DB) try {
    await env.DB.exec('CREATE TABLE IF NOT EXISTS partner_hits (k TEXT, h INTEGER, n INTEGER, PRIMARY KEY (k, h))');
    const r = await env.DB.prepare('INSERT INTO partner_hits (k, h, n) VALUES (?, ?, 1) ON CONFLICT (k, h) DO UPDATE SET n = n + 1 RETURNING n').bind(name, hour).first();
    if ((r?.n || 0) > limit) return json({ ok: false, error: `hourly limit reached (${limit}/h)` }, 429);
  } catch {}
  return json({ ok: true, name });
}
