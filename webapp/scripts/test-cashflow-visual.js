const assert = require("node:assert/strict");
const { cashflowComposition } = require("../cashflow-visual");

const example = cashflowComposition({ income: 42000, expense: 33000 });
assert.equal(example.remaining, 9000);
assert.equal(example.base, 42000);
assert.equal(example.segments.length, 2);
assert.ok(Math.abs(example.segments[0].percent - 78.57142857) < 0.00001);
const investment = cashflowComposition({ income: 42000, investmentIncome: 1000, expense: 33000, investment: 5000 });
assert.equal(investment.remaining, 5000);
assert.equal(investment.base, 43000);
assert.equal(investment.segments.find((item) => item.key === "investment").amount, 5000);
const overspent = cashflowComposition({ income: 1000, expense: 2000, investment: 500 });
assert.equal(overspent.shortfall, 1500);
assert.equal(overspent.base, 2500);
assert.equal(overspent.segments.some((item) => item.key === "remaining"), false);
const onlyExpense = cashflowComposition({ expense: 230 });
assert.equal(onlyExpense.income, 0);
assert.equal(onlyExpense.shortfall, 230);
assert.equal(onlyExpense.segments[0].percent, 100);
assert.deepEqual(cashflowComposition().segments, []);
for (const fixture of [example, investment, overspent, onlyExpense]) {
  assert.ok(Math.abs(fixture.segments.reduce((total, item) => total + item.percent, 0) - 100) < 0.00001);
  assert.ok(fixture.segments.every((item) => Number.isFinite(item.percent) && item.percent > 0));
}
console.log(JSON.stringify({ passed: true, example: true, investmentFlows: true, overspent: true, noIncome: true, empty: true }));
