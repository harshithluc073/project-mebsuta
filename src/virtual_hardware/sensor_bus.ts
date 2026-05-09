/**
 * Sensor bus for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/04_VIRTUAL_HARDWARE_SENSOR_ACTUATOR_SPEC.md`
 * sections 4.3, 4.4, 4.6, 4.13, 4.15.7, 4.16.1, 4.17, and 4.18.
 *
 * The bus turns candidate virtual hardware packets into synchronized
 * observation bundles. It verifies that packet origins match the active
 * hardware manifest, computes timestamp spread and packet age, represents
 * missing or stale evidence explicitly, aggregates sensor health, preserves
 * replayable packet references, and routes only firewall-eligible packet
 * references toward downstream prompt, verification, Oops Loop, and replay
 * flows.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import type {
  ActuatorFeedbackHardwarePacket,
  AudioPacket,
  CameraPacket,
  ContactPacket,
  HardwareTimestampInterval,
  IMUPacket,
  ProprioceptionPacket,
  VirtualHardwareObservationBatch,
  VirtualHardwarePacket,
  VirtualHardwarePacketKind,
  VirtualHardwarePacketStatus,
} from "./virtual_hardware_adapter";
import { VIRTUAL_HARDWARE_ADAPTER_SCHEMA_VERSION } from "./virtual_hardware_adapter";
import {
  VIRTUAL_HARDWARE_MANIFEST_REGISTRY_SCHEMA_VERSION,
  VirtualHardwareManifestRegistry,
} from "./virtual_hardware_manifest_registry";
import type {
  HardwareHealthStatus,
  SensorClass,
  VirtualHardwareManifest,
  VirtualSensorDescriptor,
} from "./virtual_hardware_manifest_registry";

export const SENSOR_BUS_SCHEMA_VERSION = "mebsuta.sensor_bus.v1" as const;

const DEFAULT_MAX_SYNC_SPREAD_MS = 33.334;
const DEFAULT_MAX_PACKET_AGE_MS = 100;
const DEFAULT_REFERENCE_TIME_EPSILON_S = 1e-9;
const DEFAULT_REQUIRED_SENSOR_CLASSES: readonly SensorClass[] = ["rgb_camera", "joint_encoder"];

export type SensorBusIssueCode =
  | "PacketUndeclared"
  | "PacketManifestMismatch"
  | "PacketSchemaMismatch"
  | "PacketKindMismatch"
  | "TimestampInvalid"
  | "SynchronizationSpreadTooLarge"
  | "PacketStale"
  | "PacketBlocked"
  | "PacketDegraded"
  | "PacketDuplicate"
  | "HealthReportMissing"
  | "ProvenanceMissing"
  | "MissingExpectedSensor"
  | "ObservationBundleDegraded";

export type SensorBusRecommendedAction = "continue" | "re_capture" | "re_observe" | "safe_hold" | "human_review";
export type ObservationBundleStatus = "nominal" | "degraded" | "blocked";
export type SensorBusRoute = "prompt_candidate" | "sensor_bus_only" | "qa_only" | "blocked";

/**
 * Synchronization policy for one observation-bundle assembly pass.
 */
export interface SensorBusSynchronizationPolicy {
  readonly max_synchronization_spread_ms: number;
  readonly max_packet_age_ms: number;
  readonly reference_time_s?: number;
  readonly require_manifest_match: boolean;
  readonly allow_blocked_packets_in_bundle: boolean;
}

/**
 * Health aggregation policy for missing, degraded, stale, and blocked sensors.
 */
export interface SensorBusHealthPolicy {
  readonly required_sensor_classes: readonly SensorClass[];
  readonly require_at_least_one_camera: boolean;
  readonly require_proprioception_when_encoders_declared: boolean;
  readonly require_contact_when_contact_sensors_declared: boolean;
  readonly safe_hold_on_blocked_imu_or_actuator_feedback: boolean;
}

/**
 * Provenance requirements enforced before packets are routed downstream.
 */
export interface SensorBusProvenancePolicy {
  readonly require_packet_provenance: boolean;
  readonly require_calibration_ref: boolean;
  readonly require_determinism_hash: boolean;
  readonly firewall_blocked_field_categories: readonly string[];
}

/**
 * Runtime configuration for SensorBus.
 */
export interface SensorBusConfig {
  readonly registry: VirtualHardwareManifestRegistry;
  readonly manifest_id: Ref;
  readonly synchronization_policy?: Partial<SensorBusSynchronizationPolicy>;
  readonly health_policy?: Partial<SensorBusHealthPolicy>;
  readonly provenance_policy?: Partial<SensorBusProvenancePolicy>;
}

/**
 * A compact record used by the bus to expose packet timing and readiness
 * without embedding the full packet payload.
 */
export interface SensorPacketBusRecord {
  readonly packet_ref: Ref;
  readonly sensor_ref: Ref;
  readonly packet_kind: VirtualHardwarePacketKind;
  readonly timestamp_interval: HardwareTimestampInterval;
  readonly midpoint_s: number;
  readonly age_ms: number;
  readonly readiness: "accepted" | "degraded" | "blocked" | "stale" | "missing";
  readonly health_status: HardwareHealthStatus;
  readonly confidence: number;
  readonly route: SensorBusRoute;
  readonly issue_codes: readonly SensorBusIssueCode[];
  readonly determinism_hash: string;
}

/**
 * Explicit representation of expected hardware evidence that was not present
 * in the candidate packet set.
 */
export interface MissingSensorRecord {
  readonly sensor_ref: Ref;
  readonly sensor_class: SensorClass | "proprioception_bus" | "contact_sensor_bus";
  readonly expected_packet_kind: VirtualHardwarePacketKind;
  readonly reason: "declared_sensor_absent" | "declared_sensor_blocked" | "required_bus_packet_absent";
  readonly recommended_action: SensorBusRecommendedAction;
}

/**
 * Explicit representation of stale packets with computed age.
 */
export interface StalePacketRecord {
  readonly packet_ref: Ref;
  readonly sensor_ref: Ref;
  readonly packet_kind: VirtualHardwarePacketKind;
  readonly age_ms: number;
  readonly stale_after_ms: number;
}

/**
 * Health report required by every observation bundle.
 */
export interface SensorHealthReport {
  readonly schema_version: typeof SENSOR_BUS_SCHEMA_VERSION;
  readonly sensor_health_report_id: Ref;
  readonly timestamp_interval: HardwareTimestampInterval;
  readonly healthy_sensors: readonly Ref[];
  readonly degraded_sensors: readonly {
    readonly sensor_ref: Ref;
    readonly reason: string;
    readonly packet_refs: readonly Ref[];
  }[];
  readonly missing_sensors: readonly MissingSensorRecord[];
  readonly stale_packets: readonly StalePacketRecord[];
  readonly blocked_packets: readonly Ref[];
  readonly synchronization_spread_ms: number;
  readonly firewall_blocked_fields: readonly string[];
  readonly recommended_action: SensorBusRecommendedAction;
  readonly determinism_hash: string;
}

/**
 * Provenance report for firewall and replay systems. It is audit-visible, not
 * prompt-visible as raw simulator state.
 */
export interface SensorBusProvenanceReport {
  readonly provenance_report_ref: Ref;
  readonly manifest_id: Ref;
  readonly packet_provenance_refs: readonly {
    readonly packet_ref: Ref;
    readonly sensor_ref: Ref;
    readonly calibration_ref: Ref;
    readonly synchronization_token_ref?: Ref;
    readonly source_tick: number;
    readonly source_time_s: number;
    readonly provenance_hash: string;
  }[];
  readonly missing_provenance_packet_refs: readonly Ref[];
  readonly determinism_hash: string;
}

/**
 * Synchronized observation bundle consumed by prompt construction,
 * verification, Oops Loop, safety, replay, and the information firewall.
 */
export interface ObservationBundle {
  readonly schema_version: typeof SENSOR_BUS_SCHEMA_VERSION;
  readonly bundle_id: Ref;
  readonly manifest_id: Ref;
  readonly timestamp_interval: HardwareTimestampInterval;
  readonly bundle_status: ObservationBundleStatus;
  readonly camera_packets: readonly Ref[];
  readonly audio_packets: readonly Ref[];
  readonly proprioception_packet?: Ref;
  readonly imu_packets: readonly Ref[];
  readonly contact_packet?: Ref;
  readonly actuator_feedback_packets: readonly Ref[];
  readonly packet_records: readonly SensorPacketBusRecord[];
  readonly sensor_health_report: SensorHealthReport;
  readonly provenance_report: SensorBusProvenanceReport;
  readonly prompt_candidate_packet_refs: readonly Ref[];
  readonly verification_packet_refs: readonly Ref[];
  readonly oops_loop_packet_refs: readonly Ref[];
  readonly replay_packet_refs: readonly Ref[];
  readonly issue_count: number;
  readonly issues: readonly ValidationIssue[];
  readonly recommended_action: SensorBusRecommendedAction;
  readonly determinism_hash: string;
  readonly cognitive_visibility: "firewall_input_observation_bundle";
}

export class SensorBusError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "SensorBusError";
    this.issues = issues;
  }
}

/**
 * Assembles observation bundles from virtual hardware packets.
 */
export class SensorBus {
  private readonly manifest: VirtualHardwareManifest;
  private readonly synchronizationPolicy: SensorBusSynchronizationPolicy;
  private readonly healthPolicy: SensorBusHealthPolicy;
  private readonly provenancePolicy: SensorBusProvenancePolicy;
  private readonly bundles = new Map<Ref, ObservationBundle>();

  public constructor(private readonly config: SensorBusConfig) {
    this.manifest = config.registry.requireManifest(config.manifest_id);
    this.synchronizationPolicy = Object.freeze({
      max_synchronization_spread_ms: config.synchronization_policy?.max_synchronization_spread_ms ?? DEFAULT_MAX_SYNC_SPREAD_MS,
      max_packet_age_ms: config.synchronization_policy?.max_packet_age_ms ?? DEFAULT_MAX_PACKET_AGE_MS,
      reference_time_s: config.synchronization_policy?.reference_time_s,
      require_manifest_match: config.synchronization_policy?.require_manifest_match ?? true,
      allow_blocked_packets_in_bundle: config.synchronization_policy?.allow_blocked_packets_in_bundle ?? true,
    });
    this.healthPolicy = Object.freeze({
      required_sensor_classes: freezeArray(config.health_policy?.required_sensor_classes ?? DEFAULT_REQUIRED_SENSOR_CLASSES),
      require_at_least_one_camera: config.health_policy?.require_at_least_one_camera ?? true,
      require_proprioception_when_encoders_declared: config.health_policy?.require_proprioception_when_encoders_declared ?? true,
      require_contact_when_contact_sensors_declared: config.health_policy?.require_contact_when_contact_sensors_declared ?? false,
      safe_hold_on_blocked_imu_or_actuator_feedback: config.health_policy?.safe_hold_on_blocked_imu_or_actuator_feedback ?? true,
    });
    this.provenancePolicy = Object.freeze({
      require_packet_provenance: config.provenance_policy?.require_packet_provenance ?? true,
      require_calibration_ref: config.provenance_policy?.require_calibration_ref ?? true,
      require_determinism_hash: config.provenance_policy?.require_determinism_hash ?? true,
      firewall_blocked_field_categories: freezeArray(config.provenance_policy?.firewall_blocked_field_categories ?? [
        "backend_object_refs",
        "engine_handles",
        "qa_truth",
        "debug_overlays",
        "hidden_world_coordinates",
      ]),
    });
    assertPositive(this.synchronizationPolicy.max_synchronization_spread_ms, "max_synchronization_spread_ms");
    assertPositive(this.synchronizationPolicy.max_packet_age_ms, "max_packet_age_ms");
  }

  /**
   * Assembles an observation bundle from an adapter-produced batch.
   */
  public assembleFromAdapterBatch(batch: VirtualHardwareObservationBatch): ObservationBundle {
    if (batch.manifest_id !== this.config.manifest_id) {
      const issue = makeIssue("error", "PacketManifestMismatch", "$.manifest_id", `Adapter batch manifest ${batch.manifest_id} does not match sensor bus manifest ${this.config.manifest_id}.`, "Route batches to a bus configured for the same hardware manifest.");
      throw new SensorBusError("Adapter batch manifest mismatch.", [issue]);
    }
    return this.assembleObservationBundle(batch.packets);
  }

  /**
   * Groups candidate camera/audio/proprioception/contact/IMU/feedback packets
   * into a synchronized observation bundle with explicit health and provenance.
   */
  public assembleObservationBundle(sensorPackets: readonly VirtualHardwarePacket[]): ObservationBundle {
    const issues: ValidationIssue[] = [];
    const uniquePackets = this.deduplicatePackets(sensorPackets, issues);
    const referenceTimeS = this.resolveReferenceTime(uniquePackets);
    const packetRecords = uniquePackets.map((packet) => this.validatePacket(packet, referenceTimeS, issues));
    const interval = computeBundleInterval(uniquePackets, referenceTimeS);
    const synchronizationSpreadMs = computeSynchronizationSpreadMs(uniquePackets);
    if (synchronizationSpreadMs > this.synchronizationPolicy.max_synchronization_spread_ms) {
      issues.push(makeIssue("warning", "SynchronizationSpreadTooLarge", "$.timestamp_interval", `Packet spread ${synchronizationSpreadMs.toFixed(3)} ms exceeds policy.`, "Mark the observation degraded or recapture synchronized sensors."));
    }
    const missingSensors = this.computeMissingSensors(uniquePackets, issues);
    const stalePackets = packetRecords
      .filter((record) => record.readiness === "stale")
      .map((record) => Object.freeze({
        packet_ref: record.packet_ref,
        sensor_ref: record.sensor_ref,
        packet_kind: record.packet_kind,
        age_ms: record.age_ms,
        stale_after_ms: this.synchronizationPolicy.max_packet_age_ms,
      }));
    const healthReport = this.buildHealthReport(interval, packetRecords, missingSensors, stalePackets, synchronizationSpreadMs);
    const provenanceReport = this.buildProvenanceReport(uniquePackets, issues);
    const bundleStatus = computeBundleStatus(packetRecords, missingSensors, synchronizationSpreadMs, this.synchronizationPolicy.max_synchronization_spread_ms);
    if (bundleStatus !== "nominal") {
      issues.push(makeIssue(bundleStatus === "blocked" ? "error" : "warning", "ObservationBundleDegraded", "$.bundle_status", `Observation bundle status is ${bundleStatus}.`, "Route the health report with the bundle and let downstream systems decide recapture or safe-hold."));
    }
    const promptCandidateRefs = packetRecords.filter((record) => record.route === "prompt_candidate" && record.readiness === "accepted").map((record) => record.packet_ref);
    const verificationRefs = packetRecords.filter((record) => record.route !== "blocked" && record.readiness !== "blocked").map((record) => record.packet_ref);
    const oopsRefs = packetRecords
      .filter((record) => ["camera", "audio", "contact", "proprioception", "actuator_feedback"].includes(record.packet_kind) && record.readiness !== "blocked")
      .map((record) => record.packet_ref);
    const replayRefs = packetRecords.map((record) => record.packet_ref);
    const bundleId = `observation_bundle_${this.config.manifest_id}_${Math.round(interval.start_s * 1000)}_${Math.round(interval.end_s * 1000)}`;
    const bundle: ObservationBundle = Object.freeze({
      schema_version: SENSOR_BUS_SCHEMA_VERSION,
      bundle_id: bundleId,
      manifest_id: this.config.manifest_id,
      timestamp_interval: interval,
      bundle_status: bundleStatus,
      camera_packets: refsByKind(uniquePackets, "camera"),
      audio_packets: refsByKind(uniquePackets, "audio"),
      proprioception_packet: firstRefByKind(uniquePackets, "proprioception"),
      imu_packets: refsByKind(uniquePackets, "imu"),
      contact_packet: firstRefByKind(uniquePackets, "contact"),
      actuator_feedback_packets: refsByKind(uniquePackets, "actuator_feedback"),
      packet_records: freezeArray(packetRecords),
      sensor_health_report: healthReport,
      provenance_report: provenanceReport,
      prompt_candidate_packet_refs: freezeArray(promptCandidateRefs),
      verification_packet_refs: freezeArray(verificationRefs),
      oops_loop_packet_refs: freezeArray(oopsRefs),
      replay_packet_refs: freezeArray(replayRefs),
      issue_count: issues.length,
      issues: freezeArray(issues),
      recommended_action: healthReport.recommended_action,
      determinism_hash: computeDeterminismHash({
        bundleId,
        manifestId: this.config.manifest_id,
        packetRecords,
        healthReport,
        provenanceReport,
        issues,
      }),
      cognitive_visibility: "firewall_input_observation_bundle",
    });
    this.bundles.set(bundle.bundle_id, bundle);
    return bundle;
  }

  public getBundle(bundleId: Ref): ObservationBundle | undefined {
    return this.bundles.get(bundleId);
  }

  public listBundleIds(): readonly Ref[] {
    return freezeArray([...this.bundles.keys()].sort());
  }

  private deduplicatePackets(packets: readonly VirtualHardwarePacket[], issues: ValidationIssue[]): readonly VirtualHardwarePacket[] {
    const byId = new Map<Ref, VirtualHardwarePacket>();
    for (const packet of packets) {
      if (byId.has(packet.packet_id)) {
        issues.push(makeIssue("warning", "PacketDuplicate", "$.sensorPackets", `Duplicate packet ${packet.packet_id} was ignored.`, "Keep a single packet per packet_id in each observation window."));
        continue;
      }
      byId.set(packet.packet_id, packet);
    }
    return freezeArray([...byId.values()]);
  }

  private resolveReferenceTime(packets: readonly VirtualHardwarePacket[]): number {
    if (this.synchronizationPolicy.reference_time_s !== undefined) {
      return this.synchronizationPolicy.reference_time_s;
    }
    if (packets.length === 0) {
      return 0;
    }
    return Math.max(...packets.map((packet) => packet.timestamp_interval.end_s));
  }

  private validatePacket(packet: VirtualHardwarePacket, referenceTimeS: number, issues: ValidationIssue[]): SensorPacketBusRecord {
    const packetIssues: SensorBusIssueCode[] = [];
    if (packet.schema_version !== VIRTUAL_HARDWARE_ADAPTER_SCHEMA_VERSION) {
      packetIssues.push("PacketSchemaMismatch");
      issues.push(makeIssue("error", "PacketSchemaMismatch", `$.packets.${packet.packet_id}.schema_version`, `Packet ${packet.packet_id} has unsupported adapter schema.`, "Rebuild the packet with the current VirtualHardwareAdapter."));
    }
    if (this.synchronizationPolicy.require_manifest_match && packet.manifest_id !== this.config.manifest_id) {
      packetIssues.push("PacketManifestMismatch");
      issues.push(makeIssue("error", "PacketManifestMismatch", `$.packets.${packet.packet_id}.manifest_id`, `Packet ${packet.packet_id} belongs to manifest ${packet.manifest_id}.`, "Drop packets from other hardware manifests."));
    }
    if (!isFiniteInterval(packet.timestamp_interval)) {
      packetIssues.push("TimestampInvalid");
      issues.push(makeIssue("error", "TimestampInvalid", `$.packets.${packet.packet_id}.timestamp_interval`, `Packet ${packet.packet_id} has invalid timestamps.`, "Provide finite monotonic packet timestamps."));
    }
    if (!this.packetMatchesDeclaredHardware(packet)) {
      packetIssues.push("PacketUndeclared");
      issues.push(makeIssue("error", "PacketUndeclared", `$.packets.${packet.packet_id}.sensor_id`, `Packet ${packet.packet_id} does not map to declared hardware.`, "Declare the hardware channel before routing packet evidence."));
    }
    if (!this.packetKindMatchesSensor(packet)) {
      packetIssues.push("PacketKindMismatch");
      issues.push(makeIssue("error", "PacketKindMismatch", `$.packets.${packet.packet_id}.packet_kind`, `Packet ${packet.packet_id} kind does not match its declared sensor class.`, "Route only packets whose type matches the declared sensor."));
    }
    if (this.provenancePolicy.require_packet_provenance && packet.provenance.manifest_id.length === 0) {
      packetIssues.push("ProvenanceMissing");
      issues.push(makeIssue("error", "ProvenanceMissing", `$.packets.${packet.packet_id}.provenance`, `Packet ${packet.packet_id} is missing provenance.`, "Attach manifest, source tick, source time, calibration, and determinism provenance."));
    }
    if (this.provenancePolicy.require_calibration_ref && packet.provenance.calibration_ref.length === 0) {
      packetIssues.push("ProvenanceMissing");
      issues.push(makeIssue("error", "ProvenanceMissing", `$.packets.${packet.packet_id}.provenance.calibration_ref`, `Packet ${packet.packet_id} is missing calibration provenance.`, "Attach declared calibration before bundle assembly."));
    }
    if (this.provenancePolicy.require_determinism_hash && packet.determinism_hash.length === 0) {
      packetIssues.push("ProvenanceMissing");
      issues.push(makeIssue("error", "ProvenanceMissing", `$.packets.${packet.packet_id}.determinism_hash`, `Packet ${packet.packet_id} is missing determinism hash.`, "Hash packet-visible evidence before bundle assembly."));
    }
    const ageMs = Math.max(0, (referenceTimeS - packet.timestamp_interval.end_s) * 1000);
    if (ageMs > this.synchronizationPolicy.max_packet_age_ms + DEFAULT_REFERENCE_TIME_EPSILON_S) {
      packetIssues.push("PacketStale");
      issues.push(makeIssue("warning", "PacketStale", `$.packets.${packet.packet_id}`, `Packet ${packet.packet_id} is ${ageMs.toFixed(3)} ms old.`, "Represent stale packet status explicitly and consider recapture."));
    }
    if (packet.packet_status === "blocked" || packet.health_status === "blocked") {
      packetIssues.push("PacketBlocked");
      issues.push(makeIssue("error", "PacketBlocked", `$.packets.${packet.packet_id}.packet_status`, `Packet ${packet.packet_id} is blocked.`, "Keep it in the health report and prevent prompt routing."));
    } else if (packet.packet_status === "degraded" || packet.health_status === "degraded" || packet.health_status === "stale") {
      packetIssues.push("PacketDegraded");
      issues.push(makeIssue("warning", "PacketDegraded", `$.packets.${packet.packet_id}.packet_status`, `Packet ${packet.packet_id} is degraded.`, "Expose uncertainty to downstream consumers."));
    }
    const readiness = computeReadiness(packet, packetIssues);
    const route = computeRoute(packet, readiness);
    return Object.freeze({
      packet_ref: packet.packet_id,
      sensor_ref: packet.sensor_id,
      packet_kind: packet.packet_kind,
      timestamp_interval: freezeInterval(packet.timestamp_interval),
      midpoint_s: midpoint(packet.timestamp_interval),
      age_ms: ageMs,
      readiness,
      health_status: readiness === "stale" ? "stale" : packet.health_status,
      confidence: packet.confidence,
      route,
      issue_codes: freezeArray(packetIssues),
      determinism_hash: computeDeterminismHash({
        packetRef: packet.packet_id,
        sensorRef: packet.sensor_id,
        packetKind: packet.packet_kind,
        ageMs,
        readiness,
        route,
        packetIssues,
      }),
    });
  }

  private packetMatchesDeclaredHardware(packet: VirtualHardwarePacket): boolean {
    if (packet.packet_kind === "proprioception") {
      return this.manifest.sensor_inventory.some((sensor) => sensor.sensor_class === "joint_encoder");
    }
    if (packet.packet_kind === "contact") {
      return this.manifest.sensor_inventory.some((sensor) => sensor.sensor_class === "contact_sensor" || sensor.sensor_class === "force_torque");
    }
    return this.manifest.sensor_inventory.some((sensor) => sensor.sensor_id === packet.sensor_id);
  }

  private packetKindMatchesSensor(packet: VirtualHardwarePacket): boolean {
    if (packet.packet_kind === "proprioception") {
      return packet.sensor_id === "proprioception_bus";
    }
    if (packet.packet_kind === "contact") {
      return packet.sensor_id === "contact_sensor_bus";
    }
    const sensor = this.manifest.sensor_inventory.find((entry) => entry.sensor_id === packet.sensor_id);
    if (sensor === undefined) {
      return false;
    }
    return sensorClassToPacketKind(sensor.sensor_class) === packet.packet_kind;
  }

  private computeMissingSensors(packets: readonly VirtualHardwarePacket[], issues: ValidationIssue[]): readonly MissingSensorRecord[] {
    const missing: MissingSensorRecord[] = [];
    const packetSensorIds = new Set(packets.filter((packet) => packet.packet_status !== "blocked").map((packet) => packet.sensor_id));
    const packetKinds = new Set(packets.filter((packet) => packet.packet_status !== "blocked").map((packet) => packet.packet_kind));
    for (const sensor of this.manifest.sensor_inventory) {
      if (!this.isExpectedSensor(sensor)) {
        continue;
      }
      if (!packetSensorIds.has(sensor.sensor_id)) {
        const record = makeMissingSensor(sensor.sensor_id, sensor.sensor_class, sensorClassToPacketKind(sensor.sensor_class), "declared_sensor_absent");
        missing.push(record);
        issues.push(makeIssue("warning", "MissingExpectedSensor", `$.missing_sensors.${sensor.sensor_id}`, `Expected sensor ${sensor.sensor_id} did not produce an accepted packet.`, "Represent the missing channel in health report and consider recapture."));
      }
    }
    if (this.healthPolicy.require_at_least_one_camera && !packets.some((packet) => packet.packet_kind === "camera" && packet.packet_status !== "blocked")) {
      const record = makeMissingSensor("camera_packet_required", "rgb_camera", "camera", "required_bus_packet_absent");
      missing.push(record);
      issues.push(makeIssue("warning", "MissingExpectedSensor", "$.camera_packets", "At least one accepted camera packet is required for visual planning.", "Recapture a declared camera frame."));
    }
    if (this.healthPolicy.require_proprioception_when_encoders_declared && this.hasSensorClass("joint_encoder") && !packetKinds.has("proprioception")) {
      const record = makeMissingSensor("proprioception_bus", "proprioception_bus", "proprioception", "required_bus_packet_absent");
      missing.push(record);
      issues.push(makeIssue("warning", "MissingExpectedSensor", "$.proprioception_packet", "Declared encoders require a proprioception packet.", "Produce proprioception from declared joint encoders."));
    }
    if (this.healthPolicy.require_contact_when_contact_sensors_declared && (this.hasSensorClass("contact_sensor") || this.hasSensorClass("force_torque")) && !packetKinds.has("contact")) {
      const record = makeMissingSensor("contact_sensor_bus", "contact_sensor_bus", "contact", "required_bus_packet_absent");
      missing.push(record);
      issues.push(makeIssue("warning", "MissingExpectedSensor", "$.contact_packet", "Declared contact sensors require an explicit contact packet or missing-contact record.", "Produce contact evidence or mark contact sensors missing."));
    }
    return freezeArray(missing);
  }

  private isExpectedSensor(sensor: VirtualSensorDescriptor): boolean {
    if (sensor.cognitive_route === "qa_only" || sensor.cognitive_route === "blocked") {
      return false;
    }
    if (this.healthPolicy.required_sensor_classes.includes(sensor.sensor_class)) {
      return true;
    }
    return sensor.declared_for_cognitive_use;
  }

  private hasSensorClass(sensorClass: SensorClass): boolean {
    return this.manifest.sensor_inventory.some((sensor) => sensor.sensor_class === sensorClass);
  }

  private buildHealthReport(
    interval: HardwareTimestampInterval,
    records: readonly SensorPacketBusRecord[],
    missingSensors: readonly MissingSensorRecord[],
    stalePackets: readonly StalePacketRecord[],
    synchronizationSpreadMs: number,
  ): SensorHealthReport {
    const healthySensors = records
      .filter((record) => record.readiness === "accepted" && record.health_status === "healthy")
      .map((record) => record.sensor_ref);
    const degradedBySensor = new Map<Ref, { reasons: Set<string>; packetRefs: Set<Ref> }>();
    for (const record of records) {
      if (record.readiness === "degraded" || record.readiness === "stale" || record.health_status === "degraded" || record.health_status === "stale") {
        const entry = degradedBySensor.get(record.sensor_ref) ?? { reasons: new Set<string>(), packetRefs: new Set<Ref>() };
        entry.reasons.add(record.issue_codes.length === 0 ? "degraded_hardware" : record.issue_codes.join(","));
        entry.packetRefs.add(record.packet_ref);
        degradedBySensor.set(record.sensor_ref, entry);
      }
    }
    const degradedSensors = [...degradedBySensor.entries()].map(([sensorRef, entry]) => Object.freeze({
      sensor_ref: sensorRef,
      reason: [...entry.reasons].sort().join(";"),
      packet_refs: freezeArray([...entry.packetRefs].sort()),
    }));
    const blockedPackets = records.filter((record) => record.readiness === "blocked").map((record) => record.packet_ref);
    const recommendedAction = recommendAction(records, missingSensors, stalePackets, synchronizationSpreadMs, this.synchronizationPolicy.max_synchronization_spread_ms, this.healthPolicy);
    const reportId = `sensor_health_${this.config.manifest_id}_${Math.round(interval.start_s * 1000)}_${Math.round(interval.end_s * 1000)}`;
    return Object.freeze({
      schema_version: SENSOR_BUS_SCHEMA_VERSION,
      sensor_health_report_id: reportId,
      timestamp_interval: interval,
      healthy_sensors: freezeArray([...new Set(healthySensors)].sort()),
      degraded_sensors: freezeArray(degradedSensors),
      missing_sensors: freezeArray(missingSensors),
      stale_packets: freezeArray(stalePackets),
      blocked_packets: freezeArray(blockedPackets),
      synchronization_spread_ms: synchronizationSpreadMs,
      firewall_blocked_fields: freezeArray(this.provenancePolicy.firewall_blocked_field_categories),
      recommended_action: recommendedAction,
      determinism_hash: computeDeterminismHash({ reportId, interval, records, missingSensors, stalePackets, blockedPackets, recommendedAction }),
    });
  }

  private buildProvenanceReport(packets: readonly VirtualHardwarePacket[], issues: ValidationIssue[]): SensorBusProvenanceReport {
    const records = [];
    const missingRefs: Ref[] = [];
    for (const packet of packets) {
      const missingProvenance = packet.provenance.manifest_id.length === 0
        || packet.provenance.calibration_ref.length === 0
        || packet.provenance.determinism_hash.length === 0;
      if (missingProvenance) {
        missingRefs.push(packet.packet_id);
        issues.push(makeIssue("error", "ProvenanceMissing", `$.packets.${packet.packet_id}.provenance`, `Packet ${packet.packet_id} has incomplete provenance.`, "Attach complete provenance before routing to firewall."));
        continue;
      }
      records.push(Object.freeze({
        packet_ref: packet.packet_id,
        sensor_ref: packet.sensor_id,
        calibration_ref: packet.provenance.calibration_ref,
        synchronization_token_ref: packet.provenance.synchronization_token_ref,
        source_tick: packet.provenance.source_tick,
        source_time_s: packet.provenance.source_time_s,
        provenance_hash: packet.provenance.determinism_hash,
      }));
    }
    const provenanceReportRef = `sensor_bus_provenance_${this.config.manifest_id}_${computeDeterminismHash(records).slice(0, 12)}`;
    return Object.freeze({
      provenance_report_ref: provenanceReportRef,
      manifest_id: this.config.manifest_id,
      packet_provenance_refs: freezeArray(records),
      missing_provenance_packet_refs: freezeArray(missingRefs),
      determinism_hash: computeDeterminismHash({ provenanceReportRef, records, missingRefs }),
    });
  }
}

export function createSensorBus(config: SensorBusConfig): SensorBus {
  return new SensorBus(config);
}

export function assembleObservationBundle(
  sensorPackets: readonly VirtualHardwarePacket[],
  config: SensorBusConfig,
): ObservationBundle {
  return new SensorBus(config).assembleObservationBundle(sensorPackets);
}

function makeMissingSensor(
  sensorRef: Ref,
  sensorClass: MissingSensorRecord["sensor_class"],
  expectedPacketKind: VirtualHardwarePacketKind,
  reason: MissingSensorRecord["reason"],
): MissingSensorRecord {
  return Object.freeze({
    sensor_ref: sensorRef,
    sensor_class: sensorClass,
    expected_packet_kind: expectedPacketKind,
    reason,
    recommended_action: "re_capture",
  });
}

function computeReadiness(packet: VirtualHardwarePacket, issueCodes: readonly SensorBusIssueCode[]): SensorPacketBusRecord["readiness"] {
  if (packet.packet_status === "blocked" || packet.health_status === "blocked" || issueCodes.some((code) => code === "PacketBlocked" || code === "PacketUndeclared" || code === "PacketManifestMismatch" || code === "PacketSchemaMismatch" || code === "PacketKindMismatch" || code === "ProvenanceMissing")) {
    return "blocked";
  }
  if (issueCodes.includes("PacketStale") || packet.health_status === "stale") {
    return "stale";
  }
  if (packet.packet_status === "degraded" || packet.health_status === "degraded" || issueCodes.length > 0) {
    return "degraded";
  }
  return "accepted";
}

function computeRoute(packet: VirtualHardwarePacket, readiness: SensorPacketBusRecord["readiness"]): SensorBusRoute {
  if (readiness === "blocked" || packet.packet_status === "blocked") {
    return "blocked";
  }
  if (packet.calibration_exposure === "blocked") {
    return "blocked";
  }
  if (packet.packet_kind === "actuator_feedback" || packet.packet_kind === "contact" || packet.packet_kind === "audio") {
    return "sensor_bus_only";
  }
  return "prompt_candidate";
}

function computeBundleInterval(packets: readonly VirtualHardwarePacket[], referenceTimeS: number): HardwareTimestampInterval {
  if (packets.length === 0) {
    return Object.freeze({ start_s: referenceTimeS, end_s: referenceTimeS });
  }
  return Object.freeze({
    start_s: Math.min(...packets.map((packet) => packet.timestamp_interval.start_s)),
    end_s: Math.max(...packets.map((packet) => packet.timestamp_interval.end_s)),
  });
}

function computeSynchronizationSpreadMs(packets: readonly VirtualHardwarePacket[]): number {
  if (packets.length <= 1) {
    return 0;
  }
  const midpoints = packets.map((packet) => midpoint(packet.timestamp_interval));
  return (Math.max(...midpoints) - Math.min(...midpoints)) * 1000;
}

function midpoint(interval: HardwareTimestampInterval): number {
  return (interval.start_s + interval.end_s) / 2;
}

function isFiniteInterval(interval: HardwareTimestampInterval): boolean {
  return Number.isFinite(interval.start_s) && Number.isFinite(interval.end_s) && interval.end_s >= interval.start_s;
}

function freezeInterval(interval: HardwareTimestampInterval): HardwareTimestampInterval {
  return Object.freeze({ start_s: interval.start_s, end_s: interval.end_s });
}

function refsByKind<K extends VirtualHardwarePacketKind>(packets: readonly VirtualHardwarePacket[], packetKind: K): readonly Ref[] {
  return freezeArray(packets.filter((packet) => packet.packet_kind === packetKind).map((packet) => packet.packet_id).sort());
}

function firstRefByKind<K extends VirtualHardwarePacketKind>(packets: readonly VirtualHardwarePacket[], packetKind: K): Ref | undefined {
  return packets.find((packet) => packet.packet_kind === packetKind)?.packet_id;
}

function sensorClassToPacketKind(sensorClass: SensorClass): VirtualHardwarePacketKind {
  switch (sensorClass) {
    case "rgb_camera":
    case "depth_camera":
    case "stereo_camera":
      return "camera";
    case "microphone_array":
      return "audio";
    case "joint_encoder":
      return "proprioception";
    case "contact_sensor":
    case "force_torque":
      return "contact";
    case "imu":
      return "imu";
    case "actuator_feedback":
      return "actuator_feedback";
  }
}

function computeBundleStatus(
  records: readonly SensorPacketBusRecord[],
  missingSensors: readonly MissingSensorRecord[],
  synchronizationSpreadMs: number,
  maxSynchronizationSpreadMs: number,
): ObservationBundleStatus {
  if (records.some((record) => record.readiness === "blocked")) {
    return "blocked";
  }
  if (
    records.some((record) => record.readiness === "degraded" || record.readiness === "stale")
    || missingSensors.length > 0
    || synchronizationSpreadMs > maxSynchronizationSpreadMs
  ) {
    return "degraded";
  }
  return "nominal";
}

function recommendAction(
  records: readonly SensorPacketBusRecord[],
  missingSensors: readonly MissingSensorRecord[],
  stalePackets: readonly StalePacketRecord[],
  synchronizationSpreadMs: number,
  maxSynchronizationSpreadMs: number,
  healthPolicy: SensorBusHealthPolicy,
): SensorBusRecommendedAction {
  if (healthPolicy.safe_hold_on_blocked_imu_or_actuator_feedback && records.some((record) => record.readiness === "blocked" && (record.packet_kind === "imu" || record.packet_kind === "actuator_feedback"))) {
    return "safe_hold";
  }
  if (records.some((record) => record.readiness === "blocked")) {
    return "human_review";
  }
  if (missingSensors.length > 0 || stalePackets.length > 0 || synchronizationSpreadMs > maxSynchronizationSpreadMs) {
    return "re_capture";
  }
  if (records.some((record) => record.readiness === "degraded")) {
    return "re_observe";
  }
  return "continue";
}

function assertPositive(value: number, fieldName: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new SensorBusError("SensorBus configuration is invalid.", [
      makeIssue("error", "TimestampInvalid", `$.${fieldName}`, `${fieldName} must be finite and positive.`, "Use a positive finite timing policy."),
    ]);
  }
}

function makeIssue(severity: ValidationSeverity, code: SensorBusIssueCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

export const SENSOR_BUS_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: VIRTUAL_HARDWARE_MANIFEST_REGISTRY_SCHEMA_VERSION,
  adapter_schema_version: VIRTUAL_HARDWARE_ADAPTER_SCHEMA_VERSION,
  sensor_bus_schema_version: SENSOR_BUS_SCHEMA_VERSION,
  blueprint: "architecture_docs/04_VIRTUAL_HARDWARE_SENSOR_ACTUATOR_SPEC.md",
  sections: freezeArray(["4.13", "4.15.7", "4.16.1", "4.17", "4.18"]),
});
