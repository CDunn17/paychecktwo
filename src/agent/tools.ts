import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import {
  analyzeCashflow,
  compareOptions,
  evaluatePolicyRelief as calculatePolicyRelief,
  findPressurePoints,
  type CashflowAnalysis
} from "./calculations.js";
import { ComparisonOptionSchema, DisruptionSchema, IsoDateSchema, PolicyReliefOptionSchema } from "./schemas.js";
import type { PlanStore } from "./plan-store.js";

const SessionInput = z.object({
  sessionId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)
});

export interface FinancialToolObserver {
  onPrimaryAnalysis?: (analysis: CashflowAnalysis) => void;
  onMonitoringAnalysis?: () => void;
}

export function createFinancialTools(
  planStore: PlanStore,
  observer: FinancialToolObserver = {}
) {
  let monitoringAnalysisCalls = 0;
  const getFinancialSnapshot = tool({
    name: "get_financial_snapshot",
    description: "Load the authoritative balance, paycheck, buffer, payday, and bills for a Paycheck Two session. Always call this before analysis.",
    inputSchema: SessionInput,
    callback: ({ sessionId }) => planStore.get(sessionId)
  });

  const analyzePaycheckScenario = tool({
    name: "analyze_paycheck_scenario",
    description: "Run the one authoritative cash-flow calculation for this request. Omit disruption for ordinary planning, or include the user's delayed pay, reduced income, and unexpected expenses. Call exactly once.",
    inputSchema: SessionInput.extend({
      asOf: IsoDateSchema,
      disruption: DisruptionSchema.optional()
    }),
    callback: ({ sessionId, asOf, disruption }) => {
      const analysis = analyzeCashflow(planStore.get(sessionId), asOf, disruption);
      observer.onPrimaryAnalysis?.(analysis);
      return analysis;
    }
  });

  const analyzeIncomeMonitoring = tool({
    name: "analyze_income_monitoring",
    description: "Load the one authoritative, locally calculated income-monitoring analysis and application-owned case decision for this request. Call exactly once only when the request says monitoring analysis is available. The result contains no raw transaction history and cannot initiate an external action.",
    inputSchema: SessionInput,
    callback: ({ sessionId }) => {
      if (monitoringAnalysisCalls >= 1) {
        throw new Error("The authoritative monitoring analysis has already been retrieved for this request.");
      }
      monitoringAnalysisCalls += 1;
      const result = planStore.getMonitoringResult(sessionId);
      observer.onMonitoringAnalysis?.();
      return result;
    }
  });

  const identifyPressurePoints = tool({
    name: "identify_pressure_points",
    description: "Identify a reduced paycheck, shortfall, unusually large upcoming obligation, or dangerously low daily spending room from a deterministic scenario. Use this after a disruption when the user asks what should change, even if current pre-payday risk is stable.",
    inputSchema: SessionInput.extend({
      asOf: IsoDateSchema,
      disruption: DisruptionSchema.optional()
    }),
    callback: ({ sessionId, asOf, disruption }) => {
      const analysis = analyzeCashflow(planStore.get(sessionId), asOf, disruption);
      return { analysis, pressurePoints: findPressurePoints(analysis) };
    }
  });

  const comparePlanOptions = tool({
    name: "compare_plan_options",
    description: "Compare concrete ways to create breathing room. Use this when a disruption prompt asks what should change or requests multiple options. It calculates quantified impacts but never changes bills, transfers money, or contacts a biller.",
    inputSchema: SessionInput.extend({
      asOf: IsoDateSchema,
      disruption: DisruptionSchema.optional(),
      options: z.array(ComparisonOptionSchema).min(1).max(6)
    }),
    callback: ({ sessionId, asOf, disruption, options }) => {
      const plan = planStore.get(sessionId);
      const analysis = analyzeCashflow(plan, asOf, disruption);
      return { baseline: analysis, comparisons: compareOptions(plan, analysis, options) };
    }
  });

  const evaluatePolicyRelief = tool({
    name: "evaluate_policy_relief",
    description: "Conditionally calculate how a reviewed policy could change an unexpected expense. This is a what-if calculation and never claims that a waiver or benefit was granted.",
    inputSchema: SessionInput.extend({
      asOf: IsoDateSchema,
      disruption: DisruptionSchema,
      options: z.array(PolicyReliefOptionSchema).min(1).max(6)
    }),
    callback: ({ sessionId, asOf, disruption, options }) => {
      const plan = planStore.get(sessionId);
      const baseline = analyzeCashflow(plan, asOf, disruption);
      return {
        baseline,
        conditionalOptions: calculatePolicyRelief(baseline, disruption, planStore.getPolicySources(sessionId), options)
      };
    }
  });

  return [
    getFinancialSnapshot,
    analyzeIncomeMonitoring,
    analyzePaycheckScenario,
    identifyPressurePoints,
    comparePlanOptions,
    evaluatePolicyRelief
  ];
}
