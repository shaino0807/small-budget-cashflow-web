const crypto = require("crypto");

const lineReplyEndpoint = "https://api.line.me/v2/bot/message/reply";

function lineChannelSecret() {
  return String(process.env.LINE_CHANNEL_SECRET || "");
}

function lineChannelAccessToken() {
  return String(process.env.LINE_CHANNEL_ACCESS_TOKEN || "");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function lineReadiness() {
  const secret = lineChannelSecret();
  const token = lineChannelAccessToken();
  return {
    channelSecretConfigured: secret.length >= 16,
    channelAccessTokenConfigured: token.length >= 32,
    configured: secret.length >= 16 && token.length >= 32,
    ledgerEnabled: true,
    bindingEnabled: true,
    replyDisabled: process.env.LINE_REPLY_DISABLED === "1"
  };
}

function verifyLineSignature(rawBody, signature) {
  const secret = lineChannelSecret();
  if (!secret) {
    const error = new Error("LINE_CHANNEL_SECRET 尚未設定");
    error.statusCode = 503;
    throw error;
  }
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  return safeEqual(expected, signature);
}

function parseLineWebhook(rawBody) {
  try {
    return JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody));
  } catch {
    const error = new Error("LINE webhook JSON 格式不正確");
    error.statusCode = 400;
    throw error;
  }
}

function connectionReplyText() {
  return [
    "LINE 記帳已接通。",
    "可以試著輸入：買早餐 65、賺 3000、買 0056 10000。",
    "我會先幫你記到 LINE 帳本，下一階段再和網頁報告綁定同步。"
  ].join("\n");
}

function formatMoney(value) {
  return `NT$${Math.round(Number(value || 0)).toLocaleString("zh-TW")}`;
}

function firstAmount(text) {
  const normalized = String(text || "").replace(/[,，]/g, "");
  const ticker = firstTicker(normalized);
  const amountText = ticker ? normalized.replace(new RegExp(`\\b${ticker}\\b`, "i"), " ") : normalized;
  const match = amountText.match(/(?:NT\$?\s*)?(\d+(?:\.\d+)?)(?:\s*(?:元|塊|台幣|twd))?/i);
  if (!match) return 0;
  return Math.round(Number(match[1]));
}

function firstTicker(text) {
  const value = String(text || "").toUpperCase();
  const numeric = value.match(/\b(00\d{2,4}|0\d{4,5})\b/);
  if (numeric) return numeric[1];
  const alpha = value.match(/\b([A-Z]{2,5})\b/);
  return alpha && alpha[1] !== "ETF" ? alpha[1] : "";
}

function compactNote(text) {
  return String(text || "")
    .replace(/[,，]/g, "")
    .replace(/\d+(?:\.\d+)?\s*(?:元|塊|台幣|twd)?/ig, "")
    .replace(/\b(買|付|花|繳|支出|得|賺|收入|薪水|獎金|ETF|投資|購入)\b/ig, "")
    .trim()
    .slice(0, 80);
}

function parseLedgerMessage(text) {
  const raw = String(text || "").trim();
  const amount = firstAmount(raw);
  const ticker = firstTicker(raw);
  const hasInvestment = /ETF|投資|購入/.test(raw) || (ticker && /買|購入/.test(raw));
  const hasIncome = /得|賺|收入|薪水|獎金|領到|收到/.test(raw);
  const hasExpense = /買|付|花|繳|支出|刷|扣款/.test(raw);
  if (!amount) return { intent: "help", reason: "missing_amount" };
  if (hasInvestment) {
    return { intent: "ledger", type: "investment", amount, ticker, category: "ETF", note: compactNote(raw) || ticker || "投資" };
  }
  if (hasIncome) {
    const category = /固定收入|月薪|薪水/.test(raw) ? "固定收入" : "收入";
    return { intent: "ledger", type: "income", amount, category, note: compactNote(raw) || category };
  }
  if (hasExpense) {
    return { intent: "ledger", type: "expense", amount, category: "支出", note: compactNote(raw) || "支出" };
  }
  return { intent: "help", reason: "unknown_keyword" };
}

function parseBindingMessage(text) {
  const match = String(text || "").trim().match(/^(?:綁定|绑定|bind)\s*(\d{6})$/i);
  return match ? { intent: "binding", code: match[1] } : null;
}

function ledgerTypeLabel(type) {
  return {
    expense: "支出",
    income: "收入",
    investment: "投資"
  }[type] || "記帳";
}

function summaryReplyText(entry, summary) {
  const title = `已記錄${ledgerTypeLabel(entry.type)}：${entry.note || entry.category || ""} ${formatMoney(entry.amount)}`.trim();
  const tickerLine = entry.ticker ? `ETF/標的：${entry.ticker}\n` : "";
  return [
    title,
    tickerLine + `${summary.month} 月統計`,
    `總收入：${formatMoney(summary.income)}`,
    `總支出：${formatMoney(summary.expense)}`,
    `投資總額：${formatMoney(summary.investment)}`,
    `剩餘現金流：${formatMoney(summary.remaining)}`
  ].join("\n");
}

function helpReplyText() {
  return [
    "我還沒看懂這筆。",
    "你可以這樣輸入：",
    "買早餐 65",
    "付房租 12000",
    "賺 3000",
    "買 0056 10000"
  ].join("\n");
}

async function replyLineMessage(replyToken, messages) {
  if (!replyToken || process.env.LINE_REPLY_DISABLED === "1") {
    return { skipped: true, reason: process.env.LINE_REPLY_DISABLED === "1" ? "reply_disabled" : "missing_reply_token" };
  }
  const token = lineChannelAccessToken();
  if (!token) return { skipped: true, reason: "channel_access_token_not_configured" };
  const response = await fetch(lineReplyEndpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ replyToken, messages })
  });
  if (!response.ok) {
    const error = new Error(`LINE reply API HTTP ${response.status}`);
    error.statusCode = 502;
    throw error;
  }
  return { skipped: false };
}

async function handleLineWebhook(rawBody, options = {}) {
  const body = parseLineWebhook(rawBody);
  const events = Array.isArray(body.events) ? body.events : [];
  const replies = [];
  for (const event of events) {
    if (event.type !== "message" || event.message?.type !== "text") continue;
    const text = String(event.message.text || "");
    const userId = event.source?.userId || "";
    let replyText = connectionReplyText();
    let ledgerResult = null;
    let bindingResult = null;
    const binding = parseBindingMessage(text);
    const parsed = binding || parseLedgerMessage(text);
    if (parsed.intent === "binding") {
      if (!options.store || !userId) {
        replyText = "目前無法確認你的 LINE 身分，請稍後再試。";
      } else {
        try {
          bindingResult = options.store.bindLineReport({ lineUserId: userId, code: parsed.code });
          replyText = "綁定成功。之後在 LINE 記錄的收入、支出與 ETF 投資，會同步到這份網頁報告。";
        } catch (error) {
          replyText = error.message || "綁定失敗，請回到網頁重新產生綁定碼。";
        }
      }
    } else if (parsed.intent === "ledger") {
      if (!options.store || !userId) {
        replyText = "LINE 記帳後端尚未準備好，請稍後再試。";
      } else {
        try {
          const entry = options.store.addLineLedgerEntry({
            lineUserId: userId,
            type: parsed.type,
            amount: parsed.amount,
            category: parsed.category,
            ticker: parsed.ticker,
            note: parsed.note,
            source: {
              platform: "line",
              messageId: event.message.id,
              messageText: text,
              replyToken: event.replyToken ? "present" : "missing"
            }
          });
          const summary = options.store.lineLedgerSummary(userId);
          ledgerResult = { entry, summary };
          replyText = summaryReplyText(entry, summary);
        } catch (error) {
          if (error.statusCode !== 409) throw error;
          const summary = options.store.lineLedgerSummary(userId);
          replyText = [
            "這筆 LINE 訊息已經記錄過，不會重複入帳。",
            `${summary.month} 月統計`,
            `總收入：${formatMoney(summary.income)}`,
            `總支出：${formatMoney(summary.expense)}`,
            `投資總額：${formatMoney(summary.investment)}`,
            `剩餘現金流：${formatMoney(summary.remaining)}`
          ].join("\n");
        }
      }
    } else if (!/測試|test|hello|hi|嗨|哈囉/i.test(text)) {
      replyText = helpReplyText();
    }
    const result = await replyLineMessage(event.replyToken, [
      { type: "text", text: replyText }
    ]);
    replies.push({
      eventType: event.type,
      messageType: event.message.type,
      parsedIntent: parsed.intent,
      ledgerType: ledgerResult?.entry?.type || null,
      binding: bindingResult ? "linked" : null,
      userId: event.source?.userId ? "present" : "missing",
      ...result
    });
  }
  return { receivedEvents: events.length, replies };
}

module.exports = {
  handleLineWebhook,
  lineReadiness,
  parseBindingMessage,
  parseLedgerMessage,
  verifyLineSignature
};
