import test from "node:test";
import assert from "node:assert/strict";
import { analyzeCashflow, evaluatePolicyRelief } from "../src/agent/calculations.js";
import { canonicalizePolicyReview } from "../src/agent/policy-review.js";
import { PlanStore } from "../src/agent/plan-store.js";
import { PolicyFindingSchema, type FinancialPlan, type PolicySource } from "../src/agent/schemas.js";

const plan: FinancialPlan = {
  name: "Alex",
  balance: 100,
  paycheck: 500,
  buffer: 50,
  payday: "2026-08-25",
  bills: []
};

const userPolicy: PolicySource = {
  id: "annual-waiver",
  title: "Annual overdraft-fee waiver",
  provider: "Example Bank",
  sourceType: "user_reported",
  content: "I remember that the bank may waive one overdraft fee each year.",
  sourceReference: null,
  effectiveDate: null,
  lastConfirmedDate: null
};

test("plan store clones policy sources with the financial snapshot", () => {
  const store = new PlanStore();
  store.set("policy-test", plan, [userPolicy]);
  const stored = store.getPolicySources("policy-test");
  stored[0]!.title = "Changed outside store";
  assert.equal(store.getPolicySources("policy-test")[0]?.title, "Annual overdraft-fee waiver");
});

test("plan store deletes request-scoped plan and policy data", () => {
  const store = new PlanStore();
  store.set("ephemeral-test", plan, [userPolicy]);
  store.delete("ephemeral-test");
  assert.equal(store.has("ephemeral-test"), false);
  assert.throws(() => store.getPolicySources("ephemeral-test"), /No financial plan is loaded/);
});

test("user-reported policies cannot be upgraded to explicit evidence", () => {
  assert.throws(() => PolicyFindingSchema.parse({
    sourceId: "annual-waiver",
    sourceType: "user_reported",
    title: userPolicy.title,
    provider: userPolicy.provider,
    finding: "The bank waives one fee each year.",
    supportLevel: "explicit",
    evidenceQuote: "One waiver",
    sourceReference: null,
    eligibilityConditions: [],
    needsConfirmation: false
  }), /must remain user_reported/);
});

test("policy review canonicalizes provenance from the stored source", () => {
  const result = canonicalizePolicyReview({
    summary: "The remembered waiver may be worth checking.",
    findings: [{
      sourceId: "annual-waiver",
      sourceType: "user_reported",
      title: "Model changed this title",
      provider: "Wrong provider",
      finding: "The user remembers a possible annual fee waiver.",
      supportLevel: "user_reported",
      evidenceQuote: null,
      sourceReference: "invented reference",
      eligibilityConditions: ["The waiver may not have been used this year."],
      needsConfirmation: true
    }],
    unknowns: ["Whether the waiver is current and unused."]
  }, [userPolicy]);

  assert.equal(result.findings[0]?.title, userPolicy.title);
  assert.equal(result.findings[0]?.provider, userPolicy.provider);
  assert.equal(result.findings[0]?.sourceReference, null);
});

test("policy review rejects unknown source identifiers", () => {
  assert.throws(() => canonicalizePolicyReview({
    summary: "Unknown source.",
    findings: [{
      sourceId: "missing-source",
      sourceType: "user_reported",
      title: "Missing",
      provider: "Unknown",
      finding: "Unsupported.",
      supportLevel: "user_reported",
      evidenceQuote: null,
      sourceReference: null,
      eligibilityConditions: [],
      needsConfirmation: true
    }],
    unknowns: []
  }, [userPolicy]), /unknown source/);
});

test("policy relief is conditional and cannot exceed the matching expense", () => {
  const disruption = {
    paycheckDelayDays: 0,
    incomeReduction: 0,
    unexpectedExpenses: [{ name: "Overdraft fee", amount: 35, due: "2026-08-17" }]
  };
  const baseline = analyzeCashflow(plan, "2026-08-17", disruption);
  const [result] = evaluatePolicyRelief(baseline, disruption, [userPolicy], [{
    label: "Possible fee waiver",
    sourceId: userPolicy.id,
    unexpectedExpenseName: "Overdraft fee",
    reductionAmount: 100
  }]);
  assert.equal(result?.conditional, true);
  assert.equal(result?.roomCreated, 35);
  assert.equal(result?.resultingRawRemainder, baseline.rawRemainder + 35);
  assert.match(result?.warning ?? "", /confirm eligibility/);
});
