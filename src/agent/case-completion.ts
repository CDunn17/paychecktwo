import type { MonitoringToolResult } from "./monitoring-policy.js";
import { transitionResolutionCase } from "./resolution-case.js";
import {
  ResolutionCaseCompletionEvidenceSchema,
  ResolutionCaseCompletionResultSchema,
  ResolutionCaseSchema,
  VerifierResultSchema,
  type ResolutionCase,
  type ResolutionCaseCompletionEvidence,
  type ResolutionCaseCompletionResult,
  type ResolutionOutcomeConfirmation,
  type VerifierResult
} from "./schemas.js";

export function createResolutionCaseCompletionEvidence(input: {
  resolutionCase: ResolutionCase;
  expectedVersion: number;
  asOf: string;
  outcomeConfirmation: ResolutionOutcomeConfirmation;
  monitoringResult: MonitoringToolResult;
}): ResolutionCaseCompletionEvidence {
  const resolutionCase = ResolutionCaseSchema.parse(input.resolutionCase);
  return ResolutionCaseCompletionEvidenceSchema.parse({
    caseId: resolutionCase.caseId,
    expectedVersion: input.expectedVersion,
    asOf: input.asOf,
    outcomeConfirmation: input.outcomeConfirmation,
    activeDisruptionCount: input.monitoringResult.caseDecision.activeDisruptionCount,
    protectedObligationRiskCount: input.monitoringResult.caseDecision.protectedObligationRiskCount
  });
}

export function completeResolutionCase(input: {
  resolutionCase: ResolutionCase;
  evidence: ResolutionCaseCompletionEvidence;
  verifierResult: VerifierResult;
}): ResolutionCaseCompletionResult {
  const resolutionCase = ResolutionCaseSchema.parse(input.resolutionCase);
  const evidence = ResolutionCaseCompletionEvidenceSchema.parse(input.evidence);
  const verifierResult = VerifierResultSchema.parse(input.verifierResult);
  const unmetCriteria: Array<
    "case_identity_mismatch"
    | "case_not_monitoring"
    | "stale_case_version"
    | "outcome_date_precedes_case"
    | "active_disruption_remaining"
    | "protected_obligation_risk_remaining"
    | "verifier_not_approved"
  > = [];

  if (evidence.caseId !== resolutionCase.caseId) unmetCriteria.push("case_identity_mismatch");
  if (resolutionCase.status !== "monitoring") unmetCriteria.push("case_not_monitoring");
  if (evidence.expectedVersion !== resolutionCase.version) unmetCriteria.push("stale_case_version");
  if (evidence.asOf < resolutionCase.updatedOn) unmetCriteria.push("outcome_date_precedes_case");
  if (evidence.activeDisruptionCount > 0) unmetCriteria.push("active_disruption_remaining");
  if (evidence.protectedObligationRiskCount > 0) unmetCriteria.push("protected_obligation_risk_remaining");
  if (verifierResult.verdict !== "verified") unmetCriteria.push("verifier_not_approved");

  if (unmetCriteria.length > 0) {
    return ResolutionCaseCompletionResultSchema.parse({
      assessment: {
        reviewed: true,
        closureAuthorized: false,
        unmetCriteria,
        resultingStatus: resolutionCase.status
      },
      resolutionCase
    });
  }

  const reason = evidence.outcomeConfirmation === "risk_cleared"
    ? "risk_cleared_verified"
    : "user_outcome_verified";
  const resolvedCase = transitionResolutionCase(
    resolutionCase,
    { type: "outcome_verified", occurredOn: evidence.asOf, reason },
    {
      expectedVersion: evidence.expectedVersion,
      // This value is derived solely from the parsed verifier result above. It is
      // never accepted from the request or exposed as a model tool parameter.
      closureVerifierApproved: true
    }
  );
  return ResolutionCaseCompletionResultSchema.parse({
    assessment: {
      reviewed: true,
      closureAuthorized: true,
      unmetCriteria: [],
      resultingStatus: "resolved"
    },
    resolutionCase: resolvedCase
  });
}
