const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createEtfMarketService}=require('../etf-market');
const {trailingYield}=require('../etf-data');
test('30 distinct customer reads succeed during source outage without making upstream requests',async()=>{
 let calls=0,key='batch-a';
 const db={metadata:{dataBatch:{batchId:key}},etfs:Array.from({length:30},(_,i)=>({ticker:'0'+String(500+i)})),
   priceSeries:{items:[{ticker:'0500',date:'2026-10-15',close:50}]},privateCustomer:{secret:'must-not-leak'}};
 const service=createEtfMarketService({readDatabase:()=>({db,key}),fetchText:async()=>{calls++;throw Error('offline');},fetchPrice:async()=>{calls++;throw Error('offline');}});
 const rows=await Promise.all(db.etfs.map(e=>service.get(e.ticker,6)));
 assert.equal(rows.length,30);assert.equal(calls,0);assert.equal(rows[0].priceSeries[0].close,50);
 assert(!JSON.stringify(rows).includes('must-not-leak'));assert.equal(rows[1].dataStatus,'not_yet_available');
 key='batch-b';db.priceSeries.items=[{ticker:'0500',date:'2026-10-16',close:60}];
 assert.equal((await service.get('0500')).priceSeries[0].close,60,'published batch invalidates the reader index');
 await assert.rejects(service.get('../0500'),e=>e.statusCode===400);
 await assert.rejects(service.get('0500',12),e=>e.statusCode===400);
 await assert.rejects(service.get('0999'),e=>e.statusCode===404);
});
function financial(rows,extra={}){return {etfs:[{ticker:'0050',listingDate:'2003-06-30'}],priceSeries:{items:[{ticker:'0050',date:'2026-10-15',close:50,currency:'TWD'}]},distributionHistory:{'0050':{complete:true,from:'2024-01-01',to:'2026-10-16',currency:'TWD',...extra}},distributions:rows.map(r=>({ticker:'0050',payDate:'2026-07-20',exDividendDate:'2026-06-17',amountPerUnit:1,currency:'TWD',...r}))};}
test('cash yield deduplicates equal events and rejects conflicting amount, pay date and currency',()=>{
 assert.equal(trailingYield(financial([{},{}]),'0050','2026-10-16').value,2);
 assert.equal(trailingYield(financial([{}, {amountPerUnit:2}]),'0050','2026-10-16').status,'conflicting_distribution');
 assert.equal(trailingYield(financial([{}, {payDate:'2026-07-21'}]),'0050','2026-10-16').status,'conflicting_distribution');
 assert.equal(trailingYield(financial([{currency:'USD'}]),'0050','2026-10-16').status,'currency_mismatch');
 assert.equal(trailingYield(financial([{payDate:null}]),'0050','2026-10-16').status,'invalid_distribution');
 assert.equal(trailingYield(financial([], {conflicts:['unresolved official date']}),'0050','2026-10-16').status,'source_conflict');
 assert.equal(trailingYield(financial([{estimated:true}]),'0050','2026-10-16').value,null);
});
test('decimal payments accumulate and split adjustments affect only earlier payments',()=>{
 const db=financial([{amountPerUnit:.1},{amountPerUnit:.2,payDate:'2026-08-20',exDividendDate:'2026-08-01'}]);
 assert.equal(trailingYield(db,'0050','2026-10-16').cash,.3);
 db.splits=[{ticker:'0050',date:'2026-08-01',ratio:2}];
 assert.equal(trailingYield(db,'0050','2026-10-16').cash,.25);
 const paidAfterSplit=financial([{exDividendDate:'2026-07-20',payDate:'2026-08-20'}]);
 paidAfterSplit.splits=[{ticker:'0050',date:'2026-08-01',ratio:2}];
 assert.equal(trailingYield(paidAfterSplit,'0050','2026-10-16').cash,.5,'cash entitlement uses ex-date units even when payment follows the split');
 const reverse=financial([{amountPerUnit:1}]);
 reverse.splits=[{ticker:'0050',date:'2026-08-01',ratio:.16666667,numerator:1,denominator:6}];
 assert.equal(trailingYield(reverse,'0050','2026-10-16').cash,6,'official exact units avoid rounded-ratio cash errors');
});
test('complete lifetime coverage of a newly listed fund is labeled short history',()=>{
 const db=financial([{}],{from:'2026-01-01'});db.etfs[0].listingDate='2026-01-15';
 assert.equal(trailingYield(db,'0050','2026-10-16').status,'short_history');
 db.distributionHistory['0050'].from='2026-02-01';
 assert.equal(trailingYield(db,'0050','2026-10-16').status,'missing_history');
});
test('historical quote dates must match the requested date and malformed OHLC is rejected',()=>{
 const {dailyRows}=require('./collect-price-history'),tickers=new Map([['0050','TWD']]);
 const json={date:'20260416',stat:'OK',tables:[{fields:['證券代號','開盤價','最高價','最低價','收盤價','成交股數'],data:[['0050','10','12','9','11','2000']]}]};
 assert.equal(dailyRows(json,'TWSE','2026-04-16',tickers).rows[0].close,11);
 assert.equal(dailyRows(json,'TWSE','2026-04-15',tickers).rows.length,0);
 json.tables[0].data[0][2]='8';assert.equal(dailyRows(json,'TWSE','2026-04-16',tickers).status,'rejected_numeric_rows');
});
test('source access limits stop further requests to that host and cannot reuse rejected bodies',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'official-client-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let calls=0;const client=require('./official-source-client').createSourceClient(dir,{fetchImpl:async()=>{calls++;return new Response('rate limit',{status:429});}});
 assert.equal(await client.get('first','https://official.invalid/a'),null);
 assert.equal(await client.get('second','https://official.invalid/b'),null);assert.equal(calls,1);
 assert.equal(client.read('first'),null);
 assert.equal(client.records().find(r=>r.id==='second').attempted,false);
});
test('public source receipts retain evidence but do not persist session credentials or hidden form state',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'official-session-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const {createSourceClient}=require('./official-source-client');let observed;
 const client=createSourceClient(dir,{fetchImpl:async(url,options)=>{observed=options.headers.Authorization;return new Response('<html><input name="__RequestVerificationToken" value="temporary-form-secret"><input name="hidStkId" value="0050">official data</html>');}});
 const html=await client.get('fund','https://official.invalid/fund',{transientHeaders:{Authorization:'Bearer temporary-session-secret'}});
 assert.equal(observed,'Bearer temporary-session-secret');assert(!html.includes('temporary-form-secret'));assert(html.includes('value="0050"'));
 const receipt=client.records()[0];assert.equal(receipt.formStateRedacted,true);assert(receipt.wireSha256);
 assert(!JSON.stringify(receipt).includes('temporary-session-secret'));
 const authClient=createSourceClient(dir,{fetchImpl:async()=>new Response(JSON.stringify({access_token:'must-not-save'}))});
 assert.equal(await authClient.get('wrong-endpoint','https://official.invalid/session'),null);
 assert(!fs.readdirSync(dir).some(name=>name.startsWith('wrong-endpoint-')));
});
test('asset validation distinguishes signed liabilities, derivative exposure and ordinary stock weights',()=>{
 const {checkContent}=require('./data-batch');
 const base={etfs:[{ticker:'0050'}],holdings:{items:[]}};
 const row={ticker:'0050',holdingTicker:'cash',holdingName:'cash',asOfDate:'2026-10-15',sourceUrl:'https://official.invalid/assets'};
 const evaluate=rows=>checkContent(base,{...base,holdings:{items:rows}},{today:'2026-10-16'});
 assert.equal(evaluate([{...row,assetType:'cash',weight:-2},{...row,holdingTicker:'future',assetType:'future',weight:201}]).errors.length,0);
 assert(evaluate([{...row,assetType:'stock',weight:-2}]).errors.length>0);
 assert(evaluate([{...row,assetType:'stock',weight:201}]).errors.length>0);
 assert.equal(evaluate([{...row,assetType:'repo',weight:null,purchaseCost:100}]).errors.length,0);
 assert(evaluate([{...row,assetType:'repo',weight:null,purchaseCost:NaN}]).errors.length>0);
 assert.equal(evaluate([{...row,positionId:'cash:TWD',assetType:'cash',weight:.5,currency:'TWD'},
  {...row,positionId:'cash:USD',assetType:'cash',weight:.2,currency:'USD'}]).errors.length,0);
 const unknown={...row,asOfDate:null,assetType:'bond',weight:2,source:'issuer-official-full-published-positions',
  dateStatus:'official_position_date_not_declared',observedAt:'2026-10-16T00:00:00Z'};
 assert.equal(evaluate([unknown]).status,'pass_with_gaps');
 assert(evaluate([{...unknown,sourceUrl:null}]).errors.length>0);
});
test('compact catalog defers positions and full histories while keeping the same dated yield',()=>{
 const db=financial([{}]);db.holdings={items:[{ticker:'0050',holdingTicker:'2330',weight:50}]};
 const catalog=require('../market-view').marketCatalog(db),asOf=require('../etf-data').today();
 assert.equal(catalog.holdings.items.length,0);assert.equal(catalog.distributions.length,0);
 assert.equal(catalog.datasetCounts.holdings,1);assert.equal(catalog.datasetCounts.distributions,1);
 assert.deepEqual(trailingYield(catalog,'0050',asOf),{...trailingYield(db,'0050',asOf),asOf,requestedAsOf:asOf});
});

test('month and weekend boundaries preserve the explicitly dated snapshot without relabeling it as today',()=>{
 const {financialAsOf}=require('../etf-data'),db={marketCoverage:{asOf:'2026-10-31'}};
 assert.equal(financialAsOf(db,'2026-11-01'),'2026-10-31');
 assert.equal(financialAsOf(db,'2026-11-03'),'2026-10-31');
 assert.equal(financialAsOf(db,'2026-11-04'),'2026-11-04','stale snapshots cannot silently supply current yield');
 assert.equal(financialAsOf(db,'2026-10-30'),'2026-10-30','future snapshot dates cannot advance the request');
});
test('official calendar parser handles Taiwan dates and timestamp offsets without inventing a day',()=>{
 const u=require('./official-text');
 assert.equal(u.date('2026-10-14T16:00:00Z'),'2026-10-15');
 assert.equal(u.date('2026-10-15T00:00:00+08:00'),'2026-10-15');
 assert.equal(u.date('115年10月15日'),'2026-10-15');
 assert.equal(u.date('2026-02-30T16:00:00Z'),null);
 assert.equal(u.date('1900-01-01'),'1900-01-01');
 assert.equal(u.text('<!-- fake date 2030-01-01 -->actual'),'actual');
 assert.equal(u.tables('<!-- <table><tr><td>fake</td></tr></table> -->').length,0);
});

test('stock master does not turn bond, cash or derivative positions into searchable stocks',async()=>{
 const {refreshStockMaster}=require('./update-stock-master');
 const db=await refreshStockMaster({holdings:{items:[
  {holdingTicker:'2330',holdingName:'台積電',assetType:'stock'},
  {holdingTicker:'XS12345',holdingName:'Bond',assetType:'bond'},
  {holdingTicker:'TWD',holdingName:'Cash',assetType:'cash'},
  {holdingTicker:'TX202610',holdingName:'Future',assetType:'future'}]}},{fetchJson:async()=>{throw Error('offline')}});
 assert.deepEqual(db.stocks.items.map(r=>r.ticker),['2330']);
});

test('index provider requires the correct fund identity and an explicit provider label',()=>{
 const {normalizeIndexFields}=require('./collect-index-fields');
 const make=()=>({items:[{ticker:'006208',sourceRefs:[],profile:{}}]});
 const html='<div>006208 / 富邦台50</div><li><p>指數編製公司</p><p>Official joint providers</p></li>';
 assert.equal(normalizeIndexFields(make(),{read:()=>html}).items[0].profile.indexProvider,'Official joint providers');
 assert.equal(normalizeIndexFields(make(),{read:()=>html.replace('006208','0050')}).items[0].profile.indexProvider,undefined);
});
