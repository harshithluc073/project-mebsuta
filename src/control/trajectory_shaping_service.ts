/**
 * Trajectory shaping service for Project Mebsuta deterministic control.
 *
 * Blueprint: `architecture_docs/11_CONTROL_LAYER_IK_PD_TRAJECTORY_ARCHITECTURE.md`
 * sections 11.3, 11.4, 11.5, 11.7, 11.9, 11.14, 11.15, 11.16, and 11.17.
 *
 * This service converts an admitted IK joint solution into finite, smooth,
 * velocity-limited, acceleration-limited, contact-aware setpoint profiles. It
 * uses quintic minimum-jerk interpolation, phase-specific caps, settle-window
 * rules, abort conditions, optional joint-limit validation, and deterministic
 * rejection routing before PD tracking can consume a trajectory.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type {
  Ref,
  ValidationIssue,
  ValidationSeverity,
} from "../simulation/world_manifest";
import type {
  JointTrajectoryLimitReport,
  JointTrajectorySample,
} from "../embodiment/joint_limit_catalog";
import type {
  IKFeasibilityReport,
  IKJointSetpoint,
} from "./ik_feasibility_service";

export const TRAJECTORY_SHAPING_SERVICE_SCHEMA_VERSION = "mebsuta.trajectory_shaping_service.v1" as const;

const EPSILON = 1e-9;
const QUINTIC_MAX_VELOCITY_FACTOR = 1.875;
const QUINTIC_MAX_ACCELERATION_FACTOR = 5.773503;
const HIDDEN_TRAJECTORY_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|qa_success|qa_label|qa_only|simulator truth|mesh_name|asset_id|benchmark_truth|oracle_pose)/i;

export type PrimitivePhase = "approach" | "pregrasp" | "grasp" | "lift" | "carry" | "place" | "release" | "retreat" | "tool_contact" | "safe_hold";
export type ContactMode = "free_space" | "precontact" | "contact" | "grasp" | "carry" | "placement" | "tool_contact" | "safe_hold";
export type JerkPolicyKind = "minimum_jerk_quintic" | "hold_position" | "contact_softened_quintic";
export type TrajectoryDecision = "shaped" | "shaped_with_warnings" | "rejected";
export type TrajectoryRecommendedAction = "handoff_to_pd" | "slow_trajectory" | "repair_ik_solution" | "repair_phase_policy" | "add_settle_window" | "safe_hold" | "human_review";
export type TrajectoryRejection =
  | "UnboundedTrajectory"
  | "AbruptSetpointJump"
  | "VelocityTooHigh"
  | "AccelerationTooHigh"
  | "ContactSpeedUnsafe"
  | "SettleWindowMissing"
  | "ToolSweepUnsafe"
  | "TargetStaleBeforeStart"
  | "IKNotFeasible"
  | "JointLimitRejected"
  | "PolicyInvalid";
export type TrajectoryIssueCode =
  | "InputMissing"
  | "IKNotFeasible"
  | "UnboundedTrajectory"
  | "AbruptSetpointJump"
  | "VelocityTooHigh"
  | "AccelerationTooHigh"
  | "ContactSpeedUnsafe"
  | "SettleWindowMissing"
  | "ToolSweepUnsafe"
  | "TargetStaleBeforeStart"
  | "JointLimitRejected"
  | "HiddenTrajectoryLeak"
  | "PolicyInvalid";

/**
 * Phase-specific motion limits selected by primitive, contact mode, and safety
 * envelope.
 */
export interface PhaseMotionLimits {
  readonly max_velocity_rad_s: number;
  readonly max_acceleration_rad_s2: number;
  readonly max_jerk_rad_s3: number;
  readonly max_contact_velocity_rad_s: number;
  readonly min_duration_s: number;
  readonly max_duration_s: number;
  readonly settle_window_s?: number;
  readonly sample_period_s: number;
}

/**
 * Minimal gain-profile contract needed by trajectory shaping. Full gain
 * execution remains owned by later PD-control services.
 */
export interface TrajectoryGainProfile {
  readonly gain_profile_ref: Ref;
  readonly velocity_limit_rad_s?: number;
  readonly acceleration_limit_rad_s2?: number;
  readonly effort_limit?: number;
  readonly damping_class: "low" | "standard" | "high" | "hold";
  readonly qa_status: "untested" | "simulation_validated" | "contact_validated" | "benchmark_approved";
}

/**
 * Safety envelope for finite trajectory generation.
 */
export interface TrajectorySafetyEnvelope {
  readonly safety_envelope_ref: Ref;
  readonly max_duration_s: number;
  readonly timeout_s: number;
  readonly max_velocity_rad_s?: number;
  readonly max_acceleration_rad_s2?: number;
  readonly max_contact_velocity_rad_s?: number;
  readonly min_settle_window_s?: number;
  readonly target_fresh_until_s?: number;
  readonly planned_start_s?: number;
  readonly tool_swept_clearance_m?: number;
  readonly min_tool_swept_clearance_m?: number;
  readonly abort_condition_refs?: readonly Ref[];
}

/**
 * Current measured joint state at trajectory construction time.
 */
export interface TrajectoryCurrentJointState {
  readonly joint_ref: Ref;
  readonly position: number;
  readonly velocity?: number;
  readonly effort?: number;
}

/**
 * Settle condition required for placement, stack, release, and verification
 * phases.
 */
export interface TrajectorySettleCondition {
  readonly settle_condition_ref: Ref;
  readonly required_window_s: number;
  readonly max_position_error_rad: number;
  readonly max_velocity_rad_s: number;
  readonly contact_quiet_required: boolean;
}

/**
 * Time-indexed joint setpoint emitted for trajectory execution.
 */
export interface TrajectorySetpoint {
  readonly timestamp_s: number;
  readonly joint_ref: Ref;
  readonly position: number;
  readonly velocity: number;
  readonly acceleration: number;
  readonly effort?: number;
}

/**
 * Optional adapter for existing joint-limit validation.
 */
export interface TrajectoryShapingAdapters {
  readonly evaluateTrajectory?: (input: {
    readonly embodiment_ref?: Ref;
    readonly samples: readonly JointTrajectorySample[];
    readonly consumer: "trajectory";
    readonly clamp_to_safe_limits?: boolean;
  }) => JointTrajectoryLimitReport;
}

/**
 * Runtime shaping policy.
 */
export interface TrajectoryShapingPolicy {
  readonly sample_period_s?: number;
  readonly default_max_velocity_rad_s?: number;
  readonly default_max_acceleration_rad_s2?: number;
  readonly default_max_jerk_rad_s3?: number;
  readonly default_max_contact_velocity_rad_s?: number;
  readonly default_min_duration_s?: number;
  readonly default_max_duration_s?: number;
  readonly reject_on_joint_limit_warning?: boolean;
  readonly reject_stale_target?: boolean;
  readonly reject_hidden_identifiers?: boolean;
}

/**
 * Input for File 11 `shapeTrajectory(...)`.
 */
export interface TrajectoryShapingInput {
  readonly request_ref?: Ref;
  readonly ik_report: IKFeasibilityReport;
  readonly primitive_phase: PrimitivePhase;
  readonly gain_profile: TrajectoryGainProfile;
  readonly safety_envelope: TrajectorySafetyEnvelope;
  readonly current_joint_state: readonly TrajectoryCurrentJointState[];
  readonly contact_mode?: ContactMode;
  readonly settle_condition?: TrajectorySettleCondition;
  readonly abort_conditions?: readonly string[];
  readonly adapters?: TrajectoryShapingAdapters;
  readonly policy?: TrajectoryShapingPolicy;
}

/**
 * File 11 trajectory descriptor.
 */
export interface TrajectoryDescriptor {
  readonly schema_version: typeof TRAJECTORY_SHAPING_SERVICE_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/11_CONTROL_LAYER_IK_PD_TRAJECTORY_ARCHITECTURE.md";
  readonly trajectory_ref: Ref;
  readonly source_ik_report_ref: Ref;
  readonly primitive_phase: PrimitivePhase;
  readonly setpoint_profile: readonly TrajectorySetpoint[];
  readonly duration_estimate_s: number;
  readonly velocity_limits: Readonly<Record<Ref, number>>;
  readonly acceleration_limits: Readonly<Record<Ref, number>>;
  readonly jerk_policy: {
    readonly kind: JerkPolicyKind;
    readonly max_jerk_rad_s3: number;
    readonly smoothing_samples: number;
  };
  readonly contact_mode: ContactMode;
  readonly settle_condition?: TrajectorySettleCondition;
  readonly abort_conditions: readonly string[];
  readonly determinism_hash: string;
}

/**
 * Full trajectory shaping report with rejection details and validation output.
 */
export interface TrajectoryShapingReport {
  readonly schema_version: typeof TRAJECTORY_SHAPING_SERVICE_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/11_CONTROL_LAYER_IK_PD_TRAJECTORY_ARCHITECTURE.md";
  readonly report_ref: Ref;
  readonly trajectory?: TrajectoryDescriptor;
  readonly source_ik_report_ref: Ref;
  readonly decision: TrajectoryDecision;
  readonly recommended_action: TrajectoryRecommendedAction;
  readonly rejection_reasons: readonly TrajectoryRejection[];
  readonly joint_limit_report?: JointTrajectoryLimitReport;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
  readonly cognitive_visibility: "trajectory_shaping_report";
}

interface NormalizedTrajectoryShapingPolicy {
  readonly sample_period_s: number;
  readonly default_max_velocity_rad_s: number;
  readonly default_max_acceleration_rad_s2: number;
  readonly default_max_jerk_rad_s3: number;
  readonly default_max_contact_velocity_rad_s: number;
  readonly default_min_duration_s: number;
  readonly default_max_duration_s: number;
  readonly reject_on_joint_limit_warning: boolean;
  readonly reject_stale_target: boolean;
  readonly reject_hidden_identifiers: boolean;
}

interface TrajectoryBuildState {
  readonly limits: PhaseMotionLimits;
  readonly contactMode: ContactMode;
  readonly duration_s: number;
  readonly setpoints: readonly TrajectorySetpoint[];
  readonly jointLimitReport?: JointTrajectoryLimitReport;
}

const DEFAULT_POLICY: NormalizedTrajectoryShapingPolicy = Object.freeze({
  sample_period_s: 1 / 60,
  default_max_velocity_rad_s: 0.8,
  default_max_acceleration_rad_s2: 2.4,
  default_max_jerk_rad_s3: 16,
  default_max_contact_velocity_rad_s: 0.18,
  default_min_duration_s: 0.25,
  default_max_duration_s: 8,
  reject_on_joint_limit_warning: true,
  reject_stale_target: true,
  reject_hidden_identifiers: true,
});

/**
 * Executable File 11 `TrajectoryShapingService`.
 */
export class TrajectoryShapingService {
  private readonly policy: NormalizedTrajectoryShapingPolicy;

  public constructor(policy: TrajectoryShapingPolicy = {}) {
    this.policy = mergePolicy(DEFAULT_POLICY, policy);
  }

  /**
   * Shapes a feasible IK joint solution into a finite trajectory descriptor
   * ready for later PD tracking.
   */
  public shapeTrajectory(input: TrajectoryShapingInput): TrajectoryShapingReport {
    const policy = mergePolicy(this.policy, input.policy ?? {});
    const issues: ValidationIssue[] = [];
    validatePolicy(policy, issues);
    validateInput(input, policy, issues);

    const requestRef = input.request_ref ?? makeRef("trajectory_request", input.ik_report.ik_report_ref, input.primitive_phase);
    const state = issues.some((issue) => issue.severity === "error")
      ? undefined
      : buildTrajectoryState(input, policy, issues);
    const rejectionReasons = classifyRejections(input, state, issues, policy);
    const decision = decideTrajectory(state, rejectionReasons, issues);
    const trajectory = state === undefined || decision === "rejected"
      ? undefined
      : buildTrajectoryDescriptor(input, requestRef, state);
    const recommendedAction = chooseRecommendedAction(rejectionReasons, decision);
    const reportRef = makeRef("trajectory_shaping_report", requestRef, decision);

    return Object.freeze({
      schema_version: TRAJECTORY_SHAPING_SERVICE_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/11_CONTROL_LAYER_IK_PD_TRAJECTORY_ARCHITECTURE.md",
      report_ref: reportRef,
      trajectory,
      source_ik_report_ref: input.ik_report.ik_report_ref,
      decision,
      recommended_action: recommendedAction,
      rejection_reasons: freezeArray(rejectionReasons),
      joint_limit_report: state?.jointLimitReport,
      issues: freezeArray(issues),
      ok: decision === "shaped" || decision === "shaped_with_warnings",
      determinism_hash: computeDeterminismHash({
        reportRef,
        sourceIk: input.ik_report.ik_report_ref,
        trajectory: trajectory?.determinism_hash,
        decision,
        rejectionReasons,
        issueCodes: issues.map((issue) => issue.code).sort(),
      }),
      cognitive_visibility: "trajectory_shaping_report",
    });
  }
}

/**
 * Functional API for File 11 `shapeTrajectory(...)`.
 */
export function shapeTrajectory(input: TrajectoryShapingInput): TrajectoryShapingReport {
  return new TrajectoryShapingService(input.policy).shapeTrajectory(input);
}

function buildTrajectoryState(
  input: TrajectoryShapingInput,
  policy: NormalizedTrajectoryShapingPolicy,
  issues: ValidationIssue[],
): TrajectoryBuildState | undefined {
  const solution = input.ik_report.joint_solution;
  if (solution === undefined || solution.setpoints.length === 0) {
    issues.push(makeIssue("error", "InputMissing", "$.ik_report.joint_solution", "Trajectory shaping requires a candidate IK joint solution.", "Provide a feasible IK report with joint setpoints."));
    return undefined;
  }
  const contactMode = input.contact_mode ?? defaultContactMode(input.primitive_phase);
  const limits = mergePhaseLimits(input.primitive_phase, contactMode, input.gain_profile, input.safety_envelope, policy);
  const duration = computeTrajectoryDuration(input.current_joint_state, solution.setpoints, limits, input.safety_envelope, issues);
  const setpoints = generateQuinticSetpoints(input.current_joint_state, solution.setpoints, duration, limits);
  validateSetpointProfile(setpoints, duration, limits, contactMode, input, issues);
  const jointLimitReport = input.adapters?.evaluateTrajectory?.({
    embodiment_ref: input.ik_report.joint_solution?.kinematic_chain_ref,
    samples: setpoints.map(toJointTrajectorySample),
    consumer: "trajectory",
    clamp_to_safe_limits: false,
  });
  if (jointLimitReport !== undefined) {
    issues.push(...jointLimitReport.issues.map((issue) => Object.freeze({ ...issue, path: `$.joint_limit_report.${issue.path}` })));
    if (!jointLimitReport.ok) {
      issues.push(makeIssue("error", "JointLimitRejected", "$.joint_limit_report", "Joint-limit catalog rejected at least one shaped trajectory sample.", "Lengthen duration, reduce caps, or repair the IK solution."));
    }
  }
  return Object.freeze({
    limits,
    contactMode,
    duration_s: duration,
    setpoints,
    jointLimitReport,
  });
}

function buildTrajectoryDescriptor(
  input: TrajectoryShapingInput,
  requestRef: Ref,
  state: TrajectoryBuildState,
): TrajectoryDescriptor {
  const trajectoryRef = makeRef("trajectory", input.ik_report.ik_report_ref, input.primitive_phase);
  const velocityLimits = Object.freeze(Object.fromEntries(uniqueJointRefs(state.setpoints).map((jointRef) => [jointRef, state.limits.max_velocity_rad_s])));
  const accelerationLimits = Object.freeze(Object.fromEntries(uniqueJointRefs(state.setpoints).map((jointRef) => [jointRef, state.limits.max_acceleration_rad_s2])));
  const descriptor = {
    schema_version: TRAJECTORY_SHAPING_SERVICE_SCHEMA_VERSION,
    blueprint_ref: "architecture_docs/11_CONTROL_LAYER_IK_PD_TRAJECTORY_ARCHITECTURE.md" as const,
    trajectory_ref: trajectoryRef,
    source_ik_report_ref: input.ik_report.ik_report_ref,
    primitive_phase: input.primitive_phase,
    setpoint_profile: freezeArray(state.setpoints),
    duration_estimate_s: state.duration_s,
    velocity_limits: velocityLimits,
    acceleration_limits: accelerationLimits,
    jerk_policy: Object.freeze({
      kind: jerkKindFor(input.primitive_phase, state.contactMode),
      max_jerk_rad_s3: state.limits.max_jerk_rad_s3,
      smoothing_samples: Math.max(3, Math.ceil(state.duration_s / state.limits.sample_period_s)),
    }),
    contact_mode: state.contactMode,
    settle_condition: input.settle_condition,
    abort_conditions: freezeArray(resolveAbortConditions(input)),
  };
  return Object.freeze({
    ...descriptor,
    determinism_hash: computeDeterminismHash({
      requestRef,
      trajectoryRef,
      sourceIk: input.ik_report.ik_report_ref,
      phase: input.primitive_phase,
      duration: state.duration_s,
      sampleCount: state.setpoints.length,
      first: state.setpoints[0],
      last: state.setpoints[state.setpoints.length - 1],
      contactMode: state.contactMode,
      abort: descriptor.abort_conditions,
    }),
  });
}

function computeTrajectoryDuration(
  currentStates: readonly TrajectoryCurrentJointState[],
  targets: readonly IKJointSetpoint[],
  limits: PhaseMotionLimits,
  safety: TrajectorySafetyEnvelope,
  issues: ValidationIssue[],
): number {
  let duration = limits.min_duration_s;
  for (const target of targets) {
    const current = currentStates.find((state) => state.joint_ref === target.joint_ref);
    const start = current?.position ?? target.position;
    const delta = Math.abs(target.position - start);
    const velocityDuration = limits.max_velocity_rad_s <= EPSILON ? Number.POSITIVE_INFINITY : QUINTIC_MAX_VELOCITY_FACTOR * delta / limits.max_velocity_rad_s;
    const accelerationDuration = limits.max_acceleration_rad_s2 <= EPSILON ? Number.POSITIVE_INFINITY : Math.sqrt(QUINTIC_MAX_ACCELERATION_FACTOR * delta / limits.max_acceleration_rad_s2);
    duration = Math.max(duration, velocityDuration, accelerationDuration);
  }
  duration = round6(Math.min(Math.max(duration, limits.min_duration_s), limits.max_duration_s, safety.max_duration_s));
  if (!Number.isFinite(duration) || duration <= 0) {
    issues.push(makeIssue("error", "UnboundedTrajectory", "$.duration_estimate", "Trajectory duration must be finite and positive.", "Provide positive velocity, acceleration, and safety duration limits."));
    return limits.min_duration_s;
  }
  if (duration > safety.timeout_s + EPSILON) {
    issues.push(makeIssue("error", "UnboundedTrajectory", "$.safety_envelope.timeout_s", "Trajectory duration exceeds the safety timeout.", "Increase timeout through validation or reduce target distance."));
  }
  if (duration >= limits.max_duration_s - EPSILON || duration >= safety.max_duration_s - EPSILON) {
    issues.push(makeIssue("warning", "VelocityTooHigh", "$.duration_estimate", "Trajectory is stretched to the maximum allowed duration by speed or acceleration limits.", "Review phase caps or choose a closer intermediate setpoint."));
  }
  return duration;
}

function generateQuinticSetpoints(
  currentStates: readonly TrajectoryCurrentJointState[],
  targets: readonly IKJointSetpoint[],
  duration: number,
  limits: PhaseMotionLimits,
): readonly TrajectorySetpoint[] {
  const sampleCount = Math.max(2, Math.ceil(duration / limits.sample_period_s) + 1);
  const rows: TrajectorySetpoint[] = [];
  for (let i = 0; i < sampleCount; i += 1) {
    const t = i === sampleCount - 1 ? duration : Math.min(duration, i * limits.sample_period_s);
    const s = clamp(t / duration, 0, 1);
    const basis = minimumJerkBasis(s);
    for (const target of targets) {
      const current = currentStates.find((state) => state.joint_ref === target.joint_ref);
      const start = current?.position ?? target.position;
      const delta = target.position - start;
      rows.push(Object.freeze({
        timestamp_s: round6(t),
        joint_ref: target.joint_ref,
        position: round6(start + delta * basis.position),
        velocity: round6(delta * basis.velocity / duration),
        acceleration: round6(delta * basis.acceleration / (duration * duration)),
        effort: target.effort,
      }));
    }
  }
  return freezeArray(rows.sort((a, b) => a.timestamp_s - b.timestamp_s || a.joint_ref.localeCompare(b.joint_ref)));
}

function validateSetpointProfile(
  setpoints: readonly TrajectorySetpoint[],
  duration: number,
  limits: PhaseMotionLimits,
  contactMode: ContactMode,
  input: TrajectoryShapingInput,
  issues: ValidationIssue[],
): void {
  if (setpoints.length === 0 || duration <= 0) {
    issues.push(makeIssue("error", "UnboundedTrajectory", "$.setpoint_profile", "Setpoint profile must be non-empty and time-bounded.", "Generate at least start and end samples."));
    return;
  }
  const byJoint = groupByJoint(setpoints);
  for (const [jointRef, samples] of byJoint.entries()) {
    for (let i = 0; i < samples.length; i += 1) {
      const sample = samples[i];
      if (Math.abs(sample.velocity) > limits.max_velocity_rad_s + EPSILON) {
        issues.push(makeIssue("error", "VelocityTooHigh", `$.setpoint_profile.${jointRef}.${i}.velocity`, "Shaped setpoint exceeds phase velocity cap.", "Increase duration or reduce target displacement."));
      }
      if (Math.abs(sample.acceleration) > limits.max_acceleration_rad_s2 + EPSILON) {
        issues.push(makeIssue("error", "AccelerationTooHigh", `$.setpoint_profile.${jointRef}.${i}.acceleration`, "Shaped setpoint exceeds phase acceleration cap.", "Increase duration or reduce target displacement."));
      }
      if (isContactMode(contactMode) && Math.abs(sample.velocity) > limits.max_contact_velocity_rad_s + EPSILON) {
        issues.push(makeIssue("error", "ContactSpeedUnsafe", `$.setpoint_profile.${jointRef}.${i}.velocity`, "Contact-mode setpoint exceeds contact velocity cap.", "Use slower contact-aware trajectory limits."));
      }
      if (i > 0) {
        const previous = samples[i - 1];
        const dt = Math.max(EPSILON, sample.timestamp_s - previous.timestamp_s);
        const jerk = Math.abs((sample.acceleration - previous.acceleration) / dt);
        if (jerk > limits.max_jerk_rad_s3 + EPSILON) {
          issues.push(makeIssue("warning", "AbruptSetpointJump", `$.setpoint_profile.${jointRef}.${i}.acceleration`, "Acceleration change exceeds jerk policy.", "Increase smoothing duration or reduce acceleration cap."));
        }
      }
    }
  }
  if (requiresSettle(input.primitive_phase) && input.settle_condition === undefined) {
    issues.push(makeIssue("error", "SettleWindowMissing", "$.settle_condition", "This primitive phase requires a settle condition.", "Attach a settle window before execution."));
  }
  if (input.settle_condition !== undefined && input.settle_condition.required_window_s < (limits.settle_window_s ?? 0)) {
    issues.push(makeIssue("warning", "SettleWindowMissing", "$.settle_condition.required_window_s", "Settle window is shorter than the phase default.", "Use the phase minimum settle window."));
  }
  if (input.primitive_phase === "tool_contact") {
    const clearance = input.safety_envelope.tool_swept_clearance_m;
    const minimum = input.safety_envelope.min_tool_swept_clearance_m ?? 0.025;
    if (clearance === undefined || clearance < minimum - EPSILON) {
      issues.push(makeIssue("error", "ToolSweepUnsafe", "$.safety_envelope.tool_swept_clearance_m", "Tool-contact trajectory lacks sufficient swept-volume clearance.", "Revalidate tool swept volume before shaping."));
    }
  }
  if (input.safety_envelope.target_fresh_until_s !== undefined && input.safety_envelope.planned_start_s !== undefined && input.safety_envelope.planned_start_s > input.safety_envelope.target_fresh_until_s) {
    issues.push(makeIssue("error", "TargetStaleBeforeStart", "$.safety_envelope.target_fresh_until_s", "Target estimate expires before the planned trajectory start.", "Reobserve before execution."));
  }
}

function classifyRejections(
  input: TrajectoryShapingInput,
  state: TrajectoryBuildState | undefined,
  issues: readonly ValidationIssue[],
  policy: NormalizedTrajectoryShapingPolicy,
): readonly TrajectoryRejection[] {
  const reasons: TrajectoryRejection[] = [];
  if (input.ik_report.feasibility !== "feasible" && input.ik_report.feasibility !== "feasible_with_margin_warning") reasons.push("IKNotFeasible");
  for (const issue of issues) {
    if (isTrajectoryRejection(issue.code)) reasons.push(issue.code);
  }
  if (state?.jointLimitReport !== undefined && (!state.jointLimitReport.ok || (policy.reject_on_joint_limit_warning && state.jointLimitReport.issues.length > 0))) {
    reasons.push("JointLimitRejected");
  }
  return uniqueSorted(reasons);
}

function decideTrajectory(
  state: TrajectoryBuildState | undefined,
  reasons: readonly TrajectoryRejection[],
  issues: readonly ValidationIssue[],
): TrajectoryDecision {
  if (state === undefined || reasons.some((reason) => reason === "UnboundedTrajectory" || reason === "VelocityTooHigh" || reason === "AccelerationTooHigh" || reason === "ContactSpeedUnsafe" || reason === "SettleWindowMissing" || reason === "ToolSweepUnsafe" || reason === "TargetStaleBeforeStart" || reason === "IKNotFeasible" || reason === "JointLimitRejected" || reason === "PolicyInvalid")) return "rejected";
  return issues.some((issue) => issue.severity === "warning") ? "shaped_with_warnings" : "shaped";
}

function chooseRecommendedAction(
  reasons: readonly TrajectoryRejection[],
  decision: TrajectoryDecision,
): TrajectoryRecommendedAction {
  if (decision === "shaped") return "handoff_to_pd";
  if (reasons.includes("IKNotFeasible") || reasons.includes("JointLimitRejected")) return "repair_ik_solution";
  if (reasons.includes("SettleWindowMissing")) return "add_settle_window";
  if (reasons.includes("VelocityTooHigh") || reasons.includes("AccelerationTooHigh") || reasons.includes("ContactSpeedUnsafe") || reasons.includes("AbruptSetpointJump")) return "slow_trajectory";
  if (reasons.includes("ToolSweepUnsafe") || reasons.includes("TargetStaleBeforeStart")) return "safe_hold";
  if (reasons.includes("PolicyInvalid") || reasons.includes("UnboundedTrajectory")) return "repair_phase_policy";
  return decision === "shaped_with_warnings" ? "handoff_to_pd" : "human_review";
}

function mergePhaseLimits(
  phase: PrimitivePhase,
  contactMode: ContactMode,
  gain: TrajectoryGainProfile,
  safety: TrajectorySafetyEnvelope,
  policy: NormalizedTrajectoryShapingPolicy,
): PhaseMotionLimits {
  const defaults = phaseDefaults(phase);
  const contactScale = isContactMode(contactMode) ? 0.55 : 1;
  const velocity = Math.min(
    gain.velocity_limit_rad_s ?? Number.POSITIVE_INFINITY,
    safety.max_velocity_rad_s ?? Number.POSITIVE_INFINITY,
    policy.default_max_velocity_rad_s,
    defaults.max_velocity_rad_s,
  ) * contactScale;
  const acceleration = Math.min(
    gain.acceleration_limit_rad_s2 ?? Number.POSITIVE_INFINITY,
    safety.max_acceleration_rad_s2 ?? Number.POSITIVE_INFINITY,
    policy.default_max_acceleration_rad_s2,
    defaults.max_acceleration_rad_s2,
  ) * Math.max(0.35, contactScale);
  return Object.freeze({
    max_velocity_rad_s: round6(Math.max(0.01, velocity)),
    max_acceleration_rad_s2: round6(Math.max(0.02, acceleration)),
    max_jerk_rad_s3: round6(Math.min(policy.default_max_jerk_rad_s3, defaults.max_jerk_rad_s3)),
    max_contact_velocity_rad_s: round6(Math.min(safety.max_contact_velocity_rad_s ?? policy.default_max_contact_velocity_rad_s, defaults.max_contact_velocity_rad_s)),
    min_duration_s: round6(Math.max(policy.default_min_duration_s, defaults.min_duration_s)),
    max_duration_s: round6(Math.min(policy.default_max_duration_s, defaults.max_duration_s, safety.max_duration_s)),
    settle_window_s: safety.min_settle_window_s ?? defaults.settle_window_s,
    sample_period_s: round6(policy.sample_period_s),
  });
}

function phaseDefaults(phase: PrimitivePhase): PhaseMotionLimits {
  const table: Readonly<Record<PrimitivePhase, PhaseMotionLimits>> = {
    approach: limits(0.8, 2.2, 14, 0.18, 0.35, 5),
    pregrasp: limits(0.35, 1.1, 8, 0.12, 0.45, 6),
    grasp: limits(0.18, 0.6, 5, 0.08, 0.35, 5, 0.25),
    lift: limits(0.3, 0.9, 7, 0.12, 0.55, 6),
    carry: limits(0.28, 0.75, 6, 0.1, 0.65, 8),
    place: limits(0.2, 0.55, 4.5, 0.07, 0.6, 7, 0.35),
    release: limits(0.22, 0.65, 5, 0.08, 0.45, 5, 0.25),
    retreat: limits(0.65, 1.8, 12, 0.16, 0.35, 5),
    tool_contact: limits(0.12, 0.35, 3.5, 0.04, 0.75, 8, 0.3),
    safe_hold: limits(0.08, 0.25, 2.5, 0.03, 0.25, 4, 0.5),
  };
  return table[phase];
}

function limits(
  maxVelocity: number,
  maxAcceleration: number,
  maxJerk: number,
  maxContactVelocity: number,
  minDuration: number,
  maxDuration: number,
  settleWindow?: number,
): PhaseMotionLimits {
  return Object.freeze({
    max_velocity_rad_s: maxVelocity,
    max_acceleration_rad_s2: maxAcceleration,
    max_jerk_rad_s3: maxJerk,
    max_contact_velocity_rad_s: maxContactVelocity,
    min_duration_s: minDuration,
    max_duration_s: maxDuration,
    settle_window_s: settleWindow,
    sample_period_s: DEFAULT_POLICY.sample_period_s,
  });
}

function validateInput(
  input: TrajectoryShapingInput,
  policy: NormalizedTrajectoryShapingPolicy,
  issues: ValidationIssue[],
): void {
  validateSafeRef(input.ik_report.ik_report_ref, "$.ik_report.ik_report_ref", "InputMissing", policy, issues);
  validateSafeRef(input.gain_profile.gain_profile_ref, "$.gain_profile.gain_profile_ref", "InputMissing", policy, issues);
  validateSafeRef(input.safety_envelope.safety_envelope_ref, "$.safety_envelope.safety_envelope_ref", "InputMissing", policy, issues);
  if (input.ik_report.feasibility !== "feasible" && input.ik_report.feasibility !== "feasible_with_margin_warning") {
    issues.push(makeIssue("error", "IKNotFeasible", "$.ik_report.feasibility", "Trajectory shaping requires a feasible IK report.", "Repair IK feasibility before trajectory shaping."));
  }
  if (input.safety_envelope.timeout_s <= 0 || input.safety_envelope.max_duration_s <= 0 || input.safety_envelope.timeout_s < input.safety_envelope.max_duration_s * 0.5) {
    issues.push(makeIssue("error", "UnboundedTrajectory", "$.safety_envelope", "Safety envelope must provide positive finite duration and timeout limits.", "Use finite max_duration_s and timeout_s values."));
  }
  for (const [index, state] of input.current_joint_state.entries()) {
    validateSafeRef(state.joint_ref, `$.current_joint_state[${index}].joint_ref`, "InputMissing", policy, issues);
    validateFinite(state.position, `$.current_joint_state[${index}].position`, issues, "InputMissing");
    validateOptionalFinite(state.velocity, `$.current_joint_state[${index}].velocity`, issues, "InputMissing");
    validateOptionalFinite(state.effort, `$.current_joint_state[${index}].effort`, issues, "InputMissing");
  }
  if (input.abort_conditions !== undefined && input.abort_conditions.length === 0) {
    issues.push(makeIssue("warning", "UnboundedTrajectory", "$.abort_conditions", "Explicit abort condition list is empty.", "Provide timeout, error, contact, safety, operator, or stale-target abort conditions."));
  }
}

function validatePolicy(policy: NormalizedTrajectoryShapingPolicy, issues: ValidationIssue[]): void {
  for (const [path, value] of [
    ["$.policy.sample_period_s", policy.sample_period_s],
    ["$.policy.default_max_velocity_rad_s", policy.default_max_velocity_rad_s],
    ["$.policy.default_max_acceleration_rad_s2", policy.default_max_acceleration_rad_s2],
    ["$.policy.default_max_jerk_rad_s3", policy.default_max_jerk_rad_s3],
    ["$.policy.default_max_contact_velocity_rad_s", policy.default_max_contact_velocity_rad_s],
    ["$.policy.default_min_duration_s", policy.default_min_duration_s],
    ["$.policy.default_max_duration_s", policy.default_max_duration_s],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      issues.push(makeIssue("error", "PolicyInvalid", path, "Trajectory policy numeric values must be positive and finite.", "Use positive finite policy values."));
    }
  }
  if (policy.default_min_duration_s > policy.default_max_duration_s) {
    issues.push(makeIssue("error", "PolicyInvalid", "$.policy.duration", "Minimum duration cannot exceed maximum duration.", "Use ordered duration bounds."));
  }
}

function validateSafeRef(
  value: Ref,
  path: string,
  code: TrajectoryIssueCode,
  policy: NormalizedTrajectoryShapingPolicy,
  issues: ValidationIssue[],
): void {
  if (value.trim().length === 0 || /\s/u.test(value)) {
    issues.push(makeIssue("error", code, path, "Reference must be non-empty and whitespace-free.", "Use an opaque sanitized ref."));
  }
  if (policy.reject_hidden_identifiers && HIDDEN_TRAJECTORY_PATTERN.test(value)) {
    issues.push(makeIssue("error", "HiddenTrajectoryLeak", path, "Trajectory metadata contains hidden simulator/backend/QA wording.", "Strip hidden identifiers before trajectory shaping."));
  }
}

function validateFinite(value: number, path: string, issues: ValidationIssue[], code: TrajectoryIssueCode): void {
  if (!Number.isFinite(value)) {
    issues.push(makeIssue("error", code, path, "Numeric value must be finite.", "Use finite SI-unit values."));
  }
}

function validateOptionalFinite(value: number | undefined, path: string, issues: ValidationIssue[], code: TrajectoryIssueCode): void {
  if (value !== undefined) validateFinite(value, path, issues, code);
}

function minimumJerkBasis(s: number): { readonly position: number; readonly velocity: number; readonly acceleration: number } {
  const s2 = s * s;
  const s3 = s2 * s;
  const s4 = s3 * s;
  const s5 = s4 * s;
  return Object.freeze({
    position: 10 * s3 - 15 * s4 + 6 * s5,
    velocity: 30 * s2 - 60 * s3 + 30 * s4,
    acceleration: 60 * s - 180 * s2 + 120 * s3,
  });
}

function defaultContactMode(phase: PrimitivePhase): ContactMode {
  const table: Readonly<Record<PrimitivePhase, ContactMode>> = {
    approach: "free_space",
    pregrasp: "precontact",
    grasp: "grasp",
    lift: "carry",
    carry: "carry",
    place: "placement",
    release: "placement",
    retreat: "free_space",
    tool_contact: "tool_contact",
    safe_hold: "safe_hold",
  };
  return table[phase];
}

function jerkKindFor(phase: PrimitivePhase, contactMode: ContactMode): JerkPolicyKind {
  if (phase === "safe_hold") return "hold_position";
  return isContactMode(contactMode) ? "contact_softened_quintic" : "minimum_jerk_quintic";
}

function isContactMode(mode: ContactMode): boolean {
  return mode === "precontact" || mode === "contact" || mode === "grasp" || mode === "placement" || mode === "tool_contact" || mode === "safe_hold";
}

function requiresSettle(phase: PrimitivePhase): boolean {
  return phase === "place" || phase === "release" || phase === "safe_hold";
}

function resolveAbortConditions(input: TrajectoryShapingInput): readonly string[] {
  return freezeArray(uniqueSorted([
    ...(input.abort_conditions ?? []),
    ...(input.safety_envelope.abort_condition_refs ?? []),
    "timeout",
    "tracking_error",
    "safety_interruption",
    "operator_stop",
    "stale_target",
  ].map(sanitizeText)));
}

function toJointTrajectorySample(sample: TrajectorySetpoint): JointTrajectorySample {
  return Object.freeze({
    timestamp_s: sample.timestamp_s,
    joint_ref: sample.joint_ref,
    position: sample.position,
    velocity: sample.velocity,
    acceleration: sample.acceleration,
    effort: sample.effort,
  });
}

function groupByJoint(setpoints: readonly TrajectorySetpoint[]): ReadonlyMap<Ref, readonly TrajectorySetpoint[]> {
  const grouped = new Map<Ref, TrajectorySetpoint[]>();
  for (const sample of setpoints) {
    const values = grouped.get(sample.joint_ref) ?? [];
    values.push(sample);
    grouped.set(sample.joint_ref, values);
  }
  return new Map([...grouped.entries()].map(([jointRef, values]) => [jointRef, freezeArray(values)]));
}

function uniqueJointRefs(setpoints: readonly TrajectorySetpoint[]): readonly Ref[] {
  return uniqueSorted(setpoints.map((sample) => sample.joint_ref));
}

function isTrajectoryRejection(value: string): value is TrajectoryRejection {
  return value === "UnboundedTrajectory"
    || value === "AbruptSetpointJump"
    || value === "VelocityTooHigh"
    || value === "AccelerationTooHigh"
    || value === "ContactSpeedUnsafe"
    || value === "SettleWindowMissing"
    || value === "ToolSweepUnsafe"
    || value === "TargetStaleBeforeStart"
    || value === "IKNotFeasible"
    || value === "JointLimitRejected"
    || value === "PolicyInvalid";
}

function mergePolicy(base: NormalizedTrajectoryShapingPolicy, override: TrajectoryShapingPolicy): NormalizedTrajectoryShapingPolicy {
  return Object.freeze({
    sample_period_s: positiveOrDefault(override.sample_period_s, base.sample_period_s),
    default_max_velocity_rad_s: positiveOrDefault(override.default_max_velocity_rad_s, base.default_max_velocity_rad_s),
    default_max_acceleration_rad_s2: positiveOrDefault(override.default_max_acceleration_rad_s2, base.default_max_acceleration_rad_s2),
    default_max_jerk_rad_s3: positiveOrDefault(override.default_max_jerk_rad_s3, base.default_max_jerk_rad_s3),
    default_max_contact_velocity_rad_s: positiveOrDefault(override.default_max_contact_velocity_rad_s, base.default_max_contact_velocity_rad_s),
    default_min_duration_s: positiveOrDefault(override.default_min_duration_s, base.default_min_duration_s),
    default_max_duration_s: positiveOrDefault(override.default_max_duration_s, base.default_max_duration_s),
    reject_on_joint_limit_warning: override.reject_on_joint_limit_warning ?? base.reject_on_joint_limit_warning,
    reject_stale_target: override.reject_stale_target ?? base.reject_stale_target,
    reject_hidden_identifiers: override.reject_hidden_identifiers ?? base.reject_hidden_identifiers,
  });
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function sanitizeText(value: string): string {
  return value.trim().replace(/\s+/gu, "_").replace(HIDDEN_TRAJECTORY_PATTERN, "hidden-detail").slice(0, 120);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return freezeArray([...new Set(values)].sort());
}

function makeIssue(
  severity: ValidationSeverity,
  code: TrajectoryIssueCode,
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
