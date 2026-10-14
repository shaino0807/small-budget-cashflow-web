const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { officialDate, atomicWriteJson } = require("./update-safety");
const { randomUUID } = require("node:crypto");
const { sha256, checkContent, createBatch, writeBatch } = require("./data-batch");

function validatePreservation(before, after) {
  const etfs = new Set((after.etfs || []).map((r) => r.ticker));
  for (const row of before.etfs || []) {
    if (!etfs.has(row.ticker)) throw new Error("ETF master lost: " + row.ticker);
  }
  const stocks = new Map((after.stocks?.items || []).map((r) => [r.ticker, r]));
  for (const row of before.stocks?.items || []) {
    const next = stocks.get(row.ticker);
    if (!next) throw new Error("Stock master lost: " + row.ticker);
    if (!row.latestPrice) continue;
    if (!next.latestPrice) throw new Error("Stock price lost: " + row.ticker);
    const date = officialDate(row.latestPrice.date), nextDate = officialDate(next.latestPrice.date);
    if (date && (!nextDate || nextDate < date)) throw new Error("Stock price date regressed: " + row.ticker);
    if (typeof row.latestPrice.close === "number" && row.latestPrice.close > 0
      && !(typeof next.latestPrice.close === "number" && next.latestPrice.close > 0)) {
      throw new Error("Stock close lost: " + row.ticker);
    }
  }
  const prices = new Set((after.priceSeries?.items || []).map((r) => r.ticker + ":" + r.date));
  for (const row of before.priceSeries?.items || []) {
    if (!prices.has(row.ticker + ":" + row.date)) throw new Error("ETF price history lost: " + row.ticker + ":" + row.date);
  }
}

const steps = ["update-etf-master.js", "update-price-series.js", "update-issuer-official-data.js",
  "update-stock-master.js", "finalize-data-quality.js", "validate-etf-data.js"];

function runStep(script, candidate) {
  const result = spawnSync(process.execPath, [path.join(__dirname, script)], {
    env: { ...process.env, ETF_DATABASE_PATH: candidate }, stdio: "inherit", windowsHide: true,
    timeout: 15 * 60 * 1000
  });
  if (result.error || result.status !== 0) throw new Error(script + " failed: " + (result.error?.message || result.status));
}

function refreshDatabase(file, { execute = runStep, batchDir = process.env.DATA_BATCH_DIR ||
  (process.env.CUSTOMER_DATA_DIR ? path.join(process.env.CUSTOMER_DATA_DIR, "market-batches") : path.join(path.dirname(file), "batches")) } = {}) {
  const beforeBytes = fs.readFileSync(file);
  const before = JSON.parse(beforeBytes);
  const startedAt = new Date().toISOString(), id = startedAt.replace(/[:.]/g, "-") + "-" + randomUUID();
  const completedSteps = [];
  let after = before, checks;
  const dir = fs.mkdtempSync(path.join(path.dirname(file), ".etf-refresh-"));
  const candidate = path.join(dir, "candidate.json");
  try {
    fs.writeFileSync(candidate, beforeBytes);
    for (const step of steps) {
      const start = Date.now();
      execute(step, candidate);
      completedSteps.push({ step, status: "pass", elapsedMs: Date.now() - start });
    }
    after = JSON.parse(fs.readFileSync(candidate, "utf8"));
    validatePreservation(before, after);
    checks = checkContent(before, after);
    if (checks.status === "fail") throw new Error("Content validation failed: " + checks.errors.join("; "));
    // Do not replace a file another updater changed while this run was in flight.
    if (!beforeBytes.equals(fs.readFileSync(file))) throw new Error("Database changed during refresh; candidate not promoted");
    const batch = createBatch(before, after, { id, startedAt, steps: completedSteps, checks, previousSha256: sha256(beforeBytes) });
    after.metadata ||= {};
    after.metadata.dataBatch = { batchId: id, schemaVersion: 1, status: batch.status, finishedAt: batch.finishedAt,
      version: batch.version, coverage: batch.outputInventory.map(({ sources, ...row }) => row),
      checks: { status: checks.status, errors: checks.errors.length, warnings: checks.warnings.length, notVerified: checks.notVerified } };
    batch.outputFileSha256 = sha256(Buffer.from(JSON.stringify(after, null, 2) + "\n"));
    batch.promotion = "validated_candidate";
    writeBatch(batchDir, batch);
    atomicWriteJson(file, after);
    return after;
  } catch (error) {
    const batch = createBatch(before, after, { id, startedAt, steps: completedSteps, checks, previousSha256: sha256(beforeBytes), error: error.message });
    batch.promotion = "rejected";
    writeBatch(batchDir, batch);
    throw error;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

if (require.main === module) {
  try {
    const file = process.env.ETF_DATABASE_PATH ? path.resolve(process.env.ETF_DATABASE_PATH) : path.join(__dirname, "../data/etf-database.json");
    refreshDatabase(file);
    console.log("Official database candidate validated and promoted");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { refreshDatabase, validatePreservation, steps };
