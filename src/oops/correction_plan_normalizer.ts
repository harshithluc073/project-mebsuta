/**
 * Correction plan normalizer for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/14_OOPS_LOOP_CORRECTION_ENGINE.md`
 * sections 14.4, 14.10, 14.11, 14.16, 14.17, 14.18, and 14.19.5.
 *
 * The normalizer converts a cognitive correction proposal into a deterministic
 * candidate plan with explicit waypoints, limits, preserved constraints, stop
 * conditions, and verification postconditions.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, Vector3 } from "../simulation/world_manifest";
import {
  OOPS_BLUEPRINT_REF,
  cleanOopsRef,
  cleanOopsText,
  freezeOopsArray,
  makeOopsIssue,
  makeOopsRef,
  round6,
  uniqueOopsSorted,
  vectorMagnitude,
  type CandidateCorrectionPlan,
  type CorrectionIntentKind,
  type CorrectionWaypoint,
  type OopsEpisode,
  type OopsSafetyLimits,
} from "./oops_intake_router";
import type { CognitiveCorrectionProposal } from "./gemini_correction_reasoner";
import type { FailureModeReport } from "./failure_mode_classifier";

export const CORRECTION_PLAN_NORMALIZER_SCHEMA_VERSION = "mebsuta.correction_plan_normalizer.v1" as const;

export type CorrectionPlanNormalizationDecision = "normalized" | "normalized_with_warnings" | "repair_required" | "reobserve_required" | "rejected";

export interface CorrectionPlanNormalizerRequest {
  readonly request_ref?: Ref;
  readonly episode: OopsEpisode;
  readonly proposal: CognitiveCorrectionProposal;
  readonly failure_mode_report: FailureModeReport;
  readonly safety_limits: OopsSafetyLimits;
  readonly preserved_constraint_refs?: readonly Ref[];
}

export interface CorrectionPlanNormalizerReport {
  readonly schema_version: typeof CORRECTION_PLAN_NORMALIZER_SCHEMA_VERSION;
  readonly blueprint_ref: typeof OOPS_BLUEPRINT_REF;
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly decision: CorrectionPlanNormalizationDecision;
  readonly candidate_plan?: CandidateCorrectionPlan;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "correction_plan_normalizer_report";
  readonly determinism_hash: string;
}

/**
 * Produces deterministic candidate correction plans.
 */
export class CorrectionPlanNormalizer {
  /**
   * Normalizes intent, waypoint, force, speed, and stop-condition fields.
   */
  public normalizeCorrectionPlan(request: CorrectionPlanNormalizerRequest): CorrectionPlanNormalizerReport {
    const issues: ValidationIssue[] = [];
    validateProposal(request, issues);
    const decision = decide(request, issues);
    const plan = decision === "rejected" || decision === "reobserve_required" ? undefined : buildPlan(request);
    const requestRef = cleanOopsRef(request.request_ref ?? makeOopsRef("correction_plan_normalizer", request.proposal.proposal_ref));
    const base = {
      schema_version: CORRECTION_PLAN_NORMALIZER_SCHEMA_VERSION,
      blueprint_ref: OOPS_BLUEPRINT_REF,
      report_ref: makeOopsRef("correction_plan_normalizer_report", requestRef, decision),
      request_ref: requestRef,
      decision,
      candidate_plan: plan,
      issues: freezeOopsArray(issues),
      ok: plan !== undefined && (decision === "normalized" || decision === "normalized_with_warnings"),
      cognitive_visibility: "correction_plan_normalizer_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function createCorrectionPlanNormalizer(): CorrectionPlanNormalizer {
  return new CorrectionPlanNormalizer();
}

function buildPlan(request: CorrectionPlanNormalizerRequest): CandidateCorrectionPlan {
  const intent = request.proposal.proposed_intent;
  const waypoint = waypointFor(request.proposal, request.safety_limits, intent);
  const forceLimit = round6(Math.min(request.safety_limits.max_force_n, forceFor(intent, request.safety_limits)));
  const speedLimit = round6(Math.min(request.safety_limits.max_speed_mps, speedFor(intent, request.safety_limits)));
  return Object.freeze({
    plan_ref: makeOopsRef("candidate_correction_plan", request.episode.oops_episode_ref, request.proposal.proposal_ref),
    oops_episode_ref: request.episode.oops_episode_ref,
    correction_intent: intent,
    target_object_ref: cleanOopsRef(request.proposal.target_object_ref),
    failed_constraint_refs: uniqueOopsSorted(request.failure_mode_report.evidence_refs.filter((ref) => /constraint|residual/iu.test(ref)).map(cleanOopsRef)),
    preserved_constraint_refs: uniqueOopsSorted((request.preserved_constraint_refs ?? request.episode.constraint_context_refs).map(cleanOopsRef)),
    waypoints: freezeOopsArray([waypoint]),
    expected_postcondition_refs: uniqueOopsSorted([
      makeOopsRef("post_correction_verify", request.failure_mode_report.primary_failure_mode),
      ...request.failure_mode_report.evidence_refs.filter((ref) => /constraint/iu.test(ref)),
    ]),
    force_limit_n: forceLimit,
    speed_limit_mps: speedLimit,
    max_duration_ms: durationFor(intent),
    stop_conditions: freezeOopsArray(stopConditionsFor(intent)),
    evidence_refs: uniqueOopsSorted(request.proposal.evidence_refs.map(cleanOopsRef)),
  });
}

function waypointFor(
  proposal: CognitiveCorrectionProposal,
  limits: OopsSafetyLimits,
  intent: CorrectionIntentKind,
): CorrectionWaypoint {
  const translation = clampVector(proposal.correction_vector_m ?? defaultVector(intent), limits.max_translation_m);
  const rotation = proposal.rotation_vector_rad === undefined ? undefined : clampVector(proposal.rotation_vector_rad, limits.max_rotation_rad);
  return Object.freeze({
    waypoint_ref: makeOopsRef("correction_waypoint", proposal.proposal_ref, intent),
    frame_ref: "agent_estimated_task_frame",
    position_delta_m: translation,
    rotation_delta_rad: rotation,
    dwell_ms: intent === "reobserve_only" ? 0 : 120,
    evidence_refs: uniqueOopsSorted(proposal.evidence_refs.map(cleanOopsRef)),
  });
}

function validateProposal(request: CorrectionPlanNormalizerRequest, issues: ValidationIssue[]): void {
  if (request.proposal.proposed_intent === "human_review") {
    issues.push(makeOopsIssue("warning", "CorrectionUnsupported", "$.proposal.proposed_intent", "Proposal requests human review instead of executable correction.", "Route to review or repair with a bounded intent."));
  }
  if (request.proposal.proposed_intent === "reobserve_only") {
    issues.push(makeOopsIssue("warning", "EvidenceMissing", "$.proposal.proposed_intent", "Proposal requests reobserve before correction.", "Collect evidence before physical correction."));
  }
  if (request.proposal.correction_vector_m !== undefined && vectorMagnitude(request.proposal.correction_vector_m) > request.safety_limits.max_translation_m * 1.25) {
    issues.push(makeOopsIssue("warning", "SafetyLimitExceeded", "$.proposal.correction_vector_m", "Requested translation exceeds conservative normalization range.", "Clamp motion to safety limits."));
  }
}

function decide(request: CorrectionPlanNormalizerRequest, issues: readonly ValidationIssue[]): CorrectionPlanNormalizationDecision {
  if (issues.some((issue) => issue.severity === "error")) return "rejected";
  if (request.proposal.proposed_intent === "reobserve_only") return "reobserve_required";
  if (request.proposal.proposed_intent === "human_review") return "repair_required";
  return issues.length > 0 || request.proposal.uncertainty_notes.length > 0 ? "normalized_with_warnings" : "normalized";
}

function clampVector(value: Vector3, maxMagnitude: number): Vector3 {
  const magnitude = vectorMagnitude(value);
  if (magnitude <= maxMagnitude || magnitude === 0) return [round6(value[0]), round6(value[1]), round6(value[2])];
  const scale = maxMagnitude / magnitude;
  return [round6(value[0] * scale), round6(value[1] * scale), round6(value[2] * scale)];
}

function defaultVector(intent: CorrectionIntentKind): Vector3 {
  if (intent === "micro_adjust") return [0.012, 0, 0];
  if (intent === "regrasp_and_replace") return [0, 0, 0.02];
  if (intent === "rotate_in_place") return [0, 0, 0];
  if (intent === "reposition_body") return [0.035, 0, 0];
  if (intent === "re_aim_tool") return [0.02, 0.01, 0];
  return [0, 0, 0];
}

function forceFor(intent: CorrectionIntentKind, limits: OopsSafetyLimits): number {
  if (intent === "micro_adjust" || intent === "rotate_in_place") return limits.max_force_n * 0.35;
  if (intent === "re_aim_tool") return limits.allow_tool_contact ? limits.max_force_n * 0.45 : 0;
  return limits.max_force_n * 0.55;
}

function speedFor(intent: CorrectionIntentKind, limits: OopsSafetyLimits): number {
  if (intent === "micro_adjust" || intent === "rotate_in_place") return limits.max_speed_mps * 0.35;
  if (intent === "reposition_body") return limits.max_speed_mps * 0.25;
  return limits.max_speed_mps * 0.45;
}

function durationFor(intent: CorrectionIntentKind): number {
  if (intent === "micro_adjust" || intent === "rotate_in_place") return 1800;
  if (intent === "re_aim_tool") return 2600;
  if (intent === "reposition_body") return 3200;
  return 3800;
}

function stopConditionsFor(intent: CorrectionIntentKind): readonly string[] {
  const common = ["unexpected_force", "target_lost", "view_occluded", "time_limit"];
  if (intent === "re_aim_tool") return [...common, "tool_contact_unclear", "sweep_risk"];
  if (intent === "reposition_body") return [...common, "balance_margin_low"];
  return common;
}
