/**
 * Prompt safety validator for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/18_SAFETY_GUARDRAILS_VALIDATION_AND_POLICY.md`
 * sections 18.5.1, 18.8, 18.13.2, 18.16.1, 18.17, 18.18, and 18.21.
 *
 * Gemini Robotics-ER 1.6 may advise, but prompt and response boundaries are
 * deterministic: hidden truth, unsupported success, unsafe action requests,
 * validator-circumvention language, and TTS disclosure hazards are rejected.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  buildRiskFinding,
  buildValidationReport,
  compactSafetyText,
  containsForbiddenSafetyText,
  freezeArray,
  makeIssue,
  makeSafetyRef,
  uniqueRefs,
  validateRef,
  validateSafeText,
  validateSafetyValidationRequest,
} from "./safety_policy_registry";
import type {
  ActiveSafetyPolicySet,
  SafetyDecisionType,
  SafetyRiskFinding,
  SafetyValidationReport,
  SafetyValidationRequest,
} from "./safety_policy_registry";

export const PROMPT_SAFETY_VALIDATOR_SCHEMA_VERSION = "mebsuta.prompt_safety_validator.v1" as const;

const UNSAFE_ACTION_PATTERN = /(increase force beyond|disable guard|ignore limit|override validator|circumvent validation|move blindly|blind correction|certify from audio|success without certificate|unbounded retry|forceful contact)/i;
const UNSUPPORTED_CERTAINTY_PATTERN = /\b(guaranteed|certain|verified success|confirmed success|must succeed)\b/i;

export interface PromptSegment {
  readonly segment_ref: Ref;
  readonly segment_role: "system_summary" | "developer_summary" | "task_context" | "sensor_context" | "memory_context" | "candidate_response" | "tts_text";
  readonly text: string;
  readonly evidence_refs: readonly Ref[];
  readonly schema_valid?: boolean;
}

export interface PromptSafetyValidationInput {
  readonly validation_request: SafetyValidationRequest;
  readonly active_policy_set: ActiveSafetyPolicySet;
  readonly prompt_segments: readonly PromptSegment[];
  readonly repair_attempt_count: number;
  readonly max_repair_attempts: number;
}

/**
 * Validates prompt and model-response text before it can influence planning.
 */
export class PromptSafetyValidator {
  public validatePromptSafety(input: PromptSafetyValidationInput): SafetyValidationReport {
    const issues: ValidationIssue[] = [...validateSafetyValidationRequest(input.validation_request)];
    const findings: SafetyRiskFinding[] = [];
    const blockedRefs: Ref[] = [];

    for (const [index, segment] of input.prompt_segments.entries()) {
      validateSegment(segment, index, issues);
      const hidden = containsForbiddenSafetyText(segment.text);
      const unsafe = UNSAFE_ACTION_PATTERN.test(segment.text);
      const certainty = UNSUPPORTED_CERTAINTY_PATTERN.test(segment.text) && !segment.evidence_refs.some((ref) => /certificate|verification/i.test(ref));
      const schemaInvalid = segment.schema_valid === false;
      if (hidden || unsafe || certainty || schemaInvalid) {
        blockedRefs.push(segment.segment_ref);
        findings.push(buildRiskFinding({
          risk_finding_ref: makeSafetyRef("risk_finding", input.validation_request.safety_validation_request_ref, segment.segment_ref, "prompt"),
          risk_class: "prompt",
          risk_severity: hidden || unsafe ? "critical" : "high",
          risk_description: describePromptRisk(hidden, unsafe, certainty, schemaInvalid),
          evidence_refs: uniqueRefs([segment.segment_ref, ...segment.evidence_refs]),
          policy_refs: input.active_policy_set.policy_precedence,
          recommended_restriction: input.active_policy_set.default_restrictions,
          recommended_route: schemaInvalid ? "Repair" : "Reject",
        }));
      }
    }

    if (input.repair_attempt_count > input.max_repair_attempts) {
      findings.push(buildRiskFinding({
        risk_finding_ref: makeSafetyRef("risk_finding", input.validation_request.safety_validation_request_ref, "repair_budget"),
        risk_class: "prompt",
        risk_severity: "blocking",
        risk_description: "Prompt repair attempts exceeded deterministic safety budget.",
        evidence_refs: uniqueRefs(input.prompt_segments.map((segment) => segment.segment_ref)),
        policy_refs: input.active_policy_set.policy_precedence,
        recommended_restriction: input.active_policy_set.default_restrictions,
        recommended_route: "HumanReview",
      }));
    }

    const decision = decide(findings, issues);
    return buildValidationReport({
      request_ref: input.validation_request.safety_validation_request_ref,
      validator_ref: "safety_validator:prompt",
      overall_decision: decision,
      risk_findings: findings,
      restriction_set: decision === "accepted" ? freezeArray([]) : input.active_policy_set.default_restrictions,
      rejection_reasons: blockedRefs.length === 0 ? freezeArray([]) : freezeArray([`Blocked prompt segments: ${blockedRefs.join(", ")}.`]),
      required_additional_evidence: decision === "repair_required" ? freezeArray(["Repair structured response fields and rerun prompt safety validation."]) : freezeArray([]),
      safe_alternative_hints: freezeArray(["Ask Gemini Robotics-ER 1.6 for a safer alternative, then revalidate through deterministic policy gates."]),
      audit_refs: uniqueRefs([input.validation_request.artifact_ref, ...blockedRefs, ...input.prompt_segments.flatMap((segment) => segment.evidence_refs)]),
      issues,
    });
  }
}

export function createPromptSafetyValidator(): PromptSafetyValidator {
  return new PromptSafetyValidator();
}

function validateSegment(segment: PromptSegment, index: number, issues: ValidationIssue[]): void {
  const path = `$.prompt_segments[${index}]`;
  validateRef(segment.segment_ref, `${path}.segment_ref`, issues);
  validateSafeText(segment.text, `${path}.text`, true, issues);
  for (const [evidenceIndex, ref] of segment.evidence_refs.entries()) {
    validateRef(ref, `${path}.evidence_refs[${evidenceIndex}]`, issues);
  }
}

function describePromptRisk(hidden: boolean, unsafe: boolean, certainty: boolean, schemaInvalid: boolean): string {
  const parts = [
    hidden ? "restricted provenance text" : undefined,
    unsafe ? "unsafe action or validator-circumvention wording" : undefined,
    certainty ? "unsupported certainty language" : undefined,
    schemaInvalid ? "invalid structured response shape" : undefined,
  ].filter((part): part is string => part !== undefined);
  return compactSafetyText(`Prompt segment failed safety validation due to ${parts.join(", ")}.`);
}

function decide(findings: readonly SafetyRiskFinding[], issues: readonly ValidationIssue[]): SafetyDecisionType {
  if (findings.some((finding) => finding.risk_severity === "critical")) {
    return "safe_hold_required";
  }
  if (findings.some((finding) => finding.recommended_route === "HumanReview")) {
    return "human_review_required";
  }
  if (findings.some((finding) => finding.recommended_route === "Repair")) {
    return "repair_required";
  }
  if (issues.some((issue) => issue.severity === "error") || findings.length > 0) {
    return "rejected_policy_violation";
  }
  return "accepted";
}

export const PROMPT_SAFETY_VALIDATOR_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: PROMPT_SAFETY_VALIDATOR_SCHEMA_VERSION,
  blueprint: "architecture_docs/18_SAFETY_GUARDRAILS_VALIDATION_AND_POLICY.md",
  sections: freezeArray(["18.5.1", "18.8", "18.13.2", "18.16.1", "18.17", "18.18", "18.21"]),
  component: "PromptSafetyValidator",
  determinism_hash: computeDeterminismHash("prompt safety validator alignment"),
});
