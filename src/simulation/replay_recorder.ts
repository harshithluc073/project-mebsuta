/**
 * Replay recorder for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/03_SIMULATION_AND_PHYSICS_ENGINE_ARCHITECTURE.md`
 * sections 3.3, 3.5, 3.10, 3.15, 3.17.7, 3.18.1, 3.19, 3.20, and 3.21.
 *
 * This service records deterministic replay metadata, command traces,
 * synchronized sensor packet references, disturbance traces, physics hashes,
 * timing metrics, and QA-only truth references. Replay data is simulator truth:
 * it is valid for QA, regression, and debugging, and must never become Gemini
 * Robotics-ER 1.6 prompt context or episodic memory.
 */

import { computeDeterminismHash } from "./world_manifest";
import type { DisturbanceApplicationReport, DisturbanceApplicationRecord, ReplayDisturbanceMarker } from "./disturbance_injection_service";
import type { AppliedCommandRecord, AppliedDisturbanceRecord, PhysicsStepReport } from "./physics_step_scheduler";
import type { PhysicsSynchronizationReport } from "./physics_state_synchronizer";
import type { PhysicsWorldSnapshot } from "./simulation_world_service";
import type { Ref, ReplaySeed, ValidationIssue, ValidationSeverity } from "./world_manifest";

export const REPLAY_RECORDER_SCHEMA_VERSION = "mebsuta.replay_recorder.v1" as const;
const DEFAULT_MAX_EVENT_LOG_ENTRIES = 4096;

export type ReplayStorageRecordKind = "manifest" | "checkpoint" | "determinism_report" | "event";
export type ReplayHealthStatus = "replayable" | "degraded" | "invalid";
export type ReplayTraceCompleteness = "complete" | "partial" | "missing";
export type ReplayWriteStatus = "written" | "updated" | "failed";
export type ReplayComparisonStatus = "match" | "mismatch" | "incomplete";
export type ReplayValidationCode =
  | "ReplayConfigInvalid"
  | "ReplaySeedInvalid"
  | "TraceIncomplete"
  | "ReplayWriteFailed"
  | "DeterminismMarkerUnavailable"
  | "QATruthNotIsolated"
  | "WorldRefMismatch"
  | "SnapshotRefMismatch"
  | "PhysicsTickMismatch"
  | "ReplayMismatch";

export interface ReplayRecorderConfig {
  readonly replay_id: Ref;
  readonly source_session_id: Ref;
  readonly world_manifest_ref: Ref;
  readonly embodiment_manifest_ref: Ref;
  readonly object_manifest_refs: readonly Ref[];
  readonly material_profile_refs: readonly Ref[];
  readonly replay_seed: ReplaySeed;
  readonly disturbance_schedule_ref?: Ref;
  readonly storage_adapter?: ReplayStorageAdapter;
  readonly max_event_log_entries?: number;
}

export interface ReplayManifest {
  readonly schema_version: typeof REPLAY_RECORDER_SCHEMA_VERSION;
  readonly replay_id: Ref;
  readonly source_session_id: Ref;
  readonly world_manifest_ref: Ref;
  readonly embodiment_manifest_ref: Ref;
  readonly object_manifest_refs: readonly Ref[];
  readonly material_profile_refs: readonly Ref[];
  readonly replay_seed_ref: Ref;
  readonly disturbance_schedule_ref?: Ref;
  readonly approved_command_trace_ref: Ref;
  readonly sensor_packet_trace_ref: Ref;
  readonly qa_truth_trace_ref?: Ref;
  readonly determinism_report_ref?: Ref;
  readonly cognitive_visibility: "qa_only";
  readonly determinism_hash: string;
}

export interface ReplayCommandRecord {
  readonly command_id: Ref;
  readonly target_actuator_ref: Ref;
  readonly command_kind: string;
  readonly scheduled_tick: number;
  readonly applied_tick: number;
  readonly control_lag_ms: number;
  readonly priority: number;
  readonly source_step_report_ref: Ref;
  readonly determinism_hash: string;
}

export interface ReplayCommandTrace {
  readonly trace_ref: Ref;
  readonly source_step_report_refs: readonly Ref[];
  readonly command_records: readonly ReplayCommandRecord[];
  readonly rejected_command_count: number;
  readonly deferred_command_count: number;
  readonly completeness: ReplayTraceCompleteness;
  readonly determinism_hash: string;
}

export interface ReplaySensorPacketRecord {
  readonly packet_ref: Ref;
  readonly sensor_kind: string;
  readonly readiness: string;
  readonly synchronization_report_ref: Ref;
  readonly synchronization_token_ref?: Ref;
  readonly determinism_hash: string;
}

export interface ReplaySensorPacketTrace {
  readonly trace_ref: Ref;
  readonly synchronization_report_refs: readonly Ref[];
  readonly synchronization_token_refs: readonly Ref[];
  readonly packet_records: readonly ReplaySensorPacketRecord[];
  readonly blocked_packet_count: number;
  readonly degraded_packet_count: number;
  readonly completeness: ReplayTraceCompleteness;
  readonly determinism_hash: string;
}

export interface ReplayDisturbanceRecord {
  readonly disturbance_id: Ref;
  readonly disturbance_type: string;
  readonly application_status: string;
  readonly physics_tick: number;
  readonly timestamp_s: number;
  readonly replay_marker_ref?: Ref;
  readonly safe_hold_required: boolean;
  readonly source_report_ref: Ref;
  readonly determinism_hash: string;
}

export interface ReplayDisturbanceTrace {
  readonly trace_ref: Ref;
  readonly source_disturbance_report_refs: readonly Ref[];
  readonly source_step_report_refs: readonly Ref[];
  readonly disturbance_records: readonly ReplayDisturbanceRecord[];
  readonly replay_markers: readonly ReplayDisturbanceMarker[];
  readonly rejected_disturbance_count: number;
  readonly deferred_disturbance_count: number;
  readonly completeness: ReplayTraceCompleteness;
  readonly determinism_hash: string;
}

export interface ReplayTimingMetrics {
  readonly physics_step_mean_ms: number;
  readonly physics_step_max_ms: number;
  readonly control_lag_ms: number;
  readonly sensor_sync_spread_ms: number;
  readonly render_physics_delta_ms: number;
  readonly audio_event_latency_ms: number;
  readonly jitter_ms: number;
  readonly dropped_step_count: number;
  readonly determinism_hash: string;
}

export interface QATruthIsolationPolicy {
  readonly include_qa_truth_trace: boolean;
  readonly qa_truth_trace_ref?: Ref;
  readonly allowed_destinations: readonly ("qa_report" | "developer_debug" | "regression_harness")[];
  readonly forbid_cognitive_export: boolean;
  readonly forbid_memory_export: boolean;
}

export interface ReplayCheckpointInput {
  readonly world_snapshot: PhysicsWorldSnapshot;
  readonly step_reports?: readonly PhysicsStepReport[];
  readonly synchronization_reports?: readonly PhysicsSynchronizationReport[];
  readonly disturbance_reports?: readonly DisturbanceApplicationReport[];
  readonly qa_truth_policy: QATruthIsolationPolicy;
}

export interface ReplayCheckpoint {
  readonly schema_version: typeof REPLAY_RECORDER_SCHEMA_VERSION;
  readonly checkpoint_ref: Ref;
  readonly replay_id: Ref;
  readonly sequence_index: number;
  readonly world_ref: Ref;
  readonly physics_snapshot_ref: Ref;
  readonly physics_tick: number;
  readonly timestamp_s: number;
  readonly replay_manifest: ReplayManifest;
  readonly command_trace: ReplayCommandTrace;
  readonly sensor_packet_trace: ReplaySensorPacketTrace;
  readonly disturbance_trace: ReplayDisturbanceTrace;
  readonly qa_truth_trace_ref?: Ref;
  readonly timing_metrics: ReplayTimingMetrics;
  readonly prior_checkpoint_hash?: string;
  readonly determinism_marker: string;
  readonly replay_health: ReplayHealthStatus;
  readonly storage_writes: readonly ReplayStorageWriteResult[];
  readonly issues: readonly ValidationIssue[];
  readonly cognitive_visibility: "qa_only";
  readonly determinism_hash: string;
}

export interface ReplayDeterminismReport {
  readonly schema_version: typeof REPLAY_RECORDER_SCHEMA_VERSION;
  readonly determinism_report_ref: Ref;
  readonly replay_id: Ref;
  readonly comparison_status: ReplayComparisonStatus;
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

export interface ReplayStorageRecord {
  readonly storage_key: Ref;
  readonly replay_id: Ref;
  readonly record_kind: ReplayStorageRecordKind;
  readonly payload_hash: string;
  readonly payload: unknown;
}

export interface ReplayStorageWriteResult {
  readonly storage_key: Ref;
  readonly status: ReplayWriteStatus;
  readonly payload_hash: string;
  readonly message: string;
}

export interface ReplayStorageAdapter {
  writeReplayRecord(record: ReplayStorageRecord): ReplayStorageWriteResult;
  readReplayRecord?(storageKey: Ref): ReplayStorageRecord | undefined;
  listReplayRecords?(replayId: Ref): readonly ReplayStorageRecord[];
}

export interface CognitiveSafeReplaySummary {
  readonly replay_health: ReplayHealthStatus;
  readonly checkpoint_count: number;
  readonly replay_readiness: "ready_for_regression" | "degraded_for_qa_only" | "invalid_recapture_required";
  readonly prompt_safe_summary: string;
  readonly hidden_fields_removed: readonly string[];
}

export class InMemoryReplayStorageAdapter implements ReplayStorageAdapter {
  private readonly records: Map<Ref, ReplayStorageRecord> = new Map();

  public writeReplayRecord(record: ReplayStorageRecord): ReplayStorageWriteResult {
    const status: ReplayWriteStatus = this.records.has(record.storage_key) ? "updated" : "written";
    this.records.set(record.storage_key, freezeStorageRecord(record));
    return Object.freeze({
      storage_key: record.storage_key,
      status,
      payload_hash: record.payload_hash,
      message: `${record.record_kind} record persisted in deterministic in-memory replay storage.`,
    });
  }

  public readReplayRecord(storageKey: Ref): ReplayStorageRecord | undefined {
    return this.records.get(storageKey);
  }

  public listReplayRecords(replayId: Ref): readonly ReplayStorageRecord[] {
    return freezeArray([...this.records.values()].filter((record) => record.replay_id === replayId).sort((a, b) => a.storage_key.localeCompare(b.storage_key)));
  }
}

export class ReplayRecorderError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "ReplayRecorderError";
    this.issues = issues;
  }
}

/**
 * Records replay manifests, checkpoints, and determinism reports.
 */
export class ReplayRecorder {
  private readonly storage: ReplayStorageAdapter;
  private readonly checkpoints: ReplayCheckpoint[] = [];
  private readonly eventLog: ReplayStorageRecord[] = [];
  private readonly maxEventLogEntries: number;

  public constructor(private readonly config: ReplayRecorderConfig) {
    validateConfig(config);
    this.storage = config.storage_adapter ?? new InMemoryReplayStorageAdapter();
    this.maxEventLogEntries = config.max_event_log_entries ?? DEFAULT_MAX_EVENT_LOG_ENTRIES;
    assertPositiveInteger(this.maxEventLogEntries, "max_event_log_entries");
  }

  public recordReplayCheckpoint(input: ReplayCheckpointInput): ReplayCheckpoint {
    validateCheckpointInput(input, this.config);
    const commandTrace = buildCommandTrace(this.config.replay_id, input.world_snapshot.physics_tick, input.step_reports ?? []);
    const sensorTrace = buildSensorPacketTrace(this.config.replay_id, input.world_snapshot.physics_tick, input.synchronization_reports ?? []);
    const disturbanceTrace = buildDisturbanceTrace(this.config.replay_id, input.world_snapshot.physics_tick, input.disturbance_reports ?? [], input.step_reports ?? []);
    const qaIssues = validateQaTruthPolicy(input.qa_truth_policy);
    const traceIssues = [
      ...validateStepReports(input.world_snapshot, input.step_reports ?? []),
      ...validateSynchronizationReports(input.world_snapshot, input.synchronization_reports ?? []),
      ...validateDisturbanceReports(input.world_snapshot, input.disturbance_reports ?? []),
      ...qaIssues,
    ];
    const timingMetrics = buildTimingMetrics(input.step_reports ?? [], input.synchronization_reports ?? []);
    const manifest = this.createReplayManifest({
      approved_command_trace_ref: commandTrace.trace_ref,
      sensor_packet_trace_ref: sensorTrace.trace_ref,
      qa_truth_trace_ref: input.qa_truth_policy.include_qa_truth_trace ? input.qa_truth_policy.qa_truth_trace_ref : undefined,
    });
    const sequenceIndex = this.checkpoints.length;
    const priorCheckpointHash = this.checkpoints.at(-1)?.determinism_hash;
    const markerBase = {
      replay_id: this.config.replay_id,
      sequence_index: sequenceIndex,
      snapshot_hash: input.world_snapshot.determinism_hash,
      command_trace_hash: commandTrace.determinism_hash,
      sensor_trace_hash: sensorTrace.determinism_hash,
      disturbance_trace_hash: disturbanceTrace.determinism_hash,
      timing_hash: timingMetrics.determinism_hash,
      qa_truth_trace_ref: input.qa_truth_policy.qa_truth_trace_ref,
      prior_checkpoint_hash: priorCheckpointHash,
    };
    const determinismMarker = computeDeterminismHash(markerBase);
    const replayHealth = classifyReplayHealth(commandTrace, sensorTrace, disturbanceTrace, traceIssues);

    const checkpointBase = {
      schema_version: REPLAY_RECORDER_SCHEMA_VERSION,
      checkpoint_ref: `replay_checkpoint_${this.config.replay_id}_${sequenceIndex}`,
      replay_id: this.config.replay_id,
      sequence_index: sequenceIndex,
      world_ref: input.world_snapshot.world_ref,
      physics_snapshot_ref: input.world_snapshot.snapshot_ref,
      physics_tick: input.world_snapshot.physics_tick,
      timestamp_s: input.world_snapshot.timestamp_s,
      replay_manifest: manifest,
      command_trace: commandTrace,
      sensor_packet_trace: sensorTrace,
      disturbance_trace: disturbanceTrace,
      qa_truth_trace_ref: input.qa_truth_policy.include_qa_truth_trace ? input.qa_truth_policy.qa_truth_trace_ref : undefined,
      timing_metrics: timingMetrics,
      prior_checkpoint_hash: priorCheckpointHash,
      determinism_marker: determinismMarker,
      replay_health: replayHealth,
      issues: freezeArray(traceIssues),
      cognitive_visibility: "qa_only" as const,
    };
    const checkpointWithoutWrites = Object.freeze({
      ...checkpointBase,
      storage_writes: freezeArray([] as ReplayStorageWriteResult[]),
      determinism_hash: computeDeterminismHash(checkpointBase),
    });
    const writes = this.writeCheckpointRecords(manifest, checkpointWithoutWrites);
    const checkpoint = Object.freeze({
      ...checkpointWithoutWrites,
      storage_writes: freezeArray(writes),
      determinism_hash: computeDeterminismHash({ checkpointBase, writes }),
    });
    this.checkpoints.push(checkpoint);
    this.recordEvent("checkpoint", checkpoint.checkpoint_ref, checkpoint.determinism_hash);
    return checkpoint;
  }

  public createReplayManifest(input: {
    readonly approved_command_trace_ref: Ref;
    readonly sensor_packet_trace_ref: Ref;
    readonly qa_truth_trace_ref?: Ref;
    readonly determinism_report_ref?: Ref;
  }): ReplayManifest {
    const manifestBase = {
      schema_version: REPLAY_RECORDER_SCHEMA_VERSION,
      replay_id: this.config.replay_id,
      source_session_id: this.config.source_session_id,
      world_manifest_ref: this.config.world_manifest_ref,
      embodiment_manifest_ref: this.config.embodiment_manifest_ref,
      object_manifest_refs: freezeArray([...this.config.object_manifest_refs].sort()),
      material_profile_refs: freezeArray([...this.config.material_profile_refs].sort()),
      replay_seed_ref: this.config.replay_seed.replay_seed_ref,
      disturbance_schedule_ref: this.config.disturbance_schedule_ref,
      approved_command_trace_ref: input.approved_command_trace_ref,
      sensor_packet_trace_ref: input.sensor_packet_trace_ref,
      qa_truth_trace_ref: input.qa_truth_trace_ref,
      determinism_report_ref: input.determinism_report_ref,
      cognitive_visibility: "qa_only" as const,
    };
    return Object.freeze({
      ...manifestBase,
      determinism_hash: computeDeterminismHash(manifestBase),
    });
  }

  public buildDeterminismReport(expected: readonly ReplayCheckpoint[], actual: readonly ReplayCheckpoint[] = this.checkpoints): ReplayDeterminismReport {
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
      issues.push(makeIssue("error", "ReplayMismatch", `$.checkpoints[${index}]`, "Replay determinism marker diverged.", "Replay with the original seed, manifest, command trace, disturbance trace, and synchronized sensor packet references."));
      break;
    }
    if (expected.length !== actual.length) {
      issues.push(makeIssue("error", "TraceIncomplete", "$.checkpoints", "Expected and actual replay checkpoint counts differ.", "Record all fixed-step checkpoints before comparing replay determinism."));
    }
    const status: ReplayComparisonStatus = issues.some((issue) => issue.code === "ReplayMismatch")
      ? "mismatch"
      : expected.length !== actual.length
        ? "incomplete"
        : "match";
    const reportBase = {
      schema_version: REPLAY_RECORDER_SCHEMA_VERSION,
      determinism_report_ref: `replay_determinism_${this.config.replay_id}_${this.checkpoints.length}`,
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
      throw new ReplayRecorderError("Replay determinism report write failed.", [
        makeIssue("error", "ReplayWriteFailed", "$.storage", write.message, "Inspect the replay storage adapter."),
      ]);
    }
    return report;
  }

  public listCheckpoints(): readonly ReplayCheckpoint[] {
    return freezeArray(this.checkpoints);
  }

  public listEventLog(): readonly ReplayStorageRecord[] {
    return freezeArray(this.eventLog);
  }

  public redactForCognition(): CognitiveSafeReplaySummary {
    const latestHealth = this.checkpoints.at(-1)?.replay_health ?? "invalid";
    const readiness: CognitiveSafeReplaySummary["replay_readiness"] = latestHealth === "replayable"
      ? "ready_for_regression"
      : latestHealth === "degraded"
        ? "degraded_for_qa_only"
        : "invalid_recapture_required";
    return Object.freeze({
      replay_health: latestHealth,
      checkpoint_count: this.checkpoints.length,
      replay_readiness: readiness,
      prompt_safe_summary: readiness === "ready_for_regression"
        ? "Replay evidence is available to QA; embodied reasoning should still use sensor evidence only."
        : "Replay evidence is incomplete or degraded and remains QA-only.",
      hidden_fields_removed: freezeArray([
        "replay_id",
        "source_session_id",
        "world_manifest_ref",
        "embodiment_manifest_ref",
        "object_manifest_refs",
        "material_profile_refs",
        "replay_seed_ref",
        "disturbance_schedule_ref",
        "command_trace",
        "sensor_packet_trace",
        "qa_truth_trace_ref",
        "determinism_marker",
        "determinism_hash",
      ]),
    });
  }

  private writeCheckpointRecords(manifest: ReplayManifest, checkpoint: ReplayCheckpoint): readonly ReplayStorageWriteResult[] {
    return freezeArray([
      this.writeRecord("manifest", `manifest_${manifest.replay_id}_${checkpoint.sequence_index}`, manifest),
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
        message: error instanceof Error ? error.message : "Unknown replay storage failure.",
      });
    }
  }

  private recordEvent(kind: ReplayStorageRecordKind, key: Ref, hash: string): void {
    const event: ReplayStorageRecord = Object.freeze({
      storage_key: `event_${this.config.replay_id}_${this.eventLog.length}`,
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

export function recordReplayCheckpoint(
  worldSnapshot: PhysicsWorldSnapshot,
  commandTrace: readonly PhysicsStepReport[],
  sensorTrace: readonly PhysicsSynchronizationReport[],
  disturbanceTrace: readonly DisturbanceApplicationReport[],
  qaTruthPolicy: QATruthIsolationPolicy,
  config: ReplayRecorderConfig,
): ReplayCheckpoint {
  return new ReplayRecorder(config).recordReplayCheckpoint({
    world_snapshot: worldSnapshot,
    step_reports: commandTrace,
    synchronization_reports: sensorTrace,
    disturbance_reports: disturbanceTrace,
    qa_truth_policy: qaTruthPolicy,
  });
}

function buildCommandTrace(replayId: Ref, physicsTick: number, stepReports: readonly PhysicsStepReport[]): ReplayCommandTrace {
  const commands = stepReports.flatMap((report) => report.applied_commands.map((command) => commandRecord(command, report.step_report_id)));
  const base = {
    trace_ref: `command_trace_${replayId}_${physicsTick}`,
    source_step_report_refs: freezeArray(stepReports.map((report) => report.step_report_id).sort()),
    command_records: freezeArray(commands.sort((a, b) => a.applied_tick - b.applied_tick || a.command_id.localeCompare(b.command_id))),
    rejected_command_count: stepReports.reduce((sum, report) => sum + report.rejected_commands.length, 0),
    deferred_command_count: stepReports.reduce((sum, report) => sum + report.deferred_command_ids.length, 0),
    completeness: stepReports.length === 0 ? "missing" as const : "complete" as const,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function commandRecord(command: AppliedCommandRecord, stepReportRef: Ref): ReplayCommandRecord {
  const base = {
    command_id: command.command_id,
    target_actuator_ref: command.target_actuator_ref,
    command_kind: command.command_kind,
    scheduled_tick: command.scheduled_tick,
    applied_tick: command.applied_tick,
    control_lag_ms: command.control_lag_ms,
    priority: command.priority,
    source_step_report_ref: stepReportRef,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function buildSensorPacketTrace(replayId: Ref, physicsTick: number, syncReports: readonly PhysicsSynchronizationReport[]): ReplaySensorPacketTrace {
  const packetRecords = syncReports.flatMap((report) => report.packet_records.map((record) => {
    const base = {
      packet_ref: record.packet_ref,
      sensor_kind: record.sensor_kind,
      readiness: record.readiness,
      synchronization_report_ref: report.report_ref,
      synchronization_token_ref: report.synchronization_token?.token_ref,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }));
  const base = {
    trace_ref: `sensor_trace_${replayId}_${physicsTick}`,
    synchronization_report_refs: freezeArray(syncReports.map((report) => report.report_ref).sort()),
    synchronization_token_refs: freezeArray(syncReports.map((report) => report.synchronization_token?.token_ref).filter(isDefined).sort()),
    packet_records: freezeArray(packetRecords.sort((a, b) => a.packet_ref.localeCompare(b.packet_ref))),
    blocked_packet_count: syncReports.reduce((sum, report) => sum + report.blocked_packet_refs.length, 0),
    degraded_packet_count: syncReports.reduce((sum, report) => sum + report.degraded_packet_refs.length, 0),
    completeness: syncReports.length === 0 ? "missing" as const : syncReports.some((report) => report.synchronization_status !== "synchronized") ? "partial" as const : "complete" as const,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function buildDisturbanceTrace(
  replayId: Ref,
  physicsTick: number,
  reports: readonly DisturbanceApplicationReport[],
  stepReports: readonly PhysicsStepReport[],
): ReplayDisturbanceTrace {
  const fromDisturbanceReports = reports.flatMap((report) => report.applied_disturbances.map((record) => disturbanceRecordFromReport(record, report)));
  const fromStepReports = stepReports.flatMap((report) => report.applied_disturbances.map((record) => disturbanceRecordFromStep(record, report)));
  const markers = reports.flatMap((report) => report.applied_disturbances.map((record) => record.replay_marker));
  const base = {
    trace_ref: `disturbance_trace_${replayId}_${physicsTick}`,
    source_disturbance_report_refs: freezeArray(reports.map((report) => report.report_ref).sort()),
    source_step_report_refs: freezeArray(stepReports.filter((report) => report.applied_disturbances.length > 0).map((report) => report.step_report_id).sort()),
    disturbance_records: freezeArray([...fromDisturbanceReports, ...fromStepReports].sort((a, b) => a.physics_tick - b.physics_tick || a.disturbance_id.localeCompare(b.disturbance_id))),
    replay_markers: freezeArray(markers.sort((a, b) => a.physics_tick - b.physics_tick || a.disturbance_id.localeCompare(b.disturbance_id))),
    rejected_disturbance_count: reports.reduce((sum, report) => sum + report.rejected_disturbances.length, 0) + stepReports.reduce((sum, report) => sum + report.rejected_disturbances.length, 0),
    deferred_disturbance_count: reports.reduce((sum, report) => sum + report.deferred_disturbance_ids.length, 0) + stepReports.reduce((sum, report) => sum + report.deferred_disturbance_ids.length, 0),
    completeness: reports.length === 0 && stepReports.every((report) => report.applied_disturbances.length === 0) ? "partial" as const : "complete" as const,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function disturbanceRecordFromReport(record: DisturbanceApplicationRecord, report: DisturbanceApplicationReport): ReplayDisturbanceRecord {
  const base = {
    disturbance_id: record.disturbance_id,
    disturbance_type: record.disturbance_type,
    application_status: record.application_status,
    physics_tick: report.physics_tick,
    timestamp_s: report.timestamp_s,
    replay_marker_ref: record.replay_marker.replay_marker_ref,
    safe_hold_required: record.safe_hold_required,
    source_report_ref: report.report_ref,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function disturbanceRecordFromStep(record: AppliedDisturbanceRecord, report: PhysicsStepReport): ReplayDisturbanceRecord {
  const base = {
    disturbance_id: record.disturbance_id,
    disturbance_type: record.disturbance_type,
    application_status: "scheduler_applied",
    physics_tick: record.applied_tick,
    timestamp_s: report.completed_tick * report.fixed_dt_s,
    replay_marker_ref: undefined,
    safe_hold_required: record.safety_policy === "safe_hold_if_severe",
    source_report_ref: report.step_report_id,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function buildTimingMetrics(stepReports: readonly PhysicsStepReport[], syncReports: readonly PhysicsSynchronizationReport[]): ReplayTimingMetrics {
  const stepMean = maxOrZero(stepReports.map((report) => report.timing_health.physics_step_mean_ms));
  const stepMax = maxOrZero(stepReports.map((report) => report.timing_health.physics_step_max_ms));
  const controlLag = Math.max(maxOrZero(stepReports.map((report) => report.timing_health.control_lag_ms)), maxOrZero(syncReports.map((report) => report.control_lag_ms)));
  const sensorSpread = Math.max(maxOrZero(stepReports.map((report) => report.timing_health.sensor_sync_spread_ms)), maxOrZero(syncReports.map((report) => report.sensor_sync_spread_ms)));
  const renderDelta = Math.max(maxOrZero(stepReports.map((report) => report.timing_health.render_physics_delta_ms)), maxOrZero(syncReports.map((report) => report.render_physics_delta_ms)));
  const audioLatency = Math.max(maxOrZero(stepReports.map((report) => report.timing_health.audio_event_latency_ms)), maxOrZero(syncReports.map((report) => report.audio_event_latency_ms)));
  const jitter = maxOrZero(stepReports.map((report) => report.timing_health.jitter_ms));
  const dropped = stepReports.reduce((sum, report) => sum + report.timing_health.dropped_step_count, 0);
  const base = {
    physics_step_mean_ms: round3(stepMean),
    physics_step_max_ms: round3(stepMax),
    control_lag_ms: round3(controlLag),
    sensor_sync_spread_ms: round3(sensorSpread),
    render_physics_delta_ms: round3(renderDelta),
    audio_event_latency_ms: round3(audioLatency),
    jitter_ms: round3(jitter),
    dropped_step_count: dropped,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function validateCheckpointInput(input: ReplayCheckpointInput, config: ReplayRecorderConfig): void {
  const issues: ValidationIssue[] = [];
  if (input.world_snapshot.world_ref !== config.world_manifest_ref) {
    issues.push(makeIssue("warning", "WorldRefMismatch", "$.world_snapshot.world_ref", "Snapshot world_ref differs from configured world_manifest_ref.", "Confirm the replay config references the runtime world manifest."));
  }
  if (input.world_snapshot.cognitive_visibility !== "forbidden_to_cognition") {
    issues.push(makeIssue("error", "QATruthNotIsolated", "$.world_snapshot.cognitive_visibility", "Physics snapshots must remain QA/runtime-only.", "Never route replay snapshots to cognition or memory."));
  }
  issues.push(...validateQaTruthPolicy(input.qa_truth_policy));
  if (issues.some((issue) => issue.severity === "error")) {
    throw new ReplayRecorderError("Replay checkpoint input failed validation.", issues);
  }
}

function validateStepReports(snapshot: PhysicsWorldSnapshot, reports: readonly PhysicsStepReport[]): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const report of reports) {
    if (report.world_ref !== snapshot.world_ref) {
      issues.push(makeIssue("error", "WorldRefMismatch", `$.step_reports.${report.step_report_id}`, "Step report world_ref does not match the checkpoint snapshot.", "Use step reports from the same world."));
    }
    if (report.snapshot_ref !== snapshot.snapshot_ref) {
      issues.push(makeIssue("warning", "SnapshotRefMismatch", `$.step_reports.${report.step_report_id}`, "Step report snapshot_ref differs from checkpoint snapshot.", "Record checkpoints at the same boundary as the step report."));
    }
    if (report.completed_tick > snapshot.physics_tick) {
      issues.push(makeIssue("error", "PhysicsTickMismatch", `$.step_reports.${report.step_report_id}`, "Step report is from a future physics tick.", "Record replay checkpoints after the current step completes."));
    }
  }
  return freezeArray(issues);
}

function validateSynchronizationReports(snapshot: PhysicsWorldSnapshot, reports: readonly PhysicsSynchronizationReport[]): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const report of reports) {
    if (report.world_ref !== snapshot.world_ref) {
      issues.push(makeIssue("error", "WorldRefMismatch", `$.synchronization_reports.${report.report_ref}`, "Synchronization report world_ref does not match snapshot.", "Use synchronized packets from the same world."));
    }
    if (report.physics_snapshot_ref !== snapshot.snapshot_ref) {
      issues.push(makeIssue("error", "SnapshotRefMismatch", `$.synchronization_reports.${report.report_ref}`, "Sensor trace references a different physics snapshot.", "Rebuild the sensor bundle from the checkpoint snapshot."));
    }
    if (report.physics_tick !== snapshot.physics_tick) {
      issues.push(makeIssue("error", "PhysicsTickMismatch", `$.synchronization_reports.${report.report_ref}`, "Sensor trace physics tick differs from checkpoint snapshot.", "Use a sensor trace from the same physics tick."));
    }
  }
  return freezeArray(issues);
}

function validateDisturbanceReports(snapshot: PhysicsWorldSnapshot, reports: readonly DisturbanceApplicationReport[]): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const report of reports) {
    if (report.world_ref !== snapshot.world_ref) {
      issues.push(makeIssue("error", "WorldRefMismatch", `$.disturbance_reports.${report.report_ref}`, "Disturbance report world_ref does not match snapshot.", "Use disturbance reports from the same world."));
    }
    if (report.physics_tick > snapshot.physics_tick) {
      issues.push(makeIssue("error", "PhysicsTickMismatch", `$.disturbance_reports.${report.report_ref}`, "Disturbance report is from a future tick.", "Record disturbances at or before the checkpoint tick."));
    }
  }
  return freezeArray(issues);
}

function validateQaTruthPolicy(policy: QATruthIsolationPolicy): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!policy.forbid_cognitive_export || !policy.forbid_memory_export) {
    issues.push(makeIssue("error", "QATruthNotIsolated", "$.qa_truth_policy", "QA truth must be barred from cognition and memory.", "Set forbid_cognitive_export and forbid_memory_export to true."));
  }
  if (policy.include_qa_truth_trace) {
    if (policy.qa_truth_trace_ref === undefined || policy.qa_truth_trace_ref.trim().length === 0) {
      issues.push(makeIssue("error", "QATruthNotIsolated", "$.qa_truth_policy.qa_truth_trace_ref", "QA truth trace is enabled but no QA trace ref was supplied.", "Attach a QA-only truth trace ref or disable QA truth trace capture."));
    }
    if (policy.allowed_destinations.some((destination) => destination !== "qa_report" && destination !== "developer_debug" && destination !== "regression_harness")) {
      issues.push(makeIssue("error", "QATruthNotIsolated", "$.qa_truth_policy.allowed_destinations", "QA truth destination is not isolated.", "Use only qa_report, developer_debug, or regression_harness."));
    }
  }
  return freezeArray(issues);
}

function validateConfig(config: ReplayRecorderConfig): void {
  const issues: ValidationIssue[] = [];
  validateRef(config.replay_id, issues, "$.replay_id");
  validateRef(config.source_session_id, issues, "$.source_session_id");
  validateRef(config.world_manifest_ref, issues, "$.world_manifest_ref");
  validateRef(config.embodiment_manifest_ref, issues, "$.embodiment_manifest_ref");
  validateRef(config.replay_seed.replay_seed_ref, issues, "$.replay_seed.replay_seed_ref");
  if (config.replay_seed.visibility !== "qa_only") {
    issues.push(makeIssue("error", "ReplaySeedInvalid", "$.replay_seed.visibility", "Replay seeds must be QA-only.", "Use a ReplaySeed with visibility qa_only."));
  }
  if (!Number.isInteger(config.replay_seed.seed_u32) || config.replay_seed.seed_u32 < 0 || config.replay_seed.seed_u32 > 0xffffffff) {
    issues.push(makeIssue("error", "ReplaySeedInvalid", "$.replay_seed.seed_u32", "Replay seed must be an unsigned 32-bit integer.", "Use an integer in [0, 4294967295]."));
  }
  for (let index = 0; index < config.object_manifest_refs.length; index += 1) {
    validateRef(config.object_manifest_refs[index], issues, `$.object_manifest_refs[${index}]`);
  }
  for (let index = 0; index < config.material_profile_refs.length; index += 1) {
    validateRef(config.material_profile_refs[index], issues, `$.material_profile_refs[${index}]`);
  }
  if (config.object_manifest_refs.length === 0 || config.material_profile_refs.length === 0) {
    issues.push(makeIssue("error", "ReplayConfigInvalid", "$.manifest_refs", "Replay manifest requires object and material refs.", "Capture the fixed initial world manifest closure."));
  }
  if (issues.some((issue) => issue.severity === "error")) {
    throw new ReplayRecorderError("Replay recorder configuration failed validation.", issues);
  }
}

function classifyReplayHealth(
  commandTrace: ReplayCommandTrace,
  sensorTrace: ReplaySensorPacketTrace,
  disturbanceTrace: ReplayDisturbanceTrace,
  issues: readonly ValidationIssue[],
): ReplayHealthStatus {
  if (issues.some((issue) => issue.severity === "error")) {
    return "invalid";
  }
  if (commandTrace.completeness !== "complete" || sensorTrace.completeness !== "complete" || disturbanceTrace.rejected_disturbance_count > 0 || issues.length > 0) {
    return "degraded";
  }
  return "replayable";
}

function freezeStorageRecord(record: ReplayStorageRecord): ReplayStorageRecord {
  return Object.freeze({
    ...record,
  });
}

function validateRef(value: string, issues: ValidationIssue[], path: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || /\s/.test(value)) {
    issues.push(makeIssue("error", "ReplayConfigInvalid", path, "Reference must be non-empty and whitespace-free.", "Use an opaque QA/runtime ref."));
  }
}

function makeIssue(severity: ValidationSeverity, code: ReplayValidationCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
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

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
