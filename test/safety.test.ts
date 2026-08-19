import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSafetyPreview,
  inspectAndRedactText,
  inspectUnknownForSensitiveData,
  sanitizeAgentRequest
} from "../src/agent/safety.js";
import { AgentRequestSchema, SafetyPreviewRequestSchema } from "../src/agent/request-schemas.js";
import { ResolutionCaseSchema } from "../src/agent/schemas.js";

const baseRequest = {
  sessionId: "safety-test",
  message: "Can I afford groceries?",
  plan: {
    name: "Alex",
    balance: 642.18,
    paycheck: 1840,
    buffer: 100,
    payday: "2026-08-25",
    bills: [{ id: "phone", name: "Phone bill", amount: 74, due: "2026-08-18", category: "Utilities" }]
  },
  asOf: "2026-08-17",
  policySources: []
};
const fakeAwsAccessKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const priorMonitoringCase = ResolutionCaseSchema.parse({
  caseId: "case-1",
  version: 5,
  status: "monitoring",
  nextRequiredAction: "observe_outcome",
  openedOn: "2026-08-10",
  updatedOn: "2026-08-11",
  trigger: {
    reasonCodes: ["protected_obligation_risk"],
    activeDisruptionCount: 1,
    uncertainDisruptionCount: 0,
    protectedObligationRiskCount: 1
  },
  selectedOptionId: "option-1",
  terminalReason: null,
  transitionHistory: [
    { fromStatus: null, toStatus: "detected", eventType: "case_opened", occurredOn: "2026-08-10" },
    { fromStatus: "detected", toStatus: "options_ready", eventType: "options_calculated", occurredOn: "2026-08-10" },
    { fromStatus: "options_ready", toStatus: "awaiting_decision", eventType: "options_presented", occurredOn: "2026-08-10" },
    { fromStatus: "awaiting_decision", toStatus: "prepared", eventType: "decision_recorded", occurredOn: "2026-08-11" },
    { fromStatus: "prepared", toStatus: "monitoring", eventType: "follow_up_started", occurredOn: "2026-08-11" }
  ]
});

test("redacts high-confidence identifiers and secrets without retaining their values", () => {
  const rawValues = [
    "4111 1111 1111 1111",
    "123-45-6789",
    "person@example.com",
    "(212) 555-0199",
    "021000021",
    fakeAwsAccessKey,
    "demo-password"
  ];
  const result = inspectAndRedactText(
    `Card ${rawValues[0]}, SSN ${rawValues[1]}, email ${rawValues[2]}, phone ${rawValues[3]}, routing number: ${rawValues[4]}, AWS ${rawValues[5]}, password: ${rawValues[6]}`,
    "message"
  );

  assert.deepEqual(
    new Set(result.findings.map((finding) => finding.category)),
    new Set(["payment_card", "social_security_number", "email", "phone", "bank_account", "aws_access_key", "credential"])
  );
  for (const rawValue of rawValues) assert.equal(result.redacted.includes(rawValue), false);
  assert.equal(JSON.stringify(result.findings).includes("person@example.com"), false);
});

test("sanitizes every free-text request surface before model use", () => {
  const parsed = AgentRequestSchema.parse({
    ...baseRequest,
    message: "Email me at person@example.com",
    plan: {
      ...baseRequest.plan,
      name: "person@example.com",
      bills: [{ ...baseRequest.plan.bills[0], name: "Call (212) 555-0199" }]
    },
    policySources: [{
      id: "policy-one",
      title: "Account 4111 1111 1111 1111",
      provider: "Example Bank",
      sourceType: "user_reported",
      content: "My routing number: 021000021",
      sourceReference: "person@example.com",
      effectiveDate: null,
      lastConfirmedDate: null
    }],
    privacy: { consentToModel: true, ephemeral: true }
  });
  const result = sanitizeAgentRequest(parsed);
  const serialized = JSON.stringify(result.request);

  assert.equal(serialized.includes("person@example.com"), false);
  assert.equal(serialized.includes("4111 1111 1111 1111"), false);
  assert.equal(serialized.includes("021000021"), false);
  assert.equal(serialized.includes("(212) 555-0199"), false);
  assert.ok(result.summary.length >= 4);
});

test("replaces sensitive structural identifiers with schema-safe aliases", () => {
  const parsed = AgentRequestSchema.parse({
    ...baseRequest,
    sessionId: fakeAwsAccessKey,
    plan: {
      ...baseRequest.plan,
      bills: [{ ...baseRequest.plan.bills[0], id: "4111111111111111" }]
    },
    privacy: { consentToModel: true, ephemeral: true }
  });
  const result = sanitizeAgentRequest(parsed);

  assert.equal(result.request.sessionId, "redacted-session");
  assert.equal(result.request.plan.bills[0]?.id, "redacted-bill-1");
  assert.deepEqual(
    new Set(result.summary.map((finding) => finding.category)),
    new Set(["aws_access_key", "payment_card"])
  );
});

test("preview describes transmission and redactions without returning matched values", () => {
  const request = SafetyPreviewRequestSchema.parse({
    ...baseRequest,
    message: "My email is person@example.com"
  });
  const preview = buildSafetyPreview(request);
  const serialized = JSON.stringify(preview);

  assert.equal(preview.destination, "Amazon Bedrock via Strands");
  assert.equal(preview.rawMatchedValuesReturned, false);
  assert.equal(preview.monitoringHistorySentToModel, false);
  assert.deepEqual(preview.redactions, [{ category: "email", count: 1, severity: "medium" }]);
  assert.equal(serialized.includes("person@example.com"), false);
});

test("monitoring history stays local and sensitive opaque identifiers are replaced consistently", () => {
  const request = AgentRequestSchema.parse({
    ...baseRequest,
    plan: {
      ...baseRequest.plan,
      bills: [{ ...baseRequest.plan.bills[0], id: "4111111111111111" }]
    },
    monitoring: {
      history: {
        historyStart: "2026-07-01",
        historyEnd: "2026-08-17",
        transactions: [
          { id: "4111111111111111", occurredOn: "2026-07-01", amountCents: 50_000, direction: "credit", sourceAlias: fakeAwsAccessKey, classification: "income_candidate", provenance: "synthetic_fixture" },
          { id: "event-2", occurredOn: "2026-07-08", amountCents: 50_000, direction: "credit", sourceAlias: fakeAwsAccessKey, classification: "income_candidate", provenance: "synthetic_fixture" },
          { id: "event-3", occurredOn: "2026-07-15", amountCents: 50_000, direction: "credit", sourceAlias: fakeAwsAccessKey, classification: "income_candidate", provenance: "synthetic_fixture" }
        ],
        overrides: [{ sourceAlias: fakeAwsAccessKey, action: "confirm", kind: "hourly_job" }]
      },
      horizonEnd: "2026-08-25",
      protectedBillIds: ["4111111111111111"]
    },
    privacy: { consentToModel: true, ephemeral: true }
  });
  const result = sanitizeAgentRequest(request);
  const serialized = JSON.stringify(result.request);

  assert.equal(serialized.includes(fakeAwsAccessKey), false);
  assert.equal(serialized.includes("4111111111111111"), false);
  assert.equal(result.request.monitoring?.history.transactions[0]?.sourceAlias, "redacted-income-source-1");
  assert.equal(result.request.monitoring?.history.overrides[0]?.sourceAlias, "redacted-income-source-1");
  assert.equal(result.request.monitoring?.protectedBillIds[0], "redacted-bill-1");

  const preview = buildSafetyPreview(request);
  assert.equal(preview.monitoringHistorySentToModel, false);
  assert.equal(preview.localOnlyFields.length, 1);
  assert.match(preview.fieldsSent.join(" "), /Locally derived generic income-source confidence/);
});

test("accepts only synthetic monitoring-state continuation with matching version and current monitoring", () => {
  const monitoring = {
    history: {
      historyStart: "2026-07-01",
      historyEnd: "2026-08-17",
      transactions: [
        { id: "event-1", occurredOn: "2026-07-01", amountCents: 50_000, direction: "credit", sourceAlias: "income-1", classification: "income_candidate", provenance: "synthetic_fixture" },
        { id: "event-2", occurredOn: "2026-07-08", amountCents: 50_000, direction: "credit", sourceAlias: "income-1", classification: "income_candidate", provenance: "synthetic_fixture" },
        { id: "event-3", occurredOn: "2026-07-15", amountCents: 50_000, direction: "credit", sourceAlias: "income-1", classification: "income_candidate", provenance: "synthetic_fixture" }
      ],
      overrides: [{ sourceAlias: "income-1", action: "confirm", kind: "hourly_job" }]
    },
    horizonEnd: "2026-08-25",
    protectedBillIds: ["phone"]
  };
  const continuation = {
    provenance: "synthetic_fixture",
    priorCase: priorMonitoringCase,
    expectedVersion: 5,
    outcomeConfirmation: "risk_cleared"
  };
  const accepted = AgentRequestSchema.parse({
    ...baseRequest,
    monitoring,
    caseContinuation: continuation,
    privacy: { consentToModel: true, ephemeral: true }
  });
  assert.equal(accepted.caseContinuation?.priorCase.status, "monitoring");
  assert.equal(AgentRequestSchema.safeParse({
    ...baseRequest,
    caseContinuation: continuation,
    privacy: { consentToModel: true, ephemeral: true }
  }).success, false);
  assert.equal(AgentRequestSchema.safeParse({
    ...baseRequest,
    monitoring,
    caseContinuation: { ...continuation, expectedVersion: 4 },
    privacy: { consentToModel: true, ephemeral: true }
  }).success, false);
  assert.equal(AgentRequestSchema.safeParse({
    ...baseRequest,
    monitoring,
    caseContinuation: { ...continuation, provenance: "caller_claimed" },
    privacy: { consentToModel: true, ephemeral: true }
  }).success, false);

  const preview = buildSafetyPreview(SafetyPreviewRequestSchema.parse({
    ...baseRequest,
    monitoring,
    caseContinuation: continuation
  }));
  assert.match(preview.fieldsSent.join(" "), /fixed outcome-confirmation category/i);
  assert.equal(preview.monitoringHistorySentToModel, false);
});

test("requires explicit model consent and defaults accepted requests to ephemeral", () => {
  assert.equal(AgentRequestSchema.safeParse(baseRequest).success, false);
  assert.equal(AgentRequestSchema.safeParse({
    ...baseRequest,
    privacy: { consentToModel: false, ephemeral: true }
  }).success, false);
  const accepted = AgentRequestSchema.parse({
    ...baseRequest,
    privacy: { consentToModel: true }
  });
  assert.equal(accepted.privacy.ephemeral, true);
});

test("does not mistake ordinary financial values, dates, or IDs for sensitive identifiers", () => {
  const result = inspectAndRedactText(
    "Balance $642.18, paycheck $1,840, due 2026-08-25, bill id 1234567890123456, session demo-1234.",
    "message"
  );
  assert.deepEqual(result.findings, []);
});

test("finds sensitive data in nested model output so it can fail closed", () => {
  const findings = inspectUnknownForSensitiveData({
    summary: "Contact person@example.com",
    options: [{ tradeoff: "Use card 4111 1111 1111 1111" }]
  });
  assert.deepEqual(
    new Set(findings.map((finding) => finding.category)),
    new Set(["email", "payment_card"])
  );
});
