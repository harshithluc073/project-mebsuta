/**
 * Structured observability event emitter for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/17_INTERNAL_MONOLOGUE_TTS_OBSERVABILITY.md`
 * sections 17.4, 17.6, 17.7, 17.13, 17.14, 17.15, 17.16, 17.18, and 17.19.
 *
 * This module owns the shared File 17 data contracts and deterministic helper
 * routines used by the internal monologue, TTS, dashboard, replay, retention,
 * and annotation components. It normalizes subsystem artifacts into
 * simulation-blind, replayable timeline records and validates every emitted
 * record before it can feed spoken narration or operator dashboards.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";

export const OBSERVABILITY_SCHEMA_VERSION = "mebsuta.observability.v1" as const;
export const OBSERVABILITY_BLUEPRINT_REF = "architecture_docs/17_INTERNAL_MONOLOGUE_TTS_OBSERVABILITY.md" as const;

const MAX_SUMMARY_CHARS = 900;
const MAX_MESSAGE_CHARS = 260;
const MAX_OPERATOR_NOTE_CHARS = 1_200;
const FORBIDDEN_RUNTIME_TEXT_PATTERN = /(backend|ground[_ -]?truth|hidden[_ -]?state|hidden[_ -]?pose|oracle|scene[_ -]?graph|object[_ -]?id|rigid[_ -]?body|physics[_ -]?body|collision[_ -]?mesh|qa[_ -]?label|system prompt|developer prompt|chain[_ -]?of[_ -]?thought|scratchpad|private deliberation|raw prompt|raw model|guarantee success|skip validation|override safety|ignore safety)/i;
const PROMPT_INTERNAL_PATTERN = /(system prompt|developer prompt|raw prompt|chain[_ -]?of[_ -]?thought|scratchpad|private deliberation|hidden instruction)/i;
const SUCCESS_CERTAINTY_PATTERN = /\b(verified|confirmed|complete|success|succeeded|passed)\b/i;

export type ObservabilityEventClass =
  | "state"
  | "perception"
  | "cognition"
  | "control"
  | "verification"
  | "oops"
  | "memory"
  | "audio"
  | "safety"
  | "tts"
  | "qa";

export type ObservabilitySeverity = "debug" | "info" | "warning" | "error" | "critical";
export type DashboardVisibility = "hidden" | "developer" | "operator" | "qa" | "demo" | "safety_review";
export type ProvenanceStatus = "runtime_embodied" | "policy" | "memory" | "qa" | "blocked" | "redacted";
export type MonologuePriority = "low" | "normal" | "high" | "urgent" | "blocking";
export type MonologueAudience = "developer" | "operator" | "demo" | "qa" | "safety_review";
export type UtteranceClass =
  | "observation_summary"
  | "memory_context"
  | "plan_preview"
  | "validation_block"
  | "execution_start"
  | "execution_anomaly"
  | "verification_result"
  | "oops_diagnosis"
  | "correction_preview"
  | "audio_attention"
  | "safe_hold"
  | "task_completion";
export type ClaimType = "visual" | "audio" | "tactile" | "proprioceptive" | "memory" | "verification" | "residual" | "safety" | "controller" | "policy";
export type ProvenanceClass = "embodied_sensor" | "derived_estimate" | "controller_telemetry" | "policy_config" | "memory" | "qa_only";
export type ConfidenceClass = "verified" | "high" | "medium" | "low" | "ambiguous" | "contradicted";
export type PromptSafeStatus = "allowed" | "redacted" | "blocked";
export type FilterOutcome = "approve" | "approve_with_redaction" | "downgrade_to_display_only" | "block_silent_log" | "block_and_raise_audit";
export type TTSPlaybackStatus = "queued" | "started" | "completed" | "interrupted" | "skipped" | "failed";
export type QueueAction = "play_now" | "interrupt_and_play" | "queue" | "display_only" | "skip";
export type RetentionAction = "retain_full" | "summarize" | "archive" | "delete_raw_keep_manifest";

export interface RuntimeArtifactInput {
  readonly artifact_ref: Ref;
  readonly event_time_ms: number;
  readonly event_class: ObservabilityEventClass;
  readonly subsystem_ref: Ref;
  readonly severity: ObservabilitySeverity;
  readonly summary: string;
  readonly artifact_refs?: readonly Ref[];
  readonly task_ref?: Ref;
  readonly state_ref?: Ref;
  readonly provenance_status?: ProvenanceStatus;
  readonly dashboard_visibility?: DashboardVisibility;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface ObservabilityEventPolicy {
  readonly default_visibility: DashboardVisibility;
  readonly allow_qa_visibility: boolean;
  readonly redact_forbidden_text: boolean;
  readonly require_artifact_refs_for_task_events: boolean;
  readonly max_summary_chars: number;
}

export interface ObservabilityEvent {
  readonly observability_event_ref: Ref;
  readonly event_time_ms: number;
  readonly event_class: ObservabilityEventClass;
  readonly subsystem_ref: Ref;
  readonly severity: ObservabilitySeverity;
  readonly task_ref?: Ref;
  readonly state_ref?: Ref;
  readonly summary: string;
  readonly artifact_refs: readonly Ref[];
  readonly provenance_status: ProvenanceStatus;
  readonly dashboard_visibility: DashboardVisibility;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
  readonly validation_issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface GroundedClaimRecord {
  readonly claim_ref: Ref;
  readonly claim_text: string;
  readonly claim_type: ClaimType;
  readonly source_evidence_refs: readonly Ref[];
  readonly provenance_class: ProvenanceClass;
  readonly confidence_class: ConfidenceClass;
  readonly uncertainty_summary?: string;
  readonly prompt_safe_status: PromptSafeStatus;
  readonly determinism_hash: string;
}

export interface MonologueIntent {
  readonly monologue_intent_ref: Ref;
  readonly source_event_ref: Ref;
  readonly utterance_class: UtteranceClass;
  readonly task_ref?: Ref;
  readonly priority: MonologuePriority;
  readonly candidate_message: string;
  readonly evidence_claim_refs: readonly Ref[];
  readonly confidence_labels: readonly string[];
  readonly safety_labels: readonly string[];
  readonly memory_labels: readonly string[];
  readonly allowed_audience: MonologueAudience;
  readonly requires_tts: boolean;
  readonly validation_issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface GroundedClaimSet {
  readonly grounded_claim_set_ref: Ref;
  readonly source_intent_ref: Ref;
  readonly claims: readonly GroundedClaimRecord[];
  readonly blocked_claim_refs: readonly Ref[];
  readonly missing_evidence_refs: readonly Ref[];
  readonly overall_confidence: ConfidenceClass;
  readonly validation_issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface RedactionReport {
  readonly redaction_report_ref: Ref;
  readonly source_intent_ref: Ref;
  readonly redaction_rules_applied: readonly string[];
  readonly blocked_claim_refs: readonly Ref[];
  readonly rewritten_claim_refs: readonly Ref[];
  readonly final_decision: FilterOutcome;
  readonly audit_required: boolean;
  readonly determinism_hash: string;
}

export interface ApprovedMonologueUtterance {
  readonly utterance_ref: Ref;
  readonly source_intent_ref: Ref;
  readonly final_message: string;
  readonly utterance_class: UtteranceClass;
  readonly priority: MonologuePriority;
  readonly tts_profile_ref?: Ref;
  readonly playback_policy_ref: Ref;
  readonly grounding_summary_refs: readonly Ref[];
  readonly redaction_report_ref?: Ref;
  readonly acoustic_suppression_marker_required: boolean;
  readonly display_only: boolean;
  readonly determinism_hash: string;
}

export interface MonologueFilterDecision {
  readonly filter_decision_ref: Ref;
  readonly source_intent_ref: Ref;
  readonly outcome: FilterOutcome;
  readonly approved_utterance?: ApprovedMonologueUtterance;
  readonly redaction_report: RedactionReport;
  readonly final_display_text?: string;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface QueuedUtterance {
  readonly utterance_ref: Ref;
  readonly source_intent_ref: Ref;
  readonly final_message: string;
  readonly priority: MonologuePriority;
  readonly utterance_class: UtteranceClass;
  readonly queued_at_ms: number;
  readonly display_only: boolean;
}

export interface UtteranceScheduleDecision {
  readonly schedule_decision_ref: Ref;
  readonly action: QueueAction;
  readonly selected_utterance_ref?: Ref;
  readonly interrupted_utterance_ref?: Ref;
  readonly queued_utterances: readonly QueuedUtterance[];
  readonly reason: string;
  readonly determinism_hash: string;
}

export interface TTSProfile {
  readonly tts_profile_ref: Ref;
  readonly voice_ref: Ref;
  readonly language: string;
  readonly speaking_rate_wpm: number;
  readonly volume_gain: number;
  readonly max_duration_ms: number;
}

export interface PlaybackPolicy {
  readonly playback_policy_ref: Ref;
  readonly speaker_device_ref: Ref;
  readonly allow_tts: boolean;
  readonly interrupt_for_safety: boolean;
  readonly require_acoustic_suppression_marker: boolean;
  readonly display_text_when_muted: boolean;
}

export interface TTSRequest {
  readonly tts_request_ref: Ref;
  readonly utterance_ref: Ref;
  readonly final_message: string;
  readonly tts_profile: TTSProfile;
  readonly playback_policy_ref: Ref;
  readonly speaker_device_ref: Ref;
  readonly requested_start_time_ms: number;
  readonly estimated_end_time_ms: number;
  readonly acoustic_suppression_marker_ref: Ref;
  readonly determinism_hash: string;
}

export interface AcousticSuppressionMarker {
  readonly marker_ref: Ref;
  readonly utterance_ref: Ref;
  readonly speaker_device_ref: Ref;
  readonly expected_start_time_ms: number;
  readonly expected_end_time_ms: number;
  readonly reason: "self_generated_tts";
  readonly determinism_hash: string;
}

export interface TTSPlaybackEvent {
  readonly tts_playback_ref: Ref;
  readonly utterance_ref: Ref;
  readonly speaker_device_ref: Ref;
  readonly playback_start_time_ms?: number;
  readonly playback_end_time_ms?: number;
  readonly playback_status: TTSPlaybackStatus;
  readonly audio_leakage_marker_ref?: Ref;
  readonly operator_visible_text_ref: Ref;
  readonly failure_reason?: string;
  readonly determinism_hash: string;
}

export interface DashboardStateSnapshot {
  readonly dashboard_snapshot_ref: Ref;
  readonly snapshot_time_ms: number;
  readonly visibility_mode: DashboardVisibility;
  readonly task_state_summary: string;
  readonly active_evidence_refs: readonly Ref[];
  readonly active_decision_refs: readonly Ref[];
  readonly active_alerts: readonly string[];
  readonly tts_queue_summary: string;
  readonly redaction_manifest_ref: Ref;
  readonly determinism_hash: string;
}

export interface DecisionTraceRecord {
  readonly decision_trace_ref: Ref;
  readonly decision_type: "plan" | "validate" | "execute" | "verify" | "correct" | "remember" | "safe_hold" | "observe" | "speak";
  readonly input_artifact_refs: readonly Ref[];
  readonly decision_summary: string;
  readonly decision_owner_component: Ref;
  readonly model_advisory_refs: readonly Ref[];
  readonly deterministic_validator_refs: readonly Ref[];
  readonly output_artifact_refs: readonly Ref[];
  readonly truth_boundary_status: ProvenanceStatus;
  readonly determinism_hash: string;
}

export interface ReplayBundle {
  readonly replay_bundle_ref: Ref;
  readonly task_ref: Ref;
  readonly window_start_ms: number;
  readonly window_end_ms: number;
  readonly event_refs: readonly Ref[];
  readonly evidence_refs: readonly Ref[];
  readonly decision_traces: readonly DecisionTraceRecord[];
  readonly redaction_manifest_ref: Ref;
  readonly completeness_score: number;
  readonly determinism_hash: string;
}

export interface RetentionActionReport {
  readonly retention_report_ref: Ref;
  readonly policy_ref: Ref;
  readonly retained_refs: readonly Ref[];
  readonly summarized_refs: readonly Ref[];
  readonly archived_refs: readonly Ref[];
  readonly deleted_raw_refs: readonly Ref[];
  readonly preserved_audit_refs: readonly Ref[];
  readonly determinism_hash: string;
}

export interface OperatorAnnotationRecord {
  readonly annotation_ref: Ref;
  readonly source_event_ref: Ref;
  readonly operator_ref: Ref;
  readonly annotation_time_ms: number;
  readonly visibility: DashboardVisibility;
  readonly sanitized_note: string;
  readonly linked_artifact_refs: readonly Ref[];
  readonly audit_required: boolean;
  readonly determinism_hash: string;
}

/**
 * Converts a runtime artifact into a validated observability timeline event.
 * The emitter never trusts raw text; it sanitizes public summaries, redacts
 * unsafe wording when policy allows, and records validation issues.
 */
export class ObservabilityEventEmitter {
  public emitObservabilityEvent(runtimeArtifact: RuntimeArtifactInput, eventPolicy?: Partial<ObservabilityEventPolicy>): ObservabilityEvent {
    const policy = mergeObservabilityPolicy(eventPolicy);
    const issues: ValidationIssue[] = [];
    validateRef(runtimeArtifact.artifact_ref, "$.artifact_ref", issues);
    validateRef(runtimeArtifact.subsystem_ref, "$.subsystem_ref", issues);
    validateOptionalRef(runtimeArtifact.task_ref, "$.task_ref", issues);
    validateOptionalRef(runtimeArtifact.state_ref, "$.state_ref", issues);
    validateTimestamp(runtimeArtifact.event_time_ms, "$.event_time_ms", issues);

    const artifactRefs = uniqueRefs([runtimeArtifact.artifact_ref, ...(runtimeArtifact.artifact_refs ?? [])]);
    if (policy.require_artifact_refs_for_task_events && runtimeArtifact.task_ref !== undefined && artifactRefs.length === 0) {
      issues.push(makeIssue("error", "ObservabilityArtifactRefsRequired", "$.artifact_refs", "Task events require replayable artifact references.", "Attach evidence, policy, telemetry, or certificate refs."));
    }

    const cleanedSummary = sanitizePublicText(runtimeArtifact.summary, policy.redact_forbidden_text, policy.max_summary_chars, issues, "$.summary");
    const requestedVisibility = runtimeArtifact.dashboard_visibility ?? policy.default_visibility;
    const visibility = requestedVisibility === "qa" && !policy.allow_qa_visibility ? "developer" : requestedVisibility;
    const provenance = inferProvenance(runtimeArtifact.provenance_status, runtimeArtifact.event_class, issues);

    const base = {
      observability_event_ref: makeObservabilityRef("observability_event", runtimeArtifact.subsystem_ref, runtimeArtifact.artifact_ref, runtimeArtifact.event_time_ms),
      event_time_ms: runtimeArtifact.event_time_ms,
      event_class: runtimeArtifact.event_class,
      subsystem_ref: runtimeArtifact.subsystem_ref,
      severity: runtimeArtifact.severity,
      task_ref: runtimeArtifact.task_ref,
      state_ref: runtimeArtifact.state_ref,
      summary: cleanedSummary,
      artifact_refs: artifactRefs,
      provenance_status: provenance,
      dashboard_visibility: visibility,
      metadata: Object.freeze({ ...(runtimeArtifact.metadata ?? {}) }),
      validation_issues: freezeArray(issues),
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

/**
 * Returns true when text contains runtime-forbidden wording that should never
 * be spoken in non-QA modes.
 */
export function containsForbiddenRuntimeText(value: string): boolean {
  return FORBIDDEN_RUNTIME_TEXT_PATTERN.test(value);
}

/**
 * Returns true when text exposes prompt or private deliberation internals.
 */
export function containsPromptInternalText(value: string): boolean {
  return PROMPT_INTERNAL_PATTERN.test(value);
}

/**
 * Returns true when a message asserts success language that must be backed by a
 * verification claim.
 */
export function containsSuccessCertaintyText(value: string): boolean {
  return SUCCESS_CERTAINTY_PATTERN.test(value);
}

/**
 * Sanitizes text for dashboard or TTS surfaces while preserving deterministic
 * wording and validation evidence about redaction.
 */
export function sanitizePublicText(value: string, redact: boolean, maxChars: number, issues: ValidationIssue[], path: string): string {
  const normalized = compactText(value, maxChars);
  if (normalized.length === 0) {
    issues.push(makeIssue("error", "ObservabilityTextRequired", path, "Public observability text is required.", "Provide a concise evidence-grounded summary."));
    return normalized;
  }
  if (!containsForbiddenRuntimeText(normalized)) {
    return normalized;
  }
  const severity: ValidationSeverity = redact ? "warning" : "error";
  issues.push(makeIssue(severity, "ObservabilityTextForbidden", path, "Text contains hidden-truth, prompt-internal, or safety-bypass wording.", "Use embodied evidence summaries and public policy labels."));
  return redact ? compactText(normalized.replace(FORBIDDEN_RUNTIME_TEXT_PATTERN, "[redacted]"), maxChars) : normalized;
}

/**
 * Compresses narration to a bounded public utterance without changing priority
 * or evidence refs.
 */
export function compressPublicMessage(value: string, maxChars = MAX_MESSAGE_CHARS): string {
  const normalized = compactText(value, Math.max(maxChars, 80));
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const clipped = normalized.slice(0, Math.max(60, maxChars - 1)).trim();
  const boundary = Math.max(clipped.lastIndexOf("."), clipped.lastIndexOf(";"), clipped.lastIndexOf(","));
  return boundary >= 50 ? clipped.slice(0, boundary + 1).trim() : clipped;
}

/**
 * Builds a stable, opaque reference from public-safe components.
 */
export function makeObservabilityRef(prefix: string, ...parts: readonly (string | number | undefined)[]): Ref {
  const normalized = [prefix, ...parts]
    .filter((part): part is string | number => part !== undefined)
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "observability:empty";
}

/**
 * Creates a ValidationIssue using the repo-wide issue shape.
 */
export function makeIssue(severity: ValidationSeverity, code: string, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

/**
 * Clones and freezes an array so callers cannot mutate returned reports.
 */
export function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

/**
 * Removes duplicate refs while retaining first-seen deterministic ordering.
 */
export function uniqueRefs(items: readonly (Ref | undefined)[]): readonly Ref[] {
  return freezeArray([...new Set(items.filter((item): item is Ref => item !== undefined && item.trim().length > 0))]);
}

/**
 * Validates an opaque ref for empty values, whitespace, and unsafe leaked words.
 */
export function validateRef(ref: Ref | undefined, path: string, issues: ValidationIssue[]): void {
  if (ref === undefined || ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(makeIssue("error", "ObservabilityReferenceInvalid", path, "Reference must be present, non-empty, and whitespace-free.", "Use a stable opaque ref."));
    return;
  }
  if (containsForbiddenRuntimeText(ref)) {
    issues.push(makeIssue("error", "ObservabilityReferenceForbidden", path, "Reference contains restricted runtime wording.", "Use an opaque ref that does not reveal hidden system data."));
  }
}

/**
 * Validates an optional ref only when it is present.
 */
export function validateOptionalRef(ref: Ref | undefined, path: string, issues: ValidationIssue[]): void {
  if (ref !== undefined) {
    validateRef(ref, path, issues);
  }
}

/**
 * Validates a timestamp represented in deterministic milliseconds.
 */
export function validateTimestamp(value: number, path: string, issues: ValidationIssue[]): void {
  if (!Number.isFinite(value) || value < 0) {
    issues.push(makeIssue("error", "ObservabilityTimestampInvalid", path, "Timestamp must be a finite non-negative millisecond value.", "Pass a deterministic runtime timestamp."));
  }
}

/**
 * Converts priority labels into deterministic numeric ordering.
 */
export function priorityRank(priority: MonologuePriority): number {
  switch (priority) {
    case "blocking":
      return 5;
    case "urgent":
      return 4;
    case "high":
      return 3;
    case "normal":
      return 2;
    case "low":
      return 1;
  }
}

/**
 * Converts severity labels into deterministic numeric ordering.
 */
export function severityRank(severity: ObservabilitySeverity): number {
  switch (severity) {
    case "critical":
      return 5;
    case "error":
      return 4;
    case "warning":
      return 3;
    case "info":
      return 2;
    case "debug":
      return 1;
  }
}

/**
 * Returns whether an event may appear in a requested visibility mode.
 */
export function visibilityAllows(eventVisibility: DashboardVisibility, requestedMode: DashboardVisibility): boolean {
  if (eventVisibility === "hidden") {
    return false;
  }
  if (requestedMode === "qa") {
    return true;
  }
  if (requestedMode === "safety_review") {
    return eventVisibility !== "qa";
  }
  if (requestedMode === "developer") {
    return eventVisibility === "developer" || eventVisibility === "operator" || eventVisibility === "demo" || eventVisibility === "safety_review";
  }
  if (requestedMode === "operator") {
    return eventVisibility === "operator" || eventVisibility === "demo" || eventVisibility === "safety_review";
  }
  return eventVisibility === "demo";
}

/**
 * Computes the least optimistic confidence class across a set of claims.
 */
export function aggregateConfidence(claims: readonly GroundedClaimRecord[]): ConfidenceClass {
  if (claims.length === 0) {
    return "ambiguous";
  }
  const ranks: Readonly<Record<ConfidenceClass, number>> = {
    verified: 5,
    high: 4,
    medium: 3,
    low: 2,
    ambiguous: 1,
    contradicted: 0,
  };
  return claims.reduce((worst, claim) => ranks[claim.confidence_class] < ranks[worst] ? claim.confidence_class : worst, "verified" as ConfidenceClass);
}

/**
 * Builds a hashed grounded claim and validates text, evidence, and provenance.
 */
export function buildGroundedClaim(input: Omit<GroundedClaimRecord, "determinism_hash">): GroundedClaimRecord {
  const issues: ValidationIssue[] = [];
  validateRef(input.claim_ref, "$.claim_ref", issues);
  for (const [index, ref] of input.source_evidence_refs.entries()) {
    validateRef(ref, `$.source_evidence_refs[${index}]`, issues);
  }
  sanitizePublicText(input.claim_text, input.prompt_safe_status !== "blocked", MAX_SUMMARY_CHARS, issues, "$.claim_text");
  const safeStatus: PromptSafeStatus = issues.some((issue) => issue.severity === "error") ? "blocked" : input.prompt_safe_status;
  const base = {
    ...input,
    prompt_safe_status: safeStatus,
    source_evidence_refs: uniqueRefs(input.source_evidence_refs),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

/**
 * Creates a deterministic text ref used by dashboard-visible strings.
 */
export function makeTextRef(sourceRef: Ref, text: string): Ref {
  return makeObservabilityRef("operator_text", sourceRef, computeDeterminismHash(compactText(text, MAX_OPERATOR_NOTE_CHARS)));
}

/**
 * Normalizes whitespace and applies a hard character ceiling.
 */
export function compactText(value: string, maxChars = MAX_SUMMARY_CHARS): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

/**
 * Merges caller policy with conservative observability defaults.
 */
export function mergeObservabilityPolicy(policy?: Partial<ObservabilityEventPolicy>): ObservabilityEventPolicy {
  return Object.freeze({
    default_visibility: policy?.default_visibility ?? "developer",
    allow_qa_visibility: policy?.allow_qa_visibility ?? false,
    redact_forbidden_text: policy?.redact_forbidden_text ?? true,
    require_artifact_refs_for_task_events: policy?.require_artifact_refs_for_task_events ?? true,
    max_summary_chars: policy?.max_summary_chars !== undefined && policy.max_summary_chars > 0 ? Math.floor(policy.max_summary_chars) : MAX_SUMMARY_CHARS,
  });
}

function inferProvenance(requested: ProvenanceStatus | undefined, eventClass: ObservabilityEventClass, issues: ValidationIssue[]): ProvenanceStatus {
  const inferred = requested ?? (eventClass === "memory" ? "memory" : eventClass === "qa" ? "qa" : eventClass === "safety" ? "policy" : "runtime_embodied");
  if (eventClass !== "qa" && inferred === "qa") {
    issues.push(makeIssue("warning", "ObservabilityQaProvenanceRuntime", "$.provenance_status", "QA provenance was attached to a runtime event.", "Use QA visibility only for benchmark views."));
  }
  return inferred;
}

export const OBSERVABILITY_EVENT_EMITTER_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: OBSERVABILITY_SCHEMA_VERSION,
  blueprint: OBSERVABILITY_BLUEPRINT_REF,
  sections: freezeArray(["17.4", "17.6", "17.7", "17.13", "17.14", "17.15", "17.16", "17.18", "17.19"]),
  component: "ObservabilityEventEmitter",
});
