// How does a pump.fun Holder Rewards coin pay? node tools/pump-check.mjs <CA>
// Walks the coin's recent txs, takes every DistributeFeeToHolders, and sums who lost and who got what.
import fs from 'node:fs';
const S = JSON.parse(fs.readFileSync(new URL('../secrets.json', import.meta.url)));
const H = 'https://mainnet.helius-rpc.com/?api-key=' + S.HELIUS_KEY;
const rpc = async (m, p) => { for (let i = 0; i < 5; i++) { try { const r = await fetch(H, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) }); const j = await r.json(); if (!j.error) return j.result; } catch {} await new Promise(r => setTimeout(r, 800 * (i + 1))); } return null; };
const coin = process.argv[2], pages = +process.argv[3] || 40;
const short = a => a.slice(0, 6);
const flows = {}, recv = new Map(), losers = {}; let dist = 0, seen = 0, first = 0, last = 0, tk;
for (let p = 0; p < pages; p++) {
  const o = { transactionDetails: 'full', encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, limit: 100, sortOrder: 'desc' }; if (tk) o.paginationToken = tk;
  const r = await rpc('getTransactionsForAddress', [coin, o]);
  for (const t of r?.data || []) {
    seen++;
    if (!(t.meta?.logMessages || []).some(l => l.includes('DistributeFeeToHolders'))) continue;
    dist++; last = last || t.blockTime; first = t.blockTime;
    const keys = t.transaction.message.accountKeys.map(k => k.pubkey), signer = keys[0];
    const ch = [];
    keys.forEach((k, i) => { const d = t.meta.postBalances[i] - t.meta.preBalances[i] + (i === 0 ? t.meta.fee : 0); if (d) ch.push({ who: k, asset: 'SOL', d: BigInt(d) }); });
    for (const b of t.meta.postTokenBalances || []) { const q = (t.meta.preTokenBalances || []).find(x => x.accountIndex === b.accountIndex); const d = BigInt(b.uiTokenAmount.amount) - BigInt(q?.uiTokenAmount.amount || '0'); if (d) ch.push({ who: b.owner, asset: b.mint === coin ? 'COIN' : short(b.mint), d }); }
    for (const c of ch) {
      if (c.d < 0n) losers[c.who + ' ' + c.asset] = (losers[c.who + ' ' + c.asset] || 0) + 1;
      else { const k = (c.who === signer ? 'SIGNER ' : '') + c.asset; flows[k] = (flows[k] || 0) + 1; if (c.who !== signer) { const x = recv.get(c.who) || { n: 0, sol: 0n, asset: c.asset, amt: 0n }; x.n++; x.amt += c.d; recv.set(c.who, x); } }
    }
  }
  tk = r?.paginationToken; if (!tk) break; process.stdout.write('.');
}
console.log(`\ntxs read ${seen}, distributions ${dist}, from ${new Date(first * 1000).toISOString()} to ${new Date(last * 1000).toISOString()}`);
console.log('who paid (count):', Object.entries(losers).sort((a, b) => b[1] - a[1]).slice(0, 8));
console.log('what was received (count):', flows);
console.log('distinct receivers (not signer):', recv.size);
const big = (await rpc('getTokenLargestAccounts', [coin]))?.value || [];
const own = (await rpc('getMultipleAccounts', [big.map(b => b.address), { encoding: 'jsonParsed' }]))?.value?.map(a => a?.data?.parsed?.info?.owner) || [];
const top = new Set(own);
for (const [w, x] of [...recv].sort((a, b) => b[1].n - a[1].n).slice(0, 12)) {
  const accs = (await rpc('getTokenAccountsByOwner', [w, { mint: coin }, { encoding: 'jsonParsed' }]))?.value || [];
  const bal = accs.reduce((a, y) => a + (+y.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
  console.log(w, `paid ${x.n}x`, x.asset, x.amt.toString(), 'holds', Math.round(bal), top.has(w) ? 'TOP20' : '');
}
