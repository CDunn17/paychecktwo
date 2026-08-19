import test from "node:test";
import assert from "node:assert/strict";
import {
  remainingStageBudgetMs,
  settleWithinDeadline,
  WallClockDeadlineError
} from "../src/agent/execution-budget.js";

test("stage budget preserves the finalization reserve", () => {
  assert.equal(remainingStageBudgetMs({
    nowMs: 40_000,
    deadlineAtMs: 120_000,
    reserveMs: 35_000,
    stageCapMs: 45_000
  }), 45_000);
  assert.equal(remainingStageBudgetMs({
    nowMs: 70_000,
    deadlineAtMs: 120_000,
    reserveMs: 35_000,
    stageCapMs: 45_000
  }), 15_000);
});

test("stage budget fails closed when only the reserve remains", () => {
  assert.equal(remainingStageBudgetMs({
    nowMs: 85_000,
    deadlineAtMs: 120_000,
    reserveMs: 35_000,
    stageCapMs: 45_000
  }), 0);
});

test("hard wall-clock deadline aborts and returns control even when an operation does not settle", async () => {
  let aborted = false;
  const operation = new Promise<never>(() => {});
  await assert.rejects(
    settleWithinDeadline({
      operation,
      deadlineAtMs: performance.now() + 10,
      onDeadline: () => {
        aborted = true;
      }
    }),
    WallClockDeadlineError
  );
  assert.equal(aborted, true);
});
