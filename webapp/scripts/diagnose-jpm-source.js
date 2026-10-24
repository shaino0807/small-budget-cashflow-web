// One public request; diagnostic evidence only, never a release-gate substitute.
const {officialFetch}=require('../portfolio-transport');
const {parseJpmProduct}=require('../portfolio-official');
const result={at:new Date().toISOString(),node:process.version,platform:process.platform,ticker:'00401A'};
const started=Date.now();
const safeCode=value=>typeof value==='string'&&/^[A-Z0-9_]{1,60}$/.test(value)?value:undefined;
(async()=>{
 try{
  const response=await officialFetch('https://am.jpmorgan.com/FundsMarketingHandler/product-data?cusip=TW00000401A1&country=tw&role=twetf&language=zh&userLoggedIn=false',{signal:AbortSignal.timeout(12000),redirect:'error',headers:{'User-Agent':'SmallBudgetCashflow/portfolio-validation'}});
  result.status=response.status;result.contentType=response.headers.get('content-type');
  if(!response.ok){await response.body?.cancel();return;}
  const reader=response.body.getReader(),chunks=[];let bytes=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>6000000)throw Error('Response size exceeded');chunks.push(Buffer.from(value));}}finally{await reader.cancel();}
  const raw=Buffer.concat(chunks).toString('utf8');result.bytes=bytes;
  result.challenge=/captcha|access denied|request rejected/i.test(raw);
  let json;try{json=JSON.parse(raw);}catch{result.json=false;return;}
  result.json=true;
  try{const d=parseJpmProduct(json,'00401A',new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei'}).format(new Date()));result.parsed=true;result.rows=d.stocks.length;result.holdingsDate=d.holdingsDate;}catch{result.parsed=false;}
 }catch(e){result.errorName=e.name;result.code=safeCode(e.code);result.causeCode=safeCode(e.cause?.code);result.messageCategory=/fetch failed|terminated/.test(e.message)?'network':/timeout/i.test(e.message)?'timeout':'other';}
 finally{result.elapsedMs=Date.now()-started;result.acceptance='not evaluated';console.log(JSON.stringify(result));}
})();
