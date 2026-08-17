import type { ComparisonOption, Disruption, FinancialPlan } from "./schemas.js";

const DAY_MS = 86_400_000;

export function dateFromKey(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function dateKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function shiftDateKey(value: string, days: number): string {
  const date = dateFromKey(value);
  date.setUTCDate(date.getUTCDate() + days);
  return dateKey(date);
}

export function daysBetween(from: string, to: string): number {
  return Math.max(0, Math.round((dateFromKey(to).getTime() - dateFromKey(from).getTime()) / DAY_MS));
}

export interface TimelineItem {
  id: string;
  name: string;
  amount: number;
  due: string;
  category: string;
  kind: "bill" | "unexpected_expense";
}

export interface CashflowAnalysis {
  asOf: string;
  effectivePayday: string;
  daysToPayday: number;
  currentBalance: number;
  expectedPaycheck: number;
  protectedBuffer: number;
  obligationsTotal: number;
  rawRemainder: number;
  safeToSpend: number;
  dailyFlexibleLimit: number;
  projectedAfterPaycheck: number;
  riskLevel: "stable" | "tight" | "shortfall";
  timeline: TimelineItem[];
}

export function analyzeCashflow(
  plan: FinancialPlan,
  asOf: string,
  disruption: Disruption = { paycheckDelayDays: 0, incomeReduction: 0, unexpectedExpenses: [] }
): CashflowAnalysis {
  const effectivePayday = shiftDateKey(plan.payday, disruption.paycheckDelayDays);
  const start = dateFromKey(asOf).getTime();
  const end = dateFromKey(effectivePayday).getTime();
  const timeline: TimelineItem[] = [
    ...plan.bills.map((bill) => ({ ...bill, kind: "bill" as const })),
    ...disruption.unexpectedExpenses.map((expense, index) => ({
      id: `unexpected-${index}`,
      ...expense,
      category: "Unexpected",
      kind: "unexpected_expense" as const
    }))
  ]
    .filter((item) => {
      const due = dateFromKey(item.due).getTime();
      return due >= start && due <= end;
    })
    .sort((left, right) => dateFromKey(left.due).getTime() - dateFromKey(right.due).getTime());

  const obligationsTotal = timeline.reduce((total, item) => total + item.amount, 0);
  const expectedPaycheck = Math.max(0, plan.paycheck - disruption.incomeReduction);
  const rawRemainder = plan.balance - obligationsTotal - plan.buffer;
  const safeToSpend = Math.max(0, rawRemainder);
  const daysToPayday = daysBetween(asOf, effectivePayday);
  const dailyFlexibleLimit = daysToPayday > 0 ? safeToSpend / daysToPayday : safeToSpend;
  const riskLevel = rawRemainder < 0 ? "shortfall" : safeToSpend < plan.buffer ? "tight" : "stable";

  return {
    asOf,
    effectivePayday,
    daysToPayday,
    currentBalance: plan.balance,
    expectedPaycheck,
    protectedBuffer: plan.buffer,
    obligationsTotal,
    rawRemainder,
    safeToSpend,
    dailyFlexibleLimit,
    projectedAfterPaycheck: rawRemainder + expectedPaycheck,
    riskLevel,
    timeline
  };
}

export interface PressurePoint {
  type: "shortfall" | "large_bill" | "low_daily_room";
  severity: "high" | "medium";
  description: string;
  amount: number;
  relatedBillId: string | null;
}

export function findPressurePoints(analysis: CashflowAnalysis): PressurePoint[] {
  const points: PressurePoint[] = [];
  if (analysis.rawRemainder < 0) {
    points.push({
      type: "shortfall",
      severity: "high",
      description: `Obligations and the protected buffer exceed the current balance by $${Math.abs(analysis.rawRemainder).toFixed(2)}.`,
      amount: Math.abs(analysis.rawRemainder),
      relatedBillId: null
    });
  }

  const largest = [...analysis.timeline].sort((left, right) => right.amount - left.amount)[0];
  if (largest && largest.amount >= Math.max(50, analysis.currentBalance * 0.15)) {
    points.push({
      type: "large_bill",
      severity: analysis.rawRemainder < 0 ? "high" : "medium",
      description: `${largest.name} is the largest obligation before payday.`,
      amount: largest.amount,
      relatedBillId: largest.id
    });
  }

  if (analysis.daysToPayday > 0 && analysis.dailyFlexibleLimit < 15) {
    points.push({
      type: "low_daily_room",
      severity: analysis.dailyFlexibleLimit < 5 ? "high" : "medium",
      description: `Flexible spending is limited to $${analysis.dailyFlexibleLimit.toFixed(2)} per day.`,
      amount: analysis.dailyFlexibleLimit,
      relatedBillId: null
    });
  }
  return points;
}

export interface ComparedOption {
  label: string;
  roomCreated: number;
  resultingSafeToSpend: number;
  remainingBuffer: number;
  deferredBills: string[];
  warnings: string[];
}

export function compareOptions(
  plan: FinancialPlan,
  analysis: CashflowAnalysis,
  options: ComparisonOption[]
): ComparedOption[] {
  const billsById = new Map(plan.bills.map((bill) => [bill.id, bill]));
  return options.map((option) => {
    const deferredBills = option.billIdsToDefer.map((id) => billsById.get(id)).filter((bill) => bill !== undefined);
    const deferredAmount = deferredBills.reduce((total, bill) => total + bill.amount, 0);
    const bufferReduction = Math.min(plan.buffer, option.bufferReduction);
    const roomCreated = deferredAmount + option.spendingReduction + bufferReduction;
    const warnings: string[] = [];
    if (deferredBills.length > 0) warnings.push("Confirm due-date changes with each biller; fees or service impacts may apply.");
    if (bufferReduction > 0) warnings.push("This option reduces protection against another surprise.");
    if (option.billIdsToDefer.length !== deferredBills.length) warnings.push("At least one requested bill was not found and was excluded.");
    return {
      label: option.label,
      roomCreated,
      resultingSafeToSpend: Math.max(0, analysis.rawRemainder + roomCreated),
      remainingBuffer: plan.buffer - bufferReduction,
      deferredBills: deferredBills.map((bill) => bill.name),
      warnings
    };
  }).sort((left, right) => right.resultingSafeToSpend - left.resultingSafeToSpend);
}
