/**
 * Oops episode recorder for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/14_OOPS_LOOP_CORRECTION_ENGINE.md`
 * sections 14.4, 14.5, 14.19.7, 14.21, 14.22, and 14.24.
 *
 * The recorder stores an auditable correction timeline and replay summary for
 * every Oops episode artifact.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  OOPS_BLUEPRINT_REF,
  cleanOopsRef,
  cleanOopsText,
  freezeOopsArray,
  makeOopsRef,
  uniqueOopsSorted,
  type OopsEpisode,
  type OopsEpisodeState,
  type OopsRouteDecision,
} from "./oops_intake_router";

export const OOPS_EPISODE_RECORDER_SCHEMA_VERSION = "mebsuta.oops_episode_recorder.v1" as const;

export type OopsTimelineEventKind =
  | "OopsTriggered"
  | "OopsEvidenceBundleBuilt"
  | "OopsFailureClassified"
  | "OopsGeminiDiagnosisReceived"
  | "OopsPlanNormalized"
  | "OopsSafetyValidated"
  | "OopsFeasibilityValidated"
  | "OopsCorrectionStarted"
  | "OopsCorrectionCompleted"
  | "OopsPostVerificationCompleted"
  | "OopsEpisodeClosed";

export interface OopsTimelineEvent {
  readonly event_ref: Ref;
  readonly event_kind: OopsTimelineEventKind;
  readonly episode_state: OopsEpisodeState;
  readonly timestamp_ms: number;
  readonly artifact_refs: readonly Ref[];
  readonly summary: string;
  readonly determinism_hash: string;
}

export interface OopsEpisodeSummary {
  readonly schema_version: typeof OOPS_EPISODE_RECORDER_SCHEMA_VERSION;
  readonly blueprint_ref: typeof OOPS_BLUEPRINT_REF;
  readonly summary_ref: Ref;
  readonly oops_episode_ref: Ref;
  readonly terminal_outcome: OopsRouteDecision | "complete";
  readonly timeline_event_refs: readonly Ref[];
  readonly artifact_refs: readonly Ref[];
  readonly audit_refs: readonly Ref[];
  readonly replay_ready: boolean;
  readonly prompt_safe_summary: string;
  readonly determinism_hash: string;
}

export interface OopsEpisodeRecorderRequest {
  readonly request_ref?: Ref;
  readonly episode: OopsEpisode;
  readonly terminal_outcome: OopsRouteDecision | "complete";
  readonly artifact_refs: readonly Ref[];
  readonly audit_refs: readonly Ref[];
  readonly timestamp_ms: number;
}

export interface OopsEpisodeRecorderReport {
  readonly schema_version: typeof OOPS_EPISODE_RECORDER_SCHEMA_VERSION;
  readonly blueprint_ref: typeof OOPS_BLUEPRINT_REF;
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly timeline_events: readonly OopsTimelineEvent[];
  readonly episode_summary: OopsEpisodeSummary;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "oops_episode_recorder_report";
  readonly determinism_hash: string;
}

/**
 * Records Oops episode timeline and replay metadata.
 */
export class OopsEpisodeRecorder {
  /**
   * Closes an episode with a deterministic audit summary.
   */
  public closeOopsEpisode(request: OopsEpisodeRecorderRequest): OopsEpisodeRecorderReport {
    const issues: ValidationIssue[] = [];
    const events = buildEvents(request);
    const summary = buildSummary(request, events);
    const requestRef = cleanOopsRef(request.request_ref ?? makeOopsRef("oops_episode_recorder", request.episode.oops_episode_ref));
    const base = {
      schema_version: OOPS_EPISODE_RECORDER_SCHEMA_VERSION,
      blueprint_ref: OOPS_BLUEPRINT_REF,
      report_ref: makeOopsRef("oops_episode_recorder_report", requestRef, request.terminal_outcome),
      request_ref: requestRef,
      timeline_events: events,
      episode_summary: summary,
      issues: freezeOopsArray(issues),
      ok: summary.replay_ready,
      cognitive_visibility: "oops_episode_recorder_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function createOopsEpisodeRecorder(): OopsEpisodeRecorder {
  return new OopsEpisodeRecorder();
}

function buildEvents(request: OopsEpisodeRecorderRequest): readonly OopsTimelineEvent[] {
  const kinds: readonly [OopsTimelineEventKind, OopsEpisodeState][] = [
    ["OopsTriggered", "intake"],
    ["OopsEvidenceBundleBuilt", "evidence_collection"],
    ["OopsFailureClassified", "failure_classification"],
    ["OopsGeminiDiagnosisReceived", "cognitive_diagnosis"],
    ["OopsPlanNormalized", "plan_normalization"],
    ["OopsSafetyValidated", "safety_validation"],
    ["OopsFeasibilityValidated", "feasibility_validation"],
    ["OopsCorrectionStarted", "correction_execution"],
    ["OopsCorrectionCompleted", "verification_bridge"],
    ["OopsPostVerificationCompleted", request.terminal_outcome === "complete" ? "complete" : "reobserve"],
    ["OopsEpisodeClosed", request.terminal_outcome === "safe_hold" ? "safe_hold" : request.terminal_outcome === "human_review" ? "human_review" : "complete"],
  ];
  return freezeOopsArray(kinds.map(([kind, state], index) => {
    const base = {
      event_ref: makeOopsRef("oops_event", request.episode.oops_episode_ref, kind, index.toString()),
      event_kind: kind,
      episode_state: state,
      timestamp_ms: request.timestamp_ms + index,
      artifact_refs: uniqueOopsSorted(request.artifact_refs.map(cleanOopsRef)),
      summary: cleanOopsText(`${kind} recorded for terminal outcome ${request.terminal_outcome}.`),
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }));
}

function buildSummary(request: OopsEpisodeRecorderRequest, events: readonly OopsTimelineEvent[]): OopsEpisodeSummary {
  const artifactRefs = uniqueOopsSorted(request.artifact_refs.map(cleanOopsRef));
  const auditRefs = uniqueOopsSorted(request.audit_refs.map(cleanOopsRef));
  const base = {
    schema_version: OOPS_EPISODE_RECORDER_SCHEMA_VERSION,
    blueprint_ref: OOPS_BLUEPRINT_REF,
    summary_ref: makeOopsRef("oops_episode_summary", request.episode.oops_episode_ref, request.terminal_outcome),
    oops_episode_ref: request.episode.oops_episode_ref,
    terminal_outcome: request.terminal_outcome,
    timeline_event_refs: uniqueOopsSorted(events.map((event) => event.event_ref)),
    artifact_refs: artifactRefs,
    audit_refs: auditRefs,
    replay_ready: artifactRefs.length > 0 && auditRefs.length > 0,
    prompt_safe_summary: cleanOopsText(`Oops episode ${request.episode.oops_episode_ref} closed with ${request.terminal_outcome}.`),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}
