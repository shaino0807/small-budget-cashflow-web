const crypto = require("crypto");

const {
  assertLinePayConfigured,
  linePayApiRequest,
  parseLinePayJson,
  requestLinePayPayment,
  signLinePayRequest
} = require("../linepay");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  let unconfiguredError = null;
  try {
    assertLinePayConfigured({ channelId: "", channelSecret: "" });
  } catch (error) {
    unconfiguredError = error;
  }
  assert(unconfiguredError?.statusCode === 503, "Missing LINE Pay credentials did not fail closed");

  const transactionId = "2026072812345678901";
  const parsed = parseLinePayJson(`{"returnCode":"0000","info":{"transactionId":${transactionId},"refundTransactionId":2026072899999999999,"originalTransactionId":2026072877777777777}}`);
  assert(parsed.info.transactionId === transactionId, "Large transactionId lost precision");
  assert(parsed.info.refundTransactionId === "2026072899999999999", "Large refundTransactionId lost precision");
  assert(parsed.info.originalTransactionId === "2026072877777777777", "Other large LINE Pay integers lost precision");

  const channelSecret = "test-secret";
  const nonce = "fixed-nonce";
  const expected = crypto.createHmac("sha256", channelSecret)
    .update(`${channelSecret}/v4/paymentstransactionId=123${nonce}`, "utf8")
    .digest("base64");
  const actual = signLinePayRequest({
    channelSecret,
    method: "GET",
    apiPath: "/v4/payments",
    queryString: "transactionId=123",
    nonce
  });
  assert(actual === expected, "GET signature mismatch");

  let captured = null;
  const config = {
    environment: "sandbox",
    channelId: "test-channel",
    channelSecret,
    apiBaseUrl: "https://linepay.test"
  };
  const fetchImpl = async (url, options) => {
    captured = { url, options };
    return new Response(`{"returnCode":"0000","returnMessage":"Success","info":{"transactionId":${transactionId},"paymentUrl":{"web":"https://pay.test/web","app":"line://pay"}}}`, {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  const result = await requestLinePayPayment({
    order: { id: "LPTEST001", amount: 499, currency: "TWD" },
    product: { productType: "full_report", name: "完整報告" },
    confirmUrl: "https://merchant.test/confirm",
    cancelUrl: "https://merchant.test/cancel",
    fetchImpl,
    config
  });
  assert(result.transactionId === transactionId, "Request response transactionId lost precision");
  assert(result.paymentUrl.web === "https://pay.test/web", "Payment URL missing");
  assert(captured.url === "https://linepay.test/v4/payments/request", "Unexpected request URL");
  assert(captured.options.headers["X-LINE-ChannelId"] === "test-channel", "Channel ID header missing");
  assert(Boolean(captured.options.headers["X-LINE-Authorization"]), "Signature header missing");

  let getCaptured = null;
  await linePayApiRequest({
    method: "GET",
    apiPath: "/v4/payments",
    queryString: "transactionId=123",
    config,
    fetchImpl: async (url, options) => {
      getCaptured = { url, options };
      return new Response('{"returnCode":"0000","returnMessage":"Success","info":[]}', { status: 200 });
    }
  });
  const getNonce = getCaptured.options.headers["X-LINE-Authorization-Nonce"];
  const getExpected = signLinePayRequest({
    channelSecret,
    method: "GET",
    apiPath: "/v4/payments",
    queryString: "transactionId=123",
    nonce: getNonce
  });
  assert(getCaptured.url === "https://linepay.test/v4/payments?transactionId=123", "GET query URL mismatch");
  assert(getCaptured.options.headers["X-LINE-Authorization"] === getExpected, "GET request signature mismatch");

  console.log(JSON.stringify({
    passed: true,
    missingCredentialsFailClosed: true,
    largeTransactionIdsPreserved: true,
    signedHeadersPresent: true,
    getQuerySigned: true
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
