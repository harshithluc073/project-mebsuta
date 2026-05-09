/**
 * Visual memory evidence builder for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md`
 * sections 9.3.1, 9.5.1, 9.16, 9.17, 9.18, 9.19, and 9.20.
 *
 * The builder converts current perception consensus, optional verification
 * context, and optional Oops visual evidence into retrieval-ready memory
 * records. It preserves source views, compact descriptors, spatial relations,
 * confidence, staleness, contradiction links, and evidence limitations while
 * preventing hidden simulator truth or overcertain memory claims.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import type {
  ConsensusObject,
  MultiViewConsensusReport,
  ViewConflictRecord,
  VisualMemoryPrior,
} from "./cross_view_consensus_engine";
import type { CanonicalViewName } from "./view_name_registry";
import type {
  FailureVisualEvidenceBundle,
  ObjectVisibilityChange,
  VisualMemoryHandoffCandidate,
} from "./visual_evidence_recorder";
import type {
  VerificationObservationBundle,
  VerificationRelationObservation,
} from "./verification_view_assembler";

export const VISUAL_MEMORY_EVIDENCE_BUILDER_SCHEMA_VERSION = "mebsuta.visual_memory_evidence_builder.v1" as const;

const HIDDEN_MEMORY_EVIDENCE_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|segmentation truth|debug buffer|debug overlay|qa_success|qa_label|qa_only|simulator truth|mesh_name|asset_id)/i;

export type VisualMemoryEvidenceKind = "object_observation" | "verification_result" | "failure_event" | "scene_context";
export type VisualMemoryConfidenceBand = "low" | "medium" | "high";
export type VisualMemoryDecision = "memory_ready" | "memory_ready_with_warnings" | "rejected";
export type VisualMemoryRecommendedAction = "write_memory_candidates" | "reobserve_before_memory" | "review_contradictions" | "safe_hold" | "discard";
export type VisualMemoryStalenessClass = "short_lived" | "task_lived" | "session_lived" | "long_lived_descriptor";
export type VisualMemoryOmissionReason = "low_confidence" | "hidden_source" | "missing_current_view" | "overcertain_memory" | "duplicate_low_value";
export type VisualMemoryIssueCode =
  | "HiddenVisualMemoryLeak"
  | "ConsensusRejected"
  | "ConsensusMissingObjects"
  | "VerificationConsensusMismatch"
  | "FailureConsensusMismatch"
  | "MemoryPolicyInvalid"
  | "OvercertainMemoryClamped"
  | "CurrentViewMissing"
  | "ContradictionUnresolved"
  | "NoMemoryRecords";

/**
 * Policy controlling confidence caps, staleness, and what evidence sources are
 * allowed to become memory candidates.
 */
export interface VisualMemoryPolicy {
  readonly min_confidence?: number;
  readonly max_memory_confidence?: number;
  readonly max_single_view_confidence?: number;
  readonly max_occluded_confidence?: number;
  readonly memory_stale_after_s?: number;
  readonly require_current_view?: boolean;
  readonly include_verification_evidence?: boolean;
  readonly include_failure_evidence?: boolean;
  readonly allow_conflicted_memory_write?: boolean;
  readonly max_records?: number;
  readonly hidden_source_action?: "reject" | "redact_with_issue";
}

/**
 * Related prior memory or current conflict that should be attached to a new
 * visual memory record instead of silently resolved.
 */
export interface VisualMemoryContradictionLink {
  readonly contradiction_ref: Ref;
  readonly contradiction_kind: "memory_prior_conflict" | "view_conflict" | "verification_ambiguity" | "failure_state_change";
  readonly source_ref: Ref;
  readonly label?: string;
  readonly severity: "warning" | "blocking";
  readonly summary: string;
}

/**
 * Candidate omitted before the memory write boundary. These records make it
 * explicit when low confidence, missing current views, hidden wording, or
 * duplicated descriptors prevented a memory candidate.
 */
export interface OmittedVisualMemoryCandidate {
  readonly candidate_ref: Ref;
  readonly candidate_kind: VisualMemoryEvidenceKind;
  readonly label?: string;
  readonly reason: VisualMemoryOmissionReason;
  readonly rationale: string;
}

/**
 * File 09 `Visual Memory Evidence` executable shape.
 */
export interface VisualMemoryEvidence {
  readonly visual_memory_ref: Ref;
  readonly evidence_kind: VisualMemoryEvidenceKind;
  readonly source_observation_bundle_ref: Ref;
  readonly object_hypothesis_ref?: Ref;
  readonly source_consensus_object_ref?: Ref;
  readonly source_verification_bundle_ref?: Ref;
  readonly source_failure_visual_bundle_ref?: Ref;
  readonly visual_descriptor: string;
  readonly spatial_descriptor?: string;
  readonly source_views: readonly CanonicalViewName[];
  readonly confidence: number;
  readonly confidence_band: VisualMemoryConfidenceBand;
  readonly staleness_hint: string;
  readonly staleness_class: VisualMemoryStalenessClass;
  readonly contradiction_links: readonly Ref[];
  readonly provenance_summary: string;
  readonly evidence_limitations: readonly string[];
  readonly memory_write_recommended: boolean;
  readonly determinism_hash: string;
}

/**
 * Builder output consumed by future memory services.
 */
export interface VisualMemoryEvidenceSet {
  readonly schema_version: typeof VISUAL_MEMORY_EVIDENCE_BUILDER_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md";
  readonly visual_memory_set_ref: Ref;
  readonly source_observation_bundle_ref: Ref;
  readonly consensus_ref: Ref;
  readonly verification_bundle_ref?: Ref;
  readonly failure_visual_bundle_refs: readonly Ref[];
  readonly memory_records: readonly VisualMemoryEvidence[];
  readonly omitted_candidates: readonly OmittedVisualMemoryCandidate[];
  readonly contradiction_index: readonly VisualMemoryContradictionLink[];
  readonly prior_memory_refs: readonly Ref[];
  readonly decision: VisualMemoryDecision;
  readonly recommended_action: VisualMemoryRecommendedAction;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
  readonly cognitive_visibility: "perception_visual_memory_evidence_set";
}

interface NormalizedVisualMemoryPolicy {
  readonly min_confidence: number;
  readonly max_memory_confidence: number;
  readonly max_single_view_confidence: number;
  readonly max_occluded_confidence: number;
  readonly memory_stale_after_s: number;
  readonly require_current_view: boolean;
  readonly include_verification_evidence: boolean;
  readonly include_failure_evidence: boolean;
  readonly allow_conflicted_memory_write: boolean;
  readonly max_records: number;
  readonly hidden_source_action: "reject" | "redact_with_issue";
}

interface MemoryCandidateDraft {
  readonly candidate_ref: Ref;
  readonly evidence_kind: VisualMemoryEvidenceKind;
  readonly source_observation_bundle_ref: Ref;
  readonly object_hypothesis_ref?: Ref;
  readonly source_consensus_object_ref?: Ref;
  readonly source_verification_bundle_ref?: Ref;
  readonly source_failure_visual_bundle_ref?: Ref;
  readonly label?: string;
  readonly visual_descriptor: string;
  readonly spatial_descriptor?: string;
  readonly source_views: readonly CanonicalViewName[];
  readonly base_confidence: number;
  readonly staleness_class: VisualMemoryStalenessClass;
  readonly staleness_hint: string;
  readonly contradiction_refs: readonly Ref[];
  readonly provenance_summary: string;
  readonly evidence_limitations: readonly string[];
  readonly priority: number;
}

const DEFAULT_POLICY: NormalizedVisualMemoryPolicy = Object.freeze({
  min_confidence: 0.34,
  max_memory_confidence: 0.86,
  max_single_view_confidence: 0.62,
  max_occluded_confidence: 0.48,
  memory_stale_after_s: 1_800,
  require_current_view: true,
  include_verification_evidence: true,
  include_failure_evidence: true,
  allow_conflicted_memory_write: false,
  max_records: 24,
  hidden_source_action: "reject",
});

/**
 * Executable File 09 `VisualMemoryEvidenceBuilder`.
 */
export class VisualMemoryEvidenceBuilder {
  private readonly policy: NormalizedVisualMemoryPolicy;

  public constructor(policy: VisualMemoryPolicy = {}) {
    this.policy = mergePolicy(DEFAULT_POLICY, policy);
  }

  /**
   * Converts perception evidence into bounded-confidence visual memory records.
   */
  public buildVisualMemoryEvidence(
    consensusReport: MultiViewConsensusReport,
    verificationCertificate?: VerificationObservationBundle,
    memoryPolicy: VisualMemoryPolicy = {},
    failureEvidenceBundles: readonly FailureVisualEvidenceBundle[] = [],
    memoryPriors: readonly VisualMemoryPrior[] = [],
  ): VisualMemoryEvidenceSet {
    const activePolicy = mergePolicy(this.policy, memoryPolicy);
    const issues: ValidationIssue[] = [];
    validateInputs(consensusReport, verificationCertificate, failureEvidenceBundles, memoryPriors, activePolicy, issues);

    const contradictionIndex = buildContradictionIndex(consensusReport, verificationCertificate, failureEvidenceBundles, memoryPriors);
    const drafts = [
      ...draftsFromConsensus(consensusReport, contradictionIndex, activePolicy),
      ...(activePolicy.include_verification_evidence && verificationCertificate !== undefined ? draftsFromVerification(consensusReport, verificationCertificate, contradictionIndex, activePolicy) : []),
      ...(activePolicy.include_failure_evidence ? draftsFromFailures(consensusReport, failureEvidenceBundles, contradictionIndex, activePolicy) : []),
      sceneContextDraft(consensusReport, verificationCertificate, failureEvidenceBundles, contradictionIndex, activePolicy),
    ].filter(isDraft);

    const selection = selectMemoryRecords(drafts, contradictionIndex, activePolicy, issues);
    if (selection.records.length === 0) {
      issues.push(makeIssue("error", "NoMemoryRecords", "$.memory_records", "VisualMemoryEvidenceBuilder produced no memory-ready visual records.", "Provide current consensus objects or lower the memory threshold after reobserve."));
    }
    const decision = decideMemorySet(selection.records, selection.omitted, issues);
    const recommendedAction = chooseRecommendedAction(decision, selection.records, selection.omitted, contradictionIndex, issues, consensusReport);
    const setRef = makeRef("visual_memory_set", consensusReport.consensus_ref, verificationCertificate?.verification_bundle_ref ?? "no_verification", failureEvidenceBundles.map((bundle) => bundle.failure_visual_bundle_ref).join(":"));
    const sortedRecords = [...selection.records].sort(compareMemoryRecords);
    const sortedOmitted = [...selection.omitted].sort(compareOmittedCandidates);
    const shell = {
      setRef,
      consensus: consensusReport.consensus_ref,
      verification: verificationCertificate?.verification_bundle_ref,
      failures: failureEvidenceBundles.map((bundle) => bundle.failure_visual_bundle_ref).sort(),
      records: sortedRecords.map((record) => [record.visual_memory_ref, record.evidence_kind, record.confidence, record.source_views]),
      omitted: sortedOmitted.map((item) => [item.candidate_ref, item.reason]),
      contradictions: contradictionIndex.map((link) => [link.contradiction_ref, link.severity]),
      decision,
    };

    return Object.freeze({
      schema_version: VISUAL_MEMORY_EVIDENCE_BUILDER_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md",
      visual_memory_set_ref: setRef,
      source_observation_bundle_ref: consensusReport.bundle_ref,
      consensus_ref: consensusReport.consensus_ref,
      verification_bundle_ref: verificationCertificate?.verification_bundle_ref,
      failure_visual_bundle_refs: freezeArray(failureEvidenceBundles.map((bundle) => bundle.failure_visual_bundle_ref).sort()),
      memory_records: freezeArray(sortedRecords),
      omitted_candidates: freezeArray(sortedOmitted),
      contradiction_index: freezeArray([...contradictionIndex].sort(compareContradictionLinks)),
      prior_memory_refs: freezeArray(memoryPriors.map((prior) => prior.memory_ref).sort()),
      decision,
      recommended_action: recommendedAction,
      issues: freezeArray(issues),
      ok: decision !== "rejected",
      determinism_hash: computeDeterminismHash(shell),
      cognitive_visibility: "perception_visual_memory_evidence_set",
    });
  }
}

/**
 * Functional API matching File 09's memory-evidence signature.
 */
export function buildVisualMemoryEvidence(
  consensusReport: MultiViewConsensusReport,
  verificationCertificate?: VerificationObservationBundle,
  memoryPolicy: VisualMemoryPolicy = {},
  failureEvidenceBundles: readonly FailureVisualEvidenceBundle[] = [],
  memoryPriors: readonly VisualMemoryPrior[] = [],
): VisualMemoryEvidenceSet {
  return new VisualMemoryEvidenceBuilder(memoryPolicy).buildVisualMemoryEvidence(
    consensusReport,
    verificationCertificate,
    memoryPolicy,
    failureEvidenceBundles,
    memoryPriors,
  );
}

function validateInputs(
  consensusReport: MultiViewConsensusReport,
  verificationCertificate: VerificationObservationBundle | undefined,
  failureEvidenceBundles: readonly FailureVisualEvidenceBundle[],
  memoryPriors: readonly VisualMemoryPrior[],
  policy: NormalizedVisualMemoryPolicy,
  issues: ValidationIssue[],
): void {
  if (policy.min_confidence < 0 || policy.min_confidence > 1 || policy.max_memory_confidence < policy.min_confidence || policy.max_records <= 0) {
    issues.push(makeIssue("error", "MemoryPolicyInvalid", "$.memory_policy", "Memory policy thresholds must be finite, ordered, and allow at least one record.", "Provide confidence thresholds in [0, 1] and a positive max record count."));
  }
  const hiddenSurface = JSON.stringify({ consensusReport, verificationCertificate, failureEvidenceBundles, memoryPriors });
  if (HIDDEN_MEMORY_EVIDENCE_PATTERN.test(hiddenSurface)) {
    const severity: ValidationSeverity = policy.hidden_source_action === "reject" ? "error" : "warning";
    issues.push(makeIssue(severity, "HiddenVisualMemoryLeak", "$.inputs", "Visual memory input contains hidden simulator, backend, QA, debug, or asset identifiers.", "Build memory only from sensor-derived consensus, verification, and failure evidence."));
  }
  if (consensusReport.decision === "rejected" || !consensusReport.ok) {
    issues.push(makeIssue("error", "ConsensusRejected", "$.consensus_report", "Rejected consensus cannot seed visual memory evidence.", "Reconcile current visual hypotheses before memory write."));
  }
  if (consensusReport.consensus_objects.length === 0) {
    issues.push(makeIssue("error", "ConsensusMissingObjects", "$.consensus_report.consensus_objects", "Consensus report contains no objects to remember.", "Collect current object hypotheses before memory write."));
  }
  if (verificationCertificate !== undefined && verificationCertificate.consensus_ref !== consensusReport.consensus_ref) {
    issues.push(makeIssue("warning", "VerificationConsensusMismatch", "$.verification_certificate.consensus_ref", "Verification evidence references a different consensus report.", "Use verification evidence assembled from the same consensus before memory write."));
  }
  for (const bundle of failureEvidenceBundles) {
    if (bundle.source_consensus_ref !== undefined && bundle.source_consensus_ref !== consensusReport.consensus_ref) {
      issues.push(makeIssue("warning", "FailureConsensusMismatch", `$.failure_evidence.${bundle.failure_visual_bundle_ref}.source_consensus_ref`, "Failure evidence references a different consensus report.", "Attach only failure evidence from the same consensus path or keep it as a separate episode."));
    }
  }
}

function draftsFromConsensus(
  consensusReport: MultiViewConsensusReport,
  contradictions: readonly VisualMemoryContradictionLink[],
  policy: NormalizedVisualMemoryPolicy,
): readonly MemoryCandidateDraft[] {
  return freezeArray(consensusReport.consensus_objects.map((object) => draftFromObject(consensusReport, object, contradictions, policy)));
}

function draftFromObject(
  consensusReport: MultiViewConsensusReport,
  object: ConsensusObject,
  contradictions: readonly VisualMemoryContradictionLink[],
  policy: NormalizedVisualMemoryPolicy,
): MemoryCandidateDraft {
  const sourceViews = uniqueViews(object.supporting_view_names);
  const contradictionRefs = contradictionRefsFor(object.label, object.conflict_refs, contradictions);
  const currentViewCount = object.evidence_views.filter((view) => view.current_packet).length;
  const spatialDescriptor = spatialDescriptorForObject(object);
  const baseConfidence = objectMemoryConfidence(object, currentViewCount, contradictionRefs, policy);
  const stalenessClass = stalenessClassForObject(object);
  return Object.freeze({
    candidate_ref: makeRef("memory_candidate", "object", object.consensus_object_ref),
    evidence_kind: "object_observation",
    source_observation_bundle_ref: consensusReport.bundle_ref,
    object_hypothesis_ref: object.source_hypothesis_refs[0],
    source_consensus_object_ref: object.consensus_object_ref,
    label: object.label,
    visual_descriptor: sanitizeText(`${object.label}: ${object.visual_description_summary}; role=${object.estimated_object_role}; status=${object.status}`),
    spatial_descriptor: spatialDescriptor,
    source_views: sourceViews,
    base_confidence: baseConfidence,
    staleness_class: stalenessClass,
    staleness_hint: stalenessHintForObject(object, stalenessClass, policy),
    contradiction_refs: contradictionRefs,
    provenance_summary: `Consensus ${consensusReport.consensus_ref}; object ${object.consensus_object_ref}; hypotheses=${object.source_hypothesis_refs.join(",") || "none"}.`,
    evidence_limitations: limitationsForObject(object, consensusReport, currentViewCount),
    priority: priorityForObject(object, currentViewCount),
  });
}

function draftsFromVerification(
  consensusReport: MultiViewConsensusReport,
  verification: VerificationObservationBundle,
  contradictions: readonly VisualMemoryContradictionLink[],
  policy: NormalizedVisualMemoryPolicy,
): readonly MemoryCandidateDraft[] {
  const relationDrafts = verification.visual_relation_observations.map((observation) => draftFromVerificationRelation(consensusReport, verification, observation, contradictions, policy));
  const bundleDraft = draftFromVerificationBundle(consensusReport, verification, contradictions, policy);
  return freezeArray([bundleDraft, ...relationDrafts]);
}

function draftFromVerificationRelation(
  consensusReport: MultiViewConsensusReport,
  verification: VerificationObservationBundle,
  observation: VerificationRelationObservation,
  contradictions: readonly VisualMemoryContradictionLink[],
  policy: NormalizedVisualMemoryPolicy,
): MemoryCandidateDraft {
  const contradictionRefs = contradictionRefsFor(observation.target_label, [observation.constraint_ref], contradictions);
  const confidence = verification.ok ? observation.confidence : observation.confidence * 0.62;
  const descriptor = `${observation.target_label} ${observation.relation}${observation.reference_label === undefined ? "" : ` ${observation.reference_label}`}; ${observation.observation_summary}`;
  return Object.freeze({
    candidate_ref: makeRef("memory_candidate", "verification_relation", verification.verification_bundle_ref, observation.observation_ref),
    evidence_kind: "verification_result",
    source_observation_bundle_ref: consensusReport.bundle_ref,
    source_verification_bundle_ref: verification.verification_bundle_ref,
    label: observation.target_label,
    visual_descriptor: sanitizeText(descriptor),
    spatial_descriptor: sanitizeText(`${observation.relation}${observation.reference_label === undefined ? "" : `:${observation.reference_label}`}`),
    source_views: uniqueViews(observation.evidence_views),
    base_confidence: clampMemoryConfidence(confidence, observation.evidence_views.length, verification.occlusion_status === "hidden", contradictionRefs.length > 0, policy),
    staleness_class: verification.decision === "ready_for_visual_verification" ? "task_lived" : "short_lived",
    staleness_hint: verification.decision === "ready_for_visual_verification" ? "Task-state relation may remain useful until the object or support moves." : "Verification was ambiguous; memory should be treated as a short-lived clue only.",
    contradiction_refs: contradictionRefs,
    provenance_summary: `Verification bundle ${verification.verification_bundle_ref}; constraint ${observation.constraint_ref}; consensus ${verification.consensus_ref}.`,
    evidence_limitations: limitationsForVerification(verification, observation.evidence_views),
    priority: verification.ok ? 86 : 58,
  });
}

function draftFromVerificationBundle(
  consensusReport: MultiViewConsensusReport,
  verification: VerificationObservationBundle,
  contradictions: readonly VisualMemoryContradictionLink[],
  policy: NormalizedVisualMemoryPolicy,
): MemoryCandidateDraft {
  const sourceViews = uniqueViews([...verification.provided_views, ...verification.inventory_views].map((view) => view.source_view_name));
  const contradictionRefs = contradictions.filter((link) => link.contradiction_kind === "verification_ambiguity").map((link) => link.contradiction_ref).sort();
  return Object.freeze({
    candidate_ref: makeRef("memory_candidate", "verification_bundle", verification.verification_bundle_ref),
    evidence_kind: "verification_result",
    source_observation_bundle_ref: consensusReport.bundle_ref,
    source_verification_bundle_ref: verification.verification_bundle_ref,
    visual_descriptor: sanitizeText(`Verification ${verification.decision}; constraints=${verification.target_constraint_refs.join(",") || "none"}; occlusion=${verification.occlusion_status}; action=${verification.recommended_action}.`),
    spatial_descriptor: verification.residual_hints.map((hint) => `${hint.target_label}:${hint.hint_summary}`).join(" | ") || undefined,
    source_views: sourceViews,
    base_confidence: clampMemoryConfidence(verification.ok ? 0.68 : 0.38, sourceViews.length, verification.occlusion_status === "hidden", contradictionRefs.length > 0, policy),
    staleness_class: verification.ok ? "task_lived" : "short_lived",
    staleness_hint: verification.ok ? "Verification state is task-lived and should expire when the scene changes." : "Ambiguous verification should expire quickly and trigger reobserve before reuse.",
    contradiction_refs: freezeArray(contradictionRefs),
    provenance_summary: `Verification bundle ${verification.verification_bundle_ref}; source bundle ${verification.source_bundle_ref}; consensus ${verification.consensus_ref}.`,
    evidence_limitations: limitationsForVerification(verification, sourceViews),
    priority: verification.ok ? 74 : 42,
  });
}

function draftsFromFailures(
  consensusReport: MultiViewConsensusReport,
  bundles: readonly FailureVisualEvidenceBundle[],
  contradictions: readonly VisualMemoryContradictionLink[],
  policy: NormalizedVisualMemoryPolicy,
): readonly MemoryCandidateDraft[] {
  const drafts: MemoryCandidateDraft[] = [];
  for (const bundle of bundles) {
    for (const handoff of bundle.memory_handoff_candidates) {
      drafts.push(draftFromFailureHandoff(consensusReport, bundle, handoff, contradictions, policy));
    }
    drafts.push(draftFromFailureBundle(consensusReport, bundle, contradictions, policy));
  }
  return freezeArray(drafts);
}

function draftFromFailureHandoff(
  consensusReport: MultiViewConsensusReport,
  bundle: FailureVisualEvidenceBundle,
  handoff: VisualMemoryHandoffCandidate,
  contradictions: readonly VisualMemoryContradictionLink[],
  policy: NormalizedVisualMemoryPolicy,
): MemoryCandidateDraft {
  const contradictionRefs = uniqueRefs([...handoff.contradiction_links, ...contradictionRefsFor(undefined, [bundle.failure_visual_bundle_ref], contradictions)]);
  return Object.freeze({
    candidate_ref: makeRef("memory_candidate", "failure_handoff", handoff.memory_candidate_ref),
    evidence_kind: "failure_event",
    source_observation_bundle_ref: consensusReport.bundle_ref,
    source_failure_visual_bundle_ref: bundle.failure_visual_bundle_ref,
    visual_descriptor: sanitizeText(handoff.visual_descriptor),
    spatial_descriptor: spatialDescriptorForFailure(bundle.object_visibility_change, bundle.anomaly_event.target_label),
    source_views: uniqueViews(handoff.source_views),
    base_confidence: clampMemoryConfidence(handoff.confidence, handoff.source_views.length, bundle.object_visibility_change === "occluded", contradictionRefs.length > 0, policy),
    staleness_class: stalenessClassForFailure(bundle.object_visibility_change),
    staleness_hint: sanitizeText(handoff.staleness_hint),
    contradiction_refs: contradictionRefs,
    provenance_summary: `Failure visual bundle ${bundle.failure_visual_bundle_ref}; anomaly ${bundle.anomaly_event_ref}; handoff ${handoff.memory_candidate_ref}.`,
    evidence_limitations: limitationsForFailure(bundle),
    priority: bundle.anomaly_event.severity === "critical" ? 90 : 70,
  });
}

function draftFromFailureBundle(
  consensusReport: MultiViewConsensusReport,
  bundle: FailureVisualEvidenceBundle,
  contradictions: readonly VisualMemoryContradictionLink[],
  policy: NormalizedVisualMemoryPolicy,
): MemoryCandidateDraft {
  const sourceViews = uniqueViews([
    ...bundle.before_views,
    ...bundle.during_views,
    ...bundle.after_views,
    ...bundle.contact_region_crops,
  ].map((item) => item.source_view_name));
  const contradictionRefs = contradictionRefsFor(bundle.anomaly_event.target_label, [bundle.failure_visual_bundle_ref], contradictions);
  return Object.freeze({
    candidate_ref: makeRef("memory_candidate", "failure_bundle", bundle.failure_visual_bundle_ref),
    evidence_kind: "failure_event",
    source_observation_bundle_ref: consensusReport.bundle_ref,
    source_failure_visual_bundle_ref: bundle.failure_visual_bundle_ref,
    label: bundle.anomaly_event.target_label,
    visual_descriptor: sanitizeText(`Failure ${bundle.anomaly_event.category}; visibility=${bundle.object_visibility_change}; hints=${bundle.visual_cause_hints.map((hint) => hint.summary).slice(0, 2).join(" ") || "none"}.`),
    spatial_descriptor: spatialDescriptorForFailure(bundle.object_visibility_change, bundle.anomaly_event.target_label),
    source_views: sourceViews,
    base_confidence: clampMemoryConfidence(bundle.ok ? 0.56 : 0.3, sourceViews.length, bundle.object_visibility_change === "occluded", contradictionRefs.length > 0, policy),
    staleness_class: stalenessClassForFailure(bundle.object_visibility_change),
    staleness_hint: `Failure event memory is ${bundle.object_visibility_change}; reobserve before treating it as current scene state.`,
    contradiction_refs: contradictionRefs,
    provenance_summary: bundle.provenance_summary,
    evidence_limitations: limitationsForFailure(bundle),
    priority: bundle.anomaly_event.severity === "critical" ? 82 : 62,
  });
}

function sceneContextDraft(
  consensusReport: MultiViewConsensusReport,
  verification: VerificationObservationBundle | undefined,
  failures: readonly FailureVisualEvidenceBundle[],
  contradictions: readonly VisualMemoryContradictionLink[],
  policy: NormalizedVisualMemoryPolicy,
): MemoryCandidateDraft | undefined {
  if (consensusReport.consensus_objects.length === 0) return undefined;
  const labels = consensusReport.consensus_objects.slice(0, 6).map((object) => `${object.label}:${object.status}`);
  const sourceViews = uniqueViews(consensusReport.view_inventory.filter((row) => row.status === "included").map((row) => row.canonical_view_name));
  const contradictionRefs = contradictions.filter((link) => link.severity === "blocking").map((link) => link.contradiction_ref);
  return Object.freeze({
    candidate_ref: makeRef("memory_candidate", "scene_context", consensusReport.consensus_ref),
    evidence_kind: "scene_context",
    source_observation_bundle_ref: consensusReport.bundle_ref,
    visual_descriptor: sanitizeText(`Scene context objects=${labels.join(", ")}; pose_readiness=${consensusReport.pose_readiness}; verification=${verification?.decision ?? "none"}; failures=${failures.length}.`),
    source_views: sourceViews,
    base_confidence: clampMemoryConfidence(consensusReport.ok ? 0.52 : 0.28, sourceViews.length, consensusReport.occlusion_report.occlusions.length > 0, contradictionRefs.length > 0, policy),
    staleness_class: "short_lived",
    staleness_hint: "Scene-level context is short-lived and should be replaced by the next current observation bundle.",
    contradiction_refs: freezeArray(contradictionRefs.sort()),
    provenance_summary: `Consensus ${consensusReport.consensus_ref}; bundle ${consensusReport.bundle_ref}.`,
    evidence_limitations: freezeArray([
      `blind_spot_views=${consensusReport.occlusion_report.blind_spot_views.join(",") || "none"}`,
      `view_conflicts=${consensusReport.view_conflicts.length}`,
    ]),
    priority: 36,
  });
}

function selectMemoryRecords(
  drafts: readonly MemoryCandidateDraft[],
  contradictions: readonly VisualMemoryContradictionLink[],
  policy: NormalizedVisualMemoryPolicy,
  issues: ValidationIssue[],
): { readonly records: readonly VisualMemoryEvidence[]; readonly omitted: readonly OmittedVisualMemoryCandidate[] } {
  const records: VisualMemoryEvidence[] = [];
  const omitted: OmittedVisualMemoryCandidate[] = [];
  const seenDescriptors = new Set<string>();
  for (const draft of [...drafts].sort(compareDrafts)) {
    const descriptorKey = normalizeDescriptor(`${draft.evidence_kind}:${draft.label ?? ""}:${draft.visual_descriptor}:${draft.spatial_descriptor ?? ""}`);
    if (seenDescriptors.has(descriptorKey)) {
      omitted.push(omitDraft(draft, "duplicate_low_value", "Duplicate descriptor already represented by a higher-priority visual memory record."));
      continue;
    }
    const hidden = HIDDEN_MEMORY_EVIDENCE_PATTERN.test(JSON.stringify(draft));
    if (hidden) {
      omitted.push(omitDraft(draft, "hidden_source", "Candidate descriptor or provenance included hidden-source wording."));
      continue;
    }
    const hasCurrentView = draft.source_views.length > 0;
    if (policy.require_current_view && !hasCurrentView) {
      issues.push(makeIssue("warning", "CurrentViewMissing", `$.memory_candidates.${draft.candidate_ref}`, "Memory candidate has no current source view.", "Reobserve before writing memory."));
      omitted.push(omitDraft(draft, "missing_current_view", "No current visual source view supports this candidate."));
      continue;
    }
    const hasBlockingContradiction = draft.contradiction_refs.some((ref) => contradictions.some((link) => link.contradiction_ref === ref && link.severity === "blocking"));
    if (hasBlockingContradiction && !policy.allow_conflicted_memory_write) {
      issues.push(makeIssue("warning", "ContradictionUnresolved", `$.memory_candidates.${draft.candidate_ref}.contradiction_refs`, "Candidate has unresolved blocking contradiction links.", "Resolve conflicting view or prior memory evidence before memory write."));
      omitted.push(omitDraft(draft, "overcertain_memory", "Blocking contradiction prevents direct memory write."));
      continue;
    }
    const confidence = roundScore(Math.min(policy.max_memory_confidence, draft.base_confidence));
    if (confidence < policy.min_confidence) {
      omitted.push(omitDraft(draft, "low_confidence", `Confidence ${formatScore(confidence)} is below memory threshold ${formatScore(policy.min_confidence)}.`));
      continue;
    }
    if (draft.base_confidence > confidence) {
      issues.push(makeIssue("warning", "OvercertainMemoryClamped", `$.memory_candidates.${draft.candidate_ref}.confidence`, "Memory confidence was capped to avoid overcertain memory.", "Preserve uncertainty and require current perception before acting."));
    }
    records.push(toMemoryRecord(draft, confidence, hasBlockingContradiction));
    seenDescriptors.add(descriptorKey);
    if (records.length >= policy.max_records) break;
  }
  return Object.freeze({ records: freezeArray(records), omitted: freezeArray(omitted) });
}

function toMemoryRecord(draft: MemoryCandidateDraft, confidence: number, hasBlockingContradiction: boolean): VisualMemoryEvidence {
  const memoryRef = makeRef("visual_memory", draft.evidence_kind, draft.candidate_ref);
  const shell = {
    memoryRef,
    kind: draft.evidence_kind,
    source: draft.source_observation_bundle_ref,
    descriptor: draft.visual_descriptor,
    views: draft.source_views,
    confidence,
    contradictions: draft.contradiction_refs,
  };
  return Object.freeze({
    visual_memory_ref: memoryRef,
    evidence_kind: draft.evidence_kind,
    source_observation_bundle_ref: draft.source_observation_bundle_ref,
    object_hypothesis_ref: draft.object_hypothesis_ref,
    source_consensus_object_ref: draft.source_consensus_object_ref,
    source_verification_bundle_ref: draft.source_verification_bundle_ref,
    source_failure_visual_bundle_ref: draft.source_failure_visual_bundle_ref,
    visual_descriptor: draft.visual_descriptor,
    spatial_descriptor: draft.spatial_descriptor,
    source_views: freezeArray(draft.source_views),
    confidence,
    confidence_band: confidenceBand(confidence),
    staleness_hint: draft.staleness_hint,
    staleness_class: draft.staleness_class,
    contradiction_links: freezeArray([...draft.contradiction_refs].sort()),
    provenance_summary: draft.provenance_summary,
    evidence_limitations: freezeArray(draft.evidence_limitations),
    memory_write_recommended: confidence >= 0.5 && !hasBlockingContradiction,
    determinism_hash: computeDeterminismHash(shell),
  });
}

function buildContradictionIndex(
  consensusReport: MultiViewConsensusReport,
  verification: VerificationObservationBundle | undefined,
  failures: readonly FailureVisualEvidenceBundle[],
  memoryPriors: readonly VisualMemoryPrior[],
): readonly VisualMemoryContradictionLink[] {
  const links: VisualMemoryContradictionLink[] = [];
  for (const conflict of consensusReport.view_conflicts) {
    links.push(linkFromConflict(conflict));
  }
  for (const object of consensusReport.consensus_objects.filter((item) => item.memory_alignment === "conflicts_with_prior")) {
    const matchingPriors = memoryPriors.filter((prior) => labelsMatch(prior.label, object.label));
    for (const prior of matchingPriors) {
      links.push(Object.freeze({
        contradiction_ref: makeRef("memory_prior_contradiction", object.consensus_object_ref, prior.memory_ref),
        contradiction_kind: "memory_prior_conflict",
        source_ref: prior.memory_ref,
        label: object.label,
        severity: "warning",
        summary: `Current visual consensus for ${object.label} conflicts with prior memory ${prior.memory_ref}; current view remains authoritative.`,
      }));
    }
  }
  if (verification !== undefined && (verification.decision !== "ready_for_visual_verification" || verification.occlusion_status === "hidden")) {
    for (const risk of verification.false_positive_risks.filter((item) => !item.resolved)) {
      links.push(Object.freeze({
        contradiction_ref: makeRef("verification_ambiguity", verification.verification_bundle_ref, risk.risk_ref),
        contradiction_kind: "verification_ambiguity",
        source_ref: risk.risk_ref,
        label: risk.target_label,
        severity: risk.severity,
        summary: risk.description,
      }));
    }
  }
  for (const failure of failures) {
    if (failure.object_visibility_change !== "visible" && failure.object_visibility_change !== "unknown") {
      links.push(Object.freeze({
        contradiction_ref: makeRef("failure_state_change", failure.failure_visual_bundle_ref, failure.object_visibility_change),
        contradiction_kind: "failure_state_change",
        source_ref: failure.failure_visual_bundle_ref,
        label: failure.anomaly_event.target_label,
        severity: failure.object_visibility_change === "lost" || failure.object_visibility_change === "dropped" ? "blocking" : "warning",
        summary: `Failure evidence reports object visibility change ${failure.object_visibility_change}; memory must not be treated as current state without reobserve.`,
      }));
    }
  }
  return freezeArray(dedupeContradictions(links));
}

function linkFromConflict(conflict: ViewConflictRecord): VisualMemoryContradictionLink {
  return Object.freeze({
    contradiction_ref: makeRef("view_conflict_memory_link", conflict.conflict_ref),
    contradiction_kind: "view_conflict",
    source_ref: conflict.conflict_ref,
    label: conflict.label,
    severity: conflict.severity,
    summary: conflict.summary,
  });
}

function decideMemorySet(
  records: readonly VisualMemoryEvidence[],
  omitted: readonly OmittedVisualMemoryCandidate[],
  issues: readonly ValidationIssue[],
): VisualMemoryDecision {
  if (issues.some((issue) => issue.severity === "error") || records.length === 0) return "rejected";
  return omitted.length > 0 || issues.length > 0 || records.some((record) => record.contradiction_links.length > 0) ? "memory_ready_with_warnings" : "memory_ready";
}

function chooseRecommendedAction(
  decision: VisualMemoryDecision,
  records: readonly VisualMemoryEvidence[],
  omitted: readonly OmittedVisualMemoryCandidate[],
  contradictions: readonly VisualMemoryContradictionLink[],
  issues: readonly ValidationIssue[],
  consensusReport: MultiViewConsensusReport,
): VisualMemoryRecommendedAction {
  if (issues.some((issue) => issue.code === "HiddenVisualMemoryLeak" && issue.severity === "error") || decision === "rejected") return "discard";
  if (consensusReport.recommended_action === "safe_hold") return "safe_hold";
  if (contradictions.some((link) => link.severity === "blocking") || omitted.some((item) => item.reason === "overcertain_memory")) return "review_contradictions";
  if (omitted.some((item) => item.reason === "missing_current_view") || consensusReport.recommended_action === "reobserve") return "reobserve_before_memory";
  return records.some((record) => record.memory_write_recommended) ? "write_memory_candidates" : "review_contradictions";
}

function objectMemoryConfidence(
  object: ConsensusObject,
  currentViewCount: number,
  contradictionRefs: readonly Ref[],
  policy: NormalizedVisualMemoryPolicy,
): number {
  const base = 0.62 * object.identity_confidence + 0.38 * object.pose_confidence;
  const statusPenalty = object.status === "multi_view_supported"
    ? 0
    : object.status === "single_view_supported"
      ? 0.08
      : object.status === "candidate"
        ? 0.18
        : 0.28;
  const currentPenalty = currentViewCount === 0 ? 0.22 : 0;
  const contradictionPenalty = contradictionRefs.length > 0 ? 0.14 : 0;
  const occluded = object.status === "occluded_or_out_of_view" || object.status === "lost";
  return clampMemoryConfidence(base - statusPenalty - currentPenalty - contradictionPenalty, object.supporting_view_names.length, occluded, contradictionRefs.length > 0, policy);
}

function clampMemoryConfidence(
  value: number,
  sourceViewCount: number,
  occluded: boolean,
  contradicted: boolean,
  policy: NormalizedVisualMemoryPolicy,
): number {
  const caps = [
    policy.max_memory_confidence,
    sourceViewCount <= 1 ? policy.max_single_view_confidence : policy.max_memory_confidence,
    occluded ? policy.max_occluded_confidence : policy.max_memory_confidence,
    contradicted ? Math.min(policy.max_single_view_confidence, 0.56) : policy.max_memory_confidence,
  ];
  return roundScore(Math.min(clamp01(value), ...caps));
}

function confidenceBand(confidence: number): VisualMemoryConfidenceBand {
  if (confidence >= 0.68) return "high";
  if (confidence >= 0.46) return "medium";
  return "low";
}

function spatialDescriptorForObject(object: ConsensusObject): string | undefined {
  const visualRelations = object.spatial_relations
    .filter((relation) => relation.relation_is_visual)
    .sort((a, b) => b.confidence - a.confidence || a.relation_ref.localeCompare(b.relation_ref))
    .slice(0, 4)
    .map((relation) => `${relation.relation}:${relation.target_label}:${formatScore(relation.confidence)}`);
  if (visualRelations.length === 0) return undefined;
  return sanitizeText(visualRelations.join(" | "));
}

function spatialDescriptorForFailure(change: ObjectVisibilityChange, targetLabel: string | undefined): string {
  return sanitizeText(`${targetLabel ?? "target"} visibility_change=${change}; reobserve required before using as current pose.`);
}

function limitationsForObject(
  object: ConsensusObject,
  consensusReport: MultiViewConsensusReport,
  currentViewCount: number,
): readonly string[] {
  const limitations = [
    object.supporting_view_names.length <= 1 ? "single-view memory cannot establish durable identity or pose alone" : undefined,
    currentViewCount === 0 ? "no current packet evidence in object views" : undefined,
    object.missing_expected_views.length > 0 ? `missing_expected_views=${object.missing_expected_views.join(",")}` : undefined,
    object.conflict_refs.length > 0 ? `conflicts=${object.conflict_refs.join(",")}` : undefined,
    consensusReport.occlusion_report.absence_not_proven_labels.some((label) => labelsMatch(label, object.label)) ? "absence_not_proven_under_occlusion" : undefined,
  ].filter(isString);
  return freezeArray(limitations.length === 0 ? ["current visual consensus only; memory is not a substitute for reobserve"] : limitations);
}

function limitationsForVerification(verification: VerificationObservationBundle, sourceViews: readonly CanonicalViewName[]): readonly string[] {
  const limitations = [
    verification.occlusion_status !== "fully_visible" ? `occlusion_status=${verification.occlusion_status}` : undefined,
    verification.decision !== "ready_for_visual_verification" ? `verification_decision=${verification.decision}` : undefined,
    sourceViews.length <= 1 ? "verification memory has limited view diversity" : undefined,
    verification.false_positive_risks.some((risk) => !risk.resolved) ? "unresolved_false_positive_risks_present" : undefined,
  ].filter(isString);
  return freezeArray(limitations.length === 0 ? ["verification memory remains task-state evidence, not permanent truth"] : limitations);
}

function limitationsForFailure(bundle: FailureVisualEvidenceBundle): readonly string[] {
  const limitations = [
    bundle.decision !== "recorded" ? `failure_evidence_decision=${bundle.decision}` : undefined,
    bundle.missing_evidence.length > 0 ? `missing_evidence=${bundle.missing_evidence.length}` : undefined,
    bundle.object_visibility_change !== "visible" ? `visibility_change=${bundle.object_visibility_change}` : undefined,
    bundle.visual_cause_hints.length === 0 ? "no_visual_cause_hints" : undefined,
  ].filter(isString);
  return freezeArray(limitations.length === 0 ? ["failure memory is diagnostic and requires current reobserve before action"] : limitations);
}

function stalenessClassForObject(object: ConsensusObject): VisualMemoryStalenessClass {
  if (object.status === "lost" || object.status === "occluded_or_out_of_view" || object.status === "candidate") return "short_lived";
  if (object.estimated_object_role === "tool_candidate" || object.estimated_object_role === "distractor") return "task_lived";
  if (object.spatial_relations.length > 0) return "task_lived";
  return "session_lived";
}

function stalenessClassForFailure(change: ObjectVisibilityChange): VisualMemoryStalenessClass {
  if (change === "lost" || change === "dropped" || change === "moved" || change === "occluded") return "short_lived";
  return "task_lived";
}

function stalenessHintForObject(
  object: ConsensusObject,
  stalenessClass: VisualMemoryStalenessClass,
  policy: NormalizedVisualMemoryPolicy,
): string {
  if (object.status === "lost") return `${object.label} was lost; use this only to guide search and reobserve immediately.`;
  if (object.status === "occluded_or_out_of_view") return `${object.label} was occluded or out of view; absence is unknown.`;
  if (object.spatial_relations.length > 0) return `${object.label} spatial relation is task-lived and should expire after motion or ${policy.memory_stale_after_s}s.`;
  if (stalenessClass === "session_lived") return `${object.label} descriptor may help session retrieval but current sight must confirm presence.`;
  return `${object.label} memory is short-lived and should be refreshed by the next observation.`;
}

function priorityForObject(object: ConsensusObject, currentViewCount: number): number {
  const roleBoost = object.estimated_object_role === "target" ? 28 : object.estimated_object_role === "tool_candidate" ? 22 : 0;
  const supportBoost = object.status === "multi_view_supported" ? 18 : object.status === "single_view_supported" ? 6 : 0;
  return 40 + roleBoost + supportBoost + Math.round(Math.min(object.identity_confidence, object.pose_confidence) * 16) + Math.min(currentViewCount, 3) * 4;
}

function contradictionRefsFor(
  label: string | undefined,
  sourceRefs: readonly Ref[],
  contradictions: readonly VisualMemoryContradictionLink[],
): readonly Ref[] {
  const normalizedLabel = label === undefined ? undefined : normalizeLabel(label);
  return freezeArray(contradictions
    .filter((link) => sourceRefs.includes(link.source_ref) || (normalizedLabel !== undefined && link.label !== undefined && normalizeLabel(link.label) === normalizedLabel))
    .map((link) => link.contradiction_ref)
    .sort());
}

function dedupeContradictions(links: readonly VisualMemoryContradictionLink[]): readonly VisualMemoryContradictionLink[] {
  const byKey = new Map<string, VisualMemoryContradictionLink>();
  for (const link of links) {
    const key = `${link.contradiction_kind}:${link.source_ref}:${link.label ?? ""}`;
    const existing = byKey.get(key);
    if (existing === undefined || (existing.severity === "warning" && link.severity === "blocking")) {
      byKey.set(key, link);
    }
  }
  return freezeArray([...byKey.values()]);
}

function omitDraft(
  draft: MemoryCandidateDraft,
  reason: VisualMemoryOmissionReason,
  rationale: string,
): OmittedVisualMemoryCandidate {
  return Object.freeze({
    candidate_ref: draft.candidate_ref,
    candidate_kind: draft.evidence_kind,
    label: draft.label,
    reason,
    rationale,
  });
}

function compareDrafts(a: MemoryCandidateDraft, b: MemoryCandidateDraft): number {
  return b.priority - a.priority
    || b.base_confidence - a.base_confidence
    || a.evidence_kind.localeCompare(b.evidence_kind)
    || a.candidate_ref.localeCompare(b.candidate_ref);
}

function compareMemoryRecords(a: VisualMemoryEvidence, b: VisualMemoryEvidence): number {
  return b.confidence - a.confidence
    || a.evidence_kind.localeCompare(b.evidence_kind)
    || a.visual_memory_ref.localeCompare(b.visual_memory_ref);
}

function compareOmittedCandidates(a: OmittedVisualMemoryCandidate, b: OmittedVisualMemoryCandidate): number {
  return a.reason.localeCompare(b.reason)
    || a.candidate_kind.localeCompare(b.candidate_kind)
    || a.candidate_ref.localeCompare(b.candidate_ref);
}

function compareContradictionLinks(a: VisualMemoryContradictionLink, b: VisualMemoryContradictionLink): number {
  return Number(b.severity === "blocking") - Number(a.severity === "blocking")
    || a.contradiction_kind.localeCompare(b.contradiction_kind)
    || a.contradiction_ref.localeCompare(b.contradiction_ref);
}

function labelsMatch(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && normalizeLabel(a) === normalizeLabel(b);
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function normalizeDescriptor(value: string): string {
  return sanitizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function sanitizeText(value: string): string {
  const cleaned = value.trim().replace(/\s+/g, " ").slice(0, 900);
  return HIDDEN_MEMORY_EVIDENCE_PATTERN.test(cleaned) ? "Visual memory text redacted because it contained hidden-source wording." : cleaned;
}

function mergePolicy(base: NormalizedVisualMemoryPolicy, override: VisualMemoryPolicy): NormalizedVisualMemoryPolicy {
  return Object.freeze({
    min_confidence: clamp01(override.min_confidence ?? base.min_confidence),
    max_memory_confidence: clamp01(override.max_memory_confidence ?? base.max_memory_confidence),
    max_single_view_confidence: clamp01(override.max_single_view_confidence ?? base.max_single_view_confidence),
    max_occluded_confidence: clamp01(override.max_occluded_confidence ?? base.max_occluded_confidence),
    memory_stale_after_s: positiveOrDefault(override.memory_stale_after_s, base.memory_stale_after_s),
    require_current_view: override.require_current_view ?? base.require_current_view,
    include_verification_evidence: override.include_verification_evidence ?? base.include_verification_evidence,
    include_failure_evidence: override.include_failure_evidence ?? base.include_failure_evidence,
    allow_conflicted_memory_write: override.allow_conflicted_memory_write ?? base.allow_conflicted_memory_write,
    max_records: positiveIntOrDefault(override.max_records, base.max_records),
    hidden_source_action: override.hidden_source_action ?? base.hidden_source_action,
  });
}

function isDraft(value: MemoryCandidateDraft | undefined): value is MemoryCandidateDraft {
  return value !== undefined;
}

function isString(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

function uniqueViews(values: readonly CanonicalViewName[]): readonly CanonicalViewName[] {
  return freezeArray([...new Set(values)].sort((a, b) => viewSortRank(a) - viewSortRank(b)));
}

function uniqueRefs(values: readonly Ref[]): readonly Ref[] {
  return freezeArray([...new Set(values)].sort());
}

function viewSortRank(viewName: CanonicalViewName): number {
  const ranks: Readonly<Record<CanonicalViewName, number>> = {
    front_primary: 0,
    left_aux: 1,
    right_aux: 2,
    wrist_or_mouth: 3,
    rear_body: 4,
    depth_primary: 5,
    verification_aux: 6,
  };
  return ranks[viewName];
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveIntOrDefault(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.floor(positiveOrDefault(value, fallback)));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function roundScore(value: number): number {
  return Math.round(clamp01(value) * 1000) / 1000;
}

function formatScore(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "") : "invalid";
}

function makeIssue(severity: ValidationSeverity, code: VisualMemoryIssueCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function makeRef(...parts: readonly string[]): Ref {
  const normalized = parts
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "ref:empty";
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}
