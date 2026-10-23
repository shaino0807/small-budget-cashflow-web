// Explicit live acceptance command; never imported by the running application.
// Uses public ETF codes only, an ephemeral cache, and no production credentials.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const {METHODS}=require('../portfolio-valuation');
const wait=ms=>new Promise(r=>setTimeout(r,ms)),dir=fs.mkdtempSync(path.join(os.tmpdir(),'portfolio-runtime-'));
const target='http://127.0.0.1:5197',tickers=[...Object.keys(METHODS),'00401A','00918'];
let server;const result={at:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,tickers,tests:[]};
async function main(){
  const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,PORT:'5197',SMOKE_TEST:'0',CUSTOMER_DATA_DIR:dir,CUSTOMER_DATA_KEY:crypto.randomBytes(32).toString('base64'),ACCESS_CODE_PEPPER:crypto.randomBytes(32).toString('hex'),ADMIN_API_KEY:crypto.randomBytes(32).toString('hex'),ALLOWED_ORIGINS:target,LINE_REPLY_DISABLED:'1',LINE_IMAGE_PARSER_ENABLED:'0',LINE_AI_PARSER_ENABLED:'0',LINE_VOICE_TRANSCRIPTION_ENABLED:'0',LINE_RICH_MENU_AUTO_DEPLOY:'0'};
  server=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let logs='';server.stdout.on('data',b=>logs+=b);server.stderr.on('data',b=>logs+=b);
  let healthy=false;for(let i=0;i<100;i++){try{healthy=(await fetch(target+'/api/health')).ok;if(healthy)break;}catch{}await wait(100);}assert(healthy,'isolated API starts: '+logs.slice(-1000));
  const started=Date.now(),r=await fetch(target+'/api/market/portfolio',{method:'POST',headers:{'Content-Type':'application/json',Origin:target},body:JSON.stringify({tickers})});
  assert.equal(r.status,202);let job=(await r.json()).job;assert(job.id);assert.equal(job.completed,0);result.tests.push('uncached request returns immediate pending job');const progress=[];
  while(Date.now()-started<61000){const response=await fetch(target+'/api/market/portfolio/'+job.id);assert(response.ok);job=(await response.json()).job;progress.push({completed:job.completed,total:job.total,status:job.status,elapsedMs:job.elapsedMs});if(job.status!=='running')break;await wait(250);}
  result.elapsedMs=Date.now()-started;result.progress=progress;result.funds=Object.entries(job.data||{}).map(([ticker,d])=>({ticker,status:d.status,message:d.message,holdingsDate:d.holdingsDate,valuationDate:d.valuationVerification?.date,matched:d.valuationVerification?.matchedRows,total:d.stocks?.length,observedAt:d.observedAt}));
  assert.equal(job.status,'finished',JSON.stringify(result.funds));assert(result.elapsedMs<60000);assert.equal(result.funds.length,tickers.length);
  for(const ticker of Object.keys(METHODS)){const d=job.data[ticker];assert.equal(d.status,'observed');assert.equal(d.holdingsDate,null);assert.equal(d.valuationVerification.status,'verified');assert.equal(d.valuationVerification.matchedRows,d.stocks.length);assert.match(d.issues.join(' '),/實際持股基準日未公開/);}
  for(const ticker of ['00401A','00918']){assert.equal(job.data[ticker].status,'observed');assert(job.data[ticker].holdingsDate);}
  result.tests.push('all 12 valuation dates and 2 repaired official sources pass in the actual runtime');
  const repeated=await fetch(target+'/api/market/portfolio',{method:'POST',headers:{'Content-Type':'application/json',Origin:target},body:JSON.stringify({tickers})});let cached=(await repeated.json()).job;for(let i=0;i<20;i++){cached=(await(await fetch(target+'/api/market/portfolio/'+cached.id)).json()).job;if(cached.status!=='running')break;await wait(50);}assert(Object.values(cached.data).every(d=>d.status==='cached'));result.tests.push('successful evidence persists and reuses within the same-day five-minute limit');
  for(const file of ['/portfolio-market.js','/portfolio-official.js','/portfolio-valuation.js','/portfolio-transport.js','/certificates/chunghwa-gcc-r46-ov-tls-2025.pem'])assert.equal((await fetch(target+file)).status,404);result.tests.push('backend source and certificate are not served publicly');result.pass=true;
}
main().catch(e=>{result.pass=false;result.error=e.stack;process.exitCode=1;}).finally(()=>{
  server?.kill();
  const sources=path.join(dir,'portfolio-market','sources');
  result.sourceDiagnostics=[];
  if(fs.existsSync(sources))for(const file of fs.readdirSync(sources).filter(f=>/^[a-f0-9]{64}\.json$/.test(f))){
    const receipt=JSON.parse(fs.readFileSync(path.join(sources,file)));if(!receipt.url.includes('tsit.com.tw'))continue;
    const body=fs.readFileSync(path.join(sources,file.replace('.json','.raw')),'utf8');
    result.sourceDiagnostics.push({url:receipt.url,status:receipt.httpStatus,sha256:receipt.sha256,bytes:Buffer.byteLength(body),
      title:body.match(/<title[^>]*>([^<]*)/i)?.[1]?.slice(0,150),
      selectedCodesPresent:tickers.filter(t=>body.includes(t)),challengeDetected:/captcha|cf-chl-|access denied|request rejected|機器人驗證/i.test(body)});
  }
  const output=process.argv[2];if(output)fs.writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
});
