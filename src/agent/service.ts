import { createPaycheckAgent } from "./create-agent.js";
import { PlanStore } from "./plan-store.js";
import { AgentRequestSchema, RecommendationSchema, type AgentRequest } from "./schemas.js";

export class PaycheckAgentService {
  private readonly planStore = new PlanStore();

  async advise(rawRequest: unknown) {
    const request: AgentRequest = AgentRequestSchema.parse(rawRequest);
    this.planStore.set(request.sessionId, request.plan);
    const { agent, trace } = createPaycheckAgent(this.planStore, request.sessionId);
    const asOf = new Date().toISOString().slice(0, 10);
    const result = await agent.invoke(
      `Session ID: ${request.sessionId}\nAs-of date: ${asOf}\nUser request: ${request.message}`
    );
    const recommendation = RecommendationSchema.parse(result.structuredOutput);
    return {
      recommendation,
      trace,
      metrics: result.metrics ? {
        cycles: result.metrics.cycleCount,
        toolCalls: result.metrics.toolMetrics.size
      } : null,
      stopReason: result.stopReason
    };
  }
}
