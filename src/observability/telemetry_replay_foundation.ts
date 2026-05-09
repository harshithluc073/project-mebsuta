/**
 * PIT-B06 observability telemetry replay foundation.
 *
 * Blueprint: `production_readiness_docs/12_OBSERVABILITY_LOGGING_TELEMETRY_PLAN.md`
 * and `architecture_docs/17_INTERNAL_MONOLOGUE_TTS_OBSERVABILITY.md`.
 *
 * This module does not create a server, frontend, storage backend, deployment
 * manifest, or operations workflow. It provides typed production contracts for
 * structured logs, metric samples, trace spans, redaction manifests, alert
 * records, and dashboard/replay evidence projections over the existing
 * observability event, dashboard, replay, and retention modules.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import { DashboardStateProjector } from "./dashboard_state_projector";
import {
  ObservabilityEventEmitter,
  compactText,
  containsForbiddenRuntimeText,
  containsPromptInternalText,
  freezeArray,
  makeIssue,
  makeObservabilityRef,
  severityRank,
  uniqueRefs,
  validateOptionalRef,
  validateRef,
  validateTimestamp,
} from "./observability_event_emitter";
import type {
  DashboardStateSnapshot,
  DashboardVisibility,
  ObservabilityEvent,
  ObservabilityEventClass,
  ObservabilitySeverity,
  ProvenanceStatus,
  ReplayBundle,
} from "./observability_event_emitter";
import { ObservabilityRetentionManager, type RetentionCandidate, type RetentionPolicy } from "./observability_retention_manager";
import { ReplayTraceAssembler, type ReplayRedactionPolicy } from "./replay_trace_assembler";

export const TELEMETRY_REPLAY_FOUNDATION_SCHEMA_VERSION = "mebsuta.observability.telemetry_replay_foundation.v1" as const;
export const TELEMETRY_REPLAY_FOUNDATION_BLUEPRINT_REF = "production_readiness_docs/12_OBSERVABILITY_LOGGING_TELEMETRY_PLAN.md" as const;

const SECRET_PATTERN = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}|\b(?:api|access|private|session|csrf|jwt)[_-]?(?:key|secret|token)\s*[:=]\s*[A-Za-z0-9._~+/=-]{8,}|\b(?:postgres|mysql|mongodb):\/\/[^\s]+/gi;
const QA_TRUTH_PATTERN = /\b(?:qa[_ -]?truth|qa[_ -]?label|benchmark[_ -]?truth|oracle|ground[_ -]?truth)\b/gi;
const PROMPT_PRIVATE_PATTERN = /\b(?:raw[_ -]?prompt|system prompt|developer prompt|chain[_ -]?of[_ -]?thought|scratchpad|private deliberation|raw model)\b/gi;
const HIDDEN_TRUTH_PATTERN = /\b(?:scene[_ -]?graph|object[_ -]?id|hidden[_ -]?pose|hidden[_ -]?state|backend|collision[_ -]?mesh|rigid[_ -]?body|physics[_ -]?body)\b/gi;
const SUCCESS_WITHOUT_CERT_PATTERN = /\b(?:verified|confirmed|complete|success|succeeded|passed)\b/i;

export type TelemetryBoundaryLabel = "runtime" | "qa" | "redacted" | "restricted_quarantine";
export type TelemetryMetricKind = "counter" | "gauge" | "latency_ms" | "rate" | "completeness";
export type TelemetryAlertSeverity = "info" | "warning" | "error" | "critical";
export type TelemetryAlertKind =
  | "hidden_truth_candidate"
  | "secret_redaction"
  | "qa_truth_runtime_visibility"
  | "replay_incomplete"
  | "safety_acknowledgement_missing"
  | "dashboard_projection_stale"
  | "unsupported_success_claim";

export interface ObservabilityTelemetryInput {
  readonly artifact_ref: Ref;
  readonly event_time_ms: number;
  readonly event_class: ObservabilityEventClass;
  readonly subsystem_ref: Ref;
  readonly severity: ObservabilitySeverity;
  readonly summary: string;
  readonly artifact_refs?: readonly Ref[];
  readonly task_ref?: Ref;
  readonly state_ref?: Ref;
  readonly provenance_status?: ProvenanceStatus;
  readonly dashboard_visibility?: DashboardVisibility;
  readonly metric_name: string;
  readonly metric_value: number;
  readonly trace_span_ref?: Ref;
  readonly parent_trace_span_ref?: Ref;
  readonly trace_start_ms: number;
  readonly trace_end_ms: number;
  readonly policy_refs: readonly Ref[];
  readonly requires_safety_acknowledgement?: boolean;
  readonly verification_certificate_refs?: readonly Ref[];
}

export interface TelemetryRedactionManifest {
  readonly schema_version: typeof TELEMETRY_REPLAY_FOUNDATION_SCHEMA_VERSION;
  readonly redaction_manifest_ref: Ref;
  readonly source_ref: Ref;
  readonly boundary_label: TelemetryBoundaryLabel;
  readonly redacted_summary: string;
  readonly rules_applied: readonly string[];
  readonly blocked: boolean;
  readonly audit_required: boolean;
  readonly audit_refs: readonly Ref[];
  readonly determinism_hash: string;
}

export interface StructuredTelemetryLog {
  readonly schema_version: typeof TELEMETRY_REPLAY_FOUNDATION_SCHEMA_VERSION;
  readonly log_ref: Ref;
  readonly event_ref: Ref;
  readonly event_time_ms: number;
  readonly event_class: ObservabilityEventClass;
  readonly subsystem_ref: Ref;
  readonly severity: ObservabilitySeverity;
  readonly boundary_label: TelemetryBoundaryLabel;
  readonly message: string;
  readonly redaction_manifest_ref: Ref;
  readonly replay_refs: readonly Ref[];
  readonly audit_refs: readonly Ref[];
  readonly determinism_hash: string;
}

export interface TelemetryMetricSample {
  readonly schema_version: typeof TELEMETRY_REPLAY_FOUNDATION_SCHEMA_VERSION;
  readonly metric_ref: Ref;
  readonly metric_name: string;
  readonly metric_kind: TelemetryMetricKind;
  readonly value: number;
  readonly unit: string;
  readonly event_ref: Ref;
  readonly subsystem_ref: Ref;
  readonly boundary_label: TelemetryBoundaryLabel;
  readonly sampled_at_ms: number;
  readonly policy_refs: readonly Ref[];
  readonly determinism_hash: string;
}

export interface TelemetryTraceSpan {
  readonly schema_version: typeof TELEMETRY_REPLAY_FOUNDATION_SCHEMA_VERSION;
  readonly trace_span_ref: Ref;
  readonly parent_trace_span_ref?: Ref;
  readonly event_ref: Ref;
  readonly subsystem_ref: Ref;
  readonly span_name: string;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly duration_ms: number;
  readonly boundary_label: TelemetryBoundaryLabel;
  readonly evidence_refs: readonly Ref[];
  readonly policy_refs: readonly Ref[];
  readonly determinism_hash: string;
}

export interface TelemetryAlertRecord {
  readonly schema_version: typeof TELEMETRY_REPLAY_FOUNDATION_SCHEMA_VERSION;
  readonly alert_ref: Ref;
  readonly alert_kind: TelemetryAlertKind;
  readonly severity: TelemetryAlertSeverity;
  readonly source_event_ref: Ref;
  readonly boundary_label: TelemetryBoundaryLabel;
  readonly summary: string;
  readonly required_action: string;
  readonly release_blocking: boolean;
  readonly acknowledged: boolean;
  readonly audit_refs: readonly Ref[];
  readonly determinism_hash: string;
}

export interface TelemetryEventPacket {
  readonly schema_version: typeof TELEMETRY_REPLAY_FOUNDATION_SCHEMA_VERSION;
  readonly event: ObservabilityEvent;
  readonly log_record: StructuredTelemetryLog;
  readonly metric_sample: TelemetryMetricSample;
  readonly trace_span: TelemetryTraceSpan;
  readonly redaction_manifest: TelemetryRedactionManifest;
  readonly alert_records: readonly TelemetryAlertRecord[];
  readonly determinism_hash: string;
}

export interface TelemetryEvidenceProjection {
  readonly schema_version: typeof TELEMETRY_REPLAY_FOUNDATION_SCHEMA_VERSION;
  readonly projection_ref: Ref;
  readonly boundary_label: TelemetryBoundaryLabel;
  readonly dashboard_snapshot: DashboardStateSnapshot;
  readonly replay_bundle: ReplayBundle;
  readonly metric_refs: readonly Ref[];
  readonly trace_refs: readonly Ref[];
  readonly alert_refs: readonly Ref[];
  readonly redaction_manifest_refs: readonly Ref[];
  readonly retention_report_ref?: Ref;
  readonly release_blocking_alert_refs: readonly Ref[];
  readonly determinism_hash: string;
}

export class TelemetryReplayFoundation {
  private readonly emitter = new ObservabilityEventEmitter();
  private readonly dashboardProjector = new DashboardStateProjector();
  private readonly replayAssembler = new ReplayTraceAssembler();
  private readonly retentionManager = new ObservabilityRetentionManager();

  public recordTelemetry(input: ObservabilityTelemetryInput): TelemetryEventPacket {
    const manifest = buildTelemetryRedactionManifest({
      source_ref: input.artifact_ref,
      summary: input.summary,
      provenance_status: input.provenance_status,
      dashboard_visibility: input.dashboard_visibility,
      audit_refs: uniqueRefs([input.artifact_ref, ...(input.artifact_refs ?? []), ...input.policy_refs]),
    });
    const event = this.emitter.emitObservabilityEvent({
      artifact_ref: input.artifact_ref,
      event_time_ms: input.event_time_ms,
      event_class: input.event_class,
      subsystem_ref: input.subsystem_ref,
      severity: alertSeverityToObservability(manifest.blocked ? "critical" : input.severity),
      summary: manifest.redacted_summary,
      artifact_refs: input.artifact_refs,
      task_ref: input.task_ref,
      state_ref: input.state_ref,
      provenance_status: input.provenance_status ?? provenanceForBoundary(manifest.boundary_label),
      dashboard_visibility: visibilityForBoundary(manifest.boundary_label, input.dashboard_visibility),
      metadata: {
        redaction_manifest_ref: manifest.redaction_manifest_ref,
        boundary_label: manifest.boundary_label,
        metric_name: input.metric_name,
      },
    }, { allow_qa_visibility: input.dashboard_visibility === "qa", redact_forbidden_text: true });
    const log = buildStructuredTelemetryLog(event, manifest, []);
    const metric = buildTelemetryMetricSample({
      event,
      metric_name: input.metric_name,
      metric_value: input.metric_value,
      metric_kind: input.metric_name.includes("latency") ? "latency_ms" : "gauge",
      unit: input.metric_name.includes("latency") ? "ms" : "count",
      policy_refs: input.policy_refs,
      boundary_label: manifest.boundary_label,
    });
    const trace = buildTelemetryTraceSpan({
      event,
      span_name: input.metric_name,
      trace_span_ref: input.trace_span_ref,
      parent_trace_span_ref: input.parent_trace_span_ref,
      start_ms: input.trace_start_ms,
      end_ms: input.trace_end_ms,
      evidence_refs: input.artifact_refs ?? [],
      policy_refs: input.policy_refs,
      boundary_label: manifest.boundary_label,
    });
    const alerts = evaluateTelemetryAlerts({
      event,
      redaction_manifest: manifest,
      replay_bundle: undefined,
      requires_safety_acknowledgement: input.requires_safety_acknowledgement ?? false,
      verification_certificate_refs: input.verification_certificate_refs ?? [],
    });
    const base = {
      schema_version: TELEMETRY_REPLAY_FOUNDATION_SCHEMA_VERSION,
      event,
      log_record: log,
      metric_sample: metric,
      trace_span: trace,
      redaction_manifest: manifest,
      alert_records: alerts,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }

  public projectTelemetryEvidence(input: {
    readonly projection_ref: Ref;
    readonly task_ref: Ref;
    readonly projection_time_ms: number;
    readonly packets: readonly TelemetryEventPacket[];
    readonly visibility_mode: DashboardVisibility;
    readonly replay_policy: ReplayRedactionPolicy;
    readonly retention_policy?: RetentionPolicy;
  }): TelemetryEvidenceProjection {
    const events = input.packets.map((packet) => packet.event);
    const replay = this.replayAssembler.assembleReplayTrace(
      input.task_ref,
      { start_ms: Math.min(...events.map((event) => event.event_time_ms)), end_ms: input.projection_time_ms },
      { task_ref: input.task_ref, timeline_events: events },
      input.replay_policy,
    );
    const replayAlerts = evaluateTelemetryAlerts({
      event: events[0],
      redaction_manifest: input.packets[0]?.redaction_manifest,
      replay_bundle: replay,
      requires_safety_acknowledgement: false,
      verification_certificate_refs: [],
    });
    const allAlerts = freezeArray([...input.packets.flatMap((packet) => packet.alert_records), ...replayAlerts]);
    const dashboard = this.dashboardProjector.projectDashboardState({
      snapshot_time_ms: input.projection_time_ms,
      timeline_events: events,
      queued_utterances: freezeArray([]),
      playback_events: freezeArray([]),
      filter_decisions: freezeArray([]),
      active_task_ref: input.task_ref,
    }, input.visibility_mode);
    const retentionReport = input.retention_policy === undefined
      ? undefined
      : this.retentionManager.applyObservabilityRetention(buildRetentionCandidates(input.packets, replay), input.retention_policy, input.projection_time_ms);
    const label = boundaryLabelForPackets(input.packets);
    const base = {
      schema_version: TELEMETRY_REPLAY_FOUNDATION_SCHEMA_VERSION,
      projection_ref: input.projection_ref,
      boundary_label: label,
      dashboard_snapshot: dashboard,
      replay_bundle: replay,
      metric_refs: uniqueRefs(input.packets.map((packet) => packet.metric_sample.metric_ref)),
      trace_refs: uniqueRefs(input.packets.map((packet) => packet.trace_span.trace_span_ref)),
      alert_refs: uniqueRefs(allAlerts.map((alert) => alert.alert_ref)),
      redaction_manifest_refs: uniqueRefs(input.packets.map((packet) => packet.redaction_manifest.redaction_manifest_ref)),
      retention_report_ref: retentionReport?.retention_report_ref,
      release_blocking_alert_refs: uniqueRefs(allAlerts.filter((alert) => alert.release_blocking).map((alert) => alert.alert_ref)),
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function buildTelemetryRedactionManifest(input: {
  readonly source_ref: Ref;
  readonly summary: string;
  readonly provenance_status?: ProvenanceStatus;
  readonly dashboard_visibility?: DashboardVisibility;
  readonly audit_refs?: readonly Ref[];
}): TelemetryRedactionManifest {
  const issues: ValidationIssue[] = [];
  validateRef(input.source_ref, "$.source_ref", issues);
  const boundaryLabel = inferBoundaryLabel(input.provenance_status, input.dashboard_visibility, input.summary);
  const rules: string[] = [];
  let summary = compactText(input.summary, 900);
  summary = replaceWithRule(summary, SECRET_PATTERN, "[redacted_secret]", "secret_redaction", rules);
  summary = replaceWithRule(summary, PROMPT_PRIVATE_PATTERN, "[redacted_prompt_internal]", "prompt_internal_redaction", rules);
  summary = replaceWithRule(summary, HIDDEN_TRUTH_PATTERN, "[redacted_hidden_truth]", "hidden_truth_redaction", rules);
  summary = replaceWithRule(summary, QA_TRUTH_PATTERN, "[redacted_qa_boundary]", "qa_truth_redaction", rules);
  if (containsForbiddenRuntimeText(summary) || containsPromptInternalText(summary)) {
    rules.push("observability_runtime_redaction");
    summary = summary.replace(/\[[^\]]+\]/g, "[redacted]");
  }
  const blocked = boundaryLabel === "restricted_quarantine" || (input.provenance_status === "qa" && input.dashboard_visibility !== "qa");
  const auditRequired = blocked || rules.length > 0;
  const base = {
    schema_version: TELEMETRY_REPLAY_FOUNDATION_SCHEMA_VERSION,
    redaction_manifest_ref: makeObservabilityRef("telemetry_redaction_manifest", input.source_ref, computeDeterminismHash(summary)),
    source_ref: input.source_ref,
    boundary_label: rules.length > 0 && boundaryLabel === "runtime" ? "redacted" as const : boundaryLabel,
    redacted_summary: summary,
    rules_applied: freezeArray([...new Set(rules)]),
    blocked,
    audit_required: auditRequired,
    audit_refs: uniqueRefs([input.source_ref, ...(input.audit_refs ?? [])]),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function buildStructuredTelemetryLog(event: ObservabilityEvent, manifest: TelemetryRedactionManifest, replayRefs: readonly Ref[]): StructuredTelemetryLog {
  const base = {
    schema_version: TELEMETRY_REPLAY_FOUNDATION_SCHEMA_VERSION,
    log_ref: makeObservabilityRef("structured_log", event.observability_event_ref),
    event_ref: event.observability_event_ref,
    event_time_ms: event.event_time_ms,
    event_class: event.event_class,
    subsystem_ref: event.subsystem_ref,
    severity: event.severity,
    boundary_label: manifest.boundary_label,
    message: manifest.redacted_summary,
    redaction_manifest_ref: manifest.redaction_manifest_ref,
    replay_refs: uniqueRefs(replayRefs),
    audit_refs: uniqueRefs([event.observability_event_ref, manifest.redaction_manifest_ref, ...event.artifact_refs]),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function buildTelemetryMetricSample(input: {
  readonly event: ObservabilityEvent;
  readonly metric_name: string;
  readonly metric_kind: TelemetryMetricKind;
  readonly metric_value: number;
  readonly unit: string;
  readonly policy_refs: readonly Ref[];
  readonly boundary_label: TelemetryBoundaryLabel;
}): TelemetryMetricSample {
  const issues: ValidationIssue[] = [];
  validateMetricName(input.metric_name, "$.metric_name", issues);
  validateFiniteMetric(input.metric_value, "$.metric_value", issues);
  const base = {
    schema_version: TELEMETRY_REPLAY_FOUNDATION_SCHEMA_VERSION,
    metric_ref: makeObservabilityRef("telemetry_metric", input.event.observability_event_ref, input.metric_name),
    metric_name: compactText(input.metric_name, 120),
    metric_kind: input.metric_kind,
    value: round6(input.metric_value),
    unit: compactText(input.unit, 32),
    event_ref: input.event.observability_event_ref,
    subsystem_ref: input.event.subsystem_ref,
    boundary_label: input.boundary_label,
    sampled_at_ms: input.event.event_time_ms,
    policy_refs: uniqueRefs(input.policy_refs),
  };
  if (issues.some((issue) => issue.severity === "error")) {
    throw new TelemetryReplayFoundationError("Telemetry metric sample failed validation.", issues);
  }
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function buildTelemetryTraceSpan(input: {
  readonly event: ObservabilityEvent;
  readonly span_name: string;
  readonly trace_span_ref?: Ref;
  readonly parent_trace_span_ref?: Ref;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly evidence_refs: readonly Ref[];
  readonly policy_refs: readonly Ref[];
  readonly boundary_label: TelemetryBoundaryLabel;
}): TelemetryTraceSpan {
  const issues: ValidationIssue[] = [];
  validateOptionalRef(input.trace_span_ref, "$.trace_span_ref", issues);
  validateOptionalRef(input.parent_trace_span_ref, "$.parent_trace_span_ref", issues);
  validateTimestamp(input.start_ms, "$.start_ms", issues);
  validateTimestamp(input.end_ms, "$.end_ms", issues);
  if (input.end_ms < input.start_ms) {
    issues.push(makeIssue("error", "TelemetryTraceSpanReversed", "$.end_ms", "Trace span end must be at or after start.", "Use monotonic millisecond timestamps."));
  }
  const base = {
    schema_version: TELEMETRY_REPLAY_FOUNDATION_SCHEMA_VERSION,
    trace_span_ref: input.trace_span_ref ?? makeObservabilityRef("telemetry_trace_span", input.event.observability_event_ref, input.span_name),
    parent_trace_span_ref: input.parent_trace_span_ref,
    event_ref: input.event.observability_event_ref,
    subsystem_ref: input.event.subsystem_ref,
    span_name: compactText(input.span_name, 160),
    start_ms: input.start_ms,
    end_ms: input.end_ms,
    duration_ms: round6(input.end_ms - input.start_ms),
    boundary_label: input.boundary_label,
    evidence_refs: uniqueRefs(input.evidence_refs),
    policy_refs: uniqueRefs(input.policy_refs),
  };
  if (issues.some((issue) => issue.severity === "error")) {
    throw new TelemetryReplayFoundationError("Telemetry trace span failed validation.", issues);
  }
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function evaluateTelemetryAlerts(input: {
  readonly event?: ObservabilityEvent;
  readonly redaction_manifest?: TelemetryRedactionManifest;
  readonly replay_bundle?: ReplayBundle;
  readonly requires_safety_acknowledgement: boolean;
  readonly verification_certificate_refs: readonly Ref[];
}): readonly TelemetryAlertRecord[] {
  const alerts: TelemetryAlertRecord[] = [];
  const event = input.event;
  const manifest = input.redaction_manifest;
  if (event !== undefined && manifest !== undefined) {
    if (manifest.rules_applied.includes("hidden_truth_redaction")) {
      alerts.push(buildAlert("hidden_truth_candidate", "critical", event, manifest.boundary_label, "Hidden truth candidate was redacted from telemetry.", "Quarantine event and block release until reviewed.", true));
    }
    if (manifest.rules_applied.includes("secret_redaction")) {
      alerts.push(buildAlert("secret_redaction", "critical", event, manifest.boundary_label, "Secret-like content was redacted from telemetry.", "Preserve audit manifest and review source producer.", true));
    }
    if (manifest.rules_applied.includes("qa_truth_redaction") && manifest.boundary_label !== "qa") {
      alerts.push(buildAlert("qa_truth_runtime_visibility", "critical", event, manifest.boundary_label, "QA truth candidate reached a runtime-visible telemetry path.", "Quarantine event and keep QA truth offline.", true));
    }
    if (event.event_class === "safety" && input.requires_safety_acknowledgement) {
      alerts.push(buildAlert("safety_acknowledgement_missing", "critical", event, manifest.boundary_label, "Safety-critical event requires acknowledgement.", "Require acknowledgement before release evidence can pass.", true, false));
    }
    if (SUCCESS_WITHOUT_CERT_PATTERN.test(event.summary) && input.verification_certificate_refs.length === 0) {
      alerts.push(buildAlert("unsupported_success_claim", "error", event, manifest.boundary_label, "Telemetry used success language without certificate refs.", "Downgrade success wording or attach verification certificate evidence.", true));
    }
  }
  if (input.replay_bundle !== undefined && input.replay_bundle.completeness_score < 0.95) {
    const source = event ?? fallbackEvent(input.replay_bundle);
    alerts.push(buildAlert("replay_incomplete", "error", source, manifest?.boundary_label ?? "runtime", "Replay completeness is below release evidence threshold.", "Recapture missing events or mark release evidence incomplete.", true));
  }
  return freezeArray(alerts);
}

function buildAlert(
  kind: TelemetryAlertKind,
  severity: TelemetryAlertSeverity,
  event: ObservabilityEvent,
  boundaryLabel: TelemetryBoundaryLabel,
  summary: string,
  requiredAction: string,
  releaseBlocking: boolean,
  acknowledged = false,
): TelemetryAlertRecord {
  const base = {
    schema_version: TELEMETRY_REPLAY_FOUNDATION_SCHEMA_VERSION,
    alert_ref: makeObservabilityRef("telemetry_alert", kind, event.observability_event_ref),
    alert_kind: kind,
    severity,
    source_event_ref: event.observability_event_ref,
    boundary_label: boundaryLabel,
    summary,
    required_action: requiredAction,
    release_blocking: releaseBlocking,
    acknowledged,
    audit_refs: uniqueRefs([event.observability_event_ref, ...event.artifact_refs]),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function buildRetentionCandidates(packets: readonly TelemetryEventPacket[], replay: ReplayBundle): readonly RetentionCandidate[] {
  return freezeArray([
    ...packets.map((packet) => ({
      record_ref: packet.event.observability_event_ref,
      event: packet.event,
      recorded_at_ms: packet.event.event_time_ms,
      raw_payload_refs: [packet.log_record.log_ref],
    })),
    {
      record_ref: replay.replay_bundle_ref,
      replay_bundle: replay,
      recorded_at_ms: replay.window_end_ms,
      raw_payload_refs: replay.event_refs,
    },
  ]);
}

function inferBoundaryLabel(provenance: ProvenanceStatus | undefined, visibility: DashboardVisibility | undefined, summary: string): TelemetryBoundaryLabel {
  if (provenance === "blocked" || containsForbiddenRuntimeText(summary)) {
    return "restricted_quarantine";
  }
  if (provenance === "qa" || visibility === "qa" || QA_TRUTH_PATTERN.test(summary)) {
    return "qa";
  }
  if (provenance === "redacted") {
    return "redacted";
  }
  return "runtime";
}

function boundaryLabelForPackets(packets: readonly TelemetryEventPacket[]): TelemetryBoundaryLabel {
  if (packets.some((packet) => packet.redaction_manifest.boundary_label === "restricted_quarantine")) {
    return "restricted_quarantine";
  }
  if (packets.some((packet) => packet.redaction_manifest.boundary_label === "qa")) {
    return "qa";
  }
  if (packets.some((packet) => packet.redaction_manifest.boundary_label === "redacted")) {
    return "redacted";
  }
  return "runtime";
}

function visibilityForBoundary(label: TelemetryBoundaryLabel, requested: DashboardVisibility | undefined): DashboardVisibility {
  if (label === "restricted_quarantine") {
    return "hidden";
  }
  if (label === "qa") {
    return "qa";
  }
  return requested ?? "developer";
}

function provenanceForBoundary(label: TelemetryBoundaryLabel): ProvenanceStatus {
  if (label === "restricted_quarantine") {
    return "blocked";
  }
  if (label === "qa") {
    return "qa";
  }
  if (label === "redacted") {
    return "redacted";
  }
  return "runtime_embodied";
}

function alertSeverityToObservability(value: ObservabilitySeverity | TelemetryAlertSeverity): ObservabilitySeverity {
  return value === "critical" ? "critical" : value === "error" ? "error" : value === "warning" ? "warning" : "info";
}

function replaceWithRule(value: string, pattern: RegExp, replacement: string, rule: string, rules: string[]): string {
  pattern.lastIndex = 0;
  if (!pattern.test(value)) {
    return value;
  }
  rules.push(rule);
  pattern.lastIndex = 0;
  return value.replace(pattern, replacement);
}

function validateMetricName(value: string, path: string, issues: ValidationIssue[]): void {
  if (!/^[a-z][a-z0-9_.:-]{1,119}$/i.test(value)) {
    issues.push(makeIssue("error", "TelemetryMetricNameInvalid", path, "Metric name must be a stable machine-readable identifier.", "Use lowercase subsystem.metric style names."));
  }
}

function validateFiniteMetric(value: number, path: string, issues: ValidationIssue[]): void {
  if (!Number.isFinite(value)) {
    issues.push(makeIssue("error", "TelemetryMetricValueInvalid", path, "Metric value must be finite.", "Use a finite numeric metric value."));
  }
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function fallbackEvent(replay: ReplayBundle): ObservabilityEvent {
  const base = {
    observability_event_ref: makeObservabilityRef("replay_fallback_event", replay.replay_bundle_ref),
    event_time_ms: replay.window_end_ms,
    event_class: "qa" as const,
    subsystem_ref: "observability:replay",
    severity: "error" as const,
    summary: "Replay completeness fell below threshold.",
    artifact_refs: replay.evidence_refs,
    provenance_status: "redacted" as const,
    dashboard_visibility: "developer" as const,
    metadata: Object.freeze({ replay_bundle_ref: replay.replay_bundle_ref }),
    validation_issues: freezeArray([]),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export class TelemetryReplayFoundationError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "TelemetryReplayFoundationError";
    this.issues = freezeArray(issues);
  }
}

export function telemetryIssue(severity: ValidationSeverity, code: string, path: string, message: string, remediation: string): ValidationIssue {
  return makeIssue(severity, code, path, message, remediation);
}

export const TELEMETRY_REPLAY_FOUNDATION_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: TELEMETRY_REPLAY_FOUNDATION_SCHEMA_VERSION,
  blueprint: TELEMETRY_REPLAY_FOUNDATION_BLUEPRINT_REF,
  sections: freezeArray(["12.5", "12.7", "12.8", "12.9", "12.10", "12.14", "12.15", "12.17", "12.18", "17.14", "17.17", "17.18", "17.19"]),
  component: "TelemetryReplayFoundation",
});
