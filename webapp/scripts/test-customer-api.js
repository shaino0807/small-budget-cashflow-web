const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const port = 5600 + Math.floor(Math.random() * 200);
const githubPort = port + 300;
const linePayPort = port + 600;
const baseUrl = `http://127.0.0.1:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cashflow-customer-api-"));
const adminKey = crypto.randomBytes(24).toString("base64url");
const linePayChannelId = "test-linepay-channel";
const linePayChannelSecret = "test-linepay-secret";
let githubDispatchCount = 0;
let nextTransactionId = 2026072800000000000n;
let nextRefundTransactionId = 2026072890000000000n;
const linePayTransactions = new Map();
const mismatchTransactions = new Set();

function writeJson(res, status, payload, { raw = false } = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(raw ? payload : JSON.stringify(payload));
}

function linePaySignature(req, rawBody) {
  const nonce = String(req.headers["x-line-authorization-nonce"] || "");
  const url = new URL(req.url, "http://localhost");
  const message = req.method === "GET"
    ? `${linePayChannelSecret}${url.pathname}${url.search.slice(1)}${nonce}`
    : `${linePayChannelSecret}${url.pathname}${rawBody}${nonce}`;
  return crypto.createHmac("sha256", linePayChannelSecret).update(message, "utf8").digest("base64");
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const linePayServer = http.createServer(async (req, res) => {
  try {
    const rawBody = await readRawBody(req);
    const suppliedSignature = String(req.headers["x-line-authorization"] || "");
    const suppliedChannel = String(req.headers["x-line-channelid"] || "");
    if (
      suppliedChannel !== linePayChannelId
      || !suppliedSignature
      || suppliedSignature !== linePaySignature(req, rawBody)
    ) {
      writeJson(res, 401, { returnCode: "1104", returnMessage: "Invalid signature" });
      return;
    }

    const url = new URL(req.url, `http://127.0.0.1:${linePayPort}`);
    if (req.method === "POST" && url.pathname === "/v4/payments/request") {
      const request = JSON.parse(rawBody);
      nextTransactionId += 1n;
      const transactionId = nextTransactionId.toString();
      linePayTransactions.set(transactionId, {
        transactionId,
        orderId: String(request.orderId),
        amount: Number(request.amount),
        currency: String(request.currency),
        status: "reserved"
      });
      writeJson(
        res,
        200,
        `{"returnCode":"0000","returnMessage":"Success","info":{"transactionId":${transactionId},"paymentUrl":{"web":"https://sandbox-pay.test/${transactionId}","app":"line://pay/${transactionId}"}}}`,
        { raw: true }
      );
      return;
    }

    const confirmMatch = url.pathname.match(/^\/v4\/payments\/(\d+)\/confirm$/);
    if (req.method === "POST" && confirmMatch) {
      const transaction = linePayTransactions.get(confirmMatch[1]);
      if (!transaction) {
        writeJson(res, 200, { returnCode: "1172", returnMessage: "Transaction not found" });
        return;
      }
      const request = JSON.parse(rawBody);
      transaction.status = "paid";
      const paidAmount = mismatchTransactions.has(transaction.transactionId)
        ? 1
        : Number(request.amount);
      writeJson(
        res,
        200,
        `{"returnCode":"0000","returnMessage":"Success","info":{"orderId":"${transaction.orderId}","transactionId":${transaction.transactionId},"currency":"${transaction.currency}","payInfo":[{"method":"BALANCE","amount":${paidAmount}}]}}`,
        { raw: true }
      );
      return;
    }

    const checkMatch = url.pathname.match(/^\/v4\/payments\/requests\/(\d+)\/check$/);
    if (req.method === "GET" && checkMatch) {
      const transaction = linePayTransactions.get(checkMatch[1]);
      const returnCode = transaction?.status === "paid" ? "0123" : "0110";
      writeJson(res, 200, { returnCode, returnMessage: returnCode === "0110" ? "Reserved" : "Paid" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v4/payments") {
      const transaction = linePayTransactions.get(String(url.searchParams.get("transactionId") || ""));
      if (!transaction) {
        writeJson(res, 200, { returnCode: "0000", returnMessage: "Success", info: [] });
        return;
      }
      writeJson(
        res,
        200,
        `{"returnCode":"0000","returnMessage":"Success","info":[{"orderId":"${transaction.orderId}","transactionId":${transaction.transactionId},"currency":"${transaction.currency}","payInfo":[{"method":"BALANCE","amount":${mismatchTransactions.has(transaction.transactionId) ? 1 : transaction.amount}}]}]}`,
        { raw: true }
      );
      return;
    }

    const refundMatch = url.pathname.match(/^\/v4\/payments\/(\d+)\/refund$/);
    if (req.method === "POST" && refundMatch) {
      const transaction = linePayTransactions.get(refundMatch[1]);
      if (!transaction) {
        writeJson(res, 200, { returnCode: "1172", returnMessage: "Transaction not found" });
        return;
      }
      transaction.status = "refunded";
      nextRefundTransactionId += 1n;
      writeJson(
        res,
        200,
        `{"returnCode":"0000","returnMessage":"Success","info":{"refundTransactionId":${nextRefundTransactionId},"refundAmount":${transaction.amount}}}`,
        { raw: true }
      );
      return;
    }

    writeJson(res, 404, { returnCode: "4040", returnMessage: "Not found" });
  } catch (error) {
    writeJson(res, 500, { returnCode: "5000", returnMessage: error.message });
  }
});

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
  ADMIN_API_KEY: adminKey,
  GITHUB_ACTIONS_TOKEN: "test-server-only-token",
  GITHUB_API_BASE: `http://127.0.0.1:${githubPort}`,
  ACTION_DISPATCH_MINUTES: "15",
  SITE_PUBLIC_BASE_URL: baseUrl,
  API_PUBLIC_BASE_URL: baseUrl,
  LINE_PAY_ENV: "sandbox",
  LINE_PAY_CHANNEL_ID: linePayChannelId,
  LINE_PAY_CHANNEL_SECRET: linePayChannelSecret,
  LINE_PAY_API_BASE_URL: `http://127.0.0.1:${linePayPort}`,
  ECPAY_LEGACY_CALLBACK_ENABLED: "0",
  FULL_REPORT_PRICE_TWD: "499",
  CONSULTATION_DEPOSIT_TWD: "200",
  CONSULTATION_FEE_TWD: "1500",
  CONSULTATION_IG_URL: "https://www.instagram.com/chendino080077/"
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
  return { status: response.status, body, headers: response.headers };
}

async function requestText(pathname, options = {}) {
  const { headers = {}, ...rest } = options;
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { "Content-Type": "application/json", ...headers },
    ...rest
  });
  return { status: response.status, body: await response.text(), headers: response.headers };
}

async function waitForServer() {
  for (let index = 0; index < 40; index += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/database-status`);
      if (response.ok) return;
    } catch {
      await wait(150);
    }
  }
  throw new Error("API server did not start");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function createCheckout(report, productType) {
  return request("/api/payments/checkout", {
    method: "POST",
    body: JSON.stringify({
      reportId: report.id,
      accessCode: report.accessCode,
      productType
    })
  });
}

async function confirmCheckout(checkout) {
  const transactionId = checkout.body.order.providerTradeNo;
  return requestText(
    `/api/payments/linepay/confirm?orderId=${encodeURIComponent(checkout.body.order.id)}&transactionId=${encodeURIComponent(transactionId)}`,
    { redirect: "manual" }
  );
}

async function paymentStatus(checkout, report, headers = {}) {
  return request(
    `/api/payments/${checkout.body.order.id}/status?reportId=${encodeURIComponent(report.id)}`,
    { headers }
  );
}

async function main() {
  await Promise.all([
    new Promise((resolve) => githubServer.listen(githubPort, "127.0.0.1", resolve)),
    new Promise((resolve) => linePayServer.listen(linePayPort, "127.0.0.1", resolve))
  ]);
  const server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, "..", ".."),
    env,
    windowsHide: true,
    stdio: "ignore"
  });
  try {
    await waitForServer();
    const health = await request("/api/health");
    assert(
      health.status === 200
      && health.body.payment?.provider === "linepay"
      && health.body.payment?.configured === true
      && health.body.payment?.environment === "sandbox"
      && health.body.payment?.prices?.fullReport === 499,
      "LINE Pay readiness health check failed"
    );
    const healthRaw = JSON.stringify(health.body);
    assert(!healthRaw.includes(linePayChannelSecret) && !healthRaw.includes(linePayChannelId), "Health endpoint leaked LINE Pay credentials");

    const firstRefresh = await request("/api/market/refresh", { method: "POST" });
    const secondRefresh = await request("/api/market/refresh", { method: "POST" });
    assert(
      firstRefresh.body.githubAction?.dispatched
      && secondRefresh.body.githubAction?.reason === "recent_dispatch_available"
      && githubDispatchCount === 1,
      "GitHub Action dispatch throttling failed"
    );

    const invalid = await request("/api/reports", {
      method: "POST",
      body: JSON.stringify({ checkType: "cashflow", consent: { accepted: false } })
    });
    assert(invalid.status === 400, "Invalid report was not rejected");

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
    assert(created.status === 201 && created.body.report?.accessCode, "Report creation failed");
    const report = created.body.report;

    const wrongCode = await request(`/api/reports/${report.id}`, {
      headers: { "X-Report-Access-Code": "wrong-code" }
    });
    assert(wrongCode.status === 404, "Wrong report access code was accepted");
    const unauthorizedAdmin = await request("/api/admin/reports");
    assert(unauthorizedAdmin.status === 401, "Admin endpoint accepted missing key");
    const forbiddenOrigin = await request("/api/reports", {
      method: "POST",
      headers: { Origin: "https://attacker.example" },
      body: JSON.stringify(submission)
    });
    assert(forbiddenOrigin.status === 403, "Unapproved origin was accepted");

    const checkout = await createCheckout(report, "full_report");
    assert(
      checkout.status === 201
      && checkout.body.order.status === "pending"
      && checkout.body.order.amount === 499
      && checkout.body.order.provider === "linepay"
      && checkout.body.order.statusToken
      && checkout.body.checkout?.provider === "linepay"
      && checkout.body.checkout?.paymentUrl?.web,
      "LINE Pay checkout creation failed"
    );
    assert(
      checkout.body.order.providerTradeNo === "2026072800000000001",
      "Large LINE Pay transaction ID was not preserved as a string"
    );

    const wrongPaymentAccess = await paymentStatus(checkout, report, { "X-Report-Access-Code": "wrong-code" });
    assert(wrongPaymentAccess.status === 404, "Payment status accepted a wrong access code");
    const wrongPaymentToken = await paymentStatus(checkout, report, { "X-Payment-Status-Token": "wrong-token" });
    assert(wrongPaymentToken.status === 404, "Payment status accepted a wrong status token");

    const confirm = await confirmCheckout(checkout);
    assert(confirm.status === 303 && confirm.headers.get("location")?.includes("payment=success"), "LINE Pay confirm did not redirect to success");
    const paid = await paymentStatus(checkout, report, { "X-Payment-Status-Token": checkout.body.order.statusToken });
    assert(
      paid.status === 200
      && paid.body.order.status === "paid"
      && paid.body.order.entitlements.includes("full_report"),
      "Confirmed LINE Pay order did not atomically unlock full report"
    );

    const duplicateConfirm = await confirmCheckout(checkout);
    assert(duplicateConfirm.status === 303 && duplicateConfirm.headers.get("location")?.includes("payment=success"), "Duplicate confirm was not idempotent");
    const afterDuplicate = await paymentStatus(checkout, report, { "X-Payment-Status-Token": checkout.body.order.statusToken });
    assert(
      afterDuplicate.body.order.entitlements.filter((item) => item === "full_report").length === 1,
      "Duplicate confirm duplicated the entitlement"
    );

    const mismatchCheckout = await createCheckout(report, "full_report");
    assert(mismatchCheckout.status === 201, "Mismatch checkout creation failed");
    mismatchTransactions.add(mismatchCheckout.body.order.providerTradeNo);
    const mismatchConfirm = await confirmCheckout(mismatchCheckout);
    assert(
      mismatchConfirm.status === 303 && mismatchConfirm.headers.get("location")?.includes("payment=pending"),
      "Provider amount mismatch was not held for review"
    );
    const mismatchStatus = await paymentStatus(mismatchCheckout, report, {
      "X-Payment-Status-Token": mismatchCheckout.body.order.statusToken
    });
    assert(
      mismatchStatus.status === 200
      && mismatchStatus.body.order.status !== "paid"
      && mismatchStatus.body.providerCheckError?.includes("金額")
      && mismatchStatus.body.order.entitlements.filter((item) => item === "full_report").length === 1,
      `Provider amount mismatch incorrectly unlocked or changed entitlements: ${JSON.stringify(mismatchStatus.body)}`
    );

    const cancelledCheckout = await createCheckout(report, "consultation_deposit");
    const cancel = await requestText(
      `/api/payments/linepay/cancel?orderId=${encodeURIComponent(cancelledCheckout.body.order.id)}`,
      { redirect: "manual" }
    );
    assert(cancel.status === 303 && cancel.headers.get("location")?.includes("payment=cancelled"), "LINE Pay cancel redirect failed");
    const cancelledStatus = await paymentStatus(cancelledCheckout, report, {
      "X-Payment-Status-Token": cancelledCheckout.body.order.statusToken
    });
    assert(
      cancelledStatus.body.order.status === "cancelled"
      && !cancelledStatus.body.order.entitlements.includes("consultation_deposit"),
      "Cancelled order unlocked consultation"
    );

    const consultationCheckout = await createCheckout(report, "consultation_deposit");
    const consultationConfirm = await confirmCheckout(consultationCheckout);
    assert(consultationConfirm.status === 303, "Consultation deposit confirm failed");
    const consultationPaid = await paymentStatus(consultationCheckout, report, {
      "X-Payment-Status-Token": consultationCheckout.body.order.statusToken
    });
    assert(
      consultationPaid.body.order.status === "paid"
      && consultationPaid.body.order.entitlements.includes("consultation_deposit"),
      "Consultation payment did not unlock entitlement"
    );

    const adminHeaders = { Authorization: `Bearer ${adminKey}` };
    const adminPayments = await request("/api/admin/payments", { headers: adminHeaders });
    assert(
      adminPayments.status === 200
      && adminPayments.body.orders.some((order) => order.id === consultationCheckout.body.order.id),
      "Admin payment list failed"
    );
    const refund = await request(`/api/admin/payments/${consultationCheckout.body.order.id}/refund`, {
      method: "POST",
      headers: adminHeaders,
      body: "{}"
    });
    assert(
      refund.status === 200
      && refund.body.order.status === "refunded"
      && refund.body.refundTransactionId === "2026072890000000001",
      `LINE Pay refund failed or lost large refund transaction ID: ${JSON.stringify(refund.body)}`
    );
    const afterRefund = await paymentStatus(consultationCheckout, report, {
      "X-Payment-Status-Token": consultationCheckout.body.order.statusToken
    });
    assert(
      afterRefund.body.order.status === "refunded"
      && !afterRefund.body.order.entitlements.includes("consultation_deposit"),
      "Refund did not revoke consultation entitlement"
    );
    const duplicateRefund = await request(`/api/admin/payments/${consultationCheckout.body.order.id}/refund`, {
      method: "POST",
      headers: adminHeaders,
      body: "{}"
    });
    assert(duplicateRefund.status === 200 && duplicateRefund.body.idempotent === true, "Duplicate refund was not idempotent");

    const legacyNotify = await requestText("/api/payments/ecpay/notify", { method: "POST", body: "" });
    const legacyResult = await requestText("/api/payments/ecpay/result", { method: "POST", body: "" });
    assert(legacyNotify.status === 410 && legacyResult.status === 410, "Legacy ECPay callbacks were not disabled");

    const list = await request("/api/admin/reports", { headers: adminHeaders });
    assert(list.status === 200 && list.body.reports.length === 1, "Admin report list failed");
    const detail = await request(`/api/admin/reports/${report.id}`, { headers: adminHeaders });
    assert(detail.status === 200 && detail.body.report.contact.value === "test-contact", "Admin detail decrypt failed");
    const updated = await request(`/api/admin/reports/${report.id}`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ followupStatus: "converted" })
    });
    assert(updated.status === 200, "Follow-up update failed");
    const analytics = await request("/api/admin/analytics", { headers: adminHeaders });
    assert(analytics.status === 200, "Analytics failed");

    const reopened = await request(`/api/reports/${report.id}`, {
      headers: { "X-Report-Access-Code": report.accessCode }
    });
    assert(reopened.body.report.entitlements.includes("full_report"), "Paid entitlement missing after report reopen");
    assert(!reopened.body.report.entitlements.includes("consultation_deposit"), "Refunded entitlement persisted after report reopen");

    const rawDatabase = [
      path.join(dataDir, "customers.sqlite"),
      path.join(dataDir, "customers.sqlite-wal")
    ].filter(fs.existsSync).map((file) => fs.readFileSync(file).toString("utf8")).join("");
    assert(!rawDatabase.includes("test-contact"), "Contact value was stored as plaintext");

    const deleted = await request(`/api/reports/${report.id}`, {
      method: "DELETE",
      headers: { "X-Report-Access-Code": report.accessCode }
    });
    assert(deleted.status === 200, "Report deletion failed");

    console.log(JSON.stringify({
      passed: true,
      provider: "linepay",
      signedMockApiCalls: true,
      largeTransactionIdsPreserved: true,
      amountMismatchBlocked: true,
      duplicateConfirmIdempotent: true,
      cancellationBlockedEntitlement: true,
      refundRevokedEntitlement: true,
      legacyEcpayCallbacksDisabled: true,
      encryptedDatabaseCreated: fs.existsSync(path.join(dataDir, "customers.sqlite")),
      plaintextContactAbsent: true,
      githubActionDispatchThrottled: true,
      analytics: analytics.body.analytics
    }, null, 2));
  } finally {
    server.kill();
    await Promise.race([
      new Promise((resolve) => server.once("exit", resolve)),
      wait(3000)
    ]);
    await Promise.all([
      new Promise((resolve) => githubServer.close(resolve)),
      new Promise((resolve) => linePayServer.close(resolve))
    ]);
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
