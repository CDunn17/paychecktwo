import { shiftDateKey } from "./calculations.js";
import { IncomeExpectationSchema, type IncomeExpectation } from "./monitoring-schemas.js";
import {
  RecurringIncomeInferenceRequestSchema,
  RecurringIncomeInferenceResultSchema,
  type IncomeCadence,
  type IncomePatternOverride,
  type NormalizedSyntheticTransaction,
  type ParsedRecurringIncomeInferenceRequest,
  type RecurringIncomeInferenceRequest,
  type RecurringIncomeInferenceResult,
  type RecurringIncomePattern
} from "./recurring-income-schemas.js";

export type RecurringIncomeInferenceErrorCode =
  | "unknown_override_source"
  | "irregular_pattern_requires_correction"
  | "corrected_date_not_after_observation";

export class RecurringIncomeInferenceError extends Error {
  readonly code: RecurringIncomeInferenceErrorCode;

  constructor(code: RecurringIncomeInferenceErrorCode) {
    super(code);
    this.name = "RecurringIncomeInferenceError";
    this.code = code;
  }
}

const DAY_MS = 86_400_000;

function dayNumber(value: string): number {
  return new Date(`${value}T00:00:00.000Z`).getTime() / DAY_MS;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[middle] ?? 0;
  return Math.round(((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2);
}

function lowerQuartile(values: number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor((ordered.length - 1) * 0.25)] ?? 0;
}

function monthlyCount(dates: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  dates.forEach((date) => {
    const month = date.slice(0, 7);
    counts.set(month, (counts.get(month) ?? 0) + 1);
  });
  return counts;
}

function inferCadence(dates: string[], intervals: number[]): IncomeCadence {
  if (intervals.length < 2) return "irregular";
  const center = median(intervals);
  const spread = Math.max(...intervals) - Math.min(...intervals);
  const calendarAnchorCount = dates.filter((date) => {
    const day = Number(date.slice(8, 10));
    return day <= 5 || (day >= 13 && day <= 18) || day >= 27;
  }).length;
  const monthsWithTwo = [...monthlyCount(dates).values()].filter((count) => count >= 2).length;

  if (
    dates.length >= 4
    && center >= 13
    && center <= 17
    && spread >= 1
    && intervals.every((interval) => interval >= 11 && interval <= 19)
    && calendarAnchorCount / dates.length >= 0.75
    && monthsWithTwo >= 2
  ) return "semimonthly";

  if (center >= 6 && center <= 8 && intervals.every((interval) => Math.abs(interval - 7) <= 2)) {
    return "weekly";
  }
  if (center >= 12 && center <= 16 && intervals.every((interval) => Math.abs(interval - 14) <= 2)) {
    return "biweekly";
  }
  if (center >= 27 && center <= 33 && intervals.every((interval) => interval >= 25 && interval <= 35)) {
    return "monthly";
  }
  return "irregular";
}

function nextDate(lastObservedOn: string, cadence: IncomeCadence, medianIntervalDays: number): string | null {
  if (cadence === "irregular") return null;
  if (cadence === "weekly") return shiftDateKey(lastObservedOn, 7);
  if (cadence === "biweekly") return shiftDateKey(lastObservedOn, 14);
  if (cadence === "semimonthly") return shiftDateKey(lastObservedOn, Math.max(13, medianIntervalDays));

  const date = new Date(`${lastObservedOn}T00:00:00.000Z`);
  const originalDay = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + 1);
  const lastDayOfTargetMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(originalDay, lastDayOfTargetMonth));
  return date.toISOString().slice(0, 10);
}

function defaultGraceDays(cadence: IncomeCadence): number {
  if (cadence === "weekly" || cadence === "biweekly") return 2;
  if (cadence === "semimonthly" || cadence === "monthly") return 3;
  return 0;
}

function buildInferredPattern(
  request: ParsedRecurringIncomeInferenceRequest,
  sourceAlias: string,
  transactions: NormalizedSyntheticTransaction[]
): RecurringIncomePattern {
  const ordered = [...transactions].sort((left, right) => left.occurredOn.localeCompare(right.occurredOn));
  const amountsByDate = new Map<string, number>();
  ordered.forEach((transaction) => {
    amountsByDate.set(transaction.occurredOn, (amountsByDate.get(transaction.occurredOn) ?? 0) + transaction.amountCents);
  });
  const dates = [...amountsByDate.keys()].sort();
  const amounts = dates.map((date) => amountsByDate.get(date) ?? 0);
  const intervals = dates.slice(1).map((date, index) => Math.round(dayNumber(date) - dayNumber(dates[index] ?? date)));
  const medianIntervalDays = median(intervals);
  const intervalSpreadDays = intervals.length > 0 ? Math.max(...intervals) - Math.min(...intervals) : null;
  const cadence = inferCadence(dates, intervals);
  const typicalExpectedCents = median(amounts);
  const observedMinimumCents = Math.min(...amounts);
  const observedMaximumCents = Math.max(...amounts);
  const variableAmounts = typicalExpectedCents > 0
    && (observedMaximumCents - observedMinimumCents) / typicalExpectedCents >= 0.25;
  const consistent = cadence !== "irregular";
  const inferenceConfidence = !consistent ? "low" : dates.length >= 4 ? "high" : "medium";
  const firstObservedOn = dates[0] ?? request.historyStart;
  const lastObservedOn = dates.at(-1) ?? request.historyEnd;

  return {
    sourceAlias,
    status: "inferred",
    kind: "other",
    cadence,
    inferenceConfidence,
    requiresUserConfirmation: true,
    eligibleForMonitoring: cadence !== "irregular",
    observationCount: dates.length,
    minimumExpectedCents: lowerQuartile(amounts),
    typicalExpectedCents,
    observedMinimumCents,
    observedMaximumCents,
    medianIntervalDays: intervals.length > 0 ? medianIntervalDays : null,
    intervalSpreadDays,
    nextExpectedDate: nextDate(lastObservedOn, cadence, medianIntervalDays),
    graceDays: defaultGraceDays(cadence),
    provenance: {
      method: "recurring_credit_v1",
      historyStart: request.historyStart,
      historyEnd: request.historyEnd,
      firstObservedOn,
      lastObservedOn,
      transactionIds: ordered.map(({ id }) => id),
      evidenceCodes: [
        dates.length >= 3 ? "minimum_observations_met" : "insufficient_observations",
        consistent ? "cadence_consistent" : "cadence_irregular",
        variableAmounts ? "amounts_variable" : "amounts_stable"
      ]
    }
  };
}

function applyOverride(
  pattern: RecurringIncomePattern,
  override: IncomePatternOverride
): RecurringIncomePattern | null {
  if (override.action === "reject") return null;
  if (override.action === "confirm") {
    if (pattern.cadence === "irregular" || pattern.nextExpectedDate === null) {
      throw new RecurringIncomeInferenceError("irregular_pattern_requires_correction");
    }
    return {
      ...pattern,
      status: "user_confirmed",
      kind: override.kind,
      inferenceConfidence: "user_confirmed",
      requiresUserConfirmation: false,
      provenance: {
        ...pattern.provenance,
        evidenceCodes: [...pattern.provenance.evidenceCodes, "user_confirmed"]
      }
    };
  }

  if (override.nextExpectedDate <= pattern.provenance.lastObservedOn) {
    throw new RecurringIncomeInferenceError("corrected_date_not_after_observation");
  }
  return {
    ...pattern,
    status: "user_corrected",
    kind: override.kind,
    cadence: override.cadence,
    inferenceConfidence: "user_confirmed",
    requiresUserConfirmation: false,
    eligibleForMonitoring: true,
    minimumExpectedCents: override.minimumExpectedCents,
    typicalExpectedCents: override.typicalExpectedCents,
    nextExpectedDate: override.nextExpectedDate,
    graceDays: override.graceDays,
    provenance: {
      ...pattern.provenance,
      evidenceCodes: [...pattern.provenance.evidenceCodes, "user_corrected"]
    }
  };
}

export function inferRecurringIncome(
  requestInput: RecurringIncomeInferenceRequest
): RecurringIncomeInferenceResult {
  const request = RecurringIncomeInferenceRequestSchema.parse(requestInput);
  const eligible = request.transactions.filter((transaction) => (
    transaction.direction === "credit" && transaction.classification === "income_candidate"
  ));
  const groups = new Map<string, NormalizedSyntheticTransaction[]>();
  eligible.forEach((transaction) => {
    groups.set(transaction.sourceAlias, [...(groups.get(transaction.sourceAlias) ?? []), transaction]);
  });

  const overrides = new Map(request.overrides.map((override) => [override.sourceAlias, override]));
  for (const sourceAlias of overrides.keys()) {
    if (!groups.has(sourceAlias)) throw new RecurringIncomeInferenceError("unknown_override_source");
  }

  const patterns: RecurringIncomePattern[] = [];
  const decisions: RecurringIncomeInferenceResult["decisions"] = [];
  let insufficientHistorySourceCount = 0;

  for (const [sourceAlias, transactions] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const override = overrides.get(sourceAlias);
    const observationCount = new Set(transactions.map(({ occurredOn }) => occurredOn)).size;
    if (override?.action === "reject") {
      decisions.push({ sourceAlias, action: "reject", applied: true });
      continue;
    }
    if (observationCount < 3 && override?.action !== "correct") {
      insufficientHistorySourceCount += 1;
      continue;
    }

    const basePattern = buildInferredPattern(request, sourceAlias, transactions);
    const pattern = override ? applyOverride(basePattern, override) : basePattern;
    if (override) decisions.push({ sourceAlias, action: override.action, applied: true });
    if (pattern) patterns.push(pattern);
  }

  const ignoredTransactionCounts = {
    reimbursement: request.transactions.filter(({ direction, classification }) => (
      direction === "credit" && classification === "reimbursement"
    )).length,
    transfer: request.transactions.filter(({ direction, classification }) => (
      direction === "credit" && classification === "transfer"
    )).length,
    unknown: request.transactions.filter(({ direction, classification }) => (
      direction === "credit" && classification === "unknown"
    )).length,
    debit: request.transactions.filter(({ direction }) => direction === "debit").length
  };

  return RecurringIncomeInferenceResultSchema.parse({
    historyStart: request.historyStart,
    historyEnd: request.historyEnd,
    patterns,
    decisions,
    ignoredTransactionCounts,
    insufficientHistorySourceCount
  });
}

export function patternsToIncomeExpectations(patterns: RecurringIncomePattern[]): IncomeExpectation[] {
  return patterns
    .filter((pattern) => pattern.eligibleForMonitoring && pattern.nextExpectedDate !== null)
    .sort((left, right) => left.sourceAlias.localeCompare(right.sourceAlias))
    .map((pattern, index) => IncomeExpectationSchema.parse({
      id: pattern.sourceAlias,
      label: `Income source ${index + 1}`,
      kind: pattern.kind,
      windowStart: shiftDateKey(pattern.provenance.lastObservedOn, 1),
      expectedBy: pattern.nextExpectedDate as string,
      graceDays: pattern.graceDays,
      minimumExpectedCents: pattern.minimumExpectedCents,
      typicalExpectedCents: pattern.typicalExpectedCents,
      confidence: pattern.requiresUserConfirmation ? "inferred" : "user_confirmed"
    }));
}
