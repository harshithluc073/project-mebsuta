/**
 * Visual verification adapter for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md`
 * sections 13.2, 13.4, 13.5, 13.6.5, 13.10.8, 13.11.3, and 13.12.
 *
 * The adapter creates and validates a Gemini Robotics ER visual assessment
 * contract using only embodied evidence refs, prompt-visible constraints, and
 * uncertainty notes. It keeps final authority with deterministic verifiers.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  freezeArray,
  HIDDEN_VERIFICATION_PATTERN,
  makeIssue,
  makeRef,
  sanitizeRef,
  sanitizeText,
  scaleConfidence,
  uniqueSorted,
  validateSafeRef,
  type VerificationCriterionStatus,
  type VerificationPolicy,
  type VerificationRequest,
} from "./verification_policy_registry";
import type { ViewSufficiencyReport } from "./view_sufficiency_evaluator";

export const VISUAL_VERIFICATION_ADAPTER_SCHEMA_VERSION = "mebsuta.visual_verification_adapter.v1" as const;

export type VisualVerificationDecision = "assessment_ready" | "assessment_with_warnings" | "ambiguous" | "unavailable" | "rejected";
export type VisualVerificationAction = "use_assessment" | "use_with_deterministic_guard" | "reobserve" | "continue_without_model" | "repair_assessment";

export interface VisualVerificationPromptPacket {
  readonly prompt_packet_ref: Ref;
  readonly model_family: "gemini_robotics_er_1_6";
  readonly prompt_contract_ref: Ref;
  readonly task_ref: Ref;
  readonly constraint_refs: readonly Ref[];
  readonly evidence_refs: readonly Ref[];
  readonly forbidden_content: readonly string[];
  readonly prompt_safe_summary: string;
  readonly determinism_hash: string;
}

export interface VisualConstraintAssessment {
  readonly constraint_ref: Ref;
  readonly status: VerificationCriterionStatus;
  readonly confidence: number;
  readonly evidence_refs: readonly Ref[];
  readonly qualitative_residual?: string;
  readonly ambiguity_reason?: string;
}

export interface VisualVerificationAssessment {
  readonly schema_version: typeof VISUAL_VERIFICATION_ADAPTER_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md";
  readonly assessment_ref: Ref;
  readonly prompt_packet_ref: Ref;
  readonly model_response_ref?: Ref;
  readonly model_status: "completed" | "timeout" | "contract_rejected" | "not_invoked";
  readonly constraint_assessments: readonly VisualConstraintAssessment[];
  readonly overall_status: VerificationCriterionStatus;
  readonly confidence: number;
  readonly recommended_new_evidence: readonly string[];
  readonly prompt_safe_summary: string;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "visual_verification_assessment";
  readonly determinism_hash: string;
}

export interface VisualVerificationAdapterRequest {
  readonly request_ref?: Ref;
  readonly verification_request: VerificationRequest;
  readonly policy: VerificationPolicy;
  readonly sufficiency_report: ViewSufficiencyReport;
  readonly model_response_ref?: Ref;
  readonly model_status?: VisualVerificationAssessment["model_status"];
  readonly model_constraint_assessments?: readonly VisualConstraintAssessment[];
}

export interface VisualVerificationAdapterReport {
  readonly schema_version: typeof VISUAL_VERIFICATION_ADAPTER_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md";
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly decision: VisualVerificationDecision;
  readonly recommended_action: VisualVerificationAction;
  readonly prompt_packet: VisualVerificationPromptPacket;
  readonly assessment: VisualVerificationAssessment;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "visual_verification_adapter_report";
  readonly determinism_hash: string;
}

/**
 * Packages and validates prompt-visible visual verification results.
 */
export class VisualVerificationAdapter {
  /**
   * Creates a prompt packet and normalizes the visual assessment.
   */
  public prepareVisualVerification(request: VisualVerificationAdapterRequest): VisualVerificationAdapterReport {
    const issues: ValidationIssue[] = [];
    validateRequest(request, issues);
    const requestRef = sanitizeRef(request.request_ref ?? makeRef("visual_verification", request.verification_request.verification_request_ref));
    const promptPacket = buildPromptPacket(request);
    const assessment = buildAssessment(request, promptPacket, issues);
    const decision = decide(request, assessment, issues);
    const base = {
      schema_version: VISUAL_VERIFICATION_ADAPTER_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md" as const,
      report_ref: makeRef("visual_verification_adapter_report", requestRef, decision),
      request_ref: requestRef,
      decision,
      recommended_action: recommend(decision),
      prompt_packet: promptPacket,
      assessment,
      issues: freezeArray(issues),
      ok: decision === "assessment_ready" || decision === "assessment_with_warnings",
      cognitive_visibility: "visual_verification_adapter_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function createVisualVerificationAdapter(): VisualVerificationAdapter {
  return new VisualVerificationAdapter();
}

function buildPromptPacket(request: VisualVerificationAdapterRequest): VisualVerificationPromptPacket {
  const evidenceRefs = uniqueSorted([
    ...request.sufficiency_report.evidence_refs,
    ...request.verification_request.target_object_descriptor.perceived_feature_refs,
    ...request.verification_request.expected_postcondition_refs,
  ]);
  const promptPacketRef = makeRef("visual_verification_prompt", request.verification_request.verification_request_ref, request.policy.policy_ref);
  const base = {
    prompt_packet_ref: promptPacketRef,
    model_family: "gemini_robotics_er_1_6" as const,
    prompt_contract_ref: makeRef("visual_verification_contract", request.policy.policy_ref),
    task_ref: sanitizeRef(request.verification_request.task_ref),
    constraint_refs: freezeArray(request.policy.required_constraints.map((constraint) => sanitizeRef(constraint.constraint_ref)).sort()),
    evidence_refs: evidenceRefs,
    forbidden_content: freezeArray(["backend identifiers", "QA truth", "exact simulator pose", "hidden scene graph state"]),
    prompt_safe_summary: sanitizeText(`Verify ${request.verification_request.target_object_descriptor.label} using ${evidenceRefs.length} embodied evidence refs and ${request.policy.required_constraints.length} constraints.`),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function buildAssessment(
  request: VisualVerificationAdapterRequest,
  promptPacket: VisualVerificationPromptPacket,
  issues: ValidationIssue[],
): VisualVerificationAssessment {
  const modelStatus = request.model_status ?? (request.sufficiency_report.ok ? "not_invoked" : "contract_rejected");
  const normalized = request.model_constraint_assessments === undefined
    ? defaultAssessments(request)
    : request.model_constraint_assessments.map((assessment, index) => normalizeAssessment(assessment, index, issues));
  const overall = summarizeStatus(normalized, modelStatus);
  const confidence = modelStatus === "completed"
    ? scaleConfidence(...normalized.map((assessment) => assessment.confidence), request.sufficiency_report.confidence)
    : scaleConfidence(request.sufficiency_report.confidence, modelStatus === "not_invoked" ? 0.62 : 0.25);
  const newEvidence = uniqueSorted([
    ...request.sufficiency_report.required_new_views,
    ...normalized.flatMap((assessment) => assessment.status === "ambiguous" || assessment.status === "cannot_assess" ? [assessment.ambiguity_reason ?? "additional embodied view"] : []),
  ].map(sanitizeText));
  const base = {
    schema_version: VISUAL_VERIFICATION_ADAPTER_SCHEMA_VERSION,
    blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md" as const,
    assessment_ref: makeRef("visual_verification_assessment", promptPacket.prompt_packet_ref, overall),
    prompt_packet_ref: promptPacket.prompt_packet_ref,
    model_response_ref: request.model_response_ref === undefined ? undefined : sanitizeRef(request.model_response_ref),
    model_status: modelStatus,
    constraint_assessments: freezeArray(normalized),
    overall_status: overall,
    confidence,
    recommended_new_evidence: newEvidence,
    prompt_safe_summary: sanitizeText(`Visual assessment ${overall} with confidence ${confidence.toFixed(3)}.`),
    issues: freezeArray(issues),
    ok: modelStatus === "completed" || modelStatus === "not_invoked",
    cognitive_visibility: "visual_verification_assessment" as const,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function defaultAssessments(request: VisualVerificationAdapterRequest): readonly VisualConstraintAssessment[] {
  return freezeArray(request.policy.required_constraints.map((constraint) => {
    const sufficiency = request.sufficiency_report.constraint_results.find((result) => result.constraint_ref === constraint.constraint_ref);
    const status: VerificationCriterionStatus = sufficiency === undefined || sufficiency.evidence_strength === "missing"
      ? "cannot_assess"
      : sufficiency.status === "sufficient" ? "satisfied" : "ambiguous";
    return Object.freeze({
      constraint_ref: constraint.constraint_ref,
      status,
      confidence: sufficiency?.confidence ?? 0,
      evidence_refs: sufficiency?.available_view_refs ?? constraint.evidence_refs,
      qualitative_residual: status === "satisfied" ? "Visual relation appears consistent with the requested task constraint." : undefined,
      ambiguity_reason: status === "satisfied" ? undefined : "Visual evidence is not strong enough for final deterministic certification.",
    });
  }));
}

function normalizeAssessment(assessment: VisualConstraintAssessment, index: number, issues: ValidationIssue[]): VisualConstraintAssessment {
  validateSafeRef(assessment.constraint_ref, `$.model_constraint_assessments[${index}].constraint_ref`, "HiddenVerificationLeak", issues);
  for (const ref of assessment.evidence_refs) validateSafeRef(ref, `$.model_constraint_assessments[${index}].evidence_refs`, "HiddenVerificationLeak", issues);
  for (const text of [assessment.qualitative_residual, assessment.ambiguity_reason]) {
    if (text !== undefined && HIDDEN_VERIFICATION_PATTERN.test(text)) {
      issues.push(makeIssue("error", "HiddenVerificationLeak", `$.model_constraint_assessments[${index}]`, "Visual assessment contains hidden simulator wording.", "Keep assessment grounded in embodied evidence."));
    }
  }
  return Object.freeze({
    constraint_ref: sanitizeRef(assessment.constraint_ref),
    status: assessment.status,
    confidence: Math.max(0, Math.min(1, assessment.confidence)),
    evidence_refs: uniqueSorted(assessment.evidence_refs.map(sanitizeRef)),
    qualitative_residual: assessment.qualitative_residual === undefined ? undefined : sanitizeText(assessment.qualitative_residual),
    ambiguity_reason: assessment.ambiguity_reason === undefined ? undefined : sanitizeText(assessment.ambiguity_reason),
  });
}

function validateRequest(request: VisualVerificationAdapterRequest, issues: ValidationIssue[]): void {
  if (request.model_response_ref !== undefined) validateSafeRef(request.model_response_ref, "$.model_response_ref", "HiddenVerificationLeak", issues);
  if (request.sufficiency_report.decision === "rejected") {
    issues.push(makeIssue("error", "ViewPolicyMissing", "$.sufficiency_report", "Rejected sufficiency reports cannot be sent to visual assessment.", "Repair embodied evidence before visual verification."));
  }
}

function summarizeStatus(
  assessments: readonly VisualConstraintAssessment[],
  modelStatus: VisualVerificationAssessment["model_status"],
): VerificationCriterionStatus {
  if (modelStatus === "timeout" || modelStatus === "contract_rejected") return "cannot_assess";
  if (assessments.some((assessment) => assessment.status === "failed")) return "failed";
  if (assessments.some((assessment) => assessment.status === "ambiguous" || assessment.status === "cannot_assess")) return "ambiguous";
  return "satisfied";
}

function decide(
  request: VisualVerificationAdapterRequest,
  assessment: VisualVerificationAssessment,
  issues: readonly ValidationIssue[],
): VisualVerificationDecision {
  if (issues.some((issue) => issue.severity === "error")) return "rejected";
  if (assessment.model_status === "timeout") return "unavailable";
  if (assessment.overall_status === "ambiguous" || assessment.overall_status === "cannot_assess" || !request.sufficiency_report.ok) return "ambiguous";
  return issues.length > 0 || assessment.model_status === "not_invoked" ? "assessment_with_warnings" : "assessment_ready";
}

function recommend(decision: VisualVerificationDecision): VisualVerificationAction {
  if (decision === "assessment_ready") return "use_assessment";
  if (decision === "assessment_with_warnings") return "use_with_deterministic_guard";
  if (decision === "ambiguous") return "reobserve";
  if (decision === "unavailable") return "continue_without_model";
  return "repair_assessment";
}
