import {
  AgentRecommendationSchema,
  RecommendationSchema,
  type ActionType,
  type MonitoringCaseDecision,
  type Recommendation,
  type ResolutionCase,
  type VerifierResult
} from "./schemas.js";
import type { CashflowAnalysis } from "./calculations.js";

const APPROVAL_REQUIRED: Readonly<Record<ActionType, boolean>> = {
  review_information: false,
  set_spending_target: false,
  contact_biller: true,
  change_bill: true,
  make_payment: true,
  transfer_money: true,
  use_credit: true
};

export function actionRequiresApproval(actionType: ActionType): boolean {
  return APPROVAL_REQUIRED[actionType];
}

export function recommendationMatchesPrimaryAnalysis(
  recommendation: Pick<Recommendation, "riskLevel" | "safeToSpend" | "dailyFlexibleLimit">,
  analysis: CashflowAnalysis
): boolean {
  const amountMatches = (actual: number | null, expected: number): boolean => (
    actual !== null && Math.abs(actual - expected) < 0.005
  );
  return recommendation.riskLevel === analysis.riskLevel
    && amountMatches(recommendation.safeToSpend, analysis.safeToSpend)
    && amountMatches(recommendation.dailyFlexibleLimit, analysis.dailyFlexibleLimit);
}

export function finalizeRecommendation(
  rawRecommendation: unknown,
  verifierResult: VerifierResult,
  monitoringDecision: MonitoringCaseDecision | null = null,
  resolutionCase: ResolutionCase | null = null
): Recommendation {
  const recommendation = AgentRecommendationSchema.parse(rawRecommendation);
  const verificationNote = verifierResult.verdict === "verified"
    ? "The independent verifier completed all arithmetic, essentials, assumptions, read-only action, policy-support, autonomy, and harmful-advice checks without requesting a correction."
    : `The independent verifier returned correction requirements for ${verifierResult.corrections.map(({ code }) => code.replaceAll("_", " ")).join(", ")} before final output.`;
  return RecommendationSchema.parse({
    ...recommendation,
    recommendedActions: recommendation.recommendedActions.map((action) => ({
      ...action,
      requiresApproval: actionRequiresApproval(action.actionType)
    })),
    decisionSupport: {
      decisionOwner: recommendation.decisionSupport.decisionOwner,
      choicePrompt: "Which option's tradeoffs fit your priorities?"
    },
    verification: {
      checked: true,
      notes: [verificationNote]
    },
    monitoringDecision,
    resolutionCase,
    disclaimer: "Planning guidance, not financial advice."
  });
}
