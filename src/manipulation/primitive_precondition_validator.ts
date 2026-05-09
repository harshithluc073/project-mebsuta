/**
 * Primitive precondition validator for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md`
 * sections 12.3, 12.5, 12.7 through 12.11, 12.14, 12.15, 12.16, and
 * 12.17.
 *
 * This module is the File 12 gate that runs after
 * `EmbodimentManipulationAdapter` and before manipulation control planning.
 * It verifies that a primitive intent has current sensor evidence, valid
 * target/tool frames, reach and stance admission, contact readiness, actuator
 * limits, safety envelope authority, and retry/reobserve budget. The validator
 * is deliberately simulation-blind: hidden world truth, backend handles, QA
 * labels, direct actuator commands, and raw cognitive assertions are rejected
 * as precondition evidence.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type {
  EmbodimentKind,
  Ref,
  ValidationIssue,
  ValidationSeverity,
} from "../simulation/world_manifest";
import type { ReachDecision } from "../embodiment/reach_envelope_service";
import type { StabilityDecision } from "../embodiment/stability_policy_service";
import type { ContactEvidenceReport } from "../embodiment/contact_site_registry";
import type { ActuatorLimitEnforcementReport } from "../control/actuator_limit_enforcer";
import type { ControlGeometryBridgeReport } from "../spatial/control_geometry_bridge";
import type {
  EmbodimentManipulationAdapterReport,
  EmbodimentPrimitiveBinding,
} from "./embodiment_manipulation_adapter";
import {
  createManipulationPrimitiveCatalog,
  ManipulationPrimitiveCatalog,
} from "./manipulation_primitive_catalog";
import type {
  ManipulationFallbackAction,
  ManipulationPrimitiveDescriptor,
  ManipulationSensorEvidence,
  PrimitiveExecutionIntent,
  PrimitiveExecutionIntentReport,
} from "./manipulation_primitive_catalog";

export const PRIMITIVE_PRECONDITION_VALIDATOR_SCHEMA_VERSION = "mebsuta.primitive_precondition_validator.v1" as const;

const HIDDEN_PRECONDITION_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|qa_success|qa_label|qa_only|simulator truth|mesh_name|asset_id|benchmark_truth|oracle_pose|direct_actuator|raw_gemini_actuation)/i;

const DEFAULT_STALE_TARGET_AFTER_S = 0.75;
const DEFAULT_STALE_FRAME_AFTER_S = 0.5;
const DEFAULT_MAX_POSE_SIGMA_M = 0.035;
const DEFAULT_MAX_ORIENTATION_SIGMA_RAD = 0.18;
const DEFAULT_MIN_VISIBILITY_CONFIDENCE = 0.58;
const DEFAULT_MIN_REOBSERVE_BUDGET = 1;

export type PrimitivePreconditionDecision =
  | "passed"
  | "passed_with_constraints"
  | "reobserve"
  | "reposition"
  | "safe_hold"
  | "failed";

export type PrimitivePreconditionRecommendedAction =
  | "handoff_to_control"
  | "collect_sensor_evidence"
  | "refresh_geometry"
  | "reposition_body"
  | "repair_intent"
  | "validate_tool"
  | "reduce_force"
  | "safe_hold"
  | "human_review";

export type PrimitivePreconditionGateName =
  | "intent"
  | "adapter_binding"
  | "visibility"
  | "target_frame"
  | "reach"
  | "stance"
  | "contact"
  | "control"
  | "tool"
  | "safety"
  | "retry_budget";

export type PrimitivePreconditionGateStatus = "satisfied" | "warning" | "fail" | "not_applicable";

export type PrimitivePreconditionIssueCode =
  | "PrimitiveIntentInvalid"
  | "AdapterBindingInvalid"
  | "HiddenPreconditionLeak"
  | "VisibilityMissing"
  | "SensorHealthRejected"
  | "TargetFrameMissing"
  | "TargetFrameStale"
  | "TargetFrameNotControlCandidate"
  | "GeometryContextInvalid"
  | "ReachDecisionMissing"
  | "ReachRejected"
  | "StanceDecisionMissing"
  | "StanceUnsafe"
  | "ContactReadinessMissing"
  | "ContactReadinessRejected"
  | "ActuatorLimitRejected"
  | "IKFeasibilityRejected"
  | "ToolValidationMissing"
  | "SafetyEnvelopeRejected"
  | "RetryBudgetExceeded";

export interface PrimitivePreconditionValidatorConfig {
  readonly primitive_catalog?: ManipulationPrimitiveCatalog;
  readonly stale_target_after_s?: number;
  readonly stale_frame_after_s?: number;
  readonly max_pose_sigma_m?: number;
  readonly max_orientation_sigma_rad?: number;
  readonly min_visibility_confidence?: number;
  readonly min_reobserve_budget?: number;
}

/**
 * Sensor evidence state available at the instant of precondition evaluation.
 */
export interface PrimitiveSensorEvidenceState {
  readonly available_sensor_evidence: readonly ManipulationSensorEvidence[];
  readonly evidence_refs: readonly Ref[];
  readonly target_visible: boolean;
  readonly target_visibility_confidence: number;
  readonly target_observation_age_s: number;
  readonly sensors_healthy: boolean;
  readonly degraded_sensor_refs?: readonly Ref[];
  readonly verification_view_available?: boolean;
  readonly contact_report?: ContactEvidenceReport;
}

/**
 * Geometry and frame state used to admit target/tool motion into control.
 */
export interface PrimitiveGeometryContext {
  readonly geometry_context_ref: Ref;
  readonly target_frame_ref?: Ref;
  readonly tool_frame_ref?: Ref;
  readonly control_geometry_report?: ControlGeometryBridgeReport;
  readonly target_frame_current: boolean;
  readonly target_frame_control_candidate: boolean;
  readonly target_frame_age_s?: number;
  readonly pose_uncertainty_m?: number;
  readonly orientation_uncertainty_rad?: number;
  readonly transform_chain_resolved: boolean;
  readonly path_clear: boolean;
  readonly swept_volume_clear: boolean;
  readonly tool_frame_current?: boolean;
  readonly tool_candidate_visible?: boolean;
  readonly collision_risk?: "none" | "low" | "medium" | "high" | "unknown";
}

/**
 * Control-layer readiness needed before a primitive may create trajectories.
 */
export interface PrimitiveControlContext {
  readonly control_context_ref: Ref;
  readonly reach_decision?: ReachDecision;
  readonly stability_decision?: StabilityDecision;
  readonly actuator_report?: ActuatorLimitEnforcementReport;
  readonly ik_feasible?: boolean;
  readonly stance_ready?: boolean;
  readonly grip_force_limit_configured?: boolean;
  readonly retry_budget_remaining: number;
}

/**
 * Runtime safety authority for the candidate primitive execution.
 */
export interface PrimitiveSafetyContext {
  readonly safety_envelope_ref: Ref;
  readonly safety_envelope_active: boolean;
  readonly emergency_stop_active: boolean;
  readonly safe_hold_active: boolean;
  readonly forbidden_region_clear: boolean;
  readonly human_review_required?: boolean;
  readonly observed_contact_force_n?: number;
  readonly max_contact_force_n?: number;
}

/**
 * Full File 12 precondition validation request.
 */
export interface PrimitivePreconditionValidationRequest {
  readonly request_ref?: Ref;
  readonly primitive_intent: PrimitiveExecutionIntent;
  readonly adapter_report?: EmbodimentManipulationAdapterReport;
  readonly sensor_evidence: PrimitiveSensorEvidenceState;
  readonly geometry_context: PrimitiveGeometryContext;
  readonly control_context: PrimitiveControlContext;
  readonly safety_context: PrimitiveSafetyContext;
  readonly current_time_s?: number;
  readonly reobserve_budget_remaining?: number;
}

/**
 * Per-gate status for observability and Oops handoff routing.
 */
export interface PrimitivePreconditionGateResult {
  readonly gate: PrimitivePreconditionGateName;
  readonly status: PrimitivePreconditionGateStatus;
  readonly evidence_refs: readonly Ref[];
  readonly summary: string;
  readonly recommended_action?: PrimitivePreconditionRecommendedAction;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

/**
 * File 12 validator report consumed by the upcoming control planner.
 */
export interface PrimitivePreconditionReport {
  readonly schema_version: typeof PRIMITIVE_PRECONDITION_VALIDATOR_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md";
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly primitive_ref: Ref;
  readonly primitive_name?: ManipulationPrimitiveDescriptor["primitive_name"];
  readonly embodiment_kind: EmbodimentKind;
  readonly decision: PrimitivePreconditionDecision;
  readonly recommended_action: PrimitivePreconditionRecommendedAction;
  readonly intent_report: PrimitiveExecutionIntentReport;
  readonly selected_binding?: EmbodimentPrimitiveBinding;
  readonly gate_results: readonly PrimitivePreconditionGateResult[];
  readonly missing_sensor_evidence: readonly ManipulationSensorEvidence[];
  readonly required_fallback_actions: readonly ManipulationFallbackAction[];
  readonly blocked_gate_names: readonly PrimitivePreconditionGateName[];
  readonly reobserve_budget_remaining: number;
  readonly prompt_safe_summary: string;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "primitive_precondition_report";
  readonly determinism_hash: string;
}

interface NormalizedPrimitivePreconditionPolicy {
  readonly stale_target_after_s: number;
  readonly stale_frame_after_s: number;
  readonly max_pose_sigma_m: number;
  readonly max_orientation_sigma_rad: number;
  readonly min_visibility_confidence: number;
  readonly min_reobserve_budget: number;
}

/**
 * Validates File 12 preconditions before manipulation control handoff.
 */
export class PrimitivePreconditionValidator {
  private readonly primitiveCatalog: ManipulationPrimitiveCatalog;
  private readonly policy: NormalizedPrimitivePreconditionPolicy;

  public constructor(config: PrimitivePreconditionValidatorConfig = {}) {
    this.primitiveCatalog = config.primitive_catalog ?? createManipulationPrimitiveCatalog();
    this.policy = normalizePolicy(config);
  }

  /**
   * Checks visibility, reach, target frame, contact readiness, stance, safety,
   * tool validity, and sensor health for one primitive intent.
   */
  public validatePrimitivePreconditions(request: PrimitivePreconditionValidationRequest): PrimitivePreconditionReport {
    const requestRef = sanitizeRef(request.request_ref ?? `primitive_preconditions_${computeDeterminismHash({
      intent: request.primitive_intent.intent_ref,
      primitive: request.primitive_intent.selected_primitive_ref,
      control: request.control_context.control_context_ref,
    })}`);
    const descriptor = resolveDescriptor(this.primitiveCatalog, request.primitive_intent.selected_primitive_ref);
    const intentReport = this.primitiveCatalog.validateExecutionIntent(request.primitive_intent);
    const selectedBinding = request.adapter_report?.selected_binding;
    const gateResults = freezeArray([
      validateIntentGate(request, descriptor, intentReport),
      validateAdapterGate(request, descriptor, selectedBinding),
      validateVisibilityGate(request, descriptor, this.policy),
      validateTargetFrameGate(request, descriptor, this.policy),
      validateReachGate(request, descriptor),
      validateStanceGate(request, descriptor),
      validateContactGate(request, descriptor),
      validateControlGate(request, descriptor),
      validateToolGate(request, descriptor),
      validateSafetyGate(request, descriptor),
      validateRetryBudgetGate(request, this.policy),
    ]);
    const issues = freezeArray([
      ...intentReport.issues,
      ...(request.adapter_report?.issues ?? []),
      ...gateResults.flatMap((gate) => gate.issues),
    ]);
    const missingSensors = freezeArray(uniqueSorted([
      ...intentReport.missing_sensor_evidence,
      ...gateResults
        .filter((gate) => gate.gate === "visibility")
        .flatMap((gate) => gate.issues.some((issue) => issue.code === "VisibilityMissing") ? intentReport.missing_sensor_evidence : []),
    ]));
    const blockedGates = freezeArray(gateResults
      .filter((gate) => gate.status === "fail")
      .map((gate) => gate.gate));
    const requiredFallbackActions = freezeArray(uniqueSorted([
      ...intentReport.missing_fallback_actions,
      ...fallbacksFromDecisionInputs(gateResults, issues),
    ]));
    const decision = decidePreconditions(gateResults, issues);
    const recommendedAction = recommendAction(decision, gateResults, issues, requiredFallbackActions);
    const promptSafeSummary = sanitizeText(buildSummary(request, descriptor, decision, recommendedAction, gateResults));
    const base = {
      schema_version: PRIMITIVE_PRECONDITION_VALIDATOR_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md" as const,
      report_ref: `primitive_precondition_report_${computeDeterminismHash({
        requestRef,
        primitive: request.primitive_intent.selected_primitive_ref,
        decision,
        gates: gateResults.map((gate) => `${gate.gate}:${gate.status}`),
      })}`,
      request_ref: requestRef,
      primitive_ref: sanitizeRef(request.primitive_intent.selected_primitive_ref),
      primitive_name: descriptor?.primitive_name,
      embodiment_kind: request.primitive_intent.embodiment_kind,
      decision,
      recommended_action: recommendedAction,
      intent_report: intentReport,
      selected_binding: selectedBinding,
      gate_results: gateResults,
      missing_sensor_evidence: missingSensors,
      required_fallback_actions: requiredFallbackActions,
      blocked_gate_names: blockedGates,
      reobserve_budget_remaining: Math.max(0, request.reobserve_budget_remaining ?? request.control_context.retry_budget_remaining),
      prompt_safe_summary: promptSafeSummary,
      issues,
      ok: decision === "passed" || decision === "passed_with_constraints",
      cognitive_visibility: "primitive_precondition_report" as const,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }
}

export function createPrimitivePreconditionValidator(config: PrimitivePreconditionValidatorConfig = {}): PrimitivePreconditionValidator {
  return new PrimitivePreconditionValidator(config);
}

function validateIntentGate(
  request: PrimitivePreconditionValidationRequest,
  descriptor: ManipulationPrimitiveDescriptor | undefined,
  intentReport: PrimitiveExecutionIntentReport,
): PrimitivePreconditionGateResult {
  const issues: ValidationIssue[] = [];
  validateRef(request.primitive_intent.intent_ref, "$.primitive_intent.intent_ref", "PrimitiveIntentInvalid", issues);
  validateRef(request.primitive_intent.source_plan_ref, "$.primitive_intent.source_plan_ref", "PrimitiveIntentInvalid", issues);
  validateRef(request.primitive_intent.control_work_order_ref, "$.primitive_intent.control_work_order_ref", "PrimitiveIntentInvalid", issues);
  validateRef(request.primitive_intent.validation_decision_ref, "$.primitive_intent.validation_decision_ref", "PrimitiveIntentInvalid", issues);
  if (!intentReport.accepted) {
    issues.push(makeIssue("error", "PrimitiveIntentInvalid", "$.primitive_intent", "Primitive execution intent is not accepted by the File 12 catalog.", "Repair primitive selection, frames, contact expectation, or fallback policy before execution."));
  }
  const status = issues.some(isError) ? "fail" : intentReport.issues.length > 0 || descriptor === undefined ? "warning" : "satisfied";
  return gate("intent", status, [
    request.primitive_intent.intent_ref,
    request.primitive_intent.source_plan_ref,
    request.primitive_intent.validation_decision_ref,
  ], status === "satisfied" ? "Primitive intent is catalog-valid and traceable." : "Primitive intent needs repair before control handoff.", issues, status === "fail" ? "repair_intent" : undefined);
}

function validateAdapterGate(
  request: PrimitivePreconditionValidationRequest,
  descriptor: ManipulationPrimitiveDescriptor | undefined,
  binding: EmbodimentPrimitiveBinding | undefined,
): PrimitivePreconditionGateResult {
  const issues: ValidationIssue[] = [];
  if (request.adapter_report === undefined) {
    issues.push(makeIssue("error", "AdapterBindingInvalid", "$.adapter_report", "Primitive preconditions require an embodiment binding report.", "Run EmbodimentManipulationAdapter before precondition validation."));
  } else if (!request.adapter_report.ok || binding === undefined) {
    issues.push(makeIssue("error", "AdapterBindingInvalid", "$.adapter_report.selected_binding", "Embodiment binding did not produce an executable selected binding.", "Resolve adapter follow-up before validating primitive preconditions."));
  } else {
    if (binding.primitive_ref !== request.primitive_intent.selected_primitive_ref) {
      issues.push(makeIssue("error", "AdapterBindingInvalid", "$.adapter_report.selected_binding.primitive_ref", "Selected binding primitive does not match primitive intent.", "Regenerate the adapter report from the current primitive intent."));
    }
    if (binding.end_effector_role !== request.primitive_intent.end_effector_role) {
      issues.push(makeIssue("error", "AdapterBindingInvalid", "$.adapter_report.selected_binding.end_effector_role", "Selected binding end-effector role does not match primitive intent.", "Use the adapter-selected end effector or repair the intent."));
    }
    if (binding.embodiment_kind !== request.primitive_intent.embodiment_kind) {
      issues.push(makeIssue("error", "AdapterBindingInvalid", "$.adapter_report.selected_binding.embodiment_kind", "Selected binding embodiment does not match primitive intent.", "Use the active embodiment binding."));
    }
  }
  if (descriptor !== undefined && request.primitive_intent.embodiment_kind !== undefined && !descriptor.embodiment_variants.includes(request.primitive_intent.embodiment_kind)) {
    issues.push(makeIssue("error", "AdapterBindingInvalid", "$.primitive_intent.embodiment_kind", "Primitive descriptor does not support the requested embodiment.", "Select a descriptor variant supported by the current body."));
  }
  return gate("adapter_binding", issues.some(isError) ? "fail" : issues.length > 0 ? "warning" : "satisfied", [
    request.adapter_report?.report_ref,
    binding?.binding_ref,
  ], issues.some(isError) ? "Embodiment binding is not executable." : "Embodiment binding is aligned with the primitive intent.", issues, issues.some(isError) ? "repair_intent" : undefined);
}

function validateVisibilityGate(
  request: PrimitivePreconditionValidationRequest,
  descriptor: ManipulationPrimitiveDescriptor | undefined,
  policy: NormalizedPrimitivePreconditionPolicy,
): PrimitivePreconditionGateResult {
  const issues: ValidationIssue[] = [];
  const evidence = request.sensor_evidence;
  for (const ref of evidence.evidence_refs) validateRef(ref, "$.sensor_evidence.evidence_refs", "HiddenPreconditionLeak", issues);
  const required = descriptor?.required_sensor_evidence ?? [];
  const missing = required.filter((item) => !evidence.available_sensor_evidence.includes(item));
  if (missing.length > 0) {
    issues.push(makeIssue("warning", "VisibilityMissing", "$.sensor_evidence.available_sensor_evidence", `Required sensor evidence is missing: ${missing.join(", ")}.`, "Collect the required visual, contact, force, IMU, proprioceptive, tool-tip, or verification evidence."));
  }
  if (!evidence.sensors_healthy) {
    issues.push(makeIssue("error", "SensorHealthRejected", "$.sensor_evidence.sensors_healthy", "Required manipulation sensors are degraded or unhealthy.", "Switch to alternate view or safe-hold if no reliable evidence remains."));
  }
  if (requiresCurrentTargetEvidence(descriptor) && !evidence.target_visible) {
    issues.push(makeIssue("warning", "VisibilityMissing", "$.sensor_evidence.target_visible", "Target is not currently visible for a manipulation-sensitive primitive.", "Reobserve or acquire an alternate view before execution."));
  }
  if (requiresCurrentTargetEvidence(descriptor) && evidence.target_visibility_confidence < policy.min_visibility_confidence) {
    issues.push(makeIssue("warning", "VisibilityMissing", "$.sensor_evidence.target_visibility_confidence", "Target visibility confidence is below primitive admission policy.", "Refresh visual evidence before execution."));
  }
  if (requiresCurrentTargetEvidence(descriptor) && evidence.target_observation_age_s > policy.stale_target_after_s) {
    issues.push(makeIssue("warning", "VisibilityMissing", "$.sensor_evidence.target_observation_age_s", "Target observation is stale before primitive execution.", "Reobserve the target and rebuild the primitive intent if it moved."));
  }
  const status = issues.some(isError) ? "fail" : issues.length > 0 ? "warning" : "satisfied";
  return gate("visibility", status, evidence.evidence_refs, status === "satisfied" ? "Sensor and visibility evidence is current enough for the primitive." : "Sensor or target evidence requires refresh.", issues, status === "fail" ? "safe_hold" : issues.length > 0 ? "collect_sensor_evidence" : undefined);
}

function validateTargetFrameGate(
  request: PrimitivePreconditionValidationRequest,
  descriptor: ManipulationPrimitiveDescriptor | undefined,
  policy: NormalizedPrimitivePreconditionPolicy,
): PrimitivePreconditionGateResult {
  const issues: ValidationIssue[] = [];
  const geometry = request.geometry_context;
  validateRef(geometry.geometry_context_ref, "$.geometry_context.geometry_context_ref", "GeometryContextInvalid", issues);
  if (geometry.target_frame_ref !== undefined) validateRef(geometry.target_frame_ref, "$.geometry_context.target_frame_ref", "TargetFrameMissing", issues);
  if (geometry.tool_frame_ref !== undefined) validateRef(geometry.tool_frame_ref, "$.geometry_context.tool_frame_ref", "ToolValidationMissing", issues);
  if (!geometry.transform_chain_resolved) {
    issues.push(makeIssue("error", "GeometryContextInvalid", "$.geometry_context.transform_chain_resolved", "Transform chain is unresolved for primitive target frames.", "Repair File 10 geometry before manipulation."));
  }
  if (descriptor?.target_frame_requirements.requires_target_frame === true) {
    if (request.primitive_intent.target_frame_ref === undefined || geometry.target_frame_ref === undefined) {
      issues.push(makeIssue("error", "TargetFrameMissing", "$.primitive_intent.target_frame_ref", "Primitive requires a validated target frame.", "Attach a File 10 control-candidate target frame."));
    }
    if (!geometry.target_frame_current) {
      issues.push(makeIssue("warning", "TargetFrameStale", "$.geometry_context.target_frame_current", "Target frame is not current.", "Refresh target frame before execution."));
    }
    if (!geometry.target_frame_control_candidate) {
      issues.push(makeIssue("error", "TargetFrameNotControlCandidate", "$.geometry_context.target_frame_control_candidate", "Target frame is not admitted as a control candidate.", "Use ControlGeometryBridge to produce a control-candidate frame."));
    }
    if ((geometry.target_frame_age_s ?? 0) > policy.stale_frame_after_s) {
      issues.push(makeIssue("warning", "TargetFrameStale", "$.geometry_context.target_frame_age_s", "Target frame age exceeds manipulation precondition policy.", "Refresh the frame graph and pose estimate."));
    }
  }
  if ((geometry.pose_uncertainty_m ?? 0) > policy.max_pose_sigma_m) {
    issues.push(makeIssue("warning", "GeometryContextInvalid", "$.geometry_context.pose_uncertainty_m", "Target pose position uncertainty exceeds primitive policy.", "Reobserve or run spatial normalization before execution."));
  }
  if ((geometry.orientation_uncertainty_rad ?? 0) > policy.max_orientation_sigma_rad) {
    issues.push(makeIssue("warning", "GeometryContextInvalid", "$.geometry_context.orientation_uncertainty_rad", "Target orientation uncertainty exceeds primitive policy.", "Refresh orientation estimate or choose a coarser primitive."));
  }
  if (!geometry.path_clear || !geometry.swept_volume_clear || geometry.collision_risk === "high") {
    issues.push(makeIssue("error", "GeometryContextInvalid", "$.geometry_context.swept_volume_clear", "Path or swept volume is not clear for manipulation.", "Replan, reposition, or safe-hold before contact motion."));
  }
  const status = issues.some(isError) ? "fail" : issues.length > 0 ? "warning" : descriptor?.target_frame_requirements.requires_target_frame === true ? "satisfied" : "not_applicable";
  return gate("target_frame", status, [
    geometry.geometry_context_ref,
    geometry.target_frame_ref,
    geometry.control_geometry_report?.bridge_ref,
  ], status === "satisfied" || status === "not_applicable" ? "Geometry and target-frame context satisfy primitive requirements." : "Geometry context must be refreshed or repaired.", issues, issues.some(isError) ? "refresh_geometry" : issues.length > 0 ? "collect_sensor_evidence" : undefined);
}

function validateReachGate(
  request: PrimitivePreconditionValidationRequest,
  descriptor: ManipulationPrimitiveDescriptor | undefined,
): PrimitivePreconditionGateResult {
  const issues: ValidationIssue[] = [];
  const reach = request.control_context.reach_decision;
  if (requiresReachDecision(descriptor) && reach === undefined) {
    issues.push(makeIssue("warning", "ReachDecisionMissing", "$.control_context.reach_decision", "Reach decision is missing before manipulation execution.", "Evaluate File 05 reach envelope before primitive control handoff."));
  }
  if (reach !== undefined) {
    validateRef(reach.decision_id, "$.control_context.reach_decision.decision_id", "ReachRejected", issues);
    if (!reach.ok || reach.decision === "UnreachableOrUnsafe" || reach.validator_admission === "reject") {
      issues.push(makeIssue("error", "ReachRejected", "$.control_context.reach_decision", "Reach service rejected this primitive target.", "Reposition, use a validated tool, or choose a safer primitive."));
    } else if (reach.decision === "UnknownDueToPerception") {
      issues.push(makeIssue("warning", "ReachRejected", "$.control_context.reach_decision.decision", "Reach is unknown due to perception uncertainty.", "Reobserve before manipulation."));
    } else if (reach.reposition_required || reach.validator_admission === "admit_with_reposition") {
      issues.push(makeIssue("warning", "ReachRejected", "$.control_context.reach_decision.reposition_required", "Reach requires body repositioning before execution.", "Reposition body and recompute reach."));
    } else if (reach.tool_validation_required) {
      issues.push(makeIssue("warning", "ToolValidationMissing", "$.control_context.reach_decision.tool_validation_required", "Reach requires validated tool attachment.", "Validate the tool before primitive execution."));
    }
  }
  const status = issues.some(isError) ? "fail" : issues.length > 0 ? "warning" : requiresReachDecision(descriptor) ? "satisfied" : "not_applicable";
  return gate("reach", status, [reach?.decision_id], status === "satisfied" || status === "not_applicable" ? "Reach gate admits the primitive." : "Reach requires follow-up before execution.", issues, reachAction(issues));
}

function validateStanceGate(
  request: PrimitivePreconditionValidationRequest,
  descriptor: ManipulationPrimitiveDescriptor | undefined,
): PrimitivePreconditionGateResult {
  const issues: ValidationIssue[] = [];
  const stability = request.control_context.stability_decision;
  if (requiresStanceDecision(descriptor) && stability === undefined) {
    issues.push(makeIssue("warning", "StanceDecisionMissing", "$.control_context.stability_decision", "Stability/stance decision is missing before manipulation.", "Evaluate body stance and support contacts before primitive execution."));
  }
  if (stability !== undefined) {
    validateRef(stability.decision_id, "$.control_context.stability_decision.decision_id", "StanceUnsafe", issues);
    if (stability.safe_hold_required || stability.validator_admission === "safe_hold" || stability.validator_admission === "reject") {
      issues.push(makeIssue("error", "StanceUnsafe", "$.control_context.stability_decision", "Stability policy does not admit this primitive.", "Stabilize, reposition, or safe-hold before manipulation."));
    } else if (stability.validator_admission === "admit_with_speed_limit" || stability.stability_state === "marginal") {
      issues.push(makeIssue("warning", "StanceUnsafe", "$.control_context.stability_decision", "Stability is marginal and requires speed or posture limits.", "Apply reduced speed and brace constraints before control handoff."));
    }
  }
  if (request.control_context.stance_ready === false) {
    issues.push(makeIssue("error", "StanceUnsafe", "$.control_context.stance_ready", "Runtime stance readiness is false.", "Wait for static support or choose a safer stance."));
  }
  const status = issues.some(isError) ? "fail" : issues.length > 0 ? "warning" : requiresStanceDecision(descriptor) ? "satisfied" : "not_applicable";
  return gate("stance", status, [stability?.decision_id, stability?.stance_ref], status === "satisfied" || status === "not_applicable" ? "Stance gate admits the primitive." : "Stance or support state needs follow-up.", issues, stanceAction(issues));
}

function validateContactGate(
  request: PrimitivePreconditionValidationRequest,
  descriptor: ManipulationPrimitiveDescriptor | undefined,
): PrimitivePreconditionGateResult {
  const issues: ValidationIssue[] = [];
  const report = request.sensor_evidence.contact_report;
  const expectation = request.primitive_intent.contact_expectation;
  if (requiresContactEvidence(descriptor, expectation) && report === undefined) {
    issues.push(makeIssue("warning", "ContactReadinessMissing", "$.sensor_evidence.contact_report", "Contact-sensitive primitive has no contact evidence report.", "Acquire tactile or force evidence before contact execution."));
  }
  if (report !== undefined) {
    if (!report.ok || report.over_force_count > 0) {
      issues.push(makeIssue("error", "ContactReadinessRejected", "$.sensor_evidence.contact_report", "Contact evidence has blocking issues or over-force events.", "Reduce force, repair contact state, or safe-hold."));
    }
    if (report.slip_event_count > 0 && expectation !== "no_contact") {
      issues.push(makeIssue("warning", "ContactReadinessRejected", "$.sensor_evidence.contact_report.slip_event_count", "Contact evidence indicates possible slip.", "Stabilize, reduce force, or choose alternate grasp."));
    }
    if ((expectation === "grip" || expectation === "support" || descriptor?.primitive_name === "lift_object" || descriptor?.primitive_name === "carry_object") && report.manipulation_contact_count === 0) {
      issues.push(makeIssue("warning", "ContactReadinessMissing", "$.sensor_evidence.contact_report.manipulation_contact_count", "No manipulation contact is confirmed for a held-object primitive.", "Confirm grip/contact before lift, carry, place, or release."));
    }
  }
  if (descriptor?.primitive_name === "grasp_object" && request.control_context.grip_force_limit_configured !== true) {
    issues.push(makeIssue("error", "ContactReadinessRejected", "$.control_context.grip_force_limit_configured", "Grip force limit is not configured before grasp.", "Attach a bounded grip force ramp before contact."));
  }
  const status = issues.some(isError) ? "fail" : issues.length > 0 ? "warning" : requiresContactEvidence(descriptor, expectation) ? "satisfied" : "not_applicable";
  return gate("contact", status, report?.decisions.map((decision) => decision.contact_site_ref) ?? [], status === "satisfied" || status === "not_applicable" ? "Contact readiness satisfies primitive requirements." : "Contact readiness needs corroboration or force repair.", issues, contactAction(issues));
}

function validateControlGate(
  request: PrimitivePreconditionValidationRequest,
  descriptor: ManipulationPrimitiveDescriptor | undefined,
): PrimitivePreconditionGateResult {
  const issues: ValidationIssue[] = [];
  validateRef(request.control_context.control_context_ref, "$.control_context.control_context_ref", "IKFeasibilityRejected", issues);
  if (request.control_context.ik_feasible === false) {
    issues.push(makeIssue("error", "IKFeasibilityRejected", "$.control_context.ik_feasible", "IK feasibility is rejected for this primitive target.", "Reposition, lower target, use a tool, or repair target frame."));
  }
  const actuator = request.control_context.actuator_report;
  if (actuator !== undefined) {
    validateRef(actuator.report_ref, "$.control_context.actuator_report.report_ref", "ActuatorLimitRejected", issues);
    if (!actuator.ok || actuator.safe_hold_required || actuator.decision === "safe_hold_required" || actuator.decision === "rejected") {
      issues.push(makeIssue("error", "ActuatorLimitRejected", "$.control_context.actuator_report", "Actuator limits reject or safe-hold the primitive command envelope.", "Reduce speed, force, or command targets before execution."));
    } else if (actuator.decision === "enforced_with_clipping" || actuator.clipped_command_count > 0) {
      issues.push(makeIssue("warning", "ActuatorLimitRejected", "$.control_context.actuator_report.clipped_command_count", "Actuator report clipped one or more command envelopes.", "Carry the clipped limits into trajectory planning."));
    }
  }
  if (requiresActuatorReport(descriptor) && actuator === undefined) {
    issues.push(makeIssue("warning", "ActuatorLimitRejected", "$.control_context.actuator_report", "Actuator limit evidence is missing for an executable primitive.", "Evaluate File 11 actuator limits before control handoff."));
  }
  const status = issues.some(isError) ? "fail" : issues.length > 0 ? "warning" : "satisfied";
  return gate("control", status, [request.control_context.control_context_ref, actuator?.report_ref], status === "satisfied" ? "Control readiness admits the primitive." : "Control readiness has IK or actuator constraints.", issues, controlAction(issues));
}

function validateToolGate(
  request: PrimitivePreconditionValidationRequest,
  descriptor: ManipulationPrimitiveDescriptor | undefined,
): PrimitivePreconditionGateResult {
  const issues: ValidationIssue[] = [];
  const requiresTool = descriptor?.target_frame_requirements.requires_tool_frame === true || descriptor?.admission_class === "tool_motion";
  if (!requiresTool) {
    return gate("tool", "not_applicable", [], "Primitive does not require a tool frame.", issues);
  }
  if (request.primitive_intent.tool_frame_ref === undefined || request.geometry_context.tool_frame_ref === undefined) {
    issues.push(makeIssue("error", "ToolValidationMissing", "$.primitive_intent.tool_frame_ref", "Tool primitive requires a current task-scoped tool frame.", "Validate acquisition and create a fresh tool frame before execution."));
  }
  if (request.geometry_context.tool_frame_current !== true) {
    issues.push(makeIssue("error", "ToolValidationMissing", "$.geometry_context.tool_frame_current", "Tool frame is stale or not current.", "Expire or refresh the tool subroutine before use."));
  }
  if (request.geometry_context.tool_candidate_visible === false) {
    issues.push(makeIssue("warning", "ToolValidationMissing", "$.geometry_context.tool_candidate_visible", "Tool candidate is not currently visible.", "Acquire an alternate view before tool execution."));
  }
  return gate("tool", issues.some(isError) ? "fail" : issues.length > 0 ? "warning" : "satisfied", [
    request.primitive_intent.tool_frame_ref,
    request.geometry_context.tool_frame_ref,
  ], issues.length === 0 ? "Tool frame is current and validated for this primitive." : "Tool state requires validation before execution.", issues, "validate_tool");
}

function validateSafetyGate(
  request: PrimitivePreconditionValidationRequest,
  descriptor: ManipulationPrimitiveDescriptor | undefined,
): PrimitivePreconditionGateResult {
  const issues: ValidationIssue[] = [];
  validateRef(request.safety_context.safety_envelope_ref, "$.safety_context.safety_envelope_ref", "SafetyEnvelopeRejected", issues);
  if (!request.safety_context.safety_envelope_active) {
    issues.push(makeIssue("error", "SafetyEnvelopeRejected", "$.safety_context.safety_envelope_active", "Safety envelope is not active.", "Activate a manipulation safety envelope before execution."));
  }
  if (request.safety_context.emergency_stop_active || request.safety_context.safe_hold_active) {
    issues.push(makeIssue("error", "SafetyEnvelopeRejected", "$.safety_context.safe_hold_active", "Emergency stop or safe-hold is already active.", "Do not admit task motion until safety clears."));
  }
  if (!request.safety_context.forbidden_region_clear) {
    issues.push(makeIssue("error", "SafetyEnvelopeRejected", "$.safety_context.forbidden_region_clear", "Primitive path intersects a forbidden or unresolved region.", "Replan path or safe-hold before manipulation."));
  }
  if (request.safety_context.human_review_required === true) {
    issues.push(makeIssue("error", "SafetyEnvelopeRejected", "$.safety_context.human_review_required", "Safety policy requires human review.", "Route to human review and hold motion."));
  }
  const maxForce = request.safety_context.max_contact_force_n;
  const observedForce = request.safety_context.observed_contact_force_n;
  if (maxForce !== undefined && observedForce !== undefined && observedForce > maxForce) {
    issues.push(makeIssue("error", "SafetyEnvelopeRejected", "$.safety_context.observed_contact_force_n", "Observed contact force exceeds safety envelope.", "Reduce force or safe-hold immediately."));
  }
  if (descriptor?.safety_stop_conditions.length === 0) {
    issues.push(makeIssue("warning", "SafetyEnvelopeRejected", "$.descriptor.safety_stop_conditions", "Primitive descriptor has no safety stop conditions.", "Attach primitive safety stop conditions before execution."));
  }
  return gate("safety", issues.some(isError) ? "fail" : issues.length > 0 ? "warning" : "satisfied", [request.safety_context.safety_envelope_ref], issues.length === 0 ? "Safety envelope admits the primitive." : "Safety envelope blocks or constrains execution.", issues, issues.some(isError) ? "safe_hold" : undefined);
}

function validateRetryBudgetGate(
  request: PrimitivePreconditionValidationRequest,
  policy: NormalizedPrimitivePreconditionPolicy,
): PrimitivePreconditionGateResult {
  const issues: ValidationIssue[] = [];
  const reobserveBudget = request.reobserve_budget_remaining ?? request.control_context.retry_budget_remaining;
  if (request.control_context.retry_budget_remaining < 0 || reobserveBudget < 0) {
    issues.push(makeIssue("error", "RetryBudgetExceeded", "$.control_context.retry_budget_remaining", "Retry or reobserve budget is negative.", "Repair orchestration budget accounting before execution."));
  }
  if (reobserveBudget < policy.min_reobserve_budget) {
    issues.push(makeIssue("warning", "RetryBudgetExceeded", "$.reobserve_budget_remaining", "Reobserve budget is exhausted or below policy.", "Avoid repeated blind retries; route to correction or human review if evidence is stale."));
  }
  return gate("retry_budget", issues.some(isError) ? "fail" : issues.length > 0 ? "warning" : "satisfied", [request.control_context.control_context_ref], issues.length === 0 ? "Retry and reobserve budget allows bounded execution." : "Retry or reobserve budget is constrained.", issues, issues.some(isError) ? "human_review" : undefined);
}

function resolveDescriptor(catalog: ManipulationPrimitiveCatalog, primitiveRef: Ref): ManipulationPrimitiveDescriptor | undefined {
  try {
    return catalog.requirePrimitive(primitiveRef);
  } catch {
    return undefined;
  }
}

function decidePreconditions(
  gates: readonly PrimitivePreconditionGateResult[],
  issues: readonly ValidationIssue[],
): PrimitivePreconditionDecision {
  if (issues.some((issue) => issue.severity === "error" && (issue.code === "SafetyEnvelopeRejected" || issue.code === "StanceUnsafe" || issue.code === "ContactReadinessRejected" || issue.code === "ActuatorLimitRejected"))) {
    return "safe_hold";
  }
  if (gates.some((gateResult) => gateResult.status === "fail")) {
    return "failed";
  }
  if (issues.some((issue) => issue.code === "ReachRejected" && issue.severity === "warning")) {
    return "reposition";
  }
  if (issues.some((issue) => issue.code === "VisibilityMissing" || issue.code === "TargetFrameStale" || issue.code === "GeometryContextInvalid" || issue.code === "ReachDecisionMissing")) {
    return "reobserve";
  }
  return gates.some((gateResult) => gateResult.status === "warning") || issues.length > 0 ? "passed_with_constraints" : "passed";
}

function recommendAction(
  decision: PrimitivePreconditionDecision,
  gates: readonly PrimitivePreconditionGateResult[],
  issues: readonly ValidationIssue[],
  fallbackActions: readonly ManipulationFallbackAction[],
): PrimitivePreconditionRecommendedAction {
  if (decision === "passed" || decision === "passed_with_constraints") return "handoff_to_control";
  if (decision === "safe_hold") return fallbackActions.includes("human_review") ? "human_review" : "safe_hold";
  const gateAction = gates.find((gateResult) => gateResult.status === "fail" || gateResult.status === "warning")?.recommended_action;
  if (gateAction !== undefined) return gateAction;
  if (issues.some((issue) => issue.code === "ToolValidationMissing")) return "validate_tool";
  if (issues.some((issue) => issue.code === "ReachRejected")) return "reposition_body";
  if (issues.some((issue) => issue.code === "VisibilityMissing")) return "collect_sensor_evidence";
  return "repair_intent";
}

function buildSummary(
  request: PrimitivePreconditionValidationRequest,
  descriptor: ManipulationPrimitiveDescriptor | undefined,
  decision: PrimitivePreconditionDecision,
  action: PrimitivePreconditionRecommendedAction,
  gates: readonly PrimitivePreconditionGateResult[],
): string {
  const primitive = descriptor?.primitive_name ?? request.primitive_intent.selected_primitive_ref;
  const gateText = gates.map((gateResult) => `${gateResult.gate}:${gateResult.status}`).join(", ");
  return `${primitive} preconditions ${decision} for ${request.primitive_intent.embodiment_kind}/${request.primitive_intent.end_effector_role}; recommended action ${action}; gates ${gateText}.`;
}

function requiresCurrentTargetEvidence(descriptor: ManipulationPrimitiveDescriptor | undefined): boolean {
  if (descriptor === undefined) return true;
  return descriptor.target_frame_requirements.requires_subject_object
    || descriptor.target_frame_requirements.requires_target_frame
    || descriptor.admission_class !== "safety_motion";
}

function requiresReachDecision(descriptor: ManipulationPrimitiveDescriptor | undefined): boolean {
  return descriptor === undefined ? true : descriptor.admission_class !== "observation_only" && descriptor.admission_class !== "safety_motion";
}

function requiresStanceDecision(descriptor: ManipulationPrimitiveDescriptor | undefined): boolean {
  return descriptor === undefined ? true : descriptor.admission_class !== "observation_only";
}

function requiresContactEvidence(
  descriptor: ManipulationPrimitiveDescriptor | undefined,
  expectation: PrimitiveExecutionIntent["contact_expectation"],
): boolean {
  if (expectation !== "no_contact") return true;
  if (descriptor === undefined) return true;
  return descriptor.admission_class === "contact_motion"
    || descriptor.admission_class === "load_bearing_motion"
    || descriptor.admission_class === "tool_motion"
    || descriptor.primitive_name === "release_object";
}

function requiresActuatorReport(descriptor: ManipulationPrimitiveDescriptor | undefined): boolean {
  return descriptor === undefined ? true : descriptor.admission_class !== "observation_only";
}

function fallbacksFromDecisionInputs(
  gates: readonly PrimitivePreconditionGateResult[],
  issues: readonly ValidationIssue[],
): readonly ManipulationFallbackAction[] {
  const fallbacks: ManipulationFallbackAction[] = [];
  if (issues.some((issue) => issue.code === "VisibilityMissing" || issue.code === "TargetFrameStale")) fallbacks.push("reobserve");
  if (issues.some((issue) => issue.code === "ReachRejected")) fallbacks.push("reposition");
  if (issues.some((issue) => issue.code === "ToolValidationMissing")) fallbacks.push("validate_tool");
  if (issues.some((issue) => issue.code === "ContactReadinessRejected" || issue.code === "ActuatorLimitRejected")) fallbacks.push("reduce_force", "safe_hold");
  if (issues.some((issue) => issue.code === "SafetyEnvelopeRejected" || issue.code === "StanceUnsafe")) fallbacks.push("safe_hold");
  if (gates.some((gateResult) => gateResult.gate === "retry_budget" && gateResult.status !== "satisfied")) fallbacks.push("human_review");
  return freezeArray(uniqueSorted(fallbacks));
}

function reachAction(issues: readonly ValidationIssue[]): PrimitivePreconditionRecommendedAction | undefined {
  if (issues.some((issue) => issue.code === "ToolValidationMissing")) return "validate_tool";
  if (issues.some((issue) => issue.message.toLowerCase().includes("reposition"))) return "reposition_body";
  if (issues.length > 0) return "collect_sensor_evidence";
  return undefined;
}

function stanceAction(issues: readonly ValidationIssue[]): PrimitivePreconditionRecommendedAction | undefined {
  if (issues.some(isError)) return "safe_hold";
  if (issues.length > 0) return "reposition_body";
  return undefined;
}

function contactAction(issues: readonly ValidationIssue[]): PrimitivePreconditionRecommendedAction | undefined {
  if (issues.some(isError)) return "safe_hold";
  if (issues.some((issue) => issue.code === "ContactReadinessRejected")) return "reduce_force";
  if (issues.length > 0) return "collect_sensor_evidence";
  return undefined;
}

function controlAction(issues: readonly ValidationIssue[]): PrimitivePreconditionRecommendedAction | undefined {
  if (issues.some((issue) => issue.code === "ActuatorLimitRejected" && issue.severity === "error")) return "safe_hold";
  if (issues.some((issue) => issue.code === "IKFeasibilityRejected")) return "refresh_geometry";
  if (issues.some((issue) => issue.code === "ActuatorLimitRejected")) return "reduce_force";
  return undefined;
}

function gate(
  name: PrimitivePreconditionGateName,
  status: PrimitivePreconditionGateStatus,
  refs: readonly (Ref | undefined)[],
  summary: string,
  issues: readonly ValidationIssue[],
  recommendedAction?: PrimitivePreconditionRecommendedAction,
): PrimitivePreconditionGateResult {
  const cleanRefs = freezeArray(uniqueSorted(refs.filter((ref): ref is Ref => ref !== undefined).map(sanitizeRef)));
  const base = {
    gate: name,
    status,
    evidence_refs: cleanRefs,
    summary: sanitizeText(summary),
    recommended_action: recommendedAction,
    issues: freezeArray(issues),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function normalizePolicy(config: PrimitivePreconditionValidatorConfig): NormalizedPrimitivePreconditionPolicy {
  return Object.freeze({
    stale_target_after_s: positiveOrDefault(config.stale_target_after_s, DEFAULT_STALE_TARGET_AFTER_S),
    stale_frame_after_s: positiveOrDefault(config.stale_frame_after_s, DEFAULT_STALE_FRAME_AFTER_S),
    max_pose_sigma_m: positiveOrDefault(config.max_pose_sigma_m, DEFAULT_MAX_POSE_SIGMA_M),
    max_orientation_sigma_rad: positiveOrDefault(config.max_orientation_sigma_rad, DEFAULT_MAX_ORIENTATION_SIGMA_RAD),
    min_visibility_confidence: clamp(config.min_visibility_confidence ?? DEFAULT_MIN_VISIBILITY_CONFIDENCE, 0, 1),
    min_reobserve_budget: Math.max(0, Math.floor(config.min_reobserve_budget ?? DEFAULT_MIN_REOBSERVE_BUDGET)),
  });
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value <= 0 ? fallback : value;
}

function validateRef(ref: Ref, path: string, code: PrimitivePreconditionIssueCode, issues: ValidationIssue[]): void {
  if (ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(makeIssue("error", code, path, "Reference must be a non-empty whitespace-free string.", "Use opaque validator-approved manipulation references."));
    return;
  }
  if (HIDDEN_PRECONDITION_PATTERN.test(ref)) {
    issues.push(makeIssue("error", "HiddenPreconditionLeak", path, "Reference contains hidden simulator, backend, QA, or direct actuator detail.", "Use opaque sensor, frame, plan, primitive, and control references only."));
  }
}

function sanitizeText(text: string): string {
  return text.replace(HIDDEN_PRECONDITION_PATTERN, "hidden-detail").replace(/\s+/g, " ").trim();
}

function sanitizeRef(ref: Ref): Ref {
  return ref.replace(HIDDEN_PRECONDITION_PATTERN, "hidden-detail").trim();
}

function isError(issue: ValidationIssue): boolean {
  return issue.severity === "error";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function uniqueSorted<T extends string>(items: readonly T[]): readonly T[] {
  return freezeArray([...new Set(items)].sort());
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

function makeIssue(
  severity: ValidationSeverity,
  code: PrimitivePreconditionIssueCode,
  path: string,
  message: string,
  remediation: string,
): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}
