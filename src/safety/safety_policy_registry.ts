/**
 * Safety policy registry and shared safety contracts for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/18_SAFETY_GUARDRAILS_VALIDATION_AND_POLICY.md`
 * sections 18.4, 18.5, 18.6, 18.7, 18.13, 18.15, 18.17, 18.18, and 18.21.
 *
 * This module is the shared File 18 contract layer. It resolves active safety
 * policies by deterministic precedence, validates common safety request fields,
 * aggregates validator reports, and exposes immutable helpers used by the
 * provenance, prompt, plan, spatial, embodiment, tool, runtime, and SafeHold
 * components in this batch.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity, Vector3 } from "../simulation/world_manifest";

export const SAFETY_POLICY_REGISTRY_SCHEMA_VERSION = "mebsuta.safety_policy_registry.v1" as const;
export const SAFETY_POLICY_BLUEPRINT_REF = "architecture_docs/18_SAFETY_GUARDRAILS_VALIDATION_AND_POLICY.md" as const;

const FORBIDDEN_SAFETY_TEXT_PATTERN = /(backend|engine|scene[_ -]?graph|world[_ -]?truth|ground[_ -]?truth|hidden[_ -]?state|hidden[_ -]?pose|object[_ -]?id|collision[_ -]?mesh|rigid[_ -]?body|physics[_ -]?body|qa[_ -]?label|qa[_ -]?success|oracle|system prompt|developer prompt|chain[_ -]?of[_ -]?thought|scratchpad|raw prompt|direct actuator|raw actuator|ignore safety|override safety|disable safe[_ -]?hold|skip validation|reinforcement learning|policy gradient|reward policy)/i;

export type SafetyPolicyScope = "global" | "scenario" | "embodiment" | "primitive" | "object" | "tool" | "retry" | "observability" | "emergency";
export type SafetyArtifactType = "prompt" | "plan" | "primitive" | "correction" | "verification" | "memory" | "audio" | "tts" | "tool" | "runtime";
export type TruthBoundaryStatus = "embodied_evidence" | "policy_config" | "memory_advisory" | "validator_output" | "qa_only" | "blocked";
export type SafetyDecisionType = "accepted" | "accepted_with_restrictions" | "reobserve_required" | "repair_required" | "rejected_policy_violation" | "rejected_unsafe" | "human_review_required" | "safe_hold_required";
export type SafetyRoute = "Continue" | "ContinueRestricted" | "Reobserve" | "Repair" | "Reject" | "SafeHold" | "HumanReview";
export type RiskClass = "provenance" | "force" | "speed" | "collision" | "balance" | "occlusion" | "memory" | "audio" | "tool" | "retry" | "prompt" | "workspace" | "contact";
export type RiskSeverity = "low" | "medium" | "high" | "blocking" | "critical";
export type MotionSafetyProfile = "inspection_only" | "gentle_grasp" | "normal_grasp" | "cautious_place" | "micro_correction" | "tool_contact_cautious" | "safe_retreat";
export type RuntimeSafetyEventClass = "force" | "speed" | "contact" | "slip" | "visibility" | "tool" | "balance" | "controller" | "audio";
export type ImmediateSafetyAction = "Continue" | "Slow" | "Pause" | "Abort" | "SafeHold";
export type EmbodimentSafetyKind = "quadruped" | "humanoid" | "generic";
export type RecoveryAction = "Reobserve" | "Retreat" | "Release" | "HumanReview" | "Abort" | "Resume";

export interface NumericLimit {
  readonly min?: number;
  readonly max: number;
  readonly warning?: number;
  readonly unit: string;
}

export interface WorkspaceBounds {
  readonly bounds_ref: Ref;
  readonly min_m: Vector3;
  readonly max_m: Vector3;
}

export interface ToolEnvelopeLimit {
  readonly tool_envelope_ref: Ref;
  readonly max_sweep_radius_m: number;
  readonly max_contact_force_n: number;
  readonly max_leverage_ratio: number;
  readonly require_line_of_sight: boolean;
}

export interface RetryLimits {
  readonly retry_limit_ref: Ref;
  readonly max_attempts: number;
  readonly tighten_after_attempt: number;
  readonly human_review_after_attempt: number;
}

export interface SafetyRestriction {
  readonly restriction_ref: Ref;
  readonly restriction_class: "force" | "speed" | "acceleration" | "workspace" | "tool" | "view" | "retry" | "contact" | "posture";
  readonly description: string;
  readonly numeric_limit?: NumericLimit;
  readonly policy_ref: Ref;
}

export interface SafetyCondition {
  readonly condition_ref: Ref;
  readonly field: string;
  readonly operator: "equals" | "includes" | "exists" | "at_least" | "at_most";
  readonly value: string | number | boolean;
}

export interface SafetyPolicyProfile {
  readonly safety_policy_ref: Ref;
  readonly policy_scope: SafetyPolicyScope;
  readonly precedence: number;
  readonly applicability_conditions: readonly SafetyCondition[];
  readonly force_limits?: readonly NumericLimit[];
  readonly speed_limits?: readonly NumericLimit[];
  readonly acceleration_limits?: readonly NumericLimit[];
  readonly workspace_bounds?: readonly WorkspaceBounds[];
  readonly tool_envelope_limits?: readonly ToolEnvelopeLimit[];
  readonly retry_limits?: RetryLimits;
  readonly sensor_requirements: readonly string[];
  readonly safe_hold_triggers: readonly string[];
  readonly human_review_triggers: readonly string[];
  readonly audit_requirements: readonly string[];
  readonly default_restrictions: readonly SafetyRestriction[];
  readonly determinism_hash: string;
}

export interface SafetyTaskContext {
  readonly task_ref?: Ref;
  readonly scenario_ref?: Ref;
  readonly primitive_ref?: Ref;
  readonly object_refs?: readonly Ref[];
  readonly tool_ref?: Ref;
}

export interface SafetyRiskContext {
  readonly risk_context_ref?: Ref;
  readonly risk_classes: readonly RiskClass[];
  readonly fragile_object_present?: boolean;
  readonly occlusion_present?: boolean;
  readonly audio_only_evidence?: boolean;
  readonly retry_attempt_index?: number;
  readonly prior_failure_refs?: readonly Ref[];
}

export interface SafetyValidationRequest {
  readonly safety_validation_request_ref: Ref;
  readonly artifact_type: SafetyArtifactType;
  readonly artifact_ref: Ref;
  readonly task_ref?: Ref;
  readonly embodiment_profile_ref: Ref;
  readonly policy_refs: readonly Ref[];
  readonly evidence_refs?: readonly Ref[];
  readonly risk_context_refs?: readonly Ref[];
  readonly retry_context_ref?: Ref;
  readonly truth_boundary_status: TruthBoundaryStatus;
  readonly summary: string;
}

export interface SafetyRiskFinding {
  readonly risk_finding_ref: Ref;
  readonly risk_class: RiskClass;
  readonly risk_severity: RiskSeverity;
  readonly risk_description: string;
  readonly evidence_refs: readonly Ref[];
  readonly policy_refs: readonly Ref[];
  readonly recommended_restriction: readonly SafetyRestriction[];
  readonly recommended_route: SafetyRoute;
  readonly determinism_hash: string;
}

export interface SafetyValidationReport {
  readonly safety_validation_report_ref: Ref;
  readonly request_ref: Ref;
  readonly validator_ref: Ref;
  readonly overall_decision: SafetyDecisionType;
  readonly risk_findings: readonly SafetyRiskFinding[];
  readonly restriction_set: readonly SafetyRestriction[];
  readonly rejection_reasons: readonly string[];
  readonly required_additional_evidence: readonly string[];
  readonly safe_alternative_hints: readonly string[];
  readonly audit_refs: readonly Ref[];
  readonly route_recommendation: SafetyRoute;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface ActiveSafetyPolicySet {
  readonly active_policy_set_ref: Ref;
  readonly request_ref: Ref;
  readonly policies: readonly SafetyPolicyProfile[];
  readonly policy_precedence: readonly Ref[];
  readonly force_limits: readonly NumericLimit[];
  readonly speed_limits: readonly NumericLimit[];
  readonly acceleration_limits: readonly NumericLimit[];
  readonly workspace_bounds: readonly WorkspaceBounds[];
  readonly tool_envelope_limits: readonly ToolEnvelopeLimit[];
  readonly retry_limits?: RetryLimits;
  readonly sensor_requirements: readonly string[];
  readonly safe_hold_triggers: readonly string[];
  readonly human_review_triggers: readonly string[];
  readonly audit_requirements: readonly string[];
  readonly default_restrictions: readonly SafetyRestriction[];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface SafetyDecision {
  readonly safety_decision_ref: Ref;
  readonly source_report_refs: readonly Ref[];
  readonly final_route: SafetyRoute;
  readonly restriction_set_refs: readonly Ref[];
  readonly blocked_artifact_refs: readonly Ref[];
  readonly human_readable_reason: string;
  readonly audit_replay_refs: readonly Ref[];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface SafetyRouteDecision {
  readonly safety_route_decision_ref: Ref;
  readonly source_report_refs: readonly Ref[];
  readonly final_route: SafetyRoute;
  readonly restriction_set_refs: readonly Ref[];
  readonly blocked_artifact_refs: readonly Ref[];
  readonly human_readable_reason: string;
  readonly audit_replay_refs: readonly Ref[];
  readonly determinism_hash: string;
}

export interface RuntimeSafetyEvent {
  readonly runtime_safety_event_ref: Ref;
  readonly execution_handle_ref: Ref;
  readonly event_class: RuntimeSafetyEventClass;
  readonly event_severity: Exclude<RiskSeverity, "blocking">;
  readonly measured_signal_summary: string;
  readonly threshold_ref: Ref;
  readonly immediate_action: ImmediateSafetyAction;
  readonly evidence_refs: readonly Ref[];
  readonly determinism_hash: string;
}

export interface SafeHoldState {
  readonly safe_hold_ref: Ref;
  readonly entry_trigger_ref: Ref;
  readonly entry_time_ms: number;
  readonly active_task_ref?: Ref;
  readonly body_state_summary: string;
  readonly risk_summary: string;
  readonly blocked_action_refs: readonly Ref[];
  readonly required_evidence_refs: readonly Ref[];
  readonly allowed_recovery_actions: readonly RecoveryAction[];
  readonly exit_conditions: readonly string[];
  readonly memory_write_policy: "deny_verified_spatial_writes" | "allow_audit_note_only";
  readonly tts_announcement_ref?: Ref;
  readonly determinism_hash: string;
}

/**
 * Resolves active safety policies for an artifact under a task and risk context.
 */
export class SafetyPolicyRegistry {
  private readonly policies = new Map<Ref, SafetyPolicyProfile>();

  public registerSafetyPolicy(policy: Omit<SafetyPolicyProfile, "determinism_hash">): SafetyPolicyProfile {
    const issues: ValidationIssue[] = [];
    validateRef(policy.safety_policy_ref, "$.safety_policy_ref", issues);
    for (const [index, condition] of policy.applicability_conditions.entries()) {
      validateRef(condition.condition_ref, `$.applicability_conditions[${index}].condition_ref`, issues);
      validateSafeText(condition.field, `$.applicability_conditions[${index}].field`, true, issues);
    }
    for (const [index, restriction] of policy.default_restrictions.entries()) {
      validateRestriction(restriction, `$.default_restrictions[${index}]`, issues);
    }
    if (issues.some((issue) => issue.severity === "error")) {
      throw new SafetyPolicyRegistryError("Safety policy profile failed validation.", issues);
    }
    const normalized = normalizePolicyProfile(policy);
    this.policies.set(normalized.safety_policy_ref, normalized);
    return normalized;
  }

  public getPolicy(policyRef: Ref): SafetyPolicyProfile | undefined {
    return this.policies.get(policyRef);
  }

  public listPolicies(): readonly SafetyPolicyProfile[] {
    const ordered = [...this.policies.values()];
    ordered.sort(policySort);
    return freezeArray(ordered);
  }

  public resolveSafetyPolicies(
    request: SafetyValidationRequest,
    taskContext: SafetyTaskContext,
    riskContext: SafetyRiskContext,
  ): ActiveSafetyPolicySet {
    const issues = validateSafetyValidationRequest(request);
    const candidates = [...this.policies.values()].filter((policy) => policyApplies(policy, request, taskContext, riskContext));
    const requested = request.policy_refs
      .map((ref) => this.policies.get(ref))
      .filter((policy): policy is SafetyPolicyProfile => policy !== undefined);
    const active = [...uniquePolicies([...candidates, ...requested])];
    active.sort(policySort);
    if (!active.some((policy) => policy.policy_scope === "global")) {
      issues.push(makeIssue("warning", "GlobalPolicyMissing", "$.policies", "No global safety policy is active for this request.", "Register a global policy before execution admission."));
    }
    return buildActivePolicySet(request.safety_validation_request_ref, active, issues);
  }
}

export class SafetyPolicyRegistryError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "SafetyPolicyRegistryError";
    this.issues = freezeArray(issues);
  }
}

export function createDefaultSafetyPolicyRegistry(): SafetyPolicyRegistry {
  const registry = new SafetyPolicyRegistry();
  for (const policy of defaultPolicyProfiles()) {
    registry.registerSafetyPolicy(policy);
  }
  return registry;
}

export function aggregateSafetyReports(reportSet: readonly SafetyValidationReport[], policyPrecedence: readonly Ref[]): SafetyDecision {
  const issues = freezeArray(reportSet.flatMap((report) => report.issues));
  const sorted = [...reportSet].sort((left, right) =>
    decisionRank(right.overall_decision) - decisionRank(left.overall_decision)
    || policyIndex(left.validator_ref, policyPrecedence) - policyIndex(right.validator_ref, policyPrecedence)
    || left.safety_validation_report_ref.localeCompare(right.safety_validation_report_ref),
  );
  const dominant = sorted[0];
  const finalRoute = dominant === undefined ? "Reject" : dominant.route_recommendation;
  const restrictions = uniqueRefs(reportSet.flatMap((report) => report.restriction_set.map((restriction) => restriction.restriction_ref)));
  const blocked = uniqueRefs(reportSet.filter((report) => isBlockingDecision(report.overall_decision)).map((report) => report.request_ref));
  const audit = uniqueRefs(reportSet.flatMap((report) => [report.safety_validation_report_ref, ...report.audit_refs]));
  const base = {
    safety_decision_ref: makeSafetyRef("safety_decision", finalRoute, computeDeterminismHash(reportSet)),
    source_report_refs: uniqueRefs(reportSet.map((report) => report.safety_validation_report_ref)),
    final_route: finalRoute,
    restriction_set_refs: restrictions,
    blocked_artifact_refs: blocked,
    human_readable_reason: compactSafetyText(buildDecisionReason(finalRoute, sorted)),
    audit_replay_refs: audit,
    issues,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function buildValidationReport(input: {
  readonly request_ref: Ref;
  readonly validator_ref: Ref;
  readonly overall_decision: SafetyDecisionType;
  readonly risk_findings: readonly SafetyRiskFinding[];
  readonly restriction_set?: readonly SafetyRestriction[];
  readonly rejection_reasons?: readonly string[];
  readonly required_additional_evidence?: readonly string[];
  readonly safe_alternative_hints?: readonly string[];
  readonly audit_refs?: readonly Ref[];
  readonly issues?: readonly ValidationIssue[];
}): SafetyValidationReport {
  const route = routeForDecision(input.overall_decision);
  const base = {
    safety_validation_report_ref: makeSafetyRef("safety_validation_report", input.validator_ref, input.request_ref, input.overall_decision),
    request_ref: input.request_ref,
    validator_ref: input.validator_ref,
    overall_decision: input.overall_decision,
    risk_findings: freezeArray(input.risk_findings),
    restriction_set: freezeArray(input.restriction_set ?? []),
    rejection_reasons: freezeArray((input.rejection_reasons ?? []).map(compactSafetyText)),
    required_additional_evidence: freezeArray((input.required_additional_evidence ?? []).map(compactSafetyText)),
    safe_alternative_hints: freezeArray((input.safe_alternative_hints ?? []).map(compactSafetyText)),
    audit_refs: uniqueRefs(input.audit_refs ?? []),
    route_recommendation: route,
    issues: freezeArray(input.issues ?? []),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function buildRiskFinding(input: Omit<SafetyRiskFinding, "determinism_hash">): SafetyRiskFinding {
  const base = {
    ...input,
    risk_description: compactSafetyText(input.risk_description),
    evidence_refs: uniqueRefs(input.evidence_refs),
    policy_refs: uniqueRefs(input.policy_refs),
    recommended_restriction: freezeArray(input.recommended_restriction),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function routeForDecision(decision: SafetyDecisionType): SafetyRoute {
  switch (decision) {
    case "accepted":
      return "Continue";
    case "accepted_with_restrictions":
      return "ContinueRestricted";
    case "reobserve_required":
      return "Reobserve";
    case "repair_required":
      return "Repair";
    case "rejected_policy_violation":
      return "Reject";
    case "rejected_unsafe":
      return "SafeHold";
    case "human_review_required":
      return "HumanReview";
    case "safe_hold_required":
      return "SafeHold";
  }
}

export function decisionRank(decision: SafetyDecisionType): number {
  switch (decision) {
    case "safe_hold_required":
      return 8;
    case "human_review_required":
      return 7;
    case "rejected_unsafe":
      return 6;
    case "rejected_policy_violation":
      return 5;
    case "repair_required":
      return 4;
    case "reobserve_required":
      return 3;
    case "accepted_with_restrictions":
      return 2;
    case "accepted":
      return 1;
  }
}

export function riskSeverityRank(severity: RiskSeverity): number {
  switch (severity) {
    case "critical":
      return 5;
    case "blocking":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
  }
}

export function containsForbiddenSafetyText(value: string): boolean {
  return FORBIDDEN_SAFETY_TEXT_PATTERN.test(value);
}

export function compactSafetyText(value: string, maxChars = 900): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return containsForbiddenSafetyText(compact)
    ? compact.replace(FORBIDDEN_SAFETY_TEXT_PATTERN, "[redacted_safety_content]").slice(0, maxChars)
    : compact.slice(0, maxChars);
}

export function validateSafetyValidationRequest(request: SafetyValidationRequest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateRef(request.safety_validation_request_ref, "$.safety_validation_request_ref", issues);
  validateRef(request.artifact_ref, "$.artifact_ref", issues);
  validateRef(request.embodiment_profile_ref, "$.embodiment_profile_ref", issues);
  validateOptionalRef(request.task_ref, "$.task_ref", issues);
  validateSafeText(request.summary, "$.summary", true, issues);
  for (const [index, ref] of request.policy_refs.entries()) {
    validateRef(ref, `$.policy_refs[${index}]`, issues);
  }
  for (const [index, ref] of (request.evidence_refs ?? []).entries()) {
    validateRef(ref, `$.evidence_refs[${index}]`, issues);
  }
  for (const [index, ref] of (request.risk_context_refs ?? []).entries()) {
    validateRef(ref, `$.risk_context_refs[${index}]`, issues);
  }
  validateOptionalRef(request.retry_context_ref, "$.retry_context_ref", issues);
  if (request.truth_boundary_status === "qa_only" || request.truth_boundary_status === "blocked") {
    issues.push(makeIssue("error", "TruthBoundaryRejected", "$.truth_boundary_status", "Safety validation cannot admit QA-only or blocked provenance.", "Use embodied evidence, policy config, validator output, or memory advisory labels."));
  }
  return issues;
}

export function validateRef(ref: Ref | undefined, path: string, issues: ValidationIssue[]): void {
  if (ref === undefined || ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(makeIssue("error", "SafetyReferenceInvalid", path, "Reference must be present, non-empty, and whitespace-free.", "Use a stable opaque safety reference."));
    return;
  }
  if (containsForbiddenSafetyText(ref)) {
    issues.push(makeIssue("error", "SafetyReferenceForbidden", path, "Reference contains restricted safety-boundary wording.", "Use an opaque reference without hidden runtime details."));
  }
}

export function validateOptionalRef(ref: Ref | undefined, path: string, issues: ValidationIssue[]): void {
  if (ref !== undefined) {
    validateRef(ref, path, issues);
  }
}

export function validateSafeText(value: string, path: string, required: boolean, issues: ValidationIssue[]): void {
  if (required && value.trim().length === 0) {
    issues.push(makeIssue("error", "SafetyTextRequired", path, "Safety text is required.", "Provide concise public safety text."));
  }
  if (containsForbiddenSafetyText(value)) {
    issues.push(makeIssue("error", "SafetyTextForbidden", path, "Safety text contains restricted truth, prompt, or control wording.", "Use embodied evidence, policy, telemetry, or validator summaries."));
  }
}

export function validateFiniteNumber(value: number, path: string, min: number, max: number | undefined, issues: ValidationIssue[]): void {
  if (!Number.isFinite(value) || value < min || (max !== undefined && value > max)) {
    issues.push(makeIssue("error", "SafetyNumberInvalid", path, "Numeric safety value is outside the allowed finite range.", "Clamp or recompute the safety value before validation."));
  }
}

export function validateVector3(value: Vector3, path: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(value) || value.length !== 3 || value.some((component) => !Number.isFinite(component))) {
    issues.push(makeIssue("error", "SafetyVectorInvalid", path, "Vector3 must contain exactly three finite values.", "Use canonical [x, y, z] meters."));
  }
}

export function makeSafetyRef(...parts: readonly (string | number | undefined)[]): Ref {
  const normalized = parts
    .filter((part): part is string | number => part !== undefined)
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "safety:empty";
}

export function makeIssue(severity: ValidationSeverity, code: string, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

export function uniqueRefs(items: readonly (Ref | undefined)[]): readonly Ref[] {
  return freezeArray([...new Set(items.filter((item): item is Ref => item !== undefined && item.trim().length > 0))]);
}

export function uniqueStrings(items: readonly string[]): readonly string[] {
  return freezeArray([...new Set(items.filter((item) => item.trim().length > 0))]);
}

export function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

export function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function normalizePolicyProfile(policy: Omit<SafetyPolicyProfile, "determinism_hash">): SafetyPolicyProfile {
  const base = {
    ...policy,
    applicability_conditions: freezeArray(policy.applicability_conditions),
    force_limits: freezeArray(policy.force_limits ?? []),
    speed_limits: freezeArray(policy.speed_limits ?? []),
    acceleration_limits: freezeArray(policy.acceleration_limits ?? []),
    workspace_bounds: freezeArray(policy.workspace_bounds ?? []),
    tool_envelope_limits: freezeArray(policy.tool_envelope_limits ?? []),
    sensor_requirements: uniqueStrings(policy.sensor_requirements),
    safe_hold_triggers: uniqueStrings(policy.safe_hold_triggers),
    human_review_triggers: uniqueStrings(policy.human_review_triggers),
    audit_requirements: uniqueStrings(policy.audit_requirements),
    default_restrictions: freezeArray(policy.default_restrictions),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function policyApplies(policy: SafetyPolicyProfile, request: SafetyValidationRequest, task: SafetyTaskContext, risk: SafetyRiskContext): boolean {
  if (policy.applicability_conditions.length === 0) {
    return policy.policy_scope === "global" || policy.policy_scope === "emergency";
  }
  return policy.applicability_conditions.every((condition) => conditionMatches(condition, request, task, risk));
}

function conditionMatches(condition: SafetyCondition, request: SafetyValidationRequest, task: SafetyTaskContext, risk: SafetyRiskContext): boolean {
  const value = conditionValue(condition.field, request, task, risk);
  if (condition.operator === "exists") {
    return value !== undefined && value !== false;
  }
  if (condition.operator === "equals") {
    return value === condition.value;
  }
  if (condition.operator === "includes") {
    return Array.isArray(value) && value.includes(condition.value);
  }
  if (typeof value !== "number" || typeof condition.value !== "number") {
    return false;
  }
  return condition.operator === "at_least" ? value >= condition.value : value <= condition.value;
}

function conditionValue(field: string, request: SafetyValidationRequest, task: SafetyTaskContext, risk: SafetyRiskContext): string | number | boolean | readonly string[] | readonly RiskClass[] | undefined {
  switch (field) {
    case "artifact_type":
      return request.artifact_type;
    case "truth_boundary_status":
      return request.truth_boundary_status;
    case "scenario_ref":
      return task.scenario_ref;
    case "primitive_ref":
      return task.primitive_ref;
    case "tool_ref":
      return task.tool_ref;
    case "risk_classes":
      return risk.risk_classes;
    case "fragile_object_present":
      return risk.fragile_object_present;
    case "occlusion_present":
      return risk.occlusion_present;
    case "audio_only_evidence":
      return risk.audio_only_evidence;
    case "retry_attempt_index":
      return risk.retry_attempt_index;
    default:
      return undefined;
  }
}

function buildActivePolicySet(requestRef: Ref, policies: readonly SafetyPolicyProfile[], issues: readonly ValidationIssue[]): ActiveSafetyPolicySet {
  const retryPolicy = policies.map((policy) => policy.retry_limits).find((limits): limits is RetryLimits => limits !== undefined);
  const base = {
    active_policy_set_ref: makeSafetyRef("active_safety_policy_set", requestRef, computeDeterminismHash(policies.map((policy) => policy.safety_policy_ref))),
    request_ref: requestRef,
    policies: freezeArray(policies),
    policy_precedence: freezeArray(policies.map((policy) => policy.safety_policy_ref)),
    force_limits: freezeArray(policies.flatMap((policy) => policy.force_limits ?? [])),
    speed_limits: freezeArray(policies.flatMap((policy) => policy.speed_limits ?? [])),
    acceleration_limits: freezeArray(policies.flatMap((policy) => policy.acceleration_limits ?? [])),
    workspace_bounds: freezeArray(policies.flatMap((policy) => policy.workspace_bounds ?? [])),
    tool_envelope_limits: freezeArray(policies.flatMap((policy) => policy.tool_envelope_limits ?? [])),
    retry_limits: retryPolicy,
    sensor_requirements: uniqueStrings(policies.flatMap((policy) => policy.sensor_requirements)),
    safe_hold_triggers: uniqueStrings(policies.flatMap((policy) => policy.safe_hold_triggers)),
    human_review_triggers: uniqueStrings(policies.flatMap((policy) => policy.human_review_triggers)),
    audit_requirements: uniqueStrings(policies.flatMap((policy) => policy.audit_requirements)),
    default_restrictions: freezeArray(policies.flatMap((policy) => policy.default_restrictions)),
    issues: freezeArray(issues),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function policySort(left: SafetyPolicyProfile, right: SafetyPolicyProfile): number {
  return left.precedence - right.precedence || left.safety_policy_ref.localeCompare(right.safety_policy_ref);
}

function uniquePolicies(policies: readonly SafetyPolicyProfile[]): readonly SafetyPolicyProfile[] {
  return freezeArray([...new Map(policies.map((policy) => [policy.safety_policy_ref, policy])).values()]);
}

function validateRestriction(restriction: SafetyRestriction, path: string, issues: ValidationIssue[]): void {
  validateRef(restriction.restriction_ref, `${path}.restriction_ref`, issues);
  validateRef(restriction.policy_ref, `${path}.policy_ref`, issues);
  validateSafeText(restriction.description, `${path}.description`, true, issues);
  if (restriction.numeric_limit !== undefined) {
    validateFiniteNumber(restriction.numeric_limit.max, `${path}.numeric_limit.max`, 0, undefined, issues);
    if (restriction.numeric_limit.min !== undefined) {
      validateFiniteNumber(restriction.numeric_limit.min, `${path}.numeric_limit.min`, 0, restriction.numeric_limit.max, issues);
    }
  }
}

function isBlockingDecision(decision: SafetyDecisionType): boolean {
  return decision === "rejected_policy_violation" || decision === "rejected_unsafe" || decision === "human_review_required" || decision === "safe_hold_required";
}

function policyIndex(ref: Ref, precedence: readonly Ref[]): number {
  const index = precedence.indexOf(ref);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function buildDecisionReason(route: SafetyRoute, reports: readonly SafetyValidationReport[]): string {
  const dominant = reports[0];
  if (dominant === undefined) {
    return "No safety reports were provided; reject by default.";
  }
  const topRisk = dominant.risk_findings[0];
  const reason = topRisk?.risk_description ?? dominant.rejection_reasons[0] ?? dominant.safe_alternative_hints[0] ?? dominant.overall_decision;
  return `Safety route ${route}: ${reason}`;
}

function defaultPolicyProfiles(): readonly Omit<SafetyPolicyProfile, "determinism_hash">[] {
  const globalRef = "safety_policy:global:simulation_blind";
  const emergencyRef = "safety_policy:emergency:safe_hold";
  const toolRef = "safety_policy:tool:conservative_sweep";
  return freezeArray([
    {
      safety_policy_ref: emergencyRef,
      policy_scope: "emergency",
      precedence: 1,
      applicability_conditions: freezeArray([]),
      force_limits: freezeArray([{ max: 20, warning: 12, unit: "N" }]),
      speed_limits: freezeArray([{ max: 0.25, warning: 0.15, unit: "mps" }]),
      acceleration_limits: freezeArray([{ max: 0.6, warning: 0.35, unit: "mps2" }]),
      workspace_bounds: freezeArray([]),
      tool_envelope_limits: freezeArray([]),
      sensor_requirements: freezeArray(["active_monitoring_available"]),
      safe_hold_triggers: freezeArray(["critical_risk", "operator_stop", "hidden_truth_leak", "sensor_blackout"]),
      human_review_triggers: freezeArray(["safe_hold_exit_unavailable"]),
      audit_requirements: freezeArray(["safety_validation_report", "runtime_safety_event", "safe_hold_state"]),
      default_restrictions: freezeArray([{
        restriction_ref: makeSafetyRef("restriction", emergencyRef, "zero_velocity"),
        restriction_class: "speed",
        description: "Stop new motion and command zero velocity before recovery.",
        numeric_limit: { max: 0, unit: "mps" },
        policy_ref: emergencyRef,
      }]),
    },
    {
      safety_policy_ref: globalRef,
      policy_scope: "global",
      precedence: 2,
      applicability_conditions: freezeArray([]),
      force_limits: freezeArray([{ max: 35, warning: 20, unit: "N" }]),
      speed_limits: freezeArray([{ max: 0.8, warning: 0.45, unit: "mps" }]),
      acceleration_limits: freezeArray([{ max: 1.5, warning: 0.9, unit: "mps2" }]),
      workspace_bounds: freezeArray([]),
      tool_envelope_limits: freezeArray([]),
      retry_limits: { retry_limit_ref: "retry_limit:global", max_attempts: 3, tighten_after_attempt: 1, human_review_after_attempt: 3 },
      sensor_requirements: freezeArray(["embodied_evidence", "validator_output"]),
      safe_hold_triggers: freezeArray(["force_exceeded", "hidden_truth_leak", "unsafe_verification_failure"]),
      human_review_triggers: freezeArray(["repeated_failure", "validator_disagreement"]),
      audit_requirements: freezeArray(["policy_ref", "evidence_refs", "validator_report"]),
      default_restrictions: freezeArray([{
        restriction_ref: makeSafetyRef("restriction", globalRef, "no_hidden_truth"),
        restriction_class: "view",
        description: "Reject hidden simulator truth and require embodied evidence.",
        policy_ref: globalRef,
      }]),
    },
    {
      safety_policy_ref: toolRef,
      policy_scope: "tool",
      precedence: 6,
      applicability_conditions: freezeArray([{ condition_ref: "condition:tool_exists", field: "tool_ref", operator: "exists", value: true }]),
      tool_envelope_limits: freezeArray([{ tool_envelope_ref: "tool_envelope:default", max_sweep_radius_m: 0.55, max_contact_force_n: 12, max_leverage_ratio: 1.8, require_line_of_sight: true }]),
      sensor_requirements: freezeArray(["tool_identity_confirmed", "sweep_path_visible"]),
      safe_hold_triggers: freezeArray(["tool_collision", "tool_slip_high"]),
      human_review_triggers: freezeArray(["tool_risk_unbounded"]),
      audit_requirements: freezeArray(["tool_safety_report"]),
      default_restrictions: freezeArray([{
        restriction_ref: makeSafetyRef("restriction", toolRef, "cautious_tool_contact"),
        restriction_class: "tool",
        description: "Use cautious tool contact profile with visible sweep path.",
        numeric_limit: { max: 12, unit: "N" },
        policy_ref: toolRef,
      }]),
    },
  ]);
}

export const SAFETY_POLICY_REGISTRY_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: SAFETY_POLICY_REGISTRY_SCHEMA_VERSION,
  blueprint: SAFETY_POLICY_BLUEPRINT_REF,
  sections: freezeArray(["18.4", "18.5", "18.6", "18.7", "18.13", "18.15", "18.17", "18.18", "18.21"]),
  component: "SafetyPolicyRegistry",
});
