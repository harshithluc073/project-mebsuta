/**
 * Plan safety validator for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/18_SAFETY_GUARDRAILS_VALIDATION_AND_POLICY.md`
 * sections 18.5.1, 18.5.4, 18.7, 18.11, 18.12, 18.13, 18.15.2, 18.16.1, and 18.21.
 *
 * The validator checks high-level plan structure, evidence, stop conditions,
 * retry budgets, memory/audio limitations, and policy restrictions before any
 * plan can proceed toward spatial, embodiment, tool, or controller validation.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  buildRiskFinding,
  buildValidationReport,
  compactSafetyText,
  containsForbiddenSafetyText,
  freezeArray,
  makeSafetyRef,
  uniqueRefs,
  validateRef,
  validateSafeText,
  validateSafetyValidationRequest,
} from "./safety_policy_registry";
import type {
  ActiveSafetyPolicySet,
  MotionSafetyProfile,
  SafetyDecisionType,
  SafetyRestriction,
  SafetyRiskFinding,
  SafetyValidationReport,
  SafetyValidationRequest,
} from "./safety_policy_registry";

export const PLAN_SAFETY_VALIDATOR_SCHEMA_VERSION = "mebsuta.plan_safety_validator.v1" as const;

export interface PlanStepIntent {
  readonly step_ref: Ref;
  readonly action_class: "observe" | "move" | "grasp" | "place" | "push" | "pull" | "carry" | "tool_use" | "verify" | "memory_write" | "tts";
  readonly summary: string;
  readonly evidence_refs: readonly Ref[];
  readonly expected_stop_conditions: readonly string[];
  readonly requested_motion_profile?: MotionSafetyProfile;
  readonly uses_memory_as_current_fact?: boolean;
  readonly uses_audio_as_spatial_proof?: boolean;
}

export interface CandidateSafetyPlan {
  readonly plan_ref: Ref;
  readonly plan_summary: string;
  readonly steps: readonly PlanStepIntent[];
  readonly retry_attempt_index: number;
  readonly max_retry_attempts: number;
  readonly verification_required: boolean;
  readonly memory_write_requested: boolean;
}

export interface PlanSafetyValidationInput {
  readonly validation_request: SafetyValidationRequest;
  readonly active_policy_set: ActiveSafetyPolicySet;
  readonly candidate_plan: CandidateSafetyPlan;
}

/**
 * Validates high-level plans before executable motion admission.
 */
export class PlanSafetyValidator {
  public validatePlanSafety(input: PlanSafetyValidationInput): SafetyValidationReport {
    const issues: ValidationIssue[] = [...validateSafetyValidationRequest(input.validation_request)];
    validatePlan(input.candidate_plan, issues);
    const findings = buildPlanFindings(input, issues);
    const decision = decide(input.candidate_plan, findings, issues);
    const restrictions = decision === "accepted" ? freezeArray([]) : selectRestrictions(input.active_policy_set.default_restrictions, findings);
    return buildValidationReport({
      request_ref: input.validation_request.safety_validation_request_ref,
      validator_ref: "safety_validator:plan",
      overall_decision: decision,
      risk_findings: findings,
      restriction_set: restrictions,
      rejection_reasons: findings.filter((finding) => finding.risk_severity === "blocking" || finding.risk_severity === "critical").map((finding) => finding.risk_description),
      required_additional_evidence: requiredEvidence(input.candidate_plan, findings),
      safe_alternative_hints: freezeArray(["Reobserve ambiguous targets, add explicit stop conditions, and select conservative motion profiles before execution."]),
      audit_refs: uniqueRefs([input.candidate_plan.plan_ref, ...input.candidate_plan.steps.flatMap((step) => step.evidence_refs), ...input.active_policy_set.audit_requirements]),
      issues,
    });
  }
}

export function createPlanSafetyValidator(): PlanSafetyValidator {
  return new PlanSafetyValidator();
}

function validatePlan(plan: CandidateSafetyPlan, issues: ValidationIssue[]): void {
  validateRef(plan.plan_ref, "$.candidate_plan.plan_ref", issues);
  validateSafeText(plan.plan_summary, "$.candidate_plan.plan_summary", true, issues);
  if (plan.steps.length === 0) {
    issues.push({ severity: "error", code: "PlanStepsMissing", path: "$.candidate_plan.steps", message: "Plan requires at least one step.", remediation: "Attach an observe, act, or verify step before validation." });
  }
  if (!Number.isInteger(plan.retry_attempt_index) || plan.retry_attempt_index < 0 || !Number.isInteger(plan.max_retry_attempts) || plan.max_retry_attempts < 0) {
    issues.push({ severity: "error", code: "PlanRetryInvalid", path: "$.candidate_plan.retry_attempt_index", message: "Retry counters must be non-negative integers.", remediation: "Use deterministic retry budget state." });
  }
  for (const [index, step] of plan.steps.entries()) {
    validateRef(step.step_ref, `$.candidate_plan.steps[${index}].step_ref`, issues);
    validateSafeText(step.summary, `$.candidate_plan.steps[${index}].summary`, true, issues);
    for (const [evidenceIndex, ref] of step.evidence_refs.entries()) {
      validateRef(ref, `$.candidate_plan.steps[${index}].evidence_refs[${evidenceIndex}]`, issues);
    }
  }
}

function buildPlanFindings(input: PlanSafetyValidationInput, issues: readonly ValidationIssue[]): readonly SafetyRiskFinding[] {
  const findings: SafetyRiskFinding[] = [];
  const plan = input.candidate_plan;
  for (const step of plan.steps) {
    if (containsForbiddenSafetyText(step.summary)) {
      findings.push(finding(input, step.step_ref, "provenance", "critical", "Plan step contains hidden or restricted safety-boundary wording.", "SafeHold"));
    }
    if (requiresEvidence(step.action_class) && step.evidence_refs.length === 0) {
      findings.push(finding(input, step.step_ref, "prompt", "high", `Plan step ${step.action_class} lacks evidence references.`, "Reobserve"));
    }
    if (requiresStopCondition(step.action_class) && step.expected_stop_conditions.length === 0) {
      findings.push(finding(input, step.step_ref, "force", "high", `Plan step ${step.action_class} lacks explicit stop conditions.`, "Repair"));
    }
    if (step.uses_memory_as_current_fact === true) {
      findings.push(finding(input, step.step_ref, "memory", "blocking", "Plan treats memory as current proof.", "Reobserve"));
    }
    if (step.uses_audio_as_spatial_proof === true) {
      findings.push(finding(input, step.step_ref, "audio", "blocking", "Plan treats audio as spatial proof.", "Reobserve"));
    }
    if (step.action_class === "tool_use" && step.requested_motion_profile !== "tool_contact_cautious") {
      findings.push(finding(input, step.step_ref, "tool", "high", "Tool-use step requires cautious tool-contact motion profile.", "Repair"));
    }
  }
  if (plan.retry_attempt_index >= plan.max_retry_attempts && plan.max_retry_attempts > 0) {
    findings.push(finding(input, plan.plan_ref, "retry", "blocking", "Plan retry budget is exhausted.", "HumanReview"));
  }
  if (plan.memory_write_requested && !plan.verification_required) {
    findings.push(finding(input, plan.plan_ref, "memory", "high", "Memory write request requires verification before durable storage.", "Repair"));
  }
  if (issues.some((issue) => issue.severity === "error")) {
    findings.push(finding(input, plan.plan_ref, "prompt", "high", "Plan request has structural safety errors.", "Repair"));
  }
  return freezeArray(findings);
}

function finding(input: PlanSafetyValidationInput, ref: Ref, riskClass: SafetyRiskFinding["risk_class"], severity: SafetyRiskFinding["risk_severity"], description: string, route: SafetyRiskFinding["recommended_route"]): SafetyRiskFinding {
  return buildRiskFinding({
    risk_finding_ref: makeSafetyRef("risk_finding", input.validation_request.safety_validation_request_ref, ref, riskClass),
    risk_class: riskClass,
    risk_severity: severity,
    risk_description: description,
    evidence_refs: uniqueRefs([ref, ...(input.validation_request.evidence_refs ?? [])]),
    policy_refs: input.active_policy_set.policy_precedence,
    recommended_restriction: input.active_policy_set.default_restrictions,
    recommended_route: route,
  });
}

function decide(plan: CandidateSafetyPlan, findings: readonly SafetyRiskFinding[], issues: readonly ValidationIssue[]): SafetyDecisionType {
  if (findings.some((item) => item.recommended_route === "HumanReview")) {
    return "human_review_required";
  }
  if (findings.some((item) => item.risk_severity === "critical")) {
    return "safe_hold_required";
  }
  if (findings.some((item) => item.recommended_route === "Reobserve")) {
    return "reobserve_required";
  }
  if (issues.some((issue) => issue.severity === "error") || findings.some((item) => item.recommended_route === "Repair")) {
    return "repair_required";
  }
  return findings.length > 0 || plan.retry_attempt_index > 0 ? "accepted_with_restrictions" : "accepted";
}

function requiredEvidence(plan: CandidateSafetyPlan, findings: readonly SafetyRiskFinding[]): readonly string[] {
  const requirements = findings
    .filter((finding) => finding.recommended_route === "Reobserve")
    .map((finding) => `Additional embodied evidence required for ${finding.risk_class}.`);
  if (plan.verification_required) {
    requirements.push("Verification certificate required before success or memory write.");
  }
  return freezeArray(requirements.map(compactSafetyText));
}

function selectRestrictions(restrictions: readonly SafetyRestriction[], findings: readonly SafetyRiskFinding[]): readonly SafetyRestriction[] {
  const classes = new Set(findings.map((finding) => finding.risk_class));
  const selected = restrictions.filter((restriction) => classes.has(restriction.restriction_class as SafetyRiskFinding["risk_class"]) || restriction.restriction_class === "view" || restriction.restriction_class === "retry");
  return selected.length > 0 ? freezeArray(selected) : restrictions;
}

function requiresEvidence(actionClass: PlanStepIntent["action_class"]): boolean {
  return actionClass !== "tts";
}

function requiresStopCondition(actionClass: PlanStepIntent["action_class"]): boolean {
  return actionClass === "move" || actionClass === "grasp" || actionClass === "place" || actionClass === "push" || actionClass === "pull" || actionClass === "carry" || actionClass === "tool_use";
}

export const PLAN_SAFETY_VALIDATOR_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: PLAN_SAFETY_VALIDATOR_SCHEMA_VERSION,
  blueprint: "architecture_docs/18_SAFETY_GUARDRAILS_VALIDATION_AND_POLICY.md",
  sections: freezeArray(["18.5.1", "18.5.4", "18.7", "18.11", "18.12", "18.13", "18.15.2", "18.16.1", "18.21"]),
  component: "PlanSafetyValidator",
  determinism_hash: computeDeterminismHash("plan safety validator alignment"),
});
