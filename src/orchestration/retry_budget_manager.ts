/**
 * Retry budget manager for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md`
 * sections 8.3, 8.11, 8.13, 8.14, 8.16, 8.17, and 8.18.
 *
 * This module implements the executable `RetryBudgetManager`. It creates
 * finite retry budgets, evaluates retry eligibility, consumes attempts with
 * deterministic audit events, enforces strategy-change discipline, and emits
 * terminal exhaustion events for repair, planning, reobserve, correction,
 * tool-use, verification, and audio-attention loops. It does not commit state
 * transitions; the `OrchestrationStateMachine` remains the transition authority.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import type {
  EventSeverity,
  OrchestrationEventEnvelope,
  OrchestrationEventType,
  PrimaryState,
  RetryBudgetName,
  RetryBudgetState,
  RuntimeStateSnapshot,
} from "./orchestration_state_machine";

export const RETRY_BUDGET_MANAGER_SCHEMA_VERSION = "mebsuta.retry_budget_manager.v1" as const;
export const RETRY_BUDGET_MANAGER_VERSION = "1.0.0" as const;

const CONTRACT_TRACEABILITY_REF = "architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md#RetryBudgetManager" as const;
const FORBIDDEN_RETRY_TEXT_PATTERN = /(retry forever|infinite|unbounded|ignore budget|ignore safety|same failed strategy|same exact view|without new evidence|skip validation|override safety|gemini_direct|direct actuator|reinforcement learning|reward policy|policy gradient|backend|engine|scene_graph|world_truth|ground_truth|qa_|hidden state)/i;

export type RetryBudgetDecisionKind = "retry_allowed" | "retry_allowed_last_attempt" | "strategy_change_required" | "budget_exhausted" | "blocked";
export type RetryBudgetScopeKind = "task" | "phase" | "prompt" | "object" | "failure_class" | "tool" | "constraint" | "audio_event";
export type RetryBudgetAttemptKind =
  | "schema_repair"
  | "validator_feedback_replan"
  | "targeted_reobserve"
  | "oops_correction"
  | "tool_assessment"
  | "verification_disambiguation"
  | "audio_attention";
export type RetryStrategyChangeKind =
  | "new_evidence"
  | "different_view"
  | "different_approach"
  | "lower_speed"
  | "different_end_effector"
  | "tool_added"
  | "tool_abandoned"
  | "reposition"
  | "reduced_force"
  | "human_clarification"
  | "schema_restatement"
  | "none";

export interface RetryBudgetPolicy {
  readonly budget_name: RetryBudgetName;
  readonly scope_kind: RetryBudgetScopeKind;
  readonly default_attempts: number;
  readonly maximum_attempts: number;
  readonly exhaustion_transition: RetryBudgetState["exhaustion_transition"];
  readonly attempt_kind: RetryBudgetAttemptKind;
  readonly strategy_change_after_attempts: number;
  readonly allowed_owner_states: readonly PrimaryState[];
  readonly terminal_event_type: OrchestrationEventType;
  readonly dashboard_label: string;
}

export interface RetryBudgetInitializationRequest {
  readonly scope_ref: Ref;
  readonly task_ref?: Ref;
  readonly overrides?: Partial<Record<RetryBudgetName, number>>;
  readonly exhaustion_overrides?: Partial<Record<RetryBudgetName, RetryBudgetState["exhaustion_transition"]>>;
}

export interface RetryStrategyDescriptor {
  readonly strategy_ref: Ref;
  readonly attempt_kind: RetryBudgetAttemptKind;
  readonly summary: string;
  readonly evidence_refs: readonly Ref[];
  readonly changed_aspects: readonly RetryStrategyChangeKind[];
  readonly target_ref?: Ref;
  readonly plan_ref?: Ref;
  readonly tool_ref?: Ref;
  readonly observation_ref?: Ref;
}

export interface RetryBudgetConsumeRequest {
  readonly budget_name: RetryBudgetName;
  readonly scope_ref: Ref;
  readonly owner_state: PrimaryState;
  readonly attempt_reason: string;
  readonly failure_reason?: string;
  readonly strategy: RetryStrategyDescriptor;
  readonly budgets?: readonly RetryBudgetState[];
  readonly snapshot?: RuntimeStateSnapshot;
  readonly previous_strategy_ref?: Ref;
  readonly occurred_at_ms: number;
  readonly safety_risk?: "normal" | "elevated" | "critical";
}

export interface RetryBudgetGuardRequest {
  readonly budget_name: RetryBudgetName;
  readonly scope_ref: Ref;
  readonly owner_state: PrimaryState;
  readonly budgets?: readonly RetryBudgetState[];
  readonly snapshot?: RuntimeStateSnapshot;
  readonly strategy?: RetryStrategyDescriptor;
  readonly previous_strategy_ref?: Ref;
}

export interface RetryBudgetDecision {
  readonly schema_version: typeof RETRY_BUDGET_MANAGER_SCHEMA_VERSION;
  readonly budget_name: RetryBudgetName;
  readonly scope_ref: Ref;
  readonly decision: RetryBudgetDecisionKind;
  readonly before_budget?: RetryBudgetState;
  readonly after_budget?: RetryBudgetState;
  readonly policy: RetryBudgetPolicy;
  readonly consumed: boolean;
  readonly exhaustion_transition?: RetryBudgetState["exhaustion_transition"];
  readonly recommended_target?: PrimaryState;
  readonly event: OrchestrationEventEnvelope;
  readonly issue_count: number;
  readonly error_count: number;
  readonly warning_count: number;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface RetryBudgetGuardReport {
  readonly schema_version: typeof RETRY_BUDGET_MANAGER_SCHEMA_VERSION;
  readonly budget_name: RetryBudgetName;
  readonly scope_ref: Ref;
  readonly owner_state: PrimaryState;
  readonly allowed: boolean;
  readonly reason: string;
  readonly remaining_attempts: number;
  readonly requires_strategy_change: boolean;
  readonly exhaustion_transition: RetryBudgetState["exhaustion_transition"];
  readonly recommended_target?: PrimaryState;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface RetryBudgetSweepReport {
  readonly schema_version: typeof RETRY_BUDGET_MANAGER_SCHEMA_VERSION;
  readonly scope_ref: Ref;
  readonly budgets: readonly RetryBudgetState[];
  readonly exhausted_budgets: readonly RetryBudgetState[];
  readonly low_budgets: readonly RetryBudgetState[];
  readonly dashboard_summary: readonly RetryBudgetDashboardEntry[];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface RetryBudgetDashboardEntry {
  readonly budget_name: RetryBudgetName;
  readonly scope_ref: Ref;
  readonly remaining_attempts: number;
  readonly maximum_attempts: number;
  readonly requires_strategy_change: boolean;
  readonly exhaustion_transition: RetryBudgetState["exhaustion_transition"];
  readonly label: string;
}

/**
 * Deterministic finite-budget authority for all retry loops in File 08.
 */
export class RetryBudgetManager {
  private readonly policies: Readonly<Record<RetryBudgetName, RetryBudgetPolicy>>;

  public constructor(policies: readonly RetryBudgetPolicy[] = DEFAULT_RETRY_BUDGET_POLICIES) {
    this.policies = indexPolicies(policies);
  }

  /**
   * Creates the initial retry budget set for a task, phase, prompt, failure
   * class, tool path, verification constraint, or audio-event scope.
   */
  public initializeRetryBudgets(request: RetryBudgetInitializationRequest): readonly RetryBudgetState[] {
    validateRefOrThrow(request.scope_ref, "$.scope_ref");
    return freezeArray(ALL_RETRY_BUDGETS.map((budgetName) => {
      const policy = this.policies[budgetName];
      const override = request.overrides?.[budgetName];
      const attempts = override === undefined ? policy.default_attempts : boundedAttempts(override, policy);
      const base = {
        budget_name: budgetName,
        scope_ref: request.scope_ref,
        remaining_attempts: attempts,
        requires_strategy_change: false,
        exhaustion_transition: request.exhaustion_overrides?.[budgetName] ?? policy.exhaustion_transition,
      };
      return Object.freeze(base);
    }));
  }

  /**
   * Evaluates whether a retry may start without consuming an attempt. This is
   * the executable RetryBudgetGuard used by transition and state-entry code.
   */
  public evaluateRetryBudgetGuard(request: RetryBudgetGuardRequest): RetryBudgetGuardReport {
    const issues = validateGuardRequest(request);
    const policy = this.policies[request.budget_name];
    const budget = resolveBudget(request.budgets ?? request.snapshot?.retry_budget_state ?? [], request.budget_name, request.scope_ref);
    const strategyOk = request.strategy === undefined || request.previous_strategy_ref === undefined || strategyChanged(request.strategy, request.previous_strategy_ref);
    const allowedState = policy.allowed_owner_states.includes(request.owner_state);
    if (budget === undefined) {
      issues.push(issue("error", "RetryBudgetMissing", "$.budget", "Retry budget is missing for the requested scope.", "Initialize scoped retry budgets before entering the retry loop."));
    }
    if (!allowedState) {
      issues.push(issue("error", "RetryBudgetStateInvalid", "$.owner_state", `Budget ${request.budget_name} cannot be consumed from ${request.owner_state}.`, "Use the File 08 state path for this retry category."));
    }
    if (budget !== undefined && budget.requires_strategy_change && !strategyOk) {
      issues.push(issue("error", "RetryStrategyUnchanged", "$.strategy", "Retry requires changed evidence, approach, tool, plan, or schema framing.", "Change strategy before consuming another retry attempt."));
    }
    const remaining = budget?.remaining_attempts ?? 0;
    const exhausted = remaining <= 0;
    if (exhausted) {
      issues.push(issue("error", "RetryBudgetExhausted", "$.budget.remaining_attempts", "Retry budget has no attempts remaining.", "Route to the configured exhaustion transition."));
    }
    const allowed = issues.every((item) => item.severity !== "error");
    const target = allowed ? undefined : primaryTargetFor(budget?.exhaustion_transition ?? policy.exhaustion_transition);
    const base = {
      schema_version: RETRY_BUDGET_MANAGER_SCHEMA_VERSION,
      budget_name: request.budget_name,
      scope_ref: request.scope_ref,
      owner_state: request.owner_state,
      allowed,
      reason: allowed ? "Retry budget has remaining attempts and strategy discipline is satisfied." : issues.filter((item) => item.severity === "error").map((item) => item.message).join(" "),
      remaining_attempts: remaining,
      requires_strategy_change: budget?.requires_strategy_change ?? false,
      exhaustion_transition: budget?.exhaustion_transition ?? policy.exhaustion_transition,
      recommended_target: target,
      issues: freezeArray(issues),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Consumes one retry attempt and returns the updated immutable budget plus an
   * orchestration audit event. Exhausted or invalid requests produce a terminal
   * event without mutating the budget.
   */
  public consumeRetryBudget(request: RetryBudgetConsumeRequest): RetryBudgetDecision {
    const policy = this.policies[request.budget_name];
    const issues = validateConsumeRequest(request, policy);
    const budgets = request.budgets ?? request.snapshot?.retry_budget_state ?? [];
    const before = resolveBudget(budgets, request.budget_name, request.scope_ref);
    if (before === undefined) {
      issues.push(issue("error", "RetryBudgetMissing", "$.budget", "Retry budget is missing for the requested scope.", "Initialize scoped retry budgets before consuming attempts."));
    }
    const guardReport = this.evaluateRetryBudgetGuard({
      budget_name: request.budget_name,
      scope_ref: request.scope_ref,
      owner_state: request.owner_state,
      budgets,
      snapshot: request.snapshot,
      strategy: request.strategy,
      previous_strategy_ref: request.previous_strategy_ref,
    });
    issues.push(...guardReport.issues.filter((guardIssue) => !issues.some((item) => item.code === guardIssue.code && item.path === guardIssue.path)));

    const canConsume = before !== undefined && guardReport.allowed && issues.every((item) => item.severity !== "error");
    const after = canConsume ? consumeBudget(before, request, policy) : before;
    const decision = chooseDecision(canConsume, before, after, request, policy, issues);
    const target = decision === "budget_exhausted" || decision === "blocked" || decision === "strategy_change_required"
      ? primaryTargetFor(before?.exhaustion_transition ?? policy.exhaustion_transition)
      : undefined;
    const event = makeRetryEvent(request, policy, decision, before, after, target, issues);
    const base = {
      schema_version: RETRY_BUDGET_MANAGER_SCHEMA_VERSION,
      budget_name: request.budget_name,
      scope_ref: request.scope_ref,
      decision,
      before_budget: before,
      after_budget: after,
      policy,
      consumed: canConsume,
      exhaustion_transition: before?.exhaustion_transition ?? policy.exhaustion_transition,
      recommended_target: target,
      event,
      issue_count: issues.length,
      error_count: issues.filter((item) => item.severity === "error").length,
      warning_count: issues.filter((item) => item.severity === "warning").length,
      issues: freezeArray(issues),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Replaces one budget in an immutable budget vector with the consumed result.
   * If the decision did not consume an attempt, the original vector is retained.
   */
  public applyDecisionToBudgets(budgets: readonly RetryBudgetState[], decision: RetryBudgetDecision): readonly RetryBudgetState[] {
    if (!decision.consumed || decision.after_budget === undefined) {
      return freezeArray(budgets);
    }
    const replaced = budgets.map((budget) => budget.budget_name === decision.budget_name && budget.scope_ref === decision.scope_ref ? decision.after_budget as RetryBudgetState : budget);
    const found = budgets.some((budget) => budget.budget_name === decision.budget_name && budget.scope_ref === decision.scope_ref);
    return freezeArray(found ? replaced : [...replaced, decision.after_budget]);
  }

  /**
   * Summarizes remaining attempts and exhaustion risks for dashboards and
   * operator handoff surfaces.
   */
  public summarizeBudgets(scopeRef: Ref, budgets: readonly RetryBudgetState[]): RetryBudgetSweepReport {
    const issues: ValidationIssue[] = [];
    validateRef(scopeRef, "$.scope_ref", issues);
    const scoped = budgets.filter((budget) => budget.scope_ref === scopeRef);
    const missing = ALL_RETRY_BUDGETS.filter((budgetName) => scoped.every((budget) => budget.budget_name !== budgetName));
    for (const budgetName of missing) {
      issues.push(issue("warning", "RetryBudgetMissingFromSummary", `$.budgets.${budgetName}`, `Budget ${budgetName} is absent from scope ${scopeRef}.`, "Initialize a complete budget vector for dashboard reporting."));
    }
    const exhausted = scoped.filter((budget) => budget.remaining_attempts <= 0);
    const low = scoped.filter((budget) => budget.remaining_attempts === 1);
    const dashboard = scoped
      .slice()
      .sort((a, b) => a.budget_name.localeCompare(b.budget_name))
      .map((budget) => makeDashboardEntry(budget, this.policies[budget.budget_name]));
    const base = {
      schema_version: RETRY_BUDGET_MANAGER_SCHEMA_VERSION,
      scope_ref: scopeRef,
      budgets: freezeArray(scoped),
      exhausted_budgets: freezeArray(exhausted),
      low_budgets: freezeArray(low),
      dashboard_summary: freezeArray(dashboard),
      issues: freezeArray(issues),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Returns the immutable policy table in deterministic budget order.
   */
  public getRetryBudgetPolicies(): readonly RetryBudgetPolicy[] {
    return freezeArray(ALL_RETRY_BUDGETS.map((budgetName) => this.policies[budgetName]));
  }
}

export class RetryBudgetManagerError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "RetryBudgetManagerError";
    this.issues = issues;
  }
}

function consumeBudget(before: RetryBudgetState, request: RetryBudgetConsumeRequest, policy: RetryBudgetPolicy): RetryBudgetState {
  const remaining = Math.max(0, before.remaining_attempts - 1);
  const attemptsUsed = policy.maximum_attempts - remaining;
  const requiresStrategyChange = remaining > 0 && attemptsUsed >= policy.strategy_change_after_attempts;
  return Object.freeze({
    budget_name: before.budget_name,
    scope_ref: before.scope_ref,
    remaining_attempts: remaining,
    last_attempt_reason: compactText(`${request.attempt_reason}; strategy=${request.strategy.strategy_ref}`),
    last_failure_reason: request.failure_reason === undefined ? before.last_failure_reason : compactText(request.failure_reason),
    requires_strategy_change: requiresStrategyChange,
    exhaustion_transition: before.exhaustion_transition,
  });
}

function chooseDecision(
  canConsume: boolean,
  before: RetryBudgetState | undefined,
  after: RetryBudgetState | undefined,
  request: RetryBudgetConsumeRequest,
  policy: RetryBudgetPolicy,
  issues: readonly ValidationIssue[],
): RetryBudgetDecisionKind {
  if (before !== undefined && before.requires_strategy_change && !strategyChanged(request.strategy, request.previous_strategy_ref)) {
    return "strategy_change_required";
  }
  if (before === undefined || before.remaining_attempts <= 0) {
    return "budget_exhausted";
  }
  if (!canConsume || issues.some((item) => item.severity === "error")) {
    return "blocked";
  }
  if (after !== undefined && after.remaining_attempts === 0) {
    return "retry_allowed_last_attempt";
  }
  return policy.default_attempts === 1 ? "retry_allowed_last_attempt" : "retry_allowed";
}

function makeRetryEvent(
  request: RetryBudgetConsumeRequest,
  policy: RetryBudgetPolicy,
  decision: RetryBudgetDecisionKind,
  before: RetryBudgetState | undefined,
  after: RetryBudgetState | undefined,
  target: PrimaryState | undefined,
  issues: readonly ValidationIssue[],
): OrchestrationEventEnvelope {
  const exhausted = decision === "budget_exhausted" || (after !== undefined && after.remaining_attempts <= 0 && decision !== "retry_allowed_last_attempt");
  const eventType: OrchestrationEventType = exhausted || decision === "blocked" || decision === "strategy_change_required"
    ? "RetryBudgetExhausted"
    : retryConsumedEventType(policy);
  const severity = severityFor(decision, before?.exhaustion_transition ?? policy.exhaustion_transition, request.safety_risk);
  const snapshot = request.snapshot;
  const base = {
    event_ref: makeRef("event", "retry_budget", request.budget_name, request.scope_ref, decision, request.occurred_at_ms),
    event_type: eventType,
    event_family: eventType === "RetryBudgetExhausted" ? "safety" as const : eventFamilyFor(policy),
    severity,
    session_ref: snapshot?.session_ref ?? makeRef("session", request.scope_ref),
    task_ref: snapshot?.task_ref ?? makeRef("task", request.scope_ref),
    source_state_ref: request.owner_state,
    context_ref: snapshot?.current_context_ref,
    payload_refs: uniqueRefs([
      request.scope_ref,
      request.strategy.strategy_ref,
      request.strategy.target_ref,
      request.strategy.plan_ref,
      request.strategy.tool_ref,
      request.strategy.observation_ref,
      ...(request.strategy.evidence_refs),
      snapshot?.active_plan_ref,
      snapshot?.active_primitive_ref,
      snapshot?.latest_observation_ref,
      snapshot?.latest_verification_ref,
    ]),
    provenance_classes: freezeArray(["telemetry", "validator", "safety"] as const),
    occurred_at_ms: request.occurred_at_ms,
    human_summary: eventSummary(request, decision, before, after),
    target_state_hint: target,
    consumes_retry_budget: request.budget_name,
    observation_ref: request.strategy.observation_ref ?? snapshot?.latest_observation_ref,
    plan_ref: request.strategy.plan_ref ?? snapshot?.active_plan_ref,
    primitive_ref: snapshot?.active_primitive_ref,
    verification_ref: snapshot?.latest_verification_ref,
    safety_mode_override: target === "Abort" ? "AbortRequired" as const : target === "SafeHold" ? "SafeHoldRequired" as const : undefined,
  };
  return Object.freeze(base);
}

function retryConsumedEventType(policy: RetryBudgetPolicy): OrchestrationEventType {
  switch (policy.budget_name) {
    case "PromptRepairBudget":
      return "ResponseRepairRequired";
    case "PlanningRetryBudget":
      return "PlanRejected";
    case "ReobserveBudget":
      return "ObservationAmbiguous";
    case "CorrectionRetryBudget":
      return "VerificationFailure";
    case "ToolUseRetryBudget":
      return "ReachLimitationDetected";
    case "VerificationRetryBudget":
      return "VerificationAmbiguous";
    case "AudioAttentionBudget":
      return "AudioEventDetected";
  }
}

function eventFamilyFor(policy: RetryBudgetPolicy): OrchestrationEventEnvelope["event_family"] {
  switch (policy.budget_name) {
    case "PromptRepairBudget":
    case "PlanningRetryBudget":
      return "cognitive";
    case "ReobserveBudget":
      return "sensor";
    case "CorrectionRetryBudget":
      return "anomaly";
    case "ToolUseRetryBudget":
      return "validation";
    case "VerificationRetryBudget":
      return "verification";
    case "AudioAttentionBudget":
      return "audio";
  }
}

function severityFor(
  decision: RetryBudgetDecisionKind,
  exhaustionTransition: RetryBudgetState["exhaustion_transition"],
  safetyRisk: RetryBudgetConsumeRequest["safety_risk"],
): EventSeverity {
  if (exhaustionTransition === "Abort" || safetyRisk === "critical") {
    return "critical";
  }
  if (decision === "budget_exhausted" || decision === "blocked" || decision === "strategy_change_required") {
    return exhaustionTransition === "HumanReview" ? "error" : "warning";
  }
  if (decision === "retry_allowed_last_attempt" || safetyRisk === "elevated") {
    return "warning";
  }
  return "notice";
}

function eventSummary(
  request: RetryBudgetConsumeRequest,
  decision: RetryBudgetDecisionKind,
  before: RetryBudgetState | undefined,
  after: RetryBudgetState | undefined,
): string {
  if (decision === "budget_exhausted") {
    return `${request.budget_name} exhausted for ${request.scope_ref}; no autonomous retries remain.`;
  }
  if (decision === "strategy_change_required") {
    return `${request.budget_name} requires changed strategy before another retry.`;
  }
  if (decision === "blocked") {
    return `${request.budget_name} retry request was blocked.`;
  }
  return `${request.budget_name} consumed for ${request.scope_ref}; remaining attempts ${after?.remaining_attempts ?? before?.remaining_attempts ?? 0}.`;
}

function resolveBudget(
  budgets: readonly RetryBudgetState[],
  budgetName: RetryBudgetName,
  scopeRef: Ref,
): RetryBudgetState | undefined {
  return budgets.find((budget) => budget.budget_name === budgetName && budget.scope_ref === scopeRef)
    ?? budgets.find((budget) => budget.budget_name === budgetName);
}

function strategyChanged(strategy: RetryStrategyDescriptor, previousStrategyRef: Ref | undefined): boolean {
  if (previousStrategyRef === undefined || strategy.strategy_ref !== previousStrategyRef) {
    return true;
  }
  return strategy.changed_aspects.some((aspect) => aspect !== "none");
}

function validateGuardRequest(request: RetryBudgetGuardRequest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateRef(request.scope_ref, "$.scope_ref", issues);
  const policy = DEFAULT_POLICY_BY_NAME[request.budget_name];
  if (policy === undefined) {
    issues.push(issue("error", "RetryBudgetPolicyMissing", "$.budget_name", "Retry budget policy is unknown.", "Use a File 08 retry budget name."));
  }
  if (request.strategy !== undefined) {
    validateStrategy(request.strategy, "$.strategy", issues);
  }
  return issues;
}

function validateConsumeRequest(request: RetryBudgetConsumeRequest, policy: RetryBudgetPolicy): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateRef(request.scope_ref, "$.scope_ref", issues);
  validateStrategy(request.strategy, "$.strategy", issues);
  validateSafeText(request.attempt_reason, "$.attempt_reason", true, issues);
  validateSafeText(request.failure_reason ?? "", "$.failure_reason", false, issues);
  if (!policy.allowed_owner_states.includes(request.owner_state)) {
    issues.push(issue("error", "RetryOwnerStateInvalid", "$.owner_state", `Budget ${request.budget_name} cannot be consumed from ${request.owner_state}.`, "Use the architecture-defined retry owner state."));
  }
  if (request.occurred_at_ms < 0 || !Number.isFinite(request.occurred_at_ms)) {
    issues.push(issue("error", "RetryTimestampInvalid", "$.occurred_at_ms", "Retry event timestamp must be finite and non-negative.", "Use scenario-clock milliseconds."));
  }
  if (request.safety_risk === "critical" && policy.exhaustion_transition === "FailureCertificate") {
    issues.push(issue("error", "CriticalRiskCannotIssueFailureCertificate", "$.safety_risk", "Critical safety risk cannot end in a failure certificate.", "Route critical risk to SafeHold, HumanReview, or Abort."));
  }
  return issues;
}

function validateStrategy(strategy: RetryStrategyDescriptor, path: string, issues: ValidationIssue[]): void {
  validateRef(strategy.strategy_ref, `${path}.strategy_ref`, issues);
  validateSafeText(strategy.summary, `${path}.summary`, true, issues);
  if (strategy.changed_aspects.length === 0) {
    issues.push(issue("warning", "RetryStrategyChangeUnspecified", `${path}.changed_aspects`, "Retry strategy did not declare changed aspects.", "Declare whether evidence, view, approach, tool, schema, or force changed."));
  }
  for (const [index, ref] of strategy.evidence_refs.entries()) {
    validateRef(ref, `${path}.evidence_refs[${index}]`, issues);
  }
}

function validateRef(ref: Ref, path: string, issues: ValidationIssue[]): void {
  if (ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(issue("error", "ReferenceInvalid", path, "Reference must be non-empty and whitespace-free.", "Use a stable opaque reference."));
  }
  if (FORBIDDEN_RETRY_TEXT_PATTERN.test(ref)) {
    issues.push(issue("error", "ReferenceForbiddenForRetryBudget", path, "Reference contains retry-boundary forbidden wording.", "Use opaque prompt-safe and runtime-safe references."));
  }
}

function validateRefOrThrow(ref: Ref, path: string): void {
  const issues: ValidationIssue[] = [];
  validateRef(ref, path, issues);
  if (issues.some((item) => item.severity === "error")) {
    throw new RetryBudgetManagerError("Retry budget reference validation failed.", issues);
  }
}

function validateSafeText(value: string, path: string, required: boolean, issues: ValidationIssue[]): void {
  if (required && value.trim().length === 0) {
    issues.push(issue("error", "RetryTextRequired", path, "Retry reason text is required.", "Provide a concise reason for this retry attempt."));
  }
  if (FORBIDDEN_RETRY_TEXT_PATTERN.test(value)) {
    issues.push(issue("error", "RetryTextForbidden", path, "Retry text contains unsafe or unbounded retry wording.", "Use bounded, validator-safe retry language."));
  }
}

function primaryTargetFor(exhaustion: RetryBudgetState["exhaustion_transition"]): PrimaryState {
  if (exhaustion === "FailureCertificate") {
    return "HumanReview";
  }
  return exhaustion;
}

function boundedAttempts(value: number, policy: RetryBudgetPolicy): number {
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new RetryBudgetManagerError("Retry budget override must be a finite non-negative integer.", [issue("error", "RetryBudgetOverrideInvalid", "$.overrides", "Retry budget override must be a finite non-negative integer.", "Use a bounded integer attempt count.")]);
  }
  return Math.min(value, policy.maximum_attempts);
}

function makeDashboardEntry(budget: RetryBudgetState, policy: RetryBudgetPolicy): RetryBudgetDashboardEntry {
  return Object.freeze({
    budget_name: budget.budget_name,
    scope_ref: budget.scope_ref,
    remaining_attempts: budget.remaining_attempts,
    maximum_attempts: policy.maximum_attempts,
    requires_strategy_change: budget.requires_strategy_change,
    exhaustion_transition: budget.exhaustion_transition,
    label: `${policy.dashboard_label}: ${budget.remaining_attempts}/${policy.maximum_attempts} remaining`,
  });
}

function indexPolicies(policies: readonly RetryBudgetPolicy[]): Readonly<Record<RetryBudgetName, RetryBudgetPolicy>> {
  const map = new Map<RetryBudgetName, RetryBudgetPolicy>();
  for (const policy of policies) {
    if (map.has(policy.budget_name)) {
      throw new RetryBudgetManagerError(`Duplicate retry budget policy: ${policy.budget_name}.`, [issue("error", "RetryBudgetPolicyDuplicated", "$.policies", "Retry budget policies must be unique by name.", "Remove duplicate policy entries.")]);
    }
    if (policy.default_attempts < 0 || policy.maximum_attempts < policy.default_attempts || policy.strategy_change_after_attempts < 0) {
      throw new RetryBudgetManagerError(`Invalid retry budget policy: ${policy.budget_name}.`, [issue("error", "RetryBudgetPolicyInvalid", "$.policies", "Retry budget policy attempt counts are invalid.", "Use non-negative finite attempt limits.")]);
    }
    map.set(policy.budget_name, Object.freeze(policy));
  }
  const missing = ALL_RETRY_BUDGETS.filter((budgetName) => !map.has(budgetName));
  if (missing.length > 0) {
    throw new RetryBudgetManagerError(`Missing retry budget policies: ${missing.join(", ")}.`, [issue("error", "RetryBudgetPolicyMissing", "$.policies", "All File 08 retry budgets require policies.", "Declare every retry budget category.")]);
  }
  return Object.freeze(Object.fromEntries(ALL_RETRY_BUDGETS.map((budgetName) => [budgetName, map.get(budgetName) as RetryBudgetPolicy])) as Record<RetryBudgetName, RetryBudgetPolicy>);
}

function makePolicy(
  budgetName: RetryBudgetName,
  scopeKind: RetryBudgetScopeKind,
  defaultAttempts: number,
  maximumAttempts: number,
  exhaustionTransition: RetryBudgetState["exhaustion_transition"],
  attemptKind: RetryBudgetAttemptKind,
  strategyChangeAfterAttempts: number,
  allowedOwnerStates: readonly PrimaryState[],
  terminalEventType: OrchestrationEventType,
  dashboardLabel: string,
): RetryBudgetPolicy {
  return Object.freeze({
    budget_name: budgetName,
    scope_kind: scopeKind,
    default_attempts: defaultAttempts,
    maximum_attempts: maximumAttempts,
    exhaustion_transition: exhaustionTransition,
    attempt_kind: attemptKind,
    strategy_change_after_attempts: strategyChangeAfterAttempts,
    allowed_owner_states: freezeArray(allowedOwnerStates),
    terminal_event_type: terminalEventType,
    dashboard_label: dashboardLabel,
  });
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 600);
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

const ALL_RETRY_BUDGETS: readonly RetryBudgetName[] = freezeArray([
  "PromptRepairBudget",
  "PlanningRetryBudget",
  "ReobserveBudget",
  "CorrectionRetryBudget",
  "ToolUseRetryBudget",
  "VerificationRetryBudget",
  "AudioAttentionBudget",
]);

const DEFAULT_RETRY_BUDGET_POLICIES: readonly RetryBudgetPolicy[] = freezeArray([
  makePolicy("PromptRepairBudget", "prompt", 1, 2, "SafeHold", "schema_repair", 1, ["PlanRepair", "Plan"], "RetryBudgetExhausted", "Prompt repair"),
  makePolicy("PlanningRetryBudget", "phase", 2, 3, "HumanReview", "validator_feedback_replan", 1, ["Validate", "Plan"], "RetryBudgetExhausted", "Planning retries"),
  makePolicy("ReobserveBudget", "object", 2, 3, "HumanReview", "targeted_reobserve", 1, ["Observe", "Reobserve", "Verify", "AudioAttend"], "RetryBudgetExhausted", "Reobserve attempts"),
  makePolicy("CorrectionRetryBudget", "failure_class", 2, 3, "HumanReview", "oops_correction", 1, ["Correct", "Execute", "Verify"], "RetryBudgetExhausted", "Correction attempts"),
  makePolicy("ToolUseRetryBudget", "tool", 1, 2, "HumanReview", "tool_assessment", 1, ["ToolAssess", "Validate"], "RetryBudgetExhausted", "Tool-use attempts"),
  makePolicy("VerificationRetryBudget", "constraint", 2, 3, "FailureCertificate", "verification_disambiguation", 1, ["Verify", "Reobserve"], "RetryBudgetExhausted", "Verification attempts"),
  makePolicy("AudioAttentionBudget", "audio_event", 2, 3, "SafeHold", "audio_attention", 1, ["AudioAttend", "Observe", "Execute"], "RetryBudgetExhausted", "Audio attention"),
]);

const DEFAULT_POLICY_BY_NAME: Readonly<Record<RetryBudgetName, RetryBudgetPolicy>> = indexPolicies(DEFAULT_RETRY_BUDGET_POLICIES);

export const RETRY_BUDGET_MANAGER_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: RETRY_BUDGET_MANAGER_SCHEMA_VERSION,
  blueprint: "architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md",
  sections: freezeArray(["8.3", "8.11", "8.13", "8.14", "8.16", "8.17", "8.18"]),
  traceability_ref: CONTRACT_TRACEABILITY_REF,
  retry_budget_categories: ALL_RETRY_BUDGETS,
});
