import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import dotenv from "dotenv";
import { adversarialSemanticCases } from "./adversarial-semantic-cases.js";
import {
  SEMANTIC_RUBRIC_VERSION,
  SemanticJudgeError,
  judgeRecommendation
} from "./semantic-judge.js";

dotenv.config({ quiet: true });

const argumentsList = process.argv.slice(2);
const outputArgument = argumentsList.find((argument) => argument.startsWith("--output="))?.slice("--output=".length);
const requestedCaseIds = new Set(argumentsList.filter((argument) => !argument.startsWith("--")));
const selectedCases = requestedCaseIds.size === 0
  ? adversarialSemanticCases
  : adversarialSemanticCases.filter((testCase) => requestedCaseIds.has(testCase.id));
if (selectedCases.length !== (requestedCaseIds.size || adversarialSemanticCases.length)) {
  throw new Error(`Unknown adversarial case. Available IDs: ${adversarialSemanticCases.map((testCase) => testCase.id).join(", ")}`);
}
const results = [];

for (const testCase of selectedCases) {
  try {
    const judged = await judgeRecommendation({
      scenarioId: testCase.id,
      syntheticUserGoal: testCase.syntheticUserGoal,
      successCriteria: testCase.successCriteria,
      deterministicEvidence: {
        riskLevel: testCase.recommendation.riskLevel,
        safeToSpend: testCase.recommendation.safeToSpend,
        dailyFlexibleLimit: testCase.recommendation.dailyFlexibleLimit
      },
      recommendation: testCase.recommendation,
      policyExpected: testCase.policyExpected
    });
    const requiredStyleFlagsPresent = (testCase.expected.requiredStyleFlags ?? [])
      .every((flag) => judged.evaluation.styleFlags.includes(flag));
    const requiredSafetyFlagsPresent = (testCase.expected.requiredSafetyFlags ?? [])
      .every((flag) => judged.evaluation.safetyFlags.includes(flag));
    const cleanCaseHasNoFlags = !testCase.expected.semanticPass
      || (judged.evaluation.styleFlags.length === 0 && judged.evaluation.safetyFlags.length === 0);
    const harmfulAdviceScoreWithinExpectedMaximum = testCase.expected.maximumHarmfulAdviceSafety === undefined
      || judged.evaluation.scores.harmfulAdviceSafety <= testCase.expected.maximumHarmfulAdviceSafety;
    const checks = {
      semanticOutcomeMatches: judged.evaluation.passed === testCase.expected.semanticPass,
      requiredStyleFlagsPresent,
      requiredSafetyFlagsPresent,
      cleanCaseHasNoFlags,
      harmfulAdviceScoreWithinExpectedMaximum
    };
    const passed = Object.values(checks).every(Boolean);
    results.push({
      id: testCase.id,
      passed,
      expected: testCase.expected,
      checks,
      observed: judged.evaluation,
      metrics: judged.metrics
    });
    console.log(`${passed ? "PASS" : "FAIL"} ${testCase.id.padEnd(32)} semantic=${judged.evaluation.passed ? "PASS" : "FAIL"} style=${judged.evaluation.styleFlags.join(",") || "none"} safety=${judged.evaluation.safetyFlags.join(",") || "none"}`);
  } catch (error) {
    const failureCode = error instanceof SemanticJudgeError ? error.code : "judge_unavailable";
    results.push({ id: testCase.id, passed: false, expected: testCase.expected, failureCode });
    console.log(`FAIL ${testCase.id.padEnd(32)} reason=${failureCode}`);
  }
}

const inputTokens = results.reduce((total, result) => total + ("metrics" in result ? (result.metrics?.tokens.inputTokens ?? 0) : 0), 0);
const outputTokens = results.reduce((total, result) => total + ("metrics" in result ? (result.metrics?.tokens.outputTokens ?? 0) : 0), 0);
const inputUsdPerMillionTokens = Number(process.env.EVAL_INPUT_USD_PER_MILLION_TOKENS ?? 3);
const outputUsdPerMillionTokens = Number(process.env.EVAL_OUTPUT_USD_PER_MILLION_TOKENS ?? 15);
const passedCases = results.filter((result) => result.passed).length;
const report = {
  generatedAt: new Date().toISOString(),
  model: process.env.EVAL_JUDGE_MODEL_ID ?? process.env.STRANDS_MODEL_ID ?? "global.anthropic.claude-sonnet-4-6",
  semanticRubricVersion: SEMANTIC_RUBRIC_VERSION,
  note: "Synthetic adversarial recommendations are stored only in source fixtures; this report retains fixed expectations, scores, flags, safe failure codes, and metrics.",
  passed: passedCases === results.length,
  casesPassed: passedCases,
  casesTotal: results.length,
  passRatePercent: Number(((passedCases / results.length) * 100).toFixed(1)),
  cost: {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedUsd: Number((((inputTokens * inputUsdPerMillionTokens) + (outputTokens * outputUsdPerMillionTokens)) / 1_000_000).toFixed(4))
  },
  results
};

console.log(`\nAdversarial semantic calibration: ${passedCases}/${results.length} cases passed.`);
if (outputArgument) {
  const outputPath = resolve(outputArgument);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Wrote sanitized report to ${outputPath}.`);
}
if (!report.passed) process.exitCode = 1;
