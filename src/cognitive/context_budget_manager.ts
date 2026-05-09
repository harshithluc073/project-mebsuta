/**
 * Context budget manager for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/06_GEMINI_ROBOTICS_ER_COGNITIVE_LAYER.md`
 * sections 6.2.1, 6.5.2, 6.6.1, 6.12.1, 6.18.2, 6.19.1, 6.19.3, and 6.20.
 *
 * This module enforces the Gemini Robotics-ER 1.6 Preview 131,072-token input
 * limit by allocating budget across stable instructions, schemas, task context,
 * sensor observations, media, memory, embodiment summaries, validators, and
 * safety annotations. It always trims optional low-priority context before a
 * request can violate the model limit.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import {
  GEMINI_ROBOTICS_ER_ADAPTER_SCHEMA_VERSION,
  GEMINI_ROBOTICS_ER_INPUT_TOKEN_LIMIT,
  GEMINI_ROBOTICS_ER_OUTPUT_TOKEN_LIMIT,
} from "./gemini_robotics_er_adapter";
import type {
  CognitiveBudgetReport,
  CognitiveInvocationClass,
  CognitiveMediaPart,
  CognitivePromptSection,
  CognitiveRequestEnvelope,
} from "./gemini_robotics_er_adapter";

export const CONTEXT_BUDGET_MANAGER_SCHEMA_VERSION = "mebsuta.context_budget_manager.v1" as const;

const TOKEN_CHARS_PER_UNIT = 4;
const DEFAULT_ADAPTER_OVERHEAD_TOKENS = 1600;
const DEFAULT_SCHEMA_OVERHEAD_TOKENS = 1200;
const DEFAULT_SAFETY_MARGIN_TOKENS = 12000;
const DEFAULT_OUTPUT_RESERVATION_TOKENS = 8192;

export type ContextBudgetBucket =
  | "stable_instructions"
  | "schema"
  | "task"
  | "sensor_observation"
  | "media"
  | "memory"
  | "embodiment"
  | "validator"
  | "safety";

export type ContextCandidateOrigin = "router" | "prompt_assembler" | "sensor_bus" | "memory" | "embodiment" | "validator" | "safety" | "schema";
export type ContextCompactionAction = "included" | "trimmed" | "summarized" | "dropped" | "rejected";
export type ContextBudgetDecision = "within_budget" | "compacted_within_budget" | "rejected_over_budget";

export interface ContextBudgetProfile {
  readonly profile_ref: Ref;
  readonly invocation_class: CognitiveInvocationClass;
  readonly input_token_limit: number;
  readonly output_token_reservation: number;
  readonly safety_margin_tokens: number;
  readonly adapter_overhead_tokens: number;
  readonly schema_overhead_tokens: number;
  readonly bucket_minimums: Readonly<Record<ContextBudgetBucket, number>>;
  readonly bucket_targets: Readonly<Record<ContextBudgetBucket, number>>;
  readonly bucket_maximums: Readonly<Record<ContextBudgetBucket, number>>;
}

export interface ContextContentCandidate {
  readonly candidate_ref: Ref;
  readonly bucket: ContextBudgetBucket;
  readonly origin: ContextCandidateOrigin;
  readonly content: string;
  readonly priority: number;
  readonly required: boolean;
  readonly freshness_score: number;
  readonly confidence: number;
  readonly estimated_tokens?: number;
  readonly section?: CognitivePromptSection;
  readonly media?: CognitiveMediaPart;
}

export interface ContextBudgetAllocation {
  readonly bucket: ContextBudgetBucket;
  readonly minimum_tokens: number;
  readonly target_tokens: number;
  readonly maximum_tokens: number;
  readonly allocated_tokens: number;
  readonly used_tokens: number;
  readonly remaining_tokens: number;
  readonly utilization: number;
}

export interface ContextCompactionStep {
  readonly candidate_ref: Ref;
  readonly bucket: ContextBudgetBucket;
  readonly action: ContextCompactionAction;
  readonly original_tokens: number;
  readonly final_tokens: number;
  readonly rationale: string;
}

export interface ContextBudgetDecisionReport {
  readonly schema_version: typeof CONTEXT_BUDGET_MANAGER_SCHEMA_VERSION;
  readonly decision: ContextBudgetDecision;
  readonly invocation_class: CognitiveInvocationClass;
  readonly token_limit: number;
  readonly reserved_tokens: number;
  readonly usable_input_tokens: number;
  readonly total_estimated_tokens_before_compaction: number;
  readonly total_estimated_tokens_after_compaction: number;
  readonly remaining_margin_tokens: number;
  readonly allocations: readonly ContextBudgetAllocation[];
  readonly included_candidate_refs: readonly Ref[];
  readonly excluded_candidate_refs: readonly Ref[];
  readonly compaction_steps: readonly ContextCompactionStep[];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface EnvelopeBudgetDecision {
  readonly schema_version: typeof CONTEXT_BUDGET_MANAGER_SCHEMA_VERSION;
  readonly decision_report: ContextBudgetDecisionReport;
  readonly budget_report: CognitiveBudgetReport;
  readonly compacted_envelope?: CognitiveRequestEnvelope;
  readonly determinism_hash: string;
}

/**
 * Allocates and compacts context for Gemini Robotics-ER requests using the
 * architecture-defined token limit, margin, and priority ladder.
 */
export class ContextBudgetManager {
  /**
   * Allocates a complete budget profile for a cognitive invocation class.
   * The targets are conservative so media-heavy and memory-heavy prompts still
   * preserve explicit model-limit margin.
   */
  public createBudgetProfile(invocationClass: CognitiveInvocationClass): ContextBudgetProfile {
    const weights = weightsForInvocation(invocationClass);
    const inputLimit = GEMINI_ROBOTICS_ER_INPUT_TOKEN_LIMIT;
    const outputReservation = outputReservationFor(invocationClass);
    const safetyMargin = marginFor(invocationClass);
    const fixedReserve = outputReservation + safetyMargin + DEFAULT_ADAPTER_OVERHEAD_TOKENS + DEFAULT_SCHEMA_OVERHEAD_TOKENS;
    const distributable = Math.max(0, inputLimit - fixedReserve);
    const bucketTargets = makeBucketTable(weights, distributable, "target");
    const bucketMinimums = makeBucketTable(weights, distributable, "minimum");
    const bucketMaximums = makeBucketTable(weights, distributable, "maximum");
    return Object.freeze({
      profile_ref: makeRef("context_budget_profile", invocationClass),
      invocation_class: invocationClass,
      input_token_limit: inputLimit,
      output_token_reservation: outputReservation,
      safety_margin_tokens: safetyMargin,
      adapter_overhead_tokens: DEFAULT_ADAPTER_OVERHEAD_TOKENS,
      schema_overhead_tokens: DEFAULT_SCHEMA_OVERHEAD_TOKENS,
      bucket_minimums: Object.freeze(bucketMinimums),
      bucket_targets: Object.freeze(bucketTargets),
      bucket_maximums: Object.freeze(bucketMaximums),
    });
  }

  /**
   * Allocates context candidates into bucket budgets and applies deterministic
   * compaction until the request fits or a required candidate makes it impossible.
   */
  public allocateContextBudget(
    invocationClass: CognitiveInvocationClass,
    contentCandidates: readonly ContextContentCandidate[],
    budgetProfile: ContextBudgetProfile = this.createBudgetProfile(invocationClass),
  ): ContextBudgetDecisionReport {
    const issues = [
      ...validateProfile(budgetProfile, invocationClass),
      ...contentCandidates.flatMap((candidate) => validateCandidate(candidate)),
    ];
    const validCandidates = contentCandidates.filter((candidate) => validateCandidate(candidate).some((item) => item.severity === "error") === false);
    const beforeTokens = validCandidates.reduce((sum, candidate) => sum + estimateCandidateTokens(candidate), 0);
    const usableTokens = usableInputTokens(budgetProfile);
    const sorted = [...validCandidates].sort(compareCandidatesForInclusion);
    const included = new Map<Ref, ContextContentCandidate>();
    const excluded = new Set<Ref>();
    const compactionSteps: ContextCompactionStep[] = [];
    const bucketUsage = emptyBucketUsage();
    let usedTokens = fixedPromptOverhead(budgetProfile);

    for (const candidate of sorted) {
      const originalTokens = estimateCandidateTokens(candidate);
      const bucketUsed = bucketUsage.get(candidate.bucket) ?? 0;
      const bucketMax = budgetProfile.bucket_maximums[candidate.bucket];
      const availableOverall = usableTokens - usedTokens;
      const availableBucket = Math.max(0, bucketMax - bucketUsed);
      const allowedTokens = Math.min(availableOverall, availableBucket);
      const compacted = compactCandidate(candidate, allowedTokens, budgetProfile);
      if (compacted.action === "rejected") {
        excluded.add(candidate.candidate_ref);
        compactionSteps.push(compacted.step);
        if (candidate.required) {
          issues.push(issue("error", "RequiredContextDoesNotFit", candidate.candidate_ref, "Required context cannot fit within the available token budget.", "Reduce required media or required text before model invocation."));
        }
        continue;
      }
      included.set(candidate.candidate_ref, compacted.candidate);
      usedTokens += compacted.step.final_tokens;
      bucketUsage.set(candidate.bucket, bucketUsed + compacted.step.final_tokens);
      compactionSteps.push(compacted.step);
    }

    for (const bucket of ALL_BUCKETS) {
      const minimum = budgetProfile.bucket_minimums[bucket];
      const used = bucketUsage.get(bucket) ?? 0;
      if (used < minimum && requiredBucketFor(invocationClass, bucket)) {
        issues.push(issue("warning", "BucketBelowPreferredMinimum", `bucket.${bucket}`, `Budget bucket ${bucket} is below its preferred minimum.`, "Attach more high-confidence context only if available and still under limit."));
      }
    }

    const afterTokens = Array.from(included.values()).reduce((sum, candidate) => sum + estimateCandidateTokens(candidate), 0);
    const remainingMargin = budgetProfile.input_token_limit - budgetProfile.output_token_reservation - budgetProfile.safety_margin_tokens - fixedPromptOverhead(budgetProfile) - afterTokens;
    if (remainingMargin < 0) {
      issues.push(issue("error", "ContextLimitExceeded", "total_estimated_tokens_after_compaction", "Compacted context still exceeds the model input limit plus explicit margin.", "Drop optional context and reduce required context before invocation."));
    }
    const decision = decideBudget(issues, beforeTokens, afterTokens, contentCandidates.length, included.size);
    const base = {
      schema_version: CONTEXT_BUDGET_MANAGER_SCHEMA_VERSION,
      decision,
      invocation_class: invocationClass,
      token_limit: budgetProfile.input_token_limit,
      reserved_tokens: budgetProfile.output_token_reservation + budgetProfile.safety_margin_tokens + fixedPromptOverhead(budgetProfile),
      usable_input_tokens: usableTokens,
      total_estimated_tokens_before_compaction: beforeTokens,
      total_estimated_tokens_after_compaction: afterTokens,
      remaining_margin_tokens: remainingMargin,
      allocations: freezeArray(makeAllocations(budgetProfile, bucketUsage)),
      included_candidate_refs: freezeArray(Array.from(included.keys())),
      excluded_candidate_refs: freezeArray([...excluded, ...validCandidates.filter((candidate) => included.has(candidate.candidate_ref) === false && excluded.has(candidate.candidate_ref) === false).map((candidate) => candidate.candidate_ref)]),
      compaction_steps: freezeArray(compactionSteps),
      issues: freezeArray(issues),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Converts a request envelope into budget candidates, budgets them, and emits
   * both the manager decision report and adapter-compatible budget report.
   */
  public estimateRequestEnvelopeBudget(
    envelope: CognitiveRequestEnvelope,
    budgetProfile: ContextBudgetProfile = this.createBudgetProfile(envelope.invocation_class),
  ): EnvelopeBudgetDecision {
    const candidates = candidatesFromEnvelope(envelope);
    const decisionReport = this.allocateContextBudget(envelope.invocation_class, candidates, budgetProfile);
    const includedRefs = new Set(decisionReport.included_candidate_refs);
    const compactedEnvelope = decisionReport.decision === "rejected_over_budget"
      ? undefined
      : compactEnvelope(envelope, includedRefs, decisionReport);
    const budgetReport = makeAdapterBudgetReport(envelope, decisionReport, compactedEnvelope);
    const base = {
      schema_version: CONTEXT_BUDGET_MANAGER_SCHEMA_VERSION,
      decision_report: decisionReport,
      budget_report: budgetReport,
      compacted_envelope: compactedEnvelope,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Computes utilization by bucket so telemetry can alert when repeated requests
   * run near routine targets or exceed safe margins.
   */
  public summarizeUtilization(decisionReport: ContextBudgetDecisionReport): Readonly<Record<ContextBudgetBucket, number>> {
    return Object.freeze(Object.fromEntries(decisionReport.allocations.map((allocation) => [allocation.bucket, allocation.utilization])) as Record<ContextBudgetBucket, number>);
  }
}

const ALL_BUCKETS: readonly ContextBudgetBucket[] = freezeArray([
  "stable_instructions",
  "schema",
  "task",
  "sensor_observation",
  "media",
  "memory",
  "embodiment",
  "validator",
  "safety",
]);

type BucketWeights = Readonly<Record<ContextBudgetBucket, number>>;

function weightsForInvocation(invocationClass: CognitiveInvocationClass): BucketWeights {
  const baseline: BucketWeights = {
    stable_instructions: 0.07,
    schema: 0.05,
    task: 0.1,
    sensor_observation: 0.24,
    media: 0.22,
    memory: 0.1,
    embodiment: 0.08,
    validator: 0.08,
    safety: 0.06,
  };
  if (invocationClass === "SceneObservationReasoning" || invocationClass === "MultiViewDisambiguationReasoning") {
    return Object.freeze({ ...baseline, sensor_observation: 0.3, media: 0.3, memory: 0.05, validator: 0.04 });
  }
  if (invocationClass === "TaskPlanningReasoning" || invocationClass === "WaypointGenerationReasoning") {
    return Object.freeze({ ...baseline, task: 0.16, embodiment: 0.12, sensor_observation: 0.2, media: 0.16, memory: 0.11 });
  }
  if (invocationClass === "OopsCorrectionReasoning") {
    return Object.freeze({ ...baseline, validator: 0.18, safety: 0.1, sensor_observation: 0.22, media: 0.16, memory: 0.05 });
  }
  if (invocationClass === "ToolUseReasoning") {
    return Object.freeze({ ...baseline, embodiment: 0.13, sensor_observation: 0.22, media: 0.2, validator: 0.1, memory: 0.06 });
  }
  if (invocationClass === "AudioEventReasoning") {
    return Object.freeze({ ...baseline, media: 0.28, sensor_observation: 0.12, safety: 0.12, memory: 0.04 });
  }
  if (invocationClass === "MemoryAssimilationReasoning") {
    return Object.freeze({ ...baseline, memory: 0.32, sensor_observation: 0.14, media: 0.08, validator: 0.04 });
  }
  if (invocationClass === "InternalMonologueReasoning") {
    return Object.freeze({ ...baseline, task: 0.14, validator: 0.16, safety: 0.18, media: 0.03, memory: 0.03 });
  }
  return baseline;
}

function makeBucketTable(weights: BucketWeights, distributable: number, mode: "minimum" | "target" | "maximum"): Record<ContextBudgetBucket, number> {
  const multiplier = mode === "minimum" ? 0.3 : mode === "maximum" ? 1.65 : 1;
  return Object.fromEntries(ALL_BUCKETS.map((bucket) => [bucket, Math.max(256, Math.floor(distributable * weights[bucket] * multiplier))])) as Record<ContextBudgetBucket, number>;
}

function outputReservationFor(invocationClass: CognitiveInvocationClass): number {
  if (invocationClass === "TaskPlanningReasoning" || invocationClass === "OopsCorrectionReasoning" || invocationClass === "ToolUseReasoning") {
    return 12000;
  }
  if (invocationClass === "InternalMonologueReasoning") {
    return 2048;
  }
  if (invocationClass === "MemoryAssimilationReasoning") {
    return 6000;
  }
  return DEFAULT_OUTPUT_RESERVATION_TOKENS;
}

function marginFor(invocationClass: CognitiveInvocationClass): number {
  if (invocationClass === "OopsCorrectionReasoning" || invocationClass === "AudioEventReasoning") {
    return 16000;
  }
  if (invocationClass === "InternalMonologueReasoning") {
    return 8000;
  }
  return DEFAULT_SAFETY_MARGIN_TOKENS;
}

function validateProfile(profile: ContextBudgetProfile, invocationClass: CognitiveInvocationClass): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (profile.invocation_class !== invocationClass) {
    issues.push(issue("error", "BudgetProfileClassMismatch", "budgetProfile.invocation_class", "Budget profile invocation class does not match the request class.", "Create a profile for the same invocation class."));
  }
  if (profile.input_token_limit !== GEMINI_ROBOTICS_ER_INPUT_TOKEN_LIMIT) {
    issues.push(issue("error", "InputLimitMismatch", "budgetProfile.input_token_limit", "Budget profile must use the Gemini Robotics-ER 1.6 Preview 131,072-token input limit.", "Use the approved model capability limit."));
  }
  if (profile.output_token_reservation <= 0 || profile.output_token_reservation > GEMINI_ROBOTICS_ER_OUTPUT_TOKEN_LIMIT) {
    issues.push(issue("error", "OutputReservationInvalid", "budgetProfile.output_token_reservation", "Output reservation must be positive and no larger than the model output limit.", "Reserve a finite output token range."));
  }
  if (usableInputTokens(profile) <= 0) {
    issues.push(issue("error", "UsableBudgetInvalid", "budgetProfile", "Reserved tokens consume the entire input budget.", "Reduce safety margin, adapter overhead, schema overhead, or output reservation."));
  }
  return freezeArray(issues);
}

function validateCandidate(candidate: ContextContentCandidate): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (candidate.candidate_ref.trim().length === 0) {
    issues.push(issue("error", "CandidateRefMissing", "candidate.candidate_ref", "Context candidate needs a stable reference.", "Provide a deterministic candidate ref."));
  }
  if (candidate.priority < 0 || Number.isFinite(candidate.priority) === false) {
    issues.push(issue("error", "CandidatePriorityInvalid", candidate.candidate_ref, "Context candidate priority must be finite and non-negative.", "Normalize candidate priority."));
  }
  if (candidate.freshness_score < 0 || candidate.freshness_score > 1 || Number.isFinite(candidate.freshness_score) === false) {
    issues.push(issue("error", "CandidateFreshnessInvalid", candidate.candidate_ref, "Freshness score must be finite and within 0..1.", "Normalize freshness score before budgeting."));
  }
  if (candidate.confidence < 0 || candidate.confidence > 1 || Number.isFinite(candidate.confidence) === false) {
    issues.push(issue("error", "CandidateConfidenceInvalid", candidate.candidate_ref, "Confidence must be finite and within 0..1.", "Normalize confidence before budgeting."));
  }
  if (candidate.required && candidate.content.trim().length === 0 && candidate.media === undefined && candidate.section === undefined) {
    issues.push(issue("error", "RequiredCandidateEmpty", candidate.candidate_ref, "Required context candidate is empty.", "Attach text, section, or media before budgeting."));
  }
  return freezeArray(issues);
}

function estimateCandidateTokens(candidate: ContextContentCandidate): number {
  if (candidate.estimated_tokens !== undefined) {
    return Math.max(1, Math.ceil(candidate.estimated_tokens));
  }
  if (candidate.media !== undefined) {
    return estimateMediaTokens(candidate.media);
  }
  if (candidate.section !== undefined) {
    return candidate.section.estimated_tokens ?? estimateTextTokens(`${candidate.section.title}\n${candidate.section.content}`);
  }
  return estimateTextTokens(candidate.content);
}

function estimateMediaTokens(media: CognitiveMediaPart): number {
  if (media.estimated_tokens !== undefined) {
    return Math.max(1, Math.ceil(media.estimated_tokens));
  }
  if (media.modality === "video") {
    return 9000;
  }
  if (media.modality === "audio") {
    return 2200;
  }
  return 1600;
}

function estimateTextTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / TOKEN_CHARS_PER_UNIT));
}

function compareCandidatesForInclusion(a: ContextContentCandidate, b: ContextContentCandidate): number {
  const requiredDelta = Number(b.required) - Number(a.required);
  if (requiredDelta !== 0) {
    return requiredDelta;
  }
  const priorityDelta = b.priority - a.priority;
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  const qualityDelta = candidateQuality(b) - candidateQuality(a);
  if (qualityDelta !== 0) {
    return qualityDelta;
  }
  return a.candidate_ref.localeCompare(b.candidate_ref);
}

function candidateQuality(candidate: ContextContentCandidate): number {
  return candidate.confidence * 0.55 + candidate.freshness_score * 0.35 + Math.min(1, candidate.priority / 100) * 0.1;
}

function compactCandidate(
  candidate: ContextContentCandidate,
  allowedTokens: number,
  profile: ContextBudgetProfile,
): { readonly candidate: ContextContentCandidate; readonly step: ContextCompactionStep; readonly action: ContextCompactionAction } {
  const originalTokens = estimateCandidateTokens(candidate);
  if (allowedTokens >= originalTokens) {
    const step = makeStep(candidate, "included", originalTokens, originalTokens, "Candidate fits inside overall and bucket budget.");
    return Object.freeze({ candidate, step, action: "included" });
  }
  if (candidate.required && allowedTokens >= Math.min(originalTokens, minimumRequiredTokens(candidate))) {
    const compacted = summarizeCandidate(candidate, Math.max(1, allowedTokens));
    const finalTokens = estimateCandidateTokens(compacted);
    const step = makeStep(candidate, "summarized", originalTokens, finalTokens, "Required candidate was summarized to remain under token budget.");
    return Object.freeze({ candidate: compacted, step, action: "summarized" });
  }
  if (candidate.required) {
    const step = makeStep(candidate, "rejected", originalTokens, 0, `Required candidate does not fit in ${profile.profile_ref}.`);
    return Object.freeze({ candidate, step, action: "rejected" });
  }
  if (allowedTokens >= Math.max(96, Math.floor(originalTokens * 0.35)) && candidate.bucket !== "media") {
    const compacted = summarizeCandidate(candidate, allowedTokens);
    const finalTokens = estimateCandidateTokens(compacted);
    const step = makeStep(candidate, "trimmed", originalTokens, finalTokens, "Optional text candidate was trimmed to fit remaining budget.");
    return Object.freeze({ candidate: compacted, step, action: "trimmed" });
  }
  const step = makeStep(candidate, "dropped", originalTokens, 0, "Optional candidate was dropped before violating context limit.");
  return Object.freeze({ candidate, step, action: "dropped" });
}

function minimumRequiredTokens(candidate: ContextContentCandidate): number {
  if (candidate.bucket === "media") {
    return estimateCandidateTokens(candidate);
  }
  if (candidate.bucket === "schema" || candidate.bucket === "safety") {
    return 128;
  }
  return 256;
}

function summarizeCandidate(candidate: ContextContentCandidate, allowedTokens: number): ContextContentCandidate {
  if (candidate.media !== undefined) {
    return candidate;
  }
  const allowedChars = Math.max(64, Math.floor(allowedTokens * TOKEN_CHARS_PER_UNIT));
  const source = candidate.section === undefined ? candidate.content : `${candidate.section.title}\n${candidate.section.content}`;
  const summary = source.length <= allowedChars ? source : `${source.slice(0, allowedChars - 24).trimEnd()} [compacted]`;
  const section = candidate.section === undefined
    ? undefined
    : Object.freeze({
      ...candidate.section,
      content: summary,
      estimated_tokens: estimateTextTokens(summary),
    });
  return Object.freeze({
    ...candidate,
    content: summary,
    estimated_tokens: estimateTextTokens(summary),
    section,
  });
}

function makeStep(candidate: ContextContentCandidate, action: ContextCompactionAction, originalTokens: number, finalTokens: number, rationale: string): ContextCompactionStep {
  return Object.freeze({
    candidate_ref: candidate.candidate_ref,
    bucket: candidate.bucket,
    action,
    original_tokens: originalTokens,
    final_tokens: finalTokens,
    rationale,
  });
}

function emptyBucketUsage(): Map<ContextBudgetBucket, number> {
  return new Map(ALL_BUCKETS.map((bucket) => [bucket, 0]));
}

function fixedPromptOverhead(profile: ContextBudgetProfile): number {
  return profile.adapter_overhead_tokens + profile.schema_overhead_tokens;
}

function usableInputTokens(profile: ContextBudgetProfile): number {
  return profile.input_token_limit - profile.output_token_reservation - profile.safety_margin_tokens - fixedPromptOverhead(profile);
}

function makeAllocations(profile: ContextBudgetProfile, bucketUsage: ReadonlyMap<ContextBudgetBucket, number>): readonly ContextBudgetAllocation[] {
  return freezeArray(ALL_BUCKETS.map((bucket) => {
    const maximum = profile.bucket_maximums[bucket];
    const used = bucketUsage.get(bucket) ?? 0;
    return Object.freeze({
      bucket,
      minimum_tokens: profile.bucket_minimums[bucket],
      target_tokens: profile.bucket_targets[bucket],
      maximum_tokens: maximum,
      allocated_tokens: maximum,
      used_tokens: used,
      remaining_tokens: Math.max(0, maximum - used),
      utilization: maximum <= 0 ? 1 : roundRatio(used / maximum),
    });
  }));
}

function decideBudget(
  issues: readonly ValidationIssue[],
  beforeTokens: number,
  afterTokens: number,
  candidateCount: number,
  includedCount: number,
): ContextBudgetDecision {
  if (issues.some((item) => item.severity === "error")) {
    return "rejected_over_budget";
  }
  if (afterTokens < beforeTokens || includedCount < candidateCount) {
    return "compacted_within_budget";
  }
  return "within_budget";
}

function requiredBucketFor(invocationClass: CognitiveInvocationClass, bucket: ContextBudgetBucket): boolean {
  if (bucket === "stable_instructions" || bucket === "schema" || bucket === "safety") {
    return true;
  }
  if (invocationClass === "InternalMonologueReasoning") {
    return bucket === "validator" || bucket === "task";
  }
  if (invocationClass === "MemoryAssimilationReasoning") {
    return bucket === "memory" || bucket === "sensor_observation";
  }
  if (invocationClass === "AudioEventReasoning") {
    return bucket === "media" || bucket === "sensor_observation";
  }
  return bucket === "task" || bucket === "sensor_observation" || bucket === "embodiment";
}

function candidatesFromEnvelope(envelope: CognitiveRequestEnvelope): readonly ContextContentCandidate[] {
  const candidates: ContextContentCandidate[] = [];
  for (const section of envelope.observation_sections ?? []) {
    candidates.push(candidateFromSection(section, classifySectionBucket(section), "prompt_assembler"));
  }
  for (const section of envelope.memory_context ?? []) {
    candidates.push(candidateFromSection(section, "memory", "memory"));
  }
  for (const section of envelope.validator_context ?? []) {
    candidates.push(candidateFromSection(section, "validator", "validator"));
  }
  for (const media of envelope.media_parts ?? []) {
    candidates.push(Object.freeze({
      candidate_ref: makeRef("media", media.media_ref),
      bucket: "media",
      origin: "sensor_bus",
      content: `${media.modality}:${media.mime_type}:${media.media_ref}`,
      priority: 70,
      required: false,
      freshness_score: 1,
      confidence: 1,
      estimated_tokens: media.estimated_tokens ?? estimateMediaTokens(media),
      media,
    }));
  }
  candidates.push(Object.freeze({
    candidate_ref: makeRef("embodiment", envelope.request_ref),
    bucket: "embodiment",
    origin: "embodiment",
    content: envelope.embodiment_context,
    priority: 88,
    required: true,
    freshness_score: 1,
    confidence: 1,
    estimated_tokens: estimateTextTokens(envelope.embodiment_context),
  }));
  for (let index = 0; index < envelope.safety_annotations.length; index += 1) {
    const annotation = envelope.safety_annotations[index] ?? "";
    candidates.push(Object.freeze({
      candidate_ref: makeRef("safety", envelope.request_ref, String(index)),
      bucket: "safety",
      origin: "safety",
      content: annotation,
      priority: 95,
      required: true,
      freshness_score: 1,
      confidence: 1,
      estimated_tokens: estimateTextTokens(annotation),
    }));
  }
  return freezeArray(candidates);
}

function candidateFromSection(section: CognitivePromptSection, bucket: ContextBudgetBucket, origin: ContextCandidateOrigin): ContextContentCandidate {
  return Object.freeze({
    candidate_ref: makeRef("section", section.section_ref),
    bucket,
    origin,
    content: `${section.title}\n${section.content}`,
    priority: section.priority,
    required: section.required === true,
    freshness_score: section.provenance === "memory" ? 0.65 : 1,
    confidence: 1,
    estimated_tokens: section.estimated_tokens ?? estimateTextTokens(`${section.title}\n${section.content}`),
    section,
  });
}

function classifySectionBucket(section: CognitivePromptSection): ContextBudgetBucket {
  if (section.provenance === "system") {
    return "stable_instructions";
  }
  if (section.provenance === "schema") {
    return "schema";
  }
  if (section.provenance === "task") {
    return "task";
  }
  if (section.provenance === "embodiment") {
    return "embodiment";
  }
  if (section.provenance === "validator") {
    return "validator";
  }
  if (section.provenance === "safety") {
    return "safety";
  }
  if (section.provenance === "memory") {
    return "memory";
  }
  return "sensor_observation";
}

function compactEnvelope(
  envelope: CognitiveRequestEnvelope,
  includedRefs: ReadonlySet<Ref>,
  decisionReport: ContextBudgetDecisionReport,
): CognitiveRequestEnvelope {
  const sectionByRef = new Map(decisionReport.compaction_steps.map((step) => [step.candidate_ref, step]));
  const keepSection = (section: CognitivePromptSection): boolean => includedRefs.has(makeRef("section", section.section_ref));
  const keepMedia = (media: CognitiveMediaPart): boolean => includedRefs.has(makeRef("media", media.media_ref));
  return Object.freeze({
    ...envelope,
    observation_sections: freezeArray((envelope.observation_sections ?? []).filter(keepSection).map((section) => maybeCompactSection(section, sectionByRef.get(makeRef("section", section.section_ref))))),
    memory_context: freezeArray((envelope.memory_context ?? []).filter(keepSection).map((section) => maybeCompactSection(section, sectionByRef.get(makeRef("section", section.section_ref))))),
    validator_context: freezeArray((envelope.validator_context ?? []).filter(keepSection).map((section) => maybeCompactSection(section, sectionByRef.get(makeRef("section", section.section_ref))))),
    media_parts: freezeArray((envelope.media_parts ?? []).filter(keepMedia)),
  });
}

function maybeCompactSection(section: CognitivePromptSection, step: ContextCompactionStep | undefined): CognitivePromptSection {
  if (step === undefined || (step.action !== "trimmed" && step.action !== "summarized")) {
    return section;
  }
  const targetChars = Math.max(64, step.final_tokens * TOKEN_CHARS_PER_UNIT);
  const compacted = section.content.length <= targetChars ? section.content : `${section.content.slice(0, targetChars - 24).trimEnd()} [compacted]`;
  return Object.freeze({
    ...section,
    content: compacted,
    estimated_tokens: estimateTextTokens(compacted),
  });
}

function makeAdapterBudgetReport(
  originalEnvelope: CognitiveRequestEnvelope,
  decisionReport: ContextBudgetDecisionReport,
  compactedEnvelope: CognitiveRequestEnvelope | undefined,
): CognitiveBudgetReport {
  const envelope = compactedEnvelope ?? originalEnvelope;
  const overheadTokens = DEFAULT_ADAPTER_OVERHEAD_TOKENS + DEFAULT_SCHEMA_OVERHEAD_TOKENS;
  const reservedMarginTokens = Math.max(0, decisionReport.reserved_tokens - overheadTokens);
  const estimatedInputTokens = decisionReport.token_limit - decisionReport.remaining_margin_tokens - reservedMarginTokens;
  const includedSections = [
    ...(envelope.observation_sections ?? []),
    ...(envelope.memory_context ?? []),
    ...(envelope.validator_context ?? []),
  ].map((section) => section.section_ref);
  const includedMedia = (envelope.media_parts ?? []).map((media) => media.media_ref);
  const base = {
    schema_version: GEMINI_ROBOTICS_ER_ADAPTER_SCHEMA_VERSION,
    estimated_input_tokens: estimatedInputTokens,
    estimated_output_tokens: Math.min(GEMINI_ROBOTICS_ER_OUTPUT_TOKEN_LIMIT, DEFAULT_OUTPUT_RESERVATION_TOKENS),
    token_limit: decisionReport.token_limit,
    reserved_margin_tokens: reservedMarginTokens,
    remaining_margin_tokens: decisionReport.remaining_margin_tokens,
    included_sections: freezeArray(includedSections),
    excluded_sections: freezeArray(decisionReport.excluded_candidate_refs.filter((ref) => ref.startsWith("section:"))),
    included_media: freezeArray(includedMedia),
    excluded_media: freezeArray(decisionReport.excluded_candidate_refs.filter((ref) => ref.startsWith("media:"))),
    ok: decisionReport.decision !== "rejected_over_budget",
    issues: decisionReport.issues,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function roundRatio(value: number): number {
  return Math.round(value * 1000) / 1000;
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

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}
