/**
 * Release risk gate evaluator.
 *
 * Blueprint: `architecture_docs/22_RISK_REGISTER_AND_MITIGATION_ARCHITECTURE.md`
 * sections 22.9.3, 22.11.1, and 22.11.2.
 *
 * The evaluator turns scored risks, monitoring events, and mitigation coverage
 * into a deterministic go, conditional-go, or no-go release decision.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  RISK_BLUEPRINT_REF,
  RiskContractError,
  buildRiskValidationReport,
  freezeRiskArray,
  makeRiskRef,
  normalizeRiskText,
  riskIssue,
  riskRouteForIssues,
  uniqueRiskRefs,
  uniqueRiskStrings,
  validateRiskNonEmptyArray,
  validateRiskRef,
  validateRiskRefs,
  validateRiskText,
} from "./risk_register_entry";
import type { RiskValidationReport } from "./risk_register_entry";
import type { MitigationCoverageReport } from "./mitigation_control_registry";
import type { RiskMonitoringEvent } from "./risk_monitoring_event";
import type { RiskScore } from "./risk_scoring_model";

export const RELEASE_RISK_GATE_EVALUATOR_SCHEMA_VERSION = "mebsuta.risk.release_risk_gate_evaluator.v1" as const;

export type ReleaseRiskDecision = "go" | "conditional_go" | "no_go";

export interface ReleaseRiskGateInput {
  readonly gate_report_ref: Ref;
  readonly milestone_ref: Ref;
  readonly evaluated_at_iso: string;
  readonly risk_scores: readonly RiskScore[];
  readonly monitoring_events: readonly RiskMonitoringEvent[];
  readonly mitigation_coverage_reports: readonly MitigationCoverageReport[];
  readonly acknowledged_limitation_refs?: readonly Ref[];
  readonly operator_summary: string;
}

export interface ReleaseRiskGateReport {
  readonly schema_version: typeof RELEASE_RISK_GATE_EVALUATOR_SCHEMA_VERSION;
  readonly gate_report_ref: Ref;
  readonly milestone_ref: Ref;
  readonly evaluated_at_iso: string;
  readonly decision: ReleaseRiskDecision;
  readonly no_go_conditions: readonly string[];
  readonly conditional_go_conditions: readonly string[];
  readonly release_blocking_risk_refs: readonly Ref[];
  readonly unresolved_event_refs: readonly Ref[];
  readonly insufficient_coverage_risk_refs: readonly Ref[];
  readonly acknowledged_limitation_refs: readonly Ref[];
  readonly operator_summary: string;
  readonly determinism_hash: string;
}

/**
 * Builds a release risk gate report and rejects internally inconsistent gates.
 */
export function buildReleaseRiskGateReport(input: ReleaseRiskGateInput): ReleaseRiskGateReport {
  const report = normalizeReleaseRiskGateReport(input);
  const validation = validateReleaseRiskGateReport(report);
  if (!validation.ok) {
    throw new RiskContractError("Release risk gate report failed validation.", validation.issues);
  }
  return report;
}

export function normalizeReleaseRiskGateReport(input: ReleaseRiskGateInput): ReleaseRiskGateReport {
  const releaseBlockingRiskRefs = uniqueRiskRefs(input.risk_scores.filter((score) => score.release_blocking).map((score) => score.risk_ref));
  const unresolvedEventRefs = uniqueRiskRefs(input.monitoring_events.filter((event) => event.route_decision === "release_block" || event.route_decision === "safe_hold").map((event) => event.risk_event_ref));
  const insufficientCoverageRiskRefs = uniqueRiskRefs(input.mitigation_coverage_reports.filter((coverage) => coverage.balanced_coverage === false).map((coverage) => coverage.risk_ref));
  const noGo = noGoConditions(releaseBlockingRiskRefs, unresolvedEventRefs);
  const conditional = conditionalConditions(input.risk_scores, insufficientCoverageRiskRefs, input.acknowledged_limitation_refs ?? []);
  const decision = deriveReleaseRiskDecision(noGo, conditional);
  const base = {
    schema_version: RELEASE_RISK_GATE_EVALUATOR_SCHEMA_VERSION,
    gate_report_ref: input.gate_report_ref,
    milestone_ref: input.milestone_ref,
    evaluated_at_iso: input.evaluated_at_iso,
    decision,
    no_go_conditions: freezeRiskArray(noGo),
    conditional_go_conditions: freezeRiskArray(conditional),
    release_blocking_risk_refs: releaseBlockingRiskRefs,
    unresolved_event_refs: unresolvedEventRefs,
    insufficient_coverage_risk_refs: insufficientCoverageRiskRefs,
    acknowledged_limitation_refs: uniqueRiskRefs(input.acknowledged_limitation_refs ?? []),
    operator_summary: normalizeRiskText(input.operator_summary, 900),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateReleaseRiskGateReport(report: ReleaseRiskGateReport): RiskValidationReport {
  const issues: ValidationIssue[] = [];
  validateRiskRef(report.gate_report_ref, "$.gate_report_ref", issues);
  validateRiskRef(report.milestone_ref, "$.milestone_ref", issues);
  validateRiskText(report.operator_summary, "$.operator_summary", true, issues);
  validateRiskRefs(report.release_blocking_risk_refs, "$.release_blocking_risk_refs", issues);
  validateRiskRefs(report.unresolved_event_refs, "$.unresolved_event_refs", issues);
  validateRiskRefs(report.insufficient_coverage_risk_refs, "$.insufficient_coverage_risk_refs", issues);
  validateRiskRefs(report.acknowledged_limitation_refs, "$.acknowledged_limitation_refs", issues);
  if (!Number.isFinite(new Date(report.evaluated_at_iso).getTime())) {
    issues.push(riskIssue("error", "ReleaseRiskEvaluationTimeInvalid", "$.evaluated_at_iso", "Evaluation time must be valid ISO-8601.", "Use the release gate evaluation timestamp."));
  }
  if (report.no_go_conditions.length > 0 && report.decision !== "no_go") {
    issues.push(riskIssue("error", "NoGoDecisionMismatch", "$.decision", "No-go conditions require a no_go release risk decision.", "Keep the release blocked until conditions are resolved."));
  }
  if (report.conditional_go_conditions.length > 0 && report.decision === "go") {
    issues.push(riskIssue("error", "ConditionalRiskGoMismatch", "$.decision", "Conditional-go conditions cannot produce an unconditional go.", "Use conditional_go or resolve all conditions."));
  }
  return buildRiskValidationReport(makeRiskRef("release_risk_gate_report", report.gate_report_ref), issues, riskRouteForIssues(issues));
}

export function deriveReleaseRiskDecision(noGoConditionsList: readonly string[], conditionalConditionsList: readonly string[]): ReleaseRiskDecision {
  if (noGoConditionsList.length > 0) {
    return "no_go";
  }
  if (conditionalConditionsList.length > 0) {
    return "conditional_go";
  }
  return "go";
}

export function releaseGateReady(report: ReleaseRiskGateReport): boolean {
  return report.decision === "go" && report.no_go_conditions.length === 0 && report.conditional_go_conditions.length === 0;
}

function noGoConditions(releaseBlockingRiskRefs: readonly Ref[], unresolvedEventRefs: readonly Ref[]): readonly string[] {
  const conditions: string[] = [];
  if (releaseBlockingRiskRefs.length > 0) {
    conditions.push(`${releaseBlockingRiskRefs.length} release-blocking risk refs remain active.`);
  }
  if (unresolvedEventRefs.length > 0) {
    conditions.push(`${unresolvedEventRefs.length} unresolved critical event refs require closure.`);
  }
  return uniqueRiskStrings(conditions);
}

function conditionalConditions(scores: readonly RiskScore[], insufficientCoverageRiskRefs: readonly Ref[], acknowledgedLimitations: readonly Ref[]): readonly string[] {
  const conditions: string[] = [];
  const highResidualCount = scores.filter((score) => score.score_band === "high").length;
  if (highResidualCount > 0) {
    conditions.push(`${highResidualCount} high residual risk scores require monitored release constraints.`);
  }
  if (insufficientCoverageRiskRefs.length > 0) {
    conditions.push(`${insufficientCoverageRiskRefs.length} risk refs lack balanced mitigation coverage.`);
  }
  if (acknowledgedLimitations.length > 0) {
    conditions.push(`${acknowledgedLimitations.length} acknowledged limitations must remain documented.`);
  }
  return uniqueRiskStrings(conditions);
}

export const RELEASE_RISK_GATE_EVALUATOR_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: RELEASE_RISK_GATE_EVALUATOR_SCHEMA_VERSION,
  blueprint: RISK_BLUEPRINT_REF,
  sections: freezeRiskArray(["22.9.3", "22.11.1", "22.11.2"]),
  component: "ReleaseRiskGateEvaluator",
});
