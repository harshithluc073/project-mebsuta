/**
 * Gemini correction reasoner for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/14_OOPS_LOOP_CORRECTION_ENGINE.md`
 * sections 14.2, 14.4, 14.9, 14.19.4, 14.20.2, and 14.21.
 *
 * This module builds a prompt-safe diagnosis packet and normalizes a cognitive
 * correction proposal. Gemini may suggest cause and intent, but deterministic
 * validators still own safety, feasibility, and execution.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, Vector3 } from "../simulation/world_manifest";
import {
  OOPS_BLUEPRINT_REF,
  OOPS_HIDDEN_PATTERN,
  cleanOopsRef,
  cleanOopsText,
  freezeOopsArray,
  makeOopsIssue,
  makeOopsRef,
  meanScore,
  uniqueOopsSorted,
  validateOopsRef,
  type CorrectionIntentKind,
} from "./oops_intake_router";
import type { OopsEvidenceBundle } from "./evidence_bundle_builder";
import type { FailureModeReport } from "./failure_mode_classifier";

export const GEMINI_CORRECTION_REASONER_SCHEMA_VERSION = "mebsuta.gemini_correction_reasoner.v1" as const;

export type GeminiCorrectionDecision = "proposal_ready" | "proposal_constrained" | "deterministic_fallback" | "reobserve_required" | "rejected";

export interface CorrectionDiagnosisPromptPacket {
  readonly prompt_packet_ref: Ref;
  readonly model_family: "gemini_robotics_er_1_6";
  readonly evidence_bundle_ref: Ref;
  readonly failure_mode_report_ref: Ref;
  readonly prompt_contract_ref: Ref;
  readonly evidence_refs: readonly Ref[];
  readonly forbidden_content: readonly string[];
  readonly prompt_safe_summary: string;
  readonly determinism_hash: string;
}

export interface CognitiveCorrectionProposal {
  readonly proposal_ref: Ref;
  readonly source_prompt_packet_ref: Ref;
  readonly model_response_ref?: Ref;
  readonly proposed_intent: CorrectionIntentKind;
  readonly cause_hypothesis: string;
  readonly target_object_ref: Ref;
  readonly correction_vector_m?: Vector3;
  readonly rotation_vector_rad?: Vector3;
  readonly contact_point_ref?: Ref;
  readonly evidence_refs: readonly Ref[];
  readonly confidence: number;
  readonly uncertainty_notes: readonly string[];
  readonly safety_notes: readonly string[];
}

export interface GeminiCorrectionReasonerRequest {
  readonly request_ref?: Ref;
  readonly evidence_bundle: OopsEvidenceBundle;
  readonly failure_mode_report: FailureModeReport;
  readonly correction_prompt_contract_ref: Ref;
  readonly model_response_ref?: Ref;
  readonly model_proposal?: CognitiveCorrectionProposal;
  readonly allow_deterministic_fallback: boolean;
}

export interface GeminiCorrectionReasonerReport {
  readonly schema_version: typeof GEMINI_CORRECTION_REASONER_SCHEMA_VERSION;
  readonly blueprint_ref: typeof OOPS_BLUEPRINT_REF;
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly decision: GeminiCorrectionDecision;
  readonly prompt_packet: CorrectionDiagnosisPromptPacket;
  readonly proposal?: CognitiveCorrectionProposal;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "gemini_correction_reasoner_report";
  readonly determinism_hash: string;
}

/**
 * Packages embodied diagnosis context and validates cognitive proposals.
 */
export class GeminiCorrectionReasoner {
  /**
   * Builds or normalizes a correction proposal from embodied evidence.
   */
  public requestGeminiCorrectionProposal(request: GeminiCorrectionReasonerRequest): GeminiCorrectionReasonerReport {
    const issues: ValidationIssue[] = [];
    validateRequest(request, issues);
    const promptPacket = buildPromptPacket(request);
    const proposal = request.model_proposal === undefined
      ? request.allow_deterministic_fallback ? fallbackProposal(request, promptPacket) : undefined
      : normalizeProposal(request.model_proposal, promptPacket, issues);
    const decision = decide(request, proposal, issues);
    const requestRef = cleanOopsRef(request.request_ref ?? makeOopsRef("gemini_correction", request.evidence_bundle.evidence_bundle_ref));
    const base = {
      schema_version: GEMINI_CORRECTION_REASONER_SCHEMA_VERSION,
      blueprint_ref: OOPS_BLUEPRINT_REF,
      report_ref: makeOopsRef("gemini_correction_report", requestRef, decision),
      request_ref: requestRef,
      decision,
      prompt_packet: promptPacket,
      proposal,
      issues: freezeOopsArray(issues),
      ok: proposal !== undefined && (decision === "proposal_ready" || decision === "proposal_constrained" || decision === "deterministic_fallback"),
      cognitive_visibility: "gemini_correction_reasoner_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function createGeminiCorrectionReasoner(): GeminiCorrectionReasoner {
  return new GeminiCorrectionReasoner();
}

function buildPromptPacket(request: GeminiCorrectionReasonerRequest): CorrectionDiagnosisPromptPacket {
  const evidenceRefs = uniqueOopsSorted([
    ...request.evidence_bundle.visual_evidence_refs,
    ...request.evidence_bundle.controller_telemetry_refs,
    ...request.evidence_bundle.spatial_residual_report_refs,
    ...request.evidence_bundle.tactile_contact_refs,
    ...request.evidence_bundle.audio_event_refs,
  ]);
  const packetRef = makeOopsRef("correction_prompt", request.evidence_bundle.evidence_bundle_ref, request.failure_mode_report.primary_failure_mode);
  const base = {
    prompt_packet_ref: packetRef,
    model_family: "gemini_robotics_er_1_6" as const,
    evidence_bundle_ref: request.evidence_bundle.evidence_bundle_ref,
    failure_mode_report_ref: request.failure_mode_report.report_ref,
    prompt_contract_ref: cleanOopsRef(request.correction_prompt_contract_ref),
    evidence_refs: evidenceRefs,
    forbidden_content: freezeOopsArray(["hidden simulator data", "direct motor commands", "training reward wording", "unbounded retries"]),
    prompt_safe_summary: cleanOopsText(`Diagnose ${request.failure_mode_report.primary_failure_mode} from ${evidenceRefs.length} embodied evidence refs.`),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function validateRequest(request: GeminiCorrectionReasonerRequest, issues: ValidationIssue[]): void {
  validateOopsRef(request.correction_prompt_contract_ref, "$.correction_prompt_contract_ref", "HiddenOopsLeak", issues);
  if (request.failure_mode_report.decision === "reobserve_required") {
    issues.push(makeOopsIssue("warning", "EvidenceMissing", "$.failure_mode_report", "Failure classification requests reobserve before cognitive correction.", "Collect stronger embodied evidence."));
  }
  if (request.model_response_ref !== undefined) validateOopsRef(request.model_response_ref, "$.model_response_ref", "HiddenOopsLeak", issues);
}

function normalizeProposal(
  proposal: CognitiveCorrectionProposal,
  promptPacket: CorrectionDiagnosisPromptPacket,
  issues: ValidationIssue[],
): CognitiveCorrectionProposal {
  validateOopsRef(proposal.proposal_ref, "$.proposal.proposal_ref", "HiddenOopsLeak", issues);
  validateOopsRef(proposal.target_object_ref, "$.proposal.target_object_ref", "HiddenOopsLeak", issues);
  for (const ref of proposal.evidence_refs) validateOopsRef(ref, "$.proposal.evidence_refs", "HiddenOopsLeak", issues);
  for (const text of [proposal.cause_hypothesis, ...proposal.uncertainty_notes, ...proposal.safety_notes]) {
    if (OOPS_HIDDEN_PATTERN.test(text)) {
      issues.push(makeOopsIssue("error", "HiddenOopsLeak", "$.proposal", "Correction proposal contains forbidden hidden or learning-only wording.", "Request a prompt-safe repair."));
    }
  }
  return Object.freeze({
    ...proposal,
    proposal_ref: cleanOopsRef(proposal.proposal_ref),
    source_prompt_packet_ref: promptPacket.prompt_packet_ref,
    model_response_ref: proposal.model_response_ref === undefined ? undefined : cleanOopsRef(proposal.model_response_ref),
    cause_hypothesis: cleanOopsText(proposal.cause_hypothesis),
    target_object_ref: cleanOopsRef(proposal.target_object_ref),
    contact_point_ref: proposal.contact_point_ref === undefined ? undefined : cleanOopsRef(proposal.contact_point_ref),
    evidence_refs: uniqueOopsSorted(proposal.evidence_refs.map(cleanOopsRef)),
    confidence: Math.max(0, Math.min(1, proposal.confidence)),
    uncertainty_notes: freezeOopsArray(proposal.uncertainty_notes.map(cleanOopsText)),
    safety_notes: freezeOopsArray(proposal.safety_notes.map(cleanOopsText)),
  });
}

function fallbackProposal(
  request: GeminiCorrectionReasonerRequest,
  promptPacket: CorrectionDiagnosisPromptPacket,
): CognitiveCorrectionProposal {
  const mode = request.failure_mode_report.primary_failure_mode;
  const intent = request.failure_mode_report.preferred_correction_intent;
  const vector = defaultVector(intent);
  return Object.freeze({
    proposal_ref: makeOopsRef("deterministic_correction_proposal", request.evidence_bundle.evidence_bundle_ref, intent),
    source_prompt_packet_ref: promptPacket.prompt_packet_ref,
    proposed_intent: intent,
    cause_hypothesis: cleanOopsText(`Deterministic fallback selected for ${mode} using residual and telemetry evidence.`),
    target_object_ref: request.evidence_bundle.oops_episode_ref,
    correction_vector_m: vector,
    rotation_vector_rad: intent === "rotate_in_place" ? [0, 0, 0.08] as Vector3 : undefined,
    evidence_refs: promptPacket.evidence_refs,
    confidence: meanScore([request.evidence_bundle.confidence, request.failure_mode_report.confidence, 0.62]),
    uncertainty_notes: freezeOopsArray(["Model proposal unavailable; deterministic fallback remains subject to safety and feasibility validation."]),
    safety_notes: freezeOopsArray(["Use conservative force, bounded speed, and post-correction verification."]),
  });
}

function defaultVector(intent: CorrectionIntentKind): Vector3 {
  if (intent === "micro_adjust") return [0.015, 0, 0];
  if (intent === "reposition_body") return [0.04, 0, 0];
  if (intent === "re_aim_tool") return [0.02, 0.01, 0];
  if (intent === "regrasp_and_replace") return [0, 0, 0.025];
  return [0, 0, 0];
}

function decide(
  request: GeminiCorrectionReasonerRequest,
  proposal: CognitiveCorrectionProposal | undefined,
  issues: readonly ValidationIssue[],
): GeminiCorrectionDecision {
  if (issues.some((issue) => issue.severity === "error")) return "rejected";
  if (proposal === undefined) return request.evidence_bundle.missing_evidence_report !== undefined ? "reobserve_required" : "rejected";
  if (request.model_proposal === undefined) return "deterministic_fallback";
  return issues.length > 0 || proposal.uncertainty_notes.length > 0 ? "proposal_constrained" : "proposal_ready";
}
