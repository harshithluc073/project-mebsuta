/**
 * State payload firewall for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md`
 * sections 8.3, 8.4, 8.6, 8.7, 8.14, 8.16, 8.17, 8.18, and 8.19.
 *
 * This module implements the executable `StatePayloadFirewall`. It preserves
 * simulation blindness at orchestration boundaries by classifying transition
 * payload references and summaries, blocking hidden simulator truth, backend
 * identifiers, restricted control data, QA-only facts, and prompt-private
 * material before any payload can enter cognitive-facing states.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import type {
  EventSeverity,
  OrchestrationEventEnvelope,
  PayloadProvenanceClass,
  PrimaryState,
  RuntimeStateSnapshot,
} from "./orchestration_state_machine";

export const STATE_PAYLOAD_FIREWALL_SCHEMA_VERSION = "mebsuta.state_payload_firewall.v1" as const;
export const STATE_PAYLOAD_FIREWALL_VERSION = "1.0.0" as const;

const CONTRACT_TRACEABILITY_REF = "architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md#StatePayloadFirewall" as const;
const SUPPORTING_FIREWALL_BLUEPRINT_REF = "architecture_docs/02_INFORMATION_FIREWALL_AND_EMBODIED_REALISM.md" as const;
const MAX_HUMAN_SUMMARY_CHARS = 900;
const MAX_SANITIZED_TEXT_CHARS = 700;

export type PayloadDestination =
  | "state_transition"
  | "cognitive_plan"
  | "cognitive_repair"
  | "cognitive_correct"
  | "cognitive_tool_assess"
  | "cognitive_audio_attend"
  | "monologue"
  | "memory_update"
  | "verification"
  | "execution"
  | "safe_hold"
  | "audit_only";

export type PayloadFieldKind =
  | "ref"
  | "human_summary"
  | "sanitized_summary"
  | "sensor_summary"
  | "memory_summary"
  | "validator_summary"
  | "telemetry_summary"
  | "operator_summary"
  | "unknown";

export type PayloadLeakCategory =
  | "simulation_awareness"
  | "hidden_truth"
  | "backend_identifier"
  | "scene_graph_reference"
  | "exact_pose_or_coordinate"
  | "collision_mesh_or_solver_truth"
  | "qa_or_oracle_truth"
  | "debug_or_internal_buffer"
  | "prompt_private_material"
  | "restricted_control_data"
  | "validator_bypass"
  | "memory_without_provenance"
  | "forbidden_provenance"
  | "missing_provenance"
  | "stale_context";

export type PayloadLeakSeverity = "critical" | "high" | "medium" | "low";
export type PayloadFirewallDecision = "allow" | "allow_with_redactions" | "quarantine" | "block";
export type PayloadSanitizationAction = "none" | "redact_text" | "drop_ref" | "drop_field" | "quarantine_only";
export type PayloadFirewallGuardDecision = "pass" | "warning" | "fail";

export interface StatePayloadFirewallPolicy {
  readonly block_on_missing_provenance: boolean;
  readonly quarantine_non_cognitive_leaks: boolean;
  readonly allow_controller_refs_for_execution: boolean;
  readonly allow_qa_refs_for_audit_only: boolean;
  readonly require_current_context_for_cognitive: boolean;
  readonly max_human_summary_chars: number;
  readonly additional_forbidden_patterns: readonly RegExp[];
}

export interface TransitionPayloadField {
  readonly field_ref: Ref;
  readonly path: string;
  readonly kind: PayloadFieldKind;
  readonly value: string;
  readonly provenance_class?: PayloadProvenanceClass;
  readonly evidence_refs?: readonly Ref[];
  readonly source_component_ref?: Ref;
  readonly prompt_visible: boolean;
}

export interface StatePayloadFirewallRequest {
  readonly snapshot: RuntimeStateSnapshot;
  readonly event: OrchestrationEventEnvelope;
  readonly destination?: PayloadDestination;
  readonly payload_fields?: readonly TransitionPayloadField[];
  readonly policy?: Partial<StatePayloadFirewallPolicy>;
  readonly occurred_at_ms?: number;
}

export interface PayloadFirewallFinding {
  readonly finding_ref: Ref;
  readonly category: PayloadLeakCategory;
  readonly severity: PayloadLeakSeverity;
  readonly path: string;
  readonly matched_excerpt: string;
  readonly remediation: string;
  readonly quarantine_required: boolean;
  readonly blocking: boolean;
}

export interface SanitizedTransitionPayloadField {
  readonly field_ref: Ref;
  readonly path: string;
  readonly kind: PayloadFieldKind;
  readonly original_provenance_class?: PayloadProvenanceClass;
  readonly sanitized_value?: string;
  readonly retained: boolean;
  readonly prompt_visible: boolean;
  readonly sanitization_actions: readonly PayloadSanitizationAction[];
  readonly evidence_refs: readonly Ref[];
}

export interface StatePayloadFirewallGuardResult {
  readonly guard_name: "PayloadProvenanceGuard";
  readonly decision: PayloadFirewallGuardDecision;
  readonly blocking: boolean;
  readonly reason: string;
  readonly evidence_refs: readonly Ref[];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface StatePayloadFirewallReport {
  readonly schema_version: typeof STATE_PAYLOAD_FIREWALL_SCHEMA_VERSION;
  readonly firewall_version: typeof STATE_PAYLOAD_FIREWALL_VERSION;
  readonly decision: PayloadFirewallDecision;
  readonly destination: PayloadDestination;
  readonly cognitive_facing: boolean;
  readonly sanitized_payload_refs: readonly Ref[];
  readonly rejected_payload_refs: readonly Ref[];
  readonly sanitized_fields: readonly SanitizedTransitionPayloadField[];
  readonly findings: readonly PayloadFirewallFinding[];
  readonly guard_result: StatePayloadFirewallGuardResult;
  readonly issue_count: number;
  readonly error_count: number;
  readonly warning_count: number;
  readonly issues: readonly ValidationIssue[];
  readonly traceability_ref: typeof CONTRACT_TRACEABILITY_REF;
  readonly supporting_firewall_blueprint: typeof SUPPORTING_FIREWALL_BLUEPRINT_REF;
  readonly determinism_hash: string;
}

export interface PayloadLeakSafeHoldEventRequest {
  readonly report: StatePayloadFirewallReport;
  readonly snapshot: RuntimeStateSnapshot;
  readonly source_event: OrchestrationEventEnvelope;
  readonly occurred_at_ms: number;
}

/**
 * Deterministic payload firewall for File 08 transition payloads. It evaluates
 * event payload refs, human summaries, provenance classes, and optional
 * field-level payload entries before they are made visible to cognition,
 * monologue, memory, verification, or audit surfaces.
 */
export class StatePayloadFirewall {
  /**
   * Evaluates a transition payload and returns the sanitized refs/fields plus a
   * guard result suitable for the state machine's `PayloadProvenanceGuard`.
   */
  public evaluateTransitionPayload(request: StatePayloadFirewallRequest): StatePayloadFirewallReport {
    const policy = mergePolicy(request.policy);
    const destination = request.destination ?? destinationForState(request.event.target_state_hint ?? request.snapshot.primary_state);
    const cognitiveFacing = isCognitiveFacingDestination(destination);
    const issues = validateRequest(request, policy, destination, cognitiveFacing);
    const eventFields = buildEventFields(request.event);
    const fields = freezeArray([...eventFields, ...(request.payload_fields ?? [])]);
    const findings = collectFindings(fields, request, policy, destination, cognitiveFacing);
    const sanitizedFields = freezeArray(fields.map((field) => sanitizeField(field, findings, policy, destination, cognitiveFacing)));
    const sanitizedPayloadRefs = uniqueRefs(sanitizedFields.filter((field) => field.retained && field.kind === "ref").map((field) => field.sanitized_value));
    const rejectedPayloadRefs = uniqueRefs(sanitizedFields.filter((field) => !field.retained && field.kind === "ref").map((field) => field.field_ref));
    const decision = chooseDecision(findings, issues, destination, cognitiveFacing);
    const guardResult = makeGuardResult(decision, findings, issues, sanitizedFields, cognitiveFacing);
    return makeReport(decision, destination, cognitiveFacing, sanitizedPayloadRefs, rejectedPayloadRefs, sanitizedFields, findings, guardResult, issues);
  }

  /**
   * Convenience API for File 08 guard integration. It returns true only when
   * the payload can cross the requested boundary without blocking.
   */
  public payloadAllowed(request: StatePayloadFirewallRequest): boolean {
    const report = this.evaluateTransitionPayload(request);
    return report.guard_result.blocking === false;
  }

  /**
   * Returns only prompt-visible, retained, sanitized payload fields. Callers can
   * use this to build cognitive, monologue, memory, or repair context after the
   * full firewall report has been emitted to telemetry.
   */
  public sanitizePayloadForDestination(request: StatePayloadFirewallRequest): readonly SanitizedTransitionPayloadField[] {
    return this.evaluateTransitionPayload(request).sanitized_fields.filter((field) => field.retained && field.prompt_visible);
  }

  /**
   * Builds a SafeHold event for hidden-truth leak containment. The event carries
   * only firewall report refs and safe evidence refs; rejected payload content is
   * never copied into the event summary or payload refs.
   */
  public buildLeakSafeHoldEvent(request: PayloadLeakSafeHoldEventRequest): OrchestrationEventEnvelope {
    const severity: EventSeverity = request.report.findings.some((finding) => finding.severity === "critical") ? "critical" : "error";
    const safeRefs = uniqueRefs([
      request.source_event.event_ref,
      request.snapshot.current_context_ref,
      ...request.report.sanitized_payload_refs,
      ...request.report.guard_result.evidence_refs,
    ]);
    const base = {
      event_ref: makeRef("event", "state_payload_firewall", "safe_hold", request.source_event.event_ref, request.occurred_at_ms),
      event_type: "SafeHoldCommanded" as const,
      event_family: "safety" as const,
      severity,
      session_ref: request.snapshot.session_ref,
      task_ref: request.snapshot.task_ref,
      source_state_ref: request.snapshot.primary_state,
      context_ref: request.snapshot.current_context_ref,
      payload_refs: safeRefs,
      provenance_classes: freezeArray(["safety", "schema", "telemetry"] as const),
      occurred_at_ms: request.occurred_at_ms,
      human_summary: compactText(`StatePayloadFirewall blocked ${request.report.destination} transition payload; hidden-truth-safe SafeHold required.`),
      target_state_hint: "SafeHold" as const,
      safety_mode_override: "SafeHoldRequired" as const,
    };
    return Object.freeze(base);
  }
}

function collectFindings(
  fields: readonly TransitionPayloadField[],
  request: StatePayloadFirewallRequest,
  policy: StatePayloadFirewallPolicy,
  destination: PayloadDestination,
  cognitiveFacing: boolean,
): readonly PayloadFirewallFinding[] {
  const findings: PayloadFirewallFinding[] = [];
  const eventProvenance = request.event.provenance_classes;
  for (const [index, provenanceClass] of eventProvenance.entries()) {
    inspectProvenance(provenanceClass, `$.event.provenance_classes[${index}]`, request.event.payload_refs[index], destination, cognitiveFacing, policy, findings);
  }
  for (const field of fields) {
    inspectField(field, destination, cognitiveFacing, policy, findings);
  }
  if (cognitiveFacing && policy.require_current_context_for_cognitive && request.event.context_ref !== request.snapshot.current_context_ref) {
    findings.push(makeFinding("stale_context", "high", "$.event.context_ref", request.event.context_ref ?? "missing_context_ref", true));
  }
  return freezeArray(dedupeFindings(findings));
}

function inspectField(
  field: TransitionPayloadField,
  destination: PayloadDestination,
  cognitiveFacing: boolean,
  policy: StatePayloadFirewallPolicy,
  findings: PayloadFirewallFinding[],
): void {
  validateFieldProvenance(field, destination, cognitiveFacing, policy, findings);
  scanText(field.value, field.path, cognitiveFacing || field.prompt_visible, findings, policy);
  scanText(field.field_ref, `${field.path}.field_ref`, false, findings, policy);
  for (const [index, evidenceRef] of (field.evidence_refs ?? []).entries()) {
    scanText(evidenceRef, `${field.path}.evidence_refs[${index}]`, false, findings, policy);
  }
}

function validateFieldProvenance(
  field: TransitionPayloadField,
  destination: PayloadDestination,
  cognitiveFacing: boolean,
  policy: StatePayloadFirewallPolicy,
  findings: PayloadFirewallFinding[],
): void {
  if (field.provenance_class === undefined) {
    if (policy.block_on_missing_provenance && (cognitiveFacing || field.prompt_visible)) {
      findings.push(makeFinding("missing_provenance", "high", field.path, field.field_ref, true));
    }
    return;
  }
  inspectProvenance(field.provenance_class, `${field.path}.provenance_class`, field.field_ref, destination, cognitiveFacing || field.prompt_visible, policy, findings);
  if (field.provenance_class === "memory" && (field.evidence_refs ?? []).length === 0 && (cognitiveFacing || field.prompt_visible)) {
    findings.push(makeFinding("memory_without_provenance", "high", field.path, field.field_ref, true));
  }
}

function inspectProvenance(
  provenanceClass: PayloadProvenanceClass,
  path: string,
  evidenceRef: Ref | undefined,
  destination: PayloadDestination,
  cognitiveFacing: boolean,
  policy: StatePayloadFirewallPolicy,
  findings: PayloadFirewallFinding[],
): void {
  const allowed = allowedProvenanceFor(destination, policy).has(provenanceClass);
  if (!allowed) {
    const severity: PayloadLeakSeverity = provenanceClass === "restricted" || provenanceClass === "qa_only" ? "critical" : "high";
    findings.push(makeFinding("forbidden_provenance", severity, path, evidenceRef ?? provenanceClass, cognitiveFacing));
  }
  if (cognitiveFacing && (provenanceClass === "restricted" || provenanceClass === "qa_only")) {
    findings.push(makeFinding(provenanceClass === "qa_only" ? "qa_or_oracle_truth" : "restricted_control_data", "critical", path, evidenceRef ?? provenanceClass, true));
  }
}

function scanText(
  text: string,
  path: string,
  promptVisible: boolean,
  findings: PayloadFirewallFinding[],
  policy: StatePayloadFirewallPolicy,
): void {
  if (text.trim().length === 0) {
    return;
  }
  for (const matcher of PAYLOAD_MATCHERS) {
    const match = text.match(matcher.pattern);
    if (match !== null) {
      findings.push(makeFinding(matcher.category, matcher.severity, path, redactExcerpt(match[0]), promptVisible || matcher.always_blocks));
    }
  }
  for (const pattern of policy.additional_forbidden_patterns) {
    const match = text.match(pattern);
    if (match !== null) {
      findings.push(makeFinding("hidden_truth", "critical", path, redactExcerpt(match[0]), promptVisible));
    }
  }
}

function sanitizeField(
  field: TransitionPayloadField,
  findings: readonly PayloadFirewallFinding[],
  policy: StatePayloadFirewallPolicy,
  destination: PayloadDestination,
  cognitiveFacing: boolean,
): SanitizedTransitionPayloadField {
  const fieldFindings = findings.filter((finding) => samePathOrChild(field.path, finding.path));
  const hasBlocking = fieldFindings.some((finding) => finding.blocking);
  const fieldAllowed = field.provenance_class === undefined
    ? !(policy.block_on_missing_provenance && (cognitiveFacing || field.prompt_visible))
    : allowedProvenanceFor(destination, policy).has(field.provenance_class);
  const promptVisible = field.prompt_visible || (cognitiveFacing && field.kind !== "ref");
  const shouldDrop = hasBlocking || !fieldAllowed;
  const actions: PayloadSanitizationAction[] = [];
  if (shouldDrop && field.kind === "ref") {
    actions.push("drop_ref");
  } else if (shouldDrop) {
    actions.push("drop_field");
  }
  const sanitized = shouldDrop
    ? undefined
    : sanitizeTextValue(field.value, fieldFindings, promptVisible, actions);
  if (actions.length === 0) {
    actions.push("none");
  }
  return Object.freeze({
    field_ref: field.field_ref,
    path: field.path,
    kind: field.kind,
    original_provenance_class: field.provenance_class,
    sanitized_value: sanitized,
    retained: !shouldDrop,
    prompt_visible: promptVisible,
    sanitization_actions: freezeArray(actions),
    evidence_refs: freezeArray(field.evidence_refs ?? []),
  });
}

function sanitizeTextValue(
  value: string,
  findings: readonly PayloadFirewallFinding[],
  promptVisible: boolean,
  actions: PayloadSanitizationAction[],
): string {
  if (!promptVisible || findings.length === 0) {
    return compactText(value).slice(0, MAX_SANITIZED_TEXT_CHARS);
  }
  let sanitized = value.replace(/\s+/g, " ").trim();
  for (const matcher of PAYLOAD_MATCHERS) {
    if (matcher.pattern.test(sanitized)) {
      sanitized = sanitized.replace(matcher.global_pattern, "[redacted]");
      actions.push("redact_text");
    }
  }
  return sanitized.slice(0, MAX_SANITIZED_TEXT_CHARS);
}

function chooseDecision(
  findings: readonly PayloadFirewallFinding[],
  issues: readonly ValidationIssue[],
  destination: PayloadDestination,
  cognitiveFacing: boolean,
): PayloadFirewallDecision {
  if (issues.some((issueItem) => issueItem.severity === "error") || findings.some((finding) => finding.blocking && (cognitiveFacing || finding.severity === "critical"))) {
    return "block";
  }
  if (findings.some((finding) => finding.quarantine_required)) {
    return destination === "audit_only" ? "quarantine" : "block";
  }
  if (findings.length > 0 || issues.length > 0) {
    return "allow_with_redactions";
  }
  return "allow";
}

function makeGuardResult(
  decision: PayloadFirewallDecision,
  findings: readonly PayloadFirewallFinding[],
  issues: readonly ValidationIssue[],
  fields: readonly SanitizedTransitionPayloadField[],
  cognitiveFacing: boolean,
): StatePayloadFirewallGuardResult {
  const blocking = decision === "block" || (cognitiveFacing && decision === "quarantine");
  const guardDecision: PayloadFirewallGuardDecision = blocking ? "fail" : findings.length > 0 || issues.length > 0 ? "warning" : "pass";
  const evidenceRefs = uniqueRefs([
    ...fields.flatMap((field) => field.evidence_refs),
    ...findings.map((finding) => finding.finding_ref),
  ]);
  const base = {
    guard_name: "PayloadProvenanceGuard" as const,
    decision: guardDecision,
    blocking,
    reason: blocking
      ? "Transition payload contains hidden-truth, restricted, prompt-private, or forbidden provenance content."
      : guardDecision === "warning"
        ? "Transition payload was allowed only after warning-level firewall redaction or quarantine handling."
        : "Transition payload provenance is allowed for the destination.",
    evidence_refs: evidenceRefs,
    issues: freezeArray(issues),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function makeReport(
  decision: PayloadFirewallDecision,
  destination: PayloadDestination,
  cognitiveFacing: boolean,
  sanitizedPayloadRefs: readonly Ref[],
  rejectedPayloadRefs: readonly Ref[],
  sanitizedFields: readonly SanitizedTransitionPayloadField[],
  findings: readonly PayloadFirewallFinding[],
  guardResult: StatePayloadFirewallGuardResult,
  issues: readonly ValidationIssue[],
): StatePayloadFirewallReport {
  const base = {
    schema_version: STATE_PAYLOAD_FIREWALL_SCHEMA_VERSION,
    firewall_version: STATE_PAYLOAD_FIREWALL_VERSION,
    decision,
    destination,
    cognitive_facing: cognitiveFacing,
    sanitized_payload_refs: freezeArray(sanitizedPayloadRefs),
    rejected_payload_refs: freezeArray(rejectedPayloadRefs),
    sanitized_fields: freezeArray(sanitizedFields),
    findings: freezeArray(findings),
    guard_result: guardResult,
    issue_count: issues.length,
    error_count: issues.filter((item) => item.severity === "error").length,
    warning_count: issues.filter((item) => item.severity === "warning").length,
    issues: freezeArray(issues),
    traceability_ref: CONTRACT_TRACEABILITY_REF,
    supporting_firewall_blueprint: SUPPORTING_FIREWALL_BLUEPRINT_REF,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function buildEventFields(event: OrchestrationEventEnvelope): readonly TransitionPayloadField[] {
  const refFields = event.payload_refs.map((ref, index): TransitionPayloadField => Object.freeze({
    field_ref: makeRef("payload_field", event.event_ref, "payload_ref", index),
    path: `$.event.payload_refs[${index}]`,
    kind: "ref",
    value: ref,
    provenance_class: event.provenance_classes[index],
    evidence_refs: freezeArray([ref]),
    source_component_ref: event.event_family === undefined ? undefined : makeRef("event_family", event.event_family),
    prompt_visible: false,
  }));
  const summaryField: TransitionPayloadField = Object.freeze({
    field_ref: makeRef("payload_field", event.event_ref, "human_summary"),
    path: "$.event.human_summary",
    kind: "human_summary",
    value: event.human_summary,
    provenance_class: "operator",
    evidence_refs: event.payload_refs,
    source_component_ref: event.event_family === undefined ? undefined : makeRef("event_family", event.event_family),
    prompt_visible: destinationForState(event.target_state_hint).startsWith("cognitive") || event.target_state_hint === "Monologue" || event.target_state_hint === "MemoryUpdate",
  });
  return freezeArray([...refFields, summaryField]);
}

function destinationForState(state: PrimaryState | undefined): PayloadDestination {
  switch (state) {
    case "Plan":
      return "cognitive_plan";
    case "PlanRepair":
      return "cognitive_repair";
    case "Correct":
      return "cognitive_correct";
    case "ToolAssess":
      return "cognitive_tool_assess";
    case "AudioAttend":
      return "cognitive_audio_attend";
    case "Monologue":
      return "monologue";
    case "MemoryUpdate":
      return "memory_update";
    case "Verify":
      return "verification";
    case "Execute":
      return "execution";
    case "SafeHold":
      return "safe_hold";
    default:
      return "state_transition";
  }
}

function isCognitiveFacingDestination(destination: PayloadDestination): boolean {
  return destination === "cognitive_plan"
    || destination === "cognitive_repair"
    || destination === "cognitive_correct"
    || destination === "cognitive_tool_assess"
    || destination === "cognitive_audio_attend"
    || destination === "monologue"
    || destination === "memory_update";
}

function allowedProvenanceFor(destination: PayloadDestination, policy: StatePayloadFirewallPolicy): ReadonlySet<PayloadProvenanceClass> {
  if (destination === "execution") {
    return new Set(policy.allow_controller_refs_for_execution
      ? ["sensor", "memory", "validator", "task", "safety", "schema", "controller", "telemetry", "operator"]
      : ["sensor", "memory", "validator", "task", "safety", "schema", "telemetry", "operator"]);
  }
  if (destination === "audit_only") {
    return new Set(policy.allow_qa_refs_for_audit_only
      ? ["sensor", "memory", "validator", "task", "safety", "schema", "controller", "telemetry", "operator", "qa_only"]
      : ["sensor", "memory", "validator", "task", "safety", "schema", "controller", "telemetry", "operator"]);
  }
  if (destination === "safe_hold" || destination === "verification" || destination === "state_transition") {
    return new Set(["sensor", "memory", "validator", "task", "safety", "schema", "controller", "telemetry", "operator"]);
  }
  return new Set(["sensor", "memory", "validator", "task", "safety", "schema", "operator"]);
}

function validateRequest(
  request: StatePayloadFirewallRequest,
  policy: StatePayloadFirewallPolicy,
  destination: PayloadDestination,
  cognitiveFacing: boolean,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateRef(request.snapshot.session_ref, "$.snapshot.session_ref", issues);
  validateRef(request.snapshot.task_ref, "$.snapshot.task_ref", issues);
  validateRef(request.snapshot.current_context_ref, "$.snapshot.current_context_ref", issues);
  validateRef(request.event.event_ref, "$.event.event_ref", issues);
  if (request.event.session_ref !== request.snapshot.session_ref || request.event.task_ref !== request.snapshot.task_ref) {
    issues.push(issue("error", "FirewallSessionTaskMismatch", "$.event", "Event session or task does not match the current snapshot.", "Reject stale or cross-session payloads."));
  }
  if (cognitiveFacing && policy.require_current_context_for_cognitive && request.event.context_ref !== request.snapshot.current_context_ref) {
    issues.push(issue("warning", "FirewallContextMismatch", "$.event.context_ref", "Cognitive-facing payload context differs from the current state context.", "Rebuild payload from current state or quarantine the async event."));
  }
  if (request.event.human_summary.length > policy.max_human_summary_chars) {
    issues.push(issue("warning", "FirewallSummaryTooLong", "$.event.human_summary", "Human summary exceeds the payload firewall summary budget.", "Compact the transition summary before model-facing use."));
  }
  for (const [index, field] of (request.payload_fields ?? []).entries()) {
    validateFieldShape(field, `$.payload_fields[${index}]`, issues);
  }
  if (destination === "audit_only" && cognitiveFacing) {
    issues.push(issue("error", "FirewallDestinationContradiction", "$.destination", "Audit-only destination cannot be cognitive-facing.", "Select one destination class for the payload."));
  }
  return freezeArray(issues);
}

function validateFieldShape(field: TransitionPayloadField, path: string, issues: ValidationIssue[]): void {
  validateRef(field.field_ref, `${path}.field_ref`, issues);
  if (!field.path.startsWith("$.")) {
    issues.push(issue("error", "FirewallFieldPathInvalid", `${path}.path`, "Payload field path must be a JSONPath-like path.", "Use a stable path beginning with $."));
  }
  if (field.value.trim().length === 0) {
    issues.push(issue("error", "FirewallFieldValueEmpty", `${path}.value`, "Payload field value cannot be empty.", "Omit empty fields before firewall evaluation."));
  }
  for (const [index, evidenceRef] of (field.evidence_refs ?? []).entries()) {
    validateRef(evidenceRef, `${path}.evidence_refs[${index}]`, issues);
  }
}

function validateRef(ref: Ref | undefined, path: string, issues: ValidationIssue[]): void {
  if (ref === undefined || ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(issue("error", "ReferenceInvalid", path, "Reference must be present, non-empty, and whitespace-free.", "Use a stable opaque reference."));
  }
}

function mergePolicy(policy: Partial<StatePayloadFirewallPolicy> | undefined): StatePayloadFirewallPolicy {
  return Object.freeze({
    block_on_missing_provenance: policy?.block_on_missing_provenance ?? true,
    quarantine_non_cognitive_leaks: policy?.quarantine_non_cognitive_leaks ?? true,
    allow_controller_refs_for_execution: policy?.allow_controller_refs_for_execution ?? true,
    allow_qa_refs_for_audit_only: policy?.allow_qa_refs_for_audit_only ?? false,
    require_current_context_for_cognitive: policy?.require_current_context_for_cognitive ?? true,
    max_human_summary_chars: positiveInteger(policy?.max_human_summary_chars, MAX_HUMAN_SUMMARY_CHARS),
    additional_forbidden_patterns: freezeArray(policy?.additional_forbidden_patterns ?? []),
  });
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function makeFinding(
  category: PayloadLeakCategory,
  severity: PayloadLeakSeverity,
  path: string,
  matchedExcerpt: string,
  blocking: boolean,
): PayloadFirewallFinding {
  const rule = PAYLOAD_RULES[category];
  const base = {
    category,
    severity,
    path,
    matched_excerpt: redactExcerpt(matchedExcerpt),
    remediation: rule.remediation,
    quarantine_required: rule.quarantine_required,
    blocking: blocking || rule.always_blocks,
  };
  return Object.freeze({
    finding_ref: makeRef("payload_firewall_finding", category, computeDeterminismHash(base).slice(0, 16)),
    ...base,
  });
}

function dedupeFindings(findings: readonly PayloadFirewallFinding[]): readonly PayloadFirewallFinding[] {
  const seen = new Set<string>();
  const unique: PayloadFirewallFinding[] = [];
  for (const finding of findings) {
    const key = `${finding.category}|${finding.path}|${finding.matched_excerpt}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(finding);
    }
  }
  return freezeArray(unique);
}

function samePathOrChild(fieldPath: string, findingPath: string): boolean {
  return findingPath === fieldPath || findingPath.startsWith(`${fieldPath}.`) || findingPath.startsWith(`${fieldPath}[`);
}

function issue(severity: ValidationSeverity, code: string, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_HUMAN_SUMMARY_CHARS);
}

function redactExcerpt(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

function makeRef(...parts: readonly (string | number | undefined)[]): Ref {
  const normalized = parts
    .filter((part): part is string | number => part !== undefined)
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "ref:empty";
}

function uniqueRefs(items: readonly (Ref | undefined)[]): readonly Ref[] {
  return freezeArray([...new Set(items.filter((item): item is Ref => item !== undefined && item.trim().length > 0))]);
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

interface PayloadRule {
  readonly remediation: string;
  readonly quarantine_required: boolean;
  readonly always_blocks: boolean;
}

interface PayloadMatcher {
  readonly category: PayloadLeakCategory;
  readonly severity: PayloadLeakSeverity;
  readonly pattern: RegExp;
  readonly global_pattern: RegExp;
  readonly always_blocks: boolean;
}

function matcher(category: PayloadLeakCategory, severity: PayloadLeakSeverity, pattern: string, alwaysBlocks = true): PayloadMatcher {
  return Object.freeze({
    category,
    severity,
    pattern: new RegExp(pattern, "i"),
    global_pattern: new RegExp(pattern, "gi"),
    always_blocks: alwaysBlocks,
  });
}

const PAYLOAD_RULES: Readonly<Record<PayloadLeakCategory, PayloadRule>> = Object.freeze({
  simulation_awareness: { remediation: "Remove simulator or engine framing and rebuild from embodied evidence.", quarantine_required: true, always_blocks: true },
  hidden_truth: { remediation: "Replace hidden truth with sensor-derived estimates and uncertainty.", quarantine_required: true, always_blocks: true },
  backend_identifier: { remediation: "Replace backend identifiers with opaque refs or visible descriptions.", quarantine_required: true, always_blocks: true },
  scene_graph_reference: { remediation: "Remove scene graph paths and use prompt-safe evidence refs.", quarantine_required: true, always_blocks: true },
  exact_pose_or_coordinate: { remediation: "Use estimated coordinates only when provenance and confidence are explicit.", quarantine_required: true, always_blocks: true },
  collision_mesh_or_solver_truth: { remediation: "Sanitize collision or solver detail to validator-safe reason classes.", quarantine_required: true, always_blocks: true },
  qa_or_oracle_truth: { remediation: "Keep QA-only and oracle facts out of runtime cognitive payloads.", quarantine_required: true, always_blocks: true },
  debug_or_internal_buffer: { remediation: "Replace internal buffers with safe telemetry summaries.", quarantine_required: true, always_blocks: true },
  prompt_private_material: { remediation: "Remove system, developer, chain-of-thought, scratchpad, and private deliberation material.", quarantine_required: true, always_blocks: true },
  restricted_control_data: { remediation: "Route low-level control data only to execution or validator surfaces.", quarantine_required: true, always_blocks: true },
  validator_bypass: { remediation: "Restore deterministic validator authority and SafeHold language.", quarantine_required: true, always_blocks: true },
  memory_without_provenance: { remediation: "Attach evidence refs, confidence, staleness, and contradiction status to memory.", quarantine_required: true, always_blocks: true },
  forbidden_provenance: { remediation: "Change destination or rebuild payload from allowed provenance classes.", quarantine_required: true, always_blocks: true },
  missing_provenance: { remediation: "Classify every transition field before crossing orchestration boundaries.", quarantine_required: true, always_blocks: true },
  stale_context: { remediation: "Reject or quarantine stale asynchronous context before state mutation.", quarantine_required: true, always_blocks: true },
});

const PAYLOAD_MATCHERS: readonly PayloadMatcher[] = freezeArray([
  matcher("simulation_awareness", "critical", "\\b(mujoco|babylon|simulator|simulated environment|physics engine|render engine)\\b"),
  matcher("hidden_truth", "critical", "\\b(world_truth|ground_truth|hidden state|hidden_state|hidden pose|oracle pose|privileged state)\\b"),
  matcher("backend_identifier", "critical", "\\b(backend[_ -]?(object|id|handle|name)|object_id|rigid_body_handle|physics_body|joint_handle|asset_id|internal asset|body_uid|geom_id)\\b"),
  matcher("scene_graph_reference", "critical", "\\b(scene_graph|scene graph|node path|renderer node|/world/[^\\s]+|graph path)\\b"),
  matcher("exact_pose_or_coordinate", "critical", "\\b(exact|ground.?truth|backend|hidden|oracle)\\b.{0,64}\\b(world pose|pose|coordinate|position|orientation|center of mass|com)\\b|\\b(world_pose|exact_com|hidden_pose)\\b"),
  matcher("collision_mesh_or_solver_truth", "critical", "\\b(collision_mesh|collision primitive|contact solver|contact manifold|solver island|constraint row|jacobian row|broadphase|narrowphase|internal impulse)\\b"),
  matcher("qa_or_oracle_truth", "critical", "\\b(qa[_ -]?(truth|flag|pass|oracle|success)|oracle state|benchmark answer|expected answer|test oracle|gold label)\\b"),
  matcher("debug_or_internal_buffer", "high", "\\b(debug buffer|render buffer|segmentation truth|depth truth|internal trace|stack trace|debug dump)\\b"),
  matcher("prompt_private_material", "high", "\\b(system prompt|developer prompt|chain[- ]?of[- ]?thought|scratchpad|private deliberation|hidden reasoning|full reasoning trace)\\b"),
  matcher("restricted_control_data", "critical", "\\b(direct actuator|raw actuator|joint torque|joint current|set joint|apply force|apply impulse|motor command|servo command|control tick|physics step)\\b"),
  matcher("validator_bypass", "critical", "\\b(ignore validators|override safety|disable safe.?hold|bypass validator|skip validation|act without validation|guarantee success|execution authority)\\b"),
  matcher("memory_without_provenance", "high", "\\b(memory fact|known forever|certain prior|unprovenanced memory|memory says it is true)\\b"),
]);

export const STATE_PAYLOAD_FIREWALL_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: STATE_PAYLOAD_FIREWALL_SCHEMA_VERSION,
  blueprint: "architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md",
  supporting_blueprint: SUPPORTING_FIREWALL_BLUEPRINT_REF,
  sections: freezeArray(["8.3", "8.4", "8.6", "8.7", "8.14", "8.16", "8.17", "8.18", "8.19"]),
  traceability_ref: CONTRACT_TRACEABILITY_REF,
  cognitive_facing_destinations: freezeArray([
    "cognitive_plan",
    "cognitive_repair",
    "cognitive_correct",
    "cognitive_tool_assess",
    "cognitive_audio_attend",
    "monologue",
    "memory_update",
  ] as readonly PayloadDestination[]),
});
