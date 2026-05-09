/**
 * Release readiness report.
 *
 * Blueprint: `architecture_docs/20_QA_TESTING_CHAOS_AND_BENCHMARK_ARCHITECTURE.md`
 * sections 20.18, 20.19, 20.20, 20.21, and 20.22.
 *
 * The report aggregates QA gates into a deterministic go/no-go decision for a
 * milestone while preserving explicit evidence and no-go conditions.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
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
import type { QaValidationReport } from "./test_case_spec";
import type { ReleaseGateStatus } from "./benchmark_scorecard";
import type { RegressionComparisonReport } from "./regression_comparison_report";
import type { ChaosInjectionRecord } from "./chaos_injection_record";

export const RELEASE_READINESS_REPORT_SCHEMA_VERSION = "mebsuta.qa.release_readiness_report.v1" as const;

export type ReleaseGateClass =
  | "architecture_contract"
  | "unit_test"
  | "integration"
  | "scenario_benchmark"
  | "safety"
  | "prompt_model"
  | "memory"
  | "verification"
  | "chaos"
  | "observability";

export type ReleaseDecision = "go" | "conditional_go" | "no_go";

export interface ReleaseGateEvidence {
  readonly gate_ref: Ref;
  readonly gate_class: ReleaseGateClass;
  readonly status: ReleaseGateStatus | "not_evaluated";
  readonly evidence_refs: readonly Ref[];
  readonly summary: string;
}

export interface ReleaseReadinessReportInput {
  readonly release_report_ref: Ref;
  readonly milestone_ref: Ref;
  readonly gate_evidence: readonly ReleaseGateEvidence[];
  readonly benchmark_scorecard_refs: readonly Ref[];
  readonly regression_report_refs: readonly Ref[];
  readonly chaos_record_refs: readonly Ref[];
  readonly no_go_conditions: readonly string[];
  readonly operator_summary: string;
  readonly decision?: ReleaseDecision;
}

export interface ReleaseReadinessReport {
  readonly schema_version: typeof RELEASE_READINESS_REPORT_SCHEMA_VERSION;
  readonly release_report_ref: Ref;
  readonly milestone_ref: Ref;
  readonly gate_evidence: readonly ReleaseGateEvidence[];
  readonly benchmark_scorecard_refs: readonly Ref[];
  readonly regression_report_refs: readonly Ref[];
  readonly chaos_record_refs: readonly Ref[];
  readonly no_go_conditions: readonly string[];
  readonly operator_summary: string;
  readonly decision: ReleaseDecision;
  readonly red_gate_count: number;
  readonly conditional_gate_count: number;
  readonly determinism_hash: string;
}

/**
 * Builds a release readiness report and derives go/no-go when absent.
 */
export function buildReleaseReadinessReport(input: ReleaseReadinessReportInput): ReleaseReadinessReport {
  const report = normalizeReleaseReadinessReport(input);
  const validation = validateReleaseReadinessReport(report);
  if (!validation.ok) {
    throw new QaContractError("Release readiness report failed validation.", validation.issues);
  }
  return report;
}

export function normalizeReleaseReadinessReport(input: ReleaseReadinessReportInput): ReleaseReadinessReport {
  const gates = freezeQaArray(input.gate_evidence.map(normalizeGateEvidence));
  const redGateCount = gates.filter((gate) => gate.status === "red").length;
  const conditionalGateCount = gates.filter((gate) => gate.status === "conditional" || gate.status === "not_evaluated").length;
  const noGoConditions = input.no_go_conditions.map((condition) => normalizeQaText(condition)).filter((condition) => condition.length > 0);
  const decision = input.decision ?? deriveReleaseDecision(gates, noGoConditions);
  const base = {
    schema_version: RELEASE_READINESS_REPORT_SCHEMA_VERSION,
    release_report_ref: input.release_report_ref,
    milestone_ref: input.milestone_ref,
    gate_evidence: gates,
    benchmark_scorecard_refs: uniqueQaRefs(input.benchmark_scorecard_refs),
    regression_report_refs: uniqueQaRefs(input.regression_report_refs),
    chaos_record_refs: uniqueQaRefs(input.chaos_record_refs),
    no_go_conditions: freezeQaArray(noGoConditions),
    operator_summary: normalizeQaText(input.operator_summary),
    decision,
    red_gate_count: redGateCount,
    conditional_gate_count: conditionalGateCount,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateReleaseReadinessReport(report: ReleaseReadinessReport): QaValidationReport {
  const issues: ValidationIssue[] = [];
  validateQaRef(report.release_report_ref, "$.release_report_ref", issues);
  validateQaRef(report.milestone_ref, "$.milestone_ref", issues);
  validateQaRefs(report.benchmark_scorecard_refs, "$.benchmark_scorecard_refs", issues);
  validateQaRefs(report.regression_report_refs, "$.regression_report_refs", issues);
  validateQaRefs(report.chaos_record_refs, "$.chaos_record_refs", issues);
  validateNonEmptyQaArray(report.gate_evidence, "$.gate_evidence", "ReleaseGatesMissing", issues);
  validateNonEmptyQaArray(report.benchmark_scorecard_refs, "$.benchmark_scorecard_refs", "BenchmarkScorecardsMissing", issues);
  validateQaText(report.operator_summary, "$.operator_summary", true, issues);
  report.gate_evidence.forEach((gate, index) => validateGateEvidence(gate, `$.gate_evidence[${index}]`, issues));
  report.no_go_conditions.forEach((condition, index) => validateQaText(condition, `$.no_go_conditions[${index}]`, true, issues));
  if ((report.red_gate_count > 0 || report.no_go_conditions.length > 0) && report.decision !== "no_go") {
    issues.push(qaIssue("error", "NoGoConditionDecisionMismatch", "$.decision", "Red gates or explicit no-go conditions require no_go decision.", "Set decision to no_go."));
  }
  if (report.conditional_gate_count > 0 && report.decision === "go") {
    issues.push(qaIssue("error", "ConditionalGateGoMismatch", "$.decision", "Conditional or unevaluated gates cannot produce an unconditional go.", "Use conditional_go or resolve all gates."));
  }
  return buildQaValidationReport(makeQaRef("release_readiness_report", report.release_report_ref), issues, qaRouteForIssues(issues));
}

export function deriveReleaseDecision(gates: readonly ReleaseGateEvidence[], noGoConditions: readonly string[]): ReleaseDecision {
  if (noGoConditions.length > 0 || gates.some((gate) => gate.status === "red")) {
    return "no_go";
  }
  if (gates.some((gate) => gate.status === "conditional" || gate.status === "not_evaluated")) {
    return "conditional_go";
  }
  return "go";
}

export function summarizeExternalQaSignals(
  benchmarkRefs: readonly Ref[],
  regressionReports: readonly RegressionComparisonReport[],
  chaosRecords: readonly ChaosInjectionRecord[],
): readonly string[] {
  const summaries: string[] = [];
  summaries.push(`benchmark_scorecards=${benchmarkRefs.length}`);
  summaries.push(`regression_release_blocks=${regressionReports.filter((report) => report.release_impact === "release_block").length}`);
  summaries.push(`chaos_release_blocks=${chaosRecords.filter((record) => record.release_blocking).length}`);
  return freezeQaArray(summaries);
}

function normalizeGateEvidence(gate: ReleaseGateEvidence): ReleaseGateEvidence {
  return Object.freeze({
    gate_ref: gate.gate_ref,
    gate_class: gate.gate_class,
    status: gate.status,
    evidence_refs: uniqueQaRefs(gate.evidence_refs),
    summary: normalizeQaText(gate.summary, 600),
  });
}

function validateGateEvidence(gate: ReleaseGateEvidence, path: string, issues: ValidationIssue[]): void {
  validateQaRef(gate.gate_ref, `${path}.gate_ref`, issues);
  validateNonEmptyQaArray(gate.evidence_refs, `${path}.evidence_refs`, "GateEvidenceMissing", issues);
  validateQaRefs(gate.evidence_refs, `${path}.evidence_refs`, issues);
  validateQaText(gate.summary, `${path}.summary`, true, issues);
  if (gate.status === "red" && gate.summary.length < 12) {
    issues.push(qaIssue("warning", "RedGateSummaryThin", `${path}.summary`, "Red gates should include an actionable summary.", "Document the blocking reason and owner."));
  }
}

export const RELEASE_READINESS_REPORT_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: RELEASE_READINESS_REPORT_SCHEMA_VERSION,
  blueprint: QA_BLUEPRINT_REF,
  sections: freezeQaArray(["20.18", "20.19", "20.20", "20.21", "20.22"]),
  component: "ReleaseReadinessReport",
});
