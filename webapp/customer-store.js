const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const inputVersion = "cashflow-input-v2";
const reportVersion = "cashflow-report-v2";
const dataDir = path.resolve(process.env.CUSTOMER_DATA_DIR || path.join(__dirname, "private-data"));
const dbPath = path.join(dataDir, "customers.sqlite");
const retentionDays = Math.max(1, Math.min(3650, Number(process.env.CUSTOMER_RETENTION_DAYS || 365)));

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
    CREATE TABLE IF NOT EXISTS reports (
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
  `);
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

function publicReport(row) {
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
    payload
  };
}

function createStore() {
  const db = initialize();
  const insertReport = db.prepare(`
    INSERT INTO reports (
      id, anonymous_id, access_hash, check_type, report_status, input_version, report_version,
      consent_at, created_at, updated_at, expires_at, contact_channel, contact_cipher, payload_cipher
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEvent = db.prepare(`
    INSERT INTO events (id, anonymous_id, report_id, event_type, created_at, metadata_cipher)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  function addEvent({ anonymousId, reportId = null, eventType, metadata = {} }) {
    const allowedEvents = ["page_opened", "quiz_started", "report_generated", "report_reopened", "cta_clicked"];
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

  function createReport(body) {
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
    return { id, accessCode, anonymousId, createdAt: now.toISOString(), expiresAt: expires.toISOString(), inputVersion, reportVersion };
  }

  function getReport(id, code) {
    const row = db.prepare("SELECT * FROM reports WHERE id = ?").get(id);
    if (!row || !safeEqual(row.access_hash, accessHash(code))) return null;
    if (new Date(row.expires_at) < new Date()) return null;
    addEvent({ anonymousId: row.anonymous_id, reportId: id, eventType: "report_reopened" });
    return publicReport(row);
  }

  function deleteReport(id, code) {
    const row = db.prepare("SELECT anonymous_id, access_hash FROM reports WHERE id = ?").get(id);
    if (!row || !safeEqual(row.access_hash, accessHash(code))) return false;
    db.prepare("DELETE FROM reports WHERE id = ?").run(id);
    return true;
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
      ...publicReport(row),
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

  function purgeExpired() {
    return db.prepare("DELETE FROM reports WHERE expires_at < ?").run(new Date().toISOString()).changes;
  }

  return { addEvent, analytics, createReport, deleteReport, getAdminReport, getReport, listReports, purgeExpired, setFollowupStatus };
}

module.exports = { createStore, inputVersion, reportVersion };
