/**
 * Calibration registry for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/04_VIRTUAL_HARDWARE_SENSOR_ACTUATOR_SPEC.md`
 * sections 4.3, 4.5, 4.6, 4.7, 4.8, 4.12, 4.17, and 4.18.
 *
 * The registry turns manifest-declared calibration into robot
 * self-knowledge. Camera intrinsics, sensor mounts, microphone geometry, IMU
 * alignment, encoder offsets, and actuator limits may be exposed only when
 * they are declared in the hardware manifest and contain no backend handles,
 * hidden world coordinates, QA truth, or simulator object references.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Quaternion, Ref, Transform, ValidationIssue, ValidationSeverity, Vector3 } from "../simulation/world_manifest";
import {
  VIRTUAL_HARDWARE_MANIFEST_REGISTRY_SCHEMA_VERSION,
  VirtualHardwareManifestRegistry,
} from "./virtual_hardware_manifest_registry";
import type {
  ActuatorDescriptor,
  ActuatorLimitEnvelope,
  CalibrationKind,
  CalibrationProfile,
  CameraIntrinsics,
  CameraResolution,
  CameraSensorDescriptor,
  JointEncoderDescriptor,
  MicrophoneArrayDescriptor,
  MicrophoneChannelGeometry,
  VirtualHardwareManifest,
  VirtualSensorDescriptor,
} from "./virtual_hardware_manifest_registry";

export const CALIBRATION_REGISTRY_SCHEMA_VERSION = "mebsuta.calibration_registry.v1" as const;

const EPSILON = 1e-9;
const SPEED_OF_SOUND_M_PER_S = 343.0;
const FORBIDDEN_KEY_PATTERN = /(backend|engine|scene_graph|scene_path|object_id|object_ref|world_truth|ground_truth|qa_|benchmark|simulator_seed|collision_mesh|render_node|physics_handle)/i;
const FORBIDDEN_STRING_PATTERN = /\b(?:backend|engine|scene graph|ground truth|qa truth|benchmark answer|simulator seed|collision mesh|render node|physics handle)\b|\/(?:World|Scene|Root|Meshes|Collision)\//i;

export type Matrix3 = readonly [
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
];

export type Matrix4 = readonly [
  readonly [number, number, number, number],
  readonly [number, number, number, number],
  readonly [number, number, number, number],
  readonly [number, number, number, number],
];

export type CalibrationExposurePurpose =
  | "planning_prompt"
  | "verification_prompt"
  | "oops_loop_prompt"
  | "memory_grounded_prompt"
  | "tool_use_prompt"
  | "control_validation"
  | "qa";

export type CalibrationIssueCode =
  | "ManifestCalibrationMissing"
  | "ManifestCalibrationDuplicate"
  | "CalibrationRefInvalid"
  | "CalibrationKindMismatch"
  | "CalibrationVisibilityBlocked"
  | "CalibrationHiddenTruthDetected"
  | "CalibrationTransformInvalid"
  | "CalibrationIntrinsicsInvalid"
  | "CalibrationMicrophoneGeometryInvalid"
  | "CalibrationEncoderOffsetInvalid"
  | "CalibrationImuAlignmentInvalid"
  | "CalibrationActuatorLimitInvalid"
  | "CalibrationHardwareUndeclared"
  | "CalibrationRequestInvalid";

/**
 * Query used to build a model-facing calibration packet. The optional filters
 * are conjunctions: if both hardware and calibration refs are supplied, a
 * record must match at least one of each selected ref category.
 */
export interface CalibrationExposureRequest {
  readonly purpose: CalibrationExposurePurpose;
  readonly hardware_refs?: readonly Ref[];
  readonly calibration_refs?: readonly Ref[];
  readonly include_actuator_limits?: boolean;
  readonly include_encoder_offsets?: boolean;
  readonly include_mount_matrices?: boolean;
}

/**
 * Validated camera self-knowledge derived from the manifest. The projection
 * matrix implements u = fx*x/z + cx and v = fy*y/z + cy in the camera frame.
 */
export interface DeclaredCameraCalibration {
  readonly sensor_ref: Ref;
  readonly camera_role: CameraSensorDescriptor["camera_role"];
  readonly intrinsics_ref: Ref;
  readonly extrinsics_ref: Ref;
  readonly calibration_version: string;
  readonly resolution_px: CameraResolution;
  readonly intrinsics: CameraIntrinsics;
  readonly intrinsic_matrix_3x3: Matrix3;
  readonly horizontal_fov_deg: number;
  readonly vertical_fov_deg: number;
  readonly mount_transform_body_from_sensor: Transform;
  readonly inverse_transform_sensor_from_body: Transform;
  readonly mount_matrix_body_from_sensor: Matrix4;
  readonly uncertainty_diagonal: readonly number[];
}

/**
 * Safe mount record for any declared sensor. It preserves body-relative
 * geometry without exposing simulator body handles or world-object refs.
 */
export interface DeclaredSensorMountCalibration {
  readonly hardware_ref: Ref;
  readonly hardware_kind: "sensor";
  readonly mount_frame_ref: Ref;
  readonly body_frame_ref: Ref;
  readonly calibration_ref: Ref;
  readonly mount_transform_body_from_sensor: Transform;
  readonly inverse_transform_sensor_from_body: Transform;
  readonly mount_matrix_body_from_sensor?: Matrix4;
  readonly uncertainty_diagonal: readonly number[];
}

/**
 * Microphone array geometry with deterministic baseline and maximum TDOA math.
 */
export interface DeclaredMicrophoneGeometryCalibration {
  readonly microphone_array_ref: Ref;
  readonly calibration_ref: Ref;
  readonly calibration_version: string;
  readonly channel_count: number;
  readonly channel_geometry: readonly MicrophoneChannelGeometry[];
  readonly centroid_m: Vector3;
  readonly pairwise_baselines_m: readonly {
    readonly from_channel: number;
    readonly to_channel: number;
    readonly distance_m: number;
    readonly maximum_tdoa_s: number;
  }[];
  readonly maximum_aperture_m: number;
}

/**
 * IMU alignment known to the robot, represented as a normalized body-relative
 * orientation transform and rotation matrix.
 */
export interface DeclaredImuAlignmentCalibration {
  readonly imu_sensor_ref: Ref;
  readonly calibration_ref: Ref;
  readonly calibration_version: string;
  readonly orientation_frame_ref: Ref;
  readonly mount_frame_ref: Ref;
  readonly body_from_imu_transform: Transform;
  readonly body_from_imu_matrix: Matrix4;
  readonly uncertainty_diagonal: readonly number[];
}

/**
 * Joint encoder zero offset and conversion helper. The corrected joint value is
 * raw_value - zero_offset in the declared measurement unit.
 */
export interface DeclaredEncoderOffsetCalibration {
  readonly encoder_ref: Ref;
  readonly joint_ref: Ref;
  readonly calibration_ref: Ref;
  readonly calibration_version: string;
  readonly measurement_unit: JointEncoderDescriptor["measurement_unit"];
  readonly zero_offset: number;
  readonly reports_velocity: boolean;
  readonly reports_effort: boolean;
}

/**
 * Actuator limits used by control, safety, and prompt self-knowledge. These
 * are declared hardware constraints, not observed world state.
 */
export interface DeclaredActuatorLimitCalibration {
  readonly actuator_ref: Ref;
  readonly actuator_class: ActuatorDescriptor["actuator_class"];
  readonly calibration_ref: Ref;
  readonly calibration_version: string;
  readonly command_interfaces: ActuatorDescriptor["command_interfaces"];
  readonly limit_envelope: ActuatorLimitEnvelope;
  readonly limit_summary: string;
}

/**
 * Canonical registry record that ties one declared calibration profile to the
 * hardware channels that use it.
 */
export interface CalibrationRegistryRecord {
  readonly calibration_ref: Ref;
  readonly calibration_kind: CalibrationKind;
  readonly frame_ref: Ref;
  readonly calibration_version: string;
  readonly hardware_refs: readonly Ref[];
  readonly cognitive_visible: boolean;
  readonly blocked_reason?: string;
  readonly hidden_fields_removed: readonly string[];
  readonly determinism_hash: string;
}

export interface CalibrationRegistryReport {
  readonly schema_version: typeof CALIBRATION_REGISTRY_SCHEMA_VERSION;
  readonly manifest_schema_version: typeof VIRTUAL_HARDWARE_MANIFEST_REGISTRY_SCHEMA_VERSION;
  readonly manifest_id: Ref;
  readonly record_count: number;
  readonly exposed_calibration_refs: readonly Ref[];
  readonly blocked_calibration_refs: readonly Ref[];
  readonly records: readonly CalibrationRegistryRecord[];
  readonly ok: boolean;
  readonly issue_count: number;
  readonly error_count: number;
  readonly warning_count: number;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface CognitiveCalibrationPacket {
  readonly schema_version: typeof CALIBRATION_REGISTRY_SCHEMA_VERSION;
  readonly packet_ref: Ref;
  readonly manifest_id: Ref;
  readonly purpose: CalibrationExposurePurpose;
  readonly camera_calibrations: readonly DeclaredCameraCalibration[];
  readonly sensor_mounts: readonly DeclaredSensorMountCalibration[];
  readonly microphone_geometries: readonly DeclaredMicrophoneGeometryCalibration[];
  readonly imu_alignments: readonly DeclaredImuAlignmentCalibration[];
  readonly encoder_offsets: readonly DeclaredEncoderOffsetCalibration[];
  readonly actuator_limits: readonly DeclaredActuatorLimitCalibration[];
  readonly uncertainty_summary: string;
  readonly hidden_fields_removed: readonly string[];
  readonly issues: readonly ValidationIssue[];
  readonly cognitive_visibility: "declared_calibration_self_knowledge";
  readonly determinism_hash: string;
}

export interface CameraProjectionResult {
  readonly sensor_ref: Ref;
  readonly point_camera_m: Vector3;
  readonly pixel_u: number;
  readonly pixel_v: number;
  readonly normalized_x: number;
  readonly normalized_y: number;
  readonly depth_m: number;
  readonly inside_image: boolean;
  readonly determinism_hash: string;
}

export interface ActuatorLimitClampResult {
  readonly actuator_ref: Ref;
  readonly requested_position?: number;
  readonly requested_velocity?: number;
  readonly requested_effort?: number;
  readonly clamped_position?: number;
  readonly clamped_velocity?: number;
  readonly clamped_effort?: number;
  readonly saturated_fields: readonly ("position" | "velocity" | "effort")[];
  readonly safe_to_apply: boolean;
  readonly determinism_hash: string;
}

export interface CalibrationRegistryConfig {
  readonly registry: VirtualHardwareManifestRegistry;
  readonly manifest_id: Ref;
  readonly allow_qa_import_for_cognitive_use?: boolean;
}

export class CalibrationRegistryError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "CalibrationRegistryError";
    this.issues = issues;
  }
}

/**
 * Provides validated calibration lookup, model-facing calibration packets, and
 * concrete camera/transform/limit helpers for declared virtual hardware.
 */
export class CalibrationRegistry {
  private readonly manifest: VirtualHardwareManifest;
  private readonly allowQaImportForCognitiveUse: boolean;

  public constructor(private readonly config: CalibrationRegistryConfig) {
    this.manifest = config.registry.requireManifest(config.manifest_id);
    this.allowQaImportForCognitiveUse = config.allow_qa_import_for_cognitive_use ?? false;
  }

  /**
   * Builds the complete validation report for manifest calibration closure.
   */
  public validateCalibrationClosure(): CalibrationRegistryReport {
    const issues: ValidationIssue[] = [];
    const records = this.buildRecords(issues);
    const exposed = records.filter((record) => record.cognitive_visible).map((record) => record.calibration_ref).sort();
    const blocked = records.filter((record) => !record.cognitive_visible).map((record) => record.calibration_ref).sort();
    const errorCount = issues.filter((issue) => issue.severity === "error").length;
    const reportBase = {
      schema_version: CALIBRATION_REGISTRY_SCHEMA_VERSION,
      manifest_schema_version: VIRTUAL_HARDWARE_MANIFEST_REGISTRY_SCHEMA_VERSION,
      manifest_id: this.manifest.manifest_id,
      record_count: records.length,
      exposed_calibration_refs: freezeArray(exposed),
      blocked_calibration_refs: freezeArray(blocked),
      records: freezeArray(records),
      ok: errorCount === 0,
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

  /**
   * Resolves a declared calibration profile and validates the requested kind.
   */
  public requireCalibration(calibrationRef: Ref, expectedKind?: CalibrationKind): CalibrationProfile {
    const profile = this.manifest.calibration_profiles.find((candidate) => candidate.calibration_profile_ref === calibrationRef);
    const issues: ValidationIssue[] = [];
    if (profile === undefined) {
      issues.push(makeIssue("error", "ManifestCalibrationMissing", "$.calibration_ref", `Calibration ${calibrationRef} is not declared in manifest ${this.manifest.manifest_id}.`, "Declare the calibration in the active hardware manifest."));
      throw new CalibrationRegistryError("Calibration profile is not declared.", issues);
    }
    if (expectedKind !== undefined && profile.calibration_kind !== expectedKind) {
      issues.push(makeIssue("error", "CalibrationKindMismatch", "$.calibration_kind", `Calibration ${calibrationRef} is ${profile.calibration_kind}, not ${expectedKind}.`, "Request a calibration profile of the matching kind."));
      throw new CalibrationRegistryError("Calibration kind mismatch.", issues);
    }
    return profile;
  }

  /**
   * Creates a cognitive-safe packet of declared calibration self-knowledge.
   */
  public buildCognitiveCalibrationPacket(request: CalibrationExposureRequest): CognitiveCalibrationPacket {
    const issues: ValidationIssue[] = [];
    validateRequest(request, issues);
    const report = this.validateCalibrationClosure();
    issues.push(...report.issues.filter((issue) => issue.severity === "error"));

    const selectedProfiles = this.selectProfiles(request, issues);
    const selectedRefs = new Set(selectedProfiles.map((profile) => profile.calibration_profile_ref));
    const selectedHardwareRefs = request.hardware_refs === undefined ? undefined : new Set(request.hardware_refs);

    const cameras = this.manifest.sensor_inventory
      .filter(isCameraSensor)
      .filter((sensor) => includesHardware(selectedHardwareRefs, sensor.sensor_id))
      .filter((sensor) => selectedRefs.has(sensor.intrinsics_ref) || selectedRefs.has(sensor.extrinsics_ref) || selectedRefs.has(sensor.calibration_ref))
      .map((sensor) => this.buildCameraCalibration(sensor, issues))
      .filter(isDefined);

    const mounts = this.manifest.sensor_inventory
      .filter((sensor) => includesHardware(selectedHardwareRefs, sensor.sensor_id))
      .filter((sensor) => selectedRefs.has(sensor.calibration_ref))
      .map((sensor) => this.buildSensorMountCalibration(sensor, request.include_mount_matrices ?? true, issues))
      .filter(isDefined);

    const microphones = this.manifest.sensor_inventory
      .filter(isMicrophoneArray)
      .filter((sensor) => includesHardware(selectedHardwareRefs, sensor.sensor_id))
      .filter((sensor) => selectedRefs.has(sensor.calibration_ref))
      .map((sensor) => this.buildMicrophoneGeometryCalibration(sensor, issues))
      .filter(isDefined);

    const imuAlignments = this.manifest.sensor_inventory
      .filter(isImuSensor)
      .filter((sensor) => includesHardware(selectedHardwareRefs, sensor.sensor_id))
      .filter((sensor) => selectedRefs.has(sensor.calibration_ref))
      .map((sensor) => this.buildImuAlignmentCalibration(sensor, issues))
      .filter(isDefined);

    const encoders = (request.include_encoder_offsets ?? true)
      ? this.manifest.sensor_inventory
        .filter(isJointEncoder)
        .filter((sensor) => includesHardware(selectedHardwareRefs, sensor.sensor_id))
        .filter((sensor) => selectedRefs.has(sensor.calibration_ref))
        .map((sensor) => this.buildEncoderOffsetCalibration(sensor, issues))
        .filter(isDefined)
      : [];

    const actuatorLimits = (request.include_actuator_limits ?? true)
      ? this.manifest.actuator_inventory
        .filter((actuator) => includesHardware(selectedHardwareRefs, actuator.actuator_id))
        .filter((actuator) => selectedRefs.has(actuator.calibration_ref))
        .map((actuator) => this.buildActuatorLimitCalibration(actuator, issues))
        .filter(isDefined)
      : [];

    const packetBase = {
      schema_version: CALIBRATION_REGISTRY_SCHEMA_VERSION,
      packet_ref: `calibration_packet_${this.manifest.manifest_id}_${request.purpose}_${computeDeterminismHash({ request, selectedRefs: [...selectedRefs].sort() }).slice(0, 12)}`,
      manifest_id: this.manifest.manifest_id,
      purpose: request.purpose,
      camera_calibrations: freezeArray(cameras),
      sensor_mounts: freezeArray(mounts),
      microphone_geometries: freezeArray(microphones),
      imu_alignments: freezeArray(imuAlignments),
      encoder_offsets: freezeArray(encoders),
      actuator_limits: freezeArray(actuatorLimits),
      uncertainty_summary: summarizeUncertainty(cameras, mounts, microphones, imuAlignments, encoders, actuatorLimits),
      hidden_fields_removed: freezeArray([
        "backend_engine_ref",
        "engine_body_handle",
        "scene_graph_path",
        "world_truth_transform",
        "ground_truth_object_pose",
        "qa_success_flags",
        "collision_mesh_ref",
        "render_node_ref",
      ]),
      issues: freezeArray(dedupeIssues(issues)),
      cognitive_visibility: "declared_calibration_self_knowledge" as const,
    };
    return Object.freeze({
      ...packetBase,
      determinism_hash: computeDeterminismHash(packetBase),
    });
  }

  /**
   * Projects a body-observed camera-frame point into calibrated image pixels.
   */
  public projectCameraPoint(sensorRef: Ref, pointCameraM: Vector3): CameraProjectionResult {
    const issues: ValidationIssue[] = [];
    const sensor = this.manifest.sensor_inventory.find((candidate): candidate is CameraSensorDescriptor => isCameraSensor(candidate) && candidate.sensor_id === sensorRef);
    if (sensor === undefined) {
      throw new CalibrationRegistryError("Camera sensor is not declared.", [
        makeIssue("error", "CalibrationHardwareUndeclared", "$.sensor_ref", `Camera ${sensorRef} is not declared.`, "Declare the camera in the active hardware manifest."),
      ]);
    }
    const calibration = this.buildCameraCalibration(sensor, issues);
    if (calibration === undefined || issues.some((issue) => issue.severity === "error")) {
      throw new CalibrationRegistryError("Camera calibration cannot project points.", issues);
    }
    if (!isFiniteVector3(pointCameraM) || pointCameraM[2] <= EPSILON) {
      throw new CalibrationRegistryError("Camera projection point is invalid.", [
        makeIssue("error", "CalibrationRequestInvalid", "$.point_camera_m", "Projection requires a finite point with positive z depth in the camera frame.", "Use camera-frame meters with z > 0."),
      ]);
    }
    const x = pointCameraM[0] / pointCameraM[2];
    const y = pointCameraM[1] / pointCameraM[2];
    const u = calibration.intrinsics.fx_px * x + calibration.intrinsics.cx_px;
    const v = calibration.intrinsics.fy_px * y + calibration.intrinsics.cy_px;
    const resultBase = {
      sensor_ref: sensorRef,
      point_camera_m: freezeVector3(pointCameraM),
      pixel_u: round6(u),
      pixel_v: round6(v),
      normalized_x: round6(x),
      normalized_y: round6(y),
      depth_m: round6(pointCameraM[2]),
      inside_image: u >= 0 && v >= 0 && u < sensor.resolution.width_px && v < sensor.resolution.height_px,
    };
    return Object.freeze({
      ...resultBase,
      determinism_hash: computeDeterminismHash(resultBase),
    });
  }

  /**
   * Clamps a desired actuator command against declared actuator limits.
   */
  public clampActuatorCommand(
    actuatorRef: Ref,
    command: {
      readonly position?: number;
      readonly velocity?: number;
      readonly effort?: number;
    },
  ): ActuatorLimitClampResult {
    const actuator = this.manifest.actuator_inventory.find((candidate) => candidate.actuator_id === actuatorRef);
    if (actuator === undefined) {
      throw new CalibrationRegistryError("Actuator is not declared.", [
        makeIssue("error", "CalibrationHardwareUndeclared", "$.actuator_ref", `Actuator ${actuatorRef} is not declared.`, "Declare the actuator before enforcing limits."),
      ]);
    }
    const saturated: ("position" | "velocity" | "effort")[] = [];
    const limits = actuator.limit_envelope;
    const clampedPosition = command.position === undefined ? undefined : clampOptional(command.position, limits.min_position, limits.max_position, "position", saturated);
    const clampedVelocity = command.velocity === undefined ? undefined : clampSymmetric(command.velocity, limits.max_velocity, "velocity", saturated);
    const clampedEffort = command.effort === undefined ? undefined : clampSymmetric(command.effort, limits.max_effort, "effort", saturated);
    const resultBase = {
      actuator_ref: actuatorRef,
      requested_position: command.position,
      requested_velocity: command.velocity,
      requested_effort: command.effort,
      clamped_position: clampedPosition,
      clamped_velocity: clampedVelocity,
      clamped_effort: clampedEffort,
      saturated_fields: freezeArray([...new Set(saturated)]),
      safe_to_apply: [command.position, command.velocity, command.effort].every((value) => value === undefined || Number.isFinite(value)),
    };
    return Object.freeze({
      ...resultBase,
      determinism_hash: computeDeterminismHash(resultBase),
    });
  }

  /**
   * Applies a declared rigid transform to a local point.
   */
  public transformPoint(calibrationRef: Ref, pointM: Vector3, direction: "forward" | "inverse" = "forward"): Vector3 {
    const profile = this.requireCalibration(calibrationRef);
    if (profile.transform === undefined) {
      throw new CalibrationRegistryError("Calibration profile has no transform.", [
        makeIssue("error", "CalibrationTransformInvalid", "$.transform", `Calibration ${calibrationRef} does not contain a transform.`, "Use a mount, extrinsics, or IMU alignment calibration."),
      ]);
    }
    const transform = direction === "forward" ? profile.transform : invertTransform(profile.transform);
    return applyTransform(transform, pointM);
  }

  private selectProfiles(request: CalibrationExposureRequest, issues: ValidationIssue[]): readonly CalibrationProfile[] {
    const requestedRefs = request.calibration_refs === undefined ? undefined : new Set(request.calibration_refs);
    if (requestedRefs !== undefined) {
      for (const ref of requestedRefs) {
        if (!this.manifest.calibration_profiles.some((profile) => profile.calibration_profile_ref === ref)) {
          issues.push(makeIssue("error", "ManifestCalibrationMissing", "$.calibration_refs", `Requested calibration ${ref} is not declared.`, "Request only calibration refs from the active manifest."));
        }
      }
    }
    return freezeArray(this.manifest.calibration_profiles
      .filter((profile) => requestedRefs === undefined || requestedRefs.has(profile.calibration_profile_ref))
      .filter((profile) => this.isProfileCognitiveVisible(profile, issues, `$.calibration_profiles.${profile.calibration_profile_ref}`)));
  }

  private buildRecords(issues: ValidationIssue[]): readonly CalibrationRegistryRecord[] {
    const seen = new Set<Ref>();
    const records: CalibrationRegistryRecord[] = [];
    for (const profile of this.manifest.calibration_profiles) {
      const path = `$.calibration_profiles.${profile.calibration_profile_ref}`;
      validateCalibrationProfile(profile, issues, path, this.allowQaImportForCognitiveUse);
      if (seen.has(profile.calibration_profile_ref)) {
        issues.push(makeIssue("error", "ManifestCalibrationDuplicate", path, `Calibration ${profile.calibration_profile_ref} is duplicated.`, "Calibration profile refs must be unique."));
      }
      seen.add(profile.calibration_profile_ref);
      const hardwareRefs = hardwareRefsForCalibration(this.manifest, profile.calibration_profile_ref);
      if (hardwareRefs.length === 0) {
        issues.push(makeIssue("warning", "CalibrationHardwareUndeclared", path, `Calibration ${profile.calibration_profile_ref} is not used by declared hardware.`, "Attach calibration to a sensor or actuator, or remove stale calibration."));
      }
      const blockedReason = blockedReasonForProfile(profile, this.allowQaImportForCognitiveUse);
      const recordBase = {
        calibration_ref: profile.calibration_profile_ref,
        calibration_kind: profile.calibration_kind,
        frame_ref: profile.frame_ref,
        calibration_version: profile.version,
        hardware_refs: freezeArray(hardwareRefs),
        cognitive_visible: blockedReason === undefined && scanForbiddenTruth(profile, path, issues).length === 0,
        blocked_reason: blockedReason,
        hidden_fields_removed: freezeArray(["backend_engine_ref", "hidden_world_truth", "qa_truth_refs"]),
      };
      records.push(Object.freeze({
        ...recordBase,
        determinism_hash: computeDeterminismHash(recordBase),
      }));
    }
    for (const ref of this.manifest.calibration_profile_refs) {
      if (!seen.has(ref)) {
        issues.push(makeIssue("error", "ManifestCalibrationMissing", "$.calibration_profile_refs", `Manifest references missing calibration profile ${ref}.`, "Supply the calibration profile record."));
      }
    }
    for (const sensor of this.manifest.sensor_inventory) {
      this.validateSensorCalibrationLinks(sensor, seen, issues);
    }
    for (const actuator of this.manifest.actuator_inventory) {
      if (!seen.has(actuator.calibration_ref)) {
        issues.push(makeIssue("error", "ManifestCalibrationMissing", `$.actuator_inventory.${actuator.actuator_id}.calibration_ref`, `Actuator ${actuator.actuator_id} references missing calibration ${actuator.calibration_ref}.`, "Declare actuator limit calibration before command use."));
      }
    }
    return freezeArray(records.sort((a, b) => a.calibration_ref.localeCompare(b.calibration_ref)));
  }

  private validateSensorCalibrationLinks(sensor: VirtualSensorDescriptor, calibrationRefs: ReadonlySet<Ref>, issues: ValidationIssue[]): void {
    if (!calibrationRefs.has(sensor.calibration_ref)) {
      issues.push(makeIssue("error", "ManifestCalibrationMissing", `$.sensor_inventory.${sensor.sensor_id}.calibration_ref`, `Sensor ${sensor.sensor_id} references missing calibration ${sensor.calibration_ref}.`, "Declare the sensor mount calibration."));
    }
    if (isCameraSensor(sensor)) {
      if (!calibrationRefs.has(sensor.intrinsics_ref)) {
        issues.push(makeIssue("error", "ManifestCalibrationMissing", `$.sensor_inventory.${sensor.sensor_id}.intrinsics_ref`, `Camera ${sensor.sensor_id} references missing intrinsics ${sensor.intrinsics_ref}.`, "Declare camera intrinsics."));
      }
      if (!calibrationRefs.has(sensor.extrinsics_ref)) {
        issues.push(makeIssue("error", "ManifestCalibrationMissing", `$.sensor_inventory.${sensor.sensor_id}.extrinsics_ref`, `Camera ${sensor.sensor_id} references missing extrinsics ${sensor.extrinsics_ref}.`, "Declare camera mount extrinsics."));
      }
    }
  }

  private isProfileCognitiveVisible(profile: CalibrationProfile, issues: ValidationIssue[], path: string): boolean {
    const blockedReason = blockedReasonForProfile(profile, this.allowQaImportForCognitiveUse);
    if (blockedReason !== undefined) {
      issues.push(makeIssue("warning", "CalibrationVisibilityBlocked", path, `Calibration ${profile.calibration_profile_ref} is blocked: ${blockedReason}.`, "Expose only declared calibration self-knowledge."));
      return false;
    }
    return scanForbiddenTruth(profile, path, issues).length === 0;
  }

  private buildCameraCalibration(sensor: CameraSensorDescriptor, issues: ValidationIssue[]): DeclaredCameraCalibration | undefined {
    const intrinsicsProfile = this.profileIfVisible(sensor.intrinsics_ref, "camera_intrinsics", issues);
    const extrinsicsProfile = this.profileIfVisible(sensor.extrinsics_ref, "sensor_mount_extrinsics", issues);
    if (intrinsicsProfile?.camera_intrinsics === undefined || extrinsicsProfile?.transform === undefined) {
      issues.push(makeIssue("error", "CalibrationIntrinsicsInvalid", `$.sensor_inventory.${sensor.sensor_id}`, `Camera ${sensor.sensor_id} requires declared intrinsics and extrinsics.`, "Attach camera_intrinsics and sensor_mount_extrinsics profiles."));
      return undefined;
    }
    validateCameraIntrinsics(intrinsicsProfile.camera_intrinsics, sensor.resolution, issues, `$.calibration_profiles.${sensor.intrinsics_ref}.camera_intrinsics`);
    validateTransform(extrinsicsProfile.transform, issues, `$.calibration_profiles.${sensor.extrinsics_ref}.transform`);
    const inverse = invertTransform(extrinsicsProfile.transform);
    return Object.freeze({
      sensor_ref: sensor.sensor_id,
      camera_role: sensor.camera_role,
      intrinsics_ref: sensor.intrinsics_ref,
      extrinsics_ref: sensor.extrinsics_ref,
      calibration_version: `${intrinsicsProfile.version}+${extrinsicsProfile.version}`,
      resolution_px: sensor.resolution,
      intrinsics: intrinsicsProfile.camera_intrinsics,
      intrinsic_matrix_3x3: cameraIntrinsicMatrix(intrinsicsProfile.camera_intrinsics),
      horizontal_fov_deg: round6(fovDeg(sensor.resolution.width_px, intrinsicsProfile.camera_intrinsics.fx_px)),
      vertical_fov_deg: round6(fovDeg(sensor.resolution.height_px, intrinsicsProfile.camera_intrinsics.fy_px)),
      mount_transform_body_from_sensor: normalizeTransform(extrinsicsProfile.transform),
      inverse_transform_sensor_from_body: inverse,
      mount_matrix_body_from_sensor: transformToMatrix4(extrinsicsProfile.transform),
      uncertainty_diagonal: freezeArray([...(intrinsicsProfile.covariance_diagonal ?? []), ...(extrinsicsProfile.covariance_diagonal ?? [])]),
    });
  }

  private buildSensorMountCalibration(sensor: VirtualSensorDescriptor, includeMatrix: boolean, issues: ValidationIssue[]): DeclaredSensorMountCalibration | undefined {
    const profile = this.profileIfVisible(sensor.calibration_ref, undefined, issues);
    const transform = profile?.transform ?? sensor.mount_transform;
    validateTransform(transform, issues, `$.sensor_inventory.${sensor.sensor_id}.mount_transform`);
    const mountBase = {
      hardware_ref: sensor.sensor_id,
      hardware_kind: "sensor" as const,
      mount_frame_ref: sensor.mount_frame_ref,
      body_frame_ref: sensor.body_ref,
      calibration_ref: sensor.calibration_ref,
      mount_transform_body_from_sensor: normalizeTransform(transform),
      inverse_transform_sensor_from_body: invertTransform(transform),
      mount_matrix_body_from_sensor: includeMatrix ? transformToMatrix4(transform) : undefined,
      uncertainty_diagonal: freezeArray(profile?.covariance_diagonal ?? []),
    };
    return Object.freeze(mountBase);
  }

  private buildMicrophoneGeometryCalibration(sensor: MicrophoneArrayDescriptor, issues: ValidationIssue[]): DeclaredMicrophoneGeometryCalibration | undefined {
    const profile = this.profileIfVisible(sensor.calibration_ref, "microphone_array_geometry", issues);
    const geometry = profile?.microphone_channel_geometry ?? sensor.channel_geometry;
    validateMicrophoneGeometry(geometry, sensor.channel_geometry.length, issues, `$.sensor_inventory.${sensor.sensor_id}.channel_geometry`);
    const centroid = centroid3(geometry.map((channel) => channel.local_position_m));
    const baselines = pairwiseBaselines(geometry);
    const base = {
      microphone_array_ref: sensor.sensor_id,
      calibration_ref: sensor.calibration_ref,
      calibration_version: profile?.version ?? "descriptor_declared",
      channel_count: sensor.channel_geometry.length,
      channel_geometry: freezeArray(geometry),
      centroid_m: centroid,
      pairwise_baselines_m: freezeArray(baselines),
      maximum_aperture_m: baselines.length === 0 ? 0 : round6(Math.max(...baselines.map((baseline) => baseline.distance_m))),
    };
    return Object.freeze(base);
  }

  private buildImuAlignmentCalibration(sensor: Extract<VirtualSensorDescriptor, { readonly sensor_class: "imu" }>, issues: ValidationIssue[]): DeclaredImuAlignmentCalibration | undefined {
    const profile = this.profileIfVisible(sensor.calibration_ref, "imu_alignment", issues);
    const transform = profile?.transform ?? sensor.mount_transform;
    validateTransform(transform, issues, `$.sensor_inventory.${sensor.sensor_id}.imu_alignment`);
    const base = {
      imu_sensor_ref: sensor.sensor_id,
      calibration_ref: sensor.calibration_ref,
      calibration_version: profile?.version ?? "descriptor_declared",
      orientation_frame_ref: sensor.orientation_frame_ref,
      mount_frame_ref: sensor.mount_frame_ref,
      body_from_imu_transform: normalizeTransform(transform),
      body_from_imu_matrix: transformToMatrix4(transform),
      uncertainty_diagonal: freezeArray(profile?.covariance_diagonal ?? []),
    };
    return Object.freeze(base);
  }

  private buildEncoderOffsetCalibration(sensor: JointEncoderDescriptor, issues: ValidationIssue[]): DeclaredEncoderOffsetCalibration | undefined {
    const profile = this.profileIfVisible(sensor.calibration_ref, "encoder_zero_offset", issues);
    const offset = profile?.scalar_offset ?? sensor.zero_offset;
    if (!Number.isFinite(offset)) {
      issues.push(makeIssue("error", "CalibrationEncoderOffsetInvalid", `$.sensor_inventory.${sensor.sensor_id}.zero_offset`, "Encoder zero offset must be finite.", "Use a calibrated finite zero offset."));
      return undefined;
    }
    return Object.freeze({
      encoder_ref: sensor.sensor_id,
      joint_ref: sensor.joint_ref,
      calibration_ref: sensor.calibration_ref,
      calibration_version: profile?.version ?? "descriptor_declared",
      measurement_unit: sensor.measurement_unit,
      zero_offset: round6(offset),
      reports_velocity: sensor.reports_velocity,
      reports_effort: sensor.reports_effort,
    });
  }

  private buildActuatorLimitCalibration(actuator: ActuatorDescriptor, issues: ValidationIssue[]): DeclaredActuatorLimitCalibration | undefined {
    const profile = this.profileIfVisible(actuator.calibration_ref, "actuator_limits", issues);
    validateActuatorLimits(actuator.limit_envelope, issues, `$.actuator_inventory.${actuator.actuator_id}.limit_envelope`);
    return Object.freeze({
      actuator_ref: actuator.actuator_id,
      actuator_class: actuator.actuator_class,
      calibration_ref: actuator.calibration_ref,
      calibration_version: profile?.version ?? "descriptor_declared",
      command_interfaces: actuator.command_interfaces,
      limit_envelope: Object.freeze({ ...actuator.limit_envelope }),
      limit_summary: summarizeActuatorLimits(actuator.limit_envelope),
    });
  }

  private profileIfVisible(calibrationRef: Ref, expectedKind: CalibrationKind | undefined, issues: ValidationIssue[]): CalibrationProfile | undefined {
    const profile = this.manifest.calibration_profiles.find((candidate) => candidate.calibration_profile_ref === calibrationRef);
    if (profile === undefined) {
      issues.push(makeIssue("error", "ManifestCalibrationMissing", "$.calibration_ref", `Calibration ${calibrationRef} is missing.`, "Declare the calibration profile."));
      return undefined;
    }
    if (expectedKind !== undefined && profile.calibration_kind !== expectedKind) {
      issues.push(makeIssue("error", "CalibrationKindMismatch", `$.calibration_profiles.${calibrationRef}.calibration_kind`, `Expected ${expectedKind}, got ${profile.calibration_kind}.`, "Use the calibration profile required by the hardware channel."));
      return undefined;
    }
    if (!this.isProfileCognitiveVisible(profile, issues, `$.calibration_profiles.${calibrationRef}`)) {
      return undefined;
    }
    return profile;
  }
}

export function createCalibrationRegistry(config: CalibrationRegistryConfig): CalibrationRegistry {
  return new CalibrationRegistry(config);
}

export function buildCognitiveCalibrationPacket(
  request: CalibrationExposureRequest,
  config: CalibrationRegistryConfig,
): CognitiveCalibrationPacket {
  return new CalibrationRegistry(config).buildCognitiveCalibrationPacket(request);
}

export function correctEncoderReading(rawValue: number, calibration: DeclaredEncoderOffsetCalibration): number {
  if (!Number.isFinite(rawValue)) {
    throw new TypeError("rawValue must be finite.");
  }
  return round6(rawValue - calibration.zero_offset);
}

function validateRequest(request: CalibrationExposureRequest, issues: ValidationIssue[]): void {
  if (!["planning_prompt", "verification_prompt", "oops_loop_prompt", "memory_grounded_prompt", "tool_use_prompt", "control_validation", "qa"].includes(request.purpose)) {
    issues.push(makeIssue("error", "CalibrationRequestInvalid", "$.purpose", "Calibration exposure purpose is unsupported.", "Use a declared calibration exposure purpose."));
  }
  for (const [field, values] of [["hardware_refs", request.hardware_refs], ["calibration_refs", request.calibration_refs]] as const) {
    if (values === undefined) {
      continue;
    }
    if (values.length === 0) {
      issues.push(makeIssue("warning", "CalibrationRequestInvalid", `$.${field}`, "Empty filter array selects no calibration data.", "Omit the filter or provide refs."));
    }
    for (const value of values) {
      validateRef(value, issues, `$.${field}`);
    }
  }
}

function validateCalibrationProfile(profile: CalibrationProfile, issues: ValidationIssue[], path: string, allowQaImport: boolean): void {
  validateRef(profile.calibration_profile_ref, issues, `${path}.calibration_profile_ref`);
  validateRef(profile.frame_ref, issues, `${path}.frame_ref`);
  validateRef(profile.version, issues, `${path}.version`);
  validateRef(profile.provenance_policy_ref, issues, `${path}.provenance_policy_ref`);
  if (!["camera_intrinsics", "sensor_mount_extrinsics", "microphone_array_geometry", "encoder_zero_offset", "imu_alignment", "actuator_limits"].includes(profile.calibration_kind)) {
    issues.push(makeIssue("error", "CalibrationKindMismatch", `${path}.calibration_kind`, "Calibration kind is unsupported.", "Use a calibration kind defined by the virtual hardware specification."));
  }
  const blockedReason = blockedReasonForProfile(profile, allowQaImport);
  if (blockedReason !== undefined) {
    issues.push(makeIssue("warning", "CalibrationVisibilityBlocked", `${path}.cognitive_visibility`, `Calibration is not cognitive-visible: ${blockedReason}.`, "Only declared calibration self-knowledge may cross the firewall."));
  }
  if (profile.transform !== undefined) {
    validateTransform(profile.transform, issues, `${path}.transform`);
  }
  if (profile.camera_intrinsics !== undefined) {
    validateCameraIntrinsics(profile.camera_intrinsics, undefined, issues, `${path}.camera_intrinsics`);
  }
  if (profile.microphone_channel_geometry !== undefined) {
    validateMicrophoneGeometry(profile.microphone_channel_geometry, undefined, issues, `${path}.microphone_channel_geometry`);
  }
  if (profile.scalar_offset !== undefined && !Number.isFinite(profile.scalar_offset)) {
    issues.push(makeIssue("error", "CalibrationEncoderOffsetInvalid", `${path}.scalar_offset`, "Scalar calibration offset must be finite.", "Use a finite encoder offset."));
  }
  if (profile.covariance_diagonal !== undefined && profile.covariance_diagonal.some((value) => !Number.isFinite(value) || value < 0)) {
    issues.push(makeIssue("error", "CalibrationTransformInvalid", `${path}.covariance_diagonal`, "Calibration covariance diagonal must be finite and nonnegative.", "Use nonnegative uncertainty terms."));
  }
  scanForbiddenTruth(profile, path, issues);
}

function validateCameraIntrinsics(intrinsics: CameraIntrinsics, resolution: CameraResolution | undefined, issues: ValidationIssue[], path: string): void {
  for (const [field, value] of [["fx_px", intrinsics.fx_px], ["fy_px", intrinsics.fy_px]] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      issues.push(makeIssue("error", "CalibrationIntrinsicsInvalid", `${path}.${field}`, "Camera focal length must be positive and finite.", "Use calibrated positive focal lengths."));
    }
  }
  if (!Number.isFinite(intrinsics.cx_px) || !Number.isFinite(intrinsics.cy_px)) {
    issues.push(makeIssue("error", "CalibrationIntrinsicsInvalid", path, "Camera principal point must be finite.", "Use finite cx/cy pixel coordinates."));
  }
  if (!["none", "brown_conrady", "fisheye"].includes(intrinsics.distortion_model)) {
    issues.push(makeIssue("error", "CalibrationIntrinsicsInvalid", `${path}.distortion_model`, "Camera distortion model is unsupported.", "Use none, brown_conrady, or fisheye."));
  }
  if (intrinsics.distortion_coefficients.some((value) => !Number.isFinite(value))) {
    issues.push(makeIssue("error", "CalibrationIntrinsicsInvalid", `${path}.distortion_coefficients`, "Distortion coefficients must be finite.", "Use calibrated finite coefficients."));
  }
  if (resolution !== undefined && (intrinsics.cx_px < 0 || intrinsics.cy_px < 0 || intrinsics.cx_px > resolution.width_px || intrinsics.cy_px > resolution.height_px)) {
    issues.push(makeIssue("warning", "CalibrationIntrinsicsInvalid", path, "Camera principal point is outside declared resolution.", "Confirm intrinsics and resolution use the same image space."));
  }
}

function validateMicrophoneGeometry(geometry: readonly MicrophoneChannelGeometry[], expectedCount: number | undefined, issues: ValidationIssue[], path: string): void {
  if (geometry.length === 0) {
    issues.push(makeIssue("error", "CalibrationMicrophoneGeometryInvalid", path, "Microphone geometry requires at least one channel.", "Declare channel mount frames and local positions."));
    return;
  }
  if (expectedCount !== undefined && geometry.length !== expectedCount) {
    issues.push(makeIssue("error", "CalibrationMicrophoneGeometryInvalid", path, `Microphone geometry has ${geometry.length} channels, expected ${expectedCount}.`, "Align descriptor channel count and calibration geometry."));
  }
  const indices = new Set<number>();
  for (const [index, channel] of geometry.entries()) {
    if (!Number.isInteger(channel.channel_index) || channel.channel_index < 0) {
      issues.push(makeIssue("error", "CalibrationMicrophoneGeometryInvalid", `${path}[${index}].channel_index`, "Channel index must be a nonnegative integer.", "Use zero-based channel indices."));
    }
    if (indices.has(channel.channel_index)) {
      issues.push(makeIssue("error", "CalibrationMicrophoneGeometryInvalid", `${path}[${index}].channel_index`, "Channel indices must be unique.", "Rename the duplicate microphone channel index."));
    }
    indices.add(channel.channel_index);
    validateRef(channel.mount_frame_ref, issues, `${path}[${index}].mount_frame_ref`);
    if (!isFiniteVector3(channel.local_position_m)) {
      issues.push(makeIssue("error", "CalibrationMicrophoneGeometryInvalid", `${path}[${index}].local_position_m`, "Channel local position must be a finite Vector3.", "Use [x, y, z] meters."));
    }
  }
}

function validateTransform(transform: Transform, issues: ValidationIssue[], path: string): void {
  validateRef(transform.frame_ref, issues, `${path}.frame_ref`);
  if (!isFiniteVector3(transform.position_m)) {
    issues.push(makeIssue("error", "CalibrationTransformInvalid", `${path}.position_m`, "Transform position must be a finite Vector3.", "Use [x, y, z] meters."));
  }
  if (!isFiniteQuaternion(transform.orientation_xyzw)) {
    issues.push(makeIssue("error", "CalibrationTransformInvalid", `${path}.orientation_xyzw`, "Transform orientation must be a finite quaternion.", "Use [x, y, z, w]."));
    return;
  }
  const norm = quaternionNorm(transform.orientation_xyzw);
  if (norm < EPSILON || Math.abs(norm - 1) > 1e-6) {
    issues.push(makeIssue("error", "CalibrationTransformInvalid", `${path}.orientation_xyzw`, "Transform orientation quaternion must be unit length.", "Normalize declared mount orientation."));
  }
}

function validateActuatorLimits(limits: ActuatorLimitEnvelope, issues: ValidationIssue[], path: string): void {
  const values = [limits.min_position, limits.max_position, limits.max_velocity, limits.max_effort, limits.max_acceleration].filter((value): value is number => value !== undefined);
  if (values.length === 0) {
    issues.push(makeIssue("error", "CalibrationActuatorLimitInvalid", path, "Actuator limit calibration requires at least one limit.", "Declare position, velocity, effort, or acceleration limits."));
  }
  for (const value of values) {
    if (!Number.isFinite(value)) {
      issues.push(makeIssue("error", "CalibrationActuatorLimitInvalid", path, "Actuator limits must be finite.", "Replace NaN or infinite limit values."));
    }
  }
  if (limits.min_position !== undefined && limits.max_position !== undefined && limits.min_position >= limits.max_position) {
    issues.push(makeIssue("error", "CalibrationActuatorLimitInvalid", path, "Actuator min_position must be below max_position.", "Correct the actuator position range."));
  }
  for (const [field, value] of [["max_velocity", limits.max_velocity], ["max_effort", limits.max_effort], ["max_acceleration", limits.max_acceleration]] as const) {
    if (value !== undefined && value <= 0) {
      issues.push(makeIssue("error", "CalibrationActuatorLimitInvalid", `${path}.${field}`, "Actuator maximum limits must be positive.", "Use positive calibrated maxima."));
    }
  }
}

function scanForbiddenTruth(value: unknown, path: string, issues: ValidationIssue[]): readonly string[] {
  const findings: string[] = [];
  scanForbiddenValue(value, path, "", findings);
  for (const finding of findings) {
    issues.push(makeIssue("error", "CalibrationHiddenTruthDetected", finding, "Calibration contains a hidden simulator or QA truth field.", "Remove backend refs, scene truth, QA truth, and engine handles before exposure."));
  }
  return freezeArray(findings);
}

function scanForbiddenValue(value: unknown, path: string, key: string, findings: string[]): void {
  if (key.length > 0 && FORBIDDEN_KEY_PATTERN.test(key)) {
    findings.push(path);
  }
  if (typeof value === "string") {
    if (FORBIDDEN_STRING_PATTERN.test(value)) {
      findings.push(path);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanForbiddenValue(entry, `${path}[${index}]`, key, findings));
    return;
  }
  if (isRecord(value)) {
    for (const [childKey, childValue] of Object.entries(value)) {
      scanForbiddenValue(childValue, `${path}.${childKey}`, childKey, findings);
    }
  }
}

function blockedReasonForProfile(profile: CalibrationProfile, allowQaImport: boolean): string | undefined {
  if (profile.cognitive_visibility === "declared_calibration_allowed") {
    return undefined;
  }
  if (profile.cognitive_visibility === "qa_only" && allowQaImport) {
    return undefined;
  }
  return profile.cognitive_visibility;
}

function hardwareRefsForCalibration(manifest: VirtualHardwareManifest, calibrationRef: Ref): readonly Ref[] {
  const refs: Ref[] = [];
  for (const sensor of manifest.sensor_inventory) {
    if (sensor.calibration_ref === calibrationRef) {
      refs.push(sensor.sensor_id);
    }
    if (isCameraSensor(sensor) && (sensor.intrinsics_ref === calibrationRef || sensor.extrinsics_ref === calibrationRef)) {
      refs.push(sensor.sensor_id);
    }
  }
  for (const actuator of manifest.actuator_inventory) {
    if (actuator.calibration_ref === calibrationRef) {
      refs.push(actuator.actuator_id);
    }
  }
  return freezeArray([...new Set(refs)].sort());
}

function includesHardware(filter: ReadonlySet<Ref> | undefined, hardwareRef: Ref): boolean {
  return filter === undefined || filter.has(hardwareRef);
}

function cameraIntrinsicMatrix(intrinsics: CameraIntrinsics): Matrix3 {
  return Object.freeze([
    Object.freeze([intrinsics.fx_px, 0, intrinsics.cx_px]),
    Object.freeze([0, intrinsics.fy_px, intrinsics.cy_px]),
    Object.freeze([0, 0, 1]),
  ]) as Matrix3;
}

function fovDeg(pixelExtent: number, focalLengthPx: number): number {
  return (2 * Math.atan(pixelExtent / (2 * focalLengthPx)) * 180) / Math.PI;
}

function transformToMatrix4(transform: Transform): Matrix4 {
  const normalized = normalizeTransform(transform);
  const rotation = quaternionToRotationMatrix(normalized.orientation_xyzw);
  return Object.freeze([
    Object.freeze([rotation[0][0], rotation[0][1], rotation[0][2], normalized.position_m[0]]),
    Object.freeze([rotation[1][0], rotation[1][1], rotation[1][2], normalized.position_m[1]]),
    Object.freeze([rotation[2][0], rotation[2][1], rotation[2][2], normalized.position_m[2]]),
    Object.freeze([0, 0, 0, 1]),
  ]) as Matrix4;
}

function quaternionToRotationMatrix(q: Quaternion): Matrix3 {
  const n = normalizeQuaternion(q);
  const [x, y, z, w] = n;
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
    Object.freeze([1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy)]),
    Object.freeze([2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx)]),
    Object.freeze([2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)]),
  ]) as Matrix3;
}

function invertTransform(transform: Transform): Transform {
  const normalized = normalizeTransform(transform);
  const inverseRotation = conjugateQuaternion(normalized.orientation_xyzw);
  const rotatedNegative = rotateVector(inverseRotation, [-normalized.position_m[0], -normalized.position_m[1], -normalized.position_m[2]]);
  return Object.freeze({
    frame_ref: normalized.frame_ref,
    position_m: rotatedNegative,
    orientation_xyzw: inverseRotation,
  });
}

function applyTransform(transform: Transform, point: Vector3): Vector3 {
  if (!isFiniteVector3(point)) {
    throw new TypeError("point must be a finite Vector3.");
  }
  const rotated = rotateVector(transform.orientation_xyzw, point);
  return freezeVector3([
    rotated[0] + transform.position_m[0],
    rotated[1] + transform.position_m[1],
    rotated[2] + transform.position_m[2],
  ]);
}

function rotateVector(q: Quaternion, v: Vector3): Vector3 {
  const n = normalizeQuaternion(q);
  const [qx, qy, qz, qw] = n;
  const uv: Vector3 = [
    qy * v[2] - qz * v[1],
    qz * v[0] - qx * v[2],
    qx * v[1] - qy * v[0],
  ];
  const uuv: Vector3 = [
    qy * uv[2] - qz * uv[1],
    qz * uv[0] - qx * uv[2],
    qx * uv[1] - qy * uv[0],
  ];
  return freezeVector3([
    v[0] + 2 * (qw * uv[0] + uuv[0]),
    v[1] + 2 * (qw * uv[1] + uuv[1]),
    v[2] + 2 * (qw * uv[2] + uuv[2]),
  ]);
}

function pairwiseBaselines(geometry: readonly MicrophoneChannelGeometry[]): readonly DeclaredMicrophoneGeometryCalibration["pairwise_baselines_m"][number][] {
  const baselines: DeclaredMicrophoneGeometryCalibration["pairwise_baselines_m"][number][] = [];
  for (let i = 0; i < geometry.length; i += 1) {
    for (let j = i + 1; j < geometry.length; j += 1) {
      const distance = distance3(geometry[i].local_position_m, geometry[j].local_position_m);
      baselines.push(Object.freeze({
        from_channel: geometry[i].channel_index,
        to_channel: geometry[j].channel_index,
        distance_m: round6(distance),
        maximum_tdoa_s: round9(distance / SPEED_OF_SOUND_M_PER_S),
      }));
    }
  }
  return freezeArray(baselines.sort((a, b) => a.from_channel - b.from_channel || a.to_channel - b.to_channel));
}

function centroid3(points: readonly Vector3[]): Vector3 {
  if (points.length === 0) {
    return Object.freeze([0, 0, 0]);
  }
  return freezeVector3([
    points.reduce((sum, point) => sum + point[0], 0) / points.length,
    points.reduce((sum, point) => sum + point[1], 0) / points.length,
    points.reduce((sum, point) => sum + point[2], 0) / points.length,
  ]);
}

function distance3(a: Vector3, b: Vector3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function normalizeTransform(transform: Transform): Transform {
  return Object.freeze({
    frame_ref: transform.frame_ref,
    position_m: freezeVector3(transform.position_m),
    orientation_xyzw: normalizeQuaternion(transform.orientation_xyzw),
  });
}

function normalizeQuaternion(value: Quaternion): Quaternion {
  const norm = quaternionNorm(value);
  if (norm < EPSILON || !Number.isFinite(norm)) {
    return Object.freeze([0, 0, 0, 1]);
  }
  return Object.freeze([value[0] / norm, value[1] / norm, value[2] / norm, value[3] / norm]) as Quaternion;
}

function conjugateQuaternion(value: Quaternion): Quaternion {
  const n = normalizeQuaternion(value);
  return Object.freeze([-n[0], -n[1], -n[2], n[3]]) as Quaternion;
}

function quaternionNorm(value: Quaternion): number {
  return Math.sqrt(value.reduce((sum, component) => sum + component * component, 0));
}

function clampOptional(value: number, min: number | undefined, max: number | undefined, field: "position", saturated: ("position" | "velocity" | "effort")[]): number {
  if (!Number.isFinite(value)) {
    saturated.push(field);
    return 0;
  }
  let result = value;
  if (min !== undefined && result < min) {
    result = min;
    saturated.push(field);
  }
  if (max !== undefined && result > max) {
    result = max;
    saturated.push(field);
  }
  return round6(result);
}

function clampSymmetric(value: number, maximum: number | undefined, field: "velocity" | "effort", saturated: ("position" | "velocity" | "effort")[]): number {
  if (!Number.isFinite(value)) {
    saturated.push(field);
    return 0;
  }
  if (maximum === undefined) {
    return round6(value);
  }
  const limit = Math.abs(maximum);
  if (Math.abs(value) <= limit) {
    return round6(value);
  }
  saturated.push(field);
  return round6(Math.sign(value) * limit);
}

function summarizeActuatorLimits(limits: ActuatorLimitEnvelope): string {
  const parts = [
    limits.min_position !== undefined || limits.max_position !== undefined ? `position[${limits.min_position ?? "-inf"},${limits.max_position ?? "inf"}]` : undefined,
    limits.max_velocity !== undefined ? `velocity<=${round6(limits.max_velocity)}` : undefined,
    limits.max_effort !== undefined ? `effort<=${round6(limits.max_effort)}` : undefined,
    limits.max_acceleration !== undefined ? `acceleration<=${round6(limits.max_acceleration)}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? "limits undeclared" : parts.join("; ");
}

function summarizeUncertainty(
  cameras: readonly DeclaredCameraCalibration[],
  mounts: readonly DeclaredSensorMountCalibration[],
  microphones: readonly DeclaredMicrophoneGeometryCalibration[],
  imu: readonly DeclaredImuAlignmentCalibration[],
  encoders: readonly DeclaredEncoderOffsetCalibration[],
  actuators: readonly DeclaredActuatorLimitCalibration[],
): string {
  const covarianceTerms = [
    ...cameras.flatMap((entry) => entry.uncertainty_diagonal),
    ...mounts.flatMap((entry) => entry.uncertainty_diagonal),
    ...imu.flatMap((entry) => entry.uncertainty_diagonal),
  ].filter((value) => Number.isFinite(value));
  const maxCovariance = covarianceTerms.length === 0 ? 0 : Math.max(...covarianceTerms);
  return `Declared calibration packet includes ${cameras.length} camera, ${mounts.length} mount, ${microphones.length} microphone, ${imu.length} IMU, ${encoders.length} encoder, and ${actuators.length} actuator-limit records; maximum declared covariance diagonal is ${round6(maxCovariance)}.`;
}

function dedupeIssues(issues: readonly ValidationIssue[]): readonly ValidationIssue[] {
  const byKey = new Map<string, ValidationIssue>();
  for (const issue of issues) {
    byKey.set(`${issue.severity}:${issue.code}:${issue.path}:${issue.message}`, issue);
  }
  return freezeArray([...byKey.values()]);
}

function isCameraSensor(sensor: VirtualSensorDescriptor): sensor is CameraSensorDescriptor {
  return sensor.sensor_class === "rgb_camera" || sensor.sensor_class === "depth_camera" || sensor.sensor_class === "stereo_camera";
}

function isMicrophoneArray(sensor: VirtualSensorDescriptor): sensor is MicrophoneArrayDescriptor {
  return sensor.sensor_class === "microphone_array";
}

function isJointEncoder(sensor: VirtualSensorDescriptor): sensor is JointEncoderDescriptor {
  return sensor.sensor_class === "joint_encoder";
}

function isImuSensor(sensor: VirtualSensorDescriptor): sensor is Extract<VirtualSensorDescriptor, { readonly sensor_class: "imu" }> {
  return sensor.sensor_class === "imu";
}

function isFiniteVector3(value: readonly number[]): value is Vector3 {
  return Array.isArray(value) && value.length === 3 && value.every((component) => Number.isFinite(component));
}

function isFiniteQuaternion(value: readonly number[]): value is Quaternion {
  return Array.isArray(value) && value.length === 4 && value.every((component) => Number.isFinite(component));
}

function validateRef(value: Ref, issues: ValidationIssue[], path: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || /\s/.test(value)) {
    issues.push(makeIssue("error", "CalibrationRefInvalid", path, "Reference must be a non-empty whitespace-free string.", "Use an opaque manifest ref."));
  }
}

function makeIssue(severity: ValidationSeverity, code: CalibrationIssueCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function freezeVector3(value: readonly [number, number, number] | readonly number[]): Vector3 {
  return Object.freeze([value[0], value[1], value[2]]) as Vector3;
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function round6(value: number): number {
  return Math.round(value * 1000000) / 1000000;
}

function round9(value: number): number {
  return Math.round(value * 1000000000) / 1000000000;
}

export const CALIBRATION_REGISTRY_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: VIRTUAL_HARDWARE_MANIFEST_REGISTRY_SCHEMA_VERSION,
  calibration_registry_schema_version: CALIBRATION_REGISTRY_SCHEMA_VERSION,
  blueprint: "architecture_docs/04_VIRTUAL_HARDWARE_SENSOR_ACTUATOR_SPEC.md",
  sections: freezeArray(["4.3", "4.5", "4.6", "4.7", "4.8", "4.12", "4.17", "4.18"]),
});
