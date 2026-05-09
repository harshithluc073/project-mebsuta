/**
 * Acoustic observability and TTS-safe event emission.
 *
 * Blueprint: `architecture_docs/16_ACOUSTIC_EMBODIMENT_AUDIO_REASONING.md`
 * sections 16.19, 16.20, 16.21, and 16.24.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import { AudioRoute, freezeArray, makeAcousticRef, routeRank, uniqueRefs } from "./audio_sensor_bus";
import type { AcousticMemoryWriteSet } from "./audio_memory_writer";
import type { AudioRouteDecisionSet, AudioRouteDecision } from "./audio_reasoning_router";

export const AUDIO_OBSERVABILITY_EMITTER_SCHEMA_VERSION = "mebsuta.audio_observability_emitter.v1" as const;

export type AcousticTimelineEventKind =
  | "AudioBundleCaptured"
  | "SoundEventDetected"
  | "SoundEventClassified"
  | "AudioLocalized"
  | "AudioRouteSelected"
  | "AudioAttentionRequested"
  | "AudioVerificationTriggered"
  | "AudioOopsTriggered"
  | "AcousticMemoryWritten"
  | "AudioSuppressedAsSelfNoise";

export interface AcousticTimelineEvent {
  readonly schema_version: typeof AUDIO_OBSERVABILITY_EMITTER_SCHEMA_VERSION;
  readonly timeline_event_ref: Ref;
  readonly event_kind: AcousticTimelineEventKind;
  readonly source_ref: Ref;
  readonly severity: "info" | "notice" | "warning" | "critical";
  readonly route?: AudioRoute;
  readonly evidence_refs: readonly Ref[];
  readonly tts_safe_summary: string;
  readonly dashboard_metric_updates: readonly {
    readonly metric_name: string;
    readonly delta: number;
  }[];
  readonly determinism_hash: string;
}

export interface AcousticObservabilityTimeline {
  readonly schema_version: typeof AUDIO_OBSERVABILITY_EMITTER_SCHEMA_VERSION;
  readonly timeline_ref: Ref;
  readonly events: readonly AcousticTimelineEvent[];
  readonly audio_event_detection_rate: number;
  readonly audio_triggered_verification_count: number;
  readonly audio_triggered_oops_count: number;
  readonly audio_safety_escalation_count: number;
  readonly self_noise_suppression_count: number;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export class AudioObservabilityEmitter {
  /**
   * Emits dashboard/TTS-safe timeline records from routing and memory outcomes.
   */
  public emitAcousticTimeline(
    routeDecisionSet: AudioRouteDecisionSet,
    memoryWriteSet?: AcousticMemoryWriteSet,
  ): AcousticObservabilityTimeline {
    const routeEvents = routeDecisionSet.decisions.flatMap((decision) => eventsForDecision(decision));
    const memoryEvents = memoryWriteSet === undefined
      ? []
      : memoryWriteSet.records.map((record) => makeEvent("AcousticMemoryWritten", record.acoustic_memory_ref, record.accepted ? "notice" : "warning", undefined, [record.route_decision_ref], record.accepted ? "Acoustic cue memory was recorded with uncertainty labels." : "Acoustic cue memory was not accepted by the memory write gate."));
    const events = freezeArray([...routeEvents, ...memoryEvents].sort(compareTimelineEvents));
    const base = {
      schema_version: AUDIO_OBSERVABILITY_EMITTER_SCHEMA_VERSION,
      timeline_ref: makeAcousticRef("acoustic_timeline", routeDecisionSet.route_decision_set_ref, events.length),
      events,
      audio_event_detection_rate: events.length === 0 ? 0 : 1,
      audio_triggered_verification_count: routeDecisionSet.decisions.filter((decision) => decision.verification_trigger_ref !== undefined).length,
      audio_triggered_oops_count: routeDecisionSet.decisions.filter((decision) => decision.oops_trigger_ref !== undefined).length,
      audio_safety_escalation_count: routeDecisionSet.decisions.filter((decision) => decision.safety_action_ref !== undefined || decision.human_review_ref !== undefined).length,
      self_noise_suppression_count: routeDecisionSet.decisions.filter((decision) => decision.selected_route === "ignore").length,
      issues: freezeArray([...(routeDecisionSet.issues ?? []), ...(memoryWriteSet?.issues ?? [])]),
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function emitAcousticTimeline(routeDecisionSet: AudioRouteDecisionSet, memoryWriteSet?: AcousticMemoryWriteSet): AcousticObservabilityTimeline {
  return new AudioObservabilityEmitter().emitAcousticTimeline(routeDecisionSet, memoryWriteSet);
}

function eventsForDecision(decision: AudioRouteDecision): readonly AcousticTimelineEvent[] {
  const events: AcousticTimelineEvent[] = [
    makeEvent("AudioRouteSelected", decision.route_decision_ref, severityFor(decision), decision.selected_route, decision.required_evidence_refs, summaryFor(decision)),
  ];
  if (decision.attention_request_ref !== undefined) events.push(makeEvent("AudioAttentionRequested", decision.attention_request_ref, "notice", decision.selected_route, decision.required_evidence_refs, "I heard a cue and will look toward the estimated region before acting."));
  if (decision.verification_trigger_ref !== undefined) events.push(makeEvent("AudioVerificationTriggered", decision.verification_trigger_ref, "warning", decision.selected_route, decision.required_evidence_refs, "I heard a task-relevant sound and will verify before continuing."));
  if (decision.oops_trigger_ref !== undefined) events.push(makeEvent("AudioOopsTriggered", decision.oops_trigger_ref, "warning", decision.selected_route, decision.required_evidence_refs, "The sound may indicate a failure, so correction intake needs evidence review."));
  if (decision.safety_action_ref !== undefined) events.push(makeEvent("AudioRouteSelected", decision.safety_action_ref, "critical", decision.selected_route, decision.required_evidence_refs, "The sound suggests possible collision risk, so I am stopping for safety."));
  if (decision.selected_route === "ignore") events.push(makeEvent("AudioSuppressedAsSelfNoise", decision.route_decision_ref, "info", decision.selected_route, decision.required_evidence_refs, "The sound is likely self-generated and is suppressed as external evidence."));
  return freezeArray(events);
}

function makeEvent(
  kind: AcousticTimelineEventKind,
  sourceRef: Ref,
  severity: AcousticTimelineEvent["severity"],
  route: AudioRoute | undefined,
  evidenceRefs: readonly Ref[],
  summary: string,
): AcousticTimelineEvent {
  const base = {
    schema_version: AUDIO_OBSERVABILITY_EMITTER_SCHEMA_VERSION,
    timeline_event_ref: makeAcousticRef("acoustic_timeline_event", kind, sourceRef),
    event_kind: kind,
    source_ref: makeAcousticRef(sourceRef),
    severity,
    route,
    evidence_refs: uniqueRefs(evidenceRefs),
    tts_safe_summary: summary,
    dashboard_metric_updates: freezeArray(metricUpdates(kind, route)),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function metricUpdates(kind: AcousticTimelineEventKind, route: AudioRoute | undefined): readonly { readonly metric_name: string; readonly delta: number }[] {
  const updates = [{ metric_name: "audio_timeline_events", delta: 1 }];
  if (kind === "AudioVerificationTriggered") updates.push({ metric_name: "audio_triggered_verification_count", delta: 1 });
  if (kind === "AudioOopsTriggered") updates.push({ metric_name: "audio_triggered_oops_count", delta: 1 });
  if (route === "safe_hold" || route === "human_review") updates.push({ metric_name: "audio_safety_escalation_count", delta: 1 });
  if (kind === "AudioSuppressedAsSelfNoise") updates.push({ metric_name: "self_noise_suppression_count", delta: 1 });
  return freezeArray(updates);
}

function severityFor(decision: AudioRouteDecision): AcousticTimelineEvent["severity"] {
  if (decision.priority === "blocking") return "critical";
  if (decision.priority === "high") return "warning";
  if (decision.priority === "normal") return "notice";
  return "info";
}

function summaryFor(decision: AudioRouteDecision): string {
  if (decision.selected_route === "safe_hold") return "I heard a high-risk sound and will stop for safety before continuing.";
  if (decision.selected_route === "verify") return "I heard a task-relevant sound and will verify the scene before declaring progress.";
  if (decision.selected_route === "oops") return "I heard a possible failure cue and will gather confirming evidence before correction.";
  if (decision.selected_route === "reobserve") return "I heard a sound and will reobserve toward the estimated direction.";
  if (decision.selected_route === "ignore") return "I heard likely self-noise and will not treat it as an external cue.";
  return "I recorded the sound as context with uncertainty.";
}

function compareTimelineEvents(a: AcousticTimelineEvent, b: AcousticTimelineEvent): number {
  return routeRank(b.route ?? "ignore") - routeRank(a.route ?? "ignore") || a.timeline_event_ref.localeCompare(b.timeline_event_ref);
}
