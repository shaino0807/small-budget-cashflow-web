const test=require('node:test'),assert=require('node:assert/strict');
const {priceRows,reconcile,createValuationQuotes,METHODS}=require('../portfolio-valuation');
const {calculate}=require('../portfolio-overlap');
// Synthetic fixtures test the acceptance contract; they are not market facts.
const day='2026-10-22',asOf='2026-10-23';
const doc=(ticker='00919')=>({ticker,kind:'etf',identityVerified:true,status:'observed',holdingsDate:null,nav:{date:day,value:10},valuationBasis:{date:day,netAssets:1000000,method:METHODS[ticker]},stocks:[{code:'2330',name:'合成股票',securityId:'TW:2330',quantity:1000,weight:12.3456}],receipts:[{sha256:'synthetic-official-version'}],issues:[],complete:false});
const quotes=()=>({rows:new Map([['2330',{code:'2330',close:123.45678,date:day,market:'TWSE'}]]),receipts:[{url:'https://www.twse.com.tw/synthetic',sha256:'synthetic-price-version',observedAt:'2026-10-23T00:00:00Z'}]});
function table(market='TWSE'){return {stat:'OK',date:'20261022',tables:[{title:market==='TWSE'?'115年10月22日 每日收盤行情(全部)':'上櫃股票行情',fields:market==='TWSE'?['證券代號','證券名稱','收盤價']:['代號','名稱','收盤'],data:[['2330','合成股票','123.45']]}]};}
test('accepted valuation date remains distinct from the undisclosed actual holdings date',()=>{
  const d=doc(),v=reconcile(d,quotes(),asOf);assert.equal(v.status,'verified');assert.equal(v.date,day);assert.equal(v.matchedRows,1);assert.match(v.limitation,/實際持股基準日未公開/);assert.equal(d.holdingsDate,null);
  d.valuationVerification=v;const result=calculate([{ticker:d.ticker,amount:100000}],{[d.ticker]:d});assert.equal(result.sources[0].holdingsDate,null);assert.equal(result.sources[0].valuationVerification.date,day);assert.equal(result.status,'partial');
});
test('observed issuer precision rules are separate and do not waive any unmatched row',()=>{
  assert.equal(Object.keys(METHODS).length,12);const d=doc('00904');d.stocks[0].weight=12.3457;assert.equal(reconcile(d,quotes(),asOf).method,'round4');d.stocks[0].weight=12.3456;assert.throws(()=>reconcile(d,quotes(),asOf),/不一致/);
});
test('missing prices, stale dates, invalid quantities, AUM, future dates and conflicting dates fail closed',()=>{
  for(const change of [d=>d.valuationBasis.netAssets=null,d=>d.valuationBasis.netAssets='1000000',d=>d.valuationBasis.date='2026-10-24',d=>d.nav.date='2026-10-21',d=>d.holdingsDate=day,d=>d.stocks[0].quantity=null,d=>d.stocks[0].quantity=-1,d=>d.stocks[0].weight=12,d=>d.valuationBasis.method='round4',d=>d.ticker='0050']){const d=doc();change(d);assert.throws(()=>reconcile(d,quotes(),asOf));}
  const missing=quotes();missing.rows.clear();assert.throws(()=>reconcile(doc(),missing,asOf),/缺少/);const stale=quotes();stale.rows.get('2330').date='2026-10-21';assert.throws(()=>reconcile(doc(),stale,asOf),/同日/);
});
test('every changed official data version is rechecked and receives its own basis digest',()=>{
  const d=doc(),first=reconcile(d,quotes(),asOf);d.receipts[0].sha256='synthetic-new-version';assert.notEqual(reconcile(d,quotes(),asOf).basisHash,first.basisHash);d.stocks[0].quantity=2000;assert.throws(()=>reconcile(d,quotes(),asOf),/不一致/);
});
test('official quote tables bind the response date and reject duplicates or changed schemas',()=>{
  for(const market of ['TWSE','TPEx'])assert.equal(priceRows(table(market),market,day).get('2330').close,123.45);
  for(const change of [j=>j.date='20261021',j=>j.stat='error',j=>j.tables[0].date='115/10/21',j=>j.tables[0].data.push(j.tables[0].data[0]),j=>j.tables[0].fields[2]='其他欄位']){const j=table();change(j);assert.throws(()=>priceRows(j,'TWSE',day));}
});
test('dated public quotes coalesce concurrently, expire, retry failure and request the exact valuation day',async()=>{
  let calls=0,time=1000;const urls=[];const load=createValuationQuotes({now:()=>time,ttl:100,source:async url=>{calls++;urls.push(url);const j=table(url.includes('tpex')?'TPEx':'TWSE');if(url.includes('tpex'))j.tables[0].data[0][0]='6488';return {text:JSON.stringify(j),receipt:{url,sha256:'synthetic'}};}});
  const [a,b]=await Promise.all([load(day),load(day)]);assert.equal(calls,2);assert.strictEqual(a,b);assert.equal(a.rows.size,2);assert(urls.every(u=>u.includes('20261022')||u.includes('2026%2F10%2F22')));await load(day);assert.equal(calls,2);time+=101;await load(day);assert.equal(calls,4);
  let failing=true;const retry=createValuationQuotes({source:async url=>{if(failing)throw Error('synthetic outage');const j=table(url.includes('tpex')?'TPEx':'TWSE');if(url.includes('tpex'))j.tables[0].data[0][0]='6488';return {text:JSON.stringify(j),receipt:{url}};}});await assert.rejects(retry(day));failing=false;assert.equal((await retry(day)).rows.size,2);
});
test('ambiguous cross-market security codes never pass valuation checks',async()=>{
  const load=createValuationQuotes({source:async url=>({text:JSON.stringify(table(url.includes('tpex')?'TPEx':'TWSE')),receipt:{url}})});await assert.rejects(load(day),/跨市場/);
});
