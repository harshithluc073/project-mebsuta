/**
 * Correction plan repairer for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/14_OOPS_LOOP_CORRECTION_ENGINE.md`
 * sections 14.4, 14.16, 14.19.5, 14.20.2, 14.23, and 14.24.
 *
 * The repairer creates constrained repair requests and deterministic plan
 * variants when safety, feasibility, or schema validation rejects a candidate.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  OOPS_BLUEPRINT_REF,
  cleanOopsText,
  freezeOopsArray,
  makeOopsIssue,
  makeOopsRef,
  type CandidateCorrectionPlan,
} from "./oops_intake_router";
import type { SafetyValidationReport } from "./correction_safety_validator";
import type { FeasibilityValidationReport } from "./correction_feasibility_validator";

export const CORRECTION_PLAN_REPAIRER_SCHEMA_VERSION = "mebsuta.correction_plan_repairer.v1" as const;

export type CorrectionRepairDecision = "repair_created" | "reobserve_required" | "human_review_required" | "safe_hold_required" | "not_required";

export interface CorrectionRepairRequest {
  readonly repair_request_ref: Ref;
  readonly source_candidate_plan_ref: Ref;
  readonly rejection_reasons: readonly string[];
  readonly allowed_repair_scope: readonly string[];
  readonly forbidden_changes: readonly string[];
  readonly remaining_repair_budget: number;
  readonly additional_evidence_refs: readonly Ref[];
}

export interface CorrectionPlanRepairerRequest {
  readonly request_ref?: Ref;
  readonly candidate_plan: CandidateCorrectionPlan;
  readonly safety_report?: SafetyValidationReport;
  readonly feasibility_report?: FeasibilityValidationReport;
  readonly remaining_repair_budget: number;
}

export interface CorrectionPlanRepairerReport {
  readonly schema_version: typeof CORRECTION_PLAN_REPAIRER_SCHEMA_VERSION;
  readonly blueprint_ref: typeof OOPS_BLUEPRINT_REF;
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly decision: CorrectionRepairDecision;
  readonly repair_request?: CorrectionRepairRequest;
  readonly repaired_plan?: CandidateCorrectionPlan;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "correction_plan_repairer_report";
  readonly determinism_hash: string;
}

/**
 * Builds bounded repair requests and conservative plan variants.
 */
export class CorrectionPlanRepairer {
  /**
   * Repairs adjustable plan fields or escalates when repair is unsafe.
   */
  public repairCorrectionPlan(request: CorrectionPlanRepairerRequest): CorrectionPlanRepairerReport {
    const issues: ValidationIssue[] = [];
    const reasons = rejectionReasons(request);
    const decision = decide(request, reasons, issues);
    const repairRequest = decision === "repair_created" ? buildRepairRequest(request, reasons) : undefined;
    const repaired = repairRequest === undefined ? undefined : buildRepairedPlan(request.candidate_plan);
    const requestRef = request.request_ref ?? makeOopsRef("correction_repairer", request.candidate_plan.plan_ref);
    const base = {
      schema_version: CORRECTION_PLAN_REPAIRER_SCHEMA_VERSION,
      blueprint_ref: OOPS_BLUEPRINT_REF,
      report_ref: makeOopsRef("correction_repairer_report", requestRef, decision),
      request_ref: requestRef,
      decision,
      repair_request: repairRequest,
      repaired_plan: repaired,
      issues: freezeOopsArray(issues),
      ok: decision === "repair_created" || decision === "not_required",
      cognitive_visibility: "correction_plan_repairer_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function createCorrectionPlanRepairer(): CorrectionPlanRepairer {
  return new CorrectionPlanRepairer();
}

function rejectionReasons(request: CorrectionPlanRepairerRequest): readonly string[] {
  return freezeOopsArray([
    ...(request.safety_report?.restriction_reasons ?? []),
    ...(request.safety_report?.issues.map((issue) => issue.message) ?? []),
    ...(request.feasibility_report?.required_adjustments ?? []),
    ...(request.feasibility_report?.issues.map((issue) => issue.message) ?? []),
  ].map(cleanOopsText).filter((value) => value.length > 0));
}

function decide(
  request: CorrectionPlanRepairerRequest,
  reasons: readonly string[],
  issues: ValidationIssue[],
): CorrectionRepairDecision {
  if (request.safety_report?.decision === "safe_hold_required") return "safe_hold_required";
  if (request.feasibility_report?.decision === "reobserve_required") return "reobserve_required";
  if (reasons.length === 0) return "not_required";
  if (request.remaining_repair_budget <= 0) {
    issues.push(makeOopsIssue("warning", "RetryBudgetExhausted", "$.remaining_repair_budget", "Repair budget is exhausted.", "Escalate to human review."));
    return "human_review_required";
  }
  return "repair_created";
}

function buildRepairRequest(request: CorrectionPlanRepairerRequest, reasons: readonly string[]): CorrectionRepairRequest {
  return Object.freeze({
    repair_request_ref: makeOopsRef("correction_repair_request", request.candidate_plan.plan_ref, request.remaining_repair_budget.toString()),
    source_candidate_plan_ref: request.candidate_plan.plan_ref,
    rejection_reasons: freezeOopsArray(reasons),
    allowed_repair_scope: freezeOopsArray(["lower_force", "lower_speed", "shorten_waypoint", "add_reobserve_step", "change_contact_point"]),
    forbidden_changes: freezeOopsArray(["change_target_object", "ignore_failed_constraint", "increase_retry_budget", "use_hidden_pose"]),
    remaining_repair_budget: Math.max(0, request.remaining_repair_budget - 1),
    additional_evidence_refs: freezeOopsArray(request.candidate_plan.evidence_refs),
  });
}

function buildRepairedPlan(plan: CandidateCorrectionPlan): CandidateCorrectionPlan {
  return Object.freeze({
    ...plan,
    plan_ref: makeOopsRef("repaired", plan.plan_ref),
    force_limit_n: plan.force_limit_n * 0.7,
    speed_limit_mps: plan.speed_limit_mps * 0.7,
    waypoints: freezeOopsArray(plan.waypoints.map((waypoint) => Object.freeze({
      ...waypoint,
      waypoint_ref: makeOopsRef("repaired", waypoint.waypoint_ref),
      position_delta_m: [waypoint.position_delta_m[0] * 0.7, waypoint.position_delta_m[1] * 0.7, waypoint.position_delta_m[2] * 0.7] as const,
    }))),
    stop_conditions: freezeOopsArray([...plan.stop_conditions, "repair_guard_triggered"]),
  });
}
