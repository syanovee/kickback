// One run that checks the calculator on every platform and writes a full report for review.
// node tools/yield-selftest.mjs        -> Claude outputs/selftest.txt
import fs from 'node:fs';
import { seedEngine } from './yield-seeds.mjs';
process.env.YDEBUG = '1';
const S = JSON.parse(fs.readFileSync(new URL('../secrets.json', import.meta.url)));
const m = seedEngine({ HELIUS: S.HELIUS_KEY, ALCHEMY: S.ALCHEMY_KEY, log: console.log });
let seeds = []; try { seeds = JSON.parse(fs.readFileSync('Claude outputs/seeds.json'))[0].results; } catch {}
// a few scanned coins of each platform, plus CAs searched by hand
const pick = {}; for (const x of seeds) { const k = x.chain + '|' + x.platform; (pick[k] = pick[k] || []).push(x); }
const ONLY = process.argv.includes('--only'); process.argv = process.argv.filter(x => x !== '--only');
const cases = ONLY ? [] : Object.values(pick).flatMap(a => a.sort((p, q) => (q.n || 0) - (p.n || 0)).slice(0, 3)).map(x => ({ seed: x }));
for (const ca of [...(ONLY ? [] : ['Hg5Ja55T5wESq4vyFoiVCMeHXtGyVA69X2UHq8hgpump', '0x47accd13264d8f954105256faac8376ce6a55999']), ...process.argv.slice(2)]) cases.push({ ca });
const lines = [];
const say = (...a) => { const l = a.join(' '); console.log(l); lines.push(l); };
for (const c of cases) {
  const t0 = Date.now();
  try {
    const seed = c.seed || await m.discover(c.ca.startsWith('0x') ? 'evm' : 'solana', c.ca);
    if (!seed) { say(`\n## ${c.ca}: no holder payouts found (${((Date.now() - t0) / 1e3).toFixed(0)}s)`); continue; }
    say(`\n## ${seed.chain} ${seed.platform} ${seed.coin}${c.ca ? ' (found from CA)' : ''}`);
    const r = await m(seed);
    if (!r.coin) { say('   result:', r.note); continue; }
    const st = r.stat, k = st.curve;
    const at = usd => { const toks = usd / st.price; if (!k || k.length < 3) return st.per7d; if (toks <= k[0][0]) return k[0][1]; if (toks >= k.at(-1)[0]) return k.at(-1)[1]; for (let i = 1; i < k.length; i++) if (toks <= k[i][0]) { const f = (Math.log(toks) - Math.log(k[i - 1][0])) / (Math.log(k[i][0]) - Math.log(k[i - 1][0])); return k[i - 1][1] + (k[i][1] - k[i - 1][1]) * f; } };
    const wk = usd => st.price && st.qprice ? (usd / st.price * at(usd) * st.qprice) : null;
    say(`   $${r.coin.symbol} pays ${r.coin.quote_symbol}, mcap $${Math.round(r.coin.mcap || 0)}, price ${st.price}, reward price ${st.qprice}`);
    say(`   measured on ${st.n} wallets, window ${st.win_h}h, per token/wk median ${st.per7d} (p25 ${st.lo}, p75 ${st.hi})`);
    for (const a of [100, 1000, 10000]) say(`   $${a} held -> $${wk(a)?.toFixed(2)} / week  (${wk(a) ? (wk(a) * 52 / a * 100).toFixed(1) : '?'}% a year)`);
    for (const p of st.proofs) say(`   proof ${p.w} holds ${Math.round(p.bal)} got ${p.got.toFixed(4)} in ${p.n} payouts`);
    if (k) say('   curve (tokens held -> per token/wk):', k.map(x => `${Math.round(x[0])}:${x[1].toFixed(4)}`).join('  '));
  } catch (e) { say('   ERROR', e.message); }
  say(`   took ${((Date.now() - t0) / 1e3).toFixed(0)}s`);
}
fs.writeFileSync('Claude outputs/selftest.txt', lines.join('\n'));
console.log('\nsaved Claude outputs/selftest.txt');
