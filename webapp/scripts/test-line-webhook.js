const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { parseIncomingMessage, parseLedgerMessage, parseLedgerMessageWithAi, parseLineCommand } = require("../line-bot");

const port = 5900 + Math.floor(Math.random() * 250);
const baseUrl = `http://127.0.0.1:${port}`;
const lineSecret = "test-line-channel-secret-32chars";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cashflow-line-webhook-"));

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signature(body) {
  return crypto.createHmac("sha256", lineSecret).update(body).digest("base64");
}

function request(pathname, { method = "POST", body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(body || "", "utf8");
    const req = http.request(`${baseUrl}${pathname}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": payload.length,
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

async function waitForServer() {
  for (let index = 0; index < 40; index++) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return response.json();
    } catch {
      await wait(150);
    }
  }
  throw new Error("API server did not start");
}

async function main() {
  const parserCases = [
    ["買早餐 65", "expense", 65],
    ["今天賺 3000", "income", 3000],
    ["固定收入金額 50000", "income", 50000, "固定收入"],
    ["月薪 5萬", "income", 50000, "固定收入"],
    ["昨天付房租 1.2萬", "expense", 12000, "房租"],
    ["繳保險 3000", "expense", 3000, "保險"],
    ["繳房貸 2萬", "expense", 20000, "貸款"],
    ["買 0056 10000", "investment", 10000],
    ["ETF 00878 5000", "investment", 5000]
  ];
  for (const [text, type, amount, category] of parserCases) {
    const parsed = parseLedgerMessage(text);
    if (parsed.type !== type || parsed.amount !== amount || (category && parsed.category !== category)) {
      throw new Error(`Parser failed for ${text}: ${JSON.stringify(parsed)}`);
    }
  }
  const commandCases = [
    ["查明細", "details"],
    ["修改上一筆 80", "update_last"],
    ["上一筆改成 120", "update_last"],
    ["修改第2筆 180", "update_indexed"],
    ["刪除上一筆", "delete_last"],
    ["刪除第3筆", "delete_indexed"],
    ["刪除全部資料", "request_delete_all"],
    ["確認刪除全部資料", "confirm_delete_all"]
  ];
  for (const [text, command] of commandCases) {
    const parsed = parseLineCommand(text);
    if (parsed?.command !== command) throw new Error(`Command parser failed for ${text}: ${JSON.stringify(parsed)}`);
  }
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      output_text: JSON.stringify({
        entries: [
          { type: "expense", amount: 120, category: "餐飲", ticker: null, note: "午餐", occurredAt: "2026-07-15T04:00:00.000Z" },
          { type: "expense", amount: 60, category: "餐飲", ticker: null, note: "飲料", occurredAt: "2026-07-15T04:00:00.000Z" }
        ]
      })
    })
  });
  try {
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.LINE_AI_PARSER_ENABLED = "1";
    const aiParsed = await parseLedgerMessageWithAi("午餐 120、飲料 60");
    if (aiParsed?.entries?.length !== 2 || aiParsed.entries.reduce((sum, entry) => sum + entry.amount, 0) !== 180) {
      throw new Error(`AI parser schema validation failed: ${JSON.stringify(aiParsed)}`);
    }
    const routedAiParsed = await parseIncomingMessage("午餐 120、飲料 60");
    if (routedAiParsed?.parser !== "ai" || routedAiParsed.entries?.length !== 2) {
      throw new Error(`AI parser routing failed: ${JSON.stringify(routedAiParsed)}`);
    }
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.LINE_AI_PARSER_ENABLED;
    global.fetch = originalFetch;
  }
  const server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, "..", ".."),
    env: {
      ...process.env,
      PORT: String(port),
      CUSTOMER_DATA_DIR: dataDir,
      CUSTOMER_DATA_KEY: crypto.randomBytes(32).toString("base64"),
      ACCESS_CODE_PEPPER: crypto.randomBytes(24).toString("base64url"),
      ADMIN_API_KEY: crypto.randomBytes(24).toString("base64url"),
      LINE_CHANNEL_SECRET: lineSecret,
      LINE_CHANNEL_ACCESS_TOKEN: "test-line-channel-access-token-32chars",
      LINE_REPLY_DISABLED: "1"
    },
    windowsHide: true,
    stdio: "ignore"
  });
  try {
    const health = await waitForServer();
    if (
      !health.line?.configured
      || !health.line.replyDisabled
      || !health.line.webSyncEnabled
      || !health.line.ledgerCommandsEnabled
      || health.line.richMenu?.status !== "disabled"
      || health.line.aiParser?.status !== "disabled"
    ) {
      throw new Error("LINE readiness health check failed");
    }
    const body = JSON.stringify({
      destination: "test",
      events: [{
        type: "message",
        replyToken: "test-reply-token",
        source: { type: "user", userId: "Utest" },
        message: { id: "1", type: "text", text: "買早餐 65" }
      }]
    });
    const valid = await request("/api/line/webhook", {
      body,
      headers: { "x-line-signature": signature(body) }
    });
    if (
      valid.status !== 200
      || valid.body.receivedEvents !== 1
      || valid.body.replies[0]?.reason !== "reply_disabled"
      || valid.body.replies[0]?.parsedIntent !== "ledger"
      || valid.body.replies[0]?.ledgerType !== "expense"
    ) {
      throw new Error(`Valid LINE webhook failed: ${JSON.stringify(valid)}`);
    }
    const duplicate = await request("/api/line/webhook", {
      body,
      headers: { "x-line-signature": signature(body) }
    });
    if (duplicate.status !== 200 || duplicate.body.replies[0]?.reason !== "reply_disabled") {
      throw new Error(`Duplicate LINE webhook was not handled idempotently: ${JSON.stringify(duplicate)}`);
    }
    const created = await request("/api/reports", {
      body: JSON.stringify({
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
          status: "green",
          breakdown: {},
          prescription: {},
          stockSafety: { level: "green" },
          risks: []
        }
      })
    });
    if (created.status !== 201 || !created.body.report?.accessCode) {
      throw new Error(`Report creation for LINE binding failed: ${JSON.stringify(created)}`);
    }
    const binding = await request("/api/line/bindings", {
      body: JSON.stringify({ reportId: created.body.report.id, accessCode: created.body.report.accessCode })
    });
    if (binding.status !== 201 || !/^\d{6}$/.test(binding.body.binding?.code || "")) {
      throw new Error(`LINE binding code creation failed: ${JSON.stringify(binding)}`);
    }
    const bindingBody = JSON.stringify({
      destination: "test",
      events: [{
        type: "message",
        replyToken: "test-reply-token",
        source: { type: "user", userId: "Utest" },
        message: { id: "2", type: "text", text: `綁定 ${binding.body.binding.code}` }
      }]
    });
    const bound = await request("/api/line/webhook", {
      body: bindingBody,
      headers: { "x-line-signature": signature(bindingBody) }
    });
    if (bound.status !== 200 || bound.body.replies[0]?.parsedIntent !== "binding" || bound.body.replies[0]?.binding !== "linked") {
      throw new Error(`LINE binding webhook failed: ${JSON.stringify(bound)}`);
    }
    const ledgerMessages = [
      ["3", "固定收入金額 50000"],
      ["4", "買 0056 10000"],
      ["5", "ETF 00878 5000"]
    ];
    for (const [id, text] of ledgerMessages) {
      const ledgerBody = JSON.stringify({
        destination: "test",
        events: [{
          type: "message",
          replyToken: "test-reply-token",
          source: { type: "user", userId: "Utest" },
          message: { id, type: "text", text }
        }]
      });
      const ledger = await request("/api/line/webhook", {
        body: ledgerBody,
        headers: { "x-line-signature": signature(ledgerBody) }
      });
      if (ledger.status !== 200 || ledger.body.replies[0]?.parsedIntent !== "ledger") {
        throw new Error(`LINE sync ledger message failed: ${JSON.stringify(ledger)}`);
      }
    }
    const summary = await request(`/api/line/summary?reportId=${encodeURIComponent(created.body.report.id)}`, {
      method: "GET",
      headers: { "X-Report-Access-Code": created.body.report.accessCode }
    });
    const positions = Object.fromEntries((summary.body.summary?.etfPositions || []).map((position) => [position.ticker, position.amount]));
    if (
      summary.status !== 200
      || !summary.body.summary?.linked
      || summary.body.summary.expense !== 65
      || summary.body.summary.income !== 50000
      || summary.body.summary.investment !== 15000
      || positions["0056"] !== 10000
      || positions["00878"] !== 5000
    ) {
      throw new Error(`LINE report summary did not include the ledger: ${JSON.stringify(summary)}`);
    }
    const sendCommand = async (id, text) => {
      const commandBody = JSON.stringify({
        destination: "test",
        events: [{
          type: "message",
          replyToken: "test-reply-token",
          source: { type: "user", userId: "Utest" },
          message: { id, type: "text", text }
        }]
      });
      return request("/api/line/webhook", {
        body: commandBody,
        headers: { "x-line-signature": signature(commandBody) }
      });
    };
    const details = await sendCommand("6", "查明細");
    if (details.status !== 200 || details.body.replies[0]?.command !== "details") {
      throw new Error(`LINE details command failed: ${JSON.stringify(details)}`);
    }
    const modified = await sendCommand("7", "修改上一筆 6000");
    const modifiedDuplicate = await sendCommand("7", "修改上一筆 6000");
    if (
      modified.status !== 200
      || modified.body.replies[0]?.command !== "update_last"
      || modified.body.replies[0]?.commandDuplicate
      || !modifiedDuplicate.body.replies[0]?.commandDuplicate
    ) {
      throw new Error(`LINE update command was not idempotent: ${JSON.stringify({ modified, modifiedDuplicate })}`);
    }
    const modifiedSummary = await request(`/api/line/summary?reportId=${encodeURIComponent(created.body.report.id)}`, {
      method: "GET",
      headers: { "X-Report-Access-Code": created.body.report.accessCode }
    });
    const modifiedPositions = Object.fromEntries((modifiedSummary.body.summary?.etfPositions || []).map((position) => [position.ticker, position.amount]));
    if (modifiedSummary.body.summary.investment !== 16000 || modifiedPositions["00878"] !== 6000) {
      throw new Error(`LINE update command changed the wrong entry: ${JSON.stringify(modifiedSummary)}`);
    }
    const deleted = await sendCommand("8", "刪除上一筆");
    const deletedDuplicate = await sendCommand("8", "刪除上一筆");
    if (
      deleted.status !== 200
      || deleted.body.replies[0]?.command !== "delete_last"
      || deleted.body.replies[0]?.commandDuplicate
      || !deletedDuplicate.body.replies[0]?.commandDuplicate
    ) {
      throw new Error(`LINE delete command was not idempotent: ${JSON.stringify({ deleted, deletedDuplicate })}`);
    }
    const finalSummary = await request(`/api/line/summary?reportId=${encodeURIComponent(created.body.report.id)}`, {
      method: "GET",
      headers: { "X-Report-Access-Code": created.body.report.accessCode }
    });
    const finalPositions = Object.fromEntries((finalSummary.body.summary?.etfPositions || []).map((position) => [position.ticker, position.amount]));
    if (finalSummary.body.summary.investment !== 10000 || finalPositions["0056"] !== 10000 || finalPositions["00878"] !== undefined) {
      throw new Error(`LINE duplicate delete removed more than one entry: ${JSON.stringify(finalSummary)}`);
    }
    const reportId = created.body.report.id;
    const reportAccess = { "X-Report-Access-Code": created.body.report.accessCode };
    const cashflow = await request(`/api/users/me/cashflow?reportId=${encodeURIComponent(reportId)}`, { method: "GET", headers: reportAccess });
    if (cashflow.status !== 200 || cashflow.body.cashflow?.profile?.monthlyIncome !== 50000 || cashflow.body.cashflow?.holdings?.[0]?.ticker !== "0056") {
      throw new Error(`Full cashflow API failed: ${JSON.stringify(cashflow)}`);
    }
    const webEntry = await request("/api/ledger", {
      body: JSON.stringify({ reportId, requestId: "web-ledger-1", type: "expense", amount: 900, category: "交通", note: "月票" }),
      headers: reportAccess
    });
    if (webEntry.status !== 201 || !webEntry.body.entry?.id) throw new Error(`Ledger POST failed: ${JSON.stringify(webEntry)}`);
    const duplicateWebEntry = await request("/api/ledger", {
      body: JSON.stringify({ reportId, requestId: "web-ledger-1", type: "expense", amount: 900, category: "交通", note: "月票" }),
      headers: reportAccess
    });
    if (duplicateWebEntry.status !== 409) throw new Error(`Duplicate web ledger request was accepted: ${JSON.stringify(duplicateWebEntry)}`);
    const patchedEntry = await request(`/api/ledger/${webEntry.body.entry.id}`, {
      method: "PATCH",
      body: JSON.stringify({ reportId, patch: { amount: 1000 } }),
      headers: reportAccess
    });
    if (patchedEntry.status !== 200 || patchedEntry.body.entry.amount !== 1000) throw new Error(`Ledger PATCH failed: ${JSON.stringify(patchedEntry)}`);
    const profile = await request("/api/profile", {
      method: "PATCH",
      body: JSON.stringify({ reportId, profile: { monthlyIncome: 52000, insuranceExpense: 2500 } }),
      headers: reportAccess
    });
    if (profile.status !== 200 || profile.body.profile.monthlyIncome !== 52000 || profile.body.profile.insuranceExpense !== 2500) {
      throw new Error(`Profile PATCH failed: ${JSON.stringify(profile)}`);
    }
    const holdings = await request("/api/holdings", {
      method: "PATCH",
      body: JSON.stringify({ reportId, holdings: [{ ticker: "0056", amount: 15000 }, { ticker: "006208", amount: 8000 }] }),
      headers: reportAccess
    });
    if (holdings.status !== 200 || holdings.body.holdings.length !== 2) throw new Error(`Holdings PATCH failed: ${JSON.stringify(holdings)}`);
    const deletedEntry = await request(`/api/ledger/${webEntry.body.entry.id}?reportId=${encodeURIComponent(reportId)}`, {
      method: "DELETE",
      headers: reportAccess
    });
    if (deletedEntry.status !== 200 || deletedEntry.body.deleted.amount !== 1000) throw new Error(`Ledger DELETE failed: ${JSON.stringify(deletedEntry)}`);
    const unconfirmedDelete = await request(`/api/users/me/data?reportId=${encodeURIComponent(reportId)}`, { method: "DELETE", headers: reportAccess });
    if (unconfirmedDelete.status !== 400) throw new Error(`Unconfirmed data deletion was accepted: ${JSON.stringify(unconfirmedDelete)}`);
    const confirmedDelete = await request(`/api/users/me/data?reportId=${encodeURIComponent(reportId)}`, {
      method: "DELETE",
      headers: { ...reportAccess, "X-Confirm-Delete": "DELETE LINE DATA" }
    });
    if (confirmedDelete.status !== 200 || confirmedDelete.body.deleted.ledgerEntries < 1 || confirmedDelete.body.deleted.bindings !== 1) {
      throw new Error(`Confirmed data deletion failed: ${JSON.stringify(confirmedDelete)}`);
    }
    const afterPrivacyDelete = await request(`/api/users/me/cashflow?reportId=${encodeURIComponent(reportId)}`, { method: "GET", headers: reportAccess });
    if (afterPrivacyDelete.status !== 409) throw new Error(`Deleted LINE data remained linked: ${JSON.stringify(afterPrivacyDelete)}`);
    const invalid = await request("/api/line/webhook", {
      body,
      headers: { "x-line-signature": "invalid-signature" }
    });
    if (invalid.status !== 401) {
      throw new Error(`Invalid LINE signature was not rejected: ${JSON.stringify(invalid)}`);
    }
    console.log(JSON.stringify({
      ok: true,
      valid: valid.body,
      bound: bound.body,
      beforeCommands: summary.body.summary,
      afterCommands: finalSummary.body.summary,
      commandIdempotency: true,
      ledgerApiCrud: true,
      profileAndHoldingsApi: true,
      privacyDelete: true,
      invalid: invalid.body
    }, null, 2));
  } finally {
    if (!server.killed) server.kill();
    await wait(200);
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
