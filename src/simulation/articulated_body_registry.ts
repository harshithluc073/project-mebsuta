/**
 * Articulated body registry for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/03_SIMULATION_AND_PHYSICS_ENGINE_ARCHITECTURE.md`
 * sections 3.5, 3.9, 3.17, 3.18, 3.19, and 3.20, with kinematic math aligned
 * to files 05, 10, and 11.
 *
 * This module registers executable quadruped and humanoid body descriptors:
 * body trees, joints, inertias, contact sites, sensor mounts, actuator maps,
 * self-collision policy, stability policy, forward kinematics, Jacobians, and
 * deterministic damped least-squares point IK. Engine handles and exact body
 * internals are simulator/control truth; use `buildEmbodimentPromptContract`
 * for model-facing self-knowledge.
 */

import { computeDeterminismHash } from "./world_manifest";
import type {
  EmbodimentKind,
  InertiaTensor,
  Quaternion,
  Ref,
  Transform,
  ValidationIssue,
  ValidationSeverity,
  Vector3,
} from "./world_manifest";

export const ARTICULATED_BODY_REGISTRY_SCHEMA_VERSION = "mebsuta.articulated_body_registry.v1" as const;
const IDENTITY_QUATERNION: Quaternion = [0, 0, 0, 1];
const ZERO_VECTOR: Vector3 = [0, 0, 0];

export type BodyRegion = "base" | "torso" | "head" | "leg" | "arm" | "hand" | "gripper" | "mouth" | "tool_interface" | "tail" | "sensor_carrier";
export type JointType = "fixed" | "revolute" | "prismatic";
export type JointGroup = "base" | "torso" | "head" | "front_leg" | "rear_leg" | "arm" | "hand" | "gripper" | "mouth" | "tool";
export type ActuatorKind = "rotary_servo" | "linear_servo" | "grip_force" | "passive";
export type ActuatorCommandInterface = "position" | "velocity" | "effort" | "impedance" | "grip";
export type ContactSiteRole = "foot" | "paw" | "hand" | "fingertip" | "mouth" | "gripper" | "body_collision" | "tool_contact";
export type SensorMountRole = "camera" | "depth_camera" | "microphone" | "imu" | "encoder" | "contact_sensor" | "force_torque";
export type EndEffectorRole = "mouth_gripper" | "paw" | "hand" | "wrist" | "tool_tip" | "gaze" | "base";
export type IKFeasibility = "feasible" | "feasible_with_margin_warning" | "infeasible" | "unsafe" | "ambiguous";
export type SingularityStatus = "clear" | "near_singular" | "singular" | "unknown";

export interface JointLimit {
  readonly min_position: number;
  readonly max_position: number;
  readonly max_velocity: number;
  readonly max_effort: number;
  readonly max_acceleration?: number;
  readonly safety_margin?: number;
}

export interface BodyLinkDescriptor {
  readonly body_ref: Ref;
  readonly body_region: BodyRegion;
  readonly parent_body_ref?: Ref;
  readonly parent_joint_ref?: Ref;
  readonly local_transform_parent_to_joint: Transform;
  readonly local_transform_joint_to_child: Transform;
  readonly mass_kg: number;
  readonly inertia_tensor: InertiaTensor;
  readonly center_of_mass_local_m: Vector3;
  readonly collision_shape_refs: readonly Ref[];
  readonly visual_shape_ref?: Ref;
  readonly cognitive_visibility: "self_body_summary_allowed" | "forbidden_engine_detail";
}

export interface JointDescriptor {
  readonly joint_ref: Ref;
  readonly joint_group: JointGroup;
  readonly joint_type: JointType;
  readonly parent_body_ref: Ref;
  readonly child_body_ref: Ref;
  readonly axis_local: Vector3;
  readonly limit: JointLimit;
  readonly home_position: number;
  readonly damping_n_m_s_per_rad: number;
  readonly stiffness_n_m_per_rad?: number;
  readonly actuator_ref?: Ref;
  readonly control_sign: 1 | -1;
}

export interface ActuatorDescriptor {
  readonly actuator_ref: Ref;
  readonly joint_ref: Ref;
  readonly actuator_kind: ActuatorKind;
  readonly command_interface: ActuatorCommandInterface;
  readonly effort_limit: number;
  readonly velocity_limit: number;
  readonly position_limit: readonly [number, number];
  readonly saturation_policy: "clip_and_report" | "reject_command" | "safe_hold";
}

export interface ContactSiteDescriptor {
  readonly contact_site_ref: Ref;
  readonly body_ref: Ref;
  readonly contact_role: ContactSiteRole;
  readonly local_transform: Transform;
  readonly sensor_ref?: Ref;
  readonly material_profile_ref?: Ref;
  readonly cognitive_visibility: "tactile_summary_allowed" | "forbidden_solver_detail";
}

export interface SensorMountDescriptor {
  readonly sensor_mount_ref: Ref;
  readonly body_ref: Ref;
  readonly sensor_role: SensorMountRole;
  readonly local_transform: Transform;
  readonly declared_calibration_visibility: "cognitive_allowed" | "internal_only";
}

export interface KinematicChainDescriptor {
  readonly chain_ref: Ref;
  readonly root_body_ref: Ref;
  readonly tip_body_ref: Ref;
  readonly joint_refs: readonly Ref[];
  readonly end_effector_ref?: Ref;
  readonly end_effector_role?: EndEffectorRole;
  readonly nominal_reach_m: number;
  readonly max_payload_kg: number;
}

export interface SelfCollisionPolicy {
  readonly policy_ref: Ref;
  readonly forbidden_body_pairs: readonly (readonly [Ref, Ref])[];
  readonly allowed_body_pairs: readonly (readonly [Ref, Ref])[];
  readonly minimum_clearance_m: number;
}

export interface StabilityPolicyDescriptor {
  readonly stability_policy_ref: Ref;
  readonly support_contact_site_refs: readonly Ref[];
  readonly nominal_center_of_mass_height_m: number;
  readonly max_base_tilt_rad: number;
  readonly max_carried_load_kg: number;
  readonly support_polygon_margin_m: number;
}

export interface EmbodimentPhysicsDescriptor {
  readonly embodiment_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly body_tree: readonly BodyLinkDescriptor[];
  readonly joint_limit_table: readonly JointDescriptor[];
  readonly actuator_limit_table: readonly ActuatorDescriptor[];
  readonly contact_site_table: readonly ContactSiteDescriptor[];
  readonly sensor_mount_table: readonly SensorMountDescriptor[];
  readonly kinematic_chains: readonly KinematicChainDescriptor[];
  readonly self_collision_policy: SelfCollisionPolicy;
  readonly stability_policy: StabilityPolicyDescriptor;
  readonly body_summary: string;
  readonly locomotion_primitives: readonly string[];
  readonly manipulation_primitives: readonly string[];
}

export interface EmbodimentRegistrationReport {
  readonly ok: boolean;
  readonly embodiment_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly body_count: number;
  readonly joint_count: number;
  readonly actuator_count: number;
  readonly contact_site_count: number;
  readonly sensor_mount_count: number;
  readonly kinematic_chain_count: number;
  readonly total_mass_kg: number;
  readonly issue_count: number;
  readonly error_count: number;
  readonly warning_count: number;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface BodyTransformRecord {
  readonly body_ref: Ref;
  readonly transform: Transform;
  readonly parent_body_ref?: Ref;
  readonly parent_joint_ref?: Ref;
}

export interface JointWorldAxisRecord {
  readonly joint_ref: Ref;
  readonly joint_type: JointType;
  readonly origin_m: Vector3;
  readonly axis_world: Vector3;
}

export interface ForwardKinematicsReport {
  readonly embodiment_ref: Ref;
  readonly root_transform: Transform;
  readonly body_transforms: readonly BodyTransformRecord[];
  readonly joint_world_axes: readonly JointWorldAxisRecord[];
  readonly determinism_hash: string;
}

export interface CenterOfMassReport {
  readonly embodiment_ref: Ref;
  readonly total_mass_kg: number;
  readonly center_of_mass_m: Vector3;
  readonly determinism_hash: string;
}

export interface PointJacobianReport {
  readonly embodiment_ref: Ref;
  readonly chain_ref: Ref;
  readonly body_ref: Ref;
  readonly point_world_m: Vector3;
  readonly joint_refs: readonly Ref[];
  readonly linear_jacobian: readonly Vector3[];
  readonly angular_jacobian: readonly Vector3[];
  readonly manipulability: number;
  readonly singularity_status: SingularityStatus;
  readonly determinism_hash: string;
}

export interface IKPointTarget {
  readonly embodiment_ref: Ref;
  readonly chain_ref: Ref;
  readonly target_position_m: Vector3;
  readonly seed_joint_positions?: Readonly<Record<Ref, number>>;
  readonly root_transform?: Transform;
  readonly local_tip_point_m?: Vector3;
  readonly tolerance_m?: number;
  readonly max_iterations?: number;
  readonly damping_lambda?: number;
  readonly step_scale?: number;
}

export interface IKPointSolveReport {
  readonly ik_report_ref: Ref;
  readonly embodiment_ref: Ref;
  readonly chain_ref: Ref;
  readonly feasibility: IKFeasibility;
  readonly joint_solution: Readonly<Record<Ref, number>>;
  readonly iterations: number;
  readonly residual_m: number;
  readonly limit_margin_rad_or_m: number;
  readonly singularity_status: SingularityStatus;
  readonly recommended_recovery?: "reposition" | "reobserve" | "use_tool" | "lower_target" | "safe_hold" | "human_review";
  readonly determinism_hash: string;
}

export interface EmbodimentContractPacket {
  readonly embodiment_kind: EmbodimentKind;
  readonly sensor_summary: readonly string[];
  readonly end_effector_summary: readonly string[];
  readonly locomotion_summary: readonly string[];
  readonly manipulation_summary: readonly string[];
  readonly reach_summary: readonly string[];
  readonly stability_summary: string;
  readonly forbidden_fields_removed: readonly string[];
}

export class ArticulatedBodyRegistryError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "ArticulatedBodyRegistryError";
    this.issues = issues;
  }
}

export class ArticulatedBodyRegistry {
  private readonly descriptorsByRef: Map<Ref, EmbodimentPhysicsDescriptor> = new Map();

  public constructor(descriptors: readonly EmbodimentPhysicsDescriptor[] = []) {
    for (const descriptor of descriptors) {
      this.registerEmbodimentModel(descriptor);
    }
  }

  public registerEmbodimentModel(descriptor: EmbodimentPhysicsDescriptor): EmbodimentRegistrationReport {
    const report = validateEmbodimentPhysicsDescriptor(descriptor);
    if (!report.ok) {
      throw new ArticulatedBodyRegistryError(`Embodiment ${descriptor.embodiment_ref} failed validation.`, report.issues);
    }
    this.descriptorsByRef.set(descriptor.embodiment_ref, freezeDescriptor(descriptor));
    return report;
  }

  public has(embodimentRef: Ref): boolean {
    return this.descriptorsByRef.has(embodimentRef);
  }

  public get(embodimentRef: Ref): EmbodimentPhysicsDescriptor {
    const descriptor = this.descriptorsByRef.get(embodimentRef);
    if (descriptor === undefined) {
      throw new ArticulatedBodyRegistryError(`Unknown embodiment ref: ${embodimentRef}`, [
        makeIssue("error", "EmbodimentMissing", "$.embodiment_ref", "Embodiment is not registered.", "Register the embodiment before selecting it for simulation."),
      ]);
    }
    return descriptor;
  }

  public list(): readonly EmbodimentPhysicsDescriptor[] {
    return Object.freeze([...this.descriptorsByRef.values()].sort((a, b) => a.embodiment_ref.localeCompare(b.embodiment_ref)));
  }

  public validate(embodimentRef: Ref): EmbodimentRegistrationReport {
    return validateEmbodimentPhysicsDescriptor(this.get(embodimentRef));
  }

  public computeForwardKinematics(
    embodimentRef: Ref,
    jointPositions: Readonly<Record<Ref, number>> = {},
    rootTransform: Transform = identityTransform("W"),
  ): ForwardKinematicsReport {
    const descriptor = this.get(embodimentRef);
    const bodyByRef = mapBodies(descriptor);
    const jointByRef = mapJoints(descriptor);
    const bodyTransforms = new Map<Ref, Transform>();
    const jointAxes = new Map<Ref, JointWorldAxisRecord>();

    for (const body of topologicalBodies(descriptor)) {
      if (body.parent_body_ref === undefined || body.parent_joint_ref === undefined) {
        bodyTransforms.set(body.body_ref, freezeTransform(rootTransform));
        continue;
      }

      const parentTransform = bodyTransforms.get(body.parent_body_ref);
      const joint = jointByRef.get(body.parent_joint_ref);
      if (parentTransform === undefined || joint === undefined) {
        throw new ArticulatedBodyRegistryError(`Kinematic closure failed for ${body.body_ref}.`, [
          makeIssue("error", "BodyTreeInvalid", "$.body_tree", "Parent transform or joint is missing during forward kinematics.", "Validate body tree closure before computing kinematics."),
        ]);
      }

      const q = clampJointPosition(jointPositions[joint.joint_ref] ?? joint.home_position, joint);
      const jointBase = composeTransforms(parentTransform, body.local_transform_parent_to_joint, body.local_transform_parent_to_joint.frame_ref);
      const axisWorld = normalizeVector(rotateVector(jointBase.orientation_xyzw, joint.axis_local));
      jointAxes.set(joint.joint_ref, Object.freeze({
        joint_ref: joint.joint_ref,
        joint_type: joint.joint_type,
        origin_m: jointBase.position_m,
        axis_world: axisWorld,
      }));

      const motion = jointMotionTransform(joint, q);
      const afterMotion = composeTransforms(jointBase, motion, jointBase.frame_ref);
      const childTransform = composeTransforms(afterMotion, body.local_transform_joint_to_child, body.local_transform_joint_to_child.frame_ref);
      if (!bodyByRef.has(joint.child_body_ref) || joint.child_body_ref !== body.body_ref) {
        throw new ArticulatedBodyRegistryError(`Joint ${joint.joint_ref} child mismatch.`, [
          makeIssue("error", "JointChildMismatch", "$.joint_limit_table", "Joint child does not match the traversed body.", "Repair the body tree and joint table mapping."),
        ]);
      }
      bodyTransforms.set(body.body_ref, childTransform);
    }

    const bodyRecords = [...bodyTransforms.entries()]
      .map(([bodyRef, transform]) => {
        const body = bodyByRef.get(bodyRef);
        return Object.freeze({
          body_ref: bodyRef,
          transform,
          parent_body_ref: body?.parent_body_ref,
          parent_joint_ref: body?.parent_joint_ref,
        });
      })
      .sort((a, b) => a.body_ref.localeCompare(b.body_ref));
    const axisRecords = [...jointAxes.values()].sort((a, b) => a.joint_ref.localeCompare(b.joint_ref));
    const reportBase = {
      embodiment_ref: embodimentRef,
      root_transform: freezeTransform(rootTransform),
      body_transforms: freezeArray(bodyRecords),
      joint_world_axes: freezeArray(axisRecords),
    };
    return Object.freeze({
      ...reportBase,
      determinism_hash: computeDeterminismHash(reportBase),
    });
  }

  public computeCenterOfMass(
    embodimentRef: Ref,
    jointPositions: Readonly<Record<Ref, number>> = {},
    rootTransform: Transform = identityTransform("W"),
  ): CenterOfMassReport {
    const descriptor = this.get(embodimentRef);
    const fk = this.computeForwardKinematics(embodimentRef, jointPositions, rootTransform);
    const transformByBody = new Map(fk.body_transforms.map((record) => [record.body_ref, record.transform] as const));
    let totalMass = 0;
    let weighted: Vector3 = ZERO_VECTOR;

    for (const body of descriptor.body_tree) {
      const bodyTransform = transformByBody.get(body.body_ref);
      if (bodyTransform === undefined) {
        continue;
      }
      const comWorld = transformPoint(bodyTransform, body.center_of_mass_local_m);
      weighted = addVector3(weighted, scaleVector3(comWorld, body.mass_kg));
      totalMass += body.mass_kg;
    }

    if (totalMass <= 0) {
      throw new ArticulatedBodyRegistryError(`Embodiment ${embodimentRef} has no positive mass.`, [
        makeIssue("error", "MassDistributionInvalid", "$.body_tree", "Total articulated body mass must be positive.", "Assign positive mass to body links."),
      ]);
    }

    const reportBase = {
      embodiment_ref: embodimentRef,
      total_mass_kg: totalMass,
      center_of_mass_m: scaleVector3(weighted, 1 / totalMass),
    };
    return Object.freeze({
      ...reportBase,
      determinism_hash: computeDeterminismHash(reportBase),
    });
  }

  public computePointJacobian(input: {
    readonly embodiment_ref: Ref;
    readonly chain_ref: Ref;
    readonly joint_positions?: Readonly<Record<Ref, number>>;
    readonly root_transform?: Transform;
    readonly local_point_m?: Vector3;
  }): PointJacobianReport {
    const descriptor = this.get(input.embodiment_ref);
    const chain = requireChain(descriptor, input.chain_ref);
    const fk = this.computeForwardKinematics(input.embodiment_ref, input.joint_positions ?? {}, input.root_transform ?? identityTransform("W"));
    const tipTransform = requireBodyTransform(fk, chain.tip_body_ref);
    const pointWorld = transformPoint(tipTransform, input.local_point_m ?? ZERO_VECTOR);
    const axisByJoint = new Map(fk.joint_world_axes.map((axis) => [axis.joint_ref, axis] as const));
    const jointByRef = mapJoints(descriptor);
    const linearColumns: Vector3[] = [];
    const angularColumns: Vector3[] = [];

    for (const jointRef of chain.joint_refs) {
      const joint = jointByRef.get(jointRef);
      const axis = axisByJoint.get(jointRef);
      if (joint === undefined || axis === undefined || joint.joint_type === "fixed") {
        linearColumns.push(ZERO_VECTOR);
        angularColumns.push(ZERO_VECTOR);
        continue;
      }
      if (joint.joint_type === "revolute") {
        const radius = subtractVector3(pointWorld, axis.origin_m);
        linearColumns.push(cross(axis.axis_world, radius));
        angularColumns.push(axis.axis_world);
      } else {
        linearColumns.push(axis.axis_world);
        angularColumns.push(ZERO_VECTOR);
      }
    }

    const manipulability = computeManipulability(linearColumns);
    const reportBase = {
      embodiment_ref: input.embodiment_ref,
      chain_ref: input.chain_ref,
      body_ref: chain.tip_body_ref,
      point_world_m: pointWorld,
      joint_refs: freezeArray([...chain.joint_refs]),
      linear_jacobian: freezeArray(linearColumns),
      angular_jacobian: freezeArray(angularColumns),
      manipulability,
      singularity_status: classifySingularity(manipulability),
    };
    return Object.freeze({
      ...reportBase,
      determinism_hash: computeDeterminismHash(reportBase),
    });
  }

  public solvePointIK(target: IKPointTarget): IKPointSolveReport {
    const descriptor = this.get(target.embodiment_ref);
    const chain = requireChain(descriptor, target.chain_ref);
    const jointByRef = mapJoints(descriptor);
    const q: Record<Ref, number> = {};
    const tolerance = target.tolerance_m ?? 0.01;
    const maxIterations = target.max_iterations ?? 80;
    const damping = target.damping_lambda ?? 0.05;
    const stepScale = target.step_scale ?? 0.75;

    assertPositiveFinite(tolerance, "tolerance_m");
    assertPositiveInteger(maxIterations, "max_iterations");
    assertPositiveFinite(damping, "damping_lambda");
    assertPositiveFinite(stepScale, "step_scale");

    for (const jointRef of chain.joint_refs) {
      const joint = requireJoint(jointByRef, jointRef);
      q[jointRef] = clampJointPosition(target.seed_joint_positions?.[jointRef] ?? joint.home_position, joint);
    }

    let residual = Number.POSITIVE_INFINITY;
    let singularityStatus: SingularityStatus = "unknown";
    let iterations = 0;
    for (; iterations < maxIterations; iterations += 1) {
      const jacobian = this.computePointJacobian({
        embodiment_ref: target.embodiment_ref,
        chain_ref: target.chain_ref,
        joint_positions: q,
        root_transform: target.root_transform,
        local_point_m: target.local_tip_point_m,
      });
      singularityStatus = jacobian.singularity_status;
      const error = subtractVector3(target.target_position_m, jacobian.point_world_m);
      residual = vectorNorm(error);
      if (residual <= tolerance) {
        break;
      }

      const delta = dampedLeastSquaresStep(jacobian.linear_jacobian, error, damping);
      for (let column = 0; column < chain.joint_refs.length; column += 1) {
        const jointRef = chain.joint_refs[column];
        const joint = requireJoint(jointByRef, jointRef);
        if (joint.joint_type === "fixed") {
          continue;
        }
        q[jointRef] = clampJointPosition(q[jointRef] + stepScale * delta[column] * joint.control_sign, joint);
      }
    }

    const limitMargin = minimumLimitMargin(chain.joint_refs, q, jointByRef);
    const feasibility: IKFeasibility = residual <= tolerance
      ? limitMargin < 0.02
        ? "feasible_with_margin_warning"
        : "feasible"
      : singularityStatus === "singular"
        ? "unsafe"
        : "infeasible";
    const reportBase = {
      ik_report_ref: `ik_${target.embodiment_ref}_${target.chain_ref}_${computeDeterminismHash([target.target_position_m, q]).slice(0, 8)}`,
      embodiment_ref: target.embodiment_ref,
      chain_ref: target.chain_ref,
      feasibility,
      joint_solution: freezeRecord(q),
      iterations,
      residual_m: residual,
      limit_margin_rad_or_m: limitMargin,
      singularity_status: singularityStatus,
      recommended_recovery: selectRecovery(feasibility, residual, limitMargin, singularityStatus),
    };
    return Object.freeze({
      ...reportBase,
      determinism_hash: computeDeterminismHash(reportBase),
    });
  }

  public buildEmbodimentPromptContract(embodimentRef: Ref): EmbodimentContractPacket {
    const descriptor = this.get(embodimentRef);
    return Object.freeze({
      embodiment_kind: descriptor.embodiment_kind,
      sensor_summary: freezeArray(descriptor.sensor_mount_table.map((sensor) => `${sensor.sensor_role} mounted on ${bodyRegionOf(descriptor, sensor.body_ref)}`)),
      end_effector_summary: freezeArray(descriptor.kinematic_chains.filter((chain) => chain.end_effector_role !== undefined).map((chain) => `${chain.end_effector_role} reach approximately ${chain.nominal_reach_m.toFixed(2)} m`)),
      locomotion_summary: freezeArray([...descriptor.locomotion_primitives]),
      manipulation_summary: freezeArray([...descriptor.manipulation_primitives]),
      reach_summary: freezeArray(descriptor.kinematic_chains.map((chain) => `${chain.chain_ref}: nominal reach ${chain.nominal_reach_m.toFixed(2)} m, payload limit ${chain.max_payload_kg.toFixed(2)} kg`)),
      stability_summary: `Balance checks use declared support contacts with ${descriptor.stability_policy.support_polygon_margin_m.toFixed(3)} m conservative support margin.`,
      forbidden_fields_removed: freezeArray([
        "body_tree",
        "joint_limit_table",
        "actuator_limit_table",
        "collision_shape_refs",
        "self_collision_policy",
        "exact_center_of_mass",
        "engine_handles",
        "simulator_world_pose",
      ]),
    });
  }
}

export function createArticulatedBodyRegistry(descriptors: readonly EmbodimentPhysicsDescriptor[] = []): ArticulatedBodyRegistry {
  return new ArticulatedBodyRegistry(descriptors);
}

export function validateEmbodimentPhysicsDescriptor(descriptor: EmbodimentPhysicsDescriptor): EmbodimentRegistrationReport {
  const issues: ValidationIssue[] = [];
  validateRef(descriptor.embodiment_ref, issues, "$.embodiment_ref", "EmbodimentRefInvalid");
  if (descriptor.embodiment_kind !== "quadruped" && descriptor.embodiment_kind !== "humanoid") {
    addIssue(issues, "error", "EmbodimentKindInvalid", "$.embodiment_kind", "Embodiment kind must be quadruped or humanoid.", "Use one supported embodiment kind.");
  }

  const bodies = mapBodies(descriptor, issues);
  const joints = mapJoints(descriptor, issues);
  const actuators = mapActuators(descriptor, issues);
  validateBodyTree(descriptor, bodies, joints, issues);
  validateJoints(descriptor, bodies, actuators, issues);
  validateActuators(descriptor, joints, issues);
  validateContactSites(descriptor, bodies, issues);
  validateSensorMounts(descriptor, bodies, issues);
  validateKinematicChains(descriptor, bodies, joints, issues);
  validateSelfCollisionPolicy(descriptor, bodies, issues);
  validateStabilityPolicy(descriptor, issues);
  validateNonEmptyString(descriptor.body_summary, issues, "$.body_summary", "EmbodimentSummaryMissing");
  if (descriptor.locomotion_primitives.length === 0) {
    addIssue(issues, "warning", "PrimitiveCatalogSparse", "$.locomotion_primitives", "Embodiment has no locomotion primitives.", "Add stance, step, turn, or safe-hold locomotion primitives.");
  }
  if (descriptor.manipulation_primitives.length === 0) {
    addIssue(issues, "warning", "PrimitiveCatalogSparse", "$.manipulation_primitives", "Embodiment has no manipulation primitives.", "Add inspect, grasp, push, pull, carry, place, or release primitives.");
  }

  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.length - errorCount;
  const reportBase = {
    ok: errorCount === 0,
    embodiment_ref: descriptor.embodiment_ref,
    embodiment_kind: descriptor.embodiment_kind,
    body_count: descriptor.body_tree.length,
    joint_count: descriptor.joint_limit_table.length,
    actuator_count: descriptor.actuator_limit_table.length,
    contact_site_count: descriptor.contact_site_table.length,
    sensor_mount_count: descriptor.sensor_mount_table.length,
    kinematic_chain_count: descriptor.kinematic_chains.length,
    total_mass_kg: descriptor.body_tree.reduce((sum, body) => sum + (Number.isFinite(body.mass_kg) ? body.mass_kg : 0), 0),
    issue_count: issues.length,
    error_count: errorCount,
    warning_count: warningCount,
    issues: freezeArray(issues),
  };

  return Object.freeze({
    ...reportBase,
    determinism_hash: computeDeterminismHash(reportBase),
  });
}

function validateBodyTree(
  descriptor: EmbodimentPhysicsDescriptor,
  bodies: ReadonlyMap<Ref, BodyLinkDescriptor>,
  joints: ReadonlyMap<Ref, JointDescriptor>,
  issues: ValidationIssue[],
): void {
  if (descriptor.body_tree.length === 0) {
    addIssue(issues, "error", "BodyTreeInvalid", "$.body_tree", "Embodiment requires at least one body link.", "Add a base/root link and child links.");
    return;
  }

  const roots = descriptor.body_tree.filter((body) => body.parent_body_ref === undefined);
  if (roots.length !== 1) {
    addIssue(issues, "error", "BodyTreeInvalid", "$.body_tree", "Embodiment must have exactly one root body.", "Declare a single base body without parent_body_ref.");
  }

  for (const body of descriptor.body_tree) {
    validateRef(body.body_ref, issues, "$.body_tree.body_ref", "BodyRefInvalid");
    validatePositiveFinite(body.mass_kg, issues, `$.body_tree.${body.body_ref}.mass_kg`, "MassDistributionInvalid");
    validateInertia(body.inertia_tensor, issues, `$.body_tree.${body.body_ref}.inertia_tensor`);
    validateVector3(body.center_of_mass_local_m, issues, `$.body_tree.${body.body_ref}.center_of_mass_local_m`, "TransformInvalid");
    validateTransform(body.local_transform_parent_to_joint, issues, `$.body_tree.${body.body_ref}.local_transform_parent_to_joint`);
    validateTransform(body.local_transform_joint_to_child, issues, `$.body_tree.${body.body_ref}.local_transform_joint_to_child`);

    if (body.parent_body_ref === undefined) {
      if (body.parent_joint_ref !== undefined) {
        addIssue(issues, "error", "BodyTreeInvalid", `$.body_tree.${body.body_ref}.parent_joint_ref`, "Root body cannot declare a parent joint.", "Remove parent_joint_ref from the root body.");
      }
    } else {
      if (!bodies.has(body.parent_body_ref)) {
        addIssue(issues, "error", "BodyParentMissing", `$.body_tree.${body.body_ref}.parent_body_ref`, "Parent body ref is missing.", "Register parent body in body_tree.");
      }
      if (body.parent_joint_ref === undefined || !joints.has(body.parent_joint_ref)) {
        addIssue(issues, "error", "JointMissing", `$.body_tree.${body.body_ref}.parent_joint_ref`, "Child body requires a declared parent joint.", "Add the joint to joint_limit_table.");
      }
    }
  }

  if (hasBodyCycle(descriptor)) {
    addIssue(issues, "error", "BodyTreeCycle", "$.body_tree", "Body tree contains a cycle.", "Ensure every body has one acyclic path to the root.");
  }
}

function validateJoints(
  descriptor: EmbodimentPhysicsDescriptor,
  bodies: ReadonlyMap<Ref, BodyLinkDescriptor>,
  actuators: ReadonlyMap<Ref, ActuatorDescriptor>,
  issues: ValidationIssue[],
): void {
  for (const joint of descriptor.joint_limit_table) {
    validateRef(joint.joint_ref, issues, "$.joint_limit_table.joint_ref", "JointRefInvalid");
    if (!["fixed", "revolute", "prismatic"].includes(joint.joint_type)) {
      addIssue(issues, "error", "JointTypeInvalid", `$.joint_limit_table.${joint.joint_ref}.joint_type`, "Joint type is unsupported.", "Use fixed, revolute, or prismatic.");
    }
    if (!bodies.has(joint.parent_body_ref) || !bodies.has(joint.child_body_ref)) {
      addIssue(issues, "error", "JointBodyMissing", `$.joint_limit_table.${joint.joint_ref}`, "Joint parent or child body is missing.", "Bind every joint to declared body refs.");
    }
    if (joint.joint_type !== "fixed") {
      validateUnitAxis(joint.axis_local, issues, `$.joint_limit_table.${joint.joint_ref}.axis_local`);
    }
    validateJointLimit(joint.limit, issues, `$.joint_limit_table.${joint.joint_ref}.limit`);
    if (joint.home_position < joint.limit.min_position || joint.home_position > joint.limit.max_position) {
      addIssue(issues, "error", "JointHomeOutOfRange", `$.joint_limit_table.${joint.joint_ref}.home_position`, "Home position must be within joint limits.", "Choose a home value inside min/max limits.");
    }
    validateNonNegativeFinite(joint.damping_n_m_s_per_rad, issues, `$.joint_limit_table.${joint.joint_ref}.damping_n_m_s_per_rad`, "JointDampingInvalid");
    if (joint.stiffness_n_m_per_rad !== undefined) {
      validateNonNegativeFinite(joint.stiffness_n_m_per_rad, issues, `$.joint_limit_table.${joint.joint_ref}.stiffness_n_m_per_rad`, "JointDampingInvalid");
    }
    if (joint.actuator_ref !== undefined && !actuators.has(joint.actuator_ref)) {
      addIssue(issues, "error", "ActuatorMissing", `$.joint_limit_table.${joint.joint_ref}.actuator_ref`, "Joint references an actuator that is not registered.", "Add an actuator descriptor or clear actuator_ref.");
    }
  }
}

function validateActuators(
  descriptor: EmbodimentPhysicsDescriptor,
  joints: ReadonlyMap<Ref, JointDescriptor>,
  issues: ValidationIssue[],
): void {
  for (const actuator of descriptor.actuator_limit_table) {
    validateRef(actuator.actuator_ref, issues, "$.actuator_limit_table.actuator_ref", "ActuatorRefInvalid");
    if (!joints.has(actuator.joint_ref)) {
      addIssue(issues, "error", "ActuatorJointMissing", `$.actuator_limit_table.${actuator.actuator_ref}.joint_ref`, "Actuator must map to a declared joint.", "Bind actuator to a joint in joint_limit_table.");
    }
    validatePositiveFinite(actuator.effort_limit, issues, `$.actuator_limit_table.${actuator.actuator_ref}.effort_limit`, "ActuatorLimitInvalid");
    validatePositiveFinite(actuator.velocity_limit, issues, `$.actuator_limit_table.${actuator.actuator_ref}.velocity_limit`, "ActuatorLimitInvalid");
    if (actuator.position_limit.length !== 2 || actuator.position_limit[0] > actuator.position_limit[1]) {
      addIssue(issues, "error", "ActuatorLimitInvalid", `$.actuator_limit_table.${actuator.actuator_ref}.position_limit`, "Actuator position limit must be ordered [min, max].", "Use an ordered finite interval.");
    }
    if (!["clip_and_report", "reject_command", "safe_hold"].includes(actuator.saturation_policy)) {
      addIssue(issues, "error", "ActuatorLimitInvalid", `$.actuator_limit_table.${actuator.actuator_ref}.saturation_policy`, "Unknown actuator saturation policy.", "Use clip_and_report, reject_command, or safe_hold.");
    }
  }
}

function validateContactSites(
  descriptor: EmbodimentPhysicsDescriptor,
  bodies: ReadonlyMap<Ref, BodyLinkDescriptor>,
  issues: ValidationIssue[],
): void {
  if (descriptor.contact_site_table.length === 0) {
    addIssue(issues, "error", "ContactSiteMissing", "$.contact_site_table", "At least one contact site is required.", "Declare feet, hands, mouth, gripper, or body contact sites.");
  }
  for (const site of descriptor.contact_site_table) {
    validateRef(site.contact_site_ref, issues, "$.contact_site_table.contact_site_ref", "ContactSiteRefInvalid");
    if (!bodies.has(site.body_ref)) {
      addIssue(issues, "error", "ContactSiteMissing", `$.contact_site_table.${site.contact_site_ref}.body_ref`, "Contact site body is missing.", "Attach contact site to a declared body.");
    }
    validateTransform(site.local_transform, issues, `$.contact_site_table.${site.contact_site_ref}.local_transform`);
    if (site.cognitive_visibility !== "tactile_summary_allowed" && site.cognitive_visibility !== "forbidden_solver_detail") {
      addIssue(issues, "error", "VisibilityPolicyInvalid", `$.contact_site_table.${site.contact_site_ref}.cognitive_visibility`, "Contact visibility policy is invalid.", "Use tactile_summary_allowed or forbidden_solver_detail.");
    }
  }
}

function validateSensorMounts(
  descriptor: EmbodimentPhysicsDescriptor,
  bodies: ReadonlyMap<Ref, BodyLinkDescriptor>,
  issues: ValidationIssue[],
): void {
  if (descriptor.sensor_mount_table.length === 0) {
    addIssue(issues, "error", "SensorMountMissing", "$.sensor_mount_table", "At least one sensor mount is required.", "Declare camera, microphone, IMU, encoder, or contact sensor mounts.");
  }
  for (const mount of descriptor.sensor_mount_table) {
    validateRef(mount.sensor_mount_ref, issues, "$.sensor_mount_table.sensor_mount_ref", "SensorMountRefInvalid");
    if (!bodies.has(mount.body_ref)) {
      addIssue(issues, "error", "SensorMountMissing", `$.sensor_mount_table.${mount.sensor_mount_ref}.body_ref`, "Sensor mount body is missing.", "Attach sensor mount to a declared body.");
    }
    validateTransform(mount.local_transform, issues, `$.sensor_mount_table.${mount.sensor_mount_ref}.local_transform`);
  }
}

function validateKinematicChains(
  descriptor: EmbodimentPhysicsDescriptor,
  bodies: ReadonlyMap<Ref, BodyLinkDescriptor>,
  joints: ReadonlyMap<Ref, JointDescriptor>,
  issues: ValidationIssue[],
): void {
  if (descriptor.kinematic_chains.length === 0) {
    addIssue(issues, "error", "KinematicChainMissing", "$.kinematic_chains", "At least one kinematic chain is required.", "Declare chains for legs, head, hands, gripper, mouth, or base.");
  }
  for (const chain of descriptor.kinematic_chains) {
    validateRef(chain.chain_ref, issues, "$.kinematic_chains.chain_ref", "KinematicChainRefInvalid");
    if (!bodies.has(chain.root_body_ref) || !bodies.has(chain.tip_body_ref)) {
      addIssue(issues, "error", "KinematicChainInvalid", `$.kinematic_chains.${chain.chain_ref}`, "Chain root or tip body is missing.", "Use declared body refs for chain endpoints.");
    }
    validatePositiveFinite(chain.nominal_reach_m, issues, `$.kinematic_chains.${chain.chain_ref}.nominal_reach_m`, "KinematicChainInvalid");
    validateNonNegativeFinite(chain.max_payload_kg, issues, `$.kinematic_chains.${chain.chain_ref}.max_payload_kg`, "KinematicChainInvalid");
    let expectedParent = chain.root_body_ref;
    for (const jointRef of chain.joint_refs) {
      const joint = joints.get(jointRef);
      if (joint === undefined) {
        addIssue(issues, "error", "JointMissing", `$.kinematic_chains.${chain.chain_ref}.joint_refs`, "Chain references a missing joint.", "Add the joint or remove it from the chain.");
        break;
      }
      if (joint.parent_body_ref !== expectedParent) {
        addIssue(issues, "error", "KinematicChainInvalid", `$.kinematic_chains.${chain.chain_ref}.joint_refs`, "Chain joint order does not connect from root to tip.", "Order joints from root body to tip body.");
        break;
      }
      expectedParent = joint.child_body_ref;
    }
    if (chain.joint_refs.length > 0 && expectedParent !== chain.tip_body_ref) {
      addIssue(issues, "error", "KinematicChainInvalid", `$.kinematic_chains.${chain.chain_ref}.tip_body_ref`, "Chain does not terminate at declared tip body.", "Use the child body of the final joint as the tip body.");
    }
  }
}

function validateSelfCollisionPolicy(descriptor: EmbodimentPhysicsDescriptor, bodies: ReadonlyMap<Ref, BodyLinkDescriptor>, issues: ValidationIssue[]): void {
  validateRef(descriptor.self_collision_policy.policy_ref, issues, "$.self_collision_policy.policy_ref", "SelfCollisionPolicyInvalid");
  validateNonNegativeFinite(descriptor.self_collision_policy.minimum_clearance_m, issues, "$.self_collision_policy.minimum_clearance_m", "SelfCollisionPolicyInvalid");
  for (const pair of [...descriptor.self_collision_policy.allowed_body_pairs, ...descriptor.self_collision_policy.forbidden_body_pairs]) {
    if (pair.length !== 2 || !bodies.has(pair[0]) || !bodies.has(pair[1])) {
      addIssue(issues, "error", "SelfCollisionPolicyInvalid", "$.self_collision_policy", "Collision policy pair references a missing body.", "Use only declared body refs in collision pairs.");
    }
  }
}

function validateStabilityPolicy(descriptor: EmbodimentPhysicsDescriptor, issues: ValidationIssue[]): void {
  const contactRefs = new Set(descriptor.contact_site_table.map((site) => site.contact_site_ref));
  validateRef(descriptor.stability_policy.stability_policy_ref, issues, "$.stability_policy.stability_policy_ref", "StabilityPolicyMissing");
  validatePositiveFinite(descriptor.stability_policy.nominal_center_of_mass_height_m, issues, "$.stability_policy.nominal_center_of_mass_height_m", "StabilityPolicyMissing");
  validatePositiveFinite(descriptor.stability_policy.max_base_tilt_rad, issues, "$.stability_policy.max_base_tilt_rad", "StabilityPolicyMissing");
  validateNonNegativeFinite(descriptor.stability_policy.max_carried_load_kg, issues, "$.stability_policy.max_carried_load_kg", "StabilityPolicyMissing");
  validateNonNegativeFinite(descriptor.stability_policy.support_polygon_margin_m, issues, "$.stability_policy.support_polygon_margin_m", "StabilityPolicyMissing");
  for (const contactRef of descriptor.stability_policy.support_contact_site_refs) {
    if (!contactRefs.has(contactRef)) {
      addIssue(issues, "error", "StabilityPolicyMissing", "$.stability_policy.support_contact_site_refs", "Support contact site is missing.", "Use declared contact sites in the stability policy.");
    }
  }
}

function topologicalBodies(descriptor: EmbodimentPhysicsDescriptor): readonly BodyLinkDescriptor[] {
  const remaining = new Map(descriptor.body_tree.map((body) => [body.body_ref, body] as const));
  const ordered: BodyLinkDescriptor[] = [];
  while (remaining.size > 0) {
    const before = remaining.size;
    for (const [bodyRef, body] of [...remaining.entries()]) {
      if (body.parent_body_ref === undefined || ordered.some((entry) => entry.body_ref === body.parent_body_ref)) {
        ordered.push(body);
        remaining.delete(bodyRef);
      }
    }
    if (remaining.size === before) {
      throw new ArticulatedBodyRegistryError("Body tree cannot be topologically ordered.", [
        makeIssue("error", "BodyTreeCycle", "$.body_tree", "Body tree has a cycle or missing parent.", "Validate body tree closure before kinematic traversal."),
      ]);
    }
  }
  return Object.freeze(ordered);
}

function jointMotionTransform(joint: JointDescriptor, position: number): Transform {
  if (joint.joint_type === "fixed") {
    return identityTransform("joint_motion");
  }
  if (joint.joint_type === "revolute") {
    return freezeTransform({
      frame_ref: "joint_motion",
      position_m: ZERO_VECTOR,
      orientation_xyzw: quaternionFromAxisAngle(joint.axis_local, position * joint.control_sign),
    });
  }
  return freezeTransform({
    frame_ref: "joint_motion",
    position_m: scaleVector3(normalizeVector(joint.axis_local), position * joint.control_sign),
    orientation_xyzw: IDENTITY_QUATERNION,
  });
}

function dampedLeastSquaresStep(jacobianColumns: readonly Vector3[], error: Vector3, damping: number): readonly number[] {
  const jjt = matrix3Zero();
  for (const column of jacobianColumns) {
    jjt[0][0] += column[0] * column[0];
    jjt[0][1] += column[0] * column[1];
    jjt[0][2] += column[0] * column[2];
    jjt[1][0] += column[1] * column[0];
    jjt[1][1] += column[1] * column[1];
    jjt[1][2] += column[1] * column[2];
    jjt[2][0] += column[2] * column[0];
    jjt[2][1] += column[2] * column[1];
    jjt[2][2] += column[2] * column[2];
  }
  const lambda2 = damping * damping;
  jjt[0][0] += lambda2;
  jjt[1][1] += lambda2;
  jjt[2][2] += lambda2;
  const taskStep = solveLinear3(jjt, error);
  return freezeArray(jacobianColumns.map((column) => dotVector3(column, taskStep)));
}

function computeManipulability(jacobianColumns: readonly Vector3[]): number {
  const jjt = matrix3Zero();
  for (const column of jacobianColumns) {
    for (let row = 0; row < 3; row += 1) {
      for (let col = 0; col < 3; col += 1) {
        jjt[row][col] += column[row] * column[col];
      }
    }
  }
  return Math.sqrt(Math.max(0, determinant3(jjt)));
}

function solveLinear3(matrix: number[][], rhs: Vector3): Vector3 {
  const det = determinant3(matrix);
  if (Math.abs(det) < 1e-12) {
    return ZERO_VECTOR;
  }
  const inv = [
    [
      (matrix[1][1] * matrix[2][2] - matrix[1][2] * matrix[2][1]) / det,
      (matrix[0][2] * matrix[2][1] - matrix[0][1] * matrix[2][2]) / det,
      (matrix[0][1] * matrix[1][2] - matrix[0][2] * matrix[1][1]) / det,
    ],
    [
      (matrix[1][2] * matrix[2][0] - matrix[1][0] * matrix[2][2]) / det,
      (matrix[0][0] * matrix[2][2] - matrix[0][2] * matrix[2][0]) / det,
      (matrix[0][2] * matrix[1][0] - matrix[0][0] * matrix[1][2]) / det,
    ],
    [
      (matrix[1][0] * matrix[2][1] - matrix[1][1] * matrix[2][0]) / det,
      (matrix[0][1] * matrix[2][0] - matrix[0][0] * matrix[2][1]) / det,
      (matrix[0][0] * matrix[1][1] - matrix[0][1] * matrix[1][0]) / det,
    ],
  ];
  return [
    inv[0][0] * rhs[0] + inv[0][1] * rhs[1] + inv[0][2] * rhs[2],
    inv[1][0] * rhs[0] + inv[1][1] * rhs[1] + inv[1][2] * rhs[2],
    inv[2][0] * rhs[0] + inv[2][1] * rhs[1] + inv[2][2] * rhs[2],
  ];
}

function determinant3(matrix: readonly (readonly number[])[]): number {
  return matrix[0][0] * (matrix[1][1] * matrix[2][2] - matrix[1][2] * matrix[2][1])
    - matrix[0][1] * (matrix[1][0] * matrix[2][2] - matrix[1][2] * matrix[2][0])
    + matrix[0][2] * (matrix[1][0] * matrix[2][1] - matrix[1][1] * matrix[2][0]);
}

function matrix3Zero(): number[][] {
  return [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
}

function composeTransforms(parent: Transform, child: Transform, frameRef: Ref): Transform {
  const rotatedPosition = rotateVector(parent.orientation_xyzw, child.position_m);
  return freezeTransform({
    frame_ref: frameRef,
    position_m: addVector3(parent.position_m, rotatedPosition),
    orientation_xyzw: normalizeQuaternion(multiplyQuaternions(parent.orientation_xyzw, child.orientation_xyzw)),
  });
}

function transformPoint(transform: Transform, point: Vector3): Vector3 {
  return addVector3(transform.position_m, rotateVector(transform.orientation_xyzw, point));
}

function rotateVector(q: Quaternion, v: Vector3): Vector3 {
  const qv: Quaternion = [v[0], v[1], v[2], 0];
  const rotated = multiplyQuaternions(multiplyQuaternions(q, qv), quaternionConjugate(q));
  return [rotated[0], rotated[1], rotated[2]];
}

function quaternionFromAxisAngle(axis: Vector3, angleRad: number): Quaternion {
  const unit = normalizeVector(axis);
  const half = angleRad / 2;
  const s = Math.sin(half);
  return normalizeQuaternion([unit[0] * s, unit[1] * s, unit[2] * s, Math.cos(half)]);
}

function multiplyQuaternions(a: Quaternion, b: Quaternion): Quaternion {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function quaternionConjugate(q: Quaternion): Quaternion {
  return [-q[0], -q[1], -q[2], q[3]];
}

function normalizeQuaternion(q: Quaternion): Quaternion {
  const norm = Math.sqrt(q.reduce((sum, value) => sum + value * value, 0));
  if (norm < 1e-12) {
    return IDENTITY_QUATERNION;
  }
  return [q[0] / norm, q[1] / norm, q[2] / norm, q[3] / norm];
}

function addVector3(a: Vector3, b: Vector3): Vector3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function subtractVector3(a: Vector3, b: Vector3): Vector3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scaleVector3(v: Vector3, scalar: number): Vector3 {
  return [v[0] * scalar, v[1] * scalar, v[2] * scalar];
}

function cross(a: Vector3, b: Vector3): Vector3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dotVector3(a: Vector3, b: Vector3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function vectorNorm(v: Vector3): number {
  return Math.sqrt(dotVector3(v, v));
}

function normalizeVector(v: Vector3): Vector3 {
  const norm = vectorNorm(v);
  if (norm < 1e-12) {
    return ZERO_VECTOR;
  }
  return [v[0] / norm, v[1] / norm, v[2] / norm];
}

function identityTransform(frameRef: Ref): Transform {
  return freezeTransform({
    frame_ref: frameRef,
    position_m: ZERO_VECTOR,
    orientation_xyzw: IDENTITY_QUATERNION,
  });
}

function clampJointPosition(value: number, joint: JointDescriptor): number {
  if (!Number.isFinite(value)) {
    return joint.home_position;
  }
  return Math.max(joint.limit.min_position, Math.min(joint.limit.max_position, value));
}

function minimumLimitMargin(jointRefs: readonly Ref[], q: Readonly<Record<Ref, number>>, joints: ReadonlyMap<Ref, JointDescriptor>): number {
  let margin = Number.POSITIVE_INFINITY;
  for (const jointRef of jointRefs) {
    const joint = requireJoint(joints, jointRef);
    if (joint.joint_type === "fixed") {
      continue;
    }
    const value = q[jointRef] ?? joint.home_position;
    margin = Math.min(margin, value - joint.limit.min_position, joint.limit.max_position - value);
  }
  return Number.isFinite(margin) ? margin : 0;
}

function classifySingularity(manipulability: number): SingularityStatus {
  if (!Number.isFinite(manipulability)) {
    return "unknown";
  }
  if (manipulability < 1e-8) {
    return "singular";
  }
  if (manipulability < 1e-4) {
    return "near_singular";
  }
  return "clear";
}

function selectRecovery(
  feasibility: IKFeasibility,
  residual: number,
  limitMargin: number,
  singularityStatus: SingularityStatus,
): IKPointSolveReport["recommended_recovery"] {
  if (feasibility === "feasible") {
    return undefined;
  }
  if (singularityStatus === "singular" || singularityStatus === "near_singular") {
    return "reposition";
  }
  if (limitMargin < 0.02) {
    return "lower_target";
  }
  if (residual > 0.25) {
    return "use_tool";
  }
  return "reobserve";
}

function requireChain(descriptor: EmbodimentPhysicsDescriptor, chainRef: Ref): KinematicChainDescriptor {
  const chain = descriptor.kinematic_chains.find((candidate) => candidate.chain_ref === chainRef);
  if (chain === undefined) {
    throw new ArticulatedBodyRegistryError(`Unknown kinematic chain: ${chainRef}`, [
      makeIssue("error", "KinematicChainMissing", "$.chain_ref", "Kinematic chain is not registered.", "Register the chain before computing Jacobians or IK."),
    ]);
  }
  return chain;
}

function requireJoint(joints: ReadonlyMap<Ref, JointDescriptor>, jointRef: Ref): JointDescriptor {
  const joint = joints.get(jointRef);
  if (joint === undefined) {
    throw new ArticulatedBodyRegistryError(`Unknown joint: ${jointRef}`, [
      makeIssue("error", "JointMissing", "$.joint_ref", "Joint is not registered.", "Register the joint before computing kinematics."),
    ]);
  }
  return joint;
}

function requireBodyTransform(fk: ForwardKinematicsReport, bodyRef: Ref): Transform {
  const record = fk.body_transforms.find((candidate) => candidate.body_ref === bodyRef);
  if (record === undefined) {
    throw new ArticulatedBodyRegistryError(`Missing body transform: ${bodyRef}`, [
      makeIssue("error", "BodyRefInvalid", "$.body_ref", "Forward kinematics did not produce the requested body transform.", "Validate chain endpoints and body tree closure."),
    ]);
  }
  return record.transform;
}

function bodyRegionOf(descriptor: EmbodimentPhysicsDescriptor, bodyRef: Ref): BodyRegion {
  return descriptor.body_tree.find((body) => body.body_ref === bodyRef)?.body_region ?? "sensor_carrier";
}

function mapBodies(descriptor: EmbodimentPhysicsDescriptor, issues?: ValidationIssue[]): Map<Ref, BodyLinkDescriptor> {
  const map = new Map<Ref, BodyLinkDescriptor>();
  for (const body of descriptor.body_tree) {
    if (map.has(body.body_ref)) {
      issues?.push(makeIssue("error", "BodyRefDuplicate", "$.body_tree.body_ref", "Body refs must be unique.", "Rename or remove the duplicate body."));
    }
    map.set(body.body_ref, body);
  }
  return map;
}

function mapJoints(descriptor: EmbodimentPhysicsDescriptor, issues?: ValidationIssue[]): Map<Ref, JointDescriptor> {
  const map = new Map<Ref, JointDescriptor>();
  for (const joint of descriptor.joint_limit_table) {
    if (map.has(joint.joint_ref)) {
      issues?.push(makeIssue("error", "JointRefDuplicate", "$.joint_limit_table.joint_ref", "Joint refs must be unique.", "Rename or remove the duplicate joint."));
    }
    map.set(joint.joint_ref, joint);
  }
  return map;
}

function mapActuators(descriptor: EmbodimentPhysicsDescriptor, issues?: ValidationIssue[]): Map<Ref, ActuatorDescriptor> {
  const map = new Map<Ref, ActuatorDescriptor>();
  for (const actuator of descriptor.actuator_limit_table) {
    if (map.has(actuator.actuator_ref)) {
      issues?.push(makeIssue("error", "ActuatorRefDuplicate", "$.actuator_limit_table.actuator_ref", "Actuator refs must be unique.", "Rename or remove the duplicate actuator."));
    }
    map.set(actuator.actuator_ref, actuator);
  }
  return map;
}

function hasBodyCycle(descriptor: EmbodimentPhysicsDescriptor): boolean {
  const parentByBody = new Map(descriptor.body_tree.map((body) => [body.body_ref, body.parent_body_ref] as const));
  for (const body of descriptor.body_tree) {
    const seen = new Set<Ref>();
    let cursor: Ref | undefined = body.body_ref;
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        return true;
      }
      seen.add(cursor);
      cursor = parentByBody.get(cursor);
    }
  }
  return false;
}

function freezeDescriptor(descriptor: EmbodimentPhysicsDescriptor): EmbodimentPhysicsDescriptor {
  return Object.freeze({
    ...descriptor,
    body_tree: freezeArray(descriptor.body_tree.map((body) => Object.freeze({ ...body }))),
    joint_limit_table: freezeArray(descriptor.joint_limit_table.map((joint) => Object.freeze({ ...joint }))),
    actuator_limit_table: freezeArray(descriptor.actuator_limit_table.map((actuator) => Object.freeze({ ...actuator }))),
    contact_site_table: freezeArray(descriptor.contact_site_table.map((site) => Object.freeze({ ...site }))),
    sensor_mount_table: freezeArray(descriptor.sensor_mount_table.map((mount) => Object.freeze({ ...mount }))),
    kinematic_chains: freezeArray(descriptor.kinematic_chains.map((chain) => Object.freeze({ ...chain, joint_refs: freezeArray(chain.joint_refs) }))),
    self_collision_policy: Object.freeze({
      ...descriptor.self_collision_policy,
      forbidden_body_pairs: freezeArray(descriptor.self_collision_policy.forbidden_body_pairs.map(freezePair)),
      allowed_body_pairs: freezeArray(descriptor.self_collision_policy.allowed_body_pairs.map(freezePair)),
    }),
    stability_policy: Object.freeze({
      ...descriptor.stability_policy,
      support_contact_site_refs: freezeArray(descriptor.stability_policy.support_contact_site_refs),
    }),
    locomotion_primitives: freezeArray(descriptor.locomotion_primitives),
    manipulation_primitives: freezeArray(descriptor.manipulation_primitives),
  });
}

function freezeTransform(transform: Transform): Transform {
  return Object.freeze({
    frame_ref: transform.frame_ref,
    position_m: freezeVector3(transform.position_m),
    orientation_xyzw: freezeQuaternion(transform.orientation_xyzw),
  });
}

function freezeVector3(value: Vector3): Vector3 {
  return Object.freeze([value[0], value[1], value[2]]) as unknown as Vector3;
}

function freezeQuaternion(value: Quaternion): Quaternion {
  return Object.freeze([value[0], value[1], value[2], value[3]]) as unknown as Quaternion;
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

function freezePair(pair: readonly [Ref, Ref]): readonly [Ref, Ref] {
  return Object.freeze([pair[0], pair[1]]) as readonly [Ref, Ref];
}

function freezeRecord<T>(record: Readonly<Record<Ref, T>>): Readonly<Record<Ref, T>> {
  return Object.freeze({ ...record });
}

type ArticulatedValidationCode =
  | "EmbodimentRefInvalid"
  | "EmbodimentMissing"
  | "EmbodimentKindInvalid"
  | "EmbodimentSummaryMissing"
  | "PrimitiveCatalogSparse"
  | "BodyRefInvalid"
  | "BodyRefDuplicate"
  | "BodyParentMissing"
  | "BodyTreeInvalid"
  | "BodyTreeCycle"
  | "JointRefInvalid"
  | "JointRefDuplicate"
  | "JointTypeInvalid"
  | "JointMissing"
  | "JointBodyMissing"
  | "JointChildMismatch"
  | "JointAxisInvalid"
  | "JointLimitInvalid"
  | "JointHomeOutOfRange"
  | "JointDampingInvalid"
  | "ActuatorRefInvalid"
  | "ActuatorRefDuplicate"
  | "ActuatorMissing"
  | "ActuatorJointMissing"
  | "ActuatorLimitInvalid"
  | "ContactSiteRefInvalid"
  | "ContactSiteMissing"
  | "SensorMountRefInvalid"
  | "SensorMountMissing"
  | "KinematicChainRefInvalid"
  | "KinematicChainMissing"
  | "KinematicChainInvalid"
  | "SelfCollisionPolicyInvalid"
  | "StabilityPolicyMissing"
  | "MassDistributionInvalid"
  | "InertiaInvalid"
  | "TransformInvalid"
  | "VisibilityPolicyInvalid";

function makeIssue(severity: ValidationSeverity, code: ArticulatedValidationCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function addIssue(issues: ValidationIssue[], severity: ValidationSeverity, code: ArticulatedValidationCode, path: string, message: string, remediation: string): void {
  issues.push(makeIssue(severity, code, path, message, remediation));
}

function validateRef(value: string, issues: ValidationIssue[], path: string, code: ArticulatedValidationCode): void {
  if (typeof value !== "string" || value.trim().length === 0 || /\s/.test(value)) {
    addIssue(issues, "error", code, path, "Reference must be a non-empty whitespace-free string.", "Use an opaque ref such as humanoid_left_elbow_pitch.");
  }
}

function validateNonEmptyString(value: string | undefined, issues: ValidationIssue[], path: string, code: ArticulatedValidationCode): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    addIssue(issues, "error", code, path, "Value must be a non-empty string.", "Provide a concise but meaningful value.");
  }
}

function validateJointLimit(limit: JointLimit, issues: ValidationIssue[], path: string): void {
  if (!Number.isFinite(limit.min_position) || !Number.isFinite(limit.max_position) || limit.min_position > limit.max_position) {
    addIssue(issues, "error", "JointLimitInvalid", path, "Joint position limits must be finite and ordered.", "Use min_position <= max_position.");
  }
  validatePositiveFinite(limit.max_velocity, issues, `${path}.max_velocity`, "JointLimitInvalid");
  validatePositiveFinite(limit.max_effort, issues, `${path}.max_effort`, "JointLimitInvalid");
  if (limit.max_acceleration !== undefined) {
    validatePositiveFinite(limit.max_acceleration, issues, `${path}.max_acceleration`, "JointLimitInvalid");
  }
  if (limit.safety_margin !== undefined) {
    validateNonNegativeFinite(limit.safety_margin, issues, `${path}.safety_margin`, "JointLimitInvalid");
  }
}

function validateInertia(inertia: InertiaTensor, issues: ValidationIssue[], path: string): void {
  const diagonal = [inertia.ixx_kg_m2, inertia.iyy_kg_m2, inertia.izz_kg_m2];
  for (const value of diagonal) {
    if (!Number.isFinite(value) || value <= 0) {
      addIssue(issues, "error", "InertiaInvalid", path, "Principal inertia values must be positive and finite.", "Compute inertia from body dimensions and mass.");
    }
  }
  for (const value of [inertia.ixy_kg_m2, inertia.ixz_kg_m2, inertia.iyz_kg_m2]) {
    if (!Number.isFinite(value)) {
      addIssue(issues, "error", "InertiaInvalid", path, "Product inertia values must be finite.", "Use calibrated finite product terms.");
    }
  }
  if (
    inertia.ixx_kg_m2 + inertia.iyy_kg_m2 < inertia.izz_kg_m2 ||
    inertia.ixx_kg_m2 + inertia.izz_kg_m2 < inertia.iyy_kg_m2 ||
    inertia.iyy_kg_m2 + inertia.izz_kg_m2 < inertia.ixx_kg_m2
  ) {
    addIssue(issues, "error", "InertiaInvalid", path, "Principal inertias violate rigid-body triangle inequalities.", "Recompute physically plausible link inertia.");
  }
}

function validateTransform(transform: Transform, issues: ValidationIssue[], path: string): void {
  validateRef(transform.frame_ref, issues, `${path}.frame_ref`, "TransformInvalid");
  validateVector3(transform.position_m, issues, `${path}.position_m`, "TransformInvalid");
  if (!Array.isArray(transform.orientation_xyzw) || transform.orientation_xyzw.length !== 4 || transform.orientation_xyzw.some((component) => !Number.isFinite(component))) {
    addIssue(issues, "error", "TransformInvalid", `${path}.orientation_xyzw`, "Quaternion must contain four finite values.", "Use normalized [x, y, z, w].");
    return;
  }
  const norm = Math.sqrt(transform.orientation_xyzw.reduce((sum, value) => sum + value * value, 0));
  if (norm < 1e-9 || Math.abs(norm - 1) > 1e-6) {
    addIssue(issues, "error", "TransformInvalid", `${path}.orientation_xyzw`, "Quaternion must be unit length.", "Normalize the transform orientation quaternion.");
  }
}

function validateVector3(value: Vector3, issues: ValidationIssue[], path: string, code: ArticulatedValidationCode): void {
  if (!Array.isArray(value) || value.length !== 3 || value.some((component) => !Number.isFinite(component))) {
    addIssue(issues, "error", code, path, "Vector3 must contain exactly three finite numeric values.", "Use [x, y, z] in canonical units.");
  }
}

function validateUnitAxis(value: Vector3, issues: ValidationIssue[], path: string): void {
  validateVector3(value, issues, path, "JointAxisInvalid");
  const norm = vectorNorm(value);
  if (Number.isFinite(norm) && Math.abs(norm - 1) > 1e-6) {
    addIssue(issues, "error", "JointAxisInvalid", path, "Joint axis must be normalized.", "Normalize axis_local to unit length.");
  }
}

function validatePositiveFinite(value: number, issues: ValidationIssue[], path: string, code: ArticulatedValidationCode): void {
  if (!Number.isFinite(value) || value <= 0) {
    addIssue(issues, "error", code, path, "Value must be positive and finite.", "Provide a calibrated positive finite value.");
  }
}

function validateNonNegativeFinite(value: number, issues: ValidationIssue[], path: string, code: ArticulatedValidationCode): void {
  if (!Number.isFinite(value) || value < 0) {
    addIssue(issues, "error", code, path, "Value must be nonnegative and finite.", "Provide a calibrated nonnegative finite value.");
  }
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number.`);
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
}
