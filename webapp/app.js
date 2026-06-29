const storageKey = "cashflow-map-web-state";
const inputVersion = "cashflow-input-v2";
const reportVersion = "cashflow-report-v2";
const apiBase = String(window.CASHFLOW_API_BASE || "").replace(/\/$/, "");
const consultationIgUrl = String(window.CONSULTATION_IG_URL || "https://www.instagram.com/chendino080077/");
const consultationLineUrl = String(window.CONSULTATION_LINE_URL || "");
const fullReportPriceTwd = Math.max(1, Math.round(Number(window.FULL_REPORT_PRICE_TWD || 499)));
const consultationDepositTwd = Math.max(1, Math.round(Number(window.CONSULTATION_DEPOSIT_TWD || 200)));
const consultationFeeTwd = Math.max(1, Math.round(Number(window.CONSULTATION_FEE_TWD || 1500)));
const disclaimer = "本 App 僅供教育與財務規劃參考，不構成任何投資建議、買賣建議或保證報酬。所有投資皆有風險，使用者應自行判斷並承擔投資結果。";
const monthLabels = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];
const monthFields = ["monthlyIncome", "fixedExpense", "insuranceExpense", "loanExpense", "monthlyInvestment"];
const simulationYearOptions = [10, 15, 20, 25, 30];
const industryNames = {
  "01": "水泥工業",
  "02": "食品工業",
  "03": "塑膠工業",
  "04": "紡織纖維",
  "05": "電機機械",
  "06": "電器電纜",
  "07": "化學生技醫療",
  "08": "玻璃陶瓷",
  "09": "造紙工業",
  "10": "鋼鐵工業",
  "11": "橡膠工業",
  "12": "汽車工業",
  "14": "建材營造業",
  "15": "航運業",
  "16": "觀光餐旅",
  "17": "金融保險業",
  "18": "貿易百貨業",
  "20": "其他業",
  "21": "化學工業",
  "22": "生技醫療業",
  "23": "油電燃氣業",
  "24": "半導體業",
  "25": "電腦及週邊設備業",
  "26": "光電業",
  "27": "通信網路業",
  "28": "電子零組件業",
  "29": "電子通路業",
  "30": "資訊服務業",
  "31": "其他電子業",
  "32": "文化創意業",
  "33": "農業科技業",
  "34": "電子商務業",
  "35": "綠能環保",
  "36": "數位雲端",
  "37": "運動休閒",
  "38": "居家生活",
  "91": "存託憑證"
};

const defaultState = {
  profile: {
    monthlyIncome: 0,
    fixedExpense: 0,
    insuranceExpense: 0,
    loanExpense: 0,
    cashSavings: 0,
    monthlyInvestment: 0,
    age: 35,
    retirementMonthlyNeed: 30000
  },
  holdings: [],
  monthlyCashflows: {},
  simulationYears: 10,
  paidUnlocked: false,
  consultingUnlocked: false,
  anonymousId: crypto.randomUUID(),
  consent: {
    accepted: false,
    acceptedAt: null,
    contactChannel: "none",
    contactValue: ""
  },
  inputCompletion: {
    profile: {},
    stockAnswers: []
  },
  reportMeta: null,
  payment: {
    lastOrderId: null,
    lastProductType: null,
    lastStatus: null,
    statusToken: null,
    message: ""
  },
  leadProfile: {
    checkType: "cashflow",
    capacity: "5000to10000",
    concern: "saving",
    stockMonthlyBudget: 0,
    stockReason: "price",
    stockDrop: "unsure",
    stockCount: "0",
    stockHorizon: "1year"
  }
};

const sampleState = {
  profile: {
    monthlyIncome: 62000,
    fixedExpense: 28500,
    insuranceExpense: 4200,
    loanExpense: 6500,
    cashSavings: 210000,
    monthlyInvestment: 12000,
    age: 34,
    retirementMonthlyNeed: 36000
  },
  holdings: [
    { ticker: "0056", name: "高股息 ETF", type: "高股息", amount: 180000, lots: [{ price: 36, amount: 100000 }, { price: 38, amount: 80000 }], dividendYield: 6.1, expenseRatio: 0.43, sector: "金融" },
    { ticker: "00878", name: "ESG 高股息", type: "高股息", amount: 160000, lots: [{ price: 21, amount: 90000 }, { price: 23, amount: 70000 }], dividendYield: 5.7, expenseRatio: 0.38, sector: "電子" },
    { ticker: "006208", name: "台股市值型", type: "市值型", amount: 90000, lots: [{ price: 115, amount: 90000 }], dividendYield: 2.3, expenseRatio: 0.15, sector: "半導體" }
  ],
  monthlyCashflows: {},
  simulationYears: 10,
  paidUnlocked: false,
  consultingUnlocked: false,
  anonymousId: crypto.randomUUID(),
  consent: {
    accepted: true,
    acceptedAt: new Date().toISOString(),
    contactChannel: "none",
    contactValue: ""
  },
  inputCompletion: {
    profile: { monthlyIncome: true, fixedExpense: true, cashSavings: true },
    stockAnswers: ["stockReason", "stockDrop", "stockCount", "stockHorizon"]
  },
  reportMeta: null,
  payment: {
    lastOrderId: null,
    lastProductType: null,
    lastStatus: null,
    statusToken: null,
    message: ""
  },
  leadProfile: {
    checkType: "cashflow",
    capacity: "5000to10000",
    concern: "investing",
    stockMonthlyBudget: 8000,
    stockReason: "learn",
    stockDrop: "hold",
    stockCount: "1to3",
    stockHorizon: "3years"
  }
};

let state = loadState();
let activeView = "landingView";
let etfDatabase = null;
let etfDataQuality = {
  status: "loading",
  errors: [],
  warnings: ["ETF 官方資料庫尚未載入"],
  counts: { etfs: 0, distributions: 0, holdings: 0, stocks: 0, priceSeries: 0, navSeries: 0 }
};
let latestReport = null;

const profileFields = [
  "monthlyIncome",
  "fixedExpense",
  "insuranceExpense",
  "loanExpense",
  "cashSavings",
  "monthlyInvestment",
  "age",
  "retirementMonthlyNeed"
];

const money = new Intl.NumberFormat("zh-TW", {
  style: "currency",
  currency: "TWD",
  maximumFractionDigits: 0
});

const number = new Intl.NumberFormat("zh-TW", {
  maximumFractionDigits: 0
});

latestReport = buildReport();

function loadState() {
  const saved = localStorage.getItem(storageKey);
  if (!saved) return normalizeState(structuredClone(defaultState));
  try {
    return normalizeState({ ...structuredClone(defaultState), ...JSON.parse(saved) });
  } catch {
    return normalizeState(structuredClone(defaultState));
  }
}

function normalizeState(next) {
  next.profile = { ...structuredClone(defaultState.profile), ...(next.profile || {}) };
  next.holdings = Array.isArray(next.holdings) ? next.holdings.map(normalizeHolding) : structuredClone(defaultState.holdings);
  next.monthlyCashflows = normalizeMonthlyCashflows(next.monthlyCashflows, next.profile);
  next.simulationYears = simulationYearOptions.includes(Number(next.simulationYears)) ? Number(next.simulationYears) : 10;
  next.anonymousId = String(next.anonymousId || crypto.randomUUID());
  next.consent = { ...structuredClone(defaultState.consent), ...(next.consent || {}) };
  next.inputCompletion = {
    profile: { ...(next.inputCompletion?.profile || {}) },
    stockAnswers: Array.isArray(next.inputCompletion?.stockAnswers) ? next.inputCompletion.stockAnswers : []
  };
  next.reportMeta = next.reportMeta || null;
  next.payment = { ...structuredClone(defaultState.payment), ...(next.payment || {}) };
  next.paidUnlocked = Array.isArray(next.reportMeta?.entitlements) && next.reportMeta.entitlements.includes("full_report");
  next.consultingUnlocked = Array.isArray(next.reportMeta?.entitlements) && next.reportMeta.entitlements.includes("consultation_deposit");
  next.leadProfile = { ...structuredClone(defaultState.leadProfile), ...(next.leadProfile || {}) };
  return next;
}

function normalizeHolding(holding) {
  const amount = Number(holding.amount || 0);
  const lots = Array.isArray(holding.lots) && holding.lots.length
    ? holding.lots.map((lot) => ({
      price: Number(lot.price || 0),
      amount: Number(lot.amount || 0)
    }))
    : [{ price: Number(holding.buyPrice || 0), amount }];
  return {
    ...holding,
    ticker: String(holding.ticker || "").trim(),
    amount,
    lots,
    dividendYield: Number(holding.dividendYield || 0)
  };
}

function normalizeMonthlyCashflows(saved, profile) {
  const rows = {};
  for (let month = 1; month <= 12; month++) {
    const source = saved?.[month] || saved?.[String(month)] || {};
    rows[month] = {};
    monthFields.forEach((field) => {
      rows[month][field] = source[field] === "" || source[field] === undefined || source[field] === null
        ? ""
        : Number(source[field]);
    });
  }
  const currentMonth = new Date().getMonth() + 1;
  if (!hasMonthlyInput(rows[currentMonth])) {
    monthFields.forEach((field) => {
      rows[currentMonth][field] = Number(profile[field] || 0);
    });
  }
  return rows;
}

function persist() {
  const safeState = structuredClone(state);
  safeState.consent.contactValue = "";
  if (safeState.reportMeta) safeState.reportMeta.accessCode = null;
  localStorage.setItem(storageKey, JSON.stringify(safeState));
}

function backendAvailable() {
  return Boolean(apiBase) || !location.hostname.endsWith("github.io");
}

function apiUrl(pathname) {
  return `${apiBase}${pathname}`;
}

async function apiRequest(pathname, options = {}) {
  const { headers = {}, ...rest } = options;
  const response = await fetch(apiUrl(pathname), {
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...headers },
    ...rest
  });
  const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function hasEntitlement(entitlement) {
  return Array.isArray(state.reportMeta?.entitlements) && state.reportMeta.entitlements.includes(entitlement);
}

function applyEntitlements(entitlements = []) {
  const unique = Array.from(new Set(entitlements.filter(Boolean)));
  if (!state.reportMeta) state.reportMeta = {};
  state.reportMeta.entitlements = unique;
  state.paidUnlocked = unique.includes("full_report");
  state.consultingUnlocked = unique.includes("consultation_deposit");
}

function submitCheckoutForm(checkout) {
  const form = document.createElement("form");
  form.method = checkout.method || "POST";
  form.action = checkout.action;
  form.hidden = true;
  Object.entries(checkout.fields || {}).forEach(([name, value]) => {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  });
  document.body.appendChild(form);
  form.submit();
}

async function startCheckout(productType) {
  if (!backendAvailable()) {
    showToast("付款需要後端服務，請使用正式網站或本地 server。");
    return;
  }
  if (!state.reportMeta?.reportId || !state.reportMeta?.accessCode) {
    showToast("請先產生或重新讀回報告，再進行付款。");
    goTo("freeReportView");
    return;
  }
  try {
    const result = await apiRequest("/api/payments/checkout", {
      method: "POST",
      body: JSON.stringify({
        reportId: state.reportMeta.reportId,
        accessCode: state.reportMeta.accessCode,
        productType
      })
    });
    state.payment = {
      lastOrderId: result.order.id,
      lastProductType: productType,
      lastStatus: result.order.status,
      statusToken: result.order.statusToken,
      message: "已建立付款訂單，正在前往綠界付款頁。"
    };
    persist();
    submitCheckoutForm(result.checkout);
  } catch (error) {
    state.payment = { ...state.payment, lastProductType: productType, lastStatus: "failed", message: error.message };
    refreshReports();
    showToast(error.message);
  }
}

async function checkPaymentStatus(orderId = state.payment?.lastOrderId) {
  if (!orderId || !state.reportMeta?.reportId) return null;
  const headers = {};
  if (state.reportMeta?.accessCode) headers["X-Report-Access-Code"] = state.reportMeta.accessCode;
  if (state.payment?.statusToken) headers["X-Payment-Status-Token"] = state.payment.statusToken;
  if (!headers["X-Report-Access-Code"] && !headers["X-Payment-Status-Token"]) return null;
  const result = await apiRequest(`/api/payments/${encodeURIComponent(orderId)}/status?reportId=${encodeURIComponent(state.reportMeta.reportId)}`, { headers });
  state.payment = {
    lastOrderId: result.order.id,
    lastProductType: result.order.productType,
    lastStatus: result.order.status,
    statusToken: state.payment?.statusToken || null,
    message: result.order.status === "paid" ? "付款成功，完整權限已更新。" : result.order.failureReason || "付款尚未完成。"
  };
  applyEntitlements(result.order.entitlements);
  persist();
  refreshReports();
  return result.order;
}

async function handlePaymentReturn() {
  const params = new URLSearchParams(location.search);
  const status = params.get("payment");
  const orderId = params.get("orderId");
  if (!status) return;
  state.payment = {
    lastOrderId: orderId || state.payment.lastOrderId,
    lastProductType: state.payment.lastProductType,
    lastStatus: status,
    statusToken: state.payment.statusToken,
    message: status === "success" ? "付款結果已返回，正在向後端確認入帳。" : "付款未完成或付款失敗。"
  };
  if (orderId) {
    try {
      const order = await checkPaymentStatus(orderId);
      if (order?.status === "paid" && order.productType === "full_report") goTo("paidReportView");
      if (order?.status === "paid" && order.productType === "consultation_deposit") goTo("upgradeView");
      showToast(order?.status === "paid" ? "付款成功，已更新權限。" : "尚未收到後端付款確認。");
    } catch (error) {
      showToast(`付款狀態確認失敗：${error.message}`);
    }
  } else {
    refreshReports();
  }
  params.delete("payment");
  params.delete("orderId");
  params.delete("reportId");
  const clean = `${location.pathname}${params.toString() ? `?${params.toString()}` : ""}${location.hash}`;
  history.replaceState(null, "", clean);
}

function trackEvent(eventType, metadata = {}) {
  if (!backendAvailable()) return;
  apiRequest("/api/events", {
    method: "POST",
    body: JSON.stringify({
      anonymousId: state.anonymousId,
      reportId: state.reportMeta?.reportId || null,
      eventType,
      metadata
    })
  }).catch(() => {});
}

async function loadEtfDatabase() {
  try {
    const source = backendAvailable() ? apiUrl("/api/market/database") : "./data/etf-database.json";
    let response = await fetch(source, { cache: "no-store" }).catch(() => null);
    if ((!response || !response.ok) && source !== "./data/etf-database.json") {
      response = await fetch("./data/etf-database.json", { cache: "no-store" });
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    etfDatabase = await response.json();
    etfDataQuality = validateEtfDatabase(etfDatabase);
    enrichHoldingsFromDatabase();
  } catch (error) {
    etfDatabase = null;
    etfDataQuality = {
      status: "failed",
      errors: [`ETF 資料庫載入失敗：${error.message}`],
      warnings: ["目前會退回本機範例資料，正式對外使用前必須修正。"],
      counts: { etfs: 0, distributions: 0, holdings: 0, stocks: 0, priceSeries: 0, navSeries: 0 }
    };
  }
}

async function refreshDatabaseFromServer(reason = "open") {
  if (!backendAvailable()) return false;
  try {
    const status = await fetch(apiUrl("/api/database-status"), { cache: "no-store" });
    if (!status.ok) return false;
    if (reason === "manual") showToast("正在更新官方資料庫");
    const response = await fetch(`${apiUrl("/api/market/refresh")}?reason=${encodeURIComponent(reason)}`, {
      method: "POST",
      cache: "no-store"
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || "更新失敗");
    await loadEtfDatabase();
    renderHoldings();
    refreshReports();
    showToast("官方資料庫已更新");
    return true;
  } catch (error) {
    if (reason === "manual") showToast(`更新失敗，沿用最後快照：${error.message}`);
    return false;
  }
}

function validateEtfDatabase(db) {
  const errors = [];
  const warnings = [];
  const now = new Date();
  const tickers = new Set();

  if (!Array.isArray(db?.etfs) || db.etfs.length === 0) {
    errors.push("ETF 主檔不可為空");
  }

  if (!db?.classificationRules) {
    warnings.push("ETF 顯示分類規則尚未載入");
  } else if (db.classificationRules.source !== "derived_from_official_twse_fields") {
    warnings.push("ETF 顯示分類規則來源需重新確認");
  }

  for (const etf of db?.etfs || []) {
    if (!etf.ticker) errors.push("ETF 缺 ticker");
    if (tickers.has(etf.ticker)) errors.push(`ETF ticker 重複：${etf.ticker}`);
    tickers.add(etf.ticker);
    if (!etf.shortName || !etf.fundName) errors.push(`${etf.ticker} 缺名稱`);
    if (!etf.issuer) errors.push(`${etf.ticker} 缺發行公司`);
    if (!etf.sourceUrl) errors.push(`${etf.ticker} 缺來源 URL`);
    if (!etf.displayClassification?.primary) warnings.push(`${etf.ticker} 缺顯示分類`);

    const date = new Date(`${etf.performance?.date || ""}T00:00:00+08:00`);
    if (Number.isNaN(date.getTime())) {
      if (etf.performance?.sourceDateStatus !== "official_endpoint_does_not_provide_date") {
        warnings.push(`${etf.ticker} 缺績效資料日期與來源日期狀態`);
      }
    } else {
      const ageDays = Math.round((now - date) / 86400000);
      if (ageDays > 3) warnings.push(`${etf.ticker} 績效資料日期 ${etf.performance.date} 距今 ${ageDays} 天，需確認是否最新`);
    }
    if (etf.qualityFlags?.includes("holdings_missing")) warnings.push(`${etf.ticker} 成分股權重尚未接上官方資料`);
    if (etf.qualityFlags?.includes("holdings_partial")) warnings.push(`${etf.ticker} 成分股權重只接上官方可見列，尚非完整成分股資料`);
    if (etf.qualityFlags?.includes("price_series_missing")) warnings.push(`${etf.ticker} 價格折線尚未接上官方資料`);
    if (etf.qualityFlags?.includes("nav_series_missing")) warnings.push(`${etf.ticker} NAV/折溢價尚未接上官方資料`);
  }

  for (const row of db?.distributions || []) {
    if (!tickers.has(row.ticker)) errors.push(`配息資料 ticker 不在主檔：${row.ticker}`);
    if (!row.payDate) errors.push(`${row.ticker} 配息資料缺發放日`);
    if (Number(row.amountPerUnit) < 0) errors.push(`${row.ticker} 配息金額不可小於 0`);
  }

  if (db?.stocks && !Array.isArray(db.stocks.items)) {
    errors.push("股票主檔必須是陣列");
  }
  for (const stock of db?.stocks?.items || []) {
    if (!stock.ticker) errors.push("股票主檔缺 ticker");
    if (!stock.name && !stock.shortName) warnings.push(`${stock.ticker} 缺股票名稱`);
    if (stock.qualityFlags?.includes("derived_from_etf_holdings")) warnings.push(`${stock.ticker} 股票主檔由 ETF 成分推導，尚未接上官方主檔`);
  }

  return {
    status: errors.length ? "failed" : warnings.length ? "passed_with_warnings" : "passed",
    errors,
    warnings,
    counts: {
      etfs: db?.etfs?.length || 0,
      distributions: db?.distributions?.length || 0,
      holdings: db?.holdings?.items?.length || 0,
      stocks: db?.stocks?.items?.length || 0,
      priceSeries: db?.priceSeries?.items?.length || 0,
      navSeries: db?.navSeries?.items?.length || 0
    }
  };
}

function findEtf(ticker) {
  return etfDatabase?.etfs?.find((item) => item.ticker === String(ticker || "").trim());
}

function findStock(ticker) {
  return etfDatabase?.stocks?.items?.find((item) => item.ticker === String(ticker || "").trim());
}

function enrichHoldingsFromDatabase() {
  state.holdings = state.holdings.map((holding) => {
    const etf = findEtf(holding.ticker);
    const stock = findStock(holding.ticker);
    if (!etf && !stock) return holding;
    if (stock && !etf) {
      return {
        ...holding,
        name: stock.shortName || stock.name,
        type: "個股",
        sector: industryDisplayName(stock.industry || holding.sector),
        dataSource: stock.source || "stock_master",
        dataDate: stock.latestPrice?.date || holding.dataDate
      };
    }
    return {
      ...holding,
      name: etf.shortName,
      type: etfDisplayType(etf, holding.type === "個股" ? "ETF" : holding.type),
      sector: etf.themes?.[0] || etf.displayClassification?.primary || etf.assetTypes?.[0] || holding.sector,
      dividendYield: estimatedDividendYield(etf.ticker, holding.dividendYield),
      yieldSource: "official_distributions",
      dataSource: "official_snapshot",
      dataDate: etf.performance?.date
    };
  });
}

function q(selector) {
  return document.querySelector(selector);
}

function showToast(message) {
  const old = q(".toast");
  if (old) old.remove();
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.append(toast);
  setTimeout(() => toast.remove(), 2600);
}

function formatMoney(value) {
  return money.format(Math.round(value || 0));
}

function pct(value, digits = 1) {
  return `${Number(value || 0).toFixed(digits)}%`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function monthlyTotalExpense(profile) {
  return Number(profile.fixedExpense) + Number(profile.insuranceExpense) + Number(profile.loanExpense);
}

function investableCashflow(profile) {
  return Number(profile.monthlyIncome) - monthlyTotalExpense(profile) - Number(profile.monthlyInvestment);
}

function holdingAmount(holding) {
  if (Array.isArray(holding.lots) && holding.lots.length) {
    return holding.lots.reduce((sum, lot) => sum + Number(lot.amount || 0), 0);
  }
  return Number(holding.amount || 0);
}

function totalInvested(holdings) {
  return holdings.reduce((sum, item) => sum + holdingAmount(item), 0);
}

function annualDividend(holdings) {
  return holdings.reduce((sum, item) => sum + holdingAmount(item) * Number(item.dividendYield || 0) / 100, 0);
}

function latestMarketPrice(ticker) {
  const key = String(ticker || "").trim();
  const navRows = (etfDatabase?.navSeries?.items || [])
    .filter((row) => row.ticker === key && Number(row.close || row.nav) > 0)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (navRows[0]) return Number(navRows[0].close || navRows[0].nav);

  const priceRows = (etfDatabase?.priceSeries?.items || [])
    .filter((row) => row.ticker === key && Number(row.close) > 0)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (priceRows[0]) return Number(priceRows[0].close);

  const stock = findStock(key);
  return Number(stock?.latestPrice?.close || 0);
}

function estimatedDividendYield(ticker, fallback = 0) {
  const key = String(ticker || "").trim();
  const distributions = (etfDatabase?.distributions || [])
    .filter((row) => row.ticker === key && Number(row.amountPerUnit) > 0)
    .sort((a, b) => String(b.payDate).localeCompare(String(a.payDate)))
    .slice(0, 4);
  const price = latestMarketPrice(key);
  if (!distributions.length || !price) return Number(fallback || 0);
  const annualCash = distributions.reduce((sum, row) => sum + Number(row.amountPerUnit || 0), 0);
  return Number((annualCash / price * 100).toFixed(2));
}

function etfDisplayType(etf, fallback = "ETF") {
  const display = etf?.displayClassification?.primary;
  if (display && display !== "ETF" && display !== "未分類") {
    return display === "股票型" ? "股票型ETF" : display;
  }
  const assetTypes = etf?.assetTypes || [];
  const rewardTypes = etf?.rewardTypes || [];
  const themes = etf?.themes || [];
  if (rewardTypes.includes("槓桿型")) return "槓桿型";
  if (rewardTypes.includes("反向型")) return "反向型";
  if (assetTypes.includes("債券型")) return "債券";
  if (assetTypes.includes("貨幣型")) return "貨幣";
  if (assetTypes.includes("REITs")) return "REITs";
  if (assetTypes.includes("期貨型原物料")) return "原物料";
  if (assetTypes.includes("多資產")) return "多資產";
  if (themes.includes("高股息")) return "高股息";
  if (themes.includes("大型權值") || themes.includes("全市場指數")) return "市值型";
  if (assetTypes.includes("股票型")) return "股票型ETF";
  return fallback || etf?.category || "ETF";
}

function classificationTags(etf) {
  const display = etf?.displayClassification;
  const tags = [];
  if (display?.primary && display.primary !== "ETF") tags.push(display.primary);
  if (display?.market && display.market !== "未分類") tags.push(display.market);
  if (display?.strategy && display.strategy !== "未分類") tags.push(display.strategy);
  return tags.length ? tags : ["未分類"];
}

function tagListHtml(tags) {
  const cleanTags = tags.filter(Boolean);
  const items = cleanTags.length ? cleanTags : ["未分類"];
  return `<div class="tag-list">${items.map((tag) => `<span class="mini-tag">${tag}</span>`).join("")}</div>`;
}

function industryDisplayName(value) {
  const key = String(value || "").trim();
  if (!key) return "未分類";
  return industryNames[key.padStart(2, "0")] || key;
}

function stockThemeGroup(value) {
  const name = industryDisplayName(value);
  if (["半導體業"].includes(name)) return "半導體業";
  if (["電子零組件業", "電腦及週邊設備業", "光電業", "通信網路業", "電子通路業", "資訊服務業", "其他電子業", "數位雲端"].includes(name)) return "電子科技業";
  if (["金融保險業"].includes(name)) return "金融股";
  if (["生技醫療業", "化學生技醫療"].includes(name)) return "醫療與生技";
  if (["鋼鐵工業", "塑膠工業", "化學工業", "航運業", "汽車工業", "橡膠工業", "玻璃陶瓷", "造紙工業"].includes(name)) return "景氣循環股";
  if (["建材營造業", "水泥工業", "電器電纜"].includes(name)) return "基礎建設與營建";
  if (["食品工業", "貿易百貨業", "觀光餐旅", "居家生活", "運動休閒"].includes(name)) return "民生消費";
  if (["油電燃氣業", "綠能環保"].includes(name)) return "能源與公用事業";
  if (name === "存託憑證") return "海外與存託憑證";
  return name === "未分類" ? "未分類" : name;
}

function mergeDuplicateHoldings() {
  const byTicker = new Map();
  const merged = [];
  let changed = false;
  state.holdings.forEach((holding) => {
    const ticker = String(holding.ticker || "").trim();
    if (!ticker) {
      merged.push(holding);
      return;
    }
    const key = ticker.toUpperCase();
    const amount = holdingAmount(holding);
    if (!byTicker.has(key)) {
      const normalized = { ...holding, ticker, amount };
      byTicker.set(key, normalized);
      merged.push(normalized);
      return;
    }
    changed = true;
    const current = byTicker.get(key);
    const currentAmount = holdingAmount(current);
    const total = currentAmount + amount;
    current.lots = [...(current.lots || []), ...(holding.lots || [])];
    current.amount = total;
    current.dividendYield = total
      ? Number(((Number(current.dividendYield || 0) * currentAmount + Number(holding.dividendYield || 0) * amount) / total).toFixed(2))
      : Number(current.dividendYield || holding.dividendYield || 0);
    current.name = current.name || holding.name;
    current.type = current.type || holding.type;
    current.sector = current.sector || holding.sector;
  });
  if (changed) state.holdings = merged;
  return changed;
}

function holdingUnits(holding) {
  const lots = Array.isArray(holding.lots) ? holding.lots : [];
  const lotUnits = lots.reduce((sum, lot) => {
    const price = Number(lot.price || 0);
    return price > 0 ? sum + Number(lot.amount || 0) / price : sum;
  }, 0);
  if (lotUnits > 0) return lotUnits;
  const price = latestMarketPrice(holding.ticker);
  return price > 0 ? holdingAmount(holding) / price : 0;
}

function calculateBreakdown(profile, holdings) {
  const expense = monthlyTotalExpense(profile);
  const income = Number(profile.monthlyIncome) || 1;
  const monthlySurplus = income - expense;
  const savingRate = monthlySurplus / income;
  const emergencyMonths = expense > 0 ? Number(profile.cashSavings) / expense : 0;
  const typeCount = new Set(holdings.map((item) => item.type).filter(Boolean)).size;
  const highDividendRatio = highDividendDependency(holdings);
  const investRate = Number(profile.monthlyInvestment) / income;
  const retirementYears = Math.max(1, 65 - Number(profile.age || 35));

  return {
    saving: clamp(savingRate * 220, 0, 100),
    emergency: clamp(emergencyMonths / 6 * 100, 0, 100),
    diversification: clamp(typeCount * 24 + (100 - highDividendRatio) * 0.35, 0, 100),
    stability: clamp(100 - Math.max(0, expense / income - 0.68) * 180, 0, 100),
    retirement: clamp(investRate * 260 + retirementYears * 1.1, 0, 100)
  };
}

function scoreFromBreakdown(breakdown) {
  return Math.round(
    breakdown.saving * 0.24 +
    breakdown.emergency * 0.22 +
    breakdown.diversification * 0.2 +
    breakdown.stability * 0.18 +
    breakdown.retirement * 0.16
  );
}

function highDividendDependency(holdings) {
  const total = totalInvested(holdings);
  if (!total) return 0;
  const highDividend = holdings
    .filter((item) => item.type === "高股息")
    .reduce((sum, item) => sum + holdingAmount(item), 0);
  return highDividend / total * 100;
}

function buildStockExposure(holdings) {
  const total = totalInvested(holdings);
  const rowsByTicker = new Map();
  const unresolved = [];
  let coveredAmount = 0;

  function addExposure(ticker, name, sector, amount, sourceTicker, sourceName) {
    if (!ticker || amount <= 0) return;
    const stock = findStock(ticker);
    const key = String(ticker).trim();
    const current = rowsByTicker.get(key) || {
      ticker: key,
      name: stock?.shortName || stock?.name || name || key,
      sector: stockThemeGroup(stock?.industry || sector),
      industry: industryDisplayName(stock?.industry || sector),
      amount: 0,
      share: 0,
      sources: []
    };
    current.amount += amount;
    current.sources.push({ ticker: sourceTicker, name: sourceName, amount });
    rowsByTicker.set(key, current);
  }

  holdings.forEach((holding) => {
    const amount = holdingAmount(holding);
    if (!amount) return;
    const ticker = String(holding.ticker || "").trim();
    const etf = findEtf(ticker);
    const stock = findStock(ticker);

    if (etf) {
      const constituents = (etfDatabase?.holdings?.items || []).filter((row) => row.ticker === ticker && Number(row.weight) > 0);
      const weightSum = constituents.reduce((sum, row) => sum + Number(row.weight || 0), 0);
      constituents.forEach((row) => {
        const exposureAmount = amount * Number(row.weight || 0) / 100;
        coveredAmount += exposureAmount;
        addExposure(row.holdingTicker, row.holdingName, row.sector, exposureAmount, ticker, etf.shortName);
      });
      if (weightSum < 99) {
        unresolved.push({
          ticker,
          name: etf.shortName,
          reason: constituents.length ? `ETF 成分股只覆蓋 ${pct(weightSum)}` : "ETF 成分股尚未接上官方資料",
          amount: amount * Math.max(0, 100 - weightSum) / 100
        });
      }
      return;
    }

    coveredAmount += amount;
    addExposure(ticker, stock?.shortName || stock?.name || holding.name, stock?.industry || holding.sector, amount, ticker, holding.name);
    if (!stock) {
      unresolved.push({
        ticker,
        name: holding.name || ticker,
        reason: "直接股票尚未對應官方股票主檔",
        amount
      });
    }
  });

  const rows = [...rowsByTicker.values()]
    .map((row) => ({ ...row, share: total ? row.amount / total * 100 : 0 }))
    .sort((a, b) => b.amount - a.amount);

  const bySector = rows.reduce((acc, row) => {
    acc[row.sector] = (acc[row.sector] || 0) + row.amount;
    return acc;
  }, {});

  return {
    rows,
    bySector,
    topStock: rows[0] || { ticker: "無", name: "無", sector: "無", amount: 0, share: 0, sources: [] },
    repeatedStocks: rows.filter((row) => new Set(row.sources.map((source) => source.ticker)).size > 1),
    unresolved,
    coverageRate: total ? clamp(coveredAmount / total * 100, 0, 100) : 0
  };
}

function overlapReport(holdings) {
  const total = totalInvested(holdings);
  const byType = groupAmount(holdings, "type");
  const stockExposure = buildStockExposure(holdings);
  const bySector = Object.keys(stockExposure.bySector).length ? stockExposure.bySector : groupAmount(holdings, "sector");
  const topType = topShare(byType, total);
  const topSector = topShare(bySector, total);
  const topStock = {
    name: stockExposure.topStock.name,
    ticker: stockExposure.topStock.ticker,
    amount: stockExposure.topStock.amount,
    share: stockExposure.topStock.share
  };
  const repeatedPenalty = Math.min(18, stockExposure.repeatedStocks.length * 4);
  const coveragePenalty = Math.max(0, 100 - stockExposure.coverageRate) * 0.18;
  const score = clamp(Math.max(topStock.share, topSector.share, topType.share) + repeatedPenalty + coveragePenalty, 0, 100);
  return {
    score,
    topType,
    topSector,
    topStock,
    stockExposure,
    message: score >= 70
      ? "底層股票或產業集中度偏高，可能同時透過 ETF 與直接股票買到相同曝險。"
      : "目前底層股票分散度尚可，但仍需補齊 ETF 成分股資料並定期檢查。"
  };
}

function groupAmount(items, key) {
  return items.reduce((acc, item) => {
    const name = item[key] || "未分類";
    acc[name] = (acc[name] || 0) + holdingAmount(item);
    return acc;
  }, {});
}

function topShare(grouped, total) {
  const [name = "無", amount = 0] = Object.entries(grouped).sort((a, b) => b[1] - a[1])[0] || [];
  return { name, amount, share: total ? amount / total * 100 : 0 };
}

function groupEntries(grouped, total) {
  return Object.entries(grouped)
    .map(([name, amount]) => ({ name, amount, share: total ? amount / total * 100 : 0 }))
    .sort((a, b) => b.amount - a.amount);
}

function groupExposureRows(rows, total) {
  const grouped = rows.reduce((acc, row) => {
    const name = row.sector || "未分類";
    if (!acc[name]) acc[name] = { name, amount: 0, share: 0, industries: new Set(), stocks: [] };
    acc[name].amount += row.amount;
    acc[name].industries.add(row.industry || industryDisplayName(row.sector));
    acc[name].stocks.push(row);
    return acc;
  }, {});
  return Object.values(grouped)
    .map((row) => ({
      ...row,
      share: total ? row.amount / total * 100 : 0,
      industries: [...row.industries].filter(Boolean).slice(0, 4).join("、"),
      examples: row.stocks
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 3)
        .map((stock) => `${stock.ticker} ${stock.name}`)
        .join("、")
    }))
    .sort((a, b) => b.amount - a.amount);
}

function dividendStress(profile, holdings) {
  const annual = annualDividend(holdings);
  const monthlyDividend = annual / 12;
  const baseSurplus = investableCashflow(profile) + monthlyDividend;
  const cut30 = baseSurplus - monthlyDividend * 0.3;
  const cut50 = baseSurplus - monthlyDividend * 0.5;
  return {
    monthlyDividend,
    baseSurplus,
    cut30,
    cut50,
    status: cut50 < 0 ? "壓力偏高" : cut30 < 0 ? "需要觀察" : "可承受"
  };
}

function retirementGap(profile, simulation) {
  const last = simulation[simulation.length - 1];
  const needed = Number(profile.retirementMonthlyNeed || 0) * 12 * 25;
  return {
    needed,
    projected: last.asset,
    gap: Math.max(0, needed - last.asset)
  };
}

function buildSimulation(profile, holdings) {
  const annualContribution = Number(profile.monthlyInvestment || 0) * 12;
  const total = totalInvested(holdings);
  const averageYield = total
    ? holdings.reduce((sum, item) => sum + holdingAmount(item) * Number(item.dividendYield || 0), 0) / total
    : 3;
  const growthRate = clamp(averageYield * 0.35 + 2.2, 2.5, 6.5) / 100;
  let asset = totalInvested(holdings) + Number(profile.cashSavings || 0) * 0.25;
  let contributed = totalInvested(holdings);
  return Array.from({ length: state.simulationYears }, (_, index) => {
    contributed += annualContribution;
    asset = asset * (1 + growthRate) + annualContribution;
    const yearlyDividend = asset * averageYield / 100;
    return {
      year: index + 1,
      asset,
      contributed,
      yearlyDividend,
      gapDirection: yearlyDividend / 12 >= Number(profile.retirementMonthlyNeed || 0) * 0.3 ? "接近" : "不足"
    };
  });
}

function hasMonthlyInput(row) {
  return monthFields.some((field) => row?.[field] !== "" && row?.[field] !== undefined && row?.[field] !== null);
}

function monthlyProfile(monthNumber) {
  const row = state.monthlyCashflows?.[monthNumber] || {};
  return {
    ...state.profile,
    monthlyIncome: row.monthlyIncome === "" ? 0 : Number(row.monthlyIncome || 0),
    fixedExpense: row.fixedExpense === "" ? 0 : Number(row.fixedExpense || 0),
    insuranceExpense: row.insuranceExpense === "" ? 0 : Number(row.insuranceExpense || 0),
    loanExpense: row.loanExpense === "" ? 0 : Number(row.loanExpense || 0),
    monthlyInvestment: row.monthlyInvestment === "" ? 0 : Number(row.monthlyInvestment || 0)
  };
}

function dividendEventsForMonth(holdings, year, monthNumber) {
  return (etfDatabase?.distributions || [])
    .filter((row) => {
      const date = new Date(`${row.payDate}T00:00:00+08:00`);
      return date.getFullYear() === year && date.getMonth() + 1 === monthNumber;
    })
    .map((row) => {
      const holding = holdings.find((item) => item.ticker === row.ticker);
      if (!holding) return null;
      const units = holdingUnits(holding);
      const amount = units * Number(row.amountPerUnit || 0);
      return {
        ticker: row.ticker,
        payDate: row.payDate,
        amountPerUnit: Number(row.amountPerUnit || 0),
        amount
      };
    })
    .filter(Boolean);
}

function buildCalendar(profile, holdings) {
  const year = new Date().getFullYear();
  return monthLabels.map((month, index) => {
    const monthNumber = index + 1;
    const hasInput = hasMonthlyInput(state.monthlyCashflows?.[monthNumber]);
    const monthly = monthlyProfile(monthNumber);
    const dividendEvents = dividendEventsForMonth(holdings, year, monthNumber);
    const dividend = dividendEvents.reduce((sum, row) => sum + row.amount, 0);
    if (!hasInput) {
      return {
        month,
        income: null,
        expenses: null,
        dividend,
        investable: null,
        status: "pending",
        dividendEvents,
        reminder: dividendEvents.length ? "本月有官方配息紀錄；收入支出尚未輸入。" : "本月尚未輸入現金流。"
      };
    }
    const expenses = monthlyTotalExpense(monthly);
    const investable = Number(monthly.monthlyIncome) - expenses - Number(monthly.monthlyInvestment) + dividend;
    const status = investable < 0 ? "stress" : investable < Number(monthly.monthlyIncome) * 0.08 ? "watch" : "safe";
    return {
      month,
      income: Number(monthly.monthlyIncome),
      expenses,
      dividend,
      investable,
      status,
      dividendEvents,
      reminder: status === "stress" ? "先補現金流缺口，再談加碼。" : status === "watch" ? "支出接近警戒線，保留現金。" : "現金流穩定，可檢查配置。"
    };
  });
}

function buildRisks(profile, holdings, breakdown) {
  const risks = [];
  const expense = monthlyTotalExpense(profile);
  const income = Number(profile.monthlyIncome) || 0;
  const emergencyMonths = expense ? Number(profile.cashSavings) / expense : 0;
  const highRatio = highDividendDependency(holdings);
  const overlap = overlapReport(holdings);
  const stress = dividendStress(profile, holdings);
  const total = totalInvested(holdings);
  const largestHolding = total
    ? holdings.map((item) => ({ ...item, share: holdingAmount(item) / total * 100 })).sort((a, b) => b.share - a.share)[0]
    : null;
  const expenseRatio = income ? expense / income * 100 : 0;
  const investmentRatio = income ? Number(profile.monthlyInvestment || 0) / income * 100 : 0;
  const loanRatio = income ? Number(profile.loanExpense || 0) / income * 100 : 0;
  const insuranceRatio = income ? Number(profile.insuranceExpense || 0) / income * 100 : 0;

  if (investableCashflow(profile) < 0) {
    risks.push({ level: "high", title: "每月現金流為負", body: "收入扣除固定支出、貸款、保險與投資後已低於 0。" });
  }
  if (expenseRatio > 70) {
    risks.push({ level: expenseRatio > 85 ? "high" : "medium", title: "固定支出壓力偏高", body: `固定支出、保險與貸款合計約占收入 ${pct(expenseRatio)}，可調整空間偏小。` });
  }
  if (emergencyMonths < 6) {
    risks.push({ level: emergencyMonths < 3 ? "high" : "medium", title: "緊急預備金不足", body: `目前約 ${emergencyMonths.toFixed(1)} 個月，低於 6 個月安全線。` });
  }
  if (loanRatio > 25) {
    risks.push({ level: loanRatio > 35 ? "high" : "medium", title: "貸款支出占比偏高", body: `貸款支出約占收入 ${pct(loanRatio)}，利率或收入變動時現金流較脆弱。` });
  }
  if (insuranceRatio > 15) {
    risks.push({ level: "medium", title: "保險支出占比偏高", body: `保險支出約占收入 ${pct(insuranceRatio)}，需確認保障內容是否與人生階段相符。` });
  }
  if (investmentRatio > 35 && emergencyMonths < 6) {
    risks.push({ level: "medium", title: "投資額壓縮安全墊", body: `每月投資約占收入 ${pct(investmentRatio)}，但預備金尚未達 6 個月。` });
  }
  if (highRatio > 55) {
    risks.push({ level: "medium", title: "高股息依賴偏高", body: `高股息 ETF 占比約 ${pct(highRatio)}，配息下修時現金流容易受影響。` });
  }
  if (largestHolding?.share > 40) {
    risks.push({ level: "medium", title: "單一標的集中度偏高", body: `${largestHolding.ticker || largestHolding.name} 約占投資部位 ${pct(largestHolding.share)}，單檔波動會直接影響整體資產。` });
  }
  if (holdings.filter((item) => holdingAmount(item) > 0).length < 3 && total > 0) {
    risks.push({ level: "medium", title: "持股分散度不足", body: "目前有效持股少於 3 檔，較容易受單一 ETF 或股票表現影響。" });
  }
  if (overlap.score > 65) {
    risks.push({ level: "medium", title: "底層股票曝險重疊", body: `${overlap.topStock.name} 或 ${overlap.topSector.name} 集中度偏高，可能同時來自 ETF 與直接股票。` });
  }
  if (overlap.stockExposure.coverageRate < 80 && total > 0) {
    risks.push({ level: "medium", title: "ETF 成分股資料缺口", body: `目前穿透覆蓋率約 ${pct(overlap.stockExposure.coverageRate)}，部分 ETF 尚無官方可解析成分股。` });
  }
  if (stress.cut50 < 0) {
    risks.push({ level: "medium", title: "配息下修壓力", body: "若配息下修 50%，含配息後的每月現金流可能轉為負數。" });
  }
  if (breakdown.retirement < 55) {
    risks.push({ level: "medium", title: "退休準備不足", body: "目前投入速度與退休月花費目標之間仍有落差。" });
  }
  if (emergencyMonths > 12 && investmentRatio < 10) {
    risks.push({ level: "low", title: "現金閒置偏高", body: "預備金已超過 12 個月，但每月投資占比偏低，可評估是否分批提高長期配置。" });
  }
  if (risks.length === 0) {
    risks.push({ level: "low", title: "主要風險暫時可控", body: "目前現金流與配置沒有明顯紅燈，仍建議每季重算一次。" });
  }
  const order = { high: 0, medium: 1, low: 2 };
  return risks.sort((a, b) => order[a.level] - order[b.level]).slice(0, 3);
}

function allocationRecommendations(report) {
  const total = Math.max(1, totalInvested(state.holdings));
  const emergencyReady = report.breakdown.emergency >= 80;
  const base = [
    {
      name: "保守",
      target: emergencyReady ? "現金 25% / 市值型 45% / 債券或貨幣 20% / 高股息 10%" : "先補預備金，再降低單一 ETF 依賴",
      note: "適合現金流剛穩定、希望降低波動的人。"
    },
    {
      name: "均衡",
      target: "市值型 55% / 高股息 25% / 現金 15% / 主題或海外 5%",
      note: "兼顧長期成長與配息現金流，避免只追高股息。"
    },
    {
      name: "積極",
      target: "市值型 65% / 海外或主題 15% / 高股息 15% / 現金 5%",
      note: "適合預備金充足、能承受波動且投資年限較長的人。"
    }
  ];
  if (report.highDividendRatio > 60) {
    base[1].note = `目前高股息部位約 ${pct(report.highDividendRatio)}，均衡方案應優先把新增資金導向市值型。`;
  }
  if (total < 100000) {
    base[0].target = "先建立 6 個月預備金，再用 1 到 2 檔核心 ETF 開始";
  }
  return base;
}

function personalizedActions(report) {
  const actions = [];
  if (report.breakdown.emergency < 80) actions.push("把第一優先放在補足 6 個月緊急預備金。");
  if (report.highDividendRatio > 55) actions.push("未來 3 個月新增資金先避開高股息 ETF，降低配息依賴。");
  if (report.overlap.score > 65) actions.push("檢查直接股票與 ETF 底層成分，優先處理重複買到的前幾大股票曝險。");
  if (report.stress.cut50 < 0) actions.push("用 50% 配息下修情境重排月支出，不要把配息視為固定薪水。");
  if (actions.length < 3) actions.push("每月固定重算一次現金流月曆，確認投資額沒有壓縮生活安全墊。");
  return actions.slice(0, 4);
}

function capacityAmount(capacity) {
  if (capacity === "under5000") return 4000;
  if (capacity === "over10000") return 12000;
  return 8000;
}

function capacityLabel(capacity) {
  if (capacity === "under5000") return "5,000 以下";
  if (capacity === "over10000") return "10,000 以上";
  return "5,000 到 10,000";
}

function concernLabel(concern) {
  return {
    saving: "存不到錢",
    investing: "不會投資",
    loss: "怕賠錢",
    family: "家用壓力"
  }[concern] || "存不到錢";
}

function monthlyPlanBudget(report) {
  const profile = report.profile;
  const freeCash = Math.max(0, Number(profile.monthlyIncome || 0) - monthlyTotalExpense(profile));
  const picked = Number(profile.monthlyInvestment || 0) || capacityAmount(state.leadProfile?.capacity);
  if (freeCash > 0) return Math.max(1000, Math.min(picked, freeCash));
  return Math.max(0, picked);
}

function beginnerPrescription(report) {
  const profile = report.profile;
  const expenses = monthlyTotalExpense(profile);
  const freeBeforeInvestment = Number(profile.monthlyIncome || 0) - expenses;
  const budget = monthlyPlanBudget(report);
  const reserveTarget = expenses * 6;
  const reserveGap = Math.max(0, reserveTarget - Number(profile.cashSavings || 0));
  const emergencyWeak = reserveGap > expenses;
  const invest = emergencyWeak ? Math.round(budget * 0.25 / 500) * 500 : Math.round(budget * 0.6 / 500) * 500;
  const safety = Math.max(0, budget - invest);
  const avoidBuffer = Math.max(0, budget - invest);
  const concern = concernLabel(state.leadProfile?.concern);
  const firstAction = emergencyWeak
    ? `先把安全水位補到 ${formatMoney(reserveTarget)}。你目前還差 ${formatMoney(reserveGap)}，本月先保留 ${formatMoney(safety)}，投資不要超過 ${formatMoney(invest)}。`
    : `安全水位已接近可用，先把每月 ${formatMoney(budget)} 拆成 ${formatMoney(safety)} 備用金與 ${formatMoney(invest)} 低波動投入。`;
  const allocation = budget > 0
    ? `以每月 ${formatMoney(budget)} 來看，建議 ${formatMoney(safety)} 放現金安全水位，${formatMoney(invest)} 做低波動 ETF 定期投入。`
    : `目前每月剩餘現金流約 ${formatMoney(freeBeforeInvestment)}，先不要新增投資金額，第一步是把支出壓到收入以下。`;
  const avoid = budget > 0
    ? `不適合把 ${formatMoney(budget)} 全部押在單一高股息 ETF，也不適合用生活費追求配息。至少保留 ${formatMoney(avoidBuffer)} 給現金與家用緩衝。`
    : `不適合在現金流為負時硬買 ETF。先把每月支出至少降 ${formatMoney(Math.abs(Math.min(0, freeBeforeInvestment)) + 1000)}，再談投資。`;
  return {
    budget,
    safety,
    invest,
    reserveTarget,
    reserveGap,
    concern,
    firstAction,
    allocation,
    avoid
  };
}

function stockBudgetTier(value) {
  const amount = Number(value || 0);
  if (amount < 3000) return "未滿 3,000 級";
  if (amount < 5000) return "3,000 級";
  if (amount < 10000) return "5,000 級";
  if (amount < 15000) return "10,000 級";
  if (amount < 20000) return "15,000 級";
  return "20,000 以上級";
}

function directStockHoldings() {
  return state.holdings.filter((item) => item.type === "個股" && holdingAmount(item) > 0);
}

function stockSafetyReport(report) {
  const profile = report.profile;
  const lead = state.leadProfile;
  const statedBudget = Math.max(0, Number(lead.stockMonthlyBudget || 0));
  const expenses = monthlyTotalExpense(profile);
  const hasCashflowData = Number(profile.monthlyIncome || 0) > 0 || expenses > 0;
  const available = hasCashflowData ? Math.max(0, investableCashflow(profile)) : statedBudget;
  const reserveMonths = expenses > 0 ? Number(profile.cashSavings || 0) / expenses : 0;
  const total = totalInvested(report.holdings);
  const stocks = directStockHoldings();
  const declaredStockCount = {
    "0": 0,
    "1to3": 2,
    "4to6": 5,
    "7plus": 7
  }[lead.stockCount] ?? stocks.length;
  const stockCount = stocks.length || declaredStockCount;
  const largestStock = stocks.length
    ? Math.max(...stocks.map((item) => holdingAmount(item)))
    : 0;
  const largestStockRatio = total > 0 ? largestStock / total * 100 : 0;
  const budgetBase = Math.min(statedBudget || available, available || statedBudget);
  const monthlyStockMax = Math.max(0, Math.floor((budgetBase * (reserveMonths < 3 ? 0.25 : reserveMonths < 6 ? 0.35 : 0.4)) / 500) * 500);
  const assetBase = Math.max(Number(profile.cashSavings || 0) + total, statedBudget * 6);
  const singleStockMax = Math.max(0, Math.floor((assetBase * 0.1) / 1000) * 1000);
  let level = "green";
  if (hasCashflowData && (available <= 0 || Number(profile.loanExpense || 0) > Number(profile.monthlyIncome || 0) * 0.35)) level = "black";
  else if (reserveMonths < 3 || lead.stockHorizon === "3months") level = "red";
  else if (
    reserveMonths < 6 ||
    lead.stockDrop === "sell" ||
    lead.stockDrop === "unsure" ||
    lead.stockReason === "friend" ||
    stockCount > 0 && stockCount <= 3 ||
    largestStockRatio > 20 ||
    statedBudget > available * 0.4
  ) level = "yellow";
  const copy = {
    green: { label: "綠燈", title: "可以開始，但先小額" },
    yellow: { label: "黃燈", title: "可以學，但不要買太多" },
    red: { label: "紅燈", title: "先不要買股票，先補現金流" },
    black: { label: "黑燈", title: "貸款或生活費壓力太高，不適合操作個股" }
  }[level];
  const avoid = level === "black" || level === "red"
    ? "目前不適合買個股、融資、借錢投資或用生活費進場。"
    : "目前不適合追高、融資、聽明牌或一次買滿。";
  return {
    level,
    ...copy,
    statedBudget,
    budgetTier: stockBudgetTier(statedBudget),
    available,
    reserveMonths,
    monthlyStockMax,
    singleStockMax,
    largestStockRatio,
    stockCount,
    avoid
  };
}

function buildReport() {
  const profile = state.profile;
  const holdings = state.holdings;
  const breakdown = calculateBreakdown(profile, holdings);
  const score = scoreFromBreakdown(breakdown);
  const simulation = buildSimulation(profile, holdings);
  const gap = retirementGap(profile, simulation);
  const overlap = overlapReport(holdings);
  const stress = dividendStress(profile, holdings);
  const highDividendRatio = highDividendDependency(holdings);
  const risks = buildRisks(profile, holdings, breakdown);
  const calendar = buildCalendar(profile, holdings);
  const report = {
    profile,
    holdings,
    breakdown,
    score,
    status: score >= 78 ? "穩健" : score >= 60 ? "可改善" : "需要整理",
    simulation,
    gap,
    overlap,
    stress,
    highDividendRatio,
    risks,
    calendar
  };
  report.allocations = allocationRecommendations(report);
  report.actions = personalizedActions(report);
  report.prescription = beginnerPrescription(report);
  report.stockSafety = stockSafetyReport(report);
  return report;
}

function syncInputs() {
  profileFields.forEach((field) => {
    q(`#${field}`).value = state.profile[field];
    q(`#${field}`).addEventListener("input", (event) => {
      state.profile[field] = Number(event.target.value || 0);
      state.inputCompletion.profile[field] = true;
      refreshReports();
    });
  });
  q("#simulationYears").value = state.simulationYears;
  syncQuizInputs();
  renderMonthlyCashflows();
  renderHoldings();
}

function renderMonthlyCashflows() {
  const root = q("#monthlyCashflowEditor");
  if (!root) return;
  root.innerHTML = monthLabels.map((label, index) => {
    const month = index + 1;
    const row = state.monthlyCashflows?.[month] || {};
    return `
      <div class="month-row" data-month="${month}">
        <strong>${label}</strong>
        <input data-month-field="monthlyIncome" type="number" min="0" step="1000" placeholder="收入" value="${escapeHtml(row.monthlyIncome)}" />
        <input data-month-field="fixedExpense" type="number" min="0" step="1000" placeholder="固定支出" value="${escapeHtml(row.fixedExpense)}" />
        <input data-month-field="insuranceExpense" type="number" min="0" step="500" placeholder="保險" value="${escapeHtml(row.insuranceExpense)}" />
        <input data-month-field="loanExpense" type="number" min="0" step="1000" placeholder="貸款" value="${escapeHtml(row.loanExpense)}" />
        <input data-month-field="monthlyInvestment" type="number" min="0" step="1000" placeholder="投資" value="${escapeHtml(row.monthlyInvestment)}" />
      </div>
    `;
  }).join("");

  root.querySelectorAll("[data-month-field]").forEach((input) => {
    input.addEventListener("input", (event) => {
      const month = Number(event.target.closest(".month-row").dataset.month);
      const field = event.target.dataset.monthField;
      state.monthlyCashflows[month][field] = event.target.value === "" ? "" : Number(event.target.value || 0);
      refreshReports();
    });
  });
}

function applyProfileToMonths() {
  for (let month = 1; month <= 12; month++) {
    state.monthlyCashflows[month] = {};
    monthFields.forEach((field) => {
      state.monthlyCashflows[month][field] = Number(state.profile[field] || 0);
    });
  }
  renderMonthlyCashflows();
  refreshReports();
  persist();
  showToast("已套用年度預設值到 12 個月");
}

function clearMonthlyCashflows() {
  for (let month = 1; month <= 12; month++) {
    state.monthlyCashflows[month] = {};
    monthFields.forEach((field) => {
      state.monthlyCashflows[month][field] = "";
    });
  }
  renderMonthlyCashflows();
  refreshReports();
  persist();
  showToast("已清空月份現金流");
}

function renderHoldings() {
  const root = q("#holdingEditor");
  root.innerHTML = "";
  state.holdings.forEach((holding, index) => {
    const officialEtf = findEtf(holding.ticker);
    const officialStock = findStock(holding.ticker);
    const amount = holdingAmount(holding);
    const yieldLabel = holding.yieldSource === "official_distributions" ? "官方配息估算" : "手動";
    const row = document.createElement("div");
    row.className = "holding-row";
    row.innerHTML = `
      <label>代號<input data-field="ticker" value="${escapeHtml(holding.ticker)}" inputmode="numeric" /></label>
      <label>名稱<input data-field="name" value="${escapeHtml(officialEtf?.shortName || officialStock?.shortName || holding.name)}" readonly /></label>
      <label>類型
        <select data-field="type">
          ${["ETF", "市值型", "股票型ETF", "高股息", "個股", "債券", "貨幣", "REITs", "原物料", "多資產", "槓桿型", "反向型", "海外", "主題"].map((type) => `<option ${holding.type === type ? "selected" : ""}>${type}</option>`).join("")}
        </select>
      </label>
      <label>總金額<input data-total-amount value="${formatMoney(amount)}" readonly /></label>
      <label>殖利率<input data-field="dividendYield" type="number" min="0" step="0.01" value="${holding.dividendYield}" ${officialEtf ? "readonly" : ""} /></label>
      <button class="icon-button" data-remove="${index}" type="button" title="刪除" aria-label="刪除">×</button>
      <div class="lot-editor">
        <div class="lot-title">
          <strong>分批買入</strong>
          <button class="secondary-button mini-button" data-add-lot="${index}" type="button">新增一筆</button>
        </div>
        ${(holding.lots || []).map((lot, lotIndex) => `
          <div class="lot-row" data-lot="${lotIndex}">
            <label>買入點位<input data-lot-field="price" type="number" min="0" step="0.01" value="${lot.price}" /></label>
            <label>投入金額<input data-lot-field="amount" type="number" min="0" step="1000" value="${lot.amount}" /></label>
            <button class="icon-button" data-remove-lot="${lotIndex}" type="button" title="刪除買入項目" aria-label="刪除買入項目">×</button>
          </div>
        `).join("")}
      </div>
      ${officialEtf
        ? `<small class="data-note">ETF：${officialEtf.issuer} · 資料日 ${officialEtf.performance.date} · 殖利率 ${yieldLabel} ${pct(holding.dividendYield, 2)}</small>`
        : officialStock
          ? `<small class="data-note">股票：${officialStock.market} · ${industryDisplayName(officialStock.industry)} · ${officialStock.latestPrice?.date || "官方端點未提供交易日"}</small>`
          : `<small class="data-note warning">尚未對應官方 ETF 或股票主檔</small>`}
    `;
    root.append(row);
  });

  root.querySelectorAll("input, select").forEach((input) => {
    input.addEventListener("input", (event) => {
      const row = event.target.closest(".holding-row");
      const index = [...root.children].indexOf(row);
      const field = event.target.dataset.field;
      if (!field) return;
      const numeric = ["amount", "dividendYield", "expenseRatio"].includes(field);
      state.holdings[index][field] = numeric ? Number(event.target.value || 0) : String(event.target.value).trim();
      if (field === "ticker" && String(event.target.value).trim().length >= 4) {
        state.holdings[index].ticker = String(event.target.value).trim();
        enrichHoldingsFromDatabase();
        if (mergeDuplicateHoldings()) showToast("已合併相同代號的持股");
        renderHoldings();
      }
      if (field === "type") state.holdings[index].sector = defaultSector(event.target.value);
      refreshReports();
    });
  });

  root.querySelectorAll("[data-lot-field]").forEach((input) => {
    input.addEventListener("input", (event) => {
      const row = event.target.closest(".holding-row");
      const index = [...root.children].indexOf(row);
      const lotIndex = Number(event.target.closest(".lot-row").dataset.lot);
      const field = event.target.dataset.lotField;
      state.holdings[index].lots[lotIndex][field] = Number(event.target.value || 0);
      state.holdings[index].amount = holdingAmount(state.holdings[index]);
      const totalInput = row.querySelector("[data-total-amount]");
      if (totalInput) totalInput.value = formatMoney(state.holdings[index].amount);
      refreshReports();
    });
  });

  root.querySelectorAll("[data-add-lot]").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.addLot);
      state.holdings[index].lots = [...(state.holdings[index].lots || []), { price: latestMarketPrice(state.holdings[index].ticker) || 0, amount: 0 }];
      renderHoldings();
      refreshReports();
    });
  });

  root.querySelectorAll("[data-remove-lot]").forEach((button) => {
    button.addEventListener("click", () => {
      const row = button.closest(".holding-row");
      const index = [...root.children].indexOf(row);
      state.holdings[index].lots.splice(Number(button.dataset.removeLot), 1);
      if (!state.holdings[index].lots.length) state.holdings[index].lots.push({ price: 0, amount: 0 });
      state.holdings[index].amount = holdingAmount(state.holdings[index]);
      renderHoldings();
      refreshReports();
    });
  });

  root.querySelectorAll("[data-remove]").forEach((button) => {
    button.addEventListener("click", () => {
      state.holdings.splice(Number(button.dataset.remove), 1);
      renderHoldings();
      refreshReports();
    });
  });
}

function defaultSector(type) {
  return {
    "市值型": "半導體",
    "ETF": "未分類ETF",
    "股票型ETF": "股票型",
    "高股息": "金融",
    "個股": "未分類",
    "債券": "固定收益",
    "貨幣": "貨幣市場",
    "REITs": "不動產",
    "原物料": "原物料",
    "多資產": "多資產",
    "槓桿型": "槓桿型",
    "反向型": "反向型",
    "海外": "全球",
    "主題": "科技"
  }[type] || "未分類";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function refreshReports() {
  latestReport = buildReport();
  renderHeader();
  renderQuickResult();
  renderDatabaseView();
  renderFreeReport();
  renderUpgrade();
  renderPaidReport();
  renderSimulation();
  renderCalendar();
}

function renderHeader() {
  q("#headerStatus").textContent = state.paidUnlocked ? "完整報告已解鎖" : "免費健檢";
  document.querySelectorAll(".paid-tab").forEach((tab) => tab.classList.toggle("is-locked", !state.paidUnlocked));
}

function updateProfileInputs() {
  profileFields.forEach((field) => {
    const input = q(`#${field}`);
    if (input) input.value = state.profile[field];
  });
}

function syncQuizInputs() {
  const income = q("#quizIncome");
  const expense = q("#quizExpense");
  const savings = q("#quizSavings");
  if (income) income.value = state.profile.monthlyIncome || "";
  if (expense) expense.value = monthlyTotalExpense(state.profile) || "";
  if (savings) savings.value = state.profile.cashSavings || "";
  const stockBudget = q("#stockMonthlyBudget");
  if (stockBudget) stockBudget.value = state.leadProfile.stockMonthlyBudget || "";
  q("#dataConsent").checked = state.consent.accepted;
  q("#contactChannel").value = state.consent.contactChannel;
  q("#contactValue").value = state.consent.contactValue;
  const stockMode = state.leadProfile.checkType === "stock";
  q("#cashflowQuiz").hidden = stockMode;
  q("#stockQuiz").hidden = !stockMode;
  q("#quickCheckTitle").textContent = stockMode ? "5 題股票安全健檢" : "5 題現金流健檢";
  q("#quickGenerateBtn").textContent = stockMode ? "產生股票安全報告" : "產生免費報告";
  document.querySelectorAll("[data-check-type]").forEach((button) => {
    button.classList.toggle("is-selected", button.dataset.checkType === state.leadProfile.checkType);
  });
  document.querySelectorAll("[data-capacity]").forEach((button) => {
    button.classList.toggle("is-selected", button.dataset.capacity === state.leadProfile.capacity);
  });
  document.querySelectorAll("[data-concern]").forEach((button) => {
    button.classList.toggle("is-selected", button.dataset.concern === state.leadProfile.concern);
  });
  ["reason", "drop", "count", "horizon"].forEach((field) => {
    document.querySelectorAll(`[data-stock-${field}]`).forEach((button) => {
      button.classList.toggle("is-selected", button.dataset[`stock${field[0].toUpperCase()}${field.slice(1)}`] === state.leadProfile[`stock${field[0].toUpperCase()}${field.slice(1)}`]);
    });
  });
}

function showValidationErrors(selector, errors) {
  const root = q(selector);
  if (!root) return;
  root.hidden = errors.length === 0;
  root.innerHTML = errors.length
    ? `<strong>請先完成以下資料</strong><ul>${errors.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : "";
}

function quickValidationErrors() {
  const errors = [];
  if (!state.consent.accepted) errors.push("勾選報告保存與資料使用同意");
  if (state.leadProfile.checkType === "cashflow") {
    if (q("#quizIncome").value === "" || Number(q("#quizIncome").value) <= 0) errors.push("填寫每月收入");
    if (q("#quizExpense").value === "" || Number(q("#quizExpense").value) < 0) errors.push("填寫每月固定支出");
    if (q("#quizSavings").value === "" || Number(q("#quizSavings").value) < 0) errors.push("填寫目前存款");
  } else {
    if (q("#stockMonthlyBudget").value === "" || Number(q("#stockMonthlyBudget").value) <= 0) errors.push("填寫每月股票投入金額");
    const answered = new Set(state.inputCompletion.stockAnswers);
    const labels = {
      stockReason: "選擇買股票的原因",
      stockDrop: "選擇股票跌 20% 時的做法",
      stockCount: "選擇目前個股檔數",
      stockHorizon: "選擇資金不能動用的期間"
    };
    Object.entries(labels).forEach(([key, label]) => {
      if (!answered.has(key)) errors.push(label);
    });
  }
  return errors;
}

function detailedValidationErrors() {
  const errors = [];
  const completed = state.inputCompletion.profile;
  if (!completed.monthlyIncome || Number(state.profile.monthlyIncome) <= 0) errors.push("填寫月收入");
  if (!completed.fixedExpense || Number(state.profile.fixedExpense) < 0) errors.push("填寫固定支出");
  if (!completed.cashSavings || Number(state.profile.cashSavings) < 0) errors.push("填寫現金存款");
  if (!state.consent.accepted) errors.push("回到首頁勾選報告保存與資料使用同意");
  return errors;
}

function reportSubmission() {
  return {
    anonymousId: state.anonymousId,
    checkType: state.leadProfile.checkType,
    consent: {
      accepted: state.consent.accepted,
      acceptedAt: state.consent.acceptedAt
    },
    contact: {
      channel: state.consent.contactChannel,
      value: state.consent.contactValue
    },
    input: {
      inputVersion,
      profile: structuredClone(state.profile),
      holdings: structuredClone(state.holdings),
      monthlyCashflows: structuredClone(state.monthlyCashflows),
      leadProfile: structuredClone(state.leadProfile)
    },
    report: {
      reportVersion,
      generatedAt: state.reportMeta.generatedAt,
      score: latestReport.score,
      status: latestReport.status,
      breakdown: latestReport.breakdown,
      prescription: latestReport.prescription,
      stockSafety: latestReport.stockSafety,
      risks: latestReport.risks,
      overlap: {
        score: latestReport.overlap.score,
        topStock: latestReport.overlap.topStock,
        topSector: latestReport.overlap.topSector,
        message: latestReport.overlap.message
      }
    }
  };
}

async function saveGeneratedReport() {
  state.reportMeta = {
    generatedAt: new Date().toISOString(),
    inputVersion,
    reportVersion,
    storageStatus: backendAvailable() ? "saving" : "local_only",
    reportId: null,
    accessCode: null,
    expiresAt: null,
    entitlements: []
  };
  applyEntitlements([]);
  refreshReports();
  if (!backendAvailable()) {
    persist();
    return;
  }
  try {
    const result = await apiRequest("/api/reports", {
      method: "POST",
      body: JSON.stringify(reportSubmission())
    });
    state.reportMeta = {
      ...state.reportMeta,
      storageStatus: "saved",
      reportId: result.report.id,
      accessCode: result.report.accessCode,
      expiresAt: result.report.expiresAt,
      entitlements: result.report.entitlements || []
    };
    applyEntitlements(result.report.entitlements || []);
    state.anonymousId = result.report.anonymousId;
    persist();
    refreshReports();
    showToast("報告已加密保存");
  } catch (error) {
    state.reportMeta.storageStatus = "save_failed";
    state.reportMeta.storageError = error.message;
    persist();
    refreshReports();
    showToast(`報告已產生，但後臺保存失敗：${error.message}`);
  }
}

function applyQuickCheck() {
  if (state.leadProfile.checkType === "stock") {
    state.leadProfile.stockMonthlyBudget = Number(q("#stockMonthlyBudget")?.value || 0);
    state.profile.monthlyInvestment = Math.min(state.leadProfile.stockMonthlyBudget, Math.max(0, investableCashflow(state.profile)));
    refreshReports();
    persist();
    return;
  }
  const income = Number(q("#quizIncome")?.value || 0);
  const expense = Number(q("#quizExpense")?.value || 0);
  const savings = Number(q("#quizSavings")?.value || 0);
  const capacity = state.leadProfile.capacity || "5000to10000";
  const monthlyInvestment = Math.min(capacityAmount(capacity), Math.max(0, income - expense));
  state.profile.monthlyIncome = income;
  state.profile.fixedExpense = expense;
  state.profile.insuranceExpense = 0;
  state.profile.loanExpense = 0;
  state.profile.cashSavings = savings;
  state.profile.monthlyInvestment = monthlyInvestment;
  state.profile.retirementMonthlyNeed = Math.max(30000, Math.round(expense / 1000) * 1000);
  const currentMonth = new Date().getMonth() + 1;
  state.monthlyCashflows[currentMonth] = {
    monthlyIncome: income,
    fixedExpense: expense,
    insuranceExpense: 0,
    loanExpense: 0,
    monthlyInvestment
  };
  updateProfileInputs();
  renderMonthlyCashflows();
  refreshReports();
  persist();
}

function renderQuickResult() {
  const root = q("#quickResult");
  if (!root || !latestReport?.prescription) return;
  if (state.leadProfile.checkType === "stock") {
    const stock = latestReport.stockSafety;
    root.innerHTML = `
      <div class="quick-result-card stock-${stock.level}">
        <span>${stock.label} · ${stock.budgetTier}</span>
        <strong>${stock.title}。每月個股建議先控制在 ${formatMoney(stock.monthlyStockMax)} 內。</strong>
      </div>
    `;
    return;
  }
  const item = latestReport.prescription;
  root.innerHTML = `
    <div class="quick-result-card">
      <span>目前試算</span>
      <strong>每月可規劃 ${formatMoney(item.budget)}，先放 ${formatMoney(item.safety)} 安全水位，${formatMoney(item.invest)} 再投入。</strong>
    </div>
  `;
}

function scoreHtml(report) {
  return `
    <section class="score-panel">
      <span class="badge">${report.status}</span>
      <div class="score-circle" style="--score:${report.score}">
        <strong>${report.score}</strong>
      </div>
      <div class="metrics">
        <div class="metric"><span>每月可用現金流</span><strong>${formatMoney(investableCashflow(report.profile))}</strong></div>
        <div class="metric"><span>投資年配息估算</span><strong>${formatMoney(annualDividend(report.holdings))}</strong></div>
        <div class="metric"><span>高股息依賴</span><strong>${pct(report.highDividendRatio)}</strong></div>
        <div class="metric"><span>退休缺口</span><strong>${formatMoney(report.gap.gap)}</strong></div>
      </div>
    </section>
  `;
}

function breakdownHtml(report) {
  const labels = {
    saving: "儲蓄率",
    emergency: "緊急預備金",
    diversification: "投資分散度",
    stability: "現金流穩定度",
    retirement: "退休準備度"
  };
  return `
    <section class="panel">
      <h3>分數拆解</h3>
      <div class="breakdown">
        ${Object.entries(report.breakdown).map(([key, value]) => `
          <div class="bar-row">
            <div class="bar-meta"><span>${labels[key]}</span><strong>${Math.round(value)}</strong></div>
            <div class="bar-track"><div class="bar-fill" style="--value:${value}%"></div></div>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function risksHtml(report, paid) {
  return `
    <section class="panel ${paid ? "" : "locked"}">
      <h3>3 大風險</h3>
      <div class="risk-list">
        ${report.risks.map((risk) => `
          <article class="risk-card ${risk.level === "high" ? "high" : risk.level === "low" ? "low" : ""}">
            <h4>${risk.title}</h4>
            <p>${paid ? risk.body : "已偵測到此風險，完整處理順序與調整方式在完整報告中解鎖。"}</p>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function dataSourceHtml() {
  const db = etfDatabase;
  const quality = etfDataQuality;
  const missing = quality.warnings.filter((item) => item.includes("尚未接上官方資料")).slice(0, 3);
  const etfScope = quality.counts.etfs >= 20 ? "全市場快照" : `${quality.counts.etfs || 0} 檔樣本`;
  return `
    <section class="panel">
      <h3>資料來源狀態</h3>
      <div class="metrics">
        <div class="metric"><span>ETF 主檔</span><strong>${etfScope}</strong></div>
        <div class="metric"><span>股票主檔</span><strong>${quality.counts.stocks ? `${quality.counts.stocks} 檔` : "未接"}</strong></div>
        <div class="metric"><span>配息</span><strong>${quality.counts.distributions ? "已接" : "未接"}</strong></div>
        <div class="metric"><span>資料日</span><strong>${db?.metadata?.officialPerformanceDate || "無"}</strong></div>
        <div class="metric"><span>狀態</span><strong>${quality.status === "failed" ? "錯誤" : quality.warnings.length ? "有警示" : "通過"}</strong></div>
      </div>
      <p class="panel-note">正式入庫只採官方或可追溯來源；缺少 00878 成分股權重或全市場 ETF 分類時，會保留缺資料狀態，不用第三方資料硬補。</p>
      ${missing.length ? `<ul class="feature-list">${missing.map((item) => `<li>${item}</li>`).join("")}</ul>` : `<p>目前 ETF 主檔與配息快照已可使用。</p>`}
    </section>
  `;
}

function stockExposureHtml(report) {
  const exposure = report.overlap.stockExposure;
  const total = totalInvested(report.holdings);
  const sectorRows = groupExposureRows(exposure.rows, total);
  return `
    <section class="panel">
      <h3>整體股票重疊度</h3>
      <div class="metrics">
        <div class="metric"><span>重疊風險</span><strong>${Math.round(report.overlap.score)}</strong></div>
        <div class="metric"><span>最大股票曝險</span><strong>${report.overlap.topStock.ticker}</strong></div>
        <div class="metric"><span>最大占比</span><strong>${pct(report.overlap.topStock.share)}</strong></div>
        <div class="metric"><span>穿透覆蓋率</span><strong>${pct(exposure.coverageRate)}</strong></div>
      </div>
      <p>${report.overlap.message}</p>
      <div class="inline-table">
        <div class="table-title">
          <h3>股票族群總佔比</h3>
          <span>依官方產業代碼歸納為 ${sectorRows.length} 類</span>
        </div>
        <p class="table-help">這裡不是股票代號清單，而是把 ETF 底層成分股與直接持股穿透後，依正式產業別整理成較容易理解的族群。</p>
        <table>
          <thead><tr><th>族群</th><th>主要官方產業</th><th>代表曝險</th><th>穿透金額</th><th>總佔比</th></tr></thead>
          <tbody>
            ${sectorRows.slice(0, 10).map((row) => `
              <tr>
                <td>${row.name}</td>
                <td>${row.industries || "未分類"}</td>
                <td>${row.examples || "-"}</td>
                <td>${formatMoney(row.amount)}</td>
                <td>${pct(row.share)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
      <div class="inline-table">
        <div class="table-title">
          <h3>前十大底層股票</h3>
          <span>${exposure.rows.length} 檔</span>
        </div>
        <table>
          <thead><tr><th>股票</th><th>名稱</th><th>族群</th><th>官方產業</th><th>金額</th><th>占比</th><th>來源數</th></tr></thead>
          <tbody>
            ${exposure.rows.slice(0, 10).map((row) => `
              <tr>
                <td>${row.ticker}</td>
                <td>${row.name}</td>
                <td>${row.sector}</td>
                <td>${row.industry || "未分類"}</td>
                <td>${formatMoney(row.amount)}</td>
                <td>${pct(row.share)}</td>
                <td>${new Set(row.sources.map((source) => source.ticker)).size}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
      ${exposure.unresolved.length ? `
        <div class="risk-list">
          ${exposure.unresolved.slice(0, 4).map((item) => `
            <article class="risk-card">
              <h4>${item.ticker} ${item.name}</h4>
              <p>${item.reason}，未穿透金額約 ${formatMoney(item.amount)}。</p>
            </article>
          `).join("")}
        </div>
      ` : ""}
    </section>
  `;
}

function beginnerPrescriptionHtml(report) {
  const item = report.prescription;
  return `
    <section class="panel prescription-panel">
      <span class="eyebrow">免費報告先給你方向</span>
      <h3>本月最該做的 3 件事</h3>
      <div class="prescription-grid">
        <article class="prescription-card">
          <span>先處理</span>
          <strong>${item.firstAction}</strong>
        </article>
        <article class="prescription-card">
          <span>月投入配置</span>
          <strong>${item.allocation}</strong>
        </article>
        <article class="prescription-card">
          <span>先不要做</span>
          <strong>${item.avoid}</strong>
        </article>
      </div>
      <p class="panel-note">你選的投入區間是 ${capacityLabel(state.leadProfile?.capacity)}，最擔心的是「${item.concern}」。完整報告會把 ETF 重疊、配息壓力與月份現金流一起排進去。</p>
    </section>
  `;
}

function stockSafetyHtml(report) {
  const item = report.stockSafety;
  return `
    <section class="panel stock-safety-panel stock-${item.level}">
      <div class="stock-light-head">
        <span class="stock-light" aria-hidden="true"></span>
        <div>
          <strong>股票能不能買 · ${item.label}</strong>
          <h3>${item.title}</h3>
        </div>
      </div>
      <p>你填寫的每月股票投入上限是 ${formatMoney(item.statedBudget)}，分級為 ${item.budgetTier}。依目前現金流與安全水位，個股部位建議先控制在每月 ${formatMoney(item.monthlyStockMax)} 內。</p>
      <div class="stock-answer-grid">
        <article><span>你現在每月最多只適合拿多少買股票</span><strong>${formatMoney(item.monthlyStockMax)}</strong></article>
        <article><span>單一個股最多不要超過多少</span><strong>${formatMoney(item.singleStockMax)}</strong></article>
        <article><span>你目前不適合做什麼操作</span><strong>${item.avoid}</strong></article>
      </div>
      <p class="panel-note">目前個股檔數判定為 ${item.stockCount} 檔，緊急預備金約 ${item.reserveMonths.toFixed(1)} 個月。單一個股原則上不超過可投資資產 10%，也不要用 3 個月內會用到的生活費買股票。資料庫只用來查核代號、產業與集中風險，不提供選股推薦。</p>
    </section>
  `;
}

function trustSourceHtml() {
  const quality = etfDataQuality;
  return `
    <section class="panel trust-panel">
      <span class="eyebrow">資料來源</span>
      <h3>本工具使用公開官方 ETF / 股票資料，不用網路謠言或手動亂填。</h3>
      <div class="metrics">
        <div class="metric"><span>ETF 主檔</span><strong>${quality.counts.etfs || 0} 檔</strong></div>
        <div class="metric"><span>股票主檔</span><strong>${quality.counts.stocks || 0} 檔</strong></div>
        <div class="metric"><span>配息資料</span><strong>${quality.counts.distributions || 0} 筆</strong></div>
        <div class="metric"><span>資料狀態</span><strong>${quality.status === "failed" ? "需檢查" : "可查核"}</strong></div>
      </div>
      <button class="secondary-button" data-goto="databaseView" type="button">查看資料後台</button>
    </section>
  `;
}

function leadCtaHtml() {
  return `
    <section class="panel lead-cta-panel">
      <span class="eyebrow">下一步</span>
      <h3>先確認這檔股票你能不能買，再決定投入多少</h3>
      <p>我不報明牌，但可以幫你檢查這筆錢是否能承受個股波動。</p>
      <div class="cta-grid">
        <a class="primary-button cta-link" href="#contactPanel">LINE 問我：這檔股票我能不能買？</a>
        <a class="secondary-button cta-link" href="#contactPanel">IG 看小資買股常見錯誤</a>
        <a class="secondary-button cta-link" href="#contactPanel">填表領「每月 5,000 股票配置表」</a>
        <a class="secondary-button cta-link" href="#contactPanel">領取「單一個股上限試算」</a>
      </div>
    </section>
  `;
}

function reportRecordHtml() {
  const meta = state.reportMeta;
  if (!meta) return "";
  const statusText = {
    saving: "正在加密保存",
    saved: "已加密保存",
    local_only: "目前只保存在這台裝置",
    save_failed: "後臺保存失敗"
  }[meta.storageStatus] || "尚未保存";
  return `
    <section class="panel report-record-panel">
      <h3>報告紀錄</h3>
      <div class="metrics">
        <div class="metric"><span>產生時間</span><strong>${new Date(meta.generatedAt).toLocaleString("zh-TW")}</strong></div>
        <div class="metric"><span>輸入版本</span><strong>${meta.inputVersion}</strong></div>
        <div class="metric"><span>報告版本</span><strong>${meta.reportVersion}</strong></div>
        <div class="metric"><span>保存狀態</span><strong>${statusText}</strong></div>
      </div>
      ${meta.reportId ? `
        <div class="access-code-box">
          <p>跨裝置重新開啟需要以下兩項資料。請自行保存，後臺不會顯示原始存取碼。</p>
          <code>報告編號：${meta.reportId}</code>
          <code>存取碼：${meta.accessCode}</code>
          <p class="panel-note">保存期限：${new Date(meta.expiresAt).toLocaleDateString("zh-TW")}</p>
        </div>
      ` : ""}
      ${meta.storageError ? `<p class="data-note warning">${escapeHtml(meta.storageError)}</p>` : ""}
      <div class="report-tools">
        <label>報告編號<input id="restoreReportId" type="text" /></label>
        <label>存取碼<input id="restoreAccessCode" type="password" /></label>
        <button class="secondary-button" id="restoreReportBtn" type="button">重新開啟報告</button>
        <button class="secondary-button" id="downloadReportBtn" type="button">下載報告 JSON</button>
        ${meta.reportId ? `<button class="secondary-button danger-button" id="deleteReportBtn" type="button">刪除後臺報告</button>` : ""}
      </div>
    </section>
  `;
}

function downloadCurrentReport() {
  if (!state.reportMeta) return;
  const blob = new Blob([JSON.stringify(reportSubmission(), null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `cashflow-report-${state.reportMeta.generatedAt.slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function restoreSavedReport() {
  const id = q("#restoreReportId")?.value.trim();
  const code = q("#restoreAccessCode")?.value.trim();
  if (!id || !code) return showToast("請輸入報告編號與存取碼");
  try {
    const result = await apiRequest(`/api/reports/${encodeURIComponent(id)}`, {
      headers: { "X-Report-Access-Code": code }
    });
    const payload = result.report.payload;
    state.profile = { ...state.profile, ...payload.input.profile };
    state.holdings = (payload.input.holdings || []).map(normalizeHolding);
    state.monthlyCashflows = normalizeMonthlyCashflows(payload.input.monthlyCashflows, state.profile);
    state.leadProfile = { ...state.leadProfile, ...payload.input.leadProfile };
    state.reportMeta = {
      generatedAt: result.report.createdAt,
      inputVersion: result.report.inputVersion,
      reportVersion: result.report.reportVersion,
      storageStatus: "saved",
      reportId: result.report.id,
      accessCode: code,
      expiresAt: result.report.expiresAt,
      entitlements: result.report.entitlements || []
    };
    applyEntitlements(result.report.entitlements || []);
    updateProfileInputs();
    syncQuizInputs();
    renderMonthlyCashflows();
    renderHoldings();
    refreshReports();
    persist();
    showToast("已重新開啟保存的報告");
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteSavedReport() {
  const meta = state.reportMeta;
  if (!meta?.reportId || !meta.accessCode) return;
  try {
    await apiRequest(`/api/reports/${encodeURIComponent(meta.reportId)}`, {
      method: "DELETE",
      headers: { "X-Report-Access-Code": meta.accessCode }
    });
    state.reportMeta = { ...meta, storageStatus: "deleted", reportId: null, accessCode: null };
    persist();
    refreshReports();
    showToast("後臺報告已刪除");
  } catch (error) {
    showToast(error.message);
  }
}

function renderFreeReport() {
  const report = latestReport;
  q("#freeReport").innerHTML = `
    ${scoreHtml(report)}
    <div class="stack">
      ${reportRecordHtml()}
      ${state.leadProfile.checkType === "stock" ? stockSafetyHtml(report) : ""}
      ${beginnerPrescriptionHtml(report)}
      ${breakdownHtml(report)}
      ${risksHtml(report, false)}
      ${trustSourceHtml()}
      <section class="panel">
        <h3>退休缺口方向</h3>
        <p>${state.simulationYears} 年後推估資產 ${formatMoney(report.gap.projected)}，距離目標仍差 ${formatMoney(report.gap.gap)}。</p>
      </section>
      <section class="panel locked">
        <h3>現金流預覽</h3>
        <p>目前每月可用現金流約 ${formatMoney(investableCashflow(report.profile))}。月份月曆與 ETF 配息壓力測試需升級後查看。</p>
      </section>
      ${leadCtaHtml()}
    </div>
  `;
  bindGotoButtons();
  q("#restoreReportBtn")?.addEventListener("click", restoreSavedReport);
  q("#downloadReportBtn")?.addEventListener("click", downloadCurrentReport);
  q("#deleteReportBtn")?.addEventListener("click", deleteSavedReport);
}

function renderUpgrade() {
  {
  const plans = [
    { name: "免費報告", price: "NT$0", action: "保留免費版", key: "free", features: ["財務體質分數", "現金流摘要", "3 個優先風險"] },
    { name: "完整報告", price: formatMoney(fullReportPriceTwd), action: state.paidUnlocked ? "已解鎖" : "前往付款", key: "paid", highlight: true, features: ["整體股票重疊度分析", "高股息依賴與壓力測試", "資產模擬與月份月曆", "PDF/列印匯出"] },
    { name: "一對一諮詢訂金", price: formatMoney(consultationDepositTwd), action: state.consultingUnlocked ? "已付款" : "支付訂金", key: "consulting", features: [`諮詢費 ${formatMoney(consultationFeeTwd)}`, "IG 或 LINE 預約", "人工檢視 ETF、股票與現金流"] }
  ];
  const paymentNotice = state.payment?.message ? `
    <section class="panel payment-status-panel">
      <span class="badge">${escapeHtml(state.payment.lastStatus || "payment")}</span>
      <p>${escapeHtml(state.payment.message)}</p>
      ${state.payment.lastOrderId ? `<button class="secondary-button" id="refreshPaymentStatusBtn" type="button">重新確認付款狀態</button>` : ""}
    </section>
  ` : "";
  const consultationLinks = `
    <section class="panel consultation-booking-panel">
      <span class="eyebrow">諮詢預約</span>
      <h3>訂金 ${formatMoney(consultationDepositTwd)}，諮詢費 ${formatMoney(consultationFeeTwd)}</h3>
      <p class="panel-note">完成訂金後，可用 IG 或 LINE 接續預約時間。LINE 連結正式提供後，會由 runtime 設定啟用。</p>
      <div class="cta-grid">
        <a class="primary-button cta-link" href="${escapeHtml(consultationIgUrl)}" target="_blank" rel="noopener noreferrer">IG 諮詢</a>
        ${consultationLineUrl
          ? `<a class="secondary-button cta-link" href="${escapeHtml(consultationLineUrl)}" target="_blank" rel="noopener noreferrer">LINE 諮詢</a>`
          : `<span class="secondary-button cta-link is-disabled" aria-disabled="true">LINE 尚未設定</span>`}
      </div>
    </section>
  `;
  q("#plans").innerHTML = paymentNotice + plans.map((plan) => `
    <article class="plan-card ${plan.highlight ? "highlight" : ""}">
      <h3>${plan.name}</h3>
      <div class="price">${plan.price}</div>
      <ul class="feature-list">${plan.features.map((item) => `<li>${item}</li>`).join("")}</ul>
      <button class="${plan.highlight ? "primary-button" : "secondary-button"}" data-plan="${plan.key}" type="button">${plan.action}</button>
    </article>
  `).join("") + consultationLinks;

  q("#plans").querySelectorAll("[data-plan]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (button.dataset.plan === "paid") {
        if (state.paidUnlocked) return goTo("paidReportView");
        await startCheckout("full_report");
      }
      if (button.dataset.plan === "consulting") {
        if (state.consultingUnlocked) return showToast("諮詢訂金已付款，可用下方 IG 或 LINE 預約。");
        await startCheckout("consultation_deposit");
      }
      persist();
      refreshReports();
    });
  });
  q("#refreshPaymentStatusBtn")?.addEventListener("click", () => {
    checkPaymentStatus().catch((error) => showToast(error.message));
  });
  }
}

function renderDatabaseView() {
  const db = etfDatabase;
  const quality = etfDataQuality;
  const summary = q("#databaseSummary");
  if (!summary) return;

  summary.textContent = db
    ? `快照日期 ${db.metadata.snapshotDate}，官方績效資料日 ${db.metadata.officialPerformanceDate}`
    : "ETF 官方資料庫尚未載入";

  const statusText = {
    passed: "通過",
    passed_with_warnings: "有警示",
    failed: "失敗",
    loading: "載入中"
  }[quality.status] || quality.status;
  const classifiedCount = db?.etfs?.filter((etf) => etf.displayClassification?.confidence === "rule_based").length || 0;
  const officialAssetTypesCount = db?.etfs?.filter((etf) => etf.assetTypes?.length).length || 0;
  const freshnessSources = Object.entries(db?.metadata?.sourceFreshness?.sources || {});

  q("#dataQuality").innerHTML = `
    <section class="score-panel">
      <span class="badge">${statusText}</span>
      <div class="metrics">
        <div class="metric"><span>ETF 主檔</span><strong>${quality.counts.etfs}</strong></div>
        <div class="metric"><span>顯示分類</span><strong>${classifiedCount}</strong><small>規則透明標記</small></div>
        <div class="metric"><span>官方 assetType</span><strong>${officialAssetTypesCount}</strong><small>TWSE 端點目前 403</small></div>
        <div class="metric"><span>股票主檔</span><strong>${quality.counts.stocks}</strong></div>
        <div class="metric"><span>配息資料</span><strong>${quality.counts.distributions}</strong></div>
        <div class="metric"><span>成分股</span><strong>${quality.counts.holdings}</strong></div>
        <div class="metric"><span>NAV/價格</span><strong>${quality.counts.navSeries + quality.counts.priceSeries}</strong></div>
      </div>
    </section>
    <section class="panel">
      <h3>官方來源真正資料日期</h3>
      <p class="panel-note">更新執行時間與官方資料日期分開記錄。官方端點沒有日期時會明確標示，不使用今天日期代替。</p>
      <div class="source-freshness-list">
        ${freshnessSources.map(([name, source]) => `
          <article>
            <strong>${name}</strong>
            <span>${source.sourceDataDate || "官方端點未提供日期"}</span>
            <span class="badge">${source.status}</span>
            <small>${source.evidence}</small>
          </article>
        `).join("")}
      </div>
    </section>
    <section class="panel">
      <h3>ETF 分類規則</h3>
      <p class="panel-note">全市場主檔來自 TWSE e添富官方端點；顯示分類只使用官方欄位、官方篩選器標籤與透明關鍵字規則，不覆蓋官方 assetType。</p>
      <div class="classification-strip">
        ${Object.entries((db?.etfs || []).reduce((acc, etf) => {
          const key = etf.displayClassification?.primary || "未分類";
          acc[key] = (acc[key] || 0) + 1;
          return acc;
        }, {})).sort((a, b) => b[1] - a[1]).map(([name, count]) => `
          <span><strong>${name}</strong>${count}</span>
        `).join("")}
      </div>
    </section>
    <section class="panel">
      <h3>資料檢查</h3>
      <div class="risk-list">
        ${quality.errors.map((item) => `<article class="risk-card high"><h4>錯誤</h4><p>${item}</p></article>`).join("")}
        ${quality.warnings.slice(0, 8).map((item) => `<article class="risk-card"><h4>警示</h4><p>${item}</p></article>`).join("")}
        ${!quality.errors.length && !quality.warnings.length ? `<article class="risk-card low"><h4>通過</h4><p>資料庫欄位與日期檢查通過。</p></article>` : ""}
      </div>
    </section>
  `;

  q("#etfDatabaseTable").innerHTML = db ? `
    <div class="table-title">
      <h3>ETF 主檔</h3>
      <span>${db.etfs.length} 檔</span>
    </div>
    <table>
      <thead><tr><th>代號</th><th>名稱</th><th>顯示分類</th><th>官方標籤</th><th>發行公司</th><th>追蹤指數</th><th>資產規模</th><th>資料日</th><th>來源</th></tr></thead>
      <tbody>
        ${db.etfs.map((etf) => `
          <tr>
            <td>${etf.ticker}</td>
            <td>${etf.shortName}</td>
            <td>${tagListHtml(classificationTags(etf))}</td>
            <td>${tagListHtml([...(etf.assetTypes || []), ...(etf.rewardTypes || []), ...(etf.themes || [])].slice(0, 4))}</td>
            <td>${etf.issuer}</td>
            <td>${etf.indexName}</td>
            <td>${number.format(etf.aumBillionTwd)} 億</td>
            <td>${etf.performance.date}</td>
            <td><a href="${etf.sourceUrl}" target="_blank" rel="noreferrer">TWSE</a></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  ` : `<p>ETF 資料庫尚未載入。</p>`;

  q("#databaseSectorTable").innerHTML = databaseSectorHtml(db);

  q("#priceSeriesTable").innerHTML = db?.priceSeries?.items?.length ? `
    <div class="table-title">
      <h3>官方價格明細</h3>
      <span>${db.priceSeries.items.length} 筆</span>
    </div>
    <table>
      <thead><tr><th>日期</th><th>代號</th><th>開盤</th><th>最高</th><th>最低</th><th>收盤</th><th>成交股數</th></tr></thead>
      <tbody>
        ${db.priceSeries.items.slice(-18).map((row) => `
          <tr>
            <td>${row.date}</td>
            <td>${row.ticker}</td>
            <td>${row.open}</td>
            <td>${row.high}</td>
            <td>${row.low}</td>
            <td>${row.close}</td>
            <td>${number.format(row.tradeVolume || 0)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  ` : `<section class="panel"><p>尚未載入官方價格折線。</p></section>`;

  q("#holdingsTable").innerHTML = db?.holdings?.items?.length ? `
    <div class="table-title">
      <h3>官方成分股</h3>
      <span>${db.holdings.items.length} 筆</span>
    </div>
    <table>
      <thead><tr><th>資料日</th><th>ETF</th><th>成分股</th><th>名稱</th><th>權重</th><th>股數</th><th>來源</th></tr></thead>
      <tbody>
        ${db.holdings.items.slice(0, 80).map((row) => `
          <tr>
            <td>${row.asOfDate || "未揭露"}</td>
            <td>${row.ticker}</td>
            <td>${row.holdingTicker}</td>
            <td>${row.holdingName}</td>
            <td>${pct(row.weight)}</td>
            <td>${row.shares === null ? "-" : number.format(row.shares || 0)}</td>
            <td><a href="${row.sourceUrl}" target="_blank" rel="noreferrer">官方</a></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  ` : `<section class="panel"><p>尚未載入官方成分股權重。</p></section>`;

  q("#navSeriesTable").innerHTML = db?.navSeries?.items?.length ? `
    <div class="table-title">
      <h3>NAV/折溢價</h3>
      <span>${db.navSeries.items.length} 筆</span>
    </div>
    <table>
      <thead><tr><th>日期</th><th>ETF</th><th>收盤價</th><th>NAV</th><th>折溢價</th><th>來源</th></tr></thead>
      <tbody>
        ${db.navSeries.items.map((row) => `
          <tr>
            <td>${row.date}</td>
            <td>${row.ticker}</td>
            <td>${row.close === null ? "-" : row.close}</td>
            <td>${row.nav}</td>
            <td>${row.premiumDiscountPercent === null ? "-" : pct(row.premiumDiscountPercent, 2)}</td>
            <td><a href="${row.sourceUrl}" target="_blank" rel="noreferrer">官方</a></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  ` : `<section class="panel"><p>尚未載入官方 NAV/折溢價。</p></section>`;

  requestAnimationFrame(drawOfficialPriceChart);
}

function databaseSectorHtml(db) {
  const rows = db?.holdings?.items || [];
  if (!rows.length) return `<section class="panel"><p>尚未載入官方成分股族群摘要。</p></section>`;
  const byTicker = db.etfs.map((etf) => {
    const items = rows.filter((row) => row.ticker === etf.ticker);
    const bySector = items.reduce((acc, row) => {
      const stock = findStock(row.holdingTicker);
      const sector = stockThemeGroup(stock?.industry || row.sector);
      acc[sector] = (acc[sector] || 0) + Number(row.weight || 0);
      return acc;
    }, {});
    return {
      ticker: etf.ticker,
      name: etf.shortName,
      sectors: groupEntries(bySector, 100).slice(0, 5),
      coverage: items.reduce((sum, row) => sum + Number(row.weight || 0), 0)
    };
  });
  return `
    <div class="table-title">
      <h3>官方成分股族群摘要</h3>
      <span>依 ETF 權重加總</span>
    </div>
    <table>
      <thead><tr><th>ETF</th><th>名稱</th><th>穿透覆蓋</th><th>主要族群</th></tr></thead>
      <tbody>
        ${byTicker.map((row) => `
          <tr>
            <td>${row.ticker}</td>
            <td>${row.name}</td>
            <td>${pct(row.coverage)}</td>
            <td>${row.sectors.length ? row.sectors.map((sector) => `${sector.name} ${pct(sector.amount)}`).join(" / ") : "尚未接上官方成分股"}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function drawOfficialPriceChart() {
  const canvas = q("#officialPriceChart");
  const rows = etfDatabase?.priceSeries?.items || [];
  if (!canvas || !rows.length) return;

  const containerWidth = canvas.parentElement.clientWidth - 36;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(320, containerWidth) * dpr;
  canvas.height = 240 * dpr;
  canvas.style.width = `${Math.max(320, containerWidth)}px`;
  canvas.style.height = "240px";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const width = canvas.width / dpr;
  const height = canvas.height / dpr;
  const pad = 34;
  const byTicker = rows.reduce((acc, row) => {
    if (!acc[row.ticker]) acc[row.ticker] = [];
    acc[row.ticker].push(row);
    return acc;
  }, {});
  const normalized = Object.fromEntries(Object.entries(byTicker).map(([ticker, tickerRows]) => {
    const sorted = [...tickerRows].sort((a, b) => a.date.localeCompare(b.date));
    const base = Number(sorted[0]?.close || 0) || 1;
    return [ticker, sorted.map((row) => ({ ...row, normalizedClose: Number(row.close || 0) / base * 100 }))];
  }));
  const allValues = Object.values(normalized).flat().map((row) => row.normalizedClose).filter((value) => Number.isFinite(value));
  const min = Math.floor(Math.min(...allValues) - 1);
  const max = Math.ceil(Math.max(...allValues) + 1);
  const span = Math.max(1, max - min);
  const colors = ["#0f766e", "#b45309", "#1d4ed8", "#7c3aed"];

  renderPriceChartSummary(normalized);

  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = "#d9e2df";
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const y = pad + i * ((height - pad * 2) / 3);
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(width - pad, y);
    ctx.stroke();
  }

  Object.entries(normalized).forEach(([ticker, sorted], index) => {
    ctx.strokeStyle = colors[index % colors.length];
    ctx.fillStyle = colors[index % colors.length];
    ctx.lineWidth = 3;
    ctx.beginPath();
    sorted.forEach((row, pointIndex) => {
      const x = pad + pointIndex * ((width - pad * 2) / Math.max(1, sorted.length - 1));
      const y = height - pad - ((row.normalizedClose - min) / span) * (height - pad * 2);
      if (pointIndex === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.font = "12px Microsoft JhengHei, sans-serif";
    ctx.fillText(ticker, pad + index * 62, 18);
  });

  ctx.fillStyle = "#65736f";
  ctx.font = "12px Microsoft JhengHei, sans-serif";
  ctx.fillText(`${max}`, width - pad - 34, 18);
  ctx.fillText(`${min}`, width - pad - 34, height - 10);
  ctx.fillText("相對價格", pad, height - 10);
}

function renderPriceChartSummary(normalized) {
  const root = q("#priceChartSummary");
  if (!root) return;
  const navByTicker = new Map((etfDatabase?.navSeries?.items || []).map((row) => [row.ticker, row]));
  root.innerHTML = Object.entries(normalized).map(([ticker, rows]) => {
    const first = rows[0];
    const last = rows[rows.length - 1];
    const change = first ? last.normalizedClose - first.normalizedClose : 0;
    const nav = navByTicker.get(ticker);
    return `
      <div class="metric">
        <span>${ticker} ${last?.date || ""}</span>
        <strong>${last?.close ?? "-"}</strong>
        <small>${change >= 0 ? "+" : ""}${change.toFixed(2)}% · NAV ${nav?.nav ?? "-"} · 折溢價 ${nav?.premiumDiscountPercent === null || nav?.premiumDiscountPercent === undefined ? "-" : pct(nav.premiumDiscountPercent, 2)}</small>
      </div>
    `;
  }).join("");
}

function renderPaidReport() {
  const report = latestReport;
  if (!state.paidUnlocked) {
    q("#paidReport").innerHTML = `
      <section class="panel">
        <h3>完整報告尚未解鎖</h3>
        <p>請先完成完整報告付款。付款成功後，系統會向後端確認入帳，再開啟完整報告。</p>
        ${state.payment?.message ? `<p class="panel-note">${escapeHtml(state.payment.message)}</p>` : ""}
        <button class="primary-button" data-goto="upgradeView" type="button">前往付款</button>
      </section>
    `;
    bindGotoButtons();
    return;
  }
  q("#paidReport").innerHTML = `
    ${scoreHtml(report)}
    <div class="stack">
      ${breakdownHtml(report)}
      ${risksHtml(report, true)}
      ${dataSourceHtml()}
      ${stockExposureHtml(report)}
      <section class="panel">
        <h3>配息壓力測試</h3>
        <div class="metrics">
          <div class="metric"><span>月配息估算</span><strong>${formatMoney(report.stress.monthlyDividend)}</strong></div>
          <div class="metric"><span>下修 30%</span><strong>${formatMoney(report.stress.cut30)}</strong></div>
          <div class="metric"><span>下修 50%</span><strong>${formatMoney(report.stress.cut50)}</strong></div>
          <div class="metric"><span>狀態</span><strong>${report.stress.status}</strong></div>
        </div>
      </section>
      <section class="panel">
        <h3>配置建議</h3>
        <div class="risk-list">
          ${report.allocations.map((item) => `
            <article class="risk-card low">
              <h4>${item.name}</h4>
              <p>${item.target}</p>
              <p>${item.note}</p>
            </article>
          `).join("")}
        </div>
      </section>
      <section class="panel">
        <h3>個人化調整建議</h3>
        <ul class="feature-list">${report.actions.map((item) => `<li>${item}</li>`).join("")}</ul>
      </section>
      <section class="panel">
        <h3>一對一諮詢</h3>
        <p>${state.consultingUnlocked ? "已登記一對一健檢方案，可接續安排人工檢視流程。" : "需要人工檢視 ETF、保險與貸款配置時，可升級到 NT$2,980 健檢方案。"}</p>
        <button class="secondary-button" data-goto="upgradeView" type="button">查看諮詢方案</button>
      </section>
    </div>
  `;
  bindGotoButtons();
}

function renderSimulation() {
  drawSimulationChart(latestReport.simulation);
  q("#simulationTable").innerHTML = `
    <div class="table-title">
      <h3>${state.simulationYears} 年資產模擬</h3>
      <span>可切換 10 / 15 / 20 / 25 / 30 年</span>
    </div>
    <table>
      <thead><tr><th>年度</th><th>資產</th><th>累積投入</th><th>年配息</th><th>退休缺口方向</th></tr></thead>
      <tbody>
        ${latestReport.simulation.map((row) => `
          <tr>
            <td>第 ${row.year} 年</td>
            <td>${formatMoney(row.asset)}</td>
            <td>${formatMoney(row.contributed)}</td>
            <td>${formatMoney(row.yearlyDividend)}</td>
            <td>${row.gapDirection}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function drawSimulationChart(rows) {
  const canvas = q("#simulationChart");
  const containerWidth = canvas.parentElement.clientWidth - 36;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(320, containerWidth) * dpr;
  canvas.height = 280 * dpr;
  canvas.style.width = `${Math.max(320, containerWidth)}px`;
  canvas.style.height = "280px";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const width = canvas.width / dpr;
  const height = canvas.height / dpr;
  ctx.clearRect(0, 0, width, height);
  const pad = 38;
  const max = Math.max(...rows.map((row) => row.asset));
  const min = Math.min(...rows.map((row) => row.asset));
  const span = Math.max(1, max - min);

  ctx.strokeStyle = "#d9e2df";
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const y = pad + i * ((height - pad * 2) / 3);
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(width - pad, y);
    ctx.stroke();
  }

  ctx.strokeStyle = "#0f766e";
  ctx.lineWidth = 3;
  ctx.beginPath();
  rows.forEach((row, index) => {
    const x = pad + index * ((width - pad * 2) / (rows.length - 1));
    const y = height - pad - ((row.asset - min) / span) * (height - pad * 2);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.fillStyle = "#0f766e";
  rows.forEach((row, index) => {
    const x = pad + index * ((width - pad * 2) / (rows.length - 1));
    const y = height - pad - ((row.asset - min) / span) * (height - pad * 2);
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.fillStyle = "#65736f";
  ctx.font = "12px Microsoft JhengHei, sans-serif";
  ctx.fillText(formatMoney(max), pad, 18);
  ctx.fillText("第 1 年", pad, height - 8);
  ctx.fillText(`第 ${rows.length} 年`, width - pad - 54, height - 8);
}

function renderCalendar() {
  q("#cashflowCalendar").innerHTML = latestReport.calendar.map((month) => `
    <article class="calendar-card ${month.status}">
      <div class="panel-head">
        <h3>${month.month}</h3>
        <span class="badge">${month.status === "pending" ? "待輸入" : month.status === "safe" ? "安全" : month.status === "watch" ? "普通" : "壓力"}</span>
      </div>
      <div>
        <div class="kv"><span>收入</span><strong>${month.income === null ? "未輸入" : formatMoney(month.income)}</strong></div>
        <div class="kv"><span>支出</span><strong>${month.expenses === null ? "未輸入" : formatMoney(month.expenses)}</strong></div>
        <div class="kv"><span>ETF 配息</span><strong>${formatMoney(month.dividend)}</strong></div>
        <div class="kv"><span>可投資金額</span><strong>${month.investable === null ? "未計算" : formatMoney(month.investable)}</strong></div>
      </div>
      ${month.dividendEvents.length ? `<ul class="mini-list">${month.dividendEvents.map((item) => `<li>${item.ticker} ${item.payDate} 每單位 ${item.amountPerUnit}</li>`).join("")}</ul>` : ""}
      <p>${month.reminder}</p>
    </article>
  `).join("");
}

async function loadAdminDashboard() {
  const key = q("#adminApiKey").value;
  const status = q("#adminStatus");
  status.textContent = "正在載入客戶資料";
  try {
    const headers = { Authorization: `Bearer ${key}` };
    const [reportsResult, analyticsResult] = await Promise.all([
      apiRequest("/api/admin/reports?limit=200", { headers }),
      apiRequest("/api/admin/analytics", { headers })
    ]);
    const analytics = analyticsResult.analytics;
    const eventMap = Object.fromEntries(analytics.eventCounts.map((row) => [row.eventType, row.count]));
    const conversionMap = Object.fromEntries(analytics.conversions.map((row) => [row.status, row.count]));
    const generated = Number(eventMap.report_generated || 0);
    const started = Number(eventMap.quiz_started || 0);
    const ctaClicks = Number(eventMap.cta_clicked || 0);
    const converted = Number(conversionMap.converted || 0);
    q("#adminAnalytics").innerHTML = `
      <div class="metric"><span>完成健檢</span><strong>${generated}</strong></div>
      <div class="metric"><span>健檢完成率</span><strong>${started ? pct(generated / started * 100) : "0.0%"}</strong></div>
      <div class="metric"><span>重新開啟</span><strong>${eventMap.report_reopened || 0}</strong></div>
      <div class="metric"><span>導流點擊</span><strong>${ctaClicks}</strong></div>
      <div class="metric"><span>已聯絡</span><strong>${conversionMap.contacted || 0}</strong></div>
      <div class="metric"><span>已轉換</span><strong>${converted}</strong></div>
      <div class="metric"><span>轉換率</span><strong>${generated ? pct(converted / generated * 100) : "0.0%"}</strong></div>
    `;
    q("#adminReports").innerHTML = `
      <div class="table-title"><h3>客戶報告</h3><span>${reportsResult.reports.length} 筆</span></div>
      <table>
        <thead><tr><th>建立時間</th><th>匿名編號</th><th>類型</th><th>狀態</th><th>聯絡方式</th><th>追蹤</th><th>查看</th></tr></thead>
        <tbody>${reportsResult.reports.map((row) => `
          <tr>
            <td>${new Date(row.createdAt).toLocaleString("zh-TW")}</td>
            <td>${escapeHtml(row.anonymousId)}</td>
            <td>${row.checkType === "stock" ? "股票" : "現金流"}</td>
            <td>${escapeHtml(row.status)}</td>
            <td>${escapeHtml(row.contactChannel)}</td>
            <td>
              <select data-followup-id="${row.id}">
                ${["new", "contacted", "converted", "closed"].map((item) => `<option value="${item}" ${row.followupStatus === item ? "selected" : ""}>${item}</option>`).join("")}
              </select>
            </td>
            <td><button class="secondary-button mini-button" data-admin-report="${row.id}" type="button">查看</button></td>
          </tr>
        `).join("")}</tbody>
      </table>
    `;
    q("#adminReports").querySelectorAll("[data-admin-report]").forEach((button) => {
      button.addEventListener("click", () => loadAdminReport(key, button.dataset.adminReport));
    });
    q("#adminReports").querySelectorAll("[data-followup-id]").forEach((select) => {
      select.addEventListener("change", async () => {
        try {
          await apiRequest(`/api/admin/reports/${select.dataset.followupId}`, {
            method: "PATCH",
            headers,
            body: JSON.stringify({ followupStatus: select.value })
          });
          status.textContent = "追蹤狀態已更新";
        } catch (error) {
          status.textContent = error.message;
        }
      });
    });
    status.textContent = `已載入 ${reportsResult.reports.length} 筆客戶報告`;
  } catch (error) {
    status.textContent = error.message;
    q("#adminAnalytics").innerHTML = "";
    q("#adminReports").innerHTML = "";
  }
}

async function loadAdminReport(key, id) {
  const detail = q("#adminReportDetail");
  try {
    const result = await apiRequest(`/api/admin/reports/${id}`, {
      headers: { Authorization: `Bearer ${key}` }
    });
    const report = result.report;
    detail.hidden = false;
    detail.innerHTML = `
      <h3>客戶報告明細</h3>
      <div class="metrics">
        <div class="metric"><span>報告編號</span><strong>${report.id}</strong></div>
        <div class="metric"><span>匿名編號</span><strong>${escapeHtml(report.anonymousId)}</strong></div>
        <div class="metric"><span>建立時間</span><strong>${new Date(report.createdAt).toLocaleString("zh-TW")}</strong></div>
        <div class="metric"><span>聯絡資料</span><strong>${escapeHtml(report.contact?.value || "未提供")}</strong></div>
      </div>
      <button class="secondary-button" id="downloadAdminReportBtn" type="button">下載此報告</button>
      <pre class="admin-json">${escapeHtml(JSON.stringify(report.payload, null, 2))}</pre>
    `;
    q("#downloadAdminReportBtn").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `customer-report-${report.id}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
    });
  } catch (error) {
    detail.hidden = false;
    detail.textContent = error.message;
  }
}

function goTo(viewId) {
  if (["paidReportView", "simulationView", "calendarView"].includes(viewId) && !state.paidUnlocked) {
    viewId = "upgradeView";
    showToast("完整報告、模擬與月曆需先解鎖");
  }
  activeView = viewId;
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("is-active", view.id === viewId));
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.view === viewId));
  if (viewId === "simulationView") requestAnimationFrame(() => drawSimulationChart(latestReport.simulation));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function bindGotoButtons() {
  document.querySelectorAll("[data-goto]").forEach((button) => {
    button.addEventListener("click", () => goTo(button.dataset.goto));
  });
}

function bindEvents() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => goTo(tab.dataset.view));
  });
  document.querySelectorAll("[data-scroll-target]").forEach((button) => {
    button.addEventListener("click", () => {
      q(`#${button.dataset.scrollTarget}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  document.querySelectorAll("[data-check-type]").forEach((button) => {
    button.addEventListener("click", () => {
      state.leadProfile.checkType = button.dataset.checkType;
      syncQuizInputs();
      renderQuickResult();
      trackEvent("quiz_started", { checkType: state.leadProfile.checkType });
    });
  });
  document.querySelectorAll("[data-capacity]").forEach((button) => {
    button.addEventListener("click", () => {
      state.leadProfile.capacity = button.dataset.capacity;
      syncQuizInputs();
      refreshReports();
    });
  });
  document.querySelectorAll("[data-concern]").forEach((button) => {
    button.addEventListener("click", () => {
      state.leadProfile.concern = button.dataset.concern;
      syncQuizInputs();
      refreshReports();
    });
  });
  const stockBudget = q("#stockMonthlyBudget");
  stockBudget.addEventListener("input", (event) => {
    state.leadProfile.stockMonthlyBudget = Number(event.target.value || 0);
    refreshReports();
  });
  ["reason", "drop", "count", "horizon"].forEach((field) => {
    document.querySelectorAll(`[data-stock-${field}]`).forEach((button) => {
      button.addEventListener("click", () => {
        const key = `stock${field[0].toUpperCase()}${field.slice(1)}`;
        state.leadProfile[key] = button.dataset[key];
        if (!state.inputCompletion.stockAnswers.includes(key)) state.inputCompletion.stockAnswers.push(key);
        syncQuizInputs();
        refreshReports();
      });
    });
  });
  q("#dataConsent").addEventListener("change", (event) => {
    state.consent.accepted = event.target.checked;
    state.consent.acceptedAt = event.target.checked ? new Date().toISOString() : null;
    persist();
  });
  q("#contactChannel").addEventListener("change", (event) => {
    state.consent.contactChannel = event.target.value;
  });
  q("#contactValue").addEventListener("input", (event) => {
    state.consent.contactValue = event.target.value;
  });
  q("#quickGenerateBtn").addEventListener("click", async () => {
    const errors = quickValidationErrors();
    showValidationErrors("#quickValidationErrors", errors);
    if (errors.length) return;
    applyQuickCheck();
    goTo("freeReportView");
    await saveGeneratedReport();
  });
  q("#generateBtn").addEventListener("click", async () => {
    const errors = detailedValidationErrors();
    showValidationErrors("#profileValidationErrors", errors);
    if (errors.length) return;
    refreshReports();
    persist();
    goTo("freeReportView");
    await saveGeneratedReport();
  });
  q("#saveBtn").addEventListener("click", () => {
    persist();
    showToast("已儲存到此瀏覽器");
  });
  q("#sampleBtn").addEventListener("click", () => {
    state = normalizeState(structuredClone(sampleState));
    updateProfileInputs();
    syncQuizInputs();
    renderMonthlyCashflows();
    renderHoldings();
    refreshReports();
    persist();
    showToast("已套用範例資料");
  });
  q("#addHoldingBtn").addEventListener("click", () => {
    state.holdings.push({ ticker: "", name: "新標的", type: "個股", amount: 0, lots: [{ price: 0, amount: 0 }], dividendYield: 3, expenseRatio: 0.2, sector: "未分類" });
    renderHoldings();
    refreshReports();
  });
  q("#applyProfileToMonthsBtn").addEventListener("click", applyProfileToMonths);
  q("#clearMonthsBtn").addEventListener("click", clearMonthlyCashflows);
  q("#simulationYears").addEventListener("change", (event) => {
    state.simulationYears = Number(event.target.value);
    refreshReports();
    persist();
  });
  q("#reloadDataBtn").addEventListener("click", async () => {
    const updated = await refreshDatabaseFromServer("manual");
    if (!updated) {
      await loadEtfDatabase();
      renderHoldings();
      refreshReports();
      showToast("ETF 資料庫已重新讀取");
    }
  });
  q("#printBtn").addEventListener("click", () => {
    if (!state.paidUnlocked) return goTo("upgradeView");
    window.print();
  });
  q("#loadAdminBtn").addEventListener("click", loadAdminDashboard);
  ["line-contact", "ig-contact", "form-contact"].forEach((id) => {
    q(`#${id}`)?.addEventListener("click", () => trackEvent("cta_clicked", { target: id }));
  });
  window.addEventListener("resize", () => {
    if (activeView === "simulationView") drawSimulationChart(latestReport.simulation);
    if (activeView === "databaseView") drawOfficialPriceChart();
  });
  bindGotoButtons();
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

function configureConsultationLinks() {
  const ig = q("#ig-contact");
  if (ig) {
    ig.href = consultationIgUrl;
    ig.target = "_blank";
    ig.rel = "noopener noreferrer";
  }
  const line = q("#line-contact");
  if (line) {
    if (consultationLineUrl) {
      line.href = consultationLineUrl;
      line.target = "_blank";
      line.rel = "noopener noreferrer";
      line.classList.remove("is-disabled");
    } else {
      line.href = "#contactPanel";
      line.removeAttribute("target");
      line.removeAttribute("rel");
      line.classList.add("is-disabled");
      line.setAttribute("aria-disabled", "true");
    }
  }
}

async function init() {
  if (new URLSearchParams(location.search).get("admin") === "1") {
    q(".admin-tab").hidden = false;
  }
  await loadEtfDatabase();
  syncInputs();
  bindEvents();
  configureConsultationLinks();
  refreshReports();
  await handlePaymentReturn();
  registerServiceWorker();
  trackEvent("page_opened", { path: location.pathname });
  refreshDatabaseFromServer("open");
}

init();
