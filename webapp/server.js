const http = require("http");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { createStore, lineLedgerRetentionDays } = require("./customer-store");
const { buildCheckout, createMerchantTradeNo, ecpayConfig, productCatalog, productFor, verifyNotification } = require("./ecpay");
const { handleLineWebhook, lineReadiness, verifyLineSignature } = require("./line-bot");

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
let lineRichMenuStatus = {
  enabled: process.env.LINE_RICH_MENU_AUTO_DEPLOY === "1",
  status: process.env.LINE_RICH_MENU_AUTO_DEPLOY === "1" ? "pending" : "disabled",
  richMenuId: null,
  error: null
};

function cleanBaseUrl(value, fallback) {
  return String(value || fallback).replace(/\/$/, "");
}

function sitePublicBaseUrl() {
  return cleanBaseUrl(process.env.SITE_PUBLIC_BASE_URL || process.env.PUBLIC_SITE_BASE_URL, `http://localhost:${port}`);
}

function apiPublicBaseUrl() {
  return cleanBaseUrl(process.env.API_PUBLIC_BASE_URL || process.env.BACKEND_PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL, `http://localhost:${port}`);
}

function paymentReadiness() {
  const config = ecpayConfig();
  const catalog = productCatalog();
  return {
    ecpayConfigured: Boolean(config.merchantId && config.hashKey && config.hashIv),
    ecpayEnvironment: config.isProduction ? "production" : "stage",
    checkoutHost: new URL(config.checkoutUrl).host,
    sitePublicBaseConfigured: Boolean(process.env.SITE_PUBLIC_BASE_URL || process.env.PUBLIC_SITE_BASE_URL),
    apiPublicBaseConfigured: Boolean(process.env.API_PUBLIC_BASE_URL || process.env.BACKEND_PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL),
    consultationIgConfigured: Boolean(process.env.CONSULTATION_IG_URL || "https://www.instagram.com/chendino080077/"),
    consultationLineConfigured: Boolean(process.env.CONSULTATION_LINE_URL),
    prices: {
      fullReport: catalog.full_report.amount,
      consultationDeposit: catalog.consultation_deposit.amount,
      consultationFee: Math.max(1, Math.round(Number(process.env.CONSULTATION_FEE_TWD || 1500)))
    }
  };
}

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

function sendText(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
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

function readRawBody(req, maxBytes = 1000000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        const error = new Error("請求資料超過大小限制");
        error.statusCode = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function readForm(req, maxBytes = 200000) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > maxBytes) {
        const error = new Error("form body too large");
        error.statusCode = 413;
        reject(error);
        req.destroy();
      }
    });
    req.on("end", () => {
      const params = new URLSearchParams(body);
      const result = {};
      for (const [key, value] of params.entries()) result[key] = value;
      resolve(result);
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Report-Access-Code, X-Line-Signature, X-Confirm-Delete");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self' https:; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; script-src 'self'; form-action 'self' https://payment-stage.ecpay.com.tw https://payment.ecpay.com.tw; frame-ancestors 'none'");
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
      customerStoreConfigured: Boolean(process.env.CUSTOMER_DATA_KEY && process.env.ACCESS_CODE_PEPPER && process.env.ADMIN_API_KEY),
      lineLedgerRetentionDays,
      line: { ...lineReadiness(), richMenu: lineRichMenuStatus },
      payment: paymentReadiness()
    });
    return;
  }
  if (urlPath === "/api/line/webhook" && req.method === "POST") {
    if (!rateLimit(req, 240)) return sendJson(res, 429, { ok: false, error: "LINE webhook 請求次數過多" });
    readRawBody(req, 1000000)
      .then(async (rawBody) => {
        const signature = String(req.headers["x-line-signature"] || "");
        if (!verifyLineSignature(rawBody, signature)) {
          sendJson(res, 401, { ok: false, error: "LINE 簽章驗證失敗" });
          return;
        }
        const result = await handleLineWebhook(rawBody, { store: getCustomerStore() });
        sendJson(res, 200, { ok: true, ...result });
      })
      .catch((error) => sendJson(res, error.statusCode || 400, { ok: false, error: error.message }));
    return;
  }
  if (urlPath === "/api/line/bindings" && req.method === "POST") {
    if (!rateLimit(req, 8, 60000)) return sendJson(res, 429, { ok: false, error: "LINE 綁定碼建立次數過多，請稍後再試" });
    readJson(req, 10000)
      .then((body) => sendJson(res, 201, { ok: true, binding: getCustomerStore().createLineReportBinding({
        reportId: body.reportId,
        accessCode: body.accessCode
      }) }))
      .catch((error) => sendJson(res, error.statusCode || 400, { ok: false, error: publicStoreError(error) }));
    return;
  }
  if (urlPath === "/api/line/summary" && req.method === "GET") {
    try {
      const summary = getCustomerStore().getLineReportSummary({
        reportId: url.searchParams.get("reportId"),
        accessCode: accessCode(req, url),
        monthKey: url.searchParams.get("month") || undefined
      });
      sendJson(res, 200, { ok: true, summary });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { ok: false, error: publicStoreError(error) });
    }
    return;
  }
  if (urlPath === "/api/users/me/cashflow" && req.method === "GET") {
    try {
      const cashflow = getCustomerStore().lineCashflowForReport({
        reportId: url.searchParams.get("reportId"),
        accessCode: accessCode(req, url),
        monthKey: url.searchParams.get("month") || undefined,
        limit: url.searchParams.get("limit") || 20
      });
      sendJson(res, 200, { ok: true, cashflow });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { ok: false, error: publicStoreError(error) });
    }
    return;
  }
  if (urlPath === "/api/ledger/monthly-summary" && req.method === "GET") {
    try {
      const cashflow = getCustomerStore().lineCashflowForReport({
        reportId: url.searchParams.get("reportId"),
        accessCode: accessCode(req, url),
        monthKey: url.searchParams.get("month") || undefined,
        limit: 8
      });
      const { entries, ...summary } = cashflow;
      sendJson(res, 200, { ok: true, summary });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { ok: false, error: publicStoreError(error) });
    }
    return;
  }
  if (urlPath === "/api/ledger" && req.method === "GET") {
    try {
      const cashflow = getCustomerStore().lineCashflowForReport({
        reportId: url.searchParams.get("reportId"),
        accessCode: accessCode(req, url),
        monthKey: url.searchParams.get("month") || undefined,
        limit: url.searchParams.get("limit") || 20
      });
      sendJson(res, 200, { ok: true, month: cashflow.month, entries: cashflow.entries });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { ok: false, error: publicStoreError(error) });
    }
    return;
  }
  if (urlPath === "/api/ledger" && req.method === "POST") {
    if (!rateLimit(req, 60)) return sendJson(res, 429, { ok: false, error: "記帳請求次數過多" });
    readJson(req, 20000)
      .then((body) => {
        const entry = getCustomerStore().addLineLedgerEntryForReport({
          reportId: body.reportId,
          accessCode: accessCode(req, url),
          type: body.type,
          amount: body.amount,
          category: body.category,
          ticker: body.ticker,
          note: body.note,
          occurredAt: body.occurredAt,
          source: {
            platform: "web",
            requestId: body.requestId || null,
            messageId: body.requestId ? `web:${String(body.requestId).slice(0, 70)}` : null
          }
        });
        sendJson(res, 201, { ok: true, entry });
      })
      .catch((error) => sendJson(res, error.statusCode || 400, { ok: false, error: publicStoreError(error) }));
    return;
  }
  const ledgerEntryMatch = urlPath.match(/^\/api\/ledger\/([0-9a-f-]+)$/i);
  if (ledgerEntryMatch && req.method === "PATCH") {
    readJson(req, 20000)
      .then((body) => {
        const entry = getCustomerStore().updateLineLedgerEntryForReport({
          reportId: body.reportId,
          accessCode: accessCode(req, url),
          entryId: ledgerEntryMatch[1],
          patch: body.patch || body
        });
        if (!entry) return sendJson(res, 404, { ok: false, error: "找不到這筆記帳明細" });
        sendJson(res, 200, { ok: true, entry });
      })
      .catch((error) => sendJson(res, error.statusCode || 400, { ok: false, error: publicStoreError(error) }));
    return;
  }
  if (ledgerEntryMatch && req.method === "DELETE") {
    try {
      const entry = getCustomerStore().deleteLineLedgerEntryForReport({
        reportId: url.searchParams.get("reportId"),
        accessCode: accessCode(req, url),
        entryId: ledgerEntryMatch[1]
      });
      if (!entry) return sendJson(res, 404, { ok: false, error: "找不到這筆記帳明細" });
      sendJson(res, 200, { ok: true, deleted: entry });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { ok: false, error: publicStoreError(error) });
    }
    return;
  }
  if (urlPath === "/api/profile" && req.method === "PATCH") {
    readJson(req, 20000)
      .then((body) => sendJson(res, 200, {
        ok: true,
        profile: getCustomerStore().updateLineProfileForReport({
          reportId: body.reportId,
          accessCode: accessCode(req, url),
          profile: body.profile || body
        })
      }))
      .catch((error) => sendJson(res, error.statusCode || 400, { ok: false, error: publicStoreError(error) }));
    return;
  }
  if (urlPath === "/api/holdings" && req.method === "PATCH") {
    readJson(req, 100000)
      .then((body) => sendJson(res, 200, {
        ok: true,
        holdings: getCustomerStore().replaceLineHoldingsForReport({
          reportId: body.reportId,
          accessCode: accessCode(req, url),
          holdings: body.holdings
        })
      }))
      .catch((error) => sendJson(res, error.statusCode || 400, { ok: false, error: publicStoreError(error) }));
    return;
  }
  if (urlPath === "/api/users/me/data" && req.method === "DELETE") {
    if (String(req.headers["x-confirm-delete"] || "") !== "DELETE LINE DATA") {
      sendJson(res, 400, { ok: false, error: "缺少刪除全部 LINE 財務資料的確認" });
      return;
    }
    try {
      const deleted = getCustomerStore().deleteLineUserDataForReport({
        reportId: url.searchParams.get("reportId"),
        accessCode: accessCode(req, url)
      });
      sendJson(res, 200, { ok: true, deleted });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { ok: false, error: publicStoreError(error) });
    }
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

  if (urlPath === "/api/payments/checkout" && req.method === "POST") {
    if (!rateLimit(req, 12, 60000)) return sendJson(res, 429, { ok: false, error: "付款建立次數過多，請稍後再試" });
    readJson(req, 20000)
      .then((body) => {
        const product = productFor(body.productType || "full_report");
        const order = getCustomerStore().createOrder({
          id: createMerchantTradeNo(),
          reportId: body.reportId,
          accessCode: body.accessCode,
          productType: product.productType,
          amount: product.amount,
          currency: "TWD",
          provider: "ecpay"
        });
        const checkout = buildCheckout({
          order,
          product,
          siteBaseUrl: sitePublicBaseUrl(),
          apiBaseUrl: apiPublicBaseUrl()
        });
        sendJson(res, 201, { ok: true, order, checkout });
      })
      .catch((error) => sendJson(res, error.statusCode || 400, { ok: false, error: publicStoreError(error) }));
    return;
  }

  const paymentStatusMatch = urlPath.match(/^\/api\/payments\/([A-Z0-9]+)\/status$/i);
  if (paymentStatusMatch && req.method === "GET") {
    try {
      const order = getCustomerStore().getOrderStatus({
        id: paymentStatusMatch[1],
        reportId: url.searchParams.get("reportId"),
        accessCode: accessCode(req, url),
        statusToken: String(req.headers["x-payment-status-token"] || url.searchParams.get("statusToken") || "")
      });
      sendJson(res, order ? 200 : 404, order ? { ok: true, order } : { ok: false, error: "找不到付款訂單" });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { ok: false, error: publicStoreError(error) });
    }
    return;
  }

  if (urlPath === "/api/payments/ecpay/notify" && req.method === "POST") {
    readForm(req)
      .then((body) => {
        const validMac = verifyNotification(body);
        const product = productFor(body.CustomField2 || "full_report");
        getCustomerStore().applyPaymentNotification({
          orderId: body.MerchantTradeNo,
          provider: "ecpay",
          providerTradeNo: body.TradeNo,
          amount: body.TradeAmt,
          rtnCode: body.RtnCode,
          rtnMsg: body.RtnMsg,
          paidAt: body.PaymentDate,
          validMac,
          payload: body,
          entitlement: product.entitlement
        });
        sendText(res, validMac ? 200 : 400, validMac ? "1|OK" : "0|INVALID");
      })
      .catch((error) => sendText(res, error.statusCode || 400, `0|${error.message}`));
    return;
  }

  if (urlPath === "/api/payments/ecpay/result" && req.method === "POST") {
    readForm(req)
      .then((body) => {
        const status = String(body.RtnCode) === "1" ? "success" : "failed";
        const redirect = new URL(sitePublicBaseUrl() + "/");
        redirect.searchParams.set("payment", status);
        if (body.MerchantTradeNo) redirect.searchParams.set("orderId", body.MerchantTradeNo);
        if (body.CustomField1) redirect.searchParams.set("reportId", body.CustomField1);
        res.writeHead(303, { Location: redirect.toString(), "Cache-Control": "no-store" });
        res.end();
      })
      .catch((error) => sendText(res, error.statusCode || 400, error.message));
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
  if (process.env.LINE_RICH_MENU_AUTO_DEPLOY === "1" && process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    lineRichMenuStatus = { ...lineRichMenuStatus, status: "deploying", error: null };
    execFile(process.execPath, [path.join(root, "scripts", "deploy-line-rich-menu.js")], {
      cwd: root,
      env: process.env,
      timeout: 60000,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (error) {
        const message = String(stderr || error.message).trim().slice(0, 300);
        lineRichMenuStatus = { ...lineRichMenuStatus, status: "failed", error: message };
        console.error(`LINE Rich Menu 部署失敗：${message}`);
      } else {
        try {
          const result = JSON.parse(String(stdout).trim());
          lineRichMenuStatus = { ...lineRichMenuStatus, status: "ready", richMenuId: result.richMenuId || null, error: null };
          console.log(`LINE Rich Menu 已確認：${String(stdout).trim()}`);
        } catch (parseError) {
          lineRichMenuStatus = { ...lineRichMenuStatus, status: "failed", error: "Rich Menu 部署結果格式不正確" };
          console.error(`LINE Rich Menu 部署結果解析失敗：${parseError.message}`);
        }
      }
    });
  } else if (process.env.LINE_RICH_MENU_AUTO_DEPLOY === "1") {
    lineRichMenuStatus = { ...lineRichMenuStatus, status: "missing_token", error: "LINE_CHANNEL_ACCESS_TOKEN 尚未設定" };
  }
});
