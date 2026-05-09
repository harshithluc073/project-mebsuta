/**
 * Evidence grounding resolver for Project Mebsuta monologue claims.
 *
 * Blueprint: `architecture_docs/17_INTERNAL_MONOLOGUE_TTS_OBSERVABILITY.md`
 * sections 17.4.1, 17.6.2, 17.7.4, 17.11, 17.12.1, and 17.17.
 *
 * This component links candidate narration to replayable evidence records and
 * downgrades or blocks claims that lack embodied, validator, policy, memory, or
 * telemetry support.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  aggregateConfidence,
  buildGroundedClaim,
  compactText,
  containsForbiddenRuntimeText,
  containsSuccessCertaintyText,
  freezeArray,
  makeIssue,
  makeObservabilityRef,
  uniqueRefs,
  validateRef,
} from "./observability_event_emitter";
import type {
  ClaimType,
  ConfidenceClass,
  GroundedClaimRecord,
  GroundedClaimSet,
  MonologueIntent,
  PromptSafeStatus,
  ProvenanceClass,
} from "./observability_event_emitter";

export const EVIDENCE_GROUNDING_RESOLVER_SCHEMA_VERSION = "mebsuta.evidence_grounding_resolver.v1" as const;

export interface EvidenceRegistryRecord {
  readonly evidence_ref: Ref;
  readonly claim_type: ClaimType;
  readonly provenance_class: ProvenanceClass;
  readonly confidence_class: ConfidenceClass;
  readonly summary: string;
  readonly prompt_safe_status: PromptSafeStatus;
  readonly observed_at_ms?: number;
  readonly expires_at_ms?: number;
  readonly supports_success_claim?: boolean;
}

export interface EvidenceRegistry {
  readonly registry_ref: Ref;
  readonly records: readonly EvidenceRegistryRecord[];
}

export interface GroundingPolicy {
  readonly require_evidence_for_all_claims: boolean;
  readonly allow_policy_only_for_safety: boolean;
  readonly allow_memory_only_with_label: boolean;
  readonly block_success_without_certificate: boolean;
}

export interface GroundingResolutionReport {
  readonly grounding_resolution_report_ref: Ref;
  readonly source_intent_ref: Ref;
  readonly grounded_claim_set: GroundedClaimSet;
  readonly grounded_intent: MonologueIntent;
  readonly determinism_hash: string;
}

/**
 * Resolves an intent's evidence refs into claim records with confidence labels.
 */
export class EvidenceGroundingResolver {
  public resolveGroundedClaims(intent: MonologueIntent, evidenceRegistry: EvidenceRegistry, policy?: Partial<GroundingPolicy>): GroundingResolutionReport {
    const resolvedPolicy = mergePolicy(policy);
    const issues: ValidationIssue[] = [];
    validateRef(intent.monologue_intent_ref, "$.intent.monologue_intent_ref", issues);
    validateRef(evidenceRegistry.registry_ref, "$.evidence_registry.registry_ref", issues);

    const recordsByRef = new Map<Ref, EvidenceRegistryRecord>(evidenceRegistry.records.map((record) => [record.evidence_ref, record]));
    const claims: GroundedClaimRecord[] = [];
    const blockedClaimRefs: Ref[] = [];
    const missingRefs: Ref[] = [];

    for (const [index, ref] of intent.evidence_claim_refs.entries()) {
      validateRef(ref, `$.intent.evidence_claim_refs[${index}]`, issues);
      const evidence = recordsByRef.get(ref);
      if (evidence === undefined) {
        missingRefs.push(ref);
        if (resolvedPolicy.require_evidence_for_all_claims) {
          blockedClaimRefs.push(makeObservabilityRef("missing_claim", intent.monologue_intent_ref, ref));
        }
        continue;
      }
      const claim = buildClaimFromEvidence(intent, evidence, index, resolvedPolicy, issues);
      if (claim.prompt_safe_status === "blocked") {
        blockedClaimRefs.push(claim.claim_ref);
      }
      claims.push(claim);
    }

    const successWithoutCertificate = resolvedPolicy.block_success_without_certificate
      && containsSuccessCertaintyText(intent.candidate_message)
      && !claims.some((claim) => claim.claim_type === "verification" && claim.confidence_class === "verified");
    if (successWithoutCertificate) {
      const claimRef = makeObservabilityRef("unsupported_success_claim", intent.monologue_intent_ref);
      blockedClaimRefs.push(claimRef);
      issues.push(makeIssue("error", "GroundingSuccessNeedsCertificate", "$.intent.candidate_message", "Success wording requires a verified certificate claim.", "Attach a verification certificate or rewrite as uncertain evidence."));
    }

    const claimSetBase = {
      grounded_claim_set_ref: makeObservabilityRef("grounded_claim_set", intent.monologue_intent_ref),
      source_intent_ref: intent.monologue_intent_ref,
      claims: freezeArray(claims),
      blocked_claim_refs: uniqueRefs(blockedClaimRefs),
      missing_evidence_refs: uniqueRefs(missingRefs),
      overall_confidence: aggregateConfidence(claims),
      validation_issues: freezeArray(issues),
    };
    const groundedClaimSet = Object.freeze({ ...claimSetBase, determinism_hash: computeDeterminismHash(claimSetBase) });
    const groundedIntent = attachGroundingLabels(intent, groundedClaimSet);
    const base = {
      grounding_resolution_report_ref: makeObservabilityRef("grounding_resolution_report", intent.monologue_intent_ref, evidenceRegistry.registry_ref),
      source_intent_ref: intent.monologue_intent_ref,
      grounded_claim_set: groundedClaimSet,
      grounded_intent: groundedIntent,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

function buildClaimFromEvidence(
  intent: MonologueIntent,
  evidence: EvidenceRegistryRecord,
  index: number,
  policy: GroundingPolicy,
  issues: ValidationIssue[],
): GroundedClaimRecord {
  const sourceRefs = uniqueRefs([evidence.evidence_ref]);
  const unsupportedPolicyOnly = evidence.provenance_class === "policy_config" && evidence.claim_type !== "safety" && !policy.allow_policy_only_for_safety;
  const memoryNeedsLabel = evidence.provenance_class === "memory" && !intent.memory_labels.some((label) => /memory/i.test(label));
  const forbidden = containsForbiddenRuntimeText(evidence.summary);
  const promptSafeStatus: PromptSafeStatus = unsupportedPolicyOnly || memoryNeedsLabel || forbidden ? "blocked" : evidence.prompt_safe_status;
  if (unsupportedPolicyOnly) {
    issues.push(makeIssue("error", "GroundingPolicyOnlyClaim", `$.evidence_registry.records[${index}]`, "Policy-only evidence can ground safety claims but not physical world claims.", "Attach embodied evidence for world-state narration."));
  }
  if (memoryNeedsLabel && !policy.allow_memory_only_with_label) {
    issues.push(makeIssue("error", "GroundingMemoryUnlabeled", `$.evidence_registry.records[${index}]`, "Memory evidence must be labeled as memory.", "Add memory labels before narration."));
  }
  const uncertainty = buildUncertaintySummary(evidence);
  return buildGroundedClaim({
    claim_ref: makeObservabilityRef("grounded_claim", intent.monologue_intent_ref, evidence.evidence_ref),
    claim_text: compactText(evidence.summary, 280),
    claim_type: evidence.claim_type,
    source_evidence_refs: sourceRefs,
    provenance_class: evidence.provenance_class,
    confidence_class: evidence.confidence_class,
    uncertainty_summary: uncertainty,
    prompt_safe_status: promptSafeStatus,
  });
}

function buildUncertaintySummary(evidence: EvidenceRegistryRecord): string | undefined {
  if (evidence.confidence_class === "verified" || evidence.confidence_class === "high") {
    return undefined;
  }
  if (evidence.provenance_class === "memory") {
    return "Memory evidence is advisory until current perception confirms it.";
  }
  if (evidence.claim_type === "audio") {
    return "Audio evidence is suggestive and does not certify spatial success.";
  }
  if (evidence.confidence_class === "ambiguous" || evidence.confidence_class === "low") {
    return "Additional embodied evidence is required before a confident claim.";
  }
  if (evidence.confidence_class === "contradicted") {
    return "The claim conflicts with newer evidence and must not be spoken as current fact.";
  }
  return undefined;
}

function attachGroundingLabels(intent: MonologueIntent, set: GroundedClaimSet): MonologueIntent {
  const confidenceLabels = uniqueText([...intent.confidence_labels, `grounding:${set.overall_confidence}`]);
  const safetyLabels = set.blocked_claim_refs.length > 0 ? uniqueText([...intent.safety_labels, "blocked-claims-present"]) : intent.safety_labels;
  const base = {
    ...intent,
    evidence_claim_refs: uniqueRefs([...intent.evidence_claim_refs, ...set.claims.map((claim) => claim.claim_ref)]),
    confidence_labels: confidenceLabels,
    safety_labels: freezeArray(safetyLabels),
    validation_issues: freezeArray([...intent.validation_issues, ...set.validation_issues]),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function uniqueText(items: readonly string[]): readonly string[] {
  return freezeArray([...new Set(items.filter((item) => item.trim().length > 0))]);
}

function mergePolicy(policy?: Partial<GroundingPolicy>): GroundingPolicy {
  return Object.freeze({
    require_evidence_for_all_claims: policy?.require_evidence_for_all_claims ?? true,
    allow_policy_only_for_safety: policy?.allow_policy_only_for_safety ?? true,
    allow_memory_only_with_label: policy?.allow_memory_only_with_label ?? true,
    block_success_without_certificate: policy?.block_success_without_certificate ?? true,
  });
}

export const EVIDENCE_GROUNDING_RESOLVER_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: EVIDENCE_GROUNDING_RESOLVER_SCHEMA_VERSION,
  blueprint: "architecture_docs/17_INTERNAL_MONOLOGUE_TTS_OBSERVABILITY.md",
  sections: freezeArray(["17.4.1", "17.6.2", "17.7.4", "17.11", "17.12.1", "17.17"]),
  component: "EvidenceGroundingResolver",
});
