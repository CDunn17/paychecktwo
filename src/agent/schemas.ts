import { z } from "zod";

export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const BillSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  amount: z.number().nonnegative().finite(),
  due: IsoDateSchema,
  category: z.string().min(1).max(40),
  icon: z.string().max(30).optional()
});

export const FinancialPlanSchema = z.object({
  name: z.string().min(1).max(80).default("there"),
  balance: z.number().nonnegative().finite(),
  paycheck: z.number().nonnegative().finite(),
  buffer: z.number().nonnegative().finite(),
  payday: IsoDateSchema,
  periodStart: IsoDateSchema.optional(),
  bills: z.array(BillSchema).max(200)
});

export const UnexpectedExpenseSchema = z.object({
  name: z.string().min(1).max(80),
  amount: z.number().positive().finite(),
  due: IsoDateSchema
});

export const DisruptionSchema = z.object({
  paycheckDelayDays: z.number().int().min(0).max(31).default(0),
  incomeReduction: z.number().nonnegative().finite().default(0),
  unexpectedExpenses: z.array(UnexpectedExpenseSchema).max(20).default([])
});

export const ComparisonOptionSchema = z.object({
  label: z.string().min(1).max(100),
  billIdsToDefer: z.array(z.string()).max(20).default([]),
  spendingReduction: z.number().nonnegative().finite().default(0),
  bufferReduction: z.number().nonnegative().finite().default(0)
});

export const PolicySourceTypeSchema = z.enum([
  "user_reported",
  "provider_terms",
  "provider_confirmation"
]);

export const PolicySourceSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  title: z.string().min(1).max(120),
  provider: z.string().min(1).max(120),
  sourceType: PolicySourceTypeSchema,
  content: z.string().min(3).max(12_000),
  sourceReference: z.string().max(240).nullable().default(null),
  effectiveDate: IsoDateSchema.nullable().default(null),
  lastConfirmedDate: IsoDateSchema.nullable().default(null)
});

export const PolicySupportLevelSchema = z.enum([
  "user_reported",
  "explicit",
  "ambiguous"
]);

export const PolicyFindingSchema = z.object({
  sourceId: z.string(),
  sourceType: PolicySourceTypeSchema,
  title: z.string(),
  provider: z.string(),
  finding: z.string(),
  supportLevel: PolicySupportLevelSchema,
  evidenceQuote: z.string().max(600).nullable(),
  sourceReference: z.string().max(240).nullable(),
  eligibilityConditions: z.array(z.string()),
  needsConfirmation: z.boolean()
}).superRefine((finding, context) => {
  if (finding.sourceType === "user_reported") {
    if (finding.supportLevel !== "user_reported") {
      context.addIssue({ code: "custom", path: ["supportLevel"], message: "User-reported knowledge must remain user_reported." });
    }
    if (finding.evidenceQuote !== null) {
      context.addIssue({ code: "custom", path: ["evidenceQuote"], message: "User-reported knowledge cannot have a document quote." });
    }
    if (!finding.needsConfirmation) {
      context.addIssue({ code: "custom", path: ["needsConfirmation"], message: "User-reported knowledge must be confirmed before relying on it." });
    }
  }
  if (finding.sourceType === "provider_terms" && finding.supportLevel === "explicit" && !finding.evidenceQuote) {
    context.addIssue({ code: "custom", path: ["evidenceQuote"], message: "An explicit terms finding requires a supporting quote." });
  }
});

export const PolicyReviewSchema = z.object({
  summary: z.string(),
  findings: z.array(PolicyFindingSchema).max(20),
  unknowns: z.array(z.string()).max(20)
}).describe("A provenance-preserving review of user knowledge and provider terms relevant to the current paycheck question");

export const PolicyReliefOptionSchema = z.object({
  label: z.string().min(1).max(120),
  sourceId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  unexpectedExpenseName: z.string().min(1).max(80),
  reductionAmount: z.number().positive().finite()
});

export const ActionTypeSchema = z.enum([
  "review_information",
  "set_spending_target",
  "contact_biller",
  "change_bill",
  "make_payment",
  "transfer_money",
  "use_credit"
]);

export const VerificationIssueCodeSchema = z.enum([
  "arithmetic",
  "protected_essentials",
  "assumption",
  "external_action",
  "policy_support",
  "user_autonomy",
  "harmful_advice"
]);

export const VerifierModelResultSchema = z.object({
  failedChecks: z.array(VerificationIssueCodeSchema).max(7)
});

export const VerifierResultSchema = z.object({
  verdict: z.enum(["verified", "corrections_required"]),
  checks: z.object({
    arithmeticGrounded: z.boolean(),
    protectedEssentials: z.boolean(),
    assumptionsExplicit: z.boolean(),
    externalActionsRemainReadOnly: z.boolean(),
    policyClaimsSupported: z.boolean(),
    userAutonomyPreserved: z.boolean(),
    harmfulAdviceAbsent: z.boolean()
  }),
  corrections: z.array(z.object({
    code: VerificationIssueCodeSchema,
    instruction: z.string().min(1).max(300)
  })).max(7)
}).superRefine((result, context) => {
  const allChecksPassed = Object.values(result.checks).every(Boolean);
  if (result.verdict === "verified" && (!allChecksPassed || result.corrections.length > 0)) {
    context.addIssue({
      code: "custom",
      path: ["verdict"],
      message: "A verified result requires every check to pass and no corrections."
    });
  }
  if (result.verdict === "corrections_required" && (allChecksPassed || result.corrections.length === 0)) {
    context.addIssue({
      code: "custom",
      path: ["corrections"],
      message: "A corrections-required result needs a failed check and at least one correction."
    });
  }
}).describe("A compact independent verification verdict for a proposed paycheck plan");

const RecommendationOptionSchema = z.object({
  title: z.string().min(1).max(120),
  impact: z.number().finite().describe("Estimated dollars of additional room this option creates"),
  upside: z.string().min(1).max(500).describe("A concrete benefit of this option, without value judgment"),
  tradeoff: z.string().min(1).max(500).describe("A concrete cost, downside, or limitation of this option"),
  fitPriority: z.string().min(1).max(300)
    .default("weighing this option's stated upside against its stated tradeoff")
    .describe("A neutral user priority this option fits; application code supplies a neutral default when omitted; do not prescribe the choice or begin with 'If'")
});

const AgentDecisionSupportSchema = z.object({
  decisionOwner: z.literal("user").describe("The user retains the value-dependent decision")
});

const FinalDecisionSupportSchema = AgentDecisionSupportSchema.extend({
  choicePrompt: z.literal("Which option's tradeoffs fit your priorities?")
});

const RecommendationCoreSchema = z.object({
  summary: z.string().min(1).describe("A concise, empathetic answer grounded in tool results"),
  riskLevel: z.enum(["stable", "tight", "shortfall"]).describe("The analyze_paycheck_scenario riskLevel before optional plan changes"),
  safeToSpend: z.number().nonnegative().describe("The analyze_paycheck_scenario safeToSpend before optional plan changes"),
  dailyFlexibleLimit: z.number().nonnegative().nullable().describe("The analyze_paycheck_scenario dailyFlexibleLimit before optional plan changes"),
  assumptions: z.array(z.string()),
  evidence: z.array(z.object({
    source: z.string(),
    finding: z.string()
  })).min(1),
  options: z.array(RecommendationOptionSchema).min(1).max(6),
  decisionSupport: AgentDecisionSupportSchema,
  recommendedActions: z.array(z.object({
    title: z.string(),
    rationale: z.string(),
    actionType: ActionTypeSchema.describe("Classify the action; the application decides whether approval is required")
  })),
  policyFindings: z.array(PolicyFindingSchema).default([]).describe("Only findings returned by review_terms_and_policies; use an empty array when no policy source was reviewed")
});

export const AgentRecommendationSchema = RecommendationCoreSchema.describe(
  "The final evidence-backed paycheck plan after the verifier has returned a verified verdict"
);

export const RecommendationSchema = RecommendationCoreSchema.omit({ recommendedActions: true, decisionSupport: true }).extend({
  recommendedActions: z.array(z.object({
    title: z.string(),
    rationale: z.string(),
    actionType: ActionTypeSchema,
    requiresApproval: z.boolean()
  })),
  verification: z.object({
    checked: z.literal(true),
    notes: z.array(z.string())
  }),
  decisionSupport: FinalDecisionSupportSchema,
  disclaimer: z.literal("Planning guidance, not financial advice.")
});

const AgentRequestCoreSchema = z.object({
  sessionId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  message: z.string().min(1).max(4000),
  plan: FinancialPlanSchema,
  asOf: IsoDateSchema.optional().describe("Optional deterministic date for evaluation and replay"),
  policySources: z.array(PolicySourceSchema).max(20).default([])
});

export const SafetyPreviewRequestSchema = AgentRequestCoreSchema;

export const AgentRequestSchema = AgentRequestCoreSchema.extend({
  privacy: z.object({
    consentToModel: z.literal(true),
    ephemeral: z.boolean().default(true)
  })
});

export type FinancialPlan = z.infer<typeof FinancialPlanSchema>;
export type Disruption = z.infer<typeof DisruptionSchema>;
export type ComparisonOption = z.infer<typeof ComparisonOptionSchema>;
export type PolicySource = z.infer<typeof PolicySourceSchema>;
export type PolicyFinding = z.infer<typeof PolicyFindingSchema>;
export type PolicyReview = z.infer<typeof PolicyReviewSchema>;
export type PolicyReliefOption = z.infer<typeof PolicyReliefOptionSchema>;
export type ActionType = z.infer<typeof ActionTypeSchema>;
export type VerifierModelResult = z.infer<typeof VerifierModelResultSchema>;
export type VerifierResult = z.infer<typeof VerifierResultSchema>;
export type AgentRecommendation = z.infer<typeof AgentRecommendationSchema>;
export type Recommendation = z.infer<typeof RecommendationSchema>;
export type SafetyPreviewRequest = z.infer<typeof SafetyPreviewRequestSchema>;
export type AgentRequest = z.infer<typeof AgentRequestSchema>;
