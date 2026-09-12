// Explicit opt-in only: consumes three paid vision calls using synthetic fixtures.
// Never invoked by CI or the normal regression runner. No retries or customer data.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { parseStatementImage } = require("../statement-reader");

async function main() {
  if (!process.argv.includes("--allow-three-synthetic-calls")) throw new Error("Explicit paid-test opt-in required.");
  if (!process.env.OPENAI_API_KEY) process.loadEnvFile(path.join(__dirname, "../.env.local"));
  if (!process.env.OPENAI_API_KEY) throw new Error("OpenAI key unavailable.");
  const cases = ["statement-normal", "statement-transfer", "statement-incomplete"];
  const selected = process.argv.find((arg) => arg.startsWith("--case="))?.slice(7);
  if (selected && !cases.includes(selected)) throw new Error("Unknown synthetic case.");
  const results = [];
  for (const name of cases) {
    if (selected && selected !== name) continue;
    const result = await parseStatementImage({ type: "image/png", buffer: fs.readFileSync(path.join(__dirname, `../reports/${name}.png`)) });
    console.log(JSON.stringify({ name, entries: result.entries.map(({ type, amount, occurredAt }) => ({ type, amount, occurredAt })), unresolved: result.unresolved.length }));
    if (name === "statement-normal") {
      assert.equal(result.unresolved.length, 0);
      assert.deepEqual(result.entries.map(({ type, amount, occurredAt }) => [type, amount, occurredAt.slice(0, 10)]), [
        ["expense", 230, "2026-09-01"], ["expense", 970, "2026-09-02"], ["income", 68981, "2026-09-05"]
      ]);
    } else if (name === "statement-transfer") {
      assert.ok(result.unresolved.length >= 2);
      assert.deepEqual(result.entries.map(({ type, amount }) => [type, amount]), [["expense", 120]]);
    } else {
      assert.equal(result.entries.length, 0);
      assert.ok(result.unresolved.length >= 2);
    }
    results.push({ name, passed: true, entries: result.entries.length, unresolved: result.unresolved.length });
    console.log(JSON.stringify(results.at(-1)));
  }
  console.log(JSON.stringify({ passed: true, calls: results.length, model: process.env.OPENAI_STATEMENT_MODEL || "gpt-4.1-mini", testedAt: new Date().toISOString() }));
}
main().catch((error) => { console.error(error.statementSafe || error.code === "ERR_ASSERTION" ? error.message : `${error.name}: synthetic validation failed`); process.exitCode = 1; });
