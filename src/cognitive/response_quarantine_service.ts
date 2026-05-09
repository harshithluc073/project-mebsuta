/**
 * Response quarantine service for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/06_GEMINI_ROBOTICS_ER_COGNITIVE_LAYER.md`
 * sections 6.6.1, 6.7.1, 6.11, 6.12.1, 6.13.3, 6.18.1, 6.19, and 6.20.
 *
 * This module holds raw Gemini Robotics-ER responses until they are parsed,
 * schema-checked against the structured output registry, safety-screened, and
 * converted into a release, repair, rejection, or safe-hold record. Nothing
 * from the model reaches validators, memory writers, TTS, or orchestration
 * without an explicit quarantine decision.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import {
  GEMINI_ROBOTICS_ER_ADAPTER_SCHEMA_VERSION,
  GEMINI_ROBOTICS_ER_APPROVED_MODEL,
} from "./gemini_robotics_er_adapter";
import type {
  CognitiveConfidenceReport,
  CognitiveInvocationClass,
  CognitiveLatencyReport,
  CognitiveParseStatus,
  CognitiveRequestEnvelope,
  CognitiveResponseEnvelope,
  CognitiveTelemetryEvent,
  CognitiveTelemetryEventType,
  QuarantineReleaseDecision,
  SemanticValidationStatus,
} from "./gemini_robotics_er_adapter";
import {
  StructuredOutputContractRegistry,
  STRUCTURED_RESPONSE_ENVELOPE_VERSION,
} from "./structured_output_contract_registry";
import type {
  ContractValidationDecision,
  StructuredOutputContractDescriptor,
  StructuredOutputContractRef,
  StructuredResponseValidationReport,
} from "./structured_output_contract_registry";

export const RESPONSE_QUARANTINE_SERVICE_SCHEMA_VERSION = "mebsuta.response_quarantine_service.v1" as const;

const RAW_RESPONSE_SUMMARY_LIMIT = 2000;
const MAX_REPAIR_PROMPT_TOKENS = 1800;
const TTS_MAX_SPEECH_CHARS = 360;
const FORBIDDEN_OUTPUT_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|qa_|collision_mesh|simulator|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|hidden|chain-of-thought|scratchpad|system prompt|developer prompt|direct actuator|raw actuator|joint torque|joint current|apply force|apply impulse|physics step|reward policy|reinforcement learning|rl update|bypass validator|override safety)/i;
const UNSAFE_ACTION_PATTERN = /(collide|collision acceptable|ignore collision|unstable|tip over|excessive force|crush|ram into|unsafe sweep|blind motion|move anyway|skip verification|without validation|bypass safety|disable safe-hold)/i;
const LOW_LEVEL_CONTROL_PATTERN = /(torque|joint current|motor current|raw actuator|set joint|apply impulse|apply force|physics step|controller override|ik bypass|pd bypass)/i;

export type QuarantineDecision =
  | "released"
  | "repair_needed"
  | "rejected"
  | "safe_hold_triggered"
  | "escalation_required";

export type SafetyScreenDecision = "passed" | "warning" | "rejected" | "safe_hold_required";
export type RepairEligibility = "eligible" | "ineligible" | "budget_exhausted";
export type ValidatorHandoffTarget = "validator_stack" | "verification_pipeline" | "memory_writer" | "tts_filter" | "safe_hold";

export interface RawModelResponseQuarantineRequest {
  readonly response_ref: Ref;
  readonly request_envelope: CognitiveRequestEnvelope;
  readonly raw_response_text: string;
  readonly model_identifier?: string;
  readonly expected_contract_ref: StructuredOutputContractRef;
  readonly received_at_ms?: number;
  readonly queue_started_at_ms?: number;
  readonly generation_started_at_ms?: number;
  readonly generation_completed_at_ms?: number;
  readonly repair_attempt_count?: number;
}

export interface ParsedStructuredResponse {
  readonly parse_status: CognitiveParseStatus;
  readonly parsed_payload?: unknown;
  readonly extracted_json_text?: string;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface CognitiveSafetyScreenReport {
  readonly schema_version: typeof RESPONSE_QUARANTINE_SERVICE_SCHEMA_VERSION;
  readonly response_ref: Ref;
  readonly decision: SafetyScreenDecision;
  readonly hidden_content_detected: boolean;
  readonly direct_control_detected: boolean;
  readonly unsafe_action_detected: boolean;
  readonly monologue_policy_violation: boolean;
  readonly memory_truth_violation: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface RepairPromptPacket {
  readonly schema_version: typeof RESPONSE_QUARANTINE_SERVICE_SCHEMA_VERSION;
  readonly repair_ref: Ref;
  readonly source_response_ref: Ref;
  readonly target_contract_ref: StructuredOutputContractRef;
  readonly repair_reason: readonly string[];
  readonly original_contract_summary: string;
  readonly safe_context_subset: string;
  readonly forbidden_content_reminder: string;
  readonly repair_budget_remaining: number;
  readonly output_only_instruction: string;
  readonly estimated_tokens: number;
  readonly determinism_hash: string;
}

export interface ValidatorHandoffPacket {
  readonly schema_version: typeof RESPONSE_QUARANTINE_SERVICE_SCHEMA_VERSION;
  readonly handoff_ref: Ref;
  readonly source_response_ref: Ref;
  readonly target: ValidatorHandoffTarget;
  readonly action_intent?: unknown;
  readonly object_hypotheses?: unknown;
  readonly spatial_targets?: unknown;
  readonly constraints?: unknown;
  readonly embodiment_requirements?: unknown;
  readonly safety_notes: readonly string[];
  readonly confidence_and_uncertainty: {
    readonly confidence: string;
    readonly uncertainties: readonly unknown[];
  };
  readonly required_validators: readonly string[];
  readonly failure_recovery_hint?: unknown;
  readonly determinism_hash: string;
}

export interface ResponseQuarantineReport {
  readonly schema_version: typeof RESPONSE_QUARANTINE_SERVICE_SCHEMA_VERSION;
  readonly response_ref: Ref;
  readonly request_ref: Ref;
  readonly expected_contract_ref: StructuredOutputContractRef;
  readonly decision: QuarantineDecision;
  readonly parse_report: ParsedStructuredResponse;
  readonly contract_validation_report: StructuredResponseValidationReport;
  readonly safety_screen_report: CognitiveSafetyScreenReport;
  readonly repair_eligibility: RepairEligibility;
  readonly repair_prompt?: RepairPromptPacket;
  readonly validator_handoff?: ValidatorHandoffPacket;
  readonly cognitive_response_envelope: CognitiveResponseEnvelope;
  readonly issues: readonly ValidationIssue[];
  readonly telemetry_events: readonly CognitiveTelemetryEvent[];
  readonly determinism_hash: string;
}

/**
 * Quarantines raw model output and releases only schema-valid, safety-screened
 * structured responses. Repair prompts are produced deterministically when a
 * malformed response is still eligible for a single safe repair attempt.
 */
export class ResponseQuarantineService {
  private readonly registry: StructuredOutputContractRegistry;
  private readonly nowMs: () => number;

  public constructor(
    registry: StructuredOutputContractRegistry = new StructuredOutputContractRegistry(),
    nowMs: () => number = () => Date.now(),
  ) {
    this.registry = registry;
    this.nowMs = nowMs;
  }

  /**
   * Executes the full quarantine path: parse raw text, resolve the expected
   * contract, validate the structured payload, run safety screening, decide
   * repair/rejection/release, and build the adapter-compatible response record.
   */
  public quarantineRawResponse(request: RawModelResponseQuarantineRequest): ResponseQuarantineReport {
    const startedMs = this.nowMs();
    const telemetry: CognitiveTelemetryEvent[] = [
      makeTelemetry("ResponseQuarantined", request.response_ref, request.model_identifier ?? request.request_envelope.model_identifier, request.expected_contract_ref, "info", "Raw model response entered quarantine.", request.received_at_ms ?? startedMs),
    ];
    const parseReport = parseStructuredResponse(request.raw_response_text);
    const resolution = this.registry.resolveContract({
      invocation_class: request.request_envelope.invocation_class,
      model_identifier: request.model_identifier ?? request.request_envelope.model_identifier,
      requested_contract_ref: request.expected_contract_ref,
    });
    const descriptor = resolution.descriptor;
    const contractValidationReport = this.registry.validateStructuredResponse({
      response_ref: request.response_ref,
      invocation_class: request.request_envelope.invocation_class,
      expected_contract_ref: request.expected_contract_ref,
      payload: parseReport.parsed_payload,
      repair_attempt_count: request.repair_attempt_count ?? 0,
    });
    const safetyScreenReport = this.runSafetyScreen(request.response_ref, request.request_envelope.invocation_class, request.expected_contract_ref, parseReport.parsed_payload, descriptor);
    const issues = freezeArray([
      ...parseReport.issues,
      ...resolution.issues,
      ...contractValidationReport.issues,
      ...safetyScreenReport.issues,
    ]);
    const decision = chooseQuarantineDecision(parseReport, contractValidationReport, safetyScreenReport, request.request_envelope.invocation_class);
    const repairEligibility = determineRepairEligibility(decision, parseReport, contractValidationReport, safetyScreenReport, request.repair_attempt_count ?? 0, descriptor);
    const repairPrompt = repairEligibility === "eligible" && descriptor !== undefined
      ? this.requestResponseRepair(request, descriptor, [...issues])
      : undefined;
    const validatorHandoff = decision === "released" && descriptor !== undefined && isRecord(parseReport.parsed_payload)
      ? this.extractValidatorHandoff(request.response_ref, parseReport.parsed_payload, descriptor)
      : undefined;
    telemetry.push(makeTelemetry(
      decision === "released" ? "ResponseReleased" : "ResponseRejected",
      request.response_ref,
      request.model_identifier ?? request.request_envelope.model_identifier,
      request.expected_contract_ref,
      decision === "released" ? "info" : decision === "repair_needed" ? "warning" : "error",
      `Response quarantine decision: ${decision}.`,
      this.nowMs(),
    ));
    const cognitiveResponseEnvelope = buildCognitiveResponseEnvelope(
      request,
      parseReport,
      issues,
      telemetry,
      decision,
      request.generation_started_at_ms ?? startedMs,
      request.generation_completed_at_ms ?? startedMs,
      startedMs,
      this.nowMs(),
    );
    const base = {
      schema_version: RESPONSE_QUARANTINE_SERVICE_SCHEMA_VERSION,
      response_ref: request.response_ref,
      request_ref: request.request_envelope.request_ref,
      expected_contract_ref: request.expected_contract_ref,
      decision,
      parse_report: parseReport,
      contract_validation_report: contractValidationReport,
      safety_screen_report: safetyScreenReport,
      repair_eligibility: repairEligibility,
      repair_prompt: repairPrompt,
      validator_handoff: validatorHandoff,
      cognitive_response_envelope: cognitiveResponseEnvelope,
      issues,
      telemetry_events: freezeArray(telemetry),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Builds the repair-only prompt required by the architecture. It includes the
   * failed contract fields, a compact safe context subset, a forbidden-content
   * reminder, and a strict output-only instruction.
   */
  public requestResponseRepair(
    request: RawModelResponseQuarantineRequest,
    descriptor: StructuredOutputContractDescriptor,
    issues: readonly ValidationIssue[],
  ): RepairPromptPacket {
    const reasons = issues
      .filter((item) => item.severity === "error")
      .map((item) => `${item.code} at ${item.path}: ${item.message}`)
      .slice(0, 12);
    const contractSummary = summarizeContract(descriptor);
    const safeContextSubset = summarizeSafeContext(request.request_envelope);
    const outputOnlyInstruction = [
      `Return only valid JSON for ${descriptor.metadata.contract_ref}.`,
      `Set response_contract_id to "${descriptor.metadata.contract_ref}" and contract_version_ack to "${STRUCTURED_RESPONSE_ENVELOPE_VERSION}".`,
      "Do not include markdown fences, explanations, actuator commands, hidden reasoning, simulator details, backend identifiers, or unvalidated execution claims.",
    ].join(" ");
    const base = {
      schema_version: RESPONSE_QUARANTINE_SERVICE_SCHEMA_VERSION,
      repair_ref: makeRef("repair", request.response_ref, descriptor.metadata.contract_ref, String(request.repair_attempt_count ?? 0)),
      source_response_ref: request.response_ref,
      target_contract_ref: descriptor.metadata.contract_ref,
      repair_reason: freezeArray(reasons.length > 0 ? reasons : ["Structured response failed quarantine validation."]),
      original_contract_summary: contractSummary,
      safe_context_subset: safeContextSubset,
      forbidden_content_reminder: "Use only prompt-provided sensor evidence, memory as fallible prior belief, validator feedback, task text, safety notes, and prompt-safe body context. Never use hidden simulator truth, backend coordinates, object IDs, direct actuator commands, or hidden chain-of-thought.",
      repair_budget_remaining: Math.max(0, 1 - (request.repair_attempt_count ?? 0)),
      output_only_instruction: outputOnlyInstruction,
      estimated_tokens: estimateTextTokens(`${contractSummary}\n${safeContextSubset}\n${outputOnlyInstruction}`),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Converts a released structured response into the validator handoff contract
   * consumed by orchestration, memory, verification, TTS, and deterministic
   * validators.
   */
  public extractValidatorHandoff(
    responseRef: Ref,
    payload: Record<string, unknown>,
    descriptor: StructuredOutputContractDescriptor,
  ): ValidatorHandoffPacket {
    const primary = isRecord(payload.primary_result) ? payload.primary_result : {};
    const target = descriptor.metadata.action_bearing ? descriptor.metadata.downstream_target : descriptor.metadata.downstream_target;
    const safetyNotes = stringArray(payload.safety_notes);
    const uncertainties = Array.isArray(payload.uncertainties) ? freezeArray(payload.uncertainties) : freezeArray([]);
    const base = {
      schema_version: RESPONSE_QUARANTINE_SERVICE_SCHEMA_VERSION,
      handoff_ref: makeRef("handoff", responseRef, descriptor.metadata.contract_ref),
      source_response_ref: responseRef,
      target,
      action_intent: extractFirstDefined(primary, ["ordered_phases", "candidate_waypoints", "corrective_strategy", "tool_action_plan", "recommended_action", "action_summary"]),
      object_hypotheses: extractFirstDefined(primary, ["visible_object_hypotheses", "object_roles", "consensus_objects", "object_memory_candidates", "tool_candidates"]),
      spatial_targets: extractFirstDefined(primary, ["spatial_attention_points", "spatial_constraints", "target_relation", "candidate_waypoints", "spatial_memory_candidates"]),
      constraints: extractFirstDefined(primary, ["validation_checkpoints", "validator_handoff", "new_validation_requirements", "verification_plan", "target_constraint_summary"]),
      embodiment_requirements: extractFirstDefined(primary, ["embodiment_considerations", "preconditions", "tool_attachment_plan", "reach_limitation_summary"]),
      safety_notes: safetyNotes,
      confidence_and_uncertainty: Object.freeze({
        confidence: typeof payload.confidence === "string" ? payload.confidence : "unknown",
        uncertainties,
      }),
      required_validators: requiredValidatorsFor(descriptor),
      failure_recovery_hint: extractFirstDefined(primary, ["fallback_strategy", "reobserve_request", "needed_additional_evidence", "oops_loop_trigger_suggestion", "escalation_recommendation", "reject_tool_use_reason"]),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Applies an output firewall and action-boundary scan after schema parsing.
   * The scan is intentionally conservative because deterministic validators are
   * the first authority allowed to turn model proposals into execution.
   */
  public runSafetyScreen(
    responseRef: Ref,
    invocationClass: CognitiveInvocationClass,
    contractRef: StructuredOutputContractRef,
    payload: unknown,
    descriptor: StructuredOutputContractDescriptor | undefined,
  ): CognitiveSafetyScreenReport {
    const issues: ValidationIssue[] = [];
    const serialized = typeof payload === "string" ? payload : safeStringify(payload);
    const hiddenContentDetected = FORBIDDEN_OUTPUT_PATTERN.test(serialized);
    const directControlDetected = LOW_LEVEL_CONTROL_PATTERN.test(serialized);
    const unsafeActionDetected = UNSAFE_ACTION_PATTERN.test(serialized);
    const monologuePolicyViolation = contractRef === "MonologueResponse" && monologueViolatesPolicy(payload);
    const memoryTruthViolation = contractRef === "MemoryWriteCandidateResponse" && memoryOverstatesTruth(payload);
    if (hiddenContentDetected) {
      issues.push(issue("error", "ForbiddenOutputContent", "$", "Response contains simulator, backend, hidden-reasoning, or policy-forbidden terms.", "Reject execution-bound output and rebuild or repair only when safe."));
    }
    if (directControlDetected) {
      issues.push(issue("error", "DirectControlBoundaryViolation", "$", "Response attempts direct low-level control or controller bypass.", "Reject the response and request high-level validated proposals only."));
    }
    if (unsafeActionDetected) {
      issues.push(issue("error", "UnsafeActionProposal", "$", "Response proposes unsafe motion, safety bypass, or validation skipping.", "Route to safe-hold or require a safer replan."));
    }
    if (descriptor?.metadata.action_bearing === true && isRecord(payload) && payload.requires_validation !== true) {
      issues.push(issue("error", "ValidatorGateMissing", "$.requires_validation", "Action-bearing response does not require deterministic validation.", "Reject or repair with requires_validation=true."));
    }
    if (monologuePolicyViolation) {
      issues.push(issue("error", "MonologuePolicyViolation", "$.primary_result.speech_text", "Monologue is too long or contains hidden, unsafe, or non-public content.", "Regenerate a concise public rationale or remain silent."));
    }
    if (memoryTruthViolation) {
      issues.push(issue("error", "MemoryTruthViolation", "$.primary_result", "Memory write candidate frames fallible memory as guaranteed truth.", "Downgrade to confidence-labeled prior belief or wait for verification."));
    }
    const decision = chooseSafetyDecision(issues, descriptor?.metadata.action_bearing === true, invocationClass);
    const base = {
      schema_version: RESPONSE_QUARANTINE_SERVICE_SCHEMA_VERSION,
      response_ref: responseRef,
      decision,
      hidden_content_detected: hiddenContentDetected,
      direct_control_detected: directControlDetected,
      unsafe_action_detected: unsafeActionDetected,
      monologue_policy_violation: monologuePolicyViolation,
      memory_truth_violation: memoryTruthViolation,
      issues: freezeArray(issues),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }
}

function parseStructuredResponse(rawText: string): ParsedStructuredResponse {
  const issues: ValidationIssue[] = [];
  if (rawText.trim().length === 0) {
    issues.push(issue("error", "MalformedResponse", "$.raw_response_text", "Raw response is empty.", "Request repair only if retry budget remains; otherwise reject."));
    return makeParseReport("rejected", undefined, undefined, issues);
  }
  const candidates = uniqueStrings([
    rawText.trim(),
    extractFencedJson(rawText),
    extractBalancedJsonObject(rawText),
  ].filter((item): item is string => item !== undefined && item.trim().length > 0));
  for (const candidate of candidates) {
    const parsed = parseJson(candidate);
    if (parsed.ok) {
      const status: CognitiveParseStatus = candidate === rawText.trim() ? "parsed" : "repaired";
      return makeParseReport(status, parsed.value, candidate, issues);
    }
  }
  issues.push(issue("error", "StructuredParseFailed", "$.raw_response_text", "Could not parse model response as a structured JSON object.", "Build a repair prompt with the original schema or reject after retry budget."));
  return makeParseReport("ambiguous", undefined, candidates[0], issues);
}

function makeParseReport(
  parseStatus: CognitiveParseStatus,
  parsedPayload: unknown,
  extractedJsonText: string | undefined,
  issues: readonly ValidationIssue[],
): ParsedStructuredResponse {
  const base = {
    parse_status: parseStatus,
    parsed_payload: parsedPayload,
    extracted_json_text: extractedJsonText,
    issues: freezeArray(issues),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function chooseQuarantineDecision(
  parseReport: ParsedStructuredResponse,
  contractReport: StructuredResponseValidationReport,
  safetyReport: CognitiveSafetyScreenReport,
  invocationClass: CognitiveInvocationClass,
): QuarantineDecision {
  if (safetyReport.decision === "safe_hold_required") {
    return "safe_hold_triggered";
  }
  if (safetyReport.decision === "rejected") {
    return actionBearingInvocation(invocationClass) ? "safe_hold_triggered" : "rejected";
  }
  if (parseReport.parse_status === "rejected") {
    return "rejected";
  }
  if (contractReport.decision === "released") {
    return "released";
  }
  if (contractReport.decision === "repairable" || parseReport.parse_status === "ambiguous") {
    return "repair_needed";
  }
  if (contractReport.decision === "escalation_required") {
    return actionBearingInvocation(invocationClass) ? "safe_hold_triggered" : "escalation_required";
  }
  return actionBearingInvocation(invocationClass) ? "safe_hold_triggered" : "rejected";
}

function determineRepairEligibility(
  decision: QuarantineDecision,
  parseReport: ParsedStructuredResponse,
  contractReport: StructuredResponseValidationReport,
  safetyReport: CognitiveSafetyScreenReport,
  repairAttemptCount: number,
  descriptor: StructuredOutputContractDescriptor | undefined,
): RepairEligibility {
  if (repairAttemptCount >= 1) {
    return "budget_exhausted";
  }
  if (descriptor === undefined || descriptor.metadata.repair_allowed !== true) {
    return "ineligible";
  }
  if (safetyReport.hidden_content_detected || safetyReport.direct_control_detected || safetyReport.unsafe_action_detected) {
    return "ineligible";
  }
  if (decision === "repair_needed" || contractReport.repairable || parseReport.parse_status === "ambiguous") {
    return "eligible";
  }
  return "ineligible";
}

function buildCognitiveResponseEnvelope(
  request: RawModelResponseQuarantineRequest,
  parseReport: ParsedStructuredResponse,
  issues: readonly ValidationIssue[],
  telemetryEvents: readonly CognitiveTelemetryEvent[],
  decision: QuarantineDecision,
  generationStartedMs: number,
  generationCompletedMs: number,
  validationStartedMs: number,
  validationCompletedMs: number,
): CognitiveResponseEnvelope {
  const payload = parseReport.parsed_payload;
  const base = {
    schema_version: GEMINI_ROBOTICS_ER_ADAPTER_SCHEMA_VERSION,
    request_ref: request.request_envelope.request_ref,
    model_identifier: request.model_identifier ?? request.request_envelope.model_identifier,
    raw_response_summary: redactSummary(request.raw_response_text),
    structured_parse_status: parseStatusForEnvelope(parseReport, decision),
    contract_ref: request.expected_contract_ref,
    semantic_validation_status: semanticStatus(issues),
    confidence_report: extractConfidenceReport(payload, issues),
    proposed_actions: extractProposedActions(payload),
    monologue_candidate: extractMonologueCandidate(payload),
    memory_write_candidates: extractMemoryWriteCandidates(payload),
    latency_report: Object.freeze({
      queue_ms: Math.max(0, generationStartedMs - (request.queue_started_at_ms ?? generationStartedMs)),
      generation_ms: Math.max(0, generationCompletedMs - generationStartedMs),
      validation_ms: Math.max(0, validationCompletedMs - validationStartedMs),
      repair_ms: 0,
      total_ms: Math.max(0, validationCompletedMs - (request.queue_started_at_ms ?? generationStartedMs)),
    }),
    quarantine_release: releaseDecisionForEnvelope(decision),
    parsed_payload: payload,
    issues: freezeArray(issues),
    telemetry_events: freezeArray(telemetryEvents),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function parseStatusForEnvelope(parseReport: ParsedStructuredResponse, decision: QuarantineDecision): CognitiveParseStatus {
  if (decision === "rejected" || decision === "safe_hold_triggered" || decision === "escalation_required") {
    return parseReport.parse_status === "parsed" || parseReport.parse_status === "repaired" ? parseReport.parse_status : "rejected";
  }
  return parseReport.parse_status;
}

function releaseDecisionForEnvelope(decision: QuarantineDecision): QuarantineReleaseDecision {
  if (decision === "released") {
    return "released";
  }
  if (decision === "repair_needed") {
    return "repair_needed";
  }
  if (decision === "safe_hold_triggered" || decision === "escalation_required") {
    return "safe_hold_triggered";
  }
  return "rejected";
}

function semanticStatus(issues: readonly ValidationIssue[]): SemanticValidationStatus {
  if (issues.some((item) => item.severity === "error")) {
    return "failed";
  }
  if (issues.some((item) => item.severity === "warning")) {
    return "warning";
  }
  return "passed";
}

function extractConfidenceReport(payload: unknown, issues: readonly ValidationIssue[]): CognitiveConfidenceReport {
  if (isRecord(payload)) {
    const rawConfidence = payload.confidence;
    const uncertainties = Array.isArray(payload.uncertainties)
      ? payload.uncertainties.map((entry) => typeof entry === "string" ? entry : safeStringify(entry)).filter((entry) => entry.trim().length > 0)
      : [];
    return Object.freeze({
      confidence: mapConfidence(rawConfidence, issues),
      ambiguity_notes: freezeArray(uncertainties.map(redactSummary)),
      requested_reobservation: isNonEmpty(payload.reobserve_request),
    });
  }
  return Object.freeze({
    confidence: issues.some((item) => item.severity === "error") ? "low" : "unknown",
    ambiguity_notes: freezeArray([]),
    requested_reobservation: false,
  });
}

function mapConfidence(value: unknown, issues: readonly ValidationIssue[]): CognitiveConfidenceReport["confidence"] {
  if (value === "very_high" || value === "high") {
    return "high";
  }
  if (value === "medium") {
    return "medium";
  }
  if (value === "low" || value === "very_low") {
    return "low";
  }
  return issues.some((item) => item.severity === "error") ? "low" : "unknown";
}

function extractProposedActions(payload: unknown): readonly string[] | undefined {
  if (!isRecord(payload) || !isRecord(payload.primary_result)) {
    return undefined;
  }
  const primary = payload.primary_result;
  const actionValues = [
    primary.ordered_phases,
    primary.candidate_waypoints,
    primary.corrective_strategy,
    primary.tool_action_plan,
    primary.recommended_action,
    primary.validation_checkpoints,
  ];
  const flattened = actionValues.flatMap(flattenActionValue).map(redactSummary).filter((item) => item.length > 0);
  return flattened.length > 0 ? freezeArray(flattened) : undefined;
}

function extractMonologueCandidate(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload.primary_result)) {
    return undefined;
  }
  const speech = payload.primary_result.speech_text;
  return typeof speech === "string" ? redactSummary(speech) : undefined;
}

function extractMemoryWriteCandidates(payload: unknown): readonly string[] | undefined {
  if (!isRecord(payload) || !isRecord(payload.primary_result)) {
    return undefined;
  }
  const primary = payload.primary_result;
  const candidates = [primary.episode_summary, primary.object_memory_candidates, primary.spatial_memory_candidates]
    .flatMap(flattenActionValue)
    .map(redactSummary)
    .filter((item) => item.length > 0);
  return candidates.length > 0 ? freezeArray(candidates) : undefined;
}

function summarizeContract(descriptor: StructuredOutputContractDescriptor): string {
  const envelopeFields = descriptor.common_envelope_fields
    .filter((field) => field.requirement === "required")
    .map((field) => field.field_name)
    .join(", ");
  const primaryFields = descriptor.primary_result_fields
    .filter((field) => field.requirement !== "optional")
    .map((field) => `${field.field_name}:${field.requirement}`)
    .join(", ");
  return truncateText(`Contract ${descriptor.metadata.contract_ref} v${descriptor.metadata.contract_version}. Required envelope fields: ${envelopeFields}. Primary result fields: ${primaryFields}. Action-bearing=${descriptor.metadata.action_bearing}; downstream=${descriptor.metadata.downstream_target}.`, MAX_REPAIR_PROMPT_TOKENS * 4);
}

function summarizeSafeContext(envelope: CognitiveRequestEnvelope): string {
  const sectionSummaries = [
    ...(envelope.observation_sections ?? []),
    ...(envelope.memory_context ?? []),
    ...(envelope.validator_context ?? []),
  ]
    .filter((section) => section.required === true || section.priority >= 80)
    .slice(0, 8)
    .map((section) => `[${section.provenance}:${section.title}] ${redactSummary(section.content).slice(0, 280)}`);
  const safety = envelope.safety_annotations.slice(0, 4).map((item) => `Safety: ${redactSummary(item).slice(0, 220)}`);
  return truncateText([
    `request_ref=${envelope.request_ref}`,
    `invocation_class=${envelope.invocation_class}`,
    `task=${redactSummary(envelope.task_instruction ?? "none").slice(0, 280)}`,
    `output_contract_ref=${envelope.output_contract_ref}`,
    ...sectionSummaries,
    ...safety,
  ].join("\n"), MAX_REPAIR_PROMPT_TOKENS * 4);
}

function requiredValidatorsFor(descriptor: StructuredOutputContractDescriptor): readonly string[] {
  switch (descriptor.metadata.contract_ref) {
    case "SceneUnderstandingResponse":
      return freezeArray(["provenance_checker", "view_evidence_checker", "uncertainty_completeness_checker"]);
    case "TaskPlanResponse":
      return freezeArray(["safety_validator", "no_rl_boundary_checker", "embodiment_compatibility_validator", "phase_completeness_validator"]);
    case "WaypointPlanResponse":
      return freezeArray(["geometry_validator", "reach_validator", "ik_validator", "collision_validator", "stability_validator", "controller_feasibility_validator"]);
    case "MultiViewConsensusResponse":
      return freezeArray(["view_synchronization_validator", "cross_view_evidence_checker", "ambiguity_handler"]);
    case "VisualVerificationResponse":
      return freezeArray(["spatial_residual_validator", "multi_view_confidence_checker", "false_positive_prevention_gate"]);
    case "CorrectionPlanResponse":
      return freezeArray(["retry_budget_validator", "safety_validator", "embodiment_feasibility_validator", "changed_strategy_validator"]);
    case "ToolUsePlanResponse":
      return freezeArray(["tool_visibility_validator", "affordance_validator", "attachment_validator", "swept_volume_validator", "collision_validator", "release_validator"]);
    case "AudioActionResponse":
      return freezeArray(["audio_confidence_validator", "visual_reconciliation_checker", "safety_validator"]);
    case "MemoryWriteCandidateResponse":
      return freezeArray(["memory_provenance_validator", "staleness_validator", "contradiction_validator", "privacy_validator", "verification_certificate_gate"]);
    case "MonologueResponse":
      return freezeArray(["hidden_truth_filter", "tts_length_filter", "safety_consistency_filter", "action_match_filter"]);
  }
}

function monologueViolatesPolicy(payload: unknown): boolean {
  if (!isRecord(payload) || !isRecord(payload.primary_result)) {
    return false;
  }
  const speechText = payload.primary_result.speech_text;
  if (typeof speechText !== "string") {
    return false;
  }
  return speechText.length > TTS_MAX_SPEECH_CHARS || FORBIDDEN_OUTPUT_PATTERN.test(speechText) || UNSAFE_ACTION_PATTERN.test(speechText);
}

function memoryOverstatesTruth(payload: unknown): boolean {
  if (!isRecord(payload) || !isRecord(payload.primary_result)) {
    return false;
  }
  const primaryText = safeStringify(payload.primary_result);
  return /\b(guaranteed|certain|ground truth|true position|exact location|permanent fact|known forever)\b/i.test(primaryText);
}

function chooseSafetyDecision(
  issues: readonly ValidationIssue[],
  actionBearing: boolean,
  invocationClass: CognitiveInvocationClass,
): SafetyScreenDecision {
  if (issues.some((item) => item.severity === "error")) {
    return actionBearing || actionBearingInvocation(invocationClass) ? "safe_hold_required" : "rejected";
  }
  if (issues.some((item) => item.severity === "warning")) {
    return "warning";
  }
  return "passed";
}

function actionBearingInvocation(invocationClass: CognitiveInvocationClass): boolean {
  return invocationClass === "TaskPlanningReasoning"
    || invocationClass === "WaypointGenerationReasoning"
    || invocationClass === "OopsCorrectionReasoning"
    || invocationClass === "ToolUseReasoning"
    || invocationClass === "AudioEventReasoning";
}

function flattenActionValue(value: unknown): readonly string[] {
  if (value === undefined || value === null) {
    return freezeArray([]);
  }
  if (typeof value === "string") {
    return freezeArray([value]);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return freezeArray([String(value)]);
  }
  if (Array.isArray(value)) {
    return freezeArray(value.flatMap(flattenActionValue));
  }
  if (isRecord(value)) {
    return freezeArray([safeStringify(value)]);
  }
  return freezeArray([]);
}

function extractFirstDefined(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) {
      return record[key];
    }
  }
  return undefined;
}

function extractFencedJson(rawText: string): string | undefined {
  const match = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return match?.[1]?.trim();
}

function extractBalancedJsonObject(rawText: string): string | undefined {
  const start = rawText.indexOf("{");
  if (start < 0) {
    return undefined;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < rawText.length; index += 1) {
    const char = rawText[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return rawText.slice(start, index + 1).trim();
      }
    }
  }
  return undefined;
}

function parseJson(value: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value) === false) {
      seen.add(value);
      result.push(value);
    }
  }
  return freezeArray(result);
}

function redactSummary(value: string): string {
  return truncateText(value.replace(FORBIDDEN_OUTPUT_PATTERN, "redacted-detail").replace(/\s+/g, " ").trim(), RAW_RESPONSE_SUMMARY_LIMIT);
}

function truncateText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmpty(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isRecord(value)) {
    return Object.keys(value).length > 0;
  }
  return value !== undefined && value !== null;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return freezeArray([]);
  }
  return freezeArray(value.filter((item): item is string => typeof item === "string").map(redactSummary));
}

function estimateTextTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
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

function makeTelemetry(
  eventType: CognitiveTelemetryEventType,
  requestRef: Ref | undefined,
  modelIdentifier: string | undefined,
  contractRef: Ref | undefined,
  severity: CognitiveTelemetryEvent["severity"],
  summary: string,
  timestampMs: number,
): CognitiveTelemetryEvent {
  const base = {
    event_ref: `quarantine_evt_${computeDeterminismHash({ eventType, requestRef, modelIdentifier, contractRef, severity, summary, timestampMs }).slice(0, 12)}`,
    event_type: eventType,
    request_ref: requestRef,
    model_identifier: modelIdentifier,
    contract_ref: contractRef,
    severity,
    summary,
    timestamp_ms: timestampMs,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function issue(severity: ValidationSeverity, code: string, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

if (GEMINI_ROBOTICS_ER_APPROVED_MODEL !== "gemini-robotics-er-1.6-preview") {
  throw new Error("Response quarantine service is pinned to the approved Gemini Robotics-ER profile.");
}

export const RESPONSE_QUARANTINE_SERVICE_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: RESPONSE_QUARANTINE_SERVICE_SCHEMA_VERSION,
  blueprint: "architecture_docs/06_GEMINI_ROBOTICS_ER_COGNITIVE_LAYER.md",
  companion_blueprint: "architecture_docs/07_PROMPT_CONTRACTS_AND_STRUCTURED_OUTPUTS.md",
  sections: freezeArray(["6.6.1", "6.7.1", "6.11", "6.12.1", "6.13.3", "6.18.1", "6.19", "6.20", "7.6", "7.7", "7.19", "7.20"]),
});
