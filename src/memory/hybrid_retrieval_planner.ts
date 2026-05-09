/**
 * Hybrid retrieval planner for Project Mebsuta episodic spatial memory.
 *
 * Blueprint: `architecture_docs/15_RAG_EPISODIC_SPATIAL_MEMORY_ARCHITECTURE.md`
 * sections 15.4.1, 15.10, 15.12, 15.13, 15.19.2, 15.20.2, and 15.20.4.
 *
 * The planner fuses spatial and semantic results into task-scoped memory
 * candidates while preserving labels that keep memory separate from current
 * perception.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  MEMORY_BLUEPRINT_REF,
  freezeMemoryArray,
  makeMemoryIssue,
  makeMemoryRef,
  roundMemoryScore,
} from "./memory_write_gate";
import type { SemanticRetrievalResultSet } from "./semantic_embedding_index_manager";
import type { SpatialRetrievalResultSet } from "./spatial_index_manager";
import type { SpatialMemoryRecord } from "./spatial_record_builder";

export const HYBRID_RETRIEVAL_PLANNER_SCHEMA_VERSION = "mebsuta.hybrid_retrieval_planner.v1" as const;

export type MemoryRetrievalIntent = "find_object" | "continue_task" | "diagnose_failure" | "choose_tool_context" | "review_safety" | "audit_history";
export type MemoryUseLabel = "current_search_prior" | "stale_search_hint" | "contradiction_warning" | "episode_context" | "caution_context";

export interface HybridMemoryRetrievalRequest {
  readonly request_ref?: Ref;
  readonly intent: MemoryRetrievalIntent;
  readonly task_ref?: Ref;
  readonly spatial_results?: SpatialRetrievalResultSet;
  readonly semantic_results?: SemanticRetrievalResultSet;
  readonly max_results?: number;
  readonly require_fresh_perception?: boolean;
}

export interface HybridRetrievalCandidate {
  readonly candidate_ref: Ref;
  readonly memory_record_ref: Ref;
  readonly source_channels: readonly ("spatial" | "semantic")[];
  readonly use_label: MemoryUseLabel;
  readonly hybrid_score: number;
  readonly evidence_score: number;
  readonly staleness_score: number;
  readonly contradiction: boolean;
  readonly record?: SpatialMemoryRecord;
  readonly prompt_safe_summary: string;
}

export interface RetrievalResultBundle {
  readonly schema_version: typeof HYBRID_RETRIEVAL_PLANNER_SCHEMA_VERSION;
  readonly blueprint_ref: typeof MEMORY_BLUEPRINT_REF;
  readonly bundle_ref: Ref;
  readonly request_ref: Ref;
  readonly intent: MemoryRetrievalIntent;
  readonly candidates: readonly HybridRetrievalCandidate[];
  readonly require_fresh_perception: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "retrieval_result_bundle";
  readonly determinism_hash: string;
}

export class HybridRetrievalPlanner {
  /**
   * Combines spatial, semantic, task, and staleness signals.
   */
  public retrieveMemoryForTask(request: HybridMemoryRetrievalRequest): RetrievalResultBundle {
    const issues: ValidationIssue[] = [];
    validateRequest(request, issues);
    const maxResults = Math.max(1, Math.floor(request.max_results ?? 8));
    const spatialHits = request.spatial_results?.hits ?? [];
    const semanticHits = request.semantic_results?.hits ?? [];
    const refs = new Set<Ref>([...spatialHits.map((hit) => hit.memory_record_ref), ...semanticHits.map((hit) => hit.memory_record_ref)]);
    const candidates = [...refs].map((ref) => candidateFor(ref, request)).sort(compareCandidates).slice(0, maxResults);
    const requestRef = makeMemoryRef("hybrid_retrieval_request", request.request_ref ?? request.intent, request.task_ref ?? "no_task");
    const base = {
      schema_version: HYBRID_RETRIEVAL_PLANNER_SCHEMA_VERSION,
      blueprint_ref: MEMORY_BLUEPRINT_REF,
      bundle_ref: makeMemoryRef("retrieval_result_bundle", requestRef, candidates.map((candidate) => candidate.memory_record_ref).join(":")),
      request_ref: requestRef,
      intent: request.intent,
      candidates: freezeMemoryArray(candidates),
      require_fresh_perception: request.require_fresh_perception ?? true,
      issues: freezeMemoryArray(issues),
      ok: candidates.length > 0 && !issues.some((issue) => issue.severity === "error"),
      cognitive_visibility: "retrieval_result_bundle" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function retrieveMemoryForTask(request: HybridMemoryRetrievalRequest): RetrievalResultBundle {
  return new HybridRetrievalPlanner().retrieveMemoryForTask(request);
}

function candidateFor(memoryRecordRef: Ref, request: HybridMemoryRetrievalRequest): HybridRetrievalCandidate {
  const spatialHit = request.spatial_results?.hits.find((hit) => hit.memory_record_ref === memoryRecordRef);
  const semanticHit = request.semantic_results?.hits.find((hit) => hit.memory_record_ref === memoryRecordRef);
  const channelDrafts: readonly ("spatial" | "semantic" | undefined)[] = [
    spatialHit === undefined ? undefined : "spatial",
    semanticHit === undefined ? undefined : "semantic",
  ];
  const channels = freezeMemoryArray(channelDrafts.filter(isChannel));
  const staleness = spatialHit?.record.staleness_score ?? semanticHit?.document.staleness_score ?? 0.5;
  const contradiction = spatialHit?.record.lifecycle_state === "contradicted" || semanticHit?.document.tags.includes("contradicted") === true;
  const evidenceScore = roundMemoryScore(Math.max(spatialHit?.spatial_score ?? 0, semanticHit?.semantic_score ?? 0));
  const intentBoost = intentBoostFor(request.intent, spatialHit, semanticHit);
  const hybridScore = roundMemoryScore(0.62 * evidenceScore + 0.22 * intentBoost + 0.16 * channels.length / 2 - 0.18 * staleness - (contradiction ? 0.22 : 0));
  const useLabel = useLabelFor(request.intent, staleness, contradiction, spatialHit?.record.record_class ?? semanticHit?.document.record_kind);
  return Object.freeze({
    candidate_ref: makeMemoryRef("hybrid_candidate", memoryRecordRef, channels.join("_") || "none"),
    memory_record_ref: memoryRecordRef,
    source_channels: channels,
    use_label: useLabel,
    hybrid_score: hybridScore,
    evidence_score: evidenceScore,
    staleness_score: roundMemoryScore(staleness),
    contradiction,
    record: spatialHit?.record,
    prompt_safe_summary: summaryFor(memoryRecordRef, useLabel, spatialHit, semanticHit),
  });
}

function intentBoostFor(intent: MemoryRetrievalIntent, spatialHit: SpatialRetrievalResultSet["hits"][number] | undefined, semanticHit: SemanticRetrievalResultSet["hits"][number] | undefined): number {
  if (intent === "find_object") return spatialHit === undefined ? 0.35 : 0.9;
  if (intent === "diagnose_failure") return semanticHit?.document.tags.includes("oops_episode") === true ? 0.92 : 0.45;
  if (intent === "continue_task") return semanticHit?.document.tags.includes("task_episode") === true ? 0.86 : 0.5;
  if (intent === "review_safety") return semanticHit?.document.text.includes("safe") === true || semanticHit?.document.text.includes("risk") === true ? 0.88 : 0.42;
  return 0.56;
}

function useLabelFor(intent: MemoryRetrievalIntent, staleness: number, contradiction: boolean, kind: string | undefined): MemoryUseLabel {
  if (contradiction) return "contradiction_warning";
  if (intent === "review_safety") return "caution_context";
  if (kind === "episode" || kind === "task_episode" || kind === "oops_episode") return "episode_context";
  if (staleness >= 0.45) return "stale_search_hint";
  return "current_search_prior";
}

function summaryFor(
  ref: Ref,
  label: MemoryUseLabel,
  spatialHit: SpatialRetrievalResultSet["hits"][number] | undefined,
  semanticHit: SemanticRetrievalResultSet["hits"][number] | undefined,
): string {
  const spatial = spatialHit === undefined ? "" : `spatial_score=${spatialHit.spatial_score}`;
  const semantic = semanticHit === undefined ? "" : `semantic_score=${semanticHit.semantic_score}`;
  return `Memory ${ref} retrieved as ${label}; ${[spatial, semantic].filter((item) => item.length > 0).join("; ")}; verify with current perception before execution.`;
}

function validateRequest(request: HybridMemoryRetrievalRequest, issues: ValidationIssue[]): void {
  if ((request.spatial_results?.hits.length ?? 0) === 0 && (request.semantic_results?.hits.length ?? 0) === 0) {
    issues.push(makeMemoryIssue("warning", "MemoryEvidenceMissing", "$.retrieval_results", "Hybrid retrieval has no spatial or semantic candidates.", "Run spatial or semantic retrieval before hybrid planning."));
  }
  if (request.max_results !== undefined && (!Number.isFinite(request.max_results) || request.max_results <= 0)) {
    issues.push(makeMemoryIssue("error", "MemoryPolicyInvalid", "$.max_results", "Hybrid max_results must be positive.", "Use a positive candidate limit."));
  }
}

function compareCandidates(a: HybridRetrievalCandidate, b: HybridRetrievalCandidate): number {
  return b.hybrid_score - a.hybrid_score || b.evidence_score - a.evidence_score || a.memory_record_ref.localeCompare(b.memory_record_ref);
}

function isChannel(value: "spatial" | "semantic" | undefined): value is "spatial" | "semantic" {
  return value !== undefined;
}
