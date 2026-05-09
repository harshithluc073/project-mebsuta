/**
 * Memory commit gate for Project Mebsuta verification.
 *
 * Blueprint: `architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md`
 * sections 13.2, 13.5, 13.6.9, 13.11.9, 13.16, and 13.22.
 *
 * The gate authorizes episodic spatial memory writes only when verification
 * certificates are strong enough, fresh enough, and clean of hidden truth.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  freezeArray,
  makeIssue,
  makeRef,
  round6,
  sanitizeRef,
  sanitizeText,
  uniqueSorted,
  validateSafeRef,
  type VerificationMemoryPolicy,
} from "./verification_policy_registry";
import type { TaskSuccessCertificate } from "./task_success_certificate_issuer";

export const MEMORY_COMMIT_GATE_SCHEMA_VERSION = "mebsuta.memory_commit_gate.v1" as const;

export type MemoryCommitOutcome = "commit_allowed" | "commit_summary_only" | "commit_after_reobserve" | "commit_denied";

export interface VerifiedSpatialMemoryCandidate {
  readonly candidate_ref: Ref;
  readonly perceived_object_descriptor_ref: Ref;
  readonly estimated_pose_ref?: Ref;
  readonly pose_uncertainty_m?: number;
  readonly visual_description: string;
  readonly landmark_refs: readonly Ref[];
  readonly evidence_timestamp_ms: number;
  readonly evidence_refs: readonly Ref[];
}

export interface MemoryCommitGateRequest {
  readonly request_ref?: Ref;
  readonly certificate?: TaskSuccessCertificate;
  readonly memory_policy: VerificationMemoryPolicy;
  readonly candidates: readonly VerifiedSpatialMemoryCandidate[];
  readonly current_time_ms: number;
  readonly maximum_evidence_age_ms?: number;
}

export interface MemoryCommitDecision {
  readonly candidate_ref: Ref;
  readonly outcome: MemoryCommitOutcome;
  readonly reason: string;
  readonly allowed_memory_refs: readonly Ref[];
  readonly blocked_fields: readonly string[];
}

export interface MemoryCommitGateReport {
  readonly schema_version: typeof MEMORY_COMMIT_GATE_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md";
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly overall_outcome: MemoryCommitOutcome;
  readonly decisions: readonly MemoryCommitDecision[];
  readonly certificate_ref?: Ref;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "memory_commit_gate_report";
  readonly determinism_hash: string;
}

/**
 * Gates verified memory writes from task certificates.
 */
export class MemoryCommitGate {
  /**
   * Authorizes exact memory, summary-only memory, or denial.
   */
  public authorizeMemoryCommit(request: MemoryCommitGateRequest): MemoryCommitGateReport {
    const issues: ValidationIssue[] = [];
    validateRequest(request, issues);
    const decisions = freezeArray(request.candidates.map((candidate) => decideCandidate(request, candidate)));
    const overall = overallOutcome(request, decisions, issues);
    const requestRef = sanitizeRef(request.request_ref ?? makeRef("memory_commit_gate", request.certificate?.certificate_ref ?? "no_certificate"));
    const base = {
      schema_version: MEMORY_COMMIT_GATE_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md" as const,
      report_ref: makeRef("memory_commit_gate_report", requestRef, overall),
      request_ref: requestRef,
      overall_outcome: overall,
      decisions,
      certificate_ref: request.certificate?.certificate_ref,
      issues: freezeArray(issues),
      ok: overall === "commit_allowed" || overall === "commit_summary_only",
      cognitive_visibility: "memory_commit_gate_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function createMemoryCommitGate(): MemoryCommitGate {
  return new MemoryCommitGate();
}

function validateRequest(request: MemoryCommitGateRequest, issues: ValidationIssue[]): void {
  validateSafeRef(request.memory_policy.policy_ref, "$.memory_policy.policy_ref", "HiddenVerificationLeak", issues);
  if (!Number.isFinite(request.current_time_ms) || request.current_time_ms < 0) {
    issues.push(makeIssue("error", "ToleranceInvalid", "$.current_time_ms", "Current time must be finite and nonnegative.", "Use monotonic runtime time."));
  }
  for (const candidate of request.candidates) {
    validateSafeRef(candidate.candidate_ref, "$.candidates.candidate_ref", "HiddenVerificationLeak", issues);
    validateSafeRef(candidate.perceived_object_descriptor_ref, "$.candidates.perceived_object_descriptor_ref", "HiddenVerificationLeak", issues);
    if (candidate.estimated_pose_ref !== undefined) validateSafeRef(candidate.estimated_pose_ref, "$.candidates.estimated_pose_ref", "HiddenVerificationLeak", issues);
    for (const ref of [...candidate.landmark_refs, ...candidate.evidence_refs]) validateSafeRef(ref, "$.candidates.refs", "HiddenVerificationLeak", issues);
  }
}

function decideCandidate(request: MemoryCommitGateRequest, candidate: VerifiedSpatialMemoryCandidate): MemoryCommitDecision {
  const maxAge = request.maximum_evidence_age_ms ?? 6000;
  const age = request.current_time_ms - candidate.evidence_timestamp_ms;
  if (request.certificate === undefined) return decision(candidate, "commit_denied", "No verification certificate is available.", [], ["estimated_pose_ref"]);
  if (request.certificate.result !== "success") {
    return request.memory_policy.allow_summary_on_ambiguity && request.certificate.result === "ambiguous"
      ? decision(candidate, "commit_summary_only", "Ambiguous certificate allows summary-only memory under policy.", [request.certificate.certificate_ref], ["estimated_pose_ref"])
      : decision(candidate, "commit_denied", `Certificate result ${request.certificate.result} blocks exact memory update.`, [], ["estimated_pose_ref", "landmark_refs"]);
  }
  if (request.certificate.confidence < request.memory_policy.minimum_certificate_confidence) {
    return decision(candidate, "commit_after_reobserve", "Certificate confidence is below memory policy.", [request.certificate.certificate_ref], ["estimated_pose_ref"]);
  }
  if (candidate.pose_uncertainty_m === undefined || candidate.pose_uncertainty_m > request.memory_policy.maximum_pose_uncertainty_m) {
    return decision(candidate, "commit_after_reobserve", "Pose uncertainty is too high for memory.", [request.certificate.certificate_ref], ["estimated_pose_ref"]);
  }
  if (age < 0 || age > maxAge) {
    return decision(candidate, "commit_after_reobserve", `Evidence age ${round6(age)}ms is outside the freshness window.`, [request.certificate.certificate_ref], ["estimated_pose_ref"]);
  }
  return decision(candidate, "commit_allowed", "Certificate and candidate satisfy memory policy.", [request.certificate.certificate_ref, ...candidate.evidence_refs], []);
}

function decision(
  candidate: VerifiedSpatialMemoryCandidate,
  outcome: MemoryCommitOutcome,
  reason: string,
  refs: readonly Ref[],
  blockedFields: readonly string[],
): MemoryCommitDecision {
  return Object.freeze({
    candidate_ref: sanitizeRef(candidate.candidate_ref),
    outcome,
    reason: sanitizeText(reason),
    allowed_memory_refs: uniqueSorted(refs.map(sanitizeRef)),
    blocked_fields: freezeArray(blockedFields),
  });
}

function overallOutcome(
  request: MemoryCommitGateRequest,
  decisions: readonly MemoryCommitDecision[],
  issues: readonly ValidationIssue[],
): MemoryCommitOutcome {
  if (issues.some((issue) => issue.severity === "error")) return "commit_denied";
  if (decisions.length === 0) return request.certificate?.result === "success" ? "commit_summary_only" : "commit_denied";
  if (decisions.every((item) => item.outcome === "commit_allowed")) return "commit_allowed";
  if (decisions.some((item) => item.outcome === "commit_after_reobserve")) return "commit_after_reobserve";
  if (decisions.some((item) => item.outcome === "commit_summary_only")) return "commit_summary_only";
  return "commit_denied";
}
