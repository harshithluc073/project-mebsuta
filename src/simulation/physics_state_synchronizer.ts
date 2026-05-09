/**
 * Physics state synchronizer for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/03_SIMULATION_AND_PHYSICS_ENGINE_ARCHITECTURE.md`
 * sections 3.5, 3.6, 3.10, 3.11, 3.12, 3.17.3, 3.17.4, 3.18.2,
 * 3.19, 3.20, and 3.21.
 *
 * The synchronizer is the executable guardrail that prevents render, audio,
 * sensor, and control views from drifting away from the physics-authoritative
 * snapshot. It never makes render or sensor state authoritative. Instead it
 * emits an internal synchronization token and a QA/runtime report that the
 * sensor bus, verification engine, and replay recorder can trust.
 */

import { computeDeterminismHash } from "./world_manifest";
import type { AudioPacket } from "./acoustic_world_service";
import type { PhysicsStepReport } from "./physics_step_scheduler";
import type { CameraRenderPacket } from "./rendering_bridge";
import type { PhysicsWorldSnapshot } from "./simulation_world_service";
import type { Ref, ValidationIssue, ValidationSeverity } from "./world_manifest";

export const PHYSICS_STATE_SYNCHRONIZER_SCHEMA_VERSION = "mebsuta.physics_state_synchronizer.v1" as const;
const DEFAULT_MAX_SENSOR_SYNC_SPREAD_MS = 8.334;
const DEFAULT_MAX_RENDER_PHYSICS_DELTA_MS = 4.167;
const DEFAULT_MAX_AUDIO_EVENT_LATENCY_MS = 20;
const DEFAULT_MAX_CONTROL_LAG_MS = 8.334;
const DEFAULT_MAX_PACKET_AGE_MS = 33.334;

export type SensorPacketKind = "camera" | "audio" | "proprioception" | "contact" | "imu" | "actuator_feedback" | "custom";
export type SynchronizationStatus = "synchronized" | "degraded" | "blocked";
export type SynchronizationSeverity = "info" | "warning" | "blocking";
export type SensorPacketReadiness = "accepted" | "degraded" | "blocked" | "missing";
export type PacketHealthSummary = "nominal" | "degraded" | "blocked" | "dropped" | "unknown";
export type SynchronizationIssueCode =
  | "SnapshotInvalid"
  | "SnapshotRefMismatch"
  | "PhysicsTickMismatch"
  | "WorldRefMismatch"
  | "RenderPhysicsMismatch"
  | "DebugOverlayDetected"
  | "FrameDropped"
  | "AudioTimingMismatch"
  | "AudioSourceRefLeak"
  | "SensorTimestampInvalid"
  | "SensorSyncSpreadTooLarge"
  | "SensorPacketStale"
  | "ControlTickMismatch"
  | "ControlLagExceeded"
  | "ReplayMismatch"
  | "PacketHealthBlocked";

export interface TimestampInterval {
  readonly start_s: number;
  readonly end_s: number;
}

export interface PhysicsSynchronizationPolicy {
  readonly max_sensor_sync_spread_ms: number;
  readonly max_render_physics_delta_ms: number;
  readonly max_audio_event_latency_ms: number;
  readonly max_control_lag_ms: number;
  readonly max_packet_age_ms: number;
  readonly require_shared_snapshot_ref: boolean;
  readonly require_matching_physics_tick: boolean;
  readonly require_world_hash_match: boolean;
  readonly block_cognitive_on_debug_overlay: boolean;
  readonly require_audio_source_redaction: boolean;
  readonly allow_degraded_packets_for_qa: boolean;
}

export interface GenericSensorPacketRecord {
  readonly packet_ref: Ref;
  readonly sensor_ref: Ref;
  readonly sensor_kind: Exclude<SensorPacketKind, "camera" | "audio"> | "custom";
  readonly timestamp_interval: TimestampInterval;
  readonly physics_snapshot_ref?: Ref;
  readonly physics_tick?: number;
  readonly packet_status?: "captured" | "nominal" | "degraded" | "blocked" | "dropped" | "missing";
  readonly health_status?: "nominal" | "degraded" | "blocked" | "unknown";
  readonly determinism_hash?: string;
}

export interface PhysicsSynchronizationInput {
  readonly physics_snapshot: PhysicsWorldSnapshot;
  readonly render_packets?: readonly CameraRenderPacket[];
  readonly audio_packets?: readonly AudioPacket[];
  readonly generic_sensor_packets?: readonly GenericSensorPacketRecord[];
  readonly control_step_reports?: readonly PhysicsStepReport[];
  readonly policy?: Partial<PhysicsSynchronizationPolicy>;
  readonly cognitive_bound: boolean;
  readonly expected_world_state_hash?: string;
}

export interface PacketSynchronizationRecord {
  readonly packet_ref: Ref;
  readonly sensor_ref: Ref;
  readonly sensor_kind: SensorPacketKind;
  readonly sample_midpoint_s: number;
  readonly timestamp_interval: TimestampInterval;
  readonly physics_snapshot_ref?: Ref;
  readonly physics_tick?: number;
  readonly delta_from_physics_ms: number;
  readonly readiness: SensorPacketReadiness;
  readonly health_summary: PacketHealthSummary;
  readonly issue_codes: readonly SynchronizationIssueCode[];
  readonly determinism_hash: string;
}

export interface ControlSynchronizationRecord {
  readonly step_report_id: Ref;
  readonly snapshot_ref: Ref;
  readonly starting_tick: number;
  readonly completed_tick: number;
  readonly control_lag_ms: number;
  readonly timing_jitter_ms: number;
  readonly readiness: SensorPacketReadiness;
  readonly issue_codes: readonly SynchronizationIssueCode[];
  readonly determinism_hash: string;
}

export interface PhysicsSynchronizationToken {
  readonly token_ref: Ref;
  readonly world_ref: Ref;
  readonly physics_snapshot_ref: Ref;
  readonly physics_tick: number;
  readonly physics_timestamp_s: number;
  readonly valid_from_s: number;
  readonly valid_until_s: number;
  readonly packet_refs: readonly Ref[];
  readonly render_packet_refs: readonly Ref[];
  readonly audio_packet_refs: readonly Ref[];
  readonly generic_sensor_packet_refs: readonly Ref[];
  readonly control_report_refs: readonly Ref[];
  readonly max_observed_delta_ms: number;
  readonly sensor_sync_spread_ms: number;
  readonly cognitive_bound: boolean;
  readonly cognitive_visibility: "forbidden_to_cognition";
  readonly determinism_hash: string;
}

export interface PhysicsSynchronizationReport {
  readonly schema_version: typeof PHYSICS_STATE_SYNCHRONIZER_SCHEMA_VERSION;
  readonly report_ref: Ref;
  readonly synchronization_status: SynchronizationStatus;
  readonly world_ref: Ref;
  readonly physics_snapshot_ref: Ref;
  readonly physics_tick: number;
  readonly physics_timestamp_s: number;
  readonly synchronization_token?: PhysicsSynchronizationToken;
  readonly packet_records: readonly PacketSynchronizationRecord[];
  readonly control_records: readonly ControlSynchronizationRecord[];
  readonly synchronized_packet_refs: readonly Ref[];
  readonly degraded_packet_refs: readonly Ref[];
  readonly blocked_packet_refs: readonly Ref[];
  readonly sensor_sync_spread_ms: number;
  readonly render_physics_delta_ms: number;
  readonly audio_event_latency_ms: number;
  readonly control_lag_ms: number;
  readonly max_packet_age_ms: number;
  readonly safe_for_cognitive_sensor_bus: boolean;
  readonly issue_count: number;
  readonly issues: readonly ValidationIssue[];
  readonly hidden_truth_visibility: "runtime_qa_validator_only";
  readonly determinism_hash: string;
}

export interface CognitiveSafeSynchronizationSummary {
  readonly synchronization_status: SynchronizationStatus;
  readonly sensor_readiness: "ready" | "degraded_recapture_recommended" | "blocked_recapture_required";
  readonly timing_summary: "synchronized_sensor_bundle" | "timing_margin_low" | "desynchronized";
  readonly packet_count: number;
  readonly degraded_packet_count: number;
  readonly blocked_packet_count: number;
  readonly prompt_safe_summary: string;
  readonly hidden_fields_removed: readonly string[];
}

export class PhysicsStateSynchronizerError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "PhysicsStateSynchronizerError";
    this.issues = issues;
  }
}

/**
 * Validates same-interval coherence across physics, render, audio, sensors,
 * and control reports.
 */
export class PhysicsStateSynchronizer {
  private readonly defaultPolicy: PhysicsSynchronizationPolicy;

  public constructor(defaultPolicy: Partial<PhysicsSynchronizationPolicy> = {}) {
    this.defaultPolicy = mergePolicy(defaultPolicy);
  }

  public synchronizePhysicsState(input: PhysicsSynchronizationInput): PhysicsSynchronizationReport {
    validateSnapshot(input.physics_snapshot);
    const policy = mergePolicy({ ...this.defaultPolicy, ...(input.policy ?? {}) });
    validatePolicy(policy);

    const packetRecords = [
      ...this.renderPacketRecords(input, policy),
      ...this.audioPacketRecords(input, policy),
      ...this.genericPacketRecords(input, policy),
    ].sort(comparePacketRecords);
    const controlRecords: readonly ControlSynchronizationRecord[] = freezeArray([...this.controlRecords(input, policy)].sort(compareControlRecords));
    const issues = [
      ...packetRecords.flatMap((record) => issuesForPacket(record)),
      ...controlRecords.flatMap((record) => issuesForControl(record)),
      ...this.determinismIssues(input, policy),
    ];

    const spreadMs = computeSensorSpreadMs(packetRecords);
    if (packetRecords.length > 1 && spreadMs > policy.max_sensor_sync_spread_ms) {
      issues.push(makeIssue("error", "SensorSyncSpreadTooLarge", "$.packet_records", "Sensor bundle timestamp spread exceeds synchronization policy.", "Recapture the sensor bundle from one physics interval."));
    }

    const blockedRefs = packetRecords.filter((record) => record.readiness === "blocked" || record.readiness === "missing").map((record) => record.packet_ref);
    const degradedRefs = packetRecords.filter((record) => record.readiness === "degraded").map((record) => record.packet_ref);
    const synchronizedRefs = packetRecords.filter((record) => record.readiness === "accepted").map((record) => record.packet_ref);
    const renderDelta = maxOrZero(packetRecords.filter((record) => record.sensor_kind === "camera").map((record) => record.delta_from_physics_ms));
    const audioLatency = maxOrZero((input.audio_packets ?? []).map((packet) => packet.synchronization.audio_event_latency_ms));
    const controlLag = maxOrZero(controlRecords.map((record) => record.control_lag_ms));
    const packetAge = maxOrZero(packetRecords.map((record) => Math.abs(record.delta_from_physics_ms)));
    const blockingIssuePresent = issues.some((issue) => issue.severity === "error");
    const warningPresent = issues.some((issue) => issue.severity === "warning") || degradedRefs.length > 0;
    const status: SynchronizationStatus = blockingIssuePresent
      ? "blocked"
      : warningPresent
        ? "degraded"
        : "synchronized";
    const safeForCognition = input.cognitive_bound && status === "synchronized" && blockedRefs.length === 0 && allCognitiveRedactionChecksPass(input);
    const token = status === "blocked" && !policy.allow_degraded_packets_for_qa
      ? undefined
      : createToken(input, packetRecords, controlRecords, spreadMs, Math.max(renderDelta, audioLatency, controlLag, packetAge));

    const reportBase = {
      schema_version: PHYSICS_STATE_SYNCHRONIZER_SCHEMA_VERSION,
      report_ref: `physics_sync_${input.physics_snapshot.world_ref}_${input.physics_snapshot.physics_tick}`,
      synchronization_status: status,
      world_ref: input.physics_snapshot.world_ref,
      physics_snapshot_ref: input.physics_snapshot.snapshot_ref,
      physics_tick: input.physics_snapshot.physics_tick,
      physics_timestamp_s: input.physics_snapshot.timestamp_s,
      synchronization_token: token,
      packet_records: freezeArray(packetRecords),
      control_records: freezeArray(controlRecords),
      synchronized_packet_refs: freezeArray(synchronizedRefs),
      degraded_packet_refs: freezeArray(degradedRefs),
      blocked_packet_refs: freezeArray(blockedRefs),
      sensor_sync_spread_ms: round3(spreadMs),
      render_physics_delta_ms: round3(renderDelta),
      audio_event_latency_ms: round3(audioLatency),
      control_lag_ms: round3(controlLag),
      max_packet_age_ms: round3(packetAge),
      safe_for_cognitive_sensor_bus: safeForCognition,
      issue_count: issues.length,
      issues: freezeArray(issues),
      hidden_truth_visibility: "runtime_qa_validator_only" as const,
    };
    return Object.freeze({
      ...reportBase,
      determinism_hash: computeDeterminismHash(reportBase),
    });
  }

  public assertSynchronized(report: PhysicsSynchronizationReport): void {
    if (report.synchronization_status === "blocked" || !report.safe_for_cognitive_sensor_bus) {
      throw new PhysicsStateSynchronizerError("Physics/sensor bundle is not safe for cognitive sensor bus.", report.issues);
    }
  }

  public redactForCognition(report: PhysicsSynchronizationReport): CognitiveSafeSynchronizationSummary {
    const blocked = report.blocked_packet_refs.length;
    const degraded = report.degraded_packet_refs.length;
    const sensorReadiness: CognitiveSafeSynchronizationSummary["sensor_readiness"] = blocked > 0
      ? "blocked_recapture_required"
      : degraded > 0 || report.synchronization_status === "degraded"
        ? "degraded_recapture_recommended"
        : "ready";
    const timingSummary: CognitiveSafeSynchronizationSummary["timing_summary"] = report.synchronization_status === "synchronized"
      ? "synchronized_sensor_bundle"
      : report.synchronization_status === "degraded"
        ? "timing_margin_low"
        : "desynchronized";

    return Object.freeze({
      synchronization_status: report.synchronization_status,
      sensor_readiness: sensorReadiness,
      timing_summary: timingSummary,
      packet_count: report.packet_records.length,
      degraded_packet_count: degraded,
      blocked_packet_count: blocked,
      prompt_safe_summary: promptSafeSummary(sensorReadiness),
      hidden_fields_removed: freezeArray([
        "world_ref",
        "physics_snapshot_ref",
        "physics_tick",
        "physics_timestamp_s",
        "synchronization_token",
        "packet_refs",
        "control_report_refs",
        "determinism_hash",
        "exact_delta_ms",
      ]),
    });
  }

  private renderPacketRecords(input: PhysicsSynchronizationInput, policy: PhysicsSynchronizationPolicy): readonly PacketSynchronizationRecord[] {
    return freezeArray((input.render_packets ?? []).map((packet) => {
      const issueCodes: SynchronizationIssueCode[] = [];
      if (policy.require_shared_snapshot_ref && packet.physics_snapshot_ref !== input.physics_snapshot.snapshot_ref) {
        issueCodes.push("SnapshotRefMismatch");
      }
      if (policy.require_matching_physics_tick && packet.synchronization.physics_tick !== input.physics_snapshot.physics_tick) {
        issueCodes.push("PhysicsTickMismatch");
      }
      if (packet.synchronization.status === "mismatch" || packet.synchronization.render_physics_delta_ms > policy.max_render_physics_delta_ms) {
        issueCodes.push("RenderPhysicsMismatch");
      }
      if (packet.debug_overlay_present && input.cognitive_bound && policy.block_cognitive_on_debug_overlay) {
        issueCodes.push("DebugOverlayDetected");
      }
      if (packet.packet_status === "dropped") {
        issueCodes.push("FrameDropped");
      }
      if (packet.packet_status === "blocked" || packet.health_status === "blocked") {
        issueCodes.push("PacketHealthBlocked");
      }
      const readiness = readinessFromIssues(issueCodes, packet.packet_status === "degraded" || packet.health_status === "degraded");
      return packetRecord({
        packet_ref: packet.camera_packet_id,
        sensor_ref: packet.sensor_id,
        sensor_kind: "camera",
        timestamp_interval: packet.timestamp_interval,
        physics_snapshot_ref: packet.physics_snapshot_ref,
        physics_tick: packet.synchronization.physics_tick,
        delta_from_physics_ms: packet.synchronization.render_physics_delta_ms,
        readiness,
        health_summary: packet.packet_status === "dropped" ? "dropped" : packet.health_status,
        issue_codes: issueCodes,
      });
    }));
  }

  private audioPacketRecords(input: PhysicsSynchronizationInput, policy: PhysicsSynchronizationPolicy): readonly PacketSynchronizationRecord[] {
    return freezeArray((input.audio_packets ?? []).map((packet) => {
      const issueCodes: SynchronizationIssueCode[] = [];
      if (policy.require_shared_snapshot_ref && packet.synchronization.snapshot_ref !== input.physics_snapshot.snapshot_ref) {
        issueCodes.push("SnapshotRefMismatch");
      }
      if (policy.require_matching_physics_tick && packet.synchronization.physics_tick !== input.physics_snapshot.physics_tick) {
        issueCodes.push("PhysicsTickMismatch");
      }
      if (packet.synchronization.status === "mismatch" || packet.synchronization.audio_event_latency_ms > policy.max_audio_event_latency_ms) {
        issueCodes.push("AudioTimingMismatch");
      }
      if (input.cognitive_bound && policy.require_audio_source_redaction && packet.source_redaction_status !== "source_refs_stripped_for_cognition") {
        issueCodes.push("AudioSourceRefLeak");
      }
      if (packet.packet_status === "blocked" || packet.health_status === "blocked") {
        issueCodes.push("PacketHealthBlocked");
      }
      const readiness = readinessFromIssues(issueCodes, packet.packet_status === "degraded" || packet.health_status === "degraded" || packet.synchronization.status === "degraded");
      return packetRecord({
        packet_ref: packet.audio_packet_id,
        sensor_ref: packet.microphone_array_id,
        sensor_kind: "audio",
        timestamp_interval: packet.timestamp_interval,
        physics_snapshot_ref: packet.synchronization.snapshot_ref,
        physics_tick: packet.synchronization.physics_tick,
        delta_from_physics_ms: secondsToMilliseconds(Math.abs(packet.synchronization.audio_sample_time_s - input.physics_snapshot.timestamp_s)),
        readiness,
        health_summary: packet.health_status,
        issue_codes: issueCodes,
      });
    }));
  }

  private genericPacketRecords(input: PhysicsSynchronizationInput, policy: PhysicsSynchronizationPolicy): readonly PacketSynchronizationRecord[] {
    return freezeArray((input.generic_sensor_packets ?? []).map((packet) => {
      validateTimestampInterval(packet.timestamp_interval, `$.generic_sensor_packets.${packet.packet_ref}.timestamp_interval`);
      const midpoint = intervalMidpoint(packet.timestamp_interval);
      const issueCodes: SynchronizationIssueCode[] = [];
      if (policy.require_shared_snapshot_ref && packet.physics_snapshot_ref !== undefined && packet.physics_snapshot_ref !== input.physics_snapshot.snapshot_ref) {
        issueCodes.push("SnapshotRefMismatch");
      }
      if (policy.require_matching_physics_tick && packet.physics_tick !== undefined && packet.physics_tick !== input.physics_snapshot.physics_tick) {
        issueCodes.push("PhysicsTickMismatch");
      }
      const deltaMs = secondsToMilliseconds(Math.abs(midpoint - input.physics_snapshot.timestamp_s));
      if (deltaMs > policy.max_packet_age_ms) {
        issueCodes.push("SensorPacketStale");
      }
      if (packet.packet_status === "blocked" || packet.packet_status === "dropped" || packet.packet_status === "missing" || packet.health_status === "blocked") {
        issueCodes.push("PacketHealthBlocked");
      }
      const degraded = packet.packet_status === "degraded" || packet.health_status === "degraded";
      return packetRecord({
        packet_ref: packet.packet_ref,
        sensor_ref: packet.sensor_ref,
        sensor_kind: packet.sensor_kind,
        timestamp_interval: packet.timestamp_interval,
        physics_snapshot_ref: packet.physics_snapshot_ref,
        physics_tick: packet.physics_tick,
        delta_from_physics_ms: deltaMs,
        readiness: readinessFromIssues(issueCodes, degraded),
        health_summary: summarizeGenericHealth(packet),
        issue_codes: issueCodes,
      });
    }));
  }

  private controlRecords(input: PhysicsSynchronizationInput, policy: PhysicsSynchronizationPolicy): readonly ControlSynchronizationRecord[] {
    return freezeArray((input.control_step_reports ?? []).map((report) => {
      const issueCodes: SynchronizationIssueCode[] = [];
      if (policy.require_shared_snapshot_ref && report.snapshot_ref !== input.physics_snapshot.snapshot_ref) {
        issueCodes.push("SnapshotRefMismatch");
      }
      if (policy.require_matching_physics_tick && report.completed_tick !== input.physics_snapshot.physics_tick) {
        issueCodes.push("ControlTickMismatch");
      }
      if (report.world_ref !== input.physics_snapshot.world_ref) {
        issueCodes.push("WorldRefMismatch");
      }
      if (report.timing_health.control_lag_ms > policy.max_control_lag_ms) {
        issueCodes.push("ControlLagExceeded");
      }
      if (report.timing_health.jitter_status === "safe_hold_required") {
        issueCodes.push("PacketHealthBlocked");
      }
      const readiness = readinessFromIssues(issueCodes, report.timing_health.jitter_status === "warning");
      const base = {
        step_report_id: report.step_report_id,
        snapshot_ref: report.snapshot_ref,
        starting_tick: report.starting_tick,
        completed_tick: report.completed_tick,
        control_lag_ms: report.timing_health.control_lag_ms,
        timing_jitter_ms: report.timing_health.jitter_ms,
        readiness,
        issue_codes: freezeArray(issueCodes),
      };
      return Object.freeze({
        ...base,
        determinism_hash: computeDeterminismHash(base),
      });
    }));
  }

  private determinismIssues(input: PhysicsSynchronizationInput, policy: PhysicsSynchronizationPolicy): readonly ValidationIssue[] {
    if (!policy.require_world_hash_match || input.expected_world_state_hash === undefined) {
      return freezeArray([]);
    }
    if (input.expected_world_state_hash === input.physics_snapshot.determinism_hash) {
      return freezeArray([]);
    }
    return freezeArray([
      makeIssue("error", "ReplayMismatch", "$.expected_world_state_hash", "Expected world-state determinism marker does not match the physics snapshot.", "Replay with the original manifest, command trace, disturbance trace, and synchronized packet set."),
    ]);
  }
}

export function synchronizePhysicsState(input: PhysicsSynchronizationInput): PhysicsSynchronizationReport {
  return new PhysicsStateSynchronizer(input.policy).synchronizePhysicsState(input);
}

function createToken(
  input: PhysicsSynchronizationInput,
  packetRecords: readonly PacketSynchronizationRecord[],
  controlRecords: readonly ControlSynchronizationRecord[],
  spreadMs: number,
  maxObservedDeltaMs: number,
): PhysicsSynchronizationToken {
  const allIntervals = packetRecords.map((record) => record.timestamp_interval);
  const validFrom = allIntervals.length === 0 ? input.physics_snapshot.timestamp_s : Math.min(...allIntervals.map((interval) => interval.start_s));
  const validUntil = allIntervals.length === 0 ? input.physics_snapshot.timestamp_s : Math.max(...allIntervals.map((interval) => interval.end_s));
  const renderRefs = packetRecords.filter((record) => record.sensor_kind === "camera").map((record) => record.packet_ref);
  const audioRefs = packetRecords.filter((record) => record.sensor_kind === "audio").map((record) => record.packet_ref);
  const genericRefs = packetRecords.filter((record) => record.sensor_kind !== "camera" && record.sensor_kind !== "audio").map((record) => record.packet_ref);
  const base = {
    token_ref: `sync_token_${input.physics_snapshot.world_ref}_${input.physics_snapshot.physics_tick}`,
    world_ref: input.physics_snapshot.world_ref,
    physics_snapshot_ref: input.physics_snapshot.snapshot_ref,
    physics_tick: input.physics_snapshot.physics_tick,
    physics_timestamp_s: input.physics_snapshot.timestamp_s,
    valid_from_s: validFrom,
    valid_until_s: validUntil,
    packet_refs: freezeArray(packetRecords.map((record) => record.packet_ref)),
    render_packet_refs: freezeArray(renderRefs),
    audio_packet_refs: freezeArray(audioRefs),
    generic_sensor_packet_refs: freezeArray(genericRefs),
    control_report_refs: freezeArray(controlRecords.map((record) => record.step_report_id)),
    max_observed_delta_ms: round3(maxObservedDeltaMs),
    sensor_sync_spread_ms: round3(spreadMs),
    cognitive_bound: input.cognitive_bound,
    cognitive_visibility: "forbidden_to_cognition" as const,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function packetRecord(input: Omit<PacketSynchronizationRecord, "sample_midpoint_s" | "issue_codes" | "determinism_hash"> & {
  readonly issue_codes: readonly SynchronizationIssueCode[];
}): PacketSynchronizationRecord {
  validateTimestampInterval(input.timestamp_interval, `$.packet_records.${input.packet_ref}.timestamp_interval`);
  const base = {
    ...input,
    sample_midpoint_s: intervalMidpoint(input.timestamp_interval),
    delta_from_physics_ms: round3(input.delta_from_physics_ms),
    issue_codes: freezeArray(input.issue_codes),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function readinessFromIssues(issueCodes: readonly SynchronizationIssueCode[], degraded: boolean): SensorPacketReadiness {
  if (issueCodes.some(isBlockingCode)) {
    return "blocked";
  }
  if (degraded || issueCodes.length > 0) {
    return "degraded";
  }
  return "accepted";
}

function isBlockingCode(code: SynchronizationIssueCode): boolean {
  return code === "SnapshotRefMismatch"
    || code === "PhysicsTickMismatch"
    || code === "WorldRefMismatch"
    || code === "RenderPhysicsMismatch"
    || code === "DebugOverlayDetected"
    || code === "FrameDropped"
    || code === "AudioTimingMismatch"
    || code === "AudioSourceRefLeak"
    || code === "ControlTickMismatch"
    || code === "ReplayMismatch"
    || code === "PacketHealthBlocked";
}

function issuesForPacket(record: PacketSynchronizationRecord): readonly ValidationIssue[] {
  return freezeArray(record.issue_codes.map((code) => makeIssue(
    isBlockingCode(code) ? "error" : "warning",
    code,
    `$.packet_records.${record.packet_ref}`,
    messageForCode(code),
    remediationForCode(code),
  )));
}

function issuesForControl(record: ControlSynchronizationRecord): readonly ValidationIssue[] {
  return freezeArray(record.issue_codes.map((code) => makeIssue(
    isBlockingCode(code) ? "error" : "warning",
    code,
    `$.control_records.${record.step_report_id}`,
    messageForCode(code),
    remediationForCode(code),
  )));
}

function messageForCode(code: SynchronizationIssueCode): string {
  const messages: Record<SynchronizationIssueCode, string> = {
    SnapshotInvalid: "Physics snapshot is invalid.",
    SnapshotRefMismatch: "Packet references a different physics snapshot.",
    PhysicsTickMismatch: "Packet physics tick does not match the synchronized snapshot tick.",
    WorldRefMismatch: "Control report belongs to a different physics world.",
    RenderPhysicsMismatch: "Render packet diverges from the physics snapshot timing policy.",
    DebugOverlayDetected: "Cognitive-bound camera packet contains a debug overlay.",
    FrameDropped: "Camera frame was dropped.",
    AudioTimingMismatch: "Audio packet timing exceeds synchronization policy.",
    AudioSourceRefLeak: "Audio packet did not strip internal source refs for cognitive routing.",
    SensorTimestampInvalid: "Sensor timestamp interval is invalid.",
    SensorSyncSpreadTooLarge: "Sensor bundle timestamp spread exceeds policy.",
    SensorPacketStale: "Sensor packet is stale relative to the physics snapshot.",
    ControlTickMismatch: "Control report does not terminate on the physics snapshot tick.",
    ControlLagExceeded: "Control lag exceeds synchronization policy.",
    ReplayMismatch: "Determinism marker does not match expected replay state.",
    PacketHealthBlocked: "Packet health status blocks synchronized routing.",
  };
  return messages[code];
}

function remediationForCode(code: SynchronizationIssueCode): string {
  const remediations: Record<SynchronizationIssueCode, string> = {
    SnapshotInvalid: "Create a fresh PhysicsWorldSnapshot before synchronization.",
    SnapshotRefMismatch: "Regenerate the packet from the selected physics snapshot.",
    PhysicsTickMismatch: "Recapture the packet at the synchronized physics tick.",
    WorldRefMismatch: "Discard reports from other worlds or replay sessions.",
    RenderPhysicsMismatch: "Recapture the camera frame from the current physics snapshot.",
    DebugOverlayDetected: "Disable debug overlays before routing camera evidence to cognition.",
    FrameDropped: "Mark the view unavailable or recapture the frame.",
    AudioTimingMismatch: "Rebuild the audio packet with bounded source and receive timing.",
    AudioSourceRefLeak: "Run acoustic redaction before cognitive routing.",
    SensorTimestampInvalid: "Emit finite ordered timestamp intervals.",
    SensorSyncSpreadTooLarge: "Recapture a synchronized sensor bundle.",
    SensorPacketStale: "Replace stale sensor evidence with a current packet.",
    ControlTickMismatch: "Use the control report for the same completed physics tick.",
    ControlLagExceeded: "Reduce control latency or hold motion until timing is healthy.",
    ReplayMismatch: "Replay with the original manifest, commands, disturbances, and packet set.",
    PacketHealthBlocked: "Repair or replace the blocked packet before sensor-bus assembly.",
  };
  return remediations[code];
}

function computeSensorSpreadMs(records: readonly PacketSynchronizationRecord[]): number {
  if (records.length <= 1) {
    return 0;
  }
  const midpoints = records.map((record) => record.sample_midpoint_s);
  return secondsToMilliseconds(Math.max(...midpoints) - Math.min(...midpoints));
}

function allCognitiveRedactionChecksPass(input: PhysicsSynchronizationInput): boolean {
  const renderOk = (input.render_packets ?? []).every((packet) => !packet.debug_overlay_present && packet.cognitive_visibility === "sensor_evidence_after_hardware_firewall");
  const audioOk = (input.audio_packets ?? []).every((packet) => packet.source_redaction_status === "source_refs_stripped_for_cognition" && packet.cognitive_visibility === "microphone_evidence_after_hardware_firewall");
  return renderOk && audioOk;
}

function summarizeGenericHealth(packet: GenericSensorPacketRecord): PacketHealthSummary {
  if (packet.packet_status === "dropped") {
    return "dropped";
  }
  if (packet.packet_status === "blocked" || packet.health_status === "blocked") {
    return "blocked";
  }
  if (packet.packet_status === "degraded" || packet.health_status === "degraded") {
    return "degraded";
  }
  if (packet.packet_status === "missing") {
    return "dropped";
  }
  return packet.health_status ?? "unknown";
}

function promptSafeSummary(readiness: CognitiveSafeSynchronizationSummary["sensor_readiness"]): string {
  if (readiness === "blocked_recapture_required") {
    return "The sensor bundle is not synchronized and should be recaptured before reasoning.";
  }
  if (readiness === "degraded_recapture_recommended") {
    return "The sensor bundle has low timing margin; re-observation is recommended.";
  }
  return "The sensor bundle is synchronized and ready for embodied reasoning.";
}

function mergePolicy(input: Partial<PhysicsSynchronizationPolicy>): PhysicsSynchronizationPolicy {
  return Object.freeze({
    max_sensor_sync_spread_ms: input.max_sensor_sync_spread_ms ?? DEFAULT_MAX_SENSOR_SYNC_SPREAD_MS,
    max_render_physics_delta_ms: input.max_render_physics_delta_ms ?? DEFAULT_MAX_RENDER_PHYSICS_DELTA_MS,
    max_audio_event_latency_ms: input.max_audio_event_latency_ms ?? DEFAULT_MAX_AUDIO_EVENT_LATENCY_MS,
    max_control_lag_ms: input.max_control_lag_ms ?? DEFAULT_MAX_CONTROL_LAG_MS,
    max_packet_age_ms: input.max_packet_age_ms ?? DEFAULT_MAX_PACKET_AGE_MS,
    require_shared_snapshot_ref: input.require_shared_snapshot_ref ?? true,
    require_matching_physics_tick: input.require_matching_physics_tick ?? true,
    require_world_hash_match: input.require_world_hash_match ?? false,
    block_cognitive_on_debug_overlay: input.block_cognitive_on_debug_overlay ?? true,
    require_audio_source_redaction: input.require_audio_source_redaction ?? true,
    allow_degraded_packets_for_qa: input.allow_degraded_packets_for_qa ?? true,
  });
}

function validatePolicy(policy: PhysicsSynchronizationPolicy): void {
  const issues: ValidationIssue[] = [];
  validateNonNegativeFinite(policy.max_sensor_sync_spread_ms, issues, "$.policy.max_sensor_sync_spread_ms");
  validateNonNegativeFinite(policy.max_render_physics_delta_ms, issues, "$.policy.max_render_physics_delta_ms");
  validateNonNegativeFinite(policy.max_audio_event_latency_ms, issues, "$.policy.max_audio_event_latency_ms");
  validateNonNegativeFinite(policy.max_control_lag_ms, issues, "$.policy.max_control_lag_ms");
  validateNonNegativeFinite(policy.max_packet_age_ms, issues, "$.policy.max_packet_age_ms");
  if (issues.some((issue) => issue.severity === "error")) {
    throw new PhysicsStateSynchronizerError("Synchronization policy failed validation.", issues);
  }
}

function validateSnapshot(snapshot: PhysicsWorldSnapshot): void {
  const issues: ValidationIssue[] = [];
  validateRef(snapshot.snapshot_ref, issues, "$.physics_snapshot.snapshot_ref");
  validateRef(snapshot.world_ref, issues, "$.physics_snapshot.world_ref");
  if (!Number.isInteger(snapshot.physics_tick) || snapshot.physics_tick < 0) {
    issues.push(makeIssue("error", "SnapshotInvalid", "$.physics_snapshot.physics_tick", "Physics tick must be a nonnegative integer.", "Use a snapshot emitted by SimulationWorldService."));
  }
  if (!Number.isFinite(snapshot.timestamp_s) || snapshot.timestamp_s < 0) {
    issues.push(makeIssue("error", "SnapshotInvalid", "$.physics_snapshot.timestamp_s", "Snapshot timestamp must be finite and nonnegative.", "Use simulation time in seconds."));
  }
  if (snapshot.cognitive_visibility !== "forbidden_to_cognition") {
    issues.push(makeIssue("error", "SnapshotInvalid", "$.physics_snapshot.cognitive_visibility", "Physics snapshots must remain forbidden to cognition.", "Route only synchronized sensor evidence to cognition."));
  }
  if (issues.some((issue) => issue.severity === "error")) {
    throw new PhysicsStateSynchronizerError("Physics snapshot failed synchronization validation.", issues);
  }
}

function validateTimestampInterval(interval: TimestampInterval, path: string): void {
  if (!Number.isFinite(interval.start_s) || !Number.isFinite(interval.end_s) || interval.start_s < 0 || interval.end_s < interval.start_s) {
    throw new PhysicsStateSynchronizerError("Sensor timestamp interval failed synchronization validation.", [
      makeIssue("error", "SensorTimestampInvalid", path, "Timestamp interval must be finite, nonnegative, and ordered.", "Use start_s >= 0 and end_s >= start_s."),
    ]);
  }
}

function validateRef(value: string, issues: ValidationIssue[], path: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || /\s/.test(value)) {
    issues.push(makeIssue("error", "SnapshotInvalid", path, "Reference must be non-empty and whitespace-free.", "Use an opaque simulator ref."));
  }
}

function validateNonNegativeFinite(value: number, issues: ValidationIssue[], path: string): void {
  if (!Number.isFinite(value) || value < 0) {
    issues.push(makeIssue("error", "SensorTimestampInvalid", path, "Policy value must be nonnegative and finite.", "Use a calibrated nonnegative millisecond threshold."));
  }
}

function makeIssue(severity: ValidationSeverity, code: SynchronizationIssueCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function comparePacketRecords(a: PacketSynchronizationRecord, b: PacketSynchronizationRecord): number {
  return a.sample_midpoint_s - b.sample_midpoint_s || a.sensor_kind.localeCompare(b.sensor_kind) || a.packet_ref.localeCompare(b.packet_ref);
}

function compareControlRecords(a: ControlSynchronizationRecord, b: ControlSynchronizationRecord): number {
  return a.completed_tick - b.completed_tick || a.step_report_id.localeCompare(b.step_report_id);
}

function intervalMidpoint(interval: TimestampInterval): number {
  return (interval.start_s + interval.end_s) / 2;
}

function secondsToMilliseconds(seconds: number): number {
  return seconds * 1000;
}

function maxOrZero(values: readonly number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}
