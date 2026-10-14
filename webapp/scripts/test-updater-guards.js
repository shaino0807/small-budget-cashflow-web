const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const { refreshStockMaster, sources } = require("./update-stock-master");
const { refreshEtfMaster } = require("./update-etf-master");
const { refreshDatabase, validatePreservation, steps } = require("./refresh-official-database");
const { officialDate, toNumber } = require("./update-safety");
const { resolveEtf } = require("../etf-data");
const catalogs = require("./fixtures/etf-catalogs-20261014.json");
const now = "2026-10-14T08:00:00Z";
const fail = async () => { throw new Error("simulated offline"); };
function seed() {
  return { metadata: {}, etfs: [], holdings: { items: [] }, stocks: { updatedAt: "2026-10-12T08:00:00Z", items: [
    { ticker: "2330", name: "台積電", market: "TWSE", industry: "半導體", latestPrice: { date: "2026-10-12", close: 100, observedAt: "2026-10-12T08:00:00Z", source: sources.TWSE.id } },
    { ticker: "2317", name: "鴻海", market: "TWSE", latestPrice: { date: "2026-10-12", close: 90, source: sources.TWSE.id } },
    { ticker: "6488", name: "環球晶", market: "TPEx", industry: "半導體", latestPrice: { date: "2026-10-12", close: 80, observedAt: "2026-10-12T08:00:00Z", source: sources.TPEx.id } }
  ] } };
}
const company = [{ "公司代號": "2330", "公司名稱": "台積電", "公司簡稱": "台積電" }];
const twse = [{ Code: "2330", Date: "20261013", ClosingPrice: "101", OpeningPrice: "100", TradeVolume: "1,000" }];
const tpex = [{ SecuritiesCompanyCode: "6488", CompanyName: "環球晶", Date: "1151013", Close: "81" }];
function fetcher(values) { return async (url) => { const value = values[url]; if (value instanceof Error || value === undefined) throw new Error("offline"); return structuredClone(value); }; }
function stockOptions(a=company,b=twse,c=tpex) { return { now, fetchJson: fetcher({ [sources.company.url]: a, [sources.TWSE.url]: b, [sources.TPEx.url]: c }) }; }
function stock(db,ticker) { return db.stocks.items.find((r)=>r.ticker===ticker); }
function etfOptions(extra={}) { return { now, classificationFilters: [], fetchProducts: async()=>catalogs.TWSE.rows, fetchTpex: async()=>catalogs.TPEx.rows, ...extra }; }
function temp(run) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"updater-guards-"));
  try { return run(path.join(dir,"db.json"),dir); } finally { fs.rmSync(dir,{recursive:true,force:true}); }
}
function child(script,file) {
  return spawnSync(process.execPath,[path.join(__dirname,script)],{ env:{...process.env,ETF_DATABASE_PATH:file},encoding:"utf8",windowsHide:true,timeout:20000 });
}
test("official calendar dates and numeric blanks are validated",()=>{
  for(const [input,expected] of [["1151013","2026-10-13"],["20261013","2026-10-13"],["2026.10.13","2026-10-13"],["2028-02-29","2028-02-29"],["2026-02-30",null],["1151331",null],["",null]]) assert.equal(officialDate(input),expected);
  for(const value of ["", " ", null, "--", "NaN", "Infinity"]) assert.equal(toNumber(value),null);
  assert.equal(toNumber("1,234.50"),1234.5);
});
test("TWSE Date and TPEx ROC date load; omitted stock retains its exact price",async()=>{
  const before=seed(),after=await refreshStockMaster(before,stockOptions());
  assert.equal(stock(after,"2330").latestPrice.date,"2026-10-13");
  assert.equal(stock(after,"6488").latestPrice.date,"2026-10-13");
  assert.deepEqual(stock(after,"2317").latestPrice,stock(before,"2317").latestPrice);
  assert.equal(stock(after,"2317").priceRefreshStatus,"preserved_previous");
  assert.equal(stock(after,"6488").industry,"半導體");
  assert.deepEqual(before,seed(),"input not mutated");
});
for (const market of ["TWSE","TPEx"]) test(market+" source failure preserves that market while the other updates",async()=>{
  const before=seed();
  const actual=await refreshStockMaster(before,stockOptions(company,market==="TWSE"?new Error():twse,market==="TPEx"?new Error():tpex));
  const retained=market==="TWSE"?"2330":"6488",updated=market==="TWSE"?"6488":"2330";
  assert.deepEqual(stock(actual,retained).latestPrice,stock(before,retained).latestPrice);
  assert.equal(stock(actual,retained).priceRefreshStatus,"preserved_previous");
  assert.equal(stock(actual,updated).latestPrice.date,"2026-10-13");
});
for(const [name,options] of [
  ["all sources unavailable",{now,fetchJson:fail}],
  ["empty responses",stockOptions([],[],[])],
  ["wrong response schema",stockOptions({}, {}, {})]
]) test(name+" preserves all previous prices",async()=>{
  const before=seed(),after=await refreshStockMaster(before,options);
  for(const row of before.stocks.items) assert.deepEqual(stock(after,row.ticker).latestPrice,row.latestPrice);
  assert.equal(after.stocks.updatedAt,before.stocks.updatedAt);
  assert(after.stocks.sourceAttempts.every(a=>a.status==="failed"));
});
for(const [name,changes] of [
  ["invalid calendar",{Date:"20260230"}],["missing date",{Date:""}],["future date",{Date:"20261015"}],
  ["older date",{Date:"20261011"}],["blank price",{ClosingPrice:" "}],["zero price",{ClosingPrice:"0"}],["negative price",{ClosingPrice:"-1"}]
]) test(name+" cannot replace a valid price",async()=>{
  const before=seed(),after=await refreshStockMaster(before,stockOptions(company,[{...twse[0],...changes}],tpex));
  assert.deepEqual(stock(after,"2330").latestPrice,stock(before,"2330").latestPrice);
  assert.equal(stock(after,"6488").latestPrice.close,81);
});
test("duplicate stock quotes are rejected instead of last row winning",async()=>{
  const after=await refreshStockMaster(seed(),stockOptions(company,[twse[0],{...twse[0],ClosingPrice:"999"}],tpex));
  assert.equal(stock(after,"2330").latestPrice.close,100);
});
test("company refresh alone cannot erase a price",async()=>{
  const after=await refreshStockMaster(seed(),stockOptions(company,[],[]));
  assert.equal(stock(after,"2330").latestPrice.close,100);
});
test("six-digit listed TDR stock codes retain official master and price support",async()=>{
  const after=await refreshStockMaster(seed(),stockOptions(
    [{"公司代號":"910322","公司名稱":"康師傅-DR"}],
    [{Code:"910322",Date:"1151013",ClosingPrice:"12.5"}],[]));
  assert.equal(stock(after,"910322").latestPrice.close,12.5);
});
test("freshness describes TWSE dates and independently retained TPEx dates",async()=>{
  const db=await refreshStockMaster(seed(),stockOptions(company,twse,new Error()));
  temp(file=>{
    fs.writeFileSync(file,JSON.stringify(db));
    const result=child("finalize-data-quality.js",file);assert.equal(result.status,0,result.stderr);
    const sources=JSON.parse(fs.readFileSync(file)).metadata.sourceFreshness.sources;
    assert.equal(sources.twseStockDaily.sourceDataDate,"2026-10-13");
    assert.equal(sources.twseStockDaily.status,"partial_snapshot");
    assert.equal(sources.twseStockDaily.oldestSourceDataDate,"2026-10-12");
    assert.equal(sources.tpexStockDaily.sourceDataDate,"2026-10-12");
    assert.equal(sources.tpexStockDaily.status,"preserved_previous_snapshot");
    assert.equal(sources.tpexStockDaily.observedAt,"2026-10-12T08:00:00Z");
  });
});
test("official snapshot catalogs: all 359 codes and Chinese names resolve without inventing unknown indexes",async()=>{
  const after=await refreshEtfMaster({etfs:[]},etfOptions());
  assert.equal(after.etfs.length,359);
  assert.equal(after.etfs.filter(r=>r.listingMarket==="TWSE").length,241);
  assert.equal(after.etfs.filter(r=>r.listingMarket==="TPEx").length,118);
  for(const market of ["TWSE","TPEx"]) for(const row of catalogs[market].rows){
    const found=resolveEtf(after,row.stockNo);
    assert.equal(found?.ticker,row.stockNo); assert.equal(resolveEtf(after,row.stockName)?.ticker,row.stockNo);
    assert.equal(found.listingMarket,market); assert.equal(found.shortName,row.stockName);
    assert.equal(found.issuer,row.issuer); assert.equal(found.listingDate,officialDate(row.listingDate));
    assert.equal(found.indexName,String(row.indexName??"").trim());
    assert.equal(found.performance.date,null);
  }
  assert.equal(resolveEtf(after,"00411A").indexNameStatus,"official_field_empty");
  assert.equal(resolveEtf(after,"00679B").qualityFlags.includes("price_series_missing"),true);
});
test("one master source fails: preserve its entries while accepting the other market",async()=>{
  const before=await refreshEtfMaster({etfs:[]},etfOptions());
  for(const market of ["TWSE","TPEx"]){
    const after=await refreshEtfMaster(before,etfOptions(market==="TWSE"?{fetchProducts:fail}:{fetchTpex:fail}));
    assert.equal(after.etfs.length,359);
    for(const row of after.etfs.filter(r=>r.listingMarket===market)){
      const old=before.etfs.find(r=>r.ticker===row.ticker);
      assert.equal(row.masterObservedAt,old.masterObservedAt);
      assert.equal(row.masterRefreshStatus,"preserved_previous");
      assert.equal(row.indexName,old.indexName);
    }
  }
});
test("empty catalogs, incomplete identity and duplicates cannot remove an existing ETF",async()=>{
  const before=await refreshEtfMaster({etfs:[]},etfOptions());
  for(const rows of [[],[{...catalogs.TWSE.rows[0],issuer:""}],[catalogs.TWSE.rows[0],catalogs.TWSE.rows[0]]]){
    const after=await refreshEtfMaster(before,etfOptions({fetchProducts:async()=>rows,fetchTpex:fail}));
    assert.equal(after.etfs.length,359);
    assert.equal(after.etfs[0].masterRefreshStatus,"preserved_previous");
  }
  await assert.rejects(refreshEtfMaster({etfs:[]},etfOptions({fetchProducts:fail,fetchTpex:fail})),/No usable/);
});
test("blank official index does not retain a fabricated old no-index claim",async()=>{
  const row={...catalogs.TWSE.rows[0],indexName:null};
  const after=await refreshEtfMaster({etfs:[{ticker:row.stockNo,indexName:"無"}]},etfOptions({fetchProducts:async()=>[row],fetchTpex:fail}));
  assert.equal(after.etfs[0].indexName,"");
  assert.equal(after.etfs[0].indexNameStatus,"official_field_empty");
});
test("partly failing classification filters do not erase previous official tags",async()=>{
  const row=catalogs.TWSE.rows.find(r=>r.stockNo==="0050");
  const after=await refreshEtfMaster({etfs:[{ticker:"0050",themes:["大型權值"]}]},etfOptions({
    classificationFilters:[{field:"hashtag",value:"good",target:"themes",label:"全市場指數"},{field:"hashtag",value:"offline",target:"themes",label:"大型權值"}],
    fetchProducts:async(params)=>{if(params?.hashtag==="offline")throw Error("offline");return [row];},fetchTpex:fail
  }));
  assert.deepEqual(resolveEtf(after,"0050").themes,["大型權值","全市場指數"]);
});
test("upcoming 00415A with no official issuer is rejected; zero ETF close cannot erase a known price",async()=>{
  const incomplete={stockNo:"00415A",stockName:"主動群益核心50",listingDate:"2026.10.20",indexName:null,close1:"0",issuer:null};
  const valid={...catalogs.TWSE.rows.find(r=>r.stockNo==="0050"),close1:"0"};
  const after=await refreshEtfMaster({etfs:[{ticker:"0050",close:100}]},etfOptions({fetchProducts:async()=>[incomplete,valid],fetchTpex:fail}));
  assert.equal(resolveEtf(after,"00415A"),null);
  assert.equal(resolveEtf(after,"0050").close,100);
  assert(after.etfMaster.sourceAttempts.some(a=>a.rejected?.some(r=>r.ticker==="00415A")));
});
test("refreshed master and stock rows pass the real finalizer and validator on a database copy",async()=>{
  const original=JSON.parse(fs.readFileSync(path.join(__dirname,"../data/etf-database.json"),"utf8"));
  let db=await refreshEtfMaster(original,etfOptions());
  db=await refreshStockMaster(db,stockOptions());
  validatePreservation(original,db);
  temp(file=>{
    fs.writeFileSync(file,JSON.stringify(db));
    const finalizer=child("finalize-data-quality.js",file);assert.equal(finalizer.status,0,finalizer.stderr);
    const validator=child("validate-etf-data.js",file);
    const result=JSON.parse(validator.stdout);
    assert.equal(validator.status,0,JSON.stringify(result.errors));
    assert(result.counts.etfs>=359);
    assert(result.warnings.some(w=>w.includes("追蹤指數空白")),"unknown index remains an explicit gap");
  });
});
for(const failedStep of steps) test("candidate failure at "+failedStep+" leaves original bytes and cleans staging",()=>{
  temp((file,dir)=>{
    fs.writeFileSync(file,JSON.stringify(seed()));const before=fs.readFileSync(file);
    assert.throws(()=>refreshDatabase(file,{execute:(step,candidate)=>{
      assert.notEqual(candidate,file);
      if(step===failedStep){fs.writeFileSync(candidate,"broken");throw new Error("injected failure");}
    }}),/injected failure/);
    assert.deepEqual(fs.readFileSync(file),before); assert.deepEqual(fs.readdirSync(dir).sort(),["batches","db.json"]);
    const records=fs.readdirSync(path.join(dir,"batches"));assert.equal(records.length,1);
    const receipt=JSON.parse(fs.readFileSync(path.join(dir,"batches",records[0])));
    assert.equal(receipt.status,"failed");assert.equal(receipt.promotion,"rejected");
  });
});
test("successful exit cannot bypass destructive-candidate rejection",()=>{
  temp(file=>{
    fs.writeFileSync(file,JSON.stringify(seed()));const before=fs.readFileSync(file);
    assert.throws(()=>refreshDatabase(file,{execute:(_,candidate)=>fs.writeFileSync(candidate,JSON.stringify({etfs:[],stocks:{items:[]}}))}),/Stock master lost/);
    assert.deepEqual(fs.readFileSync(file),before);
  });
});
test("price date regression and ETF/history removal are blocked at promotion",()=>{
  const before=seed();before.etfs=[{ticker:"0050"}];before.priceSeries={items:[{ticker:"0050",date:"2026-10-12",close:10}]};
  for(const mutate of [a=>a.etfs=[],a=>a.priceSeries.items=[],a=>a.stocks.items[0].latestPrice.date="2026-10-11",a=>a.stocks.items[0].latestPrice.close=null]){
    const after=structuredClone(before);mutate(after);assert.throws(()=>validatePreservation(before,after));
  }
});
test("concurrent file changes block stale promotion",()=>{
  temp(file=>{
    fs.writeFileSync(file,JSON.stringify(seed()));
    assert.throws(()=>refreshDatabase(file,{execute:()=>fs.writeFileSync(file,JSON.stringify({newer:true}))}),/changed during refresh/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)),{newer:true});
  });
});
test("valid candidate is promoted only after every step",()=>{
  temp(file=>{
    fs.writeFileSync(file,JSON.stringify(seed()));const called=[];
    const after=refreshDatabase(file,{execute:(step,candidate)=>{
      called.push(step);const db=JSON.parse(fs.readFileSync(candidate));db.marker="validated";fs.writeFileSync(candidate,JSON.stringify(db));
    }});
    assert.deepEqual(called,steps);assert.equal(after.marker,"validated");assert.equal(JSON.parse(fs.readFileSync(file)).marker,"validated");
  });
});
