/**
 * Manipulation primitive catalog for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md`
 * sections 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10, 12.11,
 * 12.12, 12.13, and 12.17.
 *
 * This module is the executable declaration boundary for deterministic
 * manipulation primitives. It defines the catalog entries used to inspect,
 * approach, align, grasp, lift, carry, place, release, retreat, push, pull,
 * slide, pin, nudge, acquire tools, use tools, and enter manipulation
 * safe-hold. Every descriptor includes File 11 control phases, contact modes,
 * target-frame requirements, preconditions, postconditions, verification
 * hooks, Oops evidence fields, and safety stops. Raw Gemini output never
 * admits a primitive here; callers must provide validated plan and control
 * references.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type {
  EmbodimentKind,
  Ref,
  ValidationIssue,
  ValidationSeverity,
} from "../simulation/world_manifest";
import type {
  EndEffectorRole,
  ManipulationPrimitive,
} from "../embodiment/embodiment_model_registry";
import type {
  ContactMode,
  PrimitivePhase,
} from "../control/trajectory_shaping_service";

export const MANIPULATION_PRIMITIVE_CATALOG_SCHEMA_VERSION = "mebsuta.manipulation_primitive_catalog.v1" as const;

const HIDDEN_PRIMITIVE_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|qa_success|qa_label|qa_only|simulator truth|mesh_name|asset_id|benchmark_truth|oracle_pose|raw_gemini_actuation|direct_actuator)/i;

export type ManipulationPrimitiveFamily =
  | "observation"
  | "approach"
  | "precontact"
  | "contact_acquisition"
  | "transport"
  | "placement"
  | "release"
  | "post_action"
  | "non_grasp_contact"
  | "tool_acquisition"
  | "tool_action"
  | "safety";

export type ManipulationPrimitiveName =
  | "inspect_target"
  | "approach_target"
  | "align_end_effector"
  | "grasp_object"
  | "contact_push"
  | "lift_object"
  | "carry_object"
  | "place_object"
  | "release_object"
  | "retreat_end_effector"
  | "push_object"
  | "pull_object"
  | "slide_object"
  | "pin_object"
  | "nudge_object"
  | "acquire_tool"
  | "use_tool"
  | "safe_hold_manipulation";

export type ManipulationAdmissionClass =
  | "observation_only"
  | "free_space_motion"
  | "precontact_motion"
  | "contact_motion"
  | "load_bearing_motion"
  | "verification_sensitive_motion"
  | "tool_motion"
  | "safety_motion";

export type ManipulationContactExpectation =
  | "no_contact"
  | "expected_contact"
  | "grip"
  | "support"
  | "tool_contact"
  | "release_contact"
  | "safe_hold_contact";

export type ManipulationSensorEvidence =
  | "primary_view"
  | "side_view"
  | "wrist_or_mouth_view"
  | "target_visibility"
  | "contact_sensor"
  | "force_estimate"
  | "imu"
  | "proprioception"
  | "audio_impact"
  | "tool_tip_view"
  | "verification_view";

export type ManipulationFallbackAction =
  | "reobserve"
  | "alternate_view"
  | "alternate_grasp"
  | "reposition"
  | "validate_tool"
  | "reduce_force"
  | "correct"
  | "safe_hold"
  | "human_review";

export type ManipulationFailureCategory =
  | "target_lost"
  | "path_blocked"
  | "missed_contact"
  | "partial_grasp"
  | "slip"
  | "drop"
  | "crush_risk"
  | "collision"
  | "overshoot"
  | "oscillation"
  | "timeout"
  | "sensor_occlusion"
  | "ik_infeasible"
  | "actuator_saturation"
  | "stability_risk"
  | "placement_residual"
  | "tool_instability"
  | "tool_frame_stale"
  | "verification_blocked";

export type ManipulationVerificationHook =
  | "none"
  | "inspect_ready"
  | "contact_confirmed"
  | "grasp_confirmed"
  | "lift_settled"
  | "carry_stable"
  | "placement_candidate"
  | "release_settled"
  | "retreat_clear"
  | "tool_effect_verified"
  | "safe_hold_stable";

export type ManipulationPrimitiveIssueCode =
  | "PrimitiveMissing"
  | "PrimitiveDuplicated"
  | "PrimitiveUnsupportedForEmbodiment"
  | "PrimitiveUnsupportedForEffector"
  | "ValidatedPlanMissing"
  | "ControlWorkOrderMissing"
  | "TargetFrameMissing"
  | "SubjectObjectMissing"
  | "ToolFrameMissing"
  | "ContactExpectationMismatch"
  | "SuccessConditionMissing"
  | "FallbackPolicyMissing"
  | "SensorEvidenceMissing"
  | "HiddenPrimitiveLeak";

/**
 * File 12 control profile attached to a manipulation primitive.
 */
export interface ManipulationControlPhaseProfile {
  readonly phases: readonly PrimitivePhase[];
  readonly contact_mode: ContactMode;
  readonly gain_family_ref: Ref;
  readonly speed_scale: number;
  readonly max_contact_velocity_m_s?: number;
  readonly force_profile: "inspect_only" | "gentle" | "normal" | "cautious" | "tool_contact" | "release" | "retreat" | "hold";
  readonly settle_window_s: number;
}

/**
 * Required target, object, and tool frames for primitive instantiation.
 */
export interface ManipulationTargetFrameRequirement {
  readonly requires_subject_object: boolean;
  readonly requires_target_frame: boolean;
  readonly requires_tool_frame: boolean;
  readonly tolerance_class: "view_only" | "coarse" | "contact" | "grasp" | "placement" | "tool_tip" | "safe_hold";
  readonly required_frame_roles: readonly ("object" | "target" | "end_effector" | "support" | "tool" | "verification")[];
}

/**
 * Executable File 12 primitive descriptor.
 */
export interface ManipulationPrimitiveDescriptor {
  readonly schema_version: typeof MANIPULATION_PRIMITIVE_CATALOG_SCHEMA_VERSION;
  readonly primitive_ref: Ref;
  readonly primitive_name: ManipulationPrimitiveName;
  readonly capability_primitive: ManipulationPrimitive;
  readonly primitive_family: ManipulationPrimitiveFamily;
  readonly admission_class: ManipulationAdmissionClass;
  readonly embodiment_variants: readonly EmbodimentKind[];
  readonly required_end_effector_roles: readonly EndEffectorRole[];
  readonly required_sensor_evidence: readonly ManipulationSensorEvidence[];
  readonly target_frame_requirements: ManipulationTargetFrameRequirement;
  readonly preconditions: readonly string[];
  readonly control_phase_profile: ManipulationControlPhaseProfile;
  readonly postconditions: readonly string[];
  readonly verification_hook: ManipulationVerificationHook;
  readonly failure_modes: readonly ManipulationFailureCategory[];
  readonly oops_handoff_fields: readonly string[];
  readonly safety_stop_conditions: readonly string[];
  readonly fallback_policy: readonly ManipulationFallbackAction[];
  readonly cognitive_safe_summary: string;
  readonly determinism_hash: string;
}

/**
 * Validated manipulation intent from plan validation and control admission.
 */
export interface PrimitiveExecutionIntent {
  readonly intent_ref: Ref;
  readonly source_plan_ref: Ref;
  readonly control_work_order_ref: Ref;
  readonly selected_primitive_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly end_effector_role: EndEffectorRole;
  readonly subject_object_ref?: Ref;
  readonly target_frame_ref?: Ref;
  readonly tool_frame_ref?: Ref;
  readonly available_sensor_evidence: readonly ManipulationSensorEvidence[];
  readonly contact_expectation: ManipulationContactExpectation;
  readonly success_condition: string;
  readonly fallback_policy: readonly ManipulationFallbackAction[];
  readonly validation_decision_ref: Ref;
}

/**
 * Descriptor plus validation outcome for a proposed primitive intent.
 */
export interface PrimitiveExecutionIntentReport {
  readonly schema_version: typeof MANIPULATION_PRIMITIVE_CATALOG_SCHEMA_VERSION;
  readonly intent_ref: Ref;
  readonly selected_primitive_ref: Ref;
  readonly primitive_name?: ManipulationPrimitiveName;
  readonly admission_class?: ManipulationAdmissionClass;
  readonly accepted: boolean;
  readonly control_phase_profile?: ManipulationControlPhaseProfile;
  readonly missing_sensor_evidence: readonly ManipulationSensorEvidence[];
  readonly missing_fallback_actions: readonly ManipulationFallbackAction[];
  readonly required_oops_handoff_fields: readonly string[];
  readonly required_safety_stop_conditions: readonly string[];
  readonly issues: readonly ValidationIssue[];
  readonly cognitive_safe_summary: string;
  readonly determinism_hash: string;
}

export interface ManipulationPrimitiveCatalogQuery {
  readonly embodiment_kind?: EmbodimentKind;
  readonly end_effector_role?: EndEffectorRole;
  readonly primitive_name?: ManipulationPrimitiveName;
  readonly capability_primitive?: ManipulationPrimitive;
  readonly admission_class?: ManipulationAdmissionClass;
  readonly verification_hook?: ManipulationVerificationHook;
}

export interface ManipulationPrimitiveCatalogReport {
  readonly schema_version: typeof MANIPULATION_PRIMITIVE_CATALOG_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md";
  readonly catalog_ref: Ref;
  readonly primitive_count: number;
  readonly primitive_names: readonly ManipulationPrimitiveName[];
  readonly descriptors: readonly ManipulationPrimitiveDescriptor[];
  readonly family_summaries: readonly ManipulationPrimitiveFamilySummary[];
  readonly hidden_fields_removed: readonly string[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
}

export interface ManipulationPrimitiveFamilySummary {
  readonly primitive_family: ManipulationPrimitiveFamily;
  readonly primitive_count: number;
  readonly primitive_names: readonly ManipulationPrimitiveName[];
  readonly admission_classes: readonly ManipulationAdmissionClass[];
  readonly embodiment_variants: readonly EmbodimentKind[];
}

/**
 * Read-only catalog service for File 12 primitive definitions.
 */
export class ManipulationPrimitiveCatalog {
  private readonly descriptors: readonly ManipulationPrimitiveDescriptor[];

  public constructor(descriptors: readonly ManipulationPrimitiveDescriptor[] = DEFAULT_MANIPULATION_PRIMITIVES) {
    this.descriptors = freezeArray(descriptors.map((descriptor) => freezeDescriptor(descriptor)));
  }

  /**
   * Builds a deterministic primitive catalog report, optionally filtered by
   * embodiment, effector, family, primitive, or verification hook.
   */
  public buildCatalogReport(query: ManipulationPrimitiveCatalogQuery = {}): ManipulationPrimitiveCatalogReport {
    const issues = validateCatalog(this.descriptors);
    const descriptors = freezeArray(this.descriptors
      .filter((descriptor) => matchesQuery(descriptor, query))
      .sort((a, b) => a.primitive_ref.localeCompare(b.primitive_ref)));
    const base = {
      schema_version: MANIPULATION_PRIMITIVE_CATALOG_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md" as const,
      catalog_ref: `manipulation_primitive_catalog_${computeDeterminismHash(descriptors.map((descriptor) => descriptor.primitive_ref))}`,
      primitive_count: descriptors.length,
      primitive_names: freezeArray(descriptors.map((descriptor) => descriptor.primitive_name)),
      descriptors,
      family_summaries: buildFamilySummaries(descriptors),
      hidden_fields_removed: hiddenFieldsRemoved(),
      issues,
      ok: issues.every((issue) => issue.severity !== "error"),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Returns exactly one primitive descriptor by opaque reference.
   */
  public requirePrimitive(primitiveRef: Ref): ManipulationPrimitiveDescriptor {
    assertSafeRef(primitiveRef, "$.primitive_ref");
    const descriptor = this.descriptors.find((candidate) => candidate.primitive_ref === primitiveRef);
    if (descriptor === undefined) {
      throw new ManipulationPrimitiveCatalogError("Manipulation primitive is not registered.", [
        makeIssue("error", "PrimitiveMissing", "$.primitive_ref", `Primitive ${primitiveRef} is not registered.`, "Use a primitive_ref from ManipulationPrimitiveCatalog."),
      ]);
    }
    return descriptor;
  }

  /**
   * Validates a plan-approved primitive execution intent against the catalog.
   */
  public validateExecutionIntent(intent: PrimitiveExecutionIntent): PrimitiveExecutionIntentReport {
    const issues: ValidationIssue[] = [];
    validateIntentShape(intent, issues);
    const descriptor = this.descriptors.find((candidate) => candidate.primitive_ref === intent.selected_primitive_ref);
    if (descriptor === undefined) {
      issues.push(makeIssue("error", "PrimitiveMissing", "$.selected_primitive_ref", "Selected primitive is not registered.", "Choose a primitive from the File 12 catalog."));
    } else {
      validateIntentAgainstDescriptor(intent, descriptor, issues);
    }
    const missingSensors = descriptor === undefined ? freezeArray([]) : missingSensorEvidence(descriptor, intent);
    const missingFallback = descriptor === undefined ? freezeArray([]) : missingFallbackActions(descriptor, intent);
    const summary = descriptor === undefined
      ? "Manipulation intent rejected because selected primitive is not registered."
      : summarizeIntent(intent, descriptor, issues);
    const base = {
      schema_version: MANIPULATION_PRIMITIVE_CATALOG_SCHEMA_VERSION,
      intent_ref: sanitizeRef(intent.intent_ref),
      selected_primitive_ref: sanitizeRef(intent.selected_primitive_ref),
      primitive_name: descriptor?.primitive_name,
      admission_class: descriptor?.admission_class,
      accepted: issues.every((issue) => issue.severity !== "error"),
      control_phase_profile: descriptor?.control_phase_profile,
      missing_sensor_evidence: missingSensors,
      missing_fallback_actions: missingFallback,
      required_oops_handoff_fields: descriptor?.oops_handoff_fields ?? freezeArray([]),
      required_safety_stop_conditions: descriptor?.safety_stop_conditions ?? freezeArray([]),
      issues: freezeArray(issues),
      cognitive_safe_summary: sanitizeText(summary, "$.cognitive_safe_summary", issues),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }
}

export class ManipulationPrimitiveCatalogError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "ManipulationPrimitiveCatalogError";
    this.issues = issues;
  }
}

export function createManipulationPrimitiveCatalog(descriptors?: readonly ManipulationPrimitiveDescriptor[]): ManipulationPrimitiveCatalog {
  return new ManipulationPrimitiveCatalog(descriptors);
}

const DEFAULT_MANIPULATION_PRIMITIVES: readonly ManipulationPrimitiveDescriptor[] = freezeArray([
  primitive({
    primitive_name: "inspect_target",
    capability_primitive: "inspect",
    primitive_family: "observation",
    admission_class: "observation_only",
    embodiment_variants: ["quadruped", "humanoid"],
    required_end_effector_roles: ["mouth_gripper", "paw", "forelimb", "left_hand", "right_hand", "both_hands", "wrist", "tool_tip"],
    required_sensor_evidence: ["primary_view", "target_visibility", "proprioception"],
    target_frame_requirements: frames(false, false, false, "view_only", ["verification"]),
    preconditions: ["Target hypothesis exists or a search region is validated.", "Sensor health is acceptable for close or alternate view capture.", "Motion, if any, is admitted as observation-safe."],
    control_phase_profile: profile(["approach"], "free_space", "gain_observation_inspect", 0.35, "inspect_only", 0.2),
    postconditions: ["Target visibility is refreshed.", "Manipulation-relevant object geometry is summarized.", "Occlusion status is recorded."],
    verification_hook: "inspect_ready",
    failure_modes: ["target_lost", "sensor_occlusion", "timeout"],
    oops_handoff_fields: ["before_view_refs", "after_view_refs", "target_visibility_status", "occlusion_summary"],
    safety_stop_conditions: ["sensor stream lost", "unexpected contact", "safety envelope expired"],
    fallback_policy: ["alternate_view", "reobserve", "reposition"],
    cognitive_safe_summary: "Inspect target with sensor-derived views before manipulation.",
  }),
  primitive({
    primitive_name: "approach_target",
    capability_primitive: "approach",
    primitive_family: "approach",
    admission_class: "free_space_motion",
    embodiment_variants: ["quadruped", "humanoid"],
    required_end_effector_roles: ["mouth_gripper", "paw", "forelimb", "left_hand", "right_hand", "both_hands", "wrist"],
    required_sensor_evidence: ["primary_view", "target_visibility", "imu", "proprioception"],
    target_frame_requirements: frames(true, true, false, "coarse", ["object", "target", "end_effector"]),
    preconditions: ["Target estimate is approach-ready.", "Path clearance is available.", "Stance and safety envelope are stable."],
    control_phase_profile: profile(["approach"], "free_space", "gain_approach_free_space", 0.55, "gentle", 0.25),
    postconditions: ["Manipulator is inside the manipulation region.", "Target remains visible or explicitly tracked.", "No unexpected contact occurred."],
    verification_hook: "inspect_ready",
    failure_modes: ["target_lost", "path_blocked", "collision", "overshoot", "ik_infeasible", "sensor_occlusion"],
    oops_handoff_fields: ["path_telemetry", "before_after_views", "target_visibility_status", "collision_contact_events"],
    safety_stop_conditions: ["unexpected contact", "target lost", "stability margin critical", "timeout"],
    fallback_policy: ["reobserve", "reposition", "correct", "safe_hold"],
    cognitive_safe_summary: "Approach a target region through validated free-space control.",
  }),
  primitive({
    primitive_name: "align_end_effector",
    capability_primitive: "approach",
    primitive_family: "precontact",
    admission_class: "precontact_motion",
    embodiment_variants: ["quadruped", "humanoid"],
    required_end_effector_roles: ["mouth_gripper", "paw", "forelimb", "left_hand", "right_hand", "both_hands", "wrist", "tool_tip"],
    required_sensor_evidence: ["wrist_or_mouth_view", "target_visibility", "proprioception"],
    target_frame_requirements: frames(true, true, false, "contact", ["object", "target", "end_effector"]),
    preconditions: ["Target contact region is visible or estimated.", "IK feasibility and reach checks are accepted.", "Precontact speed cap is active."],
    control_phase_profile: profile(["pregrasp"], "precontact", "gain_precontact_alignment", 0.35, "cautious", 0.3, 0.06),
    postconditions: ["End effector is in contact-ready alignment.", "Contact has not begun unless expected.", "Pose residual is within precontact tolerance."],
    verification_hook: "contact_confirmed",
    failure_modes: ["target_lost", "path_blocked", "missed_contact", "collision", "ik_infeasible", "sensor_occlusion"],
    oops_handoff_fields: ["end_effector_pose_residual", "precontact_view_refs", "ik_report_ref", "contact_status"],
    safety_stop_conditions: ["unexpected contact force", "target frame stale", "pose residual diverges"],
    fallback_policy: ["alternate_view", "reobserve", "reposition", "correct"],
    cognitive_safe_summary: "Align an end effector to a validated precontact pose.",
  }),
  primitive({
    primitive_name: "grasp_object",
    capability_primitive: "grasp",
    primitive_family: "contact_acquisition",
    admission_class: "contact_motion",
    embodiment_variants: ["quadruped", "humanoid"],
    required_end_effector_roles: ["mouth_gripper", "forelimb", "left_hand", "right_hand", "both_hands"],
    required_sensor_evidence: ["wrist_or_mouth_view", "contact_sensor", "force_estimate", "target_visibility", "proprioception"],
    target_frame_requirements: frames(true, true, false, "grasp", ["object", "target", "end_effector"]),
    preconditions: ["Object hypothesis is current.", "Grasp target frame is valid.", "Grip force limit and contact monitor are configured."],
    control_phase_profile: profile(["pregrasp", "grasp"], "grasp", "gain_grasp_contact_ramp", 0.25, "cautious", 0.35, 0.035),
    postconditions: ["Object is held or controlled.", "Contact is stable through hysteresis.", "Grip force remains below safe limit."],
    verification_hook: "grasp_confirmed",
    failure_modes: ["missed_contact", "partial_grasp", "slip", "crush_risk", "drop", "sensor_occlusion", "actuator_saturation"],
    oops_handoff_fields: ["contact_timeline", "grip_force_summary", "wrist_or_mouth_view_refs", "object_motion_summary", "pose_residual"],
    safety_stop_conditions: ["crush risk", "force saturation", "unexpected object motion", "contact sensor conflict"],
    fallback_policy: ["alternate_grasp", "reduce_force", "correct", "safe_hold"],
    cognitive_safe_summary: "Acquire a controlled grasp with force ramp and contact confirmation.",
  }),
  primitive({
    primitive_name: "contact_push",
    capability_primitive: "push",
    primitive_family: "contact_acquisition",
    admission_class: "contact_motion",
    embodiment_variants: ["quadruped", "humanoid"],
    required_end_effector_roles: ["paw", "forelimb", "left_hand", "right_hand", "wrist", "tool_tip"],
    required_sensor_evidence: ["primary_view", "contact_sensor", "force_estimate", "target_visibility"],
    target_frame_requirements: frames(true, true, false, "contact", ["object", "target", "end_effector"]),
    preconditions: ["Object appears pushable.", "Push direction and stop condition are validated.", "Contact point is safe and visible."],
    control_phase_profile: profile(["tool_contact"], "tool_contact", "gain_contact_push_low_speed", 0.22, "tool_contact", 0.25, 0.04),
    postconditions: ["Pushing contact is established.", "Object motion begins in intended direction.", "Force remains bounded."],
    verification_hook: "contact_confirmed",
    failure_modes: ["missed_contact", "collision", "overshoot", "placement_residual", "tool_instability", "actuator_saturation"],
    oops_handoff_fields: ["contact_force_summary", "object_motion_direction", "before_after_views", "stop_condition_status"],
    safety_stop_conditions: ["force spike", "object moves wrong direction", "contact point lost"],
    fallback_policy: ["reduce_force", "correct", "reobserve", "safe_hold"],
    cognitive_safe_summary: "Establish controlled pushing contact without a grasp.",
  }),
  primitive({
    primitive_name: "lift_object",
    capability_primitive: "lift",
    primitive_family: "transport",
    admission_class: "load_bearing_motion",
    embodiment_variants: ["quadruped", "humanoid"],
    required_end_effector_roles: ["mouth_gripper", "forelimb", "left_hand", "right_hand", "both_hands"],
    required_sensor_evidence: ["contact_sensor", "force_estimate", "imu", "target_visibility", "proprioception"],
    target_frame_requirements: frames(true, true, false, "grasp", ["object", "target", "end_effector"]),
    preconditions: ["Grasp is confirmed.", "Load estimate is within actuator and stability limits.", "Lift path is clear."],
    control_phase_profile: profile(["lift"], "carry", "gain_lift_load_bearing", 0.22, "cautious", 0.45, 0.04),
    postconditions: ["Object follows the end effector.", "Load and balance remain stable.", "Lift test clears support enough for carry decision."],
    verification_hook: "lift_settled",
    failure_modes: ["slip", "drop", "stability_risk", "actuator_saturation", "collision", "oscillation"],
    oops_handoff_fields: ["lift_telemetry", "contact_stability", "imu_summary", "object_following_view"],
    safety_stop_conditions: ["contact loss", "balance risk", "load saturation", "object drop"],
    fallback_policy: ["reduce_force", "alternate_grasp", "safe_hold", "correct"],
    cognitive_safe_summary: "Lift a held object only after contact and stability confirmation.",
  }),
  primitive({
    primitive_name: "carry_object",
    capability_primitive: "carry",
    primitive_family: "transport",
    admission_class: "load_bearing_motion",
    embodiment_variants: ["quadruped", "humanoid"],
    required_end_effector_roles: ["mouth_gripper", "forelimb", "left_hand", "right_hand", "both_hands"],
    required_sensor_evidence: ["contact_sensor", "force_estimate", "imu", "target_visibility", "proprioception"],
    target_frame_requirements: frames(true, true, false, "coarse", ["object", "target", "end_effector"]),
    preconditions: ["Object is held and lift-settled.", "Carry path is clear.", "Grip and balance margins are acceptable."],
    control_phase_profile: profile(["carry"], "carry", "gain_carry_stability_aware", 0.28, "cautious", 0.45, 0.05),
    postconditions: ["Object remains held through transport.", "Manipulator reaches placement region.", "No slip, drop, or collision occurs."],
    verification_hook: "carry_stable",
    failure_modes: ["slip", "drop", "collision", "stability_risk", "oscillation", "sensor_occlusion"],
    oops_handoff_fields: ["carry_path_telemetry", "contact_history", "imu_summary", "object_visibility_history"],
    safety_stop_conditions: ["slip threshold crossed", "collision detected", "balance margin critical"],
    fallback_policy: ["safe_hold", "correct", "reposition", "alternate_view"],
    cognitive_safe_summary: "Carry a held object with continuous grip and balance monitoring.",
  }),
  primitive({
    primitive_name: "place_object",
    capability_primitive: "place",
    primitive_family: "placement",
    admission_class: "verification_sensitive_motion",
    embodiment_variants: ["quadruped", "humanoid"],
    required_end_effector_roles: ["mouth_gripper", "forelimb", "left_hand", "right_hand", "both_hands", "tool_tip"],
    required_sensor_evidence: ["primary_view", "side_view", "contact_sensor", "target_visibility", "verification_view"],
    target_frame_requirements: frames(true, true, false, "placement", ["object", "target", "support", "verification"]),
    preconditions: ["Object is held.", "Placement tolerance and support frame are current.", "Descent path and settle view are clear."],
    control_phase_profile: profile(["place"], "placement", "gain_place_descent_damped", 0.18, "gentle", 0.55, 0.03),
    postconditions: ["Object is within placement candidate tolerance.", "Support or contact evidence is present.", "Placement is ready for release or verification."],
    verification_hook: "placement_candidate",
    failure_modes: ["placement_residual", "collision", "drop", "sensor_occlusion", "overshoot", "actuator_saturation"],
    oops_handoff_fields: ["placement_views", "descent_telemetry", "contact_event_refs", "residual_hints", "occlusion_status"],
    safety_stop_conditions: ["rim collision", "support missing", "object starts falling", "residual diverges"],
    fallback_policy: ["correct", "alternate_view", "safe_hold", "reobserve"],
    cognitive_safe_summary: "Place a held object into a validated target relation with settle evidence.",
  }),
  primitive({
    primitive_name: "release_object",
    capability_primitive: "release",
    primitive_family: "release",
    admission_class: "verification_sensitive_motion",
    embodiment_variants: ["quadruped", "humanoid"],
    required_end_effector_roles: ["mouth_gripper", "forelimb", "left_hand", "right_hand", "both_hands", "tool_tip"],
    required_sensor_evidence: ["contact_sensor", "target_visibility", "verification_view", "proprioception"],
    target_frame_requirements: frames(true, true, false, "placement", ["object", "target", "support", "end_effector"]),
    preconditions: ["Placement candidate is reached.", "Support contact is plausible.", "Release and retreat paths are clear."],
    control_phase_profile: profile(["release"], "placement", "gain_release_force_ramp", 0.16, "release", 0.6, 0.025),
    postconditions: ["Hold is removed without dragging target.", "Object remains in place.", "End effector can retreat safely."],
    verification_hook: "release_settled",
    failure_modes: ["drop", "slip", "placement_residual", "sensor_occlusion", "tool_frame_stale"],
    oops_handoff_fields: ["release_contact_timeline", "after_release_view", "object_settle_status", "residual_estimate"],
    safety_stop_conditions: ["object follows gripper", "object tips", "support contact lost"],
    fallback_policy: ["safe_hold", "correct", "alternate_view"],
    cognitive_safe_summary: "Release an object gradually and preserve placement evidence.",
  }),
  primitive({
    primitive_name: "retreat_end_effector",
    capability_primitive: "retreat",
    primitive_family: "post_action",
    admission_class: "free_space_motion",
    embodiment_variants: ["quadruped", "humanoid"],
    required_end_effector_roles: ["mouth_gripper", "paw", "forelimb", "left_hand", "right_hand", "both_hands", "wrist", "tool_tip"],
    required_sensor_evidence: ["target_visibility", "proprioception", "verification_view"],
    target_frame_requirements: frames(false, true, false, "coarse", ["target", "end_effector", "verification"]),
    preconditions: ["Release is complete or intentional contact remains validated.", "Retreat vector has clearance.", "Verification view can open."],
    control_phase_profile: profile(["retreat"], "free_space", "gain_retreat_clearance", 0.35, "retreat", 0.25),
    postconditions: ["End effector is clear of target region.", "Verification view is unobstructed.", "No post-action contact worsened the result."],
    verification_hook: "retreat_clear",
    failure_modes: ["collision", "placement_residual", "sensor_occlusion", "target_lost"],
    oops_handoff_fields: ["retreat_telemetry", "after_retreat_view", "contact_change_summary", "residual_change"],
    safety_stop_conditions: ["contact returns", "object moves", "camera remains blocked"],
    fallback_policy: ["correct", "alternate_view", "safe_hold"],
    cognitive_safe_summary: "Retreat the end effector without disturbing the manipulated object.",
  }),
  primitive({
    primitive_name: "push_object",
    capability_primitive: "push",
    primitive_family: "non_grasp_contact",
    admission_class: "contact_motion",
    embodiment_variants: ["quadruped", "humanoid"],
    required_end_effector_roles: ["paw", "forelimb", "left_hand", "right_hand", "wrist", "tool_tip"],
    required_sensor_evidence: ["primary_view", "contact_sensor", "force_estimate", "target_visibility"],
    target_frame_requirements: frames(true, true, false, "contact", ["object", "target", "end_effector"]),
    preconditions: ["Object is pushable and not fragile.", "Path is clear.", "Low-speed contact profile is active."],
    control_phase_profile: profile(["tool_contact"], "tool_contact", "gain_push_slide_contact", 0.2, "tool_contact", 0.35, 0.035),
    postconditions: ["Object moves along intended surface direction.", "Contact remains controlled.", "Stop condition is evaluated."],
    verification_hook: "tool_effect_verified",
    failure_modes: ["overshoot", "collision", "placement_residual", "tool_instability", "actuator_saturation"],
    oops_handoff_fields: ["push_before_after_views", "force_summary", "surface_motion_residual", "contact_timeline"],
    safety_stop_conditions: ["force spike", "object rotates unexpectedly", "path collision"],
    fallback_policy: ["reduce_force", "correct", "safe_hold", "reobserve"],
    cognitive_safe_summary: "Push an object along a validated surface path with bounded contact force.",
  }),
  primitive({
    primitive_name: "pull_object",
    capability_primitive: "pull",
    primitive_family: "non_grasp_contact",
    admission_class: "contact_motion",
    embodiment_variants: ["quadruped", "humanoid"],
    required_end_effector_roles: ["mouth_gripper", "forelimb", "left_hand", "right_hand", "tool_tip"],
    required_sensor_evidence: ["primary_view", "contact_sensor", "force_estimate", "target_visibility"],
    target_frame_requirements: frames(true, true, false, "contact", ["object", "target", "end_effector"]),
    preconditions: ["Pull contact or hook contact is stable.", "Pull path is clear.", "Snag and jump risks are bounded."],
    control_phase_profile: profile(["tool_contact"], "tool_contact", "gain_pull_contact_conservative", 0.18, "tool_contact", 0.4, 0.03),
    postconditions: ["Object moves toward the intended region.", "Contact remains stable.", "No snag or uncontrolled jump occurs."],
    verification_hook: "tool_effect_verified",
    failure_modes: ["slip", "tool_instability", "collision", "overshoot", "drop"],
    oops_handoff_fields: ["pull_contact_summary", "object_motion_summary", "tool_or_effector_view", "force_history"],
    safety_stop_conditions: ["snag detected", "object jumps", "contact lost"],
    fallback_policy: ["reduce_force", "alternate_grasp", "correct", "safe_hold"],
    cognitive_safe_summary: "Pull an object only with validated contact and conservative force.",
  }),
  primitive({
    primitive_name: "slide_object",
    capability_primitive: "push",
    primitive_family: "non_grasp_contact",
    admission_class: "verification_sensitive_motion",
    embodiment_variants: ["quadruped", "humanoid"],
    required_end_effector_roles: ["paw", "forelimb", "left_hand", "right_hand", "wrist", "tool_tip"],
    required_sensor_evidence: ["primary_view", "side_view", "contact_sensor", "force_estimate", "verification_view"],
    target_frame_requirements: frames(true, true, false, "placement", ["object", "target", "support", "verification"]),
    preconditions: ["Surface support is plausible.", "Residual direction is known.", "Object is stable enough for low-force sliding."],
    control_phase_profile: profile(["tool_contact"], "placement", "gain_slide_to_position", 0.14, "gentle", 0.45, 0.025),
    postconditions: ["Object residual decreases.", "Object remains supported.", "Verification view is available."],
    verification_hook: "placement_candidate",
    failure_modes: ["placement_residual", "collision", "overshoot", "tool_instability", "sensor_occlusion"],
    oops_handoff_fields: ["slide_before_after_views", "residual_direction", "contact_force_summary", "support_status"],
    safety_stop_conditions: ["residual worsens", "object tips", "support lost"],
    fallback_policy: ["correct", "reduce_force", "alternate_view", "safe_hold"],
    cognitive_safe_summary: "Slide a supported object for fine alignment under verification-sensitive control.",
  }),
  primitive({
    primitive_name: "pin_object",
    capability_primitive: "push",
    primitive_family: "non_grasp_contact",
    admission_class: "contact_motion",
    embodiment_variants: ["quadruped", "humanoid"],
    required_end_effector_roles: ["paw", "forelimb", "left_hand", "right_hand", "wrist"],
    required_sensor_evidence: ["primary_view", "contact_sensor", "force_estimate", "imu"],
    target_frame_requirements: frames(true, true, false, "contact", ["object", "target", "end_effector"]),
    preconditions: ["Pin contact point is safe.", "Force is bounded below crush threshold.", "Stance remains stable."],
    control_phase_profile: profile(["tool_contact"], "contact", "gain_pin_object_contact", 0.12, "cautious", 0.5, 0.02),
    postconditions: ["Object is stabilized without crushing.", "Contact remains at intended point.", "Next grasp or tool action can proceed."],
    verification_hook: "contact_confirmed",
    failure_modes: ["crush_risk", "slip", "collision", "stability_risk", "sensor_occlusion"],
    oops_handoff_fields: ["pin_force_summary", "contact_point_view", "object_motion_summary", "stability_status"],
    safety_stop_conditions: ["crush risk", "slip", "balance margin low"],
    fallback_policy: ["reduce_force", "alternate_grasp", "safe_hold"],
    cognitive_safe_summary: "Pin an object with bounded force before a follow-up manipulation action.",
  }),
  primitive({
    primitive_name: "nudge_object",
    capability_primitive: "push",
    primitive_family: "non_grasp_contact",
    admission_class: "verification_sensitive_motion",
    embodiment_variants: ["quadruped", "humanoid"],
    required_end_effector_roles: ["paw", "forelimb", "left_hand", "right_hand", "wrist", "tool_tip"],
    required_sensor_evidence: ["verification_view", "contact_sensor", "force_estimate", "target_visibility"],
    target_frame_requirements: frames(true, true, false, "placement", ["object", "target", "verification"]),
    preconditions: ["Placement residual is measured.", "Nudge direction is validated.", "Low-force stop-on-movement profile is active."],
    control_phase_profile: profile(["tool_contact"], "placement", "gain_nudge_residual_correction", 0.1, "gentle", 0.4, 0.02),
    postconditions: ["Residual improves or motion stops early.", "Object remains stable.", "Verification is triggered."],
    verification_hook: "placement_candidate",
    failure_modes: ["placement_residual", "overshoot", "collision", "tool_instability"],
    oops_handoff_fields: ["residual_before_after", "nudge_direction", "force_summary", "verification_view_refs"],
    safety_stop_conditions: ["residual worsens", "object leaves support", "force spike"],
    fallback_policy: ["correct", "alternate_view", "safe_hold", "human_review"],
    cognitive_safe_summary: "Nudge an object only to reduce a measured placement residual.",
  }),
  primitive({
    primitive_name: "acquire_tool",
    capability_primitive: "tool_use",
    primitive_family: "tool_acquisition",
    admission_class: "tool_motion",
    embodiment_variants: ["quadruped", "humanoid"],
    required_end_effector_roles: ["mouth_gripper", "paw", "forelimb", "left_hand", "right_hand", "both_hands"],
    required_sensor_evidence: ["primary_view", "side_view", "wrist_or_mouth_view", "contact_sensor", "force_estimate"],
    target_frame_requirements: frames(true, true, true, "tool_tip", ["object", "target", "tool", "end_effector"]),
    preconditions: ["Tool candidate is visible.", "Tool affordance is plausible.", "Pickup swept volume and compatibility are validated."],
    control_phase_profile: profile(["pregrasp", "grasp", "lift"], "grasp", "gain_tool_acquisition", 0.2, "cautious", 0.55, 0.03),
    postconditions: ["Tool frame is task-scoped and current.", "Attachment is stable.", "Effective reach envelope can be updated."],
    verification_hook: "grasp_confirmed",
    failure_modes: ["missed_contact", "slip", "drop", "tool_instability", "sensor_occlusion", "tool_frame_stale"],
    oops_handoff_fields: ["tool_views", "attachment_contact_summary", "tool_tip_estimate", "occlusion_report"],
    safety_stop_conditions: ["tool slips", "camera fully occluded", "attachment unstable", "tool too heavy"],
    fallback_policy: ["validate_tool", "alternate_grasp", "reobserve", "safe_hold"],
    cognitive_safe_summary: "Acquire a visible validated tool and create a task-scoped tool frame.",
  }),
  primitive({
    primitive_name: "use_tool",
    capability_primitive: "tool_use",
    primitive_family: "tool_action",
    admission_class: "tool_motion",
    embodiment_variants: ["quadruped", "humanoid"],
    required_end_effector_roles: ["mouth_gripper", "forelimb", "left_hand", "right_hand", "both_hands", "tool_tip"],
    required_sensor_evidence: ["tool_tip_view", "target_visibility", "contact_sensor", "force_estimate", "verification_view"],
    target_frame_requirements: frames(true, true, true, "tool_tip", ["object", "target", "tool", "verification"]),
    preconditions: ["Tool frame is current.", "Target and tool relation is visible or estimated.", "Swept volume and release plan are validated."],
    control_phase_profile: profile(["tool_contact"], "tool_contact", "gain_tool_contact_conservative", 0.12, "tool_contact", 0.5, 0.02),
    postconditions: ["Tool effect is bounded and observable.", "Attachment remains stable.", "Target movement is verified or stopped."],
    verification_hook: "tool_effect_verified",
    failure_modes: ["tool_instability", "collision", "placement_residual", "sensor_occlusion", "target_lost", "tool_frame_stale"],
    oops_handoff_fields: ["tool_tip_telemetry", "target_movement_summary", "contact_effort_summary", "before_after_views", "occlusion_status"],
    safety_stop_conditions: ["tool deflects", "swept-volume collision", "attachment loss", "target knocked away"],
    fallback_policy: ["reduce_force", "validate_tool", "correct", "safe_hold"],
    cognitive_safe_summary: "Use a task-scoped tool with conservative contact and continuous verification evidence.",
  }),
  primitive({
    primitive_name: "safe_hold_manipulation",
    capability_primitive: "retreat",
    primitive_family: "safety",
    admission_class: "safety_motion",
    embodiment_variants: ["quadruped", "humanoid"],
    required_end_effector_roles: ["mouth_gripper", "paw", "forelimb", "left_hand", "right_hand", "both_hands", "wrist", "tool_tip"],
    required_sensor_evidence: ["contact_sensor", "imu", "proprioception", "target_visibility"],
    target_frame_requirements: frames(false, false, false, "safe_hold", ["end_effector"]),
    preconditions: ["Safety event or operator pause is active.", "Current posture and held-object state are summarized.", "No new task motion is admitted."],
    control_phase_profile: profile(["safe_hold"], "safe_hold", "gain_safe_hold_manipulation", 0.05, "hold", 0.8),
    postconditions: ["Task motion is frozen or stabilized.", "Held object is lowered, held, released, or reviewed according to safety policy.", "Correction evidence is preserved."],
    verification_hook: "safe_hold_stable",
    failure_modes: ["stability_risk", "drop", "tool_instability", "sensor_occlusion", "timeout"],
    oops_handoff_fields: ["safe_hold_reason", "current_contact_state", "imu_summary", "held_object_status", "operator_or_safety_ref"],
    safety_stop_conditions: ["critical safety event persists", "object state unknown", "safe release unavailable"],
    fallback_policy: ["safe_hold", "human_review", "reobserve"],
    cognitive_safe_summary: "Stop task motion and stabilize manipulation state under safety authority.",
  }),
]);

function primitive(input: Omit<ManipulationPrimitiveDescriptor, "schema_version" | "primitive_ref" | "determinism_hash">): ManipulationPrimitiveDescriptor {
  const primitiveRef = `primitive_${input.primitive_name}`;
  const base = {
    schema_version: MANIPULATION_PRIMITIVE_CATALOG_SCHEMA_VERSION,
    primitive_ref: primitiveRef,
    ...input,
    embodiment_variants: freezeArray(input.embodiment_variants),
    required_end_effector_roles: freezeArray(input.required_end_effector_roles),
    required_sensor_evidence: freezeArray(input.required_sensor_evidence),
    preconditions: freezeArray(input.preconditions.map((text) => sanitizeLiteral(text))),
    postconditions: freezeArray(input.postconditions.map((text) => sanitizeLiteral(text))),
    failure_modes: freezeArray(input.failure_modes),
    oops_handoff_fields: freezeArray(input.oops_handoff_fields.map((text) => sanitizeLiteral(text))),
    safety_stop_conditions: freezeArray(input.safety_stop_conditions.map((text) => sanitizeLiteral(text))),
    fallback_policy: freezeArray(input.fallback_policy),
    cognitive_safe_summary: sanitizeLiteral(input.cognitive_safe_summary),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function profile(
  phases: readonly PrimitivePhase[],
  contactMode: ContactMode,
  gainFamilyRef: Ref,
  speedScale: number,
  forceProfile: ManipulationControlPhaseProfile["force_profile"],
  settleWindowS: number,
  maxContactVelocityMS?: number,
): ManipulationControlPhaseProfile {
  return Object.freeze({
    phases: freezeArray(phases),
    contact_mode: contactMode,
    gain_family_ref: gainFamilyRef,
    speed_scale: round6(Math.max(0, Math.min(1, speedScale))),
    max_contact_velocity_m_s: maxContactVelocityMS === undefined ? undefined : round6(maxContactVelocityMS),
    force_profile: forceProfile,
    settle_window_s: round6(settleWindowS),
  });
}

function frames(
  requiresSubjectObject: boolean,
  requiresTargetFrame: boolean,
  requiresToolFrame: boolean,
  toleranceClass: ManipulationTargetFrameRequirement["tolerance_class"],
  roles: readonly ManipulationTargetFrameRequirement["required_frame_roles"][number][],
): ManipulationTargetFrameRequirement {
  return Object.freeze({
    requires_subject_object: requiresSubjectObject,
    requires_target_frame: requiresTargetFrame,
    requires_tool_frame: requiresToolFrame,
    tolerance_class: toleranceClass,
    required_frame_roles: freezeArray(roles),
  });
}

function validateCatalog(descriptors: readonly ManipulationPrimitiveDescriptor[]): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const refs = new Set<Ref>();
  const names = new Set<ManipulationPrimitiveName>();
  for (const descriptor of descriptors) {
    if (refs.has(descriptor.primitive_ref)) {
      issues.push(makeIssue("error", "PrimitiveDuplicated", "$.descriptors.primitive_ref", `Duplicate primitive ref ${descriptor.primitive_ref}.`, "Primitive refs must be unique."));
    }
    if (names.has(descriptor.primitive_name)) {
      issues.push(makeIssue("error", "PrimitiveDuplicated", "$.descriptors.primitive_name", `Duplicate primitive name ${descriptor.primitive_name}.`, "Primitive names must be unique."));
    }
    refs.add(descriptor.primitive_ref);
    names.add(descriptor.primitive_name);
    validateDescriptor(descriptor, issues);
  }
  return freezeArray(issues);
}

function validateDescriptor(descriptor: ManipulationPrimitiveDescriptor, issues: ValidationIssue[]): void {
  validateSafeRef(descriptor.primitive_ref, "$.primitive_ref", issues);
  validateSafeRef(descriptor.control_phase_profile.gain_family_ref, "$.control_phase_profile.gain_family_ref", issues);
  if (descriptor.embodiment_variants.length === 0) {
    issues.push(makeIssue("error", "PrimitiveUnsupportedForEmbodiment", descriptor.primitive_ref, "Primitive has no embodiment variants.", "Declare quadruped, humanoid, or both."));
  }
  if (descriptor.required_end_effector_roles.length === 0) {
    issues.push(makeIssue("error", "PrimitiveUnsupportedForEffector", descriptor.primitive_ref, "Primitive has no supported end-effector roles.", "Declare at least one body interface."));
  }
  if (descriptor.required_sensor_evidence.length === 0) {
    issues.push(makeIssue("warning", "SensorEvidenceMissing", descriptor.primitive_ref, "Primitive has no required sensor evidence.", "Require at least one visual, contact, IMU, or proprioceptive evidence class."));
  }
  for (const text of [
    ...descriptor.preconditions,
    ...descriptor.postconditions,
    ...descriptor.oops_handoff_fields,
    ...descriptor.safety_stop_conditions,
    descriptor.cognitive_safe_summary,
  ]) {
    if (HIDDEN_PRIMITIVE_PATTERN.test(text)) {
      issues.push(makeIssue("error", "HiddenPrimitiveLeak", descriptor.primitive_ref, "Primitive descriptor contains forbidden hidden detail.", "Remove simulator, backend, QA, or direct actuator wording."));
    }
  }
}

function validateIntentShape(intent: PrimitiveExecutionIntent, issues: ValidationIssue[]): void {
  validateSafeRef(intent.intent_ref, "$.intent_ref", issues);
  validateSafeRef(intent.source_plan_ref, "$.source_plan_ref", issues);
  validateSafeRef(intent.control_work_order_ref, "$.control_work_order_ref", issues);
  validateSafeRef(intent.selected_primitive_ref, "$.selected_primitive_ref", issues);
  validateSafeRef(intent.validation_decision_ref, "$.validation_decision_ref", issues);
  if (intent.subject_object_ref !== undefined) validateSafeRef(intent.subject_object_ref, "$.subject_object_ref", issues);
  if (intent.target_frame_ref !== undefined) validateSafeRef(intent.target_frame_ref, "$.target_frame_ref", issues);
  if (intent.tool_frame_ref !== undefined) validateSafeRef(intent.tool_frame_ref, "$.tool_frame_ref", issues);
  if (intent.success_condition.trim().length === 0) {
    issues.push(makeIssue("error", "SuccessConditionMissing", "$.success_condition", "Primitive intent requires an observable success condition.", "Attach a postcondition or verification path."));
  }
  if (intent.fallback_policy.length === 0) {
    issues.push(makeIssue("error", "FallbackPolicyMissing", "$.fallback_policy", "Primitive intent requires fallback actions.", "Attach reobserve, alternate grasp, reposition, Correct, or SafeHold fallback."));
  }
}

function validateIntentAgainstDescriptor(intent: PrimitiveExecutionIntent, descriptor: ManipulationPrimitiveDescriptor, issues: ValidationIssue[]): void {
  if (!descriptor.embodiment_variants.includes(intent.embodiment_kind)) {
    issues.push(makeIssue("error", "PrimitiveUnsupportedForEmbodiment", "$.embodiment_kind", `${descriptor.primitive_name} does not support ${intent.embodiment_kind}.`, "Select a primitive variant declared for this embodiment."));
  }
  if (!descriptor.required_end_effector_roles.includes(intent.end_effector_role)) {
    issues.push(makeIssue("error", "PrimitiveUnsupportedForEffector", "$.end_effector_role", `${descriptor.primitive_name} does not support ${intent.end_effector_role}.`, "Select a supported end effector or primitive."));
  }
  if (descriptor.target_frame_requirements.requires_subject_object && intent.subject_object_ref === undefined) {
    issues.push(makeIssue("error", "SubjectObjectMissing", "$.subject_object_ref", "Primitive requires a current subject object reference.", "Bind the primitive to a current object hypothesis or memory/current target."));
  }
  if (descriptor.target_frame_requirements.requires_target_frame && intent.target_frame_ref === undefined) {
    issues.push(makeIssue("error", "TargetFrameMissing", "$.target_frame_ref", "Primitive requires a validated target frame.", "Attach a File 10 target or placement frame."));
  }
  if (descriptor.target_frame_requirements.requires_tool_frame && intent.tool_frame_ref === undefined) {
    issues.push(makeIssue("error", "ToolFrameMissing", "$.tool_frame_ref", "Primitive requires a current task-scoped tool frame.", "Validate or create the tool frame before tool primitive execution."));
  }
  const missingSensors = missingSensorEvidence(descriptor, intent);
  if (missingSensors.length > 0) {
    issues.push(makeIssue("warning", "SensorEvidenceMissing", "$.available_sensor_evidence", `Missing evidence: ${missingSensors.join(", ")}.`, "Collect required visual, contact, IMU, force, or verification evidence before execution."));
  }
  const missingFallbacks = missingFallbackActions(descriptor, intent);
  if (missingFallbacks.length > 0) {
    issues.push(makeIssue("warning", "FallbackPolicyMissing", "$.fallback_policy", `Fallback policy omits recommended actions: ${missingFallbacks.join(", ")}.`, "Include primitive-specific fallback actions to avoid repeated failed attempts."));
  }
  if (!contactExpectationAllowed(intent.contact_expectation, descriptor)) {
    issues.push(makeIssue("error", "ContactExpectationMismatch", "$.contact_expectation", `Contact expectation ${intent.contact_expectation} does not match ${descriptor.admission_class}.`, "Use the contact expectation associated with the selected primitive."));
  }
}

function missingSensorEvidence(descriptor: ManipulationPrimitiveDescriptor, intent: PrimitiveExecutionIntent): readonly ManipulationSensorEvidence[] {
  return freezeArray(descriptor.required_sensor_evidence.filter((evidence) => !intent.available_sensor_evidence.includes(evidence)));
}

function missingFallbackActions(descriptor: ManipulationPrimitiveDescriptor, intent: PrimitiveExecutionIntent): readonly ManipulationFallbackAction[] {
  return freezeArray(descriptor.fallback_policy.filter((action) => !intent.fallback_policy.includes(action)));
}

function contactExpectationAllowed(expectation: ManipulationContactExpectation, descriptor: ManipulationPrimitiveDescriptor): boolean {
  if (descriptor.admission_class === "observation_only" || descriptor.admission_class === "free_space_motion" || descriptor.primitive_family === "post_action") {
    return expectation === "no_contact" || expectation === "release_contact";
  }
  if (descriptor.admission_class === "precontact_motion") {
    return expectation === "no_contact" || expectation === "expected_contact";
  }
  if (descriptor.primitive_family === "contact_acquisition") {
    return expectation === "expected_contact" || expectation === "grip" || expectation === "tool_contact";
  }
  if (descriptor.admission_class === "load_bearing_motion") {
    return expectation === "grip" || expectation === "support";
  }
  if (descriptor.admission_class === "verification_sensitive_motion") {
    return expectation === "grip" || expectation === "support" || expectation === "release_contact" || expectation === "tool_contact";
  }
  if (descriptor.admission_class === "tool_motion") {
    return expectation === "tool_contact" || expectation === "grip" || expectation === "expected_contact";
  }
  return expectation === "safe_hold_contact" || expectation === "grip" || expectation === "support";
}

function matchesQuery(descriptor: ManipulationPrimitiveDescriptor, query: ManipulationPrimitiveCatalogQuery): boolean {
  return (query.embodiment_kind === undefined || descriptor.embodiment_variants.includes(query.embodiment_kind))
    && (query.end_effector_role === undefined || descriptor.required_end_effector_roles.includes(query.end_effector_role))
    && (query.primitive_name === undefined || descriptor.primitive_name === query.primitive_name)
    && (query.capability_primitive === undefined || descriptor.capability_primitive === query.capability_primitive)
    && (query.admission_class === undefined || descriptor.admission_class === query.admission_class)
    && (query.verification_hook === undefined || descriptor.verification_hook === query.verification_hook);
}

function buildFamilySummaries(descriptors: readonly ManipulationPrimitiveDescriptor[]): readonly ManipulationPrimitiveFamilySummary[] {
  const families = new Map<ManipulationPrimitiveFamily, ManipulationPrimitiveDescriptor[]>();
  for (const descriptor of descriptors) {
    families.set(descriptor.primitive_family, [...(families.get(descriptor.primitive_family) ?? []), descriptor]);
  }
  return freezeArray([...families.entries()]
    .map(([family, items]) => Object.freeze({
      primitive_family: family,
      primitive_count: items.length,
      primitive_names: freezeArray(items.map((item) => item.primitive_name).sort()),
      admission_classes: freezeArray([...new Set(items.map((item) => item.admission_class))].sort()),
      embodiment_variants: freezeArray([...new Set(items.flatMap((item) => item.embodiment_variants))].sort()),
    }))
    .sort((a, b) => a.primitive_family.localeCompare(b.primitive_family)));
}

function summarizeIntent(intent: PrimitiveExecutionIntent, descriptor: ManipulationPrimitiveDescriptor, issues: readonly ValidationIssue[]): string {
  const status = issues.some((issue) => issue.severity === "error") ? "rejected" : "accepted";
  return `${descriptor.primitive_name} ${status} for ${intent.embodiment_kind}/${intent.end_effector_role}; phase ${descriptor.control_phase_profile.phases.join("+")}; contact ${descriptor.control_phase_profile.contact_mode}; verification ${descriptor.verification_hook}.`;
}

function freezeDescriptor(descriptor: ManipulationPrimitiveDescriptor): ManipulationPrimitiveDescriptor {
  return Object.freeze({
    ...descriptor,
    embodiment_variants: freezeArray(descriptor.embodiment_variants),
    required_end_effector_roles: freezeArray(descriptor.required_end_effector_roles),
    required_sensor_evidence: freezeArray(descriptor.required_sensor_evidence),
    target_frame_requirements: Object.freeze({
      ...descriptor.target_frame_requirements,
      required_frame_roles: freezeArray(descriptor.target_frame_requirements.required_frame_roles),
    }),
    preconditions: freezeArray(descriptor.preconditions),
    control_phase_profile: Object.freeze({
      ...descriptor.control_phase_profile,
      phases: freezeArray(descriptor.control_phase_profile.phases),
    }),
    postconditions: freezeArray(descriptor.postconditions),
    failure_modes: freezeArray(descriptor.failure_modes),
    oops_handoff_fields: freezeArray(descriptor.oops_handoff_fields),
    safety_stop_conditions: freezeArray(descriptor.safety_stop_conditions),
    fallback_policy: freezeArray(descriptor.fallback_policy),
  });
}

function validateSafeRef(ref: Ref, path: string, issues: ValidationIssue[]): void {
  if (ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(makeIssue("error", "HiddenPrimitiveLeak", path, "Reference must be a non-empty whitespace-free string.", "Use opaque sanitized primitive references."));
    return;
  }
  if (HIDDEN_PRIMITIVE_PATTERN.test(ref)) {
    issues.push(makeIssue("error", "HiddenPrimitiveLeak", path, "Reference contains hidden simulator, backend, QA, or direct actuator detail.", "Use opaque primitive, frame, plan, or evidence references."));
  }
}

function assertSafeRef(ref: Ref, path: string): void {
  const issues: ValidationIssue[] = [];
  validateSafeRef(ref, path, issues);
  if (issues.length > 0) {
    throw new ManipulationPrimitiveCatalogError("Unsafe manipulation primitive reference.", issues);
  }
}

function sanitizeText(text: string, path: string, issues: ValidationIssue[]): string {
  const sanitized = sanitizeLiteral(text);
  if (HIDDEN_PRIMITIVE_PATTERN.test(text)) {
    issues.push(makeIssue("error", "HiddenPrimitiveLeak", path, "Text contains hidden simulator, backend, QA, or direct actuator detail.", "Remove forbidden implementation detail from primitive-facing text."));
  }
  return sanitized;
}

function sanitizeLiteral(text: string): string {
  return text.replace(HIDDEN_PRIMITIVE_PATTERN, "hidden-detail").replace(/\s+/g, " ").trim();
}

function sanitizeRef(ref: Ref): Ref {
  return ref.replace(HIDDEN_PRIMITIVE_PATTERN, "hidden-detail").trim();
}

function hiddenFieldsRemoved(): readonly string[] {
  return freezeArray(["simulator_world_frame_W", "backend_body_handles", "engine_joint_handles", "collision_mesh_refs", "qa_truth_labels", "direct_actuator_commands"]);
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

function makeIssue(
  severity: ValidationSeverity,
  code: ManipulationPrimitiveIssueCode,
  path: string,
  message: string,
  remediation: string,
): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}
