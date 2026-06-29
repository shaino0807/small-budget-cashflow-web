const { ecpayConfig, productCatalog } = require("../ecpay");

const placeholderPatterns = [
  /^your-/i,
  /placeholder/i,
  /example/i,
  /請填/i,
  /範例/i
];

function isPlaceholder(value) {
  const text = String(value || "").trim();
  return !text || placeholderPatterns.some((pattern) => pattern.test(text));
}

function isHttpsUrl(value) {
  return /^https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/.*)?$/i.test(String(value || "").trim());
}

function moneyEnv(name, fallback) {
  const value = Math.round(Number(process.env[name] || fallback));
  return Number.isFinite(value) && value > 0 ? value : NaN;
}

function main() {
  const mode = process.argv.includes("--production") ? "production" : process.argv.includes("--stage") ? "stage" : "local";
  const requirePublicUrls = mode === "production" || mode === "stage";
  const errors = [];
  const warnings = [];
  const config = ecpayConfig();
  const catalog = productCatalog();
  const sitePublicBaseUrl = String(process.env.SITE_PUBLIC_BASE_URL || process.env.PUBLIC_SITE_BASE_URL || "").trim();
  const apiPublicBaseUrl = String(process.env.API_PUBLIC_BASE_URL || process.env.BACKEND_PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").trim();
  const consultationIgUrl = String(process.env.CONSULTATION_IG_URL || "https://www.instagram.com/chendino080077/").trim();
  const consultationLineUrl = String(process.env.CONSULTATION_LINE_URL || "").trim();
  const fullReportPrice = moneyEnv("FULL_REPORT_PRICE_TWD", 499);
  const consultationDeposit = moneyEnv("CONSULTATION_DEPOSIT_TWD", 200);
  const consultationFee = moneyEnv("CONSULTATION_FEE_TWD", 1500);

  if (mode === "production") {
    if (process.env.ECPAY_ENV !== "production") errors.push("ECPAY_ENV must be production");
    if (config.useStageDefaults) errors.push("ECPAY_USE_STAGE_DEFAULTS must be 0 for production");
    if (isPlaceholder(process.env.ECPAY_MERCHANT_ID)) errors.push("ECPAY_MERCHANT_ID is missing or placeholder");
    if (isPlaceholder(process.env.ECPAY_HASH_KEY)) errors.push("ECPAY_HASH_KEY is missing or placeholder");
    if (isPlaceholder(process.env.ECPAY_HASH_IV)) errors.push("ECPAY_HASH_IV is missing or placeholder");
    if (!isHttpsUrl(consultationLineUrl)) errors.push("CONSULTATION_LINE_URL must be set to an HTTPS URL");
  } else if (mode === "stage") {
    if (process.env.ECPAY_ENV !== "stage") errors.push("ECPAY_ENV must be stage");
    if (!config.merchantId || !config.hashKey || !config.hashIv) {
      errors.push("Stage ECPay credentials are missing; set ECPAY_USE_STAGE_DEFAULTS=1 or provide stage credentials");
    }
    if (!config.checkoutUrl.includes("payment-stage.ecpay.com.tw")) errors.push("Stage checkout URL must use payment-stage.ecpay.com.tw");
    if (!consultationLineUrl) warnings.push("CONSULTATION_LINE_URL is not configured; LINE consultation CTA stays disabled during stage testing");
  } else {
    if (!config.merchantId || !config.hashKey || !config.hashIv) {
      warnings.push("ECPay credentials are not configured; checkout endpoint will reject live payment creation");
    }
    if (!consultationLineUrl) warnings.push("CONSULTATION_LINE_URL is not configured; LINE consultation CTA stays disabled");
  }

  if (requirePublicUrls) {
    if (!isHttpsUrl(sitePublicBaseUrl)) errors.push("SITE_PUBLIC_BASE_URL must be an HTTPS URL");
    if (!isHttpsUrl(apiPublicBaseUrl)) errors.push("API_PUBLIC_BASE_URL or RENDER_EXTERNAL_URL must be an HTTPS URL");
  }
  if (!isHttpsUrl(consultationIgUrl)) errors.push("CONSULTATION_IG_URL must be an HTTPS URL");
  if (fullReportPrice !== 499) warnings.push(`FULL_REPORT_PRICE_TWD is ${fullReportPrice}; expected current product price is 499`);
  if (consultationDeposit !== 200) errors.push("CONSULTATION_DEPOSIT_TWD must be 200");
  if (consultationFee !== 1500) errors.push("CONSULTATION_FEE_TWD must be 1500");
  if (catalog.full_report.amount !== fullReportPrice) errors.push("full_report catalog amount does not match FULL_REPORT_PRICE_TWD");
  if (catalog.consultation_deposit.amount !== consultationDeposit) errors.push("consultation_deposit catalog amount does not match CONSULTATION_DEPOSIT_TWD");
  if (!config.checkoutUrl.includes("ecpay.com.tw")) errors.push("ECPay checkout URL is not an ECPay endpoint");

  const result = {
    ok: errors.length === 0,
    mode,
    ecpayConfigured: Boolean(config.merchantId && config.hashKey && config.hashIv),
    checkoutHost: config.checkoutUrl ? new URL(config.checkoutUrl).host : null,
    sitePublicBaseConfigured: Boolean(sitePublicBaseUrl),
    apiPublicBaseConfigured: Boolean(apiPublicBaseUrl),
    consultationIgConfigured: Boolean(consultationIgUrl),
    consultationLineConfigured: Boolean(consultationLineUrl),
    prices: {
      fullReport: fullReportPrice,
      consultationDeposit,
      consultationFee
    },
    warnings,
    errors
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

main();
