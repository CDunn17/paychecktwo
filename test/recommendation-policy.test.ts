import test from "node:test";
import assert from "node:assert/strict";
import { actionRequiresApproval, finalizeRecommendation } from "../src/agent/recommendation-policy.js";
import type { ActionType } from "../src/agent/schemas.js";

const actionTypes: ActionType[] = [
  "review_information",
  "set_spending_target",
  "contact_biller",
  "change_bill",
  "make_payment",
  "transfer_money",
  "use_credit"
];

test("approval policy covers every action type and protects external changes", () => {
  assert.deepEqual(
    actionTypes.map((actionType) => [actionType, actionRequiresApproval(actionType)]),
    [
      ["review_information", false],
      ["set_spending_target", false],
      ["contact_biller", true],
      ["change_bill", true],
      ["make_payment", true],
      ["transfer_money", true],
      ["use_credit", true]
    ]
  );
});

test("finalization adds policy-controlled approvals and immutable safety fields", () => {
  const recommendation = finalizeRecommendation({
    summary: "The plan has a small shortfall.",
    riskLevel: "shortfall",
    safeToSpend: 0,
    dailyFlexibleLimit: null,
    assumptions: ["The tire is required before payday."],
    evidence: [{ source: "simulate_disruption", finding: "$53 shortfall" }],
    options: [{ title: "Ask about moving insurance", impact: 126, tradeoff: "Coverage must remain active." }],
    recommendedActions: [
      { title: "Review the timeline", rationale: "Confirm the known dates.", actionType: "review_information" },
      { title: "Pay for the tire", rationale: "Transportation is essential for work.", actionType: "make_payment" },
      { title: "Call the insurer", rationale: "Confirm any date change first.", actionType: "contact_biller" }
    ],
    verificationNotes: ["Arithmetic checked against tool output."]
  });

  assert.deepEqual(recommendation.recommendedActions.map((action) => action.requiresApproval), [false, true, true]);
  assert.deepEqual(recommendation.verification, {
    checked: true,
    notes: ["Arithmetic checked against tool output."]
  });
  assert.equal(recommendation.disclaimer, "Planning guidance, not financial advice.");
  assert.equal("verificationNotes" in recommendation, false);
});
