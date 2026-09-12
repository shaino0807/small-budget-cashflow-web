const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "source-date-"));
const file = path.join(dir, "database.json");
try {
  for (const [status, attempt, date, expectedStatus] of [
    ["preserved_previous_snapshot_after_failed_refresh", "failed", "2026-09-11", "preserved_previous_snapshot"],
    ["preserved_previous_snapshot_after_undated_refresh", "loaded", "2026-09-11", "preserved_previous_snapshot"],
    ["official_twse_loaded", "loaded", "2026-09-12", "current"],
    ["official_twse_loaded", "loaded", null, "missing_date"]
  ]) {
    fs.writeFileSync(file, JSON.stringify({ stocks: { status, updatedAt: "2026-09-11T04:00:00Z",
      sourceAttempts: [{ source: "tpex-mainboard-daily-close-quotes", status: attempt, sourceDataDate: null }],
      items: [{ latestPrice: { source: "tpex-mainboard-daily-close-quotes", date } }]
    } }));
    const run = spawnSync(process.execPath, [path.join(__dirname, "finalize-data-quality.js")], {
      env: { ...process.env, ETF_DATABASE_PATH: file }, encoding: "utf8", windowsHide: true
    });
    assert.equal(run.status, 0, run.stderr);
    const source = JSON.parse(fs.readFileSync(file)).metadata.sourceFreshness.sources.tpexStockDaily;
    assert.equal(source.sourceDataDate, date, "must keep the actual row date, including null");
    assert.equal(source.status, expectedStatus);
    assert.equal(source.lastAttemptStatus, attempt);
    assert.equal(source.observedAt, "2026-09-11T04:00:00Z", "must not replace retained data timestamp with execution time");
  }
  console.log(JSON.stringify({ passed: true, failedFetchRetainsOfficialDate: true, missingDateNeverInvented: true }));
} finally { fs.rmSync(file, { force: true }); fs.rmdirSync(dir); }
