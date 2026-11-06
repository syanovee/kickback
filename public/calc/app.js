document.addEventListener('error', e=>{ const im=e.target; if (im instanceof HTMLImageElement && im.dataset.oe==='rm') im.remove(); }, true);

const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const usd=v=>!isFinite(v)?'$0':v>=100?'$'+Math.round(v).toLocaleString('en-US'):'$'+v.toFixed(2);
const num=v=>v>=1e6?(v/1e6).toFixed(2)+'M':v>=1e3?Math.round(v).toLocaleString('en-US'):v>=1?v.toFixed(2):v>=0.01?v.toFixed(4):v.toPrecision(3);
const pct=v=>(v>=0?'+':'')+v.toFixed(1)+'%';
const short=a=>a.slice(0,4)+'…'+a.slice(-4);
const cap=v=>v>=1e9?'$'+(v/1e9).toFixed(1)+'B':v>=1e6?'$'+(v/1e6).toFixed(1)+'M':'$'+Math.round(v/1e3)+'K';
const isAddr=s=>/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)||/^0x[0-9a-fA-F]{40}$/.test(s);
const ic=(c,cls='')=>`<span class="ic ${cls}">${c.icon?`<img src="${esc(c.icon)}" alt="" loading="lazy" data-oe="rm">`:''}${c.icon?'':esc((c.symbol||'?')[0])}</span>`;
const store={get(k,d){try{return JSON.parse(localStorage.getItem(k))??d}catch{return d}},set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch{}}};
const cache=new Map();
async function coin(mint){ if(cache.has(mint)) return cache.get(mint); const p=fetch('/api/yield/'+mint).then(r=>r.ok?r.json():null).then(v=>v?.status==='unknown'||v?.status==='unsupported'?fetch('/api/yield/'+mint,{method:'POST'}).then(r=>r.json()).catch(()=>null):v).catch(()=>null); cache.set(mint,p); const v=await p; if(!v||v.status!=='ok') cache.delete(mint); return v; }
let cur=null, bag=store.get('kb_bag',[]);

// search
let st=0, lastQ='';
async function list(){ const q=$('q').value.trim().replace(/^\$/,''), dd=$('dd');
  if(!q){ dd.classList.remove('on'); return; }
  if(isAddr(q)){ dd.classList.remove('on'); openCoin(q); return; }
  const my=++st; lastQ=q;
  const j=await fetch('/api/yield/search?q='+encodeURIComponent(q)).then(r=>r.json()).catch(()=>({items:[]}));
  if(my!==st) return;
  dd.innerHTML=j.items.length?j.items.map(c=>`<div class="op" data-m="${esc(c.mint)}">${ic(c)}<div class="on"><b>$${esc(c.symbol)}</b><i>${esc(short(c.mint))}${c.mcap?' · '+cap(c.mcap)+' mcap':''}</i></div><small>pays ${esc(c.quote)}</small><span class="y">${c.usdPer1kWeek!=null?usd(c.usdPer1kWeek)+'/wk':c.fresh?'add':'…'}</span></div>`).join('')
    :`<div class="chk">No coin with that ticker yet. Paste its CA and we'll add it.</div>`;
  dd.classList.add('on'); }
$('q').addEventListener('input',()=>{ clearTimeout(list.t); list.t=setTimeout(list,180); });
$('q').addEventListener('focus',list);
$('q').addEventListener('keydown',e=>{ if(e.key==='Enter'){ const f=$('dd').querySelector('.op'); if(f) openCoin(f.dataset.m); else list(); } });
$('dd').onclick=e=>{ const o=e.target.closest('.op'); if(o) openCoin(o.dataset.m); };
document.addEventListener('click',e=>{ if(!e.target.closest('.srch')) $('dd').classList.remove('on'); });
fetch('/api/yield/search').then(r=>r.json()).then(j=>{ $('pop').innerHTML=j.items.slice(0,4).map(c=>`<span data-m="${esc(c.mint)}">${ic(c)}$${esc(c.symbol)}</span>`).join(''); }).catch(()=>{});
$('pop').onclick=e=>{ const t=e.target.closest('[data-m]'); if(t) openCoin(t.dataset.m); };

function msg(html){ $('msg').innerHTML=html; $('msg').classList.toggle('on',!!html); }
async function openCoin(mint){
  $('dd').classList.remove('on'); msg('<span class="ld"></span>Loading…'); $('calc').classList.remove('on');
  const c=await coin(mint);
  if(!c){ msg('Could not load this coin. Try again in a moment.'); return; }
  if(c.status==='pending'){ msg('<b>Added.</b> We\'ll measure its payouts on-chain in the next hourly run. Come back in about an hour.'); return; }
  if(c.status==='unsupported'){ msg('We measure <b>StonkFun</b> coins right now. pump.fun, Pons and other chains are coming next.'); return; }
  if(c.status==='no-rewards'){ msg(`<b>$${esc(c.symbol||'')}</b> does not pay its holders.`); return; }
  if(c.status==='quiet'||!(c.per7d>0)){ msg(`<b>$${esc(c.symbol||'')}</b> ${c.status==='quiet'||c.paid7d===0?'has not paid holders in the last 7 days.':'is still being measured. Check back in an hour.'}${c.note&&c.status!=='quiet'&&c.paid7d!==0?'<br><small>Last try: '+esc(c.note)+'.</small>':''}`); return; }
  msg(''); cur=c; $('q').value='$'+c.symbol;
  history.replaceState(null,'','/calc/?c='+c.mint);
  $('cIc').outerHTML=ic(c,'l').replace('class="ic l"','class="ic l" id="cIc"');
  $('cSym').textContent='$'+c.symbol; $('cSub').textContent=`pays ${c.quote.symbol} · ${c.platform} · ${c.chain==='solana'?'Solana':c.chain}`;
  $('cApr').textContent=c.usdPer1kWeek!=null?(c.usdPer1kWeek*52/10).toFixed(1)+'%':'·';
  const net=c.pricePct7d!=null;
  $('net').style.display=net&&c.rewardsPct7d!=null?'':'none';
  if(net){ const r=c.rewardsPct7d, p=c.pricePct7d, n=r+p; $('nR').textContent=pct(r); $('nP').textContent=pct(p); $('nP').className=p>=0?'u':'d'; $('nN').textContent=pct(n); $('nN').className=n>=0?'u':'d'; }
  const ratio=c.per24h/c.per7d;
  $('pace').innerHTML=c.coverH>=48&&c.per24h>0&&isFinite(ratio)&&Math.abs(ratio-1)>0.25?`Last 24h paid at <b>${ratio>1?(ratio).toFixed(1)+'x':Math.round(ratio*100)+'%'}</b> of the 7-day pace`:'';
  const m=c.measured, bh=c.basisH||c.coverH, cov=bh<167?` Based on the last ${bh>=36?Math.round(bh/24)+' days':Math.round(bh)+' hours'} of payouts, scaled to a week.`:'';
  $('why').innerHTML=`Measured on <b>${m.holders}</b> wallets paid in every round of the last ${m.windowH>=30?Math.round(m.windowH/24)+' days':Math.round(m.windowH)+'h'}. <button type="button" id="pfB">See their payouts</button>.${cov}`+(c.fee?`<br>$${esc(c.symbol)} takes a ${c.fee}% fee on every buy and sell, already counted above.`:'');
  $('pf').classList.remove('on');
  $('pf').innerHTML=m.proofs.map(p=>`<div class="r"><code>${esc(short(p.w))}</code> holds ${num(p.bal)}, got ${num(p.got)} ${esc(c.quote.symbol)} in ${p.n} payouts<a href="https://solscan.io/tx/${esc(p.sig)}" target="_blank" rel="noopener">tx ↗</a></div>`).join('');
  $('pfB').onclick=()=>$('pf').classList.toggle('on');
  $('buy').href=c.chain==='solana'?'https://jup.ag/swap/SOL-'+c.mint:'#';
  $('calc').classList.remove('on'); void $('calc').offsetWidth; $('calc').classList.add('on'); calc(); }

// what $a in this coin pays per week, in the reward token and in $
const weekly=(c,a)=>{ const toks=a/c.price*(1-c.fee/100), rw=toks*c.per7d; return {rw, usd:rw*c.qprice}; };
function calc(){ if(!cur) return; const a=parseFloat($('amt').value.replace(/,/g,''))||0, w=weekly(cur,a);
  $('oD').textContent=usd(w.usd/7); $('oW').textContent=usd(w.usd); $('oM').textContent=usd(w.usd*365/12/7); $('oY').textContent=usd(w.usd*52);
  $('tk').innerHTML=`≈ <b>${num(w.rw)} ${esc(cur.quote.symbol)}</b> a week, worth more or less as ${esc(cur.quote.symbol)} moves`; }
$('amt').oninput=calc;
document.querySelectorAll('.qk button').forEach(b=>b.onclick=()=>{ $('amt').value=b.dataset.v; calc(); });

// my bag
$('addBag').onclick=()=>{ if(!cur) return; const a=parseFloat($('amt').value.replace(/,/g,''))||0, ex=bag.find(x=>x.m===cur.mint); if(ex) ex.a+=a; else bag.push({m:cur.mint,a});
  store.set('kb_bag',bag); drawBag(); $('addBag').textContent='Added ✓'; setTimeout(()=>$('addBag').textContent='+ Add to my bag',900); };
async function drawBag(){ $('bag').classList.toggle('on',bag.length>0); if(!bag.length) return;
  const cs=await Promise.all(bag.map(x=>coin(x.m)));
  $('bl').innerHTML=bag.map((x,i)=>{ const c=cs[i]; if(!c||!(c.per7d>0)) return ''; return `<div class="bi">${ic(c)}<div><b>$${esc(c.symbol)}</b><small>pays ${esc(c.quote.symbol)}</small></div>
    <div class="ai"><span>$</span><input data-i="${i}" value="${x.a}" inputmode="decimal"></div><div class="wk" id="w${i}"></div><button class="x" data-x="${i}" type="button" aria-label="Remove">×</button></div>`; }).join('');
  tot(cs); }
function tot(cs){ let w=0, amt=0; bag.forEach((x,i)=>{ const c=cs[i]; if(!c||!(c.per7d>0)) return; const v=weekly(c,x.a).usd; w+=v; amt+=x.a; const el=$('w'+i); if(el) el.innerHTML=usd(v)+'<small>/wk</small>'; });
  $('tW').textContent='+'+usd(w)+' / wk'; $('tM').textContent='~'+usd(w*365/12/7); $('bN').textContent=`${bag.length} coin${bag.length>1?'s':''} · ${usd(amt)}`; tot.cs=cs; }
$('bl').oninput=e=>{ const i=e.target.dataset.i; if(i!=null){ bag[i].a=parseFloat(e.target.value.replace(/,/g,''))||0; store.set('kb_bag',bag); tot(tot.cs); } };
$('bl').onclick=e=>{ const i=e.target.dataset.x; if(i!=null){ bag.splice(i,1); store.set('kb_bag',bag); drawBag(); } };
drawBag();
const start=new URLSearchParams(location.search).get('c'); if(start&&isAddr(start)) openCoin(start);
