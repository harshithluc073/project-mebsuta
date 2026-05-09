/**
 * Embodiment model registry for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/05_EMBODIMENT_KINEMATICS_QUADRUPED_HUMANOID.md`
 * sections 5.1 through 5.7, 5.8, 5.9, 5.11 through 5.17, 5.18, and 5.19.
 *
 * The registry is the executable source for supported quadruped and humanoid
 * body models. It stores body descriptors, validates frame graphs, joint and
 * actuator limits, reach envelopes, stability policies, sensor mounts, contact
 * sites, locomotion primitives, manipulation affordances, and prompt-safe body
 * self-knowledge. Backend engine handles, exact simulator world poses, exact
 * hidden COM values, collision meshes, and QA truth are deliberately absent.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { EmbodimentKind, InertiaTensor, Quaternion, Ref, Transform, ValidationIssue, ValidationSeverity, Vector3 } from "../simulation/world_manifest";
import type { VirtualHardwareManifest } from "../virtual_hardware/virtual_hardware_manifest_registry";

export const EMBODIMENT_MODEL_REGISTRY_SCHEMA_VERSION = "mebsuta.embodiment_model_registry.v1" as const;

const ZERO_VECTOR: Vector3 = Object.freeze([0, 0, 0]) as Vector3;
const IDENTITY_TRANSFORM: Transform = Object.freeze({
  frame_ref: "B",
  position_m: ZERO_VECTOR,
  orientation_xyzw: Object.freeze([0, 0, 0, 1]) as Quaternion,
});
const EPSILON = 1e-9;
const FORBIDDEN_DETAIL_PATTERN = /(engine|backend|scene_graph|world_truth|ground_truth|qa_|collision_mesh|simulator_seed|exact_com|world_pose|joint_handle)/i;

export type BodyScaleClass = "small" | "medium" | "large" | "custom";
export type FrameRole = "base" | "torso" | "head" | "sensor" | "contact" | "end_effector" | "tool" | "estimated_map";
export type ValidityScope = "permanent" | "task_scoped";
export type JointType = "fixed" | "revolute" | "prismatic";
export type JointGroup = "base" | "torso" | "head" | "front_leg" | "rear_leg" | "arm" | "hand" | "gripper" | "mouth" | "tool";
export type EndEffectorRole = "mouth_gripper" | "paw" | "forelimb" | "left_hand" | "right_hand" | "both_hands" | "wrist" | "tool_tip";
export type LocomotionPrimitive =
  | "stand"
  | "turn_in_place"
  | "step_forward"
  | "sidestep"
  | "crouch"
  | "stabilize_load"
  | "reposition_for_reach"
  | "wide_stance"
  | "safe_hold";
export type ManipulationPrimitive = "inspect" | "approach" | "grasp" | "lift" | "carry" | "place" | "push" | "pull" | "release" | "retreat" | "tool_use";
export type PrecisionRating = "low" | "medium" | "high";
export type ReachDecisionKind = "ReachableNow" | "ReachableWithPostureChange" | "ReachableAfterReposition" | "ReachableWithTool" | "UnreachableOrUnsafe" | "UnknownDueToPerception";
export type StabilityState = "stable" | "marginal" | "unstable" | "unknown";
export type MarginClass = "safe" | "low" | "critical" | "unknown";
export type ToolState = "absent" | "candidate" | "attached" | "unstable" | "expired";
export type EmbodimentRegistrationStatus = "accepted" | "rejected";

export type EmbodimentModelIssueCode =
  | "EmbodimentIncomplete"
  | "EmbodimentRefInvalid"
  | "UnsupportedEmbodimentKind"
  | "FrameGraphInvalid"
  | "ForbiddenBodyDetail"
  | "JointLimitMissing"
  | "JointLimitInvalid"
  | "ActuatorLimitMissing"
  | "ActuatorLimitInvalid"
  | "SensorMountMissing"
  | "ContactSiteMissing"
  | "ReachSummaryUnavailable"
  | "ReachUnsafe"
  | "StabilityPolicyMissing"
  | "ManipulationCapabilityMissing"
  | "LocomotionCapabilityMissing"
  | "VisibilityPolicyMissing"
  | "SelfStateMissing"
  | "TargetEstimateMissing"
  | "EndEffectorUnavailable"
  | "ToolAttachmentInvalid"
  | "PerceptionUncertain"
  | "HardwareManifestMismatch"
  | "ActiveEmbodimentMissing"
  | "IKInputInvalid"
  | "IKLimitViolation";

/**
 * Body-relative frame descriptor. The transform is always from parent frame to
 * this frame and must never encode a simulator world pose.
 */
export interface FrameDescriptor {
  readonly frame_id: Ref;
  readonly frame_role: FrameRole;
  readonly parent_frame_ref?: Ref;
  readonly transform_from_parent?: Transform;
  readonly validity_scope: ValidityScope;
  readonly uncertainty_m?: number;
  readonly cognitive_label: string;
}

/**
 * Kinematic joint with explicit limits. Position is radians for revolute joints
 * and meters for prismatic joints.
 */
export interface JointDescriptor {
  readonly joint_ref: Ref;
  readonly joint_group: JointGroup;
  readonly joint_type: JointType;
  readonly parent_frame_ref: Ref;
  readonly child_frame_ref: Ref;
  readonly axis_local: Vector3;
  readonly min_position: number;
  readonly max_position: number;
  readonly max_velocity: number;
  readonly max_effort: number;
  readonly max_acceleration?: number;
  readonly home_position: number;
  readonly safety_margin: number;
}

/**
 * Actuator self-limits used by control, safety, and body capability summaries.
 */
export interface ActuatorLimitDescriptor {
  readonly actuator_ref: Ref;
  readonly target_joint_ref: Ref;
  readonly actuator_group: JointGroup;
  readonly command_interfaces: readonly ("position" | "velocity" | "effort" | "grip_width" | "tool_state")[];
  readonly min_position?: number;
  readonly max_position?: number;
  readonly max_velocity: number;
  readonly max_effort: number;
  readonly max_acceleration?: number;
  readonly saturation_policy: "clip_and_report" | "reject" | "safe_hold";
}

/**
 * A kinematic chain for reach, gaze, locomotion, or manipulation. Link lengths
 * provide enough geometry for deterministic reach and two-link IK checks.
 */
export interface KinematicChainDescriptor {
  readonly chain_ref: Ref;
  readonly chain_role: "locomotion" | "gaze" | "manipulation" | "gripper" | "tool";
  readonly root_frame_ref: Ref;
  readonly tip_frame_ref: Ref;
  readonly joint_refs: readonly Ref[];
  readonly end_effector_ref?: Ref;
  readonly link_lengths_m: readonly number[];
  readonly nominal_reach_m: number;
  readonly max_payload_kg: number;
}

/**
 * Declared end effector and the manipulation modes it can safely attempt.
 */
export interface EndEffectorDescriptor {
  readonly effector_ref: Ref;
  readonly role: EndEffectorRole;
  readonly frame_ref: Ref;
  readonly natural_reach_radius_m: number;
  readonly tool_extended_reach_radius_m?: number;
  readonly precision_rating: PrecisionRating;
  readonly supported_primitives: readonly ManipulationPrimitive[];
}

export interface SensorMountDescriptor {
  readonly sensor_ref: Ref;
  readonly sensor_role: "camera" | "depth_camera" | "microphone" | "imu" | "encoder" | "contact_sensor" | "force_torque";
  readonly mount_frame_ref: Ref;
  readonly body_frame_ref: Ref;
  readonly calibration_ref: Ref;
  readonly allowed_motion_summary: string;
}

export interface ContactSiteDescriptor {
  readonly contact_site_ref: Ref;
  readonly contact_role: "foot" | "paw" | "hand" | "fingertip" | "mouth" | "gripper" | "tool" | "body";
  readonly frame_ref: Ref;
  readonly sensor_ref?: Ref;
  readonly nominal_support: boolean;
  readonly max_contact_force_n: number;
}

export interface ReachEnvelopeDescriptor {
  readonly reach_envelope_id: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly end_effector_ref: Ref;
  readonly stance_ref: Ref;
  readonly natural_radius_m: number;
  readonly posture_adjusted_radius_m: number;
  readonly reposition_radius_m: number;
  readonly tool_extended_radius_m?: number;
  readonly precision_radius_m?: number;
  readonly unsafe_minimum_margin_m: number;
  readonly confidence_or_margin: number;
  readonly workspace_region_summary: string;
  readonly precision_region_summary?: string;
  readonly unsafe_region_summary?: string;
}

export interface StabilityPolicyDescriptor {
  readonly stability_policy_ref: Ref;
  readonly base_frame_ref: Ref;
  readonly torso_frame_ref: Ref;
  readonly head_frame_ref: Ref;
  readonly nominal_support_contact_refs: readonly Ref[];
  readonly nominal_center_of_mass_height_m: number;
  readonly support_polygon_margin_m: number;
  readonly critical_support_margin_m: number;
  readonly max_base_tilt_rad: number;
  readonly warning_base_tilt_rad: number;
  readonly max_carried_load_kg: number;
  readonly prefers_low_center_of_mass: boolean;
  readonly default_stance_ref: Ref;
}

export interface SafetyMarginPolicy {
  readonly target_confidence_minimum: number;
  readonly reach_uncertainty_m: number;
  readonly tool_slip_maximum: number;
  readonly support_contact_confidence_minimum: number;
  readonly load_warning_fraction: number;
  readonly load_critical_fraction: number;
}

export interface LocomotionCapabilityDescriptor {
  readonly capability_ref: Ref;
  readonly supported_primitives: readonly LocomotionPrimitive[];
  readonly stable_speed_m_per_s: number;
  readonly carry_speed_multiplier: number;
  readonly recovery_primitives: readonly LocomotionPrimitive[];
}

export interface ManipulationCapabilityDescriptor {
  readonly capability_ref: Ref;
  readonly end_effector_role: EndEffectorRole;
  readonly supported_primitives: readonly ManipulationPrimitive[];
  readonly object_size_range_summary: string;
  readonly grip_force_range_summary?: string;
  readonly precision_rating: PrecisionRating;
  readonly occlusion_risk: "low" | "medium" | "high";
  readonly failure_modes: readonly ("slip" | "crush" | "unreachable" | "collision" | "unstable" | "occlusion")[];
}

export interface BodyMassDescriptor {
  readonly body_ref: Ref;
  readonly frame_ref: Ref;
  readonly mass_kg: number;
  readonly local_center_of_mass_m: Vector3;
  readonly inertia_tensor: InertiaTensor;
}

export interface EmbodimentDescriptor {
  readonly embodiment_id: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly body_scale_class: BodyScaleClass;
  readonly body_tree_ref: Ref;
  readonly frame_graph_ref: Ref;
  readonly joint_group_table_ref: Ref;
  readonly actuator_group_table_ref: Ref;
  readonly sensor_mount_table_ref: Ref;
  readonly contact_site_table_ref: Ref;
  readonly natural_reach_envelope_ref: Ref;
  readonly tool_reach_policy_ref?: Ref;
  readonly stability_policy_ref: Ref;
  readonly locomotion_capability_ref: Ref;
  readonly manipulation_capability_ref: Ref;
  readonly safety_margin_policy_ref: Ref;
  readonly frame_graph: readonly FrameDescriptor[];
  readonly joints: readonly JointDescriptor[];
  readonly actuator_limits: readonly ActuatorLimitDescriptor[];
  readonly kinematic_chains: readonly KinematicChainDescriptor[];
  readonly end_effectors: readonly EndEffectorDescriptor[];
  readonly sensor_mounts: readonly SensorMountDescriptor[];
  readonly contact_sites: readonly ContactSiteDescriptor[];
  readonly reach_envelopes: readonly ReachEnvelopeDescriptor[];
  readonly stability_policy: StabilityPolicyDescriptor;
  readonly safety_margin_policy: SafetyMarginPolicy;
  readonly locomotion_capability: LocomotionCapabilityDescriptor;
  readonly manipulation_capabilities: readonly ManipulationCapabilityDescriptor[];
  readonly body_masses: readonly BodyMassDescriptor[];
  readonly body_summary: string;
}

export interface EmbodimentRegistrationReport {
  readonly schema_version: typeof EMBODIMENT_MODEL_REGISTRY_SCHEMA_VERSION;
  readonly registration_status: EmbodimentRegistrationStatus;
  readonly embodiment_id: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly frame_count: number;
  readonly joint_count: number;
  readonly actuator_count: number;
  readonly chain_count: number;
  readonly sensor_mount_count: number;
  readonly contact_site_count: number;
  readonly reach_envelope_count: number;
  readonly manipulation_capability_count: number;
  readonly total_mass_kg: number;
  readonly accepted: boolean;
  readonly issue_count: number;
  readonly error_count: number;
  readonly warning_count: number;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface ActiveEmbodimentSelectionReport {
  readonly schema_version: typeof EMBODIMENT_MODEL_REGISTRY_SCHEMA_VERSION;
  readonly active_embodiment_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly selected_by: "embodiment_ref" | "embodiment_kind";
  readonly available_sensor_mount_count: number;
  readonly available_end_effector_count: number;
  readonly determinism_hash: string;
}

export interface EmbodimentContractPacket {
  readonly schema_version: typeof EMBODIMENT_MODEL_REGISTRY_SCHEMA_VERSION;
  readonly embodiment_kind: EmbodimentKind;
  readonly body_summary: string;
  readonly sensor_summary: readonly string[];
  readonly end_effector_summary: readonly string[];
  readonly locomotion_summary: readonly string[];
  readonly manipulation_summary: readonly string[];
  readonly reach_summary: string;
  readonly stability_summary: string;
  readonly tool_use_summary?: string;
  readonly forbidden_detail_report_ref: Ref;
  readonly hidden_fields_removed: readonly string[];
  readonly cognitive_visibility: "gemini_safe_body_self_knowledge";
  readonly determinism_hash: string;
}

export interface ReachTargetEstimate {
  readonly target_ref: Ref;
  readonly position_in_base_frame_m: Vector3;
  readonly confidence: number;
  readonly estimate_source: "camera" | "depth" | "contact" | "memory" | "fused_sensor_estimate";
  readonly uncertainty_radius_m?: number;
}

export interface ReachEvaluationInput {
  readonly embodiment_ref?: Ref;
  readonly end_effector_role: EndEffectorRole;
  readonly target_estimate?: ReachTargetEstimate;
  readonly stance_ref?: Ref;
  readonly stance_stability?: StabilityState;
  readonly tool_state?: ToolState;
  readonly tool_length_m?: number;
  readonly tool_slip_risk?: number;
}

export interface ReachDecision {
  readonly decision_ref: Ref;
  readonly embodiment_ref: Ref;
  readonly end_effector_ref: Ref;
  readonly decision: ReachDecisionKind;
  readonly target_distance_m: number;
  readonly natural_reach_m: number;
  readonly effective_reach_m: number;
  readonly margin_m: number;
  readonly confidence: number;
  readonly recommended_action: "continue" | "adjust_posture" | "reposition" | "use_tool" | "reject" | "re_observe";
  readonly prompt_safe_summary: string;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface StabilityEvaluationInput {
  readonly embodiment_ref?: Ref;
  readonly support_contacts: readonly {
    readonly contact_ref: Ref;
    readonly position_in_base_frame_m: Vector3;
    readonly confidence: number;
  }[];
  readonly center_of_pressure_estimate_m?: Vector3;
  readonly base_tilt_roll_pitch_rad?: readonly [number, number];
  readonly carried_load_kg?: number;
  readonly planned_motion: "observe" | "reach" | "lift" | "carry" | "place" | "turn" | "walk" | "tool_use" | "safe_hold";
}

export interface StabilityDecision {
  readonly decision_ref: Ref;
  readonly embodiment_ref: Ref;
  readonly stability_state: StabilityState;
  readonly com_margin_class: MarginClass;
  readonly base_tilt_class: "normal" | "warning" | "critical";
  readonly load_shift_class: "none" | "low" | "medium" | "high";
  readonly support_polygon_area_m2: number;
  readonly center_margin_m: number;
  readonly recommended_action: "continue" | "slow" | "reposition" | "crouch" | "safe_hold" | "re_observe";
  readonly prompt_safe_summary: string;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface PlanarTwoLinkIKInput {
  readonly embodiment_ref?: Ref;
  readonly chain_ref: Ref;
  readonly target_in_root_frame_m: Vector3;
  readonly elbow_preference?: "up" | "down";
}

export interface PlanarTwoLinkIKReport {
  readonly ik_report_ref: Ref;
  readonly embodiment_ref: Ref;
  readonly chain_ref: Ref;
  readonly feasible: boolean;
  readonly root_angle_rad: number;
  readonly elbow_angle_rad: number;
  readonly residual_m: number;
  readonly joint_solution: Readonly<Record<Ref, number>>;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export class EmbodimentModelRegistryError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "EmbodimentModelRegistryError";
    this.issues = issues;
  }
}

/**
 * Stores supported body models and selects the active scenario embodiment.
 */
export class EmbodimentModelRegistry {
  private readonly models = new Map<Ref, EmbodimentDescriptor>();
  private readonly reports = new Map<Ref, EmbodimentRegistrationReport>();
  private activeEmbodimentRef: Ref | undefined;

  public constructor(models: readonly EmbodimentDescriptor[] = defaultEmbodimentDescriptors()) {
    for (const model of models) {
      this.registerEmbodimentModel(model);
    }
  }

  /**
   * Registers a complete quadruped or humanoid descriptor after validating
   * body structure, limits, reach, stability, hardware bindings, and prompt
   * safety. Rejected descriptors are not stored as selectable models.
   */
  public registerEmbodimentModel(
    embodimentDescriptor: EmbodimentDescriptor,
    hardwareManifest?: VirtualHardwareManifest,
    safetyMarginPolicy?: Partial<SafetyMarginPolicy>,
  ): EmbodimentRegistrationReport {
    const descriptor = safetyMarginPolicy === undefined
      ? embodimentDescriptor
      : Object.freeze({
        ...embodimentDescriptor,
        safety_margin_policy: Object.freeze({ ...embodimentDescriptor.safety_margin_policy, ...safetyMarginPolicy }),
      });
    const report = validateEmbodimentDescriptor(descriptor, hardwareManifest);
    this.reports.set(descriptor.embodiment_id, report);
    if (report.accepted) {
      this.models.set(descriptor.embodiment_id, freezeEmbodimentDescriptor(descriptor));
      if (this.activeEmbodimentRef === undefined) {
        this.activeEmbodimentRef = descriptor.embodiment_id;
      }
    }
    return report;
  }

  public hasEmbodiment(embodimentRef: Ref): boolean {
    return this.models.has(embodimentRef);
  }

  public listEmbodiments(kind?: EmbodimentKind): readonly EmbodimentDescriptor[] {
    return freezeArray([...this.models.values()]
      .filter((model) => kind === undefined || model.embodiment_kind === kind)
      .sort((a, b) => a.embodiment_id.localeCompare(b.embodiment_id)));
  }

  public getRegistrationReport(embodimentRef: Ref): EmbodimentRegistrationReport | undefined {
    return this.reports.get(embodimentRef);
  }

  public requireEmbodiment(embodimentRef: Ref): EmbodimentDescriptor {
    const model = this.models.get(embodimentRef);
    if (model === undefined) {
      throw new EmbodimentModelRegistryError("Embodiment model is not registered.", [
        makeIssue("error", "ActiveEmbodimentMissing", "$.embodiment_ref", `Embodiment ${embodimentRef} is not registered.`, "Register the embodiment before selecting it."),
      ]);
    }
    return model;
  }

  /**
   * Selects the active embodiment by exact ref or by body kind. Kind selection
   * chooses the lexicographically first registered model of that kind.
   */
  public selectActiveEmbodiment(selector: { readonly embodiment_ref?: Ref; readonly embodiment_kind?: EmbodimentKind }): ActiveEmbodimentSelectionReport {
    const selectedBy = selector.embodiment_ref !== undefined ? "embodiment_ref" as const : "embodiment_kind" as const;
    const model = selector.embodiment_ref !== undefined
      ? this.requireEmbodiment(selector.embodiment_ref)
      : this.listEmbodiments(selector.embodiment_kind).at(0);
    if (model === undefined) {
      throw new EmbodimentModelRegistryError("No embodiment model matches selector.", [
        makeIssue("error", "ActiveEmbodimentMissing", "$.selector", "No registered embodiment matches the selector.", "Register a quadruped or humanoid model first."),
      ]);
    }
    this.activeEmbodimentRef = model.embodiment_id;
    const reportBase = {
      schema_version: EMBODIMENT_MODEL_REGISTRY_SCHEMA_VERSION,
      active_embodiment_ref: model.embodiment_id,
      embodiment_kind: model.embodiment_kind,
      selected_by: selectedBy,
      available_sensor_mount_count: model.sensor_mounts.length,
      available_end_effector_count: model.end_effectors.length,
    };
    return Object.freeze({
      ...reportBase,
      determinism_hash: computeDeterminismHash(reportBase),
    });
  }

  public requireActiveEmbodiment(): EmbodimentDescriptor {
    if (this.activeEmbodimentRef === undefined) {
      throw new EmbodimentModelRegistryError("Active embodiment is not selected.", [
        makeIssue("error", "ActiveEmbodimentMissing", "$.active_embodiment_ref", "No active embodiment has been selected.", "Select an embodiment before validation or prompt construction."),
      ]);
    }
    return this.requireEmbodiment(this.activeEmbodimentRef);
  }

  /**
   * Builds a Gemini-safe body self-knowledge packet with capabilities and
   * limitations but no engine handles, hidden world pose, exact hidden COM,
   * collision geometry, or QA state.
   */
  public buildEmbodimentPromptContract(embodimentRef: Ref = this.requireActiveEmbodiment().embodiment_id): EmbodimentContractPacket {
    const model = this.requireEmbodiment(embodimentRef);
    const maxNaturalReach = Math.max(...model.end_effectors.map((effector) => effector.natural_reach_radius_m));
    const maxToolReach = Math.max(...model.end_effectors.map((effector) => effector.tool_extended_reach_radius_m ?? effector.natural_reach_radius_m));
    const contractBase = {
      schema_version: EMBODIMENT_MODEL_REGISTRY_SCHEMA_VERSION,
      embodiment_kind: model.embodiment_kind,
      body_summary: safeText(model.body_summary),
      sensor_summary: freezeArray(model.sensor_mounts.map((mount) => `${mount.sensor_role}:${mount.sensor_ref} on ${mount.body_frame_ref}`).sort()),
      end_effector_summary: freezeArray(model.end_effectors.map((effector) => `${effector.role} reach ${round3(effector.natural_reach_radius_m)}m precision ${effector.precision_rating}`).sort()),
      locomotion_summary: freezeArray(model.locomotion_capability.supported_primitives.map((primitive) => `${primitive}`).sort()),
      manipulation_summary: freezeArray(model.manipulation_capabilities.map((capability) => `${capability.end_effector_role}:${capability.supported_primitives.join(",")}; precision ${capability.precision_rating}`).sort()),
      reach_summary: `${model.embodiment_kind} approximate natural reach is ${round3(maxNaturalReach)}m with ${round3(model.safety_margin_policy.reach_uncertainty_m)}m configured uncertainty.`,
      stability_summary: `${model.embodiment_kind} stability uses ${model.stability_policy.nominal_support_contact_refs.length} nominal supports, warning tilt ${round3(model.stability_policy.warning_base_tilt_rad)}rad, critical tilt ${round3(model.stability_policy.max_base_tilt_rad)}rad.`,
      tool_use_summary: maxToolReach > maxNaturalReach ? `Validated task-scoped tools can extend approximate reach to ${round3(maxToolReach)}m and must expire after release or safety abort.` : undefined,
      forbidden_detail_report_ref: `embodiment_hidden_detail_${model.embodiment_id}`,
      hidden_fields_removed: freezeArray(["engine_joint_handles", "backend_body_handles", "simulator_world_pose", "exact_hidden_com", "collision_meshes", "qa_truth_refs"]),
      cognitive_visibility: "gemini_safe_body_self_knowledge" as const,
    };
    return Object.freeze({
      ...contractBase,
      determinism_hash: computeDeterminismHash(contractBase),
    });
  }

  /**
   * Evaluates a sensor-derived target against the active model reach envelope.
   */
  public evaluateReachEnvelope(input: ReachEvaluationInput): ReachDecision {
    const model = this.requireEmbodiment(input.embodiment_ref ?? this.requireActiveEmbodiment().embodiment_id);
    const issues: ValidationIssue[] = [];
    const effector = model.end_effectors.find((candidate) => candidate.role === input.end_effector_role);
    if (effector === undefined) {
      issues.push(makeIssue("error", "EndEffectorUnavailable", "$.end_effector_role", `End effector ${input.end_effector_role} is not declared for ${model.embodiment_kind}.`, "Choose an end effector declared by the active model."));
      return buildReachDecision(model, "unknown_effector", "UnknownDueToPerception", 0, 0, 0, 0, "reject", "Requested end effector is not available.", issues);
    }
    if (input.target_estimate === undefined) {
      issues.push(makeIssue("error", "TargetEstimateMissing", "$.target_estimate", "Reach validation requires a sensor-derived target estimate.", "Re-observe or provide a fused sensor estimate."));
      return buildReachDecision(model, effector.effector_ref, "UnknownDueToPerception", 0, effector.natural_reach_radius_m, effector.natural_reach_radius_m, 0, "re_observe", "Target estimate is missing.", issues);
    }
    if (input.target_estimate.confidence < model.safety_margin_policy.target_confidence_minimum) {
      issues.push(makeIssue("warning", "PerceptionUncertain", "$.target_estimate.confidence", "Target confidence is below the model safety margin.", "Re-observe before committing to reach or tool-use."));
    }
    const targetDistance = vectorNorm(input.target_estimate.position_in_base_frame_m);
    const uncertainty = input.target_estimate.uncertainty_radius_m ?? model.safety_margin_policy.reach_uncertainty_m;
    const envelope = model.reach_envelopes.find((candidate) => candidate.end_effector_ref === effector.effector_ref && candidate.stance_ref === (input.stance_ref ?? model.stability_policy.default_stance_ref))
      ?? model.reach_envelopes.find((candidate) => candidate.end_effector_ref === effector.effector_ref);
    if (envelope === undefined) {
      issues.push(makeIssue("error", "ReachSummaryUnavailable", "$.reach_envelopes", `No reach envelope exists for ${effector.effector_ref}.`, "Declare a reach envelope for every end effector."));
      return buildReachDecision(model, effector.effector_ref, "UnknownDueToPerception", targetDistance, effector.natural_reach_radius_m, 0, input.target_estimate.confidence, "reject", "Reach envelope is unavailable.", issues);
    }
    const stance = input.stance_stability ?? "stable";
    const naturalReach = Math.min(effector.natural_reach_radius_m, envelope.natural_radius_m);
    const postureReach = envelope.posture_adjusted_radius_m;
    const repositionReach = envelope.reposition_radius_m;
    const toolReach = Math.max(envelope.tool_extended_radius_m ?? 0, (input.tool_length_m ?? 0) + naturalReach);
    const toolUsable = input.tool_state === "attached" && (input.tool_slip_risk ?? 0) <= model.safety_margin_policy.tool_slip_maximum;
    const effectiveReach = toolUsable ? toolReach : stance === "stable" ? naturalReach : Math.max(naturalReach * 0.82, naturalReach - uncertainty);
    const margin = effectiveReach - targetDistance - uncertainty - envelope.unsafe_minimum_margin_m;
    let decision: ReachDecisionKind;
    let action: ReachDecision["recommended_action"];
    if (input.target_estimate.confidence < model.safety_margin_policy.target_confidence_minimum) {
      decision = "UnknownDueToPerception";
      action = "re_observe";
    } else if (margin >= 0 && stance !== "unstable") {
      decision = "ReachableNow";
      action = "continue";
    } else if (targetDistance + uncertainty <= postureReach && stance !== "unstable") {
      decision = "ReachableWithPostureChange";
      action = "adjust_posture";
    } else if (toolReach > 0 && targetDistance + uncertainty <= toolReach && input.tool_state !== "expired") {
      decision = toolUsable ? "ReachableWithTool" : "ReachableWithTool";
      action = "use_tool";
      if (input.tool_state !== "attached") {
        issues.push(makeIssue("warning", "ToolAttachmentInvalid", "$.tool_state", "Tool reach requires validated attachment before execution.", "Validate tool attachment before extending reach."));
      }
    } else if (targetDistance + uncertainty <= repositionReach) {
      decision = "ReachableAfterReposition";
      action = "reposition";
    } else {
      decision = "UnreachableOrUnsafe";
      action = "reject";
      issues.push(makeIssue("error", "ReachUnsafe", "$.target_estimate.position_in_base_frame_m", "Target is outside declared safe reach envelopes.", "Reposition, choose another effector, use a validated tool, or request help."));
    }
    return buildReachDecision(
      model,
      effector.effector_ref,
      decision,
      targetDistance,
      effectiveReach,
      margin,
      input.target_estimate.confidence,
      action,
      reachSummary(decision, model.embodiment_kind, targetDistance, effectiveReach),
      issues,
    );
  }

  /**
   * Classifies body stability using support polygon area, projected center
   * margin, base tilt, carried load, and contact confidence.
   */
  public evaluateStability(input: StabilityEvaluationInput): StabilityDecision {
    const model = this.requireEmbodiment(input.embodiment_ref ?? this.requireActiveEmbodiment().embodiment_id);
    const issues: ValidationIssue[] = [];
    const confidentContacts = input.support_contacts.filter((contact) => contact.confidence >= model.safety_margin_policy.support_contact_confidence_minimum);
    if (confidentContacts.length < minimumSupportContacts(model.embodiment_kind, input.planned_motion)) {
      issues.push(makeIssue("warning", "StabilityPolicyMissing", "$.support_contacts", "Support contact confidence is insufficient for planned motion.", "Re-observe contacts or move to safe-hold."));
    }
    for (const contact of input.support_contacts) {
      if (!model.contact_sites.some((site) => site.contact_site_ref === contact.contact_ref)) {
        issues.push(makeIssue("warning", "ContactSiteMissing", "$.support_contacts", `Contact ${contact.contact_ref} is not declared by the embodiment.`, "Use declared body contact sites only."));
      }
    }
    const supportPoints = confidentContacts.map((contact) => contact.position_in_base_frame_m);
    const hull = convexHull2D(supportPoints);
    const polygonArea = polygonArea2D(hull);
    const center = input.center_of_pressure_estimate_m ?? centroid2D(hull);
    const centerMargin = hull.length >= 3 ? distanceToPolygonEdges(center, hull) : 0;
    const tilt = Math.hypot(input.base_tilt_roll_pitch_rad?.[0] ?? 0, input.base_tilt_roll_pitch_rad?.[1] ?? 0);
    const load = input.carried_load_kg ?? 0;
    const marginClass = classifyMargin(centerMargin, hull.length, model.stability_policy);
    const tiltClass: StabilityDecision["base_tilt_class"] = tilt >= model.stability_policy.max_base_tilt_rad ? "critical" : tilt >= model.stability_policy.warning_base_tilt_rad ? "warning" : "normal";
    const loadClass = classifyLoad(load, model);
    const stabilityState = classifyStability(marginClass, tiltClass, loadClass, confidentContacts.length, model, issues);
    const action = stabilityAction(stabilityState, marginClass, input.planned_motion);
    const decisionBase = {
      decision_ref: `stability_${model.embodiment_id}_${computeDeterminismHash({ input, marginClass, tiltClass, loadClass }).slice(0, 12)}`,
      embodiment_ref: model.embodiment_id,
      stability_state: stabilityState,
      com_margin_class: marginClass,
      base_tilt_class: tiltClass,
      load_shift_class: loadClass,
      support_polygon_area_m2: round6(polygonArea),
      center_margin_m: round6(centerMargin),
      recommended_action: action,
      prompt_safe_summary: stabilitySummary(stabilityState, marginClass, tiltClass, loadClass),
      issues: freezeArray(issues),
    };
    return Object.freeze({
      ...decisionBase,
      determinism_hash: computeDeterminismHash(decisionBase),
    });
  }

  /**
   * Solves a two-link planar reach problem for quick feasibility checks. The
   * math uses the law of cosines and clamps only after reporting limit issues.
   */
  public solvePlanarTwoLinkIK(input: PlanarTwoLinkIKInput): PlanarTwoLinkIKReport {
    const model = this.requireEmbodiment(input.embodiment_ref ?? this.requireActiveEmbodiment().embodiment_id);
    const chain = model.kinematic_chains.find((candidate) => candidate.chain_ref === input.chain_ref);
    const issues: ValidationIssue[] = [];
    if (chain === undefined) {
      issues.push(makeIssue("error", "IKInputInvalid", "$.chain_ref", `Kinematic chain ${input.chain_ref} is not declared.`, "Choose a declared chain."));
      return buildIKReport(model.embodiment_id, input.chain_ref, false, 0, 0, 0, {}, issues);
    }
    if (chain.link_lengths_m.length < 2 || chain.joint_refs.length < 2) {
      issues.push(makeIssue("error", "IKInputInvalid", "$.chain_ref", "Two-link IK requires at least two link lengths and two joints.", "Use a manipulation chain with two actuated links."));
      return buildIKReport(model.embodiment_id, chain.chain_ref, false, 0, 0, vectorNorm(input.target_in_root_frame_m), {}, issues);
    }
    const l1 = chain.link_lengths_m[0];
    const l2 = chain.link_lengths_m[1];
    const x = Math.hypot(input.target_in_root_frame_m[0], input.target_in_root_frame_m[1]);
    const z = input.target_in_root_frame_m[2];
    const d = Math.hypot(x, z);
    if (!Number.isFinite(d) || d < EPSILON) {
      issues.push(makeIssue("error", "IKInputInvalid", "$.target_in_root_frame_m", "IK target must be a finite nonzero body-relative point.", "Use a sensor-derived body-relative target."));
      return buildIKReport(model.embodiment_id, chain.chain_ref, false, 0, 0, 0, {}, issues);
    }
    const cosElbow = clamp((d * d - l1 * l1 - l2 * l2) / (2 * l1 * l2), -1, 1);
    const elbowSign = input.elbow_preference === "down" ? -1 : 1;
    const elbow = elbowSign * Math.acos(cosElbow);
    const shoulder = Math.atan2(z, x) - Math.atan2(l2 * Math.sin(elbow), l1 + l2 * Math.cos(elbow));
    const reachableDistance = Math.min(Math.max(d, Math.abs(l1 - l2)), l1 + l2);
    const residual = Math.abs(d - reachableDistance);
    const jointSolution: Record<Ref, number> = {
      [chain.joint_refs[0]]: round6(shoulder),
      [chain.joint_refs[1]]: round6(elbow),
    };
    for (const jointRef of chain.joint_refs.slice(0, 2)) {
      const joint = model.joints.find((candidate) => candidate.joint_ref === jointRef);
      const value = jointSolution[jointRef];
      if (joint === undefined || value === undefined) {
        issues.push(makeIssue("error", "IKInputInvalid", "$.joint_refs", `Joint ${jointRef} is missing from the model.`, "Repair the chain joint refs."));
        continue;
      }
      if (value < joint.min_position + joint.safety_margin || value > joint.max_position - joint.safety_margin) {
        issues.push(makeIssue("warning", "IKLimitViolation", `$.joint_solution.${jointRef}`, `Joint ${jointRef} is at or beyond safety margin.`, "Reposition, choose another posture, or use a tool."));
      }
    }
    return buildIKReport(model.embodiment_id, chain.chain_ref, residual <= 0.01 && !issues.some((issue) => issue.severity === "error"), shoulder, elbow, residual, jointSolution, issues);
  }
}

export function createEmbodimentModelRegistry(models: readonly EmbodimentDescriptor[] = defaultEmbodimentDescriptors()): EmbodimentModelRegistry {
  return new EmbodimentModelRegistry(models);
}

export function registerEmbodimentModel(
  embodimentDescriptor: EmbodimentDescriptor,
  registry = new EmbodimentModelRegistry([]),
  hardwareManifest?: VirtualHardwareManifest,
  safetyMarginPolicy?: Partial<SafetyMarginPolicy>,
): EmbodimentRegistrationReport {
  return registry.registerEmbodimentModel(embodimentDescriptor, hardwareManifest, safetyMarginPolicy);
}

export function defaultEmbodimentDescriptors(): readonly EmbodimentDescriptor[] {
  return freezeArray([createDefaultQuadrupedEmbodimentDescriptor(), createDefaultHumanoidEmbodimentDescriptor()]);
}

export function createDefaultQuadrupedEmbodimentDescriptor(): EmbodimentDescriptor {
  const frames: readonly FrameDescriptor[] = freezeArray([
    frame("B", "base", undefined, "permanent", "base body frame", [0, 0, 0]),
    frame("T", "torso", "B", "permanent", "trunk frame", [0, 0, 0.28]),
    frame("H", "head", "T", "permanent", "head and snout frame", [0.34, 0, 0.16]),
    frame("S_head_camera", "sensor", "H", "permanent", "front camera frame", [0.08, 0, 0.03]),
    frame("S_microphone_array", "sensor", "H", "permanent", "head microphone frame", [0.02, 0, 0.04]),
    frame("S_body_imu", "sensor", "T", "permanent", "body IMU frame", [0, 0, 0.02]),
    frame("E_mouth", "end_effector", "H", "permanent", "mouth gripper", [0.18, 0, -0.03]),
    frame("E_front_paw", "end_effector", "B", "permanent", "front paw manipulator", [0.26, 0, -0.28]),
    frame("C_front_left_paw", "contact", "B", "permanent", "front left paw contact", [0.25, 0.16, -0.34]),
    frame("C_front_right_paw", "contact", "B", "permanent", "front right paw contact", [0.25, -0.16, -0.34]),
    frame("C_rear_left_paw", "contact", "B", "permanent", "rear left paw contact", [-0.25, 0.16, -0.34]),
    frame("C_rear_right_paw", "contact", "B", "permanent", "rear right paw contact", [-0.25, -0.16, -0.34]),
    frame("U_tool_tip", "tool", "E_mouth", "task_scoped", "validated tool tip", [0.45, 0, 0]),
  ]);
  const joints: readonly JointDescriptor[] = freezeArray([
    joint("neck_yaw", "head", "T", "H", [0, 0, 1], -0.9, 0.9, 2.2, 18, 0),
    joint("neck_pitch", "head", "T", "H", [0, 1, 0], -0.55, 0.65, 2.0, 16, 0.04),
    joint("jaw_grip", "mouth", "H", "E_mouth", [0, 1, 0], -0.08, 0.32, 1.0, 90, 0.04),
    joint("front_paw_reach", "front_leg", "B", "E_front_paw", [0, 1, 0], -0.7, 0.75, 2.4, 42, 0.02),
    joint("front_paw_lower", "front_leg", "B", "E_front_paw", [0, 1, 0], -1.25, 0.25, 2.8, 46, -0.65),
  ]);
  const contacts: readonly ContactSiteDescriptor[] = freezeArray([
    contact("C_front_left_paw", "paw", "C_front_left_paw", "front_left_contact_sensor", true, 160),
    contact("C_front_right_paw", "paw", "C_front_right_paw", "front_right_contact_sensor", true, 160),
    contact("C_rear_left_paw", "paw", "C_rear_left_paw", "rear_left_contact_sensor", true, 180),
    contact("C_rear_right_paw", "paw", "C_rear_right_paw", "rear_right_contact_sensor", true, 180),
    contact("C_mouth_grip", "mouth", "E_mouth", "mouth_contact_sensor", false, 95),
  ]);
  const descriptor: EmbodimentDescriptor = {
    embodiment_id: "quadruped_default_v1",
    embodiment_kind: "quadruped",
    body_scale_class: "medium",
    body_tree_ref: "quadruped_body_tree_v1",
    frame_graph_ref: "quadruped_frame_graph_v1",
    joint_group_table_ref: "quadruped_joint_groups_v1",
    actuator_group_table_ref: "quadruped_actuator_groups_v1",
    sensor_mount_table_ref: "quadruped_sensor_mounts_v1",
    contact_site_table_ref: "quadruped_contact_sites_v1",
    natural_reach_envelope_ref: "quadruped_reach_v1",
    tool_reach_policy_ref: "quadruped_tool_reach_v1",
    stability_policy_ref: "quadruped_stability_v1",
    locomotion_capability_ref: "quadruped_locomotion_v1",
    manipulation_capability_ref: "quadruped_manipulation_v1",
    safety_margin_policy_ref: "quadruped_safety_margins_v1",
    frame_graph: frames,
    joints,
    actuator_limits: freezeArray(joints.map((item) => actuator(`actuator_${item.joint_ref}`, item.joint_ref, item.joint_group, item.min_position, item.max_position, item.max_velocity, item.max_effort))),
    kinematic_chains: freezeArray([
      chain("quadruped_head_gaze_chain", "gaze", "T", "H", ["neck_yaw", "neck_pitch"], "E_mouth", [0.12, 0.26], 0.38, 0.5),
      chain("quadruped_mouth_chain", "manipulation", "T", "E_mouth", ["neck_pitch", "jaw_grip"], "E_mouth", [0.28, 0.22], 0.5, 1.6),
      chain("quadruped_front_paw_chain", "manipulation", "B", "E_front_paw", ["front_paw_reach", "front_paw_lower"], "E_front_paw", [0.24, 0.26], 0.5, 0.8),
    ]),
    end_effectors: freezeArray([
      effector("E_mouth", "mouth_gripper", "E_mouth", 0.5, 0.95, "medium", ["inspect", "grasp", "lift", "carry", "place", "push", "pull", "release", "tool_use"]),
      effector("E_front_paw", "paw", "E_front_paw", 0.42, 0.7, "low", ["inspect", "push", "pull", "release", "tool_use"]),
      effector("U_tool_tip", "tool_tip", "U_tool_tip", 0.95, 1.05, "low", ["push", "pull", "tool_use"]),
    ]),
    sensor_mounts: freezeArray([
      sensorMount("head_rgb_camera", "camera", "S_head_camera", "H", "calib_head_rgb_extrinsics", "neck-limited gaze with possible mouth occlusion"),
      sensorMount("head_microphone_array", "microphone", "S_microphone_array", "H", "calib_head_microphone_geometry", "head-mounted spatial hearing"),
      sensorMount("body_imu", "imu", "S_body_imu", "T", "calib_body_imu_alignment", "trunk balance and self-motion"),
      sensorMount("front_left_contact_sensor", "contact_sensor", "C_front_left_paw", "B", "calib_front_left_contact", "support contact"),
      sensorMount("front_right_contact_sensor", "contact_sensor", "C_front_right_paw", "B", "calib_front_right_contact", "support contact"),
      sensorMount("rear_left_contact_sensor", "contact_sensor", "C_rear_left_paw", "B", "calib_rear_left_contact", "support contact"),
      sensorMount("rear_right_contact_sensor", "contact_sensor", "C_rear_right_paw", "B", "calib_rear_right_contact", "support contact"),
    ]),
    contact_sites: contacts,
    reach_envelopes: freezeArray([
      reach("quadruped_mouth_stance_reach", "quadruped", "E_mouth", "quadruped_stand", 0.5, 0.62, 1.2, 0.95, 0.32, "front-head mouth workspace", "mouth precision close to snout", "avoid high side reach while loaded"),
      reach("quadruped_paw_stance_reach", "quadruped", "E_front_paw", "quadruped_stand", 0.42, 0.5, 1.0, 0.7, 0.25, "front paw short workspace", "coarse pushing only", "avoid extended paw manipulation during low contact confidence"),
    ]),
    stability_policy: {
      stability_policy_ref: "quadruped_stability_v1",
      base_frame_ref: "B",
      torso_frame_ref: "T",
      head_frame_ref: "H",
      nominal_support_contact_refs: contacts.filter((site) => site.nominal_support).map((site) => site.contact_site_ref),
      nominal_center_of_mass_height_m: 0.26,
      support_polygon_margin_m: 0.045,
      critical_support_margin_m: 0.018,
      max_base_tilt_rad: 0.62,
      warning_base_tilt_rad: 0.35,
      max_carried_load_kg: 3.2,
      prefers_low_center_of_mass: true,
      default_stance_ref: "quadruped_stand",
    },
    safety_margin_policy: defaultSafetyPolicy(),
    locomotion_capability: {
      capability_ref: "quadruped_locomotion_v1",
      supported_primitives: freezeArray(["stand", "turn_in_place", "step_forward", "sidestep", "crouch", "stabilize_load", "reposition_for_reach", "safe_hold"]),
      stable_speed_m_per_s: 0.75,
      carry_speed_multiplier: 0.45,
      recovery_primitives: freezeArray(["crouch", "stabilize_load", "safe_hold"]),
    },
    manipulation_capabilities: freezeArray([
      manipulation("quadruped_mouth_manipulation", "mouth_gripper", ["inspect", "grasp", "lift", "carry", "place", "release", "tool_use"], "small to medium objects", "low to medium grip force", "medium", "medium", ["slip", "crush", "occlusion", "unstable"]),
      manipulation("quadruped_paw_manipulation", "paw", ["inspect", "push", "pull", "tool_use"], "small to large push targets", undefined, "low", "low", ["slip", "collision", "unreachable"]),
    ]),
    body_masses: freezeArray([
      bodyMass("quadruped_trunk", "T", 12, [0, 0, 0], inertia(0.42, 0.64, 0.7)),
      bodyMass("quadruped_head", "H", 2.2, [0.08, 0, 0], inertia(0.04, 0.05, 0.06)),
      bodyMass("quadruped_legs", "B", 5.8, [0, 0, -0.22], inertia(0.2, 0.32, 0.22)),
    ]),
    body_summary: "Quadruped body optimized for stable low-center locomotion, head-mounted perception, mouth gripping, paw contact, and validated tool use for extended reach.",
  };
  return Object.freeze(descriptor);
}

export function createDefaultHumanoidEmbodimentDescriptor(): EmbodimentDescriptor {
  const frames: readonly FrameDescriptor[] = freezeArray([
    frame("B", "base", undefined, "permanent", "pelvis base frame", [0, 0, 0]),
    frame("T", "torso", "B", "permanent", "torso frame", [0, 0, 0.62]),
    frame("H", "head", "T", "permanent", "head frame", [0, 0, 0.42]),
    frame("S_head_camera", "sensor", "H", "permanent", "head camera frame", [0.08, 0, 0.05]),
    frame("S_wrist_camera", "sensor", "E_right_hand", "permanent", "right wrist camera frame", [0.04, -0.02, 0]),
    frame("S_torso_imu", "sensor", "T", "permanent", "torso IMU frame", [0, 0, 0.02]),
    frame("E_left_hand", "end_effector", "T", "permanent", "left hand", [0.36, 0.28, 0.08]),
    frame("E_right_hand", "end_effector", "T", "permanent", "right hand", [0.36, -0.28, 0.08]),
    frame("E_both_hands", "end_effector", "T", "permanent", "two-hand hold frame", [0.42, 0, 0.04]),
    frame("C_left_foot", "contact", "B", "permanent", "left foot contact", [0.02, 0.11, -0.92]),
    frame("C_right_foot", "contact", "B", "permanent", "right foot contact", [0.02, -0.11, -0.92]),
    frame("C_left_hand", "contact", "E_left_hand", "permanent", "left hand contact", [0.06, 0, 0]),
    frame("C_right_hand", "contact", "E_right_hand", "permanent", "right hand contact", [0.06, 0, 0]),
    frame("U_tool_tip", "tool", "E_right_hand", "task_scoped", "validated hand-held tool tip", [0.5, 0, 0]),
  ]);
  const joints: readonly JointDescriptor[] = freezeArray([
    joint("torso_yaw", "torso", "B", "T", [0, 0, 1], -0.6, 0.6, 1.6, 85, 0),
    joint("torso_pitch", "torso", "B", "T", [0, 1, 0], -0.45, 0.45, 1.4, 90, 0),
    joint("head_yaw", "head", "T", "H", [0, 0, 1], -1.0, 1.0, 2.0, 16, 0),
    joint("left_shoulder_pitch", "arm", "T", "E_left_hand", [0, 1, 0], -1.4, 1.5, 2.2, 55, 0.15),
    joint("left_elbow_pitch", "arm", "T", "E_left_hand", [0, 1, 0], -1.7, 0.05, 2.4, 42, -0.7),
    joint("right_shoulder_pitch", "arm", "T", "E_right_hand", [0, 1, 0], -1.4, 1.5, 2.2, 55, 0.15),
    joint("right_elbow_pitch", "arm", "T", "E_right_hand", [0, 1, 0], -1.7, 0.05, 2.4, 42, -0.7),
    joint("right_grip", "hand", "E_right_hand", "C_right_hand", [0, 1, 0], 0, 0.09, 0.8, 120, 0.04),
    joint("left_grip", "hand", "E_left_hand", "C_left_hand", [0, 1, 0], 0, 0.09, 0.8, 120, 0.04),
  ]);
  const contacts: readonly ContactSiteDescriptor[] = freezeArray([
    contact("C_left_foot", "foot", "C_left_foot", "left_foot_contact_sensor", true, 420),
    contact("C_right_foot", "foot", "C_right_foot", "right_foot_contact_sensor", true, 420),
    contact("C_left_hand", "hand", "C_left_hand", "left_hand_contact_sensor", false, 160),
    contact("C_right_hand", "hand", "C_right_hand", "right_hand_contact_sensor", false, 160),
  ]);
  const descriptor: EmbodimentDescriptor = {
    embodiment_id: "humanoid_default_v1",
    embodiment_kind: "humanoid",
    body_scale_class: "medium",
    body_tree_ref: "humanoid_body_tree_v1",
    frame_graph_ref: "humanoid_frame_graph_v1",
    joint_group_table_ref: "humanoid_joint_groups_v1",
    actuator_group_table_ref: "humanoid_actuator_groups_v1",
    sensor_mount_table_ref: "humanoid_sensor_mounts_v1",
    contact_site_table_ref: "humanoid_contact_sites_v1",
    natural_reach_envelope_ref: "humanoid_reach_v1",
    tool_reach_policy_ref: "humanoid_tool_reach_v1",
    stability_policy_ref: "humanoid_stability_v1",
    locomotion_capability_ref: "humanoid_locomotion_v1",
    manipulation_capability_ref: "humanoid_manipulation_v1",
    safety_margin_policy_ref: "humanoid_safety_margins_v1",
    frame_graph: frames,
    joints,
    actuator_limits: freezeArray(joints.map((item) => actuator(`actuator_${item.joint_ref}`, item.joint_ref, item.joint_group, item.min_position, item.max_position, item.max_velocity, item.max_effort))),
    kinematic_chains: freezeArray([
      chain("humanoid_head_gaze_chain", "gaze", "T", "H", ["head_yaw"], undefined, [0.24], 0.24, 0.2),
      chain("humanoid_left_arm_chain", "manipulation", "T", "E_left_hand", ["left_shoulder_pitch", "left_elbow_pitch"], "E_left_hand", [0.34, 0.31], 0.65, 2.5),
      chain("humanoid_right_arm_chain", "manipulation", "T", "E_right_hand", ["right_shoulder_pitch", "right_elbow_pitch"], "E_right_hand", [0.34, 0.31], 0.65, 2.5),
      chain("humanoid_two_hand_chain", "manipulation", "T", "E_both_hands", ["left_shoulder_pitch", "right_shoulder_pitch"], "E_both_hands", [0.38, 0.38], 0.72, 5.0),
    ]),
    end_effectors: freezeArray([
      effector("E_left_hand", "left_hand", "E_left_hand", 0.65, 1.05, "high", ["inspect", "approach", "grasp", "lift", "carry", "place", "push", "pull", "release", "tool_use"]),
      effector("E_right_hand", "right_hand", "E_right_hand", 0.65, 1.05, "high", ["inspect", "approach", "grasp", "lift", "carry", "place", "push", "pull", "release", "tool_use"]),
      effector("E_both_hands", "both_hands", "E_both_hands", 0.72, 1.05, "medium", ["grasp", "lift", "carry", "place", "push", "pull", "release", "tool_use"]),
      effector("U_tool_tip", "tool_tip", "U_tool_tip", 1.05, 1.2, "medium", ["push", "pull", "tool_use"]),
    ]),
    sensor_mounts: freezeArray([
      sensorMount("head_rgb_camera", "camera", "S_head_camera", "H", "calib_head_rgb_extrinsics", "head gaze tracking"),
      sensorMount("right_wrist_camera", "camera", "S_wrist_camera", "E_right_hand", "calib_right_wrist_camera", "close manipulation view"),
      sensorMount("torso_imu", "imu", "S_torso_imu", "T", "calib_torso_imu_alignment", "balance and torso self-motion"),
      sensorMount("left_foot_contact_sensor", "contact_sensor", "C_left_foot", "B", "calib_left_foot_contact", "support contact"),
      sensorMount("right_foot_contact_sensor", "contact_sensor", "C_right_foot", "B", "calib_right_foot_contact", "support contact"),
      sensorMount("left_hand_contact_sensor", "contact_sensor", "C_left_hand", "E_left_hand", "calib_left_hand_contact", "grasp contact"),
      sensorMount("right_hand_contact_sensor", "contact_sensor", "C_right_hand", "E_right_hand", "calib_right_hand_contact", "grasp contact"),
    ]),
    contact_sites: contacts,
    reach_envelopes: freezeArray([
      reach("humanoid_left_hand_reach", "humanoid", "E_left_hand", "humanoid_stand", 0.65, 0.78, 1.35, 1.05, 0.45, "left arm workspace", "fine placement inside midline hand workspace", "avoid large torso lean or high load while reaching"),
      reach("humanoid_right_hand_reach", "humanoid", "E_right_hand", "humanoid_stand", 0.65, 0.78, 1.35, 1.05, 0.45, "right arm workspace", "fine placement inside midline hand workspace", "avoid large torso lean or high load while reaching"),
      reach("humanoid_two_hand_reach", "humanoid", "E_both_hands", "humanoid_wide_stance", 0.72, 0.82, 1.2, 1.05, 0.35, "two-hand frontal workspace", "stable lift near torso", "avoid extended two-hand load far from torso"),
    ]),
    stability_policy: {
      stability_policy_ref: "humanoid_stability_v1",
      base_frame_ref: "B",
      torso_frame_ref: "T",
      head_frame_ref: "H",
      nominal_support_contact_refs: contacts.filter((site) => site.nominal_support).map((site) => site.contact_site_ref),
      nominal_center_of_mass_height_m: 0.88,
      support_polygon_margin_m: 0.065,
      critical_support_margin_m: 0.025,
      max_base_tilt_rad: 0.48,
      warning_base_tilt_rad: 0.25,
      max_carried_load_kg: 6.5,
      prefers_low_center_of_mass: false,
      default_stance_ref: "humanoid_stand",
    },
    safety_margin_policy: defaultSafetyPolicy(),
    locomotion_capability: {
      capability_ref: "humanoid_locomotion_v1",
      supported_primitives: freezeArray(["stand", "turn_in_place", "step_forward", "sidestep", "crouch", "wide_stance", "reposition_for_reach", "stabilize_load", "safe_hold"]),
      stable_speed_m_per_s: 0.55,
      carry_speed_multiplier: 0.35,
      recovery_primitives: freezeArray(["wide_stance", "crouch", "safe_hold"]),
    },
    manipulation_capabilities: freezeArray([
      manipulation("humanoid_left_hand_manipulation", "left_hand", ["inspect", "approach", "grasp", "lift", "carry", "place", "push", "pull", "release", "tool_use"], "small to medium objects", "low to high hand grip force", "high", "medium", ["slip", "crush", "unreachable", "unstable"]),
      manipulation("humanoid_right_hand_manipulation", "right_hand", ["inspect", "approach", "grasp", "lift", "carry", "place", "push", "pull", "release", "tool_use"], "small to medium objects", "low to high hand grip force", "high", "medium", ["slip", "crush", "unreachable", "unstable", "occlusion"]),
      manipulation("humanoid_two_hand_manipulation", "both_hands", ["grasp", "lift", "carry", "place", "push", "pull", "release", "tool_use"], "medium to large objects", "medium to high shared grip force", "medium", "low", ["slip", "collision", "unstable"]),
    ]),
    body_masses: freezeArray([
      bodyMass("humanoid_pelvis", "B", 10, [0, 0, 0.1], inertia(0.35, 0.3, 0.25)),
      bodyMass("humanoid_torso", "T", 22, [0, 0, 0.16], inertia(1.1, 0.95, 0.7)),
      bodyMass("humanoid_head", "H", 4, [0, 0, 0.02], inertia(0.08, 0.09, 0.07)),
      bodyMass("humanoid_arms", "T", 8, [0.22, 0, 0.05], inertia(0.42, 0.55, 0.28)),
      bodyMass("humanoid_legs", "B", 18, [0, 0, -0.45], inertia(0.9, 0.82, 0.42)),
    ]),
    body_summary: "Humanoid body optimized for hand manipulation, bimanual grasping, head and wrist perception, cautious locomotion, and load-aware balance checks.",
  };
  return Object.freeze(descriptor);
}

function validateEmbodimentDescriptor(descriptor: EmbodimentDescriptor, hardwareManifest: VirtualHardwareManifest | undefined): EmbodimentRegistrationReport {
  const issues: ValidationIssue[] = [];
  validateDescriptorShell(descriptor, issues);
  const frameRefs = validateFrames(descriptor.frame_graph, issues);
  const jointRefs = validateJoints(descriptor.joints, frameRefs, issues);
  validateActuators(descriptor.actuator_limits, jointRefs, issues);
  validateChains(descriptor.kinematic_chains, frameRefs, jointRefs, descriptor.end_effectors, issues);
  validateEndEffectors(descriptor.end_effectors, frameRefs, issues);
  validateSensorMounts(descriptor.sensor_mounts, frameRefs, hardwareManifest, issues);
  validateContactSites(descriptor.contact_sites, frameRefs, issues);
  validateReach(descriptor.reach_envelopes, descriptor.end_effectors, descriptor.embodiment_kind, issues);
  validateStability(descriptor.stability_policy, frameRefs, descriptor.contact_sites, issues);
  validateCapabilities(descriptor, issues);
  validateMasses(descriptor.body_masses, frameRefs, issues);
  scanForbiddenBodyDetails(descriptor, "$", issues);
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const totalMass = descriptor.body_masses.reduce((sum, mass) => sum + mass.mass_kg, 0);
  const reportBase = {
    schema_version: EMBODIMENT_MODEL_REGISTRY_SCHEMA_VERSION,
    registration_status: errorCount === 0 ? "accepted" as const : "rejected" as const,
    embodiment_id: descriptor.embodiment_id,
    embodiment_kind: descriptor.embodiment_kind,
    frame_count: descriptor.frame_graph.length,
    joint_count: descriptor.joints.length,
    actuator_count: descriptor.actuator_limits.length,
    chain_count: descriptor.kinematic_chains.length,
    sensor_mount_count: descriptor.sensor_mounts.length,
    contact_site_count: descriptor.contact_sites.length,
    reach_envelope_count: descriptor.reach_envelopes.length,
    manipulation_capability_count: descriptor.manipulation_capabilities.length,
    total_mass_kg: round3(totalMass),
    accepted: errorCount === 0,
    issue_count: issues.length,
    error_count: errorCount,
    warning_count: issues.length - errorCount,
    issues: freezeArray(issues),
  };
  return Object.freeze({
    ...reportBase,
    determinism_hash: computeDeterminismHash(reportBase),
  });
}

function validateDescriptorShell(descriptor: EmbodimentDescriptor, issues: ValidationIssue[]): void {
  validateRef(descriptor.embodiment_id, issues, "$.embodiment_id", "EmbodimentRefInvalid");
  if (!["quadruped", "humanoid"].includes(descriptor.embodiment_kind)) {
    issues.push(makeIssue("error", "UnsupportedEmbodimentKind", "$.embodiment_kind", "Embodiment kind must be quadruped or humanoid.", "Use a supported body family."));
  }
  for (const [path, value] of [
    ["body_tree_ref", descriptor.body_tree_ref],
    ["frame_graph_ref", descriptor.frame_graph_ref],
    ["joint_group_table_ref", descriptor.joint_group_table_ref],
    ["actuator_group_table_ref", descriptor.actuator_group_table_ref],
    ["sensor_mount_table_ref", descriptor.sensor_mount_table_ref],
    ["contact_site_table_ref", descriptor.contact_site_table_ref],
    ["natural_reach_envelope_ref", descriptor.natural_reach_envelope_ref],
    ["stability_policy_ref", descriptor.stability_policy_ref],
    ["locomotion_capability_ref", descriptor.locomotion_capability_ref],
    ["manipulation_capability_ref", descriptor.manipulation_capability_ref],
    ["safety_margin_policy_ref", descriptor.safety_margin_policy_ref],
  ] as const) {
    validateRef(value, issues, `$.${path}`, "EmbodimentIncomplete");
  }
  if (descriptor.body_summary.trim().length === 0) {
    issues.push(makeIssue("error", "EmbodimentIncomplete", "$.body_summary", "Body summary is required.", "Provide model-facing body capability summary."));
  }
  validateSafetyPolicy(descriptor.safety_margin_policy, issues);
}

function validateFrames(frames: readonly FrameDescriptor[], issues: ValidationIssue[]): ReadonlySet<Ref> {
  const refs = new Set<Ref>();
  if (frames.length === 0) {
    issues.push(makeIssue("error", "FrameGraphInvalid", "$.frame_graph", "Frame graph cannot be empty.", "Declare base, torso, head, sensor, contact, and end-effector frames."));
    return refs;
  }
  for (const frameItem of frames) {
    validateRef(frameItem.frame_id, issues, "$.frame_graph.frame_id", "FrameGraphInvalid");
    if (refs.has(frameItem.frame_id)) {
      issues.push(makeIssue("error", "FrameGraphInvalid", "$.frame_graph", `Duplicate frame ${frameItem.frame_id}.`, "Frame IDs must be unique."));
    }
    refs.add(frameItem.frame_id);
    if (!["base", "torso", "head", "sensor", "contact", "end_effector", "tool", "estimated_map"].includes(frameItem.frame_role)) {
      issues.push(makeIssue("error", "FrameGraphInvalid", `$.frame_graph.${frameItem.frame_id}.frame_role`, "Frame role is unsupported.", "Use a declared frame role."));
    }
    if (frameItem.validity_scope === "task_scoped" && frameItem.frame_role !== "tool") {
      issues.push(makeIssue("warning", "FrameGraphInvalid", `$.frame_graph.${frameItem.frame_id}.validity_scope`, "Only tool frames should normally be task-scoped.", "Keep body frames permanent."));
    }
    if (frameItem.transform_from_parent !== undefined) {
      validateTransform(frameItem.transform_from_parent, issues, `$.frame_graph.${frameItem.frame_id}.transform_from_parent`);
    }
  }
  for (const frameItem of frames) {
    if (frameItem.parent_frame_ref !== undefined && !refs.has(frameItem.parent_frame_ref)) {
      issues.push(makeIssue("error", "FrameGraphInvalid", `$.frame_graph.${frameItem.frame_id}.parent_frame_ref`, `Parent frame ${frameItem.parent_frame_ref} is missing.`, "Attach each frame to a declared parent."));
    }
  }
  if (frames.filter((frameItem) => frameItem.parent_frame_ref === undefined).length !== 1) {
    issues.push(makeIssue("error", "FrameGraphInvalid", "$.frame_graph", "Frame graph must have exactly one root frame.", "Use one root base frame."));
  }
  for (const role of ["base", "torso", "head", "end_effector", "contact"] as const) {
    if (!frames.some((frameItem) => frameItem.frame_role === role)) {
      issues.push(makeIssue("error", "FrameGraphInvalid", "$.frame_graph", `Frame graph lacks required ${role} frame.`, "Declare the full standard body frame set."));
    }
  }
  if (hasFrameCycle(frames)) {
    issues.push(makeIssue("error", "FrameGraphInvalid", "$.frame_graph", "Frame graph contains a parent cycle.", "Use an acyclic body-relative frame tree."));
  }
  return refs;
}

function validateJoints(joints: readonly JointDescriptor[], frameRefs: ReadonlySet<Ref>, issues: ValidationIssue[]): ReadonlySet<Ref> {
  const refs = new Set<Ref>();
  if (joints.length === 0) {
    issues.push(makeIssue("error", "JointLimitMissing", "$.joints", "At least one joint with limits is required.", "Declare body, gaze, manipulation, or gripper joints."));
  }
  for (const jointItem of joints) {
    validateRef(jointItem.joint_ref, issues, "$.joints.joint_ref", "JointLimitMissing");
    if (refs.has(jointItem.joint_ref)) {
      issues.push(makeIssue("error", "JointLimitInvalid", "$.joints", `Duplicate joint ${jointItem.joint_ref}.`, "Joint refs must be unique."));
    }
    refs.add(jointItem.joint_ref);
    if (!frameRefs.has(jointItem.parent_frame_ref) || !frameRefs.has(jointItem.child_frame_ref)) {
      issues.push(makeIssue("error", "FrameGraphInvalid", `$.joints.${jointItem.joint_ref}`, "Joint parent and child frames must exist.", "Bind joints to declared body frames."));
    }
    validateVector3(jointItem.axis_local, issues, `$.joints.${jointItem.joint_ref}.axis_local`, "JointLimitInvalid");
    const axisNorm = vectorNorm(jointItem.axis_local);
    if (jointItem.joint_type !== "fixed" && Math.abs(axisNorm - 1) > 1e-6) {
      issues.push(makeIssue("error", "JointLimitInvalid", `$.joints.${jointItem.joint_ref}.axis_local`, "Joint axis must be normalized.", "Use a unit axis vector."));
    }
    if (!Number.isFinite(jointItem.min_position) || !Number.isFinite(jointItem.max_position) || jointItem.min_position > jointItem.max_position) {
      issues.push(makeIssue("error", "JointLimitInvalid", `$.joints.${jointItem.joint_ref}`, "Joint position limits must be finite and ordered.", "Use min_position <= max_position."));
    }
    if (jointItem.home_position < jointItem.min_position || jointItem.home_position > jointItem.max_position) {
      issues.push(makeIssue("error", "JointLimitInvalid", `$.joints.${jointItem.joint_ref}.home_position`, "Joint home position must sit inside limits.", "Choose a safe home position."));
    }
    for (const [field, value] of [["max_velocity", jointItem.max_velocity], ["max_effort", jointItem.max_effort], ["safety_margin", jointItem.safety_margin]] as const) {
      if (!Number.isFinite(value) || value < 0 || (field !== "safety_margin" && value <= 0)) {
        issues.push(makeIssue("error", "JointLimitInvalid", `$.joints.${jointItem.joint_ref}.${field}`, "Joint limit values must be calibrated finite values.", "Use positive limits and nonnegative margins."));
      }
    }
  }
  return refs;
}

function validateActuators(actuators: readonly ActuatorLimitDescriptor[], jointRefs: ReadonlySet<Ref>, issues: ValidationIssue[]): void {
  if (actuators.length === 0) {
    issues.push(makeIssue("error", "ActuatorLimitMissing", "$.actuator_limits", "Actuator limits are required.", "Declare actuator capabilities and saturation policy."));
  }
  const refs = new Set<Ref>();
  for (const actuatorItem of actuators) {
    validateRef(actuatorItem.actuator_ref, issues, "$.actuator_limits.actuator_ref", "ActuatorLimitMissing");
    if (refs.has(actuatorItem.actuator_ref)) {
      issues.push(makeIssue("error", "ActuatorLimitInvalid", "$.actuator_limits", `Duplicate actuator ${actuatorItem.actuator_ref}.`, "Actuator refs must be unique."));
    }
    refs.add(actuatorItem.actuator_ref);
    if (!jointRefs.has(actuatorItem.target_joint_ref)) {
      issues.push(makeIssue("error", "ActuatorLimitInvalid", `$.actuator_limits.${actuatorItem.actuator_ref}.target_joint_ref`, "Actuator target joint is missing.", "Bind actuator to a declared joint."));
    }
    if (actuatorItem.command_interfaces.length === 0) {
      issues.push(makeIssue("error", "ActuatorLimitInvalid", `$.actuator_limits.${actuatorItem.actuator_ref}.command_interfaces`, "At least one command interface is required.", "Declare position, velocity, effort, grip_width, or tool_state."));
    }
    if (actuatorItem.min_position !== undefined && actuatorItem.max_position !== undefined && actuatorItem.min_position >= actuatorItem.max_position) {
      issues.push(makeIssue("error", "ActuatorLimitInvalid", `$.actuator_limits.${actuatorItem.actuator_ref}`, "Actuator min_position must be below max_position.", "Correct the position envelope."));
    }
    for (const [field, value] of [["max_velocity", actuatorItem.max_velocity], ["max_effort", actuatorItem.max_effort], ["max_acceleration", actuatorItem.max_acceleration]] as const) {
      if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
        issues.push(makeIssue("error", "ActuatorLimitInvalid", `$.actuator_limits.${actuatorItem.actuator_ref}.${field}`, "Actuator maximum limits must be positive and finite.", "Use calibrated positive limits."));
      }
    }
  }
}

function validateChains(
  chains: readonly KinematicChainDescriptor[],
  frameRefs: ReadonlySet<Ref>,
  jointRefs: ReadonlySet<Ref>,
  effectors: readonly EndEffectorDescriptor[],
  issues: ValidationIssue[],
): void {
  if (chains.length === 0) {
    issues.push(makeIssue("error", "EmbodimentIncomplete", "$.kinematic_chains", "At least one kinematic chain is required.", "Declare gaze, manipulation, locomotion, or gripper chains."));
  }
  for (const chainItem of chains) {
    validateRef(chainItem.chain_ref, issues, "$.kinematic_chains.chain_ref", "EmbodimentIncomplete");
    if (!frameRefs.has(chainItem.root_frame_ref) || !frameRefs.has(chainItem.tip_frame_ref)) {
      issues.push(makeIssue("error", "FrameGraphInvalid", `$.kinematic_chains.${chainItem.chain_ref}`, "Chain root and tip frames must exist.", "Attach chain endpoints to declared frames."));
    }
    for (const jointRef of chainItem.joint_refs) {
      if (!jointRefs.has(jointRef)) {
        issues.push(makeIssue("error", "JointLimitMissing", `$.kinematic_chains.${chainItem.chain_ref}.joint_refs`, `Chain references missing joint ${jointRef}.`, "Declare every chain joint."));
      }
    }
    if (chainItem.link_lengths_m.length === 0 || chainItem.link_lengths_m.some((value) => !Number.isFinite(value) || value <= 0)) {
      issues.push(makeIssue("error", "EmbodimentIncomplete", `$.kinematic_chains.${chainItem.chain_ref}.link_lengths_m`, "Chain link lengths must be positive.", "Declare calibrated link lengths for reach and IK."));
    }
    if (!Number.isFinite(chainItem.nominal_reach_m) || chainItem.nominal_reach_m <= 0) {
      issues.push(makeIssue("error", "ReachSummaryUnavailable", `$.kinematic_chains.${chainItem.chain_ref}.nominal_reach_m`, "Nominal reach must be positive.", "Declare chain reach."));
    }
    if (chainItem.end_effector_ref !== undefined && !effectors.some((effectorItem) => effectorItem.effector_ref === chainItem.end_effector_ref)) {
      issues.push(makeIssue("error", "EndEffectorUnavailable", `$.kinematic_chains.${chainItem.chain_ref}.end_effector_ref`, "Chain end effector is missing.", "Bind chain to a declared end effector."));
    }
  }
}

function validateEndEffectors(effectors: readonly EndEffectorDescriptor[], frameRefs: ReadonlySet<Ref>, issues: ValidationIssue[]): void {
  if (effectors.length === 0) {
    issues.push(makeIssue("error", "EndEffectorUnavailable", "$.end_effectors", "At least one end effector is required.", "Declare mouth, paw, hand, wrist, or tool end effectors."));
  }
  for (const effectorItem of effectors) {
    if (!frameRefs.has(effectorItem.frame_ref)) {
      issues.push(makeIssue("error", "FrameGraphInvalid", `$.end_effectors.${effectorItem.effector_ref}.frame_ref`, "End effector frame is missing.", "Attach effector to a declared body frame."));
    }
    if (!Number.isFinite(effectorItem.natural_reach_radius_m) || effectorItem.natural_reach_radius_m <= 0) {
      issues.push(makeIssue("error", "ReachSummaryUnavailable", `$.end_effectors.${effectorItem.effector_ref}.natural_reach_radius_m`, "End effector natural reach must be positive.", "Declare a calibrated natural reach radius."));
    }
    if (effectorItem.supported_primitives.length === 0) {
      issues.push(makeIssue("error", "ManipulationCapabilityMissing", `$.end_effectors.${effectorItem.effector_ref}.supported_primitives`, "End effector must support at least one primitive.", "Declare safe manipulation primitives."));
    }
  }
}

function validateSensorMounts(
  mounts: readonly SensorMountDescriptor[],
  frameRefs: ReadonlySet<Ref>,
  hardwareManifest: VirtualHardwareManifest | undefined,
  issues: ValidationIssue[],
): void {
  if (mounts.length === 0) {
    issues.push(makeIssue("error", "SensorMountMissing", "$.sensor_mounts", "Sensor mounts are required.", "Bind declared sensors to body frames."));
  }
  const hardwareSensorRefs = new Set(hardwareManifest?.sensor_inventory.map((sensor) => sensor.sensor_id) ?? []);
  for (const mount of mounts) {
    if (!frameRefs.has(mount.mount_frame_ref) || !frameRefs.has(mount.body_frame_ref)) {
      issues.push(makeIssue("error", "SensorMountMissing", `$.sensor_mounts.${mount.sensor_ref}`, "Sensor mount and body frames must exist.", "Attach sensor mounts to declared body frames."));
    }
    if (hardwareManifest !== undefined && !hardwareSensorRefs.has(mount.sensor_ref)) {
      issues.push(makeIssue("warning", "HardwareManifestMismatch", `$.sensor_mounts.${mount.sensor_ref}`, "Sensor mount is not present in supplied hardware manifest.", "Align embodiment and virtual hardware manifests."));
    }
  }
}

function validateContactSites(sites: readonly ContactSiteDescriptor[], frameRefs: ReadonlySet<Ref>, issues: ValidationIssue[]): void {
  if (sites.length === 0) {
    issues.push(makeIssue("error", "ContactSiteMissing", "$.contact_sites", "Contact sites are required.", "Declare support and manipulation contact sites."));
  }
  for (const site of sites) {
    if (!frameRefs.has(site.frame_ref)) {
      issues.push(makeIssue("error", "ContactSiteMissing", `$.contact_sites.${site.contact_site_ref}.frame_ref`, "Contact frame is missing.", "Attach contact site to a declared frame."));
    }
    if (!Number.isFinite(site.max_contact_force_n) || site.max_contact_force_n <= 0) {
      issues.push(makeIssue("error", "ContactSiteMissing", `$.contact_sites.${site.contact_site_ref}.max_contact_force_n`, "Contact force limit must be positive.", "Declare tactile/contact force limit."));
    }
  }
}

function validateReach(
  envelopes: readonly ReachEnvelopeDescriptor[],
  effectors: readonly EndEffectorDescriptor[],
  kind: EmbodimentKind,
  issues: ValidationIssue[],
): void {
  if (envelopes.length === 0) {
    issues.push(makeIssue("error", "ReachSummaryUnavailable", "$.reach_envelopes", "Reach envelopes are required.", "Declare natural, posture-adjusted, reposition, and tool reach boundaries."));
  }
  for (const envelope of envelopes) {
    if (envelope.embodiment_kind !== kind) {
      issues.push(makeIssue("error", "ReachSummaryUnavailable", `$.reach_envelopes.${envelope.reach_envelope_id}.embodiment_kind`, "Reach envelope body kind must match descriptor.", "Use matching embodiment kind."));
    }
    if (!effectors.some((effectorItem) => effectorItem.effector_ref === envelope.end_effector_ref)) {
      issues.push(makeIssue("error", "EndEffectorUnavailable", `$.reach_envelopes.${envelope.reach_envelope_id}.end_effector_ref`, "Reach envelope effector is missing.", "Bind reach to a declared end effector."));
    }
    if (!(envelope.natural_radius_m > 0 && envelope.posture_adjusted_radius_m >= envelope.natural_radius_m && envelope.reposition_radius_m >= envelope.posture_adjusted_radius_m)) {
      issues.push(makeIssue("error", "ReachSummaryUnavailable", `$.reach_envelopes.${envelope.reach_envelope_id}`, "Reach radii must be positive and ordered natural <= posture <= reposition.", "Declare conservative reach stages."));
    }
  }
}

function validateStability(policy: StabilityPolicyDescriptor, frameRefs: ReadonlySet<Ref>, sites: readonly ContactSiteDescriptor[], issues: ValidationIssue[]): void {
  for (const [field, ref] of [["base_frame_ref", policy.base_frame_ref], ["torso_frame_ref", policy.torso_frame_ref], ["head_frame_ref", policy.head_frame_ref]] as const) {
    if (!frameRefs.has(ref)) {
      issues.push(makeIssue("error", "StabilityPolicyMissing", `$.stability_policy.${field}`, `Stability frame ${ref} is missing.`, "Bind stability policy to declared frames."));
    }
  }
  for (const contactRef of policy.nominal_support_contact_refs) {
    if (!sites.some((site) => site.contact_site_ref === contactRef)) {
      issues.push(makeIssue("error", "StabilityPolicyMissing", "$.stability_policy.nominal_support_contact_refs", `Support contact ${contactRef} is missing.`, "Use declared support contacts."));
    }
  }
  if (policy.nominal_support_contact_refs.length === 0) {
    issues.push(makeIssue("error", "StabilityPolicyMissing", "$.stability_policy.nominal_support_contact_refs", "At least one nominal support contact is required.", "Declare support contacts."));
  }
  for (const [field, value] of [
    ["nominal_center_of_mass_height_m", policy.nominal_center_of_mass_height_m],
    ["support_polygon_margin_m", policy.support_polygon_margin_m],
    ["critical_support_margin_m", policy.critical_support_margin_m],
    ["max_base_tilt_rad", policy.max_base_tilt_rad],
    ["warning_base_tilt_rad", policy.warning_base_tilt_rad],
    ["max_carried_load_kg", policy.max_carried_load_kg],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      issues.push(makeIssue("error", "StabilityPolicyMissing", `$.stability_policy.${field}`, "Stability thresholds must be positive and finite.", "Declare conservative finite thresholds."));
    }
  }
  if (policy.critical_support_margin_m > policy.support_polygon_margin_m || policy.warning_base_tilt_rad > policy.max_base_tilt_rad) {
    issues.push(makeIssue("error", "StabilityPolicyMissing", "$.stability_policy", "Warning and critical thresholds must be ordered conservatively.", "Use critical margin <= warning margin and warning tilt <= critical tilt."));
  }
}

function validateCapabilities(descriptor: EmbodimentDescriptor, issues: ValidationIssue[]): void {
  if (descriptor.locomotion_capability.supported_primitives.length === 0) {
    issues.push(makeIssue("error", "LocomotionCapabilityMissing", "$.locomotion_capability", "Locomotion primitive list is required.", "Declare stance, movement, recovery, and safe-hold primitives."));
  }
  if (descriptor.manipulation_capabilities.length === 0) {
    issues.push(makeIssue("error", "ManipulationCapabilityMissing", "$.manipulation_capabilities", "Manipulation capabilities are required.", "Declare body-specific grasp, push, place, and tool-use capabilities."));
  }
  for (const capability of descriptor.manipulation_capabilities) {
    if (capability.supported_primitives.length === 0 || capability.failure_modes.length === 0) {
      issues.push(makeIssue("error", "ManipulationCapabilityMissing", `$.manipulation_capabilities.${capability.capability_ref}`, "Capability must declare primitives and failure modes.", "Declare safe primitives and expected failures."));
    }
  }
}

function validateMasses(masses: readonly BodyMassDescriptor[], frameRefs: ReadonlySet<Ref>, issues: ValidationIssue[]): void {
  if (masses.length === 0) {
    issues.push(makeIssue("error", "EmbodimentIncomplete", "$.body_masses", "Mass distribution is required.", "Declare link masses and inertias for stability validation."));
  }
  for (const mass of masses) {
    if (!frameRefs.has(mass.frame_ref)) {
      issues.push(makeIssue("error", "FrameGraphInvalid", `$.body_masses.${mass.body_ref}.frame_ref`, "Mass frame is missing.", "Attach mass descriptor to a declared frame."));
    }
    if (!Number.isFinite(mass.mass_kg) || mass.mass_kg <= 0) {
      issues.push(makeIssue("error", "EmbodimentIncomplete", `$.body_masses.${mass.body_ref}.mass_kg`, "Body mass must be positive.", "Use calibrated positive mass."));
    }
    validateVector3(mass.local_center_of_mass_m, issues, `$.body_masses.${mass.body_ref}.local_center_of_mass_m`, "EmbodimentIncomplete");
    validateInertia(mass.inertia_tensor, issues, `$.body_masses.${mass.body_ref}.inertia_tensor`);
  }
}

function validateSafetyPolicy(policy: SafetyMarginPolicy, issues: ValidationIssue[]): void {
  for (const [field, value] of [
    ["target_confidence_minimum", policy.target_confidence_minimum],
    ["tool_slip_maximum", policy.tool_slip_maximum],
    ["support_contact_confidence_minimum", policy.support_contact_confidence_minimum],
    ["load_warning_fraction", policy.load_warning_fraction],
    ["load_critical_fraction", policy.load_critical_fraction],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      issues.push(makeIssue("error", "VisibilityPolicyMissing", `$.safety_margin_policy.${field}`, "Safety policy ratio must be inside [0, 1].", "Use finite conservative ratios."));
    }
  }
  if (!Number.isFinite(policy.reach_uncertainty_m) || policy.reach_uncertainty_m < 0) {
    issues.push(makeIssue("error", "ReachSummaryUnavailable", "$.safety_margin_policy.reach_uncertainty_m", "Reach uncertainty must be nonnegative.", "Use calibrated uncertainty."));
  }
  if (policy.load_warning_fraction > policy.load_critical_fraction) {
    issues.push(makeIssue("error", "VisibilityPolicyMissing", "$.safety_margin_policy", "Load warning fraction cannot exceed critical fraction.", "Use ordered load risk thresholds."));
  }
}

function scanForbiddenBodyDetails(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value === "string") {
    if (FORBIDDEN_DETAIL_PATTERN.test(value)) {
      issues.push(makeIssue("error", "ForbiddenBodyDetail", path, "Descriptor contains forbidden simulator or QA detail.", "Remove backend handles, hidden world poses, exact COM, collision meshes, and QA truth."));
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanForbiddenBodyDetails(entry, `${path}[${index}]`, issues));
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_DETAIL_PATTERN.test(key)) {
        issues.push(makeIssue("error", "ForbiddenBodyDetail", `${path}.${key}`, "Descriptor key contains forbidden simulator or QA detail.", "Remove hidden implementation fields from embodiment models."));
      }
      scanForbiddenBodyDetails(entry, `${path}.${key}`, issues);
    }
  }
}

function validateInertia(inertiaValue: InertiaTensor, issues: ValidationIssue[], path: string): void {
  const diagonal = [inertiaValue.ixx_kg_m2, inertiaValue.iyy_kg_m2, inertiaValue.izz_kg_m2];
  for (const value of diagonal) {
    if (!Number.isFinite(value) || value <= 0) {
      issues.push(makeIssue("error", "EmbodimentIncomplete", path, "Principal inertia terms must be positive.", "Use a physically valid inertia tensor."));
    }
  }
  for (const value of [inertiaValue.ixy_kg_m2, inertiaValue.ixz_kg_m2, inertiaValue.iyz_kg_m2]) {
    if (!Number.isFinite(value)) {
      issues.push(makeIssue("error", "EmbodimentIncomplete", path, "Product inertia terms must be finite.", "Use finite inertia products."));
    }
  }
  if (
    inertiaValue.ixx_kg_m2 + inertiaValue.iyy_kg_m2 < inertiaValue.izz_kg_m2 ||
    inertiaValue.ixx_kg_m2 + inertiaValue.izz_kg_m2 < inertiaValue.iyy_kg_m2 ||
    inertiaValue.iyy_kg_m2 + inertiaValue.izz_kg_m2 < inertiaValue.ixx_kg_m2
  ) {
    issues.push(makeIssue("error", "EmbodimentIncomplete", path, "Principal inertias violate rigid body triangle inequalities.", "Recompute physically plausible inertia."));
  }
}

function hasFrameCycle(frames: readonly FrameDescriptor[]): boolean {
  const parent = new Map(frames.map((frameItem) => [frameItem.frame_id, frameItem.parent_frame_ref] as const));
  for (const frameItem of frames) {
    const seen = new Set<Ref>();
    let cursor: Ref | undefined = frameItem.frame_id;
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        return true;
      }
      seen.add(cursor);
      cursor = parent.get(cursor);
    }
  }
  return false;
}

function buildReachDecision(
  model: EmbodimentDescriptor,
  effectorRef: Ref,
  decision: ReachDecisionKind,
  targetDistance: number,
  effectiveReach: number,
  margin: number,
  confidence: number,
  action: ReachDecision["recommended_action"],
  summary: string,
  issues: readonly ValidationIssue[],
): ReachDecision {
  const base = {
    decision_ref: `reach_${model.embodiment_id}_${effectorRef}_${computeDeterminismHash({ decision, targetDistance, effectiveReach, margin, confidence }).slice(0, 12)}`,
    embodiment_ref: model.embodiment_id,
    end_effector_ref: effectorRef,
    decision,
    target_distance_m: round6(targetDistance),
    natural_reach_m: round6(model.end_effectors.find((effectorItem) => effectorItem.effector_ref === effectorRef)?.natural_reach_radius_m ?? 0),
    effective_reach_m: round6(effectiveReach),
    margin_m: round6(margin),
    confidence: clamp(confidence, 0, 1),
    recommended_action: action,
    prompt_safe_summary: summary,
    issues: freezeArray(issues),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function buildIKReport(
  embodimentRef: Ref,
  chainRef: Ref,
  feasible: boolean,
  rootAngle: number,
  elbowAngle: number,
  residual: number,
  jointSolution: Readonly<Record<Ref, number>>,
  issues: readonly ValidationIssue[],
): PlanarTwoLinkIKReport {
  const base = {
    ik_report_ref: `planar_ik_${embodimentRef}_${chainRef}_${computeDeterminismHash({ feasible, rootAngle, elbowAngle, residual, jointSolution }).slice(0, 12)}`,
    embodiment_ref: embodimentRef,
    chain_ref: chainRef,
    feasible,
    root_angle_rad: round6(rootAngle),
    elbow_angle_rad: round6(elbowAngle),
    residual_m: round6(residual),
    joint_solution: Object.freeze({ ...jointSolution }),
    issues: freezeArray(issues),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function reachSummary(decision: ReachDecisionKind, kind: EmbodimentKind, distance: number, reach: number): string {
  if (decision === "ReachableNow") {
    return `${kind} target appears inside stable reach: distance ${round3(distance)}m, effective reach ${round3(reach)}m.`;
  }
  if (decision === "ReachableWithPostureChange") {
    return `${kind} target may require posture adjustment before manipulation.`;
  }
  if (decision === "ReachableAfterReposition") {
    return `${kind} should reposition before attempting this target.`;
  }
  if (decision === "ReachableWithTool") {
    return `${kind} may need a validated task-scoped tool to reach this target.`;
  }
  if (decision === "UnknownDueToPerception") {
    return "Reach is uncertain because perception confidence or target evidence is insufficient.";
  }
  return "Target is outside safe declared reach; reject or re-plan.";
}

function classifyMargin(centerMargin: number, pointCount: number, policy: StabilityPolicyDescriptor): MarginClass {
  if (pointCount < 3) {
    return "unknown";
  }
  if (centerMargin <= policy.critical_support_margin_m) {
    return "critical";
  }
  if (centerMargin <= policy.support_polygon_margin_m) {
    return "low";
  }
  return "safe";
}

function classifyLoad(loadKg: number, model: EmbodimentDescriptor): StabilityDecision["load_shift_class"] {
  if (loadKg <= 0) {
    return "none";
  }
  const fraction = loadKg / model.stability_policy.max_carried_load_kg;
  if (fraction >= model.safety_margin_policy.load_critical_fraction) {
    return "high";
  }
  if (fraction >= model.safety_margin_policy.load_warning_fraction) {
    return "medium";
  }
  return "low";
}

function classifyStability(
  margin: MarginClass,
  tilt: StabilityDecision["base_tilt_class"],
  load: StabilityDecision["load_shift_class"],
  contactCount: number,
  model: EmbodimentDescriptor,
  issues: readonly ValidationIssue[],
): StabilityState {
  if (contactCount < minimumSupportContacts(model.embodiment_kind, "reach") || margin === "unknown") {
    return "unknown";
  }
  if (issues.some((issue) => issue.severity === "error") || margin === "critical" || tilt === "critical" || load === "high") {
    return "unstable";
  }
  if (issues.length > 0 || margin === "low" || tilt === "warning" || load === "medium") {
    return "marginal";
  }
  return "stable";
}

function stabilityAction(state: StabilityState, margin: MarginClass, motion: StabilityEvaluationInput["planned_motion"]): StabilityDecision["recommended_action"] {
  if (state === "unstable") {
    return "safe_hold";
  }
  if (state === "unknown") {
    return "re_observe";
  }
  if (margin === "critical") {
    return "crouch";
  }
  if (state === "marginal") {
    return motion === "walk" || motion === "turn" ? "slow" : "reposition";
  }
  return "continue";
}

function stabilitySummary(state: StabilityState, margin: MarginClass, tilt: StabilityDecision["base_tilt_class"], load: StabilityDecision["load_shift_class"]): string {
  if (state === "unstable") {
    return `Body stability is unsafe with ${margin} support margin, ${tilt} tilt, and ${load} load shift.`;
  }
  if (state === "unknown") {
    return "Body stability is uncertain; re-observe contact and self-motion evidence.";
  }
  if (state === "marginal") {
    return `Body stability is marginal with ${margin} support margin, ${tilt} tilt, and ${load} load shift.`;
  }
  return "Body stability is acceptable for the requested motion.";
}

function minimumSupportContacts(kind: EmbodimentKind, motion: StabilityEvaluationInput["planned_motion"]): number {
  if (kind === "quadruped") {
    return motion === "walk" || motion === "turn" ? 3 : 4;
  }
  return motion === "safe_hold" ? 2 : 2;
}

function convexHull2D(points: readonly Vector3[]): readonly Vector3[] {
  const unique = [...new Map(points.map((point) => [`${round6(point[0])}:${round6(point[1])}`, point])).values()]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (unique.length <= 2) {
    return freezeArray(unique);
  }
  const lower: Vector3[] = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross2D(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper: Vector3[] = [];
  for (const point of [...unique].reverse()) {
    while (upper.length >= 2 && cross2D(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }
  return freezeArray([...lower.slice(0, -1), ...upper.slice(0, -1)]);
}

function polygonArea2D(points: readonly Vector3[]): number {
  if (points.length < 3) {
    return 0;
  }
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const next = points[(i + 1) % points.length];
    area += points[i][0] * next[1] - next[0] * points[i][1];
  }
  return Math.abs(area) / 2;
}

function centroid2D(points: readonly Vector3[]): Vector3 {
  if (points.length === 0) {
    return ZERO_VECTOR;
  }
  return freezeVector3([
    points.reduce((sum, point) => sum + point[0], 0) / points.length,
    points.reduce((sum, point) => sum + point[1], 0) / points.length,
    points.reduce((sum, point) => sum + point[2], 0) / points.length,
  ]);
}

function distanceToPolygonEdges(point: Vector3, polygon: readonly Vector3[]): number {
  if (polygon.length < 3) {
    return 0;
  }
  return Math.min(...polygon.map((vertex, index) => {
    const next = polygon[(index + 1) % polygon.length];
    const numerator = Math.abs((next[0] - vertex[0]) * (vertex[1] - point[1]) - (vertex[0] - point[0]) * (next[1] - vertex[1]));
    const denominator = Math.hypot(next[0] - vertex[0], next[1] - vertex[1]);
    return numerator / Math.max(denominator, EPSILON);
  }));
}

function cross2D(origin: Vector3, a: Vector3, b: Vector3): number {
  return (a[0] - origin[0]) * (b[1] - origin[1]) - (a[1] - origin[1]) * (b[0] - origin[0]);
}

function frame(frameId: Ref, role: FrameRole, parent: Ref | undefined, scope: ValidityScope, label: string, position: Vector3): FrameDescriptor {
  return Object.freeze({
    frame_id: frameId,
    frame_role: role,
    parent_frame_ref: parent,
    transform_from_parent: parent === undefined ? undefined : transform(frameId, position),
    validity_scope: scope,
    uncertainty_m: 0.01,
    cognitive_label: label,
  });
}

function joint(ref: Ref, group: JointGroup, parent: Ref, child: Ref, axis: Vector3, min: number, max: number, velocity: number, effort: number, home: number): JointDescriptor {
  return Object.freeze({
    joint_ref: ref,
    joint_group: group,
    joint_type: "revolute",
    parent_frame_ref: parent,
    child_frame_ref: child,
    axis_local: freezeVector3(axis),
    min_position: min,
    max_position: max,
    max_velocity: velocity,
    max_effort: effort,
    max_acceleration: velocity * 4,
    home_position: home,
    safety_margin: 0.025,
  });
}

function actuator(ref: Ref, jointRef: Ref, group: JointGroup, min: number, max: number, velocity: number, effort: number): ActuatorLimitDescriptor {
  return Object.freeze({
    actuator_ref: ref,
    target_joint_ref: jointRef,
    actuator_group: group,
    command_interfaces: freezeArray(["position", "velocity", "effort"] as const),
    min_position: min,
    max_position: max,
    max_velocity: velocity,
    max_effort: effort,
    max_acceleration: velocity * 4,
    saturation_policy: "clip_and_report",
  });
}

function chain(ref: Ref, role: KinematicChainDescriptor["chain_role"], root: Ref, tip: Ref, joints: readonly Ref[], effectorRef: Ref | undefined, lengths: readonly number[], reachM: number, payloadKg: number): KinematicChainDescriptor {
  return Object.freeze({
    chain_ref: ref,
    chain_role: role,
    root_frame_ref: root,
    tip_frame_ref: tip,
    joint_refs: freezeArray(joints),
    end_effector_ref: effectorRef,
    link_lengths_m: freezeArray(lengths),
    nominal_reach_m: reachM,
    max_payload_kg: payloadKg,
  });
}

function effector(ref: Ref, role: EndEffectorRole, frameRef: Ref, reachM: number, toolReachM: number | undefined, precision: PrecisionRating, primitives: readonly ManipulationPrimitive[]): EndEffectorDescriptor {
  return Object.freeze({
    effector_ref: ref,
    role,
    frame_ref: frameRef,
    natural_reach_radius_m: reachM,
    tool_extended_reach_radius_m: toolReachM,
    precision_rating: precision,
    supported_primitives: freezeArray(primitives),
  });
}

function sensorMount(ref: Ref, role: SensorMountDescriptor["sensor_role"], mountFrame: Ref, bodyFrame: Ref, calibrationRef: Ref, motion: string): SensorMountDescriptor {
  return Object.freeze({
    sensor_ref: ref,
    sensor_role: role,
    mount_frame_ref: mountFrame,
    body_frame_ref: bodyFrame,
    calibration_ref: calibrationRef,
    allowed_motion_summary: motion,
  });
}

function contact(ref: Ref, role: ContactSiteDescriptor["contact_role"], frameRef: Ref, sensorRef: Ref | undefined, nominal: boolean, maxForce: number): ContactSiteDescriptor {
  return Object.freeze({
    contact_site_ref: ref,
    contact_role: role,
    frame_ref: frameRef,
    sensor_ref: sensorRef,
    nominal_support: nominal,
    max_contact_force_n: maxForce,
  });
}

function reach(ref: Ref, kind: EmbodimentKind, effectorRef: Ref, stanceRef: Ref, natural: number, posture: number, reposition: number, tool: number | undefined, precision: number, workspace: string, precisionSummary: string, unsafe: string): ReachEnvelopeDescriptor {
  return Object.freeze({
    reach_envelope_id: ref,
    embodiment_kind: kind,
    end_effector_ref: effectorRef,
    stance_ref: stanceRef,
    natural_radius_m: natural,
    posture_adjusted_radius_m: posture,
    reposition_radius_m: reposition,
    tool_extended_radius_m: tool,
    precision_radius_m: precision,
    unsafe_minimum_margin_m: 0.025,
    confidence_or_margin: 0.8,
    workspace_region_summary: workspace,
    precision_region_summary: precisionSummary,
    unsafe_region_summary: unsafe,
  });
}

function manipulation(ref: Ref, role: EndEffectorRole, primitives: readonly ManipulationPrimitive[], size: string, force: string | undefined, precision: PrecisionRating, occlusion: ManipulationCapabilityDescriptor["occlusion_risk"], failures: ManipulationCapabilityDescriptor["failure_modes"]): ManipulationCapabilityDescriptor {
  return Object.freeze({
    capability_ref: ref,
    end_effector_role: role,
    supported_primitives: freezeArray(primitives),
    object_size_range_summary: size,
    grip_force_range_summary: force,
    precision_rating: precision,
    occlusion_risk: occlusion,
    failure_modes: freezeArray(failures),
  });
}

function bodyMass(bodyRef: Ref, frameRef: Ref, massKg: number, com: Vector3, inertiaTensor: InertiaTensor): BodyMassDescriptor {
  return Object.freeze({
    body_ref: bodyRef,
    frame_ref: frameRef,
    mass_kg: massKg,
    local_center_of_mass_m: freezeVector3(com),
    inertia_tensor: inertiaTensor,
  });
}

function inertia(ixx: number, iyy: number, izz: number): InertiaTensor {
  return Object.freeze({
    ixx_kg_m2: ixx,
    iyy_kg_m2: iyy,
    izz_kg_m2: izz,
    ixy_kg_m2: 0,
    ixz_kg_m2: 0,
    iyz_kg_m2: 0,
  });
}

function transform(frameRef: Ref, position: Vector3): Transform {
  return Object.freeze({
    ...IDENTITY_TRANSFORM,
    frame_ref: frameRef,
    position_m: freezeVector3(position),
  });
}

function defaultSafetyPolicy(): SafetyMarginPolicy {
  return Object.freeze({
    target_confidence_minimum: 0.35,
    reach_uncertainty_m: 0.035,
    tool_slip_maximum: 0.35,
    support_contact_confidence_minimum: 0.55,
    load_warning_fraction: 0.45,
    load_critical_fraction: 0.8,
  });
}

function freezeEmbodimentDescriptor(descriptor: EmbodimentDescriptor): EmbodimentDescriptor {
  return Object.freeze({
    ...descriptor,
    frame_graph: freezeArray(descriptor.frame_graph),
    joints: freezeArray(descriptor.joints),
    actuator_limits: freezeArray(descriptor.actuator_limits),
    kinematic_chains: freezeArray(descriptor.kinematic_chains),
    end_effectors: freezeArray(descriptor.end_effectors),
    sensor_mounts: freezeArray(descriptor.sensor_mounts),
    contact_sites: freezeArray(descriptor.contact_sites),
    reach_envelopes: freezeArray(descriptor.reach_envelopes),
    locomotion_capability: Object.freeze({ ...descriptor.locomotion_capability, supported_primitives: freezeArray(descriptor.locomotion_capability.supported_primitives), recovery_primitives: freezeArray(descriptor.locomotion_capability.recovery_primitives) }),
    manipulation_capabilities: freezeArray(descriptor.manipulation_capabilities),
    body_masses: freezeArray(descriptor.body_masses),
  });
}

function validateTransform(value: Transform, issues: ValidationIssue[], path: string): void {
  validateRef(value.frame_ref, issues, `${path}.frame_ref`, "FrameGraphInvalid");
  validateVector3(value.position_m, issues, `${path}.position_m`, "FrameGraphInvalid");
  if (!Array.isArray(value.orientation_xyzw) || value.orientation_xyzw.length !== 4 || value.orientation_xyzw.some((component) => !Number.isFinite(component))) {
    issues.push(makeIssue("error", "FrameGraphInvalid", `${path}.orientation_xyzw`, "Quaternion must contain four finite values.", "Use normalized [x, y, z, w]."));
    return;
  }
  const norm = Math.sqrt(value.orientation_xyzw.reduce((sum, component) => sum + component * component, 0));
  if (norm < EPSILON || Math.abs(norm - 1) > 1e-6) {
    issues.push(makeIssue("error", "FrameGraphInvalid", `${path}.orientation_xyzw`, "Quaternion must be unit length.", "Normalize frame orientation."));
  }
}

function validateVector3(value: Vector3, issues: ValidationIssue[], path: string, code: EmbodimentModelIssueCode): void {
  if (!Array.isArray(value) || value.length !== 3 || value.some((component) => !Number.isFinite(component))) {
    issues.push(makeIssue("error", code, path, "Vector3 must contain exactly three finite values.", "Use [x, y, z] in meters."));
  }
}

function validateRef(value: Ref, issues: ValidationIssue[], path: string, code: EmbodimentModelIssueCode): void {
  if (typeof value !== "string" || value.trim().length === 0 || /\s/.test(value)) {
    issues.push(makeIssue("error", code, path, "Reference must be a non-empty whitespace-free string.", "Use an opaque body ref."));
  }
}

function makeIssue(severity: ValidationSeverity, code: EmbodimentModelIssueCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function safeText(value: string): string {
  return value.replace(FORBIDDEN_DETAIL_PATTERN, "hidden-detail").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  return Object.freeze([value[0], value[1], value[2]]) as Vector3;
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

export const EMBODIMENT_MODEL_REGISTRY_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: EMBODIMENT_MODEL_REGISTRY_SCHEMA_VERSION,
  blueprint: "architecture_docs/05_EMBODIMENT_KINEMATICS_QUADRUPED_HUMANOID.md",
  sections: freezeArray(["5.1", "5.2", "5.3", "5.4", "5.5", "5.6", "5.7", "5.8", "5.9", "5.11", "5.12", "5.13", "5.14", "5.15", "5.16", "5.17", "5.18", "5.19"]),
});
