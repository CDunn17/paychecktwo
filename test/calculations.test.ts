import test from "node:test";
import assert from "node:assert/strict";
import { analyzeCashflow, compareOptions, findPressurePoints, shiftDateKey } from "../src/agent/calculations.js";
import type { FinancialPlan } from "../src/agent/schemas.js";

const plan: FinancialPlan = {
  name: "Alex",
  balance: 642,
  paycheck: 1840,
  buffer: 100,
  payday: "2026-08-25",
  periodStart: "2026-08-11",
  bills: [
    { id: "phone", name: "Phone", amount: 74, due: "2026-08-18", category: "Utilities" },
    { id: "groceries", name: "Groceries", amount: 95, due: "2026-08-20", category: "Food" },
    { id: "insurance", name: "Car insurance", amount: 126, due: "2026-08-23", category: "Transport" }
  ]
};

test("baseline analysis protects bills and buffer", () => {
  const result = analyzeCashflow(plan, "2026-08-17");
  assert.equal(result.obligationsTotal, 295);
  assert.equal(result.safeToSpend, 247);
  assert.equal(result.dailyFlexibleLimit, 30.875);
  assert.equal(result.riskLevel, "stable");
});

test("late paycheck extends the obligation window", () => {
  const delayedPlan: FinancialPlan = {
    ...plan,
    bills: [...plan.bills, { id: "rent", name: "Rent", amount: 500, due: "2026-08-27", category: "Home" }]
  };
  const result = analyzeCashflow(delayedPlan, "2026-08-17", {
    paycheckDelayDays: 3,
    incomeReduction: 0,
    unexpectedExpenses: []
  });
  assert.equal(result.effectivePayday, "2026-08-28");
  assert.equal(result.obligationsTotal, 795);
  assert.equal(result.riskLevel, "shortfall");
});

test("unexpected expense creates a visible pressure point", () => {
  const result = analyzeCashflow(plan, "2026-08-17", {
    paycheckDelayDays: 0,
    incomeReduction: 0,
    unexpectedExpenses: [{ name: "Tire", amount: 300, due: "2026-08-19" }]
  });
  const points = findPressurePoints(result);
  assert.equal(result.rawRemainder, -53);
  assert.equal(points[0]?.type, "shortfall");
  assert.equal(points[0]?.amount, 53);
});

test("reduced income remains visible as a pressure point even when pre-payday risk is stable", () => {
  const result = analyzeCashflow(plan, "2026-08-17", {
    paycheckDelayDays: 0,
    incomeReduction: 250,
    unexpectedExpenses: []
  });
  const points = findPressurePoints(result);
  const incomePoint = points.find((point) => point.type === "income_reduction");
  assert.equal(result.riskLevel, "stable");
  assert.equal(result.incomeReduction, 250);
  assert.equal(result.expectedPaycheck, 1590);
  assert.equal(incomePoint?.amount, 250);
  assert.match(incomePoint?.description ?? "", /next paycheck is reduced by \$250\.00/);
});

test("option comparison exposes impact and buffer tradeoffs", () => {
  const baseline = analyzeCashflow(plan, "2026-08-17");
  const options = compareOptions(plan, baseline, [
    { label: "Move insurance", billIdsToDefer: ["insurance"], spendingReduction: 0, bufferReduction: 0 },
    { label: "Use half the buffer", billIdsToDefer: [], spendingReduction: 0, bufferReduction: 50 }
  ]);
  assert.equal(options[0]?.label, "Move insurance");
  assert.equal(options[0]?.roomCreated, 126);
  assert.match(options[0]?.warnings[0] ?? "", /Confirm due-date changes/);
  assert.equal(options[1]?.remainingBuffer, 50);
});

test("date shifting is UTC-safe across month boundaries", () => {
  assert.equal(shiftDateKey("2026-08-31", 3), "2026-09-03");
});
