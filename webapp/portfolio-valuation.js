// A valuation consistency check does not establish the actual holdings date.
const crypto = require('node:crypto');
const METHODS = Object.freeze({
  '00919':'truncate4','00415A':'truncate4','00927':'truncate4','00946':'truncate4','00982A':'truncate4','00992A':'truncate4','00923':'truncate4',
  '00904':'round4','00936':'round4','00947':'round4','00962':'round4','00987A':'round4'
});
function validDate(value) {
  let s=String(value||'').replaceAll('/','-');
  if(/^\d{8}$/.test(s))s=`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6)}`;
  if(/^\d{3}-\d{2}-\d{2}$/.test(s))s=`${Number(s.slice(0,3))+1911}${s.slice(3)}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s?s:null;
}
function priceRows(json,market,date) {
  if(!validDate(date)||validDate(json?.date)!==date||String(json?.stat).toLowerCase()!=='ok')throw Error('官方收盤價格日期未對應估值日');
  const codeField=market==='TWSE'?'證券代號':'代號',closeField=market==='TWSE'?'收盤價':'收盤';
  const tables=(json.tables||[]).filter(t=>t.fields?.includes(codeField)&&t.fields?.includes(closeField)&&/每日收盤行情|^上櫃股票行情$/.test(t.title||''));
  if(tables.length!==1||!Array.isArray(tables[0].data)||!tables[0].data.length)throw Error('官方收盤價格欄位或完整表格未通過');
  const t=tables[0],ci=t.fields.indexOf(codeField),pi=t.fields.indexOf(closeField),result=new Map(),seen=new Set();
  if(t.date&&validDate(t.date)!==date)throw Error('官方價格表日期不一致');
  for(const row of t.data){
    const code=String(row[ci]||'').trim();if(!/^\d{4}$/.test(code))continue;
    if(seen.has(code))throw Error('官方收盤價格有重複證券');seen.add(code);
    const raw=row[pi],close=typeof raw==='number'?raw:typeof raw==='string'&&raw.trim()?Number(raw.replaceAll(',','')):NaN;
    if(Number.isFinite(close)&&close>0)result.set(code,{code,close,date,market});
  }
  if(!result.size)throw Error('官方收盤價格沒有有效股票列');return result;
}
function reconcile(data,quotes,asOf) {
  const method=METHODS[data.ticker],basis=data.valuationBasis,date=validDate(basis?.date),aum=basis?.netAssets;
  if(!method||basis?.method!==method||!date||date>asOf||date!==data.nav?.date||data.holdingsDate!=null||typeof aum!=='number'||!Number.isFinite(aum)||aum<=0||!data.stocks?.length)throw Error('官方估值核對的身份、日期或淨資產未通過');
  const rows=data.stocks.map(s=>{
    const q=quotes.rows.get(s.code),quantity=s.quantity,weight=s.weight;
    if(!q||q.date!==date||typeof quantity!=='number'||!Number.isFinite(quantity)||quantity<0||typeof weight!=='number'||!Number.isFinite(weight)||weight<0)throw Error(`估值核對缺少同日價格或有效股數：${s.code}`);
    const calculated=quantity*q.close/aum*100;
    const publishedPrecision=method==='truncate4'?Math.floor((calculated+1e-10)*10000)/10000:Math.round(calculated*10000)/10000;
    if(!Number.isFinite(calculated)||Math.abs(publishedPrecision-weight)>1e-9)throw Error(`估值核對與官方權重不一致：${s.code}`);
    return {code:s.code,close:q.close,market:q.market,calculatedWeight:calculated,publishedWeight:weight};
  });
  const basisHash=crypto.createHash('sha256').update(JSON.stringify({ticker:data.ticker,date,aum,stocks:data.stocks,sources:data.receipts?.map(r=>r.sha256)})).digest('hex');
  return {status:'verified',date,method,matchedRows:rows.length,totalRows:rows.length,basisHash,rows,
    sources:quotes.receipts.map(r=>({url:r.url,sha256:r.sha256,observedAt:r.observedAt})),
    limitation:'官方估值日已逐列核對；實際持股基準日未公開，不能據此證明未含下一交易日調整。精度方式為數值觀測結果。'};
}
function createValuationQuotes({source,now=Date.now,ttl=300000}) {
  const cache=new Map();
  return async date=>{
    if(!validDate(date))throw Error('估值日無效');
    const existing=cache.get(date);if(existing&&now()-existing.at>=0&&now()-existing.at<ttl)return existing.promise;
    cache.delete(date);while(cache.size>=8)cache.delete(cache.keys().next().value);
    // Shared public prices have their own bounded lifetime; one customer's abort cannot poison another request.
    const signal=AbortSignal.timeout(15000),compact=date.replaceAll('-','');
    const promise=Promise.all([
      ['TWSE',`https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${compact}&type=ALLBUT0999`],
      ['TPEx',`https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=${encodeURIComponent(date.replaceAll('-','/'))}&type=EW&response=json`]
    ].map(async([market,url])=>{const s=await source(url,signal);return {rows:priceRows(JSON.parse(s.text),market,date),receipt:s.receipt};}))
      .then(parts=>{const rows=new Map();for(const p of parts)for(const[code,row]of p.rows){if(rows.has(code))throw Error('官方跨市場代碼重複');rows.set(code,row);}return {rows,receipts:parts.map(p=>p.receipt)};})
      .catch(e=>{if(cache.get(date)?.promise===promise)cache.delete(date);throw e;});
    cache.set(date,{at:now(),promise});return promise;
  };
}
module.exports={METHODS,validDate,priceRows,reconcile,createValuationQuotes};
