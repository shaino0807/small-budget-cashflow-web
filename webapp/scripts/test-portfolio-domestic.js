const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {scopeFor,loadOfficial,validStocks,parseCtbcPage,parseJpmProduct,kgiHoldingsDate,allianzHoldingsDate,hnHoldingsDate,parseTaishinCurrent}=require('../portfolio-official');
const {createPortfolioMarket}=require('../portfolio-market');
const {calculate}=require('../portfolio-overlap');
const scope=require('../portfolio-scope.json');
const temporary=[];
function cache(){const d=fs.mkdtempSync(path.join(os.tmpdir(),'portfolio-domestic-'));temporary.push(d);return d;}
test.after(()=>temporary.forEach(d=>fs.rmSync(d,{recursive:true,force:true})));
const syntheticCtbc=()=>'<table><tr><td>測試基金(股票代號 : 00891)</td></tr></table><table><tr><td>基金資產</td></tr><tr><td>資料日期:</td><td>2026/10/22</td></tr><tr><td>基金每單位淨值( 台幣 )</td><td>34.30</td></tr></table><table><tr><th>股票代碼</th><th>股票名稱</th><th>股數</th><th>權重(%)</th></tr><tr><td>2330</td><td>合成公司</td><td>1000</td><td>60</td></tr><tr><td>6488</td><td>合成上櫃公司</td><td>2000</td><td>38</td></tr></table><table><tr><th>期貨代碼</th><th>期貨名稱</th><th>口數</th><th>權重(%)</th></tr><tr><td>TX</td><td>合成期貨</td><td>1</td><td>5</td></tr></table>';
function syntheticJpm(){
  const row=(code,name,weight)=>({securityTicker:code,securityDescription:name,marketValuePercent:weight,marketValueBase:weight*10000,shares:1000,navDate:'2026-10-22'});
  return {error:null,fundData:{shareClass:{cusip:'TW00000401A1',exchangeTicker:'00401A',currencyCode:'TWD',displayName:'合成測試基金',netGrossAssetClass:1000000,nav:{date:'2026-10-22',price:10}},stringValueWrapper:{holdingLatestDate:'2026-10-22'},holdings:{pcfEquityHoldings:{effectiveDate:'2026-10-22',data:[row('2330','合成股票',95)]},pcfOptionsHoldings:{effectiveDate:'2026-10-22',data:[row('TXO','合成賣出選擇權',-1)]},pcfCashHoldings:{effectiveDate:'2026-10-22',data:[row('TWD','合成現金',6)]}}}};
}
test('JPM portfolio binds selected identity, position and row dates, NAV denominator and signed derivatives',()=>{
  const d=parseJpmProduct(syntheticJpm(),'00401A','2026-10-23');assert.equal(d.holdingsDate,'2026-10-22');assert.equal(d.stocks.length,1);assert.equal(d.otherGroups.find(g=>g.kind==='option').items[0].weight,-1);assert.equal(d.complete,false);
  for(const mutate of [j=>j.fundData.shareClass.cusip='WRONG',j=>j.fundData.holdings.pcfEquityHoldings.effectiveDate='2026-10-24',j=>j.fundData.holdings.pcfEquityHoldings.data=[],j=>j.fundData.holdings.pcfEquityHoldings.data[0].navDate='2026-10-21',j=>j.fundData.holdings.pcfEquityHoldings.data[0].marketValuePercent=null,j=>j.fundData.holdings.pcfEquityHoldings.data[0].marketValueBase=1,j=>j.fundData.holdings.pcfCashHoldings.effectiveDate='2026-10-21']){const j=syntheticJpm();mutate(j);assert.throws(()=>parseJpmProduct(j,'00401A','2026-10-23'));}
});
test('JPM selected-fund lookup uses official actual holdings, never forward-looking valuation XLSX',async()=>{
  const urls=[],d=await loadOfficial('00401A',{signal:new AbortController().signal,asOf:'2026-10-23',source:async url=>{urls.push(url);return {text:JSON.stringify(syntheticJpm()),receipt:{url,sha256:'synthetic'}};}});
  assert.equal(d.stocks.length,1);assert.equal(urls.length,1);assert(urls[0].includes('product-data?cusip=TW00000401A1'));assert(!urls.some(u=>u.includes('xlsx')));
});
test('issuer intermediate chains to existing roots and transport rejects insecure or credentialed requests',async()=>{
  const {officialFetch,getIssuerAgent}=require('../portfolio-transport');assert.equal(getIssuerAgent().options.rejectUnauthorized,true);
  for(const[url,options]of [['http://www.uobam.com.tw/',{}],['https://www.uobam.com.tw:444/',{}],['https://www.uobam.com.tw/',{headers:{Cookie:'synthetic'}}],['https://www.uobam.com.tw/',{method:'POST',body:'synthetic'}]])await assert.rejects(officialFetch(url,options));
});
test('KGI dates require a matching complete dated holdings section, never a NAV date alone',()=>{
  const rows=[{code:'2330',name:'合成股票',quantity:1000,weight:95}], html='<p>證券代號 00915</p><div id="FundDetail-06"><h4>持股比重</h4><p class="fund-asset__date">(2026/10/22)</p><table><tr><th>股票代號</th><th>股票名稱</th><th>股數</th><th>權重(%)</th></tr><tr><td>2330</td><td>合成股票</td><td>1000</td><td>95</td></tr></table></div><div id="FundDetail-07">';
  assert.equal(kgiHoldingsDate(html,'00915',rows,'2026-10-23'),'2026-10-22');
  for(const bad of [html.replace('證券代號 00915','證券代號 00919'),html.replace('fund-asset__date','nav-date'),html.replace('2026/10/22','2026/10/24'),html.replace('<td>95</td>','<td>94</td>'),html.replace('<td>1000</td>','<td>100</td>')])assert.throws(()=>kgiHoldingsDate(bad,'00915',rows,'2026-10-23'));
});
test('Allianz full asset dates bind fund identity and every stock row to trade information',()=>{
  const rows=[{code:'2330',name:'合成股票',quantity:1000,weight:95}], data={StatusCode:0,Entries:{FundID:'SYNTHETIC',Data:{FundAsset:{NavDate:'2026/10/22'},Table:[{TableTitle:'股票 (95%)',Columns:['股票代號','股票名稱','股數','權重(%)'].map(Name=>({Name})),Rows:[['2330','合成股票','1000','95%']]}]}}};
  assert.equal(allianzHoldingsDate(data,'SYNTHETIC',rows,'2026-10-23'),'2026-10-22');
  assert.throws(()=>allianzHoldingsDate(data,'OTHER',rows,'2026-10-23'));assert.throws(()=>allianzHoldingsDate(data,'SYNTHETIC',[{...rows[0],weight:94}],'2026-10-23'));
  data.Entries.Data.FundAsset.NavDate=null;assert.throws(()=>allianzHoldingsDate(data,'SYNTHETIC',rows,'2026-10-23'));
});
test('HN dates come from matching complete asset configuration, rejecting mixed group dates and mismatched quantities',()=>{
  const rows=[{code:'2330',name:'合成股票',quantity:1000,weight:95}], data={Data:{ETFID:'009808',FundID:'SYNTHETIC',PartProduct:[{ProductTypeNM:'股票',DataDate:'2026-10-22'},{ProductTypeNM:'期貨',DataDate:'2026-10-22'}],StockList:[{StockNo:'2330',StockName:'合成股票',Share:1000,Weight:0.95}]}};
  assert.equal(hnHoldingsDate(data,'009808','SYNTHETIC',rows,'2026-10-23'),'2026-10-22');assert.throws(()=>hnHoldingsDate(data,'009808','OTHER',rows,'2026-10-23'));assert.throws(()=>hnHoldingsDate(data,'009808','SYNTHETIC',[{...rows[0],quantity:100}],'2026-10-23'));
  data.Data.PartProduct[1].DataDate='2026-10-21';assert.throws(()=>hnHoldingsDate(data,'009808','SYNTHETIC',rows,'2026-10-23'));
});
test('official scope includes domestic active funds and excludes foreign name-keyword false positive',()=>{
  for(const t of ['00400A','00408A','0050','006201','00888','00928'])assert.equal(scopeFor(t),'domestic_equity');
  for(const t of ['009818','00646','00631L','00632R','00679B'])assert.equal(scopeFor(t),'outside_scope');
  assert.equal(scopeFor('099999'),'unverified');
});
test('domestic identifiers normalise explicit Taiwan suffix, never foreign suffixes or duplicate securities',()=>{
  const rows=validStocks([{type:'stock',items:[{code:'2330 TT',name:'合成',weight:60}]}]);assert.equal(rows[0].securityId,'TW:2330');
  for(const items of [[{code:'2330 US',name:'x',weight:1}],[{code:'2330',name:'x',weight:null}],[{code:'2330',name:'x',weight:101}],[{code:'2330',name:'x',weight:1},{code:'2330 TT',name:'x',weight:1}]])assert.throws(()=>validStocks([{type:'stock',items}]));
});
test('CTBC current page binds ticker, dated full stock rows and preserves futures without false NAV sum',()=>{
  const d=parseCtbcPage(syntheticCtbc(),'00891','2026-10-23');assert.equal(d.stocks.length,2);assert.equal(d.holdingsDate,'2026-10-22');assert.equal(d.stockWeight,98);assert.equal(d.complete,false);assert.equal(d.otherGroups[0].items[0].weight,5);
  assert.throws(()=>parseCtbcPage(syntheticCtbc(),'00928','2026-10-23'),/身份/);
  assert.throws(()=>parseCtbcPage(syntheticCtbc().replace('資料日期:','公告日:'),'00891','2026-10-23'),/日期/);
  assert.throws(()=>parseCtbcPage(syntheticCtbc().replace('2026/10/22','2026/10/24'),'00891','2026-10-23'),/日期/);
  assert.throws(()=>parseCtbcPage(syntheticCtbc().replace('<td>38</td>',''),'00891','2026-10-23'),/不完整列/);
});
function cathaySource(calls,{wrongIdentity=false,missingStocks=false}={}){return async url=>{
  calls.push(url);let result;
  if(url.includes('GetETFInfoMain'))result={stockCode:wrongIdentity?'0050':'00878',fundName:'合成國泰',currency:'新台幣'};
  else if(url.includes('GetETFAssets'))result={preDate:'2026/10/22',fundPerNav:'35.2'};
  else if(url.includes('GetETFDetailStockList'))result=missingStocks?[]:[{stockCode:'2330',stockName:'合成公司',volumn:'1000',weights:'97.5'}];
  else result=[];
  return {text:JSON.stringify({success:true,returnCode:'2000',result}),receipt:{url,sha256:'synthetic',observedAt:'2026-10-23T00:00:00Z'}};
};}
test('Cathay first-use asks only selected fund, with actual asset date on every detail query',async()=>{
  const calls=[],d=await loadOfficial('00878',{source:cathaySource(calls),signal:new AbortController().signal,asOf:'2026-10-23'});
  assert.equal(d.stocks.length,1);assert.equal(d.holdingsDate,'2026-10-22');assert.equal(d.complete,false);
  assert(calls.every(url=>new URL(url).searchParams.get('FundCode')==='CN'));
  assert(calls.filter(url=>/Detail|Option/.test(url)).every(url=>new URL(url).searchParams.get('SearchDate')==='2026-10-22'));
});
test('Cathay conflicting identity or empty full stocks are never successful zero-overlap results',async()=>{
  for(const options of [{wrongIdentity:true},{missingStocks:true}])await assert.rejects(loadOfficial('00878',{source:cathaySource([],options),signal:new AbortController().signal,asOf:'2026-10-23'}));
});
test('outside scope and unknown code are distinguishable, with no market refresh',async()=>{
  let calls=0;const s=createPortfolioMarket({cacheDir:cache(),allowNetwork:true,fetchImpl:async()=>{calls++;throw Error('unexpected');}});
  const out=await s.get('009818'),unknown=await s.get('099999');assert.equal(out.status,'unsupported');assert.match(out.message,/海外/);assert.equal(unknown.status,'unavailable');assert.equal(calls,0);
  assert.equal(calculate([{ticker:'099999',amount:1000}],{'099999':unknown}).status,'unavailable');
});
test('five selected domestic funds are queued, rather than falsely rejecting the fifth as busy',async()=>{
  const s=createPortfolioMarket({cacheDir:cache(),allowNetwork:true,fetchImpl:async url=>{await new Promise(r=>setTimeout(r,8));throw Error('synthetic source outage');}});
  const j=s.start(['0050','0051','0053','0055','0056']);let done;
  for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,5));done=s.status(j.id);if(done.status!=='running')break;}
  assert.equal(done.completed,5);assert.equal(done.status,'partial');assert(Object.values(done.data).every(d=>d.status==='unavailable'));
});
test('source storage refuses excess capacity and does not corrupt current result or customer files',async()=>{
  const d=cache();fs.writeFileSync(path.join(d,'customer-sentinel'),'keep');
  const s=createPortfolioMarket({cacheDir:d,allowNetwork:true,maxSourceBytes:10,fetchImpl:async url=>new Response(url.includes('pcd.aspx')?syntheticCtbc():JSON.stringify({stat:'OK',title:'115年10月 00891 測試',fields:['日期','收盤價'],data:[['115/10/22','34']]}))});
  const data=await s.get('00891');assert.equal(data.status,'observed');assert(data.receipts.every(r=>r.persistence==='unavailable'));assert.equal(fs.readFileSync(path.join(d,'customer-sentinel'),'utf8'),'keep');assert(!fs.readdirSync(path.join(d,'sources')).some(f=>f.endsWith('.raw')));
});
test('reusable official cache persists for domestic adapters and exposes no raw form state',async()=>{
  const d=cache();let calls=0;const opts={cacheDir:d,allowNetwork:true,fetchImpl:async url=>{calls++;return new Response(url.includes('pcd.aspx')?syntheticCtbc()+'<input name="__VIEWSTATE" value="PRIVATE_FORM_STATE" />':JSON.stringify({stat:'OK',title:'115年10月 00891 測試',fields:['日期','收盤價'],data:[['115/10/22','34']]}));}};
  const first=await createPortfolioMarket(opts).get('00891');assert.equal(first.status,'observed');assert.equal(calls,2);assert.equal((await createPortfolioMarket(opts).get('00891')).status,'cached');assert.equal(calls,2);
  for(const f of fs.readdirSync(path.join(d,'sources')))assert(!fs.readFileSync(path.join(d,'sources',f),'utf8').includes('PRIVATE_FORM_STATE'));
});
test('oversized or credential-bearing official JSON fails closed and is not persisted',async()=>{
  for(const body of [JSON.stringify({access_token:'SYNTHETIC_SECRET'}),'x'.repeat(6000001)]){
    const d=cache(),s=createPortfolioMarket({cacheDir:d,allowNetwork:true,fetchImpl:async()=>new Response(body)}),r=await s.get('00878');assert.equal(r.status,'unavailable');assert(!fs.existsSync(path.join(d,'00878.json')));
  }
});
test('atomic persistence failure leaves no temporary-file buildup',async()=>{
  const d=cache(),original=fs.renameSync;fs.renameSync=()=>{throw Error('synthetic rename failure');};
  try{const s=createPortfolioMarket({cacheDir:d,allowNetwork:true,fetchImpl:async url=>new Response(url.includes('pcd.aspx')?syntheticCtbc():JSON.stringify({stat:'OK',title:'115年10月 00891 測試',fields:['日期','收盤價'],data:[['115/10/22','34']]}))}),r=await s.get('00891');assert.equal(r.status,'observed');assert.equal(r.cacheWarning,'persistent_cache_unavailable');for(const folder of [d,path.join(d,'sources')])assert(!fs.readdirSync(folder).some(f=>f.endsWith('.tmp')));}finally{fs.renameSync=original;}
});
function syntheticTaishin(){return '<title>合成測試</title><input id="NAV_DATE" value="0001/1/1"><input id="DATA_DATE" value="2026-10-23"><input id="PUB_DATE" value="2026-10-23"><input id="ETF_ID" value="00936"><h4>合成台新基金 (00936)</h4><table><tr><td>基金名稱</td><td>合成台新基金</td></tr><tr><td>股票代號</td><td>00936</td></tr><tr><td>計價幣別</td><td>新台幣</td></tr><tr><td>基金淨資產價值(元)</td><td>TWD 1,000,000</td></tr><tr><td>每受益權單位淨資產價值(元)</td><td>TWD 10</td></tr></table><table><tr><th>代號</th><th>名稱</th><th>股數</th><th>持股權重</th></tr><tr><td>2330 TT</td><td>合成股票</td><td>1000</td><td>90</td></tr><tr><td>股票合計</td><td>90</td></tr></table><iframe src="/ETF/Home/TrendChartImage/00936?equal=0&amp;sday=2026%2F10%2F01&amp;eday=2026%2F10%2F23"></iframe><table><tr><th>日期</th><th>淨值</th><th>市價</th><th>折溢價幅度</th></tr><tr><td>2026-10-22</td><td>10</td><td>10</td><td>0</td></tr></table>';}
test('Taishin transient timeout or temporarily incomplete public response retries once without weakening identity or dates',async()=>{
 for(const first of [()=>{throw Error('fetch failed')},()=>({text:'<title>資料暫時更新中</title>',receipt:{url:'https://www.tsit.com.tw/synthetic',sha256:'synthetic'}})]){let calls=0;const d=await loadOfficial('00936',{asOf:'2026-10-23',signal:new AbortController().signal,source:async url=>{calls++;if(calls===1)return first();return {text:syntheticTaishin(),receipt:{url,sha256:'synthetic'}};}});assert.equal(calls,4);assert.equal(d.officialAttempts,2);assert.equal(d.holdingsDate,null);assert.equal(d.valuationBasis.date,'2026-10-22');assert.equal(d.stocks.length,1);}
});
test('Taishin retry is bounded and never retries access denials, challenges, malformed weights or aborted jobs',async()=>{
 for(const {body,error,aborted,max} of [{error:'官方來源 HTTP 403',max:1},{body:'<title>Access denied</title>',max:1},{body:'<title>captcha</title>',max:1},{body:syntheticTaishin().replace('<td>90</td>','<td>101</td>'),max:3},{error:'fetch failed',aborted:true,max:0},{error:'fetch failed',max:2}]){let calls=0;const controller=new AbortController();if(aborted)controller.abort();await assert.rejects(loadOfficial('00936',{asOf:'2026-10-23',signal:controller.signal,source:async url=>{calls++;if(error)throw Error(error);return {text:body,receipt:{url,sha256:'synthetic'}};}}));assert.equal(calls,max);}
});
test('Taishin public source reads are serialized across selected funds without changing the data checks',async()=>{
 let active=0,peak=0,calls=0;await Promise.all(Array.from({length:3},()=>loadOfficial('00936',{asOf:'2026-10-23',signal:new AbortController().signal,source:async url=>{calls++;active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,15));active--;return {text:syntheticTaishin(),receipt:{url,sha256:'synthetic'}};}})));assert.equal(calls,9);assert.equal(peak,1);
});
test('an aborted queued Taishin job performs no source read and does not block later jobs',async()=>{
 let calls=0,release;const gate=new Promise(r=>release=r),controller=new AbortController();const source=async url=>{calls++;if(calls===1)await gate;return {text:syntheticTaishin(),receipt:{url,sha256:'synthetic'}};};const first=loadOfficial('00936',{asOf:'2026-10-23',signal:new AbortController().signal,source});while(!calls)await new Promise(r=>setTimeout(r,1));const second=loadOfficial('00936',{asOf:'2026-10-23',signal:controller.signal,source});controller.abort();await assert.rejects(second,/逾時/);assert.equal(calls,1);release();await first;await loadOfficial('00936',{asOf:'2026-10-23',signal:new AbortController().signal,source});assert.equal(calls,6);
});

test('Taishin current-date PCF uses separately published latest NAV, keeps actual holdings date undisclosed',()=>{
 const html=syntheticTaishin(),d=parseTaishinCurrent(html,html,html,'00936','2026-10-23');
 assert.equal(d.holdingsDate,null);assert.equal(d.nav.date,'2026-10-22');assert.equal(d.nav.value,10);assert.equal(d.valuationBasis.netAssets,1000000);assert.equal(d.stocks[0].securityId,'TW:2330');assert.equal(d.complete,false);
});
test('Taishin never backdates PCF or selects an older NAV to make weights fit',()=>{
 const h=syntheticTaishin();
 for(const pcf of [h.replace('id="DATA_DATE" value="2026-10-23"','id="DATA_DATE" value="2026-10-22"'),h.replace('id="PUB_DATE" value="2026-10-23"','id="PUB_DATE" value="2026-10-24"')])assert.throws(()=>parseTaishinCurrent(h,pcf,h,'00936','2026-10-23'));
 const latest=h.replace('<td>2026-10-22</td>','<td>2026-10-23</td>').replace('<td>10</td><td>10</td>','<td>11</td><td>11</td>');
 assert.throws(()=>parseTaishinCurrent(h,h,latest,'00936','2026-10-23'),/最新官方淨值/);
 assert.throws(()=>parseTaishinCurrent(h,h,h.replace('<td>2026-10-22</td>','<td>2026-10-24</td>'),'00936','2026-10-23'),/日期或資料列/);
});
test('Taishin wrong fund, query range, empty rows, duplicate stocks and invalid totals fail closed',()=>{
 const h=syntheticTaishin();
 for(const pcf of [h.replace('id="ETF_ID" value="00936"','id="ETF_ID" value="00904"'),h.replace('<h4>合成台新基金 (00936)</h4>','<h4>其他基金 (00936)</h4>'),h.replace('<td>2330 TT</td><td>合成股票</td><td>1000</td><td>90</td>',''),h.replace('<td>股票合計</td><td>90</td>','<td>股票合計</td><td>80</td>'),h.replace('<td>1000</td>','<td></td>'),h.replace('<tr><td>股票合計','<tr><td>2330 TT</td><td>重複</td><td>1000</td><td>1</td></tr><tr><td>股票合計')])assert.throws(()=>parseTaishinCurrent(h,pcf,h,'00936','2026-10-23'));
 assert.throws(()=>parseTaishinCurrent(h,h,h.replace('TrendChartImage/00936','TrendChartImage/00904'),'00936','2026-10-23'));
 assert.throws(()=>parseTaishinCurrent(h,h,h.replace('2026%2F10%2F23','2026%2F10%2F22'),'00936','2026-10-23'));
});
test('Taishin actual source requests query TODAY only and bind latest NAV history to the same fund',async()=>{
 const requests=[];await loadOfficial('00936',{asOf:'2026-10-23',signal:new AbortController().signal,source:async(url,signal,options)=>{requests.push({url,options});return {text:syntheticTaishin(),receipt:{url,sha256:'synthetic'}};}});
 assert.equal(requests.length,3);assert.match(requests[1].url,/Pcf\/00936\?FundType=ALL&DataDate=2026-10-23$/);assert.equal(requests[2].options.method,'POST');assert.equal(new URLSearchParams(requests[2].options.body).get('eday'),'2026/10/23');assert.equal(new URLSearchParams(requests[2].options.body).get('id'),'00936');
});
