// Public market data only. Never read customer holdings or dispatch a release workflow.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { today, monthsBefore, isoDate, numberOrNull } = require("./etf-data");
const issuer = require("./scripts/update-issuer-official-data");
const { fetchMonthlyPrice } = require("./scripts/update-price-series");

function dividendUrl(fundId, asOf) {
  const url = new URL("https://api.yuantafunds.com/ectranslation/api/trans");
  const parameters = { APIType: "EC2API", AppName: "FundWeb", PageName: "/myfund/dividend/history", Device: "4",
    DeviceId: crypto.randomUUID(), FuncId: "FundDividend", FundId: fundId, FundType: "ETF",
    SDate: `${Number(asOf.slice(0, 4)) - 2}0101`, EDate: asOf.replaceAll("-", ""), OSVersion: "1", AppVersion: "3.0.1" };
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url.toString();
}
function parseDividends(json, ticker, fundId, sourceUrl) {
  if (json.ResultCode !== 0 || !Array.isArray(json.Data?.Data)) throw new Error("Official distribution response is incomplete");
  const rows = json.Data.Data.filter((row) => row.FUND_ID === fundId && row.FUND_TYPE === "3");
  if (rows.length !== json.Data.Data.length) throw new Error("Distribution response contains a different fund");
  return rows.map((row) => ({ ticker, payDate: isoDate(String(row.PAY_DATE || "").replaceAll("/", "-")),
    exDividendDate: isoDate(String(row.SHARE_DATE || "").replaceAll("/", "-")), amountPerUnit: numberOrNull(row.DIVIDEN_PER_UNIT),
    source: "yuanta-official-distribution-history", sourceUrl })).filter((row) => row.payDate && row.exDividendDate && row.amountPerUnit !== null);
}
function mergeRows(previous, fresh, key) {
  const map = new Map(previous.map((row) => [key(row), row]));
  fresh.forEach((row) => map.set(key(row), row));
  return [...map.values()];
}
function createEtfMarketService({ databasePath = path.join(__dirname, "data", "etf-database.json"),
  cacheDir = path.join(process.env.CUSTOMER_DATA_DIR || path.join(__dirname, "private-data"), "market-cache"),
  fetchText = issuer.fetchText, fetchPrice = fetchMonthlyPrice, now = () => new Date(), allowNetwork = process.env.SMOKE_TEST !== "1",
  readDatabase } = {}) {
  const memory = new Map(), inFlight = new Map();
  let indexedKey, indexed;
  function snapshotIndex() {
    let db, key;
    if (readDatabase) ({ db, key } = readDatabase());
    else {
      const file = typeof databasePath === "function" ? databasePath() : databasePath;
      const stat = fs.statSync(file);
      key = `${file}:${stat.mtimeMs}:${stat.size}`;
      if (indexed && key === indexedKey) return indexed;
      db = JSON.parse(fs.readFileSync(file, "utf8"));
    }
    if (indexed && key === indexedKey) return indexed;
    const map = new Map((db.etfs || []).map(etf => [etf.ticker, {
      version: 2, ticker: etf.ticker, batchId: db.metadata?.dataBatch?.batchId || null,
      priceSeries: [], holdings: [], navSeries: [], distributions: [],
      holdingsCoverage: db.holdingsCoverage?.[etf.ticker] || null,
      distributionHistory: db.distributionHistory?.[etf.ticker] || null,
      coverageMonths: 0, attemptedAt: db.metadata?.refreshExecutedAt || null,
      sourceAttempts: [], readMode: "validated_snapshot", currency: etf.currency || null
    }]));
    for (const [kind, rows] of [["priceSeries", db.priceSeries?.items], ["holdings", db.holdings?.items],
      ["navSeries", db.navSeries?.items], ["distributions", db.distributions]]) {
      for (const row of rows || []) map.get(row.ticker)?.[kind].push(row);
    }
    for (const item of map.values()) {
      item.priceSeries.sort((a,b) => a.date.localeCompare(b.date));
      item.dataStatus = item.priceSeries.length || item.holdings.length ? "available" : "not_yet_available";
    }
    indexedKey = key; indexed = map;
    return map;
  }
  let active = 0;
  function readCache(ticker) {
    if (memory.has(ticker)) return memory.get(ticker);
    try {
      const cached = JSON.parse(fs.readFileSync(path.join(cacheDir, `${ticker}.json`), "utf8"));
      if (cached.version === 1 && cached.ticker === ticker && Array.isArray(cached.priceSeries) && Array.isArray(cached.holdings)
        && Array.isArray(cached.distributions) && Array.isArray(cached.navSeries)) { memory.set(ticker, cached); return cached; }
    } catch { /* missing or invalid cache: use official snapshot */ }
    return null;
  }
  function seed(db, ticker) {
    return { version: 1, ticker, priceSeries: (db.priceSeries?.items || []).filter((row) => row.ticker === ticker),
      holdings: (db.holdings?.items || []).filter((row) => row.ticker === ticker),
      navSeries: (db.navSeries?.items || []).filter((row) => row.ticker === ticker),
      distributions: (db.distributions || []).filter((row) => row.ticker === ticker),
      distributionHistory: db.distributionHistory?.[ticker] || null, sourceAttempts: [], coverageMonths: 0, attemptedAt: null };
  }
  async function load(ticker, months, db) {
    const previous = readCache(ticker) || seed(db, ticker), asOf = today(now());
    const result = structuredClone(previous);
    result.sourceAttempts = []; result.attemptedAt = now().toISOString(); result.coverageMonths = Math.max(months, previous.coverageMonths || 0);
    if (!allowNetwork) return { ...result, networkDisabled: true };
    const attempts = result.sourceAttempts;
    await Promise.all([
      (async () => {
        // Include the preceding month so a month-boundary query still has a full comparison window.
        for (let index = 0; index <= months; index++) {
          const date = monthsBefore(asOf, index).slice(0, 7).replace("-", "") + "01";
          try {
            const response = await fetchPrice(ticker, date);
            const fresh = (response.rows || []).filter((row) => row.ticker === ticker && isoDate(row.date)
              && row.date <= asOf && numberOrNull(row.close) > 0);
            result.priceSeries = mergeRows(result.priceSeries, fresh, (row) => row.date).sort((a, b) => a.date.localeCompare(b.date));
            attempts.push({ kind: "price", queryMonth: date.slice(0, 6), status: fresh.length ? "loaded" : "no_rows_preserved_previous", rows: fresh.length, url: response.sourceUrl });
          } catch (error) { attempts.push({ kind: "price", queryMonth: date.slice(0, 6), status: "failed_preserved_previous", error: error.message }); }
        }
      })(),
      (async () => {
        const config = issuer.sourceConfigs[ticker];
        if (!config) { attempts.push({ kind: "holdings", status: "adapter_not_connected" }, { kind: "distributions", status: "adapter_not_connected" }); return; }
        try {
          const html = await fetchText(config.holdings.url);
          const isYuanta = ["0050", "0056"].includes(ticker);
          const state = isYuanta ? issuer.extractNuxtState(html) : null;
          const fund = state?.data?.[0]?.fundData;
          if (isYuanta && (!fund?.FUND_ID || fund.STK_CD !== ticker)) throw new Error("Official fund identity did not match");
          const holdings = isYuanta ? issuer.parseYuantaHoldings(html, ticker, config.holdings)
            : ticker === "006208" ? issuer.parseFubonHoldings(html, ticker, config.holdings) : issuer.parseCathayHoldings(html, ticker, config.holdings);
          // Complete Yuanta StockWeights, rather than the creation/redemption basket or a top-ten list.
          const officialRows = state?.data?.[1]?.weightData?.FundWeights?.StockWeights;
          const complete = isYuanta && Array.isArray(officialRows) && officialRows.length === holdings.length && holdings.length > 0
            && new Set(holdings.map((row) => row.holdingTicker)).size === holdings.length
            && holdings.every((row) => isoDate(row.asOfDate) && row.asOfDate <= asOf && row.weight >= 0 && row.weight <= 100);
          if (holdings.length && (!isYuanta || complete)) {
            result.holdings = holdings;
            result.holdingsCoverage = { complete, rows: holdings.length, asOfDate: holdings[0].asOfDate, sourceUrl: config.holdings.url };
          }
          attempts.push({ kind: "holdings", status: holdings.length && (!isYuanta || complete) ? "loaded" : "incomplete_preserved_previous", complete, rows: holdings.length, url: config.holdings.url });
          const nav = isYuanta ? issuer.parseYuantaNav(html, ticker, config.nav, { priceSeries: { items: result.priceSeries } })
            : ticker === "006208" ? issuer.parseFubonNav(html, ticker, config.nav, { priceSeries: { items: result.priceSeries } }) : null;
          // A PCF's NAV date does not establish a fallback market close's trading date.
          if (nav && isoDate(nav.date) && nav.date <= asOf && nav.nav > 0) { nav.close = null; nav.premiumDiscountPercent = null; result.navSeries = mergeRows(result.navSeries, [nav], (row) => row.date); }
          if (!isYuanta) { attempts.push({ kind: "distributions", status: "adapter_not_connected" }); return; }
          if (fund.CAN_DISTRIBUTE === "N") {
            result.distributions = [];
            result.distributionHistory = { complete: true, nonDistributing: true, from: `${Number(asOf.slice(0, 4)) - 2}-01-01`, to: asOf, updatedAt: result.attemptedAt, sourceUrl: config.holdings.url };
          } else {
            const url = dividendUrl(fund.FUND_ID, asOf), json = JSON.parse(await fetchText(url));
            const sourceUrl = `https://www.yuantafunds.com/myfund/dividend/history?fundid=${fund.FUND_ID}`;
            const fresh = parseDividends(json, ticker, fund.FUND_ID, sourceUrl);
            // Empty/malformed distribution rows must not replace a verified history with a zero yield.
            if (!fresh.length || fresh.length !== json.Data.Data.length) throw new Error("Official distribution history has missing rows");
            result.distributions = fresh;
            result.distributionHistory = { complete: true, from: `${Number(asOf.slice(0, 4)) - 2}-01-01`, to: asOf, updatedAt: result.attemptedAt, sourceUrl };
          }
          attempts.push({ kind: "distributions", status: "loaded", rows: result.distributions.length, url: result.distributionHistory.sourceUrl });
        } catch (error) { attempts.push({ kind: "issuer", status: "failed_preserved_previous", error: error.message }); }
      })()
    ]);
    memory.set(ticker, result);
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      const file = path.join(cacheDir, `${ticker}.json`), temp = `${file}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(result)); fs.renameSync(temp, file);
    } catch { result.cacheWarning = "persistent_cache_unavailable"; }
    return result;
  }
  async function refresh(ticker, months = 1) {
    if (!/^0\d{3,5}[A-Z]?$/.test(ticker)) throw Object.assign(new Error("ETF 代號格式不正確"), { statusCode: 400 });
    if (![1, 3, 6].includes(months)) throw Object.assign(new Error("價格期間只能是 1、3 或 6 個月"), { statusCode: 400 });
    const db = JSON.parse(fs.readFileSync(typeof databasePath === "function" ? databasePath() : databasePath, "utf8"));
    if (!db.etfs.some((etf) => etf.ticker === ticker)) throw Object.assign(new Error("官方主檔沒有此 ETF"), { statusCode: 404 });
    const cached = readCache(ticker);
    if (cached && Number.isFinite(Date.parse(cached.attemptedAt)) && cached.coverageMonths >= months && today(new Date(cached.attemptedAt)) === today(now())
      && now().getTime() - Date.parse(cached.attemptedAt) < 15 * 60000) return cached;
    if (inFlight.has(ticker)) {
      const pending = await inFlight.get(ticker);
      return pending.coverageMonths >= months ? pending : refresh(ticker, months);
    }
    if (active >= 2) throw Object.assign(new Error("官方資料查詢中，請稍後重試"), { statusCode: 503 });
    active++;
    const pending = load(ticker, months, db).finally(() => { active--; inFlight.delete(ticker); });
    inFlight.set(ticker, pending);
    return pending;
  }
  function getSaved(ticker, months = 1) {
    if (!/^0\d{3,5}[A-Z]?$/.test(ticker)) throw Object.assign(new Error("ETF 代號格式不正確"), { statusCode: 400 });
    if (![1, 3, 6].includes(months)) throw Object.assign(new Error("價格期間只能是 1、3 或 6 個月"), { statusCode: 400 });
    const data = snapshotIndex().get(ticker);
    if (!data) throw Object.assign(new Error("官方主檔沒有此 ETF"), { statusCode: 404 });
    // Customer reads never initiate issuer requests or wait for refresh slots.
    return { ...data, requestedMonths: months };
  }
  return { get: async (ticker, months) => getSaved(ticker, months), getSaved, refresh };
}
module.exports = { createEtfMarketService, dividendUrl, parseDividends, mergeRows };
