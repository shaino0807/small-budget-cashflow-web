const http = require("http");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { createStore } = require("./customer-store");

const root = __dirname;
const port = Number(process.env.PORT || 5188);
const allowedOrigins = String(process.env.ALLOWED_ORIGINS || "http://localhost:5188,http://127.0.0.1:5188")
  .split(",").map((item) => item.trim()).filter(Boolean);
const marketRefreshMinutes = Math.max(1, Math.min(1440, Number(process.env.MARKET_REFRESH_MINUTES || 15)));
const actionDispatchMinutes = Math.max(1, Math.min(1440, Number(process.env.ACTION_DISPATCH_MINUTES || 15)));
let updatePromise = null;
let lastActionDispatchAt = 0;
let customerStore = null;
let customerStoreError = null;
const rateBuckets = new Map();

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(payload, null, 2));
}

function getCustomerStore() {
  if (customerStore) return customerStore;
  if (customerStoreError) throw customerStoreError;
  try {
    customerStore = createStore();
    customerStore.purgeExpired();
    return customerStore;
  } catch (error) {
    customerStoreError = error;
    throw error;
  }
}

function publicStoreError(error) {
  if (error === customerStoreError) return "後臺儲存尚未設定";
  return error.message;
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
}

function rateLimit(req, limit = 60, windowMs = 60000) {
  const key = `${clientIp(req)}:${new URL(req.url, `http://localhost:${port}`).pathname}`;
  const now = Date.now();
  const bucket = rateBuckets.get(key) || { startedAt: now, count: 0 };
  if (now - bucket.startedAt >= windowMs) {
    bucket.startedAt = now;
    bucket.count = 0;
  }
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  return bucket.count <= limit;
}

function readJson(req, maxBytes = 600000) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > maxBytes) {
        const error = new Error("請求資料超過大小限制");
        error.statusCode = 413;
        reject(error);
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        const error = new Error("JSON 格式不正確");
        error.statusCode = 400;
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function adminKey(req) {
  return String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
}

function accessCode(req, url) {
  return String(req.headers["x-report-access-code"] || url.searchParams.get("accessCode") || "");
}

function setSecurityHeaders(req, res) {
  const origin = String(req.headers.origin || "");
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Report-Access-Code");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self' https:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'");
}

function databaseFreshness() {
  const db = JSON.parse(fs.readFileSync(path.join(root, "data", "etf-database.json"), "utf8"));
  return {
    snapshotDate: db.metadata?.snapshotDate,
    refreshExecutedAt: db.metadata?.refreshExecutedAt,
    officialPerformanceDate: db.metadata?.officialPerformanceDate,
    sourceFreshness: db.metadata?.sourceFreshness,
    counts: {
      etfs: db.etfs?.length || 0,
      stocks: db.stocks?.items?.length || 0,
      holdings: db.holdings?.items?.length || 0,
      priceSeries: db.priceSeries?.items?.length || 0,
      navSeries: db.navSeries?.items?.length || 0
    }
  };
}

function runScript(scriptName) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(root, "scripts", scriptName)], { cwd: root, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${scriptName}: ${stderr || stdout || error.message}`.trim()));
        return;
      }
      resolve({ script: scriptName, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function updateDatabase() {
  if (updatePromise) return updatePromise;
  updatePromise = (async () => {
    const startedAt = new Date().toISOString();
    const steps = [];
    for (const script of ["update-etf-master.js", "update-price-series.js", "update-issuer-official-data.js", "update-stock-master.js", "finalize-data-quality.js", "validate-etf-data.js"]) {
      steps.push(await runScript(script));
    }
    return { ok: true, startedAt, finishedAt: new Date().toISOString(), freshness: databaseFreshness(), steps };
  })().finally(() => {
    updatePromise = null;
  });
  return updatePromise;
}

function recentRefreshAvailable() {
  try {
    const freshness = databaseFreshness();
    const refreshedAt = new Date(freshness.refreshExecutedAt || 0).getTime();
    return Number.isFinite(refreshedAt) && Date.now() - refreshedAt < marketRefreshMinutes * 60000;
  } catch {
    return false;
  }
}

async function dispatchGitHubAction() {
  const token = String(process.env.GITHUB_ACTIONS_TOKEN || "");
  const repository = String(process.env.GITHUB_REPOSITORY || "shaino0807/small-budget-cashflow-web");
  const workflow = String(process.env.GITHUB_WORKFLOW_FILE || "pages.yml");
  const ref = String(process.env.GITHUB_WORKFLOW_REF || "main");
  if (!token) return { configured: false, dispatched: false, reason: "token_not_configured" };
  if (Date.now() - lastActionDispatchAt < actionDispatchMinutes * 60000) {
    return { configured: true, dispatched: false, reason: "recent_dispatch_available" };
  }
  const apiBase = String(process.env.GITHUB_API_BASE || "https://api.github.com").replace(/\/$/, "");
  const response = await fetch(`${apiBase}/repos/${repository}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "SmallBudgetCashflowMap/1.0",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ ref })
  });
  if (!response.ok) throw new Error(`GitHub Action dispatch HTTP ${response.status}`);
  lastActionDispatchAt = Date.now();
  return { configured: true, dispatched: true, repository, workflow, ref };
}

const server = http.createServer((req, res) => {
  setSecurityHeaders(req, res);
  const requestOrigin = String(req.headers.origin || "");
  if (requestOrigin && !allowedOrigins.includes(requestOrigin)) {
    sendJson(res, 403, { ok: false, error: "不允許的來源" });
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url, `http://localhost:${port}`);
  const urlPath = decodeURIComponent(url.pathname);
  if (urlPath === "/api/database-status") {
    sendJson(res, 200, { ok: true, updateRunning: Boolean(updatePromise), freshness: databaseFreshness() });
    return;
  }
  if (urlPath === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      service: "small-budget-cashflow-api",
      time: new Date().toISOString(),
      customerStoreConfigured: Boolean(process.env.CUSTOMER_DATA_KEY && process.env.ACCESS_CODE_PEPPER && process.env.ADMIN_API_KEY)
    });
    return;
  }
  if (urlPath === "/api/market/database" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    fs.createReadStream(path.join(root, "data", "etf-database.json")).pipe(res);
    return;
  }
  if ((urlPath === "/api/update-database" || urlPath === "/api/market/refresh") && ["GET", "POST"].includes(req.method)) {
    if (process.env.SMOKE_TEST === "1") {
      dispatchGitHubAction()
        .then((githubAction) => sendJson(res, 200, {
          ok: true,
          skipped: true,
          reason: "smoke-test",
          githubAction,
          freshness: databaseFreshness()
        }))
        .catch(() => sendJson(res, 500, { ok: false, error: "GitHub Action 測試觸發失敗" }));
      return;
    }
    const force = url.searchParams.get("reason") === "manual";
    const actionPromise = dispatchGitHubAction().catch(() => ({
      configured: true,
      dispatched: false,
      reason: "dispatch_failed"
    }));
    if (!force && recentRefreshAvailable()) {
      actionPromise.then((githubAction) => sendJson(res, 200, {
        ok: true,
        skipped: true,
        reason: "recent_refresh_available",
        githubAction,
        freshness: databaseFreshness()
      }));
      return;
    }
    Promise.all([updateDatabase(), actionPromise])
      .then(([result, githubAction]) => sendJson(res, 200, { ...result, githubAction }))
      .catch(() => sendJson(res, 500, { ok: false, error: "官方資料更新失敗，已保留最後通過驗證的快照" }));
    return;
  }

  if (urlPath === "/api/events" && req.method === "POST") {
    if (!rateLimit(req, 120)) return sendJson(res, 429, { ok: false, error: "請求次數過多" });
    readJson(req, 20000)
      .then((body) => {
        getCustomerStore().addEvent({
          anonymousId: body.anonymousId,
          reportId: body.reportId,
          eventType: body.eventType,
          metadata: body.metadata
        });
        sendJson(res, 201, { ok: true });
      })
      .catch((error) => sendJson(res, error.statusCode || 400, { ok: false, error: publicStoreError(error) }));
    return;
  }

  if (urlPath === "/api/reports" && req.method === "POST") {
    if (!rateLimit(req, 10, 60000)) return sendJson(res, 429, { ok: false, error: "報告建立次數過多，請稍後再試" });
    readJson(req)
      .then((body) => sendJson(res, 201, { ok: true, report: getCustomerStore().createReport(body) }))
      .catch((error) => sendJson(res, error.statusCode || 400, { ok: false, error: publicStoreError(error) }));
    return;
  }

  const reportMatch = urlPath.match(/^\/api\/reports\/([0-9a-f-]+)$/i);
  if (reportMatch && req.method === "GET") {
    try {
      const report = getCustomerStore().getReport(reportMatch[1], accessCode(req, url));
      sendJson(res, report ? 200 : 404, report ? { ok: true, report } : { ok: false, error: "找不到報告或存取碼不正確" });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { ok: false, error: publicStoreError(error) });
    }
    return;
  }
  if (reportMatch && req.method === "DELETE") {
    try {
      const deleted = getCustomerStore().deleteReport(reportMatch[1], accessCode(req, url));
      sendJson(res, deleted ? 200 : 404, deleted ? { ok: true } : { ok: false, error: "找不到報告或存取碼不正確" });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { ok: false, error: publicStoreError(error) });
    }
    return;
  }

  if (urlPath === "/api/admin/reports" && req.method === "GET") {
    try {
      sendJson(res, 200, { ok: true, reports: getCustomerStore().listReports(adminKey(req), url.searchParams.get("limit")) });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { ok: false, error: publicStoreError(error) });
    }
    return;
  }
  const adminReportMatch = urlPath.match(/^\/api\/admin\/reports\/([0-9a-f-]+)$/i);
  if (adminReportMatch && req.method === "GET") {
    try {
      const report = getCustomerStore().getAdminReport(adminKey(req), adminReportMatch[1]);
      sendJson(res, report ? 200 : 404, report ? { ok: true, report } : { ok: false, error: "找不到報告" });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { ok: false, error: publicStoreError(error) });
    }
    return;
  }
  if (adminReportMatch && req.method === "PATCH") {
    readJson(req, 20000)
      .then((body) => {
        const updated = getCustomerStore().setFollowupStatus(adminKey(req), adminReportMatch[1], body.followupStatus);
        sendJson(res, updated ? 200 : 404, updated ? { ok: true } : { ok: false, error: "找不到報告" });
      })
      .catch((error) => sendJson(res, error.statusCode || 400, { ok: false, error: publicStoreError(error) }));
    return;
  }
  if (urlPath === "/api/admin/analytics" && req.method === "GET") {
    try {
      sendJson(res, 200, { ok: true, analytics: getCustomerStore().analytics(adminKey(req)) });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { ok: false, error: publicStoreError(error) });
    }
    return;
  }

  if (urlPath === "/favicon.ico") {
    fs.readFile(path.join(root, "icon.svg"), (error, data) => {
      if (error) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8" });
      res.end(data);
    });
    return;
  }

  const requested = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const cleanPath = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(root, cleanPath);

  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": types[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": path.extname(filePath) === ".json" ? "no-store" : "public, max-age=300"
    });
    res.end(data);
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`小資現金流地圖 webapp: http://localhost:${port}`);
});
