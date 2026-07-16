const http = require("http");
const { execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { authSessionDays, createStore, lineLedgerRetentionDays } = require("./customer-store");
const { buildCheckout, createMerchantTradeNo, ecpayConfig, productCatalog, productFor, verifyNotification } = require("./ecpay");
const { authorizationUrl, createPkceValues, exchangeAuthorizationCode, lineLoginReadiness, verifyLineIdToken } = require("./line-auth");
const { handleLineWebhook, lineReadiness, parseLedgerMessageWithAi, verifyLineSignature } = require("./line-bot");

const root = __dirname;
const port = Number(process.env.PORT || 5188);
const allowedOrigins = String(process.env.ALLOWED_ORIGINS || "http://localhost:5188,http://127.0.0.1:5188")
  .split(",").map((item) => item.trim()).filter(Boolean);
const marketRefreshMinutes = Math.max(1, Math.min(1440, Number(process.env.MARKET_REFRESH_MINUTES || 15)));
const actionDispatchMinutes = Math.max(1, Math.min(1440, Number(process.env.ACTION_DISPATCH_MINUTES || 15)));
const authCookieName = "__Host-cashflow_session";
let updatePromise = null;
let lastActionDispatchAt = 0;
let customerStore = null;
let customerStoreError = null;
const rateBuckets = new Map();
let lineRichMenuStatus = {
  enabled: process.env.LINE_RICH_MENU_AUTO_DEPLOY === "1",
  status: process.env.LINE_RICH_MENU_AUTO_DEPLOY === "1" ? "pending" : "disabled",
  richMenuId: null,
  flexValidated: false,
  error: null
};
let lineAiParserStatus = {
  enabled: process.env.LINE_AI_PARSER_ENABLED === "1",
  status: process.env.LINE_AI_PARSER_ENABLED !== "1"
    ? "disabled"
    : process.env.OPENAI_API_KEY
      ? "pending"
      : "missing_key",
  model: process.env.OPENAI_LINE_PARSER_MODEL || "gpt-5.4-nano",
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

function cookies(req) {
  return String(req.headers.cookie || "").split(";").reduce((result, part) => {
    const index = part.indexOf("=");
    if (index <= 0) return result;
    result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    return result;
  }, {});
}

function authToken(req) {
  return cookies(req)[authCookieName] || "";
}

function memberSession(req, { required = false, touch = true } = {}) {
  const session = getCustomerStore().authenticatedUser(authToken(req), { touch });
  if (!session && required) {
    const error = new Error("請先使用 LINE 登入");
    error.statusCode = 401;
    throw error;
  }
  return session;
}

function setAuthCookie(res, session) {
  res.setHeader("Set-Cookie", `${authCookieName}=${encodeURIComponent(session.token)}; Path=/; Max-Age=${session.maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`);
}

function refreshAuthCookie(res, req) {
  const token = authToken(req);
  if (token) setAuthCookie(res, { token, maxAgeSeconds: authSessionDays * 86400 });
}

function clearAuthCookie(res) {
  res.setHeader("Set-Cookie", `${authCookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
}

function authReturnView(value) {
  const allowed = new Set(["landingView", "inputView", "freeReportView", "upgradeView", "paidReportView", "simulationView", "calendarView"]);
  return allowed.has(String(value || "")) ? String(value) : "inputView";
}

function authRedirectUrl(view = "inputView", extra = {}) {
  const redirect = new URL(`${sitePublicBaseUrl()}/`);
  redirect.searchParams.set("view", authReturnView(view));
  Object.entries(extra).forEach(([key, value]) => redirect.searchParams.set(key, String(value)));
  return redirect.toString();
}

function setSecurityHeaders(req, res) {
  const origin = String(req.headers.origin || "");
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Report-Access-Code, X-Line-Signature, X-Confirm-Delete");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self' https:; img-src 'self' data: https://profile.line-scdn.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; script-src 'self' https://static.line-scdn.net; form-action 'self' https://access.line.me https://payment-stage.ecpay.com.tw https://payment.ecpay.com.tw; frame-ancestors 'none'");
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

async function establishLineSession(req, idToken, nonce = "") {
  const identity = await verifyLineIdToken(idToken, nonce);
  const user = getCustomerStore().findOrCreateUserByLineId(identity.lineUserId);
  const session = getCustomerStore().createUserSession(user.id, req.headers["user-agent"] || "");
  return { user, session };
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
      authSessionDays,
      auth: lineLoginReadiness(),
      line: { ...lineReadiness(), aiParser: lineAiParserStatus, richMenu: lineRichMenuStatus },
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
  if (urlPath === "/api/auth/line/start" && req.method === "GET") {
    try {
      if (!rateLimit(req, 20, 60000)) return sendJson(res, 429, { ok: false, error: "登入嘗試次數過多，請稍後再試" });
      const state = crypto.randomBytes(24).toString("base64url");
      const nonce = crypto.randomBytes(24).toString("base64url");
      const pkce = createPkceValues();
      getCustomerStore().createAuthChallenge({
        state,
        nonce,
        codeVerifier: pkce.verifier,
        returnTo: authReturnView(url.searchParams.get("returnTo"))
      });
      res.writeHead(302, {
        Location: authorizationUrl({ state, nonce, codeChallenge: pkce.challenge }),
        "Cache-Control": "no-store"
      });
      res.end();
    } catch (error) {
      sendJson(res, error.statusCode || 500, { ok: false, error: publicStoreError(error) });
    }
    return;
  }
  if (urlPath === "/api/auth/line/callback" && req.method === "GET") {
    const state = String(url.searchParams.get("state") || "");
    const code = String(url.searchParams.get("code") || "");
    if (url.searchParams.get("error") || !state || !code) {
      res.writeHead(303, { Location: authRedirectUrl("landingView", { authError: "cancelled" }), "Cache-Control": "no-store" });
      res.end();
      return;
    }
    let challenge;
    try {
      challenge = getCustomerStore().consumeAuthChallenge(state);
    } catch {
      res.writeHead(303, { Location: authRedirectUrl("landingView", { authError: "expired" }), "Cache-Control": "no-store" });
      res.end();
      return;
    }
    exchangeAuthorizationCode({ code, codeVerifier: challenge.codeVerifier })
      .then((tokens) => establishLineSession(req, tokens.id_token, challenge.nonce))
      .then(({ session }) => {
        setAuthCookie(res, session);
        res.writeHead(303, { Location: authRedirectUrl(challenge.returnTo, { auth: "line" }), "Cache-Control": "no-store" });
        res.end();
      })
      .catch((error) => {
        console.error(`LINE Login callback 失敗：${String(error.message || error).slice(0, 300)}`);
        res.writeHead(303, { Location: authRedirectUrl("landingView", { authError: "failed" }), "Cache-Control": "no-store" });
        res.end();
      });
    return;
  }
  if (urlPath === "/api/auth/line/liff" && req.method === "POST") {
    if (!rateLimit(req, 20, 60000)) return sendJson(res, 429, { ok: false, error: "登入嘗試次數過多，請稍後再試" });
    readJson(req, 20000)
      .then((body) => establishLineSession(req, String(body.idToken || "")))
      .then(({ user, session }) => {
        setAuthCookie(res, session);
        sendJson(res, 200, { ok: true, user });
      })
      .catch((error) => sendJson(res, error.statusCode || 401, { ok: false, error: publicStoreError(error) }));
    return;
  }
  if (urlPath === "/api/auth/session" && req.method === "GET") {
    try {
      const readiness = lineLoginReadiness();
      const session = readiness.configured ? memberSession(req, { touch: true }) : null;
      if (session) refreshAuthCookie(res, req);
      sendJson(res, 200, {
        ok: true,
        configured: readiness.configured,
        liffId: readiness.liffId,
        authenticated: Boolean(session),
        user: session?.user || null,
        sessionExpiresAt: session?.sessionExpiresAt || null,
        sameOrigin: new URL(sitePublicBaseUrl()).origin === new URL(apiPublicBaseUrl()).origin
      });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { ok: false, error: publicStoreError(error) });
    }
    return;
  }
  if (urlPath === "/api/auth/logout" && req.method === "POST") {
    try {
      const session = memberSession(req, { touch: false });
      if (session) getCustomerStore().revokeUserSession(session.sessionId, session.user.id);
      clearAuthCookie(res);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      clearAuthCookie(res);
      sendJson(res, error.statusCode || 500, { ok: false, error: publicStoreError(error) });
    }
    return;
  }
  if (urlPath === "/api/auth/logout-all" && req.method === "POST") {
    try {
      const session = memberSession(req, { required: true, touch: false });
      const revoked = getCustomerStore().revokeAllUserSessions(session.user.id);
      clearAuthCookie(res);
      sendJson(res, 200, { ok: true, revoked });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { ok: false, error: publicStoreError(error) });
    }
    return;
  }
  if (urlPath === "/api/users/me/bootstrap" && req.method === "GET") {
    try {
      const session = memberSession(req, { required: true });
      const bootstrap = getCustomerStore().userBootstrap(session.user.id, url.searchParams.get("month"));
      sendJson(res, 200, { ok: true, ...bootstrap });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { ok: false, error: publicStoreError(error) });
    }
    return;
  }
  if (urlPath === "/api/users/me/onboarding/complete" && req.method === "POST") {
    readJson(req, 20000)
      .then((body) => {
        const session = memberSession(req, { required: true });
        const user = getCustomerStore().completeUserOnboarding(session.user.id, String(body.reportId || ""));
        sendJson(res, 200, { ok: true, user });
      })
      .catch((error) => sendJson(res, error.statusCode || 400, { ok: false, error: publicStoreError(error) }));
    return;
  }
  if (urlPath === "/api/users/me/account" && req.method === "DELETE") {
    try {
      if (String(req.headers["x-confirm-delete"] || "") !== "DELETE MY ACCOUNT") {
        return sendJson(res, 400, { ok: false, error: "缺少刪除會員確認" });
      }
      const session = memberSession(req, { required: true, touch: false });
      const deleted = getCustomerStore().deleteUserAccount(session.user.id);
      clearAuthCookie(res);
      sendJson(res, deleted ? 200 : 404, deleted ? { ok: true } : { ok: false, error: "找不到會員" });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { ok: false, error: publicStoreError(error) });
    }
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
      const member = memberSession(req);
      const summary = member
        ? getCustomerStore().lineCashflowForUser(member.user.id, url.searchParams.get("month") || undefined, 8)
        : getCustomerStore().getLineReportSummary({
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
      const member = memberSession(req);
      const cashflow = member
        ? getCustomerStore().lineCashflowForUser(member.user.id, url.searchParams.get("month") || undefined, url.searchParams.get("limit") || 20)
        : getCustomerStore().lineCashflowForReport({
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
      const member = memberSession(req);
      const cashflow = member
        ? getCustomerStore().lineCashflowForUser(member.user.id, url.searchParams.get("month") || undefined, 8)
        : getCustomerStore().lineCashflowForReport({
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
      const member = memberSession(req);
      const cashflow = member
        ? getCustomerStore().lineCashflowForUser(member.user.id, url.searchParams.get("month") || undefined, url.searchParams.get("limit") || 20)
        : getCustomerStore().lineCashflowForReport({
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
        const member = memberSession(req);
        const input = {
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
        };
        const entry = member
          ? getCustomerStore().addLineLedgerEntryForUser({ userId: member.user.id, ...input })
          : getCustomerStore().addLineLedgerEntryForReport({ reportId: body.reportId, accessCode: accessCode(req, url), ...input });
        sendJson(res, 201, { ok: true, entry });
      })
      .catch((error) => sendJson(res, error.statusCode || 400, { ok: false, error: publicStoreError(error) }));
    return;
  }
  const ledgerEntryMatch = urlPath.match(/^\/api\/ledger\/([0-9a-f-]+)$/i);
  if (ledgerEntryMatch && req.method === "PATCH") {
    readJson(req, 20000)
      .then((body) => {
        const member = memberSession(req);
        const entry = member
          ? getCustomerStore().updateLineLedgerEntryForUser({ userId: member.user.id, entryId: ledgerEntryMatch[1], patch: body.patch || body })
          : getCustomerStore().updateLineLedgerEntryForReport({
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
      const member = memberSession(req);
      const entry = member
        ? getCustomerStore().deleteLineLedgerEntryForUser({ userId: member.user.id, entryId: ledgerEntryMatch[1] })
        : getCustomerStore().deleteLineLedgerEntryForReport({
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
      .then((body) => {
        const member = memberSession(req);
        const profile = member
          ? getCustomerStore().updateLineProfileForUser({ userId: member.user.id, profile: body.profile || body })
          : getCustomerStore().updateLineProfileForReport({
            reportId: body.reportId,
            accessCode: accessCode(req, url),
            profile: body.profile || body
          });
        sendJson(res, 200, { ok: true, profile });
      })
      .catch((error) => sendJson(res, error.statusCode || 400, { ok: false, error: publicStoreError(error) }));
    return;
  }
  if (urlPath === "/api/holdings" && req.method === "PATCH") {
    readJson(req, 100000)
      .then((body) => {
        const member = memberSession(req);
        const holdings = member
          ? getCustomerStore().replaceLineHoldingsForUser({ userId: member.user.id, holdings: body.holdings })
          : getCustomerStore().replaceLineHoldingsForReport({
            reportId: body.reportId,
            accessCode: accessCode(req, url),
            holdings: body.holdings
          });
        sendJson(res, 200, { ok: true, holdings });
      })
      .catch((error) => sendJson(res, error.statusCode || 400, { ok: false, error: publicStoreError(error) }));
    return;
  }
  if (urlPath === "/api/users/me/data" && req.method === "DELETE") {
    if (String(req.headers["x-confirm-delete"] || "") !== "DELETE LINE DATA") {
      sendJson(res, 400, { ok: false, error: "缺少刪除全部 LINE 財務資料的確認" });
      return;
    }
    try {
      const member = memberSession(req);
      const deleted = member
        ? getCustomerStore().deleteLineUserDataForUser(member.user.id)
        : getCustomerStore().deleteLineUserDataForReport({
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
        const member = memberSession(req);
        const product = productFor(body.productType || "full_report");
        const order = getCustomerStore().createOrder({
          id: createMerchantTradeNo(),
          reportId: body.reportId,
          accessCode: body.accessCode,
          userId: member?.user.id || null,
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
      const member = memberSession(req);
      const order = getCustomerStore().getOrderStatus({
        id: paymentStatusMatch[1],
        reportId: url.searchParams.get("reportId"),
        accessCode: accessCode(req, url),
        statusToken: String(req.headers["x-payment-status-token"] || url.searchParams.get("statusToken") || ""),
        userId: member?.user.id || null
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
      .then((body) => {
        const member = memberSession(req);
        sendJson(res, 201, { ok: true, report: getCustomerStore().createReport(body, { userId: member?.user.id || null }) });
      })
      .catch((error) => sendJson(res, error.statusCode || 400, { ok: false, error: publicStoreError(error) }));
    return;
  }

  const reportMatch = urlPath.match(/^\/api\/reports\/([0-9a-f-]+)$/i);
  if (reportMatch && req.method === "GET") {
    try {
      const member = memberSession(req);
      const report = member
        ? getCustomerStore().getReportForUser(reportMatch[1], member.user.id)
        : getCustomerStore().getReport(reportMatch[1], accessCode(req, url));
      sendJson(res, report ? 200 : 404, report ? { ok: true, report } : { ok: false, error: "找不到報告或存取碼不正確" });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { ok: false, error: publicStoreError(error) });
    }
    return;
  }
  if (reportMatch && req.method === "DELETE") {
    try {
      const member = memberSession(req);
      const deleted = member
        ? getCustomerStore().deleteReportForUser(reportMatch[1], member.user.id)
        : getCustomerStore().deleteReport(reportMatch[1], accessCode(req, url));
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
  if (lineAiParserStatus.status === "pending") {
    lineAiParserStatus = { ...lineAiParserStatus, status: "validating", error: null };
    parseLedgerMessageWithAi("午餐 120、飲料 60")
      .then((result) => {
        const total = (result?.entries || []).reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
        if (result?.entries?.length !== 2 || total !== 180) throw new Error("AI parser canary 未正確拆成兩筆");
        lineAiParserStatus = { ...lineAiParserStatus, status: "ready", error: null };
        console.log("LINE AI parser canary 已通過");
      })
      .catch((error) => {
        const message = String(error.message || error).slice(0, 300);
        lineAiParserStatus = { ...lineAiParserStatus, status: "failed", error: message };
        console.error(`LINE AI parser canary 失敗：${message}`);
      });
  }
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
          lineRichMenuStatus = {
            ...lineRichMenuStatus,
            status: "ready",
            richMenuId: result.richMenuId || null,
            flexValidated: result.flexValidated === true,
            error: null
          };
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
