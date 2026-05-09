/**
 * Verification policy registry for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md`
 * sections 13.2, 13.4, 13.5, 13.6, 13.8, 13.10, 13.12, 13.13,
 * 13.16, 13.17, and 13.18.
 *
 * This file owns the common File 13 contracts used by the verification batch.
 * It resolves task constraints, embodied view requirements, numeric
 * tolerances, retry budgets, memory gates, and truth-boundary rules from
 * task-visible metadata only.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity, Vector3 } from "../simulation/world_manifest";
import type { CanonicalViewName } from "../perception/view_name_registry";
import type { ManipulationVerificationPacket } from "../manipulation/manipulation_verification_bridge";

export const VERIFICATION_POLICY_REGISTRY_SCHEMA_VERSION = "mebsuta.verification_policy_registry.v1" as const;

export const HIDDEN_VERIFICATION_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|qa_success|qa_label|qa_only|simulator truth|mesh_name|asset_id|benchmark_truth|oracle_pose|direct_actuator|raw_gemini_actuation)/i;

export type VerificationTaskClass = "collect" | "arrange" | "stack" | "insert" | "retrieve" | "tool_assisted_reach" | "inspect";
export type VerificationConstraintClass = "position" | "orientation" | "containment" | "support" | "stability" | "contact" | "identity" | "tool_effect";
export type VerificationEvidenceStrength = "strong" | "moderate" | "weak" | "missing";
export type VerificationCriterionStatus = "satisfied" | "failed" | "ambiguous" | "cannot_assess";
export type VerificationRouteDecision = "complete" | "reobserve" | "correct" | "safe_hold" | "human_review" | "memory_only";
export type EvidenceProvenanceClass = "embodied_sensor" | "derived_embodied_estimate" | "controller_telemetry" | "policy_config" | "qa_truth";
export type TruthBoundaryStatus = "runtime_embodied_only" | "contains_forbidden_truth" | "qa_boundary";
export type VerificationGuardLevel = "normal" | "strict" | "fragile" | "tool_use" | "container" | "stacking";
export type VerificationPolicyDecision = "resolved" | "resolved_with_warnings" | "rejected";
export type VerificationPolicyIssueCode =
  | "ConstraintMissing"
  | "ViewPolicyMissing"
  | "ToleranceInvalid"
  | "RetryBudgetInvalid"
  | "TruthBoundaryInvalid"
  | "HiddenVerificationLeak"
  | "MemoryPolicyInvalid";

export interface TargetObjectDescriptor {
  readonly descriptor_ref: Ref;
  readonly label: string;
  readonly object_class: "small_rigid" | "medium_rigid" | "large_rigid" | "deformable" | "fragile" | "tool" | "container";
  readonly identity_confidence: number;
  readonly perceived_feature_refs: readonly Ref[];
}

export interface ControllerCompletionSummary {
  readonly completion_ref: Ref;
  readonly trajectory_state: "completed" | "completed_with_warnings" | "interrupted" | "timed_out" | "aborted";
  readonly telemetry_refs: readonly Ref[];
  readonly max_position_residual_m?: number;
  readonly max_orientation_residual_rad?: number;
  readonly anomaly_refs: readonly Ref[];
  readonly high_force_contact: boolean;
}

export interface VerificationRetryContext {
  readonly attempts_used: number;
  readonly ambiguity_attempts_used: number;
  readonly correction_attempts_used: number;
  readonly maximum_attempts: number;
}

export interface TruthBoundaryRecord {
  readonly status: TruthBoundaryStatus;
  readonly evidence_provenance: readonly EvidenceProvenanceClass[];
  readonly audit_refs: readonly Ref[];
  readonly summary: string;
}

export interface VerificationConstraintRequirement {
  readonly constraint_ref: Ref;
  readonly constraint_class: VerificationConstraintClass;
  readonly subject_ref: Ref;
  readonly reference_ref?: Ref;
  readonly required: boolean;
  readonly expected_relation?: string;
  readonly minimum_evidence_strength: VerificationEvidenceStrength;
  readonly evidence_refs: readonly Ref[];
}

export interface VerificationTolerancePolicy {
  readonly position_tolerance_m: number;
  readonly orientation_tolerance_rad: number;
  readonly stability_motion_tolerance_m: number;
  readonly contact_tolerance_m: number;
  readonly maximum_uncertainty_ratio: number;
}

export interface VerificationViewRequirement {
  readonly requirement_ref: Ref;
  readonly constraint_class: VerificationConstraintClass;
  readonly required_views: readonly CanonicalViewName[];
  readonly optional_views: readonly CanonicalViewName[];
  readonly requires_depth: boolean;
  readonly requires_settle_window: boolean;
  readonly allowed_body_adjustments: readonly string[];
}

export interface VerificationMemoryPolicy {
  readonly policy_ref: Ref;
  readonly minimum_certificate_confidence: number;
  readonly maximum_pose_uncertainty_m: number;
  readonly require_success_certificate: boolean;
  readonly allow_summary_on_ambiguity: boolean;
}

export interface VerificationPolicy {
  readonly policy_ref: Ref;
  readonly task_class: VerificationTaskClass;
  readonly required_constraints: readonly VerificationConstraintRequirement[];
  readonly view_requirements: readonly VerificationViewRequirement[];
  readonly tolerance_policy: VerificationTolerancePolicy;
  readonly settle_window_duration_ms: number;
  readonly maximum_verification_latency_ms: number;
  readonly ambiguity_retry_budget: number;
  readonly correction_retry_budget: number;
  readonly false_positive_guard_level: VerificationGuardLevel;
  readonly memory_policy: VerificationMemoryPolicy;
}

export interface VerificationRequest {
  readonly verification_request_ref: Ref;
  readonly task_ref: Ref;
  readonly primitive_ref: Ref;
  readonly embodiment_profile_ref: Ref;
  readonly task_class: VerificationTaskClass;
  readonly target_object_descriptor: TargetObjectDescriptor;
  readonly target_constraints: readonly VerificationConstraintRequirement[];
  readonly expected_postcondition_refs: readonly Ref[];
  readonly available_sensor_refs: readonly Ref[];
  readonly controller_completion_summary: ControllerCompletionSummary;
  readonly retry_context: VerificationRetryContext;
  readonly truth_boundary_status: TruthBoundaryRecord;
  readonly safety_policy_ref: Ref;
  readonly memory_policy_ref: Ref;
  readonly manipulation_packet?: ManipulationVerificationPacket;
}

export interface VerificationPolicyRegistryReport {
  readonly schema_version: typeof VERIFICATION_POLICY_REGISTRY_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md";
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly decision: VerificationPolicyDecision;
  readonly policy?: VerificationPolicy;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "verification_policy_registry_report";
  readonly determinism_hash: string;
}

/**
 * Resolves a deterministic File 13 policy for one verification request.
 */
export class VerificationPolicyRegistry {
  /**
   * Produces constraint, tolerance, view, retry, and memory rules.
   */
  public resolveVerificationPolicy(request: VerificationRequest): VerificationPolicyRegistryReport {
    const issues: ValidationIssue[] = [];
    validateVerificationRequest(request, issues);
    const constraints = normalizeConstraints(request, issues);
    const tolerance = toleranceFor(request.task_class, request.target_object_descriptor.object_class, issues);
    const viewRequirements = buildViewRequirements(request.task_class, constraints);
    const memoryPolicy = buildMemoryPolicy(request);
    const decision: VerificationPolicyDecision = issues.some((issue) => issue.severity === "error") ? "rejected" : issues.length > 0 ? "resolved_with_warnings" : "resolved";
    const policy = decision === "rejected" ? undefined : Object.freeze({
      policy_ref: makeRef("verification_policy", request.task_class, request.target_object_descriptor.object_class, request.memory_policy_ref),
      task_class: request.task_class,
      required_constraints: freezeArray(constraints),
      view_requirements: viewRequirements,
      tolerance_policy: tolerance,
      settle_window_duration_ms: settleWindowFor(request.task_class),
      maximum_verification_latency_ms: request.task_class === "tool_assisted_reach" ? 4500 : 3200,
      ambiguity_retry_budget: Math.max(0, request.retry_context.maximum_attempts - request.retry_context.ambiguity_attempts_used),
      correction_retry_budget: Math.max(0, request.retry_context.maximum_attempts - request.retry_context.correction_attempts_used),
      false_positive_guard_level: guardLevelFor(request.task_class, constraints, request.target_object_descriptor.object_class),
      memory_policy: memoryPolicy,
    } satisfies VerificationPolicy);
    const base = {
      schema_version: VERIFICATION_POLICY_REGISTRY_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md" as const,
      report_ref: makeRef("verification_policy_report", request.verification_request_ref, decision),
      request_ref: sanitizeRef(request.verification_request_ref),
      decision,
      policy,
      issues: freezeArray(issues),
      ok: policy !== undefined && decision !== "rejected",
      cognitive_visibility: "verification_policy_registry_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function createVerificationPolicyRegistry(): VerificationPolicyRegistry {
  return new VerificationPolicyRegistry();
}

export function validateVerificationRequest(request: VerificationRequest, issues: ValidationIssue[]): void {
  validateSafeRef(request.verification_request_ref, "$.verification_request_ref", "HiddenVerificationLeak", issues);
  validateSafeRef(request.task_ref, "$.task_ref", "HiddenVerificationLeak", issues);
  validateSafeRef(request.primitive_ref, "$.primitive_ref", "HiddenVerificationLeak", issues);
  validateSafeRef(request.embodiment_profile_ref, "$.embodiment_profile_ref", "HiddenVerificationLeak", issues);
  validateSafeRef(request.memory_policy_ref, "$.memory_policy_ref", "HiddenVerificationLeak", issues);
  validateSafeRef(request.safety_policy_ref, "$.safety_policy_ref", "HiddenVerificationLeak", issues);
  validateDescriptor(request.target_object_descriptor, issues);
  validateControllerSummary(request.controller_completion_summary, issues);
  validateRetry(request.retry_context, issues);
  validateTruthBoundary(request.truth_boundary_status, issues);
  for (const ref of request.available_sensor_refs) validateSafeRef(ref, "$.available_sensor_refs", "HiddenVerificationLeak", issues);
  for (const ref of request.expected_postcondition_refs) validateSafeRef(ref, "$.expected_postcondition_refs", "HiddenVerificationLeak", issues);
  if (request.target_constraints.length === 0) {
    issues.push(makeIssue("error", "ConstraintMissing", "$.target_constraints", "Verification requires at least one task-visible constraint.", "Attach spatial, contact, identity, or tool-effect requirements."));
  }
  if (request.controller_completion_summary.trajectory_state === "aborted" || request.controller_completion_summary.trajectory_state === "timed_out") {
    issues.push(makeIssue("warning", "ViewPolicyMissing", "$.controller_completion_summary.trajectory_state", "Execution did not finish cleanly, so verification should favor reobserve or correction.", "Keep controller telemetry visible in the certificate."));
  }
}

export function makeIssue(
  severity: ValidationSeverity,
  code: VerificationPolicyIssueCode,
  path: string,
  message: string,
  remediation: string,
): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

export function validateSafeRef(value: Ref, path: string, code: VerificationPolicyIssueCode, issues: ValidationIssue[]): void {
  if (value.trim().length === 0 || /\s/u.test(value)) {
    issues.push(makeIssue("error", code, path, "Reference must be non-empty and whitespace-free.", "Use an opaque runtime ref."));
    return;
  }
  if (HIDDEN_VERIFICATION_PATTERN.test(value)) {
    issues.push(makeIssue("error", "HiddenVerificationLeak", path, "Reference contains hidden simulator or QA wording.", "Use embodied evidence refs only."));
  }
}

export function sanitizeRef(value: Ref): Ref {
  return value.replace(HIDDEN_VERIFICATION_PATTERN, "hidden-detail").trim();
}

export function sanitizeText(value: string): string {
  return value.replace(HIDDEN_VERIFICATION_PATTERN, "hidden-detail").replace(/\s+/gu, " ").trim();
}

export function makeRef(...parts: readonly string[]): Ref {
  const normalized = parts
    .join(":")
    .toLowerCase()
    .replace(HIDDEN_VERIFICATION_PATTERN, "hidden-detail")
    .replace(/[^a-z0-9_.:-]+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return normalized.length > 0 ? normalized : "ref:empty";
}

export function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

export function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return freezeArray([...new Set(values)].sort());
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function vectorNorm(value: Vector3): number {
  return Math.sqrt(value.reduce((sum, component) => sum + component * component, 0));
}

export function scaleConfidence(...values: readonly number[]): number {
  const finite = values.filter((value) => Number.isFinite(value)).map((value) => clamp(value, 0, 1));
  if (finite.length === 0) return 0;
  return round6(finite.reduce((product, value) => product * value, 1) ** (1 / finite.length));
}

function normalizeConstraints(request: VerificationRequest, issues: ValidationIssue[]): readonly VerificationConstraintRequirement[] {
  return freezeArray(request.target_constraints.map((constraint, index) => {
    validateSafeRef(constraint.constraint_ref, `$.target_constraints[${index}].constraint_ref`, "HiddenVerificationLeak", issues);
    validateSafeRef(constraint.subject_ref, `$.target_constraints[${index}].subject_ref`, "HiddenVerificationLeak", issues);
    if (constraint.reference_ref !== undefined) validateSafeRef(constraint.reference_ref, `$.target_constraints[${index}].reference_ref`, "HiddenVerificationLeak", issues);
    for (const ref of constraint.evidence_refs) validateSafeRef(ref, `$.target_constraints[${index}].evidence_refs`, "HiddenVerificationLeak", issues);
    return Object.freeze({
      ...constraint,
      constraint_ref: sanitizeRef(constraint.constraint_ref),
      subject_ref: sanitizeRef(constraint.subject_ref),
      reference_ref: constraint.reference_ref === undefined ? undefined : sanitizeRef(constraint.reference_ref),
      expected_relation: constraint.expected_relation === undefined ? undefined : sanitizeText(constraint.expected_relation),
      evidence_refs: uniqueSorted(constraint.evidence_refs.map(sanitizeRef)),
    });
  }));
}

function validateDescriptor(descriptor: TargetObjectDescriptor, issues: ValidationIssue[]): void {
  validateSafeRef(descriptor.descriptor_ref, "$.target_object_descriptor.descriptor_ref", "HiddenVerificationLeak", issues);
  for (const ref of descriptor.perceived_feature_refs) validateSafeRef(ref, "$.target_object_descriptor.perceived_feature_refs", "HiddenVerificationLeak", issues);
  if (descriptor.label.trim().length === 0 || HIDDEN_VERIFICATION_PATTERN.test(descriptor.label)) {
    issues.push(makeIssue("error", "HiddenVerificationLeak", "$.target_object_descriptor.label", "Target descriptor must be perceptual and non-empty.", "Use a visible object label."));
  }
  if (!Number.isFinite(descriptor.identity_confidence) || descriptor.identity_confidence < 0 || descriptor.identity_confidence > 1) {
    issues.push(makeIssue("error", "ToleranceInvalid", "$.target_object_descriptor.identity_confidence", "Identity confidence must be within [0, 1].", "Clamp descriptor confidence before verification."));
  }
}

function validateControllerSummary(summary: ControllerCompletionSummary, issues: ValidationIssue[]): void {
  validateSafeRef(summary.completion_ref, "$.controller_completion_summary.completion_ref", "HiddenVerificationLeak", issues);
  for (const ref of [...summary.telemetry_refs, ...summary.anomaly_refs]) validateSafeRef(ref, "$.controller_completion_summary.refs", "HiddenVerificationLeak", issues);
  for (const [path, value] of [
    ["$.controller_completion_summary.max_position_residual_m", summary.max_position_residual_m],
    ["$.controller_completion_summary.max_orientation_residual_rad", summary.max_orientation_residual_rad],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      issues.push(makeIssue("error", "ToleranceInvalid", path, "Controller residual summaries must be finite nonnegative values.", "Normalize controller telemetry before verification."));
    }
  }
}

function validateRetry(retry: VerificationRetryContext, issues: ValidationIssue[]): void {
  const values = [retry.attempts_used, retry.ambiguity_attempts_used, retry.correction_attempts_used, retry.maximum_attempts];
  if (values.some((value) => !Number.isInteger(value) || value < 0) || retry.attempts_used > retry.maximum_attempts) {
    issues.push(makeIssue("error", "RetryBudgetInvalid", "$.retry_context", "Retry budget counters must be finite nonnegative integers and remain within the maximum.", "Repair retry accounting before verification."));
  }
}

function validateTruthBoundary(boundary: TruthBoundaryRecord, issues: ValidationIssue[]): void {
  for (const ref of boundary.audit_refs) validateSafeRef(ref, "$.truth_boundary_status.audit_refs", "HiddenVerificationLeak", issues);
  if (boundary.status !== "runtime_embodied_only") {
    issues.push(makeIssue("error", "TruthBoundaryInvalid", "$.truth_boundary_status.status", "Runtime verification must use embodied evidence only.", "Strip QA and hidden truth artifacts."));
  }
  if (boundary.evidence_provenance.includes("qa_truth")) {
    issues.push(makeIssue("error", "TruthBoundaryInvalid", "$.truth_boundary_status.evidence_provenance", "QA truth cannot enter runtime verification.", "Keep QA truth in benchmark-only records."));
  }
}

function toleranceFor(taskClass: VerificationTaskClass, objectClass: TargetObjectDescriptor["object_class"], issues: ValidationIssue[]): VerificationTolerancePolicy {
  const objectScale = objectClass === "small_rigid" || objectClass === "fragile" ? 0.7 : objectClass === "large_rigid" || objectClass === "deformable" ? 1.6 : 1;
  const taskScale = taskClass === "insert" || taskClass === "stack" ? 0.7 : taskClass === "tool_assisted_reach" ? 1.25 : 1;
  const base = 0.03 * objectScale * taskScale;
  const tolerance = Object.freeze({
    position_tolerance_m: round6(base),
    orientation_tolerance_rad: round6((taskClass === "stack" || taskClass === "insert" ? 0.1 : 0.16) * objectScale),
    stability_motion_tolerance_m: round6(Math.max(0.008, base * 0.45)),
    contact_tolerance_m: round6(Math.max(0.006, base * 0.35)),
    maximum_uncertainty_ratio: objectClass === "fragile" ? 0.45 : 0.7,
  });
  if (Object.values(tolerance).some((value) => !Number.isFinite(value) || value <= 0)) {
    issues.push(makeIssue("error", "ToleranceInvalid", "$.tolerance_policy", "Resolved verification tolerances must be positive finite values.", "Use a valid task and object class."));
  }
  return tolerance;
}

function buildViewRequirements(taskClass: VerificationTaskClass, constraints: readonly VerificationConstraintRequirement[]): readonly VerificationViewRequirement[] {
  return freezeArray(uniqueSorted(constraints.map((constraint) => constraint.constraint_class)).map((constraintClass) => {
    const required = requiredViewsFor(taskClass, constraintClass);
    return Object.freeze({
      requirement_ref: makeRef("verification_view_requirement", taskClass, constraintClass),
      constraint_class: constraintClass,
      required_views: required,
      optional_views: optionalViewsFor(constraintClass, required),
      requires_depth: constraintClass === "containment" || constraintClass === "position" || taskClass === "insert",
      requires_settle_window: constraintClass === "stability" || constraintClass === "support" || constraintClass === "containment",
      allowed_body_adjustments: freezeArray(adjustmentsFor(taskClass, constraintClass)),
    });
  }));
}

function requiredViewsFor(taskClass: VerificationTaskClass, constraintClass: VerificationConstraintClass): readonly CanonicalViewName[] {
  if (constraintClass === "containment") return freezeArray(["wrist_or_mouth", "left_aux", "right_aux"] as readonly CanonicalViewName[]);
  if (constraintClass === "tool_effect" || taskClass === "tool_assisted_reach") return freezeArray(["wrist_or_mouth", "front_primary", "verification_aux"] as readonly CanonicalViewName[]);
  if (constraintClass === "support" || constraintClass === "stability" || taskClass === "stack") return freezeArray(["front_primary", "left_aux", "right_aux"] as readonly CanonicalViewName[]);
  if (constraintClass === "orientation") return freezeArray(["front_primary", "wrist_or_mouth"] as readonly CanonicalViewName[]);
  return freezeArray(["front_primary", "left_aux"] as readonly CanonicalViewName[]);
}

function optionalViewsFor(constraintClass: VerificationConstraintClass, required: readonly CanonicalViewName[]): readonly CanonicalViewName[] {
  const candidates: readonly CanonicalViewName[] = constraintClass === "containment"
    ? ["depth_primary", "verification_aux", "front_primary"]
    : ["right_aux", "depth_primary", "verification_aux", "rear_body"];
  return uniqueSorted(candidates.filter((view) => !required.includes(view)));
}

function adjustmentsFor(taskClass: VerificationTaskClass, constraintClass: VerificationConstraintClass): readonly string[] {
  const adjustments = ["safe_head_yaw", "safe_head_pitch"];
  if (constraintClass === "containment" || constraintClass === "tool_effect") adjustments.push("effector_retreat_clearance");
  if (taskClass === "stack" || constraintClass === "stability") adjustments.push("extended_settle_observation");
  return adjustments;
}

function settleWindowFor(taskClass: VerificationTaskClass): number {
  if (taskClass === "stack" || taskClass === "insert") return 650;
  if (taskClass === "tool_assisted_reach") return 420;
  return 300;
}

function guardLevelFor(
  taskClass: VerificationTaskClass,
  constraints: readonly VerificationConstraintRequirement[],
  objectClass: TargetObjectDescriptor["object_class"],
): VerificationGuardLevel {
  if (objectClass === "fragile") return "fragile";
  if (taskClass === "tool_assisted_reach" || constraints.some((constraint) => constraint.constraint_class === "tool_effect")) return "tool_use";
  if (taskClass === "stack" || constraints.some((constraint) => constraint.constraint_class === "stability")) return "stacking";
  if (taskClass === "insert" || constraints.some((constraint) => constraint.constraint_class === "containment")) return "container";
  return constraints.length > 2 ? "strict" : "normal";
}

function buildMemoryPolicy(request: VerificationRequest): VerificationMemoryPolicy {
  const fragile = request.target_object_descriptor.object_class === "fragile";
  return Object.freeze({
    policy_ref: makeRef("verification_memory_policy", request.memory_policy_ref, request.task_class),
    minimum_certificate_confidence: fragile ? 0.82 : 0.72,
    maximum_pose_uncertainty_m: fragile ? 0.015 : 0.025,
    require_success_certificate: true,
    allow_summary_on_ambiguity: request.task_class === "inspect",
  });
}
