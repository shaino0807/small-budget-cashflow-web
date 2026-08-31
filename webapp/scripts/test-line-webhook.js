const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { handleLineWebhook, parseIncomingMessage, parseLedgerMessage, parseLedgerMessageWithAi, parseLineCommand } = require("../line-bot");

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

function lineEventBody(message, id = `event-${message.id}`, userId = "Uvoice") {
  return JSON.stringify({
    destination: "test",
    events: [{
      type: "message",
      webhookEventId: id,
      replyToken: `reply-${id}`,
      source: { type: "user", userId },
      message
    }]
  });
}

async function testTargetedDeleteWebhook(store) {
  const userId = "Udelete";
  const send = (id, text) => handleLineWebhook(
    lineEventBody({ id, type: "text", text }, `event-${id}`, userId),
    { store }
  );
  const add = (id, note, amount, hoursAgo) => store.addLineLedgerEntry({
    lineUserId: userId,
    type: "expense",
    amount,
    category: "伙食",
    note,
    occurredAt: new Date(Date.now() - hoursAgo * 3600000).toISOString(),
    source: { platform: "line", messageId: id, messageText: `${note} ${amount}` }
  });

  add("delete-dinner-300", "晚餐", 300, 2);
  add("delete-breakfast-65", "早餐", 65, 4);
  add("delete-dinner-200", "晚餐", 200, 26);
  add("delete-dinner-100", "晚餐", 100, 50);
  const initialExpense = store.lineLedgerSummary(userId).expense;
  if (initialExpense !== 665) throw new Error(`Targeted delete fixture total was incorrect: ${initialExpense}`);

  const noMatch = await send("delete-none", "刪除宵夜");
  if (
    noMatch.replies[0]?.command !== "request_delete_matching"
    || noMatch.replies[0]?.candidateCount !== 0
    || noMatch.replies[0]?.pending
    || store.linePendingInput(userId) !== null
    || store.lineLedgerSummary(userId).expense !== initialExpense
  ) {
    throw new Error(`No-match targeted delete was not fail-closed: ${JSON.stringify(noMatch)}`);
  }

  const single = await send("delete-single", "刪除早餐");
  if (
    single.replies[0]?.command !== "request_delete_matching"
    || single.replies[0]?.candidateCount !== 1
    || !single.replies[0]?.pending
    || store.linePendingInput(userId)?.type !== "delete_confirmation"
    || store.lineLedgerSummary(userId).expense !== initialExpense
  ) {
    throw new Error(`Single targeted delete skipped confirmation: ${JSON.stringify(single)}`);
  }
  const canceled = await send("delete-single-cancel", "取消");
  if (canceled.replies[0]?.canceled !== "pending" || store.lineLedgerSummary(userId).expense !== initialExpense) {
    throw new Error(`Canceled targeted delete changed the ledger: ${JSON.stringify(canceled)}`);
  }
  const expiredConfirmation = await send("delete-confirm-without-pending", "確認刪除此筆");
  if (expiredConfirmation.replies[0]?.ledgerCount !== 0 || store.lineLedgerSummary(userId).expense !== initialExpense) {
    throw new Error(`Missing targeted delete pending state deleted an entry: ${JSON.stringify(expiredConfirmation)}`);
  }

  const multiple = await send("delete-multiple", "刪除晚餐");
  const multiplePending = store.linePendingInput(userId);
  if (
    multiple.replies[0]?.candidateCount !== 3
    || multiplePending?.type !== "delete_candidates"
    || multiplePending.payload?.candidates?.map((entry) => entry.amount).join(",") !== "300,200,100"
    || store.lineLedgerSummary(userId).expense !== initialExpense
  ) {
    throw new Error(`Multiple targeted delete candidates were unsafe: ${JSON.stringify({ multiple, multiplePending })}`);
  }
  const invalidSelection = await send("delete-invalid-selection", "選擇刪除第9筆");
  if (
    invalidSelection.replies[0]?.candidateCount !== 3
    || store.linePendingInput(userId)?.type !== "delete_candidates"
    || store.lineLedgerSummary(userId).expense !== initialExpense
  ) {
    throw new Error(`Invalid targeted delete selection changed state unsafely: ${JSON.stringify(invalidSelection)}`);
  }
  const selected = await send("delete-select-second", "選擇刪除第2筆");
  if (
    selected.replies[0]?.candidateCount !== 1
    || store.linePendingInput(userId)?.type !== "delete_confirmation"
    || store.linePendingInput(userId)?.payload?.candidates?.[0]?.amount !== 200
    || store.lineLedgerSummary(userId).expense !== initialExpense
  ) {
    throw new Error(`Targeted delete selection did not require final confirmation: ${JSON.stringify(selected)}`);
  }
  const confirmed = await send("delete-confirm-second", "確認刪除此筆");
  if (
    confirmed.replies[0]?.command !== "confirm_delete_selected"
    || confirmed.replies[0]?.ledgerCount !== 1
    || confirmed.replies[0]?.ledgerType !== "expense"
    || store.lineLedgerSummary(userId).expense !== 465
    || store.linePendingInput(userId) !== null
  ) {
    throw new Error(`Targeted delete removed the wrong entry: ${JSON.stringify(confirmed)}`);
  }
  const repeatedConfirmation = await send("delete-confirm-second", "確認刪除此筆");
  if (repeatedConfirmation.replies[0]?.ledgerCount !== 0 || store.lineLedgerSummary(userId).expense !== 465) {
    throw new Error(`Repeated targeted delete confirmation removed another entry: ${JSON.stringify(repeatedConfirmation)}`);
  }

  await send("delete-stale-search", "刪除晚餐");
  await send("delete-stale-select", "選擇刪除第1筆");
  await wait(5);
  store.updateIndexedLineLedgerEntry({
    lineUserId: userId,
    index: 1,
    amount: 333,
    sourceMessageId: "delete-stale-mutation"
  });
  const staleConfirmation = await send("delete-stale-confirm", "確認刪除此筆");
  if (
    staleConfirmation.replies[0]?.ledgerCount !== 0
    || store.lineLedgerSummary(userId).expense !== 498
    || store.linePendingInput(userId) !== null
  ) {
    throw new Error(`Stale targeted delete candidate was not rejected: ${JSON.stringify(staleConfirmation)}`);
  }

  const todayDinner = await send("delete-today-dinner", "刪除今天的晚餐");
  if (
    todayDinner.replies[0]?.candidateCount !== 1
    || store.linePendingInput(userId)?.type !== "delete_confirmation"
    || store.linePendingInput(userId)?.payload?.candidates?.[0]?.amount !== 333
    || store.lineLedgerSummary(userId).expense !== 498
  ) {
    throw new Error(`Positive date-scoped targeted delete was unsafe: ${JSON.stringify(todayDinner)}`);
  }
  await send("delete-today-dinner-cancel", "取消");
  const todayNoMatch = await send("delete-today-none", "取消今天的午餐");
  if (todayNoMatch.replies[0]?.candidateCount !== 0 || store.lineLedgerSummary(userId).expense !== 498) {
    throw new Error(`Date-scoped targeted delete was not fail-closed: ${JSON.stringify(todayNoMatch)}`);
  }
  const deleteBreakfast = await send("delete-breakfast-final", "刪除早餐");
  if (deleteBreakfast.replies[0]?.candidateCount !== 1) throw new Error(`Single targeted delete candidate disappeared: ${JSON.stringify(deleteBreakfast)}`);
  const confirmBreakfast = await send("delete-breakfast-confirm", "確認刪除此筆");
  if (confirmBreakfast.replies[0]?.ledgerCount !== 1 || store.lineLedgerSummary(userId).expense !== 433) {
    throw new Error(`Single targeted delete confirmation failed: ${JSON.stringify(confirmBreakfast)}`);
  }

  return {
    noMatchFailClosed: true,
    singleRequiresConfirmation: true,
    cancellationSafe: true,
    missingOrExpiredPendingSafe: true,
    multipleChoiceSafe: true,
    invalidChoiceSafe: true,
    staleCandidateRejected: true,
    repeatedConfirmationSafe: true,
    dateScopeSafe: true
  };
}

async function testVoiceWebhook() {
  const envNames = [
    "CUSTOMER_DATA_DIR",
    "CUSTOMER_DATA_KEY",
    "ACCESS_CODE_PEPPER",
    "ADMIN_API_KEY",
    "LINE_CHANNEL_ACCESS_TOKEN",
    "LINE_REPLY_DISABLED",
    "LINE_VOICE_TRANSCRIPTION_ENABLED",
    "LINE_VOICE_PILOT_MODE",
    "LINE_VOICE_MAX_DURATION_SECONDS",
    "LINE_VOICE_MAX_BYTES",
    "OPENAI_API_KEY",
    "OPENAI_TRANSCRIPTION_MODEL",
    "LINE_AI_PARSER_ENABLED"
  ];
  const previousEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  const originalFetch = global.fetch;
  let transcriptText = "昨天晚餐三百五十元";
  let transcriptionStatus = 200;
  let lineDownloadCalls = 0;
  let lineProcessingResponses = 0;
  let store = null;
  try {
    Object.assign(process.env, {
      CUSTOMER_DATA_DIR: path.join(dataDir, "voice-test"),
      CUSTOMER_DATA_KEY: crypto.randomBytes(32).toString("base64"),
      ACCESS_CODE_PEPPER: crypto.randomBytes(24).toString("base64url"),
      ADMIN_API_KEY: crypto.randomBytes(24).toString("base64url"),
      LINE_CHANNEL_ACCESS_TOKEN: "test-line-channel-access-token-32chars",
      LINE_REPLY_DISABLED: "1",
      LINE_VOICE_TRANSCRIPTION_ENABLED: "1",
      LINE_VOICE_PILOT_MODE: "1",
      LINE_VOICE_MAX_DURATION_SECONDS: "60",
      LINE_VOICE_MAX_BYTES: String(10 * 1024 * 1024),
      OPENAI_API_KEY: "test-openai-key",
      OPENAI_TRANSCRIPTION_MODEL: "gpt-4o-mini-transcribe",
      LINE_AI_PARSER_ENABLED: "0"
    });
    global.fetch = async (url, options = {}) => {
      const endpoint = String(url);
      if (endpoint.includes("api-data.line.me/v2/bot/message/")) {
        lineDownloadCalls += 1;
        if (lineProcessingResponses > 0) {
          lineProcessingResponses -= 1;
          return new Response(null, { status: 202 });
        }
        return new Response(Buffer.from("fake-line-audio"), {
          status: 200,
          headers: { "content-type": "audio/m4a", "content-length": "15" }
        });
      }
      if (endpoint.endsWith("/v1/audio/transcriptions")) {
        if (!(options.body instanceof FormData)) throw new Error("Transcription request did not use multipart FormData");
        return new Response(JSON.stringify({ text: transcriptText }), {
          status: transcriptionStatus,
          headers: { "content-type": "application/json" }
        });
      }
      if (endpoint.endsWith("/v1/responses")) {
        return new Response(JSON.stringify({
          output_text: JSON.stringify({
            entries: [
              { type: "expense", amount: 120, category: "伙食", ticker: null, note: "午餐", occurredAt: "2026-08-30T04:00:00.000Z" },
              { type: "expense", amount: 60, category: "伙食", ticker: null, note: "飲料", occurredAt: "2026-08-30T04:00:00.000Z" }
            ]
          })
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected fetch in voice test: ${endpoint}`);
    };

    const { createStore } = require("../customer-store");
    store = createStore();
    const voiceMessage = {
      id: "voice-1",
      type: "audio",
      duration: 5000,
      contentProvider: { type: "line" }
    };
    const blockedWithoutConsent = await handleLineWebhook(lineEventBody(voiceMessage), { store });
    if (
      blockedWithoutConsent.replies[0]?.voiceStatus !== "pilot_not_enabled"
      || lineDownloadCalls !== 0
      || store.linePendingInput("Uvoice") !== null
      || store.lineLedgerSummary("Uvoice").expense !== 0
    ) {
      throw new Error(`Voice pilot gate did not block pre-consent audio: ${JSON.stringify(blockedWithoutConsent)}`);
    }
    const pilotConsent = await handleLineWebhook(lineEventBody({ id: "voice-pilot-1", type: "text", text: "啟用語音測試" }), { store });
    if (
      pilotConsent.replies[0]?.command !== "enable_voice_pilot"
      || !pilotConsent.replies[0]?.pending
      || store.linePendingInput("Uvoice")?.type !== "voice_pilot"
    ) {
      throw new Error(`Voice pilot consent was not recorded: ${JSON.stringify(pilotConsent)}`);
    }
    const prepared = await handleLineWebhook(lineEventBody(voiceMessage), { store });
    if (
      prepared.replies[0]?.parsedIntent !== "voice_confirmation"
      || prepared.replies[0]?.voiceStatus !== "awaiting_confirmation"
      || !prepared.replies[0]?.pending
      || store.lineLedgerSummary("Uvoice").expense !== 0
    ) {
      throw new Error(`Voice entry was not held for confirmation: ${JSON.stringify(prepared)}`);
    }
    const repeatedVoice = await handleLineWebhook(lineEventBody(voiceMessage), { store });
    if (repeatedVoice.replies[0]?.voiceStatus !== "awaiting_confirmation" || lineDownloadCalls !== 1) {
      throw new Error(`Repeated voice webhook triggered another transcription: ${JSON.stringify(repeatedVoice)}`);
    }
    const pending = store.linePendingInput("Uvoice");
    if (pending?.payload?.transcript !== transcriptText || pending.payload.entry?.amount !== 350) {
      throw new Error(`Encrypted voice pending payload was not restored: ${JSON.stringify(pending)}`);
    }

    const confirmed = await handleLineWebhook(lineEventBody({ id: "confirm-1", type: "text", text: "確認語音記帳" }), { store });
    const confirmedSummary = store.lineLedgerSummary("Uvoice");
    if (
      confirmed.replies[0]?.command !== "confirm_current"
      || confirmed.replies[0]?.ledgerType !== "expense"
      || confirmed.replies[0]?.ledgerCount !== 1
      || confirmedSummary.expense !== 350
      || store.linePendingInput("Uvoice") !== null
    ) {
      throw new Error(`Confirmed voice entry was not recorded once: ${JSON.stringify(confirmed)}`);
    }
    const deliveredAfterConfirm = await handleLineWebhook(lineEventBody(voiceMessage), { store });
    if (deliveredAfterConfirm.replies[0]?.voiceStatus !== "duplicate" || lineDownloadCalls !== 1) {
      throw new Error(`Confirmed voice webhook was transcribed again: ${JSON.stringify(deliveredAfterConfirm)}`);
    }
    await handleLineWebhook(lineEventBody({ id: "confirm-1", type: "text", text: "確認語音記帳" }), { store });
    if (store.lineLedgerSummary("Uvoice").expense !== 350) throw new Error("Repeated confirmation duplicated the voice ledger entry");

    process.env.LINE_VOICE_PILOT_MODE = "0";

    transcriptText = "今天午餐 120";
    await handleLineWebhook(lineEventBody({ ...voiceMessage, id: "voice-2" }), { store });
    const canceled = await handleLineWebhook(lineEventBody({ id: "cancel-voice-2", type: "text", text: "取消" }), { store });
    if (canceled.replies[0]?.command !== "cancel_current" || store.lineLedgerSummary("Uvoice").expense !== 350) {
      throw new Error(`Canceled voice entry changed the ledger: ${JSON.stringify(canceled)}`);
    }

    transcriptText = "今天買0050一萬元";
    const tickerAmount = await handleLineWebhook(lineEventBody({ ...voiceMessage, id: "voice-ticker-chinese-amount" }), { store });
    const tickerAmountPending = store.linePendingInput("Uvoice");
    if (
      tickerAmount.replies[0]?.voiceStatus !== "awaiting_confirmation"
      || tickerAmountPending?.payload?.entry?.type !== "investment"
      || tickerAmountPending.payload.entry.ticker !== "0050"
      || tickerAmountPending.payload.entry.amount !== 10000
      || store.lineLedgerSummary("Uvoice").investment !== 0
    ) {
      throw new Error(`Voice ticker and Chinese amount boundary was unsafe: ${JSON.stringify({ tickerAmount, tickerAmountPending })}`);
    }
    await handleLineWebhook(lineEventBody({ id: "cancel-voice-ticker", type: "text", text: "取消" }), { store });

    transcriptText = "今天交通五十元";
    lineProcessingResponses = 2;
    const retryStart = lineDownloadCalls;
    const retried = await handleLineWebhook(lineEventBody({ ...voiceMessage, id: "voice-processing" }), {
      store,
      waitImpl: async () => {}
    });
    if (retried.replies[0]?.voiceStatus !== "awaiting_confirmation" || lineDownloadCalls - retryStart !== 3) {
      throw new Error(`LINE 202 audio preparation was not retried safely: ${JSON.stringify(retried)}`);
    }
    await handleLineWebhook(lineEventBody({ id: "cancel-processing", type: "text", text: "取消" }), { store });

    const callsBeforeLimit = lineDownloadCalls;
    const tooLong = await handleLineWebhook(lineEventBody({ ...voiceMessage, id: "voice-long", duration: 61000 }), { store });
    if (tooLong.replies[0]?.voiceStatus !== "too_long" || lineDownloadCalls !== callsBeforeLimit) {
      throw new Error(`Overlong voice was downloaded or accepted: ${JSON.stringify(tooLong)}`);
    }

    transcriptText = "早餐六十五,午餐一百二";
    process.env.LINE_AI_PARSER_ENABLED = "1";
    const multiple = await handleLineWebhook(lineEventBody({ ...voiceMessage, id: "voice-multiple" }), { store });
    if (multiple.replies[0]?.voiceStatus !== "multiple_entries" || multiple.replies[0]?.pending) {
      throw new Error(`Multiple voice entries were not rejected: ${JSON.stringify(multiple)}`);
    }

    transcriptionStatus = 500;
    const failed = await handleLineWebhook(lineEventBody({ ...voiceMessage, id: "voice-failed" }), { store });
    if (failed.replies[0]?.voiceStatus !== "transcription_failed" || store.lineLedgerSummary("Uvoice").expense !== 350) {
      throw new Error(`Transcription failure wrote a ledger entry: ${JSON.stringify(failed)}`);
    }

    transcriptionStatus = 200;
    process.env.LINE_VOICE_TRANSCRIPTION_ENABLED = "0";
    process.env.LINE_VOICE_PILOT_MODE = "1";
    const disabledConsent = await handleLineWebhook(lineEventBody({ id: "voice-pilot-disabled", type: "text", text: "啟用語音測試" }), { store });
    if (disabledConsent.replies[0]?.canceled !== "disabled" || store.linePendingInput("Uvoice") !== null) {
      throw new Error(`Disabled voice pilot created consent state: ${JSON.stringify(disabledConsent)}`);
    }
    const disabled = await handleLineWebhook(lineEventBody({ ...voiceMessage, id: "voice-disabled" }), { store });
    if (disabled.replies[0]?.voiceStatus !== "disabled") throw new Error(`Disabled voice mode was accepted: ${JSON.stringify(disabled)}`);

    const targetedDelete = await testTargetedDeleteWebhook(store);
    return {
      pilotConsentRequired: true,
      pilotDisabledSafe: true,
      confirmationRequired: true,
      duplicateTranscriptionBlocked: true,
      cancellationSafe: true,
      tickerAmountBoundarySafe: true,
      duplicateSafe: true,
      durationLimit: true,
      lineProcessingRetry: true,
      multipleEntriesRejected: true,
      transcriptionFailClosed: true,
      disabledFailClosed: true,
      targetedDelete
    };
  } finally {
    if (store) store.close();
    global.fetch = originalFetch;
    for (const name of envNames) {
      if (previousEnv[name] === undefined) delete process.env[name];
      else process.env[name] = previousEnv[name];
    }
  }
}

async function main() {
  const parserCases = [
    ["買早餐 65", "expense", 65],
    ["今天賺 3000", "income", 3000],
    ["固定收入金額 50000", "income", 50000, "本薪"],
    ["月薪 5萬", "income", 50000, "本薪"],
    ["獎金 3000", "income", 3000, "獎金"],
    ["兼職收入 8000", "income", 8000, "額外收入"],
    ["昨天付房租 1.2萬", "expense", 12000, "房租"],
    ["搭捷運 50", "expense", 50, "交通"],
    ["朋友聚餐 1200", "expense", 1200, "交際"],
    ["慶祝生日 2000", "expense", 2000, "交際"],
    ["買禮物 1500", "expense", 1500, "交際"],
    ["買伴手禮 900", "expense", 900, "交際"],
    ["婚禮紅包 3600", "expense", 3600, "交際"],
    ["參加喜宴 3200", "expense", 3200, "交際"],
    ["同事聚會 800", "expense", 800, "交際"],
    ["買衣服 1500", "expense", 1500, "服飾"],
    ["買項鍊 1200", "expense", 1200, "服飾"],
    ["買首飾 1800", "expense", 1800, "服飾"],
    ["買耳環 800", "expense", 800, "服飾"],
    ["買戒指 2500", "expense", 2500, "服飾"],
    ["買手鍊 1600", "expense", 1600, "服飾"],
    ["買手錶 5000", "expense", 5000, "服飾"],
    ["買帽子 700", "expense", 700, "服飾"],
    ["買襪子 300", "expense", 300, "服飾"],
    ["買眼鏡 3500", "expense", 3500, "服飾"],
    ["買皮夾 2200", "expense", 2200, "服飾"],
    ["繳保險 3000", "expense", 3000, "保險"],
    ["繳房貸 2萬", "expense", 20000, "貸款"],
    ["買 0056 10000", "investment", 10000],
    ["ETF 00878 5000", "investment", 5000],
    ["0056 配息 800", "investment_income", 800, "投資配息"],
    ["賣出 0056 收到 12000", "investment_income", 12000, "投資賣出"],
    ["賣 0056 12000", "investment_income", 12000, "投資賣出"]
  ];
  for (const [text, type, amount, category] of parserCases) {
    const parsed = parseLedgerMessage(text);
    if (parsed.type !== type || parsed.amount !== amount || (category && parsed.category !== category)) {
      throw new Error(`Parser failed for ${text}: ${JSON.stringify(parsed)}`);
    }
  }
  const commandCases = [
    ["啟用語音測試", "enable_voice_pilot"],
    ["投資ETF", "prompt_investment"],
    ["取消", "cancel_current"],
    ["按錯", "cancel_current"],
    ["確認語音記帳", "confirm_current"],
    ["刪除晚餐", "request_delete_matching"],
    ["取消今天的晚餐", "request_delete_matching"],
    ["選擇刪除第2筆", "select_delete_candidate"],
    ["確認刪除此筆", "confirm_delete_selected"],
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
    const missingAmount = await parseIncomingMessage("想投資 ETF");
    if (missingAmount?.intent !== "help" || missingAmount.reason !== "missing_investment_details") {
      throw new Error(`Missing investment amount was not blocked: ${JSON.stringify(missingAmount)}`);
    }
    const unrealizedGain = await parseIncomingMessage("股票賺 5000");
    if (unrealizedGain?.intent !== "help" || unrealizedGain.reason !== "unrealized_investment_gain") {
      throw new Error(`Unrealized investment gain was recorded: ${JSON.stringify(unrealizedGain)}`);
    }
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.LINE_AI_PARSER_ENABLED;
    global.fetch = originalFetch;
  }
  const voice = await testVoiceWebhook();
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
      || health.line.voiceTranscriptionConfigured
      || health.line.voiceMaxDurationSeconds !== 60
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
    const sendLineForUser = async (id, text, userId = "Utest") => {
      const lineBody = JSON.stringify({
        destination: "test",
        events: [{
          type: "message",
          replyToken: "test-reply-token",
          source: { type: "user", userId },
          message: { id, type: "text", text }
        }]
      });
      return request("/api/line/webhook", {
        body: lineBody,
        headers: { "x-line-signature": signature(lineBody) }
      });
    };
    const pendingInvestment = await sendLineForUser("pending-1", "投資ETF");
    const switchedToIncome = await sendLineForUser("pending-2", "收入");
    const canceledIncome = await sendLineForUser("pending-3", "取消");
    if (
      pendingInvestment.body.replies[0]?.command !== "prompt_investment"
      || !pendingInvestment.body.replies[0]?.pending
      || switchedToIncome.body.replies[0]?.canceled !== "ETF／股票交易"
      || canceledIncome.body.replies[0]?.command !== "cancel_current"
      || canceledIncome.body.replies[0]?.canceled !== "pending"
    ) {
      throw new Error(`Pending input cancellation failed: ${JSON.stringify({ pendingInvestment, switchedToIncome, canceledIncome })}`);
    }
    const recordedForUndo = await sendLineForUser("undo-1", "買 0056 10000");
    const undone = await sendLineForUser("undo-2", "按錯");
    const repeatedUndo = await sendLineForUser("undo-3", "按錯");
    const summaryAfterUndo = await request(`/api/line/summary?reportId=${encodeURIComponent(created.body.report.id)}`, {
      method: "GET",
      headers: { "X-Report-Access-Code": created.body.report.accessCode }
    });
    if (
      recordedForUndo.body.replies[0]?.ledgerType !== "investment"
      || undone.body.replies[0]?.canceled !== "entry"
      || repeatedUndo.body.replies[0]?.canceled !== "none"
      || summaryAfterUndo.body.summary?.investment !== 0
      || summaryAfterUndo.body.summary?.etfPositions?.length
    ) {
      throw new Error(`Immediate undo did not restore cashflow and holdings: ${JSON.stringify({ recordedForUndo, undone, summaryAfterUndo })}`);
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
    const dividend = await sendLineForUser("investment-income-1", "0056 配息 800");
    const sale = await sendLineForUser("investment-income-2", "賣出 0056 收到 12000");
    const investmentIncomeSummary = await request(`/api/line/summary?reportId=${encodeURIComponent(created.body.report.id)}`, {
      method: "GET",
      headers: { "X-Report-Access-Code": created.body.report.accessCode }
    });
    const investmentIncomePositions = Object.fromEntries((investmentIncomeSummary.body.summary?.etfPositions || []).map((position) => [position.ticker, position.amount]));
    if (
      dividend.body.replies[0]?.ledgerType !== "investment_income"
      || sale.body.replies[0]?.ledgerType !== "investment_income"
      || investmentIncomeSummary.body.summary?.investmentIncome !== 12800
      || investmentIncomeSummary.body.summary?.remaining !== 52735
      || investmentIncomePositions["0056"] !== 10000
    ) {
      throw new Error(`Investment inflow classification failed: ${JSON.stringify({ dividend, sale, investmentIncomeSummary })}`);
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
    if (
      afterPrivacyDelete.status !== 200
      || afterPrivacyDelete.body.cashflow?.linked !== false
      || afterPrivacyDelete.body.cashflow?.entries?.length !== 0
    ) {
      throw new Error(`Deleted LINE data remained linked: ${JSON.stringify(afterPrivacyDelete)}`);
    }
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
      voice,
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
