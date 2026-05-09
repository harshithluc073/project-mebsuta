/**
 * Semantic embedding index manager for Project Mebsuta episodic memory.
 *
 * Blueprint: `architecture_docs/15_RAG_EPISODIC_SPATIAL_MEMORY_ARCHITECTURE.md`
 * sections 15.4.1, 15.10, 15.12, 15.15, 15.17, 15.19.2, and 15.24.
 *
 * This deterministic semantic index uses normalized token vectors so tests and
 * replay produce stable retrieval without network embedding calls.
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
} from "./memory_write_gate";
import type { EpisodeMemoryRecord, OopsEpisodeMemoryRecord, TaskEpisodeMemoryRecord } from "./episode_record_builder";
import type { SpatialMemoryRecord } from "./spatial_record_builder";

export const SEMANTIC_EMBEDDING_INDEX_MANAGER_SCHEMA_VERSION = "mebsuta.semantic_embedding_index_manager.v1" as const;

export type SemanticRetrievalPurpose = "object_search" | "task_planning" | "oops_correction" | "tool_use" | "audio_reasoning" | "safety_review" | "audit";

export interface SemanticMemoryDocument {
  readonly document_ref: Ref;
  readonly memory_record_ref: Ref;
  readonly record_kind: "spatial" | "episode";
  readonly text: string;
  readonly tags: readonly string[];
  readonly confidence: number;
  readonly staleness_score: number;
}

export interface SemanticMemoryQuery {
  readonly query_ref?: Ref;
  readonly query_text: string;
  readonly purpose: SemanticRetrievalPurpose;
  readonly max_results?: number;
  readonly min_similarity?: number;
  readonly required_tags?: readonly string[];
}

export interface SemanticRetrievalHit {
  readonly hit_ref: Ref;
  readonly memory_record_ref: Ref;
  readonly similarity: number;
  readonly semantic_score: number;
  readonly matched_terms: readonly string[];
  readonly document: SemanticMemoryDocument;
}

export interface SemanticRetrievalResultSet {
  readonly schema_version: typeof SEMANTIC_EMBEDDING_INDEX_MANAGER_SCHEMA_VERSION;
  readonly blueprint_ref: typeof MEMORY_BLUEPRINT_REF;
  readonly query_ref: Ref;
  readonly hits: readonly SemanticRetrievalHit[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "semantic_retrieval_result_set";
  readonly determinism_hash: string;
}

export class SemanticEmbeddingIndexManager {
  private readonly documents: readonly SemanticMemoryDocument[];

  public constructor(records: readonly (SpatialMemoryRecord | EpisodeMemoryRecord)[] = []) {
    this.documents = freezeMemoryArray(records.map(semanticDocumentFrom).sort((a, b) => a.document_ref.localeCompare(b.document_ref)));
  }

  /**
   * Retrieves semantically similar memory documents using deterministic tokens.
   */
  public retrieveSemanticMemories(query: SemanticMemoryQuery): SemanticRetrievalResultSet {
    const issues: ValidationIssue[] = [];
    validateQuery(query, issues);
    const queryTokens = tokenize(query.query_text);
    const requiredTags = new Set((query.required_tags ?? []).map(normalizeToken));
    const maxResults = Math.max(1, Math.floor(query.max_results ?? 8));
    const minSimilarity = query.min_similarity ?? 0.08;
    const hits = this.documents
      .filter((document) => [...requiredTags].every((tag) => document.tags.map(normalizeToken).includes(tag)))
      .map((document) => semanticHit(document, queryTokens, query.purpose))
      .filter((hit) => hit.similarity >= minSimilarity)
      .sort(compareHits)
      .slice(0, maxResults);
    const queryRef = makeMemoryRef("semantic_memory_query", query.query_ref ?? query.purpose, query.query_text.slice(0, 32));
    const base = {
      schema_version: SEMANTIC_EMBEDDING_INDEX_MANAGER_SCHEMA_VERSION,
      blueprint_ref: MEMORY_BLUEPRINT_REF,
      query_ref: queryRef,
      hits: freezeMemoryArray(hits),
      issues: freezeMemoryArray(issues),
      ok: !issues.some((issue) => issue.severity === "error"),
      cognitive_visibility: "semantic_retrieval_result_set" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }

  /**
   * Returns the immutable semantic documents used by this manager.
   */
  public snapshotDocuments(): readonly SemanticMemoryDocument[] {
    return this.documents;
  }
}

export function retrieveSemanticMemories(records: readonly (SpatialMemoryRecord | EpisodeMemoryRecord)[], query: SemanticMemoryQuery): SemanticRetrievalResultSet {
  return new SemanticEmbeddingIndexManager(records).retrieveSemanticMemories(query);
}

function semanticDocumentFrom(record: SpatialMemoryRecord | EpisodeMemoryRecord): SemanticMemoryDocument {
  if (isSpatialMemoryRecord(record)) {
    return documentFromParts(
      record.memory_record_ref,
      "spatial",
      `${record.object_descriptor.label} ${record.object_descriptor.descriptor_summary} ${record.allowed_prompt_summary}`,
      [record.record_class, record.object_descriptor.label, record.confidence_class],
      confidenceFor(record.confidence_class),
      record.staleness_score,
    );
  }
  if (isTaskEpisodeMemoryRecord(record)) {
    return documentFromParts(
      record.memory_record_ref,
      "episode",
      `${record.task_goal_summary} ${record.final_outcome} ${record.lessons_for_retrieval.join(" ")}`,
      [record.record_class, record.final_outcome, record.confidence_class],
      confidenceFor(record.confidence_class),
      record.staleness_score,
    );
  }
  const oopsRecord = record as OopsEpisodeMemoryRecord;
  return documentFromParts(
    oopsRecord.memory_record_ref,
    "episode",
    `${oopsRecord.oops_episode_ref} ${oopsRecord.failure_mode_history.join(" ")} ${oopsRecord.successful_correction_summary ?? ""} ${oopsRecord.failed_correction_summary ?? ""}`,
    [oopsRecord.record_class, oopsRecord.retrieval_use, oopsRecord.confidence_class],
    confidenceFor(oopsRecord.confidence_class),
    oopsRecord.staleness_score,
  );
}

function documentFromParts(
  memoryRecordRef: Ref,
  recordKind: SemanticMemoryDocument["record_kind"],
  text: string,
  tags: readonly string[],
  confidence: number,
  stalenessScore: number,
): SemanticMemoryDocument {
  return Object.freeze({
    document_ref: makeMemoryRef("semantic_doc", memoryRecordRef),
    memory_record_ref: memoryRecordRef,
    record_kind: recordKind,
    text: cleanMemoryText(text),
    tags: freezeMemoryArray(tags.map(cleanMemoryText).sort()),
    confidence,
    staleness_score: roundMemoryScore(stalenessScore),
  });
}

function semanticHit(document: SemanticMemoryDocument, queryTokens: readonly string[], purpose: SemanticRetrievalPurpose): SemanticRetrievalHit {
  const documentTokens = tokenize(`${document.text} ${document.tags.join(" ")}`);
  const documentSet = new Set(documentTokens);
  const matched = [...new Set(queryTokens.filter((token) => documentSet.has(token)))].sort();
  const unionSize = new Set([...queryTokens, ...documentTokens]).size || 1;
  const similarity = roundMemoryScore(matched.length / unionSize);
  const purposeBoost = purposeMatches(document, purpose) ? 0.18 : 0;
  const semanticScore = roundMemoryScore(0.58 * similarity + 0.28 * document.confidence + purposeBoost - 0.14 * document.staleness_score);
  return Object.freeze({
    hit_ref: makeMemoryRef("semantic_hit", document.memory_record_ref, purpose),
    memory_record_ref: document.memory_record_ref,
    similarity,
    semantic_score: semanticScore,
    matched_terms: freezeMemoryArray(matched),
    document,
  });
}

function purposeMatches(document: SemanticMemoryDocument, purpose: SemanticRetrievalPurpose): boolean {
  if (purpose === "object_search") return document.record_kind === "spatial";
  if (purpose === "oops_correction") return document.tags.includes("oops_episode");
  if (purpose === "task_planning") return document.tags.includes("task_episode") || document.record_kind === "spatial";
  if (purpose === "safety_review") return document.text.includes("safe") || document.text.includes("risk");
  return true;
}

function validateQuery(query: SemanticMemoryQuery, issues: ValidationIssue[]): void {
  if (query.query_text.trim().length === 0) {
    issues.push(makeMemoryIssue("error", "MemorySchemaInvalid", "$.query_text", "Semantic memory query text cannot be empty.", "Provide object, task, failure, tool, or safety text."));
  }
  if (query.max_results !== undefined && (!Number.isFinite(query.max_results) || query.max_results <= 0)) {
    issues.push(makeMemoryIssue("error", "MemoryPolicyInvalid", "$.max_results", "Semantic max_results must be positive.", "Use a positive retrieval count."));
  }
}

function tokenize(value: string): readonly string[] {
  return freezeMemoryArray(cleanMemoryText(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .map(normalizeToken)
    .filter((token) => token.length >= 2)
    .sort());
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function confidenceFor(value: string): number {
  if (value === "verified") return 1;
  if (value === "high_observed") return 0.78;
  if (value === "medium_observed") return 0.58;
  if (value === "low_hypothesis") return 0.34;
  return 0.18;
}

function compareHits(a: SemanticRetrievalHit, b: SemanticRetrievalHit): number {
  return b.semantic_score - a.semantic_score || b.similarity - a.similarity || a.memory_record_ref.localeCompare(b.memory_record_ref);
}

function isSpatialMemoryRecord(record: SpatialMemoryRecord | EpisodeMemoryRecord): record is SpatialMemoryRecord {
  return "object_descriptor" in record;
}

function isTaskEpisodeMemoryRecord(record: SpatialMemoryRecord | EpisodeMemoryRecord): record is TaskEpisodeMemoryRecord {
  return "task_goal_summary" in record;
}
