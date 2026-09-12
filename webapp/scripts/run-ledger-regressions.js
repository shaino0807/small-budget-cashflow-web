const { spawnSync } = require("node:child_process");
const path = require("node:path");

const scripts = [
  "test-cashflow-visual.js", "test-ledger-improvements.js", "test-image-privacy.js", "test-public-boundary.js", "test-line-webhook.js", "test-line-auth.js",
  "test-line-migration.js", "test-voice-privacy.js", "test-customer-api.js", "test-linepay-client.js"
].map((name) => [name]);
if (process.argv.includes("--browser")) {
  scripts.push(["smoke-test-page.js", "--serve", "--viewport=390x844"], ["smoke-test-page.js", "--serve", "--viewport=1440x900"]);
}
for (const [name, ...args] of scripts) {
  console.log(`Running ${name} ${args.join(" ")}`);
  const result = spawnSync(process.execPath, [path.join(__dirname, name), ...args], {
    windowsHide: true, stdio: "inherit", timeout: 180000,
    env: { ...process.env, LINE_REPLY_DISABLED: "1", LINE_IMAGE_PARSER_ENABLED: "0", LINE_AI_PARSER_ENABLED: "0" }
  });
  if (result.error || result.status !== 0) {
    console.error(`${name} failed: ${result.error?.message || `exit ${result.status}`}`);
    process.exit(1);
  }
}
console.log("Ledger regression gate passed.");
