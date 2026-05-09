/**
 * Hardware replay recorder for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/04_VIRTUAL_HARDWARE_SENSOR_ACTUATOR_SPEC.md`
 * sections 4.3, 4.13, 4.15.7, 4.16, 4.17, and 4.18.2.
 *
 * This service records the replayable virtual hardware boundary: sensor packet
 * timing, packet IDs, command IDs, health events, embodiment adaptation
 * reports, provenance refs, and deterministic markers. Captured data is for
 * QA, prompt regression, and traceability only; it must not become Gemini
 * Robotics-ER 1.6 prompt context or episodic memory.
 */

import {
  InMemoryReplayStorageAdapter,
} from "../simulation/replay_recorder";
import type {
  ReplayStorageAdapter,
  ReplayStorageRecord,
  ReplayStorageRecordKind,
  ReplayStorageWriteResult,
  ReplayTraceCompleteness,
} from "../simulation/replay_recorder";
import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import type { HardwareActuatorCommandApplicationReport, HardwareCommandApplicationRecord, HardwareGatewayRejection, HardwareSimulationBoundaryCommand } from "./actuator_command_gateway";
import type { EmbodimentAdaptationReport, EmbodimentContractPacket } from "./embodiment_hardware_adapter";
import type { HardwareHealthDiagnostic, HardwareHealthReport, HardwareSafeHoldTrigger } from "./hardware_health_monitor";
import type { ObservationBundle, SensorBusProvenanceReport, SensorHealthReport, SensorPacketBusRecord } from "./sensor_bus";
import type { HardwareTimestampInterval, VirtualHardwareObservationBatch, VirtualHardwarePacket, VirtualHardwarePacketKind, VirtualHardwarePacketStatus } from "./virtual_hardware_adapter";
import {
  VIRTUAL_HARDWARE_MANIFEST_REGISTRY_SCHEMA_VERSION,
  VirtualHardwareManifestRegistry,
} from "./virtual_hardware_manifest_registry";
import type { HardwareHealthStatus, VirtualHardwareManifest } from "./virtual_hardware_manifest_registry";

export const HARDWARE_REPLAY_RECORDER_SCHEMA_VERSION = "mebsuta.hardware_replay_recorder.v1" as const;

const DEFAULT_MAX_EVENT_LOG_ENTRIES = 4096;

export type HardwareReplayHealthStatus = "replayable" | "degraded" | "invalid";
export type HardwareReplayComparisonStatus = "match" | "mismatch" | "incomplete";
export type HardwareReplayReadiness = "ready_for_regression" | "degraded_for_qa_only" | "invalid_recapture_required";
export type HardwareReplayValidationCode =
  | "HardwareReplayConfigInvalid"
  | "ManifestMismatch"
  | "PacketTraceMissing"
  | "PacketTimestampInvalid"
  | "PacketProvenanceMissing"
  | "PacketManifestMismatch"
  | "ObservationBundleMismatch"
  | "CommandTraceIncomplete"
  | "HealthTraceIncomplete"
  | "EmbodimentTraceIncomplete"
  | "ReplayWriteFailed"
  | "HardwareReplayMismatch";

export interface HardwareReplayRecorderConfig {
  readonly replay_id: Ref;
  readonly source_session_id: Ref;
  readonly registry: VirtualHardwareManifestRegistry;
  readonly manifest_id: Ref;
  readonly storage_adapter?: ReplayStorageAdapter;
  readonly max_event_log_entries?: number;
}

export interface HardwareReplayManifest {
  readonly schema_version: typeof HARDWARE_REPLAY_RECORDER_SCHEMA_VERSION;
  readonly replay_id: Ref;
  readonly source_session_id: Ref;
  readonly manifest_id: Ref;
  readonly embodiment_kind: VirtualHardwareManifest["embodiment_kind"];
  readonly hardware_manifest_hash: string;
  readonly replay_policy_ref?: Ref;
  readonly sensor_packet_trace_ref: Ref;
  readonly command_trace_ref: Ref;
  readonly health_trace_ref: Ref;
  readonly embodiment_trace_ref: Ref;
  readonly cognitive_visibility: "qa_only";
  readonly determinism_hash: string;
}

export interface HardwarePacketReplayRecord {
  readonly packet_ref: Ref;
  readonly packet_kind: VirtualHardwarePacketKind;
  readonly sensor_ref: Ref;
  readonly manifest_id: Ref;
  readonly timestamp_interval: HardwareTimestampInterval;
  readonly source_tick: number;
  readonly source_time_s: number;
  readonly synchronization_token_ref?: Ref;
  readonly calibration_ref?: Ref;
  readonly health_status: HardwareHealthStatus;
  readonly packet_status: VirtualHardwarePacketStatus;
  readonly confidence: number;
  readonly bus_readiness?: SensorPacketBusRecord["readiness"];
  readonly cognitive_visibility: "packet_ref_only_for_replay";
  readonly determinism_hash: string;
}

export interface HardwarePacketReplayTrace {
  readonly trace_ref: Ref;
  readonly packet_records: readonly HardwarePacketReplayRecord[];
  readonly observation_bundle_ref?: Ref;
  readonly sensor_health_report_ref?: Ref;
  readonly provenance_report_ref?: Ref;
  readonly synchronization_token_refs: readonly Ref[];
  readonly blocked_packet_count: number;
  readonly degraded_packet_count: number;
  readonly stale_packet_count: number;
  readonly missing_packet_count: number;
  readonly timing_interval: HardwareTimestampInterval;
  readonly completeness: ReplayTraceCompleteness;
  readonly determinism_hash: string;
}

export interface HardwareCommandReplayRecord {
  readonly command_ref: Ref;
  readonly actuator_ref: Ref;
  readonly command_mode: string;
  readonly application_status: string;
  readonly target_timestamp_s: number;
  readonly application_time_s: number;
  readonly latency_ms: number;
  readonly saturation_flags: readonly string[];
  readonly source_report_ref: Ref;
  readonly determinism_hash: string;
}

export interface HardwareFeedbackReplayRecord {
  readonly feedback_packet_ref: Ref;
  readonly command_ref: Ref;
  readonly actuator_ref: Ref;
  readonly application_status: string;
  readonly latency_ms: number;
  readonly health_status: string;
  readonly saturation_flags: readonly string[];
  readonly determinism_hash: string;
}

export interface HardwareCommandReplayTrace {
  readonly trace_ref: Ref;
  readonly source_report_refs: readonly Ref[];
  readonly accepted_boundary_command_refs: readonly Ref[];
  readonly command_records: readonly HardwareCommandReplayRecord[];
  readonly feedback_records: readonly HardwareFeedbackReplayRecord[];
  readonly rejected_command_records: readonly {
    readonly command_ref: Ref;
    readonly reason_code: string;
    readonly source_report_ref: Ref;
  }[];
  readonly delayed_command_refs: readonly Ref[];
  readonly safe_hold_report_refs: readonly Ref[];
  readonly completeness: ReplayTraceCompleteness;
  readonly determinism_hash: string;
}

export interface HardwareHealthReplayRecord {
  readonly diagnostic_ref: Ref;
  readonly failure_mode: string;
  readonly severity: string;
  readonly issue_code: string;
  readonly source_ref: Ref;
  readonly affected_hardware_refs: readonly Ref[];
  readonly recommended_action: string;
  readonly safe_hold_required: boolean;
  readonly determinism_hash: string;
}

export interface HardwareSafeHoldReplayRecord {
  readonly trigger_ref: Ref;
  readonly source_diagnostic_ref: Ref;
  readonly source_ref: Ref;
  readonly failure_mode: string;
  readonly recommended_action: string;
  readonly determinism_hash: string;
}

export interface HardwareHealthReplayTrace {
  readonly trace_ref: Ref;
  readonly source_report_ref?: Ref;
  readonly health_status?: HardwareHealthReport["health_status"];
  readonly recommended_action?: HardwareHealthReport["recommended_action"];
  readonly diagnostic_records: readonly HardwareHealthReplayRecord[];
  readonly safe_hold_records: readonly HardwareSafeHoldReplayRecord[];
  readonly sensor_health_report_ref?: Ref;
  readonly missing_sensor_count: number;
  readonly blocked_packet_count: number;
  readonly degraded_sensor_count: number;
  readonly synchronization_spread_ms: number;
  readonly completeness: ReplayTraceCompleteness;
  readonly determinism_hash: string;
}

export interface HardwareEmbodimentReplayTrace {
  readonly trace_ref: Ref;
  readonly adaptation_report_ref?: Ref;
  readonly contract_ref?: Ref;
  readonly embodiment_kind?: VirtualHardwareManifest["embodiment_kind"];
  readonly sensor_mount_count: number;
  readonly contact_site_count: number;
  readonly actuator_mapping_count: number;
  readonly adaptation_ok?: boolean;
  readonly hidden_fields_removed: readonly string[];
  readonly completeness: ReplayTraceCompleteness;
  readonly determinism_hash: string;
}

export interface HardwareReplayCheckpointInput {
  readonly adapter_batch?: VirtualHardwareObservationBatch;
  readonly packets?: readonly VirtualHardwarePacket[];
  readonly observation_bundle?: ObservationBundle;
  readonly sensor_health_report?: SensorHealthReport;
  readonly provenance_report?: SensorBusProvenanceReport;
  readonly hardware_health_report?: HardwareHealthReport;
  readonly actuator_application_reports?: readonly HardwareActuatorCommandApplicationReport[];
  readonly embodiment_adaptation_report?: EmbodimentAdaptationReport;
  readonly embodiment_contract_packet?: EmbodimentContractPacket;
}

export interface HardwareReplayCheckpoint {
  readonly schema_version: typeof HARDWARE_REPLAY_RECORDER_SCHEMA_VERSION;
  readonly checkpoint_ref: Ref;
  readonly replay_id: Ref;
  readonly sequence_index: number;
  readonly manifest_id: Ref;
  readonly replay_manifest: HardwareReplayManifest;
  readonly packet_trace: HardwarePacketReplayTrace;
  readonly command_trace: HardwareCommandReplayTrace;
  readonly health_trace: HardwareHealthReplayTrace;
  readonly embodiment_trace: HardwareEmbodimentReplayTrace;
  readonly prior_checkpoint_hash?: string;
  readonly determinism_marker: string;
  readonly replay_health: HardwareReplayHealthStatus;
  readonly storage_writes: readonly ReplayStorageWriteResult[];
  readonly issues: readonly ValidationIssue[];
  readonly cognitive_visibility: "qa_only";
  readonly determinism_hash: string;
}

export interface HardwareReplayDeterminismReport {
  readonly schema_version: typeof HARDWARE_REPLAY_RECORDER_SCHEMA_VERSION;
  readonly determinism_report_ref: Ref;
  readonly replay_id: Ref;
  readonly comparison_status: HardwareReplayComparisonStatus;
  readonly expected_checkpoint_count: number;
  readonly actual_checkpoint_count: number;
  readonly matching_checkpoint_count: number;
  readonly first_mismatch_index?: number;
  readonly expected_marker?: string;
  readonly actual_marker?: string;
  readonly issue_count: number;
  readonly issues: readonly ValidationIssue[];
  readonly cognitive_visibility: "qa_only";
  readonly determinism_hash: string;
}

export interface CognitiveSafeHardwareReplaySummary {
  readonly replay_health: HardwareReplayHealthStatus;
  readonly checkpoint_count: number;
  readonly replay_readiness: HardwareReplayReadiness;
  readonly prompt_safe_summary: string;
  readonly hidden_fields_removed: readonly string[];
}

export class HardwareReplayRecorderError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "HardwareReplayRecorderError";
    this.issues = issues;
  }
}

/**
 * Records deterministic QA-only virtual hardware replay checkpoints.
 */
export class HardwareReplayRecorder {
  private readonly manifest: VirtualHardwareManifest;
  private readonly storage: ReplayStorageAdapter;
  private readonly checkpoints: HardwareReplayCheckpoint[] = [];
  private readonly eventLog: ReplayStorageRecord[] = [];
  private readonly maxEventLogEntries: number;

  public constructor(private readonly config: HardwareReplayRecorderConfig) {
    validateConfig(config);
    this.manifest = config.registry.requireManifest(config.manifest_id);
    this.storage = config.storage_adapter ?? new InMemoryReplayStorageAdapter();
    this.maxEventLogEntries = config.max_event_log_entries ?? DEFAULT_MAX_EVENT_LOG_ENTRIES;
    assertPositiveInteger(this.maxEventLogEntries, "max_event_log_entries");
  }

  /**
   * Captures one virtual hardware replay checkpoint from adapter, sensor bus,
   * command gateway, health monitor, and embodiment adapter outputs.
   */
  public recordHardwareCheckpoint(input: HardwareReplayCheckpointInput): HardwareReplayCheckpoint {
    const issues = validateCheckpointInput(this.config.manifest_id, input);
    const packetTrace = buildPacketTrace(this.config.replay_id, this.checkpoints.length, input);
    const commandTrace = buildCommandTrace(this.config.replay_id, this.checkpoints.length, input.actuator_application_reports ?? []);
    const healthTrace = buildHealthTrace(this.config.replay_id, this.checkpoints.length, input);
    const embodimentTrace = buildEmbodimentTrace(this.config.replay_id, this.checkpoints.length, input);
    issues.push(...validateTraces(packetTrace, commandTrace, healthTrace, embodimentTrace));

    const manifest = this.createReplayManifest(packetTrace.trace_ref, commandTrace.trace_ref, healthTrace.trace_ref, embodimentTrace.trace_ref);
    const sequenceIndex = this.checkpoints.length;
    const priorCheckpointHash = this.checkpoints.at(-1)?.determinism_hash;
    const markerBase = {
      replay_id: this.config.replay_id,
      sequence_index: sequenceIndex,
      manifest_hash: manifest.determinism_hash,
      packet_hash: packetTrace.determinism_hash,
      command_hash: commandTrace.determinism_hash,
      health_hash: healthTrace.determinism_hash,
      embodiment_hash: embodimentTrace.determinism_hash,
      prior_checkpoint_hash: priorCheckpointHash,
    };
    const determinismMarker = computeDeterminismHash(markerBase);
    const replayHealth = classifyReplayHealth(packetTrace, commandTrace, healthTrace, embodimentTrace, issues);
    const checkpointBase = {
      schema_version: HARDWARE_REPLAY_RECORDER_SCHEMA_VERSION,
      checkpoint_ref: `hardware_replay_checkpoint_${this.config.replay_id}_${sequenceIndex}`,
      replay_id: this.config.replay_id,
      sequence_index: sequenceIndex,
      manifest_id: this.config.manifest_id,
      replay_manifest: manifest,
      packet_trace: packetTrace,
      command_trace: commandTrace,
      health_trace: healthTrace,
      embodiment_trace: embodimentTrace,
      prior_checkpoint_hash: priorCheckpointHash,
      determinism_marker: determinismMarker,
      replay_health: replayHealth,
      issues: freezeArray(issues),
      cognitive_visibility: "qa_only" as const,
    };
    const checkpointWithoutWrites = Object.freeze({
      ...checkpointBase,
      storage_writes: freezeArray([] as ReplayStorageWriteResult[]),
      determinism_hash: computeDeterminismHash(checkpointBase),
    });
    const writes = this.writeCheckpointRecords(manifest, checkpointWithoutWrites);
    const writeIssues = writes
      .filter((write) => write.status === "failed")
      .map((write) => makeIssue("error", "ReplayWriteFailed", `$.storage.${write.storage_key}`, write.message, "Inspect the replay storage adapter and retry capture."));
    const checkpoint = Object.freeze({
      ...checkpointWithoutWrites,
      replay_health: writeIssues.length > 0 ? "invalid" as const : checkpointWithoutWrites.replay_health,
      issues: freezeArray([...checkpointWithoutWrites.issues, ...writeIssues]),
      storage_writes: freezeArray(writes),
      determinism_hash: computeDeterminismHash({ checkpointBase, writes, writeIssues }),
    });
    this.checkpoints.push(checkpoint);
    this.recordEvent("checkpoint", checkpoint.checkpoint_ref, checkpoint.determinism_hash);
    return checkpoint;
  }

  /**
   * Builds the QA-only manifest tying every trace ref to a hardware manifest.
   */
  public createReplayManifest(
    sensorPacketTraceRef: Ref,
    commandTraceRef: Ref,
    healthTraceRef: Ref,
    embodimentTraceRef: Ref,
  ): HardwareReplayManifest {
    const manifestBase = {
      schema_version: HARDWARE_REPLAY_RECORDER_SCHEMA_VERSION,
      replay_id: this.config.replay_id,
      source_session_id: this.config.source_session_id,
      manifest_id: this.manifest.manifest_id,
      embodiment_kind: this.manifest.embodiment_kind,
      hardware_manifest_hash: computeDeterminismHash(this.manifest),
      replay_policy_ref: this.manifest.replay_policy_ref,
      sensor_packet_trace_ref: sensorPacketTraceRef,
      command_trace_ref: commandTraceRef,
      health_trace_ref: healthTraceRef,
      embodiment_trace_ref: embodimentTraceRef,
      cognitive_visibility: "qa_only" as const,
    };
    return Object.freeze({
      ...manifestBase,
      determinism_hash: computeDeterminismHash(manifestBase),
    });
  }

  /**
   * Compares deterministic checkpoint markers from two hardware replay runs.
   */
  public buildDeterminismReport(
    expected: readonly HardwareReplayCheckpoint[],
    actual: readonly HardwareReplayCheckpoint[] = this.checkpoints,
  ): HardwareReplayDeterminismReport {
    const issues: ValidationIssue[] = [];
    const minLength = Math.min(expected.length, actual.length);
    let matchingCount = 0;
    let firstMismatchIndex: number | undefined;
    for (let index = 0; index < minLength; index += 1) {
      if (expected[index].determinism_marker === actual[index].determinism_marker) {
        matchingCount += 1;
        continue;
      }
      firstMismatchIndex = index;
      issues.push(makeIssue("error", "HardwareReplayMismatch", `$.checkpoints[${index}]`, "Hardware replay determinism marker diverged.", "Replay with the same hardware manifest, packet timing, command reports, and health reports."));
      break;
    }
    if (expected.length !== actual.length) {
      issues.push(makeIssue("warning", "PacketTraceMissing", "$.checkpoints", "Expected and actual checkpoint counts differ.", "Compare complete hardware checkpoint sequences."));
    }
    const status: HardwareReplayComparisonStatus = issues.some((issue) => issue.code === "HardwareReplayMismatch")
      ? "mismatch"
      : expected.length !== actual.length
        ? "incomplete"
        : "match";
    const reportBase = {
      schema_version: HARDWARE_REPLAY_RECORDER_SCHEMA_VERSION,
      determinism_report_ref: `hardware_replay_determinism_${this.config.replay_id}_${this.checkpoints.length}`,
      replay_id: this.config.replay_id,
      comparison_status: status,
      expected_checkpoint_count: expected.length,
      actual_checkpoint_count: actual.length,
      matching_checkpoint_count: matchingCount,
      first_mismatch_index: firstMismatchIndex,
      expected_marker: firstMismatchIndex === undefined ? expected.at(-1)?.determinism_marker : expected[firstMismatchIndex]?.determinism_marker,
      actual_marker: firstMismatchIndex === undefined ? actual.at(-1)?.determinism_marker : actual[firstMismatchIndex]?.determinism_marker,
      issue_count: issues.length,
      issues: freezeArray(issues),
      cognitive_visibility: "qa_only" as const,
    };
    const report = Object.freeze({
      ...reportBase,
      determinism_hash: computeDeterminismHash(reportBase),
    });
    const write = this.writeRecord("determinism_report", report.determinism_report_ref, report);
    if (write.status === "failed") {
      throw new HardwareReplayRecorderError("Hardware replay determinism report write failed.", [
        makeIssue("error", "ReplayWriteFailed", "$.storage", write.message, "Inspect the replay storage adapter."),
      ]);
    }
    return report;
  }

  public listCheckpoints(): readonly HardwareReplayCheckpoint[] {
    return freezeArray(this.checkpoints);
  }

  public listEventLog(): readonly ReplayStorageRecord[] {
    return freezeArray(this.eventLog);
  }

  /**
   * Returns a tiny operational hint safe for prompt-adjacent diagnostics.
   */
  public redactForCognition(): CognitiveSafeHardwareReplaySummary {
    const latestHealth = this.checkpoints.at(-1)?.replay_health ?? "invalid";
    const readiness: HardwareReplayReadiness = latestHealth === "replayable"
      ? "ready_for_regression"
      : latestHealth === "degraded"
        ? "degraded_for_qa_only"
        : "invalid_recapture_required";
    return Object.freeze({
      replay_health: latestHealth,
      checkpoint_count: this.checkpoints.length,
      replay_readiness: readiness,
      prompt_safe_summary: latestHealth === "replayable"
        ? "Virtual hardware replay is available to QA; cognition must still rely on live embodied sensor evidence."
        : "Virtual hardware replay is incomplete or degraded and remains QA-only.",
      hidden_fields_removed: freezeArray([
        "replay_id",
        "source_session_id",
        "hardware_manifest_hash",
        "packet_trace",
        "command_trace",
        "health_trace",
        "embodiment_trace",
        "determinism_marker",
        "determinism_hash",
        "storage_writes",
      ]),
    });
  }

  private writeCheckpointRecords(manifest: HardwareReplayManifest, checkpoint: HardwareReplayCheckpoint): readonly ReplayStorageWriteResult[] {
    return freezeArray([
      this.writeRecord("manifest", `hardware_manifest_${manifest.replay_id}_${checkpoint.sequence_index}`, manifest),
      this.writeRecord("checkpoint", checkpoint.checkpoint_ref, checkpoint),
    ]);
  }

  private writeRecord(kind: ReplayStorageRecordKind, key: Ref, payload: unknown): ReplayStorageWriteResult {
    const payloadHash = computeDeterminismHash(payload);
    try {
      return this.storage.writeReplayRecord(Object.freeze({
        storage_key: key,
        replay_id: this.config.replay_id,
        record_kind: kind,
        payload_hash: payloadHash,
        payload,
      }));
    } catch (error) {
      return Object.freeze({
        storage_key: key,
        status: "failed",
        payload_hash: payloadHash,
        message: error instanceof Error ? error.message : "Unknown hardware replay storage failure.",
      });
    }
  }

  private recordEvent(kind: ReplayStorageRecordKind, key: Ref, hash: string): void {
    const event: ReplayStorageRecord = Object.freeze({
      storage_key: `hardware_replay_event_${this.config.replay_id}_${this.eventLog.length}`,
      replay_id: this.config.replay_id,
      record_kind: "event",
      payload_hash: hash,
      payload: Object.freeze({ kind, key, hash }),
    });
    this.eventLog.push(event);
    if (this.eventLog.length > this.maxEventLogEntries) {
      this.eventLog.splice(0, this.eventLog.length - this.maxEventLogEntries);
    }
  }
}

export function recordHardwareReplayCheckpoint(
  input: HardwareReplayCheckpointInput,
  config: HardwareReplayRecorderConfig,
): HardwareReplayCheckpoint {
  return new HardwareReplayRecorder(config).recordHardwareCheckpoint(input);
}

function buildPacketTrace(replayId: Ref, sequenceIndex: number, input: HardwareReplayCheckpointInput): HardwarePacketReplayTrace {
  const packets = deduplicatePackets([
    ...(input.adapter_batch?.packets ?? []),
    ...(input.packets ?? []),
  ]);
  const busRecordsByPacketRef = new Map<Ref, SensorPacketBusRecord>((input.observation_bundle?.packet_records ?? []).map((record) => [record.packet_ref, record]));
  const provenance = input.provenance_report ?? input.observation_bundle?.provenance_report;
  const provenanceByPacketRef = new Map<Ref, SensorBusProvenanceReport["packet_provenance_refs"][number]>((provenance?.packet_provenance_refs ?? []).map((record) => [record.packet_ref, record]));
  const packetRecords = packets.map((packet) => packetRecord(packet, busRecordsByPacketRef.get(packet.packet_id), provenanceByPacketRef.get(packet.packet_id)));
  const timingInterval = resolvePacketInterval(packetRecords, input.observation_bundle?.timestamp_interval);
  const tokenRefs = [...new Set(packetRecords.map((record) => record.synchronization_token_ref).filter(isDefined))].sort();
  const blocked = packetRecords.filter((record) => record.packet_status === "blocked" || record.health_status === "blocked").length;
  const degraded = packetRecords.filter((record) => record.packet_status === "degraded" || record.health_status === "degraded").length;
  const stale = packetRecords.filter((record) => record.health_status === "stale" || record.bus_readiness === "stale").length;
  const missing = (input.observation_bundle?.sensor_health_report.missing_sensors.length ?? input.sensor_health_report?.missing_sensors.length) ?? 0;
  const base = {
    trace_ref: `hardware_packet_trace_${replayId}_${sequenceIndex}`,
    packet_records: freezeArray(packetRecords.sort((a, b) => a.packet_ref.localeCompare(b.packet_ref))),
    observation_bundle_ref: input.observation_bundle?.bundle_id,
    sensor_health_report_ref: input.observation_bundle?.sensor_health_report.sensor_health_report_id ?? input.sensor_health_report?.sensor_health_report_id,
    provenance_report_ref: provenance?.provenance_report_ref,
    synchronization_token_refs: freezeArray(tokenRefs),
    blocked_packet_count: blocked,
    degraded_packet_count: degraded,
    stale_packet_count: stale,
    missing_packet_count: missing,
    timing_interval: timingInterval,
    completeness: classifyPacketCompleteness(packetRecords, input.observation_bundle, missing, blocked),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function packetRecord(
  packet: VirtualHardwarePacket,
  busRecord: SensorPacketBusRecord | undefined,
  provenance: SensorBusProvenanceReport["packet_provenance_refs"][number] | undefined,
): HardwarePacketReplayRecord {
  const base = {
    packet_ref: packet.packet_id,
    packet_kind: packet.packet_kind,
    sensor_ref: packet.sensor_id,
    manifest_id: packet.manifest_id,
    timestamp_interval: freezeInterval(packet.timestamp_interval),
    source_tick: provenance?.source_tick ?? packet.provenance.source_tick,
    source_time_s: round6(provenance?.source_time_s ?? packet.provenance.source_time_s),
    synchronization_token_ref: provenance?.synchronization_token_ref ?? packet.provenance.synchronization_token_ref,
    calibration_ref: provenance?.calibration_ref ?? packet.provenance.calibration_ref,
    health_status: busRecord?.health_status ?? packet.health_status,
    packet_status: packet.packet_status,
    confidence: round6(packet.confidence),
    bus_readiness: busRecord?.readiness,
    cognitive_visibility: "packet_ref_only_for_replay" as const,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function buildCommandTrace(
  replayId: Ref,
  sequenceIndex: number,
  reports: readonly HardwareActuatorCommandApplicationReport[],
): HardwareCommandReplayTrace {
  const sourceReportRefs = reports.map((report) => report.report_ref).sort();
  const commandRecords = reports.flatMap((report) => report.application_records.map((record) => commandRecord(record, report.report_ref)));
  const feedbackRecords = reports.flatMap((report) => report.feedback_packets.map((packet) => feedbackRecord(packet)));
  const rejected = reports.flatMap((report) => report.rejected_commands.map((record) => rejectionRecord(record, report.report_ref)));
  const delayedRefs = [...new Set(reports.flatMap((report) => report.delayed_command_ids))].sort();
  const acceptedBoundaryRefs = reports.flatMap((report) => report.accepted_boundary_commands.map(boundaryCommandRef)).sort();
  const safeHoldRefs = reports.filter((report) => report.safe_hold_required).map((report) => report.report_ref).sort();
  const base = {
    trace_ref: `hardware_command_trace_${replayId}_${sequenceIndex}`,
    source_report_refs: freezeArray(sourceReportRefs),
    accepted_boundary_command_refs: freezeArray(acceptedBoundaryRefs),
    command_records: freezeArray(commandRecords.sort((a, b) => a.application_time_s - b.application_time_s || a.command_ref.localeCompare(b.command_ref))),
    feedback_records: freezeArray(feedbackRecords.sort((a, b) => a.feedback_packet_ref.localeCompare(b.feedback_packet_ref))),
    rejected_command_records: freezeArray(rejected.sort((a, b) => a.command_ref.localeCompare(b.command_ref))),
    delayed_command_refs: freezeArray(delayedRefs),
    safe_hold_report_refs: freezeArray(safeHoldRefs),
    completeness: reports.length === 0 ? "missing" as const : "complete" as const,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function commandRecord(record: HardwareCommandApplicationRecord, sourceReportRef: Ref): HardwareCommandReplayRecord {
  const base = {
    command_ref: record.command_id,
    actuator_ref: record.actuator_id,
    command_mode: record.command_mode,
    application_status: record.application_status,
    target_timestamp_s: round6(record.target_timestamp_s),
    application_time_s: round6(record.application_time_s),
    latency_ms: round3(record.latency_ms),
    saturation_flags: freezeArray(record.saturation_flags.map((flag) => String(flag)).sort()),
    source_report_ref: sourceReportRef,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function feedbackRecord(packet: HardwareActuatorCommandApplicationReport["feedback_packets"][number]): HardwareFeedbackReplayRecord {
  const base = {
    feedback_packet_ref: packet.feedback_packet_id,
    command_ref: packet.command_ref,
    actuator_ref: packet.actuator_id,
    application_status: packet.applied_status,
    latency_ms: round3(packet.latency_ms),
    health_status: packet.health_status,
    saturation_flags: freezeArray(packet.saturation_flags.map((flag) => String(flag)).sort()),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function rejectionRecord(record: HardwareGatewayRejection, sourceReportRef: Ref): HardwareCommandReplayTrace["rejected_command_records"][number] {
  return Object.freeze({
    command_ref: record.command_id,
    reason_code: record.reason_code,
    source_report_ref: sourceReportRef,
  });
}

function boundaryCommandRef(command: HardwareSimulationBoundaryCommand): Ref {
  return `${command.boundary_command_id}:${command.command_ref}`;
}

function buildHealthTrace(replayId: Ref, sequenceIndex: number, input: HardwareReplayCheckpointInput): HardwareHealthReplayTrace {
  const report = input.hardware_health_report;
  const healthReport = input.sensor_health_report ?? input.observation_bundle?.sensor_health_report;
  const diagnostics = report?.diagnostics.map(healthDiagnosticRecord) ?? [];
  const safeHolds = report?.safe_hold_triggers.map(safeHoldRecord) ?? [];
  const base = {
    trace_ref: `hardware_health_trace_${replayId}_${sequenceIndex}`,
    source_report_ref: report?.report_ref,
    health_status: report?.health_status,
    recommended_action: report?.recommended_action,
    diagnostic_records: freezeArray(diagnostics.sort((a, b) => a.diagnostic_ref.localeCompare(b.diagnostic_ref))),
    safe_hold_records: freezeArray(safeHolds.sort((a, b) => a.trigger_ref.localeCompare(b.trigger_ref))),
    sensor_health_report_ref: healthReport?.sensor_health_report_id,
    missing_sensor_count: healthReport?.missing_sensors.length ?? 0,
    blocked_packet_count: healthReport?.blocked_packets.length ?? 0,
    degraded_sensor_count: healthReport?.degraded_sensors.length ?? 0,
    synchronization_spread_ms: round3(healthReport?.synchronization_spread_ms ?? 0),
    completeness: report === undefined && healthReport === undefined ? "missing" as const : report === undefined ? "partial" as const : "complete" as const,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function healthDiagnosticRecord(diagnostic: HardwareHealthDiagnostic): HardwareHealthReplayRecord {
  const base = {
    diagnostic_ref: diagnostic.diagnostic_id,
    failure_mode: diagnostic.failure_mode,
    severity: diagnostic.severity,
    issue_code: diagnostic.issue_code,
    source_ref: diagnostic.source_ref,
    affected_hardware_refs: freezeArray([...diagnostic.affected_hardware_refs].sort()),
    recommended_action: diagnostic.recommended_action,
    safe_hold_required: diagnostic.safe_hold_required,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function safeHoldRecord(trigger: HardwareSafeHoldTrigger): HardwareSafeHoldReplayRecord {
  const base = {
    trigger_ref: trigger.trigger_ref,
    source_diagnostic_ref: trigger.source_diagnostic_ref,
    source_ref: trigger.source_ref,
    failure_mode: trigger.failure_mode,
    recommended_action: trigger.recommended_action,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function buildEmbodimentTrace(replayId: Ref, sequenceIndex: number, input: HardwareReplayCheckpointInput): HardwareEmbodimentReplayTrace {
  const adaptation = input.embodiment_adaptation_report;
  const contract = input.embodiment_contract_packet;
  const hiddenFields = [
    ...(adaptation?.hidden_fields_removed ?? []),
    ...(contract?.hidden_fields_removed ?? []),
  ];
  const base = {
    trace_ref: `hardware_embodiment_trace_${replayId}_${sequenceIndex}`,
    adaptation_report_ref: adaptation?.report_ref,
    contract_ref: contract === undefined ? undefined : `embodiment_contract_${contract.embodiment_kind}_${computeDeterminismHash(contract).slice(0, 12)}`,
    embodiment_kind: adaptation?.embodiment_kind ?? contract?.embodiment_kind,
    sensor_mount_count: adaptation?.sensor_mounts.length ?? 0,
    contact_site_count: adaptation?.contact_sites.length ?? 0,
    actuator_mapping_count: adaptation?.actuator_mappings.length ?? 0,
    adaptation_ok: adaptation?.ok,
    hidden_fields_removed: freezeArray([...new Set(hiddenFields)].sort()),
    completeness: adaptation === undefined && contract === undefined ? "missing" as const : adaptation === undefined || contract === undefined ? "partial" as const : "complete" as const,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function validateCheckpointInput(manifestId: Ref, input: HardwareReplayCheckpointInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (input.adapter_batch !== undefined && input.adapter_batch.manifest_id !== manifestId) {
    issues.push(makeIssue("error", "ManifestMismatch", "$.adapter_batch.manifest_id", "Adapter batch manifest does not match recorder manifest.", "Route adapter batches by hardware manifest."));
  }
  if (input.observation_bundle !== undefined && input.observation_bundle.manifest_id !== manifestId) {
    issues.push(makeIssue("error", "ObservationBundleMismatch", "$.observation_bundle.manifest_id", "Observation bundle manifest does not match recorder manifest.", "Route observation bundles by hardware manifest."));
  }
  for (const [index, packet] of (input.packets ?? []).entries()) {
    validatePacket(packet, manifestId, issues, `$.packets[${index}]`);
  }
  for (const [index, packet] of (input.adapter_batch?.packets ?? []).entries()) {
    validatePacket(packet, manifestId, issues, `$.adapter_batch.packets[${index}]`);
  }
  for (const [index, report] of (input.actuator_application_reports ?? []).entries()) {
    if (report.manifest_id !== manifestId) {
      issues.push(makeIssue("error", "ManifestMismatch", `$.actuator_application_reports[${index}].manifest_id`, "Actuator application report manifest does not match recorder manifest.", "Record reports for the active hardware manifest only."));
    }
  }
  if (input.hardware_health_report !== undefined && input.hardware_health_report.manifest_id !== manifestId) {
    issues.push(makeIssue("error", "ManifestMismatch", "$.hardware_health_report.manifest_id", "Hardware health report manifest does not match recorder manifest.", "Evaluate health with the active hardware manifest."));
  }
  if (input.embodiment_adaptation_report !== undefined && input.embodiment_adaptation_report.manifest_id !== manifestId) {
    issues.push(makeIssue("error", "ManifestMismatch", "$.embodiment_adaptation_report.manifest_id", "Embodiment adaptation report manifest does not match recorder manifest.", "Build the adaptation report from the active hardware manifest."));
  }
  return issues;
}

function validatePacket(packet: VirtualHardwarePacket, manifestId: Ref, issues: ValidationIssue[], path: string): void {
  if (packet.manifest_id !== manifestId) {
    issues.push(makeIssue("error", "PacketManifestMismatch", `${path}.manifest_id`, `Packet ${packet.packet_id} manifest does not match recorder manifest.`, "Drop packets from other manifests before replay capture."));
  }
  if (!isFiniteInterval(packet.timestamp_interval)) {
    issues.push(makeIssue("error", "PacketTimestampInvalid", `${path}.timestamp_interval`, `Packet ${packet.packet_id} has invalid timestamps.`, "Use finite monotonic packet intervals."));
  }
  if (packet.provenance.manifest_id.length === 0 || packet.provenance.calibration_ref.length === 0 || packet.determinism_hash.length === 0) {
    issues.push(makeIssue("error", "PacketProvenanceMissing", `${path}.provenance`, `Packet ${packet.packet_id} has incomplete provenance.`, "Attach packet provenance before replay capture."));
  }
}

function validateTraces(
  packetTrace: HardwarePacketReplayTrace,
  commandTrace: HardwareCommandReplayTrace,
  healthTrace: HardwareHealthReplayTrace,
  embodimentTrace: HardwareEmbodimentReplayTrace,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (packetTrace.completeness === "missing") {
    issues.push(makeIssue("error", "PacketTraceMissing", "$.packet_trace", "Hardware replay cannot be captured without packet records.", "Supply adapter packets or sensor-bus observation bundles."));
  }
  if (commandTrace.completeness === "missing") {
    issues.push(makeIssue("warning", "CommandTraceIncomplete", "$.command_trace", "No actuator command report was supplied.", "Supply command gateway reports when replaying control behavior."));
  }
  if (healthTrace.completeness !== "complete") {
    issues.push(makeIssue("warning", "HealthTraceIncomplete", "$.health_trace", "Hardware health trace is incomplete.", "Supply hardware health and sensor health reports for full QA replay."));
  }
  if (embodimentTrace.completeness !== "complete") {
    issues.push(makeIssue("warning", "EmbodimentTraceIncomplete", "$.embodiment_trace", "Embodiment trace is incomplete.", "Supply adaptation and prompt contract packets for body-aware replay."));
  }
  return freezeArray(issues);
}

function validateConfig(config: HardwareReplayRecorderConfig): void {
  const issues: ValidationIssue[] = [];
  validateRef(config.replay_id, issues, "$.replay_id");
  validateRef(config.source_session_id, issues, "$.source_session_id");
  validateRef(config.manifest_id, issues, "$.manifest_id");
  if (issues.some((issue) => issue.severity === "error")) {
    throw new HardwareReplayRecorderError("Hardware replay recorder configuration failed validation.", issues);
  }
}

function classifyReplayHealth(
  packetTrace: HardwarePacketReplayTrace,
  commandTrace: HardwareCommandReplayTrace,
  healthTrace: HardwareHealthReplayTrace,
  embodimentTrace: HardwareEmbodimentReplayTrace,
  issues: readonly ValidationIssue[],
): HardwareReplayHealthStatus {
  if (issues.some((issue) => issue.severity === "error") || packetTrace.completeness === "missing") {
    return "invalid";
  }
  if (
    packetTrace.completeness !== "complete"
    || commandTrace.completeness !== "complete"
    || healthTrace.completeness !== "complete"
    || embodimentTrace.completeness !== "complete"
    || packetTrace.blocked_packet_count > 0
    || issues.length > 0
  ) {
    return "degraded";
  }
  return "replayable";
}

function classifyPacketCompleteness(
  packetRecords: readonly HardwarePacketReplayRecord[],
  bundle: ObservationBundle | undefined,
  missingPacketCount: number,
  blockedPacketCount: number,
): ReplayTraceCompleteness {
  if (packetRecords.length === 0) {
    return "missing";
  }
  if (bundle?.bundle_status !== "nominal" || missingPacketCount > 0 || blockedPacketCount > 0) {
    return "partial";
  }
  return "complete";
}

function deduplicatePackets(packets: readonly VirtualHardwarePacket[]): readonly VirtualHardwarePacket[] {
  const byId = new Map<Ref, VirtualHardwarePacket>();
  for (const packet of packets) {
    byId.set(packet.packet_id, packet);
  }
  return freezeArray([...byId.values()]);
}

function resolvePacketInterval(records: readonly HardwarePacketReplayRecord[], bundleInterval: HardwareTimestampInterval | undefined): HardwareTimestampInterval {
  if (bundleInterval !== undefined) {
    return freezeInterval(bundleInterval);
  }
  if (records.length === 0) {
    return Object.freeze({ start_s: 0, end_s: 0 });
  }
  return Object.freeze({
    start_s: Math.min(...records.map((record) => record.timestamp_interval.start_s)),
    end_s: Math.max(...records.map((record) => record.timestamp_interval.end_s)),
  });
}

function isFiniteInterval(interval: HardwareTimestampInterval): boolean {
  return Number.isFinite(interval.start_s) && Number.isFinite(interval.end_s) && interval.end_s >= interval.start_s;
}

function freezeInterval(interval: HardwareTimestampInterval): HardwareTimestampInterval {
  return Object.freeze({ start_s: interval.start_s, end_s: interval.end_s });
}

function validateRef(value: string, issues: ValidationIssue[], path: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || /\s/.test(value)) {
    issues.push(makeIssue("error", "HardwareReplayConfigInvalid", path, "Reference must be a non-empty whitespace-free string.", "Use an opaque QA/runtime ref."));
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function round6(value: number): number {
  return Math.round(value * 1000000) / 1000000;
}

function makeIssue(severity: ValidationSeverity, code: HardwareReplayValidationCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

export const HARDWARE_REPLAY_RECORDER_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: VIRTUAL_HARDWARE_MANIFEST_REGISTRY_SCHEMA_VERSION,
  hardware_replay_recorder_schema_version: HARDWARE_REPLAY_RECORDER_SCHEMA_VERSION,
  blueprint: "architecture_docs/04_VIRTUAL_HARDWARE_SENSOR_ACTUATOR_SPEC.md",
  sections: freezeArray(["4.3", "4.13", "4.15.7", "4.16", "4.17", "4.18.2"]),
});
