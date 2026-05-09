/**
 * Anomaly transition router for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md`
 * sections 8.3, 8.5, 8.7, 8.8, 8.9, 8.13, 8.14, 8.16, 8.17, and 8.18.
 *
 * This module implements the executable `AnomalyTransitionRouter`. It converts
 * execution, verification, sensor, audio, validator, and controller failures
 * into auditable transition events for Correct, SafeHold, Reobserve, or
 * HumanReview. It uses evidence freshness, risk, recoverability, safety mode,
 * and retry budget state to prevent false success, runaway correction, unsafe
 * tool loops, and direct execution after failure.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import type {
  EventFamily,
  EventSeverity,
  OrchestrationEventEnvelope,
  OrchestrationEventType,
  PrimaryState,
  RetryBudgetName,
  RetryBudgetState,
  RuntimeStateSnapshot,
} from "./orchestration_state_machine";
import { RetryBudgetManager } from "./retry_budget_manager";
import type {
  RetryBudgetGuardReport,
  RetryStrategyChangeKind,
  RetryStrategyDescriptor,
} from "./retry_budget_manager";

export const ANOMALY_TRANSITION_ROUTER_SCHEMA_VERSION = "mebsuta.anomaly_transition_router.v1" as const;
export const ANOMALY_TRANSITION_ROUTER_VERSION = "1.0.0" as const;

const CONTRACT_TRACEABILITY_REF = "architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md#AnomalyTransitionRouter" as const;
const DEFAULT_EVIDENCE_FRESHNESS_MS = 2_000;
const DEFAULT_VERIFICATION_EVIDENCE_FRESHNESS_MS = 5_000;
const FORBIDDEN_ANOMALY_TEXT_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|qa_|hidden state|collision_mesh|rigid_body_handle|physics_body|exact_com|world_pose|direct actuator|gemini_direct|ignore safety|skip validation|false success|reward policy|reinforcement learning|policy gradient)/i;

export type AnomalyClass =
  | "execution_slip"
  | "execution_drop"
  | "execution_collision"
  | "execution_overshoot"
  | "execution_oscillation"
  | "tool_instability"
  | "controller_timeout"
  | "tracking_error_high"
  | "primitive_failed"
  | "force_limit_exceeded"
  | "speed_limit_exceeded"
  | "impact_sound"
  | "verification_failure"
  | "verification_ambiguous"
  | "residual_too_high"
  | "sensor_loss"
  | "validator_uncertain";
export type AnomalyRiskClass = "low" | "medium" | "high" | "critical";
export type AnomalyRecoverability = "recoverable" | "recoverable_after_reobserve" | "unsafe_until_stabilized" | "unrecoverable" | "unknown";
export type AnomalyRouteDecision = "route_correct" | "route_safe_hold" | "route_reobserve" | "route_human_review";
export type EvidenceAvailability = "complete" | "partial" | "missing" | "stale";
export type AnomalyEvidenceKind = "visual" | "audio" | "contact" | "force_torque" | "controller" | "proprioceptive" | "validator" | "verification" | "operator";

/**
 * Evidence bundle used to route the anomaly. The router accepts references and
 * prompt-safe summaries only; hidden simulator truth is rejected.
 */
export interface AnomalyEvidenceBundle {
  readonly evidence_ref: Ref;
  readonly captured_at_ms: number;
  readonly availability: EvidenceAvailability;
  readonly evidence_kinds: readonly AnomalyEvidenceKind[];
  readonly evidence_refs: readonly Ref[];
  readonly current_observation_ref?: Ref;
  readonly active_plan_ref?: Ref;
  readonly active_primitive_ref?: Ref;
  readonly verification_ref?: Ref;
  readonly prompt_safe_summary: string;
}

export interface AnomalyRiskAssessment {
  readonly risk_ref: Ref;
  readonly risk_class: AnomalyRiskClass;
  readonly recoverability: AnomalyRecoverability;
  readonly safety_relevant: boolean;
  readonly object_possibly_dropped: boolean;
  readonly contact_or_force_limit_breached: boolean;
  readonly collision_possible: boolean;
  readonly human_review_recommended: boolean;
  readonly reason: string;
}

export interface AnomalyRoutingPolicy {
  readonly correction_requires_fresh_evidence: boolean;
  readonly safe_hold_on_high_risk: boolean;
  readonly human_review_on_retry_exhaustion: boolean;
  readonly allow_reobserve_for_ambiguity: boolean;
  readonly allow_correct_after_audio_impact: boolean;
  readonly max_evidence_age_ms?: number;
}

export interface AnomalyRoutingRequest {
  readonly anomaly_event: OrchestrationEventEnvelope;
  readonly snapshot: RuntimeStateSnapshot;
  readonly evidence_bundle: AnomalyEvidenceBundle;
  readonly risk_assessment: AnomalyRiskAssessment;
  readonly retry_budgets?: readonly RetryBudgetState[];
  readonly policy?: Partial<AnomalyRoutingPolicy>;
  readonly previous_strategy_ref?: Ref;
}

export interface AnomalyTransitionPlan {
  readonly transition_event: OrchestrationEventEnvelope;
  readonly target_state: PrimaryState;
  readonly retry_budget_name?: RetryBudgetName;
  readonly retry_guard?: RetryBudgetGuardReport;
  readonly recovery_strategy: RetryStrategyDescriptor;
  readonly required_evidence_refs: readonly Ref[];
  readonly safe_hold_reason?: string;
  readonly human_review_reason?: string;
}

export interface AnomalyTransitionRouterReport {
  readonly schema_version: typeof ANOMALY_TRANSITION_ROUTER_SCHEMA_VERSION;
  readonly router_version: typeof ANOMALY_TRANSITION_ROUTER_VERSION;
  readonly anomaly_class: AnomalyClass;
  readonly route_decision: AnomalyRouteDecision;
  readonly transition_plan: AnomalyTransitionPlan;
  readonly retry_guard?: RetryBudgetGuardReport;
  readonly evidence_status: EvidenceAvailability;
  readonly risk_class: AnomalyRiskClass;
  readonly issue_count: number;
  readonly error_count: number;
  readonly warning_count: number;
  readonly issues: readonly ValidationIssue[];
  readonly traceability_ref: typeof CONTRACT_TRACEABILITY_REF;
  readonly determinism_hash: string;
}

/**
 * Converts anomaly events into deterministic transition plans. The output event
 * is intended for `OrchestrationStateMachine.evaluateStateTransition`.
 */
export class AnomalyTransitionRouter {
  private readonly retryBudgetManager: RetryBudgetManager;

  public constructor(retryBudgetManager: RetryBudgetManager = new RetryBudgetManager()) {
    this.retryBudgetManager = retryBudgetManager;
  }

  /**
   * Routes execution, verification, audio, sensor, and validator anomalies to
   * the File 08 recovery state that matches risk, evidence, and retry state.
   */
  public routeAnomaly(request: AnomalyRoutingRequest): AnomalyTransitionRouterReport {
    const policy = mergePolicy(request.policy);
    const anomalyClass = classifyAnomaly(request.anomaly_event);
    const issues = validateRoutingRequest(request, anomalyClass, policy);
    const retryBudgetName = retryBudgetFor(anomalyClass);
    const strategy = makeRecoveryStrategy(request, anomalyClass);
    const retryGuard = retryBudgetName === undefined
      ? undefined
      : this.retryBudgetManager.evaluateRetryBudgetGuard({
        budget_name: retryBudgetName,
        scope_ref: retryScopeRef(request, anomalyClass),
        owner_state: request.snapshot.primary_state,
        budgets: request.retry_budgets ?? request.snapshot.retry_budget_state,
        snapshot: request.snapshot,
        strategy,
        previous_strategy_ref: request.previous_strategy_ref,
      });
    if (retryGuard !== undefined) {
      issues.push(...retryGuard.issues.filter((guardIssue) => !issues.some((item) => item.code === guardIssue.code && item.path === guardIssue.path)));
    }
    const routeDecision = chooseRoute(request, anomalyClass, policy, retryGuard, issues);
    const target = targetFor(routeDecision);
    const transitionEvent = makeTransitionEvent(request, anomalyClass, routeDecision, target, retryBudgetName);
    const plan = makeTransitionPlan(request, transitionEvent, target, retryBudgetName, retryGuard, strategy, routeDecision);
    return makeReport(anomalyClass, routeDecision, plan, retryGuard, request.evidence_bundle.availability, request.risk_assessment.risk_class, issues);
  }
}

function classifyAnomaly(event: OrchestrationEventEnvelope): AnomalyClass {
  switch (event.event_type) {
    case "SlipDetected":
      return "execution_slip";
    case "DropDetected":
      return "execution_drop";
    case "CollisionDetected":
      return "execution_collision";
    case "OvershootDetected":
      return "execution_overshoot";
    case "OscillationDetected":
      return "execution_oscillation";
    case "ToolInstabilityDetected":
      return "tool_instability";
    case "ControllerTimeout":
      return "controller_timeout";
    case "TrackingErrorHigh":
      return "tracking_error_high";
    case "PrimitiveFailed":
      return "primitive_failed";
    case "ForceLimitExceeded":
      return "force_limit_exceeded";
    case "SpeedLimitExceeded":
      return "speed_limit_exceeded";
    case "ImpactSoundDetected":
      return "impact_sound";
    case "VerificationFailure":
      return "verification_failure";
    case "VerificationAmbiguous":
      return "verification_ambiguous";
    case "ResidualTooHigh":
      return "residual_too_high";
    case "FrameMissing":
    case "SensorHealthDegraded":
      return "sensor_loss";
    case "PlanRejected":
    case "SafeHoldRequired":
      return "validator_uncertain";
    default:
      return event.event_family === "verification" ? "verification_ambiguous" : "primitive_failed";
  }
}

function chooseRoute(
  request: AnomalyRoutingRequest,
  anomalyClass: AnomalyClass,
  policy: AnomalyRoutingPolicy,
  retryGuard: RetryBudgetGuardReport | undefined,
  issues: readonly ValidationIssue[],
): AnomalyRouteDecision {
  const risk = request.risk_assessment;
  const evidence = request.evidence_bundle;
  const guardBlocked = retryGuard !== undefined && !retryGuard.allowed;
  if (issues.some((item) => item.severity === "error") && request.snapshot.safety_mode !== "Normal") {
    return "route_safe_hold";
  }
  if (risk.human_review_recommended || (guardBlocked && policy.human_review_on_retry_exhaustion)) {
    return "route_human_review";
  }
  if (risk.risk_class === "critical" || risk.recoverability === "unrecoverable") {
    return "route_safe_hold";
  }
  if (policy.safe_hold_on_high_risk && (risk.risk_class === "high" || risk.recoverability === "unsafe_until_stabilized" || risk.contact_or_force_limit_breached)) {
    return "route_safe_hold";
  }
  if (anomalyClass === "verification_ambiguous" || anomalyClass === "sensor_loss") {
    return policy.allow_reobserve_for_ambiguity && !guardBlocked ? "route_reobserve" : "route_human_review";
  }
  if (evidence.availability === "missing" || (policy.correction_requires_fresh_evidence && evidence.availability === "stale")) {
    return policy.allow_reobserve_for_ambiguity ? "route_reobserve" : "route_safe_hold";
  }
  if (anomalyClass === "impact_sound" && !policy.allow_correct_after_audio_impact) {
    return "route_safe_hold";
  }
  if (guardBlocked) {
    return retryGuard?.recommended_target === "SafeHold" ? "route_safe_hold" : "route_human_review";
  }
  if (risk.recoverability === "recoverable" || risk.recoverability === "recoverable_after_reobserve" || isCorrectableAnomaly(anomalyClass)) {
    return "route_correct";
  }
  return "route_safe_hold";
}

function isCorrectableAnomaly(anomalyClass: AnomalyClass): boolean {
  return anomalyClass === "execution_slip"
    || anomalyClass === "execution_drop"
    || anomalyClass === "execution_collision"
    || anomalyClass === "execution_overshoot"
    || anomalyClass === "execution_oscillation"
    || anomalyClass === "tool_instability"
    || anomalyClass === "controller_timeout"
    || anomalyClass === "tracking_error_high"
    || anomalyClass === "primitive_failed"
    || anomalyClass === "impact_sound"
    || anomalyClass === "verification_failure"
    || anomalyClass === "residual_too_high";
}

function targetFor(decision: AnomalyRouteDecision): PrimaryState {
  switch (decision) {
    case "route_correct":
      return "Correct";
    case "route_safe_hold":
      return "SafeHold";
    case "route_reobserve":
      return "Reobserve";
    case "route_human_review":
      return "HumanReview";
  }
}

function retryBudgetFor(anomalyClass: AnomalyClass): RetryBudgetName | undefined {
  if (anomalyClass === "verification_ambiguous" || anomalyClass === "sensor_loss") {
    return "ReobserveBudget";
  }
  if (anomalyClass === "tool_instability") {
    return "ToolUseRetryBudget";
  }
  if (anomalyClass === "verification_failure" || anomalyClass === "residual_too_high") {
    return "CorrectionRetryBudget";
  }
  if (anomalyClass === "impact_sound") {
    return "AudioAttentionBudget";
  }
  if (isCorrectableAnomaly(anomalyClass)) {
    return "CorrectionRetryBudget";
  }
  return undefined;
}

function retryScopeRef(request: AnomalyRoutingRequest, anomalyClass: AnomalyClass): Ref {
  if (anomalyClass === "tool_instability") {
    return request.evidence_bundle.active_primitive_ref ?? request.snapshot.active_primitive_ref ?? request.snapshot.task_ref;
  }
  if (anomalyClass === "verification_ambiguous" || anomalyClass === "verification_failure" || anomalyClass === "residual_too_high") {
    return request.evidence_bundle.verification_ref ?? request.snapshot.latest_verification_ref ?? request.snapshot.task_ref;
  }
  if (anomalyClass === "impact_sound") {
    return request.evidence_bundle.evidence_ref;
  }
  return request.anomaly_event.event_type;
}

function makeRecoveryStrategy(request: AnomalyRoutingRequest, anomalyClass: AnomalyClass): RetryStrategyDescriptor {
  const changedAspects: RetryStrategyChangeKind[] = [];
  if (request.evidence_bundle.current_observation_ref !== undefined) {
    changedAspects.push("new_evidence");
  }
  if (anomalyClass === "verification_ambiguous" || anomalyClass === "sensor_loss") {
    changedAspects.push("different_view");
  }
  if (anomalyClass === "execution_overshoot" || anomalyClass === "execution_oscillation" || anomalyClass === "tracking_error_high") {
    changedAspects.push("lower_speed");
  }
  if (anomalyClass === "tool_instability") {
    changedAspects.push("tool_abandoned");
  }
  if (changedAspects.length === 0) {
    changedAspects.push("none");
  }
  return Object.freeze({
    strategy_ref: makeRef("anomaly_strategy", anomalyClass, request.anomaly_event.event_ref, request.evidence_bundle.evidence_ref),
    attempt_kind: retryAttemptKindFor(anomalyClass),
    summary: compactText(`Route ${anomalyClass} using ${request.evidence_bundle.prompt_safe_summary}`),
    evidence_refs: freezeArray(uniqueRefs([request.evidence_bundle.evidence_ref, ...request.evidence_bundle.evidence_refs])),
    changed_aspects: freezeArray(changedAspects),
    target_ref: request.evidence_bundle.active_primitive_ref ?? request.snapshot.active_primitive_ref,
    plan_ref: request.evidence_bundle.active_plan_ref ?? request.snapshot.active_plan_ref,
    observation_ref: request.evidence_bundle.current_observation_ref ?? request.snapshot.latest_observation_ref,
  });
}

function retryAttemptKindFor(anomalyClass: AnomalyClass): RetryStrategyDescriptor["attempt_kind"] {
  if (anomalyClass === "verification_ambiguous" || anomalyClass === "sensor_loss") {
    return "targeted_reobserve";
  }
  if (anomalyClass === "tool_instability") {
    return "tool_assessment";
  }
  if (anomalyClass === "impact_sound") {
    return "audio_attention";
  }
  if (anomalyClass === "verification_failure" || anomalyClass === "residual_too_high") {
    return "oops_correction";
  }
  return "oops_correction";
}

function makeTransitionEvent(
  request: AnomalyRoutingRequest,
  anomalyClass: AnomalyClass,
  decision: AnomalyRouteDecision,
  target: PrimaryState,
  retryBudgetName: RetryBudgetName | undefined,
): OrchestrationEventEnvelope {
  const source = request.anomaly_event;
  const eventType = eventTypeForRoute(decision, anomalyClass, source.event_type);
  const severity = severityForRoute(decision, request.risk_assessment.risk_class);
  const payloadRefs = uniqueRefs([
    ...source.payload_refs,
    request.evidence_bundle.evidence_ref,
    ...request.evidence_bundle.evidence_refs,
    request.evidence_bundle.current_observation_ref,
    request.evidence_bundle.active_plan_ref,
    request.evidence_bundle.active_primitive_ref,
    request.evidence_bundle.verification_ref,
    request.risk_assessment.risk_ref,
  ]);
  const base = {
    event_ref: makeRef("event", "anomaly_route", source.event_ref, target, request.evidence_bundle.evidence_ref),
    event_type: eventType,
    event_family: eventFamilyFor(target, anomalyClass),
    severity,
    session_ref: request.snapshot.session_ref,
    task_ref: request.snapshot.task_ref,
    source_state_ref: request.snapshot.primary_state,
    context_ref: request.snapshot.current_context_ref,
    payload_refs: payloadRefs,
    provenance_classes: freezeArray(["sensor", "controller", "validator", "telemetry", "safety"] as const),
    occurred_at_ms: source.occurred_at_ms,
    human_summary: humanSummaryFor(request, anomalyClass, target),
    target_state_hint: target,
    consumes_retry_budget: retryBudgetName,
    observation_ref: request.evidence_bundle.current_observation_ref ?? request.snapshot.latest_observation_ref,
    plan_ref: request.evidence_bundle.active_plan_ref ?? request.snapshot.active_plan_ref,
    primitive_ref: request.evidence_bundle.active_primitive_ref ?? request.snapshot.active_primitive_ref,
    verification_ref: request.evidence_bundle.verification_ref ?? request.snapshot.latest_verification_ref,
    safety_mode_override: target === "SafeHold" ? "SafeHoldRequired" as const : target === "HumanReview" ? "Blocked" as const : undefined,
  };
  return Object.freeze(base);
}

function eventTypeForRoute(
  decision: AnomalyRouteDecision,
  anomalyClass: AnomalyClass,
  fallback: OrchestrationEventType,
): OrchestrationEventType {
  if (decision === "route_human_review") {
    return "RetryBudgetExhausted";
  }
  if (decision === "route_safe_hold") {
    return "SafeHoldCommanded";
  }
  if (decision === "route_reobserve") {
    return anomalyClass === "verification_ambiguous" ? "VerificationAmbiguous" : "ObservationAmbiguous";
  }
  if (anomalyClass === "verification_failure" || anomalyClass === "residual_too_high") {
    return "VerificationFailure";
  }
  return fallback;
}

function eventFamilyFor(target: PrimaryState, anomalyClass: AnomalyClass): EventFamily {
  if (target === "SafeHold" || target === "HumanReview") {
    return "safety";
  }
  if (target === "Reobserve") {
    return anomalyClass === "verification_ambiguous" ? "verification" : "sensor";
  }
  return anomalyClass === "verification_failure" || anomalyClass === "residual_too_high" ? "verification" : "anomaly";
}

function severityForRoute(decision: AnomalyRouteDecision, risk: AnomalyRiskClass): EventSeverity {
  if (risk === "critical") {
    return "critical";
  }
  if (decision === "route_safe_hold" || decision === "route_human_review" || risk === "high") {
    return "error";
  }
  if (decision === "route_reobserve" || risk === "medium") {
    return "warning";
  }
  return "notice";
}

function humanSummaryFor(request: AnomalyRoutingRequest, anomalyClass: AnomalyClass, target: PrimaryState): string {
  return compactText(`${anomalyClass} routed to ${target}. Evidence ${request.evidence_bundle.evidence_ref}; risk ${request.risk_assessment.risk_class}; ${request.risk_assessment.reason}`);
}

function makeTransitionPlan(
  request: AnomalyRoutingRequest,
  event: OrchestrationEventEnvelope,
  target: PrimaryState,
  retryBudgetName: RetryBudgetName | undefined,
  retryGuard: RetryBudgetGuardReport | undefined,
  strategy: RetryStrategyDescriptor,
  decision: AnomalyRouteDecision,
): AnomalyTransitionPlan {
  return Object.freeze({
    transition_event: event,
    target_state: target,
    retry_budget_name: retryBudgetName,
    retry_guard: retryGuard,
    recovery_strategy: strategy,
    required_evidence_refs: freezeArray(uniqueRefs([request.evidence_bundle.evidence_ref, ...request.evidence_bundle.evidence_refs])),
    safe_hold_reason: decision === "route_safe_hold" ? request.risk_assessment.reason : undefined,
    human_review_reason: decision === "route_human_review" ? request.risk_assessment.reason : undefined,
  });
}

function validateRoutingRequest(
  request: AnomalyRoutingRequest,
  anomalyClass: AnomalyClass,
  policy: AnomalyRoutingPolicy,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateRef(request.anomaly_event.event_ref, "$.anomaly_event.event_ref", issues);
  validateRef(request.evidence_bundle.evidence_ref, "$.evidence_bundle.evidence_ref", issues);
  validateRef(request.risk_assessment.risk_ref, "$.risk_assessment.risk_ref", issues);
  validateSafeText(request.anomaly_event.human_summary, "$.anomaly_event.human_summary", true, issues);
  validateSafeText(request.evidence_bundle.prompt_safe_summary, "$.evidence_bundle.prompt_safe_summary", true, issues);
  validateSafeText(request.risk_assessment.reason, "$.risk_assessment.reason", true, issues);
  if (request.anomaly_event.session_ref !== request.snapshot.session_ref || request.anomaly_event.task_ref !== request.snapshot.task_ref) {
    issues.push(issue("error", "AnomalySessionTaskMismatch", "$.anomaly_event", "Anomaly event does not match the current runtime snapshot.", "Reject stale or cross-session anomaly events."));
  }
  if (request.anomaly_event.source_state_ref !== undefined && request.anomaly_event.source_state_ref !== request.snapshot.primary_state) {
    issues.push(issue("warning", "AnomalySourceStateDiffers", "$.anomaly_event.source_state_ref", "Anomaly event source state differs from current snapshot.", "Confirm asynchronous anomaly freshness before committing the transition."));
  }
  const maxAgeMs = policy.max_evidence_age_ms ?? (anomalyClass === "verification_ambiguous" || anomalyClass === "verification_failure" ? DEFAULT_VERIFICATION_EVIDENCE_FRESHNESS_MS : DEFAULT_EVIDENCE_FRESHNESS_MS);
  const evidenceAgeMs = Math.max(0, request.anomaly_event.occurred_at_ms - request.evidence_bundle.captured_at_ms);
  if (evidenceAgeMs > maxAgeMs || request.evidence_bundle.availability === "stale") {
    issues.push(issue("warning", "AnomalyEvidenceStale", "$.evidence_bundle.captured_at_ms", "Anomaly evidence is stale relative to the event.", "Prefer Reobserve or SafeHold before correction."));
  }
  if (request.evidence_bundle.availability === "missing" && anomalyClass !== "sensor_loss") {
    issues.push(issue("error", "AnomalyEvidenceMissing", "$.evidence_bundle.availability", "Anomaly routing requires evidence unless the anomaly is sensor loss.", "Capture visual, controller, contact, audio, or verification evidence."));
  }
  if (request.risk_assessment.contact_or_force_limit_breached && request.risk_assessment.risk_class !== "high" && request.risk_assessment.risk_class !== "critical") {
    issues.push(issue("warning", "RiskAssessmentUnderrated", "$.risk_assessment.risk_class", "Contact or force breach should be high or critical risk.", "Review risk classification before routing."));
  }
  return issues;
}

function makeReport(
  anomalyClass: AnomalyClass,
  routeDecision: AnomalyRouteDecision,
  plan: AnomalyTransitionPlan,
  retryGuard: RetryBudgetGuardReport | undefined,
  evidenceStatus: EvidenceAvailability,
  riskClass: AnomalyRiskClass,
  issues: readonly ValidationIssue[],
): AnomalyTransitionRouterReport {
  const base = {
    schema_version: ANOMALY_TRANSITION_ROUTER_SCHEMA_VERSION,
    router_version: ANOMALY_TRANSITION_ROUTER_VERSION,
    anomaly_class: anomalyClass,
    route_decision: routeDecision,
    transition_plan: plan,
    retry_guard: retryGuard,
    evidence_status: evidenceStatus,
    risk_class: riskClass,
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

function mergePolicy(policy: Partial<AnomalyRoutingPolicy> | undefined): AnomalyRoutingPolicy {
  return Object.freeze({
    correction_requires_fresh_evidence: policy?.correction_requires_fresh_evidence ?? true,
    safe_hold_on_high_risk: policy?.safe_hold_on_high_risk ?? true,
    human_review_on_retry_exhaustion: policy?.human_review_on_retry_exhaustion ?? true,
    allow_reobserve_for_ambiguity: policy?.allow_reobserve_for_ambiguity ?? true,
    allow_correct_after_audio_impact: policy?.allow_correct_after_audio_impact ?? true,
    max_evidence_age_ms: policy?.max_evidence_age_ms,
  });
}

function validateRef(ref: Ref, path: string, issues: ValidationIssue[]): void {
  if (ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(issue("error", "ReferenceInvalid", path, "Reference must be non-empty and whitespace-free.", "Use a stable opaque reference."));
  }
  if (FORBIDDEN_ANOMALY_TEXT_PATTERN.test(ref)) {
    issues.push(issue("error", "ReferenceForbiddenForAnomalyRouting", path, "Reference contains forbidden anomaly-routing detail.", "Use opaque sensor, controller, validation, or telemetry refs."));
  }
}

function validateSafeText(value: string, path: string, required: boolean, issues: ValidationIssue[]): void {
  if (required && value.trim().length === 0) {
    issues.push(issue("error", "AnomalyTextRequired", path, "Anomaly routing text is required.", "Provide concise prompt-safe routing text."));
  }
  if (FORBIDDEN_ANOMALY_TEXT_PATTERN.test(value)) {
    issues.push(issue("error", "AnomalyTextForbidden", path, "Anomaly routing text contains hidden truth, backend, direct-control, or unsafe wording.", "Use sensor, controller, validator, and safety summaries only."));
  }
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 900);
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

export const ANOMALY_TRANSITION_ROUTER_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: ANOMALY_TRANSITION_ROUTER_SCHEMA_VERSION,
  blueprint: "architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md",
  sections: freezeArray(["8.3", "8.5", "8.7", "8.8", "8.9", "8.13", "8.14", "8.16", "8.17", "8.18"]),
  traceability_ref: CONTRACT_TRACEABILITY_REF,
  route_targets: freezeArray(["Correct", "SafeHold", "Reobserve", "HumanReview"] as readonly PrimaryState[]),
});
