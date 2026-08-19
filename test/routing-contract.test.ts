import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ORCHESTRATOR_PROMPT, VERIFIER_PROMPT } from "../src/agent/prompts.js";
import { PlanStore } from "../src/agent/plan-store.js";
import { createFinancialTools } from "../src/agent/tools.js";

const browserSource = await readFile(new URL("../app.js", import.meta.url), "utf8");

test("orchestrator requires pressure and option tools for open-ended reduced-income planning", () => {
  assert.match(
    ORCHESTRATOR_PROMPT,
    /For a reduced-income disruption followed by “what should I change\?”, both identify_pressure_points and compare_plan_options are required before verification\./
  );
  assert.match(ORCHESTRATOR_PROMPT, /Call analyze_paycheck_scenario exactly once\./);
});

test("financial toolset exposes one structurally exclusive primary calculation", () => {
  const names = createFinancialTools(new PlanStore()).map((candidate) => candidate.name);
  assert.equal(names.filter((name) => name === "analyze_paycheck_scenario").length, 1);
  assert.equal(names.includes("build_cashflow_timeline"), false);
  assert.equal(names.includes("simulate_disruption"), false);
});

test("browser displays the structured autonomy contract", () => {
  assert.match(browserSource, /option\.upside/);
  assert.match(browserSource, /option\.tradeoff/);
  assert.match(browserSource, /option\.fitPriority/);
  assert.match(browserSource, /recommendation\.decisionSupport\?\.choicePrompt/);
});

test("orchestrator and verifier reject flattery, coercive value judgments, predatory credit, and illegal conduct", () => {
  for (const prompt of [ORCHESTRATOR_PROMPT, VERIFIER_PROMPT]) {
    assert.match(prompt, /good catch/);
    assert.match(prompt, /opening a new credit card/);
    assert.match(prompt, /illegal/);
    assert.match(prompt, /unethical/);
  }
  assert.match(ORCHESTRATOR_PROMPT, /leave personal value judgments to the user/);
  assert.match(ORCHESTRATOR_PROMPT, /Do not call a value-dependent choice “best,” “right,” “responsible,” or “obvious.”/);
  assert.match(ORCHESTRATOR_PROMPT, /decisionSupport\.decisionOwner to “user”/);
  assert.match(ORCHESTRATOR_PROMPT, /For every options\[\] item, provide upside, tradeoff, and fitPriority/);
  assert.match(VERIFIER_PROMPT, /Reserve “must” and “should” for factual safety, legal, or eligibility constraints/);
});
