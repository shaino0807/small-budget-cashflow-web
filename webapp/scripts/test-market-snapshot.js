const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createMarketSnapshot, verifySnapshot } = require('../market-snapshot');
const { sha256 } = require('./data-batch');
function fixture(id, time, close = 100) {
  const batch = { batchId:id, finishedAt:time, version:{commit:'test',node:process.version} };
  const db = { metadata:{dataBatch:batch}, etfs:[{ticker:'0050'}], priceSeries:{items:[{ticker:'0050',date:'2026-09-01',close}]} };
  const bytes=Buffer.from(JSON.stringify(db));
  return {db,bytes,manifest:{...batch,schemaVersion:1,promotion:'validated_candidate',status:'pass',checks:{status:'pass',errors:[]},outputFileSha256:sha256(bytes)}};
}
function setup(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'market-snapshot-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const old=fixture('old-batch-0001','2026-09-01T00:00:00Z');
  fs.mkdirSync(path.join(dir,'batches'));
  fs.writeFileSync(path.join(dir,'database.json'),old.bytes);
  fs.writeFileSync(path.join(dir,'batches',old.manifest.batchId+'.json'),JSON.stringify(old.manifest));
  const next=fixture('new-batch-0002','2026-09-02T00:00:00Z',101);
  let fail=false,requests=0;
  const options={bundledPath:path.join(dir,'database.json'),directory:path.join(dir,'persistent'),sourceBase:'https://example.test/',ttlMs:0,
    fetchImpl:async url=>{requests++; if(fail)throw new Error('offline');return new Response(String(url).endsWith('latest-batch.json')?JSON.stringify(next.manifest):next.bytes);}};
  return {old,next,options,setFail:()=>{fail=true;},requests:()=>requests};
}
test('canonical bytes and receipt survive service restart and read back from disk',async t=>{
 const f=setup(t),s=createMarketSnapshot(f.options);await s.sync();
 assert.equal(s.status().status,'current');assert.equal(s.status().persistentReadback,true);
 assert.deepEqual(s.read().bytes,f.next.bytes);assert.equal(s.status().manifestVerified,true);
 const restarted=createMarketSnapshot(f.options);assert.deepEqual(restarted.read().bytes,f.next.bytes);
});
test('upstream outage preserves the complete previous snapshot and reports stale status',async t=>{
 const f=setup(t),s=createMarketSnapshot(f.options);await s.sync(); f.setFail();await s.sync();
 assert.equal(s.status().status,'preserved_previous');assert.deepEqual(s.read().bytes,f.next.bytes);
});
test('hash mismatch is rejected without replacing the pointer',async t=>{
 const f=setup(t);f.next.manifest.outputFileSha256='0'.repeat(64);const s=createMarketSnapshot(f.options);await s.sync();
 assert.equal(s.status().persistentReadback,false);assert.deepEqual(s.read().bytes,f.old.bytes);
});
test('rollback, missing history, changed batch identity and invalid numeric content are rejected',()=>{
 const old=fixture('old-batch-0001','2026-09-01T00:00:00Z');
 const next=fixture('new-batch-0002','2026-09-02T00:00:00Z');
 assert.throws(()=>verifySnapshot(old.bytes,old.manifest,next.db),/rollback/);
 assert.throws(()=>verifySnapshot(next.bytes,{...next.manifest,batchId:'wrong-batch-000'},old.db),/mismatch/);
 const bad=fixture('bad-batch-0003','2026-09-03T00:00:00Z',-1);
 assert.throws(()=>verifySnapshot(bad.bytes,bad.manifest,old.db),/content/);
 const lost={...next.db,priceSeries:{items:[]}}, bytes=Buffer.from(JSON.stringify(lost));
 assert.throws(()=>verifySnapshot(bytes,{...next.manifest,outputFileSha256:sha256(bytes)},old.db),/history lost/);
});
test('parallel readers share one bounded download',async t=>{
 const f=setup(t),s=createMarketSnapshot(f.options);await Promise.all([s.sync(),s.sync(),s.sync()]);assert.equal(f.requests(),2);
});

test('full-market source and validation receipts larger than 2 MB still synchronize',async t=>{
 const f=setup(t);f.next.manifest.sourceEvidence='x'.repeat(2400000);
 const s=createMarketSnapshot(f.options);await s.sync();
 assert.equal(s.status().batchId,f.next.manifest.batchId);assert.equal(s.status().manifestVerified,true);
});
test('corrupt persisted data is detected on read and falls back to bundled bytes',async t=>{
 const f=setup(t),s=createMarketSnapshot(f.options);await s.sync();
 fs.writeFileSync(path.join(f.options.directory,f.next.manifest.batchId+'.data.json'),'{}');
 assert.deepEqual(s.read().bytes,f.old.bytes);assert.equal(s.status().status,'preserved_previous');
});

test('same-batch sync detects disk corruption without claiming a fresh readback',async t=>{
 const f=setup(t),s=createMarketSnapshot(f.options);await s.sync();
 fs.writeFileSync(path.join(f.options.directory,f.next.manifest.batchId+'.data.json'),'{}');
 const result=await s.sync();assert.equal(result.status,'preserved_previous');assert.equal(result.persistentReadback,false);
 assert.deepEqual(s.current().bytes,f.next.bytes,'customer reads keep the verified memory snapshot');
});
test('credentials and insecure source URLs are refused',t=>{
 const f=setup(t);for(const sourceBase of ['http://example.test/','https://secret@example.test/'])assert.throws(()=>createMarketSnapshot({...f.options,sourceBase}),/HTTPS/);
});
