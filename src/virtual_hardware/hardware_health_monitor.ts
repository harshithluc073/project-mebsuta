/**
 * Hardware health monitor for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/04_VIRTUAL_HARDWARE_SENSOR_ACTUATOR_SPEC.md`
 * sections 4.3, 4.11.4, 4.13, 4.16.3, 4.17, and 4.18.
 *
 * This monitor aggregates declared virtual hardware degradation into explicit,
 * replayable reports for orchestration, Oops Loop, verification, QA, and
 * safety. It names missing frames, dropped audio, encoder saturation, contact
 * noise, IMU drift, actuator saturation, and safe-hold triggers without
 * leaking simulator truth, backend object refs, or QA success state.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { ActuatorFeedbackPacket as SimulationActuatorFeedbackPacket, SaturationFlag } from "../simulation/actuator_application_gateway";
import type { Quaternion, Ref, ValidationIssue, ValidationSeverity, Vector3 } from "../simulation/world_manifest";
import type { HardwareActuatorCommandApplicationReport } from "./actuator_command_gateway";
import type {
  ActuatorFeedbackHardwarePacket,
  ContactPacket,
  HardwareTimestampInterval,
  IMUPacket,
  ProprioceptionPacket,
  VirtualHardwarePacket,
} from "./virtual_hardware_adapter";
import {
  VIRTUAL_HARDWARE_MANIFEST_REGISTRY_SCHEMA_VERSION,
  VirtualHardwareManifestRegistry,
} from "./virtual_hardware_manifest_registry";
import type {
  ActuatorDescriptor,
  ContactSensorDescriptor,
  HardwareHealthStatus,
  VirtualHardwareManifest,
} from "./virtual_hardware_manifest_registry";
import type {
  MissingSensorRecord,
  ObservationBundle,
  SensorBusRecommendedAction,
  StalePacketRecord,
} from "./sensor_bus";

export const HARDWARE_HEALTH_MONITOR_SCHEMA_VERSION = "mebsuta.hardware_health_monitor.v1" as const;

const DEFAULT_SYNC_SPREAD_WARNING_MS = 33.334;
const DEFAULT_ENCODER_POSITION_MARGIN_FRACTION = 0.005;
const DEFAULT_ENCODER_VELOCITY_LIMIT_RATIO = 0.98;
const DEFAULT_ENCODER_EFFORT_LIMIT_RATIO = 0.98;
const DEFAULT_CONTACT_NOISE_WARNING_COUNT = 1;
const DEFAULT_CONTACT_NOISE_SAFE_HOLD_COUNT = 4;
const DEFAULT_IMU_ORIENTATION_DRIFT_WARNING_DEG = 4;
const DEFAULT_IMU_ORIENTATION_DRIFT_SAFE_HOLD_DEG = 12;
const DEFAULT_IMU_ANGULAR_DRIFT_RAD_PER_S = 2.5;
const DEFAULT_IMU_LINEAR_BIAS_M_PER_S2 = 3;
const DEFAULT_ACTUATOR_LATENCY_WARNING_MS = 40;
const DEFAULT_ACTUATOR_LATENCY_SAFE_HOLD_MS = 100;

export type HardwareHealthStatusSummary = "nominal" | "degraded" | "blocked" | "safe_hold_required";
export type HardwareHealthSeverity = "info" | "warning" | "high" | "critical";
export type HardwareHealthAction = "continue" | "re_capture" | "re_observe" | "safe_hold" | "human_review" | "qa_review";
export type HardwareHealthDownstreamRoute = "orchestration" | "oops_loop" | "verification" | "replay" | "qa";

export type HardwareHealthFailureMode =
  | "missing_frame"
  | "dropped_audio"
  | "encoder_saturation"
  | "contact_noise"
  | "imu_drift"
  | "actuator_saturation"
  | "safe_hold_trigger"
  | "sensor_desynchronization"
  | "packet_blocked"
  | "packet_stale"
  | "hardware_degraded";

export type HardwareHealthIssueCode =
  | "ManifestMismatch"
  | "HealthReportMissing"
  | "MissingFrame"
  | "DroppedAudio"
  | "EncoderSaturation"
  | "ContactNoise"
  | "IMUDrift"
  | "ActuatorSaturation"
  | "SafeHoldTriggered"
  | "SensorDesynchronization"
  | "PacketBlocked"
  | "PacketStale"
  | "HardwareDegraded"
  | "RuntimeMetricInvalid"
  | "PolicyInvalid";

/**
 * Thresholds that turn packet and command telemetry into deterministic
 * diagnostic severity, action, and safe-hold decisions.
 */
export interface HardwareHealthPolicy {
  readonly synchronization_spread_warning_ms: number;
  readonly encoder_position_limit_margin_fraction: number;
  readonly encoder_velocity_limit_ratio: number;
  readonly encoder_effort_limit_ratio: number;
  readonly contact_noise_warning_count: number;
  readonly contact_noise_safe_hold_count: number;
  readonly imu_orientation_drift_warning_deg: number;
  readonly imu_orientation_drift_safe_hold_deg: number;
  readonly imu_angular_drift_rad_per_s: number;
  readonly imu_linear_bias_m_per_s2: number;
  readonly actuator_latency_warning_ms: number;
  readonly actuator_latency_safe_hold_ms: number;
  readonly safe_hold_on_blocked_imu_or_feedback: boolean;
  readonly safe_hold_on_actuator_saturation: boolean;
  readonly safe_hold_on_command_safe_hold_feedback: boolean;
}

/**
 * Explicit external degradation event for hardware faults that originate
 * outside a packet, such as a driver-level audio drop counter.
 */
export interface HardwareDegradationEvent {
  readonly event_ref: Ref;
  readonly source_ref: Ref;
  readonly event_kind: HardwareHealthFailureMode;
  readonly timestamp_s: number;
  readonly severity: HardwareHealthSeverity;
  readonly metric_value: number;
  readonly threshold: number;
  readonly message: string;
  readonly recommended_action: HardwareHealthAction;
  readonly safe_hold_required: boolean;
}

/**
 * IMU drift observation produced by calibration or state-estimation code.
 */
export interface ImuDriftObservation {
  readonly observation_ref: Ref;
  readonly imu_sensor_ref: Ref;
  readonly timestamp_s: number;
  readonly orientation_delta_deg?: number;
  readonly angular_bias_rad_per_s?: Vector3;
  readonly linear_bias_m_per_s2?: Vector3;
}

export interface HardwareHealthMonitorConfig {
  readonly registry: VirtualHardwareManifestRegistry;
  readonly manifest_id: Ref;
  readonly policy?: Partial<HardwareHealthPolicy>;
}

export interface HardwareHealthMonitorInput {
  readonly observation_bundle?: ObservationBundle;
  readonly packets?: readonly VirtualHardwarePacket[];
  readonly actuator_application_reports?: readonly HardwareActuatorCommandApplicationReport[];
  readonly degradation_events?: readonly HardwareDegradationEvent[];
  readonly imu_drift_observations?: readonly ImuDriftObservation[];
  readonly previous_imu_packets?: readonly IMUPacket[];
  readonly policy?: Partial<HardwareHealthPolicy>;
}

export interface HardwareHealthMetricSnapshot {
  readonly missing_frame_count: number;
  readonly dropped_audio_count: number;
  readonly encoder_saturation_count: number;
  readonly contact_noise_count: number;
  readonly imu_drift_count: number;
  readonly actuator_saturation_count: number;
  readonly safe_hold_trigger_count: number;
  readonly stale_packet_count: number;
  readonly blocked_packet_count: number;
  readonly synchronization_spread_ms: number;
  readonly determinism_hash: string;
}

export interface HardwareHealthMetricEvidence {
  readonly metric_name: string;
  readonly observed_value: number;
  readonly threshold_value: number;
  readonly unit: "count" | "ms" | "ratio" | "deg" | "rad_per_s" | "m_per_s2" | "n" | "hardware_status";
}

export interface HardwareHealthDiagnostic {
  readonly diagnostic_id: Ref;
  readonly failure_mode: HardwareHealthFailureMode;
  readonly severity: HardwareHealthSeverity;
  readonly issue_code: HardwareHealthIssueCode;
  readonly source_ref: Ref;
  readonly affected_hardware_refs: readonly Ref[];
  readonly observed_status: HardwareHealthStatus | "actuator_saturated" | "safe_hold_required";
  readonly metric: HardwareHealthMetricEvidence;
  readonly message: string;
  readonly recommended_action: HardwareHealthAction;
  readonly safe_hold_required: boolean;
  readonly downstream_routes: readonly HardwareHealthDownstreamRoute[];
  readonly determinism_hash: string;
}

export interface HardwareSafeHoldTrigger {
  readonly trigger_ref: Ref;
  readonly source_diagnostic_ref: Ref;
  readonly source_ref: Ref;
  readonly failure_mode: HardwareHealthFailureMode;
  readonly reason: string;
  readonly recommended_action: "freeze_control" | "recapture_evidence" | "quarantine_packet" | "qa_review" | "human_review";
  readonly determinism_hash: string;
}

export interface HardwareHealthReport {
  readonly schema_version: typeof HARDWARE_HEALTH_MONITOR_SCHEMA_VERSION;
  readonly report_ref: Ref;
  readonly manifest_id: Ref;
  readonly observation_bundle_ref?: Ref;
  readonly timestamp_interval: HardwareTimestampInterval;
  readonly health_status: HardwareHealthStatusSummary;
  readonly metric_snapshot: HardwareHealthMetricSnapshot;
  readonly diagnostics: readonly HardwareHealthDiagnostic[];
  readonly safe_hold_triggers: readonly HardwareSafeHoldTrigger[];
  readonly recommended_action: HardwareHealthAction;
  readonly issue_count: number;
  readonly issues: readonly ValidationIssue[];
  readonly cognitive_visibility: "hardware_health_summary_only";
  readonly determinism_hash: string;
}

export interface CognitiveSafeHardwareHealthSummary {
  readonly health_status: HardwareHealthStatusSummary;
  readonly safe_hold_required: boolean;
  readonly recommended_action: HardwareHealthAction;
  readonly prompt_safe_summary: string;
  readonly degraded_hardware_refs: readonly Ref[];
  readonly hidden_fields_removed: readonly string[];
}

export class HardwareHealthMonitorError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "HardwareHealthMonitorError";
    this.issues = issues;
  }
}

/**
 * Aggregates virtual hardware health across sensor-bus, adapter, and actuator
 * command gateway outputs.
 */
export class HardwareHealthMonitor {
  private readonly manifest: VirtualHardwareManifest;
  private readonly defaultPolicy: HardwareHealthPolicy;

  public constructor(private readonly config: HardwareHealthMonitorConfig) {
    this.manifest = config.registry.requireManifest(config.manifest_id);
    this.defaultPolicy = mergePolicy(config.policy ?? {});
    validatePolicy(this.defaultPolicy);
  }

  /**
   * Produces a deterministic hardware health report for one observation window.
   */
  public evaluateHardwareHealth(input: HardwareHealthMonitorInput): HardwareHealthReport {
    const policy = mergePolicy({ ...this.defaultPolicy, ...(input.policy ?? {}) });
    validatePolicy(policy);
    const packets = freezeArray(input.packets ?? []);
    const issues = validateInput(this.config.manifest_id, input, packets);
    const diagnostics = [
      ...this.evaluateObservationBundle(input.observation_bundle, policy, issues),
      ...this.evaluatePacketLevelHealth(packets, policy),
      ...this.evaluateDroppedAudio(input.observation_bundle, packets, policy),
      ...this.evaluateEncoderSaturation(packets, policy),
      ...this.evaluateContactNoise(packets, policy),
      ...this.evaluateImuDrift(packets, input.previous_imu_packets ?? [], input.imu_drift_observations ?? [], policy),
      ...this.evaluateActuatorSaturation(packets, input.actuator_application_reports ?? [], policy),
      ...(input.degradation_events ?? []).map((event) => diagnosticFromEvent(event)),
    ].sort(compareDiagnostics);
    const uniqueDiagnostics = deduplicateDiagnostics(diagnostics);
    const safeHoldTriggers = uniqueDiagnostics.filter((diagnosticItem) => diagnosticItem.safe_hold_required).map(createSafeHoldTrigger);
    const interval = resolveInterval(input.observation_bundle, packets);
    const metricSnapshot = buildMetricSnapshot(uniqueDiagnostics, input.observation_bundle);
    const healthStatus = classifyReportStatus(uniqueDiagnostics, issues);
    const recommendedAction = recommendReportAction(uniqueDiagnostics, input.observation_bundle?.recommended_action);
    const reportBase = {
      schema_version: HARDWARE_HEALTH_MONITOR_SCHEMA_VERSION,
      report_ref: `hardware_health_${this.config.manifest_id}_${Math.round(interval.start_s * 1000)}_${Math.round(interval.end_s * 1000)}`,
      manifest_id: this.config.manifest_id,
      observation_bundle_ref: input.observation_bundle?.bundle_id,
      timestamp_interval: interval,
      health_status: healthStatus,
      metric_snapshot: metricSnapshot,
      diagnostics: freezeArray(uniqueDiagnostics),
      safe_hold_triggers: freezeArray(safeHoldTriggers),
      recommended_action: recommendedAction,
      issue_count: issues.length,
      issues: freezeArray(issues),
      cognitive_visibility: "hardware_health_summary_only" as const,
    };
    return Object.freeze({
      ...reportBase,
      determinism_hash: computeDeterminismHash(reportBase),
    });
  }

  /**
   * Throws when the report requires immediate control freeze.
   */
  public assertNoSafeHold(report: HardwareHealthReport): void {
    if (report.health_status === "safe_hold_required" || report.safe_hold_triggers.length > 0) {
      throw new HardwareHealthMonitorError("Hardware health monitor requested safe-hold.", report.issues);
    }
  }

  /**
   * Redacts report internals into a prompt-safe operational hint.
   */
  public redactForCognition(report: HardwareHealthReport): CognitiveSafeHardwareHealthSummary {
    const degradedHardwareRefs = [...new Set(report.diagnostics.flatMap((diagnosticItem) => diagnosticItem.affected_hardware_refs))].sort();
    return Object.freeze({
      health_status: report.health_status,
      safe_hold_required: report.safe_hold_triggers.length > 0,
      recommended_action: report.recommended_action,
      prompt_safe_summary: promptSafeSummary(report),
      degraded_hardware_refs: freezeArray(degradedHardwareRefs),
      hidden_fields_removed: freezeArray([
        "determinism_hash",
        "metric_snapshot",
        "source_diagnostic_ref",
        "exact_latency_ms",
        "exact_force_n",
        "raw_encoder_values",
        "backend_source_refs",
        "qa_success_state",
      ]),
    });
  }

  private evaluateObservationBundle(
    bundle: ObservationBundle | undefined,
    policy: HardwareHealthPolicy,
    issues: ValidationIssue[],
  ): readonly HardwareHealthDiagnostic[] {
    if (bundle === undefined) {
      issues.push(makeIssue("warning", "HealthReportMissing", "$.observation_bundle", "No observation bundle was supplied to the hardware health monitor.", "Supply a SensorBus observation bundle when one is available."));
      return freezeArray([]);
    }
    const diagnostics: HardwareHealthDiagnostic[] = [];
    if (bundle.manifest_id !== this.config.manifest_id) {
      issues.push(makeIssue("error", "ManifestMismatch", "$.observation_bundle.manifest_id", `Observation bundle manifest ${bundle.manifest_id} does not match monitor manifest ${this.config.manifest_id}.`, "Route the bundle to a monitor configured for the same manifest."));
    }
    for (const missing of bundle.sensor_health_report.missing_sensors) {
      diagnostics.push(this.diagnosticForMissingSensor(missing));
    }
    for (const stale of bundle.sensor_health_report.stale_packets) {
      diagnostics.push(diagnostic({
        failure_mode: "packet_stale",
        severity: "warning",
        issue_code: "PacketStale",
        source_ref: stale.packet_ref,
        affected_hardware_refs: [stale.sensor_ref],
        observed_status: "stale",
        metric_name: "packet_age_ms",
        observed_value: stale.age_ms,
        threshold_value: stale.stale_after_ms,
        unit: "ms",
        message: `Packet ${stale.packet_ref} is stale for sensor ${stale.sensor_ref}.`,
        recommended_action: "re_capture",
        safe_hold_required: false,
        downstream_routes: ["orchestration", "oops_loop", "verification", "replay", "qa"],
      }));
    }
    for (const blockedPacketRef of bundle.sensor_health_report.blocked_packets) {
      const record = bundle.packet_records.find((candidate) => candidate.packet_ref === blockedPacketRef);
      const safeHold = policy.safe_hold_on_blocked_imu_or_feedback && (record?.packet_kind === "imu" || record?.packet_kind === "actuator_feedback");
      diagnostics.push(diagnostic({
        failure_mode: "packet_blocked",
        severity: safeHold ? "critical" : "high",
        issue_code: "PacketBlocked",
        source_ref: blockedPacketRef,
        affected_hardware_refs: [record?.sensor_ref ?? blockedPacketRef],
        observed_status: "blocked",
        metric_name: "blocked_packet_count",
        observed_value: 1,
        threshold_value: 0,
        unit: "count",
        message: `Packet ${blockedPacketRef} is blocked by virtual hardware health routing.`,
        recommended_action: safeHold ? "safe_hold" : "human_review",
        safe_hold_required: safeHold,
        downstream_routes: ["orchestration", "verification", "replay", "qa"],
      }));
    }
    for (const degraded of bundle.sensor_health_report.degraded_sensors) {
      diagnostics.push(diagnostic({
        failure_mode: "hardware_degraded",
        severity: "warning",
        issue_code: "HardwareDegraded",
        source_ref: degraded.packet_refs[0] ?? degraded.sensor_ref,
        affected_hardware_refs: [degraded.sensor_ref],
        observed_status: "degraded",
        metric_name: "degraded_sensor_count",
        observed_value: 1,
        threshold_value: 0,
        unit: "count",
        message: `Sensor ${degraded.sensor_ref} is degraded: ${degraded.reason}.`,
        recommended_action: "re_observe",
        safe_hold_required: false,
        downstream_routes: ["orchestration", "oops_loop", "verification", "replay", "qa"],
      }));
    }
    if (bundle.sensor_health_report.synchronization_spread_ms > policy.synchronization_spread_warning_ms) {
      diagnostics.push(diagnostic({
        failure_mode: "sensor_desynchronization",
        severity: "warning",
        issue_code: "SensorDesynchronization",
        source_ref: bundle.sensor_health_report.sensor_health_report_id,
        affected_hardware_refs: bundle.packet_records.map((record) => record.sensor_ref),
        observed_status: "degraded",
        metric_name: "synchronization_spread_ms",
        observed_value: bundle.sensor_health_report.synchronization_spread_ms,
        threshold_value: policy.synchronization_spread_warning_ms,
        unit: "ms",
        message: "Observation bundle sensor timestamps exceed the configured synchronization spread.",
        recommended_action: "re_capture",
        safe_hold_required: false,
        downstream_routes: ["orchestration", "oops_loop", "verification", "replay", "qa"],
      }));
    }
    return freezeArray(diagnostics);
  }

  private diagnosticForMissingSensor(missing: MissingSensorRecord): HardwareHealthDiagnostic {
    const isCamera = missing.expected_packet_kind === "camera";
    const isAudio = missing.expected_packet_kind === "audio" || missing.sensor_class === "microphone_array";
    return diagnostic({
      failure_mode: isCamera ? "missing_frame" : isAudio ? "dropped_audio" : "hardware_degraded",
      severity: isCamera ? "high" : "warning",
      issue_code: isCamera ? "MissingFrame" : isAudio ? "DroppedAudio" : "HardwareDegraded",
      source_ref: missing.sensor_ref,
      affected_hardware_refs: [missing.sensor_ref],
      observed_status: "missing",
      metric_name: isCamera ? "missing_frame_count" : isAudio ? "dropped_audio_count" : "missing_sensor_count",
      observed_value: 1,
      threshold_value: 0,
      unit: "count",
      message: `Expected hardware evidence from ${missing.sensor_ref} is absent.`,
      recommended_action: mapSensorBusAction(missing.recommended_action),
      safe_hold_required: false,
      downstream_routes: ["orchestration", "oops_loop", "verification", "replay", "qa"],
    });
  }

  private evaluatePacketLevelHealth(packets: readonly VirtualHardwarePacket[], policy: HardwareHealthPolicy): readonly HardwareHealthDiagnostic[] {
    const diagnostics: HardwareHealthDiagnostic[] = [];
    for (const packet of packets) {
      if (packet.packet_status === "blocked" || packet.health_status === "blocked") {
        const safeHold = policy.safe_hold_on_blocked_imu_or_feedback && (packet.packet_kind === "imu" || packet.packet_kind === "actuator_feedback");
        diagnostics.push(diagnostic({
          failure_mode: "packet_blocked",
          severity: safeHold ? "critical" : "high",
          issue_code: "PacketBlocked",
          source_ref: packet.packet_id,
          affected_hardware_refs: [packet.sensor_id],
          observed_status: "blocked",
          metric_name: "blocked_packet_count",
          observed_value: 1,
          threshold_value: 0,
          unit: "count",
          message: `Packet ${packet.packet_id} is blocked and cannot be treated as reliable hardware evidence.`,
          recommended_action: safeHold ? "safe_hold" : "human_review",
          safe_hold_required: safeHold,
          downstream_routes: ["orchestration", "verification", "replay", "qa"],
        }));
      } else if (packet.packet_status === "degraded" || packet.health_status === "degraded") {
        diagnostics.push(diagnostic({
          failure_mode: "hardware_degraded",
          severity: "warning",
          issue_code: "HardwareDegraded",
          source_ref: packet.packet_id,
          affected_hardware_refs: [packet.sensor_id],
          observed_status: "degraded",
          metric_name: "packet_confidence",
          observed_value: packet.confidence,
          threshold_value: 1,
          unit: "ratio",
          message: `Packet ${packet.packet_id} is degraded and must carry uncertainty downstream.`,
          recommended_action: "re_observe",
          safe_hold_required: false,
          downstream_routes: ["orchestration", "oops_loop", "verification", "replay", "qa"],
        }));
      }
    }
    return freezeArray(diagnostics);
  }

  private evaluateDroppedAudio(
    bundle: ObservationBundle | undefined,
    packets: readonly VirtualHardwarePacket[],
    _policy: HardwareHealthPolicy,
  ): readonly HardwareHealthDiagnostic[] {
    const microphoneSensors = this.manifest.sensor_inventory.filter((sensor) => sensor.sensor_class === "microphone_array" && sensor.cognitive_route !== "blocked" && sensor.cognitive_route !== "qa_only");
    if (microphoneSensors.length === 0) {
      return freezeArray([]);
    }
    const audioPacketRefs = new Set([
      ...(bundle?.audio_packets ?? []),
      ...packets.filter((packet) => packet.packet_kind === "audio" && packet.packet_status !== "blocked").map((packet) => packet.packet_id),
    ]);
    if (audioPacketRefs.size > 0) {
      return freezeArray([]);
    }
    return freezeArray(microphoneSensors.map((sensor) => diagnostic({
      failure_mode: "dropped_audio",
      severity: "warning",
      issue_code: "DroppedAudio",
      source_ref: sensor.sensor_id,
      affected_hardware_refs: [sensor.sensor_id],
      observed_status: "missing",
      metric_name: "dropped_audio_count",
      observed_value: 1,
      threshold_value: 0,
      unit: "count",
      message: `Declared microphone array ${sensor.sensor_id} produced no audio packet in the observation window.`,
      recommended_action: "re_capture",
      safe_hold_required: false,
      downstream_routes: ["orchestration", "oops_loop", "verification", "replay", "qa"],
    })));
  }

  private evaluateEncoderSaturation(packets: readonly VirtualHardwarePacket[], policy: HardwareHealthPolicy): readonly HardwareHealthDiagnostic[] {
    const actuatorByJoint = new Map<Ref, ActuatorDescriptor>();
    for (const actuator of this.manifest.actuator_inventory) {
      actuatorByJoint.set(actuator.target_ref, actuator);
    }
    const diagnostics: HardwareHealthDiagnostic[] = [];
    for (const packet of packets.filter(isProprioceptionPacket)) {
      for (const reading of packet.encoder_readings) {
        const actuator = actuatorByJoint.get(reading.joint_ref);
        if (actuator === undefined) {
          continue;
        }
        diagnostics.push(...encoderDiagnostics(packet.packet_id, reading.encoder_sensor_id, reading.joint_ref, actuator, reading.position, reading.velocity, reading.effort, policy));
      }
    }
    return freezeArray(diagnostics);
  }

  private evaluateContactNoise(packets: readonly VirtualHardwarePacket[], policy: HardwareHealthPolicy): readonly HardwareHealthDiagnostic[] {
    const contactSensorBySite = new Map<Ref, ContactSensorDescriptor>();
    for (const sensor of this.manifest.sensor_inventory) {
      if (sensor.sensor_class === "contact_sensor" || sensor.sensor_class === "force_torque") {
        contactSensorBySite.set(sensor.contact_site_ref, sensor);
      }
    }
    const diagnostics: HardwareHealthDiagnostic[] = [];
    for (const packet of packets.filter(isContactPacket)) {
      if (packet.noisy_contact_count >= policy.contact_noise_warning_count) {
        diagnostics.push(diagnostic({
          failure_mode: "contact_noise",
          severity: packet.noisy_contact_count >= policy.contact_noise_safe_hold_count ? "high" : "warning",
          issue_code: "ContactNoise",
          source_ref: packet.packet_id,
          affected_hardware_refs: packet.contact_readings.map((reading) => reading.contact_sensor_id),
          observed_status: "degraded",
          metric_name: "noisy_contact_count",
          observed_value: packet.noisy_contact_count,
          threshold_value: policy.contact_noise_warning_count,
          unit: "count",
          message: "Contact packet includes noisy tactile readings that can reduce grasp or collision certainty.",
          recommended_action: packet.noisy_contact_count >= policy.contact_noise_safe_hold_count ? "safe_hold" : "re_observe",
          safe_hold_required: packet.noisy_contact_count >= policy.contact_noise_safe_hold_count,
          downstream_routes: ["orchestration", "oops_loop", "verification", "replay", "qa"],
        }));
      }
      for (const reading of packet.contact_readings) {
        const sensor = contactSensorBySite.get(reading.contact_site_ref);
        if (sensor === undefined) {
          continue;
        }
        const forceMagnitude = Math.hypot(reading.normal_force_n, reading.tangential_force_n);
        if (forceMagnitude > sensor.max_force_n) {
          diagnostics.push(diagnostic({
            failure_mode: "contact_noise",
            severity: "high",
            issue_code: "ContactNoise",
            source_ref: reading.contact_event_id,
            affected_hardware_refs: [reading.contact_sensor_id],
            observed_status: "degraded",
            metric_name: "contact_force_n",
            observed_value: round6(forceMagnitude),
            threshold_value: sensor.max_force_n,
            unit: "n",
            message: `Contact sensor ${reading.contact_sensor_id} reported force beyond declared tactile range.`,
            recommended_action: "re_observe",
            safe_hold_required: reading.safety_relevance === "safe_hold",
            downstream_routes: ["orchestration", "oops_loop", "verification", "replay", "qa"],
          }));
        }
      }
    }
    return freezeArray(diagnostics);
  }

  private evaluateImuDrift(
    packets: readonly VirtualHardwarePacket[],
    previousImuPackets: readonly IMUPacket[],
    observations: readonly ImuDriftObservation[],
    policy: HardwareHealthPolicy,
  ): readonly HardwareHealthDiagnostic[] {
    const previousBySensor = new Map(previousImuPackets.map((packet) => [packet.sensor_id, packet]));
    const diagnostics: HardwareHealthDiagnostic[] = [];
    for (const packet of packets.filter(isImuPacket)) {
      if (packet.range_saturation.length > 0 || packet.health_status === "degraded" || packet.packet_status === "degraded") {
        diagnostics.push(diagnostic({
          failure_mode: "imu_drift",
          severity: packet.range_saturation.length > 0 ? "high" : "warning",
          issue_code: "IMUDrift",
          source_ref: packet.packet_id,
          affected_hardware_refs: [packet.sensor_id],
          observed_status: "degraded",
          metric_name: "imu_range_saturation_count",
          observed_value: packet.range_saturation.length,
          threshold_value: 0,
          unit: "count",
          message: `IMU packet ${packet.packet_id} reports degraded self-motion or range saturation.`,
          recommended_action: packet.range_saturation.length > 0 ? "safe_hold" : "re_observe",
          safe_hold_required: packet.range_saturation.length > 0,
          downstream_routes: ["orchestration", "oops_loop", "verification", "replay", "qa"],
        }));
      }
      const previous = previousBySensor.get(packet.sensor_id);
      if (previous !== undefined) {
        const driftDeg = quaternionAngleDeg(previous.orientation_xyzw, packet.orientation_xyzw);
        if (driftDeg >= policy.imu_orientation_drift_warning_deg) {
          diagnostics.push(imuDriftDiagnostic(packet.packet_id, packet.sensor_id, "imu_orientation_drift_deg", driftDeg, policy.imu_orientation_drift_warning_deg, driftDeg >= policy.imu_orientation_drift_safe_hold_deg, policy));
        }
      }
    }
    for (const observation of observations) {
      diagnostics.push(...diagnosticsFromImuObservation(observation, policy));
    }
    return freezeArray(diagnostics);
  }

  private evaluateActuatorSaturation(
    packets: readonly VirtualHardwarePacket[],
    reports: readonly HardwareActuatorCommandApplicationReport[],
    policy: HardwareHealthPolicy,
  ): readonly HardwareHealthDiagnostic[] {
    const diagnostics: HardwareHealthDiagnostic[] = [];
    for (const packet of packets.filter(isActuatorFeedbackPacket)) {
      diagnostics.push(...actuatorFeedbackDiagnostics(packet, policy));
    }
    for (const report of reports) {
      if (report.manifest_id !== this.config.manifest_id) {
        diagnostics.push(diagnostic({
          failure_mode: "hardware_degraded",
          severity: "high",
          issue_code: "ManifestMismatch",
          source_ref: report.report_ref,
          affected_hardware_refs: [report.manifest_id],
          observed_status: "degraded",
          metric_name: "manifest_mismatch_count",
          observed_value: 1,
          threshold_value: 0,
          unit: "count",
          message: `Actuator command report ${report.report_ref} belongs to a different hardware manifest.`,
          recommended_action: "human_review",
          safe_hold_required: false,
          downstream_routes: ["orchestration", "replay", "qa"],
        }));
      }
      if (report.safe_hold_required) {
        diagnostics.push(diagnostic({
          failure_mode: "safe_hold_trigger",
          severity: "critical",
          issue_code: "SafeHoldTriggered",
          source_ref: report.report_ref,
          affected_hardware_refs: report.feedback_packets.map((feedback) => feedback.actuator_id),
          observed_status: "safe_hold_required",
          metric_name: "safe_hold_trigger_count",
          observed_value: 1,
          threshold_value: 0,
          unit: "count",
          message: `Actuator command gateway report ${report.report_ref} requested safe-hold.`,
          recommended_action: "safe_hold",
          safe_hold_required: true,
          downstream_routes: ["orchestration", "oops_loop", "verification", "replay", "qa"],
        }));
      }
      for (const feedback of report.feedback_packets) {
        diagnostics.push(...simulationFeedbackDiagnostics(report.report_ref, feedback, policy));
      }
    }
    return freezeArray(diagnostics);
  }
}

export function createHardwareHealthMonitor(config: HardwareHealthMonitorConfig): HardwareHealthMonitor {
  return new HardwareHealthMonitor(config);
}

export function evaluateHardwareHealth(input: HardwareHealthMonitorInput, config: HardwareHealthMonitorConfig): HardwareHealthReport {
  return new HardwareHealthMonitor(config).evaluateHardwareHealth(input);
}

function encoderDiagnostics(
  packetRef: Ref,
  encoderSensorRef: Ref,
  jointRef: Ref,
  actuator: ActuatorDescriptor,
  position: number,
  velocity: number | undefined,
  effort: number | undefined,
  policy: HardwareHealthPolicy,
): readonly HardwareHealthDiagnostic[] {
  const diagnostics: HardwareHealthDiagnostic[] = [];
  const limits = actuator.limit_envelope;
  const range = limits.max_position !== undefined && limits.min_position !== undefined
    ? Math.max(limits.max_position - limits.min_position, 1e-9)
    : undefined;
  const margin = range === undefined ? 0 : range * policy.encoder_position_limit_margin_fraction;
  if (limits.min_position !== undefined && position <= limits.min_position + margin) {
    diagnostics.push(encoderDiagnostic(packetRef, encoderSensorRef, jointRef, "position_min", position, limits.min_position, position < limits.min_position));
  }
  if (limits.max_position !== undefined && position >= limits.max_position - margin) {
    diagnostics.push(encoderDiagnostic(packetRef, encoderSensorRef, jointRef, "position_max", position, limits.max_position, position > limits.max_position));
  }
  if (velocity !== undefined && limits.max_velocity !== undefined) {
    const ratio = Math.abs(velocity) / limits.max_velocity;
    if (ratio >= policy.encoder_velocity_limit_ratio) {
      diagnostics.push(encoderDiagnostic(packetRef, encoderSensorRef, jointRef, "velocity", ratio, policy.encoder_velocity_limit_ratio, ratio > 1));
    }
  }
  if (effort !== undefined && limits.max_effort !== undefined) {
    const ratio = Math.abs(effort) / limits.max_effort;
    if (ratio >= policy.encoder_effort_limit_ratio) {
      diagnostics.push(encoderDiagnostic(packetRef, encoderSensorRef, jointRef, "effort", ratio, policy.encoder_effort_limit_ratio, ratio > 1));
    }
  }
  return freezeArray(diagnostics);
}

function encoderDiagnostic(
  packetRef: Ref,
  encoderSensorRef: Ref,
  jointRef: Ref,
  saturationKind: SaturationFlag,
  observedValue: number,
  thresholdValue: number,
  safeHoldRequired: boolean,
): HardwareHealthDiagnostic {
  return diagnostic({
    failure_mode: "encoder_saturation",
    severity: safeHoldRequired ? "high" : "warning",
    issue_code: "EncoderSaturation",
    source_ref: packetRef,
    affected_hardware_refs: [encoderSensorRef, jointRef],
    observed_status: "degraded",
    metric_name: `encoder_${saturationKind}`,
    observed_value: round6(observedValue),
    threshold_value: round6(thresholdValue),
    unit: saturationKind === "position_min" || saturationKind === "position_max" ? "hardware_status" : "ratio",
    message: `Encoder ${encoderSensorRef} is at or beyond its declared ${saturationKind} limit.`,
    recommended_action: safeHoldRequired ? "safe_hold" : "re_observe",
    safe_hold_required: safeHoldRequired,
    downstream_routes: ["orchestration", "oops_loop", "verification", "replay", "qa"],
  });
}

function diagnosticsFromImuObservation(observation: ImuDriftObservation, policy: HardwareHealthPolicy): readonly HardwareHealthDiagnostic[] {
  const diagnostics: HardwareHealthDiagnostic[] = [];
  if (observation.orientation_delta_deg !== undefined && observation.orientation_delta_deg >= policy.imu_orientation_drift_warning_deg) {
    diagnostics.push(imuDriftDiagnostic(observation.observation_ref, observation.imu_sensor_ref, "imu_orientation_drift_deg", observation.orientation_delta_deg, policy.imu_orientation_drift_warning_deg, observation.orientation_delta_deg >= policy.imu_orientation_drift_safe_hold_deg, policy));
  }
  if (observation.angular_bias_rad_per_s !== undefined) {
    const magnitude = vectorMagnitude(observation.angular_bias_rad_per_s);
    if (magnitude >= policy.imu_angular_drift_rad_per_s) {
      diagnostics.push(imuDriftDiagnostic(observation.observation_ref, observation.imu_sensor_ref, "imu_angular_bias_rad_per_s", magnitude, policy.imu_angular_drift_rad_per_s, true, policy));
    }
  }
  if (observation.linear_bias_m_per_s2 !== undefined) {
    const magnitude = vectorMagnitude(observation.linear_bias_m_per_s2);
    if (magnitude >= policy.imu_linear_bias_m_per_s2) {
      diagnostics.push(imuDriftDiagnostic(observation.observation_ref, observation.imu_sensor_ref, "imu_linear_bias_m_per_s2", magnitude, policy.imu_linear_bias_m_per_s2, true, policy));
    }
  }
  return freezeArray(diagnostics);
}

function imuDriftDiagnostic(
  sourceRef: Ref,
  imuSensorRef: Ref,
  metricName: string,
  observedValue: number,
  thresholdValue: number,
  safeHoldRequired: boolean,
  _policy: HardwareHealthPolicy,
): HardwareHealthDiagnostic {
  return diagnostic({
    failure_mode: "imu_drift",
    severity: safeHoldRequired ? "high" : "warning",
    issue_code: "IMUDrift",
    source_ref: sourceRef,
    affected_hardware_refs: [imuSensorRef],
    observed_status: "degraded",
    metric_name: metricName,
    observed_value: round6(observedValue),
    threshold_value: round6(thresholdValue),
    unit: metricName.endsWith("_deg") ? "deg" : metricName.includes("angular") ? "rad_per_s" : "m_per_s2",
    message: `IMU ${imuSensorRef} drift exceeds declared health threshold.`,
    recommended_action: safeHoldRequired ? "safe_hold" : "re_observe",
    safe_hold_required: safeHoldRequired,
    downstream_routes: ["orchestration", "oops_loop", "verification", "replay", "qa"],
  });
}

function actuatorFeedbackDiagnostics(packet: ActuatorFeedbackHardwarePacket, policy: HardwareHealthPolicy): readonly HardwareHealthDiagnostic[] {
  const diagnostics: HardwareHealthDiagnostic[] = [];
  if (packet.saturation_flags.length > 0) {
    diagnostics.push(actuatorSaturationDiagnostic(packet.packet_id, packet.actuator_id, packet.command_ref, packet.saturation_flags, policy));
  }
  if (packet.applied_status === "safe_hold_required" && policy.safe_hold_on_command_safe_hold_feedback) {
    diagnostics.push(safeHoldFeedbackDiagnostic(packet.packet_id, packet.actuator_id, packet.command_ref));
  }
  if (packet.latency_ms >= policy.actuator_latency_warning_ms) {
    diagnostics.push(actuatorLatencyDiagnostic(packet.packet_id, packet.actuator_id, packet.command_ref, packet.latency_ms, policy));
  }
  return freezeArray(diagnostics);
}

function simulationFeedbackDiagnostics(
  reportRef: Ref,
  feedback: SimulationActuatorFeedbackPacket,
  policy: HardwareHealthPolicy,
): readonly HardwareHealthDiagnostic[] {
  const diagnostics: HardwareHealthDiagnostic[] = [];
  if (feedback.saturation_flags.length > 0) {
    diagnostics.push(actuatorSaturationDiagnostic(reportRef, feedback.actuator_id, feedback.command_ref, feedback.saturation_flags, policy));
  }
  if (feedback.applied_status === "safe_hold_required" && policy.safe_hold_on_command_safe_hold_feedback) {
    diagnostics.push(safeHoldFeedbackDiagnostic(reportRef, feedback.actuator_id, feedback.command_ref));
  }
  if (feedback.latency_ms >= policy.actuator_latency_warning_ms) {
    diagnostics.push(actuatorLatencyDiagnostic(reportRef, feedback.actuator_id, feedback.command_ref, feedback.latency_ms, policy));
  }
  return freezeArray(diagnostics);
}

function actuatorSaturationDiagnostic(
  sourceRef: Ref,
  actuatorRef: Ref,
  commandRef: Ref,
  saturationFlags: readonly SaturationFlag[],
  policy: HardwareHealthPolicy,
): HardwareHealthDiagnostic {
  return diagnostic({
    failure_mode: "actuator_saturation",
    severity: policy.safe_hold_on_actuator_saturation ? "high" : "warning",
    issue_code: "ActuatorSaturation",
    source_ref: sourceRef,
    affected_hardware_refs: [actuatorRef, commandRef],
    observed_status: "actuator_saturated",
    metric_name: "actuator_saturation_count",
    observed_value: saturationFlags.length,
    threshold_value: 0,
    unit: "count",
    message: `Actuator ${actuatorRef} reported saturation flags: ${saturationFlags.join(",")}.`,
    recommended_action: policy.safe_hold_on_actuator_saturation ? "safe_hold" : "re_observe",
    safe_hold_required: policy.safe_hold_on_actuator_saturation,
    downstream_routes: ["orchestration", "oops_loop", "verification", "replay", "qa"],
  });
}

function safeHoldFeedbackDiagnostic(sourceRef: Ref, actuatorRef: Ref, commandRef: Ref): HardwareHealthDiagnostic {
  return diagnostic({
    failure_mode: "safe_hold_trigger",
    severity: "critical",
    issue_code: "SafeHoldTriggered",
    source_ref: sourceRef,
    affected_hardware_refs: [actuatorRef, commandRef],
    observed_status: "safe_hold_required",
    metric_name: "safe_hold_feedback_count",
    observed_value: 1,
    threshold_value: 0,
    unit: "count",
    message: `Actuator ${actuatorRef} returned safe-hold feedback for command ${commandRef}.`,
    recommended_action: "safe_hold",
    safe_hold_required: true,
    downstream_routes: ["orchestration", "oops_loop", "verification", "replay", "qa"],
  });
}

function actuatorLatencyDiagnostic(
  sourceRef: Ref,
  actuatorRef: Ref,
  commandRef: Ref,
  latencyMs: number,
  policy: HardwareHealthPolicy,
): HardwareHealthDiagnostic {
  const safeHoldRequired = latencyMs >= policy.actuator_latency_safe_hold_ms;
  return diagnostic({
    failure_mode: "hardware_degraded",
    severity: safeHoldRequired ? "high" : "warning",
    issue_code: "HardwareDegraded",
    source_ref: sourceRef,
    affected_hardware_refs: [actuatorRef, commandRef],
    observed_status: "degraded",
    metric_name: "actuator_latency_ms",
    observed_value: round3(latencyMs),
    threshold_value: safeHoldRequired ? policy.actuator_latency_safe_hold_ms : policy.actuator_latency_warning_ms,
    unit: "ms",
    message: `Actuator ${actuatorRef} command feedback latency exceeds hardware health threshold.`,
    recommended_action: safeHoldRequired ? "safe_hold" : "re_observe",
    safe_hold_required: safeHoldRequired,
    downstream_routes: ["orchestration", "oops_loop", "verification", "replay", "qa"],
  });
}

function diagnosticFromEvent(event: HardwareDegradationEvent): HardwareHealthDiagnostic {
  return diagnostic({
    failure_mode: event.event_kind,
    severity: event.severity,
    issue_code: issueCodeForFailureMode(event.event_kind),
    source_ref: event.event_ref,
    affected_hardware_refs: [event.source_ref],
    observed_status: event.safe_hold_required ? "safe_hold_required" : event.severity === "critical" || event.severity === "high" ? "degraded" : "healthy",
    metric_name: event.event_kind,
    observed_value: event.metric_value,
    threshold_value: event.threshold,
    unit: "count",
    message: event.message,
    recommended_action: event.recommended_action,
    safe_hold_required: event.safe_hold_required,
    downstream_routes: ["orchestration", "oops_loop", "verification", "replay", "qa"],
  });
}

function diagnostic(input: {
  readonly failure_mode: HardwareHealthFailureMode;
  readonly severity: HardwareHealthSeverity;
  readonly issue_code: HardwareHealthIssueCode;
  readonly source_ref: Ref;
  readonly affected_hardware_refs: readonly Ref[];
  readonly observed_status: HardwareHealthDiagnostic["observed_status"];
  readonly metric_name: string;
  readonly observed_value: number;
  readonly threshold_value: number;
  readonly unit: HardwareHealthMetricEvidence["unit"];
  readonly message: string;
  readonly recommended_action: HardwareHealthAction;
  readonly safe_hold_required: boolean;
  readonly downstream_routes: readonly HardwareHealthDownstreamRoute[];
}): HardwareHealthDiagnostic {
  const diagnosticBase = {
    diagnostic_id: `hardware_health_${input.issue_code}_${computeDeterminismHash([input.failure_mode, input.source_ref, input.metric_name, input.observed_value]).slice(0, 12)}`,
    failure_mode: input.failure_mode,
    severity: input.severity,
    issue_code: input.issue_code,
    source_ref: input.source_ref,
    affected_hardware_refs: freezeArray([...new Set(input.affected_hardware_refs)].sort()),
    observed_status: input.observed_status,
    metric: Object.freeze({
      metric_name: input.metric_name,
      observed_value: Number.isFinite(input.observed_value) ? input.observed_value : 0,
      threshold_value: Number.isFinite(input.threshold_value) ? input.threshold_value : 0,
      unit: input.unit,
    }),
    message: input.message,
    recommended_action: input.recommended_action,
    safe_hold_required: input.safe_hold_required,
    downstream_routes: freezeArray(input.downstream_routes),
  };
  return Object.freeze({
    ...diagnosticBase,
    determinism_hash: computeDeterminismHash(diagnosticBase),
  });
}

function createSafeHoldTrigger(source: HardwareHealthDiagnostic): HardwareSafeHoldTrigger {
  const triggerBase = {
    trigger_ref: `hardware_safe_hold_${source.diagnostic_id}`,
    source_diagnostic_ref: source.diagnostic_id,
    source_ref: source.source_ref,
    failure_mode: source.failure_mode,
    reason: source.message,
    recommended_action: safeHoldActionFor(source.failure_mode),
  };
  return Object.freeze({
    ...triggerBase,
    determinism_hash: computeDeterminismHash(triggerBase),
  });
}

function buildMetricSnapshot(diagnostics: readonly HardwareHealthDiagnostic[], bundle: ObservationBundle | undefined): HardwareHealthMetricSnapshot {
  const metricBase = {
    missing_frame_count: countFailure(diagnostics, "missing_frame"),
    dropped_audio_count: countFailure(diagnostics, "dropped_audio"),
    encoder_saturation_count: countFailure(diagnostics, "encoder_saturation"),
    contact_noise_count: countFailure(diagnostics, "contact_noise"),
    imu_drift_count: countFailure(diagnostics, "imu_drift"),
    actuator_saturation_count: countFailure(diagnostics, "actuator_saturation"),
    safe_hold_trigger_count: diagnostics.filter((diagnosticItem) => diagnosticItem.safe_hold_required).length,
    stale_packet_count: countFailure(diagnostics, "packet_stale"),
    blocked_packet_count: countFailure(diagnostics, "packet_blocked"),
    synchronization_spread_ms: round3(bundle?.sensor_health_report.synchronization_spread_ms ?? 0),
  };
  return Object.freeze({
    ...metricBase,
    determinism_hash: computeDeterminismHash(metricBase),
  });
}

function validateInput(manifestId: Ref, input: HardwareHealthMonitorInput, packets: readonly VirtualHardwarePacket[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (input.observation_bundle !== undefined && input.observation_bundle.manifest_id !== manifestId) {
    issues.push(makeIssue("error", "ManifestMismatch", "$.observation_bundle.manifest_id", "Observation bundle manifest does not match monitor manifest.", "Use a monitor with the same hardware manifest."));
  }
  for (const [index, packet] of packets.entries()) {
    if (packet.manifest_id !== manifestId) {
      issues.push(makeIssue("error", "ManifestMismatch", `$.packets[${index}].manifest_id`, `Packet ${packet.packet_id} belongs to manifest ${packet.manifest_id}.`, "Drop packets from other manifests before hardware health evaluation."));
    }
  }
  for (const [index, report] of (input.actuator_application_reports ?? []).entries()) {
    if (report.manifest_id !== manifestId) {
      issues.push(makeIssue("warning", "ManifestMismatch", `$.actuator_application_reports[${index}].manifest_id`, `Actuator report ${report.report_ref} belongs to manifest ${report.manifest_id}.`, "Route actuator reports by manifest."));
    }
  }
  for (const [index, event] of (input.degradation_events ?? []).entries()) {
    if (!Number.isFinite(event.metric_value) || !Number.isFinite(event.threshold) || !Number.isFinite(event.timestamp_s)) {
      issues.push(makeIssue("error", "RuntimeMetricInvalid", `$.degradation_events[${index}]`, `Degradation event ${event.event_ref} contains a non-finite metric or timestamp.`, "Emit finite runtime metrics before health aggregation."));
    }
  }
  return issues;
}

function mergePolicy(input: Partial<HardwareHealthPolicy>): HardwareHealthPolicy {
  return Object.freeze({
    synchronization_spread_warning_ms: input.synchronization_spread_warning_ms ?? DEFAULT_SYNC_SPREAD_WARNING_MS,
    encoder_position_limit_margin_fraction: input.encoder_position_limit_margin_fraction ?? DEFAULT_ENCODER_POSITION_MARGIN_FRACTION,
    encoder_velocity_limit_ratio: input.encoder_velocity_limit_ratio ?? DEFAULT_ENCODER_VELOCITY_LIMIT_RATIO,
    encoder_effort_limit_ratio: input.encoder_effort_limit_ratio ?? DEFAULT_ENCODER_EFFORT_LIMIT_RATIO,
    contact_noise_warning_count: input.contact_noise_warning_count ?? DEFAULT_CONTACT_NOISE_WARNING_COUNT,
    contact_noise_safe_hold_count: input.contact_noise_safe_hold_count ?? DEFAULT_CONTACT_NOISE_SAFE_HOLD_COUNT,
    imu_orientation_drift_warning_deg: input.imu_orientation_drift_warning_deg ?? DEFAULT_IMU_ORIENTATION_DRIFT_WARNING_DEG,
    imu_orientation_drift_safe_hold_deg: input.imu_orientation_drift_safe_hold_deg ?? DEFAULT_IMU_ORIENTATION_DRIFT_SAFE_HOLD_DEG,
    imu_angular_drift_rad_per_s: input.imu_angular_drift_rad_per_s ?? DEFAULT_IMU_ANGULAR_DRIFT_RAD_PER_S,
    imu_linear_bias_m_per_s2: input.imu_linear_bias_m_per_s2 ?? DEFAULT_IMU_LINEAR_BIAS_M_PER_S2,
    actuator_latency_warning_ms: input.actuator_latency_warning_ms ?? DEFAULT_ACTUATOR_LATENCY_WARNING_MS,
    actuator_latency_safe_hold_ms: input.actuator_latency_safe_hold_ms ?? DEFAULT_ACTUATOR_LATENCY_SAFE_HOLD_MS,
    safe_hold_on_blocked_imu_or_feedback: input.safe_hold_on_blocked_imu_or_feedback ?? true,
    safe_hold_on_actuator_saturation: input.safe_hold_on_actuator_saturation ?? true,
    safe_hold_on_command_safe_hold_feedback: input.safe_hold_on_command_safe_hold_feedback ?? true,
  });
}

function validatePolicy(policy: HardwareHealthPolicy): void {
  const issues: ValidationIssue[] = [];
  validateNonNegative(policy.synchronization_spread_warning_ms, issues, "$.policy.synchronization_spread_warning_ms");
  validateRatio(policy.encoder_position_limit_margin_fraction, issues, "$.policy.encoder_position_limit_margin_fraction");
  validateRatio(policy.encoder_velocity_limit_ratio, issues, "$.policy.encoder_velocity_limit_ratio");
  validateRatio(policy.encoder_effort_limit_ratio, issues, "$.policy.encoder_effort_limit_ratio");
  validateNonNegative(policy.contact_noise_warning_count, issues, "$.policy.contact_noise_warning_count");
  validateNonNegative(policy.contact_noise_safe_hold_count, issues, "$.policy.contact_noise_safe_hold_count");
  validateNonNegative(policy.imu_orientation_drift_warning_deg, issues, "$.policy.imu_orientation_drift_warning_deg");
  validateNonNegative(policy.imu_orientation_drift_safe_hold_deg, issues, "$.policy.imu_orientation_drift_safe_hold_deg");
  validateNonNegative(policy.imu_angular_drift_rad_per_s, issues, "$.policy.imu_angular_drift_rad_per_s");
  validateNonNegative(policy.imu_linear_bias_m_per_s2, issues, "$.policy.imu_linear_bias_m_per_s2");
  validateNonNegative(policy.actuator_latency_warning_ms, issues, "$.policy.actuator_latency_warning_ms");
  validateNonNegative(policy.actuator_latency_safe_hold_ms, issues, "$.policy.actuator_latency_safe_hold_ms");
  if (policy.contact_noise_warning_count > policy.contact_noise_safe_hold_count) {
    issues.push(makeIssue("error", "PolicyInvalid", "$.policy", "Contact noise warning threshold cannot exceed safe-hold threshold.", "Raise the safe-hold threshold or lower the warning threshold."));
  }
  if (policy.imu_orientation_drift_warning_deg > policy.imu_orientation_drift_safe_hold_deg) {
    issues.push(makeIssue("error", "PolicyInvalid", "$.policy", "IMU orientation warning threshold cannot exceed safe-hold threshold.", "Raise the safe-hold threshold or lower the warning threshold."));
  }
  if (policy.actuator_latency_warning_ms > policy.actuator_latency_safe_hold_ms) {
    issues.push(makeIssue("error", "PolicyInvalid", "$.policy", "Actuator latency warning threshold cannot exceed safe-hold threshold.", "Raise the safe-hold threshold or lower the warning threshold."));
  }
  if (issues.length > 0) {
    throw new HardwareHealthMonitorError("Hardware health policy failed validation.", issues);
  }
}

function resolveInterval(bundle: ObservationBundle | undefined, packets: readonly VirtualHardwarePacket[]): HardwareTimestampInterval {
  if (bundle !== undefined) {
    return Object.freeze({ start_s: bundle.timestamp_interval.start_s, end_s: bundle.timestamp_interval.end_s });
  }
  if (packets.length === 0) {
    return Object.freeze({ start_s: 0, end_s: 0 });
  }
  return Object.freeze({
    start_s: Math.min(...packets.map((packet) => packet.timestamp_interval.start_s)),
    end_s: Math.max(...packets.map((packet) => packet.timestamp_interval.end_s)),
  });
}

function classifyReportStatus(diagnostics: readonly HardwareHealthDiagnostic[], issues: readonly ValidationIssue[]): HardwareHealthStatusSummary {
  if (diagnostics.some((diagnosticItem) => diagnosticItem.safe_hold_required) || issues.some((issue) => issue.severity === "error")) {
    return "safe_hold_required";
  }
  if (diagnostics.some((diagnosticItem) => diagnosticItem.severity === "critical" || diagnosticItem.severity === "high" || diagnosticItem.failure_mode === "packet_blocked")) {
    return "blocked";
  }
  if (diagnostics.length > 0 || issues.length > 0) {
    return "degraded";
  }
  return "nominal";
}

function recommendReportAction(diagnostics: readonly HardwareHealthDiagnostic[], busAction: SensorBusRecommendedAction | undefined): HardwareHealthAction {
  if (diagnostics.some((diagnosticItem) => diagnosticItem.recommended_action === "safe_hold")) {
    return "safe_hold";
  }
  if (diagnostics.some((diagnosticItem) => diagnosticItem.recommended_action === "human_review")) {
    return "human_review";
  }
  if (diagnostics.some((diagnosticItem) => diagnosticItem.recommended_action === "re_capture")) {
    return "re_capture";
  }
  if (diagnostics.some((diagnosticItem) => diagnosticItem.recommended_action === "re_observe")) {
    return "re_observe";
  }
  return busAction === undefined ? "continue" : mapSensorBusAction(busAction);
}

function promptSafeSummary(report: HardwareHealthReport): string {
  if (report.health_status === "safe_hold_required") {
    return "Virtual hardware health requires safe-hold before continuing.";
  }
  if (report.health_status === "blocked") {
    return "Virtual hardware evidence is blocked or unreliable; request review before using it.";
  }
  if (report.health_status === "degraded") {
    return "Virtual hardware evidence is degraded; continue only with explicit uncertainty.";
  }
  return "Virtual hardware health is nominal.";
}

function safeHoldActionFor(failureMode: HardwareHealthFailureMode): HardwareSafeHoldTrigger["recommended_action"] {
  if (failureMode === "packet_blocked") {
    return "quarantine_packet";
  }
  if (failureMode === "missing_frame" || failureMode === "dropped_audio" || failureMode === "sensor_desynchronization") {
    return "recapture_evidence";
  }
  if (failureMode === "actuator_saturation" || failureMode === "safe_hold_trigger" || failureMode === "encoder_saturation" || failureMode === "imu_drift") {
    return "freeze_control";
  }
  if (failureMode === "contact_noise") {
    return "human_review";
  }
  return "qa_review";
}

function mapSensorBusAction(action: SensorBusRecommendedAction): HardwareHealthAction {
  if (action === "continue") {
    return "continue";
  }
  if (action === "re_capture") {
    return "re_capture";
  }
  if (action === "re_observe") {
    return "re_observe";
  }
  if (action === "safe_hold") {
    return "safe_hold";
  }
  return "human_review";
}

function issueCodeForFailureMode(failureMode: HardwareHealthFailureMode): HardwareHealthIssueCode {
  switch (failureMode) {
    case "missing_frame":
      return "MissingFrame";
    case "dropped_audio":
      return "DroppedAudio";
    case "encoder_saturation":
      return "EncoderSaturation";
    case "contact_noise":
      return "ContactNoise";
    case "imu_drift":
      return "IMUDrift";
    case "actuator_saturation":
      return "ActuatorSaturation";
    case "safe_hold_trigger":
      return "SafeHoldTriggered";
    case "sensor_desynchronization":
      return "SensorDesynchronization";
    case "packet_blocked":
      return "PacketBlocked";
    case "packet_stale":
      return "PacketStale";
    case "hardware_degraded":
      return "HardwareDegraded";
  }
}

function deduplicateDiagnostics(diagnostics: readonly HardwareHealthDiagnostic[]): readonly HardwareHealthDiagnostic[] {
  const byId = new Map<Ref, HardwareHealthDiagnostic>();
  for (const diagnosticItem of diagnostics) {
    byId.set(diagnosticItem.diagnostic_id, diagnosticItem);
  }
  return freezeArray([...byId.values()]);
}

function compareDiagnostics(a: HardwareHealthDiagnostic, b: HardwareHealthDiagnostic): number {
  return severityRank(b.severity) - severityRank(a.severity) || a.diagnostic_id.localeCompare(b.diagnostic_id);
}

function severityRank(severity: HardwareHealthSeverity): number {
  if (severity === "critical") {
    return 4;
  }
  if (severity === "high") {
    return 3;
  }
  if (severity === "warning") {
    return 2;
  }
  return 1;
}

function countFailure(diagnostics: readonly HardwareHealthDiagnostic[], failureMode: HardwareHealthFailureMode): number {
  return diagnostics.filter((diagnosticItem) => diagnosticItem.failure_mode === failureMode).length;
}

function quaternionAngleDeg(a: Quaternion, b: Quaternion): number {
  const an = normalizeQuaternion(a);
  const bn = normalizeQuaternion(b);
  const dot = Math.abs(an[0] * bn[0] + an[1] * bn[1] + an[2] * bn[2] + an[3] * bn[3]);
  return (2 * Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
}

function normalizeQuaternion(value: Quaternion): Quaternion {
  const norm = Math.sqrt(value.reduce((sum, component) => sum + component * component, 0));
  if (norm < 1e-9 || value.some((component) => !Number.isFinite(component))) {
    return Object.freeze([0, 0, 0, 1] as const);
  }
  return Object.freeze([value[0] / norm, value[1] / norm, value[2] / norm, value[3] / norm] as const);
}

function vectorMagnitude(value: Vector3): number {
  return Math.hypot(value[0], value[1], value[2]);
}

function validateNonNegative(value: number, issues: ValidationIssue[], path: string): void {
  if (!Number.isFinite(value) || value < 0) {
    issues.push(makeIssue("error", "PolicyInvalid", path, "Policy value must be finite and nonnegative.", "Use calibrated finite nonnegative thresholds."));
  }
}

function validateRatio(value: number, issues: ValidationIssue[], path: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    issues.push(makeIssue("error", "PolicyInvalid", path, "Policy ratio must be finite and inside [0, 1].", "Use a calibrated ratio between zero and one."));
  }
}

function isProprioceptionPacket(packet: VirtualHardwarePacket): packet is ProprioceptionPacket {
  return packet.packet_kind === "proprioception";
}

function isContactPacket(packet: VirtualHardwarePacket): packet is ContactPacket {
  return packet.packet_kind === "contact";
}

function isImuPacket(packet: VirtualHardwarePacket): packet is IMUPacket {
  return packet.packet_kind === "imu";
}

function isActuatorFeedbackPacket(packet: VirtualHardwarePacket): packet is ActuatorFeedbackHardwarePacket {
  return packet.packet_kind === "actuator_feedback";
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function round6(value: number): number {
  return Math.round(value * 1000000) / 1000000;
}

function makeIssue(severity: ValidationSeverity, code: HardwareHealthIssueCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

export const HARDWARE_HEALTH_MONITOR_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: VIRTUAL_HARDWARE_MANIFEST_REGISTRY_SCHEMA_VERSION,
  hardware_health_monitor_schema_version: HARDWARE_HEALTH_MONITOR_SCHEMA_VERSION,
  blueprint: "architecture_docs/04_VIRTUAL_HARDWARE_SENSOR_ACTUATOR_SPEC.md",
  sections: freezeArray(["4.3", "4.11.4", "4.13", "4.16.3", "4.17", "4.18"]),
});
