/**
 * Prompt memory formatter for Project Mebsuta episodic memory.
 *
 * Blueprint: `architecture_docs/15_RAG_EPISODIC_SPATIAL_MEMORY_ARCHITECTURE.md`
 * sections 15.2.3, 15.4.1, 15.12, 15.13, 15.19.2, 15.20.2, and 15.24.
 *
 * The formatter emits Gemini-safe memory context that labels memory as prior
 * context and strips any hidden-source language before prompt assembly.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  HIDDEN_MEMORY_PATTERN,
  MEMORY_BLUEPRINT_REF,
  cleanMemoryText,
  freezeMemoryArray,
  makeMemoryIssue,
  makeMemoryRef,
} from "./memory_write_gate";
import type { FreshnessConfidenceRankReport, RankedMemoryCandidate } from "./freshness_confidence_ranker";

export const PROMPT_MEMORY_FORMATTER_SCHEMA_VERSION = "mebsuta.prompt_memory_formatter.v1" as const;

export interface PromptMemoryFormatterPolicy {
  readonly max_items?: number;
  readonly max_characters?: number;
  readonly include_audit_refs?: boolean;
  readonly require_memory_label?: boolean;
}

export interface PromptSafeMemoryItem {
  readonly item_ref: Ref;
  readonly memory_record_ref: Ref;
  readonly authority_label: RankedMemoryCandidate["authority_label"];
  readonly text: string;
  readonly allowed_use: "inspect_before_action" | "search_hint" | "caution" | "episode_context";
  readonly rank_score: number;
}

export interface PromptSafeMemoryContext {
  readonly schema_version: typeof PROMPT_MEMORY_FORMATTER_SCHEMA_VERSION;
  readonly blueprint_ref: typeof MEMORY_BLUEPRINT_REF;
  readonly context_ref: Ref;
  readonly source_rank_report_ref: Ref;
  readonly items: readonly PromptSafeMemoryItem[];
  readonly warnings: readonly string[];
  readonly context_text: string;
  readonly estimated_characters: number;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "prompt_safe_memory_context";
  readonly determinism_hash: string;
}

interface NormalizedPromptMemoryPolicy {
  readonly max_items: number;
  readonly max_characters: number;
  readonly include_audit_refs: boolean;
  readonly require_memory_label: boolean;
}

const DEFAULT_POLICY: NormalizedPromptMemoryPolicy = Object.freeze({
  max_items: 6,
  max_characters: 2400,
  include_audit_refs: true,
  require_memory_label: true,
});

export class PromptMemoryFormatter {
  private readonly policy: NormalizedPromptMemoryPolicy;

  public constructor(policy: PromptMemoryFormatterPolicy = {}) {
    this.policy = normalizePolicy(DEFAULT_POLICY, policy);
  }

  /**
   * Builds a prompt-safe memory context bundle from ranked retrieval output.
   */
  public assemblePromptSafeMemoryContext(rankReport: FreshnessConfidenceRankReport, policy: PromptMemoryFormatterPolicy = {}): PromptSafeMemoryContext {
    const activePolicy = normalizePolicy(this.policy, policy);
    const issues: ValidationIssue[] = [];
    validatePolicy(activePolicy, issues);
    const candidates = rankReport.ranked_candidates.slice(0, activePolicy.max_items);
    const items = boundedItems(candidates, activePolicy, issues);
    const warnings = buildWarnings(items);
    const contextText = formatContextText(items, warnings, activePolicy);
    const base = {
      schema_version: PROMPT_MEMORY_FORMATTER_SCHEMA_VERSION,
      blueprint_ref: MEMORY_BLUEPRINT_REF,
      context_ref: makeMemoryRef("prompt_safe_memory_context", rankReport.report_ref),
      source_rank_report_ref: rankReport.report_ref,
      items: freezeMemoryArray(items),
      warnings: freezeMemoryArray(warnings),
      context_text: contextText,
      estimated_characters: contextText.length,
      issues: freezeMemoryArray(issues),
      ok: items.length > 0 && !issues.some((issue) => issue.severity === "error"),
      cognitive_visibility: "prompt_safe_memory_context" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function assemblePromptSafeMemoryContext(rankReport: FreshnessConfidenceRankReport, policy: PromptMemoryFormatterPolicy = {}): PromptSafeMemoryContext {
  return new PromptMemoryFormatter(policy).assemblePromptSafeMemoryContext(rankReport, policy);
}

function boundedItems(candidates: readonly RankedMemoryCandidate[], policy: NormalizedPromptMemoryPolicy, issues: ValidationIssue[]): readonly PromptSafeMemoryItem[] {
  const items: PromptSafeMemoryItem[] = [];
  let used = 0;
  for (const candidate of candidates) {
    const item = itemFor(candidate);
    const next = used + item.text.length;
    if (next > policy.max_characters) {
      issues.push(makeMemoryIssue("warning", "MemoryPolicyInvalid", "$.max_characters", "Prompt memory context reached the configured character budget.", "Increase budget or reduce retrieval count."));
      break;
    }
    used = next;
    items.push(item);
  }
  return freezeMemoryArray(items);
}

function itemFor(candidate: RankedMemoryCandidate): PromptSafeMemoryItem {
  const prefix = labelPrefix(candidate.authority_label);
  const text = cleanMemoryText(`${prefix} ${candidate.retrieval_summary}`);
  return Object.freeze({
    item_ref: makeMemoryRef("prompt_memory_item", candidate.memory_record_ref, candidate.rank.toString()),
    memory_record_ref: candidate.memory_record_ref,
    authority_label: candidate.authority_label,
    text,
    allowed_use: allowedUse(candidate),
    rank_score: candidate.rank_score,
  });
}

function formatContextText(items: readonly PromptSafeMemoryItem[], warnings: readonly string[], policy: NormalizedPromptMemoryPolicy): string {
  const header = policy.require_memory_label
    ? "MEMORY CONTEXT: prior embodied memory only. It is not current perception and cannot authorize success or execution."
    : "MEMORY CONTEXT:";
  const body = items.map((item, index) => `${index + 1}. [${item.authority_label}] ${item.text}`).join("\n");
  const warningText = warnings.length === 0 ? "" : `\nWARNINGS:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`;
  const auditText = policy.include_audit_refs ? `\nAUDIT_REFS: ${items.map((item) => item.memory_record_ref).join(",")}` : "";
  return cleanMemoryText(`${header}\n${body}${warningText}${auditText}`);
}

function buildWarnings(items: readonly PromptSafeMemoryItem[]): readonly string[] {
  return freezeMemoryArray([
    "Use fresh perception for physical action and verification.",
    items.some((item) => item.authority_label === "stale_hint") ? "At least one memory item is stale and may guide search only." : undefined,
    items.some((item) => item.authority_label === "contradiction_warning") ? "Contradicted records must not be treated as current state." : undefined,
  ].filter(isString).map(cleanMemoryText));
}

function allowedUse(candidate: RankedMemoryCandidate): PromptSafeMemoryItem["allowed_use"] {
  if (candidate.authority_label === "contradiction_warning") return "caution";
  if (candidate.authority_label === "episode_context") return "episode_context";
  if (candidate.authority_label === "search_hint" || candidate.authority_label === "stale_hint") return "search_hint";
  return "inspect_before_action";
}

function labelPrefix(label: RankedMemoryCandidate["authority_label"]): string {
  if (label === "verified_prior") return "Last verified prior:";
  if (label === "observed_prior") return "Observed prior:";
  if (label === "search_hint") return "Search hint:";
  if (label === "stale_hint") return "Stale memory:";
  if (label === "contradiction_warning") return "Contradiction warning:";
  return "Episode context:";
}

function validatePolicy(policy: NormalizedPromptMemoryPolicy, issues: ValidationIssue[]): void {
  if (policy.max_items <= 0 || policy.max_characters <= 0) {
    issues.push(makeMemoryIssue("error", "MemoryPolicyInvalid", "$.prompt_memory_policy", "Prompt formatter policy must allow at least one item and one character.", "Use positive context limits."));
  }
}

function normalizePolicy(base: NormalizedPromptMemoryPolicy, override: PromptMemoryFormatterPolicy): NormalizedPromptMemoryPolicy {
  return Object.freeze({
    max_items: Math.max(1, Math.floor(valueOr(override.max_items, base.max_items))),
    max_characters: Math.max(1, Math.floor(valueOr(override.max_characters, base.max_characters))),
    include_audit_refs: override.include_audit_refs ?? base.include_audit_refs,
    require_memory_label: override.require_memory_label ?? base.require_memory_label,
  });
}

function valueOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function isString(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && !HIDDEN_MEMORY_PATTERN.test(value);
}
