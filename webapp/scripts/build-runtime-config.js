const fs = require("fs");
const path = require("path");

const value = String(process.env.BACKEND_API_BASE || "").trim().replace(/\/$/, "");
if (value && !/^https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/.*)?$/i.test(value)) {
  throw new Error("BACKEND_API_BASE 必須是 HTTPS 網址");
}

const output = `window.CASHFLOW_API_BASE = ${JSON.stringify(value)};\n`;
fs.writeFileSync(path.join(__dirname, "..", "runtime-config.js"), output, "utf8");
console.log(JSON.stringify({ backendConfigured: Boolean(value), origin: value ? new URL(value).origin : null }));
