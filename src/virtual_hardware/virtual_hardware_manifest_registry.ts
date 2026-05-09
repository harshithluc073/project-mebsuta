/**
 * Virtual hardware manifest registry for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/04_VIRTUAL_HARDWARE_SENSOR_ACTUATOR_SPEC.md`
 * sections 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10, 4.11, 4.14,
 * 4.15, 4.17, and 4.18.
 *
 * The registry is the executable declaration boundary for simulated hardware.
 * A sensor cannot produce packets and an actuator cannot accept commands until
 * it is present in a valid manifest with mounting frames, calibration refs,
 * rate policies, limits, provenance policy, and cognitive visibility policy.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { EmbodimentKind, Ref, Transform, ValidationIssue, ValidationSeverity, Vector3 } from "../simulation/world_manifest";

export const VIRTUAL_HARDWARE_MANIFEST_REGISTRY_SCHEMA_VERSION = "mebsuta.virtual_hardware_manifest_registry.v1" as const;

export type HardwareKind = "sensor" | "actuator";
export type SensorClass =
  | "rgb_camera"
  | "depth_camera"
  | "stereo_camera"
  | "microphone_array"
  | "joint_encoder"
  | "contact_sensor"
  | "imu"
  | "force_torque"
  | "actuator_feedback";
export type CameraRole = "primary_egocentric" | "left_auxiliary" | "right_auxiliary" | "wrist_or_gripper" | "rear_or_body" | "depth";
export type ActuatorClass = "rotary_servo" | "linear_servo" | "gripper" | "speaker" | "tool_interface" | "mobile_base";
export type CognitiveVisibility = "cognitive_allowed" | "declared_calibration_allowed" | "sensor_evidence_only" | "hardware_internal_only" | "qa_only";
export type CognitiveRoute = "prompt_allowed" | "sensor_bus_only" | "qa_only" | "blocked";
export type OverlayPolicy = "none" | "human_operator_only" | "qa_only";
export type HardwareHealthStatus = "healthy" | "degraded" | "missing" | "stale" | "blocked";
export type BearingEstimationMode = "tdoa" | "intensity" | "hybrid" | "event_based";
export type JointMeasurementUnit = "radian" | "meter";
export type ContactMeasurementKind = "boolean" | "force_estimate" | "slip_estimate" | "contact_class_estimate" | "combined";
export type ActuatorCommandSource = "plan_validation_service" | "motion_primitive_executor" | "pd_control_service" | "safety_controller" | "gemini_direct" | "developer_debug";
export type CalibrationKind = "camera_intrinsics" | "sensor_mount_extrinsics" | "microphone_array_geometry" | "encoder_zero_offset" | "imu_alignment" | "actuator_limits";
export type HardwareManifestIssueCode =
  | "SchemaVersionUnsupported"
  | "ManifestIdInvalid"
  | "EmbodimentKindInvalid"
  | "SensorInventoryEmpty"
  | "SensorIdInvalid"
  | "SensorIdDuplicate"
  | "SensorClassUnsupported"
  | "MissingMountFrame"
  | "MissingCalibration"
  | "CameraDescriptorInvalid"
  | "MicrophoneDescriptorInvalid"
  | "EncoderDescriptorInvalid"
  | "ContactDescriptorInvalid"
  | "ImuDescriptorInvalid"
  | "ActuatorInventoryEmpty"
  | "ActuatorIdInvalid"
  | "ActuatorIdDuplicate"
  | "ActuatorClassUnsupported"
  | "ActuatorTargetMissing"
  | "ActuatorLimitInvalid"
  | "CommandSourceForbidden"
  | "RatePolicyInvalid"
  | "InvalidVisibilityPolicy"
  | "QAHardwareCognitiveVisible"
  | "ProvenancePolicyMissing"
  | "DefaultSensorRateInvalid"
  | "HardwareHealthPolicyMissing"
  | "CognitiveVisibilityPolicyMissing"
  | "ReplayPolicyInvalid"
  | "ManifestNotRegistered"
  | "UndeclaredSensor"
  | "UndeclaredActuator";

export interface HardwareRatePolicy {
  readonly nominal_hz: number;
  readonly minimum_hz: number;
  readonly maximum_latency_ms: number;
  readonly stale_after_ms: number;
}

export interface CameraResolution {
  readonly width_px: number;
  readonly height_px: number;
}

export interface FieldOfView {
  readonly horizontal_deg: number;
  readonly vertical_deg: number;
}

export interface CameraIntrinsics {
  readonly fx_px: number;
  readonly fy_px: number;
  readonly cx_px: number;
  readonly cy_px: number;
  readonly distortion_model: "none" | "brown_conrady" | "fisheye";
  readonly distortion_coefficients: readonly number[];
}

export interface MicrophoneChannelGeometry {
  readonly channel_index: number;
  readonly mount_frame_ref: Ref;
  readonly local_position_m: Vector3;
}

export interface ActuatorLimitEnvelope {
  readonly min_position?: number;
  readonly max_position?: number;
  readonly max_velocity?: number;
  readonly max_effort?: number;
  readonly max_acceleration?: number;
}

export interface HardwareDescriptorBase {
  readonly hardware_kind: HardwareKind;
  readonly display_name: string;
  readonly body_ref: Ref;
  readonly mount_frame_ref: Ref;
  readonly mount_transform: Transform;
  readonly calibration_ref: Ref;
  readonly rate_policy: HardwareRatePolicy;
  readonly cognitive_visibility: CognitiveVisibility;
  readonly cognitive_route: CognitiveRoute;
  readonly provenance_policy_ref?: Ref;
  readonly declared_for_cognitive_use: boolean;
}

export interface CameraSensorDescriptor extends HardwareDescriptorBase {
  readonly hardware_kind: "sensor";
  readonly sensor_class: "rgb_camera" | "depth_camera" | "stereo_camera";
  readonly sensor_id: Ref;
  readonly camera_role: CameraRole;
  readonly intrinsics_ref: Ref;
  readonly extrinsics_ref: Ref;
  readonly resolution: CameraResolution;
  readonly field_of_view: FieldOfView;
  readonly supports_depth: boolean;
  readonly overlay_policy: OverlayPolicy;
  readonly noise_profile_ref?: Ref;
}

export interface MicrophoneArrayDescriptor extends HardwareDescriptorBase {
  readonly hardware_kind: "sensor";
  readonly sensor_class: "microphone_array";
  readonly sensor_id: Ref;
  readonly channel_geometry: readonly MicrophoneChannelGeometry[];
  readonly sample_rate_hz: number;
  readonly packet_hz: number;
  readonly bearing_estimation_mode: BearingEstimationMode;
  readonly supports_raw_waveform: boolean;
  readonly self_noise_profile_ref?: Ref;
}

export interface JointEncoderDescriptor extends HardwareDescriptorBase {
  readonly hardware_kind: "sensor";
  readonly sensor_class: "joint_encoder";
  readonly sensor_id: Ref;
  readonly joint_ref: Ref;
  readonly measurement_unit: JointMeasurementUnit;
  readonly zero_offset: number;
  readonly reports_velocity: boolean;
  readonly reports_effort: boolean;
}

export interface ContactSensorDescriptor extends HardwareDescriptorBase {
  readonly hardware_kind: "sensor";
  readonly sensor_class: "contact_sensor" | "force_torque";
  readonly sensor_id: Ref;
  readonly contact_site_ref: Ref;
  readonly measurement_kind: ContactMeasurementKind;
  readonly max_force_n: number;
  readonly noise_profile_ref?: Ref;
}

export interface ImuSensorDescriptor extends HardwareDescriptorBase {
  readonly hardware_kind: "sensor";
  readonly sensor_class: "imu";
  readonly sensor_id: Ref;
  readonly orientation_frame_ref: Ref;
  readonly accelerometer_range_m_per_s2: number;
  readonly gyroscope_range_rad_per_s: number;
  readonly bias_stability_ref?: Ref;
}

export interface ActuatorFeedbackSensorDescriptor extends HardwareDescriptorBase {
  readonly hardware_kind: "sensor";
  readonly sensor_class: "actuator_feedback";
  readonly sensor_id: Ref;
  readonly actuator_ref: Ref;
  readonly feedback_fields: readonly ("applied" | "delayed" | "rejected" | "saturated" | "position" | "velocity" | "effort")[];
}

export type VirtualSensorDescriptor =
  | CameraSensorDescriptor
  | MicrophoneArrayDescriptor
  | JointEncoderDescriptor
  | ContactSensorDescriptor
  | ImuSensorDescriptor
  | ActuatorFeedbackSensorDescriptor;

export interface ActuatorDescriptor {
  readonly hardware_kind: "actuator";
  readonly actuator_id: Ref;
  readonly actuator_class: ActuatorClass;
  readonly display_name: string;
  readonly body_ref: Ref;
  readonly target_ref: Ref;
  readonly command_interfaces: readonly ("position" | "velocity" | "effort" | "grip_width" | "audio_stream" | "tool_state")[];
  readonly limit_envelope: ActuatorLimitEnvelope;
  readonly command_source_policy: readonly Exclude<ActuatorCommandSource, "gemini_direct">[];
  readonly safety_policy_ref: Ref;
  readonly calibration_ref: Ref;
  readonly cognitive_visibility: CognitiveVisibility;
  readonly cognitive_route: CognitiveRoute;
  readonly provenance_policy_ref?: Ref;
}

export interface CalibrationProfile {
  readonly calibration_profile_ref: Ref;
  readonly calibration_kind: CalibrationKind;
  readonly frame_ref: Ref;
  readonly version: string;
  readonly transform?: Transform;
  readonly camera_intrinsics?: CameraIntrinsics;
  readonly microphone_channel_geometry?: readonly MicrophoneChannelGeometry[];
  readonly scalar_offset?: number;
  readonly covariance_diagonal?: readonly number[];
  readonly cognitive_visibility: "declared_calibration_allowed" | "hardware_internal_only" | "qa_only";
  readonly provenance_policy_ref: Ref;
}

export interface VirtualHardwareManifest {
  readonly schema_version: typeof VIRTUAL_HARDWARE_MANIFEST_REGISTRY_SCHEMA_VERSION;
  readonly manifest_id: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly sensor_inventory: readonly VirtualSensorDescriptor[];
  readonly actuator_inventory: readonly ActuatorDescriptor[];
  readonly calibration_profile_refs: readonly Ref[];
  readonly calibration_profiles: readonly CalibrationProfile[];
  readonly default_sensor_rates: Readonly<Partial<Record<SensorClass, HardwareRatePolicy>>>;
  readonly hardware_health_policy_ref: Ref;
  readonly cognitive_visibility_policy_ref: Ref;
  readonly replay_policy_ref?: Ref;
  readonly manifest_visibility: "hardware_registry_internal";
}

export interface HardwareManifestValidationReport {
  readonly ok: boolean;
  readonly issue_count: number;
  readonly error_count: number;
  readonly warning_count: number;
  readonly accepted_sensor_count: number;
  readonly accepted_actuator_count: number;
  readonly missing_calibration_refs: readonly Ref[];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface HardwareManifestRegistrationReport extends HardwareManifestValidationReport {
  readonly manifest_id: Ref;
  readonly registration_status: "accepted" | "rejected";
  readonly accepted_sensor_ids: readonly Ref[];
  readonly accepted_actuator_ids: readonly Ref[];
  readonly rejected_hardware_ids: readonly Ref[];
}

export interface CognitiveSafeHardwareSummary {
  readonly schema_version: typeof VIRTUAL_HARDWARE_MANIFEST_REGISTRY_SCHEMA_VERSION;
  readonly manifest_id: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly sensor_summary: readonly {
    readonly sensor_id: Ref;
    readonly sensor_class: SensorClass;
    readonly display_name: string;
    readonly cognitive_route: CognitiveRoute;
    readonly health_status: HardwareHealthStatus;
  }[];
  readonly actuator_summary: readonly {
    readonly actuator_id: Ref;
    readonly actuator_class: ActuatorClass;
    readonly display_name: string;
    readonly cognitive_route: CognitiveRoute;
  }[];
  readonly calibration_refs_allowed: readonly Ref[];
  readonly hidden_fields_removed: readonly string[];
}

export class VirtualHardwareManifestRegistryError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "VirtualHardwareManifestRegistryError";
    this.issues = issues;
  }
}

/**
 * Stores validated hardware manifests and exposes declaration assertions used by
 * packet producers, sensor buses, and actuator command boundaries.
 */
export class VirtualHardwareManifestRegistry {
  private readonly manifests = new Map<Ref, VirtualHardwareManifest>();
  private readonly reports = new Map<Ref, HardwareManifestRegistrationReport>();

  public registerManifest(manifest: VirtualHardwareManifest): HardwareManifestRegistrationReport {
    const report = validateVirtualHardwareManifest(manifest);
    const rejectedIds = collectRejectedHardwareIds(manifest, report.issues);
    const registrationReport: HardwareManifestRegistrationReport = Object.freeze({
      ...report,
      manifest_id: manifest.manifest_id,
      registration_status: report.ok ? "accepted" : "rejected",
      accepted_sensor_ids: report.ok ? freezeArray(manifest.sensor_inventory.map((sensor) => sensor.sensor_id)) : freezeArray([]),
      accepted_actuator_ids: report.ok ? freezeArray(manifest.actuator_inventory.map((actuator) => actuator.actuator_id)) : freezeArray([]),
      rejected_hardware_ids: rejectedIds,
    });
    this.reports.set(manifest.manifest_id, registrationReport);
    if (!report.ok) {
      return registrationReport;
    }
    this.manifests.set(manifest.manifest_id, deepFreezeManifest(manifest));
    return registrationReport;
  }

  public requireManifest(manifestId: Ref): VirtualHardwareManifest {
    const manifest = this.manifests.get(manifestId);
    if (manifest === undefined) {
      throw new VirtualHardwareManifestRegistryError("Hardware manifest is not registered.", [
        makeIssue("error", "ManifestNotRegistered", "$.manifest_id", `Manifest ${manifestId} has not been accepted by the registry.`, "Register and validate the manifest before using hardware channels."),
      ]);
    }
    return manifest;
  }

  public hasManifest(manifestId: Ref): boolean {
    return this.manifests.has(manifestId);
  }

  public listManifestIds(): readonly Ref[] {
    return freezeArray([...this.manifests.keys()].sort());
  }

  public getLastRegistrationReport(manifestId: Ref): HardwareManifestRegistrationReport | undefined {
    return this.reports.get(manifestId);
  }

  public assertSensorDeclared(manifestId: Ref, sensorId: Ref, expectedClass?: SensorClass): VirtualSensorDescriptor {
    const manifest = this.requireManifest(manifestId);
    const sensor = manifest.sensor_inventory.find((entry) => entry.sensor_id === sensorId);
    if (sensor === undefined || (expectedClass !== undefined && sensor.sensor_class !== expectedClass)) {
      throw new VirtualHardwareManifestRegistryError("Sensor channel is not declared in the hardware manifest.", [
        makeIssue("error", "UndeclaredSensor", "$.sensor_id", `Sensor ${sensorId} is not declared for manifest ${manifestId}.`, "Declare the sensor and calibration before producing packets."),
      ]);
    }
    return sensor;
  }

  public assertActuatorDeclared(manifestId: Ref, actuatorId: Ref, commandSource: ActuatorCommandSource = "pd_control_service"): ActuatorDescriptor {
    const manifest = this.requireManifest(manifestId);
    const actuator = manifest.actuator_inventory.find((entry) => entry.actuator_id === actuatorId);
    if (actuator === undefined) {
      throw new VirtualHardwareManifestRegistryError("Actuator channel is not declared in the hardware manifest.", [
        makeIssue("error", "UndeclaredActuator", "$.actuator_id", `Actuator ${actuatorId} is not declared for manifest ${manifestId}.`, "Declare the actuator and limits before applying commands."),
      ]);
    }
    if (commandSource === "gemini_direct" || !actuator.command_source_policy.includes(commandSource)) {
      throw new VirtualHardwareManifestRegistryError("Actuator command source is forbidden by hardware policy.", [
        makeIssue("error", "CommandSourceForbidden", "$.command_source", `Command source ${commandSource} is not approved for actuator ${actuatorId}.`, "Route commands through validation, motion primitive execution, PD control, or the safety controller."),
      ]);
    }
    return actuator;
  }

  public resolveCalibration(manifestId: Ref, calibrationRef: Ref): CalibrationProfile {
    const manifest = this.requireManifest(manifestId);
    const profile = manifest.calibration_profiles.find((entry) => entry.calibration_profile_ref === calibrationRef);
    if (profile === undefined) {
      throw new VirtualHardwareManifestRegistryError("Calibration profile is not declared in the hardware manifest.", [
        makeIssue("error", "MissingCalibration", "$.calibration_profile_ref", `Calibration ${calibrationRef} is not present in manifest ${manifestId}.`, "Attach the calibration profile before exposing the hardware channel."),
      ]);
    }
    return profile;
  }

  public listSensors(manifestId: Ref, sensorClass?: SensorClass): readonly VirtualSensorDescriptor[] {
    const sensors = this.requireManifest(manifestId).sensor_inventory.filter((sensor) => sensorClass === undefined || sensor.sensor_class === sensorClass);
    return freezeArray(sensors);
  }

  public listActuators(manifestId: Ref, actuatorClass?: ActuatorClass): readonly ActuatorDescriptor[] {
    const actuators = this.requireManifest(manifestId).actuator_inventory.filter((actuator) => actuatorClass === undefined || actuator.actuator_class === actuatorClass);
    return freezeArray(actuators);
  }

  public buildCognitiveHardwareSummary(manifestId: Ref): CognitiveSafeHardwareSummary {
    const manifest = this.requireManifest(manifestId);
    const sensorSummary = manifest.sensor_inventory
      .filter((sensor) => sensor.cognitive_route === "prompt_allowed" || sensor.cognitive_route === "sensor_bus_only")
      .map((sensor) => Object.freeze({
        sensor_id: sensor.sensor_id,
        sensor_class: sensor.sensor_class,
        display_name: sensor.display_name,
        cognitive_route: sensor.cognitive_route,
        health_status: "healthy" as const,
      }));
    const actuatorSummary = manifest.actuator_inventory
      .filter((actuator) => actuator.cognitive_visibility !== "hardware_internal_only" && actuator.cognitive_visibility !== "qa_only")
      .map((actuator) => Object.freeze({
        actuator_id: actuator.actuator_id,
        actuator_class: actuator.actuator_class,
        display_name: actuator.display_name,
        cognitive_route: actuator.cognitive_route,
      }));
    const calibrationRefsAllowed = manifest.calibration_profiles
      .filter((profile) => profile.cognitive_visibility === "declared_calibration_allowed")
      .map((profile) => profile.calibration_profile_ref)
      .sort();
    return Object.freeze({
      schema_version: VIRTUAL_HARDWARE_MANIFEST_REGISTRY_SCHEMA_VERSION,
      manifest_id: manifest.manifest_id,
      embodiment_kind: manifest.embodiment_kind,
      sensor_summary: freezeArray(sensorSummary),
      actuator_summary: freezeArray(actuatorSummary),
      calibration_refs_allowed: freezeArray(calibrationRefsAllowed),
      hidden_fields_removed: freezeArray([
        "body_ref",
        "mount_transform",
        "hardware_health_policy_ref",
        "cognitive_visibility_policy_ref",
        "replay_policy_ref",
        "safety_policy_ref",
        "determinism_hash",
        "backend_object_refs",
        "qa_truth_refs",
      ]),
    });
  }
}

export function createVirtualHardwareManifest(
  input: Omit<VirtualHardwareManifest, "schema_version" | "manifest_visibility"> & {
    readonly schema_version?: typeof VIRTUAL_HARDWARE_MANIFEST_REGISTRY_SCHEMA_VERSION;
    readonly manifest_visibility?: "hardware_registry_internal";
  },
): VirtualHardwareManifest {
  const manifest: VirtualHardwareManifest = Object.freeze({
    ...input,
    schema_version: input.schema_version ?? VIRTUAL_HARDWARE_MANIFEST_REGISTRY_SCHEMA_VERSION,
    manifest_visibility: input.manifest_visibility ?? "hardware_registry_internal",
  });
  assertValidVirtualHardwareManifest(manifest);
  return manifest;
}

export function registerVirtualHardwareManifest(manifest: VirtualHardwareManifest, registry = new VirtualHardwareManifestRegistry()): HardwareManifestRegistrationReport {
  return registry.registerManifest(manifest);
}

export function validateVirtualHardwareManifest(manifest: VirtualHardwareManifest): HardwareManifestValidationReport {
  const issues: ValidationIssue[] = [];
  validateManifestShell(manifest, issues);
  const calibrationRefs = validateCalibrationProfiles(manifest, issues);
  const actuatorIds = validateActuators(manifest.actuator_inventory, calibrationRefs, issues);
  const sensorIds = validateSensors(manifest.sensor_inventory, calibrationRefs, actuatorIds, issues);
  validateDefaultSensorRates(manifest.default_sensor_rates, issues);
  const missingCalibrationRefs = collectMissingCalibrationRefs(manifest, calibrationRefs);
  for (const ref of missingCalibrationRefs) {
    issues.push(makeIssue("error", "MissingCalibration", "$.calibration_profile_refs", `Calibration ${ref} is referenced by hardware but not declared.`, "Add a matching calibration profile."));
  }
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.length - errorCount;
  return Object.freeze({
    ok: errorCount === 0,
    issue_count: issues.length,
    error_count: errorCount,
    warning_count: warningCount,
    accepted_sensor_count: errorCount === 0 ? sensorIds.size : 0,
    accepted_actuator_count: errorCount === 0 ? actuatorIds.size : 0,
    missing_calibration_refs: freezeArray(missingCalibrationRefs),
    issues: freezeArray(issues),
    determinism_hash: computeDeterminismHash({ manifest, issues }),
  });
}

export function assertValidVirtualHardwareManifest(manifest: VirtualHardwareManifest): void {
  const report = validateVirtualHardwareManifest(manifest);
  if (!report.ok) {
    throw new VirtualHardwareManifestRegistryError("Virtual hardware manifest failed validation.", report.issues);
  }
}

function validateManifestShell(manifest: VirtualHardwareManifest, issues: ValidationIssue[]): void {
  if (manifest.schema_version !== VIRTUAL_HARDWARE_MANIFEST_REGISTRY_SCHEMA_VERSION) {
    issues.push(makeIssue("error", "SchemaVersionUnsupported", "$.schema_version", `Expected ${VIRTUAL_HARDWARE_MANIFEST_REGISTRY_SCHEMA_VERSION}.`, "Regenerate or migrate the virtual hardware manifest."));
  }
  validateRef(manifest.manifest_id, issues, "$.manifest_id", "ManifestIdInvalid");
  if (!["quadruped", "humanoid"].includes(manifest.embodiment_kind)) {
    issues.push(makeIssue("error", "EmbodimentKindInvalid", "$.embodiment_kind", "Embodiment kind must be quadruped or humanoid.", "Use the embodiment kind from the active body manifest."));
  }
  if (!Array.isArray(manifest.sensor_inventory) || manifest.sensor_inventory.length === 0) {
    issues.push(makeIssue("error", "SensorInventoryEmpty", "$.sensor_inventory", "At least one declared sensor is required.", "Declare the embodied sensor suite before runtime."));
  }
  if (!Array.isArray(manifest.actuator_inventory) || manifest.actuator_inventory.length === 0) {
    issues.push(makeIssue("error", "ActuatorInventoryEmpty", "$.actuator_inventory", "At least one declared actuator is required.", "Declare the embodied actuator suite before runtime."));
  }
  validateRefArray(manifest.calibration_profile_refs, issues, "$.calibration_profile_refs", "MissingCalibration");
  validateRef(manifest.hardware_health_policy_ref, issues, "$.hardware_health_policy_ref", "HardwareHealthPolicyMissing");
  validateRef(manifest.cognitive_visibility_policy_ref, issues, "$.cognitive_visibility_policy_ref", "CognitiveVisibilityPolicyMissing");
  if (manifest.replay_policy_ref !== undefined) {
    validateRef(manifest.replay_policy_ref, issues, "$.replay_policy_ref", "ReplayPolicyInvalid");
  }
  if (manifest.manifest_visibility !== "hardware_registry_internal") {
    issues.push(makeIssue("error", "InvalidVisibilityPolicy", "$.manifest_visibility", "Hardware manifests are runtime registry records, not direct cognitive input.", "Set manifest_visibility to hardware_registry_internal."));
  }
}

function validateCalibrationProfiles(manifest: VirtualHardwareManifest, issues: ValidationIssue[]): ReadonlySet<Ref> {
  const profileRefs = new Set<Ref>();
  const manifestRefs = new Set(manifest.calibration_profile_refs);
  for (let index = 0; index < manifest.calibration_profiles.length; index += 1) {
    const profile = manifest.calibration_profiles[index];
    const path = `$.calibration_profiles[${index}]`;
    validateRef(profile.calibration_profile_ref, issues, `${path}.calibration_profile_ref`, "MissingCalibration");
    validateRef(profile.frame_ref, issues, `${path}.frame_ref`, "MissingMountFrame");
    validateRef(profile.version, issues, `${path}.version`, "MissingCalibration");
    validateRef(profile.provenance_policy_ref, issues, `${path}.provenance_policy_ref`, "ProvenancePolicyMissing");
    if (profileRefs.has(profile.calibration_profile_ref)) {
      issues.push(makeIssue("error", "MissingCalibration", `${path}.calibration_profile_ref`, "Calibration profile refs must be unique.", "Rename one calibration profile ref."));
    }
    profileRefs.add(profile.calibration_profile_ref);
    if (!manifestRefs.has(profile.calibration_profile_ref)) {
      issues.push(makeIssue("warning", "MissingCalibration", `${path}.calibration_profile_ref`, "Calibration profile is present but not listed in calibration_profile_refs.", "Add the profile ref to the manifest closure list."));
    }
    if (!["camera_intrinsics", "sensor_mount_extrinsics", "microphone_array_geometry", "encoder_zero_offset", "imu_alignment", "actuator_limits"].includes(profile.calibration_kind)) {
      issues.push(makeIssue("error", "MissingCalibration", `${path}.calibration_kind`, "Calibration kind is unsupported.", "Use a declared calibration kind from the hardware specification."));
    }
    if (profile.cognitive_visibility === "qa_only" && profile.provenance_policy_ref.length > 0) {
      issues.push(makeIssue("warning", "QAHardwareCognitiveVisible", `${path}.cognitive_visibility`, "QA-only calibration must remain outside prompt routes.", "Keep QA-only calibration out of cognitive summaries."));
    }
    if (profile.transform !== undefined) {
      validateTransform(profile.transform, issues, `${path}.transform`);
    }
    if (profile.camera_intrinsics !== undefined) {
      validateCameraIntrinsics(profile.camera_intrinsics, issues, `${path}.camera_intrinsics`);
    }
    if (profile.microphone_channel_geometry !== undefined) {
      validateMicrophoneGeometry(profile.microphone_channel_geometry, issues, `${path}.microphone_channel_geometry`);
    }
    if (profile.covariance_diagonal !== undefined && profile.covariance_diagonal.some((value) => !Number.isFinite(value) || value < 0)) {
      issues.push(makeIssue("error", "MissingCalibration", `${path}.covariance_diagonal`, "Calibration covariance must contain finite nonnegative values.", "Use calibrated covariance diagonal terms."));
    }
  }
  for (const ref of manifest.calibration_profile_refs) {
    if (!profileRefs.has(ref)) {
      issues.push(makeIssue("error", "MissingCalibration", "$.calibration_profile_refs", `Calibration profile ${ref} is listed but not supplied.`, "Supply the calibration profile record."));
    }
  }
  return profileRefs;
}

function validateSensors(
  sensors: readonly VirtualSensorDescriptor[],
  calibrationRefs: ReadonlySet<Ref>,
  actuatorIds: ReadonlySet<Ref>,
  issues: ValidationIssue[],
): ReadonlySet<Ref> {
  const sensorIds = new Set<Ref>();
  for (let index = 0; index < sensors.length; index += 1) {
    const sensor = sensors[index];
    const path = `$.sensor_inventory[${index}]`;
    validateSensorBase(sensor, calibrationRefs, issues, path);
    if (sensorIds.has(sensor.sensor_id)) {
      issues.push(makeIssue("error", "SensorIdDuplicate", `${path}.sensor_id`, "Every sensor must have a unique sensor ID.", "Rename one sensor ID."));
    }
    sensorIds.add(sensor.sensor_id);
    if (isCameraSensor(sensor)) {
      validateCameraSensor(sensor, issues, path);
    } else if (sensor.sensor_class === "microphone_array") {
      validateMicrophoneSensor(sensor, issues, path);
    } else if (sensor.sensor_class === "joint_encoder") {
      validateJointEncoderSensor(sensor, issues, path);
    } else if (sensor.sensor_class === "contact_sensor" || sensor.sensor_class === "force_torque") {
      validateContactSensor(sensor, issues, path);
    } else if (sensor.sensor_class === "imu") {
      validateImuSensor(sensor, issues, path);
    } else if (sensor.sensor_class === "actuator_feedback") {
      validateActuatorFeedbackSensor(sensor, actuatorIds, issues, path);
    } else {
      issues.push(makeIssue("error", "SensorClassUnsupported", `${path}.sensor_class`, "Sensor class is not supported by the virtual hardware registry.", "Use a sensor class declared by architecture file 04."));
    }
  }
  return sensorIds;
}

function validateSensorBase(sensor: VirtualSensorDescriptor, calibrationRefs: ReadonlySet<Ref>, issues: ValidationIssue[], path: string): void {
  if (sensor.hardware_kind !== "sensor") {
    issues.push(makeIssue("error", "SensorClassUnsupported", `${path}.hardware_kind`, "Sensor descriptors must use hardware_kind sensor.", "Correct the descriptor kind."));
  }
  validateRef(sensor.sensor_id, issues, `${path}.sensor_id`, "SensorIdInvalid");
  validateRef(sensor.display_name, issues, `${path}.display_name`, "SensorIdInvalid");
  validateRef(sensor.body_ref, issues, `${path}.body_ref`, "MissingMountFrame");
  validateRef(sensor.mount_frame_ref, issues, `${path}.mount_frame_ref`, "MissingMountFrame");
  validateTransform(sensor.mount_transform, issues, `${path}.mount_transform`);
  validateRef(sensor.calibration_ref, issues, `${path}.calibration_ref`, "MissingCalibration");
  validateRatePolicy(sensor.rate_policy, issues, `${path}.rate_policy`);
  validateVisibility(sensor.cognitive_visibility, sensor.cognitive_route, sensor.declared_for_cognitive_use, sensor.provenance_policy_ref, issues, path);
  if (!calibrationRefs.has(sensor.calibration_ref)) {
    issues.push(makeIssue("error", "MissingCalibration", `${path}.calibration_ref`, `Sensor ${sensor.sensor_id} references missing calibration ${sensor.calibration_ref}.`, "Add the calibration profile to the manifest."));
  }
}

function validateCameraSensor(sensor: CameraSensorDescriptor, issues: ValidationIssue[], path: string): void {
  validateRef(sensor.intrinsics_ref, issues, `${path}.intrinsics_ref`, "CameraDescriptorInvalid");
  validateRef(sensor.extrinsics_ref, issues, `${path}.extrinsics_ref`, "CameraDescriptorInvalid");
  validateResolution(sensor.resolution, issues, `${path}.resolution`);
  validateFieldOfView(sensor.field_of_view, issues, `${path}.field_of_view`);
  if (!["primary_egocentric", "left_auxiliary", "right_auxiliary", "wrist_or_gripper", "rear_or_body", "depth"].includes(sensor.camera_role)) {
    issues.push(makeIssue("error", "CameraDescriptorInvalid", `${path}.camera_role`, "Camera role is unsupported.", "Use a camera role declared by the architecture."));
  }
  if (sensor.sensor_class === "depth_camera" && !sensor.supports_depth) {
    issues.push(makeIssue("error", "CameraDescriptorInvalid", `${path}.supports_depth`, "Depth camera descriptors must support depth output.", "Set supports_depth to true or use an RGB camera class."));
  }
  if (sensor.overlay_policy !== "none" && sensor.declared_for_cognitive_use) {
    issues.push(makeIssue("error", "InvalidVisibilityPolicy", `${path}.overlay_policy`, "Cognitive camera frames cannot carry human or QA overlays.", "Set overlay_policy to none for cognitive-bound cameras."));
  }
}

function validateMicrophoneSensor(sensor: MicrophoneArrayDescriptor, issues: ValidationIssue[], path: string): void {
  validateMicrophoneGeometry(sensor.channel_geometry, issues, `${path}.channel_geometry`);
  if (sensor.channel_geometry.length < 2) {
    issues.push(makeIssue("error", "MicrophoneDescriptorInvalid", `${path}.channel_geometry`, "Microphone arrays require at least two spatially separated channels.", "Declare two or more channel geometries."));
  }
  validatePositive(sensor.sample_rate_hz, issues, `${path}.sample_rate_hz`, "MicrophoneDescriptorInvalid");
  validatePositive(sensor.packet_hz, issues, `${path}.packet_hz`, "MicrophoneDescriptorInvalid");
  if (!["tdoa", "intensity", "hybrid", "event_based"].includes(sensor.bearing_estimation_mode)) {
    issues.push(makeIssue("error", "MicrophoneDescriptorInvalid", `${path}.bearing_estimation_mode`, "Bearing estimation mode is unsupported.", "Use tdoa, intensity, hybrid, or event_based."));
  }
}

function validateJointEncoderSensor(sensor: JointEncoderDescriptor, issues: ValidationIssue[], path: string): void {
  validateRef(sensor.joint_ref, issues, `${path}.joint_ref`, "EncoderDescriptorInvalid");
  if (!["radian", "meter"].includes(sensor.measurement_unit)) {
    issues.push(makeIssue("error", "EncoderDescriptorInvalid", `${path}.measurement_unit`, "Joint encoder unit must be radian or meter.", "Match the joint type with the correct unit."));
  }
  if (!Number.isFinite(sensor.zero_offset)) {
    issues.push(makeIssue("error", "EncoderDescriptorInvalid", `${path}.zero_offset`, "Encoder zero offset must be finite.", "Provide the calibrated zero offset."));
  }
}

function validateContactSensor(sensor: ContactSensorDescriptor, issues: ValidationIssue[], path: string): void {
  validateRef(sensor.contact_site_ref, issues, `${path}.contact_site_ref`, "ContactDescriptorInvalid");
  validatePositive(sensor.max_force_n, issues, `${path}.max_force_n`, "ContactDescriptorInvalid");
  if (!["boolean", "force_estimate", "slip_estimate", "contact_class_estimate", "combined"].includes(sensor.measurement_kind)) {
    issues.push(makeIssue("error", "ContactDescriptorInvalid", `${path}.measurement_kind`, "Contact measurement kind is unsupported.", "Use a declared tactile measurement kind."));
  }
}

function validateImuSensor(sensor: ImuSensorDescriptor, issues: ValidationIssue[], path: string): void {
  validateRef(sensor.orientation_frame_ref, issues, `${path}.orientation_frame_ref`, "ImuDescriptorInvalid");
  validatePositive(sensor.accelerometer_range_m_per_s2, issues, `${path}.accelerometer_range_m_per_s2`, "ImuDescriptorInvalid");
  validatePositive(sensor.gyroscope_range_rad_per_s, issues, `${path}.gyroscope_range_rad_per_s`, "ImuDescriptorInvalid");
}

function validateActuatorFeedbackSensor(
  sensor: ActuatorFeedbackSensorDescriptor,
  actuatorIds: ReadonlySet<Ref>,
  issues: ValidationIssue[],
  path: string,
): void {
  validateRef(sensor.actuator_ref, issues, `${path}.actuator_ref`, "ActuatorTargetMissing");
  if (!actuatorIds.has(sensor.actuator_ref)) {
    issues.push(makeIssue("error", "ActuatorTargetMissing", `${path}.actuator_ref`, `Feedback sensor references undeclared actuator ${sensor.actuator_ref}.`, "Declare the actuator before feedback telemetry."));
  }
  if (sensor.feedback_fields.length === 0) {
    issues.push(makeIssue("error", "SensorClassUnsupported", `${path}.feedback_fields`, "Actuator feedback sensors must declare at least one feedback field.", "Declare applied, delayed, rejected, saturated, position, velocity, or effort."));
  }
}

function validateActuators(actuators: readonly ActuatorDescriptor[], calibrationRefs: ReadonlySet<Ref>, issues: ValidationIssue[]): ReadonlySet<Ref> {
  const actuatorIds = new Set<Ref>();
  for (let index = 0; index < actuators.length; index += 1) {
    const actuator = actuators[index];
    const path = `$.actuator_inventory[${index}]`;
    if (actuator.hardware_kind !== "actuator") {
      issues.push(makeIssue("error", "ActuatorClassUnsupported", `${path}.hardware_kind`, "Actuator descriptors must use hardware_kind actuator.", "Correct the descriptor kind."));
    }
    validateRef(actuator.actuator_id, issues, `${path}.actuator_id`, "ActuatorIdInvalid");
    validateRef(actuator.display_name, issues, `${path}.display_name`, "ActuatorIdInvalid");
    validateRef(actuator.body_ref, issues, `${path}.body_ref`, "ActuatorTargetMissing");
    validateRef(actuator.target_ref, issues, `${path}.target_ref`, "ActuatorTargetMissing");
    validateRef(actuator.safety_policy_ref, issues, `${path}.safety_policy_ref`, "InvalidVisibilityPolicy");
    validateRef(actuator.calibration_ref, issues, `${path}.calibration_ref`, "MissingCalibration");
    if (!calibrationRefs.has(actuator.calibration_ref)) {
      issues.push(makeIssue("error", "MissingCalibration", `${path}.calibration_ref`, `Actuator ${actuator.actuator_id} references missing calibration ${actuator.calibration_ref}.`, "Add the actuator calibration profile."));
    }
    if (actuatorIds.has(actuator.actuator_id)) {
      issues.push(makeIssue("error", "ActuatorIdDuplicate", `${path}.actuator_id`, "Every actuator must have a unique actuator ID.", "Rename one actuator ID."));
    }
    actuatorIds.add(actuator.actuator_id);
    if (!["rotary_servo", "linear_servo", "gripper", "speaker", "tool_interface", "mobile_base"].includes(actuator.actuator_class)) {
      issues.push(makeIssue("error", "ActuatorClassUnsupported", `${path}.actuator_class`, "Actuator class is unsupported.", "Use a declared actuator class."));
    }
    validateActuatorLimits(actuator.limit_envelope, issues, `${path}.limit_envelope`);
    validateCommandSourcePolicy(actuator.command_source_policy, issues, `${path}.command_source_policy`);
    if (actuator.command_interfaces.length === 0) {
      issues.push(makeIssue("error", "ActuatorClassUnsupported", `${path}.command_interfaces`, "Actuators must declare one or more command interfaces.", "Declare position, velocity, effort, grip_width, audio_stream, or tool_state."));
    }
    validateActuatorVisibility(actuator, issues, path);
  }
  return actuatorIds;
}

function validateActuatorLimits(limits: ActuatorLimitEnvelope, issues: ValidationIssue[], path: string): void {
  const finiteValues = [
    limits.min_position,
    limits.max_position,
    limits.max_velocity,
    limits.max_effort,
    limits.max_acceleration,
  ].filter((value): value is number => value !== undefined);
  if (finiteValues.length === 0) {
    issues.push(makeIssue("error", "ActuatorLimitInvalid", path, "Every actuator must declare at least one physical limit.", "Add position, velocity, effort, or acceleration limits."));
  }
  for (const value of finiteValues) {
    if (!Number.isFinite(value)) {
      issues.push(makeIssue("error", "ActuatorLimitInvalid", path, "Actuator limits must be finite.", "Replace NaN or infinite actuator limits."));
    }
  }
  if (limits.min_position !== undefined && limits.max_position !== undefined && limits.min_position >= limits.max_position) {
    issues.push(makeIssue("error", "ActuatorLimitInvalid", path, "Actuator min_position must be below max_position.", "Correct the actuator range."));
  }
  for (const [field, value] of [
    ["max_velocity", limits.max_velocity],
    ["max_effort", limits.max_effort],
    ["max_acceleration", limits.max_acceleration],
  ] as const) {
    if (value !== undefined && value <= 0) {
      issues.push(makeIssue("error", "ActuatorLimitInvalid", `${path}.${field}`, "Actuator maximum limits must be positive.", "Use a positive calibrated maximum."));
    }
  }
}

function validateCommandSourcePolicy(
  sources: readonly ActuatorCommandSource[],
  issues: ValidationIssue[],
  path: string,
): void {
  if (sources.length === 0) {
    issues.push(makeIssue("error", "CommandSourceForbidden", path, "Actuators must declare approved deterministic command sources.", "Allow validated control-stack sources only."));
  }
  for (const source of sources) {
    if (source === "gemini_direct" || !["plan_validation_service", "motion_primitive_executor", "pd_control_service", "safety_controller", "developer_debug"].includes(source)) {
      issues.push(makeIssue("error", "CommandSourceForbidden", path, "Gemini direct or unknown command sources are forbidden.", "Route commands through validation and deterministic control services."));
    }
  }
}

function validateActuatorVisibility(actuator: ActuatorDescriptor, issues: ValidationIssue[], path: string): void {
  if ((actuator.cognitive_visibility === "cognitive_allowed" || actuator.cognitive_visibility === "sensor_evidence_only") && actuator.provenance_policy_ref === undefined) {
    issues.push(makeIssue("error", "ProvenancePolicyMissing", `${path}.provenance_policy_ref`, "Cognitive-visible actuator summaries require provenance policy.", "Attach a provenance policy ref."));
  }
  if (actuator.cognitive_visibility === "qa_only" && actuator.cognitive_route !== "qa_only") {
    issues.push(makeIssue("error", "QAHardwareCognitiveVisible", `${path}.cognitive_route`, "QA-only actuators cannot use prompt or sensor bus routes.", "Set cognitive_route to qa_only."));
  }
}

function validateDefaultSensorRates(rates: Readonly<Partial<Record<SensorClass, HardwareRatePolicy>>>, issues: ValidationIssue[]): void {
  for (const [sensorClass, policy] of Object.entries(rates) as readonly [SensorClass, HardwareRatePolicy | undefined][]) {
    if (policy === undefined) {
      continue;
    }
    if (!isSensorClass(sensorClass)) {
      issues.push(makeIssue("error", "DefaultSensorRateInvalid", "$.default_sensor_rates", "Default sensor rate key is not a supported sensor class.", "Use a declared sensor class key."));
    }
    validateRatePolicy(policy, issues, `$.default_sensor_rates.${sensorClass}`);
  }
}

function validateVisibility(
  visibility: CognitiveVisibility,
  route: CognitiveRoute,
  declaredForCognitiveUse: boolean,
  provenancePolicyRef: Ref | undefined,
  issues: ValidationIssue[],
  path: string,
): void {
  if (!["cognitive_allowed", "declared_calibration_allowed", "sensor_evidence_only", "hardware_internal_only", "qa_only"].includes(visibility)) {
    issues.push(makeIssue("error", "InvalidVisibilityPolicy", `${path}.cognitive_visibility`, "Cognitive visibility is unsupported.", "Use a declared hardware visibility value."));
  }
  if (!["prompt_allowed", "sensor_bus_only", "qa_only", "blocked"].includes(route)) {
    issues.push(makeIssue("error", "InvalidVisibilityPolicy", `${path}.cognitive_route`, "Cognitive route is unsupported.", "Use prompt_allowed, sensor_bus_only, qa_only, or blocked."));
  }
  if (visibility === "qa_only" && (declaredForCognitiveUse || route !== "qa_only")) {
    issues.push(makeIssue("error", "QAHardwareCognitiveVisible", path, "QA-only hardware cannot be marked cognitive-visible.", "Keep QA-only channels off prompt and sensor bus routes."));
  }
  if (visibility === "hardware_internal_only" && (declaredForCognitiveUse || route === "prompt_allowed")) {
    issues.push(makeIssue("error", "InvalidVisibilityPolicy", path, "Hardware-internal channels cannot be prompt-visible.", "Route internal channels to blocked or internal-only processing."));
  }
  if ((declaredForCognitiveUse || route === "prompt_allowed" || visibility === "cognitive_allowed" || visibility === "sensor_evidence_only") && provenancePolicyRef === undefined) {
    issues.push(makeIssue("error", "ProvenancePolicyMissing", `${path}.provenance_policy_ref`, "Every cognitive-visible hardware field requires provenance policy.", "Attach the policy used by the sensor firewall."));
  }
}

function collectMissingCalibrationRefs(manifest: VirtualHardwareManifest, calibrationRefs: ReadonlySet<Ref>): readonly Ref[] {
  const referenced = new Set<Ref>();
  for (const sensor of manifest.sensor_inventory) {
    referenced.add(sensor.calibration_ref);
    if (isCameraSensor(sensor)) {
      referenced.add(sensor.intrinsics_ref);
      referenced.add(sensor.extrinsics_ref);
    }
  }
  for (const actuator of manifest.actuator_inventory) {
    referenced.add(actuator.calibration_ref);
  }
  return freezeArray([...referenced].filter((ref) => !calibrationRefs.has(ref)).sort());
}

function collectRejectedHardwareIds(manifest: VirtualHardwareManifest, issues: readonly ValidationIssue[]): readonly Ref[] {
  if (issues.length === 0) {
    return freezeArray([]);
  }
  const rejected = new Set<Ref>();
  for (const issue of issues) {
    const sensorMatch = /^\$\.sensor_inventory\[(\d+)\]/.exec(issue.path);
    if (sensorMatch !== null) {
      const sensor = manifest.sensor_inventory[Number(sensorMatch[1])];
      rejected.add(sensor?.sensor_id ?? `sensor_index_${sensorMatch[1]}`);
    }
    const actuatorMatch = /^\$\.actuator_inventory\[(\d+)\]/.exec(issue.path);
    if (actuatorMatch !== null) {
      const actuator = manifest.actuator_inventory[Number(actuatorMatch[1])];
      rejected.add(actuator?.actuator_id ?? `actuator_index_${actuatorMatch[1]}`);
    }
  }
  return freezeArray([...rejected].sort());
}

function validateRatePolicy(policy: HardwareRatePolicy, issues: ValidationIssue[], path: string): void {
  validatePositive(policy.nominal_hz, issues, `${path}.nominal_hz`, "RatePolicyInvalid");
  validatePositive(policy.minimum_hz, issues, `${path}.minimum_hz`, "RatePolicyInvalid");
  validatePositive(policy.maximum_latency_ms, issues, `${path}.maximum_latency_ms`, "RatePolicyInvalid");
  validatePositive(policy.stale_after_ms, issues, `${path}.stale_after_ms`, "RatePolicyInvalid");
  if (policy.minimum_hz > policy.nominal_hz) {
    issues.push(makeIssue("error", "RatePolicyInvalid", path, "Minimum sensor rate cannot exceed nominal rate.", "Lower the minimum rate or raise the nominal cadence."));
  }
  if (policy.maximum_latency_ms > policy.stale_after_ms) {
    issues.push(makeIssue("error", "RatePolicyInvalid", path, "Maximum latency cannot exceed stale-after threshold.", "Raise stale_after_ms or lower maximum_latency_ms."));
  }
}

function validateResolution(resolution: CameraResolution, issues: ValidationIssue[], path: string): void {
  if (!Number.isInteger(resolution.width_px) || !Number.isInteger(resolution.height_px) || resolution.width_px <= 0 || resolution.height_px <= 0) {
    issues.push(makeIssue("error", "CameraDescriptorInvalid", path, "Camera resolution must contain positive integer width and height.", "Use calibrated pixel dimensions."));
  }
}

function validateFieldOfView(fov: FieldOfView, issues: ValidationIssue[], path: string): void {
  if (!Number.isFinite(fov.horizontal_deg) || !Number.isFinite(fov.vertical_deg) || fov.horizontal_deg <= 0 || fov.vertical_deg <= 0 || fov.horizontal_deg >= 180 || fov.vertical_deg >= 180) {
    issues.push(makeIssue("error", "CameraDescriptorInvalid", path, "Camera field of view must be finite and inside (0, 180) degrees.", "Use calibrated horizontal and vertical FOV."));
  }
}

function validateCameraIntrinsics(intrinsics: CameraIntrinsics, issues: ValidationIssue[], path: string): void {
  validatePositive(intrinsics.fx_px, issues, `${path}.fx_px`, "CameraDescriptorInvalid");
  validatePositive(intrinsics.fy_px, issues, `${path}.fy_px`, "CameraDescriptorInvalid");
  if (!Number.isFinite(intrinsics.cx_px) || !Number.isFinite(intrinsics.cy_px)) {
    issues.push(makeIssue("error", "CameraDescriptorInvalid", path, "Camera principal point must be finite.", "Use calibrated cx and cy pixel coordinates."));
  }
  if (!["none", "brown_conrady", "fisheye"].includes(intrinsics.distortion_model)) {
    issues.push(makeIssue("error", "CameraDescriptorInvalid", `${path}.distortion_model`, "Camera distortion model is unsupported.", "Use none, brown_conrady, or fisheye."));
  }
  if (intrinsics.distortion_coefficients.some((value) => !Number.isFinite(value))) {
    issues.push(makeIssue("error", "CameraDescriptorInvalid", `${path}.distortion_coefficients`, "Distortion coefficients must be finite.", "Use calibrated finite coefficients."));
  }
}

function validateMicrophoneGeometry(geometry: readonly MicrophoneChannelGeometry[], issues: ValidationIssue[], path: string): void {
  const channelIndices = new Set<number>();
  for (let index = 0; index < geometry.length; index += 1) {
    const channel = geometry[index];
    const channelPath = `${path}[${index}]`;
    if (!Number.isInteger(channel.channel_index) || channel.channel_index < 0) {
      issues.push(makeIssue("error", "MicrophoneDescriptorInvalid", `${channelPath}.channel_index`, "Microphone channel index must be a nonnegative integer.", "Use zero-based channel indices."));
    }
    if (channelIndices.has(channel.channel_index)) {
      issues.push(makeIssue("error", "MicrophoneDescriptorInvalid", `${channelPath}.channel_index`, "Microphone channel indices must be unique.", "Rename one channel index."));
    }
    channelIndices.add(channel.channel_index);
    validateRef(channel.mount_frame_ref, issues, `${channelPath}.mount_frame_ref`, "MissingMountFrame");
    validateVector3(channel.local_position_m, issues, `${channelPath}.local_position_m`, "MicrophoneDescriptorInvalid");
  }
}

function validateTransform(transform: Transform, issues: ValidationIssue[], path: string): void {
  validateRef(transform.frame_ref, issues, `${path}.frame_ref`, "MissingMountFrame");
  validateVector3(transform.position_m, issues, `${path}.position_m`, "MissingMountFrame");
  if (!Array.isArray(transform.orientation_xyzw) || transform.orientation_xyzw.length !== 4 || transform.orientation_xyzw.some((value) => !Number.isFinite(value))) {
    issues.push(makeIssue("error", "MissingMountFrame", `${path}.orientation_xyzw`, "Mount transform orientation must be a finite quaternion.", "Use [x, y, z, w]."));
    return;
  }
  const norm = Math.sqrt(transform.orientation_xyzw.reduce((sum, value) => sum + value * value, 0));
  if (norm < 1e-9 || Math.abs(norm - 1) > 1e-6) {
    issues.push(makeIssue("error", "MissingMountFrame", `${path}.orientation_xyzw`, "Mount transform quaternion must be unit length.", "Normalize the sensor or actuator mount transform."));
  }
}

function validateVector3(value: Vector3, issues: ValidationIssue[], path: string, code: HardwareManifestIssueCode): void {
  if (!Array.isArray(value) || value.length !== 3 || value.some((component) => !Number.isFinite(component))) {
    issues.push(makeIssue("error", code, path, "Vector3 values must contain exactly three finite numeric components.", "Use [x, y, z] in canonical units."));
  }
}

function validatePositive(value: number, issues: ValidationIssue[], path: string, code: HardwareManifestIssueCode): void {
  if (!Number.isFinite(value) || value <= 0) {
    issues.push(makeIssue("error", code, path, "Value must be finite and positive.", "Use a calibrated positive number."));
  }
}

function validateRefArray(values: readonly Ref[], issues: ValidationIssue[], path: string, code: HardwareManifestIssueCode): void {
  if (!Array.isArray(values) || values.length === 0) {
    issues.push(makeIssue("error", code, path, "Reference array must be non-empty.", "Provide at least one declared reference."));
    return;
  }
  const seen = new Set<Ref>();
  for (let index = 0; index < values.length; index += 1) {
    validateRef(values[index], issues, `${path}[${index}]`, code);
    if (seen.has(values[index])) {
      issues.push(makeIssue("error", code, `${path}[${index}]`, "Reference array cannot contain duplicates.", "Remove the duplicate reference."));
    }
    seen.add(values[index]);
  }
}

function validateRef(value: Ref, issues: ValidationIssue[], path: string, code: HardwareManifestIssueCode): void {
  if (typeof value !== "string" || value.trim().length === 0 || /\s/.test(value)) {
    issues.push(makeIssue("error", code, path, "Reference must be a non-empty whitespace-free string.", "Use an opaque ref such as head_rgb_camera."));
  }
}

function makeIssue(severity: ValidationSeverity, code: HardwareManifestIssueCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function isCameraSensor(sensor: VirtualSensorDescriptor): sensor is CameraSensorDescriptor {
  return sensor.sensor_class === "rgb_camera" || sensor.sensor_class === "depth_camera" || sensor.sensor_class === "stereo_camera";
}

function isSensorClass(value: string): value is SensorClass {
  return [
    "rgb_camera",
    "depth_camera",
    "stereo_camera",
    "microphone_array",
    "joint_encoder",
    "contact_sensor",
    "imu",
    "force_torque",
    "actuator_feedback",
  ].includes(value);
}

function deepFreezeManifest(manifest: VirtualHardwareManifest): VirtualHardwareManifest {
  return Object.freeze({
    ...manifest,
    sensor_inventory: freezeArray(manifest.sensor_inventory),
    actuator_inventory: freezeArray(manifest.actuator_inventory),
    calibration_profile_refs: freezeArray(manifest.calibration_profile_refs),
    calibration_profiles: freezeArray(manifest.calibration_profiles),
    default_sensor_rates: Object.freeze({ ...manifest.default_sensor_rates }),
  });
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}
