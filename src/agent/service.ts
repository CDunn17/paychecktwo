import { createPaycheckAgent } from "./create-agent.js";
import { PlanStore } from "./plan-store.js";
import { finalizeRecommendation } from "./recommendation-policy.js";
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
      const { agent, trace, getCapturedStructuredOutput, getPolicyReview } = createPaycheckAgent(
        this.planStore,
        request.sessionId,
        { ephemeral: request.privacy.ephemeral }
      );
      const asOf = request.asOf ?? new Date().toISOString().slice(0, 10);
      const startedAt = performance.now();
      const result = await agent.invoke(
        `Session ID: ${request.sessionId}\nAs-of date: ${asOf}\nPolicy sources available: ${request.policySources.length}\nUser request: ${request.message}`,
        {
          cancelSignal: AbortSignal.timeout(positiveNumberFromEnv("STRANDS_TIMEOUT_MS", DEFAULT_TIMEOUT_MS)),
          limits: {
            turns: positiveNumberFromEnv("STRANDS_TURN_LIMIT", DEFAULT_TURN_LIMIT),
            outputTokens: positiveNumberFromEnv("STRANDS_OUTPUT_TOKEN_LIMIT", DEFAULT_OUTPUT_TOKEN_LIMIT),
            totalTokens: positiveNumberFromEnv("STRANDS_TOTAL_TOKEN_LIMIT", DEFAULT_TOTAL_TOKEN_LIMIT)
          }
        }
      );
      const wallClockMs = Math.round(performance.now() - startedAt);
      const structuredOutput = result.structuredOutput ?? getCapturedStructuredOutput();
      const completedEntries = trace.filter((entry) => entry.phase === "completed");
      const diagnostics = {
        cycles: result.metrics?.cycleCount ?? null,
        tokens: result.metrics?.accumulatedUsage ?? null,
        completedTools: completedEntries.map((entry) => entry.tool),
        failedTools: completedEntries.filter((entry) => entry.failed).map((entry) => entry.tool)
      };
      if (structuredOutput === undefined) {
        throw new AgentIncompleteError(result.stopReason, wallClockMs, diagnostics);
      }
      const verifierSucceeded = completedEntries.some(
        (entry) => entry.tool === "verify_financial_plan" && !entry.failed
      );
      if (!verifierSucceeded) {
        throw new AgentIncompleteError("verificationFailed", wallClockMs, diagnostics);
      }
      const modelRecommendation = finalizeRecommendation(structuredOutput);
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
          tools: toolMetrics
        } : null,
        stopReason: "toolUse"
      };
    } finally {
      if (request.privacy.ephemeral) this.planStore.delete(request.sessionId);
    }
  }
}
