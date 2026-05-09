/**
 * Constraint result aggregator for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md`
 * sections 13.2, 13.5, 13.6.8, 13.10.11, 13.11.5, and 13.12.
 *
 * The aggregator combines sufficiency, visual, spatial, settle, and
 * false-positive reports into conservative constraint decisions and one final
 * route recommendation.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  freezeArray,
  makeRef,
  round6,
  scaleConfidence,
  uniqueSorted,
  type VerificationCriterionStatus,
  type VerificationPolicy,
  type VerificationRouteDecision,
} from "./verification_policy_registry";
import type { FalsePositiveRiskReport } from "./false_positive_guard";
import type { SpatialResidualEvaluationReport } from "./spatial_residual_evaluator";
import type { ViewSufficiencyReport } from "./view_sufficiency_evaluator";
import type { VisualVerificationAssessment } from "./visual_verification_adapter";
import type { SettleWindowReport } from "./settle_window_monitor";

export const CONSTRAINT_RESULT_AGGREGATOR_SCHEMA_VERSION = "mebsuta.constraint_result_aggregator.v1" as const;

export type ConstraintAggregationDecision = "success_ready" | "failure_correctable" | "ambiguous" | "unsafe" | "human_review_required" | "rejected";
export type ConstraintAggregationAction = "issue_certificate" | "route_correct" | "route_reobserve" | "safe_hold" | "human_review" | "repair_inputs";

export interface ConstraintVerificationResult {
  readonly constraint_ref: Ref;
  readonly status: VerificationCriterionStatus;
  readonly required: boolean;
  readonly visual_status?: VerificationCriterionStatus;
  readonly spatial_status?: VerificationCriterionStatus;
  readonly evidence_refs: readonly Ref[];
  readonly confidence: number;
  readonly reason: string;
}

export interface ConstraintAggregationRequest {
  readonly request_ref?: Ref;
  readonly policy: VerificationPolicy;
  readonly sufficiency_report: ViewSufficiencyReport;
  readonly visual_assessment: VisualVerificationAssessment;
  readonly spatial_report: SpatialResidualEvaluationReport;
  readonly false_positive_report: FalsePositiveRiskReport;
  readonly settle_report?: SettleWindowReport;
}

export interface ConstraintAggregationReport {
  readonly schema_version: typeof CONSTRAINT_RESULT_AGGREGATOR_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md";
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly decision: ConstraintAggregationDecision;
  readonly route_decision: VerificationRouteDecision;
  readonly recommended_action: ConstraintAggregationAction;
  readonly constraint_results: readonly ConstraintVerificationResult[];
  readonly success_constraint_refs: readonly Ref[];
  readonly failure_constraint_refs: readonly Ref[];
  readonly ambiguous_constraint_refs: readonly Ref[];
  readonly unsafe_constraint_refs: readonly Ref[];
  readonly confidence: number;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "constraint_aggregation_report";
  readonly determinism_hash: string;
}

/**
 * Aggregates all verification evidence into final route-ready results.
 */
export class ConstraintResultAggregator {
  /**
   * Produces one result per required constraint plus an overall decision.
   */
  public aggregateConstraintResults(request: ConstraintAggregationRequest): ConstraintAggregationReport {
    const issues = freezeArray([
      ...request.sufficiency_report.issues,
      ...request.visual_assessment.issues,
      ...request.spatial_report.issues,
      ...request.false_positive_report.issues,
      ...(request.settle_report?.issues ?? []),
    ]);
    const results = freezeArray(request.policy.required_constraints.map((constraint) => aggregateOne(request, constraint.constraint_ref, constraint.required)));
    const unsafe = uniqueSorted([
      ...request.spatial_report.unsafe_constraint_refs,
      ...results.filter((result) => request.false_positive_report.decision === "safe_hold_required").map((result) => result.constraint_ref),
    ]);
    const failures = uniqueSorted(results.filter((result) => result.status === "failed").map((result) => result.constraint_ref));
    const ambiguous = uniqueSorted(results.filter((result) => result.status === "ambiguous" || result.status === "cannot_assess").map((result) => result.constraint_ref));
    const successes = uniqueSorted(results.filter((result) => result.status === "satisfied").map((result) => result.constraint_ref));
    const decision = decide(request, results, failures, ambiguous, unsafe, issues);
    const route = routeFor(decision);
    const confidence = scaleConfidence(...results.map((result) => result.confidence), request.false_positive_report.confidence);
    const requestRef = request.request_ref ?? makeRef("constraint_aggregation", request.policy.policy_ref);
    const base = {
      schema_version: CONSTRAINT_RESULT_AGGREGATOR_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md" as const,
      report_ref: makeRef("constraint_aggregation_report", requestRef, decision),
      request_ref: requestRef,
      decision,
      route_decision: route,
      recommended_action: actionFor(decision),
      constraint_results: results,
      success_constraint_refs: successes,
      failure_constraint_refs: failures,
      ambiguous_constraint_refs: ambiguous,
      unsafe_constraint_refs: unsafe,
      confidence: round6(confidence),
      issues,
      ok: decision === "success_ready",
      cognitive_visibility: "constraint_aggregation_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function createConstraintResultAggregator(): ConstraintResultAggregator {
  return new ConstraintResultAggregator();
}

function aggregateOne(
  request: ConstraintAggregationRequest,
  constraintRef: Ref,
  required: boolean,
): ConstraintVerificationResult {
  const sufficiency = request.sufficiency_report.constraint_results.find((result) => result.constraint_ref === constraintRef);
  const visual = request.visual_assessment.constraint_assessments.find((result) => result.constraint_ref === constraintRef);
  const spatial = request.spatial_report.residuals.find((result) => result.constraint_ref === constraintRef);
  const riskBlocked = request.false_positive_report.risks.some((risk) => risk.constraint_refs.includes(constraintRef) && !risk.resolved && risk.severity !== "warning");
  const status = combinedStatus(sufficiency?.status, visual?.status, spatial?.status, riskBlocked, required, request.settle_report);
  const confidence = scaleConfidence(sufficiency?.confidence ?? 0.4, visual?.confidence ?? 0.6, spatial?.confidence ?? 0.6, riskBlocked ? 0.2 : 1, request.settle_report?.stability_confidence ?? 1);
  const evidenceRefs = uniqueSorted([
    ...(sufficiency?.available_view_refs ?? []),
    ...(visual?.evidence_refs ?? []),
    ...(spatial?.evidence_refs ?? []),
  ]);
  return Object.freeze({
    constraint_ref: constraintRef,
    status,
    required,
    visual_status: visual?.status,
    spatial_status: spatial?.status,
    evidence_refs: evidenceRefs,
    confidence,
    reason: reasonFor(status, riskBlocked, sufficiency?.status, visual?.status, spatial?.status),
  });
}

function combinedStatus(
  sufficiency: string | undefined,
  visual: VerificationCriterionStatus | undefined,
  spatial: VerificationCriterionStatus | undefined,
  riskBlocked: boolean,
  required: boolean,
  settle: SettleWindowReport | undefined,
): VerificationCriterionStatus {
  if (riskBlocked || spatial === "failed" || visual === "failed" || settle?.decision === "unsafe_contact") return "failed";
  if (settle !== undefined && !settle.ok) return "ambiguous";
  if (sufficiency === "insufficient" || visual === "cannot_assess" || spatial === "cannot_assess") return "cannot_assess";
  if (sufficiency === "sufficient_with_warnings" || visual === "ambiguous" || spatial === "ambiguous") return "ambiguous";
  if (visual === "satisfied" && (spatial === "satisfied" || spatial === undefined || !required)) return "satisfied";
  if (!required && (visual === "satisfied" || spatial === "satisfied")) return "satisfied";
  return required ? "ambiguous" : "satisfied";
}

function decide(
  request: ConstraintAggregationRequest,
  results: readonly ConstraintVerificationResult[],
  failures: readonly Ref[],
  ambiguous: readonly Ref[],
  unsafe: readonly Ref[],
  issues: readonly ValidationIssue[],
): ConstraintAggregationDecision {
  if (issues.some((issue) => issue.severity === "error")) return "rejected";
  if (unsafe.length > 0 || request.false_positive_report.decision === "safe_hold_required" || request.settle_report?.decision === "unsafe_contact") return "unsafe";
  if (request.false_positive_report.decision === "blocked") return "ambiguous";
  if (failures.length > 0) return request.policy.correction_retry_budget > 0 ? "failure_correctable" : "human_review_required";
  if (ambiguous.length > 0 || results.some((result) => result.confidence < 0.45)) return request.policy.ambiguity_retry_budget > 0 ? "ambiguous" : "human_review_required";
  return "success_ready";
}

function routeFor(decision: ConstraintAggregationDecision): VerificationRouteDecision {
  if (decision === "success_ready") return "complete";
  if (decision === "failure_correctable") return "correct";
  if (decision === "ambiguous") return "reobserve";
  if (decision === "unsafe") return "safe_hold";
  return "human_review";
}

function actionFor(decision: ConstraintAggregationDecision): ConstraintAggregationAction {
  if (decision === "success_ready") return "issue_certificate";
  if (decision === "failure_correctable") return "route_correct";
  if (decision === "ambiguous") return "route_reobserve";
  if (decision === "unsafe") return "safe_hold";
  if (decision === "human_review_required") return "human_review";
  return "repair_inputs";
}

function reasonFor(
  status: VerificationCriterionStatus,
  riskBlocked: boolean,
  sufficiency: string | undefined,
  visual: VerificationCriterionStatus | undefined,
  spatial: VerificationCriterionStatus | undefined,
): string {
  if (riskBlocked) return "False-positive risk blocks this constraint.";
  return `constraint=${status}; sufficiency=${sufficiency ?? "unknown"}; visual=${visual ?? "unknown"}; spatial=${spatial ?? "unknown"}.`;
}
