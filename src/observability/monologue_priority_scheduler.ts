/**
 * Monologue priority scheduler for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/17_INTERNAL_MONOLOGUE_TTS_OBSERVABILITY.md`
 * sections 17.4.1, 17.7.2, 17.11, 17.12.2, 17.15, 17.16, and 17.18.
 *
 * This scheduler orders approved utterances, suppresses repeated chatter, and
 * guarantees that safety and Oops narration can interrupt routine speech.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref } from "../simulation/world_manifest";
import {
  freezeArray,
  makeObservabilityRef,
  priorityRank,
  uniqueRefs,
} from "./observability_event_emitter";
import type {
  ApprovedMonologueUtterance,
  MonologuePriority,
  QueuedUtterance,
  QueueAction,
  UtteranceScheduleDecision,
} from "./observability_event_emitter";

export const MONOLOGUE_PRIORITY_SCHEDULER_SCHEMA_VERSION = "mebsuta.monologue_priority_scheduler.v1" as const;

export interface ActiveSpeechState {
  readonly utterance_ref: Ref;
  readonly priority: MonologuePriority;
  readonly started_at_ms: number;
  readonly interruptible: boolean;
}

export interface QueueContext {
  readonly now_ms: number;
  readonly active_speech?: ActiveSpeechState;
  readonly queued_utterances: readonly QueuedUtterance[];
  readonly recent_utterances: readonly QueuedUtterance[];
}

export interface PrioritySchedulerPolicy {
  readonly max_queue_depth: number;
  readonly repeated_message_suppression_ms: number;
  readonly max_low_priority_per_window: number;
  readonly low_priority_window_ms: number;
  readonly allow_interruptions: boolean;
}

/**
 * Creates deterministic playback queue decisions from approved utterances.
 */
export class MonologuePriorityScheduler {
  public scheduleMonologueUtterance(
    approvedUtterance: ApprovedMonologueUtterance,
    currentQueue: QueueContext,
    priorityPolicy?: Partial<PrioritySchedulerPolicy>,
  ): UtteranceScheduleDecision {
    const policy = mergePolicy(priorityPolicy);
    if (approvedUtterance.display_only) {
      return makeDecision(approvedUtterance, "display_only", currentQueue.queued_utterances, undefined, "Utterance is dashboard-only.");
    }
    if (isRepeated(approvedUtterance, currentQueue, policy)) {
      return makeDecision(approvedUtterance, "skip", currentQueue.queued_utterances, undefined, "Repeated low-urgency narration was suppressed.");
    }
    if (isLowPriorityWindowFull(approvedUtterance, currentQueue, policy)) {
      return makeDecision(approvedUtterance, "skip", currentQueue.queued_utterances, undefined, "Low-priority chatter window is full.");
    }

    const active = currentQueue.active_speech;
    if (active === undefined) {
      return makeDecision(approvedUtterance, "play_now", currentQueue.queued_utterances, undefined, "No active speech is playing.");
    }
    if (shouldInterrupt(active, approvedUtterance, policy)) {
      return makeDecision(approvedUtterance, "interrupt_and_play", currentQueue.queued_utterances, active.utterance_ref, "Higher-priority safety or anomaly narration interrupts active speech.");
    }
    const queued = enqueue(currentQueue.queued_utterances, approvedUtterance, currentQueue.now_ms, policy.max_queue_depth);
    return makeDecision(approvedUtterance, "queue", queued, undefined, "Active speech continues; utterance entered priority queue.");
  }

  /**
   * Compresses an utterance for queue storage without changing its source refs.
   */
  public compressUtterance(approvedUtterance: ApprovedMonologueUtterance, maxChars: number): ApprovedMonologueUtterance {
    const finalMessage = approvedUtterance.final_message.length <= maxChars ? approvedUtterance.final_message : approvedUtterance.final_message.slice(0, Math.max(60, maxChars)).trim();
    const base = { ...approvedUtterance, final_message: finalMessage };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

function shouldInterrupt(active: ActiveSpeechState, incoming: ApprovedMonologueUtterance, policy: PrioritySchedulerPolicy): boolean {
  if (!policy.allow_interruptions || !active.interruptible) {
    return false;
  }
  return priorityRank(incoming.priority) >= priorityRank("urgent") && priorityRank(incoming.priority) > priorityRank(active.priority);
}

function isRepeated(utterance: ApprovedMonologueUtterance, context: QueueContext, policy: PrioritySchedulerPolicy): boolean {
  if (priorityRank(utterance.priority) >= priorityRank("high")) {
    return false;
  }
  return context.recent_utterances.some((recent) =>
    recent.final_message === utterance.final_message
    && context.now_ms - recent.queued_at_ms <= policy.repeated_message_suppression_ms,
  );
}

function isLowPriorityWindowFull(utterance: ApprovedMonologueUtterance, context: QueueContext, policy: PrioritySchedulerPolicy): boolean {
  if (priorityRank(utterance.priority) >= priorityRank("normal")) {
    return false;
  }
  const recentLow = context.recent_utterances.filter((recent) =>
    priorityRank(recent.priority) <= priorityRank("low")
    && context.now_ms - recent.queued_at_ms <= policy.low_priority_window_ms,
  );
  return recentLow.length >= policy.max_low_priority_per_window;
}

function enqueue(existing: readonly QueuedUtterance[], utterance: ApprovedMonologueUtterance, nowMs: number, maxDepth: number): readonly QueuedUtterance[] {
  const queued: QueuedUtterance = Object.freeze({
    utterance_ref: utterance.utterance_ref,
    source_intent_ref: utterance.source_intent_ref,
    final_message: utterance.final_message,
    priority: utterance.priority,
    utterance_class: utterance.utterance_class,
    queued_at_ms: nowMs,
    display_only: utterance.display_only,
  });
  return freezeArray([...existing, queued].sort((left, right) => priorityRank(right.priority) - priorityRank(left.priority) || left.queued_at_ms - right.queued_at_ms).slice(0, maxDepth));
}

function makeDecision(
  utterance: ApprovedMonologueUtterance,
  action: QueueAction,
  queue: readonly QueuedUtterance[],
  interrupted: Ref | undefined,
  reason: string,
): UtteranceScheduleDecision {
  const base = {
    schedule_decision_ref: makeObservabilityRef("utterance_schedule_decision", utterance.utterance_ref, action),
    action,
    selected_utterance_ref: action === "skip" ? undefined : utterance.utterance_ref,
    interrupted_utterance_ref: interrupted,
    queued_utterances: freezeArray(queue),
    reason,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function mergePolicy(policy?: Partial<PrioritySchedulerPolicy>): PrioritySchedulerPolicy {
  return Object.freeze({
    max_queue_depth: policy?.max_queue_depth !== undefined && policy.max_queue_depth > 0 ? Math.floor(policy.max_queue_depth) : 5,
    repeated_message_suppression_ms: policy?.repeated_message_suppression_ms !== undefined && policy.repeated_message_suppression_ms > 0 ? Math.floor(policy.repeated_message_suppression_ms) : 12_000,
    max_low_priority_per_window: policy?.max_low_priority_per_window !== undefined && policy.max_low_priority_per_window >= 0 ? Math.floor(policy.max_low_priority_per_window) : 2,
    low_priority_window_ms: policy?.low_priority_window_ms !== undefined && policy.low_priority_window_ms > 0 ? Math.floor(policy.low_priority_window_ms) : 30_000,
    allow_interruptions: policy?.allow_interruptions ?? true,
  });
}

export const MONOLOGUE_PRIORITY_SCHEDULER_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: MONOLOGUE_PRIORITY_SCHEDULER_SCHEMA_VERSION,
  blueprint: "architecture_docs/17_INTERNAL_MONOLOGUE_TTS_OBSERVABILITY.md",
  sections: freezeArray(["17.4.1", "17.7.2", "17.11", "17.12.2", "17.15", "17.16", "17.18"]),
  component: "MonologuePriorityScheduler",
  queue_actions: uniqueRefs(["play_now", "interrupt_and_play", "queue", "display_only", "skip"]),
});
