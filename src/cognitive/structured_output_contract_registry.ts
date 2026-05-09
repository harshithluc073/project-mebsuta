/**
 * Structured output contract registry for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/06_GEMINI_ROBOTICS_ER_COGNITIVE_LAYER.md`
 * sections 6.6.1, 6.6.2, 6.7.1, 6.11, 6.12.1, 6.18.1, 6.19, and 6.20.
 *
 * This module maps each Gemini Robotics-ER cognitive invocation class to its
 * expected structured response contract. It publishes adapter-ready JSON schema
 * metadata, field-level validation rules, repair eligibility, and rejection
 * policies so raw model output can be quarantined before it reaches validators,
 * memory writers, TTS, or orchestration.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import {
  GEMINI_ROBOTICS_ER_APPROVED_MODEL,
  GEMINI_ROBOTICS_ER_OUTPUT_TOKEN_LIMIT,
} from "./gemini_robotics_er_adapter";
import type {
  CognitiveInvocationClass,
  OutputContractDefinition,
} from "./gemini_robotics_er_adapter";

export const STRUCTURED_OUTPUT_CONTRACT_REGISTRY_SCHEMA_VERSION = "mebsuta.structured_output_contract_registry.v1" as const;
export const STRUCTURED_RESPONSE_ENVELOPE_VERSION = "1.0.0" as const;

const FORBIDDEN_RESPONSE_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|qa_|collision_mesh|simulator|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|hidden|chain-of-thought|scratchpad|system prompt|direct actuator|joint torque|joint current|apply force|apply impulse|reward policy|reinforcement learning|rl update)/i;
const CONTRACT_ID_PATTERN = /^[A-Z][A-Za-z0-9]+Response$/u;
const MAX_CONTRACT_TEXT_TOKENS = 4000;

export type StructuredOutputContractRef =
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

export type ContractLifecycleStatus = "active" | "deprecated" | "withdrawn";
export type ConfidenceValue = "very_low" | "low" | "medium" | "high" | "very_high";
export type EvidenceCategory = "sensor" | "memory" | "embodiment" | "validator" | "task" | "safety" | "schema" | "system" | "tool" | "plan" | "audio" | "uncertainty";
export type UncertaintyCategory = "visibility_ambiguity" | "identity_ambiguity" | "pose_ambiguity" | "reach_ambiguity" | "audio_ambiguity" | "memory_conflict" | "safety_uncertainty";
export type ContractFieldRequirement = "required" | "conditional" | "optional";
export type ContractValueKind = "string" | "boolean" | "number" | "array" | "object" | "enum";
export type ContractResolutionDecision = "resolved" | "resolved_with_warnings" | "rejected";
export type ContractValidationDecision = "released" | "repairable" | "rejected" | "escalation_required";
export type ContractRejectionAction = "repair_once" | "reject" | "safe_hold" | "human_review";

export interface ContractFieldDefinition {
  readonly field_name: string;
  readonly requirement: ContractFieldRequirement;
  readonly value_kind: ContractValueKind;
  readonly description: string;
  readonly validation_rule: string;
  readonly allowed_values?: readonly string[];
}

export interface ContractValidationRule {
  readonly rule_ref: Ref;
  readonly severity: ValidationSeverity;
  readonly description: string;
  readonly rejection_action: ContractRejectionAction;
  readonly repairable: boolean;
}

export interface ContractRejectionPolicy {
  readonly missing_required_field: ContractRejectionAction;
  readonly wrong_contract_id: ContractRejectionAction;
  readonly deprecated_contract: ContractRejectionAction;
  readonly hidden_or_simulator_content: ContractRejectionAction;
  readonly direct_actuator_command: ContractRejectionAction;
  readonly low_confidence_without_reobserve: ContractRejectionAction;
  readonly unsafe_action_proposal: ContractRejectionAction;
  readonly repeated_schema_failure: ContractRejectionAction;
  readonly action_bearing_without_validation: ContractRejectionAction;
}

export interface ContractSchemaMetadata {
  readonly contract_ref: StructuredOutputContractRef;
  readonly contract_version: typeof STRUCTURED_RESPONSE_ENVELOPE_VERSION;
  readonly invocation_class: CognitiveInvocationClass;
  readonly model_identifier: typeof GEMINI_ROBOTICS_ER_APPROVED_MODEL;
  readonly lifecycle_status: ContractLifecycleStatus;
  readonly response_mime_type: "application/json";
  readonly estimated_contract_tokens: number;
  readonly action_bearing: boolean;
  readonly downstream_target: "validator_stack" | "verification_pipeline" | "memory_writer" | "tts_filter";
  readonly repair_allowed: boolean;
  readonly deprecated_after_ms?: number;
}

export interface StructuredOutputContractDescriptor {
  readonly schema_version: typeof STRUCTURED_OUTPUT_CONTRACT_REGISTRY_SCHEMA_VERSION;
  readonly metadata: ContractSchemaMetadata;
  readonly common_envelope_fields: readonly ContractFieldDefinition[];
  readonly primary_result_fields: readonly ContractFieldDefinition[];
  readonly validation_rules: readonly ContractValidationRule[];
  readonly rejection_policy: ContractRejectionPolicy;
  readonly adapter_contract: OutputContractDefinition;
  readonly determinism_hash: string;
}

export interface ContractResolutionRequest {
  readonly invocation_class: CognitiveInvocationClass;
  readonly model_identifier?: string;
  readonly requested_contract_ref?: Ref;
  readonly allow_deprecated?: boolean;
}

export interface ContractResolutionReport {
  readonly schema_version: typeof STRUCTURED_OUTPUT_CONTRACT_REGISTRY_SCHEMA_VERSION;
  readonly decision: ContractResolutionDecision;
  readonly invocation_class: CognitiveInvocationClass;
  readonly requested_contract_ref?: Ref;
  readonly resolved_contract_ref?: StructuredOutputContractRef;
  readonly descriptor?: StructuredOutputContractDescriptor;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface StructuredResponseValidationRequest {
  readonly response_ref: Ref;
  readonly invocation_class: CognitiveInvocationClass;
  readonly expected_contract_ref: StructuredOutputContractRef;
  readonly payload: unknown;
  readonly repair_attempt_count?: number;
}

export interface StructuredResponseValidationReport {
  readonly schema_version: typeof STRUCTURED_OUTPUT_CONTRACT_REGISTRY_SCHEMA_VERSION;
  readonly response_ref: Ref;
  readonly expected_contract_ref: StructuredOutputContractRef;
  readonly decision: ContractValidationDecision;
  readonly required_field_count: number;
  readonly missing_required_fields: readonly string[];
  readonly unsupported_fields: readonly string[];
  readonly repairable: boolean;
  readonly safe_hold_required: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

interface ContractSeed {
  readonly contract_ref: StructuredOutputContractRef;
  readonly invocation_class: CognitiveInvocationClass;
  readonly action_bearing: boolean;
  readonly downstream_target: ContractSchemaMetadata["downstream_target"];
  readonly repair_allowed: boolean;
  readonly primary_result_fields: readonly ContractFieldDefinition[];
  readonly validation_rules: readonly ContractValidationRule[];
}

/**
 * Resolves, publishes, and validates cognitive structured output contracts.
 * The registry is deterministic and side-effect free so it can be reused by the
 * adapter, response quarantine, prompt regression harness, and telemetry tools.
 */
export class StructuredOutputContractRegistry {
  private readonly contractsByRef: ReadonlyMap<StructuredOutputContractRef, StructuredOutputContractDescriptor>;
  private readonly refsByInvocationClass: ReadonlyMap<CognitiveInvocationClass, StructuredOutputContractRef>;

  public constructor(contractSeeds: readonly ContractSeed[] = DEFAULT_CONTRACT_SEEDS) {
    const descriptors = contractSeeds.map((seed) => buildDescriptor(seed));
    this.contractsByRef = Object.freeze(new Map(descriptors.map((descriptor) => [descriptor.metadata.contract_ref, descriptor])));
    this.refsByInvocationClass = Object.freeze(new Map(descriptors.map((descriptor) => [descriptor.metadata.invocation_class, descriptor.metadata.contract_ref])));
    assertRegistryComplete(this.refsByInvocationClass);
  }

  /**
   * Resolves an invocation class and model profile to exactly one active output
   * contract, rejecting unknown contract refs, deprecated contracts, and
   * unsupported model identifiers before any prompt packet is assembled.
   */
  public resolveContract(request: ContractResolutionRequest): ContractResolutionReport {
    const issues: ValidationIssue[] = [];
    if (request.model_identifier !== undefined && request.model_identifier !== GEMINI_ROBOTICS_ER_APPROVED_MODEL) {
      issues.push(issue("error", "UnsupportedModelProfile", "$.model_identifier", "Structured output contracts are pinned to the approved Gemini Robotics-ER profile.", "Use gemini-robotics-er-1.6-preview or create a model migration record."));
    }
    const expectedRef = this.refsByInvocationClass.get(request.invocation_class);
    if (expectedRef === undefined) {
      issues.push(issue("error", "UnknownInvocationClass", "$.invocation_class", "No structured output contract is registered for this invocation class.", "Register a contract before routing this cognitive request."));
      return this.makeResolutionReport(request, undefined, issues);
    }
    if (request.requested_contract_ref !== undefined && request.requested_contract_ref !== expectedRef) {
      issues.push(issue("error", "ContractInvocationMismatch", "$.requested_contract_ref", `Requested contract ${request.requested_contract_ref} does not match ${request.invocation_class}.`, `Use ${expectedRef} for ${request.invocation_class}.`));
    }
    const descriptor = this.contractsByRef.get(expectedRef);
    if (descriptor === undefined) {
      issues.push(issue("error", "RegistryIndexCorrupt", "$.contract_ref", "Invocation index points at a missing descriptor.", "Rebuild the registry with the default contract set."));
      return this.makeResolutionReport(request, undefined, issues);
    }
    if (descriptor.metadata.lifecycle_status !== "active" && request.allow_deprecated !== true) {
      issues.push(issue("error", "ContractDeprecated", "$.contract_ref", `Contract ${descriptor.metadata.contract_ref} is not active.`, "Use the latest active contract or explicitly allow deprecated contracts only in offline regression."));
    }
    if (descriptor.metadata.estimated_contract_tokens > MAX_CONTRACT_TEXT_TOKENS) {
      issues.push(issue("warning", "ContractInstructionLarge", "$.estimated_contract_tokens", "Contract instruction text is larger than the compact prompt budget target.", "Use the adapter JSON schema and compact textual summary in realtime calls."));
    }
    return this.makeResolutionReport(request, descriptor, issues);
  }

  /**
   * Returns the adapter-ready contract definition that can be supplied to the
   * Gemini adapter configuration for response MIME type and JSON schema control.
   */
  public getAdapterOutputContract(contractRef: StructuredOutputContractRef): OutputContractDefinition {
    const descriptor = this.contractsByRef.get(contractRef);
    if (descriptor === undefined) {
      throw new Error(`Structured output contract is not registered: ${contractRef}`);
    }
    return descriptor.adapter_contract;
  }

  /**
   * Returns every active adapter contract in deterministic contract-ref order.
   */
  public getAdapterOutputContracts(): readonly OutputContractDefinition[] {
    return freezeArray([...this.contractsByRef.values()]
      .filter((descriptor) => descriptor.metadata.lifecycle_status === "active")
      .sort((a, b) => a.metadata.contract_ref.localeCompare(b.metadata.contract_ref))
      .map((descriptor) => descriptor.adapter_contract));
  }

  /**
   * Validates a parsed model response against the common envelope and the
   * contract-specific `primary_result` fields. This is a quarantine-grade check:
   * it rejects hidden implementation content, action-bearing outputs that do
   * not require validation, low-confidence outputs without re-observation, and
   * repeated malformed responses.
   */
  public validateStructuredResponse(request: StructuredResponseValidationRequest): StructuredResponseValidationReport {
    const descriptor = this.contractsByRef.get(request.expected_contract_ref);
    const issues: ValidationIssue[] = [];
    const missingRequiredFields: string[] = [];
    const unsupportedFields: string[] = [];
    if (descriptor === undefined) {
      issues.push(issue("error", "UnknownOutputContract", "$.expected_contract_ref", "Expected contract is not registered.", "Reject the response and route the request through a known contract."));
      return makeValidationReport(request, "rejected", missingRequiredFields, unsupportedFields, false, true, issues);
    }
    if (descriptor.metadata.invocation_class !== request.invocation_class) {
      issues.push(issue("error", "ContractInvocationMismatch", "$.invocation_class", "Response contract does not belong to the requested invocation class.", "Use the router-selected contract for validation."));
    }
    if (!isRecord(request.payload)) {
      issues.push(issue("error", "MalformedStructuredResponse", "$.payload", "Structured response must parse to a JSON object.", "Repair once with the original contract, then reject on repeat failure."));
      return makeValidationReport(request, repeatedFailureDecision(request), missingRequiredFields, unsupportedFields, request.repair_attempt_count === undefined || request.repair_attempt_count < 1, descriptor.metadata.action_bearing, issues);
    }
    validateEnvelope(request.payload, descriptor, missingRequiredFields, unsupportedFields, issues);
    validatePrimaryResult(request.payload.primary_result, descriptor, missingRequiredFields, issues);
    validateForbiddenContent(request.payload, issues);
    validateConfidenceAndReobserve(request.payload, descriptor, issues);
    validateActionValidationGate(request.payload, descriptor, issues);
    const safeHoldRequired = descriptor.metadata.action_bearing && issues.some((item) => item.severity === "error");
    const decision = chooseValidationDecision(issues, descriptor, request.repair_attempt_count ?? 0);
    const repairable = decision === "repairable";
    return makeValidationReport(request, decision, missingRequiredFields, unsupportedFields, repairable, safeHoldRequired, issues);
  }

  private makeResolutionReport(
    request: ContractResolutionRequest,
    descriptor: StructuredOutputContractDescriptor | undefined,
    issues: readonly ValidationIssue[],
  ): ContractResolutionReport {
    const decision: ContractResolutionDecision = issues.some((item) => item.severity === "error")
      ? "rejected"
      : issues.some((item) => item.severity === "warning")
        ? "resolved_with_warnings"
        : "resolved";
    const base = {
      schema_version: STRUCTURED_OUTPUT_CONTRACT_REGISTRY_SCHEMA_VERSION,
      decision,
      invocation_class: request.invocation_class,
      requested_contract_ref: request.requested_contract_ref,
      resolved_contract_ref: descriptor?.metadata.contract_ref,
      descriptor,
      issues: freezeArray(issues),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }
}

function buildDescriptor(seed: ContractSeed): StructuredOutputContractDescriptor {
  const commonFields = COMMON_ENVELOPE_FIELDS;
  const metadata: ContractSchemaMetadata = Object.freeze({
    contract_ref: seed.contract_ref,
    contract_version: STRUCTURED_RESPONSE_ENVELOPE_VERSION,
    invocation_class: seed.invocation_class,
    model_identifier: GEMINI_ROBOTICS_ER_APPROVED_MODEL,
    lifecycle_status: "active",
    response_mime_type: "application/json",
    estimated_contract_tokens: estimateContractTokens(commonFields, seed.primary_result_fields, seed.validation_rules),
    action_bearing: seed.action_bearing,
    downstream_target: seed.downstream_target,
    repair_allowed: seed.repair_allowed,
  });
  const adapterContract = buildAdapterContract(metadata, commonFields, seed.primary_result_fields);
  const base = {
    schema_version: STRUCTURED_OUTPUT_CONTRACT_REGISTRY_SCHEMA_VERSION,
    metadata,
    common_envelope_fields: commonFields,
    primary_result_fields: seed.primary_result_fields,
    validation_rules: freezeArray([...BASE_VALIDATION_RULES, ...seed.validation_rules]),
    rejection_policy: defaultRejectionPolicy(seed.action_bearing, seed.repair_allowed),
    adapter_contract: adapterContract,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function buildAdapterContract(
  metadata: ContractSchemaMetadata,
  envelopeFields: readonly ContractFieldDefinition[],
  primaryFields: readonly ContractFieldDefinition[],
): OutputContractDefinition {
  const requiredEnvelopeFields = envelopeFields.filter((field) => field.requirement === "required").map((field) => field.field_name);
  const requiredPrimaryFields = primaryFields.filter((field) => field.requirement === "required").map((field) => field.field_name);
  return Object.freeze({
    contract_ref: metadata.contract_ref,
    required_fields: freezeArray(requiredEnvelopeFields),
    allowed_action_fields: metadata.action_bearing
      ? freezeArray(["primary_result", "requires_validation", "safety_notes", "reobserve_request"])
      : freezeArray(["primary_result", "safety_notes", "reobserve_request"]),
    response_mime_type: "application/json" as const,
    json_schema: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: Object.freeze({
        response_contract_id: enumSchema([metadata.contract_ref]),
        contract_version_ack: stringSchema(),
        task_state_ref: stringSchema(),
        evidence_used: arraySchema(stringSchema()),
        primary_result: Object.freeze({
          type: "object",
          additionalProperties: true,
          properties: Object.freeze(Object.fromEntries(primaryFields.map((field) => [field.field_name, schemaForField(field)]))),
          required: freezeArray(requiredPrimaryFields),
        }),
        confidence: enumSchema(["very_low", "low", "medium", "high", "very_high"]),
        uncertainties: arraySchema(Object.freeze({
          type: "object",
          additionalProperties: true,
          properties: Object.freeze({
            category: enumSchema(["visibility_ambiguity", "identity_ambiguity", "pose_ambiguity", "reach_ambiguity", "audio_ambiguity", "memory_conflict", "safety_uncertainty"]),
            summary: stringSchema(),
          }),
          required: freezeArray(["category", "summary"]),
        })),
        requires_validation: booleanSchema(),
        reobserve_request: Object.freeze({
          anyOf: freezeArray([stringSchema(), Object.freeze({ type: "object", additionalProperties: true }), Object.freeze({ type: "null" })]),
        }),
        safety_notes: arraySchema(stringSchema()),
        forbidden_content_absent: booleanSchema(),
      }),
      required: freezeArray(requiredEnvelopeFields),
    }),
  });
}

function validateEnvelope(
  payload: Record<string, unknown>,
  descriptor: StructuredOutputContractDescriptor,
  missingRequiredFields: string[],
  unsupportedFields: string[],
  issues: ValidationIssue[],
): void {
  const allowedFields = new Set(descriptor.common_envelope_fields.map((field) => field.field_name));
  for (const field of descriptor.common_envelope_fields) {
    const value = payload[field.field_name];
    if (field.requirement === "required" && value === undefined) {
      missingRequiredFields.push(field.field_name);
      issues.push(issue("error", "RequiredEnvelopeFieldMissing", `$.${field.field_name}`, `Required envelope field ${field.field_name} is missing.`, "Repair with the full common structured response envelope."));
      continue;
    }
    if (value !== undefined && valueMatchesKind(value, field) === false) {
      issues.push(issue("error", "EnvelopeFieldTypeMismatch", `$.${field.field_name}`, `Envelope field ${field.field_name} does not match ${field.value_kind}.`, "Repair the response with the documented field type."));
    }
  }
  for (const key of Object.keys(payload)) {
    if (allowedFields.has(key) === false) {
      unsupportedFields.push(key);
      issues.push(issue("warning", "UnsupportedEnvelopeField", `$.${key}`, `Response includes unsupported envelope field ${key}.`, "Strip unsupported fields before downstream handoff."));
    }
  }
  if (payload.response_contract_id !== descriptor.metadata.contract_ref) {
    issues.push(issue("error", "WrongContractId", "$.response_contract_id", `Response contract ID must be ${descriptor.metadata.contract_ref}.`, "Repair with the requested contract ID or reject the response."));
  }
  if (typeof payload.contract_version_ack === "string" && isCompatibleVersion(payload.contract_version_ack) === false) {
    issues.push(issue("error", "ContractVersionMismatch", "$.contract_version_ack", `Contract version must be compatible with ${STRUCTURED_RESPONSE_ENVELOPE_VERSION}.`, "Use the current structured response envelope version."));
  }
}

function validatePrimaryResult(
  primaryResult: unknown,
  descriptor: StructuredOutputContractDescriptor,
  missingRequiredFields: string[],
  issues: ValidationIssue[],
): void {
  if (!isRecord(primaryResult)) {
    issues.push(issue("error", "PrimaryResultMalformed", "$.primary_result", "Primary result must be a JSON object.", "Repair the response with a contract-specific primary_result object."));
    for (const field of descriptor.primary_result_fields.filter((item) => item.requirement === "required")) {
      missingRequiredFields.push(`primary_result.${field.field_name}`);
    }
    return;
  }
  for (const field of descriptor.primary_result_fields) {
    const value = primaryResult[field.field_name];
    if (field.requirement === "required" && value === undefined) {
      missingRequiredFields.push(`primary_result.${field.field_name}`);
      issues.push(issue("error", "RequiredPrimaryFieldMissing", `$.primary_result.${field.field_name}`, `Required ${descriptor.metadata.contract_ref} field ${field.field_name} is missing.`, "Repair with the contract-specific primary_result fields."));
      continue;
    }
    if (value !== undefined && valueMatchesKind(value, field) === false) {
      issues.push(issue("error", "PrimaryFieldTypeMismatch", `$.primary_result.${field.field_name}`, `Primary result field ${field.field_name} does not match ${field.value_kind}.`, "Repair the field with the documented type or constrained value."));
    }
  }
}

function validateForbiddenContent(payload: Record<string, unknown>, issues: ValidationIssue[]): void {
  const serialized = JSON.stringify(payload);
  if (FORBIDDEN_RESPONSE_PATTERN.test(serialized)) {
    issues.push(issue("error", "ForbiddenResponseContent", "$", "Response contains hidden implementation, simulator-truth, hidden-reasoning, or direct-control language.", "Reject execution-bound responses and rebuild a safe prompt or repair only for non-execution content."));
  }
  if (payload.forbidden_content_absent !== true) {
    issues.push(issue("error", "ForbiddenContentAssertionMissing", "$.forbidden_content_absent", "Response must explicitly assert absence of forbidden content while still being independently scanned.", "Repair with forbidden_content_absent=true only when the response contains no forbidden content."));
  }
}

function validateConfidenceAndReobserve(
  payload: Record<string, unknown>,
  descriptor: StructuredOutputContractDescriptor,
  issues: ValidationIssue[],
): void {
  const confidence = payload.confidence;
  const reobserve = payload.reobserve_request;
  if (isConfidenceValue(confidence) === false) {
    issues.push(issue("error", "ConfidenceInvalid", "$.confidence", "Confidence must use the approved five-value confidence scale.", "Use very_low, low, medium, high, or very_high."));
    return;
  }
  const uncertainties = Array.isArray(payload.uncertainties) ? payload.uncertainties : [];
  if ((confidence === "very_low" || confidence === "low") && isNonEmptyReobserveRequest(reobserve) === false) {
    issues.push(issue("error", "LowConfidenceWithoutReobserve", "$.reobserve_request", "Low-confidence responses must request more evidence, safe-hold, or re-observation.", "Add a concrete re-observation request or reject the response."));
  }
  if (descriptor.metadata.action_bearing && confidence === "medium" && uncertainties.length === 0) {
    issues.push(issue("warning", "ActionUncertaintyNotExplained", "$.uncertainties", "Action-bearing medium-confidence responses should explain uncertainty for validators.", "Include visibility, pose, reach, audio, memory, or safety uncertainty as appropriate."));
  }
}

function validateActionValidationGate(
  payload: Record<string, unknown>,
  descriptor: StructuredOutputContractDescriptor,
  issues: ValidationIssue[],
): void {
  if (descriptor.metadata.action_bearing && payload.requires_validation !== true) {
    issues.push(issue("error", "ActionValidationGateMissing", "$.requires_validation", "Action-bearing output must require deterministic validation before execution.", "Set requires_validation=true and include validator-ready fields."));
  }
  if (descriptor.metadata.contract_ref === "MonologueResponse" && payload.requires_validation !== false) {
    issues.push(issue("warning", "MonologueValidationFlagUnexpected", "$.requires_validation", "Monologue output is TTS-bound and should not itself become an execution validator gate.", "Use the validated plan as the authority and keep monologue public-only."));
  }
}

function chooseValidationDecision(
  issues: readonly ValidationIssue[],
  descriptor: StructuredOutputContractDescriptor,
  repairAttemptCount: number,
): ContractValidationDecision {
  const hasErrorIssue = issues.some((item) => item.severity === "error");
  if (!hasErrorIssue) {
    return "released";
  }
  if (descriptor.metadata.action_bearing && hasUnsafeOrForbiddenIssue(issues)) {
    return "rejected";
  }
  if (repairAttemptCount > 0) {
    return descriptor.metadata.action_bearing ? "escalation_required" : "rejected";
  }
  return descriptor.metadata.repair_allowed ? "repairable" : "rejected";
}

function repeatedFailureDecision(request: StructuredResponseValidationRequest): ContractValidationDecision {
  return (request.repair_attempt_count ?? 0) > 0 ? "rejected" : "repairable";
}

function hasUnsafeOrForbiddenIssue(issues: readonly ValidationIssue[]): boolean {
  return issues.some((item) =>
    item.code === "ForbiddenResponseContent"
    || item.code === "ActionValidationGateMissing"
    || item.code === "WrongContractId");
}

function makeValidationReport(
  request: StructuredResponseValidationRequest,
  decision: ContractValidationDecision,
  missingRequiredFields: readonly string[],
  unsupportedFields: readonly string[],
  repairable: boolean,
  safeHoldRequired: boolean,
  issues: readonly ValidationIssue[],
): StructuredResponseValidationReport {
  const base = {
    schema_version: STRUCTURED_OUTPUT_CONTRACT_REGISTRY_SCHEMA_VERSION,
    response_ref: request.response_ref,
    expected_contract_ref: request.expected_contract_ref,
    decision,
    required_field_count: missingRequiredFields.length,
    missing_required_fields: freezeArray(missingRequiredFields),
    unsupported_fields: freezeArray(unsupportedFields),
    repairable,
    safe_hold_required: safeHoldRequired,
    issues: freezeArray(issues),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function assertRegistryComplete(index: ReadonlyMap<CognitiveInvocationClass, StructuredOutputContractRef>): void {
  const missing = ALL_INVOCATION_CLASSES.filter((invocationClass) => index.has(invocationClass) === false);
  if (missing.length > 0) {
    throw new Error(`StructuredOutputContractRegistry missing invocation classes: ${missing.join(", ")}`);
  }
}

function estimateContractTokens(
  commonFields: readonly ContractFieldDefinition[],
  primaryFields: readonly ContractFieldDefinition[],
  rules: readonly ContractValidationRule[],
): number {
  const text = [...commonFields, ...primaryFields]
    .map((field) => `${field.field_name} ${field.requirement} ${field.description} ${field.validation_rule} ${(field.allowed_values ?? []).join(" ")}`)
    .join(" ");
  const ruleText = rules.map((rule) => `${rule.rule_ref} ${rule.description}`).join(" ");
  return Math.ceil((text.length + ruleText.length) / 4);
}

function defaultRejectionPolicy(actionBearing: boolean, repairAllowed: boolean): ContractRejectionPolicy {
  return Object.freeze({
    missing_required_field: repairAllowed ? "repair_once" : "reject",
    wrong_contract_id: "repair_once",
    deprecated_contract: "reject",
    hidden_or_simulator_content: actionBearing ? "safe_hold" : "reject",
    direct_actuator_command: actionBearing ? "safe_hold" : "reject",
    low_confidence_without_reobserve: repairAllowed ? "repair_once" : "reject",
    unsafe_action_proposal: actionBearing ? "safe_hold" : "reject",
    repeated_schema_failure: actionBearing ? "human_review" : "reject",
    action_bearing_without_validation: actionBearing ? "safe_hold" : "reject",
  });
}

function valueMatchesKind(value: unknown, field: ContractFieldDefinition): boolean {
  if (field.value_kind === "array") {
    return Array.isArray(value);
  }
  if (field.value_kind === "object") {
    return isRecord(value);
  }
  if (field.value_kind === "boolean") {
    return typeof value === "boolean";
  }
  if (field.value_kind === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (field.value_kind === "enum") {
    return typeof value === "string" && (field.allowed_values ?? []).includes(value);
  }
  return typeof value === "string";
}

function schemaForField(field: ContractFieldDefinition): Readonly<Record<string, unknown>> {
  if (field.value_kind === "array") {
    return arraySchema(Object.freeze({ anyOf: freezeArray([stringSchema(), Object.freeze({ type: "object", additionalProperties: true })]) }));
  }
  if (field.value_kind === "object") {
    return Object.freeze({ type: "object", additionalProperties: true });
  }
  if (field.value_kind === "boolean") {
    return booleanSchema();
  }
  if (field.value_kind === "number") {
    return Object.freeze({ type: "number" });
  }
  if (field.value_kind === "enum") {
    return enumSchema(field.allowed_values ?? []);
  }
  return stringSchema();
}

function stringSchema(): Readonly<Record<string, unknown>> {
  return Object.freeze({ type: "string" });
}

function booleanSchema(): Readonly<Record<string, unknown>> {
  return Object.freeze({ type: "boolean" });
}

function arraySchema(items: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.freeze({ type: "array", items });
}

function enumSchema(values: readonly string[]): Readonly<Record<string, unknown>> {
  return Object.freeze({ type: "string", enum: freezeArray(values) });
}

function isCompatibleVersion(version: string): boolean {
  const expectedMajor = STRUCTURED_RESPONSE_ENVELOPE_VERSION.split(".")[0];
  const actualMajor = version.split(".")[0];
  return actualMajor === expectedMajor && version.trim().length > 0;
}

function isConfidenceValue(value: unknown): value is ConfidenceValue {
  return value === "very_low" || value === "low" || value === "medium" || value === "high" || value === "very_high";
}

function isNonEmptyReobserveRequest(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (isRecord(value)) {
    return Object.keys(value).length > 0;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(
  fieldName: string,
  requirement: ContractFieldRequirement,
  valueKind: ContractValueKind,
  description: string,
  validationRule: string,
  allowedValues?: readonly string[],
): ContractFieldDefinition {
  return Object.freeze({
    field_name: fieldName,
    requirement,
    value_kind: valueKind,
    description,
    validation_rule: validationRule,
    allowed_values: allowedValues === undefined ? undefined : freezeArray(allowedValues),
  });
}

function rule(
  ruleRef: Ref,
  severity: ValidationSeverity,
  description: string,
  rejectionAction: ContractRejectionAction,
  repairable: boolean,
): ContractValidationRule {
  return Object.freeze({
    rule_ref: ruleRef,
    severity,
    description,
    rejection_action: rejectionAction,
    repairable,
  });
}

function seed(
  contractRef: StructuredOutputContractRef,
  invocationClass: CognitiveInvocationClass,
  actionBearing: boolean,
  downstreamTarget: ContractSchemaMetadata["downstream_target"],
  repairAllowed: boolean,
  primaryResultFields: readonly ContractFieldDefinition[],
  validationRules: readonly ContractValidationRule[],
): ContractSeed {
  return Object.freeze({
    contract_ref: contractRef,
    invocation_class: invocationClass,
    action_bearing: actionBearing,
    downstream_target: downstreamTarget,
    repair_allowed: repairAllowed,
    primary_result_fields: freezeArray(primaryResultFields),
    validation_rules: freezeArray(validationRules),
  });
}

function issue(severity: ValidationSeverity, code: string, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

const ALL_CONTRACT_REFS: readonly StructuredOutputContractRef[] = freezeArray([
  "SceneUnderstandingResponse",
  "TaskPlanResponse",
  "WaypointPlanResponse",
  "MultiViewConsensusResponse",
  "VisualVerificationResponse",
  "CorrectionPlanResponse",
  "ToolUsePlanResponse",
  "AudioActionResponse",
  "MemoryWriteCandidateResponse",
  "MonologueResponse",
]);

const COMMON_ENVELOPE_FIELDS: readonly ContractFieldDefinition[] = freezeArray([
  field("response_contract_id", "required", "enum", "Stable response contract family used by the model.", "Must match the requested contract ref.", ALL_CONTRACT_REFS),
  field("contract_version_ack", "required", "string", "Acknowledgement of the response contract version.", "Major version must match the registry version."),
  field("task_state_ref", "required", "string", "Prompt-safe orchestrator task reference.", "Must not contain simulator identity or hidden state."),
  field("evidence_used", "required", "array", "Evidence categories and refs used by the response.", "Must cite allowed provenance labels only."),
  field("primary_result", "required", "object", "Contract-specific structured answer.", "Must contain all required fields for the response family."),
  field("confidence", "required", "enum", "Approved confidence category.", "Must use the architecture confidence scale.", ["very_low", "low", "medium", "high", "very_high"]),
  field("uncertainties", "required", "array", "Ambiguities, missing evidence, or contradictions.", "May be empty only for high-confidence non-ambiguous outputs."),
  field("requires_validation", "required", "boolean", "Whether downstream validators are required before execution or memory write.", "Must be true for action-bearing outputs."),
  field("reobserve_request", "conditional", "object", "Requested view, audio, crop, or sensor update.", "Required when confidence is low or evidence is incomplete."),
  field("safety_notes", "required", "array", "Safety constraints relevant to output.", "Must not override deterministic safety or safe-hold policy."),
  field("forbidden_content_absent", "required", "boolean", "Model assertion that it did not use forbidden hidden data.", "Must be true and independently scanned."),
]);

const BASE_VALIDATION_RULES: readonly ContractValidationRule[] = freezeArray([
  rule("contract.rule.common.contract_id_match", "error", "Response contract id must match the requested output contract.", "repair_once", true),
  rule("contract.rule.common.version_compatible", "error", "Contract version acknowledgement must be compatible with the registry major version.", "repair_once", true),
  rule("contract.rule.common.no_hidden_detail", "error", "Response must not contain simulator truth, backend handles, hidden reasoning, or direct actuator commands.", "safe_hold", false),
  rule("contract.rule.common.confidence_scale", "error", "Confidence must use the approved five-value scale.", "repair_once", true),
  rule("contract.rule.common.low_confidence_reobserve", "error", "Low-confidence responses require re-observation, safe-hold, or evidence gathering.", "repair_once", true),
  rule("contract.rule.common.action_validation_gate", "error", "Action-bearing outputs require deterministic validation before execution.", "safe_hold", false),
]);

const ALL_INVOCATION_CLASSES: readonly CognitiveInvocationClass[] = freezeArray([
  "SceneObservationReasoning",
  "TaskPlanningReasoning",
  "WaypointGenerationReasoning",
  "MultiViewDisambiguationReasoning",
  "SpatialVerificationReasoning",
  "OopsCorrectionReasoning",
  "ToolUseReasoning",
  "AudioEventReasoning",
  "MemoryAssimilationReasoning",
  "InternalMonologueReasoning",
]);

const DEFAULT_CONTRACT_SEEDS: readonly ContractSeed[] = freezeArray([
  seed(
    "SceneUnderstandingResponse",
    "SceneObservationReasoning",
    false,
    "validator_stack",
    true,
    [
      field("visible_object_hypotheses", "required", "array", "Visible objects with label, description, evidence views, confidence, and ambiguity.", "Each object must reference current sensor views and avoid backend IDs."),
      field("object_relationships", "required", "array", "Relative relations such as near, inside, on top of, occluding, or reachable side.", "Each relation must state whether it is visual or inferred."),
      field("affordance_hypotheses", "required", "array", "Graspable, pushable, container-like, tool-like, fragile, slippery, or heavy-looking affordances.", "Each affordance must include confidence and evidence."),
      field("occlusion_report", "required", "object", "Blocked, cropped, blurred, or hidden scene areas.", "Required even when no occlusion is apparent."),
      field("spatial_attention_points", "conditional", "array", "View-specific normalized points or regions for downstream perception.", "Must be normalized and view-specific when present."),
      field("reobserve_request", "conditional", "object", "Requested camera movement, crop, angle, lighting, or audio update.", "Required below planning confidence."),
      field("memory_alignment", "optional", "object", "Current observation agreement or conflict with retrieved memory.", "Must label conflicts and memory staleness."),
      field("safety_relevant_observations", "required", "array", "Visible obstacles, unstable stacks, collision risks, or hazards.", "May not claim final safety."),
    ],
    [
      rule("contract.rule.scene.object_evidence_required", "error", "Object hypotheses require evidence views and confidence.", "repair_once", true),
      rule("contract.rule.scene.occlusion_required", "error", "Occlusion report is mandatory to prevent blind-spot overconfidence.", "repair_once", true),
    ],
  ),
  seed(
    "TaskPlanResponse",
    "TaskPlanningReasoning",
    true,
    "validator_stack",
    true,
    [
      field("task_interpretation", "required", "object", "Restated objective, target objects, desired arrangement, and constraints.", "Must not invent objects or hidden goals."),
      field("assumptions", "required", "array", "Explicit assumptions for ambiguous instructions.", "Assumptions must be bounded and safe."),
      field("ordered_phases", "required", "array", "Observe, approach, inspect, manipulate, place, verify, correct, and memory phases.", "Each phase must include preconditions and validation needs."),
      field("object_roles", "required", "array", "Target, support, container, distractor, obstacle, or possible tool roles.", "Roles must trace to observation or instruction."),
      field("spatial_constraints", "conditional", "array", "Desired final relations and human-readable tolerances.", "Must be validator-ready without hidden truth."),
      field("embodiment_considerations", "required", "array", "Body limits, reach constraints, stance, and tool needs.", "Must match prompt-safe embodiment context."),
      field("validation_checkpoints", "required", "array", "Deterministic validation and visual verification gates.", "Required before execution-bearing phases."),
      field("fallback_strategy", "required", "object", "Re-observe, reposition, use tool, alternate grasp, safe-hold, or escalation strategy.", "Must respect retry budget."),
      field("requires_waypoint_generation", "required", "boolean", "Whether a separate waypoint contract is needed.", "Must be true for physical motion beyond orient or reobserve."),
    ],
    [
      rule("contract.rule.plan.no_direct_actuator", "error", "Planning outputs must not include direct actuator commands.", "safe_hold", false),
      rule("contract.rule.plan.validation_checkpoint_required", "error", "Every action-bearing phase needs deterministic validation.", "safe_hold", false),
    ],
  ),
  seed(
    "WaypointPlanResponse",
    "WaypointGenerationReasoning",
    true,
    "validator_stack",
    true,
    [
      field("waypoint_intent", "required", "enum", "Approach, inspect, grasp, lift, carry, place, retreat, tool-sweep, or re-observe intent.", "Must use approved waypoint vocabulary.", ["approach", "inspect", "grasp", "lift", "carry", "place", "retreat", "tool_sweep", "reobserve"]),
      field("reference_evidence", "required", "array", "Sensor views, object hypotheses, memory snippets, or validation feedback used.", "Must use allowed provenance."),
      field("target_relation", "required", "object", "Object-relative or body-relative target description.", "Must not use hidden simulator coordinates."),
      field("candidate_waypoints", "required", "array", "Ordered candidate targets with qualitative or estimated coordinates where allowed.", "Each waypoint must include frame label and uncertainty."),
      field("tolerances", "conditional", "object", "Position, orientation, and relation tolerance requests.", "Must be compatible with task and verification."),
      field("preconditions", "required", "array", "Visibility, grasp state, stance, tool attachment, or object-state prerequisites.", "Must be checkable."),
      field("postconditions", "required", "array", "Expected visible result after waypoint execution.", "Must feed verification."),
      field("risk_notes", "required", "array", "Collision, occlusion, balance, slip, overreach, tool sweep, or contact risk.", "Safety validator consumes this."),
      field("validator_handoff", "required", "object", "Reach, IK, collision, stability, tool-envelope, and spatial-relation validators needed.", "Required for all physical motion."),
    ],
    [
      rule("contract.rule.waypoint.frame_policy", "error", "Waypoints must use image-normalized, object-relative, target-relative, or agent-estimated frames.", "safe_hold", false),
      rule("contract.rule.waypoint.stop_condition", "error", "Waypoint plans require finite endpoint, tolerance, and stop condition.", "repair_once", true),
    ],
  ),
  seed(
    "MultiViewConsensusResponse",
    "MultiViewDisambiguationReasoning",
    false,
    "validator_stack",
    true,
    [
      field("view_inventory", "required", "array", "Views considered, quality, timestamp relationship, and perspective role.", "Must match provided view packet names."),
      field("consensus_objects", "required", "array", "Objects supported across views or strongly supported by a relevant view.", "Must include evidence per object."),
      field("conflicting_hypotheses", "required", "array", "View disagreements or possible identity swaps.", "Empty only when explicitly no conflicts exist."),
      field("occlusion_explanation", "required", "object", "Which view sees or misses object and why.", "Must distinguish occlusion from absence."),
      field("pose_confidence", "required", "object", "Confidence in orientation, depth, support, and accessible side.", "Must include uncertainty category."),
      field("recommended_next_view", "conditional", "object", "Camera move, crop, wrist view, side view, or head reposition.", "Required when consensus is insufficient."),
      field("planning_readiness", "required", "enum", "Readiness state for planning, search, verification, or re-observation.", "Must align with confidence.", ["ready_for_planning", "ready_only_for_search", "verification_only", "not_ready"]),
    ],
    [
      rule("contract.rule.multiview.conflict_preserved", "error", "Conflicting view evidence must be represented rather than ignored.", "repair_once", true),
      rule("contract.rule.multiview.next_view_low_confidence", "error", "Insufficient consensus requires a next-view recommendation.", "repair_once", true),
    ],
  ),
  seed(
    "VisualVerificationResponse",
    "SpatialVerificationReasoning",
    false,
    "verification_pipeline",
    true,
    [
      field("target_constraint_summary", "required", "object", "Restatement of the spatial constraint being checked.", "Must match task and validator context."),
      field("visual_evidence_for_success", "required", "array", "View-specific evidence supporting success.", "Must cite view names and observed relations."),
      field("visual_evidence_against_success", "required", "array", "Misalignment, occlusion, instability, object mismatch, or uncertainty.", "Required even if none found."),
      field("constraint_status", "required", "enum", "Visual status of the checked constraint.", "Cannot be satisfied under low confidence.", ["appears_satisfied", "appears_unsatisfied", "ambiguous", "cannot_assess"]),
      field("residual_hint", "conditional", "object", "Qualitative direction or magnitude of visible error.", "Must be estimated, not hidden truth."),
      field("needed_additional_evidence", "conditional", "object", "Re-observe request when visual evidence is incomplete.", "Required for ambiguity."),
      field("memory_update_readiness", "required", "boolean", "Whether memory may write the outcome after deterministic certificate.", "Must remain false until final validation."),
      field("oops_loop_trigger_suggestion", "conditional", "object", "Whether correction should start and why.", "Must be evidence-based."),
    ],
    [
      rule("contract.rule.verify.low_confidence_no_success", "error", "Low confidence may not produce an appears_satisfied status.", "repair_once", true),
      rule("contract.rule.verify.memory_not_proof", "error", "Memory alone may not prove current placement success.", "reject", false),
    ],
  ),
  seed(
    "CorrectionPlanResponse",
    "OopsCorrectionReasoning",
    true,
    "validator_stack",
    true,
    [
      field("failure_summary", "required", "object", "What appears to have gone wrong.", "Must separate evidence from inference."),
      field("ranked_cause_hypotheses", "required", "array", "Physical cause hypotheses with confidence and supporting evidence.", "Must include alternatives when uncertainty exists."),
      field("immediate_safety_action", "required", "enum", "Hold, release, stabilize, retreat, re-observe, or continue cautiously.", "Must be safe and finite.", ["hold", "release", "stabilize", "retreat", "reobserve", "continue_cautiously"]),
      field("corrective_strategy", "required", "array", "Revised high-level action sequence.", "Must be smaller or safer than the failed strategy unless evidence supports otherwise."),
      field("changed_assumptions", "required", "array", "Beliefs changed by the failure evidence.", "Must trace to evidence."),
      field("new_validation_requirements", "required", "array", "Validators needed before retry.", "Must include retry budget and safety checks."),
      field("reobserve_request", "conditional", "object", "Additional evidence needed before correction.", "Required under low confidence."),
      field("escalation_recommendation", "conditional", "object", "Human review or terminal failure if retries are exhausted.", "Must respect retry budget."),
    ],
    [
      rule("contract.rule.correction.retry_budget_authority", "error", "Correction must respect retry budget and escalation threshold.", "safe_hold", false),
      rule("contract.rule.correction.safety_first", "error", "Safety-critical anomalies require immediate safe action before corrective planning.", "safe_hold", false),
    ],
  ),
  seed(
    "ToolUsePlanResponse",
    "ToolUseReasoning",
    true,
    "validator_stack",
    true,
    [
      field("reach_limitation_summary", "required", "object", "Why direct manipulation appears insufficient.", "Must cite reach report or visible limitation."),
      field("tool_candidates", "required", "array", "Visible tool-like objects with affordance and confidence.", "Must be sensor-derived and not invented."),
      field("selected_tool_rationale", "conditional", "object", "Why one candidate is chosen or none is acceptable.", "Must include safety and suitability."),
      field("tool_attachment_plan", "conditional", "object", "How the body would grasp, hold, mouth-grip, or contact the tool.", "Must be validator-ready."),
      field("tool_action_plan", "conditional", "object", "Push, pull, hook, sweep, nudge, extend reach, block, or probe plan.", "Must be finite with stop criteria."),
      field("swept_volume_concerns", "required", "array", "Obstacles, target fragility, occlusion, body collision, and overreach concerns.", "Safety validator consumes this."),
      field("release_and_retreat_plan", "conditional", "object", "How the tool is released and body returns to safe posture.", "Required when using a tool."),
      field("verification_plan", "required", "object", "How to verify tool effect before continuing.", "Must use visual or contact evidence."),
      field("reject_tool_use_reason", "conditional", "object", "Why no tool should be used.", "Required when candidates are unsafe or absent."),
    ],
    [
      rule("contract.rule.tool.visible_tool_only", "error", "Tool candidates must be visible and evidence-backed.", "safe_hold", false),
      rule("contract.rule.tool.release_required", "error", "Selected tool use requires release and retreat planning.", "repair_once", true),
    ],
  ),
  seed(
    "AudioActionResponse",
    "AudioEventReasoning",
    true,
    "validator_stack",
    true,
    [
      field("audio_event_interpretation", "required", "object", "Sound class hypothesis and confidence.", "Must include confidence and treat source class as uncertain unless validated."),
      field("direction_estimate_use", "conditional", "object", "How sound direction estimate affects action.", "Must treat direction as estimate."),
      field("visual_reconciliation", "required", "object", "Whether visual evidence supports, contradicts, or does not address the audio event.", "Required for action-bearing responses."),
      field("recommended_action", "required", "enum", "Safe next response to the audio event.", "Must be safe and finite.", ["orient_camera", "pause", "inspect", "reobserve", "start_oops_loop", "update_memory", "ignore_low_confidence"]),
      field("safety_relevance", "required", "object", "Whether the sound implies collision, drop, slip, instruction, or environmental change.", "Must not overclaim identity."),
      field("memory_relevance", "conditional", "object", "Whether the event should create or update memory.", "Must require verification when needed."),
    ],
    [
      rule("contract.rule.audio.direction_is_estimate", "error", "Low-confidence direction estimates require orienting or re-observation, not direct motion.", "repair_once", true),
      rule("contract.rule.audio.no_audio_generation", "error", "Audio reasoning output must not request Gemini audio generation.", "reject", false),
    ],
  ),
  seed(
    "MemoryWriteCandidateResponse",
    "MemoryAssimilationReasoning",
    false,
    "memory_writer",
    true,
    [
      field("episode_summary", "required", "string", "Short summary of what was observed or verified.", "Must be grounded in current evidence or final certificate."),
      field("object_memory_candidates", "conditional", "array", "Object labels, descriptors, approximate locations, affordances, and relationships.", "Must include confidence and source views."),
      field("spatial_memory_candidates", "conditional", "array", "Object-relative, target-relative, or agent-estimated spatial facts.", "Must include frame and uncertainty."),
      field("contradictions_detected", "required", "array", "Conflicts with retrieved memories.", "Required even when none."),
      field("staleness_policy", "required", "object", "Suggested freshness or expiry behavior.", "Must match memory governance."),
      field("write_readiness", "required", "enum", "Memory write readiness.", "Must not write unverified guesses as facts.", ["ready_to_write", "write_after_verification", "do_not_write"]),
      field("retrieval_tags", "required", "array", "Search terms, object descriptors, relation labels, and task tags.", "Must avoid hidden IDs."),
    ],
    [
      rule("contract.rule.memory.no_truth_claim", "error", "Memory candidates must remain fallible evidence with confidence and staleness.", "repair_once", true),
      rule("contract.rule.memory.no_hidden_coordinates", "error", "Memory writes must not include backend coordinates, object IDs, or simulator flags.", "reject", false),
    ],
  ),
  seed(
    "MonologueResponse",
    "InternalMonologueReasoning",
    false,
    "tts_filter",
    true,
    [
      field("speech_text", "required", "string", "Short TTS-ready statement.", "Must meet length, safety, and hidden-data filters."),
      field("action_summary", "required", "string", "One-sentence summary of intended validated action.", "Must match current validated plan."),
      field("evidence_summary", "required", "string", "Short public reason based on visible evidence or validator status.", "Must not include hidden reasoning."),
      field("uncertainty_phrase", "conditional", "string", "Brief uncertainty phrase when re-observing or acting cautiously.", "Required when confidence is not high."),
      field("interrupt_policy", "required", "enum", "Whether speech may be interrupted by safety or execution events.", "Must allow safety interruption.", ["safety_interruptible", "execution_interruptible", "silent"]),
      field("do_not_say", "optional", "array", "Terms or facts explicitly excluded from speech.", "Used by TTS filter."),
    ],
    [
      rule("contract.rule.monologue.public_only", "error", "Monologue must be public rationale, never hidden chain-of-thought.", "reject", false),
      rule("contract.rule.monologue.safety_interruptible", "error", "Monologue must allow safety interruption.", "repair_once", true),
    ],
  ),
]);

for (const contractRef of ALL_CONTRACT_REFS) {
  if (CONTRACT_ID_PATTERN.test(contractRef) === false) {
    throw new Error(`Invalid structured output contract ref: ${contractRef}`);
  }
}

if (GEMINI_ROBOTICS_ER_OUTPUT_TOKEN_LIMIT < 8192) {
  throw new Error("Structured output registry expects Robotics-ER output capacity for long structured plans.");
}

export const STRUCTURED_OUTPUT_CONTRACT_REGISTRY_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: STRUCTURED_OUTPUT_CONTRACT_REGISTRY_SCHEMA_VERSION,
  blueprint: "architecture_docs/06_GEMINI_ROBOTICS_ER_COGNITIVE_LAYER.md",
  companion_blueprint: "architecture_docs/07_PROMPT_CONTRACTS_AND_STRUCTURED_OUTPUTS.md",
  sections: freezeArray(["6.6.1", "6.6.2", "6.7.1", "6.11", "6.12.1", "6.18.1", "6.19", "6.20", "7.6", "7.7", "7.9-7.19"]),
});
