const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
process.env.CUSTOMER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cashflow-improvements-"));
process.env.CUSTOMER_DATA_KEY = crypto.randomBytes(32).toString("base64");
process.env.ACCESS_CODE_PEPPER = crypto.randomBytes(32).toString("hex");
process.env.LINE_REPLY_DISABLED = "1";
global.fetch = async () => { throw new Error("Network is forbidden in this fixture test"); };
process.env.LINE_AI_PARSER_ENABLED = "0";
const { createStore } = require("../customer-store");
const { parseMultilineLedger, parseIncomingMessage, parseLedgerMessageWithAi, batchReviewText, handleLineWebhook } = require("../line-bot");
const { validateStatement, readStatementImage, parseStatementImage } = require("../statement-reader");

const screenshotText = `9月3號搭 Uber 花134
9月3號樂天遊樂園手續費7塊
9月4號信用卡帳單26,104
9月4日
・旅遊：321
・旅遊：161
・旅遊：142
・手續費：61
・Olivia：4,067
・交易手續費：2
・搭 Uber：147
・搭 Uber：134
9月5日
・吃燒肉：4,562
9月5日：
・搭 Uber 476元
・搭 Uber 339元
9月6日：
・買藥970元
・搭 Uber 660元
・電話帳單1,449元
9月5號收到薪水68,981
9月6號付孝親費8000
9月6號付王道銀行貸款2207
9/6付學費3,800
9/8火鍋990`;
const screenshotTwo = `9月1號 國外交易手續費3元
9月1號 Render.com 230塊
9月1號 玩具 UX-21 1896元
9月1號 玩具 BX-49 629元`;
const store = createStore();
let sequence = 0;
const send = (text, user = "Ubatch", id = `m${++sequence}`) => handleLineWebhook(JSON.stringify({ events: [{ type: "message", replyToken: "test", source: { type: "user", userId: user }, message: { type: "text", id, text } }] }), { store });

async function main() {
  const parsed = parseMultilineLedger(screenshotText);
  assert.equal(parsed.entries.length, 22);
  assert.deepEqual(parsed.unresolved, []);
  assert.equal(parsed.entries[3].sourceLine, 5);
  assert.equal(parseMultilineLedger("9/1\n\n早餐65\n午餐100").entries[0].sourceLine, 3);
  assert.match(batchReviewText(parsed.entries), /原文第 5 行/);
  assert.match(batchReviewText(parsed.entries), /支出/);
  assert.match(batchReviewText(parsed.entries), /收入/);
  const longLine = parseMultilineLedger(`9/1\n${"用途".repeat(160)} 300`);
  assert.equal(longLine.entries.length, 0);
  assert.match(longLine.unresolved[0], /超過 300 字/);
  const expense = parsed.entries.filter((entry) => entry.type === "expense").reduce((sum, entry) => sum + entry.amount, 0);
  assert.equal(expense, 54733);
  assert.equal(parsed.entries.filter((entry) => entry.type === "income")[0].amount, 68981);
  assert.equal(parsed.entries[3].occurredAt.slice(5, 10), "09-04");
  assert.equal(parsed.entries[12].occurredAt.slice(5, 10), "09-05");
  await send(screenshotText, "Ubatch", "batch-redelivery");
  await send(screenshotText, "Ubatch", "batch-redelivery");
  assert.equal(store.linePendingInput("Ubatch").payload.entries.length, 22);
  assert.equal(store.lineLedgerSummary("Ubatch").expense, 0, "preview must not write");
  await send("確認記帳");
  assert.equal(store.lineLedgerSummary("Ubatch").expense, expense);
  await send("確認記帳");
  assert.equal(store.lineLedgerSummary("Ubatch").expense, expense, "confirmation idempotent");
  await send(screenshotTwo, "Urender"); await send("確認記帳", "Urender");
  assert.equal(store.lineLedgerSummary("Urender").expense, 2758);
  assert.equal(store.lineLedgerSummary("Urender").investment, 0);
  const networkGuard = global.fetch;
  try {
    global.fetch = async () => Response.json({ output_text: JSON.stringify({ entries: [
      { type: "investment", amount: 230, category: "ETF", ticker: "RENDER", note: "Render.com 續約", occurredAt: "2026-09-01T04:00:00Z" },
      { type: "investment", amount: 5000, category: "ETF", ticker: "0056", note: "買 ETF 0056", occurredAt: "2026-09-01T04:00:00Z" }
    ] }) });
    const corrected = await parseLedgerMessageWithAi("Render.com 續約230元，買ETF 0056 5000元");
    assert.equal(corrected.entries[0].type, "expense");
    assert.equal(corrected.entries[0].category, "生活帳單");
    assert.equal(corrected.entries[0].ticker, "");
    assert.equal(corrected.entries[1].type, "investment");
  } finally { global.fetch = networkGuard; }
  await send("早餐65\n用途不明", "Ureject"); await send("確認記帳", "Ureject");
  assert.equal(store.lineLedgerSummary("Ureject").expense, 0);
  await send("早餐65\n午餐100", "Ucancel"); await send("取消", "Ucancel"); await send("確認記帳", "Ucancel");
  assert.equal(store.lineLedgerSummary("Ucancel").expense, 0);
  assert.equal((await parseIncomingMessage("早餐65 午餐100")).intent, "batch_review");
  assert.equal(parseMultilineLedger("13/31\n早餐65").unresolved.length, 1);
  assert.equal(parseMultilineLedger("9/31\n早餐65").unresolved.length, 1);
  assert.equal(parseMultilineLedger("轉帳1000\n早餐65").unresolved.length, 1);
  assert.equal(parseMultilineLedger("早餐65\n".repeat(61)).entries.length, 0);

  // The whole batch rolls back when a later item is invalid or already recorded.
  store.startLinePendingInput({ lineUserId: "Uatomic", type: "batch_confirmation", sourceMessageId: "atomic", payload: { sourceMessageId: "atomic", entries: [{ type: "expense", amount: 65 }, { type: "expense", amount: -1 }] } });
  assert.throws(() => store.confirmLineBatch("Uatomic"));
  assert.equal(store.lineLedgerSummary("Uatomic").expense, 0);

  const user = store.findOrCreateUserByLineId("Usettings");
  const profile = { monthlyIncome: 72000, fixedExpense: 22000, insuranceExpense: 2000, loanExpense: 3000, monthlyInvestment: 8000, cashSavings: 100000, age: 35, retirementMonthlyNeed: 30000 };
  const settings = { profile, monthlyCashflows: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, { monthlyIncome: 72000, fixedExpense: 22000, insuranceExpense: 2000, loanExpense: 3000, monthlyInvestment: 8000 }])), holdings: [{ ticker: "0056", type: "高股息", amount: 10000, lots: [{ amount: 10000, price: 30 }] }] };
  store.saveFinancialSettings({ userId: user.id, settings });
  assert.equal(store.userBootstrap(user.id).cashflow.holdings[0].amount, 10000);
  settings.holdings = [];
  settings.monthlyCashflows[9].monthlyIncome = 75000;
  store.saveFinancialSettings({ userId: user.id, settings });
  const reopened = createStore();
  const restored = reopened.userBootstrap(user.id).cashflow;
  assert.equal(restored.financialSettings.profile.monthlyIncome, 72000);
  assert.equal(restored.financialSettings.monthlyCashflows[9].monthlyIncome, 75000);
  assert.deepEqual(restored.holdings, []);
  assert.deepEqual(restored.financialSettings.holdings, []);
  const invalid = structuredClone(settings); invalid.profile.monthlyIncome = -1;
  assert.throws(() => store.saveFinancialSettings({ userId: user.id, settings: invalid }));
  assert.equal(store.userBootstrap(user.id).cashflow.financialSettings.profile.monthlyIncome, 72000);

  const imagePayload = { complete: true, warnings: [], rows: [{ date: "2026-09-01", dateEvidence: "2026-09-01", amount: 230, currency: "TWD", kind: "expense", description: "Render.com 續約" }] };
  assert.equal(validateStatement(imagePayload).entries[0].type, "expense");
  for (const patch of [{ kind: "transfer" }, { kind: "card_payment" }, { currency: "USD" }, { date: null }, { date: "2026-02-30" }, { amount: 0 }, { amount: 1.5 }]) {
    assert.equal(validateStatement({ ...imagePayload, rows: [{ ...imagePayload.rows[0], ...patch }] }).unresolved.length, 1);
  }
  let calls = 0;
  process.env.LINE_IMAGE_PARSER_ENABLED = "1";
  process.env.OPENAI_API_KEY = "synthetic-test-key";
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "synthetic-line-token";
  const fakeFetch = async (url, options) => {
    calls++;
    if (url.includes("api-data.line.me")) return new Response(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), { headers: { "content-type": "image/png" } });
    const body = JSON.parse(options.body); assert.equal(body.store, false);
    assert.equal(body.input[1].content[1].type, "input_image");
    return Response.json({ status: "completed", output_text: JSON.stringify(imagePayload) });
  };
  const imageEvent = (id) => JSON.stringify({ events: [{ type: "message", source: { type: "user", userId: "Uimage" }, message: { type: "image", id } }] });
  await handleLineWebhook(imageEvent("img0"), { store, fetchImpl: fakeFetch }); assert.equal(calls, 0);
  await send("啟用圖片記帳", "Uimage"); await send("同意並啟用圖片記帳", "Uimage");
  await handleLineWebhook(imageEvent("img1"), { store, fetchImpl: fakeFetch });
  assert.equal(calls, 2); assert.equal(store.lineLedgerSummary("Uimage").expense, 0);
  await handleLineWebhook(imageEvent("img1-pending-copy"), { store, fetchImpl: fakeFetch });
  assert.equal(calls, 2, "pending image blocks further downloads and preserves confirmation");
  await send("確認記帳", "Uimage");
  assert.equal(store.lineLedgerSummary("Uimage", "2026-09").expense, 230);
  await handleLineWebhook(imageEvent("img1"), { store, fetchImpl: fakeFetch }); assert.equal(calls, 2);
  await handleLineWebhook(imageEvent("img2"), { store, fetchImpl: fakeFetch }); assert.equal(calls, 3, "same image with new message id skips AI");
  await send("停用圖片記帳", "Uimage");
  await handleLineWebhook(imageEvent("img3"), { store, fetchImpl: fakeFetch }); assert.equal(calls, 3);
  assert.equal(store.lineBatchDuplicateWarnings("Uimage", validateStatement(imagePayload).entries).length, 1);
  assert.equal(store.lineBatchDuplicateWarnings("Uimage", [{ ...validateStatement(imagePayload).entries[0], type: "income" }]).length, 1, "same date and amount prompts even if type differs");
  for (let i = 0; i < 10; i++) assert.equal(store.claimLineImageAttempt("Ulimit", `limit${i}`), true);
  assert.equal(store.claimLineImageAttempt("Ulimit", "limit11"), false);
  await assert.rejects(readStatementImage("big", { fetchImpl: async () => new Response("x", { headers: { "content-type": "image/png", "content-length": String(9 * 1024 * 1024) } }) }));
  await assert.rejects(parseStatementImage({ type: "image/png", buffer: Buffer.from("x") }, { fetchImpl: async () => Response.json({ status: "incomplete" }) }));
  store.deleteLineUserData({ lineUserId: "Usettings" });
  assert.equal(store.userBootstrap(user.id).cashflow.financialSettings, null);
  console.log(JSON.stringify({ passed: true, screenshotEntries: parsed.entries.length, screenshotExpense: expense, missingExpense: expense - 30807, renderExpense: 2758, atomicBatch: true, reloadSettings: true, emptyHoldings: true, imageConsentAndDuplicateGates: true, externalCalls: 0 }, null, 2));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
