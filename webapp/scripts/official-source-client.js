// Public official responses only. Receipts and raw bodies stay in the updater cache.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {atomicWriteJson}=require('./update-safety');
const {sha256}=require('./data-batch');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function redactFormState(bytes){
 const source=bytes.toString('utf8');if(!source.trimStart().startsWith('<'))return bytes;
 const clean=source.replace(/<input\b[^>]*>/gi,tag=>/\bname\s*=\s*["']__/i.test(tag)?tag.replace(/\bvalue\s*=\s*(["'])[\s\S]*?\1/i,'value=""'):tag);
 return clean===source?bytes:Buffer.from(clean);
}
function containsCredentials(value,depth=0){
 if(!value||typeof value!=='object'||depth>30)return false;
 return Object.entries(value).some(([key,v])=>/^(token|access_token|refresh_token|api_key|password|authorization)$/i.test(key)&&typeof v==='string'&&v.length||containsCredentials(v,depth+1));
}
function createSourceClient(directory,{fetchImpl=fetch,maxAgeMs=6*3600000}={}) {
 fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,'receipts.json');
 const records=new Map(fs.existsSync(file)?JSON.parse(fs.readFileSync(file)).map(r=>[r.id,r]):[]),blocked=new Set(),jars=new Map();
 const cooldowns=new Map();
 for(const r of records.values())if(r.blockedUntil&&Date.parse(r.blockedUntil)>Date.now()){
  const host=new URL(r.url).hostname;blocked.add(host);cooldowns.set(host,r.blockedUntil);
 }
 async function publicFetch(url,options,session){
  if(!session)return fetchImpl(url,options);
  const origin=new URL(url).origin,jar=jars.get(origin)||new Map();jars.set(origin,jar);
  for(let redirects=0;redirects<5;redirects++){
   const headers={...options.headers};if(jar.size)headers.Cookie=[...jar].map(([k,v])=>k+'='+v).join('; ');
   const xsrf=jar.get('X-XSRF-TOKEN')||jar.get('XSRF-TOKEN');if(xsrf)headers['X-XSRF-TOKEN']=decodeURIComponent(xsrf);
   const response=await fetchImpl(url,{...options,headers,redirect:'manual'});
   for(const cookie of response.headers.getSetCookie?.()||[]){const pair=cookie.split(';')[0],eq=pair.indexOf('=');if(eq>0)jar.set(pair.slice(0,eq),pair.slice(eq+1));}
   if(![301,302,303,307,308].includes(response.status))return response;
   const next=new URL(response.headers.get('location'),url);if(next.origin!==origin)throw Error('Cross-origin anonymous redirect rejected');
   await response.body?.cancel();url=next.toString();
   if(response.status===303||[301,302].includes(response.status)&&options.method==='POST')options={...options,method:'GET',body:undefined};
  }
  throw Error('Anonymous redirect limit');
 }
 function read(id){const r=records.get(id);if(r?.status!==200||!r.path)return null;try{const b=fs.readFileSync(path.join(directory,r.path));if(sha256(b)!==r.sha256)return null;const s=b.toString('utf8');try{return JSON.parse(s);}catch{return s;}}catch{return null;}}
 async function get(id,url,{method='GET',body,formState=false,transientParams,transientHeaders,anonymousSession=false,bootstrapUrl,nativeTransport=false}={}){
  if(!/^[A-Za-z0-9_-]+$/.test(id))throw Error('Invalid source identifier');
  const parsed=new URL(url);if(parsed.protocol!=='https:'||parsed.username||parsed.password)throw Error('Invalid public source URL');
  if([...parsed.searchParams.keys()].some(k=>/^(token|access_token|api_key|password|authorization)$/i.test(k)))throw Error('Credentials must stay in transient parameters');
  let publicParameters;
  if(typeof body==='object')publicParameters=body;
  else if(body){try{publicParameters=JSON.parse(body);}catch{publicParameters=Object.fromEntries(new URLSearchParams(body));}}
  publicParameters=Object.fromEntries(Object.entries(publicParameters||{}).filter(([k])=>!/^(__|token$|access_token$|api_key$|password$|authorization$|secret$)/i.test(k)));
  const requestSha256=sha256(Buffer.from(JSON.stringify({method,url,parameters:publicParameters})));
  const old=records.get(id);if(old?.url===url&&(old.requestSha256===requestSha256||method==='GET'&&!body)&&old.status===200&&Date.now()-Date.parse(old.retrievedAt)<maxAgeMs&&read(id)!==null)return read(id);
  if(blocked.has(parsed.hostname)){
   records.set(id,{id,url,method,requestParameters:publicParameters,requestSha256,retrievedAt:new Date().toISOString(),status:null,path:null,attempted:false,blockedUntil:cooldowns.get(parsed.hostname),error:'Host access limit; request not sent during cooldown'});
   atomicWriteJson(file,[...records.values()]);return null;
  }
  const at=new Date().toISOString();let record={id,url,method,requestParameters:publicParameters,requestSha256,retrievedAt:at,status:null,path:null,sourceDataDate:null};
  try{
   const headers={'User-Agent':'SmallBudgetCashflow-OfficialData/1.0',...transientHeaders};
   if(bootstrapUrl&&!jars.has(parsed.origin)){
    if(new URL(bootstrapUrl).origin!==parsed.origin)throw Error('Cross-origin bootstrap rejected');
    const initial=await publicFetch(bootstrapUrl,{signal:AbortSignal.timeout(20000)},true);
    if(!initial.ok)throw Error('Public bootstrap HTTP '+initial.status);await initial.body?.cancel();
   }
   if(formState){
    const page=await publicFetch(url,{signal:AbortSignal.timeout(20000)},anonymousSession);if(!page.ok)throw Error('Form HTTP '+page.status);
    const html=await page.text(),params=new URLSearchParams(body||{});
    for(const m of html.matchAll(/<input\b[^>]*name="(__[^"]+)"[^>]*value="([^"]*)"/g))params.set(m[1],require('./official-text').decode(m[2]));
    body=params.toString();headers['Content-Type']='application/x-www-form-urlencoded';
   } else if(body && typeof body==='object'){body=JSON.stringify(body);headers['Content-Type']='application/json';}
   else if(body){headers['Content-Type']=String(body).startsWith('{')?'application/json':'application/x-www-form-urlencoded';}
   const requestUrl=new URL(url);for(const [key,value] of Object.entries(transientParams||{}))requestUrl.searchParams.set(key,value);
   const options={method,body:method==='GET'?undefined:body,headers,signal:AbortSignal.timeout(20000)};
   const response=nativeTransport?await require('./official-native-fetch').nativeFetch(requestUrl,options):await publicFetch(requestUrl,options,anonymousSession);
   if(nativeTransport)record.transport='system-curl-verified-tls';
   record.status=response.status;
   if(response.url){const resolved=new URL(response.url);for(const key of ['token','access_token','api_key'])resolved.searchParams.delete(key);record.resolvedUrl=resolved.toString();}
   if([301,302,303,307,308,401,403,429].includes(response.status)){
    blocked.add(parsed.hostname);const retry=response.headers.get('retry-after'),seconds=/^\d+$/.test(retry||'')?Number(retry):0;
    record.blockedUntil=new Date(Math.max(Date.now()+3600000,seconds?Date.now()+seconds*1000:Date.parse(retry)||0)).toISOString();
    cooldowns.set(parsed.hostname,record.blockedUntil);throw Error('Source access/redirect limit; no retry this run or during cooldown');
   }
   if(!response.ok)throw Error('HTTP '+response.status);
   const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>12000000)throw Error('Official body exceeds size limit');chunks.push(chunk);}
   const wire=Buffer.concat(chunks);let json;try{json=JSON.parse(wire.toString('utf8'));}catch{}
   if(containsCredentials(json))throw Error('Credential-bearing response refused');
   const bytes=redactFormState(wire),digest=sha256(bytes),name=id+'-'+digest+'.raw';
   fs.writeFileSync(path.join(directory,name),bytes);record={...record,path:name,sha256:digest,bytes:bytes.length,completedAt:new Date().toISOString()};
   if(bytes!==wire){record.formStateRedacted=true;record.wireSha256=sha256(wire);}
  }catch(e){record.error=e.message;record.path=null;}
  records.set(id,record);atomicWriteJson(file,[...records.values()]);return read(id);
 }
 const bytes=id=>{const r=records.get(id);if(!r?.path||r.status!==200)return null;try{const b=fs.readFileSync(path.join(directory,r.path));return sha256(b)===r.sha256?b:null;}catch{return null;}};
 return {get,read,bytes,records:()=>[...records.values()],sleep};
}
module.exports={createSourceClient,redactFormState,containsCredentials};
