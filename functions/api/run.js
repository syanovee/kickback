// POST /api/run {wallets}: starts a check. Returns a run token signed for exactly these wallets and this session.
// Every write about the result (log, saved result, link preview, card, rank) must carry it.
import { json } from '../_lib/cache.js';
import { bump, ipKey } from '../_lib/ratelimit.js';
import { makeRun } from '../_lib/sec.js';
import { partners, originOk } from '../_partners.js';
const isAddr = s => typeof s === 'string' && (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) || /^0x[0-9a-fA-F]{40}$/.test(s));
export async function onRequestPost(ctx) {
  let b; try { b = await ctx.request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const ws = Array.isArray(b?.wallets) ? b.wallets : [];
  if (!ws.length || ws.length > 10 || !ws.every(isAddr)) return json({ error: 'bad wallets' }, 400);
  const a = await bump(ctx, 'run|' + ctx.data.sid, [[21600, 120]]), c = await bump(ctx, 'runip|' + ipKey(ctx.request), [[3600, 1500]]);
  if (a.wait || c.wait) return json({ error: 'too many checks, try again soon' }, 429);
  // a scan inside a partner's site counts toward that partner's hourly limit, here where the scan starts
  if (b.partner) {
    const p = partners(ctx.env)[String(b.partner.key || '')];
    if (!p || !originOk(p, String(b.partner.origin || ''))) return json({ error: 'key check failed' }, 403);
    const limit = p.hour || 300, n = await bump(ctx, 'partner|' + (p.name || 'partner'), [[3600, limit]]);
    if (n.wait) return json({ error: `hourly limit reached (${limit}/h)` }, 429);
    try {   // the admin's per-partner counts
      await ctx.env.DB.exec('CREATE TABLE IF NOT EXISTS partner_hits (k TEXT, h INTEGER, n INTEGER, PRIMARY KEY (k, h))');
      await ctx.env.DB.prepare('INSERT INTO partner_hits (k, h, n) VALUES (?1, ?2, 1) ON CONFLICT (k, h) DO UPDATE SET n = n + 1').bind(p.name || 'partner', Math.floor(Date.now() / 3600000)).run();
    } catch {}
  }
  const r = await makeRun(ctx.env, ctx.data.sid, ws);
  return json({ t: r.t, run: r.run });
}
