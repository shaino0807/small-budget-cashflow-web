const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { parseLedgerMessage } = require("../line-bot");

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

function request(pathname, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(body || "", "utf8");
    const req = http.request(`${baseUrl}${pathname}`, {
      method: "POST",
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
    ["買 0056 10000", "investment", 10000],
    ["ETF 00878 5000", "investment", 5000]
  ];
  for (const [text, type, amount] of parserCases) {
    const parsed = parseLedgerMessage(text);
    if (parsed.type !== type || parsed.amount !== amount) {
      throw new Error(`Parser failed for ${text}: ${JSON.stringify(parsed)}`);
    }
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
    if (!health.line?.configured || !health.line.replyDisabled) {
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
    const invalid = await request("/api/line/webhook", {
      body,
      headers: { "x-line-signature": "invalid-signature" }
    });
    if (invalid.status !== 401) {
      throw new Error(`Invalid LINE signature was not rejected: ${JSON.stringify(invalid)}`);
    }
    console.log(JSON.stringify({ ok: true, valid: valid.body, invalid: invalid.body }, null, 2));
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
