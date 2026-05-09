/**
 * Oops handoff router for Project Mebsuta verification.
 *
 * Blueprint: `architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md`
 * sections 13.5, 13.6.11, 13.10.13, 13.11.8, and 13.15.
 *
 * The router converts correctable verification failures into deterministic
 * correction packets for the Oops Loop while preserving residual directions,
 * embodied evidence, controller symptoms, and safety limits.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  freezeArray,
  makeIssue,
  makeRef,
  sanitizeRef,
  sanitizeText,
  uniqueSorted,
  type ControllerCompletionSummary,
  type VerificationPolicy,
  type VerificationRouteDecision,
} from "./verification_policy_registry";
import type { ConstraintAggregationReport } from "./constraint_result_aggregator";
import type { TaskSuccessCertificate } from "./task_success_certificate_issuer";
import type { SpatialResidualEvaluationReport } from "./spatial_residual_evaluator";

export const OOPS_HANDOFF_ROUTER_SCHEMA_VERSION = "mebsuta.oops_handoff_router.v1" as const;

export type OopsHandoffDecision = "handoff_ready" | "insufficient_failure_evidence" | "retry_budget_exhausted" | "safe_hold_required" | "not_required";
export type OopsFailureMode = "placement_offset" | "misplacement" | "rotation_error" | "slip" | "missed_insertion" | "tool_misalignment" | "stability_failure" | "wrong_object" | "unknown";
export type OopsCorrectionScope = "micro_adjust" | "regrasp_and_replace" | "rotate_in_place" | "reposition_and_retry" | "re_aim_tool_path" | "human_review";

export interface OopsVerificationHandoff {
  readonly schema_version: typeof OOPS_HANDOFF_ROUTER_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md";
  readonly handoff_ref: Ref;
  readonly source_certificate_ref: Ref;
  readonly failure_mode: OopsFailureMode;
  readonly correction_scope: OopsCorrectionScope;
  readonly failed_constraint_refs: readonly Ref[];
  readonly residual_direction_summaries: readonly string[];
  readonly evidence_refs: readonly Ref[];
  readonly controller_telemetry_refs: readonly Ref[];
  readonly retry_budget_remaining_after_handoff: number;
  readonly safety_policy_ref: Ref;
  readonly prompt_safe_summary: string;
  readonly determinism_hash: string;
}

export interface OopsHandoffRouterRequest {
  readonly request_ref?: Ref;
  readonly policy: VerificationPolicy;
  readonly aggregation_report: ConstraintAggregationReport;
  readonly certificate?: TaskSuccessCertificate;
  readonly spatial_report: SpatialResidualEvaluationReport;
  readonly controller_completion_summary: ControllerCompletionSummary;
  readonly safety_policy_ref: Ref;
}

export interface OopsHandoffRouterReport {
  readonly schema_version: typeof OOPS_HANDOFF_ROUTER_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md";
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly decision: OopsHandoffDecision;
  readonly route_decision: VerificationRouteDecision;
  readonly handoff?: OopsVerificationHandoff;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "oops_handoff_router_report";
  readonly determinism_hash: string;
}

/**
 * Builds verification failure handoffs for correction.
 */
export class OopsHandoffRouter {
  /**
   * Routes correctable failures into a bounded Oops packet.
   */
  public routeOopsHandoff(request: OopsHandoffRouterRequest): OopsHandoffRouterReport {
    const issues: ValidationIssue[] = [];
    validateRequest(request, issues);
    const decision = decide(request, issues);
    const handoff = decision === "handoff_ready" ? buildHandoff(request) : undefined;
    const requestRef = sanitizeRef(request.request_ref ?? makeRef("oops_handoff", request.aggregation_report.report_ref));
    const base = {
      schema_version: OOPS_HANDOFF_ROUTER_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md" as const,
      report_ref: makeRef("oops_handoff_router_report", requestRef, decision),
      request_ref: requestRef,
      decision,
      route_decision: routeFor(decision),
      handoff,
      issues: freezeArray(issues),
      ok: decision === "handoff_ready" || decision === "not_required",
      cognitive_visibility: "oops_handoff_router_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function createOopsHandoffRouter(): OopsHandoffRouter {
  return new OopsHandoffRouter();
}

function validateRequest(request: OopsHandoffRouterRequest, issues: ValidationIssue[]): void {
  if (request.aggregation_report.failure_constraint_refs.length === 0 && request.aggregation_report.route_decision === "correct") {
    issues.push(makeIssue("warning", "ConstraintMissing", "$.aggregation_report.failure_constraint_refs", "Correction route lacks failed constraint refs.", "Attach residual-backed failure evidence."));
  }
  if (request.controller_completion_summary.high_force_contact) {
    issues.push(makeIssue("warning", "ViewPolicyMissing", "$.controller_completion_summary.high_force_contact", "High-force contact blocks correction until safety review.", "Route SafeHold."));
  }
}

function decide(request: OopsHandoffRouterRequest, issues: readonly ValidationIssue[]): OopsHandoffDecision {
  if (request.aggregation_report.route_decision !== "correct") return request.aggregation_report.route_decision === "safe_hold" ? "safe_hold_required" : "not_required";
  if (request.controller_completion_summary.high_force_contact) return "safe_hold_required";
  if (request.policy.correction_retry_budget <= 0) return "retry_budget_exhausted";
  if (request.aggregation_report.failure_constraint_refs.length === 0 || request.spatial_report.residuals.length === 0 || issues.some((issue) => issue.severity === "error")) return "insufficient_failure_evidence";
  return "handoff_ready";
}

function buildHandoff(request: OopsHandoffRouterRequest): OopsVerificationHandoff {
  const failureMode = classifyFailureMode(request);
  const scope = correctionScopeFor(failureMode);
  const evidenceRefs = uniqueSorted([
    ...request.aggregation_report.constraint_results.flatMap((result) => result.evidence_refs),
    ...request.spatial_report.evidence_refs,
  ]);
  const residualDirections = uniqueSorted(request.spatial_report.residuals
    .filter((residual) => request.aggregation_report.failure_constraint_refs.includes(residual.constraint_ref))
    .map((residual) => sanitizeText(`${residual.constraint_ref}:${String(residual.correction_direction ?? "direction_unknown")}`)));
  const handoffRef = makeRef("oops_verification_handoff", request.aggregation_report.report_ref, failureMode);
  const base = {
    schema_version: OOPS_HANDOFF_ROUTER_SCHEMA_VERSION,
    blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md" as const,
    handoff_ref: handoffRef,
    source_certificate_ref: request.certificate?.certificate_ref ?? makeRef("certificate_pending", request.aggregation_report.report_ref),
    failure_mode: failureMode,
    correction_scope: scope,
    failed_constraint_refs: request.aggregation_report.failure_constraint_refs,
    residual_direction_summaries: residualDirections,
    evidence_refs: evidenceRefs,
    controller_telemetry_refs: uniqueSorted(request.controller_completion_summary.telemetry_refs.map(sanitizeRef)),
    retry_budget_remaining_after_handoff: Math.max(0, request.policy.correction_retry_budget - 1),
    safety_policy_ref: sanitizeRef(request.safety_policy_ref),
    prompt_safe_summary: sanitizeText(`Correction handoff ${failureMode} recommends ${scope} from embodied residual evidence.`),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function classifyFailureMode(request: OopsHandoffRouterRequest): OopsFailureMode {
  const failed = request.aggregation_report.failure_constraint_refs.join(":").toLowerCase();
  const residualTypes = request.spatial_report.residuals.filter((residual) => request.aggregation_report.failure_constraint_refs.includes(residual.constraint_ref)).map((residual) => residual.residual_ref).join(":");
  if (/identity|wrong/iu.test(failed)) return "wrong_object";
  if (/orientation|rotation/iu.test(failed + residualTypes)) return "rotation_error";
  if (/inside|contain/iu.test(failed)) return "missed_insertion";
  if (/tool/iu.test(failed)) return "tool_misalignment";
  if (/stability|support|top/iu.test(failed)) return "stability_failure";
  if (request.controller_completion_summary.anomaly_refs.some((ref) => /slip/iu.test(ref))) return "slip";
  const maxError = Math.max(0, ...request.spatial_report.residuals.map((residual) => residual.normalized_error));
  return maxError > 3 ? "misplacement" : "placement_offset";
}

function correctionScopeFor(mode: OopsFailureMode): OopsCorrectionScope {
  if (mode === "placement_offset") return "micro_adjust";
  if (mode === "rotation_error") return "rotate_in_place";
  if (mode === "tool_misalignment") return "re_aim_tool_path";
  if (mode === "wrong_object" || mode === "unknown") return "human_review";
  if (mode === "missed_insertion") return "reposition_and_retry";
  return "regrasp_and_replace";
}

function routeFor(decision: OopsHandoffDecision): VerificationRouteDecision {
  if (decision === "handoff_ready") return "correct";
  if (decision === "safe_hold_required") return "safe_hold";
  if (decision === "retry_budget_exhausted" || decision === "insufficient_failure_evidence") return "human_review";
  return "complete";
}
