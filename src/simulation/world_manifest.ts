/**
 * Project Mebsuta simulation world manifest.
 *
 * This module is the executable boundary for architecture document
 * `03_SIMULATION_AND_PHYSICS_ENGINE_ARCHITECTURE.md`, section 3.7. It defines
 * the physics-authoritative manifest that initializes a bounded world before
 * stepping, rendering, sensors, disturbances, or replay are allowed to run.
 *
 * The manifest deliberately contains simulator truth: object refs, collision
 * refs, initial transforms, replay seeds, and disturbance scripts. Those values
 * are valid for physics, validators, replay, and QA. They are not valid inputs
 * to Gemini Robotics-ER 1.6. Use `redactWorldManifestForCognition` when a
 * downstream caller needs a cognitive-safe calibration summary.
 */

export const WORLD_MANIFEST_SCHEMA_VERSION = "mebsuta.world_manifest.v1" as const;

export const CANONICAL_UNITS = Object.freeze({
  length: "meter",
  angle: "radian",
  time: "second",
  mass: "kilogram",
  force: "newton",
  torque: "newton_meter",
} as const);

export const DEFAULT_PHYSICS_HZ = 240;
export const EARTH_GRAVITY_M_PER_S2 = 9.80665;
export const DEFAULT_GRAVITY_VECTOR: Vector3 = Object.freeze([0, 0, -EARTH_GRAVITY_M_PER_S2]);

export type SchemaVersion = typeof WORLD_MANIFEST_SCHEMA_VERSION;
export type Ref = string;
export type Vector3 = readonly [number, number, number];
export type Quaternion = readonly [number, number, number, number];

export type Axis = "x" | "y" | "z";
export type SignedAxis = Axis | "-x" | "-y" | "-z";
export type Handedness = "right_handed" | "left_handed";
export type Visibility =
  | "cognitive_allowed"
  | "cognitive_calibration_only"
  | "sensor_derived_only"
  | "qa_only"
  | "validator_only"
  | "forbidden_to_cognition";

export type WorldLifecycleState =
  | "WorldUninitialized"
  | "WorldLoading"
  | "WorldReady"
  | "WorldStepping"
  | "WorldPaused"
  | "WorldReplay"
  | "WorldShutdown";

export type ObjectRole =
  | "fixed_environment"
  | "movable_task_object"
  | "tool_candidate"
  | "distractor_object"
  | "audio_emitter"
  | "occluder"
  | "qa_only_marker";

export type MovabilityPolicy = "fixed" | "dynamic" | "kinematic" | "constrained";
export type EmbodimentKind = "quadruped" | "humanoid";
export type DisturbanceType =
  | "slip"
  | "drop"
  | "occlusion"
  | "object_movement"
  | "audio"
  | "physics_glitch"
  | "sensor"
  | "api_timing";
export type SafetyPolicy = "allow" | "warning" | "safe_hold_if_severe";

export interface TimestampInterval {
  readonly start_s: number;
  readonly end_s: number;
}

export interface WorldBounds {
  readonly kind: "axis_aligned_box";
  readonly min_m: Vector3;
  readonly max_m: Vector3;
  readonly boundary_policy: "solid" | "soft_limit" | "visual_only";
}

export interface CoordinateConvention {
  readonly world_frame: "W";
  readonly agent_estimated_world_frame: "W_hat";
  readonly handedness: Handedness;
  readonly up_axis: Axis;
  readonly forward_axis: SignedAxis;
  readonly lateral_axis: SignedAxis;
  readonly canonical_units: typeof CANONICAL_UNITS;
  readonly simulator_truth_visibility: "qa_and_validators_only";
}

export interface Transform {
  readonly frame_ref: Ref;
  readonly position_m: Vector3;
  /**
   * Quaternion `[x, y, z, w]`, normalized to unit length.
   *
   * This stores the rotation term in the homogeneous transform
   *   ^B T_A = [ ^B R_A  ^B p_A ; 0  1 ]
   * used by architecture file 10. A non-unit quaternion would scale the
   * rotation matrix and corrupt downstream IK and residual math.
   */
  readonly orientation_xyzw: Quaternion;
}

export interface GravityVector {
  readonly vector_m_per_s2: Vector3;
  readonly visibility: "normal_physics_summary_allowed" | "internal_only";
}

export interface WorldManifest {
  readonly schema_version: SchemaVersion;
  readonly world_manifest_id: Ref;
  readonly world_bounds: WorldBounds;
  readonly gravity_vector: GravityVector;
  readonly coordinate_convention: CoordinateConvention;
  readonly lighting_profile_refs: readonly Ref[];
  readonly material_profile_refs: readonly Ref[];
  readonly object_manifest_refs: readonly Ref[];
  readonly embodiment_manifest_ref: Ref;
  readonly disturbance_schedule_ref?: Ref;
  readonly replay_seed_ref?: Ref;
  readonly nominal_physics_hz: number;
  readonly created_at_iso?: string;
  readonly manifest_tags?: readonly string[];
}

export interface MaterialProfile {
  readonly material_profile_ref: Ref;
  readonly display_name: string;
  readonly static_friction: number;
  readonly dynamic_friction: number;
  readonly rolling_resistance: number;
  readonly restitution: number;
  readonly contact_stiffness_n_per_m: number;
  readonly contact_damping_n_s_per_m: number;
  readonly solver_tolerance_m: number;
  readonly acoustic_profile_ref?: Ref;
  readonly visibility: Visibility;
}

export interface InertiaTensor {
  readonly ixx_kg_m2: number;
  readonly iyy_kg_m2: number;
  readonly izz_kg_m2: number;
  readonly ixy_kg_m2: number;
  readonly ixz_kg_m2: number;
  readonly iyz_kg_m2: number;
}

export interface RenderTraits {
  readonly visible_shape: string;
  readonly primary_color: string;
  readonly texture_label?: string;
  readonly scale_hint_m?: Vector3;
}

export interface ObjectPhysicsDescriptor {
  readonly object_ref: Ref;
  readonly object_role: ObjectRole;
  readonly collision_shape_ref: Ref;
  readonly visual_shape_ref: Ref;
  readonly mass_kg?: number;
  readonly inertia_tensor?: InertiaTensor;
  readonly material_profile_ref: Ref;
  readonly initial_transform: Transform;
  readonly movability_policy: MovabilityPolicy;
  readonly render_traits: RenderTraits;
  readonly affordance_hint_internal?: string;
  readonly audio_profile_ref?: Ref;
  readonly cognitive_visibility: "visible_through_sensors_only" | "not_visible";
}

export interface EmbodimentManifestRef {
  readonly embodiment_manifest_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly sensor_mount_table_ref: Ref;
  readonly contact_site_table_ref: Ref;
  readonly joint_limit_table_ref: Ref;
  readonly actuator_limit_table_ref: Ref;
  readonly stability_policy_ref: Ref;
}

export interface DisturbanceEvent {
  readonly disturbance_id: Ref;
  readonly disturbance_type: DisturbanceType;
  readonly scheduled_time: TimestampInterval | { readonly trigger: string };
  readonly target_internal_refs?: readonly Ref[];
  readonly physical_effect: string;
  readonly expected_sensor_effect?: string;
  readonly replay_seed_ref?: Ref;
  readonly safety_policy: SafetyPolicy;
}

export interface DisturbanceSchedule {
  readonly disturbance_schedule_ref: Ref;
  readonly events: readonly DisturbanceEvent[];
  readonly qa_authorized: boolean;
  readonly cognitive_disclosure: "effects_only";
}

export interface ReplaySeed {
  readonly replay_seed_ref: Ref;
  readonly seed_u32: number;
  readonly generator: "xorshift32" | "pcg32" | "splitmix32";
  readonly visibility: "qa_only";
}

export interface WorldManifestBundle {
  readonly manifest: WorldManifest;
  readonly materials: readonly MaterialProfile[];
  readonly objects: readonly ObjectPhysicsDescriptor[];
  readonly embodiment: EmbodimentManifestRef;
  readonly disturbance_schedule?: DisturbanceSchedule;
  readonly replay_seed?: ReplaySeed;
}

export type ValidationSeverity = "error" | "warning";

export interface ValidationIssue {
  readonly severity: ValidationSeverity;
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly remediation: string;
}

export interface WorldManifestValidationReport {
  readonly ok: boolean;
  readonly issue_count: number;
  readonly error_count: number;
  readonly warning_count: number;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface CognitiveSafeWorldSummary {
  readonly schema_version: SchemaVersion;
  readonly physical_reality_summary: "bounded_3d_world_with_gravity_collision_friction_mass_lighting_and_occlusion";
  readonly calibration?: {
    readonly canonical_units: typeof CANONICAL_UNITS;
    readonly agent_estimated_world_frame: "W_hat";
    readonly handedness: Handedness;
    readonly up_axis: Axis;
    readonly forward_axis: SignedAxis;
  };
  readonly gravity_summary: "earth_like" | "custom_magnitude" | "internal_only";
  readonly boundary_summary: "agent_must_infer_boundaries_through_declared_sensors";
  readonly object_summary: "objects_are_available_only_as_sensor_evidence";
  readonly forbidden_fields_removed: readonly string[];
}

export class WorldManifestValidationError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "WorldManifestValidationError";
    this.issues = issues;
  }
}

export function createCanonicalCoordinateConvention(
  overrides: Partial<Omit<CoordinateConvention, "canonical_units" | "world_frame" | "agent_estimated_world_frame" | "simulator_truth_visibility">> = {},
): CoordinateConvention {
  return Object.freeze({
    world_frame: "W",
    agent_estimated_world_frame: "W_hat",
    handedness: overrides.handedness ?? "right_handed",
    up_axis: overrides.up_axis ?? "z",
    forward_axis: overrides.forward_axis ?? "x",
    lateral_axis: overrides.lateral_axis ?? "y",
    canonical_units: CANONICAL_UNITS,
    simulator_truth_visibility: "qa_and_validators_only",
  });
}

export function createWorldManifest(input: Omit<WorldManifest, "schema_version" | "nominal_physics_hz"> & {
  readonly nominal_physics_hz?: number;
}): WorldManifest {
  const manifest: WorldManifest = Object.freeze({
    ...input,
    schema_version: WORLD_MANIFEST_SCHEMA_VERSION,
    nominal_physics_hz: input.nominal_physics_hz ?? DEFAULT_PHYSICS_HZ,
  });
  assertValidWorldManifest(manifest);
  return manifest;
}

export function validateWorldManifestBundle(bundle: WorldManifestBundle): WorldManifestValidationReport {
  const issues: ValidationIssue[] = [];

  validateWorldManifestInto(bundle.manifest, issues, "$.manifest");
  validateEmbodimentRefInto(bundle.embodiment, issues, "$.embodiment");

  const materialRefs = new Set<string>();
  for (let index = 0; index < bundle.materials.length; index += 1) {
    const material = bundle.materials[index];
    validateMaterialProfileInto(material, issues, `$.materials[${index}]`);
    if (materialRefs.has(material.material_profile_ref)) {
      addIssue(issues, "error", "MaterialRefDuplicate", `$.materials[${index}].material_profile_ref`, "Material profile refs must be unique.", "Rename one material profile ref.");
    }
    materialRefs.add(material.material_profile_ref);
  }

  const objectRefs = new Set<string>();
  for (let index = 0; index < bundle.objects.length; index += 1) {
    const object = bundle.objects[index];
    validateObjectDescriptorInto(object, materialRefs, issues, `$.objects[${index}]`);
    if (objectRefs.has(object.object_ref)) {
      addIssue(issues, "error", "ObjectRefDuplicate", `$.objects[${index}].object_ref`, "Object refs must be unique inside a world.", "Rename one object ref.");
    }
    objectRefs.add(object.object_ref);
  }

  validateManifestReferenceClosureInto(bundle, objectRefs, materialRefs, issues);

  if (bundle.disturbance_schedule !== undefined) {
    validateDisturbanceScheduleInto(bundle.disturbance_schedule, bundle.replay_seed, issues, "$.disturbance_schedule");
  }

  if (bundle.replay_seed !== undefined) {
    validateReplaySeedInto(bundle.replay_seed, issues, "$.replay_seed");
  }

  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.length - errorCount;
  return Object.freeze({
    ok: errorCount === 0,
    issue_count: issues.length,
    error_count: errorCount,
    warning_count: warningCount,
    issues,
    determinism_hash: computeDeterminismHash(bundle),
  });
}

export function validateWorldManifest(manifest: WorldManifest): WorldManifestValidationReport {
  const issues: ValidationIssue[] = [];
  validateWorldManifestInto(manifest, issues, "$");
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.length - errorCount;
  return Object.freeze({
    ok: errorCount === 0,
    issue_count: issues.length,
    error_count: errorCount,
    warning_count: warningCount,
    issues,
    determinism_hash: computeDeterminismHash(manifest),
  });
}

export function assertValidWorldManifest(manifest: WorldManifest): void {
  const report = validateWorldManifest(manifest);
  if (!report.ok) {
    throw new WorldManifestValidationError("World manifest failed validation.", report.issues);
  }
}

export function assertValidWorldManifestBundle(bundle: WorldManifestBundle): void {
  const report = validateWorldManifestBundle(bundle);
  if (!report.ok) {
    throw new WorldManifestValidationError("World manifest bundle failed validation.", report.issues);
  }
}

export function redactWorldManifestForCognition(
  manifest: WorldManifest,
  options: { readonly include_calibration?: boolean } = {},
): CognitiveSafeWorldSummary {
  const gravityMagnitude = vectorNorm(manifest.gravity_vector.vector_m_per_s2);
  const gravitySummary =
    manifest.gravity_vector.visibility === "internal_only"
      ? "internal_only"
      : Math.abs(gravityMagnitude - EARTH_GRAVITY_M_PER_S2) <= 0.25
        ? "earth_like"
        : "custom_magnitude";

  return Object.freeze({
    schema_version: manifest.schema_version,
    physical_reality_summary: "bounded_3d_world_with_gravity_collision_friction_mass_lighting_and_occlusion",
    calibration: options.include_calibration
      ? Object.freeze({
          canonical_units: CANONICAL_UNITS,
          agent_estimated_world_frame: "W_hat",
          handedness: manifest.coordinate_convention.handedness,
          up_axis: manifest.coordinate_convention.up_axis,
          forward_axis: manifest.coordinate_convention.forward_axis,
        })
      : undefined,
    gravity_summary: gravitySummary,
    boundary_summary: "agent_must_infer_boundaries_through_declared_sensors",
    object_summary: "objects_are_available_only_as_sensor_evidence",
    forbidden_fields_removed: Object.freeze([
      "world_manifest_id",
      "world_bounds",
      "material_profile_refs",
      "object_manifest_refs",
      "embodiment_manifest_ref",
      "disturbance_schedule_ref",
      "replay_seed_ref",
    ]),
  });
}

export function computeDeterminismHash(value: unknown): string {
  const canonical = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function validateLifecycleTransition(from: WorldLifecycleState, to: WorldLifecycleState): boolean {
  const allowed: Readonly<Record<WorldLifecycleState, readonly WorldLifecycleState[]>> = {
    WorldUninitialized: ["WorldLoading", "WorldShutdown"],
    WorldLoading: ["WorldReady", "WorldShutdown"],
    WorldReady: ["WorldStepping", "WorldReplay", "WorldShutdown"],
    WorldStepping: ["WorldPaused", "WorldReplay", "WorldShutdown"],
    WorldPaused: ["WorldStepping", "WorldReplay", "WorldShutdown"],
    WorldReplay: ["WorldReady", "WorldShutdown"],
    WorldShutdown: [],
  };
  return allowed[from].includes(to);
}

function validateWorldManifestInto(manifest: WorldManifest, issues: ValidationIssue[], path: string): void {
  validateRef(manifest.world_manifest_id, issues, `${path}.world_manifest_id`, "WorldManifestIdInvalid");

  if (manifest.schema_version !== WORLD_MANIFEST_SCHEMA_VERSION) {
    addIssue(issues, "error", "SchemaVersionUnsupported", `${path}.schema_version`, `Expected ${WORLD_MANIFEST_SCHEMA_VERSION}.`, "Regenerate or migrate the manifest.");
  }

  validateBoundsInto(manifest.world_bounds, issues, `${path}.world_bounds`);
  validateGravityInto(manifest.gravity_vector, issues, `${path}.gravity_vector`);
  validateCoordinateConventionInto(manifest.coordinate_convention, issues, `${path}.coordinate_convention`);

  validateRefArray(manifest.lighting_profile_refs, issues, `${path}.lighting_profile_refs`, "LightingProfileRefsInvalid");
  validateRefArray(manifest.material_profile_refs, issues, `${path}.material_profile_refs`, "MaterialProfileRefsInvalid");
  validateRefArray(manifest.object_manifest_refs, issues, `${path}.object_manifest_refs`, "ObjectManifestRefsInvalid");
  validateRef(manifest.embodiment_manifest_ref, issues, `${path}.embodiment_manifest_ref`, "EmbodimentManifestRefInvalid");

  if (manifest.disturbance_schedule_ref !== undefined) {
    validateRef(manifest.disturbance_schedule_ref, issues, `${path}.disturbance_schedule_ref`, "DisturbanceScheduleRefInvalid");
  }
  if (manifest.replay_seed_ref !== undefined) {
    validateRef(manifest.replay_seed_ref, issues, `${path}.replay_seed_ref`, "ReplaySeedRefInvalid");
  }
  if (manifest.disturbance_schedule_ref !== undefined && manifest.replay_seed_ref === undefined) {
    addIssue(issues, "warning", "DisturbanceWithoutReplaySeed", `${path}.replay_seed_ref`, "Repeatable disturbance schedules should bind to a replay seed.", "Attach a QA-only replay seed before benchmark use.");
  }
  if (!Number.isFinite(manifest.nominal_physics_hz) || manifest.nominal_physics_hz <= 0) {
    addIssue(issues, "error", "NominalPhysicsHzInvalid", `${path}.nominal_physics_hz`, "Physics frequency must be positive.", "Use 240 Hz or a documented equivalent substep rate.");
  } else if (manifest.nominal_physics_hz < DEFAULT_PHYSICS_HZ) {
    addIssue(issues, "warning", "NominalPhysicsHzBelowTarget", `${path}.nominal_physics_hz`, "Architecture target is 240 Hz internal stepping or equivalent sub-stepping.", "Document the equivalent substep strategy or raise the rate.");
  }
}

function validateBoundsInto(bounds: WorldBounds, issues: ValidationIssue[], path: string): void {
  if (bounds.kind !== "axis_aligned_box") {
    addIssue(issues, "error", "WorldBoundsKindInvalid", `${path}.kind`, "Only axis-aligned world bounds are currently supported.", "Use kind axis_aligned_box.");
  }
  validateVector3(bounds.min_m, issues, `${path}.min_m`, "WorldBoundsMinInvalid");
  validateVector3(bounds.max_m, issues, `${path}.max_m`, "WorldBoundsMaxInvalid");

  for (let axis = 0; axis < 3; axis += 1) {
    if (Number.isFinite(bounds.min_m[axis]) && Number.isFinite(bounds.max_m[axis]) && bounds.min_m[axis] >= bounds.max_m[axis]) {
      addIssue(issues, "error", "WorldBoundsNonPositiveExtent", `${path}`, "Each world bound axis must have max > min.", "Expand the world bounds so the simulation has nonzero volume.");
    }
  }
  if (!["solid", "soft_limit", "visual_only"].includes(bounds.boundary_policy)) {
    addIssue(issues, "error", "WorldBoundaryPolicyInvalid", `${path}.boundary_policy`, "Boundary policy is not recognized.", "Use solid, soft_limit, or visual_only.");
  }
}

function validateGravityInto(gravity: GravityVector, issues: ValidationIssue[], path: string): void {
  validateVector3(gravity.vector_m_per_s2, issues, `${path}.vector_m_per_s2`, "GravityVectorInvalid");
  const magnitude = vectorNorm(gravity.vector_m_per_s2);
  if (!Number.isFinite(magnitude) || magnitude <= 0) {
    addIssue(issues, "error", "GravityMagnitudeInvalid", `${path}.vector_m_per_s2`, "Gravity must have nonzero finite magnitude.", "Use an Earth-like vector such as [0, 0, -9.80665].");
  } else if (magnitude < 1 || magnitude > 25) {
    addIssue(issues, "warning", "GravityMagnitudeUnusual", `${path}.vector_m_per_s2`, "Gravity magnitude is far from ordinary embodied-room simulation values.", "Confirm this is a deliberate benchmark condition.");
  }
}

function validateCoordinateConventionInto(convention: CoordinateConvention, issues: ValidationIssue[], path: string): void {
  if (convention.world_frame !== "W") {
    addIssue(issues, "error", "WorldFrameInvalid", `${path}.world_frame`, "Simulator truth frame must be W.", "Use W for simulator truth and W_hat for agent estimates.");
  }
  if (convention.agent_estimated_world_frame !== "W_hat") {
    addIssue(issues, "error", "EstimatedWorldFrameInvalid", `${path}.agent_estimated_world_frame`, "Agent-estimated world frame must be W_hat.", "Use W_hat for cognitive-facing estimates.");
  }
  if (convention.simulator_truth_visibility !== "qa_and_validators_only") {
    addIssue(issues, "error", "SimulatorTruthVisibilityInvalid", `${path}.simulator_truth_visibility`, "Simulator truth must be QA and validator only.", "Do not allow direct cognitive visibility of W.");
  }
  if (!["right_handed", "left_handed"].includes(convention.handedness)) {
    addIssue(issues, "error", "HandednessInvalid", `${path}.handedness`, "Handedness must be explicit.", "Use right_handed unless an embodiment profile requires otherwise.");
  }
  if (!isAxis(convention.up_axis)) {
    addIssue(issues, "error", "UpAxisInvalid", `${path}.up_axis`, "Up axis must be x, y, or z.", "Declare the physics engine up axis.");
  }
  if (!isSignedAxis(convention.forward_axis) || !isSignedAxis(convention.lateral_axis)) {
    addIssue(issues, "error", "SignedAxisInvalid", `${path}`, "Forward and lateral axes must be signed axes.", "Use x, y, z, -x, -y, or -z.");
  } else if (stripSign(convention.forward_axis) === stripSign(convention.lateral_axis) || stripSign(convention.forward_axis) === convention.up_axis || stripSign(convention.lateral_axis) === convention.up_axis) {
    addIssue(issues, "error", "CoordinateAxesNotOrthogonal", `${path}`, "Forward, lateral, and up axes must occupy three distinct basis axes.", "Choose orthogonal axes such as forward x, lateral y, up z.");
  }
  if (stableStringify(convention.canonical_units) !== stableStringify(CANONICAL_UNITS)) {
    addIssue(issues, "error", "CanonicalUnitsInvalid", `${path}.canonical_units`, "World manifest units must match the spatial geometry contract.", "Use meters, radians, seconds, kilograms, newtons, and newton-meters.");
  }
}

function validateMaterialProfileInto(material: MaterialProfile, issues: ValidationIssue[], path: string): void {
  validateRef(material.material_profile_ref, issues, `${path}.material_profile_ref`, "MaterialProfileRefInvalid");
  validateNonEmptyString(material.display_name, issues, `${path}.display_name`, "MaterialDisplayNameInvalid");
  validateRange(material.static_friction, 0, 5, issues, `${path}.static_friction`, "StaticFrictionInvalid");
  validateRange(material.dynamic_friction, 0, 5, issues, `${path}.dynamic_friction`, "DynamicFrictionInvalid");
  validateRange(material.rolling_resistance, 0, 1, issues, `${path}.rolling_resistance`, "RollingResistanceInvalid");
  validateRange(material.restitution, 0, 1, issues, `${path}.restitution`, "RestitutionInvalid");
  validateRange(material.contact_stiffness_n_per_m, 1, Number.POSITIVE_INFINITY, issues, `${path}.contact_stiffness_n_per_m`, "ContactStiffnessInvalid");
  validateRange(material.contact_damping_n_s_per_m, 0, Number.POSITIVE_INFINITY, issues, `${path}.contact_damping_n_s_per_m`, "ContactDampingInvalid");
  validateRange(material.solver_tolerance_m, 0, 0.1, issues, `${path}.solver_tolerance_m`, "SolverToleranceInvalid");

  if (Number.isFinite(material.static_friction) && Number.isFinite(material.dynamic_friction) && material.dynamic_friction > material.static_friction) {
    addIssue(issues, "warning", "DynamicFrictionExceedsStatic", `${path}`, "Dynamic friction usually should not exceed static friction for stable contact calibration.", "Confirm the material model or reduce dynamic friction.");
  }
  if (material.visibility === "cognitive_allowed") {
    addIssue(issues, "error", "MaterialProfileCognitiveLeak", `${path}.visibility`, "Material labels and contact parameters are internal truth unless inferred through sensors.", "Set visibility to qa_only, validator_only, sensor_derived_only, or forbidden_to_cognition.");
  }
}

function validateObjectDescriptorInto(object: ObjectPhysicsDescriptor, materialRefs: ReadonlySet<string>, issues: ValidationIssue[], path: string): void {
  validateRef(object.object_ref, issues, `${path}.object_ref`, "ObjectRefInvalid");
  validateRef(object.collision_shape_ref, issues, `${path}.collision_shape_ref`, "CollisionShapeRefInvalid");
  validateRef(object.visual_shape_ref, issues, `${path}.visual_shape_ref`, "VisualShapeRefInvalid");
  validateRef(object.material_profile_ref, issues, `${path}.material_profile_ref`, "MaterialProfileRefInvalid");
  validateTransformInto(object.initial_transform, issues, `${path}.initial_transform`);
  validateRenderTraitsInto(object.render_traits, issues, `${path}.render_traits`);

  if (!materialRefs.has(object.material_profile_ref)) {
    addIssue(issues, "error", "ObjectMaterialMissing", `${path}.material_profile_ref`, "Object references a material profile not present in the bundle.", "Add the material profile or correct the ref.");
  }

  const dynamic = object.movability_policy === "dynamic" || object.movability_policy === "constrained";
  if (dynamic) {
    if (!Number.isFinite(object.mass_kg) || (object.mass_kg ?? 0) <= 0) {
      addIssue(issues, "error", "DynamicObjectMassInvalid", `${path}.mass_kg`, "Dynamic and constrained objects require positive mass.", "Provide a physically plausible mass in kilograms.");
    }
    if (object.inertia_tensor === undefined) {
      addIssue(issues, "error", "DynamicObjectInertiaMissing", `${path}.inertia_tensor`, "Dynamic and constrained objects require an inertia tensor.", "Provide a symmetric positive inertia tensor.");
    } else {
      validateInertiaTensorInto(object.inertia_tensor, issues, `${path}.inertia_tensor`);
    }
  }

  if (object.movability_policy === "fixed" && object.mass_kg !== undefined && object.mass_kg <= 0) {
    addIssue(issues, "error", "FixedObjectMassInvalid", `${path}.mass_kg`, "If supplied, fixed object mass must be positive.", "Remove mass or set a positive value.");
  }

  if (object.object_role === "qa_only_marker" && object.cognitive_visibility !== "not_visible") {
    addIssue(issues, "error", "QAMarkerVisible", `${path}.cognitive_visibility`, "QA-only markers must never be visible to cognition.", "Mark QA marker visibility as not_visible.");
  }
  if (object.affordance_hint_internal !== undefined && object.cognitive_visibility === "visible_through_sensors_only") {
    addIssue(issues, "warning", "InternalAffordanceMustRemainHidden", `${path}.affordance_hint_internal`, "Affordance hints are developer/QA hints, not model-facing truth.", "Ensure downstream prompt builders never serialize this field.");
  }
}

function validateTransformInto(transform: Transform, issues: ValidationIssue[], path: string): void {
  validateRef(transform.frame_ref, issues, `${path}.frame_ref`, "TransformFrameRefInvalid");
  validateVector3(transform.position_m, issues, `${path}.position_m`, "TransformPositionInvalid");
  validateQuaternion(transform.orientation_xyzw, issues, `${path}.orientation_xyzw`, "TransformOrientationInvalid");
}

function validateRenderTraitsInto(traits: RenderTraits, issues: ValidationIssue[], path: string): void {
  validateNonEmptyString(traits.visible_shape, issues, `${path}.visible_shape`, "RenderVisibleShapeInvalid");
  validateNonEmptyString(traits.primary_color, issues, `${path}.primary_color`, "RenderPrimaryColorInvalid");
  if (traits.scale_hint_m !== undefined) {
    validateVector3(traits.scale_hint_m, issues, `${path}.scale_hint_m`, "RenderScaleHintInvalid");
    if (traits.scale_hint_m.some((value) => value <= 0)) {
      addIssue(issues, "error", "RenderScaleHintNonPositive", `${path}.scale_hint_m`, "Scale hints must be positive meter values.", "Use positive dimensions.");
    }
  }
}

function validateInertiaTensorInto(inertia: InertiaTensor, issues: ValidationIssue[], path: string): void {
  const diagonal = [inertia.ixx_kg_m2, inertia.iyy_kg_m2, inertia.izz_kg_m2];
  for (let index = 0; index < diagonal.length; index += 1) {
    if (!Number.isFinite(diagonal[index]) || diagonal[index] <= 0) {
      addIssue(issues, "error", "InertiaDiagonalInvalid", `${path}`, "Principal inertia terms must be positive finite values.", "Provide a positive definite inertia tensor.");
    }
  }
  for (const product of [inertia.ixy_kg_m2, inertia.ixz_kg_m2, inertia.iyz_kg_m2]) {
    if (!Number.isFinite(product)) {
      addIssue(issues, "error", "InertiaProductInvalid", `${path}`, "Inertia product terms must be finite.", "Replace NaN or infinite product terms.");
    }
  }
  /*
   * Rigid-body inertias obey triangle inequalities:
   *   I_xx + I_yy >= I_zz, I_xx + I_zz >= I_yy, I_yy + I_zz >= I_xx
   * These follow from I_xx = integral(y^2 + z^2) dm and equivalents.
   */
  if (
    inertia.ixx_kg_m2 + inertia.iyy_kg_m2 < inertia.izz_kg_m2 ||
    inertia.ixx_kg_m2 + inertia.izz_kg_m2 < inertia.iyy_kg_m2 ||
    inertia.iyy_kg_m2 + inertia.izz_kg_m2 < inertia.ixx_kg_m2
  ) {
    addIssue(issues, "error", "InertiaTriangleInequalityInvalid", path, "Principal moments violate rigid-body inertia triangle inequalities.", "Recompute inertia from object mass distribution.");
  }
}

function validateEmbodimentRefInto(embodiment: EmbodimentManifestRef, issues: ValidationIssue[], path: string): void {
  validateRef(embodiment.embodiment_manifest_ref, issues, `${path}.embodiment_manifest_ref`, "EmbodimentManifestRefInvalid");
  validateRef(embodiment.sensor_mount_table_ref, issues, `${path}.sensor_mount_table_ref`, "SensorMountTableRefInvalid");
  validateRef(embodiment.contact_site_table_ref, issues, `${path}.contact_site_table_ref`, "ContactSiteTableRefInvalid");
  validateRef(embodiment.joint_limit_table_ref, issues, `${path}.joint_limit_table_ref`, "JointLimitTableRefInvalid");
  validateRef(embodiment.actuator_limit_table_ref, issues, `${path}.actuator_limit_table_ref`, "ActuatorLimitTableRefInvalid");
  validateRef(embodiment.stability_policy_ref, issues, `${path}.stability_policy_ref`, "StabilityPolicyRefInvalid");
  if (!["quadruped", "humanoid"].includes(embodiment.embodiment_kind)) {
    addIssue(issues, "error", "EmbodimentKindInvalid", `${path}.embodiment_kind`, "Embodiment kind must be quadruped or humanoid.", "Use one of the supported embodiment kinds.");
  }
}

function validateDisturbanceScheduleInto(schedule: DisturbanceSchedule, replaySeed: ReplaySeed | undefined, issues: ValidationIssue[], path: string): void {
  validateRef(schedule.disturbance_schedule_ref, issues, `${path}.disturbance_schedule_ref`, "DisturbanceScheduleRefInvalid");
  if (!schedule.qa_authorized) {
    addIssue(issues, "error", "DisturbanceScheduleUnauthorized", `${path}.qa_authorized`, "Disturbance injection requires QA authorization.", "Authorize the schedule in QA tooling before loading it.");
  }
  if (schedule.cognitive_disclosure !== "effects_only") {
    addIssue(issues, "error", "DisturbanceDisclosureInvalid", `${path}.cognitive_disclosure`, "Disturbance scripts must not be disclosed to cognition.", "Use effects_only.");
  }

  const ids = new Set<string>();
  for (let index = 0; index < schedule.events.length; index += 1) {
    const event = schedule.events[index];
    const eventPath = `${path}.events[${index}]`;
    validateRef(event.disturbance_id, issues, `${eventPath}.disturbance_id`, "DisturbanceIdInvalid");
    if (ids.has(event.disturbance_id)) {
      addIssue(issues, "error", "DisturbanceIdDuplicate", `${eventPath}.disturbance_id`, "Disturbance IDs must be unique.", "Rename one disturbance ID.");
    }
    ids.add(event.disturbance_id);
    validateNonEmptyString(event.physical_effect, issues, `${eventPath}.physical_effect`, "DisturbanceEffectInvalid");
    if (!["allow", "warning", "safe_hold_if_severe"].includes(event.safety_policy)) {
      addIssue(issues, "error", "DisturbanceSafetyPolicyInvalid", `${eventPath}.safety_policy`, "Disturbance safety policy is invalid.", "Use allow, warning, or safe_hold_if_severe.");
    }
    if ("start_s" in event.scheduled_time) {
      validateTimestampIntervalInto(event.scheduled_time, issues, `${eventPath}.scheduled_time`);
    } else {
      validateNonEmptyString(event.scheduled_time.trigger, issues, `${eventPath}.scheduled_time.trigger`, "DisturbanceTriggerInvalid");
    }
    if (event.replay_seed_ref !== undefined && replaySeed !== undefined && event.replay_seed_ref !== replaySeed.replay_seed_ref) {
      addIssue(issues, "error", "DisturbanceReplaySeedMismatch", `${eventPath}.replay_seed_ref`, "Disturbance seed ref must match bundle replay seed.", "Use the bundle replay seed ref.");
    }
  }
}

function validateReplaySeedInto(seed: ReplaySeed, issues: ValidationIssue[], path: string): void {
  validateRef(seed.replay_seed_ref, issues, `${path}.replay_seed_ref`, "ReplaySeedRefInvalid");
  if (!Number.isInteger(seed.seed_u32) || seed.seed_u32 < 0 || seed.seed_u32 > 0xffffffff) {
    addIssue(issues, "error", "ReplaySeedInvalid", `${path}.seed_u32`, "Replay seed must be an unsigned 32-bit integer.", "Choose an integer in [0, 4294967295].");
  }
  if (seed.visibility !== "qa_only") {
    addIssue(issues, "error", "ReplaySeedVisibilityInvalid", `${path}.visibility`, "Replay seeds are QA-only.", "Set visibility to qa_only.");
  }
}

function validateManifestReferenceClosureInto(
  bundle: WorldManifestBundle,
  objectRefs: ReadonlySet<string>,
  materialRefs: ReadonlySet<string>,
  issues: ValidationIssue[],
): void {
  for (const ref of bundle.manifest.object_manifest_refs) {
    if (!objectRefs.has(ref)) {
      addIssue(issues, "error", "ManifestObjectRefMissing", "$.manifest.object_manifest_refs", `World manifest references missing object ${ref}.`, "Add the object descriptor or remove the ref.");
    }
  }
  for (const ref of bundle.manifest.material_profile_refs) {
    if (!materialRefs.has(ref)) {
      addIssue(issues, "error", "ManifestMaterialRefMissing", "$.manifest.material_profile_refs", `World manifest references missing material ${ref}.`, "Add the material profile or remove the ref.");
    }
  }
  if (bundle.manifest.embodiment_manifest_ref !== bundle.embodiment.embodiment_manifest_ref) {
    addIssue(issues, "error", "ManifestEmbodimentRefMismatch", "$.manifest.embodiment_manifest_ref", "Manifest embodiment ref must match the supplied embodiment descriptor.", "Pass the matching embodiment descriptor.");
  }
  if (bundle.manifest.disturbance_schedule_ref !== undefined && bundle.disturbance_schedule?.disturbance_schedule_ref !== bundle.manifest.disturbance_schedule_ref) {
    addIssue(issues, "error", "ManifestDisturbanceRefMismatch", "$.manifest.disturbance_schedule_ref", "Manifest disturbance schedule ref does not match supplied schedule.", "Pass the matching disturbance schedule.");
  }
  if (bundle.manifest.replay_seed_ref !== undefined && bundle.replay_seed?.replay_seed_ref !== bundle.manifest.replay_seed_ref) {
    addIssue(issues, "error", "ManifestReplaySeedRefMismatch", "$.manifest.replay_seed_ref", "Manifest replay seed ref does not match supplied replay seed.", "Pass the matching replay seed.");
  }
}

function validateTimestampIntervalInto(interval: TimestampInterval, issues: ValidationIssue[], path: string): void {
  if (!Number.isFinite(interval.start_s) || !Number.isFinite(interval.end_s) || interval.start_s < 0 || interval.end_s < interval.start_s) {
    addIssue(issues, "error", "TimestampIntervalInvalid", path, "Timestamp intervals must be finite, nonnegative, and ordered.", "Use start_s >= 0 and end_s >= start_s.");
  }
}

function addIssue(
  issues: ValidationIssue[],
  severity: ValidationSeverity,
  code: string,
  path: string,
  message: string,
  remediation: string,
): void {
  issues.push(Object.freeze({ severity, code, path, message, remediation }));
}

function validateRef(value: string, issues: ValidationIssue[], path: string, code: string): void {
  if (!isNonEmptyString(value) || /\s/.test(value)) {
    addIssue(issues, "error", code, path, "Reference must be a non-empty whitespace-free string.", "Use an opaque ref such as world_lab_v1 or object_cube_blue_01.");
  }
}

function validateRefArray(values: readonly string[], issues: ValidationIssue[], path: string, code: string): void {
  if (!Array.isArray(values) || values.length === 0) {
    addIssue(issues, "error", code, path, "Reference arrays must be non-empty.", "Provide at least one declared reference.");
    return;
  }
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    validateRef(values[index], issues, `${path}[${index}]`, code);
    if (seen.has(values[index])) {
      addIssue(issues, "error", `${code}Duplicate`, `${path}[${index}]`, "Reference arrays must not contain duplicates.", "Remove the duplicate ref.");
    }
    seen.add(values[index]);
  }
}

function validateNonEmptyString(value: string | undefined, issues: ValidationIssue[], path: string, code: string): void {
  if (!isNonEmptyString(value)) {
    addIssue(issues, "error", code, path, "Value must be a non-empty string.", "Provide a meaningful non-empty value.");
  }
}

function validateVector3(value: Vector3, issues: ValidationIssue[], path: string, code: string): void {
  if (!Array.isArray(value) || value.length !== 3 || value.some((component) => !Number.isFinite(component))) {
    addIssue(issues, "error", code, path, "Vector3 must contain exactly three finite numeric components.", "Use [x, y, z] in canonical units.");
  }
}

function validateQuaternion(value: Quaternion, issues: ValidationIssue[], path: string, code: string): void {
  if (!Array.isArray(value) || value.length !== 4 || value.some((component) => !Number.isFinite(component))) {
    addIssue(issues, "error", code, path, "Quaternion must contain exactly four finite numeric components.", "Use [x, y, z, w].");
    return;
  }
  const norm = Math.sqrt(value.reduce((sum, component) => sum + component * component, 0));
  if (norm < 1e-9 || Math.abs(norm - 1) > 1e-6) {
    addIssue(issues, "error", "QuaternionNotUnitLength", path, "Orientation quaternion must be normalized.", "Normalize the quaternion before constructing the manifest.");
  }
}

function validateRange(value: number, min: number, max: number, issues: ValidationIssue[], path: string, code: string): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    const upper = Number.isFinite(max) ? `${max}` : "infinity";
    addIssue(issues, "error", code, path, `Value must be finite and in range [${min}, ${upper}].`, "Choose a physically calibrated value.");
  }
}

function vectorNorm(value: Vector3): number {
  return Math.sqrt(value[0] * value[0] + value[1] * value[1] + value[2] * value[2]);
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isAxis(value: string): value is Axis {
  return value === "x" || value === "y" || value === "z";
}

function isSignedAxis(value: string): value is SignedAxis {
  return value === "x" || value === "y" || value === "z" || value === "-x" || value === "-y" || value === "-z";
}

function stripSign(axis: SignedAxis): Axis {
  return axis.startsWith("-") ? (axis.slice(1) as Axis) : (axis as Axis);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}
