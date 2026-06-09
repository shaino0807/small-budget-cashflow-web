const fs = require("fs");
const https = require("https");
const path = require("path");

const dbPath = path.join(__dirname, "..", "data", "etf-database.json");
const twseCompanyUrl = "https://openapi.twse.com.tw/v1/opendata/t187ap03_L";
const twseDailyUrl = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL";

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

function getField(row, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  }
  return undefined;
}

function toNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(String(value).replaceAll(",", "").replace("+", "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTicker(value) {
  return String(value || "").trim();
}

function stockFromHolding(row) {
  const ticker = normalizeTicker(row.holdingTicker);
  if (!ticker) return null;
  return {
    ticker,
    name: row.holdingName || ticker,
    shortName: row.holdingName || ticker,
    market: "unknown",
    industry: row.sector || "",
    listingDate: null,
    latestPrice: null,
    source: "derived-from-etf-holdings",
    sourceUrl: row.sourceUrl || "",
    qualityFlags: ["derived_from_etf_holdings"]
  };
}

async function main() {
  const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  const byTicker = new Map();
  const sourceAttempts = [];

  for (const row of db.holdings?.items || []) {
    const stock = stockFromHolding(row);
    if (stock && !byTicker.has(stock.ticker)) byTicker.set(stock.ticker, stock);
  }

  try {
    const rows = await getJson(twseCompanyUrl);
    if (!Array.isArray(rows)) throw new Error("TWSE company response is not an array");
    rows.forEach((row) => {
      const ticker = normalizeTicker(getField(row, ["公司代號", "Code", "公司代號 "]));
      if (!ticker) return;
      byTicker.set(ticker, {
        ticker,
        name: String(getField(row, ["公司名稱", "CompanyName", "公司名稱 "]) || ticker).trim(),
        shortName: String(getField(row, ["公司簡稱", "Abbreviation", "公司簡稱 "]) || ticker).trim(),
        market: "TWSE",
        industry: String(getField(row, ["產業別", "Industry", "產業別 "]) || "").trim(),
        listingDate: String(getField(row, ["上市日期", "ListingDate", "上市日期 "]) || "").trim() || null,
        latestPrice: null,
        source: "twse-company-basic",
        sourceUrl: twseCompanyUrl,
        qualityFlags: ["official_master_loaded"]
      });
    });
    sourceAttempts.push({ source: "twse-company-basic", status: "loaded", rows: rows.length, url: twseCompanyUrl });
  } catch (error) {
    sourceAttempts.push({ source: "twse-company-basic", status: "failed", error: error.message, url: twseCompanyUrl });
  }

  try {
    const rows = await getJson(twseDailyUrl);
    if (!Array.isArray(rows)) throw new Error("TWSE daily response is not an array");
    rows.forEach((row) => {
      const ticker = normalizeTicker(getField(row, ["Code", "證券代號", "證券代號 "]));
      if (!ticker || !byTicker.has(ticker)) return;
      const stock = byTicker.get(ticker);
      stock.latestPrice = {
        date: db.metadata?.snapshotDate || new Date().toISOString().slice(0, 10),
        open: toNumber(getField(row, ["OpeningPrice", "開盤價"])),
        high: toNumber(getField(row, ["HighestPrice", "最高價"])),
        low: toNumber(getField(row, ["LowestPrice", "最低價"])),
        close: toNumber(getField(row, ["ClosingPrice", "收盤價"])),
        tradeVolume: toNumber(getField(row, ["TradeVolume", "成交股數"])),
        source: "twse-stock-day-all",
        sourceUrl: twseDailyUrl
      };
      stock.qualityFlags = [...new Set([...(stock.qualityFlags || []), "daily_price_loaded"])];
    });
    sourceAttempts.push({ source: "twse-stock-day-all", status: "loaded", rows: rows.length, url: twseDailyUrl });
  } catch (error) {
    sourceAttempts.push({ source: "twse-stock-day-all", status: "failed", error: error.message, url: twseDailyUrl });
  }

  const items = [...byTicker.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
  const derivedCount = items.filter((item) => item.source === "derived-from-etf-holdings").length;

  db.stocks = {
    status: sourceAttempts.some((item) => item.status === "loaded")
      ? derivedCount ? "official_twse_loaded_with_derived_gaps" : "official_twse_loaded"
      : "derived_from_etf_holdings_only",
    requiredFor: ["直接股票辨識", "ETF 底層股票穿透", "整體股票重疊度"],
    items,
    sourceAttempts,
    limitations: [
      "TWSE OpenAPI 可補上市股票主檔與每日行情。",
      "若使用者輸入上櫃或未上市標的，需再接 TPEx 或其他正式來源；目前會標示為未知標的，不做假資料補值。",
      "ETF 成分股只有在投信官方成分資料完整時，才能完整穿透到個股曝險。"
    ]
  };

  db.metadata.sources = (db.metadata.sources || []).filter((source) => !["twse-company-basic", "twse-stock-day-all"].includes(source.id));
  db.metadata.sources.push({
    id: "twse-company-basic",
    name: "TWSE OpenAPI 上市公司基本資料",
    url: twseCompanyUrl,
    usage: "股票主檔、公司簡稱、產業別與上市日期"
  });
  db.metadata.sources.push({
    id: "twse-stock-day-all",
    name: "TWSE OpenAPI 上市個股日成交資訊",
    url: twseDailyUrl,
    usage: "股票每日開高低收、成交量與最新價格"
  });

  fs.writeFileSync(dbPath, `${JSON.stringify(db, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    stocks: items.length,
    derivedCount,
    sourceAttempts
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
