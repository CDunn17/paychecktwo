import type { FinancialPlan, PolicySource } from "./schemas.js";

export class PlanStore {
  private readonly plans = new Map<string, FinancialPlan>();
  private readonly policySources = new Map<string, PolicySource[]>();

  set(sessionId: string, plan: FinancialPlan, policySources: PolicySource[] = []): void {
    this.plans.set(sessionId, structuredClone(plan));
    this.policySources.set(sessionId, structuredClone(policySources));
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

  delete(sessionId: string): void {
    this.plans.delete(sessionId);
    this.policySources.delete(sessionId);
  }
}
