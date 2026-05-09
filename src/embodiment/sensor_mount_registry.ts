/**
 * Sensor mount registry for Project Mebsuta embodiment models.
 *
 * Blueprint: `architecture_docs/05_EMBODIMENT_KINEMATICS_QUADRUPED_HUMANOID.md`
 * sections 5.3, 5.5, 5.6, 5.7, 5.15, 5.16, 5.19, and 5.20.
 *
 * This module is the executable registry for body-mounted cameras, depth
 * sensors, microphones, IMUs, encoders, contact sensors, and force-torque
 * sensors. It binds every sensor to declared body frames and calibration refs,
 * cross-checks optional virtual hardware manifests, computes body-relative
 * mount transforms, and emits prompt-safe sensor capability summaries without
 * leaking simulator world pose, backend handles, collision meshes, or QA truth.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { EmbodimentKind, Quaternion, Ref, Transform, ValidationIssue, ValidationSeverity, Vector3 } from "../simulation/world_manifest";
import { createEmbodimentModelRegistry, EmbodimentModelRegistry } from "./embodiment_model_registry";
import type { EmbodimentDescriptor, FrameDescriptor, SensorMountDescriptor } from "./embodiment_model_registry";
import type { VirtualHardwareManifest, VirtualSensorDescriptor } from "../virtual_hardware/virtual_hardware_manifest_registry";

export const SENSOR_MOUNT_REGISTRY_SCHEMA_VERSION = "mebsuta.sensor_mount_registry.v1" as const;

const EPSILON = 1e-9;
const IDENTITY_QUATERNION: Quaternion = Object.freeze([0, 0, 0, 1]) as Quaternion;
const ZERO_VECTOR: Vector3 = Object.freeze([0, 0, 0]) as Vector3;
const FORBIDDEN_DETAIL_PATTERN = /(engine|backend|scene_graph|world_truth|ground_truth|qa_|collision_mesh|simulator_seed|exact_com|world_pose|rigid_body_handle|physics_body|render_node|object_id)/i;

export type SensorMountRole = SensorMountDescriptor["sensor_role"];
export type SensorMountVisibility = "cognitive_allowed" | "declared_calibration_allowed" | "sensor_evidence_only" | "hardware_internal_only";
export type SensorMountHealthClass = "nominal" | "degraded" | "missing" | "undeclared";
export type SensorMountConsumer = "virtual_hardware" | "perception" | "control" | "stability" | "contact" | "prompt_contract" | "qa";

export type SensorMountIssueCode =
  | "ActiveEmbodimentMissing"
  | "SensorMountMissing"
  | "SensorMountDuplicate"
  | "SensorRefInvalid"
  | "SensorRoleInvalid"
  | "SensorFrameMissing"
  | "SensorFrameRoleInvalid"
  | "BodyFrameMissing"
  | "BodyFrameInvalid"
  | "CalibrationRefMissing"
  | "HardwareManifestMismatch"
  | "HardwareSensorMissing"
  | "HardwareSensorClassMismatch"
  | "HardwareCalibrationMissing"
  | "MountTransformUnavailable"
  | "ForbiddenBodyDetail";

export interface SensorMountRegistryConfig {
  readonly registry?: EmbodimentModelRegistry;
  readonly embodiment?: EmbodimentDescriptor;
  readonly hardware_manifest?: VirtualHardwareManifest;
  readonly active_embodiment_ref?: Ref;
}

export interface SensorMountSelectionInput {
  readonly active_embodiment_ref?: Ref;
  readonly sensor_ref?: Ref;
  readonly sensor_role?: SensorMountRole;
  readonly body_frame_ref?: Ref;
  readonly consumer?: SensorMountConsumer;
}

export interface ResolvedSensorMount {
  readonly schema_version: typeof SENSOR_MOUNT_REGISTRY_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly sensor_ref: Ref;
  readonly sensor_role: SensorMountRole;
  readonly mount_frame_ref: Ref;
  readonly mount_frame_role: FrameDescriptor["frame_role"];
  readonly body_frame_ref: Ref;
  readonly body_frame_role: FrameDescriptor["frame_role"];
  readonly calibration_ref: Ref;
  readonly allowed_motion_summary: string;
  readonly transform_body_from_mount: Transform;
  readonly transform_mount_from_body: Transform;
  readonly mount_distance_from_body_m: number;
  readonly hardware_sensor_class?: VirtualSensorDescriptor["sensor_class"];
  readonly hardware_declared: boolean;
  readonly calibration_declared: boolean;
  readonly cognitive_visibility: SensorMountVisibility;
  readonly health_class: SensorMountHealthClass;
  readonly prompt_safe_summary: string;
  readonly hidden_fields_removed: readonly string[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
}

export interface SensorRoleSummary {
  readonly sensor_role: SensorMountRole;
  readonly sensor_count: number;
  readonly mounted_body_frames: readonly Ref[];
  readonly calibration_count: number;
  readonly cognitive_visible_count: number;
  readonly hardware_declared_count: number;
  readonly nominal_count: number;
}

export interface SensorMountRegistryReport {
  readonly schema_version: typeof SENSOR_MOUNT_REGISTRY_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly sensor_mount_table_ref: Ref;
  readonly sensor_mount_count: number;
  readonly camera_count: number;
  readonly depth_sensor_count: number;
  readonly microphone_count: number;
  readonly imu_count: number;
  readonly encoder_count: number;
  readonly contact_sensor_count: number;
  readonly force_torque_count: number;
  readonly mounts: readonly ResolvedSensorMount[];
  readonly role_summaries: readonly SensorRoleSummary[];
  readonly hidden_fields_removed: readonly string[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly error_count: number;
  readonly warning_count: number;
  readonly determinism_hash: string;
}

export interface SensorCoverageRequest {
  readonly active_embodiment_ref?: Ref;
  readonly required_roles: readonly SensorMountRole[];
  readonly require_cognitive_visible?: boolean;
  readonly require_hardware_declared?: boolean;
}

export interface SensorCoverageReport {
  readonly schema_version: typeof SENSOR_MOUNT_REGISTRY_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly required_roles: readonly SensorMountRole[];
  readonly satisfied_roles: readonly SensorMountRole[];
  readonly missing_roles: readonly SensorMountRole[];
  readonly usable_sensor_refs: readonly Ref[];
  readonly ok: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface CognitiveSensorMountSummary {
  readonly schema_version: typeof SENSOR_MOUNT_REGISTRY_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly installed_sensor_summary: readonly string[];
  readonly declared_calibration_summary: readonly string[];
  readonly limitations_summary: readonly string[];
  readonly forbidden_detail_report_ref: Ref;
  readonly hidden_fields_removed: readonly string[];
  readonly determinism_hash: string;
}

export class SensorMountRegistryError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "SensorMountRegistryError";
    this.issues = issues;
  }
}

/**
 * Resolves and validates sensor mounts for the active embodiment.
 */
export class SensorMountRegistry {
  private readonly registry: EmbodimentModelRegistry;
  private readonly hardwareManifest: VirtualHardwareManifest | undefined;
  private activeEmbodimentRef: Ref | undefined;

  public constructor(config: SensorMountRegistryConfig = {}) {
    this.registry = config.registry ?? createEmbodimentModelRegistry(config.embodiment === undefined ? undefined : [config.embodiment]);
    this.hardwareManifest = config.hardware_manifest;
    if (config.embodiment !== undefined) {
      this.registry.registerEmbodimentModel(config.embodiment);
    }
    if (config.active_embodiment_ref !== undefined) {
      this.selectActiveEmbodiment(config.active_embodiment_ref);
    } else if (config.embodiment !== undefined) {
      this.activeEmbodimentRef = config.embodiment.embodiment_id;
    }
  }

  /**
   * Selects the embodiment whose sensor mount table is resolved by default.
   */
  public selectActiveEmbodiment(activeEmbodimentRef: Ref): Ref {
    assertSafeRef(activeEmbodimentRef, "$.active_embodiment_ref");
    this.registry.selectActiveEmbodiment({ embodiment_ref: activeEmbodimentRef });
    this.activeEmbodimentRef = activeEmbodimentRef;
    return activeEmbodimentRef;
  }

  /**
   * Returns a full validated mount table for cameras, microphones, IMUs,
   * encoders, contact sensors, depth sensors, and force-torque sensors.
   */
  public buildSensorMountRegistryReport(selection: SensorMountSelectionInput = {}): SensorMountRegistryReport {
    const model = this.requireEmbodiment(selection.active_embodiment_ref);
    const mounts = freezeArray(model.sensor_mounts
      .filter((mount) => selection.sensor_ref === undefined || mount.sensor_ref === selection.sensor_ref)
      .filter((mount) => selection.sensor_role === undefined || mount.sensor_role === selection.sensor_role)
      .filter((mount) => selection.body_frame_ref === undefined || mount.body_frame_ref === selection.body_frame_ref)
      .map((mount, index) => resolveSensorMount(model, mount, this.hardwareManifest, `$.sensor_mounts[${index}]`))
      .sort((a, b) => a.sensor_ref.localeCompare(b.sensor_ref)));
    const coverageIssues = validateMountCoverage(model, this.hardwareManifest);
    const issues = freezeArray([...coverageIssues, ...mounts.flatMap((mount) => mount.issues)]);
    const base = {
      schema_version: SENSOR_MOUNT_REGISTRY_SCHEMA_VERSION,
      embodiment_ref: model.embodiment_id,
      embodiment_kind: model.embodiment_kind,
      sensor_mount_table_ref: model.sensor_mount_table_ref,
      sensor_mount_count: mounts.length,
      camera_count: mounts.filter((mount) => mount.sensor_role === "camera").length,
      depth_sensor_count: mounts.filter((mount) => mount.sensor_role === "depth_camera").length,
      microphone_count: mounts.filter((mount) => mount.sensor_role === "microphone").length,
      imu_count: mounts.filter((mount) => mount.sensor_role === "imu").length,
      encoder_count: mounts.filter((mount) => mount.sensor_role === "encoder").length,
      contact_sensor_count: mounts.filter((mount) => mount.sensor_role === "contact_sensor").length,
      force_torque_count: mounts.filter((mount) => mount.sensor_role === "force_torque").length,
      mounts,
      role_summaries: buildRoleSummaries(mounts),
      hidden_fields_removed: hiddenFieldsRemoved(),
      issues,
      ok: issues.every((issue) => issue.severity !== "error"),
      error_count: issues.filter((issue) => issue.severity === "error").length,
      warning_count: issues.filter((issue) => issue.severity === "warning").length,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Resolves exactly one sensor mount or throws if the selection is ambiguous
   * or unavailable.
   */
  public requireSensorMount(selection: SensorMountSelectionInput): ResolvedSensorMount {
    const report = this.buildSensorMountRegistryReport(selection);
    if (report.mounts.length !== 1) {
      throw new SensorMountRegistryError("Sensor mount selection must resolve to exactly one mount.", [
        makeIssue("error", "SensorMountMissing", "$.selection", `Selection resolved ${report.mounts.length} mounts.`, "Select by exact sensor_ref or a unique role/body-frame pair."),
      ]);
    }
    return report.mounts[0];
  }

  /**
   * Checks whether required sensor roles are declared and usable for a
   * downstream consumer such as perception, stability, or prompt contracts.
   */
  public evaluateSensorCoverage(request: SensorCoverageRequest): SensorCoverageReport {
    const model = this.requireEmbodiment(request.active_embodiment_ref);
    const report = this.buildSensorMountRegistryReport({ active_embodiment_ref: model.embodiment_id });
    const requiredRoles = freezeArray([...new Set(request.required_roles)].sort());
    const usable = report.mounts.filter((mount) => {
      const visibilityOk = request.require_cognitive_visible !== true || mount.cognitive_visibility === "cognitive_allowed" || mount.cognitive_visibility === "declared_calibration_allowed" || mount.cognitive_visibility === "sensor_evidence_only";
      const hardwareOk = request.require_hardware_declared !== true || mount.hardware_declared;
      return mount.ok && visibilityOk && hardwareOk;
    });
    const satisfiedRoles = freezeArray(requiredRoles.filter((role) => usable.some((mount) => mount.sensor_role === role)));
    const missingRoles = freezeArray(requiredRoles.filter((role) => !satisfiedRoles.includes(role)));
    const issues = freezeArray(missingRoles.map((role) => makeIssue("error", "SensorMountMissing", "$.required_roles", `Required sensor role ${role} is not usable.`, "Declare and validate the required sensor mount.")));
    const base = {
      schema_version: SENSOR_MOUNT_REGISTRY_SCHEMA_VERSION,
      embodiment_ref: model.embodiment_id,
      required_roles: requiredRoles,
      satisfied_roles: satisfiedRoles,
      missing_roles: missingRoles,
      usable_sensor_refs: freezeArray(usable.map((mount) => mount.sensor_ref).sort()),
      ok: missingRoles.length === 0,
      issues,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Produces the model-facing sensor self-knowledge allowed by the embodiment
   * prompt contract.
   */
  public buildCognitiveSensorMountSummary(activeEmbodimentRef?: Ref): CognitiveSensorMountSummary {
    const report = this.buildSensorMountRegistryReport({ active_embodiment_ref: activeEmbodimentRef });
    const installed = freezeArray(report.role_summaries
      .filter((summary) => summary.sensor_count > 0)
      .map((summary) => sanitizeText(`${summary.sensor_count} ${summary.sensor_role} sensor(s) mounted on ${summary.mounted_body_frames.join(", ")}.`)));
    const calibration = freezeArray(report.mounts
      .filter((mount) => mount.calibration_declared || mount.cognitive_visibility === "declared_calibration_allowed")
      .map((mount) => sanitizeText(`${mount.sensor_role} ${mount.sensor_ref} uses declared calibration ${mount.calibration_ref}.`)));
    const limitations = freezeArray(report.mounts
      .filter((mount) => mount.health_class !== "nominal" || mount.issues.length > 0)
      .map((mount) => sanitizeText(`${mount.sensor_role} ${mount.sensor_ref} is ${mount.health_class}; ${mount.allowed_motion_summary}.`)));
    for (const text of [...installed, ...calibration, ...limitations]) {
      assertNoForbiddenLeak(text);
    }
    const hidden = hiddenFieldsRemoved();
    const base = {
      schema_version: SENSOR_MOUNT_REGISTRY_SCHEMA_VERSION,
      embodiment_ref: report.embodiment_ref,
      embodiment_kind: report.embodiment_kind,
      installed_sensor_summary: installed,
      declared_calibration_summary: calibration,
      limitations_summary: limitations,
      forbidden_detail_report_ref: `sensor_mount_hidden_${computeDeterminismHash({ report: report.determinism_hash, hidden }).slice(0, 12)}`,
      hidden_fields_removed: hidden,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  private requireEmbodiment(embodimentRef?: Ref): EmbodimentDescriptor {
    const activeRef = embodimentRef ?? this.activeEmbodimentRef;
    if (activeRef !== undefined) {
      assertSafeRef(activeRef, "$.active_embodiment_ref");
      return this.registry.requireEmbodiment(activeRef);
    }
    const selected = this.registry.listEmbodiments().at(0);
    if (selected === undefined) {
      throw new SensorMountRegistryError("No active embodiment is registered for sensor mount resolution.", [
        makeIssue("error", "ActiveEmbodimentMissing", "$.active_embodiment_ref", "No active embodiment is registered.", "Register and select an embodiment before resolving sensor mounts."),
      ]);
    }
    this.activeEmbodimentRef = selected.embodiment_id;
    return selected;
  }
}

export function createSensorMountRegistry(config: SensorMountRegistryConfig = {}): SensorMountRegistry {
  return new SensorMountRegistry(config);
}

function resolveSensorMount(
  model: EmbodimentDescriptor,
  mount: SensorMountDescriptor,
  hardwareManifest: VirtualHardwareManifest | undefined,
  path: string,
): ResolvedSensorMount {
  const issues: ValidationIssue[] = [];
  validateSafeRef(mount.sensor_ref, `${path}.sensor_ref`, issues, "SensorRefInvalid");
  validateSafeRef(mount.mount_frame_ref, `${path}.mount_frame_ref`, issues, "SensorFrameMissing");
  validateSafeRef(mount.body_frame_ref, `${path}.body_frame_ref`, issues, "BodyFrameMissing");
  validateSafeRef(mount.calibration_ref, `${path}.calibration_ref`, issues, "CalibrationRefMissing");
  if (mount.allowed_motion_summary.trim().length === 0) {
    issues.push(makeIssue("error", "SensorMountMissing", `${path}.allowed_motion_summary`, "Allowed motion summary must be non-empty.", "Declare how this sensor may move with the body."));
  }
  if (FORBIDDEN_DETAIL_PATTERN.test(mount.allowed_motion_summary)) {
    issues.push(makeIssue("error", "ForbiddenBodyDetail", `${path}.allowed_motion_summary`, "Allowed motion summary contains forbidden simulator or QA detail.", "Use body-relative plain-language motion limits."));
  }

  const mountFrame = model.frame_graph.find((frame) => frame.frame_id === mount.mount_frame_ref);
  const bodyFrame = model.frame_graph.find((frame) => frame.frame_id === mount.body_frame_ref);
  if (mountFrame === undefined) {
    issues.push(makeIssue("error", "SensorFrameMissing", `${path}.mount_frame_ref`, `Mount frame ${mount.mount_frame_ref} is not declared.`, "Attach every sensor to a declared frame."));
  }
  if (bodyFrame === undefined) {
    issues.push(makeIssue("error", "BodyFrameMissing", `${path}.body_frame_ref`, `Body frame ${mount.body_frame_ref} is not declared.`, "Bind the sensor mount to a declared body frame."));
  } else if (bodyFrame.frame_role === "sensor" || bodyFrame.frame_role === "tool") {
    issues.push(makeIssue("warning", "BodyFrameInvalid", `${path}.body_frame_ref`, "Body frame should be a stable body, contact, or end-effector frame, not a sensor/tool frame.", "Use base, torso, head, contact, or end-effector frames for body binding."));
  }
  if (mountFrame !== undefined && !isRoleCompatible(mount.sensor_role, mountFrame.frame_role)) {
    issues.push(makeIssue("warning", "SensorFrameRoleInvalid", `${path}.mount_frame_ref`, `Sensor role ${mount.sensor_role} is mounted on frame role ${mountFrame.frame_role}.`, "Use sensor frames for cameras, microphones, IMUs, and body/contact frames for tactile sensors."));
  }

  const hardware = hardwareManifest?.sensor_inventory.find((sensor) => sensor.sensor_id === mount.sensor_ref);
  if (hardwareManifest !== undefined && hardwareManifest.embodiment_kind !== model.embodiment_kind) {
    issues.push(makeIssue("error", "HardwareManifestMismatch", "$.hardware_manifest.embodiment_kind", "Hardware manifest embodiment kind differs from the active embodiment.", "Use the hardware manifest for the active body."));
  }
  if (hardwareManifest !== undefined && hardware === undefined) {
    issues.push(makeIssue("warning", "HardwareSensorMissing", `${path}.sensor_ref`, `Sensor ${mount.sensor_ref} is not declared in the hardware manifest.`, "Declare the sensor in the virtual hardware manifest before packet production."));
  }
  if (hardware !== undefined) {
    if (!sensorRoleMatchesHardware(mount.sensor_role, hardware.sensor_class)) {
      issues.push(makeIssue("error", "HardwareSensorClassMismatch", `${path}.sensor_role`, `Mount role ${mount.sensor_role} does not match hardware class ${hardware.sensor_class}.`, "Align embodiment mount roles with hardware sensor classes."));
    }
    if (hardware.mount_frame_ref !== mount.mount_frame_ref) {
      issues.push(makeIssue("warning", "HardwareManifestMismatch", `${path}.mount_frame_ref`, "Hardware manifest mount frame differs from the embodiment mount.", "Reconcile hardware and embodiment mount frames."));
    }
    if (hardware.calibration_ref !== mount.calibration_ref) {
      issues.push(makeIssue("warning", "HardwareManifestMismatch", `${path}.calibration_ref`, "Hardware manifest calibration ref differs from the embodiment mount.", "Reconcile hardware and embodiment calibration refs."));
    }
  }
  const calibrationDeclared = hardwareManifest === undefined
    ? true
    : hardwareManifest.calibration_profiles.some((profile) => profile.calibration_profile_ref === mount.calibration_ref)
      || hardwareManifest.calibration_profile_refs.includes(mount.calibration_ref)
      || hardware?.calibration_ref === mount.calibration_ref;
  if (!calibrationDeclared) {
    issues.push(makeIssue("warning", "HardwareCalibrationMissing", `${path}.calibration_ref`, `Calibration ${mount.calibration_ref} is not declared in the hardware manifest.`, "Add a calibration profile or ref for the mounted sensor."));
  }

  const bodyFromMount = mountFrame !== undefined && bodyFrame !== undefined
    ? computeTransformBetweenFrames(model.frame_graph, bodyFrame.frame_id, mountFrame.frame_id, issues, path)
    : identityTransform(mount.mount_frame_ref);
  const mountFromBody = invertTransform(bodyFromMount, mount.body_frame_ref);
  const visibility = hardware === undefined ? defaultVisibilityForRole(mount.sensor_role) : visibilityFromHardware(hardware);
  const health = classifyHealth(issues, hardwareManifest, hardware, calibrationDeclared);
  const promptSummary = sanitizeText(`${mount.sensor_role} ${mount.sensor_ref} is mounted on ${safeFrameLabel(bodyFrame)} for ${mount.allowed_motion_summary}.`);
  assertNoForbiddenLeak(promptSummary);
  const base = {
    schema_version: SENSOR_MOUNT_REGISTRY_SCHEMA_VERSION,
    embodiment_ref: model.embodiment_id,
    embodiment_kind: model.embodiment_kind,
    sensor_ref: mount.sensor_ref,
    sensor_role: mount.sensor_role,
    mount_frame_ref: mount.mount_frame_ref,
    mount_frame_role: mountFrame?.frame_role ?? "sensor" as FrameDescriptor["frame_role"],
    body_frame_ref: mount.body_frame_ref,
    body_frame_role: bodyFrame?.frame_role ?? "base" as FrameDescriptor["frame_role"],
    calibration_ref: mount.calibration_ref,
    allowed_motion_summary: sanitizeText(mount.allowed_motion_summary),
    transform_body_from_mount: bodyFromMount,
    transform_mount_from_body: mountFromBody,
    mount_distance_from_body_m: round6(vectorNorm(bodyFromMount.position_m)),
    hardware_sensor_class: hardware?.sensor_class,
    hardware_declared: hardware !== undefined,
    calibration_declared: calibrationDeclared,
    cognitive_visibility: visibility,
    health_class: health,
    prompt_safe_summary: promptSummary,
    hidden_fields_removed: hiddenFieldsRemoved(),
    issues: freezeArray(issues),
    ok: issues.every((issue) => issue.severity !== "error"),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function validateMountCoverage(model: EmbodimentDescriptor, hardwareManifest: VirtualHardwareManifest | undefined): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<Ref>();
  for (const [index, mount] of model.sensor_mounts.entries()) {
    if (seen.has(mount.sensor_ref)) {
      issues.push(makeIssue("error", "SensorMountDuplicate", `$.sensor_mounts[${index}].sensor_ref`, `Sensor ${mount.sensor_ref} is mounted more than once.`, "Use one canonical mount record per sensor."));
    }
    seen.add(mount.sensor_ref);
  }
  if (model.sensor_mounts.length === 0) {
    issues.push(makeIssue("error", "SensorMountMissing", "$.sensor_mounts", "Embodiment has no sensor mounts.", "Declare at least one embodied sensor mount."));
  }
  for (const required of requiredRolesForEmbodiment(model.embodiment_kind)) {
    if (!model.sensor_mounts.some((mount) => mount.sensor_role === required)) {
      issues.push(makeIssue("warning", "SensorMountMissing", "$.sensor_mounts", `Expected ${required} mount is absent for ${model.embodiment_kind}.`, "Declare the required body sensor role."));
    }
  }
  if (hardwareManifest !== undefined) {
    for (const sensor of hardwareManifest.sensor_inventory) {
      if (!model.sensor_mounts.some((mount) => mount.sensor_ref === sensor.sensor_id)) {
        issues.push(makeIssue("warning", "HardwareManifestMismatch", "$.hardware_manifest.sensor_inventory", `Hardware sensor ${sensor.sensor_id} has no embodiment mount.`, "Bind every hardware sensor to a body mount."));
      }
    }
  }
  return freezeArray(issues);
}

function buildRoleSummaries(mounts: readonly ResolvedSensorMount[]): readonly SensorRoleSummary[] {
  const roles = freezeArray([...new Set(mounts.map((mount) => mount.sensor_role))].sort());
  return freezeArray(roles.map((role) => {
    const roleMounts = mounts.filter((mount) => mount.sensor_role === role);
    return Object.freeze({
      sensor_role: role,
      sensor_count: roleMounts.length,
      mounted_body_frames: freezeArray([...new Set(roleMounts.map((mount) => mount.body_frame_ref))].sort()),
      calibration_count: new Set(roleMounts.map((mount) => mount.calibration_ref)).size,
      cognitive_visible_count: roleMounts.filter((mount) => mount.cognitive_visibility !== "hardware_internal_only").length,
      hardware_declared_count: roleMounts.filter((mount) => mount.hardware_declared).length,
      nominal_count: roleMounts.filter((mount) => mount.health_class === "nominal").length,
    });
  }));
}

function computeTransformBetweenFrames(frames: readonly FrameDescriptor[], ancestorRef: Ref, childRef: Ref, issues: ValidationIssue[], path: string): Transform {
  if (ancestorRef === childRef) {
    return identityTransform(childRef);
  }
  const frameByRef = new Map(frames.map((frame) => [frame.frame_id, frame] as const));
  const transforms: Transform[] = [];
  let cursor = frameByRef.get(childRef);
  const visited = new Set<Ref>();
  while (cursor !== undefined && cursor.frame_id !== ancestorRef) {
    if (visited.has(cursor.frame_id)) {
      issues.push(makeIssue("error", "MountTransformUnavailable", `${path}.mount_frame_ref`, "Frame graph contains a cycle while resolving sensor mount transform.", "Fix the frame graph before resolving sensor mounts."));
      return identityTransform(childRef);
    }
    visited.add(cursor.frame_id);
    if (cursor.parent_frame_ref === undefined || cursor.transform_from_parent === undefined) {
      issues.push(makeIssue("error", "MountTransformUnavailable", `${path}.mount_frame_ref`, `Frame ${cursor.frame_id} is not a descendant of ${ancestorRef}.`, "Mount sensors beneath their declared body frame or add the missing transform."));
      return identityTransform(childRef);
    }
    transforms.push(cursor.transform_from_parent);
    cursor = frameByRef.get(cursor.parent_frame_ref);
  }
  if (cursor === undefined) {
    issues.push(makeIssue("error", "MountTransformUnavailable", `${path}.mount_frame_ref`, `Frame ${childRef} cannot be traced to ${ancestorRef}.`, "Declare a connected body-relative frame graph."));
    return identityTransform(childRef);
  }
  return transforms.reverse().reduce((accumulator, transform) => composeTransforms(accumulator, transform, childRef), identityTransform(ancestorRef));
}

function composeTransforms(parentFromCurrent: Transform, currentFromChild: Transform, frameRef: Ref): Transform {
  const orientation = normalizeQuaternion(multiplyQuaternions(parentFromCurrent.orientation_xyzw, currentFromChild.orientation_xyzw));
  const rotated = rotateVectorByQuaternion(currentFromChild.position_m, parentFromCurrent.orientation_xyzw);
  return Object.freeze({
    frame_ref: frameRef,
    position_m: freezeVector3([
      parentFromCurrent.position_m[0] + rotated[0],
      parentFromCurrent.position_m[1] + rotated[1],
      parentFromCurrent.position_m[2] + rotated[2],
    ]),
    orientation_xyzw: orientation,
  });
}

function invertTransform(transform: Transform, frameRef: Ref): Transform {
  const inverseOrientation = normalizeQuaternion(Object.freeze([
    -transform.orientation_xyzw[0],
    -transform.orientation_xyzw[1],
    -transform.orientation_xyzw[2],
    transform.orientation_xyzw[3],
  ]) as Quaternion);
  const inversePosition = rotateVectorByQuaternion(freezeVector3([
    -transform.position_m[0],
    -transform.position_m[1],
    -transform.position_m[2],
  ]), inverseOrientation);
  return Object.freeze({
    frame_ref: frameRef,
    position_m: inversePosition,
    orientation_xyzw: inverseOrientation,
  });
}

function multiplyQuaternions(a: Quaternion, b: Quaternion): Quaternion {
  const ax = a[0];
  const ay = a[1];
  const az = a[2];
  const aw = a[3];
  const bx = b[0];
  const by = b[1];
  const bz = b[2];
  const bw = b[3];
  return Object.freeze([
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]) as Quaternion;
}

function rotateVectorByQuaternion(vector: Vector3, quaternion: Quaternion): Vector3 {
  const qVector = Object.freeze([vector[0], vector[1], vector[2], 0]) as Quaternion;
  const qConjugate = Object.freeze([-quaternion[0], -quaternion[1], -quaternion[2], quaternion[3]]) as Quaternion;
  const rotated = multiplyQuaternions(multiplyQuaternions(quaternion, qVector), qConjugate);
  return freezeVector3([rotated[0], rotated[1], rotated[2]]);
}

function normalizeQuaternion(quaternion: Quaternion): Quaternion {
  const norm = Math.hypot(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
  if (norm <= EPSILON) {
    return IDENTITY_QUATERNION;
  }
  return Object.freeze([quaternion[0] / norm, quaternion[1] / norm, quaternion[2] / norm, quaternion[3] / norm]) as Quaternion;
}

function identityTransform(frameRef: Ref): Transform {
  return Object.freeze({
    frame_ref: frameRef,
    position_m: ZERO_VECTOR,
    orientation_xyzw: IDENTITY_QUATERNION,
  });
}

function sensorRoleMatchesHardware(role: SensorMountRole, sensorClass: VirtualSensorDescriptor["sensor_class"]): boolean {
  if (role === "camera") {
    return sensorClass === "rgb_camera" || sensorClass === "stereo_camera";
  }
  if (role === "depth_camera") {
    return sensorClass === "depth_camera" || sensorClass === "stereo_camera";
  }
  if (role === "microphone") {
    return sensorClass === "microphone_array";
  }
  if (role === "imu") {
    return sensorClass === "imu";
  }
  if (role === "encoder") {
    return sensorClass === "joint_encoder";
  }
  if (role === "contact_sensor") {
    return sensorClass === "contact_sensor";
  }
  return sensorClass === "force_torque";
}

function isRoleCompatible(role: SensorMountRole, frameRole: FrameDescriptor["frame_role"]): boolean {
  if (role === "contact_sensor" || role === "force_torque") {
    return frameRole === "contact" || frameRole === "end_effector" || frameRole === "base" || frameRole === "tool";
  }
  if (role === "encoder") {
    return frameRole === "base" || frameRole === "torso" || frameRole === "head" || frameRole === "end_effector" || frameRole === "contact";
  }
  return frameRole === "sensor" || frameRole === "head" || frameRole === "torso" || frameRole === "end_effector";
}

function classifyHealth(
  issues: readonly ValidationIssue[],
  hardwareManifest: VirtualHardwareManifest | undefined,
  hardware: VirtualSensorDescriptor | undefined,
  calibrationDeclared: boolean,
): SensorMountHealthClass {
  if (issues.some((issue) => issue.severity === "error")) {
    return "degraded";
  }
  if (hardwareManifest !== undefined && hardware === undefined) {
    return "undeclared";
  }
  if (!calibrationDeclared) {
    return "degraded";
  }
  if (issues.length > 0) {
    return "degraded";
  }
  return "nominal";
}

function visibilityFromHardware(hardware: VirtualSensorDescriptor): SensorMountVisibility {
  if (hardware.cognitive_visibility === "cognitive_allowed") {
    return "cognitive_allowed";
  }
  if (hardware.cognitive_visibility === "declared_calibration_allowed") {
    return "declared_calibration_allowed";
  }
  if (hardware.cognitive_visibility === "sensor_evidence_only") {
    return "sensor_evidence_only";
  }
  return "hardware_internal_only";
}

function defaultVisibilityForRole(role: SensorMountRole): SensorMountVisibility {
  if (role === "camera" || role === "depth_camera" || role === "microphone") {
    return "sensor_evidence_only";
  }
  if (role === "imu" || role === "encoder" || role === "contact_sensor" || role === "force_torque") {
    return "declared_calibration_allowed";
  }
  return "hardware_internal_only";
}

function requiredRolesForEmbodiment(kind: EmbodimentKind): readonly SensorMountRole[] {
  return kind === "quadruped"
    ? freezeArray(["camera", "microphone", "imu", "contact_sensor"])
    : freezeArray(["camera", "imu", "contact_sensor"]);
}

function safeFrameLabel(frame: FrameDescriptor | undefined): string {
  if (frame === undefined) {
    return "unknown body frame";
  }
  return sanitizeText(`${frame.frame_role} frame ${frame.frame_id}`);
}

function hiddenFieldsRemoved(): readonly string[] {
  return freezeArray([
    "transform_body_from_mount.position_m",
    "transform_body_from_mount.orientation_xyzw",
    "transform_mount_from_body",
    "hardware_manifest.mount_transform",
    "hardware_backend_handles",
  ]);
}

function validateSafeRef(value: Ref | undefined, path: string, issues: ValidationIssue[], code: SensorMountIssueCode): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string" || value.trim().length === 0 || /\s/.test(value)) {
    issues.push(makeIssue("error", code, path, "Reference must be a non-empty whitespace-free string.", "Use an opaque body-safe reference."));
  }
  if (FORBIDDEN_DETAIL_PATTERN.test(value)) {
    issues.push(makeIssue("error", "ForbiddenBodyDetail", path, "Reference appears to contain forbidden simulator or QA detail.", "Use an opaque declared body reference."));
  }
}

function assertSafeRef(value: Ref, path: string): void {
  const issues: ValidationIssue[] = [];
  validateSafeRef(value, path, issues, "ActiveEmbodimentMissing");
  if (issues.length > 0) {
    throw new SensorMountRegistryError("Invalid sensor mount registry reference.", issues);
  }
}

function sanitizeText(value: string): string {
  return value.replace(FORBIDDEN_DETAIL_PATTERN, "hidden-detail").trim();
}

function assertNoForbiddenLeak(value: string): void {
  if (FORBIDDEN_DETAIL_PATTERN.test(value)) {
    throw new SensorMountRegistryError("Cognitive sensor mount summary contains forbidden body detail.", [
      makeIssue("error", "ForbiddenBodyDetail", "$.prompt_safe_summary", "Summary contains forbidden simulator or QA detail.", "Sanitize exact internals before exposing sensor summaries."),
    ]);
  }
}

function makeIssue(severity: ValidationSeverity, code: SensorMountIssueCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function vectorNorm(value: Vector3): number {
  return Math.hypot(value[0], value[1], value[2]);
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

export const SENSOR_MOUNT_REGISTRY_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: SENSOR_MOUNT_REGISTRY_SCHEMA_VERSION,
  blueprint: "architecture_docs/05_EMBODIMENT_KINEMATICS_QUADRUPED_HUMANOID.md",
  sections: freezeArray(["5.3", "5.5", "5.6", "5.7", "5.15", "5.16", "5.19", "5.20"]),
});
