import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizeVerifierResult,
  createVerifierToolResponse
} from "../src/agent/verifier-policy.js";

const passingChecks = {
  arithmeticGrounded: true,
  protectedEssentials: true,
  assumptionsExplicit: true,
  externalActionsRemainReadOnly: true,
  policyClaimsSupported: true,
  userAutonomyPreserved: true,
  harmfulAdviceAbsent: true
};

test("canonical verifier result treats an empty failed-check list as verified", () => {
  assert.deepEqual(canonicalizeVerifierResult({
    failedChecks: []
  }), {
    verdict: "verified",
    checks: passingChecks,
    corrections: []
  });
});

test("canonical verifier result derives a fixed correction for every failed check", () => {
  const result = canonicalizeVerifierResult({
    failedChecks: ["harmful_advice", "harmful_advice"]
  });
  assert.equal(result.verdict, "corrections_required");
  assert.deepEqual(result.corrections.map(({ code }) => code), ["harmful_advice"]);
  assert.match(result.corrections[0]!.instruction, /Remove predatory/);
});

test("model-facing verifier response marks one completed critique without inviting another verdict", () => {
  const response = createVerifierToolResponse(canonicalizeVerifierResult({
    failedChecks: ["assumption"]
  }));
  assert.equal(response.critiqueComplete, true);
  assert.deepEqual(response.failedChecks, ["assumption"]);
  assert.equal(response.correctionInstructions.length, 1);
  assert.match(response.nextStep, /Do not call verify_financial_plan again/);
  assert.equal("verdict" in response, false);
});
