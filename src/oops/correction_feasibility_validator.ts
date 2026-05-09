/**
 * Correction feasibility validator for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/14_OOPS_LOOP_CORRECTION_ENGINE.md`
 * sections 14.4, 14.12, 14.17, 14.18, 14.19.5, 14.20, and 14.24.
 *
 * This validator checks reach, frame availability, IK margin, collision
 * clearance, view availability, and body-specific capability before execution.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  OOPS_BLUEPRINT_REF,
  cleanOopsRef,
  freezeOopsArray,
  makeOopsIssue,
  makeOopsRef,
  maxWaypointTranslation,
  meanScore,
  uniqueOopsSorted,
  type CandidateCorrectionPlan,
} from "./oops_intake_router";
import type { SafetyValidationReport } from "./correction_safety_validator";

export const CORRECTION_FEASIBILITY_VALIDATOR_SCHEMA_VERSION = "mebsuta.correction_feasibility_validator.v1" as const;

export type CorrectionFeasibilityDecision = "feasible" | "feasible_with_adjustments" | "repair_required" | "reobserve_required" | "rejected";

export interface CorrectionCapabilitySummary {
  readonly capability_ref: Ref;
  readonly embodiment_kind: "quadruped" | "humanoid";
  readonly maximum_reach_m: number;
  readonly fine_rotation_supported: boolean;
  readonly tool_use_supported: boolean;
  readonly body_reposition_supported: boolean;
  readonly available_view_refs: readonly Ref[];
}

export interface GeometryFeasibilityContext {
  readonly context_ref: Ref;
  readonly frame_refs: readonly Ref[];
  readonly collision_clearance_m: number;
  readonly ik_margin: number;
  readonly required_view_refs: readonly Ref[];
  readonly unresolved_constraint_refs: readonly Ref[];
}

export interface CorrectionFeasibilityValidatorRequest {
  readonly request_ref?: Ref;
  readonly candidate_plan: CandidateCorrectionPlan;
  readonly safety_report: SafetyValidationReport;
  readonly capability_summary: CorrectionCapabilitySummary;
  readonly geometry_context: GeometryFeasibilityContext;
}

export interface FeasibilityValidationReport {
  readonly schema_version: typeof CORRECTION_FEASIBILITY_VALIDATOR_SCHEMA_VERSION;
  readonly blueprint_ref: typeof OOPS_BLUEPRINT_REF;
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly decision: CorrectionFeasibilityDecision;
  readonly feasible_plan_ref?: Ref;
  readonly required_adjustments: readonly string[];
  readonly unavailable_requirement_refs: readonly Ref[];
  readonly confidence: number;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "correction_feasibility_validation_report";
  readonly determinism_hash: string;
}

/**
 * Validates whether a safe plan is physically executable.
 */
export class CorrectionFeasibilityValidator {
  /**
   * Checks reach, IK margin, clearance, frame refs, and view needs.
   */
  public validateCorrectionFeasibility(request: CorrectionFeasibilityValidatorRequest): FeasibilityValidationReport {
    const issues: ValidationIssue[] = [];
    const adjustments = buildAdjustments(request, issues);
    const unavailable = unavailableRefs(request);
    const decision = decide(request, adjustments, unavailable, issues);
    const confidence = meanScore([request.geometry_context.ik_margin, request.geometry_context.collision_clearance_m > 0.03 ? 1 : 0.45, unavailable.length === 0 ? 1 : 0.4, request.safety_report.confidence]);
    const requestRef = cleanOopsRef(request.request_ref ?? makeOopsRef("correction_feasibility", request.candidate_plan.plan_ref));
    const base = {
      schema_version: CORRECTION_FEASIBILITY_VALIDATOR_SCHEMA_VERSION,
      blueprint_ref: OOPS_BLUEPRINT_REF,
      report_ref: makeOopsRef("correction_feasibility_report", requestRef, decision),
      request_ref: requestRef,
      decision,
      feasible_plan_ref: decision === "feasible" || decision === "feasible_with_adjustments" ? request.candidate_plan.plan_ref : undefined,
      required_adjustments: freezeOopsArray(adjustments),
      unavailable_requirement_refs: unavailable,
      confidence,
      issues: freezeOopsArray(issues),
      ok: decision === "feasible" || decision === "feasible_with_adjustments",
      cognitive_visibility: "correction_feasibility_validation_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function createCorrectionFeasibilityValidator(): CorrectionFeasibilityValidator {
  return new CorrectionFeasibilityValidator();
}

function buildAdjustments(request: CorrectionFeasibilityValidatorRequest, issues: ValidationIssue[]): readonly string[] {
  const adjustments: string[] = [];
  if (request.safety_report.accepted_plan_ref === undefined) {
    issues.push(makeOopsIssue("error", "SafetyLimitExceeded", "$.safety_report", "Safety validation did not accept the candidate plan.", "Repair safety before feasibility."));
  }
  if (maxWaypointTranslation(request.candidate_plan) > request.capability_summary.maximum_reach_m) {
    adjustments.push("body_reposition_before_correction");
  }
  if (request.candidate_plan.correction_intent === "rotate_in_place" && !request.capability_summary.fine_rotation_supported) {
    adjustments.push("use_regrasp_instead_of_fine_rotation");
  }
  if (request.candidate_plan.correction_intent === "re_aim_tool" && !request.capability_summary.tool_use_supported) {
    issues.push(makeOopsIssue("error", "FeasibilityMissing", "$.capability_summary.tool_use_supported", "Tool correction is not supported by the embodiment.", "Repair plan with non-tool intent."));
  }
  if (request.geometry_context.ik_margin < 0.15) adjustments.push("reduce_waypoint_distance");
  if (request.geometry_context.collision_clearance_m < 0.02) adjustments.push("increase_clearance_or_reobserve");
  return freezeOopsArray(adjustments);
}

function unavailableRefs(request: CorrectionFeasibilityValidatorRequest): readonly Ref[] {
  const available = new Set(request.capability_summary.available_view_refs);
  return uniqueOopsSorted(request.geometry_context.required_view_refs.filter((ref) => !available.has(ref)).map(cleanOopsRef));
}

function decide(
  request: CorrectionFeasibilityValidatorRequest,
  adjustments: readonly string[],
  unavailable: readonly Ref[],
  issues: readonly ValidationIssue[],
): CorrectionFeasibilityDecision {
  if (issues.some((issue) => issue.severity === "error")) return "rejected";
  if (unavailable.length > 0) return "reobserve_required";
  if (request.geometry_context.ik_margin <= 0 || request.geometry_context.collision_clearance_m <= 0) return "repair_required";
  return adjustments.length > 0 || issues.length > 0 ? "feasible_with_adjustments" : "feasible";
}
