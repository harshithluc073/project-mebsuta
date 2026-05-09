/**
 * Thinking budget policy manager for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/06_GEMINI_ROBOTICS_ER_COGNITIVE_LAYER.md`
 * sections 6.2.1, 6.6.1, 6.6.2, 6.8.4, 6.12.1, 6.13.1, 6.13.2, 6.19,
 * and 6.20.
 *
 * This module selects the Gemini Robotics-ER thinking allocation for each
 * cognitive request. It trades reasoning depth against latency by scoring
 * invocation difficulty, urgency, ambiguity, safety criticality, deadline
 * pressure, retry state, and evidence complexity, then returns an adapter-ready
 * `CognitiveInvocationPolicy` with hidden reasoning exposure disabled.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import { GEMINI_ROBOTICS_ER_OUTPUT_TOKEN_LIMIT } from "./gemini_robotics_er_adapter";
import type {
  CognitiveInvocationClass,
  CognitiveInvocationPolicy,
  TemperatureClass,
  ThinkingBudgetClass,
} from "./gemini_robotics_er_adapter";
import type { CognitiveConfigurationProfile, CognitiveInvocationPlan, CognitiveQueue } from "./cognitive_request_router";

export const THINKING_BUDGET_POLICY_MANAGER_SCHEMA_VERSION = "mebsuta.thinking_budget_policy_manager.v1" as const;

const MIN_TIMEOUT_MS = 1500;
const MAX_TIMEOUT_MS = 30000;
const DEFAULT_DEADLINE_MS = 10000;
const MAX_EVIDENCE_ITEMS_FOR_SCORE = 16;
const MAX_CONTRADICTIONS_FOR_SCORE = 6;
const MAX_CANDIDATE_ACTIONS_FOR_SCORE = 10;
const MAX_RETRY_PENALTY_WINDOW = 3;

export type ThinkingBudgetProfileName =
  | "MinimalSpatialPointing"
  | "BalancedSceneUnderstanding"
  | "ComplexTaskPlanning"
  | "FailureDiagnosis"
  | "ToolUseReasoning"
  | "MonologueDraft";

export type ThinkingUrgency = "background" | "routine" | "execution_bound" | "safety_immediate";
export type ThinkingAmbiguity = "none" | "low" | "medium" | "high" | "conflict";
export type ThinkingSafetyCriticality = "none" | "low" | "medium" | "high" | "critical";
export type ThinkingLatencyTarget = "realtime" | "interactive" | "deliberate" | "background";
export type ThinkingDecision = "policy_ready" | "policy_ready_with_warnings" | "policy_rejected";

export interface ThinkingEvidenceComplexity {
  readonly evidence_item_count: number;
  readonly distinct_view_count: number;
  readonly contradiction_count: number;
  readonly candidate_action_count: number;
  readonly requires_tool_reasoning?: boolean;
  readonly requires_failure_diagnosis?: boolean;
  readonly requires_multi_step_plan?: boolean;
}

export interface ThinkingBudgetRequest {
  readonly request_ref: Ref;
  readonly invocation_class: CognitiveInvocationClass;
  readonly configuration_profile?: CognitiveConfigurationProfile;
  readonly queue?: CognitiveQueue;
  readonly urgency: ThinkingUrgency;
  readonly ambiguity: ThinkingAmbiguity;
  readonly safety_criticality: ThinkingSafetyCriticality;
  readonly latency_target: ThinkingLatencyTarget;
  readonly deadline_ms?: number;
  readonly retry_budget_remaining?: number;
  readonly validator_gate_required?: boolean;
  readonly evidence_complexity?: ThinkingEvidenceComplexity;
  readonly base_policy?: CognitiveInvocationPolicy;
}

export interface ThinkingScoreBreakdown {
  readonly base_invocation_difficulty: number;
  readonly ambiguity_pressure: number;
  readonly safety_pressure: number;
  readonly urgency_adjustment: number;
  readonly latency_adjustment: number;
  readonly deadline_adjustment: number;
  readonly retry_adjustment: number;
  readonly evidence_complexity_pressure: number;
  readonly final_reasoning_score: number;
}

export interface GeminiThinkingApiConfig {
  readonly thinkingConfig: {
    readonly thinkingBudget: number;
    readonly includeThoughts: false;
  };
}

export interface ThinkingBudgetProfile {
  readonly profile_ref: Ref;
  readonly profile_name: ThinkingBudgetProfileName;
  readonly invocation_class: CognitiveInvocationClass;
  readonly thinking_budget_class: ThinkingBudgetClass;
  readonly max_thinking_tokens: number;
  readonly max_output_tokens: number;
  readonly recommended_timeout_ms: number;
  readonly temperature_class: TemperatureClass;
  readonly latency_target: ThinkingLatencyTarget;
  readonly hidden_reasoning_exposure_allowed: false;
  readonly public_rationale_required: boolean;
  readonly validator_gate_required: boolean;
  readonly risk_controls: readonly string[];
  readonly api_generation_config: GeminiThinkingApiConfig;
}

export interface ThinkingBudgetDecisionReport {
  readonly schema_version: typeof THINKING_BUDGET_POLICY_MANAGER_SCHEMA_VERSION;
  readonly decision: ThinkingDecision;
  readonly request_ref: Ref;
  readonly invocation_class: CognitiveInvocationClass;
  readonly score_breakdown: ThinkingScoreBreakdown;
  readonly selected_profile: ThinkingBudgetProfile;
  readonly invocation_policy: CognitiveInvocationPolicy;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface InvocationPlanThinkingPolicy {
  readonly schema_version: typeof THINKING_BUDGET_POLICY_MANAGER_SCHEMA_VERSION;
  readonly source_plan_ref: Ref;
  readonly thinking_report: ThinkingBudgetDecisionReport;
  readonly invocation_policy: CognitiveInvocationPolicy;
  readonly determinism_hash: string;
}

/**
 * Selects low, moderate, or high model reasoning budgets while preserving the
 * cognitive-layer rules for latency, safety, structured output, and public-only
 * rationale. Minimal is retained for the blueprint's monologue and memory
 * profiles where deliberate hidden reasoning would add latency without value.
 */
export class ThinkingBudgetPolicyManager {
  /**
   * Builds a policy request directly from a router invocation plan. Callers may
   * pass explicit ambiguity, safety, or evidence metrics when the orchestrator
   * has richer information than the route itself.
   */
  public evaluateInvocationPlan(
    plan: CognitiveInvocationPlan,
    overrides: Partial<Omit<ThinkingBudgetRequest, "request_ref" | "invocation_class" | "base_policy">> = {},
  ): InvocationPlanThinkingPolicy {
    const request: ThinkingBudgetRequest = Object.freeze({
      request_ref: plan.plan_ref,
      invocation_class: plan.invocation_class,
      configuration_profile: plan.configuration_profile,
      queue: plan.queue,
      urgency: overrides.urgency ?? urgencyFromQueue(plan.queue, plan.safe_hold_required),
      ambiguity: overrides.ambiguity ?? ambiguityFromPlan(plan),
      safety_criticality: overrides.safety_criticality ?? safetyFromPlan(plan),
      latency_target: overrides.latency_target ?? latencyFromQueue(plan.queue),
      deadline_ms: overrides.deadline_ms ?? plan.invocation_policy.timeout_ms,
      retry_budget_remaining: overrides.retry_budget_remaining,
      validator_gate_required: overrides.validator_gate_required ?? plan.validator_gate_required,
      evidence_complexity: overrides.evidence_complexity ?? evidenceComplexityFromPlan(plan),
      base_policy: plan.invocation_policy,
    });
    const thinkingReport = this.selectThinkingBudgetProfile(request);
    const base = {
      schema_version: THINKING_BUDGET_POLICY_MANAGER_SCHEMA_VERSION,
      source_plan_ref: plan.plan_ref,
      thinking_report: thinkingReport,
      invocation_policy: thinkingReport.invocation_policy,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Scores the request and returns a complete thinking profile plus the exact
   * invocation policy that should be submitted to the Gemini adapter.
   */
  public selectThinkingBudgetProfile(request: ThinkingBudgetRequest): ThinkingBudgetDecisionReport {
    const issues = validateRequest(request);
    const scoreBreakdown = scoreRequest(request);
    const budgetClass = chooseBudgetClass(request, scoreBreakdown.final_reasoning_score);
    const profileName = chooseProfileName(request, budgetClass);
    const timeoutMs = chooseTimeoutMs(request, budgetClass);
    const maxOutputTokens = chooseMaxOutputTokens(request.invocation_class, budgetClass);
    const temperatureClass = chooseTemperatureClass(request, budgetClass);
    const selectedProfile = makeProfile(request, profileName, budgetClass, timeoutMs, maxOutputTokens, temperatureClass);
    const invocationPolicy = makeInvocationPolicy(request.base_policy, selectedProfile);
    if (selectedProfile.recommended_timeout_ms > (request.deadline_ms ?? DEFAULT_DEADLINE_MS) && request.latency_target !== "background") {
      issues.push(issue("warning", "ThinkingTimeoutExceedsDeadline", "$.deadline_ms", "Selected thinking profile wants more time than the current deadline.", "Use the returned timeout only if the orchestrator can safely pause before motion."));
    }
    if (selectedProfile.thinking_budget_class === "high" && request.safety_criticality === "none" && request.latency_target === "realtime") {
      issues.push(issue("warning", "HighThinkingForRealtimeNoncriticalRequest", "$.latency_target", "High reasoning depth is unusual for a realtime noncritical request.", "Prefer low or moderate thinking unless ambiguity requires deeper reasoning."));
    }
    const decision: ThinkingDecision = issues.some((item) => item.severity === "error")
      ? "policy_rejected"
      : issues.some((item) => item.severity === "warning")
        ? "policy_ready_with_warnings"
        : "policy_ready";
    const base = {
      schema_version: THINKING_BUDGET_POLICY_MANAGER_SCHEMA_VERSION,
      decision,
      request_ref: request.request_ref,
      invocation_class: request.invocation_class,
      score_breakdown: scoreBreakdown,
      selected_profile: selectedProfile,
      invocation_policy: invocationPolicy,
      issues: freezeArray(issues),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }
}

function scoreRequest(request: ThinkingBudgetRequest): ThinkingScoreBreakdown {
  const baseInvocationDifficulty = baseDifficultyFor(request.invocation_class);
  const ambiguityPressure = ambiguityPressureFor(request.ambiguity);
  const safetyPressure = safetyPressureFor(request.safety_criticality, request.validator_gate_required === true);
  const urgencyAdjustment = urgencyAdjustmentFor(request.urgency, request.safety_criticality);
  const latencyAdjustment = latencyAdjustmentFor(request.latency_target);
  const deadlineAdjustment = deadlineAdjustmentFor(request.deadline_ms ?? DEFAULT_DEADLINE_MS);
  const retryAdjustment = retryAdjustmentFor(request.retry_budget_remaining);
  const evidenceComplexityPressure = evidencePressureFor(request.evidence_complexity);
  const finalReasoningScore = clamp01(
    baseInvocationDifficulty
      + ambiguityPressure
      + safetyPressure
      + urgencyAdjustment
      + latencyAdjustment
      + deadlineAdjustment
      + retryAdjustment
      + evidenceComplexityPressure,
  );
  return Object.freeze({
    base_invocation_difficulty: round3(baseInvocationDifficulty),
    ambiguity_pressure: round3(ambiguityPressure),
    safety_pressure: round3(safetyPressure),
    urgency_adjustment: round3(urgencyAdjustment),
    latency_adjustment: round3(latencyAdjustment),
    deadline_adjustment: round3(deadlineAdjustment),
    retry_adjustment: round3(retryAdjustment),
    evidence_complexity_pressure: round3(evidenceComplexityPressure),
    final_reasoning_score: round3(finalReasoningScore),
  });
}

function chooseBudgetClass(request: ThinkingBudgetRequest, score: number): ThinkingBudgetClass {
  if (request.invocation_class === "InternalMonologueReasoning") {
    return score >= 0.42 ? "low" : "minimal";
  }
  if (request.invocation_class === "MemoryAssimilationReasoning" && request.ambiguity !== "conflict" && request.safety_criticality !== "critical") {
    return score >= 0.48 ? "low" : "minimal";
  }
  if (request.invocation_class === "ToolUseReasoning") {
    return "high";
  }
  if (request.invocation_class === "OopsCorrectionReasoning" && (request.safety_criticality === "high" || request.safety_criticality === "critical" || request.ambiguity === "conflict")) {
    return "high";
  }
  if (score < 0.25) {
    return "minimal";
  }
  if (score < 0.46) {
    return "low";
  }
  if (score < 0.69) {
    return "moderate";
  }
  return "high";
}

function chooseProfileName(request: ThinkingBudgetRequest, budgetClass: ThinkingBudgetClass): ThinkingBudgetProfileName {
  if (request.invocation_class === "InternalMonologueReasoning") {
    return "MonologueDraft";
  }
  if (request.invocation_class === "OopsCorrectionReasoning" || request.evidence_complexity?.requires_failure_diagnosis === true) {
    return "FailureDiagnosis";
  }
  if (request.invocation_class === "ToolUseReasoning" || request.evidence_complexity?.requires_tool_reasoning === true) {
    return "ToolUseReasoning";
  }
  if (request.invocation_class === "TaskPlanningReasoning" || request.evidence_complexity?.requires_multi_step_plan === true || budgetClass === "high") {
    return "ComplexTaskPlanning";
  }
  if (request.invocation_class === "SceneObservationReasoning" || request.invocation_class === "MultiViewDisambiguationReasoning" || request.invocation_class === "SpatialVerificationReasoning") {
    return budgetClass === "minimal" ? "MinimalSpatialPointing" : "BalancedSceneUnderstanding";
  }
  if (request.invocation_class === "WaypointGenerationReasoning") {
    return budgetClass === "low" ? "BalancedSceneUnderstanding" : "ComplexTaskPlanning";
  }
  if (request.invocation_class === "AudioEventReasoning") {
    return budgetClass === "minimal" || budgetClass === "low" ? "MinimalSpatialPointing" : "BalancedSceneUnderstanding";
  }
  return budgetClass === "minimal" ? "MonologueDraft" : "BalancedSceneUnderstanding";
}

function makeProfile(
  request: ThinkingBudgetRequest,
  profileName: ThinkingBudgetProfileName,
  budgetClass: ThinkingBudgetClass,
  timeoutMs: number,
  maxOutputTokens: number,
  temperatureClass: TemperatureClass,
): ThinkingBudgetProfile {
  const maxThinkingTokens = thinkingTokensFor(budgetClass, request.latency_target);
  const riskControls = riskControlsFor(request, profileName, budgetClass);
  return Object.freeze({
    profile_ref: makeRef("thinking_budget_profile", request.invocation_class, profileName, budgetClass),
    profile_name: profileName,
    invocation_class: request.invocation_class,
    thinking_budget_class: budgetClass,
    max_thinking_tokens: maxThinkingTokens,
    max_output_tokens: maxOutputTokens,
    recommended_timeout_ms: timeoutMs,
    temperature_class: temperatureClass,
    latency_target: request.latency_target,
    hidden_reasoning_exposure_allowed: false,
    public_rationale_required: request.invocation_class === "InternalMonologueReasoning" || request.safety_criticality !== "none",
    validator_gate_required: request.validator_gate_required === true || actionBearingInvocation(request.invocation_class),
    risk_controls: freezeArray(riskControls),
    api_generation_config: Object.freeze({
      thinkingConfig: Object.freeze({
        thinkingBudget: maxThinkingTokens,
        includeThoughts: false as const,
      }),
    }),
  });
}

function makeInvocationPolicy(basePolicy: CognitiveInvocationPolicy | undefined, profile: ThinkingBudgetProfile): CognitiveInvocationPolicy {
  return Object.freeze({
    ...(basePolicy ?? {}),
    temperature_class: profile.temperature_class,
    thinking_budget_class: profile.thinking_budget_class,
    retry_class: basePolicy?.retry_class ?? "single_repair",
    timeout_ms: profile.recommended_timeout_ms,
    max_output_tokens: profile.max_output_tokens,
    require_structured_output: true,
    allow_preview_model: basePolicy?.allow_preview_model ?? true,
  });
}

function baseDifficultyFor(invocationClass: CognitiveInvocationClass): number {
  switch (invocationClass) {
    case "SceneObservationReasoning":
      return 0.32;
    case "TaskPlanningReasoning":
      return 0.68;
    case "WaypointGenerationReasoning":
      return 0.58;
    case "MultiViewDisambiguationReasoning":
      return 0.62;
    case "SpatialVerificationReasoning":
      return 0.42;
    case "OopsCorrectionReasoning":
      return 0.72;
    case "ToolUseReasoning":
      return 0.82;
    case "AudioEventReasoning":
      return 0.34;
    case "MemoryAssimilationReasoning":
      return 0.24;
    case "InternalMonologueReasoning":
      return 0.16;
  }
}

function ambiguityPressureFor(ambiguity: ThinkingAmbiguity): number {
  switch (ambiguity) {
    case "none":
      return 0;
    case "low":
      return 0.06;
    case "medium":
      return 0.15;
    case "high":
      return 0.26;
    case "conflict":
      return 0.34;
  }
}

function safetyPressureFor(safetyCriticality: ThinkingSafetyCriticality, validatorGateRequired: boolean): number {
  const gatePressure = validatorGateRequired ? 0.04 : 0;
  switch (safetyCriticality) {
    case "none":
      return gatePressure;
    case "low":
      return 0.05 + gatePressure;
    case "medium":
      return 0.13 + gatePressure;
    case "high":
      return 0.23 + gatePressure;
    case "critical":
      return 0.31 + gatePressure;
  }
}

function urgencyAdjustmentFor(urgency: ThinkingUrgency, safetyCriticality: ThinkingSafetyCriticality): number {
  const safetyUrgencyBoost = safetyCriticality === "high" || safetyCriticality === "critical" ? 0.06 : 0;
  switch (urgency) {
    case "background":
      return -0.08;
    case "routine":
      return 0;
    case "execution_bound":
      return 0.02;
    case "safety_immediate":
      return -0.04 + safetyUrgencyBoost;
  }
}

function latencyAdjustmentFor(latencyTarget: ThinkingLatencyTarget): number {
  switch (latencyTarget) {
    case "realtime":
      return -0.18;
    case "interactive":
      return -0.07;
    case "deliberate":
      return 0.04;
    case "background":
      return -0.03;
  }
}

function deadlineAdjustmentFor(deadlineMs: number): number {
  if (deadlineMs <= 2500) {
    return -0.2;
  }
  if (deadlineMs <= 5000) {
    return -0.1;
  }
  if (deadlineMs >= 18000) {
    return 0.08;
  }
  if (deadlineMs >= 12000) {
    return 0.04;
  }
  return 0;
}

function retryAdjustmentFor(retryBudgetRemaining: number | undefined): number {
  if (retryBudgetRemaining === undefined) {
    return 0;
  }
  const normalized = clamp01((MAX_RETRY_PENALTY_WINDOW - clamp(retryBudgetRemaining, 0, MAX_RETRY_PENALTY_WINDOW)) / MAX_RETRY_PENALTY_WINDOW);
  return normalized * 0.1;
}

function evidencePressureFor(complexity: ThinkingEvidenceComplexity | undefined): number {
  if (complexity === undefined) {
    return 0;
  }
  const evidenceLoad = clamp01(complexity.evidence_item_count / MAX_EVIDENCE_ITEMS_FOR_SCORE) * 0.08;
  const viewLoad = clamp01(complexity.distinct_view_count / 4) * 0.08;
  const contradictionLoad = clamp01(complexity.contradiction_count / MAX_CONTRADICTIONS_FOR_SCORE) * 0.12;
  const actionLoad = clamp01(complexity.candidate_action_count / MAX_CANDIDATE_ACTIONS_FOR_SCORE) * 0.08;
  const toolLoad = complexity.requires_tool_reasoning === true ? 0.08 : 0;
  const failureLoad = complexity.requires_failure_diagnosis === true ? 0.08 : 0;
  const planLoad = complexity.requires_multi_step_plan === true ? 0.06 : 0;
  return evidenceLoad + viewLoad + contradictionLoad + actionLoad + toolLoad + failureLoad + planLoad;
}

function chooseTimeoutMs(request: ThinkingBudgetRequest, budgetClass: ThinkingBudgetClass): number {
  const base = timeoutBaseFor(request.invocation_class);
  const budgetMultiplier = budgetClass === "minimal" ? 0.5 : budgetClass === "low" ? 0.75 : budgetClass === "moderate" ? 1 : 1.25;
  const latencyMultiplier = request.latency_target === "realtime" ? 0.65 : request.latency_target === "interactive" ? 0.9 : request.latency_target === "deliberate" ? 1.15 : 1;
  const raw = Math.round(base * budgetMultiplier * latencyMultiplier);
  const deadline = request.deadline_ms ?? DEFAULT_DEADLINE_MS;
  const canStretchForSafety = request.safety_criticality === "high" || request.safety_criticality === "critical";
  const deadlineBound = canStretchForSafety ? Math.max(deadline, Math.round(deadline * 1.15)) : deadline;
  return clamp(raw, MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, deadlineBound)));
}

function timeoutBaseFor(invocationClass: CognitiveInvocationClass): number {
  switch (invocationClass) {
    case "InternalMonologueReasoning":
      return 3000;
    case "AudioEventReasoning":
      return 5000;
    case "SpatialVerificationReasoning":
      return 7000;
    case "SceneObservationReasoning":
      return 8000;
    case "MemoryAssimilationReasoning":
      return 9000;
    case "OopsCorrectionReasoning":
      return 10000;
    case "WaypointGenerationReasoning":
    case "ToolUseReasoning":
      return 12000;
    case "TaskPlanningReasoning":
    case "MultiViewDisambiguationReasoning":
      return 14000;
  }
}

function chooseMaxOutputTokens(invocationClass: CognitiveInvocationClass, budgetClass: ThinkingBudgetClass): number {
  const base = outputBaseFor(invocationClass);
  const multiplier = budgetClass === "minimal" ? 0.5 : budgetClass === "low" ? 0.7 : budgetClass === "moderate" ? 1 : 1.25;
  return clamp(Math.round(base * multiplier), 512, GEMINI_ROBOTICS_ER_OUTPUT_TOKEN_LIMIT);
}

function outputBaseFor(invocationClass: CognitiveInvocationClass): number {
  switch (invocationClass) {
    case "InternalMonologueReasoning":
      return 1024;
    case "MemoryAssimilationReasoning":
      return 2048;
    case "AudioEventReasoning":
    case "SpatialVerificationReasoning":
      return 3072;
    case "SceneObservationReasoning":
    case "MultiViewDisambiguationReasoning":
      return 4096;
    case "WaypointGenerationReasoning":
      return 6144;
    case "TaskPlanningReasoning":
    case "OopsCorrectionReasoning":
    case "ToolUseReasoning":
      return 8192;
  }
}

function thinkingTokensFor(budgetClass: ThinkingBudgetClass, latencyTarget: ThinkingLatencyTarget): number {
  const base = budgetClass === "minimal" ? 512 : budgetClass === "low" ? 2048 : budgetClass === "moderate" ? 8192 : 16384;
  const multiplier = latencyTarget === "realtime" ? 0.75 : latencyTarget === "deliberate" ? 1.25 : 1;
  return clamp(Math.round(base * multiplier), 256, 24576);
}

function chooseTemperatureClass(request: ThinkingBudgetRequest, budgetClass: ThinkingBudgetClass): TemperatureClass {
  if (request.invocation_class === "MemoryAssimilationReasoning" || request.invocation_class === "InternalMonologueReasoning") {
    return "deterministic";
  }
  if (request.safety_criticality === "high" || request.safety_criticality === "critical" || request.invocation_class === "OopsCorrectionReasoning") {
    return "low";
  }
  if (request.invocation_class === "ToolUseReasoning" && budgetClass === "high") {
    return "balanced";
  }
  return request.base_policy?.temperature_class ?? (budgetClass === "high" ? "balanced" : "low");
}

function riskControlsFor(request: ThinkingBudgetRequest, profileName: ThinkingBudgetProfileName, budgetClass: ThinkingBudgetClass): readonly string[] {
  const controls = new Set<string>([
    "disable_hidden_reasoning_output",
    "require_structured_output",
    "preserve_simulation_blindness",
  ]);
  if (actionBearingInvocation(request.invocation_class) || request.validator_gate_required === true) {
    controls.add("deterministic_validator_gate_required");
  }
  if (request.ambiguity === "high" || request.ambiguity === "conflict") {
    controls.add("must_state_uncertainty_and_reobserve_option");
  }
  if (request.safety_criticality === "high" || request.safety_criticality === "critical") {
    controls.add("safe_hold_preferred_over_unsafe_guess");
  }
  if (profileName === "ToolUseReasoning") {
    controls.add("tool_envelope_and_contact_validator_mandatory");
  }
  if (profileName === "FailureDiagnosis") {
    controls.add("retry_budget_is_authoritative");
  }
  if (budgetClass === "minimal" || budgetClass === "low") {
    controls.add("require_verifier_for_manipulation_use");
  }
  return freezeArray([...controls].sort());
}

function validateRequest(request: ThinkingBudgetRequest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateRef(request.request_ref, "$.request_ref", issues);
  if (request.deadline_ms !== undefined && Number.isFinite(request.deadline_ms) === false) {
    issues.push(issue("error", "InvalidDeadline", "$.deadline_ms", "Deadline must be a finite millisecond value.", "Provide a finite positive deadline in milliseconds."));
  } else if (request.deadline_ms !== undefined && request.deadline_ms < MIN_TIMEOUT_MS) {
    issues.push(issue("warning", "VeryShortDeadline", "$.deadline_ms", "Deadline is shorter than the minimum safe model timeout.", "Use deterministic fallback or safe-hold if the model cannot respond in time."));
  }
  if (request.retry_budget_remaining !== undefined && (Number.isFinite(request.retry_budget_remaining) === false || request.retry_budget_remaining < 0)) {
    issues.push(issue("error", "InvalidRetryBudget", "$.retry_budget_remaining", "Retry budget must be a non-negative finite number.", "Clamp retry budget to zero when no retries remain."));
  }
  if (request.evidence_complexity !== undefined) {
    validateComplexity(request.evidence_complexity, issues);
  }
  return issues;
}

function validateComplexity(complexity: ThinkingEvidenceComplexity, issues: ValidationIssue[]): void {
  const fields: readonly (keyof ThinkingEvidenceComplexity)[] = ["evidence_item_count", "distinct_view_count", "contradiction_count", "candidate_action_count"];
  for (const field of fields) {
    const value = complexity[field];
    if (typeof value !== "number" || Number.isFinite(value) === false || value < 0) {
      issues.push(issue("error", "InvalidEvidenceComplexity", `$.evidence_complexity.${field}`, "Evidence complexity counters must be finite non-negative numbers.", "Provide normalized counts from the orchestrator or omit the complexity block."));
    }
  }
}

function urgencyFromQueue(queue: CognitiveQueue, safeHoldRequired: boolean): ThinkingUrgency {
  if (safeHoldRequired || queue === "SafetyImmediate") {
    return "safety_immediate";
  }
  if (queue === "ExecutionPlanning") {
    return "execution_bound";
  }
  if (queue === "MemoryMaintenance" || queue === "OfflineQA") {
    return "background";
  }
  return "routine";
}

function latencyFromQueue(queue: CognitiveQueue): ThinkingLatencyTarget {
  if (queue === "SafetyImmediate") {
    return "realtime";
  }
  if (queue === "ExecutionPlanning" || queue === "Verification") {
    return "interactive";
  }
  return "background";
}

function ambiguityFromPlan(plan: CognitiveInvocationPlan): ThinkingAmbiguity {
  if (plan.invocation_class === "MultiViewDisambiguationReasoning") {
    return "conflict";
  }
  const rejected = plan.rejected_evidence_refs.length;
  const warnings = plan.validation_issues.filter((item) => item.severity === "warning").length;
  if (rejected >= 3 || warnings >= 3) {
    return "high";
  }
  if (rejected > 0 || warnings > 0) {
    return "medium";
  }
  return plan.invocation_class === "SceneObservationReasoning" || plan.invocation_class === "SpatialVerificationReasoning" ? "low" : "none";
}

function safetyFromPlan(plan: CognitiveInvocationPlan): ThinkingSafetyCriticality {
  if (plan.safe_hold_required) {
    return "critical";
  }
  if (plan.invocation_class === "OopsCorrectionReasoning") {
    return "high";
  }
  if (plan.validator_gate_required || plan.invocation_class === "ToolUseReasoning" || plan.invocation_class === "WaypointGenerationReasoning") {
    return "medium";
  }
  return "low";
}

function evidenceComplexityFromPlan(plan: CognitiveInvocationPlan): ThinkingEvidenceComplexity {
  return Object.freeze({
    evidence_item_count: plan.selected_evidence_refs.length + plan.rejected_evidence_refs.length,
    distinct_view_count: plan.required_evidence_kinds.includes("visual") ? Math.min(2, plan.selected_evidence_refs.length) : 0,
    contradiction_count: plan.rejected_evidence_refs.length,
    candidate_action_count: plan.validator_gate_required ? Math.max(1, plan.required_evidence_kinds.length) : 0,
    requires_tool_reasoning: plan.invocation_class === "ToolUseReasoning",
    requires_failure_diagnosis: plan.invocation_class === "OopsCorrectionReasoning",
    requires_multi_step_plan: plan.invocation_class === "TaskPlanningReasoning" || plan.invocation_class === "WaypointGenerationReasoning",
  });
}

function actionBearingInvocation(invocationClass: CognitiveInvocationClass): boolean {
  return invocationClass === "TaskPlanningReasoning"
    || invocationClass === "WaypointGenerationReasoning"
    || invocationClass === "OopsCorrectionReasoning"
    || invocationClass === "ToolUseReasoning"
    || invocationClass === "AudioEventReasoning";
}

function validateRef(ref: Ref, path: string, issues: ValidationIssue[]): void {
  if (ref.trim().length === 0) {
    issues.push(issue("error", "EmptyRef", path, "Reference values may not be empty.", "Provide a stable non-empty request or plan reference."));
  }
  if (/(backend|engine|scene_graph|ground_truth|world_truth|object_id|hidden|simulator)/i.test(ref)) {
    issues.push(issue("error", "UnsafeRef", path, "Reference contains simulator-truth or hidden-state language.", "Use prompt-safe opaque references only."));
  }
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
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

function makeRef(...parts: readonly string[]): Ref {
  const normalized = parts
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "ref:empty";
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}
