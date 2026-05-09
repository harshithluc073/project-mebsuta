/**
 * Memory decay scheduler for Project Mebsuta episodic memory.
 *
 * Blueprint: `architecture_docs/15_RAG_EPISODIC_SPATIAL_MEMORY_ARCHITECTURE.md`
 * sections 15.5.2, 15.10, 15.11.3, 15.19.3, 15.20.2, and 15.24.
 *
 * The scheduler updates freshness, staleness, and archival recommendations
 * from time, object mobility, scene events, and contradictions.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  MEMORY_BLUEPRINT_REF,
  cleanMemoryText,
  freezeMemoryArray,
  makeMemoryIssue,
  makeMemoryRef,
  roundMemoryScore,
  scoreAgeFreshness,
  type MemoryLifecycleState,
  type MemoryRecordBase,
} from "./memory_write_gate";

export const MEMORY_DECAY_SCHEDULER_SCHEMA_VERSION = "mebsuta.memory_decay_scheduler.v1" as const;

export type MemorySceneEventKind = "object_motion" | "agent_manipulation" | "occlusion" | "audio_motion_cue" | "task_boundary" | "contradiction" | "safety_event";

export interface MemorySceneEvent {
  readonly event_ref: Ref;
  readonly event_kind: MemorySceneEventKind;
  readonly affected_memory_refs: readonly Ref[];
  readonly timestamp_ms: number;
  readonly severity: "low" | "medium" | "high";
  readonly summary: string;
}

export interface MemoryDecayPolicy {
  readonly fresh_window_ms?: number;
  readonly stale_window_ms?: number;
  readonly archive_window_ms?: number;
  readonly mobile_event_penalty?: number;
  readonly contradiction_penalty?: number;
}

export interface MemoryStalenessUpdate {
  readonly update_ref: Ref;
  readonly memory_record_ref: Ref;
  readonly previous_staleness_score: number;
  readonly next_staleness_score: number;
  readonly previous_lifecycle_state: MemoryLifecycleState;
  readonly next_lifecycle_state: MemoryLifecycleState;
  readonly freshness_score: number;
  readonly event_refs: readonly Ref[];
  readonly reason: string;
}

export interface StalenessUpdateReport {
  readonly schema_version: typeof MEMORY_DECAY_SCHEDULER_SCHEMA_VERSION;
  readonly blueprint_ref: typeof MEMORY_BLUEPRINT_REF;
  readonly report_ref: Ref;
  readonly time_now_ms: number;
  readonly updates: readonly MemoryStalenessUpdate[];
  readonly archive_refs: readonly Ref[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "staleness_update_report";
  readonly determinism_hash: string;
}

interface NormalizedDecayPolicy {
  readonly fresh_window_ms: number;
  readonly stale_window_ms: number;
  readonly archive_window_ms: number;
  readonly mobile_event_penalty: number;
  readonly contradiction_penalty: number;
}

const DEFAULT_POLICY: NormalizedDecayPolicy = Object.freeze({
  fresh_window_ms: 120000,
  stale_window_ms: 900000,
  archive_window_ms: 7200000,
  mobile_event_penalty: 0.22,
  contradiction_penalty: 0.5,
});

export class MemoryDecayScheduler {
  private readonly policy: NormalizedDecayPolicy;

  public constructor(policy: MemoryDecayPolicy = {}) {
    this.policy = normalizePolicy(DEFAULT_POLICY, policy);
  }

  /**
   * Updates memory staleness based on time and scene events.
   */
  public updateMemoryStaleness(
    memoryRecords: readonly MemoryRecordBase[],
    sceneEvents: readonly MemorySceneEvent[],
    timeNowMs: number,
    policy: MemoryDecayPolicy = {},
  ): StalenessUpdateReport {
    const activePolicy = normalizePolicy(this.policy, policy);
    const issues: ValidationIssue[] = [];
    validateInputs(memoryRecords, sceneEvents, timeNowMs, activePolicy, issues);
    const updates = memoryRecords.map((record) => updateFor(record, sceneEvents, timeNowMs, activePolicy));
    const archiveRefs = updates.filter((update) => update.next_lifecycle_state === "archived").map((update) => update.memory_record_ref);
    const base = {
      schema_version: MEMORY_DECAY_SCHEDULER_SCHEMA_VERSION,
      blueprint_ref: MEMORY_BLUEPRINT_REF,
      report_ref: makeMemoryRef("staleness_update_report", timeNowMs.toString(), updates.length.toString()),
      time_now_ms: timeNowMs,
      updates: freezeMemoryArray(updates.sort((a, b) => a.memory_record_ref.localeCompare(b.memory_record_ref))),
      archive_refs: freezeMemoryArray(archiveRefs.sort()),
      issues: freezeMemoryArray(issues),
      ok: !issues.some((issue) => issue.severity === "error"),
      cognitive_visibility: "staleness_update_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function updateMemoryStaleness(
  memoryRecords: readonly MemoryRecordBase[],
  sceneEvents: readonly MemorySceneEvent[],
  timeNowMs: number,
  policy: MemoryDecayPolicy = {},
): StalenessUpdateReport {
  return new MemoryDecayScheduler(policy).updateMemoryStaleness(memoryRecords, sceneEvents, timeNowMs, policy);
}

function updateFor(record: MemoryRecordBase, events: readonly MemorySceneEvent[], timeNowMs: number, policy: NormalizedDecayPolicy): MemoryStalenessUpdate {
  const age = Math.max(0, timeNowMs - record.created_at_ms);
  const relatedEvents = events.filter((event) => event.affected_memory_refs.includes(record.memory_record_ref) || event.affected_memory_refs.length === 0);
  const eventPenalty = relatedEvents.reduce((sum, event) => sum + penaltyFor(event, policy), 0);
  const timeStaleness = age >= policy.archive_window_ms ? 1 : age >= policy.stale_window_ms ? 0.72 : age >= policy.fresh_window_ms ? 0.38 : 0.08;
  const nextStaleness = roundMemoryScore(Math.max(record.staleness_score, Math.min(1, timeStaleness + eventPenalty)));
  const nextState = nextStateFor(record.lifecycle_state, nextStaleness, age, policy, relatedEvents);
  const freshness = scoreAgeFreshness(age, policy.stale_window_ms);
  return Object.freeze({
    update_ref: makeMemoryRef("memory_staleness_update", record.memory_record_ref, nextState),
    memory_record_ref: record.memory_record_ref,
    previous_staleness_score: record.staleness_score,
    next_staleness_score: nextStaleness,
    previous_lifecycle_state: record.lifecycle_state,
    next_lifecycle_state: nextState,
    freshness_score: freshness,
    event_refs: freezeMemoryArray(relatedEvents.map((event) => event.event_ref).sort()),
    reason: cleanMemoryText(`age_ms=${age}; event_count=${relatedEvents.length}; next_state=${nextState}; memory remains context only.`),
  });
}

function nextStateFor(
  current: MemoryLifecycleState,
  staleness: number,
  age: number,
  policy: NormalizedDecayPolicy,
  events: readonly MemorySceneEvent[],
): MemoryLifecycleState {
  if (current === "quarantined" || current === "archived") return current;
  if (events.some((event) => event.event_kind === "contradiction")) return "contradicted";
  if (age >= policy.archive_window_ms || staleness >= 0.94) return "archived";
  if (staleness >= 0.52) return "stale";
  return "fresh";
}

function penaltyFor(event: MemorySceneEvent, policy: NormalizedDecayPolicy): number {
  const severity = event.severity === "high" ? 1 : event.severity === "medium" ? 0.62 : 0.32;
  if (event.event_kind === "contradiction") return policy.contradiction_penalty * severity;
  if (event.event_kind === "object_motion" || event.event_kind === "agent_manipulation" || event.event_kind === "audio_motion_cue") return policy.mobile_event_penalty * severity;
  if (event.event_kind === "occlusion" || event.event_kind === "task_boundary") return 0.12 * severity;
  return 0.18 * severity;
}

function validateInputs(records: readonly MemoryRecordBase[], events: readonly MemorySceneEvent[], timeNowMs: number, policy: NormalizedDecayPolicy, issues: ValidationIssue[]): void {
  if (!Number.isFinite(timeNowMs) || timeNowMs < 0) {
    issues.push(makeMemoryIssue("error", "MemorySchemaInvalid", "$.time_now_ms", "Decay scheduler time must be finite and nonnegative.", "Use monotonic runtime timestamps."));
  }
  if (policy.fresh_window_ms <= 0 || policy.stale_window_ms <= policy.fresh_window_ms || policy.archive_window_ms <= policy.stale_window_ms) {
    issues.push(makeMemoryIssue("error", "MemoryPolicyInvalid", "$.decay_policy", "Decay windows must be positive and strictly increasing.", "Use fresh < stale < archive windows."));
  }
  if (records.length === 0) {
    issues.push(makeMemoryIssue("warning", "MemoryEvidenceMissing", "$.memory_records", "No memory records were supplied for decay.", "Provide active memory records from the store."));
  }
  for (const event of events) {
    if (!Number.isFinite(event.timestamp_ms) || event.timestamp_ms < 0) {
      issues.push(makeMemoryIssue("error", "MemorySchemaInvalid", `$.scene_events.${event.event_ref}.timestamp_ms`, "Scene event timestamp must be finite and nonnegative.", "Use monotonic event timestamps."));
    }
  }
}

function normalizePolicy(base: NormalizedDecayPolicy, override: MemoryDecayPolicy): NormalizedDecayPolicy {
  return Object.freeze({
    fresh_window_ms: positiveOrDefault(override.fresh_window_ms, base.fresh_window_ms),
    stale_window_ms: positiveOrDefault(override.stale_window_ms, base.stale_window_ms),
    archive_window_ms: positiveOrDefault(override.archive_window_ms, base.archive_window_ms),
    mobile_event_penalty: clamp01(override.mobile_event_penalty ?? base.mobile_event_penalty),
    contradiction_penalty: clamp01(override.contradiction_penalty ?? base.contradiction_penalty),
  });
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
