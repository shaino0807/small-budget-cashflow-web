(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CashflowEtfData = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";
  const numberOrNull = (value) => value === null || value === undefined || String(value).trim() === "" ? null
    : Number.isFinite(Number(String(value).replaceAll(",", ""))) ? Number(String(value).replaceAll(",", "")) : null;
  function isoDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return null;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
  }
  function today(date = new Date()) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  }
  function monthsBefore(date, count) {
    const d = new Date(`${date}T00:00:00Z`), day = d.getUTCDate();
    d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - count);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return d.toISOString().slice(0, 10);
  }
  function searchEtfs(db, value) {
    const query = String(value || "").trim().toUpperCase();
    if (!query) return [];
    return (db?.etfs || []).filter((etf) => [etf.ticker, etf.shortName, etf.fundName, ...(etf.aliases || [])]
      .some((text) => String(text || "").toUpperCase().includes(query)));
  }
  function resolveEtf(db, value) {
    const query = String(value || "").trim().toUpperCase();
    const code = query.match(/^(0\d{3,5}[A-Z]?)(?:\s|$)/)?.[1];
    const exact = (db?.etfs || []).filter((etf) => etf.ticker === (code || query)
      || [etf.shortName, etf.fundName, ...(etf.aliases || [])].some((name) => String(name || "").toUpperCase() === query));
    if (exact.length === 1) return exact[0];
    const matches = searchEtfs(db, query);
    return matches.length === 1 ? matches[0] : null;
  }
  function heldTickers(db, holdings) {
    return [...new Set((holdings || []).map((holding) => resolveEtf(db, holding.ticker)?.ticker).filter(Boolean))];
  }
  function latestClose(db, ticker, asOf = today()) {
    return [...(db?.priceSeries?.items || []), ...(db?.navSeries?.items || [])]
      .filter((row) => row.ticker === ticker && isoDate(row.date) && row.date <= asOf && numberOrNull(row.close) > 0)
      .sort((a, b) => b.date.localeCompare(a.date))[0] || null;
  }
  function trailingYield(db, ticker, asOf = today()) {
    const history = db?.distributionHistory?.[ticker];
    const price = latestClose(db, ticker, asOf);
    const from = monthsBefore(asOf, 12);
    const base = { value: null, status: "missing_history", from, to: asOf, priceDate: price?.date || null,
      close: price ? numberOrNull(price.close) : null, observedAt: history?.updatedAt || null, sourceUrl: history?.sourceUrl || null };
    if (!history?.complete || !isoDate(history.from) || !isoDate(history.to) || history.from > from || history.to < asOf) return base;
    if (!price) return { ...base, status: "missing_price" };
    if (history.nonDistributing === true) return { ...base, value: 0, cash: 0, status: "non_distributing" };
    const unique = new Map();
    for (const row of db?.distributions || []) {
      if (row.ticker !== ticker || !isoDate(row.payDate) || row.payDate <= from || row.payDate > asOf || !(numberOrNull(row.amountPerUnit) > 0)) continue;
      const adjustments = (db.splits || []).filter((split) => split.ticker === ticker && isoDate(split.date) && split.date > row.payDate && split.date <= asOf);
      if (adjustments.some((split) => !(numberOrNull(split.ratio) > 0))) return { ...base, status: "invalid_split" };
      const adjustedCash = numberOrNull(row.amountPerUnit) / adjustments.reduce((factor, split) => factor * numberOrNull(split.ratio), 1);
      unique.set(`${row.payDate}|${row.exDividendDate || ""}`, adjustedCash);
    }
    const cash = [...unique.values()].reduce((sum, amount) => sum + amount, 0);
    if (!unique.size) return { ...base, status: "no_paid_distributions" };
    const etf = (db.etfs || []).find((item) => item.ticker === ticker);
    const partial = isoDate(etf?.listingDate) && etf.listingDate > from;
    return { ...base, cash, payments: unique.size, value: Number((cash / base.close * 100).toFixed(2)),
      status: partial ? "short_history" : "available" };
  }
  function priceComparison(db, tickers, months = 1, asOf = today()) {
    const series = [...new Set(tickers)].map((ticker) => ({ ticker, rows: (db?.priceSeries?.items || [])
      .filter((row) => row.ticker === ticker && isoDate(row.date) && row.date <= asOf && numberOrNull(row.close) > 0)
      .sort((a, b) => a.date.localeCompare(b.date)) }));
    const missing = series.filter((item) => !item.rows.length).map((item) => item.ticker);
    if (!series.length || missing.length) return { normalized: {}, missing, reason: missing.length ? "missing_prices" : "empty_selection" };
    const end = series.map((item) => item.rows.at(-1).date).sort()[0];
    const cutoff = months ? monthsBefore(end, months) : "0000-01-01";
    const commonDates = series[0].rows.filter((row) => row.date >= cutoff && row.date <= end
      && series.every((item) => item.rows.some((point) => point.date === row.date))).map((row) => row.date);
    if (!commonDates.length) return { normalized: {}, missing: [], reason: "no_common_dates" };
    const start = commonDates[0];
    const splits = (db.splits || []).filter((split) => tickers.includes(split.ticker) && split.date > start && split.date <= end);
    if (splits.length) return { normalized: {}, missing: [], reason: "split_in_range" };
    const normalized = Object.fromEntries(series.map(({ ticker, rows }) => {
      const base = numberOrNull(rows.find((row) => row.date === start).close);
      return [ticker, rows.filter((row) => row.date >= start && row.date <= end).map((row) => ({ ...row, normalizedClose: numberOrNull(row.close) / base * 100 }))];
    }));
    return { normalized, missing: [], start, end, reason: "available" };
  }
  return { numberOrNull, isoDate, today, monthsBefore, searchEtfs, resolveEtf, heldTickers, latestClose, trailingYield, priceComparison };
});
