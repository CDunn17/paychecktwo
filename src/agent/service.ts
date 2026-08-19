import { createPaycheckAgent } from "./create-agent.js";
import { settleWithinDeadline, WallClockDeadlineError } from "./execution-budget.js";
import { PlanStore } from "./plan-store.js";
import { finalizeRecommendation, recommendationMatchesPrimaryAnalysis } from "./recommendation-policy.js";
import { inspectUnknownForSensitiveData, sanitizeAgentRequest, summarizeSensitiveData } from "./safety.js";
import { AgentRequestSchema, RecommendationSchema, type AgentRequest } from "./schemas.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_TURN_LIMIT = 9;
const DEFAULT_OUTPUT_TOKEN_LIMIT = 12_000;
const DEFAULT_TOTAL_TOKEN_LIMIT = 100_000;

export class AgentIncompleteError extends Error {
  constructor(
    readonly stopReason: string,
    readonly wallClockMs: number,
    readonly diagnostics: {
      cycles: number | null;
      tokens: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
      completedTools: string[];
      failedTools: string[];
      toolStages: Array<{
        tool: string;
        durationMs: number | null;
        failed: boolean;
        failureCategory: "schema_validation" | "tool_execution" | null;
        validationIssuePaths: string[];
        validationIssueCodes: string[];
      }>;
      modelStages: Array<{
        agentRole: "orchestrator" | "verifier" | "policy-reviewer";
        call: number;
        durationMs: number | null;
        completed: boolean;
        projectedInputTokens: number | null;
        usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
        stopReason: string | null;
        failureCategory: "throttled" | "max_tokens" | "cancelled" | "model_error" | "unknown" | null;
      }>;
      verifierAttempts: Array<{
        attempt: number;
        verdict: "verified" | "corrections_required";
        failedChecks: string[];
      }>;
    }
  ) {
    super(`Agent stopped with ${stopReason} before producing validated structured output after ${wallClockMs} ms.`);
    this.name = "AgentIncompleteError";
  }
}

export class UnsafeAgentOutputError extends Error {
  constructor(readonly categories: string[]) {
    super("The agent response contained sensitive data and was blocked.");
    this.name = "UnsafeAgentOutputError";
  }
}

function positiveNumberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number.`);
  return value;
}

export class PaycheckAgentService {
  private readonly planStore = new PlanStore();

  async advise(rawRequest: unknown) {
    const parsedRequest: AgentRequest = AgentRequestSchema.parse(rawRequest);
    const { request, summary: inputRedactions } = sanitizeAgentRequest(parsedRequest);
    this.planStore.set(request.sessionId, request.plan, request.policySources);
    try {
      const timeoutMs = positiveNumberFromEnv("STRANDS_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
      const startedAt = performance.now();
      const deadlineAtMs = startedAt + timeoutMs;
      const {
        agent,
        trace,
        modelStages,
        verifierAttempts,
        getCapturedStructuredOutput,
        getPolicyReview,
        getVerifierResult,
        getPrimaryAnalysis
      } = createPaycheckAgent(
        this.planStore,
        request.sessionId,
        {
          ephemeral: request.privacy.ephemeral,
          deadlineAtMs,
          finalizationReserveMs: positiveNumberFromEnv("STRANDS_FINALIZATION_RESERVE_MS", 35_000)
        }
      );
      const asOf = request.asOf ?? new Date().toISOString().slice(0, 10);
      const invocationController = new AbortController();
      const invocation = agent.invoke(
        `Session ID: ${request.sessionId}\nAs-of date: ${asOf}\nPolicy sources available: ${request.policySources.length}\nUser request: ${request.message}`,
        {
          cancelSignal: invocationController.signal,
          limits: {
            turns: positiveNumberFromEnv("STRANDS_TURN_LIMIT", DEFAULT_TURN_LIMIT),
            outputTokens: positiveNumberFromEnv("STRANDS_OUTPUT_TOKEN_LIMIT", DEFAULT_OUTPUT_TOKEN_LIMIT),
            totalTokens: positiveNumberFromEnv("STRANDS_TOTAL_TOKEN_LIMIT", DEFAULT_TOTAL_TOKEN_LIMIT)
          }
        }
      );
      let result;
      try {
        result = await settleWithinDeadline({
          operation: invocation,
          deadlineAtMs,
          onDeadline: () => invocationController.abort()
        });
      } catch (error) {
        if (!(error instanceof WallClockDeadlineError)) throw error;
        const wallClockMs = Math.round(performance.now() - startedAt);
        const completedEntries = trace.filter((entry) => entry.phase === "completed");
        throw new AgentIncompleteError("wallClockDeadline", wallClockMs, {
          cycles: null,
          tokens: null,
          completedTools: completedEntries.map((entry) => entry.tool),
          failedTools: completedEntries.filter((entry) => entry.failed).map((entry) => entry.tool),
          toolStages: completedEntries.map((entry) => ({
            tool: entry.tool,
            durationMs: entry.durationMs ?? null,
            failed: entry.failed ?? false,
            failureCategory: entry.failureCategory ?? null,
            validationIssuePaths: [...(entry.validationIssuePaths ?? [])],
            validationIssueCodes: [...(entry.validationIssueCodes ?? [])]
          })),
          modelStages: modelStages.map((stage) => ({
            ...stage,
            usage: stage.usage ? { ...stage.usage } : null
          })),
          verifierAttempts: verifierAttempts.map((attempt) => ({
            ...attempt,
            failedChecks: [...attempt.failedChecks]
          }))
        });
      }
      const wallClockMs = Math.round(performance.now() - startedAt);
      const structuredOutput = result.structuredOutput ?? getCapturedStructuredOutput();
      const completedEntries = trace.filter((entry) => entry.phase === "completed");
      const diagnostics = {
        cycles: result.metrics?.cycleCount ?? null,
        tokens: result.metrics?.accumulatedUsage ?? null,
        completedTools: completedEntries.map((entry) => entry.tool),
        failedTools: completedEntries.filter((entry) => entry.failed).map((entry) => entry.tool),
        toolStages: completedEntries.map((entry) => ({
          tool: entry.tool,
          durationMs: entry.durationMs ?? null,
          failed: entry.failed ?? false,
          failureCategory: entry.failureCategory ?? null,
          validationIssuePaths: [...(entry.validationIssuePaths ?? [])],
          validationIssueCodes: [...(entry.validationIssueCodes ?? [])]
        })),
        modelStages,
        verifierAttempts
      };
      if (completedEntries.some((entry) => entry.failed)) {
        throw new AgentIncompleteError("toolFailed", wallClockMs, diagnostics);
      }
      if (structuredOutput === undefined) {
        throw new AgentIncompleteError(result.stopReason, wallClockMs, diagnostics);
      }
      const verifierSucceeded = completedEntries.some(
        (entry) => entry.tool === "verify_financial_plan" && !entry.failed
      );
      const verifierResult = getVerifierResult();
      if (!verifierSucceeded || verifierResult === undefined) {
        throw new AgentIncompleteError("verificationFailed", wallClockMs, diagnostics);
      }
      const modelRecommendation = finalizeRecommendation(structuredOutput, verifierResult);
      const primaryAnalysis = getPrimaryAnalysis();
      if (
        primaryAnalysis === undefined
        || !recommendationMatchesPrimaryAnalysis(modelRecommendation, primaryAnalysis)
      ) {
        throw new AgentIncompleteError("groundingFailed", wallClockMs, diagnostics);
      }
      const recommendation = RecommendationSchema.parse({
        ...modelRecommendation,
        policyFindings: getPolicyReview()?.findings ?? []
      });
      const outputFindings = inspectUnknownForSensitiveData(recommendation, "recommendation");
      if (outputFindings.length > 0) {
        throw new UnsafeAgentOutputError(
          summarizeSensitiveData(outputFindings).map((finding) => finding.category)
        );
      }
      const toolMetrics = result.metrics?.toolMetrics ?? {};
      const toolCalls = Object.values(toolMetrics).reduce((total, metric) => total + metric.callCount, 0);
      const structuredOutputEntries = trace.filter((entry) => entry.phase === "completed" && entry.tool === "strands_structured_output");
      return {
        recommendation,
        safety: {
          modelInputSanitized: true,
          inputRedactions,
          rawMatchedValuesReturned: false,
          ephemeralSession: request.privacy.ephemeral,
          outputScanPassed: true
        },
        trace,
        metrics: result.metrics ? {
          cycles: result.metrics.cycleCount,
          durationMs: result.metrics.totalDuration,
          wallClockMs,
          toolCalls,
          structuredOutputAttempts: structuredOutputEntries.length,
          structuredOutputFailures: structuredOutputEntries.filter((entry) => entry.failed).length,
          tokens: result.metrics.accumulatedUsage,
          tools: toolMetrics,
          modelStages,
          verifierAttempts
        } : null,
        stopReason: "toolUse"
      };
    } finally {
      if (request.privacy.ephemeral) this.planStore.delete(request.sessionId);
    }
  }
}
