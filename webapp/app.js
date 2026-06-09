const storageKey = "cashflow-map-web-state";
const disclaimer = "本 App 僅供教育與財務規劃參考，不構成任何投資建議、買賣建議或保證報酬。所有投資皆有風險，使用者應自行判斷並承擔投資結果。";

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
    { ticker: "0056", name: "高股息 ETF", type: "高股息", amount: 180000, dividendYield: 6.1, expenseRatio: 0.43, sector: "金融" },
    { ticker: "00878", name: "ESG 高股息", type: "高股息", amount: 160000, dividendYield: 5.7, expenseRatio: 0.38, sector: "電子" },
    { ticker: "006208", name: "台股市值型", type: "市值型", amount: 90000, dividendYield: 2.3, expenseRatio: 0.15, sector: "半導體" }
  ],
  paidUnlocked: false,
  consultingUnlocked: false
};

let state = loadState();
let activeView = "inputView";
let latestReport = buildReport();
let etfDatabase = null;
let etfDataQuality = {
  status: "loading",
  errors: [],
  warnings: ["ETF 官方資料庫尚未載入"],
  counts: { etfs: 0, distributions: 0, holdings: 0, priceSeries: 0, navSeries: 0 }
};

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

function loadState() {
  const saved = localStorage.getItem(storageKey);
  if (!saved) return structuredClone(sampleState);
  try {
    return { ...structuredClone(sampleState), ...JSON.parse(saved) };
  } catch {
    return structuredClone(sampleState);
  }
}

function persist() {
  localStorage.setItem(storageKey, JSON.stringify(state));
}

async function loadEtfDatabase() {
  try {
    const response = await fetch("./data/etf-database.json", { cache: "no-store" });
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
      counts: { etfs: 0, distributions: 0, holdings: 0, priceSeries: 0, navSeries: 0 }
    };
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

  for (const etf of db?.etfs || []) {
    if (!etf.ticker) errors.push("ETF 缺 ticker");
    if (tickers.has(etf.ticker)) errors.push(`ETF ticker 重複：${etf.ticker}`);
    tickers.add(etf.ticker);
    if (!etf.shortName || !etf.fundName) errors.push(`${etf.ticker} 缺名稱`);
    if (!etf.issuer) errors.push(`${etf.ticker} 缺發行公司`);
    if (!etf.sourceUrl) errors.push(`${etf.ticker} 缺來源 URL`);

    const date = new Date(`${etf.performance?.date || ""}T00:00:00+08:00`);
    if (Number.isNaN(date.getTime())) {
      warnings.push(`${etf.ticker} 缺績效資料日期`);
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

  return {
    status: errors.length ? "failed" : warnings.length ? "passed_with_warnings" : "passed",
    errors,
    warnings,
    counts: {
      etfs: db?.etfs?.length || 0,
      distributions: db?.distributions?.length || 0,
      holdings: db?.holdings?.items?.length || 0,
      priceSeries: db?.priceSeries?.items?.length || 0,
      navSeries: db?.navSeries?.items?.length || 0
    }
  };
}

function findEtf(ticker) {
  return etfDatabase?.etfs?.find((item) => item.ticker === String(ticker || "").trim());
}

function enrichHoldingsFromDatabase() {
  state.holdings = state.holdings.map((holding) => {
    const etf = findEtf(holding.ticker);
    if (!etf) return holding;
    return {
      ...holding,
      name: etf.shortName,
      type: etf.themes?.includes("高股息") ? "高股息" : etf.themes?.includes("大型權值") ? "市值型" : holding.type,
      sector: etf.themes?.[0] || holding.sector,
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

function totalInvested(holdings) {
  return holdings.reduce((sum, item) => sum + Number(item.amount || 0), 0);
}

function annualDividend(holdings) {
  return holdings.reduce((sum, item) => sum + Number(item.amount || 0) * Number(item.dividendYield || 0) / 100, 0);
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
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);
  return highDividend / total * 100;
}

function overlapReport(holdings) {
  const total = totalInvested(holdings);
  const byType = groupAmount(holdings, "type");
  const bySector = groupAmount(holdings, "sector");
  const topType = topShare(byType, total);
  const topSector = topShare(bySector, total);
  const score = clamp(Math.max(topType.share, topSector.share) + Math.max(0, holdings.length - new Set(holdings.map((x) => x.type)).size) * 8, 0, 100);
  return {
    score,
    topType,
    topSector,
    message: score >= 70 ? "持股集中度偏高，容易買到不同代號但相似邏輯的 ETF。" : "目前分散度尚可，但仍需定期檢查成分與產業曝險。"
  };
}

function groupAmount(items, key) {
  return items.reduce((acc, item) => {
    const name = item[key] || "未分類";
    acc[name] = (acc[name] || 0) + Number(item.amount || 0);
    return acc;
  }, {});
}

function topShare(grouped, total) {
  const [name = "無", amount = 0] = Object.entries(grouped).sort((a, b) => b[1] - a[1])[0] || [];
  return { name, amount, share: total ? amount / total * 100 : 0 };
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
  const averageYield = holdings.length
    ? holdings.reduce((sum, item) => sum + Number(item.dividendYield || 0), 0) / holdings.length
    : 3;
  const growthRate = clamp(averageYield * 0.35 + 2.2, 2.5, 6.5) / 100;
  let asset = totalInvested(holdings) + Number(profile.cashSavings || 0) * 0.25;
  let contributed = totalInvested(holdings);
  return Array.from({ length: 10 }, (_, index) => {
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

function buildCalendar(profile, holdings) {
  const months = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];
  const baseDividend = annualDividend(holdings) / 12;
  return months.map((month, index) => {
    const seasonalExpense = [1, 5, 8].includes(index) ? 3500 : 0;
    const dividendBoost = [2, 5, 8, 11].includes(index) ? baseDividend * 1.8 : baseDividend * 0.7;
    const expenses = monthlyTotalExpense(profile) + seasonalExpense;
    const investable = Number(profile.monthlyIncome) - expenses - Number(profile.monthlyInvestment) + dividendBoost;
    const status = investable < 0 ? "stress" : investable < Number(profile.monthlyIncome) * 0.08 ? "watch" : "safe";
    return {
      month,
      income: Number(profile.monthlyIncome),
      expenses,
      dividend: dividendBoost,
      investable,
      status,
      reminder: status === "stress" ? "先補現金流缺口，再談加碼。" : status === "watch" ? "支出接近警戒線，保留現金。" : "現金流穩定，可檢查配置。"
    };
  });
}

function buildRisks(profile, holdings, breakdown) {
  const risks = [];
  const expense = monthlyTotalExpense(profile);
  const emergencyMonths = expense ? Number(profile.cashSavings) / expense : 0;
  const highRatio = highDividendDependency(holdings);
  const overlap = overlapReport(holdings);

  if (investableCashflow(profile) < 0) {
    risks.push({ level: "high", title: "每月現金流為負", body: "收入扣除固定支出、貸款、保險與投資後已低於 0。" });
  }
  if (emergencyMonths < 6) {
    risks.push({ level: emergencyMonths < 3 ? "high" : "medium", title: "緊急預備金不足", body: `目前約 ${emergencyMonths.toFixed(1)} 個月，低於 6 個月安全線。` });
  }
  if (highRatio > 55) {
    risks.push({ level: "medium", title: "高股息依賴偏高", body: `高股息 ETF 占比約 ${pct(highRatio)}，配息下修時現金流容易受影響。` });
  }
  if (overlap.score > 65) {
    risks.push({ level: "medium", title: "ETF 曝險重疊", body: `${overlap.topType.name} 或 ${overlap.topSector.name} 集中度偏高。` });
  }
  if (breakdown.retirement < 55) {
    risks.push({ level: "medium", title: "退休準備不足", body: "目前投入速度與退休月花費目標之間仍有落差。" });
  }
  if (risks.length === 0) {
    risks.push({ level: "low", title: "主要風險暫時可控", body: "目前現金流與配置沒有明顯紅燈，仍建議每季重算一次。" });
  }
  return risks.slice(0, 3);
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
  if (report.overlap.score > 65) actions.push("檢查 ETF 成分與產業，刪掉功能相近但費用較高的部位。");
  if (report.stress.cut50 < 0) actions.push("用 50% 配息下修情境重排月支出，不要把配息視為固定薪水。");
  if (actions.length < 3) actions.push("每月固定重算一次現金流月曆，確認投資額沒有壓縮生活安全墊。");
  return actions.slice(0, 4);
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
  return report;
}

function syncInputs() {
  profileFields.forEach((field) => {
    q(`#${field}`).value = state.profile[field];
    q(`#${field}`).addEventListener("input", (event) => {
      state.profile[field] = Number(event.target.value || 0);
      refreshReports();
    });
  });
  renderHoldings();
}

function renderHoldings() {
  const root = q("#holdingEditor");
  root.innerHTML = "";
  state.holdings.forEach((holding, index) => {
    const officialEtf = findEtf(holding.ticker);
    const row = document.createElement("div");
    row.className = "holding-row";
    row.innerHTML = `
      <label>代號<input data-field="ticker" value="${escapeHtml(holding.ticker)}" /></label>
      <label>名稱<input data-field="name" value="${escapeHtml(officialEtf?.shortName || holding.name)}" /></label>
      <label>類型
        <select data-field="type">
          ${["市值型", "高股息", "債券", "海外", "主題"].map((type) => `<option ${holding.type === type ? "selected" : ""}>${type}</option>`).join("")}
        </select>
      </label>
      <label>金額<input data-field="amount" type="number" min="0" step="1000" value="${holding.amount}" /></label>
      <label>殖利率<input data-field="dividendYield" type="number" min="0" step="0.1" value="${holding.dividendYield}" /></label>
      <button class="icon-button" data-remove="${index}" type="button" title="刪除" aria-label="刪除">×</button>
      ${officialEtf ? `<small class="data-note">${officialEtf.issuer} · 資料日 ${officialEtf.performance.date}</small>` : `<small class="data-note warning">尚未對應官方 ETF 主檔</small>`}
    `;
    root.append(row);
  });

  root.querySelectorAll("input, select").forEach((input) => {
    input.addEventListener("input", (event) => {
      const row = event.target.closest(".holding-row");
      const index = [...root.children].indexOf(row);
      const field = event.target.dataset.field;
      const numeric = ["amount", "dividendYield", "expenseRatio"].includes(field);
      state.holdings[index][field] = numeric ? Number(event.target.value || 0) : event.target.value;
      if (field === "ticker") enrichHoldingsFromDatabase();
      if (field === "type") state.holdings[index].sector = defaultSector(event.target.value);
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
    "高股息": "金融",
    "債券": "固定收益",
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

function scoreHtml(report) {
  return `
    <section class="score-panel">
      <span class="badge">${report.status}</span>
      <div class="score-circle" style="--score:${report.score}">
        <strong>${report.score}</strong>
      </div>
      <div class="metrics">
        <div class="metric"><span>每月可用現金流</span><strong>${formatMoney(investableCashflow(report.profile))}</strong></div>
        <div class="metric"><span>ETF 年配息估算</span><strong>${formatMoney(annualDividend(report.holdings))}</strong></div>
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
  return `
    <section class="panel">
      <h3>資料來源狀態</h3>
      <div class="metrics">
        <div class="metric"><span>主檔</span><strong>${quality.counts.etfs ? "已接" : "未接"}</strong></div>
        <div class="metric"><span>配息</span><strong>${quality.counts.distributions ? "已接" : "未接"}</strong></div>
        <div class="metric"><span>資料日</span><strong>${db?.metadata?.officialPerformanceDate || "無"}</strong></div>
        <div class="metric"><span>狀態</span><strong>${quality.status === "failed" ? "錯誤" : quality.warnings.length ? "有警示" : "通過"}</strong></div>
      </div>
      ${missing.length ? `<ul class="feature-list">${missing.map((item) => `<li>${item}</li>`).join("")}</ul>` : `<p>目前 ETF 主檔與配息快照已可使用。</p>`}
    </section>
  `;
}

function renderFreeReport() {
  const report = latestReport;
  q("#freeReport").innerHTML = `
    ${scoreHtml(report)}
    <div class="stack">
      ${breakdownHtml(report)}
      ${risksHtml(report, false)}
      ${dataSourceHtml()}
      <section class="panel">
        <h3>退休缺口方向</h3>
        <p>10 年後推估資產 ${formatMoney(report.gap.projected)}，距離目標仍差 ${formatMoney(report.gap.gap)}。</p>
      </section>
      <section class="panel locked">
        <h3>現金流預覽</h3>
        <p>目前每月可用現金流約 ${formatMoney(investableCashflow(report.profile))}。12 個月月曆與 ETF 配息壓力測試需升級後查看。</p>
      </section>
    </div>
  `;
}

function renderUpgrade() {
  const plans = [
    { name: "免費版", price: "NT$0", action: "保留免費版", key: "free", features: ["財務體質分數", "分數拆解摘要", "3 大風險提示"] },
    { name: "完整報告版", price: "NT$299", action: state.paidUnlocked ? "已解鎖" : "Mock 解鎖", key: "paid", highlight: true, features: ["ETF 重疊度分析", "高股息依賴與壓力測試", "10 年模擬與 12 個月月曆", "PDF/列印匯出"] },
    { name: "一對一健檢版", price: "NT$2,980", action: state.consultingUnlocked ? "已登記" : "Mock 登記", key: "consulting", features: ["完整報告版內容", "預約諮詢 CTA", "個人化調整建議整理"] }
  ];
  q("#plans").innerHTML = plans.map((plan) => `
    <article class="plan-card ${plan.highlight ? "highlight" : ""}">
      <h3>${plan.name}</h3>
      <div class="price">${plan.price}</div>
      <ul class="feature-list">${plan.features.map((item) => `<li>${item}</li>`).join("")}</ul>
      <button class="${plan.highlight ? "primary-button" : "secondary-button"}" data-plan="${plan.key}" type="button">${plan.action}</button>
    </article>
  `).join("");

  q("#plans").querySelectorAll("[data-plan]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.plan === "paid") {
        state.paidUnlocked = true;
        showToast("完整報告已用 mock purchase 解鎖");
        goTo("paidReportView");
      }
      if (button.dataset.plan === "consulting") {
        state.paidUnlocked = true;
        state.consultingUnlocked = true;
        showToast("一對一健檢方案已用 mock purchase 登記");
        goTo("paidReportView");
      }
      persist();
      refreshReports();
    });
  });
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

  q("#dataQuality").innerHTML = `
    <section class="score-panel">
      <span class="badge">${statusText}</span>
      <div class="metrics">
        <div class="metric"><span>ETF 主檔</span><strong>${quality.counts.etfs}</strong></div>
        <div class="metric"><span>配息資料</span><strong>${quality.counts.distributions}</strong></div>
        <div class="metric"><span>成分股</span><strong>${quality.counts.holdings}</strong></div>
        <div class="metric"><span>NAV/價格</span><strong>${quality.counts.navSeries + quality.counts.priceSeries}</strong></div>
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
    <table>
      <thead><tr><th>代號</th><th>名稱</th><th>發行公司</th><th>追蹤指數</th><th>資產規模</th><th>資料日</th><th>來源</th></tr></thead>
      <tbody>
        ${db.etfs.map((etf) => `
          <tr>
            <td>${etf.ticker}</td>
            <td>${etf.shortName}</td>
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

  q("#priceSeriesTable").innerHTML = db?.priceSeries?.items?.length ? `
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
  const allCloses = rows.map((row) => row.close).filter((value) => Number.isFinite(value));
  const min = Math.min(...allCloses);
  const max = Math.max(...allCloses);
  const span = Math.max(1, max - min);
  const colors = ["#0f766e", "#b45309", "#1d4ed8", "#7c3aed"];

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

  Object.entries(byTicker).forEach(([ticker, tickerRows], index) => {
    const sorted = [...tickerRows].sort((a, b) => a.date.localeCompare(b.date));
    ctx.strokeStyle = colors[index % colors.length];
    ctx.fillStyle = colors[index % colors.length];
    ctx.lineWidth = 3;
    ctx.beginPath();
    sorted.forEach((row, pointIndex) => {
      const x = pad + pointIndex * ((width - pad * 2) / Math.max(1, sorted.length - 1));
      const y = height - pad - ((row.close - min) / span) * (height - pad * 2);
      if (pointIndex === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.font = "12px Microsoft JhengHei, sans-serif";
    ctx.fillText(ticker, pad + index * 62, 18);
  });

  ctx.fillStyle = "#65736f";
  ctx.font = "12px Microsoft JhengHei, sans-serif";
  ctx.fillText(String(max), width - pad - 40, 18);
  ctx.fillText(String(min), width - pad - 40, height - 10);
}

function renderPaidReport() {
  const report = latestReport;
  if (!state.paidUnlocked) {
    q("#paidReport").innerHTML = `
      <section class="panel">
        <h3>完整報告尚未解鎖</h3>
        <p>請先到升級頁使用 mock purchase 解鎖完整報告。</p>
        <button class="primary-button" data-goto="upgradeView" type="button">前往升級</button>
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
      <section class="panel">
        <h3>ETF 重疊度分析</h3>
        <div class="metrics">
          <div class="metric"><span>重疊風險</span><strong>${Math.round(report.overlap.score)}</strong></div>
          <div class="metric"><span>主要類型</span><strong>${report.overlap.topType.name}</strong></div>
          <div class="metric"><span>主要產業</span><strong>${report.overlap.topSector.name}</strong></div>
          <div class="metric"><span>高股息占比</span><strong>${pct(report.highDividendRatio)}</strong></div>
        </div>
        <p>${report.overlap.message}</p>
      </section>
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
  ctx.fillText("第 10 年", width - pad - 46, height - 8);
}

function renderCalendar() {
  q("#cashflowCalendar").innerHTML = latestReport.calendar.map((month) => `
    <article class="calendar-card ${month.status}">
      <div class="panel-head">
        <h3>${month.month}</h3>
        <span class="badge">${month.status === "safe" ? "安全" : month.status === "watch" ? "普通" : "壓力"}</span>
      </div>
      <div>
        <div class="kv"><span>收入</span><strong>${formatMoney(month.income)}</strong></div>
        <div class="kv"><span>支出</span><strong>${formatMoney(month.expenses)}</strong></div>
        <div class="kv"><span>ETF 配息</span><strong>${formatMoney(month.dividend)}</strong></div>
        <div class="kv"><span>可投資金額</span><strong>${formatMoney(month.investable)}</strong></div>
      </div>
      <p>${month.reminder}</p>
    </article>
  `).join("");
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

function reportMarkdown() {
  const report = latestReport;
  return [
    "# 小資現金流地圖完整報告",
    "",
    `- 財務體質分數：${report.score}`,
    `- 狀態：${report.status}`,
    `- 每月可用現金流：${formatMoney(investableCashflow(report.profile))}`,
    `- ETF 年配息估算：${formatMoney(annualDividend(report.holdings))}`,
    `- 高股息依賴：${pct(report.highDividendRatio)}`,
    `- 退休缺口：${formatMoney(report.gap.gap)}`,
    "",
    "## 3 大風險",
    ...report.risks.map((risk) => `- ${risk.title}：${risk.body}`),
    "",
    "## ETF 重疊度分析",
    `- 重疊風險：${Math.round(report.overlap.score)}`,
    `- 主要類型：${report.overlap.topType.name}`,
    `- 主要產業：${report.overlap.topSector.name}`,
    `- 說明：${report.overlap.message}`,
    "",
    "## 配息壓力測試",
    `- 月配息估算：${formatMoney(report.stress.monthlyDividend)}`,
    `- 下修 30%：${formatMoney(report.stress.cut30)}`,
    `- 下修 50%：${formatMoney(report.stress.cut50)}`,
    "",
    "## 個人化調整建議",
    ...report.actions.map((action) => `- ${action}`),
    "",
    "## 免責聲明",
    disclaimer
  ].join("\n");
}

function downloadMarkdown() {
  const blob = new Blob([reportMarkdown()], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "小資現金流地圖完整報告.md";
  link.click();
  URL.revokeObjectURL(url);
}

function bindEvents() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => goTo(tab.dataset.view));
  });
  q("#generateBtn").addEventListener("click", () => {
    refreshReports();
    persist();
    goTo("freeReportView");
  });
  q("#saveBtn").addEventListener("click", () => {
    persist();
    showToast("已儲存到此瀏覽器");
  });
  q("#sampleBtn").addEventListener("click", () => {
    state = structuredClone(sampleState);
    syncInputs();
    refreshReports();
    persist();
    showToast("已套用範例資料");
  });
  q("#addHoldingBtn").addEventListener("click", () => {
    state.holdings.push({ ticker: "", name: "新 ETF", type: "市值型", amount: 0, dividendYield: 3, expenseRatio: 0.2, sector: "半導體" });
    renderHoldings();
    refreshReports();
  });
  q("#reloadDataBtn").addEventListener("click", async () => {
    await loadEtfDatabase();
    renderHoldings();
    refreshReports();
    showToast("ETF 資料庫已重新讀取");
  });
  q("#printBtn").addEventListener("click", () => {
    if (!state.paidUnlocked) return goTo("upgradeView");
    window.print();
  });
  q("#markdownBtn").addEventListener("click", () => {
    if (!state.paidUnlocked) return goTo("upgradeView");
    downloadMarkdown();
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

async function init() {
  await loadEtfDatabase();
  syncInputs();
  bindEvents();
  refreshReports();
  registerServiceWorker();
}

init();
