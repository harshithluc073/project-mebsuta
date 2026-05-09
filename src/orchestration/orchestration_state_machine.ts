/**
 * Orchestration state machine for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md`
 * sections 8.3 through 8.18.
 *
 * This module implements the executable `OrchestrationStateMachine`. It owns
 * the authoritative runtime lifecycle state, evaluates guarded state
 * transitions, enforces safety preemption, consumes finite retry budgets, blocks
 * stale asynchronous responses, preserves command ownership, and emits
 * deterministic transition audit records. It never executes physics or sends
 * prompts; it only decides whether a transition is allowed and records why.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";

export const ORCHESTRATION_STATE_MACHINE_SCHEMA_VERSION = "mebsuta.orchestration_state_machine.v1" as const;
export const ORCHESTRATION_STATE_MACHINE_VERSION = "1.0.0" as const;

const CONTRACT_TRACEABILITY_REF = "architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md#OrchestrationStateMachine" as const;
const DEFAULT_CLOCK_REF = "runtime_clock:scenario_replay_clock" as const;
const FORBIDDEN_STATE_PAYLOAD_PATTERN = /(mujoco|babylon|backend|engine|scene_graph|world_truth|ground_truth|qa_|collision_mesh|segmentation truth|debug buffer|simulator|physics_body|rigid_body_handle|joint_handle|object_id|exact_com|world_pose|hidden pose|hidden state|system prompt|developer prompt|chain-of-thought|scratchpad|private deliberation|direct actuator|raw actuator|joint torque|joint current|set joint|apply force|apply impulse|physics step|reward policy|policy gradient|reinforcement learning|rl update|ignore validators|override safety|disable safe-hold|skip validation|without validation)/i;

export type PrimaryState =
  | "Initialize"
  | "Observe"
  | "Reobserve"
  | "Plan"
  | "PlanRepair"
  | "Validate"
  | "Monologue"
  | "Execute"
  | "Verify"
  | "Correct"
  | "MemoryUpdate"
  | "AudioAttend"
  | "ToolAssess"
  | "SafeHold"
  | "HumanReview"
  | "Complete"
  | "Abort";

export type SafetyMode = "Normal" | "Caution" | "Blocked" | "SafeHoldRequired" | "AbortRequired";
export type GuardDecision = "pass" | "fail" | "warning" | "not_applicable";
export type TransitionDecisionKind = "approved" | "blocked" | "escalated";
export type EventSeverity = "info" | "notice" | "warning" | "error" | "critical";
export type EventFamily = "task" | "sensor" | "cognitive" | "validation" | "monologue" | "execution" | "anomaly" | "verification" | "memory" | "audio" | "safety" | "operator";

export type OrchestrationEventType =
  | "TaskReceived"
  | "TaskCancelled"
  | "TaskCompleted"
  | "TaskReset"
  | "ObservationReady"
  | "ObservationAmbiguous"
  | "FrameMissing"
  | "SensorHealthDegraded"
  | "VerificationRequested"
  | "PromptReady"
  | "ModelResponseReceived"
  | "ModelTimeout"
  | "ResponseRepairRequired"
  | "ResponseRejected"
  | "PlanApproved"
  | "PlanRejected"
  | "PlanRepairRequested"
  | "SafeHoldRequired"
  | "MonologueReady"
  | "SpeechStarted"
  | "SpeechCompleted"
  | "SpeechInterrupted"
  | "SpeechFailed"
  | "PrimitiveStarted"
  | "PrimitiveCompleted"
  | "PrimitiveFailed"
  | "ControllerTimeout"
  | "TrackingErrorHigh"
  | "SlipDetected"
  | "DropDetected"
  | "CollisionDetected"
  | "OvershootDetected"
  | "OscillationDetected"
  | "ToolInstabilityDetected"
  | "VerificationSuccess"
  | "VerificationFailure"
  | "VerificationAmbiguous"
  | "ResidualTooHigh"
  | "MemoryRetrieved"
  | "MemoryWriteCandidateReady"
  | "MemoryWritten"
  | "MemoryContradictionDetected"
  | "AudioEventDetected"
  | "AudioDirectionEstimated"
  | "ImpactSoundDetected"
  | "AudioAmbiguous"
  | "AudioActionApproved"
  | "ReachLimitationDetected"
  | "ToolCandidateVisible"
  | "ToolPlanCandidateReady"
  | "NoSafeToolCandidate"
  | "SafeHoldCommanded"
  | "AbortCommanded"
  | "RetryBudgetExhausted"
  | "ForceLimitExceeded"
  | "SpeedLimitExceeded"
  | "OperatorPause"
  | "OperatorResume"
  | "OperatorAbort"
  | "OperatorClarification";

export type RetryBudgetName =
  | "PromptRepairBudget"
  | "PlanningRetryBudget"
  | "ReobserveBudget"
  | "CorrectionRetryBudget"
  | "ToolUseRetryBudget"
  | "VerificationRetryBudget"
  | "AudioAttentionBudget";

export type DeadlineClass =
  | "SensorFrameDeadline"
  | "RoutinePlanningDeadline"
  | "CorrectionPlanningDeadline"
  | "AnomalyDetectionDeadline"
  | "MonologueStartDeadline"
  | "PrimitiveExecutionDeadline"
  | "VerificationDeadline"
  | "RepairDeadline";

export type PayloadProvenanceClass = "sensor" | "memory" | "validator" | "task" | "safety" | "schema" | "controller" | "telemetry" | "operator" | "qa_only" | "restricted";

export interface RetryBudgetState {
  readonly budget_name: RetryBudgetName;
  readonly scope_ref: Ref;
  readonly remaining_attempts: number;
  readonly last_attempt_reason?: string;
  readonly last_failure_reason?: string;
  readonly requires_strategy_change: boolean;
  readonly exhaustion_transition: "SafeHold" | "HumanReview" | "Abort" | "FailureCertificate";
}

export interface DeadlineStateEntry {
  readonly deadline_ref: Ref;
  readonly deadline_class: DeadlineClass;
  readonly owner_state: PrimaryState;
  readonly started_at_ms: number;
  readonly duration_ms: number;
  readonly timeout_target: PrimaryState;
  readonly elapsed_ms: number;
  readonly expired: boolean;
}

export interface RuntimeStateSnapshot {
  readonly schema_version: typeof ORCHESTRATION_STATE_MACHINE_SCHEMA_VERSION;
  readonly session_ref: Ref;
  readonly task_ref: Ref;
  readonly primary_state: PrimaryState;
  readonly substate?: string;
  readonly safety_mode: SafetyMode;
  readonly embodiment_ref: Ref;
  readonly active_plan_ref?: Ref;
  readonly active_primitive_ref?: Ref;
  readonly latest_observation_ref?: Ref;
  readonly latest_verification_ref?: Ref;
  readonly retry_budget_state: readonly RetryBudgetState[];
  readonly deadline_state: readonly DeadlineStateEntry[];
  readonly memory_context_refs: readonly Ref[];
  readonly audit_refs: readonly Ref[];
  readonly current_context_ref: Ref;
  readonly command_owner_state?: PrimaryState;
  readonly updated_at_ms: number;
  readonly determinism_hash: string;
}

export interface StateGuardDecision {
  readonly guard_name: string;
  readonly decision: GuardDecision;
  readonly reason: string;
  readonly blocking: boolean;
  readonly recovery_hint?: PrimaryState | "RejectEvent" | "QuarantineOnly";
  readonly evidence_refs: readonly Ref[];
}

export interface StateTransitionRecord {
  readonly schema_version: typeof ORCHESTRATION_STATE_MACHINE_SCHEMA_VERSION;
  readonly transition_ref: Ref;
  readonly from_state: PrimaryState;
  readonly to_state: PrimaryState;
  readonly trigger_event: OrchestrationEventType;
  readonly guard_results: readonly StateGuardDecision[];
  readonly payload_refs: readonly Ref[];
  readonly safety_mode_before: SafetyMode;
  readonly safety_mode_after: SafetyMode;
  readonly human_visible_summary: string;
  readonly timestamp_ref: Ref;
  readonly determinism_hash: string;
}

export interface OrchestrationEventEnvelope {
  readonly event_ref: Ref;
  readonly event_type: OrchestrationEventType;
  readonly event_family?: EventFamily;
  readonly severity: EventSeverity;
  readonly session_ref: Ref;
  readonly task_ref: Ref;
  readonly source_state_ref?: PrimaryState;
  readonly context_ref?: Ref;
  readonly payload_refs: readonly Ref[];
  readonly provenance_classes: readonly PayloadProvenanceClass[];
  readonly occurred_at_ms: number;
  readonly human_summary: string;
  readonly target_state_hint?: PrimaryState;
  readonly consumes_retry_budget?: RetryBudgetName;
  readonly deadline_ref?: Ref;
  readonly contract_ref?: Ref;
  readonly observation_ref?: Ref;
  readonly plan_ref?: Ref;
  readonly primitive_ref?: Ref;
  readonly verification_ref?: Ref;
  readonly safety_mode_override?: SafetyMode;
  readonly validation_approved?: boolean;
  readonly monologue_required?: boolean;
  readonly operator_resume_target?: PrimaryState;
}

export interface StateTransitionDecision {
  readonly schema_version: typeof ORCHESTRATION_STATE_MACHINE_SCHEMA_VERSION;
  readonly decision: TransitionDecisionKind;
  readonly event_ref: Ref;
  readonly from_snapshot_ref: Ref;
  readonly proposed_to_state?: PrimaryState;
  readonly transition_record?: StateTransitionRecord;
  readonly consumed_retry_budget?: RetryBudgetState;
  readonly guard_results: readonly StateGuardDecision[];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface InitializeRuntimeStateRequest {
  readonly session_ref: Ref;
  readonly task_ref: Ref;
  readonly embodiment_ref: Ref;
  readonly initialized_at_ms: number;
  readonly safety_mode?: SafetyMode;
  readonly memory_context_refs?: readonly Ref[];
  readonly audit_refs?: readonly Ref[];
}

export interface GuardPolicy {
  readonly now_ms?: number;
  readonly allow_stale_async_context_refs?: readonly Ref[];
  readonly payload_refs_requiring_current_context?: readonly Ref[];
  readonly current_observation_max_age_ms?: number;
  readonly active_observation_age_ms?: number;
  readonly allow_monologue_skip?: boolean;
  readonly require_validation_for_execute?: boolean;
  readonly allow_tool_reposition_plan?: boolean;
}

interface TransitionRule {
  readonly from: PrimaryState | "Any";
  readonly event_type: OrchestrationEventType;
  readonly to: PrimaryState;
  readonly note: string;
  readonly budget?: RetryBudgetName;
}

/**
 * Authoritative runtime lifecycle state machine. The implementation is
 * deterministic and immutable: each transition decision contains all guard
 * results and, when approved, a complete audit record suitable for replay.
 */
export class OrchestrationStateMachine {
  private readonly transitionRules: readonly TransitionRule[];

  public constructor(transitionRules: readonly TransitionRule[] = DEFAULT_TRANSITION_RULES) {
    this.transitionRules = freezeArray(transitionRules);
  }

  /**
   * Creates the initial runtime snapshot with default retry budgets and an
   * Initialize primary state. No cognitive or actuator work is started here.
   */
  public initializeRuntimeState(request: InitializeRuntimeStateRequest): RuntimeStateSnapshot {
    const issues: ValidationIssue[] = [];
    validateRef(request.session_ref, "$.session_ref", issues);
    validateRef(request.task_ref, "$.task_ref", issues);
    validateRef(request.embodiment_ref, "$.embodiment_ref", issues);
    if (issues.some((item) => item.severity === "error")) {
      throw new Error(`Invalid runtime initialization: ${issues.map((item) => item.code).join(", ")}`);
    }
    return makeSnapshot({
      session_ref: request.session_ref,
      task_ref: request.task_ref,
      primary_state: "Initialize",
      substate: "runtime session initialized; waiting for task and sensor readiness",
      safety_mode: request.safety_mode ?? "Normal",
      embodiment_ref: request.embodiment_ref,
      retry_budget_state: defaultRetryBudgets(request.task_ref),
      deadline_state: freezeArray([]),
      memory_context_refs: freezeArray(request.memory_context_refs ?? []),
      audit_refs: freezeArray([...(request.audit_refs ?? []), makeRef("audit", request.session_ref, "initialize")]),
      current_context_ref: makeRef("state_context", request.session_ref, request.task_ref, "Initialize", String(request.initialized_at_ms)),
      updated_at_ms: request.initialized_at_ms,
    });
  }

  /**
   * Evaluates a state transition against transition-table legality, freshness,
   * safety interlocks, payload provenance, retry budget, deadline, contract,
   * observation currency, and command ownership guards.
   */
  public evaluateStateTransition(
    currentSnapshot: RuntimeStateSnapshot,
    event: OrchestrationEventEnvelope,
    guardPolicy: GuardPolicy = {},
  ): StateTransitionDecision {
    const issues: ValidationIssue[] = [];
    validateSnapshot(currentSnapshot, issues);
    validateEvent(event, currentSnapshot, issues);
    const proposedState = resolveTargetState(currentSnapshot.primary_state, event, this.transitionRules, guardPolicy);
    const guardResults = evaluateGuards(currentSnapshot, event, proposedState, guardPolicy);
    const blocking = guardResults.some((guard) => guard.blocking);
    const safetyEscalated = proposedState === "SafeHold" || proposedState === "Abort" || proposedState === "HumanReview";
    const decision: TransitionDecisionKind = blocking ? "blocked" : safetyEscalated ? "escalated" : "approved";
    const consumedBudget = blocking || proposedState === undefined ? undefined : consumeBudgetIfNeeded(currentSnapshot, event, proposedState);
    const transitionRecord = blocking || proposedState === undefined
      ? undefined
      : buildTransitionRecord(currentSnapshot, event, proposedState, guardResults, consumedBudget?.budget_name);
    return makeDecision(currentSnapshot, event, decision, proposedState, transitionRecord, consumedBudget, guardResults, issues);
  }

  /**
   * Applies an approved or escalated transition decision to a snapshot and
   * returns the next immutable runtime state. Blocked decisions do not mutate
   * primary state and only add the decision audit reference.
   */
  public commitStateTransition(currentSnapshot: RuntimeStateSnapshot, decision: StateTransitionDecision): RuntimeStateSnapshot {
    if (decision.transition_record === undefined || decision.proposed_to_state === undefined || decision.decision === "blocked") {
      return makeSnapshot({
        ...snapshotBase(currentSnapshot),
        substate: decision.decision === "blocked" ? "transition blocked; state unchanged" : currentSnapshot.substate,
        audit_refs: freezeArray([...currentSnapshot.audit_refs, makeRef("blocked_transition", decision.event_ref)]),
      });
    }
    const record = decision.transition_record;
    const nextState = decision.proposed_to_state;
    const retryBudgets = decision.consumed_retry_budget === undefined
      ? currentSnapshot.retry_budget_state
      : replaceRetryBudget(currentSnapshot.retry_budget_state, decision.consumed_retry_budget);
    return makeSnapshot({
      ...snapshotBase(currentSnapshot),
      primary_state: nextState,
      substate: substateFor(nextState, record.trigger_event),
      safety_mode: record.safety_mode_after,
      active_plan_ref: nextActivePlanRef(currentSnapshot, nextState, record),
      active_primitive_ref: nextActivePrimitiveRef(currentSnapshot, nextState, record),
      latest_observation_ref: nextObservationRef(currentSnapshot, record),
      latest_verification_ref: nextVerificationRef(currentSnapshot, record),
      retry_budget_state: retryBudgets,
      deadline_state: refreshDeadlinesForState(currentSnapshot.deadline_state, nextState, record),
      audit_refs: freezeArray([...currentSnapshot.audit_refs, record.transition_ref]),
      current_context_ref: makeRef("state_context", currentSnapshot.session_ref, currentSnapshot.task_ref, nextState, String(record.timestamp_ref)),
      command_owner_state: commandOwnerFor(nextState),
      updated_at_ms: timestampMsFromRef(record.timestamp_ref, currentSnapshot.updated_at_ms),
    });
  }

  /**
   * Builds an immediate safety transition decision. Critical abort events route
   * to Abort; all other safety interruptions route to SafeHold.
   */
  public interruptForSafety(
    currentSnapshot: RuntimeStateSnapshot,
    safetyEvent: OrchestrationEventEnvelope,
    guardPolicy: GuardPolicy = {},
  ): StateTransitionDecision {
    const target: PrimaryState = safetyEvent.event_type === "AbortCommanded" || safetyEvent.severity === "critical" || currentSnapshot.safety_mode === "AbortRequired"
      ? "Abort"
      : "SafeHold";
    const event = Object.freeze({
      ...safetyEvent,
      target_state_hint: target,
      safety_mode_override: target === "Abort" ? "AbortRequired" as const : "SafeHoldRequired" as const,
    });
    return this.evaluateStateTransition(currentSnapshot, event, guardPolicy);
  }

  /**
   * Resumes from SafeHold. File 08 requires resume to prefer fresh observation,
   * never direct execution of an old plan.
   */
  public resumeFromSafeHold(
    safeHoldSnapshot: RuntimeStateSnapshot,
    resumeIntent: "fresh_observation" | "replan" | "correct" | "human_review" | "abort",
    operatorDecision: OrchestrationEventEnvelope,
    guardPolicy: GuardPolicy = {},
  ): StateTransitionDecision {
    const targetByIntent: Readonly<Record<typeof resumeIntent, PrimaryState>> = {
      fresh_observation: "Observe",
      replan: "Plan",
      correct: "Correct",
      human_review: "HumanReview",
      abort: "Abort",
    };
    const target = safeHoldSnapshot.primary_state === "SafeHold" ? targetByIntent[resumeIntent] : "HumanReview";
    const safeTarget = target === "Execute" ? "Observe" : target;
    const event = Object.freeze({
      ...operatorDecision,
      event_type: target === "Abort" ? "OperatorAbort" as const : "OperatorResume" as const,
      target_state_hint: safeTarget,
      safety_mode_override: target === "Abort" ? "AbortRequired" as const : "Normal" as const,
    });
    return this.evaluateStateTransition(safeHoldSnapshot, event, guardPolicy);
  }
}

function evaluateGuards(
  snapshot: RuntimeStateSnapshot,
  event: OrchestrationEventEnvelope,
  proposedState: PrimaryState | undefined,
  policy: GuardPolicy,
): readonly StateGuardDecision[] {
  return freezeArray([
    stateFreshnessGuard(snapshot, event, policy),
    transitionLegalityGuard(snapshot, event, proposedState),
    safetyInterlockGuard(snapshot, event, proposedState),
    payloadProvenanceGuard(event, proposedState),
    retryBudgetGuard(snapshot, event, proposedState),
    deadlineGuard(snapshot, event, policy),
    contractCompatibilityGuard(snapshot, event, proposedState),
    observationCurrencyGuard(snapshot, proposedState, policy),
    commandOwnershipGuard(snapshot, event, proposedState),
  ]);
}

function stateFreshnessGuard(snapshot: RuntimeStateSnapshot, event: OrchestrationEventEnvelope, policy: GuardPolicy): StateGuardDecision {
  const acceptedRefs = new Set([snapshot.current_context_ref, ...(policy.allow_stale_async_context_refs ?? [])]);
  const requiresCurrent = event.context_ref !== undefined && contextRequiredFor(event);
  const ok = !requiresCurrent || acceptedRefs.has(event.context_ref as Ref);
  return guard("StateFreshnessGuard", ok ? "pass" : "fail", ok ? "Event context is current or explicitly allowed." : "Event context is stale for the current runtime state.", !ok, ok ? undefined : "QuarantineOnly", event.context_ref === undefined ? [] : [event.context_ref]);
}

function transitionLegalityGuard(snapshot: RuntimeStateSnapshot, event: OrchestrationEventEnvelope, proposedState: PrimaryState | undefined): StateGuardDecision {
  const ok = proposedState !== undefined && !(TERMINAL_STATES.includes(snapshot.primary_state) && snapshot.primary_state !== "Complete");
  return guard("TransitionTableGuard", ok ? "pass" : "fail", ok ? "Transition is present in the File 08 transition table." : "Transition is illegal for the current primary state.", !ok, "RejectEvent", event.payload_refs);
}

function safetyInterlockGuard(snapshot: RuntimeStateSnapshot, event: OrchestrationEventEnvelope, proposedState: PrimaryState | undefined): StateGuardDecision {
  if (event.event_type === "AbortCommanded" || proposedState === "Abort") {
    return guard("SafetyInterlockGuard", "pass", "Abort transition is safety-authorized.", false, undefined, event.payload_refs);
  }
  if (snapshot.safety_mode === "AbortRequired") {
    return guard("SafetyInterlockGuard", "fail", "Abort-required safety mode blocks non-abort transitions.", true, "Abort", event.payload_refs);
  }
  if (snapshot.safety_mode === "SafeHoldRequired" && proposedState !== "SafeHold" && snapshot.primary_state !== "SafeHold") {
    return guard("SafetyInterlockGuard", "fail", "Safe-hold-required mode blocks non-SafeHold transitions.", true, "SafeHold", event.payload_refs);
  }
  if (snapshot.safety_mode === "Blocked" && proposedState === "Execute") {
    return guard("SafetyInterlockGuard", "fail", "Blocked safety mode prevents execution.", true, "SafeHold", event.payload_refs);
  }
  if (event.severity === "critical" && proposedState !== "SafeHold") {
    return guard("SafetyInterlockGuard", "fail", "Critical event must route to SafeHold or Abort.", true, "SafeHold", event.payload_refs);
  }
  return guard("SafetyInterlockGuard", event.severity === "warning" ? "warning" : "pass", event.severity === "warning" ? "Warning event may require caution mode." : "Safety mode permits transition.", false, undefined, event.payload_refs);
}

function payloadProvenanceGuard(event: OrchestrationEventEnvelope, proposedState: PrimaryState | undefined): StateGuardDecision {
  const cognitiveFacing = proposedState !== undefined && COGNITIVE_FACING_STATES.includes(proposedState);
  const restricted = event.provenance_classes.some((item) => item === "qa_only" || item === "restricted");
  const forbiddenRef = event.payload_refs.some((ref) => FORBIDDEN_STATE_PAYLOAD_PATTERN.test(ref)) || FORBIDDEN_STATE_PAYLOAD_PATTERN.test(event.human_summary);
  const ok = !cognitiveFacing || (!restricted && !forbiddenRef);
  return guard("PayloadProvenanceGuard", ok ? "pass" : "fail", ok ? "Payload provenance is allowed for the target state." : "Cognitive-facing transition contains restricted or hidden-truth payload.", !ok, "QuarantineOnly", event.payload_refs);
}

function retryBudgetGuard(snapshot: RuntimeStateSnapshot, event: OrchestrationEventEnvelope, proposedState: PrimaryState | undefined): StateGuardDecision {
  const budgetName = event.consumes_retry_budget ?? retryBudgetForTransition(event, proposedState);
  if (budgetName === undefined) {
    return guard("RetryBudgetGuard", "not_applicable", "Transition does not consume retry budget.", false, undefined, event.payload_refs);
  }
  const budget = snapshot.retry_budget_state.find((item) => item.budget_name === budgetName);
  const ok = budget !== undefined && budget.remaining_attempts > 0;
  return guard("RetryBudgetGuard", ok ? "pass" : "fail", ok ? `${budgetName} has remaining attempts.` : `${budgetName} is exhausted or missing.`, !ok, exhaustionTarget(budget), budget === undefined ? event.payload_refs : [budget.scope_ref, ...event.payload_refs]);
}

function deadlineGuard(snapshot: RuntimeStateSnapshot, event: OrchestrationEventEnvelope, policy: GuardPolicy): StateGuardDecision {
  const nowMs = policy.now_ms ?? event.occurred_at_ms;
  const expired = snapshot.deadline_state.filter((deadline) => deadline.owner_state === snapshot.primary_state && nowMs - deadline.started_at_ms > deadline.duration_ms);
  if (expired.length === 0) {
    return guard("DeadlineGuard", "pass", "No active deadline is expired for the current state.", false, undefined, event.deadline_ref === undefined ? [] : [event.deadline_ref]);
  }
  const target = expired[0]?.timeout_target ?? "SafeHold";
  const ok = event.event_type === "ModelTimeout" || event.event_type === "ControllerTimeout" || proposedTimeoutEvent(event);
  return guard("DeadlineGuard", ok ? "warning" : "fail", ok ? "Expired deadline is being handled by timeout event." : "State deadline expired before transition event.", !ok, target, expired.map((deadline) => deadline.deadline_ref));
}

function contractCompatibilityGuard(snapshot: RuntimeStateSnapshot, event: OrchestrationEventEnvelope, proposedState: PrimaryState | undefined): StateGuardDecision {
  if (proposedState === undefined || !CONTRACT_GATED_STATES.includes(proposedState)) {
    return guard("ContractCompatibilityGuard", "not_applicable", "Target state does not require prompt contract compatibility.", false, undefined, event.payload_refs);
  }
  const hasContract = event.contract_ref !== undefined || event.payload_refs.some((ref) => /PROMPT-|Response|Contract|contract/i.test(ref));
  const ok = hasContract || snapshot.primary_state === "SafeHold";
  return guard("ContractCompatibilityGuard", ok ? "pass" : "fail", ok ? "Contract-compatible reference is available for target state." : "Target state requires prompt or response contract reference.", !ok, "PlanRepair", event.contract_ref === undefined ? event.payload_refs : [event.contract_ref, ...event.payload_refs]);
}

function observationCurrencyGuard(snapshot: RuntimeStateSnapshot, proposedState: PrimaryState | undefined, policy: GuardPolicy): StateGuardDecision {
  if (proposedState === undefined || !OBSERVATION_GATED_STATES.includes(proposedState)) {
    return guard("ObservationCurrencyGuard", "not_applicable", "Target state does not require current observation.", false, undefined, []);
  }
  const maxAge = policy.current_observation_max_age_ms ?? 5000;
  const age = policy.active_observation_age_ms ?? 0;
  const hasObservation = snapshot.latest_observation_ref !== undefined || proposedState === "Plan" || proposedState === "Reobserve";
  const ok = hasObservation && age <= maxAge;
  return guard("ObservationCurrencyGuard", ok ? "pass" : "fail", ok ? "Observation context is fresh enough for target state." : "Observation is missing or stale for target state.", !ok, "Reobserve", snapshot.latest_observation_ref === undefined ? [] : [snapshot.latest_observation_ref]);
}

function commandOwnershipGuard(snapshot: RuntimeStateSnapshot, event: OrchestrationEventEnvelope, proposedState: PrimaryState | undefined): StateGuardDecision {
  if (proposedState !== "Execute") {
    return guard("CommandOwnershipGuard", "not_applicable", "Target state does not request actuator ownership.", false, undefined, event.payload_refs);
  }
  const noOwner = snapshot.command_owner_state === undefined || snapshot.command_owner_state === "Execute" || snapshot.command_owner_state === "SafeHold";
  const primitiveKnown = event.primitive_ref !== undefined || snapshot.active_primitive_ref !== undefined;
  const validationOk = event.validation_approved === true;
  const ok = noOwner && primitiveKnown && validationOk;
  return guard("CommandOwnershipGuard", ok ? "pass" : "fail", ok ? "Execute can own the approved primitive." : "Execute requires exclusive owner, approved validation, and known primitive.", !ok, "SafeHold", uniqueRefs([event.primitive_ref, snapshot.active_primitive_ref, ...event.payload_refs]));
}

function resolveTargetState(
  from: PrimaryState,
  event: OrchestrationEventEnvelope,
  rules: readonly TransitionRule[],
  policy: GuardPolicy,
): PrimaryState | undefined {
  if (event.target_state_hint !== undefined && isExplicitResumeOrSafety(event)) {
    return event.target_state_hint === "Execute" ? "Observe" : event.target_state_hint;
  }
  if (event.event_type === "PlanApproved") {
    return event.monologue_required === true && !policy.allow_monologue_skip ? "Monologue" : "Execute";
  }
  if (event.event_type === "MemoryWritten") {
    return event.target_state_hint ?? "Complete";
  }
  if (event.event_type === "NoSafeToolCandidate") {
    return event.target_state_hint === "Plan" && policy.allow_tool_reposition_plan === true ? "Plan" : "SafeHold";
  }
  const exact = rules.find((rule) => (rule.from === from || rule.from === "Any") && rule.event_type === event.event_type);
  return exact?.to;
}

function buildTransitionRecord(
  snapshot: RuntimeStateSnapshot,
  event: OrchestrationEventEnvelope,
  toState: PrimaryState,
  guards: readonly StateGuardDecision[],
  consumedBudget?: RetryBudgetName,
): StateTransitionRecord {
  const safetyAfter = event.safety_mode_override ?? safetyModeAfter(snapshot.safety_mode, toState, event);
  const payloadRefs = uniqueRefs([
    ...event.payload_refs,
    event.context_ref,
    event.contract_ref,
    event.observation_ref,
    event.plan_ref,
    event.primitive_ref,
    event.verification_ref,
    consumedBudget,
  ]);
  const base = {
    schema_version: ORCHESTRATION_STATE_MACHINE_SCHEMA_VERSION,
    from_state: snapshot.primary_state,
    to_state: toState,
    trigger_event: event.event_type,
    guard_results: freezeArray(guards),
    payload_refs: payloadRefs,
    safety_mode_before: snapshot.safety_mode,
    safety_mode_after: safetyAfter,
    human_visible_summary: sanitizeSummary(event.human_summary),
    timestamp_ref: makeRef("timestamp", String(event.occurred_at_ms)),
  };
  return Object.freeze({
    ...base,
    transition_ref: makeRef("transition", snapshot.session_ref, snapshot.primary_state, toState, event.event_ref),
    determinism_hash: computeDeterminismHash(base),
  });
}

function consumeBudgetIfNeeded(snapshot: RuntimeStateSnapshot, event: OrchestrationEventEnvelope, proposedState: PrimaryState): RetryBudgetState | undefined {
  const budgetName = event.consumes_retry_budget ?? retryBudgetForTransition(event, proposedState);
  if (budgetName === undefined) {
    return undefined;
  }
  const budget = snapshot.retry_budget_state.find((item) => item.budget_name === budgetName);
  if (budget === undefined || budget.remaining_attempts <= 0) {
    return undefined;
  }
  return Object.freeze({
    ...budget,
    remaining_attempts: budget.remaining_attempts - 1,
    last_attempt_reason: sanitizeSummary(event.human_summary),
    last_failure_reason: event.severity === "error" || event.severity === "critical" ? sanitizeSummary(event.human_summary) : budget.last_failure_reason,
    requires_strategy_change: budget.remaining_attempts - 1 <= 0 ? true : budget.requires_strategy_change,
  });
}

function retryBudgetForTransition(event: OrchestrationEventEnvelope, proposedState: PrimaryState | undefined): RetryBudgetName | undefined {
  if (event.event_type === "ResponseRepairRequired" || proposedState === "PlanRepair") {
    return "PromptRepairBudget";
  }
  if (event.event_type === "PlanRejected" && proposedState === "Plan") {
    return "PlanningRetryBudget";
  }
  if (proposedState === "Reobserve") {
    return "ReobserveBudget";
  }
  if (event.event_type === "VerificationFailure" || proposedState === "Correct") {
    return "CorrectionRetryBudget";
  }
  if (proposedState === "ToolAssess") {
    return "ToolUseRetryBudget";
  }
  if (event.event_type === "VerificationAmbiguous") {
    return "VerificationRetryBudget";
  }
  if (proposedState === "AudioAttend") {
    return "AudioAttentionBudget";
  }
  return undefined;
}

function defaultRetryBudgets(taskRef: Ref): readonly RetryBudgetState[] {
  return freezeArray([
    budget("PromptRepairBudget", taskRef, 1, "SafeHold"),
    budget("PlanningRetryBudget", taskRef, 2, "HumanReview"),
    budget("ReobserveBudget", taskRef, 2, "HumanReview"),
    budget("CorrectionRetryBudget", taskRef, 2, "HumanReview"),
    budget("ToolUseRetryBudget", taskRef, 1, "HumanReview"),
    budget("VerificationRetryBudget", taskRef, 2, "HumanReview"),
    budget("AudioAttentionBudget", taskRef, 2, "SafeHold"),
  ]);
}

function budget(name: RetryBudgetName, scopeRef: Ref, attempts: number, exhaustion: RetryBudgetState["exhaustion_transition"]): RetryBudgetState {
  return Object.freeze({
    budget_name: name,
    scope_ref: scopeRef,
    remaining_attempts: attempts,
    requires_strategy_change: false,
    exhaustion_transition: exhaustion,
  });
}

function makeSnapshot(input: Omit<RuntimeStateSnapshot, "schema_version" | "determinism_hash">): RuntimeStateSnapshot {
  const base = {
    schema_version: ORCHESTRATION_STATE_MACHINE_SCHEMA_VERSION,
    ...input,
    retry_budget_state: freezeArray(input.retry_budget_state),
    deadline_state: freezeArray(input.deadline_state),
    memory_context_refs: freezeArray(input.memory_context_refs),
    audit_refs: freezeArray(input.audit_refs),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function makeDecision(
  snapshot: RuntimeStateSnapshot,
  event: OrchestrationEventEnvelope,
  decision: TransitionDecisionKind,
  proposedState: PrimaryState | undefined,
  transitionRecord: StateTransitionRecord | undefined,
  consumedBudget: RetryBudgetState | undefined,
  guards: readonly StateGuardDecision[],
  issues: readonly ValidationIssue[],
): StateTransitionDecision {
  const base = {
    schema_version: ORCHESTRATION_STATE_MACHINE_SCHEMA_VERSION,
    decision,
    event_ref: event.event_ref,
    from_snapshot_ref: snapshot.current_context_ref,
    proposed_to_state: proposedState,
    transition_record: transitionRecord,
    consumed_retry_budget: consumedBudget,
    guard_results: freezeArray(guards),
    issues: freezeArray(issues),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function snapshotBase(snapshot: RuntimeStateSnapshot): Omit<RuntimeStateSnapshot, "schema_version" | "determinism_hash"> {
  return {
    session_ref: snapshot.session_ref,
    task_ref: snapshot.task_ref,
    primary_state: snapshot.primary_state,
    substate: snapshot.substate,
    safety_mode: snapshot.safety_mode,
    embodiment_ref: snapshot.embodiment_ref,
    active_plan_ref: snapshot.active_plan_ref,
    active_primitive_ref: snapshot.active_primitive_ref,
    latest_observation_ref: snapshot.latest_observation_ref,
    latest_verification_ref: snapshot.latest_verification_ref,
    retry_budget_state: snapshot.retry_budget_state,
    deadline_state: snapshot.deadline_state,
    memory_context_refs: snapshot.memory_context_refs,
    audit_refs: snapshot.audit_refs,
    current_context_ref: snapshot.current_context_ref,
    command_owner_state: snapshot.command_owner_state,
    updated_at_ms: snapshot.updated_at_ms,
  };
}

function validateSnapshot(snapshot: RuntimeStateSnapshot, issues: ValidationIssue[]): void {
  validateRef(snapshot.session_ref, "$.snapshot.session_ref", issues);
  validateRef(snapshot.task_ref, "$.snapshot.task_ref", issues);
  validateRef(snapshot.embodiment_ref, "$.snapshot.embodiment_ref", issues);
  validateRef(snapshot.current_context_ref, "$.snapshot.current_context_ref", issues);
  if (snapshot.schema_version !== ORCHESTRATION_STATE_MACHINE_SCHEMA_VERSION) {
    issues.push(issue("error", "StateSnapshotVersionMismatch", "$.snapshot.schema_version", "Runtime snapshot schema version does not match the state machine.", `Use ${ORCHESTRATION_STATE_MACHINE_SCHEMA_VERSION}.`));
  }
}

function validateEvent(event: OrchestrationEventEnvelope, snapshot: RuntimeStateSnapshot, issues: ValidationIssue[]): void {
  validateRef(event.event_ref, "$.event.event_ref", issues);
  validateRef(event.session_ref, "$.event.session_ref", issues);
  validateRef(event.task_ref, "$.event.task_ref", issues);
  if (event.session_ref !== snapshot.session_ref || event.task_ref !== snapshot.task_ref) {
    issues.push(issue("error", "EventSessionTaskMismatch", "$.event", "Event session or task does not match the current runtime snapshot.", "Reject stale or cross-session events."));
  }
  if (FORBIDDEN_STATE_PAYLOAD_PATTERN.test(event.human_summary)) {
    issues.push(issue("error", "EventSummaryContainsForbiddenContent", "$.event.human_summary", "Event summary contains hidden-truth or restricted control wording.", "Use a prompt-safe human-visible summary."));
  }
}

function validateRef(ref: Ref, path: string, issues: ValidationIssue[]): void {
  if (ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(issue("error", "ReferenceInvalid", path, "Reference must be non-empty and whitespace-free.", "Use a stable opaque reference."));
  }
  if (FORBIDDEN_STATE_PAYLOAD_PATTERN.test(ref)) {
    issues.push(issue("error", "ReferenceContainsForbiddenContent", path, "Reference contains forbidden orchestration-boundary terminology.", "Use prompt-safe opaque references."));
  }
}

function issue(severity: ValidationSeverity, code: string, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function guard(
  name: string,
  decision: GuardDecision,
  reason: string,
  blocking: boolean,
  recoveryHint: StateGuardDecision["recovery_hint"],
  evidenceRefs: readonly Ref[],
): StateGuardDecision {
  return Object.freeze({
    guard_name: name,
    decision,
    reason,
    blocking,
    recovery_hint: recoveryHint,
    evidence_refs: freezeArray(evidenceRefs),
  });
}

function replaceRetryBudget(budgets: readonly RetryBudgetState[], updated: RetryBudgetState): readonly RetryBudgetState[] {
  return freezeArray(budgets.map((budgetItem) => budgetItem.budget_name === updated.budget_name ? updated : budgetItem));
}

function refreshDeadlinesForState(deadlines: readonly DeadlineStateEntry[], state: PrimaryState, record: StateTransitionRecord): readonly DeadlineStateEntry[] {
  const retained = deadlines.filter((deadline) => !deadline.expired && deadline.owner_state === state);
  const defaultDeadline = defaultDeadlineForState(state, record.timestamp_ref);
  return freezeArray(defaultDeadline === undefined ? retained : [...retained, defaultDeadline]);
}

function defaultDeadlineForState(state: PrimaryState, timestampRef: Ref): DeadlineStateEntry | undefined {
  const startedAt = timestampMsFromRef(timestampRef, 0);
  const config = DEFAULT_DEADLINE_BY_STATE[state];
  if (config === undefined) {
    return undefined;
  }
  return Object.freeze({
    deadline_ref: makeRef("deadline", state, timestampRef),
    deadline_class: config.deadlineClass,
    owner_state: state,
    started_at_ms: startedAt,
    duration_ms: config.durationMs,
    timeout_target: config.timeoutTarget,
    elapsed_ms: 0,
    expired: false,
  });
}

function substateFor(state: PrimaryState, trigger: OrchestrationEventType): string {
  return sanitizeSummary(`${state} entered after ${trigger}.`);
}

function nextActivePlanRef(snapshot: RuntimeStateSnapshot, state: PrimaryState, record: StateTransitionRecord): Ref | undefined {
  if (state === "Plan" || state === "Validate" || state === "Monologue" || state === "Execute") {
    return firstMatchingRef(record.payload_refs, /plan|response|handoff|validation/i) ?? snapshot.active_plan_ref;
  }
  if (state === "Complete" || state === "Abort") {
    return undefined;
  }
  return snapshot.active_plan_ref;
}

function nextActivePrimitiveRef(snapshot: RuntimeStateSnapshot, state: PrimaryState, record: StateTransitionRecord): Ref | undefined {
  if (state === "Execute") {
    return firstMatchingRef(record.payload_refs, /primitive|motion|controller/i) ?? snapshot.active_primitive_ref;
  }
  if (state === "Verify" || state === "Correct" || state === "SafeHold" || state === "Abort" || state === "Complete") {
    return undefined;
  }
  return snapshot.active_primitive_ref;
}

function nextObservationRef(snapshot: RuntimeStateSnapshot, record: StateTransitionRecord): Ref | undefined {
  return firstMatchingRef(record.payload_refs, /observation|sensor|view|evidence/i) ?? snapshot.latest_observation_ref;
}

function nextVerificationRef(snapshot: RuntimeStateSnapshot, record: StateTransitionRecord): Ref | undefined {
  return firstMatchingRef(record.payload_refs, /verification|certificate|residual/i) ?? snapshot.latest_verification_ref;
}

function firstMatchingRef(refs: readonly Ref[], pattern: RegExp): Ref | undefined {
  return refs.find((ref) => pattern.test(ref));
}

function commandOwnerFor(state: PrimaryState): PrimaryState | undefined {
  if (state === "Execute" || state === "SafeHold") {
    return state;
  }
  return undefined;
}

function safetyModeAfter(before: SafetyMode, state: PrimaryState, event: OrchestrationEventEnvelope): SafetyMode {
  if (event.event_type === "AbortCommanded" || state === "Abort") {
    return "AbortRequired";
  }
  if (state === "SafeHold") {
    return "SafeHoldRequired";
  }
  if (state === "HumanReview") {
    return before === "AbortRequired" ? "AbortRequired" : "Blocked";
  }
  if (event.severity === "warning") {
    return "Caution";
  }
  if (state === "Observe" && before === "SafeHoldRequired") {
    return "Normal";
  }
  return before === "Blocked" && (state === "Plan" || state === "Reobserve") ? "Caution" : "Normal";
}

function timestampMsFromRef(timestampRef: Ref, fallback: number): number {
  const match = timestampRef.match(/(\d+)$/);
  if (match === null) {
    return fallback;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sanitizeSummary(summary: string): string {
  const compact = summary.replace(/\s+/g, " ").trim();
  return FORBIDDEN_STATE_PAYLOAD_PATTERN.test(compact)
    ? compact.replace(FORBIDDEN_STATE_PAYLOAD_PATTERN, "[redacted_orchestration_content]").slice(0, 800)
    : compact.slice(0, 800);
}

function contextRequiredFor(event: OrchestrationEventEnvelope): boolean {
  return event.event_family === "cognitive"
    || event.event_family === "validation"
    || event.event_family === "monologue"
    || event.event_family === "verification"
    || event.event_type === "ModelResponseReceived"
    || event.event_type === "PlanApproved";
}

function proposedTimeoutEvent(event: OrchestrationEventEnvelope): boolean {
  return event.event_type === "ModelTimeout" || event.event_type === "ControllerTimeout" || event.event_type === "SensorHealthDegraded";
}

function isExplicitResumeOrSafety(event: OrchestrationEventEnvelope): boolean {
  return event.event_type === "OperatorResume"
    || event.event_type === "OperatorAbort"
    || event.event_type === "SafeHoldCommanded"
    || event.event_type === "AbortCommanded";
}

function exhaustionTarget(budget: RetryBudgetState | undefined): StateGuardDecision["recovery_hint"] {
  if (budget === undefined) {
    return "HumanReview";
  }
  return budget.exhaustion_transition === "FailureCertificate" ? "HumanReview" : budget.exhaustion_transition;
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

const TERMINAL_STATES: readonly PrimaryState[] = freezeArray(["Abort"]);
const COGNITIVE_FACING_STATES: readonly PrimaryState[] = freezeArray(["Plan", "PlanRepair", "Correct", "ToolAssess", "AudioAttend", "Monologue", "MemoryUpdate"]);
const CONTRACT_GATED_STATES: readonly PrimaryState[] = freezeArray(["Plan", "PlanRepair", "Validate", "Correct", "ToolAssess", "AudioAttend", "Monologue"]);
const OBSERVATION_GATED_STATES: readonly PrimaryState[] = freezeArray(["Plan", "Validate", "Verify", "Execute"]);

const DEFAULT_TRANSITION_RULES: readonly TransitionRule[] = freezeArray([
  { from: "Initialize", event_type: "TaskReceived", to: "Observe", note: "Starts embodied evidence collection." },
  { from: "Observe", event_type: "ObservationReady", to: "Plan", note: "Default path for new task or phase." },
  { from: "Observe", event_type: "VerificationRequested", to: "Verify", note: "Post-execution verification path." },
  { from: "Reobserve", event_type: "ObservationReady", to: "Plan", note: "Resolved ambiguity enough to plan." },
  { from: "Plan", event_type: "ModelResponseReceived", to: "Validate", note: "Response remains non-executing." },
  { from: "Plan", event_type: "ResponseRepairRequired", to: "PlanRepair", note: "Schema repair path.", budget: "PromptRepairBudget" },
  { from: "PlanRepair", event_type: "ModelResponseReceived", to: "Validate", note: "Validate repaired response." },
  { from: "Validate", event_type: "PlanApproved", to: "Execute", note: "Direct execution when monologue is optional." },
  { from: "Monologue", event_type: "SpeechCompleted", to: "Execute", note: "Execute after speech and recheck." },
  { from: "Monologue", event_type: "SpeechFailed", to: "Execute", note: "Speech degradation logged when non-critical." },
  { from: "Execute", event_type: "PrimitiveCompleted", to: "Verify", note: "Verification decides outcome." },
  { from: "Verify", event_type: "VerificationSuccess", to: "MemoryUpdate", note: "Memory may be required before completion." },
  { from: "MemoryUpdate", event_type: "MemoryWritten", to: "Complete", note: "Task phase complete." },
  { from: "Complete", event_type: "TaskReceived", to: "Observe", note: "Accept next task." },
  { from: "Observe", event_type: "ObservationAmbiguous", to: "Reobserve", note: "Targeted view acquisition.", budget: "ReobserveBudget" },
  { from: "Plan", event_type: "ModelTimeout", to: "SafeHold", note: "No motion without plan." },
  { from: "Plan", event_type: "ResponseRejected", to: "Reobserve", note: "Gather missing evidence." },
  { from: "PlanRepair", event_type: "ResponseRejected", to: "SafeHold", note: "Repair budget exhausted." },
  { from: "Validate", event_type: "PlanRejected", to: "Plan", note: "Validator feedback replanning.", budget: "PlanningRetryBudget" },
  { from: "Verify", event_type: "VerificationAmbiguous", to: "Reobserve", note: "Avoid false success.", budget: "VerificationRetryBudget" },
  { from: "Verify", event_type: "VerificationFailure", to: "Correct", note: "Oops Loop path.", budget: "CorrectionRetryBudget" },
  { from: "Any", event_type: "SafeHoldCommanded", to: "SafeHold", note: "Safety fallback." },
  { from: "Any", event_type: "AbortCommanded", to: "Abort", note: "Terminal abort." },
  { from: "Execute", event_type: "SlipDetected", to: "Correct", note: "Recoverable anomaly.", budget: "CorrectionRetryBudget" },
  { from: "Execute", event_type: "DropDetected", to: "Correct", note: "Recoverable anomaly.", budget: "CorrectionRetryBudget" },
  { from: "Execute", event_type: "CollisionDetected", to: "Correct", note: "Recoverable anomaly.", budget: "CorrectionRetryBudget" },
  { from: "Execute", event_type: "OvershootDetected", to: "Correct", note: "Recoverable anomaly.", budget: "CorrectionRetryBudget" },
  { from: "Execute", event_type: "OscillationDetected", to: "Correct", note: "Recoverable anomaly.", budget: "CorrectionRetryBudget" },
  { from: "Execute", event_type: "ForceLimitExceeded", to: "SafeHold", note: "Safety threshold exceeded." },
  { from: "Execute", event_type: "SpeedLimitExceeded", to: "SafeHold", note: "Safety threshold exceeded." },
  { from: "Correct", event_type: "RetryBudgetExhausted", to: "HumanReview", note: "Prevent runaway correction." },
  { from: "SafeHold", event_type: "OperatorResume", to: "Observe", note: "Fresh observation after pause." },
  { from: "SafeHold", event_type: "OperatorAbort", to: "Abort", note: "Operator terminal abort." },
  { from: "HumanReview", event_type: "OperatorClarification", to: "Plan", note: "Safe clarification replanning." },
  { from: "Observe", event_type: "AudioEventDetected", to: "AudioAttend", note: "Audio becomes embodied evidence.", budget: "AudioAttentionBudget" },
  { from: "Execute", event_type: "ImpactSoundDetected", to: "Correct", note: "Treat impact as failure evidence.", budget: "CorrectionRetryBudget" },
  { from: "AudioAttend", event_type: "AudioAmbiguous", to: "Reobserve", note: "Visual confirmation needed.", budget: "ReobserveBudget" },
  { from: "AudioAttend", event_type: "AudioActionApproved", to: "Execute", note: "Approved orientation primitive only." },
  { from: "Validate", event_type: "ReachLimitationDetected", to: "ToolAssess", note: "Tool path.", budget: "ToolUseRetryBudget" },
  { from: "ToolAssess", event_type: "ToolPlanCandidateReady", to: "Validate", note: "Tool handoff validation." },
  { from: "ToolAssess", event_type: "NoSafeToolCandidate", to: "SafeHold", note: "Unsafe tool fallback." },
]);

const DEFAULT_DEADLINE_BY_STATE: Partial<Record<PrimaryState, { readonly deadlineClass: DeadlineClass; readonly durationMs: number; readonly timeoutTarget: PrimaryState }>> = Object.freeze({
  Observe: { deadlineClass: "SensorFrameDeadline", durationMs: 2000, timeoutTarget: "Reobserve" },
  Reobserve: { deadlineClass: "SensorFrameDeadline", durationMs: 2500, timeoutTarget: "SafeHold" },
  Plan: { deadlineClass: "RoutinePlanningDeadline", durationMs: 5000, timeoutTarget: "SafeHold" },
  PlanRepair: { deadlineClass: "RepairDeadline", durationMs: 3000, timeoutTarget: "SafeHold" },
  Monologue: { deadlineClass: "MonologueStartDeadline", durationMs: 1000, timeoutTarget: "Execute" },
  Execute: { deadlineClass: "PrimitiveExecutionDeadline", durationMs: 30000, timeoutTarget: "Correct" },
  Verify: { deadlineClass: "VerificationDeadline", durationMs: 5000, timeoutTarget: "Reobserve" },
  Correct: { deadlineClass: "CorrectionPlanningDeadline", durationMs: 10000, timeoutTarget: "SafeHold" },
});

export const ORCHESTRATION_STATE_MACHINE_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: ORCHESTRATION_STATE_MACHINE_SCHEMA_VERSION,
  blueprint: "architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md",
  sections: freezeArray(["8.3", "8.4", "8.5", "8.6", "8.7", "8.8", "8.10", "8.11", "8.12", "8.14", "8.15", "8.16", "8.17", "8.18"]),
  traceability_ref: CONTRACT_TRACEABILITY_REF,
  default_clock_ref: DEFAULT_CLOCK_REF,
});
