import {
  Agent,
  AfterToolsEvent,
  AfterToolCallEvent,
  BedrockModel,
  BeforeToolCallEvent,
  SessionManager,
  tool
} from "@strands-agents/sdk";
import { LocalFileStorage } from "@strands-agents/sdk/storage";
import { z } from "zod";
import { normalizeBedrockApiKeyHeader } from "./bedrock-auth.js";
import { createFinancialTools } from "./tools.js";
import { ORCHESTRATOR_PROMPT, VERIFIER_PROMPT } from "./prompts.js";
import { AgentRecommendationSchema } from "./schemas.js";
import type { PlanStore } from "./plan-store.js";

export interface AgentTraceEntry {
  phase: "started" | "completed";
  tool: string;
  timestamp: string;
  status?: "success" | "error";
  durationMs?: number;
  failed?: boolean;
}

export interface AgentRuntime {
  agent: Agent;
  trace: AgentTraceEntry[];
  getCapturedStructuredOutput: () => unknown | undefined;
}

export function createPaycheckAgent(planStore: PlanStore, sessionId: string): AgentRuntime {
  const bedrockApiKey = process.env.AWS_BEARER_TOKEN_BEDROCK;
  const model = new BedrockModel({
    region: process.env.AWS_REGION ?? "us-east-1",
    modelId: process.env.STRANDS_MODEL_ID ?? "global.anthropic.claude-sonnet-4-6",
    maxTokens: Number(process.env.STRANDS_MODEL_MAX_TOKENS ?? 2500),
    temperature: 0.1,
    ...(bedrockApiKey ? { apiKey: bedrockApiKey } : {})
  });
  if (bedrockApiKey) normalizeBedrockApiKeyHeader(model, bedrockApiKey);

  const verifier = new Agent({
    id: "plan-verifier",
    name: "Paycheck Plan Verifier",
    description: "Checks a proposed paycheck plan for arithmetic grounding, protected essentials, unsupported assumptions, and unsafe recommendations.",
    model,
    systemPrompt: VERIFIER_PROMPT,
    printer: false
  });

  const sessionManager = new SessionManager({
    sessionId,
    storage: new LocalFileStorage(process.env.STRANDS_SESSION_DIR ?? ".strands"),
    saveLatestOn: "invocation"
  });

  const verifyFinancialPlan = tool({
    name: "verify_financial_plan",
    description: "Independently check the proposed recommendation and its tool evidence before answering the user.",
    inputSchema: z.object({ input: z.string().min(1) }),
    callback: async ({ input }, context) => {
      if (!context) throw new Error("Plan verifier requires an agent tool context.");
      const verifierTimeout = AbortSignal.timeout(Number(process.env.STRANDS_VERIFIER_TIMEOUT_MS ?? 30_000));
      const result = await verifier.invoke(input, {
        cancelSignal: AbortSignal.any([context.agent.cancelSignal, verifierTimeout]),
        invocationState: context.invocationState,
        limits: { turns: 1, outputTokens: 2_000, totalTokens: 25_000 }
      });
      if (result.stopReason === "cancelled") throw new Error("Plan verification timed out.");
      return result.toString();
    }
  });

  const agent = new Agent({
    id: "paycheck-two-orchestrator",
    name: "Paycheck Two",
    description: "Builds and verifies resilient plans between paychecks.",
    model,
    systemPrompt: ORCHESTRATOR_PROMPT,
    tools: [
      ...createFinancialTools(planStore),
      verifyFinancialPlan
    ],
    structuredOutputSchema: AgentRecommendationSchema,
    sessionManager,
    toolExecutor: "sequential",
    contextManager: "auto",
    printer: false,
    traceAttributes: {
      "app.name": "paycheck-two",
      "app.session_id": sessionId
    }
  });

  const trace: AgentTraceEntry[] = [];
  let capturedStructuredOutput: unknown | undefined;
  const toolStartedAt = new Map<string, number>();
  agent.addHook(BeforeToolCallEvent, (event) => {
    toolStartedAt.set(event.toolUse.toolUseId, performance.now());
    trace.push({ phase: "started", tool: event.toolUse.name, timestamp: new Date().toISOString() });
  });
  agent.addHook(AfterToolCallEvent, (event) => {
    const startedAt = toolStartedAt.get(event.toolUse.toolUseId);
    const failed = Boolean(event.error) || event.result.status === "error";
    trace.push({
      phase: "completed",
      tool: event.toolUse.name,
      timestamp: new Date().toISOString(),
      status: failed ? "error" : "success",
      durationMs: startedAt === undefined ? undefined : Math.round(performance.now() - startedAt),
      failed
    });
    if (!failed && event.toolUse.name === "strands_structured_output") {
      capturedStructuredOutput = event.toolUse.input;
    }
    toolStartedAt.delete(event.toolUse.toolUseId);
  });
  agent.addHook(AfterToolsEvent, (event) => {
    if (capturedStructuredOutput !== undefined) {
      event.endTurn = "Validated structured output captured.";
    }
  });

  return { agent, trace, getCapturedStructuredOutput: () => capturedStructuredOutput };
}
