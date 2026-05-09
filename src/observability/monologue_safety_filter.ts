/**
 * Monologue safety filter for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/17_INTERNAL_MONOLOGUE_TTS_OBSERVABILITY.md`
 * sections 17.5.3, 17.6.3, 17.7, 17.11, 17.12.2, 17.16, and 17.18.
 *
 * The filter applies the MF and OG safety rules to candidate narration. It
 * fails closed for hidden-truth, prompt-internal, QA-only, and unsupported
 * success claims while producing a deterministic redaction report for replay.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  compressPublicMessage,
  containsForbiddenRuntimeText,
  containsPromptInternalText,
  containsSuccessCertaintyText,
  freezeArray,
  makeIssue,
  makeObservabilityRef,
  sanitizePublicText,
  uniqueRefs,
  validateRef,
} from "./observability_event_emitter";
import type {
  ApprovedMonologueUtterance,
  FilterOutcome,
  GroundedClaimSet,
  MonologueFilterDecision,
  MonologueIntent,
  RedactionReport,
} from "./observability_event_emitter";

export const MONOLOGUE_SAFETY_FILTER_SCHEMA_VERSION = "mebsuta.monologue_safety_filter.v1" as const;

export interface MonologueFirewallPolicy {
  readonly policy_ref: Ref;
  readonly allow_developer_display_for_redacted: boolean;
  readonly allow_qa_truth_in_runtime_modes: boolean;
  readonly max_spoken_chars: number;
  readonly block_prompt_internals: boolean;
}

export interface MonologueSafetyPolicy {
  readonly safety_policy_ref: Ref;
  readonly playback_policy_ref: Ref;
  readonly tts_profile_ref?: Ref;
  readonly require_certificate_for_success: boolean;
  readonly require_memory_label: boolean;
  readonly require_audio_uncertainty_label: boolean;
  readonly tts_enabled: boolean;
}

/**
 * Produces approved, redacted, display-only, or blocked utterance decisions.
 */
export class MonologueSafetyFilter {
  public filterMonologueIntent(
    monologueIntent: MonologueIntent,
    groundedClaimSet: GroundedClaimSet,
    firewallPolicy: MonologueFirewallPolicy,
    safetyPolicy: MonologueSafetyPolicy,
  ): MonologueFilterDecision {
    const issues: ValidationIssue[] = [];
    validateRef(monologueIntent.monologue_intent_ref, "$.intent.monologue_intent_ref", issues);
    validateRef(firewallPolicy.policy_ref, "$.firewall_policy.policy_ref", issues);
    validateRef(safetyPolicy.safety_policy_ref, "$.safety_policy.safety_policy_ref", issues);
    validateRef(safetyPolicy.playback_policy_ref, "$.safety_policy.playback_policy_ref", issues);

    const rules: string[] = [];
    const blockedClaimRefs: Ref[] = [...groundedClaimSet.blocked_claim_refs];
    const rewrittenClaimRefs: Ref[] = [];
    let message = monologueIntent.candidate_message;
    let auditRequired = false;

    const forbiddenRuntime = containsForbiddenRuntimeText(message);
    if (forbiddenRuntime) {
      rules.push("MF-001", "MF-002");
      message = message.replace(/object[_ -]?id\s*[a-z0-9_.:-]*/gi, "the perceived object");
      message = message.replace(/ground[_ -]?truth|hidden[_ -]?pose|scene[_ -]?graph|backend/gi, "embodied evidence");
      auditRequired = true;
    }

    if (firewallPolicy.block_prompt_internals && containsPromptInternalText(message)) {
      rules.push("MF-005");
      auditRequired = true;
      issues.push(makeIssue("error", "MonologuePromptInternalBlocked", "$.candidate_message", "Prompt-private or raw deliberation content cannot be displayed or spoken.", "Use a short public decision summary."));
    }

    if (safetyPolicy.require_memory_label && referencesMemory(monologueIntent, message)) {
      rules.push("MF-003");
      message = ensureMemoryLanguage(message);
      rewrittenClaimRefs.push(...groundedClaimSet.claims.filter((claim) => claim.claim_type === "memory").map((claim) => claim.claim_ref));
    }

    if (safetyPolicy.require_audio_uncertainty_label && referencesAudio(monologueIntent, message)) {
      message = ensureAudioLanguage(message);
      rewrittenClaimRefs.push(...groundedClaimSet.claims.filter((claim) => claim.claim_type === "audio").map((claim) => claim.claim_ref));
    }

    if (needsUncertaintyDowngrade(groundedClaimSet)) {
      rules.push("MF-004");
      message = ensureUncertainLanguage(message);
      rewrittenClaimRefs.push(...groundedClaimSet.claims.filter((claim) => claim.confidence_class === "ambiguous" || claim.confidence_class === "low").map((claim) => claim.claim_ref));
    }

    if (hasQaOnlyClaim(groundedClaimSet) && !firewallPolicy.allow_qa_truth_in_runtime_modes) {
      rules.push("MF-006");
      auditRequired = true;
      for (const claim of groundedClaimSet.claims.filter((item) => item.provenance_class === "qa_only")) {
        blockedClaimRefs.push(claim.claim_ref);
      }
    }

    if (safetyPolicy.require_certificate_for_success && containsSuccessCertaintyText(message) && !hasVerifiedCertificateClaim(groundedClaimSet)) {
      rules.push("MF-007");
      message = message.replace(/\b(verified|confirmed|complete|success|succeeded|passed)\b/gi, "appears possible");
      issues.push(makeIssue("warning", "MonologueSuccessDowngraded", "$.candidate_message", "Success wording was downgraded because no verified certificate claim is attached.", "Attach a verification claim before speaking success."));
    }

    const sanitized = sanitizePublicText(message, true, firewallPolicy.max_spoken_chars, issues, "$.final_message");
    const outcome = chooseOutcome(sanitized, issues, rules, blockedClaimRefs, monologueIntent, firewallPolicy, safetyPolicy);
    const redactionReport = buildRedactionReport(monologueIntent.monologue_intent_ref, rules, blockedClaimRefs, rewrittenClaimRefs, outcome, auditRequired);
    const utterance = buildApprovedUtterance(monologueIntent, groundedClaimSet, sanitized, outcome, redactionReport, safetyPolicy);
    const base = {
      filter_decision_ref: makeObservabilityRef("monologue_filter_decision", monologueIntent.monologue_intent_ref, outcome),
      source_intent_ref: monologueIntent.monologue_intent_ref,
      outcome,
      approved_utterance: utterance,
      redaction_report: redactionReport,
      final_display_text: outcome === "block_silent_log" || outcome === "block_and_raise_audit" ? undefined : sanitized,
      issues: freezeArray(issues),
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

function chooseOutcome(
  message: string,
  issues: readonly ValidationIssue[],
  rules: readonly string[],
  blockedClaimRefs: readonly Ref[],
  intent: MonologueIntent,
  firewallPolicy: MonologueFirewallPolicy,
  safetyPolicy: MonologueSafetyPolicy,
): FilterOutcome {
  if (issues.some((issue) => issue.severity === "error") || blockedClaimRefs.length > 0 && rules.includes("MF-006")) {
    return rules.includes("MF-005") || rules.includes("MF-006") ? "block_and_raise_audit" : "block_silent_log";
  }
  if (message.length === 0) {
    return "block_silent_log";
  }
  if (!intent.requires_tts || !safetyPolicy.tts_enabled) {
    return "downgrade_to_display_only";
  }
  if (rules.length > 0 || blockedClaimRefs.length > 0 || firewallPolicy.allow_developer_display_for_redacted) {
    return "approve_with_redaction";
  }
  return "approve";
}

function buildApprovedUtterance(
  intent: MonologueIntent,
  groundedClaimSet: GroundedClaimSet,
  message: string,
  outcome: FilterOutcome,
  report: RedactionReport,
  safetyPolicy: MonologueSafetyPolicy,
): ApprovedMonologueUtterance | undefined {
  if (outcome === "block_silent_log" || outcome === "block_and_raise_audit") {
    return undefined;
  }
  const displayOnly = outcome === "downgrade_to_display_only" || !safetyPolicy.tts_enabled;
  const base = {
    utterance_ref: makeObservabilityRef("approved_utterance", intent.monologue_intent_ref),
    source_intent_ref: intent.monologue_intent_ref,
    final_message: compressPublicMessage(message),
    utterance_class: intent.utterance_class,
    priority: intent.priority,
    tts_profile_ref: displayOnly ? undefined : safetyPolicy.tts_profile_ref,
    playback_policy_ref: safetyPolicy.playback_policy_ref,
    grounding_summary_refs: uniqueRefs([...groundedClaimSet.claims.map((claim) => claim.claim_ref), ...groundedClaimSet.claims.flatMap((claim) => claim.source_evidence_refs)]),
    redaction_report_ref: report.redaction_report_ref,
    acoustic_suppression_marker_required: !displayOnly,
    display_only: displayOnly,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function buildRedactionReport(
  intentRef: Ref,
  rules: readonly string[],
  blocked: readonly Ref[],
  rewritten: readonly Ref[],
  outcome: FilterOutcome,
  auditRequired: boolean,
): RedactionReport {
  const base = {
    redaction_report_ref: makeObservabilityRef("redaction_report", intentRef, outcome),
    source_intent_ref: intentRef,
    redaction_rules_applied: uniqueStrings(rules),
    blocked_claim_refs: uniqueRefs(blocked),
    rewritten_claim_refs: uniqueRefs(rewritten),
    final_decision: outcome,
    audit_required: auditRequired || outcome === "block_and_raise_audit",
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function referencesMemory(intent: MonologueIntent, message: string): boolean {
  return intent.utterance_class === "memory_context" || intent.memory_labels.length > 0 || /\bmemory|remember|previously|last seen|last verified\b/i.test(message);
}

function referencesAudio(intent: MonologueIntent, message: string): boolean {
  return intent.utterance_class === "audio_attention" || /\bheard|audio|sound|impact|voice\b/i.test(message);
}

function ensureMemoryLanguage(message: string): string {
  return /\bI remember|memory|previously|last verified\b/i.test(message) ? message : `I remember this as prior context: ${message}`;
}

function ensureAudioLanguage(message: string): string {
  return /\bheard|sound cue|suggestive\b/i.test(message) ? message : `I heard a suggestive sound cue: ${message}`;
}

function ensureUncertainLanguage(message: string): string {
  return /\bappears|unclear|ambiguous|need another view|cannot tell\b/i.test(message) ? message : `${message} This appears uncertain, so more evidence may be needed.`;
}

function needsUncertaintyDowngrade(set: GroundedClaimSet): boolean {
  return set.overall_confidence === "ambiguous" || set.overall_confidence === "low" || set.claims.some((claim) => claim.confidence_class === "ambiguous" || claim.confidence_class === "low");
}

function hasQaOnlyClaim(set: GroundedClaimSet): boolean {
  return set.claims.some((claim) => claim.provenance_class === "qa_only");
}

function hasVerifiedCertificateClaim(set: GroundedClaimSet): boolean {
  return set.claims.some((claim) => claim.claim_type === "verification" && claim.confidence_class === "verified");
}

function uniqueStrings(items: readonly string[]): readonly string[] {
  return freezeArray([...new Set(items.filter((item) => item.trim().length > 0))]);
}

export const MONOLOGUE_SAFETY_FILTER_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: MONOLOGUE_SAFETY_FILTER_SCHEMA_VERSION,
  blueprint: "architecture_docs/17_INTERNAL_MONOLOGUE_TTS_OBSERVABILITY.md",
  sections: freezeArray(["17.5.3", "17.6.3", "17.7", "17.11", "17.12.2", "17.16", "17.18"]),
  component: "MonologueSafetyFilter",
});
