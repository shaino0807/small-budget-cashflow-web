const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const inputVersion = "cashflow-input-v2";
const reportVersion = "cashflow-report-v2";
const dataDir = path.resolve(process.env.CUSTOMER_DATA_DIR || path.join(__dirname, "private-data"));
const dbPath = path.join(dataDir, "customers.sqlite");
const retentionDays = Math.max(1, Math.min(3650, Number(process.env.CUSTOMER_RETENTION_DAYS || 365)));
const lineLedgerRetentionDays = Math.max(30, Math.min(3650, Number(process.env.LINE_LEDGER_RETENTION_DAYS || 1095)));
const authSessionDays = Math.max(1, Math.min(90, Number(process.env.AUTH_SESSION_DAYS || 30)));

function requiredSecret(name, minimumLength = 32) {
  const value = String(process.env[name] || "");
  if (value.length < minimumLength) throw new Error(`${name} 尚未設定或長度不足`);
  return value;
}

function encryptionKey() {
  const raw = requiredSecret("CUSTOMER_DATA_KEY", 32);
  const decoded = Buffer.from(raw, "base64");
  return decoded.length === 32 ? decoded : crypto.createHash("sha256").update(raw).digest();
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, body]).toString("base64");
}

function decrypt(value) {
  const packed = Buffer.from(value, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), packed.subarray(0, 12));
  decipher.setAuthTag(packed.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString("utf8"));
}

function accessHash(value) {
  return crypto.createHmac("sha256", requiredSecret("ACCESS_CODE_PEPPER", 24)).update(String(value)).digest("hex");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function assertAdmin(value) {
  if (!safeEqual(value, requiredSecret("ADMIN_API_KEY", 24))) {
    const error = new Error("管理權限驗證失敗");
    error.statusCode = 401;
    throw error;
  }
}

function initialize() {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      line_user_hash TEXT NOT NULL UNIQUE,
      onboarding_completed_at TEXT,
      created_at TEXT NOT NULL,
      last_login_at TEXT
    );
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      user_id TEXT,
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
      followup_status TEXT NOT NULL DEFAULT 'new',
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_reports_created_at ON reports(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_reports_anonymous_id ON reports(anonymous_id);
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      anonymous_id TEXT NOT NULL,
      report_id TEXT,
      event_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      metadata_cipher TEXT,
      FOREIGN KEY(report_id) REFERENCES reports(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_events_type_created ON events(event_type, created_at DESC);
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL,
      product_type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL,
      provider TEXT NOT NULL,
      status_token_hash TEXT,
      provider_trade_no TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      paid_at TEXT,
      failed_at TEXT,
      failure_reason TEXT,
      FOREIGN KEY(report_id) REFERENCES reports(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_orders_report_id ON orders(report_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at DESC);
    CREATE TABLE IF NOT EXISTS payment_events (
      id TEXT PRIMARY KEY,
      order_id TEXT,
      provider TEXT NOT NULL,
      event_type TEXT NOT NULL,
      valid_mac INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      raw_cipher TEXT NOT NULL,
      FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_payment_events_order_id ON payment_events(order_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS report_entitlements (
      report_id TEXT NOT NULL,
      entitlement TEXT NOT NULL,
      source_order_id TEXT NOT NULL,
      granted_at TEXT NOT NULL,
      PRIMARY KEY(report_id, entitlement),
      FOREIGN KEY(report_id) REFERENCES reports(id) ON DELETE CASCADE,
      FOREIGN KEY(source_order_id) REFERENCES orders(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS line_ledger_entries (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      line_user_hash TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL,
      category TEXT,
      ticker TEXT,
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      note_cipher TEXT,
      source_cipher TEXT,
      source_message_id TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_line_ledger_user_month ON line_ledger_entries(line_user_hash, occurred_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_line_ledger_source_message ON line_ledger_entries(line_user_hash, source_message_id)
      WHERE source_message_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS line_command_receipts (
      id TEXT PRIMARY KEY,
      line_user_hash TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      command_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      result_cipher TEXT NOT NULL,
      UNIQUE(line_user_hash, source_message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_line_command_receipts_created ON line_command_receipts(created_at DESC);
    CREATE TABLE IF NOT EXISTS line_profiles (
      line_user_hash TEXT PRIMARY KEY,
      user_id TEXT UNIQUE,
      monthly_income INTEGER NOT NULL DEFAULT 0,
      fixed_expense INTEGER NOT NULL DEFAULT 0,
      insurance_expense INTEGER NOT NULL DEFAULT 0,
      loan_expense INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS line_holdings (
      line_user_hash TEXT NOT NULL,
      user_id TEXT,
      ticker TEXT NOT NULL,
      amount INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(line_user_hash, ticker),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_line_holdings_user ON line_holdings(line_user_hash, amount DESC);
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_key TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS line_report_bindings (
      id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL UNIQUE,
      code_hash TEXT NOT NULL UNIQUE,
      line_user_hash TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      bound_at TEXT,
      FOREIGN KEY(report_id) REFERENCES reports(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_line_report_bindings_code ON line_report_bindings(code_hash);
    CREATE INDEX IF NOT EXISTS idx_line_report_bindings_user ON line_report_bindings(line_user_hash, bound_at DESC);
    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT,
      user_agent_hash TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id, expires_at DESC);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_expiry ON user_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS auth_challenges (
      state_hash TEXT PRIMARY KEY,
      payload_cipher TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_challenges_expiry ON auth_challenges(expires_at);
  `);
  const reportColumns = db.prepare("PRAGMA table_info(reports)").all().map((row) => row.name);
  if (!reportColumns.includes("user_id")) db.exec("ALTER TABLE reports ADD COLUMN user_id TEXT");
  const orderColumns = db.prepare("PRAGMA table_info(orders)").all().map((row) => row.name);
  if (!orderColumns.includes("status_token_hash")) {
    db.exec("ALTER TABLE orders ADD COLUMN status_token_hash TEXT");
  }
  const ledgerColumns = db.prepare("PRAGMA table_info(line_ledger_entries)").all().map((row) => row.name);
  if (!ledgerColumns.includes("updated_at")) {
    db.exec("ALTER TABLE line_ledger_entries ADD COLUMN updated_at TEXT");
    db.prepare("UPDATE line_ledger_entries SET updated_at = created_at WHERE updated_at IS NULL").run();
  }
  if (!ledgerColumns.includes("user_id")) db.exec("ALTER TABLE line_ledger_entries ADD COLUMN user_id TEXT");
  const profileColumns = db.prepare("PRAGMA table_info(line_profiles)").all().map((row) => row.name);
  if (!profileColumns.includes("user_id")) db.exec("ALTER TABLE line_profiles ADD COLUMN user_id TEXT");
  const holdingColumns = db.prepare("PRAGMA table_info(line_holdings)").all().map((row) => row.name);
  if (!holdingColumns.includes("user_id")) db.exec("ALTER TABLE line_holdings ADD COLUMN user_id TEXT");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_reports_user_id ON reports(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_line_ledger_user_id ON line_ledger_entries(user_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_line_holdings_user_id ON line_holdings(user_id, amount DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_line_profiles_user_id ON line_profiles(user_id) WHERE user_id IS NOT NULL;
  `);
  const holdingsMigration = db.prepare("SELECT 1 FROM schema_migrations WHERE migration_key = ?")
    .get("line-holdings-from-ledger-v1");
  if (!holdingsMigration) {
    db.exec(`
      INSERT INTO line_holdings (line_user_hash, ticker, amount, updated_at)
      SELECT line_user_hash, ticker, SUM(amount), MAX(COALESCE(updated_at, created_at))
      FROM line_ledger_entries
      WHERE entry_type = 'investment' AND ticker IS NOT NULL AND ticker <> ''
      GROUP BY line_user_hash, ticker
      ON CONFLICT(line_user_hash, ticker) DO NOTHING;
    `);
    db.prepare("INSERT INTO schema_migrations (migration_key, applied_at) VALUES (?, ?)")
      .run("line-holdings-from-ledger-v1", new Date().toISOString());
  }
  const memberMigration = db.prepare("SELECT 1 FROM schema_migrations WHERE migration_key = ?")
    .get("member-identity-backfill-v1");
  if (!memberMigration) {
    const hashes = db.prepare(`
      SELECT line_user_hash FROM line_ledger_entries
      UNION SELECT line_user_hash FROM line_profiles
      UNION SELECT line_user_hash FROM line_holdings
      UNION SELECT line_user_hash FROM line_report_bindings WHERE line_user_hash IS NOT NULL
    `).all().map((row) => row.line_user_hash).filter(Boolean);
    const insertUser = db.prepare(`
      INSERT OR IGNORE INTO users (id, line_user_hash, onboarding_completed_at, created_at, last_login_at)
      VALUES (?, ?, ?, ?, NULL)
    `);
    for (const lineUserHash of hashes) {
      const binding = db.prepare(`
        SELECT binding.report_id AS reportId, binding.bound_at AS boundAt, report.created_at AS reportCreatedAt
        FROM line_report_bindings binding
        JOIN reports report ON report.id = binding.report_id
        WHERE binding.line_user_hash = ? AND binding.bound_at IS NOT NULL
        ORDER BY binding.bound_at DESC LIMIT 1
      `).get(lineUserHash);
      const now = new Date().toISOString();
      insertUser.run(crypto.randomUUID(), lineUserHash, binding?.boundAt || null, binding?.reportCreatedAt || now);
      const user = db.prepare("SELECT id, onboarding_completed_at FROM users WHERE line_user_hash = ?").get(lineUserHash);
      if (binding?.boundAt && !user.onboarding_completed_at) {
        db.prepare("UPDATE users SET onboarding_completed_at = ? WHERE id = ?").run(binding.boundAt, user.id);
      }
      db.prepare("UPDATE line_ledger_entries SET user_id = ? WHERE line_user_hash = ? AND user_id IS NULL").run(user.id, lineUserHash);
      db.prepare("UPDATE line_profiles SET user_id = ? WHERE line_user_hash = ? AND user_id IS NULL").run(user.id, lineUserHash);
      db.prepare("UPDATE line_holdings SET user_id = ? WHERE line_user_hash = ? AND user_id IS NULL").run(user.id, lineUserHash);
      db.prepare(`
        UPDATE reports SET user_id = ?
        WHERE user_id IS NULL AND id IN (
          SELECT report_id FROM line_report_bindings WHERE line_user_hash = ? AND bound_at IS NOT NULL
        )
      `).run(user.id, lineUserHash);
    }
    db.prepare("INSERT INTO schema_migrations (migration_key, applied_at) VALUES (?, ?)")
      .run("member-identity-backfill-v1", new Date().toISOString());
  }
  return db;
}

function finiteMoney(value, field, allowZero = true) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || (!allowZero && number === 0) || number > 1000000000) {
    throw new Error(`${field} 格式不正確`);
  }
  return number;
}

function validateSubmission(body) {
  if (!body || typeof body !== "object") throw new Error("缺少報告資料");
  if (!["cashflow", "stock"].includes(body.checkType)) throw new Error("健檢類型不正確");
  if (body.consent?.accepted !== true) throw new Error("尚未同意保存健檢資料");
  const consentAt = new Date(body.consent.acceptedAt);
  if (!Number.isFinite(consentAt.getTime())) throw new Error("同意時間不正確");
  const profile = body.input?.profile || {};
  if (body.checkType === "cashflow") {
    finiteMoney(profile.monthlyIncome, "月收入", false);
    finiteMoney(profile.fixedExpense, "固定支出");
    finiteMoney(profile.cashSavings, "現金存款");
  } else {
    finiteMoney(body.input?.leadProfile?.stockMonthlyBudget, "股票投入金額", false);
    for (const key of ["stockReason", "stockDrop", "stockCount", "stockHorizon"]) {
      if (!String(body.input?.leadProfile?.[key] || "").trim()) throw new Error(`缺少 ${key}`);
    }
  }
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized, "utf8") > 512000) throw new Error("報告資料超過大小限制");
  return body;
}

function taipeiMonthKey(date = new Date()) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

function taipeiMonthRange(monthKey = taipeiMonthKey()) {
  const normalized = String(monthKey || "").match(/^\d{4}-\d{2}$/) ? monthKey : taipeiMonthKey();
  const [year, month] = normalized.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1) - 8 * 60 * 60 * 1000);
  const end = new Date(Date.UTC(year, month, 1) - 8 * 60 * 60 * 1000);
  return { monthKey: normalized, start: start.toISOString(), end: end.toISOString() };
}

function publicReport(row, entitlements = []) {
  const payload = decrypt(row.payload_cipher);
  return {
    id: row.id,
    anonymousId: row.anonymous_id,
    checkType: row.check_type,
    status: row.report_status,
    inputVersion: row.input_version,
    reportVersion: row.report_version,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    entitlements,
    payload
  };
}

function createStore() {
  const db = initialize();
  const insertReport = db.prepare(`
    INSERT INTO reports (
      id, user_id, anonymous_id, access_hash, check_type, report_status, input_version, report_version,
      consent_at, created_at, updated_at, expires_at, contact_channel, contact_cipher, payload_cipher
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEvent = db.prepare(`
    INSERT INTO events (id, anonymous_id, report_id, event_type, created_at, metadata_cipher)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertOrder = db.prepare(`
    INSERT INTO orders (
      id, report_id, product_type, amount, currency, provider, status_token_hash, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPaymentEvent = db.prepare(`
    INSERT INTO payment_events (id, order_id, provider, event_type, valid_mac, created_at, raw_cipher)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertLineLedgerEntry = db.prepare(`
    INSERT INTO line_ledger_entries (
      id, user_id, line_user_hash, entry_type, amount, currency, category, ticker,
      occurred_at, created_at, updated_at, note_cipher, source_cipher, source_message_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  function publicLineEntry(row) {
    if (!row) return null;
    const note = row.note_cipher ? decrypt(row.note_cipher)?.value : "";
    return {
      id: row.id,
      type: row.entry_type,
      amount: Number(row.amount || 0),
      category: row.category,
      ticker: row.ticker,
      note: String(note || ""),
      occurredAt: row.occurred_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at || row.created_at
    };
  }

  function lineProfileByHash(lineUserHash) {
    const row = db.prepare("SELECT * FROM line_profiles WHERE line_user_hash = ?").get(lineUserHash);
    return {
      monthlyIncome: Number(row?.monthly_income || 0),
      fixedExpense: Number(row?.fixed_expense || 0),
      insuranceExpense: Number(row?.insurance_expense || 0),
      loanExpense: Number(row?.loan_expense || 0),
      updatedAt: row?.updated_at || null
    };
  }

  function lineHoldingsByHash(lineUserHash) {
    return db.prepare(`
      SELECT ticker, amount, updated_at AS updatedAt
      FROM line_holdings
      WHERE line_user_hash = ? AND amount > 0
      ORDER BY amount DESC, ticker ASC
    `).all(lineUserHash).map((row) => ({ ...row, amount: Number(row.amount || 0) }));
  }

  function userIdByLineHash(lineUserHash) {
    return db.prepare("SELECT id FROM users WHERE line_user_hash = ?").get(lineUserHash)?.id || null;
  }

  function adjustLineHolding(lineUserHash, ticker, delta, now = new Date().toISOString()) {
    const normalizedTicker = String(ticker || "").trim().toUpperCase().slice(0, 12);
    if (!normalizedTicker || !Number(delta)) return;
    db.prepare(`
      INSERT INTO line_holdings (line_user_hash, user_id, ticker, amount, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(line_user_hash, ticker) DO UPDATE SET
        user_id = COALESCE(line_holdings.user_id, excluded.user_id),
        amount = MAX(0, line_holdings.amount + excluded.amount),
        updated_at = excluded.updated_at
    `).run(lineUserHash, userIdByLineHash(lineUserHash), normalizedTicker, Math.round(Number(delta)), now);
    db.prepare("DELETE FROM line_holdings WHERE line_user_hash = ? AND ticker = ? AND amount <= 0")
      .run(lineUserHash, normalizedTicker);
  }

  function lineEntriesByHash(lineUserHash, monthKey = taipeiMonthKey(), limit = 8) {
    const range = taipeiMonthRange(monthKey);
    return db.prepare(`
      SELECT * FROM line_ledger_entries
      WHERE line_user_hash = ? AND occurred_at >= ? AND occurred_at < ?
      ORDER BY occurred_at DESC, created_at DESC
      LIMIT ?
    `).all(lineUserHash, range.start, range.end, Math.max(1, Math.min(20, Number(limit) || 8))).map(publicLineEntry);
  }

  function runLineCommandOnce({ lineUserHash, sourceMessageId, commandType, action }) {
    const messageId = String(sourceMessageId || "").slice(0, 80);
    if (!messageId) return action();
    const existing = db.prepare(`
      SELECT result_cipher FROM line_command_receipts
      WHERE line_user_hash = ? AND source_message_id = ?
    `).get(lineUserHash, messageId);
    if (existing) return { ...decrypt(existing.result_cipher), duplicate: true };

    db.exec("BEGIN IMMEDIATE");
    try {
      const repeated = db.prepare(`
        SELECT result_cipher FROM line_command_receipts
        WHERE line_user_hash = ? AND source_message_id = ?
      `).get(lineUserHash, messageId);
      if (repeated) {
        db.exec("COMMIT");
        return { ...decrypt(repeated.result_cipher), duplicate: true };
      }
      const result = action();
      db.prepare(`
        INSERT INTO line_command_receipts (id, line_user_hash, source_message_id, command_type, created_at, result_cipher)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(crypto.randomUUID(), lineUserHash, messageId, commandType, new Date().toISOString(), encrypt(result));
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function lineSummaryByHash(lineUserHash, monthKey = taipeiMonthKey()) {
    const range = taipeiMonthRange(monthKey);
    const rows = db.prepare(`
      SELECT entry_type AS type, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
      FROM line_ledger_entries
      WHERE line_user_hash = ? AND occurred_at >= ? AND occurred_at < ?
      GROUP BY entry_type
    `).all(lineUserHash, range.start, range.end);
    const summary = {
      month: range.monthKey,
      income: 0,
      expense: 0,
      investment: 0,
      counts: { income: 0, expense: 0, investment: 0 }
    };
    rows.forEach((row) => {
      if (row.type === "income") summary.income = Number(row.total || 0);
      if (row.type === "expense") summary.expense = Number(row.total || 0);
      if (row.type === "investment") summary.investment = Number(row.total || 0);
      if (summary.counts[row.type] !== undefined) summary.counts[row.type] = Number(row.count || 0);
    });
    summary.expenseCategories = db.prepare(`
      SELECT COALESCE(category, '其他支出') AS category, COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS count
      FROM line_ledger_entries
      WHERE line_user_hash = ? AND entry_type = 'expense' AND occurred_at >= ? AND occurred_at < ?
      GROUP BY COALESCE(category, '其他支出')
      ORDER BY amount DESC, category ASC
    `).all(lineUserHash, range.start, range.end).map((row) => ({
      category: row.category,
      amount: Number(row.amount || 0),
      count: Number(row.count || 0)
    }));
    const investmentCounts = db.prepare(`
      SELECT ticker, COUNT(*) AS count, MAX(occurred_at) AS lastOccurredAt
      FROM line_ledger_entries
      WHERE line_user_hash = ? AND entry_type = 'investment' AND ticker IS NOT NULL AND ticker <> ''
      GROUP BY ticker
    `).all(lineUserHash);
    const countByTicker = new Map(investmentCounts.map((row) => [row.ticker, row]));
    summary.etfPositions = lineHoldingsByHash(lineUserHash).map((holding) => ({
      ticker: holding.ticker,
      amount: holding.amount,
      count: Number(countByTicker.get(holding.ticker)?.count || 0),
      lastOccurredAt: countByTicker.get(holding.ticker)?.lastOccurredAt || holding.updatedAt
    }));
    summary.profile = lineProfileByHash(lineUserHash);
    summary.holdings = summary.etfPositions.map((position) => ({ ticker: position.ticker, amount: position.amount }));
    summary.recentEntries = lineEntriesByHash(lineUserHash, range.monthKey, 8);
    summary.remaining = summary.income - summary.expense - summary.investment;
    return summary;
  }

  function listEntitlements(reportId) {
    return db.prepare("SELECT entitlement FROM report_entitlements WHERE report_id = ? ORDER BY granted_at")
      .all(reportId)
      .map((row) => row.entitlement);
  }

  function assertReportAccess(reportId, code) {
    const row = db.prepare("SELECT * FROM reports WHERE id = ?").get(reportId);
    if (!row || !safeEqual(row.access_hash, accessHash(code)) || new Date(row.expires_at) < new Date()) {
      const error = new Error("找不到報告或存取碼不正確");
      error.statusCode = 404;
      throw error;
    }
    return row;
  }

  function assertUserReport(reportId, userId) {
    const row = db.prepare("SELECT * FROM reports WHERE id = ? AND user_id = ?").get(reportId, userId);
    if (!row || new Date(row.expires_at) < new Date()) {
      const error = new Error("找不到這個會員的報告");
      error.statusCode = 404;
      throw error;
    }
    return row;
  }

  function publicUser(row) {
    if (!row) return null;
    return {
      id: row.id,
      onboardingCompleted: Boolean(row.onboarding_completed_at),
      onboardingCompletedAt: row.onboarding_completed_at || null,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at || null
    };
  }

  function linkExistingLineData(userId, lineUserHash) {
    db.prepare("UPDATE line_ledger_entries SET user_id = ? WHERE line_user_hash = ? AND user_id IS NULL").run(userId, lineUserHash);
    db.prepare("UPDATE line_profiles SET user_id = ? WHERE line_user_hash = ? AND user_id IS NULL").run(userId, lineUserHash);
    db.prepare("UPDATE line_holdings SET user_id = ? WHERE line_user_hash = ? AND user_id IS NULL").run(userId, lineUserHash);
    db.prepare(`
      UPDATE reports SET user_id = ?
      WHERE user_id IS NULL AND id IN (
        SELECT report_id FROM line_report_bindings WHERE line_user_hash = ? AND bound_at IS NOT NULL
      )
    `).run(userId, lineUserHash);
    const boundAt = db.prepare(`
      SELECT MAX(bound_at) AS boundAt FROM line_report_bindings
      WHERE line_user_hash = ? AND bound_at IS NOT NULL
    `).get(lineUserHash)?.boundAt;
    if (boundAt) {
      db.prepare(`
        UPDATE users SET onboarding_completed_at = COALESCE(onboarding_completed_at, ?)
        WHERE id = ?
      `).run(boundAt, userId);
    }
  }

  function findOrCreateUserByLineId(lineUserId) {
    const lineUserHash = accessHash(`line:${lineUserId}`);
    const now = new Date().toISOString();
    let row = db.prepare("SELECT * FROM users WHERE line_user_hash = ?").get(lineUserHash);
    if (!row) {
      const id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO users (id, line_user_hash, onboarding_completed_at, created_at, last_login_at)
        VALUES (?, ?, NULL, ?, ?)
      `).run(id, lineUserHash, now, now);
      row = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    } else {
      db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now, row.id);
    }
    linkExistingLineData(row.id, lineUserHash);
    return publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(row.id));
  }

  function createAuthChallenge({ state, nonce, codeVerifier, returnTo = "inputView" }) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 10 * 60000).toISOString();
    db.prepare(`
      INSERT INTO auth_challenges (state_hash, payload_cipher, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(
      accessHash(`oauth-state:${state}`),
      encrypt({ nonce, codeVerifier, returnTo: String(returnTo || "inputView").slice(0, 80) }),
      now.toISOString(),
      expiresAt
    );
    return { expiresAt };
  }

  function consumeAuthChallenge(state) {
    const stateHash = accessHash(`oauth-state:${state}`);
    const row = db.prepare("SELECT * FROM auth_challenges WHERE state_hash = ?").get(stateHash);
    db.prepare("DELETE FROM auth_challenges WHERE state_hash = ?").run(stateHash);
    if (!row || new Date(row.expires_at) <= new Date()) {
      const error = new Error("LINE Login 驗證已過期，請重新登入");
      error.statusCode = 401;
      throw error;
    }
    return decrypt(row.payload_cipher);
  }

  function createUserSession(userId, userAgent = "") {
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
    if (!user) {
      const error = new Error("找不到會員");
      error.statusCode = 404;
      throw error;
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + authSessionDays * 86400000);
    db.prepare(`
      INSERT INTO user_sessions (
        id, user_id, token_hash, created_at, expires_at, last_seen_at, revoked_at, user_agent_hash
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(
      crypto.randomUUID(),
      userId,
      accessHash(`session:${token}`),
      now.toISOString(),
      expiresAt.toISOString(),
      now.toISOString(),
      userAgent ? crypto.createHash("sha256").update(String(userAgent).slice(0, 500)).digest("hex") : null
    );
    return { token, expiresAt: expiresAt.toISOString(), maxAgeSeconds: authSessionDays * 86400 };
  }

  function authenticatedUser(token, { touch = true } = {}) {
    if (String(token || "").length < 32) return null;
    const row = db.prepare(`
      SELECT session.id AS session_id, session.expires_at AS session_expires_at,
        session.last_seen_at AS session_last_seen_at, user.*
      FROM user_sessions session
      JOIN users user ON user.id = session.user_id
      WHERE session.token_hash = ? AND session.revoked_at IS NULL AND session.expires_at > ?
    `).get(accessHash(`session:${token}`), new Date().toISOString());
    if (!row) return null;
    if (touch) {
      const now = new Date();
      const lastSeen = new Date(row.session_last_seen_at).getTime();
      if (!Number.isFinite(lastSeen) || now.getTime() - lastSeen > 15 * 60000) {
        const expiresAt = new Date(now.getTime() + authSessionDays * 86400000).toISOString();
        db.prepare("UPDATE user_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?")
          .run(now.toISOString(), expiresAt, row.session_id);
        row.session_expires_at = expiresAt;
      }
    }
    return {
      sessionId: row.session_id,
      sessionExpiresAt: row.session_expires_at,
      user: publicUser(row)
    };
  }

  function revokeUserSession(sessionId, userId) {
    return db.prepare(`
      UPDATE user_sessions SET revoked_at = ?
      WHERE id = ? AND user_id = ? AND revoked_at IS NULL
    `).run(new Date().toISOString(), sessionId, userId).changes > 0;
  }

  function revokeAllUserSessions(userId) {
    return db.prepare(`
      UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL
    `).run(new Date().toISOString(), userId).changes;
  }

  function memberLineUserHash(userId) {
    const row = db.prepare("SELECT line_user_hash FROM users WHERE id = ?").get(userId);
    if (!row) {
      const error = new Error("登入已失效");
      error.statusCode = 401;
      throw error;
    }
    return row.line_user_hash;
  }

  function latestReportForUser(userId) {
    const row = db.prepare(`
      SELECT * FROM reports WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1
    `).get(userId, new Date().toISOString());
    return row ? publicReport(row, listEntitlements(row.id)) : null;
  }

  function userBootstrap(userId, monthKey = taipeiMonthKey()) {
    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
    if (!row) return null;
    const lineUserHash = row.line_user_hash;
    return {
      user: publicUser(row),
      report: latestReportForUser(userId),
      cashflow: {
        linked: true,
        linkedAt: row.created_at,
        ...lineSummaryByHash(lineUserHash, monthKey),
        entries: lineEntriesByHash(lineUserHash, monthKey, 20)
      }
    };
  }

  function completeUserOnboarding(userId, reportId) {
    const report = db.prepare("SELECT id FROM reports WHERE id = ? AND user_id = ?").get(reportId, userId);
    if (!report) {
      const error = new Error("找不到這個會員的健檢報告");
      error.statusCode = 404;
      throw error;
    }
    const completedAt = new Date().toISOString();
    db.prepare("UPDATE users SET onboarding_completed_at = ? WHERE id = ?").run(completedAt, userId);
    return publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(userId));
  }

  function lineCashflowForUser(userId, monthKey = taipeiMonthKey(), limit = 20) {
    const user = db.prepare("SELECT created_at, line_user_hash FROM users WHERE id = ?").get(userId);
    if (!user) return null;
    return {
      linked: true,
      linkedAt: user.created_at,
      ...lineSummaryByHash(user.line_user_hash, monthKey),
      entries: lineEntriesByHash(user.line_user_hash, monthKey, limit)
    };
  }

  function deleteUserAccount(userId) {
    const row = db.prepare("SELECT line_user_hash FROM users WHERE id = ?").get(userId);
    if (!row) return false;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM reports WHERE user_id = ?").run(userId);
      db.prepare("DELETE FROM line_ledger_entries WHERE line_user_hash = ?").run(row.line_user_hash);
      db.prepare("DELETE FROM line_holdings WHERE line_user_hash = ?").run(row.line_user_hash);
      db.prepare("DELETE FROM line_profiles WHERE line_user_hash = ?").run(row.line_user_hash);
      db.prepare("DELETE FROM line_command_receipts WHERE line_user_hash = ?").run(row.line_user_hash);
      db.prepare("DELETE FROM line_report_bindings WHERE line_user_hash = ?").run(row.line_user_hash);
      db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(userId);
      db.prepare("DELETE FROM users WHERE id = ?").run(userId);
      db.exec("COMMIT");
      return true;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function publicOrder(row) {
    if (!row) return null;
    return {
      id: row.id,
      reportId: row.report_id,
      productType: row.product_type,
      amount: row.amount,
      currency: row.currency,
      provider: row.provider,
      status: row.status,
      providerTradeNo: row.provider_trade_no,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      paidAt: row.paid_at,
      failedAt: row.failed_at,
      failureReason: row.failure_reason,
      entitlements: listEntitlements(row.report_id)
    };
  }

  function addEvent({ anonymousId, reportId = null, eventType, metadata = {} }) {
    const allowedEvents = [
      "page_opened",
      "quiz_started",
      "report_generated",
      "report_reopened",
      "cta_clicked",
      "line_binding_code_created",
      "line_report_bound",
      "payment_checkout_started",
      "payment_paid",
      "payment_failed"
    ];
    if (!allowedEvents.includes(eventType)) throw new Error("事件類型不正確");
    insertEvent.run(
      crypto.randomUUID(),
      String(anonymousId || "anonymous").slice(0, 80),
      reportId,
      String(eventType).slice(0, 60),
      new Date().toISOString(),
      encrypt(metadata)
    );
  }

  function createReport(body, { userId = null } = {}) {
    purgeExpired();
    validateSubmission(body);
    const now = new Date();
    const expires = new Date(now.getTime() + retentionDays * 86400000);
    const id = crypto.randomUUID();
    const accessCode = crypto.randomBytes(9).toString("base64url");
    const anonymousId = String(body.anonymousId || crypto.randomUUID()).slice(0, 80);
    const channel = ["none", "line", "form", "email"].includes(body.contact?.channel) ? body.contact.channel : "none";
    const contact = String(body.contact?.value || "").trim().slice(0, 200);
    const status = String(body.report?.stockSafety?.level || body.report?.status || "generated").slice(0, 40);
    insertReport.run(
      id,
      userId,
      anonymousId,
      accessHash(accessCode),
      body.checkType,
      status,
      inputVersion,
      reportVersion,
      body.consent.acceptedAt,
      now.toISOString(),
      now.toISOString(),
      expires.toISOString(),
      channel,
      contact ? encrypt({ value: contact }) : null,
      encrypt(body)
    );
    addEvent({ anonymousId, reportId: id, eventType: "report_generated", metadata: { checkType: body.checkType, channel } });
    return { id, accessCode, anonymousId, createdAt: now.toISOString(), expiresAt: expires.toISOString(), inputVersion, reportVersion, entitlements: [] };
  }

  function getReport(id, code) {
    const row = db.prepare("SELECT * FROM reports WHERE id = ?").get(id);
    if (!row || !safeEqual(row.access_hash, accessHash(code))) return null;
    if (new Date(row.expires_at) < new Date()) return null;
    addEvent({ anonymousId: row.anonymous_id, reportId: id, eventType: "report_reopened" });
    return publicReport(row, listEntitlements(id));
  }

  function getReportForUser(id, userId) {
    const row = db.prepare("SELECT * FROM reports WHERE id = ? AND user_id = ?").get(id, userId);
    if (!row || new Date(row.expires_at) < new Date()) return null;
    addEvent({ anonymousId: row.anonymous_id, reportId: id, eventType: "report_reopened" });
    return publicReport(row, listEntitlements(id));
  }

  function deleteReport(id, code) {
    const row = db.prepare("SELECT anonymous_id, access_hash FROM reports WHERE id = ?").get(id);
    if (!row || !safeEqual(row.access_hash, accessHash(code))) return false;
    db.prepare("DELETE FROM reports WHERE id = ?").run(id);
    return true;
  }

  function deleteReportForUser(id, userId) {
    return db.prepare("DELETE FROM reports WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
  }

  function listReports(adminKey, limit = 100) {
    assertAdmin(adminKey);
    purgeExpired();
    return db.prepare(`
      SELECT id, anonymous_id AS anonymousId, check_type AS checkType, report_status AS status,
        consent_at AS consentAt, created_at AS createdAt, expires_at AS expiresAt,
        contact_channel AS contactChannel, followup_status AS followupStatus
      FROM reports ORDER BY created_at DESC LIMIT ?
    `).all(Math.max(1, Math.min(500, Number(limit) || 100)));
  }

  function getAdminReport(adminKey, id) {
    assertAdmin(adminKey);
    const row = db.prepare("SELECT * FROM reports WHERE id = ?").get(id);
    if (!row) return null;
    return {
      ...publicReport(row, listEntitlements(id)),
      contact: row.contact_cipher ? decrypt(row.contact_cipher) : null,
      followupStatus: row.followup_status
    };
  }

  function setFollowupStatus(adminKey, id, status) {
    assertAdmin(adminKey);
    const allowed = ["new", "contacted", "converted", "closed"];
    if (!allowed.includes(status)) throw new Error("追蹤狀態不正確");
    return db.prepare("UPDATE reports SET followup_status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), id).changes > 0;
  }

  function analytics(adminKey) {
    assertAdmin(adminKey);
    const eventCounts = db.prepare("SELECT event_type AS eventType, COUNT(*) AS count FROM events GROUP BY event_type").all();
    const reportCounts = db.prepare("SELECT check_type AS checkType, COUNT(*) AS count FROM reports GROUP BY check_type").all();
    const conversions = db.prepare("SELECT followup_status AS status, COUNT(*) AS count FROM reports GROUP BY followup_status").all();
    return { eventCounts, reportCounts, conversions };
  }

  function immediateTransaction(action) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function normalizeLineProfile(profile = {}, current = {}) {
    const result = { ...current };
    const fields = ["monthlyIncome", "fixedExpense", "insuranceExpense", "loanExpense"];
    fields.forEach((field) => {
      if (!Object.prototype.hasOwnProperty.call(profile, field)) return;
      const value = Math.round(Number(profile[field]));
      if (!Number.isFinite(value) || value < 0 || value > 1000000000) throw new Error(`${field} 金額格式不正確`);
      result[field] = value;
    });
    return result;
  }

  function updateLineProfileByHash(lineUserHash, profile = {}) {
    const merged = normalizeLineProfile(profile, lineProfileByHash(lineUserHash));
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO line_profiles (
        line_user_hash, user_id, monthly_income, fixed_expense, insurance_expense, loan_expense, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(line_user_hash) DO UPDATE SET
        user_id = COALESCE(line_profiles.user_id, excluded.user_id),
        monthly_income = excluded.monthly_income,
        fixed_expense = excluded.fixed_expense,
        insurance_expense = excluded.insurance_expense,
        loan_expense = excluded.loan_expense,
        updated_at = excluded.updated_at
    `).run(
      lineUserHash,
      userIdByLineHash(lineUserHash),
      merged.monthlyIncome,
      merged.fixedExpense,
      merged.insuranceExpense,
      merged.loanExpense,
      now
    );
    return { ...merged, updatedAt: now };
  }

  function replaceLineHoldingsByHash(lineUserHash, holdings = []) {
    if (!Array.isArray(holdings) || holdings.length > 100) throw new Error("ETF 部位格式不正確");
    const normalized = holdings.map((holding) => {
      const ticker = String(holding.ticker || "").trim().toUpperCase();
      const amount = Math.round(Number(holding.amount));
      if (!/^[A-Z0-9.-]{2,12}$/.test(ticker)) throw new Error("ETF 代碼格式不正確");
      if (!Number.isFinite(amount) || amount < 0 || amount > 1000000000) throw new Error(`${ticker} 部位金額格式不正確`);
      return { ticker, amount };
    });
    const merged = new Map();
    normalized.forEach(({ ticker, amount }) => merged.set(ticker, (merged.get(ticker) || 0) + amount));
    return immediateTransaction(() => {
      const now = new Date().toISOString();
      db.prepare("DELETE FROM line_holdings WHERE line_user_hash = ?").run(lineUserHash);
      const userId = userIdByLineHash(lineUserHash);
      const insert = db.prepare("INSERT INTO line_holdings (line_user_hash, user_id, ticker, amount, updated_at) VALUES (?, ?, ?, ?, ?)");
      for (const [ticker, amount] of merged.entries()) {
        if (amount > 0) insert.run(lineUserHash, userId, ticker, amount, now);
      }
      return lineHoldingsByHash(lineUserHash);
    });
  }

  function addLineLedgerEntryByHash({ lineUserHash, type, amount, category = null, ticker = null, note = "", source = {}, occurredAt = null, profilePatch = null }) {
    const allowedTypes = ["expense", "income", "investment"];
    if (!allowedTypes.includes(type)) throw new Error("記帳類型不正確");
    const numericAmount = Math.round(Number(amount));
    if (!Number.isFinite(numericAmount) || numericAmount <= 0 || numericAmount > 1000000000) throw new Error("金額格式不正確");
    const now = new Date();
    const occurred = occurredAt ? new Date(occurredAt) : now;
    if (!Number.isFinite(occurred.getTime())) throw new Error("日期格式不正確");
    const sourceMessageId = source.messageId ? String(source.messageId).slice(0, 80) : null;
    const id = crypto.randomUUID();
    try {
      return immediateTransaction(() => {
        const normalizedTicker = ticker ? String(ticker).toUpperCase().slice(0, 12) : null;
        insertLineLedgerEntry.run(
          id,
          userIdByLineHash(lineUserHash),
          lineUserHash,
          type,
          numericAmount,
          "TWD",
          category ? String(category).slice(0, 60) : null,
          normalizedTicker,
          occurred.toISOString(),
          now.toISOString(),
          now.toISOString(),
          note ? encrypt({ value: String(note).slice(0, 300) }) : null,
          encrypt(source),
          sourceMessageId
        );
        if (type === "investment" && normalizedTicker) adjustLineHolding(lineUserHash, normalizedTicker, numericAmount, now.toISOString());
        if (profilePatch && Object.keys(profilePatch).length) updateLineProfileByHash(lineUserHash, profilePatch);
        return { id, type, amount: numericAmount, category, ticker: normalizedTicker, occurredAt: occurred.toISOString() };
      });
    } catch (error) {
      if (String(error.message || "").includes("UNIQUE")) {
        const duplicate = new Error("這筆 LINE 訊息已經記錄過");
        duplicate.statusCode = 409;
        throw duplicate;
      }
      throw error;
    }
  }

  function addLineLedgerEntry({ lineUserId, ...entry }) {
    if (!lineUserId) throw new Error("缺少 LINE 使用者");
    return addLineLedgerEntryByHash({ lineUserHash: accessHash(`line:${lineUserId}`), ...entry });
  }

  function lineLedgerSummary(lineUserId, monthKey = taipeiMonthKey()) {
    if (!lineUserId) throw new Error("缺少 LINE 使用者");
    const lineUserHash = accessHash(`line:${lineUserId}`);
    return lineSummaryByHash(lineUserHash, monthKey);
  }

  function lineLedgerEntries(lineUserId, monthKey = taipeiMonthKey(), limit = 8) {
    if (!lineUserId) throw new Error("缺少 LINE 使用者");
    return lineEntriesByHash(accessHash(`line:${lineUserId}`), monthKey, limit);
  }

  function updateLineLedgerEntryByHash({ lineUserHash, entryId, patch = {} }) {
    const row = db.prepare("SELECT * FROM line_ledger_entries WHERE id = ? AND line_user_hash = ?").get(entryId, lineUserHash);
    if (!row) return null;
    const type = patch.type === undefined ? row.entry_type : String(patch.type);
    if (!["expense", "income", "investment"].includes(type)) throw new Error("記帳類型不正確");
    const amount = patch.amount === undefined ? Number(row.amount) : Math.round(Number(patch.amount));
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000000) throw new Error("金額格式不正確");
    const category = patch.category === undefined ? row.category : (patch.category ? String(patch.category).slice(0, 60) : null);
    const ticker = patch.ticker === undefined ? row.ticker : (patch.ticker ? String(patch.ticker).trim().toUpperCase().slice(0, 12) : null);
    const occurred = patch.occurredAt === undefined ? new Date(row.occurred_at) : new Date(patch.occurredAt);
    if (!Number.isFinite(occurred.getTime())) throw new Error("日期格式不正確");
    const noteCipher = patch.note === undefined
      ? row.note_cipher
      : (patch.note ? encrypt({ value: String(patch.note).slice(0, 300) }) : null);
    const now = new Date().toISOString();
    if (row.entry_type === "investment" && row.ticker) adjustLineHolding(lineUserHash, row.ticker, -Number(row.amount), now);
    if (type === "investment" && ticker) adjustLineHolding(lineUserHash, ticker, amount, now);
    db.prepare(`
      UPDATE line_ledger_entries
      SET entry_type = ?, amount = ?, category = ?, ticker = ?, occurred_at = ?, updated_at = ?, note_cipher = ?
      WHERE id = ? AND line_user_hash = ?
    `).run(type, amount, category, ticker, occurred.toISOString(), now, noteCipher, entryId, lineUserHash);
    return publicLineEntry(db.prepare("SELECT * FROM line_ledger_entries WHERE id = ?").get(entryId));
  }

  function deleteLineLedgerEntryByHash({ lineUserHash, entryId }) {
    const row = db.prepare("SELECT * FROM line_ledger_entries WHERE id = ? AND line_user_hash = ?").get(entryId, lineUserHash);
    if (!row) return null;
    if (row.entry_type === "investment" && row.ticker) adjustLineHolding(lineUserHash, row.ticker, -Number(row.amount));
    db.prepare("DELETE FROM line_ledger_entries WHERE id = ? AND line_user_hash = ?").run(entryId, lineUserHash);
    return publicLineEntry(row);
  }

  function indexedLineEntry(lineUserHash, index = 1, monthKey = taipeiMonthKey()) {
    const entries = lineEntriesByHash(lineUserHash, monthKey, 20);
    return entries[Math.max(0, Number(index || 1) - 1)] || null;
  }

  function updateIndexedLineLedgerEntry({ lineUserId, amount, index = 1, sourceMessageId }) {
    if (!lineUserId) throw new Error("缺少 LINE 使用者");
    const lineUserHash = accessHash(`line:${lineUserId}`);
    return runLineCommandOnce({
      lineUserHash,
      sourceMessageId,
      commandType: "update_indexed",
      action: () => {
        const entry = indexedLineEntry(lineUserHash, index);
        if (!entry) return { entry: null, index };
        return { entry: updateLineLedgerEntryByHash({ lineUserHash, entryId: entry.id, patch: { amount } }), index };
      }
    });
  }

  function deleteIndexedLineLedgerEntry({ lineUserId, index = 1, sourceMessageId }) {
    if (!lineUserId) throw new Error("缺少 LINE 使用者");
    const lineUserHash = accessHash(`line:${lineUserId}`);
    return runLineCommandOnce({
      lineUserHash,
      sourceMessageId,
      commandType: "delete_indexed",
      action: () => {
        const entry = indexedLineEntry(lineUserHash, index);
        if (!entry) return { entry: null, index };
        return { entry: deleteLineLedgerEntryByHash({ lineUserHash, entryId: entry.id }), index };
      }
    });
  }

  function updateLastLineLedgerEntry(options) {
    return updateIndexedLineLedgerEntry({ ...options, index: 1 });
  }

  function deleteLastLineLedgerEntry(options) {
    return deleteIndexedLineLedgerEntry({ ...options, index: 1 });
  }

  function createLineReportBinding({ reportId, accessCode }) {
    const report = assertReportAccess(reportId, accessCode);
    const now = new Date();
    const existing = db.prepare("SELECT * FROM line_report_bindings WHERE report_id = ?").get(reportId);
    if (existing?.bound_at) return { status: "linked", linkedAt: existing.bound_at };
    if (existing) db.prepare("DELETE FROM line_report_bindings WHERE report_id = ?").run(reportId);

    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
    let code = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
      const exists = db.prepare("SELECT 1 FROM line_report_bindings WHERE code_hash = ?").get(accessHash(`line-bind:${candidate}`));
      if (!exists) {
        code = candidate;
        break;
      }
    }
    if (!code) throw new Error("暫時無法產生 LINE 綁定碼，請稍後再試");
    db.prepare(`
      INSERT INTO line_report_bindings (id, report_id, code_hash, line_user_hash, created_at, expires_at, bound_at)
      VALUES (?, ?, ?, NULL, ?, ?, NULL)
    `).run(crypto.randomUUID(), reportId, accessHash(`line-bind:${code}`), now.toISOString(), expiresAt);
    addEvent({ anonymousId: report.anonymous_id, reportId, eventType: "line_binding_code_created" });
    return { status: "pending", code, expiresAt };
  }

  function bindLineReport({ lineUserId, code }) {
    if (!lineUserId) throw new Error("缺少 LINE 使用者");
    const normalizedCode = String(code || "").trim();
    if (!/^\d{6}$/.test(normalizedCode)) {
      const error = new Error("綁定碼格式不正確，請回到網頁重新取得 6 位數綁定碼");
      error.statusCode = 400;
      throw error;
    }
    const now = new Date().toISOString();
    const row = db.prepare(`
      SELECT binding.*, reports.anonymous_id
      FROM line_report_bindings binding
      JOIN reports ON reports.id = binding.report_id
      WHERE binding.code_hash = ? AND binding.bound_at IS NULL AND binding.expires_at > ? AND reports.expires_at > ?
    `).get(accessHash(`line-bind:${normalizedCode}`), now, now);
    if (!row) {
      const error = new Error("綁定碼無效或已過期，請回到網頁重新產生");
      error.statusCode = 404;
      throw error;
    }
    db.prepare(`
      UPDATE line_report_bindings
      SET line_user_hash = ?, bound_at = ?
      WHERE id = ? AND bound_at IS NULL
    `).run(accessHash(`line:${lineUserId}`), now, row.id);
    addEvent({ anonymousId: row.anonymous_id, reportId: row.report_id, eventType: "line_report_bound" });
    return { reportId: row.report_id, boundAt: now };
  }

  function getLineReportSummary({ reportId, accessCode, monthKey = taipeiMonthKey() }) {
    assertReportAccess(reportId, accessCode);
    const binding = db.prepare(`
      SELECT line_user_hash, bound_at
      FROM line_report_bindings
      WHERE report_id = ? AND bound_at IS NOT NULL
    `).get(reportId);
    if (!binding?.line_user_hash) return { linked: false, month: taipeiMonthRange(monthKey).monthKey };
    return { linked: true, linkedAt: binding.bound_at, ...lineSummaryByHash(binding.line_user_hash, monthKey) };
  }

  function boundLineUserHash(reportId, accessCode) {
    assertReportAccess(reportId, accessCode);
    const binding = db.prepare(`
      SELECT line_user_hash
      FROM line_report_bindings
      WHERE report_id = ? AND bound_at IS NOT NULL
    `).get(reportId);
    if (!binding?.line_user_hash) {
      const error = new Error("這份報告尚未綁定 LINE");
      error.statusCode = 409;
      throw error;
    }
    return binding.line_user_hash;
  }

  function lineCashflowForReport({ reportId, accessCode, monthKey = taipeiMonthKey(), limit = 20 }) {
    const summary = getLineReportSummary({ reportId, accessCode, monthKey });
    if (!summary.linked) return { ...summary, entries: [] };
    const lineUserHash = boundLineUserHash(reportId, accessCode);
    return {
      ...summary,
      ...lineSummaryByHash(lineUserHash, monthKey),
      entries: lineEntriesByHash(lineUserHash, monthKey, limit)
    };
  }

  function addLineLedgerEntryForReport({ reportId, accessCode, ...entry }) {
    const lineUserHash = boundLineUserHash(reportId, accessCode);
    return addLineLedgerEntryByHash({ lineUserHash, ...entry });
  }

  function updateLineLedgerEntryForReport({ reportId, accessCode, entryId, patch }) {
    const lineUserHash = boundLineUserHash(reportId, accessCode);
    return immediateTransaction(() => updateLineLedgerEntryByHash({ lineUserHash, entryId, patch }));
  }

  function deleteLineLedgerEntryForReport({ reportId, accessCode, entryId }) {
    const lineUserHash = boundLineUserHash(reportId, accessCode);
    return immediateTransaction(() => deleteLineLedgerEntryByHash({ lineUserHash, entryId }));
  }

  function updateLineProfileForReport({ reportId, accessCode, profile }) {
    return updateLineProfileByHash(boundLineUserHash(reportId, accessCode), profile);
  }

  function replaceLineHoldingsForReport({ reportId, accessCode, holdings }) {
    return replaceLineHoldingsByHash(boundLineUserHash(reportId, accessCode), holdings);
  }

  function addLineLedgerEntryForUser({ userId, ...entry }) {
    return addLineLedgerEntryByHash({ lineUserHash: memberLineUserHash(userId), ...entry });
  }

  function updateLineLedgerEntryForUser({ userId, entryId, patch }) {
    const lineUserHash = memberLineUserHash(userId);
    return immediateTransaction(() => updateLineLedgerEntryByHash({ lineUserHash, entryId, patch }));
  }

  function deleteLineLedgerEntryForUser({ userId, entryId }) {
    const lineUserHash = memberLineUserHash(userId);
    return immediateTransaction(() => deleteLineLedgerEntryByHash({ lineUserHash, entryId }));
  }

  function updateLineProfileForUser({ userId, profile }) {
    return updateLineProfileByHash(memberLineUserHash(userId), profile);
  }

  function replaceLineHoldingsForUser({ userId, holdings }) {
    return replaceLineHoldingsByHash(memberLineUserHash(userId), holdings);
  }

  function deleteLineUserDataByHash(lineUserHash) {
    return immediateTransaction(() => {
      const deleted = {
        ledgerEntries: db.prepare("SELECT COUNT(*) AS count FROM line_ledger_entries WHERE line_user_hash = ?").get(lineUserHash).count,
        holdings: db.prepare("SELECT COUNT(*) AS count FROM line_holdings WHERE line_user_hash = ?").get(lineUserHash).count,
        profiles: db.prepare("SELECT COUNT(*) AS count FROM line_profiles WHERE line_user_hash = ?").get(lineUserHash).count,
        bindings: db.prepare("SELECT COUNT(*) AS count FROM line_report_bindings WHERE line_user_hash = ?").get(lineUserHash).count
      };
      db.prepare("DELETE FROM line_ledger_entries WHERE line_user_hash = ?").run(lineUserHash);
      db.prepare("DELETE FROM line_holdings WHERE line_user_hash = ?").run(lineUserHash);
      db.prepare("DELETE FROM line_profiles WHERE line_user_hash = ?").run(lineUserHash);
      db.prepare("DELETE FROM line_command_receipts WHERE line_user_hash = ?").run(lineUserHash);
      db.prepare("DELETE FROM line_report_bindings WHERE line_user_hash = ?").run(lineUserHash);
      return deleted;
    });
  }

  function deleteLineUserData({ lineUserId }) {
    if (!lineUserId) throw new Error("缺少 LINE 使用者");
    return deleteLineUserDataByHash(accessHash(`line:${lineUserId}`));
  }

  function deleteLineUserDataForReport({ reportId, accessCode }) {
    return deleteLineUserDataByHash(boundLineUserHash(reportId, accessCode));
  }

  function deleteLineUserDataForUser(userId) {
    return deleteLineUserDataByHash(memberLineUserHash(userId));
  }

  function createOrder({ id, reportId, accessCode, userId = null, productType, amount, currency = "TWD", provider = "ecpay" }) {
    const report = userId ? assertUserReport(reportId, userId) : assertReportAccess(reportId, accessCode);
    const now = new Date().toISOString();
    const numericAmount = Math.round(Number(amount));
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) throw new Error("付款金額不正確");
    const statusToken = crypto.randomBytes(18).toString("base64url");
    insertOrder.run(
      id,
      reportId,
      String(productType).slice(0, 80),
      numericAmount,
      String(currency).slice(0, 8),
      String(provider).slice(0, 40),
      accessHash(statusToken),
      "pending",
      now,
      now
    );
    addEvent({
      anonymousId: report.anonymous_id,
      reportId,
      eventType: "payment_checkout_started",
      metadata: { orderId: id, productType, amount: numericAmount, currency, provider }
    });
    return { ...publicOrder(db.prepare("SELECT * FROM orders WHERE id = ?").get(id)), statusToken };
  }

  function getOrderStatus({ id, reportId, accessCode, statusToken, userId = null }) {
    const row = db.prepare("SELECT * FROM orders WHERE id = ? AND report_id = ?").get(id, reportId);
    if (!row) return null;
    if (statusToken) {
      if (!row.status_token_hash || !safeEqual(row.status_token_hash, accessHash(statusToken))) {
        const error = new Error("找不到付款訂單或付款查詢碼不正確");
        error.statusCode = 404;
        throw error;
      }
      return publicOrder(row);
    }
    if (userId) assertUserReport(reportId, userId);
    else assertReportAccess(reportId, accessCode);
    return publicOrder(row);
  }

  function recordPaymentEvent({ orderId = null, provider = "ecpay", eventType, validMac, payload = {} }) {
    insertPaymentEvent.run(
      crypto.randomUUID(),
      orderId,
      String(provider).slice(0, 40),
      String(eventType).slice(0, 80),
      validMac ? 1 : 0,
      new Date().toISOString(),
      encrypt(payload)
    );
  }

  function applyPaymentNotification({ orderId, provider = "ecpay", providerTradeNo = null, amount, rtnCode, rtnMsg = "", paidAt = null, validMac, payload = {}, entitlement = null }) {
    const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
    recordPaymentEvent({
      orderId: row ? orderId : null,
      provider,
      eventType: validMac ? `rtn_${rtnCode}` : "invalid_mac",
      validMac,
      payload
    });
    if (!row || !validMac) return { ok: false, order: row ? publicOrder(row) : null };
    if (row.status === "paid") return { ok: true, order: publicOrder(row), idempotent: true };

    const now = new Date().toISOString();
    const numericAmount = Math.round(Number(amount));
    if (numericAmount !== Number(row.amount)) {
      db.prepare(`
        UPDATE orders
        SET status = 'failed', provider_trade_no = ?, updated_at = ?, failed_at = ?, failure_reason = ?
        WHERE id = ?
      `).run(providerTradeNo, now, now, "amount_mismatch", orderId);
      return { ok: false, order: publicOrder(db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId)) };
    }

    if (String(rtnCode) !== "1") {
      db.prepare(`
        UPDATE orders
        SET status = 'failed', provider_trade_no = ?, updated_at = ?, failed_at = ?, failure_reason = ?
        WHERE id = ?
      `).run(providerTradeNo, now, now, String(rtnMsg || "payment_failed").slice(0, 200), orderId);
      const report = db.prepare("SELECT anonymous_id FROM reports WHERE id = ?").get(row.report_id);
      addEvent({ anonymousId: report?.anonymous_id || row.report_id, reportId: row.report_id, eventType: "payment_failed", metadata: { orderId, rtnCode, rtnMsg } });
      return { ok: false, order: publicOrder(db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId)) };
    }

    db.prepare(`
      UPDATE orders
      SET status = 'paid', provider_trade_no = ?, updated_at = ?, paid_at = ?, failure_reason = NULL
      WHERE id = ?
    `).run(providerTradeNo, now, paidAt || now, orderId);
    if (entitlement) {
      db.prepare(`
        INSERT OR IGNORE INTO report_entitlements (report_id, entitlement, source_order_id, granted_at)
        VALUES (?, ?, ?, ?)
      `).run(row.report_id, entitlement, orderId, now);
    }
    const report = db.prepare("SELECT anonymous_id FROM reports WHERE id = ?").get(row.report_id);
    addEvent({ anonymousId: report?.anonymous_id || row.report_id, reportId: row.report_id, eventType: "payment_paid", metadata: { orderId, provider, providerTradeNo } });
    return { ok: true, order: publicOrder(db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId)) };
  }

  function purgeExpired() {
    const now = new Date();
    const changes = db.prepare("DELETE FROM reports WHERE expires_at < ?").run(now.toISOString()).changes;
    db.prepare("DELETE FROM line_command_receipts WHERE created_at < ?")
      .run(new Date(now.getTime() - 90 * 86400000).toISOString());
    db.prepare("DELETE FROM line_ledger_entries WHERE occurred_at < ?")
      .run(new Date(now.getTime() - lineLedgerRetentionDays * 86400000).toISOString());
    db.prepare("DELETE FROM auth_challenges WHERE expires_at < ?").run(now.toISOString());
    db.prepare("DELETE FROM user_sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)")
      .run(now.toISOString(), new Date(now.getTime() - 30 * 86400000).toISOString());
    return changes;
  }

  return {
    addEvent,
    addLineLedgerEntryForUser,
    analytics,
    applyPaymentNotification,
    authenticatedUser,
    bindLineReport,
    close: () => db.close(),
    createOrder,
    createLineReportBinding,
    createReport,
    createAuthChallenge,
    createUserSession,
    addLineLedgerEntryForReport,
    deleteIndexedLineLedgerEntry,
    deleteLineLedgerEntryForReport,
    deleteLineUserData,
    deleteLineUserDataForReport,
    deleteLineUserDataForUser,
    deleteReport,
    deleteReportForUser,
    deleteUserAccount,
    deleteLastLineLedgerEntry,
    getAdminReport,
    getOrderStatus,
    getReport,
    getReportForUser,
    findOrCreateUserByLineId,
    addLineLedgerEntry,
    getLineReportSummary,
    lineCashflowForReport,
    lineCashflowForUser,
    lineLedgerSummary,
    lineLedgerEntries,
    listReports,
    purgeExpired,
    consumeAuthChallenge,
    completeUserOnboarding,
    revokeAllUserSessions,
    revokeUserSession,
    setFollowupStatus,
    replaceLineHoldingsForReport,
    replaceLineHoldingsForUser,
    updateIndexedLineLedgerEntry,
    updateLineLedgerEntryForReport,
    updateLineLedgerEntryForUser,
    updateLineProfileForReport,
    updateLineProfileForUser,
    userBootstrap,
    deleteLineLedgerEntryForUser,
    updateLastLineLedgerEntry
  };
}

module.exports = { authSessionDays, createStore, inputVersion, lineLedgerRetentionDays, reportVersion };
