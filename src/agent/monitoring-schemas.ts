import { z } from "zod";
import { IsoDateSchema } from "./schemas.js";

const MONEY_LIMIT_CENTS = 1_000_000_000;

const MonitoringDateSchema = IsoDateSchema.refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Use a valid calendar date in YYYY-MM-DD format");

export const MoneyCentsSchema = z.number().int().min(-MONEY_LIMIT_CENTS).max(MONEY_LIMIT_CENTS);
export const NonnegativeMoneyCentsSchema = z.number().int().min(0).max(MONEY_LIMIT_CENTS);
export const PositiveMoneyCentsSchema = z.number().int().positive().max(MONEY_LIMIT_CENTS);

export const IncomeSourceKindSchema = z.enum([
  "hourly_job",
  "salaried_job",
  "freelance_client",
  "benefit",
  "other"
]);

export const MonitoringConfidenceSchema = z.enum(["user_confirmed", "inferred"]);

export const IncomeExpectationSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  label: z.string().min(1).max(80),
  kind: IncomeSourceKindSchema,
  windowStart: MonitoringDateSchema,
  expectedBy: MonitoringDateSchema,
  graceDays: z.number().int().min(0).max(14).default(0),
  minimumExpectedCents: NonnegativeMoneyCentsSchema,
  typicalExpectedCents: NonnegativeMoneyCentsSchema,
  confidence: MonitoringConfidenceSchema
}).superRefine((expectation, context) => {
  if (expectation.windowStart > expectation.expectedBy) {
    context.addIssue({
      code: "custom",
      path: ["windowStart"],
      message: "The income window must begin on or before the expected date."
    });
  }
  if (expectation.typicalExpectedCents < expectation.minimumExpectedCents) {
    context.addIssue({
      code: "custom",
      path: ["typicalExpectedCents"],
      message: "The typical amount must be at least the minimum expected amount."
    });
  }
});

export const ObservedIncomeSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  sourceId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  receivedOn: MonitoringDateSchema,
  amountCents: PositiveMoneyCentsSchema,
  matchConfidence: MonitoringConfidenceSchema
});

export const MonitoredObligationSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  label: z.string().min(1).max(80),
  due: MonitoringDateSchema,
  amountCents: PositiveMoneyCentsSchema,
  priority: z.enum(["protected", "flexible"])
});

export const IncomeMonitoringSnapshotSchema = z.object({
  asOf: MonitoringDateSchema,
  horizonEnd: MonitoringDateSchema,
  availableBalanceCents: MoneyCentsSchema,
  protectedBufferCents: NonnegativeMoneyCentsSchema,
  incomeExpectations: z.array(IncomeExpectationSchema).max(100),
  observedIncome: z.array(ObservedIncomeSchema).max(500),
  obligations: z.array(MonitoredObligationSchema).max(500)
}).superRefine((snapshot, context) => {
  if (snapshot.horizonEnd < snapshot.asOf) {
    context.addIssue({
      code: "custom",
      path: ["horizonEnd"],
      message: "The monitoring horizon cannot end before the as-of date."
    });
  }

  const expectationIds = new Set(snapshot.incomeExpectations.map(({ id }) => id));
  if (expectationIds.size !== snapshot.incomeExpectations.length) {
    context.addIssue({
      code: "custom",
      path: ["incomeExpectations"],
      message: "Income expectation IDs must be unique within a snapshot."
    });
  }
  if (new Set(snapshot.observedIncome.map(({ id }) => id)).size !== snapshot.observedIncome.length) {
    context.addIssue({
      code: "custom",
      path: ["observedIncome"],
      message: "Observed income IDs must be unique within a snapshot."
    });
  }
  if (new Set(snapshot.obligations.map(({ id }) => id)).size !== snapshot.obligations.length) {
    context.addIssue({
      code: "custom",
      path: ["obligations"],
      message: "Obligation IDs must be unique within a snapshot."
    });
  }
  snapshot.observedIncome.forEach((income, index) => {
    if (!expectationIds.has(income.sourceId)) {
      context.addIssue({
        code: "custom",
        path: ["observedIncome", index, "sourceId"],
        message: "Observed income must reference an income expectation in this snapshot."
      });
    }
    if (income.receivedOn > snapshot.asOf) {
      context.addIssue({
        code: "custom",
        path: ["observedIncome", index, "receivedOn"],
        message: "Observed income cannot be dated after the snapshot."
      });
    }
  });
});

export const IncomeExpectationStatusSchema = z.enum([
  "pending",
  "grace_period",
  "met",
  "late",
  "reduced",
  "missing"
]);

export const IncomeExpectationAssessmentSchema = z.object({
  sourceId: z.string(),
  status: IncomeExpectationStatusSchema,
  expectedBy: MonitoringDateSchema,
  graceEnds: MonitoringDateSchema,
  minimumExpectedCents: NonnegativeMoneyCentsSchema,
  typicalExpectedCents: NonnegativeMoneyCentsSchema,
  receivedCents: NonnegativeMoneyCentsSchema,
  remainingToMinimumCents: NonnegativeMoneyCentsSchema,
  thresholdMetOn: MonitoringDateSchema.nullable(),
  requiresUserConfirmation: z.boolean()
});

export const IncomeDisruptionEventSchema = z.object({
  sourceId: z.string(),
  type: z.enum(["late_pending", "late_income", "reduced_income", "missing_income"]),
  active: z.boolean(),
  detectedOn: MonitoringDateSchema,
  expectedBy: MonitoringDateSchema,
  amountAtIssueCents: NonnegativeMoneyCentsSchema,
  requiresUserConfirmation: z.boolean()
});

export const ProtectedObligationRiskSchema = z.object({
  obligationId: z.string(),
  due: MonitoringDateSchema,
  projectedShortfallCents: PositiveMoneyCentsSchema,
  basis: z.literal("confirmed_minimum")
});

export const CoverageForecastSchema = z.object({
  asOf: MonitoringDateSchema,
  horizonEnd: MonitoringDateSchema,
  conservativeEndingBalanceCents: MoneyCentsSchema,
  typicalEndingBalanceCents: MoneyCentsSchema,
  conservativeLowestBalanceCents: MoneyCentsSchema,
  typicalLowestBalanceCents: MoneyCentsSchema,
  protectedObligationsAtRisk: z.array(ProtectedObligationRiskSchema)
});

export const IncomeMonitoringAnalysisSchema = z.object({
  assessments: z.array(IncomeExpectationAssessmentSchema),
  disruptions: z.array(IncomeDisruptionEventSchema),
  coverage: CoverageForecastSchema
});

export type IncomeExpectation = z.infer<typeof IncomeExpectationSchema>;
export type ObservedIncome = z.infer<typeof ObservedIncomeSchema>;
export type MonitoredObligation = z.infer<typeof MonitoredObligationSchema>;
export type IncomeMonitoringSnapshot = z.infer<typeof IncomeMonitoringSnapshotSchema>;
export type IncomeExpectationAssessment = z.infer<typeof IncomeExpectationAssessmentSchema>;
export type IncomeDisruptionEvent = z.infer<typeof IncomeDisruptionEventSchema>;
export type CoverageForecast = z.infer<typeof CoverageForecastSchema>;
export type IncomeMonitoringAnalysis = z.infer<typeof IncomeMonitoringAnalysisSchema>;
