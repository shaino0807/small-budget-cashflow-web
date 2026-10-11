const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createEtfMarketService, parseDividends } = require("../etf-market");
const { trailingYield } = require("../etf-data");
assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8"), /\/api\/market\/refresh/, "customer queries must never dispatch the global refresh/release workflow");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "etf-market-"));
const databasePath = path.join(dir, "db.json"), cacheDir = path.join(dir, "cache");
const raw = { etfs: [{ ticker: "0050" }, { ticker: "0056" }, { ticker: "00999" }],
  priceSeries: { items: [{ ticker: "0050", date: "2026-08-31", close: 40 }] }, holdings: { items: [] },
  privateCustomer: { holdings: "MUST_NOT_LEAK" } };
fs.writeFileSync(databasePath, JSON.stringify(raw));
const before = fs.readFileSync(databasePath, "utf8");
let fail = false, clock = new Date("2026-10-11T13:00:00Z"), requests = [];
const official = {
  data: [{ fundData: { FUND_ID: "1066", STK_CD: "0050", CAN_DISTRIBUTE: "Y" } }, { weightData: {
    PCF: { trandate: "20261008", nav: 50 }, FundWeights: { StockWeights: Array.from({ length: 100 }, (_, index) => ({ code: String(1000 + index), name: `公司${index}`, weights: 0.99, qty: 100 })) },
    InKind: { FundComposition: [{ code: "9999", name: "wrong basket", weights: 100 }] }
  } }]
};
const payouts = { ResultCode: 0, Data: { Data: [
  { FUND_ID: "1066", FUND_TYPE: "3", PAY_DATE: "2026/01/10", SHARE_DATE: "2025/12/20", DIVIDEN_PER_UNIT: "1.5" },
  { FUND_ID: "1066", FUND_TYPE: "3", PAY_DATE: "2026/07/10", SHARE_DATE: "2026/06/20", DIVIDEN_PER_UNIT: "1" }
] } };
const options = { databasePath, cacheDir, now: () => clock, allowNetwork: true,
  fetchText: async (url) => {
    requests.push(url);
    if (fail) throw new Error("official offline");
    return url.includes("api.yuantafunds") ? JSON.stringify(payouts) : `<script>window.__NUXT__=(function(){return ${JSON.stringify(official)}})();</script>`;
  }, fetchPrice: async (ticker, month) => {
    requests.push(`${ticker}:${month}`);
    if (fail) throw new Error("price offline");
    return { rows: [{ ticker, date: `${month.slice(0, 4)}-${month.slice(4, 6)}-08`, close: 50 }], sourceUrl: "https://www.twse.com.tw/exchangeReport/STOCK_DAY" };
  }
};
(async () => {
  const service = createEtfMarketService(options);
  for (const [ticker, months, status] of [["../0050", 1, 400], ["0050", 2, 400], ["0000", 1, 404]]) {
    await assert.rejects(service.get(ticker, months), (error) => error.statusCode === status);
  }
  const [first, same] = await Promise.all([service.get("0050"), service.get("0050")]);
  assert.deepEqual(first, same, "concurrent identical requests coalesced");
  assert.equal(requests.length, 4, "one issuer, one history, current and preceding month fetched once");
  assert.equal(first.holdings.length, 100, "full portfolio, no 80-row cap or basket substitution");
  assert.equal(first.holdingsCoverage.complete, true);
  assert.equal(new Set(first.holdings.map((row) => row.holdingTicker)).size, 100);
  assert.equal(first.navSeries[0].close, null, "NAV date cannot invent market close date");
  assert.equal(first.priceSeries.length, 3, "previous month's earlier history preserved");
  assert(requests.includes("0050:20260901"), "month boundary requests preceding month");
  assert(!JSON.stringify(first).includes("MUST_NOT_LEAK"), "public endpoint whitelist excludes customer fields");
  assert.equal(trailingYield({ etfs: raw.etfs, priceSeries: { items: first.priceSeries }, distributions: first.distributions, distributionHistory: { "0050": first.distributionHistory } }, "0050", "2026-10-11").value, 5);
  await service.get("0050");
  assert.equal(requests.length, 4, "15 minute cache avoids repeated upstream requests");
  await service.get("0050", 3);
  assert(requests.includes("0050:20260701"), "extended period loads real earlier months");
  const success = await service.get("0050", 3);
  clock = new Date("2026-10-11T13:20:00Z"); fail = true;
  const retained = await service.get("0050", 3);
  assert.deepEqual(retained.holdings, success.holdings);
  assert.deepEqual(retained.distributions, success.distributions);
  assert.equal(retained.distributionHistory.updatedAt, success.distributionHistory.updatedAt, "failure preserves successful observation timestamp");
  assert(retained.sourceAttempts.some((attempt) => attempt.status === "failed_preserved_previous"));
  const restarted = createEtfMarketService({ ...options, allowNetwork: false });
  assert.deepEqual((await restarted.get("0050", 3)).holdings, success.holdings, "cache survives service restart");
  const unsupported = await service.get("00999");
  assert.equal(unsupported.distributionHistory, null, "unconnected issuer does not invent yield");
  assert(unsupported.sourceAttempts.some((attempt) => attempt.status === "adapter_not_connected"));
  assert.throws(() => parseDividends({ ResultCode: 0, Data: { Data: [{ FUND_ID: "OTHER", FUND_TYPE: "3" }] } }, "0050", "1066", ""), /different fund/);
  assert.equal(fs.readFileSync(databasePath, "utf8"), before, "market lookup never rewrites production master");
  const mismatch = createEtfMarketService({ ...options, allowNetwork: true, cacheDir: path.join(dir, "mismatch"),
    fetchText: async () => `<script>window.__NUXT__=(function(){return ${JSON.stringify(official)}})();</script>` });
  const rejected = await mismatch.get("0056");
  assert.equal(rejected.holdings.length, 0, "mismatched official identity cannot replace holdings");
  assert.equal(rejected.navSeries.length, 0, "mismatched official identity cannot replace NAV");
  assert(rejected.sourceAttempts.some((attempt) => /identity/.test(attempt.error || "")));
  fs.unlinkSync(path.join(dir, "mismatch", "0056.json")); fs.rmdirSync(path.join(dir, "mismatch"));
  const saved = JSON.parse(fs.readFileSync(path.join(cacheDir, "0050.json")));
  assert.equal(saved.version, 1);
  console.log(JSON.stringify({ passed: true, full100Constituents: true, persistedPublicCache: true, sourceFailurePreservesDates: true, noMasterOrCustomerWrites: true }));
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const name of fs.readdirSync(cacheDir)) fs.unlinkSync(path.join(cacheDir, name));
  fs.rmdirSync(cacheDir); fs.unlinkSync(databasePath); fs.rmdirSync(dir);
});
