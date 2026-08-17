import type { FinancialPlan } from "./schemas.js";

export class PlanStore {
  private readonly plans = new Map<string, FinancialPlan>();

  set(sessionId: string, plan: FinancialPlan): void {
    this.plans.set(sessionId, structuredClone(plan));
  }

  get(sessionId: string): FinancialPlan {
    const plan = this.plans.get(sessionId);
    if (!plan) throw new Error(`No financial plan is loaded for session ${sessionId}.`);
    return structuredClone(plan);
  }

  has(sessionId: string): boolean {
    return this.plans.has(sessionId);
  }
}
