import type {
  FinancialPlan,
  PolicySource,
  ResolutionCase,
  ResolutionCaseCompletionEvidence,
  SyntheticEventStreamSummary
} from "./schemas.js";
import type { MonitoringToolResult } from "./monitoring-policy.js";

export class PlanStore {
  private readonly plans = new Map<string, FinancialPlan>();
  private readonly policySources = new Map<string, PolicySource[]>();
  private readonly monitoringResults = new Map<string, MonitoringToolResult>();
  private readonly resolutionCases = new Map<string, ResolutionCase>();
  private readonly caseCompletionEvidence = new Map<string, ResolutionCaseCompletionEvidence>();
  private readonly syntheticEventStreams = new Map<string, SyntheticEventStreamSummary>();

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
    this.caseCompletionEvidence.delete(sessionId);
    this.syntheticEventStreams.delete(sessionId);
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

  hasMonitoringResult(sessionId: string): boolean {
    return this.monitoringResults.has(sessionId);
  }

  getResolutionCase(sessionId: string): ResolutionCase {
    if (!this.plans.has(sessionId)) throw new Error(`No financial plan is loaded for session ${sessionId}.`);
    const resolutionCase = this.resolutionCases.get(sessionId);
    if (!resolutionCase) throw new Error(`No resolution case is loaded for session ${sessionId}.`);
    return structuredClone(resolutionCase);
  }

  hasResolutionCase(sessionId: string): boolean {
    return this.resolutionCases.has(sessionId);
  }

  setResolutionCase(sessionId: string, resolutionCase: ResolutionCase): void {
    if (!this.plans.has(sessionId)) throw new Error(`No financial plan is loaded for session ${sessionId}.`);
    this.resolutionCases.set(sessionId, structuredClone(resolutionCase));
  }

  setCaseCompletionEvidence(sessionId: string, evidence: ResolutionCaseCompletionEvidence): void {
    if (!this.plans.has(sessionId)) throw new Error(`No financial plan is loaded for session ${sessionId}.`);
    this.caseCompletionEvidence.set(sessionId, structuredClone(evidence));
  }

  getCaseCompletionEvidence(sessionId: string): ResolutionCaseCompletionEvidence {
    if (!this.plans.has(sessionId)) throw new Error(`No financial plan is loaded for session ${sessionId}.`);
    const evidence = this.caseCompletionEvidence.get(sessionId);
    if (!evidence) throw new Error(`No case-completion evidence is loaded for session ${sessionId}.`);
    return structuredClone(evidence);
  }

  hasCaseCompletionEvidence(sessionId: string): boolean {
    return this.caseCompletionEvidence.has(sessionId);
  }

  setSyntheticEventStream(sessionId: string, summary: SyntheticEventStreamSummary): void {
    if (!this.plans.has(sessionId)) throw new Error(`No financial plan is loaded for session ${sessionId}.`);
    this.syntheticEventStreams.set(sessionId, structuredClone(summary));
  }

  getSyntheticEventStream(sessionId: string): SyntheticEventStreamSummary {
    if (!this.plans.has(sessionId)) throw new Error(`No financial plan is loaded for session ${sessionId}.`);
    const summary = this.syntheticEventStreams.get(sessionId);
    if (!summary) throw new Error(`No synthetic event-stream summary is loaded for session ${sessionId}.`);
    return structuredClone(summary);
  }

  hasSyntheticEventStream(sessionId: string): boolean {
    return this.syntheticEventStreams.has(sessionId);
  }

  delete(sessionId: string): void {
    this.plans.delete(sessionId);
    this.policySources.delete(sessionId);
    this.monitoringResults.delete(sessionId);
    this.resolutionCases.delete(sessionId);
    this.caseCompletionEvidence.delete(sessionId);
    this.syntheticEventStreams.delete(sessionId);
  }
}
