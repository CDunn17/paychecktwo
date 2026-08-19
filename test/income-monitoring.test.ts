import test from "node:test";
import assert from "node:assert/strict";
import { analyzeIncomeMonitoring, assessIncomeExpectations } from "../src/agent/income-monitoring.js";
import { IncomeMonitoringSnapshotSchema, type IncomeMonitoringSnapshot } from "../src/agent/monitoring-schemas.js";

function snapshot(overrides: Partial<IncomeMonitoringSnapshot> = {}): IncomeMonitoringSnapshot {
  return {
    asOf: "2026-08-21",
    horizonEnd: "2026-08-31",
    availableBalanceCents: 42_000,
    protectedBufferCents: 10_000,
    incomeExpectations: [],
    observedIncome: [],
    obligations: [],
    ...overrides
  };
}

test("hourly income remains pending until its confirmed grace period ends", () => {
  const input = snapshot({
    asOf: "2026-08-22",
    incomeExpectations: [{
      id: "shift-work",
      label: "Hourly job",
      kind: "hourly_job",
      windowStart: "2026-08-15",
      expectedBy: "2026-08-21",
      graceDays: 2,
      minimumExpectedCents: 60_000,
      typicalExpectedCents: 78_000,
      confidence: "user_confirmed"
    }],
    observedIncome: [{
      id: "partial-pay",
      sourceId: "shift-work",
      receivedOn: "2026-08-21",
      amountCents: 40_000,
      matchConfidence: "user_confirmed"
    }]
  });

  const [assessment] = assessIncomeExpectations(input);
  assert.equal(assessment?.status, "grace_period");
  assert.equal(assessment?.receivedCents, 40_000);
  assert.equal(assessment?.remainingToMinimumCents, 20_000);
});

test("partial hourly income becomes a reduced-income disruption after grace", () => {
  const input = snapshot({
    asOf: "2026-08-24",
    incomeExpectations: [{
      id: "shift-work",
      label: "Hourly job",
      kind: "hourly_job",
      windowStart: "2026-08-15",
      expectedBy: "2026-08-21",
      graceDays: 2,
      minimumExpectedCents: 60_000,
      typicalExpectedCents: 78_000,
      confidence: "user_confirmed"
    }],
    observedIncome: [{
      id: "partial-pay",
      sourceId: "shift-work",
      receivedOn: "2026-08-21",
      amountCents: 40_000,
      matchConfidence: "user_confirmed"
    }]
  });

  const result = analyzeIncomeMonitoring(input);
  assert.equal(result.assessments[0]?.status, "reduced");
  assert.deepEqual(result.disruptions[0], {
    sourceId: "shift-work",
    type: "reduced_income",
    active: true,
    detectedOn: "2026-08-24",
    expectedBy: "2026-08-21",
    amountAtIssueCents: 20_000,
    requiresUserConfirmation: false
  });
});

test("multiple income sources are assessed independently", () => {
  const input = snapshot({
    asOf: "2026-08-25",
    incomeExpectations: [
      {
        id: "job-a",
        label: "Job A",
        kind: "hourly_job",
        windowStart: "2026-08-15",
        expectedBy: "2026-08-22",
        graceDays: 1,
        minimumExpectedCents: 50_000,
        typicalExpectedCents: 65_000,
        confidence: "user_confirmed"
      },
      {
        id: "client-b",
        label: "Client B",
        kind: "freelance_client",
        windowStart: "2026-08-15",
        expectedBy: "2026-08-22",
        graceDays: 1,
        minimumExpectedCents: 25_000,
        typicalExpectedCents: 40_000,
        confidence: "user_confirmed"
      }
    ],
    observedIncome: [{
      id: "job-a-pay",
      sourceId: "job-a",
      receivedOn: "2026-08-22",
      amountCents: 65_000,
      matchConfidence: "user_confirmed"
    }]
  });

  const result = analyzeIncomeMonitoring(input);
  assert.equal(result.assessments.find(({ sourceId }) => sourceId === "job-a")?.status, "met");
  assert.equal(result.assessments.find(({ sourceId }) => sourceId === "client-b")?.status, "missing");
  assert.equal(result.disruptions.length, 1);
  assert.equal(result.disruptions[0]?.sourceId, "client-b");
});

test("inferred income is excluded from the conservative coverage forecast", () => {
  const input = snapshot({
    asOf: "2026-08-20",
    horizonEnd: "2026-08-28",
    availableBalanceCents: 30_000,
    protectedBufferCents: 10_000,
    incomeExpectations: [{
      id: "possible-client",
      label: "Possible recurring client payment",
      kind: "freelance_client",
      windowStart: "2026-08-18",
      expectedBy: "2026-08-23",
      graceDays: 2,
      minimumExpectedCents: 25_000,
      typicalExpectedCents: 40_000,
      confidence: "inferred"
    }],
    obligations: [{
      id: "rent",
      label: "Rent",
      due: "2026-08-25",
      amountCents: 45_000,
      priority: "protected"
    }]
  });

  const result = analyzeIncomeMonitoring(input);
  assert.equal(result.assessments[0]?.requiresUserConfirmation, true);
  assert.equal(result.coverage.conservativeEndingBalanceCents, -15_000);
  assert.equal(result.coverage.typicalEndingBalanceCents, 25_000);
  assert.equal(result.coverage.protectedObligationsAtRisk[0]?.projectedShortfallCents, 25_000);
});

test("a confirmed future minimum is counted conservatively but same-day bills remain first", () => {
  const input = snapshot({
    asOf: "2026-08-20",
    horizonEnd: "2026-08-25",
    availableBalanceCents: 35_000,
    protectedBufferCents: 5_000,
    incomeExpectations: [{
      id: "job-a",
      label: "Job A",
      kind: "hourly_job",
      windowStart: "2026-08-20",
      expectedBy: "2026-08-25",
      graceDays: 1,
      minimumExpectedCents: 50_000,
      typicalExpectedCents: 60_000,
      confidence: "user_confirmed"
    }],
    obligations: [{
      id: "rent",
      label: "Rent",
      due: "2026-08-25",
      amountCents: 40_000,
      priority: "protected"
    }]
  });

  const result = analyzeIncomeMonitoring(input);
  assert.equal(result.coverage.conservativeEndingBalanceCents, 45_000);
  assert.equal(result.coverage.conservativeLowestBalanceCents, -5_000);
  assert.equal(result.coverage.protectedObligationsAtRisk[0]?.obligationId, "rent");
});

test("the monitoring boundary rejects unknown income references and future observations", () => {
  const result = IncomeMonitoringSnapshotSchema.safeParse(snapshot({
    observedIncome: [{
      id: "unmatched-pay",
      sourceId: "unknown-source",
      receivedOn: "2026-08-22",
      amountCents: 10_000,
      matchConfidence: "inferred"
    }]
  }));

  assert.equal(result.success, false);
  if (!result.success) {
    assert.deepEqual(
      result.error.issues.map(({ path }) => path.join(".")),
      ["observedIncome.0.sourceId", "observedIncome.0.receivedOn"]
    );
  }
});

test("the monitoring boundary rejects duplicate opaque identifiers", () => {
  const repeatedExpectation = {
    id: "job-a",
    label: "Job A",
    kind: "hourly_job" as const,
    windowStart: "2026-08-15",
    expectedBy: "2026-08-22",
    graceDays: 1,
    minimumExpectedCents: 50_000,
    typicalExpectedCents: 65_000,
    confidence: "user_confirmed" as const
  };
  const result = IncomeMonitoringSnapshotSchema.safeParse(snapshot({
    incomeExpectations: [repeatedExpectation, repeatedExpectation]
  }));

  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.issues[0]?.path.join("."), "incomeExpectations");
  }
});

test("the monitoring boundary rejects impossible calendar dates", () => {
  const result = IncomeMonitoringSnapshotSchema.safeParse({
    ...snapshot(),
    asOf: "2026-02-30"
  });

  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.issues[0]?.path.join("."), "asOf");
  }
});
