const fs = require("fs");
const path = require("path");

const dbPath = process.env.ETF_DATABASE_PATH
  ? path.resolve(process.env.ETF_DATABASE_PATH)
  : path.join(__dirname, "..", "data", "etf-database.json");
const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function latestDate(values) {
  return values.filter(validDate).sort().at(-1) || null;
}

function ageDays(date, referenceDate) {
  if (!date || !referenceDate) return null;
  return Math.round((new Date(`${referenceDate}T00:00:00+08:00`) - new Date(`${date}T00:00:00+08:00`)) / 86400000);
}

const executedAt = new Date().toISOString();
const stockDate = latestDate((db.stocks?.items || []).map((row) => row.latestPrice?.date));
const twseStockAttempt = (db.stocks?.sourceAttempts || []).find((row) => row.source === "twse-stock-day-all");
const tpexStockAttempt = (db.stocks?.sourceAttempts || []).find((row) => row.source === "tpex-mainboard-daily-close-quotes");
// The last fetch attempt can fail while the retained official rows remain valid.
// Derive the source date from the data being published, never from a fetch timestamp.
const tpexStockDate = latestDate((db.stocks?.items || [])
  .filter((row) => row.latestPrice?.source === "tpex-mainboard-daily-close-quotes")
  .map((row) => row.latestPrice.date));
const tpexSnapshotPreserved = String(db.stocks?.status || "").startsWith("preserved_previous_snapshot");
const priceDate = latestDate((db.priceSeries?.items || []).map((row) => row.date));
const holdingsDate = latestDate((db.holdings?.items || []).map((row) => row.asOfDate));
const navDate = latestDate((db.navSeries?.items || []).map((row) => row.date));
const referenceTradingDate = latestDate([stockDate, priceDate, holdingsDate, navDate]);

function sourceStatus(sourceDataDate, required = true) {
  if (!sourceDataDate) return required ? "missing_date" : "observed_without_source_date";
  const lagDays = ageDays(sourceDataDate, referenceTradingDate);
  return lagDays > 3 ? "stale" : "current";
}

db.metadata = db.metadata || {};
db.metadata.refreshExecutedAt = executedAt;
db.metadata.officialPerformanceDate = referenceTradingDate;
db.metadata.sourceFreshness = {
  referenceTradingDate,
  checkedAt: executedAt,
  sources: {
    etfMaster: {
      observedAt: executedAt,
      sourceDataDate: null,
      status: "observed_without_source_date",
      evidence: "TWSE ETF e添富商品篩選器回應沒有提供資料日期，不得以執行日冒充交易日"
    },
    stockMaster: {
      observedAt: db.stocks?.updatedAt || executedAt,
      sourceDataDate: stockDate,
      status: sourceStatus(stockDate),
      evidence: "所有具官方日期欄位的股票行情列最大日期"
    },
    twseStockDaily: {
      observedAt: db.stocks?.updatedAt || executedAt,
      sourceDataDate: twseStockAttempt?.sourceDataDate || null,
      status: "observed_without_source_date",
      evidence: twseStockAttempt?.dateEvidence || "TWSE STOCK_DAY_ALL 回應沒有交易日期欄位"
    },
    tpexStockDaily: {
      observedAt: db.stocks?.updatedAt || executedAt,
      sourceDataDate: tpexStockDate,
      status: tpexSnapshotPreserved && tpexStockDate ? "preserved_previous_snapshot" : sourceStatus(tpexStockDate),
      lastAttemptStatus: tpexStockAttempt?.status || "unknown",
      evidence: tpexSnapshotPreserved
        ? "本次更新未取得完整日期資料；保留前次官方行情，日期取保留資料列的 TPEx Date 最大值"
        : "目前官方 TPEx 行情資料列的 Date 最大值"
    },
    priceSeries: {
      observedAt: db.priceSeries?.updatedAt || executedAt,
      sourceDataDate: priceDate,
      status: sourceStatus(priceDate),
      evidence: "TWSE STOCK_DAY 回傳資料列 date 最大值"
    },
    issuerHoldings: {
      observedAt: db.holdings?.updatedAt || executedAt,
      sourceDataDate: holdingsDate,
      status: sourceStatus(holdingsDate),
      evidence: "投信官方成分股 asOfDate 最大值"
    },
    issuerNav: {
      observedAt: db.navSeries?.updatedAt || executedAt,
      sourceDataDate: navDate,
      status: sourceStatus(navDate),
      evidence: "投信官方 NAV date 最大值"
    }
  }
};

fs.writeFileSync(dbPath, `${JSON.stringify(db, null, 2)}\n`, "utf8");
console.log(JSON.stringify(db.metadata.sourceFreshness, null, 2));
