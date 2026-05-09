/**
 * Regression comparison report.
 *
 * Blueprint: `architecture_docs/20_QA_TESTING_CHAOS_AND_BENCHMARK_ARCHITECTURE.md`
 * sections 20.5.4, 20.7, 20.18, 20.20.1, 20.20.2, and 20.22.
 *
 * The report compares current artifacts to a golden baseline, classifies drift,
 * and records the release impact of prompt, certificate, memory, route, and
 * observability changes.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
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
  uniqueQaStrings,
  validateFiniteQaNumber,
  validateNonEmptyQaArray,
  validateQaRef,
  validateQaRefs,
  validateQaText,
  validateRatio,
} from "./test_case_spec";
import type { QaValidationReport } from "./test_case_spec";

export const REGRESSION_COMPARISON_REPORT_SCHEMA_VERSION = "mebsuta.qa.regression_comparison_report.v1" as const;

export type RegressionArtifactClass = "prompt" | "model_response" | "certificate" | "memory_write" | "route_decision" | "control_telemetry" | "observability_event" | "scorecard";
export type DriftClassification = "none" | "expected" | "minor" | "major" | "critical";

export interface RegressionDelta {
  readonly delta_ref: Ref;
  readonly artifact_class: RegressionArtifactClass;
  readonly baseline_artifact_ref: Ref;
  readonly current_artifact_ref: Ref;
  readonly similarity_score: number;
  readonly drift_classification: DriftClassification;
  readonly severity: ValidationSeverity;
  readonly explanation: string;
}

export interface RegressionComparisonReportInput {
  readonly regression_report_ref: Ref;
  readonly golden_baseline_ref: Ref;
  readonly current_run_ref: Ref;
  readonly compared_artifact_refs: readonly Ref[];
  readonly deltas: readonly RegressionDelta[];
  readonly drift_summary: string;
  readonly release_impact: "none" | "conditional_review" | "release_block";
  readonly remediation_refs?: readonly Ref[];
}

export interface RegressionComparisonReport {
  readonly schema_version: typeof REGRESSION_COMPARISON_REPORT_SCHEMA_VERSION;
  readonly regression_report_ref: Ref;
  readonly golden_baseline_ref: Ref;
  readonly current_run_ref: Ref;
  readonly compared_artifact_refs: readonly Ref[];
  readonly deltas: readonly RegressionDelta[];
  readonly drift_summary: string;
  readonly release_impact: "none" | "conditional_review" | "release_block";
  readonly remediation_refs: readonly Ref[];
  readonly critical_delta_count: number;
  readonly mean_similarity_score: number;
  readonly determinism_hash: string;
}

/**
 * Builds a regression report and derives critical-drift counters.
 */
export function buildRegressionComparisonReport(input: RegressionComparisonReportInput): RegressionComparisonReport {
  const report = normalizeRegressionComparisonReport(input);
  const validation = validateRegressionComparisonReport(report);
  if (!validation.ok) {
    throw new QaContractError("Regression comparison report failed validation.", validation.issues);
  }
  return report;
}

export function normalizeRegressionComparisonReport(input: RegressionComparisonReportInput): RegressionComparisonReport {
  const deltas = freezeQaArray(input.deltas.map(normalizeRegressionDelta));
  const meanSimilarity = deltas.length === 0
    ? 1
    : deltas.reduce((sum, delta) => sum + delta.similarity_score, 0) / deltas.length;
  const criticalDeltaCount = deltas.filter((delta) => delta.drift_classification === "critical").length;
  const base = {
    schema_version: REGRESSION_COMPARISON_REPORT_SCHEMA_VERSION,
    regression_report_ref: input.regression_report_ref,
    golden_baseline_ref: input.golden_baseline_ref,
    current_run_ref: input.current_run_ref,
    compared_artifact_refs: uniqueQaRefs(input.compared_artifact_refs),
    deltas,
    drift_summary: normalizeQaText(input.drift_summary),
    release_impact: input.release_impact,
    remediation_refs: uniqueQaRefs(input.remediation_refs ?? []),
    critical_delta_count: criticalDeltaCount,
    mean_similarity_score: meanSimilarity,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateRegressionComparisonReport(report: RegressionComparisonReport): QaValidationReport {
  const issues: ValidationIssue[] = [];
  validateQaRef(report.regression_report_ref, "$.regression_report_ref", issues);
  validateQaRef(report.golden_baseline_ref, "$.golden_baseline_ref", issues);
  validateQaRef(report.current_run_ref, "$.current_run_ref", issues);
  validateQaRefs(report.compared_artifact_refs, "$.compared_artifact_refs", issues);
  validateQaRefs(report.remediation_refs, "$.remediation_refs", issues);
  validateNonEmptyQaArray(report.compared_artifact_refs, "$.compared_artifact_refs", "ComparedArtifactsMissing", issues);
  validateQaText(report.drift_summary, "$.drift_summary", true, issues);
  validateRatio(report.mean_similarity_score, "$.mean_similarity_score", issues);
  report.deltas.forEach((delta, index) => validateRegressionDelta(delta, `$.deltas[${index}]`, issues));
  if (report.critical_delta_count > 0 && report.release_impact !== "release_block") {
    issues.push(qaIssue("error", "CriticalDriftNotBlocking", "$.release_impact", "Critical drift must block release.", "Set release impact to release_block."));
  }
  if (report.release_impact !== "none" && report.remediation_refs.length === 0) {
    issues.push(qaIssue("warning", "RegressionRemediationMissing", "$.remediation_refs", "Regressions with release impact should include remediation refs.", "Attach remediation or review ticket refs."));
  }
  return buildQaValidationReport(makeQaRef("regression_comparison_report", report.regression_report_ref), issues, qaRouteForIssues(issues));
}

export function compareCanonicalArtifacts(
  deltaRef: Ref,
  artifactClass: RegressionArtifactClass,
  baselineArtifactRef: Ref,
  currentArtifactRef: Ref,
  baselineValue: unknown,
  currentValue: unknown,
): RegressionDelta {
  const baselineHash = computeDeterminismHash(baselineValue);
  const currentHash = computeDeterminismHash(currentValue);
  const similarity = baselineHash === currentHash ? 1 : estimateStringSimilarity(JSON.stringify(baselineValue), JSON.stringify(currentValue));
  const drift = classifySimilarity(similarity);
  return normalizeRegressionDelta({
    delta_ref: deltaRef,
    artifact_class: artifactClass,
    baseline_artifact_ref: baselineArtifactRef,
    current_artifact_ref: currentArtifactRef,
    similarity_score: similarity,
    drift_classification: drift,
    severity: drift === "critical" || drift === "major" ? "error" : "warning",
    explanation: `baseline_hash=${baselineHash}; current_hash=${currentHash}`,
  });
}

function normalizeRegressionDelta(delta: RegressionDelta): RegressionDelta {
  return Object.freeze({
    delta_ref: delta.delta_ref,
    artifact_class: delta.artifact_class,
    baseline_artifact_ref: delta.baseline_artifact_ref,
    current_artifact_ref: delta.current_artifact_ref,
    similarity_score: Math.max(0, Math.min(1, delta.similarity_score)),
    drift_classification: delta.drift_classification,
    severity: delta.severity,
    explanation: normalizeQaText(delta.explanation, 600),
  });
}

function validateRegressionDelta(delta: RegressionDelta, path: string, issues: ValidationIssue[]): void {
  validateQaRef(delta.delta_ref, `${path}.delta_ref`, issues);
  validateQaRef(delta.baseline_artifact_ref, `${path}.baseline_artifact_ref`, issues);
  validateQaRef(delta.current_artifact_ref, `${path}.current_artifact_ref`, issues);
  validateRatio(delta.similarity_score, `${path}.similarity_score`, issues);
  validateQaText(delta.explanation, `${path}.explanation`, true, issues);
  if (delta.drift_classification === "critical" && delta.severity !== "error") {
    issues.push(qaIssue("error", "CriticalDeltaSeverityInvalid", `${path}.severity`, "Critical deltas require error severity.", "Mark critical deltas as error severity."));
  }
}

function classifySimilarity(similarity: number): DriftClassification {
  if (similarity >= 1) {
    return "none";
  }
  if (similarity >= 0.96) {
    return "expected";
  }
  if (similarity >= 0.86) {
    return "minor";
  }
  if (similarity >= 0.7) {
    return "major";
  }
  return "critical";
}

function estimateStringSimilarity(a: string, b: string): number {
  const left = uniqueQaStrings(a.split(/\W+/u));
  const right = uniqueQaStrings(b.split(/\W+/u));
  if (left.length === 0 && right.length === 0) {
    return 1;
  }
  const rightSet = new Set(right);
  const intersection = left.filter((token) => rightSet.has(token)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 1 : intersection / union;
}

export const REGRESSION_COMPARISON_REPORT_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: REGRESSION_COMPARISON_REPORT_SCHEMA_VERSION,
  blueprint: QA_BLUEPRINT_REF,
  sections: freezeQaArray(["20.5.4", "20.7", "20.18", "20.20.1", "20.20.2", "20.22"]),
  component: "RegressionComparisonReport",
});
