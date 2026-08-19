import type { AgentRequest, SafetyPreviewRequest } from "./request-schemas.js";

export type SensitiveDataCategory =
  | "aws_access_key"
  | "credential"
  | "payment_card"
  | "bank_account"
  | "social_security_number"
  | "email"
  | "phone";

export interface SensitiveDataFinding {
  category: SensitiveDataCategory;
  path: string;
  severity: "high" | "medium";
}

export interface SensitiveDataSummary {
  category: SensitiveDataCategory;
  count: number;
  severity: "high" | "medium";
}

export interface SafetyPreview {
  destination: "Amazon Bedrock via Strands";
  fieldsSent: string[];
  localOnlyFields: string[];
  policySourceCount: number;
  monitoringHistorySentToModel: false;
  redactions: SensitiveDataSummary[];
  rawMatchedValuesReturned: false;
  ephemeralByDefault: true;
}

const REDACTION_LABELS: Record<SensitiveDataCategory, string> = {
  aws_access_key: "[REDACTED:AWS_ACCESS_KEY]",
  credential: "[REDACTED:CREDENTIAL]",
  payment_card: "[REDACTED:PAYMENT_CARD]",
  bank_account: "[REDACTED:BANK_ACCOUNT]",
  social_security_number: "[REDACTED:SSN]",
  email: "[REDACTED:EMAIL]",
  phone: "[REDACTED:PHONE]"
};

const SEVERITY: Record<SensitiveDataCategory, "high" | "medium"> = {
  aws_access_key: "high",
  credential: "high",
  payment_card: "high",
  bank_account: "high",
  social_security_number: "high",
  email: "medium",
  phone: "medium"
};

function luhnValid(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number(digits[index]);
    if (doubleDigit) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function record(findings: SensitiveDataFinding[], category: SensitiveDataCategory, path: string): void {
  findings.push({ category, path, severity: SEVERITY[category] });
}

export function inspectAndRedactText(value: string, path = "text"): {
  redacted: string;
  findings: SensitiveDataFinding[];
} {
  const findings: SensitiveDataFinding[] = [];
  let redacted = value;

  const replaceAll = (pattern: RegExp, category: SensitiveDataCategory) => {
    redacted = redacted.replace(pattern, () => {
      record(findings, category, path);
      return REDACTION_LABELS[category];
    });
  };

  replaceAll(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "aws_access_key");

  redacted = redacted.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (candidate) => {
    if (!luhnValid(candidate)) return candidate;
    record(findings, "payment_card", path);
    return REDACTION_LABELS.payment_card;
  });

  replaceAll(/\b(?!000|666|9\d\d)\d{3}[- ]?(?!00)\d{2}[- ]?(?!0000)\d{4}\b/g, "social_security_number");
  replaceAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "email");
  replaceAll(/(?<!\d)(?:\+?1[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]\d{4}(?!\d)/g, "phone");

  redacted = redacted.replace(
    /\b(account(?:\s+number)?|routing(?:\s+number)?|ABA)\s*(?:is|:|#|=)?\s*([0-9][0-9 -]{2,15}[0-9])\b/gi,
    (_match, label: string) => {
      record(findings, "bank_account", path);
      return `${label}: ${REDACTION_LABELS.bank_account}`;
    }
  );

  redacted = redacted.replace(
    /\b(password|passcode|security\s+answer|PIN|OTP|one[- ]time\s+code|API\s+key|secret|bearer\s+token|access\s+token)\s*(?:is|:|=)\s*([^\s,;]{4,})/gi,
    (match, label: string, secretValue: string) => {
      if (secretValue.startsWith("[REDACTED:")) return match;
      record(findings, "credential", path);
      return `${label}: ${REDACTION_LABELS.credential}`;
    }
  );

  return { redacted, findings };
}

export function summarizeSensitiveData(findings: SensitiveDataFinding[]): SensitiveDataSummary[] {
  const summaries = new Map<SensitiveDataCategory, SensitiveDataSummary>();
  for (const finding of findings) {
    const current = summaries.get(finding.category);
    if (current) current.count += 1;
    else summaries.set(finding.category, { category: finding.category, count: 1, severity: finding.severity });
  }
  return [...summaries.values()].sort((left, right) => left.category.localeCompare(right.category));
}

function sanitizeText(value: string, path: string, findings: SensitiveDataFinding[]): string {
  const result = inspectAndRedactText(value, path);
  findings.push(...result.findings);
  return result.redacted;
}

function sanitizeIdentifier(value: string, path: string, fallback: string, findings: SensitiveDataFinding[]): string {
  const result = inspectAndRedactText(value, path);
  findings.push(...result.findings);
  return result.findings.length > 0 ? fallback : value;
}

export function sanitizeAgentRequest<T extends AgentRequest | SafetyPreviewRequest>(request: T): {
  request: T;
  findings: SensitiveDataFinding[];
  summary: SensitiveDataSummary[];
} {
  const findings: SensitiveDataFinding[] = [];
  const sanitized = structuredClone(request);
  sanitized.sessionId = sanitizeIdentifier(sanitized.sessionId, "sessionId", "redacted-session", findings);
  sanitized.message = sanitizeText(sanitized.message, "message", findings);
  sanitized.plan.name = sanitizeText(sanitized.plan.name, "plan.name", findings);
  const sanitizedBillIds = new Map(sanitized.plan.bills.map((bill, index) => [
    bill.id,
    sanitizeIdentifier(bill.id, `plan.bills.${index}.id`, `redacted-bill-${index + 1}`, findings)
  ]));
  sanitized.plan.bills = sanitized.plan.bills.map((bill, index) => ({
    ...bill,
    id: sanitizedBillIds.get(bill.id) ?? `redacted-bill-${index + 1}`,
    name: sanitizeText(bill.name, `plan.bills.${index}.name`, findings),
    category: sanitizeText(bill.category, `plan.bills.${index}.category`, findings),
    icon: bill.icon === undefined ? undefined : sanitizeText(bill.icon, `plan.bills.${index}.icon`, findings)
  }));
  sanitized.policySources = sanitized.policySources.map((source, index) => ({
    ...source,
    id: sanitizeIdentifier(source.id, `policySources.${index}.id`, `redacted-policy-${index + 1}`, findings),
    title: sanitizeText(source.title, `policySources.${index}.title`, findings),
    provider: sanitizeText(source.provider, `policySources.${index}.provider`, findings),
    content: sanitizeText(source.content, `policySources.${index}.content`, findings),
    sourceReference: source.sourceReference === null
      ? null
      : sanitizeText(source.sourceReference, `policySources.${index}.sourceReference`, findings)
  }));
  if (sanitized.monitoring) {
    sanitized.monitoring.protectedBillIds = sanitized.monitoring.protectedBillIds.map(
      (billId) => sanitizedBillIds.get(billId) ?? "redacted-bill"
    );
    const aliases = [...new Set([
      ...sanitized.monitoring.history.transactions.map(({ sourceAlias }) => sourceAlias),
      ...sanitized.monitoring.history.overrides.map(({ sourceAlias }) => sourceAlias)
    ])];
    const sanitizedAliases = new Map(aliases.map((alias, index) => [
      alias,
      sanitizeIdentifier(
        alias,
        `monitoring.history.sourceAliases.${index}`,
        `redacted-income-source-${index + 1}`,
        findings
      )
    ]));
    sanitized.monitoring.history.transactions = sanitized.monitoring.history.transactions.map((transaction, index) => ({
      ...transaction,
      id: sanitizeIdentifier(
        transaction.id,
        `monitoring.history.transactions.${index}.id`,
        `redacted-transaction-${index + 1}`,
        findings
      ),
      sourceAlias: sanitizedAliases.get(transaction.sourceAlias) ?? `redacted-income-source-${index + 1}`
    }));
    sanitized.monitoring.history.overrides = sanitized.monitoring.history.overrides.map((override) => ({
      ...override,
      sourceAlias: sanitizedAliases.get(override.sourceAlias) ?? "redacted-income-source"
    }));
  }
  return { request: sanitized, findings, summary: summarizeSensitiveData(findings) };
}

export function buildSafetyPreview(request: SafetyPreviewRequest): SafetyPreview {
  const { summary } = sanitizeAgentRequest(request);
  return {
    destination: "Amazon Bedrock via Strands",
    fieldsSent: [
      "Your question",
      "Balance, paycheck, buffer, and dates",
      "Bill names, categories, amounts, and due dates",
      ...(request.monitoring ? [
        "Locally derived generic income-source confidence, disruption codes, coverage forecast, case decision, and resolution-case status/history"
      ] : []),
      ...(request.policySources.length > 0 ? ["Saved policy sources relevant to the question"] : [])
    ],
    localOnlyFields: request.monitoring ? [
      "Synthetic normalized transaction IDs, dates, amounts, directions, source aliases, classifications, and user pattern corrections"
    ] : [],
    policySourceCount: request.policySources.length,
    monitoringHistorySentToModel: false,
    redactions: summary,
    rawMatchedValuesReturned: false,
    ephemeralByDefault: true
  };
}

export function inspectUnknownForSensitiveData(value: unknown, path = "output"): SensitiveDataFinding[] {
  const findings: SensitiveDataFinding[] = [];
  const visit = (current: unknown, currentPath: string): void => {
    if (typeof current === "string") {
      findings.push(...inspectAndRedactText(current, currentPath).findings);
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, `${currentPath}.${index}`));
      return;
    }
    if (current && typeof current === "object") {
      Object.entries(current).forEach(([key, entry]) => visit(entry, `${currentPath}.${key}`));
    }
  };
  visit(value, path);
  return findings;
}
