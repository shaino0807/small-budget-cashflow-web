// Public instrument evidence only: no portfolio amounts, member IDs or financial records.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { extractNuxtState } = require('./scripts/update-issuer-official-data');
const { loadOfficial, scopeFor } = require('./portfolio-official');
const scope = require('./portfolio-scope.json');
const { containsCredentials, redactFormState } = require('./scripts/official-source-client');
const VERSION = 7, TTL = 5 * 60000, JOB_TTL = 10 * 60000;
// Temporary availability policy approved on 2026-10-23; scope membership is unchanged.
// Apply before cache reads so old holdings cannot bypass the pending state.
const PENDING_FUNDS = new Set(['00904','00936','00947','00962','00987A']);
const pendingFund = ticker => ({ticker,status:'unavailable',reasonCode:'fund_data_pending_update',message:'基金資料待更新'});
const FUNDS = { '0050': { fundId: '1066', isin: 'TW0000050004' }, '0056': { fundId: '1084', isin: 'TW0000056001' } };
const FUBON_URL = 'https://websys.fsit.com.tw/FubonETF/Fund/Assets.aspx?stkId=006208';
const supported = ticker => scopeFor(ticker) === 'domestic_equity' || ticker === '2330';
const visibleText = html => String(html).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/\s+/g,' ').trim();
const taiwanDate = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(now));
function num(value) { if (value === null || value === undefined || typeof value === 'boolean' || !String(value).trim()) return null; const n = Number(String(value).replaceAll(',', '')); return Number.isFinite(n) ? n : null; }
function date(value) {
  let text = String(value || '').replaceAll('/', '-');
  if (/^\d{8}$/.test(text)) text = `${text.slice(0,4)}-${text.slice(4,6)}-${text.slice(6)}`;
  if (/^\d{3}-\d{2}-\d{2}$/.test(text)) text = `${Number(text.slice(0,3))+1911}${text.slice(3)}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && Number.isFinite(Date.parse(text)) && new Date(text).toISOString().slice(0,10) === text ? text : null;
}
function parseYuanta(html, ticker, asOf) {
  const state = extractNuxtState(html), fund = state?.data?.[0]?.fundData, weights = state?.data?.[1]?.weightData;
  const expected = FUNDS[ticker] || (scopeFor(ticker)==='domestic_equity' && /^TW[0-9A-Z]{10}$/.test(fund?.ISINCODE||'') ? {fundId:fund.FUND_ID,isin:fund.ISINCODE} : null), pcf = weights?.PCF, groups = weights?.FundWeights;
  if (!expected || fund?.STK_CD !== ticker || fund?.FUND_ID !== expected.fundId || fund?.ISINCODE !== expected.isin
      || pcf?.markcd !== ticker || String(pcf?.fundid) !== expected.fundId || String(groups?.Summary?.code) !== expected.fundId) throw Error('官方基金身份不一致');
  const raw = groups.StockWeights;
  if (!Array.isArray(raw) || !raw.length) throw Error('未取得完整股票陣列，不能以申購清單或前十大替代');
  const stocks = raw.map(row => ({ code: String(row.code || '').trim(), name: String(row.name || '').trim(), weight: num(row.weights) }))
    .map(row => ({ ...row, securityId: /^\d{4}$/.test(row.code) ? `TW:${row.code}` : null }));
  if (stocks.some(row => !row.securityId || !row.name || row.weight === null || row.weight < 0 || row.weight > 100)
      || new Set(stocks.map(row => row.securityId)).size !== stocks.length) throw Error('持股識別或數值格式未通過');
  const stockWeight = stocks.reduce((sum, row) => sum + row.weight, 0);
  if (stockWeight <= 0 || stockWeight > 100) throw Error('股票權重加總異常');
  const navDate = date(pcf.trandate), navValue = num(pcf.nav);
  if (!navDate || navDate > asOf || !(navValue > 0)) throw Error('官方淨值日期或數值未通過');
  // The date must come from the STOCK section, never the NAV/PCF section.
  const stockSection = visibleText(html).match(/基金權重-股票\s+([\s\S]*?)(?:基金權重-|$)/)?.[1] || '';
  const holdingsDate = date(stockSection.match(/(?:交易日期|Trade Date)\s*[:：]\s*(\d{4}\/\d{2}\/\d{2})/)?.[1]);
  if (holdingsDate && holdingsDate > asOf) throw Error('股票持股日期超出當日');
  const displayed = [...stockSection.matchAll(/商品代碼\s+(\d{4})\s+商品名稱\s+(.+?)\s+商品數量\s+([\d,]+)\s+商品權重\s+([\d.]+)/g)];
  if (holdingsDate && (!displayed.length || displayed.some((row,i) => stocks[i]?.code !== row[1] || stocks[i]?.name !== row[2].trim() || stocks[i]?.weight !== num(row[4]) || num(raw[i]?.qty) !== num(row[3])))) throw Error('股票頁面與完整持股陣列不一致');
  const otherGroups = ['FutureWeights', 'ETFWeights', 'BondWeights'].map(key => ({ kind: key, rows: Array.isArray(groups[key]) ? groups[key].length : null,
    items: Array.isArray(groups[key]) ? groups[key].map(row=>({code:String(row.code||''),name:String(row.name||''),weight:num(row.weights),quantity:num(row.qty)})) : [] }));
  return { ticker, kind:'etf', name: fund.STK_NAME || fund.FUND_SH_NAME, identityVerified:true, stocks, stockWeight,
    holdingsDate, holdingsDateEvidence:holdingsDate?'official_stock_section_and_displayed_rows':null, complete:false, otherGroups, nav:{ date:navDate, value:navValue }, fundId:expected.fundId,
    issues:[...(!holdingsDate?['官方股票陣列已取得，但未獨立確認持股估值日期；PCF 日期僅用於淨值']:[]), ...(otherGroups.some(g => g.rows > 0) ? ['存在股票以外部位，尚未穿透至底層股票'] : [])] };
}
function parseFubon(html, ticker, asOf) {
  const text=visibleText(html), identity=text.match(/(?:^|\s)(\d{4,6}[A-Z]?)\s*\/\s*((?:主動)?富邦[^\s]+)/), holdingsDate=date(text.match(/資料日期：\s*(\d{4}\/\d{2}\/\d{2})/)?.[1]);
  if(scopeFor(ticker)!=='domestic_equity'||identity?.[1]!==ticker)throw Error('官方基金身份不一致');
  if(!holdingsDate||holdingsDate>asOf)throw Error('持股資料日期未通過');
  const block=text.match(/股票代碼 股票名稱 股數 金額 權重\(%\)\s+([\s\S]+?)\s+股票合計\s+([\d,]+)\s+([\d.]+)/);
  if(!block)throw Error('未取得完整官方股票表格');
  const pattern=/(\d{4})\s+(.+?)\s+([\d,]+)\s+([\d,]+)\s+([\d.]+)/g;
  const matches=[...block[1].matchAll(pattern)];
  if(block[1].replace(pattern,'').trim())throw Error('股票表格含未解析列');
  const stocks=matches.map(row=>({code:row[1],securityId:`TW:${row[1]}`,name:row[2].trim(),shares:num(row[3]),marketValue:num(row[4]),weight:num(row[5])}));
  const stockWeight=stocks.reduce((sum,row)=>sum+row.weight,0), totalValue=stocks.reduce((sum,row)=>sum+row.marketValue,0);
  if(!stocks.length||new Set(stocks.map(r=>r.code)).size!==stocks.length||stocks.some(r=>!r.name||r.weight===null||r.weight<0||r.weight>100||!(r.shares>=0)||!(r.marketValue>=0))||stockWeight>100||stockWeight<=0||totalValue!==num(block[2])||Math.abs(stockWeight-num(block[3]))>stocks.length*0.00005+0.000001)throw Error('持股列或官方加總未通過');
  const futuresBlock=text.match(/期貨代碼 期貨名稱 口數 金額 權重\(%\)\s+([\s\S]+?)\s+期貨合計/);
  const futures=futuresBlock?[...futuresBlock[1].matchAll(/(\S+)\s+(.+?)\s+([\d,]+)\s+([\d,]+)\s+([\d.]+)/g)].map(r=>({code:r[1],name:r[2],quantity:num(r[3]),weight:num(r[5])})):[];
  const navValue=num(text.match(/基金每單位淨值\(新台幣\)\s+([\d,.]+)/)?.[1]);
  if(!(navValue>0))throw Error('官方淨值未通過');
  return {ticker,kind:'etf',name:scope.entries[ticker].name,identityVerified:true,stocks,stockWeight,holdingsDate,holdingsDateEvidence:'official_full_assets_table_with_totals',complete:false,nav:{date:holdingsDate,value:navValue},otherGroups:[{kind:'FutureWeights',rows:futures.length,items:futures}],issues:['股票以外資產未穿透至底層股票；已知股票資料不代表完整金融曝險']};
}
function parsePrice(json, ticker, asOf) {
  if (json.stat !== 'OK' || !new RegExp(`(?:^|\\s)${ticker}(?:\\s|$)`).test(String(json.title || '')) || !Array.isArray(json.data)) throw Error('官方價格身份或資料不完整');
  const fields = json.fields || [], di = fields.indexOf('日期'), ci = fields.indexOf('收盤價');
  if (di < 0 || ci < 0) throw Error('官方價格欄位已變更');
  const rows = json.data.map(row => ({ date:date(row[di]), close:num(row[ci]) })).filter(row => row.date && row.date <= asOf && row.close > 0);
  if (!rows.length) throw Error('本月尚無可驗證成交資料');
  return rows.sort((a,b) => a.date.localeCompare(b.date)).at(-1);
}
function createPortfolioMarket({ cacheDir = path.join(process.env.CUSTOMER_DATA_DIR || path.join(__dirname,'private-data'),'portfolio-market'),
  fetchImpl = require('./portfolio-transport').officialFetch, now = () => Date.now(), allowNetwork = process.env.SMOKE_TEST !== '1', deadlineMs = 55000, requestTimeoutMs = 12000,
  cacheTtlMs = TTL, maxActive = 4, maxSourceBytes = 128 * 1024 * 1024, maxSourceFiles = 1024 } = {}) {
  const cache = new Map(), inFlight = new Map(), jobs = new Map();
  let active = 0;
  const hash = text => crypto.createHash('sha256').update(text).digest('hex');
  const atomic = (file, value) => { fs.mkdirSync(path.dirname(file),{recursive:true}); const tmp = `${file}.${crypto.randomUUID()}.tmp`;try{fs.writeFileSync(tmp,JSON.stringify(value));fs.renameSync(tmp,file);}finally{try{fs.unlinkSync(tmp);}catch{}} };
  function reserveSource(bytes, digest) {
    const dir=path.join(cacheDir,'sources');fs.mkdirSync(dir,{recursive:true});
    const raw=path.join(dir,digest+'.raw');if(fs.existsSync(raw))return;
    const files=fs.readdirSync(dir).filter(f=>/^[a-f0-9]{64}\.raw$/.test(f)).map(f=>{const stat=fs.statSync(path.join(dir,f));return {f,size:stat.size,mtime:stat.mtimeMs};}).sort((a,b)=>a.mtime-b.mtime);
    let size=files.reduce((s,f)=>s+f.size,0),count=files.length;
    for(const f of files){if(size+bytes<=maxSourceBytes&&count<maxSourceFiles)break;
      // Recent in-flight evidence and every reusable cache stay intact.
      if(Date.now()-f.mtime<=Math.max(cacheTtlMs,TTL)+60000)continue;
      fs.unlinkSync(path.join(dir,f.f));try{fs.unlinkSync(path.join(dir,f.f.replace('.raw','.json')));}catch{}
      size-=f.size;count--;
    }
    if(size+bytes>maxSourceBytes||count>=maxSourceFiles)throw Error('Public source cache capacity reached');
  }
  function read(ticker) {
    if (cache.has(ticker)) return cache.get(ticker);
    try { const doc = JSON.parse(fs.readFileSync(path.join(cacheDir,`${ticker}.json`),'utf8'));
      if (doc.version === VERSION && doc.data?.ticker === ticker && doc.sha256 === hash(JSON.stringify(doc.data))) { cache.set(ticker,doc.data); return doc.data; }
    } catch { /* Invalid cache is never promoted to official evidence. */ }
    return null;
  }
  async function source(url, signal, options={}) {
    const requestUrl=new URL(url);for(const [key,value] of Object.entries(options.transientParams||{}))requestUrl.searchParams.set(key,value);
    const response = await fetchImpl(Object.keys(options.transientParams||{}).length?requestUrl.toString():url,{ signal:AbortSignal.any([signal,AbortSignal.timeout(requestTimeoutMs)]), redirect:options.session?'manual':'error', method:options.method||'GET',body:options.body, headers:{'User-Agent':'SmallBudgetCashflow/portfolio-validation',...options.headers} });
    if(options.session && [301,302,303,307,308].includes(response.status)){await response.body?.cancel();return {redirect:response.headers.get('location'),headers:response.headers,status:response.status};}
    if (!response.ok) throw Error(`官方來源 HTTP ${response.status}`);
    const reader=response.body?.getReader();let wire;
    if (reader) { const chunks=[];let bytes=0;try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>6000000)throw Error('官方回應超過大小上限');chunks.push(Buffer.from(value));}wire=Buffer.concat(chunks);}finally{await reader.cancel().catch(()=>{});} }
    else {wire=Buffer.from(await response.text());if(wire.length>6000000)throw Error('官方回應超過大小上限');}
    const declared=response.headers?.get('content-type')?.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1]||wire.subarray(0,1000).toString('ascii').match(/charset\s*=\s*["']?([A-Za-z0-9_-]+)/i)?.[1]||'utf-8';
    if(!/^(utf-8|utf8|big5)$/i.test(declared))throw Error('官方回應編碼尚未支援');
    let text=new TextDecoder(declared,{fatal:true}).decode(wire);
    if (signal.aborted) throw Error('資料核對已逾時');
    if(options.transient)return {text,headers:response.headers};
    let parsed;try{parsed=JSON.parse(text);}catch{}
    if(containsCredentials(parsed))throw Error('官方回應含工作階段憑證，不保留或傳送至客戶端');
    text=redactFormState(Buffer.from(text)).toString('utf8');
    let parameters={};if(options.body){try{parameters=JSON.parse(options.body);}catch{parameters=Object.fromEntries(new URLSearchParams(options.body));}}
    parameters=Object.fromEntries(Object.entries(parameters).filter(([k])=>!/^(__|token$|access_token$|password$|authorization$|secret$|api_key$)/i.test(k)));
    const receipt={url,method:options.method||'GET',requestParameters:parameters,observedAt:new Date(now()).toISOString(),sha256:hash(text),wireSha256:hash(wire),encoding:declared,httpStatus:response.status};
    try { reserveSource(Buffer.byteLength(text),receipt.sha256);fs.writeFileSync(path.join(cacheDir,'sources',`${receipt.sha256}.raw`),text); atomic(path.join(cacheDir,'sources',`${receipt.sha256}.json`),receipt); } catch { receipt.persistence='unavailable'; }
    return {text,receipt,headers:response.headers};
  }
  const valuationQuotes=require('./portfolio-valuation').createValuationQuotes({source,now,ttl:cacheTtlMs});
  async function load(ticker, signal) {
    const asOf=taiwanDate(now()), receipts=[];
    if (!allowNetwork) return {ticker,status:'unavailable',message:'此環境停用官方連線，尚未確認最新資料'};
    const priceUrl=`https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${asOf.slice(0,7).replace('-','')}01&stockNo=${ticker}`;
    const pricePromise=source(priceUrl,signal).then(s=>{receipts.push(s.receipt);return {...parsePrice(JSON.parse(s.text),ticker,asOf),sourceUrl:priceUrl};}).catch(e=>({error:e.message}));
    let data;
    if (/元大/.test(scope.entries[ticker]?.issuer||'')) {
      const url=`https://www.yuantaetfs.com/product/detail/${ticker}/ratio`;
      const s=await source(url,signal);receipts.push(s.receipt);data={...parseYuanta(s.text,ticker,asOf),sourceUrl:url};
    } else if (/富邦/.test(scope.entries[ticker]?.issuer||'')) {
      const url=FUBON_URL.replace('006208',ticker),s=await source(url,signal);receipts.push(s.receipt);data={...parseFubon(s.text,ticker,asOf),sourceUrl:url};
    } else if (ticker === '2330') {
      const price=await pricePromise;
      if(price.error) throw Error(price.error);
      data={ticker,kind:'stock',name:'台積電',security:{code:ticker,name:'台積電',securityId:'TW:2330'},identityVerified:true,complete:true,sourceUrl:priceUrl,issues:[]};
    } else { data=await loadOfficial(ticker,{source,signal,asOf,etf:scope.entries[ticker]});receipts.push(...data.receipts); }
    data.price=await pricePromise;
    if(data.price.error) {data.issues.push(`價格待確認：${data.price.error}`);data.price=null;}
    data.receipts=receipts;
    if(data.valuationBasis){
      const quotes=await valuationQuotes(data.valuationBasis.date);
      data.valuationVerification=require('./portfolio-valuation').reconcile(data,quotes,asOf);
      receipts.push(...quotes.receipts);
      data.issues=data.issues.filter(s=>!s.startsWith('官方未明示可獨立核對的持股日期'));
      data.issues.unshift(data.valuationVerification.limitation);
    }
    data.observedAt=new Date(now()).toISOString();data.status='observed';
    data.freshness='official_endpoint_observed'; // Retrieval time is never a holdings valuation date.
    if (!signal.aborted) { cache.set(ticker,data); try{atomic(path.join(cacheDir,`${ticker}.json`),{version:VERSION,sha256:hash(JSON.stringify(data)),data});}catch{data.cacheWarning='persistent_cache_unavailable';} }
    return data;
  }
  async function get(ticker) {
    if (PENDING_FUNDS.has(ticker)) return pendingFund(ticker);
    if (!supported(ticker)) return scopeFor(ticker)==='outside_scope'
      ? {ticker,status:'unsupported',message:`此 ETF 的官方類型是「${scope.entries[ticker].classification}」。目前僅支援國內一般股票型 ETF（含主動式）；海外、債券、槓桿與反向等類型不支援，等待或重試不會自動補齊`}
      : {ticker,status:'unavailable',message:'此代號尚未完成官方範圍核對，無法判定是否支援；不會推估持股或顯示零重疊'};
    const previous=read(ticker), age=previous ? now()-Date.parse(previous.observedAt) : Infinity;
    if(previous && age>=0 && age<cacheTtlMs && taiwanDate(previous.observedAt)===taiwanDate(now())) return {...previous,status:'cached'};
    if(inFlight.has(ticker)) return inFlight.get(ticker);
    if(active>=maxActive) return {ticker,status:'busy',message:'官方核對工作已滿，請稍後重試'};
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.max(1,deadlineMs-1000));
    const expired=new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(Error('官方核對已達等待上限')),{once:true}));
    const task=Promise.race([load(ticker,controller.signal),expired]).catch(e=>{controller.abort();const message=/[\u3400-\u9fff]/.test(e.message)?e.message:/timeout|aborted/i.test(e.message)?'官方連線逾時，本次尚無法確認最新資料':'官方資料暫時無法核對（連線或格式問題），請稍後重試';return {ticker,status:'unavailable',message,previousAvailable:!!previous,
      previousObservedAt:previous?.observedAt||null};}).finally(()=>{clearTimeout(timer);active--;inFlight.delete(ticker);});
    active++;inFlight.set(ticker,task);return task;
  }
  function clean() { for(const [id,job] of jobs) if(now()-job.createdAt>JOB_TTL) jobs.delete(id); }
  function start(tickers) {
    clean();
    if(!Array.isArray(tickers)||tickers.length<1||tickers.length>20||tickers.some(t=>typeof t!=='string'||!/^\d{4,6}[A-Z]?$/.test(t))) throw Object.assign(Error('請提供 1 至 20 個有效持有代號'),{statusCode:400});
    if(jobs.size>=64) throw Object.assign(Error('分析工作已滿，請稍後重試'),{statusCode:429});
    const unique=[...new Set(tickers)].sort(),job={id:crypto.randomUUID(),createdAt:now(),deadlineAt:now()+deadlineMs,status:'running',tickers:unique,data:{},completed:0,total:unique.length};
    jobs.set(job.id,job);
    for (const ticker of unique) if (PENDING_FUNDS.has(ticker)) {job.data[ticker]=pendingFund(ticker);job.completed++;}
    const remaining=unique.filter(t=>!job.data[t]);
    if (!remaining.length) {job.status='partial';return view(job);}
    const timer=setTimeout(()=>{
      if(job.status!=='running')return;
      unique.filter(t=>!job.data[t]).forEach(t=>{job.data[t]={ticker:t,status:'timeout',message:'核對逾時，尚無法確認最新資料'};});
      job.status='timeout';
    },deadlineMs);timer.unref?.();
    let next=0;
    Promise.all(Array.from({length:Math.min(maxActive,remaining.length)},async()=>{
      while(next<remaining.length&&job.status==='running'){const ticker=remaining[next++],data=await get(ticker);if(job.status!=='running')return;job.data[ticker]=data;job.completed++;}
    })).then(()=>{
      clearTimeout(timer);if(job.status!=='running')return;
      job.status=Object.values(job.data).every(d=>['observed','cached'].includes(d.status))?'finished':'partial';
    });
    return view(job);
  }
  function view(job) {return {id:job.id,status:job.status,tickers:job.tickers,completed:job.completed,total:job.total,
    progressMeaning:'已處理的標的數（含待更新）；不代表完整驗證通過率',elapsedMs:Math.max(0,now()-job.createdAt),deadlineMs,data:structuredClone(job.data)};}
  return {start,status:id=>{clean();const job=jobs.get(id);if(!job)throw Object.assign(Error('工作已過期，請重新分析'),{statusCode:404});return view(job);},get};
}
module.exports={createPortfolioMarket,parseYuanta,parseFubon,parsePrice,taiwanDate,date,num};
