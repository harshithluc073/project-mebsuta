/**
 * Episode record builder for Project Mebsuta episodic spatial memory.
 *
 * Blueprint: `architecture_docs/15_RAG_EPISODIC_SPATIAL_MEMORY_ARCHITECTURE.md`
 * sections 15.4.1, 15.5.1, 15.6.5, 15.6.6, 15.11, 15.15, 15.19.1, and 15.20.4.
 *
 * The builder stores task and correction history as retrieval context while
 * preserving the no-RL boundary: records explain what happened; they do not
 * update a learned reward policy.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  MEMORY_BLUEPRINT_REF,
  baseMemoryRecord,
  cleanMemoryRef,
  cleanMemoryText,
  freezeMemoryArray,
  makeMemoryIssue,
  makeMemoryRef,
  type MemoryEvidenceManifest,
  type MemoryRecordBase,
  type MemoryWriteDecision,
} from "./memory_write_gate";

export const EPISODE_RECORD_BUILDER_SCHEMA_VERSION = "mebsuta.episode_record_builder.v1" as const;

export type TaskEpisodeOutcome = "success" | "failure" | "abandoned" | "human_review" | "safe_hold";
export type OopsRetrievalUse = "avoid_repeated_failure" | "suggest_inspection" | "caution_only";

export interface TaskEpisodeMemoryRecord extends MemoryRecordBase {
  readonly record_class: "task_episode";
  readonly episode_memory_ref: Ref;
  readonly task_ref: Ref;
  readonly task_goal_summary: string;
  readonly plan_summary_refs: readonly Ref[];
  readonly execution_event_refs: readonly Ref[];
  readonly verification_certificate_refs: readonly Ref[];
  readonly objects_involved_refs: readonly Ref[];
  readonly final_outcome: TaskEpisodeOutcome;
  readonly lessons_for_retrieval: readonly string[];
}

export interface OopsEpisodeMemoryRecord extends MemoryRecordBase {
  readonly record_class: "oops_episode";
  readonly oops_memory_ref: Ref;
  readonly oops_episode_ref: Ref;
  readonly failure_mode_history: readonly string[];
  readonly correction_attempt_refs: readonly Ref[];
  readonly successful_correction_summary?: string;
  readonly failed_correction_summary?: string;
  readonly safety_escalation_refs: readonly Ref[];
  readonly retrieval_use: OopsRetrievalUse;
}

export type EpisodeMemoryRecord = TaskEpisodeMemoryRecord | OopsEpisodeMemoryRecord;

export interface TaskEpisodeRecordInput {
  readonly decision: MemoryWriteDecision;
  readonly evidence_manifest: MemoryEvidenceManifest;
  readonly task_ref: Ref;
  readonly task_goal_summary: string;
  readonly plan_summary_refs?: readonly Ref[];
  readonly execution_event_refs: readonly Ref[];
  readonly verification_certificate_refs: readonly Ref[];
  readonly objects_involved_refs?: readonly Ref[];
  readonly final_outcome: TaskEpisodeOutcome;
  readonly lessons_for_retrieval?: readonly string[];
}

export interface OopsEpisodeRecordInput {
  readonly decision: MemoryWriteDecision;
  readonly evidence_manifest: MemoryEvidenceManifest;
  readonly oops_episode_ref: Ref;
  readonly failure_mode_history: readonly string[];
  readonly correction_attempt_refs: readonly Ref[];
  readonly successful_correction_summary?: string;
  readonly failed_correction_summary?: string;
  readonly safety_escalation_refs?: readonly Ref[];
  readonly retrieval_use: OopsRetrievalUse;
}

export interface EpisodeRecordBuilderReport {
  readonly schema_version: typeof EPISODE_RECORD_BUILDER_SCHEMA_VERSION;
  readonly blueprint_ref: typeof MEMORY_BLUEPRINT_REF;
  readonly report_ref: Ref;
  readonly records: readonly EpisodeMemoryRecord[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "episode_record_builder_report";
  readonly determinism_hash: string;
}

export class EpisodeRecordBuilder {
  /**
   * Builds an auditable task episode memory record.
   */
  public buildTaskEpisodeRecord(input: TaskEpisodeRecordInput): TaskEpisodeMemoryRecord {
    const issues: ValidationIssue[] = [];
    validateEpisodeDecision(input.decision, issues);
    if (input.execution_event_refs.length === 0) {
      issues.push(makeMemoryIssue("warning", "MemoryEvidenceMissing", "$.execution_event_refs", "Task episode has no execution event refs.", "Attach primitive or controller event refs where available."));
    }
    const episodeRef = makeMemoryRef("task_episode_memory", input.task_ref, input.final_outcome);
    const base = baseMemoryRecord(
      "task_episode",
      episodeRef,
      input.evidence_manifest,
      issues.some((issue) => issue.severity === "error") ? "quarantined" : "verified",
      issues.some((issue) => issue.severity === "error") ? "quarantined" : "active",
      input.final_outcome === "success" ? 0.08 : 0.18,
      `${input.task_goal_summary}; outcome=${input.final_outcome}; memory is context for future reasoning only.`,
      [input.decision.decision_ref, ...input.decision.accepted_evidence_refs],
    );
    const recordBase = {
      ...base,
      record_class: "task_episode" as const,
      episode_memory_ref: episodeRef,
      task_ref: cleanMemoryRef(input.task_ref),
      task_goal_summary: cleanMemoryText(input.task_goal_summary),
      plan_summary_refs: refs(input.plan_summary_refs ?? []),
      execution_event_refs: refs(input.execution_event_refs),
      verification_certificate_refs: refs(input.verification_certificate_refs),
      objects_involved_refs: refs(input.objects_involved_refs ?? []),
      final_outcome: input.final_outcome,
      lessons_for_retrieval: freezeMemoryArray((input.lessons_for_retrieval ?? []).map(cleanMemoryText).sort()),
    };
    return Object.freeze({ ...recordBase, determinism_hash: computeDeterminismHash(recordBase) });
  }

  /**
   * Builds an Oops correction episode memory record.
   */
  public buildOopsEpisodeRecord(input: OopsEpisodeRecordInput): OopsEpisodeMemoryRecord {
    const issues: ValidationIssue[] = [];
    validateEpisodeDecision(input.decision, issues);
    if (input.failure_mode_history.length === 0) {
      issues.push(makeMemoryIssue("warning", "MemoryEvidenceMissing", "$.failure_mode_history", "Oops memory should include at least one failure mode.", "Attach the File 14 failure classifier output."));
    }
    const oopsMemoryRef = makeMemoryRef("oops_episode_memory", input.oops_episode_ref, input.retrieval_use);
    const base = baseMemoryRecord(
      "oops_episode",
      oopsMemoryRef,
      input.evidence_manifest,
      issues.some((issue) => issue.severity === "error") ? "quarantined" : "verified",
      issues.some((issue) => issue.severity === "error") ? "quarantined" : "active",
      input.retrieval_use === "caution_only" ? 0.12 : 0.08,
      oopsSummary(input),
      [input.decision.decision_ref, ...input.decision.accepted_evidence_refs],
    );
    const recordBase = {
      ...base,
      record_class: "oops_episode" as const,
      oops_memory_ref: oopsMemoryRef,
      oops_episode_ref: cleanMemoryRef(input.oops_episode_ref),
      failure_mode_history: freezeMemoryArray(input.failure_mode_history.map(cleanMemoryText).sort()),
      correction_attempt_refs: refs(input.correction_attempt_refs),
      successful_correction_summary: input.successful_correction_summary === undefined ? undefined : cleanMemoryText(input.successful_correction_summary),
      failed_correction_summary: input.failed_correction_summary === undefined ? undefined : cleanMemoryText(input.failed_correction_summary),
      safety_escalation_refs: refs(input.safety_escalation_refs ?? []),
      retrieval_use: input.retrieval_use,
    };
    return Object.freeze({ ...recordBase, determinism_hash: computeDeterminismHash(recordBase) });
  }

  /**
   * Packages episode records for QA and audit replay.
   */
  public report(records: readonly EpisodeMemoryRecord[], issues: readonly ValidationIssue[] = []): EpisodeRecordBuilderReport {
    const base = {
      schema_version: EPISODE_RECORD_BUILDER_SCHEMA_VERSION,
      blueprint_ref: MEMORY_BLUEPRINT_REF,
      report_ref: makeMemoryRef("episode_record_builder_report", records.map((record) => record.memory_record_ref).join(":") || "empty"),
      records: freezeMemoryArray([...records].sort((a, b) => a.memory_record_ref.localeCompare(b.memory_record_ref))),
      issues: freezeMemoryArray(issues),
      ok: records.length > 0 && !issues.some((issue) => issue.severity === "error"),
      cognitive_visibility: "episode_record_builder_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function buildTaskEpisodeRecord(input: TaskEpisodeRecordInput): TaskEpisodeMemoryRecord {
  return new EpisodeRecordBuilder().buildTaskEpisodeRecord(input);
}

export function buildOopsEpisodeRecord(input: OopsEpisodeRecordInput): OopsEpisodeMemoryRecord {
  return new EpisodeRecordBuilder().buildOopsEpisodeRecord(input);
}

function validateEpisodeDecision(decision: MemoryWriteDecision, issues: ValidationIssue[]): void {
  if (!decision.accepted || decision.action !== "write_episode") {
    issues.push(makeMemoryIssue("error", "MemorySchemaInvalid", "$.decision", "Episode record requires an accepted episode write decision.", "Evaluate episode memory through MemoryWriteGate before building a record."));
  }
}

function oopsSummary(input: OopsEpisodeRecordInput): string {
  const modes = input.failure_mode_history.length === 0 ? "no classified failure modes" : input.failure_mode_history.join(",");
  const outcome = input.successful_correction_summary ?? input.failed_correction_summary ?? "terminal outcome captured by File 14 refs";
  return cleanMemoryText(`Oops episode ${input.oops_episode_ref}; modes=${modes}; use=${input.retrieval_use}; ${outcome}; validators remain mandatory.`);
}

function refs(values: readonly Ref[]): readonly Ref[] {
  return freezeMemoryArray([...new Set(values.map(cleanMemoryRef))].sort());
}
