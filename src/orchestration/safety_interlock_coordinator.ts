/**
 * Safety interlock coordinator for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md`
 * sections 8.3, 8.5, 8.7, 8.8, 8.9.7, 8.9.8, 8.9.14, 8.10, 8.14,
 * 8.15, 8.16, 8.17, and 8.18.
 *
 * This module implements the executable `SafetyInterlockCoordinator`. It turns
 * force, speed, collision-risk, controller, sensor, operator, retry, speech, and
 * policy interlock signals into File 08 safety preemption events. It can
 * interrupt Monologue, Execute, Plan, Verify, Correct, AudioAttend, ToolAssess,
 * and every other primary state into SafeHold or Abort while preserving
 * prompt-safe evidence and deterministic replay records.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import type {
  EventSeverity,
  OrchestrationEventEnvelope,
  OrchestrationEventType,
  PrimaryState,
  RuntimeStateSnapshot,
  SafetyMode,
} from "./orchestration_state_machine";

export const SAFETY_INTERLOCK_COORDINATOR_SCHEMA_VERSION = "mebsuta.safety_interlock_coordinator.v1" as const;
export const SAFETY_INTERLOCK_COORDINATOR_VERSION = "1.0.0" as const;

const CONTRACT_TRACEABILITY_REF = "architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md#SafetyInterlockCoordinator" as const;
const DEFAULT_FORCE_LIMIT_N = 35;
const DEFAULT_SPEED_LIMIT_MPS = 0.8;
const DEFAULT_CRITICAL_RISK_THRESHOLD = 0.9;
const DEFAULT_BLOCKING_RISK_THRESHOLD = 0.65;
const DEFAULT_SIGNAL_STALENESS_MS = 1_000;
const FORBIDDEN_SAFETY_TEXT_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|qa_|hidden state|collision_mesh|rigid_body_handle|physics_body|exact_com|world_pose|direct actuator|raw actuator|joint torque stream|gemini_direct|ignore safety|override safety|disable safe-hold|skip validation|reward policy|reinforcement learning|policy gradient|system prompt|developer prompt|chain-of-thought|scratchpad)/i;

export type SafetyInterlockKind =
  | "force_limit"
  | "speed_limit"
  | "collision_risk"
  | "controller_fault"
  | "sensor_loss"
  | "operator_pause"
  | "operator_abort"
  | "speech_safety"
  | "planning_safety"
  | "verification_safety"
  | "firewall_leak"
  | "retry_exhaustion"
  | "manual_safe_hold"
  | "manual_abort";
export type SafetyInterlockSeverity = "notice" | "caution" | "blocking" | "critical";
export type SafetyPreemptionDecision =
  | "continue_with_caution"
  | "command_safe_hold"
  | "command_abort"
  | "block_new_action"
  | "resume_not_allowed";
export type SafetyInterruptAction = "cancel_async_request" | "pause_primitive" | "stop_speech" | "block_command_admission" | "preserve_evidence";
export type SafetyResumeIntent = "fresh_observation" | "replan" | "correct" | "human_review" | "abort";
export type SafetyResumeDecisionKind = "resume_to_observe" | "resume_to_plan" | "resume_to_correct" | "resume_to_human_review" | "abort_session" | "resume_blocked";
export type SafeHoldCommandMode = "hold_posture" | "zero_velocity" | "release_tool_if_safe" | "disable_new_commands";

/**
 * A prompt-safe safety signal emitted by SafetyManager, controllers, monitors,
 * operator UI, or state guards. Numeric fields use canonical File 03 units.
 */
export interface SafetyInterlockSignal {
  readonly signal_ref: Ref;
  readonly kind: SafetyInterlockKind;
  readonly severity: SafetyInterlockSeverity;
  readonly source_component: string;
  readonly observed_at_ms: number;
  readonly evidence_refs: readonly Ref[];
  readonly human_summary: string;
  readonly force_n?: number;
  readonly speed_mps?: number;
  readonly risk_score?: number;
  readonly active_request_ref?: Ref;
}

/**
 * Runtime policy for the universal File 08 safety-preemption guard. Defaults
 * prioritize SafeHold, speech interruption, and operator abort authority.
 */
export interface SafetyInterlockPolicy {
  readonly force_limit_n: number;
  readonly speed_limit_mps: number;
  readonly critical_risk_threshold: number;
  readonly blocking_risk_threshold: number;
  readonly signal_staleness_ms: number;
  readonly safe_hold_on_sensor_loss: boolean;
  readonly abort_on_operator_abort: boolean;
  readonly allow_monologue_interrupt: boolean;
  readonly allow_planning_interrupt: boolean;
  readonly allow_verification_interrupt: boolean;
}

export interface SafetyInterlockEvaluationRequest {
  readonly snapshot: RuntimeStateSnapshot;
  readonly signals: readonly SafetyInterlockSignal[];
  readonly occurred_at_ms: number;
  readonly policy?: Partial<SafetyInterlockPolicy>;
  readonly active_request_ref?: Ref;
  readonly payload_refs?: readonly Ref[];
}

export interface SafetyPreemptionGuardResult {
  readonly guard_name: "SafetyInterlockGuard";
  readonly decision: "clear" | "caution" | "blocked" | "abort";
  readonly blocking: boolean;
  readonly reason: string;
  readonly evidence_refs: readonly Ref[];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface SafetyInterlockDecisionReport {
  readonly schema_version: typeof SAFETY_INTERLOCK_COORDINATOR_SCHEMA_VERSION;
  readonly coordinator_version: typeof SAFETY_INTERLOCK_COORDINATOR_VERSION;
  readonly decision: SafetyPreemptionDecision;
  readonly safety_mode: SafetyMode;
  readonly target_state?: PrimaryState;
  readonly transition_event?: OrchestrationEventEnvelope;
  readonly dominant_signal?: SafetyInterlockSignal;
  readonly cancel_request_refs: readonly Ref[];
  readonly pause_request_refs: readonly Ref[];
  readonly interrupt_speech: boolean;
  readonly interrupt_actions: readonly SafetyInterruptAction[];
  readonly guard_result: SafetyPreemptionGuardResult;
  readonly issue_count: number;
  readonly error_count: number;
  readonly warning_count: number;
  readonly issues: readonly ValidationIssue[];
  readonly traceability_ref: typeof CONTRACT_TRACEABILITY_REF;
  readonly determinism_hash: string;
}

export interface SafeHoldWorkOrder {
  readonly schema_version: typeof SAFETY_INTERLOCK_COORDINATOR_SCHEMA_VERSION;
  readonly work_order_ref: Ref;
  readonly session_ref: Ref;
  readonly task_ref: Ref;
  readonly reason: string;
  readonly entered_from_state: PrimaryState;
  readonly active_plan_ref?: Ref;
  readonly active_primitive_ref?: Ref;
  readonly latest_observation_ref?: Ref;
  readonly safety_mode: "SafeHoldRequired" | "AbortRequired";
  readonly command_modes: readonly SafeHoldCommandMode[];
  readonly evidence_refs: readonly Ref[];
  readonly stop_new_motion: true;
  readonly preserve_logs: true;
  readonly human_visible_summary: string;
  readonly determinism_hash: string;
}

export interface SafetyResumeRequest {
  readonly safe_hold_snapshot: RuntimeStateSnapshot;
  readonly resume_intent: SafetyResumeIntent;
  readonly operator_event_ref: Ref;
  readonly operator_decision_summary: string;
  readonly occurred_at_ms: number;
  readonly active_signals?: readonly SafetyInterlockSignal[];
  readonly cleared_signal_refs?: readonly Ref[];
  readonly latest_observation_ref?: Ref;
  readonly allow_replan_without_fresh_observation?: boolean;
}

export interface SafetyResumeDecision {
  readonly schema_version: typeof SAFETY_INTERLOCK_COORDINATOR_SCHEMA_VERSION;
  readonly decision: SafetyResumeDecisionKind;
  readonly target_state?: PrimaryState;
  readonly transition_event?: OrchestrationEventEnvelope;
  readonly guard_result: SafetyPreemptionGuardResult;
  readonly required_next_observation: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly traceability_ref: typeof CONTRACT_TRACEABILITY_REF;
  readonly determinism_hash: string;
}

/**
 * Deterministic coordinator for universal safety preemption and SafeHold resume
 * checks. It produces events for the state machine, but does not commit state.
 */
export class SafetyInterlockCoordinator {
  /**
   * Evaluates active interlock signals and emits a SafeHold, Abort, caution, or
   * block-new-action decision. All payloads remain prompt-safe references.
   */
  public evaluateSafetyInterlocks(request: SafetyInterlockEvaluationRequest): SafetyInterlockDecisionReport {
    const policy = mergePolicy(request.policy);
    const issues = validateEvaluationRequest(request, policy);
    const dominantSignal = chooseDominantSignal(request.snapshot, request.signals, policy);
    const decision = chooseDecision(request.snapshot, dominantSignal, request.signals, policy, issues);
    const targetState = targetStateFor(decision);
    const transitionEvent = targetState === undefined || dominantSignal === undefined
      ? undefined
      : buildTransitionEvent(request, dominantSignal, targetState, decision);
    const cancelRefs = cancellationRefs(request.snapshot, request, decision);
    const pauseRefs = pauseRefsFor(request.snapshot, dominantSignal, decision);
    const interruptActions = interruptActionsFor(request.snapshot.primary_state, decision);
    const guardResult = makeGuardResult(decision, dominantSignal, request, issues);
    return makeDecisionReport(
      decision,
      safetyModeFor(decision, request.snapshot.safety_mode),
      targetState,
      transitionEvent,
      dominantSignal,
      cancelRefs,
      pauseRefs,
      interruptActions,
      guardResult,
      issues,
    );
  }

  /**
   * Convenience API matching File 08's architecture signature for immediate
   * safety preemption from a single safety event.
   */
  public interruptForSafety(
    currentSnapshot: RuntimeStateSnapshot,
    safetyEvent: SafetyInterlockSignal,
    safetyPolicy: Partial<SafetyInterlockPolicy> = {},
  ): SafetyInterlockDecisionReport {
    return this.evaluateSafetyInterlocks({
      snapshot: currentSnapshot,
      signals: freezeArray([safetyEvent]),
      occurred_at_ms: safetyEvent.observed_at_ms,
      policy: safetyPolicy,
      active_request_ref: safetyEvent.active_request_ref,
      payload_refs: safetyEvent.evidence_refs,
    });
  }

  /**
   * Creates a deterministic SafeHold work order for SafetyManager and the
   * control stack. The work order stops new motion and preserves audit evidence.
   */
  public buildSafeHoldWorkOrder(report: SafetyInterlockDecisionReport, snapshot: RuntimeStateSnapshot): SafeHoldWorkOrder {
    const reason = report.dominant_signal?.human_summary ?? report.guard_result.reason;
    const evidenceRefs = uniqueRefs([
      ...report.guard_result.evidence_refs,
      snapshot.active_plan_ref,
      snapshot.active_primitive_ref,
      snapshot.latest_observation_ref,
      snapshot.latest_verification_ref,
    ]);
    const base = {
      schema_version: SAFETY_INTERLOCK_COORDINATOR_SCHEMA_VERSION,
      work_order_ref: makeRef("safe_hold_work_order", snapshot.session_ref, snapshot.task_ref, snapshot.primary_state, report.decision, snapshot.updated_at_ms),
      session_ref: snapshot.session_ref,
      task_ref: snapshot.task_ref,
      reason: compactText(reason),
      entered_from_state: snapshot.primary_state,
      active_plan_ref: snapshot.active_plan_ref,
      active_primitive_ref: snapshot.active_primitive_ref,
      latest_observation_ref: snapshot.latest_observation_ref,
      safety_mode: report.decision === "command_abort" ? "AbortRequired" as const : "SafeHoldRequired" as const,
      command_modes: freezeArray(commandModesFor(report)),
      evidence_refs: evidenceRefs,
      stop_new_motion: true as const,
      preserve_logs: true as const,
      human_visible_summary: compactText(`Safety interlock ${report.decision}; ${reason}`),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Evaluates whether SafeHold can exit. File 08 requires resume to prefer a
   * fresh Observe path and forbids direct execution of an old primitive.
   */
  public resumeFromSafeHold(request: SafetyResumeRequest): SafetyResumeDecision {
    const policy = mergePolicy(undefined);
    const issues = validateResumeRequest(request);
    const activeReport = request.active_signals === undefined || request.active_signals.length === 0
      ? undefined
      : this.evaluateSafetyInterlocks({
          snapshot: request.safe_hold_snapshot,
          signals: request.active_signals,
          occurred_at_ms: request.occurred_at_ms,
          policy,
        });
    const targetState = resumeTargetFor(request, activeReport, issues);
    const decision = resumeDecisionFor(targetState, activeReport, issues);
    const event = targetState === undefined
      ? undefined
      : buildResumeEvent(request, targetState);
    const guardResult = resumeGuardResult(request, decision, activeReport, issues);
    const base = {
      schema_version: SAFETY_INTERLOCK_COORDINATOR_SCHEMA_VERSION,
      decision,
      target_state: targetState,
      transition_event: event,
      guard_result: guardResult,
      required_next_observation: targetState === "Observe",
      issues: freezeArray(issues),
      traceability_ref: CONTRACT_TRACEABILITY_REF,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }
}

function chooseDominantSignal(
  snapshot: RuntimeStateSnapshot,
  signals: readonly SafetyInterlockSignal[],
  policy: SafetyInterlockPolicy,
): SafetyInterlockSignal | undefined {
  if (snapshot.safety_mode === "AbortRequired") {
    return syntheticModeSignal(snapshot, "manual_abort", "critical", "Snapshot safety mode already requires Abort.");
  }
  if (snapshot.safety_mode === "SafeHoldRequired") {
    return syntheticModeSignal(snapshot, "manual_safe_hold", "blocking", "Snapshot safety mode already requires SafeHold.");
  }
  const scored = signals.map((signal) => ({ signal, score: signalPriority(signal, policy) }));
  scored.sort((left, right) => right.score - left.score || left.signal.observed_at_ms - right.signal.observed_at_ms || left.signal.signal_ref.localeCompare(right.signal.signal_ref));
  return scored[0]?.signal;
}

function signalPriority(signal: SafetyInterlockSignal, policy: SafetyInterlockPolicy): number {
  let score = severityRank(signal.severity) * 100;
  if (signal.kind === "operator_abort" || signal.kind === "manual_abort") {
    score += 80;
  }
  if (signal.kind === "force_limit" && signal.force_n !== undefined && signal.force_n >= policy.force_limit_n) {
    score += 50;
  }
  if (signal.kind === "speed_limit" && signal.speed_mps !== undefined && signal.speed_mps >= policy.speed_limit_mps) {
    score += 50;
  }
  if (signal.risk_score !== undefined) {
    score += Math.round(Math.max(0, Math.min(1, signal.risk_score)) * 40);
  }
  return score;
}

function chooseDecision(
  snapshot: RuntimeStateSnapshot,
  dominantSignal: SafetyInterlockSignal | undefined,
  signals: readonly SafetyInterlockSignal[],
  policy: SafetyInterlockPolicy,
  issues: readonly ValidationIssue[],
): SafetyPreemptionDecision {
  if (issues.some((item) => item.severity === "error" && item.code !== "SafetySignalStale")) {
    return snapshot.primary_state === "SafeHold" ? "resume_not_allowed" : "command_safe_hold";
  }
  if (snapshot.safety_mode === "AbortRequired") {
    return "command_abort";
  }
  if (snapshot.safety_mode === "SafeHoldRequired") {
    return snapshot.primary_state === "SafeHold" ? "resume_not_allowed" : "command_safe_hold";
  }
  if (dominantSignal === undefined) {
    return "continue_with_caution";
  }
  if (requiresAbort(dominantSignal, policy) || signals.some((signal) => requiresAbort(signal, policy))) {
    return "command_abort";
  }
  if (requiresSafeHold(dominantSignal, policy) || signals.some((signal) => requiresSafeHold(signal, policy))) {
    return "command_safe_hold";
  }
  if (dominantSignal.severity === "caution" || (dominantSignal.risk_score ?? 0) >= policy.blocking_risk_threshold) {
    return isActionBearingState(snapshot.primary_state) ? "block_new_action" : "continue_with_caution";
  }
  return "continue_with_caution";
}

function requiresAbort(signal: SafetyInterlockSignal, policy: SafetyInterlockPolicy): boolean {
  return signal.kind === "manual_abort"
    || (signal.kind === "operator_abort" && policy.abort_on_operator_abort)
    || signal.severity === "critical"
    || (signal.risk_score !== undefined && signal.risk_score >= policy.critical_risk_threshold);
}

function requiresSafeHold(signal: SafetyInterlockSignal, policy: SafetyInterlockPolicy): boolean {
  if (signal.severity === "blocking") {
    return true;
  }
  if (signal.kind === "manual_safe_hold" || signal.kind === "operator_pause" || signal.kind === "collision_risk" || signal.kind === "controller_fault" || signal.kind === "firewall_leak" || signal.kind === "retry_exhaustion") {
    return true;
  }
  if (signal.kind === "sensor_loss" && policy.safe_hold_on_sensor_loss) {
    return true;
  }
  if (signal.kind === "force_limit" && signal.force_n !== undefined && signal.force_n >= policy.force_limit_n) {
    return true;
  }
  if (signal.kind === "speed_limit" && signal.speed_mps !== undefined && signal.speed_mps >= policy.speed_limit_mps) {
    return true;
  }
  return (signal.risk_score ?? 0) >= policy.blocking_risk_threshold;
}

function targetStateFor(decision: SafetyPreemptionDecision): PrimaryState | undefined {
  if (decision === "command_abort") {
    return "Abort";
  }
  if (decision === "command_safe_hold" || decision === "resume_not_allowed") {
    return "SafeHold";
  }
  return undefined;
}

function buildTransitionEvent(
  request: SafetyInterlockEvaluationRequest,
  signal: SafetyInterlockSignal,
  targetState: PrimaryState,
  decision: SafetyPreemptionDecision,
): OrchestrationEventEnvelope {
  const eventType = eventTypeForSafety(request.snapshot.primary_state, signal, targetState);
  const payloadRefs = uniqueRefs([
    ...(request.payload_refs ?? []),
    signal.signal_ref,
    ...signal.evidence_refs,
    signal.active_request_ref,
    request.active_request_ref,
    request.snapshot.active_plan_ref,
    request.snapshot.active_primitive_ref,
    request.snapshot.latest_observation_ref,
    request.snapshot.latest_verification_ref,
  ]);
  const base = {
    event_ref: makeRef("event", "safety_interlock", signal.kind, targetState, signal.signal_ref, request.occurred_at_ms),
    event_type: eventType,
    event_family: "safety" as const,
    severity: eventSeverityFor(decision, signal),
    session_ref: request.snapshot.session_ref,
    task_ref: request.snapshot.task_ref,
    source_state_ref: request.snapshot.primary_state,
    context_ref: request.snapshot.current_context_ref,
    payload_refs: payloadRefs,
    provenance_classes: freezeArray(["safety", "telemetry", "controller", "operator"] as const),
    occurred_at_ms: request.occurred_at_ms,
    human_summary: compactText(`${signal.kind} safety interlock routes ${request.snapshot.primary_state} to ${targetState}. ${signal.human_summary}`),
    target_state_hint: targetState,
    plan_ref: request.snapshot.active_plan_ref,
    primitive_ref: request.snapshot.active_primitive_ref,
    verification_ref: request.snapshot.latest_verification_ref,
    observation_ref: request.snapshot.latest_observation_ref,
    safety_mode_override: safetyModeFor(decision, request.snapshot.safety_mode),
  };
  return Object.freeze(base);
}

function eventTypeForSafety(sourceState: PrimaryState, signal: SafetyInterlockSignal, targetState: PrimaryState): OrchestrationEventType {
  if (targetState === "Abort") {
    return "AbortCommanded";
  }
  if (sourceState === "Execute" && signal.kind === "force_limit") {
    return "ForceLimitExceeded";
  }
  if (sourceState === "Execute" && signal.kind === "speed_limit") {
    return "SpeedLimitExceeded";
  }
  if (signal.kind === "retry_exhaustion") {
    return "RetryBudgetExhausted";
  }
  return "SafeHoldCommanded";
}

function eventSeverityFor(decision: SafetyPreemptionDecision, signal: SafetyInterlockSignal): EventSeverity {
  if (decision === "command_abort" || signal.severity === "critical") {
    return "critical";
  }
  if (decision === "command_safe_hold" || signal.severity === "blocking") {
    return "error";
  }
  if (decision === "block_new_action" || signal.severity === "caution") {
    return "warning";
  }
  return "notice";
}

function safetyModeFor(decision: SafetyPreemptionDecision, currentMode: SafetyMode): SafetyMode {
  if (decision === "command_abort") {
    return "AbortRequired";
  }
  if (decision === "command_safe_hold" || decision === "resume_not_allowed") {
    return "SafeHoldRequired";
  }
  if (decision === "block_new_action") {
    return "Blocked";
  }
  return currentMode === "Normal" ? "Caution" : currentMode;
}

function cancellationRefs(
  snapshot: RuntimeStateSnapshot,
  request: SafetyInterlockEvaluationRequest,
  decision: SafetyPreemptionDecision,
): readonly Ref[] {
  if (decision !== "command_safe_hold" && decision !== "command_abort" && decision !== "resume_not_allowed") {
    return freezeArray([]);
  }
  const cancelable = isAsyncState(snapshot.primary_state) ? request.active_request_ref : undefined;
  return uniqueRefs([cancelable, snapshot.active_plan_ref, ...request.signals.map((signal) => signal.active_request_ref)]);
}

function pauseRefsFor(
  snapshot: RuntimeStateSnapshot,
  signal: SafetyInterlockSignal | undefined,
  decision: SafetyPreemptionDecision,
): readonly Ref[] {
  if (decision !== "command_safe_hold" && decision !== "command_abort") {
    return freezeArray([]);
  }
  return snapshot.primary_state === "Execute" || snapshot.active_primitive_ref !== undefined
    ? uniqueRefs([snapshot.active_primitive_ref, signal?.active_request_ref])
    : freezeArray([]);
}

function interruptActionsFor(state: PrimaryState, decision: SafetyPreemptionDecision): readonly SafetyInterruptAction[] {
  if (decision === "continue_with_caution") {
    return freezeArray([]);
  }
  const actions: SafetyInterruptAction[] = ["preserve_evidence"];
  if (decision === "block_new_action") {
    actions.push("block_command_admission");
  }
  if (decision === "command_safe_hold" || decision === "command_abort" || decision === "resume_not_allowed") {
    actions.push("block_command_admission");
    if (state === "Execute") {
      actions.push("pause_primitive");
    }
    if (state === "Monologue") {
      actions.push("stop_speech");
    }
    if (isAsyncState(state)) {
      actions.push("cancel_async_request");
    }
  }
  return freezeArray(uniqueStrings(actions));
}

function makeGuardResult(
  decision: SafetyPreemptionDecision,
  dominantSignal: SafetyInterlockSignal | undefined,
  request: SafetyInterlockEvaluationRequest,
  issues: readonly ValidationIssue[],
): SafetyPreemptionGuardResult {
  const evidenceRefs = uniqueRefs([
    dominantSignal?.signal_ref,
    ...(dominantSignal?.evidence_refs ?? []),
    request.snapshot.active_primitive_ref,
    request.snapshot.latest_observation_ref,
    ...(request.payload_refs ?? []),
  ]);
  const guardDecision: SafetyPreemptionGuardResult["decision"] = decision === "command_abort"
    ? "abort"
    : decision === "command_safe_hold" || decision === "resume_not_allowed" || decision === "block_new_action"
      ? "blocked"
      : dominantSignal === undefined
        ? "clear"
        : "caution";
  const base = {
    guard_name: "SafetyInterlockGuard" as const,
    decision: guardDecision,
    blocking: guardDecision === "blocked" || guardDecision === "abort",
    reason: dominantSignal === undefined ? "No active safety interlock requires preemption." : compactText(dominantSignal.human_summary),
    evidence_refs: evidenceRefs,
    issues: freezeArray(issues),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function makeDecisionReport(
  decision: SafetyPreemptionDecision,
  safetyMode: SafetyMode,
  targetState: PrimaryState | undefined,
  transitionEvent: OrchestrationEventEnvelope | undefined,
  dominantSignal: SafetyInterlockSignal | undefined,
  cancelRefs: readonly Ref[],
  pauseRefs: readonly Ref[],
  interruptActions: readonly SafetyInterruptAction[],
  guardResult: SafetyPreemptionGuardResult,
  issues: readonly ValidationIssue[],
): SafetyInterlockDecisionReport {
  const base = {
    schema_version: SAFETY_INTERLOCK_COORDINATOR_SCHEMA_VERSION,
    coordinator_version: SAFETY_INTERLOCK_COORDINATOR_VERSION,
    decision,
    safety_mode: safetyMode,
    target_state: targetState,
    transition_event: transitionEvent,
    dominant_signal: dominantSignal,
    cancel_request_refs: freezeArray(cancelRefs),
    pause_request_refs: freezeArray(pauseRefs),
    interrupt_speech: interruptActions.includes("stop_speech"),
    interrupt_actions: freezeArray(interruptActions),
    guard_result: guardResult,
    issue_count: issues.length,
    error_count: issues.filter((item) => item.severity === "error").length,
    warning_count: issues.filter((item) => item.severity === "warning").length,
    issues: freezeArray(issues),
    traceability_ref: CONTRACT_TRACEABILITY_REF,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function commandModesFor(report: SafetyInterlockDecisionReport): readonly SafeHoldCommandMode[] {
  const modes: SafeHoldCommandMode[] = ["zero_velocity", "disable_new_commands", "hold_posture"];
  if (report.dominant_signal?.kind === "operator_abort" || report.dominant_signal?.kind === "manual_abort") {
    modes.push("release_tool_if_safe");
  }
  return freezeArray(uniqueStrings(modes));
}

function resumeTargetFor(
  request: SafetyResumeRequest,
  activeReport: SafetyInterlockDecisionReport | undefined,
  issues: readonly ValidationIssue[],
): PrimaryState | undefined {
  if (issues.some((item) => item.severity === "error")) {
    return undefined;
  }
  if (activeReport !== undefined && activeReport.decision !== "continue_with_caution") {
    return activeReport.target_state === "Abort" ? "Abort" : undefined;
  }
  if (request.resume_intent === "abort") {
    return "Abort";
  }
  if (request.resume_intent === "human_review") {
    return "HumanReview";
  }
  if (request.resume_intent === "correct") {
    return "Correct";
  }
  if (request.resume_intent === "replan" && request.allow_replan_without_fresh_observation === true && request.latest_observation_ref !== undefined) {
    return "Plan";
  }
  return "Observe";
}

function resumeDecisionFor(
  targetState: PrimaryState | undefined,
  activeReport: SafetyInterlockDecisionReport | undefined,
  issues: readonly ValidationIssue[],
): SafetyResumeDecisionKind {
  if (targetState === "Abort") {
    return "abort_session";
  }
  if (targetState === undefined || issues.some((item) => item.severity === "error") || (activeReport !== undefined && activeReport.decision !== "continue_with_caution")) {
    return "resume_blocked";
  }
  if (targetState === "HumanReview") {
    return "resume_to_human_review";
  }
  if (targetState === "Correct") {
    return "resume_to_correct";
  }
  if (targetState === "Plan") {
    return "resume_to_plan";
  }
  return "resume_to_observe";
}

function buildResumeEvent(request: SafetyResumeRequest, targetState: PrimaryState): OrchestrationEventEnvelope {
  const eventType: OrchestrationEventType = targetState === "Abort" ? "OperatorAbort" : "OperatorResume";
  const base = {
    event_ref: makeRef("event", "safe_hold_resume", request.operator_event_ref, targetState, request.occurred_at_ms),
    event_type: eventType,
    event_family: "operator" as const,
    severity: targetState === "Abort" ? "critical" as const : "notice" as const,
    session_ref: request.safe_hold_snapshot.session_ref,
    task_ref: request.safe_hold_snapshot.task_ref,
    source_state_ref: "SafeHold" as const,
    context_ref: request.safe_hold_snapshot.current_context_ref,
    payload_refs: uniqueRefs([
      request.operator_event_ref,
      ...(request.cleared_signal_refs ?? []),
      request.latest_observation_ref,
      request.safe_hold_snapshot.latest_observation_ref,
      request.safe_hold_snapshot.active_plan_ref,
    ]),
    provenance_classes: freezeArray(["operator", "safety", "telemetry"] as const),
    occurred_at_ms: request.occurred_at_ms,
    human_summary: compactText(`SafeHold resume intent ${request.resume_intent}: ${request.operator_decision_summary}`),
    target_state_hint: targetState,
    observation_ref: request.latest_observation_ref ?? request.safe_hold_snapshot.latest_observation_ref,
    plan_ref: targetState === "Plan" ? request.safe_hold_snapshot.active_plan_ref : undefined,
    safety_mode_override: targetState === "Abort" ? "AbortRequired" as const : "Normal" as const,
    operator_resume_target: targetState,
  };
  return Object.freeze(base);
}

function resumeGuardResult(
  request: SafetyResumeRequest,
  decision: SafetyResumeDecisionKind,
  activeReport: SafetyInterlockDecisionReport | undefined,
  issues: readonly ValidationIssue[],
): SafetyPreemptionGuardResult {
  const evidenceRefs = uniqueRefs([
    request.operator_event_ref,
    ...(request.cleared_signal_refs ?? []),
    request.latest_observation_ref,
    ...(activeReport?.guard_result.evidence_refs ?? []),
  ]);
  const guardDecision: SafetyPreemptionGuardResult["decision"] = decision === "abort_session"
    ? "abort"
    : decision === "resume_blocked"
      ? "blocked"
      : "clear";
  const base = {
    guard_name: "SafetyInterlockGuard" as const,
    decision: guardDecision,
    blocking: decision === "resume_blocked" || decision === "abort_session",
    reason: decision === "resume_blocked" ? "SafeHold resume is blocked by active safety state or invalid request." : "SafeHold resume guard accepted the requested recovery path.",
    evidence_refs: evidenceRefs,
    issues: freezeArray(issues),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function validateEvaluationRequest(request: SafetyInterlockEvaluationRequest, policy: SafetyInterlockPolicy): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateRef(request.snapshot.session_ref, "$.snapshot.session_ref", issues);
  validateRef(request.snapshot.task_ref, "$.snapshot.task_ref", issues);
  validateRef(request.snapshot.current_context_ref, "$.snapshot.current_context_ref", issues);
  if (!Number.isFinite(request.occurred_at_ms) || request.occurred_at_ms < 0) {
    issues.push(issue("error", "SafetyEventTimeInvalid", "$.occurred_at_ms", "Safety evaluation time must be finite and nonnegative.", "Use the scenario runtime clock."));
  }
  for (let index = 0; index < request.signals.length; index += 1) {
    validateSignal(request.signals[index], index, request.occurred_at_ms, policy, issues);
  }
  for (const [index, ref] of (request.payload_refs ?? []).entries()) {
    validateRef(ref, `$.payload_refs[${index}]`, issues);
  }
  return issues;
}

function validateSignal(
  signal: SafetyInterlockSignal,
  index: number,
  occurredAtMs: number,
  policy: SafetyInterlockPolicy,
  issues: ValidationIssue[],
): void {
  const path = `$.signals[${index}]`;
  validateRef(signal.signal_ref, `${path}.signal_ref`, issues);
  validateSafeText(signal.source_component, `${path}.source_component`, true, issues);
  validateSafeText(signal.human_summary, `${path}.human_summary`, true, issues);
  for (const [evidenceIndex, ref] of signal.evidence_refs.entries()) {
    validateRef(ref, `${path}.evidence_refs[${evidenceIndex}]`, issues);
  }
  if (!Number.isFinite(signal.observed_at_ms) || signal.observed_at_ms < 0) {
    issues.push(issue("error", "SafetySignalTimeInvalid", `${path}.observed_at_ms`, "Signal observation time must be finite and nonnegative.", "Use the scenario runtime clock."));
  }
  if (occurredAtMs - signal.observed_at_ms > policy.signal_staleness_ms) {
    issues.push(issue("warning", "SafetySignalStale", `${path}.observed_at_ms`, "Safety signal is stale relative to evaluation time.", "Refresh safety telemetry or remain conservative."));
  }
  validateOptionalNonnegative(signal.force_n, `${path}.force_n`, "ForceValueInvalid", issues);
  validateOptionalNonnegative(signal.speed_mps, `${path}.speed_mps`, "SpeedValueInvalid", issues);
  if (signal.risk_score !== undefined && (!Number.isFinite(signal.risk_score) || signal.risk_score < 0 || signal.risk_score > 1)) {
    issues.push(issue("error", "RiskScoreInvalid", `${path}.risk_score`, "Risk score must be finite in [0, 1].", "Clamp or recompute the safety risk score."));
  }
  if (signal.kind === "force_limit" && signal.force_n === undefined) {
    issues.push(issue("warning", "ForceSignalValueMissing", `${path}.force_n`, "Force limit signal lacks a force magnitude.", "Attach force telemetry in newtons when available."));
  }
  if (signal.kind === "speed_limit" && signal.speed_mps === undefined) {
    issues.push(issue("warning", "SpeedSignalValueMissing", `${path}.speed_mps`, "Speed limit signal lacks a speed magnitude.", "Attach speed telemetry in meters per second when available."));
  }
}

function validateResumeRequest(request: SafetyResumeRequest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateRef(request.safe_hold_snapshot.session_ref, "$.safe_hold_snapshot.session_ref", issues);
  validateRef(request.safe_hold_snapshot.task_ref, "$.safe_hold_snapshot.task_ref", issues);
  validateRef(request.operator_event_ref, "$.operator_event_ref", issues);
  validateSafeText(request.operator_decision_summary, "$.operator_decision_summary", true, issues);
  if (request.safe_hold_snapshot.primary_state !== "SafeHold") {
    issues.push(issue("error", "ResumeRequiresSafeHoldState", "$.safe_hold_snapshot.primary_state", "Resume guard can only run from SafeHold.", "Route through SafeHold before resume."));
  }
  if (request.resume_intent === "replan" && request.allow_replan_without_fresh_observation === true && request.latest_observation_ref === undefined) {
    issues.push(issue("error", "ResumePlanNeedsObservation", "$.latest_observation_ref", "Replan resume without Observe requires a fresh observation reference.", "Resume to Observe first or attach a current observation."));
  }
  if (!Number.isFinite(request.occurred_at_ms) || request.occurred_at_ms < 0) {
    issues.push(issue("error", "ResumeTimeInvalid", "$.occurred_at_ms", "Resume event time must be finite and nonnegative.", "Use the scenario runtime clock."));
  }
  for (const [index, ref] of (request.cleared_signal_refs ?? []).entries()) {
    validateRef(ref, `$.cleared_signal_refs[${index}]`, issues);
  }
  return issues;
}

function mergePolicy(policy: Partial<SafetyInterlockPolicy> | undefined): SafetyInterlockPolicy {
  return Object.freeze({
    force_limit_n: finitePositive(policy?.force_limit_n, DEFAULT_FORCE_LIMIT_N),
    speed_limit_mps: finitePositive(policy?.speed_limit_mps, DEFAULT_SPEED_LIMIT_MPS),
    critical_risk_threshold: finiteUnit(policy?.critical_risk_threshold, DEFAULT_CRITICAL_RISK_THRESHOLD),
    blocking_risk_threshold: finiteUnit(policy?.blocking_risk_threshold, DEFAULT_BLOCKING_RISK_THRESHOLD),
    signal_staleness_ms: finitePositive(policy?.signal_staleness_ms, DEFAULT_SIGNAL_STALENESS_MS),
    safe_hold_on_sensor_loss: policy?.safe_hold_on_sensor_loss ?? true,
    abort_on_operator_abort: policy?.abort_on_operator_abort ?? true,
    allow_monologue_interrupt: policy?.allow_monologue_interrupt ?? true,
    allow_planning_interrupt: policy?.allow_planning_interrupt ?? true,
    allow_verification_interrupt: policy?.allow_verification_interrupt ?? true,
  });
}

function finitePositive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function finiteUnit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function validateOptionalNonnegative(value: number | undefined, path: string, code: string, issues: ValidationIssue[]): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    issues.push(issue("error", code, path, "Value must be finite and nonnegative.", "Use canonical nonnegative telemetry units."));
  }
}

function validateRef(ref: Ref | undefined, path: string, issues: ValidationIssue[]): void {
  if (ref === undefined || ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(issue("error", "ReferenceInvalid", path, "Reference must be present, non-empty, and whitespace-free.", "Use a stable opaque reference."));
    return;
  }
  if (FORBIDDEN_SAFETY_TEXT_PATTERN.test(ref)) {
    issues.push(issue("error", "ReferenceForbiddenForSafetyInterlock", path, "Reference contains safety-boundary forbidden wording.", "Use an opaque safety, telemetry, operator, or controller reference."));
  }
}

function validateSafeText(value: string, path: string, required: boolean, issues: ValidationIssue[]): void {
  if (required && value.trim().length === 0) {
    issues.push(issue("error", "SafetyTextRequired", path, "Safety interlock text is required.", "Provide concise prompt-safe safety text."));
  }
  if (FORBIDDEN_SAFETY_TEXT_PATTERN.test(value)) {
    issues.push(issue("error", "SafetyTextForbidden", path, "Safety text contains hidden truth, restricted control, or prompt-private wording.", "Use safety, controller, telemetry, and operator summaries only."));
  }
}

function syntheticModeSignal(snapshot: RuntimeStateSnapshot, kind: SafetyInterlockKind, severity: SafetyInterlockSeverity, summary: string): SafetyInterlockSignal {
  return Object.freeze({
    signal_ref: makeRef("safety_mode_signal", snapshot.session_ref, snapshot.safety_mode, snapshot.updated_at_ms),
    kind,
    severity,
    source_component: "RuntimeStateSnapshot",
    observed_at_ms: snapshot.updated_at_ms,
    evidence_refs: freezeArray([snapshot.current_context_ref]),
    human_summary: summary,
  });
}

function isActionBearingState(state: PrimaryState): boolean {
  return state === "Validate" || state === "Monologue" || state === "Execute" || state === "ToolAssess" || state === "Correct";
}

function isAsyncState(state: PrimaryState): boolean {
  return state === "Plan"
    || state === "PlanRepair"
    || state === "Monologue"
    || state === "Execute"
    || state === "Verify"
    || state === "Correct"
    || state === "MemoryUpdate"
    || state === "AudioAttend"
    || state === "ToolAssess";
}

function severityRank(severity: SafetyInterlockSeverity): number {
  switch (severity) {
    case "critical":
      return 4;
    case "blocking":
      return 3;
    case "caution":
      return 2;
    case "notice":
      return 1;
  }
}

function compactText(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return FORBIDDEN_SAFETY_TEXT_PATTERN.test(compact)
    ? compact.replace(FORBIDDEN_SAFETY_TEXT_PATTERN, "[redacted_safety_content]").slice(0, 900)
    : compact.slice(0, 900);
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

function uniqueStrings<T extends string>(items: readonly T[]): readonly T[] {
  return freezeArray([...new Set(items)]);
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

export const SAFETY_INTERLOCK_COORDINATOR_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: SAFETY_INTERLOCK_COORDINATOR_SCHEMA_VERSION,
  blueprint: "architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md",
  sections: freezeArray(["8.3", "8.5", "8.7", "8.8", "8.9.7", "8.9.8", "8.9.14", "8.10", "8.14", "8.15", "8.16", "8.17", "8.18"]),
  traceability_ref: CONTRACT_TRACEABILITY_REF,
  preemption_targets: freezeArray(["SafeHold", "Abort"] as readonly PrimaryState[]),
});
