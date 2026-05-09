/**
 * Object physics catalog for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/03_SIMULATION_AND_PHYSICS_ENGINE_ARCHITECTURE.md`
 * sections 3.5, 3.7, 3.8, 3.13, 3.14, and 3.20, with coordinate-frame
 * alignment from `10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md`.
 *
 * The catalog owns executable object descriptors: role, collision shape,
 * visual shape, mass, inertia, material binding, initial simulator transform,
 * movability policy, render traits, and internal affordance hints. These are
 * simulator-truth fields. They are valid for physics, validators, QA, replay,
 * disturbance targeting, and rendering setup; they are not model-facing
 * knowledge for Gemini Robotics-ER 1.6.
 */

import { MaterialProfileRegistry } from "./material_profile_registry";
import { computeDeterminismHash } from "./world_manifest";
import type {
  InertiaTensor,
  MaterialProfile,
  MovabilityPolicy,
  ObjectPhysicsDescriptor,
  ObjectRole,
  Quaternion,
  Ref,
  RenderTraits,
  Transform,
  ValidationIssue,
  ValidationSeverity,
  Vector3,
  WorldBounds,
  WorldManifest,
} from "./world_manifest";

export const OBJECT_PHYSICS_CATALOG_SCHEMA_VERSION = "mebsuta.object_physics_catalog.v1" as const;
const ZERO_VECTOR: Vector3 = [0, 0, 0];

export type CollisionShapeKind = "box" | "sphere" | "cylinder" | "capsule" | "convex_hull" | "mesh_proxy";
export type VisualShapeKind = "box" | "sphere" | "cylinder" | "capsule" | "mesh" | "billboard";
export type ObjectReadiness = "physics_ready" | "render_only" | "qa_only" | "invalid";
export type CognitiveObjectVisibility = "visible_as_sensor_evidence" | "hidden_internal_only";

export interface CollisionShapeDescriptor {
  readonly collision_shape_ref: Ref;
  readonly shape_kind: CollisionShapeKind;
  readonly half_extents_m?: Vector3;
  readonly radius_m?: number;
  readonly height_m?: number;
  readonly local_offset_m?: Vector3;
  readonly local_orientation_xyzw?: Quaternion;
  readonly qa_only_mesh_ref?: Ref;
}

export interface VisualShapeDescriptor {
  readonly visual_shape_ref: Ref;
  readonly shape_kind: VisualShapeKind;
  readonly render_asset_ref?: Ref;
  readonly visible_dimensions_m?: Vector3;
  readonly local_offset_m?: Vector3;
  readonly local_orientation_xyzw?: Quaternion;
}

export interface ObjectCatalogEntry {
  readonly descriptor: ObjectPhysicsDescriptor;
  readonly collision_shape: CollisionShapeDescriptor;
  readonly visual_shape: VisualShapeDescriptor;
  readonly readiness: ObjectReadiness;
  readonly qa_tags?: readonly string[];
}

export interface ObjectCatalogValidationReport {
  readonly ok: boolean;
  readonly object_count: number;
  readonly dynamic_object_count: number;
  readonly fixed_object_count: number;
  readonly issue_count: number;
  readonly error_count: number;
  readonly warning_count: number;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface ObjectMassProperties {
  readonly object_ref: Ref;
  readonly mass_kg: number;
  readonly inertia_tensor: InertiaTensor;
  readonly center_of_mass_local_m: Vector3;
  readonly is_dynamic: boolean;
}

export interface AxisAlignedBounds {
  readonly min_m: Vector3;
  readonly max_m: Vector3;
}

export interface ObjectSpatialEnvelope {
  readonly object_ref: Ref;
  readonly frame_ref: Ref;
  readonly world_aabb_m: AxisAlignedBounds;
  readonly bounding_radius_m: number;
  readonly determinism_hash: string;
}

export interface CatalogManifestClosureReport {
  readonly ok: boolean;
  readonly manifest_ref: Ref;
  readonly missing_object_refs: readonly Ref[];
  readonly extra_catalog_refs: readonly Ref[];
  readonly missing_material_refs: readonly Ref[];
  readonly qa_marker_refs: readonly Ref[];
  readonly determinism_hash: string;
}

export interface CognitiveSafeObjectEvidence {
  readonly object_ref: Ref;
  readonly cognitive_visibility: CognitiveObjectVisibility;
  readonly sensor_visible_traits?: RenderTraits;
  readonly forbidden_fields_removed: readonly string[];
}

export class ObjectPhysicsCatalogError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "ObjectPhysicsCatalogError";
    this.issues = issues;
  }
}

export class ObjectPhysicsCatalog {
  private readonly entriesByRef: Map<Ref, ObjectCatalogEntry>;
  private readonly collisionRefs: Map<Ref, Ref>;
  private readonly visualRefs: Map<Ref, Ref>;

  public constructor(
    entries: readonly ObjectCatalogEntry[] = [],
    private readonly materialRegistry: MaterialProfileRegistry = MaterialProfileRegistry.withDefaultProfiles(),
  ) {
    this.entriesByRef = new Map<Ref, ObjectCatalogEntry>();
    this.collisionRefs = new Map<Ref, Ref>();
    this.visualRefs = new Map<Ref, Ref>();
    for (const entry of entries) {
      this.upsert(entry);
    }
  }

  public upsert(entry: ObjectCatalogEntry): void {
    const report = validateObjectCatalogEntries([entry], this.materialRegistry);
    if (!report.ok) {
      throw new ObjectPhysicsCatalogError(`Object ${entry.descriptor.object_ref} failed validation.`, report.issues);
    }

    const frozen = freezeEntry(entry);
    const existing = this.entriesByRef.get(frozen.descriptor.object_ref);
    if (existing !== undefined) {
      this.collisionRefs.delete(existing.collision_shape.collision_shape_ref);
      this.visualRefs.delete(existing.visual_shape.visual_shape_ref);
    }
    this.entriesByRef.set(frozen.descriptor.object_ref, frozen);
    this.collisionRefs.set(frozen.collision_shape.collision_shape_ref, frozen.descriptor.object_ref);
    this.visualRefs.set(frozen.visual_shape.visual_shape_ref, frozen.descriptor.object_ref);
  }

  public remove(objectRef: Ref): boolean {
    const entry = this.entriesByRef.get(objectRef);
    if (entry === undefined) {
      return false;
    }
    this.collisionRefs.delete(entry.collision_shape.collision_shape_ref);
    this.visualRefs.delete(entry.visual_shape.visual_shape_ref);
    return this.entriesByRef.delete(objectRef);
  }

  public has(objectRef: Ref): boolean {
    return this.entriesByRef.has(objectRef);
  }

  public get(objectRef: Ref): ObjectCatalogEntry {
    const entry = this.entriesByRef.get(objectRef);
    if (entry === undefined) {
      throw new ObjectPhysicsCatalogError(`Unknown object ref: ${objectRef}`, [
        makeIssue("error", "ObjectRefInvalid", "$.object_ref", "Object ref is not registered.", "Register the object before resolving it."),
      ]);
    }
    return entry;
  }

  public getByCollisionShapeRef(collisionShapeRef: Ref): ObjectCatalogEntry {
    const objectRef = this.collisionRefs.get(collisionShapeRef);
    if (objectRef === undefined) {
      throw new ObjectPhysicsCatalogError(`Unknown collision shape ref: ${collisionShapeRef}`, [
        makeIssue("error", "CollisionShapeRefInvalid", "$.collision_shape_ref", "Collision shape ref is not registered.", "Register the object collision shape first."),
      ]);
    }
    return this.get(objectRef);
  }

  public getByVisualShapeRef(visualShapeRef: Ref): ObjectCatalogEntry {
    const objectRef = this.visualRefs.get(visualShapeRef);
    if (objectRef === undefined) {
      throw new ObjectPhysicsCatalogError(`Unknown visual shape ref: ${visualShapeRef}`, [
        makeIssue("error", "VisualShapeRefInvalid", "$.visual_shape_ref", "Visual shape ref is not registered.", "Register the object visual shape first."),
      ]);
    }
    return this.get(objectRef);
  }

  public list(): readonly ObjectCatalogEntry[] {
    return Object.freeze([...this.entriesByRef.values()].sort(compareEntries));
  }

  public refsByRole(role: ObjectRole): readonly Ref[] {
    return Object.freeze(this.list().filter((entry) => entry.descriptor.object_role === role).map((entry) => entry.descriptor.object_ref));
  }

  public refsByMovability(policy: MovabilityPolicy): readonly Ref[] {
    return Object.freeze(this.list().filter((entry) => entry.descriptor.movability_policy === policy).map((entry) => entry.descriptor.object_ref));
  }

  public validate(): ObjectCatalogValidationReport {
    return validateObjectCatalogEntries(this.list(), this.materialRegistry);
  }

  public determinismHash(): string {
    return computeDeterminismHash(this.list());
  }

  public resolveMaterial(objectRef: Ref): MaterialProfile {
    const entry = this.get(objectRef);
    return this.materialRegistry.get(entry.descriptor.material_profile_ref).profile;
  }

  public resolveMassProperties(objectRef: Ref): ObjectMassProperties {
    const entry = this.get(objectRef);
    const descriptor = entry.descriptor;
    const dynamic = isDynamicMovability(descriptor.movability_policy);
    if (!dynamic) {
      return Object.freeze({
        object_ref: descriptor.object_ref,
        mass_kg: descriptor.mass_kg ?? Number.POSITIVE_INFINITY,
        inertia_tensor: descriptor.inertia_tensor ?? infiniteInertia(),
        center_of_mass_local_m: ZERO_VECTOR,
        is_dynamic: false,
      });
    }

    if (descriptor.mass_kg === undefined || descriptor.inertia_tensor === undefined) {
      throw new ObjectPhysicsCatalogError(`Dynamic object ${objectRef} is missing mass properties.`, [
        makeIssue("error", "DynamicMassPropertiesMissing", "$.descriptor", "Dynamic objects require mass and inertia tensor.", "Provide positive mass and inertia before physics initialization."),
      ]);
    }

    return Object.freeze({
      object_ref: descriptor.object_ref,
      mass_kg: descriptor.mass_kg,
      inertia_tensor: descriptor.inertia_tensor,
      center_of_mass_local_m: entry.collision_shape.local_offset_m ?? ZERO_VECTOR,
      is_dynamic: true,
    });
  }

  public computeSpatialEnvelope(objectRef: Ref): ObjectSpatialEnvelope {
    const entry = this.get(objectRef);
    const extents = estimateLocalHalfExtents(entry.collision_shape, entry.descriptor.render_traits);
    const rotationAbs = absoluteRotationMatrixFromQuaternion(entry.descriptor.initial_transform.orientation_xyzw);
    const rotatedHalfExtents = multiplyMatrix3Vector3(rotationAbs, extents);
    const center = addVector3(entry.descriptor.initial_transform.position_m, entry.collision_shape.local_offset_m ?? [0, 0, 0]);
    const aabb = Object.freeze({
      min_m: subtractVector3(center, rotatedHalfExtents),
      max_m: addVector3(center, rotatedHalfExtents),
    });
    return Object.freeze({
      object_ref: objectRef,
      frame_ref: entry.descriptor.initial_transform.frame_ref,
      world_aabb_m: aabb,
      bounding_radius_m: vectorNorm(extents),
      determinism_hash: computeDeterminismHash([objectRef, aabb]),
    });
  }

  public validateAgainstWorldManifest(manifest: WorldManifest): CatalogManifestClosureReport {
    const catalogRefs = new Set(this.list().map((entry) => entry.descriptor.object_ref));
    const manifestRefs = new Set(manifest.object_manifest_refs);
    const materialRefs = new Set(manifest.material_profile_refs);
    const missingObjectRefs = manifest.object_manifest_refs.filter((ref) => !catalogRefs.has(ref));
    const extraCatalogRefs = this.list().map((entry) => entry.descriptor.object_ref).filter((ref) => !manifestRefs.has(ref));
    const missingMaterialRefs = this.list()
      .map((entry) => entry.descriptor.material_profile_ref)
      .filter((ref, index, refs) => refs.indexOf(ref) === index && !materialRefs.has(ref));
    const qaMarkerRefs = this.refsByRole("qa_only_marker");

    return Object.freeze({
      ok: missingObjectRefs.length === 0 && missingMaterialRefs.length === 0,
      manifest_ref: manifest.world_manifest_id,
      missing_object_refs: Object.freeze(missingObjectRefs),
      extra_catalog_refs: Object.freeze(extraCatalogRefs),
      missing_material_refs: Object.freeze(missingMaterialRefs),
      qa_marker_refs: Object.freeze(qaMarkerRefs),
      determinism_hash: computeDeterminismHash([manifest.world_manifest_id, missingObjectRefs, extraCatalogRefs, missingMaterialRefs, qaMarkerRefs]),
    });
  }

  public assertWithinWorldBounds(objectRef: Ref, worldBounds: WorldBounds): void {
    const envelope = this.computeSpatialEnvelope(objectRef);
    const issues: ValidationIssue[] = [];
    validateAabbWithinWorld(envelope.world_aabb_m, worldBounds, issues, `$.objects.${objectRef}.world_aabb_m`);
    if (issues.length > 0) {
      throw new ObjectPhysicsCatalogError(`Object ${objectRef} is outside world bounds.`, issues);
    }
  }

  public redactForCognition(objectRef: Ref): CognitiveSafeObjectEvidence {
    const entry = this.get(objectRef);
    const visible = entry.descriptor.cognitive_visibility === "visible_through_sensors_only" && entry.descriptor.object_role !== "qa_only_marker";
    return Object.freeze({
      object_ref: entry.descriptor.object_ref,
      cognitive_visibility: visible ? "visible_as_sensor_evidence" : "hidden_internal_only",
      sensor_visible_traits: visible ? entry.descriptor.render_traits : undefined,
      forbidden_fields_removed: Object.freeze([
        "object_role",
        "collision_shape_ref",
        "visual_shape_ref",
        "mass_kg",
        "inertia_tensor",
        "material_profile_ref",
        "initial_transform",
        "movability_policy",
        "affordance_hint_internal",
        "audio_profile_ref",
        "qa_tags",
      ]),
    });
  }
}

export function validateObjectCatalogEntries(
  entries: readonly ObjectCatalogEntry[],
  materialRegistry: MaterialProfileRegistry = MaterialProfileRegistry.withDefaultProfiles(),
): ObjectCatalogValidationReport {
  const issues: ValidationIssue[] = [];
  const objectRefs = new Set<Ref>();
  const collisionRefs = new Set<Ref>();
  const visualRefs = new Set<Ref>();

  for (let index = 0; index < entries.length; index += 1) {
    const path = `$[${index}]`;
    const entry = entries[index];
    validateEntryInto(entry, materialRegistry, issues, path);
    checkUnique(entry.descriptor.object_ref, objectRefs, issues, `${path}.descriptor.object_ref`, "ObjectRefDuplicate", "Object refs must be unique.");
    checkUnique(entry.collision_shape.collision_shape_ref, collisionRefs, issues, `${path}.collision_shape.collision_shape_ref`, "CollisionShapeRefDuplicate", "Collision shape refs must be unique.");
    checkUnique(entry.visual_shape.visual_shape_ref, visualRefs, issues, `${path}.visual_shape.visual_shape_ref`, "VisualShapeRefDuplicate", "Visual shape refs must be unique.");
  }

  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.length - errorCount;
  const dynamicCount = entries.filter((entry) => isDynamicMovability(entry.descriptor.movability_policy)).length;
  return Object.freeze({
    ok: errorCount === 0,
    object_count: entries.length,
    dynamic_object_count: dynamicCount,
    fixed_object_count: entries.length - dynamicCount,
    issue_count: issues.length,
    error_count: errorCount,
    warning_count: warningCount,
    issues: Object.freeze(issues),
    determinism_hash: computeDeterminismHash(entries),
  });
}

export function createObjectPhysicsCatalog(
  entries: readonly ObjectCatalogEntry[],
  materialRegistry: MaterialProfileRegistry = MaterialProfileRegistry.withDefaultProfiles(),
): ObjectPhysicsCatalog {
  const report = validateObjectCatalogEntries(entries, materialRegistry);
  if (!report.ok) {
    throw new ObjectPhysicsCatalogError("Object physics catalog failed validation.", report.issues);
  }
  return new ObjectPhysicsCatalog(entries, materialRegistry);
}

export function createBoxInertia(massKg: number, dimensionsM: Vector3): InertiaTensor {
  assertPositiveFinite(massKg, "mass_kg");
  assertPositiveVector3(dimensionsM, "dimensions_m");
  const [x, y, z] = dimensionsM;
  /*
   * Solid cuboid inertia about its center of mass:
   * I_xx = 1/12 m (y^2 + z^2), and cyclic permutations.
   */
  return Object.freeze({
    ixx_kg_m2: (massKg / 12) * (y * y + z * z),
    iyy_kg_m2: (massKg / 12) * (x * x + z * z),
    izz_kg_m2: (massKg / 12) * (x * x + y * y),
    ixy_kg_m2: 0,
    ixz_kg_m2: 0,
    iyz_kg_m2: 0,
  });
}

export function createSphereInertia(massKg: number, radiusM: number): InertiaTensor {
  assertPositiveFinite(massKg, "mass_kg");
  assertPositiveFinite(radiusM, "radius_m");
  const inertia = (2 / 5) * massKg * radiusM * radiusM;
  return Object.freeze({
    ixx_kg_m2: inertia,
    iyy_kg_m2: inertia,
    izz_kg_m2: inertia,
    ixy_kg_m2: 0,
    ixz_kg_m2: 0,
    iyz_kg_m2: 0,
  });
}

export function createSolidCylinderInertia(massKg: number, radiusM: number, heightM: number, cylinderAxis: "x" | "y" | "z" = "z"): InertiaTensor {
  assertPositiveFinite(massKg, "mass_kg");
  assertPositiveFinite(radiusM, "radius_m");
  assertPositiveFinite(heightM, "height_m");
  const axial = 0.5 * massKg * radiusM * radiusM;
  const transverse = (massKg / 12) * (3 * radiusM * radiusM + heightM * heightM);
  const values = cylinderAxis === "x"
    ? [axial, transverse, transverse]
    : cylinderAxis === "y"
      ? [transverse, axial, transverse]
      : [transverse, transverse, axial];
  return Object.freeze({
    ixx_kg_m2: values[0],
    iyy_kg_m2: values[1],
    izz_kg_m2: values[2],
    ixy_kg_m2: 0,
    ixz_kg_m2: 0,
    iyz_kg_m2: 0,
  });
}

export function createObjectDescriptor(input: {
  readonly object_ref: Ref;
  readonly object_role: ObjectRole;
  readonly collision_shape_ref: Ref;
  readonly visual_shape_ref: Ref;
  readonly material_profile_ref: Ref;
  readonly initial_transform: Transform;
  readonly movability_policy: MovabilityPolicy;
  readonly render_traits: RenderTraits;
  readonly mass_kg?: number;
  readonly inertia_tensor?: InertiaTensor;
  readonly affordance_hint_internal?: string;
  readonly audio_profile_ref?: Ref;
  readonly cognitive_visibility?: "visible_through_sensors_only" | "not_visible";
}): ObjectPhysicsDescriptor {
  return Object.freeze({
    ...input,
    cognitive_visibility: input.cognitive_visibility ?? (input.object_role === "qa_only_marker" ? "not_visible" : "visible_through_sensors_only"),
  });
}

function validateEntryInto(entry: ObjectCatalogEntry, materialRegistry: MaterialProfileRegistry, issues: ValidationIssue[], path: string): void {
  validateDescriptorInto(entry.descriptor, materialRegistry, issues, `${path}.descriptor`);
  validateCollisionShapeInto(entry.collision_shape, issues, `${path}.collision_shape`);
  validateVisualShapeInto(entry.visual_shape, issues, `${path}.visual_shape`);

  if (entry.descriptor.collision_shape_ref !== entry.collision_shape.collision_shape_ref) {
    addIssue(issues, "error", "CollisionShapeRefMismatch", path, "Descriptor collision_shape_ref must match the supplied collision shape descriptor.", "Use one collision shape ref for both records.");
  }
  if (entry.descriptor.visual_shape_ref !== entry.visual_shape.visual_shape_ref) {
    addIssue(issues, "error", "VisualShapeRefMismatch", path, "Descriptor visual_shape_ref must match the supplied visual shape descriptor.", "Use one visual shape ref for both records.");
  }
  if (entry.readiness === "physics_ready" && entry.descriptor.object_role === "qa_only_marker") {
    addIssue(issues, "error", "QAMarkerPhysicsReady", `${path}.readiness`, "QA-only markers cannot be physics-ready runtime objects.", "Use qa_only readiness for hidden markers.");
  }
}

function validateDescriptorInto(descriptor: ObjectPhysicsDescriptor, materialRegistry: MaterialProfileRegistry, issues: ValidationIssue[], path: string): void {
  validateRef(descriptor.object_ref, issues, `${path}.object_ref`, "ObjectRefInvalid");
  validateRef(descriptor.collision_shape_ref, issues, `${path}.collision_shape_ref`, "CollisionShapeRefInvalid");
  validateRef(descriptor.visual_shape_ref, issues, `${path}.visual_shape_ref`, "VisualShapeRefInvalid");
  validateRef(descriptor.material_profile_ref, issues, `${path}.material_profile_ref`, "MaterialProfileRefInvalid");
  validateTransformInto(descriptor.initial_transform, issues, `${path}.initial_transform`);
  validateRenderTraitsInto(descriptor.render_traits, issues, `${path}.render_traits`);

  if (!materialRegistry.has(descriptor.material_profile_ref)) {
    addIssue(issues, "error", "MaterialRefMissing", `${path}.material_profile_ref`, "Object references a material profile that is not registered.", "Register the material before adding the object.");
  }

  const dynamic = isDynamicMovability(descriptor.movability_policy);
  if (dynamic) {
    if (descriptor.mass_kg === undefined || !Number.isFinite(descriptor.mass_kg) || descriptor.mass_kg <= 0) {
      addIssue(issues, "error", "DynamicMassInvalid", `${path}.mass_kg`, "Dynamic and constrained objects require positive finite mass.", "Provide mass in kilograms.");
    }
    if (descriptor.inertia_tensor === undefined) {
      addIssue(issues, "error", "DynamicInertiaMissing", `${path}.inertia_tensor`, "Dynamic and constrained objects require an inertia tensor.", "Compute inertia from physical dimensions or supply a calibrated tensor.");
    } else {
      validateInertiaTensorInto(descriptor.inertia_tensor, issues, `${path}.inertia_tensor`);
    }
  }

  if (descriptor.movability_policy === "fixed" && descriptor.object_role === "movable_task_object") {
    addIssue(issues, "warning", "MovableRoleFixedPolicy", path, "Movable task object has fixed movability policy.", "Use dynamic or constrained unless the object is intentionally immobilized.");
  }
  if (descriptor.object_role === "qa_only_marker" && descriptor.cognitive_visibility !== "not_visible") {
    addIssue(issues, "error", "QAMarkerVisible", `${path}.cognitive_visibility`, "QA-only markers must not be cognitive-visible.", "Set cognitive_visibility to not_visible.");
  }
  if (descriptor.affordance_hint_internal !== undefined && descriptor.affordance_hint_internal.trim().length > 0 && descriptor.cognitive_visibility === "visible_through_sensors_only") {
    addIssue(issues, "warning", "InternalAffordanceHint", `${path}.affordance_hint_internal`, "Affordance hints are hidden developer truth.", "Ensure prompt builders never serialize this field.");
  }
}

function validateCollisionShapeInto(shape: CollisionShapeDescriptor, issues: ValidationIssue[], path: string): void {
  validateRef(shape.collision_shape_ref, issues, `${path}.collision_shape_ref`, "CollisionShapeRefInvalid");
  if (!["box", "sphere", "cylinder", "capsule", "convex_hull", "mesh_proxy"].includes(shape.shape_kind)) {
    addIssue(issues, "error", "CollisionShapeKindInvalid", `${path}.shape_kind`, "Collision shape kind is unsupported.", "Use a supported architecture-level collision shape.");
  }
  if (shape.shape_kind === "box") {
    validatePositiveVector3(shape.half_extents_m, issues, `${path}.half_extents_m`, "CollisionDimensionsInvalid");
  }
  if (shape.shape_kind === "sphere") {
    validatePositiveNumber(shape.radius_m, issues, `${path}.radius_m`, "CollisionDimensionsInvalid");
  }
  if (shape.shape_kind === "cylinder" || shape.shape_kind === "capsule") {
    validatePositiveNumber(shape.radius_m, issues, `${path}.radius_m`, "CollisionDimensionsInvalid");
    validatePositiveNumber(shape.height_m, issues, `${path}.height_m`, "CollisionDimensionsInvalid");
  }
  if ((shape.shape_kind === "convex_hull" || shape.shape_kind === "mesh_proxy") && !isNonEmptyString(shape.qa_only_mesh_ref)) {
    addIssue(issues, "warning", "CollisionMeshProxyUnspecified", `${path}.qa_only_mesh_ref`, "Mesh-like collision shapes should carry a QA-only mesh ref.", "Provide a QA-only proxy mesh ref for debugging and replay.");
  }
  if (shape.local_offset_m !== undefined) {
    validateVector3(shape.local_offset_m, issues, `${path}.local_offset_m`, "CollisionOffsetInvalid");
  }
  if (shape.local_orientation_xyzw !== undefined) {
    validateQuaternion(shape.local_orientation_xyzw, issues, `${path}.local_orientation_xyzw`, "CollisionOrientationInvalid");
  }
}

function validateVisualShapeInto(shape: VisualShapeDescriptor, issues: ValidationIssue[], path: string): void {
  validateRef(shape.visual_shape_ref, issues, `${path}.visual_shape_ref`, "VisualShapeRefInvalid");
  if (!["box", "sphere", "cylinder", "capsule", "mesh", "billboard"].includes(shape.shape_kind)) {
    addIssue(issues, "error", "VisualShapeKindInvalid", `${path}.shape_kind`, "Visual shape kind is unsupported.", "Use a supported architecture-level visual shape.");
  }
  if (shape.visible_dimensions_m !== undefined) {
    validatePositiveVector3(shape.visible_dimensions_m, issues, `${path}.visible_dimensions_m`, "VisualDimensionsInvalid");
  }
  if (shape.local_offset_m !== undefined) {
    validateVector3(shape.local_offset_m, issues, `${path}.local_offset_m`, "VisualOffsetInvalid");
  }
  if (shape.local_orientation_xyzw !== undefined) {
    validateQuaternion(shape.local_orientation_xyzw, issues, `${path}.local_orientation_xyzw`, "VisualOrientationInvalid");
  }
}

function validateTransformInto(transform: Transform, issues: ValidationIssue[], path: string): void {
  validateRef(transform.frame_ref, issues, `${path}.frame_ref`, "TransformFrameRefInvalid");
  validateVector3(transform.position_m, issues, `${path}.position_m`, "TransformPositionInvalid");
  validateQuaternion(transform.orientation_xyzw, issues, `${path}.orientation_xyzw`, "TransformOrientationInvalid");
  if (transform.frame_ref !== "W") {
    addIssue(issues, "warning", "InitialTransformNotSimulatorWorld", `${path}.frame_ref`, "Initial physics transforms are expected in simulator truth frame W.", "Confirm this object is intentionally initialized in another internal frame.");
  }
}

function validateRenderTraitsInto(traits: RenderTraits, issues: ValidationIssue[], path: string): void {
  validateNonEmptyString(traits.visible_shape, issues, `${path}.visible_shape`, "RenderTraitInvalid");
  validateNonEmptyString(traits.primary_color, issues, `${path}.primary_color`, "RenderTraitInvalid");
  if (traits.scale_hint_m !== undefined) {
    validatePositiveVector3(traits.scale_hint_m, issues, `${path}.scale_hint_m`, "RenderTraitInvalid");
  }
}

function validateInertiaTensorInto(inertia: InertiaTensor, issues: ValidationIssue[], path: string): void {
  const diagonal = [inertia.ixx_kg_m2, inertia.iyy_kg_m2, inertia.izz_kg_m2];
  for (const value of diagonal) {
    if (!Number.isFinite(value) || value <= 0) {
      addIssue(issues, "error", "InertiaInvalid", path, "Principal inertia terms must be positive finite values.", "Provide a positive definite inertia tensor.");
    }
  }
  for (const value of [inertia.ixy_kg_m2, inertia.ixz_kg_m2, inertia.iyz_kg_m2]) {
    if (!Number.isFinite(value)) {
      addIssue(issues, "error", "InertiaInvalid", path, "Product inertia terms must be finite.", "Replace nonfinite product terms.");
    }
  }
  if (
    inertia.ixx_kg_m2 + inertia.iyy_kg_m2 < inertia.izz_kg_m2 ||
    inertia.ixx_kg_m2 + inertia.izz_kg_m2 < inertia.iyy_kg_m2 ||
    inertia.iyy_kg_m2 + inertia.izz_kg_m2 < inertia.ixx_kg_m2
  ) {
    addIssue(issues, "error", "InertiaInvalid", path, "Principal moments violate rigid-body inertia triangle inequalities.", "Recompute inertia from object dimensions and mass.");
  }
}

function validateAabbWithinWorld(aabb: AxisAlignedBounds, bounds: WorldBounds, issues: ValidationIssue[], path: string): void {
  for (let axis = 0; axis < 3; axis += 1) {
    if (aabb.min_m[axis] < bounds.min_m[axis] || aabb.max_m[axis] > bounds.max_m[axis]) {
      addIssue(issues, "error", "ObjectOutsideWorldBounds", path, "Object spatial envelope exceeds world bounds.", "Move the object or enlarge the world bounds.");
    }
  }
}

function estimateLocalHalfExtents(shape: CollisionShapeDescriptor, traits: RenderTraits): Vector3 {
  if (shape.shape_kind === "box" && shape.half_extents_m !== undefined) {
    return shape.half_extents_m;
  }
  if (shape.shape_kind === "sphere" && shape.radius_m !== undefined) {
    return [shape.radius_m, shape.radius_m, shape.radius_m];
  }
  if ((shape.shape_kind === "cylinder" || shape.shape_kind === "capsule") && shape.radius_m !== undefined && shape.height_m !== undefined) {
    const z = shape.shape_kind === "capsule" ? (shape.height_m / 2) + shape.radius_m : shape.height_m / 2;
    return [shape.radius_m, shape.radius_m, z];
  }
  if (traits.scale_hint_m !== undefined) {
    return [traits.scale_hint_m[0] / 2, traits.scale_hint_m[1] / 2, traits.scale_hint_m[2] / 2];
  }
  return [0.05, 0.05, 0.05];
}

function absoluteRotationMatrixFromQuaternion(q: Quaternion): readonly [Vector3, Vector3, Vector3] {
  const [x, y, z, w] = q;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  return Object.freeze([
    Object.freeze([Math.abs(1 - 2 * (yy + zz)), Math.abs(2 * (xy - wz)), Math.abs(2 * (xz + wy))] as const),
    Object.freeze([Math.abs(2 * (xy + wz)), Math.abs(1 - 2 * (xx + zz)), Math.abs(2 * (yz - wx))] as const),
    Object.freeze([Math.abs(2 * (xz - wy)), Math.abs(2 * (yz + wx)), Math.abs(1 - 2 * (xx + yy))] as const),
  ]);
}

function multiplyMatrix3Vector3(matrix: readonly [Vector3, Vector3, Vector3], vector: Vector3): Vector3 {
  return [
    matrix[0][0] * vector[0] + matrix[0][1] * vector[1] + matrix[0][2] * vector[2],
    matrix[1][0] * vector[0] + matrix[1][1] * vector[1] + matrix[1][2] * vector[2],
    matrix[2][0] * vector[0] + matrix[2][1] * vector[1] + matrix[2][2] * vector[2],
  ];
}

function addVector3(a: Vector3, b: Vector3): Vector3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function subtractVector3(a: Vector3, b: Vector3): Vector3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function vectorNorm(value: Vector3): number {
  return Math.sqrt(value[0] * value[0] + value[1] * value[1] + value[2] * value[2]);
}

function freezeEntry(entry: ObjectCatalogEntry): ObjectCatalogEntry {
  return Object.freeze({
    ...entry,
    descriptor: Object.freeze({ ...entry.descriptor }),
    collision_shape: Object.freeze({ ...entry.collision_shape }),
    visual_shape: Object.freeze({ ...entry.visual_shape }),
    qa_tags: entry.qa_tags === undefined ? undefined : Object.freeze([...entry.qa_tags]),
  });
}

function infiniteInertia(): InertiaTensor {
  return Object.freeze({
    ixx_kg_m2: Number.POSITIVE_INFINITY,
    iyy_kg_m2: Number.POSITIVE_INFINITY,
    izz_kg_m2: Number.POSITIVE_INFINITY,
    ixy_kg_m2: 0,
    ixz_kg_m2: 0,
    iyz_kg_m2: 0,
  });
}

function compareEntries(a: ObjectCatalogEntry, b: ObjectCatalogEntry): number {
  return a.descriptor.object_ref.localeCompare(b.descriptor.object_ref);
}

function isDynamicMovability(policy: MovabilityPolicy): boolean {
  return policy === "dynamic" || policy === "constrained";
}

function checkUnique(value: Ref, seen: Set<Ref>, issues: ValidationIssue[], path: string, code: ObjectValidationCode, message: string): void {
  if (seen.has(value)) {
    addIssue(issues, "error", code, path, message, "Rename one of the duplicate references.");
  }
  seen.add(value);
}

type ObjectValidationCode =
  | "ObjectRefInvalid"
  | "ObjectRefDuplicate"
  | "CollisionShapeRefInvalid"
  | "CollisionShapeRefDuplicate"
  | "CollisionShapeKindInvalid"
  | "CollisionShapeRefMismatch"
  | "CollisionDimensionsInvalid"
  | "CollisionOffsetInvalid"
  | "CollisionOrientationInvalid"
  | "CollisionMeshProxyUnspecified"
  | "VisualShapeRefInvalid"
  | "VisualShapeRefDuplicate"
  | "VisualShapeKindInvalid"
  | "VisualShapeRefMismatch"
  | "VisualDimensionsInvalid"
  | "VisualOffsetInvalid"
  | "VisualOrientationInvalid"
  | "MaterialProfileRefInvalid"
  | "MaterialRefMissing"
  | "TransformFrameRefInvalid"
  | "TransformPositionInvalid"
  | "TransformOrientationInvalid"
  | "InitialTransformNotSimulatorWorld"
  | "DynamicMassInvalid"
  | "DynamicMassPropertiesMissing"
  | "DynamicInertiaMissing"
  | "InertiaInvalid"
  | "MovableRoleFixedPolicy"
  | "QAMarkerVisible"
  | "QAMarkerPhysicsReady"
  | "InternalAffordanceHint"
  | "RenderTraitInvalid"
  | "ObjectOutsideWorldBounds";

function makeIssue(severity: ValidationSeverity, code: ObjectValidationCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function addIssue(issues: ValidationIssue[], severity: ValidationSeverity, code: ObjectValidationCode, path: string, message: string, remediation: string): void {
  issues.push(makeIssue(severity, code, path, message, remediation));
}

function validateRef(value: string, issues: ValidationIssue[], path: string, code: ObjectValidationCode): void {
  if (!isNonEmptyString(value) || /\s/.test(value)) {
    addIssue(issues, "error", code, path, "Reference must be a non-empty whitespace-free string.", "Use an opaque ref such as object_cube_blue_01.");
  }
}

function validateNonEmptyString(value: string | undefined, issues: ValidationIssue[], path: string, code: ObjectValidationCode): void {
  if (!isNonEmptyString(value)) {
    addIssue(issues, "error", code, path, "Value must be a non-empty string.", "Provide a meaningful non-empty value.");
  }
}

function validateVector3(value: Vector3 | undefined, issues: ValidationIssue[], path: string, code: ObjectValidationCode): void {
  if (!Array.isArray(value) || value.length !== 3 || value.some((component) => !Number.isFinite(component))) {
    addIssue(issues, "error", code, path, "Vector3 must contain exactly three finite numeric components.", "Use [x, y, z] in meters.");
  }
}

function validatePositiveVector3(value: Vector3 | undefined, issues: ValidationIssue[], path: string, code: ObjectValidationCode): void {
  validateVector3(value, issues, path, code);
  if (Array.isArray(value) && value.length === 3 && value.some((component) => component <= 0)) {
    addIssue(issues, "error", code, path, "Vector3 dimensions must be positive.", "Use positive meter dimensions.");
  }
}

function validatePositiveNumber(value: number | undefined, issues: ValidationIssue[], path: string, code: ObjectValidationCode): void {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) {
    addIssue(issues, "error", code, path, "Value must be a positive finite number.", "Provide a calibrated positive meter value.");
  }
}

function validateQuaternion(value: Quaternion, issues: ValidationIssue[], path: string, code: ObjectValidationCode): void {
  if (!Array.isArray(value) || value.length !== 4 || value.some((component) => !Number.isFinite(component))) {
    addIssue(issues, "error", code, path, "Quaternion must contain exactly four finite numeric components.", "Use [x, y, z, w].");
    return;
  }
  const norm = Math.sqrt(value.reduce((sum, component) => sum + component * component, 0));
  if (norm < 1e-9 || Math.abs(norm - 1) > 1e-6) {
    addIssue(issues, "error", code, path, "Quaternion must be normalized.", "Normalize the quaternion before catalog registration.");
  }
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number.`);
  }
}

function assertPositiveVector3(value: Vector3, name: string): void {
  for (const component of value) {
    if (!Number.isFinite(component) || component <= 0) {
      throw new RangeError(`${name} must contain positive finite meter values.`);
    }
  }
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
