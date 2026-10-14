const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { officialDate, toNumber, atomicWriteJson } = require("./update-safety");
const tpexProductsUrl = "https://info.tpex.org.tw/api/etfFilter";

const dbPath = process.env.ETF_DATABASE_PATH
  ? path.resolve(process.env.ETF_DATABASE_PATH)
  : path.join(__dirname, "..", "data", "etf-database.json");
const productsUrl = "https://www.twse.com.tw/zh/ETFortune/ajaxProductsResult";
const productsPageUrl = "https://www.twse.com.tw/zh/ETFortune/products";

const filters = [
  { field: "managerType", value: "Active", label: "主動式ETF", target: "managerType" },
  { field: "managerType", value: "Passive", label: "被動式ETF", target: "managerType" },
  { field: "assetType", value: "Stock", label: "股票型", target: "assetTypes" },
  { field: "assetType", value: "Bond", label: "債券型", target: "assetTypes" },
  { field: "assetType", value: "MultiAsset", label: "多資產", target: "assetTypes" },
  { field: "assetType", value: "RawMaterial", label: "期貨型原物料", target: "assetTypes" },
  { field: "assetType", value: "FX", label: "貨幣型", target: "assetTypes" },
  { field: "assetType", value: "REITs", label: "REITs", target: "assetTypes" },
  { field: "rewardType", value: "Vanilla", label: "原型", target: "rewardTypes" },
  { field: "rewardType", value: "L", label: "槓桿型", target: "rewardTypes" },
  { field: "rewardType", value: "I", label: "反向型", target: "rewardTypes" },
  { field: "hashtag", value: "ff808081899b8efc0189aa050440001c", label: "高股息", target: "themes" },
  { field: "hashtag", value: "ff808081899b8efc0189aa05af5c001d", label: "高息低波動", target: "themes" },
  { field: "hashtag", value: "ff808081899b8efc0189aa05ed24001e", label: "因子投資", target: "themes" },
  { field: "hashtag", value: "ff808081899b8efc0189aa06281f001f", label: "等權重", target: "themes" },
  { field: "hashtag", value: "ff808081899b8efc0189aa066a5a0020", label: "全市場指數", target: "themes" },
  { field: "hashtag", value: "ff808081899b8efc0189aa06d5ce0021", label: "大型權值", target: "themes" },
  { field: "hashtag", value: "ff808081899b8efc0189aa070e910022", label: "中小型權值", target: "themes" },
  { field: "hashtag", value: "ff808081899b8efc0189aa074b8d0023", label: "科技主題型", target: "themes" },
  { field: "hashtag", value: "ff808081899b8efc0189aa0786cb0024", label: "金融", target: "themes" },
  { field: "hashtag", value: "ff808081899b8efc0189aa07ec700025", label: "綠能及電動車", target: "themes" },
  { field: "hashtag", value: "ff808081899b8efc0189aa082e6d0026", label: "生技", target: "themes" },
  { field: "hashtag", value: "ff808081899b8efc0189aa0864d40027", label: "公司治理及ESG", target: "themes" }
];

function requestProducts(url, body, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === "http:" ? http : https;
    const req = client.request(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Content-Length": Buffer.byteLength(body),
        "User-Agent": "SmallBudgetCashflowMap/0.1",
        "Referer": url.startsWith(tpexProductsUrl) ? "https://info.tpex.org.tw/" : productsPageUrl,
        "X-Requested-With": "XMLHttpRequest"
      }
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirectCount >= 5) {
          reject(new Error(`Too many redirects for ${url}`));
          return;
        }
        const nextUrl = new URL(res.headers.location, url).toString();
        requestProducts(nextUrl, body, redirectCount + 1).then(resolve, reject);
        return;
      }
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("Aborted response")));
      let response = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        response += chunk;
      });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try {
          const json = JSON.parse(response);
          if (json.status !== "success" || !Array.isArray(json.data)) {
            reject(new Error(`Unexpected TWSE response status: ${json.status || "unknown"}`));
            return;
          }
          resolve(json.data);
        } catch (error) {
          reject(new Error(`Invalid JSON: ${error.message}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error(`Request timeout for ${url}`));
    });
    req.write(body);
    req.end();
  });
}

function postProducts(params = {}) {
  const body = new URLSearchParams(params).toString();
  return requestProducts(productsUrl, body);
}



function pushUnique(target, key, value) {
  if (!value) return;
  if (!Array.isArray(target[key])) target[key] = [];
  if (!target[key].includes(value)) target[key].push(value);
}


function textIncludesAny(text, words) {
  return words.some((word) => text.includes(word));
}

function pushRule(rules, id, reason) {
  rules.push({ id, reason });
}

function displayClassificationFor(etf) {
  const text = `${etf.shortName || ""} ${etf.fundName || ""} ${etf.indexName || ""} ${(etf.themes || []).join(" ")}`.toLowerCase();
  const rules = [];
  let assetClass = "未分類";
  let strategy = etf.managerType || "未分類";
  let incomeStyle = "一般";
  let market = "未分類";
  let primary = "ETF";

  if (textIncludesAny(text, ["債", "bond", "treasury", "投資等級", "高收益", "公債", "公司債", "政金債"])) {
    assetClass = "債券型";
    pushRule(rules, "asset-bond-keywords", "名稱或追蹤指數含債券關鍵字");
  } else if (textIncludesAny(text, ["黃金", "原油", "油正", "商品", "原物料", "期貨"])) {
    assetClass = "商品型";
    pushRule(rules, "asset-commodity-keywords", "名稱或追蹤指數含商品/期貨關鍵字");
  } else if (textIncludesAny(text, ["reit", "不動產", "房地產"])) {
    assetClass = "REITs";
    pushRule(rules, "asset-reit-keywords", "名稱或追蹤指數含 REITs/不動產關鍵字");
  } else if (textIncludesAny(text, ["多資產", "平衡", "多重資產"])) {
    assetClass = "多資產";
    pushRule(rules, "asset-multi-asset-keywords", "名稱或追蹤指數含多資產關鍵字");
  } else if (textIncludesAny(text, ["貨幣市場", "美元貨幣", "money market"])) {
    assetClass = "貨幣型";
    pushRule(rules, "asset-money-market-keywords", "名稱或追蹤指數含貨幣市場關鍵字");
  } else if (textIncludesAny(text, ["股票", "指數", "臺灣", "台灣", "半導體", "科技", "金融", "公司治理", "esg", "高股息", "nasdaq", "s&p", "道瓊", "費城", "恒生", "日經", "印度", "越南"])) {
    assetClass = "股票型";
    pushRule(rules, "asset-equity-keywords", "名稱、追蹤指數或官方主題含股票市場關鍵字");
  }

  if ((etf.rewardTypes || []).includes("槓桿型")) {
    strategy = "槓桿型";
    primary = "槓桿型";
    pushRule(rules, "strategy-leveraged-official", "TWSE rewardType 官方篩選器命中槓桿型");
  } else if ((etf.rewardTypes || []).includes("反向型")) {
    strategy = "反向型";
    primary = "反向型";
    pushRule(rules, "strategy-inverse-official", "TWSE rewardType 官方篩選器命中反向型");
  } else if ((etf.themes || []).includes("高股息") || textIncludesAny(text, ["高股息", "高息", "收益"])) {
    incomeStyle = "高股息/收益";
    primary = "高股息";
    pushRule(rules, "income-high-dividend", "官方主題或名稱含高股息/收益");
  } else if ((etf.themes || []).includes("全市場指數") || (etf.themes || []).includes("大型權值")) {
    primary = "市值型";
    pushRule(rules, "strategy-market-cap-official-theme", "TWSE 官方主題命中全市場指數或大型權值");
  } else if (assetClass !== "未分類") {
    primary = assetClass;
  }

  if (textIncludesAny(text, ["臺灣", "台灣", "twse", "櫃買", "上櫃", "加權"])) {
    market = "台灣";
    pushRule(rules, "market-taiwan-keywords", "名稱或追蹤指數含台灣市場關鍵字");
  } else if (textIncludesAny(text, ["美國", "nasdaq", "s&p", "標普", "道瓊", "費城", "nyse"])) {
    market = "美國";
    pushRule(rules, "market-us-keywords", "名稱或追蹤指數含美國市場關鍵字");
  } else if (textIncludesAny(text, ["中國", "香港", "恒生", "上證", "深證", "滬深"])) {
    market = "中港";
    pushRule(rules, "market-china-hk-keywords", "名稱或追蹤指數含中港市場關鍵字");
  } else if (textIncludesAny(text, ["日本", "日經"])) {
    market = "日本";
    pushRule(rules, "market-japan-keywords", "名稱或追蹤指數含日本市場關鍵字");
  } else if (textIncludesAny(text, ["印度"])) {
    market = "印度";
    pushRule(rules, "market-india-keywords", "名稱或追蹤指數含印度市場關鍵字");
  } else if (textIncludesAny(text, ["越南"])) {
    market = "越南";
    pushRule(rules, "market-vietnam-keywords", "名稱或追蹤指數含越南市場關鍵字");
  } else if (textIncludesAny(text, ["全球", "世界", "新興市場"])) {
    market = "全球/新興";
    pushRule(rules, "market-global-keywords", "名稱或追蹤指數含全球或新興市場關鍵字");
  }

  return {
    primary,
    assetClass,
    strategy,
    incomeStyle,
    market,
    source: etf.listingMarket === "TPEx" ? "derived_from_official_tpex_fields" : "derived_from_official_twse_fields",
    confidence: rules.length ? "rule_based" : "unknown",
    rules
  };
}


async function refreshEtfMaster(input, { fetchProducts = postProducts,
  fetchTpex = () => requestProducts(tpexProductsUrl, ""),
  now = new Date().toISOString(), classificationFilters = filters } = {}) {
  const db = structuredClone(input);
  const byTicker = new Map((db.etfs || []).map((row) => [row.ticker, row]));
  const classifications = new Map(), sourceAttempts = [], updated = new Set();
  const failedClassificationTargets = new Set();
  const catalogs = [];
  for (const [market, source, url, fetcher] of [
    ["TWSE", "twse-etfortune-products", productsUrl, fetchProducts],
    ["TPEx", "tpex-etf-filter", tpexProductsUrl, fetchTpex]
  ]) {
    try {
      const rows = await fetcher();
      if (!Array.isArray(rows) || !rows.length) throw new Error("Empty or invalid ETF catalog");
      catalogs.push({ market, source, url, rows });
    } catch (error) {
      sourceAttempts.push({ market, source, url, status: "failed", error: error.message });
    }
  }
  if (catalogs.some((c) => c.market === "TWSE")) {
    for (const filter of classificationFilters) {
      try {
        const rows = await fetchProducts({ [filter.field]: filter.value });
        if (!Array.isArray(rows)) throw new Error("Invalid filter response");
        for (const row of rows) {
          const ticker = String(row.stockNo || "").trim();
          if (!ticker) continue;
          const current = classifications.get(ticker) || {};
          if (filter.target === "managerType") current.managerType = filter.label;
          else pushUnique(current, filter.target, filter.label);
          classifications.set(ticker, current);
        }
        sourceAttempts.push({ source: "twse-etfortune-filter-" + filter.field + "-" + filter.value, status: "loaded", rows: rows.length, label: filter.label, url: productsUrl });
      } catch (error) {
        failedClassificationTargets.add(filter.target);
        sourceAttempts.push({ source: "twse-etfortune-filter-" + filter.field + "-" + filter.value, status: "failed", error: error.message, label: filter.label, url: productsUrl });
      }
    }
  }
  const counts = new Map();
  for (const { rows } of catalogs) for (const row of rows) {
    const ticker = String(row.stockNo || "").trim();
    counts.set(ticker, (counts.get(ticker) || 0) + 1);
  }
  for (const { market, source, url, rows } of catalogs) {
    const rejected = [];
    let accepted = 0;
    for (const row of rows) {
      const ticker = String(row.stockNo || "").trim();
      const shortName = String(row.stockName || "").trim();
      const issuer = String(row.issuer || "").trim();
      const listingDate = officialDate(row.listingDate);
      const reason = !/^0\d{3,5}[A-Z]?$/.test(ticker) ? "invalid_ticker"
        : counts.get(ticker) > 1 ? "duplicate_ticker" : !shortName || !issuer || !listingDate ? "missing_identity" : null;
      if (reason) { rejected.push({ ticker, reason }); continue; }
      const old = byTicker.get(ticker) || {};
      const classification = classifications.get(ticker) || {};
      for (const target of ["assetTypes", "themes", "rewardTypes"]) {
        if (failedClassificationTargets.has(target)) {
          classification[target] = [...new Set([...(old[target] || []), ...(classification[target] || [])])];
        }
      }
      const close = toNumber(row.close1);
      // Blank index is unknown, never silently turned into the claim "no index".
      const indexName = String(Object.hasOwn(row, "indexName") ? row.indexName ?? "" : old.indexName ?? "").trim();
      const next = { ...old, ticker, shortName, fundName: old.fundName || shortName, issuer, listingDate,
        listingMarket: market, indexName,
        indexNameStatus: !indexName ? "official_field_empty" : indexName === "無" ? "official_explicit_none" : "official_field",
        assetTypes: classification.assetTypes || old.assetTypes || [],
        themes: classification.themes || old.themes || [],
        rewardTypes: classification.rewardTypes || old.rewardTypes || [],
        managerType: classification.managerType || old.managerType || "",
        aumBillionTwd: toNumber(row.totalAv), beneficiaries: toNumber(row.holders),
        ytdAverageValueMillionTwd: toNumber(row.valueYTD), ytdAverageVolume: toNumber(row.volumeYTD),
        close: close !== null && close > 0 ? close : old.close ?? null,
        performance: { ...(old.performance || {}), date: null, observedAt: now,
          sourceDateStatus: "official_endpoint_does_not_provide_date", source },
        sourceUrl: market === "TWSE" ? "https://www.twse.com.tw/zh/ETFortune/etfInfo/" + ticker : tpexProductsUrl,
        masterObservedAt: now, masterRefreshStatus: "updated",
        qualityFlags: [...new Set([...(old.qualityFlags || ["holdings_missing", "price_series_missing", "nav_series_missing"]).filter((f) => !["master_preserved", "official_twse_master_loaded", "official_tpex_master_loaded"].includes(f)),
          market === "TWSE" ? "official_twse_master_loaded" : "official_tpex_master_loaded"])]
      };
      next.displayClassification = displayClassificationFor(next);
      next.category = next.assetTypes[0] || next.displayClassification.assetClass || "未分類";
      byTicker.set(ticker, next);
      updated.add(ticker);
      accepted++;
    }
    sourceAttempts.push({ market, source, url, status: accepted ? (rejected.length ? "partial" : "loaded") : "failed",
      rows: rows.length, accepted, rejected, observedAt: now, sourceDataDate: null });
  }
  let preserved = 0;
  for (const row of byTicker.values()) {
    if (updated.has(row.ticker)) continue;
    row.masterRefreshStatus = "preserved_previous";
    row.qualityFlags = [...new Set([...(row.qualityFlags || []), "master_preserved"])];
    preserved++;
  }
  if (!byTicker.size) throw new Error("No usable ETF master; no database written");
  db.etfs = [...byTicker.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
  db.metadata ||= {};
  db.metadata.refreshExecutedAt = now;
  db.metadata.buildMode = "official_twse_tpex_master_with_quality_flags";
  db.metadata.limitations = [...new Set([
    ...(db.metadata.limitations || []).filter((text) => !text.startsWith("ETF 全市場主檔與分類來自 TWSE")),
    "上市與上櫃 ETF 主檔分別來自 TWSE／TPEx；來源失敗或缺列保留前次資料並標記。",
    "主檔端點未提供資料日；空白追蹤指數代表待核實，不推定為無指數。主檔收錄不等於成分股、價格或殖利率已驗收。"
  ])];
  db.metadata.sources = (db.metadata.sources || []).filter((s) => !["twse-etfortune-products", "tpex-etf-filter"].includes(s.id));
  db.metadata.sources.push(
    { id: "twse-etfortune-products", name: "TWSE ETF e添富", url: productsPageUrl, endpoint: productsUrl, usage: "上市ETF主檔與官方篩選器" },
    { id: "tpex-etf-filter", name: "TPEx ETF 投資資訊", url: tpexProductsUrl, usage: "上櫃ETF主檔；未提供資料日期與收盤價的欄位保留缺口" });
  db.classificationRules = {
    ...(db.classificationRules || {}), status: "display_rules_loaded", source: "derived_from_official_exchange_fields",
    notes: ["TWSE 篩選器與交易所主檔文字推導顯示分類；不等於官方資產分類。TPEx 未接篩選器分類。"]
  };
  db.etfMaster = { status: preserved || sourceAttempts.some((s) => s.status !== "loaded") ? "official_master_partial" : "official_master_loaded",
    observedAt: updated.size ? now : db.etfMaster?.observedAt || null, lastAttemptAt: now, preserved,
    items: db.etfs.map((row) => ({ ticker: row.ticker, shortName: row.shortName, listingMarket: row.listingMarket,
      issuer: row.issuer, listingDate: row.listingDate, indexName: row.indexName, indexNameStatus: row.indexNameStatus,
      category: row.category, assetTypes: row.assetTypes, rewardTypes: row.rewardTypes, managerType: row.managerType,
      themes: row.themes, displayClassification: row.displayClassification, sourceUrl: row.sourceUrl })),
    sourceAttempts };
  return db;
}
async function main() {
  const db = await refreshEtfMaster(JSON.parse(fs.readFileSync(dbPath, "utf8")));
  atomicWriteJson(dbPath, db);
  console.log(JSON.stringify({ etfs: db.etfs.length, status: db.etfMaster.status, sourceAttempts: db.etfMaster.sourceAttempts }, null, 2));
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { refreshEtfMaster, requestProducts, displayClassificationFor };
