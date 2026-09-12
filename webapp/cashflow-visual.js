/* Shared presentation math. Does not change the ledger or budget. */
(function (root) {
  function cashflowComposition(values = {}) {
    const amount = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
    const income = amount(values.income) + amount(values.investmentIncome);
    const expense = amount(values.expense);
    const investment = amount(values.investment);
    const outflow = expense + investment;
    const remaining = income - outflow;
    const base = Math.max(income, outflow);
    const segments = [
      { key: "expense", label: "支出", amount: expense },
      { key: "investment", label: "投資買入", amount: investment },
      { key: "remaining", label: "剩餘", amount: Math.max(0, remaining) }
    ].filter((item) => item.amount > 0).map((item) => ({ ...item, percent: base > 0 ? item.amount / base * 100 : 0 }));
    return { income, outflow, remaining, shortfall: Math.max(0, -remaining), base, segments };
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { cashflowComposition };
  else root.cashflowComposition = cashflowComposition;
})(typeof window !== "undefined" ? window : globalThis);
