import {
  Agent,
  AfterToolCallEvent,
  BedrockModel,
  BeforeToolCallEvent,
  SessionManager
} from "@strands-agents/sdk";
import { LocalFileStorage } from "@strands-agents/sdk/storage";
import { createFinancialTools } from "./tools.js";
import { ORCHESTRATOR_PROMPT, VERIFIER_PROMPT } from "./prompts.js";
import { RecommendationSchema } from "./schemas.js";
import type { PlanStore } from "./plan-store.js";

export interface AgentTraceEntry {
  phase: "started" | "completed";
  tool: string;
  timestamp: string;
  failed?: boolean;
}

export interface AgentRuntime {
  agent: Agent;
  trace: AgentTraceEntry[];
}

export function createPaycheckAgent(planStore: PlanStore, sessionId: string): AgentRuntime {
  const model = new BedrockModel({
    region: process.env.AWS_REGION ?? "us-east-1",
    modelId: process.env.STRANDS_MODEL_ID ?? "global.anthropic.claude-sonnet-4-6",
    maxTokens: 4096,
    temperature: 0.1
  });

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

  const agent = new Agent({
    id: "paycheck-two-orchestrator",
    name: "Paycheck Two",
    description: "Builds and verifies resilient plans between paychecks.",
    model,
    systemPrompt: ORCHESTRATOR_PROMPT,
    tools: [
      ...createFinancialTools(planStore),
      verifier.asTool({
        name: "verify_financial_plan",
        description: "Independently check the proposed recommendation and its tool evidence before answering the user.",
        preserveContext: false
      })
    ],
    structuredOutputSchema: RecommendationSchema,
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
  agent.addHook(BeforeToolCallEvent, (event) => {
    trace.push({ phase: "started", tool: event.toolUse.name, timestamp: new Date().toISOString() });
  });
  agent.addHook(AfterToolCallEvent, (event) => {
    trace.push({
      phase: "completed",
      tool: event.toolUse.name,
      timestamp: new Date().toISOString(),
      failed: Boolean(event.error)
    });
  });

  return { agent, trace };
}
