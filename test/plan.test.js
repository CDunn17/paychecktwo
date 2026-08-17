import test from "node:test";
import assert from "node:assert/strict";
import { billsThrough, calculatePlan, daysBetween } from "../src/plan.js";

const today = new Date(2026, 7, 17);

test("daysBetween uses calendar days", () => {
  assert.equal(daysBetween(today, "2026-08-25"), 8);
});

test("billsThrough includes today and payday but excludes later bills", () => {
  const bills = [
    { amount: 10, due: "2026-08-17" },
    { amount: 20, due: "2026-08-25" },
    { amount: 30, due: "2026-08-26" }
  ];
  assert.equal(billsThrough(bills, "2026-08-25", today).length, 2);
});

test("calculatePlan reserves bills and buffer", () => {
  const result = calculatePlan({
    balance: 642,
    paycheck: 1840,
    buffer: 100,
    payday: "2026-08-25",
    bills: [{ amount: 74, due: "2026-08-18" }, { amount: 95, due: "2026-08-20" }]
  }, today);
  assert.equal(result.billsTotal, 169);
  assert.equal(result.safeToSpend, 373);
  assert.equal(result.afterPaycheck, 2213);
  assert.equal(result.dailySafe, 46.625);
});

test("safe to spend never presents a negative amount", () => {
  const result = calculatePlan({
    balance: 100,
    paycheck: 500,
    buffer: 50,
    payday: "2026-08-25",
    bills: [{ amount: 200, due: "2026-08-20" }]
  }, today);
  assert.equal(result.safeToSpend, 0);
  assert.equal(result.rawRemainder, -150);
  assert.equal(result.afterPaycheck, 350);
});
