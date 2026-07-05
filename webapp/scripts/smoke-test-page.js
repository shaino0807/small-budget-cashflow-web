const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const targetUrl = process.argv[2] || "http://127.0.0.1:5188/";
const shouldServe = process.argv.includes("--serve");
const screenshotArg = process.argv.find((arg) => arg.startsWith("--screenshot="));
const screenshotPath = screenshotArg ? path.resolve(screenshotArg.slice("--screenshot=".length)) : "";
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
          CUSTOMER_DATA_DIR: customerDataDir,
          CUSTOMER_DATA_KEY: crypto.randomBytes(32).toString("base64"),
          ACCESS_CODE_PEPPER: crypto.randomBytes(24).toString("base64url"),
          ADMIN_API_KEY: crypto.randomBytes(24).toString("base64url")
        },
        windowsHide: true,
        stdio: "ignore"
      });
      await waitForHttp("http://127.0.0.1:5188/");
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
      "--window-size=390,844",
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
        failures.push(message.params.errorText || message.params.blockedReason || "loadingFailed");
      }
      if (message.method === "Network.responseReceived") {
        const status = message.params.response.status;
        if (status >= 400) {
          badResponses.push({ status, url: message.params.response.url });
        }
      }
    });

    await send(ws, "Runtime.enable");
    await send(ws, "Network.enable");
    await send(ws, "Page.enable");
    await send(ws, "Log.enable");
    await send(ws, "Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true
    });
    await send(ws, "Emulation.setUserAgentOverride", {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    });

    await send(ws, "Page.navigate", { url: targetUrl });
    await wait(4500);
    const inputMetrics = await send(ws, "Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => ({
        currentUrl: location.href,
        title: document.title,
        activeView: document.querySelector('.view.is-active')?.id,
        header: document.querySelector('h1')?.textContent,
        heroTitle: document.querySelector('#landingTitle')?.textContent,
        quickCheckExists: Boolean(document.querySelector('#quickCheckPanel')),
        contactExists: Boolean(document.querySelector('#contactPanel')),
        tabCount: document.querySelectorAll('.tab').length,
        panelCount: document.querySelectorAll('.panel,.score-panel,.table-panel,.plan-card,.calendar-card').length,
        bodyOverflow: Math.max(0, document.body.scrollWidth - document.documentElement.clientWidth),
        htmlLength: document.body.innerText.length
      }))()`
    });
    await send(ws, "Runtime.evaluate", {
      expression: `localStorage.setItem('cashflow-map-web-state', JSON.stringify({
        paidUnlocked: true,
        consultingUnlocked: true,
        reportMeta: { entitlements: [] },
        anonymousId: crypto.randomUUID(),
        consent: { accepted: false, acceptedAt: null, contactChannel: 'none', contactValue: '' },
        profile: {},
        holdings: [],
        monthlyCashflows: {},
        inputCompletion: { profile: {}, stockAnswers: [] },
        leadProfile: {}
      }))`
    });
    await send(ws, "Page.navigate", { url: targetUrl });
    await wait(1800);
    const entitlementGuardMetrics = await send(ws, "Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => ({
        paidUnlocked: typeof state !== 'undefined' ? Boolean(state.paidUnlocked) : true,
        consultingUnlocked: typeof state !== 'undefined' ? Boolean(state.consultingUnlocked) : true,
        paidTabLocked: document.querySelector('.paid-tab')?.classList.contains('is-locked')
      }))()`
    });
    await send(ws, "Runtime.evaluate", {
      expression: `localStorage.removeItem('cashflow-map-web-state')`
    });
    await send(ws, "Page.navigate", { url: targetUrl });
    await wait(1800);
    await send(ws, "Runtime.evaluate", {
      expression: `document.querySelector('#quickGenerateBtn').click()`
    });
    await wait(200);
    const validationMetrics = await send(ws, "Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => ({
        activeView: document.querySelector('.view.is-active')?.id,
        quickErrorsVisible: !document.querySelector('#quickValidationErrors')?.hidden,
        quickErrorCount: document.querySelectorAll('#quickValidationErrors li').length
      }))()`
    });
    await send(ws, "Runtime.evaluate", {
      expression: `(() => {
        document.querySelector('.tab[data-view="inputView"]').click();
        document.querySelector('#generateBtn').click();
      })()`
    });
    await wait(200);
    const detailedValidationMetrics = await send(ws, "Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => ({
        activeView: document.querySelector('.view.is-active')?.id,
        errorsVisible: !document.querySelector('#profileValidationErrors')?.hidden,
        errorCount: document.querySelectorAll('#profileValidationErrors li').length
      }))()`
    });
    await send(ws, "Runtime.evaluate", {
      expression: `document.querySelector('.tab[data-view="landingView"]').click()`
    });
    if (screenshotPath) {
      const shot = await send(ws, "Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      fs.writeFileSync(screenshotPath, Buffer.from(shot.data, "base64"));
    }

    const landingLeadMetrics = await send(ws, "Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const text = document.body.innerText || '';
        return {
          activeView: document.querySelector('.view.is-active')?.id,
          hasIncomeQuestion: text.includes('1. 每月收入'),
          hasExpenseQuestion: text.includes('2. 每月必要支出'),
          hasSavingsQuestion: text.includes('3. 現在存款'),
          hasPressureQuestion: text.includes('4. 有沒有貸款 / 保險壓力'),
          hasConcernQuestion: text.includes('5. 最想解決什麼'),
          hasAllocationConcern: text.includes('錢不知道怎麼分'),
          hasRiskConcern: text.includes('怕亂投資'),
          hasLineCta: text.includes('LINE 傳我你的健檢結果，我幫你看第一步'),
          hasAllocationCta: text.includes('領「每月 5,000 / 10,000 分配表」'),
          hasConsultCta: text.includes('預約 30 分鐘現金流健檢'),
          hasDecisionCta: text.includes('我想知道我的錢該先存、先還，還是能投資'),
          keepsIgCta: text.includes('IG 看小資買股常見錯誤'),
          hidesStockRoute: !text.includes('做股票安全健檢'),
          noOldStockCta: !text.includes('這檔股票我能不能買') && !text.includes('每月 5,000 股票配置表') && !text.includes('單一個股上限試算'),
          bodyOverflow: Math.max(0, document.body.scrollWidth - document.documentElement.clientWidth)
        };
      })()`
    });

    await send(ws, "Runtime.evaluate", {
      expression: `(() => {
        document.querySelector('[data-goto="landingView"]')?.click();
        if (!document.querySelector('#landingView').classList.contains('is-active')) {
          document.querySelector('.tab[data-view="landingView"]').click();
        }
        document.querySelector('[data-check-type="cashflow"]').click();
      })()`
    });
    await send(ws, "Runtime.evaluate", {
      expression: `(() => {
        document.querySelector('[data-pressure="some"]').click();
        document.querySelector('[data-concern="family"]').click();
        document.querySelector('#quizIncome').value = '42000';
        document.querySelector('#quizIncome').dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#quizExpense').value = '33000';
        document.querySelector('#quizExpense').dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#quizSavings').value = '80000';
        document.querySelector('#quizSavings').dispatchEvent(new Event('input', { bubbles: true }));
        const consent = document.querySelector('#dataConsent');
        consent.checked = true;
        consent.dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('#quickGenerateBtn').click();
      })()`
    });
    await wait(800);
    const freeReportMetrics = await send(ws, "Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const text = document.querySelector('#freeReport')?.innerText || '';
        return {
          activeView: document.querySelector('.view.is-active')?.id,
          consentAccepted: Boolean(state.consent.accepted),
          incomeValue: document.querySelector('#quizIncome')?.value || '',
          expenseValue: document.querySelector('#quizExpense')?.value || '',
          savingsValue: document.querySelector('#quizSavings')?.value || '',
          validationText: document.querySelector('#quickValidationErrors')?.innerText || '',
          hasPrescription: text.includes('本月最該做的 3 件事'),
          hasFirstAction: text.includes('先處理'),
          hasAllocation: text.includes('月投入配置'),
          hasAvoid: text.includes('先不要做'),
          hasNumbers: /\\$|5,000|8,000|10,000|NT/.test(text),
          bodyOverflow: Math.max(0, document.body.scrollWidth - document.documentElement.clientWidth)
        };
      })()`
    });

    await send(ws, "Runtime.evaluate", {
      expression: `window.goTo ? window.goTo("upgradeView") : document.querySelector('.tab[data-view="upgradeView"]').click()`
    });
    await wait(300);
    const upgradeMetrics = await send(ws, "Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const text = document.querySelector('#upgradeView')?.innerText || '';
        const ig = document.querySelector('.consultation-booking-panel a[href*="instagram.com"]');
        const lineDisabled = document.querySelector('.consultation-booking-panel [aria-disabled="true"]');
        return {
          activeView: document.querySelector('.view.is-active')?.id,
          hasFullReport: text.includes('完整報告'),
          hasFullReportPrice: text.includes('499'),
          hasConsultationDeposit: text.includes('諮詢訂金') && text.includes('200'),
          hasConsultationFee: text.includes('諮詢費') && text.includes('1,500'),
          hasPaidButton: Boolean(document.querySelector('[data-plan="paid"]')),
          hasConsultingButton: Boolean(document.querySelector('[data-plan="consulting"]')),
          igHref: ig?.href || '',
          lineDisabled: Boolean(lineDisabled),
          noMockCopy: !/mock purchase|Mock/i.test(text),
          bodyOverflow: Math.max(0, document.body.scrollWidth - document.documentElement.clientWidth)
        };
      })()`
    });

    await send(ws, "Runtime.evaluate", {
      expression: `window.goTo ? window.goTo("databaseView") : document.querySelector('[data-goto="databaseView"]')?.click()`
    });
    for (let i = 0; i < 12; i++) {
      const rows = await send(ws, "Runtime.evaluate", {
        returnByValue: true,
        expression: `document.querySelectorAll('#etfDatabaseTable tbody tr').length`
      });
      if (rows.result.value > 0) break;
      await wait(500);
    }
    const databaseMetrics = await send(ws, "Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => ({
        activeView: document.querySelector('.view.is-active')?.id,
        summary: document.querySelector('#databaseSummary')?.textContent,
        dataQuality: document.querySelector('#dataQuality')?.innerText || '',
        classificationStrip: document.querySelector('.classification-strip')?.innerText || '',
        etfRows: document.querySelectorAll('#etfDatabaseTable tbody tr').length,
        bodyOverflow: Math.max(0, document.body.scrollWidth - document.documentElement.clientWidth)
      }))()`
    });
    const result = {
      url: targetUrl,
      viewport: "390x844 mobile",
      consoleErrors,
      runtimeErrors,
      failedRequests: failures,
      badResponses,
      input: inputMetrics.result.value,
      entitlementGuard: entitlementGuardMetrics.result.value,
      requiredValidation: validationMetrics.result.value,
      detailedValidation: detailedValidationMetrics.result.value,
      landingLead: landingLeadMetrics.result.value,
      freeReport: freeReportMetrics.result.value,
      upgrade: upgradeMetrics.result.value,
      database: databaseMetrics.result.value,
      passed: consoleErrors.length === 0
        && runtimeErrors.length === 0
        && failures.length === 0
        && badResponses.length === 0
        && inputMetrics.result.value.activeView === "landingView"
        && inputMetrics.result.value.quickCheckExists
        && inputMetrics.result.value.contactExists
        && inputMetrics.result.value.bodyOverflow === 0
        && entitlementGuardMetrics.result.value.paidUnlocked === false
        && entitlementGuardMetrics.result.value.consultingUnlocked === false
        && entitlementGuardMetrics.result.value.paidTabLocked === true
        && validationMetrics.result.value.activeView === "landingView"
        && validationMetrics.result.value.quickErrorsVisible
        && validationMetrics.result.value.quickErrorCount >= 4
        && detailedValidationMetrics.result.value.activeView === "inputView"
        && detailedValidationMetrics.result.value.errorsVisible
        && detailedValidationMetrics.result.value.errorCount >= 4
        && landingLeadMetrics.result.value.activeView === "landingView"
        && landingLeadMetrics.result.value.hasIncomeQuestion
        && landingLeadMetrics.result.value.hasExpenseQuestion
        && landingLeadMetrics.result.value.hasSavingsQuestion
        && landingLeadMetrics.result.value.hasPressureQuestion
        && landingLeadMetrics.result.value.hasConcernQuestion
        && landingLeadMetrics.result.value.hasAllocationConcern
        && landingLeadMetrics.result.value.hasRiskConcern
        && landingLeadMetrics.result.value.hasLineCta
        && landingLeadMetrics.result.value.hasAllocationCta
        && landingLeadMetrics.result.value.hasConsultCta
        && landingLeadMetrics.result.value.hasDecisionCta
        && landingLeadMetrics.result.value.keepsIgCta
        && landingLeadMetrics.result.value.hidesStockRoute
        && landingLeadMetrics.result.value.noOldStockCta
        && landingLeadMetrics.result.value.bodyOverflow === 0
        && freeReportMetrics.result.value.activeView === "freeReportView"
        && freeReportMetrics.result.value.hasPrescription
        && freeReportMetrics.result.value.hasFirstAction
        && freeReportMetrics.result.value.hasAllocation
        && freeReportMetrics.result.value.hasAvoid
        && freeReportMetrics.result.value.hasNumbers
        && freeReportMetrics.result.value.bodyOverflow === 0
        && upgradeMetrics.result.value.activeView === "upgradeView"
        && upgradeMetrics.result.value.hasFullReport
        && upgradeMetrics.result.value.hasFullReportPrice
        && upgradeMetrics.result.value.hasConsultationDeposit
        && upgradeMetrics.result.value.hasConsultationFee
        && upgradeMetrics.result.value.hasPaidButton
        && upgradeMetrics.result.value.hasConsultingButton
        && upgradeMetrics.result.value.igHref === "https://www.instagram.com/chendino080077/"
        && upgradeMetrics.result.value.lineDisabled
        && upgradeMetrics.result.value.noMockCopy
        && upgradeMetrics.result.value.bodyOverflow === 0
        && databaseMetrics.result.value.activeView === "databaseView"
        && databaseMetrics.result.value.bodyOverflow === 0
        && databaseMetrics.result.value.etfRows > 0
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
