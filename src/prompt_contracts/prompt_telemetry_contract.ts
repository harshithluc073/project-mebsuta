/**
 * Prompt telemetry contract for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/07_PROMPT_CONTRACTS_AND_STRUCTURED_OUTPUTS.md`
 * sections 7.3, 7.4, 7.5, 7.6, 7.7, 7.18, 7.20, 7.23, and 7.24.
 *
 * This module implements the executable `PromptTelemetryContract`. It emits
 * inspectable request and response summaries while preventing hidden reasoning,
 * simulator truth, backend identifiers, raw media, direct-control wording, and
 * validator-bypass language from entering developer observability or QA rows.
 * It is deterministic and storage-agnostic: callers can persist the returned
 * records in logs, telemetry streams, or replay archives.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import { GEMINI_ROBOTICS_ER_APPROVED_MODEL } from "../cognitive/gemini_robotics_er_adapter";
import type { CognitiveInvocationClass } from "../cognitive/gemini_robotics_er_adapter";
import {
  COGNITIVE_OUTPUT_VALIDATOR_POLICY_REF,
  COGNITIVE_PROMPT_FIREWALL_POLICY_REF,
  COGNITIVE_PROMPT_PACKET_CONTRACT_VERSION,
} from "./cognitive_prompt_packet_contract";
import type {
  CognitivePromptPacketCandidate,
  CognitivePromptPacketSection,
  PromptContractId,
  PromptProvenanceLabel,
} from "./cognitive_prompt_packet_contract";
import { STRUCTURED_RESPONSE_CONTRACT_VERSION } from "./structured_response_contract";
import type {
  StructuredConfidenceValue,
  StructuredResponseContractRef,
  StructuredResponseEnvelope,
  StructuredUncertaintyCategory,
} from "./structured_response_contract";
import { PROMPT_FIREWALL_VALIDATION_CONTRACT_VERSION } from "./prompt_firewall_validation_contract";
import type { PromptFirewallValidationReport } from "./prompt_firewall_validation_contract";
import { NO_RL_PROMPT_COMPLIANCE_CONTRACT_VERSION } from "./no_rl_prompt_compliance_contract";
import type { NoRLComplianceReport } from "./no_rl_prompt_compliance_contract";
import { UNCERTAINTY_REPORTING_CONTRACT_VERSION } from "./uncertainty_reporting_contract";
import type { UncertaintyReportingReport } from "./uncertainty_reporting_contract";
import { RESPONSE_REPAIR_CONTRACT_VERSION } from "./response_repair_contract";
import type { ResponseRepairReport } from "./response_repair_contract";
import { PROMPT_REGRESSION_CONTRACT_VERSION } from "./prompt_regression_contract";

export const PROMPT_TELEMETRY_CONTRACT_SCHEMA_VERSION = "mebsuta.prompt_telemetry_contract.v1" as const;
export const PROMPT_TELEMETRY_CONTRACT_VERSION = "1.0.0" as const;
export const PROMPT_TELEMETRY_CONTRACT_ID = "PROMPT-TELEMETRY-001" as const;

const CONTRACT_TRACEABILITY_REF = "architecture_docs/07_PROMPT_CONTRACTS_AND_STRUCTURED_OUTPUTS.md#PromptTelemetryContract" as const;
const PROMPT_TELEMETRY_POLICY_VERSION = "prompt_observability_redaction_v1" as const;
const REDACTED_TEXT = "[REDACTED_PROMPT_TELEMETRY_CONTENT]" as const;
const RAW_MEDIA_REDACTION = "[REDACTED_RAW_MEDIA_PAYLOAD]" as const;
const DEFAULT_MAX_SUMMARY_CHARS = 1400;
const MAX_TELEMETRY_LABELS = 24;
const MAX_ARTIFACT_REFS = 48;
const FORBIDDEN_TELEMETRY_PATTERN = /(mujoco|babylon|backend|engine|scene_graph|world_truth|ground_truth|qa_|collision_mesh|segmentation truth|debug buffer|render buffer|simulator|physics_body|rigid_body_handle|joint_handle|object_id|exact_com|world_pose|hidden pose|hidden state|system prompt|developer prompt|chain-of-thought|scratchpad|private deliberation|full hidden reasoning|direct actuator|raw actuator|joint torque|joint current|set joint|apply force|apply impulse|physics step|reward policy|policy gradient|reinforcement learning|rl update|ignore validators|override safety|disable safe-hold|skip validation|without validation)/i;
const RAW_MEDIA_PATTERN = /\b(data:image\/|data:video\/|data:audio\/|base64,|raw frame|pixel buffer|pcm samples|wav bytes|mp4 bytes)\b/i;

export type PromptTelemetryEventKind =
  | "prompt_packet_prepared"
  | "prompt_packet_rejected"
  | "model_request_started"
  | "model_response_received"
  | "structured_response_validated"
  | "response_repair_requested"
  | "validator_handoff_emitted"
  | "monologue_filtered"
  | "prompt_regression_recorded";

export type PromptTelemetryVisibility = "runtime_summary" | "developer_observability" | "qa_only" | "redacted" | "blocked";
export type PromptTelemetryTruthBoundary = "sensor_or_policy_only" | "memory_labeled" | "validator_feedback_labeled" | "model_output_labeled" | "qa_only" | "truth_boundary_violation";
export type PromptTelemetryRedactionDecision = "none" | "summary_only" | "redacted" | "blocked";
export type PromptTelemetrySeverity = "info" | "warning" | "error";
export type PromptTelemetryRecordClass = "request" | "response" | "validation" | "repair" | "handoff" | "monologue" | "qa";

export type PromptTelemetrySourceClass =
  | "sensor_evidence"
  | "memory_prior"
  | "validator_feedback"
  | "embodiment_context"
  | "human_instruction"
  | "schema_instruction"
  | "safety_policy"
  | "model_output"
  | "adapter_metadata"
  | "qa_truth";

/**
 * Redaction policy applied to all telemetry text and references.
 */
export interface PromptTelemetryRedactionPolicy {
  readonly policy_ref: Ref;
  readonly max_summary_chars: number;
  readonly redact_raw_prompt_text: boolean;
  readonly redact_raw_response_text: boolean;
  readonly redact_media_payloads: boolean;
  readonly block_forbidden_runtime_content: boolean;
  readonly allow_qa_truth_in_qa_records: boolean;
}

/**
 * Provenance manifest for one telemetry record.
 */
export interface PromptTelemetryProvenanceManifest {
  readonly manifest_ref: Ref;
  readonly source_classes: readonly PromptTelemetrySourceClass[];
  readonly provenance_labels: readonly PromptProvenanceLabel[];
  readonly truth_boundary_status: PromptTelemetryTruthBoundary;
  readonly forbidden_content_detected: boolean;
  readonly raw_media_detected: boolean;
  readonly audit_notes: readonly string[];
  readonly determinism_hash: string;
}

/**
 * Redaction report attached to one telemetry record.
 */
export interface PromptTelemetryRedactionReport {
  readonly schema_version: typeof PROMPT_TELEMETRY_CONTRACT_SCHEMA_VERSION;
  readonly redaction_report_ref: Ref;
  readonly source_ref: Ref;
  readonly decision: PromptTelemetryRedactionDecision;
  readonly visibility: PromptTelemetryVisibility;
  readonly redacted_field_paths: readonly string[];
  readonly rules_applied: readonly string[];
  readonly audit_required: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

/**
 * Contract metadata used by observability and audit surfaces.
 */
export interface PromptTelemetryContractDescriptor {
  readonly schema_version: typeof PROMPT_TELEMETRY_CONTRACT_SCHEMA_VERSION;
  readonly contract_id: typeof PROMPT_TELEMETRY_CONTRACT_ID;
  readonly contract_version: typeof PROMPT_TELEMETRY_CONTRACT_VERSION;
  readonly telemetry_policy_version: typeof PROMPT_TELEMETRY_POLICY_VERSION;
  readonly prompt_packet_contract_version: typeof COGNITIVE_PROMPT_PACKET_CONTRACT_VERSION;
  readonly structured_response_contract_version: typeof STRUCTURED_RESPONSE_CONTRACT_VERSION;
  readonly firewall_contract_version: typeof PROMPT_FIREWALL_VALIDATION_CONTRACT_VERSION;
  readonly no_rl_contract_version: typeof NO_RL_PROMPT_COMPLIANCE_CONTRACT_VERSION;
  readonly uncertainty_contract_version: typeof UNCERTAINTY_REPORTING_CONTRACT_VERSION;
  readonly response_repair_contract_version: typeof RESPONSE_REPAIR_CONTRACT_VERSION;
  readonly prompt_regression_contract_version: typeof PROMPT_REGRESSION_CONTRACT_VERSION;
  readonly model_profile_ref: typeof GEMINI_ROBOTICS_ER_APPROVED_MODEL;
  readonly input_firewall_ref: typeof COGNITIVE_PROMPT_FIREWALL_POLICY_REF;
  readonly output_validator_ref: typeof COGNITIVE_OUTPUT_VALIDATOR_POLICY_REF;
  readonly traceability_ref: typeof CONTRACT_TRACEABILITY_REF;
  readonly redaction_policy: PromptTelemetryRedactionPolicy;
  readonly determinism_hash: string;
}

/**
 * Input for request-side telemetry summary generation.
 */
export interface PromptTelemetryRequestInput {
  readonly event_ref: Ref;
  readonly request_ref: Ref;
  readonly invocation_class: CognitiveInvocationClass;
  readonly prompt_contract_id: PromptContractId;
  readonly output_contract_ref: StructuredResponseContractRef;
  readonly packet?: CognitivePromptPacketCandidate;
  readonly task_state_ref: Ref;
  readonly model_identifier?: string;
  readonly estimated_input_tokens?: number;
  readonly estimated_output_tokens?: number;
  readonly media_ref_count?: number;
  readonly omitted_section_refs?: readonly Ref[];
  readonly firewall_report?: PromptFirewallValidationReport;
  readonly no_rl_report?: NoRLComplianceReport;
  readonly timestamp_ms?: number;
}

/**
 * Input for response-side telemetry summary generation.
 */
export interface PromptTelemetryResponseInput {
  readonly event_ref: Ref;
  readonly request_ref: Ref;
  readonly response_ref: Ref;
  readonly invocation_class: CognitiveInvocationClass;
  readonly expected_contract_ref: StructuredResponseContractRef;
  readonly response_envelope?: StructuredResponseEnvelope;
  readonly raw_response_summary?: string;
  readonly firewall_report?: PromptFirewallValidationReport;
  readonly no_rl_report?: NoRLComplianceReport;
  readonly uncertainty_report?: UncertaintyReportingReport;
  readonly repair_report?: ResponseRepairReport;
  readonly released: boolean;
  readonly safe_hold_required: boolean;
  readonly latency_ms?: number;
  readonly timestamp_ms?: number;
}

/**
 * Redacted, inspectable telemetry record for prompt/response observability.
 */
export interface PromptTelemetryRecord {
  readonly schema_version: typeof PROMPT_TELEMETRY_CONTRACT_SCHEMA_VERSION;
  readonly telemetry_ref: Ref;
  readonly event_kind: PromptTelemetryEventKind;
  readonly record_class: PromptTelemetryRecordClass;
  readonly severity: PromptTelemetrySeverity;
  readonly visibility: PromptTelemetryVisibility;
  readonly request_ref?: Ref;
  readonly response_ref?: Ref;
  readonly task_state_ref?: Ref;
  readonly invocation_class?: CognitiveInvocationClass;
  readonly prompt_contract_id?: PromptContractId | typeof PROMPT_TELEMETRY_CONTRACT_ID;
  readonly output_contract_ref?: StructuredResponseContractRef;
  readonly model_identifier?: string;
  readonly summary: string;
  readonly timestamp_ms: number;
  readonly telemetry_labels: readonly Ref[];
  readonly artifact_refs: readonly Ref[];
  readonly confidence_value?: StructuredConfidenceValue;
  readonly uncertainty_categories: readonly StructuredUncertaintyCategory[];
  readonly requires_reobserve: boolean;
  readonly requires_validation: boolean;
  readonly safe_hold_required: boolean;
  readonly latency_ms?: number;
  readonly provenance_manifest: PromptTelemetryProvenanceManifest;
  readonly redaction_report: PromptTelemetryRedactionReport;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

/**
 * QA row projected from a telemetry record.
 */
export interface PromptTelemetryQARow {
  readonly schema_version: typeof PROMPT_TELEMETRY_CONTRACT_SCHEMA_VERSION;
  readonly row_ref: Ref;
  readonly telemetry_ref: Ref;
  readonly request_ref?: Ref;
  readonly response_ref?: Ref;
  readonly invocation_class?: CognitiveInvocationClass;
  readonly output_contract_ref?: StructuredResponseContractRef;
  readonly event_kind: PromptTelemetryEventKind;
  readonly severity: PromptTelemetrySeverity;
  readonly summary: string;
  readonly released: boolean;
  readonly redaction_decision: PromptTelemetryRedactionDecision;
  readonly truth_boundary_status: PromptTelemetryTruthBoundary;
  readonly safe_hold_required: boolean;
  readonly repair_attempted: boolean;
  readonly latency_ms?: number;
  readonly determinism_hash: string;
}

/**
 * Deterministic telemetry contract. It produces redacted request summaries,
 * redacted response summaries, and QA rows without storing raw model prompts,
 * raw model output, raw media payloads, hidden reasoning, or privileged state.
 */
export class PromptTelemetryContract {
  private readonly descriptor: PromptTelemetryContractDescriptor;
  private readonly redactionPolicy: PromptTelemetryRedactionPolicy;
  private readonly nowMs: () => number;

  public constructor(
    redactionPolicy: PromptTelemetryRedactionPolicy = DEFAULT_PROMPT_TELEMETRY_REDACTION_POLICY,
    nowMs: () => number = () => Date.now(),
  ) {
    this.redactionPolicy = freezeRedactionPolicy(redactionPolicy);
    this.nowMs = nowMs;
    this.descriptor = buildDescriptor(this.redactionPolicy);
  }

  /**
   * Returns immutable telemetry policy metadata for audit and traceability.
   */
  public getDescriptor(): PromptTelemetryContractDescriptor {
    return this.descriptor;
  }

  /**
   * Emits a request-side telemetry record from a prompt packet candidate and
   * validation reports. Raw section text is summarized by counts and refs.
   */
  public summarizeRequest(input: PromptTelemetryRequestInput): PromptTelemetryRecord {
    const issues: ValidationIssue[] = [];
    validateRef(input.event_ref, "$.event_ref", issues);
    validateRef(input.request_ref, "$.request_ref", issues);
    validateRef(input.task_state_ref, "$.task_state_ref", issues);
    const labels = telemetryLabelsFromRequest(input);
    const sourceClasses = sourceClassesFromPacket(input.packet);
    const provenanceLabels = provenanceLabelsFromPacket(input.packet);
    const summary = [
      `Prompt request ${input.request_ref} prepared for ${input.invocation_class}.`,
      `Prompt=${input.prompt_contract_id}; output=${input.output_contract_ref}; model=${input.model_identifier ?? GEMINI_ROBOTICS_ER_APPROVED_MODEL}.`,
      `Sections=${input.packet?.sections.length ?? 0}; media_refs=${input.media_ref_count ?? input.packet?.media_refs.length ?? 0}; omitted=${input.omitted_section_refs?.length ?? 0}.`,
      `Tokens_in=${input.estimated_input_tokens ?? "unknown"}; tokens_out=${input.estimated_output_tokens ?? "unknown"}.`,
      validationReportSummary(input.firewall_report, input.no_rl_report),
    ].join(" ");
    const manifest = buildProvenanceManifest(makeRef("telemetry_provenance", input.event_ref), sourceClasses, provenanceLabels, summary);
    const redaction = redactText(input.event_ref, summary, "$.summary", manifest, this.redactionPolicy, "developer_observability");
    const severity = severityFromReports(input.firewall_report, input.no_rl_report, false);
    return makeRecord({
      eventKind: input.firewall_report?.decision === "reject" || input.no_rl_report?.decision === "non_compliant" ? "prompt_packet_rejected" : "prompt_packet_prepared",
      recordClass: "request",
      severity,
      requestRef: input.request_ref,
      taskStateRef: input.task_state_ref,
      invocationClass: input.invocation_class,
      promptContractId: input.prompt_contract_id,
      outputContractRef: input.output_contract_ref,
      modelIdentifier: input.model_identifier ?? GEMINI_ROBOTICS_ER_APPROVED_MODEL,
      summary: redaction.summary,
      timestampMs: input.timestamp_ms ?? this.nowMs(),
      telemetryLabels: labels,
      artifactRefs: requestArtifactRefs(input),
      requiresReobserve: false,
      requiresValidation: true,
      safeHoldRequired: severity === "error",
      uncertaintyCategories: [],
      provenanceManifest: manifest,
      redactionReport: redaction.report,
      issues,
    });
  }

  /**
   * Emits a response-side telemetry record from a structured response envelope,
   * validation reports, and optional repair report.
   */
  public summarizeResponse(input: PromptTelemetryResponseInput): PromptTelemetryRecord {
    const issues: ValidationIssue[] = [];
    validateRef(input.event_ref, "$.event_ref", issues);
    validateRef(input.request_ref, "$.request_ref", issues);
    validateRef(input.response_ref, "$.response_ref", issues);
    const envelope = input.response_envelope;
    const confidenceValue = envelope?.confidence.value;
    const uncertaintyCategories = uniqueStrings(envelope?.uncertainties.map((entry) => entry.category) ?? []);
    const requiresReobserve = envelope?.uncertainties.some((entry) => entry.requires_reobserve) === true
      || envelope?.reobserve_request !== undefined
      || input.uncertainty_report?.reobserve_required === true;
    const summary = [
      `Response ${input.response_ref} ${input.released ? "released" : "blocked"} for ${input.expected_contract_ref}.`,
      `Confidence=${confidenceValue ?? "unknown"}; uncertainties=${uncertaintyCategories.join(",") || "none"}.`,
      `Validation=${envelope?.requires_validation === true ? "required" : "not_asserted"}; reobserve=${requiresReobserve}; safe_hold=${input.safe_hold_required}.`,
      input.repair_report === undefined ? "Repair=not_requested." : `Repair=${input.repair_report.decision}; eligibility=${input.repair_report.eligibility}.`,
      compactRawResponseSummary(input.raw_response_summary),
      validationReportSummary(input.firewall_report, input.no_rl_report),
    ].join(" ");
    const sourceClasses: readonly PromptTelemetrySourceClass[] = ["model_output", "adapter_metadata", ...(input.repair_report === undefined ? [] : ["validator_feedback" as const])];
    const manifest = buildProvenanceManifest(makeRef("telemetry_provenance", input.event_ref), sourceClasses, [], summary);
    const redaction = redactText(input.response_ref, summary, "$.summary", manifest, this.redactionPolicy, input.released ? "developer_observability" : "redacted");
    const severity = input.safe_hold_required || !input.released ? "error" : severityFromReports(input.firewall_report, input.no_rl_report, input.uncertainty_report?.decision === "repair_required");
    return makeRecord({
      eventKind: input.repair_report === undefined ? "structured_response_validated" : "response_repair_requested",
      recordClass: input.repair_report === undefined ? "validation" : "repair",
      severity,
      requestRef: input.request_ref,
      responseRef: input.response_ref,
      invocationClass: input.invocation_class,
      promptContractId: PROMPT_TELEMETRY_CONTRACT_ID,
      outputContractRef: input.expected_contract_ref,
      modelIdentifier: GEMINI_ROBOTICS_ER_APPROVED_MODEL,
      summary: redaction.summary,
      timestampMs: input.timestamp_ms ?? this.nowMs(),
      telemetryLabels: uniqueRefs([input.event_ref, input.request_ref, input.response_ref]),
      artifactRefs: responseArtifactRefs(input),
      confidenceValue,
      uncertaintyCategories,
      requiresReobserve,
      requiresValidation: envelope?.requires_validation === true,
      safeHoldRequired: input.safe_hold_required,
      latencyMs: input.latency_ms,
      provenanceManifest: manifest,
      redactionReport: redaction.report,
      issues,
    });
  }

  /**
   * Projects a telemetry record into a QA-safe row for regression datasets.
   */
  public toQARow(record: PromptTelemetryRecord): PromptTelemetryQARow {
    const base = {
      schema_version: PROMPT_TELEMETRY_CONTRACT_SCHEMA_VERSION,
      row_ref: makeRef("prompt_qa_row", record.telemetry_ref),
      telemetry_ref: record.telemetry_ref,
      request_ref: record.request_ref,
      response_ref: record.response_ref,
      invocation_class: record.invocation_class,
      output_contract_ref: record.output_contract_ref,
      event_kind: record.event_kind,
      severity: record.severity,
      summary: record.summary,
      released: record.severity !== "error" && record.redaction_report.decision !== "blocked",
      redaction_decision: record.redaction_report.decision,
      truth_boundary_status: record.provenance_manifest.truth_boundary_status,
      safe_hold_required: record.safe_hold_required,
      repair_attempted: record.event_kind === "response_repair_requested" || /repair/i.test(record.summary),
      latency_ms: record.latency_ms,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }
}

function makeRecord(input: {
  readonly eventKind: PromptTelemetryEventKind;
  readonly recordClass: PromptTelemetryRecordClass;
  readonly severity: PromptTelemetrySeverity;
  readonly requestRef?: Ref;
  readonly responseRef?: Ref;
  readonly taskStateRef?: Ref;
  readonly invocationClass?: CognitiveInvocationClass;
  readonly promptContractId?: PromptContractId | typeof PROMPT_TELEMETRY_CONTRACT_ID;
  readonly outputContractRef?: StructuredResponseContractRef;
  readonly modelIdentifier?: string;
  readonly summary: string;
  readonly timestampMs: number;
  readonly telemetryLabels: readonly Ref[];
  readonly artifactRefs: readonly Ref[];
  readonly confidenceValue?: StructuredConfidenceValue;
  readonly uncertaintyCategories: readonly StructuredUncertaintyCategory[];
  readonly requiresReobserve: boolean;
  readonly requiresValidation: boolean;
  readonly safeHoldRequired: boolean;
  readonly latencyMs?: number;
  readonly provenanceManifest: PromptTelemetryProvenanceManifest;
  readonly redactionReport: PromptTelemetryRedactionReport;
  readonly issues: readonly ValidationIssue[];
}): PromptTelemetryRecord {
  const base = {
    schema_version: PROMPT_TELEMETRY_CONTRACT_SCHEMA_VERSION,
    event_kind: input.eventKind,
    record_class: input.recordClass,
    severity: input.severity,
    visibility: input.redactionReport.visibility,
    request_ref: input.requestRef,
    response_ref: input.responseRef,
    task_state_ref: input.taskStateRef,
    invocation_class: input.invocationClass,
    prompt_contract_id: input.promptContractId,
    output_contract_ref: input.outputContractRef,
    model_identifier: input.modelIdentifier,
    summary: input.summary,
    timestamp_ms: input.timestampMs,
    telemetry_labels: freezeArray(input.telemetryLabels.slice(0, MAX_TELEMETRY_LABELS)),
    artifact_refs: freezeArray(input.artifactRefs.slice(0, MAX_ARTIFACT_REFS)),
    confidence_value: input.confidenceValue,
    uncertainty_categories: freezeArray(input.uncertaintyCategories),
    requires_reobserve: input.requiresReobserve,
    requires_validation: input.requiresValidation,
    safe_hold_required: input.safeHoldRequired,
    latency_ms: input.latencyMs,
    provenance_manifest: input.provenanceManifest,
    redaction_report: input.redactionReport,
    issues: freezeArray([...input.issues, ...input.redactionReport.issues]),
  };
  return Object.freeze({
    telemetry_ref: makeRef("prompt_telemetry", input.eventKind, input.requestRef ?? input.responseRef ?? "global", String(input.timestampMs)),
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function buildProvenanceManifest(
  manifestRef: Ref,
  sourceClasses: readonly PromptTelemetrySourceClass[],
  provenanceLabels: readonly PromptProvenanceLabel[],
  textForAudit: string,
): PromptTelemetryProvenanceManifest {
  const rawMediaDetected = RAW_MEDIA_PATTERN.test(textForAudit);
  const forbiddenDetected = FORBIDDEN_TELEMETRY_PATTERN.test(textForAudit);
  const truthBoundary = truthBoundaryFor(sourceClasses, provenanceLabels, forbiddenDetected);
  const auditNotes = [
    ...(forbiddenDetected ? ["restricted content pattern detected"] : []),
    ...(rawMediaDetected ? ["raw media payload detected"] : []),
    ...(sourceClasses.includes("memory_prior") ? ["memory is labeled as prior belief"] : []),
    ...(sourceClasses.includes("validator_feedback") ? ["validator feedback is summary-only"] : []),
  ];
  const base = {
    manifest_ref: manifestRef,
    source_classes: uniqueStrings(sourceClasses),
    provenance_labels: uniqueStrings(provenanceLabels),
    truth_boundary_status: truthBoundary,
    forbidden_content_detected: forbiddenDetected,
    raw_media_detected: rawMediaDetected,
    audit_notes: freezeArray(auditNotes),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function redactText(
  sourceRef: Ref,
  text: string,
  path: string,
  manifest: PromptTelemetryProvenanceManifest,
  policy: PromptTelemetryRedactionPolicy,
  requestedVisibility: PromptTelemetryVisibility,
): { readonly summary: string; readonly report: PromptTelemetryRedactionReport } {
  const issues: ValidationIssue[] = [];
  const redactedPaths: string[] = [];
  const rules: string[] = [];
  let summary = compactText(text, policy.max_summary_chars);
  let decision: PromptTelemetryRedactionDecision = "none";
  let visibility = requestedVisibility;
  if (manifest.raw_media_detected && policy.redact_media_payloads) {
    summary = summary.replace(RAW_MEDIA_PATTERN, RAW_MEDIA_REDACTION);
    redactedPaths.push(path);
    rules.push("raw_media_payload_redacted");
    decision = "redacted";
    visibility = "redacted";
  }
  if (manifest.forbidden_content_detected && (policy.redact_raw_prompt_text || policy.redact_raw_response_text)) {
    summary = summary.replace(FORBIDDEN_TELEMETRY_PATTERN, REDACTED_TEXT);
    redactedPaths.push(path);
    rules.push("forbidden_telemetry_pattern_redacted");
    decision = "redacted";
    visibility = "redacted";
    issues.push(issue("warning", "PromptTelemetryRedactionApplied", path, "Telemetry summary contained forbidden prompt-observability content.", "Store only redacted summary and replay-safe references."));
  }
  if (manifest.truth_boundary_status === "truth_boundary_violation" && policy.block_forbidden_runtime_content) {
    decision = "blocked";
    visibility = "blocked";
    rules.push("truth_boundary_violation_blocked");
    issues.push(issue("error", "PromptTelemetryBlocked", path, "Telemetry record crossed the prompt truth boundary.", "Audit the source and remove hidden or privileged content."));
  } else if (manifest.truth_boundary_status === "qa_only" && !policy.allow_qa_truth_in_qa_records) {
    decision = decision === "none" ? "summary_only" : decision;
    visibility = "qa_only";
    rules.push("qa_truth_summary_only");
  }
  const base = {
    schema_version: PROMPT_TELEMETRY_CONTRACT_SCHEMA_VERSION,
    redaction_report_ref: makeRef("prompt_redaction", sourceRef, decision),
    source_ref: sourceRef,
    decision,
    visibility,
    redacted_field_paths: uniqueRefs(redactedPaths),
    rules_applied: uniqueRefs(rules),
    audit_required: decision === "redacted" || decision === "blocked",
    issues: freezeArray(issues),
  };
  return Object.freeze({
    summary,
    report: Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    }),
  });
}

function truthBoundaryFor(
  sourceClasses: readonly PromptTelemetrySourceClass[],
  provenanceLabels: readonly PromptProvenanceLabel[],
  forbiddenDetected: boolean,
): PromptTelemetryTruthBoundary {
  if (forbiddenDetected) {
    return "truth_boundary_violation";
  }
  if (sourceClasses.includes("qa_truth")) {
    return "qa_only";
  }
  if (sourceClasses.includes("model_output")) {
    return "model_output_labeled";
  }
  if (sourceClasses.includes("validator_feedback") || provenanceLabels.includes("validator_feedback")) {
    return "validator_feedback_labeled";
  }
  if (sourceClasses.includes("memory_prior") || provenanceLabels.includes("memory_prior")) {
    return "memory_labeled";
  }
  return "sensor_or_policy_only";
}

function telemetryLabelsFromRequest(input: PromptTelemetryRequestInput): readonly Ref[] {
  return uniqueRefs([
    input.event_ref,
    input.request_ref,
    input.task_state_ref,
    ...(input.packet?.telemetry_labels ?? []),
  ]).slice(0, MAX_TELEMETRY_LABELS);
}

function requestArtifactRefs(input: PromptTelemetryRequestInput): readonly Ref[] {
  return uniqueRefs([
    input.request_ref,
    input.task_state_ref,
    input.prompt_contract_id,
    input.output_contract_ref,
    ...(input.packet?.sections.map((section) => section.section_ref) ?? []),
    ...(input.packet?.media_refs ?? []),
    ...(input.omitted_section_refs ?? []),
  ]).slice(0, MAX_ARTIFACT_REFS);
}

function responseArtifactRefs(input: PromptTelemetryResponseInput): readonly Ref[] {
  return uniqueRefs([
    input.request_ref,
    input.response_ref,
    input.expected_contract_ref,
    ...(input.response_envelope?.evidence_used.map((evidence) => evidence.evidence_ref) ?? []),
    ...(input.repair_report?.repair_prompt === undefined ? [] : [input.repair_report.repair_prompt.repair_prompt_ref]),
  ]).slice(0, MAX_ARTIFACT_REFS);
}

function sourceClassesFromPacket(packet: CognitivePromptPacketCandidate | undefined): readonly PromptTelemetrySourceClass[] {
  if (packet === undefined) {
    return freezeArray(["adapter_metadata", "schema_instruction"]);
  }
  const classes: PromptTelemetrySourceClass[] = ["adapter_metadata", "schema_instruction"];
  for (const section of packet.sections) {
    classes.push(sourceClassForSection(section));
  }
  return uniqueStrings(classes);
}

function sourceClassForSection(section: CognitivePromptPacketSection): PromptTelemetrySourceClass {
  switch (section.provenance_label) {
    case "sensor_visual_current":
    case "sensor_audio_current":
    case "sensor_contact_current":
    case "proprioceptive_current":
    case "inference_from_evidence":
      return "sensor_evidence";
    case "memory_prior":
      return "memory_prior";
    case "validator_feedback":
      return "validator_feedback";
    case "embodiment_self_knowledge":
      return "embodiment_context";
    case "human_instruction":
      return "human_instruction";
    case "safety_policy":
      return "safety_policy";
    case "schema_instruction":
    case "system_contract":
    case "telemetry_label":
      return "schema_instruction";
  }
}

function provenanceLabelsFromPacket(packet: CognitivePromptPacketCandidate | undefined): readonly PromptProvenanceLabel[] {
  return uniqueStrings(packet?.sections.map((section) => section.provenance_label) ?? []);
}

function validationReportSummary(firewall: PromptFirewallValidationReport | undefined, noRL: NoRLComplianceReport | undefined): string {
  return `Firewall=${firewall?.decision ?? "not_run"}; no_rl=${noRL?.decision ?? "not_run"}.`;
}

function severityFromReports(
  firewall: PromptFirewallValidationReport | undefined,
  noRL: NoRLComplianceReport | undefined,
  uncertaintyRepairRequired: boolean,
): PromptTelemetrySeverity {
  if (firewall?.decision === "reject" || firewall?.decision === "quarantine" || noRL?.decision === "non_compliant" || noRL?.decision === "quarantine_required") {
    return "error";
  }
  if (uncertaintyRepairRequired || firewall?.decision === "allow_with_warnings" || noRL?.decision === "compliant_with_warnings") {
    return "warning";
  }
  return "info";
}

function compactRawResponseSummary(summary: string | undefined): string {
  if (summary === undefined || summary.trim().length === 0) {
    return "Raw response summary unavailable.";
  }
  return `Raw response summary=${compactText(summary, 360)}.`;
}

function validateRef(ref: Ref, path: string, issues: ValidationIssue[]): void {
  if (ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(issue("error", "ReferenceInvalid", path, "Reference must be non-empty and whitespace-free.", "Use a stable opaque reference."));
  }
  if (FORBIDDEN_TELEMETRY_PATTERN.test(ref)) {
    issues.push(issue("error", "ReferenceContainsForbiddenContent", path, "Reference contains forbidden telemetry-boundary terminology.", "Use prompt-safe opaque references."));
  }
}

function compactText(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function uniqueRefs(items: readonly (Ref | undefined)[]): readonly Ref[] {
  return freezeArray([...new Set(items.filter((item): item is Ref => item !== undefined && item.trim().length > 0))]);
}

function uniqueStrings<T extends string>(items: readonly T[]): readonly T[] {
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

function freezeRedactionPolicy(policy: PromptTelemetryRedactionPolicy): PromptTelemetryRedactionPolicy {
  return Object.freeze({ ...policy });
}

function buildDescriptor(redactionPolicy: PromptTelemetryRedactionPolicy): PromptTelemetryContractDescriptor {
  const base = {
    schema_version: PROMPT_TELEMETRY_CONTRACT_SCHEMA_VERSION,
    contract_id: PROMPT_TELEMETRY_CONTRACT_ID,
    contract_version: PROMPT_TELEMETRY_CONTRACT_VERSION,
    telemetry_policy_version: PROMPT_TELEMETRY_POLICY_VERSION,
    prompt_packet_contract_version: COGNITIVE_PROMPT_PACKET_CONTRACT_VERSION,
    structured_response_contract_version: STRUCTURED_RESPONSE_CONTRACT_VERSION,
    firewall_contract_version: PROMPT_FIREWALL_VALIDATION_CONTRACT_VERSION,
    no_rl_contract_version: NO_RL_PROMPT_COMPLIANCE_CONTRACT_VERSION,
    uncertainty_contract_version: UNCERTAINTY_REPORTING_CONTRACT_VERSION,
    response_repair_contract_version: RESPONSE_REPAIR_CONTRACT_VERSION,
    prompt_regression_contract_version: PROMPT_REGRESSION_CONTRACT_VERSION,
    model_profile_ref: GEMINI_ROBOTICS_ER_APPROVED_MODEL,
    input_firewall_ref: COGNITIVE_PROMPT_FIREWALL_POLICY_REF,
    output_validator_ref: COGNITIVE_OUTPUT_VALIDATOR_POLICY_REF,
    traceability_ref: CONTRACT_TRACEABILITY_REF,
    redaction_policy: redactionPolicy,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

const DEFAULT_PROMPT_TELEMETRY_REDACTION_POLICY: PromptTelemetryRedactionPolicy = Object.freeze({
  policy_ref: "prompt_telemetry_redaction_policy:observability_v1",
  max_summary_chars: DEFAULT_MAX_SUMMARY_CHARS,
  redact_raw_prompt_text: true,
  redact_raw_response_text: true,
  redact_media_payloads: true,
  block_forbidden_runtime_content: true,
  allow_qa_truth_in_qa_records: false,
});

export const PROMPT_TELEMETRY_CONTRACT_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: PROMPT_TELEMETRY_CONTRACT_SCHEMA_VERSION,
  blueprint: "architecture_docs/07_PROMPT_CONTRACTS_AND_STRUCTURED_OUTPUTS.md",
  supporting_blueprints: freezeArray([
    "architecture_docs/06_GEMINI_ROBOTICS_ER_COGNITIVE_LAYER.md",
    "architecture_docs/17_INTERNAL_MONOLOGUE_TTS_OBSERVABILITY.md",
    "architecture_docs/20_QA_TESTING_CHAOS_AND_BENCHMARK_ARCHITECTURE.md",
  ]),
  sections: freezeArray(["7.3", "7.4", "7.5", "7.6", "7.7", "7.18", "7.20", "7.23", "7.24"]),
});
