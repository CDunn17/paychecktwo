import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import { analyzeCashflow, compareOptions, evaluatePolicyRelief as calculatePolicyRelief, findPressurePoints } from "./calculations.js";
import { ComparisonOptionSchema, DisruptionSchema, IsoDateSchema, PolicyReliefOptionSchema } from "./schemas.js";
import type { PlanStore } from "./plan-store.js";

const SessionInput = z.object({
  sessionId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)
});

export function createFinancialTools(planStore: PlanStore) {
  const getFinancialSnapshot = tool({
    name: "get_financial_snapshot",
    description: "Load the authoritative balance, paycheck, buffer, payday, and bills for a Paycheck Two session. Always call this before analysis.",
    inputSchema: SessionInput,
    callback: ({ sessionId }) => planStore.get(sessionId)
  });

  const buildCashflowTimeline = tool({
    name: "build_cashflow_timeline",
    description: "Deterministically calculate obligations, safe-to-spend, daily flexible room, and risk through payday for the current plan.",
    inputSchema: SessionInput.extend({ asOf: IsoDateSchema }),
    callback: ({ sessionId, asOf }) => analyzeCashflow(planStore.get(sessionId), asOf)
  });

  const simulateDisruption = tool({
    name: "simulate_disruption",
    description: "Run a deterministic what-if scenario involving a delayed or smaller paycheck and unexpected expenses. Use this whenever the user describes a possible disruption.",
    inputSchema: SessionInput.extend({
      asOf: IsoDateSchema,
      disruption: DisruptionSchema
    }),
    callback: ({ sessionId, asOf, disruption }) => analyzeCashflow(planStore.get(sessionId), asOf, disruption)
  });

  const identifyPressurePoints = tool({
    name: "identify_pressure_points",
    description: "Identify a shortfall, an unusually large upcoming obligation, or dangerously low daily spending room from a deterministic scenario.",
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
    description: "Compare concrete ways to create breathing room. It calculates impact but never changes bills, transfers money, or contacts a biller.",
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

  return [getFinancialSnapshot, buildCashflowTimeline, simulateDisruption, identifyPressurePoints, comparePlanOptions, evaluatePolicyRelief];
}
