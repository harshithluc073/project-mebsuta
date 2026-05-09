/**
 * Control telemetry recorder for Project Mebsuta deterministic control.
 *
 * Blueprint: `architecture_docs/11_CONTROL_LAYER_IK_PD_TRAJECTORY_ARCHITECTURE.md`
 * sections 11.5, 11.7.6, 11.7.7, 11.15.3, 11.16, and 11.17.
 *
 * The recorder preserves compact execution evidence for Oops Loop, verifier,
 * dashboard, and QA replay consumers. It records only runtime control
 * telemetry, sensor-derived summaries, actuator-limit summaries, and opaque
 * evidence references. Hidden simulator truth, backend handles, QA labels, and
 * verbose solver internals are rejected or redacted before a bundle may cross
 * into cognitive correction or external observability.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type {
  Ref,
  TimestampInterval,
  ValidationIssue,
  ValidationSeverity,
} from "../simulation/world_manifest";
import type {
  ActuatorLimitEnforcementReport,
} from "./actuator_limit_enforcer";
import type {
  ExecutionMonitorReport,
  ExecutionProgressClassification,
} from "./execution_monitor";
import type {
  ControlTelemetryPacket,
  PDActuatorSaturationFlag,
  PDAnomalyEvent,
  PDAnomalySeverity,
} from "./pd_control_service";

export const CONTROL_TELEMETRY_RECORDER_SCHEMA_VERSION = "mebsuta.control_telemetry_recorder.v1" as const;

const EPSILON = 1e-9;
const DEFAULT_PRE_ANOMALY_WINDOW_S = 2;
const DEFAULT_POST_ANOMALY_WINDOW_S = 1;
const DEFAULT_MAX_RECORDED_PACKETS = 64;
const DEFAULT_MAX_EVIDENCE_RECORDS = 48;
const DEFAULT_MAX_SUMMARY_CHARS = 240;
const DEFAULT_HISTORY_LIMIT = 256;
const DEFAULT_MAX_TELEMETRY_AGE_S = 30;
const HIDDEN_TELEMETRY_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|qa_success|qa_label|qa_only|simulator truth|mesh_name|asset_id|benchmark_truth|oracle_pose|internal_solver_details|private_debug|oracle)/i;

export type ControlEvidenceKind =
  | "control_telemetry"
  | "execution_monitor"
  | "anomaly_event"
  | "contact"
  | "imu"
  | "visual"
  | "audio"
  | "actuator_limit"
  | "prior_plan"
  | "dashboard"
  | "qa_replay";

export type ControlTelemetryRecorderDecision =
  | "recorded"
  | "recorded_with_warnings"
  | "oops_bundle_ready"
  | "rejected";

export type ControlTelemetryRecorderIssueCode =
  | "TelemetryWindowMissing"
  | "TelemetryPacketInvalid"
  | "MonitorReportMissing"
  | "AnomalyMissing"
  | "EvidenceRecordInvalid"
  | "TimingInvalid"
  | "TelemetryStale"
  | "HiddenTelemetryLeak"
  | "PolicyInvalid"
  | "BundleIncomplete";

export type ControlTelemetryRecorderRoute =
  | "dashboard_only"
  | "qa_replay"
  | "verification"
  | "oops_loop"
  | "safe_hold_review";

/**
 * Sensor or contextual evidence record supplied by monitor, perception, audio,
 * contact, or orchestration code. The recorder stores compact text plus opaque
 * references; it does not store raw sensor payloads.
 */
export interface ControlEvidenceRecord {
  readonly evidence_ref: Ref;
  readonly evidence_kind: ControlEvidenceKind;
  readonly captured_at_s: number;
  readonly summary: string;
  readonly confidence?: number;
  readonly source_refs: readonly Ref[];
  readonly cognitive_visibility: "control_evidence_summary";
  readonly determinism_hash: string;
}

/**
 * Telemetry packet reduced to the fields allowed by File 11 cognitive and QA
 * evidence contracts.
 */
export interface RecordedControlTelemetryPacket {
  readonly telemetry_ref: Ref;
  readonly work_order_ref: Ref;
  readonly primitive_ref: Ref;
  readonly timestamp_interval: TimestampInterval;
  readonly tracking_error_summary: string;
  readonly actuator_saturation_flags: readonly PDActuatorSaturationFlag[];
  readonly contact_state_summary?: string;
  readonly imu_stability_summary?: string;
  readonly deadline_status: ControlTelemetryPacket["deadline_status"];
  readonly anomaly_refs: readonly Ref[];
  readonly determinism_hash: string;
}

/**
 * Compact telemetry window captured around a monitor tick or anomaly.
 */
export interface RecordedTelemetryWindow {
  readonly window_ref: Ref;
  readonly captured_at_s: number;
  readonly timestamp_interval: TimestampInterval;
  readonly packet_count: number;
  readonly telemetry_packets: readonly RecordedControlTelemetryPacket[];
  readonly saturation_summary: string;
  readonly anomaly_summary: string;
  readonly progress_classification: ExecutionProgressClassification;
  readonly determinism_hash: string;
}

/**
 * Oops-ready bundle assembled from anomaly, telemetry, sensor evidence, and
 * prior-plan references.
 */
export interface ControlEvidenceBundle {
  readonly evidence_ref: Ref;
  readonly anomaly_event: PDAnomalyEvent;
  readonly telemetry_window_ref: Ref;
  readonly telemetry_refs: readonly Ref[];
  readonly sensor_evidence_refs: readonly Ref[];
  readonly actuator_evidence_refs: readonly Ref[];
  readonly prior_plan_ref?: Ref;
  readonly tracking_summary: string;
  readonly contact_summary?: string;
  readonly imu_summary?: string;
  readonly saturation_summary: string;
  readonly monitor_decision: ExecutionMonitorReport["decision"];
  readonly progress_classification: ExecutionProgressClassification;
  readonly immediate_control_action: PDAnomalyEvent["immediate_control_action"];
  readonly oops_eligible: boolean;
  readonly human_review_required: boolean;
  readonly cognitive_visibility: "oops_control_evidence_without_hidden_truth";
  readonly determinism_hash: string;
}

/**
 * Dashboard-facing state packet with no raw telemetry payloads.
 */
export interface ControlDashboardTelemetryPacket {
  readonly dashboard_ref: Ref;
  readonly captured_at_s: number;
  readonly active_primitive_ref: Ref;
  readonly decision: ExecutionMonitorReport["decision"];
  readonly progress_classification: ExecutionProgressClassification;
  readonly deadline_status: ControlTelemetryPacket["deadline_status"];
  readonly anomaly_count: number;
  readonly safe_hold_required: boolean;
  readonly oops_eligible: boolean;
  readonly telemetry_ref_count: number;
  readonly evidence_ref_count: number;
  readonly determinism_hash: string;
}

/**
 * QA replay manifest for deterministic reinspection of the recorded interval.
 */
export interface ControlQaReplayPacket {
  readonly replay_ref: Ref;
  readonly captured_at_s: number;
  readonly telemetry_window_ref: Ref;
  readonly report_ref: Ref;
  readonly monitor_report_ref: Ref;
  readonly anomaly_refs: readonly Ref[];
  readonly retained_history_count: number;
  readonly replay_seed_hint: string;
  readonly determinism_hash: string;
}

/**
 * Recorder policy controlling window selection, compaction, and leak handling.
 */
export interface ControlTelemetryRecorderPolicy {
  readonly pre_anomaly_window_s?: number;
  readonly post_anomaly_window_s?: number;
  readonly max_recorded_packets?: number;
  readonly max_evidence_records?: number;
  readonly max_summary_chars?: number;
  readonly max_history_records?: number;
  readonly max_telemetry_age_s?: number;
  readonly require_anomaly_for_oops_bundle?: boolean;
  readonly reject_hidden_identifiers?: boolean;
  readonly redact_hidden_text?: boolean;
}

/**
 * File 11 recorder input.
 */
export interface ControlTelemetryRecorderInput {
  readonly request_ref?: Ref;
  readonly telemetry_window: readonly ControlTelemetryPacket[];
  readonly execution_monitor_report: ExecutionMonitorReport;
  readonly current_time_s: number;
  readonly selected_anomaly_ref?: Ref;
  readonly prior_plan_ref?: Ref;
  readonly actuator_enforcement_report?: ActuatorLimitEnforcementReport;
  readonly sensor_evidence_records?: readonly ControlEvidenceRecord[];
  readonly route_hint?: ControlTelemetryRecorderRoute;
  readonly policy?: ControlTelemetryRecorderPolicy;
}

/**
 * Full recorder result returned to orchestration, Oops Loop, dashboard, and QA.
 */
export interface ControlTelemetryRecorderReport {
  readonly schema_version: typeof CONTROL_TELEMETRY_RECORDER_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/11_CONTROL_LAYER_IK_PD_TRAJECTORY_ARCHITECTURE.md";
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly decision: ControlTelemetryRecorderDecision;
  readonly recommended_route: ControlTelemetryRecorderRoute;
  readonly recorded_window: RecordedTelemetryWindow;
  readonly evidence_bundle?: ControlEvidenceBundle;
  readonly dashboard_packet: ControlDashboardTelemetryPacket;
  readonly qa_replay_packet: ControlQaReplayPacket;
  readonly evidence_records: readonly ControlEvidenceRecord[];
  readonly redacted_fields: readonly string[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "control_telemetry_recorder_report";
  readonly determinism_hash: string;
}

interface NormalizedRecorderPolicy {
  readonly pre_anomaly_window_s: number;
  readonly post_anomaly_window_s: number;
  readonly max_recorded_packets: number;
  readonly max_evidence_records: number;
  readonly max_summary_chars: number;
  readonly max_history_records: number;
  readonly max_telemetry_age_s: number;
  readonly require_anomaly_for_oops_bundle: boolean;
  readonly reject_hidden_identifiers: boolean;
  readonly redact_hidden_text: boolean;
}

interface RecorderHistoryRecord {
  readonly report_ref: Ref;
  readonly captured_at_s: number;
  readonly telemetry_window_ref: Ref;
  readonly anomaly_refs: readonly Ref[];
  readonly route: ControlTelemetryRecorderRoute;
  readonly determinism_hash: string;
}

/**
 * Bounded in-memory recorder for File 11 control telemetry. Production callers
 * may persist the returned report to their own storage boundary; this class
 * deliberately avoids hidden simulator or filesystem side effects.
 */
export class ControlTelemetryRecorder {
  private readonly history: RecorderHistoryRecord[] = [];

  /**
   * Records a compact telemetry window and assembles an Oops-ready evidence
   * bundle when the monitor provides an eligible anomaly.
   */
  public record(input: ControlTelemetryRecorderInput): ControlTelemetryRecorderReport {
    const policy = normalizePolicy(input.policy);
    const issues: ValidationIssue[] = [];
    const redactedFields: string[] = [];
    const requestRef = sanitizeRef(input.request_ref ?? `control_telemetry_record_${Math.round(input.current_time_s * 1_000_000)}`);
    validateInput(input, policy, issues);

    const selectedAnomaly = selectAnomaly(input.execution_monitor_report, input.selected_anomaly_ref, issues);
    const recordedWindow = buildRecordedWindow(input, selectedAnomaly, policy, redactedFields, issues);
    const evidenceRecords = buildEvidenceRecords(input, policy, redactedFields, issues);
    const evidenceBundle = selectedAnomaly === undefined
      ? undefined
      : buildEvidenceBundle(input, selectedAnomaly, recordedWindow, evidenceRecords, policy, redactedFields, issues);
    const recommendedRoute = decideRoute(input, selectedAnomaly, evidenceBundle);
    const dashboardPacket = buildDashboardPacket(input, recordedWindow, evidenceRecords, selectedAnomaly);
    const reportRef = `control_telemetry_report_${computeDeterminismHash({
      requestRef,
      monitor: input.execution_monitor_report.report_ref,
      telemetryWindow: recordedWindow.window_ref,
      selectedAnomaly: selectedAnomaly?.anomaly_ref,
      evidenceBundle: evidenceBundle?.evidence_ref,
    })}`;
    const qaReplayPacket = buildQaReplayPacket(input, recordedWindow, reportRef, selectedAnomaly, this.history.length);
    const decision = decideRecorder(selectedAnomaly, evidenceBundle, issues);
    const base = {
      schema_version: CONTROL_TELEMETRY_RECORDER_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/11_CONTROL_LAYER_IK_PD_TRAJECTORY_ARCHITECTURE.md" as const,
      report_ref: reportRef,
      request_ref: requestRef,
      decision,
      recommended_route: recommendedRoute,
      recorded_window: recordedWindow,
      evidence_bundle: evidenceBundle,
      dashboard_packet: dashboardPacket,
      qa_replay_packet: qaReplayPacket,
      evidence_records: evidenceRecords,
      redacted_fields: freezeArray(redactedFields),
      issues: freezeArray(issues),
      ok: decision !== "rejected",
      cognitive_visibility: "control_telemetry_recorder_report" as const,
    };
    const report = Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
    this.remember(report, policy);
    return report;
  }

  /**
   * Returns a deterministic snapshot of retained recorder history.
   */
  public readHistory(): readonly RecorderHistoryRecord[] {
    return freezeArray(this.history);
  }

  private remember(report: ControlTelemetryRecorderReport, policy: NormalizedRecorderPolicy): void {
    const base = {
      report_ref: report.report_ref,
      captured_at_s: report.dashboard_packet.captured_at_s,
      telemetry_window_ref: report.recorded_window.window_ref,
      anomaly_refs: report.recorded_window.telemetry_packets.flatMap((packet) => packet.anomaly_refs),
      route: report.recommended_route,
    };
    this.history.push(Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    }));
    while (this.history.length > policy.max_history_records) {
      this.history.shift();
    }
  }
}

/**
 * Convenience function for stateless callers.
 */
export function recordControlTelemetry(input: ControlTelemetryRecorderInput): ControlTelemetryRecorderReport {
  return new ControlTelemetryRecorder().record(input);
}

function normalizePolicy(policy?: ControlTelemetryRecorderPolicy): NormalizedRecorderPolicy {
  return Object.freeze({
    pre_anomaly_window_s: positiveOrDefault(policy?.pre_anomaly_window_s, DEFAULT_PRE_ANOMALY_WINDOW_S),
    post_anomaly_window_s: positiveOrDefault(policy?.post_anomaly_window_s, DEFAULT_POST_ANOMALY_WINDOW_S),
    max_recorded_packets: integerOrDefault(policy?.max_recorded_packets, DEFAULT_MAX_RECORDED_PACKETS),
    max_evidence_records: integerOrDefault(policy?.max_evidence_records, DEFAULT_MAX_EVIDENCE_RECORDS),
    max_summary_chars: integerOrDefault(policy?.max_summary_chars, DEFAULT_MAX_SUMMARY_CHARS),
    max_history_records: integerOrDefault(policy?.max_history_records, DEFAULT_HISTORY_LIMIT),
    max_telemetry_age_s: positiveOrDefault(policy?.max_telemetry_age_s, DEFAULT_MAX_TELEMETRY_AGE_S),
    require_anomaly_for_oops_bundle: policy?.require_anomaly_for_oops_bundle ?? true,
    reject_hidden_identifiers: policy?.reject_hidden_identifiers ?? true,
    redact_hidden_text: policy?.redact_hidden_text ?? true,
  });
}

function validateInput(input: ControlTelemetryRecorderInput, policy: NormalizedRecorderPolicy, issues: ValidationIssue[]): void {
  validateFinite(input.current_time_s, issues, "$.current_time_s", "TimingInvalid");
  validateRef(input.execution_monitor_report.report_ref, issues, "$.execution_monitor_report.report_ref", "MonitorReportMissing", policy.reject_hidden_identifiers);
  validateRef(input.execution_monitor_report.active_primitive_ref, issues, "$.execution_monitor_report.active_primitive_ref", "MonitorReportMissing", policy.reject_hidden_identifiers);
  if (input.telemetry_window.length === 0) {
    issues.push(makeIssue("error", "TelemetryWindowMissing", "$.telemetry_window", "ControlTelemetryRecorder requires at least one telemetry packet.", "Pass the telemetry window captured by PDControlService and ExecutionMonitor."));
  }
  for (const packet of input.telemetry_window) {
    validateRef(packet.telemetry_ref, issues, "$.telemetry_window.telemetry_ref", "TelemetryPacketInvalid", policy.reject_hidden_identifiers);
    validateRef(packet.work_order_ref, issues, "$.telemetry_window.work_order_ref", "TelemetryPacketInvalid", policy.reject_hidden_identifiers);
    validateRef(packet.primitive_ref, issues, "$.telemetry_window.primitive_ref", "TelemetryPacketInvalid", policy.reject_hidden_identifiers);
    validateFinite(packet.timestamp_interval.start_s, issues, "$.telemetry_window.timestamp_interval.start_s", "TimingInvalid");
    validateFinite(packet.timestamp_interval.end_s, issues, "$.telemetry_window.timestamp_interval.end_s", "TimingInvalid");
    if (packet.timestamp_interval.end_s < packet.timestamp_interval.start_s - EPSILON) {
      issues.push(makeIssue("error", "TelemetryPacketInvalid", "$.telemetry_window.timestamp_interval", "Telemetry packet interval is inverted.", "Emit telemetry with start <= end."));
    }
    if (input.current_time_s - packet.timestamp_interval.end_s > policy.max_telemetry_age_s + EPSILON) {
      issues.push(makeIssue("warning", "TelemetryStale", "$.telemetry_window.timestamp_interval.end_s", "Telemetry packet is older than the recorder retention freshness window.", "Capture a fresher control telemetry window before correction."));
    }
  }
  for (const record of input.sensor_evidence_records ?? []) {
    validateEvidenceRecord(record, policy, issues);
  }
  if (input.prior_plan_ref !== undefined) {
    validateRef(input.prior_plan_ref, issues, "$.prior_plan_ref", "EvidenceRecordInvalid", policy.reject_hidden_identifiers);
  }
}

function validateEvidenceRecord(record: ControlEvidenceRecord, policy: NormalizedRecorderPolicy, issues: ValidationIssue[]): void {
  validateRef(record.evidence_ref, issues, "$.sensor_evidence_records.evidence_ref", "EvidenceRecordInvalid", policy.reject_hidden_identifiers);
  validateFinite(record.captured_at_s, issues, "$.sensor_evidence_records.captured_at_s", "TimingInvalid");
  if (record.summary.trim().length === 0) {
    issues.push(makeIssue("error", "EvidenceRecordInvalid", "$.sensor_evidence_records.summary", "Evidence summary must not be empty.", "Provide a compact sensor-derived summary."));
  }
  if (record.confidence !== undefined && (!Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1)) {
    issues.push(makeIssue("error", "EvidenceRecordInvalid", "$.sensor_evidence_records.confidence", "Evidence confidence must be in [0, 1].", "Normalize confidence before recorder ingestion."));
  }
  for (const ref of record.source_refs) {
    validateRef(ref, issues, "$.sensor_evidence_records.source_refs", "EvidenceRecordInvalid", policy.reject_hidden_identifiers);
  }
}

function selectAnomaly(report: ExecutionMonitorReport, selectedRef: Ref | undefined, issues: ValidationIssue[]): PDAnomalyEvent | undefined {
  if (report.anomaly_events.length === 0) {
    return undefined;
  }
  if (selectedRef !== undefined) {
    const selected = report.anomaly_events.find((event) => event.anomaly_ref === selectedRef);
    if (selected === undefined) {
      issues.push(makeIssue("warning", "AnomalyMissing", "$.selected_anomaly_ref", "Selected anomaly reference is not present in monitor report.", "Use an anomaly_ref emitted by ExecutionMonitor."));
    } else {
      return selected;
    }
  }
  return [...report.anomaly_events].sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.anomaly_ref.localeCompare(b.anomaly_ref))[0];
}

function buildRecordedWindow(
  input: ControlTelemetryRecorderInput,
  anomaly: PDAnomalyEvent | undefined,
  policy: NormalizedRecorderPolicy,
  redactedFields: string[],
  issues: ValidationIssue[],
): RecordedTelemetryWindow {
  const selectedPackets = selectTelemetryPackets(input.telemetry_window, anomaly, policy, input.current_time_s);
  const packets = freezeArray(selectedPackets.map((packet) => compactTelemetryPacket(packet, policy, redactedFields, issues)));
  const interval = intervalFor(packets, input.current_time_s);
  const saturationSummary = summarizeSaturation(packets.flatMap((packet) => packet.actuator_saturation_flags), policy.max_summary_chars);
  const anomalySummary = summarizeAnomalies(input.execution_monitor_report.anomaly_events, policy.max_summary_chars);
  const base = {
    window_ref: `control_telemetry_window_${computeDeterminismHash({
      telemetryRefs: packets.map((packet) => packet.telemetry_ref),
      anomaly: anomaly?.anomaly_ref,
      currentTime: round6(input.current_time_s),
    })}`,
    captured_at_s: round6(input.current_time_s),
    timestamp_interval: interval,
    packet_count: packets.length,
    telemetry_packets: packets,
    saturation_summary: sanitizeSummary(saturationSummary, "$.recorded_window.saturation_summary", policy, redactedFields, issues),
    anomaly_summary: sanitizeSummary(anomalySummary, "$.recorded_window.anomaly_summary", policy, redactedFields, issues),
    progress_classification: input.execution_monitor_report.progress_classification,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function selectTelemetryPackets(
  telemetry: readonly ControlTelemetryPacket[],
  anomaly: PDAnomalyEvent | undefined,
  policy: NormalizedRecorderPolicy,
  currentTimeS: number,
): readonly ControlTelemetryPacket[] {
  const sorted = [...telemetry].sort((a, b) => a.timestamp_interval.end_s - b.timestamp_interval.end_s);
  if (sorted.length <= policy.max_recorded_packets && anomaly === undefined) {
    return freezeArray(sorted);
  }
  const anomalyRefs = new Set(anomaly?.telemetry_refs ?? []);
  const anchorTime = anomaly === undefined
    ? currentTimeS
    : mean(sorted.filter((packet) => anomalyRefs.has(packet.telemetry_ref)).map((packet) => packet.timestamp_interval.end_s)) || currentTimeS;
  const start = anchorTime - policy.pre_anomaly_window_s;
  const end = anchorTime + policy.post_anomaly_window_s;
  const windowed = sorted.filter((packet) => packet.timestamp_interval.end_s >= start - EPSILON && packet.timestamp_interval.start_s <= end + EPSILON);
  const selected = windowed.length === 0 ? sorted.slice(-policy.max_recorded_packets) : windowed;
  return freezeArray(selected.slice(Math.max(0, selected.length - policy.max_recorded_packets)));
}

function compactTelemetryPacket(
  packet: ControlTelemetryPacket,
  policy: NormalizedRecorderPolicy,
  redactedFields: string[],
  issues: ValidationIssue[],
): RecordedControlTelemetryPacket {
  const base = {
    telemetry_ref: packet.telemetry_ref,
    work_order_ref: packet.work_order_ref,
    primitive_ref: packet.primitive_ref,
    timestamp_interval: Object.freeze({
      start_s: round6(packet.timestamp_interval.start_s),
      end_s: round6(packet.timestamp_interval.end_s),
    }),
    tracking_error_summary: sanitizeSummary(packet.tracking_error_summary, "$.telemetry_window.tracking_error_summary", policy, redactedFields, issues),
    actuator_saturation_flags: freezeArray(packet.actuator_saturation_flags.map((flag) => Object.freeze({ ...flag, ratio: round6(flag.ratio) }))),
    contact_state_summary: packet.contact_state_summary === undefined ? undefined : sanitizeSummary(packet.contact_state_summary, "$.telemetry_window.contact_state_summary", policy, redactedFields, issues),
    imu_stability_summary: packet.imu_stability_summary === undefined ? undefined : sanitizeSummary(packet.imu_stability_summary, "$.telemetry_window.imu_stability_summary", policy, redactedFields, issues),
    deadline_status: packet.deadline_status,
    anomaly_refs: freezeArray(packet.anomaly_candidates.map((event) => event.anomaly_ref).sort()),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function buildEvidenceRecords(
  input: ControlTelemetryRecorderInput,
  policy: NormalizedRecorderPolicy,
  redactedFields: string[],
  issues: ValidationIssue[],
): readonly ControlEvidenceRecord[] {
  const supplied = input.sensor_evidence_records ?? [];
  const generated: ControlEvidenceRecord[] = [
    makeEvidenceRecord("execution_monitor", input.execution_monitor_report.report_ref, input.current_time_s, monitorSummary(input.execution_monitor_report), [input.execution_monitor_report.report_ref], 1, policy, redactedFields, issues),
  ];
  if (input.actuator_enforcement_report !== undefined) {
    generated.push(makeEvidenceRecord("actuator_limit", input.actuator_enforcement_report.report_ref, input.current_time_s, actuatorSummary(input.actuator_enforcement_report), [input.actuator_enforcement_report.report_ref], input.actuator_enforcement_report.ok ? 1 : 0.5, policy, redactedFields, issues));
  }
  for (const anomaly of input.execution_monitor_report.anomaly_events) {
    generated.push(makeEvidenceRecord("anomaly_event", anomaly.anomaly_ref, input.current_time_s, anomalySummary(anomaly), [anomaly.anomaly_ref, ...anomaly.telemetry_refs, ...(anomaly.sensor_evidence_refs ?? [])], confidenceForSeverity(anomaly.severity), policy, redactedFields, issues));
  }
  if (input.prior_plan_ref !== undefined) {
    generated.push(makeEvidenceRecord("prior_plan", input.prior_plan_ref, input.current_time_s, `Prior plan ${input.prior_plan_ref} retained as correction context.`, [input.prior_plan_ref], 1, policy, redactedFields, issues));
  }
  const sanitizedSupplied = supplied.map((record) => sanitizeEvidenceRecord(record, policy, redactedFields, issues));
  const byRef = new Map<Ref, ControlEvidenceRecord>();
  for (const record of [...sanitizedSupplied, ...generated]) {
    if (!byRef.has(record.evidence_ref)) {
      byRef.set(record.evidence_ref, record);
    }
  }
  return freezeArray([...byRef.values()].sort((a, b) => a.captured_at_s - b.captured_at_s || a.evidence_ref.localeCompare(b.evidence_ref)).slice(-policy.max_evidence_records));
}

function buildEvidenceBundle(
  input: ControlTelemetryRecorderInput,
  anomaly: PDAnomalyEvent,
  window: RecordedTelemetryWindow,
  evidenceRecords: readonly ControlEvidenceRecord[],
  policy: NormalizedRecorderPolicy,
  redactedFields: string[],
  issues: ValidationIssue[],
): ControlEvidenceBundle | undefined {
  if (policy.require_anomaly_for_oops_bundle && !anomaly.oops_eligible) {
    issues.push(makeIssue("warning", "BundleIncomplete", "$.execution_monitor_report.anomaly_events", "Selected anomaly is not Oops eligible.", "Route this record to dashboard or QA replay instead of correction."));
    return undefined;
  }
  const telemetryRefs = freezeArray(window.telemetry_packets.map((packet) => packet.telemetry_ref));
  const sensorRefs = freezeArray([...new Set([
    ...input.execution_monitor_report.sensor_evidence_refs,
    ...(anomaly.sensor_evidence_refs ?? []),
    ...evidenceRecords.flatMap((record) => record.evidence_kind === "contact" || record.evidence_kind === "imu" || record.evidence_kind === "visual" || record.evidence_kind === "audio" ? [record.evidence_ref] : []),
  ])].sort());
  const actuatorRefs = freezeArray(evidenceRecords.filter((record) => record.evidence_kind === "actuator_limit").map((record) => record.evidence_ref));
  if (telemetryRefs.length === 0) {
    issues.push(makeIssue("error", "BundleIncomplete", "$.recorded_window.telemetry_packets", "Oops evidence bundle requires telemetry refs.", "Capture at least one telemetry packet around the anomaly."));
  }
  const base = {
    evidence_ref: `control_evidence_bundle_${computeDeterminismHash({
      anomaly: anomaly.anomaly_ref,
      telemetryRefs,
      sensorRefs,
      priorPlan: input.prior_plan_ref,
    })}`,
    anomaly_event: anomaly,
    telemetry_window_ref: window.window_ref,
    telemetry_refs: telemetryRefs,
    sensor_evidence_refs: sensorRefs,
    actuator_evidence_refs: actuatorRefs,
    prior_plan_ref: input.prior_plan_ref,
    tracking_summary: sanitizeSummary(window.telemetry_packets.at(-1)?.tracking_error_summary ?? "No tracking telemetry summary captured.", "$.evidence_bundle.tracking_summary", policy, redactedFields, issues),
    contact_summary: latestOptionalSummary(window.telemetry_packets, "contact"),
    imu_summary: latestOptionalSummary(window.telemetry_packets, "imu"),
    saturation_summary: window.saturation_summary,
    monitor_decision: input.execution_monitor_report.decision,
    progress_classification: input.execution_monitor_report.progress_classification,
    immediate_control_action: anomaly.immediate_control_action,
    oops_eligible: anomaly.oops_eligible,
    human_review_required: anomaly.human_review_required === true || input.execution_monitor_report.human_review_required,
    cognitive_visibility: "oops_control_evidence_without_hidden_truth" as const,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function buildDashboardPacket(
  input: ControlTelemetryRecorderInput,
  window: RecordedTelemetryWindow,
  evidenceRecords: readonly ControlEvidenceRecord[],
  anomaly: PDAnomalyEvent | undefined,
): ControlDashboardTelemetryPacket {
  const base = {
    dashboard_ref: `control_dashboard_${computeDeterminismHash({
      monitor: input.execution_monitor_report.report_ref,
      window: window.window_ref,
      anomaly: anomaly?.anomaly_ref,
    })}`,
    captured_at_s: round6(input.current_time_s),
    active_primitive_ref: input.execution_monitor_report.active_primitive_ref,
    decision: input.execution_monitor_report.decision,
    progress_classification: input.execution_monitor_report.progress_classification,
    deadline_status: input.execution_monitor_report.deadline_status,
    anomaly_count: input.execution_monitor_report.anomaly_events.length,
    safe_hold_required: input.execution_monitor_report.safe_hold_required,
    oops_eligible: input.execution_monitor_report.oops_eligible,
    telemetry_ref_count: window.packet_count,
    evidence_ref_count: evidenceRecords.length,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function buildQaReplayPacket(
  input: ControlTelemetryRecorderInput,
  window: RecordedTelemetryWindow,
  reportRef: Ref,
  anomaly: PDAnomalyEvent | undefined,
  retainedHistoryCount: number,
): ControlQaReplayPacket {
  const anomalyRefs = anomaly === undefined
    ? input.execution_monitor_report.anomaly_events.map((event) => event.anomaly_ref)
    : [anomaly.anomaly_ref];
  const base = {
    replay_ref: `control_qa_replay_${computeDeterminismHash({
      reportRef,
      window: window.window_ref,
      anomalies: anomalyRefs,
    })}`,
    captured_at_s: round6(input.current_time_s),
    telemetry_window_ref: window.window_ref,
    report_ref: reportRef,
    monitor_report_ref: input.execution_monitor_report.report_ref,
    anomaly_refs: freezeArray([...anomalyRefs].sort()),
    retained_history_count: retainedHistoryCount,
    replay_seed_hint: computeDeterminismHash({
      telemetryRefs: window.telemetry_packets.map((packet) => packet.telemetry_ref),
      monitor: input.execution_monitor_report.determinism_hash,
      actuator: input.actuator_enforcement_report?.determinism_hash,
    }),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function decideRecorder(
  anomaly: PDAnomalyEvent | undefined,
  bundle: ControlEvidenceBundle | undefined,
  issues: readonly ValidationIssue[],
): ControlTelemetryRecorderDecision {
  if (issues.some((issue) => issue.severity === "error")) {
    return "rejected";
  }
  if (bundle !== undefined && anomaly?.oops_eligible === true) {
    return "oops_bundle_ready";
  }
  if (issues.some((issue) => issue.severity === "warning")) {
    return "recorded_with_warnings";
  }
  return "recorded";
}

function decideRoute(
  input: ControlTelemetryRecorderInput,
  anomaly: PDAnomalyEvent | undefined,
  bundle: ControlEvidenceBundle | undefined,
): ControlTelemetryRecorderRoute {
  if (input.route_hint !== undefined) {
    return input.route_hint;
  }
  if (input.execution_monitor_report.safe_hold_required || anomaly?.immediate_control_action === "safe_hold") {
    return "safe_hold_review";
  }
  if (bundle !== undefined && anomaly?.oops_eligible === true) {
    return "oops_loop";
  }
  if (input.execution_monitor_report.decision === "complete") {
    return "verification";
  }
  return anomaly === undefined ? "dashboard_only" : "qa_replay";
}

function makeEvidenceRecord(
  kind: ControlEvidenceKind,
  evidenceRef: Ref,
  capturedAtS: number,
  summary: string,
  sourceRefs: readonly Ref[],
  confidence: number,
  policy: NormalizedRecorderPolicy,
  redactedFields: string[],
  issues: ValidationIssue[],
): ControlEvidenceRecord {
  const sanitizedSummary = sanitizeSummary(summary, `$.evidence_records.${evidenceRef}.summary`, policy, redactedFields, issues);
  const base = {
    evidence_ref: sanitizeRef(evidenceRef),
    evidence_kind: kind,
    captured_at_s: round6(capturedAtS),
    summary: sanitizedSummary,
    confidence: boundedConfidence(confidence),
    source_refs: freezeArray(sourceRefs.map(sanitizeRef).sort()),
    cognitive_visibility: "control_evidence_summary" as const,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function sanitizeEvidenceRecord(
  record: ControlEvidenceRecord,
  policy: NormalizedRecorderPolicy,
  redactedFields: string[],
  issues: ValidationIssue[],
): ControlEvidenceRecord {
  const base = {
    evidence_ref: sanitizeRef(record.evidence_ref),
    evidence_kind: record.evidence_kind,
    captured_at_s: round6(record.captured_at_s),
    summary: sanitizeSummary(record.summary, `$.sensor_evidence_records.${record.evidence_ref}.summary`, policy, redactedFields, issues),
    confidence: record.confidence === undefined ? undefined : boundedConfidence(record.confidence),
    source_refs: freezeArray(record.source_refs.map(sanitizeRef).sort()),
    cognitive_visibility: "control_evidence_summary" as const,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function monitorSummary(report: ExecutionMonitorReport): string {
  return `Monitor ${report.decision}; progress ${report.progress_classification}; action ${report.immediate_control_action}; anomalies ${report.anomaly_events.length}; safe_hold ${report.safe_hold_required}.`;
}

function actuatorSummary(report: ActuatorLimitEnforcementReport): string {
  return `Actuator limits ${report.decision}; accepted ${report.accepted_command_count}; clipped ${report.clipped_command_count}; rejected ${report.rejected_command_refs.length}; safe_hold ${report.safe_hold_required}.`;
}

function anomalySummary(event: PDAnomalyEvent): string {
  return `${event.anomaly_type} ${event.severity}; trigger ${event.trigger_signal}; action ${event.immediate_control_action}; oops ${event.oops_eligible}.`;
}

function summarizeSaturation(flags: readonly PDActuatorSaturationFlag[], maxChars: number): string {
  if (flags.length === 0) {
    return "No actuator saturation flags recorded.";
  }
  const byAction = new Map<PDActuatorSaturationFlag["action"], number>();
  let maxRatio = 0;
  for (const flag of flags) {
    byAction.set(flag.action, (byAction.get(flag.action) ?? 0) + 1);
    maxRatio = Math.max(maxRatio, flag.ratio);
  }
  return compactText(`Saturation flags ${flags.length}; clipped ${byAction.get("clipped") ?? 0}; rejected ${byAction.get("rejected") ?? 0}; safe_hold ${byAction.get("safe_hold_required") ?? 0}; max_ratio ${formatNumber(maxRatio)}.`, maxChars);
}

function summarizeAnomalies(events: readonly PDAnomalyEvent[], maxChars: number): string {
  if (events.length === 0) {
    return "No anomaly events recorded.";
  }
  const severe = [...events].sort((a, b) => severityRank(b.severity) - severityRank(a.severity))[0];
  return compactText(`Anomalies ${events.length}; highest ${severe.anomaly_type}/${severe.severity}; action ${severe.immediate_control_action}; oops ${events.some((event) => event.oops_eligible)}.`, maxChars);
}

function latestOptionalSummary(packets: readonly RecordedControlTelemetryPacket[], kind: "contact" | "imu"): string | undefined {
  for (const packet of [...packets].reverse()) {
    const summary = kind === "contact" ? packet.contact_state_summary : packet.imu_stability_summary;
    if (summary !== undefined && summary.trim().length > 0) {
      return summary;
    }
  }
  return undefined;
}

function intervalFor(packets: readonly RecordedControlTelemetryPacket[], currentTimeS: number): TimestampInterval {
  if (packets.length === 0) {
    return Object.freeze({ start_s: round6(currentTimeS), end_s: round6(currentTimeS) });
  }
  return Object.freeze({
    start_s: round6(Math.min(...packets.map((packet) => packet.timestamp_interval.start_s))),
    end_s: round6(Math.max(...packets.map((packet) => packet.timestamp_interval.end_s))),
  });
}

function sanitizeSummary(
  text: string,
  path: string,
  policy: NormalizedRecorderPolicy,
  redactedFields: string[],
  issues: ValidationIssue[],
): string {
  const compact = compactText(text, policy.max_summary_chars);
  if (!HIDDEN_TELEMETRY_PATTERN.test(compact)) {
    return compact;
  }
  if (policy.redact_hidden_text) {
    redactedFields.push(path);
    return compactText(compact.replace(HIDDEN_TELEMETRY_PATTERN, "hidden-detail-redacted"), policy.max_summary_chars);
  }
  issues.push(makeIssue("error", "HiddenTelemetryLeak", path, "Telemetry summary contains hidden simulator, backend, QA, or solver detail.", "Redact hidden implementation detail before recorder output."));
  return compact;
}

function validateRef(ref: Ref | undefined, issues: ValidationIssue[], path: string, code: ControlTelemetryRecorderIssueCode, rejectHidden: boolean): void {
  if (ref === undefined || ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(makeIssue("error", code, path, "Reference must be a non-empty whitespace-free string.", "Use opaque runtime control references."));
    return;
  }
  if (rejectHidden && HIDDEN_TELEMETRY_PATTERN.test(ref)) {
    issues.push(makeIssue("error", "HiddenTelemetryLeak", path, "Reference contains hidden simulator, backend, or QA detail.", "Replace hidden implementation identifiers with opaque refs."));
  }
}

function validateFinite(value: number, issues: ValidationIssue[], path: string, code: ControlTelemetryRecorderIssueCode): void {
  if (!Number.isFinite(value)) {
    issues.push(makeIssue("error", code, path, "Numeric value must be finite.", "Use finite canonical control timestamps and metrics."));
  }
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value <= 0 ? fallback : value;
}

function integerOrDefault(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value <= 0 ? fallback : Math.max(1, Math.round(value));
}

function boundedConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, round6(value)));
}

function confidenceForSeverity(severity: PDAnomalySeverity): number {
  if (severity === "critical") return 1;
  if (severity === "error") return 0.9;
  if (severity === "warning") return 0.7;
  return 0.5;
}

function severityRank(severity: PDAnomalySeverity): number {
  if (severity === "critical") return 4;
  if (severity === "error") return 3;
  if (severity === "warning") return 2;
  return 1;
}

function compactText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd();
}

function sanitizeRef(ref: Ref): Ref {
  return ref.replace(HIDDEN_TELEMETRY_PATTERN, "hidden-detail").trim();
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function formatNumber(value: number): string {
  return round6(value).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

function makeIssue(
  severity: ValidationSeverity,
  code: ControlTelemetryRecorderIssueCode,
  path: string,
  message: string,
  remediation: string,
): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}
