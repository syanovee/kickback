// Request budgets, so a script can't burn our provider allowances or fill the database through the api.
// Each worker counts in memory and adds its count to a shared total in D1 every ~5 seconds (one small write),
// so the total is right across all workers and data centers, only a moment late.
// Normal scans stay far below these numbers (measured on the heaviest wallets we have).
export const IP_WINDOWS = [[60, 1200], [3600, 8000], [86400, 30000]];   // [seconds, max units per address]
const FLUSH_MS = 5000;
const mem = new Map();   // key -> {pend, total, last, busy}
let ready = false;
export const ipKey = request => {
  const ip = request.headers.get('cf-connecting-ip') || '';
  return ip.includes(':') ? ip.split(':').slice(0, 4).join(':') : ip;   // IPv6: one /64 counts as one address
};
const siteOf = request => new URL(request.url).hostname.endsWith('kickback-test.pages.dev') ? 't' : 'p';   // test and live counted apart (same database)

// count `weight` units for `who` in each window; returns {wait, n}: wait = 0 when the request may go on, else seconds to wait
export async function bump(ctx, who, windows, weight = 1) {
  const { request, env } = ctx;
  if (!who || !env.DB) return { wait: 0, n: 0 };
  const nowMs = Date.now(), now = Math.floor(nowMs / 1000);
  if (mem.size > 20000) mem.clear();
  const site = siteOf(request);
  const rows = windows.map(([sec, max]) => {
    const slot = Math.floor(now / sec), k = site + '|' + sec + '|' + who + '|' + slot;
    let e = mem.get(k); if (!e) mem.set(k, e = { pend: 0, total: 0, last: 0 });
    e.pend += weight;
    return { sec, max, slot, k, e };
  });
  // one flush at a time per key in this worker: requests that arrive meanwhile keep counting locally
  const due = !rows[0].e.busy && rows.some(r => nowMs - r.e.last > FLUSH_MS || r.e.total + r.e.pend > r.max * 0.8);
  if (due) {
    const take = rows.map(r => r.e.pend);
    rows.forEach(r => { r.e.pend = 0; r.e.busy = true; });
    const bg = typeof ctx.waitUntil === 'function';
    const flush = (async () => {
      let done = false;
      try {
        if (!ready) { await env.DB.exec('CREATE TABLE IF NOT EXISTS rl (k TEXT PRIMARY KEY, n INTEGER NOT NULL, exp INTEGER NOT NULL)'); ready = true; }
        const st = rows.map((r, i) => env.DB.prepare('INSERT INTO rl (k, n, exp) VALUES (?1, ?2, ?3) ON CONFLICT(k) DO UPDATE SET n = n + ?2 RETURNING n')
          .bind(r.k, take[i], (r.slot + 1) * r.sec + 60));
        if (Math.random() < 0.01) st.push(env.DB.prepare('DELETE FROM rl WHERE exp < ?1').bind(now));
        const out = await env.DB.batch(st);
        rows.forEach((r, i) => { const v = out[i]?.results?.[0]?.n; if (v) r.e.total = v; r.e.last = Date.now(); });
        done = true;
      } catch {}   // if counting fails, let requests through: a broken counter must never break scans
      rows.forEach((r, i) => { r.e.busy = false; if (!done) { r.e.pend += take[i]; if (bg) r.e.total -= take[i]; } });
    })();
    // in the background when the platform allows it: the request doesn't wait for the database round trip
    if (bg) { rows.forEach((r, i) => { r.e.total += take[i]; }); ctx.waitUntil(flush.then(() => {})); }
    else await flush;
  }
  let wait = 0;
  for (const r of rows) if (r.e.total + r.e.pend > r.max) wait = Math.max(wait, (r.slot + 1) * r.sec - now);
  return { wait, n: rows[0].e.total + rows[0].e.pend };
}
// the per-address budget every api call counts against
export const overLimit = (ctx, weight = 1) => bump(ctx, ipKey(ctx.request), IP_WINDOWS, weight);
