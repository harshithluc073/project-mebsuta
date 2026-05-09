/**
 * Control geometry bridge for Project Mebsuta spatial control handoff.
 *
 * Blueprint: `architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md`
 * sections 10.4, 10.5, 10.6, 10.8, 10.10, 10.14, 10.15, 10.16, and 10.17.
 *
 * This bridge converts validator-ready File 10 target frames into
 * controller-facing target descriptors. It resolves frame-labeled current and
 * desired poses, computes Cartesian position and quaternion orientation pose
 * errors, preserves residual and uncertainty gates, and emits deterministic
 * IK/control work-order metadata without exposing simulator or QA truth.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type {
  Quaternion,
  Ref,
  Transform,
  ValidationIssue,
  ValidationSeverity,
  Vector3,
} from "../simulation/world_manifest";
import type {
  SpatialToleranceDescriptor,
  TargetFrameDescriptor,
  ValidatorRequirement,
} from "./cognitive_spatial_normalizer";
import type { TransformResolutionReport } from "./frame_graph_service";
import type { CanonicalPoseEstimate } from "./pose_representation_service";
import type { SpatialResidualReport } from "./spatial_constraint_evaluator";

export const CONTROL_GEOMETRY_BRIDGE_SCHEMA_VERSION = "mebsuta.control_geometry_bridge.v1" as const;

const EPSILON = 1e-9;
const HIDDEN_CONTROL_GEOMETRY_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|qa_success|qa_label|qa_only|simulator truth|mesh_name|asset_id|benchmark_truth|oracle_pose)/i;
const TRUTH_FRAME_PATTERN = /(^|[:_\s])(w|q_[a-z0-9_.:-]+|qa_truth)([:_\s]|$)/iu;
const IDENTITY_QUATERNION: Quaternion = Object.freeze([0, 0, 0, 1]) as Quaternion;
const ZERO_VECTOR: Vector3 = Object.freeze([0, 0, 0]) as Vector3;

export type EndEffectorControlRole = "hand" | "wrist" | "mouth" | "gripper" | "paw" | "tool_tip" | "base" | "gaze";
export type InitialSeedPolicy = "current_posture" | "nominal_posture" | "previous_solution" | "safe_preset";
export type SingularityPolicy = "avoid" | "slow" | "reject" | "request_reposition";
export type ControlGeometryDecision = "resolved" | "resolved_with_warnings" | "ambiguous" | "rejected";
export type ControlGeometryRecommendedAction = "handoff_to_ik" | "refresh_geometry" | "repair_target_frame" | "repair_transform_chain" | "repair_truth_boundary" | "safe_hold";
export type ControlGeometryIssueCode =
  | "InputMissing"
  | "ControlContextInvalid"
  | "TargetFrameInvalid"
  | "TargetFrameNotReady"
  | "TargetPoseMissing"
  | "CurrentPoseMissing"
  | "PoseNotControlReady"
  | "FrameMismatch"
  | "TransformMissing"
  | "TransformNotResolved"
  | "PositionGoalMissing"
  | "OrientationGoalMissing"
  | "ToleranceInvalid"
  | "UncertaintyTooHigh"
  | "ResidualNotControlCandidate"
  | "ValidatorRequirementMissing"
  | "HiddenControlGeometryLeak"
  | "TruthFrameBlocked"
  | "PolicyInvalid";

/**
 * Policy gates for converting spatial geometry into deterministic controller
 * handoff descriptors.
 */
export interface ControlGeometryBridgePolicy {
  readonly require_control_candidate_target?: boolean;
  readonly require_current_pose_control_ready?: boolean;
  readonly require_transform_resolution?: boolean;
  readonly require_orientation_goal?: boolean;
  readonly reject_hidden_identifiers?: boolean;
  readonly min_target_confidence?: number;
  readonly max_position_sigma_m?: number;
  readonly max_orientation_sigma_rad?: number;
  readonly default_position_weight?: number;
  readonly default_orientation_weight?: number;
  readonly default_confidence_requirement?: number;
}

/**
 * Control context supplied by the validator/orchestration layer before IK.
 * It carries only approved, finite execution metadata and never raw Gemini
 * joint commands.
 */
export interface ControlGeometryContext {
  readonly approved_plan_ref: Ref;
  readonly embodiment_ref: Ref;
  readonly end_effector_role: EndEffectorControlRole;
  readonly kinematic_chain_ref: Ref;
  readonly safety_envelope_ref: Ref;
  readonly control_profile_ref: Ref;
  readonly primitive_sequence: readonly string[];
  readonly stop_conditions: readonly string[];
  readonly monitor_policy_ref: Ref;
  readonly current_pose_ref?: Ref;
  readonly end_effector_subject_ref?: Ref;
  readonly initial_seed_policy?: InitialSeedPolicy;
  readonly singularity_policy?: SingularityPolicy;
  readonly confidence_requirement?: number;
  readonly constraint_refs?: readonly Ref[];
}

/**
 * Input packet for converting File 10 geometry into File 11 control targets.
 */
export interface ControlGeometryBridgeInput {
  readonly bridge_ref?: Ref;
  readonly target_frames: readonly TargetFrameDescriptor[];
  readonly current_pose_estimates: readonly CanonicalPoseEstimate[];
  readonly transform_resolutions?: readonly TransformResolutionReport[];
  readonly residual_reports?: readonly SpatialResidualReport[];
  readonly context: ControlGeometryContext;
  readonly policy?: ControlGeometryBridgePolicy;
}

/**
 * Controller-facing Cartesian pose error. Position error is `p_d - p`.
 * Orientation error is the signed shortest quaternion residual equivalent to
 * File 10 and File 11's controller-facing `e_R`.
 */
export interface ControlPoseError {
  readonly pose_error_ref: Ref;
  readonly current_pose_ref: Ref;
  readonly target_frame_ref: Ref;
  readonly evaluation_frame_ref: Ref;
  readonly position_error_m?: Vector3;
  readonly position_error_norm_m?: number;
  readonly orientation_error_vector_rad?: Vector3;
  readonly orientation_error_angle_rad?: number;
  readonly weighted_pose_error?: readonly number[];
  readonly position_weight: number;
  readonly orientation_weight: number;
  readonly uncertainty_gate: "passed" | "ambiguous" | "failed";
  readonly notes: readonly string[];
  readonly determinism_hash: string;
}

/**
 * File 11-compatible IK target descriptor emitted from File 10 target geometry.
 */
export interface ControlIKTargetDescriptor {
  readonly ik_target_ref: Ref;
  readonly target_frame_ref: Ref;
  readonly end_effector_role: EndEffectorControlRole;
  readonly kinematic_chain_ref: Ref;
  readonly pose_goal: {
    readonly frame_ref: Ref;
    readonly position_m?: Vector3;
    readonly orientation_xyzw?: Quaternion;
  };
  readonly pose_error: ControlPoseError;
  readonly constraint_set: readonly Ref[];
  readonly tolerance_profile: SpatialToleranceDescriptor;
  readonly initial_seed_policy: InitialSeedPolicy;
  readonly singularity_policy: SingularityPolicy;
  readonly confidence_requirement: number;
  readonly validator_requirements: readonly ValidatorRequirement[];
  readonly residual_report_refs: readonly Ref[];
  readonly determinism_hash: string;
}

/**
 * Control work order assembled for downstream IK, trajectory, and PD layers.
 */
export interface ControlGeometryWorkOrder {
  readonly work_order_ref: Ref;
  readonly approved_plan_ref: Ref;
  readonly target_frame_refs: readonly Ref[];
  readonly primitive_sequence: readonly string[];
  readonly embodiment_ref: Ref;
  readonly safety_envelope_ref: Ref;
  readonly control_profile_ref: Ref;
  readonly stop_conditions: readonly string[];
  readonly monitor_policy_ref: Ref;
  readonly provenance_status: "agent_estimate_only" | "blocked";
  readonly determinism_hash: string;
}

/**
 * Full bridge report for validator-to-IK handoff.
 */
export interface ControlGeometryBridgeReport {
  readonly schema_version: typeof CONTROL_GEOMETRY_BRIDGE_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md";
  readonly bridge_ref: Ref;
  readonly work_order: ControlGeometryWorkOrder;
  readonly ik_targets: readonly ControlIKTargetDescriptor[];
  readonly rejected_target_frame_refs: readonly Ref[];
  readonly decision: ControlGeometryDecision;
  readonly recommended_action: ControlGeometryRecommendedAction;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
  readonly cognitive_visibility: "control_geometry_bridge_report";
}

interface NormalizedControlGeometryBridgePolicy {
  readonly require_control_candidate_target: boolean;
  readonly require_current_pose_control_ready: boolean;
  readonly require_transform_resolution: boolean;
  readonly require_orientation_goal: boolean;
  readonly reject_hidden_identifiers: boolean;
  readonly min_target_confidence: number;
  readonly max_position_sigma_m: number;
  readonly max_orientation_sigma_rad: number;
  readonly default_position_weight: number;
  readonly default_orientation_weight: number;
  readonly default_confidence_requirement: number;
}

interface TargetBuildContext {
  readonly input: ControlGeometryBridgeInput;
  readonly policy: NormalizedControlGeometryBridgePolicy;
  readonly poseByRef: ReadonlyMap<Ref, CanonicalPoseEstimate>;
  readonly poseBySubject: ReadonlyMap<Ref, CanonicalPoseEstimate>;
  readonly transformByPair: ReadonlyMap<string, TransformResolutionReport>;
  readonly residualsByTarget: ReadonlyMap<Ref, readonly SpatialResidualReport[]>;
}

interface NormalizedPoseForControl {
  readonly pose_ref: Ref;
  readonly frame_ref: Ref;
  readonly position_m?: Vector3;
  readonly orientation_xyzw?: Quaternion;
  readonly position_sigma_m?: number;
  readonly orientation_sigma_rad?: number;
  readonly transform_report_ref?: Ref;
}

const DEFAULT_POLICY: NormalizedControlGeometryBridgePolicy = Object.freeze({
  require_control_candidate_target: true,
  require_current_pose_control_ready: true,
  require_transform_resolution: true,
  require_orientation_goal: false,
  reject_hidden_identifiers: true,
  min_target_confidence: 0.55,
  max_position_sigma_m: 0.05,
  max_orientation_sigma_rad: 0.16,
  default_position_weight: 1,
  default_orientation_weight: 1,
  default_confidence_requirement: 0.6,
});

/**
 * Executable File 10 `ControlGeometryBridge`.
 */
export class ControlGeometryBridge {
  private readonly policy: NormalizedControlGeometryBridgePolicy;

  public constructor(policy: ControlGeometryBridgePolicy = {}) {
    this.policy = mergePolicy(DEFAULT_POLICY, policy);
  }

  /**
   * Resolves target frames and current end-effector geometry into
   * deterministic IK descriptors and a finite control work order.
   */
  public resolveControlGeometry(input: ControlGeometryBridgeInput): ControlGeometryBridgeReport {
    const policy = mergePolicy(this.policy, input.policy ?? {});
    const issues: ValidationIssue[] = [];
    validatePolicy(policy, issues);
    validateInputShell(input, policy, issues);
    const context = buildContext(input, policy);

    const targets = input.target_frames.map((targetFrame, index) => buildIKTarget(context, targetFrame, index, issues));
    const ikTargets = targets.filter(isControlIKTargetDescriptor);
    const rejected = input.target_frames
      .filter((targetFrame) => !ikTargets.some((target) => target.target_frame_ref === targetFrame.target_frame_ref))
      .map((targetFrame) => sanitizeRef(targetFrame.target_frame_ref || "target_frame_ref_missing"))
      .sort();
    const decision = decideBridge(ikTargets, rejected, issues);
    const recommendedAction = chooseRecommendedAction(issues, decision);
    const bridgeRef = input.bridge_ref === undefined
      ? makeRef("control_geometry_bridge", input.context.approved_plan_ref, decision)
      : sanitizeRef(input.bridge_ref);
    const workOrder = buildWorkOrder(input, ikTargets, decision);

    return Object.freeze({
      schema_version: CONTROL_GEOMETRY_BRIDGE_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md",
      bridge_ref: bridgeRef,
      work_order: workOrder,
      ik_targets: freezeArray(ikTargets),
      rejected_target_frame_refs: freezeArray(rejected),
      decision,
      recommended_action: recommendedAction,
      issues: freezeArray(issues),
      ok: decision === "resolved",
      determinism_hash: computeDeterminismHash({
        bridgeRef,
        workOrder: workOrder.work_order_ref,
        targets: ikTargets.map((target) => [target.ik_target_ref, target.pose_error.uncertainty_gate]),
        rejected,
        decision,
        issueCodes: issues.map((issue) => issue.code).sort(),
      }),
      cognitive_visibility: "control_geometry_bridge_report",
    });
  }
}

/**
 * Functional API matching File 10's controller handoff geometry contract.
 */
export function resolveControlGeometry(input: ControlGeometryBridgeInput): ControlGeometryBridgeReport {
  return new ControlGeometryBridge(input.policy).resolveControlGeometry(input);
}

function buildContext(
  input: ControlGeometryBridgeInput,
  policy: NormalizedControlGeometryBridgePolicy,
): TargetBuildContext {
  const poseByRef = new Map<Ref, CanonicalPoseEstimate>();
  const poseBySubject = new Map<Ref, CanonicalPoseEstimate>();
  for (const pose of input.current_pose_estimates) {
    poseByRef.set(pose.pose_ref, pose);
    if (!poseBySubject.has(pose.subject_ref)) poseBySubject.set(pose.subject_ref, pose);
  }
  const transformByPair = new Map<string, TransformResolutionReport>();
  for (const report of input.transform_resolutions ?? []) {
    transformByPair.set(pairKey(report.source_frame_ref, report.target_frame_ref), report);
  }
  const residualsByTarget = new Map<Ref, SpatialResidualReport[]>();
  for (const report of input.residual_reports ?? []) {
    if (report.target_frame_ref === undefined) continue;
    const existing = residualsByTarget.get(report.target_frame_ref) ?? [];
    existing.push(report);
    residualsByTarget.set(report.target_frame_ref, existing);
  }
  return Object.freeze({
    input,
    policy,
    poseByRef,
    poseBySubject,
    transformByPair,
    residualsByTarget,
  });
}

function buildIKTarget(
  context: TargetBuildContext,
  targetFrame: TargetFrameDescriptor,
  index: number,
  sharedIssues: ValidationIssue[],
): ControlIKTargetDescriptor | undefined {
  const path = `$.target_frames[${index}]`;
  const issues: ValidationIssue[] = [];
  validateTargetFrame(targetFrame, path, context.policy, issues);
  const currentPose = resolveCurrentPose(context, path, issues);
  const targetPose = resolveTargetPose(context, targetFrame, path, issues);
  if (currentPose === undefined || targetPose === undefined) {
    sharedIssues.push(...issues);
    return undefined;
  }

  const evaluationFrame = targetFrame.reference_frame;
  const normalizedCurrent = normalizePoseFrame(currentPose, evaluationFrame, context, `${path}.current_pose`, issues);
  const normalizedTarget = normalizeTargetFrame(targetPose, evaluationFrame, context, targetFrame, `${path}.pose_or_relation`, issues);
  if (normalizedCurrent === undefined || normalizedTarget === undefined) {
    sharedIssues.push(...issues);
    return undefined;
  }

  const residuals = context.residualsByTarget.get(targetFrame.target_frame_ref) ?? [];
  validateResidualHandoff(residuals, targetFrame, path, issues);
  const poseError = computeControlPoseError(context, targetFrame, normalizedCurrent, normalizedTarget, path, issues);
  const confidenceRequirement = clamp01(context.input.context.confidence_requirement ?? context.policy.default_confidence_requirement);
  const ikTargetRef = makeRef("ik_target", targetFrame.target_frame_ref, context.input.context.end_effector_role);
  const constraintSet = uniqueSorted([
    ...(context.input.context.constraint_refs ?? []),
    ...targetFrame.constraints.map((constraint) => constraint.constraint_ref),
    ...residuals.map((report) => report.constraint_ref),
    context.input.context.safety_envelope_ref,
  ]);
  const descriptor = Object.freeze({
    ik_target_ref: ikTargetRef,
    target_frame_ref: targetFrame.target_frame_ref,
    end_effector_role: context.input.context.end_effector_role,
    kinematic_chain_ref: context.input.context.kinematic_chain_ref,
    pose_goal: Object.freeze({
      frame_ref: evaluationFrame,
      position_m: normalizedTarget.position_m,
      orientation_xyzw: normalizedTarget.orientation_xyzw,
    }),
    pose_error: poseError,
    constraint_set: constraintSet,
    tolerance_profile: targetFrame.constraints[0]?.tolerance ?? toleranceFromTarget(targetFrame),
    initial_seed_policy: context.input.context.initial_seed_policy ?? "current_posture",
    singularity_policy: context.input.context.singularity_policy ?? "reject",
    confidence_requirement: confidenceRequirement,
    validator_requirements: freezeArray(targetFrame.validator_requirements),
    residual_report_refs: freezeArray(residuals.map((report) => report.residual_report_ref).sort()),
    determinism_hash: computeDeterminismHash({
      ikTargetRef,
      target: targetFrame.target_frame_ref,
      role: context.input.context.end_effector_role,
      chain: context.input.context.kinematic_chain_ref,
      poseGoal: normalizedTarget,
      poseError: poseError.determinism_hash,
      constraints: constraintSet,
      confidenceRequirement,
    }),
  });

  sharedIssues.push(...issues);
  if (issues.some((issue) => issue.severity === "error")) return undefined;
  return descriptor;
}

function resolveCurrentPose(
  context: TargetBuildContext,
  path: string,
  issues: ValidationIssue[],
): CanonicalPoseEstimate | undefined {
  const requestedPoseRef = context.input.context.current_pose_ref;
  const requestedSubjectRef = context.input.context.end_effector_subject_ref;
  const byRef = requestedPoseRef === undefined ? undefined : context.poseByRef.get(requestedPoseRef);
  const bySubject = requestedSubjectRef === undefined ? undefined : context.poseBySubject.get(requestedSubjectRef);
  const fallback = [...context.poseByRef.values()]
    .filter((pose) => pose.usage === "control" || pose.control_ready)
    .sort((a, b) => a.pose_ref.localeCompare(b.pose_ref))[0];
  const pose = byRef ?? bySubject ?? fallback;
  if (pose === undefined) {
    issues.push(makeIssue("error", "CurrentPoseMissing", `${path}.current_pose`, "Control handoff requires a current end-effector, tool, base, or gaze pose.", "Provide a canonical control-ready current pose."));
    return undefined;
  }
  if (context.policy.require_current_pose_control_ready && !pose.control_ready) {
    issues.push(makeIssue("error", "PoseNotControlReady", `${path}.current_pose`, "Selected current pose is not marked control-ready.", "Reobserve or canonicalize the pose with control usage before IK handoff."));
  }
  return pose;
}

function resolveTargetPose(
  context: TargetBuildContext,
  targetFrame: TargetFrameDescriptor,
  path: string,
  issues: ValidationIssue[],
): NormalizedPoseForControl | undefined {
  const value = targetFrame.pose_or_relation;
  const poseRef = value.target_pose_ref ?? value.target_orientation_ref;
  const sourcePose = poseRef === undefined ? undefined : context.poseByRef.get(poseRef);
  const position = value.target_position_m ?? sourcePose?.position_m;
  const orientation = sourcePose?.orientation?.quaternion_xyzw;
  if (position === undefined) {
    issues.push(makeIssue("error", "PositionGoalMissing", `${path}.pose_or_relation`, "Control handoff requires a desired target position in meters.", "Attach target_position_m or a target_pose_ref with position_m."));
  }
  if (context.policy.require_orientation_goal && orientation === undefined) {
    issues.push(makeIssue("error", "OrientationGoalMissing", `${path}.pose_or_relation`, "Policy requires a desired orientation quaternion for this control target.", "Attach target_pose_ref or target_orientation_ref with exact orientation."));
  }
  if (sourcePose === undefined && poseRef !== undefined) {
    issues.push(makeIssue("error", "TargetPoseMissing", `${path}.pose_or_relation.target_pose_ref`, "Target pose reference is not present in current_pose_estimates.", "Provide the canonical target pose estimate before bridging to control."));
  }
  if (position === undefined) return undefined;
  return Object.freeze({
    pose_ref: poseRef ?? makeRef("target_pose", targetFrame.target_frame_ref),
    frame_ref: sourcePose?.frame_ref ?? targetFrame.reference_frame,
    position_m: freezeVector3(position),
    orientation_xyzw: orientation,
    position_sigma_m: combineOptionalSigmas([sourcePose?.uncertainty.position_sigma_m, targetFrame.uncertainty.position_sigma_m]),
    orientation_sigma_rad: combineOptionalSigmas([sourcePose?.uncertainty.orientation_sigma_rad, targetFrame.uncertainty.orientation_sigma_rad]),
    transform_report_ref: undefined,
  });
}

function normalizePoseFrame(
  pose: CanonicalPoseEstimate,
  evaluationFrame: Ref,
  context: TargetBuildContext,
  path: string,
  issues: ValidationIssue[],
): NormalizedPoseForControl | undefined {
  if (pose.position_m === undefined) {
    issues.push(makeIssue("error", "CurrentPoseMissing", `${path}.position_m`, "Current control pose lacks a position estimate.", "Provide a position-bearing canonical pose."));
    return undefined;
  }
  const base = Object.freeze({
    pose_ref: pose.pose_ref,
    frame_ref: pose.frame_ref,
    position_m: pose.position_m,
    orientation_xyzw: pose.orientation?.quaternion_xyzw,
    position_sigma_m: pose.uncertainty.position_sigma_m,
    orientation_sigma_rad: pose.uncertainty.orientation_sigma_rad,
    transform_report_ref: pose.transform_report_ref,
  });
  return pose.frame_ref === evaluationFrame ? base : transformPose(base, evaluationFrame, context, path, issues);
}

function normalizeTargetFrame(
  target: NormalizedPoseForControl,
  evaluationFrame: Ref,
  context: TargetBuildContext,
  targetFrame: TargetFrameDescriptor,
  path: string,
  issues: ValidationIssue[],
): NormalizedPoseForControl | undefined {
  if (target.frame_ref === evaluationFrame) return target;
  return transformPose(target, evaluationFrame, context, `${path}.${targetFrame.target_frame_ref}`, issues);
}

function transformPose(
  pose: NormalizedPoseForControl,
  targetFrameRef: Ref,
  context: TargetBuildContext,
  path: string,
  issues: ValidationIssue[],
): NormalizedPoseForControl | undefined {
  const report = context.transformByPair.get(pairKey(pose.frame_ref, targetFrameRef));
  if (report === undefined) {
    issues.push(makeIssue(context.policy.require_transform_resolution ? "error" : "warning", "TransformMissing", `${path}.frame_ref`, `No transform resolution from ${pose.frame_ref} to ${targetFrameRef}.`, "Resolve the frame chain before issuing IK/control geometry."));
    return context.policy.require_transform_resolution ? undefined : pose;
  }
  if (!report.ok) {
    issues.push(makeIssue("error", "TransformNotResolved", `${path}.transform_resolution`, "Transform report is not resolved and cannot support control geometry.", "Refresh or repair the transform chain."));
    return undefined;
  }
  validateNoTruthFrame(report.source_frame_ref, `${path}.source_frame_ref`, issues);
  validateNoTruthFrame(report.target_frame_ref, `${path}.target_frame_ref`, issues);
  const transformedPosition = pose.position_m === undefined ? undefined : applyTransformToPoint(report.transform_target_from_source, pose.position_m);
  const transformedOrientation = pose.orientation_xyzw === undefined ? undefined : canonicalQuaternion(quaternionMultiply(report.transform_target_from_source.orientation_xyzw, pose.orientation_xyzw));
  return Object.freeze({
    pose_ref: pose.pose_ref,
    frame_ref: targetFrameRef,
    position_m: transformedPosition,
    orientation_xyzw: transformedOrientation,
    position_sigma_m: combineOptionalSigmas([pose.position_sigma_m, report.uncertainty_m]),
    orientation_sigma_rad: pose.orientation_sigma_rad,
    transform_report_ref: report.resolution_ref,
  });
}

function computeControlPoseError(
  context: TargetBuildContext,
  targetFrame: TargetFrameDescriptor,
  current: NormalizedPoseForControl,
  target: NormalizedPoseForControl,
  path: string,
  issues: ValidationIssue[],
): ControlPoseError {
  const notes: string[] = [];
  const positionError = current.position_m !== undefined && target.position_m !== undefined
    ? subtractVectors(target.position_m, current.position_m)
    : undefined;
  if (positionError === undefined) notes.push("position_error=unavailable");
  const orientationResidual = current.orientation_xyzw !== undefined && target.orientation_xyzw !== undefined
    ? quaternionOrientationError(current.orientation_xyzw, target.orientation_xyzw)
    : undefined;
  if (orientationResidual === undefined) notes.push("orientation_error=unavailable");

  const positionWeight = positiveOrDefault(context.input.policy?.default_position_weight, context.policy.default_position_weight);
  const orientationWeight = positiveOrDefault(context.input.policy?.default_orientation_weight, context.policy.default_orientation_weight);
  const weighted = [
    ...(positionError === undefined ? [] : positionError.map((value) => round6(value * positionWeight))),
    ...(orientationResidual === undefined ? [] : orientationResidual.error_vector_rad.map((value) => round6(value * orientationWeight))),
  ];
  const uncertaintyGate = classifyUncertaintyGate(context, current, target, targetFrame, path, issues, notes);
  const poseErrorRef = makeRef("control_pose_error", current.pose_ref, targetFrame.target_frame_ref);

  return Object.freeze({
    pose_error_ref: poseErrorRef,
    current_pose_ref: current.pose_ref,
    target_frame_ref: targetFrame.target_frame_ref,
    evaluation_frame_ref: targetFrame.reference_frame,
    position_error_m: positionError,
    position_error_norm_m: positionError === undefined ? undefined : round6(vectorNorm(positionError)),
    orientation_error_vector_rad: orientationResidual?.error_vector_rad,
    orientation_error_angle_rad: orientationResidual?.angle_rad,
    weighted_pose_error: weighted.length === 0 ? undefined : freezeArray(weighted),
    position_weight: positionWeight,
    orientation_weight: orientationWeight,
    uncertainty_gate: uncertaintyGate,
    notes: freezeArray(notes),
    determinism_hash: computeDeterminismHash({
      poseErrorRef,
      current: current.pose_ref,
      target: targetFrame.target_frame_ref,
      frame: targetFrame.reference_frame,
      positionError,
      orientationResidual,
      weighted,
      uncertaintyGate,
    }),
  });
}

function classifyUncertaintyGate(
  context: TargetBuildContext,
  current: NormalizedPoseForControl,
  target: NormalizedPoseForControl,
  targetFrame: TargetFrameDescriptor,
  path: string,
  issues: ValidationIssue[],
  notes: string[],
): ControlPoseError["uncertainty_gate"] {
  const positionSigma = combineOptionalSigmas([current.position_sigma_m, target.position_sigma_m, targetFrame.uncertainty.position_sigma_m]);
  const orientationSigma = combineOptionalSigmas([current.orientation_sigma_rad, target.orientation_sigma_rad, targetFrame.uncertainty.orientation_sigma_rad]);
  const confidence = 1 - Math.min(1, targetFrame.uncertainty.exceeds_tolerance ? 0.5 : 0);
  if (targetFrame.uncertainty.exceeds_tolerance || confidence < context.policy.min_target_confidence) {
    issues.push(makeIssue("warning", "UncertaintyTooHigh", `${path}.uncertainty`, "Target uncertainty is too high for a clean control handoff.", "Reobserve or refine the target before IK."));
    notes.push("uncertainty_gate=ambiguous_target_uncertainty");
    return "ambiguous";
  }
  if (positionSigma !== undefined && positionSigma > context.policy.max_position_sigma_m) {
    issues.push(makeIssue("warning", "UncertaintyTooHigh", `${path}.position_uncertainty`, "Combined position uncertainty exceeds the control bridge policy.", "Refresh spatial evidence before execution."));
    notes.push(`position_sigma_m=${formatNumber(positionSigma)}`);
    return "ambiguous";
  }
  if (orientationSigma !== undefined && orientationSigma > context.policy.max_orientation_sigma_rad) {
    issues.push(makeIssue("warning", "UncertaintyTooHigh", `${path}.orientation_uncertainty`, "Combined orientation uncertainty exceeds the control bridge policy.", "Refresh orientation evidence or lower the target to position-only control."));
    notes.push(`orientation_sigma_rad=${formatNumber(orientationSigma)}`);
    return "ambiguous";
  }
  notes.push("uncertainty_gate=passed");
  return "passed";
}

function buildWorkOrder(
  input: ControlGeometryBridgeInput,
  ikTargets: readonly ControlIKTargetDescriptor[],
  decision: ControlGeometryDecision,
): ControlGeometryWorkOrder {
  const provenanceStatus = decision === "rejected" ? "blocked" : "agent_estimate_only";
  const workOrderRef = makeRef("control_work_order", input.context.approved_plan_ref, decision);
  return Object.freeze({
    work_order_ref: workOrderRef,
    approved_plan_ref: input.context.approved_plan_ref,
    target_frame_refs: freezeArray(ikTargets.map((target) => target.target_frame_ref).sort()),
    primitive_sequence: freezeArray(input.context.primitive_sequence.map(sanitizeText)),
    embodiment_ref: input.context.embodiment_ref,
    safety_envelope_ref: input.context.safety_envelope_ref,
    control_profile_ref: input.context.control_profile_ref,
    stop_conditions: freezeArray(input.context.stop_conditions.map(sanitizeText)),
    monitor_policy_ref: input.context.monitor_policy_ref,
    provenance_status: provenanceStatus,
    determinism_hash: computeDeterminismHash({
      workOrderRef,
      approvedPlan: input.context.approved_plan_ref,
      targets: ikTargets.map((target) => target.target_frame_ref).sort(),
      primitives: input.context.primitive_sequence,
      stopConditions: input.context.stop_conditions,
      provenanceStatus,
    }),
  });
}

function validateInputShell(
  input: ControlGeometryBridgeInput,
  policy: NormalizedControlGeometryBridgePolicy,
  issues: ValidationIssue[],
): void {
  if (input.target_frames.length === 0) {
    issues.push(makeIssue("error", "InputMissing", "$.target_frames", "ControlGeometryBridge requires at least one target frame.", "Provide validator-ready or control-candidate target frames."));
  }
  if (input.current_pose_estimates.length === 0) {
    issues.push(makeIssue("error", "InputMissing", "$.current_pose_estimates", "ControlGeometryBridge requires current canonical pose estimates.", "Provide current end-effector, tool, base, or gaze poses."));
  }
  validateContext(input.context, issues);
  for (const [index, pose] of input.current_pose_estimates.entries()) {
    validateSafeRef(pose.pose_ref, `$.current_pose_estimates[${index}].pose_ref`, "CurrentPoseMissing", policy, issues);
    validateNoTruthFrame(pose.frame_ref, `$.current_pose_estimates[${index}].frame_ref`, issues);
  }
  for (const [index, report] of (input.transform_resolutions ?? []).entries()) {
    validateSafeRef(report.resolution_ref, `$.transform_resolutions[${index}].resolution_ref`, "TransformMissing", policy, issues);
    validateNoTruthFrame(report.source_frame_ref, `$.transform_resolutions[${index}].source_frame_ref`, issues);
    validateNoTruthFrame(report.target_frame_ref, `$.transform_resolutions[${index}].target_frame_ref`, issues);
  }
}

function validateContext(context: ControlGeometryContext, issues: ValidationIssue[]): void {
  validateRequiredRef(context.approved_plan_ref, "$.context.approved_plan_ref", issues);
  validateRequiredRef(context.embodiment_ref, "$.context.embodiment_ref", issues);
  validateRequiredRef(context.kinematic_chain_ref, "$.context.kinematic_chain_ref", issues);
  validateRequiredRef(context.safety_envelope_ref, "$.context.safety_envelope_ref", issues);
  validateRequiredRef(context.control_profile_ref, "$.context.control_profile_ref", issues);
  validateRequiredRef(context.monitor_policy_ref, "$.context.monitor_policy_ref", issues);
  if (context.primitive_sequence.length === 0) {
    issues.push(makeIssue("error", "ControlContextInvalid", "$.context.primitive_sequence", "Control work order requires a finite primitive sequence.", "Provide at least one approved primitive phase."));
  }
  if (context.stop_conditions.length === 0) {
    issues.push(makeIssue("error", "ControlContextInvalid", "$.context.stop_conditions", "Control work order requires finite stop conditions.", "Provide completion, timeout, error, contact, safety, or operator-stop conditions."));
  }
  const confidence = context.confidence_requirement;
  if (confidence !== undefined && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    issues.push(makeIssue("error", "ControlContextInvalid", "$.context.confidence_requirement", "Confidence requirement must be finite in [0, 1].", "Use normalized confidence."));
  }
}

function validateTargetFrame(
  targetFrame: TargetFrameDescriptor,
  path: string,
  policy: NormalizedControlGeometryBridgePolicy,
  issues: ValidationIssue[],
): void {
  validateSafeRef(targetFrame.target_frame_ref, `${path}.target_frame_ref`, "TargetFrameInvalid", policy, issues);
  validateSafeRef(targetFrame.reference_frame, `${path}.reference_frame`, "TargetFrameInvalid", policy, issues);
  validateNoTruthFrame(targetFrame.reference_frame, `${path}.reference_frame`, issues);
  for (const [index, ref] of targetFrame.evidence_refs.entries()) {
    validateSafeRef(ref, `${path}.evidence_refs[${index}]`, "TargetFrameInvalid", policy, issues);
  }
  if (policy.require_control_candidate_target && targetFrame.lifecycle_state !== "control_candidate") {
    issues.push(makeIssue("error", "TargetFrameNotReady", `${path}.lifecycle_state`, "Control handoff requires a target frame in control_candidate lifecycle state.", "Run geometry, reach, collision, stability, IK admission, and safety validators before control."));
  }
  if (targetFrame.lifecycle_state !== "validator_ready" && targetFrame.lifecycle_state !== "control_candidate") {
    issues.push(makeIssue("error", "TargetFrameNotReady", `${path}.lifecycle_state`, "Target frame is not validator-ready for control geometry.", "Normalize and validate the target frame before handoff."));
  }
  if (!targetFrame.validator_requirements.includes("geometry")) {
    issues.push(makeIssue("warning", "ValidatorRequirementMissing", `${path}.validator_requirements`, "Target frame lacks an explicit geometry validator requirement.", "Include geometry in validator_requirements."));
  }
  if (!targetFrame.validator_requirements.includes("ik") && !targetFrame.validator_requirements.includes("controller_feasibility")) {
    issues.push(makeIssue("warning", "ValidatorRequirementMissing", `${path}.validator_requirements`, "Target frame lacks IK/controller feasibility requirements.", "Include ik or controller_feasibility in validator_requirements."));
  }
  validateTolerance(targetFrame.constraints[0]?.tolerance ?? toleranceFromTarget(targetFrame), `${path}.tolerance`, issues);
}

function validateResidualHandoff(
  residuals: readonly SpatialResidualReport[],
  targetFrame: TargetFrameDescriptor,
  path: string,
  issues: ValidationIssue[],
): void {
  for (const report of residuals) {
    if (report.result === "fail_unsafe" || report.correctability === "unsafe") {
      issues.push(makeIssue("error", "ResidualNotControlCandidate", `${path}.residual_reports`, "Unsafe spatial residual blocks control handoff.", "Route to safe hold or repair before issuing IK."));
    } else if (report.result === "ambiguous" || report.result === "cannot_assess") {
      issues.push(makeIssue("warning", "ResidualNotControlCandidate", `${path}.residual_reports`, "Ambiguous residual should be refreshed before clean control handoff.", "Reobserve or rerun residual evaluation."));
    }
  }
  const targetConstraintRefs = new Set(targetFrame.constraints.map((constraint) => constraint.constraint_ref));
  const missingResidual = targetFrame.constraints.some((constraint) => !residuals.some((report) => report.constraint_ref === constraint.constraint_ref));
  if (targetConstraintRefs.size > 0 && missingResidual) {
    issues.push(makeIssue("warning", "ResidualNotControlCandidate", `${path}.residual_reports`, "Not every target-frame constraint has an attached residual report.", "Run SpatialConstraintEvaluator before final controller admission."));
  }
}

function validateTolerance(
  tolerance: SpatialToleranceDescriptor,
  path: string,
  issues: ValidationIssue[],
): void {
  const numeric = [
    tolerance.position_tolerance_m,
    tolerance.orientation_tolerance_rad,
    tolerance.distance_tolerance_m,
    tolerance.clearance_margin_m,
  ].filter(isNumber);
  if (numeric.length === 0 && tolerance.qualitative_threshold === undefined) {
    issues.push(makeIssue("error", "ToleranceInvalid", path, "Control handoff requires numeric or qualitative tolerance metadata.", "Attach a File 10 tolerance profile."));
  }
  if (numeric.some((value) => !Number.isFinite(value) || value <= 0)) {
    issues.push(makeIssue("error", "ToleranceInvalid", path, "Tolerance values must be positive finite meters or radians.", "Use positive File 10 canonical-unit tolerances."));
  }
}

function validatePolicy(policy: NormalizedControlGeometryBridgePolicy, issues: ValidationIssue[]): void {
  for (const [path, value] of [
    ["$.policy.min_target_confidence", policy.min_target_confidence],
    ["$.policy.max_position_sigma_m", policy.max_position_sigma_m],
    ["$.policy.max_orientation_sigma_rad", policy.max_orientation_sigma_rad],
    ["$.policy.default_position_weight", policy.default_position_weight],
    ["$.policy.default_orientation_weight", policy.default_orientation_weight],
    ["$.policy.default_confidence_requirement", policy.default_confidence_requirement],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      issues.push(makeIssue("error", "PolicyInvalid", path, "ControlGeometryBridge policy numbers must be finite and nonnegative.", "Use finite nonnegative policy thresholds."));
    }
  }
  if (policy.min_target_confidence > 1 || policy.default_confidence_requirement > 1) {
    issues.push(makeIssue("error", "PolicyInvalid", "$.policy.confidence", "Confidence thresholds must be in [0, 1].", "Use normalized confidence thresholds."));
  }
}

function decideBridge(
  ikTargets: readonly ControlIKTargetDescriptor[],
  rejected: readonly Ref[],
  issues: readonly ValidationIssue[],
): ControlGeometryDecision {
  if (issues.some((issue) => issue.code === "PolicyInvalid" || issue.code === "TruthFrameBlocked" || issue.code === "HiddenControlGeometryLeak")) return "rejected";
  if (ikTargets.length === 0 && rejected.length > 0) return "rejected";
  if (issues.some((issue) => issue.severity === "error")) return "rejected";
  if (ikTargets.some((target) => target.pose_error.uncertainty_gate === "ambiguous") || issues.some((issue) => issue.severity === "warning")) return "resolved_with_warnings";
  return "resolved";
}

function chooseRecommendedAction(
  issues: readonly ValidationIssue[],
  decision: ControlGeometryDecision,
): ControlGeometryRecommendedAction {
  if (decision === "resolved") return "handoff_to_ik";
  if (issues.some((issue) => issue.code === "TruthFrameBlocked" || issue.code === "HiddenControlGeometryLeak")) return "repair_truth_boundary";
  if (issues.some((issue) => issue.code === "TransformMissing" || issue.code === "TransformNotResolved" || issue.code === "FrameMismatch")) return "repair_transform_chain";
  if (issues.some((issue) => issue.code === "TargetFrameInvalid" || issue.code === "TargetFrameNotReady" || issue.code === "TargetPoseMissing" || issue.code === "PositionGoalMissing" || issue.code === "ToleranceInvalid")) return "repair_target_frame";
  if (issues.some((issue) => issue.code === "CurrentPoseMissing" || issue.code === "PoseNotControlReady" || issue.code === "UncertaintyTooHigh" || issue.code === "ResidualNotControlCandidate")) return "refresh_geometry";
  return "safe_hold";
}

function toleranceFromTarget(targetFrame: TargetFrameDescriptor): SpatialToleranceDescriptor {
  return Object.freeze({
    tolerance_profile_ref: targetFrame.tolerance_profile_ref,
    tolerance_class: "approach",
    position_tolerance_m: 0.03,
    orientation_tolerance_rad: 0.12,
    distance_tolerance_m: 0.04,
    clearance_margin_m: 0.05,
    uncertainty_must_be_below_tolerance: true,
  });
}

function mergePolicy(
  base: NormalizedControlGeometryBridgePolicy,
  override: ControlGeometryBridgePolicy,
): NormalizedControlGeometryBridgePolicy {
  return Object.freeze({
    require_control_candidate_target: override.require_control_candidate_target ?? base.require_control_candidate_target,
    require_current_pose_control_ready: override.require_current_pose_control_ready ?? base.require_current_pose_control_ready,
    require_transform_resolution: override.require_transform_resolution ?? base.require_transform_resolution,
    require_orientation_goal: override.require_orientation_goal ?? base.require_orientation_goal,
    reject_hidden_identifiers: override.reject_hidden_identifiers ?? base.reject_hidden_identifiers,
    min_target_confidence: clamp01(override.min_target_confidence ?? base.min_target_confidence),
    max_position_sigma_m: positiveOrDefault(override.max_position_sigma_m, base.max_position_sigma_m),
    max_orientation_sigma_rad: positiveOrDefault(override.max_orientation_sigma_rad, base.max_orientation_sigma_rad),
    default_position_weight: positiveOrDefault(override.default_position_weight, base.default_position_weight),
    default_orientation_weight: positiveOrDefault(override.default_orientation_weight, base.default_orientation_weight),
    default_confidence_requirement: clamp01(override.default_confidence_requirement ?? base.default_confidence_requirement),
  });
}

function applyTransformToPoint(transform: Transform, point: Vector3): Vector3 {
  return addVectors(transform.position_m, rotateVector(transform.orientation_xyzw, point));
}

function quaternionOrientationError(current: Quaternion, target: Quaternion): { readonly error_vector_rad: Vector3; readonly angle_rad: number } {
  const relative = canonicalQuaternion(quaternionMultiply(target, quaternionConjugate(current)));
  const angle = 2 * Math.atan2(vectorNorm([relative[0], relative[1], relative[2]]), Math.abs(relative[3]));
  const sign = relative[3] < 0 ? -1 : 1;
  const vectorPartNorm = Math.hypot(relative[0], relative[1], relative[2]);
  const axis = vectorPartNorm < EPSILON ? ZERO_VECTOR : freezeVector3([relative[0] / vectorPartNorm, relative[1] / vectorPartNorm, relative[2] / vectorPartNorm]);
  return Object.freeze({
    error_vector_rad: freezeVector3([axis[0] * angle * sign, axis[1] * angle * sign, axis[2] * angle * sign]),
    angle_rad: round6(angle),
  });
}

function quaternionMultiply(a: Quaternion, b: Quaternion): Quaternion {
  const ax = a[0];
  const ay = a[1];
  const az = a[2];
  const aw = a[3];
  const bx = b[0];
  const by = b[1];
  const bz = b[2];
  const bw = b[3];
  return canonicalQuaternion([
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]);
}

function quaternionConjugate(value: Quaternion): Quaternion {
  return freezeQuaternion([-value[0], -value[1], -value[2], value[3]]);
}

function canonicalQuaternion(value: readonly number[]): Quaternion {
  const length = Math.hypot(value[0], value[1], value[2], value[3]);
  if (length < EPSILON) return IDENTITY_QUATERNION;
  const sign = value[3] < 0 ? -1 : 1;
  return freezeQuaternion([sign * value[0] / length, sign * value[1] / length, sign * value[2] / length, sign * value[3] / length]);
}

function rotateVector(orientation: Quaternion, vector: Vector3): Vector3 {
  const vQuat: Quaternion = [vector[0], vector[1], vector[2], 0];
  const rotated = quaternionMultiply(quaternionMultiply(canonicalQuaternion(orientation), vQuat), quaternionConjugate(canonicalQuaternion(orientation)));
  return freezeVector3([rotated[0], rotated[1], rotated[2]]);
}

function subtractVectors(target: Vector3, current: Vector3): Vector3 {
  return freezeVector3([target[0] - current[0], target[1] - current[1], target[2] - current[2]]);
}

function addVectors(a: Vector3, b: Vector3): Vector3 {
  return freezeVector3([a[0] + b[0], a[1] + b[1], a[2] + b[2]]);
}

function vectorNorm(value: readonly number[]): number {
  return Math.sqrt(value.reduce((sum, component) => sum + component * component, 0));
}

function combineOptionalSigmas(values: readonly (number | undefined)[]): number | undefined {
  const numeric = values.filter(isNumber);
  if (numeric.length === 0) return undefined;
  return round6(Math.hypot(...numeric));
}

function pairKey(sourceFrameRef: Ref, targetFrameRef: Ref): string {
  return `${sourceFrameRef}->${targetFrameRef}`;
}

function validateRequiredRef(value: Ref, path: string, issues: ValidationIssue[]): void {
  if (value.trim().length === 0 || /\s/u.test(value)) {
    issues.push(makeIssue("error", "ControlContextInvalid", path, "Control context refs must be non-empty and whitespace-free.", "Use opaque sanitized refs."));
  }
  validateNoHiddenText(value, path, issues);
}

function validateSafeRef(
  value: Ref,
  path: string,
  code: ControlGeometryIssueCode,
  policy: NormalizedControlGeometryBridgePolicy,
  issues: ValidationIssue[],
): void {
  if (value.trim().length === 0 || /\s/u.test(value)) {
    issues.push(makeIssue("error", code, path, "Reference must be non-empty and whitespace-free.", "Use an opaque sanitized ref."));
  }
  if (policy.reject_hidden_identifiers) validateNoHiddenText(value, path, issues);
}

function validateNoTruthFrame(value: Ref, path: string, issues: ValidationIssue[]): void {
  if (value === "W" || value.startsWith("Q_") || TRUTH_FRAME_PATTERN.test(value)) {
    issues.push(makeIssue("error", "TruthFrameBlocked", path, "Control geometry cannot consume simulator world or QA truth frames.", "Use W_hat, body, sensor, object, target, contact, or tool estimate frames."));
  }
}

function validateNoHiddenText(value: string, path: string, issues: ValidationIssue[]): void {
  if (HIDDEN_CONTROL_GEOMETRY_PATTERN.test(value)) {
    issues.push(makeIssue("error", "HiddenControlGeometryLeak", path, "Control geometry metadata contains hidden simulator/backend/QA wording.", "Strip hidden identifiers before control handoff."));
  }
}

function sanitizeText(value: string): string {
  return value.trim().replace(/\s+/gu, " ").replace(HIDDEN_CONTROL_GEOMETRY_PATTERN, "hidden-detail").slice(0, 160);
}

function sanitizeRef(value: Ref): Ref {
  return makeRef(value);
}

function isControlIKTargetDescriptor(value: ControlIKTargetDescriptor | undefined): value is ControlIKTargetDescriptor {
  return value !== undefined;
}

function isNumber(value: number | undefined): value is number {
  return value !== undefined;
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "") : "invalid";
}

function freezeVector3(value: readonly number[]): Vector3 {
  return Object.freeze([round6(value[0]), round6(value[1]), round6(value[2])]) as Vector3;
}

function freezeQuaternion(value: readonly number[]): Quaternion {
  return Object.freeze([round6(value[0]), round6(value[1]), round6(value[2]), round6(value[3])]) as Quaternion;
}

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return freezeArray([...new Set(values)].sort());
}

function makeIssue(
  severity: ValidationSeverity,
  code: ControlGeometryIssueCode,
  path: string,
  message: string,
  remediation: string,
): ValidationIssue {
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

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}
