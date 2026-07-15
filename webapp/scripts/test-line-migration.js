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
  const holding = migrated.prepare("SELECT amount FROM line_holdings WHERE line_user_hash = 'legacy-user-hash' AND ticker = '0056'").get();
  const marker = migrated.prepare("SELECT 1 AS present FROM schema_migrations WHERE migration_key = 'line-holdings-from-ledger-v1'").get();
  migrated.close();
  if (!columns.includes("updated_at") || !entry?.updated_at || Number(holding?.amount) !== 10000 || !marker?.present) {
    throw new Error("LINE legacy schema migration failed");
  }
  console.log(JSON.stringify({ passed: true, updatedAtBackfilled: true, holdingsBackfilled: true }));
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
