const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {parseFubon,parseYuanta,createPortfolioMarket}=require('../portfolio-market');
// Deliberately synthetic: validates parsing contracts, never a financial source.
const fubon=(rows='2330 台積電 10 2000 60 2317 鴻海 20 1000 30')=>`<h1>006208 / 富邦台50 測試基金</h1><p>資料日期：2026/10/21 基金每單位淨值(新台幣) 100</p><table>股票代碼 股票名稱 股數 金額 權重(%) ${rows} 股票合計 3,000 90</table>`;
const fund={data:[{fundData:{STK_CD:'0050',FUND_ID:'1066',ISINCODE:'TW0000050004',STK_NAME:'測試基金'}},{weightData:{PCF:{markcd:'0050',fundid:'1066',trandate:'20261022',nav:100},FundWeights:{Summary:{code:'1066'},StockWeights:[{code:'2330',name:'台積電',qty:10,weights:60}],FutureWeights:[],ETFWeights:[],BondWeights:[]}}}]};
const yuanta=(block='基金權重-股票 交易日期: 2026/10/21 商品代碼 2330 商品名稱 台積電 商品數量 10 商品權重 60')=>`<p>${block}</p><script>window.__NUXT__=(function(){return ${JSON.stringify(fund)}})();</script>`;
test('stock section date is verified independently from newer PCF date',()=>{const d=parseYuanta(yuanta(),'0050','2026-10-22');assert.equal(d.holdingsDate,'2026-10-21');assert.equal(d.nav.date,'2026-10-22');assert.equal(d.otherGroups.length,3);});
test('missing stock section date never inherits PCF; visible conflict fails closed',()=>{assert.equal(parseYuanta(yuanta('基金權重-股票 商品代碼 2330'),'0050','2026-10-22').holdingsDate,null);assert.throws(()=>parseYuanta(yuanta('基金權重-股票 交易日期: 2026/10/21 商品代碼 2330 商品名稱 台積電 商品數量 10 商品權重 59'),'0050','2026-10-22'),/不一致/);});
test('first-use Fubon validates exact identity, date, all rows and official sum',()=>{const d=parseFubon(fubon(),'006208','2026-10-22');assert.equal(d.stocks.length,2);assert.equal(d.stockWeight,90);assert.equal(d.holdingsDate,'2026-10-21');assert.equal(d.complete,false);});
test('Fubon wrong identity, missing date, truncation, hidden leftovers and bad totals fail closed',()=>{for(const h of [fubon().replace('006208 /','00692 /'),fubon().replace('2026/10/21','2026/10/23'),fubon().replace('資料日期：','來源日期：'),fubon('2330 台積電 10 2000 60'),fubon()+'',fubon('2330 台積電 10 2000 60 未知列 2317 鴻海 20 1000 30')].filter((_,i)=>i!==4))assert.throws(()=>parseFubon(h,'006208','2026-10-22'));assert.throws(()=>parseFubon(fubon().replace('3,000 90','3,001 90'),'006208','2026-10-22'));});
test('empty cache waits for official source then persists and reuses evidence',async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'portfolio-first-use-'));try{let calls=0,release;const wait=new Promise(r=>release=r);const service=createPortfolioMarket({cacheDir:dir,allowNetwork:true,now:()=>Date.parse('2026-10-22T00:00:00Z'),fetchImpl:async url=>{calls++;await wait;return new Response(url.includes('fsit')?fubon():JSON.stringify({stat:'OK',title:'115年10月 006208 測試',fields:['日期','收盤價'],data:[['115/10/21','100']]}));}});const job=service.start(['006208']);assert.equal(job.status,'running');assert.equal(job.completed,0);assert.equal(fs.existsSync(path.join(dir,'006208.json')),false);release();let done;for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,5));done=service.status(job.id);if(done.status!=='running')break;}assert.equal(done.data['006208'].status,'observed');assert.equal(done.data['006208'].holdingsDate,'2026-10-21');assert.equal(calls,2);assert.equal((await service.get('006208')).status,'cached');assert.equal(calls,2);}finally{fs.rmSync(dir,{recursive:true,force:true});}});
test('unsupported ETF is not disguised as successful automatic update',async()=>{let calls=0;const service=createPortfolioMarket({allowNetwork:true,fetchImpl:async()=>{calls++;throw Error('unexpected');}});const d=await service.get('00646');assert.equal(d.status,'unsupported');assert.match(d.message,/等待或重試不會自動補齊/);assert.equal(calls,0);});
test('five temporarily pending funds finish immediately without sources or cached holdings',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'portfolio-pending-'));
  try {
    const tickers=['00904','00936','00947','00962','00987A'],at=Date.parse('2026-10-23T13:00:00Z');
    // Deliberately synthetic old cache: pending policy must override otherwise reusable data.
    const data={ticker:'00904',status:'observed',identityVerified:true,observedAt:new Date(at).toISOString(),stocks:[{code:'2330',securityId:'TW:2330',name:'合成股票',weight:100}]};
    fs.writeFileSync(path.join(dir,'00904.json'),JSON.stringify({version:7,sha256:require('node:crypto').createHash('sha256').update(JSON.stringify(data)).digest('hex'),data}));
    let calls=0;
    const service=createPortfolioMarket({cacheDir:dir,now:()=>at,allowNetwork:true,fetchImpl:async()=>{calls++;throw Error('must not request pending sources');}});
    for(const ticker of tickers){const d=await service.get(ticker);assert.equal(d.status,'unavailable');assert.equal(d.reasonCode,'fund_data_pending_update');assert.equal(d.message,'基金資料待更新');assert.equal(d.stocks,undefined);}
    const job=service.start(tickers);assert.equal(job.status,'partial');assert.equal(job.completed,5);assert.equal(job.total,5);assert.equal(calls,0);
    const result=require('../portfolio-overlap').calculate(tickers.map(ticker=>({ticker,amount:1000})),job.data);
    assert.equal(result.status,'unavailable');assert.equal(result.rows.length,0);assert.equal(result.sources.length,0);assert.equal(result.gaps.length,5);assert(result.gaps.every(g=>g.reason==='基金資料待更新'));
    assert.equal(require('../portfolio-official').scopeFor('00904'),'domestic_equity');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('mixed portfolio preserves pending amounts and still loads other selected instruments',async()=>{
  let calls=0;const dir=fs.mkdtempSync(path.join(os.tmpdir(),'portfolio-pending-mixed-'));
  try {
    const service=createPortfolioMarket({cacheDir:dir,allowNetwork:true,now:()=>Date.parse('2026-10-23T13:00:00Z'),fetchImpl:async url=>{calls++;assert(url.includes('stockNo=2330'));return new Response(JSON.stringify({stat:'OK',title:'115年10月 2330 合成測試',fields:['日期','收盤價'],data:[['115/10/23','100']]}));}});
    let job=service.start(['00904','2330']);assert.equal(job.data['00904'].message,'基金資料待更新');assert.equal(job.completed,1);
    for(let i=0;i<100&&job.status==='running';i++){await new Promise(r=>setTimeout(r,5));job=service.status(job.id);}
    assert.equal(job.status,'partial');assert.equal(job.data['2330'].status,'observed');assert.equal(calls,1);
    const result=require('../portfolio-overlap').calculate([{ticker:'00904',amount:1000},{ticker:'2330',amount:1000}],job.data);
    assert.equal(result.status,'partial');assert.equal(result.total,2000);assert.equal(result.coveragePercent,50);assert.equal(result.rows[0].share,50);assert.equal(result.gaps[0].amount,1000);assert.equal(result.gaps[0].reason,'基金資料待更新');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
