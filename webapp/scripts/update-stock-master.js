const fs = require("fs");
const https = require("https");
const path = require("path");

const dbPath = path.join(__dirname, "..", "data", "etf-database.json");
const twseCompanyUrl = "https://openapi.twse.com.tw/v1/opendata/t187ap03_L";
const twseDailyUrl = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL";
const tpexDailyUrl = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes";

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

function rocCompactToIso(value) {
  const match = String(value || "").trim().match(/^(\d{3})(\d{2})(\d{2})$/);
  if (!match) return null;
  return `${Number(match[1]) + 1911}-${match[2]}-${match[3]}`;
}

function isFourDigitStock(ticker) {
  return /^\d{4}$/.test(ticker);
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
  const previousStocks = db.stocks && Array.isArray(db.stocks.items) ? db.stocks : null;
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
        date: null,
        observedAt: new Date().toISOString(),
        sourceDateStatus: "official_endpoint_does_not_provide_date",
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
    sourceAttempts.push({
      source: "twse-stock-day-all",
      status: "loaded",
      rows: rows.length,
      sourceDataDate: null,
      dateEvidence: "官方回應列未提供交易日期",
      url: twseDailyUrl
    });
  } catch (error) {
    sourceAttempts.push({ source: "twse-stock-day-all", status: "failed", error: error.message, url: twseDailyUrl });
  }

  try {
    const rows = await getJson(tpexDailyUrl);
    if (!Array.isArray(rows)) throw new Error("TPEx daily response is not an array");
    let stockRows = 0;
    const officialDates = [];
    rows.forEach((row) => {
      const ticker = normalizeTicker(getField(row, ["SecuritiesCompanyCode", "Code", "代號"]));
      if (!isFourDigitStock(ticker)) return;
      stockRows += 1;
      const date = rocCompactToIso(getField(row, ["Date", "資料日期"]));
      if (date) officialDates.push(date);
      const existing = byTicker.get(ticker);
      byTicker.set(ticker, {
        ticker,
        name: String(getField(row, ["CompanyName", "Name", "名稱"]) || existing?.name || ticker).trim(),
        shortName: String(getField(row, ["CompanyName", "Name", "名稱"]) || existing?.shortName || ticker).trim(),
        market: "TPEx",
        industry: existing?.industry || "",
        listingDate: existing?.listingDate || null,
        latestPrice: {
          date,
          observedAt: new Date().toISOString(),
          sourceDateStatus: date ? "official_row_date" : "official_row_date_missing",
          open: toNumber(getField(row, ["Open", "開盤"])),
          high: toNumber(getField(row, ["High", "最高"])),
          low: toNumber(getField(row, ["Low", "最低"])),
          close: toNumber(getField(row, ["Close", "收盤"])),
          tradeVolume: toNumber(getField(row, ["TradingShares", "成交股數"])),
          tradeValue: toNumber(getField(row, ["TransactionAmount", "成交金額"])),
          transaction: toNumber(getField(row, ["TransactionNumber", "成交筆數"])),
          source: "tpex-mainboard-daily-close-quotes",
          sourceUrl: tpexDailyUrl
        },
        issuedShares: toNumber(getField(row, ["Capitals", "發行股數"])),
        source: "tpex-mainboard-daily-close-quotes",
        sourceUrl: tpexDailyUrl,
        qualityFlags: ["official_tpex_quote_loaded", "daily_price_loaded", "master_from_daily_quote"]
      });
    });
    sourceAttempts.push({
      source: "tpex-mainboard-daily-close-quotes",
      status: "loaded",
      rows: rows.length,
      stockRows,
      sourceDataDate: officialDates.sort().at(-1) || null,
      dateEvidence: "官方 Date 欄位",
      url: tpexDailyUrl
    });
  } catch (error) {
    sourceAttempts.push({ source: "tpex-mainboard-daily-close-quotes", status: "failed", error: error.message, url: tpexDailyUrl });
  }

  const items = [...byTicker.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
  const derivedCount = items.filter((item) => item.source === "derived-from-etf-holdings").length;
  const hasOfficialRows = sourceAttempts.some((item) => item.status === "loaded");

  if (!hasOfficialRows && previousStocks) {
    db.stocks = {
      ...previousStocks,
      status: "preserved_previous_snapshot_after_failed_refresh",
      sourceAttempts
    };
  } else {
    db.stocks = {
      status: hasOfficialRows
        ? derivedCount ? "official_twse_loaded_with_derived_gaps" : "official_twse_loaded"
        : "derived_from_etf_holdings_only",
      requiredFor: ["直接股票辨識", "ETF 底層股票穿透", "整體股票重疊度"],
      items,
      updatedAt: new Date().toISOString(),
      sourceAttempts,
      limitations: [
        "TWSE OpenAPI 可補上市股票主檔與每日行情。",
        "TPEx OpenAPI 可補上櫃股票每日行情，並以代號與名稱建立上櫃股票主檔；產業別與掛牌日若來源未提供會保留空值，不做假資料補值。",
        "若使用者輸入興櫃或未上市標的，需再接 TPEx 興櫃或其他正式來源；目前會標示為未知標的，不做假資料補值。",
        "ETF 成分股只有在投信官方成分資料完整時，才能完整穿透到個股曝險。"
      ]
    };
  }

  db.metadata.sources = (db.metadata.sources || []).filter((source) => !["twse-company-basic", "twse-stock-day-all", "tpex-mainboard-daily-close-quotes"].includes(source.id));
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
  db.metadata.sources.push({
    id: "tpex-mainboard-daily-close-quotes",
    name: "TPEx OpenAPI 上櫃股票行情",
    url: tpexDailyUrl,
    usage: "上櫃股票代號、名稱、每日開高低收、成交量、成交金額與發行股數"
  });

  fs.writeFileSync(dbPath, `${JSON.stringify(db, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    stocks: items.length,
    effectiveStocks: db.stocks.items.length,
    derivedCount: db.stocks.items.filter((item) => item.source === "derived-from-etf-holdings").length,
    sourceAttempts
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
