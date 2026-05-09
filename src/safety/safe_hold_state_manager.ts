/**
 * SafeHold state manager for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/18_SAFETY_GUARDRAILS_VALIDATION_AND_POLICY.md`
 * sections 18.6, 18.15.3, 18.16.2, 18.17, 18.18, 18.19, 18.20, and 18.21.
 *
 * The manager creates deterministic SafeHold records, blocks new physical
 * authority, preserves audit evidence, denies unsafe memory success writes, and
 * evaluates conservative exit routes from SafeHold into reobserve, retreat,
 * resume, human review, or task abort.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  compactSafetyText,
  freezeArray,
  makeIssue,
  makeSafetyRef,
  uniqueRefs,
  uniqueStrings,
  validateFiniteNumber,
  validateOptionalRef,
  validateRef,
  validateSafeText,
} from "./safety_policy_registry";
import type {
  ActiveSafetyPolicySet,
  RecoveryAction,
  RiskSeverity,
  SafeHoldState,
  SafetyRoute,
  SafetyRouteDecision,
} from "./safety_policy_registry";

export const SAFE_HOLD_STATE_MANAGER_SCHEMA_VERSION = "mebsuta.safe_hold_state_manager.v1" as const;

export type SafeHoldTriggerClass =
  | "force_contact_limit"
  | "controller_anomaly"
  | "hidden_truth_leak"
  | "retry_budget_exhausted"
  | "tool_sweep_unsafe"
  | "body_stability_risk"
  | "audio_impact_risk"
  | "verification_unsafe_failure"
  | "operator_stop"
  | "sensor_blackout";

export type SafeHoldExitRoute = "reobserve" | "controlled_retreat" | "resume_task" | "human_review" | "abort_task";
export type SafeHoldExitDecisionKind = "exit_to_reobserve" | "exit_to_retreat" | "exit_to_resume" | "human_review_required" | "abort_task" | "remain_in_safe_hold";

export interface SafeHoldTriggerEvent {
  readonly trigger_event_ref: Ref;
  readonly trigger_class: SafeHoldTriggerClass;
  readonly severity: Extract<RiskSeverity, "medium" | "high" | "blocking" | "critical">;
  readonly occurred_at_ms: number;
  readonly source_report_refs: readonly Ref[];
  readonly blocked_action_refs: readonly Ref[];
  readonly evidence_refs: readonly Ref[];
  readonly human_reason: string;
}

export interface SafeHoldBodyStateSummary {
  readonly body_state_ref: Ref;
  readonly posture_summary: string;
  readonly held_object_ref?: Ref;
  readonly tool_state_ref?: Ref;
  readonly stable_posture_available: boolean;
  readonly release_is_safer_than_hold: boolean;
}

export interface SafeHoldActiveTask {
  readonly task_ref?: Ref;
  readonly active_plan_ref?: Ref;
  readonly active_primitive_ref?: Ref;
  readonly active_tool_ref?: Ref;
}

export interface SafeHoldEntryRequest {
  readonly trigger_event: SafeHoldTriggerEvent;
  readonly body_state: SafeHoldBodyStateSummary;
  readonly active_task: SafeHoldActiveTask;
  readonly active_policy_set: ActiveSafetyPolicySet;
  readonly tts_announcement_ref?: Ref;
}

export interface SafeHoldEvidenceUpdate {
  readonly evidence_ref: Ref;
  readonly evidence_class: "observation" | "telemetry" | "operator" | "verification" | "policy" | "controller" | "audio";
  readonly summary: string;
  readonly observed_at_ms: number;
  readonly resolves_trigger_refs: readonly Ref[];
  readonly supports_recovery_routes: readonly SafeHoldExitRoute[];
}

export interface SafeHoldRecoveryPolicy {
  readonly recovery_policy_ref: Ref;
  readonly allowed_exit_routes: readonly SafeHoldExitRoute[];
  readonly require_fresh_observation: boolean;
  readonly require_operator_review_for_critical: boolean;
  readonly maximum_evidence_age_ms: number;
  readonly cleared_trigger_refs: readonly Ref[];
  readonly retreat_path_validated: boolean;
  readonly resume_validation_report_refs: readonly Ref[];
}

export interface SafeHoldExitDecision {
  readonly safe_hold_exit_decision_ref: Ref;
  readonly safe_hold_ref: Ref;
  readonly decision: SafeHoldExitDecisionKind;
  readonly route_decision: SafetyRouteDecision;
  readonly required_evidence_refs: readonly Ref[];
  readonly cleared_trigger_refs: readonly Ref[];
  readonly blocked_exit_reasons: readonly string[];
  readonly memory_write_policy: SafeHoldState["memory_write_policy"];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

/**
 * Owns SafeHold entry and exit evaluation for the File 18 safety batch.
 */
export class SafeHoldStateManager {
  /**
   * Enters SafeHold by building an immutable state record and conservative
   * recovery contract from trigger, body, task, and policy evidence.
   */
  public enterSafeHold(request: SafeHoldEntryRequest): SafeHoldState {
    const issues = validateEntryRequest(request);
    if (issues.some((issue) => issue.severity === "error")) {
      throw new SafeHoldStateManagerError("SafeHold entry request failed validation.", issues);
    }

    const blockedActionRefs = uniqueRefs([
      ...request.trigger_event.blocked_action_refs,
      request.active_task.active_plan_ref,
      request.active_task.active_primitive_ref,
      request.active_task.active_tool_ref,
    ]);
    const requiredEvidenceRefs = uniqueRefs([
      request.trigger_event.trigger_event_ref,
      request.body_state.body_state_ref,
      ...request.trigger_event.evidence_refs,
      ...request.trigger_event.source_report_refs,
      ...request.active_policy_set.audit_requirements,
    ]);
    const allowedRecoveryActions = recoveryActionsFor(request.trigger_event, request.body_state, request.active_policy_set);
    const exitConditions = buildExitConditions(request.trigger_event, allowedRecoveryActions);
    const base = {
      safe_hold_ref: makeSafetyRef("safe_hold", request.trigger_event.trigger_event_ref, request.trigger_event.occurred_at_ms),
      entry_trigger_ref: request.trigger_event.trigger_event_ref,
      entry_time_ms: request.trigger_event.occurred_at_ms,
      active_task_ref: request.active_task.task_ref,
      body_state_summary: compactSafetyText(buildBodySummary(request.body_state)),
      risk_summary: compactSafetyText(request.trigger_event.human_reason),
      blocked_action_refs: blockedActionRefs,
      required_evidence_refs: requiredEvidenceRefs,
      allowed_recovery_actions: allowedRecoveryActions,
      exit_conditions: exitConditions,
      memory_write_policy: "deny_verified_spatial_writes" as const,
      tts_announcement_ref: request.tts_announcement_ref,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }

  /**
   * Evaluates whether a SafeHold record may exit. Critical or uncleared
   * triggers remain in SafeHold unless policy explicitly routes human review or
   * task abort; autonomous resume requires fresh validating evidence.
   */
  public evaluateSafeHoldExit(
    safeHoldState: SafeHoldState,
    newEvidence: readonly SafeHoldEvidenceUpdate[],
    recoveryPolicy: SafeHoldRecoveryPolicy,
    nowMs: number,
  ): SafeHoldExitDecision {
    const issues = validateExitRequest(safeHoldState, newEvidence, recoveryPolicy, nowMs);
    const freshEvidence = newEvidence.filter((item) => nowMs - item.observed_at_ms <= recoveryPolicy.maximum_evidence_age_ms);
    const clearedTriggerRefs = uniqueRefs([
      ...recoveryPolicy.cleared_trigger_refs,
      ...freshEvidence.flatMap((item) => item.resolves_trigger_refs),
    ]);
    const supportedRoutes = routeIntersection(recoveryPolicy.allowed_exit_routes, freshEvidence.flatMap((item) => item.supports_recovery_routes));
    const blockedReasons = blockedExitReasons(safeHoldState, freshEvidence, supportedRoutes, recoveryPolicy, issues);
    const decision = chooseExitDecision(safeHoldState, supportedRoutes, recoveryPolicy, blockedReasons, issues);
    const routeDecision = buildRouteDecision(safeHoldState, decision, freshEvidence, recoveryPolicy, blockedReasons);
    const base = {
      safe_hold_exit_decision_ref: makeSafetyRef("safe_hold_exit_decision", safeHoldState.safe_hold_ref, decision, nowMs),
      safe_hold_ref: safeHoldState.safe_hold_ref,
      decision,
      route_decision: routeDecision,
      required_evidence_refs: requiredEvidenceForDecision(safeHoldState, decision, recoveryPolicy),
      cleared_trigger_refs: clearedTriggerRefs,
      blocked_exit_reasons: freezeArray(blockedReasons.map((reason) => compactSafetyText(reason))),
      memory_write_policy: decision === "exit_to_resume" ? "allow_audit_note_only" as const : "deny_verified_spatial_writes" as const,
      issues: freezeArray(issues),
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export class SafeHoldStateManagerError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "SafeHoldStateManagerError";
    this.issues = freezeArray(issues);
  }
}

export function createSafeHoldStateManager(): SafeHoldStateManager {
  return new SafeHoldStateManager();
}

function validateEntryRequest(request: SafeHoldEntryRequest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateTrigger(request.trigger_event, "$.trigger_event", issues);
  validateBody(request.body_state, "$.body_state", issues);
  validateActiveTask(request.active_task, "$.active_task", issues);
  validateOptionalRef(request.tts_announcement_ref, "$.tts_announcement_ref", issues);
  validateRef(request.active_policy_set.active_policy_set_ref, "$.active_policy_set.active_policy_set_ref", issues);
  return issues;
}

function validateExitRequest(
  safeHoldState: SafeHoldState,
  newEvidence: readonly SafeHoldEvidenceUpdate[],
  recoveryPolicy: SafeHoldRecoveryPolicy,
  nowMs: number,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateSafeHoldState(safeHoldState, issues);
  validateRef(recoveryPolicy.recovery_policy_ref, "$.recovery_policy.recovery_policy_ref", issues);
  validateFiniteNumber(recoveryPolicy.maximum_evidence_age_ms, "$.recovery_policy.maximum_evidence_age_ms", 1, undefined, issues);
  validateFiniteNumber(nowMs, "$.now_ms", 0, undefined, issues);
  for (const [index, ref] of recoveryPolicy.cleared_trigger_refs.entries()) {
    validateRef(ref, `$.recovery_policy.cleared_trigger_refs[${index}]`, issues);
  }
  for (const [index, ref] of recoveryPolicy.resume_validation_report_refs.entries()) {
    validateRef(ref, `$.recovery_policy.resume_validation_report_refs[${index}]`, issues);
  }
  for (const [index, item] of newEvidence.entries()) {
    validateEvidence(item, index, issues);
    if (nowMs - item.observed_at_ms > recoveryPolicy.maximum_evidence_age_ms) {
      issues.push(makeIssue("warning", "SafeHoldEvidenceStale", `$.new_evidence[${index}].observed_at_ms`, "Recovery evidence is stale relative to policy.", "Refresh observation, telemetry, or operator evidence before exit."));
    }
  }
  return issues;
}

function validateTrigger(trigger: SafeHoldTriggerEvent, path: string, issues: ValidationIssue[]): void {
  validateRef(trigger.trigger_event_ref, `${path}.trigger_event_ref`, issues);
  validateFiniteNumber(trigger.occurred_at_ms, `${path}.occurred_at_ms`, 0, undefined, issues);
  validateSafeText(trigger.human_reason, `${path}.human_reason`, true, issues);
  for (const [index, ref] of trigger.source_report_refs.entries()) {
    validateRef(ref, `${path}.source_report_refs[${index}]`, issues);
  }
  for (const [index, ref] of trigger.blocked_action_refs.entries()) {
    validateRef(ref, `${path}.blocked_action_refs[${index}]`, issues);
  }
  for (const [index, ref] of trigger.evidence_refs.entries()) {
    validateRef(ref, `${path}.evidence_refs[${index}]`, issues);
  }
}

function validateBody(body: SafeHoldBodyStateSummary, path: string, issues: ValidationIssue[]): void {
  validateRef(body.body_state_ref, `${path}.body_state_ref`, issues);
  validateSafeText(body.posture_summary, `${path}.posture_summary`, true, issues);
  validateOptionalRef(body.held_object_ref, `${path}.held_object_ref`, issues);
  validateOptionalRef(body.tool_state_ref, `${path}.tool_state_ref`, issues);
}

function validateActiveTask(task: SafeHoldActiveTask, path: string, issues: ValidationIssue[]): void {
  validateOptionalRef(task.task_ref, `${path}.task_ref`, issues);
  validateOptionalRef(task.active_plan_ref, `${path}.active_plan_ref`, issues);
  validateOptionalRef(task.active_primitive_ref, `${path}.active_primitive_ref`, issues);
  validateOptionalRef(task.active_tool_ref, `${path}.active_tool_ref`, issues);
}

function validateSafeHoldState(state: SafeHoldState, issues: ValidationIssue[]): void {
  validateRef(state.safe_hold_ref, "$.safe_hold_state.safe_hold_ref", issues);
  validateRef(state.entry_trigger_ref, "$.safe_hold_state.entry_trigger_ref", issues);
  validateFiniteNumber(state.entry_time_ms, "$.safe_hold_state.entry_time_ms", 0, undefined, issues);
  validateOptionalRef(state.active_task_ref, "$.safe_hold_state.active_task_ref", issues);
  validateSafeText(state.body_state_summary, "$.safe_hold_state.body_state_summary", true, issues);
  validateSafeText(state.risk_summary, "$.safe_hold_state.risk_summary", true, issues);
}

function validateEvidence(item: SafeHoldEvidenceUpdate, index: number, issues: ValidationIssue[]): void {
  const path = `$.new_evidence[${index}]`;
  validateRef(item.evidence_ref, `${path}.evidence_ref`, issues);
  validateSafeText(item.summary, `${path}.summary`, true, issues);
  validateFiniteNumber(item.observed_at_ms, `${path}.observed_at_ms`, 0, undefined, issues);
  for (const [refIndex, ref] of item.resolves_trigger_refs.entries()) {
    validateRef(ref, `${path}.resolves_trigger_refs[${refIndex}]`, issues);
  }
}

function recoveryActionsFor(
  trigger: SafeHoldTriggerEvent,
  body: SafeHoldBodyStateSummary,
  policySet: ActiveSafetyPolicySet,
): readonly RecoveryAction[] {
  const actions: RecoveryAction[] = ["HumanReview", "Abort"];
  if (policySet.sensor_requirements.length > 0 && trigger.trigger_class !== "hidden_truth_leak") {
    actions.push("Reobserve");
  }
  if (body.stable_posture_available) {
    actions.push("Retreat");
  }
  if (body.release_is_safer_than_hold || trigger.trigger_class === "tool_sweep_unsafe") {
    actions.push("Release");
  }
  if (trigger.severity !== "critical" && trigger.trigger_class !== "hidden_truth_leak" && trigger.trigger_class !== "operator_stop") {
    actions.push("Resume");
  }
  return uniqueRecoveryActions(actions);
}

function buildExitConditions(trigger: SafeHoldTriggerEvent, actions: readonly RecoveryAction[]): readonly string[] {
  const conditions = [
    "new physical commands remain blocked until exit decision is accepted",
    "safety evidence and policy refs are preserved for audit replay",
    "verified spatial memory writes remain denied while SafeHold is active",
    actions.includes("Reobserve") ? "fresh embodied observation must clear the trigger" : undefined,
    actions.includes("Retreat") ? "controlled retreat path must be validated before retreat" : undefined,
    actions.includes("Resume") ? "all triggering risks require deterministic validator clearance before resume" : undefined,
    trigger.severity === "critical" ? "critical trigger requires human review or abort unless policy explicitly clears it" : undefined,
  ].filter((item): item is string => item !== undefined);
  return uniqueStrings(conditions);
}

function buildBodySummary(body: SafeHoldBodyStateSummary): string {
  const held = body.held_object_ref === undefined ? "no held object recorded" : `held object ${body.held_object_ref}`;
  const tool = body.tool_state_ref === undefined ? "no active tool recorded" : `tool state ${body.tool_state_ref}`;
  const posture = body.stable_posture_available ? "stable posture available" : "stable posture unavailable";
  const release = body.release_is_safer_than_hold ? "policy prefers release if validated" : "policy prefers hold posture";
  return `${body.posture_summary}; ${held}; ${tool}; ${posture}; ${release}.`;
}

function routeIntersection(policyRoutes: readonly SafeHoldExitRoute[], evidenceRoutes: readonly SafeHoldExitRoute[]): readonly SafeHoldExitRoute[] {
  const evidence = new Set(evidenceRoutes);
  return freezeArray(policyRoutes.filter((route) => evidence.has(route)));
}

function blockedExitReasons(
  state: SafeHoldState,
  freshEvidence: readonly SafeHoldEvidenceUpdate[],
  supportedRoutes: readonly SafeHoldExitRoute[],
  policy: SafeHoldRecoveryPolicy,
  issues: readonly ValidationIssue[],
): readonly string[] {
  const reasons: string[] = [];
  if (issues.some((issue) => issue.severity === "error")) {
    reasons.push("SafeHold exit request contains structural validation errors.");
  }
  if (policy.require_fresh_observation && !freshEvidence.some((item) => item.evidence_class === "observation")) {
    reasons.push("Fresh observation evidence is required before SafeHold exit.");
  }
  if (supportedRoutes.length === 0 && !policy.allowed_exit_routes.includes("human_review") && !policy.allowed_exit_routes.includes("abort_task")) {
    reasons.push("No policy-allowed exit route is supported by fresh evidence.");
  }
  if (policy.allowed_exit_routes.includes("controlled_retreat") && !policy.retreat_path_validated && supportedRoutes.includes("controlled_retreat")) {
    reasons.push("Controlled retreat route lacks validated retreat path evidence.");
  }
  if (policy.allowed_exit_routes.includes("resume_task") && policy.resume_validation_report_refs.length === 0 && supportedRoutes.includes("resume_task")) {
    reasons.push("Resume route requires deterministic validation report references.");
  }
  if (state.required_evidence_refs.length > 0 && freshEvidence.length === 0) {
    reasons.push("SafeHold required evidence has not been refreshed or cleared.");
  }
  return freezeArray(reasons);
}

function chooseExitDecision(
  state: SafeHoldState,
  supportedRoutes: readonly SafeHoldExitRoute[],
  policy: SafeHoldRecoveryPolicy,
  blockedReasons: readonly string[],
  issues: readonly ValidationIssue[],
): SafeHoldExitDecisionKind {
  if (policy.allowed_exit_routes.includes("abort_task")) {
    return "abort_task";
  }
  if (issues.some((issue) => issue.severity === "error")) {
    return "remain_in_safe_hold";
  }
  if (policy.require_operator_review_for_critical && state.risk_summary.toLowerCase().includes("critical")) {
    return "human_review_required";
  }
  if (blockedReasons.length > 0) {
    return policy.allowed_exit_routes.includes("human_review") ? "human_review_required" : "remain_in_safe_hold";
  }
  if (supportedRoutes.includes("resume_task") && state.allowed_recovery_actions.includes("Resume")) {
    return "exit_to_resume";
  }
  if (supportedRoutes.includes("controlled_retreat") && state.allowed_recovery_actions.includes("Retreat")) {
    return "exit_to_retreat";
  }
  if (supportedRoutes.includes("reobserve") && state.allowed_recovery_actions.includes("Reobserve")) {
    return "exit_to_reobserve";
  }
  return policy.allowed_exit_routes.includes("human_review") ? "human_review_required" : "remain_in_safe_hold";
}

function buildRouteDecision(
  state: SafeHoldState,
  decision: SafeHoldExitDecisionKind,
  evidence: readonly SafeHoldEvidenceUpdate[],
  policy: SafeHoldRecoveryPolicy,
  blockedReasons: readonly string[],
): SafetyRouteDecision {
  const finalRoute: SafetyRoute = decision === "exit_to_resume"
    ? "Continue"
    : decision === "exit_to_retreat"
      ? "ContinueRestricted"
      : decision === "exit_to_reobserve"
        ? "Reobserve"
        : decision === "human_review_required"
          ? "HumanReview"
          : decision === "abort_task"
            ? "Reject"
            : "SafeHold";
  const base = {
    safety_route_decision_ref: makeSafetyRef("safe_hold_route", state.safe_hold_ref, decision, policy.recovery_policy_ref),
    source_report_refs: uniqueRefs([state.safe_hold_ref, ...policy.resume_validation_report_refs]),
    final_route: finalRoute,
    restriction_set_refs: finalRoute === "Continue" ? freezeArray([]) : uniqueRefs(state.exit_conditions.map((condition) => makeSafetyRef("safe_hold_condition", condition))),
    blocked_artifact_refs: finalRoute === "Continue" || finalRoute === "ContinueRestricted" ? freezeArray([]) : state.blocked_action_refs,
    human_readable_reason: routeReason(decision, blockedReasons),
    audit_replay_refs: uniqueRefs([state.safe_hold_ref, policy.recovery_policy_ref, ...evidence.map((item) => item.evidence_ref), ...state.required_evidence_refs]),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function routeReason(decision: SafeHoldExitDecisionKind, blockedReasons: readonly string[]): string {
  if (blockedReasons.length > 0) {
    return compactSafetyText(`SafeHold exit ${decision}; ${blockedReasons.join(" ")}`);
  }
  switch (decision) {
    case "exit_to_reobserve":
      return "SafeHold may exit to constrained reobserve only.";
    case "exit_to_retreat":
      return "SafeHold may exit to controlled retreat with restrictions.";
    case "exit_to_resume":
      return "SafeHold may exit to resume after deterministic validation clearance.";
    case "human_review_required":
      return "SafeHold requires human review before autonomous recovery.";
    case "abort_task":
      return "SafeHold recovery policy routes to task abort.";
    case "remain_in_safe_hold":
      return "SafeHold remains active until required evidence clears the trigger.";
  }
}

function requiredEvidenceForDecision(
  state: SafeHoldState,
  decision: SafeHoldExitDecisionKind,
  policy: SafeHoldRecoveryPolicy,
): readonly Ref[] {
  if (decision === "exit_to_resume") {
    return uniqueRefs(policy.resume_validation_report_refs);
  }
  if (decision === "exit_to_reobserve" || decision === "exit_to_retreat") {
    return uniqueRefs([state.entry_trigger_ref, ...state.required_evidence_refs]);
  }
  return state.required_evidence_refs;
}

function uniqueRecoveryActions(actions: readonly RecoveryAction[]): readonly RecoveryAction[] {
  const order: readonly RecoveryAction[] = ["Reobserve", "Retreat", "Release", "Resume", "HumanReview", "Abort"];
  const present = new Set(actions);
  return freezeArray(order.filter((item) => present.has(item)));
}

export const SAFE_HOLD_STATE_MANAGER_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: SAFE_HOLD_STATE_MANAGER_SCHEMA_VERSION,
  blueprint: "architecture_docs/18_SAFETY_GUARDRAILS_VALIDATION_AND_POLICY.md",
  sections: freezeArray(["18.6", "18.15.3", "18.16.2", "18.17", "18.18", "18.19", "18.20", "18.21"]),
  component: "SafeHoldStateManager",
  determinism_hash: computeDeterminismHash("safe hold state manager alignment"),
});
