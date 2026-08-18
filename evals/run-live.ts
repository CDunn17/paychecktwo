import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
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
  stopReason: string;
}

const baseUrl = process.env.AGENT_BASE_URL ?? "http://127.0.0.1:8787";
const allFixtures = JSON.parse(
  await readFile(new URL("./cases.json", import.meta.url), "utf8")
) as EvaluationFixture[];
const requestedFixtureIds = new Set(process.argv.slice(2));
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

const results = [];

for (const fixture of fixtures) {
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
    completedWithStructuredOutput: responseBody.stopReason === "toolUse"
  };
  const passed = Object.values(automaticChecks).every(Boolean);
  const result = {
    id: fixture.id,
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
    `${passed ? "PASS" : "FAIL"} ${fixture.id.padEnd(28)} ${(result.durationMs / 1000).toFixed(1).padStart(6)}s  cycles=${String(result.cycles).padStart(2)}  tokens=${String(result.tokens?.totalTokens ?? "?").padStart(6)}  schema_attempts=${result.structuredOutputAttempts}`
  );
}

const report = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  passed: results.every((result) => result.passed),
  scenariosPassed: results.filter((result) => result.passed).length,
  scenariosTotal: results.length,
  results
};

console.log(`\n${JSON.stringify(report, null, 2)}`);
if (!report.passed) process.exitCode = 1;
