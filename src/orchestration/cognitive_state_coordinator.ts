/**
 * Cognitive state coordinator for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md`
 * sections 8.3, 8.5, 8.12, 8.13, 8.14, and 8.15.
 *
 * This module implements the executable `CognitiveStateCoordinator`. It gates
 * cognitive-facing state entry by resolving the correct prompt and response
 * contracts, assembling only provenance-labeled context, applying the prompt
 * firewall and no-RL compliance scanners, enforcing context budget decisions,
 * and returning Gemini-ready request envelopes for Plan, Correct, ToolAssess,
 * AudioAttend, and Monologue state work.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import {
  GEMINI_ROBOTICS_ER_APPROVED_MODEL,
  GEMINI_ROBOTICS_ER_INPUT_TOKEN_LIMIT,
} from "../cognitive/gemini_robotics_er_adapter";
import type {
  CognitiveInvocationClass,
  CognitiveInvocationPolicy,
  CognitiveMediaPart,
  CognitivePromptSection,
  CognitiveRequestEnvelope,
  OutputContractDefinition,
} from "../cognitive/gemini_robotics_er_adapter";
import { ContextBudgetManager } from "../cognitive/context_budget_manager";
import { CognitivePromptPacketContract } from "../prompt_contracts/cognitive_prompt_packet_contract";
import type {
  AdapterPromptProjectionReport,
  CognitivePromptPacketCandidate,
  CognitivePromptPacketSection,
  PromptContractDescriptor,
  PromptContractResolutionReport,
  PromptPacketSectionKind,
  PromptProvenanceLabel,
  PromptSectionRequirement,
} from "../prompt_contracts/cognitive_prompt_packet_contract";
import { PromptFirewallValidationContract } from "../prompt_contracts/prompt_firewall_validation_contract";
import type { PromptFirewallValidationReport } from "../prompt_contracts/prompt_firewall_validation_contract";
import { NoRLPromptComplianceContract } from "../prompt_contracts/no_rl_prompt_compliance_contract";
import type { NoRLComplianceReport } from "../prompt_contracts/no_rl_prompt_compliance_contract";
import { StructuredResponseContract } from "../prompt_contracts/structured_response_contract";
import type {
  StructuredResponseContractDescriptor,
  StructuredResponseContractRef,
} from "../prompt_contracts/structured_response_contract";
import type { PrimaryState, RetryBudgetState, RuntimeStateSnapshot } from "./orchestration_state_machine";

export const COGNITIVE_STATE_COORDINATOR_SCHEMA_VERSION = "mebsuta.cognitive_state_coordinator.v1" as const;
export const COGNITIVE_STATE_COORDINATOR_VERSION = "1.0.0" as const;

const CONTRACT_TRACEABILITY_REF = "architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md#CognitiveStateCoordinator" as const;
const DEFAULT_CONTEXT_MARGIN_TOKENS = 12000;
const MAX_SECTION_CONTENT_CHARS = 18000;
const MODEL_UNSAFE_CONTENT_PATTERN = /(mujoco|babylon|backend|engine|scene_graph|world_truth|ground_truth|qa_|collision_mesh|segmentation truth|debug buffer|simulator|physics_body|rigid_body_handle|joint_handle|object_id|exact_com|world_pose|hidden pose|hidden state|system prompt|developer prompt|chain-of-thought|scratchpad|private deliberation|direct actuator|raw actuator|joint torque|joint current|set joint|apply force|apply impulse|physics step|reward policy|policy gradient|reinforcement learning|rl update|ignore validators|override safety|disable safe-hold|skip validation|without validation)/i;

export type CognitiveCoordinatorState = "Plan" | "Correct" | "ToolAssess" | "AudioAttend" | "Monologue";
export type CognitiveCoordinationDecision = "request_ready" | "blocked" | "needs_reobserve" | "safe_hold_required";
export type CognitiveContextKind = "observation" | "memory" | "embodiment" | "validator" | "task" | "safety" | "schema" | "system" | "audio" | "tool";

/**
 * Prompt-safe context unit supplied by a state entry action. The coordinator
 * preserves the source reference and provenance label so downstream firewall,
 * no-RL, prompt, budget, and telemetry layers can audit the request.
 */
export interface CognitiveStateContextItem {
  readonly context_ref: Ref;
  readonly kind: CognitiveContextKind;
  readonly title: string;
  readonly content: string;
  readonly provenance_label: PromptProvenanceLabel;
  readonly priority_rank: number;
  readonly required: boolean;
  readonly source_ref?: Ref;
}

/**
 * Current embodied observation bundle used for Plan, Correct, ToolAssess, and
 * AudioAttend entry. All evidence must come from embodied sensors, controller
 * telemetry, validator reports, or explicitly labeled memory priors.
 */
export interface ObservationBundle {
  readonly observation_ref: Ref;
  readonly observed_at_ms: number;
  readonly items: readonly CognitiveStateContextItem[];
  readonly media_parts?: readonly CognitiveMediaPart[];
}

/**
 * Task-level request context shared by cognitive-facing state entry methods.
 */
export interface TaskContext {
  readonly task_ref: Ref;
  readonly task_instruction: string;
  readonly embodiment_context: string;
  readonly safety_policy_summary: string;
  readonly telemetry_labels?: readonly Ref[];
}

/**
 * Failure evidence for the Correct state. The failure summary is model-facing,
 * but it remains validator/controller/sensor derived and never becomes an
 * execution command.
 */
export interface FailureEventContext {
  readonly failure_ref: Ref;
  readonly failure_kind: "execution_failure" | "verification_failure" | "audio_impact" | "validator_rejection" | "safety_interruption";
  readonly summary: string;
  readonly evidence_refs: readonly Ref[];
  readonly occurred_at_ms: number;
}

/**
 * Safety profile summary applied to Correct state work orders.
 */
export interface CorrectionSafetyProfile {
  readonly safety_profile_ref: Ref;
  readonly summary: string;
  readonly safe_hold_allowed: boolean;
  readonly human_review_on_exhaustion: boolean;
}

/**
 * Optional runtime context used to bind a cognitive request to the current
 * authoritative state snapshot.
 */
export interface CognitiveStateEntryMetadata {
  readonly entry_ref?: Ref;
  readonly snapshot?: RuntimeStateSnapshot;
  readonly created_at_ms?: number;
  readonly expected_prompt_contract_ref?: Ref;
  readonly additional_safety_annotations?: readonly string[];
}

/**
 * Generic request for cognitive-facing states other than Correct.
 */
export interface CognitiveStateEntryRequest extends CognitiveStateEntryMetadata {
  readonly target_state: CognitiveCoordinatorState;
  readonly observation_bundle: ObservationBundle;
  readonly task_context: TaskContext;
  readonly memory_context?: readonly CognitiveStateContextItem[];
  readonly validation_feedback?: readonly CognitiveStateContextItem[];
}

/**
 * Correct-state request matching File 08's `enterCorrectState` signature.
 */
export interface CorrectStateEntryRequest extends CognitiveStateEntryMetadata {
  readonly failure_event: FailureEventContext;
  readonly evidence_bundle: ObservationBundle;
  readonly retry_budget: RetryBudgetState;
  readonly safety_profile: CorrectionSafetyProfile;
  readonly task_context: TaskContext;
  readonly memory_context?: readonly CognitiveStateContextItem[];
  readonly validation_feedback?: readonly CognitiveStateContextItem[];
}

/**
 * Complete coordination result for a cognitive state entry. A ready decision
 * includes a compacted Gemini request envelope and invocation policy; blocked
 * decisions include the same validation reports without a request envelope.
 */
export interface CognitiveStateCoordinationReport {
  readonly schema_version: typeof COGNITIVE_STATE_COORDINATOR_SCHEMA_VERSION;
  readonly coordinator_version: typeof COGNITIVE_STATE_COORDINATOR_VERSION;
  readonly state: CognitiveCoordinatorState;
  readonly decision: CognitiveCoordinationDecision;
  readonly request_envelope?: CognitiveRequestEnvelope;
  readonly invocation_policy: CognitiveInvocationPolicy;
  readonly prompt_contract_report: PromptContractResolutionReport;
  readonly response_contract: StructuredResponseContractDescriptor;
  readonly adapter_output_contract: OutputContractDefinition;
  readonly prompt_packet?: CognitivePromptPacketCandidate;
  readonly projection_report?: AdapterPromptProjectionReport;
  readonly firewall_report?: PromptFirewallValidationReport;
  readonly no_rl_report?: NoRLComplianceReport;
  readonly issue_count: number;
  readonly error_count: number;
  readonly warning_count: number;
  readonly issues: readonly ValidationIssue[];
  readonly traceability_ref: typeof CONTRACT_TRACEABILITY_REF;
  readonly determinism_hash: string;
}

/**
 * Correct-state work order returned after failure evidence is gated. It carries
 * retry and safety metadata alongside the cognitive request coordination report.
 */
export interface CorrectionWorkOrder {
  readonly schema_version: typeof COGNITIVE_STATE_COORDINATOR_SCHEMA_VERSION;
  readonly work_order_ref: Ref;
  readonly failure_ref: Ref;
  readonly retry_budget_ref: Ref;
  readonly safety_profile_ref: Ref;
  readonly coordination_report: CognitiveStateCoordinationReport;
  readonly can_request_model: boolean;
  readonly terminal_on_retry_exhaustion: "SafeHold" | "HumanReview";
  readonly determinism_hash: string;
}

/**
 * Error thrown by convenience entry methods when callers request a bare
 * `CognitiveRequestEnvelope` but coordination blocks the request.
 */
export class CognitiveStateCoordinationError extends Error {
  public readonly report: CognitiveStateCoordinationReport;

  public constructor(message: string, report: CognitiveStateCoordinationReport) {
    super(message);
    this.name = "CognitiveStateCoordinationError";
    this.report = report;
  }
}

/**
 * Deterministic state-entry gate for all Gemini-bound orchestration states.
 */
export class CognitiveStateCoordinator {
  private readonly promptContract: CognitivePromptPacketContract;
  private readonly firewall: PromptFirewallValidationContract;
  private readonly noRlCompliance: NoRLPromptComplianceContract;
  private readonly structuredResponses: StructuredResponseContract;
  private readonly budgetManager: ContextBudgetManager;
  private readonly nowMs: () => number;

  public constructor(options: {
    readonly prompt_contract?: CognitivePromptPacketContract;
    readonly firewall?: PromptFirewallValidationContract;
    readonly no_rl_compliance?: NoRLPromptComplianceContract;
    readonly structured_responses?: StructuredResponseContract;
    readonly budget_manager?: ContextBudgetManager;
    readonly now_ms?: () => number;
  } = {}) {
    this.promptContract = options.prompt_contract ?? new CognitivePromptPacketContract();
    this.firewall = options.firewall ?? new PromptFirewallValidationContract();
    this.noRlCompliance = options.no_rl_compliance ?? new NoRLPromptComplianceContract();
    this.structuredResponses = options.structured_responses ?? new StructuredResponseContract();
    this.budgetManager = options.budget_manager ?? new ContextBudgetManager();
    this.nowMs = options.now_ms ?? (() => Date.now());
  }

  /**
   * File 08 entry action for Plan. Returns a Gemini-ready envelope or throws a
   * coordination error with full prompt/firewall/no-RL/budget diagnostics.
   */
  public enterPlanState(
    observationBundle: ObservationBundle,
    promptContractRef: Ref,
    taskContext: TaskContext,
    memoryContext: readonly CognitiveStateContextItem[] = [],
    metadata: CognitiveStateEntryMetadata = {},
  ): CognitiveRequestEnvelope {
    const report = this.coordinateStateEntry({
      ...metadata,
      target_state: "Plan",
      observation_bundle: observationBundle,
      task_context: taskContext,
      memory_context: memoryContext,
      expected_prompt_contract_ref: promptContractRef,
    });
    return requireEnvelope(report);
  }

  /**
   * File 08 entry action for Correct. The work order is model-callable only
   * after failure evidence, retry budget, and safety profile checks succeed.
   */
  public enterCorrectState(
    failureEvent: FailureEventContext,
    evidenceBundle: ObservationBundle,
    retryBudget: RetryBudgetState,
    safetyProfile: CorrectionSafetyProfile,
    taskContext: TaskContext,
    metadata: CognitiveStateEntryMetadata = {},
  ): CorrectionWorkOrder {
    const report = this.coordinateCorrectState({
      ...metadata,
      failure_event: failureEvent,
      evidence_bundle: evidenceBundle,
      retry_budget: retryBudget,
      safety_profile: safetyProfile,
      task_context: taskContext,
    });
    const base = {
      schema_version: COGNITIVE_STATE_COORDINATOR_SCHEMA_VERSION,
      work_order_ref: makeRef("correction_work_order", failureEvent.failure_ref, taskContext.task_ref),
      failure_ref: failureEvent.failure_ref,
      retry_budget_ref: retryBudget.scope_ref,
      safety_profile_ref: safetyProfile.safety_profile_ref,
      coordination_report: report,
      can_request_model: report.decision === "request_ready",
      terminal_on_retry_exhaustion: safetyProfile.human_review_on_exhaustion ? "HumanReview" as const : "SafeHold" as const,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Coordinates Plan, ToolAssess, AudioAttend, or Monologue state entry while
   * returning all validation artifacts for telemetry and regression.
   */
  public coordinateStateEntry(request: CognitiveStateEntryRequest): CognitiveStateCoordinationReport {
    if (request.target_state === "Correct") {
      return makeEarlyReport("Correct", "blocked", this.defaultPolicy("Correct"), this.resolveContracts("Correct", request.snapshot?.current_context_ref ?? request.task_context.task_ref), [
        issue("error", "UseCorrectEntryRequest", "$.target_state", "Correct requires failure evidence, retry budget, and safety profile.", "Call coordinateCorrectState or enterCorrectState."),
      ]);
    }
    return this.coordinateGenericState(request);
  }

  /**
   * Coordinates Correct state entry and returns the same diagnostics used by the
   * correction work-order API.
   */
  public coordinateCorrectState(request: CorrectStateEntryRequest): CognitiveStateCoordinationReport {
    const failureItem: CognitiveStateContextItem = Object.freeze({
      context_ref: request.failure_event.failure_ref,
      kind: "validator",
      title: `${request.failure_event.failure_kind} evidence`,
      content: [
        request.failure_event.summary,
        `Evidence refs: ${request.failure_event.evidence_refs.join(", ") || "none"}.`,
        `Retry budget ${request.retry_budget.budget_name} has ${request.retry_budget.remaining_attempts} remaining attempts.`,
        `Safety profile ${request.safety_profile.safety_profile_ref}: ${request.safety_profile.summary}`,
      ].join(" "),
      provenance_label: "validator_feedback",
      priority_rank: 1,
      required: true,
      source_ref: request.failure_event.failure_ref,
    });
    return this.coordinateGenericState({
      ...request,
      target_state: "Correct",
      observation_bundle: request.evidence_bundle,
      task_context: {
        ...request.task_context,
        safety_policy_summary: `${request.task_context.safety_policy_summary} ${request.safety_profile.summary}`.trim(),
      },
      validation_feedback: [failureItem, ...(request.validation_feedback ?? [])],
      expected_prompt_contract_ref: request.expected_prompt_contract_ref,
    });
  }

  /**
   * Convenience entry for visible tool reasoning after reach limitation.
   */
  public enterToolAssessState(request: Omit<CognitiveStateEntryRequest, "target_state">): CognitiveStateCoordinationReport {
    return this.coordinateStateEntry({ ...request, target_state: "ToolAssess" });
  }

  /**
   * Convenience entry for acoustic attention reasoning. The request may include
   * audio media parts, visual reconciliation context, and safety annotations.
   */
  public enterAudioAttendState(request: Omit<CognitiveStateEntryRequest, "target_state">): CognitiveStateCoordinationReport {
    return this.coordinateStateEntry({ ...request, target_state: "AudioAttend" });
  }

  /**
   * Convenience entry for public monologue generation after plan validation.
   */
  public enterMonologueState(request: Omit<CognitiveStateEntryRequest, "target_state">): CognitiveStateCoordinationReport {
    return this.coordinateStateEntry({ ...request, target_state: "Monologue" });
  }

  private coordinateGenericState(request: CognitiveStateEntryRequest): CognitiveStateCoordinationReport {
    const state = request.target_state;
    const invocationClass = invocationForState(state);
    const taskStateRef = request.snapshot?.current_context_ref ?? makeRef("task_state", request.task_context.task_ref, state, request.observation_bundle.observation_ref);
    const contracts = this.resolveContracts(state, taskStateRef);
    const policy = this.defaultPolicy(state);
    const preflightIssues = [
      ...validateStateRequest(request),
      ...validatePrimaryStateCompatibility(state, request.snapshot?.primary_state),
      ...validateExpectedPromptContract(request.expected_prompt_contract_ref, contracts.promptContractReport.descriptor),
    ];

    if (contracts.promptContractReport.descriptor === undefined) {
      return makeEarlyReport(state, "blocked", policy, contracts, preflightIssues);
    }

    const packet = makePromptPacket({
      state,
      invocationClass,
      descriptor: contracts.promptContractReport.descriptor,
      taskStateRef,
      entryRef: request.entry_ref,
      observationBundle: request.observation_bundle,
      taskContext: request.task_context,
      memoryContext: request.memory_context ?? [],
      validationFeedback: request.validation_feedback ?? [],
      createdAtMs: request.created_at_ms ?? this.nowMs(),
    });
    const promptValidation = this.promptContract.validatePromptPacket(packet);
    const firewallReport = this.firewall.validatePromptPacket(packet);
    const noRlReport = this.noRlCompliance.validatePromptPacket(packet);
    const projection = this.promptContract.projectToAdapterSections(packet, GEMINI_ROBOTICS_ER_INPUT_TOKEN_LIMIT, DEFAULT_CONTEXT_MARGIN_TOKENS);
    const rawEnvelope = makeRequestEnvelope({
      state,
      invocationClass,
      packet,
      taskContext: request.task_context,
      responseContract: contracts.responseContract,
      adapterSections: projection.adapter_sections,
      mediaParts: request.observation_bundle.media_parts ?? [],
      additionalSafetyAnnotations: request.additional_safety_annotations ?? [],
    });
    const budgetDecision = this.budgetManager.estimateRequestEnvelopeBudget(rawEnvelope);
    const budgetEnvelope = budgetDecision.compacted_envelope === undefined
      ? undefined
      : Object.freeze({ ...budgetDecision.compacted_envelope, budget_report: budgetDecision.budget_report });
    const issues = freezeArray([
      ...preflightIssues,
      ...contracts.promptContractReport.issues,
      ...promptValidation.issues,
      ...firewallReport.issues,
      ...noRlReport.issues,
      ...projection.issues,
      ...budgetDecision.decision_report.issues,
      ...budgetDecision.budget_report.issues,
    ]);
    const decision = decideCoordination({
      state,
      observationItemCount: request.observation_bundle.items.length,
      promptDecision: promptValidation.decision,
      firewallDecision: firewallReport.decision,
      noRlDecision: noRlReport.decision,
      budgetReady: budgetEnvelope !== undefined && budgetDecision.decision_report.decision !== "rejected_over_budget",
      issues,
    });
    const envelope = decision === "request_ready" ? budgetEnvelope : undefined;
    return makeReport({
      state,
      decision,
      envelope,
      policy,
      contracts,
      packet,
      projection,
      firewallReport,
      noRlReport,
      issues,
    });
  }

  private resolveContracts(state: CognitiveCoordinatorState, taskStateRef: Ref): ResolvedCoordinatorContracts {
    const invocationClass = invocationForState(state);
    const promptContractReport = this.promptContract.resolvePromptContract(invocationClass, taskStateRef, GEMINI_ROBOTICS_ER_APPROVED_MODEL);
    const responseContract = this.structuredResponses.resolveForInvocation(invocationClass);
    const adapterOutputContract = this.structuredResponses.getAdapterOutputContract(responseContract.contract_ref);
    return Object.freeze({
      promptContractReport,
      responseContract,
      adapterOutputContract,
    });
  }

  private defaultPolicy(state: CognitiveCoordinatorState): CognitiveInvocationPolicy {
    const invocationClass = invocationForState(state);
    return Object.freeze({
      model_identifier: GEMINI_ROBOTICS_ER_APPROVED_MODEL,
      temperature_class: state === "Monologue" ? "low" : "deterministic",
      thinking_budget_class: thinkingBudgetFor(invocationClass),
      retry_class: state === "Plan" || state === "Correct" || state === "ToolAssess" ? "single_repair" : "none",
      timeout_ms: timeoutFor(state),
      max_output_tokens: state === "Monologue" ? 2048 : state === "AudioAttend" ? 4096 : 12000,
      allow_preview_model: true,
      require_structured_output: true,
    });
  }
}

interface ResolvedCoordinatorContracts {
  readonly promptContractReport: PromptContractResolutionReport;
  readonly responseContract: StructuredResponseContractDescriptor;
  readonly adapterOutputContract: OutputContractDefinition;
}

interface PromptPacketInput {
  readonly state: CognitiveCoordinatorState;
  readonly invocationClass: CognitiveInvocationClass;
  readonly descriptor: PromptContractDescriptor;
  readonly taskStateRef: Ref;
  readonly entryRef?: Ref;
  readonly observationBundle: ObservationBundle;
  readonly taskContext: TaskContext;
  readonly memoryContext: readonly CognitiveStateContextItem[];
  readonly validationFeedback: readonly CognitiveStateContextItem[];
  readonly createdAtMs: number;
}

interface RequestEnvelopeInput {
  readonly state: CognitiveCoordinatorState;
  readonly invocationClass: CognitiveInvocationClass;
  readonly packet: CognitivePromptPacketCandidate;
  readonly taskContext: TaskContext;
  readonly responseContract: StructuredResponseContractDescriptor;
  readonly adapterSections: readonly CognitivePromptSection[];
  readonly mediaParts: readonly CognitiveMediaPart[];
  readonly additionalSafetyAnnotations: readonly string[];
}

interface ReportInput {
  readonly state: CognitiveCoordinatorState;
  readonly decision: CognitiveCoordinationDecision;
  readonly envelope?: CognitiveRequestEnvelope;
  readonly policy: CognitiveInvocationPolicy;
  readonly contracts: ResolvedCoordinatorContracts;
  readonly packet?: CognitivePromptPacketCandidate;
  readonly projection?: AdapterPromptProjectionReport;
  readonly firewallReport?: PromptFirewallValidationReport;
  readonly noRlReport?: NoRLComplianceReport;
  readonly issues: readonly ValidationIssue[];
}

function makePromptPacket(input: PromptPacketInput): CognitivePromptPacketCandidate {
  const sectionsByKind = new Map<PromptPacketSectionKind, CognitivePromptPacketSection[]>();
  const addSection = (section: CognitivePromptPacketSection): void => {
    const existing = sectionsByKind.get(section.section_kind) ?? [];
    sectionsByKind.set(section.section_kind, [...existing, section]);
  };

  addSection(makeSection(input, "SystemRole", "system_contract", "system", "Coordinator role", systemRoleText(input.state), "coordinator:system_role", "required", 1));
  addSection(makeSection(input, "SafetyPolicySummary", "safety_policy", "safety", "Safety policy", input.taskContext.safety_policy_summary, "coordinator:safety_policy", "required", 1));
  addSection(makeSection(input, "TaskInstruction", "human_instruction", "task", "Task instruction", input.taskContext.task_instruction, input.taskContext.task_ref, "required", 2));
  addSection(makeContextSection(input, "CurrentObservation", observationText(input.observationBundle), "sensor_visual_current", input.observationBundle.observation_ref, "Current embodied evidence", "required", 2));
  addSection(makeSection(input, "EmbodimentContext", "embodiment_self_knowledge", "embodiment", "Embodiment context", input.taskContext.embodiment_context, "coordinator:embodiment_context", "required", 2));
  addSection(makeSection(input, "OutputContractInstruction", "schema_instruction", "schema", "Structured output contract", outputContractText(input.descriptor.output_contract_ref), input.descriptor.output_contract_ref, "required", 1));
  addSection(makeSection(input, "UncertaintyInstruction", "schema_instruction", "schema", "Uncertainty discipline", uncertaintyText(input.state), "coordinator:uncertainty_policy", "required", 1));
  addSection(makeSection(input, "TelemetryLabels", "telemetry_label", "schema", "Telemetry labels", telemetryText(input), "coordinator:telemetry_labels", "required", 1));

  for (const item of input.memoryContext) {
    addSection(contextItemToSection(input, item, "MemoryContext", "optional"));
  }
  for (const item of input.validationFeedback) {
    addSection(contextItemToSection(input, item, "ValidationFeedback", "conditional"));
  }
  for (const item of input.observationBundle.items.filter((item) => item.kind === "audio" || item.kind === "tool")) {
    addSection(contextItemToSection(input, item, "RecentObservationHistory", "optional"));
  }

  const sections = requiredAndAvailableSections(input.descriptor, sectionsByKind);
  const telemetryLabels = freezeArray([
    makeRef("telemetry", input.state, input.invocationClass),
    makeRef("prompt_contract", input.descriptor.contract_id),
    makeRef("response_contract", input.descriptor.output_contract_ref),
    ...(input.taskContext.telemetry_labels ?? []),
  ]);
  return Object.freeze({
    packet_ref: input.entryRef ?? makeRef("cognitive_packet", input.taskContext.task_ref, input.state, input.createdAtMs),
    descriptor: input.descriptor,
    task_state_ref: input.taskStateRef,
    sections,
    media_refs: freezeArray((input.observationBundle.media_parts ?? []).map((part) => part.media_ref)),
    telemetry_labels: telemetryLabels,
    created_at_ms: input.createdAtMs,
  });
}

function makeRequestEnvelope(input: RequestEnvelopeInput): CognitiveRequestEnvelope {
  const memorySections = input.adapterSections.filter((section) => section.provenance === "memory");
  const validatorSections = input.adapterSections.filter((section) => section.provenance === "validator");
  const observationSections = input.adapterSections.filter((section) => section.provenance !== "memory" && section.provenance !== "validator");
  return Object.freeze({
    request_ref: makeRef("cognitive_request", input.packet.packet_ref, input.invocationClass),
    invocation_class: input.invocationClass,
    model_identifier: GEMINI_ROBOTICS_ER_APPROVED_MODEL,
    task_instruction: input.taskContext.task_instruction,
    observation_sections: freezeArray(observationSections),
    media_parts: freezeArray(input.mediaParts),
    embodiment_context: input.taskContext.embodiment_context,
    memory_context: freezeArray(memorySections),
    validator_context: freezeArray(validatorSections),
    output_contract_ref: input.responseContract.contract_ref,
    safety_annotations: freezeArray([
      input.taskContext.safety_policy_summary,
      `State ${input.state} may propose structured reasoning only; validators and controllers own approval.`,
      ...input.additionalSafetyAnnotations,
    ].map(compactText)),
  });
}

function requiredAndAvailableSections(
  descriptor: PromptContractDescriptor,
  sectionsByKind: ReadonlyMap<PromptPacketSectionKind, readonly CognitivePromptPacketSection[]>,
): readonly CognitivePromptPacketSection[] {
  const orderedKinds = [
    ...descriptor.required_sections,
    ...descriptor.conditional_sections,
    ...descriptor.optional_sections,
  ];
  const seen = new Set<Ref>();
  const sections: CognitivePromptPacketSection[] = [];
  for (const kind of orderedKinds) {
    for (const section of sectionsByKind.get(kind) ?? []) {
      if (!seen.has(section.section_ref)) {
        seen.add(section.section_ref);
        sections.push(section);
      }
    }
  }
  return freezeArray(sections);
}

function makeSection(
  input: PromptPacketInput,
  sectionKind: PromptPacketSectionKind,
  provenanceLabel: PromptProvenanceLabel,
  kind: CognitiveContextKind,
  title: string,
  content: string,
  sourceRef: Ref,
  requirement: PromptSectionRequirement,
  priorityRank: number,
): CognitivePromptPacketSection {
  const sectionRef = makeRef("section", input.state, sectionKind, sourceRef);
  return Object.freeze({
    section_ref: sectionRef,
    section_kind: sectionKind,
    title,
    content: compactText(content),
    provenance_label: provenanceLabel,
    source_ref: makeRef(kind, sourceRef),
    requirement,
    priority_rank: priorityRank,
    estimated_tokens: estimateTextTokens(content),
    telemetry_label: makeRef("telemetry", sectionRef),
  });
}

function makeContextSection(
  input: PromptPacketInput,
  sectionKind: PromptPacketSectionKind,
  content: string,
  provenanceLabel: PromptProvenanceLabel,
  sourceRef: Ref,
  title: string,
  requirement: PromptSectionRequirement,
  priorityRank: number,
): CognitivePromptPacketSection {
  return makeSection(input, sectionKind, provenanceLabel, "observation", title, content, sourceRef, requirement, priorityRank);
}

function contextItemToSection(
  input: PromptPacketInput,
  item: CognitiveStateContextItem,
  sectionKind: PromptPacketSectionKind,
  requirementOverride?: PromptSectionRequirement,
): CognitivePromptPacketSection {
  return Object.freeze({
    section_ref: makeRef("section", input.state, sectionKind, item.context_ref),
    section_kind: sectionKind,
    title: compactText(item.title),
    content: compactText(item.content),
    provenance_label: item.provenance_label,
    source_ref: item.source_ref ?? item.context_ref,
    requirement: requirementOverride ?? (item.required ? "required" : "optional"),
    priority_rank: item.priority_rank,
    estimated_tokens: estimateTextTokens(item.content),
    telemetry_label: makeRef("telemetry", input.state, item.context_ref),
  });
}

function observationText(bundle: ObservationBundle): string {
  if (bundle.items.length === 0) {
    return "No current observation items were supplied; request fresh embodied evidence before action-bearing reasoning.";
  }
  return bundle.items
    .filter((item) => item.kind === "observation" || item.kind === "audio" || item.kind === "tool")
    .sort((a, b) => a.priority_rank - b.priority_rank || a.context_ref.localeCompare(b.context_ref))
    .map((item) => `${item.title}: ${item.content} [${item.provenance_label}; ${item.context_ref}]`)
    .join("\n");
}

function systemRoleText(state: CognitiveCoordinatorState): string {
  return [
    `State entry: ${state}.`,
    "Use only supplied sensor evidence, memory priors, validator feedback, task text, safety notes, and body capability summaries.",
    "Return structured reasoning proposals with evidence references and uncertainty.",
    "Do not issue controller commands or claim task success; deterministic validators decide approval before execution.",
  ].join(" ");
}

function outputContractText(contractRef: Ref): string {
  return [
    `Return JSON for response_contract_id ${contractRef}.`,
    "Include contract_version_ack, task_state_ref, evidence_used, primary_result, confidence, uncertainties, requires_validation, safety_notes, and forbidden_content_absent.",
    "Use stable evidence references from the prompt and request re-observation when evidence is weak.",
  ].join(" ");
}

function uncertaintyText(state: CognitiveCoordinatorState): string {
  const stateHint = state === "AudioAttend"
    ? "Treat audio direction and identity as estimates until reconciled with visual or contact evidence."
    : state === "ToolAssess"
      ? "Reject tool use when visibility, attachment, swept volume, or release safety is uncertain."
      : state === "Monologue"
        ? "Produce concise public speech and include an interruptible safety policy."
        : "Prefer re-observation or safe hold when evidence is insufficient.";
  return `${stateHint} Separate observed evidence from inference and expose residual uncertainty explicitly.`;
}

function telemetryText(input: PromptPacketInput): string {
  return [
    `coordinator_version=${COGNITIVE_STATE_COORDINATOR_VERSION}`,
    `state=${input.state}`,
    `invocation_class=${input.invocationClass}`,
    `prompt_contract=${input.descriptor.contract_id}`,
    `response_contract=${input.descriptor.output_contract_ref}`,
    `task_state_ref=${input.taskStateRef}`,
  ].join("\n");
}

function validateStateRequest(request: CognitiveStateEntryRequest): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateRef(request.observation_bundle.observation_ref, "$.observation_bundle.observation_ref", issues);
  validateRef(request.task_context.task_ref, "$.task_context.task_ref", issues);
  validateText(request.task_context.task_instruction, "$.task_context.task_instruction", true, issues);
  validateText(request.task_context.embodiment_context, "$.task_context.embodiment_context", true, issues);
  validateText(request.task_context.safety_policy_summary, "$.task_context.safety_policy_summary", true, issues);
  for (const [index, item] of [
    ...request.observation_bundle.items,
    ...(request.memory_context ?? []),
    ...(request.validation_feedback ?? []),
  ].entries()) {
    validateContextItem(item, `$.context_items[${index}]`, issues);
  }
  for (const [index, media] of (request.observation_bundle.media_parts ?? []).entries()) {
    validateRef(media.media_ref, `$.media_parts[${index}].media_ref`, issues);
    if (media.provenance !== "virtual_sensor" && media.provenance !== "perception_excerpt") {
      issues.push(issue("error", "MediaProvenanceRejected", `$.media_parts[${index}].provenance`, "Cognitive media must be virtual sensor output or perception excerpts.", "Attach embodied perception media only."));
    }
  }
  if ((request.target_state === "Plan" || request.target_state === "ToolAssess" || request.target_state === "AudioAttend") && request.observation_bundle.items.length === 0) {
    issues.push(issue("warning", "ObservationContextEmpty", "$.observation_bundle.items", "Cognitive state entry has no current observation items.", "Enter Reobserve before model reasoning if no evidence is available."));
  }
  return freezeArray(issues);
}

function validatePrimaryStateCompatibility(state: CognitiveCoordinatorState, primaryState: PrimaryState | undefined): readonly ValidationIssue[] {
  if (primaryState === undefined || primaryState === state) {
    return freezeArray([]);
  }
  const compatible: Readonly<Record<CognitiveCoordinatorState, readonly PrimaryState[]>> = {
    Plan: ["Plan", "Observe", "Reobserve", "HumanReview"],
    Correct: ["Correct", "Execute", "Verify", "SafeHold"],
    ToolAssess: ["ToolAssess", "Validate"],
    AudioAttend: ["AudioAttend", "Observe"],
    Monologue: ["Monologue", "Validate"],
  };
  return compatible[state].includes(primaryState)
    ? freezeArray([issue("warning", "CompatibleSourceState", "$.snapshot.primary_state", `Request is entering ${state} from compatible source state ${primaryState}.`, "Commit the state transition before submitting the model request when operating live.")])
    : freezeArray([issue("error", "PrimaryStateMismatch", "$.snapshot.primary_state", `Cannot enter ${state} from primary state ${primaryState}.`, "Use the OrchestrationStateMachine transition table before building cognitive work.")]);
}

function validateExpectedPromptContract(expected: Ref | undefined, descriptor: PromptContractDescriptor | undefined): readonly ValidationIssue[] {
  if (expected === undefined || descriptor === undefined) {
    return freezeArray([]);
  }
  const accepted = new Set<Ref>([descriptor.contract_id, descriptor.output_contract_ref, descriptor.traceability_ref]);
  return accepted.has(expected)
    ? freezeArray([])
    : freezeArray([issue("error", "PromptContractMismatch", "$.expected_prompt_contract_ref", `Expected prompt contract ${expected} does not match ${descriptor.contract_id}.`, "Use the state-specific prompt contract resolved from File 07.")]);
}

function validateContextItem(item: CognitiveStateContextItem, path: string, issues: ValidationIssue[]): void {
  validateRef(item.context_ref, `${path}.context_ref`, issues);
  validateRef(item.source_ref ?? item.context_ref, `${path}.source_ref`, issues);
  validateText(item.title, `${path}.title`, true, issues);
  validateText(item.content, `${path}.content`, item.required, issues);
  if (item.priority_rank < 0 || Number.isFinite(item.priority_rank) === false) {
    issues.push(issue("error", "ContextPriorityInvalid", `${path}.priority_rank`, "Context priority must be finite and non-negative.", "Normalize priority before state entry."));
  }
}

function validateText(value: string, path: string, required: boolean, issues: ValidationIssue[]): void {
  if (required && value.trim().length === 0) {
    issues.push(issue("error", "RequiredTextMissing", path, "Required model-facing text is empty.", "Provide concise prompt-safe text."));
  }
  if (MODEL_UNSAFE_CONTENT_PATTERN.test(value)) {
    issues.push(issue("error", "UnsafeModelFacingText", path, "Model-facing text contains restricted implementation, oracle, private reasoning, control, or validator-bypass wording.", "Replace it with embodied evidence, safe summaries, or opaque references."));
  }
}

function validateRef(ref: Ref, path: string, issues: ValidationIssue[]): void {
  if (ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(issue("error", "ReferenceInvalid", path, "Reference must be non-empty and whitespace-free.", "Use a stable opaque reference."));
  }
  if (MODEL_UNSAFE_CONTENT_PATTERN.test(ref)) {
    issues.push(issue("error", "ReferenceUnsafeForCognition", path, "Reference contains wording that cannot cross into cognitive prompts.", "Use an opaque prompt-safe reference."));
  }
}

function decideCoordination(input: {
  readonly state: CognitiveCoordinatorState;
  readonly observationItemCount: number;
  readonly promptDecision: string;
  readonly firewallDecision: string;
  readonly noRlDecision: string;
  readonly budgetReady: boolean;
  readonly issues: readonly ValidationIssue[];
}): CognitiveCoordinationDecision {
  if (input.issues.some((item) => item.severity === "error") || input.promptDecision === "rejected" || input.firewallDecision === "reject" || input.firewallDecision === "quarantine" || input.noRlDecision === "non_compliant" || input.noRlDecision === "quarantine_required" || !input.budgetReady) {
    return input.state === "Correct" || input.state === "ToolAssess" ? "safe_hold_required" : "blocked";
  }
  if (input.observationItemCount === 0 && input.state !== "Monologue") {
    return "needs_reobserve";
  }
  return "request_ready";
}

function makeReport(input: ReportInput): CognitiveStateCoordinationReport {
  const errorCount = input.issues.filter((item) => item.severity === "error").length;
  const warningCount = input.issues.filter((item) => item.severity === "warning").length;
  const base = {
    schema_version: COGNITIVE_STATE_COORDINATOR_SCHEMA_VERSION,
    coordinator_version: COGNITIVE_STATE_COORDINATOR_VERSION,
    state: input.state,
    decision: input.decision,
    request_envelope: input.envelope,
    invocation_policy: input.policy,
    prompt_contract_report: input.contracts.promptContractReport,
    response_contract: input.contracts.responseContract,
    adapter_output_contract: input.contracts.adapterOutputContract,
    prompt_packet: input.packet,
    projection_report: input.projection,
    firewall_report: input.firewallReport,
    no_rl_report: input.noRlReport,
    issue_count: input.issues.length,
    error_count: errorCount,
    warning_count: warningCount,
    issues: freezeArray(input.issues),
    traceability_ref: CONTRACT_TRACEABILITY_REF,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function makeEarlyReport(
  state: CognitiveCoordinatorState,
  decision: CognitiveCoordinationDecision,
  policy: CognitiveInvocationPolicy,
  contracts: ResolvedCoordinatorContracts,
  issues: readonly ValidationIssue[],
): CognitiveStateCoordinationReport {
  return makeReport({
    state,
    decision,
    policy,
    contracts,
    issues: freezeArray([...contracts.promptContractReport.issues, ...issues]),
  });
}

function requireEnvelope(report: CognitiveStateCoordinationReport): CognitiveRequestEnvelope {
  if (report.request_envelope === undefined) {
    throw new CognitiveStateCoordinationError(`Cognitive state ${report.state} was not ready for model request: ${report.decision}.`, report);
  }
  return report.request_envelope;
}

function invocationForState(state: CognitiveCoordinatorState): CognitiveInvocationClass {
  const map: Readonly<Record<CognitiveCoordinatorState, CognitiveInvocationClass>> = {
    Plan: "TaskPlanningReasoning",
    Correct: "OopsCorrectionReasoning",
    ToolAssess: "ToolUseReasoning",
    AudioAttend: "AudioEventReasoning",
    Monologue: "InternalMonologueReasoning",
  };
  return map[state];
}

function thinkingBudgetFor(invocationClass: CognitiveInvocationClass): CognitiveInvocationPolicy["thinking_budget_class"] {
  if (invocationClass === "TaskPlanningReasoning" || invocationClass === "OopsCorrectionReasoning" || invocationClass === "ToolUseReasoning") {
    return "high";
  }
  if (invocationClass === "AudioEventReasoning") {
    return "moderate";
  }
  return "low";
}

function timeoutFor(state: CognitiveCoordinatorState): number {
  const map: Readonly<Record<CognitiveCoordinatorState, number>> = {
    Plan: 5000,
    Correct: 10000,
    ToolAssess: 7000,
    AudioAttend: 3500,
    Monologue: 1000,
  };
  return map[state];
}

function estimateTextTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function compactText(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= MAX_SECTION_CONTENT_CHARS ? compact : `${compact.slice(0, MAX_SECTION_CONTENT_CHARS - 13).trimEnd()} [compacted]`;
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

function issue(severity: ValidationSeverity, code: string, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

export const COGNITIVE_STATE_COORDINATOR_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: COGNITIVE_STATE_COORDINATOR_SCHEMA_VERSION,
  blueprint: "architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md",
  sections: freezeArray(["8.3", "8.5", "8.12", "8.13", "8.14", "8.15"]),
  traceability_ref: CONTRACT_TRACEABILITY_REF,
  output_contracts: freezeArray([
    "TaskPlanResponse",
    "CorrectionPlanResponse",
    "ToolUsePlanResponse",
    "AudioActionResponse",
    "MonologueResponse",
  ] as readonly StructuredResponseContractRef[]),
});
