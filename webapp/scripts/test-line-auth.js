const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const port = 6100 + Math.floor(Math.random() * 200);
const linePort = port + 300;
const baseUrl = `http://127.0.0.1:${port}`;
const lineBase = `http://127.0.0.1:${linePort}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cashflow-line-auth-"));
const lineUserId = `U${"1".repeat(32)}`;
const channelSecret = crypto.randomBytes(24).toString("base64url");

const lineServer = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const form = new URLSearchParams(body);
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/oauth2/v2.1/token" && req.method === "POST") {
    if (!form.get("code_verifier")) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "missing_verifier" }));
      return;
    }
    res.end(JSON.stringify({ id_token: `oauth:${form.get("code")}` }));
    return;
  }
  if (req.url === "/oauth2/v2.1/verify" && req.method === "POST") {
    if (!form.get("id_token") || form.get("client_id") !== "test-channel-id") {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "invalid_token" }));
      return;
    }
    res.end(JSON.stringify({ sub: lineUserId, name: "Test Member" }));
    return;
  }
  res.writeHead(404);
  res.end(JSON.stringify({ error: "not_found" }));
});

const env = {
  ...process.env,
  PORT: String(port),
  SMOKE_TEST: "1",
  CUSTOMER_DATA_DIR: dataDir,
  CUSTOMER_DATA_KEY: crypto.randomBytes(32).toString("base64"),
  ACCESS_CODE_PEPPER: crypto.randomBytes(24).toString("base64url"),
  ADMIN_API_KEY: crypto.randomBytes(24).toString("base64url"),
  SITE_PUBLIC_BASE_URL: baseUrl,
  API_PUBLIC_BASE_URL: baseUrl,
  ALLOWED_ORIGINS: baseUrl,
  LINE_LOGIN_CHANNEL_ID: "test-channel-id",
  LINE_LOGIN_CHANNEL_SECRET: channelSecret,
  LINE_LOGIN_CALLBACK_URL: `${baseUrl}/api/auth/line/callback`,
  LINE_LOGIN_AUTHORIZE_URL: `${lineBase}/authorize`,
  LINE_LOGIN_API_BASE: lineBase,
  LINE_LIFF_ID: "test-liff-id",
  AUTH_SESSION_DAYS: "30",
  LINE_REPLY_DISABLED: "1",
  LINE_RICH_MENU_AUTO_DEPLOY: "0"
};

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cookieFrom(response) {
  return String(response.headers.get("set-cookie") || "").split(";")[0];
}

async function request(pathname, options = {}) {
  const { headers = {}, ...rest } = options;
  const response = await fetch(`${baseUrl}${pathname}`, {
    redirect: "manual",
    headers: { "Content-Type": "application/json", ...headers },
    ...rest
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
}

async function waitForServer() {
  for (let index = 0; index < 50; index++) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // retry
    }
    await wait(120);
  }
  throw new Error("Auth test server did not start");
}

async function oauthLogin(code) {
  const started = await request("/api/auth/line/start?returnTo=inputView");
  if (started.status !== 302) throw new Error("LINE Login start did not redirect");
  const authorization = new URL(started.headers.get("location"));
  if (!authorization.searchParams.get("code_challenge") || authorization.searchParams.get("code_challenge_method") !== "S256") {
    throw new Error("LINE Login did not use PKCE");
  }
  const callback = await request(`/api/auth/line/callback?state=${encodeURIComponent(authorization.searchParams.get("state"))}&code=${encodeURIComponent(code)}`);
  const setCookie = callback.headers.get("set-cookie") || "";
  if (callback.status !== 303 || !setCookie.includes("HttpOnly") || !setCookie.includes("Secure") || !setCookie.includes("SameSite=Lax")) {
    throw new Error("LINE callback did not issue the secure session cookie");
  }
  return cookieFrom(callback);
}

function submission() {
  return {
    anonymousId: crypto.randomUUID(),
    checkType: "cashflow",
    consent: { accepted: true, acceptedAt: new Date().toISOString() },
    contact: { channel: "none", value: "" },
    input: {
      inputVersion: "cashflow-input-v2",
      profile: { monthlyIncome: 50000, fixedExpense: 25000, cashSavings: 120000 },
      holdings: [],
      monthlyCashflows: {},
      leadProfile: {}
    },
    report: {
      reportVersion: "cashflow-report-v2",
      generatedAt: new Date().toISOString(),
      score: 70,
      status: "可改善",
      breakdown: {},
      prescription: {},
      stockSafety: { level: "green" },
      risks: []
    }
  };
}

async function main() {
  await new Promise((resolve) => lineServer.listen(linePort, "127.0.0.1", resolve));
  const server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, "..", ".."),
    env,
    windowsHide: true,
    stdio: "ignore"
  });
  try {
    await waitForServer();
    const health = await request("/api/health");
    const healthText = JSON.stringify(health.body);
    if (!health.body.auth?.configured || healthText.includes(channelSecret)) throw new Error("Auth readiness is wrong or leaked a secret");

    const anonymousSession = await request("/api/auth/session");
    if (!anonymousSession.body.configured || anonymousSession.body.authenticated) throw new Error("Anonymous auth state is wrong");

    const firstCookie = await oauthLogin("first-device");
    const firstHeaders = { Cookie: firstCookie };
    const firstToken = decodeURIComponent(firstCookie.slice(firstCookie.indexOf("=") + 1));
    const rawSessionStore = ["customers.sqlite", "customers.sqlite-wal"]
      .map((name) => path.join(dataDir, name))
      .filter(fs.existsSync)
      .map((file) => fs.readFileSync(file).toString("latin1"))
      .join("");
    if (rawSessionStore.includes(firstToken)) throw new Error("Raw session token was stored in SQLite");
    const firstSession = await request("/api/auth/session", { headers: firstHeaders });
    if (!firstSession.body.authenticated || firstSession.body.user.onboardingCompleted) throw new Error("First member session is wrong");
    if (!String(firstSession.headers.get("set-cookie") || "").includes("Max-Age=2592000")) throw new Error("Active session cookie was not renewed");
    if (JSON.stringify(firstSession.body).includes("oauth:first-device")) throw new Error("LINE token leaked into the session API");

    const created = await request("/api/reports", {
      method: "POST",
      headers: firstHeaders,
      body: JSON.stringify(submission())
    });
    if (created.status !== 201) throw new Error("Member report creation failed");
    const reportId = created.body.report.id;
    const onboarding = await request("/api/users/me/onboarding/complete", {
      method: "POST",
      headers: firstHeaders,
      body: JSON.stringify({ reportId })
    });
    if (!onboarding.body.user.onboardingCompleted) throw new Error("Onboarding was not completed");

    const reloadBootstrap = await request("/api/users/me/bootstrap", { headers: firstHeaders });
    if (reloadBootstrap.body.report.id !== reportId || !reloadBootstrap.body.user.onboardingCompleted) {
      throw new Error("F5 bootstrap did not restore the member report");
    }

    const liffLogin = await request("/api/auth/line/liff", {
      method: "POST",
      body: JSON.stringify({ idToken: "liff-device-token" })
    });
    const secondCookie = cookieFrom(liffLogin);
    if (liffLogin.status !== 200 || !secondCookie) throw new Error("LIFF login failed");
    const secondHeaders = { Cookie: secondCookie };
    const secondBootstrap = await request("/api/users/me/bootstrap", { headers: secondHeaders });
    if (secondBootstrap.body.report.id !== reportId) throw new Error("Second device did not restore the same member data");

    await request("/api/auth/logout", { method: "POST", headers: firstHeaders, body: "{}" });
    const firstAfterLogout = await request("/api/auth/session", { headers: firstHeaders });
    const secondAfterFirstLogout = await request("/api/auth/session", { headers: secondHeaders });
    if (firstAfterLogout.body.authenticated || !secondAfterFirstLogout.body.authenticated) throw new Error("Single-device logout revoked the wrong sessions");

    await request("/api/auth/logout-all", { method: "POST", headers: secondHeaders, body: "{}" });
    const secondAfterLogoutAll = await request("/api/auth/session", { headers: secondHeaders });
    if (secondAfterLogoutAll.body.authenticated) throw new Error("Logout all did not revoke the other session");

    const expiringCookie = await oauthLogin("expiring-device");
    const db = new DatabaseSync(path.join(dataDir, "customers.sqlite"));
    db.prepare("UPDATE user_sessions SET expires_at = ? WHERE revoked_at IS NULL").run("2000-01-01T00:00:00.000Z");
    db.close();
    const expired = await request("/api/auth/session", { headers: { Cookie: expiringCookie } });
    if (expired.body.authenticated) throw new Error("Expired session remained authenticated");

    const deleteCookie = await oauthLogin("delete-account");
    const deleted = await request("/api/users/me/account", {
      method: "DELETE",
      headers: { Cookie: deleteCookie, "X-Confirm-Delete": "DELETE MY ACCOUNT" }
    });
    if (deleted.status !== 200) throw new Error("Member account deletion failed");
    const deletedSession = await request("/api/auth/session", { headers: { Cookie: deleteCookie } });
    if (deletedSession.body.authenticated) throw new Error("Deleted member session remained authenticated");

    console.log(JSON.stringify({
      passed: true,
      pkce: true,
      secureCookie: true,
      slidingSession: true,
      sessionTokenHashedAtRest: true,
      onboardingOnce: true,
      f5Bootstrap: true,
      secondDeviceRestore: true,
      logoutAndRevokeAll: true,
      expiry: true,
      accountDeletion: true
    }, null, 2));
  } finally {
    server.kill();
    await new Promise((resolve) => server.once("exit", resolve));
    await new Promise((resolve) => lineServer.close(resolve));
    try {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      if (error.code !== "EPERM") throw error;
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
