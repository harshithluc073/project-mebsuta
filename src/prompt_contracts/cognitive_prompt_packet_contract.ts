/**
 * Cognitive prompt packet contract for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/07_PROMPT_CONTRACTS_AND_STRUCTURED_OUTPUTS.md`
 * sections 7.3, 7.4, 7.5, 7.7, 7.8, 7.9, 7.10, and 7.11.
 *
 * This module defines the executable prompt packet contract layer: prompt
 * families, required and conditional sections, provenance labels, priority
 * rules, forbidden-content boundaries, telemetry labels, and adapter-safe
 * prompt section projection. It validates packet candidates before they are
 * assembled for Gemini Robotics-ER so hidden simulator truth, low-level control
 * requests, private reasoning requests, and unsupported model roles are refused
 * at the contract boundary.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import { GEMINI_ROBOTICS_ER_APPROVED_MODEL } from "../cognitive/gemini_robotics_er_adapter";
import type { CognitiveInvocationClass, CognitivePromptSection } from "../cognitive/gemini_robotics_er_adapter";

export const COGNITIVE_PROMPT_PACKET_CONTRACT_SCHEMA_VERSION = "mebsuta.cognitive_prompt_packet_contract.v1" as const;
export const COGNITIVE_PROMPT_PACKET_CONTRACT_VERSION = "1.0.0" as const;
export const COGNITIVE_PROMPT_FIREWALL_POLICY_REF = "prompt_firewall:simulation_blindness_no_rl_v1" as const;
export const COGNITIVE_OUTPUT_VALIDATOR_POLICY_REF = "output_validator:structured_response_boundary_v1" as const;

const TOKEN_CHARS_PER_UNIT = 4;
const DEFAULT_RESERVED_MARGIN_TOKENS = 12000;
const FORBIDDEN_PROMPT_CONTENT_PATTERN = /(mujoco|babylon|backend|engine|scene_graph|world_truth|ground_truth|qa_|collision_mesh|segmentation truth|render-engine debug|debug buffer|simulator|physics_body|rigid_body_handle|joint_handle|object_id|exact_com|world_pose|hidden pose|hidden state|system prompt|developer prompt|chain-of-thought|scratchpad|private deliberation|direct actuator|raw actuator|joint torque|joint current|set joint|apply force|apply impulse|physics step|reward policy|policy gradient|reinforcement learning|rl update|ignore validators|override safety|disable safe-hold)/i;
const EXECUTABLE_CODE_REQUEST_PATTERN = /(write|output|generate|return)\s+(executable\s+)?(python|typescript|javascript|c\+\+|java|rust|code)\b/i;

export type PromptContractId =
  | "PROMPT-SYS-001"
  | "PROMPT-OBS-001"
  | "PROMPT-PLAN-001"
  | "PROMPT-WAY-001"
  | "PROMPT-MV-001"
  | "PROMPT-VERIFY-001"
  | "PROMPT-OOPS-001"
  | "PROMPT-MEM-001"
  | "PROMPT-AUD-001"
  | "PROMPT-TOOL-001"
  | "PROMPT-MONO-001"
  | "PROMPT-REPAIR-001";

export type PromptFamily =
  | "EmbodiedSystemInstruction"
  | "SceneObservation"
  | "TaskPlanning"
  | "WaypointGeneration"
  | "MultiViewDisambiguation"
  | "SpatialVerification"
  | "FailureCorrection"
  | "MemoryAssimilation"
  | "AcousticReasoning"
  | "ToolUseReasoning"
  | "InternalMonologue"
  | "StructuredResponseRepair";

export type PromptPacketSectionKind =
  | "SystemRole"
  | "SafetyPolicySummary"
  | "TaskInstruction"
  | "CurrentObservation"
  | "MediaAttachments"
  | "EmbodimentContext"
  | "MemoryContext"
  | "ValidationFeedback"
  | "OutputContractInstruction"
  | "UncertaintyInstruction"
  | "TelemetryLabels"
  | "RecentObservationHistory";

export type PromptSectionRequirement = "required" | "conditional" | "optional";
export type PromptContractResolutionDecision = "resolved" | "resolved_with_warnings" | "rejected";
export type PromptPacketValidationDecision = "approved" | "approved_with_warnings" | "rejected";
export type PromptSectionBudgetDecision = "included" | "omitted";

export type PromptProvenanceLabel =
  | "sensor_visual_current"
  | "sensor_audio_current"
  | "sensor_contact_current"
  | "proprioceptive_current"
  | "memory_prior"
  | "validator_feedback"
  | "embodiment_self_knowledge"
  | "human_instruction"
  | "inference_from_evidence"
  | "safety_policy"
  | "schema_instruction"
  | "system_contract"
  | "telemetry_label";

export interface PromptContractDescriptor {
  readonly schema_version: typeof COGNITIVE_PROMPT_PACKET_CONTRACT_SCHEMA_VERSION;
  readonly contract_id: PromptContractId;
  readonly contract_version: typeof COGNITIVE_PROMPT_PACKET_CONTRACT_VERSION;
  readonly prompt_family: PromptFamily;
  readonly invocation_class: CognitiveInvocationClass;
  readonly output_contract_ref: Ref;
  readonly model_profile_ref: typeof GEMINI_ROBOTICS_ER_APPROVED_MODEL;
  readonly input_firewall_ref: typeof COGNITIVE_PROMPT_FIREWALL_POLICY_REF;
  readonly output_validator_ref: typeof COGNITIVE_OUTPUT_VALIDATOR_POLICY_REF;
  readonly traceability_ref: Ref;
  readonly required_sections: readonly PromptPacketSectionKind[];
  readonly conditional_sections: readonly PromptPacketSectionKind[];
  readonly optional_sections: readonly PromptPacketSectionKind[];
  readonly allowed_provenance_labels: readonly PromptProvenanceLabel[];
  readonly action_bearing: boolean;
  readonly validator_handoff_required: boolean;
  readonly determinism_hash: string;
}

export interface PromptSectionPriorityRule {
  readonly section_kind: PromptPacketSectionKind;
  readonly priority_rank: number;
  readonly required_for_live_requests: boolean;
  readonly drop_strategy: "never_drop" | "compact_first" | "omit_under_pressure";
  readonly budget_behavior: string;
}

export interface CognitivePromptPacketSection {
  readonly section_ref: Ref;
  readonly section_kind: PromptPacketSectionKind;
  readonly title: string;
  readonly content: string;
  readonly provenance_label: PromptProvenanceLabel;
  readonly source_ref: Ref;
  readonly requirement: PromptSectionRequirement;
  readonly priority_rank?: number;
  readonly estimated_tokens?: number;
  readonly telemetry_label?: Ref;
}

export interface CognitivePromptPacketCandidate {
  readonly packet_ref: Ref;
  readonly descriptor: PromptContractDescriptor;
  readonly task_state_ref: Ref;
  readonly sections: readonly CognitivePromptPacketSection[];
  readonly media_refs: readonly Ref[];
  readonly telemetry_labels: readonly Ref[];
  readonly created_at_ms: number;
}

export interface PromptContractResolutionReport {
  readonly schema_version: typeof COGNITIVE_PROMPT_PACKET_CONTRACT_SCHEMA_VERSION;
  readonly decision: PromptContractResolutionDecision;
  readonly invocation_class: CognitiveInvocationClass;
  readonly descriptor?: PromptContractDescriptor;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface PromptPacketValidationReport {
  readonly schema_version: typeof COGNITIVE_PROMPT_PACKET_CONTRACT_SCHEMA_VERSION;
  readonly decision: PromptPacketValidationDecision;
  readonly packet_ref: Ref;
  readonly approved_section_refs: readonly Ref[];
  readonly rejected_section_refs: readonly Ref[];
  readonly missing_required_sections: readonly PromptPacketSectionKind[];
  readonly forbidden_content_section_refs: readonly Ref[];
  readonly telemetry_label_refs: readonly Ref[];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface PromptSectionBudgetReport {
  readonly schema_version: typeof COGNITIVE_PROMPT_PACKET_CONTRACT_SCHEMA_VERSION;
  readonly packet_ref: Ref;
  readonly max_input_tokens: number;
  readonly reserved_margin_tokens: number;
  readonly estimated_total_tokens: number;
  readonly included_sections: readonly CognitivePromptPacketSection[];
  readonly omitted_sections: readonly CognitivePromptPacketSection[];
  readonly section_decisions: readonly {
    readonly section_ref: Ref;
    readonly decision: PromptSectionBudgetDecision;
    readonly reason: string;
    readonly estimated_tokens: number;
  }[];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface AdapterPromptProjectionReport {
  readonly schema_version: typeof COGNITIVE_PROMPT_PACKET_CONTRACT_SCHEMA_VERSION;
  readonly packet_ref: Ref;
  readonly adapter_sections: readonly CognitivePromptSection[];
  readonly omitted_section_refs: readonly Ref[];
  readonly validation_report: PromptPacketValidationReport;
  readonly budget_report: PromptSectionBudgetReport;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

/**
 * Defines and validates prompt packet contracts for Gemini Robotics-ER calls.
 * The class is deterministic so prompt assembly, telemetry, regression, and
 * audit tools can reproduce every section decision from the same packet input.
 */
export class CognitivePromptPacketContract {
  private readonly descriptors: Readonly<Record<CognitiveInvocationClass, PromptContractDescriptor>>;
  private readonly priorityRules: Readonly<Record<PromptPacketSectionKind, PromptSectionPriorityRule>>;

  public constructor(
    descriptors: readonly PromptContractDescriptor[] = DEFAULT_PROMPT_CONTRACT_DESCRIPTORS,
    priorityRules: readonly PromptSectionPriorityRule[] = DEFAULT_SECTION_PRIORITY_RULES,
  ) {
    this.descriptors = indexDescriptors(descriptors);
    this.priorityRules = indexPriorityRules(priorityRules);
  }

  /**
   * Resolves the prompt contract descriptor for one invocation class and model
   * profile. Unknown or unapproved model references are rejected at this layer.
   */
  public resolvePromptContract(
    invocationClass: CognitiveInvocationClass,
    taskStateRef: Ref,
    modelProfileRef: string = GEMINI_ROBOTICS_ER_APPROVED_MODEL,
  ): PromptContractResolutionReport {
    const issues: ValidationIssue[] = [];
    validateRef(taskStateRef, "$.task_state_ref", issues);
    if (modelProfileRef !== GEMINI_ROBOTICS_ER_APPROVED_MODEL) {
      issues.push(issue("error", "ModelProfileRejected", "$.model_profile_ref", "Prompt contracts are currently bound to the approved Gemini Robotics-ER profile.", "Run model migration review before changing the prompt profile."));
    }
    const descriptor = this.descriptors[invocationClass];
    const decision: PromptContractResolutionDecision = issues.some((item) => item.severity === "error")
      ? "rejected"
      : issues.length > 0
        ? "resolved_with_warnings"
        : "resolved";
    const base = {
      schema_version: COGNITIVE_PROMPT_PACKET_CONTRACT_SCHEMA_VERSION,
      decision,
      invocation_class: invocationClass,
      descriptor: decision === "rejected" ? undefined : descriptor,
      issues: freezeArray(issues),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Validates a complete packet candidate for required sections, provenance
   * labels, telemetry refs, forbidden wording, and invocation-specific needs.
   */
  public validatePromptPacket(packet: CognitivePromptPacketCandidate): PromptPacketValidationReport {
    const issues: ValidationIssue[] = [];
    validateRef(packet.packet_ref, "$.packet_ref", issues);
    validateRef(packet.task_state_ref, "$.task_state_ref", issues);
    const missingRequired = findMissingRequiredSections(packet);
    for (const missing of missingRequired) {
      issues.push(issue("error", "RequiredPromptSectionMissing", `$.sections.${missing}`, `Prompt packet is missing required section ${missing}.`, "Add the required prompt section before model invocation."));
    }
    const approvedSectionRefs: Ref[] = [];
    const rejectedSectionRefs: Ref[] = [];
    const forbiddenSectionRefs: Ref[] = [];
    for (const section of packet.sections) {
      const sectionIssues = this.validateSection(packet.descriptor, section);
      issues.push(...sectionIssues);
      if (sectionIssues.some((item) => item.severity === "error")) {
        rejectedSectionRefs.push(section.section_ref);
      } else {
        approvedSectionRefs.push(section.section_ref);
      }
      if (sectionIssues.some((item) => item.code === "ForbiddenPromptContent" || item.code === "ExecutableCodeRequest")) {
        forbiddenSectionRefs.push(section.section_ref);
      }
    }
    if (packet.telemetry_labels.length === 0 || packet.sections.some((section) => section.section_kind === "TelemetryLabels") === false) {
      issues.push(issue("error", "TelemetryLabelsMissing", "$.telemetry_labels", "Prompt packet requires telemetry labels for request ref, contract version, and invocation class.", "Attach TelemetryLabels section and label refs."));
    }
    if (packet.descriptor.action_bearing && packet.descriptor.validator_handoff_required === false) {
      issues.push(issue("error", "ValidatorHandoffMissing", "$.descriptor.validator_handoff_required", "Action-bearing prompt contract must require deterministic validator handoff.", "Enable validator handoff for action-bearing prompts."));
    }
    const decision = decideValidation(issues);
    const base = {
      schema_version: COGNITIVE_PROMPT_PACKET_CONTRACT_SCHEMA_VERSION,
      decision,
      packet_ref: packet.packet_ref,
      approved_section_refs: freezeArray(approvedSectionRefs),
      rejected_section_refs: freezeArray(rejectedSectionRefs),
      missing_required_sections: missingRequired,
      forbidden_content_section_refs: freezeArray(forbiddenSectionRefs),
      telemetry_label_refs: freezeArray(packet.telemetry_labels),
      issues: freezeArray(issues),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Selects prompt sections under a token envelope using the documented
   * priority ladder. Required live sections are retained before optional memory,
   * old history, or prior monologue-like narrative material.
   */
  public selectSectionsByPriority(
    packet: CognitivePromptPacketCandidate,
    maxInputTokens: number,
    reservedMarginTokens: number = DEFAULT_RESERVED_MARGIN_TOKENS,
  ): PromptSectionBudgetReport {
    const issues: ValidationIssue[] = [];
    if (maxInputTokens <= reservedMarginTokens || Number.isFinite(maxInputTokens) === false || Number.isFinite(reservedMarginTokens) === false) {
      issues.push(issue("error", "InvalidTokenEnvelope", "$.max_input_tokens", "Token envelope must be finite and larger than reserved margin.", "Provide a finite model input limit and reserved margin."));
    }
    const usableTokens = Math.max(0, maxInputTokens - reservedMarginTokens);
    const sorted = [...packet.sections].sort((a, b) => effectivePriority(a, this.priorityRules) - effectivePriority(b, this.priorityRules) || a.section_ref.localeCompare(b.section_ref));
    const included: CognitivePromptPacketSection[] = [];
    const omitted: CognitivePromptPacketSection[] = [];
    const decisions: PromptSectionBudgetReport["section_decisions"][number][] = [];
    let usedTokens = 0;
    for (const section of sorted) {
      const tokens = estimateSectionTokens(section);
      const rule = this.priorityRules[section.section_kind];
      const mustKeep = section.requirement === "required" || rule.drop_strategy === "never_drop";
      if (usedTokens + tokens <= usableTokens || mustKeep) {
        included.push(section);
        usedTokens += tokens;
        if (usedTokens > usableTokens && mustKeep) {
          issues.push(issue("warning", "RequiredSectionExceedsTokenEnvelope", section.section_ref, `Required section ${section.section_kind} exceeds the preferred token envelope.`, "Compact optional sections and inspect required section length."));
        }
        decisions.push(Object.freeze({ section_ref: section.section_ref, decision: "included" as const, reason: mustKeep ? "required_by_contract" : "within_priority_budget", estimated_tokens: tokens }));
      } else {
        omitted.push(section);
        decisions.push(Object.freeze({ section_ref: section.section_ref, decision: "omitted" as const, reason: rule.drop_strategy, estimated_tokens: tokens }));
      }
    }
    const base = {
      schema_version: COGNITIVE_PROMPT_PACKET_CONTRACT_SCHEMA_VERSION,
      packet_ref: packet.packet_ref,
      max_input_tokens: maxInputTokens,
      reserved_margin_tokens: reservedMarginTokens,
      estimated_total_tokens: usedTokens,
      included_sections: freezeArray(included),
      omitted_sections: freezeArray(omitted),
      section_decisions: freezeArray(decisions),
      issues: freezeArray(issues),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Projects a validated prompt packet into adapter-ready prompt sections. This
   * preserves provenance and priority while stripping contract-only metadata.
   */
  public projectToAdapterSections(
    packet: CognitivePromptPacketCandidate,
    maxInputTokens: number,
    reservedMarginTokens: number = DEFAULT_RESERVED_MARGIN_TOKENS,
  ): AdapterPromptProjectionReport {
    const validation = this.validatePromptPacket(packet);
    const budget = this.selectSectionsByPriority(packet, maxInputTokens, reservedMarginTokens);
    const includedRefs = new Set(budget.included_sections.map((section) => section.section_ref));
    const rejectedRefs = new Set(validation.rejected_section_refs);
    const adapterSections = packet.sections
      .filter((section) => includedRefs.has(section.section_ref) && rejectedRefs.has(section.section_ref) === false)
      .map((section) => toAdapterSection(section, this.priorityRules));
    const omittedRefs = packet.sections
      .filter((section) => includedRefs.has(section.section_ref) === false || rejectedRefs.has(section.section_ref))
      .map((section) => section.section_ref);
    const issues = freezeArray([...validation.issues, ...budget.issues]);
    const base = {
      schema_version: COGNITIVE_PROMPT_PACKET_CONTRACT_SCHEMA_VERSION,
      packet_ref: packet.packet_ref,
      adapter_sections: freezeArray(adapterSections),
      omitted_section_refs: freezeArray(omittedRefs),
      validation_report: validation,
      budget_report: budget,
      issues,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  private validateSection(descriptor: PromptContractDescriptor, section: CognitivePromptPacketSection): readonly ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    validateRef(section.section_ref, "$.section.section_ref", issues);
    validateRef(section.source_ref, "$.section.source_ref", issues);
    if (section.title.trim().length === 0 || section.content.trim().length === 0) {
      issues.push(issue("error", "PromptSectionEmpty", section.section_ref, "Prompt section title and content must be non-empty.", "Provide concise model-facing content."));
    }
    if (!descriptor.allowed_provenance_labels.includes(section.provenance_label)) {
      issues.push(issue("error", "ProvenanceLabelRejected", section.section_ref, `Provenance label ${section.provenance_label} is not allowed for this prompt contract.`, "Use a provenance label defined by the common prompt packet contract."));
    }
    if (FORBIDDEN_PROMPT_CONTENT_PATTERN.test(`${section.title} ${section.content} ${section.source_ref}`)) {
      issues.push(issue("error", "ForbiddenPromptContent", section.section_ref, "Prompt section contains simulator, hidden-truth, private reasoning, direct-control, or no-RL-forbidden content.", "Replace with sensor-derived, prompt-safe, validator-bound language."));
    }
    if (EXECUTABLE_CODE_REQUEST_PATTERN.test(section.content)) {
      issues.push(issue("error", "ExecutableCodeRequest", section.section_ref, "Prompt section asks the model for executable implementation code.", "Request structured plans, waypoints, or repair fields rather than executable code."));
    }
    if (section.section_kind === "MemoryContext" && section.provenance_label !== "memory_prior") {
      issues.push(issue("error", "MemoryLabelMissing", section.section_ref, "Memory context must be labeled as prior memory, not current truth.", "Use memory_prior provenance with confidence and staleness text."));
    }
    if (section.section_kind === "CurrentObservation" && !isCurrentSensorLabel(section.provenance_label) && section.provenance_label !== "inference_from_evidence") {
      issues.push(issue("error", "ObservationProvenanceInvalid", section.section_ref, "Current observation must come from current sensor evidence or labeled inference.", "Use current sensor provenance labels."));
    }
    return freezeArray(issues);
  }
}

function findMissingRequiredSections(packet: CognitivePromptPacketCandidate): readonly PromptPacketSectionKind[] {
  const present = new Set(packet.sections.map((section) => section.section_kind));
  return freezeArray(packet.descriptor.required_sections.filter((section) => present.has(section) === false));
}

function decideValidation(issues: readonly ValidationIssue[]): PromptPacketValidationDecision {
  if (issues.some((item) => item.severity === "error")) {
    return "rejected";
  }
  if (issues.length > 0) {
    return "approved_with_warnings";
  }
  return "approved";
}

function toAdapterSection(section: CognitivePromptPacketSection, rules: Readonly<Record<PromptPacketSectionKind, PromptSectionPriorityRule>>): CognitivePromptSection {
  const priority = section.priority_rank ?? rules[section.section_kind].priority_rank;
  return Object.freeze({
    section_ref: section.section_ref,
    title: section.title,
    content: renderModelFacingContent(section),
    provenance: adapterProvenanceFor(section),
    priority,
    required: section.requirement === "required",
    estimated_tokens: estimateSectionTokens(section),
  });
}

function renderModelFacingContent(section: CognitivePromptPacketSection): string {
  return [
    `[${section.provenance_label}]`,
    section.content.trim(),
    `source_ref: ${section.source_ref}`,
    section.telemetry_label === undefined ? "" : `telemetry_label: ${section.telemetry_label}`,
  ].filter((line) => line.length > 0).join("\n");
}

function adapterProvenanceFor(section: CognitivePromptPacketSection): CognitivePromptSection["provenance"] {
  switch (section.provenance_label) {
    case "sensor_visual_current":
    case "sensor_audio_current":
    case "sensor_contact_current":
    case "proprioceptive_current":
    case "inference_from_evidence":
      return "sensor";
    case "memory_prior":
      return "memory";
    case "validator_feedback":
      return "validator";
    case "embodiment_self_knowledge":
      return "embodiment";
    case "human_instruction":
      return "task";
    case "safety_policy":
      return "safety";
    case "schema_instruction":
      return "schema";
    case "system_contract":
    case "telemetry_label":
      return "system";
  }
}

function effectivePriority(section: CognitivePromptPacketSection, rules: Readonly<Record<PromptPacketSectionKind, PromptSectionPriorityRule>>): number {
  return section.priority_rank ?? rules[section.section_kind].priority_rank;
}

function estimateSectionTokens(section: CognitivePromptPacketSection): number {
  if (section.estimated_tokens !== undefined) {
    return Math.max(1, Math.ceil(section.estimated_tokens));
  }
  return Math.max(1, Math.ceil((section.title.length + section.content.length + section.source_ref.length) / TOKEN_CHARS_PER_UNIT));
}

function isCurrentSensorLabel(label: PromptProvenanceLabel): boolean {
  return label === "sensor_visual_current" || label === "sensor_audio_current" || label === "sensor_contact_current" || label === "proprioceptive_current";
}

function indexDescriptors(descriptors: readonly PromptContractDescriptor[]): Readonly<Record<CognitiveInvocationClass, PromptContractDescriptor>> {
  const map = new Map<CognitiveInvocationClass, PromptContractDescriptor>();
  for (const descriptor of descriptors) {
    map.set(descriptor.invocation_class, freezeDescriptor(descriptor));
  }
  const missing = ALL_INVOCATION_CLASSES.filter((invocationClass) => map.has(invocationClass) === false);
  if (missing.length > 0) {
    throw new Error(`CognitivePromptPacketContract missing descriptors: ${missing.join(", ")}`);
  }
  return Object.freeze(Object.fromEntries(ALL_INVOCATION_CLASSES.map((invocationClass) => [invocationClass, map.get(invocationClass) as PromptContractDescriptor])) as Record<CognitiveInvocationClass, PromptContractDescriptor>);
}

function indexPriorityRules(rules: readonly PromptSectionPriorityRule[]): Readonly<Record<PromptPacketSectionKind, PromptSectionPriorityRule>> {
  const map = new Map<PromptPacketSectionKind, PromptSectionPriorityRule>();
  for (const rule of rules) {
    map.set(rule.section_kind, Object.freeze({ ...rule }));
  }
  const missing = ALL_SECTION_KINDS.filter((section) => map.has(section) === false);
  if (missing.length > 0) {
    throw new Error(`CognitivePromptPacketContract missing priority rules: ${missing.join(", ")}`);
  }
  return Object.freeze(Object.fromEntries(ALL_SECTION_KINDS.map((section) => [section, map.get(section) as PromptSectionPriorityRule])) as Record<PromptPacketSectionKind, PromptSectionPriorityRule>);
}

function freezeDescriptor(descriptor: PromptContractDescriptor): PromptContractDescriptor {
  return Object.freeze({
    ...descriptor,
    required_sections: freezeArray(descriptor.required_sections),
    conditional_sections: freezeArray(descriptor.conditional_sections),
    optional_sections: freezeArray(descriptor.optional_sections),
    allowed_provenance_labels: freezeArray(descriptor.allowed_provenance_labels),
  });
}

function makeDescriptor(
  contractId: PromptContractId,
  family: PromptFamily,
  invocationClass: CognitiveInvocationClass,
  outputContractRef: Ref,
  requiredSections: readonly PromptPacketSectionKind[],
  conditionalSections: readonly PromptPacketSectionKind[],
  optionalSections: readonly PromptPacketSectionKind[],
  actionBearing: boolean,
): PromptContractDescriptor {
  const base = {
    schema_version: COGNITIVE_PROMPT_PACKET_CONTRACT_SCHEMA_VERSION,
    contract_id: contractId,
    contract_version: COGNITIVE_PROMPT_PACKET_CONTRACT_VERSION,
    prompt_family: family,
    invocation_class: invocationClass,
    output_contract_ref: outputContractRef,
    model_profile_ref: GEMINI_ROBOTICS_ER_APPROVED_MODEL,
    input_firewall_ref: COGNITIVE_PROMPT_FIREWALL_POLICY_REF,
    output_validator_ref: COGNITIVE_OUTPUT_VALIDATOR_POLICY_REF,
    traceability_ref: `architecture_docs/07_PROMPT_CONTRACTS_AND_STRUCTURED_OUTPUTS.md#${contractId}`,
    required_sections: freezeArray(requiredSections),
    conditional_sections: freezeArray(conditionalSections),
    optional_sections: freezeArray(optionalSections),
    allowed_provenance_labels: ALL_PROVENANCE_LABELS,
    action_bearing: actionBearing,
    validator_handoff_required: actionBearing,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function makePriorityRule(
  sectionKind: PromptPacketSectionKind,
  priorityRank: number,
  requiredForLiveRequests: boolean,
  dropStrategy: PromptSectionPriorityRule["drop_strategy"],
  budgetBehavior: string,
): PromptSectionPriorityRule {
  return Object.freeze({
    section_kind: sectionKind,
    priority_rank: priorityRank,
    required_for_live_requests: requiredForLiveRequests,
    drop_strategy: dropStrategy,
    budget_behavior: budgetBehavior,
  });
}

function validateRef(ref: Ref, path: string, issues: ValidationIssue[]): void {
  if (ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(issue("error", "ReferenceInvalid", path, "Reference must be non-empty and whitespace-free.", "Use a stable opaque reference."));
  }
  if (FORBIDDEN_PROMPT_CONTENT_PATTERN.test(ref)) {
    issues.push(issue("error", "ReferenceContainsForbiddenContent", path, "Reference contains forbidden prompt-boundary terminology.", "Replace with an opaque prompt-safe reference."));
  }
}

function issue(severity: ValidationSeverity, code: string, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

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

const ALL_SECTION_KINDS: readonly PromptPacketSectionKind[] = freezeArray([
  "SystemRole",
  "SafetyPolicySummary",
  "TaskInstruction",
  "CurrentObservation",
  "MediaAttachments",
  "EmbodimentContext",
  "MemoryContext",
  "ValidationFeedback",
  "OutputContractInstruction",
  "UncertaintyInstruction",
  "TelemetryLabels",
  "RecentObservationHistory",
]);

const ALL_PROVENANCE_LABELS: readonly PromptProvenanceLabel[] = freezeArray([
  "sensor_visual_current",
  "sensor_audio_current",
  "sensor_contact_current",
  "proprioceptive_current",
  "memory_prior",
  "validator_feedback",
  "embodiment_self_knowledge",
  "human_instruction",
  "inference_from_evidence",
  "safety_policy",
  "schema_instruction",
  "system_contract",
  "telemetry_label",
]);

const DEFAULT_SECTION_PRIORITY_RULES: readonly PromptSectionPriorityRule[] = freezeArray([
  makePriorityRule("SystemRole", 1, true, "never_drop", "Stable embodied role and output discipline are always retained."),
  makePriorityRule("SafetyPolicySummary", 1, true, "never_drop", "Safety constraints are retained for all live and regression requests."),
  makePriorityRule("OutputContractInstruction", 1, true, "never_drop", "Structured response fields and allowed values are retained."),
  makePriorityRule("TaskInstruction", 2, true, "never_drop", "Current task objective is retained for action-bearing requests."),
  makePriorityRule("CurrentObservation", 2, true, "compact_first", "Latest direct observation is compacted before omission."),
  makePriorityRule("EmbodimentContext", 2, true, "never_drop", "Body capability constraints are retained for planning and control handoff."),
  makePriorityRule("ValidationFeedback", 3, true, "compact_first", "Validator feedback is required for correction and repair."),
  makePriorityRule("MediaAttachments", 4, false, "compact_first", "Duplicate or low-quality media is compacted before omission."),
  makePriorityRule("RecentObservationHistory", 5, false, "compact_first", "History is summarized under budget pressure."),
  makePriorityRule("MemoryContext", 6, false, "omit_under_pressure", "Memory snippets are ranked by relevance and confidence."),
  makePriorityRule("UncertaintyInstruction", 1, true, "never_drop", "Uncertainty and re-observation discipline is always retained."),
  makePriorityRule("TelemetryLabels", 1, true, "never_drop", "Request refs and contract labels are retained for audit."),
]);

const DEFAULT_PROMPT_CONTRACT_DESCRIPTORS: readonly PromptContractDescriptor[] = freezeArray([
  makeDescriptor("PROMPT-OBS-001", "SceneObservation", "SceneObservationReasoning", "SceneUnderstandingResponse", ["SystemRole", "CurrentObservation", "EmbodimentContext", "OutputContractInstruction", "UncertaintyInstruction", "TelemetryLabels"], ["MediaAttachments"], ["MemoryContext", "SafetyPolicySummary", "RecentObservationHistory"], false),
  makeDescriptor("PROMPT-PLAN-001", "TaskPlanning", "TaskPlanningReasoning", "TaskPlanResponse", ["SystemRole", "SafetyPolicySummary", "TaskInstruction", "CurrentObservation", "EmbodimentContext", "OutputContractInstruction", "UncertaintyInstruction", "TelemetryLabels"], ["MemoryContext"], ["RecentObservationHistory"], true),
  makeDescriptor("PROMPT-WAY-001", "WaypointGeneration", "WaypointGenerationReasoning", "WaypointPlanResponse", ["SystemRole", "SafetyPolicySummary", "TaskInstruction", "CurrentObservation", "EmbodimentContext", "OutputContractInstruction", "UncertaintyInstruction", "TelemetryLabels"], ["ValidationFeedback", "MediaAttachments"], ["MemoryContext", "RecentObservationHistory"], true),
  makeDescriptor("PROMPT-MV-001", "MultiViewDisambiguation", "MultiViewDisambiguationReasoning", "MultiViewConsensusResponse", ["SystemRole", "CurrentObservation", "MediaAttachments", "OutputContractInstruction", "UncertaintyInstruction", "TelemetryLabels"], ["EmbodimentContext"], ["MemoryContext", "RecentObservationHistory"], false),
  makeDescriptor("PROMPT-VERIFY-001", "SpatialVerification", "SpatialVerificationReasoning", "VisualVerificationResponse", ["SystemRole", "SafetyPolicySummary", "CurrentObservation", "OutputContractInstruction", "UncertaintyInstruction", "TelemetryLabels"], ["MediaAttachments", "EmbodimentContext"], ["MemoryContext", "RecentObservationHistory"], false),
  makeDescriptor("PROMPT-OOPS-001", "FailureCorrection", "OopsCorrectionReasoning", "CorrectionPlanResponse", ["SystemRole", "SafetyPolicySummary", "TaskInstruction", "CurrentObservation", "ValidationFeedback", "EmbodimentContext", "OutputContractInstruction", "UncertaintyInstruction", "TelemetryLabels"], ["MediaAttachments"], ["MemoryContext", "RecentObservationHistory"], true),
  makeDescriptor("PROMPT-TOOL-001", "ToolUseReasoning", "ToolUseReasoning", "ToolUsePlanResponse", ["SystemRole", "SafetyPolicySummary", "TaskInstruction", "CurrentObservation", "EmbodimentContext", "OutputContractInstruction", "UncertaintyInstruction", "TelemetryLabels"], ["MediaAttachments", "ValidationFeedback"], ["MemoryContext", "RecentObservationHistory"], true),
  makeDescriptor("PROMPT-AUD-001", "AcousticReasoning", "AudioEventReasoning", "AudioActionResponse", ["SystemRole", "SafetyPolicySummary", "CurrentObservation", "OutputContractInstruction", "UncertaintyInstruction", "TelemetryLabels"], ["EmbodimentContext", "MediaAttachments"], ["MemoryContext", "RecentObservationHistory"], true),
  makeDescriptor("PROMPT-MEM-001", "MemoryAssimilation", "MemoryAssimilationReasoning", "MemoryWriteCandidateResponse", ["SystemRole", "CurrentObservation", "MemoryContext", "OutputContractInstruction", "UncertaintyInstruction", "TelemetryLabels"], ["ValidationFeedback"], ["SafetyPolicySummary", "RecentObservationHistory"], false),
  makeDescriptor("PROMPT-MONO-001", "InternalMonologue", "InternalMonologueReasoning", "MonologueResponse", ["SystemRole", "SafetyPolicySummary", "TaskInstruction", "ValidationFeedback", "OutputContractInstruction", "UncertaintyInstruction", "TelemetryLabels"], ["CurrentObservation"], ["MemoryContext", "RecentObservationHistory"], false),
]);

export const COGNITIVE_PROMPT_PACKET_CONTRACT_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: COGNITIVE_PROMPT_PACKET_CONTRACT_SCHEMA_VERSION,
  blueprint: "architecture_docs/07_PROMPT_CONTRACTS_AND_STRUCTURED_OUTPUTS.md",
  sections: freezeArray(["7.3", "7.4", "7.5", "7.7", "7.8", "7.9", "7.10", "7.11"]),
});
