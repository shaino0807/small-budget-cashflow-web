const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createPortfolioMarket,parseYuanta,parsePrice,date,num}=require('../portfolio-market');
const {calculate}=require('../portfolio-overlap');
// SYNTHETIC fixtures exercise the contract; these weights are never market evidence.
function fixture(ticker='0050') {
 const fundId=ticker==='0050'?'1066':'1084',isin=ticker==='0050'?'TW0000050004':'TW0000056001';
 return {data:[{fundData:{STK_CD:ticker,FUND_ID:fundId,ISINCODE:isin,STK_NAME:'測試基金'}},{weightData:{PCF:{markcd:ticker,fundid:fundId,trandate:'20261019',nav:10},FundWeights:{Summary:{code:fundId},StockWeights:[{code:'2330',name:'台積電',weights:60},{code:'2317',name:'鴻海',weights:30}],FutureWeights:[{code:'TX',weights:5}],ETFWeights:[],BondWeights:[]}}}]};
}
const html=body=>`<script>window.__NUXT__=(function(){return ${JSON.stringify(body)}})();</script>`;
const price=ticker=>({stat:'OK',title:`115年10月 ${ticker} 測試價格`,fields:['日期','收盤價'],data:[['115/10/19','10.50']]});
const root=fs.mkdtempSync(path.join(os.tmpdir(),'portfolio-demand-test-'));let seq=0;
const cache=()=>path.join(root,String(++seq));
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
function options(extra={}){return {cacheDir:cache(),now:()=>Date.parse('2026-10-19T12:00:00Z'),allowNetwork:true,fetchImpl:async url=>new Response(url.includes('yuanta')?html(fixture(url.includes('0056')?'0056':'0050')):JSON.stringify(price(new URL(url).searchParams.get('stockNo')))),...extra};}
test('empty and malformed numeric/date fields are not zero or valid dates',()=>{
 for(const input of [null,undefined,'',false,'bad'])assert.equal(num(input),null);
 assert.equal(num('1,234.5'),1234.5);assert.equal(date('20260230'),null);assert.equal(date('115/10/19'),'2026-10-19');
});
test('Yuanta identity binds ticker, fund id, ISIN, PCF and weight group',()=>{
 for(const change of [f=>f.data[0].fundData.STK_CD='0056',f=>f.data[0].fundData.ISINCODE='WRONG',f=>f.data[1].weightData.PCF.markcd='0056',f=>f.data[1].weightData.FundWeights.Summary.code='OTHER']){
  const f=fixture();change(f);assert.throws(()=>parseYuanta(html(f),'0050','2026-10-19'),/身份/);
 }
});
test('all stock rows retained, PCF date is NOT promoted to holdings date/completeness',()=>{
 const parsed=parseYuanta(html(fixture()),'0050','2026-10-19');assert.equal(parsed.stocks.length,2);assert.equal(parsed.holdingsDate,null);assert.equal(parsed.complete,false);assert.equal(parsed.nav.date,'2026-10-19');assert.equal(parsed.otherGroups[0].rows,1);
});
test('truncation, basket-only, duplicate securities, bad weights and future NAV fail closed',()=>{
 for(const change of [f=>f.data[1].weightData.FundWeights.StockWeights=[],f=>f.data[1].weightData.FundWeights.StockWeights[1].code='2330',f=>f.data[1].weightData.FundWeights.StockWeights[0].weights=null,f=>f.data[1].weightData.FundWeights.StockWeights[0].weights=90,f=>f.data[1].weightData.PCF.trandate='20261021']){
  const f=fixture();change(f);assert.throws(()=>parseYuanta(html(f),'0050','2026-10-19'));
 }
});
test('official price identity and real valid trade dates are mandatory',()=>{
 assert.equal(parsePrice(price('2330'),'2330','2026-10-19').close,10.5);
 assert.throws(()=>parsePrice(price('0050'),'2330','2026-10-19'));
 assert.throws(()=>parsePrice({...price('2330'),data:[['115/10/20','10']]},'2330','2026-10-19'));
});
test('empty/unrecognised portfolio never implies zero overlap',()=>{
 assert.equal(calculate([],{}).status,'empty');const r=calculate([{ticker:'UNKNOWN',amount:100}],{});assert.equal(r.status,'unavailable');assert.equal(r.gaps[0].amount,100);assert.equal(r.rows.length,0);
});
function instruments(){const f=t=>({...parseYuanta(html(fixture(t)),t,'2026-10-19'),status:'observed',observedAt:'2026-10-19T12:00:00Z',sourceUrl:'https://www.yuantaetfs.com/'});return {'0050':f('0050'),'0056':f('0056'),'2330':{kind:'stock',status:'observed',identityVerified:true,security:{securityId:'TW:2330',code:'2330',name:'台積電'},issues:[]}};}
test('weighted overlap includes direct exposure, keeps missing 10%, never rescales',()=>{
 const r=calculate([{ticker:'0050',amount:1000},{ticker:'0056',amount:2000},{ticker:'2330',amount:1000}],instruments());
 assert.equal(r.rows.find(s=>s.ticker==='2330').amount,2800);assert.equal(r.rows.find(s=>s.ticker==='2330').share,70);assert.equal(r.coveragePercent,92.5);assert.equal(r.repeated.length,2);assert.equal(r.status,'partial');assert.equal(r.gaps.filter(g=>g.amount!==null).reduce((n,g)=>n+g.amount,0),300);
});
test('duplicate input lots are one instrument, foreign code collision never merges',()=>{
 const d=instruments();d['0056'].stocks[0].securityId='OTHER:2330';
 const r=calculate([{ticker:'0050',amount:100},{ticker:'0050',amount:200},{ticker:'0056',amount:100}],d);
 assert.equal(r.rows.find(x=>x.securityId==='TW:2330').amount,180);assert.equal(r.rows.find(x=>x.securityId==='OTHER:2330').amount,60);
 assert.equal(r.rows.find(x=>x.securityId==='TW:2330').sources.length,1);
});
test('different verified dates remain explicit cross-date limitation',()=>{
 const d=instruments();d['0050'].holdingsDate='2026-10-16';d['0056'].holdingsDate='2026-10-19';
 assert(calculate([{ticker:'0050',amount:100},{ticker:'0056',amount:100}],d).gaps.some(g=>g.reason.includes('跨日期')));
});
test('unavailable or stale preserved data is excluded, not accepted by row presence',()=>{
 const d=instruments();d['0050'].status='unavailable';const r=calculate([{ticker:'0050',amount:100}],d);assert.equal(r.status,'unavailable');assert.equal(r.coveragePercent,0);
});
test('no source request on service creation; only selected unique instruments are fetched',async()=>{
 let calls=[];const opt=options(),service=createPortfolioMarket({...opt,fetchImpl:async(...args)=>{calls.push(args[0]);return opt.fetchImpl(...args);}});
 assert.equal(calls.length,0);const [a,b]=await Promise.all([service.get('0050'),service.get('0050')]);
 assert.equal(calls.length,2);assert.deepEqual(a,b);assert(calls.every(u=>u.includes('0050')));assert.equal(a.status,'observed');assert.equal((await service.get('0050')).status,'cached');assert.equal(calls.length,2);
});
test('cache survives restart; expiry and Taiwan calendar rollover trigger real recheck',async()=>{
 let clock=Date.parse('2026-10-19T15:59:00Z'),calls=0;const opt=options({now:()=>clock});const fetchImpl=async(...a)=>{calls++;return opt.fetchImpl(...a);};
 await createPortfolioMarket({...opt,fetchImpl}).get('0050');assert.equal(calls,2);
 const restarted=createPortfolioMarket({...opt,fetchImpl});assert.equal((await restarted.get('0050')).status,'cached');assert.equal(calls,2);
 clock+=2*60000;await restarted.get('0050');assert.equal(calls,4,'Taiwan midnight invalidates despite less than 5 minutes');
 clock+=6*60000;await restarted.get('0050');assert.equal(calls,6);
});
test('failed refresh preserves successful receipt but does not return it as current',async()=>{
 let clock=Date.parse('2026-10-19T12:00:00Z'),fail=false;const opt=options({now:()=>clock});
 const service=createPortfolioMarket({...opt,fetchImpl:async(...a)=>{if(fail)throw Error('official offline');return opt.fetchImpl(...a);}});
 const old=await service.get('0050');clock+=6*60000;fail=true;const next=await service.get('0050');
 assert.equal(next.status,'unavailable');assert.equal(next.previousObservedAt,old.observedAt);assert.equal(JSON.parse(fs.readFileSync(path.join(opt.cacheDir,'0050.json'))).data.observedAt,old.observedAt);
});
test('unsupported symbols and offline mode never cause hidden full-market refresh',async()=>{
 let calls=0;const service=createPortfolioMarket(options({fetchImpl:async()=>{calls++;throw Error('unexpected');}}));
 assert.equal((await service.get('00646')).status,'unsupported');assert.equal(calls,0);
 assert.equal((await createPortfolioMarket(options({allowNetwork:false})).get('0050')).status,'unavailable');
});
test('progress comes from settled selected instruments, invalid job inputs rejected',async()=>{
 const service=createPortfolioMarket(options());for(const input of [[],['../0050'],Array(21).fill('0050'),['0050',null]])assert.throws(()=>service.start(input),e=>e.statusCode===400);
 let job=service.start(['0050','0050','0056']);assert.equal(job.total,2);assert.equal(job.completed,0);
 for(let i=0;i<50&&job.status==='running';i++){await new Promise(r=>setTimeout(r,5));job=service.status(job.id);}
 assert.equal(job.completed,2);assert.equal(job.status,'finished');assert.equal(job.data['0050'].complete,false,'source done is not financial acceptance');assert.throws(()=>service.status('missing'),e=>e.statusCode===404);
});
test('stalled upstream terminates and does not block slots forever',async()=>{
 const service=createPortfolioMarket(options({deadlineMs:1100,fetchImpl:()=>new Promise(()=>{})}));
 const start=Date.now(),data=await service.get('0050');assert.equal(data.status,'unavailable');assert(Date.now()-start<1000);
 const next=await service.get('2330');assert.equal(next.status,'unavailable');assert.notEqual(next.status,'busy');
});
test('late completion after timeout cannot overwrite cache',async()=>{
 let resolve;const opt=options({deadlineMs:1050});const service=createPortfolioMarket({...opt,fetchImpl:()=>new Promise(r=>{resolve=r;})});
 await service.get('0050');resolve?.(new Response(html(fixture())));await new Promise(r=>setTimeout(r,20));assert.equal(fs.existsSync(path.join(opt.cacheDir,'0050.json')),false);
});
test('concurrent source slots bounded; abandoned jobs expire',async()=>{
 let clock=Date.parse('2026-10-19T12:00:00Z');const service=createPortfolioMarket(options({now:()=>clock,deadlineMs:1050,maxActive:1,fetchImpl:()=>new Promise(()=>{})}));
 const first=service.get('0050');assert.equal((await service.get('0056')).status,'busy');await first;
 const job=service.start(['00878']);clock+=11*60000;assert.throws(()=>service.status(job.id),e=>e.statusCode===404);
});
test('visible yield label distinguishes saved snapshot dates from newly checked overlap sources',()=>{
 const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
 const fn=app.slice(app.indexOf('function yieldText(holding)'),app.indexOf('function yieldCoverageNote'));
 const context={pct:n=>String(n),findEtf:()=>({})};require('node:vm').createContext(context);require('node:vm').runInContext(fn,context);
 const label=context.yieldText({yieldSource:'official_ttm',dividendYield:7.04,yieldAsOf:'2026-10-19',yieldPriceDate:'2026-10-16'});
 assert.match(label,/保存資料/);assert.match(label,/2026-10-19/);assert.match(label,/2026-10-16/);
});
