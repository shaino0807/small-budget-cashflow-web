const fs = require("fs");
const path = require("path");
const { officialDate } = require("./update-safety");

const dbPath = process.env.ETF_DATABASE_PATH
  ? path.resolve(process.env.ETF_DATABASE_PATH)
  : path.join(__dirname, "..", "data", "etf-database.json");
const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));

function validDate(value) {
  return Boolean(value) && officialDate(value) === value;
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
const priceDate = latestDate((db.priceSeries?.items || []).map((row) => row.date));
const holdingsDate = latestDate((db.holdings?.items || []).map((row) => row.asOfDate));
const navDate = latestDate((db.navSeries?.items || []).map((row) => row.date));
const referenceTradingDate = latestDate([stockDate, priceDate, holdingsDate, navDate]);

function sourceStatus(sourceDataDate, required = true) {
  if (!sourceDataDate) return required ? "missing_date" : "observed_without_source_date";
  const lagDays = ageDays(sourceDataDate, referenceTradingDate);
  return lagDays > 3 ? "stale" : "current";
}

function quoteFreshness(source, attempt) {
  const rows = (db.stocks?.items || []).filter((r) => r.latestPrice?.source === source);
  const date = latestDate(rows.map((r) => r.latestPrice.date));
  const preserved = rows.filter((r) => r.priceRefreshStatus === "preserved_previous").length;
  const allPreserved = preserved === rows.length || attempt?.status === "failed"
    || String(db.stocks?.status || "").startsWith("preserved_previous_snapshot");
  return {
    observedAt: rows.map((r) => r.latestPrice?.observedAt).filter(Boolean).sort().at(-1) || db.stocks?.updatedAt || null,
    sourceDataDate: date,
    oldestSourceDataDate: rows.map((r) => r.latestPrice?.date).filter(validDate).sort()[0] || null,
    status: date ? allPreserved ? "preserved_previous_snapshot"
      : preserved || attempt?.status === "partial" ? "partial_snapshot" : sourceStatus(date) : "missing_date",
    lastAttemptStatus: attempt?.status || "unknown", preservedRows: preserved,
    evidence: "取目前發布的官方行情列日期；保留資料不以本次執行時間冒充更新"
  };
}

db.metadata = db.metadata || {};
db.metadata.refreshExecutedAt = executedAt;
db.metadata.officialPerformanceDate = referenceTradingDate;
db.metadata.sourceFreshness = {
  referenceTradingDate,
  checkedAt: executedAt,
  sources: {
    etfMaster: {
      observedAt: db.etfMaster?.observedAt || null,
      lastAttemptStatus: db.etfMaster?.status || "unknown",
      sourceDataDate: null,
      status: "observed_without_source_date",
      evidence: "TWSE／TPEx ETF 商品篩選器回應沒有提供資料日期，不得以執行日冒充交易日"
    },
    stockMaster: {
      observedAt: db.stocks?.updatedAt || executedAt,
      sourceDataDate: stockDate,
      status: (db.stocks?.items || []).some((row) => row.priceRefreshStatus === "preserved_previous" || row.priceRefreshStatus === "missing")
        ? "partial_snapshot" : sourceStatus(stockDate),
      evidence: "所有具官方日期欄位的股票行情列最大日期"
    },
    twseStockDaily: quoteFreshness("twse-stock-day-all", twseStockAttempt),
    tpexStockDaily: quoteFreshness("tpex-mainboard-daily-close-quotes", tpexStockAttempt),
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
