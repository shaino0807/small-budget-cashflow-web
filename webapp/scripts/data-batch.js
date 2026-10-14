const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const {officialDate,atomicWriteJson}=require("./update-safety");
const sha256=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
function datasets(db){return [
 ["etfMaster",db.etfs||[],null],["stockQuotes",(db.stocks?.items||[]).map(s=>({...s.latestPrice,ticker:s.ticker,refreshStatus:s.priceRefreshStatus})), "date"],
 ["priceSeries",db.priceSeries?.items||[],"date"],["holdings",db.holdings?.items||[],"asOfDate"],
 ["navSeries",db.navSeries?.items||[],"date"],["distributions",db.distributions||[],"payDate"]
];}
function inventory(db){
 return datasets(db).map(([name,rows,dateKey])=>{
  const dates=dateKey?rows.map(r=>r[dateKey]).filter(d=>d&&officialDate(d)===d).sort():[];
  const bySource={};
  for(const row of rows){
   const source=row.source||row.performance?.source||"unspecified";
   const item=bySource[source]||={source,rows:0,datedRows:0,from:null,to:null,urls:[]};
   item.rows++;
   const date=dateKey&&row[dateKey];
   if(date&&officialDate(date)===date){item.datedRows++;item.from=!item.from||date<item.from?date:item.from;item.to=!item.to||date>item.to?date:item.to;}
   if(row.sourceUrl&&!item.urls.includes(row.sourceUrl))item.urls.push(row.sourceUrl);
  }
  return {dataset:name,rows:rows.length,datedRows:dates.length,missingDateRows:rows.length-dates.length,coverage:{from:dates[0]||null,to:dates.at(-1)||null},sources:Object.values(bySource)};
 });
}
function checkContent(before,after,{today=new Date().toISOString().slice(0,10)}={}){
 const errors=[],warnings=[];
 for(const [name,rows,dateKey] of datasets(after)){
  const oldRows=datasets(before).find(x=>x[0]===name)[1],old=new Map(oldRows.map(r=>[key(name,r),JSON.stringify(r)])),seen=new Set();
  for(const row of rows){
   const identity=key(name,row),issues=[];
   if(seen.has(identity))errors.push(name+": duplicate "+identity);
   seen.add(identity);
   if(!row.ticker)issues.push("missing ticker");
   if(dateKey){
    const date=row[dateKey];
    if(!date||officialDate(date)!==date)issues.push("missing/invalid "+dateKey);
    if(date&&date>today&&name!=="distributions")issues.push("future source date");
   }
   if(name==="stockQuotes"||name==="priceSeries"){
    if(!(typeof row.close==="number"&&Number.isFinite(row.close)&&row.close>0))issues.push("invalid close");
    const nums=["open","high","low","close"].map(k=>row[k]);
    if(nums.every(n=>typeof n==="number"&&Number.isFinite(n))&&(row.high<Math.max(row.open,row.close,row.low)||row.low>Math.min(row.open,row.close,row.high)))issues.push("inconsistent OHLC");
    if(row.tradeVolume!=null&&(!Number.isFinite(row.tradeVolume)||row.tradeVolume<0))issues.push("invalid volume");
   }
   if(name==="holdings"&&(!row.holdingTicker||!Number.isFinite(row.weight)||row.weight<0||row.weight>100))issues.push("invalid holding/weight");
   if(name==="distributions"&&(!Number.isFinite(row.amountPerUnit)||row.amountPerUnit<0))issues.push("invalid distribution amount");
   if(issues.length){
    // Existing gaps stay visible; do not turn them into proof of a successful refresh.
    const unchanged=old.get(identity)===JSON.stringify(row);
    const preserved=name==="stockQuotes"&&row.refreshStatus==="preserved_previous";
    const missingQuote=name==="stockQuotes"&&row.close==null&&(!old.has(identity)||row.refreshStatus==="missing");
    (unchanged||preserved||missingQuote?warnings:errors).push(name+"/"+identity+": "+issues.join(","));
   }
  }
 }
 return {status:errors.length?"fail":warnings.length?"pass_with_gaps":"pass",errors,warnings,checks:["unique identities","calendar/source dates","new price positivity and OHLC consistency","nonnegative volumes/amounts","holding weight bounds","preserved gaps explicitly reported"],notVerified:["all issuer holdings completeness","all tracked index correctness","full-market independent cross-source comparison"]};
}
function key(name,row){return name==="etfMaster"||name==="stockQuotes"?row.ticker:name==="holdings"?[row.ticker,row.holdingTicker,row.asOfDate].join(":"):name==="distributions"?[row.ticker,row.payDate,row.exDate||"",row.amountPerUnit].join(":"):[row.ticker,row.date].join(":");}
function codeVersion(){
 const files=["data-batch.js","refresh-official-database.js","update-etf-master.js","update-stock-master.js","update-price-series.js","update-issuer-official-data.js","finalize-data-quality.js","validate-etf-data.js","update-safety.js"];
 return {commit:process.env.GITHUB_SHA||process.env.RENDER_GIT_COMMIT||null,node:process.version,codeSha256:sha256(files.map(f=>f+"\n"+fs.readFileSync(path.join(__dirname,f),"utf8")).join("\n"))};
}
function createBatch(before,after,{id,startedAt,steps,checks,previousSha256,error}){
 const attempts=[...(after.etfMaster?.sourceAttempts||[]),...(after.stocks?.sourceAttempts||[]),...(after.priceSeries?.sourceAttempts||[]),...(after.holdings?.sourceAttempts||[]),...(after.navSeries?.sourceAttempts||[])];
 const sourceGaps=attempts.some(a=>!["loaded","OK"].includes(a.status)||a.preserved||a.preservedRows||a.rejected?.length);
 return {schemaVersion:1,batchId:id,startedAt,finishedAt:new Date().toISOString(),status:error?"failed":sourceGaps&&checks?.status==="pass"?"pass_with_gaps":checks?.status||"not_tested",
  version:codeVersion(),previousFileSha256:previousSha256,inputInventory:inventory(before),outputInventory:inventory(after),
  sourceAttempts:attempts,sourceRegistry:after.metadata?.sources||[],steps,checks:checks||{status:"not_tested"},...(error?{error}:{}),
  integrityMeaning:"SHA-256 identifies bytes, not correctness. Content checks and source coverage are separate."};
}
function writeBatch(directory,batch){fs.mkdirSync(directory,{recursive:true});atomicWriteJson(path.join(directory,batch.batchId+".json"),batch);}
module.exports={sha256,inventory,checkContent,createBatch,writeBatch};
