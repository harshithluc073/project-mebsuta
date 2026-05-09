/**
 * Tool subroutine lifecycle manager for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md`
 * sections 12.3, 12.10, 12.11, 12.13, 12.14, 12.15, 12.16, and
 * 12.17.
 *
 * This manager keeps tool routines task-scoped. It creates, retains, expires,
 * or quarantines tool frames based on acquisition evidence, attachment
 * validation, release evidence, task completion, safety events, frame age,
 * visibility, swept-volume authority, and verification outcome.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type {
  Ref,
  ValidationIssue,
  ValidationSeverity,
} from "../simulation/world_manifest";

export const TOOL_SUBROUTINE_LIFECYCLE_MANAGER_SCHEMA_VERSION = "mebsuta.tool_subroutine_lifecycle_manager.v1" as const;

const HIDDEN_TOOL_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|qa_success|qa_label|qa_only|simulator truth|mesh_name|asset_id|benchmark_truth|oracle_pose|direct_actuator|raw_gemini_actuation)/i;

export type ToolSubroutineState = "candidate" | "acquiring" | "attached" | "in_use" | "released" | "expired" | "quarantined";
export type ToolLifecycleDecision = "created" | "retained" | "expired" | "quarantined" | "human_review_required" | "rejected";
export type ToolLifecycleAction = "continue_tool_routine" | "acquire_or_attach" | "expire_tool_frame" | "quarantine_tool_state" | "request_human_review" | "repair_tool_state";
export type ToolExpirationReason = "task_complete" | "released" | "safety_event" | "frame_stale" | "tool_lost" | "attachment_ambiguous" | "verification_complete" | "operator_review";
export type ToolLifecycleIssueCode =
  | "ToolStateInvalid"
  | "ToolEvidenceMissing"
  | "ToolFrameStale"
  | "ToolReleaseAmbiguous"
  | "ToolVisibilityMissing"
  | "ToolSafetyEvent"
  | "HiddenToolLeak";

export interface ToolSubroutineStateSnapshot {
  readonly subroutine_ref: Ref;
  readonly tool_ref: Ref;
  readonly tool_frame_ref?: Ref;
  readonly state: ToolSubroutineState;
  readonly task_ref: Ref;
  readonly attached_at_s?: number;
  readonly updated_at_s: number;
  readonly frame_created_at_s?: number;
  readonly attachment_validated: boolean;
  readonly swept_volume_validated: boolean;
  readonly release_plan_ref?: Ref;
  readonly evidence_refs: readonly Ref[];
}

export interface ToolReleaseEvidence {
  readonly release_evidence_ref: Ref;
  readonly released: boolean;
  readonly contact_cleared: boolean;
  readonly tool_visible: boolean;
  readonly frame_clearance_m?: number;
  readonly confidence: number;
}

export interface ToolTaskState {
  readonly task_ref: Ref;
  readonly task_complete: boolean;
  readonly verification_complete: boolean;
  readonly active_safety_event: boolean;
  readonly human_review_required?: boolean;
}

export interface ToolLifecyclePolicy {
  readonly max_frame_age_s?: number;
  readonly min_release_confidence?: number;
  readonly min_clearance_m?: number;
}

export interface ToolLifecycleRequest {
  readonly request_ref?: Ref;
  readonly tool_state: ToolSubroutineStateSnapshot;
  readonly release_evidence?: ToolReleaseEvidence;
  readonly task_state: ToolTaskState;
  readonly current_time_s: number;
  readonly policy?: ToolLifecyclePolicy;
}

export interface ToolSubroutineLifecycleReport {
  readonly schema_version: typeof TOOL_SUBROUTINE_LIFECYCLE_MANAGER_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md";
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly subroutine_ref: Ref;
  readonly tool_ref: Ref;
  readonly previous_state: ToolSubroutineState;
  readonly next_state: ToolSubroutineState;
  readonly decision: ToolLifecycleDecision;
  readonly recommended_action: ToolLifecycleAction;
  readonly expired_tool_frame_ref?: Ref;
  readonly expiration_reasons: readonly ToolExpirationReason[];
  readonly retained_evidence_refs: readonly Ref[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "tool_subroutine_lifecycle_report";
  readonly determinism_hash: string;
}

interface NormalizedToolPolicy {
  readonly max_frame_age_s: number;
  readonly min_release_confidence: number;
  readonly min_clearance_m: number;
}

/**
 * Manages task-scoped tool frame retention and expiration.
 */
export class ToolSubroutineLifecycleManager {
  /**
   * Determines whether a tool frame should be retained, expired, quarantined,
   * or routed for review.
   */
  public expireToolSubroutine(request: ToolLifecycleRequest): ToolSubroutineLifecycleReport {
    const issues: ValidationIssue[] = [];
    const policy = normalizePolicy(request.policy);
    const requestRef = sanitizeRef(request.request_ref ?? `tool_lifecycle_${computeDeterminismHash({
      subroutine: request.tool_state.subroutine_ref,
      tool: request.tool_state.tool_ref,
      task: request.task_state.task_ref,
    })}`);
    validateRequest(request, policy, issues);
    const reasons = freezeArray(resolveExpirationReasons(request, policy, issues));
    const nextState = nextStateFor(request, reasons, issues);
    const decision = decide(nextState, reasons, issues);
    const retainedEvidence = freezeArray(uniqueSorted([
      ...request.tool_state.evidence_refs,
      request.release_evidence?.release_evidence_ref,
    ].filter((ref): ref is Ref => ref !== undefined).map(sanitizeRef)));
    const base = {
      schema_version: TOOL_SUBROUTINE_LIFECYCLE_MANAGER_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md" as const,
      report_ref: `tool_subroutine_lifecycle_report_${computeDeterminismHash({
        requestRef,
        decision,
        nextState,
        reasons,
      })}`,
      request_ref: requestRef,
      subroutine_ref: sanitizeRef(request.tool_state.subroutine_ref),
      tool_ref: sanitizeRef(request.tool_state.tool_ref),
      previous_state: request.tool_state.state,
      next_state: nextState,
      decision,
      recommended_action: recommend(decision, nextState),
      expired_tool_frame_ref: nextState === "expired" || nextState === "quarantined" ? request.tool_state.tool_frame_ref : undefined,
      expiration_reasons: reasons,
      retained_evidence_refs: retainedEvidence,
      issues: freezeArray(issues),
      ok: decision === "created" || decision === "retained" || decision === "expired",
      cognitive_visibility: "tool_subroutine_lifecycle_report" as const,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }
}

export function createToolSubroutineLifecycleManager(): ToolSubroutineLifecycleManager {
  return new ToolSubroutineLifecycleManager();
}

function resolveExpirationReasons(
  request: ToolLifecycleRequest,
  policy: NormalizedToolPolicy,
  issues: ValidationIssue[],
): readonly ToolExpirationReason[] {
  const reasons: ToolExpirationReason[] = [];
  const frameAge = request.tool_state.frame_created_at_s === undefined ? 0 : request.current_time_s - request.tool_state.frame_created_at_s;
  if (request.task_state.task_complete) reasons.push("task_complete");
  if (request.task_state.verification_complete) reasons.push("verification_complete");
  if (request.task_state.active_safety_event) {
    reasons.push("safety_event");
    issues.push(makeIssue("error", "ToolSafetyEvent", "$.task_state.active_safety_event", "Active safety event requires tool routine expiration or quarantine.", "Stop tool authority and preserve evidence."));
  }
  if (request.task_state.human_review_required === true) reasons.push("operator_review");
  if (request.release_evidence?.released === true) reasons.push("released");
  if (request.tool_state.frame_created_at_s !== undefined && frameAge > policy.max_frame_age_s) {
    reasons.push("frame_stale");
    issues.push(makeIssue("warning", "ToolFrameStale", "$.tool_state.frame_created_at_s", "Tool frame age exceeds lifecycle policy.", "Expire or refresh the task-scoped tool frame."));
  }
  if (request.release_evidence !== undefined && !releaseEvidenceClear(request.release_evidence, policy)) {
    reasons.push("attachment_ambiguous");
    issues.push(makeIssue("warning", "ToolReleaseAmbiguous", "$.release_evidence", "Tool release evidence is ambiguous.", "Collect release view and contact-clearance evidence."));
  }
  if (request.release_evidence !== undefined && !request.release_evidence.tool_visible) {
    reasons.push("tool_lost");
    issues.push(makeIssue("warning", "ToolVisibilityMissing", "$.release_evidence.tool_visible", "Released or active tool is not visible.", "Reobserve before retaining or reusing the tool frame."));
  }
  return freezeArray(uniqueSorted(reasons));
}

function nextStateFor(
  request: ToolLifecycleRequest,
  reasons: readonly ToolExpirationReason[],
  issues: readonly ValidationIssue[],
): ToolSubroutineState {
  if (issues.some((issue) => issue.severity === "error" && issue.code === "HiddenToolLeak")) return "quarantined";
  if (reasons.includes("safety_event") || reasons.includes("tool_lost")) return "quarantined";
  if (reasons.includes("attachment_ambiguous") && request.task_state.human_review_required === true) return "quarantined";
  if (reasons.length > 0 && (request.tool_state.state === "released" || request.release_evidence?.released === true || request.task_state.task_complete || request.task_state.verification_complete)) return "expired";
  if (request.tool_state.state === "candidate" || request.tool_state.state === "acquiring") return request.tool_state.attachment_validated ? "attached" : "acquiring";
  if (request.tool_state.attachment_validated && request.tool_state.swept_volume_validated) return "in_use";
  return request.tool_state.state;
}

function decide(
  nextState: ToolSubroutineState,
  reasons: readonly ToolExpirationReason[],
  issues: readonly ValidationIssue[],
): ToolLifecycleDecision {
  if (issues.some((issue) => issue.severity === "error" && issue.code === "HiddenToolLeak")) return "rejected";
  if (nextState === "quarantined") return "quarantined";
  if (reasons.includes("operator_review")) return "human_review_required";
  if (nextState === "expired") return "expired";
  if (nextState === "attached" && reasons.length === 0) return "created";
  return issues.some((issue) => issue.severity === "error") ? "rejected" : "retained";
}

function recommend(decision: ToolLifecycleDecision, nextState: ToolSubroutineState): ToolLifecycleAction {
  if (decision === "created" || (decision === "retained" && (nextState === "attached" || nextState === "in_use"))) return "continue_tool_routine";
  if (decision === "retained") return "acquire_or_attach";
  if (decision === "expired") return "expire_tool_frame";
  if (decision === "quarantined") return "quarantine_tool_state";
  if (decision === "human_review_required") return "request_human_review";
  return "repair_tool_state";
}

function releaseEvidenceClear(evidence: ToolReleaseEvidence, policy: NormalizedToolPolicy): boolean {
  return evidence.released
    && evidence.contact_cleared
    && evidence.confidence >= policy.min_release_confidence
    && (evidence.frame_clearance_m === undefined || evidence.frame_clearance_m >= policy.min_clearance_m);
}

function validateRequest(request: ToolLifecycleRequest, policy: NormalizedToolPolicy, issues: ValidationIssue[]): void {
  validateRef(request.tool_state.subroutine_ref, "$.tool_state.subroutine_ref", "HiddenToolLeak", issues);
  validateRef(request.tool_state.tool_ref, "$.tool_state.tool_ref", "HiddenToolLeak", issues);
  validateRef(request.task_state.task_ref, "$.task_state.task_ref", "HiddenToolLeak", issues);
  if (request.tool_state.tool_frame_ref !== undefined) validateRef(request.tool_state.tool_frame_ref, "$.tool_state.tool_frame_ref", "HiddenToolLeak", issues);
  if (request.tool_state.release_plan_ref !== undefined) validateRef(request.tool_state.release_plan_ref, "$.tool_state.release_plan_ref", "HiddenToolLeak", issues);
  for (const ref of request.tool_state.evidence_refs) validateRef(ref, "$.tool_state.evidence_refs", "HiddenToolLeak", issues);
  if (!Number.isFinite(request.current_time_s) || request.current_time_s < 0) {
    issues.push(makeIssue("error", "ToolStateInvalid", "$.current_time_s", "Current time must be finite and nonnegative.", "Use monotonic lifecycle time."));
  }
  if (request.tool_state.updated_at_s > request.current_time_s) {
    issues.push(makeIssue("error", "ToolStateInvalid", "$.tool_state.updated_at_s", "Tool state update time cannot be in the future.", "Repair tool lifecycle timestamps."));
  }
  if ((request.tool_state.state === "attached" || request.tool_state.state === "in_use") && request.tool_state.tool_frame_ref === undefined) {
    issues.push(makeIssue("error", "ToolEvidenceMissing", "$.tool_state.tool_frame_ref", "Attached or active tool state requires a task-scoped tool frame.", "Attach a validated tool frame before use."));
  }
  if (request.tool_state.state === "in_use" && !request.tool_state.swept_volume_validated) {
    issues.push(makeIssue("error", "ToolStateInvalid", "$.tool_state.swept_volume_validated", "Tool motion requires swept-volume validation.", "Validate swept volume before retaining tool authority."));
  }
  if (request.release_evidence !== undefined) validateReleaseEvidence(request.release_evidence, policy, issues);
}

function validateReleaseEvidence(
  evidence: ToolReleaseEvidence,
  policy: NormalizedToolPolicy,
  issues: ValidationIssue[],
): void {
  validateRef(evidence.release_evidence_ref, "$.release_evidence.release_evidence_ref", "HiddenToolLeak", issues);
  if (!Number.isFinite(evidence.confidence) || evidence.confidence < 0 || evidence.confidence > 1) {
    issues.push(makeIssue("error", "ToolReleaseAmbiguous", "$.release_evidence.confidence", "Release confidence must be in [0, 1].", "Normalize release confidence."));
  }
  if (evidence.frame_clearance_m !== undefined && (!Number.isFinite(evidence.frame_clearance_m) || evidence.frame_clearance_m < 0)) {
    issues.push(makeIssue("error", "ToolReleaseAmbiguous", "$.release_evidence.frame_clearance_m", "Release clearance must be finite and nonnegative.", "Use calibrated clearance evidence."));
  }
  if (evidence.released && evidence.confidence < policy.min_release_confidence) {
    issues.push(makeIssue("warning", "ToolReleaseAmbiguous", "$.release_evidence.confidence", "Release confidence is below lifecycle policy.", "Collect clearer release evidence before frame expiration."));
  }
}

function normalizePolicy(policy: ToolLifecyclePolicy | undefined): NormalizedToolPolicy {
  return Object.freeze({
    max_frame_age_s: positiveOrDefault(policy?.max_frame_age_s, 2.0),
    min_release_confidence: clamp(policy?.min_release_confidence ?? 0.62, 0, 1),
    min_clearance_m: positiveOrDefault(policy?.min_clearance_m, 0.03),
  });
}

function validateRef(ref: Ref, path: string, code: ToolLifecycleIssueCode, issues: ValidationIssue[]): void {
  if (ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(makeIssue("error", code, path, "Reference must be a non-empty whitespace-free string.", "Use opaque tool lifecycle refs."));
    return;
  }
  if (HIDDEN_TOOL_PATTERN.test(ref)) {
    issues.push(makeIssue("error", "HiddenToolLeak", path, "Reference contains forbidden hidden execution detail.", "Use sensor-derived and task-scoped tool refs only."));
  }
}

function sanitizeRef(ref: Ref): Ref {
  return ref.replace(HIDDEN_TOOL_PATTERN, "hidden-detail").trim();
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value <= 0 ? fallback : value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function uniqueSorted<T extends string>(items: readonly T[]): readonly T[] {
  return freezeArray([...new Set(items)].sort());
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

function makeIssue(
  severity: ValidationSeverity,
  code: ToolLifecycleIssueCode,
  path: string,
  message: string,
  remediation: string,
): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}
