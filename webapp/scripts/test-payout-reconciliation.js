// Synthetic boundary fixtures. Real official-response replay lives in the local audit.
const test=require('node:test'),assert=require('node:assert/strict');
const {parseSinopacHistory}=require('./sinopac-payout-history');
const {amendExchangePayments,corrections}=require('./payout-corrections');
const {applyMarketReference}=require('./apply-market-reference');
const {reconcileEvents}=require('./reconcile-market-events');
const {trailingYield}=require('../etf-data');
const rule=corrections[0],asOf='2026-10-17';
function sinopac(range='5',name='永豐優息存股',rowName=name){return `<select name="fundId"><option selected value="88">${name}</option></select>
 <input name="range" value="${range}" checked><input name="hdnTimeRange" value="${range}">
 <table><tr><th>基金</th><th>每單位配息</th><th>評價日</th><th>除息日</th><th>基準日</th><th>發放日</th></tr>
 <tr><td>${rowName}</td><td>0.24</td><td>2026/07/31</td><td>2026/08/25</td><td>2026/08/31</td><td>2026/09/18</td></tr></table>`;}
function notice(){return `<table><tr><th>發言日期</th><td>2026.07.13</td></tr><tr><th>說明</th><td>
 收益分配發放日遞延給付；發放日由115年7月13日遞延至115年7月14日。
 ${rule.tickers.map(t=>`(證券代號：${t})`).join(' ')}
 </td></tr></table>`;}
const ref={ticker:'00998A',identity:{issuer:'復華投信'}};
const row={exDate:'2026-06-17',payDate:'2026-07-13',amount:0.404};
function client(html=notice(),receipt={}){return {read:id=>id===rule.id?html:null,records:()=>[{id:rule.id,status:200,url:rule.sourceUrl,path:'notice.raw',sha256:'a'.repeat(64),...receipt}]};}
test('recent GET response cannot claim a full payout window',()=>{
 const result=parseSinopacHistory(sinopac('0'),{shortName:'永豐優息存股',asOf});
 assert.equal(result.completeWindow,false);assert.equal(result.identityVerified,true);
});
test('returned all-history form state and same fund are verified',()=>{
 const result=parseSinopacHistory(sinopac(),{shortName:'永豐優息存股',asOf});
 assert.equal(result.completeWindow,true);assert.equal(result.rows[0].amount,0.24);
 assert.equal(result.rows[0].payDate,'2026-09-18');
});
test('default fund, mixed fund rows and absent range proof fail closed',()=>{
 assert.equal(parseSinopacHistory(sinopac(),{shortName:'永豐ESG低碳高息',asOf}),null);
 assert.equal(parseSinopacHistory(sinopac('5','永豐優息存股','別的基金'),{shortName:'永豐優息存股',asOf}),null);
 assert.equal(parseSinopacHistory(sinopac().replace('name="hdnTimeRange"','name="unknown"'),{shortName:'永豐優息存股',asOf}).completeWindow,false);
});
test('dated, ticker-specific official amendment keeps amount and original record',()=>{
 const before=structuredClone(row),result=amendExchangePayments([row],ref,client(),asOf);
 assert.equal(result.rows[0].payDate,'2026-07-14');assert.equal(result.rows[0].amount,0.404);
 assert.equal(result.rows[0].originalPayDate,'2026-07-13');assert.equal(result.applied[0].sourceSha256,'a'.repeat(64));
 assert.deepEqual(row,before);
});
test('missing, altered, wrong-date or unrelated amendment evidence cannot change a payment',()=>{
 const variants=[client(null),client(notice(),{status:403}),client(notice(),{url:'https://example.com/'}),
  client(notice(),{sha256:null}),client(notice().replace('2026.07.13','2026.07.12')),
  client(notice().replace('00998A','00999A')),client(notice().replace('遞延至115年7月14日','遞延至115年7月15日'))];
 for(const c of variants)assert.deepEqual(amendExchangePayments([row],ref,c,asOf),{rows:[row],applied:[]});
 for(const other of [{...row,exDate:'2026-06-18'},{...row,amount:0.404,payDate:'2026-10-16'}])assert.deepEqual(amendExchangePayments([other],ref,client(),asOf).rows,[other]);
 assert.equal(amendExchangePayments([row],{...ref,ticker:'00986D'},client(),asOf).applied.length,0);
 assert.equal(amendExchangePayments([row],ref,client(),'2026-07-12').applied.length,0);
});
function applyFixture(c=client()){
 const source={id:'fhtrust-history-00998A',status:200,path:'history.raw',sha256:'b'.repeat(64),url:'https://www.fhtrust.com.tw/api/fundDividend',retrievedAt:'2026-10-18T00:00:00Z'};
 const prior={exDate:row.exDate,issuer:{payDate:'2026-07-14',amount:0.404},exchange:{payDate:row.payDate,amount:0.404}};
 const db={metadata:{},etfs:[{ticker:'00998A',issuer:'復華投信',currency:'TWD',listingDate:'2026-03-01'}],
  distributions:[],holdings:{items:[]},priceSeries:{items:[{ticker:'00998A',date:'2026-10-16',close:16.17,currency:'TWD'}]},
  distributionHistory:{'00998A':{complete:true,from:'2025-08-01',to:asOf,currency:'TWD',acceptance:'conflict',conflicts:[prior]}}};
 const item={...structuredClone(ref),profile:{currency:'TWD'},sourceRefs:[{id:source.id}],
  history:{identityVerified:true,completeWindow:true,windowFrom:'2025-08-01',sourceId:source.id,comparisonPerformed:true,conflicts:[],
   rows:[{...row,payDate:'2026-07-14',currency:'TWD'}]},payoutCrossCheck:{completeWindow:false,officialCorrections:[]}};
 const apply=(database,proof=c)=>applyMarketReference(database,{reference:{asOf,items:[structuredClone(item)]},receipts:[source,...proof.records()],read:proof.read});
 return {db,item,apply};
}
test('recent TPEx window clears only an amendment-proven prior date conflict',()=>{
 const {db,apply}=applyFixture();apply(db);
 assert.equal(db.distributionHistory['00998A'].conflicts.length,0);
 assert.equal(db.distributionHistory['00998A'].independentCrossSourceVerified,false);
 assert.equal(db.distributionHistory['00998A'].resolvedConflicts.length,1);
 assert.equal(trailingYield(db,'00998A',asOf).status,'short_history');
});
test('no amendment proof or conflicting issuer amount keeps a recorded conflict',()=>{
 const {db,apply}=applyFixture(client(null));apply(db);
 assert.equal(trailingYield(db,'00998A',asOf).status,'source_conflict');
 const changed=applyFixture();changed.db.distributionHistory['00998A'].conflicts[0].exchange.amount=0.5;
 changed.apply(changed.db);assert.equal(trailingYield(changed.db,'00998A',asOf).status,'source_conflict');
});
test('repeat refresh preserves amendment lineage; missing proof restores conflict',()=>{
 const {db,apply}=applyFixture();apply(db);apply(db);
 assert.equal(db.distributionHistory['00998A'].resolvedConflicts.length,1);
 assert.equal(db.distributionHistory['00998A'].officialCorrections.length,1);
 apply(db,client(null));assert.equal(trailingYield(db,'00998A',asOf).status,'source_conflict');
});
test('query cutoff excludes announced but unpaid future distribution',()=>{
 const {db,apply}=applyFixture();apply(db);
 db.distributions.push({ticker:'00998A',exDividendDate:'2026-10-01',payDate:'2026-10-20',amountPerUnit:99,currency:'TWD'});
 assert.equal(trailingYield(db,'00998A',asOf).cash,0.404);
});
test('TWSE whole-window match uses amendment proof and records its source',()=>{
 const c=client(),html=`<script>Start_Year option[value="2003"]; End_Year option[value="2026"];</script>
 <table><tr><th>證券代號</th><th>名稱</th><th>除息日</th><th>基準日</th><th>發放日</th><th>金額</th></tr>
 <tr><td>00710B</td><td>基金</td><td>2026/06/17</td><td>2026/06/23</td><td>2026/07/13</td><td>0.31</td></tr></table>`;
 const item={ticker:'00710B',market:'TWSE',identity:{issuer:'復華投信'},sourceRefs:[],
  history:{identityVerified:true,completeWindow:true,rows:[{exDate:'2026-06-17',payDate:'2026-07-14',amount:0.31}]}};
 const live={read:id=>id==='twse-payout-all-history'?html:c.read(id),records:()=>[...c.records(),{id:'twse-payout-all-history',path:'history.raw'}]};
 reconcileEvents({asOf,items:[item]},live);
 assert.equal(item.history.conflicts.length,0);assert.equal(item.history.independentlyReconciled,true);
 assert.equal(item.payoutCrossCheck.officialCorrections.length,1);
});
