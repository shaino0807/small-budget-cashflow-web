const crypto = require("crypto");

const { productCatalog, productFor } = require("./payment-catalog");

const linePayHosts = {
  sandbox: "https://sandbox-api-pay.line.me",
  production: "https://api-pay.line.me"
};

function cleanBaseUrl(value) {
  return String(value || "").replace(/\/$/, "");
}

function linePayConfig() {
  const environment = process.env.LINE_PAY_ENV === "production" ? "production" : "sandbox";
  return {
    environment,
    channelId: String(process.env.LINE_PAY_CHANNEL_ID || ""),
    channelSecret: String(process.env.LINE_PAY_CHANNEL_SECRET || ""),
    apiBaseUrl: cleanBaseUrl(process.env.LINE_PAY_API_BASE_URL || linePayHosts[environment])
  };
}

function linePayReadiness() {
  const config = linePayConfig();
  return {
    provider: "linepay",
    configured: Boolean(config.channelId && config.channelSecret),
    environment: config.environment,
    apiHost: new URL(config.apiBaseUrl).host
  };
}

function assertLinePayConfigured(config = linePayConfig()) {
  if (!config.channelId || !config.channelSecret) {
    const error = new Error("LINE Pay 商店審核中，付款功能尚未開放");
    error.statusCode = 503;
    throw error;
  }
}

function parseLinePayJson(rawText) {
  const protectedText = String(rawText || "").replace(
    /(:\s*)(-?\d{16,})(?=\s*[,}\]])/g,
    '$1"$2"'
  );
  return JSON.parse(protectedText);
}

function signLinePayRequest({ channelSecret, method, apiPath, queryString = "", body = "", nonce }) {
  const normalizedQueryString = String(queryString || "").replace(/^\?/, "");
  const message = method === "GET"
    ? `${channelSecret}${apiPath}${normalizedQueryString}${nonce}`
    : `${channelSecret}${apiPath}${body}${nonce}`;
  return crypto.createHmac("sha256", channelSecret).update(message, "utf8").digest("base64");
}

async function linePayApiRequest({
  method,
  apiPath,
  queryString = "",
  data = null,
  timeoutMs = 20000,
  fetchImpl = globalThis.fetch,
  config = linePayConfig()
}) {
  assertLinePayConfigured(config);
  const nonce = crypto.randomUUID();
  const body = data === null ? "" : JSON.stringify(data);
  const normalizedQueryString = String(queryString || "").replace(/^\?/, "");
  const authorization = signLinePayRequest({
    channelSecret: config.channelSecret,
    method,
    apiPath,
    queryString: normalizedQueryString,
    body,
    nonce
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${config.apiBaseUrl}${apiPath}${normalizedQueryString ? `?${normalizedQueryString}` : ""}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-LINE-ChannelId": config.channelId,
        "X-LINE-Authorization-Nonce": nonce,
        "X-LINE-Authorization": authorization
      },
      body: body || undefined,
      signal: controller.signal
    });
    const rawText = await response.text();
    if (!response.ok) {
      const error = new Error(`LINE Pay API HTTP ${response.status}`);
      error.statusCode = 502;
      error.providerStatus = response.status;
      throw error;
    }
    const result = parseLinePayJson(rawText);
    if (!result || typeof result.returnCode !== "string") {
      const error = new Error("LINE Pay 回傳格式不正確");
      error.statusCode = 502;
      throw error;
    }
    return result;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("LINE Pay 連線逾時，請稍後重新確認付款狀態");
      timeoutError.statusCode = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function assertLinePaySuccess(result, action) {
  if (result.returnCode === "0000") return result;
  const error = new Error(`LINE Pay ${action}失敗：${result.returnMessage || result.returnCode}`);
  error.statusCode = 502;
  error.providerCode = result.returnCode;
  error.providerResult = result;
  throw error;
}

async function requestLinePayPayment({ order, product, confirmUrl, cancelUrl, fetchImpl, config }) {
  const result = assertLinePaySuccess(await linePayApiRequest({
    method: "POST",
    apiPath: "/v4/payments/request",
    data: {
      amount: Number(order.amount),
      currency: order.currency,
      orderId: order.id,
      packages: [{
        id: order.id,
        amount: Number(order.amount),
        products: [{
          id: product.productType,
          name: product.name,
          quantity: 1,
          price: Number(order.amount)
        }]
      }],
      redirectUrls: { confirmUrl, cancelUrl }
    },
    timeoutMs: 12000,
    fetchImpl,
    config
  }), "付款請求");
  const transactionId = String(result.info?.transactionId || "");
  const webUrl = String(result.info?.paymentUrl?.web || "");
  const appUrl = String(result.info?.paymentUrl?.app || "");
  if (!transactionId || (!webUrl && !appUrl)) {
    const error = new Error("LINE Pay 未回傳交易編號或付款網址");
    error.statusCode = 502;
    throw error;
  }
  return { transactionId, paymentUrl: { web: webUrl, app: appUrl }, providerResult: result };
}

async function confirmLinePayPayment({ transactionId, amount, currency, fetchImpl, config }) {
  return assertLinePaySuccess(await linePayApiRequest({
    method: "POST",
    apiPath: `/v4/payments/${encodeURIComponent(String(transactionId))}/confirm`,
    data: { amount: Number(amount), currency },
    timeoutMs: 45000,
    fetchImpl,
    config
  }), "付款確認");
}

async function checkLinePayPaymentRequest({ transactionId, fetchImpl, config }) {
  return linePayApiRequest({
    method: "GET",
    apiPath: `/v4/payments/requests/${encodeURIComponent(String(transactionId))}/check`,
    timeoutMs: 22000,
    fetchImpl,
    config
  });
}

async function retrieveLinePayPayment({ transactionId, orderId, fetchImpl, config }) {
  const params = new URLSearchParams();
  if (transactionId) params.append("transactionId", String(transactionId));
  if (orderId) params.append("orderId", String(orderId));
  const queryString = params.toString();
  return assertLinePaySuccess(await linePayApiRequest({
    method: "GET",
    apiPath: "/v4/payments",
    queryString,
    timeoutMs: 22000,
    fetchImpl,
    config
  }), "交易查詢");
}

async function refundLinePayPayment({ transactionId, refundAmount = null, fetchImpl, config }) {
  const data = refundAmount === null ? {} : { refundAmount: Number(refundAmount) };
  return assertLinePaySuccess(await linePayApiRequest({
    method: "POST",
    apiPath: `/v4/payments/${encodeURIComponent(String(transactionId))}/refund`,
    data,
    timeoutMs: 22000,
    fetchImpl,
    config
  }), "退款");
}

module.exports = {
  assertLinePayConfigured,
  checkLinePayPaymentRequest,
  confirmLinePayPayment,
  linePayApiRequest,
  linePayConfig,
  linePayReadiness,
  parseLinePayJson,
  productCatalog,
  productFor,
  refundLinePayPayment,
  requestLinePayPayment,
  retrieveLinePayPayment,
  signLinePayRequest
};
