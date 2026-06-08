const fs = require("fs");
const https = require("https");
const path = require("path");

const dbPath = path.join(__dirname, "..", "data", "etf-database.json");
const stockDayAllUrl = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL";

function getJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "SmallBudgetCashflowMap/0.1" } }, (res) => {
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

function getField(row, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  }
  return undefined;
}

async function main() {
  const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  const tickers = new Set(db.etfs.map((item) => item.ticker));
  const rows = await getJson(stockDayAllUrl);
  if (!Array.isArray(rows)) throw new Error("TWSE STOCK_DAY_ALL response is not an array");

  const matched = rows
    .filter((row) => tickers.has(String(getField(row, ["Code", "證券代號", "證券代號 "]) || "").trim()))
    .map((row) => {
      const ticker = String(getField(row, ["Code", "證券代號", "證券代號 "])).trim();
      return {
        ticker,
        date: db.metadata.snapshotDate,
        close: toNumber(getField(row, ["ClosingPrice", "收盤價"])),
        open: toNumber(getField(row, ["OpeningPrice", "開盤價"])),
        high: toNumber(getField(row, ["HighestPrice", "最高價"])),
        low: toNumber(getField(row, ["LowestPrice", "最低價"])),
        tradeVolume: toNumber(getField(row, ["TradeVolume", "成交股數"])),
        tradeValue: toNumber(getField(row, ["TradeValue", "成交金額"])),
        transaction: toNumber(getField(row, ["Transaction", "成交筆數"])),
        source: "twse-openapi-stock-day-all",
        sourceUrl: stockDayAllUrl
      };
    });

  db.priceSeries.status = matched.length ? "official_daily_snapshot_loaded" : "no_matching_tickers";
  db.priceSeries.items = matched;
  db.metadata.sources = db.metadata.sources.filter((source) => source.id !== "twse-openapi-stock-day-all");
  db.metadata.sources.push({
    id: "twse-openapi-stock-day-all",
    name: "TWSE OpenAPI 上市個股日成交資訊",
    url: stockDayAllUrl,
    usage: "ETF 每日開高低收、成交量與成交金額"
  });

  for (const etf of db.etfs) {
    const hasPrice = matched.some((item) => item.ticker === etf.ticker);
    etf.qualityFlags = (etf.qualityFlags || []).filter((flag) => flag !== "price_series_missing");
    if (hasPrice && !etf.qualityFlags.includes("daily_price_loaded")) {
      etf.qualityFlags.push("daily_price_loaded");
    }
    if (!hasPrice && !etf.qualityFlags.includes("price_series_missing")) {
      etf.qualityFlags.push("price_series_missing");
    }
  }

  fs.writeFileSync(dbPath, `${JSON.stringify(db, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ updated: matched.length, tickers: matched.map((item) => item.ticker) }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
