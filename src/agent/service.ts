import { createPaycheckAgent } from "./create-agent.js";
import { PlanStore } from "./plan-store.js";
import { finalizeRecommendation } from "./recommendation-policy.js";
import { AgentRequestSchema, type AgentRequest } from "./schemas.js";

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

function positiveNumberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number.`);
  return value;
}

export class PaycheckAgentService {
  private readonly planStore = new PlanStore();

  async advise(rawRequest: unknown) {
    const request: AgentRequest = AgentRequestSchema.parse(rawRequest);
    this.planStore.set(request.sessionId, request.plan);
    const { agent, trace, getCapturedStructuredOutput } = createPaycheckAgent(this.planStore, request.sessionId);
    const asOf = new Date().toISOString().slice(0, 10);
    const startedAt = performance.now();
    const result = await agent.invoke(
      `Session ID: ${request.sessionId}\nAs-of date: ${asOf}\nUser request: ${request.message}`,
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
    if (structuredOutput === undefined) {
      const completedEntries = trace.filter((entry) => entry.phase === "completed");
      throw new AgentIncompleteError(result.stopReason, wallClockMs, {
        cycles: result.metrics?.cycleCount ?? null,
        tokens: result.metrics?.accumulatedUsage ?? null,
        completedTools: completedEntries.map((entry) => entry.tool),
        failedTools: completedEntries.filter((entry) => entry.failed).map((entry) => entry.tool)
      });
    }
    const recommendation = finalizeRecommendation(structuredOutput);
    const toolMetrics = result.metrics?.toolMetrics ?? {};
    const toolCalls = Object.values(toolMetrics).reduce((total, metric) => total + metric.callCount, 0);
    const structuredOutputEntries = trace.filter((entry) => entry.phase === "completed" && entry.tool === "strands_structured_output");
    return {
      recommendation,
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
  }
}
