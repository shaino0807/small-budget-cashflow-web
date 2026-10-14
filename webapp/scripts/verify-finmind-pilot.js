const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const {officialDate,toNumber}=require("./update-safety");
const tickers=["0050","0056"],from="2026-09-01",to="2026-09-30";
const sha256=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
function normalize(provider,json,ticker){
 if(provider==="FinMind"){
  if(json.status!==200||!Array.isArray(json.data))throw Error("FinMind response not successful: "+String(json.status)+" "+String(json.msg||""));
  return json.data.map(r=>({ticker:String(r.stock_id),date:officialDate(r.date),open:toNumber(r.open),high:toNumber(r.max),low:toNumber(r.min),close:toNumber(r.close),volume:toNumber(r.Trading_Volume)}));
 }
 if(json.stat!=="OK"||!Array.isArray(json.data))throw Error("TWSE response not successful: "+String(json.stat));
 return json.data.map(r=>({ticker,date:officialDate(r[0]),open:toNumber(r[3]),high:toNumber(r[4]),low:toNumber(r[5]),close:toNumber(r[6]),volume:toNumber(r[1])}));
}
function compare(ticker,official,candidate){
 const errors=[],detail=[],seen=new Set();
 for(const [provider,rows] of [["TWSE",official],["FinMind",candidate]]){
  seen.clear();
  for(const row of rows){
   if(row.ticker!==ticker||!row.date||row.date<from||row.date>to)errors.push(provider+": invalid identity/date "+JSON.stringify(row));
   if(seen.has(row.date))errors.push(provider+": duplicate date "+row.date);
   seen.add(row.date);
   if(![row.open,row.high,row.low,row.close].every(n=>typeof n==="number"&&Number.isFinite(n)&&n>0))errors.push(provider+": invalid OHLC "+row.date);
   if(row.high<Math.max(row.open,row.close,row.low)||row.low>Math.min(row.open,row.close,row.high))errors.push(provider+": inconsistent OHLC "+row.date);
   if(!Number.isSafeInteger(row.volume)||row.volume<0)errors.push(provider+": invalid volume "+row.date);
  }
 }
 if(!official.length||!candidate.length)errors.push("Empty response cannot pass");
 const left=new Map(official.map(r=>[r.date,r])),right=new Map(candidate.map(r=>[r.date,r]));
 for(const date of [...new Set([...left.keys(),...right.keys()])].sort()){
  if(!left.has(date)||!right.has(date)){errors.push("Missing date "+date);detail.push({ticker,date,field:"date",official:left.has(date),finmind:right.has(date),match:false});continue;}
  for(const field of ["open","high","low","close","volume"]){
   const a=left.get(date)[field],b=right.get(date)[field],match=Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<1e-8;
   detail.push({ticker,date,field,official:a,finmind:b,match});
  }
 }
 const mismatches=detail.filter(r=>!r.match);
 return {ticker,status:errors.length||mismatches.length?"fail":"pass",officialRows:official.length,finmindRows:candidate.length,comparedValues:detail.length,mismatches:mismatches.length,errors,detail};
}
async function run(outputDir){
 fs.mkdirSync(outputDir,{recursive:true});
 const receipts=[],results=[];
 for(const ticker of tickers){
  const datasets={};
  for(const provider of ["TWSE","FinMind"]){
   const url=provider==="TWSE"?"https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=20260901&stockNo="+ticker
    :"https://api.finmindtrade.com/api/v4/data?"+new URLSearchParams({dataset:"TaiwanStockPrice",data_id:ticker,start_date:from,end_date:to});
   const receipt={provider,ticker,url,requestedRange:{from,to},retrievedAt:new Date().toISOString()};
   try{
    const headers={"User-Agent":"SmallBudgetCashflowMap/FinMindPilot"};
    if(provider==="FinMind"&&process.env.FINMIND_TOKEN)headers.Authorization="Bearer "+process.env.FINMIND_TOKEN;
    const res=await fetch(url,{headers,signal:AbortSignal.timeout(25000)});
    const bytes=Buffer.from(await res.arrayBuffer()),file=provider.toLowerCase()+"-"+ticker+"-raw.json";
    fs.writeFileSync(path.join(outputDir,file),bytes);
    Object.assign(receipt,{httpStatus:res.status,sha256:sha256(bytes),file});
    if(!res.ok)throw Error("HTTP "+res.status);
    const rows=normalize(provider,JSON.parse(bytes.toString("utf8")),ticker);
    datasets[provider]=rows;
    Object.assign(receipt,{status:"received",rows:rows.length,sourceFrom:rows.map(r=>r.date).filter(Boolean).sort()[0]||null,sourceTo:rows.map(r=>r.date).filter(Boolean).sort().at(-1)||null});
   }catch(error){receipt.status="blocked";receipt.error=error.message;}
   receipts.push(receipt);
  }
  results.push(datasets.TWSE&&datasets.FinMind?compare(ticker,datasets.TWSE,datasets.FinMind):{ticker,status:"blocked",reason:"Source unavailable; no comparison pass claimed",detail:[]});
 }
 const report={schemaVersion:1,pilotVersion:sha256(fs.readFileSync(__filename)),node:process.version,executedAt:new Date().toISOString(),requestedRange:{from,to},tickers,priceBasis:"unadjusted TWD per unit",volumeUnit:"shares (TWSE trade volume / FinMind Trading_Volume); no inferred multiplier",productionImported:false,status:results.every(r=>r.status==="pass")?"pass":results.some(r=>r.status==="blocked")?"blocked":"fail",receipts,results:results.map(({detail,...r})=>r)};
 fs.writeFileSync(path.join(outputDir,"report.json"),JSON.stringify(report,null,2)+"\n");
 const lines=["ticker,date,field,twse,finmind,match",...results.flatMap(r=>r.detail.map(v=>[v.ticker,v.date,v.field,v.official,v.finmind,v.match].join(",")))];
 fs.writeFileSync(path.join(outputDir,"comparison.csv"),lines.join("\n")+"\n");
 console.log(JSON.stringify(report,null,2));
 return report;
}
if(require.main===module){
 const outputDir=process.argv[2];
 if(!outputDir){console.error("Usage: node verify-finmind-pilot.js <private-local-output-directory>");process.exitCode=1;}
 else run(path.resolve(outputDir)).then(r=>{if(r.status!=="pass")process.exitCode=2;}).catch(e=>{console.error(e.message);process.exitCode=1;});
}
module.exports={normalize,compare};
