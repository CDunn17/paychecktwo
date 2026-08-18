import { basename, dirname, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  SEMANTIC_RUBRIC_VERSION,
  SemanticJudgeSchema,
  finalizeSemanticEvaluation
} from "./semantic-judge.js";

const StoredSemanticEvaluationSchema = SemanticJudgeSchema.extend({
  passed: z.boolean(),
  failedCriteria: z.array(z.string())
});

const StoredReportSchema = z.object({
  generatedAt: z.string(),
  model: z.string().nullable(),
  semanticJudgeModel: z.string().nullable().optional(),
  contractVersion: z.number().nullable(),
  results: z.array(z.object({
    id: z.string(),
    trial: z.number().int().positive(),
    automaticChecks: z.record(z.string(), z.boolean()).nullable(),
    semanticEvaluation: StoredSemanticEvaluationSchema.nullable()
  }))
});

const FixtureSchema = z.object({
  id: z.string(),
  expectedTools: z.array(z.string())
});

const [inputArgument, outputArgument] = process.argv.slice(2);
if (!inputArgument || !outputArgument) {
  throw new Error("Usage: npm run eval:semantic:reclassify -- <input-report.json> <output-report.json>");
}

const inputPath = resolve(inputArgument);
const outputPath = resolve(outputArgument);
const storedReport = StoredReportSchema.parse(JSON.parse(await readFile(inputPath, "utf8")));
const fixtures = z.array(FixtureSchema).parse(
  JSON.parse(await readFile(new URL("./cases.json", import.meta.url), "utf8"))
);
const policyExpectedById = new Map(
  fixtures.map((fixture) => [fixture.id, fixture.expectedTools.includes("review_terms_and_policies")])
);

const results = storedReport.results.map((result) => {
  if (!result.semanticEvaluation) {
    return { id: result.id, trial: result.trial, passed: false, reason: "missing_semantic_evaluation" as const };
  }
  const policyExpected = policyExpectedById.get(result.id);
  if (policyExpected === undefined) {
    return { id: result.id, trial: result.trial, passed: false, reason: "unknown_fixture" as const };
  }
  const semanticEvaluation = finalizeSemanticEvaluation(
    SemanticJudgeSchema.parse(result.semanticEvaluation),
    policyExpected
  );
  const automaticPassed = result.automaticChecks !== null
    && Object.values(result.automaticChecks).every(Boolean);
  return {
    id: result.id,
    trial: result.trial,
    passed: automaticPassed && semanticEvaluation.passed,
    automaticPassed,
    policyExpected,
    semanticEvaluation
  };
});

const passedRuns = results.filter((result) => result.passed).length;
const output = {
  generatedAt: new Date().toISOString(),
  sourceReport: basename(inputPath),
  sourceGeneratedAt: storedReport.generatedAt,
  model: storedReport.model,
  semanticJudgeModel: storedReport.semanticJudgeModel ?? storedReport.model,
  semanticJudgeModelSource: storedReport.semanticJudgeModel ? "source_report" : "legacy_default_to_main_model",
  contractVersion: storedReport.contractVersion,
  semanticRubricVersion: SEMANTIC_RUBRIC_VERSION,
  note: "Reclassified from stored scores and fixed flags without a model invocation; no recommendation text is retained. This can reapply score thresholds, but it cannot apply a new detector that requires the original recommendation.",
  passed: passedRuns === results.length,
  runsPassed: passedRuns,
  runsTotal: results.length,
  passRatePercent: Number(((passedRuns / results.length) * 100).toFixed(1)),
  results
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(`Reclassified ${passedRuns}/${results.length} runs with semantic rubric v${SEMANTIC_RUBRIC_VERSION}.`);
console.log(`Wrote sanitized report to ${outputPath}.`);
if (!output.passed) process.exitCode = 1;
