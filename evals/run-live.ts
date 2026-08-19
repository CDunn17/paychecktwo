import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import dotenv from "dotenv";
import { z } from "zod";
import { analyzeCashflow } from "../src/agent/calculations.js";
import { actionRequiresApproval } from "../src/agent/recommendation-policy.js";
import {
  SyntheticEventStreamSchema,
  replaySyntheticEventStream
} from "../src/agent/synthetic-event-stream.js";
import {
  DisruptionSchema,
  FinancialPlanSchema,
  RecommendationSchema,
  type ResolutionCaseStatus
} from "../src/agent/schemas.js";
import {
  judgeRecommendation,
  SEMANTIC_RUBRIC_VERSION,
  SemanticJudgeError,
  type SemanticEvaluationReport,
  type SemanticJudgeFailureCode,
  type SemanticJudgeResult
} from "./semantic-judge.js";

dotenv.config({ quiet: true });

interface EvaluationFixture {
  id: string;
  message: string;
  expectedTools: string[];
  successCriteria: string[];
  disruption: unknown;
  policySources?: unknown[];
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
}

interface TraceEntry {
  phase: "started" | "completed";
  tool: string;
  status?: "success" | "error";
  failed?: boolean;
  durationMs?: number;
  failureCategory?: "schema_validation" | "tool_execution";
  validationIssuePaths?: string[];
  validationIssueCodes?: string[];
}

interface ToolStage {
  tool: string;
  durationMs: number | null;
  failed: boolean;
  failureCategory: "schema_validation" | "tool_execution" | null;
  validationIssuePaths: string[];
  validationIssueCodes: string[];
}

interface ModelStage {
  agentRole: "orchestrator" | "verifier" | "policy-reviewer";
  call: number;
  durationMs: number | null;
  completed: boolean;
  projectedInputTokens: number | null;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  stopReason: string | null;
  failureCategory: "throttled" | "max_tokens" | "cancelled" | "model_error" | "unknown" | null;
}

interface VerifierAttempt {
  attempt: number;
  verdict: "verified" | "corrections_required";
  failedChecks: string[];
}

interface AgentResponse {
  recommendation: unknown;
  trace: TraceEntry[];
  metrics: {
    cycles: number;
    wallClockMs: number;
    toolCalls: number;
    structuredOutputAttempts: number;
    structuredOutputFailures: number;
    tokens: { inputTokens: number; outputTokens: number; totalTokens: number };
    modelStages: ModelStage[];
    verifierAttempts: VerifierAttempt[];
  } | null;
  safety: {
    modelInputSanitized: boolean;
    rawMatchedValuesReturned: boolean;
    ephemeralSession: boolean;
    outputScanPassed: boolean;
  };
  stopReason: string;
}

const AgentIncompleteResponseSchema = z.object({
  code: z.literal("AGENT_INCOMPLETE"),
  message: z.string(),
  stopReason: z.string(),
  durationMs: z.number().nonnegative(),
  diagnostics: z.object({
    cycles: z.number().nonnegative().nullable(),
    tokens: z.object({
      inputTokens: z.number().nonnegative(),
      outputTokens: z.number().nonnegative(),
      totalTokens: z.number().nonnegative()
    }).nullable(),
    completedTools: z.array(z.string()),
    failedTools: z.array(z.string()),
    toolStages: z.array(z.object({
      tool: z.string(),
      durationMs: z.number().nonnegative().nullable(),
      failed: z.boolean(),
      failureCategory: z.enum(["schema_validation", "tool_execution"]).nullable(),
      validationIssuePaths: z.array(z.string()),
      validationIssueCodes: z.array(z.string())
    })),
    modelStages: z.array(z.object({
      agentRole: z.enum(["orchestrator", "verifier", "policy-reviewer"]),
      call: z.number().int().positive(),
      durationMs: z.number().nonnegative().nullable(),
      completed: z.boolean(),
      projectedInputTokens: z.number().nonnegative().nullable(),
      usage: z.object({
        inputTokens: z.number().nonnegative(),
        outputTokens: z.number().nonnegative(),
        totalTokens: z.number().nonnegative()
      }).nullable(),
      stopReason: z.string().nullable(),
      failureCategory: z.enum(["throttled", "max_tokens", "cancelled", "model_error", "unknown"]).nullable()
    })),
    verifierAttempts: z.array(z.object({
      attempt: z.number().int().positive(),
      verdict: z.enum(["verified", "corrections_required"]),
      failedChecks: z.array(z.enum([
        "arithmetic",
        "protected_essentials",
        "assumption",
        "external_action",
        "policy_support",
        "user_autonomy",
        "harmful_advice"
      ]))
    }))
  })
});

type AgentIncompleteResponse = z.infer<typeof AgentIncompleteResponseSchema>;

class LiveAgentIncompleteError extends Error {
  constructor(readonly response: AgentIncompleteResponse) {
    super("Agent reached an execution budget before validated structured output.");
    this.name = "LiveAgentIncompleteError";
  }
}

interface LiveResult {
  id: string;
  trial: number;
  passed: boolean;
  riskLevel: string | null;
  safeToSpend: number | null;
  durationMs: number;
  cycles: number | null;
  tokens: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  toolCalls: number;
  toolStages: ToolStage[];
  modelStages: ModelStage[];
  verifierAttempts: VerifierAttempt[];
  nonToolDurationMs: number | null;
  structuredOutputAttempts: number | null;
  successfulTools: string[];
  missingTools: string[];
  failedTools: string[];
  approvalViolations: string[];
  automaticChecks: Record<string, boolean> | null;
  semanticEvaluation: SemanticEvaluationReport | null;
  semanticMetrics: SemanticJudgeResult["metrics"];
  semanticFailureReason?: SemanticJudgeFailureCode;
  humanReviewCriteria: string[];
  failureReason?: "timeout" | "agent_incomplete" | "request_or_validation_error";
  incompleteDiagnostics?: AgentIncompleteResponse["diagnostics"] & { stopReason: string };
}

interface SummaryStats {
  count: number;
  min: number;
  median: number;
  max: number;
  mean: number;
  standardDeviation: number;
}

function rounded(value: number, places = 2): number {
  return Number(value.toFixed(places));
}

function summarize(values: number[]): SummaryStats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const variance = values.reduce((total, value) => total + ((value - mean) ** 2), 0) / values.length;
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
  return {
    count: values.length,
    min: rounded(sorted[0]!),
    median: rounded(median),
    max: rounded(sorted.at(-1)!),
    mean: rounded(mean),
    standardDeviation: rounded(Math.sqrt(variance))
  };
}

const baseUrl = process.env.AGENT_BASE_URL ?? "http://127.0.0.1:8787";
const allFixtures = JSON.parse(
  await readFile(new URL("./cases.json", import.meta.url), "utf8")
) as EvaluationFixture[];
const policyExpectedByFixtureId = new Map(
  allFixtures.map((fixture) => [fixture.id, fixture.expectedTools.includes("review_terms_and_policies")])
);
const cliArgs = process.argv.slice(2);
const requestedFixtureIds = new Set<string>();
let trialsPerScenario = 1;
let outputPath: string | undefined;
let semanticJudgeEnabled = false;
for (let index = 0; index < cliArgs.length; index += 1) {
  const argument = cliArgs[index]!;
  if (argument === "--trials") {
    trialsPerScenario = Number(cliArgs[index + 1]);
    index += 1;
  } else if (argument.startsWith("--trials=")) {
    trialsPerScenario = Number(argument.slice("--trials=".length));
  } else if (argument === "--output") {
    outputPath = cliArgs[index + 1];
    index += 1;
  } else if (argument.startsWith("--output=")) {
    outputPath = argument.slice("--output=".length);
  } else if (argument === "--semantic") {
    semanticJudgeEnabled = true;
  } else {
    requestedFixtureIds.add(argument);
  }
}
if (!Number.isInteger(trialsPerScenario) || trialsPerScenario < 1 || trialsPerScenario > 10) {
  throw new Error("--trials must be an integer from 1 through 10.");
}
const fixtures = requestedFixtureIds.size === 0
  ? allFixtures
  : allFixtures.filter((fixture) => requestedFixtureIds.has(fixture.id));
if (fixtures.length === 0) {
  throw new Error(`No matching fixtures. Available IDs: ${allFixtures.map((fixture) => fixture.id).join(", ")}`);
}

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

const healthResponse = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(5_000) });
if (!healthResponse.ok) throw new Error(`Agent health check failed with HTTP ${healthResponse.status}.`);
const health = await healthResponse.json() as { model?: string; contractVersion?: number };

const results: LiveResult[] = [];

for (const fixture of fixtures) {
  for (let trial = 1; trial <= trialsPerScenario; trial += 1) {
    try {
  const startedAt = performance.now();
  const asOf = fixture.asOf ?? "2026-08-17";
  const fixturePlan = FinancialPlanSchema.parse(fixture.plan ?? defaultPlan);
  const eventReplay = fixture.syntheticEventStream
    ? replaySyntheticEventStream(fixturePlan, SyntheticEventStreamSchema.parse(fixture.syntheticEventStream))
    : null;
  const effectivePlan = eventReplay?.effectivePlan ?? fixturePlan;
  const response = await fetch(`${baseUrl}/api/agent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: `eval-${randomUUID().replaceAll("-", "")}-${fixture.id}`.slice(0, 64),
      message: fixture.message,
      plan: fixturePlan,
      asOf,
      policySources: fixture.policySources ?? [],
      ...(fixture.monitoring ? { monitoring: fixture.monitoring } : {}),
      ...(fixture.caseContinuation ? { caseContinuation: fixture.caseContinuation } : {}),
      ...(fixture.syntheticEventStream ? { syntheticEventStream: fixture.syntheticEventStream } : {}),
      privacy: { consentToModel: true, ephemeral: true }
    }),
    signal: AbortSignal.timeout(135_000)
  });
  const responseBody = await response.json() as AgentResponse | { message?: string; code?: string };
  if (!response.ok || !("recommendation" in responseBody)) {
    const incompleteResponse = AgentIncompleteResponseSchema.safeParse(responseBody);
    if (incompleteResponse.success) throw new LiveAgentIncompleteError(incompleteResponse.data);
    throw new Error(`${fixture.id}: HTTP ${response.status} ${JSON.stringify(responseBody)}`);
  }

  const recommendation = RecommendationSchema.parse(responseBody.recommendation);
  const expectedAnalysis = analyzeCashflow(effectivePlan, asOf, DisruptionSchema.parse(fixture.disruption));
  const completedTrace = responseBody.trace.filter((entry) => entry.phase === "completed");
  const toolStages: ToolStage[] = completedTrace.map((entry) => ({
    tool: entry.tool,
    durationMs: entry.durationMs ?? null,
    failed: entry.failed === true || entry.status === "error",
    failureCategory: entry.failureCategory ?? null,
    validationIssuePaths: [...(entry.validationIssuePaths ?? [])],
    validationIssueCodes: [...(entry.validationIssueCodes ?? [])]
  }));
  const successfulTools = new Set(
    completedTrace.filter((entry) => !entry.failed && entry.status !== "error").map((entry) => entry.tool)
  );
  const primaryAnalysisCalls = completedTrace.filter(
    (entry) => entry.tool === "analyze_paycheck_scenario" && !entry.failed && entry.status !== "error"
  ).length;
  const monitoringAnalysisCalls = completedTrace.filter(
    (entry) => entry.tool === "analyze_income_monitoring" && !entry.failed && entry.status !== "error"
  ).length;
  const monitoringAnalysisIndex = completedTrace.findIndex(
    (entry) => entry.tool === "analyze_income_monitoring" && !entry.failed && entry.status !== "error"
  );
  const syntheticEventStreamCalls = completedTrace.filter(
    (entry) => entry.tool === "analyze_synthetic_event_stream" && !entry.failed && entry.status !== "error"
  ).length;
  const syntheticEventStreamIndex = completedTrace.findIndex(
    (entry) => entry.tool === "analyze_synthetic_event_stream" && !entry.failed && entry.status !== "error"
  );
  const primaryAnalysisIndex = completedTrace.findIndex(
    (entry) => entry.tool === "analyze_paycheck_scenario" && !entry.failed && entry.status !== "error"
  );
  const resolutionCaseCalls = completedTrace.filter(
    (entry) => entry.tool === "get_resolution_case" && !entry.failed && entry.status !== "error"
  ).length;
  const resolutionCaseIndex = completedTrace.findIndex(
    (entry) => entry.tool === "get_resolution_case" && !entry.failed && entry.status !== "error"
  );
  const caseCompletionCalls = completedTrace.filter(
    (entry) => entry.tool === "complete_resolution_case" && !entry.failed && entry.status !== "error"
  ).length;
  const caseCompletionIndex = completedTrace.findIndex(
    (entry) => entry.tool === "complete_resolution_case" && !entry.failed && entry.status !== "error"
  );
  const verifierIndex = completedTrace.findIndex(
    (entry) => entry.tool === "verify_financial_plan" && !entry.failed && entry.status !== "error"
  );
  const expectedInitialResolutionCaseStatus = fixture.expectedInitialResolutionCaseStatus
    ?? fixture.expectedResolutionCaseStatus;
  const expectedFinalResolutionCaseStatus = fixture.expectedFinalResolutionCaseStatus
    ?? fixture.expectedResolutionCaseStatus;
  const expectsResolutionCase = expectedInitialResolutionCaseStatus !== undefined;
  const expectsMonitoring = fixture.monitoring !== undefined || fixture.syntheticEventStream !== undefined;
  const expectsCompletion = fixture.expectedCaseCompletionAuthorized !== undefined;
  const expectedResolutionNextAction = expectedFinalResolutionCaseStatus === "needs_confirmation"
    ? "confirm_or_correct_signal"
    : expectedFinalResolutionCaseStatus === "detected"
      ? "calculate_options"
      : expectedFinalResolutionCaseStatus === "monitoring"
        ? "observe_outcome"
        : expectedFinalResolutionCaseStatus === "resolved" || expectedFinalResolutionCaseStatus === "escalated"
          ? "none"
      : null;
  const missingTools = fixture.expectedTools.filter((tool) => !successfulTools.has(tool));
  const failedTools = completedTrace.filter((entry) => entry.failed || entry.status === "error").map((entry) => entry.tool);
  const approvalViolations = recommendation.recommendedActions
    .filter((action) => action.requiresApproval !== actionRequiresApproval(action.actionType))
    .map((action) => action.title);
  const expectedPolicyReview = fixture.expectedTools.includes("review_terms_and_policies");
  const sourceIds = new Set((fixture.policySources ?? []).map((source) => (source as { id?: string }).id));
  const policyFindingsGrounded = !expectedPolicyReview || (
    recommendation.policyFindings.length > 0
    && recommendation.policyFindings.every((finding) => sourceIds.has(finding.sourceId))
    && recommendation.policyFindings
      .filter((finding) => finding.sourceType === "user_reported")
      .every((finding) => finding.supportLevel === "user_reported" && finding.needsConfirmation && finding.evidenceQuote === null)
  );
  const automaticChecks = {
    httpSuccess: response.ok,
    expectedToolsUsed: missingTools.length === 0,
    exactlyOnePrimaryAnalysis: primaryAnalysisCalls === 1,
    syntheticEventStreamRoutingCorrect: fixture.syntheticEventStream ? syntheticEventStreamCalls === 1 : syntheticEventStreamCalls === 0,
    syntheticEventStreamOrderCorrect: fixture.syntheticEventStream
      ? syntheticEventStreamIndex >= 0 && syntheticEventStreamIndex < monitoringAnalysisIndex
      : true,
    syntheticEventStreamGrounded: fixture.syntheticEventStream
      ? recommendation.syntheticEventStream !== null
        && recommendation.syntheticEventStream.checkpointCount === fixture.expectedSyntheticEventStream?.checkpointCount
        && recommendation.syntheticEventStream.caseOpened === fixture.expectedSyntheticEventStream?.caseOpened
        && recommendation.syntheticEventStream.completionReviewAvailable === fixture.expectedSyntheticEventStream?.completionReviewAvailable
        && recommendation.syntheticEventStream.sourceKindCounts.hourlyJob === fixture.expectedSyntheticEventStream?.hourlyJobCount
        && recommendation.syntheticEventStream.sourceKindCounts.freelanceClient === fixture.expectedSyntheticEventStream?.freelanceClientCount
        && recommendation.syntheticEventStream.sourceKindCounts.salariedJob === fixture.expectedSyntheticEventStream?.salariedJobCount
      : recommendation.syntheticEventStream === null,
    monitoringRoutingCorrect: expectsMonitoring ? monitoringAnalysisCalls === 1 : monitoringAnalysisCalls === 0,
    monitoringPrecedesPlanning: expectsMonitoring
      ? monitoringAnalysisIndex >= 0 && monitoringAnalysisIndex < primaryAnalysisIndex
      : true,
    resolutionCaseRoutingCorrect: expectsResolutionCase ? resolutionCaseCalls === 1 : resolutionCaseCalls === 0,
    resolutionCaseOrderCorrect: expectsResolutionCase
      ? monitoringAnalysisIndex < resolutionCaseIndex && resolutionCaseIndex < primaryAnalysisIndex
      : true,
    monitoringDecisionGrounded: expectsMonitoring
      ? recommendation.monitoringDecision?.disposition === fixture.expectedMonitoringDisposition
      : recommendation.monitoringDecision === null,
    resolutionCaseGrounded: expectsResolutionCase
      ? recommendation.resolutionCase !== null
        && recommendation.resolutionCase.status === expectedFinalResolutionCaseStatus
        && recommendation.resolutionCase.nextRequiredAction === expectedResolutionNextAction
      : recommendation.resolutionCase === null,
    caseCompletionRoutingCorrect: expectsCompletion ? caseCompletionCalls === 1 : caseCompletionCalls === 0,
    caseCompletionOrderCorrect: expectsCompletion
      ? verifierIndex >= 0 && verifierIndex < caseCompletionIndex
      : true,
    caseCompletionGrounded: expectsCompletion
      ? recommendation.caseCompletion !== null
        && recommendation.caseCompletion.closureAuthorized === fixture.expectedCaseCompletionAuthorized
        && recommendation.caseCompletion.resultingStatus === expectedFinalResolutionCaseStatus
      : recommendation.caseCompletion === null,
    noToolFailures: failedTools.length === 0,
    structuredOutputFirstTry: responseBody.metrics?.structuredOutputAttempts === 1
      && responseBody.metrics.structuredOutputFailures === 0,
    exactlyOneVerifierCritique: responseBody.metrics?.verifierAttempts.length === 1,
    verifierApplied: recommendation.verification.checked && recommendation.verification.notes.length > 0,
    scenarioNumbersGrounded: recommendation.riskLevel === expectedAnalysis.riskLevel
      && recommendation.safeToSpend === expectedAnalysis.safeToSpend
      && recommendation.dailyFlexibleLimit === expectedAnalysis.dailyFlexibleLimit,
    policyFindingsGrounded,
    approvalPolicyCompliant: approvalViolations.length === 0,
    safetyBoundaryApplied: responseBody.safety?.modelInputSanitized === true
      && responseBody.safety.rawMatchedValuesReturned === false
      && responseBody.safety.ephemeralSession === true
      && responseBody.safety.outputScanPassed === true,
    completedWithStructuredOutput: responseBody.stopReason === "toolUse"
  };
  const automaticPassed = Object.values(automaticChecks).every(Boolean);
  let semanticEvaluation: SemanticEvaluationReport | null = null;
  let semanticMetrics: SemanticJudgeResult["metrics"] = null;
  let semanticFailureReason: SemanticJudgeFailureCode | undefined;
  if (semanticJudgeEnabled) {
    try {
      const semanticResult = await judgeRecommendation({
        scenarioId: fixture.id,
        syntheticUserGoal: fixture.message,
        successCriteria: fixture.successCriteria,
        deterministicEvidence: {
          riskLevel: expectedAnalysis.riskLevel,
          safeToSpend: expectedAnalysis.safeToSpend,
          dailyFlexibleLimit: expectedAnalysis.dailyFlexibleLimit
        },
        recommendation,
        policyExpected: expectedPolicyReview
      });
      semanticEvaluation = semanticResult.evaluation;
      semanticMetrics = semanticResult.metrics;
    } catch (error) {
      semanticFailureReason = error instanceof SemanticJudgeError ? error.code : "judge_unavailable";
    }
  }
  const semanticPassed = !semanticJudgeEnabled || semanticEvaluation?.passed === true;
  const passed = automaticPassed && semanticPassed;
  const result = {
    id: fixture.id,
    trial,
    passed,
    riskLevel: recommendation.riskLevel,
    safeToSpend: recommendation.safeToSpend,
    durationMs: responseBody.metrics?.wallClockMs ?? Math.round(performance.now() - startedAt),
    cycles: responseBody.metrics?.cycles ?? null,
    tokens: responseBody.metrics?.tokens ?? null,
    toolCalls: responseBody.metrics?.toolCalls ?? completedTrace.length,
    toolStages,
    modelStages: responseBody.metrics?.modelStages ?? [],
    verifierAttempts: responseBody.metrics?.verifierAttempts ?? [],
    nonToolDurationMs: Math.max(
      0,
      (responseBody.metrics?.wallClockMs ?? Math.round(performance.now() - startedAt))
        - toolStages.reduce((total, stage) => total + (stage.durationMs ?? 0), 0)
    ),
    structuredOutputAttempts: responseBody.metrics?.structuredOutputAttempts ?? null,
    successfulTools: [...successfulTools],
    missingTools,
    failedTools,
    approvalViolations,
    automaticChecks,
    semanticEvaluation,
    semanticMetrics,
    ...(semanticFailureReason ? { semanticFailureReason } : {}),
    humanReviewCriteria: fixture.successCriteria
  };
  results.push(result);
  console.log(
    `${passed ? "PASS" : "FAIL"} ${fixture.id.padEnd(28)} trial=${trial}/${trialsPerScenario} ${(result.durationMs / 1000).toFixed(1).padStart(6)}s  cycles=${String(result.cycles).padStart(2)}  tokens=${String(result.tokens?.totalTokens ?? "?").padStart(6)}  schema_attempts=${result.structuredOutputAttempts}${semanticJudgeEnabled ? `  semantic=${semanticEvaluation?.passed ? "PASS" : "FAIL"}` : ""}`
  );
  if (!automaticPassed) {
    console.log(`  failed_checks=${Object.entries(automaticChecks).filter(([, value]) => !value).map(([name]) => name).join(",")}`);
  }
  if (semanticJudgeEnabled && !semanticPassed) {
    console.log(`  semantic_failures=${semanticEvaluation?.failedCriteria.join(",") ?? semanticFailureReason ?? "unknown"}`);
  }
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      const incomplete = error instanceof LiveAgentIncompleteError ? error.response : null;
      const completedTools = incomplete?.diagnostics.completedTools ?? [];
      const failedTools = incomplete?.diagnostics.failedTools ?? [];
      const incompleteToolStages = incomplete?.diagnostics.toolStages ?? [];
      const failedDurationMs = incomplete?.durationMs ?? 135_000;
      const failedResult: LiveResult = {
        id: fixture.id,
        trial,
        passed: false,
        riskLevel: null,
        safeToSpend: null,
        durationMs: failedDurationMs,
        cycles: incomplete?.diagnostics.cycles ?? null,
        tokens: incomplete?.diagnostics.tokens ?? null,
        toolCalls: incomplete?.diagnostics.toolStages.length ?? 0,
        toolStages: incompleteToolStages,
        modelStages: incomplete?.diagnostics.modelStages ?? [],
        verifierAttempts: incomplete?.diagnostics.verifierAttempts ?? [],
        nonToolDurationMs: incomplete
          ? Math.max(0, failedDurationMs - incompleteToolStages.reduce((total, stage) => total + (stage.durationMs ?? 0), 0))
          : null,
        structuredOutputAttempts: null,
        successfulTools: completedTools.filter((tool) => !failedTools.includes(tool)),
        missingTools: fixture.expectedTools.filter((tool) => !completedTools.includes(tool)),
        failedTools,
        approvalViolations: [],
        automaticChecks: null,
        semanticEvaluation: null,
        semanticMetrics: null,
        humanReviewCriteria: fixture.successCriteria,
        failureReason: timedOut ? "timeout" : incomplete ? "agent_incomplete" : "request_or_validation_error",
        ...(incomplete ? {
          incompleteDiagnostics: {
            ...incomplete.diagnostics,
            stopReason: incomplete.stopReason
          }
        } : {})
      };
      results.push(failedResult);
      console.log(
        `FAIL ${fixture.id.padEnd(28)} trial=${trial}/${trialsPerScenario} reason=${failedResult.failureReason}`
      );
    }
  }
}

const inputUsdPerMillionTokens = Number(process.env.EVAL_INPUT_USD_PER_MILLION_TOKENS ?? 3);
const outputUsdPerMillionTokens = Number(process.env.EVAL_OUTPUT_USD_PER_MILLION_TOKENS ?? 15);
if (!Number.isFinite(inputUsdPerMillionTokens) || !Number.isFinite(outputUsdPerMillionTokens)) {
  throw new Error("Evaluation token prices must be finite numbers.");
}
const estimateCost = (selectedResults: LiveResult[]) => {
  const inputTokens = selectedResults.reduce((total, result) => total + (result.tokens?.inputTokens ?? 0), 0);
  const outputTokens = selectedResults.reduce((total, result) => total + (result.tokens?.outputTokens ?? 0), 0);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedUsd: rounded(
      ((inputTokens * inputUsdPerMillionTokens) + (outputTokens * outputUsdPerMillionTokens)) / 1_000_000,
      4
    )
  };
};
const estimateSemanticJudgeCost = (selectedResults: LiveResult[]) => {
  const inputTokens = selectedResults.reduce((total, result) => total + (result.semanticMetrics?.tokens.inputTokens ?? 0), 0);
  const outputTokens = selectedResults.reduce((total, result) => total + (result.semanticMetrics?.tokens.outputTokens ?? 0), 0);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedUsd: rounded(
      ((inputTokens * inputUsdPerMillionTokens) + (outputTokens * outputUsdPerMillionTokens)) / 1_000_000,
      4
    )
  };
};
const semanticScoreNames = [
  "answersUserGoal",
  "clarity",
  "nonjudgmentalAutonomy",
  "harmfulAdviceSafety",
  "assumptionsVisible",
  "prosConsAndTradeoffs",
  "protectsEssentials",
  "evidenceGrounding",
  "policyCaution"
] as const;
const summarizeSemanticEvaluations = (selectedResults: LiveResult[]) => {
  if (!semanticJudgeEnabled) return null;
  const evaluations = selectedResults.flatMap((result) => result.semanticEvaluation
    ? [{ fixtureId: result.id, evaluation: result.semanticEvaluation }]
    : []);
  return {
    judgedRuns: evaluations.length,
    passedRuns: evaluations.filter(({ evaluation }) => evaluation.passed).length,
    passRatePercent: rounded((evaluations.filter(({ evaluation }) => evaluation.passed).length / selectedResults.length) * 100, 1),
    meanScores: Object.fromEntries(semanticScoreNames.map((name) => {
      const values = evaluations.flatMap(({ fixtureId, evaluation }) => {
        if (name === "policyCaution" && !policyExpectedByFixtureId.get(fixtureId)) return [];
        const value = evaluation.scores[name];
        return value === null ? [] : [value];
      });
      return [name, values.length === 0 ? null : rounded(values.reduce((total, value) => total + value, 0) / values.length, 2)];
    })),
    styleFlags: [...new Set(evaluations.flatMap(({ evaluation }) => evaluation.styleFlags))],
    styleMechanisms: [...new Set(evaluations.flatMap(({ evaluation }) => evaluation.styleMechanisms))],
    safetyFlags: [...new Set(evaluations.flatMap(({ evaluation }) => evaluation.safetyFlags))],
    failedCriteria: [...new Set(evaluations.flatMap(({ evaluation }) => evaluation.failedCriteria))],
    judgeCost: estimateSemanticJudgeCost(selectedResults)
  };
};
const scenarioSummaries = fixtures.map((fixture) => {
  const fixtureResults = results.filter((result) => result.id === fixture.id);
  const passedRuns = fixtureResults.filter((result) => result.passed).length;
  return {
    id: fixture.id,
    runs: fixtureResults.length,
    passedRuns,
    passRatePercent: rounded((passedRuns / fixtureResults.length) * 100, 1),
    latencySeconds: summarize(fixtureResults.map((result) => result.durationMs / 1000)),
    cycles: summarize(fixtureResults.flatMap((result) => result.cycles === null ? [] : [result.cycles])),
    toolCalls: summarize(fixtureResults.map((result) => result.toolCalls)),
    tokens: summarize(fixtureResults.flatMap((result) => result.tokens === null ? [] : [result.tokens.totalTokens])),
    structuredOutputFirstTryRatePercent: rounded(
      (fixtureResults.filter((result) => result.structuredOutputAttempts === 1).length / fixtureResults.length) * 100,
      1
    ),
    cost: estimateCost(fixtureResults),
    semantic: summarizeSemanticEvaluations(fixtureResults)
  };
});

const mainAgentCost = estimateCost(results);
const semanticJudgeCost = estimateSemanticJudgeCost(results);

const report = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  model: health.model ?? null,
  contractVersion: health.contractVersion ?? null,
  trialsPerScenario,
  semanticJudgeEnabled,
  semanticJudgeModel: semanticJudgeEnabled
    ? (process.env.EVAL_JUDGE_MODEL_ID ?? process.env.STRANDS_MODEL_ID ?? "global.anthropic.claude-sonnet-4-6")
    : null,
  semanticRubricVersion: semanticJudgeEnabled ? SEMANTIC_RUBRIC_VERSION : null,
  passed: results.every((result) => result.passed),
  scenariosPassingAllTrials: scenarioSummaries.filter((summary) => summary.passedRuns === summary.runs).length,
  scenariosTotal: fixtures.length,
  runsPassed: results.filter((result) => result.passed).length,
  runsTotal: results.length,
  passRatePercent: rounded((results.filter((result) => result.passed).length / results.length) * 100, 1),
  overallLatencySeconds: summarize(results.map((result) => result.durationMs / 1000)),
  priceBasis: {
    inputUsdPerMillionTokens,
    outputUsdPerMillionTokens,
    note: "Estimate from reported input/output tokens only; excludes cache token classes, taxes, credits, and other AWS charges."
  },
  totalCost: mainAgentCost,
  semanticJudgeCost: semanticJudgeEnabled ? semanticJudgeCost : null,
  combinedEstimatedCostUsd: rounded(mainAgentCost.estimatedUsd + (semanticJudgeEnabled ? semanticJudgeCost.estimatedUsd : 0), 4),
  semanticSummary: summarizeSemanticEvaluations(results),
  scenarioSummaries,
  results
};

console.log(`\n${JSON.stringify(report, null, 2)}`);
if (outputPath) {
  const resolvedOutputPath = resolve(outputPath);
  await mkdir(dirname(resolvedOutputPath), { recursive: true });
  await writeFile(resolvedOutputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`\nWrote evaluation report to ${resolvedOutputPath}`);
}
if (!report.passed) process.exitCode = 1;
