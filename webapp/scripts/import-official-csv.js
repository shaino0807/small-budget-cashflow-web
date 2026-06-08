const fs = require("fs");
const path = require("path");

const [, , kind, file] = process.argv;
const dbPath = path.join(__dirname, "..", "data", "etf-database.json");

if (!["holdings", "nav"].includes(kind) || !file) {
  console.error("Usage: node webapp\\scripts\\import-official-csv.js holdings|nav <csv-path>");
  process.exit(1);
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const headers = lines.shift().split(",").map((item) => item.trim());
  return lines.map((line) => {
    const values = line.split(",");
    return Object.fromEntries(headers.map((header, index) => [header, (values[index] || "").trim()]));
  });
}

function toNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
const rows = parseCsv(fs.readFileSync(path.resolve(file), "utf8"));
const tickers = new Set(db.etfs.map((item) => item.ticker));
const unknown = rows.filter((row) => !tickers.has(row.ticker)).map((row) => row.ticker);
if (unknown.length) {
  console.error(`Unknown tickers: ${[...new Set(unknown)].join(", ")}`);
  process.exit(1);
}

if (kind === "holdings") {
  const items = rows
    .filter((row) => row.holdingTicker && row.weight)
    .map((row) => ({
      ticker: row.ticker,
      asOfDate: row.asOfDate,
      holdingTicker: row.holdingTicker,
      holdingName: row.holdingName,
      weight: toNumber(row.weight),
      shares: toNumber(row.shares),
      sector: row.sector,
      sourceUrl: row.sourceUrl,
      source: "official_csv_import"
    }));
  db.holdings.status = items.length ? "official_csv_imported" : "empty_import";
  db.holdings.items = items;
  for (const etf of db.etfs) {
    const hasRows = items.some((item) => item.ticker === etf.ticker);
    etf.qualityFlags = (etf.qualityFlags || []).filter((flag) => flag !== "holdings_missing");
    if (hasRows && !etf.qualityFlags.includes("holdings_loaded")) etf.qualityFlags.push("holdings_loaded");
    if (!hasRows && !etf.qualityFlags.includes("holdings_missing")) etf.qualityFlags.push("holdings_missing");
  }
}

if (kind === "nav") {
  const items = rows
    .filter((row) => row.date && row.nav)
    .map((row) => ({
      ticker: row.ticker,
      date: row.date,
      close: toNumber(row.close),
      nav: toNumber(row.nav),
      premiumDiscountPercent: toNumber(row.premiumDiscountPercent),
      sourceUrl: row.sourceUrl,
      source: "official_csv_import"
    }));
  db.navSeries.status = items.length ? "official_csv_imported" : "empty_import";
  db.navSeries.items = items;
  for (const etf of db.etfs) {
    const hasRows = items.some((item) => item.ticker === etf.ticker);
    etf.qualityFlags = (etf.qualityFlags || []).filter((flag) => flag !== "nav_series_missing");
    if (hasRows && !etf.qualityFlags.includes("nav_series_loaded")) etf.qualityFlags.push("nav_series_loaded");
    if (!hasRows && !etf.qualityFlags.includes("nav_series_missing")) etf.qualityFlags.push("nav_series_missing");
  }
}

fs.writeFileSync(dbPath, `${JSON.stringify(db, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ kind, importedRows: rows.length }, null, 2));
