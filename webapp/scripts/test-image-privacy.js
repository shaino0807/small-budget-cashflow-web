const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
process.env.CUSTOMER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "image-privacy-"));
process.env.CUSTOMER_DATA_KEY = crypto.randomBytes(32).toString("base64");
process.env.ACCESS_CODE_PEPPER = crypto.randomBytes(32).toString("hex");
process.env.LINE_REPLY_DISABLED = "1";
process.env.LINE_AI_PARSER_ENABLED = "0";
process.env.LINE_IMAGE_PARSER_ENABLED = "0";
process.env.OPENAI_API_KEY = "synthetic-only";
process.env.LINE_CHANNEL_ACCESS_TOKEN = "synthetic-only";
global.fetch = async () => { throw new Error("External network forbidden"); };
const { createStore } = require("../customer-store");
const { handleLineWebhook, statementReviewText } = require("../line-bot");
const { validateStatement, clarifyStatement, readStatementImage, parseStatementImage } = require("../statement-reader");
const store = createStore();
const db = new DatabaseSync(path.join(process.env.CUSTOMER_DATA_DIR, "customers.sqlite"));
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.from("synthetic-image-private-marker")]);
const row = { date: "2026-09-01", dateEvidence: "2026-09-01", amount: 230, currency: "TWD", kind: "expense", description: "synthetic-private-merchant" };
const payload = { complete: true, warnings: [], rows: [row] };
let seq = 0, calls = 0;
const event = (user, type, text, id = `event-${++seq}`, sourceType = "user") => JSON.stringify({ events: [{ type: "message", source: { type: sourceType, userId: user }, message: { type, id, text } }] });
const text = (user, value, sourceType) => handleLineWebhook(event(user, "text", value, undefined, sourceType), { store });
const fakeFetch = async (url, options) => {
  calls++;
  assert.equal(options.redirect, "error");
  assert.ok(options.signal instanceof AbortSignal);
  if (url.startsWith("https://api-data.line.me/")) return new Response(png, { headers: { "content-type": "image/png" } });
  assert.equal(url, "https://api.openai.com/v1/responses");
  const body = JSON.parse(options.body);
  assert.equal(body.store, false);
  assert.equal(body.text.format.strict, true);
  return Response.json({ status: "completed", output_text: JSON.stringify(payload) });
};
const image = (user, fetchImpl = fakeFetch, id, sourceType) => handleLineWebhook(event(user, "image", undefined, id, sourceType), { store, fetchImpl });
async function main() {
  store.setLineImageConsent("disabled", true);
  await image("disabled"); assert.equal(calls, 0, "disabled must not download");
  delete process.env.LINE_IMAGE_PARSER_ENABLED;
  await image("disabled"); assert.equal(calls, 0, "missing operator flag must not download");
  // Only this isolated, network-denied process enables the branch under test.
  process.env.LINE_IMAGE_PARSER_ENABLED = "1";
  await image("no-consent"); assert.equal(calls, 0);
  store.setLineImageConsent("group", true);
  await image("group", fakeFetch, "group-image", "group"); assert.equal(calls, 0);
  const key = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  await image("disabled"); assert.equal(calls, 0);
  process.env.OPENAI_API_KEY = key;
  await text("no-consent", "同意並啟用圖片記帳"); assert.equal(store.lineImageConsent("no-consent"), false);

  for (const patch of [{ complete: false }, { warnings: ["secret 1234567890123456"] }, { warnings: [null] }, { rows: Array(41).fill(row) }]) {
    try { assert.ok(validateStatement({ ...payload, ...patch }).unresolved.length); } catch (error) { if (error.code === "ERR_ASSERTION") throw error; }
  }
  for (const patch of [{ dateEvidence: null }, { dateEvidence: "09/01" }, { dateEvidence: "2025-09-01" }, { dateEvidence: "" }, { date: null }, { date: "2026-02-30" }, { amount: -1 }, { amount: 2.5 }, { currency: "USD" }, { kind: "card_payment" }, { kind: "transfer" }, { kind: "investment" }, { description: {} }, { description: " " }, { description: "a".repeat(81) }, { description: "1234 5678 9012 3456" }, { description: "信用卡繳款" }, { description: "匯款" }]) {
    const result = validateStatement({ ...payload, rows: [{ ...row, ...patch }] });
    assert.equal(result.entries.length, 0);
    assert.ok(result.unresolved.length);
    assert.ok(!JSON.stringify(result).includes("1234 5678"));
  }
  for (const response of [{ status: "incomplete" }, { output_text: JSON.stringify(payload) }, { status: "completed", output_text: "not json" }, { status: "completed", output: [{ content: [{ type: "refusal", refusal: "secret" }] }] }]) {
    await assert.rejects(parseStatementImage({ type: "image/png", buffer: png }, { fetchImpl: async () => Response.json(response) }));
  }
  await assert.rejects(readStatementImage("bad-mime", { fetchImpl: async () => new Response(png, { headers: { "content-type": "text/html" } }) }));
  await assert.rejects(readStatementImage("spoof", { fetchImpl: async () => new Response("not png", { headers: { "content-type": "image/png" } }) }));
  await assert.rejects(readStatementImage("oversize", { fetchImpl: async () => new Response(Buffer.alloc(8 * 1024 * 1024 + 1), { headers: { "content-type": "image/png" } }) }));

  store.setLineImageConsent("confirmed", true);
  await image("confirmed");
  assert.equal(store.lineLedgerSummary("confirmed").expense, 0);
  const pending = db.prepare("SELECT payload_cipher FROM line_pending_inputs").all();
  assert.ok(!JSON.stringify(pending).includes(row.description));
  assert.ok(!fs.readFileSync(path.join(process.env.CUSTOMER_DATA_DIR, "customers.sqlite")).includes(png));
  await text("confirmed", "確認記帳", "group");
  assert.equal(store.lineLedgerSummary("confirmed", "2026-09").expense, 0);
  process.env.LINE_IMAGE_PARSER_ENABLED = "0";
  await text("confirmed", "確認記帳");
  assert.equal(store.lineLedgerSummary("confirmed", "2026-09").expense, 0, "kill switch also gates confirmation");
  process.env.LINE_IMAGE_PARSER_ENABLED = "1";
  await text("confirmed", "確認記帳");
  assert.equal(store.lineLedgerSummary("confirmed", "2026-09").expense, 230);
  assert.equal(store.lineBatchDuplicateWarnings("new-user", validateStatement({ ...payload, rows: [row, row] }).entries).length, 1);

  // Merchant rows remain visible when the screenshot has month/day but no year.
  // No personal card details or real image bytes are used in these fixtures.
  const merchantRows = [
    ["09/08", "台灣聯通停車場", 180], ["09/08", "黑市鍋物", 990],
    ["09/06", "台哥大帳單－網路／語音", 1449], ["09/06", "台哥大帳單代收富邦產險", 198],
    ["09/06", "UBER *TRIP HELPUBER.COM", 650], ["09/06", "國外交易手續費", 10],
    ["09/06", "LOTTEGIMHAEGONGHANGM…", 1536], ["09/06", "國外交易手續費", 23]
  ].map(([dateEvidence, description, amount]) => ({ date: null, dateEvidence, description, amount, currency: "unknown", kind: "expense" }));
  const partial = validateStatement({ complete: true, warnings: [], rows: merchantRows });
  assert.equal(partial.entries.length, 0);
  assert.equal(partial.reviewLines.length, 8);
  assert.ok(partial.clarification);
  assert.match(statementReviewText(partial), /已擷取 8 筆/);
  assert.match(statementReviewText(partial), /台灣聯通停車場｜交通｜金額 180/);
  assert.match(statementReviewText(partial), /缺少年份/);
  assert.match(statementReviewText(partial), /缺少幣別/);
  assert.ok(!statementReviewText(partial).includes("辨識 0 筆"));
  const completed = clarifyStatement(partial.clarification, 2026, "TWD");
  assert.equal(completed.unresolved.length, 0);
  assert.equal(completed.entries.reduce((sum, entry) => sum + entry.amount, 0), 5036);
  assert.deepEqual(completed.entries.map(entry => entry.category), ["交通", "伙食", "生活帳單", "保險", "交通", "手續費", "其他支出", "手續費"]);
  assert.equal(clarifyStatement({ rows: [{ ...merchantRows[0], dateEvidence: "02/29" }] }, 2025, "TWD").entries.length, 0);
  for (const patch of [{ amount: null }, { kind: "card_payment" }, { description: "卡號：1234 5678 9012 3456" }, { currency: "USD" }]) {
    const rejected = validateStatement({ complete: true, warnings: [], rows: [{ ...merchantRows[0], ...patch }] });
    assert.equal(rejected.clarification, null);
    assert.ok(!statementReviewText(rejected).includes("1234 5678"));
  }
  payload.rows = merchantRows;
  store.setLineImageConsent("year-review", true);
  await image("year-review");
  assert.equal(store.linePendingInput("year-review").type, "image_clarification");
  const callsBeforeClarification = calls;
  await text("year-review", "確認記帳");
  assert.equal(store.lineLedgerSummary("year-review", "2026-09").expense, 0);
  await text("year-review", "圖片補充 2026 台幣", "group");
  assert.equal(store.linePendingInput("year-review").type, "image_clarification");
  process.env.LINE_IMAGE_PARSER_ENABLED = "0";
  await text("year-review", "圖片補充 2026 台幣");
  assert.equal(store.linePendingInput("year-review").type, "image_clarification");
  process.env.LINE_IMAGE_PARSER_ENABLED = "1";
  await text("year-review", "圖片補充 2026 USD");
  assert.equal(store.linePendingInput("year-review").type, "image_clarification");
  await text("year-review", "圖片補充 2026 台幣");
  assert.equal(calls, callsBeforeClarification, "clarification must not call image API again");
  assert.equal(store.linePendingInput("year-review").type, "batch_confirmation");
  assert.equal(store.lineLedgerSummary("year-review", "2026-09").expense, 0);
  await text("year-review", "確認記帳");
  assert.equal(store.lineLedgerSummary("year-review", "2026-09").expense, 5036);
  await image("year-review");
  assert.equal(calls, callsBeforeClarification + 1, "duplicate image must stop before OpenAI");
  for (const command of ["取消", "停用圖片記帳"]) {
    const user = `partial-${command}`;
    store.setLineImageConsent(user, true);
    await image(user);
    await text(user, command);
    await text(user, "圖片補充 2026 台幣");
    assert.equal(store.linePendingInput(user), null);
    assert.equal(store.lineLedgerSummary(user, "2026-09").expense, 0);
  }
  store.setLineImageConsent("year-expiry", true);
  await image("year-expiry");
  db.prepare("UPDATE line_pending_inputs SET expires_at = '2000-01-01T00:00:00Z'").run();
  await text("year-expiry", "圖片補充 2026 台幣");
  assert.equal(store.linePendingInput("year-expiry"), null);
  payload.rows = [row];

  // Cancel or disable while the external response is in flight; late responses cannot resurrect a draft.
  for (const command of ["取消", "停用圖片記帳"]) {
    const user = `race-${command}`;
    store.setLineImageConsent(user, true);
    let release, entered;
    const reached = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const task = image(user, async (url, options) => {
      if (url.includes("api.openai.com")) { entered(); await gate; }
      return fakeFetch(url, options);
    });
    await reached;
    const callsBeforeDuplicate = calls;
    await image(user);
    assert.equal(calls, callsBeforeDuplicate, "parallel image must preserve the in-flight request");
    assert.equal(store.linePendingInput(user).type, "image_processing");
    await text(user, command);
    if (command === "停用圖片記帳") store.setLineImageConsent(user, true);
    release(); await task;
    assert.equal(store.linePendingInput(user), null);
    assert.equal(store.lineLedgerSummary(user, "2026-09").expense, 0);
  }
  // Capture a synthetic reply locally; a thrown provider error must not escape to LINE.
  const deniedFetch = global.fetch;
  let capturedReply;
  store.setLineImageConsent("provider-error", true);
  try {
    process.env.LINE_REPLY_DISABLED = "0";
    global.fetch = async (url, options) => {
      assert.equal(url, "https://api.line.me/v2/bot/message/reply");
      capturedReply = JSON.parse(options.body);
      return Response.json({});
    };
    const body = JSON.parse(event("provider-error", "image"));
    body.events[0].replyToken = "synthetic-reply";
    await handleLineWebhook(JSON.stringify(body), { store, fetchImpl: async () => { throw new Error("secret-provider-key-1234567890123456"); } });
    assert.ok(capturedReply.messages[0].text.includes("尚未入帳"));
    assert.ok(!JSON.stringify(capturedReply).includes("secret-provider"));
    assert.equal(store.linePendingInput("provider-error"), null);
  } finally { global.fetch = deniedFetch; process.env.LINE_REPLY_DISABLED = "1"; }
  store.setLineImageConsent("expiry", true);
  await image("expiry");
  db.prepare("UPDATE line_pending_inputs SET expires_at = '2000-01-01T00:00:00Z'").run();
  await text("expiry", "確認記帳");
  assert.equal(store.lineLedgerSummary("expiry", "2026-09").expense, 0);
  store.deleteLineUserData({ lineUserId: "confirmed" });
  assert.equal(store.lineImageConsent("confirmed"), false);
  assert.equal(store.lineLedgerSummary("confirmed", "2026-09").expense, 0);
  const user = store.findOrCreateUserByLineId("delete-account");
  store.setLineImageConsent("delete-account", true);
  store.claimLineImageAttempt("delete-account", "delete-attempt");
  store.deleteUserAccount(user.id);
  assert.equal(store.lineImageConsent("delete-account"), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM line_image_attempts WHERE message_id = 'delete-attempt'").get().n, 0);
  process.env.LINE_IMAGE_PARSER_ENABLED = "0";
  db.close();
  console.log(JSON.stringify({ passed: true, disabledNoNetwork: true, privateChatOnly: true, malformedFailClosed: true, cancelRace: true, revokeRace: true, expiredNoWrite: true, encryptedPending: true, deletion: true, realExternalCalls: 0 }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
