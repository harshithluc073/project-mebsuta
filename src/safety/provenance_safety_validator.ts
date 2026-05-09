/**
 * Provenance safety validator for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/18_SAFETY_GUARDRAILS_VALIDATION_AND_POLICY.md`
 * sections 18.2.5, 18.5.1, 18.5.3, 18.5.4, 18.16.1, 18.17, and 18.21.
 *
 * This validator enforces the simulation-blind safety boundary before any
 * prompt, plan, primitive, memory, audio, TTS, or correction artifact can
 * become execution authority.
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
  TruthBoundaryStatus,
} from "./safety_policy_registry";

export const PROVENANCE_SAFETY_VALIDATOR_SCHEMA_VERSION = "mebsuta.provenance_safety_validator.v1" as const;

export interface ProvenanceArtifactField {
  readonly field_ref: Ref;
  readonly field_path: string;
  readonly source_status: TruthBoundaryStatus;
  readonly text_value?: string;
  readonly evidence_refs: readonly Ref[];
}

export interface ProvenanceSafetyValidationInput {
  readonly validation_request: SafetyValidationRequest;
  readonly active_policy_set: ActiveSafetyPolicySet;
  readonly artifact_fields: readonly ProvenanceArtifactField[];
}

/**
 * Blocks hidden simulator truth, QA-only provenance, and unsafe refs.
 */
export class ProvenanceSafetyValidator {
  public validateProvenanceSafety(input: ProvenanceSafetyValidationInput): SafetyValidationReport {
    const issues: ValidationIssue[] = [...validateSafetyValidationRequest(input.validation_request)];
    const findings: SafetyRiskFinding[] = [];
    const rejectedFieldRefs: Ref[] = [];

    for (const [index, field] of input.artifact_fields.entries()) {
      validateField(field, index, issues);
      const hidden = isRejectedStatus(field.source_status) || containsForbiddenSafetyText(field.field_ref) || containsForbiddenSafetyText(field.text_value ?? "");
      if (hidden) {
        rejectedFieldRefs.push(field.field_ref);
        findings.push(buildRiskFinding({
          risk_finding_ref: makeSafetyRef("risk_finding", input.validation_request.safety_validation_request_ref, field.field_ref, "provenance"),
          risk_class: "provenance",
          risk_severity: field.source_status === "blocked" || field.source_status === "qa_only" ? "critical" : "blocking",
          risk_description: `Field ${field.field_path} violates the embodied provenance boundary.`,
          evidence_refs: uniqueRefs([field.field_ref, ...field.evidence_refs]),
          policy_refs: input.active_policy_set.policy_precedence,
          recommended_restriction: input.active_policy_set.default_restrictions,
          recommended_route: "SafeHold",
        }));
      }
    }

    if (input.artifact_fields.length === 0 && input.validation_request.truth_boundary_status !== "embodied_evidence" && input.validation_request.truth_boundary_status !== "validator_output" && input.validation_request.truth_boundary_status !== "policy_config") {
      findings.push(buildRiskFinding({
        risk_finding_ref: makeSafetyRef("risk_finding", input.validation_request.safety_validation_request_ref, "missing_provenance"),
        risk_class: "provenance",
        risk_severity: "blocking",
        risk_description: "Artifact lacks admitted embodied or validator provenance.",
        evidence_refs: uniqueRefs(input.validation_request.evidence_refs ?? []),
        policy_refs: input.active_policy_set.policy_precedence,
        recommended_restriction: input.active_policy_set.default_restrictions,
        recommended_route: "Reject",
      }));
    }

    const decision = decide(input.validation_request.truth_boundary_status, findings, issues);
    const rejectionReasons = rejectedFieldRefs.length > 0
      ? [`Rejected provenance fields: ${rejectedFieldRefs.join(", ")}.`]
      : findings.map((finding) => finding.risk_description);
    return buildValidationReport({
      request_ref: input.validation_request.safety_validation_request_ref,
      validator_ref: "safety_validator:provenance",
      overall_decision: decision,
      risk_findings: freezeArray(findings),
      restriction_set: decision === "accepted" ? freezeArray([]) : input.active_policy_set.default_restrictions,
      rejection_reasons: rejectionReasons,
      required_additional_evidence: decision === "accepted" ? freezeArray([]) : freezeArray(["Provide embodied sensor, policy, or deterministic validator evidence."]),
      safe_alternative_hints: freezeArray(["Reobserve through allowed sensors and rebuild the artifact without hidden or QA-only fields."]),
      audit_refs: uniqueRefs([
        input.validation_request.artifact_ref,
        ...input.active_policy_set.audit_requirements,
        ...input.artifact_fields.flatMap((field) => field.evidence_refs),
      ]),
      issues,
    });
  }
}

export function createProvenanceSafetyValidator(): ProvenanceSafetyValidator {
  return new ProvenanceSafetyValidator();
}

function validateField(field: ProvenanceArtifactField, index: number, issues: ValidationIssue[]): void {
  const path = `$.artifact_fields[${index}]`;
  validateRef(field.field_ref, `${path}.field_ref`, issues);
  validateSafeText(field.field_path, `${path}.field_path`, true, issues);
  if (field.text_value !== undefined) {
    validateSafeText(field.text_value, `${path}.text_value`, false, issues);
  }
  for (const [evidenceIndex, ref] of field.evidence_refs.entries()) {
    validateRef(ref, `${path}.evidence_refs[${evidenceIndex}]`, issues);
  }
}

function isRejectedStatus(status: TruthBoundaryStatus): boolean {
  return status === "qa_only" || status === "blocked";
}

function decide(status: TruthBoundaryStatus, findings: readonly SafetyRiskFinding[], issues: readonly ValidationIssue[]): SafetyDecisionType {
  if (status === "blocked" || status === "qa_only" || findings.some((finding) => finding.risk_severity === "critical")) {
    return "safe_hold_required";
  }
  if (issues.some((issue) => issue.severity === "error") || findings.length > 0) {
    return "rejected_policy_violation";
  }
  return "accepted";
}

export const PROVENANCE_SAFETY_VALIDATOR_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: PROVENANCE_SAFETY_VALIDATOR_SCHEMA_VERSION,
  blueprint: "architecture_docs/18_SAFETY_GUARDRAILS_VALIDATION_AND_POLICY.md",
  sections: freezeArray(["18.2.5", "18.5.1", "18.5.3", "18.5.4", "18.16.1", "18.17", "18.21"]),
  component: "ProvenanceSafetyValidator",
  determinism_hash: computeDeterminismHash(compactSafetyText("provenance safety validator alignment")),
});
