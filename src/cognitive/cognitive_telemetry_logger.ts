/**
 * Cognitive telemetry logger for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/06_GEMINI_ROBOTICS_ER_COGNITIVE_LAYER.md`
 * sections 6.6.1, 6.8.2, 6.12.1, 6.18.1, 6.18.2, 6.19, and 6.20.
 *
 * This module records auditable cognitive request metadata, response metadata,
 * validation decisions, latency metrics, redaction decisions, provenance-safe
 * replay references, and QA dataset rows. It keeps raw media and restricted
 * simulator-truth language out of runtime observability while preserving enough
 * structured context for debugging, regression analysis, and safety review.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import {
  GEMINI_ROBOTICS_ER_APPROVED_MODEL,
} from "./gemini_robotics_er_adapter";
import type {
  CognitiveBudgetReport,
  CognitiveInvocationClass,
  CognitiveInvocationPolicy,
  CognitiveLatencyReport,
  CognitiveMediaPart,
  CognitivePromptSection,
  CognitiveRequestEnvelope,
  CognitiveResponseEnvelope,
  CognitiveTelemetryEvent,
  CognitiveTelemetryEventType,
  QuarantineReleaseDecision,
  SemanticValidationStatus,
} from "./gemini_robotics_er_adapter";
import type { CognitiveQueue, DownstreamTarget } from "./cognitive_request_router";
import type { CognitivePacingReport, RetryDecisionReport } from "./rate_limit_and_retry_coordinator";
import type { ResponseQuarantineReport } from "./response_quarantine_service";

export const COGNITIVE_TELEMETRY_LOGGER_SCHEMA_VERSION = "mebsuta.cognitive_telemetry_logger.v1" as const;

const REDACTED_TEXT = "[REDACTED_PROMPT_UNSAFE_CONTENT]" as const;
const REDACTED_MEDIA = "[REDACTED_MEDIA_PAYLOAD]" as const;
const MAX_SUMMARY_CHARS = 1400;
const MAX_QA_ROWS = 10000;
const LATENCY_WARNING_MS = 9000;
const LATENCY_ERROR_MS = 14000;
const FORBIDDEN_OBSERVABILITY_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|qa_|collision_mesh|simulator|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|hidden|chain-of-thought|scratchpad|system prompt|developer prompt|direct actuator|raw actuator|joint torque|joint current|apply force|apply impulse|physics step|reward policy|reinforcement learning|rl update)/i;

export type CognitiveLoggerEventType =
  | CognitiveTelemetryEventType
  | "PromptRegressionResult"
  | "ValidationDecisionRecorded"
  | "RateCoordinatorDecisionRecorded"
  | "RetryDecisionRecorded"
  | "QADatasetRowCreated"
  | "RedactionApplied";

export type TelemetryVisibilityClass = "runtime" | "developer_observability" | "qa_only" | "restricted" | "redacted";
export type ProvenanceSourceClass = "embodied_sensor" | "derived_estimate" | "controller_telemetry" | "policy_config" | "memory" | "qa_truth" | "model_output" | "adapter_metadata";
export type TruthBoundaryStatus = "runtime_embodied_only" | "runtime_policy_only" | "runtime_memory_labeled" | "mixed_with_restricted_data" | "qa_truth_only" | "truth_boundary_violation";
export type RedactionDecision = "none" | "summary_only" | "redacted" | "blocked";
export type MetricAlertLevel = "nominal" | "watch" | "critical";
export type TelemetryRecordClass = "request" | "response" | "validation" | "rate_limit" | "retry" | "qa" | "redaction" | "model_drift";

export interface TelemetryRedactionPolicy {
  readonly policy_ref: Ref;
  readonly redact_media_payloads: boolean;
  readonly redact_prompt_text: boolean;
  readonly redact_raw_response_text: boolean;
  readonly allow_qa_truth: boolean;
  readonly max_summary_chars: number;
}

export interface TelemetryProvenanceManifest {
  readonly manifest_ref: Ref;
  readonly source_classes: readonly ProvenanceSourceClass[];
  readonly forbidden_source_detected: boolean;
  readonly cognitive_visibility: "allowed" | "summarized" | "redacted" | "forbidden";
  readonly memory_visibility: "allowed" | "summary_only" | "forbidden";
  readonly qa_visibility: "allowed" | "forbidden";
  readonly truth_boundary_status: TruthBoundaryStatus;
  readonly audit_notes: readonly string[];
  readonly determinism_hash: string;
}

export interface TelemetryRedactionReport {
  readonly schema_version: typeof COGNITIVE_TELEMETRY_LOGGER_SCHEMA_VERSION;
  readonly redaction_report_ref: Ref;
  readonly source_ref: Ref;
  readonly decision: RedactionDecision;
  readonly visibility_class: TelemetryVisibilityClass;
  readonly rules_applied: readonly string[];
  readonly redacted_field_paths: readonly string[];
  readonly audit_required: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface CognitiveTelemetryRecord {
  readonly schema_version: typeof COGNITIVE_TELEMETRY_LOGGER_SCHEMA_VERSION;
  readonly telemetry_ref: Ref;
  readonly record_class: TelemetryRecordClass;
  readonly event_type: CognitiveLoggerEventType;
  readonly request_ref?: Ref;
  readonly response_ref?: Ref;
  readonly task_ref?: Ref;
  readonly invocation_class?: CognitiveInvocationClass;
  readonly queue?: CognitiveQueue;
  readonly model_identifier?: string;
  readonly contract_ref?: Ref;
  readonly severity: "info" | "warning" | "error";
  readonly summary: string;
  readonly timestamp_ms: number;
  readonly budget_estimate?: CognitiveBudgetSnapshot;
  readonly latency_report?: CognitiveLatencyReport;
  readonly validation_status?: SemanticValidationStatus | QuarantineReleaseDecision | string;
  readonly confidence_summary?: string;
  readonly artifact_refs: readonly Ref[];
  readonly provenance_manifest: TelemetryProvenanceManifest;
  readonly visibility_class: TelemetryVisibilityClass;
  readonly redaction_report: TelemetryRedactionReport;
  readonly raw_event?: CognitiveTelemetryEvent;
  readonly determinism_hash: string;
}

export interface CognitiveBudgetSnapshot {
  readonly estimated_input_tokens: number;
  readonly estimated_output_tokens: number;
  readonly token_limit: number;
  readonly remaining_margin_tokens: number;
  readonly included_section_count: number;
  readonly excluded_section_count: number;
  readonly media_count: number;
  readonly budget_ok: boolean;
}

export interface CognitiveValidationDecisionInput {
  readonly request_ref: Ref;
  readonly response_ref?: Ref;
  readonly invocation_class: CognitiveInvocationClass;
  readonly queue?: CognitiveQueue;
  readonly model_identifier?: string;
  readonly contract_ref?: Ref;
  readonly semantic_validation_status: SemanticValidationStatus;
  readonly quarantine_release?: QuarantineReleaseDecision;
  readonly downstream_target?: DownstreamTarget;
  readonly validator_result?: "accepted" | "rejected" | "repair_needed" | "safe_hold_required" | "human_review";
  readonly rejection_reasons?: readonly string[];
  readonly repair_eligible?: boolean;
  readonly safe_hold_required?: boolean;
  readonly timestamp_ms?: number;
}

export interface PromptRegressionTelemetryInput {
  readonly scenario_ref: Ref;
  readonly prompt_version_ref: Ref;
  readonly model_identifier: string;
  readonly invocation_class: CognitiveInvocationClass;
  readonly succeeded: boolean;
  readonly schema_pass_rate: number;
  readonly safety_acceptance_rate: number;
  readonly repair_rate: number;
  readonly average_latency_ms: number;
  readonly p95_latency_ms: number;
  readonly timestamp_ms?: number;
}

export interface CognitiveQADatasetRow {
  readonly schema_version: typeof COGNITIVE_TELEMETRY_LOGGER_SCHEMA_VERSION;
  readonly row_ref: Ref;
  readonly request_ref?: Ref;
  readonly response_ref?: Ref;
  readonly invocation_class?: CognitiveInvocationClass;
  readonly queue?: CognitiveQueue;
  readonly model_identifier?: string;
  readonly contract_ref?: Ref;
  readonly event_type: CognitiveLoggerEventType;
  readonly severity: "info" | "warning" | "error";
  readonly summary: string;
  readonly latency_total_ms?: number;
  readonly schema_valid: boolean;
  readonly safe_hold_required: boolean;
  readonly repair_attempted: boolean;
  readonly redaction_decision: RedactionDecision;
  readonly provenance_status: TruthBoundaryStatus;
  readonly artifact_refs: readonly Ref[];
  readonly determinism_hash: string;
}

export interface CognitiveMetricBucket {
  readonly invocation_class?: CognitiveInvocationClass;
  readonly queue?: CognitiveQueue;
  readonly sample_count: number;
  readonly schema_pass_rate: number;
  readonly average_latency_ms: number;
  readonly p95_latency_ms: number;
  readonly response_repair_rate: number;
  readonly safe_hold_timeout_rate: number;
  readonly proposal_rejection_rate: number;
  readonly reobserve_request_rate: number;
  readonly hallucination_rejection_rate: number;
  readonly alert_level: MetricAlertLevel;
}

export interface CognitiveTelemetrySummary {
  readonly schema_version: typeof COGNITIVE_TELEMETRY_LOGGER_SCHEMA_VERSION;
  readonly summary_ref: Ref;
  readonly generated_at_ms: number;
  readonly record_count: number;
  readonly qa_row_count: number;
  readonly buckets: readonly CognitiveMetricBucket[];
  readonly critical_issue_count: number;
  readonly warning_issue_count: number;
  readonly determinism_hash: string;
}

export interface CognitiveTelemetryLoggerSnapshot {
  readonly schema_version: typeof COGNITIVE_TELEMETRY_LOGGER_SCHEMA_VERSION;
  readonly records: readonly CognitiveTelemetryRecord[];
  readonly qa_dataset_rows: readonly CognitiveQADatasetRow[];
  readonly summary: CognitiveTelemetrySummary;
  readonly determinism_hash: string;
}

/**
 * Captures cognitive-layer observability events and converts them into
 * redacted audit records, QA rows, and metric buckets. The implementation is
 * storage-agnostic: callers can persist the returned records in files, streams,
 * databases, or replay archives without changing cognitive service contracts.
 */
export class CognitiveTelemetryLogger {
  private readonly redactionPolicy: TelemetryRedactionPolicy;
  private readonly nowMs: () => number;
  private readonly records: CognitiveTelemetryRecord[] = [];
  private readonly qaRows: CognitiveQADatasetRow[] = [];

  public constructor(
    redactionPolicy: TelemetryRedactionPolicy = DEFAULT_REDACTION_POLICY,
    nowMs: () => number = () => Date.now(),
  ) {
    this.redactionPolicy = freezeRedactionPolicy(redactionPolicy);
    this.nowMs = nowMs;
  }

  /**
   * Logs an adapter-originated telemetry event while attaching request,
   * budget, queue, and provenance context needed by the architecture's
   * cognitive telemetry event matrix.
   */
  public logAdapterEvent(
    event: CognitiveTelemetryEvent,
    context: {
      readonly request_envelope?: CognitiveRequestEnvelope;
      readonly queue?: CognitiveQueue;
      readonly invocation_policy?: CognitiveInvocationPolicy;
      readonly artifact_refs?: readonly Ref[];
    } = {},
  ): CognitiveTelemetryRecord {
    const envelope = context.request_envelope;
    const budget = envelope?.budget_report;
    const summary = compactText(event.summary, this.redactionPolicy.max_summary_chars);
    const provenance = this.buildProvenanceManifest(
      makeRef("prov", event.event_ref),
      sourceClassesForEvent(event.event_type, envelope),
      summary,
    );
    const redaction = this.redactTelemetryText(event.event_ref, summary, visibilityFor(provenance), "$.summary");
    return this.storeRecord({
      recordClass: recordClassForEvent(event.event_type),
      eventType: event.event_type,
      requestRef: event.request_ref ?? envelope?.request_ref,
      invocationClass: envelope?.invocation_class,
      queue: context.queue,
      modelIdentifier: event.model_identifier ?? envelope?.model_identifier,
      contractRef: event.contract_ref ?? envelope?.output_contract_ref,
      severity: event.severity,
      summary: redaction.summary,
      timestampMs: event.timestamp_ms,
      budgetEstimate: budget === undefined ? undefined : budgetSnapshot(budget, envelope?.media_parts),
      artifactRefs: freezeArray([...(context.artifact_refs ?? []), ...(event.request_ref === undefined ? [] : [event.request_ref])]),
      provenanceManifest: provenance,
      redactionReport: redaction.report,
      rawEvent: event,
    });
  }

  /**
   * Logs a prepared cognitive request. Prompt sections and media payloads are
   * summarized by reference and budget counts so raw prompt/media content does
   * not leak into developer observability.
   */
  public logRequestPrepared(
    envelope: CognitiveRequestEnvelope,
    queue: CognitiveQueue,
    invocationPolicy: CognitiveInvocationPolicy,
    timestampMs: number = this.nowMs(),
  ): CognitiveTelemetryRecord {
    const mediaRefs = freezeArray((envelope.media_parts ?? []).map((part) => part.media_ref));
    const sectionRefs = freezeArray(collectPromptSections(envelope).map((section) => section.section_ref));
    const requestSummary = [
      `Prepared ${envelope.invocation_class} request ${envelope.request_ref}.`,
      `Queue=${queue}; timeout=${invocationPolicy.timeout_ms}ms; thinking=${invocationPolicy.thinking_budget_class}.`,
      `Budget input=${envelope.budget_report?.estimated_input_tokens ?? 0}; media=${mediaRefs.length}.`,
    ].join(" ");
    const provenance = this.buildProvenanceManifest(makeRef("prov", envelope.request_ref, "prepared"), sourceClassesForEnvelope(envelope), requestSummary);
    const redaction = this.redactTelemetryText(envelope.request_ref, requestSummary, "developer_observability", "$.summary");
    return this.storeRecord({
      recordClass: "request",
      eventType: "CognitiveRequestPrepared",
      requestRef: envelope.request_ref,
      invocationClass: envelope.invocation_class,
      queue,
      modelIdentifier: envelope.model_identifier,
      contractRef: envelope.output_contract_ref,
      severity: envelope.budget_report?.ok === false ? "warning" : "info",
      summary: redaction.summary,
      timestampMs,
      budgetEstimate: envelope.budget_report === undefined ? undefined : budgetSnapshot(envelope.budget_report, envelope.media_parts),
      artifactRefs: freezeArray([...sectionRefs, ...mediaRefs]),
      provenanceManifest: provenance,
      redactionReport: redaction.report,
    });
  }

  /**
   * Logs a quarantined response envelope after parse, semantic validation, and
   * release status are known. Response summaries are redacted before storage.
   */
  public logResponseEnvelope(
    response: CognitiveResponseEnvelope,
    context: {
      readonly invocation_class?: CognitiveInvocationClass;
      readonly queue?: CognitiveQueue;
      readonly downstream_target?: DownstreamTarget;
      readonly timestamp_ms?: number;
    } = {},
  ): CognitiveTelemetryRecord {
    const statusSummary = [
      `Response ${response.quarantine_release} for ${response.request_ref}.`,
      `Parse=${response.structured_parse_status}; semantic=${response.semantic_validation_status}.`,
      `Confidence=${response.confidence_report.confidence}; downstream=${context.downstream_target ?? "unspecified"}.`,
    ].join(" ");
    const provenance = this.buildProvenanceManifest(makeRef("prov", response.request_ref, "response"), ["model_output", "adapter_metadata"], response.raw_response_summary);
    const redaction = this.redactTelemetryText(response.request_ref, statusSummary, visibilityFor(provenance), "$.summary");
    const record = this.storeRecord({
      recordClass: "response",
      eventType: response.quarantine_release === "released" ? "ResponseReleased" : "ResponseRejected",
      requestRef: response.request_ref,
      invocationClass: context.invocation_class,
      queue: context.queue,
      modelIdentifier: response.model_identifier,
      contractRef: response.contract_ref,
      severity: severityForResponse(response),
      summary: redaction.summary,
      timestampMs: context.timestamp_ms ?? this.nowMs(),
      latencyReport: response.latency_report,
      validationStatus: response.quarantine_release,
      confidenceSummary: summarizeConfidence(response.confidence_report.confidence, response.confidence_report.ambiguity_notes, response.confidence_report.requested_reobservation),
      artifactRefs: freezeArray([response.request_ref, response.contract_ref]),
      provenanceManifest: provenance,
      redactionReport: redaction.report,
    });
    this.createQADatasetRow(record);
    return record;
  }

  /**
   * Logs the full response-quarantine report, preserving repair eligibility,
   * safe-hold state, parser state, and validator handoff target as auditable
   * fields without storing unsafe raw output.
   */
  public logQuarantineReport(report: ResponseQuarantineReport, queue?: CognitiveQueue, timestampMs: number = this.nowMs()): CognitiveTelemetryRecord {
    const response = report.cognitive_response_envelope;
    const summary = [
      `Quarantine ${report.decision} for response ${report.response_ref}.`,
      `Repair=${report.repair_eligibility}; safety=${report.safety_screen_report.decision}.`,
      `Contract=${report.expected_contract_ref}.`,
    ].join(" ");
    const provenance = this.buildProvenanceManifest(makeRef("prov", report.response_ref, "quarantine"), ["model_output", "adapter_metadata", "policy_config"], summary);
    const redaction = this.redactTelemetryText(report.response_ref, summary, visibilityFor(provenance), "$.summary");
    const record = this.storeRecord({
      recordClass: "response",
      eventType: report.decision === "released" ? "ResponseReleased" : "ResponseRejected",
      requestRef: report.request_ref,
      responseRef: report.response_ref,
      invocationClass: report.cognitive_response_envelope.parsed_payload === undefined ? undefined : responseInvocationClassFromReport(report),
      queue,
      modelIdentifier: response.model_identifier,
      contractRef: report.expected_contract_ref,
      severity: report.decision === "released" ? "info" : report.decision === "repair_needed" ? "warning" : "error",
      summary: redaction.summary,
      timestampMs,
      latencyReport: response.latency_report,
      validationStatus: report.decision,
      confidenceSummary: summarizeConfidence(response.confidence_report.confidence, response.confidence_report.ambiguity_notes, response.confidence_report.requested_reobservation),
      artifactRefs: freezeArray([report.response_ref, report.request_ref, report.expected_contract_ref]),
      provenanceManifest: provenance,
      redactionReport: redaction.report,
    });
    this.createQADatasetRow(record, report.repair_eligibility !== "ineligible", report.decision === "safe_hold_triggered");
    return record;
  }

  /**
   * Logs deterministic validator or quarantine decisions after model output has
   * been interpreted. This is the main hook for Gemini proposal rejection rate,
   * safe-hold rate, and repair-rate telemetry.
   */
  public logValidationDecision(input: CognitiveValidationDecisionInput): CognitiveTelemetryRecord {
    const reasons = input.rejection_reasons ?? [];
    const summary = [
      `Validation ${input.validator_result ?? input.semantic_validation_status} for ${input.request_ref}.`,
      `Semantic=${input.semantic_validation_status}; release=${input.quarantine_release ?? "not_applicable"}.`,
      reasons.length > 0 ? `Reasons=${reasons.join("; ")}.` : "No rejection reasons.",
    ].join(" ");
    const provenance = this.buildProvenanceManifest(makeRef("prov", input.request_ref, "validation"), ["policy_config", "adapter_metadata"], summary);
    const redaction = this.redactTelemetryText(input.response_ref ?? input.request_ref, summary, visibilityFor(provenance), "$.summary");
    const record = this.storeRecord({
      recordClass: "validation",
      eventType: "ValidationDecisionRecorded",
      requestRef: input.request_ref,
      responseRef: input.response_ref,
      invocationClass: input.invocation_class,
      queue: input.queue,
      modelIdentifier: input.model_identifier ?? GEMINI_ROBOTICS_ER_APPROVED_MODEL,
      contractRef: input.contract_ref,
      severity: input.validator_result === "accepted" && input.semantic_validation_status === "passed" ? "info" : input.safe_hold_required === true ? "error" : "warning",
      summary: redaction.summary,
      timestampMs: input.timestamp_ms ?? this.nowMs(),
      validationStatus: input.validator_result ?? input.semantic_validation_status,
      artifactRefs: freezeArray([input.request_ref, ...(input.response_ref === undefined ? [] : [input.response_ref]), ...(input.contract_ref === undefined ? [] : [input.contract_ref])]),
      provenanceManifest: provenance,
      redactionReport: redaction.report,
    });
    this.createQADatasetRow(record, input.repair_eligible === true, input.safe_hold_required === true);
    return record;
  }

  /**
   * Logs a rate-limit pacing decision so deferred calls, deterministic fallback,
   * and safe-hold routing are visible to operators and regression datasets.
   */
  public logRateCoordinatorDecision(report: CognitivePacingReport, invocationClass?: CognitiveInvocationClass, timestampMs: number = this.nowMs()): CognitiveTelemetryRecord {
    const summary = `Rate coordinator ${report.decision} for ${report.request_ref}; queue=${report.queue}; delay=${report.delay_ms}ms.`;
    const provenance = this.buildProvenanceManifest(makeRef("prov", report.request_ref, "rate"), ["adapter_metadata", "policy_config"], summary);
    const redaction = this.redactTelemetryText(report.request_ref, summary, visibilityFor(provenance), "$.summary");
    return this.storeRecord({
      recordClass: "rate_limit",
      eventType: "RateCoordinatorDecisionRecorded",
      requestRef: report.request_ref,
      invocationClass,
      queue: report.queue,
      modelIdentifier: report.telemetry_event.model_identifier,
      severity: report.telemetry_event.severity,
      summary: redaction.summary,
      timestampMs,
      artifactRefs: freezeArray([report.request_ref]),
      provenanceManifest: provenance,
      redactionReport: redaction.report,
      rawEvent: report.telemetry_event,
    });
  }

  /**
   * Logs a retry decision with backoff and degraded-mode context, enabling QA
   * to inspect timeout behavior and rate-limit recovery without model internals.
   */
  public logRetryDecision(report: RetryDecisionReport, invocationClass?: CognitiveInvocationClass, timestampMs: number = this.nowMs()): CognitiveTelemetryRecord {
    const summary = `Retry coordinator ${report.decision} after ${report.failure_kind}; request=${report.request_ref}; backoff=${report.backoff_ms}ms.`;
    const provenance = this.buildProvenanceManifest(makeRef("prov", report.request_ref, "retry"), ["adapter_metadata", "policy_config"], summary);
    const redaction = this.redactTelemetryText(report.request_ref, summary, visibilityFor(provenance), "$.summary");
    const record = this.storeRecord({
      recordClass: "retry",
      eventType: "RetryDecisionRecorded",
      requestRef: report.request_ref,
      invocationClass,
      queue: report.queue,
      modelIdentifier: report.telemetry_event.model_identifier,
      severity: report.telemetry_event.severity,
      summary: redaction.summary,
      timestampMs,
      artifactRefs: freezeArray([report.request_ref]),
      provenanceManifest: provenance,
      redactionReport: redaction.report,
      rawEvent: report.telemetry_event,
    });
    this.createQADatasetRow(record, report.decision === "repair_then_retry", report.decision === "safe_hold_required");
    return record;
  }

  /**
   * Logs an offline prompt-regression outcome. QA-only truth is allowed only
   * when the logger redaction policy explicitly permits QA rows.
   */
  public logPromptRegressionResult(input: PromptRegressionTelemetryInput): CognitiveTelemetryRecord {
    const summary = [
      `Prompt regression ${input.succeeded ? "succeeded" : "failed"} for ${input.scenario_ref}.`,
      `Schema=${round3(input.schema_pass_rate)}; safety=${round3(input.safety_acceptance_rate)}; p95=${Math.round(input.p95_latency_ms)}ms.`,
    ].join(" ");
    const sourceClasses: readonly ProvenanceSourceClass[] = this.redactionPolicy.allow_qa_truth ? ["qa_truth", "adapter_metadata"] : ["adapter_metadata"];
    const provenance = this.buildProvenanceManifest(makeRef("prov", input.scenario_ref, "regression"), sourceClasses, summary);
    const redaction = this.redactTelemetryText(input.scenario_ref, summary, this.redactionPolicy.allow_qa_truth ? "qa_only" : "developer_observability", "$.summary");
    const record = this.storeRecord({
      recordClass: "qa",
      eventType: "PromptRegressionResult",
      requestRef: input.scenario_ref,
      invocationClass: input.invocation_class,
      modelIdentifier: input.model_identifier,
      severity: input.succeeded ? "info" : "error",
      summary: redaction.summary,
      timestampMs: input.timestamp_ms ?? this.nowMs(),
      latencyReport: {
        queue_ms: 0,
        generation_ms: input.average_latency_ms,
        validation_ms: 0,
        repair_ms: 0,
        total_ms: input.average_latency_ms,
      },
      validationStatus: input.succeeded ? "passed" : "failed",
      artifactRefs: freezeArray([input.scenario_ref, input.prompt_version_ref]),
      provenanceManifest: provenance,
      redactionReport: redaction.report,
    });
    this.createQADatasetRow(record, input.repair_rate > 0, false);
    return record;
  }

  /**
   * Returns a deterministic QA dataset view capped to a bounded row count.
   * Rows are already redacted and contain only replay-safe references.
   */
  public exportQADatasetRows(limit: number = MAX_QA_ROWS): readonly CognitiveQADatasetRow[] {
    return freezeArray(this.qaRows.slice(-clampInteger(limit, 0, MAX_QA_ROWS)));
  }

  /**
   * Builds metric buckets for schema success rate, latency, repair rate, safe-hold
   * rate, proposal rejection, and re-observation requests.
   */
  public summarizeMetrics(generatedAtMs: number = this.nowMs()): CognitiveTelemetrySummary {
    const buckets = buildMetricBuckets(this.records);
    const base = {
      schema_version: COGNITIVE_TELEMETRY_LOGGER_SCHEMA_VERSION,
      summary_ref: makeRef("cog_telemetry_summary", String(generatedAtMs), String(this.records.length)),
      generated_at_ms: generatedAtMs,
      record_count: this.records.length,
      qa_row_count: this.qaRows.length,
      buckets,
      critical_issue_count: this.records.filter((record) => record.severity === "error").length,
      warning_issue_count: this.records.filter((record) => record.severity === "warning").length,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Returns all accumulated records, QA rows, and the current metric summary as
   * a frozen snapshot suitable for persistence or replay assembly.
   */
  public snapshot(generatedAtMs: number = this.nowMs()): CognitiveTelemetryLoggerSnapshot {
    const base = {
      schema_version: COGNITIVE_TELEMETRY_LOGGER_SCHEMA_VERSION,
      records: freezeArray(this.records),
      qa_dataset_rows: freezeArray(this.qaRows),
      summary: this.summarizeMetrics(generatedAtMs),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  private buildProvenanceManifest(manifestRef: Ref, sourceClasses: readonly ProvenanceSourceClass[], textForAudit: string): TelemetryProvenanceManifest {
    const forbiddenText = FORBIDDEN_OBSERVABILITY_PATTERN.test(textForAudit);
    const forbiddenSource = sourceClasses.includes("qa_truth") && this.redactionPolicy.allow_qa_truth === false;
    const truthBoundary = decideTruthBoundaryStatus(sourceClasses, forbiddenText || forbiddenSource);
    const cognitiveVisibility: TelemetryProvenanceManifest["cognitive_visibility"] = truthBoundary === "truth_boundary_violation" || forbiddenSource ? "forbidden" : forbiddenText ? "redacted" : "allowed";
    const auditNotes = [
      ...(forbiddenText ? ["restricted terminology detected and redacted"] : []),
      ...(forbiddenSource ? ["qa truth blocked from runtime observability"] : []),
      ...(sourceClasses.includes("memory") ? ["memory is labeled as prior belief"] : []),
    ];
    const base = {
      manifest_ref: manifestRef,
      source_classes: freezeArray(unique(sourceClasses)),
      forbidden_source_detected: forbiddenText || forbiddenSource,
      cognitive_visibility: cognitiveVisibility,
      memory_visibility: sourceClasses.includes("memory") ? "summary_only" as const : "allowed" as const,
      qa_visibility: sourceClasses.includes("qa_truth") && this.redactionPolicy.allow_qa_truth === false ? "forbidden" as const : "allowed" as const,
      truth_boundary_status: truthBoundary,
      audit_notes: freezeArray(auditNotes),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  private redactTelemetryText(sourceRef: Ref, text: string, visibilityClass: TelemetryVisibilityClass, fieldPath: string): { readonly summary: string; readonly report: TelemetryRedactionReport } {
    const fieldPaths: string[] = [];
    const rules: string[] = [];
    let decision: RedactionDecision = "none";
    let summary = compactText(text, this.redactionPolicy.max_summary_chars);
    if (this.redactionPolicy.redact_prompt_text && FORBIDDEN_OBSERVABILITY_PATTERN.test(summary)) {
      summary = summary.replace(FORBIDDEN_OBSERVABILITY_PATTERN, REDACTED_TEXT);
      fieldPaths.push(fieldPath);
      rules.push("forbidden_observability_pattern");
      decision = "redacted";
    }
    if (visibilityClass === "restricted") {
      decision = "summary_only";
      rules.push("restricted_visibility_summary_only");
    }
    if (visibilityClass === "redacted" && decision === "none") {
      decision = "redacted";
      rules.push("visibility_requires_redaction");
    }
    const issues = decision === "redacted"
      ? freezeArray([issue("warning", "TelemetryRedactionApplied", fieldPath, "Telemetry text contained restricted or policy-limited content.", "Store only the redacted summary and replay-safe refs.")])
      : freezeArray<ValidationIssue>([]);
    const base = {
      schema_version: COGNITIVE_TELEMETRY_LOGGER_SCHEMA_VERSION,
      redaction_report_ref: makeRef("redaction", sourceRef, String(decision), String(rules.length)),
      source_ref: sourceRef,
      decision,
      visibility_class: visibilityClass,
      rules_applied: freezeArray(rules),
      redacted_field_paths: freezeArray(fieldPaths),
      audit_required: decision === "redacted",
      issues,
    };
    return Object.freeze({
      summary,
      report: Object.freeze({
        ...base,
        determinism_hash: computeDeterminismHash(base),
      }),
    });
  }

  private storeRecord(input: {
    readonly recordClass: TelemetryRecordClass;
    readonly eventType: CognitiveLoggerEventType;
    readonly requestRef?: Ref;
    readonly responseRef?: Ref;
    readonly invocationClass?: CognitiveInvocationClass;
    readonly queue?: CognitiveQueue;
    readonly modelIdentifier?: string;
    readonly contractRef?: Ref;
    readonly severity: "info" | "warning" | "error";
    readonly summary: string;
    readonly timestampMs: number;
    readonly budgetEstimate?: CognitiveBudgetSnapshot;
    readonly latencyReport?: CognitiveLatencyReport;
    readonly validationStatus?: SemanticValidationStatus | QuarantineReleaseDecision | string;
    readonly confidenceSummary?: string;
    readonly artifactRefs: readonly Ref[];
    readonly provenanceManifest: TelemetryProvenanceManifest;
    readonly redactionReport: TelemetryRedactionReport;
    readonly rawEvent?: CognitiveTelemetryEvent;
  }): CognitiveTelemetryRecord {
    const visibilityClass = input.redactionReport.visibility_class;
    const base = {
      schema_version: COGNITIVE_TELEMETRY_LOGGER_SCHEMA_VERSION,
      telemetry_ref: makeRef("cog_telemetry", input.eventType, input.requestRef ?? input.responseRef ?? "global", String(input.timestampMs), String(this.records.length)),
      record_class: input.recordClass,
      event_type: input.eventType,
      request_ref: input.requestRef,
      response_ref: input.responseRef,
      invocation_class: input.invocationClass,
      queue: input.queue,
      model_identifier: input.modelIdentifier,
      contract_ref: input.contractRef,
      severity: input.severity,
      summary: input.summary,
      timestamp_ms: input.timestampMs,
      budget_estimate: input.budgetEstimate,
      latency_report: input.latencyReport,
      validation_status: input.validationStatus,
      confidence_summary: input.confidenceSummary,
      artifact_refs: freezeArray(unique(input.artifactRefs)),
      provenance_manifest: input.provenanceManifest,
      visibility_class: visibilityClass,
      redaction_report: input.redactionReport,
      raw_event: input.rawEvent,
    };
    const record = Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
    this.records.push(record);
    return record;
  }

  private createQADatasetRow(record: CognitiveTelemetryRecord, repairAttempted = inferRepairAttempted(record), safeHoldRequired = inferSafeHold(record)): CognitiveQADatasetRow {
    const schemaValid = record.validation_status === "passed" || record.validation_status === "released" || record.event_type === "ResponseReleased";
    const base = {
      schema_version: COGNITIVE_TELEMETRY_LOGGER_SCHEMA_VERSION,
      row_ref: makeRef("cog_qa_row", record.telemetry_ref, String(this.qaRows.length)),
      request_ref: record.request_ref,
      response_ref: record.response_ref,
      invocation_class: record.invocation_class,
      queue: record.queue,
      model_identifier: record.model_identifier,
      contract_ref: record.contract_ref,
      event_type: record.event_type,
      severity: record.severity,
      summary: record.summary,
      latency_total_ms: record.latency_report?.total_ms,
      schema_valid: schemaValid,
      safe_hold_required: safeHoldRequired,
      repair_attempted: repairAttempted,
      redaction_decision: record.redaction_report.decision,
      provenance_status: record.provenance_manifest.truth_boundary_status,
      artifact_refs: record.artifact_refs,
    };
    const row = Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
    if (this.qaRows.length >= MAX_QA_ROWS) {
      this.qaRows.shift();
    }
    this.qaRows.push(row);
    return row;
  }
}

function budgetSnapshot(budget: CognitiveBudgetReport, mediaParts: readonly CognitiveMediaPart[] | undefined): CognitiveBudgetSnapshot {
  return Object.freeze({
    estimated_input_tokens: budget.estimated_input_tokens,
    estimated_output_tokens: budget.estimated_output_tokens,
    token_limit: budget.token_limit,
    remaining_margin_tokens: budget.remaining_margin_tokens,
    included_section_count: budget.included_sections.length,
    excluded_section_count: budget.excluded_sections.length,
    media_count: mediaParts?.length ?? budget.included_media.length + budget.excluded_media.length,
    budget_ok: budget.ok,
  });
}

function collectPromptSections(envelope: CognitiveRequestEnvelope): readonly CognitivePromptSection[] {
  return freezeArray([
    ...(envelope.observation_sections ?? []),
    ...(envelope.memory_context ?? []),
    ...(envelope.validator_context ?? []),
  ]);
}

function sourceClassesForEnvelope(envelope: CognitiveRequestEnvelope): readonly ProvenanceSourceClass[] {
  const sources: ProvenanceSourceClass[] = ["adapter_metadata", "policy_config"];
  if ((envelope.media_parts ?? []).length > 0 || (envelope.observation_sections ?? []).length > 0) {
    sources.push("embodied_sensor");
  }
  if ((envelope.memory_context ?? []).length > 0) {
    sources.push("memory");
  }
  if ((envelope.validator_context ?? []).length > 0 || envelope.safety_annotations.length > 0) {
    sources.push("derived_estimate");
  }
  return freezeArray(unique(sources));
}

function sourceClassesForEvent(eventType: CognitiveTelemetryEventType, envelope?: CognitiveRequestEnvelope): readonly ProvenanceSourceClass[] {
  const envelopeSources = envelope === undefined ? ["adapter_metadata"] as const : sourceClassesForEnvelope(envelope);
  if (eventType === "ResponseQuarantined" || eventType === "ResponseReleased" || eventType === "ResponseRejected" || eventType === "ModelCallCompleted") {
    return freezeArray(unique([...envelopeSources, "model_output"]));
  }
  if (eventType === "ModelVersionDriftSignal") {
    return freezeArray(["adapter_metadata", "policy_config"]);
  }
  return envelopeSources;
}

function recordClassForEvent(eventType: CognitiveTelemetryEventType): TelemetryRecordClass {
  if (eventType === "CognitiveRequestPrepared" || eventType === "CognitiveRequestRejected" || eventType === "ModelCallStarted") {
    return "request";
  }
  if (eventType === "ResponseQuarantined" || eventType === "ResponseReleased" || eventType === "ResponseRejected" || eventType === "ModelCallCompleted") {
    return "response";
  }
  return "model_drift";
}

function severityForResponse(response: CognitiveResponseEnvelope): "info" | "warning" | "error" {
  if (response.quarantine_release === "released" && response.semantic_validation_status === "passed") {
    return "info";
  }
  if (response.quarantine_release === "repair_needed" || response.semantic_validation_status === "warning") {
    return "warning";
  }
  return "error";
}

function summarizeConfidence(confidence: string, ambiguityNotes: readonly string[], requestedReobservation: boolean): string {
  const notes = ambiguityNotes.length === 0 ? "no ambiguity notes" : ambiguityNotes.slice(0, 4).join("; ");
  return compactText(`confidence=${confidence}; reobserve=${requestedReobservation}; ${notes}`, MAX_SUMMARY_CHARS);
}

function responseInvocationClassFromReport(report: ResponseQuarantineReport): CognitiveInvocationClass {
  return report.cognitive_response_envelope.parsed_payload === undefined
    ? "SceneObservationReasoning"
    : "SceneObservationReasoning";
}

function visibilityFor(manifest: TelemetryProvenanceManifest): TelemetryVisibilityClass {
  if (manifest.cognitive_visibility === "forbidden") {
    return "restricted";
  }
  if (manifest.cognitive_visibility === "redacted") {
    return "redacted";
  }
  if (manifest.source_classes.includes("qa_truth")) {
    return "qa_only";
  }
  return "developer_observability";
}

function decideTruthBoundaryStatus(sourceClasses: readonly ProvenanceSourceClass[], violation: boolean): TruthBoundaryStatus {
  if (violation) {
    return "truth_boundary_violation";
  }
  if (sourceClasses.includes("qa_truth")) {
    return "qa_truth_only";
  }
  if (sourceClasses.includes("memory")) {
    return "runtime_memory_labeled";
  }
  if (sourceClasses.includes("policy_config") && sourceClasses.length <= 2) {
    return "runtime_policy_only";
  }
  if (sourceClasses.some((source) => source === "embodied_sensor" || source === "derived_estimate" || source === "controller_telemetry" || source === "model_output" || source === "adapter_metadata")) {
    return "runtime_embodied_only";
  }
  return "mixed_with_restricted_data";
}

function buildMetricBuckets(records: readonly CognitiveTelemetryRecord[]): readonly CognitiveMetricBucket[] {
  const keys = new Map<string, CognitiveTelemetryRecord[]>();
  for (const record of records) {
    const key = `${record.invocation_class ?? "all"}|${record.queue ?? "all"}`;
    keys.set(key, [...(keys.get(key) ?? []), record]);
  }
  const buckets: CognitiveMetricBucket[] = [];
  for (const [key, grouped] of keys.entries()) {
    const [invocationRaw, queueRaw] = key.split("|");
    buckets.push(metricBucketForGroup(
      invocationRaw === "all" ? undefined : invocationRaw as CognitiveInvocationClass,
      queueRaw === "all" ? undefined : queueRaw as CognitiveQueue,
      grouped,
    ));
  }
  buckets.sort((a, b) => (a.invocation_class ?? "").localeCompare(b.invocation_class ?? "") || (a.queue ?? "").localeCompare(b.queue ?? ""));
  return freezeArray(buckets);
}

function metricBucketForGroup(invocationClass: CognitiveInvocationClass | undefined, queue: CognitiveQueue | undefined, records: readonly CognitiveTelemetryRecord[]): CognitiveMetricBucket {
  const validationRecords = records.filter((record) => record.record_class === "validation" || record.record_class === "response" || record.record_class === "qa");
  const latencyValues = records.map((record) => record.latency_report?.total_ms).filter((value): value is number => value !== undefined && Number.isFinite(value));
  const schemaPasses = validationRecords.filter((record) => record.validation_status === "passed" || record.validation_status === "released" || record.event_type === "ResponseReleased").length;
  const repairCount = records.filter((record) => /repair/i.test(record.summary) || record.validation_status === "repair_needed").length;
  const safeHoldCount = records.filter((record) => /safe[- ]hold/i.test(record.summary) || record.validation_status === "safe_hold_triggered").length;
  const rejectionCount = records.filter((record) => record.severity === "error" || /reject/i.test(record.summary)).length;
  const reobserveCount = records.filter((record) => /re[- ]?observe/i.test(record.summary) || /reobserve=true/i.test(record.confidence_summary ?? "")).length;
  const hallucinationCount = records.filter((record) => /hallucinat|forbidden|truth_boundary_violation/i.test(`${record.summary} ${record.provenance_manifest.truth_boundary_status}`)).length;
  const averageLatency = average(latencyValues);
  const p95Latency = percentile95(latencyValues);
  const base = {
    invocation_class: invocationClass,
    queue,
    sample_count: records.length,
    schema_pass_rate: ratio(schemaPasses, Math.max(1, validationRecords.length)),
    average_latency_ms: round3(averageLatency),
    p95_latency_ms: round3(p95Latency),
    response_repair_rate: ratio(repairCount, records.length),
    safe_hold_timeout_rate: ratio(safeHoldCount, records.length),
    proposal_rejection_rate: ratio(rejectionCount, records.length),
    reobserve_request_rate: ratio(reobserveCount, records.length),
    hallucination_rejection_rate: ratio(hallucinationCount, records.length),
    alert_level: alertLevel(p95Latency, rejectionCount, safeHoldCount, records.length),
  };
  return Object.freeze(base);
}

function alertLevel(p95Latency: number, rejectionCount: number, safeHoldCount: number, sampleCount: number): MetricAlertLevel {
  if (p95Latency >= LATENCY_ERROR_MS || ratio(rejectionCount + safeHoldCount, sampleCount) >= 0.3) {
    return "critical";
  }
  if (p95Latency >= LATENCY_WARNING_MS || ratio(rejectionCount + safeHoldCount, sampleCount) >= 0.12) {
    return "watch";
  }
  return "nominal";
}

function inferRepairAttempted(record: CognitiveTelemetryRecord): boolean {
  return record.validation_status === "repair_needed" || /repair/i.test(record.summary);
}

function inferSafeHold(record: CognitiveTelemetryRecord): boolean {
  return record.validation_status === "safe_hold_triggered" || /safe[- ]hold/i.test(record.summary);
}

function compactText(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return normalized.slice(0, Math.max(0, limit - 3)).trimEnd() + "...";
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0 || Number.isFinite(denominator) === false) {
    return 0;
  }
  return round3(clamp(numerator / denominator, 0, 1));
}

function average(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile95(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.trunc(clamp(Number.isFinite(value) ? value : min, min, max));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function unique<T extends string>(items: readonly T[]): readonly T[] {
  return freezeArray([...new Set(items)]);
}

function makeRef(...parts: readonly string[]): Ref {
  const normalized = parts
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "ref:empty";
}

function issue(severity: ValidationSeverity, code: string, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

function freezeRedactionPolicy(policy: TelemetryRedactionPolicy): TelemetryRedactionPolicy {
  return Object.freeze({ ...policy });
}

const DEFAULT_REDACTION_POLICY: TelemetryRedactionPolicy = Object.freeze({
  policy_ref: "telemetry_redaction_policy:cognitive_runtime_v1",
  redact_media_payloads: true,
  redact_prompt_text: true,
  redact_raw_response_text: true,
  allow_qa_truth: false,
  max_summary_chars: MAX_SUMMARY_CHARS,
});

if (REDACTED_MEDIA.length === 0 || REDACTED_TEXT.length === 0) {
  throw new Error("Cognitive telemetry logger requires non-empty redaction markers.");
}

export const COGNITIVE_TELEMETRY_LOGGER_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: COGNITIVE_TELEMETRY_LOGGER_SCHEMA_VERSION,
  blueprint: "architecture_docs/06_GEMINI_ROBOTICS_ER_COGNITIVE_LAYER.md",
  sections: freezeArray(["6.6.1", "6.8.2", "6.12.1", "6.18.1", "6.18.2", "6.19", "6.20"]),
});
