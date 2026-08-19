import test from "node:test";
import assert from "node:assert/strict";
import {
  completeResolutionCase,
  createResolutionCaseCompletionEvidence
} from "../src/agent/case-completion.js";
import { openResolutionCase, transitionResolutionCase } from "../src/agent/resolution-case.js";
import {
  ResolutionCaseCompletionEvidenceSchema,
  type MonitoringCaseDecision,
  type ResolutionCase,
  type VerifierResult
} from "../src/agent/schemas.js";
import type { MonitoringToolResult } from "../src/agent/monitoring-policy.js";

const verified: VerifierResult = {
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

const correctionsRequired: VerifierResult = {
  verdict: "corrections_required",
  checks: { ...verified.checks, assumptionsExplicit: false },
  corrections: [{ code: "assumption", instruction: "Label every unsupported fact as an assumption." }]
};

function monitoringCase(): ResolutionCase {
  const decision: MonitoringCaseDecision = {
    disposition: "open_case",
    shouldOpenCase: true,
    reasonCodes: ["protected_obligation_risk"],
    activeDisruptionCount: 1,
    uncertainDisruptionCount: 0,
    protectedObligationRiskCount: 1
  };
  let current = openResolutionCase(decision, "2026-08-10");
  assert.ok(current);
  current = transitionResolutionCase(current, { type: "options_calculated", occurredOn: "2026-08-10" }, { expectedVersion: 1 });
  current = transitionResolutionCase(current, { type: "options_presented", occurredOn: "2026-08-10" }, { expectedVersion: 2 });
  current = transitionResolutionCase(current, {
    type: "decision_recorded",
    occurredOn: "2026-08-11",
    selectedOptionId: "option-1"
  }, { expectedVersion: 3 });
  return transitionResolutionCase(current, { type: "follow_up_started", occurredOn: "2026-08-11" }, { expectedVersion: 4 });
}

function monitoringResult(activeDisruptionCount = 0, protectedObligationRiskCount = 0): MonitoringToolResult {
  return {
    sources: [],
    analysis: {
      assessments: [],
      disruptions: Array.from({ length: activeDisruptionCount }, (_, index) => ({
        sourceId: `income-source-${index + 1}`,
        type: "missing_income" as const,
        active: true,
        detectedOn: "2026-08-17",
        expectedBy: "2026-08-16",
        amountAtIssueCents: 50_000,
        requiresUserConfirmation: false
      })),
      coverage: {
        asOf: "2026-08-17",
        horizonEnd: "2026-08-25",
        conservativeEndingBalanceCents: 20_000,
        typicalEndingBalanceCents: 20_000,
        conservativeLowestBalanceCents: 20_000,
        typicalLowestBalanceCents: 20_000,
        protectedObligationsAtRisk: Array.from({ length: protectedObligationRiskCount }, (_, index) => ({
          obligationId: `obligation-${index + 1}`,
          due: "2026-08-18",
          projectedShortfallCents: 1_000,
          basis: "confirmed_minimum" as const
        }))
      }
    },
    caseDecision: protectedObligationRiskCount > 0 ? {
      disposition: "open_case",
      shouldOpenCase: true,
      reasonCodes: ["protected_obligation_risk"],
      activeDisruptionCount,
      uncertainDisruptionCount: 0,
      protectedObligationRiskCount
    } : {
      disposition: "no_case",
      shouldOpenCase: false,
      reasonCodes: ["no_material_or_uncertain_disruption"],
      activeDisruptionCount,
      uncertainDisruptionCount: 0,
      protectedObligationRiskCount: 0
    }
  };
}

test("derives completion counts from current deterministic monitoring and closes only with a verified verdict", () => {
  const resolutionCase = monitoringCase();
  const evidence = createResolutionCaseCompletionEvidence({
    resolutionCase,
    expectedVersion: 5,
    asOf: "2026-08-17",
    outcomeConfirmation: "risk_cleared",
    monitoringResult: monitoringResult()
  });
  const result = completeResolutionCase({ resolutionCase, evidence, verifierResult: verified });

  assert.deepEqual(evidence, {
    caseId: "case-1",
    expectedVersion: 5,
    asOf: "2026-08-17",
    outcomeConfirmation: "risk_cleared",
    activeDisruptionCount: 0,
    protectedObligationRiskCount: 0
  });
  assert.equal(result.assessment.closureAuthorized, true);
  assert.deepEqual(result.assessment.unmetCriteria, []);
  assert.equal(result.resolutionCase.status, "resolved");
  assert.equal(result.resolutionCase.terminalReason, "risk_cleared_verified");
  assert.equal(result.resolutionCase.version, 6);
});

test("keeps the case open when current disruption, protected risk, or verifier criteria fail", () => {
  const resolutionCase = monitoringCase();
  const evidence = createResolutionCaseCompletionEvidence({
    resolutionCase,
    expectedVersion: 5,
    asOf: "2026-08-17",
    outcomeConfirmation: "resolved_externally",
    monitoringResult: monitoringResult(1, 1)
  });
  const result = completeResolutionCase({
    resolutionCase,
    evidence,
    verifierResult: correctionsRequired
  });

  assert.equal(result.assessment.closureAuthorized, false);
  assert.deepEqual(result.assessment.unmetCriteria, [
    "active_disruption_remaining",
    "protected_obligation_risk_remaining",
    "verifier_not_approved"
  ]);
  assert.equal(result.resolutionCase.status, "monitoring");
  assert.equal(result.resolutionCase.version, 5);
});

test("uses fixed identity, state, version, and date failures without mutating the case", () => {
  const resolutionCase = transitionResolutionCase(
    monitoringCase(),
    { type: "outcome_requires_replan", occurredOn: "2026-08-11" },
    { expectedVersion: 5 }
  );
  const result = completeResolutionCase({
    resolutionCase,
    evidence: {
      caseId: "case-other",
      expectedVersion: 4,
      asOf: "2026-08-10",
      outcomeConfirmation: "risk_cleared",
      activeDisruptionCount: 0,
      protectedObligationRiskCount: 0
    },
    verifierResult: verified
  });

  assert.deepEqual(result.assessment.unmetCriteria, [
    "case_identity_mismatch",
    "case_not_monitoring",
    "stale_case_version",
    "outcome_date_precedes_case"
  ]);
  assert.equal(result.resolutionCase.status, "detected");
});

test("completion evidence is strict and cannot carry a caller-supplied verifier approval", () => {
  const parsed = ResolutionCaseCompletionEvidenceSchema.safeParse({
    caseId: "case-1",
    expectedVersion: 5,
    asOf: "2026-08-17",
    outcomeConfirmation: "risk_cleared",
    activeDisruptionCount: 0,
    protectedObligationRiskCount: 0,
    closureVerifierApproved: true
  });
  assert.equal(parsed.success, false);
});
