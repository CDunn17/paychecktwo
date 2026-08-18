import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { analyzeCashflow } from "../src/agent/calculations.js";
import { actionRequiresApproval } from "../src/agent/recommendation-policy.js";
import {
  DisruptionSchema,
  FinancialPlanSchema,
  RecommendationSchema
} from "../src/agent/schemas.js";

interface EvaluationFixture {
  id: string;
  message: string;
  expectedTools: string[];
  successCriteria: string[];
  disruption: unknown;
  policySources?: unknown[];
}

interface TraceEntry {
  phase: "started" | "completed";
  tool: string;
  status?: "success" | "error";
  failed?: boolean;
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
  } | null;
  safety: {
    modelInputSanitized: boolean;
    rawMatchedValuesReturned: boolean;
    ephemeralSession: boolean;
    outputScanPassed: boolean;
  };
  stopReason: string;
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
  structuredOutputAttempts: number | null;
  successfulTools: string[];
  missingTools: string[];
  failedTools: string[];
  approvalViolations: string[];
  automaticChecks: Record<string, boolean> | null;
  humanReviewCriteria: string[];
  failureReason?: "timeout" | "request_or_validation_error";
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
const cliArgs = process.argv.slice(2);
const requestedFixtureIds = new Set<string>();
let trialsPerScenario = 1;
let outputPath: string | undefined;
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

const plan = FinancialPlanSchema.parse({
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
  const response = await fetch(`${baseUrl}/api/agent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: `eval-${randomUUID().replaceAll("-", "")}-${fixture.id}`.slice(0, 64),
      message: fixture.message,
      plan,
      asOf: "2026-08-17",
      policySources: fixture.policySources ?? [],
      privacy: { consentToModel: true, ephemeral: true }
    }),
    signal: AbortSignal.timeout(135_000)
  });
  const responseBody = await response.json() as AgentResponse | { message?: string; code?: string };
  if (!response.ok || !("recommendation" in responseBody)) {
    throw new Error(`${fixture.id}: HTTP ${response.status} ${JSON.stringify(responseBody)}`);
  }

  const recommendation = RecommendationSchema.parse(responseBody.recommendation);
  const expectedAnalysis = analyzeCashflow(plan, "2026-08-17", DisruptionSchema.parse(fixture.disruption));
  const completedTrace = responseBody.trace.filter((entry) => entry.phase === "completed");
  const successfulTools = new Set(
    completedTrace.filter((entry) => !entry.failed && entry.status !== "error").map((entry) => entry.tool)
  );
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
    noToolFailures: failedTools.length === 0,
    structuredOutputFirstTry: responseBody.metrics?.structuredOutputAttempts === 1
      && responseBody.metrics.structuredOutputFailures === 0,
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
  const passed = Object.values(automaticChecks).every(Boolean);
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
    structuredOutputAttempts: responseBody.metrics?.structuredOutputAttempts ?? null,
    successfulTools: [...successfulTools],
    missingTools,
    failedTools,
    approvalViolations,
    automaticChecks,
    humanReviewCriteria: fixture.successCriteria
  };
  results.push(result);
  console.log(
    `${passed ? "PASS" : "FAIL"} ${fixture.id.padEnd(28)} trial=${trial}/${trialsPerScenario} ${(result.durationMs / 1000).toFixed(1).padStart(6)}s  cycles=${String(result.cycles).padStart(2)}  tokens=${String(result.tokens?.totalTokens ?? "?").padStart(6)}  schema_attempts=${result.structuredOutputAttempts}`
  );
  if (!passed) {
    console.log(`  failed_checks=${Object.entries(automaticChecks).filter(([, value]) => !value).map(([name]) => name).join(",")}`);
  }
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      const failedResult: LiveResult = {
        id: fixture.id,
        trial,
        passed: false,
        riskLevel: null,
        safeToSpend: null,
        durationMs: 135_000,
        cycles: null,
        tokens: null,
        toolCalls: 0,
        structuredOutputAttempts: null,
        successfulTools: [],
        missingTools: fixture.expectedTools,
        failedTools: [],
        approvalViolations: [],
        automaticChecks: null,
        humanReviewCriteria: fixture.successCriteria,
        failureReason: timedOut ? "timeout" : "request_or_validation_error"
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
    cost: estimateCost(fixtureResults)
  };
});

const report = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  model: health.model ?? null,
  contractVersion: health.contractVersion ?? null,
  trialsPerScenario,
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
  totalCost: estimateCost(results),
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
