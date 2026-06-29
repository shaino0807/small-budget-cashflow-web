const crypto = require("crypto");

const stageDefaults = {
  merchantId: "3002607",
  hashKey: "pwFHCqoQZGmho4w6",
  hashIv: "EkRm7iFT261dpevs"
};

function twDateTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function ecpayEncode(value) {
  return encodeURIComponent(String(value))
    .toLowerCase()
    .replace(/%20/g, "+")
    .replace(/%2d/g, "-")
    .replace(/%5f/g, "_")
    .replace(/%2e/g, ".")
    .replace(/%21/g, "!")
    .replace(/%2a/g, "*")
    .replace(/%28/g, "(")
    .replace(/%29/g, ")");
}

function computeCheckMacValue(params, hashKey, hashIv) {
  const sorted = Object.keys(params)
    .filter((key) => key !== "CheckMacValue" && params[key] !== undefined && params[key] !== null)
    .sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase(), "en"));
  const body = sorted.map((key) => `${key}=${params[key]}`).join("&");
  const encoded = ecpayEncode(`HashKey=${hashKey}&${body}&HashIV=${hashIv}`);
  return crypto.createHash("sha256").update(encoded, "utf8").digest("hex").toUpperCase();
}

function productCatalog() {
  return {
    full_report: {
      productType: "full_report",
      name: "完整報告",
      amount: Math.max(1, Math.round(Number(process.env.FULL_REPORT_PRICE_TWD || 499))),
      entitlement: "full_report",
      description: "小資現金流完整報告"
    },
    consultation_deposit: {
      productType: "consultation_deposit",
      name: "諮詢訂金",
      amount: Math.max(1, Math.round(Number(process.env.CONSULTATION_DEPOSIT_TWD || 200))),
      entitlement: "consultation_deposit",
      description: "一對一諮詢預約訂金"
    }
  };
}

function productFor(type) {
  const product = productCatalog()[type];
  if (!product) {
    const error = new Error("不支援的付款項目");
    error.statusCode = 400;
    throw error;
  }
  return product;
}

function ecpayConfig() {
  const useStageDefaults = process.env.ECPAY_USE_STAGE_DEFAULTS === "1";
  const isProduction = process.env.ECPAY_ENV === "production";
  const merchantId = process.env.ECPAY_MERCHANT_ID || (!isProduction && useStageDefaults ? stageDefaults.merchantId : "");
  const hashKey = process.env.ECPAY_HASH_KEY || (!isProduction && useStageDefaults ? stageDefaults.hashKey : "");
  const hashIv = process.env.ECPAY_HASH_IV || (!isProduction && useStageDefaults ? stageDefaults.hashIv : "");
  const checkoutUrl = process.env.ECPAY_CHECKOUT_URL || (
    isProduction
      ? "https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5"
      : "https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5"
  );
  return { merchantId, hashKey, hashIv, checkoutUrl, isProduction, useStageDefaults };
}

function assertConfigured(config = ecpayConfig()) {
  if (!config.merchantId || !config.hashKey || !config.hashIv) {
    const error = new Error("綠界金流尚未設定 MerchantID、HashKey、HashIV");
    error.statusCode = 503;
    throw error;
  }
}

function buildCheckout({ order, product, siteBaseUrl, apiBaseUrl }) {
  const config = ecpayConfig();
  assertConfigured(config);
  const fields = {
    MerchantID: config.merchantId,
    MerchantTradeNo: order.id,
    MerchantTradeDate: twDateTime(new Date(order.createdAt || Date.now())),
    PaymentType: "aio",
    TotalAmount: String(order.amount),
    TradeDesc: "SmallBudgetCashflowReport",
    ItemName: product.name,
    ReturnURL: `${apiBaseUrl}/api/payments/ecpay/notify`,
    ChoosePayment: "Credit",
    ClientBackURL: `${siteBaseUrl}/?payment=back&orderId=${encodeURIComponent(order.id)}`,
    OrderResultURL: `${apiBaseUrl}/api/payments/ecpay/result`,
    NeedExtraPaidInfo: "N",
    CustomField1: order.reportId,
    CustomField2: order.productType,
    EncryptType: "1"
  };
  fields.CheckMacValue = computeCheckMacValue(fields, config.hashKey, config.hashIv);
  return {
    provider: "ecpay",
    method: "POST",
    action: config.checkoutUrl,
    fields
  };
}

function verifyNotification(params) {
  const config = ecpayConfig();
  assertConfigured(config);
  const expected = computeCheckMacValue(params, config.hashKey, config.hashIv);
  const actual = String(params.CheckMacValue || "").toUpperCase();
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function createMerchantTradeNo() {
  const stamp = Date.now().toString(36).toUpperCase();
  const random = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `CF${stamp}${random}`.slice(0, 20);
}

module.exports = {
  buildCheckout,
  computeCheckMacValue,
  createMerchantTradeNo,
  ecpayConfig,
  productFor,
  productCatalog,
  verifyNotification
};
