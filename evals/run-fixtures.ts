import { readFile } from "node:fs/promises";
import { analyzeCashflow, findPressurePoints } from "../src/agent/calculations.js";
import { DisruptionSchema, FinancialPlanSchema } from "../src/agent/schemas.js";

const fixtures = JSON.parse(await readFile(new URL("./cases.json", import.meta.url), "utf8")) as Array<{
  id: string;
  disruption: unknown;
  expectedTools: string[];
  successCriteria: string[];
}>;

const plan = FinancialPlanSchema.parse({
  name: "Alex",
  balance: 642,
  paycheck: 1840,
  buffer: 100,
  payday: "2026-08-25",
  periodStart: "2026-08-11",
  bills: [
    { id: "phone", name: "Phone bill", amount: 74, due: "2026-08-18", category: "Utilities" },
    { id: "groceries", name: "Groceries", amount: 95, due: "2026-08-20", category: "Food" },
    { id: "insurance", name: "Car insurance", amount: 126, due: "2026-08-23", category: "Transport" }
  ]
});

for (const fixture of fixtures) {
  const disruption = DisruptionSchema.parse(fixture.disruption);
  const analysis = analyzeCashflow(plan, "2026-08-17", disruption);
  const pressurePoints = findPressurePoints(analysis);
  if (!fixture.expectedTools.includes("verify_financial_plan")) throw new Error(`${fixture.id}: verifier is not required`);
  if (fixture.successCriteria.length < 3) throw new Error(`${fixture.id}: success criteria are too weak`);
  console.log(`${fixture.id.padEnd(28)} risk=${analysis.riskLevel.padEnd(9)} safe=$${analysis.safeToSpend.toFixed(2).padStart(7)} pressure_points=${pressurePoints.length}`);
}

console.log(`\nValidated ${fixtures.length} deterministic agent-evaluation fixtures.`);
