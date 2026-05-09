/**
 * Structured response contract for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/07_PROMPT_CONTRACTS_AND_STRUCTURED_OUTPUTS.md`
 * sections 7.3, 7.4, 7.6, 7.7, 7.9 through 7.18, and 7.19.
 *
 * This module defines the executable common response envelope expected from
 * Gemini Robotics-ER prompt families. It validates contract identity, version
 * acknowledgement, evidence provenance, confidence scale, uncertainty fields,
 * re-observation requirements, safety notes, validation boundaries, and
 * forbidden content before a model response can be released to validators,
 * memory writers, TTS filtering, or orchestration.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import { GEMINI_ROBOTICS_ER_APPROVED_MODEL } from "../cognitive/gemini_robotics_er_adapter";
import type { CognitiveInvocationClass, OutputContractDefinition } from "../cognitive/gemini_robotics_er_adapter";
import type { PromptProvenanceLabel } from "./cognitive_prompt_packet_contract";

export const STRUCTURED_RESPONSE_CONTRACT_SCHEMA_VERSION = "mebsuta.structured_response_contract.v1" as const;
export const STRUCTURED_RESPONSE_CONTRACT_VERSION = "1.0.0" as const;

const FORBIDDEN_RESPONSE_CONTENT_PATTERN = /(mujoco|babylon|backend|engine|scene_graph|world_truth|ground_truth|qa_|collision_mesh|segmentation truth|debug buffer|simulator|physics_body|rigid_body_handle|joint_handle|object_id|exact_com|world_pose|hidden pose|hidden state|system prompt|developer prompt|chain-of-thought|scratchpad|private deliberation|direct actuator|raw actuator|joint torque|joint current|set joint|apply force|apply impulse|physics step|reward policy|policy gradient|reinforcement learning|rl update|ignore validators|override safety|disable safe-hold)/i;
const UNSAFE_ACTION_PATTERN = /(move anyway|try anyway|skip validation|without validation|ignore collision|unsafe sweep|excessive force|blind correction|audio-only success|disable safe-hold|override validator|bypass safety)/i;
const EXACT_POSE_PATTERN = /\b(exact|precise|ground.?truth)\b.*\b(world|pose|coordinate|position|orientation)\b/i;

export type StructuredResponseContractRef =
  | "SceneUnderstandingResponse"
  | "TaskPlanResponse"
  | "WaypointPlanResponse"
  | "MultiViewConsensusResponse"
  | "VisualVerificationResponse"
  | "CorrectionPlanResponse"
  | "ToolUsePlanResponse"
  | "AudioActionResponse"
  | "MemoryWriteCandidateResponse"
  | "MonologueResponse";

export type StructuredConfidenceValue = "very_low" | "low" | "medium" | "high" | "very_high";
export type StructuredUncertaintyCategory =
  | "visibility_ambiguity"
  | "identity_ambiguity"
  | "pose_ambiguity"
  | "reach_ambiguity"
  | "audio_ambiguity"
  | "memory_conflict"
  | "safety_uncertainty";
export type StructuredEvidenceCategory = "sensor" | "memory" | "embodiment" | "validator" | "task" | "safety" | "schema" | "system" | "tool" | "plan" | "audio" | "uncertainty";
export type StructuredResponseFieldRequirement = "required" | "conditional" | "optional";
export type StructuredResponseValueKind = "string" | "boolean" | "number" | "array" | "object" | "enum";
export type StructuredResponseDecision = "released" | "repairable" | "rejected" | "escalation_required";
export type StructuredResponseRejectionAction = "repair_once" | "reject" | "safe_hold" | "human_review";

export interface StructuredResponseFieldRule {
  readonly field_name: string;
  readonly requirement: StructuredResponseFieldRequirement;
  readonly value_kind: StructuredResponseValueKind;
  readonly description: string;
  readonly validation_rule: string;
  readonly allowed_values?: readonly string[];
}

export interface StructuredResponseContractDescriptor {
  readonly schema_version: typeof STRUCTURED_RESPONSE_CONTRACT_SCHEMA_VERSION;
  readonly contract_ref: StructuredResponseContractRef;
  readonly contract_version: typeof STRUCTURED_RESPONSE_CONTRACT_VERSION;
  readonly invocation_class: CognitiveInvocationClass;
  readonly model_identifier: typeof GEMINI_ROBOTICS_ER_APPROVED_MODEL;
  readonly output_mime_type: "application/json";
  readonly action_bearing: boolean;
  readonly downstream_target: "validator_stack" | "verification_pipeline" | "memory_writer" | "tts_filter";
  readonly common_envelope_fields: readonly StructuredResponseFieldRule[];
  readonly primary_result_fields: readonly StructuredResponseFieldRule[];
  readonly required_uncertainty_categories: readonly StructuredUncertaintyCategory[];
  readonly allowed_evidence_categories: readonly StructuredEvidenceCategory[];
  readonly adapter_contract: OutputContractDefinition;
  readonly determinism_hash: string;
}

export interface StructuredEvidenceCitation {
  readonly evidence_ref: Ref;
  readonly category: StructuredEvidenceCategory;
  readonly provenance_label: PromptProvenanceLabel;
  readonly summary: string;
}

export interface StructuredUncertaintyEntry {
  readonly category: StructuredUncertaintyCategory;
  readonly description: string;
  readonly evidence_refs: readonly Ref[];
  readonly requires_reobserve: boolean;
}

export interface StructuredResponseEnvelope {
  readonly response_contract_id: StructuredResponseContractRef;
  readonly contract_version_ack: typeof STRUCTURED_RESPONSE_CONTRACT_VERSION | string;
  readonly task_state_ref: Ref;
  readonly evidence_used: readonly StructuredEvidenceCitation[];
  readonly primary_result: Readonly<Record<string, unknown>>;
  readonly confidence: {
    readonly value: StructuredConfidenceValue;
    readonly rationale: string;
  };
  readonly uncertainties: readonly StructuredUncertaintyEntry[];
  readonly requires_validation: boolean;
  readonly reobserve_request?: {
    readonly reason: string;
    readonly requested_evidence: readonly string[];
  };
  readonly safety_notes: readonly string[];
  readonly forbidden_content_absent: boolean;
}

export interface StructuredResponseValidationRequest {
  readonly response_ref: Ref;
  readonly invocation_class: CognitiveInvocationClass;
  readonly expected_contract_ref: StructuredResponseContractRef;
  readonly payload: unknown;
  readonly repair_attempt_count?: number;
}

export interface StructuredResponseValidationReport {
  readonly schema_version: typeof STRUCTURED_RESPONSE_CONTRACT_SCHEMA_VERSION;
  readonly response_ref: Ref;
  readonly expected_contract_ref: StructuredResponseContractRef;
  readonly decision: StructuredResponseDecision;
  readonly missing_required_fields: readonly string[];
  readonly conditional_fields_needed: readonly string[];
  readonly unsupported_fields: readonly string[];
  readonly confidence_value?: StructuredConfidenceValue;
  readonly reobserve_required: boolean;
  readonly safe_hold_required: boolean;
  readonly repairable: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

interface ContractSeed {
  readonly contract_ref: StructuredResponseContractRef;
  readonly invocation_class: CognitiveInvocationClass;
  readonly action_bearing: boolean;
  readonly downstream_target: StructuredResponseContractDescriptor["downstream_target"];
  readonly primary_result_fields: readonly StructuredResponseFieldRule[];
  readonly required_uncertainty_categories: readonly StructuredUncertaintyCategory[];
}

/**
 * Validates the common structured response envelope and each invocation-specific
 * primary result shape. This class is deterministic and side-effect free, so it
 * can be used by response quarantine, prompt regression, telemetry, and future
 * prompt-contract review tools.
 */
export class StructuredResponseContract {
  private readonly descriptorsByRef: Readonly<Record<StructuredResponseContractRef, StructuredResponseContractDescriptor>>;
  private readonly refsByInvocation: Readonly<Record<CognitiveInvocationClass, StructuredResponseContractRef>>;

  public constructor(seeds: readonly ContractSeed[] = DEFAULT_CONTRACT_SEEDS) {
    const descriptors = seeds.map((seed) => buildDescriptor(seed));
    this.descriptorsByRef = indexDescriptorsByRef(descriptors);
    this.refsByInvocation = indexRefsByInvocation(descriptors);
  }

  /**
   * Resolves the expected contract for an invocation class.
   */
  public resolveForInvocation(invocationClass: CognitiveInvocationClass): StructuredResponseContractDescriptor {
    return this.descriptorsByRef[this.refsByInvocation[invocationClass]];
  }

  /**
   * Returns adapter-ready JSON schema metadata for Gemini structured outputs.
   */
  public getAdapterOutputContract(contractRef: StructuredResponseContractRef): OutputContractDefinition {
    return this.descriptorsByRef[contractRef].adapter_contract;
  }

  /**
   * Returns all adapter contracts in deterministic contract-ref order.
   */
  public getAdapterOutputContracts(): readonly OutputContractDefinition[] {
    return freezeArray(Object.values(this.descriptorsByRef)
      .sort((a, b) => a.contract_ref.localeCompare(b.contract_ref))
      .map((descriptor) => descriptor.adapter_contract));
  }

  /**
   * Validates a parsed response payload against the common envelope and the
   * invocation-specific primary-result fields.
   */
  public validateStructuredResponse(request: StructuredResponseValidationRequest): StructuredResponseValidationReport {
    const issues: ValidationIssue[] = [];
    const missingRequiredFields: string[] = [];
    const conditionalFieldsNeeded: string[] = [];
    const unsupportedFields: string[] = [];
    validateRef(request.response_ref, "$.response_ref", issues);
    const descriptor = this.descriptorsByRef[request.expected_contract_ref];
    if (descriptor.invocation_class !== request.invocation_class) {
      issues.push(issue("error", "InvocationContractMismatch", "$.invocation_class", "Expected contract does not belong to this invocation class.", "Use the router-selected response contract for this invocation."));
    }
    if (!isRecord(request.payload)) {
      issues.push(issue("error", "ResponseEnvelopeNotObject", "$.payload", "Structured response must be a JSON object.", "Repair once with the common response envelope, then reject if malformed again."));
      return this.makeReport(request, descriptor, "repairable", missingRequiredFields, conditionalFieldsNeeded, unsupportedFields, undefined, true, descriptor.action_bearing, true, issues);
    }
    validateCommonEnvelope(request.payload, descriptor, missingRequiredFields, conditionalFieldsNeeded, unsupportedFields, issues);
    validateEvidenceUsed(request.payload.evidence_used, descriptor, issues);
    validatePrimaryResult(request.payload.primary_result, descriptor, missingRequiredFields, issues);
    validateConfidence(request.payload, descriptor, conditionalFieldsNeeded, issues);
    validateUncertainties(request.payload.uncertainties, descriptor, issues);
    validateValidationBoundary(request.payload, descriptor, issues);
    validateForbiddenContent(request.payload, issues);
    const confidenceValue = parseConfidenceValue(request.payload.confidence);
    const reobserveRequired = requiresReobserve(confidenceValue, request.payload.uncertainties);
    const safeHoldRequired = descriptor.action_bearing && issues.some((item) => item.severity === "error");
    const decision = chooseDecision(issues, descriptor, request.repair_attempt_count ?? 0, safeHoldRequired);
    const repairable = decision === "repairable";
    return this.makeReport(request, descriptor, decision, missingRequiredFields, conditionalFieldsNeeded, unsupportedFields, confidenceValue, reobserveRequired, safeHoldRequired, repairable, issues);
  }

  private makeReport(
    request: StructuredResponseValidationRequest,
    descriptor: StructuredResponseContractDescriptor,
    decision: StructuredResponseDecision,
    missingRequiredFields: readonly string[],
    conditionalFieldsNeeded: readonly string[],
    unsupportedFields: readonly string[],
    confidenceValue: StructuredConfidenceValue | undefined,
    reobserveRequired: boolean,
    safeHoldRequired: boolean,
    repairable: boolean,
    issues: readonly ValidationIssue[],
  ): StructuredResponseValidationReport {
    const base = {
      schema_version: STRUCTURED_RESPONSE_CONTRACT_SCHEMA_VERSION,
      response_ref: request.response_ref,
      expected_contract_ref: descriptor.contract_ref,
      decision,
      missing_required_fields: freezeArray(missingRequiredFields),
      conditional_fields_needed: freezeArray(conditionalFieldsNeeded),
      unsupported_fields: freezeArray(unsupportedFields),
      confidence_value: confidenceValue,
      reobserve_required: reobserveRequired,
      safe_hold_required: safeHoldRequired,
      repairable,
      issues: freezeArray(issues),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }
}

function validateCommonEnvelope(
  payload: Readonly<Record<string, unknown>>,
  descriptor: StructuredResponseContractDescriptor,
  missingRequiredFields: string[],
  conditionalFieldsNeeded: string[],
  unsupportedFields: string[],
  issues: ValidationIssue[],
): void {
  const allowedFields = new Set([...COMMON_ENVELOPE_FIELDS.map((field) => field.field_name), ...descriptor.primary_result_fields.map((field) => `primary_result.${field.field_name}`)]);
  for (const field of COMMON_ENVELOPE_FIELDS) {
    if (field.requirement === "required" && !(field.field_name in payload)) {
      missingRequiredFields.push(field.field_name);
      issues.push(issue("error", "RequiredEnvelopeFieldMissing", `$.${field.field_name}`, `Response envelope is missing ${field.field_name}.`, "Return the full common response envelope."));
    }
  }
  for (const key of Object.keys(payload)) {
    if (!COMMON_ENVELOPE_FIELD_NAMES.has(key)) {
      unsupportedFields.push(key);
      issues.push(issue("warning", "UnsupportedEnvelopeField", `$.${key}`, "Response contains an unsupported top-level field.", "Move contract-specific data under primary_result or remove the field."));
    }
  }
  if (payload.response_contract_id !== descriptor.contract_ref) {
    issues.push(issue("error", "ResponseContractIdMismatch", "$.response_contract_id", "Response contract ID does not match the requested contract.", `Use ${descriptor.contract_ref}.`));
  }
  if (payload.contract_version_ack !== STRUCTURED_RESPONSE_CONTRACT_VERSION) {
    issues.push(issue("warning", "ContractVersionAckMismatch", "$.contract_version_ack", "Response did not acknowledge the current contract version.", `Acknowledge ${STRUCTURED_RESPONSE_CONTRACT_VERSION}.`));
  }
  if (typeof payload.task_state_ref !== "string" || payload.task_state_ref.trim().length === 0 || FORBIDDEN_RESPONSE_CONTENT_PATTERN.test(payload.task_state_ref)) {
    issues.push(issue("error", "TaskStateRefInvalid", "$.task_state_ref", "Task state ref must be prompt-safe and non-empty.", "Use a non-secret orchestrator task reference."));
  }
  if (descriptor.action_bearing && payload.reobserve_request === undefined) {
    conditionalFieldsNeeded.push("reobserve_request when confidence is low or uncertainty remains");
  }
  void allowedFields;
}

function validateEvidenceUsed(value: unknown, descriptor: StructuredResponseContractDescriptor, issues: ValidationIssue[]): void {
  if (!Array.isArray(value)) {
    issues.push(issue("error", "EvidenceUsedInvalid", "$.evidence_used", "Evidence used must be an array.", "Cite the evidence refs and provenance labels used by the response."));
    return;
  }
  if (value.length === 0) {
    issues.push(issue("error", "EvidenceUsedEmpty", "$.evidence_used", "Response must cite at least one evidence item.", "Reference sensor, memory, embodiment, validator, task, safety, schema, or system evidence."));
  }
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      issues.push(issue("error", "EvidenceCitationInvalid", `$.evidence_used[${index}]`, "Evidence citation must be an object.", "Use the structured evidence citation shape."));
      continue;
    }
    if (!isEvidenceCategory(entry.category) || !descriptor.allowed_evidence_categories.includes(entry.category)) {
      issues.push(issue("error", "EvidenceCategoryRejected", `$.evidence_used[${index}].category`, "Evidence category is not allowed for this contract.", "Use one of the common evidence categories."));
    }
    if (!isPromptProvenanceLabel(entry.provenance_label)) {
      issues.push(issue("error", "EvidenceProvenanceRejected", `$.evidence_used[${index}].provenance_label`, "Evidence provenance label is not recognized.", "Use a common prompt provenance label."));
    }
    if (typeof entry.evidence_ref !== "string" || FORBIDDEN_RESPONSE_CONTENT_PATTERN.test(entry.evidence_ref)) {
      issues.push(issue("error", "EvidenceRefInvalid", `$.evidence_used[${index}].evidence_ref`, "Evidence ref is missing or contains restricted terminology.", "Use prompt-safe evidence refs only."));
    }
  }
}

function validatePrimaryResult(value: unknown, descriptor: StructuredResponseContractDescriptor, missingRequiredFields: string[], issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue("error", "PrimaryResultInvalid", "$.primary_result", "Primary result must be an object.", "Return contract-specific fields under primary_result."));
    return;
  }
  for (const field of descriptor.primary_result_fields) {
    const present = field.field_name in value && value[field.field_name] !== undefined && value[field.field_name] !== null;
    if (field.requirement === "required" && !present) {
      missingRequiredFields.push(`primary_result.${field.field_name}`);
      issues.push(issue("error", "PrimaryResultFieldMissing", `$.primary_result.${field.field_name}`, `Primary result is missing ${field.field_name}.`, "Repair the response with all required primary result fields."));
      continue;
    }
    if (present && !valueKindMatches(value[field.field_name], field.value_kind, field.allowed_values)) {
      issues.push(issue("error", "PrimaryResultFieldTypeInvalid", `$.primary_result.${field.field_name}`, `Primary result field ${field.field_name} has the wrong value kind.`, field.validation_rule));
    }
  }
}

function validateConfidence(
  payload: Readonly<Record<string, unknown>>,
  descriptor: StructuredResponseContractDescriptor,
  conditionalFieldsNeeded: string[],
  issues: ValidationIssue[],
): void {
  const confidenceValue = parseConfidenceValue(payload.confidence);
  if (confidenceValue === undefined) {
    issues.push(issue("error", "ConfidenceInvalid", "$.confidence.value", "Confidence must use the approved confidence scale.", "Use very_low, low, medium, high, or very_high."));
    return;
  }
  if (isRecord(payload.confidence) && (typeof payload.confidence.rationale !== "string" || payload.confidence.rationale.trim().length === 0)) {
    issues.push(issue("error", "ConfidenceRationaleMissing", "$.confidence.rationale", "Confidence requires a concise rationale.", "Explain the evidence basis without private reasoning."));
  }
  if ((confidenceValue === "very_low" || confidenceValue === "low") && payload.reobserve_request === undefined) {
    conditionalFieldsNeeded.push("reobserve_request");
    issues.push(issue("error", "LowConfidenceNeedsReobserve", "$.reobserve_request", "Low confidence requires a re-observation request.", "Ask for additional evidence instead of proceeding."));
  }
  if (descriptor.action_bearing && confidenceValue === "very_high" && Array.isArray(payload.uncertainties) && payload.uncertainties.length > 0) {
    issues.push(issue("warning", "VeryHighConfidenceWithUncertainty", "$.confidence.value", "Very high confidence conflicts with non-empty uncertainty entries.", "Downgrade confidence or explain why uncertainties are non-blocking."));
  }
}

function validateUncertainties(value: unknown, descriptor: StructuredResponseContractDescriptor, issues: ValidationIssue[]): void {
  if (!Array.isArray(value)) {
    issues.push(issue("error", "UncertaintiesInvalid", "$.uncertainties", "Uncertainties must be an array.", "Return uncertainty entries, or an empty array only when evidence is strong."));
    return;
  }
  const categories = new Set<StructuredUncertaintyCategory>();
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      issues.push(issue("error", "UncertaintyEntryInvalid", `$.uncertainties[${index}]`, "Uncertainty entry must be an object.", "Use the structured uncertainty entry shape."));
      continue;
    }
    if (!isUncertaintyCategory(entry.category)) {
      issues.push(issue("error", "UncertaintyCategoryInvalid", `$.uncertainties[${index}].category`, "Uncertainty category is not recognized.", "Use the required uncertainty category taxonomy."));
    } else {
      categories.add(entry.category);
    }
    if (typeof entry.description !== "string" || entry.description.trim().length === 0) {
      issues.push(issue("error", "UncertaintyDescriptionMissing", `$.uncertainties[${index}].description`, "Uncertainty entry needs a description.", "Describe the ambiguity or missing evidence."));
    }
    if (typeof entry.requires_reobserve !== "boolean") {
      issues.push(issue("error", "UncertaintyReobserveFlagMissing", `$.uncertainties[${index}].requires_reobserve`, "Uncertainty entry needs a re-observation flag.", "State whether more evidence is required."));
    }
  }
  if (descriptor.action_bearing && descriptor.required_uncertainty_categories.some((category) => categories.has(category)) === false && value.length === 0) {
    issues.push(issue("warning", "ActionResponseHasNoUncertainty", "$.uncertainties", "Action-bearing responses should explicitly state relevant uncertainty or why none blocks validation.", "Add uncertainty entries or a clear high-confidence rationale."));
  }
}

function validateValidationBoundary(payload: Readonly<Record<string, unknown>>, descriptor: StructuredResponseContractDescriptor, issues: ValidationIssue[]): void {
  if (typeof payload.requires_validation !== "boolean") {
    issues.push(issue("error", "RequiresValidationMissing", "$.requires_validation", "Response must state whether deterministic validation is required.", "Set requires_validation explicitly."));
    return;
  }
  if (descriptor.action_bearing && payload.requires_validation !== true) {
    issues.push(issue("error", "ActionResponseWithoutValidation", "$.requires_validation", "Action-bearing responses must require deterministic validation before execution.", "Set requires_validation to true."));
  }
  if (!Array.isArray(payload.safety_notes) || payload.safety_notes.length === 0) {
    issues.push(issue("error", "SafetyNotesMissing", "$.safety_notes", "Response must include safety notes.", "State safety constraints and validator needs."));
  }
  if (payload.forbidden_content_absent !== true) {
    issues.push(issue("error", "ForbiddenContentAssertionMissing", "$.forbidden_content_absent", "Response must assert absence of forbidden content, then independent scanners verify it.", "Set forbidden_content_absent to true only when compliant."));
  }
}

function validateForbiddenContent(payload: unknown, issues: ValidationIssue[]): void {
  const serialized = safeStringify(payload);
  if (FORBIDDEN_RESPONSE_CONTENT_PATTERN.test(serialized)) {
    issues.push(issue("error", "ForbiddenResponseContent", "$.payload", "Response contains simulator, hidden-truth, private reasoning, low-level control, or no-RL-forbidden content.", "Reject or repair with prompt-safe evidence-grounded language."));
  }
  if (UNSAFE_ACTION_PATTERN.test(serialized)) {
    issues.push(issue("error", "UnsafeActionLanguage", "$.payload", "Response contains unsafe action or safety-bypass language.", "Reject and route through safety validation or safe-hold."));
  }
  if (EXACT_POSE_PATTERN.test(serialized)) {
    issues.push(issue("warning", "OverPrecisePoseClaim", "$.payload", "Response appears to claim exact pose or coordinate precision.", "Downgrade to evidence-labeled estimates and uncertainty."));
  }
}

function chooseDecision(
  issues: readonly ValidationIssue[],
  descriptor: StructuredResponseContractDescriptor,
  repairAttemptCount: number,
  safeHoldRequired: boolean,
): StructuredResponseDecision {
  if (issues.some((item) => item.severity === "error")) {
    if (safeHoldRequired) {
      return "escalation_required";
    }
    return repairAttemptCount < 1 ? "repairable" : descriptor.action_bearing ? "escalation_required" : "rejected";
  }
  if (issues.some((item) => item.severity === "warning")) {
    return "repairable";
  }
  return "released";
}

function requiresReobserve(confidenceValue: StructuredConfidenceValue | undefined, uncertainties: unknown): boolean {
  if (confidenceValue === undefined || confidenceValue === "very_low" || confidenceValue === "low") {
    return true;
  }
  return Array.isArray(uncertainties) && uncertainties.some((entry) => isRecord(entry) && entry.requires_reobserve === true);
}

function parseConfidenceValue(value: unknown): StructuredConfidenceValue | undefined {
  if (!isRecord(value) || typeof value.value !== "string") {
    return undefined;
  }
  return isConfidenceValue(value.value) ? value.value : undefined;
}

function valueKindMatches(value: unknown, kind: StructuredResponseValueKind, allowedValues: readonly string[] | undefined): boolean {
  if (kind === "string") {
    return typeof value === "string";
  }
  if (kind === "boolean") {
    return typeof value === "boolean";
  }
  if (kind === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (kind === "array") {
    return Array.isArray(value);
  }
  if (kind === "object") {
    return isRecord(value);
  }
  if (kind === "enum") {
    return typeof value === "string" && (allowedValues ?? []).includes(value);
  }
  return false;
}

function buildDescriptor(seed: ContractSeed): StructuredResponseContractDescriptor {
  const common = COMMON_ENVELOPE_FIELDS;
  const adapterContract = buildAdapterContract(seed, common);
  const base = {
    schema_version: STRUCTURED_RESPONSE_CONTRACT_SCHEMA_VERSION,
    contract_ref: seed.contract_ref,
    contract_version: STRUCTURED_RESPONSE_CONTRACT_VERSION,
    invocation_class: seed.invocation_class,
    model_identifier: GEMINI_ROBOTICS_ER_APPROVED_MODEL,
    output_mime_type: "application/json" as const,
    action_bearing: seed.action_bearing,
    downstream_target: seed.downstream_target,
    common_envelope_fields: common,
    primary_result_fields: freezeArray(seed.primary_result_fields),
    required_uncertainty_categories: freezeArray(seed.required_uncertainty_categories),
    allowed_evidence_categories: ALL_EVIDENCE_CATEGORIES,
    adapter_contract: adapterContract,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function buildAdapterContract(seed: ContractSeed, commonFields: readonly StructuredResponseFieldRule[]): OutputContractDefinition {
  const primaryProperties = Object.fromEntries(seed.primary_result_fields.map((field) => [field.field_name, jsonSchemaForField(field)]));
  const schema = Object.freeze({
    type: "object",
    additionalProperties: false,
    properties: Object.freeze({
      response_contract_id: Object.freeze({ type: "string", enum: freezeArray([seed.contract_ref]) }),
      contract_version_ack: Object.freeze({ type: "string" }),
      task_state_ref: Object.freeze({ type: "string" }),
      evidence_used: Object.freeze({ type: "array", items: Object.freeze({ type: "object" }) }),
      primary_result: Object.freeze({
        type: "object",
        properties: Object.freeze(primaryProperties),
        required: freezeArray(seed.primary_result_fields.filter((field) => field.requirement === "required").map((field) => field.field_name)),
      }),
      confidence: Object.freeze({
        type: "object",
        properties: Object.freeze({
          value: Object.freeze({ type: "string", enum: ALL_CONFIDENCE_VALUES }),
          rationale: Object.freeze({ type: "string" }),
        }),
        required: freezeArray(["value", "rationale"]),
      }),
      uncertainties: Object.freeze({ type: "array", items: Object.freeze({ type: "object" }) }),
      requires_validation: Object.freeze({ type: "boolean" }),
      reobserve_request: Object.freeze({ type: "object" }),
      safety_notes: Object.freeze({ type: "array", items: Object.freeze({ type: "string" }) }),
      forbidden_content_absent: Object.freeze({ type: "boolean" }),
    }),
    required: freezeArray(commonFields.filter((field) => field.requirement === "required").map((field) => field.field_name)),
  });
  return Object.freeze({
    contract_ref: seed.contract_ref,
    required_fields: freezeArray(commonFields.filter((field) => field.requirement === "required").map((field) => field.field_name)),
    allowed_action_fields: seed.action_bearing ? freezeArray(["primary_result", "safety_notes", "requires_validation"]) : freezeArray(["primary_result"]),
    response_mime_type: "application/json",
    json_schema: schema,
  });
}

function jsonSchemaForField(field: StructuredResponseFieldRule): Readonly<Record<string, unknown>> {
  if (field.value_kind === "enum") {
    return Object.freeze({ type: "string", enum: freezeArray(field.allowed_values ?? []) });
  }
  if (field.value_kind === "array") {
    return Object.freeze({ type: "array" });
  }
  if (field.value_kind === "object") {
    return Object.freeze({ type: "object" });
  }
  if (field.value_kind === "number") {
    return Object.freeze({ type: "number" });
  }
  if (field.value_kind === "boolean") {
    return Object.freeze({ type: "boolean" });
  }
  return Object.freeze({ type: "string" });
}

function indexDescriptorsByRef(descriptors: readonly StructuredResponseContractDescriptor[]): Readonly<Record<StructuredResponseContractRef, StructuredResponseContractDescriptor>> {
  const map = new Map<StructuredResponseContractRef, StructuredResponseContractDescriptor>();
  for (const descriptor of descriptors) {
    map.set(descriptor.contract_ref, descriptor);
  }
  const missing = ALL_CONTRACT_REFS.filter((contractRef) => map.has(contractRef) === false);
  if (missing.length > 0) {
    throw new Error(`StructuredResponseContract missing contract refs: ${missing.join(", ")}`);
  }
  return Object.freeze(Object.fromEntries(ALL_CONTRACT_REFS.map((contractRef) => [contractRef, map.get(contractRef) as StructuredResponseContractDescriptor])) as Record<StructuredResponseContractRef, StructuredResponseContractDescriptor>);
}

function indexRefsByInvocation(descriptors: readonly StructuredResponseContractDescriptor[]): Readonly<Record<CognitiveInvocationClass, StructuredResponseContractRef>> {
  const map = new Map<CognitiveInvocationClass, StructuredResponseContractRef>();
  for (const descriptor of descriptors) {
    map.set(descriptor.invocation_class, descriptor.contract_ref);
  }
  const missing = ALL_INVOCATION_CLASSES.filter((invocationClass) => map.has(invocationClass) === false);
  if (missing.length > 0) {
    throw new Error(`StructuredResponseContract missing invocation mappings: ${missing.join(", ")}`);
  }
  return Object.freeze(Object.fromEntries(ALL_INVOCATION_CLASSES.map((invocationClass) => [invocationClass, map.get(invocationClass) as StructuredResponseContractRef])) as Record<CognitiveInvocationClass, StructuredResponseContractRef>);
}

function makeField(fieldName: string, requirement: StructuredResponseFieldRequirement, valueKind: StructuredResponseValueKind, description: string, validationRule: string, allowedValues?: readonly string[]): StructuredResponseFieldRule {
  return Object.freeze({
    field_name: fieldName,
    requirement,
    value_kind: valueKind,
    description,
    validation_rule: validationRule,
    allowed_values: allowedValues === undefined ? undefined : freezeArray(allowedValues),
  });
}

function makeSeed(
  contractRef: StructuredResponseContractRef,
  invocationClass: CognitiveInvocationClass,
  actionBearing: boolean,
  downstreamTarget: StructuredResponseContractDescriptor["downstream_target"],
  primaryFields: readonly StructuredResponseFieldRule[],
  uncertainties: readonly StructuredUncertaintyCategory[],
): ContractSeed {
  return Object.freeze({
    contract_ref: contractRef,
    invocation_class: invocationClass,
    action_bearing: actionBearing,
    downstream_target: downstreamTarget,
    primary_result_fields: freezeArray(primaryFields),
    required_uncertainty_categories: freezeArray(uncertainties),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isConfidenceValue(value: string): value is StructuredConfidenceValue {
  return ALL_CONFIDENCE_VALUES.includes(value as StructuredConfidenceValue);
}

function isEvidenceCategory(value: unknown): value is StructuredEvidenceCategory {
  return typeof value === "string" && ALL_EVIDENCE_CATEGORIES.includes(value as StructuredEvidenceCategory);
}

function isUncertaintyCategory(value: unknown): value is StructuredUncertaintyCategory {
  return typeof value === "string" && ALL_UNCERTAINTY_CATEGORIES.includes(value as StructuredUncertaintyCategory);
}

function isPromptProvenanceLabel(value: unknown): value is PromptProvenanceLabel {
  return typeof value === "string" && ALL_PROMPT_PROVENANCE_LABELS.includes(value as PromptProvenanceLabel);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function validateRef(ref: Ref, path: string, issues: ValidationIssue[]): void {
  if (ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(issue("error", "ReferenceInvalid", path, "Reference must be non-empty and whitespace-free.", "Use a prompt-safe opaque reference."));
  }
  if (FORBIDDEN_RESPONSE_CONTENT_PATTERN.test(ref)) {
    issues.push(issue("error", "ReferenceContainsForbiddenContent", path, "Reference contains forbidden response-boundary terminology.", "Replace with an opaque prompt-safe reference."));
  }
}

function issue(severity: ValidationSeverity, code: string, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

const COMMON_ENVELOPE_FIELDS: readonly StructuredResponseFieldRule[] = freezeArray([
  makeField("response_contract_id", "required", "enum", "Contract family used by the response.", "Must match requested output contract.", []),
  makeField("contract_version_ack", "required", "string", "Response acknowledgement of expected contract version.", "Must match the current structured response version."),
  makeField("task_state_ref", "required", "string", "Non-secret orchestrator task reference.", "Must not encode simulator object identity."),
  makeField("evidence_used", "required", "array", "Evidence citations used by the response.", "Must cite allowed provenance labels."),
  makeField("primary_result", "required", "object", "Invocation-specific structured result.", "Must satisfy contract-specific fields."),
  makeField("confidence", "required", "object", "Confidence value and rationale.", "Must use the approved confidence scale."),
  makeField("uncertainties", "required", "array", "Ambiguities and missing evidence.", "Empty only when evidence is strong."),
  makeField("requires_validation", "required", "boolean", "Whether deterministic validation is required.", "Required true for action-bearing outputs."),
  makeField("reobserve_request", "conditional", "object", "Requested additional evidence.", "Required when confidence is low or evidence is incomplete."),
  makeField("safety_notes", "required", "array", "Safety constraints and validator needs.", "Must not override deterministic safety."),
  makeField("forbidden_content_absent", "required", "boolean", "Model assertion that forbidden content is absent.", "Must be true and independently verified."),
]);

const COMMON_ENVELOPE_FIELD_NAMES = new Set(COMMON_ENVELOPE_FIELDS.map((field) => field.field_name));

const ALL_CONFIDENCE_VALUES: readonly StructuredConfidenceValue[] = freezeArray(["very_low", "low", "medium", "high", "very_high"]);
const ALL_UNCERTAINTY_CATEGORIES: readonly StructuredUncertaintyCategory[] = freezeArray(["visibility_ambiguity", "identity_ambiguity", "pose_ambiguity", "reach_ambiguity", "audio_ambiguity", "memory_conflict", "safety_uncertainty"]);
const ALL_EVIDENCE_CATEGORIES: readonly StructuredEvidenceCategory[] = freezeArray(["sensor", "memory", "embodiment", "validator", "task", "safety", "schema", "system", "tool", "plan", "audio", "uncertainty"]);
const ALL_PROMPT_PROVENANCE_LABELS: readonly PromptProvenanceLabel[] = freezeArray(["sensor_visual_current", "sensor_audio_current", "sensor_contact_current", "proprioceptive_current", "memory_prior", "validator_feedback", "embodiment_self_knowledge", "human_instruction", "inference_from_evidence", "safety_policy", "schema_instruction", "system_contract", "telemetry_label"]);

const ALL_CONTRACT_REFS: readonly StructuredResponseContractRef[] = freezeArray(["SceneUnderstandingResponse", "TaskPlanResponse", "WaypointPlanResponse", "MultiViewConsensusResponse", "VisualVerificationResponse", "CorrectionPlanResponse", "ToolUsePlanResponse", "AudioActionResponse", "MemoryWriteCandidateResponse", "MonologueResponse"]);
const ALL_INVOCATION_CLASSES: readonly CognitiveInvocationClass[] = freezeArray(["SceneObservationReasoning", "TaskPlanningReasoning", "WaypointGenerationReasoning", "MultiViewDisambiguationReasoning", "SpatialVerificationReasoning", "OopsCorrectionReasoning", "ToolUseReasoning", "AudioEventReasoning", "MemoryAssimilationReasoning", "InternalMonologueReasoning"]);

const DEFAULT_CONTRACT_SEEDS: readonly ContractSeed[] = freezeArray([
  makeSeed("SceneUnderstandingResponse", "SceneObservationReasoning", false, "verification_pipeline", [
    makeField("visible_object_hypotheses", "required", "array", "Visible object hypotheses with labels, evidence, confidence, and ambiguity.", "Must reference current sensor views."),
    makeField("object_relationships", "required", "array", "Relative object relationships.", "Must state whether each relation is visual or inferred."),
    makeField("affordance_hypotheses", "required", "array", "Object affordance hypotheses.", "Must include confidence and evidence."),
    makeField("occlusion_report", "required", "object", "Occlusion, crop, blur, or hidden-region report.", "Required even when no occlusion is apparent."),
    makeField("spatial_attention_points", "conditional", "array", "View-specific normalized regions.", "Must be view-specific and normalized if provided."),
    makeField("memory_alignment", "optional", "object", "Current observation alignment with memory.", "Must label conflicts."),
    makeField("safety_relevant_observations", "required", "array", "Visible safety-relevant observations.", "Must not claim final safety."),
  ], ["visibility_ambiguity", "identity_ambiguity", "pose_ambiguity"]),
  makeSeed("TaskPlanResponse", "TaskPlanningReasoning", true, "validator_stack", [
    makeField("task_interpretation", "required", "object", "Restated objective and constraints.", "Must not invent objects or hidden goals."),
    makeField("assumptions", "required", "array", "Bounded assumptions.", "Must remain safe and explicit."),
    makeField("ordered_phases", "required", "array", "Ordered embodied phases.", "Each phase needs preconditions and validation needs."),
    makeField("object_roles", "required", "array", "Target, support, distractor, obstacle, or tool roles.", "Roles must trace to evidence."),
    makeField("spatial_constraints", "conditional", "array", "Desired final relations and tolerances.", "Must be validator-ready."),
    makeField("embodiment_considerations", "required", "array", "Body limits and stance considerations.", "Must match prompt-safe embodiment context."),
    makeField("validation_checkpoints", "required", "array", "Validation checkpoints.", "Required before execution-bearing phases."),
    makeField("fallback_strategy", "required", "object", "Fallback or safe-hold strategy.", "Must respect retry budgets."),
    makeField("requires_waypoint_generation", "required", "boolean", "Whether waypoint generation is needed.", "True for physical motion beyond orienting or re-observation."),
  ], ["visibility_ambiguity", "identity_ambiguity", "reach_ambiguity", "safety_uncertainty"]),
  makeSeed("WaypointPlanResponse", "WaypointGenerationReasoning", true, "validator_stack", [
    makeField("waypoint_intent", "required", "string", "Waypoint intent vocabulary.", "Must use approved waypoint intent."),
    makeField("reference_evidence", "required", "array", "Evidence references.", "Must use allowed provenance."),
    makeField("target_relation", "required", "object", "Object-relative or body-relative target relation.", "Must not use hidden coordinates."),
    makeField("candidate_waypoints", "required", "array", "Candidate waypoint targets.", "Must include frame label and uncertainty."),
    makeField("tolerances", "conditional", "object", "Requested tolerances.", "Must fit task and verification."),
    makeField("preconditions", "required", "array", "Checkable preconditions.", "Must be finite."),
    makeField("postconditions", "required", "array", "Expected visible result.", "Must feed verification."),
    makeField("risk_notes", "required", "array", "Collision, occlusion, balance, slip, or reach risks.", "Safety validator consumes this."),
    makeField("validator_handoff", "required", "array", "Required validators.", "Required for physical motion."),
  ], ["pose_ambiguity", "reach_ambiguity", "safety_uncertainty"]),
  makeSeed("MultiViewConsensusResponse", "MultiViewDisambiguationReasoning", false, "verification_pipeline", [
    makeField("view_inventory", "required", "array", "Views considered and quality.", "Must match provided view names."),
    makeField("consensus_objects", "required", "array", "Objects supported by views.", "Must include evidence per object."),
    makeField("conflicting_hypotheses", "required", "array", "View conflicts.", "Empty only when explicitly no conflicts."),
    makeField("occlusion_explanation", "required", "array", "Occlusion explanation.", "Must distinguish occlusion from absence."),
    makeField("pose_confidence", "required", "object", "Pose confidence by object.", "Must include uncertainty category."),
    makeField("recommended_next_view", "conditional", "object", "Next view request.", "Required when consensus is insufficient."),
    makeField("planning_readiness", "required", "enum", "Planning readiness.", "Must align with confidence.", ["ready_for_planning", "ready_for_search_only", "verification_only", "not_ready"]),
  ], ["visibility_ambiguity", "identity_ambiguity", "pose_ambiguity"]),
  makeSeed("VisualVerificationResponse", "SpatialVerificationReasoning", false, "verification_pipeline", [
    makeField("target_constraint_summary", "required", "string", "Constraint being checked.", "Must match task and validator context."),
    makeField("visual_evidence_for_success", "required", "array", "View-specific support evidence.", "Must cite views."),
    makeField("visual_evidence_against_success", "required", "array", "Counterevidence or uncertainty.", "Required even if none found."),
    makeField("constraint_status", "required", "enum", "Visual constraint status.", "Cannot be satisfied under low confidence.", ["appears_satisfied", "appears_unsatisfied", "ambiguous", "cannot_assess"]),
    makeField("residual_hint", "conditional", "object", "Qualitative residual hint.", "Must be an estimate."),
    makeField("needed_additional_evidence", "conditional", "array", "Additional evidence needed.", "Required for ambiguity."),
    makeField("memory_update_readiness", "required", "boolean", "Memory write readiness.", "False until final certificate."),
    makeField("oops_loop_trigger_suggestion", "conditional", "object", "Correction trigger suggestion.", "Must be evidence-based."),
  ], ["visibility_ambiguity", "pose_ambiguity", "memory_conflict"]),
  makeSeed("CorrectionPlanResponse", "OopsCorrectionReasoning", true, "validator_stack", [
    makeField("failure_summary", "required", "string", "Failure summary.", "Must separate evidence from inference."),
    makeField("ranked_cause_hypotheses", "required", "array", "Physical cause hypotheses.", "Must include alternatives when uncertainty exists."),
    makeField("immediate_safety_action", "required", "string", "Immediate safety action.", "Must be safe and finite."),
    makeField("corrective_strategy", "required", "array", "Revised action sequence.", "Must be smaller or safer unless evidence supports otherwise."),
    makeField("changed_assumptions", "required", "array", "Changed assumptions.", "Must trace to evidence."),
    makeField("new_validation_requirements", "required", "array", "New validators before retry.", "Must include retry budget and safety checks."),
    makeField("escalation_recommendation", "conditional", "object", "Escalation recommendation.", "Required when retries are exhausted."),
  ], ["visibility_ambiguity", "pose_ambiguity", "reach_ambiguity", "safety_uncertainty"]),
  makeSeed("ToolUsePlanResponse", "ToolUseReasoning", true, "validator_stack", [
    makeField("reach_limitation_summary", "required", "string", "Reach limitation summary.", "Must cite reach report or visible limitation."),
    makeField("tool_candidates", "required", "array", "Visible tool candidates.", "Must be sensor-derived."),
    makeField("selected_tool_rationale", "conditional", "object", "Selection rationale.", "Must include safety and suitability."),
    makeField("tool_attachment_plan", "conditional", "object", "Tool attachment plan.", "Must be validator-ready."),
    makeField("tool_action_plan", "conditional", "object", "Finite tool action plan.", "Must have stop criteria."),
    makeField("swept_volume_concerns", "required", "array", "Swept volume concerns.", "Safety validator consumes this."),
    makeField("release_and_retreat_plan", "conditional", "object", "Release and retreat plan.", "Required for tool use."),
    makeField("verification_plan", "required", "array", "Verification plan.", "Must use visual/contact evidence."),
    makeField("reject_tool_use_reason", "conditional", "string", "Reason no tool should be used.", "Required when candidates are unsafe or absent."),
  ], ["reach_ambiguity", "safety_uncertainty", "visibility_ambiguity"]),
  makeSeed("AudioActionResponse", "AudioEventReasoning", true, "validator_stack", [
    makeField("audio_event_interpretation", "required", "object", "Sound class hypothesis.", "Must include confidence."),
    makeField("direction_estimate_use", "conditional", "object", "Use of direction estimate.", "Must treat direction as estimate."),
    makeField("visual_reconciliation", "required", "object", "Visual support or contradiction.", "Required for action-bearing responses."),
    makeField("recommended_action", "required", "string", "Safe recommended action.", "Must be finite."),
    makeField("safety_relevance", "required", "object", "Safety relevance.", "Must not overclaim identity."),
    makeField("memory_relevance", "conditional", "object", "Memory relevance.", "Must require verification when needed."),
  ], ["audio_ambiguity", "visibility_ambiguity", "safety_uncertainty"]),
  makeSeed("MemoryWriteCandidateResponse", "MemoryAssimilationReasoning", false, "memory_writer", [
    makeField("episode_summary", "required", "string", "Observed or verified episode summary.", "Must be grounded."),
    makeField("object_memory_candidates", "conditional", "array", "Object memory candidates.", "Must include confidence and source views."),
    makeField("spatial_memory_candidates", "conditional", "array", "Spatial memory candidates.", "Must include frame and uncertainty."),
    makeField("contradictions_detected", "required", "array", "Memory contradictions.", "Required even when none."),
    makeField("staleness_policy", "required", "object", "Freshness behavior.", "Must match memory governance."),
    makeField("write_readiness", "required", "enum", "Write readiness.", "Must not write unverified guesses.", ["ready_to_write", "write_after_verification", "do_not_write"]),
    makeField("retrieval_tags", "required", "array", "Search tags.", "Must avoid hidden IDs."),
  ], ["memory_conflict", "visibility_ambiguity"]),
  makeSeed("MonologueResponse", "InternalMonologueReasoning", false, "tts_filter", [
    makeField("speech_text", "required", "string", "TTS-ready statement.", "Must meet length and safety filters."),
    makeField("action_summary", "required", "string", "Public action summary.", "Must match validated plan."),
    makeField("evidence_summary", "required", "string", "Visible reason or validator status.", "Must not include private reasoning."),
    makeField("uncertainty_phrase", "conditional", "string", "Brief uncertainty phrase.", "Required when confidence is not high."),
    makeField("interrupt_policy", "required", "enum", "Speech interrupt policy.", "Must allow safety interruption.", ["interruptible", "safety_interruptible", "silent"]),
    makeField("do_not_say", "optional", "array", "Excluded terms.", "Used by TTS filter."),
  ], ["safety_uncertainty", "visibility_ambiguity"]),
]);

export const STRUCTURED_RESPONSE_CONTRACT_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: STRUCTURED_RESPONSE_CONTRACT_SCHEMA_VERSION,
  blueprint: "architecture_docs/07_PROMPT_CONTRACTS_AND_STRUCTURED_OUTPUTS.md",
  sections: freezeArray(["7.3", "7.4", "7.6", "7.7", "7.9", "7.10", "7.11", "7.12", "7.13", "7.14", "7.15", "7.16", "7.17", "7.18", "7.19"]),
});
