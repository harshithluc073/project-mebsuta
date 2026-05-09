/**
 * Verification telemetry recorder for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md`
 * sections 13.5, 13.20, 13.21, and 13.22.
 *
 * The recorder emits deterministic audit events, dashboard metrics, and replay
 * index rows for every verification lifecycle artifact.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import { freezeArray, makeRef, sanitizeRef, sanitizeText, uniqueSorted, validateSafeRef } from "./verification_policy_registry";

export const VERIFICATION_TELEMETRY_RECORDER_SCHEMA_VERSION = "mebsuta.verification_telemetry_recorder.v1" as const;

export type VerificationTelemetryEventKind =
  | "VerificationRequested"
  | "VerificationPolicyResolved"
  | "VerificationViewPlanCreated"
  | "VerificationEvidenceInsufficient"
  | "VisualAssessmentCompleted"
  | "ResidualEvaluationCompleted"
  | "FalsePositiveGuardCompleted"
  | "CertificateIssued"
  | "MemoryCommitDecisionMade"
  | "OopsHandoffCreated";

export interface VerificationTelemetryEvent {
  readonly event_ref: Ref;
  readonly event_kind: VerificationTelemetryEventKind;
  readonly timestamp_ms: number;
  readonly artifact_refs: readonly Ref[];
  readonly severity: "info" | "warning" | "error";
  readonly summary: string;
  readonly determinism_hash: string;
}

export interface VerificationDashboardMetric {
  readonly metric_ref: Ref;
  readonly name: string;
  readonly value: number;
  readonly unit: "count" | "ratio" | "ms";
}

export interface VerificationReplayIndexRecord {
  readonly replay_ref: Ref;
  readonly task_ref: Ref;
  readonly certificate_ref?: Ref;
  readonly evidence_refs: readonly Ref[];
  readonly artifact_refs: readonly Ref[];
  readonly determinism_hash: string;
}

export interface VerificationTelemetryRecorderRequest {
  readonly request_ref?: Ref;
  readonly task_ref: Ref;
  readonly timestamp_ms: number;
  readonly artifact_refs: readonly Ref[];
  readonly evidence_refs: readonly Ref[];
  readonly certificate_ref?: Ref;
  readonly route_decision: "complete" | "reobserve" | "correct" | "safe_hold" | "human_review" | "memory_only";
  readonly confidence: number;
  readonly latency_ms: number;
  readonly notes?: readonly string[];
}

export interface VerificationTelemetryRecorderReport {
  readonly schema_version: typeof VERIFICATION_TELEMETRY_RECORDER_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md";
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly events: readonly VerificationTelemetryEvent[];
  readonly dashboard_metrics: readonly VerificationDashboardMetric[];
  readonly replay_index_record: VerificationReplayIndexRecord;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "verification_telemetry_recorder_report";
  readonly determinism_hash: string;
}

/**
 * Records verification audit and dashboard telemetry.
 */
export class VerificationTelemetryRecorder {
  /**
   * Emits lifecycle events and replay index metadata.
   */
  public recordVerificationTelemetry(request: VerificationTelemetryRecorderRequest): VerificationTelemetryRecorderReport {
    const issues: ValidationIssue[] = [];
    validateRequest(request, issues);
    const requestRef = sanitizeRef(request.request_ref ?? makeRef("verification_telemetry", request.task_ref, request.route_decision));
    const events = buildEvents(request);
    const metrics = buildMetrics(request);
    const replay = buildReplay(request);
    const base = {
      schema_version: VERIFICATION_TELEMETRY_RECORDER_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md" as const,
      report_ref: makeRef("verification_telemetry_report", requestRef, request.route_decision),
      request_ref: requestRef,
      events,
      dashboard_metrics: metrics,
      replay_index_record: replay,
      issues: freezeArray(issues),
      ok: !issues.some((issue) => issue.severity === "error"),
      cognitive_visibility: "verification_telemetry_recorder_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function createVerificationTelemetryRecorder(): VerificationTelemetryRecorder {
  return new VerificationTelemetryRecorder();
}

function validateRequest(request: VerificationTelemetryRecorderRequest, issues: ValidationIssue[]): void {
  validateSafeRef(request.task_ref, "$.task_ref", "HiddenVerificationLeak", issues);
  for (const ref of [...request.artifact_refs, ...request.evidence_refs]) validateSafeRef(ref, "$.refs", "HiddenVerificationLeak", issues);
  if (request.certificate_ref !== undefined) validateSafeRef(request.certificate_ref, "$.certificate_ref", "HiddenVerificationLeak", issues);
}

function buildEvents(request: VerificationTelemetryRecorderRequest): readonly VerificationTelemetryEvent[] {
  const kinds: readonly VerificationTelemetryEventKind[] = [
    "VerificationRequested",
    "VerificationPolicyResolved",
    "VerificationViewPlanCreated",
    request.route_decision === "reobserve" ? "VerificationEvidenceInsufficient" : "VisualAssessmentCompleted",
    "ResidualEvaluationCompleted",
    "FalsePositiveGuardCompleted",
    "CertificateIssued",
    "MemoryCommitDecisionMade",
    request.route_decision === "correct" ? "OopsHandoffCreated" : "CertificateIssued",
  ];
  return freezeArray(kinds.map((kind, index) => {
    const artifactRefs = uniqueSorted(request.artifact_refs);
    const base = {
      event_ref: makeRef("verification_event", request.task_ref, kind, index.toString()),
      event_kind: kind,
      timestamp_ms: request.timestamp_ms + index,
      artifact_refs: artifactRefs,
      severity: request.route_decision === "safe_hold" || request.route_decision === "human_review" ? "warning" as const : "info" as const,
      summary: sanitizeText(`${kind} for route ${request.route_decision}. ${(request.notes ?? []).join(" ")}`),
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }));
}

function buildMetrics(request: VerificationTelemetryRecorderRequest): readonly VerificationDashboardMetric[] {
  return freezeArray([
    metric("verification_confidence", request.confidence, "ratio"),
    metric("verification_latency", request.latency_ms, "ms"),
    metric("artifact_count", request.artifact_refs.length, "count"),
    metric("evidence_count", request.evidence_refs.length, "count"),
    metric("route_safe_hold", request.route_decision === "safe_hold" ? 1 : 0, "count"),
  ]);
}

function metric(name: string, value: number, unit: VerificationDashboardMetric["unit"]): VerificationDashboardMetric {
  return Object.freeze({
    metric_ref: makeRef("verification_metric", name),
    name,
    value: Number.isFinite(value) ? value : 0,
    unit,
  });
}

function buildReplay(request: VerificationTelemetryRecorderRequest): VerificationReplayIndexRecord {
  const base = {
    replay_ref: makeRef("verification_replay", request.task_ref, request.certificate_ref ?? request.route_decision),
    task_ref: sanitizeRef(request.task_ref),
    certificate_ref: request.certificate_ref,
    evidence_refs: uniqueSorted(request.evidence_refs),
    artifact_refs: uniqueSorted(request.artifact_refs),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}
