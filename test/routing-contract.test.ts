import test from "node:test";
import assert from "node:assert/strict";
import { ORCHESTRATOR_PROMPT, VERIFIER_PROMPT } from "../src/agent/prompts.js";

test("orchestrator requires pressure and option tools for open-ended reduced-income planning", () => {
  assert.match(
    ORCHESTRATOR_PROMPT,
    /For a reduced-income disruption followed by “what should I change\?”, both identify_pressure_points and compare_plan_options are required before verification\./
  );
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
  assert.match(VERIFIER_PROMPT, /Reserve “must” and “should” for factual safety, legal, or eligibility constraints/);
});
