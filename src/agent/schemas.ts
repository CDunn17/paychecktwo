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

const RecommendationCoreSchema = z.object({
  summary: z.string().min(1).describe("A concise, empathetic answer grounded in tool results"),
  riskLevel: z.enum(["stable", "tight", "shortfall"]).describe("The primary timeline or disruption tool's riskLevel before optional plan changes"),
  safeToSpend: z.number().nonnegative().describe("The primary timeline or disruption tool's safeToSpend before optional plan changes"),
  dailyFlexibleLimit: z.number().nonnegative().nullable().describe("The primary timeline or disruption tool's dailyFlexibleLimit before optional plan changes"),
  assumptions: z.array(z.string()),
  evidence: z.array(z.object({
    source: z.string(),
    finding: z.string()
  })).min(1),
  options: z.array(z.object({
    title: z.string(),
    impact: z.number().describe("Estimated dollars of additional room this option creates"),
    tradeoff: z.string()
  })),
  recommendedActions: z.array(z.object({
    title: z.string(),
    rationale: z.string(),
    actionType: ActionTypeSchema.describe("Classify the action; the application decides whether approval is required")
  })),
  policyFindings: z.array(PolicyFindingSchema).default([]).describe("Only findings returned by review_terms_and_policies; use an empty array when no policy source was reviewed")
});

export const AgentRecommendationSchema = RecommendationCoreSchema.extend({
  verificationNotes: z.array(z.string())
}).describe("The final evidence-backed paycheck plan after the verifier's corrections have been applied");

export const RecommendationSchema = RecommendationCoreSchema.omit({ recommendedActions: true }).extend({
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
export type AgentRecommendation = z.infer<typeof AgentRecommendationSchema>;
export type Recommendation = z.infer<typeof RecommendationSchema>;
export type SafetyPreviewRequest = z.infer<typeof SafetyPreviewRequestSchema>;
export type AgentRequest = z.infer<typeof AgentRequestSchema>;
