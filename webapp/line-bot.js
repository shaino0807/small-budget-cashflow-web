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
    "下一階段會支援：買/付/花 記支出、得/賺 記收入、ETF 金額寫入配置。",
    "目前這則回覆用來確認 webhook 與簽章驗證正常。"
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

async function handleLineWebhook(rawBody) {
  const body = parseLineWebhook(rawBody);
  const events = Array.isArray(body.events) ? body.events : [];
  const replies = [];
  for (const event of events) {
    if (event.type !== "message" || event.message?.type !== "text") continue;
    const result = await replyLineMessage(event.replyToken, [
      { type: "text", text: connectionReplyText() }
    ]);
    replies.push({
      eventType: event.type,
      messageType: event.message.type,
      userId: event.source?.userId ? "present" : "missing",
      ...result
    });
  }
  return { receivedEvents: events.length, replies };
}

module.exports = {
  handleLineWebhook,
  lineReadiness,
  verifyLineSignature
};
