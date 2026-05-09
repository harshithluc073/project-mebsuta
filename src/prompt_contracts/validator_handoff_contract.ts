/**
 * Validator handoff contract for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/07_PROMPT_CONTRACTS_AND_STRUCTURED_OUTPUTS.md`
 * sections 7.3, 7.6, 7.7, 7.19, 7.20, 7.23, and 7.24.
 *
 * This module implements the executable `ValidatorHandoffContract`. It turns a
 * structured Gemini Robotics-ER response into a deterministic downstream
 * validator packet containing action intent, object hypotheses, spatial targets,
 * embodiment requirements, safety notes, confidence and uncertainty metadata,
 * required validators, and failure recovery hints. The packet is a proposal
 * handoff only; it never grants the model execution authority.
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
import {
  STRUCTURED_RESPONSE_CONTRACT_VERSION,
} from "./structured_response_contract";
import type {
  StructuredConfidenceValue,
  StructuredResponseContractRef,
  StructuredResponseEnvelope,
  StructuredUncertaintyCategory,
  StructuredUncertaintyEntry,
} from "./structured_response_contract";
import { UNCERTAINTY_REPORTING_CONTRACT_VERSION } from "./uncertainty_reporting_contract";

export const VALIDATOR_HANDOFF_CONTRACT_SCHEMA_VERSION = "mebsuta.validator_handoff_contract.v1" as const;
export const VALIDATOR_HANDOFF_CONTRACT_VERSION = "1.0.0" as const;
export const VALIDATOR_HANDOFF_CONTRACT_ID = "PROMPT-VALIDATOR-HANDOFF-001" as const;

const CONTRACT_TRACEABILITY_REF = "architecture_docs/07_PROMPT_CONTRACTS_AND_STRUCTURED_OUTPUTS.md#ValidatorHandoffContract" as const;
const VALIDATOR_HANDOFF_POLICY_VERSION = "deterministic_validator_handoff_v1" as const;
const FORBIDDEN_HANDOFF_CONTENT_PATTERN = /(mujoco|babylon|backend|engine|scene_graph|world_truth|ground_truth|qa_|collision_mesh|segmentation truth|debug buffer|simulator|physics_body|rigid_body_handle|joint_handle|object_id|exact_com|world_pose|hidden pose|hidden state|system prompt|developer prompt|chain-of-thought|scratchpad|private deliberation|direct actuator|raw actuator|joint torque|joint current|set joint|apply force|apply impulse|physics step|reward policy|policy gradient|reinforcement learning|rl update|ignore validators|override safety|disable safe-hold|skip validation|without validation)/i;

export type ValidatorHandoffTarget = "validator_stack" | "verification_pipeline" | "memory_writer" | "tts_filter" | "safe_hold";
export type ValidatorHandoffDecision = "released" | "released_with_warnings" | "rejected" | "safe_hold_required";

export type RequiredValidatorKind =
  | "provenance"
  | "view_evidence"
  | "uncertainty_completeness"
  | "safety"
  | "no_rl"
  | "embodiment_compatibility"
  | "phase_completeness"
  | "geometry"
  | "reach"
  | "ik"
  | "collision"
  | "stability"
  | "controller_feasibility"
  | "view_synchronization"
  | "cross_view_evidence"
  | "ambiguity_handling"
  | "spatial_residual"
  | "multi_view_confidence"
  | "false_positive_prevention"
  | "retry_budget"
  | "changed_strategy"
  | "staleness"
  | "contradiction"
  | "privacy"
  | "verification_certificate"
  | "audio_confidence"
  | "audio_visual_reconciliation"
  | "tool_visibility"
  | "tool_affordance"
  | "tool_attachment"
  | "swept_volume"
  | "release"
  | "hidden_truth_filter"
  | "tts_length"
  | "safety_consistency"
  | "action_match";

export type ValidatorRequirementLevel = "mandatory" | "conditional";
export type ValidatorEvidenceSensitivity = "current_sensor_required" | "memory_allowed" | "validator_feedback_allowed" | "public_text_only";
export type SpatialTargetFrame = "object_relative" | "image_normalized" | "agent_estimated" | "body_relative" | "view_relative" | "unknown";

/**
 * Immutable validator policy metadata used by telemetry and regression tools.
 */
export interface ValidatorHandoffPolicyDescriptor {
  readonly schema_version: typeof VALIDATOR_HANDOFF_CONTRACT_SCHEMA_VERSION;
  readonly contract_id: typeof VALIDATOR_HANDOFF_CONTRACT_ID;
  readonly contract_version: typeof VALIDATOR_HANDOFF_CONTRACT_VERSION;
  readonly handoff_policy_version: typeof VALIDATOR_HANDOFF_POLICY_VERSION;
  readonly prompt_packet_contract_version: typeof COGNITIVE_PROMPT_PACKET_CONTRACT_VERSION;
  readonly structured_response_contract_version: typeof STRUCTURED_RESPONSE_CONTRACT_VERSION;
  readonly uncertainty_reporting_contract_version: typeof UNCERTAINTY_REPORTING_CONTRACT_VERSION;
  readonly model_profile_ref: typeof GEMINI_ROBOTICS_ER_APPROVED_MODEL;
  readonly input_firewall_ref: typeof COGNITIVE_PROMPT_FIREWALL_POLICY_REF;
  readonly output_validator_ref: typeof COGNITIVE_OUTPUT_VALIDATOR_POLICY_REF;
  readonly traceability_ref: typeof CONTRACT_TRACEABILITY_REF;
  readonly output_validator_matrix: readonly OutputValidatorPolicy[];
  readonly determinism_hash: string;
}

/**
 * Required validator bundle for one structured response contract.
 */
export interface OutputValidatorPolicy {
  readonly contract_ref: StructuredResponseContractRef;
  readonly invocation_class: CognitiveInvocationClass;
  readonly target: ValidatorHandoffTarget;
  readonly action_bearing: boolean;
  readonly mandatory_validators: readonly RequiredValidatorKind[];
  readonly conditional_validators: readonly RequiredValidatorKind[];
}

/**
 * Prompt-safe visible object hypothesis copied into the downstream handoff.
 */
export interface HandoffObjectHypothesis {
  readonly object_ref: Ref;
  readonly label: string;
  readonly evidence_refs: readonly Ref[];
  readonly confidence?: StructuredConfidenceValue;
  readonly ambiguity_notes: readonly string[];
}

/**
 * Spatial target candidate expressed only in validator-consumable public frames.
 */
export interface SpatialTargetCandidate {
  readonly target_ref: Ref;
  readonly frame: SpatialTargetFrame;
  readonly description: string;
  readonly evidence_refs: readonly Ref[];
  readonly relation?: string;
  readonly tolerance_hint?: string;
  readonly uncertainty_categories: readonly StructuredUncertaintyCategory[];
}

/**
 * Embodiment capability or stance requirement that validators must check.
 */
export interface EmbodimentRequirement {
  readonly requirement_ref: Ref;
  readonly requirement_kind: "body" | "stance" | "end_effector" | "tool_attachment" | "reach_mode" | "controller_mode";
  readonly description: string;
  readonly evidence_refs: readonly Ref[];
  readonly mandatory: boolean;
}

/**
 * One validator invocation requirement with evidence expectations and rationale.
 */
export interface ValidatorRequirement {
  readonly validator_ref: Ref;
  readonly kind: RequiredValidatorKind;
  readonly level: ValidatorRequirementLevel;
  readonly target: ValidatorHandoffTarget;
  readonly evidence_sensitivity: ValidatorEvidenceSensitivity;
  readonly rationale: string;
}

/**
 * Confidence and ambiguity payload consumed by orchestrator thresholding.
 */
export interface HandoffConfidenceAndUncertainty {
  readonly confidence: StructuredConfidenceValue;
  readonly rationale: string;
  readonly uncertainty_categories: readonly StructuredUncertaintyCategory[];
  readonly uncertainties: readonly StructuredUncertaintyEntry[];
  readonly reobserve_required: boolean;
}

/**
 * Deterministic packet released to validator, memory, verification, or TTS gates.
 */
export interface ValidatorHandoffPacket {
  readonly schema_version: typeof VALIDATOR_HANDOFF_CONTRACT_SCHEMA_VERSION;
  readonly handoff_ref: Ref;
  readonly source_response_ref: Ref;
  readonly target: ValidatorHandoffTarget;
  readonly response_contract_ref: StructuredResponseContractRef;
  readonly task_state_ref: Ref;
  readonly action_intent?: string;
  readonly object_hypotheses: readonly HandoffObjectHypothesis[];
  readonly spatial_targets: readonly SpatialTargetCandidate[];
  readonly constraints: readonly string[];
  readonly embodiment_requirements: readonly EmbodimentRequirement[];
  readonly safety_notes: readonly string[];
  readonly confidence_and_uncertainty: HandoffConfidenceAndUncertainty;
  readonly required_validators: readonly ValidatorRequirement[];
  readonly failure_recovery_hint?: string;
  readonly determinism_hash: string;
}

/**
 * Request accepted by `extractValidatorHandoff`.
 */
export interface ValidatorHandoffExtractionRequest {
  readonly response_ref: Ref;
  readonly invocation_class: CognitiveInvocationClass;
  readonly expected_contract_ref: StructuredResponseContractRef;
  readonly payload: unknown;
  readonly downstream_target?: ValidatorHandoffTarget;
  readonly stale_task_state_refs?: readonly Ref[];
}

/**
 * Extraction and validation report for one handoff packet.
 */
export interface ValidatorHandoffReport {
  readonly schema_version: typeof VALIDATOR_HANDOFF_CONTRACT_SCHEMA_VERSION;
  readonly decision: ValidatorHandoffDecision;
  readonly source_response_ref: Ref;
  readonly expected_contract_ref: StructuredResponseContractRef;
  readonly target: ValidatorHandoffTarget;
  readonly packet?: ValidatorHandoffPacket;
  readonly missing_required_validators: readonly RequiredValidatorKind[];
  readonly safe_hold_required: boolean;
  readonly reobserve_required: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

/**
 * Extracts deterministic validator handoff packets from already structured
 * response envelopes. The contract preserves model proposals as bounded inputs
 * to deterministic validators and rejects any action-bearing response that
 * omits validation, safety notes, or contract-mandated validator categories.
 */
export class ValidatorHandoffContract {
  private readonly descriptor: ValidatorHandoffPolicyDescriptor;
  private readonly policiesByContract: Readonly<Record<StructuredResponseContractRef, OutputValidatorPolicy>>;

  public constructor(policies: readonly OutputValidatorPolicy[] = DEFAULT_OUTPUT_VALIDATOR_POLICIES) {
    this.policiesByContract = indexPolicies(policies);
    this.descriptor = buildDescriptor(Object.values(this.policiesByContract));
  }

  /**
   * Returns immutable contract metadata for telemetry and architecture audits.
   */
  public getDescriptor(): ValidatorHandoffPolicyDescriptor {
    return this.descriptor;
  }

  /**
   * Builds and validates a downstream handoff packet from a structured response.
   */
  public extractValidatorHandoff(request: ValidatorHandoffExtractionRequest): ValidatorHandoffReport {
    const issues: ValidationIssue[] = [];
    validateRef(request.response_ref, "$.response_ref", issues);
    const policy = this.policiesByContract[request.expected_contract_ref];
    if (policy.invocation_class !== request.invocation_class) {
      issues.push(issue("error", "InvocationContractMismatch", "$.invocation_class", "Validator handoff contract does not belong to this invocation class.", "Use the structured-response contract selected by the request router."));
    }
    if (!isStructuredResponseEnvelope(request.payload)) {
      issues.push(issue("error", "ResponseEnvelopeInvalid", "$.payload", "Validator handoff requires a structured response envelope.", "Run structured response validation or repair before handoff extraction."));
      return makeReport(request.response_ref, request.expected_contract_ref, request.downstream_target ?? policy.target, undefined, [], true, false, issues);
    }

    const envelope = request.payload;
    validateEnvelopeIdentity(envelope, request, policy, issues);
    const staleRefs = request.stale_task_state_refs ?? [];
    if (staleRefs.includes(envelope.task_state_ref)) {
      issues.push(issue("error", "TaskStateStale", "$.task_state_ref", "Response task state is marked stale for downstream validation.", "Replan or re-observe against the current task state before handoff."));
    }

    const target = request.downstream_target ?? policy.target;
    const packet = buildPacket(request.response_ref, target, policy, envelope);
    const packetIssues = validateHandoffPacket(packet, policy);
    issues.push(...packetIssues);
    const missingRequiredValidators = findMissingMandatoryValidators(packet, policy);
    for (const missing of missingRequiredValidators) {
      issues.push(issue("error", "RequiredValidatorMissing", "$.required_validators", `Validator handoff is missing mandatory validator ${missing}.`, "Restore the output-type validator set from the blueprint matrix."));
    }

    if (policy.action_bearing && envelope.requires_validation !== true) {
      issues.push(issue("error", "ActionResponseWithoutValidation", "$.requires_validation", "Action-bearing responses must require deterministic validation before execution.", "Set requires_validation to true and route through validator handoff."));
    }
    if (policy.action_bearing && packet.safety_notes.length === 0) {
      issues.push(issue("error", "SafetyNotesMissing", "$.safety_notes", "Action-bearing handoff requires safety notes.", "State collision, reach, force, visibility, or safe-hold checks for deterministic validators."));
    }

    const reobserveRequired = packet.confidence_and_uncertainty.reobserve_required;
    const safeHoldRequired = shouldSafeHold(policy, packet, issues);
    return makeReport(request.response_ref, request.expected_contract_ref, target, packet, missingRequiredValidators, safeHoldRequired, reobserveRequired, issues);
  }
}

function validateEnvelopeIdentity(
  envelope: StructuredResponseEnvelope,
  request: ValidatorHandoffExtractionRequest,
  policy: OutputValidatorPolicy,
  issues: ValidationIssue[],
): void {
  if (envelope.response_contract_id !== request.expected_contract_ref || envelope.response_contract_id !== policy.contract_ref) {
    issues.push(issue("error", "ResponseContractMismatch", "$.response_contract_id", "Response contract does not match the requested handoff contract.", `Use ${request.expected_contract_ref}.`));
  }
  if (envelope.contract_version_ack !== STRUCTURED_RESPONSE_CONTRACT_VERSION) {
    issues.push(issue("warning", "ContractVersionAckMismatch", "$.contract_version_ack", "Response did not acknowledge the current structured response version.", `Acknowledge ${STRUCTURED_RESPONSE_CONTRACT_VERSION}.`));
  }
  if (envelope.forbidden_content_absent !== true) {
    issues.push(issue("error", "ForbiddenContentAssertionFailed", "$.forbidden_content_absent", "Response did not assert that forbidden content is absent.", "Reject or repair before validator handoff."));
  }
  validateRef(envelope.task_state_ref, "$.task_state_ref", issues);
}

function buildPacket(
  sourceResponseRef: Ref,
  target: ValidatorHandoffTarget,
  policy: OutputValidatorPolicy,
  envelope: StructuredResponseEnvelope,
): ValidatorHandoffPacket {
  const evidenceRefs = envelope.evidence_used.map((citation) => citation.evidence_ref);
  const primary = envelope.primary_result;
  const confidenceAndUncertainty = buildConfidenceAndUncertainty(envelope);
  const base = {
    schema_version: VALIDATOR_HANDOFF_CONTRACT_SCHEMA_VERSION,
    source_response_ref: sourceResponseRef,
    target,
    response_contract_ref: envelope.response_contract_id,
    task_state_ref: envelope.task_state_ref,
    action_intent: extractActionIntent(envelope.response_contract_id, primary),
    object_hypotheses: extractObjectHypotheses(envelope.response_contract_id, primary, evidenceRefs, envelope.confidence.value),
    spatial_targets: extractSpatialTargets(envelope.response_contract_id, primary, evidenceRefs, confidenceAndUncertainty.uncertainty_categories),
    constraints: extractConstraints(envelope.response_contract_id, primary, envelope.safety_notes),
    embodiment_requirements: extractEmbodimentRequirements(envelope.response_contract_id, primary, evidenceRefs),
    safety_notes: freezeArray([...envelope.safety_notes, ...extractRiskNotes(primary)]),
    confidence_and_uncertainty: confidenceAndUncertainty,
    required_validators: buildValidatorRequirements(policy, primary),
    failure_recovery_hint: extractFailureRecoveryHint(envelope, primary),
  };
  const hashBase = { ...base, required_validators: base.required_validators.map((validator) => validator.kind) };
  const handoffRef = `validator_handoff_${computeDeterminismHash(hashBase).slice(0, 16)}`;
  const fullBase = {
    ...base,
    handoff_ref: handoffRef,
  };
  return Object.freeze({
    ...fullBase,
    determinism_hash: computeDeterminismHash(fullBase),
  });
}

function buildConfidenceAndUncertainty(envelope: StructuredResponseEnvelope): HandoffConfidenceAndUncertainty {
  const categories = freezeArray([...new Set(envelope.uncertainties.map((entry) => entry.category))]);
  return Object.freeze({
    confidence: envelope.confidence.value,
    rationale: envelope.confidence.rationale,
    uncertainty_categories: categories,
    uncertainties: freezeArray(envelope.uncertainties),
    reobserve_required: envelope.uncertainties.some((entry) => entry.requires_reobserve) || envelope.confidence.value === "very_low" || envelope.confidence.value === "low" || envelope.reobserve_request !== undefined,
  });
}

function extractActionIntent(contractRef: StructuredResponseContractRef, primary: Readonly<Record<string, unknown>>): string | undefined {
  const orderedKeys = actionIntentKeysFor(contractRef);
  for (const key of orderedKeys) {
    const text = summarizeUnknown(primary[key]);
    if (text !== undefined) {
      return text;
    }
  }
  return undefined;
}

function extractObjectHypotheses(
  contractRef: StructuredResponseContractRef,
  primary: Readonly<Record<string, unknown>>,
  fallbackEvidenceRefs: readonly Ref[],
  confidence: StructuredConfidenceValue,
): readonly HandoffObjectHypothesis[] {
  const candidates: HandoffObjectHypothesis[] = [];
  const keys = objectHypothesisKeysFor(contractRef);
  for (const key of keys) {
    const value = primary[key];
    for (const [index, item] of normalizeCollection(value).entries()) {
      const label = labelFromUnknown(item) ?? `${key}_${index}`;
      candidates.push(Object.freeze({
        object_ref: `object_hypothesis_${computeDeterminismHash({ key, index, label }).slice(0, 12)}`,
        label,
        evidence_refs: evidenceRefsFromUnknown(item, fallbackEvidenceRefs),
        confidence,
        ambiguity_notes: ambiguityNotesFromUnknown(item),
      }));
    }
  }
  return freezeArray(uniqueByRef(candidates, (item) => item.object_ref));
}

function extractSpatialTargets(
  contractRef: StructuredResponseContractRef,
  primary: Readonly<Record<string, unknown>>,
  fallbackEvidenceRefs: readonly Ref[],
  uncertaintyCategories: readonly StructuredUncertaintyCategory[],
): readonly SpatialTargetCandidate[] {
  const targets: SpatialTargetCandidate[] = [];
  for (const key of spatialTargetKeysFor(contractRef)) {
    for (const [index, item] of normalizeCollection(primary[key]).entries()) {
      const description = summarizeUnknown(item) ?? `${key}_${index}`;
      const relation = relationFromUnknown(item);
      targets.push(Object.freeze({
        target_ref: `spatial_target_${computeDeterminismHash({ key, index, description, relation }).slice(0, 12)}`,
        frame: frameFromUnknown(item),
        description,
        evidence_refs: evidenceRefsFromUnknown(item, fallbackEvidenceRefs),
        relation,
        tolerance_hint: toleranceFromUnknown(item),
        uncertainty_categories: freezeArray(uncertaintyCategories),
      }));
    }
  }
  return freezeArray(uniqueByRef(targets, (item) => item.target_ref));
}

function extractConstraints(contractRef: StructuredResponseContractRef, primary: Readonly<Record<string, unknown>>, safetyNotes: readonly string[]): readonly string[] {
  const constraints: string[] = [];
  for (const key of constraintKeysFor(contractRef)) {
    for (const item of normalizeCollection(primary[key])) {
      const text = summarizeUnknown(item);
      if (text !== undefined) {
        constraints.push(text);
      }
    }
  }
  constraints.push(...safetyNotes.map((note) => `safety_note:${note}`));
  return freezeArray(uniqueStrings(constraints));
}

function extractEmbodimentRequirements(contractRef: StructuredResponseContractRef, primary: Readonly<Record<string, unknown>>, evidenceRefs: readonly Ref[]): readonly EmbodimentRequirement[] {
  const requirements: EmbodimentRequirement[] = [];
  for (const key of embodimentKeysFor(contractRef)) {
    for (const [index, item] of normalizeCollection(primary[key]).entries()) {
      const description = summarizeUnknown(item);
      if (description === undefined) {
        continue;
      }
      requirements.push(Object.freeze({
        requirement_ref: `embodiment_requirement_${computeDeterminismHash({ key, index, description }).slice(0, 12)}`,
        requirement_kind: embodimentKindFromKey(key, item),
        description,
        evidence_refs: evidenceRefsFromUnknown(item, evidenceRefs),
        mandatory: true,
      }));
    }
  }
  return freezeArray(uniqueByRef(requirements, (item) => item.requirement_ref));
}

function extractRiskNotes(primary: Readonly<Record<string, unknown>>): readonly string[] {
  const risks: string[] = [];
  for (const key of ["risk_notes", "swept_volume_concerns", "safety_relevant_observations", "safety_relevance"]) {
    for (const item of normalizeCollection(primary[key])) {
      const text = summarizeUnknown(item);
      if (text !== undefined) {
        risks.push(text);
      }
    }
  }
  return freezeArray(uniqueStrings(risks));
}

function buildValidatorRequirements(policy: OutputValidatorPolicy, primary: Readonly<Record<string, unknown>>): readonly ValidatorRequirement[] {
  const modelSuggested = parseModelSuggestedValidators(primary.validator_handoff ?? primary.validation_checkpoints ?? primary.new_validation_requirements ?? primary.verification_plan);
  const mandatory = [...policy.mandatory_validators, ...modelSuggested.filter((kind) => policy.mandatory_validators.includes(kind) === false && policy.conditional_validators.includes(kind) === false)];
  const requirements = [
    ...mandatory.map((kind) => makeValidatorRequirement(kind, "mandatory", policy.target)),
    ...policy.conditional_validators.map((kind) => makeValidatorRequirement(kind, "conditional", policy.target)),
  ];
  return freezeArray(uniqueByRef(requirements, (item) => item.validator_ref));
}

function makeValidatorRequirement(kind: RequiredValidatorKind, level: ValidatorRequirementLevel, target: ValidatorHandoffTarget): ValidatorRequirement {
  const base = {
    kind,
    level,
    target,
    evidence_sensitivity: evidenceSensitivityFor(kind),
    rationale: rationaleForValidator(kind),
  };
  return Object.freeze({
    validator_ref: `validator_${kind}`,
    ...base,
  });
}

function parseModelSuggestedValidators(value: unknown): readonly RequiredValidatorKind[] {
  const parsed: RequiredValidatorKind[] = [];
  for (const item of normalizeCollection(value)) {
    const raw = summarizeUnknown(item)?.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    const mapped = mapValidatorAlias(raw);
    if (mapped !== undefined) {
      parsed.push(mapped);
    }
  }
  return freezeArray(uniqueStrings(parsed) as RequiredValidatorKind[]);
}

function extractFailureRecoveryHint(envelope: StructuredResponseEnvelope, primary: Readonly<Record<string, unknown>>): string | undefined {
  const direct = summarizeUnknown(primary.fallback_strategy ?? primary.escalation_recommendation ?? primary.reject_tool_use_reason ?? primary.recommended_next_view ?? primary.oops_loop_trigger_suggestion);
  if (direct !== undefined) {
    return direct;
  }
  if (envelope.reobserve_request !== undefined) {
    return `reobserve:${envelope.reobserve_request.reason}; requested=${envelope.reobserve_request.requested_evidence.join(",")}`;
  }
  if (envelope.confidence.value === "very_low" || envelope.confidence.value === "low") {
    return "safe_hold_or_reobserve_before_retry";
  }
  return undefined;
}

function validateHandoffPacket(packet: ValidatorHandoffPacket, policy: OutputValidatorPolicy): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateRef(packet.handoff_ref, "$.handoff_ref", issues);
  validateRef(packet.source_response_ref, "$.source_response_ref", issues);
  validateRef(packet.task_state_ref, "$.task_state_ref", issues);
  if (packet.target !== policy.target && packet.target !== "safe_hold") {
    issues.push(issue("warning", "HandoffTargetOverride", "$.target", "Handoff target differs from the default output-type target.", "Verify downstream policy override before routing."));
  }
  validatePromptSafePayload(packet, "$.packet", issues);
  if (policy.action_bearing && packet.action_intent === undefined) {
    issues.push(issue("error", "ActionIntentMissing", "$.action_intent", "Action-bearing handoff requires a high-level action intent.", "Extract an action or plan intent from primary_result."));
  }
  if (policy.action_bearing && packet.required_validators.length === 0) {
    issues.push(issue("error", "RequiredValidatorsEmpty", "$.required_validators", "Action-bearing handoff requires downstream validators.", "Attach the validator matrix for this output type."));
  }
  if ((packet.confidence_and_uncertainty.confidence === "very_low" || packet.confidence_and_uncertainty.confidence === "low") && packet.failure_recovery_hint === undefined) {
    issues.push(issue("error", "LowConfidenceRecoveryMissing", "$.failure_recovery_hint", "Low-confidence handoff requires re-observe or recovery guidance.", "Provide a reobserve request, safe-hold hint, or correction route."));
  }
  return freezeArray(issues);
}

function findMissingMandatoryValidators(packet: ValidatorHandoffPacket, policy: OutputValidatorPolicy): readonly RequiredValidatorKind[] {
  const actual = new Set(packet.required_validators.filter((item) => item.level === "mandatory").map((item) => item.kind));
  return freezeArray(policy.mandatory_validators.filter((kind) => actual.has(kind) === false));
}

function shouldSafeHold(policy: OutputValidatorPolicy, packet: ValidatorHandoffPacket, issues: readonly ValidationIssue[]): boolean {
  if (issues.some((item) => item.severity === "error")) {
    return policy.action_bearing;
  }
  if (policy.action_bearing && (packet.confidence_and_uncertainty.confidence === "very_low" || packet.confidence_and_uncertainty.confidence === "low")) {
    return true;
  }
  return packet.confidence_and_uncertainty.uncertainty_categories.includes("safety_uncertainty") && packet.safety_notes.length === 0;
}

function makeReport(
  responseRef: Ref,
  contractRef: StructuredResponseContractRef,
  target: ValidatorHandoffTarget,
  packet: ValidatorHandoffPacket | undefined,
  missingRequiredValidators: readonly RequiredValidatorKind[],
  safeHoldRequired: boolean,
  reobserveRequired: boolean,
  issues: readonly ValidationIssue[],
): ValidatorHandoffReport {
  const hasErrors = issues.some((item) => item.severity === "error");
  const decision: ValidatorHandoffDecision = safeHoldRequired
    ? "safe_hold_required"
    : hasErrors
      ? "rejected"
      : issues.length > 0
        ? "released_with_warnings"
        : "released";
  const base = {
    schema_version: VALIDATOR_HANDOFF_CONTRACT_SCHEMA_VERSION,
    decision,
    source_response_ref: responseRef,
    expected_contract_ref: contractRef,
    target,
    packet: hasErrors && packet === undefined ? undefined : packet,
    missing_required_validators: freezeArray(missingRequiredValidators),
    safe_hold_required: safeHoldRequired,
    reobserve_required: reobserveRequired,
    issues: freezeArray(issues),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function actionIntentKeysFor(contractRef: StructuredResponseContractRef): readonly string[] {
  switch (contractRef) {
    case "TaskPlanResponse":
      return freezeArray(["task_interpretation", "ordered_phases", "requires_waypoint_generation"]);
    case "WaypointPlanResponse":
      return freezeArray(["waypoint_intent", "target_relation", "candidate_waypoints"]);
    case "CorrectionPlanResponse":
      return freezeArray(["immediate_safety_action", "corrective_strategy", "failure_summary"]);
    case "ToolUsePlanResponse":
      return freezeArray(["tool_action_plan", "selected_tool_rationale", "reach_limitation_summary"]);
    case "AudioActionResponse":
      return freezeArray(["recommended_action", "audio_event_interpretation"]);
    case "MonologueResponse":
      return freezeArray(["action_summary", "speech_text"]);
    default:
      return freezeArray(["target_constraint_summary", "constraint_status", "planning_readiness", "write_readiness", "episode_summary"]);
  }
}

function objectHypothesisKeysFor(contractRef: StructuredResponseContractRef): readonly string[] {
  switch (contractRef) {
    case "SceneUnderstandingResponse":
      return freezeArray(["visible_object_hypotheses", "affordance_hypotheses"]);
    case "TaskPlanResponse":
      return freezeArray(["object_roles"]);
    case "MultiViewConsensusResponse":
      return freezeArray(["consensus_objects", "conflicting_hypotheses"]);
    case "ToolUsePlanResponse":
      return freezeArray(["tool_candidates"]);
    case "MemoryWriteCandidateResponse":
      return freezeArray(["object_memory_candidates"]);
    default:
      return freezeArray(["visible_object_hypotheses", "object_roles", "tool_candidates"]);
  }
}

function spatialTargetKeysFor(contractRef: StructuredResponseContractRef): readonly string[] {
  switch (contractRef) {
    case "WaypointPlanResponse":
      return freezeArray(["target_relation", "candidate_waypoints", "tolerances"]);
    case "TaskPlanResponse":
      return freezeArray(["spatial_constraints", "ordered_phases"]);
    case "VisualVerificationResponse":
      return freezeArray(["target_constraint_summary", "residual_hint"]);
    case "MemoryWriteCandidateResponse":
      return freezeArray(["spatial_memory_candidates"]);
    case "ToolUsePlanResponse":
      return freezeArray(["tool_attachment_plan", "tool_action_plan", "release_and_retreat_plan"]);
    default:
      return freezeArray(["spatial_attention_points", "object_relationships", "pose_confidence"]);
  }
}

function constraintKeysFor(contractRef: StructuredResponseContractRef): readonly string[] {
  switch (contractRef) {
    case "TaskPlanResponse":
      return freezeArray(["spatial_constraints", "validation_checkpoints", "assumptions"]);
    case "WaypointPlanResponse":
      return freezeArray(["preconditions", "postconditions", "tolerances", "risk_notes"]);
    case "CorrectionPlanResponse":
      return freezeArray(["new_validation_requirements", "changed_assumptions"]);
    case "ToolUsePlanResponse":
      return freezeArray(["verification_plan", "swept_volume_concerns", "release_and_retreat_plan"]);
    default:
      return freezeArray(["constraints", "needed_additional_evidence", "do_not_say"]);
  }
}

function embodimentKeysFor(contractRef: StructuredResponseContractRef): readonly string[] {
  switch (contractRef) {
    case "TaskPlanResponse":
      return freezeArray(["embodiment_considerations"]);
    case "WaypointPlanResponse":
      return freezeArray(["preconditions", "candidate_waypoints"]);
    case "CorrectionPlanResponse":
      return freezeArray(["immediate_safety_action", "new_validation_requirements"]);
    case "ToolUsePlanResponse":
      return freezeArray(["tool_attachment_plan", "tool_action_plan", "reach_limitation_summary"]);
    default:
      return freezeArray(["embodiment_requirements"]);
  }
}

function normalizeCollection(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) {
    return freezeArray(value);
  }
  if (value === undefined || value === null) {
    return freezeArray([]);
  }
  return freezeArray([value]);
}

function summarizeUnknown(value: unknown): string | undefined {
  if (typeof value === "string") {
    const text = value.trim();
    return text.length === 0 ? undefined : text;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (isRecord(value)) {
    for (const key of ["intent", "action", "summary", "description", "label", "name", "relation", "status", "reason", "text", "waypoint_intent"]) {
      const nested = summarizeUnknown(value[key]);
      if (nested !== undefined) {
        return nested;
      }
    }
    return compactJson(value);
  }
  return undefined;
}

function compactJson(value: unknown): string | undefined {
  try {
    const raw = JSON.stringify(value);
    if (raw === undefined || raw === "{}" || raw === "[]") {
      return undefined;
    }
    return raw.length > 420 ? `${raw.slice(0, 417)}...` : raw;
  } catch {
    return undefined;
  }
}

function labelFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim().length === 0 ? undefined : value.trim();
  }
  if (isRecord(value)) {
    return summarizeUnknown(value.label ?? value.name ?? value.object_label ?? value.role ?? value.tool_label ?? value.summary);
  }
  return undefined;
}

function evidenceRefsFromUnknown(value: unknown, fallbackRefs: readonly Ref[]): readonly Ref[] {
  if (isRecord(value)) {
    for (const key of ["evidence_refs", "reference_evidence", "source_refs", "view_refs"]) {
      const refs = arrayOfRefs(value[key]);
      if (refs.length > 0) {
        return refs;
      }
    }
  }
  return freezeArray(fallbackRefs);
}

function arrayOfRefs(value: unknown): readonly Ref[] {
  if (!Array.isArray(value)) {
    return freezeArray([]);
  }
  return freezeArray(value.filter((item): item is Ref => typeof item === "string" && item.trim().length > 0));
}

function ambiguityNotesFromUnknown(value: unknown): readonly string[] {
  if (!isRecord(value)) {
    return freezeArray([]);
  }
  const notes: string[] = [];
  for (const key of ["ambiguity_notes", "uncertainty", "uncertainty_notes", "conflicts", "occlusion"]) {
    for (const item of normalizeCollection(value[key])) {
      const text = summarizeUnknown(item);
      if (text !== undefined) {
        notes.push(text);
      }
    }
  }
  return freezeArray(uniqueStrings(notes));
}

function relationFromUnknown(value: unknown): string | undefined {
  if (isRecord(value)) {
    return summarizeUnknown(value.relation ?? value.target_relation ?? value.constraint ?? value.approach_side);
  }
  return undefined;
}

function toleranceFromUnknown(value: unknown): string | undefined {
  if (isRecord(value)) {
    return summarizeUnknown(value.tolerance ?? value.tolerances ?? value.tolerance_hint);
  }
  return undefined;
}

function frameFromUnknown(value: unknown): SpatialTargetFrame {
  const raw = isRecord(value) ? summarizeUnknown(value.frame ?? value.frame_ref ?? value.coordinate_frame ?? value.target_frame) : undefined;
  if (raw === undefined) {
    return "unknown";
  }
  const normalized = raw.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (normalized.includes("object")) {
    return "object_relative";
  }
  if (normalized.includes("image") || normalized.includes("normalized")) {
    return "image_normalized";
  }
  if (normalized.includes("body") || normalized.includes("base") || normalized.includes("end_effector")) {
    return "body_relative";
  }
  if (normalized.includes("view") || normalized.includes("camera")) {
    return "view_relative";
  }
  if (normalized.includes("agent") || normalized.includes("estimated")) {
    return "agent_estimated";
  }
  return "unknown";
}

function embodimentKindFromKey(key: string, value: unknown): EmbodimentRequirement["requirement_kind"] {
  const raw = `${key} ${summarizeUnknown(value) ?? ""}`.toLowerCase();
  if (raw.includes("tool") || raw.includes("attachment")) {
    return "tool_attachment";
  }
  if (raw.includes("gripper") || raw.includes("hand") || raw.includes("mouth") || raw.includes("end effector")) {
    return "end_effector";
  }
  if (raw.includes("stance") || raw.includes("balance") || raw.includes("support")) {
    return "stance";
  }
  if (raw.includes("reach")) {
    return "reach_mode";
  }
  if (raw.includes("controller") || raw.includes("waypoint")) {
    return "controller_mode";
  }
  return "body";
}

function evidenceSensitivityFor(kind: RequiredValidatorKind): ValidatorEvidenceSensitivity {
  if (kind === "staleness" || kind === "contradiction" || kind === "verification_certificate") {
    return "memory_allowed";
  }
  if (kind === "hidden_truth_filter" || kind === "tts_length" || kind === "action_match") {
    return "public_text_only";
  }
  if (kind === "retry_budget" || kind === "changed_strategy") {
    return "validator_feedback_allowed";
  }
  return "current_sensor_required";
}

function rationaleForValidator(kind: RequiredValidatorKind): string {
  switch (kind) {
    case "provenance":
      return "Checks that claims trace to prompt-safe sensor, task, memory, or validator evidence.";
    case "view_evidence":
      return "Checks that view-specific evidence supports the handoff claim.";
    case "uncertainty_completeness":
      return "Checks that confidence and ambiguity categories are complete before routing.";
    case "safety":
      return "Checks force, collision, visibility, and safe-hold constraints before action.";
    case "no_rl":
      return "Checks that the response remains symbolic and contains no learned policy update.";
    case "embodiment_compatibility":
      return "Checks body, stance, reach mode, and end-effector capability compatibility.";
    case "phase_completeness":
      return "Checks that planned phases have preconditions, checkpoints, and fallbacks.";
    case "geometry":
      return "Checks object-relative, view-relative, or body-relative geometry consistency.";
    case "reach":
      return "Checks reachable zones for the body, tool, and candidate target.";
    case "ik":
      return "Checks inverse-kinematic feasibility before controller handoff.";
    case "collision":
      return "Checks static and swept collision risk before motion.";
    case "stability":
      return "Checks stance, support, and balance feasibility.";
    case "controller_feasibility":
      return "Checks whether the candidate can be represented by supported controllers.";
    case "view_synchronization":
      return "Checks that multi-view evidence belongs to a compatible observation window.";
    case "cross_view_evidence":
      return "Checks that objects or relations are supported across views.";
    case "ambiguity_handling":
      return "Checks that conflicting or ambiguous hypotheses remain explicit.";
    case "spatial_residual":
      return "Checks residuals for visual or geometric task success.";
    case "multi_view_confidence":
      return "Checks confidence consistency across visual evidence.";
    case "false_positive_prevention":
      return "Checks that success claims are not based on weak or one-sided evidence.";
    case "retry_budget":
      return "Checks bounded retry count before correction or repair.";
    case "changed_strategy":
      return "Checks that a correction meaningfully changes the failed strategy.";
    case "staleness":
      return "Checks memory freshness before writing or planning from memory.";
    case "contradiction":
      return "Checks memory and current evidence contradictions.";
    case "privacy":
      return "Checks that memory writes do not persist unsafe or private content.";
    case "verification_certificate":
      return "Checks final verification evidence before durable memory write.";
    case "audio_confidence":
      return "Checks sound classification, direction, and ambiguity.";
    case "audio_visual_reconciliation":
      return "Checks that audio action proposals are reconciled with visual evidence.";
    case "tool_visibility":
      return "Checks that candidate tools are currently visible or evidence-backed.";
    case "tool_affordance":
      return "Checks tool suitability for the proposed task.";
    case "tool_attachment":
      return "Checks attachment feasibility and release constraints.";
    case "swept_volume":
      return "Checks tool and body swept-volume hazards.";
    case "release":
      return "Checks safe release, retreat, and post-action verification.";
    case "hidden_truth_filter":
      return "Checks that public text contains no hidden implementation or simulator truth.";
    case "tts_length":
      return "Checks monologue length and interruption policy.";
    case "safety_consistency":
      return "Checks that speech and action summaries do not contradict safety policy.";
    case "action_match":
      return "Checks that public monologue matches the validated action or safe-hold state.";
  }
}

function mapValidatorAlias(value: string | undefined): RequiredValidatorKind | undefined {
  if (value === undefined) {
    return undefined;
  }
  const aliases: Readonly<Record<string, RequiredValidatorKind>> = {
    geometry: "geometry",
    spatial: "geometry",
    reach: "reach",
    ik: "ik",
    inverse_kinematics: "ik",
    collision: "collision",
    safety: "safety",
    stability: "stability",
    controller: "controller_feasibility",
    controller_feasibility: "controller_feasibility",
    no_rl: "no_rl",
    embodiment: "embodiment_compatibility",
    embodiment_compatibility: "embodiment_compatibility",
    phase: "phase_completeness",
    phase_completeness: "phase_completeness",
    tool_envelope: "swept_volume",
    swept_volume: "swept_volume",
    spatial_relation: "geometry",
    visual_evidence: "view_evidence",
    memory_provenance: "provenance",
    provenance: "provenance",
    audio_visual_reconciliation: "audio_visual_reconciliation",
    retry_budget: "retry_budget",
  };
  return aliases[value];
}

function validatePromptSafePayload(value: unknown, path: string, issues: ValidationIssue[]): void {
  const text = safeStringify(value);
  if (FORBIDDEN_HANDOFF_CONTENT_PATTERN.test(text)) {
    issues.push(issue("error", "ForbiddenHandoffContent", path, "Validator handoff contains simulator-truth, private reasoning, direct-control, or validator-bypass terminology.", "Sanitize the response and keep only prompt-safe symbolic proposals."));
  }
}

function isStructuredResponseEnvelope(value: unknown): value is StructuredResponseEnvelope {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.response_contract_id === "string"
    && typeof value.contract_version_ack === "string"
    && typeof value.task_state_ref === "string"
    && Array.isArray(value.evidence_used)
    && isRecord(value.primary_result)
    && isRecord(value.confidence)
    && isConfidenceValue(value.confidence.value)
    && typeof value.confidence.rationale === "string"
    && Array.isArray(value.uncertainties)
    && typeof value.requires_validation === "boolean"
    && Array.isArray(value.safety_notes)
    && value.safety_notes.every((item) => typeof item === "string")
    && typeof value.forbidden_content_absent === "boolean";
}

function isConfidenceValue(value: unknown): value is StructuredConfidenceValue {
  return typeof value === "string" && CONFIDENCE_VALUES.includes(value as StructuredConfidenceValue);
}

function validateRef(ref: Ref, path: string, issues: ValidationIssue[]): void {
  if (ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(issue("error", "ReferenceInvalid", path, "Reference must be non-empty and whitespace-free.", "Use a stable opaque reference."));
  }
  if (FORBIDDEN_HANDOFF_CONTENT_PATTERN.test(ref)) {
    issues.push(issue("error", "ReferenceContainsForbiddenContent", path, "Reference contains forbidden handoff-boundary terminology.", "Use prompt-safe opaque references."));
  }
}

function issue(severity: ValidationSeverity, code: string, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueStrings<T extends string>(items: readonly T[]): readonly T[] {
  return freezeArray([...new Set(items)]);
}

function uniqueByRef<T>(items: readonly T[], refFor: (item: T) => Ref): readonly T[] {
  const seen = new Set<Ref>();
  const unique: T[] = [];
  for (const item of items) {
    const ref = refFor(item);
    if (seen.has(ref)) {
      continue;
    }
    seen.add(ref);
    unique.push(item);
  }
  return freezeArray(unique);
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

function indexPolicies(policies: readonly OutputValidatorPolicy[]): Readonly<Record<StructuredResponseContractRef, OutputValidatorPolicy>> {
  const map = new Map<StructuredResponseContractRef, OutputValidatorPolicy>();
  for (const policy of policies) {
    map.set(policy.contract_ref, freezePolicy(policy));
  }
  const missing = ALL_CONTRACT_REFS.filter((contractRef) => map.has(contractRef) === false);
  if (missing.length > 0) {
    throw new Error(`ValidatorHandoffContract missing policies: ${missing.join(", ")}`);
  }
  return Object.freeze(Object.fromEntries(ALL_CONTRACT_REFS.map((contractRef) => [contractRef, map.get(contractRef) as OutputValidatorPolicy])) as Record<StructuredResponseContractRef, OutputValidatorPolicy>);
}

function freezePolicy(policy: OutputValidatorPolicy): OutputValidatorPolicy {
  return Object.freeze({
    ...policy,
    mandatory_validators: freezeArray(policy.mandatory_validators),
    conditional_validators: freezeArray(policy.conditional_validators),
  });
}

function buildDescriptor(policies: readonly OutputValidatorPolicy[]): ValidatorHandoffPolicyDescriptor {
  const base = {
    schema_version: VALIDATOR_HANDOFF_CONTRACT_SCHEMA_VERSION,
    contract_id: VALIDATOR_HANDOFF_CONTRACT_ID,
    contract_version: VALIDATOR_HANDOFF_CONTRACT_VERSION,
    handoff_policy_version: VALIDATOR_HANDOFF_POLICY_VERSION,
    prompt_packet_contract_version: COGNITIVE_PROMPT_PACKET_CONTRACT_VERSION,
    structured_response_contract_version: STRUCTURED_RESPONSE_CONTRACT_VERSION,
    uncertainty_reporting_contract_version: UNCERTAINTY_REPORTING_CONTRACT_VERSION,
    model_profile_ref: GEMINI_ROBOTICS_ER_APPROVED_MODEL,
    input_firewall_ref: COGNITIVE_PROMPT_FIREWALL_POLICY_REF,
    output_validator_ref: COGNITIVE_OUTPUT_VALIDATOR_POLICY_REF,
    traceability_ref: CONTRACT_TRACEABILITY_REF,
    output_validator_matrix: freezeArray(policies),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function makePolicy(
  contractRef: StructuredResponseContractRef,
  invocationClass: CognitiveInvocationClass,
  target: ValidatorHandoffTarget,
  actionBearing: boolean,
  mandatoryValidators: readonly RequiredValidatorKind[],
  conditionalValidators: readonly RequiredValidatorKind[] = [],
): OutputValidatorPolicy {
  return Object.freeze({
    contract_ref: contractRef,
    invocation_class: invocationClass,
    target,
    action_bearing: actionBearing,
    mandatory_validators: freezeArray(mandatoryValidators),
    conditional_validators: freezeArray(conditionalValidators),
  });
}

const CONFIDENCE_VALUES: readonly StructuredConfidenceValue[] = freezeArray(["very_low", "low", "medium", "high", "very_high"]);

const ALL_CONTRACT_REFS: readonly StructuredResponseContractRef[] = freezeArray([
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

const DEFAULT_OUTPUT_VALIDATOR_POLICIES: readonly OutputValidatorPolicy[] = freezeArray([
  makePolicy("SceneUnderstandingResponse", "SceneObservationReasoning", "verification_pipeline", false, ["provenance", "view_evidence", "uncertainty_completeness"], ["ambiguity_handling"]),
  makePolicy("TaskPlanResponse", "TaskPlanningReasoning", "validator_stack", true, ["safety", "no_rl", "embodiment_compatibility", "phase_completeness"], ["retry_budget", "provenance"]),
  makePolicy("WaypointPlanResponse", "WaypointGenerationReasoning", "validator_stack", true, ["geometry", "reach", "ik", "collision", "stability", "controller_feasibility"], ["view_evidence", "uncertainty_completeness"]),
  makePolicy("MultiViewConsensusResponse", "MultiViewDisambiguationReasoning", "verification_pipeline", false, ["view_synchronization", "cross_view_evidence", "ambiguity_handling"], ["view_evidence", "uncertainty_completeness"]),
  makePolicy("VisualVerificationResponse", "SpatialVerificationReasoning", "verification_pipeline", false, ["spatial_residual", "multi_view_confidence", "false_positive_prevention"], ["view_evidence", "provenance"]),
  makePolicy("CorrectionPlanResponse", "OopsCorrectionReasoning", "validator_stack", true, ["retry_budget", "safety", "embodiment_compatibility", "changed_strategy"], ["no_rl", "provenance"]),
  makePolicy("ToolUsePlanResponse", "ToolUseReasoning", "validator_stack", true, ["tool_visibility", "tool_affordance", "tool_attachment", "swept_volume", "collision", "release"], ["reach", "stability", "safety"]),
  makePolicy("AudioActionResponse", "AudioEventReasoning", "validator_stack", true, ["audio_confidence", "audio_visual_reconciliation", "safety"], ["view_evidence", "uncertainty_completeness"]),
  makePolicy("MemoryWriteCandidateResponse", "MemoryAssimilationReasoning", "memory_writer", false, ["provenance", "staleness", "contradiction", "privacy"], ["verification_certificate", "view_evidence"]),
  makePolicy("MonologueResponse", "InternalMonologueReasoning", "tts_filter", false, ["hidden_truth_filter", "tts_length", "safety_consistency", "action_match"], ["uncertainty_completeness"]),
]);

export const VALIDATOR_HANDOFF_CONTRACT_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: VALIDATOR_HANDOFF_CONTRACT_SCHEMA_VERSION,
  blueprint: "architecture_docs/07_PROMPT_CONTRACTS_AND_STRUCTURED_OUTPUTS.md",
  supporting_blueprints: freezeArray([
    "architecture_docs/06_GEMINI_ROBOTICS_ER_COGNITIVE_LAYER.md",
    "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md",
    "architecture_docs/18_SAFETY_GUARDRAILS_VALIDATION_AND_POLICY.md",
  ]),
  sections: freezeArray(["7.3", "7.6", "7.7", "7.19", "7.20", "7.23", "7.24"]),
});
