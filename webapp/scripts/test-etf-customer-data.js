const assert = require("node:assert/strict");
const data = require("../etf-data");
let cases = 0;
function check(actual, expected, message) { assert.deepEqual(actual, expected, message); cases++; }
const db = {
  etfs: [{ ticker: "0050", shortName: "元大台灣50", listingDate: "2003-06-30" }, { ticker: "0056", shortName: "元大高股息" }, { ticker: "00999", shortName: "測試高股息" }],
  priceSeries: { items: [{ ticker: "0050", date: "2026-10-08", close: 100 }, { ticker: "0050", date: "2026-10-12", close: 999 }] },
  navSeries: { items: [{ ticker: "0056", date: "2026-10-08", nav: 50, close: null }] },
  distributionHistory: { "0050": { complete: true, from: "2024-01-01", to: "2026-10-11" } },
  distributions: [
    { ticker: "0050", payDate: "2025-10-11", amountPerUnit: 20 },
    { ticker: "0050", payDate: "2025-10-12", amountPerUnit: 1 },
    { ticker: "0050", payDate: "2026-04-10", amountPerUnit: 2 },
    { ticker: "0050", payDate: "2026-10-11", amountPerUnit: 3 },
    { ticker: "0050", payDate: "2026-10-12", amountPerUnit: 50 },
    { ticker: "0050", payDate: null, amountPerUnit: 20 },
    { ticker: "0050", payDate: "2026-02-30", amountPerUnit: 20 },
    { ticker: "0050", payDate: "2026-04-10", amountPerUnit: 2 }
  ]
};
check(data.resolveEtf(db, "0050").ticker, "0050", "leading zero code");
check(data.resolveEtf(db, "元大台灣50").ticker, "0050", "Chinese name");
check(data.resolveEtf(db, "0056 元大高股息").ticker, "0056", "datalist label");
check(data.resolveEtf(db, "高股息"), null, "ambiguous name must not guess");
check(data.resolveEtf(db, "0000"), null, "unknown code");
check(data.heldTickers(db, [{ ticker: "0050" }, { ticker: "0050" }, { ticker: "0056" }, { ticker: "2330" }]), ["0050", "0056"], "held ETF only and no duplicates");
check(data.isoDate("2026-02-30"), null, "invalid calendar date");
check(data.numberOrNull(null), null, "missing numeric evidence is not zero");
check(data.trailingYield(db, "0050", "2026-10-11").value, 6, "all actual paid cash in trailing calendar year, not last four payments");
check(data.trailingYield(db, "0050", "2026-10-11").payments, 3, "duplicates and future/undated payments excluded");
check(data.latestClose(db, "0050", "2026-10-11").close, 100, "future price excluded");
check(data.latestClose(db, "0056", "2026-10-11"), null, "NAV is not a market close");
for (const date of ["2026-09-30", "2026-10-01", "2026-10-11", "2026-12-31", "2027-01-01", "2028-02-29"]) {
  const fixture = structuredClone(db);
  fixture.distributionHistory["0050"].to = date;
  fixture.priceSeries.items = [{ ticker: "0050", date, close: 50 }];
  const from = data.monthsBefore(date, 12);
  fixture.distributions = [{ ticker: "0050", payDate: from, amountPerUnit: 100 }, { ticker: "0050", payDate: date, amountPerUnit: 2 }];
  check(data.trailingYield(fixture, "0050", date).value, 4, `month/year/leap boundary ${date}`);
}
check(data.monthsBefore("2028-02-29", 12), "2027-02-28", "leap day clamped");
const missing = structuredClone(db);
missing.distributionHistory["0050"].complete = false;
check(data.trailingYield(missing, "0050", "2026-10-11").value, null, "incomplete history never zero");
missing.distributionHistory["0050"] = { complete: true, from: "2026-01-01", to: "2026-10-11" };
check(data.trailingYield(missing, "0050", "2026-10-11").value, null, "insufficient window never annualized");
missing.distributionHistory["0050"] = { complete: true, from: "2024-01-01", to: "2026-10-11", nonDistributing: true };
check(data.trailingYield(missing, "0050", "2026-10-11").value, 0, "only official non-distributing evidence yields zero");
const split = structuredClone(db);
split.splits = [{ ticker: "0050", date: "2026-01-01", ratio: 4 }];
check(data.trailingYield(split, "0050", "2026-10-11").value, 5.25, "pre-split cash uses current units");
split.splits[0].ratio = null;
check(data.trailingYield(split, "0050", "2026-10-11").value, null, "invalid split never inferred");
const short = structuredClone(db);
short.etfs[0].listingDate = "2026-01-01";
check(data.trailingYield(short, "0050", "2026-10-11").status, "short_history", "short listing explicitly labeled");
const prices = { priceSeries: { items: [
  { ticker: "0050", date: "2026-09-30", close: 100 }, { ticker: "0050", date: "2026-10-01", close: 110 }, { ticker: "0050", date: "2026-10-08", close: 121 },
  { ticker: "0056", date: "2026-10-01", close: 50 }, { ticker: "0056", date: "2026-10-08", close: 55 }, { ticker: "0056", date: "2026-10-12", close: 60 }
] } };
const comparison = data.priceComparison(prices, ["0050", "0056"], 1, "2026-10-11");
check(comparison.start, "2026-10-01", "same actual date base for both ETFs");
check(comparison.end, "2026-10-08", "common end excludes future points");
check(comparison.normalized["0050"].map((row) => Number(row.normalizedClose.toFixed(2))), [100, 110], "same date normalization");
check(data.priceComparison(prices, ["0050", "00999"], 1, "2026-10-11").reason, "missing_prices", "missing selection not silently dropped");
check(data.priceComparison(prices, [], 1, "2026-10-11").reason, "empty_selection", "empty chart cleared");
prices.splits = [{ ticker: "0050", date: "2026-10-02", ratio: 4 }];
check(data.priceComparison(prices, ["0050", "0056"], 1, "2026-10-11").reason, "split_in_range", "known split blocks unadjusted misleading comparison");
console.log(JSON.stringify({ passed: true, cases, monthBoundary: true, officialMissingIsNull: true }));
