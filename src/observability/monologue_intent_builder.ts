/**
 * Monologue intent builder for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/17_INTERNAL_MONOLOGUE_TTS_OBSERVABILITY.md`
 * sections 17.4.1, 17.5, 17.6.1, 17.11, 17.12.1, and 17.19.
 *
 * The builder converts structured observability events into bounded candidate
 * narration intents. It does not expose private deliberation and it does not
 * approve speech by itself; it prepares public summaries for grounding and
 * safety filtering.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  compressPublicMessage,
  containsForbiddenRuntimeText,
  freezeArray,
  makeIssue,
  makeObservabilityRef,
  sanitizePublicText,
  severityRank,
  uniqueRefs,
  validateOptionalRef,
  validateRef,
} from "./observability_event_emitter";
import type {
  DashboardVisibility,
  MonologueAudience,
  MonologueIntent,
  MonologuePriority,
  ObservabilityEvent,
  UtteranceClass,
} from "./observability_event_emitter";

export const MONOLOGUE_INTENT_BUILDER_SCHEMA_VERSION = "mebsuta.monologue_intent_builder.v1" as const;

export interface MonologueTaskContext {
  readonly task_ref?: Ref;
  readonly task_goal_summary?: string;
  readonly active_state_ref?: Ref;
  readonly latest_plan_ref?: Ref;
  readonly latest_certificate_ref?: Ref;
  readonly safety_policy_refs?: readonly Ref[];
  readonly memory_context_refs?: readonly Ref[];
  readonly retry_attempt_index?: number;
  readonly operator_tts_enabled?: boolean;
}

export interface IntentBuilderPolicy {
  readonly max_candidate_chars: number;
  readonly speak_plan_previews: boolean;
  readonly speak_verification_results: boolean;
  readonly speak_routine_debug_events: boolean;
  readonly require_tts_for_safety: boolean;
  readonly default_audience: MonologueAudience;
}

export interface MonologueIntentBuilderReport {
  readonly intent_builder_report_ref: Ref;
  readonly source_event_ref: Ref;
  readonly intent?: MonologueIntent;
  readonly suppressed_reason?: string;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

/**
 * Converts important observability events into candidate public narration.
 */
export class MonologueIntentBuilder {
  public buildMonologueIntent(
    observabilityEvent: ObservabilityEvent,
    taskContext: MonologueTaskContext,
    audienceMode: MonologueAudience,
    policy?: Partial<IntentBuilderPolicy>,
  ): MonologueIntentBuilderReport {
    const resolvedPolicy = mergePolicy(policy, audienceMode);
    const issues: ValidationIssue[] = [];
    validateEvent(observabilityEvent, taskContext, issues);
    const utteranceClass = chooseUtteranceClass(observabilityEvent);
    const priority = choosePriority(observabilityEvent, utteranceClass);
    const requiresTTS = chooseRequiresTTS(observabilityEvent, utteranceClass, priority, resolvedPolicy, taskContext);
    const allowedAudience = chooseAudience(observabilityEvent.dashboard_visibility, resolvedPolicy.default_audience);

    if (!shouldEmitIntent(observabilityEvent, utteranceClass, priority, resolvedPolicy)) {
      return makeReport(observabilityEvent, undefined, "Event is preserved for timeline replay without narration.", issues);
    }

    const message = buildCandidateMessage(observabilityEvent, taskContext, utteranceClass, resolvedPolicy.max_candidate_chars, issues);
    const evidenceRefs = uniqueRefs([...observabilityEvent.artifact_refs, taskContext.latest_certificate_ref, taskContext.latest_plan_ref]);
    if (containsForbiddenRuntimeText(message)) {
      issues.push(makeIssue("warning", "MonologueIntentNeedsFiltering", "$.candidate_message", "Candidate narration needs safety filtering before display or TTS.", "Run the monologue safety filter before playback."));
    }

    const base = {
      monologue_intent_ref: makeObservabilityRef("monologue_intent", observabilityEvent.observability_event_ref, utteranceClass),
      source_event_ref: observabilityEvent.observability_event_ref,
      utterance_class: utteranceClass,
      task_ref: taskContext.task_ref ?? observabilityEvent.task_ref,
      priority,
      candidate_message: message,
      evidence_claim_refs: evidenceRefs,
      confidence_labels: buildConfidenceLabels(observabilityEvent),
      safety_labels: buildSafetyLabels(observabilityEvent, taskContext),
      memory_labels: buildMemoryLabels(observabilityEvent, taskContext),
      allowed_audience: allowedAudience,
      requires_tts: requiresTTS,
      validation_issues: freezeArray(issues),
    };
    return makeReport(observabilityEvent, Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) }), undefined, issues);
  }
}

function chooseUtteranceClass(event: ObservabilityEvent): UtteranceClass {
  if (event.event_class === "safety" || event.severity === "critical") {
    return "safe_hold";
  }
  if (event.event_class === "verification") {
    return /success|complete|passed|certificate/i.test(event.summary) ? "task_completion" : "verification_result";
  }
  if (event.event_class === "oops") {
    return /correction|retry|repair/i.test(event.summary) ? "correction_preview" : "oops_diagnosis";
  }
  if (event.event_class === "audio") {
    return "audio_attention";
  }
  if (event.event_class === "memory") {
    return "memory_context";
  }
  if (event.event_class === "control") {
    return event.severity === "warning" || event.severity === "error" ? "execution_anomaly" : "execution_start";
  }
  if (event.event_class === "perception") {
    return "observation_summary";
  }
  if (event.event_class === "cognition" || event.event_class === "state") {
    return /plan|approach|move|execute|primitive/i.test(event.summary) ? "plan_preview" : "validation_block";
  }
  return "observation_summary";
}

function choosePriority(event: ObservabilityEvent, utteranceClass: UtteranceClass): MonologuePriority {
  if (utteranceClass === "safe_hold" || event.severity === "critical") {
    return "blocking";
  }
  if (event.severity === "error" || utteranceClass === "execution_anomaly") {
    return "urgent";
  }
  if (event.severity === "warning" || utteranceClass === "verification_result" || utteranceClass === "oops_diagnosis" || utteranceClass === "correction_preview") {
    return "high";
  }
  if (utteranceClass === "plan_preview" || utteranceClass === "task_completion" || utteranceClass === "audio_attention") {
    return "normal";
  }
  return "low";
}

function chooseRequiresTTS(
  event: ObservabilityEvent,
  utteranceClass: UtteranceClass,
  priority: MonologuePriority,
  policy: IntentBuilderPolicy,
  context: MonologueTaskContext,
): boolean {
  if (context.operator_tts_enabled === false) {
    return false;
  }
  if (priority === "blocking" && policy.require_tts_for_safety) {
    return true;
  }
  if (utteranceClass === "plan_preview") {
    return policy.speak_plan_previews;
  }
  if (utteranceClass === "verification_result" || utteranceClass === "task_completion") {
    return policy.speak_verification_results;
  }
  return severityRank(event.severity) >= severityRank("warning");
}

function shouldEmitIntent(event: ObservabilityEvent, utteranceClass: UtteranceClass, priority: MonologuePriority, policy: IntentBuilderPolicy): boolean {
  if (event.dashboard_visibility === "hidden") {
    return false;
  }
  if (priority === "low" && !policy.speak_routine_debug_events) {
    return false;
  }
  return utteranceClass !== "observation_summary" || severityRank(event.severity) >= severityRank("info");
}

function buildCandidateMessage(
  event: ObservabilityEvent,
  context: MonologueTaskContext,
  utteranceClass: UtteranceClass,
  maxChars: number,
  issues: ValidationIssue[],
): string {
  const goal = context.task_goal_summary === undefined ? "" : ` Task context: ${context.task_goal_summary}.`;
  const retry = context.retry_attempt_index === undefined || context.retry_attempt_index <= 0 ? "" : ` Retry attempt ${context.retry_attempt_index}.`;
  const prefix = prefixForClass(utteranceClass);
  const raw = `${prefix} ${event.summary}.${goal}${retry}`;
  return compressPublicMessage(sanitizePublicText(raw, true, maxChars, issues, "$.candidate_message"), maxChars);
}

function prefixForClass(utteranceClass: UtteranceClass): string {
  switch (utteranceClass) {
    case "memory_context":
      return "I remember prior context, and I will treat it as memory rather than current proof:";
    case "plan_preview":
      return "I am about to act from the current evidence:";
    case "validation_block":
      return "I cannot proceed yet:";
    case "execution_start":
      return "Starting the validated motion:";
    case "execution_anomaly":
      return "I detected an execution anomaly:";
    case "verification_result":
      return "Verification result:";
    case "oops_diagnosis":
      return "The correction loop diagnosed:";
    case "correction_preview":
      return "I will attempt a bounded correction:";
    case "audio_attention":
      return "I heard a sound cue:";
    case "safe_hold":
      return "Safety hold:";
    case "task_completion":
      return "Task status:";
    case "observation_summary":
      return "Current observation:";
  }
}

function chooseAudience(visibility: DashboardVisibility, fallback: MonologueAudience): MonologueAudience {
  if (visibility === "qa") {
    return "qa";
  }
  if (visibility === "safety_review") {
    return "safety_review";
  }
  if (visibility === "demo") {
    return "demo";
  }
  if (visibility === "operator") {
    return "operator";
  }
  return fallback;
}

function buildConfidenceLabels(event: ObservabilityEvent): readonly string[] {
  if (event.event_class === "verification" && /success|passed|certificate/i.test(event.summary)) {
    return freezeArray(["certificate-backed"]);
  }
  if (/ambiguous|unclear|blocked|occluded|uncertain/i.test(event.summary)) {
    return freezeArray(["ambiguous"]);
  }
  if (event.event_class === "audio") {
    return freezeArray(["audio-suggestive"]);
  }
  return freezeArray(["evidence-linked"]);
}

function buildSafetyLabels(event: ObservabilityEvent, context: MonologueTaskContext): readonly string[] {
  const labels = event.event_class === "safety" ? ["safety-event"] : [];
  return freezeArray([...labels, ...(context.safety_policy_refs ?? []).slice(0, 3).map((ref) => `policy:${ref}`)]);
}

function buildMemoryLabels(event: ObservabilityEvent, context: MonologueTaskContext): readonly string[] {
  if (event.event_class !== "memory" && (context.memory_context_refs ?? []).length === 0) {
    return freezeArray([]);
  }
  return freezeArray(["memory-labeled", ...(context.memory_context_refs ?? []).slice(0, 2)]);
}

function validateEvent(event: ObservabilityEvent, context: MonologueTaskContext, issues: ValidationIssue[]): void {
  validateRef(event.observability_event_ref, "$.event.observability_event_ref", issues);
  validateRef(event.subsystem_ref, "$.event.subsystem_ref", issues);
  validateOptionalRef(context.task_ref, "$.task_context.task_ref", issues);
  validateOptionalRef(context.latest_plan_ref, "$.task_context.latest_plan_ref", issues);
  validateOptionalRef(context.latest_certificate_ref, "$.task_context.latest_certificate_ref", issues);
  for (const [index, ref] of (context.safety_policy_refs ?? []).entries()) {
    validateRef(ref, `$.task_context.safety_policy_refs[${index}]`, issues);
  }
}

function mergePolicy(policy: Partial<IntentBuilderPolicy> | undefined, audience: MonologueAudience): IntentBuilderPolicy {
  return Object.freeze({
    max_candidate_chars: policy?.max_candidate_chars !== undefined && policy.max_candidate_chars > 0 ? Math.floor(policy.max_candidate_chars) : 240,
    speak_plan_previews: policy?.speak_plan_previews ?? true,
    speak_verification_results: policy?.speak_verification_results ?? true,
    speak_routine_debug_events: policy?.speak_routine_debug_events ?? false,
    require_tts_for_safety: policy?.require_tts_for_safety ?? true,
    default_audience: policy?.default_audience ?? audience,
  });
}

function makeReport(
  event: ObservabilityEvent,
  intent: MonologueIntent | undefined,
  suppressedReason: string | undefined,
  issues: readonly ValidationIssue[],
): MonologueIntentBuilderReport {
  const base = {
    intent_builder_report_ref: makeObservabilityRef("monologue_intent_builder_report", event.observability_event_ref),
    source_event_ref: event.observability_event_ref,
    intent,
    suppressed_reason: suppressedReason,
    issues: freezeArray(issues),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export const MONOLOGUE_INTENT_BUILDER_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: MONOLOGUE_INTENT_BUILDER_SCHEMA_VERSION,
  blueprint: "architecture_docs/17_INTERNAL_MONOLOGUE_TTS_OBSERVABILITY.md",
  sections: freezeArray(["17.4.1", "17.5", "17.6.1", "17.11", "17.12.1", "17.19"]),
  component: "MonologueIntentBuilder",
});
