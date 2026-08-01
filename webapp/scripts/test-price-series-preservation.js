const { applyPriceRefresh } = require("./update-price-series");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function row(ticker, date, close) {
  return { ticker, date, close, source: "twse-stock-day" };
}

function main() {
  const targets = [
    { ticker: "0056", qualityFlags: ["monthly_price_loaded"] },
    { ticker: "006208", qualityFlags: ["monthly_price_loaded"] }
  ];
  const db = {
    priceSeries: {
      status: "official_monthly_price_loaded",
      queryDate: "20260731",
      updatedAt: "2026-07-31T08:00:00.000Z",
      items: [row("0056", "2026-07-31", 35), row("006208", "2026-07-31", 120)]
    }
  };

  const partial = applyPriceRefresh(db, targets, [
    { ticker: "0056", status: "沒有符合資料", rows: [], sourceUrl: "https://example.test/0056" },
    { ticker: "006208", status: "OK", rows: [row("006208", "2026-08-03", 121)], sourceUrl: "https://example.test/006208" }
  ], { attemptedAt: "2026-08-03T08:00:00.000Z", attemptedQueryDate: "20260803" });

  assert(partial.updatedRows === 1 && partial.preservedRows === 1, "Partial refresh counts are incorrect");
  assert(db.priceSeries.status === "official_monthly_price_partially_loaded_preserved_previous", "Partial refresh status is incorrect");
  assert(db.priceSeries.items.some((item) => item.ticker === "0056" && item.date === "2026-07-31"), "Missing ticker did not preserve its previous rows");
  assert(db.priceSeries.items.some((item) => item.ticker === "006208" && item.date === "2026-08-03"), "Fresh ticker rows were not applied");

  const beforeNoDataUpdate = db.priceSeries.updatedAt;
  const noData = applyPriceRefresh(db, targets, [
    { ticker: "0056", status: "沒有符合資料", rows: [], sourceUrl: "https://example.test/0056" },
    { ticker: "006208", status: "沒有符合資料", rows: [], sourceUrl: "https://example.test/006208" }
  ], { attemptedAt: "2026-08-04T08:00:00.000Z", attemptedQueryDate: "20260804" });

  assert(noData.updatedRows === 0 && noData.preservedRows === 2, "No-data refresh did not preserve all prior rows");
  assert(db.priceSeries.status === "no_new_price_rows_preserved_previous", "No-data refresh status is incorrect");
  assert(db.priceSeries.updatedAt === beforeNoDataUpdate, "No-data refresh falsely changed the data update timestamp");
  assert(db.priceSeries.lastAttemptQueryDate === "20260804", "No-data refresh did not record the attempted query date");
  assert(targets.every((etf) => etf.qualityFlags.includes("monthly_price_loaded") && !etf.qualityFlags.includes("price_series_missing")), "Preserved price rows received incorrect quality flags");

  console.log(JSON.stringify({
    passed: true,
    partialRefreshPreservedMissingTicker: true,
    noDataRefreshPreservedSnapshot: true,
    sourceAttemptRecorded: true
  }, null, 2));
}

main();
