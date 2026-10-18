import { json } from '../_lib/cache.js';
const isAddr = s => typeof s === 'string' && (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) || /^0x[0-9a-fA-F]{40}$/.test(s));
const str = (s, n) => typeof s === 'string' ? s.slice(0, n) : '';
const coinsJson = c => JSON.stringify((Array.isArray(c) ? c : []).slice(0, 15).map(x => ({ s: str(x?.s, 16), p: str(x?.p, 24), u: Math.round(Number(x?.u) * 100) / 100 || 0, ...(x?.f ? { f: str(x.f, 16) } : {}), ...(typeof x?.i === 'string' && /^https:\/\/[^\s"'<>]{8,280}$/.test(x.i) ? { i: x.i } : {}) })));
const num = (v, max = 1e9) => { const x = Number(v); return Number.isFinite(x) && x >= 0 && x <= max ? x : 0; };
const ready = {};
async function init(DB, T) {
  if (ready[T]) return;
  await DB.exec(`CREATE TABLE IF NOT EXISTS ${T} (run TEXT PRIMARY KEY, ts INTEGER, ts_final INTEGER, wallets TEXT, linked TEXT, total REAL, total_final REAL, plats TEXT, payouts INTEGER, chains INTEGER, secs INTEGER, secs_final INTEGER, handle TEXT, flags TEXT, mobile INTEGER, country TEXT, ref TEXT, copied INTEGER DEFAULT 0, posted INTEGER DEFAULT 0)`);
  try { await DB.exec(`ALTER TABLE ${T} ADD COLUMN coins TEXT`); } catch {}
  ready[T] = true;
}
function source(ref, search) {
  let out = '';
  try { if (ref) out = new URL(ref).hostname; } catch {}
  try { const q = new URLSearchParams(search || ''); const u = [...q].filter(([k, v]) => k.startsWith('utm_') || (k === 'from' && v === 'knots')).map(([k, v]) => (k === 'from' ? 'from=knots' : k.slice(4) + '=' + v.slice(0, 40))); if (u.length) out += (out ? ' ' : '') + u.join('&'); } catch {}
  return out.slice(0, 160);
}
export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: 'no db' }, 503);
  // the real site logs to scan_log; the test site (what partners try) logs to its own table, so stats stay clean
  const host = new URL(request.url).hostname, prod = /(^|\.)getkickback\.fun$/.test(host);
  if (!prod && !/(^|\.)kickback-test\.pages\.dev$/.test(host)) return json({ ok: true, skipped: 'not prod' });
  const T = prod ? 'scan_log' : 'scan_log_test';
  let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  if (b?.kind === 'tip') {
    if (!prod) return json({ ok: true, skipped: 'test' });
    const act = b.act === 'copy' ? 'copy' : b.act === 'open' ? 'open' : '';
    if (!act) return json({ error: 'bad act' }, 400);
    await env.DB.exec(`CREATE TABLE IF NOT EXISTS tip_log (ts INTEGER, act TEXT, src TEXT, mobile INTEGER, country TEXT)`);
    await env.DB.prepare(`INSERT INTO tip_log (ts, act, src, mobile, country) VALUES (?1, ?2, ?3, ?4, ?5)`)
      .bind(Math.floor(Date.now() / 1000), act, b.src === 'footer' ? 'footer' : act === 'open' ? 'pill' : '', b.mobile ? 1 : 0, str(request.cf?.country, 4)).run();
    return json({ ok: true });
  }
  // coin -> where its holder payouts come from, for the bag calculator. No wallet is stored with it.
  if ((b?.kind === 'first' || b?.kind === 'final') && Array.isArray(b.seeds) && b.seeds.length) {
    try {
      await env.DB.exec(`CREATE TABLE IF NOT EXISTS y_seed (chain TEXT, coin TEXT, platform TEXT, distributor TEXT, asset TEXT, sig TEXT, t INTEGER, seen INTEGER, n INTEGER DEFAULT 1, PRIMARY KEY (chain, coin, platform))`);
      const ok = (x, n) => typeof x === 'string' && x.length > 0 && x.length <= n && /^[A-Za-z0-9:._-]+$/.test(x);
      const now = Math.floor(Date.now() / 1000), st = [];
      for (const x of b.seeds.slice(0, 40)) {
        if (!ok(x?.c, 12) || !/^[A-Za-z .]{2,24}$/.test(x?.p || '') || !ok(x?.m, 60)) continue;
        st.push(env.DB.prepare(`INSERT INTO y_seed (chain, coin, platform, distributor, asset, sig, t, seen, n) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1)
          ON CONFLICT(chain, coin, platform) DO UPDATE SET distributor = COALESCE(excluded.distributor, distributor), asset = excluded.asset,
          sig = CASE WHEN excluded.t >= COALESCE(t, 0) AND excluded.sig IS NOT NULL THEN excluded.sig ELSE sig END, t = MAX(COALESCE(t, 0), excluded.t), seen = excluded.seen, n = n + 1`)
          .bind(x.c, x.m, x.p, ok(x.d, 60) ? x.d : null, ok(x.a, 60) ? x.a : '', ok(x.s, 100) ? x.s : null, Number(x.t) | 0, now));
      }
      if (st.length) await env.DB.batch(st);
    } catch {}
  }
  const run = b?.run;
  if (typeof run !== 'string' || !/^[A-Za-z0-9-]{8,40}$/.test(run)) return json({ error: 'bad run' }, 400);
  await init(env.DB, T);
  const now = Math.floor(Date.now() / 1000), handle = str(b.handle, 30).replace(/[^A-Za-z0-9_]/g, '');
  if (b.kind === 'first') {
    const wallets = (Array.isArray(b.wallets) ? b.wallets : []).filter(isAddr).slice(0, 10);
    if (!wallets.length) return json({ error: 'bad wallets' }, 400);
    const linked = (Array.isArray(b.linked) ? b.linked : []).filter(isAddr).slice(0, 10);
    await env.DB.prepare(`INSERT OR IGNORE INTO ${T} (run, ts, wallets, linked, total, plats, payouts, chains, secs, handle, flags, mobile, country, ref, coins)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`)
      .bind(run, now, wallets.join(' '), linked.join(' '), num(b.total, 5e6), str(JSON.stringify(b.plats || {}), 600), num(b.payouts, 1e6) | 0, num(b.chains, 20) | 0,
        num(b.secs, 1e5) | 0, handle, str(b.flags, 120), b.mobile ? 1 : 0, str(request.cf?.country, 4), source(str(b.ref, 300), str(b.search, 300)), coinsJson(b.coins)).run();
  } else if (b.kind === 'final') {
    await env.DB.prepare(`UPDATE ${T} SET ts_final=?2, total_final=?3, plats=?4, payouts=?5, secs_final=?6, flags=CASE WHEN ?7='' THEN flags ELSE ?7 END, coins=?8 WHERE run=?1`)
      .bind(run, now, num(b.total, 5e6), str(JSON.stringify(b.plats || {}), 600), num(b.payouts, 1e6) | 0, num(b.secs, 1e5) | 0, str(b.flags, 120), coinsJson(b.coins)).run();
  } else if (b.kind === 'copy' || b.kind === 'post') {
    const col = b.kind === 'copy' ? 'copied' : 'posted';
    const r = await env.DB.prepare(`UPDATE ${T} SET ${col}=${col}+1, handle=CASE WHEN ?2='' THEN handle ELSE ?2 END WHERE run=?1`).bind(run, handle).run();
    if (!r?.meta?.changes) {
      const wallets = (Array.isArray(b.wallets) ? b.wallets : []).filter(isAddr).slice(0, 10);
      await env.DB.prepare(`INSERT OR IGNORE INTO ${T} (run, ts, wallets, linked, total, plats, payouts, chains, secs, handle, flags, mobile, country, ref, ${col})
        VALUES (?1, ?2, ?3, '', 0, '{}', 0, 0, 0, ?4, 'event-only', 0, ?5, '', 1)`).bind(run, now, wallets.join(' '), handle, str(request.cf?.country, 4)).run();
    }
  } else return json({ error: 'bad kind' }, 400);
  return json({ ok: true });
}
