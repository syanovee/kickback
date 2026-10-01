import { json } from '../_lib/cache.js';
const isAddr = s => typeof s === 'string' && (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) || /^0x[0-9a-fA-F]{40}$/.test(s));
const str = (s, n) => typeof s === 'string' ? s.slice(0, n) : '';
const coinsJson = c => JSON.stringify((Array.isArray(c) ? c : []).slice(0, 15).map(x => ({ s: str(x?.s, 16), p: str(x?.p, 24), u: Math.round(Number(x?.u) * 100) / 100 || 0 })));
const num = (v, max = 1e9) => { const x = Number(v); return Number.isFinite(x) && x >= 0 && x <= max ? x : 0; };
let ready = false;
async function init(DB) {
  if (ready) return;
  await DB.exec(`CREATE TABLE IF NOT EXISTS scan_log (run TEXT PRIMARY KEY, ts INTEGER, ts_final INTEGER, wallets TEXT, linked TEXT, total REAL, total_final REAL, plats TEXT, payouts INTEGER, chains INTEGER, secs INTEGER, secs_final INTEGER, handle TEXT, flags TEXT, mobile INTEGER, country TEXT, ref TEXT, copied INTEGER DEFAULT 0, posted INTEGER DEFAULT 0)`);
  try { await DB.exec(`ALTER TABLE scan_log ADD COLUMN coins TEXT`); } catch {}
  ready = true;
}
function source(ref, search) {
  let out = '';
  try { if (ref) out = new URL(ref).hostname; } catch {}
  try { const q = new URLSearchParams(search || ''); const u = [...q].filter(([k]) => k.startsWith('utm_')).map(([k, v]) => k.slice(4) + '=' + v.slice(0, 40)); if (u.length) out += (out ? ' ' : '') + u.join('&'); } catch {}
  return out.slice(0, 160);
}
export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: 'no db' }, 503);
  if (!/(^|\.)getkickback\.fun$/.test(new URL(request.url).hostname)) return json({ ok: true, skipped: 'not prod' });
  let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  if (b?.kind === 'tip') {
    const act = b.act === 'copy' ? 'copy' : b.act === 'open' ? 'open' : '';
    if (!act) return json({ error: 'bad act' }, 400);
    await env.DB.exec(`CREATE TABLE IF NOT EXISTS tip_log (ts INTEGER, act TEXT, src TEXT, mobile INTEGER, country TEXT)`);
    await env.DB.prepare(`INSERT INTO tip_log (ts, act, src, mobile, country) VALUES (?1, ?2, ?3, ?4, ?5)`)
      .bind(Math.floor(Date.now() / 1000), act, b.src === 'footer' ? 'footer' : act === 'open' ? 'pill' : '', b.mobile ? 1 : 0, str(request.cf?.country, 4)).run();
    return json({ ok: true });
  }
  const run = b?.run;
  if (typeof run !== 'string' || !/^[A-Za-z0-9-]{8,40}$/.test(run)) return json({ error: 'bad run' }, 400);
  await init(env.DB);
  const now = Math.floor(Date.now() / 1000), handle = str(b.handle, 30).replace(/[^A-Za-z0-9_]/g, '');
  if (b.kind === 'first') {
    const wallets = (Array.isArray(b.wallets) ? b.wallets : []).filter(isAddr).slice(0, 10);
    if (!wallets.length) return json({ error: 'bad wallets' }, 400);
    const linked = (Array.isArray(b.linked) ? b.linked : []).filter(isAddr).slice(0, 10);
    await env.DB.prepare(`INSERT OR IGNORE INTO scan_log (run, ts, wallets, linked, total, plats, payouts, chains, secs, handle, flags, mobile, country, ref, coins)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`)
      .bind(run, now, wallets.join(' '), linked.join(' '), num(b.total, 5e6), str(JSON.stringify(b.plats || {}), 600), num(b.payouts, 1e6) | 0, num(b.chains, 20) | 0,
        num(b.secs, 1e5) | 0, handle, str(b.flags, 120), b.mobile ? 1 : 0, str(request.cf?.country, 4), source(str(b.ref, 300), str(b.search, 300)), coinsJson(b.coins)).run();
  } else if (b.kind === 'final') {
    await env.DB.prepare(`UPDATE scan_log SET ts_final=?2, total_final=?3, plats=?4, payouts=?5, secs_final=?6, flags=CASE WHEN ?7='' THEN flags ELSE ?7 END, coins=?8 WHERE run=?1`)
      .bind(run, now, num(b.total, 5e6), str(JSON.stringify(b.plats || {}), 600), num(b.payouts, 1e6) | 0, num(b.secs, 1e5) | 0, str(b.flags, 120), coinsJson(b.coins)).run();
  } else if (b.kind === 'copy' || b.kind === 'post') {
    const col = b.kind === 'copy' ? 'copied' : 'posted';
    const r = await env.DB.prepare(`UPDATE scan_log SET ${col}=${col}+1, handle=CASE WHEN ?2='' THEN handle ELSE ?2 END WHERE run=?1`).bind(run, handle).run();
    if (!r?.meta?.changes) {
      const wallets = (Array.isArray(b.wallets) ? b.wallets : []).filter(isAddr).slice(0, 10);
      await env.DB.prepare(`INSERT OR IGNORE INTO scan_log (run, ts, wallets, linked, total, plats, payouts, chains, secs, handle, flags, mobile, country, ref, ${col})
        VALUES (?1, ?2, ?3, '', 0, '{}', 0, 0, 0, ?4, 'event-only', 0, ?5, '', 1)`).bind(run, now, wallets.join(' '), handle, str(request.cf?.country, 4)).run();
    }
  } else return json({ error: 'bad kind' }, 400);
  return json({ ok: true });
}
