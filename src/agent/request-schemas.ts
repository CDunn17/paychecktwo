import { z } from "zod";
import { MonitoringDateSchema } from "./monitoring-schemas.js";
import { RecurringIncomeInferenceRequestSchema } from "./recurring-income-schemas.js";
import { PlanningAgentRequestSchema, PlanningSafetyPreviewRequestSchema } from "./schemas.js";

export const MonitoringRequestContextSchema = z.object({
  history: RecurringIncomeInferenceRequestSchema,
  horizonEnd: MonitoringDateSchema,
  protectedBillIds: z.array(z.string().min(1)).max(200)
});

function validateMonitoringDates(
  request: {
    asOf?: string;
    plan?: { bills: Array<{ id: string }> };
    monitoring?: z.infer<typeof MonitoringRequestContextSchema>;
  },
  context: z.RefinementCtx
): void {
  if (!request.monitoring) return;
  if (!request.asOf) {
    context.addIssue({
      code: "custom",
      path: ["asOf"],
      message: "A deterministic as-of date is required for monitoring."
    });
    return;
  }
  if (request.monitoring.history.historyEnd !== request.asOf) {
    context.addIssue({
      code: "custom",
      path: ["monitoring", "history", "historyEnd"],
      message: "Monitoring history must end on the request as-of date."
    });
  }
  if (request.monitoring.horizonEnd < request.asOf) {
    context.addIssue({
      code: "custom",
      path: ["monitoring", "horizonEnd"],
      message: "The monitoring horizon cannot end before the request as-of date."
    });
  }
  const billIds = new Set(request.plan?.bills.map(({ id }) => id) ?? []);
  request.monitoring.protectedBillIds.forEach((billId, index) => {
    if (!billIds.has(billId)) {
      context.addIssue({
        code: "custom",
        path: ["monitoring", "protectedBillIds", index],
        message: "Every protected obligation must reference a bill in the supplied plan."
      });
    }
  });
  if (new Set(request.monitoring.protectedBillIds).size !== request.monitoring.protectedBillIds.length) {
    context.addIssue({
      code: "custom",
      path: ["monitoring", "protectedBillIds"],
      message: "Protected bill IDs must be unique."
    });
  }
}

export const SafetyPreviewRequestSchema = PlanningSafetyPreviewRequestSchema.extend({
  monitoring: MonitoringRequestContextSchema.optional()
}).superRefine(validateMonitoringDates);

export const AgentRequestSchema = PlanningAgentRequestSchema.extend({
  monitoring: MonitoringRequestContextSchema.optional()
}).superRefine(validateMonitoringDates);

export type MonitoringRequestContext = z.infer<typeof MonitoringRequestContextSchema>;
export type SafetyPreviewRequest = z.infer<typeof SafetyPreviewRequestSchema>;
export type AgentRequest = z.infer<typeof AgentRequestSchema>;
