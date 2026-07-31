const { linePayConfig, linePayReadiness } = require("../linepay");
const { productCatalog } = require("../payment-catalog");

const placeholderPatterns = [
  /^your-/i,
  /placeholder/i,
  /example/i,
  /請填/i,
  /你的/i
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
  const mode = process.argv.includes("--production")
    ? "production"
    : process.argv.includes("--sandbox")
      ? "sandbox"
      : "local";
  const errors = [];
  const warnings = [];
  const config = linePayConfig();
  const readiness = linePayReadiness();
  const catalog = productCatalog();
  const sitePublicBaseUrl = String(process.env.SITE_PUBLIC_BASE_URL || process.env.PUBLIC_SITE_BASE_URL || "").trim();
  const apiPublicBaseUrl = String(process.env.API_PUBLIC_BASE_URL || process.env.BACKEND_PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").trim();
  const consultationIgUrl = String(process.env.CONSULTATION_IG_URL || "https://www.instagram.com/chendino080077/").trim();
  const consultationLineUrl = String(process.env.CONSULTATION_LINE_URL || "").trim();
  const fullReportPrice = moneyEnv("FULL_REPORT_PRICE_TWD", 499);
  const consultationDeposit = moneyEnv("CONSULTATION_DEPOSIT_TWD", 200);
  const consultationFee = moneyEnv("CONSULTATION_FEE_TWD", 1500);

  if (mode === "production" || mode === "sandbox") {
    if (process.env.LINE_PAY_ENV !== mode) errors.push(`LINE_PAY_ENV must be ${mode}`);
    if (isPlaceholder(process.env.LINE_PAY_CHANNEL_ID)) errors.push("LINE_PAY_CHANNEL_ID is missing or placeholder");
    if (isPlaceholder(process.env.LINE_PAY_CHANNEL_SECRET)) errors.push("LINE_PAY_CHANNEL_SECRET is missing or placeholder");
    if (!isHttpsUrl(sitePublicBaseUrl)) errors.push("SITE_PUBLIC_BASE_URL must be an HTTPS URL");
    if (!isHttpsUrl(apiPublicBaseUrl)) errors.push("API_PUBLIC_BASE_URL or RENDER_EXTERNAL_URL must be an HTTPS URL");
  } else if (!readiness.configured) {
    warnings.push("LINE Pay credentials are not configured; checkout is safely disabled and no order will be created");
  }

  if (mode === "production") {
    if (config.apiBaseUrl !== "https://api-pay.line.me") errors.push("Production must use https://api-pay.line.me");
    if (!isHttpsUrl(consultationLineUrl)) errors.push("CONSULTATION_LINE_URL must be set to an HTTPS URL");
  } else if (mode === "sandbox") {
    if (config.apiBaseUrl !== "https://sandbox-api-pay.line.me") errors.push("Sandbox must use https://sandbox-api-pay.line.me");
    if (!consultationLineUrl) warnings.push("CONSULTATION_LINE_URL is not configured; LINE consultation CTA stays disabled");
  }

  if (process.env.LINE_PAY_API_BASE_URL && mode !== "local") {
    errors.push("LINE_PAY_API_BASE_URL override is only allowed for local automated tests");
  }
  if (!isHttpsUrl(consultationIgUrl)) errors.push("CONSULTATION_IG_URL must be an HTTPS URL");
  if (fullReportPrice !== 499) warnings.push(`FULL_REPORT_PRICE_TWD is ${fullReportPrice}; expected current product price is 499`);
  if (consultationDeposit !== 200) errors.push("CONSULTATION_DEPOSIT_TWD must be 200");
  if (consultationFee !== 1500) errors.push("CONSULTATION_FEE_TWD must be 1500");
  if (catalog.full_report.amount !== fullReportPrice) errors.push("full_report catalog amount does not match FULL_REPORT_PRICE_TWD");
  if (catalog.consultation_deposit.amount !== consultationDeposit) errors.push("consultation_deposit catalog amount does not match CONSULTATION_DEPOSIT_TWD");

  const result = {
    ok: errors.length === 0,
    mode,
    provider: readiness.provider,
    configured: readiness.configured,
    environment: readiness.environment,
    apiHost: readiness.apiHost,
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
