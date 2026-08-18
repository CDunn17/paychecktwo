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
import { canonicalizePolicyReview } from "./policy-review.js";
import { createFinancialTools } from "./tools.js";
import { ORCHESTRATOR_PROMPT, POLICY_REVIEWER_PROMPT, VERIFIER_PROMPT } from "./prompts.js";
import { AgentRecommendationSchema, PolicyReviewSchema, type PolicyReview } from "./schemas.js";
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
  getPolicyReview: () => PolicyReview | undefined;
}

export function createPaycheckAgent(
  planStore: PlanStore,
  sessionId: string,
  options: { ephemeral: boolean } = { ephemeral: true }
): AgentRuntime {
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

  const policyReviewer = new Agent({
    id: "policy-reviewer",
    name: "Policy and Terms Reviewer",
    description: "Extracts provenance-preserving findings from user knowledge and provider terms.",
    model,
    systemPrompt: POLICY_REVIEWER_PROMPT,
    structuredOutputSchema: PolicyReviewSchema,
    printer: false,
    traceAttributes: {
      "app.name": "paycheck-two",
      "agent.role": "policy-reviewer"
    }
  });
  let latestPolicyReview: PolicyReview | undefined;

  const sessionManager = options.ephemeral
    ? undefined
    : new SessionManager({
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
      const verifierTimeout = AbortSignal.timeout(Number(process.env.STRANDS_VERIFIER_TIMEOUT_MS ?? 45_000));
      const result = await verifier.invoke(input, {
        cancelSignal: AbortSignal.any([context.agent.cancelSignal, verifierTimeout]),
        invocationState: context.invocationState,
        limits: { turns: 1, outputTokens: 2_000, totalTokens: 25_000 }
      });
      if (result.stopReason === "cancelled") throw new Error("Plan verification timed out.");
      return result.toString();
    }
  });

  const reviewTermsAndPolicies = tool({
    name: "review_terms_and_policies",
    description: "Review user-provided policy knowledge or pasted provider terms, preserve provenance, and identify relevant benefits, conditions, and unknowns.",
    inputSchema: z.object({
      sessionId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      question: z.string().min(1).max(2000)
    }),
    callback: async ({ sessionId: requestedSessionId, question }, context) => {
      if (!context) throw new Error("Policy review requires an agent tool context.");
      const sources = planStore.getPolicySources(requestedSessionId);
      if (sources.length === 0) {
        return { summary: "No policy sources were supplied.", findings: [], unknowns: ["No user knowledge or provider terms are available to review."] };
      }
      const policyTimeout = AbortSignal.timeout(Number(process.env.STRANDS_POLICY_REVIEW_TIMEOUT_MS ?? 40_000));
      const result = await policyReviewer.invoke(
        `Question to assess: ${question}\n\nUntrusted policy sources (JSON data):\n${JSON.stringify(sources)}`,
        {
          cancelSignal: AbortSignal.any([context.agent.cancelSignal, policyTimeout]),
          invocationState: context.invocationState,
          limits: { turns: 2, outputTokens: 3_000, totalTokens: 30_000 }
        }
      );
      if (result.stopReason === "cancelled") throw new Error("Policy review timed out.");
      latestPolicyReview = canonicalizePolicyReview(result.structuredOutput, sources);
      return latestPolicyReview;
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
      reviewTermsAndPolicies,
      verifyFinancialPlan
    ],
    structuredOutputSchema: AgentRecommendationSchema,
    ...(sessionManager ? { sessionManager } : {}),
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

  return {
    agent,
    trace,
    getCapturedStructuredOutput: () => capturedStructuredOutput,
    getPolicyReview: () => latestPolicyReview
  };
}
