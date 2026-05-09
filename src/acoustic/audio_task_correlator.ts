/**
 * Audio-to-task correlation for acoustic reasoning.
 *
 * Blueprint: `architecture_docs/16_ACOUSTIC_EMBODIMENT_AUDIO_REASONING.md`
 * sections 16.7.2, 16.9, 16.10, 16.11, 16.14, 16.15, and 16.18.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  AudioEvent,
  AudioExpectednessStatus,
  AudioLocalizationEstimate,
  AudioRiskLevel,
  AudioRoute,
  AudioTaskPhase,
  AudioTaskPhaseCorrelation,
  freezeArray,
  makeAcousticRef,
  riskRank,
  round6,
  uniqueRefs,
} from "./audio_sensor_bus";
import type { AudioLocalizationSet } from "./spatial_audio_localizer";

export const AUDIO_TASK_CORRELATOR_SCHEMA_VERSION = "mebsuta.audio_task_correlator.v1" as const;

export interface ActiveTaskAcousticContext {
  readonly task_context_ref: Ref;
  readonly task_phase: AudioTaskPhase;
  readonly active_goal_ref?: Ref;
  readonly expected_sound_classes: readonly AudioTaskPhaseCorrelation["expected_sound_classes"][number][];
  readonly affected_constraint_refs: readonly Ref[];
  readonly fragile_region_refs: readonly Ref[];
  readonly controller_anomaly_refs: readonly Ref[];
  readonly contact_evidence_refs: readonly Ref[];
  readonly speaker_active: boolean;
  readonly visual_confirmation_available: boolean;
}

export interface AudioTaskCorrelationReport {
  readonly schema_version: typeof AUDIO_TASK_CORRELATOR_SCHEMA_VERSION;
  readonly correlation_report_ref: Ref;
  readonly audio_event_ref: Ref;
  readonly task_context_ref: Ref;
  readonly task_phase: AudioTaskPhase;
  readonly expectedness_status: AudioExpectednessStatus;
  readonly task_relevance_score: number;
  readonly safety_relevance_score: number;
  readonly affected_constraint_refs: readonly Ref[];
  readonly supporting_evidence_refs: readonly Ref[];
  readonly direction_estimate_ref?: Ref;
  readonly confidence_class: "low" | "medium" | "high";
  readonly recommended_route: AudioRoute;
  readonly reason: string;
  readonly determinism_hash: string;
}

export interface AudioTaskCorrelationSet {
  readonly schema_version: typeof AUDIO_TASK_CORRELATOR_SCHEMA_VERSION;
  readonly correlation_set_ref: Ref;
  readonly reports: readonly AudioTaskCorrelationReport[];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export class AudioTaskCorrelator {
  /**
   * Correlates classified audio events with the active task phase and evidence.
   */
  public correlateAudioWithTask(
    events: readonly AudioEvent[],
    localizationSet: AudioLocalizationSet,
    taskContext: ActiveTaskAcousticContext,
  ): AudioTaskCorrelationSet {
    const reports = events.map((event) => correlateOne(event, localizationSet.localizations.find((estimate) => estimate.audio_event_ref === event.audio_event_ref), taskContext));
    const base = {
      schema_version: AUDIO_TASK_CORRELATOR_SCHEMA_VERSION,
      correlation_set_ref: makeAcousticRef("audio_correlation_set", taskContext.task_context_ref, reports.length),
      reports: freezeArray(reports.sort(compareReports)),
      issues: localizationSet.issues,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function correlateAudioWithTask(
  events: readonly AudioEvent[],
  localizationSet: AudioLocalizationSet,
  taskContext: ActiveTaskAcousticContext,
): AudioTaskCorrelationSet {
  return new AudioTaskCorrelator().correlateAudioWithTask(events, localizationSet, taskContext);
}

function correlateOne(event: AudioEvent, localization: AudioLocalizationEstimate | undefined, context: ActiveTaskAcousticContext): AudioTaskCorrelationReport {
  const expected = context.expected_sound_classes.includes(event.event_class);
  const phaseSensitive = ["carry", "place", "release", "tool_use", "verify"].includes(context.task_phase);
  const directionUseful = localization !== undefined && localization.localization_confidence >= 0.18;
  const taskRelevance = round6(Math.min(1, event.classification_confidence * 0.4 + (expected || phaseSensitive ? 0.22 : 0) + (directionUseful ? 0.18 : 0) + (event.recommended_route !== "ignore" ? 0.2 : 0)));
  const fragile = context.fragile_region_refs.length > 0 && (event.event_class === "impact" || event.event_class === "scrape");
  const safetyRelevance = round6(Math.min(1, riskRank(event.risk_level) / 4 + (fragile ? 0.24 : 0) + (context.controller_anomaly_refs.length > 0 ? 0.18 : 0)));
  const expectedness: AudioExpectednessStatus = event.event_class === "self_noise"
    ? "expected"
    : expected
      ? "expected"
      : event.expectedness_status === "impossible_to_judge"
        ? "impossible_to_judge"
        : "unexpected";
  const route = chooseCorrelationRoute(event.recommended_route, event.risk_level, safetyRelevance, taskRelevance, context.visual_confirmation_available);
  const base = {
    schema_version: AUDIO_TASK_CORRELATOR_SCHEMA_VERSION,
    correlation_report_ref: makeAcousticRef("audio_correlation", event.audio_event_ref, context.task_context_ref),
    audio_event_ref: event.audio_event_ref,
    task_context_ref: makeAcousticRef(context.task_context_ref),
    task_phase: context.task_phase,
    expectedness_status: expectedness,
    task_relevance_score: taskRelevance,
    safety_relevance_score: safetyRelevance,
    affected_constraint_refs: uniqueRefs([...context.affected_constraint_refs, ...(event.event_class === "impact" || event.event_class === "roll" ? ["constraint:visual_final_state"] : [])]),
    supporting_evidence_refs: uniqueRefs([...event.evidence_refs, ...context.controller_anomaly_refs, ...context.contact_evidence_refs]),
    direction_estimate_ref: localization?.localization_ref,
    confidence_class: confidenceClass(Math.max(taskRelevance, safetyRelevance), event.classification_confidence, localization?.localization_confidence ?? 0),
    recommended_route: route,
    reason: reasonFor(event, route, expectedness, context),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function chooseCorrelationRoute(route: AudioRoute, risk: AudioRiskLevel, safetyScore: number, taskScore: number, visualAvailable: boolean): AudioRoute {
  if (risk === "blocking" || safetyScore >= 0.88) return "safe_hold";
  if (!visualAvailable && safetyScore >= 0.58) return "human_review";
  if (route === "oops" && visualAvailable) return "oops";
  if (riskRank(risk) >= 2 || taskScore >= 0.62) return "verify";
  if (taskScore >= 0.32) return "reobserve";
  return route;
}

function confidenceClass(relevance: number, eventConfidence: number, localizationConfidence: number): AudioTaskCorrelationReport["confidence_class"] {
  const score = relevance * 0.45 + eventConfidence * 0.4 + localizationConfidence * 0.15;
  if (score >= 0.68) return "high";
  if (score >= 0.38) return "medium";
  return "low";
}

function reasonFor(event: AudioEvent, route: AudioRoute, expectedness: AudioExpectednessStatus, context: ActiveTaskAcousticContext): string {
  if (route === "safe_hold") return "Acoustic cue and task context indicate a safety-relevant interruption.";
  if (route === "human_review") return "Acoustic cue is safety-relevant but visual confirmation is unavailable.";
  if (route === "oops") return "Acoustic cue may indicate task failure and should enter Oops only after confirmation.";
  if (route === "verify") return `Acoustic ${event.event_class} cue during ${context.task_phase} requires verification before success.`;
  if (route === "reobserve") return "Acoustic direction or class is useful as an attention cue, not as proof.";
  if (expectedness === "expected") return "Acoustic cue matches expected task or self-motion context.";
  return "Acoustic cue has low task relevance and is retained as context.";
}

function compareReports(a: AudioTaskCorrelationReport, b: AudioTaskCorrelationReport): number {
  return b.safety_relevance_score - a.safety_relevance_score || b.task_relevance_score - a.task_relevance_score || a.audio_event_ref.localeCompare(b.audio_event_ref);
}
