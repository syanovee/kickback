import { getCached, putCached, json } from '../_lib/cache.js';
import { TX_OPTS, txKey } from '../_lib/soltx.js';
import { solCompact } from '../_lib/compact.js';
import { memPut } from '../_lib/solmem.js';
import { solRpc } from '../_lib/rpc.js';
import { charge } from '../_lib/budget.js';
const DAY = 86400, TAG = 'alchemy:solana-mainnet', SOL_F = { status: 'succeeded', tokenAccounts: 'balanceChanged' };
const isAddr = s => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
// a slot range covers one slice of a wallet's own history; about seven months at most
const MAX_SLOTS = 50_000_000;
const isSig = s => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(s);

export async function onRequestPost(ctx) {
  const { env } = ctx;
  let b; try { b = await ctx.request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const W = b?.w, sigs = b?.sigs;
  if (!isAddr(W) || !Array.isArray(sigs) || !sigs.length || sigs.length > 100 || !sigs.every(isSig)) return json({ error: 'bad request' }, 400);
  const want = new Set(sigs), out = {}, now = Date.now() / 1000, puts = [];
  const mem = [];
  const keep = tx => {
    const sig = tx?.transaction?.signatures?.[0]; if (!sig) return;
    const final = tx.blockTime && now - tx.blockTime > 120;
    if (final) puts.push(putCached(ctx, TAG, txKey(sig), 30 * DAY, JSON.stringify({ jsonrpc: '2.0', id: 1, result: tx })));
    let c = null; try { c = solCompact(tx, W); } catch {}
    if (c && want.has(sig)) out[sig] = c;
    if (c && final) mem.push(c);
  };
  const miss = [];
  await Promise.all(sigs.map(async s => { const hit = await getCached(ctx, TAG, txKey(s)); if (hit) { try { const r = JSON.parse(hit).result; if (r) { out[s] = solCompact(r, W); return; } } catch {} } miss.push(s); }));
  if (!miss.length) return json({ txs: out, cached: sigs.length, hit: sigs.length });
  // signatures are only checked for shape, so made-up ones always miss: every miss is an upstream call,
  // charged to the session (and a tenth of a unit each to the address budget) before anything is fetched
  const viaRange = b.src === 'h' && miss.length >= 8 && Number.isInteger(b.lo) && Number.isInteger(b.hi) && b.lo >= 0 && b.hi >= b.lo && b.hi - b.lo <= MAX_SLOTS;
  const maxPages = Math.min(3, Math.ceil(miss.length / 100) + 1);
  const over = await charge(ctx, viaRange ? maxPages : miss.length, Math.ceil(miss.length / 10));
  if (over) return over;

  if (viaRange) {
    let tk = null, pages = 0;
    do {
      const o = { transactionDetails: 'full', limit: 100, encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, filters: { ...SOL_F, slot: { gte: b.lo, lte: b.hi } } };
      if (tk) o.paginationToken = tk;
      // one try: the router already moves to another provider or waits out a short limit
      let j = null;
      try { const r = await solRpc(env, 'getTransactionsForAddress', [W, o]); const t = r.status === 200 ? JSON.parse(r.text) : null; if (t?.result) j = t; } catch {}
      for (const tx of j?.result?.data || []) keep(tx);
      tk = j?.result?.paginationToken; pages++;
    } while (tk && pages < maxPages);
  } else {
    const url = `https://solana-mainnet.g.alchemy.com/v2/${env.ALCHEMY_KEY}`;
    const chunks = []; for (let i = 0; i < miss.length; i += 50) chunks.push(miss.slice(i, i + 50));
    await Promise.all(chunks.map(async c => {
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c.map((s, i) => ({ jsonrpc: '2.0', id: i, method: 'getTransaction', params: [s, TX_OPTS] }))) });
        const arr = r.ok ? await r.json() : null;
        for (const a of Array.isArray(arr) ? arr : []) if (a?.result) keep(a.result);
      } catch {}
    }));
  }
  ctx.waitUntil(Promise.all([...puts, memPut(env, W, mem)]));
  return json({ txs: out, hit: sigs.length - miss.length });
}
