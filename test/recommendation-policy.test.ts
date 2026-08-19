import test from "node:test";
import assert from "node:assert/strict";
import {
  actionRequiresApproval,
  finalizeRecommendation,
  recommendationMatchesPrimaryAnalysis
} from "../src/agent/recommendation-policy.js";
import { analyzeCashflow } from "../src/agent/calculations.js";
import { VerifierResultSchema, type ActionType, type VerifierResult } from "../src/agent/schemas.js";

const verifiedResult: VerifierResult = {
  verdict: "verified",
  checks: {
    arithmeticGrounded: true,
    protectedEssentials: true,
    assumptionsExplicit: true,
    externalActionsRemainReadOnly: true,
    policyClaimsSupported: true,
    userAutonomyPreserved: true,
    harmfulAdviceAbsent: true
  },
  corrections: []
};

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
    evidence: [{ source: "analyze_paycheck_scenario", finding: "$53 shortfall" }],
    options: [{
      title: "Ask about moving insurance",
      impact: 126,
      upside: "This creates $126 of room before payday.",
      tradeoff: "Coverage must remain active and the insurer may decline the request.",
      fitPriority: "preserving cash before payday matters more than keeping the current due date"
    }],
    decisionSupport: {
      decisionOwner: "user"
    },
    recommendedActions: [
      { title: "Review the timeline", rationale: "Confirm the known dates.", actionType: "review_information" },
      { title: "Pay for the tire", rationale: "Transportation is essential for work.", actionType: "make_payment" },
      { title: "Call the insurer", rationale: "Confirm any date change first.", actionType: "contact_biller" }
    ]
  }, verifiedResult);

  assert.deepEqual(recommendation.recommendedActions.map((action) => action.requiresApproval), [false, true, true]);
  assert.deepEqual(recommendation.verification, {
    checked: true,
    notes: ["The independent verifier completed all arithmetic, essentials, assumptions, read-only action, policy-support, autonomy, and harmful-advice checks without requesting a correction."]
  });
  assert.equal(recommendation.disclaimer, "Planning guidance, not financial advice.");
  assert.equal(recommendation.decisionSupport.decisionOwner, "user");
  assert.equal(recommendation.decisionSupport.choicePrompt, "Which option's tradeoffs fit your priorities?");
  assert.deepEqual(recommendation.policyFindings, []);
});

test("recommendation schema rejects incomplete autonomy framing", () => {
  const base = {
    summary: "The plan has options.",
    riskLevel: "stable",
    safeToSpend: 100,
    dailyFlexibleLimit: 20,
    assumptions: [],
    evidence: [{ source: "timeline", finding: "$100 remains." }],
    options: [{
      title: "Delay an optional purchase",
      impact: 50,
      tradeoff: "The purchase happens later.",
      fitPriority: "preserving more cash matters more than the purchase timing"
    }],
    decisionSupport: { decisionOwner: "user" },
    recommendedActions: [{ title: "Review", rationale: "Compare the options.", actionType: "review_information" }]
  };
  assert.throws(() => finalizeRecommendation(base, verifiedResult));
});

test("finalization supplies neutral fit framing when the model omits fitPriority", () => {
  const recommendation = finalizeRecommendation({
    summary: "The plan has an option.",
    riskLevel: "stable",
    safeToSpend: 100,
    dailyFlexibleLimit: 20,
    assumptions: [],
    evidence: [{ source: "analyze_paycheck_scenario", finding: "$100 remains." }],
    options: [{
      title: "Delay an optional purchase",
      impact: 50,
      upside: "This keeps $50 available before payday.",
      tradeoff: "The purchase happens later."
    }],
    decisionSupport: { decisionOwner: "user" },
    recommendedActions: [{ title: "Review", rationale: "Compare the tradeoff.", actionType: "review_information" }]
  }, verifiedResult);
  assert.equal(
    recommendation.options[0]!.fitPriority,
    "weighing this option's stated upside against its stated tradeoff"
  );
});

test("finalization preserves fixed verifier correction categories without model prose", () => {
  const correctionsRequired = VerifierResultSchema.parse({
    verdict: "corrections_required",
    checks: { ...verifiedResult.checks, arithmeticGrounded: false },
    corrections: [{ code: "arithmetic", instruction: "Use the deterministic safe-to-spend amount." }]
  });
  const rawRecommendation = {
    summary: "The plan has a small shortfall.",
    riskLevel: "shortfall",
    safeToSpend: 0,
    dailyFlexibleLimit: 0,
    assumptions: [],
    evidence: [{ source: "analyze_paycheck_scenario", finding: "$53 shortfall" }],
    options: [{
      title: "Reduce optional spending",
      impact: 53,
      upside: "This closes the modeled gap.",
      tradeoff: "Optional spending is lower before payday.",
      fitPriority: "closing the modeled gap matters more than optional spending"
    }],
    decisionSupport: { decisionOwner: "user" },
    recommendedActions: [{
      title: "Review optional spending",
      rationale: "Compare it with the deterministic gap.",
      actionType: "review_information"
    }]
  };
  assert.deepEqual(
    finalizeRecommendation(rawRecommendation, correctionsRequired).verification.notes,
    ["The independent verifier returned correction requirements for arithmetic before final output."]
  );
});

test("verifier result schema rejects contradictory verdicts", () => {
  assert.throws(() => VerifierResultSchema.parse({
    verdict: "verified",
    checks: { ...verifiedResult.checks, harmfulAdviceAbsent: false },
    corrections: []
  }));
});

test("final recommendation amounts must match the authoritative primary analysis", () => {
  const analysis = analyzeCashflow({
    name: "Alex",
    balance: 642,
    paycheck: 1840,
    buffer: 100,
    payday: "2026-08-25",
    bills: [
      { id: "phone", name: "Phone", amount: 74, due: "2026-08-18", category: "Utilities" },
      { id: "food", name: "Food", amount: 95, due: "2026-08-20", category: "Food" },
      { id: "insurance", name: "Insurance", amount: 126, due: "2026-08-23", category: "Transport" }
    ]
  }, "2026-08-17");
  assert.equal(recommendationMatchesPrimaryAnalysis({
    riskLevel: analysis.riskLevel,
    safeToSpend: analysis.safeToSpend,
    dailyFlexibleLimit: analysis.dailyFlexibleLimit
  }, analysis), true);
  assert.equal(recommendationMatchesPrimaryAnalysis({
    riskLevel: analysis.riskLevel,
    safeToSpend: analysis.safeToSpend + 1,
    dailyFlexibleLimit: analysis.dailyFlexibleLimit
  }, analysis), false);
});
