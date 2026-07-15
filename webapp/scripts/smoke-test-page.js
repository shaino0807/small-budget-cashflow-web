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
      hasHoldingEditor: Boolean(document.querySelector("#holdingEditor")),
      title: document.querySelector("#inputTitle")?.textContent || ""
    }))()`);
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
      return {
        activeView: document.querySelector(".view.is-active")?.id,
        hasWorkspaceNav: text.includes("健檢結果") && text.includes("ETF 部位配置"),
        hasMissingEtfPrompt: text.includes("需先填 ETF 部位") && text.includes("補 ETF 部位配置"),
        hasPrescription: text.includes("本月最該做的 3 件事"),
        hasFirstAction: text.includes("先處理"),
        hasAllocation: text.includes("月投入配置"),
        hasAvoid: text.includes("先不要做"),
        hasNumbers: /5,000|10,000|NT|\\$/.test(text),
        hasLineSyncPanel: Boolean(document.querySelector("#freeReport .line-sync-panel")),
        hasLineBindingAction: Boolean(document.querySelector("#freeReport #createLineBindingBtn")),
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
          expense: 65,
          investment: 10000,
          counts: { income: 1, expense: 1, investment: 1 },
          etfPositions: [{ ticker: "0056", amount: 10000, count: 1 }],
          recentEntries: [{
            type: "investment",
            amount: 10000,
            ticker: "0056",
            note: "0056",
            occurredAt: new Date().toISOString()
          }]
        };
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
        recentEntries: document.querySelectorAll("#freeReport .line-recent-entries .kv").length
      };
    })()`);

    await send(ws, "Runtime.evaluate", {
      expression: `document.querySelector('#freeReport [data-focus-section="etfAllocationSection"]')?.click()`
    });
    await wait(750);
    const workspaceJump = await evalValue(ws, `(() => ({
      activeView: document.querySelector(".view.is-active")?.id,
      hasEtfSection: Boolean(document.querySelector("#etfAllocationSection")),
      hasHoldingEditor: Boolean(document.querySelector("#holdingEditor")),
      hasBackHome: Boolean(document.querySelector('#inputView [data-goto="landingView"]')),
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
      await send(ws, "Runtime.evaluate", { expression: `window.goTo("landingView")` });
      await wait(500);
      const shot = await send(ws, "Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      fs.writeFileSync(screenshotPath, Buffer.from(shot.data, "base64"));
    }

    const result = {
      url: targetUrl,
      viewport: "390x844 mobile",
      consoleErrors,
      runtimeErrors,
      failedRequests: failures,
      badResponses,
      landing,
      requiredValidation,
      advancedInput,
      consentStep,
      freeReport,
      lineApplied,
      workspaceJump,
      database,
      passed: consoleErrors.length === 0
        && runtimeErrors.length === 0
        && failures.length === 0
        && badResponses.length === 0
        && landing.activeView === "landingView"
        && landing.brand === "Chen Dino"
        && landing.heroTitle.includes("先知道")
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
        && landing.bodyOverflow === 0
        && requiredValidation.step === "1"
        && requiredValidation.errorsVisible
        && requiredValidation.errorCount >= 1
        && advancedInput.activeView === "inputView"
        && advancedInput.hasMonthlyEditor
        && advancedInput.hasHoldingEditor
        && advancedInput.title.includes("財務資料")
        && consentStep.step === "6"
        && consentStep.consentVisible
        && freeReport.activeView === "freeReportView"
        && freeReport.hasWorkspaceNav
        && freeReport.hasMissingEtfPrompt
        && freeReport.hasPrescription
        && freeReport.hasFirstAction
        && freeReport.hasAllocation
        && freeReport.hasAvoid
        && freeReport.hasNumbers
        && freeReport.hasLineSyncPanel
        && freeReport.hasLineBindingAction
        && freeReport.bodyOverflow === 0
        && lineApplied.income === 50000
        && lineApplied.expense === 65
        && lineApplied.investment === 10000
        && lineApplied.ticker === "0056"
        && lineApplied.lineLots === 1
        && lineApplied.lineAmount === 10000
        && lineApplied.recentEntries === 1
        && workspaceJump.activeView === "inputView"
        && workspaceJump.hasEtfSection
        && workspaceJump.hasHoldingEditor
        && workspaceJump.hasBackHome
        && workspaceJump.bodyOverflow === 0
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
