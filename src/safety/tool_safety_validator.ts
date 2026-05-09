/**
 * Tool safety validator for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/18_SAFETY_GUARDRAILS_VALIDATION_AND_POLICY.md`
 * sections 18.4, 18.5.1, 18.7, 18.10, 18.12, 18.15.2, 18.16.4, 18.17, and 18.21.
 *
 * The validator checks tool identity, attachment, swept volume, contact force,
 * leverage, occlusion, and correction retry posture before tool-use plans can
 * reach controller execution.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  buildRiskFinding,
  buildValidationReport,
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
  SafetyDecisionType,
  SafetyRiskFinding,
  SafetyValidationReport,
  SafetyValidationRequest,
  ToolEnvelopeLimit,
} from "./safety_policy_registry";

export const TOOL_SAFETY_VALIDATOR_SCHEMA_VERSION = "mebsuta.tool_safety_validator.v1" as const;

export interface ToolUseIntent {
  readonly tool_intent_ref: Ref;
  readonly tool_ref: Ref;
  readonly contact_point_ref?: Ref;
  readonly intended_action: "push" | "pull" | "hook" | "scoop" | "probe" | "stabilize";
  readonly summary: string;
  readonly evidence_refs: readonly Ref[];
}

export interface ToolSweepEstimate {
  readonly sweep_ref: Ref;
  readonly swept_radius_m: number;
  readonly expected_contact_force_n: number;
  readonly leverage_ratio: number;
  readonly path_visible: boolean;
  readonly obstacle_clearance_m: number;
  readonly attachment_validated: boolean;
  readonly tool_identity_confidence: number;
}

export interface ToolSafetyValidationInput {
  readonly validation_request: SafetyValidationRequest;
  readonly active_policy_set: ActiveSafetyPolicySet;
  readonly tool_intent: ToolUseIntent;
  readonly sweep_estimate: ToolSweepEstimate;
  readonly envelope_override?: ToolEnvelopeLimit;
}

/**
 * Validates tool-use safety envelopes and attachment confidence.
 */
export class ToolSafetyValidator {
  public validateToolSafety(input: ToolSafetyValidationInput): SafetyValidationReport {
    const issues: ValidationIssue[] = [...validateSafetyValidationRequest(input.validation_request)];
    validateToolIntent(input.tool_intent, issues);
    validateSweep(input.sweep_estimate, issues);
    const envelope = input.envelope_override ?? input.active_policy_set.tool_envelope_limits[0] ?? defaultEnvelope(input.tool_intent.tool_ref);
    const findings = buildFindings(input, envelope);
    const decision = decide(findings, issues);
    return buildValidationReport({
      request_ref: input.validation_request.safety_validation_request_ref,
      validator_ref: "safety_validator:tool",
      overall_decision: decision,
      risk_findings: findings,
      restriction_set: decision === "accepted" ? freezeArray([]) : input.active_policy_set.default_restrictions,
      rejection_reasons: findings.filter((finding) => finding.risk_severity === "critical" || finding.risk_severity === "blocking").map((finding) => finding.risk_description),
      required_additional_evidence: decision === "reobserve_required" ? freezeArray(["Confirm tool identity, contact point, and visible swept path."]) : freezeArray([]),
      safe_alternative_hints: freezeArray(["Use a shorter sweep, lower force, or non-tool correction route."]),
      audit_refs: uniqueRefs([input.tool_intent.tool_intent_ref, input.tool_intent.tool_ref, input.sweep_estimate.sweep_ref, ...input.tool_intent.evidence_refs]),
      issues,
    });
  }
}

export function createToolSafetyValidator(): ToolSafetyValidator {
  return new ToolSafetyValidator();
}

function validateToolIntent(intent: ToolUseIntent, issues: ValidationIssue[]): void {
  validateRef(intent.tool_intent_ref, "$.tool_intent.tool_intent_ref", issues);
  validateRef(intent.tool_ref, "$.tool_intent.tool_ref", issues);
  validateSafeText(intent.summary, "$.tool_intent.summary", true, issues);
  if (intent.contact_point_ref !== undefined) {
    validateRef(intent.contact_point_ref, "$.tool_intent.contact_point_ref", issues);
  }
  for (const [index, ref] of intent.evidence_refs.entries()) {
    validateRef(ref, `$.tool_intent.evidence_refs[${index}]`, issues);
  }
}

function validateSweep(sweep: ToolSweepEstimate, issues: ValidationIssue[]): void {
  validateRef(sweep.sweep_ref, "$.sweep_estimate.sweep_ref", issues);
  validateFiniteNumber(sweep.swept_radius_m, "$.sweep_estimate.swept_radius_m", 0, undefined, issues);
  validateFiniteNumber(sweep.expected_contact_force_n, "$.sweep_estimate.expected_contact_force_n", 0, undefined, issues);
  validateFiniteNumber(sweep.leverage_ratio, "$.sweep_estimate.leverage_ratio", 0, undefined, issues);
  validateFiniteNumber(sweep.obstacle_clearance_m, "$.sweep_estimate.obstacle_clearance_m", 0, undefined, issues);
  validateFiniteNumber(sweep.tool_identity_confidence, "$.sweep_estimate.tool_identity_confidence", 0, 1, issues);
}

function buildFindings(input: ToolSafetyValidationInput, envelope: ToolEnvelopeLimit): readonly SafetyRiskFinding[] {
  const findings: SafetyRiskFinding[] = [];
  const sweep = input.sweep_estimate;
  if (!sweep.attachment_validated) {
    findings.push(finding(input, "tool", "blocking", "Tool attachment has not been validated.", "Reobserve"));
  }
  if (sweep.tool_identity_confidence < 0.72) {
    findings.push(finding(input, "tool", "high", "Tool identity confidence is below the safety threshold.", "Reobserve"));
  }
  if (sweep.swept_radius_m > envelope.max_sweep_radius_m) {
    findings.push(finding(input, "tool", "high", `Tool swept radius ${round6(sweep.swept_radius_m)} m exceeds policy envelope.`, "Repair"));
  }
  if (sweep.expected_contact_force_n > envelope.max_contact_force_n) {
    findings.push(finding(input, "force", sweep.expected_contact_force_n > envelope.max_contact_force_n * 1.8 ? "critical" : "high", "Tool contact force exceeds conservative envelope.", "SafeHold"));
  }
  if (sweep.leverage_ratio > envelope.max_leverage_ratio) {
    findings.push(finding(input, "tool", "high", "Tool leverage ratio exceeds allowed control envelope.", "Repair"));
  }
  if (envelope.require_line_of_sight && !sweep.path_visible) {
    findings.push(finding(input, "occlusion", "blocking", "Tool swept path is not visible to required sensors.", "Reobserve"));
  }
  if (sweep.obstacle_clearance_m < 0.03) {
    findings.push(finding(input, "collision", "blocking", "Tool path clearance is too small for autonomous sweep.", "SafeHold"));
  }
  return freezeArray(findings);
}

function finding(input: ToolSafetyValidationInput, riskClass: SafetyRiskFinding["risk_class"], severity: SafetyRiskFinding["risk_severity"], description: string, route: SafetyRiskFinding["recommended_route"]): SafetyRiskFinding {
  return buildRiskFinding({
    risk_finding_ref: makeSafetyRef("risk_finding", input.validation_request.safety_validation_request_ref, input.tool_intent.tool_ref, riskClass, route),
    risk_class: riskClass,
    risk_severity: severity,
    risk_description: description,
    evidence_refs: uniqueRefs([input.tool_intent.tool_intent_ref, input.sweep_estimate.sweep_ref, ...input.tool_intent.evidence_refs]),
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

function defaultEnvelope(toolRef: Ref): ToolEnvelopeLimit {
  return Object.freeze({
    tool_envelope_ref: makeSafetyRef("tool_envelope", toolRef, "default"),
    max_sweep_radius_m: 0.45,
    max_contact_force_n: 10,
    max_leverage_ratio: 1.5,
    require_line_of_sight: true,
  });
}

export const TOOL_SAFETY_VALIDATOR_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: TOOL_SAFETY_VALIDATOR_SCHEMA_VERSION,
  blueprint: "architecture_docs/18_SAFETY_GUARDRAILS_VALIDATION_AND_POLICY.md",
  sections: freezeArray(["18.4", "18.5.1", "18.7", "18.10", "18.12", "18.15.2", "18.16.4", "18.17", "18.21"]),
  component: "ToolSafetyValidator",
  determinism_hash: computeDeterminismHash("tool safety validator alignment"),
});
