const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cashflow-line-migration-"));
const dbPath = path.join(dataDir, "customers.sqlite");
process.env.CUSTOMER_DATA_DIR = dataDir;
process.env.CUSTOMER_DATA_KEY = crypto.randomBytes(32).toString("base64");
process.env.ACCESS_CODE_PEPPER = crypto.randomBytes(24).toString("base64url");
process.env.ADMIN_API_KEY = crypto.randomBytes(24).toString("base64url");

try {
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE reports (
      id TEXT PRIMARY KEY,
      anonymous_id TEXT NOT NULL,
      access_hash TEXT NOT NULL,
      check_type TEXT NOT NULL,
      report_status TEXT NOT NULL,
      input_version TEXT NOT NULL,
      report_version TEXT NOT NULL,
      consent_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      contact_channel TEXT NOT NULL,
      contact_cipher TEXT,
      payload_cipher TEXT NOT NULL,
      followup_status TEXT NOT NULL DEFAULT 'new'
    );
    INSERT INTO reports (
      id, anonymous_id, access_hash, check_type, report_status, input_version, report_version,
      consent_at, created_at, updated_at, expires_at, contact_channel, payload_cipher
    ) VALUES (
      'legacy-report', 'legacy-anonymous', 'legacy-access', 'cashflow', 'green',
      'cashflow-input-v2', 'cashflow-report-v2', '2026-07-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
      '2027-07-01T00:00:00.000Z', 'none', 'legacy-cipher'
    );
    CREATE TABLE line_report_bindings (
      id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL UNIQUE,
      code_hash TEXT NOT NULL UNIQUE,
      line_user_hash TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      bound_at TEXT
    );
    INSERT INTO line_report_bindings (
      id, report_id, code_hash, line_user_hash, created_at, expires_at, bound_at
    ) VALUES (
      'legacy-binding', 'legacy-report', 'legacy-code', 'legacy-user-hash',
      '2026-07-01T00:00:00.000Z', '2026-07-01T01:00:00.000Z', '2026-07-01T00:30:00.000Z'
    );
    CREATE TABLE line_ledger_entries (
      id TEXT PRIMARY KEY,
      line_user_hash TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL,
      category TEXT,
      ticker TEXT,
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      note_cipher TEXT,
      source_cipher TEXT,
      source_message_id TEXT
    );
    INSERT INTO line_ledger_entries (
      id, line_user_hash, entry_type, amount, currency, category, ticker, occurred_at, created_at
    ) VALUES (
      'legacy-entry', 'legacy-user-hash', 'investment', 10000, 'TWD', 'ETF', '0056',
      '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
    );
  `);
  legacy.close();

  const { createStore } = require("../customer-store");
  const store = createStore();
  store.close();

  const migrated = new DatabaseSync(dbPath);
  const columns = migrated.prepare("PRAGMA table_info(line_ledger_entries)").all().map((row) => row.name);
  const entry = migrated.prepare("SELECT updated_at FROM line_ledger_entries WHERE id = 'legacy-entry'").get();
  const holding = migrated.prepare("SELECT amount, user_id FROM line_holdings WHERE line_user_hash = 'legacy-user-hash' AND ticker = '0056'").get();
  const user = migrated.prepare("SELECT id, onboarding_completed_at FROM users WHERE line_user_hash = 'legacy-user-hash'").get();
  const report = migrated.prepare("SELECT user_id FROM reports WHERE id = 'legacy-report'").get();
  const ledger = migrated.prepare("SELECT user_id FROM line_ledger_entries WHERE id = 'legacy-entry'").get();
  const marker = migrated.prepare("SELECT 1 AS present FROM schema_migrations WHERE migration_key = 'line-holdings-from-ledger-v1'").get();
  const memberMarker = migrated.prepare("SELECT 1 AS present FROM schema_migrations WHERE migration_key = 'member-identity-backfill-v1'").get();
  migrated.close();
  if (
    !columns.includes("updated_at")
    || !columns.includes("user_id")
    || !entry?.updated_at
    || Number(holding?.amount) !== 10000
    || !user?.onboarding_completed_at
    || report?.user_id !== user.id
    || ledger?.user_id !== user.id
    || holding?.user_id !== user.id
    || !marker?.present
    || !memberMarker?.present
  ) {
    throw new Error("LINE legacy schema migration failed");
  }
  console.log(JSON.stringify({
    passed: true,
    updatedAtBackfilled: true,
    holdingsBackfilled: true,
    memberCreated: true,
    reportLedgerHoldingAssigned: true,
    onboardingPreserved: true
  }));
} finally {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    if (error.code !== "EPERM") throw error;
  }
}
