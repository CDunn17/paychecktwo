import { readFile } from "node:fs/promises";
import { analyzeCashflow, findPressurePoints } from "../src/agent/calculations.js";
import { prepareMonitoringToolResult } from "../src/agent/monitoring-context.js";
import {
  MonitoringRequestContextSchema,
  ResolutionCaseContinuationSchema
} from "../src/agent/request-schemas.js";
import {
  completeResolutionCase,
  createResolutionCaseCompletionEvidence
} from "../src/agent/case-completion.js";
import { openResolutionCase } from "../src/agent/resolution-case.js";
import {
  SyntheticEventStreamSchema,
  replaySyntheticEventStream
} from "../src/agent/synthetic-event-stream.js";
import {
  DisruptionSchema,
  FinancialPlanSchema,
  type ResolutionCaseStatus,
  type VerifierResult
} from "../src/agent/schemas.js";

const fixtures = JSON.parse(await readFile(new URL("./cases.json", import.meta.url), "utf8")) as Array<{
  id: string;
  disruption: unknown;
  expectedTools: string[];
  successCriteria: string[];
  asOf?: string;
  plan?: unknown;
  monitoring?: unknown;
  syntheticEventStream?: unknown;
  caseContinuation?: unknown;
  expectedMonitoringDisposition?: "no_case" | "needs_confirmation" | "open_case";
  expectedResolutionCaseStatus?: "detected" | "needs_confirmation";
  expectedInitialResolutionCaseStatus?: ResolutionCaseStatus;
  expectedFinalResolutionCaseStatus?: ResolutionCaseStatus;
  expectedCaseCompletionAuthorized?: boolean;
  expectedSyntheticEventStream?: {
    checkpointCount: number;
    caseOpened: boolean;
    completionReviewAvailable: boolean;
    hourlyJobCount: number;
    freelanceClientCount: number;
    salariedJobCount: number;
  };
}>;

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

const defaultPlan = FinancialPlanSchema.parse({
  name: "Alex",
  balance: 642,
  paycheck: 1840,
  buffer: 100,
  payday: "2026-08-25",
  periodStart: "2026-08-11",
  bills: [
    { id: "phone", name: "Phone bill", amount: 74, due: "2026-08-18", category: "Utilities" },
    { id: "groceries", name: "Groceries", amount: 95, due: "2026-08-20", category: "Food" },
    { id: "insurance", name: "Car insurance", amount: 126, due: "2026-08-23", category: "Transport" }
  ]
});

for (const fixture of fixtures) {
  const asOf = fixture.asOf ?? "2026-08-17";
  const fixturePlan = FinancialPlanSchema.parse(fixture.plan ?? defaultPlan);
  const eventReplay = fixture.syntheticEventStream
    ? replaySyntheticEventStream(fixturePlan, SyntheticEventStreamSchema.parse(fixture.syntheticEventStream))
    : null;
  const effectivePlan = eventReplay?.effectivePlan ?? fixturePlan;
  const disruption = DisruptionSchema.parse(fixture.disruption);
  const analysis = analyzeCashflow(effectivePlan, asOf, disruption);
  const pressurePoints = findPressurePoints(analysis);
  if (!fixture.expectedTools.includes("verify_financial_plan")) throw new Error(`${fixture.id}: verifier is not required`);
  if (fixture.successCriteria.length < 3) throw new Error(`${fixture.id}: success criteria are too weak`);
  if (eventReplay) {
    const expected = fixture.expectedSyntheticEventStream;
    if (!fixture.expectedTools.includes("analyze_synthetic_event_stream") || !expected) {
      throw new Error(`${fixture.id}: synthetic event-stream expectations are incomplete`);
    }
    if (eventReplay.summary.checkpointCount !== expected.checkpointCount
      || eventReplay.summary.caseOpened !== expected.caseOpened
      || eventReplay.summary.completionReviewAvailable !== expected.completionReviewAvailable
      || eventReplay.summary.sourceKindCounts.hourlyJob !== expected.hourlyJobCount
      || eventReplay.summary.sourceKindCounts.freelanceClient !== expected.freelanceClientCount
      || eventReplay.summary.sourceKindCounts.salariedJob !== expected.salariedJobCount) {
      throw new Error(`${fixture.id}: synthetic event-stream summary does not match fixture expectation`);
    }
  }
  const monitoring = eventReplay?.finalMonitoringResult
    ?? (fixture.monitoring ? prepareMonitoringToolResult(
      fixturePlan,
      asOf,
      MonitoringRequestContextSchema.parse(fixture.monitoring)
    ) : null);
  if (monitoring) {
    if (!fixture.expectedTools.includes("analyze_income_monitoring")) {
      throw new Error(`${fixture.id}: monitoring tool is not required`);
    }
    if (monitoring.caseDecision.disposition !== fixture.expectedMonitoringDisposition) {
      throw new Error(`${fixture.id}: monitoring disposition does not match fixture expectation`);
    }
    const continuation = fixture.caseContinuation
      ? ResolutionCaseContinuationSchema.parse(fixture.caseContinuation)
      : null;
    const resolutionCase = continuation?.priorCase
      ?? eventReplay?.finalResolutionCase
      ?? openResolutionCase(monitoring.caseDecision, asOf);
    const expectedInitialStatus = fixture.expectedInitialResolutionCaseStatus
      ?? fixture.expectedResolutionCaseStatus;
    if (resolutionCase?.status !== expectedInitialStatus) {
      throw new Error(`${fixture.id}: resolution-case status does not match fixture expectation`);
    }
    if (resolutionCase && !fixture.expectedTools.includes("get_resolution_case")) {
      throw new Error(`${fixture.id}: resolution-case tool is not required`);
    }
    const completionCandidate = continuation ? {
      expectedVersion: continuation.expectedVersion,
      outcomeConfirmation: continuation.outcomeConfirmation
    } : eventReplay?.completionCandidate ?? null;
    if (completionCandidate && resolutionCase) {
      if (!fixture.expectedTools.includes("complete_resolution_case")) {
        throw new Error(`${fixture.id}: completion tool is not required`);
      }
      const completion = completeResolutionCase({
        resolutionCase,
        evidence: createResolutionCaseCompletionEvidence({
          resolutionCase,
          expectedVersion: completionCandidate.expectedVersion,
          asOf,
          outcomeConfirmation: completionCandidate.outcomeConfirmation,
          monitoringResult: monitoring
        }),
        verifierResult: verifiedResult
      });
      if (completion.resolutionCase.status !== fixture.expectedFinalResolutionCaseStatus
        || completion.assessment.closureAuthorized !== fixture.expectedCaseCompletionAuthorized) {
        throw new Error(`${fixture.id}: deterministic case-completion result does not match fixture expectation`);
      }
    } else if (fixture.expectedTools.includes("complete_resolution_case")) {
      throw new Error(`${fixture.id}: completion tool is required without a continuation`);
    }
  }
  console.log(`${fixture.id.padEnd(28)} risk=${analysis.riskLevel.padEnd(9)} safe=$${analysis.safeToSpend.toFixed(2).padStart(7)} pressure_points=${pressurePoints.length}`);
}

console.log(`\nValidated ${fixtures.length} deterministic agent-evaluation fixtures.`);
