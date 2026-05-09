/**
 * State deadline manager for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md`
 * sections 8.3, 8.9, 8.10, 8.12, 8.14, 8.15, 8.16, and 8.17.
 *
 * This module implements the executable `StateDeadlineManager`. It creates
 * state-specific deadline records, evaluates elapsed and remaining time with
 * deterministic math, classifies timeout outcomes, and emits orchestration
 * timeout events for sensors, Gemini planning, repair, validators, TTS,
 * controllers, verification, correction, audio, memory, safe-hold dwell, and
 * human-review watchdogs. It never mutates runtime state directly; the
 * `OrchestrationStateMachine` remains the authority for committed transitions.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import type {
  DeadlineClass,
  DeadlineStateEntry,
  EventSeverity,
  OrchestrationEventEnvelope,
  OrchestrationEventType,
  PrimaryState,
  RuntimeStateSnapshot,
} from "./orchestration_state_machine";

export const STATE_DEADLINE_MANAGER_SCHEMA_VERSION = "mebsuta.state_deadline_manager.v1" as const;
export const STATE_DEADLINE_MANAGER_VERSION = "1.0.0" as const;

const CONTRACT_TRACEABILITY_REF = "architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md#StateDeadlineManager" as const;
const DEFAULT_NON_REAL_TIME_MULTIPLIER = 3;
const MINIMUM_DEADLINE_DURATION_MS = 1;
const HUMAN_REVIEW_WATCHDOG_MS = 300_000;
const SAFE_HOLD_DWELL_REVIEW_MS = 120_000;

export type DeadlineEvaluationStatus = "pending" | "within_margin" | "warning" | "expired";
export type TimeoutOutcome =
  | "continue_waiting"
  | "mark_missing"
  | "skip_noncritical"
  | "defer_noncritical"
  | "transition_reobserve"
  | "transition_plan_repair"
  | "transition_correct"
  | "transition_safe_hold"
  | "transition_human_review"
  | "transition_abort";
export type DeadlineCriticality = "safety_critical" | "task_critical" | "noncritical" | "watchdog";
export type DeadlineOwnerSubsystem = "sensor" | "cognitive" | "validator" | "tts" | "controller" | "verification" | "memory" | "safety" | "operator";

export interface StateDeadlinePolicy {
  readonly deadline_class: DeadlineClass;
  readonly owner_state: PrimaryState;
  readonly owner_subsystem: DeadlineOwnerSubsystem;
  readonly default_duration_ms: number;
  readonly warning_ratio: number;
  readonly timeout_target: PrimaryState;
  readonly timeout_event_type: OrchestrationEventType;
  readonly criticality: DeadlineCriticality;
  readonly target_behavior: string;
}

export interface DeadlineStartRequest {
  readonly deadline_ref?: Ref;
  readonly owner_state: PrimaryState;
  readonly deadline_class?: DeadlineClass;
  readonly started_at_ms: number;
  readonly duration_ms?: number;
  readonly timeout_target?: PrimaryState;
  readonly context_ref?: Ref;
  readonly source_ref?: Ref;
  readonly metadata_refs?: readonly Ref[];
}

export interface DeadlineRuntimePolicy {
  readonly real_time_mode?: boolean;
  readonly allow_noncritical_monologue_skip?: boolean;
  readonly memory_write_required_for_task_integrity?: boolean;
  readonly execution_anomaly_recoverable?: boolean;
  readonly partial_model_response_available?: boolean;
  readonly repair_budget_remaining?: boolean;
  readonly verification_evidence_required?: boolean;
  readonly sensor_required_for_action?: boolean;
  readonly repeated_timeout_count?: number;
  readonly operator_watchdog_enabled?: boolean;
  readonly safe_hold_cleared?: boolean;
}

export interface DeadlineEvaluationRequest {
  readonly deadline: DeadlineStateEntry;
  readonly now_ms: number;
  readonly runtime_policy?: DeadlineRuntimePolicy;
  readonly snapshot?: RuntimeStateSnapshot;
  readonly payload_refs?: readonly Ref[];
}

export interface DeadlineDecision {
  readonly schema_version: typeof STATE_DEADLINE_MANAGER_SCHEMA_VERSION;
  readonly deadline_ref: Ref;
  readonly deadline_class: DeadlineClass;
  readonly owner_state: PrimaryState;
  readonly status: DeadlineEvaluationStatus;
  readonly outcome: TimeoutOutcome;
  readonly elapsed_ms: number;
  readonly duration_ms: number;
  readonly remaining_ms: number;
  readonly elapsed_ratio: number;
  readonly timeout_target?: PrimaryState;
  readonly timeout_event?: OrchestrationEventEnvelope;
  readonly human_visible_summary: string;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface DeadlineSweepReport {
  readonly schema_version: typeof STATE_DEADLINE_MANAGER_SCHEMA_VERSION;
  readonly evaluated_at_ms: number;
  readonly active_count: number;
  readonly expired_count: number;
  readonly warning_count: number;
  readonly decisions: readonly DeadlineDecision[];
  readonly next_deadline_ref?: Ref;
  readonly next_deadline_remaining_ms?: number;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface SnapshotDeadlineReconciliation {
  readonly schema_version: typeof STATE_DEADLINE_MANAGER_SCHEMA_VERSION;
  readonly snapshot_ref: Ref;
  readonly evaluated_at_ms: number;
  readonly retained_deadlines: readonly DeadlineStateEntry[];
  readonly refreshed_deadlines: readonly DeadlineStateEntry[];
  readonly sweep_report: DeadlineSweepReport;
  readonly determinism_hash: string;
}

/**
 * Deterministic state timeout authority. Its public methods are side-effect
 * free so orchestration tests can replay deadline decisions from the same
 * snapshot, clock reading, and runtime policy.
 */
export class StateDeadlineManager {
  private readonly policies: Readonly<Record<DeadlineClass, StateDeadlinePolicy>>;

  public constructor(policies: readonly StateDeadlinePolicy[] = DEFAULT_DEADLINE_POLICIES) {
    this.policies = indexPolicies(policies);
  }

  /**
   * Creates a deadline entry for a state entry action. If callers omit the
   * deadline class, the manager uses the File 08 default class for that state.
   */
  public startDeadline(request: DeadlineStartRequest): DeadlineStateEntry {
    const deadlineClass = request.deadline_class ?? defaultDeadlineClassForState(request.owner_state);
    const policy = this.policies[deadlineClass];
    const durationMs = request.duration_ms ?? policy.default_duration_ms;
    const target = request.timeout_target ?? policy.timeout_target;
    const issues: ValidationIssue[] = [];
    validateDeadlineStartRequest(request, policy, durationMs, issues);
    if (issues.some((item) => item.severity === "error")) {
      throw new StateDeadlineManagerError("Deadline start request failed validation.", issues);
    }
    const base = {
      deadline_ref: request.deadline_ref ?? makeRef("deadline", request.owner_state, deadlineClass, request.context_ref, request.started_at_ms),
      deadline_class: deadlineClass,
      owner_state: request.owner_state,
      started_at_ms: request.started_at_ms,
      duration_ms: Math.max(MINIMUM_DEADLINE_DURATION_MS, durationMs),
      timeout_target: target,
      elapsed_ms: 0,
      expired: false,
    };
    return Object.freeze(base);
  }

  /**
   * Returns the recommended deadline for a primary state, including special
   * watchdog policies for SafeHold and HumanReview.
   */
  public createDeadlineForState(
    ownerState: PrimaryState,
    startedAtMs: number,
    runtimePolicy: DeadlineRuntimePolicy = {},
    overrides: Partial<Pick<DeadlineStartRequest, "deadline_ref" | "duration_ms" | "timeout_target" | "context_ref" | "source_ref" | "metadata_refs">> = {},
  ): DeadlineStateEntry | undefined {
    const deadlineClass = optionalDeadlineClassForState(ownerState);
    if (deadlineClass === undefined) {
      return undefined;
    }
    const policy = this.policies[deadlineClass];
    const multiplier = runtimePolicy.real_time_mode === false && deadlineClass === "RoutinePlanningDeadline"
      ? DEFAULT_NON_REAL_TIME_MULTIPLIER
      : 1;
    const durationMs = overrides.duration_ms ?? policy.default_duration_ms * multiplier;
    return this.startDeadline({
      owner_state: ownerState,
      deadline_class: deadlineClass,
      started_at_ms: startedAtMs,
      duration_ms: durationMs,
      timeout_target: overrides.timeout_target,
      deadline_ref: overrides.deadline_ref,
      context_ref: overrides.context_ref,
      source_ref: overrides.source_ref,
      metadata_refs: overrides.metadata_refs,
    });
  }

  /**
   * Evaluates a single deadline against a monotonic millisecond clock. The
   * result includes all arithmetic needed for dashboards and replay.
   */
  public evaluateDeadline(request: DeadlineEvaluationRequest): DeadlineDecision {
    const issues: ValidationIssue[] = [];
    validateDeadlineEntry(request.deadline, "$.deadline", issues);
    if (!Number.isFinite(request.now_ms)) {
      issues.push(issue("error", "DeadlineNowInvalid", "$.now_ms", "Deadline evaluation clock must be finite.", "Use the scenario or wall clock millisecond reading."));
    }
    const elapsedMs = Math.max(0, request.now_ms - request.deadline.started_at_ms);
    const durationMs = Math.max(MINIMUM_DEADLINE_DURATION_MS, request.deadline.duration_ms);
    const remainingMs = Math.max(0, durationMs - elapsedMs);
    const elapsedRatio = elapsedMs / durationMs;
    const status = chooseStatus(elapsedRatio, request.deadline, this.policies[request.deadline.deadline_class]);
    const outcome = status === "expired"
      ? chooseTimeoutOutcome(request.deadline, request.runtime_policy ?? {})
      : status === "warning"
        ? "continue_waiting"
        : "continue_waiting";
    const timeoutTarget = outcomeTarget(outcome, request.deadline.timeout_target);
    const event = status === "expired" && timeoutTarget !== undefined
      ? this.materializeTimeoutEvent(request, elapsedMs, timeoutTarget, outcome)
      : undefined;
    const allIssues = status === "expired"
      ? freezeArray([...issues, issue("warning", "DeadlineExpired", "$.deadline", `${request.deadline.deadline_class} expired after ${elapsedMs} ms.`, "Route timeout through the orchestration state machine.")])
      : freezeArray(issues);
    const base = {
      schema_version: STATE_DEADLINE_MANAGER_SCHEMA_VERSION,
      deadline_ref: request.deadline.deadline_ref,
      deadline_class: request.deadline.deadline_class,
      owner_state: request.deadline.owner_state,
      status,
      outcome,
      elapsed_ms: elapsedMs,
      duration_ms: durationMs,
      remaining_ms: remainingMs,
      elapsed_ratio: roundRatio(elapsedRatio),
      timeout_target: timeoutTarget,
      timeout_event: event,
      human_visible_summary: summarizeDecision(request.deadline, status, outcome, elapsedMs, remainingMs),
      issues: allIssues,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Evaluates all active deadlines in deterministic expiry order. The first
   * expired decision is the one orchestration should process first.
   */
  public sweepDeadlines(
    deadlines: readonly DeadlineStateEntry[],
    nowMs: number,
    runtimePolicy: DeadlineRuntimePolicy = {},
    snapshot?: RuntimeStateSnapshot,
    payloadRefs: readonly Ref[] = [],
  ): DeadlineSweepReport {
    const decisions = deadlines
      .slice()
      .sort(compareDeadlines)
      .map((deadline) => this.evaluateDeadline({
        deadline,
        now_ms: nowMs,
        runtime_policy: runtimePolicy,
        snapshot,
        payload_refs: payloadRefs,
      }));
    const warnings = decisions.filter((decision) => decision.status === "warning").length;
    const expired = decisions.filter((decision) => decision.status === "expired").length;
    const next = decisions
      .filter((decision) => decision.status !== "expired")
      .sort((a, b) => a.remaining_ms - b.remaining_ms || a.deadline_ref.localeCompare(b.deadline_ref))[0];
    const issues = freezeArray(decisions.flatMap((decision) => decision.issues));
    const base = {
      schema_version: STATE_DEADLINE_MANAGER_SCHEMA_VERSION,
      evaluated_at_ms: nowMs,
      active_count: deadlines.length,
      expired_count: expired,
      warning_count: warnings,
      decisions: freezeArray(decisions),
      next_deadline_ref: next?.deadline_ref,
      next_deadline_remaining_ms: next?.remaining_ms,
      issues,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Reconciles a runtime snapshot's deadline state with the current time. This
   * is useful for ledger/dashboard updates before a transition is committed.
   */
  public reconcileSnapshotDeadlines(
    snapshot: RuntimeStateSnapshot,
    nowMs: number,
    runtimePolicy: DeadlineRuntimePolicy = {},
  ): SnapshotDeadlineReconciliation {
    const sweep = this.sweepDeadlines(snapshot.deadline_state, nowMs, runtimePolicy, snapshot, snapshot.audit_refs);
    const expiredRefs = new Set(sweep.decisions.filter((decision) => decision.status === "expired").map((decision) => decision.deadline_ref));
    const retained = snapshot.deadline_state
      .filter((deadline) => !expiredRefs.has(deadline.deadline_ref))
      .map((deadline) => refreshDeadlineElapsed(deadline, nowMs));
    const replacement = retained.some((deadline) => deadline.owner_state === snapshot.primary_state)
      ? undefined
      : this.createDeadlineForState(snapshot.primary_state, nowMs, runtimePolicy, { context_ref: snapshot.current_context_ref });
    const refreshed = freezeArray(replacement === undefined ? retained : [...retained, replacement]);
    const base = {
      schema_version: STATE_DEADLINE_MANAGER_SCHEMA_VERSION,
      snapshot_ref: snapshot.current_context_ref,
      evaluated_at_ms: nowMs,
      retained_deadlines: freezeArray(retained),
      refreshed_deadlines: refreshed,
      sweep_report: sweep,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Returns the immutable policy table for telemetry and audits.
   */
  public getDeadlinePolicies(): readonly StateDeadlinePolicy[] {
    return freezeArray(Object.values(this.policies).sort((a, b) => a.deadline_class.localeCompare(b.deadline_class)));
  }

  private materializeTimeoutEvent(
    request: DeadlineEvaluationRequest,
    elapsedMs: number,
    timeoutTarget: PrimaryState,
    outcome: TimeoutOutcome,
  ): OrchestrationEventEnvelope {
    const policy = this.policies[request.deadline.deadline_class];
    const snapshot = request.snapshot;
    const severity = severityFor(policy, timeoutTarget, outcome);
    const payloadRefs = uniqueRefs([
      request.deadline.deadline_ref,
      request.deadline.owner_state,
      request.deadline.timeout_target,
      ...(request.payload_refs ?? []),
      snapshot?.active_plan_ref,
      snapshot?.active_primitive_ref,
      snapshot?.latest_observation_ref,
      snapshot?.latest_verification_ref,
    ]);
    const base = {
      event_ref: makeRef("event", "deadline_expired", request.deadline.deadline_ref, request.now_ms),
      event_type: policy.timeout_event_type,
      event_family: eventFamilyFor(policy),
      severity,
      session_ref: snapshot?.session_ref ?? makeRef("session", request.deadline.deadline_ref),
      task_ref: snapshot?.task_ref ?? makeRef("task", request.deadline.deadline_ref),
      source_state_ref: request.deadline.owner_state,
      context_ref: snapshot?.current_context_ref,
      payload_refs: payloadRefs,
      provenance_classes: freezeArray(["telemetry", "safety"] as const),
      occurred_at_ms: request.now_ms,
      human_summary: `${request.deadline.deadline_class} expired after ${elapsedMs} ms; recommended outcome ${outcome}.`,
      target_state_hint: timeoutTarget,
      deadline_ref: request.deadline.deadline_ref,
      observation_ref: snapshot?.latest_observation_ref,
      plan_ref: snapshot?.active_plan_ref,
      primitive_ref: snapshot?.active_primitive_ref,
      verification_ref: snapshot?.latest_verification_ref,
      safety_mode_override: timeoutTarget === "Abort" ? "AbortRequired" as const : timeoutTarget === "SafeHold" ? "SafeHoldRequired" as const : undefined,
    };
    return Object.freeze(base);
  }
}

export class StateDeadlineManagerError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "StateDeadlineManagerError";
    this.issues = issues;
  }
}

function chooseStatus(deadlineRatio: number, deadline: DeadlineStateEntry, policy: StateDeadlinePolicy): DeadlineEvaluationStatus {
  if (deadline.expired || deadlineRatio >= 1) {
    return "expired";
  }
  if (deadlineRatio >= policy.warning_ratio) {
    return "warning";
  }
  return deadlineRatio >= 0.5 ? "within_margin" : "pending";
}

function chooseTimeoutOutcome(deadline: DeadlineStateEntry, runtimePolicy: DeadlineRuntimePolicy): TimeoutOutcome {
  switch (deadline.deadline_class) {
    case "SensorFrameDeadline":
      return runtimePolicy.sensor_required_for_action === false ? "mark_missing" : deadline.owner_state === "Observe" || deadline.owner_state === "Reobserve" ? "transition_reobserve" : "transition_safe_hold";
    case "RoutinePlanningDeadline":
      return runtimePolicy.partial_model_response_available === true ? "transition_plan_repair" : "transition_safe_hold";
    case "CorrectionPlanningDeadline":
      return "transition_safe_hold";
    case "AnomalyDetectionDeadline":
      return runtimePolicy.execution_anomaly_recoverable === true ? "transition_correct" : "transition_safe_hold";
    case "MonologueStartDeadline":
      return runtimePolicy.allow_noncritical_monologue_skip === true ? "skip_noncritical" : "transition_safe_hold";
    case "PrimitiveExecutionDeadline":
      return runtimePolicy.execution_anomaly_recoverable === true ? "transition_correct" : "transition_safe_hold";
    case "VerificationDeadline":
      return runtimePolicy.verification_evidence_required === false ? "transition_reobserve" : "transition_safe_hold";
    case "RepairDeadline":
      return runtimePolicy.repair_budget_remaining === true ? "transition_plan_repair" : "transition_safe_hold";
    default:
      return deadline.owner_state === "MemoryUpdate" && runtimePolicy.memory_write_required_for_task_integrity !== true ? "defer_noncritical" : "transition_safe_hold";
  }
}

function outcomeTarget(outcome: TimeoutOutcome, defaultTarget: PrimaryState): PrimaryState | undefined {
  switch (outcome) {
    case "transition_reobserve":
      return "Reobserve";
    case "transition_plan_repair":
      return "PlanRepair";
    case "transition_correct":
      return "Correct";
    case "transition_safe_hold":
      return "SafeHold";
    case "transition_human_review":
      return "HumanReview";
    case "transition_abort":
      return "Abort";
    case "skip_noncritical":
      return defaultTarget === "SafeHold" ? "Execute" : defaultTarget;
    case "defer_noncritical":
    case "mark_missing":
      return defaultTarget;
    case "continue_waiting":
      return undefined;
  }
}

function defaultDeadlineClassForState(state: PrimaryState): DeadlineClass {
  const deadlineClass = optionalDeadlineClassForState(state);
  if (deadlineClass !== undefined) {
    return deadlineClass;
  }
  return "SensorFrameDeadline";
}

function optionalDeadlineClassForState(state: PrimaryState): DeadlineClass | undefined {
  switch (state) {
    case "Observe":
    case "Reobserve":
    case "AudioAttend":
      return "SensorFrameDeadline";
    case "Plan":
      return "RoutinePlanningDeadline";
    case "PlanRepair":
      return "RepairDeadline";
    case "Validate":
      return "RepairDeadline";
    case "Monologue":
      return "MonologueStartDeadline";
    case "Execute":
      return "PrimitiveExecutionDeadline";
    case "Verify":
      return "VerificationDeadline";
    case "Correct":
      return "CorrectionPlanningDeadline";
    case "ToolAssess":
      return "RoutinePlanningDeadline";
    case "MemoryUpdate":
      return "VerificationDeadline";
    case "SafeHold":
      return "AnomalyDetectionDeadline";
    case "HumanReview":
      return "AnomalyDetectionDeadline";
    case "Initialize":
    case "Complete":
    case "Abort":
      return undefined;
  }
}

function refreshDeadlineElapsed(deadline: DeadlineStateEntry, nowMs: number): DeadlineStateEntry {
  const elapsedMs = Math.max(0, nowMs - deadline.started_at_ms);
  return Object.freeze({
    ...deadline,
    elapsed_ms: elapsedMs,
    expired: elapsedMs >= deadline.duration_ms,
  });
}

function compareDeadlines(a: DeadlineStateEntry, b: DeadlineStateEntry): number {
  const aExpires = a.started_at_ms + a.duration_ms;
  const bExpires = b.started_at_ms + b.duration_ms;
  return aExpires - bExpires || a.deadline_ref.localeCompare(b.deadline_ref);
}

function severityFor(policy: StateDeadlinePolicy, target: PrimaryState, outcome: TimeoutOutcome): EventSeverity {
  if (target === "Abort" || policy.criticality === "safety_critical") {
    return "critical";
  }
  if (target === "SafeHold" || target === "HumanReview" || outcome === "transition_safe_hold") {
    return "error";
  }
  if (outcome === "skip_noncritical" || outcome === "defer_noncritical" || outcome === "mark_missing") {
    return "warning";
  }
  return "notice";
}

function eventFamilyFor(policy: StateDeadlinePolicy): OrchestrationEventEnvelope["event_family"] {
  switch (policy.owner_subsystem) {
    case "sensor":
      return "sensor";
    case "cognitive":
      return "cognitive";
    case "validator":
      return "validation";
    case "tts":
      return "monologue";
    case "controller":
      return "execution";
    case "verification":
      return "verification";
    case "memory":
      return "memory";
    case "safety":
      return "safety";
    case "operator":
      return "operator";
  }
}

function summarizeDecision(
  deadline: DeadlineStateEntry,
  status: DeadlineEvaluationStatus,
  outcome: TimeoutOutcome,
  elapsedMs: number,
  remainingMs: number,
): string {
  if (status === "expired") {
    return `${deadline.owner_state} ${deadline.deadline_class} expired after ${elapsedMs} ms; outcome ${outcome}.`;
  }
  if (status === "warning") {
    return `${deadline.owner_state} ${deadline.deadline_class} is near timeout with ${remainingMs} ms remaining.`;
  }
  return `${deadline.owner_state} ${deadline.deadline_class} remains active with ${remainingMs} ms remaining.`;
}

function validateDeadlineStartRequest(
  request: DeadlineStartRequest,
  policy: StateDeadlinePolicy,
  durationMs: number,
  issues: ValidationIssue[],
): void {
  if (request.started_at_ms < 0 || !Number.isFinite(request.started_at_ms)) {
    issues.push(issue("error", "DeadlineStartInvalid", "$.started_at_ms", "Deadline start time must be a finite non-negative millisecond value.", "Use the scenario clock millisecond reading."));
  }
  if (durationMs < MINIMUM_DEADLINE_DURATION_MS || !Number.isFinite(durationMs)) {
    issues.push(issue("error", "DeadlineDurationInvalid", "$.duration_ms", "Deadline duration must be positive and finite.", "Use a File 08 deadline duration or a bounded override."));
  }
  if (policy.owner_state !== request.owner_state && !policyCompatibleWithState(policy.deadline_class, request.owner_state)) {
    issues.push(issue("warning", "DeadlineStateClassUnusual", "$.deadline_class", `Deadline class ${policy.deadline_class} is unusual for ${request.owner_state}.`, "Confirm this is an intentional watchdog or cross-state deadline."));
  }
  for (const ref of [request.deadline_ref, request.context_ref, request.source_ref, ...(request.metadata_refs ?? [])]) {
    if (ref !== undefined && ref.trim().length === 0) {
      issues.push(issue("error", "DeadlineReferenceInvalid", "$.refs", "Deadline references must be non-empty when supplied.", "Use stable opaque refs."));
    }
  }
}

function validateDeadlineEntry(deadline: DeadlineStateEntry, path: string, issues: ValidationIssue[]): void {
  if (deadline.deadline_ref.trim().length === 0 || /\s/.test(deadline.deadline_ref)) {
    issues.push(issue("error", "DeadlineRefInvalid", `${path}.deadline_ref`, "Deadline ref must be stable and whitespace-free.", "Use an opaque deadline ref."));
  }
  if (deadline.duration_ms < MINIMUM_DEADLINE_DURATION_MS || !Number.isFinite(deadline.duration_ms)) {
    issues.push(issue("error", "DeadlineDurationInvalid", `${path}.duration_ms`, "Deadline duration must be positive and finite.", "Use a bounded duration."));
  }
  if (deadline.started_at_ms < 0 || !Number.isFinite(deadline.started_at_ms)) {
    issues.push(issue("error", "DeadlineStartedAtInvalid", `${path}.started_at_ms`, "Deadline start time must be finite and non-negative.", "Use the scenario clock."));
  }
  if (deadline.elapsed_ms < 0 || !Number.isFinite(deadline.elapsed_ms)) {
    issues.push(issue("error", "DeadlineElapsedInvalid", `${path}.elapsed_ms`, "Deadline elapsed time must be finite and non-negative.", "Refresh elapsed time from the current clock."));
  }
}

function policyCompatibleWithState(deadlineClass: DeadlineClass, state: PrimaryState): boolean {
  const expected = optionalDeadlineClassForState(state);
  if (expected === deadlineClass) {
    return true;
  }
  if (state === "SafeHold" || state === "HumanReview") {
    return deadlineClass === "AnomalyDetectionDeadline";
  }
  if (state === "ToolAssess") {
    return deadlineClass === "RoutinePlanningDeadline" || deadlineClass === "CorrectionPlanningDeadline";
  }
  if (state === "Validate") {
    return deadlineClass === "RepairDeadline" || deadlineClass === "RoutinePlanningDeadline";
  }
  return false;
}

function indexPolicies(policies: readonly StateDeadlinePolicy[]): Readonly<Record<DeadlineClass, StateDeadlinePolicy>> {
  const map = new Map<DeadlineClass, StateDeadlinePolicy>();
  for (const policy of policies) {
    if (map.has(policy.deadline_class)) {
      throw new StateDeadlineManagerError(`Duplicate deadline policy: ${policy.deadline_class}.`, [issue("error", "DeadlinePolicyDuplicated", "$.policies", "Deadline policy classes must be unique.", "Remove duplicate policy entries.")]);
    }
    if (policy.default_duration_ms < MINIMUM_DEADLINE_DURATION_MS || !Number.isFinite(policy.default_duration_ms)) {
      throw new StateDeadlineManagerError(`Invalid deadline policy duration: ${policy.deadline_class}.`, [issue("error", "DeadlinePolicyDurationInvalid", "$.policies", "Deadline policy duration must be positive and finite.", "Use a bounded File 08 duration.")]);
    }
    map.set(policy.deadline_class, Object.freeze(policy));
  }
  const missing = ALL_DEADLINE_CLASSES.filter((deadlineClass) => !map.has(deadlineClass));
  if (missing.length > 0) {
    throw new StateDeadlineManagerError(`Missing deadline policies: ${missing.join(", ")}.`, [issue("error", "DeadlinePolicyMissing", "$.policies", "Every orchestration deadline class needs a policy.", "Declare all File 08 deadline classes.")]);
  }
  return Object.freeze(Object.fromEntries(ALL_DEADLINE_CLASSES.map((deadlineClass) => [deadlineClass, map.get(deadlineClass) as StateDeadlinePolicy])) as Record<DeadlineClass, StateDeadlinePolicy>);
}

function makePolicy(
  deadlineClass: DeadlineClass,
  ownerState: PrimaryState,
  ownerSubsystem: DeadlineOwnerSubsystem,
  defaultDurationMs: number,
  warningRatio: number,
  timeoutTarget: PrimaryState,
  timeoutEventType: OrchestrationEventType,
  criticality: DeadlineCriticality,
  targetBehavior: string,
): StateDeadlinePolicy {
  return Object.freeze({
    deadline_class: deadlineClass,
    owner_state: ownerState,
    owner_subsystem: ownerSubsystem,
    default_duration_ms: defaultDurationMs,
    warning_ratio: warningRatio,
    timeout_target: timeoutTarget,
    timeout_event_type: timeoutEventType,
    criticality,
    target_behavior: targetBehavior,
  });
}

function roundRatio(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function uniqueRefs(refs: readonly (Ref | undefined)[]): readonly Ref[] {
  return freezeArray([...new Set(refs.filter((ref): ref is Ref => ref !== undefined && ref.trim().length > 0))]);
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

function issue(severity: ValidationSeverity, code: string, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

const ALL_DEADLINE_CLASSES: readonly DeadlineClass[] = freezeArray([
  "SensorFrameDeadline",
  "RoutinePlanningDeadline",
  "CorrectionPlanningDeadline",
  "AnomalyDetectionDeadline",
  "MonologueStartDeadline",
  "PrimitiveExecutionDeadline",
  "VerificationDeadline",
  "RepairDeadline",
]);

const DEFAULT_DEADLINE_POLICIES: readonly StateDeadlinePolicy[] = freezeArray([
  makePolicy("SensorFrameDeadline", "Observe", "sensor", 2_000, 0.75, "Reobserve", "FrameMissing", "task_critical", "Mark missing or degraded sensor packet rather than waiting indefinitely."),
  makePolicy("RoutinePlanningDeadline", "Plan", "cognitive", 5_000, 0.8, "SafeHold", "ModelTimeout", "task_critical", "Routine Gemini planning prefers under five seconds."),
  makePolicy("CorrectionPlanningDeadline", "Correct", "cognitive", 10_000, 0.8, "SafeHold", "ModelTimeout", "safety_critical", "Oops correction must not invent action after timeout."),
  makePolicy("AnomalyDetectionDeadline", "Execute", "controller", 500, 0.6, "Correct", "TrackingErrorHigh", "safety_critical", "Controller and contact anomalies should be detected within 500 ms."),
  makePolicy("MonologueStartDeadline", "Monologue", "tts", 1_000, 0.7, "Execute", "SpeechFailed", "noncritical", "TTS should start quickly or be skipped when policy allows."),
  makePolicy("PrimitiveExecutionDeadline", "Execute", "controller", 30_000, 0.85, "Correct", "ControllerTimeout", "safety_critical", "Primitive timeout routes to correction or safe-hold based on risk."),
  makePolicy("VerificationDeadline", "Verify", "verification", 5_000, 0.8, "Reobserve", "VerificationAmbiguous", "task_critical", "Missing verification evidence cannot count as success."),
  makePolicy("RepairDeadline", "PlanRepair", "validator", 3_000, 0.8, "SafeHold", "ResponseRejected", "task_critical", "Structured response repair is shorter than original planning."),
]);

export const STATE_DEADLINE_MANAGER_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: STATE_DEADLINE_MANAGER_SCHEMA_VERSION,
  blueprint: "architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md",
  sections: freezeArray(["8.3", "8.9", "8.10", "8.12", "8.14", "8.15", "8.16", "8.17"]),
  traceability_ref: CONTRACT_TRACEABILITY_REF,
  deadline_classes: ALL_DEADLINE_CLASSES,
});
