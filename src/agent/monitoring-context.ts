import { analyzeIncomeMonitoring } from "./income-monitoring.js";
import { MonitoringToolResultSchema, decideMonitoringCase, type MonitoringToolResult } from "./monitoring-policy.js";
import { IncomeMonitoringSnapshotSchema, type IncomeExpectation } from "./monitoring-schemas.js";
import { inferRecurringIncome, patternsToIncomeExpectations } from "./recurring-income.js";
import type { FinancialPlan } from "./schemas.js";
import type { MonitoringRequestContext } from "./request-schemas.js";

function dollarsToCents(value: number): number {
  return Math.round(value * 100);
}

export function prepareMonitoringToolResult(
  plan: FinancialPlan,
  asOf: string,
  monitoring: MonitoringRequestContext
): MonitoringToolResult {
  const inference = inferRecurringIncome(monitoring.history);
  const originalExpectations = patternsToIncomeExpectations(inference.patterns);
  const incomeExpectations: IncomeExpectation[] = originalExpectations.map((expectation, index) => {
    const sourceId = `income-source-${index + 1}`;
    return {
      ...expectation,
      id: sourceId,
      label: `Income source ${index + 1}`
    };
  });
  const snapshot = IncomeMonitoringSnapshotSchema.parse({
    asOf,
    horizonEnd: monitoring.horizonEnd,
    availableBalanceCents: dollarsToCents(plan.balance),
    protectedBufferCents: dollarsToCents(plan.buffer),
    incomeExpectations,
    observedIncome: [],
    obligations: plan.bills.map((bill, index) => ({
      id: `obligation-${index + 1}`,
      label: `Obligation ${index + 1}`,
      due: bill.due,
      amountCents: dollarsToCents(bill.amount),
      priority: monitoring.protectedBillIds.includes(bill.id) ? "protected" : "flexible"
    })).filter(({ amountCents }) => amountCents > 0)
  });
  const analysis = analyzeIncomeMonitoring(snapshot);
  const patternsByAlias = new Map(inference.patterns.map((pattern) => [pattern.sourceAlias, pattern]));

  return MonitoringToolResultSchema.parse({
    sources: originalExpectations.map((expectation, index) => {
      const pattern = patternsByAlias.get(expectation.id);
      if (!pattern || pattern.cadence === "irregular") {
        throw new Error("Eligible monitoring source is missing its recurring-income pattern.");
      }
      return {
        sourceId: `income-source-${index + 1}`,
        label: `Income source ${index + 1}`,
        kind: pattern.kind,
        cadence: pattern.cadence,
        patternStatus: pattern.status,
        requiresUserConfirmation: pattern.requiresUserConfirmation
      };
    }),
    analysis,
    caseDecision: decideMonitoringCase(analysis)
  });
}
