const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const { officialDate, toNumber, atomicWriteJson } = require("./update-safety");
const sources = {
  company: { id: "twse-company-basic", url: "https://openapi.twse.com.tw/v1/opendata/t187ap03_L" },
  TWSE: { id: "twse-stock-day-all", url: "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL" },
  TPEx: { id: "tpex-mainboard-daily-close-quotes", url: "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes" }
};
function getJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "SmallBudgetCashflowMap/0.1" } }, (res) => {
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("Aborted response: " + url)));
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects >= 5) return reject(new Error("Too many redirects: " + url));
        getJson(new URL(res.headers.location, url).toString(), redirects + 1).then(resolve, reject);
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error("HTTP " + res.statusCode));
        try { resolve(JSON.parse(body)); } catch (error) { reject(new Error("Invalid JSON: " + error.message)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("Request timeout: " + url)));
  });
}
function field(row, names) {
  if (!row || typeof row !== "object") return undefined;
  return names.map((name) => row[name]).find((v) => v != null && String(v).trim() !== "");
}
async function refreshStockMaster(input, { fetchJson = getJson, now = new Date().toISOString() } = {}) {
  const db = structuredClone(input);
  const previous = db.stocks || {};
  // Absence from a response is not evidence of delisting.
  const byTicker = new Map((previous.items || []).map((row) => [row.ticker, row]));
  const sourceAttempts = [];
  for (const row of db.holdings?.items || []) {
    if (row.assetType && row.assetType !== "stock") continue;
    const ticker = String(row.holdingTicker || "").trim();
    if (ticker && !byTicker.has(ticker)) byTicker.set(ticker, {
      ticker, name: row.holdingName || ticker, shortName: row.holdingName || ticker,
      market: "unknown", industry: row.sector || "", listingDate: null, latestPrice: null,
      source: "derived-from-etf-holdings", sourceUrl: row.sourceUrl || "", qualityFlags: ["derived_from_etf_holdings"]
    });
  }
  try {
    const rows = await fetchJson(sources.company.url);
    if (!Array.isArray(rows) || !rows.length) throw new Error("Empty or invalid TWSE company response");
    let accepted = 0;
    for (const row of rows) {
      const ticker = String(field(row, ["公司代號", "Code", "公司代號 "]) || "").trim();
      const name = String(field(row, ["公司名稱", "CompanyName", "公司名稱 "]) || "").trim();
      if (!/^\d{4,6}$/.test(ticker) || !name) continue;
      const old = byTicker.get(ticker) || {};
      byTicker.set(ticker, { ...old, ticker, name,
        shortName: String(field(row, ["公司簡稱", "Abbreviation", "公司簡稱 "]) || old.shortName || name).trim(),
        market: "TWSE", industry: String(field(row, ["產業別", "Industry", "產業別 "]) || old.industry || "").trim(),
        listingDate: officialDate(field(row, ["上市日期", "ListingDate", "上市日期 "])) || old.listingDate || null,
        latestPrice: old.latestPrice || null, source: sources.company.id, sourceUrl: sources.company.url,
        qualityFlags: [...new Set([...(old.qualityFlags || []).filter((f) => f !== "derived_from_etf_holdings"), "official_master_loaded"])] });
      accepted++;
    }
    if (!accepted) throw new Error("No valid TWSE company rows");
    sourceAttempts.push({ source: sources.company.id, status: "loaded", rows: rows.length, accepted, url: sources.company.url });
  } catch (error) {
    sourceAttempts.push({ source: sources.company.id, status: "failed", error: error.message, url: sources.company.url });
  }
  let refreshed = 0;
  for (const market of ["TWSE", "TPEx"]) {
    const source = sources[market], updated = new Set(), rejected = [], dates = [];
    let attempt;
    try {
      const rows = await fetchJson(source.url);
      if (!Array.isArray(rows) || !rows.length) throw new Error("Empty or invalid " + market + " quote response");
      const tickerOf = (row) => String(field(row, market === "TWSE" ? ["Code", "證券代號", "證券代號 "] : ["SecuritiesCompanyCode", "Code", "代號"]) || "").trim();
      const counts = new Map();
      for (const row of rows) counts.set(tickerOf(row), (counts.get(tickerOf(row)) || 0) + 1);
      for (const row of rows) {
        const ticker = tickerOf(row);
        if (!(market === "TWSE" ? /^\d{4,6}$/ : /^\d{4}$/).test(ticker)) continue;
        const old = byTicker.get(ticker);
        // TWSE quotes include ETFs; the company master identifies equities.
        if (market === "TWSE" && (!old || old.market !== "TWSE")) continue;
        if (market === "TPEx" && old?.market === "TWSE") continue;
        const date = officialDate(field(row, ["Date", "資料日期", "日期"]));
        const close = toNumber(field(row, market === "TWSE" ? ["ClosingPrice", "收盤價"] : ["Close", "收盤"]));
        const previousDate = officialDate(old?.latestPrice?.date);
        const reason = counts.get(ticker) > 1 ? "duplicate_ticker" : !date ? "invalid_date"
          : date > now.slice(0, 10) ? "future_date" : close === null || close <= 0 ? "invalid_close"
          : previousDate && date < previousDate ? "older_than_previous" : null;
        if (reason) { rejected.push({ ticker, reason }); continue; }
        const name = String(field(row, ["CompanyName", "Name", "名稱"]) || old?.name || ticker).trim();
        const latestPrice = {
          date, observedAt: now, sourceDateStatus: "official_row_date",
          open: toNumber(field(row, ["OpeningPrice", "Open", "開盤價", "開盤"])),
          high: toNumber(field(row, ["HighestPrice", "High", "最高價", "最高"])),
          low: toNumber(field(row, ["LowestPrice", "Low", "最低價", "最低"])), close,
          tradeVolume: toNumber(field(row, ["TradeVolume", "TradingShares", "成交股數"])),
          ...(market === "TPEx" ? { tradeValue: toNumber(row.TransactionAmount), transaction: toNumber(row.TransactionNumber) } : {}),
          source: source.id, sourceUrl: source.url
        };
        byTicker.set(ticker, { ...old, ticker, name, shortName: old?.shortName || name, market,
          industry: old?.industry || "", listingDate: old?.listingDate || null, latestPrice,
          ...(market === "TPEx" ? { issuedShares: toNumber(row.Capitals) ?? old?.issuedShares ?? null } : {}),
          source: market === "TPEx" ? source.id : old?.source || source.id,
          sourceUrl: market === "TPEx" ? source.url : old?.sourceUrl || source.url,
          priceRefreshStatus: "updated", priceRefreshAttemptedAt: now,
          qualityFlags: [...new Set([...(old?.qualityFlags || []).filter((f) => !["price_preserved", "derived_from_etf_holdings"].includes(f)), "daily_price_loaded"])] });
        updated.add(ticker);
        dates.push(date);
      }
      attempt = { source: source.id, status: updated.size ? (rejected.length ? "partial" : "loaded") : "failed",
        rows: rows.length, accepted: updated.size, rejected, sourceDataDate: dates.sort().at(-1) || null,
        dateEvidence: "官方 Date 欄位；只計通過日期與價格檢查的資料列", url: source.url };
    } catch (error) {
      attempt = { source: source.id, status: "failed", accepted: 0, error: error.message, url: source.url };
    }
    let preserved = 0;
    for (const stock of byTicker.values()) {
      if (stock.market !== market || updated.has(stock.ticker)) continue;
      if (stock.latestPrice) preserved++;
      stock.priceRefreshStatus = stock.latestPrice ? "preserved_previous" : "missing";
      stock.priceRefreshAttemptedAt = now;
      if (stock.latestPrice) stock.qualityFlags = [...new Set([...(stock.qualityFlags || []), "price_preserved"])];
    }
    attempt.preserved = preserved;
    if (preserved && attempt.status === "loaded") attempt.status = "partial";
    refreshed += updated.size;
    sourceAttempts.push(attempt);
  }
  db.stocks = { ...previous,
    status: refreshed ? (sourceAttempts.some((a) => a.status !== "loaded") ? "official_quotes_partial" : "official_quotes_loaded") : "preserved_previous_snapshot_after_failed_refresh",
    items: [...byTicker.values()].sort((a, b) => a.ticker.localeCompare(b.ticker)),
    updatedAt: refreshed ? now : previous.updatedAt || null, lastAttemptAt: now, sourceAttempts };
  db.metadata ||= {};
  db.metadata.sources = (db.metadata.sources || []).filter((s) => !Object.values(sources).some((v) => v.id === s.id));
  db.metadata.sources.push(...Object.values(sources).map((s) => ({ ...s, name: s.id, usage: "官方股票主檔或行情；失敗與缺列保留舊資料" })));
  return db;
}
async function main() {
  const file = process.env.ETF_DATABASE_PATH ? path.resolve(process.env.ETF_DATABASE_PATH) : path.join(__dirname, "../data/etf-database.json");
  const db = await refreshStockMaster(JSON.parse(fs.readFileSync(file, "utf8")));
  atomicWriteJson(file, db);
  console.log(JSON.stringify({ status: db.stocks.status, stocks: db.stocks.items.length, sourceAttempts: db.stocks.sourceAttempts }, null, 2));
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { refreshStockMaster, sources, getJson };
