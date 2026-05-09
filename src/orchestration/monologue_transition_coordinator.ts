/**
 * Monologue transition coordinator for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md`
 * sections 8.3, 8.5, 8.7, 8.9.7, 8.10, 8.14, 8.15, 8.16, 8.17, 8.18,
 * and 8.19.
 *
 * This module implements the executable `MonologueTransitionCoordinator`. It
 * admits TTS only after deterministic plan validation, filters public
 * narration for simulation-blindness and prompt safety, schedules or skips
 * utterances according to priority and queue policy, emits acoustic suppression
 * markers for self-generated audio, handles safety interruption, and returns a
 * monologue gate that never grants execution approval by itself.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import type {
  EventSeverity,
  OrchestrationEventEnvelope,
  PayloadProvenanceClass,
  PrimaryState,
  RuntimeStateSnapshot,
} from "./orchestration_state_machine";
import type { MonologueExecutionGate, MonologueExecutionStatus } from "./execution_gatekeeper";
import type { StatePayloadFirewallReport } from "./state_payload_firewall";

export const MONOLOGUE_TRANSITION_COORDINATOR_SCHEMA_VERSION = "mebsuta.monologue_transition_coordinator.v1" as const;
export const MONOLOGUE_TRANSITION_COORDINATOR_VERSION = "1.0.0" as const;

const CONTRACT_TRACEABILITY_REF = "architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md#MonologueTransitionCoordinator" as const;
const SUPPORTING_MONOLOGUE_BLUEPRINT_REF = "architecture_docs/17_INTERNAL_MONOLOGUE_TTS_OBSERVABILITY.md" as const;
const DEFAULT_TTS_START_TARGET_MS = 1_000;
const DEFAULT_MAX_UTTERANCE_CHARS = 220;
const DEFAULT_MAX_QUEUE_DEPTH = 4;
const DEFAULT_IDENTICAL_SUPPRESSION_WINDOW_MS = 12_000;
const DEFAULT_INTERRUPT_LATENCY_BUDGET_MS = 250;
const FORBIDDEN_MONOLOGUE_TEXT_PATTERN = /(mujoco|babylon|simulator|physics engine|render engine|world_truth|ground_truth|hidden state|hidden_state|hidden pose|oracle state|qa_|backend|object_id|rigid_body_handle|physics_body|joint_handle|scene_graph|collision_mesh|debug buffer|segmentation truth|depth truth|system prompt|developer prompt|chain-of-thought|scratchpad|private deliberation|raw model|direct actuator|raw actuator|joint torque|apply force|apply impulse|reward policy|policy gradient|reinforcement learning|guarantee success|skip validation|override safety|ignore safety)/i;

export type MonologueUtteranceClass =
  | "observation"
  | "plan"
  | "validation"
  | "oops"
  | "verification"
  | "safety"
  | "memory"
  | "audio"
  | "tool"
  | "status";
export type MonologuePriority = "low" | "normal" | "high" | "urgent" | "blocking";
export type MonologueAudience = "developer" | "operator" | "scenario_demo" | "qa_only" | "safety_review";
export type MonologueClaimType = "visual" | "audio" | "tactile" | "proprioceptive" | "memory" | "verification" | "residual" | "safety" | "controller" | "task" | "policy";
export type MonologueClaimConfidence = "verified" | "high" | "medium" | "low" | "ambiguous" | "contradicted";
export type MonologuePromptSafeStatus = "allowed" | "redacted" | "blocked";
export type MonologueFilterDisposition = "approved" | "redacted" | "display_only" | "blocked";
export type MonologueScheduleDecision = "play_now" | "interrupt_and_play" | "queue" | "display_only" | "skip";
export type TTSPlaybackStatus = "queued" | "started" | "completed" | "interrupted" | "skipped" | "failed";
export type TTSVoiceStyle = "neutral" | "concise" | "calm" | "demo" | "debug";
export type TTSSpeakingRate = "slow" | "normal" | "fast";
export type TTSVolumeProfile = "quiet" | "normal" | "alert";
export type TTSInterruptibility = "interruptible" | "non_interruptible";
export type MonologueTransitionDecision = "tts_request_ready" | "display_only" | "skipped_by_policy" | "blocked" | "safe_hold_required" | "interrupted";

export interface MonologueCoordinatorPolicy {
  readonly require_plan_validation: boolean;
  readonly allow_skip_when_noncritical: boolean;
  readonly allow_display_only_when_muted: boolean;
  readonly block_on_firewall_warning: boolean;
  readonly max_utterance_chars: number;
  readonly tts_start_target_ms: number;
  readonly max_queue_depth: number;
  readonly identical_suppression_window_ms: number;
  readonly interrupt_latency_budget_ms: number;
  readonly debug_tts_enabled: boolean;
  readonly operator_tts_muted: boolean;
}

export interface GroundedClaimRecord {
  readonly claim_ref: Ref;
  readonly claim_text: string;
  readonly claim_type: MonologueClaimType;
  readonly source_evidence_refs: readonly Ref[];
  readonly provenance_class: PayloadProvenanceClass | "embodied_sensor" | "derived_estimate" | "policy_config";
  readonly confidence_class: MonologueClaimConfidence;
  readonly uncertainty_summary?: string;
  readonly prompt_safe_status: MonologuePromptSafeStatus;
}

export interface MonologueIntent {
  readonly monologue_intent_ref: Ref;
  readonly source_event_ref: Ref;
  readonly utterance_class: MonologueUtteranceClass;
  readonly task_ref?: Ref;
  readonly priority: MonologuePriority;
  readonly candidate_message: string;
  readonly evidence_claim_refs: readonly Ref[];
  readonly grounded_claims: readonly GroundedClaimRecord[];
  readonly confidence_labels?: readonly string[];
  readonly safety_labels?: readonly string[];
  readonly memory_labels?: readonly string[];
  readonly allowed_audience: MonologueAudience;
  readonly requires_tts: boolean;
}

export interface TTSProfile {
  readonly tts_profile_ref: Ref;
  readonly voice_style: TTSVoiceStyle;
  readonly speaking_rate: TTSSpeakingRate;
  readonly volume_profile: TTSVolumeProfile;
  readonly language: string;
  readonly max_utterance_duration_ms: number;
  readonly interruptibility: TTSInterruptibility;
}

export interface MonologuePlaybackPolicy {
  readonly playback_policy_ref: Ref;
  readonly speaker_device_ref: Ref;
  readonly allow_tts: boolean;
  readonly require_acoustic_suppression_marker: boolean;
  readonly audio_critical_phase_active: boolean;
  readonly monologue_required_for_plan: boolean;
  readonly allow_noncritical_skip: boolean;
}

export interface ApprovedMonologueUtterance {
  readonly utterance_ref: Ref;
  readonly source_intent_ref: Ref;
  readonly final_message: string;
  readonly utterance_class: MonologueUtteranceClass;
  readonly priority: MonologuePriority;
  readonly tts_profile_ref?: Ref;
  readonly playback_policy_ref: Ref;
  readonly grounding_summary_refs: readonly Ref[];
  readonly redaction_report_ref?: Ref;
  readonly acoustic_suppression_marker_required: boolean;
  readonly display_only: boolean;
  readonly determinism_hash: string;
}

export interface TTSRequest {
  readonly tts_request_ref: Ref;
  readonly utterance_ref: Ref;
  readonly message: string;
  readonly tts_profile: TTSProfile;
  readonly playback_policy_ref: Ref;
  readonly speaker_device_ref: Ref;
  readonly requested_start_ms: number;
  readonly deadline_ms: number;
  readonly acoustic_suppression_marker_ref: Ref;
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

export interface AcousticSuppressionMarker {
  readonly marker_ref: Ref;
  readonly utterance_ref: Ref;
  readonly speaker_device_ref: Ref;
  readonly expected_start_ms: number;
  readonly expected_end_ms: number;
  readonly suppression_route_ref: Ref;
  readonly reason: "self_generated_tts";
  readonly determinism_hash: string;
}

export interface ActiveTTSPlayback {
  readonly playback_ref: Ref;
  readonly utterance_ref: Ref;
  readonly priority: MonologuePriority;
  readonly interruptibility: TTSInterruptibility;
  readonly started_at_ms: number;
  readonly speaker_device_ref: Ref;
}

export interface QueuedMonologueUtterance {
  readonly utterance_ref: Ref;
  readonly source_intent_ref: Ref;
  readonly final_message: string;
  readonly utterance_class: MonologueUtteranceClass;
  readonly priority: MonologuePriority;
  readonly queued_at_ms: number;
}

export interface MonologueQueueContext {
  readonly active_playback?: ActiveTTSPlayback;
  readonly queued_utterances: readonly QueuedMonologueUtterance[];
  readonly recent_utterances: readonly QueuedMonologueUtterance[];
}

export interface MonologueFilterDecisionReport {
  readonly intent_ref: Ref;
  readonly disposition: MonologueFilterDisposition;
  readonly approved_utterance?: ApprovedMonologueUtterance;
  readonly removed_claim_refs: readonly Ref[];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface MonologueScheduleReport {
  readonly schedule_decision: MonologueScheduleDecision;
  readonly approved_utterance?: ApprovedMonologueUtterance;
  readonly tts_request?: TTSRequest;
  readonly acoustic_suppression_marker?: AcousticSuppressionMarker;
  readonly interrupted_playback_event?: TTSPlaybackEvent;
  readonly queued_utterances: readonly QueuedMonologueUtterance[];
  readonly reason: string;
  readonly determinism_hash: string;
}

export interface MonologueTransitionRequest {
  readonly snapshot: RuntimeStateSnapshot;
  readonly validation_event: OrchestrationEventEnvelope;
  readonly approved_plan_ref: Ref;
  readonly validation_decision_ref: Ref;
  readonly latest_observation_ref: Ref;
  readonly plan_summary: string;
  readonly plan_still_valid: boolean;
  readonly safety_interruption_active: boolean;
  readonly intents: readonly MonologueIntent[];
  readonly tts_profile: TTSProfile;
  readonly playback_policy: MonologuePlaybackPolicy;
  readonly queue_context: MonologueQueueContext;
  readonly occurred_at_ms: number;
  readonly policy?: Partial<MonologueCoordinatorPolicy>;
  readonly firewall_reports?: readonly StatePayloadFirewallReport[];
}

export interface MonologueTransitionCoordinatorReport {
  readonly schema_version: typeof MONOLOGUE_TRANSITION_COORDINATOR_SCHEMA_VERSION;
  readonly coordinator_version: typeof MONOLOGUE_TRANSITION_COORDINATOR_VERSION;
  readonly decision: MonologueTransitionDecision;
  readonly selected_intent_ref?: Ref;
  readonly approved_utterance?: ApprovedMonologueUtterance;
  readonly tts_request?: TTSRequest;
  readonly acoustic_suppression_marker?: AcousticSuppressionMarker;
  readonly playback_event?: TTSPlaybackEvent;
  readonly transition_event: OrchestrationEventEnvelope;
  readonly monologue_gate: MonologueExecutionGate;
  readonly filter_reports: readonly MonologueFilterDecisionReport[];
  readonly schedule_report: MonologueScheduleReport;
  readonly issue_count: number;
  readonly error_count: number;
  readonly warning_count: number;
  readonly issues: readonly ValidationIssue[];
  readonly traceability_ref: typeof CONTRACT_TRACEABILITY_REF;
  readonly supporting_monologue_blueprint: typeof SUPPORTING_MONOLOGUE_BLUEPRINT_REF;
  readonly determinism_hash: string;
}

export interface TTSEnginePort {
  readonly playTTSUtterance: (request: TTSRequest) => TTSPlaybackEvent | Promise<TTSPlaybackEvent>;
  readonly interruptTTSPlayback?: (activePlayback: ActiveTTSPlayback, interruptReason: string, interruptedAtMs: number) => TTSPlaybackEvent | Promise<TTSPlaybackEvent>;
}

/**
 * Coordinates Monologue state entry, TTS scheduling, safety interruption, and
 * execution-gate status. It produces TTS requests and orchestration events; it
 * does not approve motion or mutate runtime state.
 */
export class MonologueTransitionCoordinator {
  /**
   * Evaluates validated-plan narration and prepares either a TTS request,
   * display-only utterance, skip decision, SafeHold event, or interruption.
   */
  public evaluateMonologueTransition(request: MonologueTransitionRequest): MonologueTransitionCoordinatorReport {
    const policy = mergePolicy(request.policy);
    const structuralIssues = validateRequest(request, policy);
    const firewallIssues = issuesFromFirewallReports(request.firewall_reports ?? [], policy);
    const selectedIntent = selectIntent(request.intents, request.queue_context, policy, request.occurred_at_ms);
    const filterReports = freezeArray(request.intents.map((intent) => filterMonologueIntent(intent, request, policy)));
    const selectedFilterReport = selectedIntent === undefined
      ? undefined
      : filterReports.find((report) => report.intent_ref === selectedIntent.monologue_intent_ref);
    const scheduleReport = scheduleMonologueUtterance(selectedFilterReport?.approved_utterance, request, policy, selectedFilterReport);
    const issues = freezeArray([...structuralIssues, ...firewallIssues, ...filterReports.flatMap((report) => report.issues)]);
    const decision = chooseDecision(request, selectedFilterReport, scheduleReport, issues, policy);
    const transitionEvent = buildTransitionEvent(request, decision, selectedFilterReport, scheduleReport, issues);
    const gate = buildMonologueGate(request, decision, scheduleReport, transitionEvent);
    return makeReport(decision, selectedIntent?.monologue_intent_ref, selectedFilterReport, scheduleReport, transitionEvent, gate, filterReports, issues);
  }

  /**
   * Executes the prepared TTS request through an injected TTS engine port. The
   * returned playback event is normalized into a deterministic receipt.
   */
  public async playPreparedTTS(report: MonologueTransitionCoordinatorReport, ttsEngine: TTSEnginePort): Promise<TTSPlaybackEvent> {
    if (report.tts_request === undefined) {
      return makePlaybackEvent(
        report.approved_utterance?.utterance_ref ?? report.transition_event.event_ref,
        "skipped",
        report.transition_event.payload_refs[0] ?? report.transition_event.event_ref,
        undefined,
        undefined,
        report.transition_event.occurred_at_ms,
        "No TTS request was prepared by monologue policy.",
      );
    }
    try {
      const playback = await ttsEngine.playTTSUtterance(report.tts_request);
      return normalizePlaybackEvent(playback, report.tts_request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return makePlaybackEvent(
        report.tts_request.utterance_ref,
        "failed",
        report.tts_request.speaker_device_ref,
        report.tts_request.acoustic_suppression_marker_ref,
        undefined,
        report.tts_request.requested_start_ms,
        compactText(message),
      );
    }
  }

  /**
   * Builds a safety-interruption playback event for active speech. Critical
   * safety events never wait for the TTS engine before SafeHold can proceed.
   */
  public async interruptForSafety(
    activePlayback: ActiveTTSPlayback,
    safetyEvent: OrchestrationEventEnvelope,
    ttsEngine: TTSEnginePort | undefined,
    interruptedAtMs: number,
  ): Promise<TTSPlaybackEvent> {
    if (ttsEngine?.interruptTTSPlayback !== undefined) {
      try {
        const playback = await ttsEngine.interruptTTSPlayback(activePlayback, safetyEvent.human_summary, interruptedAtMs);
        return Object.freeze({ ...playback });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return makePlaybackEvent(activePlayback.utterance_ref, "interrupted", activePlayback.speaker_device_ref, undefined, activePlayback.started_at_ms, interruptedAtMs, compactText(message));
      }
    }
    return makePlaybackEvent(activePlayback.utterance_ref, "interrupted", activePlayback.speaker_device_ref, undefined, activePlayback.started_at_ms, interruptedAtMs, "Safety event interrupted active speech.");
  }
}

function filterMonologueIntent(
  intent: MonologueIntent,
  request: MonologueTransitionRequest,
  policy: MonologueCoordinatorPolicy,
): MonologueFilterDecisionReport {
  const issues: ValidationIssue[] = [];
  const removedClaims: Ref[] = [];
  validateIntent(intent, request, issues);
  const allowedClaims = intent.grounded_claims.filter((claim) => {
    const keep = claim.prompt_safe_status === "allowed" && claim.provenance_class !== "qa_only" && claim.provenance_class !== "restricted" && claim.confidence_class !== "contradicted";
    if (!keep) {
      removedClaims.push(claim.claim_ref);
    }
    return keep;
  });
  const rawMessage = buildMessage(intent, request.plan_summary, allowedClaims);
  const filtered = filterText(rawMessage, issues);
  const disposition = chooseFilterDisposition(intent, filtered, issues, policy);
  const utterance = disposition === "blocked"
    ? undefined
    : buildApprovedUtterance(intent, filtered.text, allowedClaims, request, disposition, removedClaims);
  const base = {
    intent_ref: intent.monologue_intent_ref,
    disposition,
    approved_utterance: utterance,
    removed_claim_refs: freezeArray(removedClaims),
    issues: freezeArray(issues),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function scheduleMonologueUtterance(
  utterance: ApprovedMonologueUtterance | undefined,
  request: MonologueTransitionRequest,
  policy: MonologueCoordinatorPolicy,
  filterReport: MonologueFilterDecisionReport | undefined,
): MonologueScheduleReport {
  if (utterance === undefined || filterReport === undefined) {
    return makeScheduleReport("skip", undefined, undefined, undefined, undefined, request.queue_context.queued_utterances, "No approved utterance available.");
  }
  if (filterReport.disposition === "display_only" || utterance.display_only) {
    return makeScheduleReport("display_only", utterance, undefined, undefined, undefined, request.queue_context.queued_utterances, "Utterance is dashboard-only by policy.");
  }
  if (!request.playback_policy.allow_tts || policy.operator_tts_muted) {
    const decision: MonologueScheduleDecision = policy.allow_display_only_when_muted ? "display_only" : "skip";
    return makeScheduleReport(decision, utterance, undefined, undefined, undefined, request.queue_context.queued_utterances, "TTS is muted or disabled.");
  }
  if (request.playback_policy.audio_critical_phase_active && !isSafetyPriority(utterance.priority)) {
    return makeScheduleReport("queue", utterance, undefined, undefined, undefined, enqueue(request.queue_context.queued_utterances, utterance, request.occurred_at_ms, policy), "Audio-critical phase delays nonessential speech.");
  }
  if (isRepeatedRoutineUtterance(utterance, request.queue_context, request.occurred_at_ms, policy)) {
    return makeScheduleReport("skip", utterance, undefined, undefined, undefined, request.queue_context.queued_utterances, "Recent identical routine utterance already covered this message.");
  }
  const active = request.queue_context.active_playback;
  if (active !== undefined && shouldInterrupt(active, utterance)) {
    const interrupted = makePlaybackEvent(active.utterance_ref, "interrupted", active.speaker_device_ref, undefined, active.started_at_ms, request.occurred_at_ms, "Higher-priority monologue utterance interrupted current speech.");
    const ttsRequest = buildTTSRequest(utterance, request);
    const marker = buildAcousticSuppressionMarker(ttsRequest, request.tts_profile);
    return makeScheduleReport("interrupt_and_play", utterance, ttsRequest, marker, interrupted, request.queue_context.queued_utterances, "Higher-priority utterance interrupts active speech.");
  }
  if (active !== undefined) {
    const queue = enqueue(request.queue_context.queued_utterances, utterance, request.occurred_at_ms, policy);
    return makeScheduleReport("queue", utterance, undefined, undefined, undefined, queue, "Active speech is not interruptible by this utterance.");
  }
  const ttsRequest = buildTTSRequest(utterance, request);
  const marker = buildAcousticSuppressionMarker(ttsRequest, request.tts_profile);
  return makeScheduleReport("play_now", utterance, ttsRequest, marker, undefined, request.queue_context.queued_utterances, "Queue is clear and TTS is allowed.");
}

function chooseDecision(
  request: MonologueTransitionRequest,
  selectedFilterReport: MonologueFilterDecisionReport | undefined,
  scheduleReport: MonologueScheduleReport,
  issues: readonly ValidationIssue[],
  policy: MonologueCoordinatorPolicy,
): MonologueTransitionDecision {
  if (request.safety_interruption_active || request.snapshot.safety_mode === "SafeHoldRequired" || request.snapshot.safety_mode === "AbortRequired") {
    return scheduleReport.interrupted_playback_event !== undefined ? "interrupted" : "safe_hold_required";
  }
  if (issues.some((item) => item.severity === "error") && request.playback_policy.monologue_required_for_plan) {
    return "safe_hold_required";
  }
  if (selectedFilterReport?.disposition === "blocked") {
    return request.playback_policy.monologue_required_for_plan ? "safe_hold_required" : "blocked";
  }
  if (scheduleReport.schedule_decision === "display_only") {
    return "display_only";
  }
  if (scheduleReport.schedule_decision === "skip" || scheduleReport.schedule_decision === "queue") {
    return request.playback_policy.monologue_required_for_plan && !policy.allow_skip_when_noncritical ? "blocked" : "skipped_by_policy";
  }
  return "tts_request_ready";
}

function buildTransitionEvent(
  request: MonologueTransitionRequest,
  decision: MonologueTransitionDecision,
  filterReport: MonologueFilterDecisionReport | undefined,
  scheduleReport: MonologueScheduleReport,
  issues: readonly ValidationIssue[],
): OrchestrationEventEnvelope {
  const targetState = decision === "safe_hold_required" || decision === "interrupted" ? "SafeHold" : decision === "tts_request_ready" ? "Monologue" : "Execute";
  const eventType = eventTypeForDecision(decision, scheduleReport);
  const base = {
    event_ref: makeRef("event", "monologue_transition", eventType, request.approved_plan_ref, request.occurred_at_ms),
    event_type: eventType,
    event_family: "monologue" as const,
    severity: severityForDecision(decision, issues),
    session_ref: request.snapshot.session_ref,
    task_ref: request.snapshot.task_ref,
    source_state_ref: request.snapshot.primary_state,
    context_ref: request.snapshot.current_context_ref,
    payload_refs: uniqueRefs([
      request.validation_event.event_ref,
      request.approved_plan_ref,
      request.validation_decision_ref,
      request.latest_observation_ref,
      filterReport?.intent_ref,
      scheduleReport.approved_utterance?.utterance_ref,
      scheduleReport.tts_request?.tts_request_ref,
      scheduleReport.acoustic_suppression_marker?.marker_ref,
      scheduleReport.interrupted_playback_event?.tts_playback_ref,
    ]),
    provenance_classes: freezeArray(["validator", "schema", "safety", "telemetry"] as const),
    occurred_at_ms: request.occurred_at_ms,
    human_summary: summaryForDecision(decision, scheduleReport.reason),
    target_state_hint: targetState as PrimaryState,
    plan_ref: request.approved_plan_ref,
    validation_approved: true,
    monologue_required: request.playback_policy.monologue_required_for_plan,
    safety_mode_override: targetState === "SafeHold" ? "SafeHoldRequired" as const : undefined,
  };
  return Object.freeze(base);
}

function buildMonologueGate(
  request: MonologueTransitionRequest,
  decision: MonologueTransitionDecision,
  scheduleReport: MonologueScheduleReport,
  event: OrchestrationEventEnvelope,
): MonologueExecutionGate {
  const status: MonologueExecutionStatus = gateStatusForDecision(decision, scheduleReport);
  return Object.freeze({
    policy_ref: request.playback_policy.playback_policy_ref,
    required: request.playback_policy.monologue_required_for_plan,
    status,
    speech_ref: scheduleReport.approved_utterance?.utterance_ref ?? event.event_ref,
    completed_at_ms: status === "completed" || status === "skipped_by_policy" ? request.occurred_at_ms : undefined,
    allow_skip_when_noncritical: request.playback_policy.allow_noncritical_skip,
    safety_interruption_active: request.safety_interruption_active || decision === "safe_hold_required" || decision === "interrupted",
    expected_plan_ref: request.approved_plan_ref,
  });
}

function validateRequest(request: MonologueTransitionRequest, policy: MonologueCoordinatorPolicy): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateRef(request.snapshot.session_ref, "$.snapshot.session_ref", issues);
  validateRef(request.snapshot.task_ref, "$.snapshot.task_ref", issues);
  validateRef(request.snapshot.current_context_ref, "$.snapshot.current_context_ref", issues);
  validateRef(request.validation_event.event_ref, "$.validation_event.event_ref", issues);
  validateRef(request.approved_plan_ref, "$.approved_plan_ref", issues);
  validateRef(request.validation_decision_ref, "$.validation_decision_ref", issues);
  validateRef(request.latest_observation_ref, "$.latest_observation_ref", issues);
  validateRef(request.tts_profile.tts_profile_ref, "$.tts_profile.tts_profile_ref", issues);
  validateRef(request.playback_policy.playback_policy_ref, "$.playback_policy.playback_policy_ref", issues);
  validateRef(request.playback_policy.speaker_device_ref, "$.playback_policy.speaker_device_ref", issues);
  validateSafeText(request.plan_summary, "$.plan_summary", true, issues);
  if (request.validation_event.session_ref !== request.snapshot.session_ref || request.validation_event.task_ref !== request.snapshot.task_ref) {
    issues.push(issue("error", "MonologueValidationEventMismatch", "$.validation_event", "Validation event does not match the current runtime snapshot.", "Reject stale or cross-session monologue input."));
  }
  if (policy.require_plan_validation && request.validation_event.event_type !== "PlanApproved") {
    issues.push(issue("error", "MonologueRequiresPlanApproved", "$.validation_event.event_type", "Monologue TTS requires a PlanApproved validation event.", "Route through Validate before Monologue."));
  }
  if (!request.plan_still_valid) {
    issues.push(issue("error", "MonologuePlanStale", "$.plan_still_valid", "Approved plan is no longer valid for speech-to-execution flow.", "Revalidate or route to SafeHold."));
  }
  if (request.tts_profile.max_utterance_duration_ms <= 0 || !Number.isFinite(request.tts_profile.max_utterance_duration_ms)) {
    issues.push(issue("error", "TTSProfileDurationInvalid", "$.tts_profile.max_utterance_duration_ms", "TTS profile must bound utterance duration.", "Use a finite positive duration budget."));
  }
  if (request.occurred_at_ms - request.validation_event.occurred_at_ms > policy.tts_start_target_ms && request.playback_policy.monologue_required_for_plan) {
    issues.push(issue("warning", "MonologueStartTargetMissed", "$.occurred_at_ms", "Required monologue missed the File 08 TTS start target.", "Skip only if non-critical or route to SafeHold."));
  }
  return freezeArray(issues);
}

function validateIntent(intent: MonologueIntent, request: MonologueTransitionRequest, issues: ValidationIssue[]): void {
  validateRef(intent.monologue_intent_ref, "$.intent.monologue_intent_ref", issues);
  validateRef(intent.source_event_ref, "$.intent.source_event_ref", issues);
  validateSafeText(intent.candidate_message, "$.intent.candidate_message", true, issues);
  if (intent.task_ref !== undefined && intent.task_ref !== request.snapshot.task_ref) {
    issues.push(issue("error", "MonologueIntentTaskMismatch", "$.intent.task_ref", "Monologue intent task does not match runtime task.", "Reject stale monologue intent."));
  }
  if (intent.allowed_audience === "qa_only" && intent.requires_tts) {
    issues.push(issue("error", "QAOnlyMonologueCannotUseTTS", "$.intent.allowed_audience", "QA-only monologue must not be spoken.", "Use dashboard-only QA visibility."));
  }
  if (intent.grounded_claims.length === 0 && intent.priority !== "blocking") {
    issues.push(issue("warning", "MonologueClaimsMissing", "$.intent.grounded_claims", "Non-blocking monologue lacks grounded evidence claims.", "Attach claim refs or make it display-only."));
  }
  for (const [index, claim] of intent.grounded_claims.entries()) {
    validateClaim(claim, index, issues);
  }
}

function validateClaim(claim: GroundedClaimRecord, index: number, issues: ValidationIssue[]): void {
  const path = `$.intent.grounded_claims[${index}]`;
  validateRef(claim.claim_ref, `${path}.claim_ref`, issues);
  validateSafeText(claim.claim_text, `${path}.claim_text`, true, issues);
  if (claim.source_evidence_refs.length === 0) {
    issues.push(issue("warning", "MonologueClaimEvidenceMissing", `${path}.source_evidence_refs`, "Grounded claim has no evidence refs.", "Attach sensor, memory, certificate, telemetry, or policy refs."));
  }
  for (const [refIndex, evidenceRef] of claim.source_evidence_refs.entries()) {
    validateRef(evidenceRef, `${path}.source_evidence_refs[${refIndex}]`, issues);
  }
  if (claim.provenance_class === "qa_only" || claim.provenance_class === "restricted") {
    issues.push(issue("error", "MonologueClaimProvenanceForbidden", `${path}.provenance_class`, "Monologue cannot speak QA-only or restricted provenance.", "Use embodied, validator, safety, memory, schema, operator, telemetry, or policy provenance."));
  }
  if (claim.prompt_safe_status === "blocked") {
    issues.push(issue("error", "MonologueClaimBlocked", `${path}.prompt_safe_status`, "Monologue claim is blocked by prompt safety status.", "Remove or redact the claim before speech."));
  }
}

function issuesFromFirewallReports(reports: readonly StatePayloadFirewallReport[], policy: MonologueCoordinatorPolicy): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [index, report] of reports.entries()) {
    if (report.guard_result.blocking || report.decision === "block") {
      issues.push(issue("error", "MonologueFirewallBlocked", `$.firewall_reports[${index}]`, "State payload firewall blocked monologue-facing payload.", "Do not speak blocked content."));
    } else if (report.findings.length > 0 || report.decision === "quarantine") {
      issues.push(issue(policy.block_on_firewall_warning ? "error" : "warning", "MonologueFirewallWarning", `$.firewall_reports[${index}]`, "State payload firewall reported warnings for monologue payload.", "Use only sanitized payload fields."));
    }
  }
  return freezeArray(issues);
}

function selectIntent(
  intents: readonly MonologueIntent[],
  queueContext: MonologueQueueContext,
  policy: MonologueCoordinatorPolicy,
  occurredAtMs: number,
): MonologueIntent | undefined {
  const eligible = intents.filter((intent) => intent.allowed_audience !== "qa_only" || policy.debug_tts_enabled);
  eligible.sort((left, right) => priorityRank(right.priority) - priorityRank(left.priority) || left.monologue_intent_ref.localeCompare(right.monologue_intent_ref));
  return eligible.find((intent) => !recentIntentRepeated(intent, queueContext, occurredAtMs, policy)) ?? eligible[0];
}

function buildMessage(intent: MonologueIntent, planSummary: string, claims: readonly GroundedClaimRecord[]): string {
  const claimSummary = claims
    .slice(0, 3)
    .map((claim) => claim.claim_text)
    .join(" ");
  const labels = [
    ...(intent.confidence_labels ?? []),
    ...(intent.safety_labels ?? []),
    ...(intent.memory_labels ?? []),
  ].slice(0, 3).join("; ");
  const raw = intent.candidate_message.trim().length > 0 ? intent.candidate_message : planSummary;
  return compactText([raw, claimSummary, labels].filter((item) => item.trim().length > 0).join(" "));
}

function filterText(message: string, issues: ValidationIssue[]): { readonly text: string; readonly redacted: boolean } {
  validateSafeText(message, "$.monologue_message", true, issues);
  if (!FORBIDDEN_MONOLOGUE_TEXT_PATTERN.test(message)) {
    return Object.freeze({ text: compactText(message), redacted: false });
  }
  return Object.freeze({
    text: compactText(message.replace(FORBIDDEN_MONOLOGUE_TEXT_PATTERN, "[redacted]")),
    redacted: true,
  });
}

function chooseFilterDisposition(
  intent: MonologueIntent,
  filtered: { readonly text: string; readonly redacted: boolean },
  issues: readonly ValidationIssue[],
  policy: MonologueCoordinatorPolicy,
): MonologueFilterDisposition {
  if (issues.some((item) => item.severity === "error" && (item.code.includes("Forbidden") || item.code.includes("Blocked")))) {
    return "blocked";
  }
  if (!intent.requires_tts || intent.allowed_audience === "developer" && !policy.debug_tts_enabled) {
    return "display_only";
  }
  return filtered.redacted || issues.some((item) => item.severity === "warning") ? "redacted" : "approved";
}

function buildApprovedUtterance(
  intent: MonologueIntent,
  message: string,
  claims: readonly GroundedClaimRecord[],
  request: MonologueTransitionRequest,
  disposition: MonologueFilterDisposition,
  removedClaimRefs: readonly Ref[],
): ApprovedMonologueUtterance {
  const compressed = compressUtterance(message, intent.priority, request.policy?.max_utterance_chars ?? DEFAULT_MAX_UTTERANCE_CHARS);
  const base = {
    utterance_ref: makeRef("monologue_utterance", intent.monologue_intent_ref, request.occurred_at_ms),
    source_intent_ref: intent.monologue_intent_ref,
    final_message: compressed,
    utterance_class: intent.utterance_class,
    priority: intent.priority,
    tts_profile_ref: disposition === "display_only" ? undefined : request.tts_profile.tts_profile_ref,
    playback_policy_ref: request.playback_policy.playback_policy_ref,
    grounding_summary_refs: uniqueRefs([...claims.map((claim) => claim.claim_ref), ...claims.flatMap((claim) => claim.source_evidence_refs)]),
    redaction_report_ref: removedClaimRefs.length > 0 || disposition === "redacted" ? makeRef("monologue_redaction", intent.monologue_intent_ref, request.occurred_at_ms) : undefined,
    acoustic_suppression_marker_required: request.playback_policy.require_acoustic_suppression_marker && disposition !== "display_only",
    display_only: disposition === "display_only",
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function buildTTSRequest(utterance: ApprovedMonologueUtterance, request: MonologueTransitionRequest): TTSRequest {
  const durationEstimate = estimateSpeechDurationMs(utterance.final_message, request.tts_profile);
  const deadline = request.occurred_at_ms + Math.min(durationEstimate, request.tts_profile.max_utterance_duration_ms);
  const base = {
    tts_request_ref: makeRef("tts_request", utterance.utterance_ref, request.occurred_at_ms),
    utterance_ref: utterance.utterance_ref,
    message: utterance.final_message,
    tts_profile: request.tts_profile,
    playback_policy_ref: request.playback_policy.playback_policy_ref,
    speaker_device_ref: request.playback_policy.speaker_device_ref,
    requested_start_ms: request.occurred_at_ms,
    deadline_ms: deadline,
    acoustic_suppression_marker_ref: makeRef("tts_acoustic_marker", utterance.utterance_ref, request.occurred_at_ms),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function buildAcousticSuppressionMarker(request: TTSRequest, profile: TTSProfile): AcousticSuppressionMarker {
  const base = {
    marker_ref: request.acoustic_suppression_marker_ref,
    utterance_ref: request.utterance_ref,
    speaker_device_ref: request.speaker_device_ref,
    expected_start_ms: request.requested_start_ms,
    expected_end_ms: request.deadline_ms,
    suppression_route_ref: makeRef("acoustic_suppression", request.speaker_device_ref, profile.language),
    reason: "self_generated_tts" as const,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function makeScheduleReport(
  scheduleDecision: MonologueScheduleDecision,
  utterance: ApprovedMonologueUtterance | undefined,
  ttsRequest: TTSRequest | undefined,
  acousticMarker: AcousticSuppressionMarker | undefined,
  interruptedPlayback: TTSPlaybackEvent | undefined,
  queuedUtterances: readonly QueuedMonologueUtterance[],
  reason: string,
): MonologueScheduleReport {
  const base = {
    schedule_decision: scheduleDecision,
    approved_utterance: utterance,
    tts_request: ttsRequest,
    acoustic_suppression_marker: acousticMarker,
    interrupted_playback_event: interruptedPlayback,
    queued_utterances: freezeArray(queuedUtterances),
    reason,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function makeReport(
  decision: MonologueTransitionDecision,
  selectedIntentRef: Ref | undefined,
  filterReport: MonologueFilterDecisionReport | undefined,
  scheduleReport: MonologueScheduleReport,
  transitionEvent: OrchestrationEventEnvelope,
  gate: MonologueExecutionGate,
  filterReports: readonly MonologueFilterDecisionReport[],
  issues: readonly ValidationIssue[],
): MonologueTransitionCoordinatorReport {
  const base = {
    schema_version: MONOLOGUE_TRANSITION_COORDINATOR_SCHEMA_VERSION,
    coordinator_version: MONOLOGUE_TRANSITION_COORDINATOR_VERSION,
    decision,
    selected_intent_ref: selectedIntentRef,
    approved_utterance: scheduleReport.approved_utterance ?? filterReport?.approved_utterance,
    tts_request: scheduleReport.tts_request,
    acoustic_suppression_marker: scheduleReport.acoustic_suppression_marker,
    playback_event: scheduleReport.interrupted_playback_event,
    transition_event: transitionEvent,
    monologue_gate: gate,
    filter_reports: freezeArray(filterReports),
    schedule_report: scheduleReport,
    issue_count: issues.length,
    error_count: issues.filter((item) => item.severity === "error").length,
    warning_count: issues.filter((item) => item.severity === "warning").length,
    issues: freezeArray(issues),
    traceability_ref: CONTRACT_TRACEABILITY_REF,
    supporting_monologue_blueprint: SUPPORTING_MONOLOGUE_BLUEPRINT_REF,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function normalizePlaybackEvent(playback: TTSPlaybackEvent, request: TTSRequest): TTSPlaybackEvent {
  const base = {
    ...playback,
    utterance_ref: request.utterance_ref,
    speaker_device_ref: request.speaker_device_ref,
    audio_leakage_marker_ref: playback.audio_leakage_marker_ref ?? request.acoustic_suppression_marker_ref,
    operator_visible_text_ref: playback.operator_visible_text_ref || makeRef("operator_text", request.utterance_ref),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function makePlaybackEvent(
  utteranceRef: Ref,
  status: TTSPlaybackStatus,
  speakerDeviceRef: Ref,
  acousticMarkerRef: Ref | undefined,
  startMs: number | undefined,
  endMs: number | undefined,
  failureReason: string | undefined,
): TTSPlaybackEvent {
  const base = {
    tts_playback_ref: makeRef("tts_playback", utteranceRef, status, endMs),
    utterance_ref: utteranceRef,
    speaker_device_ref: speakerDeviceRef,
    playback_start_time_ms: startMs,
    playback_end_time_ms: endMs,
    playback_status: status,
    audio_leakage_marker_ref: acousticMarkerRef,
    operator_visible_text_ref: makeRef("operator_text", utteranceRef),
    failure_reason: failureReason,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function enqueue(
  existing: readonly QueuedMonologueUtterance[],
  utterance: ApprovedMonologueUtterance,
  queuedAtMs: number,
  policy: MonologueCoordinatorPolicy,
): readonly QueuedMonologueUtterance[] {
  const queued = Object.freeze({
    utterance_ref: utterance.utterance_ref,
    source_intent_ref: utterance.source_intent_ref,
    final_message: utterance.final_message,
    utterance_class: utterance.utterance_class,
    priority: utterance.priority,
    queued_at_ms: queuedAtMs,
  });
  return freezeArray([...existing, queued].sort((left, right) => priorityRank(right.priority) - priorityRank(left.priority) || left.queued_at_ms - right.queued_at_ms).slice(0, policy.max_queue_depth));
}

function shouldInterrupt(active: ActiveTTSPlayback, utterance: ApprovedMonologueUtterance): boolean {
  if (active.interruptibility !== "interruptible") {
    return false;
  }
  return priorityRank(utterance.priority) >= priorityRank("urgent") && priorityRank(utterance.priority) > priorityRank(active.priority);
}

function isSafetyPriority(priority: MonologuePriority): boolean {
  return priority === "urgent" || priority === "blocking";
}

function isRepeatedRoutineUtterance(
  utterance: ApprovedMonologueUtterance,
  context: MonologueQueueContext,
  occurredAtMs: number,
  policy: MonologueCoordinatorPolicy,
): boolean {
  if (priorityRank(utterance.priority) >= priorityRank("high")) {
    return false;
  }
  return context.recent_utterances.some((recent) => recent.final_message === utterance.final_message && occurredAtMs - recent.queued_at_ms <= policy.identical_suppression_window_ms);
}

function recentIntentRepeated(intent: MonologueIntent, context: MonologueQueueContext, occurredAtMs: number, policy: MonologueCoordinatorPolicy): boolean {
  return context.recent_utterances.some((recent) => recent.source_intent_ref === intent.monologue_intent_ref && occurredAtMs - recent.queued_at_ms <= policy.identical_suppression_window_ms);
}

function eventTypeForDecision(decision: MonologueTransitionDecision, scheduleReport: MonologueScheduleReport): OrchestrationEventEnvelope["event_type"] {
  if (decision === "safe_hold_required") {
    return "SafeHoldCommanded";
  }
  if (decision === "interrupted" || scheduleReport.interrupted_playback_event !== undefined) {
    return "SpeechInterrupted";
  }
  if (decision === "tts_request_ready") {
    return "MonologueReady";
  }
  if (decision === "display_only" || decision === "skipped_by_policy") {
    return "SpeechCompleted";
  }
  return "SpeechFailed";
}

function severityForDecision(decision: MonologueTransitionDecision, issues: readonly ValidationIssue[]): EventSeverity {
  if (decision === "safe_hold_required") {
    return "critical";
  }
  if (decision === "blocked" || issues.some((item) => item.severity === "error")) {
    return "error";
  }
  if (decision === "display_only" || decision === "skipped_by_policy" || issues.some((item) => item.severity === "warning")) {
    return "warning";
  }
  return "info";
}

function summaryForDecision(decision: MonologueTransitionDecision, reason: string): string {
  if (decision === "tts_request_ready") {
    return compactText(`Monologue TTS request is ready. ${reason}`);
  }
  if (decision === "display_only") {
    return compactText(`Monologue rendered dashboard-only. ${reason}`);
  }
  if (decision === "skipped_by_policy") {
    return compactText(`Monologue speech skipped by policy. ${reason}`);
  }
  if (decision === "interrupted") {
    return compactText(`Monologue speech interrupted for safety or higher priority. ${reason}`);
  }
  if (decision === "safe_hold_required") {
    return compactText(`Monologue transition requires SafeHold. ${reason}`);
  }
  return compactText(`Monologue transition blocked. ${reason}`);
}

function gateStatusForDecision(decision: MonologueTransitionDecision, scheduleReport: MonologueScheduleReport): MonologueExecutionStatus {
  if (decision === "tts_request_ready") {
    return "completed";
  }
  if (decision === "display_only" || decision === "skipped_by_policy") {
    return "skipped_by_policy";
  }
  if (decision === "interrupted" || scheduleReport.interrupted_playback_event !== undefined) {
    return "interrupted";
  }
  if (decision === "blocked" || decision === "safe_hold_required") {
    return "failed";
  }
  return "missing";
}

function compressUtterance(message: string, priority: MonologuePriority, maxChars: number): string {
  const normalized = compactText(message);
  if (normalized.length <= maxChars || priority === "blocking" || priority === "urgent") {
    return normalized.slice(0, Math.max(maxChars, 80));
  }
  const clipped = normalized.slice(0, Math.max(40, maxChars - 1)).trim();
  const lastBoundary = Math.max(clipped.lastIndexOf("."), clipped.lastIndexOf(";"), clipped.lastIndexOf(","));
  return (lastBoundary >= 40 ? clipped.slice(0, lastBoundary + 1) : clipped).trim();
}

function estimateSpeechDurationMs(message: string, profile: TTSProfile): number {
  const words = message.trim().split(/\s+/).filter((word) => word.length > 0).length;
  const wordsPerMinute = profile.speaking_rate === "slow" ? 120 : profile.speaking_rate === "fast" ? 190 : 155;
  return Math.ceil((words / wordsPerMinute) * 60_000) + 150;
}

function priorityRank(priority: MonologuePriority): number {
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

function mergePolicy(policy: Partial<MonologueCoordinatorPolicy> | undefined): MonologueCoordinatorPolicy {
  return Object.freeze({
    require_plan_validation: policy?.require_plan_validation ?? true,
    allow_skip_when_noncritical: policy?.allow_skip_when_noncritical ?? true,
    allow_display_only_when_muted: policy?.allow_display_only_when_muted ?? true,
    block_on_firewall_warning: policy?.block_on_firewall_warning ?? false,
    max_utterance_chars: positiveInteger(policy?.max_utterance_chars, DEFAULT_MAX_UTTERANCE_CHARS),
    tts_start_target_ms: positiveInteger(policy?.tts_start_target_ms, DEFAULT_TTS_START_TARGET_MS),
    max_queue_depth: positiveInteger(policy?.max_queue_depth, DEFAULT_MAX_QUEUE_DEPTH),
    identical_suppression_window_ms: positiveInteger(policy?.identical_suppression_window_ms, DEFAULT_IDENTICAL_SUPPRESSION_WINDOW_MS),
    interrupt_latency_budget_ms: positiveInteger(policy?.interrupt_latency_budget_ms, DEFAULT_INTERRUPT_LATENCY_BUDGET_MS),
    debug_tts_enabled: policy?.debug_tts_enabled ?? false,
    operator_tts_muted: policy?.operator_tts_muted ?? false,
  });
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function validateSafeText(value: string, path: string, required: boolean, issues: ValidationIssue[]): void {
  if (required && value.trim().length === 0) {
    issues.push(issue("error", "MonologueTextRequired", path, "Monologue text is required.", "Provide concise public narration text."));
    return;
  }
  if (FORBIDDEN_MONOLOGUE_TEXT_PATTERN.test(value)) {
    issues.push(issue("error", "MonologueTextForbidden", path, "Monologue text contains hidden truth, prompt-private material, restricted control data, or safety-bypass wording.", "Use evidence-grounded public narration only."));
  }
}

function validateRef(ref: Ref | undefined, path: string, issues: ValidationIssue[]): void {
  if (ref === undefined || ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(issue("error", "ReferenceInvalid", path, "Reference must be present, non-empty, and whitespace-free.", "Use a stable opaque reference."));
    return;
  }
  if (FORBIDDEN_MONOLOGUE_TEXT_PATTERN.test(ref)) {
    issues.push(issue("error", "MonologueReferenceForbidden", path, "Reference contains forbidden monologue-boundary wording.", "Use opaque prompt-safe refs."));
  }
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 1_000);
}

function issue(severity: ValidationSeverity, code: string, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function makeRef(...parts: readonly (string | number | undefined)[]): Ref {
  const normalized = parts
    .filter((part): part is string | number => part !== undefined)
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "ref:empty";
}

function uniqueRefs(items: readonly (Ref | undefined)[]): readonly Ref[] {
  return freezeArray([...new Set(items.filter((item): item is Ref => item !== undefined && item.trim().length > 0))]);
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

export const MONOLOGUE_TRANSITION_COORDINATOR_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: MONOLOGUE_TRANSITION_COORDINATOR_SCHEMA_VERSION,
  blueprint: "architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md",
  supporting_blueprint: SUPPORTING_MONOLOGUE_BLUEPRINT_REF,
  sections: freezeArray(["8.3", "8.5", "8.7", "8.9.7", "8.10", "8.14", "8.15", "8.16", "8.17", "8.18", "8.19"]),
  traceability_ref: CONTRACT_TRACEABILITY_REF,
  normal_exits: freezeArray(["Execute", "SafeHold"] as readonly PrimaryState[]),
});
