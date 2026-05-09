/**
 * IK feasibility service for Project Mebsuta deterministic control.
 *
 * Blueprint: `architecture_docs/11_CONTROL_LAYER_IK_PD_TRAJECTORY_ARCHITECTURE.md`
 * sections 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.14, 11.15, 11.16, and 11.17.
 *
 * This service maps File 10 control geometry targets into deterministic IK
 * feasibility reports. It evaluates target readiness, kinematic chain reach,
 * two-link planar IK geometry, joint position/velocity/effort margins,
 * collision clearance, stability admission, singularity risk, actuator
 * feasibility, and confidence gates before any trajectory or PD layer can
 * consume candidate joint setpoints.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type {
  Ref,
  ValidationIssue,
  ValidationSeverity,
  Vector3,
} from "../simulation/world_manifest";
import type {
  ChainPlanarIKReport,
  ChainReachEnvelope,
  ResolvedKinematicChain,
  SingularityClass,
} from "../embodiment/kinematic_chain_registry";
import type {
  JointCommandLimitReport,
  ResolvedJointLimit,
} from "../embodiment/joint_limit_catalog";
import type { ResolvedActuatorLimit } from "../embodiment/actuator_limit_catalog";
import type { ReachDecision } from "../embodiment/reach_envelope_service";
import type { StabilityState } from "../embodiment/embodiment_model_registry";
import type { StabilityDecision } from "../embodiment/stability_policy_service";
import type { ControlIKTargetDescriptor } from "../spatial/control_geometry_bridge";

export const IK_FEASIBILITY_SERVICE_SCHEMA_VERSION = "mebsuta.ik_feasibility_service.v1" as const;

const EPSILON = 1e-9;
const HIDDEN_IK_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|qa_success|qa_label|qa_only|simulator truth|mesh_name|asset_id|benchmark_truth|oracle_pose)/i;
const SAFE_HOLD_RECOVERY: IKRecommendedRecovery = "safe_hold";

export type IKFeasibility = "feasible" | "feasible_with_margin_warning" | "infeasible" | "unsafe" | "ambiguous";
export type IKCollisionStatus = "clear" | "near_margin" | "colliding" | "unknown";
export type IKStabilityStatus = "stable" | "marginal" | "unstable" | "unknown";
export type IKSingularityStatus = "clear" | "near_singular" | "singular" | "unknown";
export type IKRecommendedRecovery = "reposition" | "reobserve" | "use_tool" | "lower_target" | "safe_hold" | "human_review" | "slow_trajectory" | "alternate_posture";
export type IKRejectionReason =
  | "TargetFrameMissing"
  | "TargetEstimateUncertain"
  | "OutOfReach"
  | "JointLimitViolation"
  | "VelocityLimitViolation"
  | "TorqueLimitViolation"
  | "CollisionRisk"
  | "StabilityRisk"
  | "SingularityRisk"
  | "ToolFrameInvalid"
  | "ActuatorLimitViolation"
  | "KinematicChainMissing"
  | "PolicyInvalid";
export type IKFeasibilityIssueCode =
  | "InputMissing"
  | "TargetFrameMissing"
  | "TargetEstimateUncertain"
  | "KinematicChainMissing"
  | "TargetPoseMissing"
  | "OutOfReach"
  | "JointLimitViolation"
  | "VelocityLimitViolation"
  | "TorqueLimitViolation"
  | "ActuatorLimitViolation"
  | "CollisionRisk"
  | "StabilityRisk"
  | "SingularityRisk"
  | "ToolFrameInvalid"
  | "HiddenIKLeak"
  | "PolicyInvalid";

/**
 * Runtime policy for solver conservatism and finite command checks.
 */
export interface IKFeasibilityPolicy {
  readonly min_confidence_requirement?: number;
  readonly max_position_residual_ratio?: number;
  readonly max_orientation_residual_ratio?: number;
  readonly min_reach_margin_m?: number;
  readonly near_singularity_margin_m?: number;
  readonly min_collision_margin_m?: number;
  readonly min_stability_margin_m?: number;
  readonly default_delta_time_s?: number;
  readonly clamp_candidate_to_safe_joint_limits?: boolean;
  readonly reject_on_joint_limit_warning?: boolean;
  readonly reject_on_actuator_warning?: boolean;
  readonly reject_hidden_identifiers?: boolean;
}

/**
 * Optional adapter callbacks. When present, the service calls the existing
 * embodiment APIs and folds their typed reports into the IK decision.
 */
export interface IKFeasibilityAdapters {
  readonly evaluateChainReach?: (chainRef: Ref, targetInRootFrameM: Vector3, embodimentRef?: Ref) => ChainReachEnvelope;
  readonly solvePlanarTwoLinkIK?: (input: {
    readonly embodiment_ref?: Ref;
    readonly chain_ref: Ref;
    readonly target_in_root_frame_m: Vector3;
    readonly elbow_preference?: "up" | "down";
    readonly clamp_to_joint_limits?: boolean;
  }) => ChainPlanarIKReport;
  readonly evaluateJointCommand?: (input: {
    readonly embodiment_ref?: Ref;
    readonly joint_ref: Ref;
    readonly requested_position: number;
    readonly requested_velocity?: number;
    readonly requested_effort?: number;
    readonly previous_position?: number;
    readonly previous_velocity?: number;
    readonly delta_time_s?: number;
    readonly consumer: "ik";
    readonly clamp_to_safe_limits?: boolean;
  }) => JointCommandLimitReport;
}

/**
 * Current joint state from proprioception or the control estimator.
 */
export interface CurrentJointState {
  readonly joint_ref: Ref;
  readonly position: number;
  readonly velocity?: number;
  readonly effort?: number;
}

/**
 * Spherical obstacle or swept-margin primitive used for IK admission.
 */
export interface CollisionObstacle {
  readonly obstacle_ref: Ref;
  readonly center_in_chain_root_m: Vector3;
  readonly radius_m: number;
  readonly required_clearance_m: number;
  readonly evidence_refs: readonly Ref[];
}

/**
 * Collision policy for target and straight-line approach admission.
 */
export interface IKCollisionPolicy {
  readonly policy_ref: Ref;
  readonly obstacles: readonly CollisionObstacle[];
  readonly unknown_if_no_obstacles?: boolean;
}

/**
 * Tool-state gate for tool-tip targets.
 */
export interface IKToolContext {
  readonly tool_frame_ref?: Ref;
  readonly attachment_validated: boolean;
  readonly tool_slip_risk?: number;
  readonly max_allowed_slip_risk?: number;
  readonly evidence_refs: readonly Ref[];
}

/**
 * Solver input for File 11 `solveIKFeasibility(...)`.
 */
export interface IKFeasibilityInput {
  readonly request_ref?: Ref;
  readonly ik_target: ControlIKTargetDescriptor;
  readonly kinematic_chain?: ResolvedKinematicChain;
  readonly target_in_chain_root_frame_m?: Vector3;
  readonly current_joint_state: readonly CurrentJointState[];
  readonly joint_limits?: readonly ResolvedJointLimit[];
  readonly actuator_limits?: readonly ResolvedActuatorLimit[];
  readonly reach_decision?: ReachDecision;
  readonly stability_decision?: StabilityDecision;
  readonly collision_policy?: IKCollisionPolicy;
  readonly tool_context?: IKToolContext;
  readonly adapters?: IKFeasibilityAdapters;
  readonly elbow_preference?: "up" | "down";
  readonly policy?: IKFeasibilityPolicy;
}

/**
 * Residual summary required by File 11's IK feasibility report schema.
 */
export interface IKResidualSummary {
  readonly position_error_norm_m?: number;
  readonly position_tolerance_m?: number;
  readonly position_residual_ratio?: number;
  readonly orientation_error_angle_rad?: number;
  readonly orientation_tolerance_rad?: number;
  readonly orientation_residual_ratio?: number;
  readonly uncertainty_gate: "passed" | "ambiguous" | "failed";
  readonly within_tolerance: boolean;
}

/**
 * Closest margins across all solver gates.
 */
export interface IKLimitMargins {
  readonly closest_joint_margin_rad: number;
  readonly closest_velocity_margin_rad_s: number;
  readonly closest_torque_margin_nm: number;
  readonly reach_margin_m: number;
  readonly collision_margin_m?: number;
  readonly stability_margin_m?: number;
  readonly actuator_effort_margin?: number;
}

/**
 * Joint target emitted only when the IK candidate survives admission.
 */
export interface IKJointSetpoint {
  readonly joint_ref: Ref;
  readonly position: number;
  readonly velocity?: number;
  readonly effort?: number;
  readonly source: "planar_two_link_ik" | "home_posture_fill";
}

/**
 * Candidate joint solution for trajectory shaping.
 */
export interface IKJointSolution {
  readonly joint_solution_ref: Ref;
  readonly kinematic_chain_ref: Ref;
  readonly target_frame_ref: Ref;
  readonly setpoints: readonly IKJointSetpoint[];
  readonly residual_m: number;
  readonly solver: "deterministic_planar_two_link";
  readonly determinism_hash: string;
}

/**
 * File 11 IK feasibility report.
 */
export interface IKFeasibilityReport {
  readonly schema_version: typeof IK_FEASIBILITY_SERVICE_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/11_CONTROL_LAYER_IK_PD_TRAJECTORY_ARCHITECTURE.md";
  readonly ik_report_ref: Ref;
  readonly ik_target_ref: Ref;
  readonly feasibility: IKFeasibility;
  readonly joint_solution_ref?: Ref;
  readonly joint_solution?: IKJointSolution;
  readonly residual_summary: IKResidualSummary;
  readonly limit_margins: IKLimitMargins;
  readonly collision_status: IKCollisionStatus;
  readonly stability_status: IKStabilityStatus;
  readonly singularity_status: IKSingularityStatus;
  readonly rejection_reasons: readonly IKRejectionReason[];
  readonly recommended_recovery?: IKRecommendedRecovery;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
  readonly cognitive_visibility: "ik_feasibility_report";
}

interface NormalizedIKFeasibilityPolicy {
  readonly min_confidence_requirement: number;
  readonly max_position_residual_ratio: number;
  readonly max_orientation_residual_ratio: number;
  readonly min_reach_margin_m: number;
  readonly near_singularity_margin_m: number;
  readonly min_collision_margin_m: number;
  readonly min_stability_margin_m: number;
  readonly default_delta_time_s: number;
  readonly clamp_candidate_to_safe_joint_limits: boolean;
  readonly reject_on_joint_limit_warning: boolean;
  readonly reject_on_actuator_warning: boolean;
  readonly reject_hidden_identifiers: boolean;
}

interface SolverState {
  readonly targetPoint: Vector3;
  readonly chain: ResolvedKinematicChain;
  readonly reach: ChainReachEnvelope;
  readonly planarIK: ChainPlanarIKReport;
  readonly jointReports: readonly JointCommandLimitReport[];
  readonly residualSummary: IKResidualSummary;
  readonly collision: {
    readonly status: IKCollisionStatus;
    readonly margin_m?: number;
    readonly issues: readonly ValidationIssue[];
  };
  readonly stability: {
    readonly status: IKStabilityStatus;
    readonly margin_m?: number;
    readonly issues: readonly ValidationIssue[];
  };
  readonly singularity: IKSingularityStatus;
}

const DEFAULT_POLICY: NormalizedIKFeasibilityPolicy = Object.freeze({
  min_confidence_requirement: 0.6,
  max_position_residual_ratio: 1,
  max_orientation_residual_ratio: 1.25,
  min_reach_margin_m: 0.005,
  near_singularity_margin_m: 0.03,
  min_collision_margin_m: 0.025,
  min_stability_margin_m: 0.02,
  default_delta_time_s: 0.25,
  clamp_candidate_to_safe_joint_limits: false,
  reject_on_joint_limit_warning: true,
  reject_on_actuator_warning: true,
  reject_hidden_identifiers: true,
});

/**
 * Executable File 11 `IKFeasibilityService`.
 */
export class IKFeasibilityService {
  private readonly policy: NormalizedIKFeasibilityPolicy;

  public constructor(policy: IKFeasibilityPolicy = {}) {
    this.policy = mergePolicy(DEFAULT_POLICY, policy);
  }

  /**
   * Solves deterministic IK feasibility for one control target. The method
   * does not emit actuator commands; it only returns an admitted or rejected
   * candidate for trajectory shaping.
   */
  public solveIKFeasibility(input: IKFeasibilityInput): IKFeasibilityReport {
    const policy = mergePolicy(this.policy, input.policy ?? {});
    const issues: ValidationIssue[] = [];
    validatePolicy(policy, issues);
    validateInputShell(input, policy, issues);

    const requestRef = input.request_ref ?? makeRef("ik_request", input.ik_target.ik_target_ref);
    const chain = input.kinematic_chain;
    if (chain === undefined) {
      issues.push(makeIssue("error", "KinematicChainMissing", "$.kinematic_chain", "IK feasibility requires the resolved kinematic chain named by the target.", "Provide a ResolvedKinematicChain from KinematicChainRegistry."));
      return buildFallbackReport(input, requestRef, policy, issues);
    }

    const targetPoint = resolveTargetPoint(input, chain, issues);
    if (targetPoint === undefined) {
      return buildFallbackReport(input, requestRef, policy, issues);
    }

    const state = buildSolverState(input, chain, targetPoint, policy, issues);
    const allIssues = freezeArray([
      ...issues,
      ...state.reach.issues,
      ...state.planarIK.issues,
      ...state.jointReports.flatMap((report) => report.issues),
      ...state.collision.issues,
      ...state.stability.issues,
    ]);
    const rejectionReasons = classifyRejections(input, state, allIssues, policy);
    const feasibility = decideFeasibility(state, rejectionReasons, allIssues);
    const recommendedRecovery = chooseRecovery(rejectionReasons, state, feasibility);
    const jointSolution = buildJointSolution(input, state, feasibility);
    const ikReportRef = makeRef("ik_feasibility_report", requestRef, feasibility);

    return Object.freeze({
      schema_version: IK_FEASIBILITY_SERVICE_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/11_CONTROL_LAYER_IK_PD_TRAJECTORY_ARCHITECTURE.md",
      ik_report_ref: ikReportRef,
      ik_target_ref: input.ik_target.ik_target_ref,
      feasibility,
      joint_solution_ref: jointSolution?.joint_solution_ref,
      joint_solution: jointSolution,
      residual_summary: state.residualSummary,
      limit_margins: buildLimitMargins(state, input, policy),
      collision_status: state.collision.status,
      stability_status: state.stability.status,
      singularity_status: state.singularity,
      rejection_reasons: freezeArray(rejectionReasons),
      recommended_recovery: recommendedRecovery,
      issues: allIssues,
      ok: feasibility === "feasible" || feasibility === "feasible_with_margin_warning",
      determinism_hash: computeDeterminismHash({
        ikReportRef,
        target: input.ik_target.ik_target_ref,
        feasibility,
        jointSolution: jointSolution?.determinism_hash,
        residual: state.residualSummary,
        margins: buildLimitMargins(state, input, policy),
        collision: state.collision.status,
        stability: state.stability.status,
        singularity: state.singularity,
        rejectionReasons,
        issueCodes: allIssues.map((issue) => issue.code).sort(),
      }),
      cognitive_visibility: "ik_feasibility_report",
    });
  }
}

/**
 * Functional API for File 11 `solveIKFeasibility(...)`.
 */
export function solveIKFeasibility(input: IKFeasibilityInput): IKFeasibilityReport {
  return new IKFeasibilityService(input.policy).solveIKFeasibility(input);
}

function buildSolverState(
  input: IKFeasibilityInput,
  chain: ResolvedKinematicChain,
  targetPoint: Vector3,
  policy: NormalizedIKFeasibilityPolicy,
  issues: ValidationIssue[],
): SolverState {
  const reach = input.adapters?.evaluateChainReach?.(chain.chain_ref, targetPoint, chain.embodiment_ref)
    ?? computeReachEnvelope(chain, targetPoint);
  const planarIK = input.adapters?.solvePlanarTwoLinkIK?.({
    embodiment_ref: chain.embodiment_ref,
    chain_ref: chain.chain_ref,
    target_in_root_frame_m: targetPoint,
    elbow_preference: input.elbow_preference,
    clamp_to_joint_limits: policy.clamp_candidate_to_safe_joint_limits,
  }) ?? solvePlanarTwoLink(chain, targetPoint, input.elbow_preference, policy.clamp_candidate_to_safe_joint_limits);
  const jointReports = buildJointCommandReports(input, chain, planarIK, policy);
  const collision = evaluateCollision(input.collision_policy, targetPoint, policy);
  const stability = evaluateStability(input.stability_decision, policy);
  const residualSummary = summarizeResiduals(input.ik_target, policy, issues);
  const singularity = classifySingularityStatus(planarIK.singularity_class, reach.reach_margin_m, policy);
  return Object.freeze({
    targetPoint,
    chain,
    reach,
    planarIK,
    jointReports,
    residualSummary,
    collision,
    stability,
    singularity,
  });
}

function resolveTargetPoint(
  input: IKFeasibilityInput,
  chain: ResolvedKinematicChain,
  issues: ValidationIssue[],
): Vector3 | undefined {
  if (input.target_in_chain_root_frame_m !== undefined) {
    validateVector3(input.target_in_chain_root_frame_m, "$.target_in_chain_root_frame_m", issues, "TargetPoseMissing");
    return freezeVector3(input.target_in_chain_root_frame_m);
  }
  const goal = input.ik_target.pose_goal.position_m;
  if (goal === undefined) {
    issues.push(makeIssue("error", "TargetPoseMissing", "$.ik_target.pose_goal.position_m", "IK target requires a desired Cartesian position.", "Provide the geometry-bridge pose_goal position."));
    return undefined;
  }
  if (input.ik_target.pose_goal.frame_ref !== chain.root_frame_ref) {
    issues.push(makeIssue("warning", "TargetPoseMissing", "$.ik_target.pose_goal.frame_ref", "Target pose is not declared in the chain root frame; interpreting it as already transformed by ControlGeometryBridge.", "Prefer providing target_in_chain_root_frame_m or a target pose in the chain root frame."));
  }
  return freezeVector3(goal);
}

function summarizeResiduals(
  target: ControlIKTargetDescriptor,
  policy: NormalizedIKFeasibilityPolicy,
  issues: ValidationIssue[],
): IKResidualSummary {
  const positionTolerance = target.tolerance_profile.position_tolerance_m ?? target.tolerance_profile.distance_tolerance_m;
  const orientationTolerance = target.tolerance_profile.orientation_tolerance_rad;
  const positionRatio = ratioOrUndefined(target.pose_error.position_error_norm_m, positionTolerance);
  const orientationRatio = ratioOrUndefined(target.pose_error.orientation_error_angle_rad, orientationTolerance);
  if (target.pose_error.uncertainty_gate !== "passed") {
    issues.push(makeIssue("warning", "TargetEstimateUncertain", "$.ik_target.pose_error.uncertainty_gate", "Target pose uncertainty is not cleanly passed for IK.", "Reobserve or refresh control geometry before execution."));
  }
  if (target.confidence_requirement < policy.min_confidence_requirement) {
    issues.push(makeIssue("warning", "TargetEstimateUncertain", "$.ik_target.confidence_requirement", "IK target confidence requirement is below service policy.", "Raise target confidence or reobserve."));
  }
  const withinPosition = positionRatio === undefined || positionRatio <= policy.max_position_residual_ratio;
  const withinOrientation = orientationRatio === undefined || orientationRatio <= policy.max_orientation_residual_ratio;
  return Object.freeze({
    position_error_norm_m: target.pose_error.position_error_norm_m,
    position_tolerance_m: positionTolerance,
    position_residual_ratio: positionRatio,
    orientation_error_angle_rad: target.pose_error.orientation_error_angle_rad,
    orientation_tolerance_rad: orientationTolerance,
    orientation_residual_ratio: orientationRatio,
    uncertainty_gate: target.pose_error.uncertainty_gate,
    within_tolerance: withinPosition && withinOrientation && target.pose_error.uncertainty_gate === "passed",
  });
}

function buildJointCommandReports(
  input: IKFeasibilityInput,
  chain: ResolvedKinematicChain,
  planarIK: ChainPlanarIKReport,
  policy: NormalizedIKFeasibilityPolicy,
): readonly JointCommandLimitReport[] {
  const reports = chain.joints
    .map((joint) => {
      const requested = planarIK.joint_solution[joint.joint_ref] ?? joint.home_position;
      const current = input.current_joint_state.find((state) => state.joint_ref === joint.joint_ref);
      if (input.adapters?.evaluateJointCommand !== undefined) {
        return input.adapters.evaluateJointCommand({
          embodiment_ref: chain.embodiment_ref,
          joint_ref: joint.joint_ref,
          requested_position: requested,
          requested_velocity: inferRequestedVelocity(requested, current?.position, policy.default_delta_time_s),
          requested_effort: estimateJointEffort(joint.max_effort, requested, current?.position),
          previous_position: current?.position,
          previous_velocity: current?.velocity,
          delta_time_s: policy.default_delta_time_s,
          consumer: "ik",
          clamp_to_safe_limits: policy.clamp_candidate_to_safe_joint_limits,
        });
      }
      return computeJointCommandReport(chain.embodiment_ref, joint, requested, current, policy);
    });
  return freezeArray(reports);
}

function computeReachEnvelope(chain: ResolvedKinematicChain, target: Vector3): ChainReachEnvelope {
  const radial = Math.hypot(target[0], target[1]);
  const vertical = target[2];
  const distance = Math.hypot(radial, vertical);
  const singularity = classifyChainSingularity(distance, chain.min_folded_reach_m, chain.link_length_sum_m);
  const issues: ValidationIssue[] = [];
  if (distance > chain.conservative_reach_m + EPSILON) {
    issues.push(makeIssue("warning", "OutOfReach", "$.target_in_chain_root_frame_m", "Target lies outside conservative chain reach.", "Reposition the base, choose another chain, or validate a tool extension."));
  }
  if (distance < chain.min_folded_reach_m - EPSILON) {
    issues.push(makeIssue("warning", "SingularityRisk", "$.target_in_chain_root_frame_m", "Target lies inside folded reach and risks singular posture.", "Move the target away from the chain root or use alternate posture."));
  }
  const base = {
    schema_version: chain.schema_version,
    embodiment_ref: chain.embodiment_ref,
    chain_ref: chain.chain_ref,
    target_distance_m: round6(distance),
    radial_distance_m: round6(radial),
    vertical_offset_m: round6(vertical),
    min_reach_m: round6(chain.min_folded_reach_m),
    max_reach_m: round6(chain.link_length_sum_m),
    conservative_reach_m: round6(chain.conservative_reach_m),
    reach_margin_m: round6(chain.conservative_reach_m - distance),
    singularity_class: singularity,
    reachable: distance <= chain.conservative_reach_m + EPSILON && distance >= chain.min_folded_reach_m - EPSILON,
    issues: freezeArray(issues),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function solvePlanarTwoLink(
  chain: ResolvedKinematicChain,
  target: Vector3,
  elbowPreference: "up" | "down" | undefined,
  clampToSafeLimits: boolean,
): ChainPlanarIKReport {
  const issues: ValidationIssue[] = [...chain.issues];
  if (chain.link_lengths_m.length < 2 || chain.joints.length < 2) {
    issues.push(makeIssue("error", "KinematicChainMissing", "$.kinematic_chain", "Planar IK requires at least two links and two joints.", "Use a chain with two controllable joints."));
    return buildPlanarIKReport(chain, target, 0, 0, vectorNorm(target), "not_applicable", {}, [], issues);
  }
  const l1 = chain.link_lengths_m[0];
  const l2 = chain.link_lengths_m[1];
  const radial = Math.hypot(target[0], target[1]);
  const vertical = target[2];
  const distance = Math.hypot(radial, vertical);
  if (!Number.isFinite(distance) || distance < EPSILON) {
    issues.push(makeIssue("error", "TargetPoseMissing", "$.target_in_chain_root_frame_m", "IK target must be finite and nonzero.", "Provide a nonzero target in chain root coordinates."));
    return buildPlanarIKReport(chain, target, 0, 0, 0, "degenerate", {}, [], issues);
  }
  const minReach = Math.abs(l1 - l2);
  const maxReach = l1 + l2;
  const clampedDistance = clamp(distance, minReach, maxReach);
  const residual = Math.abs(distance - clampedDistance);
  if (residual > EPSILON) {
    issues.push(makeIssue("warning", "OutOfReach", "$.target_in_chain_root_frame_m", "Target is outside exact two-link reach bounds.", "Move the base, adjust posture, or choose another chain."));
  }
  const elbowSign = elbowPreference === "down" ? -1 : 1;
  const cosElbow = clamp((clampedDistance * clampedDistance - l1 * l1 - l2 * l2) / (2 * l1 * l2), -1, 1);
  const elbow = elbowSign * Math.acos(cosElbow);
  const shoulder = Math.atan2(vertical, radial) - Math.atan2(l2 * Math.sin(elbow), l1 + l2 * Math.cos(elbow));
  const singularity = classifyChainSingularity(clampedDistance, minReach, maxReach);
  const rawSolution: Record<Ref, number> = {
    [chain.joints[0].joint_ref]: round6(shoulder),
    [chain.joints[1].joint_ref]: round6(elbow),
  };
  const appliedLimits = chain.joints.slice(0, 2).map((joint) => {
    const requested = rawSolution[joint.joint_ref] ?? joint.home_position;
    const minSafe = joint.min_position + joint.safety_margin;
    const maxSafe = joint.max_position - joint.safety_margin;
    const insideSafe = requested >= minSafe - EPSILON && requested <= maxSafe + EPSILON;
    if (!insideSafe) {
      issues.push(makeIssue("warning", "JointLimitViolation", `$.joint_solution.${joint.joint_ref}`, "Planar IK solution is outside safe joint limits.", "Reposition, choose another posture, or clamp only for initialization."));
    }
    return Object.freeze({
      joint_ref: joint.joint_ref,
      requested_position: round6(requested),
      limited_position: round6(clampToSafeLimits ? clamp(requested, minSafe, maxSafe) : requested),
      min_safe_position: round6(minSafe),
      max_safe_position: round6(maxSafe),
      inside_safe_limits: insideSafe,
    });
  });
  const solution = appliedLimits.reduce<Record<Ref, number>>((accumulator, limit) => {
    accumulator[limit.joint_ref] = limit.limited_position;
    return accumulator;
  }, {});
  if (singularity !== "clear" && singularity !== "not_applicable") {
    issues.push(makeIssue("warning", "SingularityRisk", "$.target_in_chain_root_frame_m", "IK solution is near a folded or extended singularity.", "Prefer more bend margin or alternate posture."));
  }
  return buildPlanarIKReport(chain, target, shoulder, elbow, residual, singularity, solution, appliedLimits, issues);
}

function computeJointCommandReport(
  embodimentRef: Ref,
  joint: ResolvedKinematicChain["joints"][number],
  requested: number,
  current: CurrentJointState | undefined,
  policy: NormalizedIKFeasibilityPolicy,
): JointCommandLimitReport {
  const safeMin = joint.min_position + joint.safety_margin;
  const safeMax = joint.max_position - joint.safety_margin;
  const limitedPosition = policy.clamp_candidate_to_safe_joint_limits ? clamp(requested, safeMin, safeMax) : requested;
  const velocity = inferRequestedVelocity(requested, current?.position, policy.default_delta_time_s);
  const effort = estimateJointEffort(joint.max_effort, requested, current?.position);
  const issues: ValidationIssue[] = [];
  const outsideHard = requested < joint.min_position - EPSILON || requested > joint.max_position + EPSILON;
  const outsideSafe = requested < safeMin - EPSILON || requested > safeMax + EPSILON;
  if (outsideHard) {
    issues.push(makeIssue("error", "JointLimitViolation", `$.joint_solution.${joint.joint_ref}`, "Candidate joint position exceeds hard joint limits.", "Reject this IK target or replan through a safe posture."));
  } else if (outsideSafe) {
    issues.push(makeIssue("warning", "JointLimitViolation", `$.joint_solution.${joint.joint_ref}`, "Candidate joint position is outside safe margin.", "Prefer a target farther from the joint limit."));
  }
  if (velocity !== undefined && Math.abs(velocity) > joint.max_velocity + EPSILON) {
    issues.push(makeIssue("warning", "VelocityLimitViolation", `$.joint_solution.${joint.joint_ref}.velocity`, "Candidate joint velocity exceeds declared max velocity.", "Lengthen trajectory duration or slow the primitive."));
  }
  if (Math.abs(effort) > joint.max_effort + EPSILON) {
    issues.push(makeIssue("warning", "TorqueLimitViolation", `$.joint_solution.${joint.joint_ref}.effort`, "Estimated effort exceeds declared max effort.", "Reduce load, use a different chain, or safe-hold."));
  }
  const lowerDistance = round6(limitedPosition - safeMin);
  const upperDistance = round6(safeMax - limitedPosition);
  const nearest = round6(Math.min(Math.max(0, lowerDistance), Math.max(0, upperDistance)));
  const base = {
    schema_version: "mebsuta.joint_limit_catalog.v1" as const,
    embodiment_ref: embodimentRef,
    joint_ref: joint.joint_ref,
    consumer: "ik" as const,
    limit_state: outsideHard ? "outside_hard_limits" as const : outsideSafe ? "inside_hard_limits" as const : "inside_safe_limits" as const,
    requested_position: round6(requested),
    limited_position: round6(limitedPosition),
    requested_velocity: velocity === undefined ? undefined : round6(velocity),
    limited_velocity: velocity === undefined ? undefined : round6(clampSymmetric(velocity, joint.max_velocity, policy.clamp_candidate_to_safe_joint_limits)),
    requested_acceleration: undefined,
    limited_acceleration: undefined,
    requested_effort: round6(effort),
    limited_effort: round6(clampSymmetric(effort, joint.max_effort, policy.clamp_candidate_to_safe_joint_limits)),
    inferred_velocity: velocity === undefined ? undefined : round6(velocity),
    inferred_acceleration: undefined,
    motion_direction: velocity === undefined || Math.abs(velocity) < EPSILON ? "stationary" as const : velocity > 0 ? "positive" as const : "negative" as const,
    distance_to_lower_safe_limit: lowerDistance,
    distance_to_upper_safe_limit: upperDistance,
    nearest_limit_distance: nearest,
    safety_margin_consumed_ratio: round6(safetyMarginConsumed(requested, joint.min_position, joint.max_position, joint.safety_margin)),
    accepted: !issues.some((issue) => issue.severity === "error") && (!policy.reject_on_joint_limit_warning || !issues.some((issue) => issue.severity === "warning")),
    issues: freezeArray(issues),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function evaluateCollision(
  policy: IKCollisionPolicy | undefined,
  targetPoint: Vector3,
  solverPolicy: NormalizedIKFeasibilityPolicy,
): SolverState["collision"] {
  if (policy === undefined || policy.obstacles.length === 0) {
    return Object.freeze({
      status: policy?.unknown_if_no_obstacles === true ? "unknown" : "clear",
      margin_m: undefined,
      issues: freezeArray([]),
    });
  }
  const issues: ValidationIssue[] = [];
  let minimumMargin = Number.POSITIVE_INFINITY;
  for (const [index, obstacle] of policy.obstacles.entries()) {
    validateVector3(obstacle.center_in_chain_root_m, `$.collision_policy.obstacles[${index}].center_in_chain_root_m`, issues, "CollisionRisk");
    const pathDistance = distancePointToSegment(obstacle.center_in_chain_root_m, ZERO_VECTOR, targetPoint);
    const margin = pathDistance - obstacle.radius_m - obstacle.required_clearance_m;
    minimumMargin = Math.min(minimumMargin, margin);
    if (margin < 0) {
      issues.push(makeIssue("error", "CollisionRisk", `$.collision_policy.obstacles[${index}]`, "IK straight-line admission path intersects an obstacle margin.", "Replan path or choose a different target."));
    } else if (margin < solverPolicy.min_collision_margin_m) {
      issues.push(makeIssue("warning", "CollisionRisk", `$.collision_policy.obstacles[${index}]`, "IK target path is near collision margin.", "Slow trajectory or request a path replan."));
    }
  }
  const roundedMargin = round6(minimumMargin);
  return Object.freeze({
    status: roundedMargin < 0 ? "colliding" : roundedMargin < solverPolicy.min_collision_margin_m ? "near_margin" : "clear",
    margin_m: roundedMargin,
    issues: freezeArray(issues),
  });
}

function evaluateStability(
  decision: StabilityDecision | undefined,
  policy: NormalizedIKFeasibilityPolicy,
): SolverState["stability"] {
  if (decision === undefined) {
    return Object.freeze({ status: "unknown", margin_m: undefined, issues: freezeArray([]) });
  }
  const issues: ValidationIssue[] = [];
  const margin = decision.support_geometry.center_margin_m;
  const status = mapStabilityState(decision.stability_state, margin, policy);
  if (status === "unstable" || decision.validator_admission === "reject" || decision.validator_admission === "safe_hold") {
    issues.push(makeIssue("error", "StabilityRisk", "$.stability_decision", "Stability policy rejects this IK target.", "Reposition, widen stance, lower speed, or safe-hold."));
  } else if (status === "marginal" || decision.validator_admission === "admit_with_speed_limit") {
    issues.push(makeIssue("warning", "StabilityRisk", "$.stability_decision", "Stability margin is marginal for this IK target.", "Slow trajectory or adjust posture."));
  }
  return Object.freeze({
    status,
    margin_m: margin === undefined ? undefined : round6(margin),
    issues: freezeArray(issues),
  });
}

function classifyRejections(
  input: IKFeasibilityInput,
  state: SolverState,
  issues: readonly ValidationIssue[],
  policy: NormalizedIKFeasibilityPolicy,
): readonly IKRejectionReason[] {
  const reasons: IKRejectionReason[] = [];
  if (input.ik_target.target_frame_ref.trim().length === 0) reasons.push("TargetFrameMissing");
  if (!state.residualSummary.within_tolerance || state.residualSummary.uncertainty_gate !== "passed") reasons.push("TargetEstimateUncertain");
  if (!state.reach.reachable || state.reach.reach_margin_m < -EPSILON) reasons.push("OutOfReach");
  if (state.jointReports.some((report) => report.issues.some((issue) => issue.code === "JointLimitViolation" && (issue.severity === "error" || policy.reject_on_joint_limit_warning)))) reasons.push("JointLimitViolation");
  if (state.jointReports.some((report) => report.issues.some((issue) => issue.code === "VelocityLimitViolation" && (issue.severity === "error" || policy.reject_on_joint_limit_warning)))) reasons.push("VelocityLimitViolation");
  if (state.jointReports.some((report) => report.issues.some((issue) => issue.code === "TorqueLimitViolation" && (issue.severity === "error" || policy.reject_on_joint_limit_warning)))) reasons.push("TorqueLimitViolation");
  if (state.collision.status === "colliding") reasons.push("CollisionRisk");
  if (state.stability.status === "unstable") reasons.push("StabilityRisk");
  if (state.singularity === "singular") reasons.push("SingularityRisk");
  if (input.ik_target.end_effector_role === "tool_tip" && !isToolContextValid(input.tool_context)) reasons.push("ToolFrameInvalid");
  if (hasActuatorViolation(input, state, policy)) reasons.push("ActuatorLimitViolation");
  if (issues.some((issue) => issue.code === "KinematicChainMissing")) reasons.push("KinematicChainMissing");
  if (issues.some((issue) => issue.code === "PolicyInvalid")) reasons.push("PolicyInvalid");
  return uniqueSorted(reasons);
}

function decideFeasibility(
  state: SolverState,
  rejectionReasons: readonly IKRejectionReason[],
  issues: readonly ValidationIssue[],
): IKFeasibility {
  if (rejectionReasons.includes("PolicyInvalid") || rejectionReasons.includes("KinematicChainMissing")) return "infeasible";
  if (rejectionReasons.includes("CollisionRisk") || rejectionReasons.includes("StabilityRisk") || rejectionReasons.includes("ToolFrameInvalid")) return "unsafe";
  if (rejectionReasons.includes("TargetEstimateUncertain") || state.collision.status === "unknown" || state.stability.status === "unknown") return "ambiguous";
  if (rejectionReasons.length > 0 || !state.planarIK.feasible) return "infeasible";
  if (issues.some((issue) => issue.severity === "warning") || state.singularity === "near_singular" || state.collision.status === "near_margin" || state.stability.status === "marginal") return "feasible_with_margin_warning";
  return "feasible";
}

function chooseRecovery(
  reasons: readonly IKRejectionReason[],
  state: SolverState,
  feasibility: IKFeasibility,
): IKRecommendedRecovery | undefined {
  if (feasibility === "feasible") return undefined;
  if (reasons.includes("CollisionRisk") || reasons.includes("StabilityRisk") || feasibility === "unsafe") return SAFE_HOLD_RECOVERY;
  if (reasons.includes("TargetEstimateUncertain")) return "reobserve";
  if (reasons.includes("OutOfReach")) return state.reach.target_distance_m > state.reach.max_reach_m ? "reposition" : "alternate_posture";
  if (reasons.includes("ToolFrameInvalid")) return "use_tool";
  if (reasons.includes("VelocityLimitViolation") || reasons.includes("TorqueLimitViolation")) return "slow_trajectory";
  if (reasons.includes("SingularityRisk") || reasons.includes("JointLimitViolation")) return "alternate_posture";
  return "human_review";
}

function buildJointSolution(
  input: IKFeasibilityInput,
  state: SolverState,
  feasibility: IKFeasibility,
): IKJointSolution | undefined {
  if (feasibility !== "feasible" && feasibility !== "feasible_with_margin_warning") return undefined;
  const jointSolutionRef = makeRef("joint_solution", input.ik_target.ik_target_ref, state.chain.chain_ref);
  const setpoints = state.chain.joints.map((joint) => {
    const solvedPosition = state.planarIK.joint_solution[joint.joint_ref];
    const position = solvedPosition ?? joint.home_position;
    const current = input.current_joint_state.find((candidate) => candidate.joint_ref === joint.joint_ref);
    return Object.freeze({
      joint_ref: joint.joint_ref,
      position: round6(position),
      velocity: inferRequestedVelocity(position, current?.position, mergePolicy(DEFAULT_POLICY, input.policy ?? {}).default_delta_time_s),
      effort: estimateJointEffort(joint.max_effort, position, current?.position),
      source: solvedPosition === undefined ? "home_posture_fill" as const : "planar_two_link_ik" as const,
    });
  });
  return Object.freeze({
    joint_solution_ref: jointSolutionRef,
    kinematic_chain_ref: state.chain.chain_ref,
    target_frame_ref: input.ik_target.target_frame_ref,
    setpoints: freezeArray(setpoints),
    residual_m: round6(state.planarIK.residual_m),
    solver: "deterministic_planar_two_link",
    determinism_hash: computeDeterminismHash({
      jointSolutionRef,
      chain: state.chain.chain_ref,
      target: input.ik_target.target_frame_ref,
      setpoints,
      residual: state.planarIK.residual_m,
    }),
  });
}

function buildLimitMargins(
  state: SolverState,
  input: IKFeasibilityInput,
  policy: NormalizedIKFeasibilityPolicy,
): IKLimitMargins {
  const jointMargin = minOrDefault(state.jointReports.map((report) => report.nearest_limit_distance), 0);
  const velocityMargin = minOrDefault(state.chain.joints.map((joint) => {
    const report = state.jointReports.find((candidate) => candidate.joint_ref === joint.joint_ref);
    const velocity = Math.abs(report?.requested_velocity ?? report?.inferred_velocity ?? 0);
    return joint.max_velocity - velocity;
  }), 0);
  const effortMargin = minOrDefault(state.chain.joints.map((joint) => {
    const report = state.jointReports.find((candidate) => candidate.joint_ref === joint.joint_ref);
    const effort = Math.abs(report?.requested_effort ?? 0);
    return joint.max_effort - effort;
  }), 0);
  return Object.freeze({
    closest_joint_margin_rad: round6(jointMargin),
    closest_velocity_margin_rad_s: round6(velocityMargin),
    closest_torque_margin_nm: round6(effortMargin),
    reach_margin_m: round6(state.reach.reach_margin_m),
    collision_margin_m: state.collision.margin_m,
    stability_margin_m: state.stability.margin_m,
    actuator_effort_margin: actuatorEffortMargin(input.actuator_limits, state, policy),
  });
}

function hasActuatorViolation(
  input: IKFeasibilityInput,
  state: SolverState,
  policy: NormalizedIKFeasibilityPolicy,
): boolean {
  if (input.actuator_limits === undefined || input.actuator_limits.length === 0) return false;
  return state.chain.joints.some((joint) => {
    const limit = input.actuator_limits?.find((candidate) => candidate.target_joint_ref === joint.joint_ref);
    const report = state.jointReports.find((candidate) => candidate.joint_ref === joint.joint_ref);
    if (limit === undefined || report === undefined) return false;
    const velocityViolation = Math.abs(report.requested_velocity ?? report.inferred_velocity ?? 0) > limit.max_velocity + EPSILON;
    const effortViolation = Math.abs(report.requested_effort ?? 0) > limit.max_effort + EPSILON;
    return policy.reject_on_actuator_warning && (velocityViolation || effortViolation);
  });
}

function actuatorEffortMargin(
  limits: readonly ResolvedActuatorLimit[] | undefined,
  state: SolverState,
  policy: NormalizedIKFeasibilityPolicy,
): number | undefined {
  if (limits === undefined || limits.length === 0) return undefined;
  const margins = state.chain.joints
    .map((joint) => {
      const limit = limits.find((candidate) => candidate.target_joint_ref === joint.joint_ref);
      const report = state.jointReports.find((candidate) => candidate.joint_ref === joint.joint_ref);
      if (limit === undefined || report === undefined) return undefined;
      const effort = Math.abs(report.requested_effort ?? estimateJointEffort(limit.max_effort, report.requested_position, undefined));
      const velocity = Math.abs(report.requested_velocity ?? report.inferred_velocity ?? 0);
      return Math.min(limit.max_effort - effort, limit.max_velocity - velocity);
    })
    .filter(isNumber);
  return margins.length === 0 ? undefined : round6(Math.min(...margins, policy.reject_on_actuator_warning ? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY));
}

function buildFallbackReport(
  input: IKFeasibilityInput,
  requestRef: Ref,
  policy: NormalizedIKFeasibilityPolicy,
  issues: readonly ValidationIssue[],
): IKFeasibilityReport {
  const residualSummary = summarizeResiduals(input.ik_target, policy, []);
  const reasons: readonly IKRejectionReason[] = issues.some((issue) => issue.code === "KinematicChainMissing")
    ? freezeArray(["KinematicChainMissing"])
    : freezeArray(["TargetFrameMissing"]);
  const ikReportRef = makeRef("ik_feasibility_report", requestRef, "infeasible");
  return Object.freeze({
    schema_version: IK_FEASIBILITY_SERVICE_SCHEMA_VERSION,
    blueprint_ref: "architecture_docs/11_CONTROL_LAYER_IK_PD_TRAJECTORY_ARCHITECTURE.md",
    ik_report_ref: ikReportRef,
    ik_target_ref: input.ik_target.ik_target_ref,
    feasibility: "infeasible",
    residual_summary: residualSummary,
    limit_margins: Object.freeze({
      closest_joint_margin_rad: 0,
      closest_velocity_margin_rad_s: 0,
      closest_torque_margin_nm: 0,
      reach_margin_m: 0,
    }),
    collision_status: "unknown",
    stability_status: "unknown",
    singularity_status: "unknown",
    rejection_reasons: reasons,
    recommended_recovery: "human_review",
    issues: freezeArray(issues),
    ok: false,
    determinism_hash: computeDeterminismHash({
      ikReportRef,
      target: input.ik_target.ik_target_ref,
      reasons,
      issueCodes: issues.map((issue) => issue.code).sort(),
    }),
    cognitive_visibility: "ik_feasibility_report",
  });
}

function buildPlanarIKReport(
  chain: ResolvedKinematicChain,
  target: Vector3,
  rootAngle: number,
  elbowAngle: number,
  residual: number,
  singularity: SingularityClass,
  solution: Readonly<Record<Ref, number>>,
  appliedLimits: ChainPlanarIKReport["applied_joint_limits"],
  issues: readonly ValidationIssue[],
): ChainPlanarIKReport {
  const distance = vectorNorm(target);
  const ikReportRef = makeRef("planar_ik", chain.chain_ref, distance.toString());
  const base = {
    schema_version: chain.schema_version,
    ik_report_ref: ikReportRef,
    embodiment_ref: chain.embodiment_ref,
    chain_ref: chain.chain_ref,
    feasible: !issues.some((issue) => issue.severity === "error") && residual <= Math.max(0.002, chain.conservative_reach_m * 0.01),
    root_angle_rad: round6(rootAngle),
    elbow_angle_rad: round6(elbowAngle),
    residual_m: round6(residual),
    target_distance_m: round6(distance),
    singularity_class: singularity,
    joint_solution: Object.freeze({ ...solution }),
    applied_joint_limits: freezeArray(appliedLimits),
    issues: freezeArray(issues),
    ok: !issues.some((issue) => issue.severity === "error"),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function validateInputShell(
  input: IKFeasibilityInput,
  policy: NormalizedIKFeasibilityPolicy,
  issues: ValidationIssue[],
): void {
  validateSafeRef(input.ik_target.ik_target_ref, "$.ik_target.ik_target_ref", "TargetFrameMissing", policy, issues);
  validateSafeRef(input.ik_target.target_frame_ref, "$.ik_target.target_frame_ref", "TargetFrameMissing", policy, issues);
  validateSafeRef(input.ik_target.kinematic_chain_ref, "$.ik_target.kinematic_chain_ref", "KinematicChainMissing", policy, issues);
  if (input.kinematic_chain !== undefined && input.kinematic_chain.chain_ref !== input.ik_target.kinematic_chain_ref) {
    issues.push(makeIssue("error", "KinematicChainMissing", "$.kinematic_chain.chain_ref", "Resolved chain does not match the IK target descriptor.", "Provide the chain named by ik_target.kinematic_chain_ref."));
  }
  if (input.current_joint_state.length === 0) {
    issues.push(makeIssue("warning", "InputMissing", "$.current_joint_state", "Current joint state is missing; solver will infer setpoints from home posture.", "Provide proprioceptive joint positions before execution."));
  }
  for (const [index, state] of input.current_joint_state.entries()) {
    validateSafeRef(state.joint_ref, `$.current_joint_state[${index}].joint_ref`, "InputMissing", policy, issues);
    validateFinite(state.position, `$.current_joint_state[${index}].position`, issues, "InputMissing");
    validateOptionalFinite(state.velocity, `$.current_joint_state[${index}].velocity`, issues, "InputMissing");
    validateOptionalFinite(state.effort, `$.current_joint_state[${index}].effort`, issues, "InputMissing");
  }
  if (input.ik_target.end_effector_role === "tool_tip" && !isToolContextValid(input.tool_context)) {
    issues.push(makeIssue("error", "ToolFrameInvalid", "$.tool_context", "Tool-tip IK requires a validated active tool frame.", "Validate tool attachment and slip risk before tool-tip IK."));
  }
}

function validatePolicy(policy: NormalizedIKFeasibilityPolicy, issues: ValidationIssue[]): void {
  for (const [path, value] of [
    ["$.policy.min_confidence_requirement", policy.min_confidence_requirement],
    ["$.policy.max_position_residual_ratio", policy.max_position_residual_ratio],
    ["$.policy.max_orientation_residual_ratio", policy.max_orientation_residual_ratio],
    ["$.policy.min_reach_margin_m", policy.min_reach_margin_m],
    ["$.policy.near_singularity_margin_m", policy.near_singularity_margin_m],
    ["$.policy.min_collision_margin_m", policy.min_collision_margin_m],
    ["$.policy.min_stability_margin_m", policy.min_stability_margin_m],
    ["$.policy.default_delta_time_s", policy.default_delta_time_s],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      issues.push(makeIssue("error", "PolicyInvalid", path, "IK policy thresholds must be finite and nonnegative.", "Use finite nonnegative policy values."));
    }
  }
  if (policy.min_confidence_requirement > 1) {
    issues.push(makeIssue("error", "PolicyInvalid", "$.policy.min_confidence_requirement", "Confidence threshold must be in [0, 1].", "Use normalized confidence."));
  }
}

function validateSafeRef(
  value: Ref,
  path: string,
  code: IKFeasibilityIssueCode,
  policy: NormalizedIKFeasibilityPolicy,
  issues: ValidationIssue[],
): void {
  if (value.trim().length === 0 || /\s/u.test(value)) {
    issues.push(makeIssue("error", code, path, "Reference must be non-empty and whitespace-free.", "Use an opaque sanitized ref."));
  }
  if (policy.reject_hidden_identifiers && HIDDEN_IK_PATTERN.test(value)) {
    issues.push(makeIssue("error", "HiddenIKLeak", path, "IK metadata contains hidden simulator/backend/QA wording.", "Strip hidden identifiers before control handoff."));
  }
}

function validateVector3(value: Vector3, path: string, issues: ValidationIssue[], code: IKFeasibilityIssueCode): void {
  if (!Array.isArray(value) || value.length !== 3 || value.some((component) => !Number.isFinite(component))) {
    issues.push(makeIssue("error", code, path, "Vector3 must contain exactly three finite values.", "Use [x, y, z] in canonical meters."));
  }
}

function validateFinite(value: number, path: string, issues: ValidationIssue[], code: IKFeasibilityIssueCode): void {
  if (!Number.isFinite(value)) {
    issues.push(makeIssue("error", code, path, "Numeric value must be finite.", "Provide a finite SI-unit value."));
  }
}

function validateOptionalFinite(value: number | undefined, path: string, issues: ValidationIssue[], code: IKFeasibilityIssueCode): void {
  if (value !== undefined) validateFinite(value, path, issues, code);
}

function mapStabilityState(
  state: StabilityState,
  margin: number | undefined,
  policy: NormalizedIKFeasibilityPolicy,
): IKStabilityStatus {
  if (state === "stable" && (margin === undefined || margin >= policy.min_stability_margin_m)) return "stable";
  if (state === "stable" || state === "marginal") return "marginal";
  if (state === "unstable") return "unstable";
  return "unknown";
}

function classifySingularityStatus(
  singularity: SingularityClass,
  reachMargin: number,
  policy: NormalizedIKFeasibilityPolicy,
): IKSingularityStatus {
  if (singularity === "degenerate") return "singular";
  if (singularity === "near_folded" || singularity === "near_extended" || reachMargin < policy.near_singularity_margin_m) return "near_singular";
  if (singularity === "not_applicable") return "unknown";
  return "clear";
}

function classifyChainSingularity(distance: number, minReach: number, maxReach: number): SingularityClass {
  if (!Number.isFinite(distance) || maxReach < EPSILON) return "not_applicable";
  if (distance < EPSILON) return "degenerate";
  const span = Math.max(EPSILON, maxReach - minReach);
  const foldedRatio = (distance - minReach) / span;
  const extendedRatio = (maxReach - distance) / span;
  if (foldedRatio < 0.08) return "near_folded";
  if (extendedRatio < 0.08) return "near_extended";
  return "clear";
}

function isToolContextValid(context: IKToolContext | undefined): boolean {
  if (context === undefined) return false;
  const maxRisk = context.max_allowed_slip_risk ?? 0.35;
  return context.attachment_validated && (context.tool_slip_risk ?? 0) <= maxRisk && context.evidence_refs.length > 0;
}

function inferRequestedVelocity(requested: number, previous: number | undefined, deltaTime: number): number | undefined {
  if (previous === undefined || deltaTime <= EPSILON) return undefined;
  return round6((requested - previous) / deltaTime);
}

function estimateJointEffort(maxEffort: number, requested: number, previous: number | undefined): number {
  const displacement = Math.abs(requested - (previous ?? 0));
  return round6(Math.min(maxEffort * 1.5, displacement * maxEffort * 0.25));
}

function safetyMarginConsumed(position: number, min: number, max: number, margin: number): number {
  if (margin <= EPSILON) return 0;
  const lower = position < min + margin ? (min + margin - position) / margin : 0;
  const upper = position > max - margin ? (position - (max - margin)) / margin : 0;
  return Math.max(0, lower, upper);
}

function distancePointToSegment(point: Vector3, start: Vector3, end: Vector3): number {
  const ab = subtractVectors(end, start);
  const ap = subtractVectors(point, start);
  const denominator = Math.max(EPSILON, dot(ab, ab));
  const t = clamp(dot(ap, ab) / denominator, 0, 1);
  const closest = addVectors(start, scaleVector(ab, t));
  return vectorNorm(subtractVectors(point, closest));
}

function ratioOrUndefined(value: number | undefined, tolerance: number | undefined): number | undefined {
  if (value === undefined || tolerance === undefined || tolerance <= EPSILON) return undefined;
  return round6(value / tolerance);
}

function minOrDefault(values: readonly number[], fallback: number): number {
  const finite = values.filter((value) => Number.isFinite(value));
  return finite.length === 0 ? fallback : Math.min(...finite);
}

function subtractVectors(a: Vector3, b: Vector3): Vector3 {
  return freezeVector3([a[0] - b[0], a[1] - b[1], a[2] - b[2]]);
}

function addVectors(a: Vector3, b: Vector3): Vector3 {
  return freezeVector3([a[0] + b[0], a[1] + b[1], a[2] + b[2]]);
}

function scaleVector(value: Vector3, scale: number): Vector3 {
  return freezeVector3([value[0] * scale, value[1] * scale, value[2] * scale]);
}

function dot(a: Vector3, b: Vector3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function vectorNorm(value: readonly number[]): number {
  return Math.sqrt(value.reduce((sum, component) => sum + component * component, 0));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampSymmetric(value: number, limit: number, enabled: boolean): number {
  return enabled ? clamp(value, -limit, limit) : value;
}

function mergePolicy(base: NormalizedIKFeasibilityPolicy, override: IKFeasibilityPolicy): NormalizedIKFeasibilityPolicy {
  return Object.freeze({
    min_confidence_requirement: clamp01(override.min_confidence_requirement ?? base.min_confidence_requirement),
    max_position_residual_ratio: positiveOrDefault(override.max_position_residual_ratio, base.max_position_residual_ratio),
    max_orientation_residual_ratio: positiveOrDefault(override.max_orientation_residual_ratio, base.max_orientation_residual_ratio),
    min_reach_margin_m: nonnegativeOrDefault(override.min_reach_margin_m, base.min_reach_margin_m),
    near_singularity_margin_m: nonnegativeOrDefault(override.near_singularity_margin_m, base.near_singularity_margin_m),
    min_collision_margin_m: nonnegativeOrDefault(override.min_collision_margin_m, base.min_collision_margin_m),
    min_stability_margin_m: nonnegativeOrDefault(override.min_stability_margin_m, base.min_stability_margin_m),
    default_delta_time_s: positiveOrDefault(override.default_delta_time_s, base.default_delta_time_s),
    clamp_candidate_to_safe_joint_limits: override.clamp_candidate_to_safe_joint_limits ?? base.clamp_candidate_to_safe_joint_limits,
    reject_on_joint_limit_warning: override.reject_on_joint_limit_warning ?? base.reject_on_joint_limit_warning,
    reject_on_actuator_warning: override.reject_on_actuator_warning ?? base.reject_on_actuator_warning,
    reject_hidden_identifiers: override.reject_hidden_identifiers ?? base.reject_hidden_identifiers,
  });
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonnegativeOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? clamp(value, 0, 1) : 0;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function freezeVector3(value: readonly number[]): Vector3 {
  return Object.freeze([round6(value[0]), round6(value[1]), round6(value[2])]) as Vector3;
}

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return freezeArray([...new Set(values)].sort());
}

function isNumber(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

function makeIssue(
  severity: ValidationSeverity,
  code: IKFeasibilityIssueCode,
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

const ZERO_VECTOR: Vector3 = Object.freeze([0, 0, 0]) as Vector3;
