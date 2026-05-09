/**
 * Manipulation failure classifier for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md`
 * sections 12.3, 12.7, 12.8, 12.9, 12.10, 12.11, 12.13, 12.14,
 * 12.15, 12.16, and 12.17.
 *
 * This classifier converts postcondition, contact, verification, visual,
 * audio, residual, and retry evidence into a deterministic File 12 failure
 * category plus an Oops-ready handoff packet. It also enforces changed
 * strategy after repeated failures so correction cannot loop on the identical
 * grasp, placement, release, or tool action.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type {
  Ref,
  ValidationIssue,
  ValidationSeverity,
} from "../simulation/world_manifest";
import type { ContactStateMonitorReport } from "./contact_state_monitor";
import type {
  PrimitiveExecutionOutcome,
  PrimitivePostconditionReport,
} from "./primitive_postcondition_evaluator";
import type { ManipulationVerificationBridgeReport } from "./manipulation_verification_bridge";
import type {
  ManipulationFailureCategory,
  ManipulationFallbackAction,
  ManipulationPrimitiveName,
} from "./manipulation_primitive_catalog";

export const MANIPULATION_FAILURE_CLASSIFIER_SCHEMA_VERSION = "mebsuta.manipulation_failure_classifier.v1" as const;

const HIDDEN_FAILURE_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|qa_success|qa_label|qa_only|simulator truth|mesh_name|asset_id|benchmark_truth|oracle_pose|direct_actuator|raw_gemini_actuation)/i;

export type ManipulationFailureDecision = "failure_classified" | "failure_ambiguous" | "retry_strategy_required" | "human_review_required" | "safe_hold_required" | "rejected";
export type ManipulationFailureAction = "handoff_to_oops" | "collect_more_evidence" | "change_strategy" | "request_human_review" | "safe_hold" | "repair_failure_packet";
export type ManipulationCorrectionClass = "regrasp" | "reobserve" | "reposition" | "nudge" | "tool" | "reduce_force" | "release_recover" | "safe_hold" | "human_review";
export type ManipulationFailureIssueCode =
  | "FailureEvidenceMissing"
  | "FailureEvidenceHidden"
  | "RetryBudgetExceeded"
  | "RepeatedStrategy"
  | "UnsafeFailure"
  | "FailureClassificationAmbiguous";

export interface ManipulationVisualFailureEvidence {
  readonly evidence_ref: Ref;
  readonly subject_ref: Ref;
  readonly visible: boolean;
  readonly confidence: number;
  readonly motion_delta_m?: number;
  readonly deformation_score?: number;
  readonly occlusion_fraction?: number;
}

export interface ManipulationAudioFailureEvidence {
  readonly evidence_ref: Ref;
  readonly cue: "impact" | "drop" | "scrape" | "slip" | "collision" | "ambiguous";
  readonly confidence: number;
}

export interface ManipulationRetryState {
  readonly retry_budget_remaining: number;
  readonly previous_failure_categories: readonly ManipulationFailureCategory[];
  readonly previous_strategy_refs: readonly Ref[];
  readonly current_strategy_ref: Ref;
  readonly strategy_changed: boolean;
}

export interface ManipulationFailureClassificationRequest {
  readonly request_ref?: Ref;
  readonly primitive_result: PrimitiveExecutionOutcome;
  readonly primitive_name?: ManipulationPrimitiveName;
  readonly contact_report?: ContactStateMonitorReport;
  readonly postcondition_report?: PrimitivePostconditionReport;
  readonly verification_report?: ManipulationVerificationBridgeReport;
  readonly visual_evidence: readonly ManipulationVisualFailureEvidence[];
  readonly audio_evidence?: readonly ManipulationAudioFailureEvidence[];
  readonly retry_state: ManipulationRetryState;
  readonly control_telemetry_refs: readonly Ref[];
  readonly residual_report_refs?: readonly Ref[];
  readonly intended_postcondition: string;
  readonly observed_outcome: string;
}

export interface ManipulationOopsHandoffPacket {
  readonly schema_version: typeof MANIPULATION_FAILURE_CLASSIFIER_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md";
  readonly manipulation_failure_ref: Ref;
  readonly failed_primitive_ref: Ref;
  readonly primitive_name?: ManipulationPrimitiveName;
  readonly object_or_tool_ref?: Ref;
  readonly intended_postcondition: string;
  readonly observed_outcome: string;
  readonly contact_timeline_ref?: Ref;
  readonly visual_evidence_refs: readonly Ref[];
  readonly control_telemetry_refs: readonly Ref[];
  readonly residual_report_refs: readonly Ref[];
  readonly retry_budget_state: ManipulationRetryState;
  readonly suggested_correction_class: ManipulationCorrectionClass;
  readonly required_fallback_actions: readonly ManipulationFallbackAction[];
  readonly prompt_safe_summary: string;
  readonly determinism_hash: string;
}

export interface ManipulationFailureReport {
  readonly schema_version: typeof MANIPULATION_FAILURE_CLASSIFIER_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md";
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly decision: ManipulationFailureDecision;
  readonly recommended_action: ManipulationFailureAction;
  readonly failure_category?: ManipulationFailureCategory;
  readonly confidence: number;
  readonly oops_handoff_packet?: ManipulationOopsHandoffPacket;
  readonly evidence_refs: readonly Ref[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "manipulation_failure_report";
  readonly determinism_hash: string;
}

/**
 * Classifies manipulation failure evidence and builds Oops handoff packets.
 */
export class ManipulationFailureClassifier {
  /**
   * Produces a failure taxonomy entry with correction-ready evidence fields.
   */
  public classifyManipulationFailure(request: ManipulationFailureClassificationRequest): ManipulationFailureReport {
    const issues: ValidationIssue[] = [];
    const requestRef = sanitizeRef(request.request_ref ?? `manipulation_failure_${computeDeterminismHash({
      primitive: request.primitive_result.primitive_ref,
      outcome: request.primitive_result.outcome_ref,
      strategy: request.retry_state.current_strategy_ref,
    })}`);
    validateRequest(request, issues);
    const category = chooseCategory(request, issues);
    const confidence = computeConfidence(request, category);
    const decision = decide(request, category, confidence, issues);
    const packet = decision === "failure_classified" || decision === "retry_strategy_required"
      ? buildOopsPacket(request, category ?? "target_lost", confidence)
      : undefined;
    const evidenceRefs = freezeArray(uniqueSorted([
      request.primitive_result.outcome_ref,
      ...request.control_telemetry_refs,
      ...request.visual_evidence.map((evidence) => evidence.evidence_ref),
      ...request.audio_evidence?.map((evidence) => evidence.evidence_ref) ?? [],
      ...request.residual_report_refs ?? [],
      request.contact_report?.report_ref,
      request.postcondition_report?.report_ref,
      request.verification_report?.report_ref,
    ].filter((ref): ref is Ref => ref !== undefined).map(sanitizeRef)));
    const base = {
      schema_version: MANIPULATION_FAILURE_CLASSIFIER_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md" as const,
      report_ref: `manipulation_failure_report_${computeDeterminismHash({
        requestRef,
        decision,
        category,
        confidence,
      })}`,
      request_ref: requestRef,
      decision,
      recommended_action: recommend(decision),
      failure_category: category,
      confidence,
      oops_handoff_packet: packet,
      evidence_refs: evidenceRefs,
      issues: freezeArray(issues),
      ok: packet !== undefined && (decision === "failure_classified" || decision === "retry_strategy_required"),
      cognitive_visibility: "manipulation_failure_report" as const,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }
}

export function createManipulationFailureClassifier(): ManipulationFailureClassifier {
  return new ManipulationFailureClassifier();
}

function chooseCategory(
  request: ManipulationFailureClassificationRequest,
  issues: ValidationIssue[],
): ManipulationFailureCategory | undefined {
  const contactDecision = request.contact_report?.decision;
  const visualDrop = request.visual_evidence.some((evidence) => evidence.visible && (evidence.motion_delta_m ?? 0) >= 0.08 && evidence.confidence >= 0.55);
  const visualCrush = request.visual_evidence.some((evidence) => (evidence.deformation_score ?? 0) >= 0.55 && evidence.confidence >= 0.5);
  const visualOcclusion = request.visual_evidence.some((evidence) => (evidence.occlusion_fraction ?? 0) >= 0.7);
  const audioDrop = (request.audio_evidence ?? []).some((evidence) => evidence.cue === "drop" && evidence.confidence >= 0.55);
  const audioCollision = (request.audio_evidence ?? []).some((evidence) => evidence.cue === "collision" && evidence.confidence >= 0.55);
  if (contactDecision === "crush_risk" || visualCrush) return "crush_risk";
  if (contactDecision === "drop_risk" || visualDrop || audioDrop) return "drop";
  if (contactDecision === "slip_risk") return "slip";
  if (contactDecision === "unexpected_contact" || audioCollision) return "collision";
  if (request.postcondition_report?.decision === "safe_hold_required") return "stability_risk";
  if (request.verification_report?.decision === "correct_required") return "placement_residual";
  if (request.verification_report?.decision === "reobserve_required" || visualOcclusion) return "verification_blocked";
  if (request.primitive_result.execution_status === "timed_out") return "timeout";
  if (request.primitive_result.execution_status === "aborted") return "target_lost";
  if (request.postcondition_report?.decision === "correct_required") return "partial_grasp";
  issues.push(makeIssue("warning", "FailureClassificationAmbiguous", "$.evidence", "Failure evidence does not isolate one category.", "Collect close view, contact timeline, residual, and control telemetry before retry."));
  return undefined;
}

function buildOopsPacket(
  request: ManipulationFailureClassificationRequest,
  category: ManipulationFailureCategory,
  confidence: number,
): ManipulationOopsHandoffPacket {
  const correction = correctionFor(category, request);
  const visualRefs = freezeArray(uniqueSorted(request.visual_evidence.map((evidence) => sanitizeRef(evidence.evidence_ref))));
  const residualRefs = freezeArray(uniqueSorted((request.residual_report_refs ?? request.postcondition_report?.residual_report_refs ?? []).map(sanitizeRef)));
  const base = {
    schema_version: MANIPULATION_FAILURE_CLASSIFIER_SCHEMA_VERSION,
    blueprint_ref: "architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md" as const,
    manipulation_failure_ref: `manipulation_failure_${category}_${computeDeterminismHash({
      outcome: request.primitive_result.outcome_ref,
      category,
      confidence,
    })}`,
    failed_primitive_ref: sanitizeRef(request.primitive_result.primitive_ref),
    primitive_name: request.primitive_name,
    object_or_tool_ref: inferObjectOrToolRef(request),
    intended_postcondition: sanitizeText(request.intended_postcondition),
    observed_outcome: sanitizeText(request.observed_outcome),
    contact_timeline_ref: request.contact_report?.report_ref,
    visual_evidence_refs: visualRefs,
    control_telemetry_refs: freezeArray(uniqueSorted(request.control_telemetry_refs.map(sanitizeRef))),
    residual_report_refs: residualRefs,
    retry_budget_state: Object.freeze({
      ...request.retry_state,
      previous_failure_categories: freezeArray(request.retry_state.previous_failure_categories),
      previous_strategy_refs: freezeArray(request.retry_state.previous_strategy_refs.map(sanitizeRef)),
      current_strategy_ref: sanitizeRef(request.retry_state.current_strategy_ref),
    }),
    suggested_correction_class: correction,
    required_fallback_actions: freezeArray(fallbacksFor(correction, category)),
    prompt_safe_summary: sanitizeText(`${category} classified for ${request.primitive_name ?? request.primitive_result.primitive_ref}; correction ${correction}; confidence ${round6(confidence)}.`),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function decide(
  request: ManipulationFailureClassificationRequest,
  category: ManipulationFailureCategory | undefined,
  confidence: number,
  issues: readonly ValidationIssue[],
): ManipulationFailureDecision {
  if (issues.some((issue) => issue.severity === "error" && issue.code === "FailureEvidenceHidden")) return "rejected";
  if (category === "crush_risk" || category === "collision" || request.postcondition_report?.decision === "safe_hold_required") return "safe_hold_required";
  if (request.retry_state.retry_budget_remaining <= 0) return "human_review_required";
  if (!request.retry_state.strategy_changed && request.retry_state.previous_strategy_refs.includes(request.retry_state.current_strategy_ref)) return "retry_strategy_required";
  if (category === undefined || confidence < 0.45) return "failure_ambiguous";
  return "failure_classified";
}

function computeConfidence(
  request: ManipulationFailureClassificationRequest,
  category: ManipulationFailureCategory | undefined,
): number {
  if (category === undefined) return 0.25;
  let score = 0.35;
  if (request.contact_report !== undefined) score += 0.2;
  if (request.postcondition_report !== undefined) score += 0.12;
  if (request.verification_report !== undefined) score += 0.12;
  if (request.visual_evidence.some((evidence) => evidence.confidence >= 0.55)) score += 0.14;
  if ((request.audio_evidence ?? []).some((evidence) => evidence.confidence >= 0.55)) score += 0.07;
  return round6(Math.min(0.98, score));
}

function correctionFor(
  category: ManipulationFailureCategory,
  request: ManipulationFailureClassificationRequest,
): ManipulationCorrectionClass {
  if (category === "missed_contact" || category === "partial_grasp") return "regrasp";
  if (category === "slip") return "regrasp";
  if (category === "drop") return "release_recover";
  if (category === "crush_risk" || category === "actuator_saturation") return "reduce_force";
  if (category === "placement_residual") return "nudge";
  if (category === "ik_infeasible" || category === "path_blocked") return "reposition";
  if (category === "tool_instability" || category === "tool_frame_stale") return "tool";
  if (category === "verification_blocked" || category === "target_lost" || request.visual_evidence.length === 0) return "reobserve";
  if (category === "collision" || category === "stability_risk") return "safe_hold";
  return request.retry_state.retry_budget_remaining <= 1 ? "human_review" : "reobserve";
}

function fallbacksFor(
  correction: ManipulationCorrectionClass,
  category: ManipulationFailureCategory,
): readonly ManipulationFallbackAction[] {
  if (correction === "regrasp") return freezeArray(["alternate_grasp", "reobserve", "correct"]);
  if (correction === "reobserve") return freezeArray(["reobserve", "alternate_view"]);
  if (correction === "reposition") return freezeArray(["reposition", "reobserve"]);
  if (correction === "tool") return freezeArray(["validate_tool", "correct"]);
  if (correction === "reduce_force") return freezeArray(["reduce_force", "safe_hold"]);
  if (correction === "safe_hold") return freezeArray(["safe_hold"]);
  if (correction === "human_review") return freezeArray(["human_review", "safe_hold"]);
  return category === "placement_residual" ? freezeArray(["correct", "reobserve"]) : freezeArray(["correct"]);
}

function inferObjectOrToolRef(request: ManipulationFailureClassificationRequest): Ref | undefined {
  const visual = request.visual_evidence.find((evidence) => evidence.subject_ref.trim().length > 0);
  return visual === undefined ? undefined : sanitizeRef(visual.subject_ref);
}

function validateRequest(request: ManipulationFailureClassificationRequest, issues: ValidationIssue[]): void {
  validateRef(request.primitive_result.outcome_ref, "$.primitive_result.outcome_ref", "FailureEvidenceHidden", issues);
  validateRef(request.primitive_result.primitive_ref, "$.primitive_result.primitive_ref", "FailureEvidenceHidden", issues);
  validateRef(request.retry_state.current_strategy_ref, "$.retry_state.current_strategy_ref", "FailureEvidenceHidden", issues);
  for (const ref of request.retry_state.previous_strategy_refs) validateRef(ref, "$.retry_state.previous_strategy_refs", "FailureEvidenceHidden", issues);
  for (const ref of request.control_telemetry_refs) validateRef(ref, "$.control_telemetry_refs", "FailureEvidenceHidden", issues);
  for (const ref of request.residual_report_refs ?? []) validateRef(ref, "$.residual_report_refs", "FailureEvidenceHidden", issues);
  for (const evidence of request.visual_evidence) {
    validateRef(evidence.evidence_ref, "$.visual_evidence.evidence_ref", "FailureEvidenceHidden", issues);
    validateRef(evidence.subject_ref, "$.visual_evidence.subject_ref", "FailureEvidenceHidden", issues);
  }
  for (const evidence of request.audio_evidence ?? []) validateRef(evidence.evidence_ref, "$.audio_evidence.evidence_ref", "FailureEvidenceHidden", issues);
  if (request.visual_evidence.length === 0 && request.contact_report === undefined && request.postcondition_report === undefined) {
    issues.push(makeIssue("error", "FailureEvidenceMissing", "$.evidence", "Failure classification requires visual, contact, or postcondition evidence.", "Attach sensor-derived failure evidence before Oops handoff."));
  }
  if (request.retry_state.retry_budget_remaining < 0) {
    issues.push(makeIssue("error", "RetryBudgetExceeded", "$.retry_state.retry_budget_remaining", "Retry budget cannot be negative.", "Repair retry budget accounting."));
  }
  if (!request.retry_state.strategy_changed && request.retry_state.previous_strategy_refs.includes(request.retry_state.current_strategy_ref)) {
    issues.push(makeIssue("warning", "RepeatedStrategy", "$.retry_state.current_strategy_ref", "Current retry repeats a previous strategy.", "Require changed approach, grasp, force, view, tool, or posture before retry."));
  }
  for (const text of [request.intended_postcondition, request.observed_outcome]) {
    if (HIDDEN_FAILURE_PATTERN.test(text)) {
      issues.push(makeIssue("error", "FailureEvidenceHidden", "$.observed_text", "Failure text contains forbidden hidden execution detail.", "Use sensor-derived failure wording only."));
    }
  }
}

function recommend(decision: ManipulationFailureDecision): ManipulationFailureAction {
  if (decision === "failure_classified") return "handoff_to_oops";
  if (decision === "failure_ambiguous") return "collect_more_evidence";
  if (decision === "retry_strategy_required") return "change_strategy";
  if (decision === "human_review_required") return "request_human_review";
  if (decision === "safe_hold_required") return "safe_hold";
  return "repair_failure_packet";
}

function validateRef(ref: Ref, path: string, code: ManipulationFailureIssueCode, issues: ValidationIssue[]): void {
  if (ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(makeIssue("error", code, path, "Reference must be a non-empty whitespace-free string.", "Use opaque failure evidence refs."));
    return;
  }
  if (HIDDEN_FAILURE_PATTERN.test(ref)) {
    issues.push(makeIssue("error", "FailureEvidenceHidden", path, "Reference contains forbidden hidden execution detail.", "Use sensor-derived evidence refs only."));
  }
}

function sanitizeText(text: string): string {
  return text.replace(HIDDEN_FAILURE_PATTERN, "hidden-detail").replace(/\s+/g, " ").trim();
}

function sanitizeRef(ref: Ref): Ref {
  return ref.replace(HIDDEN_FAILURE_PATTERN, "hidden-detail").trim();
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function uniqueSorted<T extends string>(items: readonly T[]): readonly T[] {
  return freezeArray([...new Set(items)].sort());
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

function makeIssue(
  severity: ValidationSeverity,
  code: ManipulationFailureIssueCode,
  path: string,
  message: string,
  remediation: string,
): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}
