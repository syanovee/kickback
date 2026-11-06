// Checks a partner key + the page origin it is used from. Read-only: the hourly scan limit is counted where a scan
// actually starts (/api/run, which needs a session), so direct calls here can't use up a partner's hour.
import { json } from '../_lib/cache.js';
import { partners, originOk } from '../_partners.js';
export async function onRequestGet({ request, env }) {
  const u = new URL(request.url), key = u.searchParams.get('key') || '', origin = u.searchParams.get('origin') || '';
  const p = partners(env)[key];
  if (!p) return json({ ok: false, error: 'unknown key' }, 403);
  if (!originOk(p, origin)) return json({ ok: false, error: 'this key is not allowed on ' + origin }, 403);
  return json({ ok: true, name: p.name || 'partner' });
}
