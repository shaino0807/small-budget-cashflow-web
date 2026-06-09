const fs = require("fs");
const https = require("https");
const path = require("path");
const vm = require("vm");

const dbPath = path.join(__dirname, "..", "data", "etf-database.json");

const sourceConfigs = {
  "0056": {
    holdings: {
      url: "https://www.yuantaetfs.com/product/detail/0056/ratio",
      source: "yuanta-holdings-ratio",
      coverage: "partial_visible_rows"
    },
    nav: {
      url: "https://www.yuantaetfs.com/product/detail/0056/ratio",
      source: "yuanta-pcf-nav"
    }
  },
  "00878": {
    holdings: {
      url: "https://www.cathaysite.com.tw/ETF/detail/ECN?lang=en_US",
      source: "cathay-etf-detail-holdings",
      coverage: "unavailable_dynamic_page"
    },
    nav: {
      url: "https://www.cathaysite.com.tw/fund-details/ECN?tab=net_worth",
      source: "cathay-fund-detail-nav"
    }
  },
  "006208": {
    holdings: {
      url: "https://websys.fsit.com.tw/FubonETF/Fund/Assets.aspx?stkId=006208",
      source: "fubon-fund-assets",
      coverage: "full_visible_rows"
    },
    nav: {
      url: "https://websys.fsit.com.tw/FubonETF/Fund/Assets.aspx?stkId=006208",
      source: "fubon-fund-assets-nav"
    }
  }
};

function fetchText(url) {
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
          resolve(body);
        });
      })
      .on("error", reject);
  });
}

function textOf(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function extractNuxtState(html) {
  const marker = "window.__NUXT__=";
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const codeStart = start + marker.length;
  const codeEnd = html.indexOf("</script>", codeStart);
  if (codeEnd === -1) return null;
  const code = html.slice(codeStart, codeEnd).trim();
  if (!code.startsWith("(function(")) return null;
  if (/\b(require|process|globalThis|Function|eval|import|XMLHttpRequest)\b/.test(code)) return null;
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  try {
    vm.runInContext(`window.__NUXT__=${code}`, sandbox, { timeout: 1000 });
    return sandbox.window.__NUXT__ || null;
  } catch {
    return null;
  }
}

function toNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(String(value).replaceAll(",", "").replace("NT$", "").replace("NTD", "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function toIsoDate(value) {
  const match = String(value || "").match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!match) return null;
  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function yyyymmddToIso(value) {
  const match = String(value || "").match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function closeFor(db, ticker, date) {
  const rows = db.priceSeries?.items || [];
  const exact = rows.find((row) => row.ticker === ticker && row.date === date);
  const fallback = [...rows].reverse().find((row) => row.ticker === ticker);
  return exact?.close ?? fallback?.close ?? null;
}

function parseYuantaHoldings(html, ticker, config) {
  const state = extractNuxtState(html);
  const rows = state?.data?.[1]?.weightData?.FundWeights?.StockWeights;
  const pcf = state?.data?.[1]?.weightData?.PCF;
  if (Array.isArray(rows) && rows.length) {
    const asOfDate = yyyymmddToIso(pcf?.trandate);
    return rows.map((row) => ({
      ticker,
      asOfDate,
      holdingTicker: String(row.code || "").trim(),
      holdingName: String(row.name || row.code || "").trim(),
      weight: toNumber(row.weights),
      shares: toNumber(row.qty),
      sector: "",
      sourceUrl: config.url,
      source: config.source,
      coverage: "official_nuxt_state"
    })).filter((row) => row.holdingTicker && row.holdingName && row.weight !== null);
  }

  const text = textOf(html);
  const asOfDate = toIsoDate(text.match(/Trade Date:\s*(\d{4}\/\d{2}\/\d{2})/)?.[1]);
  const stockBlock = text.match(/基金權重-股票\s+([\s\S]+?)\s+基金權重-期貨/)?.[1] || text;
  const items = [];
  const rowPattern = /商品代碼\s+(\d{4})\s+商品名稱\s+(.+?)\s+商品數量\s+([\d,]+)\s+商品權重\s+([\d.]+)/g;
  let match;
  while ((match = rowPattern.exec(stockBlock))) {
    items.push({
      ticker,
      asOfDate,
      holdingTicker: match[1],
      holdingName: match[2].trim(),
      weight: toNumber(match[4]),
      shares: toNumber(match[3]),
      sector: "",
      sourceUrl: config.url,
      source: config.source,
      coverage: config.coverage
    });
  }
  return items;
}

function parseFubonHoldings(html, ticker, config) {
  const text = textOf(html);
  const asOfDate = toIsoDate(text.match(/資料日期：\s*(\d{4}\/\d{2}\/\d{2})/)?.[1]);
  const stockBlock = text.match(/股票代碼 股票名稱 股數 金額 權重\(%\)\s+([\s\S]+?)\s+股票合計/)?.[1] || "";
  const items = [];
  const rowPattern = /(\d{4})\s+(.+?)\s+([\d,]+)\s+([\d,]+)\s+([\d.]+)/g;
  let match;
  while ((match = rowPattern.exec(stockBlock))) {
    items.push({
      ticker,
      asOfDate,
      holdingTicker: match[1],
      holdingName: match[2].trim(),
      weight: toNumber(match[5]),
      shares: toNumber(match[3]),
      sector: "",
      sourceUrl: config.url,
      source: config.source,
      coverage: config.coverage
    });
  }
  return items;
}

function parseCathayHoldings(html, ticker, config) {
  const text = textOf(html);
  const items = [];
  const rowPattern = /(\d{4})\s+([\u4e00-\u9fa5A-Za-z0-9*.-]+)\s+([\d.]+)%/g;
  let match;
  while ((match = rowPattern.exec(text))) {
    items.push({
      ticker,
      asOfDate: null,
      holdingTicker: match[1],
      holdingName: match[2].trim(),
      weight: toNumber(match[3]),
      shares: null,
      sector: "",
      sourceUrl: config.url,
      source: config.source,
      coverage: "parsed_visible_rows"
    });
  }
  return items;
}

function parseYuantaNav(html, ticker, config, db) {
  const state = extractNuxtState(html);
  const pcf = state?.data?.[1]?.weightData?.PCF;
  if (pcf?.trandate && pcf.nav !== undefined) {
    const date = yyyymmddToIso(pcf.trandate);
    const nav = toNumber(pcf.nav);
    return navRow(ticker, date, nav, closeFor(db, ticker, date), config);
  }

  const text = textOf(html);
  const date = toIsoDate(text.match(/#####\s*(\d{4}\/\d{2}\/\d{2})\s+####\s+NAV Per Share/)?.[1])
    || toIsoDate(text.match(/NAV Per Share\s+NTD\s+[\d,.]+.*?#####\s*(\d{4}\/\d{2}\/\d{2})/)?.[1])
    || toIsoDate(text.match(/Announce Date：\s*(\d{4}\/\d{2}\/\d{2})/)?.[1]);
  const nav = toNumber(text.match(/NAV Per Share\s+NTD\s+([\d,.]+)/)?.[1]);
  return navRow(ticker, date, nav, closeFor(db, ticker, date), config);
}

function parseCathayNav(html, ticker, config) {
  const text = textOf(html);
  const closeMatch = text.match(/收盤價\s*\((\d{4}\/\d{2}\/\d{2})\)\s*([\d.]+)\s*新台幣/);
  const navMatch = text.match(/淨值\s*\((\d{4}\/\d{2}\/\d{2})\)\s*([\d.]+)\s*新台幣/);
  const date = toIsoDate(navMatch?.[1] || closeMatch?.[1]);
  return navRow(ticker, date, toNumber(navMatch?.[2]), toNumber(closeMatch?.[2]), config);
}

function parseFubonNav(html, ticker, config, db) {
  const text = textOf(html);
  const date = toIsoDate(text.match(/資料日期：\s*(\d{4}\/\d{2}\/\d{2})/)?.[1]);
  const nav = toNumber(text.match(/基金每單位淨值\(新台幣\)\s*([\d,.]+)/)?.[1]);
  return navRow(ticker, date, nav, closeFor(db, ticker, date), config);
}

function navRow(ticker, date, nav, close, config) {
  if (!date || nav === null) return null;
  const premiumDiscountPercent = close === null ? null : Number((((close - nav) / nav) * 100).toFixed(4));
  return {
    ticker,
    date,
    close,
    nav,
    premiumDiscountPercent,
    sourceUrl: config.url,
    source: config.source
  };
}

async function main() {
  const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  const sourceAttempts = [];
  const holdingsItems = [];
  const navItems = [];

  for (const ticker of Object.keys(sourceConfigs)) {
    const config = sourceConfigs[ticker];

    try {
      const holdingsHtml = await fetchText(config.holdings.url);
      const parsed = ticker === "0056"
        ? parseYuantaHoldings(holdingsHtml, ticker, config.holdings)
        : ticker === "006208"
          ? parseFubonHoldings(holdingsHtml, ticker, config.holdings)
          : parseCathayHoldings(holdingsHtml, ticker, config.holdings);
      holdingsItems.push(...parsed);
      sourceAttempts.push({ ticker, kind: "holdings", status: parsed.length ? "loaded" : "no_visible_rows", rows: parsed.length, url: config.holdings.url });
    } catch (error) {
      sourceAttempts.push({ ticker, kind: "holdings", status: "failed", error: error.message, url: config.holdings.url });
    }

    try {
      const navHtml = await fetchText(config.nav.url);
      const parsed = ticker === "0056"
        ? parseYuantaNav(navHtml, ticker, config.nav, db)
        : ticker === "006208"
          ? parseFubonNav(navHtml, ticker, config.nav, db)
          : parseCathayNav(navHtml, ticker, config.nav);
      if (parsed) navItems.push(parsed);
      sourceAttempts.push({ ticker, kind: "nav", status: parsed ? "loaded" : "no_visible_nav", rows: parsed ? 1 : 0, url: config.nav.url });
    } catch (error) {
      sourceAttempts.push({ ticker, kind: "nav", status: "failed", error: error.message, url: config.nav.url });
    }
  }

  db.holdings.status = holdingsItems.length ? "official_issuer_pages_loaded_with_gaps" : "missing_official_machine_readable_source";
  db.holdings.items = holdingsItems;
  db.holdings.sourceAttempts = sourceAttempts.filter((attempt) => attempt.kind === "holdings");
  db.navSeries.status = navItems.length ? "official_issuer_pages_loaded" : "missing_official_machine_readable_source";
  db.navSeries.items = navItems;
  db.navSeries.sourceAttempts = sourceAttempts.filter((attempt) => attempt.kind === "nav");

  for (const etf of db.etfs) {
    const holdingRows = holdingsItems.filter((item) => item.ticker === etf.ticker);
    const hasNav = navItems.some((item) => item.ticker === etf.ticker);
    const flags = new Set((etf.qualityFlags || []).filter((flag) => ![
      "holdings_missing",
      "holdings_loaded",
      "holdings_partial",
      "nav_series_missing",
      "nav_series_loaded"
    ].includes(flag)));
    if (holdingRows.length >= 10) flags.add("holdings_loaded");
    else if (holdingRows.length > 0) flags.add("holdings_partial");
    else flags.add("holdings_missing");
    if (hasNav) flags.add("nav_series_loaded");
    else flags.add("nav_series_missing");
    etf.qualityFlags = [...flags];
  }

  for (const source of [
    { id: "yuanta-holdings-ratio", name: "元大投信 ETF 持股比重", url: sourceConfigs["0056"].holdings.url, usage: "0056 官方持股比重頁，優先解析 Nuxt SSR 狀態中的完整 StockWeights" },
    { id: "yuanta-pcf-nav", name: "元大投信 ETF 持股比重 / PCF 淨值欄位", url: sourceConfigs["0056"].nav.url, usage: "0056 官方 NAV/PCF 欄位" },
    { id: "cathay-fund-detail-nav", name: "國泰投信基金詳情淨值和市價", url: sourceConfigs["00878"].nav.url, usage: "00878 官方收盤價、淨值與日期" },
    { id: "cathay-etf-detail-holdings", name: "國泰投信 ETF 詳情持股權重", url: sourceConfigs["00878"].holdings.url, usage: "00878 官方持股權重頁；目前公開 HTML 未穩定吐出表格列" },
    { id: "fubon-fund-assets", name: "富邦投信 ETF 基金資產", url: sourceConfigs["006208"].holdings.url, usage: "006208 官方基金資產、完整可見持股列與 NAV" }
  ]) {
    db.metadata.sources = db.metadata.sources.filter((item) => item.id !== source.id);
    db.metadata.sources.push(source);
  }

  db.metadata.limitations = db.metadata.limitations.filter((item) => !item.includes("成分股權重、逐日 NAV"));
  db.metadata.limitations.push("投信官方頁已接上可解析來源：0056 與 006208 持股/NAV 可由官方頁解析，00878 NAV 可見但持股權重表格仍是動態頁，需取得正式 API 或下載檔。");

  fs.writeFileSync(dbPath, `${JSON.stringify(db, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    holdingsRows: holdingsItems.length,
    navRows: navItems.length,
    sourceAttempts
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
