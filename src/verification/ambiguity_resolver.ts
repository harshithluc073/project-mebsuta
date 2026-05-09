/**
 * Ambiguity resolver for Project Mebsuta verification.
 *
 * Blueprint: `architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md`
 * sections 13.2.3, 13.6.10, 13.10.13, 13.11.7, 13.14, and 13.18.
 *
 * The resolver turns unresolved evidence gaps into targeted reobserve or
 * human-review decisions with retry accounting and safe view acquisition
 * limits.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  freezeArray,
  makeIssue,
  makeRef,
  sanitizeText,
  uniqueSorted,
  type VerificationPolicy,
  type VerificationRouteDecision,
} from "./verification_policy_registry";
import type { ConstraintAggregationReport } from "./constraint_result_aggregator";
import type { ViewSufficiencyReport } from "./view_sufficiency_evaluator";
import type { VisualVerificationAssessment } from "./visual_verification_adapter";

export const AMBIGUITY_RESOLVER_SCHEMA_VERSION = "mebsuta.ambiguity_resolver.v1" as const;

export type AmbiguityClass = "occlusion" | "depth_uncertain" | "identity_uncertain" | "stability_uncertain" | "tool_contact_uncertain" | "sensor_sync_uncertain" | "residual_conflict";
export type AmbiguityResolutionDecision = "reobserve_requested" | "alternate_modality_requested" | "human_review_required" | "safe_hold_required" | "no_ambiguity";

export interface AmbiguityReport {
  readonly ambiguity_ref: Ref;
  readonly ambiguity_class: AmbiguityClass;
  readonly affected_constraint_refs: readonly Ref[];
  readonly evidence_refs: readonly Ref[];
  readonly reason: string;
  readonly required_new_views: readonly string[];
  readonly required_new_sensor_packets: readonly string[];
}

export interface ReobserveRequest {
  readonly reobserve_request_ref: Ref;
  readonly source_ambiguity_report_refs: readonly Ref[];
  readonly required_new_views: readonly string[];
  readonly required_new_sensor_packets: readonly string[];
  readonly allowed_body_adjustments: readonly string[];
  readonly forbidden_scene_disturbances: readonly string[];
  readonly maximum_attempt_duration_ms: number;
  readonly retry_budget_remaining_after_attempt: number;
}

export interface AmbiguityResolverRequest {
  readonly request_ref?: Ref;
  readonly policy: VerificationPolicy;
  readonly aggregation_report: ConstraintAggregationReport;
  readonly sufficiency_report: ViewSufficiencyReport;
  readonly visual_assessment: VisualVerificationAssessment;
}

export interface AmbiguityResolverReport {
  readonly schema_version: typeof AMBIGUITY_RESOLVER_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md";
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly decision: AmbiguityResolutionDecision;
  readonly route_decision: VerificationRouteDecision;
  readonly ambiguity_reports: readonly AmbiguityReport[];
  readonly reobserve_request?: ReobserveRequest;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "ambiguity_resolver_report";
  readonly determinism_hash: string;
}

/**
 * Routes ambiguity to reobserve, alternate modality, or review.
 */
export class AmbiguityResolver {
  /**
   * Creates a bounded reobserve request when ambiguity remains actionable.
   */
  public resolveAmbiguity(request: AmbiguityResolverRequest): AmbiguityResolverReport {
    const issues: ValidationIssue[] = [];
    const ambiguities = freezeArray(buildAmbiguities(request));
    const decision = decide(request, ambiguities, issues);
    const reobserve = decision === "reobserve_requested" || decision === "alternate_modality_requested" ? buildReobserveRequest(request, ambiguities) : undefined;
    const requestRef = request.request_ref ?? makeRef("ambiguity_resolver", request.aggregation_report.report_ref);
    const base = {
      schema_version: AMBIGUITY_RESOLVER_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md" as const,
      report_ref: makeRef("ambiguity_resolver_report", requestRef, decision),
      request_ref: requestRef,
      decision,
      route_decision: routeFor(decision),
      ambiguity_reports: ambiguities,
      reobserve_request: reobserve,
      issues: freezeArray(issues),
      ok: decision === "no_ambiguity" || reobserve !== undefined,
      cognitive_visibility: "ambiguity_resolver_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function createAmbiguityResolver(): AmbiguityResolver {
  return new AmbiguityResolver();
}

function buildAmbiguities(request: AmbiguityResolverRequest): readonly AmbiguityReport[] {
  const reports: AmbiguityReport[] = [];
  if (request.aggregation_report.ambiguous_constraint_refs.length > 0) {
    reports.push(report("residual_conflict", request.aggregation_report.ambiguous_constraint_refs, request.sufficiency_report.evidence_refs, "Aggregated constraint status remains ambiguous.", request.sufficiency_report.required_new_views, []));
  }
  if (request.sufficiency_report.required_new_views.length > 0) {
    reports.push(report("occlusion", request.sufficiency_report.constraint_results.filter((item) => item.status !== "sufficient").map((item) => item.constraint_ref), request.sufficiency_report.evidence_refs, "Required embodied views or relation evidence are missing.", request.sufficiency_report.required_new_views, []));
  }
  for (const assessment of request.visual_assessment.constraint_assessments) {
    const reason = assessment.ambiguity_reason ?? "";
    if (/identity|similar|distractor/iu.test(reason)) reports.push(report("identity_uncertain", [assessment.constraint_ref], assessment.evidence_refs, reason, ["distinguishing_crop"], []));
    if (/tool|contact/iu.test(reason)) reports.push(report("tool_contact_uncertain", [assessment.constraint_ref], assessment.evidence_refs, reason, ["tool_axis_view"], ["tactile_contact_summary"]));
    if (/depth|inside|rim|container/iu.test(reason)) reports.push(report("depth_uncertain", [assessment.constraint_ref], assessment.evidence_refs, reason, ["side_view", "overhead_or_wrist_view"], ["depth_packet"]));
  }
  return dedupe(reports);
}

function report(
  ambiguityClass: AmbiguityClass,
  constraintRefs: readonly Ref[],
  evidenceRefs: readonly Ref[],
  reason: string,
  requiredViews: readonly string[],
  requiredPackets: readonly string[],
): AmbiguityReport {
  return Object.freeze({
    ambiguity_ref: makeRef("ambiguity", ambiguityClass, constraintRefs.join(":")),
    ambiguity_class: ambiguityClass,
    affected_constraint_refs: uniqueSorted(constraintRefs),
    evidence_refs: uniqueSorted(evidenceRefs),
    reason: sanitizeText(reason.length > 0 ? reason : `Ambiguity class ${ambiguityClass} requires additional embodied evidence.`),
    required_new_views: uniqueSorted(requiredViews.map(sanitizeText)),
    required_new_sensor_packets: uniqueSorted(requiredPackets.map(sanitizeText)),
  });
}

function decide(
  request: AmbiguityResolverRequest,
  ambiguities: readonly AmbiguityReport[],
  issues: ValidationIssue[],
): AmbiguityResolutionDecision {
  if (request.aggregation_report.route_decision === "safe_hold") return "safe_hold_required";
  if (ambiguities.length === 0 || request.aggregation_report.route_decision !== "reobserve") return "no_ambiguity";
  if (request.policy.ambiguity_retry_budget <= 0) {
    issues.push(makeIssue("warning", "RetryBudgetInvalid", "$.policy.ambiguity_retry_budget", "Ambiguity retry budget is exhausted.", "Escalate to human review."));
    return "human_review_required";
  }
  if (ambiguities.some((ambiguity) => ambiguity.required_new_sensor_packets.length > 0)) return "alternate_modality_requested";
  return "reobserve_requested";
}

function buildReobserveRequest(request: AmbiguityResolverRequest, ambiguities: readonly AmbiguityReport[]): ReobserveRequest {
  return Object.freeze({
    reobserve_request_ref: makeRef("reobserve_request", request.aggregation_report.report_ref, ambiguities.map((item) => item.ambiguity_class).join(":")),
    source_ambiguity_report_refs: uniqueSorted(ambiguities.map((item) => item.ambiguity_ref)),
    required_new_views: uniqueSorted(ambiguities.flatMap((item) => item.required_new_views)),
    required_new_sensor_packets: uniqueSorted(ambiguities.flatMap((item) => item.required_new_sensor_packets)),
    allowed_body_adjustments: freezeArray(["safe_head_yaw", "safe_head_pitch", "effector_retreat_clearance"]),
    forbidden_scene_disturbances: freezeArray(["move_target_object", "apply_tool_force", "use_qa_truth"]),
    maximum_attempt_duration_ms: request.policy.maximum_verification_latency_ms,
    retry_budget_remaining_after_attempt: Math.max(0, request.policy.ambiguity_retry_budget - 1),
  });
}

function routeFor(decision: AmbiguityResolutionDecision): VerificationRouteDecision {
  if (decision === "reobserve_requested" || decision === "alternate_modality_requested") return "reobserve";
  if (decision === "safe_hold_required") return "safe_hold";
  if (decision === "human_review_required") return "human_review";
  return "complete";
}

function dedupe(reports: readonly AmbiguityReport[]): readonly AmbiguityReport[] {
  const byKey = new Map<string, AmbiguityReport>();
  for (const item of reports) byKey.set(`${item.ambiguity_class}:${item.affected_constraint_refs.join(",")}`, item);
  return freezeArray([...byKey.values()].sort((a, b) => a.ambiguity_class.localeCompare(b.ambiguity_class)));
}
