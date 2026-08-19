import test from "node:test";
import assert from "node:assert/strict";
import {
  openResolutionCase,
  transitionResolutionCase,
  ResolutionCaseTransitionError
} from "../src/agent/resolution-case.js";
import { PlanStore } from "../src/agent/plan-store.js";
import { FinancialPlanSchema, ResolutionCaseSchema, type MonitoringCaseDecision } from "../src/agent/schemas.js";

const materialDecision: MonitoringCaseDecision = {
  disposition: "open_case",
  shouldOpenCase: true,
  reasonCodes: ["protected_obligation_risk"],
  activeDisruptionCount: 1,
  uncertainDisruptionCount: 0,
  protectedObligationRiskCount: 1
};

const uncertainDecision: MonitoringCaseDecision = {
  disposition: "needs_confirmation",
  shouldOpenCase: true,
  reasonCodes: ["unconfirmed_income_signal"],
  activeDisruptionCount: 1,
  uncertainDisruptionCount: 1,
  protectedObligationRiskCount: 0
};

test("opens only material or uncertain cases with application-owned initial states", () => {
  const material = openResolutionCase(materialDecision, "2026-08-17");
  const uncertain = openResolutionCase(uncertainDecision, "2026-08-17");
  const noCase = openResolutionCase({
    disposition: "no_case",
    shouldOpenCase: false,
    reasonCodes: ["no_material_or_uncertain_disruption"],
    activeDisruptionCount: 0,
    uncertainDisruptionCount: 0,
    protectedObligationRiskCount: 0
  }, "2026-08-17");

  assert.equal(material?.status, "detected");
  assert.equal(material?.nextRequiredAction, "calculate_options");
  assert.equal(uncertain?.status, "needs_confirmation");
  assert.equal(uncertain?.nextRequiredAction, "confirm_or_correct_signal");
  assert.equal(noCase, null);
  assert.deepEqual(uncertain?.transitionHistory, [{
    fromStatus: null,
    toStatus: "needs_confirmation",
    eventType: "case_opened",
    occurredOn: "2026-08-17"
  }]);
});

test("follows the legal decision and follow-up path through every nonterminal work state", () => {
  let current = openResolutionCase(materialDecision, "2026-08-17");
  assert.ok(current);
  current = transitionResolutionCase(current, { type: "options_calculated", occurredOn: "2026-08-17" }, { expectedVersion: 1 });
  assert.equal(current.status, "options_ready");
  current = transitionResolutionCase(current, { type: "options_presented", occurredOn: "2026-08-17" }, { expectedVersion: 2 });
  assert.equal(current.status, "awaiting_decision");
  current = transitionResolutionCase(current, {
    type: "decision_recorded",
    occurredOn: "2026-08-18",
    selectedOptionId: "option-1"
  }, { expectedVersion: 3 });
  assert.equal(current.status, "prepared");
  assert.equal(current.selectedOptionId, "option-1");
  current = transitionResolutionCase(current, { type: "follow_up_started", occurredOn: "2026-08-18" }, { expectedVersion: 4 });
  assert.equal(current.status, "monitoring");
  current = transitionResolutionCase(current, {
    type: "outcome_requires_replan",
    occurredOn: "2026-08-19"
  }, { expectedVersion: 5 });
  assert.equal(current.status, "detected");
  assert.equal(current.version, 6);
  assert.equal(current.nextRequiredAction, "calculate_options");
});

test("confirmation can advance uncertainty while verified rejection can resolve it", () => {
  const uncertain = openResolutionCase(uncertainDecision, "2026-08-17");
  assert.ok(uncertain);
  const confirmed = transitionResolutionCase(
    uncertain,
    { type: "signal_confirmed", occurredOn: "2026-08-18" },
    { expectedVersion: 1 }
  );
  assert.equal(confirmed.status, "detected");

  assert.throws(
    () => transitionResolutionCase(
      uncertain,
      { type: "signal_rejected", occurredOn: "2026-08-18" },
      { expectedVersion: 1 }
    ),
    (error) => error instanceof ResolutionCaseTransitionError
      && error.code === "closure_verification_required"
  );
  const resolved = transitionResolutionCase(
    uncertain,
    { type: "signal_rejected", occurredOn: "2026-08-18" },
    { expectedVersion: 1, closureVerifierApproved: true }
  );
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.terminalReason, "false_positive_verified");
  assert.equal(resolved.nextRequiredAction, "none");
});

test("blocks stale, invalid, backward-dated, and terminal transitions with fixed codes", () => {
  const initial = openResolutionCase(materialDecision, "2026-08-17");
  assert.ok(initial);
  assert.throws(
    () => transitionResolutionCase(initial, { type: "options_calculated", occurredOn: "2026-08-17" }, { expectedVersion: 2 }),
    (error) => error instanceof ResolutionCaseTransitionError && error.code === "stale_case_version"
  );
  assert.throws(
    () => transitionResolutionCase(initial, { type: "follow_up_started", occurredOn: "2026-08-17" }, { expectedVersion: 1 }),
    (error) => error instanceof ResolutionCaseTransitionError && error.code === "invalid_case_transition"
  );
  assert.throws(
    () => transitionResolutionCase(initial, { type: "options_calculated", occurredOn: "2026-08-16" }, { expectedVersion: 1 }),
    (error) => error instanceof ResolutionCaseTransitionError && error.code === "invalid_case_transition"
  );
  assert.throws(
    () => transitionResolutionCase(initial, { type: "options_calculated", occurredOn: "2026-02-30" }, { expectedVersion: 1 })
  );
  const escalated = transitionResolutionCase(initial, {
    type: "escalation_required",
    occurredOn: "2026-08-18",
    reason: "outside_agent_scope"
  }, { expectedVersion: 1 });
  assert.equal(escalated.status, "escalated");
  assert.throws(
    () => transitionResolutionCase(escalated, { type: "options_calculated", occurredOn: "2026-08-19" }, { expectedVersion: 2 }),
    (error) => error instanceof ResolutionCaseTransitionError && error.code === "terminal_case"
  );
});

test("case schema rejects forged history, mismatched version, and extra fields", () => {
  const initial = openResolutionCase(materialDecision, "2026-08-17");
  assert.ok(initial);
  const result = ResolutionCaseSchema.safeParse({
    ...initial,
    version: 9,
    transitionHistory: [{
      ...initial.transitionHistory[0],
      eventType: "options_calculated"
    }]
  });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.issues.some(({ path }) => path.join(".") === "version"));
    assert.ok(result.error.issues.some(({ path }) => path.join(".") === "transitionHistory.0"));
  }
  const extraField = ResolutionCaseSchema.safeParse({ ...initial, unexpected: "not allowed" });
  assert.equal(extraField.success, false);
  if (!extraField.success) {
    assert.ok(extraField.error.issues.some(({ code }) => code === "unrecognized_keys"));
  }
});

test("request store clones and deletes the minimized resolution case", () => {
  const resolutionCase = openResolutionCase(materialDecision, "2026-08-17");
  assert.ok(resolutionCase);
  const store = new PlanStore();
  const plan = FinancialPlanSchema.parse({
    name: "Synthetic user",
    balance: 100,
    paycheck: 200,
    buffer: 25,
    payday: "2026-08-20",
    bills: []
  });
  store.set("case-store", plan, [], undefined, resolutionCase);
  const retrieved = store.getResolutionCase("case-store");
  retrieved.status = "escalated";
  assert.equal(store.getResolutionCase("case-store").status, "detected");
  store.delete("case-store");
  assert.throws(() => store.getResolutionCase("case-store"), /No financial plan is loaded/);
});
