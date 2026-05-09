/**
 * Freshness confidence ranker for Project Mebsuta episodic memory.
 *
 * Blueprint: `architecture_docs/15_RAG_EPISODIC_SPATIAL_MEMORY_ARCHITECTURE.md`
 * sections 15.4.1, 15.5.3, 15.10, 15.12, 15.13, 15.19.2, and 15.20.2.
 *
 * The ranker converts retrieval candidates into labeled memory context where
 * age, uncertainty, confidence, and contradictions are explicit.
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
import type { HybridRetrievalCandidate, RetrievalResultBundle } from "./hybrid_retrieval_planner";

export const FRESHNESS_CONFIDENCE_RANKER_SCHEMA_VERSION = "mebsuta.freshness_confidence_ranker.v1" as const;

export type RankedMemoryAuthorityLabel = "verified_prior" | "observed_prior" | "search_hint" | "stale_hint" | "contradiction_warning" | "episode_context";

export interface FreshnessConfidencePolicy {
  readonly max_results?: number;
  readonly stale_after_score?: number;
  readonly contradiction_penalty?: number;
  readonly verified_bonus?: number;
  readonly min_rank_score?: number;
}

export interface RankedMemoryCandidate {
  readonly ranked_ref: Ref;
  readonly memory_record_ref: Ref;
  readonly rank: number;
  readonly rank_score: number;
  readonly authority_label: RankedMemoryAuthorityLabel;
  readonly freshness_score: number;
  readonly confidence_score: number;
  readonly contradiction: boolean;
  readonly retrieval_summary: string;
  readonly source_candidate: HybridRetrievalCandidate;
}

export interface FreshnessConfidenceRankReport {
  readonly schema_version: typeof FRESHNESS_CONFIDENCE_RANKER_SCHEMA_VERSION;
  readonly blueprint_ref: typeof MEMORY_BLUEPRINT_REF;
  readonly report_ref: Ref;
  readonly source_bundle_ref: Ref;
  readonly ranked_candidates: readonly RankedMemoryCandidate[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "freshness_confidence_rank_report";
  readonly determinism_hash: string;
}

interface NormalizedFreshnessPolicy {
  readonly max_results: number;
  readonly stale_after_score: number;
  readonly contradiction_penalty: number;
  readonly verified_bonus: number;
  readonly min_rank_score: number;
}

const DEFAULT_POLICY: NormalizedFreshnessPolicy = Object.freeze({
  max_results: 8,
  stale_after_score: 0.45,
  contradiction_penalty: 0.34,
  verified_bonus: 0.16,
  min_rank_score: 0.04,
});

export class FreshnessConfidenceRanker {
  private readonly policy: NormalizedFreshnessPolicy;

  public constructor(policy: FreshnessConfidencePolicy = {}) {
    this.policy = normalizePolicy(DEFAULT_POLICY, policy);
  }

  /**
   * Scores memory candidates for prompt and planning use.
   */
  public rankRetrievalResults(bundle: RetrievalResultBundle, policy: FreshnessConfidencePolicy = {}): FreshnessConfidenceRankReport {
    const activePolicy = normalizePolicy(this.policy, policy);
    const issues: ValidationIssue[] = [];
    validatePolicy(activePolicy, issues);
    const ranked = bundle.candidates
      .map((candidate) => scoreCandidate(candidate, activePolicy))
      .filter((candidate) => candidate.rank_score >= activePolicy.min_rank_score)
      .sort(compareRanked)
      .slice(0, activePolicy.max_results)
      .map((candidate, index) => Object.freeze({ ...candidate, rank: index + 1 }));
    const base = {
      schema_version: FRESHNESS_CONFIDENCE_RANKER_SCHEMA_VERSION,
      blueprint_ref: MEMORY_BLUEPRINT_REF,
      report_ref: makeMemoryRef("freshness_confidence_rank_report", bundle.bundle_ref),
      source_bundle_ref: bundle.bundle_ref,
      ranked_candidates: freezeMemoryArray(ranked),
      issues: freezeMemoryArray(issues),
      ok: ranked.length > 0 && !issues.some((issue) => issue.severity === "error"),
      cognitive_visibility: "freshness_confidence_rank_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function rankRetrievalResults(bundle: RetrievalResultBundle, policy: FreshnessConfidencePolicy = {}): FreshnessConfidenceRankReport {
  return new FreshnessConfidenceRanker(policy).rankRetrievalResults(bundle, policy);
}

function scoreCandidate(candidate: HybridRetrievalCandidate, policy: NormalizedFreshnessPolicy): RankedMemoryCandidate {
  const freshness = roundMemoryScore(1 - candidate.staleness_score);
  const confidence = candidate.record?.confidence_class === "verified" ? 1 : candidate.evidence_score;
  const authority = authorityFor(candidate, freshness, policy);
  const authorityBonus = authority === "verified_prior" ? policy.verified_bonus : authority === "episode_context" ? 0.08 : 0;
  const contradictionPenalty = candidate.contradiction ? policy.contradiction_penalty : 0;
  const rankScore = roundMemoryScore(0.42 * candidate.hybrid_score + 0.27 * freshness + 0.25 * confidence + authorityBonus - contradictionPenalty);
  return Object.freeze({
    ranked_ref: makeMemoryRef("ranked_memory", candidate.memory_record_ref, authority),
    memory_record_ref: candidate.memory_record_ref,
    rank: 0,
    rank_score: rankScore,
    authority_label: authority,
    freshness_score: freshness,
    confidence_score: roundMemoryScore(confidence),
    contradiction: candidate.contradiction,
    retrieval_summary: `${candidate.prompt_safe_summary} Ranked as ${authority}; memory cannot prove current task success.`,
    source_candidate: candidate,
  });
}

function authorityFor(candidate: HybridRetrievalCandidate, freshness: number, policy: NormalizedFreshnessPolicy): RankedMemoryAuthorityLabel {
  if (candidate.contradiction) return "contradiction_warning";
  if (candidate.use_label === "episode_context" || candidate.use_label === "caution_context") return "episode_context";
  if (freshness < 1 - policy.stale_after_score || candidate.use_label === "stale_search_hint") return "stale_hint";
  if (candidate.record?.confidence_class === "verified") return "verified_prior";
  if (candidate.record?.record_class === "search_hint") return "search_hint";
  return "observed_prior";
}

function validatePolicy(policy: NormalizedFreshnessPolicy, issues: ValidationIssue[]): void {
  if (policy.max_results <= 0 || policy.stale_after_score < 0 || policy.stale_after_score > 1 || policy.min_rank_score < 0 || policy.min_rank_score > 1) {
    issues.push(makeMemoryIssue("error", "MemoryPolicyInvalid", "$.freshness_policy", "Ranking policy values must be finite and within expected bounds.", "Use positive result counts and score thresholds in [0, 1]."));
  }
}

function normalizePolicy(base: NormalizedFreshnessPolicy, override: FreshnessConfidencePolicy): NormalizedFreshnessPolicy {
  return Object.freeze({
    max_results: Math.max(1, Math.floor(valueOr(override.max_results, base.max_results))),
    stale_after_score: clamp01(valueOr(override.stale_after_score, base.stale_after_score)),
    contradiction_penalty: clamp01(valueOr(override.contradiction_penalty, base.contradiction_penalty)),
    verified_bonus: clamp01(valueOr(override.verified_bonus, base.verified_bonus)),
    min_rank_score: clamp01(valueOr(override.min_rank_score, base.min_rank_score)),
  });
}

function compareRanked(a: RankedMemoryCandidate, b: RankedMemoryCandidate): number {
  return b.rank_score - a.rank_score || b.freshness_score - a.freshness_score || a.memory_record_ref.localeCompare(b.memory_record_ref);
}

function valueOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
