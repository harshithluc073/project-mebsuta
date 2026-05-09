/**
 * Scenario benchmark and chaos harness.
 *
 * Blueprint: `architecture_docs/20_QA_TESTING_CHAOS_AND_BENCHMARK_ARCHITECTURE.md`
 * sections 20.3, 20.17, 20.18, 20.19, 20.20, and 20.22.
 *
 * This PIT-B11 surface composes scenario specs, benchmark scorecards, chaos
 * records, golden comparisons, replay closure, and release-readiness evidence
 * while keeping runtime artifacts separated from offline QA scoring artifacts.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import { buildAssertionResult } from "./assertion_result_evaluator";
import type { AssertionResult } from "./assertion_result_evaluator";
import { buildBenchmarkScorecard, validateBenchmarkScorecard } from "./benchmark_scorecard";
import type { BenchmarkMetricsInput, BenchmarkScorecard, ReleaseGateStatus } from "./benchmark_scorecard";
import { validateChaosInjectionRecord } from "./chaos_injection_record";
import type { ChaosInjectionRecord } from "./chaos_injection_record";
import { validateRegressionComparisonReport } from "./regression_comparison_report";
import type { RegressionComparisonReport } from "./regression_comparison_report";
import { buildReleaseReadinessReport } from "./release_readiness_report";
import type { ReleaseGateEvidence, ReleaseReadinessReport } from "./release_readiness_report";
import { validateScenarioBenchmarkSpec } from "./scenario_benchmark_spec";
import type { ScenarioBenchmarkSpec } from "./scenario_benchmark_spec";
import {
  QA_BLUEPRINT_REF,
  QaContractError,
  buildQaValidationReport,
  freezeQaArray,
  makeQaRef,
  normalizeQaText,
  qaIssue,
  qaRouteForIssues,
  uniqueQaRefs,
  validateNonEmptyQaArray,
  validateQaRef,
  validateQaRefs,
  validateQaText,
} from "./test_case_spec";
import type { QaOutcome, QaValidationReport } from "./test_case_spec";
import { buildTestRunRecord, deriveRunStatus } from "./test_run_record";
import type { TestRunRecord } from "./test_run_record";

export const SCENARIO_BENCHMARK_CHAOS_HARNESS_SCHEMA_VERSION = "mebsuta.qa.scenario_benchmark_chaos_harness.v1" as const;

export interface GoldenScenarioEvidenceInput {
  readonly golden_baseline_ref: Ref;
  readonly current_run_ref: Ref;
  readonly compared_artifact_refs: readonly Ref[];
  readonly runtime_artifact_refs: readonly Ref[];
  readonly qa_scoped_artifact_refs: readonly Ref[];
  readonly required_replay_refs: readonly Ref[];
  readonly observed_replay_refs: readonly Ref[];
  readonly replay_bundle_ref: Ref;
}

export interface GoldenScenarioEvidence {
  readonly golden_baseline_ref: Ref;
  readonly current_run_ref: Ref;
  readonly compared_artifact_refs: readonly Ref[];
  readonly runtime_artifact_refs: readonly Ref[];
  readonly qa_scoped_artifact_refs: readonly Ref[];
  readonly required_replay_refs: readonly Ref[];
  readonly observed_replay_refs: readonly Ref[];
  readonly missing_replay_refs: readonly Ref[];
  readonly replay_bundle_ref: Ref;
  readonly replay_completeness_rate: number;
  readonly truth_isolated: boolean;
}

export interface ScenarioBenchmarkChaosHarnessInput {
  readonly harness_run_ref: Ref;
  readonly milestone_ref: Ref;
  readonly scenario_spec: ScenarioBenchmarkSpec;
  readonly scenario_run_refs: readonly Ref[];
  readonly benchmark_metrics: BenchmarkMetricsInput;
  readonly chaos_records: readonly ChaosInjectionRecord[];
  readonly regression_reports: readonly RegressionComparisonReport[];
  readonly golden_evidence: GoldenScenarioEvidenceInput;
  readonly started_at_ms: number;
  readonly ended_at_ms: number;
  readonly operator_summary: string;
}

export interface ScenarioBenchmarkChaosHarnessReport {
  readonly schema_version: typeof SCENARIO_BENCHMARK_CHAOS_HARNESS_SCHEMA_VERSION;
  readonly harness_run_ref: Ref;
  readonly milestone_ref: Ref;
  readonly scenario_benchmark_ref: Ref;
  readonly scenario_run_refs: readonly Ref[];
  readonly scenario_spec_validation_report: QaValidationReport;
  readonly benchmark_scorecard: BenchmarkScorecard;
  readonly benchmark_scorecard_validation_report: QaValidationReport;
  readonly chaos_validation_reports: readonly QaValidationReport[];
  readonly regression_validation_reports: readonly QaValidationReport[];
  readonly golden_evidence: GoldenScenarioEvidence;
  readonly assertion_results: readonly AssertionResult[];
  readonly test_run_record: TestRunRecord;
  readonly release_readiness_report: ReleaseReadinessReport;
  readonly no_go_conditions: readonly string[];
  readonly overall_status: QaOutcome;
  readonly determinism_hash: string;
}

/**
 * Executes PIT-B11 scenario benchmark and chaos evidence aggregation.
 */
export function executeScenarioBenchmarkChaosHarness(input: ScenarioBenchmarkChaosHarnessInput): ScenarioBenchmarkChaosHarnessReport {
  const scenarioSpecValidation = validateScenarioBenchmarkSpec(input.scenario_spec);
  const benchmarkScorecard = buildBenchmarkScorecard({
    scorecard_ref: makeQaRef(input.harness_run_ref, "scorecard"),
    scenario_benchmark_ref: input.scenario_spec.scenario_benchmark_ref,
    scenario_run_refs: input.scenario_run_refs,
    metrics: input.benchmark_metrics,
    scoring_policy: input.scenario_spec.scoring_policy,
  });
  const benchmarkValidation = validateBenchmarkScorecard(benchmarkScorecard, input.scenario_spec.scoring_policy);
  const chaosValidations = freezeQaArray(input.chaos_records.map(validateChaosInjectionRecord));
  const regressionValidations = freezeQaArray(input.regression_reports.map(validateRegressionComparisonReport));
  const goldenEvidence = normalizeGoldenScenarioEvidence(input.golden_evidence);
  const assertions = buildHarnessAssertions(input, scenarioSpecValidation, benchmarkScorecard, benchmarkValidation, chaosValidations, regressionValidations, goldenEvidence);
  const overallStatus = deriveRunStatus(assertions.map((assertion) => assertion.status));
  const noGoConditions = buildNoGoConditions(input.chaos_records, input.regression_reports, goldenEvidence, benchmarkScorecard, overallStatus);
  const testRunRecord = buildTestRunRecord({
    test_run_ref: input.harness_run_ref,
    test_case_ref: makeQaRef(input.harness_run_ref, "scenario_benchmark_case"),
    scenario_run_ref: input.scenario_run_refs[0],
    collection_mode: "benchmark_sweep",
    timing: {
      start_time_ms: input.started_at_ms,
      end_time_ms: input.ended_at_ms,
    },
    runtime_artifact_refs: runtimeEvidenceRefs(input, benchmarkScorecard, goldenEvidence, assertions),
    qa_truth_artifact_refs: goldenEvidence.qa_scoped_artifact_refs,
    assertion_result_refs: assertions.map((assertion) => assertion.assertion_ref),
    replay_bundle_ref: goldenEvidence.replay_bundle_ref,
    overall_status: overallStatus,
  });
  const releaseReadinessReport = buildReleaseReadinessReport({
    release_report_ref: makeQaRef(input.harness_run_ref, "scenario_benchmark_release_readiness"),
    milestone_ref: input.milestone_ref,
    gate_evidence: buildGateEvidence(input, benchmarkScorecard, assertions, goldenEvidence),
    benchmark_scorecard_refs: [benchmarkScorecard.scorecard_ref],
    regression_report_refs: input.regression_reports.map((report) => report.regression_report_ref),
    chaos_record_refs: input.chaos_records.map((record) => record.chaos_test_ref),
    no_go_conditions: noGoConditions,
    operator_summary: input.operator_summary,
  });
  const base = {
    schema_version: SCENARIO_BENCHMARK_CHAOS_HARNESS_SCHEMA_VERSION,
    harness_run_ref: input.harness_run_ref,
    milestone_ref: input.milestone_ref,
    scenario_benchmark_ref: input.scenario_spec.scenario_benchmark_ref,
    scenario_run_refs: uniqueQaRefs(input.scenario_run_refs),
    scenario_spec_validation_report: scenarioSpecValidation,
    benchmark_scorecard: benchmarkScorecard,
    benchmark_scorecard_validation_report: benchmarkValidation,
    chaos_validation_reports: chaosValidations,
    regression_validation_reports: regressionValidations,
    golden_evidence: goldenEvidence,
    assertion_results: freezeQaArray(assertions),
    test_run_record: testRunRecord,
    release_readiness_report: releaseReadinessReport,
    no_go_conditions: noGoConditions,
    overall_status: overallStatus,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateScenarioBenchmarkChaosHarnessReport(report: ScenarioBenchmarkChaosHarnessReport): QaValidationReport {
  const issues: ValidationIssue[] = [];
  validateQaRef(report.harness_run_ref, "$.harness_run_ref", issues);
  validateQaRef(report.milestone_ref, "$.milestone_ref", issues);
  validateQaRef(report.scenario_benchmark_ref, "$.scenario_benchmark_ref", issues);
  validateQaRefs(report.scenario_run_refs, "$.scenario_run_refs", issues);
  validateNonEmptyQaArray(report.scenario_run_refs, "$.scenario_run_refs", "ScenarioRunsMissing", issues);
  validateNonEmptyQaArray(report.chaos_validation_reports, "$.chaos_validation_reports", "ChaosReportsMissing", issues);
  validateNonEmptyQaArray(report.regression_validation_reports, "$.regression_validation_reports", "RegressionReportsMissing", issues);
  validateGoldenScenarioEvidence(report.golden_evidence, "$.golden_evidence", issues);
  if (report.overall_status === "ok" && report.no_go_conditions.length > 0) {
    issues.push(qaIssue("error", "ScenarioHarnessOkWithNoGo", "$.overall_status", "Harness cannot be ok when no-go conditions exist.", "Derive status from failed assertions and blocking gates."));
  }
  if (report.release_readiness_report.decision === "go" && report.no_go_conditions.length > 0) {
    issues.push(qaIssue("error", "ScenarioHarnessReleaseGoWithNoGo", "$.release_readiness_report.decision", "Release readiness cannot be go when no-go conditions exist.", "Carry blocking conditions into release readiness."));
  }
  return buildQaValidationReport(makeQaRef("scenario_benchmark_chaos_harness_report", report.harness_run_ref), issues, qaRouteForIssues(issues));
}

export function assertValidScenarioBenchmarkChaosHarnessReport(report: ScenarioBenchmarkChaosHarnessReport): void {
  const validation = validateScenarioBenchmarkChaosHarnessReport(report);
  if (!validation.ok) {
    throw new QaContractError("Scenario benchmark chaos harness report failed validation.", validation.issues);
  }
}

export function normalizeGoldenScenarioEvidence(input: GoldenScenarioEvidenceInput): GoldenScenarioEvidence {
  const runtimeRefs = uniqueQaRefs(input.runtime_artifact_refs);
  const qaRefs = uniqueQaRefs(input.qa_scoped_artifact_refs);
  const requiredReplayRefs = uniqueQaRefs(input.required_replay_refs);
  const observedReplayRefs = uniqueQaRefs(input.observed_replay_refs);
  const observedSet = new Set(observedReplayRefs);
  const missingReplayRefs = uniqueQaRefs(requiredReplayRefs.filter((ref) => !observedSet.has(ref)));
  const runtimeSet = new Set(runtimeRefs);
  const truthIsolated = qaRefs.every((ref) => !runtimeSet.has(ref));
  return Object.freeze({
    golden_baseline_ref: input.golden_baseline_ref,
    current_run_ref: input.current_run_ref,
    compared_artifact_refs: uniqueQaRefs(input.compared_artifact_refs),
    runtime_artifact_refs: runtimeRefs,
    qa_scoped_artifact_refs: qaRefs,
    required_replay_refs: requiredReplayRefs,
    observed_replay_refs: observedReplayRefs,
    missing_replay_refs: missingReplayRefs,
    replay_bundle_ref: input.replay_bundle_ref,
    replay_completeness_rate: requiredReplayRefs.length === 0 ? 0 : (requiredReplayRefs.length - missingReplayRefs.length) / requiredReplayRefs.length,
    truth_isolated: truthIsolated,
  });
}

function buildHarnessAssertions(
  input: ScenarioBenchmarkChaosHarnessInput,
  scenarioSpecValidation: QaValidationReport,
  scorecard: BenchmarkScorecard,
  scorecardValidation: QaValidationReport,
  chaosValidations: readonly QaValidationReport[],
  regressionValidations: readonly QaValidationReport[],
  goldenEvidence: GoldenScenarioEvidence,
): readonly AssertionResult[] {
  const chaosReleaseBlockCount = input.chaos_records.filter((record) => record.release_blocking).length;
  const regressionReleaseBlockCount = input.regression_reports.filter((report) => report.release_impact === "release_block").length;
  return freezeQaArray([
    buildAssertionResult({
      assertion_ref: makeQaRef(input.harness_run_ref, "scenario_spec_contract"),
      test_run_ref: input.harness_run_ref,
      assertion_category: "schema",
      expected: "scenario benchmark spec validates",
      observed: `scenario_spec_errors=${scenarioSpecValidation.error_count}`,
      status: scenarioSpecValidation.ok ? "ok" : "fail",
      severity: scenarioSpecValidation.ok ? "warning" : "error",
      evidence_refs: [scenarioSpecValidation.report_ref, input.scenario_spec.scenario_benchmark_ref],
      remediation_hint: "Repair the scenario benchmark contract before benchmark execution.",
    }),
    buildAssertionResult({
      assertion_ref: makeQaRef(input.harness_run_ref, "benchmark_scorecard_gate"),
      test_run_ref: input.harness_run_ref,
      assertion_category: "benchmark",
      expected: "benchmark scorecard validates and is not red",
      observed: `score=${formatQaRatio(scorecard.aggregate_score)}; gate=${scorecard.release_gate_status}; errors=${scorecardValidation.error_count}`,
      status: scorecardValidation.ok && scorecard.release_gate_status !== "red" ? "ok" : "fail",
      severity: scorecardValidation.ok && scorecard.release_gate_status !== "red" ? "warning" : "error",
      evidence_refs: [scorecard.scorecard_ref, scorecardValidation.report_ref],
      remediation_hint: "Review scorecard metrics and blocking benchmark conditions.",
    }),
    buildAssertionResult({
      assertion_ref: makeQaRef(input.harness_run_ref, "chaos_detection_records"),
      test_run_ref: input.harness_run_ref,
      assertion_category: "chaos",
      expected: "chaos records validate with zero release blocks",
      observed: `chaos_records=${input.chaos_records.length}; release_blocks=${chaosReleaseBlockCount}; validation_errors=${sumErrors(chaosValidations)}`,
      status: input.chaos_records.length > 0 && chaosReleaseBlockCount === 0 && sumErrors(chaosValidations) === 0 ? "ok" : "fail",
      severity: input.chaos_records.length > 0 && chaosReleaseBlockCount === 0 && sumErrors(chaosValidations) === 0 ? "warning" : "error",
      evidence_refs: uniqueQaRefs([...input.chaos_records.map((record) => record.chaos_test_ref), ...chaosValidations.map((report) => report.report_ref)]),
      remediation_hint: "Replay failed chaos cases and repair detection or route policy.",
    }),
    buildAssertionResult({
      assertion_ref: makeQaRef(input.harness_run_ref, "golden_regression_comparison"),
      test_run_ref: input.harness_run_ref,
      assertion_category: "benchmark",
      expected: "golden scenario comparisons have no release block drift",
      observed: `regression_reports=${input.regression_reports.length}; release_blocks=${regressionReleaseBlockCount}; validation_errors=${sumErrors(regressionValidations)}`,
      status: input.regression_reports.length > 0 && regressionReleaseBlockCount === 0 && sumErrors(regressionValidations) === 0 ? "ok" : "fail",
      severity: input.regression_reports.length > 0 && regressionReleaseBlockCount === 0 && sumErrors(regressionValidations) === 0 ? "warning" : "error",
      evidence_refs: uniqueQaRefs([...input.regression_reports.map((report) => report.regression_report_ref), ...regressionValidations.map((report) => report.report_ref)]),
      remediation_hint: "Review golden drift and attach remediation refs before release gating.",
    }),
    buildAssertionResult({
      assertion_ref: makeQaRef(input.harness_run_ref, "replay_completeness"),
      test_run_ref: input.harness_run_ref,
      assertion_category: "observability",
      expected: "all required replay refs are present",
      observed: `replay_completeness=${formatQaRatio(goldenEvidence.replay_completeness_rate)}; missing=${goldenEvidence.missing_replay_refs.length}`,
      status: goldenEvidence.missing_replay_refs.length === 0 ? "ok" : "fail",
      severity: goldenEvidence.missing_replay_refs.length === 0 ? "warning" : "error",
      evidence_refs: uniqueQaRefs([goldenEvidence.replay_bundle_ref, ...goldenEvidence.observed_replay_refs]),
      remediation_hint: "Capture missing replay artifacts before benchmark acceptance.",
    }),
    buildAssertionResult({
      assertion_ref: makeQaRef(input.harness_run_ref, "qa_truth_isolation"),
      test_run_ref: input.harness_run_ref,
      assertion_category: "provenance",
      expected: "QA-scoped scoring refs do not appear in runtime artifact refs",
      observed: goldenEvidence.truth_isolated ? "truth_isolated=true" : "truth_isolated=false",
      status: goldenEvidence.truth_isolated ? "ok" : "fail",
      severity: goldenEvidence.truth_isolated ? "warning" : "error",
      evidence_refs: uniqueQaRefs([...goldenEvidence.runtime_artifact_refs, ...goldenEvidence.qa_scoped_artifact_refs]),
      remediation_hint: "Separate runtime evidence refs from offline scoring refs and rerun the benchmark.",
    }),
  ]);
}

function buildGateEvidence(
  input: ScenarioBenchmarkChaosHarnessInput,
  scorecard: BenchmarkScorecard,
  assertions: readonly AssertionResult[],
  goldenEvidence: GoldenScenarioEvidence,
): readonly ReleaseGateEvidence[] {
  const assertionRefs = assertions.map((assertion) => assertion.assertion_ref);
  const assertionStatus = assertions.some((assertion) => assertion.status === "fail") ? "red" as const : scorecard.release_gate_status;
  return freezeQaArray([
    gateEvidence(input.harness_run_ref, "scenario_benchmark", "scenario_benchmark", scorecard.release_gate_status, [scorecard.scorecard_ref, ...assertionRefs], "Scenario benchmark scorecard and aggregate threshold evidence are recorded."),
    gateEvidence(input.harness_run_ref, "chaos", "chaos", gateStatusFromAssertion(assertions, "chaos_detection_records"), [...input.chaos_records.map((record) => record.chaos_test_ref), ...assertionRefs], "Chaos records prove detection signals, route outcomes, and blocking status."),
    gateEvidence(input.harness_run_ref, "regression", "prompt_model", gateStatusFromAssertion(assertions, "golden_regression_comparison"), [...input.regression_reports.map((report) => report.regression_report_ref), ...assertionRefs], "Golden comparison evidence records current drift against baseline artifacts."),
    gateEvidence(input.harness_run_ref, "replay", "observability", goldenEvidence.missing_replay_refs.length === 0 ? "green" : "red", [goldenEvidence.replay_bundle_ref, ...goldenEvidence.observed_replay_refs], "Replay evidence closure is available for benchmark and chaos outcomes."),
    gateEvidence(input.harness_run_ref, "truth_isolation", "verification", goldenEvidence.truth_isolated ? assertionStatus : "red", [...goldenEvidence.runtime_artifact_refs, ...goldenEvidence.qa_scoped_artifact_refs], "Runtime evidence refs stay separated from QA-scoped scoring refs."),
    gateEvidence(input.harness_run_ref, "memory", "memory", input.benchmark_metrics.memory_contamination_count === 0 ? "green" : "red", [scorecard.scorecard_ref], "Benchmark metrics report zero verified memory contamination."),
  ]);
}

function gateEvidence(harnessRunRef: Ref, suffix: string, gateClass: ReleaseGateEvidence["gate_class"], status: ReleaseGateStatus, evidenceRefs: readonly Ref[], summary: string): ReleaseGateEvidence {
  return Object.freeze({
    gate_ref: makeQaRef(harnessRunRef, "gate", suffix),
    gate_class: gateClass,
    status,
    evidence_refs: uniqueQaRefs(evidenceRefs),
    summary: normalizeQaText(summary, 600),
  });
}

function gateStatusFromAssertion(assertions: readonly AssertionResult[], suffix: string): ReleaseGateStatus {
  const assertion = assertions.find((item) => item.assertion_ref.endsWith(suffix));
  return assertion?.status === "fail" ? "red" : "green";
}

function buildNoGoConditions(
  chaosRecords: readonly ChaosInjectionRecord[],
  regressionReports: readonly RegressionComparisonReport[],
  goldenEvidence: GoldenScenarioEvidence,
  scorecard: BenchmarkScorecard,
  overallStatus: QaOutcome,
): readonly string[] {
  const conditions: string[] = [];
  if (overallStatus === "fail" || overallStatus === "blocked") {
    conditions.push("scenario_benchmark_harness_failed");
  }
  if (scorecard.release_gate_status === "red") {
    conditions.push("benchmark_scorecard_red");
  }
  if (chaosRecords.some((record) => record.release_blocking)) {
    conditions.push("chaos_release_block");
  }
  if (regressionReports.some((report) => report.release_impact === "release_block")) {
    conditions.push("golden_regression_release_block");
  }
  if (goldenEvidence.missing_replay_refs.length > 0) {
    conditions.push("replay_evidence_incomplete");
  }
  if (!goldenEvidence.truth_isolated) {
    conditions.push("qa_truth_isolation_failed");
  }
  return freezeQaArray(conditions);
}

function runtimeEvidenceRefs(
  input: ScenarioBenchmarkChaosHarnessInput,
  scorecard: BenchmarkScorecard,
  goldenEvidence: GoldenScenarioEvidence,
  assertions: readonly AssertionResult[],
): readonly Ref[] {
  return uniqueQaRefs([
    input.scenario_spec.scenario_benchmark_ref,
    scorecard.scorecard_ref,
    ...input.scenario_run_refs,
    ...goldenEvidence.runtime_artifact_refs,
    ...goldenEvidence.observed_replay_refs,
    ...assertions.map((assertion) => assertion.assertion_ref),
  ]);
}

function validateGoldenScenarioEvidence(evidence: GoldenScenarioEvidence, path: string, issues: ValidationIssue[]): void {
  validateQaRef(evidence.golden_baseline_ref, `${path}.golden_baseline_ref`, issues);
  validateQaRef(evidence.current_run_ref, `${path}.current_run_ref`, issues);
  validateQaRef(evidence.replay_bundle_ref, `${path}.replay_bundle_ref`, issues);
  validateQaRefs(evidence.compared_artifact_refs, `${path}.compared_artifact_refs`, issues);
  validateQaRefs(evidence.runtime_artifact_refs, `${path}.runtime_artifact_refs`, issues);
  validateQaRefs(evidence.qa_scoped_artifact_refs, `${path}.qa_scoped_artifact_refs`, issues);
  validateQaRefs(evidence.required_replay_refs, `${path}.required_replay_refs`, issues);
  validateQaRefs(evidence.observed_replay_refs, `${path}.observed_replay_refs`, issues);
  validateQaRefs(evidence.missing_replay_refs, `${path}.missing_replay_refs`, issues);
  validateNonEmptyQaArray(evidence.compared_artifact_refs, `${path}.compared_artifact_refs`, "GoldenComparedArtifactsMissing", issues);
  validateNonEmptyQaArray(evidence.runtime_artifact_refs, `${path}.runtime_artifact_refs`, "GoldenRuntimeArtifactsMissing", issues);
  validateNonEmptyQaArray(evidence.qa_scoped_artifact_refs, `${path}.qa_scoped_artifact_refs`, "GoldenQaScopedArtifactsMissing", issues);
  validateNonEmptyQaArray(evidence.required_replay_refs, `${path}.required_replay_refs`, "GoldenReplayRequirementsMissing", issues);
  validateQaText(evidence.truth_isolated ? "truth_isolated" : "truth_not_isolated", `${path}.truth_isolated`, true, issues);
  if (evidence.missing_replay_refs.length > 0) {
    issues.push(qaIssue("error", "GoldenReplayIncomplete", `${path}.missing_replay_refs`, "Golden scenario replay evidence is incomplete.", "Capture all required replay refs."));
  }
  if (!evidence.truth_isolated) {
    issues.push(qaIssue("error", "GoldenQaScopeOverlap", `${path}.qa_scoped_artifact_refs`, "QA-scoped artifact refs overlap runtime artifact refs.", "Separate QA-scoped scoring refs from runtime refs."));
  }
}

function sumErrors(reports: readonly QaValidationReport[]): number {
  return reports.reduce((sum, report) => sum + report.error_count, 0);
}

function formatQaRatio(value: number): string {
  return value.toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "");
}

export const SCENARIO_BENCHMARK_CHAOS_HARNESS_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: SCENARIO_BENCHMARK_CHAOS_HARNESS_SCHEMA_VERSION,
  blueprint: QA_BLUEPRINT_REF,
  sections: freezeQaArray(["20.3", "20.17", "20.18", "20.19", "20.20", "20.22"]),
  component: "ScenarioBenchmarkChaosHarness",
});
