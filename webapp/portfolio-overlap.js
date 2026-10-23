/* Same arithmetic in the browser and node tests. Amounts stay on the client. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CashflowPortfolioOverlap = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function calculate(positions, instruments = {}) {
    const combined = new Map();
    for (const item of positions || []) {
      const ticker = String(item.ticker || '').trim().toUpperCase(), amount = Number(item.amount);
      if (ticker && Number.isFinite(amount) && amount > 0) combined.set(ticker, (combined.get(ticker) || 0) + amount);
    }
    const total = [...combined.values()].reduce((a, b) => a + b, 0), rows = new Map(), gaps = [], sources = [];
    let covered = 0;
    const add = (security, amount, ticker) => {
      // TW identifies Taiwan ordinary equities across TWSE and TPEx; foreign namespaces stay separate.
      const key = security.securityId;
      if (!key || !Number.isFinite(amount) || amount < 0) return false;
      const row = rows.get(key) || { securityId: key, ticker: security.code, name: security.name, amount: 0, sources: [] };
      row.amount += amount; row.sources.push({ ticker, amount }); rows.set(key, row); covered += amount; return true;
    };
    for (const [ticker, amount] of combined) {
      const data = instruments[ticker];
      if (!data || !['observed', 'cached'].includes(data.status) || data.identityVerified !== true) {
        gaps.push({ ticker, amount, reason: data?.message || '尚未核對官方資料；無法判定重疊' }); continue;
      }
      sources.push({ ticker, kind:data.kind, otherGroups:data.otherGroups||[], observedAt: data.observedAt, holdingsDate: data.holdingsDate || null,
        navDate: data.nav?.date || null, priceDate: data.price?.date || null, valuationVerification:data.valuationVerification||null,
        sourceUrl: data.sourceUrl, reused: data.status === 'cached', issues: data.issues || [] });
      if (data.kind === 'stock') {
        if (!add(data.security, amount, ticker)) gaps.push({ ticker, amount, reason: '證券識別資料不足' });
        continue;
      }
      const stocks = data.stocks || [], valid = stocks.length > 0 && stocks.every(r => r.securityId && typeof r.weight === 'number' && Number.isFinite(r.weight) && r.weight >= 0 && r.weight <= 100)
        && new Set(stocks.map(r => r.securityId)).size === stocks.length;
      const weight = stocks.reduce((sum, r) => sum + (Number.isFinite(r.weight) ? r.weight : 0), 0);
      // Do not silently normalise malformed, duplicated, leveraged or excessive weights.
      if (!valid || weight > 100) { gaps.push({ ticker, amount, reason: '持股權重或識別檢查未通過' }); continue; }
      stocks.forEach(row => add(row, amount * row.weight / 100, ticker));
      if (weight < 100) gaps.push({ ticker, amount: amount * (100 - weight) / 100, reason: '股票以外、未拆解或四捨五入部位；不推定為現金或零重疊' });
      if (!data.holdingsDate || data.complete !== true || data.issues?.length) gaps.push({ ticker, amount: null, reason: (data.issues || []).join('；') || '完整性或持股日期尚待確認' });
    }
    const list = [...rows.values()].map(r => ({ ...r, share: total ? r.amount / total * 100 : 0 })).sort((a,b) => b.amount-a.amount);
    const repeated = list.filter(r => new Set(r.sources.map(s => s.ticker)).size > 1);
    const dates = new Set(sources.map(s => s.holdingsDate).filter(Boolean));
    if (dates.size > 1) gaps.push({ ticker: '', amount: null, reason: '各 ETF 持股日期不同，屬跨日期比較' });
    return { total, rows: list, repeated, sources, gaps, coveredAmount: covered,
      coveragePercent: total ? covered / total * 100 : null,
      status: !total ? 'empty' : !list.length ? 'unavailable' : gaps.length ? 'partial' : 'complete',
      basis: '依輸入投入金額加權；並非持倉即時市值或完整衍生品曝險' };
  }
  return { calculate };
});
