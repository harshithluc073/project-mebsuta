/**
 * Benchmark scorecard contract and deterministic scoring.
 *
 * Blueprint: `architecture_docs/20_QA_TESTING_CHAOS_AND_BENCHMARK_ARCHITECTURE.md`
 * sections 20.4.2, 20.5.5, 20.18, 20.19, 20.20, and 20.22.
 *
 * The scorecard aggregates runtime certificate correctness, safety, robustness,
 * efficiency, transparency, boundary integrity, memory quality, prompt schema
 * validity, and critical violation penalties into a release gate signal.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  QA_BLUEPRINT_REF,
  QaContractError,
  buildQaValidationReport,
  freezeQaArray,
  makeQaRef,
  qaIssue,
  qaRouteForIssues,
  uniqueQaRefs,
  validateFiniteQaNumber,
  validateNonEmptyQaArray,
  validateQaRef,
  validateQaRefs,
  validateRatio,
} from "./test_case_spec";
import type { QaValidationReport } from "./test_case_spec";
import type { OfflineMetricClass, ScoringPolicy } from "./scenario_benchmark_spec";
import { scoringWeightTotal } from "./scenario_benchmark_spec";

export const BENCHMARK_SCORECARD_SCHEMA_VERSION = "mebsuta.qa.benchmark_scorecard.v1" as const;

export type ReleaseGateStatus = "green" | "conditional" | "red";

export interface BenchmarkMetricsInput {
  readonly task_success_rate: number;
  readonly false_success_rate: number;
  readonly false_failure_rate: number;
  readonly ambiguity_rate: number;
  readonly oops_recovery_rate: number;
  readonly safehold_rate: number;
  readonly hidden_truth_leak_count: number;
  readonly memory_contamination_count: number;
  readonly prompt_schema_validity_rate: number;
  readonly replay_completeness_rate: number;
}

export interface BenchmarkScorecardInput {
  readonly scorecard_ref: Ref;
  readonly scenario_benchmark_ref: Ref;
  readonly scenario_run_refs: readonly Ref[];
  readonly metrics: BenchmarkMetricsInput;
  readonly scoring_policy: ScoringPolicy;
  readonly release_gate_status?: ReleaseGateStatus;
}

export interface BenchmarkScorecard {
  readonly schema_version: typeof BENCHMARK_SCORECARD_SCHEMA_VERSION;
  readonly scorecard_ref: Ref;
  readonly scenario_benchmark_ref: Ref;
  readonly scenario_run_refs: readonly Ref[];
  readonly metrics: BenchmarkMetricsInput;
  readonly scoring_policy_ref: Ref;
  readonly dimension_scores: Readonly<Record<OfflineMetricClass, number>>;
  readonly aggregate_score: number;
  readonly critical_penalty_applied: number;
  readonly release_gate_status: ReleaseGateStatus;
  readonly determinism_hash: string;
}

/**
 * Builds a benchmark scorecard using the weighted formula from the blueprint.
 */
export function buildBenchmarkScorecard(input: BenchmarkScorecardInput): BenchmarkScorecard {
  const scorecard = normalizeBenchmarkScorecard(input);
  const report = validateBenchmarkScorecard(scorecard, input.scoring_policy);
  if (!report.ok) {
    throw new QaContractError("Benchmark scorecard failed validation.", report.issues);
  }
  return scorecard;
}

export function normalizeBenchmarkScorecard(input: BenchmarkScorecardInput): BenchmarkScorecard {
  const metrics = freezeMetrics(input.metrics);
  const dimensionScores = computeDimensionScores(metrics);
  const criticalPenalty = computeCriticalPenalty(metrics, input.scoring_policy.critical_violation_penalty);
  const weighted = Object.entries(input.scoring_policy.metric_weights).reduce((sum, [metric, weight]) => {
    const score = dimensionScores[metric as OfflineMetricClass] ?? 0;
    return sum + score * weight;
  }, 0);
  const aggregateScore = clampRatio(weighted - criticalPenalty);
  const status = input.release_gate_status ?? deriveReleaseGateStatus(aggregateScore, metrics, input.scoring_policy.release_threshold);
  const base = {
    schema_version: BENCHMARK_SCORECARD_SCHEMA_VERSION,
    scorecard_ref: input.scorecard_ref,
    scenario_benchmark_ref: input.scenario_benchmark_ref,
    scenario_run_refs: uniqueQaRefs(input.scenario_run_refs),
    metrics,
    scoring_policy_ref: input.scoring_policy.scoring_policy_ref,
    dimension_scores: dimensionScores,
    aggregate_score: aggregateScore,
    critical_penalty_applied: criticalPenalty,
    release_gate_status: status,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateBenchmarkScorecard(scorecard: BenchmarkScorecard, scoringPolicy: ScoringPolicy): QaValidationReport {
  const issues: ValidationIssue[] = [];
  validateQaRef(scorecard.scorecard_ref, "$.scorecard_ref", issues);
  validateQaRef(scorecard.scenario_benchmark_ref, "$.scenario_benchmark_ref", issues);
  validateQaRef(scorecard.scoring_policy_ref, "$.scoring_policy_ref", issues);
  validateQaRefs(scorecard.scenario_run_refs, "$.scenario_run_refs", issues);
  validateNonEmptyQaArray(scorecard.scenario_run_refs, "$.scenario_run_refs", "ScenarioRunsMissing", issues);
  validateMetrics(scorecard.metrics, "$.metrics", issues);
  validateRatio(scorecard.aggregate_score, "$.aggregate_score", issues);
  validateFiniteQaNumber(scorecard.critical_penalty_applied, "$.critical_penalty_applied", 0, Number.POSITIVE_INFINITY, issues);
  if (scorecard.scoring_policy_ref !== scoringPolicy.scoring_policy_ref) {
    issues.push(qaIssue("error", "ScorecardPolicyMismatch", "$.scoring_policy_ref", "Scorecard policy ref must match the scoring policy used for validation.", "Use the same scoring policy object that generated the scorecard."));
  }
  if (Math.abs(scoringWeightTotal(scoringPolicy) - 1) > 1e-9) {
    issues.push(qaIssue("error", "ScorecardPolicyWeightsInvalid", "$.scoring_policy.metric_weights", "Scoring policy weights must sum to 1.", "Normalize scoring policy weights."));
  }
  if (scorecard.metrics.hidden_truth_leak_count > 0 && scorecard.release_gate_status !== "red") {
    issues.push(qaIssue("error", "HiddenTruthLeakNotRed", "$.release_gate_status", "Hidden truth leaks require a red release gate.", "Set release gate status to red."));
  }
  return buildQaValidationReport(makeQaRef("benchmark_scorecard_report", scorecard.scorecard_ref), issues, qaRouteForIssues(issues));
}

export function deriveReleaseGateStatus(metricsScore: number, metrics: BenchmarkMetricsInput, releaseThreshold: number): ReleaseGateStatus {
  if (metrics.hidden_truth_leak_count > 0 || metrics.memory_contamination_count > 0 || metrics.false_success_rate > 0.02) {
    return "red";
  }
  if (metricsScore < releaseThreshold) {
    return "red";
  }
  if (metrics.ambiguity_rate > 0.25 || metrics.false_failure_rate > 0.15 || metricsScore < Math.min(1, releaseThreshold + 0.08)) {
    return "conditional";
  }
  return "green";
}

function computeDimensionScores(metrics: BenchmarkMetricsInput): Readonly<Record<OfflineMetricClass, number>> {
  return Object.freeze({
    task_completion: clampRatio(metrics.task_success_rate),
    spatial_precision: clampRatio(1 - metrics.false_success_rate - metrics.false_failure_rate),
    safety: clampRatio(1 - metrics.hidden_truth_leak_count - metrics.memory_contamination_count),
    robustness: clampRatio((metrics.oops_recovery_rate + (1 - metrics.ambiguity_rate)) / 2),
    efficiency: clampRatio(1 - metrics.safehold_rate * 0.5 - metrics.ambiguity_rate * 0.25),
    transparency: clampRatio(metrics.replay_completeness_rate),
    boundary_integrity: metrics.hidden_truth_leak_count === 0 ? 1 : 0,
    memory_quality: metrics.memory_contamination_count === 0 ? 1 : 0,
    audio_routing: clampRatio(1 - metrics.ambiguity_rate),
    tool_use: clampRatio(metrics.task_success_rate * (1 - metrics.false_success_rate)),
  });
}

function computeCriticalPenalty(metrics: BenchmarkMetricsInput, penaltyPerIssue: number): number {
  const criticalCount = metrics.hidden_truth_leak_count + metrics.memory_contamination_count + (metrics.false_success_rate > 0.02 ? 1 : 0);
  return Math.max(0, criticalCount * penaltyPerIssue);
}

function freezeMetrics(metrics: BenchmarkMetricsInput): BenchmarkMetricsInput {
  return Object.freeze({ ...metrics });
}

function validateMetrics(metrics: BenchmarkMetricsInput, path: string, issues: ValidationIssue[]): void {
  validateRatio(metrics.task_success_rate, `${path}.task_success_rate`, issues);
  validateRatio(metrics.false_success_rate, `${path}.false_success_rate`, issues);
  validateRatio(metrics.false_failure_rate, `${path}.false_failure_rate`, issues);
  validateRatio(metrics.ambiguity_rate, `${path}.ambiguity_rate`, issues);
  validateRatio(metrics.oops_recovery_rate, `${path}.oops_recovery_rate`, issues);
  validateRatio(metrics.safehold_rate, `${path}.safehold_rate`, issues);
  validateRatio(metrics.prompt_schema_validity_rate, `${path}.prompt_schema_validity_rate`, issues);
  validateRatio(metrics.replay_completeness_rate, `${path}.replay_completeness_rate`, issues);
  validateFiniteQaNumber(metrics.hidden_truth_leak_count, `${path}.hidden_truth_leak_count`, 0, Number.POSITIVE_INFINITY, issues);
  validateFiniteQaNumber(metrics.memory_contamination_count, `${path}.memory_contamination_count`, 0, Number.POSITIVE_INFINITY, issues);
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

export const BENCHMARK_SCORECARD_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: BENCHMARK_SCORECARD_SCHEMA_VERSION,
  blueprint: QA_BLUEPRINT_REF,
  sections: freezeQaArray(["20.4.2", "20.5.5", "20.18", "20.19", "20.20", "20.22"]),
  component: "BenchmarkScorecard",
});
