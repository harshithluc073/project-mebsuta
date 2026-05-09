/**
 * Embodiment hardware adapter for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/04_VIRTUAL_HARDWARE_SENSOR_ACTUATOR_SPEC.md`
 * sections 4.3, 4.5, 4.6, 4.11, 4.12, 4.14, 4.17, and 4.18, cross-checked
 * against `architecture_docs/05_EMBODIMENT_KINEMATICS_QUADRUPED_HUMANOID.md`
 * sections 5.6, 5.7, 5.8, 5.9, 5.13, 5.14, 5.15, 5.16, 5.17, and 5.19.
 *
 * The adapter is the executable bridge between a validated virtual hardware
 * manifest and a selected quadruped or humanoid body model. It verifies that
 * sensors, actuators, contact sites, and calibration records attach to declared
 * body frames, preserves the shared packet contracts from the virtual hardware
 * layer, and emits only body self-knowledge summaries for cognition.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { EmbodimentKind, Ref, Transform, ValidationIssue, ValidationSeverity, Vector3 } from "../simulation/world_manifest";
import {
  VIRTUAL_HARDWARE_MANIFEST_REGISTRY_SCHEMA_VERSION,
  VirtualHardwareManifestRegistry,
} from "./virtual_hardware_manifest_registry";
import type {
  ActuatorClass,
  ActuatorDescriptor,
  CalibrationProfile,
  CameraRole,
  HardwareHealthStatus,
  SensorClass,
  VirtualHardwareManifest,
  VirtualSensorDescriptor,
} from "./virtual_hardware_manifest_registry";

export const EMBODIMENT_HARDWARE_ADAPTER_SCHEMA_VERSION = "mebsuta.embodiment_hardware_adapter.v1" as const;

const DEFAULT_REACH_UNCERTAINTY_M = 0.035;
const DEFAULT_TARGET_CONFIDENCE_MINIMUM = 0.35;
const DEFAULT_STABILITY_MARGIN_WARNING_M = 0.045;
const DEFAULT_STABILITY_MARGIN_CRITICAL_M = 0.015;
const DEFAULT_BASE_TILT_WARNING_RAD = 0.35;
const DEFAULT_BASE_TILT_CRITICAL_RAD = 0.6;
const DEFAULT_LOAD_WARNING_KG = 3;
const DEFAULT_LOAD_CRITICAL_KG = 6;
const DEFAULT_TOOL_SLIP_WARNING = 0.35;
const DEFAULT_TOOL_SLIP_CRITICAL = 0.7;
const EPSILON = 1e-9;

export type BodyScaleClass = "small" | "medium" | "large" | "custom";
export type FrameRole = "base" | "torso" | "head" | "sensor" | "contact" | "end_effector" | "tool";
export type ValidityScope = "permanent" | "task_scoped";
export type EndEffectorRole = "mouth_gripper" | "paw" | "forelimb" | "left_hand" | "right_hand" | "wrist" | "tool_tip" | "speaker";
export type LocomotionPrimitive =
  | "quadrupedStand"
  | "quadrupedTurnInPlace"
  | "quadrupedStepForward"
  | "quadrupedSidestep"
  | "quadrupedCrouch"
  | "quadrupedStabilizeLoad"
  | "quadrupedRepositionForReach"
  | "humanoidStand"
  | "humanoidTurnInPlace"
  | "humanoidStepForward"
  | "humanoidSidestep"
  | "humanoidCrouch"
  | "humanoidRepositionForReach";
export type ManipulationMode = "inspect" | "grasp" | "lift" | "carry" | "place" | "push" | "pull" | "release" | "tool_use";
export type ReachDecisionKind = "reachable_now" | "posture_change_needed" | "reposition_needed" | "tool_needed" | "unsafe" | "unknown";
export type StabilityState = "stable" | "marginal" | "unstable" | "unknown";
export type MarginClass = "wide" | "narrow" | "critical" | "unknown";
export type ToolAttachmentStatus = "accepted" | "rejected" | "unstable" | "needs_regrasp" | "expired";
export type EmbodimentAdapterIssueCode =
  | "EmbodimentKindMismatch"
  | "UnsupportedEmbodimentKind"
  | "FrameGraphInvalid"
  | "SensorMountMissing"
  | "ContactSiteMissing"
  | "ActuatorMappingMissing"
  | "JointLimitMissing"
  | "ReachSummaryUnavailable"
  | "StabilityPolicyMissing"
  | "SelfStateMissing"
  | "ForbiddenBodyDetail"
  | "TargetEstimateMissing"
  | "EndEffectorUnavailable"
  | "ReachUnsafe"
  | "ToolAttachmentInvalid"
  | "PerceptionUncertain"
  | "ContactInsufficient"
  | "COMMarginCritical"
  | "BaseTiltCritical"
  | "LoadTooHigh"
  | "NoSafeReposition";

/**
 * Conservative embodiment safety thresholds used by reach, stability, and tool
 * attachment decisions. Values are body-relative and never world truth.
 */
export interface EmbodimentSafetyMarginPolicy {
  readonly reach_uncertainty_m: number;
  readonly target_confidence_minimum: number;
  readonly stability_margin_warning_m: number;
  readonly stability_margin_critical_m: number;
  readonly base_tilt_warning_rad: number;
  readonly base_tilt_critical_rad: number;
  readonly load_warning_kg: number;
  readonly load_critical_kg: number;
  readonly tool_slip_warning: number;
  readonly tool_slip_critical: number;
}

export interface EmbodimentFrameDescriptor {
  readonly frame_id: Ref;
  readonly frame_role: FrameRole;
  readonly parent_frame_ref?: Ref;
  readonly transform_from_parent?: Transform;
  readonly validity_scope: ValidityScope;
  readonly cognitive_label: string;
}

export interface EmbodimentEndEffectorDescriptor {
  readonly effector_ref: Ref;
  readonly role: EndEffectorRole;
  readonly frame_ref: Ref;
  readonly natural_reach_radius_m: number;
  readonly tool_extended_reach_radius_m?: number;
  readonly precision_rating: "low" | "medium" | "high";
  readonly supported_manipulation_modes: readonly ManipulationMode[];
}

export interface EmbodimentStabilityProfile {
  readonly nominal_support_frame_refs: readonly Ref[];
  readonly base_frame_ref: Ref;
  readonly torso_frame_ref: Ref;
  readonly head_frame_ref: Ref;
  readonly maximum_safe_load_kg: number;
  readonly prefers_low_center_of_mass: boolean;
  readonly default_stance_ref: Ref;
}

export interface EmbodimentHardwareProfile {
  readonly embodiment_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly body_scale_class: BodyScaleClass;
  readonly frame_graph: readonly EmbodimentFrameDescriptor[];
  readonly end_effectors: readonly EmbodimentEndEffectorDescriptor[];
  readonly locomotion_primitives: readonly LocomotionPrimitive[];
  readonly manipulation_modes: readonly ManipulationMode[];
  readonly stability_profile: EmbodimentStabilityProfile;
  readonly safety_margin_policy?: Partial<EmbodimentSafetyMarginPolicy>;
}

export interface EmbodimentHardwareAdapterConfig {
  readonly registry: VirtualHardwareManifestRegistry;
  readonly manifest_id: Ref;
  readonly profile?: EmbodimentHardwareProfile;
  readonly safety_margin_policy?: Partial<EmbodimentSafetyMarginPolicy>;
}

export interface SensorMountRecord {
  readonly sensor_ref: Ref;
  readonly sensor_class: SensorClass;
  readonly body_frame_ref: Ref;
  readonly mount_frame_ref: Ref;
  readonly calibration_ref: Ref;
  readonly cognitive_route: "prompt_allowed" | "sensor_bus_only" | "qa_only" | "blocked";
  readonly mount_valid: boolean;
}

export interface ContactSiteRecord {
  readonly contact_sensor_ref: Ref;
  readonly contact_site_ref: Ref;
  readonly body_frame_ref: Ref;
  readonly contact_role: "foot" | "hand" | "paw" | "mouth" | "tool" | "body" | "unknown";
  readonly force_limit_n: number;
  readonly contact_valid: boolean;
}

export interface ActuatorMappingRecord {
  readonly actuator_ref: Ref;
  readonly actuator_class: ActuatorClass;
  readonly target_ref: Ref;
  readonly body_ref: Ref;
  readonly command_interfaces: readonly string[];
  readonly limit_summary: string;
  readonly mapping_valid: boolean;
}

export interface EmbodimentAdaptationReport {
  readonly schema_version: typeof EMBODIMENT_HARDWARE_ADAPTER_SCHEMA_VERSION;
  readonly report_ref: Ref;
  readonly manifest_id: Ref;
  readonly embodiment_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly sensor_mounts: readonly SensorMountRecord[];
  readonly contact_sites: readonly ContactSiteRecord[];
  readonly actuator_mappings: readonly ActuatorMappingRecord[];
  readonly missing_frame_refs: readonly Ref[];
  readonly missing_contact_site_refs: readonly Ref[];
  readonly missing_actuator_target_refs: readonly Ref[];
  readonly ok: boolean;
  readonly issue_count: number;
  readonly issues: readonly ValidationIssue[];
  readonly hidden_fields_removed: readonly string[];
  readonly cognitive_visibility: "validator_and_prompt_contract_source";
  readonly determinism_hash: string;
}

export interface EmbodimentContractPacket {
  readonly schema_version: typeof EMBODIMENT_HARDWARE_ADAPTER_SCHEMA_VERSION;
  readonly embodiment_kind: EmbodimentKind;
  readonly sensor_summary: readonly string[];
  readonly end_effector_summary: readonly string[];
  readonly locomotion_summary: readonly string[];
  readonly manipulation_summary: readonly string[];
  readonly reach_summary: string;
  readonly stability_summary: string;
  readonly tool_use_summary?: string;
  readonly health_summary?: string;
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

export interface EmbodimentReachDecision {
  readonly decision_ref: Ref;
  readonly embodiment_ref: Ref;
  readonly end_effector_ref: Ref;
  readonly decision: ReachDecisionKind;
  readonly target_distance_m: number;
  readonly effective_reach_m: number;
  readonly margin_m: number;
  readonly confidence: number;
  readonly recommended_action: "continue" | "adjust_posture" | "reposition" | "use_tool" | "reject" | "re_observe";
  readonly prompt_safe_summary: string;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface EmbodimentStabilityInput {
  readonly stance_ref: Ref;
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

export interface EmbodimentStabilityDecision {
  readonly decision_ref: Ref;
  readonly embodiment_ref: Ref;
  readonly stability_state: StabilityState;
  readonly margin_class: MarginClass;
  readonly support_polygon_area_m2: number;
  readonly center_margin_m: number;
  readonly base_tilt_rad: number;
  readonly load_risk: "none" | "low" | "medium" | "high";
  readonly recommended_action: "continue" | "slow_down" | "widen_stance" | "reposition" | "safe_hold" | "re_observe";
  readonly prompt_safe_summary: string;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface RepositionPrimitiveRecommendation {
  readonly recommendation_ref: Ref;
  readonly embodiment_ref: Ref;
  readonly primitive_ref: LocomotionPrimitive;
  readonly reason: string;
  readonly expected_effect: "reduce_reach_distance" | "improve_balance" | "improve_sensor_coverage" | "safe_hold";
  readonly prompt_safe_summary: string;
  readonly determinism_hash: string;
}

export interface ToolAttachmentInput {
  readonly tool_candidate_ref: Ref;
  readonly effector_ref: Ref;
  readonly tool_length_m: number;
  readonly tool_mass_kg: number;
  readonly grip_confidence: number;
  readonly slip_risk: number;
  readonly sweep_radius_m: number;
  readonly visually_grounded: boolean;
  readonly timestamp_s: number;
  readonly expires_after_s: number;
}

export interface ToolAttachmentDecision {
  readonly decision_ref: Ref;
  readonly status: ToolAttachmentStatus;
  readonly temporary_tool_frame_ref?: Ref;
  readonly effective_reach_m: number;
  readonly expires_at_s?: number;
  readonly prompt_safe_summary: string;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export class EmbodimentHardwareAdapterError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "EmbodimentHardwareAdapterError";
    this.issues = issues;
  }
}

/**
 * Adapts a quadruped or humanoid hardware manifest into body-grounded
 * capability, reach, contact, and prompt-contract records.
 */
export class EmbodimentHardwareAdapter {
  private readonly manifest: VirtualHardwareManifest;
  private readonly profile: EmbodimentHardwareProfile;
  private readonly policy: EmbodimentSafetyMarginPolicy;

  public constructor(private readonly config: EmbodimentHardwareAdapterConfig) {
    this.manifest = config.registry.requireManifest(config.manifest_id);
    this.profile = config.profile ?? defaultProfileFor(this.manifest.embodiment_kind);
    this.policy = mergePolicy({
      ...this.profile.safety_margin_policy,
      ...(config.safety_margin_policy ?? {}),
    });
    validatePolicy(this.policy);
    const profileIssues = validateProfile(this.profile);
    if (this.profile.embodiment_kind !== this.manifest.embodiment_kind) {
      profileIssues.push(makeIssue("error", "EmbodimentKindMismatch", "$.profile.embodiment_kind", `Profile ${this.profile.embodiment_kind} does not match manifest ${this.manifest.embodiment_kind}.`, "Use a profile matching the active hardware manifest."));
    }
    if (profileIssues.some((issue) => issue.severity === "error")) {
      throw new EmbodimentHardwareAdapterError("Embodiment hardware profile failed validation.", profileIssues);
    }
  }

  /**
   * Builds the manifest-to-body binding report used by validators and prompt
   * contract generation. Engine refs and simulator world state are not exposed.
   */
  public buildAdaptationReport(): EmbodimentAdaptationReport {
    const issues: ValidationIssue[] = [];
    const frameRefs = new Set(this.profile.frame_graph.map((frame) => frame.frame_id));
    const effectorRefs = new Set(this.profile.end_effectors.map((effector) => effector.effector_ref));
    const contactFrameRefs = new Set(this.profile.frame_graph.filter((frame) => frame.frame_role === "contact").map((frame) => frame.frame_id));
    const jointLikeTargetRefs = new Set<Ref>([
      ...this.profile.frame_graph.map((frame) => frame.frame_id),
      ...this.profile.end_effectors.map((effector) => effector.effector_ref),
    ]);
    const sensorMounts = this.manifest.sensor_inventory.map((sensor) => mapSensorMount(sensor, frameRefs, issues));
    const contactSites = this.manifest.sensor_inventory
      .filter(isContactSensor)
      .map((sensor) => mapContactSite(sensor, contactFrameRefs, frameRefs, issues));
    const actuatorMappings = this.manifest.actuator_inventory.map((actuator) => mapActuator(actuator, jointLikeTargetRefs, effectorRefs, frameRefs, issues));
    validateEmbodimentHardwareShape(this.manifest, this.profile, sensorMounts, contactSites, actuatorMappings, issues);
    const missingFrameRefs = collectMissingFrames(sensorMounts, actuatorMappings);
    const missingContactSiteRefs = contactSites.filter((site) => !site.contact_valid).map((site) => site.contact_site_ref);
    const missingActuatorTargetRefs = actuatorMappings.filter((mapping) => !mapping.mapping_valid).map((mapping) => mapping.target_ref);
    const reportBase = {
      schema_version: EMBODIMENT_HARDWARE_ADAPTER_SCHEMA_VERSION,
      report_ref: `embodiment_hardware_${this.manifest.manifest_id}_${this.profile.embodiment_ref}`,
      manifest_id: this.manifest.manifest_id,
      embodiment_ref: this.profile.embodiment_ref,
      embodiment_kind: this.profile.embodiment_kind,
      sensor_mounts: freezeArray(sensorMounts),
      contact_sites: freezeArray(contactSites),
      actuator_mappings: freezeArray(actuatorMappings),
      missing_frame_refs: freezeArray([...new Set(missingFrameRefs)].sort()),
      missing_contact_site_refs: freezeArray([...new Set(missingContactSiteRefs)].sort()),
      missing_actuator_target_refs: freezeArray([...new Set(missingActuatorTargetRefs)].sort()),
      ok: issues.every((issue) => issue.severity !== "error"),
      issue_count: issues.length,
      issues: freezeArray(issues),
      hidden_fields_removed: freezeArray(["internal_engine_ref", "simulator_world_frame", "collision_mesh", "exact_com", "backend_body_handle", "qa_truth_refs"]),
      cognitive_visibility: "validator_and_prompt_contract_source" as const,
    };
    return Object.freeze({
      ...reportBase,
      determinism_hash: computeDeterminismHash(reportBase),
    });
  }

  /**
   * Produces the Gemini-safe body contract packet from manifest hardware and
   * embodiment capability records.
   */
  public buildEmbodimentPromptContract(currentHealthStatus: HardwareHealthStatus = "healthy"): EmbodimentContractPacket {
    const adaptation = this.buildAdaptationReport();
    const sensorSummary = this.manifest.sensor_inventory
      .filter((sensor) => sensor.cognitive_route === "prompt_allowed" || sensor.cognitive_route === "sensor_bus_only")
      .map((sensor) => `${sensor.sensor_class}:${sensor.display_name} mounted on ${safeFrameLabel(sensor.mount_frame_ref, this.profile)}`)
      .sort();
    const endEffectorSummary = this.profile.end_effectors
      .map((effector) => `${effector.role} reach ${round3(effector.natural_reach_radius_m)}m precision ${effector.precision_rating}`)
      .sort();
    const locomotionSummary = this.profile.locomotion_primitives.map((primitive) => primitive).sort();
    const manipulationSummary = this.profile.manipulation_modes.map((mode) => mode).sort();
    const maxReach = Math.max(...this.profile.end_effectors.map((effector) => effector.natural_reach_radius_m));
    const toolReach = Math.max(...this.profile.end_effectors.map((effector) => effector.tool_extended_reach_radius_m ?? effector.natural_reach_radius_m));
    const contractBase = {
      schema_version: EMBODIMENT_HARDWARE_ADAPTER_SCHEMA_VERSION,
      embodiment_kind: this.profile.embodiment_kind,
      sensor_summary: freezeArray(sensorSummary),
      end_effector_summary: freezeArray(endEffectorSummary),
      locomotion_summary: freezeArray(locomotionSummary),
      manipulation_summary: freezeArray(manipulationSummary),
      reach_summary: `${this.profile.embodiment_kind} natural reach is approximately ${round3(maxReach)}m from a stable stance; target estimates include sensor uncertainty.`,
      stability_summary: stabilitySummaryFor(this.profile, this.policy),
      tool_use_summary: toolReach > maxReach ? `Validated tool attachment can extend task-scoped reach to approximately ${round3(toolReach)}m and must expire after release or safety abort.` : undefined,
      health_summary: `Declared body hardware health is ${currentHealthStatus}.`,
      forbidden_detail_report_ref: adaptation.report_ref,
      hidden_fields_removed: freezeArray(["engine_joint_handles", "simulator_world_pose", "exact_center_of_mass", "collision_mesh", "qa_success_flags", "backend_scene_paths"]),
      cognitive_visibility: "gemini_safe_body_self_knowledge" as const,
    };
    return Object.freeze({
      ...contractBase,
      determinism_hash: computeDeterminismHash(contractBase),
    });
  }

  /**
   * Evaluates whether a sensor-derived body-relative target is reachable by an
   * end effector under current stance and tool assumptions.
   */
  public evaluateReachEnvelope(
    endEffectorRole: EndEffectorRole,
    targetEstimate: ReachTargetEstimate | undefined,
    stanceState: StabilityState = "stable",
    toolState: ToolAttachmentDecision | undefined = undefined,
  ): EmbodimentReachDecision {
    const issues: ValidationIssue[] = [];
    const effector = this.profile.end_effectors.find((candidate) => candidate.role === endEffectorRole);
    if (effector === undefined) {
      issues.push(makeIssue("error", "EndEffectorUnavailable", "$.endEffectorRole", `End effector ${endEffectorRole} is not available on ${this.profile.embodiment_kind}.`, "Choose an end effector declared by the active embodiment."));
      return buildReachDecision(this.profile.embodiment_ref, "unknown_effector", "unknown", 0, 0, 0, 0, "reject", "Requested end effector is unavailable.", issues);
    }
    if (targetEstimate === undefined) {
      issues.push(makeIssue("warning", "TargetEstimateMissing", "$.targetEstimate", "Reach evaluation has no target estimate.", "Acquire camera/depth/contact evidence before checking reach."));
      return buildReachDecision(this.profile.embodiment_ref, effector.effector_ref, "unknown", 0, effector.natural_reach_radius_m, 0, 0, "re_observe", "Target estimate is missing; re-observe before reaching.", issues);
    }
    const distance = vectorMagnitude(targetEstimate.position_in_base_frame_m);
    const postureMultiplier = stanceReachMultiplier(this.profile.embodiment_kind, stanceState);
    const uncertainty = targetEstimate.uncertainty_radius_m ?? this.policy.reach_uncertainty_m;
    const toolReach = toolState?.status === "accepted" ? toolState.effective_reach_m : undefined;
    const effectiveReach = Math.max(effector.natural_reach_radius_m * postureMultiplier, toolReach ?? 0);
    const margin = effectiveReach - distance - uncertainty;
    if (targetEstimate.confidence < this.policy.target_confidence_minimum) {
      issues.push(makeIssue("warning", "PerceptionUncertain", "$.targetEstimate.confidence", "Target confidence is below reach-evaluation threshold.", "Re-observe or fuse more sensor evidence before committing."));
      return buildReachDecision(this.profile.embodiment_ref, effector.effector_ref, "unknown", distance, effectiveReach, margin, targetEstimate.confidence, "re_observe", "Target estimate is too uncertain for a safe reach decision.", issues);
    }
    if (stanceState === "unstable") {
      issues.push(makeIssue("error", "ReachUnsafe", "$.stanceState", "Current stance is unstable for reaching.", "Stabilize or safe-hold before reach execution."));
      return buildReachDecision(this.profile.embodiment_ref, effector.effector_ref, "unsafe", distance, effectiveReach, margin, targetEstimate.confidence, "reject", "Current stance is unstable; reject reach until stabilized.", issues);
    }
    if (margin >= 0) {
      return buildReachDecision(this.profile.embodiment_ref, effector.effector_ref, "reachable_now", distance, effectiveReach, margin, targetEstimate.confidence, "continue", "Target appears reachable from the current body configuration.", issues);
    }
    const postureReach = effector.natural_reach_radius_m * 1.12 - distance - uncertainty;
    if (stanceState === "stable" && postureReach >= 0) {
      return buildReachDecision(this.profile.embodiment_ref, effector.effector_ref, "posture_change_needed", distance, effector.natural_reach_radius_m * 1.12, postureReach, targetEstimate.confidence, "adjust_posture", "A conservative posture change may bring the target into reach.", issues);
    }
    if ((effector.tool_extended_reach_radius_m ?? 0) - distance - uncertainty >= 0) {
      return buildReachDecision(this.profile.embodiment_ref, effector.effector_ref, "tool_needed", distance, effector.tool_extended_reach_radius_m ?? effectiveReach, (effector.tool_extended_reach_radius_m ?? effectiveReach) - distance - uncertainty, targetEstimate.confidence, "use_tool", "A validated tool attachment is needed to reach this target.", issues);
    }
    return buildReachDecision(this.profile.embodiment_ref, effector.effector_ref, "reposition_needed", distance, effectiveReach, margin, targetEstimate.confidence, "reposition", "Body repositioning is required before this target is reachable.", issues);
  }

  /**
   * Computes support polygon margin, base tilt, and load risk from self-state
   * estimates; exact simulator COM or world pose is neither required nor used.
   */
  public evaluateEmbodimentStability(input: EmbodimentStabilityInput): EmbodimentStabilityDecision {
    const issues: ValidationIssue[] = [];
    if (input.support_contacts.length < minimumSupportContacts(this.profile.embodiment_kind, input.planned_motion)) {
      issues.push(makeIssue("warning", "ContactInsufficient", "$.support_contacts", "Support contacts are insufficient for the active body and planned motion.", "Re-observe contact state or choose a stabilizing primitive."));
    }
    const supportPoints = input.support_contacts.map((contact) => contact.position_in_base_frame_m);
    const polygon = convexHull2D(supportPoints);
    const area = polygonArea2D(polygon);
    const center = input.center_of_pressure_estimate_m ?? centroid2D(polygon);
    const centerMargin = polygon.length >= 3 ? distanceToPolygonEdges(center, polygon) : 0;
    const tilt = Math.hypot(input.base_tilt_roll_pitch_rad?.[0] ?? 0, input.base_tilt_roll_pitch_rad?.[1] ?? 0);
    const loadKg = input.carried_load_kg ?? 0;
    const loadRisk = loadRiskFor(loadKg, this.policy);
    if (centerMargin <= this.policy.stability_margin_critical_m && polygon.length >= 3) {
      issues.push(makeIssue("error", "COMMarginCritical", "$.center_of_pressure_estimate_m", "Estimated support margin is critical.", "Widen stance, reduce reach, or safe-hold."));
    }
    if (tilt >= this.policy.base_tilt_critical_rad) {
      issues.push(makeIssue("error", "BaseTiltCritical", "$.base_tilt_roll_pitch_rad", "Base tilt exceeds critical stability threshold.", "Enter safe-hold or recover posture."));
    }
    if (loadKg >= this.policy.load_critical_kg || loadKg > this.profile.stability_profile.maximum_safe_load_kg) {
      issues.push(makeIssue("error", "LoadTooHigh", "$.carried_load_kg", "Carried load exceeds embodiment stability policy.", "Set down the load or request assistance."));
    }
    const stabilityState = classifyStability(centerMargin, tilt, loadKg, polygon.length, this.policy, issues);
    const marginClass = marginClassFor(centerMargin, polygon.length, this.policy);
    const decisionBase = {
      decision_ref: `embodiment_stability_${this.profile.embodiment_ref}_${computeDeterminismHash([input.stance_ref, supportPoints, center, tilt, loadKg]).slice(0, 12)}`,
      embodiment_ref: this.profile.embodiment_ref,
      stability_state: stabilityState,
      margin_class: marginClass,
      support_polygon_area_m2: round6(area),
      center_margin_m: round6(centerMargin),
      base_tilt_rad: round6(tilt),
      load_risk: loadRisk,
      recommended_action: stabilityActionFor(stabilityState, marginClass, input.planned_motion),
      prompt_safe_summary: stabilityPromptSummary(stabilityState, marginClass, loadRisk),
      issues: freezeArray(issues),
    };
    return Object.freeze({
      ...decisionBase,
      determinism_hash: computeDeterminismHash(decisionBase),
    });
  }

  /**
   * Selects a body-valid reposition primitive from reach, obstacle, and sensor
   * health context.
   */
  public selectEmbodimentRepositionPrimitive(input: {
    readonly reach_decision: EmbodimentReachDecision;
    readonly obstacle_summary: "clear" | "front_blocked" | "side_blocked" | "ambiguous";
    readonly sensor_health_status: HardwareHealthStatus;
  }): RepositionPrimitiveRecommendation {
    let primitive: LocomotionPrimitive;
    let effect: RepositionPrimitiveRecommendation["expected_effect"] = "reduce_reach_distance";
    let reason = "Move the body closer to improve reach margin.";
    if (input.sensor_health_status === "blocked" || input.sensor_health_status === "missing" || input.obstacle_summary === "ambiguous" || input.reach_decision.decision === "unknown") {
      primitive = this.profile.embodiment_kind === "quadruped" ? "quadrupedTurnInPlace" : "humanoidTurnInPlace";
      effect = "improve_sensor_coverage";
      reason = "Reorient and re-observe because reach or obstacle evidence is uncertain.";
    } else if (input.reach_decision.decision === "unsafe") {
      primitive = this.profile.embodiment_kind === "quadruped" ? "quadrupedStand" : "humanoidStand";
      effect = "safe_hold";
      reason = "Hold a stable posture before reconsidering the unsafe reach.";
    } else if (input.obstacle_summary === "front_blocked") {
      primitive = this.profile.embodiment_kind === "quadruped" ? "quadrupedSidestep" : "humanoidSidestep";
      effect = "improve_balance";
      reason = "Sidestep to avoid the blocked frontal approach while keeping the target in view.";
    } else {
      primitive = this.profile.embodiment_kind === "quadruped" ? "quadrupedStepForward" : "humanoidStepForward";
    }
    const recommendationBase = {
      recommendation_ref: `embodiment_reposition_${this.profile.embodiment_ref}_${computeDeterminismHash([input.reach_decision.decision_ref, primitive, input.obstacle_summary]).slice(0, 12)}`,
      embodiment_ref: this.profile.embodiment_ref,
      primitive_ref: primitive,
      reason,
      expected_effect: effect,
      prompt_safe_summary: `${primitive} is recommended: ${reason}`,
    };
    return Object.freeze({
      ...recommendationBase,
      determinism_hash: computeDeterminismHash(recommendationBase),
    });
  }

  /**
   * Validates a task-scoped tool frame attachment and computes extended reach.
   */
  public attachToolFrameToEmbodiment(input: ToolAttachmentInput): ToolAttachmentDecision {
    const issues: ValidationIssue[] = [];
    const effector = this.profile.end_effectors.find((candidate) => candidate.effector_ref === input.effector_ref);
    if (effector === undefined) {
      issues.push(makeIssue("error", "EndEffectorUnavailable", "$.effector_ref", `Effector ${input.effector_ref} is not declared.`, "Attach tools only to declared end effectors."));
    }
    if (!input.visually_grounded) {
      issues.push(makeIssue("error", "ToolAttachmentInvalid", "$.visually_grounded", "Tool candidate is not grounded by sensor evidence.", "Observe the tool before creating a tool frame."));
    }
    if (input.grip_confidence < this.policy.target_confidence_minimum) {
      issues.push(makeIssue("warning", "ToolAttachmentInvalid", "$.grip_confidence", "Grip confidence is too low for a stable tool frame.", "Regrasp or collect contact evidence."));
    }
    if (input.slip_risk >= this.policy.tool_slip_critical) {
      issues.push(makeIssue("error", "ToolAttachmentInvalid", "$.slip_risk", "Tool slip risk exceeds critical threshold.", "Reject attachment or regrasp."));
    } else if (input.slip_risk >= this.policy.tool_slip_warning) {
      issues.push(makeIssue("warning", "ToolAttachmentInvalid", "$.slip_risk", "Tool slip risk is elevated.", "Use a lower-speed tool motion or regrasp."));
    }
    if (input.tool_mass_kg >= this.policy.load_critical_kg || input.tool_mass_kg > this.profile.stability_profile.maximum_safe_load_kg) {
      issues.push(makeIssue("error", "LoadTooHigh", "$.tool_mass_kg", "Tool mass exceeds the body load policy.", "Reject the tool attachment."));
    }
    const effectiveReach = Math.max(0, (effector?.natural_reach_radius_m ?? 0) + input.tool_length_m - input.sweep_radius_m * 0.15);
    const status: ToolAttachmentStatus = issues.some((issue) => issue.severity === "error")
      ? "rejected"
      : issues.some((issue) => issue.severity === "warning")
        ? "unstable"
        : "accepted";
    const expiresAt = status === "accepted" || status === "unstable" ? input.timestamp_s + Math.max(0, input.expires_after_s) : undefined;
    const decisionBase = {
      decision_ref: `tool_attachment_${input.tool_candidate_ref}_${computeDeterminismHash([input.effector_ref, input.tool_length_m, input.timestamp_s]).slice(0, 12)}`,
      status,
      temporary_tool_frame_ref: status === "accepted" || status === "unstable" ? `tool_frame_${input.tool_candidate_ref}_${input.effector_ref}` : undefined,
      effective_reach_m: round3(effectiveReach),
      expires_at_s: expiresAt,
      prompt_safe_summary: toolPromptSummary(status, round3(effectiveReach)),
      issues: freezeArray(issues),
    };
    return Object.freeze({
      ...decisionBase,
      determinism_hash: computeDeterminismHash(decisionBase),
    });
  }
}

export function createEmbodimentHardwareAdapter(config: EmbodimentHardwareAdapterConfig): EmbodimentHardwareAdapter {
  return new EmbodimentHardwareAdapter(config);
}

export function buildEmbodimentPromptContract(
  config: EmbodimentHardwareAdapterConfig,
  currentHealthStatus: HardwareHealthStatus = "healthy",
): EmbodimentContractPacket {
  return new EmbodimentHardwareAdapter(config).buildEmbodimentPromptContract(currentHealthStatus);
}

function defaultProfileFor(kind: EmbodimentKind): EmbodimentHardwareProfile {
  if (kind === "quadruped") {
    return Object.freeze({
      embodiment_ref: "default_quadruped_embodiment",
      embodiment_kind: "quadruped",
      body_scale_class: "medium",
      frame_graph: freezeArray([
        frame("B", "base", undefined, "base body frame"),
        frame("T", "torso", "B", "torso/trunk frame"),
        frame("H", "head", "T", "head and snout sensor frame"),
        frame("C_front_left_paw", "contact", "B", "front left paw contact"),
        frame("C_front_right_paw", "contact", "B", "front right paw contact"),
        frame("C_rear_left_paw", "contact", "B", "rear left paw contact"),
        frame("C_rear_right_paw", "contact", "B", "rear right paw contact"),
        frame("C_mouth_gripper", "contact", "H", "mouth gripper contact"),
        frame("E_mouth_gripper", "end_effector", "H", "mouth gripper"),
        frame("E_forelimb", "end_effector", "B", "forelimb manipulator"),
      ]),
      end_effectors: freezeArray([
        effector("E_mouth_gripper", "mouth_gripper", "E_mouth_gripper", 0.55, 1.1, "medium", ["inspect", "grasp", "lift", "carry", "place", "release", "tool_use"]),
        effector("E_forelimb", "forelimb", "E_forelimb", 0.45, 0.9, "low", ["inspect", "push", "pull", "tool_use"]),
      ]),
      locomotion_primitives: freezeArray<LocomotionPrimitive>(["quadrupedStand", "quadrupedTurnInPlace", "quadrupedStepForward", "quadrupedSidestep", "quadrupedCrouch", "quadrupedStabilizeLoad", "quadrupedRepositionForReach"]),
      manipulation_modes: freezeArray<ManipulationMode>(["inspect", "grasp", "lift", "carry", "place", "push", "pull", "release", "tool_use"]),
      stability_profile: Object.freeze({
        nominal_support_frame_refs: freezeArray(["C_front_left_paw", "C_front_right_paw", "C_rear_left_paw", "C_rear_right_paw"]),
        base_frame_ref: "B",
        torso_frame_ref: "T",
        head_frame_ref: "H",
        maximum_safe_load_kg: 4,
        prefers_low_center_of_mass: true,
        default_stance_ref: "NeutralStand",
      }),
    });
  }
  return Object.freeze({
    embodiment_ref: "default_humanoid_embodiment",
    embodiment_kind: "humanoid",
    body_scale_class: "medium",
    frame_graph: freezeArray([
      frame("B", "base", undefined, "base pelvis frame"),
      frame("T", "torso", "B", "torso frame"),
      frame("H", "head", "T", "head and eye-line frame"),
      frame("C_left_foot", "contact", "B", "left foot contact"),
      frame("C_right_foot", "contact", "B", "right foot contact"),
      frame("C_left_hand", "contact", "T", "left hand contact"),
      frame("C_right_hand", "contact", "T", "right hand contact"),
      frame("E_left_hand", "end_effector", "T", "left hand"),
      frame("E_right_hand", "end_effector", "T", "right hand"),
      frame("E_wrist", "end_effector", "T", "wrist tool interface"),
    ]),
    end_effectors: freezeArray([
      effector("E_left_hand", "left_hand", "E_left_hand", 0.75, 1.35, "high", ["inspect", "grasp", "lift", "carry", "place", "push", "pull", "release", "tool_use"]),
      effector("E_right_hand", "right_hand", "E_right_hand", 0.75, 1.35, "high", ["inspect", "grasp", "lift", "carry", "place", "push", "pull", "release", "tool_use"]),
      effector("E_wrist", "wrist", "E_wrist", 0.7, 1.25, "high", ["inspect", "grasp", "place", "push", "pull", "tool_use"]),
    ]),
    locomotion_primitives: freezeArray<LocomotionPrimitive>(["humanoidStand", "humanoidTurnInPlace", "humanoidStepForward", "humanoidSidestep", "humanoidCrouch", "humanoidRepositionForReach"]),
    manipulation_modes: freezeArray<ManipulationMode>(["inspect", "grasp", "lift", "carry", "place", "push", "pull", "release", "tool_use"]),
    stability_profile: Object.freeze({
      nominal_support_frame_refs: freezeArray(["C_left_foot", "C_right_foot"]),
      base_frame_ref: "B",
      torso_frame_ref: "T",
      head_frame_ref: "H",
      maximum_safe_load_kg: 5,
      prefers_low_center_of_mass: false,
      default_stance_ref: "humanoidStand",
    }),
  });
}

function frame(frameId: Ref, frameRole: FrameRole, parentFrameRef: Ref | undefined, cognitiveLabel: string): EmbodimentFrameDescriptor {
  return Object.freeze({
    frame_id: frameId,
    frame_role: frameRole,
    parent_frame_ref: parentFrameRef,
    validity_scope: "permanent",
    cognitive_label: cognitiveLabel,
  });
}

function effector(
  effectorRef: Ref,
  role: EndEffectorRole,
  frameRef: Ref,
  naturalReachRadiusM: number,
  toolExtendedReachRadiusM: number,
  precisionRating: EmbodimentEndEffectorDescriptor["precision_rating"],
  supportedModes: readonly ManipulationMode[],
): EmbodimentEndEffectorDescriptor {
  return Object.freeze({
    effector_ref: effectorRef,
    role,
    frame_ref: frameRef,
    natural_reach_radius_m: naturalReachRadiusM,
    tool_extended_reach_radius_m: toolExtendedReachRadiusM,
    precision_rating: precisionRating,
    supported_manipulation_modes: freezeArray(supportedModes),
  });
}

function mapSensorMount(sensor: VirtualSensorDescriptor, frameRefs: ReadonlySet<Ref>, issues: ValidationIssue[]): SensorMountRecord {
  const mountValid = frameRefs.has(sensor.body_ref) || frameRefs.has(sensor.mount_frame_ref);
  if (!mountValid) {
    issues.push(makeIssue("error", "SensorMountMissing", `$.sensor_inventory.${sensor.sensor_id}.mount_frame_ref`, `Sensor ${sensor.sensor_id} is not attached to a declared embodiment frame.`, "Attach every sensor to a body, head, torso, contact, or end-effector frame."));
  }
  return Object.freeze({
    sensor_ref: sensor.sensor_id,
    sensor_class: sensor.sensor_class,
    body_frame_ref: sensor.body_ref,
    mount_frame_ref: sensor.mount_frame_ref,
    calibration_ref: sensor.calibration_ref,
    cognitive_route: sensor.cognitive_route,
    mount_valid: mountValid,
  });
}

function mapContactSite(sensor: Extract<VirtualSensorDescriptor, { readonly sensor_class: "contact_sensor" | "force_torque" }>, contactFrameRefs: ReadonlySet<Ref>, frameRefs: ReadonlySet<Ref>, issues: ValidationIssue[]): ContactSiteRecord {
  const contactValid = contactFrameRefs.has(sensor.contact_site_ref) || frameRefs.has(sensor.contact_site_ref) || frameRefs.has(sensor.mount_frame_ref);
  if (!contactValid) {
    issues.push(makeIssue("error", "ContactSiteMissing", `$.sensor_inventory.${sensor.sensor_id}.contact_site_ref`, `Contact sensor ${sensor.sensor_id} does not map to a declared contact frame.`, "Declare a body contact frame for every tactile sensor."));
  }
  return Object.freeze({
    contact_sensor_ref: sensor.sensor_id,
    contact_site_ref: sensor.contact_site_ref,
    body_frame_ref: sensor.body_ref,
    contact_role: inferContactRole(sensor.contact_site_ref),
    force_limit_n: sensor.max_force_n,
    contact_valid: contactValid,
  });
}

function mapActuator(
  actuator: ActuatorDescriptor,
  targetRefs: ReadonlySet<Ref>,
  effectorRefs: ReadonlySet<Ref>,
  frameRefs: ReadonlySet<Ref>,
  issues: ValidationIssue[],
): ActuatorMappingRecord {
  const mappingValid = targetRefs.has(actuator.target_ref) || effectorRefs.has(actuator.target_ref) || frameRefs.has(actuator.body_ref);
  if (!mappingValid) {
    issues.push(makeIssue("error", "ActuatorMappingMissing", `$.actuator_inventory.${actuator.actuator_id}.target_ref`, `Actuator ${actuator.actuator_id} target ${actuator.target_ref} is not represented by the embodiment profile.`, "Map each actuator to a declared joint, frame, or end effector."));
  }
  return Object.freeze({
    actuator_ref: actuator.actuator_id,
    actuator_class: actuator.actuator_class,
    target_ref: actuator.target_ref,
    body_ref: actuator.body_ref,
    command_interfaces: freezeArray(actuator.command_interfaces),
    limit_summary: summarizeLimits(actuator),
    mapping_valid: mappingValid,
  });
}

function validateEmbodimentHardwareShape(
  manifest: VirtualHardwareManifest,
  profile: EmbodimentHardwareProfile,
  sensorMounts: readonly SensorMountRecord[],
  contactSites: readonly ContactSiteRecord[],
  actuatorMappings: readonly ActuatorMappingRecord[],
  issues: ValidationIssue[],
): void {
  if (manifest.embodiment_kind !== profile.embodiment_kind) {
    issues.push(makeIssue("error", "EmbodimentKindMismatch", "$.embodiment_kind", "Hardware manifest and active embodiment profile disagree.", "Select a matching quadruped or humanoid profile."));
  }
  if (!sensorMounts.some((mount) => isCameraClass(mount.sensor_class))) {
    issues.push(makeIssue("warning", "SensorMountMissing", "$.sensor_inventory", "No camera sensor is mounted for the active embodiment.", "Declare at least one egocentric camera for embodied perception."));
  }
  if (!sensorMounts.some((mount) => mount.sensor_class === "imu")) {
    issues.push(makeIssue("warning", "SensorMountMissing", "$.sensor_inventory", "No IMU sensor is mounted for the active embodiment.", "Declare an IMU for balance and self-motion evidence."));
  }
  if (!sensorMounts.some((mount) => mount.sensor_class === "joint_encoder")) {
    issues.push(makeIssue("error", "JointLimitMissing", "$.sensor_inventory", "No joint encoders are declared for proprioception.", "Declare joint encoders mapped to embodiment joints."));
  }
  if (contactSites.length === 0) {
    issues.push(makeIssue("warning", "ContactSiteMissing", "$.sensor_inventory", "No contact sensors are declared for tactile evidence.", "Declare foot, hand, paw, mouth, or tool contact sensors."));
  }
  if (actuatorMappings.length === 0) {
    issues.push(makeIssue("error", "ActuatorMappingMissing", "$.actuator_inventory", "No actuators are declared for the embodiment.", "Declare actuators with limits before control."));
  }
  if (profile.embodiment_kind === "quadruped" && contactSites.filter((site) => site.contact_role === "paw" || site.contact_role === "foot").length < 4) {
    issues.push(makeIssue("warning", "ContactInsufficient", "$.contact_sites", "Quadruped profile expects four foot or paw contact sites for stable stance.", "Declare four support contact sensors when the hardware supports them."));
  }
  if (profile.embodiment_kind === "humanoid" && !profile.end_effectors.some((effectorItem) => effectorItem.role === "left_hand" || effectorItem.role === "right_hand")) {
    issues.push(makeIssue("error", "EndEffectorUnavailable", "$.end_effectors", "Humanoid profile requires at least one hand end effector.", "Declare left or right hand capability."));
  }
}

function validateProfile(profile: EmbodimentHardwareProfile): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!["quadruped", "humanoid"].includes(profile.embodiment_kind)) {
    issues.push(makeIssue("error", "UnsupportedEmbodimentKind", "$.embodiment_kind", "Only quadruped and humanoid embodiments are supported.", "Use a supported embodiment kind."));
  }
  const frameRefs = new Set<Ref>();
  for (const frameDescriptor of profile.frame_graph) {
    validateRef(frameDescriptor.frame_id, issues, "$.frame_graph.frame_id", "FrameGraphInvalid");
    if (frameRefs.has(frameDescriptor.frame_id)) {
      issues.push(makeIssue("error", "FrameGraphInvalid", "$.frame_graph", `Duplicate frame ${frameDescriptor.frame_id}.`, "Frame refs must be unique."));
    }
    frameRefs.add(frameDescriptor.frame_id);
  }
  for (const frameDescriptor of profile.frame_graph) {
    if (frameDescriptor.parent_frame_ref !== undefined && !frameRefs.has(frameDescriptor.parent_frame_ref)) {
      issues.push(makeIssue("error", "FrameGraphInvalid", `$.frame_graph.${frameDescriptor.frame_id}.parent_frame_ref`, `Parent frame ${frameDescriptor.parent_frame_ref} is missing.`, "Attach frame to an existing body frame."));
    }
  }
  for (const effectorDescriptor of profile.end_effectors) {
    if (!frameRefs.has(effectorDescriptor.frame_ref)) {
      issues.push(makeIssue("error", "FrameGraphInvalid", `$.end_effectors.${effectorDescriptor.effector_ref}.frame_ref`, `Effector frame ${effectorDescriptor.frame_ref} is missing.`, "Attach every end effector to a declared frame."));
    }
    if (!Number.isFinite(effectorDescriptor.natural_reach_radius_m) || effectorDescriptor.natural_reach_radius_m <= 0) {
      issues.push(makeIssue("error", "ReachSummaryUnavailable", `$.end_effectors.${effectorDescriptor.effector_ref}.natural_reach_radius_m`, "Reach radius must be positive and finite.", "Provide a calibrated body-relative reach radius."));
    }
  }
  if (!frameRefs.has(profile.stability_profile.base_frame_ref) || !frameRefs.has(profile.stability_profile.torso_frame_ref) || !frameRefs.has(profile.stability_profile.head_frame_ref)) {
    issues.push(makeIssue("error", "StabilityPolicyMissing", "$.stability_profile", "Base, torso, and head frames must exist in the frame graph.", "Bind stability profile frames to declared body frames."));
  }
  return issues;
}

function buildReachDecision(
  embodimentRef: Ref,
  effectorRef: Ref,
  decision: ReachDecisionKind,
  targetDistanceM: number,
  effectiveReachM: number,
  marginM: number,
  confidence: number,
  action: EmbodimentReachDecision["recommended_action"],
  summary: string,
  issues: readonly ValidationIssue[],
): EmbodimentReachDecision {
  const decisionBase = {
    decision_ref: `embodiment_reach_${embodimentRef}_${effectorRef}_${computeDeterminismHash([decision, targetDistanceM, effectiveReachM, marginM, confidence]).slice(0, 12)}`,
    embodiment_ref: embodimentRef,
    end_effector_ref: effectorRef,
    decision,
    target_distance_m: round3(targetDistanceM),
    effective_reach_m: round3(effectiveReachM),
    margin_m: round3(marginM),
    confidence: clamp01(confidence),
    recommended_action: action,
    prompt_safe_summary: summary,
    issues: freezeArray(issues),
  };
  return Object.freeze({
    ...decisionBase,
    determinism_hash: computeDeterminismHash(decisionBase),
  });
}

function classifyStability(
  centerMarginM: number,
  baseTiltRad: number,
  loadKg: number,
  polygonPointCount: number,
  policy: EmbodimentSafetyMarginPolicy,
  issues: readonly ValidationIssue[],
): StabilityState {
  if (polygonPointCount < 2) {
    return "unknown";
  }
  if (issues.some((issue) => issue.severity === "error") || centerMarginM <= policy.stability_margin_critical_m || baseTiltRad >= policy.base_tilt_critical_rad || loadKg >= policy.load_critical_kg) {
    return "unstable";
  }
  if (issues.length > 0 || centerMarginM <= policy.stability_margin_warning_m || baseTiltRad >= policy.base_tilt_warning_rad || loadKg >= policy.load_warning_kg) {
    return "marginal";
  }
  return "stable";
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
  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length];
    area += points[index][0] * next[1] - next[0] * points[index][1];
  }
  return Math.abs(area) / 2;
}

function centroid2D(points: readonly Vector3[]): Vector3 {
  if (points.length === 0) {
    return [0, 0, 0];
  }
  return [
    points.reduce((sum, point) => sum + point[0], 0) / points.length,
    points.reduce((sum, point) => sum + point[1], 0) / points.length,
    points.reduce((sum, point) => sum + point[2], 0) / points.length,
  ];
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

function mergePolicy(input: Partial<EmbodimentSafetyMarginPolicy>): EmbodimentSafetyMarginPolicy {
  return Object.freeze({
    reach_uncertainty_m: input.reach_uncertainty_m ?? DEFAULT_REACH_UNCERTAINTY_M,
    target_confidence_minimum: input.target_confidence_minimum ?? DEFAULT_TARGET_CONFIDENCE_MINIMUM,
    stability_margin_warning_m: input.stability_margin_warning_m ?? DEFAULT_STABILITY_MARGIN_WARNING_M,
    stability_margin_critical_m: input.stability_margin_critical_m ?? DEFAULT_STABILITY_MARGIN_CRITICAL_M,
    base_tilt_warning_rad: input.base_tilt_warning_rad ?? DEFAULT_BASE_TILT_WARNING_RAD,
    base_tilt_critical_rad: input.base_tilt_critical_rad ?? DEFAULT_BASE_TILT_CRITICAL_RAD,
    load_warning_kg: input.load_warning_kg ?? DEFAULT_LOAD_WARNING_KG,
    load_critical_kg: input.load_critical_kg ?? DEFAULT_LOAD_CRITICAL_KG,
    tool_slip_warning: input.tool_slip_warning ?? DEFAULT_TOOL_SLIP_WARNING,
    tool_slip_critical: input.tool_slip_critical ?? DEFAULT_TOOL_SLIP_CRITICAL,
  });
}

function validatePolicy(policy: EmbodimentSafetyMarginPolicy): void {
  const issues: ValidationIssue[] = [];
  validatePositive(policy.reach_uncertainty_m, issues, "$.policy.reach_uncertainty_m");
  validateRatio(policy.target_confidence_minimum, issues, "$.policy.target_confidence_minimum");
  validatePositive(policy.stability_margin_warning_m, issues, "$.policy.stability_margin_warning_m");
  validatePositive(policy.stability_margin_critical_m, issues, "$.policy.stability_margin_critical_m");
  validatePositive(policy.base_tilt_warning_rad, issues, "$.policy.base_tilt_warning_rad");
  validatePositive(policy.base_tilt_critical_rad, issues, "$.policy.base_tilt_critical_rad");
  validatePositive(policy.load_warning_kg, issues, "$.policy.load_warning_kg");
  validatePositive(policy.load_critical_kg, issues, "$.policy.load_critical_kg");
  validateRatio(policy.tool_slip_warning, issues, "$.policy.tool_slip_warning");
  validateRatio(policy.tool_slip_critical, issues, "$.policy.tool_slip_critical");
  if (policy.stability_margin_critical_m > policy.stability_margin_warning_m) {
    issues.push(makeIssue("error", "StabilityPolicyMissing", "$.policy", "Critical stability margin must be less than or equal to warning margin.", "Use conservative margin thresholds."));
  }
  if (policy.base_tilt_warning_rad > policy.base_tilt_critical_rad || policy.load_warning_kg > policy.load_critical_kg || policy.tool_slip_warning > policy.tool_slip_critical) {
    issues.push(makeIssue("error", "StabilityPolicyMissing", "$.policy", "Warning thresholds cannot exceed critical thresholds.", "Raise critical thresholds or lower warning thresholds."));
  }
  if (issues.length > 0) {
    throw new EmbodimentHardwareAdapterError("Embodiment safety margin policy failed validation.", issues);
  }
}

function stanceReachMultiplier(kind: EmbodimentKind, stanceState: StabilityState): number {
  if (stanceState === "unstable" || stanceState === "unknown") {
    return 0.75;
  }
  if (kind === "quadruped") {
    return stanceState === "stable" ? 1 : 0.86;
  }
  return stanceState === "stable" ? 1 : 0.8;
}

function minimumSupportContacts(kind: EmbodimentKind, plannedMotion: EmbodimentStabilityInput["planned_motion"]): number {
  if (plannedMotion === "safe_hold") {
    return kind === "quadruped" ? 4 : 2;
  }
  if (kind === "quadruped") {
    return plannedMotion === "walk" || plannedMotion === "turn" ? 3 : 4;
  }
  return 2;
}

function stabilityActionFor(
  stabilityState: StabilityState,
  marginClass: MarginClass,
  plannedMotion: EmbodimentStabilityInput["planned_motion"],
): EmbodimentStabilityDecision["recommended_action"] {
  if (stabilityState === "unstable") {
    return "safe_hold";
  }
  if (stabilityState === "unknown") {
    return "re_observe";
  }
  if (marginClass === "critical") {
    return "widen_stance";
  }
  if (stabilityState === "marginal") {
    return plannedMotion === "walk" || plannedMotion === "turn" ? "slow_down" : "reposition";
  }
  return "continue";
}

function marginClassFor(centerMarginM: number, pointCount: number, policy: EmbodimentSafetyMarginPolicy): MarginClass {
  if (pointCount < 3) {
    return "unknown";
  }
  if (centerMarginM <= policy.stability_margin_critical_m) {
    return "critical";
  }
  if (centerMarginM <= policy.stability_margin_warning_m) {
    return "narrow";
  }
  return "wide";
}

function loadRiskFor(loadKg: number, policy: EmbodimentSafetyMarginPolicy): EmbodimentStabilityDecision["load_risk"] {
  if (loadKg <= 0) {
    return "none";
  }
  if (loadKg >= policy.load_critical_kg) {
    return "high";
  }
  if (loadKg >= policy.load_warning_kg) {
    return "medium";
  }
  return "low";
}

function toolPromptSummary(status: ToolAttachmentStatus, reachM: number): string {
  if (status === "accepted") {
    return `Tool frame accepted; temporary reach is approximately ${reachM}m.`;
  }
  if (status === "unstable") {
    return `Tool frame is unstable; use low-speed motion or regrasp before extending reach beyond ${reachM}m.`;
  }
  if (status === "needs_regrasp") {
    return "Tool needs regrasp before it can extend reach.";
  }
  if (status === "expired") {
    return "Tool frame expired and must not be used for reach.";
  }
  return "Tool frame rejected; do not extend reach with this tool.";
}

function stabilityPromptSummary(stabilityState: StabilityState, marginClass: MarginClass, loadRisk: EmbodimentStabilityDecision["load_risk"]): string {
  if (stabilityState === "unstable") {
    return "Body stability is unsafe; safe-hold or reposition is required.";
  }
  if (stabilityState === "unknown") {
    return "Body stability is uncertain; re-observe contact and self-motion.";
  }
  if (stabilityState === "marginal") {
    return `Body stability is marginal with ${marginClass} support margin and ${loadRisk} load risk.`;
  }
  return `Body stability is acceptable with ${marginClass} support margin.`;
}

function stabilitySummaryFor(profile: EmbodimentHardwareProfile, policy: EmbodimentSafetyMarginPolicy): string {
  if (profile.embodiment_kind === "quadruped") {
    return `Quadruped stability depends on paw contact confidence and low center of mass; support margin below ${round3(policy.stability_margin_warning_m)}m should trigger caution.`;
  }
  return `Humanoid stability depends on two-foot support, torso tilt, and load shift; support margin below ${round3(policy.stability_margin_warning_m)}m should trigger caution.`;
}

function inferContactRole(ref: Ref): ContactSiteRecord["contact_role"] {
  const lower = ref.toLowerCase();
  if (lower.includes("paw")) {
    return "paw";
  }
  if (lower.includes("foot") || lower.includes("feet")) {
    return "foot";
  }
  if (lower.includes("hand") || lower.includes("finger")) {
    return "hand";
  }
  if (lower.includes("mouth") || lower.includes("gripper") || lower.includes("jaw")) {
    return "mouth";
  }
  if (lower.includes("tool")) {
    return "tool";
  }
  if (lower.includes("body") || lower.includes("torso")) {
    return "body";
  }
  return "unknown";
}

function summarizeLimits(actuator: ActuatorDescriptor): string {
  const limits = actuator.limit_envelope;
  const parts = [
    limits.min_position !== undefined || limits.max_position !== undefined ? `position[${limits.min_position ?? "-inf"},${limits.max_position ?? "inf"}]` : undefined,
    limits.max_velocity !== undefined ? `velocity<=${round3(limits.max_velocity)}` : undefined,
    limits.max_effort !== undefined ? `effort<=${round3(limits.max_effort)}` : undefined,
    limits.max_acceleration !== undefined ? `acceleration<=${round3(limits.max_acceleration)}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? "limits unspecified" : parts.join("; ");
}

function collectMissingFrames(sensorMounts: readonly SensorMountRecord[], actuatorMappings: readonly ActuatorMappingRecord[]): readonly Ref[] {
  return freezeArray([
    ...sensorMounts.filter((mount) => !mount.mount_valid).flatMap((mount) => [mount.body_frame_ref, mount.mount_frame_ref]),
    ...actuatorMappings.filter((mapping) => !mapping.mapping_valid).map((mapping) => mapping.body_ref),
  ]);
}

function safeFrameLabel(frameRef: Ref, profile: EmbodimentHardwareProfile): string {
  return profile.frame_graph.find((frameDescriptor) => frameDescriptor.frame_id === frameRef)?.cognitive_label ?? frameRef;
}

function isCameraClass(sensorClass: SensorClass): boolean {
  return sensorClass === "rgb_camera" || sensorClass === "depth_camera" || sensorClass === "stereo_camera";
}

function isContactSensor(sensor: VirtualSensorDescriptor): sensor is Extract<VirtualSensorDescriptor, { readonly sensor_class: "contact_sensor" | "force_torque" }> {
  return sensor.sensor_class === "contact_sensor" || sensor.sensor_class === "force_torque";
}

function validateRef(value: Ref, issues: ValidationIssue[], path: string, code: EmbodimentAdapterIssueCode): void {
  if (value.trim().length === 0 || /\s/.test(value)) {
    issues.push(makeIssue("error", code, path, "Reference must be a non-empty whitespace-free string.", "Use opaque body and hardware refs."));
  }
}

function validatePositive(value: number, issues: ValidationIssue[], path: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    issues.push(makeIssue("error", "StabilityPolicyMissing", path, "Policy value must be positive and finite.", "Use calibrated positive thresholds."));
  }
}

function validateRatio(value: number, issues: ValidationIssue[], path: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    issues.push(makeIssue("error", "StabilityPolicyMissing", path, "Policy ratio must be finite and inside [0, 1].", "Use a ratio between zero and one."));
  }
}

function vectorMagnitude(value: Vector3): number {
  return Math.hypot(value[0], value[1], value[2]);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function round6(value: number): number {
  return Math.round(value * 1000000) / 1000000;
}

function makeIssue(severity: ValidationSeverity, code: EmbodimentAdapterIssueCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

export const EMBODIMENT_HARDWARE_ADAPTER_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: VIRTUAL_HARDWARE_MANIFEST_REGISTRY_SCHEMA_VERSION,
  embodiment_hardware_adapter_schema_version: EMBODIMENT_HARDWARE_ADAPTER_SCHEMA_VERSION,
  blueprint: "architecture_docs/04_VIRTUAL_HARDWARE_SENSOR_ACTUATOR_SPEC.md",
  cross_checked_blueprint: "architecture_docs/05_EMBODIMENT_KINEMATICS_QUADRUPED_HUMANOID.md",
  sections: freezeArray(["4.3", "4.5", "4.6", "4.11", "4.12", "4.14", "4.17", "4.18", "5.15", "5.16", "5.17", "5.19"]),
});
