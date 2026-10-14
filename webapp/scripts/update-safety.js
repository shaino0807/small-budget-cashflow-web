const fs = require("node:fs");
const path = require("node:path");
function officialDate(value) {
  const compact = String(value ?? "").trim().replace(/[./-]/g, "");
  if (!/^\d{7,8}$/.test(compact)) return null;
  const length = compact.length - 4;
  const year = Number(compact.slice(0, length)) + (length === 3 ? 1911 : 0);
  const iso = `${year}-${compact.slice(-4, -2)}-${compact.slice(-2)}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return year >= 1912 && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null;
}
function toNumber(value) {
  if (value == null || String(value).trim() === "") return null;
  const text = String(value).trim().replaceAll(",", "");
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}
function atomicWriteJson(file, value) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
module.exports = { officialDate, toNumber, atomicWriteJson };
