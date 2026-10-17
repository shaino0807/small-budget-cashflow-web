const u=require('./official-text');
const {monthsBefore}=require('../etf-data');
function dailyRows(json,market,date,tickers){
 if(!json||u.date(json.date)!==date)return {status:'date_not_verified',rows:[]};
 if(!/^ok$/i.test(json.stat||''))return {status:/沒有符合|查無資料/.test(json.stat||'')?'no_session':'unavailable',rows:[]};
 const table=(json.tables||[]).find(t=>t.fields?.some(f=>/^(證券代號|代號)$/.test(f))&&t.fields.some(f=>/^(收盤價|收盤)$/.test(f)));
 if(!table)return {status:'schema_not_verified',rows:[]};
 const field=(names)=>table.fields.findIndex(f=>names.includes(f));
 const code=field(['證券代號','代號']),close=field(['收盤價','收盤']),open=field(['開盤價','開盤']),high=field(['最高價','最高']),low=field(['最低價','最低']),volume=field(['成交股數']);
 const rows=[];let rejected=0;
 for(const cells of table.data||[]){const ticker=u.text(cells[code]),currency=tickers.get(ticker);if(!tickers.has(ticker))continue;
  const last=u.number(cells[close]);if(last===null)continue;
  const row={ticker,date,close:last,open:u.number(cells[open]),high:u.number(cells[high]),low:u.number(cells[low]),tradeVolume:u.number(cells[volume]),currency,
   source:market==='TWSE'?'twse-official-daily-etf-history':'tpex-official-daily-history'};
  if(!(last>0)||[row.open,row.high,row.low].every(Number.isFinite)&&(row.high<Math.max(row.open,row.low,last)||row.low>Math.min(row.open,row.high,last))){rejected++;continue;}
  rows.push(row);
 }
 return {status:rejected?'rejected_numeric_rows':rows.length?'loaded':'empty_official_response',rows,rejected};
}
async function collectPriceHistory(c,db,asOf){
 const start=monthsBefore(asOf,6),recent=new Date(asOf+'T00:00:00Z');recent.setUTCDate(recent.getUTCDate()-7);
 const refreshFrom=recent.toISOString().slice(0,10),sessions={...db.priceSeries?.sessions},items=[],tasks=[];
 for(const market of ['TWSE','TPEx'])for(let day=new Date(start+'T00:00:00Z');day.toISOString().slice(0,10)<=asOf;day.setUTCDate(day.getUTCDate()+1)){
  if([0,6].includes(day.getUTCDay()))continue;const date=day.toISOString().slice(0,10),key=market+':'+date,prior=sessions[key];
  if(date<refreshFrom&&(prior?.status==='loaded'&&prior.rows>0||prior?.status==='no_session'))continue;
  tasks.push({market,date,key});
 }
 let next=0,done=0;
 await Promise.all(Array.from({length:2},async()=>{while(next<tasks.length){
  const {market,date,key}=tasks[next++],id=market.toLowerCase()+'-etf-history-'+date;
  const url=market==='TWSE'?'https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date='+date.replaceAll('-','')+'&type=0099P&response=json':
   'https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date='+date.replaceAll('-','%2F')+'&id=&response=json';
  const value=await c.get(id,url),tickers=new Map(db.etfs.filter(e=>e.listingMarket===market).map(e=>[e.ticker,e.currency||null]));
  const parsed=dailyRows(value,market,date,tickers),record=c.records().find(r=>r.id===id);
  sessions[key]={status:parsed.status,rows:parsed.rows.length,checkedAt:record?.retrievedAt||null,sourceUrl:url,...(parsed.rejected?{rejected:parsed.rejected}:{})};
  items.push(...parsed.rows.map(row=>({...row,sourceUrl:url})));
  if(++done%25===0)console.log(JSON.stringify({phase:'six-month-price-history',done,total:tasks.length}));await c.sleep(200);
 }}));
 return {items,sessions,from:start,to:asOf};
}
module.exports={dailyRows,collectPriceHistory};
