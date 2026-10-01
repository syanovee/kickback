const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export function solCompact(tx, W){
  const msg = tx.transaction.message, keys = msg.accountKeys, kp = keys.map(k=>k.pubkey), sg = keys.filter(k=>k.signer).map(k=>k.pubkey);
  const c = {s:tx.transaction.signatures[0], sl:tx.slot||0, t:tx.blockTime||0};
  if (tx.meta.err){ c.err=1; return c; }
  const d = {};
  for (const [ph,arr] of [['pre',tx.meta.preTokenBalances],['post',tx.meta.postTokenBalances]]){
    for (const b of arr||[]){
      if (b.owner!==W) continue;
      const a = kp[b.accountIndex];
      const e = d[a] || (d[a]={a, m:b.mint, dec:b.uiTokenAmount.decimals, pre:'0', post:'0'});
      e[ph] = b.uiTokenAmount.amount;
    }
  }
  c.d = Object.values(d); c.sg = sg;
  if (sg.includes(W)){ c.sw=1; return c; }
  const wi = kp.indexOf(W);
  c.wg = wi>=0 ? String(tx.meta.postBalances[wi]-tx.meta.preBalances[wi]) : '0';
  const logs = tx.meta.logMessages||[];
  const scribe = logs.map(l=>/scribe:rewards (\w{32,44})/.exec(l)).find(Boolean); if (scribe) c.sc = scribe[1];
  if (logs.some(l=>l.includes('DistributeFeeToHolders')) && kp.includes(PUMP_PROGRAM)){
    const ix = msg.instructions.find(i=>i.programId===PUMP_PROGRAM);
    c.pf = 1; c.pc = (ix?.accounts||[]).find(a=>a.endsWith('pump')) || ix?.accounts?.[2] || null;
  }
  const gainers = new Set();
  for (const b of tx.meta.postTokenBalances||[]){
    const p=(tx.meta.preTokenBalances||[]).find(x=>x.accountIndex===b.accountIndex);
    if (BigInt(b.uiTokenAmount.amount)>BigInt(p?.uiTokenAmount.amount||'0')) gainers.add(b.owner);
  }
  let solGainers=0; kp.forEach((k,j)=>{ if (tx.meta.postBalances[j]>tx.meta.preBalances[j]) solGainers++; });
  if (Math.max(gainers.size, solGainers) >= 5){
    const senders = new Set(sg);
    const ixs = [...msg.instructions, ...(tx.meta.innerInstructions||[]).flatMap(x=>x.instructions)];
    for (const i of ixs){ const inf=i.parsed?.info; if (inf?.authority) senders.add(inf.authority); if (inf?.multisigAuthority) senders.add(inf.multisigAuthority); if (i.parsed?.type==='transfer' && inf?.source && inf?.lamports) senders.add(inf.source); }
    const groups = {};
    for (const i of ixs){ const t=i.parsed?.type, inf=i.parsed?.info; if(!inf) continue;
      if ((t==='transfer'||t==='transferChecked') && inf.destination){ const amt = inf.tokenAmount?.amount ?? inf.amount ?? inf.lamports; if (amt==null) continue;
        const k=(inf.mint||(inf.lamports!=null?'SOL':'tok'))+'|'+(inf.authority||inf.source); (groups[k]=groups[k]||new Map()).set(inf.destination, String(amt)); } }
    c.b = {snd:[...senders], pr:Object.values(groups).some(g=>g.size>=5 && new Set(g.values()).size>=3)?1:0};
  }
  return c;
}
