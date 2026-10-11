// node tools/debug-coin.mjs <CA> [solana]   finds and measures one coin, printing every step
import fs from 'node:fs';
import { seedEngine } from './yield-seeds.mjs';
process.env.YDEBUG = '1';
const S = JSON.parse(fs.readFileSync(new URL('../secrets.json', import.meta.url)));
const m = seedEngine({ HELIUS: S.HELIUS_KEY, ALCHEMY: S.ALCHEMY_KEY, log: console.log });
const ca = process.argv[2], chain = process.argv[3] || (ca.startsWith('0x') ? 'evm' : 'solana');
const seed = await m.discover(chain, ca);
console.log('seed', seed);
if (seed) console.log(JSON.stringify(await m(seed), null, 1).slice(0, 3000));
