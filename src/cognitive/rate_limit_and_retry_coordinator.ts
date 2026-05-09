/**
 * Rate limit and retry coordinator for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/06_GEMINI_ROBOTICS_ER_COGNITIVE_LAYER.md`
 * sections 6.6.1, 6.12.1, 6.13.1, 6.13.2, 6.13.3, 6.18.1, 6.18.2,
 * 6.19, and 6.20.
 *
 * This module controls cognitive request pacing, queue priority, deterministic
 * exponential backoff, timeout fallback, degraded-mode behavior, and retry
 * eligibility. It never schedules motion-critical retries past their safety
 * deadline; those requests are paused, degraded to deterministic checks, or
 * routed to safe-hold instead.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import type {
  CognitiveInvocationClass,
  CognitiveInvocationPolicy,
  CognitiveTelemetryEvent,
  CognitiveTelemetryEventType,
  RetryClass,
} from "./gemini_robotics_er_adapter";
import type {
  CognitiveConfigurationProfile,
  CognitiveInvocationPlan,
  CognitiveQueue,
} from "./cognitive_request_router";

export const RATE_LIMIT_AND_RETRY_COORDINATOR_SCHEMA_VERSION = "mebsuta.rate_limit_and_retry_coordinator.v1" as const;

const MIN_SPACING_MS = 50;
const MAX_REASONABLE_BACKOFF_MS = 120000;
const DEFAULT_SAFE_HOLD_MARGIN_MS = 750;
const DETERMINISTIC_JITTER_MODULUS = 997;

export type RateLimitDecision = "dispatch_now" | "defer" | "skip_noncritical" | "degrade_to_deterministic" | "safe_hold_required" | "reject";
export type RetryDecision = "retry_after_backoff" | "repair_then_retry" | "degrade_without_retry" | "safe_hold_required" | "terminal_reject" | "no_retry_needed";
export type RetryFailureKind = "api_timeout" | "rate_limit" | "malformed_structured_output" | "unsupported_modality" | "preview_behavior_drift" | "transport_error" | "schema_rejection";
export type DegradedModeEvent = "context_reduced" | "memory_skipped" | "monologue_skipped" | "deterministic_residual_only" | "reobserve_required" | "safe_hold_entered" | "human_visible_telemetry";
export type TimeoutFallback = "safe_hold_without_model" | "pause_before_motion" | "reobserve_or_residual_only" | "defer_without_blocking" | "test_harness_retry";

export interface QueueSchedulingPolicy {
  readonly queue: CognitiveQueue;
  readonly priority: number;
  readonly max_concurrent: number;
  readonly min_spacing_ms: number;
  readonly default_timeout_ms: number;
  readonly safety_deadline_ms: number;
  readonly max_retry_attempts: number;
  readonly base_backoff_ms: number;
  readonly max_backoff_ms: number;
  readonly jitter_ratio: number;
  readonly timeout_fallback: TimeoutFallback;
}

export interface QueueRuntimeState {
  readonly queue: CognitiveQueue;
  readonly in_flight_count: number;
  readonly recent_dispatch_timestamps_ms: readonly number[];
  readonly last_dispatch_ms?: number;
  readonly rate_limited_until_ms?: number;
  readonly consecutive_rate_limits?: number;
  readonly consecutive_timeouts?: number;
}

export interface AdapterRateLimitSignal {
  readonly signal_ref: Ref;
  readonly received_at_ms: number;
  readonly retry_after_ms?: number;
  readonly quota_scope: "global" | "model" | "queue" | "unknown";
  readonly http_status?: number;
  readonly summary: string;
}

export interface CognitiveSchedulingRequest {
  readonly request_ref: Ref;
  readonly invocation_class: CognitiveInvocationClass;
  readonly queue: CognitiveQueue;
  readonly configuration_profile?: CognitiveConfigurationProfile;
  readonly invocation_policy: CognitiveInvocationPolicy;
  readonly queue_state: QueueRuntimeState;
  readonly now_ms: number;
  readonly deadline_ms?: number;
  readonly safe_hold_active?: boolean;
  readonly action_bearing: boolean;
  readonly rate_limit_signal?: AdapterRateLimitSignal;
}

export interface RetryCoordinationRequest {
  readonly request_ref: Ref;
  readonly invocation_class: CognitiveInvocationClass;
  readonly queue: CognitiveQueue;
  readonly invocation_policy: CognitiveInvocationPolicy;
  readonly failure_kind: RetryFailureKind;
  readonly attempt_index: number;
  readonly now_ms: number;
  readonly first_attempt_started_ms: number;
  readonly deadline_ms?: number;
  readonly action_bearing: boolean;
  readonly rate_limit_signal?: AdapterRateLimitSignal;
  readonly repair_available?: boolean;
}

export interface CognitivePacingReport {
  readonly schema_version: typeof RATE_LIMIT_AND_RETRY_COORDINATOR_SCHEMA_VERSION;
  readonly request_ref: Ref;
  readonly queue: CognitiveQueue;
  readonly decision: RateLimitDecision;
  readonly dispatch_at_ms?: number;
  readonly delay_ms: number;
  readonly selected_policy: QueueSchedulingPolicy;
  readonly degraded_mode_events: readonly DegradedModeEvent[];
  readonly issues: readonly ValidationIssue[];
  readonly telemetry_event: CognitiveTelemetryEvent;
  readonly determinism_hash: string;
}

export interface RetryDecisionReport {
  readonly schema_version: typeof RATE_LIMIT_AND_RETRY_COORDINATOR_SCHEMA_VERSION;
  readonly request_ref: Ref;
  readonly queue: CognitiveQueue;
  readonly failure_kind: RetryFailureKind;
  readonly attempt_index: number;
  readonly decision: RetryDecision;
  readonly next_attempt_at_ms?: number;
  readonly backoff_ms: number;
  readonly retry_budget_remaining: number;
  readonly degraded_mode_events: readonly DegradedModeEvent[];
  readonly issues: readonly ValidationIssue[];
  readonly telemetry_event: CognitiveTelemetryEvent;
  readonly determinism_hash: string;
}

export interface QueueHealthSnapshot {
  readonly schema_version: typeof RATE_LIMIT_AND_RETRY_COORDINATOR_SCHEMA_VERSION;
  readonly queue: CognitiveQueue;
  readonly saturated: boolean;
  readonly in_flight_count: number;
  readonly dispatches_in_window: number;
  readonly earliest_next_dispatch_ms: number;
  readonly rate_limited_until_ms?: number;
  readonly timeout_pressure: number;
  readonly rate_limit_pressure: number;
  readonly determinism_hash: string;
}

/**
 * Coordinates request pacing and retry behavior for Gemini Robotics-ER calls.
 * All calculations are deterministic so telemetry, replay, and regression can
 * reproduce exactly why a request was dispatched, deferred, degraded, or held.
 */
export class RateLimitAndRetryCoordinator {
  private readonly policies: Readonly<Record<CognitiveQueue, QueueSchedulingPolicy>>;

  public constructor(policies: readonly QueueSchedulingPolicy[] = DEFAULT_QUEUE_POLICIES) {
    this.policies = indexPolicies(policies);
  }

  /**
   * Converts a router invocation plan into a scheduling request using the plan's
   * queue, policy, timeout, action-bearing status, and optional state deadline.
   * The router timeout remains the per-call API timeout; the state deadline is
   * a separate outer bound supplied by the orchestrator when motion timing is
   * already constrained.
   */
  public requestFromInvocationPlan(
    plan: CognitiveInvocationPlan,
    queueState: QueueRuntimeState,
    nowMs: number,
    actionBearing = actionBearingInvocation(plan.invocation_class),
    rateLimitSignal?: AdapterRateLimitSignal,
    stateDeadlineMs?: number,
  ): CognitiveSchedulingRequest {
    return Object.freeze({
      request_ref: plan.plan_ref,
      invocation_class: plan.invocation_class,
      queue: plan.queue,
      configuration_profile: plan.configuration_profile,
      invocation_policy: plan.invocation_policy,
      queue_state: queueState,
      now_ms: nowMs,
      deadline_ms: stateDeadlineMs,
      safe_hold_active: plan.safe_hold_required,
      action_bearing: actionBearing,
      rate_limit_signal: rateLimitSignal,
    });
  }

  /**
   * Decides whether a request may dispatch now or must be deferred/degraded.
   * Motion-critical requests are never delayed past their safety timeout.
   */
  public evaluateRequestPacing(request: CognitiveSchedulingRequest): CognitivePacingReport {
    const policy = this.policyFor(request.queue);
    const issues = [
      ...validateSchedulingRequest(request),
      ...validateQueueState(request.queue_state, request.queue),
      ...validatePolicy(policy),
    ];
    const degradedEvents: DegradedModeEvent[] = [];
    const earliestBySpacing = Math.max(request.now_ms, (request.queue_state.last_dispatch_ms ?? -Infinity) + policy.min_spacing_ms);
    const earliestByRateLimit = request.rate_limit_signal === undefined
      ? request.queue_state.rate_limited_until_ms ?? request.now_ms
      : Math.max(request.queue_state.rate_limited_until_ms ?? request.now_ms, request.rate_limit_signal.received_at_ms + (request.rate_limit_signal.retry_after_ms ?? policy.base_backoff_ms));
    const saturated = request.queue_state.in_flight_count >= policy.max_concurrent;
    const earliestByConcurrency = saturated ? request.now_ms + policy.min_spacing_ms : request.now_ms;
    const earliestDispatch = Math.max(earliestBySpacing, earliestByRateLimit, earliestByConcurrency);
    const delayMs = Math.max(0, earliestDispatch - request.now_ms);
    const absoluteDeadline = absoluteDeadlineMs(request, policy);

    if (request.safe_hold_active === true) {
      degradedEvents.push("safe_hold_entered");
      return makePacingReport(request, policy, "safe_hold_required", undefined, delayMs, degradedEvents, issues);
    }
    if (issues.some((item) => item.severity === "error")) {
      return makePacingReport(request, policy, "reject", undefined, delayMs, degradedEvents, issues);
    }
    if (wouldMissSafetyDeadline(earliestDispatch, request.invocation_policy.timeout_ms, absoluteDeadline, request.action_bearing)) {
      degradedEvents.push(...fallbackEvents(policy.timeout_fallback));
      const decision = request.action_bearing ? "safe_hold_required" : fallbackDecision(policy.timeout_fallback);
      return makePacingReport(request, policy, decision, undefined, delayMs, degradedEvents, issues);
    }
    if (request.rate_limit_signal !== undefined && request.queue !== "SafetyImmediate" && request.queue !== "ExecutionPlanning") {
      degradedEvents.push(...noncriticalRateLimitEvents(request.queue));
      const noncriticalDecision = request.queue === "MemoryMaintenance" || request.queue === "OfflineQA" ? "skip_noncritical" : "defer";
      return makePacingReport(request, policy, noncriticalDecision, earliestDispatch, delayMs, degradedEvents, issues);
    }
    if (delayMs > 0) {
      return makePacingReport(request, policy, "defer", earliestDispatch, delayMs, degradedEvents, issues);
    }
    return makePacingReport(request, policy, "dispatch_now", request.now_ms, 0, degradedEvents, issues);
  }

  /**
   * Computes a retry response for adapter failures, rate-limit signals, schema
   * failures, unsupported modalities, and preview behavior drift.
   */
  public coordinateRetry(request: RetryCoordinationRequest): RetryDecisionReport {
    const policy = this.policyFor(request.queue);
    const issues = [
      ...validateRetryRequest(request),
      ...validatePolicy(policy),
    ];
    const retryBudgetRemaining = Math.max(0, policy.max_retry_attempts - request.attempt_index);
    const degradedEvents: DegradedModeEvent[] = [];
    if (issues.some((item) => item.severity === "error")) {
      return makeRetryReport(request, policy, "terminal_reject", 0, undefined, retryBudgetRemaining, degradedEvents, issues);
    }
    if (request.failure_kind === "preview_behavior_drift") {
      degradedEvents.push("human_visible_telemetry");
      return makeRetryReport(request, policy, "terminal_reject", 0, undefined, retryBudgetRemaining, degradedEvents, issues);
    }
    if (request.failure_kind === "malformed_structured_output" && request.repair_available === true && request.attempt_index === 0) {
      return makeRetryReport(request, policy, "repair_then_retry", 0, request.now_ms, retryBudgetRemaining, degradedEvents, issues);
    }
    if (retryBudgetRemaining <= 0 || request.invocation_policy.retry_class === "none") {
      degradedEvents.push(...terminalEventsFor(request.failure_kind, request.queue, request.action_bearing));
      return makeRetryReport(request, policy, terminalDecisionFor(request), 0, undefined, retryBudgetRemaining, degradedEvents, issues);
    }
    const backoffMs = computeBackoffMs(request, policy);
    const nextAttemptAt = request.now_ms + backoffMs;
    const absoluteDeadline = request.deadline_ms === undefined ? request.first_attempt_started_ms + policy.safety_deadline_ms : request.first_attempt_started_ms + request.deadline_ms;
    if (wouldMissSafetyDeadline(nextAttemptAt, request.invocation_policy.timeout_ms, absoluteDeadline, request.action_bearing)) {
      degradedEvents.push(...fallbackEvents(policy.timeout_fallback));
      return makeRetryReport(request, policy, request.action_bearing ? "safe_hold_required" : "degrade_without_retry", backoffMs, undefined, retryBudgetRemaining, degradedEvents, issues);
    }
    if (request.failure_kind === "unsupported_modality") {
      degradedEvents.push("context_reduced");
      return makeRetryReport(request, policy, "retry_after_backoff", Math.min(backoffMs, policy.base_backoff_ms), request.now_ms + Math.min(backoffMs, policy.base_backoff_ms), retryBudgetRemaining, degradedEvents, issues);
    }
    if (request.failure_kind === "rate_limit" && (request.queue === "MemoryMaintenance" || request.queue === "OfflineQA")) {
      degradedEvents.push(...noncriticalRateLimitEvents(request.queue));
      return makeRetryReport(request, policy, "degrade_without_retry", backoffMs, undefined, retryBudgetRemaining, degradedEvents, issues);
    }
    if (request.failure_kind === "api_timeout") {
      degradedEvents.push("context_reduced");
    }
    return makeRetryReport(request, policy, "retry_after_backoff", backoffMs, nextAttemptAt, retryBudgetRemaining, degradedEvents, issues);
  }

  /**
   * Produces queue health metrics used by telemetry and operators to identify
   * saturation, repeated rate limits, timeout pressure, and earliest dispatch.
   */
  public summarizeQueueHealth(queue: CognitiveQueue, state: QueueRuntimeState, nowMs: number, windowMs = 60000): QueueHealthSnapshot {
    const policy = this.policyFor(queue);
    const recentDispatches = state.recent_dispatch_timestamps_ms.filter((timestamp) => timestamp >= nowMs - windowMs && timestamp <= nowMs);
    const earliestNextDispatch = Math.max(
      nowMs,
      (state.last_dispatch_ms ?? -Infinity) + policy.min_spacing_ms,
      state.rate_limited_until_ms ?? nowMs,
      state.in_flight_count >= policy.max_concurrent ? nowMs + policy.min_spacing_ms : nowMs,
    );
    const base = {
      schema_version: RATE_LIMIT_AND_RETRY_COORDINATOR_SCHEMA_VERSION,
      queue,
      saturated: state.in_flight_count >= policy.max_concurrent,
      in_flight_count: state.in_flight_count,
      dispatches_in_window: recentDispatches.length,
      earliest_next_dispatch_ms: earliestNextDispatch,
      rate_limited_until_ms: state.rate_limited_until_ms,
      timeout_pressure: round3(Math.min(1, (state.consecutive_timeouts ?? 0) / Math.max(1, policy.max_retry_attempts + 1))),
      rate_limit_pressure: round3(Math.min(1, (state.consecutive_rate_limits ?? 0) / Math.max(1, policy.max_retry_attempts + 1))),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  private policyFor(queue: CognitiveQueue): QueueSchedulingPolicy {
    return this.policies[queue];
  }
}

function makePacingReport(
  request: CognitiveSchedulingRequest,
  policy: QueueSchedulingPolicy,
  decision: RateLimitDecision,
  dispatchAtMs: number | undefined,
  delayMs: number,
  degradedEvents: readonly DegradedModeEvent[],
  issues: readonly ValidationIssue[],
): CognitivePacingReport {
  const severity = decision === "reject" || decision === "safe_hold_required" ? "error" : decision === "defer" || decision === "skip_noncritical" || decision === "degrade_to_deterministic" ? "warning" : "info";
  const event = makeTelemetry(
    decision === "dispatch_now" ? "ModelCallStarted" : "CognitiveRequestRejected",
    request.request_ref,
    request.invocation_policy.model_identifier,
    undefined,
    severity,
    `Rate coordinator decision ${decision} for ${request.queue}.`,
    request.now_ms,
  );
  const base = {
    schema_version: RATE_LIMIT_AND_RETRY_COORDINATOR_SCHEMA_VERSION,
    request_ref: request.request_ref,
    queue: request.queue,
    decision,
    dispatch_at_ms: dispatchAtMs,
    delay_ms: delayMs,
    selected_policy: policy,
    degraded_mode_events: freezeArray(degradedEvents),
    issues: freezeArray(issues),
    telemetry_event: event,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function makeRetryReport(
  request: RetryCoordinationRequest,
  policy: QueueSchedulingPolicy,
  decision: RetryDecision,
  backoffMs: number,
  nextAttemptAtMs: number | undefined,
  retryBudgetRemaining: number,
  degradedEvents: readonly DegradedModeEvent[],
  issues: readonly ValidationIssue[],
): RetryDecisionReport {
  const severity = decision === "retry_after_backoff" || decision === "repair_then_retry" ? "warning" : decision === "no_retry_needed" ? "info" : "error";
  const event = makeTelemetry(
    decision === "retry_after_backoff" || decision === "repair_then_retry" ? "ModelCallStarted" : "CognitiveRequestRejected",
    request.request_ref,
    request.invocation_policy.model_identifier,
    undefined,
    severity,
    `Retry coordinator decision ${decision} after ${request.failure_kind}.`,
    request.now_ms,
  );
  const base = {
    schema_version: RATE_LIMIT_AND_RETRY_COORDINATOR_SCHEMA_VERSION,
    request_ref: request.request_ref,
    queue: request.queue,
    failure_kind: request.failure_kind,
    attempt_index: request.attempt_index,
    decision,
    next_attempt_at_ms: nextAttemptAtMs,
    backoff_ms: backoffMs,
    retry_budget_remaining: retryBudgetRemaining,
    degraded_mode_events: freezeArray(degradedEvents),
    issues: freezeArray(issues),
    telemetry_event: event,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function computeBackoffMs(request: RetryCoordinationRequest, policy: QueueSchedulingPolicy): number {
  if (request.failure_kind === "rate_limit" && request.rate_limit_signal?.retry_after_ms !== undefined) {
    return clamp(request.rate_limit_signal.retry_after_ms, policy.min_spacing_ms, policy.max_backoff_ms);
  }
  const retryClassMultiplier = retryClassMultiplierFor(request.invocation_policy.retry_class);
  const failureMultiplier = failureMultiplierFor(request.failure_kind);
  const exponential = policy.base_backoff_ms * Math.pow(2, Math.max(0, request.attempt_index)) * retryClassMultiplier * failureMultiplier;
  const jitter = deterministicJitterMs(request.request_ref, request.attempt_index, policy);
  return clamp(Math.round(exponential + jitter), policy.min_spacing_ms, Math.min(policy.max_backoff_ms, MAX_REASONABLE_BACKOFF_MS));
}

function deterministicJitterMs(requestRef: Ref, attemptIndex: number, policy: QueueSchedulingPolicy): number {
  const hash = computeDeterminismHash({ requestRef, attemptIndex, queue: policy.queue });
  const numeric = Number.parseInt(hash.slice(0, 8), 16);
  const normalized = Number.isFinite(numeric) ? (numeric % DETERMINISTIC_JITTER_MODULUS) / DETERMINISTIC_JITTER_MODULUS : 0;
  return Math.round(policy.base_backoff_ms * policy.jitter_ratio * normalized);
}

function retryClassMultiplierFor(retryClass: RetryClass): number {
  if (retryClass === "none") {
    return 0;
  }
  if (retryClass === "single_repair") {
    return 1;
  }
  return 1.35;
}

function failureMultiplierFor(kind: RetryFailureKind): number {
  switch (kind) {
    case "rate_limit":
      return 1.8;
    case "api_timeout":
      return 1.25;
    case "transport_error":
      return 1.4;
    case "malformed_structured_output":
      return 0.6;
    case "unsupported_modality":
      return 0.45;
    case "schema_rejection":
      return 0.75;
    case "preview_behavior_drift":
      return 4;
  }
}

function absoluteDeadlineMs(request: CognitiveSchedulingRequest, policy: QueueSchedulingPolicy): number {
  return request.now_ms + (request.deadline_ms ?? policy.safety_deadline_ms);
}

function wouldMissSafetyDeadline(dispatchAtMs: number, timeoutMs: number, deadlineMs: number, actionBearing: boolean): boolean {
  const requiredMargin = actionBearing ? DEFAULT_SAFE_HOLD_MARGIN_MS : 0;
  return dispatchAtMs + Math.max(0, timeoutMs) + requiredMargin > deadlineMs;
}

function fallbackDecision(fallback: TimeoutFallback): RateLimitDecision {
  switch (fallback) {
    case "safe_hold_without_model":
      return "safe_hold_required";
    case "pause_before_motion":
    case "reobserve_or_residual_only":
      return "degrade_to_deterministic";
    case "defer_without_blocking":
    case "test_harness_retry":
      return "defer";
  }
}

function fallbackEvents(fallback: TimeoutFallback): readonly DegradedModeEvent[] {
  switch (fallback) {
    case "safe_hold_without_model":
      return freezeArray(["safe_hold_entered", "human_visible_telemetry"]);
    case "pause_before_motion":
      return freezeArray(["safe_hold_entered"]);
    case "reobserve_or_residual_only":
      return freezeArray(["deterministic_residual_only", "reobserve_required"]);
    case "defer_without_blocking":
      return freezeArray(["memory_skipped"]);
    case "test_harness_retry":
      return freezeArray(["human_visible_telemetry"]);
  }
}

function noncriticalRateLimitEvents(queue: CognitiveQueue): readonly DegradedModeEvent[] {
  if (queue === "MemoryMaintenance") {
    return freezeArray(["memory_skipped", "human_visible_telemetry"]);
  }
  if (queue === "OfflineQA") {
    return freezeArray(["human_visible_telemetry"]);
  }
  return freezeArray(["deterministic_residual_only"]);
}

function terminalEventsFor(kind: RetryFailureKind, queue: CognitiveQueue, actionBearing: boolean): readonly DegradedModeEvent[] {
  if (actionBearing) {
    return freezeArray(["safe_hold_entered", "human_visible_telemetry"]);
  }
  if (kind === "api_timeout" && queue === "Verification") {
    return freezeArray(["deterministic_residual_only", "reobserve_required"]);
  }
  if (queue === "MemoryMaintenance") {
    return freezeArray(["memory_skipped"]);
  }
  return freezeArray(["human_visible_telemetry"]);
}

function terminalDecisionFor(request: RetryCoordinationRequest): RetryDecision {
  if (request.action_bearing) {
    return "safe_hold_required";
  }
  if (request.queue === "Verification" || request.queue === "MemoryMaintenance" || request.queue === "OfflineQA") {
    return "degrade_without_retry";
  }
  return "terminal_reject";
}

function validateSchedulingRequest(request: CognitiveSchedulingRequest): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateRef(request.request_ref, "$.request_ref", issues);
  if (request.now_ms < 0 || Number.isFinite(request.now_ms) === false) {
    issues.push(issue("error", "InvalidNowTimestamp", "$.now_ms", "Current time must be a finite non-negative millisecond value.", "Pass a monotonic or wall-clock millisecond timestamp."));
  }
  if (request.invocation_policy.timeout_ms <= 0 || Number.isFinite(request.invocation_policy.timeout_ms) === false) {
    issues.push(issue("error", "InvalidInvocationTimeout", "$.invocation_policy.timeout_ms", "Invocation timeout must be finite and positive.", "Use the router or thinking-budget timeout."));
  }
  if (request.deadline_ms !== undefined && (request.deadline_ms <= 0 || Number.isFinite(request.deadline_ms) === false)) {
    issues.push(issue("error", "InvalidDeadline", "$.deadline_ms", "Deadline must be finite and positive when provided.", "Provide a deadline in milliseconds or omit it."));
  }
  return freezeArray(issues);
}

function validateRetryRequest(request: RetryCoordinationRequest): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateRef(request.request_ref, "$.request_ref", issues);
  if (request.attempt_index < 0 || Number.isInteger(request.attempt_index) === false) {
    issues.push(issue("error", "InvalidAttemptIndex", "$.attempt_index", "Attempt index must be a non-negative integer.", "Start the first retry calculation at attempt index zero."));
  }
  if (request.now_ms < request.first_attempt_started_ms) {
    issues.push(issue("error", "RetryTimeReversal", "$.now_ms", "Retry time is earlier than first attempt start.", "Use monotonic timestamps from the same clock."));
  }
  if (request.invocation_policy.timeout_ms <= 0 || Number.isFinite(request.invocation_policy.timeout_ms) === false) {
    issues.push(issue("error", "InvalidInvocationTimeout", "$.invocation_policy.timeout_ms", "Invocation timeout must be finite and positive.", "Use the router or thinking-budget timeout."));
  }
  return freezeArray(issues);
}

function validateQueueState(state: QueueRuntimeState, queue: CognitiveQueue): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (state.queue !== queue) {
    issues.push(issue("error", "QueueStateMismatch", "$.queue_state.queue", "Queue runtime state does not match request queue.", "Use runtime state for the same cognitive queue."));
  }
  if (state.in_flight_count < 0 || Number.isInteger(state.in_flight_count) === false) {
    issues.push(issue("error", "InvalidInFlightCount", "$.queue_state.in_flight_count", "In-flight count must be a non-negative integer.", "Normalize queue runtime counters."));
  }
  for (const [index, timestamp] of state.recent_dispatch_timestamps_ms.entries()) {
    if (timestamp < 0 || Number.isFinite(timestamp) === false) {
      issues.push(issue("error", "InvalidDispatchTimestamp", `$.queue_state.recent_dispatch_timestamps_ms[${index}]`, "Dispatch timestamps must be finite non-negative milliseconds.", "Prune or normalize queue timestamps."));
    }
  }
  return freezeArray(issues);
}

function validatePolicy(policy: QueueSchedulingPolicy): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (policy.priority < 0 || Number.isFinite(policy.priority) === false) {
    issues.push(issue("error", "InvalidQueuePriority", `policy.${policy.queue}.priority`, "Queue priority must be finite and non-negative.", "Use a deterministic queue priority."));
  }
  if (policy.max_concurrent < 1 || Number.isInteger(policy.max_concurrent) === false) {
    issues.push(issue("error", "InvalidMaxConcurrent", `policy.${policy.queue}.max_concurrent`, "Max concurrent requests must be a positive integer.", "Set at least one slot per queue."));
  }
  if (policy.min_spacing_ms < MIN_SPACING_MS || Number.isFinite(policy.min_spacing_ms) === false) {
    issues.push(issue("error", "InvalidMinSpacing", `policy.${policy.queue}.min_spacing_ms`, "Queue minimum spacing is too short or invalid.", "Use a finite spacing that protects request pacing."));
  }
  if (policy.base_backoff_ms < policy.min_spacing_ms || policy.max_backoff_ms < policy.base_backoff_ms) {
    issues.push(issue("error", "InvalidBackoffPolicy", `policy.${policy.queue}.backoff`, "Backoff bounds must be ordered min_spacing <= base <= max.", "Fix the queue backoff configuration."));
  }
  if (policy.jitter_ratio < 0 || policy.jitter_ratio > 0.5 || Number.isFinite(policy.jitter_ratio) === false) {
    issues.push(issue("error", "InvalidJitterRatio", `policy.${policy.queue}.jitter_ratio`, "Jitter ratio must be finite and in the 0..0.5 range.", "Use bounded deterministic jitter."));
  }
  return freezeArray(issues);
}

function validateRef(ref: Ref, path: string, issues: ValidationIssue[]): void {
  if (ref.trim().length === 0) {
    issues.push(issue("error", "EmptyRef", path, "Reference values may not be empty.", "Provide a stable non-empty ref."));
  }
}

function actionBearingInvocation(invocationClass: CognitiveInvocationClass): boolean {
  return invocationClass === "TaskPlanningReasoning"
    || invocationClass === "WaypointGenerationReasoning"
    || invocationClass === "OopsCorrectionReasoning"
    || invocationClass === "ToolUseReasoning"
    || invocationClass === "AudioEventReasoning";
}

function indexPolicies(policies: readonly QueueSchedulingPolicy[]): Readonly<Record<CognitiveQueue, QueueSchedulingPolicy>> {
  const map = new Map<CognitiveQueue, QueueSchedulingPolicy>();
  for (const policy of policies) {
    map.set(policy.queue, freezePolicy(policy));
  }
  const missing = ALL_QUEUES.filter((queue) => map.has(queue) === false);
  if (missing.length > 0) {
    throw new Error(`RateLimitAndRetryCoordinator missing queue policies: ${missing.join(", ")}`);
  }
  return Object.freeze(Object.fromEntries(ALL_QUEUES.map((queue) => [queue, map.get(queue) as QueueSchedulingPolicy])) as Record<CognitiveQueue, QueueSchedulingPolicy>);
}

function freezePolicy(policy: QueueSchedulingPolicy): QueueSchedulingPolicy {
  return Object.freeze({ ...policy });
}

function makePolicy(
  queue: CognitiveQueue,
  priority: number,
  maxConcurrent: number,
  minSpacingMs: number,
  defaultTimeoutMs: number,
  safetyDeadlineMs: number,
  maxRetryAttempts: number,
  baseBackoffMs: number,
  maxBackoffMs: number,
  jitterRatio: number,
  timeoutFallback: TimeoutFallback,
): QueueSchedulingPolicy {
  return Object.freeze({
    queue,
    priority,
    max_concurrent: maxConcurrent,
    min_spacing_ms: minSpacingMs,
    default_timeout_ms: defaultTimeoutMs,
    safety_deadline_ms: safetyDeadlineMs,
    max_retry_attempts: maxRetryAttempts,
    base_backoff_ms: baseBackoffMs,
    max_backoff_ms: maxBackoffMs,
    jitter_ratio: jitterRatio,
    timeout_fallback: timeoutFallback,
  });
}

function makeTelemetry(
  eventType: CognitiveTelemetryEventType,
  requestRef: Ref | undefined,
  modelIdentifier: string | undefined,
  contractRef: Ref | undefined,
  severity: CognitiveTelemetryEvent["severity"],
  summary: string,
  timestampMs: number,
): CognitiveTelemetryEvent {
  const base = {
    event_ref: `rate_retry_evt_${computeDeterminismHash({ eventType, requestRef, modelIdentifier, contractRef, severity, summary, timestampMs }).slice(0, 12)}`,
    event_type: eventType,
    request_ref: requestRef,
    model_identifier: modelIdentifier,
    contract_ref: contractRef,
    severity,
    summary,
    timestamp_ms: timestampMs,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function issue(severity: ValidationSeverity, code: string, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

const ALL_QUEUES: readonly CognitiveQueue[] = freezeArray(["SafetyImmediate", "ExecutionPlanning", "Verification", "MemoryMaintenance", "OfflineQA"]);

const DEFAULT_QUEUE_POLICIES: readonly QueueSchedulingPolicy[] = freezeArray([
  makePolicy("SafetyImmediate", 100, 1, 100, 3000, 3500, 0, 250, 1000, 0.05, "safe_hold_without_model"),
  makePolicy("ExecutionPlanning", 80, 1, 250, 9000, 12000, 1, 750, 4000, 0.1, "pause_before_motion"),
  makePolicy("Verification", 55, 2, 400, 7000, 11000, 1, 900, 5000, 0.12, "reobserve_or_residual_only"),
  makePolicy("MemoryMaintenance", 25, 1, 1000, 9000, 30000, 1, 1500, 15000, 0.15, "defer_without_blocking"),
  makePolicy("OfflineQA", 5, 4, 1500, 30000, 120000, 3, 2000, 60000, 0.2, "test_harness_retry"),
]);

export const RATE_LIMIT_AND_RETRY_COORDINATOR_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: RATE_LIMIT_AND_RETRY_COORDINATOR_SCHEMA_VERSION,
  blueprint: "architecture_docs/06_GEMINI_ROBOTICS_ER_COGNITIVE_LAYER.md",
  sections: freezeArray(["6.6.1", "6.12.1", "6.13.1", "6.13.2", "6.13.3", "6.18.1", "6.18.2", "6.19", "6.20"]),
});
