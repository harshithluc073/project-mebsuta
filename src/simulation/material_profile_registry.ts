/**
 * Material profile registry for Project Mebsuta's physics-authoritative world.
 *
 * Blueprint: `architecture_docs/03_SIMULATION_AND_PHYSICS_ENGINE_ARCHITECTURE.md`
 * sections 3.5, 3.8, 3.12, 3.13, and 3.20.
 *
 * The registry owns executable material contracts used by contact modeling,
 * disturbance tests, acoustic event generation, object catalog validation, and
 * QA calibration. Material names, friction coefficients, restitution, contact
 * stiffness, damping, solver tolerances, and acoustic profile refs are simulator
 * truth. They must not be serialized into Gemini Robotics-ER 1.6 prompts unless
 * converted into sensor-derived evidence by downstream perception or contact
 * services.
 */

import { computeDeterminismHash } from "./world_manifest";
import type { MaterialProfile, Ref, ValidationIssue, ValidationSeverity } from "./world_manifest";

export const MATERIAL_REGISTRY_SCHEMA_VERSION = "mebsuta.material_profile_registry.v1" as const;
export const STANDARD_GRAVITY_M_PER_S2 = 9.80665;

export type CalibrationScenario =
  | "inclined_plane_hold"
  | "controlled_push_distance"
  | "rolling_cylinder_decay"
  | "drop_rebound"
  | "stack_compression"
  | "grasp_settle"
  | "tool_scrape";

export type ContactSoundClass = "soft_impact" | "sharp_impact" | "dull_impact" | "knock" | "muted_impact" | "scrape" | "ring";
export type ContactRegime = "sticking" | "sliding" | "separating";
export type DampingRegime = "undamped" | "underdamped" | "critical" | "overdamped";
export type MaterialValidationCode =
  | "MaterialRefInvalid"
  | "MaterialDuplicate"
  | "DisplayNameInvalid"
  | "StaticFrictionInvalid"
  | "DynamicFrictionInvalid"
  | "RollingResistanceInvalid"
  | "RestitutionInvalid"
  | "ContactStiffnessInvalid"
  | "ContactDampingInvalid"
  | "SolverToleranceInvalid"
  | "DynamicFrictionExceedsStatic"
  | "VisibilityLeak"
  | "AcousticProfileMissing"
  | "CalibrationEnvelopeRisk";

export interface MaterialRegistryEntry {
  readonly profile: MaterialProfile;
  readonly calibration_scenarios: readonly CalibrationScenario[];
  readonly contact_sound_classes: readonly ContactSoundClass[];
  readonly typical_risk: string;
  readonly created_at_iso?: string;
  readonly updated_at_iso?: string;
}

export interface MaterialPairContactProfile {
  readonly material_a_ref: Ref;
  readonly material_b_ref: Ref;
  readonly effective_static_friction: number;
  readonly effective_dynamic_friction: number;
  readonly effective_rolling_resistance: number;
  readonly effective_restitution: number;
  readonly effective_contact_stiffness_n_per_m: number;
  readonly effective_contact_damping_n_s_per_m: number;
  readonly solver_tolerance_m: number;
  readonly acoustic_profile_refs: readonly Ref[];
  readonly determinism_hash: string;
}

export interface FrictionConeEvaluation {
  readonly contact_regime: ContactRegime;
  readonly normal_force_n: number;
  readonly tangential_force_n: number;
  readonly friction_limit_n: number;
  readonly cone_half_angle_rad: number;
  readonly slip_margin_n: number;
  readonly utilization: number;
}

export interface InclinedPlanePrediction {
  readonly material_ref: Ref;
  readonly incline_angle_rad: number;
  readonly static_slip_threshold_rad: number;
  readonly should_slide: boolean;
  readonly downslope_acceleration_m_per_s2: number;
  readonly safety_margin_rad: number;
}

export interface ControlledPushPrediction {
  readonly material_ref: Ref;
  readonly initial_speed_m_per_s: number;
  readonly stop_distance_m: number;
  readonly stop_time_s: number;
  readonly deceleration_m_per_s2: number;
}

export interface DropTestPrediction {
  readonly material_a_ref: Ref;
  readonly material_b_ref: Ref;
  readonly release_height_m: number;
  readonly impact_speed_m_per_s: number;
  readonly rebound_height_m: number;
  readonly energy_retained_ratio: number;
}

export interface ContactOscillationPrediction {
  readonly effective_mass_kg: number;
  readonly natural_frequency_rad_per_s: number;
  readonly damping_ratio: number;
  readonly damping_regime: DampingRegime;
  readonly estimated_settle_time_s: number;
}

export interface GripForceEstimate {
  readonly material_ref: Ref;
  readonly carried_mass_kg: number;
  readonly contact_count: number;
  readonly safety_factor: number;
  readonly required_normal_force_per_contact_n: number;
  readonly total_required_normal_force_n: number;
}

export interface CalibrationGateReport {
  readonly ok: boolean;
  readonly material_count: number;
  readonly issue_count: number;
  readonly error_count: number;
  readonly warning_count: number;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface CognitiveSafeMaterialEvidence {
  readonly material_profile_ref: Ref;
  readonly allowed_summary: "material_properties_are_internal_truth";
  readonly observable_effects: readonly string[];
  readonly forbidden_fields_removed: readonly string[];
}

export class MaterialProfileRegistryError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "MaterialProfileRegistryError";
    this.issues = issues;
  }
}

/**
 * Registry for physics and QA material profiles.
 *
 * The class is intentionally immutable at the API boundary: callers receive
 * frozen snapshots, while mutation methods validate and replace entries. This
 * keeps replay determinism stable because hash generation sees canonicalized
 * material state rather than ambient object identity.
 */
export class MaterialProfileRegistry {
  private readonly entriesByRef: Map<Ref, MaterialRegistryEntry>;

  public constructor(entries: readonly MaterialRegistryEntry[] = []) {
    this.entriesByRef = new Map<Ref, MaterialRegistryEntry>();
    for (const entry of entries) {
      this.upsert(entry);
    }
  }

  public static withDefaultProfiles(): MaterialProfileRegistry {
    return new MaterialProfileRegistry(DEFAULT_MATERIAL_PROFILE_ENTRIES);
  }

  public upsert(entry: MaterialRegistryEntry): void {
    const report = validateMaterialRegistryEntries([entry]);
    if (!report.ok) {
      throw new MaterialProfileRegistryError(`Material profile ${entry.profile.material_profile_ref} failed validation.`, report.issues);
    }
    this.entriesByRef.set(entry.profile.material_profile_ref, freezeEntry(entry));
  }

  public remove(materialRef: Ref): boolean {
    return this.entriesByRef.delete(materialRef);
  }

  public has(materialRef: Ref): boolean {
    return this.entriesByRef.has(materialRef);
  }

  public get(materialRef: Ref): MaterialRegistryEntry {
    const entry = this.entriesByRef.get(materialRef);
    if (entry === undefined) {
      throw new MaterialProfileRegistryError(`Unknown material profile ref: ${materialRef}`, [
        makeIssue("error", "MaterialRefInvalid", "$.material_profile_ref", "Material profile ref is not registered.", "Register the material before resolving it."),
      ]);
    }
    return entry;
  }

  public list(): readonly MaterialRegistryEntry[] {
    return Object.freeze([...this.entriesByRef.values()].sort(compareEntries));
  }

  public refs(): readonly Ref[] {
    return Object.freeze([...this.entriesByRef.keys()].sort());
  }

  public validate(): CalibrationGateReport {
    return validateMaterialRegistryEntries(this.list());
  }

  public determinismHash(): string {
    return computeDeterminismHash(this.list());
  }

  /**
   * Combines two material profiles into a single contact pair contract.
   *
   * Friction coefficients are combined with the geometric mean. This is a stable
   * symmetric approximation for heterogeneous contacts and avoids allowing one
   * extreme material to dominate linearly. Contact stiffness uses a series spring
   * reduction,
   *
   *   k_eff = (k_a k_b) / (k_a + k_b)
   *
   * because two deformable contact layers compress in series. Restitution uses
   * the lower coefficient so contact does not create more bounce than the less
   * elastic side can physically support.
   */
  public resolveContactPair(materialARef: Ref, materialBRef: Ref): MaterialPairContactProfile {
    const a = this.get(materialARef).profile;
    const b = this.get(materialBRef).profile;
    const stiffness = harmonicSeriesStiffness(a.contact_stiffness_n_per_m, b.contact_stiffness_n_per_m);
    const acousticRefs = [a.acoustic_profile_ref, b.acoustic_profile_ref].filter(isDefined);
    return Object.freeze({
      material_a_ref: a.material_profile_ref,
      material_b_ref: b.material_profile_ref,
      effective_static_friction: geometricMean(a.static_friction, b.static_friction),
      effective_dynamic_friction: geometricMean(a.dynamic_friction, b.dynamic_friction),
      effective_rolling_resistance: Math.max(a.rolling_resistance, b.rolling_resistance),
      effective_restitution: Math.min(a.restitution, b.restitution),
      effective_contact_stiffness_n_per_m: stiffness,
      effective_contact_damping_n_s_per_m: a.contact_damping_n_s_per_m + b.contact_damping_n_s_per_m,
      solver_tolerance_m: Math.max(a.solver_tolerance_m, b.solver_tolerance_m),
      acoustic_profile_refs: Object.freeze(acousticRefs),
      determinism_hash: computeDeterminismHash([a.material_profile_ref, b.material_profile_ref, stiffness]),
    });
  }

  public evaluateFrictionCone(input: {
    readonly material_ref: Ref;
    readonly normal_force_n: number;
    readonly tangential_force_n: number;
    readonly use_dynamic_friction?: boolean;
  }): FrictionConeEvaluation {
    assertNonNegativeFinite(input.normal_force_n, "normal_force_n");
    assertNonNegativeFinite(input.tangential_force_n, "tangential_force_n");
    const profile = this.get(input.material_ref).profile;
    const mu = input.use_dynamic_friction === true ? profile.dynamic_friction : profile.static_friction;
    const frictionLimit = mu * input.normal_force_n;
    const slipMargin = frictionLimit - input.tangential_force_n;
    const utilization = frictionLimit === 0 ? Number.POSITIVE_INFINITY : input.tangential_force_n / frictionLimit;
    return Object.freeze({
      contact_regime: slipMargin >= 0 ? "sticking" : "sliding",
      normal_force_n: input.normal_force_n,
      tangential_force_n: input.tangential_force_n,
      friction_limit_n: frictionLimit,
      cone_half_angle_rad: Math.atan(mu),
      slip_margin_n: slipMargin,
      utilization,
    });
  }

  /**
   * Predicts whether a block slides on an inclined plane.
   *
   * At rest, downslope gravity is `m g sin(theta)` and normal force is
   * `m g cos(theta)`. Static hold fails when:
   *
   *   m g sin(theta) > mu_s m g cos(theta)
   *   tan(theta) > mu_s
   *
   * If sliding begins, acceleration is
   *   a = g (sin(theta) - mu_d cos(theta)).
   */
  public predictInclinedPlane(materialRef: Ref, inclineAngleRad: number): InclinedPlanePrediction {
    assertFinite(inclineAngleRad, "incline_angle_rad");
    const profile = this.get(materialRef).profile;
    const threshold = Math.atan(profile.static_friction);
    const shouldSlide = Math.tan(inclineAngleRad) > profile.static_friction;
    const acceleration = shouldSlide
      ? Math.max(0, STANDARD_GRAVITY_M_PER_S2 * (Math.sin(inclineAngleRad) - profile.dynamic_friction * Math.cos(inclineAngleRad)))
      : 0;
    return Object.freeze({
      material_ref: materialRef,
      incline_angle_rad: inclineAngleRad,
      static_slip_threshold_rad: threshold,
      should_slide: shouldSlide,
      downslope_acceleration_m_per_s2: acceleration,
      safety_margin_rad: threshold - inclineAngleRad,
    });
  }

  /**
   * Estimates sliding stop distance after a push using Coulomb friction.
   *
   * The kinetic energy `0.5 m v^2` is dissipated by work `mu_d m g d`, so mass
   * cancels and:
   *
   *   d = v^2 / (2 mu_d g)
   */
  public predictControlledPush(materialRef: Ref, initialSpeedMPerS: number): ControlledPushPrediction {
    assertNonNegativeFinite(initialSpeedMPerS, "initial_speed_m_per_s");
    const profile = this.get(materialRef).profile;
    const deceleration = profile.dynamic_friction * STANDARD_GRAVITY_M_PER_S2;
    const stopDistance = deceleration > 0 ? (initialSpeedMPerS * initialSpeedMPerS) / (2 * deceleration) : Number.POSITIVE_INFINITY;
    return Object.freeze({
      material_ref: materialRef,
      initial_speed_m_per_s: initialSpeedMPerS,
      stop_distance_m: stopDistance,
      stop_time_s: deceleration > 0 ? initialSpeedMPerS / deceleration : Number.POSITIVE_INFINITY,
      deceleration_m_per_s2: deceleration,
    });
  }

  public predictDropTest(materialARef: Ref, materialBRef: Ref, releaseHeightM: number): DropTestPrediction {
    assertNonNegativeFinite(releaseHeightM, "release_height_m");
    const pair = this.resolveContactPair(materialARef, materialBRef);
    const impactSpeed = Math.sqrt(2 * STANDARD_GRAVITY_M_PER_S2 * releaseHeightM);
    const energyRetained = pair.effective_restitution * pair.effective_restitution;
    return Object.freeze({
      material_a_ref: materialARef,
      material_b_ref: materialBRef,
      release_height_m: releaseHeightM,
      impact_speed_m_per_s: impactSpeed,
      rebound_height_m: energyRetained * releaseHeightM,
      energy_retained_ratio: energyRetained,
    });
  }

  /**
   * Evaluates contact oscillation for a mass-spring-damper approximation.
   *
   * Natural frequency is `omega_n = sqrt(k / m)` and damping ratio is
   * `zeta = c / (2 sqrt(k m))`. This is the control-facing metric behind the
   * architecture's "grasp settle" and "stack compression" calibration gates.
   */
  public predictContactOscillation(materialARef: Ref, materialBRef: Ref, effectiveMassKg: number): ContactOscillationPrediction {
    assertPositiveFinite(effectiveMassKg, "effective_mass_kg");
    const pair = this.resolveContactPair(materialARef, materialBRef);
    const omega = Math.sqrt(pair.effective_contact_stiffness_n_per_m / effectiveMassKg);
    const zeta = pair.effective_contact_damping_n_s_per_m / (2 * Math.sqrt(pair.effective_contact_stiffness_n_per_m * effectiveMassKg));
    return Object.freeze({
      effective_mass_kg: effectiveMassKg,
      natural_frequency_rad_per_s: omega,
      damping_ratio: zeta,
      damping_regime: classifyDampingRegime(zeta),
      estimated_settle_time_s: estimateSettlingTime(zeta, omega),
    });
  }

  public estimateGripForce(input: {
    readonly material_ref: Ref;
    readonly carried_mass_kg: number;
    readonly upward_acceleration_m_per_s2?: number;
    readonly contact_count: number;
    readonly safety_factor?: number;
  }): GripForceEstimate {
    assertPositiveFinite(input.carried_mass_kg, "carried_mass_kg");
    assertPositiveInteger(input.contact_count, "contact_count");
    const profile = this.get(input.material_ref).profile;
    const safetyFactor = input.safety_factor ?? 1.5;
    assertPositiveFinite(safetyFactor, "safety_factor");
    const acceleration = input.upward_acceleration_m_per_s2 ?? 0;
    assertFinite(acceleration, "upward_acceleration_m_per_s2");
    const requiredTangentialLoad = input.carried_mass_kg * (STANDARD_GRAVITY_M_PER_S2 + acceleration);
    const normalPerContact = profile.static_friction > 0
      ? (requiredTangentialLoad * safetyFactor) / (profile.static_friction * input.contact_count)
      : Number.POSITIVE_INFINITY;
    return Object.freeze({
      material_ref: input.material_ref,
      carried_mass_kg: input.carried_mass_kg,
      contact_count: input.contact_count,
      safety_factor: safetyFactor,
      required_normal_force_per_contact_n: normalPerContact,
      total_required_normal_force_n: normalPerContact * input.contact_count,
    });
  }

  public redactForCognition(materialRef: Ref): CognitiveSafeMaterialEvidence {
    const entry = this.get(materialRef);
    return Object.freeze({
      material_profile_ref: entry.profile.material_profile_ref,
      allowed_summary: "material_properties_are_internal_truth",
      observable_effects: Object.freeze([
        "visual appearance may be inferred from rendered camera frames",
        "slip or sticking may be inferred from declared contact sensors",
        "impact, scrape, and rolling sounds may be inferred from microphone packets",
      ]),
      forbidden_fields_removed: Object.freeze([
        "display_name",
        "static_friction",
        "dynamic_friction",
        "rolling_resistance",
        "restitution",
        "contact_stiffness_n_per_m",
        "contact_damping_n_s_per_m",
        "solver_tolerance_m",
        "acoustic_profile_ref",
        "typical_risk",
      ]),
    });
  }
}

export const DEFAULT_MATERIAL_PROFILE_ENTRIES: readonly MaterialRegistryEntry[] = Object.freeze([
  makeEntry({
    profile: {
      material_profile_ref: "matte_plastic",
      display_name: "Matte plastic",
      static_friction: 0.55,
      dynamic_friction: 0.42,
      rolling_resistance: 0.035,
      restitution: 0.18,
      contact_stiffness_n_per_m: 9000,
      contact_damping_n_s_per_m: 38,
      solver_tolerance_m: 0.0008,
      acoustic_profile_ref: "audio_soft_impact_mild_scrape",
      visibility: "qa_only",
    },
    calibration_scenarios: ["inclined_plane_hold", "controlled_push_distance", "drop_rebound", "grasp_settle"],
    contact_sound_classes: ["soft_impact", "scrape"],
    typical_risk: "May slide if grip force is low.",
  }),
  makeEntry({
    profile: {
      material_profile_ref: "smooth_metal",
      display_name: "Smooth metal",
      static_friction: 0.28,
      dynamic_friction: 0.21,
      rolling_resistance: 0.018,
      restitution: 0.48,
      contact_stiffness_n_per_m: 18000,
      contact_damping_n_s_per_m: 24,
      solver_tolerance_m: 0.0005,
      acoustic_profile_ref: "audio_sharp_impact_ringing_scrape",
      visibility: "qa_only",
    },
    calibration_scenarios: ["inclined_plane_hold", "controlled_push_distance", "rolling_cylinder_decay", "drop_rebound", "tool_scrape"],
    contact_sound_classes: ["sharp_impact", "ring", "scrape"],
    typical_risk: "Slips easily and is harder to lift.",
  }),
  makeEntry({
    profile: {
      material_profile_ref: "rubber",
      display_name: "Rubber",
      static_friction: 1.08,
      dynamic_friction: 0.86,
      rolling_resistance: 0.085,
      restitution: 0.12,
      contact_stiffness_n_per_m: 6500,
      contact_damping_n_s_per_m: 56,
      solver_tolerance_m: 0.001,
      acoustic_profile_ref: "audio_dull_impact",
      visibility: "qa_only",
    },
    calibration_scenarios: ["inclined_plane_hold", "controlled_push_distance", "grasp_settle", "stack_compression"],
    contact_sound_classes: ["dull_impact"],
    typical_risk: "Can stick unrealistically if friction is too high.",
  }),
  makeEntry({
    profile: {
      material_profile_ref: "wood",
      display_name: "Wood",
      static_friction: 0.48,
      dynamic_friction: 0.36,
      rolling_resistance: 0.045,
      restitution: 0.24,
      contact_stiffness_n_per_m: 11500,
      contact_damping_n_s_per_m: 32,
      solver_tolerance_m: 0.0007,
      acoustic_profile_ref: "audio_knock_and_scrape",
      visibility: "qa_only",
    },
    calibration_scenarios: ["inclined_plane_hold", "controlled_push_distance", "drop_rebound", "tool_scrape", "stack_compression"],
    contact_sound_classes: ["knock", "scrape"],
    typical_risk: "Good tool candidate behavior.",
  }),
  makeEntry({
    profile: {
      material_profile_ref: "foam",
      display_name: "Foam",
      static_friction: 0.72,
      dynamic_friction: 0.58,
      rolling_resistance: 0.12,
      restitution: 0.05,
      contact_stiffness_n_per_m: 2300,
      contact_damping_n_s_per_m: 74,
      solver_tolerance_m: 0.0025,
      acoustic_profile_ref: "audio_muted_impact",
      visibility: "qa_only",
    },
    calibration_scenarios: ["controlled_push_distance", "drop_rebound", "grasp_settle", "stack_compression"],
    contact_sound_classes: ["muted_impact"],
    typical_risk: "Hard to model contact deformation.",
  }),
  makeEntry({
    profile: {
      material_profile_ref: "glass_like",
      display_name: "Glass-like material",
      static_friction: 0.22,
      dynamic_friction: 0.16,
      rolling_resistance: 0.012,
      restitution: 0.62,
      contact_stiffness_n_per_m: 22000,
      contact_damping_n_s_per_m: 18,
      solver_tolerance_m: 0.0004,
      acoustic_profile_ref: "audio_sharp_tap",
      visibility: "qa_only",
    },
    calibration_scenarios: ["inclined_plane_hold", "controlled_push_distance", "drop_rebound"],
    contact_sound_classes: ["sharp_impact"],
    typical_risk: "Reflective perception ambiguity.",
  }),
]);

export function validateMaterialRegistryEntries(entries: readonly MaterialRegistryEntry[]): CalibrationGateReport {
  const issues: ValidationIssue[] = [];
  const refs = new Set<Ref>();

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const path = `$[${index}]`;
    validateEntryInto(entry, issues, path);
    if (refs.has(entry.profile.material_profile_ref)) {
      addIssue(issues, "error", "MaterialDuplicate", `${path}.profile.material_profile_ref`, "Material profile refs must be unique.", "Rename or remove the duplicate profile.");
    }
    refs.add(entry.profile.material_profile_ref);
  }

  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.length - errorCount;
  return Object.freeze({
    ok: errorCount === 0,
    material_count: entries.length,
    issue_count: issues.length,
    error_count: errorCount,
    warning_count: warningCount,
    issues: Object.freeze(issues),
    determinism_hash: computeDeterminismHash(entries),
  });
}

export function createMaterialProfileRegistry(entries: readonly MaterialRegistryEntry[] = DEFAULT_MATERIAL_PROFILE_ENTRIES): MaterialProfileRegistry {
  const report = validateMaterialRegistryEntries(entries);
  if (!report.ok) {
    throw new MaterialProfileRegistryError("Material registry failed validation.", report.issues);
  }
  return new MaterialProfileRegistry(entries);
}

function makeEntry(entry: MaterialRegistryEntry): MaterialRegistryEntry {
  return freezeEntry(entry);
}

function freezeEntry(entry: MaterialRegistryEntry): MaterialRegistryEntry {
  return Object.freeze({
    ...entry,
    profile: Object.freeze({ ...entry.profile }),
    calibration_scenarios: Object.freeze([...entry.calibration_scenarios]),
    contact_sound_classes: Object.freeze([...entry.contact_sound_classes]),
  });
}

function validateEntryInto(entry: MaterialRegistryEntry, issues: ValidationIssue[], path: string): void {
  validateProfileInto(entry.profile, issues, `${path}.profile`);
  if (entry.calibration_scenarios.length === 0) {
    addIssue(issues, "warning", "CalibrationEnvelopeRisk", `${path}.calibration_scenarios`, "Material has no QA calibration scenarios.", "Attach at least one calibration scenario before benchmark use.");
  }
  if (entry.contact_sound_classes.length === 0 || entry.profile.acoustic_profile_ref === undefined) {
    addIssue(issues, "warning", "AcousticProfileMissing", `${path}`, "Material has incomplete acoustic contact metadata.", "Attach an acoustic profile and sound class if audio reasoning may observe this material.");
  }
  if (!isNonEmptyString(entry.typical_risk)) {
    addIssue(issues, "warning", "CalibrationEnvelopeRisk", `${path}.typical_risk`, "Material should document a typical risk for QA review.", "Describe slip, sticking, bounce, deformation, or perception risk.");
  }
}

function validateProfileInto(profile: MaterialProfile, issues: ValidationIssue[], path: string): void {
  validateRef(profile.material_profile_ref, issues, `${path}.material_profile_ref`, "MaterialRefInvalid");
  validateNonEmptyString(profile.display_name, issues, `${path}.display_name`, "DisplayNameInvalid");
  validateRange(profile.static_friction, 0, 5, issues, `${path}.static_friction`, "StaticFrictionInvalid");
  validateRange(profile.dynamic_friction, 0, 5, issues, `${path}.dynamic_friction`, "DynamicFrictionInvalid");
  validateRange(profile.rolling_resistance, 0, 1, issues, `${path}.rolling_resistance`, "RollingResistanceInvalid");
  validateRange(profile.restitution, 0, 1, issues, `${path}.restitution`, "RestitutionInvalid");
  validateRange(profile.contact_stiffness_n_per_m, 1, Number.POSITIVE_INFINITY, issues, `${path}.contact_stiffness_n_per_m`, "ContactStiffnessInvalid");
  validateRange(profile.contact_damping_n_s_per_m, 0, Number.POSITIVE_INFINITY, issues, `${path}.contact_damping_n_s_per_m`, "ContactDampingInvalid");
  validateRange(profile.solver_tolerance_m, 0, 0.1, issues, `${path}.solver_tolerance_m`, "SolverToleranceInvalid");

  if (profile.dynamic_friction > profile.static_friction) {
    addIssue(issues, "warning", "DynamicFrictionExceedsStatic", path, "Dynamic friction exceeds static friction; most contact models expect dynamic <= static.", "Confirm this is a deliberate nonstandard material.");
  }
  if (profile.visibility === "cognitive_allowed" || profile.visibility === "cognitive_calibration_only") {
    addIssue(issues, "error", "VisibilityLeak", `${path}.visibility`, "Material parameters are simulator truth and cannot be cognitive-visible.", "Use qa_only, validator_only, sensor_derived_only, or forbidden_to_cognition.");
  }
}

function classifyDampingRegime(zeta: number): DampingRegime {
  if (zeta <= 0) {
    return "undamped";
  }
  if (zeta < 0.95) {
    return "underdamped";
  }
  if (zeta <= 1.05) {
    return "critical";
  }
  return "overdamped";
}

function estimateSettlingTime(zeta: number, omega: number): number {
  if (omega <= 0 || zeta <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  if (zeta <= 1) {
    return 4 / (zeta * omega);
  }
  const slowPole = omega * (zeta - Math.sqrt(zeta * zeta - 1));
  return slowPole > 0 ? 4 / slowPole : Number.POSITIVE_INFINITY;
}

function harmonicSeriesStiffness(a: number, b: number): number {
  return (a * b) / (a + b);
}

function geometricMean(a: number, b: number): number {
  return Math.sqrt(Math.max(0, a) * Math.max(0, b));
}

function compareEntries(a: MaterialRegistryEntry, b: MaterialRegistryEntry): number {
  return a.profile.material_profile_ref.localeCompare(b.profile.material_profile_ref);
}

function makeIssue(severity: ValidationSeverity, code: MaterialValidationCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function addIssue(issues: ValidationIssue[], severity: ValidationSeverity, code: MaterialValidationCode, path: string, message: string, remediation: string): void {
  issues.push(makeIssue(severity, code, path, message, remediation));
}

function validateRef(value: string, issues: ValidationIssue[], path: string, code: MaterialValidationCode): void {
  if (!isNonEmptyString(value) || /\s/.test(value)) {
    addIssue(issues, "error", code, path, "Reference must be a non-empty whitespace-free string.", "Use an opaque ref such as matte_plastic or audio_soft_impact.");
  }
}

function validateNonEmptyString(value: string | undefined, issues: ValidationIssue[], path: string, code: MaterialValidationCode): void {
  if (!isNonEmptyString(value)) {
    addIssue(issues, "error", code, path, "Value must be a non-empty string.", "Provide a meaningful non-empty value.");
  }
}

function validateRange(value: number, min: number, max: number, issues: ValidationIssue[], path: string, code: MaterialValidationCode): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    const upper = Number.isFinite(max) ? `${max}` : "infinity";
    addIssue(issues, "error", code, path, `Value must be finite and in range [${min}, ${upper}].`, "Choose a physically calibrated value.");
  }
}

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite.`);
  }
}

function assertNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a nonnegative finite number.`);
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

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
