import test from "node:test";
import assert from "node:assert/strict";
import { prepareMonitoringToolResult } from "../src/agent/monitoring-context.js";
import { decideMonitoringCase } from "../src/agent/monitoring-policy.js";
import { AgentRequestSchema } from "../src/agent/request-schemas.js";
import { FinancialPlanSchema } from "../src/agent/schemas.js";

const history = {
  historyStart: "2026-07-01",
  historyEnd: "2026-08-17",
  transactions: [
    { id: "event-1", sourceAlias: "source-a", occurredOn: "2026-07-06", amountCents: 62_000, direction: "credit" as const, classification: "income_candidate" as const, provenance: "synthetic_fixture" as const },
    { id: "event-2", sourceAlias: "source-a", occurredOn: "2026-07-13", amountCents: 70_000, direction: "credit" as const, classification: "income_candidate" as const, provenance: "synthetic_fixture" as const },
    { id: "event-3", sourceAlias: "source-a", occurredOn: "2026-07-20", amountCents: 50_000, direction: "credit" as const, classification: "income_candidate" as const, provenance: "synthetic_fixture" as const },
    { id: "event-4", sourceAlias: "source-a", occurredOn: "2026-07-27", amountCents: 66_000, direction: "credit" as const, classification: "income_candidate" as const, provenance: "synthetic_fixture" as const }
  ],
  overrides: []
};

const plan = FinancialPlanSchema.parse({
  name: "Synthetic user",
  balance: 300,
  paycheck: 1_000,
  buffer: 100,
  payday: "2026-08-28",
  bills: [
    { id: "rent", name: "Rent", amount: 400, due: "2026-08-20", category: "Housing" },
    { id: "streaming", name: "Streaming", amount: 20, due: "2026-08-21", category: "Entertainment" }
  ]
});

test("prepares a minimized Strands result and opens a provisional case for an uncertain disruption", () => {
  const result = prepareMonitoringToolResult(plan, "2026-08-17", {
    history,
    horizonEnd: "2026-08-25",
    protectedBillIds: ["rent"]
  });
  const serialized = JSON.stringify(result);

  assert.equal(result.sources[0]?.sourceId, "income-source-1");
  assert.equal(result.sources[0]?.label, "Income source 1");
  assert.equal(result.analysis.assessments[0]?.status, "missing");
  assert.equal(result.analysis.coverage.protectedObligationsAtRisk[0]?.obligationId, "obligation-1");
  assert.equal(result.caseDecision.disposition, "needs_confirmation");
  assert.equal(result.caseDecision.shouldOpenCase, true);
  assert.deepEqual(result.caseDecision.reasonCodes, ["unconfirmed_income_signal", "protected_obligation_risk"]);
  assert.equal(serialized.includes("source-a"), false);
  assert.equal(serialized.includes("event-1"), false);
  assert.equal(serialized.includes("Rent"), false);
  assert.equal(serialized.includes("Streaming"), false);
});

test("confirmed material risk opens a case while a non-material confirmed disruption does not", () => {
  const confirmed = prepareMonitoringToolResult(plan, "2026-08-17", {
    history: {
      ...history,
      overrides: [{ sourceAlias: "source-a", action: "confirm" as const, kind: "hourly_job" as const }]
    },
    horizonEnd: "2026-08-25",
    protectedBillIds: ["rent"]
  });
  assert.equal(confirmed.caseDecision.disposition, "open_case");
  assert.deepEqual(confirmed.caseDecision.reasonCodes, ["protected_obligation_risk"]);

  const noMaterialRisk = decideMonitoringCase({
    ...confirmed.analysis,
    coverage: {
      ...confirmed.analysis.coverage,
      protectedObligationsAtRisk: []
    }
  });
  assert.equal(noMaterialRisk.disposition, "no_case");
  assert.equal(noMaterialRisk.shouldOpenCase, false);
  assert.deepEqual(noMaterialRisk.reasonCodes, ["no_material_or_uncertain_disruption"]);
});

test("monitoring request schema requires aligned dates and explicit protected obligations", () => {
  const base = {
    sessionId: "monitor-test",
    message: "Review the monitoring signal.",
    plan,
    asOf: "2026-08-17",
    policySources: [],
    privacy: { consentToModel: true as const, ephemeral: true },
    monitoring: {
      history,
      horizonEnd: "2026-08-25",
      protectedBillIds: ["rent"]
    }
  };
  assert.equal(AgentRequestSchema.safeParse(base).success, true);

  const invalid = AgentRequestSchema.safeParse({
    ...base,
    asOf: "2026-08-18",
    monitoring: { ...base.monitoring, protectedBillIds: ["unknown"] }
  });
  assert.equal(invalid.success, false);
  if (!invalid.success) {
    assert.deepEqual(invalid.error.issues.map(({ path }) => path.join(".")), [
      "monitoring.history.historyEnd",
      "monitoring.protectedBillIds.0"
    ]);
  }
});
