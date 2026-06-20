const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const port = 5600 + Math.floor(Math.random() * 300);
const githubPort = port + 400;
const baseUrl = `http://127.0.0.1:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cashflow-customer-api-"));
const adminKey = crypto.randomBytes(24).toString("base64url");
let githubDispatchCount = 0;
const githubServer = http.createServer((req, res) => {
  if (req.method === "POST" && req.url.includes("/actions/workflows/pages.yml/dispatches")) {
    githubDispatchCount += 1;
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(404);
  res.end();
});
const env = {
  ...process.env,
  PORT: String(port),
  SMOKE_TEST: "1",
  CUSTOMER_DATA_DIR: dataDir,
  CUSTOMER_DATA_KEY: crypto.randomBytes(32).toString("base64"),
  ACCESS_CODE_PEPPER: crypto.randomBytes(24).toString("base64url"),
  ADMIN_API_KEY: adminKey
  ,
  GITHUB_ACTIONS_TOKEN: "test-server-only-token",
  GITHUB_API_BASE: `http://127.0.0.1:${githubPort}`,
  ACTION_DISPATCH_MINUTES: "15"
};

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(pathname, options = {}) {
  const { headers = {}, ...rest } = options;
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { "Content-Type": "application/json", ...headers },
    ...rest
  });
  const body = await response.json();
  return { status: response.status, body };
}

async function waitForServer() {
  for (let index = 0; index < 40; index++) {
    try {
      const response = await fetch(`${baseUrl}/api/database-status`);
      if (response.ok) return;
    } catch {
      await wait(150);
    }
  }
  throw new Error("API server did not start");
}

async function main() {
  await new Promise((resolve) => githubServer.listen(githubPort, "127.0.0.1", resolve));
  const server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, "..", ".."),
    env,
    windowsHide: true,
    stdio: "ignore"
  });
  try {
    await waitForServer();
    const firstRefresh = await request("/api/market/refresh", { method: "POST" });
    const secondRefresh = await request("/api/market/refresh", { method: "POST" });
    if (!firstRefresh.body.githubAction?.dispatched || secondRefresh.body.githubAction?.reason !== "recent_dispatch_available" || githubDispatchCount !== 1) {
      throw new Error("GitHub Action dispatch throttling failed");
    }
    const invalid = await request("/api/reports", {
      method: "POST",
      body: JSON.stringify({ checkType: "cashflow", consent: { accepted: false } })
    });
    if (invalid.status !== 400) throw new Error("Invalid report was not rejected");

    const submission = {
      anonymousId: crypto.randomUUID(),
      checkType: "cashflow",
      consent: { accepted: true, acceptedAt: new Date().toISOString() },
      contact: { channel: "line", value: "test-contact" },
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
    const created = await request("/api/reports", { method: "POST", body: JSON.stringify(submission) });
    if (created.status !== 201 || !created.body.report?.accessCode) throw new Error("Report creation failed");
    const report = created.body.report;

    const wrongCode = await request(`/api/reports/${report.id}`, {
      headers: { "X-Report-Access-Code": "wrong-code" }
    });
    if (wrongCode.status !== 404) throw new Error("Wrong access code was accepted");

    const unauthorizedAdmin = await request("/api/admin/reports");
    if (unauthorizedAdmin.status !== 401) throw new Error("Admin endpoint accepted missing key");

    const forbiddenOrigin = await request("/api/reports", {
      method: "POST",
      headers: { Origin: "https://attacker.example" },
      body: JSON.stringify(submission)
    });
    if (forbiddenOrigin.status !== 403) throw new Error("Unapproved origin was accepted");

    const reopened = await request(`/api/reports/${report.id}`, {
      headers: { "X-Report-Access-Code": report.accessCode }
    });
    if (reopened.status !== 200 || reopened.body.report.payload.input.profile.monthlyIncome !== 50000) {
      throw new Error("Report reopen failed");
    }

    const adminHeaders = { Authorization: `Bearer ${adminKey}` };
    const list = await request("/api/admin/reports", { headers: adminHeaders });
    if (list.status !== 200 || list.body.reports.length !== 1) throw new Error("Admin report list failed");

    const detail = await request(`/api/admin/reports/${report.id}`, { headers: adminHeaders });
    if (detail.status !== 200 || detail.body.report.contact.value !== "test-contact") throw new Error("Admin detail decrypt failed");

    const updated = await request(`/api/admin/reports/${report.id}`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ followupStatus: "converted" })
    });
    if (updated.status !== 200) throw new Error("Follow-up update failed");

    const analytics = await request("/api/admin/analytics", { headers: adminHeaders });
    if (analytics.status !== 200) throw new Error("Analytics failed");

    const rawDatabase = [
      path.join(dataDir, "customers.sqlite"),
      path.join(dataDir, "customers.sqlite-wal")
    ].filter(fs.existsSync).map((file) => fs.readFileSync(file).toString("utf8")).join("");
    if (rawDatabase.includes("test-contact")) throw new Error("Contact value was stored as plaintext");

    const deleted = await request(`/api/reports/${report.id}`, {
      method: "DELETE",
      headers: { "X-Report-Access-Code": report.accessCode }
    });
    if (deleted.status !== 200) throw new Error("Report deletion failed");

    console.log(JSON.stringify({
      passed: true,
      invalidSubmissionRejected: true,
      encryptedDatabaseCreated: fs.existsSync(path.join(dataDir, "customers.sqlite")),
      wrongAccessRejected: true,
      unauthorizedAdminRejected: true,
      unapprovedOriginRejected: true,
      plaintextContactAbsent: true,
      githubActionDispatchedServerSide: true,
      githubActionDispatchThrottled: true,
      reportCreateReopenDelete: true,
      adminListDetailUpdate: true,
      analytics: analytics.body.analytics
    }, null, 2));
  } finally {
    server.kill();
    await new Promise((resolve) => server.once("exit", resolve));
    await new Promise((resolve) => githubServer.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
