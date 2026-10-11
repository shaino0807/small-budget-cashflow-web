const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Test Taipei month changes while the OS clock and real timers keep running.
const scenarios = [
  { now: "2026-09-15T04:00:00.000Z", month: "2026-09" },
  { now: "2026-09-30T15:59:59.000Z", month: "2026-09" },
  { now: "2026-09-30T16:00:00.000Z", month: "2026-10" },
  { now: "2026-10-11T04:00:00.000Z", month: "2026-10" },
  { now: "2026-12-31T15:59:59.000Z", month: "2026-12" },
  { now: "2026-12-31T16:00:00.000Z", month: "2027-01" }
];
const results = [];
for (const scenario of scenarios) {
  const result = spawnSync(process.execPath, [
    "--require", path.join(__dirname, "test-fixture-clock.js"),
    path.join(__dirname, "test-ledger-improvements.js")
  ], {
    env: { ...process.env, CASHFLOW_TEST_NOW: scenario.now },
    windowsHide: true, encoding: "utf8", timeout: 30000
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${scenario.now}\n${result.stdout}\n${result.stderr}`);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.passed, true);
  assert.equal(evidence.currentMonth, scenario.month, "Taipei month follows the simulated date");
  assert.equal(evidence.fixtureMonth, `${scenario.month.slice(0, 4)}-09`, "month-only dates keep the simulated current year");
  assert.equal(evidence.screenshotEntries, 22);
  assert.equal(evidence.screenshotExpense, 54733);
  assert.equal(evidence.renderExpense, 2758);
  assert.equal(evidence.externalCalls, 0);
  results.push({ ...scenario, fixtureMonth: evidence.fixtureMonth, passed: true });
}
console.log(JSON.stringify({ passed: true, nodeVersion: process.version, scenarios: results, externalCalls: 0 }, null, 2));
