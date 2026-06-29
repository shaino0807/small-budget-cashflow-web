const fs = require("fs");
const path = require("path");

const backendApiBase = String(process.env.BACKEND_API_BASE || "").trim().replace(/\/$/, "");
const consultationIgUrl = String(process.env.CONSULTATION_IG_URL || "https://www.instagram.com/chendino080077/").trim();
const consultationLineUrl = String(process.env.CONSULTATION_LINE_URL || "").trim();
const fullReportPriceTwd = Math.max(1, Math.round(Number(process.env.FULL_REPORT_PRICE_TWD || 499)));
const consultationDepositTwd = Math.max(1, Math.round(Number(process.env.CONSULTATION_DEPOSIT_TWD || 200)));
const consultationFeeTwd = Math.max(1, Math.round(Number(process.env.CONSULTATION_FEE_TWD || 1500)));

function assertHttpsUrl(name, value, required = false) {
  if (!value && !required) return;
  if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/.*)?$/i.test(value)) {
    throw new Error(`${name} must be an HTTPS URL`);
  }
}

assertHttpsUrl("BACKEND_API_BASE", backendApiBase);
assertHttpsUrl("CONSULTATION_IG_URL", consultationIgUrl, true);
assertHttpsUrl("CONSULTATION_LINE_URL", consultationLineUrl);

const output = [
  `window.CASHFLOW_API_BASE = ${JSON.stringify(backendApiBase)};`,
  `window.CONSULTATION_IG_URL = ${JSON.stringify(consultationIgUrl)};`,
  `window.CONSULTATION_LINE_URL = ${JSON.stringify(consultationLineUrl)};`,
  `window.FULL_REPORT_PRICE_TWD = ${JSON.stringify(fullReportPriceTwd)};`,
  `window.CONSULTATION_DEPOSIT_TWD = ${JSON.stringify(consultationDepositTwd)};`,
  `window.CONSULTATION_FEE_TWD = ${JSON.stringify(consultationFeeTwd)};`,
  ""
].join("\n");

fs.writeFileSync(path.join(__dirname, "..", "runtime-config.js"), output, "utf8");
console.log(JSON.stringify({
  backendConfigured: Boolean(backendApiBase),
  origin: backendApiBase ? new URL(backendApiBase).origin : null,
  consultationIgConfigured: Boolean(consultationIgUrl),
  consultationLineConfigured: Boolean(consultationLineUrl),
  fullReportPriceTwd,
  consultationDepositTwd,
  consultationFeeTwd
}));
