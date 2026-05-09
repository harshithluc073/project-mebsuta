/**
 * Cross-view consensus engine for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md`
 * sections 9.3, 9.5.1, 9.6.4, 9.9, 9.10, 9.17, 9.18, 9.19,
 * and 9.20.
 *
 * The engine reconciles File 09 per-view object hypotheses into consensus
 * objects, explicit conflicts, occlusion reports, readiness decisions, and
 * next-view requests. It never treats memory as current truth, never hides
 * missing/degraded views, and refuses backend/debug identifiers before any
 * perception result can feed planning or verification.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import type { CalibrationPromptContext } from "./calibration_context_assembler";
import type { CanonicalViewName } from "./view_name_registry";
import type {
  MemoryAlignmentStatus,
  PerViewObjectHypothesisSet,
  VisualAffordanceHypothesis,
  VisualEvidenceView,
  VisualObjectHypothesis,
  VisualObjectRole,
  VisualSpatialRelation,
} from "./object_hypothesis_service";

export const CROSS_VIEW_CONSENSUS_ENGINE_SCHEMA_VERSION = "mebsuta.cross_view_consensus_engine.v1" as const;

const HIDDEN_CONSENSUS_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|segmentation truth|debug buffer|debug overlay|qa_success|qa_label|qa_only|simulator truth|mesh_name|asset_id)/i;

export type ConsensusObjectStatus = "multi_view_supported" | "single_view_supported" | "candidate" | "occluded_or_out_of_view" | "lost" | "conflicted" | "rejected";
export type ViewConflictKind = "identity_swap" | "descriptor_mismatch" | "missing_in_expected_view" | "memory_conflict" | "pose_conflict" | "desync_risk" | "low_quality_conflict";
export type OcclusionKind = "object_object" | "robot_self" | "tool" | "container_rim" | "table_or_support" | "field_of_view" | "lighting_or_shadow" | "motion" | "unknown";
export type PoseReadiness = "not_ready" | "search_ready" | "planning_ready" | "manipulation_ready" | "verification_ready";
export type ConsensusDecision = "consensus_ready" | "consensus_with_warnings" | "reobserve_required" | "rejected";
export type ConsensusRecommendedAction = "continue" | "reobserve" | "recapture_tight_sync" | "safe_hold" | "human_review";
export type CrossViewConsensusIssueCode =
  | "HypothesisSetMissing"
  | "BundleRefMismatch"
  | "CalibrationBundleMismatch"
  | "NoConsensusObjects"
  | "HiddenConsensusLeak"
  | "IdentityConflict"
  | "DescriptorConflict"
  | "PoseConflict"
  | "MissingExpectedView"
  | "DesynchronizedEvidence"
  | "MemoryConflict"
  | "InsufficientEvidence"
  | "RecommendedNextViewMissing";

/**
 * Fallible visual memory prior. It may support search and continuity, but never
 * upgrades a current observation by itself.
 */
export interface VisualMemoryPrior {
  readonly memory_ref: Ref;
  readonly label: string;
  readonly visual_description?: string;
  readonly expected_role?: VisualObjectRole;
  readonly expected_views?: readonly CanonicalViewName[];
  readonly last_seen_view?: CanonicalViewName;
  readonly confidence: number;
  readonly staleness_s: number;
  readonly location_hint?: string;
}

/**
 * Policy for deterministic consensus and readiness thresholds.
 */
export interface CrossViewConsensusPolicy {
  readonly required_views?: readonly CanonicalViewName[];
  readonly min_identity_confidence_for_consensus?: number;
  readonly min_pose_confidence_for_planning?: number;
  readonly min_pose_confidence_for_manipulation?: number;
  readonly min_pose_confidence_for_verification?: number;
  readonly require_multi_view_for_manipulation?: boolean;
  readonly require_verification_view_for_verification?: boolean;
  readonly desync_blocks_planning?: boolean;
  readonly memory_stale_after_s?: number;
}

/**
 * Prompt-visible inventory row for the consensus report.
 */
export interface ConsensusViewInventoryRecord {
  readonly canonical_view_name: CanonicalViewName;
  readonly status: "included" | "missing" | "degraded" | "stale" | "hypothesis_only" | "calibration_missing";
  readonly packet_ref?: Ref;
  readonly hypothesis_count: number;
  readonly quality_score?: number;
  readonly calibration_ref?: Ref;
  readonly notes: readonly string[];
}

/**
 * Merged object-level consensus from one or more per-view hypotheses.
 */
export interface ConsensusObject {
  readonly consensus_object_ref: Ref;
  readonly label: string;
  readonly status: ConsensusObjectStatus;
  readonly estimated_object_role: VisualObjectRole;
  readonly source_hypothesis_refs: readonly Ref[];
  readonly evidence_views: readonly VisualEvidenceView[];
  readonly supporting_view_names: readonly CanonicalViewName[];
  readonly missing_expected_views: readonly CanonicalViewName[];
  readonly visual_description_summary: string;
  readonly spatial_relations: readonly VisualSpatialRelation[];
  readonly affordance_hypotheses: readonly VisualAffordanceHypothesis[];
  readonly identity_confidence: number;
  readonly pose_confidence: number;
  readonly memory_alignment: MemoryAlignmentStatus;
  readonly memory_prior_refs: readonly Ref[];
  readonly conflict_refs: readonly Ref[];
  readonly determinism_hash: string;
}

/**
 * Explicit disagreement or evidence gap. Empty conflict lists are allowed only
 * after checks have run.
 */
export interface ViewConflictRecord {
  readonly conflict_ref: Ref;
  readonly conflict_kind: ViewConflictKind;
  readonly label: string;
  readonly involved_views: readonly CanonicalViewName[];
  readonly involved_hypothesis_refs: readonly Ref[];
  readonly severity: "warning" | "blocking";
  readonly summary: string;
  readonly recommended_resolution: "reobserve" | "recapture_tight_sync" | "disambiguate_with_side_view" | "downgrade_confidence" | "human_review";
}

/**
 * Occlusion or blind-spot record. Missing/blocked views are represented as
 * unknown, not absence.
 */
export interface ConsensusOcclusionRecord {
  readonly occlusion_ref: Ref;
  readonly occlusion_kind: OcclusionKind;
  readonly affected_label?: string;
  readonly affected_views: readonly CanonicalViewName[];
  readonly confidence: number;
  readonly explanation: string;
  readonly recommended_view?: CanonicalViewName;
}

/**
 * Bundle-level occlusion summary for downstream verification and planning.
 */
export interface ConsensusOcclusionReport {
  readonly occlusions: readonly ConsensusOcclusionRecord[];
  readonly blind_spot_views: readonly CanonicalViewName[];
  readonly absence_not_proven_labels: readonly string[];
  readonly summary: string;
}

/**
 * Next-view or crop recommendation when readiness is below state need.
 */
export interface RecommendedNextView {
  readonly request_ref: Ref;
  readonly reason: string;
  readonly requested_view: CanonicalViewName;
  readonly requested_crop_label?: string;
  readonly priority: number;
  readonly expected_resolution: "identity_disambiguation" | "pose_estimate" | "occlusion_clearance" | "verification_cross_check" | "recapture_sync";
}

/**
 * File 09 `MultiViewConsensusReport` executable shape.
 */
export interface MultiViewConsensusReport {
  readonly schema_version: typeof CROSS_VIEW_CONSENSUS_ENGINE_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md";
  readonly consensus_ref: Ref;
  readonly bundle_ref: Ref;
  readonly view_inventory: readonly ConsensusViewInventoryRecord[];
  readonly consensus_objects: readonly ConsensusObject[];
  readonly view_conflicts: readonly ViewConflictRecord[];
  readonly occlusion_report: ConsensusOcclusionReport;
  readonly pose_readiness: PoseReadiness;
  readonly recommended_next_view?: RecommendedNextView;
  readonly gemini_prompt_packet_ref?: Ref;
  readonly validator_notes: readonly string[];
  readonly decision: ConsensusDecision;
  readonly recommended_action: ConsensusRecommendedAction;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
  readonly cognitive_visibility: "perception_multi_view_consensus_report";
}

interface NormalizedPolicy {
  readonly required_views: readonly CanonicalViewName[];
  readonly min_identity_confidence_for_consensus: number;
  readonly min_pose_confidence_for_planning: number;
  readonly min_pose_confidence_for_manipulation: number;
  readonly min_pose_confidence_for_verification: number;
  readonly require_multi_view_for_manipulation: boolean;
  readonly require_verification_view_for_verification: boolean;
  readonly desync_blocks_planning: boolean;
  readonly memory_stale_after_s: number;
}

interface HypothesisCluster {
  readonly cluster_key: string;
  readonly label: string;
  readonly hypotheses: readonly VisualObjectHypothesis[];
}

const DEFAULT_POLICY: NormalizedPolicy = Object.freeze({
  required_views: freezeArray(["front_primary"] as readonly CanonicalViewName[]),
  min_identity_confidence_for_consensus: 0.48,
  min_pose_confidence_for_planning: 0.45,
  min_pose_confidence_for_manipulation: 0.62,
  min_pose_confidence_for_verification: 0.68,
  require_multi_view_for_manipulation: true,
  require_verification_view_for_verification: true,
  desync_blocks_planning: true,
  memory_stale_after_s: 1_800,
});

/**
 * Executable File 09 `CrossViewConsensusEngine`.
 */
export class CrossViewConsensusEngine {
  private readonly policy: NormalizedPolicy;

  public constructor(policy: CrossViewConsensusPolicy = {}) {
    this.policy = mergePolicy(DEFAULT_POLICY, policy);
  }

  /**
   * Reconciles one or more per-view hypothesis sets into a File 09 consensus
   * report with explicit conflicts, occlusion, readiness, and next-view needs.
   */
  public reconcileMultiViewHypotheses(
    hypothesisSets: readonly PerViewObjectHypothesisSet[],
    calibrationContext: CalibrationPromptContext,
    memoryPriors: readonly VisualMemoryPrior[] = [],
    consensusPolicy: CrossViewConsensusPolicy = {},
    geminiPromptPacketRef?: Ref,
  ): MultiViewConsensusReport {
    const activePolicy = mergePolicy(this.policy, consensusPolicy);
    const issues: ValidationIssue[] = [];
    validateInputs(hypothesisSets, calibrationContext, memoryPriors, activePolicy, issues);

    const bundleRef = resolveBundleRef(hypothesisSets, calibrationContext);
    const inventory = buildViewInventory(hypothesisSets, calibrationContext, activePolicy);
    const clusters = clusterHypotheses(flattenHypotheses(hypothesisSets));
    const conflicts: ViewConflictRecord[] = [];
    const consensusObjects = clusters.map((cluster) => buildConsensusObject(cluster, inventory, memoryPriors, activePolicy, conflicts, issues));
    appendGlobalConflicts(hypothesisSets, consensusObjects, inventory, activePolicy, conflicts, issues);
    const occlusionReport = buildOcclusionReport(consensusObjects, inventory, conflicts);
    const poseReadiness = computePoseReadiness(consensusObjects, conflicts, inventory, hypothesisSets, activePolicy);
    const recommendedNextView = buildRecommendedNextView(poseReadiness, consensusObjects, conflicts, inventory, activePolicy, hypothesisSets);
    if (poseReadiness !== "planning_ready" && poseReadiness !== "manipulation_ready" && poseReadiness !== "verification_ready" && recommendedNextView === undefined) {
      issues.push(makeIssue("warning", "RecommendedNextViewMissing", "$.recommended_next_view", "Consensus readiness is below planning threshold but no next-view request was produced.", "Select a safe embodied view for reobserve or recapture."));
    }
    if (consensusObjects.length === 0) {
      issues.push(makeIssue("error", "NoConsensusObjects", "$.consensus_objects", "No consensus objects could be produced from the hypothesis sets.", "Collect object hypotheses from current visual evidence before consensus."));
    }
    const validatorNotes = buildValidatorNotes(consensusObjects, conflicts, occlusionReport, poseReadiness);
    const decision = decideConsensus(consensusObjects, conflicts, issues, poseReadiness);
    const recommendedAction = chooseRecommendedAction(decision, conflicts, issues, hypothesisSets, recommendedNextView);
    const consensusRef = makeRef("multi_view_consensus", bundleRef, consensusObjects.map((object) => object.consensus_object_ref).join(":"));
    const shell = {
      consensusRef,
      bundleRef,
      objects: consensusObjects.map((object) => [object.consensus_object_ref, object.status, object.identity_confidence, object.pose_confidence]),
      conflicts: conflicts.map((conflict) => [conflict.conflict_ref, conflict.conflict_kind, conflict.severity]),
      readiness: poseReadiness,
      nextView: recommendedNextView?.requested_view,
      issues: issues.map((issue) => issue.code),
    };
    return Object.freeze({
      schema_version: CROSS_VIEW_CONSENSUS_ENGINE_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md",
      consensus_ref: consensusRef,
      bundle_ref: bundleRef,
      view_inventory: freezeArray(inventory),
      consensus_objects: freezeArray(consensusObjects.sort(compareConsensusObjects)),
      view_conflicts: freezeArray(conflicts.sort(compareConflicts)),
      occlusion_report: occlusionReport,
      pose_readiness: poseReadiness,
      recommended_next_view: recommendedNextView,
      gemini_prompt_packet_ref: geminiPromptPacketRef,
      validator_notes: freezeArray(validatorNotes),
      decision,
      recommended_action: recommendedAction,
      issues: freezeArray(issues),
      ok: decision !== "rejected" && issues.every((issue) => issue.severity !== "error"),
      determinism_hash: computeDeterminismHash(shell),
      cognitive_visibility: "perception_multi_view_consensus_report",
    });
  }
}

/**
 * Functional API matching File 09's consensus signature.
 */
export function reconcileMultiViewHypotheses(
  hypothesisSets: readonly PerViewObjectHypothesisSet[],
  calibrationContext: CalibrationPromptContext,
  memoryPriors: readonly VisualMemoryPrior[] = [],
  consensusPolicy: CrossViewConsensusPolicy = {},
  geminiPromptPacketRef?: Ref,
): MultiViewConsensusReport {
  return new CrossViewConsensusEngine(consensusPolicy).reconcileMultiViewHypotheses(hypothesisSets, calibrationContext, memoryPriors, consensusPolicy, geminiPromptPacketRef);
}

function validateInputs(
  hypothesisSets: readonly PerViewObjectHypothesisSet[],
  calibrationContext: CalibrationPromptContext,
  memoryPriors: readonly VisualMemoryPrior[],
  policy: NormalizedPolicy,
  issues: ValidationIssue[],
): void {
  if (hypothesisSets.length === 0) {
    issues.push(makeIssue("error", "HypothesisSetMissing", "$.hypothesis_sets", "Cross-view consensus requires at least one hypothesis set.", "Run ObjectHypothesisService before consensus."));
  }
  const bundleRefs = uniqueSorted(hypothesisSets.map((set) => set.bundle_ref));
  if (bundleRefs.length > 1) {
    issues.push(makeIssue("error", "BundleRefMismatch", "$.hypothesis_sets.bundle_ref", "Hypothesis sets refer to different multi-view bundles.", "Reconcile only hypothesis sets from the same synchronized bundle."));
  }
  if (bundleRefs.length === 1 && calibrationContext.bundle_ref !== bundleRefs[0]) {
    issues.push(makeIssue("warning", "CalibrationBundleMismatch", "$.calibration_context.bundle_ref", "Calibration context bundle differs from hypothesis set bundle.", "Assemble calibration context from the same multi-view bundle before consensus."));
  }
  if (policy.desync_blocks_planning && hypothesisSets.some((set) => set.issues.some((issue) => issue.code.toLowerCase().includes("desync")))) {
    issues.push(makeIssue("warning", "DesynchronizedEvidence", "$.hypothesis_sets.issues", "Hypothesis set reports desynchronized evidence.", "Recapture tight-sync views before planning, manipulation, or verification."));
  }
  const hiddenSurface = JSON.stringify({ hypothesisSets, memoryPriors });
  if (HIDDEN_CONSENSUS_PATTERN.test(hiddenSurface)) {
    issues.push(makeIssue("error", "HiddenConsensusLeak", "$.inputs", "Consensus inputs contain hidden simulator, backend, QA, or debug identifiers.", "Repair upstream perception outputs to sensor-derived evidence only."));
  }
}

function buildViewInventory(
  hypothesisSets: readonly PerViewObjectHypothesisSet[],
  calibrationContext: CalibrationPromptContext,
  policy: NormalizedPolicy,
): readonly ConsensusViewInventoryRecord[] {
  const rows = new Map<CanonicalViewName, ConsensusViewInventoryRecord>();
  for (const set of hypothesisSets) {
    for (const group of set.per_view_hypotheses) {
      const calibration = calibrationContext.view_contexts.find((context) => context.canonical_view_name === group.source_view_name);
      rows.set(group.source_view_name, Object.freeze({
        canonical_view_name: group.source_view_name,
        status: group.view_quality_score !== undefined && group.view_quality_score < 0.45 ? "degraded" : "included",
        packet_ref: group.packet_ref,
        hypothesis_count: group.hypotheses.length,
        quality_score: group.view_quality_score,
        calibration_ref: calibration?.calibration_ref,
        notes: freezeArray(group.omitted_hypothesis_refs.length > 0 ? [`omitted_hypotheses=${group.omitted_hypothesis_refs.join(",")}`] : []),
      }));
    }
  }
  for (const missing of calibrationContext.missing_view_contexts) {
    if (!rows.has(missing.canonical_view_name)) {
      rows.set(missing.canonical_view_name, Object.freeze({
        canonical_view_name: missing.canonical_view_name,
        status: "missing",
        hypothesis_count: 0,
        notes: freezeArray([`calibration_missing_or_view_absent: ${missing.reason}`]),
      }));
    }
  }
  for (const required of policy.required_views) {
    if (!rows.has(required)) {
      rows.set(required, Object.freeze({
        canonical_view_name: required,
        status: "missing",
        hypothesis_count: 0,
        notes: freezeArray(["required view absent from hypothesis inventory"]),
      }));
    }
  }
  return freezeArray([...rows.values()].sort((a, b) => viewSortRank(a.canonical_view_name) - viewSortRank(b.canonical_view_name)));
}

function flattenHypotheses(hypothesisSets: readonly PerViewObjectHypothesisSet[]): readonly VisualObjectHypothesis[] {
  const byRef = new Map<Ref, VisualObjectHypothesis>();
  for (const set of hypothesisSets) {
    for (const hypothesis of set.hypotheses) {
      byRef.set(hypothesis.hypothesis_ref, hypothesis);
    }
  }
  return freezeArray([...byRef.values()].sort(compareHypotheses));
}

function clusterHypotheses(hypotheses: readonly VisualObjectHypothesis[]): readonly HypothesisCluster[] {
  const clusters = new Map<string, VisualObjectHypothesis[]>();
  for (const hypothesis of hypotheses) {
    const key = clusterKeyFor(hypothesis);
    const existing = clusters.get(key);
    if (existing === undefined) {
      clusters.set(key, [hypothesis]);
    } else {
      existing.push(hypothesis);
    }
  }
  return freezeArray([...clusters.entries()]
    .map(([clusterKey, values]) => Object.freeze({
      cluster_key: clusterKey,
      label: values[0]?.label ?? clusterKey,
      hypotheses: freezeArray(values.sort(compareHypotheses)),
    }))
    .sort((a, b) => a.cluster_key.localeCompare(b.cluster_key)));
}

function buildConsensusObject(
  cluster: HypothesisCluster,
  inventory: readonly ConsensusViewInventoryRecord[],
  memoryPriors: readonly VisualMemoryPrior[],
  policy: NormalizedPolicy,
  conflicts: ViewConflictRecord[],
  issues: ValidationIssue[],
): ConsensusObject {
  const hypotheses = cluster.hypotheses;
  const evidenceViews = dedupeEvidence(hypotheses.flatMap((hypothesis) => [...hypothesis.evidence_views]));
  const supportingViews = uniqueSorted(evidenceViews.map((view) => view.source_view_name));
  const expectedViews = expectedViewsForCluster(cluster, memoryPriors, policy);
  const missingExpectedViews = expectedViews.filter((view) => !supportingViews.includes(view));
  const role = chooseRole(hypotheses, memoryPriors);
  const memoryMatches = matchingMemoryPriors(cluster, memoryPriors);
  const memoryAlignment = chooseMemoryAlignment(hypotheses, memoryMatches);
  const identityConfidence = consensusIdentityConfidence(hypotheses, supportingViews, memoryAlignment);
  const poseConfidence = consensusPoseConfidence(hypotheses, supportingViews);
  const status = chooseObjectStatus(hypotheses, supportingViews, missingExpectedViews, identityConfidence, poseConfidence, memoryAlignment, policy);
  const localConflictRefs = appendClusterConflicts(cluster, supportingViews, missingExpectedViews, memoryAlignment, identityConfidence, poseConfidence, conflicts, issues);
  const consensusRef = makeRef("consensus_object", cluster.cluster_key, hypotheses.map((hypothesis) => hypothesis.hypothesis_ref).join(":"));
  const sortedEvidenceViews: readonly VisualEvidenceView[] = freezeArray([...evidenceViews].sort(compareEvidenceViews));
  const shell = {
    consensusRef,
    label: cluster.label,
    status,
    views: supportingViews,
    missing: missingExpectedViews,
    identityConfidence,
    poseConfidence,
    memory: memoryMatches.map((memory) => memory.memory_ref),
    conflicts: localConflictRefs,
  };
  return Object.freeze({
    consensus_object_ref: consensusRef,
    label: cluster.label,
    status,
    estimated_object_role: role,
    source_hypothesis_refs: freezeArray(hypotheses.map((hypothesis) => hypothesis.hypothesis_ref).sort()),
    evidence_views: sortedEvidenceViews,
    supporting_view_names: freezeArray(supportingViews),
    missing_expected_views: freezeArray(missingExpectedViews),
    visual_description_summary: summarizeDescriptions(hypotheses),
    spatial_relations: freezeArray(mergeRelations(hypotheses)),
    affordance_hypotheses: freezeArray(mergeAffordances(hypotheses)),
    identity_confidence: identityConfidence,
    pose_confidence: poseConfidence,
    memory_alignment: memoryAlignment,
    memory_prior_refs: freezeArray(memoryMatches.map((memory) => memory.memory_ref).sort()),
    conflict_refs: freezeArray(localConflictRefs),
    determinism_hash: computeDeterminismHash({ ...shell, inventory: inventory.map((row) => [row.canonical_view_name, row.status]) }),
  });
}

function appendClusterConflicts(
  cluster: HypothesisCluster,
  supportingViews: readonly CanonicalViewName[],
  missingExpectedViews: readonly CanonicalViewName[],
  memoryAlignment: MemoryAlignmentStatus,
  identityConfidence: number,
  poseConfidence: number,
  conflicts: ViewConflictRecord[],
  issues: ValidationIssue[],
): readonly Ref[] {
  const refs: Ref[] = [];
  const descriptions = uniqueSorted(cluster.hypotheses.map((hypothesis) => normalizeDescription(hypothesis.visual_description)));
  if (descriptions.length > 1 && descriptionsDifferMeaningfully(descriptions)) {
    const conflict = makeConflict("descriptor_mismatch", cluster.label, supportingViews, cluster.hypotheses, "warning", "View descriptions differ enough to require disambiguation.", "disambiguate_with_side_view");
    conflicts.push(conflict);
    refs.push(conflict.conflict_ref);
    issues.push(makeIssue("warning", "DescriptorConflict", `$.consensus_objects.${cluster.cluster_key}`, `Descriptions for ${cluster.label} differ across views.`, "Keep identity ambiguity explicit or reobserve from a disambiguating view."));
  }
  if (missingExpectedViews.length > 0) {
    const conflict = makeConflict("missing_in_expected_view", cluster.label, missingExpectedViews, cluster.hypotheses, missingExpectedViews.includes("front_primary") ? "blocking" : "warning", "Object is not supported by all expected current views.", "reobserve");
    conflicts.push(conflict);
    refs.push(conflict.conflict_ref);
    issues.push(makeIssue(missingExpectedViews.includes("front_primary") ? "error" : "warning", "MissingExpectedView", `$.consensus_objects.${cluster.cluster_key}.missing_expected_views`, `${cluster.label} is missing from expected views: ${missingExpectedViews.join(", ")}.`, "Reobserve expected views before treating absence or placement as settled."));
  }
  if (memoryAlignment === "conflicts_with_prior") {
    const conflict = makeConflict("memory_conflict", cluster.label, supportingViews, cluster.hypotheses, "warning", "Current visual evidence conflicts with prior memory.", "downgrade_confidence");
    conflicts.push(conflict);
    refs.push(conflict.conflict_ref);
    issues.push(makeIssue("warning", "MemoryConflict", `$.consensus_objects.${cluster.cluster_key}.memory_alignment`, `${cluster.label} conflicts with retrieved memory prior.`, "Use current views as authoritative and mark memory stale or conflicting."));
  }
  if (identityConfidence < 0.45) {
    const conflict = makeConflict("identity_swap", cluster.label, supportingViews, cluster.hypotheses, "blocking", "Identity confidence is too low for stable object identity.", "disambiguate_with_side_view");
    conflicts.push(conflict);
    refs.push(conflict.conflict_ref);
    issues.push(makeIssue("error", "IdentityConflict", `$.consensus_objects.${cluster.cluster_key}.identity_confidence`, `${cluster.label} identity confidence is below consensus threshold.`, "Request a disambiguating view or crop."));
  }
  if (poseConfidence < 0.35 && supportingViews.length > 0) {
    const conflict = makeConflict("pose_conflict", cluster.label, supportingViews, cluster.hypotheses, "warning", "Pose confidence is too weak for manipulation or verification.", "downgrade_confidence");
    conflicts.push(conflict);
    refs.push(conflict.conflict_ref);
    issues.push(makeIssue("warning", "PoseConflict", `$.consensus_objects.${cluster.cluster_key}.pose_confidence`, `${cluster.label} pose confidence is weak.`, "Use only for search or request depth/side/wrist evidence."));
  }
  return freezeArray(refs);
}

function appendGlobalConflicts(
  hypothesisSets: readonly PerViewObjectHypothesisSet[],
  consensusObjects: readonly ConsensusObject[],
  inventory: readonly ConsensusViewInventoryRecord[],
  policy: NormalizedPolicy,
  conflicts: ViewConflictRecord[],
  issues: ValidationIssue[],
): void {
  if (hypothesisSets.some((set) => set.decision === "rejected")) {
    conflicts.push(makeConflict("low_quality_conflict", "hypothesis_set", [], [], "blocking", "At least one hypothesis set was rejected before consensus.", "human_review"));
    issues.push(makeIssue("error", "InsufficientEvidence", "$.hypothesis_sets.decision", "Rejected hypothesis set cannot support reliable consensus.", "Repair upstream scene response or reobserve."));
  }
  const missingRequired = inventory.filter((row) => policy.required_views.includes(row.canonical_view_name) && row.status === "missing");
  for (const row of missingRequired) {
    conflicts.push(makeConflict("missing_in_expected_view", row.canonical_view_name, [row.canonical_view_name], [], row.canonical_view_name === "front_primary" ? "blocking" : "warning", `Required view ${row.canonical_view_name} is missing from consensus inventory.`, "reobserve"));
  }
  const duplicatedLabels = duplicateLabels(consensusObjects);
  for (const label of duplicatedLabels) {
    conflicts.push(makeConflict("identity_swap", label, [], [], "warning", `Multiple consensus clusters share label ${label}; similar-object identity may be swapped.`, "disambiguate_with_side_view"));
    issues.push(makeIssue("warning", "IdentityConflict", "$.consensus_objects", `Multiple consensus objects share label ${label}.`, "Use visual descriptors, task role, and side/wrist evidence to split identities."));
  }
}

function buildOcclusionReport(
  consensusObjects: readonly ConsensusObject[],
  inventory: readonly ConsensusViewInventoryRecord[],
  conflicts: readonly ViewConflictRecord[],
): ConsensusOcclusionReport {
  const records: ConsensusOcclusionRecord[] = [];
  for (const object of consensusObjects) {
    if (object.missing_expected_views.length > 0 || object.status === "occluded_or_out_of_view" || object.status === "single_view_supported") {
      const kind = inferOcclusionKind(object, conflicts);
      records.push(Object.freeze({
        occlusion_ref: makeRef("occlusion", object.consensus_object_ref, kind),
        occlusion_kind: kind,
        affected_label: object.label,
        affected_views: freezeArray(object.missing_expected_views.length > 0 ? object.missing_expected_views : object.supporting_view_names),
        confidence: object.status === "occluded_or_out_of_view" ? 0.72 : 0.48,
        explanation: `${object.label} has limited support: status=${object.status}; missing_views=${object.missing_expected_views.join(",") || "none"}. Absence is not proven from weak or missing views.`,
        recommended_view: chooseViewFromMissing(object.missing_expected_views),
      }));
    }
  }
  for (const row of inventory.filter((item) => item.status === "missing" || item.status === "degraded" || item.status === "stale")) {
    records.push(Object.freeze({
      occlusion_ref: makeRef("occlusion", "view", row.canonical_view_name, row.status),
      occlusion_kind: row.status === "degraded" ? "lighting_or_shadow" : "field_of_view",
      affected_views: freezeArray([row.canonical_view_name]),
      confidence: row.status === "missing" ? 0.9 : 0.55,
      explanation: `View ${row.canonical_view_name} is ${row.status}; visual absence from this view must remain unknown.`,
      recommended_view: row.canonical_view_name,
    }));
  }
  const blindSpotViews = uniqueSorted(inventory.filter((row) => row.status === "missing" || row.status === "degraded" || row.status === "stale").map((row) => row.canonical_view_name));
  const absenceNotProven = uniqueSorted(consensusObjects.filter((object) => object.status !== "multi_view_supported").map((object) => object.label));
  return Object.freeze({
    occlusions: freezeArray(deduplicateOcclusions(records)),
    blind_spot_views: freezeArray(blindSpotViews),
    absence_not_proven_labels: freezeArray(absenceNotProven),
    summary: `occlusions=${records.length}; blind_spots=${blindSpotViews.join(",") || "none"}; absence_not_proven=${absenceNotProven.join(",") || "none"}`,
  });
}

function computePoseReadiness(
  consensusObjects: readonly ConsensusObject[],
  conflicts: readonly ViewConflictRecord[],
  inventory: readonly ConsensusViewInventoryRecord[],
  hypothesisSets: readonly PerViewObjectHypothesisSet[],
  policy: NormalizedPolicy,
): PoseReadiness {
  if (consensusObjects.length === 0 || conflicts.some((conflict) => conflict.severity === "blocking")) {
    return "not_ready";
  }
  if (policy.desync_blocks_planning && hypothesisSets.some((set) => set.issues.some((issue) => /desync/i.test(issue.code)))) {
    return "search_ready";
  }
  const bestPose = Math.max(...consensusObjects.map((object) => object.pose_confidence));
  const bestIdentity = Math.max(...consensusObjects.map((object) => object.identity_confidence));
  const hasVerificationView = inventory.some((row) => row.canonical_view_name === "verification_aux" && row.status === "included");
  const hasManipulationEvidence = consensusObjects.some((object) => object.supporting_view_names.includes("wrist_or_mouth") && object.supporting_view_names.length >= 2);
  if (policy.require_verification_view_for_verification && hasVerificationView && bestPose >= policy.min_pose_confidence_for_verification && bestIdentity >= policy.min_identity_confidence_for_consensus) {
    return "verification_ready";
  }
  if ((!policy.require_multi_view_for_manipulation || hasManipulationEvidence) && bestPose >= policy.min_pose_confidence_for_manipulation && bestIdentity >= policy.min_identity_confidence_for_consensus) {
    return "manipulation_ready";
  }
  if (bestPose >= policy.min_pose_confidence_for_planning && bestIdentity >= policy.min_identity_confidence_for_consensus) {
    return "planning_ready";
  }
  return consensusObjects.some((object) => object.identity_confidence >= 0.3) ? "search_ready" : "not_ready";
}

function buildRecommendedNextView(
  readiness: PoseReadiness,
  consensusObjects: readonly ConsensusObject[],
  conflicts: readonly ViewConflictRecord[],
  inventory: readonly ConsensusViewInventoryRecord[],
  policy: NormalizedPolicy,
  hypothesisSets: readonly PerViewObjectHypothesisSet[],
): RecommendedNextView | undefined {
  if (readiness === "planning_ready" || readiness === "manipulation_ready" || readiness === "verification_ready") {
    return undefined;
  }
  const blocking = conflicts.find((conflict) => conflict.severity === "blocking");
  const missingRequired = inventory.find((row) => policy.required_views.includes(row.canonical_view_name) && row.status === "missing");
  const desync = hypothesisSets.some((set) => set.issues.some((issue) => /desync/i.test(issue.code)));
  const weakestObject = [...consensusObjects].sort((a, b) => a.pose_confidence + a.identity_confidence - (b.pose_confidence + b.identity_confidence))[0];
  const requestedView = desync
    ? "front_primary"
    : missingRequired?.canonical_view_name
      ?? chooseViewFromMissing(weakestObject?.missing_expected_views ?? [])
      ?? chooseDisambiguatingView(weakestObject?.supporting_view_names ?? []);
  return Object.freeze({
    request_ref: makeRef("next_view", requestedView, weakestObject?.consensus_object_ref ?? blocking?.conflict_ref ?? "scene"),
    reason: desync
      ? "Recapture synchronized primary and supporting views before consensus is trusted."
      : blocking?.summary ?? `Readiness ${readiness}; additional ${requestedView} evidence is needed.`,
    requested_view: requestedView,
    requested_crop_label: weakestObject?.label,
    priority: desync || requestedView === "front_primary" ? 100 : weakestObject === undefined ? 70 : Math.round((1 - Math.min(weakestObject.identity_confidence, weakestObject.pose_confidence)) * 100),
    expected_resolution: desync
      ? "recapture_sync"
      : blocking?.conflict_kind === "identity_swap" || blocking?.conflict_kind === "descriptor_mismatch"
        ? "identity_disambiguation"
        : blocking?.conflict_kind === "pose_conflict"
          ? "pose_estimate"
          : "occlusion_clearance",
  });
}

function buildValidatorNotes(
  consensusObjects: readonly ConsensusObject[],
  conflicts: readonly ViewConflictRecord[],
  occlusionReport: ConsensusOcclusionReport,
  readiness: PoseReadiness,
): readonly string[] {
  const notes = [
    `pose_readiness=${readiness}`,
    `consensus_objects=${consensusObjects.length}`,
    `blocking_conflicts=${conflicts.filter((conflict) => conflict.severity === "blocking").length}`,
    `blind_spot_views=${occlusionReport.blind_spot_views.join(",") || "none"}`,
  ];
  for (const object of consensusObjects.filter((item) => item.status !== "multi_view_supported")) {
    notes.push(`${object.label}: status=${object.status}; identity=${formatScore(object.identity_confidence)}; pose=${formatScore(object.pose_confidence)}`);
  }
  return freezeArray(notes);
}

function decideConsensus(
  consensusObjects: readonly ConsensusObject[],
  conflicts: readonly ViewConflictRecord[],
  issues: readonly ValidationIssue[],
  readiness: PoseReadiness,
): ConsensusDecision {
  if (issues.some((issue) => issue.severity === "error") || consensusObjects.length === 0) {
    return "rejected";
  }
  if (readiness === "not_ready" || readiness === "search_ready" || conflicts.some((conflict) => conflict.severity === "blocking")) {
    return "reobserve_required";
  }
  return conflicts.length > 0 || issues.length > 0 ? "consensus_with_warnings" : "consensus_ready";
}

function chooseRecommendedAction(
  decision: ConsensusDecision,
  conflicts: readonly ViewConflictRecord[],
  issues: readonly ValidationIssue[],
  hypothesisSets: readonly PerViewObjectHypothesisSet[],
  nextView: RecommendedNextView | undefined,
): ConsensusRecommendedAction {
  if (hypothesisSets.some((set) => set.recommended_action === "safe_hold")) {
    return "safe_hold";
  }
  if (hypothesisSets.some((set) => set.issues.some((issue) => /desync/i.test(issue.code))) || nextView?.expected_resolution === "recapture_sync") {
    return "recapture_tight_sync";
  }
  if (decision === "reobserve_required" || nextView !== undefined) {
    return "reobserve";
  }
  if (issues.some((issue) => issue.severity === "error") || conflicts.some((conflict) => conflict.recommended_resolution === "human_review")) {
    return "human_review";
  }
  return "continue";
}

function expectedViewsForCluster(
  cluster: HypothesisCluster,
  memoryPriors: readonly VisualMemoryPrior[],
  policy: NormalizedPolicy,
): readonly CanonicalViewName[] {
  const expected = new Set<CanonicalViewName>(policy.required_views);
  for (const hypothesis of cluster.hypotheses) {
    for (const view of hypothesis.evidence_views) {
      expected.add(view.source_view_name);
    }
    if (hypothesis.estimated_object_role === "target" || hypothesis.estimated_object_role === "tool_candidate") {
      expected.add("front_primary");
    }
    if (hypothesis.estimated_object_role === "target" && cluster.hypotheses.some((item) => item.affordance_hypotheses.length > 0)) {
      expected.add("wrist_or_mouth");
    }
  }
  for (const memory of matchingMemoryPriors(cluster, memoryPriors)) {
    for (const view of memory.expected_views ?? []) {
      expected.add(view);
    }
    if (memory.last_seen_view !== undefined) {
      expected.add(memory.last_seen_view);
    }
  }
  return freezeArray([...expected].sort((a, b) => viewSortRank(a) - viewSortRank(b)));
}

function matchingMemoryPriors(cluster: HypothesisCluster, memoryPriors: readonly VisualMemoryPrior[]): readonly VisualMemoryPrior[] {
  const key = normalizeLabel(cluster.label);
  return freezeArray(memoryPriors.filter((memory) => normalizeLabel(memory.label) === key).sort((a, b) => b.confidence - a.confidence || a.staleness_s - b.staleness_s));
}

function chooseRole(hypotheses: readonly VisualObjectHypothesis[], memoryPriors: readonly VisualMemoryPrior[]): VisualObjectRole {
  const roles = hypotheses.map((hypothesis) => hypothesis.estimated_object_role).filter((role) => role !== "unknown");
  if (roles.length > 0) {
    return mostCommon(roles) ?? "unknown";
  }
  const memoryRole = memoryPriors.find((memory) => memory.expected_role !== undefined)?.expected_role;
  return memoryRole ?? "unknown";
}

function chooseMemoryAlignment(hypotheses: readonly VisualObjectHypothesis[], memoryMatches: readonly VisualMemoryPrior[]): MemoryAlignmentStatus {
  if (hypotheses.some((hypothesis) => hypothesis.memory_alignment === "conflicts_with_prior")) {
    return "conflicts_with_prior";
  }
  if (hypotheses.some((hypothesis) => hypothesis.memory_alignment === "matches_prior")) {
    return "matches_prior";
  }
  if (memoryMatches.length > 0) {
    return "unknown";
  }
  return "not_provided";
}

function consensusIdentityConfidence(hypotheses: readonly VisualObjectHypothesis[], supportingViews: readonly CanonicalViewName[], memoryAlignment: MemoryAlignmentStatus): number {
  const base = weightedMean(hypotheses.map((hypothesis) => hypothesis.identity_confidence), hypotheses.map((hypothesis) => hypothesis.evidence_views.length + 1));
  const viewBonus = supportingViews.length >= 2 ? 0.12 : supportingViews.length === 1 ? 0 : -0.18;
  const memoryPenalty = memoryAlignment === "conflicts_with_prior" ? -0.16 : 0;
  return roundScore(base + viewBonus + memoryPenalty);
}

function consensusPoseConfidence(hypotheses: readonly VisualObjectHypothesis[], supportingViews: readonly CanonicalViewName[]): number {
  const base = weightedMean(hypotheses.map((hypothesis) => hypothesis.pose_confidence), hypotheses.map((hypothesis) => hypothesis.evidence_views.length + 1));
  const viewBonus = supportingViews.length >= 2 ? 0.14 : supportingViews.length === 1 ? -0.12 : -0.28;
  const depthOrWristBonus = supportingViews.includes("depth_primary") || supportingViews.includes("wrist_or_mouth") ? 0.08 : 0;
  return roundScore(base + viewBonus + depthOrWristBonus);
}

function chooseObjectStatus(
  hypotheses: readonly VisualObjectHypothesis[],
  supportingViews: readonly CanonicalViewName[],
  missingExpectedViews: readonly CanonicalViewName[],
  identityConfidence: number,
  poseConfidence: number,
  memoryAlignment: MemoryAlignmentStatus,
  policy: NormalizedPolicy,
): ConsensusObjectStatus {
  if (hypotheses.every((hypothesis) => hypothesis.tracking_status === "rejected")) {
    return "rejected";
  }
  if (memoryAlignment === "conflicts_with_prior" && supportingViews.length === 0) {
    return "lost";
  }
  if (supportingViews.length === 0) {
    return "occluded_or_out_of_view";
  }
  if (identityConfidence < policy.min_identity_confidence_for_consensus) {
    return "conflicted";
  }
  if (supportingViews.length >= 2 && poseConfidence >= policy.min_pose_confidence_for_planning && missingExpectedViews.length === 0) {
    return "multi_view_supported";
  }
  if (supportingViews.length === 1) {
    return "single_view_supported";
  }
  return "candidate";
}

function clusterKeyFor(hypothesis: VisualObjectHypothesis): string {
  const roleKey = hypothesis.estimated_object_role === "unknown" ? "" : `:${hypothesis.estimated_object_role}`;
  return `${normalizeLabel(hypothesis.label)}${roleKey}`;
}

function summarizeDescriptions(hypotheses: readonly VisualObjectHypothesis[]): string {
  const descriptions = uniqueSorted(hypotheses.map((hypothesis) => hypothesis.visual_description));
  if (descriptions.length <= 2) {
    return descriptions.join(" | ");
  }
  return `${descriptions.slice(0, 2).join(" | ")} | additional_descriptions=${descriptions.length - 2}`;
}

function mergeRelations(hypotheses: readonly VisualObjectHypothesis[]): readonly VisualSpatialRelation[] {
  const byKey = new Map<string, VisualSpatialRelation>();
  for (const relation of hypotheses.flatMap((hypothesis) => [...hypothesis.spatial_relations])) {
    const key = `${relation.relation}:${normalizeLabel(relation.target_label)}:${relation.evidence_views.join(",")}`;
    const existing = byKey.get(key);
    if (existing === undefined || relation.confidence > existing.confidence) {
      byKey.set(key, relation);
    }
  }
  return freezeArray([...byKey.values()].sort((a, b) => a.relation_ref.localeCompare(b.relation_ref)));
}

function mergeAffordances(hypotheses: readonly VisualObjectHypothesis[]): readonly VisualAffordanceHypothesis[] {
  const byKey = new Map<string, VisualAffordanceHypothesis>();
  for (const affordance of hypotheses.flatMap((hypothesis) => [...hypothesis.affordance_hypotheses])) {
    const key = `${affordance.affordance}:${affordance.evidence_views.join(",")}`;
    const existing = byKey.get(key);
    if (existing === undefined || affordance.confidence > existing.confidence) {
      byKey.set(key, affordance);
    }
  }
  return freezeArray([...byKey.values()].sort((a, b) => a.affordance_ref.localeCompare(b.affordance_ref)));
}

function makeConflict(
  kind: ViewConflictKind,
  label: string,
  involvedViews: readonly CanonicalViewName[],
  hypotheses: readonly VisualObjectHypothesis[],
  severity: ViewConflictRecord["severity"],
  summary: string,
  resolution: ViewConflictRecord["recommended_resolution"],
): ViewConflictRecord {
  const refs = hypotheses.map((hypothesis) => hypothesis.hypothesis_ref).sort();
  return Object.freeze({
    conflict_ref: makeRef("view_conflict", kind, label, involvedViews.join("_"), refs.join("_")),
    conflict_kind: kind,
    label,
    involved_views: freezeArray(uniqueSorted(involvedViews)),
    involved_hypothesis_refs: freezeArray(refs),
    severity,
    summary,
    recommended_resolution: resolution,
  });
}

function inferOcclusionKind(object: ConsensusObject, conflicts: readonly ViewConflictRecord[]): OcclusionKind {
  const text = `${object.visual_description_summary} ${object.spatial_relations.map((relation) => relation.summary).join(" ")} ${conflicts.map((conflict) => conflict.summary).join(" ")}`.toLowerCase();
  if (/tool/.test(text)) return "tool";
  if (/gripper|mouth|limb|body|self/.test(text)) return "robot_self";
  if (/container|rim|bowl|box/.test(text)) return "container_rim";
  if (/table|support|under|behind/.test(text)) return "table_or_support";
  if (/shadow|glare|light/.test(text)) return "lighting_or_shadow";
  if (/motion|blur|moving/.test(text)) return "motion";
  if (/occlud|block/.test(text)) return "object_object";
  return "field_of_view";
}

function chooseViewFromMissing(missingViews: readonly CanonicalViewName[]): CanonicalViewName | undefined {
  for (const preferred of canonicalViewOrder()) {
    if (missingViews.includes(preferred)) {
      return preferred;
    }
  }
  return undefined;
}

function chooseDisambiguatingView(currentViews: readonly CanonicalViewName[]): CanonicalViewName {
  if (!currentViews.includes("front_primary")) return "front_primary";
  if (!currentViews.includes("left_aux")) return "left_aux";
  if (!currentViews.includes("right_aux")) return "right_aux";
  if (!currentViews.includes("wrist_or_mouth")) return "wrist_or_mouth";
  return "verification_aux";
}

function resolveBundleRef(hypothesisSets: readonly PerViewObjectHypothesisSet[], calibrationContext: CalibrationPromptContext): Ref {
  return hypothesisSets[0]?.bundle_ref ?? calibrationContext.bundle_ref;
}

function duplicateLabels(objects: readonly ConsensusObject[]): readonly string[] {
  const counts = new Map<string, number>();
  for (const object of objects) {
    const key = normalizeLabel(object.label);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return freezeArray([...counts.entries()].filter(([, count]) => count > 1).map(([label]) => label).sort());
}

function dedupeEvidence(views: readonly VisualEvidenceView[]): readonly VisualEvidenceView[] {
  const byKey = new Map<string, VisualEvidenceView>();
  for (const view of views) {
    byKey.set(`${view.source_view_name}:${view.source_camera_packet_ref}:${view.crop_ref ?? ""}`, view);
  }
  return freezeArray([...byKey.values()]);
}

function deduplicateOcclusions(records: readonly ConsensusOcclusionRecord[]): readonly ConsensusOcclusionRecord[] {
  const byKey = new Map<string, ConsensusOcclusionRecord>();
  for (const record of records) {
    byKey.set(`${record.occlusion_kind}:${record.affected_label ?? ""}:${record.affected_views.join(",")}`, record);
  }
  return freezeArray([...byKey.values()].sort((a, b) => a.occlusion_ref.localeCompare(b.occlusion_ref)));
}

function compareConsensusObjects(a: ConsensusObject, b: ConsensusObject): number {
  return b.identity_confidence - a.identity_confidence
    || b.pose_confidence - a.pose_confidence
    || a.label.localeCompare(b.label)
    || a.consensus_object_ref.localeCompare(b.consensus_object_ref);
}

function compareConflicts(a: ViewConflictRecord, b: ViewConflictRecord): number {
  return Number(b.severity === "blocking") - Number(a.severity === "blocking")
    || a.conflict_kind.localeCompare(b.conflict_kind)
    || a.conflict_ref.localeCompare(b.conflict_ref);
}

function compareHypotheses(a: VisualObjectHypothesis, b: VisualObjectHypothesis): number {
  return b.identity_confidence - a.identity_confidence
    || b.pose_confidence - a.pose_confidence
    || a.hypothesis_ref.localeCompare(b.hypothesis_ref);
}

function compareEvidenceViews(a: VisualEvidenceView, b: VisualEvidenceView): number {
  return viewSortRank(a.source_view_name) - viewSortRank(b.source_view_name)
    || a.source_camera_packet_ref.localeCompare(b.source_camera_packet_ref)
    || (a.crop_ref ?? "").localeCompare(b.crop_ref ?? "");
}

function descriptionsDifferMeaningfully(descriptions: readonly string[]): boolean {
  if (descriptions.length <= 1) return false;
  const tokenSets = descriptions.map((description) => new Set(description.split("_").filter((token) => token.length > 2)));
  for (let i = 0; i < tokenSets.length; i += 1) {
    for (let j = i + 1; j < tokenSets.length; j += 1) {
      const a = tokenSets[i];
      const b = tokenSets[j];
      if (a === undefined || b === undefined) continue;
      const intersection = [...a].filter((token) => b.has(token)).length;
      const union = new Set([...a, ...b]).size;
      if (union > 0 && intersection / union < 0.38) {
        return true;
      }
    }
  }
  return false;
}

function normalizeDescription(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function normalizeLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function weightedMean(values: readonly number[], weights: readonly number[]): number {
  if (values.length === 0) return 0;
  let weighted = 0;
  let totalWeight = 0;
  for (const [index, value] of values.entries()) {
    const weight = Math.max(0.001, weights[index] ?? 1);
    weighted += clamp01(value) * weight;
    totalWeight += weight;
  }
  return totalWeight <= 0 ? 0 : weighted / totalWeight;
}

function mostCommon<T extends string>(values: readonly T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

function mergePolicy(base: NormalizedPolicy, override: CrossViewConsensusPolicy): NormalizedPolicy {
  return Object.freeze({
    required_views: freezeArray(override.required_views ?? base.required_views),
    min_identity_confidence_for_consensus: clamp01(override.min_identity_confidence_for_consensus ?? base.min_identity_confidence_for_consensus),
    min_pose_confidence_for_planning: clamp01(override.min_pose_confidence_for_planning ?? base.min_pose_confidence_for_planning),
    min_pose_confidence_for_manipulation: clamp01(override.min_pose_confidence_for_manipulation ?? base.min_pose_confidence_for_manipulation),
    min_pose_confidence_for_verification: clamp01(override.min_pose_confidence_for_verification ?? base.min_pose_confidence_for_verification),
    require_multi_view_for_manipulation: override.require_multi_view_for_manipulation ?? base.require_multi_view_for_manipulation,
    require_verification_view_for_verification: override.require_verification_view_for_verification ?? base.require_verification_view_for_verification,
    desync_blocks_planning: override.desync_blocks_planning ?? base.desync_blocks_planning,
    memory_stale_after_s: positiveOrDefault(override.memory_stale_after_s, base.memory_stale_after_s),
  });
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function canonicalViewOrder(): readonly CanonicalViewName[] {
  return freezeArray(["front_primary", "left_aux", "right_aux", "wrist_or_mouth", "rear_body", "depth_primary", "verification_aux"] as const);
}

function viewSortRank(viewName: CanonicalViewName): number {
  return canonicalViewOrder().indexOf(viewName);
}

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return freezeArray([...new Set(values)].sort());
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

function makeIssue(severity: ValidationSeverity, code: CrossViewConsensusIssueCode, path: string, message: string, remediation: string): ValidationIssue {
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
