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
  riskLevel: z.enum(["stable", "tight", "shortfall"]),
  safeToSpend: z.number().nonnegative(),
  dailyFlexibleLimit: z.number().nonnegative().nullable(),
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
  }))
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

export const AgentRequestSchema = z.object({
  sessionId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  message: z.string().min(1).max(4000),
  plan: FinancialPlanSchema
});

export type FinancialPlan = z.infer<typeof FinancialPlanSchema>;
export type Disruption = z.infer<typeof DisruptionSchema>;
export type ComparisonOption = z.infer<typeof ComparisonOptionSchema>;
export type ActionType = z.infer<typeof ActionTypeSchema>;
export type AgentRecommendation = z.infer<typeof AgentRecommendationSchema>;
export type Recommendation = z.infer<typeof RecommendationSchema>;
export type AgentRequest = z.infer<typeof AgentRequestSchema>;
