// Explicit diagnostic command only; never imported by the application.
// No credentials, response headers, hidden form values or raw HTML are logged.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {createPortfolioMarket,taiwanDate}=require('../portfolio-market');
const {officialFetch}=require('../portfolio-transport');
const {text}=require('./official-text');
const TICKERS=['00904','00936','00947','00962','00987A'];
const EXPECTED = {"portfolio-market.js":"b1b12751cb4b9616c7e10c607010560f196ce334c64a95da07dbf055c20c5dd9","portfolio-official.js":"6397810b721a843940d81c908610c86524ac4b73d01c82b12d2f8d253013aa8d","portfolio-valuation.js":"99bbf7441dd26436b82e4eb41762f4e8d0e7c69236effbeab6e1ca47e589b43c","portfolio-overlap.js":"67e7a5ad4c0a01f827bcbbffec3c309813e5f380bd956c69e29cce5339623645","portfolio-transport.js":"bde1cd8ed08ec2dd8009ebbdbbe16e13cb9b7f6d29a4e71c2fa605586eec20b8","portfolio-scope.json":"c8391a10dcf6ab857e8202d923fbcfbc73258fe9fd3e7ffe77ba4f9d31e1ba1c","server.js":"9bc4668f1b9def185b9d8d8d905700af4499faedb5b057da5334cfe46395a0e7","app.js":"d9b3437449d31ce370c79d10608d769934f000e8015f4bb26f5048dbb2ea61b7"};
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function safeVisible(html){
 let value=text(String(html));
 if(/\b(?:password|passwd|pwd|secret|token|csrf|nonce|access[_-]?token|api[_-]?key|authorization|cookie|connection[ _]?string|viewstate|session[_-]?id|bearer)\b|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./i.test(value))return '[withheld: potentially sensitive visible content]';
 value=value.replace(/https?:\/\/[^\s<>]+/gi,url=>{try{const u=new URL(url);return u.origin+u.pathname+(u.search?'?[redacted]':'');}catch{return '[redacted URL]';}})
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[redacted email]')
  .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g,'[redacted IP]')
  .replace(/\b(?:[a-f0-9]{1,4}:){2,}[a-f0-9:]*\b/gi,'[redacted IP]')
  .replace(/[A-Z]:\\[^\s<>]+|\/(?:home|var|etc|usr|opt|app)\/[^\s<>]+/gi,'[redacted path]')
  .replace(/\b[A-Za-z0-9_+=/-]{32,}\b/g,'[redacted opaque value]');
 return value.slice(0,1500);
}
async function boundedSample(response){
 const reader=response.clone().body?.getReader();if(!reader)return {complete:true,bytes:0,body:''};
 const chunks=[];let bytes=0,complete=false;
 try{for(;;){const r=await reader.read();if(r.done){complete=true;break;}bytes+=r.value.length;chunks.push(Buffer.from(r.value).subarray(0,Math.max(0,4096-chunks.reduce((s,b)=>s+b.length,0))));if(bytes>4096)break;}}
 finally{void reader.cancel().catch(()=>{});}
 const prefix=Buffer.concat(chunks),result={complete,bytesObserved:bytes,prefixSha256:hash(prefix)};
 if(complete){result.bytes=bytes;result.wireSha256=hash(prefix);result.body=new TextDecoder('utf-8',{fatal:true}).decode(prefix);}
 return result;
}
function binding(){return Object.entries(EXPECTED||{}).map(([file,expected])=>{const actual=hash(fs.readFileSync(path.join(__dirname,'..',file),'utf8').replace(/\r\n/g,'\n'));return {file,expected,actual,matches:actual===expected};});}
async function main(){
 const result={at:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,asOf:taiwanDate(Date.now()),baseProductCommit:'71899e0be845402bf4e58353a86873a1f19cf4b4',scope:'Diagnostic only; unchanged production loaders with ephemeral empty cache. Instrumented response sampling is not a latency or financial acceptance test.',bindings:binding(),responses:[]};
 assert(result.bindings.length===8&&result.bindings.every(r=>r.matches),'Production source binding mismatch');
 const cacheDir=fs.mkdtempSync(path.join(os.tmpdir(),'taishin-diagnostic-'));
 const fetchImpl=async(url,options)=>{
  const u=new URL(url);if(u.hostname!=='www.tsit.com.tw')return officialFetch(url,options);
  const id=u.pathname.match(/\/(00904|00936|00947|00962|00987A)$/)?.[1]||new URLSearchParams(options.body).get('id');
  const record={ticker:TICKERS.includes(id)?id:null,stage:u.pathname.includes('/Pcf/')?'pcf':u.pathname.endsWith('/PartialHistoryFundNav')?'nav':'profile',url:u.origin+u.pathname+(u.pathname.includes('/Pcf/')?'?FundType=ALL&DataDate='+u.searchParams.get('DataDate'):''),method:options.method,at:new Date().toISOString(),productionUserAgent:options.headers['User-Agent']==='SmallBudgetCashflow/portfolio-validation'};
  result.responses.push(record);const started=Date.now();
  try{const response=await officialFetch(url,options);record.status=response.status;
   try{const sample=await boundedSample(response);record.bodyComplete=sample.complete;record.bytes=sample.bytes;record.bytesObserved=sample.bytesObserved;record.wireSha256=sample.wireSha256;record.prefixSha256=sample.prefixSha256;
    if(sample.complete){record.title=safeVisible(sample.body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]||'');record.visibleBody=safeVisible(sample.body);record.denialOrChallenge=/captcha|cf-chl-|access denied|request rejected|unauthorized|forbidden|機器人驗證|存取遭拒/i.test(text(sample.body));}
   }catch(e){record.samplingError=e.name==='AbortError'?'aborted':e.name==='TimeoutError'?'timeout':'sample unavailable';}
   return response;
  }catch(e){record.fetchError=e.name==='TimeoutError'?'timeout':e.name==='AbortError'?'aborted':'network failure';throw e;}
  finally{record.elapsedMs=Date.now()-started;}
 };
 const market=createPortfolioMarket({cacheDir,fetchImpl,allowNetwork:true}),job=market.start(TICKERS),started=Date.now();let current=job;
 while(current.status==='running'&&Date.now()-started<57000){await new Promise(r=>setTimeout(r,200));current=market.status(job.id);}
 result.elapsedMs=Date.now()-started;result.jobStatus=current.status;
 result.funds=Object.entries(current.data).map(([ticker,d])=>({ticker,status:d.status,message:d.message?safeVisible(d.message):null,observedAt:d.observedAt,valuationDate:d.valuationVerification?.date,rows:d.stocks?.length}));
 result.capturedSmallResponses=result.responses.filter(r=>r.bodyComplete).length;
 result.diagnosticCompleted=true;result.financialAcceptance='not evaluated';result.finishedAt=new Date().toISOString();
 if(process.argv[2])fs.writeFileSync(process.argv[2],JSON.stringify(result,null,2));
 console.log(JSON.stringify(result,null,2));
}
function selfTest(){
 assert(!safeVisible('<input value="SYNTHETIC_PRIVATE_FORM"><script>SYNTHETIC_PRIVATE_SCRIPT</script><p>public error</p>').includes('SYNTHETIC_PRIVATE'));
 for(const secret of ['password=TEST_PRIVATE','access_token=TEST_PRIVATE','Bearer TEST_PRIVATE','connection string=TEST_PRIVATE','eyJabc.def.ghi'])assert(!safeVisible('<p>'+secret+'</p>').includes('TEST_PRIVATE'));
 assert.equal(safeVisible('eyJabc.def.ghi'),'[withheld: potentially sensitive visible content]');
 const safe=safeVisible('<p>Error person@example.com 192.0.2.123 C:\\private\\file /var/private/file https://example.com/path?q=abc</p>');
 assert(!safe.includes('person@'));assert(!safe.includes('192.0.2.123'));assert(!safe.includes('C:\\private'));assert(!safe.includes('/var/private'));assert(!safe.includes('q=abc'));
 assert.equal(safeVisible('<title>Error</title><h2>Service temporarily unavailable</h2>'),'Error Service temporarily unavailable');
 console.log(JSON.stringify({selfTestPassed:true,scope:'Diagnostic output redaction only; no network requests'}));
}
if(require.main===module){if(process.argv.includes('--self-test'))selfTest();else main().catch(()=>{console.error(JSON.stringify({diagnosticCompleted:false,error:'Diagnostic failed; raw exception deliberately withheld'}));process.exitCode=1;});}
module.exports={safeVisible};
