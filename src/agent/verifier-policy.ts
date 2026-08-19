import {
  VerifierModelResultSchema,
  VerifierResultSchema,
  type VerifierModelResult,
  type VerifierResult
} from "./schemas.js";

const CHECK_POLICIES = [
  ["arithmeticGrounded", "arithmetic", "Use only the deterministic tool amounts and risk result."],
  ["protectedEssentials", "protected_essentials", "Revise the plan so protected essentials and the stated buffer are not treated as optional."],
  ["assumptionsExplicit", "assumption", "Label every unsupported or missing fact as an assumption that needs confirmation."],
  ["externalActionsRemainReadOnly", "external_action", "Describe external actions as user-controlled possibilities that require confirmation or approval."],
  ["policyClaimsSupported", "policy_support", "Keep policy relief conditional and limited to the supplied source support."],
  ["userAutonomyPreserved", "user_autonomy", "Present balanced tradeoffs without praise, moral judgment, or pressure toward a choice."],
  ["harmfulAdviceAbsent", "harmful_advice", "Remove predatory, illegal, deceptive, exploitative, or essentials-sacrificing advice."]
] as const satisfies ReadonlyArray<readonly [
  keyof VerifierResult["checks"],
  VerifierModelResult["failedChecks"][number],
  string
]>;

export function canonicalizeVerifierResult(rawResult: unknown): VerifierResult {
  const result = VerifierModelResultSchema.parse(rawResult);
  const failedCodes = new Set(result.failedChecks);
  const failedChecks = CHECK_POLICIES.filter(([, code]) => failedCodes.has(code));
  const checks = Object.fromEntries(
    CHECK_POLICIES.map(([check, code]) => [check, !failedCodes.has(code)])
  ) as VerifierResult["checks"];
  if (failedChecks.length === 0) {
    return VerifierResultSchema.parse({ verdict: "verified", checks, corrections: [] });
  }

  return VerifierResultSchema.parse({
    verdict: "corrections_required",
    checks,
    corrections: failedChecks.map(([, code, instruction]) => ({
      code,
      instruction
    }))
  });
}

export interface VerifierToolResponse {
  critiqueComplete: true;
  failedChecks: VerifierModelResult["failedChecks"];
  correctionInstructions: string[];
  nextStep: "Apply these corrections directly to the final structured output. Do not call verify_financial_plan again.";
}

export function createVerifierToolResponse(result: VerifierResult): VerifierToolResponse {
  return {
    critiqueComplete: true,
    failedChecks: result.corrections.map(({ code }) => code),
    correctionInstructions: result.corrections.map(({ instruction }) => instruction),
    nextStep: "Apply these corrections directly to the final structured output. Do not call verify_financial_plan again."
  };
}
