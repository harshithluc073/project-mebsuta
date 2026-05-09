/**
 * Geometry convention registry for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md`
 * sections 10.1 through 10.5, 10.9, 10.14, 10.16, and 10.17.
 *
 * This registry establishes the executable File 10 contract for canonical
 * units, frame symbols, axis handedness, image coordinate conventions,
 * tolerance classes, and the `W` versus `W_hat` truth boundary before any
 * frame graph, spatial estimate, residual, or controller handoff service
 * consumes geometry.
 */

import {
  CANONICAL_UNITS,
  computeDeterminismHash,
  createCanonicalCoordinateConvention,
} from "../simulation/world_manifest";
import type {
  Axis,
  CoordinateConvention,
  Handedness,
  Ref,
  SignedAxis,
  ValidationIssue,
  ValidationSeverity,
  Vector3,
} from "../simulation/world_manifest";

export const GEOMETRY_CONVENTION_REGISTRY_SCHEMA_VERSION = "mebsuta.geometry_convention_registry.v1" as const;

const HIDDEN_GEOMETRY_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|qa_success|qa_label|qa_only|simulator truth|mesh_name|asset_id)/i;

export type GeometryFrameSymbol = "W" | "W_hat" | "B" | "T" | "H" | "S_i" | "E_i" | "C_i" | "O_j" | "T_k" | "U_i" | "Q_i";
export type GeometryFrameClass =
  | "simulator_world"
  | "agent_estimated_world"
  | "base"
  | "torso_or_head"
  | "sensor"
  | "end_effector"
  | "contact"
  | "object"
  | "target"
  | "tool"
  | "qa_truth";
export type GeometryCognitiveVisibility = "forbidden" | "allowed_with_uncertainty" | "self_state" | "declared_calibration" | "task_scoped" | "audit_only";
export type ImageCoordinateConvention = "normalized_0_1000" | "pixel_image";
export type GeometryToleranceClass =
  | "coarse_search"
  | "approach"
  | "grasp_candidate"
  | "placement_standard"
  | "placement_precise"
  | "verification_visual"
  | "safety_clearance";
export type GeometryConventionDecision = "registered" | "registered_with_warnings" | "rejected";
export type GeometryConventionRecommendedAction = "use_convention_profile" | "repair_axis_metadata" | "repair_units" | "repair_truth_boundary" | "safe_hold" | "human_review";
export type GeometryConventionIssueCode =
  | "CanonicalUnitsInvalid"
  | "WorldFrameInvalid"
  | "EstimatedWorldFrameInvalid"
  | "HandednessInvalid"
  | "AxisInvalid"
  | "AxisNotOrthogonal"
  | "AxisHandednessMismatch"
  | "FramePolicyMissing"
  | "TruthFrameCognitiveLeak"
  | "ToleranceProfileInvalid"
  | "ImageConventionInvalid"
  | "HiddenGeometryLeak"
  | "ProfileRefInvalid"
  | "NoToleranceProfiles";

/**
 * Registry policy for File 10 convention creation and validation.
 */
export interface GeometryConventionRegistryPolicy {
  readonly default_handedness?: Handedness;
  readonly default_up_axis?: Axis;
  readonly default_forward_axis?: SignedAxis;
  readonly default_lateral_axis?: SignedAxis;
  readonly allowed_image_coordinate_conventions?: readonly ImageCoordinateConvention[];
  readonly min_safety_clearance_m?: number;
  readonly require_w_hat_for_cognition?: boolean;
  readonly hidden_source_action?: "reject" | "warn";
}

/**
 * Optional profile input for embodiment-specific geometry convention records.
 */
export interface GeometryConventionProfileInput {
  readonly profile_ref?: Ref;
  readonly source_ref?: Ref;
  readonly coordinate_convention?: Partial<Omit<CoordinateConvention, "canonical_units" | "world_frame" | "agent_estimated_world_frame" | "simulator_truth_visibility">>;
  readonly image_coordinate_conventions?: readonly ImageCoordinateConvention[];
  readonly tolerance_overrides?: readonly Partial<GeometryToleranceProfile>[];
  readonly policy?: GeometryConventionRegistryPolicy;
}

/**
 * Deterministic axis basis derived from the active coordinate convention.
 */
export interface GeometryAxisBasis {
  readonly handedness: Handedness;
  readonly up_axis: Axis;
  readonly forward_axis: SignedAxis;
  readonly lateral_axis: SignedAxis;
  readonly forward_unit_vector: Vector3;
  readonly lateral_unit_vector: Vector3;
  readonly up_unit_vector: Vector3;
  readonly determinant: number;
  readonly orthonormal: boolean;
  readonly basis_summary: string;
}

/**
 * Canonical unit declaration used by geometry, constraints, residuals, and
 * controller handoff payloads.
 */
export interface GeometryUnitConvention {
  readonly length: typeof CANONICAL_UNITS.length;
  readonly angle: typeof CANONICAL_UNITS.angle;
  readonly time: typeof CANONICAL_UNITS.time;
  readonly mass: typeof CANONICAL_UNITS.mass;
  readonly force: typeof CANONICAL_UNITS.force;
  readonly torque: typeof CANONICAL_UNITS.torque;
  readonly image_coordinate_conventions: readonly ImageCoordinateConvention[];
  readonly internal_image_normalized_range: readonly [0, 1000];
}

/**
 * Visibility and ownership policy for each File 10 frame class.
 */
export interface GeometryFrameClassPolicy {
  readonly frame_class: GeometryFrameClass;
  readonly symbol: GeometryFrameSymbol;
  readonly owned_by: string;
  readonly cognitive_visibility: GeometryCognitiveVisibility;
  readonly allowed_provenance: readonly GeometryProvenanceClass[];
  readonly expires_after_task: boolean;
  readonly requires_uncertainty: boolean;
  readonly notes: string;
}

export type GeometryProvenanceClass =
  | "declared_calibration"
  | "proprioceptive_estimate"
  | "visual_estimate"
  | "contact_estimate"
  | "memory_prior"
  | "task_instruction"
  | "validator_internal"
  | "simulator_truth"
  | "qa_truth";

/**
 * Tolerance policy used by downstream target-frame and residual services.
 */
export interface GeometryToleranceProfile {
  readonly tolerance_profile_ref: Ref;
  readonly tolerance_class: GeometryToleranceClass;
  readonly position_tolerance_m?: number;
  readonly orientation_tolerance_rad?: number;
  readonly distance_tolerance_m?: number;
  readonly clearance_margin_m?: number;
  readonly uncertainty_must_be_below_tolerance: boolean;
  readonly required_evidence: readonly string[];
  readonly memory_pose_use: "search_only" | "continuity_support" | "current_confirmation_required";
  readonly tool_clearance_multiplier: number;
  readonly summary: string;
  readonly determinism_hash: string;
}

/**
 * Natural-language spatial term mapped to the frame and tolerance information
 * a normalizer must require later in File 10.
 */
export interface GeometryTaskLanguageRule {
  readonly term: "left_of" | "right_of" | "in_front_of" | "behind" | "on_top_of" | "inside" | "near" | "aligned" | "centered" | "upright";
  readonly required_reference_frame: boolean;
  readonly required_axis?: SignedAxis | "gravity_up";
  readonly default_tolerance_class: GeometryToleranceClass;
  readonly required_evidence: readonly string[];
  readonly ambiguity_if_missing: string;
}

/**
 * Executable geometry convention profile consumed by the future frame graph,
 * pose, target-frame, residual, memory, and control bridge services.
 */
export interface GeometryConventionProfile {
  readonly schema_version: typeof GEOMETRY_CONVENTION_REGISTRY_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md";
  readonly profile_ref: Ref;
  readonly source_ref?: Ref;
  readonly coordinate_convention: CoordinateConvention;
  readonly unit_convention: GeometryUnitConvention;
  readonly axis_basis: GeometryAxisBasis;
  readonly frame_class_policies: readonly GeometryFrameClassPolicy[];
  readonly tolerance_profiles: readonly GeometryToleranceProfile[];
  readonly task_language_rules: readonly GeometryTaskLanguageRule[];
  readonly cognitive_allowed_frame_symbols: readonly GeometryFrameSymbol[];
  readonly forbidden_cognitive_frame_symbols: readonly GeometryFrameSymbol[];
  readonly truth_boundary_summary: string;
  readonly determinism_hash: string;
  readonly cognitive_visibility: "spatial_geometry_convention_profile";
}

/**
 * Registry report with validation and routing metadata.
 */
export interface GeometryConventionRegistrationReport {
  readonly schema_version: typeof GEOMETRY_CONVENTION_REGISTRY_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md";
  readonly registration_ref: Ref;
  readonly profile: GeometryConventionProfile;
  readonly decision: GeometryConventionDecision;
  readonly recommended_action: GeometryConventionRecommendedAction;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
  readonly cognitive_visibility: "spatial_geometry_convention_registration_report";
}

interface NormalizedGeometryConventionRegistryPolicy {
  readonly default_handedness: Handedness;
  readonly default_up_axis: Axis;
  readonly default_forward_axis: SignedAxis;
  readonly default_lateral_axis: SignedAxis;
  readonly allowed_image_coordinate_conventions: readonly ImageCoordinateConvention[];
  readonly min_safety_clearance_m: number;
  readonly require_w_hat_for_cognition: boolean;
  readonly hidden_source_action: "reject" | "warn";
}

const DEFAULT_POLICY: NormalizedGeometryConventionRegistryPolicy = Object.freeze({
  default_handedness: "right_handed",
  default_up_axis: "z",
  default_forward_axis: "x",
  default_lateral_axis: "y",
  allowed_image_coordinate_conventions: Object.freeze(["normalized_0_1000", "pixel_image"] as const),
  min_safety_clearance_m: 0.05,
  require_w_hat_for_cognition: true,
  hidden_source_action: "reject",
});

/**
 * Executable File 10 `GeometryConventionRegistry`.
 */
export class GeometryConventionRegistry {
  private readonly policy: NormalizedGeometryConventionRegistryPolicy;

  public constructor(policy: GeometryConventionRegistryPolicy = {}) {
    this.policy = mergePolicy(DEFAULT_POLICY, policy);
  }

  /**
   * Registers and validates one geometry convention profile. The output is
   * deterministic and can be used as the convention record referenced by later
   * frame graph registration and transform resolution services.
   */
  public registerGeometryConventionProfile(input: GeometryConventionProfileInput = {}): GeometryConventionRegistrationReport {
    const policy = mergePolicy(this.policy, input.policy ?? {});
    const issues: ValidationIssue[] = [];
    const profileRef = normalizeRef(input.profile_ref ?? "geometry_convention_profile:canonical:file10");
    if (profileRef.length === 0) {
      issues.push(makeIssue("error", "ProfileRefInvalid", "$.profile_ref", "Geometry convention profile ref must be non-empty.", "Use an opaque profile ref such as geometry_convention_profile_canonical."));
    }

    const coordinateConvention = createCanonicalCoordinateConvention({
      handedness: input.coordinate_convention?.handedness ?? policy.default_handedness,
      up_axis: input.coordinate_convention?.up_axis ?? policy.default_up_axis,
      forward_axis: input.coordinate_convention?.forward_axis ?? policy.default_forward_axis,
      lateral_axis: input.coordinate_convention?.lateral_axis ?? policy.default_lateral_axis,
    });
    const imageConventions = normalizeImageConventions(input.image_coordinate_conventions, policy, issues);
    const unitConvention = buildUnitConvention(imageConventions);
    const axisBasis = buildAxisBasis(coordinateConvention);
    const framePolicies = buildFrameClassPolicies();
    const toleranceProfiles = buildToleranceProfiles(input.tolerance_overrides ?? [], policy, issues);
    const taskLanguageRules = buildTaskLanguageRules(coordinateConvention);
    const profile = buildProfile(profileRef, input.source_ref, coordinateConvention, unitConvention, axisBasis, framePolicies, toleranceProfiles, taskLanguageRules);

    validateProfile(profile, policy, issues);
    const decision = decideRegistration(issues);
    const recommendedAction = chooseRecommendedAction(issues, decision);
    const registrationRef = makeRef("geometry_convention_registration", profile.profile_ref, decision);
    const shell = {
      registrationRef,
      profile: profile.profile_ref,
      units: profile.unit_convention,
      axes: profile.axis_basis,
      framePolicies: profile.frame_class_policies.map((frame) => [frame.symbol, frame.cognitive_visibility]),
      tolerances: profile.tolerance_profiles.map((tolerance) => [tolerance.tolerance_class, tolerance.position_tolerance_m, tolerance.orientation_tolerance_rad]),
      decision,
      issueCodes: issues.map((issue) => issue.code).sort(),
    };

    return Object.freeze({
      schema_version: GEOMETRY_CONVENTION_REGISTRY_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md",
      registration_ref: registrationRef,
      profile,
      decision,
      recommended_action: recommendedAction,
      issues: freezeArray(issues),
      ok: decision !== "rejected",
      determinism_hash: computeDeterminismHash(shell),
      cognitive_visibility: "spatial_geometry_convention_registration_report",
    });
  }
}

/**
 * Functional API for registering File 10 geometry conventions.
 */
export function registerGeometryConventionProfile(input: GeometryConventionProfileInput = {}): GeometryConventionRegistrationReport {
  return new GeometryConventionRegistry(input.policy).registerGeometryConventionProfile(input);
}

/**
 * Returns the default tolerance profile for a downstream constraint class.
 */
export function getDefaultGeometryToleranceProfile(toleranceClass: GeometryToleranceClass): GeometryToleranceProfile {
  const profile = defaultToleranceProfiles(DEFAULT_POLICY).find((item) => item.tolerance_class === toleranceClass);
  if (profile === undefined) {
    throw new Error(`Unknown geometry tolerance class: ${toleranceClass}`);
  }
  return profile;
}

/**
 * Computes the signed determinant for the forward-lateral-up basis. Values near
 * `+1` are right-handed; values near `-1` are left-handed.
 */
export function computeAxisBasisDeterminant(forward: SignedAxis, lateral: SignedAxis, up: Axis): number {
  return round6(determinant3(axisVector(forward), axisVector(lateral), axisVector(up)));
}

function buildProfile(
  profileRef: Ref,
  sourceRef: Ref | undefined,
  coordinateConvention: CoordinateConvention,
  unitConvention: GeometryUnitConvention,
  axisBasis: GeometryAxisBasis,
  framePolicies: readonly GeometryFrameClassPolicy[],
  toleranceProfiles: readonly GeometryToleranceProfile[],
  taskLanguageRules: readonly GeometryTaskLanguageRule[],
): GeometryConventionProfile {
  const cognitiveAllowed = framePolicies
    .filter((policy) => policy.cognitive_visibility !== "forbidden" && policy.cognitive_visibility !== "audit_only")
    .map((policy) => policy.symbol)
    .sort(compareFrameSymbol);
  const forbidden = framePolicies
    .filter((policy) => policy.cognitive_visibility === "forbidden" || policy.cognitive_visibility === "audit_only")
    .map((policy) => policy.symbol)
    .sort(compareFrameSymbol);
  const shell = {
    profileRef,
    sourceRef,
    convention: coordinateConvention,
    units: unitConvention,
    axes: axisBasis,
    frames: framePolicies.map((policy) => [policy.symbol, policy.cognitive_visibility]),
    tolerances: toleranceProfiles.map((profile) => [profile.tolerance_class, profile.position_tolerance_m, profile.clearance_margin_m]),
    language: taskLanguageRules.map((rule) => [rule.term, rule.default_tolerance_class]),
  };
  return Object.freeze({
    schema_version: GEOMETRY_CONVENTION_REGISTRY_SCHEMA_VERSION,
    blueprint_ref: "architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md",
    profile_ref: profileRef,
    source_ref: sourceRef,
    coordinate_convention: coordinateConvention,
    unit_convention: unitConvention,
    axis_basis: axisBasis,
    frame_class_policies: freezeArray(framePolicies),
    tolerance_profiles: freezeArray(toleranceProfiles),
    task_language_rules: freezeArray(taskLanguageRules),
    cognitive_allowed_frame_symbols: freezeArray(cognitiveAllowed),
    forbidden_cognitive_frame_symbols: freezeArray(forbidden),
    truth_boundary_summary: "Simulator world W and QA truth frames remain non-cognitive; agent-facing geometry uses W_hat, declared calibration, self-state, visual estimates, contact estimates, task evidence, or staleness-aware memory only.",
    determinism_hash: computeDeterminismHash(shell),
    cognitive_visibility: "spatial_geometry_convention_profile",
  });
}

function buildUnitConvention(imageConventions: readonly ImageCoordinateConvention[]): GeometryUnitConvention {
  return Object.freeze({
    length: CANONICAL_UNITS.length,
    angle: CANONICAL_UNITS.angle,
    time: CANONICAL_UNITS.time,
    mass: CANONICAL_UNITS.mass,
    force: CANONICAL_UNITS.force,
    torque: CANONICAL_UNITS.torque,
    image_coordinate_conventions: freezeArray(imageConventions),
    internal_image_normalized_range: Object.freeze([0, 1000] as const),
  });
}

function buildAxisBasis(convention: CoordinateConvention): GeometryAxisBasis {
  const forward = axisVector(convention.forward_axis);
  const lateral = axisVector(convention.lateral_axis);
  const up = axisVector(convention.up_axis);
  const determinant = computeAxisBasisDeterminant(convention.forward_axis, convention.lateral_axis, convention.up_axis);
  const orthonormal = areUnit(forward, lateral, up) && areOrthogonal(forward, lateral, up);
  return Object.freeze({
    handedness: convention.handedness,
    up_axis: convention.up_axis,
    forward_axis: convention.forward_axis,
    lateral_axis: convention.lateral_axis,
    forward_unit_vector: forward,
    lateral_unit_vector: lateral,
    up_unit_vector: up,
    determinant,
    orthonormal,
    basis_summary: `${convention.handedness}; forward=${convention.forward_axis}; lateral=${convention.lateral_axis}; up=${convention.up_axis}; determinant=${formatNumber(determinant)}.`,
  });
}

function buildFrameClassPolicies(): readonly GeometryFrameClassPolicy[] {
  return freezeArray([
    framePolicy("simulator_world", "W", "physics engine and QA", "forbidden", ["simulator_truth"], false, false, "Authoritative simulator world; never cognitive-facing."),
    framePolicy("agent_estimated_world", "W_hat", "geometry and memory", "allowed_with_uncertainty", ["visual_estimate", "proprioceptive_estimate", "contact_estimate", "memory_prior", "task_instruction"], false, true, "Agent-estimated frame for cognitive spatial reasoning."),
    framePolicy("base", "B", "embodiment and control", "self_state", ["proprioceptive_estimate", "declared_calibration"], false, true, "Robot body root frame."),
    framePolicy("torso_or_head", "T", "embodiment", "self_state", ["proprioceptive_estimate", "declared_calibration"], false, true, "Torso frame for body posture and mounted sensors."),
    framePolicy("torso_or_head", "H", "embodiment", "self_state", ["proprioceptive_estimate", "declared_calibration"], false, true, "Head frame for sensor orientation."),
    framePolicy("sensor", "S_i", "virtual hardware", "declared_calibration", ["declared_calibration"], false, true, "Declared sensor frame used for camera/audio projection."),
    framePolicy("end_effector", "E_i", "embodiment and control", "self_state", ["proprioceptive_estimate", "contact_estimate"], false, true, "End-effector frame for IK and manipulation."),
    framePolicy("contact", "C_i", "embodiment and tactile sensing", "self_state", ["contact_estimate", "proprioceptive_estimate"], true, true, "Contact frame derived from declared contact sites and current contact evidence."),
    framePolicy("object", "O_j", "perception and memory", "allowed_with_uncertainty", ["visual_estimate", "contact_estimate", "memory_prior"], true, true, "Estimated object frame from local hypotheses, never backend identity."),
    framePolicy("target", "T_k", "task and verification", "task_scoped", ["task_instruction", "visual_estimate", "validator_internal"], true, true, "Task target frame derived from estimates and explicit constraints."),
    framePolicy("tool", "U_i", "tool frame service", "task_scoped", ["visual_estimate", "contact_estimate", "proprioceptive_estimate"], true, true, "Temporary tool frame that expires after release or lost contact."),
    framePolicy("qa_truth", "Q_i", "QA harness", "audit_only", ["qa_truth"], false, false, "Benchmark and QA frame excluded from cognitive geometry."),
  ].sort((a, b) => compareFrameSymbol(a.symbol, b.symbol) || a.notes.localeCompare(b.notes)));
}

function framePolicy(
  frameClass: GeometryFrameClass,
  symbol: GeometryFrameSymbol,
  ownedBy: string,
  cognitiveVisibility: GeometryCognitiveVisibility,
  allowedProvenance: readonly GeometryProvenanceClass[],
  expiresAfterTask: boolean,
  requiresUncertainty: boolean,
  notes: string,
): GeometryFrameClassPolicy {
  return Object.freeze({
    frame_class: frameClass,
    symbol,
    owned_by: ownedBy,
    cognitive_visibility: cognitiveVisibility,
    allowed_provenance: freezeArray([...allowedProvenance].sort()),
    expires_after_task: expiresAfterTask,
    requires_uncertainty: requiresUncertainty,
    notes,
  });
}

function buildToleranceProfiles(
  overrides: readonly Partial<GeometryToleranceProfile>[],
  policy: NormalizedGeometryConventionRegistryPolicy,
  issues: ValidationIssue[],
): readonly GeometryToleranceProfile[] {
  const byClass = new Map<GeometryToleranceClass, GeometryToleranceProfile>();
  for (const profile of defaultToleranceProfiles(policy)) {
    byClass.set(profile.tolerance_class, profile);
  }
  for (const override of overrides) {
    if (override.tolerance_class === undefined) {
      issues.push(makeIssue("warning", "ToleranceProfileInvalid", "$.tolerance_overrides", "Tolerance override omitted tolerance_class.", "Attach overrides to an approved File 10 tolerance class."));
      continue;
    }
    const base = byClass.get(override.tolerance_class);
    if (base === undefined) {
      issues.push(makeIssue("error", "ToleranceProfileInvalid", `$.tolerance_overrides.${override.tolerance_class}`, "Tolerance override uses an unknown tolerance class.", "Use one of the File 10 tolerance classes."));
      continue;
    }
    byClass.set(override.tolerance_class, freezeTolerance({
      ...base,
      ...override,
      tolerance_profile_ref: override.tolerance_profile_ref ?? base.tolerance_profile_ref,
      tolerance_class: override.tolerance_class,
      required_evidence: override.required_evidence ?? base.required_evidence,
      uncertainty_must_be_below_tolerance: override.uncertainty_must_be_below_tolerance ?? base.uncertainty_must_be_below_tolerance,
      memory_pose_use: override.memory_pose_use ?? base.memory_pose_use,
      tool_clearance_multiplier: override.tool_clearance_multiplier ?? base.tool_clearance_multiplier,
      summary: override.summary ?? base.summary,
      determinism_hash: "",
    }));
  }
  return freezeArray([...byClass.values()].sort(compareToleranceProfiles));
}

function defaultToleranceProfiles(policy: NormalizedGeometryConventionRegistryPolicy): readonly GeometryToleranceProfile[] {
  return freezeArray([
    freezeTolerance({
      tolerance_profile_ref: "tolerance_profile:coarse_search",
      tolerance_class: "coarse_search",
      position_tolerance_m: 0.2,
      orientation_tolerance_rad: undefined,
      distance_tolerance_m: 0.25,
      clearance_margin_m: policy.min_safety_clearance_m,
      uncertainty_must_be_below_tolerance: false,
      required_evidence: ["current_view_or_memory_search_prior", "declared_reference_frame"],
      memory_pose_use: "search_only",
      tool_clearance_multiplier: 1.5,
      summary: "Broad target region for search and orienting; not a manipulation target.",
      determinism_hash: "",
    }),
    freezeTolerance({
      tolerance_profile_ref: "tolerance_profile:approach",
      tolerance_class: "approach",
      position_tolerance_m: 0.08,
      orientation_tolerance_rad: 0.35,
      distance_tolerance_m: 0.1,
      clearance_margin_m: policy.min_safety_clearance_m,
      uncertainty_must_be_below_tolerance: true,
      required_evidence: ["current_visual_estimate", "body_frame", "safe_clearance"],
      memory_pose_use: "current_confirmation_required",
      tool_clearance_multiplier: 1.25,
      summary: "Body-safe approach tolerance anchored to current estimates.",
      determinism_hash: "",
    }),
    freezeTolerance({
      tolerance_profile_ref: "tolerance_profile:grasp_candidate",
      tolerance_class: "grasp_candidate",
      position_tolerance_m: 0.025,
      orientation_tolerance_rad: 0.22,
      distance_tolerance_m: 0.035,
      clearance_margin_m: policy.min_safety_clearance_m,
      uncertainty_must_be_below_tolerance: true,
      required_evidence: ["current_wrist_or_close_view", "contact_or_depth_when_available", "object_frame"],
      memory_pose_use: "current_confirmation_required",
      tool_clearance_multiplier: 1.5,
      summary: "Candidate manipulation tolerance requiring current close-view support.",
      determinism_hash: "",
    }),
    freezeTolerance({
      tolerance_profile_ref: "tolerance_profile:placement_standard",
      tolerance_class: "placement_standard",
      position_tolerance_m: 0.035,
      orientation_tolerance_rad: 0.28,
      distance_tolerance_m: 0.04,
      clearance_margin_m: policy.min_safety_clearance_m,
      uncertainty_must_be_below_tolerance: true,
      required_evidence: ["current_target_view", "support_surface_estimate", "verification_view"],
      memory_pose_use: "current_confirmation_required",
      tool_clearance_multiplier: 1.5,
      summary: "Standard placement tolerance for object-on-support or near-target tasks.",
      determinism_hash: "",
    }),
    freezeTolerance({
      tolerance_profile_ref: "tolerance_profile:placement_precise",
      tolerance_class: "placement_precise",
      position_tolerance_m: 0.015,
      orientation_tolerance_rad: 0.14,
      distance_tolerance_m: 0.02,
      clearance_margin_m: Math.max(policy.min_safety_clearance_m, 0.06),
      uncertainty_must_be_below_tolerance: true,
      required_evidence: ["multi_view_current_estimate", "declared_depth_or_contact_support", "verification_aux_view"],
      memory_pose_use: "current_confirmation_required",
      tool_clearance_multiplier: 1.75,
      summary: "Precise benchmark placement tolerance requiring multi-view evidence.",
      determinism_hash: "",
    }),
    freezeTolerance({
      tolerance_profile_ref: "tolerance_profile:verification_visual",
      tolerance_class: "verification_visual",
      position_tolerance_m: 0.025,
      orientation_tolerance_rad: 0.2,
      distance_tolerance_m: 0.03,
      clearance_margin_m: policy.min_safety_clearance_m,
      uncertainty_must_be_below_tolerance: true,
      required_evidence: ["synchronized_verification_views", "relation_visible", "residual_evidence"],
      memory_pose_use: "continuity_support",
      tool_clearance_multiplier: 1.5,
      summary: "Visual verification tolerance; relation must be visible and uncertainty explicit.",
      determinism_hash: "",
    }),
    freezeTolerance({
      tolerance_profile_ref: "tolerance_profile:safety_clearance",
      tolerance_class: "safety_clearance",
      position_tolerance_m: undefined,
      orientation_tolerance_rad: undefined,
      distance_tolerance_m: policy.min_safety_clearance_m,
      clearance_margin_m: policy.min_safety_clearance_m,
      uncertainty_must_be_below_tolerance: true,
      required_evidence: ["obstacle_estimate", "body_or_tool_swept_region", "safety_validator"],
      memory_pose_use: "current_confirmation_required",
      tool_clearance_multiplier: 2,
      summary: "Conservative clearance policy for collision, tool sweep, and safety checks.",
      determinism_hash: "",
    }),
  ]);
}

function freezeTolerance(profile: GeometryToleranceProfile): GeometryToleranceProfile {
  const shell = {
    ref: profile.tolerance_profile_ref,
    cls: profile.tolerance_class,
    position: profile.position_tolerance_m,
    orientation: profile.orientation_tolerance_rad,
    distance: profile.distance_tolerance_m,
    clearance: profile.clearance_margin_m,
    uncertainty: profile.uncertainty_must_be_below_tolerance,
    evidence: profile.required_evidence,
    memory: profile.memory_pose_use,
    tool: profile.tool_clearance_multiplier,
  };
  return Object.freeze({
    ...profile,
    required_evidence: freezeArray([...profile.required_evidence].sort()),
    determinism_hash: computeDeterminismHash(shell),
  });
}

function buildTaskLanguageRules(convention: CoordinateConvention): readonly GeometryTaskLanguageRule[] {
  return freezeArray([
    languageRule("left_of", true, invertSignedAxis(convention.lateral_axis), "placement_standard", ["subject_estimate", "reference_estimate"], "Left/right relation needs a reference frame and lateral axis."),
    languageRule("right_of", true, convention.lateral_axis, "placement_standard", ["subject_estimate", "reference_estimate"], "Left/right relation needs a reference frame and lateral axis."),
    languageRule("in_front_of", true, convention.forward_axis, "approach", ["subject_estimate", "reference_estimate"], "Front/behind relation needs the reference frame forward axis."),
    languageRule("behind", true, invertSignedAxis(convention.forward_axis), "approach", ["subject_estimate", "reference_estimate"], "Front/behind relation needs the reference frame forward axis."),
    languageRule("on_top_of", true, "gravity_up", "verification_visual", ["support_surface_estimate", "contact_or_depth_evidence", "side_or_verification_view"], "On-top relation is ambiguous without support/contact visibility."),
    languageRule("inside", true, "gravity_up", "verification_visual", ["container_boundary_estimate", "rim_visibility", "side_or_depth_evidence"], "Inside relation is ambiguous if rim/container boundary is hidden."),
    languageRule("near", true, undefined, "coarse_search", ["distance_threshold", "subject_estimate", "reference_estimate"], "Near requires an explicit threshold."),
    languageRule("aligned", true, convention.forward_axis, "placement_precise", ["axis_declaration", "multi_view_estimate"], "Alignment requires axis and tolerance."),
    languageRule("centered", true, undefined, "placement_standard", ["target_region", "center_residual"], "Centered requires target region and tolerance."),
    languageRule("upright", true, "gravity_up", "verification_visual", ["orientation_cue", "gravity_reference"], "Upright requires a gravity/up reference and orientation cue."),
  ].sort((a, b) => a.term.localeCompare(b.term)));
}

function languageRule(
  term: GeometryTaskLanguageRule["term"],
  requiredReferenceFrame: boolean,
  requiredAxis: GeometryTaskLanguageRule["required_axis"],
  defaultToleranceClass: GeometryToleranceClass,
  requiredEvidence: readonly string[],
  ambiguityIfMissing: string,
): GeometryTaskLanguageRule {
  return Object.freeze({
    term,
    required_reference_frame: requiredReferenceFrame,
    required_axis: requiredAxis,
    default_tolerance_class: defaultToleranceClass,
    required_evidence: freezeArray([...requiredEvidence].sort()),
    ambiguity_if_missing: ambiguityIfMissing,
  });
}

function validateProfile(
  profile: GeometryConventionProfile,
  policy: NormalizedGeometryConventionRegistryPolicy,
  issues: ValidationIssue[],
): void {
  validateNoHiddenGeometry(profile, policy, issues);
  validateCoordinateConvention(profile.coordinate_convention, profile.axis_basis, issues);
  validateUnitConvention(profile.unit_convention, policy, issues);
  validateFramePolicies(profile.frame_class_policies, policy, issues);
  validateToleranceProfiles(profile.tolerance_profiles, policy, issues);
}

function validateNoHiddenGeometry(
  profile: GeometryConventionProfile,
  policy: NormalizedGeometryConventionRegistryPolicy,
  issues: ValidationIssue[],
): void {
  const hiddenSurface = JSON.stringify({
    profile_ref: profile.profile_ref,
    source_ref: profile.source_ref,
    policies: profile.frame_class_policies.map((item) => [item.symbol, item.notes, item.owned_by]),
    tolerances: profile.tolerance_profiles.map((item) => [item.tolerance_profile_ref, item.summary]),
  });
  if (HIDDEN_GEOMETRY_PATTERN.test(hiddenSurface)) {
    issues.push(makeIssue(policy.hidden_source_action === "reject" ? "error" : "warning", "HiddenGeometryLeak", "$.profile", "Geometry convention profile contains hidden simulator/backend/QA wording in cognitive-adjacent metadata.", "Keep simulator truth and QA labels only in non-cognitive frame policies."));
  }
}

function validateCoordinateConvention(
  convention: CoordinateConvention,
  axisBasis: GeometryAxisBasis,
  issues: ValidationIssue[],
): void {
  if (convention.world_frame !== "W") {
    issues.push(makeIssue("error", "WorldFrameInvalid", "$.coordinate_convention.world_frame", "Simulator truth frame must be W.", "Use W only as non-cognitive simulator truth."));
  }
  if (convention.agent_estimated_world_frame !== "W_hat") {
    issues.push(makeIssue("error", "EstimatedWorldFrameInvalid", "$.coordinate_convention.agent_estimated_world_frame", "Agent-estimated cognitive geometry frame must be W_hat.", "Use W_hat for agent-estimated geometry."));
  }
  if (convention.handedness !== "right_handed" && convention.handedness !== "left_handed") {
    issues.push(makeIssue("error", "HandednessInvalid", "$.coordinate_convention.handedness", "Handedness must be explicit.", "Use right_handed unless an embodiment profile requires left_handed."));
  }
  if (!isAxis(convention.up_axis) || !isSignedAxis(convention.forward_axis) || !isSignedAxis(convention.lateral_axis)) {
    issues.push(makeIssue("error", "AxisInvalid", "$.coordinate_convention", "Up, forward, and lateral axes must use the approved File 10 axis vocabulary.", "Use x, y, z and optional sign for forward/lateral axes."));
  }
  if (!axisBasis.orthonormal) {
    issues.push(makeIssue("error", "AxisNotOrthogonal", "$.axis_basis", "Forward, lateral, and up axes must form an orthonormal basis.", "Choose three distinct basis axes."));
  }
  const expectedDeterminant = convention.handedness === "right_handed" ? 1 : -1;
  if (axisBasis.orthonormal && Math.abs(axisBasis.determinant - expectedDeterminant) > 1e-6) {
    issues.push(makeIssue("error", "AxisHandednessMismatch", "$.axis_basis.determinant", `Axis determinant ${formatNumber(axisBasis.determinant)} does not match ${convention.handedness}.`, "Flip one signed axis or correct the declared handedness."));
  }
  if (convention.simulator_truth_visibility !== "qa_and_validators_only") {
    issues.push(makeIssue("error", "TruthFrameCognitiveLeak", "$.coordinate_convention.simulator_truth_visibility", "Simulator truth visibility must stay QA and validator only.", "Do not expose W as cognitive geometry."));
  }
}

function validateUnitConvention(
  unitConvention: GeometryUnitConvention,
  policy: NormalizedGeometryConventionRegistryPolicy,
  issues: ValidationIssue[],
): void {
  if (
    unitConvention.length !== "meter"
    || unitConvention.angle !== "radian"
    || unitConvention.time !== "second"
    || unitConvention.mass !== "kilogram"
    || unitConvention.force !== "newton"
    || unitConvention.torque !== "newton_meter"
  ) {
    issues.push(makeIssue("error", "CanonicalUnitsInvalid", "$.unit_convention", "Geometry units must match the File 10 canonical unit table.", "Use meter, radian, second, kilogram, newton, and newton_meter internally."));
  }
  for (const imageConvention of unitConvention.image_coordinate_conventions) {
    if (!policy.allowed_image_coordinate_conventions.includes(imageConvention)) {
      issues.push(makeIssue("error", "ImageConventionInvalid", "$.unit_convention.image_coordinate_conventions", "Image coordinate convention is not approved for this registry policy.", "Use normalized_0_1000 or pixel_image and declare which one each payload uses."));
    }
  }
}

function validateFramePolicies(
  framePolicies: readonly GeometryFrameClassPolicy[],
  policy: NormalizedGeometryConventionRegistryPolicy,
  issues: ValidationIssue[],
): void {
  const bySymbol = new Map<GeometryFrameSymbol, GeometryFrameClassPolicy[]>();
  for (const item of framePolicies) {
    const records = bySymbol.get(item.symbol) ?? [];
    records.push(item);
    bySymbol.set(item.symbol, records);
  }
  for (const symbol of ["W", "W_hat", "B", "S_i", "E_i", "O_j", "T_k", "U_i", "Q_i"] as const) {
    if (!bySymbol.has(symbol)) {
      issues.push(makeIssue("error", "FramePolicyMissing", `$.frame_class_policies.${symbol}`, `Frame policy for ${symbol} is missing.`, "Declare every File 10 core frame class before frame graph registration."));
    }
  }
  const forbiddenSymbols: readonly GeometryFrameSymbol[] = ["W", "Q_i"];
  for (const symbol of forbiddenSymbols) {
    const policies = bySymbol.get(symbol) ?? [];
    if (policies.some((item) => item.cognitive_visibility !== "forbidden" && item.cognitive_visibility !== "audit_only")) {
      issues.push(makeIssue("error", "TruthFrameCognitiveLeak", `$.frame_class_policies.${symbol}`, `${symbol} cannot be cognitive-visible geometry.`, "Use W_hat or a sensor-derived estimate for cognitive-facing geometry."));
    }
  }
  if (policy.require_w_hat_for_cognition) {
    const wHat = bySymbol.get("W_hat") ?? [];
    if (!wHat.some((item) => item.cognitive_visibility === "allowed_with_uncertainty" && item.requires_uncertainty)) {
      issues.push(makeIssue("error", "FramePolicyMissing", "$.frame_class_policies.W_hat", "W_hat must be the uncertainty-labeled cognitive geometry frame.", "Mark W_hat allowed_with_uncertainty and require uncertainty."));
    }
  }
}

function validateToleranceProfiles(
  toleranceProfiles: readonly GeometryToleranceProfile[],
  policy: NormalizedGeometryConventionRegistryPolicy,
  issues: ValidationIssue[],
): void {
  if (toleranceProfiles.length === 0) {
    issues.push(makeIssue("error", "NoToleranceProfiles", "$.tolerance_profiles", "Geometry convention registry must define tolerance profiles.", "Register the File 10 default tolerance classes."));
    return;
  }
  const seen = new Set<GeometryToleranceClass>();
  for (const profile of toleranceProfiles) {
    seen.add(profile.tolerance_class);
    const numericValues = [profile.position_tolerance_m, profile.orientation_tolerance_rad, profile.distance_tolerance_m, profile.clearance_margin_m].filter(isNumber);
    if (numericValues.some((value) => value <= 0 || !Number.isFinite(value))) {
      issues.push(makeIssue("error", "ToleranceProfileInvalid", `$.tolerance_profiles.${profile.tolerance_class}`, "Tolerance numeric values must be positive finite numbers.", "Use positive meter/radian thresholds."));
    }
    if ((profile.clearance_margin_m ?? 0) < policy.min_safety_clearance_m && profile.tolerance_class === "safety_clearance") {
      issues.push(makeIssue("error", "ToleranceProfileInvalid", "$.tolerance_profiles.safety_clearance.clearance_margin_m", "Safety clearance margin is below registry policy.", "Increase the clearance margin before controller handoff."));
    }
    if (profile.required_evidence.length === 0) {
      issues.push(makeIssue("error", "ToleranceProfileInvalid", `$.tolerance_profiles.${profile.tolerance_class}.required_evidence`, "Tolerance profiles must name required evidence.", "Attach view, contact, depth, telemetry, or task evidence requirements."));
    }
  }
  for (const required of ["coarse_search", "approach", "grasp_candidate", "placement_standard", "placement_precise", "verification_visual", "safety_clearance"] as const) {
    if (!seen.has(required)) {
      issues.push(makeIssue("error", "ToleranceProfileInvalid", `$.tolerance_profiles.${required}`, "Required File 10 tolerance class is missing.", "Restore the canonical tolerance profile."));
    }
  }
}

function normalizeImageConventions(
  requested: readonly ImageCoordinateConvention[] | undefined,
  policy: NormalizedGeometryConventionRegistryPolicy,
  issues: ValidationIssue[],
): readonly ImageCoordinateConvention[] {
  const values = requested === undefined || requested.length === 0
    ? policy.allowed_image_coordinate_conventions
    : requested;
  const unique = uniqueSorted(values);
  for (const value of unique) {
    if (value !== "normalized_0_1000" && value !== "pixel_image") {
      issues.push(makeIssue("error", "ImageConventionInvalid", "$.image_coordinate_conventions", "Image coordinate convention must be normalized_0_1000 or pixel_image.", "Declare a File 10-approved image coordinate convention."));
    }
  }
  return freezeArray(unique);
}

function decideRegistration(issues: readonly ValidationIssue[]): GeometryConventionDecision {
  if (issues.some((issue) => issue.severity === "error")) return "rejected";
  return issues.length > 0 ? "registered_with_warnings" : "registered";
}

function chooseRecommendedAction(
  issues: readonly ValidationIssue[],
  decision: GeometryConventionDecision,
): GeometryConventionRecommendedAction {
  if (decision === "registered") return "use_convention_profile";
  if (issues.some((issue) => issue.code === "AxisInvalid" || issue.code === "AxisNotOrthogonal" || issue.code === "AxisHandednessMismatch" || issue.code === "HandednessInvalid")) return "repair_axis_metadata";
  if (issues.some((issue) => issue.code === "CanonicalUnitsInvalid" || issue.code === "ImageConventionInvalid")) return "repair_units";
  if (issues.some((issue) => issue.code === "TruthFrameCognitiveLeak" || issue.code === "HiddenGeometryLeak")) return "repair_truth_boundary";
  if (decision === "registered_with_warnings") return "human_review";
  return "safe_hold";
}

function mergePolicy(
  base: NormalizedGeometryConventionRegistryPolicy,
  override: GeometryConventionRegistryPolicy,
): NormalizedGeometryConventionRegistryPolicy {
  return Object.freeze({
    default_handedness: override.default_handedness ?? base.default_handedness,
    default_up_axis: override.default_up_axis ?? base.default_up_axis,
    default_forward_axis: override.default_forward_axis ?? base.default_forward_axis,
    default_lateral_axis: override.default_lateral_axis ?? base.default_lateral_axis,
    allowed_image_coordinate_conventions: freezeArray(override.allowed_image_coordinate_conventions ?? base.allowed_image_coordinate_conventions),
    min_safety_clearance_m: positiveOrDefault(override.min_safety_clearance_m, base.min_safety_clearance_m),
    require_w_hat_for_cognition: override.require_w_hat_for_cognition ?? base.require_w_hat_for_cognition,
    hidden_source_action: override.hidden_source_action ?? base.hidden_source_action,
  });
}

function axisVector(axis: SignedAxis | Axis): Vector3 {
  const sign = axis.startsWith("-") ? -1 : 1;
  const bare = stripSign(axis);
  if (bare === "x") return Object.freeze([sign, 0, 0] as const);
  if (bare === "y") return Object.freeze([0, sign, 0] as const);
  return Object.freeze([0, 0, sign] as const);
}

function determinant3(a: Vector3, b: Vector3, c: Vector3): number {
  return a[0] * (b[1] * c[2] - b[2] * c[1])
    - b[0] * (a[1] * c[2] - a[2] * c[1])
    + c[0] * (a[1] * b[2] - a[2] * b[1]);
}

function dot(a: Vector3, b: Vector3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function norm(a: Vector3): number {
  return Math.sqrt(dot(a, a));
}

function areUnit(...vectors: readonly Vector3[]): boolean {
  return vectors.every((vector) => Math.abs(norm(vector) - 1) <= 1e-9);
}

function areOrthogonal(a: Vector3, b: Vector3, c: Vector3): boolean {
  return Math.abs(dot(a, b)) <= 1e-9 && Math.abs(dot(a, c)) <= 1e-9 && Math.abs(dot(b, c)) <= 1e-9;
}

function stripSign(axis: SignedAxis | Axis): Axis {
  return axis.startsWith("-") ? axis.slice(1) as Axis : axis as Axis;
}

function invertSignedAxis(axis: SignedAxis): SignedAxis {
  return axis.startsWith("-") ? stripSign(axis) : `-${axis}` as SignedAxis;
}

function isAxis(value: string): value is Axis {
  return value === "x" || value === "y" || value === "z";
}

function isSignedAxis(value: string): value is SignedAxis {
  return isAxis(value) || value === "-x" || value === "-y" || value === "-z";
}

function isNumber(value: number | undefined): value is number {
  return value !== undefined;
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeRef(value: string): Ref {
  return makeRef(value);
}

function compareToleranceProfiles(a: GeometryToleranceProfile, b: GeometryToleranceProfile): number {
  return toleranceRank(a.tolerance_class) - toleranceRank(b.tolerance_class)
    || a.tolerance_profile_ref.localeCompare(b.tolerance_profile_ref);
}

function toleranceRank(value: GeometryToleranceClass): number {
  const ranks: Readonly<Record<GeometryToleranceClass, number>> = {
    coarse_search: 0,
    approach: 1,
    grasp_candidate: 2,
    placement_standard: 3,
    placement_precise: 4,
    verification_visual: 5,
    safety_clearance: 6,
  };
  return ranks[value];
}

function compareFrameSymbol(a: GeometryFrameSymbol, b: GeometryFrameSymbol): number {
  return frameRank(a) - frameRank(b) || a.localeCompare(b);
}

function frameRank(value: GeometryFrameSymbol): number {
  const ranks: Readonly<Record<GeometryFrameSymbol, number>> = {
    W: 0,
    W_hat: 1,
    B: 2,
    T: 3,
    H: 4,
    S_i: 5,
    E_i: 6,
    C_i: 7,
    O_j: 8,
    T_k: 9,
    U_i: 10,
    Q_i: 11,
  };
  return ranks[value];
}

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return freezeArray([...new Set(values)].sort());
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "") : "invalid";
}

function makeIssue(
  severity: ValidationSeverity,
  code: GeometryConventionIssueCode,
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
