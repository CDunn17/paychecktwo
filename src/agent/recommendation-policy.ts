import {
  AgentRecommendationSchema,
  RecommendationSchema,
  type ActionType,
  type Recommendation
} from "./schemas.js";

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

export function finalizeRecommendation(rawRecommendation: unknown): Recommendation {
  const recommendation = AgentRecommendationSchema.parse(rawRecommendation);
  const { verificationNotes, ...recommendationCore } = recommendation;
  return RecommendationSchema.parse({
    ...recommendationCore,
    recommendedActions: recommendation.recommendedActions.map((action) => ({
      ...action,
      requiresApproval: actionRequiresApproval(action.actionType)
    })),
    verification: {
      checked: true,
      notes: verificationNotes
    },
    disclaimer: "Planning guidance, not financial advice."
  });
}
