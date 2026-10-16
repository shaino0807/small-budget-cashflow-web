const fs=require('node:fs'),path=require('node:path');
const {collect}=require('./collect-official-market');
const {applyMarketReference}=require('./apply-market-reference');
const {atomicWriteJson}=require('./update-safety');
async function main(){
 const file=process.env.ETF_DATABASE_PATH?path.resolve(process.env.ETF_DATABASE_PATH):path.join(__dirname,'../data/etf-database.json');
 const cache=process.env.OFFICIAL_SOURCE_CACHE||path.join(process.env.CUSTOMER_DATA_DIR||path.join(__dirname,'../private-data'),'market-sources');
 const db=JSON.parse(fs.readFileSync(file));
 const data=await collect(db,cache);applyMarketReference(db,data);
 const used=new Set(data.reference.items.flatMap(r=>r.sourceRefs.map(s=>s.id)));
 db.marketCoverage.sourceAttempts=data.receipts.map(r=>({id:r.id,url:r.url,method:r.method,status:r.path?'loaded':r.attempted===false?'not_attempted_access_limit':'failed',
   retrievalMeaning:'HTTP body receipt only; content and fund identity checks are separate',referencedByNormalization:used.has(r.id),
   retrievedAt:r.retrievedAt,sha256:r.sha256||null,bytes:r.bytes||null,requestParameters:r.requestParameters||{},error:r.error||null}));
 db.metadata.limitations=(db.metadata.limitations||[]).filter(x=>!x.startsWith('投信官方頁已接上可解析來源'));
 db.metadata.limitations.push('全市場逐檔涵蓋狀態見 marketCoverage；已列出官方公布資產不等於所有資產及配息窗口已獨立核對。');
 atomicWriteJson(file,db);
 console.log(JSON.stringify({fullMarket:db.marketCoverage.population,positions:db.holdings.items.length,
  fundsWithPositions:new Set(db.holdings.items.map(r=>r.ticker)).size,
  yieldAvailable:db.marketCoverage.items.filter(x=>x.yieldValue!==null).length,status:db.marketCoverage.status}));
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={main};
