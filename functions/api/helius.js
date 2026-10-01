import { cached, okRpc, json, putCached } from '../_lib/cache.js';
import { TX_OPTS, txKey } from '../_lib/soltx.js';
const ALLOWED = new Set(['getTokenAccountsByOwner','getTransactionsForAddress','getAssetBatch','getTransaction',
  'getSignaturesForAddress','getAccountInfo','getMultipleAccounts','getBalance']);
const DAY = 86400;

export async function onRequestPost(ctx) {
  const { request, env } = ctx;
  let body;
  try { body = await request.json(); } catch { return json({ error: { message: 'bad json' } }, 400); }
  if (Array.isArray(body) || !ALLOWED.has(body?.method)) return json({ error: { message: 'method not allowed' } }, 403);
  const p = body.params, m = body.method;
  let ttl = 0;
  if (m === 'getTransactionsForAddress' && p?.[1]?.sortOrder === 'asc' && p?.[1]?.limit === 1) ttl = 30 * DAY;
  else if (m === 'getTransaction') ttl = 30 * DAY;
  else if (m === 'getAssetBatch') ttl = DAY;
  else if (m === 'getTransactionsForAddress' && p?.[1]?.transactionDetails === 'signatures' && p?.[1]?.filters?.blockTime?.lt
           && p[1].filters.blockTime.lt < Date.now() / 1000 - 3600) ttl = 7 * DAY;
  const upstream = async () => {
    const r = await fetch('https://mainnet.helius-rpc.com/?api-key=' + env.HELIUS_KEY, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, id: 1 }) });
    return { status: r.status, text: await r.text() };
  };
  const res = await cached(ctx, 'helius', JSON.stringify([m, p]), ttl, upstream, okRpc);
  if (m === 'getTransactionsForAddress' && p?.[1]?.transactionDetails === 'full' && res.status === 200) {
    try {
      const j = await res.clone().json(), now = Date.now() / 1000;
      for (const tx of j?.result?.data || []) {
        const sig = tx?.transaction?.signatures?.[0];
        if (sig && tx.blockTime && now - tx.blockTime > 120) await putCached(ctx, 'alchemy:solana-mainnet', txKey(sig), 30 * DAY, JSON.stringify({ jsonrpc: '2.0', id: 1, result: tx }));
      }
    } catch {}
  }
  return res;
}
