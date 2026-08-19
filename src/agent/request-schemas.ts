import { z } from "zod";
import { MonitoringDateSchema } from "./monitoring-schemas.js";
import { RecurringIncomeInferenceRequestSchema } from "./recurring-income-schemas.js";
import {
  SyntheticEventStreamSchema,
  finalSyntheticCheckpointDate
} from "./synthetic-event-stream.js";
import {
  PlanningAgentRequestSchema,
  PlanningSafetyPreviewRequestSchema,
  ResolutionCaseSchema,
  ResolutionOutcomeConfirmationSchema
} from "./schemas.js";

export const MonitoringRequestContextSchema = z.object({
  history: RecurringIncomeInferenceRequestSchema,
  horizonEnd: MonitoringDateSchema,
  protectedBillIds: z.array(z.string().min(1)).max(200)
});

export const ResolutionCaseContinuationSchema = z.object({
  provenance: z.literal("synthetic_fixture"),
  priorCase: ResolutionCaseSchema,
  expectedVersion: z.number().int().positive(),
  outcomeConfirmation: ResolutionOutcomeConfirmationSchema
}).strict();

function validateMonitoringDates(
  request: {
    asOf?: string;
    plan?: { bills: Array<{ id: string; due?: string }> };
    monitoring?: z.infer<typeof MonitoringRequestContextSchema>;
    caseContinuation?: z.infer<typeof ResolutionCaseContinuationSchema>;
    syntheticEventStream?: z.infer<typeof SyntheticEventStreamSchema>;
  },
  context: z.RefinementCtx
): void {
  if (request.monitoring && request.syntheticEventStream) {
    context.addIssue({
      code: "custom",
      path: ["syntheticEventStream"],
      message: "Supply either normalized monitoring history or a synthetic event stream, not both."
    });
  }
  if (request.caseContinuation && !request.monitoring) {
    context.addIssue({
      code: "custom",
      path: ["caseContinuation"],
      message: "Synthetic case continuation requires current monitoring evidence."
    });
  }
  if (request.syntheticEventStream) {
    if (!request.asOf) {
      context.addIssue({
        code: "custom",
        path: ["asOf"],
        message: "A deterministic as-of date is required for a synthetic event stream."
      });
    } else if (finalSyntheticCheckpointDate(request.syntheticEventStream) !== request.asOf) {
      context.addIssue({
        code: "custom",
        path: ["asOf"],
        message: "The request as-of date must match the stream's final monitoring checkpoint."
      });
    }
    const billIds = new Set(request.plan?.bills.map(({ id }) => id) ?? []);
    const finalCheckpoint = finalSyntheticCheckpointDate(request.syntheticEventStream);
    request.plan?.bills.forEach((bill, index) => {
      if (finalCheckpoint && bill.due && bill.due < finalCheckpoint) {
        context.addIssue({
          code: "custom",
          path: ["plan", "bills", index, "due"],
          message: "Stream replay requires plan obligations to remain current at the final checkpoint."
        });
      }
    });
    request.syntheticEventStream.protectedBillIds.forEach((billId, index) => {
      if (!billIds.has(billId)) {
        context.addIssue({
          code: "custom",
          path: ["syntheticEventStream", "protectedBillIds", index],
          message: "Every stream-protected obligation must reference a bill in the supplied plan."
        });
      }
    });
  }
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
  if (request.caseContinuation) {
    if (request.caseContinuation.priorCase.status !== "monitoring") {
      context.addIssue({
        code: "custom",
        path: ["caseContinuation", "priorCase", "status"],
        message: "Synthetic completion review requires a case in the monitoring state."
      });
    }
    if (request.caseContinuation.expectedVersion !== request.caseContinuation.priorCase.version) {
      context.addIssue({
        code: "custom",
        path: ["caseContinuation", "expectedVersion"],
        message: "The expected case version must match the supplied prior case."
      });
    }
    if (request.asOf && request.asOf < request.caseContinuation.priorCase.updatedOn) {
      context.addIssue({
        code: "custom",
        path: ["asOf"],
        message: "Completion review cannot predate the prior case update."
      });
    }
  }
}

export const SafetyPreviewRequestSchema = PlanningSafetyPreviewRequestSchema.extend({
  monitoring: MonitoringRequestContextSchema.optional(),
  caseContinuation: ResolutionCaseContinuationSchema.optional(),
  syntheticEventStream: SyntheticEventStreamSchema.optional()
}).superRefine(validateMonitoringDates);

export const AgentRequestSchema = PlanningAgentRequestSchema.extend({
  monitoring: MonitoringRequestContextSchema.optional(),
  caseContinuation: ResolutionCaseContinuationSchema.optional(),
  syntheticEventStream: SyntheticEventStreamSchema.optional()
}).superRefine(validateMonitoringDates);

export type MonitoringRequestContext = z.infer<typeof MonitoringRequestContextSchema>;
export type ResolutionCaseContinuation = z.infer<typeof ResolutionCaseContinuationSchema>;
export type SafetyPreviewRequest = z.infer<typeof SafetyPreviewRequestSchema>;
export type AgentRequest = z.infer<typeof AgentRequestSchema>;
