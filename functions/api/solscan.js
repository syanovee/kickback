import { getCached, putCached, json } from '../_lib/cache.js';
import { TX_OPTS, txKey } from '../_lib/soltx.js';
import { solCompact } from '../_lib/compact.js';
const DAY = 86400, TAG = 'alchemy:solana-mainnet', SOL_F = { status: 'succeeded', tokenAccounts: 'balanceChanged' };
const isAddr = s => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
const isSig = s => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(s);

export async function onRequestPost(ctx) {
  const { env } = ctx;
  let b; try { b = await ctx.request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const W = b?.w, sigs = b?.sigs;
  if (!isAddr(W) || !Array.isArray(sigs) || !sigs.length || sigs.length > 100 || !sigs.every(isSig)) return json({ error: 'bad request' }, 400);
  const want = new Set(sigs), out = {}, now = Date.now() / 1000, puts = [];
  const keep = tx => {
    const sig = tx?.transaction?.signatures?.[0]; if (!sig) return;
    if (tx.blockTime && now - tx.blockTime > 120) puts.push(putCached(ctx, TAG, txKey(sig), 30 * DAY, JSON.stringify({ jsonrpc: '2.0', id: 1, result: tx })));
    if (want.has(sig)) { try { out[sig] = solCompact(tx, W); } catch {} }
  };
  const miss = [];
  await Promise.all(sigs.map(async s => { const hit = await getCached(ctx, TAG, txKey(s)); if (hit) { try { const r = JSON.parse(hit).result; if (r) { out[s] = solCompact(r, W); return; } } catch {} } miss.push(s); }));
  if (!miss.length) return json({ txs: out, cached: sigs.length, hit: sigs.length });

  if (b.src === 'h' && miss.length >= 8 && Number.isInteger(b.lo) && Number.isInteger(b.hi)) {
    let tk = null, pages = 0;
    do {
      const o = { transactionDetails: 'full', limit: 100, encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, filters: { ...SOL_F, slot: { gte: b.lo, lte: b.hi } } };
      if (tk) o.paginationToken = tk;
      let j = null;
      for (let a = 0; a < 5 && !j; a++) {
        if (a) await new Promise(r => setTimeout(r, 250 * a + Math.random() * 250));
        try { const r = await fetch('https://mainnet.helius-rpc.com/?api-key=' + env.HELIUS_KEY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransactionsForAddress', params: [W, o] }) });
          const t = r.ok ? await r.json() : null; if (t?.result) j = t; } catch {}
      }
      for (const tx of j?.result?.data || []) keep(tx);
      tk = j?.result?.paginationToken; pages++;
    } while (tk && pages < 5);
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
  ctx.waitUntil(Promise.all(puts));
  return json({ txs: out, hit: sigs.length - miss.length });
}
