/**
 * Embodied system instruction contract for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/07_PROMPT_CONTRACTS_AND_STRUCTURED_OUTPUTS.md`
 * sections 7.3, 7.4, 7.5, 7.7, 7.8, and 7.24.
 *
 * This module implements the executable `PROMPT-SYS-001` boundary. It builds
 * the shared model-facing system role instruction, validates required embodied
 * role semantics, rejects privileged-world leakage and validator-bypass wording,
 * and projects the instruction into the common prompt packet section shape used
 * by the Gemini Robotics-ER adapter path.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import { GEMINI_ROBOTICS_ER_APPROVED_MODEL } from "../cognitive/gemini_robotics_er_adapter";
import type { CognitiveInvocationClass, CognitivePromptSection } from "../cognitive/gemini_robotics_er_adapter";
import {
  COGNITIVE_OUTPUT_VALIDATOR_POLICY_REF,
  COGNITIVE_PROMPT_FIREWALL_POLICY_REF,
  COGNITIVE_PROMPT_PACKET_CONTRACT_VERSION,
} from "./cognitive_prompt_packet_contract";
import type { PromptProvenanceLabel } from "./cognitive_prompt_packet_contract";

export const EMBODIED_SYSTEM_INSTRUCTION_CONTRACT_SCHEMA_VERSION = "mebsuta.embodied_system_instruction_contract.v1" as const;
export const EMBODIED_SYSTEM_INSTRUCTION_CONTRACT_VERSION = "1.0.0" as const;
export const EMBODIED_SYSTEM_INSTRUCTION_CONTRACT_ID = "PROMPT-SYS-001" as const;
export const EMBODIED_SYSTEM_INSTRUCTION_FAMILY = "EmbodiedSystemInstruction" as const;

const CONTRACT_TRACEABILITY_REF = "architecture_docs/07_PROMPT_CONTRACTS_AND_STRUCTURED_OUTPUTS.md#PROMPT-SYS-001" as const;
const TOKEN_CHARS_PER_UNIT = 4;

const PRIVILEGED_WORLD_LEAK_PATTERN = /(mujoco|babylon|backend|scene_graph|world_truth|ground_truth|qa_|collision_mesh|segmentation truth|render.?engine debug|debug buffer|simulator|simulation|physics_body|rigid_body_handle|joint_handle|object_id|exact_com|world_pose|hidden pose|hidden state|oracle state|privileged state)/i;
const FORBIDDEN_CONTROL_PATTERN = /(direct actuator|raw actuator|joint torque|joint current|set joint|apply force|apply impulse|physics step|reward policy|policy gradient|reinforcement learning|rl update|learned motor update|trained controller logic)/i;
const FORBIDDEN_AUTHORITY_PATTERN = /(ignore validators|override safety|disable safe.?hold|bypass validator|skip validation|execution authority|act without validation|guarantee success)/i;
const FORBIDDEN_REASONING_PATTERN = /(chain.?of.?thought|scratchpad|private deliberation|full hidden reasoning|developer prompt|system prompt disclosure|reveal internal reasoning)/i;
const EXECUTABLE_CODE_REQUEST_PATTERN = /(write|output|generate|return)\s+(executable\s+)?(python|typescript|javascript|c\+\+|java|rust|code)\b/i;

export type EmbodiedRoleSemantic =
  | "embodied_agent"
  | "no_privileged_world_awareness"
  | "sensor_evidence_only"
  | "structured_output"
  | "validation_boundary"
  | "uncertainty_allowed"
  | "public_rationale_only";

export type EmbodiedForbiddenSemantic =
  | "privileged_world_disclosure"
  | "backend_identity"
  | "exact_hidden_pose"
  | "executable_code_request"
  | "direct_control_request"
  | "validator_bypass"
  | "private_reasoning_request"
  | "no_rl_violation";

export type EmbodiedInstructionClauseKind =
  | "EmbodiedRole"
  | "EvidenceDiscipline"
  | "PrivilegedStateBoundary"
  | "StructuredOutputDuty"
  | "ValidatorAuthority"
  | "UncertaintyAndReobserve"
  | "PublicRationale";

export type EmbodiedInstructionMode = "standard" | "compact" | "repair";
export type EmbodiedInstructionDecision = "approved" | "approved_with_warnings" | "rejected";

export interface EmbodiedInstructionClause {
  readonly clause_ref: Ref;
  readonly clause_kind: EmbodiedInstructionClauseKind;
  readonly title: string;
  readonly content: string;
  readonly required: boolean;
  readonly provenance_label: PromptProvenanceLabel;
  readonly priority_rank: number;
}

export interface EmbodiedSystemInstructionDescriptor {
  readonly schema_version: typeof EMBODIED_SYSTEM_INSTRUCTION_CONTRACT_SCHEMA_VERSION;
  readonly contract_id: typeof EMBODIED_SYSTEM_INSTRUCTION_CONTRACT_ID;
  readonly contract_version: typeof EMBODIED_SYSTEM_INSTRUCTION_CONTRACT_VERSION;
  readonly prompt_packet_contract_version: typeof COGNITIVE_PROMPT_PACKET_CONTRACT_VERSION;
  readonly prompt_family: typeof EMBODIED_SYSTEM_INSTRUCTION_FAMILY;
  readonly model_profile_ref: typeof GEMINI_ROBOTICS_ER_APPROVED_MODEL;
  readonly input_firewall_ref: typeof COGNITIVE_PROMPT_FIREWALL_POLICY_REF;
  readonly output_validator_ref: typeof COGNITIVE_OUTPUT_VALIDATOR_POLICY_REF;
  readonly traceability_ref: typeof CONTRACT_TRACEABILITY_REF;
  readonly applies_to_invocation_classes: readonly CognitiveInvocationClass[];
  readonly required_role_semantics: readonly EmbodiedRoleSemantic[];
  readonly forbidden_role_semantics: readonly EmbodiedForbiddenSemantic[];
  readonly required_clause_kinds: readonly EmbodiedInstructionClauseKind[];
  readonly determinism_hash: string;
}

export interface EmbodiedSystemInstructionBuildRequest {
  readonly request_ref: Ref;
  readonly task_state_ref: Ref;
  readonly invocation_class: CognitiveInvocationClass;
  readonly output_contract_ref: Ref;
  readonly mode?: EmbodiedInstructionMode;
  readonly telemetry_label_ref?: Ref;
  readonly additional_safe_clauses?: readonly EmbodiedInstructionClause[];
}

export interface EmbodiedSystemInstructionValidationRequest {
  readonly instruction_ref: Ref;
  readonly invocation_class: CognitiveInvocationClass;
  readonly output_contract_ref: Ref;
  readonly instruction_text: string;
  readonly clause_refs?: readonly Ref[];
}

export interface EmbodiedSystemInstructionReport {
  readonly schema_version: typeof EMBODIED_SYSTEM_INSTRUCTION_CONTRACT_SCHEMA_VERSION;
  readonly decision: EmbodiedInstructionDecision;
  readonly instruction_ref: Ref;
  readonly descriptor: EmbodiedSystemInstructionDescriptor;
  readonly instruction_text: string;
  readonly adapter_section?: CognitivePromptSection;
  readonly included_clause_refs: readonly Ref[];
  readonly missing_required_semantics: readonly EmbodiedRoleSemantic[];
  readonly detected_forbidden_semantics: readonly EmbodiedForbiddenSemantic[];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

/**
 * Builds and validates the stable embodied role instruction shared by every
 * prompt family. The class is deterministic and side-effect free so prompt
 * regression, telemetry, adapter assembly, and safety gates can reproduce the
 * exact same instruction from the same request.
 */
export class EmbodiedSystemInstructionContract {
  private readonly descriptor: EmbodiedSystemInstructionDescriptor;
  private readonly baseClauses: readonly EmbodiedInstructionClause[];

  public constructor(baseClauses: readonly EmbodiedInstructionClause[] = DEFAULT_SYSTEM_INSTRUCTION_CLAUSES) {
    this.baseClauses = freezeArray(baseClauses.map(freezeClause));
    this.descriptor = buildDescriptor(this.baseClauses);
  }

  /**
   * Returns the immutable `PROMPT-SYS-001` descriptor used by prompt registry,
   * telemetry, and adapter integration.
   */
  public getDescriptor(): EmbodiedSystemInstructionDescriptor {
    return this.descriptor;
  }

  /**
   * Builds a model-facing system instruction, validates it immediately, and
   * projects it as a required `CognitivePromptSection` for adapter assembly.
   */
  public buildSystemInstruction(request: EmbodiedSystemInstructionBuildRequest): EmbodiedSystemInstructionReport {
    const issues: ValidationIssue[] = [];
    validateRef(request.request_ref, "$.request_ref", issues);
    validateRef(request.task_state_ref, "$.task_state_ref", issues);
    validateRef(request.output_contract_ref, "$.output_contract_ref", issues);
    if (!ALL_INVOCATION_CLASSES.includes(request.invocation_class)) {
      issues.push(issue("error", "InvocationClassRejected", "$.invocation_class", "Invocation class is not covered by PROMPT-SYS-001.", "Use a registered cognitive invocation class."));
    }

    const mode = request.mode ?? "standard";
    const candidateClauses = normalizeClauses([...this.baseClauses, ...(request.additional_safe_clauses ?? [])]);
    const instructionRef = makeInstructionRef(request.request_ref, request.invocation_class, request.output_contract_ref, mode);
    const instructionText = renderInstructionText(candidateClauses, request.invocation_class, request.output_contract_ref, mode);
    const validation = this.validateSystemInstruction({
      instruction_ref: instructionRef,
      invocation_class: request.invocation_class,
      output_contract_ref: request.output_contract_ref,
      instruction_text: instructionText,
      clause_refs: candidateClauses.map((clause) => clause.clause_ref),
    });
    issues.push(...validation.issues);

    const decision = chooseDecision(issues);
    const adapterSection = decision === "rejected"
      ? undefined
      : toAdapterSection(instructionRef, instructionText, request.telemetry_label_ref);
    const base = {
      schema_version: EMBODIED_SYSTEM_INSTRUCTION_CONTRACT_SCHEMA_VERSION,
      decision,
      instruction_ref: instructionRef,
      descriptor: this.descriptor,
      instruction_text: decision === "rejected" ? "" : instructionText,
      adapter_section: adapterSection,
      included_clause_refs: freezeArray(candidateClauses.map((clause) => clause.clause_ref)),
      missing_required_semantics: validation.missing_required_semantics,
      detected_forbidden_semantics: validation.detected_forbidden_semantics,
      issues: freezeArray(issues),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Validates arbitrary instruction text against required role semantics,
   * forbidden wording classes, required clause coverage, and adapter-safe refs.
   */
  public validateSystemInstruction(request: EmbodiedSystemInstructionValidationRequest): EmbodiedSystemInstructionReport {
    const issues: ValidationIssue[] = [];
    validateRef(request.instruction_ref, "$.instruction_ref", issues);
    validateRef(request.output_contract_ref, "$.output_contract_ref", issues);
    if (!ALL_INVOCATION_CLASSES.includes(request.invocation_class)) {
      issues.push(issue("error", "InvocationClassRejected", "$.invocation_class", "System instruction must target a known cognitive invocation class.", "Resolve invocation class through the cognitive router."));
    }
    if (request.instruction_text.trim().length === 0) {
      issues.push(issue("error", "InstructionEmpty", "$.instruction_text", "System instruction text must be non-empty.", "Build the instruction from the contract clauses."));
    }
    if (request.instruction_text.length > MAX_SYSTEM_INSTRUCTION_CHARS) {
      issues.push(issue("warning", "InstructionLarge", "$.instruction_text", "System instruction is larger than the compact prompt target.", "Use compact mode unless this is an offline regression packet."));
    }

    const missingRequiredSemantics = findMissingRoleSemantics(request.instruction_text);
    for (const semantic of missingRequiredSemantics) {
      issues.push(issue("error", "RequiredRoleSemanticMissing", `$.role_semantics.${semantic}`, `System instruction is missing required role semantic ${semantic}.`, "Regenerate the instruction from the default contract clauses."));
    }

    const forbiddenSemantics = detectForbiddenSemantics(request.instruction_text);
    for (const semantic of forbiddenSemantics) {
      issues.push(issue("error", "ForbiddenRoleSemanticDetected", `$.forbidden_semantics.${semantic}`, `System instruction contains forbidden role semantic ${semantic}.`, "Remove privileged, direct-control, no-RL, private-reasoning, or validator-bypass wording."));
    }

    if (!mentionsInvocationClass(request.instruction_text, request.invocation_class)) {
      issues.push(issue("warning", "InvocationClassNotEchoed", "$.instruction_text", "Instruction does not explicitly echo the invocation class.", "Include the invocation class for telemetry and regression traceability."));
    }
    if (!mentionsOutputContract(request.instruction_text, request.output_contract_ref)) {
      issues.push(issue("error", "OutputContractNotBound", "$.instruction_text", "Instruction does not bind the requested output contract.", "Include the output contract reference in the instruction."));
    }
    if (request.clause_refs !== undefined) {
      validateClauseCoverage(request.clause_refs, issues);
    }

    const decision = chooseDecision(issues);
    const adapterSection = decision === "rejected"
      ? undefined
      : toAdapterSection(request.instruction_ref, request.instruction_text, undefined);
    const base = {
      schema_version: EMBODIED_SYSTEM_INSTRUCTION_CONTRACT_SCHEMA_VERSION,
      decision,
      instruction_ref: request.instruction_ref,
      descriptor: this.descriptor,
      instruction_text: decision === "rejected" ? "" : request.instruction_text,
      adapter_section: adapterSection,
      included_clause_refs: freezeArray(request.clause_refs ?? []),
      missing_required_semantics: missingRequiredSemantics,
      detected_forbidden_semantics: forbiddenSemantics,
      issues: freezeArray(issues),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }
}

function renderInstructionText(
  clauses: readonly EmbodiedInstructionClause[],
  invocationClass: CognitiveInvocationClass,
  outputContractRef: Ref,
  mode: EmbodiedInstructionMode,
): string {
  const ordered = [...clauses].sort((a, b) => a.priority_rank - b.priority_rank || a.clause_ref.localeCompare(b.clause_ref));
  const body = ordered
    .filter((clause) => mode !== "compact" || clause.required || clause.priority_rank <= 2)
    .map((clause) => mode === "compact" ? clause.content.trim() : `${clause.title}: ${clause.content.trim()}`)
    .join(" ");
  const repairSuffix = mode === "repair"
    ? "Repair only the malformed structured response fields requested by the quarantine path, while preserving evidence limits and validator authority."
    : "";
  return [
    body,
    `Invocation class: ${invocationClass}.`,
    `Requested output contract: ${outputContractRef}.`,
    repairSuffix,
  ].filter((line) => line.length > 0).join(" ");
}

function toAdapterSection(instructionRef: Ref, instructionText: string, telemetryLabelRef: Ref | undefined): CognitivePromptSection {
  const telemetryLine = telemetryLabelRef === undefined ? "" : ` telemetry_label: ${telemetryLabelRef}.`;
  return Object.freeze({
    section_ref: instructionRef,
    title: "Embodied System Role",
    content: `${instructionText.trim()}${telemetryLine}`,
    provenance: "system",
    priority: 1,
    required: true,
    estimated_tokens: estimateTokens(instructionText),
  });
}

function findMissingRoleSemantics(text: string): readonly EmbodiedRoleSemantic[] {
  const checks: Readonly<Record<EmbodiedRoleSemantic, RegExp>> = {
    embodied_agent: /\b(robot|body|embodied|cameras|microphones|contact|proprioceptive)\b/i,
    no_privileged_world_awareness: /\b(unprovided|provided only|privileged|implementation details|not supplied)\b/i,
    sensor_evidence_only: /\b(sensor|camera|microphone|contact|proprioceptive|memory|validator|human-task|evidence)\b/i,
    structured_output: /\b(structured response|requested output contract|fields|contract)\b/i,
    validation_boundary: /\b(validators|controllers|execution|proposals|approve)\b/i,
    uncertainty_allowed: /\b(uncertain|uncertainty|re-observation|reobserve|insufficient evidence)\b/i,
    public_rationale_only: /\b(public rationale|concise public|spoken)\b/i,
  };
  return freezeArray(REQUIRED_ROLE_SEMANTICS.filter((semantic) => checks[semantic].test(text) === false));
}

function detectForbiddenSemantics(text: string): readonly EmbodiedForbiddenSemantic[] {
  const found: EmbodiedForbiddenSemantic[] = [];
  if (PRIVILEGED_WORLD_LEAK_PATTERN.test(text)) {
    found.push("privileged_world_disclosure");
  }
  if (/(scene_graph|object_id|backend identity|exact internal id)/i.test(text)) {
    found.push("backend_identity");
  }
  if (/(exact_com|world_pose|hidden pose|hidden state|privileged pose|ground.?truth pose)/i.test(text)) {
    found.push("exact_hidden_pose");
  }
  if (EXECUTABLE_CODE_REQUEST_PATTERN.test(text)) {
    found.push("executable_code_request");
  }
  if (FORBIDDEN_CONTROL_PATTERN.test(text)) {
    found.push("direct_control_request");
  }
  if (FORBIDDEN_AUTHORITY_PATTERN.test(text)) {
    found.push("validator_bypass");
  }
  if (FORBIDDEN_REASONING_PATTERN.test(text)) {
    found.push("private_reasoning_request");
  }
  if (/(reward policy|policy gradient|reinforcement learning|rl update|learned motor update|trained controller logic)/i.test(text)) {
    found.push("no_rl_violation");
  }
  return freezeArray([...new Set(found)]);
}

function validateClauseCoverage(clauseRefs: readonly Ref[], issues: ValidationIssue[]): void {
  const presentRefs = new Set(clauseRefs);
  for (const clause of DEFAULT_SYSTEM_INSTRUCTION_CLAUSES.filter((item) => item.required)) {
    if (!presentRefs.has(clause.clause_ref)) {
      issues.push(issue("error", "RequiredInstructionClauseMissing", `$.clause_refs.${clause.clause_ref}`, `Required system instruction clause ${clause.clause_kind} is missing.`, "Include every required PROMPT-SYS-001 clause."));
    }
  }
}

function normalizeClauses(clauses: readonly EmbodiedInstructionClause[]): readonly EmbodiedInstructionClause[] {
  const byKind = new Map<EmbodiedInstructionClauseKind, EmbodiedInstructionClause>();
  for (const clause of clauses) {
    byKind.set(clause.clause_kind, freezeClause(clause));
  }
  return freezeArray([...byKind.values()]);
}

function buildDescriptor(clauses: readonly EmbodiedInstructionClause[]): EmbodiedSystemInstructionDescriptor {
  const base = {
    schema_version: EMBODIED_SYSTEM_INSTRUCTION_CONTRACT_SCHEMA_VERSION,
    contract_id: EMBODIED_SYSTEM_INSTRUCTION_CONTRACT_ID,
    contract_version: EMBODIED_SYSTEM_INSTRUCTION_CONTRACT_VERSION,
    prompt_packet_contract_version: COGNITIVE_PROMPT_PACKET_CONTRACT_VERSION,
    prompt_family: EMBODIED_SYSTEM_INSTRUCTION_FAMILY,
    model_profile_ref: GEMINI_ROBOTICS_ER_APPROVED_MODEL,
    input_firewall_ref: COGNITIVE_PROMPT_FIREWALL_POLICY_REF,
    output_validator_ref: COGNITIVE_OUTPUT_VALIDATOR_POLICY_REF,
    traceability_ref: CONTRACT_TRACEABILITY_REF,
    applies_to_invocation_classes: ALL_INVOCATION_CLASSES,
    required_role_semantics: REQUIRED_ROLE_SEMANTICS,
    forbidden_role_semantics: FORBIDDEN_ROLE_SEMANTICS,
    required_clause_kinds: freezeArray(clauses.filter((clause) => clause.required).map((clause) => clause.clause_kind)),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function makeInstructionRef(requestRef: Ref, invocationClass: CognitiveInvocationClass, outputContractRef: Ref, mode: EmbodiedInstructionMode): Ref {
  return `prompt_sys_${computeDeterminismHash({ requestRef, invocationClass, outputContractRef, mode }).slice(0, 16)}`;
}

function mentionsInvocationClass(text: string, invocationClass: CognitiveInvocationClass): boolean {
  return text.includes(invocationClass);
}

function mentionsOutputContract(text: string, outputContractRef: Ref): boolean {
  return text.includes(outputContractRef);
}

function chooseDecision(issues: readonly ValidationIssue[]): EmbodiedInstructionDecision {
  if (issues.some((item) => item.severity === "error")) {
    return "rejected";
  }
  if (issues.length > 0) {
    return "approved_with_warnings";
  }
  return "approved";
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / TOKEN_CHARS_PER_UNIT));
}

function validateRef(ref: Ref, path: string, issues: ValidationIssue[]): void {
  if (ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(issue("error", "ReferenceInvalid", path, "Reference must be non-empty and whitespace-free.", "Use a stable prompt-safe reference."));
  }
  if (PRIVILEGED_WORLD_LEAK_PATTERN.test(ref) || FORBIDDEN_CONTROL_PATTERN.test(ref) || FORBIDDEN_AUTHORITY_PATTERN.test(ref) || FORBIDDEN_REASONING_PATTERN.test(ref)) {
    issues.push(issue("error", "ReferenceContainsForbiddenContent", path, "Reference contains forbidden system-instruction terminology.", "Replace with an opaque contract reference."));
  }
}

function issue(severity: ValidationSeverity, code: string, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function freezeClause(clause: EmbodiedInstructionClause): EmbodiedInstructionClause {
  return Object.freeze({ ...clause });
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

const MAX_SYSTEM_INSTRUCTION_CHARS = 3200;

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

const REQUIRED_ROLE_SEMANTICS: readonly EmbodiedRoleSemantic[] = freezeArray([
  "embodied_agent",
  "no_privileged_world_awareness",
  "sensor_evidence_only",
  "structured_output",
  "validation_boundary",
  "uncertainty_allowed",
  "public_rationale_only",
]);

const FORBIDDEN_ROLE_SEMANTICS: readonly EmbodiedForbiddenSemantic[] = freezeArray([
  "privileged_world_disclosure",
  "backend_identity",
  "exact_hidden_pose",
  "executable_code_request",
  "direct_control_request",
  "validator_bypass",
  "private_reasoning_request",
  "no_rl_violation",
]);

const DEFAULT_SYSTEM_INSTRUCTION_CLAUSES: readonly EmbodiedInstructionClause[] = freezeArray([
  {
    clause_ref: "prompt_sys_clause_embodied_role",
    clause_kind: "EmbodiedRole",
    title: "Embodied role",
    content: "Reason as the robot's embodied cognitive layer, using the provided cameras, microphones, contact sensors, proprioceptive state, memory records, validator feedback, and human-task text.",
    required: true,
    provenance_label: "system_contract",
    priority_rank: 1,
  },
  {
    clause_ref: "prompt_sys_clause_evidence_discipline",
    clause_kind: "EvidenceDiscipline",
    title: "Evidence discipline",
    content: "Make scene, object, pose, reach, sound, and safety claims only from supplied sensor evidence, prior memory marked as memory, explicit human-task wording, or validator feedback.",
    required: true,
    provenance_label: "system_contract",
    priority_rank: 1,
  },
  {
    clause_ref: "prompt_sys_clause_privileged_state_boundary",
    clause_kind: "PrivilegedStateBoundary",
    title: "Unprovided state boundary",
    content: "Do not infer from unprovided implementation details, unprovided state, exact internal coordinates, opaque identity handles, or any data not supplied as prompt evidence.",
    required: true,
    provenance_label: "system_contract",
    priority_rank: 1,
  },
  {
    clause_ref: "prompt_sys_clause_structured_output_duty",
    clause_kind: "StructuredOutputDuty",
    title: "Structured output duty",
    content: "Return only the requested structured response fields for the requested output contract, with evidence references, confidence, uncertainty entries, and re-observation requests when needed.",
    required: true,
    provenance_label: "system_contract",
    priority_rank: 1,
  },
  {
    clause_ref: "prompt_sys_clause_validator_authority",
    clause_kind: "ValidatorAuthority",
    title: "Validator authority",
    content: "Treat plans and waypoints as proposals; deterministic validators and controllers decide whether execution, memory writes, or spoken status may proceed.",
    required: true,
    provenance_label: "system_contract",
    priority_rank: 1,
  },
  {
    clause_ref: "prompt_sys_clause_uncertainty_and_reobserve",
    clause_kind: "UncertaintyAndReobserve",
    title: "Uncertainty and re-observation",
    content: "When evidence is incomplete, ambiguous, stale, contradictory, or unsafe, lower confidence, preserve uncertainty, and request re-observation or safe-hold rather than guessing.",
    required: true,
    provenance_label: "system_contract",
    priority_rank: 2,
  },
  {
    clause_ref: "prompt_sys_clause_public_rationale",
    clause_kind: "PublicRationale",
    title: "Public rationale",
    content: "For monologue or spoken output, provide concise public rationale only, grounded in visible evidence or validator status, and keep safety interruption available.",
    required: true,
    provenance_label: "system_contract",
    priority_rank: 2,
  },
]);

export const EMBODIED_SYSTEM_INSTRUCTION_CONTRACT_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: EMBODIED_SYSTEM_INSTRUCTION_CONTRACT_SCHEMA_VERSION,
  blueprint: "architecture_docs/07_PROMPT_CONTRACTS_AND_STRUCTURED_OUTPUTS.md",
  sections: freezeArray(["7.3", "7.4", "7.5", "7.7", "7.8", "7.24"]),
});
