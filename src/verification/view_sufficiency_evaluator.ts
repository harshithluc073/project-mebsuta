/**
 * View sufficiency evaluator for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md`
 * sections 13.2, 13.3, 13.5, 13.6.4, 13.8.3, 13.10.6, 13.13,
 * and 13.14.
 *
 * This evaluator determines whether embodied observations are enough to judge
 * the requested constraints. It is conservative around occlusion, missing
 * views, weak identity, and unresolved false-positive risks.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import type { VerificationObservationBundle } from "../perception/verification_view_assembler";
import {
  freezeArray,
  makeIssue,
  makeRef,
  sanitizeRef,
  scaleConfidence,
  uniqueSorted,
  validateSafeRef,
  type VerificationConstraintRequirement,
  type VerificationEvidenceStrength,
  type VerificationPolicy,
} from "./verification_policy_registry";
import type { VerificationViewPlan } from "./verification_view_requester";

export const VIEW_SUFFICIENCY_EVALUATOR_SCHEMA_VERSION = "mebsuta.view_sufficiency_evaluator.v1" as const;

export type ViewSufficiencyDecision = "sufficient" | "sufficient_with_warnings" | "insufficient" | "recapture_required" | "rejected";
export type ViewSufficiencyAction = "continue_visual_assessment" | "continue_with_caution" | "reobserve" | "recapture" | "repair_evidence";

export interface ViewSufficiencyRequest {
  readonly request_ref?: Ref;
  readonly policy: VerificationPolicy;
  readonly view_plan: VerificationViewPlan;
  readonly observation_bundle?: VerificationObservationBundle;
  readonly external_evidence_refs?: readonly Ref[];
}

export interface ConstraintEvidenceSufficiency {
  readonly constraint_ref: Ref;
  readonly status: ViewSufficiencyDecision;
  readonly evidence_strength: VerificationEvidenceStrength;
  readonly available_view_refs: readonly Ref[];
  readonly missing_view_names: readonly string[];
  readonly unresolved_risk_refs: readonly Ref[];
  readonly confidence: number;
}

export interface ViewSufficiencyReport {
  readonly schema_version: typeof VIEW_SUFFICIENCY_EVALUATOR_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md";
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly decision: ViewSufficiencyDecision;
  readonly recommended_action: ViewSufficiencyAction;
  readonly constraint_results: readonly ConstraintEvidenceSufficiency[];
  readonly missing_evidence_refs: readonly Ref[];
  readonly required_new_views: readonly string[];
  readonly confidence: number;
  readonly evidence_refs: readonly Ref[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "view_sufficiency_report";
  readonly determinism_hash: string;
}

/**
 * Evaluates view coverage and embodied evidence strength.
 */
export class ViewSufficiencyEvaluator {
  /**
   * Determines whether the observation bundle can support final judgment.
   */
  public evaluateViewSufficiency(request: ViewSufficiencyRequest): ViewSufficiencyReport {
    const issues: ValidationIssue[] = [];
    validateRequest(request, issues);
    const constraintResults = freezeArray(request.policy.required_constraints.map((constraint) => evaluateConstraint(request, constraint)));
    const decision = decide(request, constraintResults, issues);
    const confidence = scaleConfidence(...constraintResults.map((result) => result.confidence), request.observation_bundle?.ok === false ? 0.45 : 1);
    const requiredNewViews = uniqueSorted(constraintResults.flatMap((result) => result.missing_view_names));
    const missingEvidenceRefs = freezeArray(constraintResults.filter((result) => result.evidence_strength === "missing").map((result) => makeRef("missing_evidence", result.constraint_ref)));
    const evidenceRefs = freezeArray([
      ...(request.external_evidence_refs ?? []),
      ...(request.observation_bundle?.provided_views.map((view) => view.evidence_ref) ?? []),
    ].map(sanitizeRef).sort());
    const requestRef = sanitizeRef(request.request_ref ?? makeRef("view_sufficiency", request.view_plan.view_plan_ref));
    const base = {
      schema_version: VIEW_SUFFICIENCY_EVALUATOR_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md" as const,
      report_ref: makeRef("view_sufficiency_report", requestRef, decision),
      request_ref: requestRef,
      decision,
      recommended_action: recommend(decision),
      constraint_results: constraintResults,
      missing_evidence_refs: missingEvidenceRefs,
      required_new_views: requiredNewViews,
      confidence,
      evidence_refs: evidenceRefs,
      issues: freezeArray(issues),
      ok: decision === "sufficient" || decision === "sufficient_with_warnings",
      cognitive_visibility: "view_sufficiency_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function createViewSufficiencyEvaluator(): ViewSufficiencyEvaluator {
  return new ViewSufficiencyEvaluator();
}

function validateRequest(request: ViewSufficiencyRequest, issues: ValidationIssue[]): void {
  validateSafeRef(request.view_plan.view_plan_ref, "$.view_plan.view_plan_ref", "HiddenVerificationLeak", issues);
  for (const ref of request.external_evidence_refs ?? []) validateSafeRef(ref, "$.external_evidence_refs", "HiddenVerificationLeak", issues);
  if (request.view_plan.missing_required_views.length > 0 && request.observation_bundle === undefined) {
    issues.push(makeIssue("warning", "ViewPolicyMissing", "$.observation_bundle", "View plan has missing required views and no final observation bundle.", "Collect the required views before visual assessment."));
  }
}

function evaluateConstraint(
  request: ViewSufficiencyRequest,
  constraint: VerificationConstraintRequirement,
): ConstraintEvidenceSufficiency {
  const planItems = request.view_plan.required_views.filter((item) => item.supports_constraint_refs.includes(constraint.constraint_ref));
  const availablePlanItems = planItems.filter((item) => item.sensor_ref !== undefined);
  const bundleViews = request.observation_bundle?.provided_views.filter((view) => view.supports_constraint_refs.includes(constraint.constraint_ref)) ?? [];
  const risks = request.observation_bundle?.false_positive_risks.filter((risk) => risk.constraint_ref === constraint.constraint_ref && risk.severity === "blocking" && !risk.resolved) ?? [];
  const missingViewNames = planItems.filter((item) => item.sensor_ref === undefined || bundleViews.some((view) => view.source_view_name === item.view_name && (view.status === "missing" || view.status === "occluded"))).map((item) => item.view_name);
  const evidenceRefs = uniqueSorted([
    ...constraint.evidence_refs,
    ...availablePlanItems.flatMap((item) => item.sensor_ref === undefined ? [] : [item.sensor_ref]),
    ...bundleViews.map((view) => view.evidence_ref),
  ]);
  const strength = strengthFor(constraint, planItems.length, availablePlanItems.length, bundleViews.length, risks.length);
  const confidence = confidenceFor(strength, planItems.length, availablePlanItems.length, bundleViews.length, risks.length, missingViewNames.length);
  const status: ViewSufficiencyDecision = risks.length > 0 || strength === "missing" ? "insufficient" : missingViewNames.length > 0 || strength === "weak" ? "sufficient_with_warnings" : "sufficient";
  return Object.freeze({
    constraint_ref: constraint.constraint_ref,
    status,
    evidence_strength: strength,
    available_view_refs: evidenceRefs,
    missing_view_names: freezeArray(uniqueSorted(missingViewNames.map(String))),
    unresolved_risk_refs: freezeArray(risks.map((risk) => risk.risk_ref).sort()),
    confidence,
  });
}

function strengthFor(
  constraint: VerificationConstraintRequirement,
  planCount: number,
  availablePlanCount: number,
  bundleCount: number,
  riskCount: number,
): VerificationEvidenceStrength {
  if (riskCount > 0 || (constraint.required && availablePlanCount === 0 && bundleCount === 0 && constraint.evidence_refs.length === 0)) return "missing";
  if (bundleCount >= Math.max(1, Math.min(2, planCount)) && availablePlanCount >= Math.max(1, Math.min(2, planCount))) return "strong";
  if (availablePlanCount > 0 || bundleCount > 0 || constraint.evidence_refs.length > 0) return "moderate";
  return "weak";
}

function confidenceFor(
  strength: VerificationEvidenceStrength,
  planCount: number,
  availablePlanCount: number,
  bundleCount: number,
  riskCount: number,
  missingCount: number,
): number {
  const strengthScore = strength === "strong" ? 1 : strength === "moderate" ? 0.78 : strength === "weak" ? 0.48 : 0.1;
  const planScore = planCount === 0 ? 0.3 : Math.min(1, availablePlanCount / planCount);
  const bundleScore = planCount === 0 ? 0.5 : Math.min(1, bundleCount / planCount);
  const riskScore = riskCount > 0 ? 0.2 : 1;
  const missingScore = missingCount > 0 ? 0.65 : 1;
  return scaleConfidence(strengthScore, planScore, bundleScore, riskScore, missingScore);
}

function decide(
  request: ViewSufficiencyRequest,
  results: readonly ConstraintEvidenceSufficiency[],
  issues: readonly ValidationIssue[],
): ViewSufficiencyDecision {
  if (issues.some((issue) => issue.severity === "error")) return "rejected";
  if (request.observation_bundle?.decision === "recapture_required") return "recapture_required";
  if (results.some((result) => result.status === "insufficient")) return "insufficient";
  if (results.some((result) => result.status === "sufficient_with_warnings") || issues.length > 0) return "sufficient_with_warnings";
  return "sufficient";
}

function recommend(decision: ViewSufficiencyDecision): ViewSufficiencyAction {
  if (decision === "sufficient") return "continue_visual_assessment";
  if (decision === "sufficient_with_warnings") return "continue_with_caution";
  if (decision === "insufficient") return "reobserve";
  if (decision === "recapture_required") return "recapture";
  return "repair_evidence";
}
