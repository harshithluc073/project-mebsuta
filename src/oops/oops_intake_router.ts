/**
 * Oops intake router for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/14_OOPS_LOOP_CORRECTION_ENGINE.md`
 * sections 14.1, 14.3, 14.4, 14.5, 14.6, 14.19.1, 14.20,
 * 14.23, and 14.24.
 *
 * The intake router admits only bounded, embodied, audit-ready correction
 * triggers. It also exports the shared File 14 contracts and deterministic
 * helper functions used by the rest of the Oops Loop batch.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity, Vector3 } from "../simulation/world_manifest";
import type { OopsVerificationHandoff } from "../verification/oops_handoff_router";
import type { TaskSuccessCertificate } from "../verification/task_success_certificate_issuer";

export const OOPS_INTAKE_ROUTER_SCHEMA_VERSION = "mebsuta.oops_intake_router.v1" as const;
export const OOPS_BLUEPRINT_REF = "architecture_docs/14_OOPS_LOOP_CORRECTION_ENGINE.md" as const;

export const OOPS_HIDDEN_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|qa_success|qa_label|qa_only|simulator truth|mesh_name|asset_id|benchmark_truth|oracle_pose|direct_actuator|raw_gemini_actuation|reward|policy_update|value_function)/i;

export type OopsTriggerSource = "verification" | "control" | "manipulation" | "perception" | "acoustic" | "memory" | "safety";
export type OopsTriggerClass = "correctable_failure" | "unsafe_failure" | "ambiguity" | "anomaly" | "contradiction";
export type OopsRouteDecision = "correct" | "reobserve" | "safe_hold" | "human_review" | "reject";
export type OopsSafetyState = "normal" | "cautious" | "restricted" | "safe_hold" | "human_review";
export type OopsEpisodeState = "intake" | "evidence_collection" | "failure_classification" | "cognitive_diagnosis" | "plan_normalization" | "safety_validation" | "feasibility_validation" | "correction_execution" | "verification_bridge" | "reobserve" | "safe_hold" | "human_review" | "complete";
export type OopsFailureFamily = "placement_offset" | "misplacement" | "rotation_error" | "slip_or_drop" | "missed_insertion" | "tool_misalignment" | "wrong_object" | "stability_failure" | "sensor_or_view_gap" | "unsafe_contact" | "unknown";
export type CorrectionIntentKind = "micro_adjust" | "regrasp_and_replace" | "rotate_in_place" | "reposition_body" | "re_aim_tool" | "reobserve_only" | "human_review";
export type OopsIssueCode =
  | "TriggerInvalid"
  | "EvidenceMissing"
  | "RetryBudgetExhausted"
  | "UnsafeTrigger"
  | "HiddenOopsLeak"
  | "PolicyInvalid"
  | "CorrectionUnsupported"
  | "SafetyLimitExceeded"
  | "FeasibilityMissing"
  | "SchemaInvalid";

export interface OopsObjectDescriptor {
  readonly descriptor_ref: Ref;
  readonly label: string;
  readonly object_class: "small_rigid" | "medium_rigid" | "large_rigid" | "deformable" | "fragile" | "tool" | "container";
  readonly confidence: number;
  readonly feature_refs: readonly Ref[];
}

export interface OopsRetryBudget {
  readonly episode_attempts_used: number;
  readonly maximum_episode_attempts: number;
  readonly repair_attempts_used: number;
  readonly maximum_repair_attempts: number;
  readonly reobserve_attempts_used: number;
  readonly maximum_reobserve_attempts: number;
}

export interface OopsSafetyLimits {
  readonly safety_policy_ref: Ref;
  readonly max_translation_m: number;
  readonly max_rotation_rad: number;
  readonly max_force_n: number;
  readonly max_speed_mps: number;
  readonly allow_tool_contact: boolean;
  readonly allow_body_reposition: boolean;
}

export interface OopsTrigger {
  readonly trigger_ref: Ref;
  readonly trigger_source: OopsTriggerSource;
  readonly trigger_class: OopsTriggerClass;
  readonly task_ref: Ref;
  readonly primitive_ref?: Ref;
  readonly affected_object_descriptors: readonly OopsObjectDescriptor[];
  readonly affected_constraint_refs: readonly Ref[];
  readonly evidence_ref_candidates: readonly Ref[];
  readonly initial_route_recommendation: OopsRouteDecision;
  readonly provenance_manifest_ref: Ref;
  readonly verification_handoff?: OopsVerificationHandoff;
  readonly source_certificate?: TaskSuccessCertificate;
}

export interface OopsPolicy {
  readonly policy_ref: Ref;
  readonly retry_budget: OopsRetryBudget;
  readonly safety_limits: OopsSafetyLimits;
  readonly require_visual_evidence: boolean;
  readonly allow_diagnosis_only_for_unsafe: boolean;
  readonly allow_deterministic_fallback: boolean;
}

export interface OopsAttemptRecord {
  readonly attempt_ref: Ref;
  readonly started_at_ms: number;
  readonly ended_at_ms?: number;
  readonly route: OopsRouteDecision;
  readonly artifact_refs: readonly Ref[];
  readonly result_summary: string;
}

export interface OopsEpisode {
  readonly oops_episode_ref: Ref;
  readonly task_ref: Ref;
  readonly source_trigger_ref: Ref;
  readonly source_certificate_ref?: Ref;
  readonly failure_mode_history: readonly OopsFailureFamily[];
  readonly attempt_records: readonly OopsAttemptRecord[];
  readonly current_retry_budget: OopsRetryBudget;
  readonly current_safety_state: OopsSafetyState;
  readonly target_object_descriptor: OopsObjectDescriptor;
  readonly constraint_context_refs: readonly Ref[];
  readonly truth_boundary_status: "runtime_embodied_only" | "blocked_hidden_truth";
  readonly terminal_outcome?: OopsRouteDecision | "complete";
}

export interface OopsAdmissionReport {
  readonly schema_version: typeof OOPS_INTAKE_ROUTER_SCHEMA_VERSION;
  readonly blueprint_ref: typeof OOPS_BLUEPRINT_REF;
  readonly report_ref: Ref;
  readonly trigger_ref: Ref;
  readonly decision: "admitted" | "admitted_for_diagnosis_only" | "reobserve_required" | "safe_hold_required" | "human_review_required" | "rejected";
  readonly route_decision: OopsRouteDecision;
  readonly episode?: OopsEpisode;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "oops_admission_report";
  readonly determinism_hash: string;
}

export interface CorrectionWaypoint {
  readonly waypoint_ref: Ref;
  readonly frame_ref: Ref;
  readonly position_delta_m: Vector3;
  readonly rotation_delta_rad?: Vector3;
  readonly dwell_ms: number;
  readonly evidence_refs: readonly Ref[];
}

export interface CandidateCorrectionPlan {
  readonly plan_ref: Ref;
  readonly oops_episode_ref: Ref;
  readonly correction_intent: CorrectionIntentKind;
  readonly target_object_ref: Ref;
  readonly failed_constraint_refs: readonly Ref[];
  readonly preserved_constraint_refs: readonly Ref[];
  readonly waypoints: readonly CorrectionWaypoint[];
  readonly expected_postcondition_refs: readonly Ref[];
  readonly force_limit_n: number;
  readonly speed_limit_mps: number;
  readonly max_duration_ms: number;
  readonly stop_conditions: readonly string[];
  readonly evidence_refs: readonly Ref[];
}

/**
 * Admits Oops triggers and creates episode records.
 */
export class OopsIntakeRouter {
  /**
   * Applies trigger admission, retry, evidence, safety, and hidden-data rules.
   */
  public admitOopsTrigger(trigger: OopsTrigger, policy: OopsPolicy, currentSafetyState: OopsSafetyState = "normal"): OopsAdmissionReport {
    const issues: ValidationIssue[] = [];
    validateTrigger(trigger, issues);
    validatePolicy(policy, issues);
    const decision = decideAdmission(trigger, policy, currentSafetyState, issues);
    const route = routeForAdmission(decision, trigger);
    const episode = decision === "admitted" || decision === "admitted_for_diagnosis_only" ? buildEpisode(trigger, policy, currentSafetyState, route) : undefined;
    const base = {
      schema_version: OOPS_INTAKE_ROUTER_SCHEMA_VERSION,
      blueprint_ref: OOPS_BLUEPRINT_REF,
      report_ref: makeOopsRef("oops_admission_report", trigger.trigger_ref, decision),
      trigger_ref: cleanOopsRef(trigger.trigger_ref),
      decision,
      route_decision: route,
      episode,
      issues: freezeOopsArray(issues),
      ok: episode !== undefined || decision === "reobserve_required",
      cognitive_visibility: "oops_admission_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function createOopsIntakeRouter(): OopsIntakeRouter {
  return new OopsIntakeRouter();
}

export function validateTrigger(trigger: OopsTrigger, issues: ValidationIssue[]): void {
  validateOopsRef(trigger.trigger_ref, "$.trigger_ref", "HiddenOopsLeak", issues);
  validateOopsRef(trigger.task_ref, "$.task_ref", "HiddenOopsLeak", issues);
  validateOopsRef(trigger.provenance_manifest_ref, "$.provenance_manifest_ref", "HiddenOopsLeak", issues);
  if (trigger.primitive_ref !== undefined) validateOopsRef(trigger.primitive_ref, "$.primitive_ref", "HiddenOopsLeak", issues);
  for (const ref of [...trigger.affected_constraint_refs, ...trigger.evidence_ref_candidates]) validateOopsRef(ref, "$.trigger.refs", "HiddenOopsLeak", issues);
  if (trigger.task_ref.trim().length === 0) {
    issues.push(makeOopsIssue("error", "TriggerInvalid", "$.task_ref", "Oops trigger must reference an active task.", "Attach the active task ref before correction intake."));
  }
  if (trigger.affected_object_descriptors.length === 0) {
    issues.push(makeOopsIssue("error", "TriggerInvalid", "$.affected_object_descriptors", "Oops trigger needs at least one perceived target descriptor.", "Attach the target descriptor from embodied evidence."));
  }
  if (trigger.evidence_ref_candidates.length === 0 && trigger.initial_route_recommendation !== "reobserve") {
    issues.push(makeOopsIssue("warning", "EvidenceMissing", "$.evidence_ref_candidates", "Correction intake has no embodied evidence candidates.", "Collect view, tactile, audio, or telemetry evidence before physical correction."));
  }
  for (const descriptor of trigger.affected_object_descriptors) validateDescriptor(descriptor, issues);
  if (trigger.trigger_class === "unsafe_failure" && trigger.initial_route_recommendation !== "safe_hold") {
    issues.push(makeOopsIssue("warning", "UnsafeTrigger", "$.initial_route_recommendation", "Unsafe triggers should route to SafeHold unless policy allows diagnosis-only handling.", "Use SafeHold for unsafe correction triggers."));
  }
}

export function makeOopsIssue(
  severity: ValidationSeverity,
  code: OopsIssueCode,
  path: string,
  message: string,
  remediation: string,
): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

export function validateOopsRef(value: Ref, path: string, code: OopsIssueCode, issues: ValidationIssue[]): void {
  if (value.trim().length === 0 || /\s/u.test(value)) {
    issues.push(makeOopsIssue("error", code, path, "Reference must be non-empty and whitespace-free.", "Use an opaque runtime ref."));
    return;
  }
  if (OOPS_HIDDEN_PATTERN.test(value)) {
    issues.push(makeOopsIssue("error", "HiddenOopsLeak", path, "Reference contains hidden simulator, QA, or learning-only wording.", "Use embodied evidence refs only."));
  }
}

export function cleanOopsRef(value: Ref): Ref {
  return value.replace(OOPS_HIDDEN_PATTERN, "hidden-detail").trim();
}

export function cleanOopsText(value: string): string {
  return value.replace(OOPS_HIDDEN_PATTERN, "hidden-detail").replace(/\s+/gu, " ").trim();
}

export function makeOopsRef(...parts: readonly string[]): Ref {
  const normalized = parts
    .join(":")
    .toLowerCase()
    .replace(OOPS_HIDDEN_PATTERN, "hidden-detail")
    .replace(/[^a-z0-9_.:-]+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return normalized.length > 0 ? normalized : "ref:empty";
}

export function freezeOopsArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

export function uniqueOopsSorted<T extends string>(values: readonly T[]): readonly T[] {
  return freezeOopsArray([...new Set(values)].sort());
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

export function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function vectorMagnitude(value: Vector3): number {
  return Math.sqrt(value.reduce((sum, component) => sum + component * component, 0));
}

export function meanScore(values: readonly number[]): number {
  const finite = values.filter((value) => Number.isFinite(value)).map(clamp01);
  if (finite.length === 0) return 0;
  return round6(finite.reduce((sum, value) => sum + value, 0) / finite.length);
}

export function maxWaypointTranslation(plan: CandidateCorrectionPlan): number {
  return round6(Math.max(0, ...plan.waypoints.map((waypoint) => vectorMagnitude(waypoint.position_delta_m))));
}

export function maxWaypointRotation(plan: CandidateCorrectionPlan): number {
  return round6(Math.max(0, ...plan.waypoints.map((waypoint) => waypoint.rotation_delta_rad === undefined ? 0 : vectorMagnitude(waypoint.rotation_delta_rad))));
}

function validateDescriptor(descriptor: OopsObjectDescriptor, issues: ValidationIssue[]): void {
  validateOopsRef(descriptor.descriptor_ref, "$.affected_object_descriptors.descriptor_ref", "HiddenOopsLeak", issues);
  for (const ref of descriptor.feature_refs) validateOopsRef(ref, "$.affected_object_descriptors.feature_refs", "HiddenOopsLeak", issues);
  if (descriptor.label.trim().length === 0 || OOPS_HIDDEN_PATTERN.test(descriptor.label)) {
    issues.push(makeOopsIssue("error", "HiddenOopsLeak", "$.affected_object_descriptors.label", "Object label must be perceptual and non-empty.", "Use a visible label."));
  }
  if (!Number.isFinite(descriptor.confidence) || descriptor.confidence < 0 || descriptor.confidence > 1) {
    issues.push(makeOopsIssue("error", "TriggerInvalid", "$.affected_object_descriptors.confidence", "Descriptor confidence must be within [0, 1].", "Normalize descriptor confidence."));
  }
}

function validatePolicy(policy: OopsPolicy, issues: ValidationIssue[]): void {
  validateOopsRef(policy.policy_ref, "$.policy_ref", "HiddenOopsLeak", issues);
  validateOopsRef(policy.safety_limits.safety_policy_ref, "$.safety_limits.safety_policy_ref", "HiddenOopsLeak", issues);
  const retry = policy.retry_budget;
  const retryValues = [retry.episode_attempts_used, retry.maximum_episode_attempts, retry.repair_attempts_used, retry.maximum_repair_attempts, retry.reobserve_attempts_used, retry.maximum_reobserve_attempts];
  if (retryValues.some((value) => !Number.isInteger(value) || value < 0)) {
    issues.push(makeOopsIssue("error", "PolicyInvalid", "$.retry_budget", "Retry budget counters must be nonnegative integers.", "Repair retry budget accounting."));
  }
  const limits = policy.safety_limits;
  const numericLimits = [limits.max_translation_m, limits.max_rotation_rad, limits.max_force_n, limits.max_speed_mps];
  if (numericLimits.some((value) => !Number.isFinite(value) || value <= 0)) {
    issues.push(makeOopsIssue("error", "PolicyInvalid", "$.safety_limits", "Safety limits must be positive finite values.", "Use bounded correction limits."));
  }
}

function decideAdmission(
  trigger: OopsTrigger,
  policy: OopsPolicy,
  safetyState: OopsSafetyState,
  issues: readonly ValidationIssue[],
): OopsAdmissionReport["decision"] {
  if (issues.some((issue) => issue.severity === "error")) return "rejected";
  if (safetyState === "safe_hold" || trigger.trigger_class === "unsafe_failure") {
    return policy.allow_diagnosis_only_for_unsafe ? "admitted_for_diagnosis_only" : "safe_hold_required";
  }
  if (policy.retry_budget.episode_attempts_used >= policy.retry_budget.maximum_episode_attempts) return "human_review_required";
  if (trigger.initial_route_recommendation === "reobserve" || trigger.trigger_class === "ambiguity") return "reobserve_required";
  if (trigger.evidence_ref_candidates.length === 0 && policy.require_visual_evidence) return "reobserve_required";
  return "admitted";
}

function routeForAdmission(decision: OopsAdmissionReport["decision"], trigger: OopsTrigger): OopsRouteDecision {
  if (decision === "admitted") return trigger.initial_route_recommendation === "reject" ? "human_review" : trigger.initial_route_recommendation;
  if (decision === "admitted_for_diagnosis_only" || decision === "safe_hold_required") return "safe_hold";
  if (decision === "reobserve_required") return "reobserve";
  if (decision === "human_review_required") return "human_review";
  return "reject";
}

function buildEpisode(
  trigger: OopsTrigger,
  policy: OopsPolicy,
  safetyState: OopsSafetyState,
  route: OopsRouteDecision,
): OopsEpisode {
  const target = trigger.affected_object_descriptors[0];
  return Object.freeze({
    oops_episode_ref: makeOopsRef("oops_episode", trigger.task_ref, trigger.trigger_ref),
    task_ref: cleanOopsRef(trigger.task_ref),
    source_trigger_ref: cleanOopsRef(trigger.trigger_ref),
    source_certificate_ref: trigger.source_certificate?.certificate_ref ?? trigger.verification_handoff?.source_certificate_ref,
    failure_mode_history: freezeOopsArray([]),
    attempt_records: freezeOopsArray([{
      attempt_ref: makeOopsRef("oops_attempt", trigger.trigger_ref, "intake"),
      started_at_ms: 0,
      route,
      artifact_refs: uniqueOopsSorted([trigger.trigger_ref, trigger.provenance_manifest_ref]),
      result_summary: cleanOopsText(`Trigger admitted from ${trigger.trigger_source} with route ${route}.`),
    }]),
    current_retry_budget: policy.retry_budget,
    current_safety_state: safetyState,
    target_object_descriptor: Object.freeze({
      ...target,
      descriptor_ref: cleanOopsRef(target.descriptor_ref),
      label: cleanOopsText(target.label),
      feature_refs: uniqueOopsSorted(target.feature_refs.map(cleanOopsRef)),
    }),
    constraint_context_refs: uniqueOopsSorted(trigger.affected_constraint_refs.map(cleanOopsRef)),
    truth_boundary_status: "runtime_embodied_only" as const,
  });
}
