const fs = require("fs");
const path = require("path");

const dbPath = path.join(__dirname, "..", "data", "etf-database.json");
const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
const today = new Date();
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
assert(Array.isArray(db.holdings?.items), "ETF 成分股資料必須是陣列");
assert(Array.isArray(db.navSeries?.items), "NAV/折溢價資料必須是陣列");
assert(Array.isArray(db.priceSeries?.items), "價格資料必須是陣列");
if (db.etfMaster) {
  assert(Array.isArray(db.etfMaster.items), "ETF master items 必須是陣列");
  assert(db.etfMaster.items.length === db.etfs.length, "ETF master 筆數需與 ETF 主檔一致");
  const failedMasterSources = (db.etfMaster.sourceAttempts || []).filter((item) => item.status === "failed");
  if (failedMasterSources.length) {
    warn(false, `ETF master 部分官方分類來源失敗：${failedMasterSources.map((item) => item.label || item.source).join("、")}`);
  }
}

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
  const ageDays = Number.isFinite(perfDate.getTime()) ? Math.round((today - perfDate) / 86400000) : 999;
  warn(ageDays <= 3, `${etf.ticker} 績效資料日期 ${etf.performance?.date || "無"} 距今 ${ageDays} 天，需確認是否最新`);
  warn(!etf.qualityFlags?.includes("holdings_missing"), `${etf.ticker} 成分股權重尚未接上官方資料`);
  warn(!etf.qualityFlags?.includes("holdings_partial"), `${etf.ticker} 成分股權重只接上官方可見列，尚非完整成分股資料`);
  warn(!etf.qualityFlags?.includes("price_series_missing"), `${etf.ticker} 價格折線尚未接上官方資料`);
  warn(!etf.qualityFlags?.includes("nav_series_missing"), `${etf.ticker} NAV/折溢價尚未接上官方資料`);
}

const stockTickers = new Set();
if (db.stocks) {
  assert(Array.isArray(db.stocks.items), "股票主檔必須是陣列");
  for (const stock of db.stocks.items || []) {
    assert(stock.ticker, "股票主檔缺 ticker");
    assert(!stockTickers.has(stock.ticker), `股票 ticker 重複：${stock.ticker}`);
    stockTickers.add(stock.ticker);
    assert(stock.name || stock.shortName, `${stock.ticker} 缺股票名稱`);
    warn(!stock.qualityFlags?.includes("derived_from_etf_holdings"), `${stock.ticker} 股票主檔為 ETF 成分推導，尚未接上官方股票主檔`);
  }
} else {
  warn(false, "股票主檔尚未建立，無法支援直接股票與 ETF 底層股票重疊度");
}

for (const row of db.distributions) {
  assert(tickers.has(row.ticker), `配息資料 ticker 不在主檔：${row.ticker}`);
  assert(row.payDate, `${row.ticker} 配息資料缺發放日`);
  assert(Number(row.amountPerUnit) >= 0, `${row.ticker} 配息金額不可小於 0`);
}

for (const row of db.holdings.items || []) {
  assert(tickers.has(row.ticker), `成分股 ETF ticker 不在主檔：${row.ticker}`);
  assert(row.holdingTicker, `${row.ticker} 成分股缺股票代號`);
  assert(row.holdingName, `${row.ticker}/${row.holdingTicker} 成分股缺名稱`);
  assert(Number(row.weight) >= 0, `${row.ticker}/${row.holdingTicker} 權重不可小於 0`);
  warn(!db.stocks || stockTickers.has(row.holdingTicker), `${row.ticker}/${row.holdingTicker} 未對應股票主檔`);
}

const result = {
  status: errors.length ? "failed" : warnings.length ? "passed_with_warnings" : "passed",
  errors,
  warnings,
  counts: {
    etfs: db.etfs.length,
    distributions: db.distributions.length,
    holdings: db.holdings.items.length,
    stocks: db.stocks?.items?.length || 0,
    priceSeries: db.priceSeries.items.length,
    navSeries: db.navSeries.items.length
  }
};

console.log(JSON.stringify(result, null, 2));
process.exit(errors.length ? 1 : 0);
