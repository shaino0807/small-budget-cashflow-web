const { spawn } = require("child_process");
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
  const failures = [];
  const consoleErrors = [];
  const badResponses = [];

  try {
    if (shouldServe) {
      serverProcess = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
        cwd: path.join(__dirname, "..", ".."),
        env: { ...process.env, SMOKE_TEST: "1" },
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
        title: document.title,
        activeView: document.querySelector('.view.is-active')?.id,
        header: document.querySelector('h1')?.textContent,
        tabCount: document.querySelectorAll('.tab').length,
        panelCount: document.querySelectorAll('.panel,.score-panel,.table-panel,.plan-card,.calendar-card').length,
        bodyOverflow: Math.max(0, document.body.scrollWidth - document.documentElement.clientWidth),
        htmlLength: document.body.innerText.length
      }))()`
    });

    await send(ws, "Runtime.evaluate", {
      expression: `document.querySelector('[data-view="databaseView"]')?.click()`
    });
    await wait(1200);
    const databaseMetrics = await send(ws, "Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => ({
        activeView: document.querySelector('.view.is-active')?.id,
        summary: document.querySelector('#databaseSummary')?.textContent,
        classificationStrip: document.querySelector('.classification-strip')?.innerText || '',
        etfRows: document.querySelectorAll('#etfDatabaseTable tbody tr').length,
        bodyOverflow: Math.max(0, document.body.scrollWidth - document.documentElement.clientWidth)
      }))()`
    });
    if (screenshotPath) {
      const shot = await send(ws, "Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      fs.writeFileSync(screenshotPath, Buffer.from(shot.data, "base64"));
    }

    const result = {
      url: targetUrl,
      viewport: "390x844 mobile",
      consoleErrors,
      failedRequests: failures,
      badResponses,
      input: inputMetrics.result.value,
      database: databaseMetrics.result.value,
      passed: consoleErrors.length === 0
        && failures.length === 0
        && badResponses.length === 0
        && inputMetrics.result.value.bodyOverflow === 0
        && databaseMetrics.result.value.bodyOverflow === 0
        && databaseMetrics.result.value.etfRows > 0
    };
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.passed ? 0 : 1);
  } finally {
    if (chromeProcess && !chromeProcess.killed) chromeProcess.kill();
    if (serverProcess && !serverProcess.killed) serverProcess.kill();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
