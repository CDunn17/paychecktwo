import { z } from "zod";
import {
  IncomeMonitoringAnalysisSchema,
  type IncomeMonitoringAnalysis
} from "./monitoring-schemas.js";
import {
  MonitoringCaseDecisionSchema,
  type MonitoringCaseDecision
} from "./schemas.js";

export const MonitoringSourceSummarySchema = z.object({
  sourceId: z.string().regex(/^income-source-[1-9][0-9]*$/),
  label: z.string().regex(/^Income source [1-9][0-9]*$/),
  kind: z.enum(["hourly_job", "salaried_job", "freelance_client", "benefit", "other"]),
  cadence: z.enum(["weekly", "biweekly", "semimonthly", "monthly"]),
  patternStatus: z.enum(["inferred", "user_confirmed", "user_corrected"]),
  requiresUserConfirmation: z.boolean()
});

export const MonitoringToolResultSchema = z.object({
  sources: z.array(MonitoringSourceSummarySchema).max(100),
  analysis: IncomeMonitoringAnalysisSchema,
  caseDecision: MonitoringCaseDecisionSchema
});

export type MonitoringToolResult = z.infer<typeof MonitoringToolResultSchema>;

export function decideMonitoringCase(analysisInput: IncomeMonitoringAnalysis): MonitoringCaseDecision {
  const analysis = IncomeMonitoringAnalysisSchema.parse(analysisInput);
  const activeDisruptions = analysis.disruptions.filter(({ active }) => active);
  const uncertainDisruptions = activeDisruptions.filter(({ requiresUserConfirmation }) => requiresUserConfirmation);
  const unconfirmedAssessments = analysis.assessments.filter(({ requiresUserConfirmation }) => requiresUserConfirmation);
  const atRiskCount = analysis.coverage.protectedObligationsAtRisk.length;

  if (uncertainDisruptions.length > 0 || (atRiskCount > 0 && unconfirmedAssessments.length > 0)) {
    return MonitoringCaseDecisionSchema.parse({
      disposition: "needs_confirmation",
      shouldOpenCase: true,
      reasonCodes: [
        "unconfirmed_income_signal",
        ...(atRiskCount > 0 ? ["protected_obligation_risk" as const] : [])
      ],
      activeDisruptionCount: activeDisruptions.length,
      uncertainDisruptionCount: uncertainDisruptions.length,
      protectedObligationRiskCount: atRiskCount
    });
  }

  if (atRiskCount > 0) {
    return MonitoringCaseDecisionSchema.parse({
      disposition: "open_case",
      shouldOpenCase: true,
      reasonCodes: ["protected_obligation_risk"],
      activeDisruptionCount: activeDisruptions.length,
      uncertainDisruptionCount: 0,
      protectedObligationRiskCount: atRiskCount
    });
  }

  return MonitoringCaseDecisionSchema.parse({
    disposition: "no_case",
    shouldOpenCase: false,
    reasonCodes: ["no_material_or_uncertain_disruption"],
    activeDisruptionCount: activeDisruptions.length,
    uncertainDisruptionCount: uncertainDisruptions.length,
    protectedObligationRiskCount: 0
  });
}
