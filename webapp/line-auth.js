const crypto = require("crypto");

const defaultAuthorizeUrl = "https://access.line.me/oauth2/v2.1/authorize";
const defaultApiBase = "https://api.line.me";

function cleanUrl(value) {
  return String(value || "").trim().replace(/\/$/, "");
}

function lineLoginConfig() {
  const channelId = String(process.env.LINE_LOGIN_CHANNEL_ID || "").trim();
  const channelSecret = String(process.env.LINE_LOGIN_CHANNEL_SECRET || "").trim();
  const apiPublicBase = cleanUrl(process.env.API_PUBLIC_BASE_URL || "http://127.0.0.1:5188");
  return {
    channelId,
    channelSecret,
    liffId: String(process.env.LINE_LIFF_ID || "").trim(),
    callbackUrl: String(process.env.LINE_LOGIN_CALLBACK_URL || `${apiPublicBase}/api/auth/line/callback`).trim(),
    authorizeUrl: String(process.env.LINE_LOGIN_AUTHORIZE_URL || defaultAuthorizeUrl).trim(),
    apiBase: cleanUrl(process.env.LINE_LOGIN_API_BASE || defaultApiBase)
  };
}

function lineLoginReadiness() {
  const config = lineLoginConfig();
  return {
    configured: Boolean(config.channelId && config.channelSecret && config.callbackUrl),
    channelIdConfigured: Boolean(config.channelId),
    channelSecretConfigured: Boolean(config.channelSecret),
    callbackUrlConfigured: Boolean(config.callbackUrl),
    liffConfigured: Boolean(config.liffId),
    liffId: config.liffId || null
  };
}

function requireLineLoginConfig() {
  const config = lineLoginConfig();
  if (!config.channelId || config.channelSecret.length < 20 || !config.callbackUrl) {
    const error = new Error("LINE Login 尚未完成設定");
    error.statusCode = 503;
    throw error;
  }
  return config;
}

function createPkceValues() {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function authorizationUrl({ state, nonce, codeChallenge }) {
  const config = requireLineLoginConfig();
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.channelId);
  url.searchParams.set("redirect_uri", config.callbackUrl);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", "openid profile");
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function lineFormRequest(url, form) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(10000)
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const error = new Error(`LINE Login HTTP ${response.status}: ${String(payload.error_description || payload.error || "驗證失敗").slice(0, 200)}`);
    error.statusCode = 502;
    throw error;
  }
  return payload;
}

async function exchangeAuthorizationCode({ code, codeVerifier }) {
  const config = requireLineLoginConfig();
  return lineFormRequest(`${config.apiBase}/oauth2/v2.1/token`, {
    grant_type: "authorization_code",
    code,
    redirect_uri: config.callbackUrl,
    client_id: config.channelId,
    client_secret: config.channelSecret,
    code_verifier: codeVerifier
  });
}

async function verifyLineIdToken(idToken, nonce = "") {
  const config = requireLineLoginConfig();
  const form = { id_token: idToken, client_id: config.channelId };
  if (nonce) form.nonce = nonce;
  const payload = await lineFormRequest(`${config.apiBase}/oauth2/v2.1/verify`, form);
  if (!/^U[0-9a-f]{32}$/i.test(String(payload.sub || ""))) {
    const error = new Error("LINE Login 未回傳有效使用者識別碼");
    error.statusCode = 401;
    throw error;
  }
  return {
    lineUserId: payload.sub,
    name: String(payload.name || "").slice(0, 80),
    picture: String(payload.picture || "").slice(0, 500)
  };
}

module.exports = {
  authorizationUrl,
  createPkceValues,
  exchangeAuthorizationCode,
  lineLoginConfig,
  lineLoginReadiness,
  verifyLineIdToken
};
