import { z } from "zod";
import {
  MonitoringCaseDecisionSchema,
  ResolutionCaseDateSchema,
  ResolutionCaseSchema,
  ResolutionCaseStatusSchema,
  ResolutionCaseTerminalReasonSchema,
  type MonitoringCaseDecision,
  type ResolutionCase,
  type ResolutionCaseStatus,
  type ResolutionCaseTerminalReason
} from "./schemas.js";

const CaseIdSchema = z.string().regex(/^case-[a-z0-9-]{1,64}$/);
const OptionIdSchema = z.string().regex(/^option-[a-z0-9-]{1,64}$/);

export const ResolutionCaseTransitionEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("signal_confirmed"), occurredOn: ResolutionCaseDateSchema }).strict(),
  z.object({ type: z.literal("signal_rejected"), occurredOn: ResolutionCaseDateSchema }).strict(),
  z.object({ type: z.literal("options_calculated"), occurredOn: ResolutionCaseDateSchema }).strict(),
  z.object({ type: z.literal("options_presented"), occurredOn: ResolutionCaseDateSchema }).strict(),
  z.object({
    type: z.literal("decision_recorded"),
    occurredOn: ResolutionCaseDateSchema,
    selectedOptionId: OptionIdSchema
  }).strict(),
  z.object({ type: z.literal("follow_up_started"), occurredOn: ResolutionCaseDateSchema }).strict(),
  z.object({ type: z.literal("outcome_requires_replan"), occurredOn: ResolutionCaseDateSchema }).strict(),
  z.object({ type: z.literal("confirmation_required"), occurredOn: ResolutionCaseDateSchema }).strict(),
  z.object({
    type: z.literal("outcome_verified"),
    occurredOn: ResolutionCaseDateSchema,
    reason: z.enum(["risk_cleared_verified", "user_outcome_verified"])
  }).strict(),
  z.object({
    type: z.literal("escalation_required"),
    occurredOn: ResolutionCaseDateSchema,
    reason: z.enum([
      "risk_worsened",
      "deadline_missed",
      "required_service_unavailable",
      "outside_agent_scope"
    ])
  }).strict()
]);

export type ResolutionCaseTransitionEvent = z.infer<typeof ResolutionCaseTransitionEventSchema>;

export interface ResolutionCaseTransitionControls {
  expectedVersion: number;
  closureVerifierApproved?: boolean;
}

export type ResolutionCaseTransitionErrorCode =
  | "stale_case_version"
  | "invalid_case_transition"
  | "terminal_case"
  | "closure_verification_required"
  | "case_history_limit";

export class ResolutionCaseTransitionError extends Error {
  constructor(readonly code: ResolutionCaseTransitionErrorCode) {
    super(code);
    this.name = "ResolutionCaseTransitionError";
  }
}

const NEXT_ACTION_BY_STATUS = {
  detected: "calculate_options",
  needs_confirmation: "confirm_or_correct_signal",
  options_ready: "present_tradeoffs",
  awaiting_decision: "wait_for_user_choice",
  prepared: "begin_follow_up",
  monitoring: "observe_outcome",
  resolved: "none",
  escalated: "none"
} as const;

const TRANSITION_TARGETS: Readonly<Partial<Record<ResolutionCaseStatus, Partial<Record<ResolutionCaseTransitionEvent["type"], ResolutionCaseStatus>>>>> = {
  needs_confirmation: {
    signal_confirmed: "detected",
    signal_rejected: "resolved",
    escalation_required: "escalated"
  },
  detected: {
    options_calculated: "options_ready",
    confirmation_required: "needs_confirmation",
    escalation_required: "escalated"
  },
  options_ready: {
    options_presented: "awaiting_decision",
    outcome_requires_replan: "detected",
    confirmation_required: "needs_confirmation",
    escalation_required: "escalated"
  },
  awaiting_decision: {
    decision_recorded: "prepared",
    outcome_requires_replan: "detected",
    confirmation_required: "needs_confirmation",
    escalation_required: "escalated"
  },
  prepared: {
    follow_up_started: "monitoring",
    outcome_requires_replan: "detected",
    confirmation_required: "needs_confirmation",
    escalation_required: "escalated"
  },
  monitoring: {
    outcome_requires_replan: "detected",
    confirmation_required: "needs_confirmation",
    outcome_verified: "resolved",
    escalation_required: "escalated"
  }
};

export function openResolutionCase(
  decisionInput: MonitoringCaseDecision,
  openedOn: string,
  caseId = "case-1"
): ResolutionCase | null {
  const decision = MonitoringCaseDecisionSchema.parse(decisionInput);
  const date = ResolutionCaseDateSchema.parse(openedOn);
  const parsedCaseId = CaseIdSchema.parse(caseId);
  if (!decision.shouldOpenCase) return null;

  const status: ResolutionCaseStatus = decision.disposition === "needs_confirmation"
    ? "needs_confirmation"
    : "detected";
  return ResolutionCaseSchema.parse({
    caseId: parsedCaseId,
    version: 1,
    status,
    nextRequiredAction: NEXT_ACTION_BY_STATUS[status],
    openedOn: date,
    updatedOn: date,
    trigger: {
      reasonCodes: decision.reasonCodes,
      activeDisruptionCount: decision.activeDisruptionCount,
      uncertainDisruptionCount: decision.uncertainDisruptionCount,
      protectedObligationRiskCount: decision.protectedObligationRiskCount
    },
    selectedOptionId: null,
    terminalReason: null,
    transitionHistory: [{
      fromStatus: null,
      toStatus: status,
      eventType: "case_opened",
      occurredOn: date
    }]
  });
}

export function transitionResolutionCase(
  caseInput: ResolutionCase,
  eventInput: ResolutionCaseTransitionEvent,
  controls: ResolutionCaseTransitionControls
): ResolutionCase {
  const resolutionCase = ResolutionCaseSchema.parse(caseInput);
  const event = ResolutionCaseTransitionEventSchema.parse(eventInput);
  if (controls.expectedVersion !== resolutionCase.version) {
    throw new ResolutionCaseTransitionError("stale_case_version");
  }
  if (resolutionCase.status === "resolved" || resolutionCase.status === "escalated") {
    throw new ResolutionCaseTransitionError("terminal_case");
  }
  if (resolutionCase.transitionHistory.length >= 32) {
    throw new ResolutionCaseTransitionError("case_history_limit");
  }
  if (event.occurredOn < resolutionCase.updatedOn) {
    throw new ResolutionCaseTransitionError("invalid_case_transition");
  }

  const target = TRANSITION_TARGETS[resolutionCase.status]?.[event.type];
  if (!target) throw new ResolutionCaseTransitionError("invalid_case_transition");
  if (target === "resolved" && controls.closureVerifierApproved !== true) {
    throw new ResolutionCaseTransitionError("closure_verification_required");
  }

  let terminalReason: ResolutionCaseTerminalReason | null = null;
  if (event.type === "signal_rejected") terminalReason = "false_positive_verified";
  if (event.type === "outcome_verified") terminalReason = event.reason;
  if (event.type === "escalation_required") terminalReason = event.reason;
  if (terminalReason !== null) ResolutionCaseTerminalReasonSchema.parse(terminalReason);

  const selectedOptionId = event.type === "decision_recorded"
    ? event.selectedOptionId
    : event.type === "outcome_requires_replan" || event.type === "confirmation_required"
      ? null
      : resolutionCase.selectedOptionId;
  return ResolutionCaseSchema.parse({
    ...resolutionCase,
    version: resolutionCase.version + 1,
    status: ResolutionCaseStatusSchema.parse(target),
    nextRequiredAction: NEXT_ACTION_BY_STATUS[target],
    updatedOn: event.occurredOn,
    selectedOptionId,
    terminalReason,
    transitionHistory: [
      ...resolutionCase.transitionHistory,
      {
        fromStatus: resolutionCase.status,
        toStatus: target,
        eventType: event.type,
        occurredOn: event.occurredOn
      }
    ]
  });
}
