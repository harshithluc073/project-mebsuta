/**
 * Virtual hardware adapter for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/04_VIRTUAL_HARDWARE_SENSOR_ACTUATOR_SPEC.md`
 * sections 4.3, 4.6, 4.7, 4.8, 4.9, 4.10, 4.11, 4.12, 4.14,
 * 4.15.2 through 4.15.6, 4.16, 4.17, and 4.18.
 *
 * The adapter is the executable simulation-to-hardware packet boundary. It
 * accepts render buffers, acoustic packets, joint state, body motion, contact
 * events, IMU state, and actuator feedback from the simulation layer, then
 * emits declared, calibrated, replayable, cognitive-safe virtual hardware
 * packets. Backend refs, debug overlays, hidden world truth, QA metadata, and
 * undeclared channels are blocked or stripped before any packet can be used by
 * cognition-facing systems.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { ActuatorFeedbackPacket as GatewayFeedbackPacket, GatewayApplicationStatus, GatewayHealthStatus, SaturationFlag } from "../simulation/actuator_application_gateway";
import type { AudioHealthStatus, AudioPacket as AcousticAudioPacket, SoundEventCandidate } from "../simulation/acoustic_world_service";
import type { ContactClass, ContactEvent, RelativeMotionSummary, SafetyRelevance } from "../simulation/contact_solver_adapter";
import type { CameraHealthStatus, CameraRenderPacket, RenderPacketStatus } from "../simulation/rendering_bridge";
import type { PhysicsSynchronizationToken } from "../simulation/physics_state_synchronizer";
import type { Quaternion, Ref, ValidationIssue, ValidationSeverity, Vector3 } from "../simulation/world_manifest";
import {
  VIRTUAL_HARDWARE_MANIFEST_REGISTRY_SCHEMA_VERSION,
  VirtualHardwareManifestRegistry,
  VirtualHardwareManifestRegistryError,
} from "./virtual_hardware_manifest_registry";
import type {
  ActuatorDescriptor,
  ActuatorFeedbackSensorDescriptor,
  CalibrationProfile,
  CameraIntrinsics,
  CameraSensorDescriptor,
  ContactSensorDescriptor,
  HardwareHealthStatus,
  HardwareRatePolicy,
  ImuSensorDescriptor,
  JointEncoderDescriptor,
  MicrophoneArrayDescriptor,
  SensorClass,
  VirtualSensorDescriptor,
} from "./virtual_hardware_manifest_registry";

export const VIRTUAL_HARDWARE_ADAPTER_SCHEMA_VERSION = "mebsuta.virtual_hardware_adapter.v1" as const;

const ZERO_VECTOR: Vector3 = [0, 0, 0];
const IDENTITY_QUATERNION: Quaternion = [0, 0, 0, 1];
const DEFAULT_PACKET_WINDOW_S = 1 / 240;
const DEFAULT_SENSOR_CONFIDENCE = 0.96;
const DEGRADED_SENSOR_CONFIDENCE = 0.62;
const BLOCKED_SENSOR_CONFIDENCE = 0;
const QUATERNION_NORM_TOLERANCE = 1e-5;

export type VirtualHardwarePacketKind = "camera" | "audio" | "proprioception" | "contact" | "imu" | "actuator_feedback";
export type VirtualHardwarePacketStatus = "captured" | "degraded" | "blocked" | "missing";
export type CalibrationExposure = "declared_self_knowledge" | "hardware_internal_only" | "blocked";
export type AdapterIssueCode =
  | "UndeclaredSensor"
  | "UndeclaredActuator"
  | "WrongSensorClass"
  | "MissingCalibration"
  | "DebugOverlayDetected"
  | "DepthNotDeclared"
  | "BackendRefLeak"
  | "SourceRefLeak"
  | "InternalContactRefStripped"
  | "UnknownJoint"
  | "EncoderMissing"
  | "UndeclaredContactSite"
  | "ForceOutOfRange"
  | "IMURangeExceeded"
  | "PacketStale"
  | "TimestampInvalid"
  | "ConfidenceDegraded"
  | "ActuatorFeedbackSensorMissing"
  | "ActuatorSaturated";

/**
 * Timestamp interval carried by every hardware packet. Times are seconds in
 * simulation-clock space and must be finite, monotonic, and replayable.
 */
export interface HardwareTimestampInterval {
  readonly start_s: number;
  readonly end_s: number;
}

/**
 * Provenance fields that may cross service boundaries without exposing engine
 * handles. The synchronization token remains referenced, not embedded.
 */
export interface HardwarePacketProvenance {
  readonly manifest_id: Ref;
  readonly source_tick: number;
  readonly source_time_s: number;
  readonly synchronization_token_ref?: Ref;
  readonly calibration_ref: Ref;
  readonly provenance_policy_ref?: Ref;
  readonly determinism_hash: string;
}

/**
 * Shared packet metadata used by the sensor bus and replay recorder.
 */
export interface HardwarePacketBase {
  readonly schema_version: typeof VIRTUAL_HARDWARE_ADAPTER_SCHEMA_VERSION;
  readonly packet_id: Ref;
  readonly packet_kind: VirtualHardwarePacketKind;
  readonly manifest_id: Ref;
  readonly sensor_id: Ref;
  readonly timestamp_interval: HardwareTimestampInterval;
  readonly health_status: HardwareHealthStatus;
  readonly packet_status: VirtualHardwarePacketStatus;
  readonly confidence: number;
  readonly provenance: HardwarePacketProvenance;
  readonly calibration_exposure: CalibrationExposure;
  readonly hidden_fields_removed: readonly string[];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
  readonly cognitive_visibility: "embodied_hardware_packet_after_adapter_firewall";
}

/**
 * Camera packet emitted from a declared virtual camera render buffer.
 */
export interface CameraPacket extends HardwarePacketBase {
  readonly packet_kind: "camera";
  readonly camera_role: CameraSensorDescriptor["camera_role"];
  readonly image_ref: Ref;
  readonly depth_ref?: Ref;
  readonly resolution_px: {
    readonly width_px: number;
    readonly height_px: number;
  };
  readonly intrinsics: CameraIntrinsics;
  readonly mount_frame_ref: Ref;
  readonly overlay_blocked: boolean;
  readonly source_render_packet_status: RenderPacketStatus;
  readonly source_camera_health_status: CameraHealthStatus;
}

/**
 * Audio packet emitted from a declared microphone array.
 */
export interface AudioPacket extends HardwarePacketBase {
  readonly packet_kind: "audio";
  readonly microphone_array_id: Ref;
  readonly waveform_ref?: Ref;
  readonly event_candidates: readonly AudioEventEvidence[];
  readonly dominant_bearing_estimate?: AcousticAudioPacket["dominant_bearing_estimate"];
  readonly intensity_estimate: AcousticAudioPacket["intensity_estimate"];
  readonly self_generated_likelihood: number;
  readonly source_redaction_status: "source_refs_stripped";
  readonly source_audio_health_status: AudioHealthStatus;
}

/**
 * Cognitive-safe acoustic event evidence with backend source metadata removed.
 */
export interface AudioEventEvidence {
  readonly sound_event_id: Ref;
  readonly acoustic_class: SoundEventCandidate["acoustic_class"];
  readonly source_time_s: number;
  readonly confidence: number;
  readonly expectedness: SoundEventCandidate["expectedness"];
  readonly intensity_estimate: SoundEventCandidate["intensity_estimate"];
  readonly bearing_estimate?: SoundEventCandidate["bearing_estimate"];
  readonly self_generated_likelihood: number;
  readonly route_hint: SoundEventCandidate["route_hint"];
  readonly prompt_safe_summary: string;
}

/**
 * Simulation joint state input. Engine handles are accepted only as internal
 * source fields and are deliberately absent from the output packet.
 */
export interface JointStateSample {
  readonly joint_ref: Ref;
  readonly timestamp_s: number;
  readonly position: number;
  readonly velocity?: number;
  readonly effort?: number;
  readonly engine_joint_handle?: Ref;
}

/**
 * Base/body motion input expressed as robot self-state. World refs are not
 * carried forward into packets.
 */
export interface BodyMotionState {
  readonly timestamp_s: number;
  readonly orientation_xyzw?: Quaternion;
  readonly angular_velocity_rad_per_s?: Vector3;
  readonly linear_acceleration_m_per_s2?: Vector3;
  readonly base_linear_velocity_m_per_s?: Vector3;
  readonly hidden_world_frame_ref?: Ref;
}

/**
 * Encoder reading after zero-offset correction and declared-unit mapping.
 */
export interface EncoderReading {
  readonly encoder_sensor_id: Ref;
  readonly joint_ref: Ref;
  readonly measurement_unit: JointEncoderDescriptor["measurement_unit"];
  readonly position: number;
  readonly velocity?: number;
  readonly effort?: number;
  readonly confidence: number;
  readonly calibration_ref: Ref;
}

/**
 * Proprioception packet containing declared joint encoders only.
 */
export interface ProprioceptionPacket extends HardwarePacketBase {
  readonly packet_kind: "proprioception";
  readonly sensor_id: "proprioception_bus";
  readonly encoder_readings: readonly EncoderReading[];
  readonly body_motion_estimate: {
    readonly orientation_xyzw: Quaternion;
    readonly angular_velocity_rad_per_s: Vector3;
    readonly linear_acceleration_m_per_s2: Vector3;
    readonly base_linear_velocity_m_per_s: Vector3;
  };
}

/**
 * IMU packet emitted from a declared body-mounted IMU.
 */
export interface IMUPacket extends HardwarePacketBase {
  readonly packet_kind: "imu";
  readonly orientation_xyzw: Quaternion;
  readonly angular_velocity_rad_per_s: Vector3;
  readonly linear_acceleration_m_per_s2: Vector3;
  readonly orientation_frame_ref: Ref;
  readonly range_saturation: readonly ("accelerometer" | "gyroscope")[];
}

/**
 * Declared contact site evidence derived from contact solver events.
 */
export interface ContactSiteReading {
  readonly contact_sensor_id: Ref;
  readonly contact_site_ref: Ref;
  readonly contact_event_id: Ref;
  readonly contact_class: ContactClass;
  readonly in_contact: boolean;
  readonly normal_force_n: number;
  readonly tangential_force_n: number;
  readonly slip_estimate: number;
  readonly relative_motion_summary: RelativeMotionSummary;
  readonly safety_relevance: SafetyRelevance;
  readonly force_estimate_basis: "contact_solver_impulse_divided_by_step_dt";
}

/**
 * Contact packet with internal body refs and collision shape refs removed.
 */
export interface ContactPacket extends HardwarePacketBase {
  readonly packet_kind: "contact";
  readonly sensor_id: "contact_sensor_bus";
  readonly contact_readings: readonly ContactSiteReading[];
  readonly unsafe_contact_count: number;
  readonly noisy_contact_count: number;
}

/**
 * Feedback packet for declared actuator feedback sensors.
 */
export interface ActuatorFeedbackHardwarePacket extends HardwarePacketBase {
  readonly packet_kind: "actuator_feedback";
  readonly actuator_id: Ref;
  readonly command_ref: Ref;
  readonly applied_status: GatewayApplicationStatus;
  readonly saturation_flags: readonly SaturationFlag[];
  readonly latency_ms: number;
  readonly actuator_health_status: GatewayHealthStatus;
  readonly prompt_safe_summary: string;
}

export type VirtualHardwarePacket = CameraPacket | AudioPacket | ProprioceptionPacket | IMUPacket | ContactPacket | ActuatorFeedbackHardwarePacket;

/**
 * Full adapter capture input used for one synchronized simulation step.
 */
export interface VirtualHardwareCaptureInput {
  readonly synchronization_token?: PhysicsSynchronizationToken;
  readonly camera_render_packets?: readonly CameraRenderPacket[];
  readonly audio_packets?: readonly AcousticAudioPacket[];
  readonly joint_state_samples?: readonly JointStateSample[];
  readonly body_motion_state?: BodyMotionState;
  readonly contact_events?: readonly ContactEvent[];
  readonly gateway_feedback_packets?: readonly GatewayFeedbackPacket[];
}

/**
 * Batch emitted by the adapter for sensor-bus ingestion.
 */
export interface VirtualHardwareObservationBatch {
  readonly schema_version: typeof VIRTUAL_HARDWARE_ADAPTER_SCHEMA_VERSION;
  readonly manifest_id: Ref;
  readonly synchronization_token_ref?: Ref;
  readonly packets: readonly VirtualHardwarePacket[];
  readonly blocked_packet_ids: readonly Ref[];
  readonly degraded_packet_ids: readonly Ref[];
  readonly issue_count: number;
  readonly issues: readonly ValidationIssue[];
  readonly hidden_fields_removed: readonly string[];
  readonly determinism_hash: string;
}

/**
 * Runtime configuration for the hardware adapter.
 */
export interface VirtualHardwareAdapterConfig {
  readonly registry: VirtualHardwareManifestRegistry;
  readonly manifest_id: Ref;
  readonly contact_step_dt_s?: number;
  readonly fail_on_blocked_cognitive_packet?: boolean;
  readonly include_waveform_refs?: boolean;
}

export class VirtualHardwareAdapterError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "VirtualHardwareAdapterError";
    this.issues = issues;
  }
}

/**
 * Converts simulation-layer artifacts into declared virtual hardware packets.
 */
export class VirtualHardwareAdapter {
  private readonly contactStepDtS: number;
  private readonly failOnBlockedCognitivePacket: boolean;
  private readonly includeWaveformRefs: boolean;

  public constructor(private readonly config: VirtualHardwareAdapterConfig) {
    this.contactStepDtS = assertPositiveFinite(config.contact_step_dt_s ?? DEFAULT_PACKET_WINDOW_S, "contact_step_dt_s");
    this.failOnBlockedCognitivePacket = config.fail_on_blocked_cognitive_packet ?? false;
    this.includeWaveformRefs = config.include_waveform_refs ?? true;
    this.config.registry.requireManifest(config.manifest_id);
  }

  /**
   * Produces a camera packet from a render buffer while removing render backend
   * refs, QA projections, scene graph state, and debug overlays.
   */
  public produceCameraPacket(renderPacket: CameraRenderPacket, synchronizationToken?: PhysicsSynchronizationToken): CameraPacket {
    const sensor = this.requireCameraSensor(renderPacket.sensor_id);
    const issues: ValidationIssue[] = [...renderPacket.issues];
    const packetId = `vh_camera_${renderPacket.camera_packet_id}`;
    const calibration = this.requireCalibration(sensor.calibration_ref, issues, "$.camera.calibration_ref");
    const intrinsics = this.resolveCameraIntrinsics(sensor, issues);
    const overlayBlocked = renderPacket.debug_overlay_present && isCognitiveRoute(sensor);
    if (overlayBlocked) {
      issues.push(makeIssue("error", "DebugOverlayDetected", "$.camera.debug_overlay_present", `Camera ${sensor.sensor_id} render packet includes a debug overlay.`, "Block cognitive use and recapture without debug overlays."));
    }
    if (renderPacket.depth_ref !== undefined && !sensor.supports_depth) {
      issues.push(makeIssue("error", "DepthNotDeclared", "$.camera.depth_ref", `Camera ${sensor.sensor_id} received depth data without declared depth support.`, "Declare a depth sensor or drop depth data."));
    }
    const stale = isPacketStale(renderPacket.timestamp_interval, sensor.rate_policy);
    if (stale) {
      issues.push(makeIssue("warning", "PacketStale", "$.camera.timestamp_interval", `Camera ${sensor.sensor_id} packet exceeded stale threshold.`, "Recapture or mark the packet degraded."));
    }
    const blocked = overlayBlocked || renderPacket.packet_status === "blocked" || (renderPacket.depth_ref !== undefined && !sensor.supports_depth);
    const packetStatus = blocked ? "blocked" : stale || renderPacket.packet_status === "degraded" ? "degraded" : "captured";
    const healthStatus = toHardwareHealth(renderPacket.health_status, packetStatus);
    const packet: CameraPacket = Object.freeze({
      schema_version: VIRTUAL_HARDWARE_ADAPTER_SCHEMA_VERSION,
      packet_id: packetId,
      packet_kind: "camera",
      manifest_id: this.config.manifest_id,
      sensor_id: sensor.sensor_id,
      timestamp_interval: freezeTimestamp(renderPacket.timestamp_interval),
      health_status: healthStatus,
      packet_status: packetStatus,
      confidence: confidenceFor(packetStatus, issues),
      provenance: this.buildProvenance(sensor, renderPacket.synchronization.physics_tick, renderPacket.synchronization.physics_timestamp_s, synchronizationToken, calibration.calibration_profile_ref, packetId),
      calibration_exposure: calibrationExposure(calibration),
      hidden_fields_removed: freezeArray([
        "physics_snapshot_ref",
        "qa_render_metadata",
        "projected_objects",
        "render_node_refs",
        "object_ref",
        "visual_shape_ref",
        "camera_world_transform",
        "hidden_target_markers",
      ]),
      issues: freezeArray(issues),
      determinism_hash: computeDeterminismHash({
        packetId,
        sensorId: sensor.sensor_id,
        imageRef: renderPacket.image_ref,
        depthRef: sensor.supports_depth ? renderPacket.depth_ref : undefined,
        timestamp: renderPacket.timestamp_interval,
        issues,
      }),
      cognitive_visibility: "embodied_hardware_packet_after_adapter_firewall",
      camera_role: sensor.camera_role,
      image_ref: renderPacket.image_ref,
      depth_ref: sensor.supports_depth ? renderPacket.depth_ref : undefined,
      resolution_px: Object.freeze({ width_px: renderPacket.rgb_buffer.width_px, height_px: renderPacket.rgb_buffer.height_px }),
      intrinsics,
      mount_frame_ref: sensor.mount_frame_ref,
      overlay_blocked: overlayBlocked,
      source_render_packet_status: renderPacket.packet_status,
      source_camera_health_status: renderPacket.health_status,
    });
    this.assertAllowedPacket(packet);
    return packet;
  }

  /**
   * Produces an audio packet from acoustic simulation output while stripping
   * backend source refs and preserving bearing/confidence evidence.
   */
  public produceAudioPacket(audioPacket: AcousticAudioPacket, synchronizationToken?: PhysicsSynchronizationToken): AudioPacket {
    const sensor = this.requireMicrophoneSensor(audioPacket.microphone_array_id);
    const issues: ValidationIssue[] = [...audioPacket.issues];
    const packetId = `vh_audio_${audioPacket.audio_packet_id}`;
    const calibration = this.requireCalibration(sensor.calibration_ref, issues, "$.audio.calibration_ref");
    if (audioPacket.source_redaction_status !== "source_refs_stripped_for_cognition") {
      issues.push(makeIssue("error", "SourceRefLeak", "$.audio.source_redaction_status", `Audio packet ${audioPacket.audio_packet_id} has not stripped backend source refs.`, "Reject cognitive-bound audio until source refs are removed."));
    }
    const eventCandidates = freezeArray(audioPacket.event_candidates.map((candidate) => sanitizeAudioCandidate(candidate, issues)));
    const stale = isPacketStale(audioPacket.timestamp_interval, sensor.rate_policy);
    if (stale) {
      issues.push(makeIssue("warning", "PacketStale", "$.audio.timestamp_interval", `Audio packet ${audioPacket.audio_packet_id} exceeded stale threshold.`, "Recapture audio or mark degraded."));
    }
    const blocked = audioPacket.packet_status === "blocked" || audioPacket.source_redaction_status !== "source_refs_stripped_for_cognition";
    const packetStatus = blocked ? "blocked" : stale || audioPacket.packet_status === "degraded" ? "degraded" : "captured";
    const packet: AudioPacket = Object.freeze({
      schema_version: VIRTUAL_HARDWARE_ADAPTER_SCHEMA_VERSION,
      packet_id: packetId,
      packet_kind: "audio",
      manifest_id: this.config.manifest_id,
      sensor_id: sensor.sensor_id,
      timestamp_interval: freezeTimestamp(audioPacket.timestamp_interval),
      health_status: toHardwareHealth(audioPacket.health_status, packetStatus),
      packet_status: packetStatus,
      confidence: confidenceFor(packetStatus, issues),
      provenance: this.buildProvenance(sensor, audioPacket.synchronization.physics_tick, audioPacket.synchronization.physics_timestamp_s, synchronizationToken, calibration.calibration_profile_ref, packetId),
      calibration_exposure: calibrationExposure(calibration),
      hidden_fields_removed: freezeArray([
        "qa_source_metadata",
        "internal_source_refs",
        "source_position_m",
        "audio_profile_refs",
        "contact_event_ref",
        "movement_event_ref",
        "backend_source_object_ref",
      ]),
      issues: freezeArray(issues),
      determinism_hash: computeDeterminismHash({
        packetId,
        sensorId: sensor.sensor_id,
        eventCandidates,
        waveformRef: this.includeWaveformRefs ? audioPacket.waveform_ref : undefined,
        timestamp: audioPacket.timestamp_interval,
        issues,
      }),
      cognitive_visibility: "embodied_hardware_packet_after_adapter_firewall",
      microphone_array_id: sensor.sensor_id,
      waveform_ref: this.includeWaveformRefs ? audioPacket.waveform_ref : undefined,
      event_candidates: eventCandidates,
      dominant_bearing_estimate: audioPacket.dominant_bearing_estimate,
      intensity_estimate: audioPacket.intensity_estimate,
      self_generated_likelihood: clamp01(audioPacket.self_generated_likelihood),
      source_redaction_status: "source_refs_stripped",
      source_audio_health_status: audioPacket.health_status,
    });
    this.assertAllowedPacket(packet);
    return packet;
  }

  /**
   * Produces a proprioception packet from joint samples by joining each sample
   * to a declared encoder, subtracting calibrated zero offset, and dropping
   * engine handles.
   */
  public produceProprioceptionPacket(
    jointStateSamples: readonly JointStateSample[],
    bodyMotionState: BodyMotionState = { timestamp_s: 0 },
    synchronizationToken?: PhysicsSynchronizationToken,
  ): ProprioceptionPacket {
    const issues: ValidationIssue[] = [];
    const encoders = this.listSensors("joint_encoder").filter(isJointEncoder);
    const byJointRef = new Map<Ref, JointEncoderDescriptor>();
    for (const encoder of encoders) {
      byJointRef.set(encoder.joint_ref, encoder);
    }
    const readings: EncoderReading[] = [];
    let sourceTime = bodyMotionState.timestamp_s;
    for (let index = 0; index < jointStateSamples.length; index += 1) {
      const sample = jointStateSamples[index];
      sourceTime = Math.max(sourceTime, sample.timestamp_s);
      const encoder = byJointRef.get(sample.joint_ref);
      if (encoder === undefined) {
        issues.push(makeIssue("error", "EncoderMissing", `$.joint_state_samples[${index}].joint_ref`, `Joint ${sample.joint_ref} has no declared encoder.`, "Declare a joint encoder before exposing proprioception."));
        continue;
      }
      if (sample.engine_joint_handle !== undefined) {
        issues.push(makeIssue("warning", "BackendRefLeak", `$.joint_state_samples[${index}].engine_joint_handle`, "Engine joint handle was stripped from proprioception output.", "Keep engine handles internal to simulation adapters."));
      }
      const position = sample.position - encoder.zero_offset;
      const reading: EncoderReading = Object.freeze({
        encoder_sensor_id: encoder.sensor_id,
        joint_ref: encoder.joint_ref,
        measurement_unit: encoder.measurement_unit,
        position: finiteOrIssue(position, issues, `$.joint_state_samples[${index}].position`, "UnknownJoint"),
        velocity: encoder.reports_velocity && sample.velocity !== undefined ? finiteOrIssue(sample.velocity, issues, `$.joint_state_samples[${index}].velocity`, "UnknownJoint") : undefined,
        effort: encoder.reports_effort && sample.effort !== undefined ? finiteOrIssue(sample.effort, issues, `$.joint_state_samples[${index}].effort`, "UnknownJoint") : undefined,
        confidence: DEFAULT_SENSOR_CONFIDENCE,
        calibration_ref: encoder.calibration_ref,
      });
      readings.push(reading);
    }
    const packetStatus: VirtualHardwarePacketStatus = issues.some((issue) => issue.severity === "error") ? "blocked" : issues.length > 0 ? "degraded" : "captured";
    const representativeEncoder = encoders[0];
    const calibrationRef = representativeEncoder?.calibration_ref ?? "proprioception_bus_calibration_missing";
    if (representativeEncoder === undefined) {
      issues.push(makeIssue("error", "EncoderMissing", "$.sensor_inventory", "No joint encoders are declared for proprioception.", "Declare encoder sensors before producing proprioception packets."));
    }
    const timestamp = buildPointInterval(sourceTime);
    const packetId = `vh_proprioception_${this.config.manifest_id}_${Math.round(sourceTime * 1000)}`;
    const packet: ProprioceptionPacket = Object.freeze({
      schema_version: VIRTUAL_HARDWARE_ADAPTER_SCHEMA_VERSION,
      packet_id: packetId,
      packet_kind: "proprioception",
      manifest_id: this.config.manifest_id,
      sensor_id: "proprioception_bus",
      timestamp_interval: timestamp,
      health_status: packetStatus === "blocked" ? "blocked" : packetStatus === "degraded" ? "degraded" : "healthy",
      packet_status: packetStatus,
      confidence: confidenceFor(packetStatus, issues),
      provenance: this.buildBusProvenance(sourceTime, synchronizationToken, calibrationRef, packetId),
      calibration_exposure: representativeEncoder === undefined ? "blocked" : "declared_self_knowledge",
      hidden_fields_removed: freezeArray(["engine_joint_handle", "hidden_world_frame_ref", "physics_body_ref", "solver_body_handle"]),
      issues: freezeArray(issues),
      determinism_hash: computeDeterminismHash({ packetId, readings, bodyMotionState: stripBodyMotionState(bodyMotionState), issues }),
      cognitive_visibility: "embodied_hardware_packet_after_adapter_firewall",
      encoder_readings: freezeArray(readings),
      body_motion_estimate: Object.freeze(stripBodyMotionState(bodyMotionState)),
    });
    this.assertAllowedPacket(packet);
    return packet;
  }

  /**
   * Produces an IMU packet from body motion state with accelerometer and gyro
   * range checks against the declared IMU descriptor.
   */
  public produceIMUPacket(sensorId: Ref, bodyMotionState: BodyMotionState, synchronizationToken?: PhysicsSynchronizationToken): IMUPacket {
    const sensor = this.requireImuSensor(sensorId);
    const issues: ValidationIssue[] = [];
    const calibration = this.requireCalibration(sensor.calibration_ref, issues, "$.imu.calibration_ref");
    const orientation = normalizeQuaternion(bodyMotionState.orientation_xyzw ?? IDENTITY_QUATERNION, issues, "$.imu.orientation_xyzw");
    const angularVelocity = finiteVector(bodyMotionState.angular_velocity_rad_per_s ?? ZERO_VECTOR, issues, "$.imu.angular_velocity_rad_per_s");
    const acceleration = finiteVector(bodyMotionState.linear_acceleration_m_per_s2 ?? ZERO_VECTOR, issues, "$.imu.linear_acceleration_m_per_s2");
    const saturation: ("accelerometer" | "gyroscope")[] = [];
    if (vectorMagnitude(acceleration) > sensor.accelerometer_range_m_per_s2) {
      saturation.push("accelerometer");
      issues.push(makeIssue("warning", "IMURangeExceeded", "$.imu.linear_acceleration_m_per_s2", `IMU ${sensor.sensor_id} acceleration exceeded declared range.`, "Mark IMU degraded and recapture or recalibrate."));
    }
    if (vectorMagnitude(angularVelocity) > sensor.gyroscope_range_rad_per_s) {
      saturation.push("gyroscope");
      issues.push(makeIssue("warning", "IMURangeExceeded", "$.imu.angular_velocity_rad_per_s", `IMU ${sensor.sensor_id} angular velocity exceeded declared range.`, "Mark IMU degraded and recapture or recalibrate."));
    }
    if (bodyMotionState.hidden_world_frame_ref !== undefined) {
      issues.push(makeIssue("warning", "BackendRefLeak", "$.imu.hidden_world_frame_ref", "Hidden world frame ref was stripped from IMU packet.", "Expose IMU readings only as self-state."));
    }
    const packetStatus: VirtualHardwarePacketStatus = issues.some((issue) => issue.severity === "error") ? "blocked" : issues.length > 0 ? "degraded" : "captured";
    const timestamp = buildPointInterval(bodyMotionState.timestamp_s);
    const packetId = `vh_imu_${sensor.sensor_id}_${Math.round(bodyMotionState.timestamp_s * 1000)}`;
    const packet: IMUPacket = Object.freeze({
      schema_version: VIRTUAL_HARDWARE_ADAPTER_SCHEMA_VERSION,
      packet_id: packetId,
      packet_kind: "imu",
      manifest_id: this.config.manifest_id,
      sensor_id: sensor.sensor_id,
      timestamp_interval: timestamp,
      health_status: packetStatus === "degraded" ? "degraded" : packetStatus === "blocked" ? "blocked" : "healthy",
      packet_status: packetStatus,
      confidence: confidenceFor(packetStatus, issues),
      provenance: this.buildProvenance(sensor, synchronizationToken?.physics_tick ?? 0, bodyMotionState.timestamp_s, synchronizationToken, calibration.calibration_profile_ref, packetId),
      calibration_exposure: calibrationExposure(calibration),
      hidden_fields_removed: freezeArray(["hidden_world_frame_ref", "world_pose", "physics_body_ref", "solver_body_handle"]),
      issues: freezeArray(issues),
      determinism_hash: computeDeterminismHash({ packetId, orientation, angularVelocity, acceleration, saturation, issues }),
      cognitive_visibility: "embodied_hardware_packet_after_adapter_firewall",
      orientation_xyzw: orientation,
      angular_velocity_rad_per_s: angularVelocity,
      linear_acceleration_m_per_s2: acceleration,
      orientation_frame_ref: sensor.orientation_frame_ref,
      range_saturation: freezeArray(saturation),
    });
    this.assertAllowedPacket(packet);
    return packet;
  }

  /**
   * Produces contact sensor packets by mapping contact solver sites to declared
   * contact sensors and stripping body/collision internals.
   */
  public produceContactPacket(contactEvents: readonly ContactEvent[], synchronizationToken?: PhysicsSynchronizationToken): ContactPacket {
    const issues: ValidationIssue[] = [];
    const contactSensors = this.listSensors("contact_sensor").filter(isContactSensor);
    const forceTorqueSensors = this.listSensors("force_torque").filter(isContactSensor);
    const sensors = [...contactSensors, ...forceTorqueSensors];
    const bySite = new Map<Ref, ContactSensorDescriptor>();
    for (const sensor of sensors) {
      bySite.set(sensor.contact_site_ref, sensor);
    }
    const readings: ContactSiteReading[] = [];
    let latestTime = synchronizationToken?.physics_timestamp_s ?? 0;
    let unsafeContactCount = 0;
    let noisyContactCount = 0;
    for (const event of contactEvents) {
      latestTime = Math.max(latestTime, event.timestamp_s);
      if (event.internal_body_refs.length > 0 || event.collision_shape_refs.length > 0) {
        issues.push(makeIssue("warning", "InternalContactRefStripped", "$.contact_events.internal_refs", `Internal refs were stripped from contact event ${event.contact_event_id}.`, "Keep solver and collision refs inside runtime QA metadata."));
      }
      const matchingSensors = event.contact_sites.map((site) => bySite.get(site)).filter((sensor): sensor is ContactSensorDescriptor => sensor !== undefined);
      if (matchingSensors.length === 0) {
        issues.push(makeIssue("error", "UndeclaredContactSite", "$.contact_events.contact_sites", `Contact event ${event.contact_event_id} did not map to any declared contact sensor.`, "Declare contact sites before exposing tactile evidence."));
        continue;
      }
      for (const sensor of matchingSensors) {
        const normalForce = Math.max(0, event.impulse_summary.estimated_normal_force_n);
        const tangentialForce = Math.max(0, event.impulse_summary.estimated_tangential_force_n);
        const forceClamped = Math.min(normalForce, sensor.max_force_n);
        if (normalForce > sensor.max_force_n) {
          noisyContactCount += 1;
          issues.push(makeIssue("warning", "ForceOutOfRange", `$.contact_events.${event.contact_event_id}.normal_force_n`, `Contact force exceeded ${sensor.sensor_id} max force.`, "Clamp to declared range and mark contact degraded."));
        }
        if (event.safety_relevance === "safe_hold" || event.contact_class === "unplanned_collision") {
          unsafeContactCount += 1;
        }
        readings.push(Object.freeze({
          contact_sensor_id: sensor.sensor_id,
          contact_site_ref: sensor.contact_site_ref,
          contact_event_id: event.contact_event_id,
          contact_class: event.contact_class,
          in_contact: true,
          normal_force_n: forceClamped,
          tangential_force_n: Math.min(tangentialForce, sensor.max_force_n),
          slip_estimate: estimateSlip(event.relative_motion_summary, event.impulse_summary.estimated_tangential_force_n, Math.max(event.impulse_summary.estimated_normal_force_n, 1e-9)),
          relative_motion_summary: event.relative_motion_summary,
          safety_relevance: event.safety_relevance,
          force_estimate_basis: "contact_solver_impulse_divided_by_step_dt",
        }));
      }
    }
    const packetStatus: VirtualHardwarePacketStatus = issues.some((issue) => issue.severity === "error") ? "blocked" : issues.length > 0 ? "degraded" : "captured";
    const representativeSensor = sensors[0];
    if (representativeSensor === undefined) {
      issues.push(makeIssue("error", "UndeclaredSensor", "$.sensor_inventory", "No contact or force-torque sensors are declared.", "Declare tactile/contact sensors before producing contact packets."));
    }
    const packetId = `vh_contact_${this.config.manifest_id}_${synchronizationToken?.physics_tick ?? Math.round(latestTime * 1000)}`;
    const packet: ContactPacket = Object.freeze({
      schema_version: VIRTUAL_HARDWARE_ADAPTER_SCHEMA_VERSION,
      packet_id: packetId,
      packet_kind: "contact",
      manifest_id: this.config.manifest_id,
      sensor_id: "contact_sensor_bus",
      timestamp_interval: buildPointInterval(latestTime),
      health_status: packetStatus === "blocked" ? "blocked" : packetStatus === "degraded" ? "degraded" : "healthy",
      packet_status: packetStatus,
      confidence: confidenceFor(packetStatus, issues),
      provenance: this.buildBusProvenance(latestTime, synchronizationToken, representativeSensor?.calibration_ref ?? "contact_bus_calibration_missing", packetId),
      calibration_exposure: representativeSensor === undefined ? "blocked" : "declared_self_knowledge",
      hidden_fields_removed: freezeArray(["internal_body_refs", "collision_shape_refs", "material_pair", "friction_diagnostic", "acoustic_profile_refs", "mean_contact_point_m"]),
      issues: freezeArray(issues),
      determinism_hash: computeDeterminismHash({ packetId, readings, unsafeContactCount, noisyContactCount, issues }),
      cognitive_visibility: "embodied_hardware_packet_after_adapter_firewall",
      contact_readings: freezeArray(readings),
      unsafe_contact_count: unsafeContactCount,
      noisy_contact_count: noisyContactCount,
    });
    this.assertAllowedPacket(packet);
    return packet;
  }

  /**
   * Produces actuator feedback packets for declared actuator feedback sensors.
   */
  public produceActuatorFeedbackPackets(feedbackPackets: readonly GatewayFeedbackPacket[], synchronizationToken?: PhysicsSynchronizationToken): readonly ActuatorFeedbackHardwarePacket[] {
    return freezeArray(feedbackPackets.map((feedback) => this.produceActuatorFeedbackPacket(feedback, synchronizationToken)));
  }

  /**
   * Converts a single gateway feedback packet to hardware feedback evidence.
   */
  public produceActuatorFeedbackPacket(feedback: GatewayFeedbackPacket, synchronizationToken?: PhysicsSynchronizationToken): ActuatorFeedbackHardwarePacket {
    const issues: ValidationIssue[] = [];
    const actuator = this.config.registry.assertActuatorDeclared(this.config.manifest_id, feedback.actuator_id);
    const feedbackSensor = this.findFeedbackSensor(feedback.actuator_id);
    if (feedbackSensor === undefined) {
      issues.push(makeIssue("error", "ActuatorFeedbackSensorMissing", "$.feedback.actuator_id", `Actuator ${feedback.actuator_id} has no declared feedback sensor.`, "Declare an actuator_feedback sensor before exposing actuator results."));
    }
    if (feedback.saturation_flags.length > 0 || feedback.applied_status === "saturated" || feedback.applied_status === "safe_hold_required") {
      issues.push(makeIssue("warning", "ActuatorSaturated", "$.feedback.saturation_flags", `Actuator ${feedback.actuator_id} reported saturation or safe-hold state.`, "Expose saturation explicitly and let control/safety decide follow-up."));
    }
    const packetStatus: VirtualHardwarePacketStatus = feedback.applied_status === "rejected" || feedbackSensor === undefined ? "blocked" : issues.length > 0 ? "degraded" : "captured";
    const sensorId = feedbackSensor?.sensor_id ?? `missing_feedback_sensor_for_${feedback.actuator_id}`;
    const calibrationRef = feedbackSensor?.calibration_ref ?? actuator.calibration_ref;
    const calibration = this.requireCalibration(calibrationRef, issues, "$.feedback.calibration_ref");
    const sourceTime = synchronizationToken?.physics_timestamp_s ?? 0;
    const packetId = `vh_feedback_${feedback.feedback_packet_id}`;
    const packet: ActuatorFeedbackHardwarePacket = Object.freeze({
      schema_version: VIRTUAL_HARDWARE_ADAPTER_SCHEMA_VERSION,
      packet_id: packetId,
      packet_kind: "actuator_feedback",
      manifest_id: this.config.manifest_id,
      sensor_id: sensorId,
      timestamp_interval: buildPointInterval(sourceTime),
      health_status: gatewayHealthToHardware(feedback.health_status, packetStatus),
      packet_status: packetStatus,
      confidence: confidenceFor(packetStatus, issues),
      provenance: feedbackSensor === undefined
        ? this.buildActuatorProvenance(actuator, sourceTime, synchronizationToken, calibration.calibration_profile_ref, packetId)
        : this.buildProvenance(feedbackSensor, synchronizationToken?.physics_tick ?? 0, sourceTime, synchronizationToken, calibration.calibration_profile_ref, packetId),
      calibration_exposure: calibrationExposure(calibration),
      hidden_fields_removed: freezeArray(["joint_ref", "physics_actuator_handle", "runtime_control_report_ref", "target_ref", "safety_policy_ref"]),
      issues: freezeArray(issues),
      determinism_hash: computeDeterminismHash({
        packetId,
        actuatorId: feedback.actuator_id,
        commandRef: feedback.command_ref,
        status: feedback.applied_status,
        saturationFlags: feedback.saturation_flags,
        issues,
      }),
      cognitive_visibility: "embodied_hardware_packet_after_adapter_firewall",
      actuator_id: feedback.actuator_id,
      command_ref: feedback.command_ref,
      applied_status: feedback.applied_status,
      saturation_flags: freezeArray(feedback.saturation_flags),
      latency_ms: finiteOrIssue(feedback.latency_ms, issues, "$.feedback.latency_ms", "TimestampInvalid"),
      actuator_health_status: feedback.health_status,
      prompt_safe_summary: `Actuator ${feedback.actuator_id} ${feedback.applied_status}; saturation flags: ${feedback.saturation_flags.length === 0 ? "none" : feedback.saturation_flags.join(",")}.`,
    });
    this.assertAllowedPacket(packet);
    return packet;
  }

  /**
   * Converts all provided simulation artifacts for a synchronized step.
   */
  public capture(input: VirtualHardwareCaptureInput): VirtualHardwareObservationBatch {
    const packets: VirtualHardwarePacket[] = [];
    const issues: ValidationIssue[] = [];
    for (const renderPacket of input.camera_render_packets ?? []) {
      packets.push(this.produceCameraPacket(renderPacket, input.synchronization_token));
    }
    for (const audioPacket of input.audio_packets ?? []) {
      packets.push(this.produceAudioPacket(audioPacket, input.synchronization_token));
    }
    if ((input.joint_state_samples?.length ?? 0) > 0 || input.body_motion_state !== undefined) {
      packets.push(this.produceProprioceptionPacket(input.joint_state_samples ?? [], input.body_motion_state, input.synchronization_token));
    }
    for (const imu of this.listSensors("imu").filter(isImuSensor)) {
      if (input.body_motion_state !== undefined) {
        packets.push(this.produceIMUPacket(imu.sensor_id, input.body_motion_state, input.synchronization_token));
      }
    }
    if ((input.contact_events?.length ?? 0) > 0) {
      packets.push(this.produceContactPacket(input.contact_events ?? [], input.synchronization_token));
    }
    packets.push(...this.produceActuatorFeedbackPackets(input.gateway_feedback_packets ?? [], input.synchronization_token));
    for (const packet of packets) {
      issues.push(...packet.issues);
    }
    const blockedPacketIds = packets.filter((packet) => packet.packet_status === "blocked").map((packet) => packet.packet_id);
    const degradedPacketIds = packets.filter((packet) => packet.packet_status === "degraded").map((packet) => packet.packet_id);
    const batch: VirtualHardwareObservationBatch = Object.freeze({
      schema_version: VIRTUAL_HARDWARE_ADAPTER_SCHEMA_VERSION,
      manifest_id: this.config.manifest_id,
      synchronization_token_ref: input.synchronization_token?.token_ref,
      packets: freezeArray(packets),
      blocked_packet_ids: freezeArray(blockedPacketIds),
      degraded_packet_ids: freezeArray(degradedPacketIds),
      issue_count: issues.length,
      issues: freezeArray(issues),
      hidden_fields_removed: freezeArray([
        "physics_snapshot_ref",
        "engine_joint_handle",
        "hidden_world_frame_ref",
        "internal_body_refs",
        "collision_shape_refs",
        "qa_source_metadata",
        "runtime_control_report_ref",
      ]),
      determinism_hash: computeDeterminismHash({ manifestId: this.config.manifest_id, packets, blockedPacketIds, degradedPacketIds, issues }),
    });
    return batch;
  }

  private requireCameraSensor(sensorId: Ref): CameraSensorDescriptor {
    const sensor = this.config.registry.assertSensorDeclared(this.config.manifest_id, sensorId);
    if (!isCameraSensor(sensor)) {
      throw new VirtualHardwareAdapterError("Declared sensor is not a camera.", [
        makeIssue("error", "WrongSensorClass", "$.sensor_id", `Sensor ${sensorId} is not declared as a camera.`, "Use an RGB, depth, or stereo camera descriptor."),
      ]);
    }
    return sensor;
  }

  private requireMicrophoneSensor(sensorId: Ref): MicrophoneArrayDescriptor {
    const sensor = this.config.registry.assertSensorDeclared(this.config.manifest_id, sensorId, "microphone_array");
    if (!isMicrophoneSensor(sensor)) {
      throw new VirtualHardwareAdapterError("Declared sensor is not a microphone array.", [
        makeIssue("error", "WrongSensorClass", "$.sensor_id", `Sensor ${sensorId} is not declared as a microphone array.`, "Use a microphone_array descriptor."),
      ]);
    }
    return sensor;
  }

  private requireImuSensor(sensorId: Ref): ImuSensorDescriptor {
    const sensor = this.config.registry.assertSensorDeclared(this.config.manifest_id, sensorId, "imu");
    if (!isImuSensor(sensor)) {
      throw new VirtualHardwareAdapterError("Declared sensor is not an IMU.", [
        makeIssue("error", "WrongSensorClass", "$.sensor_id", `Sensor ${sensorId} is not declared as an IMU.`, "Use an IMU descriptor."),
      ]);
    }
    return sensor;
  }

  private listSensors(sensorClass: SensorClass): readonly VirtualSensorDescriptor[] {
    return this.config.registry.listSensors(this.config.manifest_id, sensorClass);
  }

  private requireCalibration(calibrationRef: Ref, issues: ValidationIssue[], path: string): CalibrationProfile {
    try {
      return this.config.registry.resolveCalibration(this.config.manifest_id, calibrationRef);
    } catch (error) {
      if (error instanceof VirtualHardwareManifestRegistryError) {
        issues.push(...error.issues);
      }
      issues.push(makeIssue("error", "MissingCalibration", path, `Calibration ${calibrationRef} is missing.`, "Declare calibration before exposing hardware packets."));
      throw new VirtualHardwareAdapterError("Required calibration is missing.", issues);
    }
  }

  private resolveCameraIntrinsics(sensor: CameraSensorDescriptor, issues: ValidationIssue[]): CameraIntrinsics {
    const profile = this.requireCalibration(sensor.intrinsics_ref, issues, "$.camera.intrinsics_ref");
    if (profile.camera_intrinsics === undefined) {
      issues.push(makeIssue("error", "MissingCalibration", "$.camera.intrinsics_ref", `Calibration ${sensor.intrinsics_ref} does not include camera intrinsics.`, "Attach camera intrinsic calibration."));
      return Object.freeze({
        fx_px: sensor.resolution.width_px,
        fy_px: sensor.resolution.height_px,
        cx_px: sensor.resolution.width_px / 2,
        cy_px: sensor.resolution.height_px / 2,
        distortion_model: "none",
        distortion_coefficients: freezeArray([]),
      });
    }
    return Object.freeze({
      ...profile.camera_intrinsics,
      distortion_coefficients: freezeArray(profile.camera_intrinsics.distortion_coefficients),
    });
  }

  private findFeedbackSensor(actuatorId: Ref): ActuatorFeedbackSensorDescriptor | undefined {
    return this.listSensors("actuator_feedback").filter(isActuatorFeedbackSensor).find((sensor) => sensor.actuator_ref === actuatorId);
  }

  private buildProvenance(
    sensor: VirtualSensorDescriptor,
    sourceTick: number,
    sourceTimeS: number,
    synchronizationToken: PhysicsSynchronizationToken | undefined,
    calibrationRef: Ref,
    packetId: Ref,
  ): HardwarePacketProvenance {
    return Object.freeze({
      manifest_id: this.config.manifest_id,
      source_tick: synchronizationToken?.physics_tick ?? sourceTick,
      source_time_s: synchronizationToken?.physics_timestamp_s ?? sourceTimeS,
      synchronization_token_ref: synchronizationToken?.token_ref,
      calibration_ref: calibrationRef,
      provenance_policy_ref: sensor.provenance_policy_ref,
      determinism_hash: computeDeterminismHash({ packetId, calibrationRef, sourceTick, sourceTimeS, token: synchronizationToken?.token_ref }),
    });
  }

  private buildBusProvenance(sourceTimeS: number, synchronizationToken: PhysicsSynchronizationToken | undefined, calibrationRef: Ref, packetId: Ref): HardwarePacketProvenance {
    return Object.freeze({
      manifest_id: this.config.manifest_id,
      source_tick: synchronizationToken?.physics_tick ?? Math.round(sourceTimeS / DEFAULT_PACKET_WINDOW_S),
      source_time_s: synchronizationToken?.physics_timestamp_s ?? sourceTimeS,
      synchronization_token_ref: synchronizationToken?.token_ref,
      calibration_ref: calibrationRef,
      determinism_hash: computeDeterminismHash({ packetId, calibrationRef, sourceTimeS, token: synchronizationToken?.token_ref }),
    });
  }

  private buildActuatorProvenance(
    actuator: ActuatorDescriptor,
    sourceTimeS: number,
    synchronizationToken: PhysicsSynchronizationToken | undefined,
    calibrationRef: Ref,
    packetId: Ref,
  ): HardwarePacketProvenance {
    return Object.freeze({
      manifest_id: this.config.manifest_id,
      source_tick: synchronizationToken?.physics_tick ?? Math.round(sourceTimeS / DEFAULT_PACKET_WINDOW_S),
      source_time_s: synchronizationToken?.physics_timestamp_s ?? sourceTimeS,
      synchronization_token_ref: synchronizationToken?.token_ref,
      calibration_ref: calibrationRef,
      provenance_policy_ref: actuator.provenance_policy_ref,
      determinism_hash: computeDeterminismHash({ packetId, actuatorId: actuator.actuator_id, calibrationRef, sourceTimeS }),
    });
  }

  private assertAllowedPacket(packet: HardwarePacketBase): void {
    if (this.failOnBlockedCognitivePacket && packet.packet_status === "blocked") {
      throw new VirtualHardwareAdapterError(`Packet ${packet.packet_id} is blocked by the virtual hardware firewall.`, packet.issues);
    }
  }
}

export function createVirtualHardwareAdapter(config: VirtualHardwareAdapterConfig): VirtualHardwareAdapter {
  return new VirtualHardwareAdapter(config);
}

export function captureVirtualHardware(input: VirtualHardwareCaptureInput, config: VirtualHardwareAdapterConfig): VirtualHardwareObservationBatch {
  return new VirtualHardwareAdapter(config).capture(input);
}

function sanitizeAudioCandidate(candidate: SoundEventCandidate, issues: ValidationIssue[]): AudioEventEvidence {
  if (!candidate.hidden_source_ref_redacted || candidate.qa_source_metadata.internal_source_refs.length > 0) {
    issues.push(makeIssue("error", "SourceRefLeak", `$.audio.event_candidates.${candidate.sound_event_id}`, `Audio event ${candidate.sound_event_id} carried backend source metadata before adapter redaction.`, "Strip source refs and keep QA metadata internal."));
  }
  return Object.freeze({
    sound_event_id: candidate.sound_event_id,
    acoustic_class: candidate.acoustic_class,
    source_time_s: candidate.source_time_s,
    confidence: clamp01(candidate.confidence),
    expectedness: candidate.expectedness,
    intensity_estimate: candidate.intensity_estimate,
    bearing_estimate: candidate.bearing_estimate,
    self_generated_likelihood: clamp01(candidate.self_generated_likelihood),
    route_hint: candidate.route_hint,
    prompt_safe_summary: candidate.prompt_safe_summary,
  });
}

function stripBodyMotionState(bodyMotionState: BodyMotionState): ProprioceptionPacket["body_motion_estimate"] {
  return Object.freeze({
    orientation_xyzw: normalizeQuaternionNoIssue(bodyMotionState.orientation_xyzw ?? IDENTITY_QUATERNION),
    angular_velocity_rad_per_s: freezeVector(bodyMotionState.angular_velocity_rad_per_s ?? ZERO_VECTOR),
    linear_acceleration_m_per_s2: freezeVector(bodyMotionState.linear_acceleration_m_per_s2 ?? ZERO_VECTOR),
    base_linear_velocity_m_per_s: freezeVector(bodyMotionState.base_linear_velocity_m_per_s ?? ZERO_VECTOR),
  });
}

function isPacketStale(timestamp: { readonly start_s: number; readonly end_s: number }, policy: HardwareRatePolicy): boolean {
  const durationMs = Math.max(0, timestamp.end_s - timestamp.start_s) * 1000;
  return durationMs > policy.stale_after_ms || !isFiniteTimestamp(timestamp);
}

function buildPointInterval(timestampS: number): HardwareTimestampInterval {
  const finite = Number.isFinite(timestampS) ? timestampS : 0;
  return Object.freeze({ start_s: finite, end_s: finite + DEFAULT_PACKET_WINDOW_S });
}

function freezeTimestamp(timestamp: { readonly start_s: number; readonly end_s: number }): HardwareTimestampInterval {
  if (!isFiniteTimestamp(timestamp)) {
    return Object.freeze({ start_s: 0, end_s: DEFAULT_PACKET_WINDOW_S });
  }
  return Object.freeze({ start_s: timestamp.start_s, end_s: timestamp.end_s });
}

function isFiniteTimestamp(timestamp: { readonly start_s: number; readonly end_s: number }): boolean {
  return Number.isFinite(timestamp.start_s) && Number.isFinite(timestamp.end_s) && timestamp.end_s >= timestamp.start_s;
}

function toHardwareHealth(health: CameraHealthStatus | AudioHealthStatus, packetStatus: VirtualHardwarePacketStatus): HardwareHealthStatus {
  if (packetStatus === "blocked" || health === "blocked") {
    return "blocked";
  }
  if (packetStatus === "missing") {
    return "missing";
  }
  if (packetStatus === "degraded" || health === "degraded") {
    return "degraded";
  }
  return "healthy";
}

function gatewayHealthToHardware(health: GatewayHealthStatus, packetStatus: VirtualHardwarePacketStatus): HardwareHealthStatus {
  if (packetStatus === "blocked" || health === "disabled") {
    return "blocked";
  }
  if (packetStatus === "degraded" || health === "degraded") {
    return "degraded";
  }
  return "healthy";
}

function confidenceFor(packetStatus: VirtualHardwarePacketStatus, issues: readonly ValidationIssue[]): number {
  if (packetStatus === "blocked") {
    return BLOCKED_SENSOR_CONFIDENCE;
  }
  if (packetStatus === "degraded" || issues.length > 0) {
    return DEGRADED_SENSOR_CONFIDENCE;
  }
  return DEFAULT_SENSOR_CONFIDENCE;
}

function calibrationExposure(profile: CalibrationProfile): CalibrationExposure {
  if (profile.cognitive_visibility === "declared_calibration_allowed") {
    return "declared_self_knowledge";
  }
  if (profile.cognitive_visibility === "hardware_internal_only") {
    return "hardware_internal_only";
  }
  return "blocked";
}

function estimateSlip(relativeMotion: RelativeMotionSummary, tangentialForceN: number, normalForceN: number): number {
  const forceRatio = clamp01(Math.abs(tangentialForceN) / Math.max(Math.abs(normalForceN), 1e-9));
  switch (relativeMotion) {
    case "sliding":
      return clamp01(0.65 + 0.35 * forceRatio);
    case "rolling":
      return clamp01(0.25 + 0.3 * forceRatio);
    case "separating":
      return clamp01(0.35 + 0.2 * forceRatio);
    case "impacting":
      return clamp01(0.45 + 0.4 * forceRatio);
    case "sticking":
      return clamp01(0.05 + 0.2 * forceRatio);
  }
}

function normalizeQuaternion(quaternion: Quaternion, issues: ValidationIssue[], path: string): Quaternion {
  if (quaternion.length !== 4 || quaternion.some((value) => !Number.isFinite(value))) {
    issues.push(makeIssue("error", "IMURangeExceeded", path, "Quaternion must contain four finite values.", "Provide a finite [x,y,z,w] orientation."));
    return IDENTITY_QUATERNION;
  }
  const norm = Math.sqrt(quaternion.reduce((sum, value) => sum + value * value, 0));
  if (norm < 1e-9) {
    issues.push(makeIssue("error", "IMURangeExceeded", path, "Quaternion norm is zero.", "Provide a valid body orientation."));
    return IDENTITY_QUATERNION;
  }
  if (Math.abs(norm - 1) > QUATERNION_NORM_TOLERANCE) {
    issues.push(makeIssue("warning", "ConfidenceDegraded", path, "Quaternion was normalized before IMU packet emission.", "Normalize orientation at the motion source."));
  }
  return Object.freeze([quaternion[0] / norm, quaternion[1] / norm, quaternion[2] / norm, quaternion[3] / norm] as const);
}

function normalizeQuaternionNoIssue(quaternion: Quaternion): Quaternion {
  const norm = Math.sqrt(quaternion.reduce((sum, value) => sum + value * value, 0));
  if (norm < 1e-9 || quaternion.some((value) => !Number.isFinite(value))) {
    return IDENTITY_QUATERNION;
  }
  return Object.freeze([quaternion[0] / norm, quaternion[1] / norm, quaternion[2] / norm, quaternion[3] / norm] as const);
}

function finiteVector(vector: Vector3, issues: ValidationIssue[], path: string): Vector3 {
  if (vector.length !== 3 || vector.some((value) => !Number.isFinite(value))) {
    issues.push(makeIssue("error", "IMURangeExceeded", path, "Vector3 must contain three finite values.", "Provide finite body motion values."));
    return ZERO_VECTOR;
  }
  return freezeVector(vector);
}

function freezeVector(vector: Vector3): Vector3 {
  return Object.freeze([vector[0], vector[1], vector[2]] as const);
}

function vectorMagnitude(vector: Vector3): number {
  return Math.sqrt(vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2]);
}

function finiteOrIssue(value: number, issues: ValidationIssue[], path: string, code: AdapterIssueCode): number {
  if (!Number.isFinite(value)) {
    issues.push(makeIssue("error", code, path, "Numeric value must be finite.", "Replace NaN or infinite runtime values before packetization."));
    return 0;
  }
  return value;
}

function assertPositiveFinite(value: number, fieldName: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new VirtualHardwareAdapterError("Virtual hardware adapter configuration is invalid.", [
      makeIssue("error", "TimestampInvalid", `$.${fieldName}`, `${fieldName} must be finite and positive.`, "Provide a positive finite configuration value."),
    ]);
  }
  return value;
}

function isCognitiveRoute(sensor: VirtualSensorDescriptor): boolean {
  return sensor.cognitive_route === "prompt_allowed" || sensor.cognitive_route === "sensor_bus_only";
}

function isCameraSensor(sensor: VirtualSensorDescriptor): sensor is CameraSensorDescriptor {
  return sensor.sensor_class === "rgb_camera" || sensor.sensor_class === "depth_camera" || sensor.sensor_class === "stereo_camera";
}

function isMicrophoneSensor(sensor: VirtualSensorDescriptor): sensor is MicrophoneArrayDescriptor {
  return sensor.sensor_class === "microphone_array";
}

function isJointEncoder(sensor: VirtualSensorDescriptor): sensor is JointEncoderDescriptor {
  return sensor.sensor_class === "joint_encoder";
}

function isContactSensor(sensor: VirtualSensorDescriptor): sensor is ContactSensorDescriptor {
  return sensor.sensor_class === "contact_sensor" || sensor.sensor_class === "force_torque";
}

function isImuSensor(sensor: VirtualSensorDescriptor): sensor is ImuSensorDescriptor {
  return sensor.sensor_class === "imu";
}

function isActuatorFeedbackSensor(sensor: VirtualSensorDescriptor): sensor is ActuatorFeedbackSensorDescriptor {
  return sensor.sensor_class === "actuator_feedback";
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function makeIssue(severity: ValidationSeverity, code: AdapterIssueCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

export const VIRTUAL_HARDWARE_ADAPTER_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: VIRTUAL_HARDWARE_MANIFEST_REGISTRY_SCHEMA_VERSION,
  adapter_schema_version: VIRTUAL_HARDWARE_ADAPTER_SCHEMA_VERSION,
  blueprint: "architecture_docs/04_VIRTUAL_HARDWARE_SENSOR_ACTUATOR_SPEC.md",
  sections: freezeArray(["4.14", "4.15.2", "4.15.3", "4.15.4", "4.15.5", "4.15.6", "4.16", "4.17", "4.18"]),
});
