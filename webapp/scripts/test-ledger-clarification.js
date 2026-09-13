const assert = require("node:assert/strict");
global.fetch = async () => { throw new Error("External network forbidden"); };
const { parseVoiceLedgerTranscript } = require("../line-bot");

for (const text of ["今天停車費一百八", "今天停車費花一百八", "今天停車費花 180", "今天停車費一百八十元"]) {
  const result = parseVoiceLedgerTranscript(text);
  assert.equal(result.intent, "ledger", text);
  assert.equal(result.amount, 180, text);
  assert.equal(result.category, "交通", text);
}
for (const text of ["今天花晚餐,還今天花停車費一百八。", "今天花晚餐還花停車費 180", "今天晚餐、停車費共180元"]) {
  const result = parseVoiceLedgerTranscript(text);
  assert.equal(result.reason, "ambiguous_amount_scope", text);
  assert.match(result.clarification, /180/);
  assert.match(result.clarification, /晚餐/);
  assert.match(result.clarification, /停車/);
  assert.ok(!result.clarification.includes("缺少金額"));
}
for (const [text, missing, present] of [
  ["今天晚餐", "金額", "用途"],
  ["今天花一百八", "用途", "金額"],
  ["我今天花一百八塊錢", "用途", "金額"],
  ["請幫我記帳今天花180元", "用途", "金額"],
  ["停車費180", "日期", "金額"],
  ["今天", "用途", "日期"]
]) {
  const result = parseVoiceLedgerTranscript(text);
  assert.equal(result.reason, "missing_fields", text);
  assert.ok(result.clarification.includes(missing), text);
  assert.ok(!result.clarification.includes(present), text);
}
for (const text of ["今天停車花一百八，晚餐花一百八", "今天停車花180晚餐花180", "今天停車180然後晚餐180"]) {
  const batch = parseVoiceLedgerTranscript(text);
  assert.equal(batch.intent, "ledger_batch", text);
  assert.deepEqual(batch.entries.map(entry => entry.amount), [180, 180]);
  assert.deepEqual(batch.entries.map(entry => entry.category), ["交通", "伙食"]);
  assert.equal(batch.entries[0].occurredAt, batch.entries[1].occurredAt, "inherit the explicitly spoken date");
}
assert.equal(parseVoiceLedgerTranscript("昨天晚餐180，今天停車費60").entries.length, 2);
assert.equal(parseVoiceLedgerTranscript("今天晚餐180，停車費60，飲料").reason, "batch_missing_fields");
assert.equal(parseVoiceLedgerTranscript("晚餐180，停車費60").reason, "batch_missing_fields");
assert.match(parseVoiceLedgerTranscript(Array(41).fill("今天晚餐180").join("，")).clarification, /超過 40 筆/);
const investment = parseVoiceLedgerTranscript("今天買0050一萬元");
assert.equal(parseVoiceLedgerTranscript("二零二六年二月三十號晚餐180").reason, "invalid_date");
for (const text of ["二零二二年九月十三號停車費一百八，二零二六年九月十三號晚餐一百八", "2022 年 9 月 13 號停車費 180，2026 年 9 月 13 號晚餐 180"]) {
  const batch = parseVoiceLedgerTranscript(text);
  assert.equal(batch.intent, "ledger_batch");
  assert.deepEqual(batch.entries.map(entry => entry.occurredAt.slice(0, 10)), ["2022-09-13", "2026-09-13"]);
  assert.deepEqual(batch.entries.map(entry => entry.amount), [180, 180]);
}
assert.equal(investment.type, "investment");
assert.equal(investment.amount, 10000);
assert.equal(investment.ticker, "0050");
console.log(JSON.stringify({ passed: true, voiceAmount180: true, explicitMissingFields: true, ambiguousScopeBlocked: true, realExternalCalls: 0 }));
