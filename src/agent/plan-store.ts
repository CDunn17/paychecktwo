import type { FinancialPlan, PolicySource, ResolutionCase } from "./schemas.js";
import type { MonitoringToolResult } from "./monitoring-policy.js";

export class PlanStore {
  private readonly plans = new Map<string, FinancialPlan>();
  private readonly policySources = new Map<string, PolicySource[]>();
  private readonly monitoringResults = new Map<string, MonitoringToolResult>();
  private readonly resolutionCases = new Map<string, ResolutionCase>();

  set(
    sessionId: string,
    plan: FinancialPlan,
    policySources: PolicySource[] = [],
    monitoringResult?: MonitoringToolResult,
    resolutionCase?: ResolutionCase | null
  ): void {
    this.plans.set(sessionId, structuredClone(plan));
    this.policySources.set(sessionId, structuredClone(policySources));
    if (monitoringResult) this.monitoringResults.set(sessionId, structuredClone(monitoringResult));
    else this.monitoringResults.delete(sessionId);
    if (resolutionCase) this.resolutionCases.set(sessionId, structuredClone(resolutionCase));
    else this.resolutionCases.delete(sessionId);
  }

  get(sessionId: string): FinancialPlan {
    const plan = this.plans.get(sessionId);
    if (!plan) throw new Error(`No financial plan is loaded for session ${sessionId}.`);
    return structuredClone(plan);
  }

  has(sessionId: string): boolean {
    return this.plans.has(sessionId);
  }

  getPolicySources(sessionId: string): PolicySource[] {
    if (!this.plans.has(sessionId)) throw new Error(`No financial plan is loaded for session ${sessionId}.`);
    return structuredClone(this.policySources.get(sessionId) ?? []);
  }

  getMonitoringResult(sessionId: string): MonitoringToolResult {
    if (!this.plans.has(sessionId)) throw new Error(`No financial plan is loaded for session ${sessionId}.`);
    const result = this.monitoringResults.get(sessionId);
    if (!result) throw new Error(`No monitoring analysis is loaded for session ${sessionId}.`);
    return structuredClone(result);
  }

  getResolutionCase(sessionId: string): ResolutionCase {
    if (!this.plans.has(sessionId)) throw new Error(`No financial plan is loaded for session ${sessionId}.`);
    const resolutionCase = this.resolutionCases.get(sessionId);
    if (!resolutionCase) throw new Error(`No resolution case is loaded for session ${sessionId}.`);
    return structuredClone(resolutionCase);
  }

  delete(sessionId: string): void {
    this.plans.delete(sessionId);
    this.policySources.delete(sessionId);
    this.monitoringResults.delete(sessionId);
    this.resolutionCases.delete(sessionId);
  }
}
