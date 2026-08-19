import { shiftDateKey } from "./calculations.js";
import {
  IncomeMonitoringAnalysisSchema,
  IncomeMonitoringSnapshotSchema,
  type CoverageForecast,
  type IncomeDisruptionEvent,
  type IncomeExpectation,
  type IncomeExpectationAssessment,
  type IncomeMonitoringAnalysis,
  type IncomeMonitoringSnapshot,
  type ObservedIncome
} from "./monitoring-schemas.js";

function matchingIncome(
  expectation: IncomeExpectation,
  observedIncome: ObservedIncome[],
  asOf: string
): ObservedIncome[] {
  return observedIncome
    .filter((income) => (
      income.sourceId === expectation.id
      && income.receivedOn >= expectation.windowStart
      && income.receivedOn <= asOf
    ))
    .sort((left, right) => left.receivedOn.localeCompare(right.receivedOn));
}

function thresholdMetOn(expectation: IncomeExpectation, matches: ObservedIncome[]): string | null {
  if (expectation.minimumExpectedCents === 0) return expectation.expectedBy;
  let total = 0;
  for (const income of matches) {
    total += income.amountCents;
    if (total >= expectation.minimumExpectedCents) return income.receivedOn;
  }
  return null;
}

export function assessIncomeExpectations(
  snapshotInput: IncomeMonitoringSnapshot
): IncomeExpectationAssessment[] {
  const snapshot = IncomeMonitoringSnapshotSchema.parse(snapshotInput);
  return snapshot.incomeExpectations.map((expectation) => {
    const matches = matchingIncome(expectation, snapshot.observedIncome, snapshot.asOf);
    const receivedCents = matches.reduce((total, income) => total + income.amountCents, 0);
    const metOn = thresholdMetOn(expectation, matches);
    const graceEnds = shiftDateKey(expectation.expectedBy, expectation.graceDays);
    let status: IncomeExpectationAssessment["status"];

    if (metOn !== null) {
      status = metOn > expectation.expectedBy ? "late" : "met";
    } else if (snapshot.asOf <= expectation.expectedBy) {
      status = "pending";
    } else if (snapshot.asOf <= graceEnds) {
      status = "grace_period";
    } else if (receivedCents === 0) {
      status = "missing";
    } else {
      status = "reduced";
    }

    return {
      sourceId: expectation.id,
      status,
      expectedBy: expectation.expectedBy,
      graceEnds,
      minimumExpectedCents: expectation.minimumExpectedCents,
      typicalExpectedCents: expectation.typicalExpectedCents,
      receivedCents,
      remainingToMinimumCents: Math.max(0, expectation.minimumExpectedCents - receivedCents),
      thresholdMetOn: metOn,
      requiresUserConfirmation: expectation.confidence === "inferred"
        || matches.some((income) => income.matchConfidence === "inferred")
    };
  });
}

function disruptionEvents(
  snapshot: IncomeMonitoringSnapshot,
  assessments: IncomeExpectationAssessment[]
): IncomeDisruptionEvent[] {
  return assessments.flatMap((assessment): IncomeDisruptionEvent[] => {
    const common = {
      sourceId: assessment.sourceId,
      detectedOn: snapshot.asOf,
      expectedBy: assessment.expectedBy,
      requiresUserConfirmation: assessment.requiresUserConfirmation
    };
    switch (assessment.status) {
      case "grace_period":
        return [{
          ...common,
          type: "late_pending",
          active: true,
          amountAtIssueCents: assessment.remainingToMinimumCents
        }];
      case "late":
        return [{
          ...common,
          type: "late_income",
          active: false,
          amountAtIssueCents: Math.max(0, assessment.typicalExpectedCents - assessment.receivedCents)
        }];
      case "reduced":
        return [{
          ...common,
          type: "reduced_income",
          active: true,
          amountAtIssueCents: assessment.remainingToMinimumCents
        }];
      case "missing":
        return [{
          ...common,
          type: "missing_income",
          active: true,
          amountAtIssueCents: assessment.minimumExpectedCents
        }];
      default:
        return [];
    }
  });
}

type ForecastEvent = {
  date: string;
  order: number;
  conservativeChangeCents: number;
  typicalChangeCents: number;
  obligationId: string | null;
  protected: boolean;
};

function forecastIncomeEvents(
  snapshot: IncomeMonitoringSnapshot,
  assessments: IncomeExpectationAssessment[]
): ForecastEvent[] {
  const assessmentBySource = new Map(assessments.map((assessment) => [assessment.sourceId, assessment]));
  return snapshot.incomeExpectations.flatMap((expectation): ForecastEvent[] => {
    const assessment = assessmentBySource.get(expectation.id);
    if (!assessment || assessment.status === "met" || assessment.status === "late") return [];

    let forecastDate: string | null = null;
    if (assessment.status === "pending") forecastDate = expectation.expectedBy;
    if (assessment.status === "grace_period") forecastDate = assessment.graceEnds;
    if (!forecastDate || forecastDate < snapshot.asOf || forecastDate > snapshot.horizonEnd) return [];

    const minimumRemaining = Math.max(0, expectation.minimumExpectedCents - assessment.receivedCents);
    const typicalRemaining = Math.max(0, expectation.typicalExpectedCents - assessment.receivedCents);
    const isConfirmed = expectation.confidence === "user_confirmed" && !assessment.requiresUserConfirmation;

    return [{
      date: forecastDate,
      order: 1,
      conservativeChangeCents: isConfirmed && assessment.status === "pending" ? minimumRemaining : 0,
      typicalChangeCents: typicalRemaining,
      obligationId: null,
      protected: false
    }];
  });
}

export function forecastCoverage(
  snapshotInput: IncomeMonitoringSnapshot,
  assessmentsInput?: IncomeExpectationAssessment[]
): CoverageForecast {
  const snapshot = IncomeMonitoringSnapshotSchema.parse(snapshotInput);
  const assessments = assessmentsInput ?? assessIncomeExpectations(snapshot);
  const events: ForecastEvent[] = [
    ...snapshot.obligations
      .filter((obligation) => obligation.due >= snapshot.asOf && obligation.due <= snapshot.horizonEnd)
      .map((obligation): ForecastEvent => ({
        date: obligation.due,
        order: 0,
        conservativeChangeCents: -obligation.amountCents,
        typicalChangeCents: -obligation.amountCents,
        obligationId: obligation.id,
        protected: obligation.priority === "protected"
      })),
    ...forecastIncomeEvents(snapshot, assessments)
  ].sort((left, right) => left.date.localeCompare(right.date) || left.order - right.order);

  let conservativeBalance = snapshot.availableBalanceCents;
  let typicalBalance = snapshot.availableBalanceCents;
  let conservativeLowest = conservativeBalance;
  let typicalLowest = typicalBalance;
  const protectedObligationsAtRisk: CoverageForecast["protectedObligationsAtRisk"] = [];

  for (const event of events) {
    conservativeBalance += event.conservativeChangeCents;
    typicalBalance += event.typicalChangeCents;
    conservativeLowest = Math.min(conservativeLowest, conservativeBalance);
    typicalLowest = Math.min(typicalLowest, typicalBalance);

    if (event.protected && event.obligationId && conservativeBalance < snapshot.protectedBufferCents) {
      protectedObligationsAtRisk.push({
        obligationId: event.obligationId,
        due: event.date,
        projectedShortfallCents: snapshot.protectedBufferCents - conservativeBalance,
        basis: "confirmed_minimum"
      });
    }
  }

  return {
    asOf: snapshot.asOf,
    horizonEnd: snapshot.horizonEnd,
    conservativeEndingBalanceCents: conservativeBalance,
    typicalEndingBalanceCents: typicalBalance,
    conservativeLowestBalanceCents: conservativeLowest,
    typicalLowestBalanceCents: typicalLowest,
    protectedObligationsAtRisk
  };
}

export function analyzeIncomeMonitoring(snapshotInput: IncomeMonitoringSnapshot): IncomeMonitoringAnalysis {
  const snapshot = IncomeMonitoringSnapshotSchema.parse(snapshotInput);
  const assessments = assessIncomeExpectations(snapshot);
  return IncomeMonitoringAnalysisSchema.parse({
    assessments,
    disruptions: disruptionEvents(snapshot, assessments),
    coverage: forecastCoverage(snapshot, assessments)
  });
}
