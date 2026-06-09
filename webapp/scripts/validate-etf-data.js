const fs = require("fs");
const path = require("path");

const dbPath = path.join(__dirname, "..", "data", "etf-database.json");
const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
const today = new Date("2026-06-09T00:00:00+08:00");
const errors = [];
const warnings = [];

function assert(condition, message) {
  if (!condition) errors.push(message);
}

function warn(condition, message) {
  if (!condition) warnings.push(message);
}

assert(Array.isArray(db.etfs) && db.etfs.length > 0, "ETF 主檔不可為空");
assert(Array.isArray(db.distributions), "配息資料必須是陣列");

const tickers = new Set();
for (const etf of db.etfs) {
  assert(etf.ticker, "ETF 缺 ticker");
  assert(!tickers.has(etf.ticker), `ETF ticker 重複：${etf.ticker}`);
  tickers.add(etf.ticker);
  assert(etf.shortName && etf.fundName, `${etf.ticker} 缺名稱`);
  assert(etf.issuer, `${etf.ticker} 缺發行公司`);
  assert(etf.indexName, `${etf.ticker} 缺追蹤指數`);
  assert(etf.sourceUrl, `${etf.ticker} 缺來源 URL`);

  const perfDate = new Date(`${etf.performance?.date}T00:00:00+08:00`);
  const ageDays = Math.round((today - perfDate) / 86400000);
  warn(ageDays <= 3, `${etf.ticker} 績效資料日期 ${etf.performance?.date} 距今 ${ageDays} 天，需確認是否最新`);
  warn(!etf.qualityFlags?.includes("holdings_missing"), `${etf.ticker} 成分股權重尚未接上官方資料`);
  warn(!etf.qualityFlags?.includes("holdings_partial"), `${etf.ticker} 成分股權重只接上官方可見列，尚非完整成分股資料`);
  warn(!etf.qualityFlags?.includes("price_series_missing"), `${etf.ticker} 價格折線尚未接上官方資料`);
  warn(!etf.qualityFlags?.includes("nav_series_missing"), `${etf.ticker} NAV/折溢價尚未接上官方資料`);
}

for (const row of db.distributions) {
  assert(tickers.has(row.ticker), `配息資料 ticker 不在主檔：${row.ticker}`);
  assert(row.payDate, `${row.ticker} 配息資料缺發放日`);
  assert(Number(row.amountPerUnit) >= 0, `${row.ticker} 配息金額不可小於 0`);
}

const result = {
  status: errors.length ? "failed" : warnings.length ? "passed_with_warnings" : "passed",
  errors,
  warnings,
  counts: {
    etfs: db.etfs.length,
    distributions: db.distributions.length,
    holdings: db.holdings.items.length,
    priceSeries: db.priceSeries.items.length,
    navSeries: db.navSeries.items.length
  }
};

console.log(JSON.stringify(result, null, 2));
process.exit(errors.length ? 1 : 0);
