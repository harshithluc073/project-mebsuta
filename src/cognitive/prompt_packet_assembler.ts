/**
 * Prompt packet assembler for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/06_GEMINI_ROBOTICS_ER_COGNITIVE_LAYER.md`
 * sections 6.5.2, 6.6.1, 6.7.3, 6.12.1, 6.18.1, 6.19, and 6.20.
 *
 * This module builds Gemini Robotics-ER prompt input from allowed task,
 * sensor, memory, validator, safety, schema, and embodiment context. It is
 * deliberately strict about provenance labels, simulation-blindness language,
 * media budget selection, memory staleness labeling, and 131,072-token context
 * limits before a `CognitiveRequestEnvelope` can reach the model adapter.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import {
  GEMINI_ROBOTICS_ER_APPROVED_MODEL,
  GEMINI_ROBOTICS_ER_INPUT_TOKEN_LIMIT,
  GEMINI_ROBOTICS_ER_OUTPUT_TOKEN_LIMIT,
} from "./gemini_robotics_er_adapter";
import type {
  CognitiveBudgetReport,
  CognitiveMediaPart,
  CognitivePromptSection,
  CognitiveRequestEnvelope,
} from "./gemini_robotics_er_adapter";
import type {
  CognitiveInvocationPlan,
  EvidenceKind,
  EvidenceProvenance,
} from "./cognitive_request_router";

export const PROMPT_PACKET_ASSEMBLER_SCHEMA_VERSION = "mebsuta.prompt_packet_assembler.v1" as const;

const FORBIDDEN_PROMPT_DETAIL_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|simulator|hidden|system prompt|chain-of-thought|scratchpad)/i;
const UNSUPPORTED_MODEL_USE_PATTERN = /(live api|audio generation|image generation|direct actuator|joint torque|joint current|physics step|reward policy|reinforcement learning|rl update|override safety|bypass validator)/i;
const TOKEN_CHARS_PER_UNIT = 4;
const DEFAULT_CONTEXT_MARGIN_TOKENS = 12000;
const DEFAULT_MAX_MEDIA_TOKENS = 38000;

export type PromptFactProvenance = "sensor" | "memory" | "embodiment" | "validator" | "task" | "safety" | "schema" | "system";
export type PromptMediaModality = "image" | "video" | "audio";
export type PromptAssemblyDecision = "assembled" | "rejected" | "compacted";
export type MemoryReliability = "likely_current" | "stale_prior" | "contradicted_prior" | "low_confidence_prior";

export interface PromptInputFact {
  readonly fact_ref: Ref;
  readonly title: string;
  readonly content: string;
  readonly provenance: PromptFactProvenance;
  readonly source_ref: Ref;
  readonly priority: number;
  readonly required: boolean;
  readonly confidence: number;
  readonly observed_at_ms?: number;
}

export interface PromptMediaCandidate {
  readonly media_ref: Ref;
  readonly modality: PromptMediaModality;
  readonly mime_type: string;
  readonly data_base64?: string;
  readonly file_uri?: string;
  readonly provenance: "virtual_sensor" | "perception_excerpt";
  readonly priority: number;
  readonly required: boolean;
  readonly quality_score: number;
  readonly observed_at_ms?: number;
  readonly token_cost_estimate?: number;
}

export interface PromptAssemblyRequest {
  readonly request_ref: Ref;
  readonly invocation_plan: CognitiveInvocationPlan;
  readonly task_instruction?: string;
  readonly stable_system_facts?: readonly PromptInputFact[];
  readonly sensor_facts?: readonly PromptInputFact[];
  readonly memory_facts?: readonly PromptInputFact[];
  readonly validator_facts?: readonly PromptInputFact[];
  readonly safety_facts?: readonly PromptInputFact[];
  readonly schema_facts?: readonly PromptInputFact[];
  readonly embodiment_facts?: readonly PromptInputFact[];
  readonly media_candidates?: readonly PromptMediaCandidate[];
  readonly safety_annotations?: readonly string[];
  readonly media_budget_tokens?: number;
  readonly max_input_tokens?: number;
  readonly context_margin_tokens?: number;
}

export interface PromptProvenanceApproval {
  readonly schema_version: typeof PROMPT_PACKET_ASSEMBLER_SCHEMA_VERSION;
  readonly approved: boolean;
  readonly approved_fact_refs: readonly Ref[];
  readonly rejected_fact_refs: readonly Ref[];
  readonly approved_media_refs: readonly Ref[];
  readonly rejected_media_refs: readonly Ref[];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface MediaSelectionReport {
  readonly schema_version: typeof PROMPT_PACKET_ASSEMBLER_SCHEMA_VERSION;
  readonly selected_media: readonly CognitiveMediaPart[];
  readonly omitted_media_refs: readonly Ref[];
  readonly total_estimated_tokens: number;
  readonly media_budget_tokens: number;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface RetrievedMemoryEpisode {
  readonly memory_ref: Ref;
  readonly summary: string;
  readonly confidence: number;
  readonly staleness_s: number;
  readonly contradicted_by_current_observation: boolean;
  readonly relevance_score: number;
}

export interface MemoryStalenessPolicy {
  readonly fresh_s: number;
  readonly stale_s: number;
  readonly minimum_confidence: number;
}

export interface MemoryContradictionReport {
  readonly contradiction_ref: Ref;
  readonly contradicted_memory_refs: readonly Ref[];
  readonly current_observation_summary: string;
}

export interface MemoryAugmentedPromptPacket {
  readonly schema_version: typeof PROMPT_PACKET_ASSEMBLER_SCHEMA_VERSION;
  readonly memory_sections: readonly CognitivePromptSection[];
  readonly omitted_memory_refs: readonly Ref[];
  readonly contradiction_notes: readonly string[];
  readonly determinism_hash: string;
}

export interface ObservationHistoryEntry {
  readonly observation_ref: Ref;
  readonly summary: string;
  readonly salience: number;
  readonly uncertainty: "none" | "low" | "medium" | "high";
  readonly observed_at_ms: number;
  readonly retained_media_refs: readonly Ref[];
}

export interface ObservationHistorySummary {
  readonly schema_version: typeof PROMPT_PACKET_ASSEMBLER_SCHEMA_VERSION;
  readonly section: CognitivePromptSection;
  readonly retained_observation_refs: readonly Ref[];
  readonly omitted_observation_refs: readonly Ref[];
  readonly determinism_hash: string;
}

export interface ObservationSaliencePolicy {
  readonly max_entries: number;
  readonly min_salience: number;
  readonly current_time_ms: number;
  readonly half_life_ms: number;
}

export interface PromptAssemblyReport {
  readonly schema_version: typeof PROMPT_PACKET_ASSEMBLER_SCHEMA_VERSION;
  readonly decision: PromptAssemblyDecision;
  readonly request_envelope?: CognitiveRequestEnvelope;
  readonly provenance_approval: PromptProvenanceApproval;
  readonly media_selection: MediaSelectionReport;
  readonly budget_report: CognitiveBudgetReport;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

/**
 * Assembles prompt-safe text and media into adapter-ready cognitive request
 * envelopes while refusing hidden truth, unsupported capabilities, and
 * over-budget context.
 */
export class PromptPacketAssembler {
  private readonly nowMs: () => number;

  public constructor(nowMs: () => number = () => Date.now()) {
    this.nowMs = nowMs;
  }

  /**
   * Builds a complete `CognitiveRequestEnvelope` from a router plan, facts, and
   * media candidates. The returned report includes deterministic provenance,
   * media, budget, and issue records for telemetry.
   */
  public assemblePromptPacket(request: PromptAssemblyRequest): PromptAssemblyReport {
    const allFacts = collectFacts(request);
    const provenanceApproval = this.validatePromptProvenance(allFacts, request.media_candidates ?? []);
    const mediaSelection = this.selectMediaForCognitiveRequest(
      (request.media_candidates ?? []).filter((candidate) => candidate.modality === "image"),
      (request.media_candidates ?? []).filter((candidate) => candidate.modality === "video"),
      (request.media_candidates ?? []).filter((candidate) => candidate.modality === "audio"),
      request.media_budget_tokens ?? DEFAULT_MAX_MEDIA_TOKENS,
    );
    const approvedFactRefs = new Set(provenanceApproval.approved_fact_refs);
    const sections = factsToSections(allFacts.filter((fact) => approvedFactRefs.has(fact.fact_ref)));
    const requestedSections = selectSectionsByBudget(
      sections,
      request.max_input_tokens ?? GEMINI_ROBOTICS_ER_INPUT_TOKEN_LIMIT,
      request.context_margin_tokens ?? DEFAULT_CONTEXT_MARGIN_TOKENS,
      mediaSelection.total_estimated_tokens,
    );
    const embodimentContext = buildEmbodimentContext(request, requestedSections.included_sections);
    const budgetReport = makeBudgetReport(
      requestedSections.included_sections,
      requestedSections.excluded_section_refs,
      mediaSelection.selected_media,
      mediaSelection.omitted_media_refs,
      request.max_input_tokens ?? GEMINI_ROBOTICS_ER_INPUT_TOKEN_LIMIT,
      request.context_margin_tokens ?? DEFAULT_CONTEXT_MARGIN_TOKENS,
      [...provenanceApproval.issues, ...mediaSelection.issues, ...requestedSections.issues],
    );
    const issues = [
      ...provenanceApproval.issues,
      ...mediaSelection.issues,
      ...requestedSections.issues,
      ...validateInvocationPlanForAssembly(request.invocation_plan),
      ...validateTaskInstruction(request.task_instruction),
    ];
    const decision = decideAssembly(provenanceApproval, budgetReport, issues);
    const envelope = decision === "rejected"
      ? undefined
      : makeRequestEnvelope(request, requestedSections.included_sections, mediaSelection.selected_media, embodimentContext, budgetReport);
    const base = {
      schema_version: PROMPT_PACKET_ASSEMBLER_SCHEMA_VERSION,
      decision,
      request_envelope: envelope,
      provenance_approval: provenanceApproval,
      media_selection: mediaSelection,
      budget_report: budgetReport,
      issues: freezeArray(issues),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Validates every prompt fact and media item for explicit provenance,
   * prompt-safe source labels, finite confidence, and absence of simulator truth.
   */
  public validatePromptProvenance(
    facts: readonly PromptInputFact[],
    mediaCandidates: readonly PromptMediaCandidate[],
  ): PromptProvenanceApproval {
    const issues: ValidationIssue[] = [];
    const approvedFactRefs: Ref[] = [];
    const rejectedFactRefs: Ref[] = [];
    const approvedMediaRefs: Ref[] = [];
    const rejectedMediaRefs: Ref[] = [];

    for (const fact of facts) {
      const factIssues = validateFact(fact);
      issues.push(...factIssues);
      if (factIssues.some((item) => item.severity === "error")) {
        rejectedFactRefs.push(fact.fact_ref);
      } else {
        approvedFactRefs.push(fact.fact_ref);
      }
    }
    for (const media of mediaCandidates) {
      const mediaIssues = validateMedia(media);
      issues.push(...mediaIssues);
      if (mediaIssues.some((item) => item.severity === "error")) {
        rejectedMediaRefs.push(media.media_ref);
      } else {
        approvedMediaRefs.push(media.media_ref);
      }
    }
    const base = {
      schema_version: PROMPT_PACKET_ASSEMBLER_SCHEMA_VERSION,
      approved: issues.some((item) => item.severity === "error") === false,
      approved_fact_refs: freezeArray(approvedFactRefs),
      rejected_fact_refs: freezeArray(rejectedFactRefs),
      approved_media_refs: freezeArray(approvedMediaRefs),
      rejected_media_refs: freezeArray(rejectedMediaRefs),
      issues: freezeArray(issues),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Selects media under a token budget. Required media is admitted first, then
   * optional media is ranked by priority, quality, and recency.
   */
  public selectMediaForCognitiveRequest(
    cameraPackets: readonly PromptMediaCandidate[],
    videoSnippets: readonly PromptMediaCandidate[],
    audioPackets: readonly PromptMediaCandidate[],
    mediaBudgetTokens: number,
  ): MediaSelectionReport {
    const issues: ValidationIssue[] = [];
    if (mediaBudgetTokens <= 0 || Number.isFinite(mediaBudgetTokens) === false) {
      issues.push(issue("error", "MediaBudgetInvalid", "mediaBudgetTokens", "Media budget must be a positive finite number.", "Provide a positive media token budget."));
    }
    const candidates = [...cameraPackets, ...videoSnippets, ...audioPackets]
      .filter((candidate) => validateMedia(candidate).some((item) => item.severity === "error") === false)
      .sort(compareMediaCandidates);
    const selected: CognitiveMediaPart[] = [];
    const omitted: Ref[] = [];
    let total = 0;
    for (const candidate of candidates) {
      const tokenCost = candidate.token_cost_estimate ?? estimateMediaTokens(candidate);
      if (candidate.required || total + tokenCost <= mediaBudgetTokens) {
        selected.push(candidateToMediaPart(candidate, tokenCost));
        total += tokenCost;
      } else {
        omitted.push(candidate.media_ref);
      }
    }
    if (total > mediaBudgetTokens) {
      issues.push(issue("error", "RequiredMediaExceedsBudget", "mediaBudgetTokens", "Required media exceeds the configured media budget.", "Reduce required media or raise the media budget before model invocation."));
    }
    const base = {
      schema_version: PROMPT_PACKET_ASSEMBLER_SCHEMA_VERSION,
      selected_media: freezeArray(selected),
      omitted_media_refs: freezeArray(omitted),
      total_estimated_tokens: total,
      media_budget_tokens: mediaBudgetTokens,
      issues: freezeArray(issues),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Converts retrieved memory episodes into prompt sections labeled as fallible
   * prior belief with confidence, staleness, and contradiction notes.
   */
  public assembleMemoryAugmentedPrompt(
    basePromptRef: Ref,
    retrievedEpisodes: readonly RetrievedMemoryEpisode[],
    stalenessPolicy: MemoryStalenessPolicy,
    contradictionReport?: MemoryContradictionReport,
  ): MemoryAugmentedPromptPacket {
    const contradicted = new Set(contradictionReport?.contradicted_memory_refs ?? []);
    const included: CognitivePromptSection[] = [];
    const omitted: Ref[] = [];
    for (const episode of [...retrievedEpisodes].sort(compareMemoryEpisodes)) {
      const reliability = classifyMemory(episode, stalenessPolicy, contradicted);
      if (episode.confidence < stalenessPolicy.minimum_confidence && reliability !== "contradicted_prior") {
        omitted.push(episode.memory_ref);
        continue;
      }
      included.push(Object.freeze({
        section_ref: makeRef(basePromptRef, "memory", episode.memory_ref),
        title: `Memory prior ${episode.memory_ref}`,
        content: `Memory is prior belief, not guaranteed truth. Reliability=${reliability}. Confidence=${formatNumber(episode.confidence)}. Staleness_s=${formatNumber(episode.staleness_s)}. Summary: ${episode.summary}`,
        provenance: "memory",
        priority: reliability === "likely_current" ? 65 : reliability === "contradicted_prior" ? 95 : 45,
        required: reliability === "contradicted_prior",
        estimated_tokens: estimateTextTokens(episode.summary) + 28,
      }));
    }
    const contradictionNotes = contradictionReport === undefined
      ? []
      : [`Current observation note for memory contradictions: ${contradictionReport.current_observation_summary}`];
    const base = {
      schema_version: PROMPT_PACKET_ASSEMBLER_SCHEMA_VERSION,
      memory_sections: freezeArray(included),
      omitted_memory_refs: freezeArray(omitted),
      contradiction_notes: freezeArray(contradictionNotes),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Compacts observation history by salience, uncertainty, and exponential
   * recency decay while preserving uncertainty and retained-media references.
   */
  public compactObservationHistory(
    historyWindow: readonly ObservationHistoryEntry[],
    currentTask: string,
    saliencePolicy: ObservationSaliencePolicy,
  ): ObservationHistorySummary {
    const scored = historyWindow
      .map((entry) => ({ entry, score: scoreObservation(entry, currentTask, saliencePolicy) }))
      .filter((item) => item.score >= saliencePolicy.min_salience)
      .sort((a, b) => b.score - a.score || b.entry.observed_at_ms - a.entry.observed_at_ms);
    const retained = scored.slice(0, Math.max(0, saliencePolicy.max_entries)).map((item) => item.entry);
    const retainedRefs = new Set(retained.map((entry) => entry.observation_ref));
    const omitted = historyWindow.filter((entry) => retainedRefs.has(entry.observation_ref) === false).map((entry) => entry.observation_ref);
    const content = retained.map((entry) =>
      `Observation ${entry.observation_ref}: uncertainty=${entry.uncertainty}; media_refs=${entry.retained_media_refs.join(",") || "none"}; ${entry.summary}`).join("\n");
    const section: CognitivePromptSection = Object.freeze({
      section_ref: makeRef("observation_history", currentTask.slice(0, 40)),
      title: "Compacted observation history",
      content: content.length > 0 ? content : "No prior observation history retained; use current sensor evidence only.",
      provenance: "sensor",
      priority: 40,
      required: false,
      estimated_tokens: estimateTextTokens(content),
    });
    const base = {
      schema_version: PROMPT_PACKET_ASSEMBLER_SCHEMA_VERSION,
      section,
      retained_observation_refs: freezeArray(retained.map((entry) => entry.observation_ref)),
      omitted_observation_refs: freezeArray(omitted),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }
}

function collectFacts(request: PromptAssemblyRequest): readonly PromptInputFact[] {
  return freezeArray([
    ...routeFacts(request),
    ...(request.stable_system_facts ?? []),
    ...(request.sensor_facts ?? []),
    ...(request.memory_facts ?? []),
    ...(request.validator_facts ?? []),
    ...(request.safety_facts ?? []),
    ...(request.schema_facts ?? []),
    ...(request.embodiment_facts ?? []),
  ]);
}

function routeFacts(request: PromptAssemblyRequest): readonly PromptInputFact[] {
  const plan = request.invocation_plan;
  const facts: PromptInputFact[] = [
    makeFact("system", "Approved model boundary", `Use only ${GEMINI_ROBOTICS_ER_APPROVED_MODEL}. Produce text structured to ${plan.output_contract_ref}.`, "system", plan.plan_ref, 100, true, 1),
    makeFact("schema", "Output contract", `Invocation class=${plan.invocation_class}; output contract=${plan.output_contract_ref}; prompt template=${plan.prompt_template_ref}.`, "schema", plan.output_contract_ref, 98, true, 1),
    makeFact("safety", "Validator handoff", `Any action-bearing output is a proposal only and must be released by deterministic validators. Downstream target=${plan.downstream_target}.`, "safety", plan.plan_ref, 96, true, 1),
  ];
  if (request.task_instruction !== undefined && request.task_instruction.trim().length > 0) {
    facts.push(makeFact("task", "Current task", request.task_instruction, "task", request.request_ref, 94, true, 1));
  }
  return freezeArray(facts);
}

function makeFact(
  prefix: string,
  title: string,
  content: string,
  provenance: PromptFactProvenance,
  sourceRef: Ref,
  priority: number,
  required: boolean,
  confidence: number,
): PromptInputFact {
  return Object.freeze({
    fact_ref: makeRef(prefix, sourceRef, title),
    title,
    content,
    provenance,
    source_ref: sourceRef,
    priority,
    required,
    confidence,
  });
}

function validateFact(fact: PromptInputFact): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (fact.fact_ref.trim().length === 0) {
    issues.push(issue("error", "FactRefMissing", "fact.fact_ref", "Prompt fact is missing a stable reference.", "Provide a deterministic fact_ref."));
  }
  if (fact.title.trim().length === 0 || fact.content.trim().length === 0) {
    issues.push(issue("error", "FactContentMissing", fact.fact_ref, "Prompt fact requires a non-empty title and content.", "Provide concise prompt-safe text."));
  }
  if (fact.source_ref.trim().length === 0) {
    issues.push(issue("error", "FactSourceMissing", fact.fact_ref, "Prompt fact lacks a source reference.", "Attach the originating sensor, memory, validator, task, or schema ref."));
  }
  if (fact.confidence < 0 || fact.confidence > 1 || Number.isFinite(fact.confidence) === false) {
    issues.push(issue("error", "FactConfidenceInvalid", fact.fact_ref, "Prompt fact confidence must be finite and within 0..1.", "Normalize confidence before assembly."));
  }
  if (fact.priority < 0 || Number.isFinite(fact.priority) === false) {
    issues.push(issue("error", "FactPriorityInvalid", fact.fact_ref, "Prompt fact priority must be finite and non-negative.", "Use a finite non-negative priority."));
  }
  if (FORBIDDEN_PROMPT_DETAIL_PATTERN.test(fact.content) || FORBIDDEN_PROMPT_DETAIL_PATTERN.test(fact.title)) {
    issues.push(issue("error", "ForbiddenPromptDetail", fact.fact_ref, "Prompt fact contains simulator-truth or hidden implementation language.", "Replace it with sensor-derived or validator-safe wording."));
  }
  if (UNSUPPORTED_MODEL_USE_PATTERN.test(fact.content)) {
    issues.push(issue("error", "UnsupportedModelUse", fact.fact_ref, "Prompt fact asks Gemini Robotics-ER to use a blocked capability.", "Route capability through deterministic subsystems or omit it."));
  }
  if (fact.provenance === "memory" && /truth|certain|guaranteed/i.test(fact.content)) {
    issues.push(issue("error", "MemoryTruthClaim", fact.fact_ref, "Memory content is framed as guaranteed truth.", "Label memory as prior belief with confidence and staleness."));
  }
  return freezeArray(issues);
}

function validateMedia(media: PromptMediaCandidate): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (media.media_ref.trim().length === 0) {
    issues.push(issue("error", "MediaRefMissing", "media.media_ref", "Media candidate is missing a stable reference.", "Provide a deterministic media_ref."));
  }
  if (media.mime_type.trim().length === 0 || media.mime_type.startsWith(`${media.modality}/`) === false) {
    issues.push(issue("error", "MediaMimeInvalid", media.media_ref, "Media MIME type must match its modality.", "Use image/*, video/*, or audio/* MIME labels."));
  }
  if ((media.data_base64 === undefined || media.data_base64.length === 0) && (media.file_uri === undefined || media.file_uri.length === 0)) {
    issues.push(issue("error", "MediaPayloadMissing", media.media_ref, "Media requires either base64 data or a file URI.", "Attach selected media data before assembly."));
  }
  if (media.quality_score < 0 || media.quality_score > 1 || Number.isFinite(media.quality_score) === false) {
    issues.push(issue("error", "MediaQualityInvalid", media.media_ref, "Media quality score must be finite and within 0..1.", "Normalize media quality before selection."));
  }
  if (media.priority < 0 || Number.isFinite(media.priority) === false) {
    issues.push(issue("error", "MediaPriorityInvalid", media.media_ref, "Media priority must be finite and non-negative.", "Use a finite non-negative priority."));
  }
  return freezeArray(issues);
}

function factsToSections(facts: readonly PromptInputFact[]): readonly CognitivePromptSection[] {
  return freezeArray(facts
    .slice()
    .sort((a, b) => b.priority - a.priority || a.fact_ref.localeCompare(b.fact_ref))
    .map((fact) => Object.freeze({
      section_ref: fact.fact_ref,
      title: fact.title,
      content: `${fact.content}\nProvenance=${fact.provenance}; Source=${fact.source_ref}; Confidence=${formatNumber(fact.confidence)}.`,
      provenance: fact.provenance,
      priority: fact.priority,
      required: fact.required,
      estimated_tokens: estimateTextTokens(`${fact.title}\n${fact.content}`) + 12,
    })));
}

function selectSectionsByBudget(
  sections: readonly CognitivePromptSection[],
  maxInputTokens: number,
  contextMarginTokens: number,
  mediaTokens: number,
): {
  readonly included_sections: readonly CognitivePromptSection[];
  readonly excluded_section_refs: readonly Ref[];
  readonly issues: readonly ValidationIssue[];
} {
  const issues: ValidationIssue[] = [];
  const limit = maxInputTokens - contextMarginTokens - mediaTokens - 1600;
  if (limit <= 0) {
    issues.push(issue("error", "TextBudgetUnavailable", "maxInputTokens", "Media and reserved context consume the whole input budget.", "Reduce media or increase available input tokens."));
  }
  const required = sections.filter((section) => section.required === true);
  const optional = sections.filter((section) => section.required !== true).sort((a, b) => b.priority - a.priority || a.section_ref.localeCompare(b.section_ref));
  const included: CognitivePromptSection[] = [];
  const excluded: Ref[] = [];
  let total = 0;
  for (const section of required) {
    const cost = section.estimated_tokens ?? estimateTextTokens(section.content);
    included.push(section);
    total += cost;
  }
  for (const section of optional) {
    const cost = section.estimated_tokens ?? estimateTextTokens(section.content);
    if (total + cost <= limit) {
      included.push(section);
      total += cost;
    } else {
      excluded.push(section.section_ref);
    }
  }
  if (total > limit) {
    issues.push(issue("error", "RequiredTextExceedsBudget", "sections", "Required prompt sections exceed the text token budget.", "Compact required facts or reduce media before model invocation."));
  }
  return Object.freeze({
    included_sections: freezeArray(included),
    excluded_section_refs: freezeArray(excluded),
    issues: freezeArray(issues),
  });
}

function buildEmbodimentContext(request: PromptAssemblyRequest, sections: readonly CognitivePromptSection[]): string {
  const explicit = sections.filter((section) => section.provenance === "embodiment").map((section) => section.content);
  if (explicit.length > 0) {
    return explicit.join("\n");
  }
  return `Prompt-safe body summary unavailable for ${request.invocation_plan.invocation_class}; downstream validators remain authoritative.`;
}

function makeRequestEnvelope(
  request: PromptAssemblyRequest,
  sections: readonly CognitivePromptSection[],
  mediaParts: readonly CognitiveMediaPart[],
  embodimentContext: string,
  budgetReport: CognitiveBudgetReport,
): CognitiveRequestEnvelope {
  const observationSections = sections.filter((section) => section.provenance === "sensor" || section.provenance === "task" || section.provenance === "schema" || section.provenance === "system" || section.provenance === "safety");
  const memoryContext = sections.filter((section) => section.provenance === "memory");
  const validatorContext = sections.filter((section) => section.provenance === "validator");
  return Object.freeze({
    request_ref: request.request_ref,
    invocation_class: request.invocation_plan.invocation_class,
    model_identifier: GEMINI_ROBOTICS_ER_APPROVED_MODEL,
    task_instruction: request.task_instruction,
    observation_sections: freezeArray(observationSections),
    media_parts: freezeArray(mediaParts),
    embodiment_context: embodimentContext,
    memory_context: freezeArray(memoryContext),
    validator_context: freezeArray(validatorContext),
    output_contract_ref: request.invocation_plan.output_contract_ref,
    budget_report: budgetReport,
    safety_annotations: freezeArray(request.safety_annotations ?? []),
  });
}

function makeBudgetReport(
  includedSections: readonly CognitivePromptSection[],
  excludedSectionRefs: readonly Ref[],
  mediaParts: readonly CognitiveMediaPart[],
  excludedMediaRefs: readonly Ref[],
  tokenLimit: number,
  reservedMarginTokens: number,
  issues: readonly ValidationIssue[],
): CognitiveBudgetReport {
  const inputTokens = includedSections.reduce((sum, section) => sum + (section.estimated_tokens ?? estimateTextTokens(section.content)), 0)
    + mediaParts.reduce((sum, media) => sum + (media.estimated_tokens ?? estimateMediaPartTokens(media)), 0)
    + 1600;
  const base = {
    schema_version: "mebsuta.gemini_robotics_er_adapter.v1" as const,
    estimated_input_tokens: inputTokens,
    estimated_output_tokens: Math.min(GEMINI_ROBOTICS_ER_OUTPUT_TOKEN_LIMIT, 8192),
    token_limit: tokenLimit,
    reserved_margin_tokens: reservedMarginTokens,
    remaining_margin_tokens: tokenLimit - reservedMarginTokens - inputTokens,
    included_sections: freezeArray(includedSections.map((section) => section.section_ref)),
    excluded_sections: freezeArray(excludedSectionRefs),
    included_media: freezeArray(mediaParts.map((media) => media.media_ref)),
    excluded_media: freezeArray(excludedMediaRefs),
    ok: inputTokens + reservedMarginTokens <= tokenLimit && issues.some((item) => item.severity === "error") === false,
    issues: freezeArray(issues),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function validateInvocationPlanForAssembly(plan: CognitiveInvocationPlan): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (plan.route_decision !== "route_ready" && plan.route_decision !== "safe_hold_required") {
    issues.push(issue("error", "RouteNotReady", "invocation_plan.route_decision", "Prompt assembly requires a ready or safe-hold route.", "Resolve router validation errors before prompt assembly."));
  }
  if (plan.model_identifier !== GEMINI_ROBOTICS_ER_APPROVED_MODEL) {
    issues.push(issue("error", "ModelIdentifierMismatch", "invocation_plan.model_identifier", "Invocation plan does not use the approved Gemini Robotics-ER model.", "Use gemini-robotics-er-1.6-preview."));
  }
  if (plan.output_contract_ref.trim().length === 0 || plan.prompt_template_ref.trim().length === 0) {
    issues.push(issue("error", "RouteContractMissing", "invocation_plan", "Invocation plan lacks prompt template or output contract refs.", "Route the request before prompt assembly."));
  }
  return freezeArray(issues);
}

function validateTaskInstruction(taskInstruction: string | undefined): readonly ValidationIssue[] {
  if (taskInstruction === undefined || taskInstruction.trim().length === 0) {
    return freezeArray([]);
  }
  const issues: ValidationIssue[] = [];
  if (FORBIDDEN_PROMPT_DETAIL_PATTERN.test(taskInstruction)) {
    issues.push(issue("error", "TaskInstructionForbiddenDetail", "task_instruction", "Task instruction contains forbidden implementation or hidden-truth terminology.", "Sanitize task instruction before prompt assembly."));
  }
  if (UNSUPPORTED_MODEL_USE_PATTERN.test(taskInstruction)) {
    issues.push(issue("error", "TaskInstructionUnsupportedUse", "task_instruction", "Task instruction requests unsupported model behavior.", "Route direct control or audio generation requests to deterministic subsystems."));
  }
  return freezeArray(issues);
}

function decideAssembly(
  provenanceApproval: PromptProvenanceApproval,
  budgetReport: CognitiveBudgetReport,
  issues: readonly ValidationIssue[],
): PromptAssemblyDecision {
  if (provenanceApproval.approved === false || budgetReport.ok === false || issues.some((item) => item.severity === "error")) {
    return "rejected";
  }
  if (budgetReport.excluded_sections.length > 0 || budgetReport.excluded_media.length > 0) {
    return "compacted";
  }
  return "assembled";
}

function compareMediaCandidates(a: PromptMediaCandidate, b: PromptMediaCandidate): number {
  const requiredDelta = Number(b.required) - Number(a.required);
  if (requiredDelta !== 0) {
    return requiredDelta;
  }
  const priorityDelta = b.priority - a.priority;
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  const qualityDelta = b.quality_score - a.quality_score;
  if (qualityDelta !== 0) {
    return qualityDelta;
  }
  return (b.observed_at_ms ?? 0) - (a.observed_at_ms ?? 0);
}

function candidateToMediaPart(candidate: PromptMediaCandidate, tokenCost: number): CognitiveMediaPart {
  return Object.freeze({
    media_ref: candidate.media_ref,
    modality: candidate.modality,
    mime_type: candidate.mime_type,
    data_base64: candidate.data_base64,
    file_uri: candidate.file_uri,
    provenance: candidate.provenance,
    estimated_tokens: tokenCost,
  });
}

function estimateMediaTokens(candidate: PromptMediaCandidate): number {
  if (candidate.modality === "image") {
    return Math.max(900, Math.round(1600 * candidate.quality_score));
  }
  if (candidate.modality === "video") {
    return Math.max(3200, Math.round(9000 * candidate.quality_score));
  }
  return Math.max(600, Math.round(2200 * candidate.quality_score));
}

function estimateMediaPartTokens(media: CognitiveMediaPart): number {
  if (media.estimated_tokens !== undefined) {
    return media.estimated_tokens;
  }
  if (media.modality === "video") {
    return 9000;
  }
  if (media.modality === "audio") {
    return 1800;
  }
  return 1400;
}

function compareMemoryEpisodes(a: RetrievedMemoryEpisode, b: RetrievedMemoryEpisode): number {
  return b.relevance_score - a.relevance_score || b.confidence - a.confidence || a.staleness_s - b.staleness_s;
}

function classifyMemory(
  episode: RetrievedMemoryEpisode,
  policy: MemoryStalenessPolicy,
  contradicted: ReadonlySet<Ref>,
): MemoryReliability {
  if (episode.contradicted_by_current_observation || contradicted.has(episode.memory_ref)) {
    return "contradicted_prior";
  }
  if (episode.confidence < policy.minimum_confidence) {
    return "low_confidence_prior";
  }
  if (episode.staleness_s >= policy.stale_s) {
    return "stale_prior";
  }
  return "likely_current";
}

function scoreObservation(entry: ObservationHistoryEntry, currentTask: string, policy: ObservationSaliencePolicy): number {
  const ageMs = Math.max(0, policy.current_time_ms - entry.observed_at_ms);
  const recency = Math.pow(0.5, ageMs / Math.max(1, policy.half_life_ms));
  const uncertaintyBoost = entry.uncertainty === "high" ? 0.18 : entry.uncertainty === "medium" ? 0.1 : entry.uncertainty === "low" ? 0.03 : 0;
  const taskWords = new Set(currentTask.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2));
  const summaryWords = entry.summary.toLowerCase().split(/[^a-z0-9]+/);
  const taskOverlap = summaryWords.filter((word) => taskWords.has(word)).length / Math.max(1, taskWords.size);
  return entry.salience * 0.6 + recency * 0.25 + uncertaintyBoost + taskOverlap * 0.15;
}

function estimateTextTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / TOKEN_CHARS_PER_UNIT));
}

function issue(severity: ValidationSeverity, code: string, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
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

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "") : "invalid";
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

export function promptFactFromRouterEvidence(
  evidenceRef: Ref,
  kind: EvidenceKind,
  provenance: EvidenceProvenance,
  summary: string,
  confidence: number,
  required = false,
): PromptInputFact {
  return makeFact(
    kind,
    `Evidence ${kind}`,
    summary,
    mapRouterProvenance(kind, provenance),
    evidenceRef,
    required ? 90 : 50,
    required,
    confidence,
  );
}

function mapRouterProvenance(kind: EvidenceKind, provenance: EvidenceProvenance): PromptFactProvenance {
  if (kind === "memory" || provenance === "memory") {
    return "memory";
  }
  if (kind === "embodiment" || provenance === "embodiment") {
    return "embodiment";
  }
  if (kind === "validator" || provenance === "validator") {
    return "validator";
  }
  if (kind === "task" || provenance === "orchestrator") {
    return "task";
  }
  if (provenance === "safety") {
    return "safety";
  }
  return "sensor";
}
