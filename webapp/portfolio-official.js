// Selected-fund adapters only. Never invoke the whole-market collectors here.
const recipes = [...require('./scripts/official-source-recipes.json').recipes,
  // Issuer product page /etf/product/detail/504/basic identifies 00415A.
  {id:'capital-basic-00415A',url:'https://www.capitalfund.com.tw/CFWeb/api/etf/basic/504'},
  {id:'capital-detail-00415A',url:'https://www.capitalfund.com.tw/CFWeb/api/etf/detail/504'},
  {id:'capital-portfolio-00415A',url:'https://www.capitalfund.com.tw/CFWeb/api/etf/buyback',method:'POST',body:{fundId:'504',date:null}}];
const scope = require('./portfolio-scope.json');
const u = require('./scripts/official-text');
const normalize = require('./scripts/issuer-reference');
const { normalizeAdditional } = require('./scripts/collect-additional-issuers');
const { firstgoldFunds } = require('./scripts/collect-more-issuers');
const { uniFunds } = require('./scripts/collect-session-issuers');
function scopeFor(ticker) { return scope.entries[ticker]?.scope || 'unverified'; }
function validStocks(groups) {
  const raw = groups.filter(g => g.type === 'stock').flatMap(g => g.items);
  const stocks = raw.map(r => ({code:String(r.code || '').trim().replace(/^(\d{4})\s+TT$/, '$1'), name:String(r.name || '').trim(), weight:r.weight, quantity:r.quantity}));
  if (!stocks.length || stocks.some(r => !/^\d{4}$/.test(r.code) || !r.name || typeof r.weight !== 'number' || !Number.isFinite(r.weight) || r.weight < 0 || r.weight > 100)
      || new Set(stocks.map(r=>r.code)).size !== stocks.length) throw Error('完整股票表格的識別、權重或重複列未通過核對');
  const total=stocks.reduce((s,r)=>s+r.weight,0);
  if(total<=0 || total>100) throw Error('股票權重總和異常');
  for(const g of groups.filter(g=>g.type==='stock')) if(g.summaryWeight!=null && Math.abs(g.items.reduce((s,r)=>s+r.weight,0)-g.summaryWeight)>g.items.length*0.005+0.000001) throw Error('股票權重與官方總計不一致');
  return stocks.map(r=>({...r,securityId:`TW:${r.code}`}));
}
function parseCtbcPage(html,ticker,asOf) {
  const text=u.text(html),tables=u.tables(html);
  if(text.match(/股票代號\s*[:：]\s*(\d{4,6}[A-Z]?)/)?.[1]!==ticker)throw Error('中信官方基金身份不一致');
  const assets=tables.find(t=>t[0]?.[0]==='基金資產'),kv=Object.fromEntries(assets||[]),d=u.date(kv['資料日期:']||kv['資料日期：']);
  if(!d||d>asOf)throw Error('中信基金資產日期未通過');
  const groups=tables.filter(t=>t[0]?.some(h=>/權重/.test(h))).map(t=>{
    const h=t[0],kind=h[0]==='股票代碼'?'stock':h[0]==='期貨代碼'?'future':'other';
    if(t.slice(1).some(r=>r.length!==h.length))throw Error('中信官方資產表含不完整列');
    return {type:kind,items:t.slice(1).map(r=>({code:r[0],name:r[1],quantity:u.number(r[2]),weight:u.number(r[h.findIndex(x=>/權重/.test(x))])}))};
  });
  const stocks=validStocks(groups),nav=u.number(Object.entries(kv).find(([k])=>/基金每單位淨值/.test(k))?.[1]);
  if(!(nav>0))throw Error('中信官方淨值未通過');
  // Futures notional, cash/margin and liabilities cannot be added as NAV weights.
  // Preserve their published values without inventing a 100% reconciliation.
  if(groups.flatMap(g=>g.items).some(r=>typeof r.weight!=='number'||!Number.isFinite(r.weight)||r.weight<0))throw Error('中信其他資產權重格式未通過');
  return {ticker,kind:'etf',name:scope.entries[ticker]?.name,identityVerified:true,stocks,stockWeight:stocks.reduce((s,r)=>s+r.weight,0),holdingsDate:d,holdingsDateEvidence:'official_fund_assets_section_date_and_full_stock_table',complete:false,nav:{date:d,value:nav},
    otherGroups:groups.filter(g=>g.type!=='stock').map(g=>({kind:g.type,rows:g.items.length,items:g.items})),issues:['股票以外資產未穿透至底層股票；已知股票資料不代表完整金融曝險']};
}
function parseJpmProduct(json,ticker,asOf) {
  const f=json?.fundData, sc=f?.shareClass, equity=f?.holdings?.pcfEquityHoldings;
  if(json.error || ticker!=='00401A' || sc?.cusip!=='TW00000401A1' || sc.exchangeTicker!==ticker || sc.currencyCode!=='TWD')throw Error('摩根官方基金身份未通過');
  const d=u.date(equity?.effectiveDate), latest=u.date(f.stringValueWrapper?.holdingLatestDate);
  if(!d || d!==latest || d>asOf || !Array.isArray(equity.data) || !equity.data.length)throw Error('摩根官方持股日期或完整股票表未通過');
  const aum=sc.netGrossAssetClass;
  if(typeof aum!=='number'||!Number.isFinite(aum)||aum<=0)throw Error('摩根官方基金資產總額未通過');
  const groups=[];
  for(const[key,type]of [['pcfEquityHoldings','stock'],['pcfBondHoldings','bond'],['pcfCashHoldings','cash'],['pcfFutureHoldings','future'],['pcfOptionsHoldings','option'],['pcfOthersHoldings','other']]){
    const g=f.holdings[key];if(g==null)continue;
    if(!Array.isArray(g.data)||u.date(g.effectiveDate)!==d)throw Error('摩根各資產表日期不一致');
    const items=g.data.map(r=>{
      const weight=r.marketValuePercent,value=r.marketValueBase;
      if(u.date(r.navDate)!==d||typeof weight!=='number'||!Number.isFinite(weight)||typeof value!=='number'||!Number.isFinite(value)||!r.securityDescription)throw Error('摩根資產列日期或數值未通過');
      if(Math.abs(value/aum*100-weight)>0.000051)throw Error('摩根權重與官方市值及基金資產總額不符');
      return {code:r.securityTicker||r.securityId,name:r.securityDescription,weight,quantity:r.shares,value};
    });groups.push({type,items});
  }
  const stocks=validStocks(groups);
  return {ticker,kind:'etf',name:sc.displayName,identityVerified:true,stocks,stockWeight:stocks.reduce((s,r)=>s+r.weight,0),holdingsDate:d,
    holdingsDateEvidence:'official_pcfEquityHoldings.effectiveDate_and_each_row.navDate_match_holdingLatestDate',complete:false,
    nav:u.date(sc.nav?.date)===d&&sc.nav.price>0?{date:d,value:sc.nav.price}:null,
    otherGroups:groups.filter(g=>g.type!=='stock').map(g=>({kind:g.type,rows:g.items.length,items:g.items})),
    issues:['股票以外資產未穿透至底層股票；賣出選擇權的負權重照官方資料保留，不代表完整金融曝險']};
}
function matchDatedStocks(expected, actual) {
  if(expected.length!==actual.length)throw Error('日期證據表與持股表筆數不一致');
  for(const row of expected){const other=actual.find(r=>r.code===row.code);
    if(!other||u.name(other.name)!==u.name(row.name)||Math.abs(other.weight-row.weight)>1e-9||other.quantity!==row.quantity)throw Error('日期證據表與持股表內容不一致');}
}
function kgiHoldingsDate(html,ticker,stocks,asOf) {
  if(!new RegExp('證券代號\\s*'+ticker+'(?:\\s|$)').test(u.text(html)))throw Error('凱基持股日期來源身份不一致');
  const start=html.indexOf('id="FundDetail-06"');if(start<0)throw Error('凱基完整持股日期區塊未取得');
  const end=html.indexOf('id="FundDetail-07"',start+1),section=html.slice(start,end<0?undefined:end);
  const d=u.date(section.match(/class="fund-asset__date"[^>]*>\s*\(([^)]+)\)/)?.[1]);
  if(!d||d>asOf||!u.text(section.slice(0,section.indexOf('<table'))).includes('持股比重'))throw Error('凱基持股日期未通過');
  const tables=u.tables(section).filter(t=>t[0]?.[0]==='股票代號'&&t[0]?.includes('股數')&&t[0]?.some(h=>/權重/.test(h)));
  if(!tables.length)throw Error('凱基日期區塊缺完整股票表');
  for(const t of tables){const h=t[0],wi=h.findIndex(x=>/權重/.test(x)),qi=h.indexOf('股數');if(t.slice(1).some(r=>r.length!==h.length))throw Error('凱基日期表有不完整列');
    matchDatedStocks(stocks,validStocks([{type:'stock',items:t.slice(1).map(r=>({code:r[0],name:r[1],quantity:u.number(r[qi]),weight:u.number(r[wi])}))}]));}
  return d;
}
function allianzHoldingsDate(json,fundId,stocks,asOf){
  const a=json?.Entries,d=u.date(a?.Data?.FundAsset?.NavDate);
  if(json?.StatusCode!==0||a?.FundID!==fundId||!d||d>asOf)throw Error('安聯完整資產日期或基金身份未通過');
  const groups=(a.Data.Table||[]).filter(t=>/^股票/.test(t.TableTitle||'')).map(t=>{const h=t.Columns.map(c=>c.Name),ci=h.indexOf('股票代號'),ni=h.indexOf('股票名稱'),qi=h.indexOf('股數'),wi=h.findIndex(x=>/權重/.test(x));
    if([ci,ni,qi,wi].some(i=>i<0)||t.Rows.some(r=>r.length!==h.length))throw Error('安聯日期證據表欄位不完整');
    return {type:'stock',items:t.Rows.map(r=>({code:r[ci],name:r[ni],quantity:u.number(r[qi]),weight:u.number(r[wi])}))};});
  matchDatedStocks(stocks,validStocks(groups));return d;
}
function hnHoldingsDate(json,ticker,fundId,stocks,asOf){
  const a=json?.Data,parts=a?.PartProduct,dates=[...new Set((parts||[]).map(p=>u.date(p.DataDate)))];
  if(a?.ETFID!==ticker||!fundId||a.FundID!==fundId||!parts?.some(p=>p.ProductTypeNM==='股票')||dates.length!==1||!dates[0]||dates[0]>asOf)throw Error('華南完整資產配置日期或基金身份未通過');
  matchDatedStocks(stocks,validStocks([{type:'stock',items:(a.StockList||[]).map(r=>({code:r.StockNo,name:r.StockName,quantity:u.number(r.Share),weight:r.Weight==null?null:u.number(r.Weight)*100}))}]));
  return dates[0];
}
function taishinProfile(html,ticker) {
  const table=typeof html==='string'&&u.tables(html).find(t=>t[0]?.[0]==='基金名稱');
  const fields=Object.fromEntries((table||[]).map(r=>[r[0],r[1]]));
  if(fields['股票代號']!==ticker||!fields['基金名稱']||!/新台幣|新臺幣|TWD/.test(fields['計價幣別']||''))throw Error('未取得身份相符的完整官方資產表');
  return fields;
}
function parseTaishinCurrent(profile,pcf,history,ticker,asOf) {
  const fields=taishinProfile(profile,ticker);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(asOf)||u.date(asOf)!==asOf)throw Error('台新查詢當日日期無效');
  const input=(html,id)=>{const tags=[...String(html).matchAll(/<input\b[^>]*>/gi)].map(m=>m[0]).filter(s=>new RegExp(`\\bid=["']${id}["']`,'i').test(s));
    if(tags.length!==1)throw Error('台新當日PCF身份或公告日期未通過');return u.decode(tags[0].match(/\bvalue=["']([^"']*)/i)?.[1]||'');};
  const heading=[...String(pcf).matchAll(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi)].map(m=>u.text(m[1]));
  if(input(pcf,'ETF_ID')!==ticker||input(pcf,'DATA_DATE')!==asOf||input(pcf,'PUB_DATE')!==asOf||!heading.some(s=>s.endsWith(`(${ticker})`)&&s.includes(fields['基金名稱'])))throw Error('台新當日PCF身份或公告日期未通過');
  // The separately published NAV series establishes the valuation date. Never
  // choose an older NAV because its value or closing prices fit a PCF better.
  const frame=String(history).match(/<iframe\b[^>]*\bsrc=["']([^"']+)/i)?.[1];
  let frameUrl;try{frameUrl=new URL(u.decode(frame||''),'https://www.tsit.com.tw');}catch{}
  const from=asOf.slice(0,7).replace('-','/')+'/01';
  if(!frameUrl||frameUrl.origin!=='https://www.tsit.com.tw'||frameUrl.pathname!==`/ETF/Home/TrendChartImage/${ticker}`||frameUrl.searchParams.get('sday')!==from||frameUrl.searchParams.get('eday')!==asOf.replaceAll('-','/'))throw Error('台新官方淨值查詢身份或日期範圍未通過');
  const navTables=u.tables(String(history)).filter(t=>t[0]?.[0]==='日期'&&t[0]?.[1]==='淨值');
  if(navTables.length!==1||navTables[0].length<2)throw Error('台新官方最新淨值日期尚未取得');
  const dates=new Set(),navs=navTables[0].slice(1).map(r=>{const date=u.date(r[0]),value=u.number(r[1]);
    if(r.length!==navTables[0][0].length||!date||date<asOf.slice(0,7)+'-01'||date>asOf||dates.has(date)||!(value>0))throw Error('台新官方淨值日期或資料列未通過');dates.add(date);return {date,value};});
  navs.sort((a,b)=>b.date.localeCompare(a.date));const latest=navs[0];
  const tables=u.tables(String(pcf)),assetTables=tables.filter(t=>t.some(r=>r[0]==='基金淨資產價值(元)'));
  if(assetTables.length!==1)throw Error('台新當日PCF淨資產表未通過');
  const asset=Object.fromEntries(assetTables[0].map(r=>[r[0],r[1]])),num=s=>u.number(String(s||'').replace(/^TWD\s*/,''));
  const aum=num(asset['基金淨資產價值(元)']),nav=num(asset['每受益權單位淨資產價值(元)']);
  if(!(aum>0)||!(nav>0)||nav!==latest.value)throw Error('台新當日PCF與最新官方淨值未一致');
  const stockTables=tables.filter(t=>t[0]?.[0]==='代號'&&t[0]?.[1]==='名稱'&&t[0]?.[2]==='股數'&&t[0]?.[3]==='持股權重');
  if(stockTables.length!==1)throw Error('台新當日PCF完整股票表未通過');
  const stocksTable=stockTables[0],totals=stocksTable.slice(1).filter(r=>/^(股票)?合計$/.test(r[0])),rows=stocksTable.slice(1).filter(r=>!/^(股票)?合計$/.test(r[0]));
  if(totals.length!==1||rows.some(r=>r.length!==4||u.number(r[2])==null||u.number(r[2])<0))throw Error('台新當日PCF股票列或總計未通過');
  const summaryWeight=u.number(totals[0].at(-1));
  if(summaryWeight==null)throw Error('台新當日PCF股票總計未通過');
  const stocks=validStocks([{type:'stock',summaryWeight,items:rows.map(r=>({code:r[0],name:r[1],quantity:u.number(r[2]),weight:u.number(r[3])}))}]);
  const otherGroups=tables.filter(t=>t[0]?.some(s=>/持股權重/.test(s))&&!stockTables.includes(t)).map(t=>({kind:t[0].some(s=>/契約年月/.test(s))?'future':'other',rows:t.length-1,items:t.slice(1).filter(r=>!/合計|總計/.test(r[0])).map(r=>({code:r[0],name:r[1]||r[0],quantity:u.number(r.at(-2)),weight:u.number(r.at(-1))}))}));
  return {ticker,kind:'etf',name:scope.entries[ticker]?.name||fields['基金名稱'],identityVerified:true,stocks,stockWeight:stocks.reduce((s,r)=>s+r.weight,0),holdingsDate:null,
    holdingsDateEvidence:'not_disclosed_current_official_PCF_and_latest_official_NAV_are_separate',complete:false,
    valuationBasis:{date:latest.date,netAssets:aum,method:'round4'},nav:latest,otherGroups,
    issues:['官方未明示實際持股基準日；當日申購買回清單與最新官方淨值已分別核對，仍須逐列估值核對','股票以外資產未穿透至底層股票；已知股票資料不代表完整金融曝險']};
}
async function loadOfficialOnce(ticker, {source, signal, asOf, etf}) {
  if(scopeFor(ticker)!=='domestic_equity') throw Error('尚未確認為支援的國內股票型 ETF');
  const entry=scope.entries[ticker], issuer=entry.issuer, values=new Map(), receipts=[], failures=[];
  const records=[];
  const jars=new Map();
  async function get(id,url,options={}) {
    if(signal.aborted) throw Error('官方資料核對已逾時');
    let body=options.body, headers={...options.headers};
    if(body && typeof body==='object'){body=JSON.stringify(body);headers['Content-Type']='application/json';}
    else if(body)headers['Content-Type']=String(body).startsWith('{')?'application/json':'application/x-www-form-urlencoded';
    const origin=new URL(url).origin, jar=jars.get(origin)||new Map();
    if(options.session && jar.size){headers.Cookie=[...jar].map(([k,v])=>`${k}=${v}`).join('; ');const xsrf=jar.get('X-XSRF-TOKEN')||jar.get('XSRF-TOKEN');if(xsrf)headers['X-XSRF-TOKEN']=decodeURIComponent(xsrf);}
    let result,currentUrl=url,method=options.method||'GET';
    for(let redirects=0;redirects<4;redirects++){
      if(options.session&&jar.size){headers.Cookie=[...jar].map(([k,v])=>`${k}=${v}`).join('; ');const xsrf=jar.get('X-XSRF-TOKEN')||jar.get('XSRF-TOKEN');if(xsrf)headers['X-XSRF-TOKEN']=decodeURIComponent(xsrf);}
      result=await source(currentUrl,signal,{method,body,headers,transient:options.transient,transientParams:options.transientParams,session:options.session});
      if(options.session){for(const c of result.headers?.getSetCookie?.()||[]){const pair=c.split(';')[0],i=pair.indexOf('=');if(i>0)jar.set(pair.slice(0,i),pair.slice(i+1));}jars.set(origin,jar);}
      if(!result.redirect)break;
      const next=new URL(result.redirect,currentUrl);if(next.origin!==origin)throw Error('官方公開工作階段轉向不同網站，停止核對');
      currentUrl=next.toString();if(result.status===303||[301,302].includes(result.status)&&method==='POST'){method='GET';body=undefined;}
    }
    if(result.redirect)throw Error('官方公開工作階段重新導向過多');
    let data;try{data=JSON.parse(result.text);}catch{data=result.text;}
    if(!options.transient){values.set(id,data);receipts.push(result.receipt);records.push({id,url,status:200,path:id,sha256:result.receipt.sha256});}
    return data;
  }
  const recipe=id=>{const r=recipes.find(r=>r.id===id);if(!r)throw Error('此基金的官方來源尚未建立');return {...r};};
  const run=async r=>get(r.id,r.url,{method:r.method,body:r.body});
  const runId=id=>run(recipe(id));
  const profileUrl=prefix=>etf?.profileEvidence?.find(r=>r.id.startsWith(prefix));
  if(/摩根/.test(issuer)&&ticker==='00401A') {
    const url='https://am.jpmorgan.com/FundsMarketingHandler/product-data?cusip=TW00000401A1&country=tw&role=twetf&language=zh&userLoggedIn=false';
    const json=await get('jpm-current-portfolio-'+ticker,url);
    return {...parseJpmProduct(json,ticker,asOf),sourceUrl:url,receipts};
  } else if(/國泰/.test(issuer)) {
    const [info,assets]=await Promise.all([runId('cathay-info-'+ticker),runId('cathay-assets-'+ticker)]);
    if(!info.success || info.result?.stockCode!==ticker || !assets.success || !u.date(assets.result?.preDate))throw Error('國泰基金身份或資產日期未通過');
    const d=u.date(assets.result.preDate);
    await Promise.all(['stock','bond','future','fund','etf','buy','option','bal'].map(async kind=>{
      const r=recipe(`cathay-${kind}-${ticker}`),url=new URL(r.url);url.searchParams.set('SearchDate',d);r.url=url.toString();
      try{const j=await run(r);if(kind==='stock'&&(!j.success||!Array.isArray(j.result)||!j.result.length))throw Error('國泰完整股票陣列未取得');if(!j.success)failures.push(`${kind} 官方類別回應尚待確認`);}catch(e){if(kind==='stock')throw e;failures.push(`${kind}：${e.message}`);}
    }));
  } else if(/復華/.test(issuer)) {
    const p=await runId('fhtrust-profile-'+ticker),r=recipe('fhtrust-assets-'+ticker),url=new URL(r.url);
    if(p?.result?.[0]?.etf002!==ticker||!u.date(p.result[0].navDate))throw Error('復華基金身份或日期未通過');
    url.searchParams.set('qDate',p.result[0].navDate);r.url=url.toString();await run(r);
  } else if(/群益/.test(issuer)) {
    await Promise.all(['basic','detail','portfolio'].map(k=>runId(`capital-${k}-${ticker}`)));
  } else if(/凱基/.test(issuer)) {
    await Promise.all(['detail','portfolio'].map(k=>runId(`kgi-${k}-${ticker}`)));
  } else if(/台新/.test(issuer)) {
    const profile=await runId('taishin-detail-'+ticker);
    taishinProfile(profile,ticker);
    // The public default product page can have DATA_DATE empty and NAV_DATE=0001.
    // Use the issuer's actual Pcf.js date selection for TODAY only, never scan
    // backwards until a historical portfolio happens to pass.
    const pcfUrl=`https://www.tsit.com.tw/ETF/Home/Pcf/${ticker}?FundType=ALL&DataDate=${asOf}`;
    const pcf=await get('taishin-current-pcf-'+ticker,pcfUrl);
    const nav=await get('taishin-current-nav-'+ticker,'https://www.tsit.com.tw/ETF/Home/PartialHistoryFundNav',{
      method:'POST',body:new URLSearchParams({equal:'0',id:ticker,sday:asOf.slice(0,7).replace('-','/')+'/01',eday:asOf.replaceAll('-','/')}).toString()
    });
    return {...parseTaishinCurrent(profile,pcf,nav,ticker,asOf),sourceUrl:pcfUrl,receipts};
  }
  else if(/玉山/.test(issuer)) await Promise.all(['profile','assets'].map(k=>runId(`esun-${k}-${ticker}`)));
  else if(/永豐/.test(issuer)) await get('sinopac-pcf-'+ticker,'https://sitc.sinopac.com/SinopacEtfs/Etfs/Pcf/'+ticker);
  else if(/野村/.test(issuer)) {
    const base='https://www.nomurafunds.com.tw/API/ETFAPI/api/Fund/';
    await Promise.all([get('nomura-profile-'+ticker,base+'GetFundDetailPage',{method:'POST',body:{FundNo:ticker,IsPreview:false,SearchType:1,Year:Number(asOf.slice(0,4)),SDate:asOf,EDate:asOf}}),get('nomura-assets-'+ticker,base+'GetFundAssets',{method:'POST',body:{FundID:ticker,SearchDate:null}})]);
  } else if(/兆豐/.test(issuer)) {
    const p=profileUrl('mega-detail-id-');if(!p||new URL(p.url).hostname!=='www.megafunds.com.tw')throw Error('兆豐基金官方對照尚未建立');await get(p.id,p.url);
  } else if(/第一金/.test(issuer)) {
    const page=await get('firstgold-catalog','https://www.fsitc.com.tw/FundDetail.aspx?ID=183'),f=firstgoldFunds(page).find(f=>f.cETFStockCode===ticker);
    if(!f)throw Error('第一金官方基金名單未找到此代號');
    await get('firstgold-assets-'+ticker,'https://www.fsitc.com.tw/WebAPI.aspx/Get_hd',{method:'POST',body:{pStrFundID:f.cNo,pStrDate:asOf.replaceAll('-','/')}});
  } else if(/聯邦/.test(issuer)) await get('usitc-pcf-'+ticker,'https://www.usitc.com.tw/CustCenter/BuyBackList',{method:'POST',body:new URLSearchParams({FundNo:ticker,sDate:asOf}).toString()});
  else if(/華美/.test(issuer)) {
    const base='https://www.ftft.com.tw/official/api/',list=await get('ftft-catalog',base+'etf/indicative-navs'),f=Array.isArray(list)&&list.find(f=>f.StockCode===ticker);
    if(!f)throw Error('華美官方基金名單未找到此代號');
    const id=await get('ftft-id-'+ticker,base+'newetf/Fund/GetFundId?FtftId='+encodeURIComponent(f.FundId));
    if(!id?.fundId)throw Error('華美基金識別未通過');
    const p=await get('ftft-profile-'+ticker,base+'newetf/Fund/Detail/'+encodeURIComponent(id.fundId));
    if(p?.code!==ticker)throw Error('華美基金身份不一致');
    await Promise.all([get('ftft-assets-'+ticker,base+'etf/shares/'+encodeURIComponent(f.FundId)+'?date='),get('ftft-basic-'+ticker,base+'newetf/Fund0/Detail/'+encodeURIComponent(p.fund0Id))]);
  } else if(/聯博/.test(issuer)) {
    const p=profileUrl('ab-profile-');if(!p||new URL(p.url).hostname!=='webapi.alliancebernstein.com')throw Error('聯博基金官方對照尚未建立');
    await Promise.all([get(p.id,p.url),get('ab-assets-'+ticker,p.url+'/holdings'),get('ab-basket-'+ticker,p.url+'/basket')]);
  } else if(/統一/.test(issuer)) {
    const page=await get('uni-pcf','https://www.ezmoney.com.tw/ETF/Transaction/PCF',{session:true}),f=uniFunds(page).find(f=>f.sStockNo?.trim()===ticker);
    if(!f)throw Error('統一官方基金名單未找到此代號');
    await get('uni-assets-'+ticker,'https://www.ezmoney.com.tw/ETF/Transaction/GetPCF',{session:true,method:'POST',body:{fundCode:f.sFundCode,date:(Number(asOf.slice(0,4))-1911)+asOf.slice(4).replaceAll('-','/'),specificDate:false}});
  } else if(/安聯/.test(issuer)) {
    const base='https://etf.allianzgi.com.tw/webapi/api/';
    await get('session',base+'AntiForgery/GetAntiForgeryToken',{session:true,transient:true});
    const list=await get('allianz-list',base+'Category/GetFundDropdownOptions',{session:true,method:'POST',body:{TypeID:-1,IsAddAllOption:false}}),f=list?.Entries?.find(f=>f.SecuritiesCode===ticker);
    if(!f)throw Error('安聯官方基金名單未找到此代號');
    await get('allianz-assets-'+ticker,base+'Fund/GetFundTradeInfo',{session:true,method:'POST',body:{Date:null,FundNo:f.FundNo}});
    await get('allianz-dated-assets-'+ticker,base+'Fund/GetFundAssets',{session:true,method:'POST',body:{FundID:f.FundNo}});
  } else if(/中信|中國信託/.test(issuer)) {
    const url='https://www.ctbcinvestments.com.tw/CTWEB/Content/ETF/pcd.aspx?ETF_ID='+ticker;
    const html=await get('ctbc-current-assets-'+ticker,url);
    return {...parseCtbcPage(html,ticker,asOf),sourceUrl:url,receipts};
  } else if(/大華銀/.test(issuer) && ticker==='00918') {
    // Verified public issuer page /fund/etf/88329556; response must also identify ticker.
    await get('uob-pcf-id-88329556','https://www.uobam.com.tw/json/reply/WebSitePcfRequest?fundID=88329556&pcfDate=');
  } else if(/華南永昌/.test(issuer)) {
    const base='https://www.hnfunds.com.tw/WEB_API/HN_OW_PROD/',headers={Client_Id:'WFPAPIPublicClient','Accept-Language':'zh-TW','X-Origin-Time':new Date().toISOString()};
    const auth=await get('session',base+'Auth/SysLogin',{method:'POST',headers,transient:true});
    if(!auth?.access_token)throw Error('華南官方公開工作階段暫不可用');
    await get('hn-assets-'+ticker,base+'ETF/BuyBack',{method:'POST',headers:{...headers,Authorization:'Bearer '+auth.access_token},body:{ETFID:ticker,DataDate:''}});
    await get('hn-dated-assets-'+ticker,base+'ETF/FundDtl/AssetSet/'+ticker,{headers:{...headers,Authorization:'Bearer '+auth.access_token}});
  } else throw Error('此國內股票型 ETF 的官方來源尚待接入；不會使用推估持股');
  const client={read:id=>values.get(id)||null,records:()=>records};
  const reference=normalize({population:[{stockNo:ticker,stockName:entry.name,issuer,market:entry.market}],read:client.read,receipts:records,asOf});
  const ref=normalizeAdditional(reference,client).items[0], a=ref?.assetSnapshot;
  if(!a)throw Error('未取得身份相符的完整官方資產表');
  const stocks=validStocks(a.groups||[]);let holdingsDate=a.dateVerifiedForGroups?u.date(a.date):null,holdingsDateEvidence=holdingsDate?a.dateBasis||a.coverage:null;
  if(/凱基/.test(issuer)){
    holdingsDate=kgiHoldingsDate(values.get('kgi-detail-'+ticker),ticker,stocks,asOf);
    if(holdingsDate!==u.date(a.navDate))throw Error('凱基持股比重日期與本次資產表日期不同');
    holdingsDateEvidence='official_FundDetail_06_持股比重_date_and_every_stock_row_matches_PCF';
  }else if(/安聯/.test(issuer)){
    const fund=values.get('allianz-list')?.Entries?.find(f=>f.SecuritiesCode===ticker);
    holdingsDate=allianzHoldingsDate(values.get('allianz-dated-assets-'+ticker),fund?.FundNo,stocks,asOf);
    if(holdingsDate!==u.date(a.navDate))throw Error('安聯持股資料日期與本次資產表日期不同');
    holdingsDateEvidence='official_GetFundAssets_visible_資料日期_and_every_stock_row_matches_TradeInfo';
  }else if(/華南永昌/.test(issuer)){
    holdingsDate=hnHoldingsDate(values.get('hn-dated-assets-'+ticker),ticker,values.get('hn-assets-'+ticker)?.Data?.FundID,stocks,asOf);
    if(holdingsDate!==u.date(a.navDate))throw Error('華南持股資產配置日期與本次資產表日期不同');
    holdingsDateEvidence='official_AssetSet_PartProduct.DataDate_and_every_stock_row_matches_BuyBack';
  }
  if(holdingsDate>asOf || (a.navDate && u.date(a.navDate)>asOf))throw Error('官方資料日期超出當日');
  const sourceRef=ref.sourceRefs.find(s=>/assets|portfolio|pcf|mega-detail|taishin-detail/.test(s.id)), sourceUrl=records.find(r=>r.id===sourceRef?.id)?.url||receipts.at(-1)?.url;
  return {ticker,kind:'etf',name:entry.name,identityVerified:true,stocks,stockWeight:stocks.reduce((s,r)=>s+r.weight,0),holdingsDate,
    holdingsDateEvidence,complete:false,sourceUrl,receipts,
    ...(/群益|台新/.test(issuer)?{valuationBasis:{date:u.date(a.navDate),netAssets:a.aum,method:require('./portfolio-valuation').METHODS[ticker]}}:{}),
    nav:a.nav>0&&u.date(a.navDate)?{value:a.nav,date:u.date(a.navDate)}:null,
    otherGroups:(a.groups||[]).filter(g=>g.type!=='stock').map(g=>({kind:g.type,rows:g.items.length,items:g.items.map(r=>({code:r.code,name:r.name,weight:r.weight,quantity:r.quantity}))})),
    issues:[...(!holdingsDate?['官方未明示可獨立核對的持股日期；公告日或淨值日不當成持股日']:[]),...failures,'股票以外資產未穿透至底層股票；已知股票資料不代表完整金融曝險']};
}
const capitalRead=require('./portfolio-public-read').createPublicReadQueue();
let taishinTail=Promise.resolve(),taishinPending=0,taishinLastRead=0;
async function withTaishinTurn(signal,task){
  if(signal.aborted)throw Error('官方資料核對已逾時');
  if(taishinPending>=32)throw Error('官方來源核對佇列已滿，請稍後重試');
  taishinPending++;const previous=taishinTail;let release,onAbort;
  const ticket=new Promise(resolve=>{release=resolve;});taishinTail=previous.then(()=>ticket);
  try{
    await Promise.race([previous,new Promise((_,reject)=>{onAbort=()=>reject(Error('官方資料核對已逾時'));signal.addEventListener('abort',onAbort,{once:true});})]);
    if(signal.aborted)throw Error('官方資料核對已逾時');return await task();
  }finally{signal.removeEventListener('abort',onAbort);taishinPending--;release();}
}
async function loadOfficial(ticker,options){
  if(/群益/.test(scope.entries[ticker]?.issuer||''))return loadOfficialOnce(ticker,{...options,
    source:(url,signal,request)=>capitalRead(()=>options.source(url,signal,request),signal)});
  if(!/台新/.test(scope.entries[ticker]?.issuer||''))return loadOfficialOnce(ticker,options);
  return withTaishinTurn(options.signal,async()=>{
  let blocked=false;
  const source=async(...args)=>{
    const pause=400-(Date.now()-taishinLastRead);
    if(pause>0)await new Promise(resolve=>setTimeout(resolve,pause));
    if(options.signal.aborted)throw Error('官方資料核對已逾時');
    taishinLastRead=Date.now();
    const result=await options.source(...args),html=result.text||'';
    blocked=/captcha|cf-chl-|access denied|request rejected|機器人驗證|存取遭拒|unauthorized|forbidden|permission denied/i.test(html);
    // ASP.NET can return its generic temporary error template with HTTP200.
    // Do not classify a wrong fund, empty portfolio, denial or challenge as it.
    if(!blocked&&Buffer.byteLength(html)<2048&&/^\s*Error\s*$/i.test(u.text(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]||''))&&/an error occurred while processing your request/i.test(u.text(html)))throw Error('台新官方暫時錯誤頁');
    return result;
  };
  for(let attempt=0;attempt<2;attempt++){
    try{
      const data=await loadOfficialOnce(ticker,{...options,source});
      if(attempt){data.officialAttempts=2;data.issues.unshift('官方來源首次讀取未通過；已重新讀取並通過本次身份與完整股票表核對');}
      return data;
    }catch(error){
      const retryable=/timeout|timed out|aborted|fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|UND_ERR_|HTTP 50[234]|^未取得身份相符的完整官方資產表$|^台新官方暫時錯誤頁$/i.test(error.message||'');
      // One identical public read only. Never retry access denial, a challenge, malformed weights or an expired customer job.
      if(attempt||blocked||options.signal.aborted||!retryable)throw error;
      await new Promise(resolve=>setTimeout(resolve,250));
      if(options.signal.aborted)throw error;
    }
  }
  });
}
module.exports={loadOfficial,scopeFor,validStocks,parseCtbcPage,parseJpmProduct,kgiHoldingsDate,allianzHoldingsDate,hnHoldingsDate,parseTaishinCurrent};
