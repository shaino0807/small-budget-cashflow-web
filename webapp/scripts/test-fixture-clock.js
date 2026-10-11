// Loaded only by the month-regression child processes; never by the application.
const assert = require("node:assert/strict");
const { mock } = require("node:test");

const timestamp = process.env.CASHFLOW_TEST_NOW;
assert.match(timestamp || "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "a fixed UTC test date is required");
const now = new Date(timestamp);
assert.equal(now.toISOString(), timestamp, "test date must be valid and canonical");
mock.timers.enable({ apis: ["Date"], now });
assert.equal(Date.now(), now.getTime());
