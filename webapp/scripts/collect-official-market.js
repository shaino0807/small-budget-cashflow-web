const fs=require('node:fs'),path=require('node:path');
const {createSourceClient}=require('./official-source-client');
const recipes=require('./official-source-recipes.json').recipes;
const {today}=require('../etf-data');
async function collect(db,directory,{fetchImpl=fetch}={}){
 const client=createSourceClient(directory,{fetchImpl}),asOf=today();
 const tasks=[...recipes];
 for(const etf of db.etfs.filter(e=>/元大|富邦/.test(e.issuer))){
  const id=(/元大/.test(etf.issuer)?'yuanta-':'fubon-')+etf.ticker;
  if(!tasks.some(t=>t.id===id))tasks.push({id,url:/元大/.test(etf.issuer)?'https://www.yuantaetfs.com/product/detail/'+etf.ticker+'/ratio':'https://websys.fsit.com.tw/FubonETF/Fund/Assets.aspx?stkId='+etf.ticker});
 }
 for(const etf of db.etfs.filter(x=>x.listingMarket==='TPEx'))tasks.push({id:'tpex-product-'+etf.ticker,url:'https://info.tpex.org.tw/api/etfProduct?lang=zh-tw&query='+etf.ticker,method:'POST'});
 tasks.push({id:'tpex-fund-basic',url:'https://openapi.twse.com.tw/v1/opendata/t187ap47_O'});
 const rank=t=>/^(twse-|tpex-)|-(profile|basic|info|detail)-/.test(t.id)?0:/-assets-/.test(t.id)?1:/cathay-(stock|bond|future|fund|etf|buy|option|bal)-/.test(t.id)?2:3;
 let completed=0;
 for(const phase of [0,1,2,3]){
  const todo=tasks.filter(t=>rank(t)===phase);let next=0;
  await Promise.all(Array.from({length:2},async()=>{while(next<todo.length){
   const task={...todo[next++]};
   const url=new URL(task.url);
   if(task.id.startsWith('fhtrust-assets-')){const p=client.read(task.id.replace('assets','profile'))?.result?.[0];if(p?.navDate)url.searchParams.set('qDate',p.navDate);}
   if(/^cathay-(stock|bond|future|fund|etf|buy|option|bal)-/.test(task.id)){const ticker=task.id.split('-').at(-1),d=client.read('cathay-assets-'+ticker)?.result?.preDate;if(!d){completed++;continue;}url.searchParams.set('SearchDate',d.replaceAll('/','-'));}
   for(const key of ['EDate','eDate'])if(url.searchParams.has(key))url.searchParams.set(key,key==='EDate'?asOf.replaceAll('-',''):asOf.replaceAll('-','/'));
   task.url=url.toString();
   if(task.body){const text=typeof task.body==='string'?task.body:JSON.stringify(task.body);
    const current=text.replaceAll('2026-10-14',asOf).replaceAll('2026/10/14',asOf.replaceAll('-','/')).replaceAll('20261014',asOf.replaceAll('-',''));
    task.body=typeof task.body==='string'?current:JSON.parse(current);}
   if(task.formState&&task.id.startsWith('fubon-history-'))for(const key of Object.keys(task.body||{})){
    if(key.endsWith('$sDate'))task.body[key]='2024/01/01';
    if(key.endsWith('$eDate'))task.body[key]=asOf.replaceAll('-','/');
   }
   await client.get(task.id,task.url,{method:task.method,body:task.body,formState:task.formState});
   completed++;if(completed%25===0)console.log(JSON.stringify({phase:'official-source-collection',completed,total:tasks.length}));
   await client.sleep(150);
  }}));
 }
 await require('./collect-additional-issuers').collectAdditional(client,db,asOf);
 await require('./reconcile-market-events').collectEvents(client,db,asOf);
 const priceHistory=await require('./collect-price-history').collectPriceHistory(client,db,asOf);
 const read=id=>{const value=client.read(id);if(id==='twse-fund-basic')return [...(Array.isArray(value)?value:[]),...(Array.isArray(client.read('tpex-fund-basic'))?client.read('tpex-fund-basic'):[])];return value;};
 const population=db.etfs.map(e=>({stockNo:e.ticker,stockName:e.shortName,issuer:e.issuer,market:e.listingMarket,listingDate:e.listingDate,indexName:e.indexName}));
 const reference=require('./reconcile-market-events').reconcileEvents(require('./collect-additional-issuers').normalizeAdditional(require('./issuer-reference')({population,read,receipts:client.records(),asOf}),client),client);
 reference.priceHistory=priceHistory;
 fs.writeFileSync(path.join(directory,'reference.json'),JSON.stringify(reference,null,2)+'\n');
 return {reference,receipts:client.records(),read};
}
if(require.main===module){const file=process.env.ETF_DATABASE_PATH||path.join(__dirname,'../data/etf-database.json');const dir=process.argv[2]||path.join(path.dirname(file),'official-cache');collect(JSON.parse(fs.readFileSync(file)),dir).then(r=>console.log(JSON.stringify({done:true,receipts:r.receipts.length,assets:r.reference.items.filter(x=>x.assetSnapshot).length,history:r.reference.items.filter(x=>x.history?.completeWindow).length}))).catch(e=>{console.error(e);process.exitCode=1;});}
module.exports={collect};
