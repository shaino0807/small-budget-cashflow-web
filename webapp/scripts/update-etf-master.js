const fs = require("fs");
const https = require("https");
const path = require("path");

const dbPath = path.join(__dirname, "..", "data", "etf-database.json");
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

function postProducts(params = {}) {
  const body = new URLSearchParams(params).toString();
  return new Promise((resolve, reject) => {
    const req = https.request(productsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Content-Length": Buffer.byteLength(body),
        "User-Agent": "SmallBudgetCashflowMap/0.1",
        "Referer": productsPageUrl,
        "X-Requested-With": "XMLHttpRequest"
      }
    }, (res) => {
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
    req.write(body);
    req.end();
  });
}

function toNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(String(value).replaceAll(",", "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function dotDateToIso(value) {
  const match = String(value || "").trim().match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function pushUnique(target, key, value) {
  if (!value) return;
  if (!Array.isArray(target[key])) target[key] = [];
  if (!target[key].includes(value)) target[key].push(value);
}

function mergeQualityFlags(existing) {
  const keep = (existing?.qualityFlags || []).filter((flag) => ![
    "official_master_loaded",
    "official_twse_master_loaded"
  ].includes(flag));
  return [...new Set([...keep, "official_twse_master_loaded"])];
}

async function main() {
  const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  const existingByTicker = new Map((db.etfs || []).map((etf) => [etf.ticker, etf]));
  const rows = await postProducts();
  const classifications = new Map();
  const sourceAttempts = [{ source: "twse-etfortune-products", status: "loaded", rows: rows.length, url: productsUrl }];

  for (const filter of filters) {
    try {
      const filteredRows = await postProducts({ [filter.field]: filter.value });
      filteredRows.forEach((row) => {
        const ticker = String(row.stockNo || "").trim();
        if (!ticker) return;
        const current = classifications.get(ticker) || { themes: [], assetTypes: [], rewardTypes: [], managerType: "" };
        if (filter.target === "managerType") current.managerType = filter.label;
        else pushUnique(current, filter.target, filter.label);
        classifications.set(ticker, current);
      });
      sourceAttempts.push({ source: `twse-etfortune-filter-${filter.field}-${filter.value}`, status: "loaded", rows: filteredRows.length, label: filter.label, url: productsUrl });
    } catch (error) {
      sourceAttempts.push({ source: `twse-etfortune-filter-${filter.field}-${filter.value}`, status: "failed", error: error.message, label: filter.label, url: productsUrl });
    }
  }

  const snapshotDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());

  const etfs = rows
    .map((row) => {
      const ticker = String(row.stockNo || "").trim();
      const existing = existingByTicker.get(ticker) || {};
      const classification = classifications.get(ticker) || {};
      const shortName = String(row.stockName || existing.shortName || ticker).trim();
      const assetTypes = classification.assetTypes || existing.assetTypes || [];
      const themes = classification.themes || existing.themes || [];
      const rewardTypes = classification.rewardTypes || existing.rewardTypes || [];
      return {
        ...existing,
        ticker,
        shortName,
        fundName: existing.fundName || shortName,
        category: assetTypes[0] || existing.category || "未分類",
        assetTypes,
        rewardTypes,
        managerType: classification.managerType || existing.managerType || "",
        issuer: String(row.issuer || existing.issuer || "").trim(),
        indexName: String(row.indexName || existing.indexName || "").trim() || "無",
        listingDate: dotDateToIso(row.listingDate) || existing.listingDate || null,
        themes,
        aumBillionTwd: toNumber(row.totalAv),
        beneficiaries: toNumber(row.holders),
        ytdAverageValueMillionTwd: toNumber(row.valueYTD),
        ytdAverageVolume: toNumber(row.volumeYTD),
        close: toNumber(row.close1),
        performance: {
          ...(existing.performance || {}),
          date: snapshotDate,
          source: "twse-etfortune-products"
        },
        sourceUrl: `https://www.twse.com.tw/zh/ETFortune/etfInfo/${ticker}`,
        qualityFlags: mergeQualityFlags(existing)
      };
    })
    .filter((etf) => etf.ticker)
    .sort((a, b) => a.ticker.localeCompare(b.ticker));

  db.etfs = etfs;
  db.metadata = db.metadata || {};
  db.metadata.snapshotDate = snapshotDate;
  db.metadata.officialPerformanceDate = snapshotDate;
  db.metadata.buildMode = "official_twse_etfortune_master_with_quality_flags";
  db.metadata.featuredTickers = db.metadata.featuredTickers || ["0056", "00878", "006208"];
  db.metadata.sources = (db.metadata.sources || []).filter((source) => source.id !== "twse-etfortune-products");
  db.metadata.sources.push({
    id: "twse-etfortune-products",
    name: "TWSE ETF e添富投資篩選器",
    url: productsPageUrl,
    endpoint: productsUrl,
    usage: "全市場 ETF 主檔、上市日期、追蹤指數、資產規模、收盤價、受益人數、發行人，以及官方篩選器分類"
  });
  db.metadata.limitations = [
    "ETF 全市場主檔與分類來自 TWSE ETF e添富投資篩選器官方端點。",
    "TWSE 投資篩選器 assetType 資產類別參數目前回 HTTP 403；在取得可穩定讀取的官方端點前，資產類別保留為未分類，不用名稱猜測補值。",
    "ETF 成分股、NAV/折溢價與配息仍需分投信或其他正式來源逐項接入；未接上的 ETF 會保留缺資料狀態。",
    "00878 NAV 可見但持股權重表格仍是動態頁，需取得正式 API 或下載檔；不使用第三方資料硬補。"
  ];
  db.etfMaster = {
    status: "official_twse_etfortune_loaded",
    items: etfs.map((etf) => ({
      ticker: etf.ticker,
      shortName: etf.shortName,
      category: etf.category,
      assetTypes: etf.assetTypes,
      rewardTypes: etf.rewardTypes,
      managerType: etf.managerType,
      themes: etf.themes,
      issuer: etf.issuer,
      listingDate: etf.listingDate,
      indexName: etf.indexName,
      sourceUrl: etf.sourceUrl
    })),
    sourceAttempts
  };

  fs.writeFileSync(dbPath, `${JSON.stringify(db, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    etfs: etfs.length,
    classified: [...classifications.keys()].length,
    sourceAttempts
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
