/**
 * Embodiment safety validator for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/18_SAFETY_GUARDRAILS_VALIDATION_AND_POLICY.md`
 * sections 18.5.1, 18.6, 18.7, 18.14, 18.15.2, 18.16.1, 18.17, and 18.21.
 *
 * This validator checks quadruped, humanoid, and generic body-specific reach,
 * balance, posture, joint margin, monitoring, and recovery limits before a
 * plan can proceed to controller execution.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  buildRiskFinding,
  buildValidationReport,
  clamp,
  freezeArray,
  makeSafetyRef,
  round6,
  uniqueRefs,
  validateFiniteNumber,
  validateRef,
  validateSafetyValidationRequest,
  validateSafeText,
} from "./safety_policy_registry";
import type {
  ActiveSafetyPolicySet,
  EmbodimentSafetyKind,
  MotionSafetyProfile,
  SafetyDecisionType,
  SafetyRiskFinding,
  SafetyValidationReport,
  SafetyValidationRequest,
} from "./safety_policy_registry";

export const EMBODIMENT_SAFETY_VALIDATOR_SCHEMA_VERSION = "mebsuta.embodiment_safety_validator.v1" as const;

export interface EmbodimentBodyState {
  readonly body_state_ref: Ref;
  readonly embodiment_kind: EmbodimentSafetyKind;
  readonly posture_summary: string;
  readonly balance_margin: number;
  readonly reach_margin_m: number;
  readonly minimum_joint_margin_rad: number;
  readonly held_object_ref?: Ref;
  readonly required_monitoring_available: boolean;
  readonly hand_or_gripper_occluding_target: boolean;
}

export interface EmbodimentActionIntent {
  readonly action_intent_ref: Ref;
  readonly action_class: "inspect" | "reach" | "grasp" | "place" | "carry" | "tool_use" | "retreat" | "recover";
  readonly requested_motion_profile: MotionSafetyProfile;
  readonly requires_body_reposition: boolean;
  readonly requires_bimanual_coordination?: boolean;
  readonly target_evidence_refs: readonly Ref[];
}

export interface EmbodimentSafetyValidationInput {
  readonly validation_request: SafetyValidationRequest;
  readonly active_policy_set: ActiveSafetyPolicySet;
  readonly action_intent: EmbodimentActionIntent;
  readonly body_state: EmbodimentBodyState;
}

/**
 * Validates body-specific safety before motion admission.
 */
export class EmbodimentSafetyValidator {
  public validateEmbodimentSafety(input: EmbodimentSafetyValidationInput): SafetyValidationReport {
    const issues: ValidationIssue[] = [...validateSafetyValidationRequest(input.validation_request)];
    validateAction(input.action_intent, issues);
    validateBody(input.body_state, issues);
    const findings = buildFindings(input);
    const profile = selectSafeMotionProfile(input.action_intent, input.body_state);
    const decision = decide(findings, issues);
    return buildValidationReport({
      request_ref: input.validation_request.safety_validation_request_ref,
      validator_ref: "safety_validator:embodiment",
      overall_decision: decision,
      risk_findings: findings,
      restriction_set: decision === "accepted" ? freezeArray([]) : input.active_policy_set.default_restrictions,
      rejection_reasons: findings.filter((finding) => finding.risk_severity === "blocking" || finding.risk_severity === "critical").map((finding) => finding.risk_description),
      required_additional_evidence: decision === "reobserve_required" ? freezeArray(["Clear body occlusion or restore required monitoring before movement."]) : freezeArray([]),
      safe_alternative_hints: freezeArray([`Use ${profile} motion profile and revalidate posture before execution.`]),
      audit_refs: uniqueRefs([input.body_state.body_state_ref, input.action_intent.action_intent_ref, ...input.action_intent.target_evidence_refs]),
      issues,
    });
  }

  /**
   * Selects a conservative motion profile from action and body risk context.
   */
  public selectSafeMotionProfile(actionIntent: EmbodimentActionIntent, bodyState: EmbodimentBodyState): MotionSafetyProfile {
    return selectSafeMotionProfile(actionIntent, bodyState);
  }
}

export function createEmbodimentSafetyValidator(): EmbodimentSafetyValidator {
  return new EmbodimentSafetyValidator();
}

function validateAction(action: EmbodimentActionIntent, issues: ValidationIssue[]): void {
  validateRef(action.action_intent_ref, "$.action_intent.action_intent_ref", issues);
  for (const [index, ref] of action.target_evidence_refs.entries()) {
    validateRef(ref, `$.action_intent.target_evidence_refs[${index}]`, issues);
  }
}

function validateBody(body: EmbodimentBodyState, issues: ValidationIssue[]): void {
  validateRef(body.body_state_ref, "$.body_state.body_state_ref", issues);
  validateSafeText(body.posture_summary, "$.body_state.posture_summary", true, issues);
  validateFiniteNumber(body.balance_margin, "$.body_state.balance_margin", 0, 1, issues);
  validateFiniteNumber(body.reach_margin_m, "$.body_state.reach_margin_m", -10, 10, issues);
  validateFiniteNumber(body.minimum_joint_margin_rad, "$.body_state.minimum_joint_margin_rad", 0, undefined, issues);
  if (body.held_object_ref !== undefined) {
    validateRef(body.held_object_ref, "$.body_state.held_object_ref", issues);
  }
}

function buildFindings(input: EmbodimentSafetyValidationInput): readonly SafetyRiskFinding[] {
  const findings: SafetyRiskFinding[] = [];
  const body = input.body_state;
  const action = input.action_intent;
  if (body.balance_margin < 0.18) {
    findings.push(finding(input, "balance", body.balance_margin < 0.08 ? "critical" : "blocking", `Balance margin ${round6(body.balance_margin)} is too low for autonomous motion.`, "SafeHold"));
  }
  if (body.reach_margin_m < 0) {
    findings.push(finding(input, "balance", "high", `Reach margin is negative by ${round6(Math.abs(body.reach_margin_m))} m.`, action.requires_body_reposition ? "Repair" : "Reobserve"));
  }
  if (body.minimum_joint_margin_rad < 0.08) {
    findings.push(finding(input, "balance", "high", "Joint margin is below safe movement threshold.", "Repair"));
  }
  if (!body.required_monitoring_available) {
    findings.push(finding(input, "occlusion", "blocking", "Required body or target monitoring is unavailable.", "SafeHold"));
  }
  if (body.hand_or_gripper_occluding_target && (action.action_class === "place" || action.action_class === "grasp")) {
    findings.push(finding(input, "occlusion", "medium", "Manipulator occludes target relation for contact-sensitive action.", "Reobserve"));
  }
  if (body.embodiment_kind === "quadruped" && action.action_class === "tool_use" && action.requested_motion_profile !== "tool_contact_cautious") {
    findings.push(finding(input, "tool", "high", "Quadruped tool-use requires conservative front-gripper or mouth sweep validation.", "Repair"));
  }
  if (body.embodiment_kind === "humanoid" && action.requires_bimanual_coordination === true && body.hand_or_gripper_occluding_target) {
    findings.push(finding(input, "collision", "high", "Humanoid bimanual action has unobserved hand collision risk.", "Reobserve"));
  }
  return freezeArray(findings);
}

function finding(input: EmbodimentSafetyValidationInput, riskClass: SafetyRiskFinding["risk_class"], severity: SafetyRiskFinding["risk_severity"], description: string, route: SafetyRiskFinding["recommended_route"]): SafetyRiskFinding {
  return buildRiskFinding({
    risk_finding_ref: makeSafetyRef("risk_finding", input.validation_request.safety_validation_request_ref, input.body_state.body_state_ref, riskClass, route),
    risk_class: riskClass,
    risk_severity: severity,
    risk_description: description,
    evidence_refs: uniqueRefs([input.body_state.body_state_ref, input.action_intent.action_intent_ref, ...input.action_intent.target_evidence_refs]),
    policy_refs: input.active_policy_set.policy_precedence,
    recommended_restriction: input.active_policy_set.default_restrictions,
    recommended_route: route,
  });
}

function decide(findings: readonly SafetyRiskFinding[], issues: readonly ValidationIssue[]): SafetyDecisionType {
  if (findings.some((finding) => finding.risk_severity === "critical" || finding.recommended_route === "SafeHold")) {
    return "safe_hold_required";
  }
  if (findings.some((finding) => finding.recommended_route === "Reobserve")) {
    return "reobserve_required";
  }
  if (issues.some((issue) => issue.severity === "error") || findings.some((finding) => finding.recommended_route === "Repair")) {
    return "repair_required";
  }
  return findings.length > 0 ? "accepted_with_restrictions" : "accepted";
}

function selectSafeMotionProfile(actionIntent: EmbodimentActionIntent, bodyState: EmbodimentBodyState): MotionSafetyProfile {
  const risk = 1 - clamp(bodyState.balance_margin, 0, 1);
  if (actionIntent.action_class === "recover" || actionIntent.action_class === "retreat") {
    return "safe_retreat";
  }
  if (!bodyState.required_monitoring_available || risk > 0.82) {
    return "inspection_only";
  }
  if (actionIntent.action_class === "tool_use") {
    return "tool_contact_cautious";
  }
  if (actionIntent.action_class === "grasp") {
    return risk > 0.45 || bodyState.reach_margin_m < 0.04 ? "gentle_grasp" : "normal_grasp";
  }
  if (actionIntent.action_class === "place") {
    return "cautious_place";
  }
  return actionIntent.requires_body_reposition || bodyState.reach_margin_m < 0.02 ? "micro_correction" : actionIntent.requested_motion_profile;
}

export const EMBODIMENT_SAFETY_VALIDATOR_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: EMBODIMENT_SAFETY_VALIDATOR_SCHEMA_VERSION,
  blueprint: "architecture_docs/18_SAFETY_GUARDRAILS_VALIDATION_AND_POLICY.md",
  sections: freezeArray(["18.5.1", "18.6", "18.7", "18.14", "18.15.2", "18.16.1", "18.17", "18.21"]),
  component: "EmbodimentSafetyValidator",
  determinism_hash: computeDeterminismHash("embodiment safety validator alignment"),
});
