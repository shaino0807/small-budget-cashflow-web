const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {checkContent,inventory,sha256}=require("./data-batch");
const {refreshDatabase}=require("./refresh-official-database");
const {normalize,compare}=require("./verify-finmind-pilot");
function quote(){return {ticker:"0050",date:"2026-09-01",open:10,high:12,low:9,close:11,tradeVolume:1000,source:"twse-stock-day",sourceUrl:"https://www.twse.com.tw/exchangeReport/STOCK_DAY"};}
test("hash identifies identical invalid bytes, but content gate rejects the data",()=>{
 const bad={priceSeries:{items:[{...quote(),high:5}]}},bytes=JSON.stringify(bad);
 assert.equal(sha256(bytes),sha256(bytes));assert.equal(checkContent({},bad).status,"fail");
});
test("content gate blocks duplicates, future dates, missing close and negative volume",()=>{
 for(const rows of [[quote(),quote()],[{...quote(),date:"2999-01-01"}],[{...quote(),close:null}],[{...quote(),tradeVolume:-1}]]){
  assert.equal(checkContent({},{priceSeries:{items:rows}}).status,"fail");
 }
});
test("inventory records per-source dates and counts without inventing undated master dates",()=>{
 const rows=inventory({etfs:[{ticker:"0050",listingDate:"2003-06-30",performance:{source:"twse"}}],priceSeries:{items:[quote()]}});
 assert.equal(rows[0].coverage.from,null);assert.equal(rows[0].missingDateRows,1);
 const prices=rows.find(r=>r.dataset==="priceSeries");assert.equal(prices.rows,1);assert.equal(prices.sources[0].from,"2026-09-01");
});
test("successful batch output hash matches promoted bytes and records checks and versions",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"batch-audit-")),file=path.join(dir,"db.json");
 try{
  fs.writeFileSync(file,JSON.stringify({etfs:[],priceSeries:{items:[]}}));
  const result=refreshDatabase(file,{execute:()=>{}});
  const receipt=JSON.parse(fs.readFileSync(path.join(dir,"batches",result.metadata.dataBatch.batchId+".json")));
  assert.equal(receipt.outputFileSha256,sha256(fs.readFileSync(file)));
  assert.equal(receipt.checks.status,"pass");assert(receipt.version.codeSha256);assert(receipt.version.node);
  assert.equal(receipt.previousFileSha256.length,64);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test("rejected content leaves original file and a failed batch manifest",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"batch-reject-")),file=path.join(dir,"db.json");
 try{
  fs.writeFileSync(file,'{"etfs":[]}');const original=fs.readFileSync(file);
  assert.throws(()=>refreshDatabase(file,{execute:(_,candidate)=>fs.writeFileSync(candidate,JSON.stringify({etfs:[],priceSeries:{items:[{...quote(),high:1}]}}))}),/Content validation failed/);
  assert.deepEqual(fs.readFileSync(file),original);
  const receipt=JSON.parse(fs.readFileSync(path.join(dir,"batches",fs.readdirSync(path.join(dir,"batches"))[0])));
  assert.equal(receipt.checks.status,"fail");assert.equal(receipt.status,"failed");
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
const official=[{ticker:"0050",date:"2026-09-01",open:10,high:12,low:9,close:11,volume:1000}];
test("FinMind comparison fails on mismatch, duplicate or missing date and wrong code",()=>{
 assert.equal(compare("0050",official,official).status,"pass");
 for(const rows of [[],[...official,...official],[{...official[0],close:10}],[{...official[0],ticker:"0056"}]]){
  assert.equal(compare("0050",official,rows).status,"fail");
 }
});
test("FinMind schema/status and ROC dates are verified",()=>{
 assert.throws(()=>normalize("FinMind",{status:402,data:[]},"0050"));
 const rows=normalize("TWSE",{stat:"OK",data:[["115/09/01","1,000","","10","12","9","11"]]},"0050");
 assert.deepEqual(rows,official);
});
