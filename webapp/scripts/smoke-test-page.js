const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const cliArgs = process.argv.slice(2);
const explicitTargetUrl = cliArgs.find((arg) => !arg.startsWith("--"));
const shouldServe = cliArgs.includes("--serve");
const requestedPort = explicitTargetUrl ? Number(new URL(explicitTargetUrl).port) : 0;
const smokeServerPort = requestedPort > 0 ? requestedPort : 5400 + Math.floor(Math.random() * 400);
const targetUrl = explicitTargetUrl || (shouldServe ? `http://127.0.0.1:${smokeServerPort}/` : "http://127.0.0.1:5188/");
const screenshotArg = cliArgs.find((arg) => arg.startsWith("--screenshot="));
const screenshotPath = screenshotArg ? path.resolve(screenshotArg.slice("--screenshot=".length)) : "";
const screenshotViewArg = cliArgs.find((arg) => arg.startsWith("--screenshot-view="));
const screenshotView = screenshotViewArg ? screenshotViewArg.slice("--screenshot-view=".length) : "landingView";
const screenshotSectionArg = cliArgs.find((arg) => arg.startsWith("--screenshot-section="));
const screenshotSection = screenshotSectionArg ? screenshotSectionArg.slice("--screenshot-section=".length) : "";
const viewportArg = cliArgs.find((arg) => arg.startsWith("--viewport="));
const viewportMatch = viewportArg?.match(/^(?:--viewport=)(\d+)x(\d+)$/i);
const viewportWidth = viewportMatch ? Number(viewportMatch[1]) : 390;
const viewportHeight = viewportMatch ? Number(viewportMatch[2]) : 844;
const mobileViewport = viewportWidth <= 640;
const chromePath = process.env.CHROME_PATH || [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
].find((item) => fs.existsSync(item));

if (!chromePath) {
  console.error("Chrome or Edge executable not found");
  process.exit(1);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    }).on("error", reject);
  });
}

async function waitForHttp(url, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // retry
    }
    await wait(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function send(ws, method, params = {}) {
  const id = ++send.nextId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    send.pending.set(id, { resolve, reject });
  });
}
send.nextId = 0;
send.pending = new Map();

async function evalValue(ws, expression) {
  const result = await send(ws, "Runtime.evaluate", { expression, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Runtime.evaluate failed");
  }
  return result.result.value;
}

async function waitForPageReady(ws, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const ready = await evalValue(ws, `Boolean(document.body?.dataset?.appReady === "true" && document.querySelector("#landingView"))`);
      if (ready) return;
    } catch {
      // retry until the document is available
    }
    await wait(250);
  }
  let debug = {};
  try {
    debug = await evalValue(ws, `({ href: location.href, readyState: document.readyState, body: Boolean(document.body), html: document.documentElement?.outerHTML?.slice(0, 120) || "" })`);
  } catch (error) {
    debug = { error: error.message };
  }
  throw new Error(`Timed out waiting for page DOM: ${JSON.stringify(debug)}`);
}

async function main() {
  let serverProcess = null;
  let chromeProcess = null;
  let customerDataDir = null;
  const failures = [];
  const consoleErrors = [];
  const runtimeErrors = [];
  const badResponses = [];

  try {
    if (shouldServe) {
      customerDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cashflow-smoke-data-"));
      serverProcess = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
        cwd: path.join(__dirname, "..", ".."),
        env: {
          ...process.env,
          SMOKE_TEST: "1",
          PORT: String(smokeServerPort),
          ALLOWED_ORIGINS: `http://localhost:${smokeServerPort},http://127.0.0.1:${smokeServerPort}`,
          CUSTOMER_DATA_DIR: customerDataDir,
          CUSTOMER_DATA_KEY: crypto.randomBytes(32).toString("base64"),
          ACCESS_CODE_PEPPER: crypto.randomBytes(24).toString("base64url"),
          ADMIN_API_KEY: crypto.randomBytes(24).toString("base64url"),
          GITHUB_ACTIONS_TOKEN: "",
          LINE_REPLY_DISABLED: "1"
        },
        windowsHide: true,
        stdio: "ignore"
      });
      await waitForHttp(targetUrl);
    }

    const debuggingPort = 9300 + Math.floor(Math.random() * 400);
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cashflow-smoke-"));
    chromeProcess = spawn(chromePath, [
      "--headless=new",
      `--remote-debugging-port=${debuggingPort}`,
      `--user-data-dir=${userDataDir}`,
      "--disable-software-rasterizer",
      "--disable-gpu-compositing",
      "--in-process-gpu",
      "--no-sandbox",
      `--window-size=${viewportWidth},${viewportHeight}`,
      "about:blank"
    ], { windowsHide: true, stdio: "ignore" });

    let version;
    const versionUrl = `http://127.0.0.1:${debuggingPort}/json/version`;
    for (let i = 0; i < 40; i++) {
      try {
        version = await fetchJson(versionUrl);
        break;
      } catch {
        await wait(250);
      }
    }
    if (!version?.webSocketDebuggerUrl) throw new Error("Chrome DevTools endpoint did not start");
    const targets = await fetchJson(`http://127.0.0.1:${debuggingPort}/json/list`);
    const pageTarget = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
    if (!pageTarget) throw new Error("Chrome page target did not start");

    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });

    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && send.pending.has(message.id)) {
        const pending = send.pending.get(message.id);
        send.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        consoleErrors.push(message.params.args.map((arg) => arg.value || arg.description || "").join(" "));
      }
      if (message.method === "Runtime.exceptionThrown") {
        runtimeErrors.push(message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text || "runtime exception");
      }
      if (message.method === "Network.loadingFailed") {
        const reason = message.params.errorText || message.params.blockedReason || "loadingFailed";
        if (reason !== "net::ERR_NETWORK_ACCESS_DENIED") failures.push(reason);
      }
      if (message.method === "Network.responseReceived") {
        const status = message.params.response.status;
        const url = message.params.response.url;
        if (status >= 400 && !url.includes("fonts.gstatic.com") && !url.includes("fonts.googleapis.com")) {
          badResponses.push({ status, url });
        }
      }
    });

    await send(ws, "Runtime.enable");
    await send(ws, "Network.enable");
    await send(ws, "Page.enable");
    await send(ws, "Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        window.__smokeFailedApiResponses = [];
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (...args) => {
          const response = await originalFetch(...args);
          if (response.status >= 400) {
            let body = "";
            try { body = (await response.clone().text()).slice(0, 500); } catch {}
            const request = args[0];
            const url = request instanceof Request ? request.url : String(request);
            window.__smokeFailedApiResponses.push({ url, status: response.status, body });
          }
          return response;
        };
      })()`
    });
    await send(ws, "Emulation.setDeviceMetricsOverride", {
      width: viewportWidth,
      height: viewportHeight,
      deviceScaleFactor: mobileViewport ? 2 : 1,
      mobile: mobileViewport
    });
    await send(ws, "Emulation.setUserAgentOverride", {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    });

    await send(ws, "Page.navigate", { url: targetUrl });
    await waitForPageReady(ws);
    await wait(4500);

    const landing = await evalValue(ws, `(() => {
      const text = document.body.innerText || "";
      return {
        title: document.title,
        activeView: document.querySelector(".view.is-active")?.id,
        brand: document.querySelector(".brand h1")?.textContent,
        heroTitle: document.querySelector("#landingTitle")?.textContent,
        hasPain: Boolean(document.querySelector("#painPoints")),
        hasSolution: Boolean(document.querySelector("#solutionPanel")),
        hasFlow: Boolean(document.querySelector("#quickCheckPanel .flow-step.is-active")),
        hasServices: Boolean(document.querySelector("#servicePanel")),
        hasTestimonials: Boolean(document.querySelector("#testimonialPanel")),
        hasCta: Boolean(document.querySelector("#contactPanel")),
        hasMotionStage: Boolean(document.querySelector(".motion-stage .flow-line i")),
        hasMotionCards: document.querySelectorAll(".motion-cards div").length === 3,
        hasAdvancedInputEntry: text.includes("填家庭收支與 ETF 配置"),
        hasIg: text.includes("@chendino080077"),
        headerStatus: document.querySelector("#headerStatus")?.textContent,
        painKicker: document.querySelector("#painPoints .section-kicker")?.textContent,
        painTitle: document.querySelector("#painPoints .section-heading h2")?.textContent,
        solutionTitle: document.querySelector("#solutionPanel h2")?.textContent,
        quickCheckTitle: document.querySelector("#quickCheckTitle")?.textContent,
        serviceTitle: document.querySelector("#servicePanel .section-heading h2")?.textContent,
        testimonialTitle: document.querySelector("#testimonialPanel h2")?.textContent,
        contactTitle: document.querySelector("#contactTitle")?.textContent,
        formQuestionTitles: [...document.querySelectorAll("#quickCheckPanel [data-flow-step] > h3")].map((item) => item.textContent.trim()),
        memberTitles: [
          "#dashboardTitle",
          "#inputTitle",
          "#freeTitle",
          "#upgradeTitle",
          "#paidTitle",
          "#simulationTitle",
          "#calendarTitle"
        ].map((selector) => document.querySelector(selector)?.textContent?.trim()),
        internalCopyLeaked: [
          "使用者回饋後先改這裡",
          "首頁不要再像工具箱",
          "新的網站流程",
          "正式 LINE / 表單網址提供後"
        ].some((copy) => text.includes(copy)),
        headerHeight: Math.round(document.querySelector(".brand-nav")?.getBoundingClientRect().height || 0),
        heroFontSize: parseFloat(getComputedStyle(document.querySelector(".hero-copy h2")).fontSize),
        heroContentTopGap: Math.round(
          document.querySelector(".hero-copy")?.getBoundingClientRect().top
          - document.querySelector(".hero-section")?.getBoundingClientRect().top
        ),
        heroProofDisplay: getComputedStyle(document.querySelector(".hero-proof")).display,
        heroActionsDisplay: getComputedStyle(document.querySelector(".hero-actions")).display,
        gateEyebrowColor: getComputedStyle(document.querySelector(".member-auth-gate .eyebrow")).color,
        heroEyebrowColor: getComputedStyle(document.querySelector(".hero-section .eyebrow")).color,
        bodyOverflow: Math.max(0, document.body.scrollWidth - document.documentElement.clientWidth)
      };
    })()`);

    await send(ws, "Runtime.evaluate", {
      expression: `document.querySelector('.flow-step.is-active [data-flow-next]').click()`
    });
    await wait(250);
    const requiredValidation = await evalValue(ws, `(() => ({
      step: document.querySelector(".flow-step.is-active")?.dataset.flowStep,
      errorsVisible: !document.querySelector("#quickValidationErrors")?.hidden,
      errorCount: document.querySelectorAll("#quickValidationErrors li").length
    }))()`);

    const fillStep = async (selector, value) => {
      await send(ws, "Runtime.evaluate", {
        expression: `(() => {
          const input = document.querySelector(${JSON.stringify(selector)});
          input.value = ${JSON.stringify(value)};
          input.dispatchEvent(new Event("input", { bubbles: true }));
          document.querySelector('.flow-step.is-active [data-flow-next]')?.click();
        })()`
      });
      await wait(350);
    };

    await send(ws, "Runtime.evaluate", { expression: `document.querySelector('[data-goto="inputView"]').click()` });
    await wait(350);
    const advancedInput = await evalValue(ws, `(() => ({
      activeView: document.querySelector(".view.is-active")?.id,
      hasMonthlyEditor: Boolean(document.querySelector("#monthlyCashflowEditor")),
      visibleMonthRows: document.querySelectorAll("#monthlyCashflowEditor .month-row").length,
      monthTabCount: document.querySelectorAll("#monthlyCashflowEditor [data-select-month]").length,
      activeMonthTabs: document.querySelectorAll("#monthlyCashflowEditor .month-tab.is-active").length,
      activeMonth: Number(document.querySelector("#monthlyCashflowEditor .month-tab.is-active")?.dataset.selectMonth || 0),
      hasHoldingEditor: Boolean(document.querySelector("#holdingEditor")),
      panelBackdrop: getComputedStyle(document.querySelector("#etfAllocationSection")).backdropFilter,
      title: document.querySelector("#inputTitle")?.textContent || ""
    }))()`);

    await send(ws, "Runtime.evaluate", {
      expression: `(() => {
        document.querySelector("#addHoldingBtn")?.click();
        let value = "";
        for (const character of "00919") {
          value += character;
          const ticker = document.querySelector("#holdingEditor .holding-row:last-child [data-field='ticker']");
          ticker.value = value;
          ticker.dispatchEvent(new Event("input", { bubbles: true }));
        }
      })()`
    });
    await wait(300);
    await send(ws, "Runtime.evaluate", {
      expression: `(() => {
        const amount = document.querySelector("#holdingEditor .holding-row:last-child [data-holding-amount]");
        amount.value = "10000";
        amount.dispatchEvent(new Event("input", { bubbles: true }));
      })()`
    });
    await wait(250);
    const simpleHoldingEditor = await evalValue(ws, `(() => {
      const row = document.querySelector("#holdingEditor .holding-row:last-child");
      const holding = state.holdings[state.holdings.length - 1];
      return {
        addButtonLabel: document.querySelector("#addHoldingBtn")?.textContent.trim() || "",
        primaryInputCount: row?.querySelectorAll(".holding-primary input").length || 0,
        ticker: row?.querySelector('[data-field="ticker"]')?.value || "",
        amount: Number(row?.querySelector("[data-holding-amount]")?.value || 0),
        identity: row?.querySelector(".holding-identity")?.innerText || "",
        advancedOpen: row?.querySelector(".holding-advanced")?.open || false,
        typeLocked: row?.querySelector('[data-field="type"]')?.disabled || false,
        yieldLocked: row?.querySelector('[data-field="dividendYield"]')?.readOnly || false,
        storedAmount: Number(holding?.amount || 0),
        lotAmount: Number(holding?.lots?.[0]?.amount || 0),
        bodyOverflow: Math.max(0, document.body.scrollWidth - document.documentElement.clientWidth)
      };
    })()`);
    await send(ws, "Runtime.evaluate", {
      expression: `document.querySelector("#holdingEditor .holding-row:last-child [data-remove]")?.click()`
    });
    await wait(200);

    await send(ws, "Runtime.evaluate", { expression: `showToast("通知不遮擋內容")` });
    await wait(100);
    const notificationBehavior = await evalValue(ws, `(() => ({
      desktopToastCount: document.querySelectorAll("body > .toast").length,
      headerNotification: document.querySelector("#headerStatus")?.classList.contains("is-notification") || false,
      headerText: document.querySelector("#headerStatus")?.textContent || "",
      bodyOverflow: Math.max(0, document.body.scrollWidth - document.documentElement.clientWidth)
    }))()`);
    await send(ws, "Runtime.evaluate", { expression: `clearToast()` });
    const notificationRestored = await evalValue(ws, `(() => ({
      desktopToastCount: document.querySelectorAll("body > .toast").length,
      headerNotification: document.querySelector("#headerStatus")?.classList.contains("is-notification") || false
    }))()`);

    await send(ws, "Runtime.evaluate", {
      expression: `(() => {
        const currentMonth = new Date().getMonth() + 1;
        const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1;
        document.querySelector('[data-select-month="' + nextMonth + '"]')?.click();
        const input = document.querySelector('#monthlyCashflowEditor [data-month-field="monthlyIncome"]');
        input.value = "1234";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      })()`
    });
    await wait(250);
    const monthSwitching = await evalValue(ws, `(() => {
      const currentMonth = new Date().getMonth() + 1;
      const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1;
      return {
        selectedMonth: Number(document.querySelector("#monthlyCashflowEditor .month-row")?.dataset.month || 0),
        expectedMonth: nextMonth,
        visibleMonthRows: document.querySelectorAll("#monthlyCashflowEditor .month-row").length,
        activeMonthTabs: document.querySelectorAll("#monthlyCashflowEditor .month-tab.is-active").length,
        activeHasData: document.querySelector("#monthlyCashflowEditor .month-tab.is-active")?.classList.contains("has-data") || false,
        status: document.querySelector("#selectedMonthStatus")?.textContent || "",
        storedMonth: Number(sessionStorage.getItem("cashflow-map-selected-month") || 0),
        bodyOverflow: Math.max(0, document.body.scrollWidth - document.documentElement.clientWidth)
      };
    })()`);
    await send(ws, "Runtime.evaluate", {
      expression: `(() => {
        const annualIncome = document.querySelector("#monthlyIncome");
        annualIncome.value = "43000";
        annualIncome.dispatchEvent(new Event("input", { bubbles: true }));
      })()`
    });
    await wait(200);
    const annualBudgetSync = await evalValue(ws, `(() => {
      const currentMonth = new Date().getMonth() + 1;
      const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1;
      const result = {
        currentMonthIncome: Number(state.monthlyCashflows[currentMonth]?.monthlyIncome || 0),
        overriddenMonthIncome: Number(state.monthlyCashflows[nextMonth]?.monthlyIncome || 0)
      };
      const annualIncome = document.querySelector("#monthlyIncome");
      annualIncome.value = "42000";
      annualIncome.dispatchEvent(new Event("input", { bubbles: true }));
      return result;
    })()`);
    const detailedValidationCleared = await evalValue(ws, `(() => {
      state.profile.monthlyIncome = 42000;
      state.profile.fixedExpense = 33000;
      state.profile.cashSavings = 100000;
      state.inputCompletion.profile = {};
      state.consent.accepted = true;
      showValidationErrors("#profileValidationErrors", detailedValidationErrors());
      return document.querySelector("#profileValidationErrors")?.hidden === true;
    })()`);
    await send(ws, "Runtime.evaluate", {
      expression: `document.querySelector('[data-select-month="' + (new Date().getMonth() + 1) + '"]')?.click()`
    });
    await send(ws, "Runtime.evaluate", { expression: `window.goTo("landingView")` });
    await wait(250);

    await fillStep("#quizIncome", "42000");
    await fillStep("#quizExpense", "33000");
    await fillStep("#quizSavings", "80000");
    await send(ws, "Runtime.evaluate", { expression: `document.querySelector('[data-pressure="some"]').click(); document.querySelector('.flow-step.is-active [data-flow-next]').click();` });
    await wait(350);
    await send(ws, "Runtime.evaluate", { expression: `document.querySelector('[data-concern="allocation"]').click(); document.querySelector('.flow-step.is-active [data-flow-next]').click();` });
    await wait(350);
    const consentStep = await evalValue(ws, `(() => ({
      step: document.querySelector(".flow-step.is-active")?.dataset.flowStep,
      progress: document.querySelector("#flowProgressText")?.textContent,
      consentVisible: Boolean(document.querySelector("#dataConsent"))
    }))()`);

    await send(ws, "Runtime.evaluate", {
      expression: `(() => {
        const consent = document.querySelector("#dataConsent");
        consent.checked = true;
        consent.dispatchEvent(new Event("change", { bubbles: true }));
        document.querySelector("#quickGenerateBtn").click();
      })()`
    });
    await wait(1200);
    const freeReport = await evalValue(ws, `(() => {
      const text = document.querySelector("#freeReport")?.innerText || "";
      const workspaceNav = document.querySelector("#freeReport > .workspace-nav");
      return {
        activeView: document.querySelector(".view.is-active")?.id,
        hasWorkspaceNav: Boolean(workspaceNav),
        workspaceNavDisplay: workspaceNav ? getComputedStyle(workspaceNav).display : "missing",
        hasMissingEtfPrompt: text.includes("需先填 ETF 部位") && text.includes("補 ETF 部位配置"),
        hasPrescription: text.includes("本月最該做的 3 件事"),
        hasFirstAction: text.includes("先處理"),
        hasAllocation: text.includes("月投入配置"),
        hasAvoid: text.includes("先不要做"),
        hasNumbers: /5,000|10,000|NT|\\$/.test(text),
        hasLineSyncPanel: Boolean(document.querySelector("#freeReport .line-sync-panel")),
        hasLineBindingAction: Boolean(document.querySelector("#freeReport #createLineBindingBtn")),
        hasHeaderSalesButton: Boolean(document.querySelector("#freeReportView > .section-title [data-goto='upgradeView']")),
        cashflowMetricCount: document.querySelectorAll("#freeReport .report-cashflow-grid article").length,
        upgradeButtonCount: document.querySelectorAll("#freeReport .report-upgrade-cta [data-goto='upgradeView']").length,
        scoreOrder: [...document.querySelectorAll("#freeReport [data-report-block]")].findIndex((item) => item.dataset.reportBlock === "score"),
        cashflowOrder: [...document.querySelectorAll("#freeReport [data-report-block]")].findIndex((item) => item.dataset.reportBlock === "cashflow"),
        actionsOrder: [...document.querySelectorAll("#freeReport [data-report-block]")].findIndex((item) => item.dataset.reportBlock === "actions"),
        upgradeOrder: [...document.querySelectorAll("#freeReport [data-report-block]")].findIndex((item) => item.dataset.reportBlock === "upgrade"),
        detailPanelShadow: getComputedStyle(document.querySelector("#freeReport .report-detail-stack .panel")).boxShadow,
        bodyOverflow: Math.max(0, document.body.scrollWidth - document.documentElement.clientWidth)
      };
    })()`);

    await send(ws, "Runtime.evaluate", {
      expression: `(() => {
        const month = String(new Date().getMonth() + 1).padStart(2, "0");
        const summary = {
          linked: true,
          month: new Date().getFullYear() + "-" + month,
          income: 50000,
          investmentIncome: 800,
          expense: 65,
          investment: 10000,
          counts: { income: 1, expense: 1, investment: 1, investment_income: 1 },
          incomeCategories: [{ category: "本薪", amount: 50000, count: 1 }],
          expenseCategories: [{ category: "伙食", amount: 65, count: 1 }],
          etfPositions: [{ ticker: "0056", amount: 10000, count: 1 }],
          recentEntries: [
            {
              type: "investment_income",
              amount: 800,
              ticker: "0056",
              note: "配息",
              occurredAt: new Date().toISOString()
            },
            {
              type: "investment",
              amount: 10000,
              ticker: "0056",
              note: "0056",
              occurredAt: new Date().toISOString()
            }
          ],
          entries: []
        };
        summary.entries = summary.recentEntries.map((entry, index) => ({ ...entry, id: "00000000-0000-4000-8000-00000000000" + index }));
        state.reportMeta.lineSummary = summary;
        applyLineSummaryToState(summary);
        applyLineSummaryToState(summary);
        refreshReports();
      })()`
    });
    await wait(350);
    const lineApplied = await evalValue(ws, `(() => {
      const month = new Date().getMonth() + 1;
      const row = document.querySelector('.month-row[data-month="' + month + '"]');
      const holdingRows = [...document.querySelectorAll("#holdingEditor .holding-row")];
      const holding = holdingRows.find((item) => item.querySelector('[data-field="ticker"]')?.value === "0056");
      return {
        income: Number(row?.querySelector('[data-month-field="monthlyIncome"]')?.value || 0),
        expense: Number(row?.querySelector('[data-month-field="fixedExpense"]')?.value || 0),
        investment: Number(row?.querySelector('[data-month-field="monthlyInvestment"]')?.value || 0),
        ticker: holding?.querySelector('[data-field="ticker"]')?.value || "",
        lineLots: holding?.querySelectorAll(".lot-row.is-line-synced").length || 0,
        lineAmount: Number(holding?.querySelector('.lot-row.is-line-synced [data-lot-field="amount"]')?.value || 0),
        recentEntries: document.querySelectorAll("#freeReport .ledger-entry-row").length,
        categoryBreakdowns: document.querySelectorAll("#freeReport .ledger-breakdowns details").length,
        privacyDelete: Boolean(document.querySelector("#freeReport #deleteLineDataBtn"))
      };
    })()`);

    await send(ws, "Runtime.evaluate", {
      expression: `(() => {
        document.body.dataset.memberAuth = "ready";
        window.goTo("dashboardView", "", "overview");
        renderDashboard();
      })()`
    });
    await wait(350);
    const dashboard = await evalValue(ws, `(() => ({
      activeView: document.querySelector(".view.is-active")?.id,
      period: document.querySelector("#dashboardPeriod")?.textContent || "",
      income: document.querySelector('[data-dashboard-metric="income"] strong')?.textContent || "",
      investmentIncome: document.querySelector('[data-dashboard-metric="investment-income"] strong')?.textContent || "",
      expense: document.querySelector('[data-dashboard-metric="expense"] strong')?.textContent || "",
      investment: document.querySelector('[data-dashboard-metric="investment"] strong')?.textContent || "",
      remaining: document.querySelector('[data-dashboard-metric="remaining"] strong')?.textContent || "",
      budgetRemaining: document.querySelector('.dashboard-budget-comparison > div:nth-child(1) strong')?.textContent || "",
      actualRemaining: document.querySelector('.dashboard-budget-comparison > div:nth-child(2) strong')?.textContent || "",
      variance: document.querySelector('.dashboard-budget-comparison > div:nth-child(3) strong')?.textContent || "",
      recentEntries: document.querySelectorAll("#dashboardRecentEntries .dashboard-entry").length,
      recentAmounts: [...document.querySelectorAll("#dashboardRecentEntries .dashboard-entry strong")].map((item) => item.textContent || ""),
      reminderCount: document.querySelectorAll(".dashboard-reminder").length,
      categoryBreakdowns: document.querySelectorAll("#dashboardRecentEntries .ledger-breakdowns details").length,
      expenseCategorySummaryRows: document.querySelectorAll("#dashboardRecentEntries .expense-category-bar").length,
      expenseCategorySummaryText: document.querySelector("#dashboardRecentEntries .expense-category-overview")?.innerText || "",
      budgetComparison: document.querySelectorAll(".dashboard-budget-comparison > div").length,
      bottomNavCount: document.querySelectorAll(".member-nav-item").length,
      bottomNavDisplay: getComputedStyle(document.querySelector(".member-bottom-nav")).display,
      activeBottomTabs: document.querySelectorAll(".member-nav-item.is-active").length,
      activeBottomLabel: document.querySelector(".member-nav-item.is-active span:last-child")?.textContent || "",
      headerHeight: Math.round(document.querySelector(".brand-nav")?.getBoundingClientRect().height || 0),
      bodyOverflow: Math.max(0, document.body.scrollWidth - document.documentElement.clientWidth)
    }))()`);

    await send(ws, "Runtime.evaluate", {
      expression: `document.querySelector('[data-member-nav="ledger"]')?.click()`
    });
    await wait(350);
    const ledgerNavigation = await evalValue(ws, `(() => ({
      activeView: document.querySelector(".view.is-active")?.id,
      activeBottomTabs: document.querySelectorAll(".member-nav-item.is-active").length,
      activeBottomLabel: document.querySelector(".member-nav-item.is-active span:last-child")?.textContent || ""
    }))()`);

    await send(ws, "Runtime.evaluate", {
      expression: `document.querySelector('[data-member-nav="invest"]')?.click()`
    });
    await wait(750);
    const workspaceJump = await evalValue(ws, `(() => ({
      activeView: document.querySelector(".view.is-active")?.id,
      hasEtfSection: Boolean(document.querySelector("#etfAllocationSection")),
      hasHoldingEditor: Boolean(document.querySelector("#holdingEditor")),
      hasBackHome: Boolean(document.querySelector('#inputView [data-goto="landingView"]')),
      hasDashboardReturn: Boolean(document.querySelector('#inputView [data-goto="dashboardView"]')),
      activeWorkspaceTabs: document.querySelectorAll('#inputView .workspace-tab.is-active').length,
      activeWorkspaceLabel: document.querySelector('#inputView .workspace-tab.is-active')?.textContent?.trim() || "",
      bodyOverflow: Math.max(0, document.body.scrollWidth - document.documentElement.clientWidth)
    }))()`);

    await send(ws, "Runtime.evaluate", {
      expression: `(() => {
        const savedSummary = state.reportMeta.lineSummary;
        state.reportMeta.lineSummary = {
          ...savedSummary,
          income: 0,
          investmentIncome: 0,
          expense: 0,
          investment: 0,
          counts: { income: 0, expense: 0, investment: 0, investment_income: 0 },
          entries: [],
          recentEntries: []
        };
        renderDashboard();
        window.__emptyActualDashboard = {
          status: document.querySelector('.dashboard-mode-note .dashboard-status')?.textContent || "",
          metrics: [...document.querySelectorAll('.dashboard-metric strong')].map((item) => item.textContent || ""),
          actualRemaining: document.querySelector('.dashboard-budget-comparison > div:nth-child(2) strong')?.textContent || "",
          variance: document.querySelector('.dashboard-budget-comparison > div:nth-child(3) strong')?.textContent || "",
          ledgerStatus: document.querySelector('#dashboardRecentEntries .dashboard-status')?.textContent || ""
        };
        state.reportMeta.lineSummary = {
          ...savedSummary,
          income: 0,
          investmentIncome: 0,
          expense: 1065,
          investment: 0,
          counts: { income: 0, expense: 2, investment: 0, investment_income: 0 },
          expenseCategories: [{ category: "伙食", amount: 1000, count: 1 }, { category: "交通", amount: 65, count: 1 }],
          entries: [],
          recentEntries: []
        };
        renderDashboard();
        window.__expenseOnlyDashboard = {
          income: document.querySelector('[data-dashboard-metric="income"] strong')?.textContent || "",
          incomeNote: document.querySelector('[data-dashboard-metric="income"] small')?.textContent || "",
          variance: document.querySelector('.dashboard-budget-comparison > div:nth-child(3) strong')?.textContent || "",
          varianceNote: document.querySelector('.dashboard-budget-comparison > div:nth-child(3) small')?.textContent || "",
          categoryRows: document.querySelectorAll('#dashboardRecentEntries .expense-category-bar').length
        };
        state.reportMeta.lineSummary = savedSummary;
        renderDashboard();
      })()`
    });
    const emptyActualDashboard = await evalValue(ws, "window.__emptyActualDashboard");
    const expenseOnlyDashboard = await evalValue(ws, "window.__expenseOnlyDashboard");
    await send(ws, "Runtime.evaluate", {
      expression: `(() => {
        authState = { ...authState, authenticated: true, user: { ...(authState.user || {}), onboardingCompleted: true } };
        document.querySelector('.site-links [data-focus-section="solutionPanel"]')?.click();
      })()`
    });
    await wait(450);
    const headerNavigation = await evalValue(ws, `(() => ({
      activeView: document.querySelector(".view.is-active")?.id,
      solutionVisible: document.querySelector("#solutionPanel")?.offsetParent !== null,
      bookingConfigured: document.querySelector('.site-links [data-focus-section="contactPanel"]')?.dataset.goto === "landingView",
      homeButtonCount: document.querySelectorAll('[data-goto="landingView"]').length
    }))()`);

    await send(ws, "Runtime.evaluate", { expression: `window.goTo("freeReportView", "", "report")` });
    await send(ws, "Runtime.evaluate", {
      expression: `document.querySelector('#freeReport .report-upgrade-cta [data-goto="upgradeView"]')?.click()`
    });
    await wait(350);
    const upgradeNavigation = await evalValue(ws, `(() => ({
      activeView: document.querySelector(".view.is-active")?.id,
      backButtonCount: document.querySelectorAll('#upgradeView [data-upgrade-back]').length,
      prices: [...document.querySelectorAll("#upgradeView .plan-card .price")].map((item) => item.textContent.trim()),
      hasFreeActionButton: Boolean(document.querySelector('#upgradeView [data-plan="free"]')),
      freeStatus: document.querySelector("#upgradeView .plan-card .plan-status")?.textContent.trim() || "",
      consultingPrice: [...document.querySelectorAll("#upgradeView .plan-card")].find((card) => card.querySelector("h3")?.textContent.includes("一對一"))?.querySelector(".price")?.textContent.trim() || "",
      consultingAction: document.querySelector('#upgradeView [data-plan="consulting"]')?.textContent.trim() || "",
      fullReportAction: document.querySelector('#upgradeView [data-plan="paid"]')?.textContent.trim() || "",
      disabledPaymentButtons: document.querySelectorAll('#upgradeView [data-plan]:disabled').length,
      hasLinePayPendingNotice: document.querySelector("#upgradeView")?.innerText.includes("LINE Pay 商店資料申請中") || false,
      hasNoChargeNotice: document.querySelector("#upgradeView")?.innerText.includes("不會建立訂單或收取款項") || false,
      hasDepositInclusion: document.querySelector("#upgradeView")?.innerText.includes("訂金 NT$200 已包含在總費用內") || false,
      hasBalance: document.querySelector("#upgradeView")?.innerText.includes("尾款 NT$1,300") || false,
      hasUnconfiguredLine: document.querySelector("#upgradeView")?.innerText.includes("LINE 尚未設定") || false,
      lineBookingCount: [...document.querySelectorAll("#upgradeView .consultation-booking-panel a")].filter((item) => item.textContent.includes("LINE")).length,
      igBookingCount: [...document.querySelectorAll("#upgradeView .consultation-booking-panel a")].filter((item) => item.textContent.includes("IG")).length,
      bodyOverflow: Math.max(0, document.body.scrollWidth - document.documentElement.clientWidth)
    }))()`);
    await send(ws, "Runtime.evaluate", {
      expression: `document.querySelector('#upgradeView .upgrade-return-actions [data-upgrade-back]')?.click()`
    });
    await wait(750);
    const upgradeReturn = await evalValue(ws, `(() => ({
      activeView: document.querySelector(".view.is-active")?.id,
      activeWorkspaceTabs: document.querySelectorAll('#inputView .workspace-tab.is-active').length,
      activeWorkspaceLabel: document.querySelector('#inputView .workspace-tab.is-active')?.textContent?.trim() || ""
    }))()`);

    await send(ws, "Runtime.evaluate", { expression: `document.body.dataset.appReady = "reloading"` });
    await send(ws, "Page.reload", { ignoreCache: true });
    await waitForPageReady(ws);
    await wait(1000);
    const f5Persistence = await evalValue(ws, `(() => ({
      activeView: document.querySelector(".view.is-active")?.id,
      reportId: state.reportMeta?.reportId || null,
      hasSessionAccess: Boolean(state.reportMeta?.accessCode),
      income: Number(document.querySelector("#monthlyIncome")?.value || 0)
    }))()`);

    await send(ws, "Runtime.evaluate", { expression: `window.goTo("dashboardView", "", "overview")` });
    await send(ws, "Page.reload", { ignoreCache: true });
    await waitForPageReady(ws);
    await wait(1000);
    const dashboardF5Persistence = await evalValue(ws, `(() => ({
      activeView: document.querySelector(".view.is-active")?.id,
      activeBottomTabs: document.querySelectorAll(".member-nav-item.is-active").length,
      activeBottomLabel: document.querySelector(".member-nav-item.is-active span:last-child")?.textContent || "",
      hasMetrics: document.querySelectorAll("#dashboardView .dashboard-metric").length === 5,
      bodyOverflow: Math.max(0, document.body.scrollWidth - document.documentElement.clientWidth)
    }))()`);

    await send(ws, "Runtime.evaluate", {
      expression: `window.goTo("databaseView")`
    });
    for (let i = 0; i < 12; i++) {
      const rows = await evalValue(ws, `document.querySelectorAll("#etfDatabaseTable tbody tr").length`);
      if (rows > 0) break;
      await wait(500);
    }
    const database = await evalValue(ws, `(() => ({
      activeView: document.querySelector(".view.is-active")?.id,
      etfRows: document.querySelectorAll("#etfDatabaseTable tbody tr").length,
      bodyOverflow: Math.max(0, document.body.scrollWidth - document.documentElement.clientWidth)
    }))()`);

    if (screenshotPath) {
      await send(ws, "Runtime.evaluate", {
        expression: `(() => {
          const viewId = ${JSON.stringify(screenshotView)};
          const sectionId = ${JSON.stringify(screenshotSection)};
          if (viewId === "dashboardView") document.body.dataset.memberAuth = "ready";
          window.goTo(viewId, sectionId);
          if (sectionId === "etfAllocationSection" && !document.querySelector("#holdingEditor .holding-row")) {
            document.querySelector("#sampleBtn")?.click();
            document.querySelector(".toast")?.remove();
          }
          if (sectionId) scrollToWorkspaceSection(sectionId);
        })()`
      });
      await wait(500);
      const shot = await send(ws, "Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      fs.writeFileSync(screenshotPath, Buffer.from(shot.data, "base64"));
    }

    const failedApiResponses = await evalValue(ws, "window.__smokeFailedApiResponses || []");
    const result = {
      url: targetUrl,
      viewport: `${viewportWidth}x${viewportHeight} ${mobileViewport ? "mobile" : "desktop"}`,
      consoleErrors,
      runtimeErrors,
      failedRequests: failures,
      badResponses,
      failedApiResponses,
      landing,
      requiredValidation,
      advancedInput,
      simpleHoldingEditor,
      notificationBehavior,
      notificationRestored,
      monthSwitching,
      annualBudgetSync,
      detailedValidationCleared,
      consentStep,
      freeReport,
      lineApplied,
      dashboard,
      emptyActualDashboard,
      expenseOnlyDashboard,
      ledgerNavigation,
      workspaceJump,
      headerNavigation,
      upgradeNavigation,
      upgradeReturn,
      f5Persistence,
      dashboardF5Persistence,
      database,
      passed: consoleErrors.length === 0
        && runtimeErrors.length === 0
        && failures.length === 0
        && badResponses.length === 0
        && landing.activeView === "landingView"
        && landing.brand === "Chen Dino"
        && landing.heroTitle.includes("掌握本月現金流")
        && landing.hasPain
        && landing.hasSolution
        && landing.hasFlow
        && landing.hasServices
        && landing.hasTestimonials
        && landing.hasCta
        && landing.hasMotionStage
        && landing.hasMotionCards
        && landing.hasAdvancedInputEntry
        && landing.hasIg
        && landing.headerStatus === "個人現金流管理"
        && landing.painKicker === "常見現金流困境"
        && landing.painTitle === "複雜的財務資訊，往往使決策失去優先順序"
        && landing.solutionTitle === "依序完成資料輸入，逐步建立現金流分析"
        && landing.quickCheckTitle === "現金流基礎評估"
        && landing.serviceTitle === "從基礎健檢到完整規劃，依需求取得合適分析"
        && landing.testimonialTitle === "清楚的分析流程，協助使用者掌握下一步"
        && landing.contactTitle === "進一步釐清您的現金流與資產配置"
        && landing.formQuestionTitles.join("|") === [
          "請填寫每月平均收入",
          "請估算每月必要支出",
          "請填寫目前可運用存款",
          "請評估貸款與保險支出壓力",
          "請選擇目前優先改善的財務目標",
          "確認資料保存並產生健檢報告"
        ].join("|")
        && landing.memberTitles.join("|") === [
          "本月總覽",
          "家庭財務資料",
          "現金流健檢報告",
          "專業分析方案",
          "完整財務分析報告",
          "資產成長模擬",
          "現金流與配息月曆"
        ].join("|")
        && !landing.internalCopyLeaked
        && landing.headerHeight <= (mobileViewport ? 66 : 78)
        && (!mobileViewport || landing.heroFontSize === 40)
        && (!mobileViewport || landing.heroContentTopGap <= 80)
        && landing.heroProofDisplay === (mobileViewport ? "none" : "grid")
        && landing.heroActionsDisplay === (mobileViewport ? "grid" : "flex")
        && landing.gateEyebrowColor === "rgb(18, 101, 78)"
        && landing.heroEyebrowColor === "rgb(185, 243, 222)"
        && landing.bodyOverflow === 0
        && requiredValidation.step === "1"
        && requiredValidation.errorsVisible
        && requiredValidation.errorCount >= 1
        && advancedInput.activeView === "inputView"
        && advancedInput.hasMonthlyEditor
        && advancedInput.visibleMonthRows === 1
        && advancedInput.monthTabCount === 12
        && advancedInput.activeMonthTabs === 1
        && advancedInput.activeMonth === new Date().getMonth() + 1
        && advancedInput.hasHoldingEditor
        && advancedInput.panelBackdrop === "none"
        && advancedInput.title.includes("家庭財務資料")
        && simpleHoldingEditor.addButtonLabel.includes("新增部位")
        && simpleHoldingEditor.primaryInputCount === 2
        && simpleHoldingEditor.ticker === "00919"
        && simpleHoldingEditor.amount === 10000
        && simpleHoldingEditor.identity.includes("系統已帶入")
        && !simpleHoldingEditor.identity.includes("等待輸入代號")
        && !simpleHoldingEditor.advancedOpen
        && simpleHoldingEditor.typeLocked
        && !simpleHoldingEditor.yieldLocked
        && simpleHoldingEditor.identity.includes("配息資料待更新")
        && simpleHoldingEditor.storedAmount === 10000
        && simpleHoldingEditor.lotAmount === 10000
        && simpleHoldingEditor.bodyOverflow === 0
        && (!mobileViewport || notificationBehavior.headerText.includes("通知不遮擋內容"))
        && notificationBehavior.desktopToastCount === (mobileViewport ? 0 : 1)
        && notificationBehavior.headerNotification === mobileViewport
        && notificationBehavior.bodyOverflow === 0
        && notificationRestored.desktopToastCount === 0
        && !notificationRestored.headerNotification
        && monthSwitching.selectedMonth === monthSwitching.expectedMonth
        && monthSwitching.visibleMonthRows === 1
        && monthSwitching.activeMonthTabs === 1
        && monthSwitching.activeHasData
        && monthSwitching.status === "本月已調整"
        && monthSwitching.storedMonth === monthSwitching.expectedMonth
        && monthSwitching.bodyOverflow === 0
        && annualBudgetSync.currentMonthIncome === 43000
        && annualBudgetSync.overriddenMonthIncome === 1234
        && detailedValidationCleared
        && consentStep.step === "6"
        && consentStep.consentVisible
        && freeReport.activeView === "freeReportView"
        && freeReport.hasWorkspaceNav
        && (mobileViewport ? freeReport.workspaceNavDisplay === "none" : freeReport.workspaceNavDisplay !== "none")
        && freeReport.hasMissingEtfPrompt
        && freeReport.hasPrescription
        && freeReport.hasFirstAction
        && freeReport.hasAllocation
        && freeReport.hasAvoid
        && freeReport.hasNumbers
        && freeReport.hasLineSyncPanel
        && freeReport.hasLineBindingAction
        && !freeReport.hasHeaderSalesButton
        && freeReport.cashflowMetricCount === 4
        && freeReport.upgradeButtonCount === 1
        && freeReport.scoreOrder >= 0
        && freeReport.cashflowOrder > freeReport.scoreOrder
        && freeReport.actionsOrder > freeReport.cashflowOrder
        && freeReport.upgradeOrder > freeReport.actionsOrder
        && freeReport.detailPanelShadow === "none"
        && freeReport.bodyOverflow === 0
        && lineApplied.income === 42000
        && lineApplied.expense === 33000
        && lineApplied.investment === 8000
        && lineApplied.ticker === "0056"
        && lineApplied.lineLots === 1
        && lineApplied.lineAmount === 10000
        && lineApplied.recentEntries === 2
        && lineApplied.categoryBreakdowns === 2
        && lineApplied.privacyDelete
        && dashboard.activeView === "dashboardView"
        && dashboard.period.includes("年")
        && /50,000/.test(dashboard.income)
        && /800/.test(dashboard.investmentIncome)
        && /65/.test(dashboard.expense)
        && /10,000/.test(dashboard.investment)
        && /40,735/.test(dashboard.remaining)
        && /1,000/.test(dashboard.budgetRemaining)
        && /40,735/.test(dashboard.actualRemaining)
        && /39,735/.test(dashboard.variance)
        && dashboard.recentEntries === 2
        && dashboard.recentAmounts.some((value) => /\+.*800/.test(value))
        && dashboard.recentAmounts.some((value) => /−.*10,000/.test(value))
        && dashboard.reminderCount >= 1
        && dashboard.categoryBreakdowns === 2
        && dashboard.expenseCategorySummaryRows === 1
        && dashboard.expenseCategorySummaryText.includes("伙食")
        && dashboard.expenseCategorySummaryText.includes("100%")
        && dashboard.budgetComparison === 3
        && dashboard.bottomNavCount === 5
        && dashboard.bottomNavDisplay === (mobileViewport ? "grid" : "none")
        && dashboard.activeBottomTabs === 1
        && dashboard.activeBottomLabel === "總覽"
        && dashboard.headerHeight <= 66
        && dashboard.bodyOverflow === 0
        && emptyActualDashboard.status === "本月尚無實際帳"
        && emptyActualDashboard.metrics.length === 5
        && emptyActualDashboard.metrics.every((value) => value === "—")
        && emptyActualDashboard.actualRemaining === "尚無實際帳"
        && emptyActualDashboard.variance === "開始記帳後顯示"
        && emptyActualDashboard.ledgerStatus === "本月無資料"
        && expenseOnlyDashboard.income === "尚未記錄"
        && expenseOnlyDashboard.incomeNote.includes("未自動帶入")
        && expenseOnlyDashboard.variance === "等待實際收入後比較"
        && expenseOnlyDashboard.varianceNote.includes("不會自動帶入實際帳")
        && expenseOnlyDashboard.categoryRows === 2
        && ledgerNavigation.activeView === "dashboardView"
        && ledgerNavigation.activeBottomTabs === 1
        && ledgerNavigation.activeBottomLabel === "記帳"
        && workspaceJump.activeView === "inputView"
        && workspaceJump.hasEtfSection
        && workspaceJump.hasHoldingEditor
        && workspaceJump.hasBackHome
        && workspaceJump.hasDashboardReturn
        && workspaceJump.activeWorkspaceTabs === 1
        && workspaceJump.activeWorkspaceLabel === "ETF 部位配置"
        && workspaceJump.bodyOverflow === 0
        && headerNavigation.activeView === "dashboardView"
        && !headerNavigation.solutionVisible
        && headerNavigation.bookingConfigured
        && headerNavigation.homeButtonCount >= 3
        && upgradeNavigation.activeView === "upgradeView"
        && upgradeNavigation.backButtonCount === 2
        && JSON.stringify(upgradeNavigation.prices) === JSON.stringify(["NT$0", "NT$499", "NT$1,500"])
        && !upgradeNavigation.hasFreeActionButton
        && upgradeNavigation.freeStatus === "目前方案"
        && upgradeNavigation.consultingPrice === "NT$1,500"
        && upgradeNavigation.consultingAction === "LINE Pay 申請中"
        && upgradeNavigation.fullReportAction === "LINE Pay 申請中"
        && upgradeNavigation.disabledPaymentButtons === 2
        && upgradeNavigation.hasLinePayPendingNotice
        && upgradeNavigation.hasNoChargeNotice
        && upgradeNavigation.hasDepositInclusion
        && upgradeNavigation.hasBalance
        && !upgradeNavigation.hasUnconfiguredLine
        && upgradeNavigation.lineBookingCount === 0
        && upgradeNavigation.igBookingCount === 1
        && upgradeNavigation.bodyOverflow === 0
        && upgradeReturn.activeView === "freeReportView"
        && upgradeReturn.activeWorkspaceTabs === 1
        && upgradeReturn.activeWorkspaceLabel === "健檢結果"
        && f5Persistence.activeView === "freeReportView"
        && Boolean(f5Persistence.reportId)
        && f5Persistence.hasSessionAccess
        && f5Persistence.income === 42000
        && dashboardF5Persistence.activeView === "dashboardView"
        && dashboardF5Persistence.activeBottomTabs === 1
        && dashboardF5Persistence.activeBottomLabel === "總覽"
        && dashboardF5Persistence.hasMetrics
        && dashboardF5Persistence.bodyOverflow === 0
        && database.activeView === "databaseView"
        && database.etfRows > 0
        && database.bodyOverflow === 0
    };
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.passed ? 0 : 1);
  } finally {
    if (chromeProcess && !chromeProcess.killed) chromeProcess.kill();
    if (serverProcess && !serverProcess.killed) serverProcess.kill();
    await wait(300);
    if (customerDataDir) fs.rmSync(customerDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
