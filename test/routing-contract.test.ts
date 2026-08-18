import test from "node:test";
import assert from "node:assert/strict";
import { ORCHESTRATOR_PROMPT } from "../src/agent/prompts.js";

test("orchestrator requires pressure and option tools for open-ended reduced-income planning", () => {
  assert.match(
    ORCHESTRATOR_PROMPT,
    /For a reduced-income disruption followed by “what should I change\?”, both identify_pressure_points and compare_plan_options are required before verification\./
  );
});
