const test=require('node:test'),assert=require('node:assert/strict');
const {createPublicReadQueue}=require('../portfolio-public-read');
const signal=()=>new AbortController().signal;
test('public reads serialize across funds and recover from a transient timeout once',async()=>{
  const read=createPublicReadQueue({intervalMs:0});let active=0,peak=0,attempts=0;
  const values=await Promise.all(Array.from({length:6},(_,i)=>read(async()=>{
    active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,2));active--;
    if(i===0&&++attempts===1)throw new DOMException('timed out','TimeoutError');return i;
  },signal())));
  assert.deepEqual(values,[0,1,2,3,4,5]);assert.equal(peak,1);assert.equal(attempts,2);
});
test('retry is bounded; TLS, HTTP denial, challenge and data errors are never retried',async()=>{
  for(const [error,expected] of [[new DOMException('timed out','TimeoutError'),2],[Object.assign(Error('fetch failed'),{cause:{code:'ECONNRESET'}}),2],[Object.assign(Error('fetch failed'),{cause:{code:'CERT_HAS_EXPIRED'}}),1],[Error('官方來源 HTTP 403'),1],[Error('captcha'),1],[Error('invalid weights'),1],[Error('fetch failed'),1]]){
    const read=createPublicReadQueue({intervalMs:0});let calls=0;
    await assert.rejects(read(async()=>{calls++;throw error;},signal()));assert.equal(calls,expected);
  }
});
test('expired queued jobs do not read or block later jobs; abort prevents retry',async()=>{
  const read=createPublicReadQueue({intervalMs:0});let release,calls=0;
  const first=read(()=>new Promise(r=>release=r),signal());
  while(!release)await new Promise(r=>setTimeout(r,1));
  const controller=new AbortController();const second=read(()=>{calls++;},controller.signal);controller.abort();
  await assert.rejects(second);assert.equal(calls,0);release('first');await first;
  assert.equal(await read(async()=>42,signal()),42);
  const expired=new AbortController();await assert.rejects(read(async()=>{calls++;expired.abort();throw new DOMException('timeout','TimeoutError');},expired.signal));assert.equal(calls,1);
});
test('successful response, including a challenge body, is passed to the existing parser exactly once',async()=>{
  const read=createPublicReadQueue({intervalMs:0});let calls=0;const response={text:'captcha'};
  assert.equal(await read(async()=>{calls++;return response;},signal()),response);assert.equal(calls,1);
});
