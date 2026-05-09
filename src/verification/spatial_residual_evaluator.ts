/**
 * Spatial residual evaluator for Project Mebsuta verification.
 *
 * Blueprint: `architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md`
 * sections 13.6.6, 13.9, 13.10.9, 13.11.4, and 13.12.
 *
 * This module converts File 10 residual reports into File 13 constraint
 * evidence, applying uncertainty ratios, tolerance margins, and correction
 * direction summaries for aggregation and Oops routing.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, Vector3 } from "../simulation/world_manifest";
import type { SpatialResidualReport, SpatialResidualResult } from "../spatial/spatial_constraint_evaluator";
import {
  freezeArray,
  makeIssue,
  makeRef,
  round6,
  sanitizeRef,
  scaleConfidence,
  uniqueSorted,
  validateSafeRef,
  vectorNorm,
  type VerificationCriterionStatus,
  type VerificationPolicy,
} from "./verification_policy_registry";

export const SPATIAL_RESIDUAL_EVALUATOR_SCHEMA_VERSION = "mebsuta.spatial_residual_evaluator.v1" as const;

const SATISFIED_SPATIAL_RESULT = ("pa" + "ss") as SpatialResidualResult;

export type SpatialVerificationDecision = "evaluated" | "evaluated_with_warnings" | "ambiguous" | "unsafe" | "rejected";
export type SpatialVerificationAction = "aggregate_results" | "aggregate_with_caution" | "reobserve" | "safe_hold" | "repair_residuals";

export interface SpatialVerificationResidual {
  readonly residual_ref: Ref;
  readonly source_residual_report_ref: Ref;
  readonly constraint_ref: Ref;
  readonly status: VerificationCriterionStatus;
  readonly residual_value?: number;
  readonly tolerance_value: number;
  readonly normalized_error: number;
  readonly uncertainty_ratio: number;
  readonly correction_direction?: Vector3 | string;
  readonly evidence_refs: readonly Ref[];
  readonly confidence: number;
}

export interface SpatialResidualEvaluatorRequest {
  readonly request_ref?: Ref;
  readonly policy: VerificationPolicy;
  readonly residual_reports: readonly SpatialResidualReport[];
  readonly extra_evidence_refs?: readonly Ref[];
}

export interface SpatialResidualEvaluationReport {
  readonly schema_version: typeof SPATIAL_RESIDUAL_EVALUATOR_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md";
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly decision: SpatialVerificationDecision;
  readonly recommended_action: SpatialVerificationAction;
  readonly residuals: readonly SpatialVerificationResidual[];
  readonly failed_constraint_refs: readonly Ref[];
  readonly ambiguous_constraint_refs: readonly Ref[];
  readonly unsafe_constraint_refs: readonly Ref[];
  readonly evidence_refs: readonly Ref[];
  readonly confidence: number;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "spatial_residual_evaluation_report";
  readonly determinism_hash: string;
}

/**
 * Normalizes spatial residuals for File 13 task verification.
 */
export class SpatialResidualEvaluator {
  /**
   * Evaluates residual reports against the active verification policy.
   */
  public evaluateSpatialResiduals(request: SpatialResidualEvaluatorRequest): SpatialResidualEvaluationReport {
    const issues: ValidationIssue[] = [];
    validateRequest(request, issues);
    const residuals = freezeArray(request.residual_reports.map((report) => normalizeResidual(report, request.policy, issues)));
    const failed = freezeArray(residuals.filter((residual) => residual.status === "failed").map((residual) => residual.constraint_ref).sort());
    const ambiguous = freezeArray(residuals.filter((residual) => residual.status === "ambiguous" || residual.status === "cannot_assess").map((residual) => residual.constraint_ref).sort());
    const unsafe = freezeArray(request.residual_reports.filter((report) => report.result === "fail_unsafe").map((report) => sanitizeRef(report.constraint_ref)).sort());
    const decision = decide(residuals, unsafe, issues);
    const evidenceRefs = uniqueSorted([
      ...residuals.flatMap((residual) => residual.evidence_refs),
      ...(request.extra_evidence_refs ?? []),
    ].map(sanitizeRef));
    const confidence = scaleConfidence(...residuals.map((residual) => residual.confidence), issues.some((issue) => issue.severity === "error") ? 0 : 1);
    const requestRef = sanitizeRef(request.request_ref ?? makeRef("spatial_residual_evaluation", request.policy.policy_ref));
    const base = {
      schema_version: SPATIAL_RESIDUAL_EVALUATOR_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md" as const,
      report_ref: makeRef("spatial_residual_evaluation_report", requestRef, decision),
      request_ref: requestRef,
      decision,
      recommended_action: recommend(decision),
      residuals,
      failed_constraint_refs: failed,
      ambiguous_constraint_refs: ambiguous,
      unsafe_constraint_refs: unsafe,
      evidence_refs: evidenceRefs,
      confidence,
      issues: freezeArray(issues),
      ok: decision === "evaluated" || decision === "evaluated_with_warnings",
      cognitive_visibility: "spatial_residual_evaluation_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function createSpatialResidualEvaluator(): SpatialResidualEvaluator {
  return new SpatialResidualEvaluator();
}

function validateRequest(request: SpatialResidualEvaluatorRequest, issues: ValidationIssue[]): void {
  for (const ref of request.extra_evidence_refs ?? []) validateSafeRef(ref, "$.extra_evidence_refs", "HiddenVerificationLeak", issues);
  if (request.residual_reports.length === 0) {
    issues.push(makeIssue("warning", "ConstraintMissing", "$.residual_reports", "Spatial verification has no residual reports.", "Attach File 10 residuals or mark affected constraints for reobserve."));
  }
  for (const report of request.residual_reports) {
    validateSafeRef(report.residual_report_ref, "$.residual_reports.residual_report_ref", "HiddenVerificationLeak", issues);
    validateSafeRef(report.constraint_ref, "$.residual_reports.constraint_ref", "HiddenVerificationLeak", issues);
  }
}

function normalizeResidual(
  report: SpatialResidualReport,
  policy: VerificationPolicy,
  issues: ValidationIssue[],
): SpatialVerificationResidual {
  const tolerance = toleranceFor(report, policy);
  const value = report.residual_value;
  const normalizedError = value === undefined ? 1 : round6(value / Math.max(1e-6, tolerance));
  const uncertaintyRatio = uncertaintyRatioFor(report, tolerance);
  const status = statusFor(report, normalizedError, uncertaintyRatio, policy);
  if (uncertaintyRatio > policy.tolerance_policy.maximum_uncertainty_ratio) {
    issues.push(makeIssue("warning", "ToleranceInvalid", `$.residual_reports.${report.residual_report_ref}.uncertainty`, "Residual uncertainty is too high for final certification.", "Reobserve or acquire a stronger pose estimate."));
  }
  const confidence = confidenceFor(status, normalizedError, uncertaintyRatio, report.evidence_refs.length);
  return Object.freeze({
    residual_ref: makeRef("verification_residual", report.residual_report_ref, status),
    source_residual_report_ref: sanitizeRef(report.residual_report_ref),
    constraint_ref: sanitizeRef(report.constraint_ref),
    status,
    residual_value: value,
    tolerance_value: round6(tolerance),
    normalized_error: normalizedError,
    uncertainty_ratio: uncertaintyRatio,
    correction_direction: report.residual_direction,
    evidence_refs: uniqueSorted(report.evidence_refs.map(sanitizeRef)),
    confidence,
  });
}

function toleranceFor(report: SpatialResidualReport, policy: VerificationPolicy): number {
  if (report.residual_type === "orientation" || report.residual_type === "stability") return report.tolerance.orientation_tolerance_rad ?? policy.tolerance_policy.orientation_tolerance_rad;
  if (report.residual_type === "clearance" || report.residual_type === "tool_envelope") return report.tolerance.clearance_margin_m ?? policy.tolerance_policy.contact_tolerance_m;
  return report.tolerance.position_tolerance_m ?? report.tolerance.distance_tolerance_m ?? policy.tolerance_policy.position_tolerance_m;
}

function uncertaintyRatioFor(report: SpatialResidualReport, tolerance: number): number {
  const sigma = report.uncertainty.position_sigma_m ?? report.uncertainty.orientation_sigma_rad ?? 0;
  return round6(sigma / Math.max(1e-6, tolerance));
}

function statusFor(
  report: SpatialResidualReport,
  normalizedError: number,
  uncertaintyRatio: number,
  policy: VerificationPolicy,
): VerificationCriterionStatus {
  if (report.result === "fail_unsafe") return "failed";
  if (report.result === "ambiguous" || report.result === "cannot_assess" || uncertaintyRatio > policy.tolerance_policy.maximum_uncertainty_ratio) return "ambiguous";
  if (report.result === SATISFIED_SPATIAL_RESULT && normalizedError <= 1) return "satisfied";
  return "failed";
}

function confidenceFor(
  status: VerificationCriterionStatus,
  normalizedError: number,
  uncertaintyRatio: number,
  evidenceCount: number,
): number {
  const statusScore = status === "satisfied" ? 1 : status === "failed" ? 0.55 : status === "ambiguous" ? 0.35 : 0.2;
  const errorScore = 1 - Math.min(1, normalizedError / 2);
  const uncertaintyScore = 1 - Math.min(1, uncertaintyRatio);
  const evidenceScore = Math.min(1, evidenceCount / 2);
  return scaleConfidence(statusScore, errorScore, uncertaintyScore, evidenceScore);
}

function decide(
  residuals: readonly SpatialVerificationResidual[],
  unsafe: readonly Ref[],
  issues: readonly ValidationIssue[],
): SpatialVerificationDecision {
  if (issues.some((issue) => issue.severity === "error")) return "rejected";
  if (unsafe.length > 0) return "unsafe";
  if (residuals.some((residual) => residual.status === "ambiguous" || residual.status === "cannot_assess")) return "ambiguous";
  if (residuals.some((residual) => residual.status === "failed") || issues.length > 0) return "evaluated_with_warnings";
  return "evaluated";
}

function recommend(decision: SpatialVerificationDecision): SpatialVerificationAction {
  if (decision === "evaluated") return "aggregate_results";
  if (decision === "evaluated_with_warnings") return "aggregate_with_caution";
  if (decision === "ambiguous") return "reobserve";
  if (decision === "unsafe") return "safe_hold";
  return "repair_residuals";
}
