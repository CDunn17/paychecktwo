import { z } from "zod";
import {
  IncomeSourceKindSchema,
  MonitoringDateSchema,
  NonnegativeMoneyCentsSchema,
  PositiveMoneyCentsSchema
} from "./monitoring-schemas.js";

const OpaqueIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);

export const NormalizedTransactionClassificationSchema = z.enum([
  "income_candidate",
  "reimbursement",
  "transfer",
  "unknown"
]);

export const NormalizedSyntheticTransactionSchema = z.object({
  id: OpaqueIdSchema,
  occurredOn: MonitoringDateSchema,
  amountCents: PositiveMoneyCentsSchema,
  direction: z.enum(["credit", "debit"]),
  sourceAlias: OpaqueIdSchema,
  classification: NormalizedTransactionClassificationSchema,
  provenance: z.literal("synthetic_fixture")
});

export const IncomeCadenceSchema = z.enum([
  "weekly",
  "biweekly",
  "semimonthly",
  "monthly",
  "irregular"
]);

const ConfirmPatternOverrideSchema = z.object({
  sourceAlias: OpaqueIdSchema,
  action: z.literal("confirm"),
  kind: IncomeSourceKindSchema
});

const CorrectPatternOverrideSchema = z.object({
  sourceAlias: OpaqueIdSchema,
  action: z.literal("correct"),
  kind: IncomeSourceKindSchema,
  cadence: IncomeCadenceSchema.exclude(["irregular"]),
  minimumExpectedCents: NonnegativeMoneyCentsSchema,
  typicalExpectedCents: NonnegativeMoneyCentsSchema,
  nextExpectedDate: MonitoringDateSchema,
  graceDays: z.number().int().min(0).max(14)
}).superRefine((override, context) => {
  if (override.typicalExpectedCents < override.minimumExpectedCents) {
    context.addIssue({
      code: "custom",
      path: ["typicalExpectedCents"],
      message: "The corrected typical amount must be at least the corrected minimum."
    });
  }
});

const RejectPatternOverrideSchema = z.object({
  sourceAlias: OpaqueIdSchema,
  action: z.literal("reject")
});

export const IncomePatternOverrideSchema = z.discriminatedUnion("action", [
  ConfirmPatternOverrideSchema,
  CorrectPatternOverrideSchema,
  RejectPatternOverrideSchema
]);

export const RecurringIncomeInferenceRequestSchema = z.object({
  historyStart: MonitoringDateSchema,
  historyEnd: MonitoringDateSchema,
  transactions: z.array(NormalizedSyntheticTransactionSchema).max(1_000),
  overrides: z.array(IncomePatternOverrideSchema).max(100).default([])
}).superRefine((request, context) => {
  if (request.historyEnd < request.historyStart) {
    context.addIssue({
      code: "custom",
      path: ["historyEnd"],
      message: "The history cannot end before it starts."
    });
  } else {
    const start = new Date(`${request.historyStart}T00:00:00.000Z`).getTime();
    const end = new Date(`${request.historyEnd}T00:00:00.000Z`).getTime();
    if ((end - start) / 86_400_000 > 180) {
      context.addIssue({
        code: "custom",
        path: ["historyStart"],
        message: "Recurring-income inference is limited to 180 days of history."
      });
    }
  }

  if (new Set(request.transactions.map(({ id }) => id)).size !== request.transactions.length) {
    context.addIssue({
      code: "custom",
      path: ["transactions"],
      message: "Normalized transaction IDs must be unique."
    });
  }
  if (new Set(request.overrides.map(({ sourceAlias }) => sourceAlias)).size !== request.overrides.length) {
    context.addIssue({
      code: "custom",
      path: ["overrides"],
      message: "Only one user override is allowed per source alias."
    });
  }
  const candidateSources = new Set(request.transactions
    .filter(({ direction, classification }) => direction === "credit" && classification === "income_candidate")
    .map(({ sourceAlias }) => sourceAlias));
  if (candidateSources.size > 100) {
    context.addIssue({
      code: "custom",
      path: ["transactions"],
      message: "Recurring-income inference is limited to 100 candidate sources."
    });
  }

  request.transactions.forEach((transaction, index) => {
    if (transaction.occurredOn < request.historyStart || transaction.occurredOn > request.historyEnd) {
      context.addIssue({
        code: "custom",
        path: ["transactions", index, "occurredOn"],
        message: "Every normalized transaction must fall inside the bounded history window."
      });
    }
  });
});

export const RecurringIncomeEvidenceCodeSchema = z.enum([
  "minimum_observations_met",
  "insufficient_observations",
  "cadence_consistent",
  "cadence_irregular",
  "amounts_stable",
  "amounts_variable",
  "user_confirmed",
  "user_corrected"
]);

export const RecurringIncomePatternSchema = z.object({
  sourceAlias: OpaqueIdSchema,
  status: z.enum(["inferred", "user_confirmed", "user_corrected"]),
  kind: IncomeSourceKindSchema,
  cadence: IncomeCadenceSchema,
  inferenceConfidence: z.enum(["low", "medium", "high", "user_confirmed"]),
  requiresUserConfirmation: z.boolean(),
  eligibleForMonitoring: z.boolean(),
  observationCount: z.number().int().min(1).max(1_000),
  minimumExpectedCents: NonnegativeMoneyCentsSchema,
  typicalExpectedCents: NonnegativeMoneyCentsSchema,
  observedMinimumCents: NonnegativeMoneyCentsSchema,
  observedMaximumCents: NonnegativeMoneyCentsSchema,
  medianIntervalDays: z.number().int().nonnegative().nullable(),
  intervalSpreadDays: z.number().int().nonnegative().nullable(),
  nextExpectedDate: MonitoringDateSchema.nullable(),
  graceDays: z.number().int().min(0).max(14),
  provenance: z.object({
    method: z.literal("recurring_credit_v1"),
    historyStart: MonitoringDateSchema,
    historyEnd: MonitoringDateSchema,
    firstObservedOn: MonitoringDateSchema,
    lastObservedOn: MonitoringDateSchema,
    transactionIds: z.array(OpaqueIdSchema).min(1).max(1_000),
    evidenceCodes: z.array(RecurringIncomeEvidenceCodeSchema).min(1)
  })
});

export const IncomePatternDecisionSchema = z.object({
  sourceAlias: OpaqueIdSchema,
  action: z.enum(["confirm", "correct", "reject"]),
  applied: z.literal(true)
});

export const RecurringIncomeInferenceResultSchema = z.object({
  historyStart: MonitoringDateSchema,
  historyEnd: MonitoringDateSchema,
  patterns: z.array(RecurringIncomePatternSchema).max(100),
  decisions: z.array(IncomePatternDecisionSchema).max(100),
  ignoredTransactionCounts: z.object({
    reimbursement: z.number().int().nonnegative(),
    transfer: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
    debit: z.number().int().nonnegative()
  }),
  insufficientHistorySourceCount: z.number().int().nonnegative()
});

export type NormalizedSyntheticTransaction = z.infer<typeof NormalizedSyntheticTransactionSchema>;
export type IncomeCadence = z.infer<typeof IncomeCadenceSchema>;
export type IncomePatternOverride = z.infer<typeof IncomePatternOverrideSchema>;
export type RecurringIncomeInferenceRequest = z.input<typeof RecurringIncomeInferenceRequestSchema>;
export type ParsedRecurringIncomeInferenceRequest = z.output<typeof RecurringIncomeInferenceRequestSchema>;
export type RecurringIncomePattern = z.infer<typeof RecurringIncomePatternSchema>;
export type RecurringIncomeInferenceResult = z.infer<typeof RecurringIncomeInferenceResultSchema>;
