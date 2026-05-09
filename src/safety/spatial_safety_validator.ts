/**
 * Spatial safety validator for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/18_SAFETY_GUARDRAILS_VALIDATION_AND_POLICY.md`
 * sections 18.5.1, 18.7, 18.9, 18.15.2, 18.16.1, 18.16.3, 18.17, and 18.21.
 *
 * The validator checks body-relative path samples, workspace bounds, clearance,
 * occlusion, collision-risk estimates, and target relation ambiguity before a
 * plan can enter embodiment or controller admission.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, Vector3 } from "../simulation/world_manifest";
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
  validateVector3,
} from "./safety_policy_registry";
import type {
  ActiveSafetyPolicySet,
  SafetyDecisionType,
  SafetyRiskFinding,
  SafetyValidationReport,
  SafetyValidationRequest,
  WorkspaceBounds,
} from "./safety_policy_registry";

export const SPATIAL_SAFETY_VALIDATOR_SCHEMA_VERSION = "mebsuta.spatial_safety_validator.v1" as const;

export interface SpatialPathSample {
  readonly sample_ref: Ref;
  readonly position_m: Vector3;
  readonly clearance_m: number;
  readonly collision_risk: number;
  readonly visible_to_required_sensors: boolean;
  readonly occlusion_risk: number;
}

export interface SpatialSafetyEnvelope {
  readonly envelope_ref: Ref;
  readonly workspace_bounds: readonly WorkspaceBounds[];
  readonly minimum_clearance_m: number;
  readonly maximum_collision_risk: number;
  readonly maximum_occlusion_risk: number;
  readonly target_uncertainty_m: number;
}

export interface SpatialSafetyValidationInput {
  readonly validation_request: SafetyValidationRequest;
  readonly active_policy_set: ActiveSafetyPolicySet;
  readonly path_samples: readonly SpatialPathSample[];
  readonly envelope: SpatialSafetyEnvelope;
  readonly target_relation_ambiguous: boolean;
}

/**
 * Validates spatial path and target relation safety.
 */
export class SpatialSafetyValidator {
  public validateSpatialSafety(input: SpatialSafetyValidationInput): SafetyValidationReport {
    const issues: ValidationIssue[] = [...validateSafetyValidationRequest(input.validation_request)];
    validateEnvelope(input.envelope, issues);
    const findings: SafetyRiskFinding[] = [];
    for (const [index, sample] of input.path_samples.entries()) {
      validateSample(sample, index, issues);
      findings.push(...findingsForSample(input, sample));
    }
    if (input.path_samples.length === 0) {
      findings.push(finding(input, input.envelope.envelope_ref, "workspace", "blocking", "Spatial validator requires at least one path or target sample.", "Reobserve"));
    }
    if (input.target_relation_ambiguous || input.envelope.target_uncertainty_m > input.envelope.minimum_clearance_m) {
      findings.push(finding(input, input.envelope.envelope_ref, "occlusion", "high", "Target relation is ambiguous relative to spatial safety margins.", "Reobserve"));
    }
    const decision = decide(findings, issues);
    return buildValidationReport({
      request_ref: input.validation_request.safety_validation_request_ref,
      validator_ref: "safety_validator:spatial",
      overall_decision: decision,
      risk_findings: freezeArray(findings),
      restriction_set: decision === "accepted" ? freezeArray([]) : input.active_policy_set.default_restrictions,
      rejection_reasons: findings.filter((item) => item.risk_severity === "critical" || item.risk_severity === "blocking").map((item) => item.risk_description),
      required_additional_evidence: decision === "reobserve_required" ? freezeArray(["Collect a less occluded target view and recompute body-relative path clearance."]) : freezeArray([]),
      safe_alternative_hints: freezeArray(["Use inspection-only motion or replan through a wider clearance corridor."]),
      audit_refs: uniqueRefs([input.envelope.envelope_ref, ...input.path_samples.map((sample) => sample.sample_ref), ...input.validation_request.evidence_refs ?? []]),
      issues,
    });
  }
}

export function createSpatialSafetyValidator(): SpatialSafetyValidator {
  return new SpatialSafetyValidator();
}

function validateEnvelope(envelope: SpatialSafetyEnvelope, issues: ValidationIssue[]): void {
  validateRef(envelope.envelope_ref, "$.envelope.envelope_ref", issues);
  validateFiniteNumber(envelope.minimum_clearance_m, "$.envelope.minimum_clearance_m", 0, undefined, issues);
  validateFiniteNumber(envelope.maximum_collision_risk, "$.envelope.maximum_collision_risk", 0, 1, issues);
  validateFiniteNumber(envelope.maximum_occlusion_risk, "$.envelope.maximum_occlusion_risk", 0, 1, issues);
  validateFiniteNumber(envelope.target_uncertainty_m, "$.envelope.target_uncertainty_m", 0, undefined, issues);
  for (const [index, bounds] of envelope.workspace_bounds.entries()) {
    validateRef(bounds.bounds_ref, `$.envelope.workspace_bounds[${index}].bounds_ref`, issues);
    validateVector3(bounds.min_m, `$.envelope.workspace_bounds[${index}].min_m`, issues);
    validateVector3(bounds.max_m, `$.envelope.workspace_bounds[${index}].max_m`, issues);
  }
}

function validateSample(sample: SpatialPathSample, index: number, issues: ValidationIssue[]): void {
  const path = `$.path_samples[${index}]`;
  validateRef(sample.sample_ref, `${path}.sample_ref`, issues);
  validateVector3(sample.position_m, `${path}.position_m`, issues);
  validateFiniteNumber(sample.clearance_m, `${path}.clearance_m`, 0, undefined, issues);
  validateFiniteNumber(sample.collision_risk, `${path}.collision_risk`, 0, 1, issues);
  validateFiniteNumber(sample.occlusion_risk, `${path}.occlusion_risk`, 0, 1, issues);
}

function findingsForSample(input: SpatialSafetyValidationInput, sample: SpatialPathSample): readonly SafetyRiskFinding[] {
  const findings: SafetyRiskFinding[] = [];
  if (!insideAnyBounds(sample.position_m, input.envelope.workspace_bounds)) {
    findings.push(finding(input, sample.sample_ref, "workspace", "blocking", "Path sample leaves declared workspace bounds.", "SafeHold"));
  }
  if (sample.clearance_m < input.envelope.minimum_clearance_m) {
    findings.push(finding(input, sample.sample_ref, "collision", sample.clearance_m <= 0 ? "critical" : "high", `Path clearance ${round6(sample.clearance_m)} m is below policy minimum.`, sample.clearance_m <= 0 ? "SafeHold" : "Repair"));
  }
  if (sample.collision_risk > input.envelope.maximum_collision_risk) {
    findings.push(finding(input, sample.sample_ref, "collision", sample.collision_risk > 0.85 ? "critical" : "high", `Collision risk ${round6(sample.collision_risk)} exceeds policy threshold.`, "SafeHold"));
  }
  if (!sample.visible_to_required_sensors || sample.occlusion_risk > input.envelope.maximum_occlusion_risk) {
    findings.push(finding(input, sample.sample_ref, "occlusion", "medium", "Required monitoring visibility is insufficient for this spatial sample.", "Reobserve"));
  }
  return freezeArray(findings);
}

function insideAnyBounds(position: Vector3, bounds: readonly WorkspaceBounds[]): boolean {
  if (bounds.length === 0) {
    return true;
  }
  return bounds.some((candidate) =>
    position[0] >= Math.min(candidate.min_m[0], candidate.max_m[0])
    && position[0] <= Math.max(candidate.min_m[0], candidate.max_m[0])
    && position[1] >= Math.min(candidate.min_m[1], candidate.max_m[1])
    && position[1] <= Math.max(candidate.min_m[1], candidate.max_m[1])
    && position[2] >= Math.min(candidate.min_m[2], candidate.max_m[2])
    && position[2] <= Math.max(candidate.min_m[2], candidate.max_m[2]),
  );
}

function finding(input: SpatialSafetyValidationInput, ref: Ref, riskClass: SafetyRiskFinding["risk_class"], severity: SafetyRiskFinding["risk_severity"], description: string, route: SafetyRiskFinding["recommended_route"]): SafetyRiskFinding {
  return buildRiskFinding({
    risk_finding_ref: makeSafetyRef("risk_finding", input.validation_request.safety_validation_request_ref, ref, riskClass),
    risk_class: riskClass,
    risk_severity: severity,
    risk_description: description,
    evidence_refs: uniqueRefs([ref, ...input.validation_request.evidence_refs ?? []]),
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

export function computeMinimumClearance(samples: readonly SpatialPathSample[]): number {
  return samples.length === 0 ? 0 : round6(Math.min(...samples.map((sample) => sample.clearance_m)));
}

export function computeMeanCollisionRisk(samples: readonly SpatialPathSample[]): number {
  return samples.length === 0 ? 0 : round6(samples.reduce((sum, sample) => sum + clamp(sample.collision_risk, 0, 1), 0) / samples.length);
}

export const SPATIAL_SAFETY_VALIDATOR_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: SPATIAL_SAFETY_VALIDATOR_SCHEMA_VERSION,
  blueprint: "architecture_docs/18_SAFETY_GUARDRAILS_VALIDATION_AND_POLICY.md",
  sections: freezeArray(["18.5.1", "18.7", "18.9", "18.15.2", "18.16.1", "18.16.3", "18.17", "18.21"]),
  component: "SpatialSafetyValidator",
  determinism_hash: computeDeterminismHash("spatial safety validator alignment"),
});
