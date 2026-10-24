// Server-only planning engine. Never add this file to the public allowlist.
function calculate(input, database) {
  if(!input || !input.profile || !Array.isArray(input.holdings) || input.holdings.length>100) throw Error('規劃輸入格式不正確');
  const profile={};
  for(const key of ['monthlyIncome','fixedExpense','insuranceExpense','loanExpense','monthlyInvestment','cashSavings','retirementMonthlyNeed','age']) {
    const n=Number(input.profile[key] ?? 0);if(!Number.isFinite(n)||n<0||n>1e12)throw Error('財務數值不正確');profile[key]=n;
  }
  const holdings=input.holdings.map(h=>{
    if(!h || !/^[A-Z0-9.:_-]{1,24}$/.test(String(h.ticker||'')))throw Error('持有代號格式不正確');
    const amount=Number(h.amount||0), dividendYield=h.dividendYield==null?null:Number(h.dividendYield);
    if(!Number.isFinite(amount)||amount<0||amount>1e12 || (dividendYield!==null && (!Number.isFinite(dividendYield)||dividendYield<0||dividendYield>100)))throw Error('持有數值不正確');
    const lots=Array.isArray(h.lots)?h.lots:[];if(lots.length>100)throw Error('買入批次過多');
    for(const lot of lots)if(!Number.isFinite(Number(lot.amount))||Number(lot.amount)<0||Number(lot.amount)>1e12||!Number.isFinite(Number(lot.price))||Number(lot.price)<0||Number(lot.price)>1e9)throw Error('買入批次不正確');
    return {ticker:String(h.ticker),type:String(h.type||''),amount,dividendYield,lots};
  });
  const months=input.monthlyCashflows||{};
  for(const row of Object.values(months)) {if(!row||typeof row!=='object')throw Error('月份資料不正確');for(const key of ['monthlyIncome','fixedExpense','insuranceExpense','loanExpense','monthlyInvestment'])if(row[key]!=null&&row[key]!==''&&(!Number.isFinite(Number(row[key]))||Number(row[key])<0||Number(row[key])>1e12))throw Error('月份數值不正確');}
  const state={profile,holdings,monthlyCashflows:months,simulationYears:[10,15,20,25,30].includes(Number(input.simulationYears))?Number(input.simulationYears):20};
  const etfDatabase=database||{}, monthLabels=Array.from({length:12},(_,i)=>(i+1)+'月');
  const monthFields=['monthlyIncome','fixedExpense','insuranceExpense','loanExpense','monthlyInvestment'];
  const clamp=(n,min,max)=>Math.min(max,Math.max(min,n)),pct=n=>Number(n).toFixed(1)+'%';
  function holdingUnits(h){const lots=h.lots||[];return lots.reduce((s,l)=>s+(Number(l.price)>0?Number(l.amount)/Number(l.price):0),0);}
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

function highDividendDependency(holdings) {
  const total = totalInvested(holdings);
  if (!total) return 0;
  const highDividend = holdings
    .filter((item) => item.type === "高股息")
    .reduce((sum, item) => sum + holdingAmount(item), 0);
  return highDividend / total * 100;
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

function monthlyFieldValue(row, field) {
  const value = row?.[field];
  return value === "" || value === undefined || value === null
    ? Number(state.profile[field] || 0)
    : Number(value || 0);
}

function monthlyProfile(monthNumber) {
  const row = state.monthlyCashflows?.[monthNumber] || {};
  return {
    ...state.profile,
    monthlyIncome: monthlyFieldValue(row, "monthlyIncome"),
    fixedExpense: monthlyFieldValue(row, "fixedExpense"),
    insuranceExpense: monthlyFieldValue(row, "insuranceExpense"),
    loanExpense: monthlyFieldValue(row, "loanExpense"),
    monthlyInvestment: monthlyFieldValue(row, "monthlyInvestment")
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

  const simulation=buildSimulation(profile,holdings),breakdown=calculateBreakdown(profile,holdings);
  const report={profile,holdings,breakdown,simulation,gap:retirementGap(profile,simulation),stress:dividendStress(profile,holdings),highDividendRatio:highDividendDependency(holdings),overlap:{score:null}};
  report.allocations=allocationRecommendations(report);report.actions=personalizedActions(report);report.calendar=buildCalendar(profile,holdings);
  report.assumptions=['沿用既有規則式試算；不代表保證報酬。','配息依輸入殖利率估算，缺資料不代表零配息。','月曆採已有官方配息紀錄及買入批次推算單位，並非未來公告。'];
  report.yieldCoverage={known:holdings.filter(h=>h.dividendYield!==null).length,total:holdings.length};
  return report;
}
module.exports={calculate};
