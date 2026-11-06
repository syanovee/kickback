// Params for the paid RPC proxies are rebuilt here from what the page actually sends, never forwarded as given:
// a caller can't pick bigger pages, more keys or other shapes than Kickback itself uses.
// Each builder returns the clean params, or null when the call isn't one Kickback makes.
const PK = s => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
const SIG = s => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(s);
const B64 = s => typeof s === 'string' && s.length <= 2400 && /^[A-Za-z0-9+/]+={0,2}$/.test(s);
const INT = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isObj = o => o && typeof o === 'object' && !Array.isArray(o);
const TOKEN_PROGRAMS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
const COMMIT = new Set(['processed', 'confirmed', 'finalized']);
const ENC = new Set(['jsonParsed', 'base64', 'json']);

function range(r, keys, max) {   // {gte, gt, lt, lte} numeric filters
  if (!isObj(r)) return null; const o = {};
  for (const [k, v] of Object.entries(r)) { if (!keys.includes(k) || !INT(v, 0, max)) return null; o[k] = v; }
  return Object.keys(o).length ? o : null;
}
function dataSlice(d) { return isObj(d) && INT(d.offset, 0, 10240) && INT(d.length, 0, 10240) ? { offset: d.offset, length: d.length } : null; }
function acctOpts(o) {
  if (o === undefined) return {};
  if (!isObj(o)) return null; const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === 'encoding' && ENC.has(v)) out.encoding = v;
    else if (k === 'commitment' && COMMIT.has(v)) out.commitment = v;
    else if (k === 'dataSlice' && dataSlice(v)) out.dataSlice = dataSlice(v);
    else return null;
  }
  return out;
}

export const SOL_PARAMS = {
  getTokenAccountsByOwner(p) {
    if (!Array.isArray(p) || p.length < 2 || !PK(p[0]) || !isObj(p[1])) return null;
    const f = Object.keys(p[1]).length === 1 && (TOKEN_PROGRAMS.has(p[1].programId) ? { programId: p[1].programId } : PK(p[1].mint) ? { mint: p[1].mint } : null);
    const o = acctOpts(p[2]); if (!f || !o) return null;
    return [p[0], f, o];
  },
  getTransactionsForAddress(p) {
    if (!Array.isArray(p) || p.length !== 2 || !PK(p[0]) || !isObj(p[1])) return null;
    const i = p[1], o = {};
    if (i.transactionDetails !== 'signatures' && i.transactionDetails !== 'full') return null;
    o.transactionDetails = i.transactionDetails;
    // the page asks for 1000 signatures or 100 full transactions at most
    if (!INT(i.limit, 1, o.transactionDetails === 'full' ? 100 : 1000)) return null; o.limit = i.limit;
    for (const [k, v] of Object.entries(i)) {
      if (k === 'transactionDetails' || k === 'limit') continue;
      if (k === 'sortOrder' && (v === 'asc' || v === 'desc')) o.sortOrder = v;
      else if (k === 'encoding' && v === 'jsonParsed') o.encoding = v;
      else if (k === 'maxSupportedTransactionVersion' && INT(v, 0, 1)) o.maxSupportedTransactionVersion = v;
      else if (k === 'paginationToken' && typeof v === 'string' && v.length <= 400 && /^[\x21-\x7e]+$/.test(v)) o.paginationToken = v;
      else if (k === 'filters' && isObj(v)) {
        const f = {};
        for (const [fk, fv] of Object.entries(v)) {
          if (fk === 'status' && (fv === 'succeeded' || fv === 'failed' || fv === 'any')) f.status = fv;
          else if (fk === 'tokenAccounts' && (fv === 'balanceChanged' || fv === 'none' || fv === 'all')) f.tokenAccounts = fv;
          else if (fk === 'blockTime' && range(fv, ['gte', 'gt', 'lt', 'lte'], 4e9)) f.blockTime = range(fv, ['gte', 'gt', 'lt', 'lte'], 4e9);
          else if (fk === 'slot' && range(fv, ['gte', 'gt', 'lt', 'lte'], 1e10)) f.slot = range(fv, ['gte', 'gt', 'lt', 'lte'], 1e10);
          else return null;
        }
        o.filters = f;
      } else return null;
    }
    return [p[0], o];
  },
  getTransaction(p) {
    if (!Array.isArray(p) || p.length > 2 || !SIG(p[0])) return null;
    const i = p[1] ?? {}, o = {}; if (!isObj(i)) return null;
    for (const [k, v] of Object.entries(i)) {
      if (k === 'encoding' && (v === 'jsonParsed' || v === 'json')) o.encoding = v;
      else if (k === 'maxSupportedTransactionVersion' && INT(v, 0, 1)) o.maxSupportedTransactionVersion = v;
      else if (k === 'commitment' && COMMIT.has(v)) o.commitment = v;
      else return null;
    }
    return [p[0], o];
  },
  getAssetBatch(p) {   // Helius DAS: {ids}
    if (!isObj(p) || Object.keys(p).length !== 1 || !Array.isArray(p.ids) || !p.ids.length || p.ids.length > 500 || !p.ids.every(PK)) return null;
    return { ids: p.ids };
  },
  getSignaturesForAddress(p) {
    if (!Array.isArray(p) || p.length > 2 || !PK(p[0])) return null;
    const i = p[1] ?? {}, o = {}; if (!isObj(i)) return null;
    for (const [k, v] of Object.entries(i)) {
      if (k === 'limit' && INT(v, 1, 1000)) o.limit = v;
      else if ((k === 'before' || k === 'until') && SIG(v)) o[k] = v;
      else if (k === 'commitment' && COMMIT.has(v)) o.commitment = v;
      else return null;
    }
    return [p[0], o];
  },
  getAccountInfo(p) { if (!Array.isArray(p) || p.length > 2 || !PK(p[0])) return null; const o = acctOpts(p[1]); return o ? [p[0], o] : null; },
  getMultipleAccounts(p) {
    if (!Array.isArray(p) || p.length > 2 || !Array.isArray(p[0]) || !p[0].length || p[0].length > 100 || !p[0].every(PK)) return null;
    const o = acctOpts(p[1]); return o ? [p[0], o] : null;
  },
  getBalance(p) { if (!Array.isArray(p) || p.length > 2 || !PK(p[0])) return null; const o = acctOpts(p[1]); return o && !o.encoding && !o.dataSlice ? [p[0], o] : null; },
  // claim (rent): building, checking, sending and confirming the user's own signed transactions
  getMinimumBalanceForRentExemption(p) { return Array.isArray(p) && p.length === 1 && INT(p[0], 0, 10240) ? [p[0]] : null; },
  getLatestBlockhash(p) { if (p === undefined || (Array.isArray(p) && !p.length)) return []; return Array.isArray(p) && p.length === 1 && isObj(p[0]) && Object.keys(p[0]).length === 1 && COMMIT.has(p[0].commitment) ? [{ commitment: p[0].commitment }] : null; },
  simulateTransaction(p) {
    if (!Array.isArray(p) || p.length !== 2 || !B64(p[0]) || !isObj(p[1])) return null;
    const o = {};
    for (const [k, v] of Object.entries(p[1])) {
      if (k === 'encoding' && v === 'base64') o.encoding = v;
      else if ((k === 'sigVerify' || k === 'replaceRecentBlockhash') && typeof v === 'boolean') o[k] = v;
      else if (k === 'commitment' && COMMIT.has(v)) o.commitment = v;
      else if (k === 'accounts' && isObj(v) && v.encoding === 'base64' && Array.isArray(v.addresses) && v.addresses.length <= 4 && v.addresses.every(PK) && Object.keys(v).length === 2) o.accounts = { encoding: 'base64', addresses: v.addresses };
      else return null;
    }
    if (o.encoding !== 'base64') return null;
    return [p[0], o];
  },
  sendTransaction(p) {
    if (!Array.isArray(p) || p.length !== 2 || !B64(p[0]) || !isObj(p[1])) return null;
    const o = {};
    for (const [k, v] of Object.entries(p[1])) {
      if (k === 'encoding' && v === 'base64') o.encoding = v;
      else if (k === 'skipPreflight' && typeof v === 'boolean') o.skipPreflight = v;
      else if (k === 'preflightCommitment' && COMMIT.has(v)) o.preflightCommitment = v;
      else if (k === 'maxRetries' && INT(v, 0, 10)) o.maxRetries = v;
      else return null;
    }
    if (o.encoding !== 'base64') return null;
    return [p[0], o];
  },
  getSignatureStatuses(p) {
    if (!Array.isArray(p) || p.length > 2 || !Array.isArray(p[0]) || !p[0].length || p[0].length > 50 || !p[0].every(SIG)) return null;
    const i = p[1] ?? {}; if (!isObj(i)) return null;
    for (const [k, v] of Object.entries(i)) if (!(k === 'searchTransactionHistory' && typeof v === 'boolean')) return null;
    return [p[0], { ...i }];
  },
};

// Alchemy (EVM + a few Solana reads)
const HEX = (s, max = 66) => typeof s === 'string' && s.length <= max && /^0x[0-9a-fA-F]*$/.test(s);
const EADDR = s => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);
const TAGB = s => s === 'latest' || HEX(s, 18);
const CATS = new Set(['external', 'internal', 'erc20', 'erc721', 'erc1155', 'specialnft']);
export const EVM_PARAMS = {
  eth_blockNumber: p => (p === undefined || (Array.isArray(p) && !p.length)) ? [] : null,
  eth_getCode: p => Array.isArray(p) && p.length === 2 && EADDR(p[0]) && TAGB(p[1]) ? [p[0], p[1]] : null,
  eth_getBalance: p => Array.isArray(p) && p.length === 2 && EADDR(p[0]) && TAGB(p[1]) ? [p[0], p[1]] : null,
  eth_getTransactionByHash: p => Array.isArray(p) && p.length === 1 && HEX(p[0]) && p[0].length === 66 ? [p[0]] : null,
  eth_getTransactionReceipt: p => Array.isArray(p) && p.length === 1 && HEX(p[0]) && p[0].length === 66 ? [p[0]] : null,
  eth_call(p) {
    if (!Array.isArray(p) || p.length !== 2 || !isObj(p[0]) || !TAGB(p[1])) return null;
    const { to, data, ...rest } = p[0];
    if (Object.keys(rest).length || !EADDR(to) || !HEX(data, 1000)) return null;   // view calls only: no from, value or gas
    return [{ to, data }, p[1]];
  },
  alchemy_getAssetTransfers(p) {
    if (!Array.isArray(p) || p.length !== 1 || !isObj(p[0])) return null;
    const o = {};
    for (const [k, v] of Object.entries(p[0])) {
      if ((k === 'fromBlock' || k === 'toBlock') && TAGB(v)) o[k] = v;
      else if ((k === 'fromAddress' || k === 'toAddress') && EADDR(v)) o[k] = v;
      else if (k === 'contractAddresses' && Array.isArray(v) && v.length <= 20 && v.every(EADDR)) o[k] = v;
      else if (k === 'category' && Array.isArray(v) && v.length && v.length <= 6 && v.every(c => CATS.has(c))) o[k] = v;
      else if (k === 'maxCount' && HEX(v, 6) && parseInt(v, 16) >= 1 && parseInt(v, 16) <= 1000) o[k] = v;
      else if (k === 'order' && (v === 'asc' || v === 'desc')) o[k] = v;
      else if ((k === 'withMetadata' || k === 'excludeZeroValue') && typeof v === 'boolean') o[k] = v;
      else if (k === 'pageKey' && typeof v === 'string' && v.length <= 200 && /^[A-Za-z0-9_-]+$/.test(v)) o[k] = v;
      else return null;
    }
    return [o];
  },
  getTransaction: p => SOL_PARAMS.getTransaction(p),
  getSlot: p => (p === undefined || (Array.isArray(p) && !p.length)) ? [] : null,
};
