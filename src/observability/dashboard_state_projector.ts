/**
 * Dashboard state projector for Project Mebsuta observability.
 *
 * Blueprint: `architecture_docs/17_INTERNAL_MONOLOGUE_TTS_OBSERVABILITY.md`
 * sections 17.4.1, 17.6.5, 17.10, 17.12.4, 17.13, 17.14.3, and 17.19.
 *
 * The projector builds a visibility-scoped dashboard snapshot from timeline
 * events, queue state, playback receipts, and redaction reports.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref } from "../simulation/world_manifest";
import {
  freezeArray,
  makeObservabilityRef,
  severityRank,
  uniqueRefs,
  visibilityAllows,
} from "./observability_event_emitter";
import type {
  DashboardStateSnapshot,
  DashboardVisibility,
  MonologueFilterDecision,
  ObservabilityEvent,
  QueuedUtterance,
  TTSPlaybackEvent,
} from "./observability_event_emitter";

export const DASHBOARD_STATE_PROJECTOR_SCHEMA_VERSION = "mebsuta.dashboard_state_projector.v1" as const;

export interface DashboardProjectionInput {
  readonly snapshot_time_ms: number;
  readonly timeline_events: readonly ObservabilityEvent[];
  readonly queued_utterances: readonly QueuedUtterance[];
  readonly playback_events: readonly TTSPlaybackEvent[];
  readonly filter_decisions: readonly MonologueFilterDecision[];
  readonly active_task_ref?: Ref;
  readonly active_state_ref?: Ref;
}

/**
 * Projects operator, developer, demo, QA, or safety-review dashboard state.
 */
export class DashboardStateProjector {
  public projectDashboardState(input: DashboardProjectionInput, visibilityMode: DashboardVisibility): DashboardStateSnapshot {
    const visibleEvents = input.timeline_events.filter((event) => visibilityAllows(event.dashboard_visibility, visibilityMode));
    const visiblePlayback = input.playback_events.filter((event) => event.playback_status !== "skipped");
    const activeAlerts = buildAlerts(visibleEvents, input.filter_decisions, visibilityMode);
    const evidenceRefs = uniqueRefs(visibleEvents.flatMap((event) => event.artifact_refs));
    const decisionRefs = uniqueRefs([
      ...input.filter_decisions.map((decision) => decision.filter_decision_ref),
      ...visiblePlayback.map((event) => event.tts_playback_ref),
      input.active_state_ref,
    ]);
    const taskSummary = buildTaskSummary(input, visibleEvents);
    const queueSummary = buildQueueSummary(input.queued_utterances, visiblePlayback);
    const base = {
      dashboard_snapshot_ref: makeObservabilityRef("dashboard_snapshot", visibilityMode, input.active_task_ref, input.snapshot_time_ms),
      snapshot_time_ms: input.snapshot_time_ms,
      visibility_mode: visibilityMode,
      task_state_summary: taskSummary,
      active_evidence_refs: evidenceRefs,
      active_decision_refs: decisionRefs,
      active_alerts: freezeArray(activeAlerts),
      tts_queue_summary: queueSummary,
      redaction_manifest_ref: makeObservabilityRef("dashboard_redaction_manifest", visibilityMode, input.snapshot_time_ms),
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

function buildTaskSummary(input: DashboardProjectionInput, events: readonly ObservabilityEvent[]): string {
  const latest = [...events].sort((left, right) => right.event_time_ms - left.event_time_ms)[0];
  const task = input.active_task_ref ?? latest?.task_ref ?? "task:unbound";
  const state = input.active_state_ref ?? latest?.state_ref ?? "state:unknown";
  const summary = latest?.summary ?? "No visible timeline events for this dashboard mode.";
  return `${task} | ${state} | ${summary}`;
}

function buildQueueSummary(queue: readonly QueuedUtterance[], playback: readonly TTSPlaybackEvent[]): string {
  const active = playback.filter((event) => event.playback_status === "started" || event.playback_status === "queued").length;
  const next = [...queue].sort((left, right) => left.queued_at_ms - right.queued_at_ms)[0];
  return next === undefined ? `${active} active playback records; queue empty.` : `${active} active playback records; next ${next.priority} utterance ${next.utterance_ref}.`;
}

function buildAlerts(events: readonly ObservabilityEvent[], filterDecisions: readonly MonologueFilterDecision[], mode: DashboardVisibility): readonly string[] {
  const severe = events
    .filter((event) => severityRank(event.severity) >= severityRank("warning"))
    .sort((left, right) => severityRank(right.severity) - severityRank(left.severity) || right.event_time_ms - left.event_time_ms)
    .slice(0, 8)
    .map((event) => `${event.severity}:${event.event_class}:${event.summary}`);
  const redactions = filterDecisions
    .filter((decision) => decision.redaction_report.audit_required || decision.outcome === "block_and_raise_audit")
    .slice(0, mode === "qa" ? 8 : 3)
    .map((decision) => `redaction:${decision.outcome}:${decision.source_intent_ref}`);
  return freezeArray([...severe, ...redactions]);
}

export const DASHBOARD_STATE_PROJECTOR_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: DASHBOARD_STATE_PROJECTOR_SCHEMA_VERSION,
  blueprint: "architecture_docs/17_INTERNAL_MONOLOGUE_TTS_OBSERVABILITY.md",
  sections: freezeArray(["17.4.1", "17.6.5", "17.10", "17.12.4", "17.13", "17.14.3", "17.19"]),
  component: "DashboardStateProjector",
});
