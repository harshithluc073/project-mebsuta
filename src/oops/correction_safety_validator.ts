/**
 * Correction safety validator for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/14_OOPS_LOOP_CORRECTION_ENGINE.md`
 * sections 14.2, 14.4, 14.11, 14.13, 14.17, 14.18, 14.19.5,
 * 14.20, 14.23, and 14.24.
 *
 * The validator enforces force, speed, motion, tool, retry, and environment
 * risk limits before any correction can reach deterministic execution.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  OOPS_BLUEPRINT_REF,
  cleanOopsRef,
  cleanOopsText,
  freezeOopsArray,
  makeOopsIssue,
  makeOopsRef,
  maxWaypointRotation,
  maxWaypointTranslation,
  meanScore,
  type CandidateCorrectionPlan,
  type OopsSafetyLimits,
} from "./oops_intake_router";

export const CORRECTION_SAFETY_VALIDATOR_SCHEMA_VERSION = "mebsuta.correction_safety_validator.v1" as const;

export type CorrectionSafetyDecision = "accepted" | "accepted_with_restrictions" | "repair_required" | "safe_hold_required" | "rejected";

export interface CorrectionRiskContext {
  readonly risk_context_ref: Ref;
  readonly fragile_object_nearby: boolean;
  readonly human_review_required: boolean;
  readonly tool_sweep_risk: "none" | "low" | "medium" | "high";
  readonly balance_margin: "stable" | "cautious" | "unstable";
  readonly environment_risk_refs: readonly Ref[];
}

export interface CorrectionSafetyValidatorRequest {
  readonly request_ref?: Ref;
  readonly candidate_plan: CandidateCorrectionPlan;
  readonly safety_limits: OopsSafetyLimits;
  readonly risk_context: CorrectionRiskContext;
}

export interface SafetyValidationReport {
  readonly schema_version: typeof CORRECTION_SAFETY_VALIDATOR_SCHEMA_VERSION;
  readonly blueprint_ref: typeof OOPS_BLUEPRINT_REF;
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly decision: CorrectionSafetyDecision;
  readonly accepted_plan_ref?: Ref;
  readonly restricted_force_limit_n: number;
  readonly restricted_speed_limit_mps: number;
  readonly restriction_reasons: readonly string[];
  readonly confidence: number;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "correction_safety_validation_report";
  readonly determinism_hash: string;
}

/**
 * Validates correction plans against deterministic safety rules.
 */
export class CorrectionSafetyValidator {
  /**
   * Accepts, restricts, repairs, or blocks a correction plan.
   */
  public validateCorrectionSafety(request: CorrectionSafetyValidatorRequest): SafetyValidationReport {
    const issues: ValidationIssue[] = [];
    const restrictions = buildRestrictions(request, issues);
    const decision = decide(request, issues, restrictions);
    const requestRef = cleanOopsRef(request.request_ref ?? makeOopsRef("correction_safety", request.candidate_plan.plan_ref));
    const restrictedForce = Math.min(request.candidate_plan.force_limit_n, request.safety_limits.max_force_n * forceScale(request.risk_context));
    const restrictedSpeed = Math.min(request.candidate_plan.speed_limit_mps, request.safety_limits.max_speed_mps * speedScale(request.risk_context));
    const confidence = meanScore([decision === "accepted" ? 1 : decision === "accepted_with_restrictions" ? 0.78 : 0.25, request.risk_context.balance_margin === "stable" ? 1 : 0.55, request.risk_context.tool_sweep_risk === "high" ? 0.15 : 0.85]);
    const base = {
      schema_version: CORRECTION_SAFETY_VALIDATOR_SCHEMA_VERSION,
      blueprint_ref: OOPS_BLUEPRINT_REF,
      report_ref: makeOopsRef("correction_safety_report", requestRef, decision),
      request_ref: requestRef,
      decision,
      accepted_plan_ref: decision === "accepted" || decision === "accepted_with_restrictions" ? request.candidate_plan.plan_ref : undefined,
      restricted_force_limit_n: restrictedForce,
      restricted_speed_limit_mps: restrictedSpeed,
      restriction_reasons: freezeOopsArray(restrictions),
      confidence,
      issues: freezeOopsArray(issues),
      ok: decision === "accepted" || decision === "accepted_with_restrictions",
      cognitive_visibility: "correction_safety_validation_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function createCorrectionSafetyValidator(): CorrectionSafetyValidator {
  return new CorrectionSafetyValidator();
}

function buildRestrictions(request: CorrectionSafetyValidatorRequest, issues: ValidationIssue[]): readonly string[] {
  const restrictions: string[] = [];
  if (maxWaypointTranslation(request.candidate_plan) > request.safety_limits.max_translation_m) {
    restrictions.push("translation_clamped_to_safety_limit");
    issues.push(makeOopsIssue("warning", "SafetyLimitExceeded", "$.candidate_plan.waypoints", "Correction translation exceeds safety limit.", "Repair or clamp correction motion."));
  }
  if (maxWaypointRotation(request.candidate_plan) > request.safety_limits.max_rotation_rad) {
    restrictions.push("rotation_clamped_to_safety_limit");
  }
  if (request.candidate_plan.force_limit_n > request.safety_limits.max_force_n) restrictions.push("force_limited");
  if (request.candidate_plan.speed_limit_mps > request.safety_limits.max_speed_mps) restrictions.push("speed_limited");
  if (request.risk_context.fragile_object_nearby) restrictions.push("fragile_context_low_force");
  if (request.risk_context.balance_margin === "cautious") restrictions.push("body_motion_restricted");
  if (request.candidate_plan.correction_intent === "re_aim_tool" && !request.safety_limits.allow_tool_contact) {
    issues.push(makeOopsIssue("error", "SafetyLimitExceeded", "$.candidate_plan.correction_intent", "Tool correction is not allowed by safety policy.", "Use non-tool correction or route review."));
  }
  return freezeOopsArray(restrictions.map(cleanOopsText));
}

function decide(
  request: CorrectionSafetyValidatorRequest,
  issues: readonly ValidationIssue[],
  restrictions: readonly string[],
): CorrectionSafetyDecision {
  if (issues.some((issue) => issue.severity === "error")) return "rejected";
  if (request.risk_context.human_review_required || request.risk_context.balance_margin === "unstable" || request.risk_context.tool_sweep_risk === "high") return "safe_hold_required";
  if (maxWaypointTranslation(request.candidate_plan) > request.safety_limits.max_translation_m * 1.5) return "repair_required";
  return restrictions.length > 0 || issues.length > 0 ? "accepted_with_restrictions" : "accepted";
}

function forceScale(context: CorrectionRiskContext): number {
  if (context.fragile_object_nearby) return 0.35;
  if (context.tool_sweep_risk === "medium") return 0.55;
  return 1;
}

function speedScale(context: CorrectionRiskContext): number {
  if (context.balance_margin === "cautious") return 0.45;
  if (context.fragile_object_nearby) return 0.55;
  return 1;
}
