/**
 * Joint limit catalog for Project Mebsuta embodiment models.
 *
 * Blueprint: `architecture_docs/05_EMBODIMENT_KINEMATICS_QUADRUPED_HUMANOID.md`
 * sections 5.3, 5.5, 5.6, 5.10, 5.16, 5.19, and 5.20.
 *
 * This module is the executable joint-limit authority consumed by IK, PD
 * control, manipulation, safety validation, and embodiment QA. It resolves
 * declared joint ranges, velocity limits, effort limits, acceleration limits,
 * home positions, and conservative safety margins from the active embodiment
 * model without exposing simulator world truth, backend handles, collision
 * geometry, or QA-only coordinates.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { EmbodimentKind, Ref, ValidationIssue, ValidationSeverity, Vector3 } from "../simulation/world_manifest";
import { createEmbodimentModelRegistry, EmbodimentModelRegistry } from "./embodiment_model_registry";
import type { ActuatorLimitDescriptor, EmbodimentDescriptor, JointDescriptor, JointGroup, JointType } from "./embodiment_model_registry";

export const JOINT_LIMIT_CATALOG_SCHEMA_VERSION = "mebsuta.joint_limit_catalog.v1" as const;

const EPSILON = 1e-9;
const FORBIDDEN_DETAIL_PATTERN = /(engine|backend|scene_graph|world_truth|ground_truth|qa_|collision_mesh|simulator_seed|exact_com|world_pose|joint_handle|rigid_body_handle|physics_body)/i;

export type JointLimitIssueCode =
  | "ActiveEmbodimentMissing"
  | "JointRefInvalid"
  | "JointLimitMissing"
  | "JointLimitDuplicated"
  | "JointLimitInvalid"
  | "JointAxisInvalid"
  | "JointFrameMissing"
  | "ForbiddenBodyDetail"
  | "CommandInputInvalid"
  | "PositionLimitViolation"
  | "VelocityLimitViolation"
  | "AccelerationLimitViolation"
  | "EffortLimitViolation"
  | "SafetyMarginViolation"
  | "TrajectoryLimitViolation"
  | "ActuatorLimitMismatch";

export type JointLimitConsumer = "ik" | "pd_control" | "trajectory" | "manipulation" | "locomotion" | "safety" | "qa";
export type JointLimitState = "inside_safe_limits" | "inside_hard_limits" | "outside_hard_limits" | "invalid";
export type JointMotionDirection = "negative" | "positive" | "stationary";

export interface JointLimitCatalogConfig {
  readonly registry?: EmbodimentModelRegistry;
  readonly embodiment?: EmbodimentDescriptor;
  readonly active_embodiment_ref?: Ref;
}

export interface JointLimitSelectionInput {
  readonly embodiment_ref?: Ref;
  readonly joint_ref?: Ref;
  readonly joint_group?: JointGroup;
  readonly joint_type?: JointType;
}

export interface ResolvedJointLimit {
  readonly schema_version: typeof JOINT_LIMIT_CATALOG_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly joint_ref: Ref;
  readonly joint_group: JointGroup;
  readonly joint_type: JointType;
  readonly parent_frame_ref: Ref;
  readonly child_frame_ref: Ref;
  readonly axis_local: Vector3;
  readonly min_position: number;
  readonly max_position: number;
  readonly safe_min_position: number;
  readonly safe_max_position: number;
  readonly home_position: number;
  readonly position_range: number;
  readonly safe_position_range: number;
  readonly normalized_home_position: number;
  readonly max_velocity: number;
  readonly max_effort: number;
  readonly max_acceleration: number;
  readonly safety_margin: number;
  readonly minimum_stop_distance: number;
  readonly nominal_stop_time_s: number;
  readonly actuator_refs: readonly Ref[];
  readonly command_interfaces: readonly string[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
}

export interface JointGroupLimitSummary {
  readonly joint_group: JointGroup;
  readonly joint_count: number;
  readonly min_position: number;
  readonly max_position: number;
  readonly max_velocity: number;
  readonly max_effort: number;
  readonly max_acceleration: number;
  readonly average_safety_margin: number;
  readonly actuator_count: number;
}

export interface JointLimitCatalogReport {
  readonly schema_version: typeof JOINT_LIMIT_CATALOG_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly joint_count: number;
  readonly revolute_joint_count: number;
  readonly prismatic_joint_count: number;
  readonly fixed_joint_count: number;
  readonly actuated_joint_count: number;
  readonly joint_limits: readonly ResolvedJointLimit[];
  readonly joint_group_summaries: readonly JointGroupLimitSummary[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly error_count: number;
  readonly warning_count: number;
  readonly hidden_fields_removed: readonly string[];
  readonly determinism_hash: string;
}

export interface JointCommandLimitInput {
  readonly embodiment_ref?: Ref;
  readonly joint_ref: Ref;
  readonly requested_position: number;
  readonly requested_velocity?: number;
  readonly requested_acceleration?: number;
  readonly requested_effort?: number;
  readonly previous_position?: number;
  readonly previous_velocity?: number;
  readonly delta_time_s?: number;
  readonly consumer: JointLimitConsumer;
  readonly clamp_to_safe_limits?: boolean;
}

export interface JointCommandLimitReport {
  readonly schema_version: typeof JOINT_LIMIT_CATALOG_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly joint_ref: Ref;
  readonly consumer: JointLimitConsumer;
  readonly limit_state: JointLimitState;
  readonly requested_position: number;
  readonly limited_position: number;
  readonly requested_velocity?: number;
  readonly limited_velocity?: number;
  readonly requested_acceleration?: number;
  readonly limited_acceleration?: number;
  readonly requested_effort?: number;
  readonly limited_effort?: number;
  readonly inferred_velocity?: number;
  readonly inferred_acceleration?: number;
  readonly motion_direction: JointMotionDirection;
  readonly distance_to_lower_safe_limit: number;
  readonly distance_to_upper_safe_limit: number;
  readonly nearest_limit_distance: number;
  readonly safety_margin_consumed_ratio: number;
  readonly accepted: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface JointTrajectorySample {
  readonly timestamp_s: number;
  readonly joint_ref: Ref;
  readonly position: number;
  readonly velocity?: number;
  readonly acceleration?: number;
  readonly effort?: number;
}

export interface JointTrajectoryLimitInput {
  readonly embodiment_ref?: Ref;
  readonly samples: readonly JointTrajectorySample[];
  readonly consumer: JointLimitConsumer;
  readonly clamp_to_safe_limits?: boolean;
}

export interface JointTrajectoryLimitReport {
  readonly schema_version: typeof JOINT_LIMIT_CATALOG_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly sample_count: number;
  readonly accepted_sample_count: number;
  readonly rejected_sample_count: number;
  readonly reports: readonly JointCommandLimitReport[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
}

export interface CognitiveJointLimitSummary {
  readonly schema_version: typeof JOINT_LIMIT_CATALOG_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly joint_group_summaries: readonly string[];
  readonly safety_summary: readonly string[];
  readonly hidden_fields_removed: readonly string[];
  readonly cognitive_visibility: "body_self_knowledge_without_simulator_world_truth";
  readonly determinism_hash: string;
}

export class JointLimitCatalogError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "JointLimitCatalogError";
    this.issues = issues;
  }
}

/**
 * Builds deterministic joint-limit tables and evaluates proposed joint
 * commands against hard limits, safety margins, velocity, acceleration, and
 * effort bounds.
 */
export class JointLimitCatalog {
  private readonly registry: EmbodimentModelRegistry;
  private activeEmbodimentRef: Ref | undefined;

  public constructor(config: JointLimitCatalogConfig = {}) {
    this.registry = config.registry ?? createEmbodimentModelRegistry(config.embodiment === undefined ? undefined : [config.embodiment]);
    this.activeEmbodimentRef = config.active_embodiment_ref ?? config.embodiment?.embodiment_id;
    if (this.activeEmbodimentRef !== undefined) {
      this.registry.selectActiveEmbodiment({ embodiment_ref: this.activeEmbodimentRef });
    }
  }

  /**
   * Selects the active embodiment and immediately returns its limit catalog.
   */
  public selectActiveEmbodiment(embodimentRef: Ref): JointLimitCatalogReport {
    assertSafeRef(embodimentRef, "$.embodiment_ref");
    this.registry.selectActiveEmbodiment({ embodiment_ref: embodimentRef });
    this.activeEmbodimentRef = embodimentRef;
    return this.buildCatalogReport({ embodiment_ref: embodimentRef });
  }

  /**
   * Resolves all joint limits matching the optional selector. Returned tables
   * are sorted by joint ref to keep downstream reports deterministic.
   */
  public buildCatalogReport(selection: JointLimitSelectionInput = {}): JointLimitCatalogReport {
    const model = this.requireEmbodiment(selection.embodiment_ref ?? this.requireActiveEmbodiment().embodiment_id);
    const issues: ValidationIssue[] = [];
    const selectedJoints = model.joints
      .filter((joint) => selection.joint_ref === undefined || joint.joint_ref === selection.joint_ref)
      .filter((joint) => selection.joint_group === undefined || joint.joint_group === selection.joint_group)
      .filter((joint) => selection.joint_type === undefined || joint.joint_type === selection.joint_type)
      .sort((a, b) => a.joint_ref.localeCompare(b.joint_ref));
    if (selection.joint_ref !== undefined && selectedJoints.length === 0) {
      issues.push(makeIssue("error", "JointLimitMissing", "$.joint_ref", `Joint ${selection.joint_ref} is not declared.`, "Choose a joint from the active embodiment model."));
    }
    const limits = freezeArray(selectedJoints.map((joint) => resolveJointLimit(model, joint, issues)));
    validateJointCatalogCoverage(model, limits, issues);
    const groupSummaries = buildGroupSummaries(limits);
    const base = {
      schema_version: JOINT_LIMIT_CATALOG_SCHEMA_VERSION,
      embodiment_ref: model.embodiment_id,
      embodiment_kind: model.embodiment_kind,
      joint_count: limits.length,
      revolute_joint_count: limits.filter((limit) => limit.joint_type === "revolute").length,
      prismatic_joint_count: limits.filter((limit) => limit.joint_type === "prismatic").length,
      fixed_joint_count: limits.filter((limit) => limit.joint_type === "fixed").length,
      actuated_joint_count: limits.filter((limit) => limit.actuator_refs.length > 0).length,
      joint_limits: limits,
      joint_group_summaries: groupSummaries,
      issues: freezeArray(issues),
      ok: !issues.some((issue) => issue.severity === "error"),
      error_count: issues.filter((issue) => issue.severity === "error").length,
      warning_count: issues.filter((issue) => issue.severity === "warning").length,
      hidden_fields_removed: hiddenFieldsRemoved(),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Requires a single joint-limit record and throws if the active model does
   * not declare it or if its limit definition is invalid.
   */
  public requireJointLimit(jointRef: Ref, embodimentRef: Ref = this.requireActiveEmbodiment().embodiment_id): ResolvedJointLimit {
    assertSafeRef(jointRef, "$.joint_ref");
    const report = this.buildCatalogReport({ embodiment_ref: embodimentRef, joint_ref: jointRef });
    const limit = report.joint_limits.find((candidate) => candidate.joint_ref === jointRef);
    if (limit === undefined) {
      throw new JointLimitCatalogError("Joint limit is not declared for the embodiment.", [
        makeIssue("error", "JointLimitMissing", "$.joint_ref", `Joint ${jointRef} is not available on ${embodimentRef}.`, "Choose a declared joint from the active catalog."),
      ]);
    }
    if (!limit.ok) {
      throw new JointLimitCatalogError("Joint limit failed validation.", limit.issues);
    }
    return limit;
  }

  /**
   * Evaluates a proposed joint command. When `clamp_to_safe_limits` is true the
   * returned command is clipped to safe position, velocity, acceleration, and
   * effort bounds; otherwise violations are reported without changing values.
   */
  public evaluateJointCommand(input: JointCommandLimitInput): JointCommandLimitReport {
    const limit = this.requireJointLimit(input.joint_ref, input.embodiment_ref ?? this.requireActiveEmbodiment().embodiment_id);
    validateFinite(input.requested_position, "$.requested_position");
    validateOptionalFinite(input.requested_velocity, "$.requested_velocity");
    validateOptionalFinite(input.requested_acceleration, "$.requested_acceleration");
    validateOptionalFinite(input.requested_effort, "$.requested_effort");
    validateOptionalFinite(input.previous_position, "$.previous_position");
    validateOptionalFinite(input.previous_velocity, "$.previous_velocity");
    validateOptionalFinite(input.delta_time_s, "$.delta_time_s");

    const issues: ValidationIssue[] = [];
    const clampEnabled = input.clamp_to_safe_limits === true;
    const inferredVelocity = inferVelocity(input);
    const inferredAcceleration = inferAcceleration(input, inferredVelocity);
    const velocityForCheck = input.requested_velocity ?? inferredVelocity;
    const accelerationForCheck = input.requested_acceleration ?? inferredAcceleration;
    const limitedPosition = clampEnabled ? clamp(input.requested_position, limit.safe_min_position, limit.safe_max_position) : input.requested_position;
    const limitedVelocity = velocityForCheck === undefined ? undefined : clampSymmetric(velocityForCheck, limit.max_velocity, clampEnabled);
    const limitedAcceleration = accelerationForCheck === undefined ? undefined : clampSymmetric(accelerationForCheck, limit.max_acceleration, clampEnabled);
    const limitedEffort = input.requested_effort === undefined ? undefined : clampSymmetric(input.requested_effort, limit.max_effort, clampEnabled);

    const limitState = classifyPosition(input.requested_position, limit);
    if (limitState === "outside_hard_limits") {
      issues.push(makeIssue("error", "PositionLimitViolation", "$.requested_position", `Joint ${limit.joint_ref} position exceeds hard limits.`, "Reject the motion or move through a safe intermediate pose."));
    } else if (limitState === "inside_hard_limits") {
      issues.push(makeIssue("warning", "SafetyMarginViolation", "$.requested_position", `Joint ${limit.joint_ref} is inside hard limits but outside configured safety margin.`, "Prefer the safe interval before commanding IK or PD control."));
    }
    if (velocityForCheck !== undefined && Math.abs(velocityForCheck) > limit.max_velocity + EPSILON) {
      issues.push(makeIssue("warning", "VelocityLimitViolation", "$.requested_velocity", `Joint ${limit.joint_ref} velocity exceeds max velocity.`, "Reduce trajectory speed or lengthen interpolation time."));
    }
    if (accelerationForCheck !== undefined && Math.abs(accelerationForCheck) > limit.max_acceleration + EPSILON) {
      issues.push(makeIssue("warning", "AccelerationLimitViolation", "$.requested_acceleration", `Joint ${limit.joint_ref} acceleration exceeds max acceleration.`, "Smooth the trajectory or increase blend time."));
    }
    if (input.requested_effort !== undefined && Math.abs(input.requested_effort) > limit.max_effort + EPSILON) {
      issues.push(makeIssue("warning", "EffortLimitViolation", "$.requested_effort", `Joint ${limit.joint_ref} effort exceeds max effort.`, "Reduce load, use another posture, or request safe-hold."));
    }

    const lowerDistance = round6(limitedPosition - limit.safe_min_position);
    const upperDistance = round6(limit.safe_max_position - limitedPosition);
    const nearest = round6(Math.min(Math.max(0, lowerDistance), Math.max(0, upperDistance)));
    const consumed = safetyMarginConsumed(input.requested_position, limit);
    const base = {
      schema_version: JOINT_LIMIT_CATALOG_SCHEMA_VERSION,
      embodiment_ref: limit.embodiment_ref,
      joint_ref: limit.joint_ref,
      consumer: input.consumer,
      limit_state: limitState,
      requested_position: round6(input.requested_position),
      limited_position: round6(limitedPosition),
      requested_velocity: input.requested_velocity === undefined ? undefined : round6(input.requested_velocity),
      limited_velocity: limitedVelocity === undefined ? undefined : round6(limitedVelocity),
      requested_acceleration: input.requested_acceleration === undefined ? undefined : round6(input.requested_acceleration),
      limited_acceleration: limitedAcceleration === undefined ? undefined : round6(limitedAcceleration),
      requested_effort: input.requested_effort === undefined ? undefined : round6(input.requested_effort),
      limited_effort: limitedEffort === undefined ? undefined : round6(limitedEffort),
      inferred_velocity: inferredVelocity === undefined ? undefined : round6(inferredVelocity),
      inferred_acceleration: inferredAcceleration === undefined ? undefined : round6(inferredAcceleration),
      motion_direction: motionDirection(velocityForCheck ?? 0),
      distance_to_lower_safe_limit: lowerDistance,
      distance_to_upper_safe_limit: upperDistance,
      nearest_limit_distance: nearest,
      safety_margin_consumed_ratio: round6(consumed),
      accepted: !issues.some((issue) => issue.severity === "error") && (clampEnabled || !issues.some((issue) => issue.severity === "warning")),
      issues: freezeArray(issues),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Evaluates a time-ordered trajectory sample set and reports aggregate
   * acceptance. Per-sample velocity and acceleration may be explicit or
   * inferred from neighboring samples for the same joint.
   */
  public evaluateTrajectory(input: JointTrajectoryLimitInput): JointTrajectoryLimitReport {
    const model = this.requireEmbodiment(input.embodiment_ref ?? this.requireActiveEmbodiment().embodiment_id);
    const issues: ValidationIssue[] = [];
    if (input.samples.length === 0) {
      issues.push(makeIssue("error", "TrajectoryLimitViolation", "$.samples", "Trajectory must contain at least one joint sample.", "Provide time-ordered joint samples."));
    }
    const ordered = [...input.samples].sort((a, b) => a.timestamp_s - b.timestamp_s || a.joint_ref.localeCompare(b.joint_ref));
    const previousByJoint = new Map<Ref, JointTrajectorySample>();
    const reports = ordered.map((sample) => {
      validateFinite(sample.timestamp_s, "$.samples.timestamp_s");
      const previous = previousByJoint.get(sample.joint_ref);
      const delta = previous === undefined ? undefined : sample.timestamp_s - previous.timestamp_s;
      const report = this.evaluateJointCommand({
        embodiment_ref: model.embodiment_id,
        joint_ref: sample.joint_ref,
        requested_position: sample.position,
        requested_velocity: sample.velocity,
        requested_acceleration: sample.acceleration,
        requested_effort: sample.effort,
        previous_position: previous?.position,
        previous_velocity: previous?.velocity,
        delta_time_s: delta,
        consumer: input.consumer,
        clamp_to_safe_limits: input.clamp_to_safe_limits,
      });
      previousByJoint.set(sample.joint_ref, sample);
      return report;
    });
    issues.push(...reports.flatMap((report) => report.issues.map((issue) => Object.freeze({ ...issue, path: `$.samples.${report.joint_ref}.${issue.path}` }))));
    const acceptedCount = reports.filter((report) => report.accepted).length;
    const base = {
      schema_version: JOINT_LIMIT_CATALOG_SCHEMA_VERSION,
      embodiment_ref: model.embodiment_id,
      sample_count: reports.length,
      accepted_sample_count: acceptedCount,
      rejected_sample_count: reports.length - acceptedCount,
      reports: freezeArray(reports),
      issues: freezeArray(issues),
      ok: !issues.some((issue) => issue.severity === "error") && acceptedCount === reports.length,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Builds a Gemini-safe body-limit summary with coarse capability statements
   * and no raw backend implementation details.
   */
  public buildCognitiveJointLimitSummary(embodimentRef: Ref = this.requireActiveEmbodiment().embodiment_id): CognitiveJointLimitSummary {
    const report = this.buildCatalogReport({ embodiment_ref: embodimentRef });
    assertNoForbiddenLeak(report);
    const base = {
      schema_version: JOINT_LIMIT_CATALOG_SCHEMA_VERSION,
      embodiment_ref: report.embodiment_ref,
      embodiment_kind: report.embodiment_kind,
      joint_group_summaries: freezeArray(report.joint_group_summaries.map((summary) => sanitizeText(`${summary.joint_group}: ${summary.joint_count} joints, max speed ${round3(summary.max_velocity)}rad/s, max effort ${round3(summary.max_effort)}`)).sort()),
      safety_summary: freezeArray(report.joint_limits.map((limit) => sanitizeText(`${limit.joint_ref}: safe interval ${round3(limit.safe_min_position)} to ${round3(limit.safe_max_position)}, home ${round3(limit.home_position)}`)).sort()),
      hidden_fields_removed: hiddenFieldsRemoved(),
      cognitive_visibility: "body_self_knowledge_without_simulator_world_truth" as const,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  private requireActiveEmbodiment(): EmbodimentDescriptor {
    if (this.activeEmbodimentRef !== undefined) {
      return this.registry.requireEmbodiment(this.activeEmbodimentRef);
    }
    const model = this.registry.requireActiveEmbodiment();
    this.activeEmbodimentRef = model.embodiment_id;
    return model;
  }

  private requireEmbodiment(embodimentRef: Ref): EmbodimentDescriptor {
    return this.registry.requireEmbodiment(embodimentRef);
  }
}

export function createJointLimitCatalog(config: JointLimitCatalogConfig = {}): JointLimitCatalog {
  return new JointLimitCatalog(config);
}

function resolveJointLimit(model: EmbodimentDescriptor, joint: JointDescriptor, sharedIssues: ValidationIssue[]): ResolvedJointLimit {
  const issues: ValidationIssue[] = [];
  validateJointLimit(model, joint, issues);
  const actuators = model.actuator_limits.filter((actuator) => actuator.target_joint_ref === joint.joint_ref);
  const maxAcceleration = joint.max_acceleration ?? joint.max_velocity * 4;
  const safeMin = joint.min_position + joint.safety_margin;
  const safeMax = joint.max_position - joint.safety_margin;
  const range = joint.max_position - joint.min_position;
  const safeRange = Math.max(0, safeMax - safeMin);
  const normalizedHome = range <= EPSILON ? 0 : (joint.home_position - joint.min_position) / range;
  const minimumStopDistance = maxAcceleration <= EPSILON ? 0 : (joint.max_velocity * joint.max_velocity) / (2 * maxAcceleration);
  if (actuators.length === 0) {
    issues.push(makeIssue("warning", "ActuatorLimitMismatch", `$.joints.${joint.joint_ref}`, `Joint ${joint.joint_ref} has no actuator limit descriptor.`, "Bind joint limits to actuator limits before command execution."));
  }
  for (const actuator of actuators) {
    if (actuator.min_position !== undefined && actuator.min_position > joint.min_position + EPSILON) {
      issues.push(makeIssue("warning", "ActuatorLimitMismatch", `$.actuator_limits.${actuator.actuator_ref}.min_position`, "Actuator lower bound is narrower than joint hard lower bound.", "Use the narrower actuator envelope during command limiting."));
    }
    if (actuator.max_position !== undefined && actuator.max_position < joint.max_position - EPSILON) {
      issues.push(makeIssue("warning", "ActuatorLimitMismatch", `$.actuator_limits.${actuator.actuator_ref}.max_position`, "Actuator upper bound is narrower than joint hard upper bound.", "Use the narrower actuator envelope during command limiting."));
    }
  }
  const base = {
    schema_version: JOINT_LIMIT_CATALOG_SCHEMA_VERSION,
    embodiment_ref: model.embodiment_id,
    embodiment_kind: model.embodiment_kind,
    joint_ref: joint.joint_ref,
    joint_group: joint.joint_group,
    joint_type: joint.joint_type,
    parent_frame_ref: joint.parent_frame_ref,
    child_frame_ref: joint.child_frame_ref,
    axis_local: freezeVector3(joint.axis_local),
    min_position: round6(joint.min_position),
    max_position: round6(joint.max_position),
    safe_min_position: round6(safeMin),
    safe_max_position: round6(safeMax),
    home_position: round6(joint.home_position),
    position_range: round6(range),
    safe_position_range: round6(safeRange),
    normalized_home_position: round6(normalizedHome),
    max_velocity: round6(joint.max_velocity),
    max_effort: round6(joint.max_effort),
    max_acceleration: round6(maxAcceleration),
    safety_margin: round6(joint.safety_margin),
    minimum_stop_distance: round6(minimumStopDistance),
    nominal_stop_time_s: round6(maxAcceleration <= EPSILON ? 0 : joint.max_velocity / maxAcceleration),
    actuator_refs: freezeArray(actuators.map((actuator) => actuator.actuator_ref).sort()),
    command_interfaces: freezeArray([...new Set(actuators.flatMap((actuator) => actuator.command_interfaces))].sort()),
    issues: freezeArray(issues),
    ok: !issues.some((issue) => issue.severity === "error"),
  };
  sharedIssues.push(...issues);
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function validateJointLimit(model: EmbodimentDescriptor, joint: JointDescriptor, issues: ValidationIssue[]): void {
  validateSafeRef(joint.joint_ref, issues, `$.joints.${joint.joint_ref}.joint_ref`, "JointRefInvalid");
  validateSafeRef(joint.parent_frame_ref, issues, `$.joints.${joint.joint_ref}.parent_frame_ref`, "JointFrameMissing");
  validateSafeRef(joint.child_frame_ref, issues, `$.joints.${joint.joint_ref}.child_frame_ref`, "JointFrameMissing");
  const frameRefs = new Set(model.frame_graph.map((frame) => frame.frame_id));
  if (!frameRefs.has(joint.parent_frame_ref) || !frameRefs.has(joint.child_frame_ref)) {
    issues.push(makeIssue("error", "JointFrameMissing", `$.joints.${joint.joint_ref}`, "Joint parent and child frames must exist in the embodiment frame graph.", "Bind each joint to declared body frames."));
  }
  if (!isVector3(joint.axis_local)) {
    issues.push(makeIssue("error", "JointAxisInvalid", `$.joints.${joint.joint_ref}.axis_local`, "Joint axis must be a finite Vector3.", "Use a calibrated local joint axis."));
  } else if (joint.joint_type !== "fixed" && Math.abs(vectorNorm(joint.axis_local) - 1) > 1e-6) {
    issues.push(makeIssue("error", "JointAxisInvalid", `$.joints.${joint.joint_ref}.axis_local`, "Actuated joint axis must be unit length.", "Normalize the local joint axis."));
  }
  if (!Number.isFinite(joint.min_position) || !Number.isFinite(joint.max_position) || joint.min_position >= joint.max_position) {
    issues.push(makeIssue("error", "JointLimitInvalid", `$.joints.${joint.joint_ref}`, "Joint min/max positions must be finite and strictly ordered.", "Use min_position < max_position."));
  }
  if (!Number.isFinite(joint.home_position) || joint.home_position < joint.min_position || joint.home_position > joint.max_position) {
    issues.push(makeIssue("error", "JointLimitInvalid", `$.joints.${joint.joint_ref}.home_position`, "Joint home position must be finite and inside hard limits.", "Move home_position inside min/max."));
  }
  if (!Number.isFinite(joint.max_velocity) || joint.max_velocity <= 0) {
    issues.push(makeIssue("error", "JointLimitInvalid", `$.joints.${joint.joint_ref}.max_velocity`, "Joint max velocity must be positive and finite.", "Use calibrated velocity limits."));
  }
  if (!Number.isFinite(joint.max_effort) || joint.max_effort <= 0) {
    issues.push(makeIssue("error", "JointLimitInvalid", `$.joints.${joint.joint_ref}.max_effort`, "Joint max effort must be positive and finite.", "Use calibrated effort limits."));
  }
  if (joint.max_acceleration !== undefined && (!Number.isFinite(joint.max_acceleration) || joint.max_acceleration <= 0)) {
    issues.push(makeIssue("error", "JointLimitInvalid", `$.joints.${joint.joint_ref}.max_acceleration`, "Joint max acceleration must be positive and finite when provided.", "Use calibrated acceleration limits."));
  }
  if (!Number.isFinite(joint.safety_margin) || joint.safety_margin < 0) {
    issues.push(makeIssue("error", "JointLimitInvalid", `$.joints.${joint.joint_ref}.safety_margin`, "Joint safety margin must be finite and nonnegative.", "Use a nonnegative safety margin."));
  }
  const range = joint.max_position - joint.min_position;
  if (Number.isFinite(range) && joint.safety_margin * 2 >= range) {
    issues.push(makeIssue("error", "SafetyMarginViolation", `$.joints.${joint.joint_ref}.safety_margin`, "Joint safety margin consumes the full position range.", "Use a smaller margin or wider calibrated joint range."));
  }
}

function validateJointCatalogCoverage(model: EmbodimentDescriptor, limits: readonly ResolvedJointLimit[], issues: ValidationIssue[]): void {
  const refs = new Set<Ref>();
  for (const joint of model.joints) {
    if (refs.has(joint.joint_ref)) {
      issues.push(makeIssue("error", "JointLimitDuplicated", "$.joints", `Duplicate joint ${joint.joint_ref}.`, "Joint refs must be unique."));
    }
    refs.add(joint.joint_ref);
  }
  const limitRefs = new Set(limits.map((limit) => limit.joint_ref));
  for (const chain of model.kinematic_chains) {
    for (const jointRef of chain.joint_refs) {
      if (!limitRefs.has(jointRef) && model.joints.some((joint) => joint.joint_ref === jointRef)) {
        issues.push(makeIssue("warning", "JointLimitMissing", `$.kinematic_chains.${chain.chain_ref}.joint_refs`, `Chain joint ${jointRef} is outside the selected catalog view.`, "Build the full catalog before validating chains."));
      }
      if (!model.joints.some((joint) => joint.joint_ref === jointRef)) {
        issues.push(makeIssue("error", "JointLimitMissing", `$.kinematic_chains.${chain.chain_ref}.joint_refs`, `Chain joint ${jointRef} is not declared in the joint catalog.`, "Declare every chain joint with limits."));
      }
    }
  }
}

function buildGroupSummaries(limits: readonly ResolvedJointLimit[]): readonly JointGroupLimitSummary[] {
  const groups = new Map<JointGroup, ResolvedJointLimit[]>();
  for (const limit of limits) {
    const group = groups.get(limit.joint_group) ?? [];
    group.push(limit);
    groups.set(limit.joint_group, group);
  }
  return freezeArray([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, values]) => Object.freeze({
    joint_group: group,
    joint_count: values.length,
    min_position: round6(Math.min(...values.map((value) => value.min_position))),
    max_position: round6(Math.max(...values.map((value) => value.max_position))),
    max_velocity: round6(Math.max(...values.map((value) => value.max_velocity))),
    max_effort: round6(Math.max(...values.map((value) => value.max_effort))),
    max_acceleration: round6(Math.max(...values.map((value) => value.max_acceleration))),
    average_safety_margin: round6(values.reduce((sum, value) => sum + value.safety_margin, 0) / values.length),
    actuator_count: new Set(values.flatMap((value) => value.actuator_refs)).size,
  })));
}

function classifyPosition(position: number, limit: ResolvedJointLimit): JointLimitState {
  if (!Number.isFinite(position)) {
    return "invalid";
  }
  if (position < limit.min_position - EPSILON || position > limit.max_position + EPSILON) {
    return "outside_hard_limits";
  }
  if (position < limit.safe_min_position - EPSILON || position > limit.safe_max_position + EPSILON) {
    return "inside_hard_limits";
  }
  return "inside_safe_limits";
}

function inferVelocity(input: JointCommandLimitInput): number | undefined {
  if (input.previous_position === undefined || input.delta_time_s === undefined || input.delta_time_s <= EPSILON) {
    return undefined;
  }
  return (input.requested_position - input.previous_position) / input.delta_time_s;
}

function inferAcceleration(input: JointCommandLimitInput, inferredVelocity: number | undefined): number | undefined {
  if (inferredVelocity === undefined || input.previous_velocity === undefined || input.delta_time_s === undefined || input.delta_time_s <= EPSILON) {
    return undefined;
  }
  return (inferredVelocity - input.previous_velocity) / input.delta_time_s;
}

function safetyMarginConsumed(position: number, limit: ResolvedJointLimit): number {
  if (position >= limit.safe_min_position && position <= limit.safe_max_position) {
    return 0;
  }
  if (position < limit.safe_min_position) {
    return clamp((limit.safe_min_position - position) / Math.max(limit.safety_margin, EPSILON), 0, 1);
  }
  return clamp((position - limit.safe_max_position) / Math.max(limit.safety_margin, EPSILON), 0, 1);
}

function motionDirection(velocity: number): JointMotionDirection {
  if (velocity > EPSILON) {
    return "positive";
  }
  if (velocity < -EPSILON) {
    return "negative";
  }
  return "stationary";
}

function clampSymmetric(value: number, maxAbs: number, enabled: boolean): number {
  return enabled ? clamp(value, -maxAbs, maxAbs) : value;
}

function assertSafeRef(ref: Ref, path: string): void {
  const issues: ValidationIssue[] = [];
  validateSafeRef(ref, issues, path, "JointRefInvalid");
  if (issues.length > 0) {
    throw new JointLimitCatalogError("Reference is not safe for joint limit use.", issues);
  }
}

function validateSafeRef(ref: Ref, issues: ValidationIssue[], path: string, code: JointLimitIssueCode): void {
  if (typeof ref !== "string" || ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(makeIssue("error", code, path, "Reference must be a non-empty whitespace-free string.", "Use an opaque body-relative reference."));
  }
  if (ref === "W" || !isSafeText(ref)) {
    issues.push(makeIssue("error", "ForbiddenBodyDetail", path, "Reference contains forbidden simulator/backend detail.", "Use sanitized body, frame, or joint refs."));
  }
}

function assertNoForbiddenLeak(report: JointLimitCatalogReport): void {
  const issues: ValidationIssue[] = [];
  for (const limit of report.joint_limits) {
    for (const value of [limit.joint_ref, limit.parent_frame_ref, limit.child_frame_ref, ...limit.actuator_refs]) {
      if (!isSafeText(value) || value === "W") {
        issues.push(makeIssue("error", "ForbiddenBodyDetail", "$.joint_limits", `Joint limit field ${value} contains forbidden simulator detail.`, "Strip backend handles and world-truth refs before model-facing output."));
      }
    }
  }
  if (issues.length > 0) {
    throw new JointLimitCatalogError("Joint limit report contains forbidden simulator detail.", issues);
  }
}

function validateFinite(value: number, path: string): void {
  if (!Number.isFinite(value)) {
    throw new JointLimitCatalogError("Numeric input is invalid.", [
      makeIssue("error", "CommandInputInvalid", path, "Value must be finite.", "Use finite SI-unit command values."),
    ]);
  }
}

function validateOptionalFinite(value: number | undefined, path: string): void {
  if (value !== undefined && !Number.isFinite(value)) {
    throw new JointLimitCatalogError("Numeric input is invalid.", [
      makeIssue("error", "CommandInputInvalid", path, "Optional value must be finite when provided.", "Use finite SI-unit command values or omit the field."),
    ]);
  }
}

function isVector3(value: readonly number[]): value is Vector3 {
  return value.length === 3 && value.every((component) => Number.isFinite(component));
}

function hiddenFieldsRemoved(): readonly string[] {
  return freezeArray(["simulator_world_frame_W", "backend_body_handles", "engine_joint_handles", "collision_mesh_refs", "exact_hidden_com", "qa_truth_refs"]);
}

function sanitizeText(value: string): string {
  return value.replace(FORBIDDEN_DETAIL_PATTERN, "hidden-detail").trim();
}

function isSafeText(value: string): boolean {
  return !FORBIDDEN_DETAIL_PATTERN.test(value);
}

function makeIssue(severity: ValidationSeverity, code: JointLimitIssueCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function vectorNorm(value: Vector3): number {
  return Math.hypot(value[0], value[1], value[2]);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function round6(value: number): number {
  return Math.round(value * 1000000) / 1000000;
}

function freezeVector3(value: readonly number[]): Vector3 {
  return Object.freeze([round6(value[0]), round6(value[1]), round6(value[2])]) as Vector3;
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

export const JOINT_LIMIT_CATALOG_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: JOINT_LIMIT_CATALOG_SCHEMA_VERSION,
  blueprint: "architecture_docs/05_EMBODIMENT_KINEMATICS_QUADRUPED_HUMANOID.md",
  sections: freezeArray(["5.3", "5.5", "5.6", "5.10", "5.16", "5.19", "5.20"]),
  responsibilities: freezeArray([
    "resolve min and max joint positions",
    "resolve velocity, acceleration, effort, and safety-margin envelopes",
    "validate joint axes, frame bindings, and actuator coverage",
    "evaluate IK, PD, trajectory, manipulation, locomotion, safety, and QA joint commands",
    "publish cognitive-safe joint limitation summaries",
  ]),
});
