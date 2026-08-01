const fs = require("fs");
const https = require("https");
const path = require("path");

const dbPath = process.env.ETF_DATABASE_PATH
  ? path.resolve(process.env.ETF_DATABASE_PATH)
  : path.join(__dirname, "..", "data", "etf-database.json");
const queryDate = process.argv[2] || taipeiQueryDate();

function taipeiQueryDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}${byType.month}${byType.day}`;
}

function getJson(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "SmallBudgetCashflowMap/0.1" } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (redirectCount >= 5) {
            reject(new Error(`Too many redirects for ${url}`));
            return;
          }
          getJson(new URL(res.headers.location, url).toString(), redirectCount + 1).then(resolve, reject);
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`Invalid JSON: ${error.message}`));
          }
        });
      })
      .on("error", reject);
  });
}

function toNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value).replaceAll(",", "").replace("+", "").trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function rocDateToIso(value) {
  const [rocYear, month, day] = String(value).split("/");
  const year = Number(rocYear) + 1911;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

async function fetchMonthlyPrice(ticker) {
  const url = `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${queryDate}&stockNo=${ticker}`;
  const json = await getJson(url);
  if (json.stat !== "OK") {
    return { ticker, sourceUrl: url, rows: [], status: json.stat || "not_ok" };
  }
  const rows = json.data.map((row) => ({
    ticker,
    date: rocDateToIso(row[0]),
    tradeVolume: toNumber(row[1]),
    tradeValue: toNumber(row[2]),
    open: toNumber(row[3]),
    high: toNumber(row[4]),
    low: toNumber(row[5]),
    close: toNumber(row[6]),
    change: toNumber(row[7]),
    transaction: toNumber(row[8]),
    source: "twse-stock-day",
    sourceUrl: url
  }));
  return { ticker, sourceUrl: url, rows, status: "OK" };
}

function applyPriceRefresh(db, targets, results, { attemptedAt = new Date().toISOString(), attemptedQueryDate = queryDate } = {}) {
  db.priceSeries = db.priceSeries || { items: [] };
  const previousItems = Array.isArray(db.priceSeries.items) ? db.priceSeries.items : [];
  const targetTickers = new Set(targets.map((etf) => etf.ticker));
  const effectiveItems = previousItems.filter((row) => !targetTickers.has(row.ticker));
  let updatedRows = 0;
  let preservedRows = 0;

  for (const result of results) {
    const freshRows = Array.isArray(result.rows) ? result.rows : [];
    if (freshRows.length) {
      effectiveItems.push(...freshRows);
      updatedRows += freshRows.length;
      continue;
    }
    const previousTickerRows = previousItems.filter((row) => row.ticker === result.ticker);
    effectiveItems.push(...previousTickerRows);
    preservedRows += previousTickerRows.length;
  }

  db.priceSeries.status = updatedRows
    ? preservedRows
      ? "official_monthly_price_partially_loaded_preserved_previous"
      : "official_monthly_price_loaded"
    : preservedRows
      ? "no_new_price_rows_preserved_previous"
      : "no_price_rows";
  db.priceSeries.items = effectiveItems;
  db.priceSeries.source = "twse-stock-day";
  db.priceSeries.lastAttemptedAt = attemptedAt;
  db.priceSeries.lastAttemptQueryDate = attemptedQueryDate;
  db.priceSeries.sourceAttempts = results.map((result) => ({
    ticker: result.ticker,
    status: result.status,
    rows: Array.isArray(result.rows) ? result.rows.length : 0,
    preservedRows: Array.isArray(result.rows) && result.rows.length
      ? 0
      : previousItems.filter((row) => row.ticker === result.ticker).length,
    sourceUrl: result.sourceUrl
  }));
  if (updatedRows || !preservedRows) {
    db.priceSeries.queryDate = attemptedQueryDate;
    db.priceSeries.updatedAt = attemptedAt;
  }

  for (const etf of targets) {
    const hasRows = effectiveItems.some((row) => row.ticker === etf.ticker);
    etf.qualityFlags = (etf.qualityFlags || []).filter((flag) => flag !== "price_series_missing" && flag !== "daily_price_loaded");
    if (hasRows && !etf.qualityFlags.includes("monthly_price_loaded")) {
      etf.qualityFlags.push("monthly_price_loaded");
    }
    if (!hasRows && !etf.qualityFlags.includes("price_series_missing")) {
      etf.qualityFlags.push("price_series_missing");
    }
  }

  return { updatedRows, preservedRows, effectiveRows: effectiveItems.length };
}

async function main() {
  const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  const featuredTickers = new Set(db.metadata?.featuredTickers || db.etfs.map((etf) => etf.ticker));
  const targets = db.etfs.filter((etf) => featuredTickers.has(etf.ticker));
  const results = [];
  for (const etf of targets) {
    results.push(await fetchMonthlyPrice(etf.ticker));
  }

  const refresh = applyPriceRefresh(db, targets, results);

  db.metadata.sources = db.metadata.sources.filter((source) => source.id !== "twse-stock-day");
  db.metadata.sources.push({
    id: "twse-stock-day",
    name: "TWSE STOCK_DAY 各日成交資訊",
    url: "https://www.twse.com.tw/exchangeReport/STOCK_DAY",
    usage: "ETF 月內價格折線、開高低收、成交量與成交金額"
  });

  fs.writeFileSync(dbPath, `${JSON.stringify(db, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    queryDate,
    targetTickers: targets.map((etf) => etf.ticker),
    ...refresh,
    byTicker: db.priceSeries.sourceAttempts
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { applyPriceRefresh, fetchMonthlyPrice, rocDateToIso, taipeiQueryDate, toNumber };
