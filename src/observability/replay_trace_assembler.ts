/**
 * Replay trace assembler for Project Mebsuta observability.
 *
 * Blueprint: `architecture_docs/17_INTERNAL_MONOLOGUE_TTS_OBSERVABILITY.md`
 * sections 17.4.1, 17.12.4, 17.14.1, 17.16, 17.17, 17.18, and 17.19.
 *
 * The assembler turns timeline events into replay bundles with decision traces,
 * evidence coverage, and redaction manifests suitable for QA and developer
 * diagnosis.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref } from "../simulation/world_manifest";
import {
  freezeArray,
  makeObservabilityRef,
  uniqueRefs,
  visibilityAllows,
} from "./observability_event_emitter";
import type {
  DashboardVisibility,
  DecisionTraceRecord,
  ObservabilityEvent,
  ProvenanceStatus,
  ReplayBundle,
} from "./observability_event_emitter";

export const REPLAY_TRACE_ASSEMBLER_SCHEMA_VERSION = "mebsuta.replay_trace_assembler.v1" as const;

export interface ReplayAssemblyInput {
  readonly task_ref: Ref;
  readonly timeline_events: readonly ObservabilityEvent[];
  readonly existing_decision_traces?: readonly DecisionTraceRecord[];
  readonly model_advisory_refs?: readonly Ref[];
  readonly deterministic_validator_refs?: readonly Ref[];
}

export interface ReplayRedactionPolicy {
  readonly visibility_mode: DashboardVisibility;
  readonly include_qa_events: boolean;
  readonly preserve_safety_events: boolean;
}

/**
 * Creates replayable traces for a task and time window.
 */
export class ReplayTraceAssembler {
  public assembleReplayTrace(taskRef: Ref, timeWindow: { readonly start_ms: number; readonly end_ms: number }, input: ReplayAssemblyInput, redactionPolicy: ReplayRedactionPolicy): ReplayBundle {
    const windowedEvents = input.timeline_events
      .filter((event) => event.task_ref === taskRef || taskRef === input.task_ref)
      .filter((event) => event.event_time_ms >= timeWindow.start_ms && event.event_time_ms <= timeWindow.end_ms)
      .filter((event) => shouldIncludeEvent(event, redactionPolicy))
      .sort((left, right) => left.event_time_ms - right.event_time_ms || left.observability_event_ref.localeCompare(right.observability_event_ref));

    const generatedTraces = windowedEvents.map((event) => buildDecisionTrace(event, input.model_advisory_refs ?? [], input.deterministic_validator_refs ?? []));
    const decisionTraces = freezeArray([...(input.existing_decision_traces ?? []), ...generatedTraces]);
    const evidenceRefs = uniqueRefs(windowedEvents.flatMap((event) => event.artifact_refs));
    const eventRefs = uniqueRefs(windowedEvents.map((event) => event.observability_event_ref));
    const completeness = computeCompleteness(windowedEvents, decisionTraces, evidenceRefs);
    const base = {
      replay_bundle_ref: makeObservabilityRef("replay_bundle", taskRef, timeWindow.start_ms, timeWindow.end_ms, redactionPolicy.visibility_mode),
      task_ref: taskRef,
      window_start_ms: timeWindow.start_ms,
      window_end_ms: timeWindow.end_ms,
      event_refs: eventRefs,
      evidence_refs: evidenceRefs,
      decision_traces: decisionTraces,
      redaction_manifest_ref: makeObservabilityRef("replay_redaction_manifest", taskRef, redactionPolicy.visibility_mode),
      completeness_score: completeness,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

function shouldIncludeEvent(event: ObservabilityEvent, policy: ReplayRedactionPolicy): boolean {
  if (event.event_class === "qa" && !policy.include_qa_events) {
    return false;
  }
  if (policy.preserve_safety_events && event.event_class === "safety") {
    return true;
  }
  return visibilityAllows(event.dashboard_visibility, policy.visibility_mode);
}

function buildDecisionTrace(event: ObservabilityEvent, modelRefs: readonly Ref[], validatorRefs: readonly Ref[]): DecisionTraceRecord {
  const decisionType = classifyDecision(event);
  const base = {
    decision_trace_ref: makeObservabilityRef("decision_trace", event.observability_event_ref, decisionType),
    decision_type: decisionType,
    input_artifact_refs: event.artifact_refs,
    decision_summary: event.summary,
    decision_owner_component: event.subsystem_ref,
    model_advisory_refs: decisionType === "plan" || event.event_class === "cognition" ? freezeArray(modelRefs) : freezeArray([]),
    deterministic_validator_refs: decisionType === "validate" || decisionType === "safe_hold" || event.event_class === "verification" ? freezeArray(validatorRefs) : freezeArray([]),
    output_artifact_refs: freezeArray([event.observability_event_ref]),
    truth_boundary_status: event.provenance_status as ProvenanceStatus,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function classifyDecision(event: ObservabilityEvent): DecisionTraceRecord["decision_type"] {
  if (event.event_class === "perception" || event.event_class === "audio") {
    return "observe";
  }
  if (event.event_class === "cognition" || event.event_class === "state") {
    return "plan";
  }
  if (event.event_class === "safety") {
    return "safe_hold";
  }
  if (event.event_class === "control") {
    return "execute";
  }
  if (event.event_class === "verification") {
    return "verify";
  }
  if (event.event_class === "oops") {
    return "correct";
  }
  if (event.event_class === "memory") {
    return "remember";
  }
  return "speak";
}

function computeCompleteness(events: readonly ObservabilityEvent[], traces: readonly DecisionTraceRecord[], evidenceRefs: readonly Ref[]): number {
  if (events.length === 0) {
    return 0;
  }
  const eventCoverage = traces.length / events.length;
  const evidenceCoverage = events.every((event) => event.artifact_refs.length > 0) ? 1 : evidenceRefs.length / Math.max(1, events.length);
  return Math.round(Math.min(1, (eventCoverage * 0.6) + (Math.min(1, evidenceCoverage) * 0.4)) * 100) / 100;
}

export const REPLAY_TRACE_ASSEMBLER_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: REPLAY_TRACE_ASSEMBLER_SCHEMA_VERSION,
  blueprint: "architecture_docs/17_INTERNAL_MONOLOGUE_TTS_OBSERVABILITY.md",
  sections: freezeArray(["17.4.1", "17.12.4", "17.14.1", "17.16", "17.17", "17.18", "17.19"]),
  component: "ReplayTraceAssembler",
});
