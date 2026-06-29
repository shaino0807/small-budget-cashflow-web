const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { computeCheckMacValue } = require("../ecpay");

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
  ACTION_DISPATCH_MINUTES: "15",
  SITE_PUBLIC_BASE_URL: baseUrl,
  API_PUBLIC_BASE_URL: baseUrl,
  ECPAY_USE_STAGE_DEFAULTS: "1",
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
  return { status: response.status, body };
}

async function requestText(pathname, options = {}) {
  const { headers = {}, ...rest } = options;
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { "Content-Type": "application/json", ...headers },
    ...rest
  });
  return { status: response.status, body: await response.text(), headers: response.headers };
}

function formBody(params) {
  return new URLSearchParams(params).toString();
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
    const health = await request("/api/health");
    if (health.status !== 200 || !health.body.payment?.ecpayConfigured || health.body.payment.prices.fullReport !== 499) {
      throw new Error("Payment readiness health check failed");
    }
    const healthRaw = JSON.stringify(health.body);
    if (healthRaw.includes("pwFHCqoQZGmho4w6") || healthRaw.includes("EkRm7iFT261dpevs")) {
      throw new Error("Health endpoint leaked ECPay secrets");
    }
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

    const checkout = await request("/api/payments/checkout", {
      method: "POST",
      body: JSON.stringify({
        reportId: report.id,
        accessCode: report.accessCode,
        productType: "full_report"
      })
    });
    if (checkout.status !== 201 || checkout.body.order.status !== "pending" || checkout.body.order.amount !== 499 || !checkout.body.order.statusToken) {
      throw new Error("Payment checkout creation failed");
    }
    if (!checkout.body.checkout?.fields?.CheckMacValue || !checkout.body.checkout.action.includes("ecpay")) {
      throw new Error("ECPay checkout form was not generated");
    }

    const unauthorizedPaymentStatus = await request(`/api/payments/${checkout.body.order.id}/status?reportId=${report.id}`, {
      headers: { "X-Report-Access-Code": "wrong-code" }
    });
    if (unauthorizedPaymentStatus.status !== 404) throw new Error("Payment status accepted a wrong access code");

    const wrongPaymentToken = await request(`/api/payments/${checkout.body.order.id}/status?reportId=${report.id}`, {
      headers: { "X-Payment-Status-Token": "wrong-token" }
    });
    if (wrongPaymentToken.status !== 404) throw new Error("Payment status accepted a wrong status token");

    const notifyPayload = {
      MerchantID: "3002607",
      MerchantTradeNo: checkout.body.order.id,
      StoreID: "",
      RtnCode: "1",
      RtnMsg: "Succeeded",
      TradeNo: "stage-test-trade-no",
      TradeAmt: "499",
      PaymentDate: "2026/06/29 12:00:00",
      PaymentType: "Credit_CreditCard",
      PaymentTypeChargeFee: "0",
      TradeDate: "2026/06/29 11:59:00",
      SimulatePaid: "1",
      CustomField1: report.id,
      CustomField2: "full_report",
      CustomField3: "",
      CustomField4: ""
    };

    const invalidMacPayload = { ...notifyPayload, CheckMacValue: "INVALID" };
    const invalidMacNotify = await requestText("/api/payments/ecpay/notify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody(invalidMacPayload)
    });
    if (invalidMacNotify.status !== 400 || invalidMacNotify.body !== "0|INVALID") {
      throw new Error("Invalid ECPay CheckMacValue was not rejected");
    }
    const statusAfterInvalidMac = await request(`/api/payments/${checkout.body.order.id}/status?reportId=${report.id}`, {
      headers: { "X-Payment-Status-Token": checkout.body.order.statusToken }
    });
    if (statusAfterInvalidMac.status !== 200 || statusAfterInvalidMac.body.order.status !== "pending") {
      throw new Error("Invalid ECPay notification changed the order status");
    }

    const mismatchCheckout = await request("/api/payments/checkout", {
      method: "POST",
      body: JSON.stringify({
        reportId: report.id,
        accessCode: report.accessCode,
        productType: "full_report"
      })
    });
    if (mismatchCheckout.status !== 201 || mismatchCheckout.body.order.status !== "pending") {
      throw new Error("Amount mismatch checkout creation failed");
    }
    const mismatchNotifyPayload = {
      ...notifyPayload,
      MerchantTradeNo: mismatchCheckout.body.order.id,
      TradeNo: "stage-test-mismatch-trade-no",
      TradeAmt: "1"
    };
    mismatchNotifyPayload.CheckMacValue = computeCheckMacValue(mismatchNotifyPayload, "pwFHCqoQZGmho4w6", "EkRm7iFT261dpevs");
    const mismatchNotify = await requestText("/api/payments/ecpay/notify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody(mismatchNotifyPayload)
    });
    if (mismatchNotify.status !== 200 || mismatchNotify.body !== "1|OK") {
      throw new Error("Valid amount-mismatch callback was not acknowledged");
    }
    const mismatchStatus = await request(`/api/payments/${mismatchCheckout.body.order.id}/status?reportId=${report.id}`, {
      headers: { "X-Payment-Status-Token": mismatchCheckout.body.order.statusToken }
    });
    if (mismatchStatus.status !== 200 || mismatchStatus.body.order.status !== "failed" || mismatchStatus.body.order.entitlements.includes("full_report")) {
      throw new Error("Amount mismatch did not fail the order without entitlement");
    }

    notifyPayload.CheckMacValue = computeCheckMacValue(notifyPayload, "pwFHCqoQZGmho4w6", "EkRm7iFT261dpevs");
    const notify = await requestText("/api/payments/ecpay/notify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody(notifyPayload)
    });
    if (notify.status !== 200 || notify.body !== "1|OK") throw new Error("ECPay notify was not accepted");

    const paymentStatus = await request(`/api/payments/${checkout.body.order.id}/status?reportId=${report.id}`, {
      headers: { "X-Report-Access-Code": report.accessCode }
    });
    if (paymentStatus.status !== 200 || paymentStatus.body.order.status !== "paid" || !paymentStatus.body.order.entitlements.includes("full_report")) {
      throw new Error("Paid order did not unlock full report entitlement");
    }

    const duplicateNotify = await requestText("/api/payments/ecpay/notify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody(notifyPayload)
    });
    if (duplicateNotify.status !== 200 || duplicateNotify.body !== "1|OK") {
      throw new Error("Duplicate ECPay notify was not idempotent");
    }
    const duplicateStatus = await request(`/api/payments/${checkout.body.order.id}/status?reportId=${report.id}`, {
      headers: { "X-Payment-Status-Token": checkout.body.order.statusToken }
    });
    const duplicateFullReportEntitlements = duplicateStatus.body.order.entitlements.filter((entitlement) => entitlement === "full_report");
    if (duplicateStatus.status !== 200 || duplicateStatus.body.order.status !== "paid" || duplicateFullReportEntitlements.length !== 1) {
      throw new Error("Duplicate ECPay notify duplicated or damaged the entitlement");
    }

    const tokenPaymentStatus = await request(`/api/payments/${checkout.body.order.id}/status?reportId=${report.id}`, {
      headers: { "X-Payment-Status-Token": checkout.body.order.statusToken }
    });
    if (tokenPaymentStatus.status !== 200 || tokenPaymentStatus.body.order.status !== "paid" || !tokenPaymentStatus.body.order.entitlements.includes("full_report")) {
      throw new Error("Payment status token did not survive redirect-style lookup");
    }

    const reopenedAfterPayment = await request(`/api/reports/${report.id}`, {
      headers: { "X-Report-Access-Code": report.accessCode }
    });
    if (!reopenedAfterPayment.body.report.entitlements.includes("full_report")) {
      throw new Error("Report entitlement was not returned after payment");
    }

    const consultationCheckout = await request("/api/payments/checkout", {
      method: "POST",
      body: JSON.stringify({
        reportId: report.id,
        accessCode: report.accessCode,
        productType: "consultation_deposit"
      })
    });
    if (consultationCheckout.status !== 201 || consultationCheckout.body.order.status !== "pending" || consultationCheckout.body.order.amount !== 200) {
      throw new Error("Consultation deposit checkout creation failed");
    }

    const consultationNotifyPayload = {
      ...notifyPayload,
      MerchantTradeNo: consultationCheckout.body.order.id,
      TradeNo: "stage-test-consultation-trade-no",
      TradeAmt: "200",
      CustomField2: "consultation_deposit"
    };
    consultationNotifyPayload.CheckMacValue = computeCheckMacValue(consultationNotifyPayload, "pwFHCqoQZGmho4w6", "EkRm7iFT261dpevs");
    const consultationNotify = await requestText("/api/payments/ecpay/notify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody(consultationNotifyPayload)
    });
    if (consultationNotify.status !== 200 || consultationNotify.body !== "1|OK") {
      throw new Error("Consultation deposit notify was not accepted");
    }

    const consultationStatus = await request(`/api/payments/${consultationCheckout.body.order.id}/status?reportId=${report.id}`, {
      headers: { "X-Payment-Status-Token": consultationCheckout.body.order.statusToken }
    });
    if (consultationStatus.status !== 200 || consultationStatus.body.order.status !== "paid" || !consultationStatus.body.order.entitlements.includes("consultation_deposit")) {
      throw new Error("Paid consultation deposit did not unlock consultation entitlement");
    }

    const resultRedirect = await requestText("/api/payments/ecpay/result", {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody(notifyPayload)
    });
    if (resultRedirect.status !== 303 || !resultRedirect.headers.get("location")?.includes("payment=success")) {
      throw new Error("Payment result did not redirect to the success page");
    }

    const failedResultPayload = { ...notifyPayload, RtnCode: "0", RtnMsg: "Failed" };
    failedResultPayload.CheckMacValue = computeCheckMacValue(failedResultPayload, "pwFHCqoQZGmho4w6", "EkRm7iFT261dpevs");
    const failedResultRedirect = await requestText("/api/payments/ecpay/result", {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody(failedResultPayload)
    });
    if (failedResultRedirect.status !== 303 || !failedResultRedirect.headers.get("location")?.includes("payment=failed")) {
      throw new Error("Payment result did not redirect to the failed page");
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
