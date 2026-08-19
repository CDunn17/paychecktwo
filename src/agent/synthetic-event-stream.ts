import { z } from "zod";
import { analyzeIncomeMonitoring } from "./income-monitoring.js";
import {
  IncomeExpectationSchema,
  IncomeSourceKindSchema,
  MonitoringConfidenceSchema,
  MonitoringDateSchema,
  PositiveMoneyCentsSchema
} from "./monitoring-schemas.js";
import { decideMonitoringCase, MonitoringToolResultSchema, type MonitoringToolResult } from "./monitoring-policy.js";
import { openResolutionCase, transitionResolutionCase } from "./resolution-case.js";
import {
  FinancialPlanSchema,
  ResolutionOutcomeConfirmationSchema,
  SyntheticEventStreamSummarySchema,
  type FinancialPlan,
  type ResolutionCase,
  type ResolutionOutcomeConfirmation,
  type SyntheticEventStreamSummary
} from "./schemas.js";

const StreamIdSchema = z.string().regex(/^stream-[a-z0-9-]{1,64}$/);
const EventIdSchema = z.string().regex(/^stream-event-[1-9][0-9]*$/);
const SourceIdSchema = z.string().regex(/^income-source-[1-9][0-9]*$/);

export const SyntheticEventStreamSourceSchema = IncomeExpectationSchema.safeExtend({
  id: SourceIdSchema,
  label: z.string().regex(/^Income source [1-9][0-9]*$/),
  kind: IncomeSourceKindSchema,
  cadence: z.enum(["weekly", "biweekly", "semimonthly", "monthly"]),
  confidence: MonitoringConfidenceSchema
}).strict();

const EventBase = {
  eventId: EventIdSchema,
  occurredOn: MonitoringDateSchema
};

export const SyntheticEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...EventBase,
    type: z.literal("income_observed"),
    sourceId: SourceIdSchema,
    amountCents: PositiveMoneyCentsSchema,
    matchConfidence: MonitoringConfidenceSchema,
    provenance: z.literal("synthetic_fixture")
  }).strict(),
  z.object({
    ...EventBase,
    type: z.literal("monitoring_checkpoint"),
    horizonEnd: MonitoringDateSchema
  }).strict(),
  z.object({ ...EventBase, type: z.literal("case_options_calculated") }).strict(),
  z.object({ ...EventBase, type: z.literal("case_options_presented") }).strict(),
  z.object({
    ...EventBase,
    type: z.literal("case_decision_recorded"),
    selectedOptionId: z.string().regex(/^option-[a-z0-9-]{1,64}$/)
  }).strict(),
  z.object({ ...EventBase, type: z.literal("case_follow_up_started") }).strict(),
  z.object({
    ...EventBase,
    type: z.literal("case_escalation_required"),
    reason: z.enum(["risk_worsened", "deadline_missed", "required_service_unavailable", "outside_agent_scope"])
  }).strict(),
  z.object({
    ...EventBase,
    type: z.literal("outcome_confirmation"),
    outcomeConfirmation: ResolutionOutcomeConfirmationSchema
  }).strict()
]);

export const SyntheticEventStreamSchema = z.object({
  streamId: StreamIdSchema,
  provenance: z.literal("synthetic_fixture"),
  streamStart: MonitoringDateSchema,
  sources: z.array(SyntheticEventStreamSourceSchema).min(2).max(12),
  protectedBillIds: z.array(z.string().min(1)).max(200),
  events: z.array(SyntheticEventSchema).min(2).max(64)
}).strict().superRefine((stream, context) => {
  const sourceIds = new Set(stream.sources.map(({ id }) => id));
  if (sourceIds.size !== stream.sources.length) {
    context.addIssue({ code: "custom", path: ["sources"], message: "Synthetic stream source IDs must be unique." });
  }
  stream.sources.forEach((source, index) => {
    const sourceNumber = source.id.slice("income-source-".length);
    if (source.label !== `Income source ${sourceNumber}`) {
      context.addIssue({
        code: "custom",
        path: ["sources", index, "label"],
        message: "Synthetic source labels must match their generic source IDs."
      });
    }
  });
  if (new Set(stream.protectedBillIds).size !== stream.protectedBillIds.length) {
    context.addIssue({ code: "custom", path: ["protectedBillIds"], message: "Protected bill IDs must be unique." });
  }
  const eventIds = new Set<string>();
  let previousDate = stream.streamStart;
  let checkpointCount = 0;
  let outcomeCount = 0;
  stream.events.forEach((event, index) => {
    if (eventIds.has(event.eventId)) {
      context.addIssue({ code: "custom", path: ["events", index, "eventId"], message: "Synthetic event IDs must be unique." });
    }
    eventIds.add(event.eventId);
    if (event.occurredOn < stream.streamStart || event.occurredOn < previousDate) {
      context.addIssue({ code: "custom", path: ["events", index, "occurredOn"], message: "Synthetic events must be ordered within the stream window." });
    }
    previousDate = event.occurredOn;
    if (event.type === "income_observed" && !sourceIds.has(event.sourceId)) {
      context.addIssue({ code: "custom", path: ["events", index, "sourceId"], message: "Observed income must reference a stream source." });
    }
    if (event.type === "monitoring_checkpoint") {
      checkpointCount += 1;
      if (event.horizonEnd < event.occurredOn) {
        context.addIssue({ code: "custom", path: ["events", index, "horizonEnd"], message: "A checkpoint horizon cannot precede its date." });
      }
    }
    if (event.type === "outcome_confirmation") {
      outcomeCount += 1;
      if (index !== stream.events.length - 1) {
        context.addIssue({ code: "custom", path: ["events", index], message: "Outcome confirmation must be the final synthetic event." });
      }
    }
  });
  if (checkpointCount < 2) {
    context.addIssue({ code: "custom", path: ["events"], message: "A synthetic stream requires at least two monitoring checkpoints." });
  }
  if (outcomeCount > 1) {
    context.addIssue({ code: "custom", path: ["events"], message: "A synthetic stream can contain at most one outcome confirmation." });
  }
  const lastEvent = stream.events.at(-1);
  const finalStateEvent = lastEvent?.type === "outcome_confirmation"
    ? stream.events.at(-2)
    : lastEvent;
  if (finalStateEvent?.type !== "monitoring_checkpoint") {
    context.addIssue({
      code: "custom",
      path: ["events"],
      message: "The final state-producing event must be a monitoring checkpoint."
    });
  }
  const lastDate = stream.events.at(-1)?.occurredOn ?? stream.streamStart;
  const spanDays = Math.round((Date.parse(`${lastDate}T00:00:00.000Z`) - Date.parse(`${stream.streamStart}T00:00:00.000Z`)) / 86_400_000);
  if (spanDays > 90) {
    context.addIssue({ code: "custom", path: ["events"], message: "A synthetic stream cannot span more than 90 days." });
  }
});

export type SyntheticEventStream = z.infer<typeof SyntheticEventStreamSchema>;

export type SyntheticEventStreamReplayErrorCode =
  | "case_event_without_case"
  | "completion_candidate_not_eligible"
  | "missing_final_checkpoint"
  | "unknown_protected_bill"
  | "unsupported_past_obligation";

export class SyntheticEventStreamReplayError extends Error {
  constructor(readonly code: SyntheticEventStreamReplayErrorCode) {
    super(code);
    this.name = "SyntheticEventStreamReplayError";
  }
}

export interface SyntheticCompletionCandidate {
  expectedVersion: number;
  outcomeConfirmation: ResolutionOutcomeConfirmation;
}

export interface SyntheticEventStreamReplayResult {
  summary: SyntheticEventStreamSummary;
  finalMonitoringResult: MonitoringToolResult;
  finalResolutionCase: ResolutionCase | null;
  completionCandidate: SyntheticCompletionCandidate | null;
  effectivePlan: FinancialPlan;
  finalCheckpointOn: string;
}

function statusCounts(analysis: MonitoringToolResult["analysis"]): SyntheticEventStreamSummary["frames"][number]["assessmentStatusCounts"] {
  const count = (status: MonitoringToolResult["analysis"]["assessments"][number]["status"]): number => (
    analysis.assessments.filter((assessment) => assessment.status === status).length
  );
  return {
    pending: count("pending"),
    gracePeriod: count("grace_period"),
    met: count("met"),
    late: count("late"),
    reduced: count("reduced"),
    missing: count("missing")
  };
}

export function finalSyntheticCheckpointDate(streamInput: SyntheticEventStream): string | null {
  const stream = SyntheticEventStreamSchema.parse(streamInput);
  return stream.events.filter(({ type }) => type === "monitoring_checkpoint").at(-1)?.occurredOn ?? null;
}

export function replaySyntheticEventStream(
  planInput: FinancialPlan,
  streamInput: SyntheticEventStream
): SyntheticEventStreamReplayResult {
  const plan = FinancialPlanSchema.parse(planInput);
  const stream = SyntheticEventStreamSchema.parse(streamInput);
  const finalCheckpoint = finalSyntheticCheckpointDate(stream);
  if (finalCheckpoint && plan.bills.some(({ due }) => due < finalCheckpoint)) {
    throw new SyntheticEventStreamReplayError("unsupported_past_obligation");
  }
  const billIds = new Set(plan.bills.map(({ id }) => id));
  for (const billId of stream.protectedBillIds) {
    if (!billIds.has(billId)) throw new SyntheticEventStreamReplayError("unknown_protected_bill");
  }

  let availableBalanceCents = Math.round(plan.balance * 100);
  const observedIncome: Array<{
    id: string;
    sourceId: string;
    receivedOn: string;
    amountCents: number;
    matchConfidence: "user_confirmed" | "inferred";
  }> = [];
  let resolutionCase: ResolutionCase | null = null;
  let latestMonitoring: MonitoringToolResult | null = null;
  let finalCheckpointOn: string | null = null;
  let completionCandidate: SyntheticCompletionCandidate | null = null;
  let caseOpened = false;
  const frames: SyntheticEventStreamSummary["frames"] = [];

  const transition = (event: Parameters<typeof transitionResolutionCase>[1]): void => {
    if (!resolutionCase) throw new SyntheticEventStreamReplayError("case_event_without_case");
    resolutionCase = transitionResolutionCase(resolutionCase, event, { expectedVersion: resolutionCase.version });
  };

  for (const event of stream.events) {
    if (event.type === "income_observed") {
      observedIncome.push({
        id: event.eventId,
        sourceId: event.sourceId,
        receivedOn: event.occurredOn,
        amountCents: event.amountCents,
        matchConfidence: event.matchConfidence
      });
      availableBalanceCents += event.amountCents;
      continue;
    }
    if (event.type === "monitoring_checkpoint") {
      const analysis = analyzeIncomeMonitoring({
        asOf: event.occurredOn,
        horizonEnd: event.horizonEnd,
        availableBalanceCents,
        protectedBufferCents: Math.round(plan.buffer * 100),
        incomeExpectations: stream.sources.map(({ cadence: _cadence, ...source }) => source),
        observedIncome,
        obligations: plan.bills.map((bill, index) => ({
          id: `obligation-${index + 1}`,
          label: `Obligation ${index + 1}`,
          due: bill.due,
          amountCents: Math.round(bill.amount * 100),
          priority: stream.protectedBillIds.includes(bill.id) ? "protected" as const : "flexible" as const
        })).filter(({ amountCents }) => amountCents > 0)
      });
      const caseDecision = decideMonitoringCase(analysis);
      latestMonitoring = MonitoringToolResultSchema.parse({
        sources: stream.sources.map((source) => ({
          sourceId: source.id,
          label: source.label,
          kind: source.kind,
          cadence: source.cadence,
          patternStatus: source.confidence === "user_confirmed" ? "user_confirmed" : "inferred",
          requiresUserConfirmation: source.confidence === "inferred"
        })),
        analysis,
        caseDecision
      });
      if (!resolutionCase && caseDecision.shouldOpenCase) {
        resolutionCase = openResolutionCase(caseDecision, event.occurredOn);
        caseOpened = resolutionCase !== null;
      } else if (resolutionCase?.status === "needs_confirmation" && caseDecision.disposition === "open_case") {
        transition({ type: "signal_confirmed", occurredOn: event.occurredOn });
      } else if (resolutionCase?.status === "monitoring" && caseDecision.disposition === "needs_confirmation") {
        transition({ type: "confirmation_required", occurredOn: event.occurredOn });
      } else if (resolutionCase?.status === "monitoring" && caseDecision.disposition === "open_case") {
        transition({ type: "outcome_requires_replan", occurredOn: event.occurredOn });
      }
      frames.push({
        checkpointOn: event.occurredOn,
        assessmentStatusCounts: statusCounts(latestMonitoring.analysis),
        disposition: latestMonitoring.caseDecision.disposition,
        activeDisruptionCount: latestMonitoring.caseDecision.activeDisruptionCount,
        uncertainDisruptionCount: latestMonitoring.caseDecision.uncertainDisruptionCount,
        protectedObligationRiskCount: latestMonitoring.caseDecision.protectedObligationRiskCount,
        caseStatus: resolutionCase?.status ?? null,
        nextRequiredAction: resolutionCase?.nextRequiredAction ?? null,
        caseVersion: resolutionCase?.version ?? null
      });
      finalCheckpointOn = event.occurredOn;
      continue;
    }
    if (event.type === "case_options_calculated") {
      transition({ type: "options_calculated", occurredOn: event.occurredOn });
      continue;
    }
    if (event.type === "case_options_presented") {
      transition({ type: "options_presented", occurredOn: event.occurredOn });
      continue;
    }
    if (event.type === "case_decision_recorded") {
      transition({ type: "decision_recorded", occurredOn: event.occurredOn, selectedOptionId: event.selectedOptionId });
      continue;
    }
    if (event.type === "case_follow_up_started") {
      transition({ type: "follow_up_started", occurredOn: event.occurredOn });
      continue;
    }
    if (event.type === "case_escalation_required") {
      transition({ type: "escalation_required", occurredOn: event.occurredOn, reason: event.reason });
      continue;
    }
    if (!resolutionCase
      || resolutionCase.status !== "monitoring"
      || !latestMonitoring
      || latestMonitoring.caseDecision.disposition !== "no_case"
      || latestMonitoring.caseDecision.activeDisruptionCount !== 0
      || latestMonitoring.caseDecision.protectedObligationRiskCount !== 0) {
      throw new SyntheticEventStreamReplayError("completion_candidate_not_eligible");
    }
    completionCandidate = {
      expectedVersion: resolutionCase.version,
      outcomeConfirmation: event.outcomeConfirmation
    };
  }

  if (!latestMonitoring || !finalCheckpointOn) {
    throw new SyntheticEventStreamReplayError("missing_final_checkpoint");
  }
  const sourceKindCounts = {
    hourlyJob: stream.sources.filter(({ kind }) => kind === "hourly_job").length,
    salariedJob: stream.sources.filter(({ kind }) => kind === "salaried_job").length,
    freelanceClient: stream.sources.filter(({ kind }) => kind === "freelance_client").length,
    benefit: stream.sources.filter(({ kind }) => kind === "benefit").length,
    other: stream.sources.filter(({ kind }) => kind === "other").length
  };
  const summary = SyntheticEventStreamSummarySchema.parse({
    streamId: stream.streamId,
    provenance: stream.provenance,
    sourceKindCounts,
    eventCount: stream.events.length,
    checkpointCount: frames.length,
    caseOpened,
    frames,
    finalCaseStatus: resolutionCase?.status ?? null,
    finalNextRequiredAction: resolutionCase?.nextRequiredAction ?? null,
    completionReviewAvailable: completionCandidate !== null
  });
  return {
    summary,
    finalMonitoringResult: latestMonitoring,
    finalResolutionCase: resolutionCase,
    completionCandidate,
    effectivePlan: FinancialPlanSchema.parse({ ...plan, balance: availableBalanceCents / 100 }),
    finalCheckpointOn
  };
}
