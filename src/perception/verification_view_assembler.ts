/**
 * Verification view assembler for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md`
 * sections 9.3.1, 9.5.1, 9.6.7, 9.13, 9.17, 9.18.3, 9.20,
 * and 9.21.
 *
 * The assembler packages synchronized final-state views for visual success
 * checks. It selects constraint-specific required views, keeps missing and
 * degraded evidence visible, rejects hidden backend truth, and marks
 * false-positive risks before the Gemini visual verifier or geometry layer can
 * evaluate task success.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import type { CalibrationPromptContext } from "./calibration_context_assembler";
import type { ConsensusObject, MultiViewConsensusReport, ViewConflictRecord } from "./cross_view_consensus_engine";
import type { MultiViewObservationBundle, PerceptionTaskPhase, SynchronizedViewPacket } from "./multi_view_synchronizer";
import type { OcclusionReport, ReasonedOcclusionRecord } from "./occlusion_reasoner";
import type { CanonicalViewName } from "./view_name_registry";
import type { ViewQualityReport, ViewQualityReportSet, TargetVisibility } from "./view_quality_assessor";
import type { SpatialReadinessLevel, VisualSpatialEstimate, VisualSpatialEstimateSet } from "./visual_spatial_estimator";

export const VERIFICATION_VIEW_ASSEMBLER_SCHEMA_VERSION = "mebsuta.verification_view_assembler.v1" as const;

const HIDDEN_VERIFICATION_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|segmentation truth|debug buffer|debug overlay|qa_success|qa_label|qa_only|simulator truth|mesh_name|asset_id)/i;

export type VerificationConstraintType =
  | "exact_position_tolerance"
  | "orientation_tolerance"
  | "on_top_relation"
  | "inside_container"
  | "adjacent_left_right_relation"
  | "stacked_relation"
  | "tool_effect_verification";

export type VerificationBundleDecision =
  | "ready_for_visual_verification"
  | "ambiguous_reobserve_required"
  | "recapture_required"
  | "rejected";

export type VerificationRecommendedAction = "continue" | "reobserve" | "recapture_tight_sync" | "safe_hold" | "human_review";
export type VerificationEvidenceStatus = "selected" | "missing" | "degraded" | "occluded" | "inventory_only";
export type VerificationOcclusionStatus = "fully_visible" | "partial" | "hidden" | "unknown";

export type FalsePositiveRiskKind =
  | "container_rim_confusion"
  | "shadow_boundary_confusion"
  | "similar_object_swap"
  | "gripper_or_tool_occlusion"
  | "desynchronized_views"
  | "temporary_instability"
  | "single_occluded_view"
  | "hidden_relation"
  | "missing_reference_region";

export type VerificationViewAssemblerIssueCode =
  | "BundleConsensusMismatch"
  | "BundleQualityMismatch"
  | "BundleSpatialMismatch"
  | "BundleOcclusionMismatch"
  | "BundleCalibrationMismatch"
  | "HiddenVerificationInputLeak"
  | "NoTaskConstraints"
  | "CriticalViewMissing"
  | "SelectedViewLowQuality"
  | "TargetOccluded"
  | "TargetRelationHidden"
  | "DesynchronizedVerificationViews"
  | "SpatialEstimateNotReady"
  | "FalsePositiveRiskBlocking";

/**
 * Task-side visual verification constraint. These are goal constraints, not
 * simulator facts, and each row is traceable to a task or validator goal ref.
 */
export interface VerificationTaskConstraint {
  readonly constraint_ref: Ref;
  readonly constraint_type: VerificationConstraintType;
  readonly target_label: string;
  readonly reference_label?: string;
  readonly required_relation?: string;
  readonly tolerance_summary?: string;
  readonly requires_settle_check?: boolean;
  readonly requires_release_visible?: boolean;
  readonly critical?: boolean;
}

/**
 * Runtime policy for selecting final-state views and gating ambiguity.
 */
export interface VerificationPolicy {
  readonly required_views?: readonly CanonicalViewName[];
  readonly min_quality_score?: number;
  readonly min_spatial_confidence?: number;
  readonly require_alternate_view_for_occlusion_risk?: boolean;
  readonly require_tight_sync?: boolean;
  readonly max_selected_views?: number;
  readonly include_inventory_only_views?: boolean;
  readonly require_depth_for_container?: boolean;
}

/**
 * Prompt-visible evidence view selected or preserved for verification.
 */
export interface VerificationEvidenceView {
  readonly evidence_ref: Ref;
  readonly source_view_name: CanonicalViewName;
  readonly source_camera_packet_ref?: Ref;
  readonly image_ref?: Ref;
  readonly depth_ref?: Ref;
  readonly status: VerificationEvidenceStatus;
  readonly quality_score?: number;
  readonly target_visibility?: TargetVisibility;
  readonly occlusion_status: VerificationOcclusionStatus;
  readonly selected_rationale: string;
  readonly supports_constraint_refs: readonly Ref[];
  readonly visible_relations: readonly string[];
  readonly occlusion_notes: readonly string[];
  readonly calibration_ref?: Ref;
  readonly timestamp_midpoint_s?: number;
  readonly determinism_hash: string;
}

/**
 * Required false-positive guard surfaced before visual success may be claimed.
 */
export interface VerificationFalsePositiveRisk {
  readonly risk_ref: Ref;
  readonly risk_kind: FalsePositiveRiskKind;
  readonly constraint_ref?: Ref;
  readonly target_label?: string;
  readonly source_views: readonly CanonicalViewName[];
  readonly severity: "warning" | "blocking";
  readonly description: string;
  readonly required_prevention: string;
  readonly resolved: boolean;
}

/**
 * Verification readiness event emitted by the assembler for orchestration.
 */
export interface VerificationReadinessEvent {
  readonly event_ref: Ref;
  readonly bundle_ref: Ref;
  readonly decision: VerificationBundleDecision;
  readonly recommended_action: VerificationRecommendedAction;
  readonly critical_views_missing: readonly CanonicalViewName[];
  readonly blocking_risks: readonly Ref[];
  readonly ready_constraint_refs: readonly Ref[];
  readonly ambiguous_constraint_refs: readonly Ref[];
  readonly summary: string;
}

/**
 * Constraint-to-view requirement row retained in the verification bundle.
 */
export interface VerificationRequiredViewRecord {
  readonly constraint_ref: Ref;
  readonly constraint_type: VerificationConstraintType;
  readonly required_views: readonly CanonicalViewName[];
  readonly minimum_visual_evidence: string;
  readonly ambiguity_trigger: string;
}

/**
 * File 09 executable verification view bundle.
 */
export interface VerificationObservationBundle {
  readonly schema_version: typeof VERIFICATION_VIEW_ASSEMBLER_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md";
  readonly verification_bundle_ref: Ref;
  readonly source_bundle_ref: Ref;
  readonly consensus_ref: Ref;
  readonly spatial_estimate_set_ref?: Ref;
  readonly task_phase: PerceptionTaskPhase;
  readonly target_constraint_refs: readonly Ref[];
  readonly constraints: readonly VerificationTaskConstraint[];
  readonly required_views: readonly VerificationRequiredViewRecord[];
  readonly provided_views: readonly VerificationEvidenceView[];
  readonly inventory_views: readonly VerificationEvidenceView[];
  readonly visual_relation_observations: readonly VerificationRelationObservation[];
  readonly occlusion_status: VerificationOcclusionStatus;
  readonly residual_hints: readonly VerificationResidualHint[];
  readonly spatial_estimate_refs: readonly Ref[];
  readonly false_positive_risks: readonly VerificationFalsePositiveRisk[];
  readonly readiness_event: VerificationReadinessEvent;
  readonly issues: readonly ValidationIssue[];
  readonly decision: VerificationBundleDecision;
  readonly recommended_action: VerificationRecommendedAction;
  readonly ok: boolean;
  readonly determinism_hash: string;
  readonly cognitive_visibility: "perception_verification_observation_bundle";
}

/**
 * Relation observation grounded in selected views and consensus objects.
 */
export interface VerificationRelationObservation {
  readonly observation_ref: Ref;
  readonly constraint_ref: Ref;
  readonly target_label: string;
  readonly relation: string;
  readonly reference_label?: string;
  readonly evidence_views: readonly CanonicalViewName[];
  readonly confidence: number;
  readonly observation_summary: string;
}

/**
 * Qualitative spatial hint for the downstream geometry verifier.
 */
export interface VerificationResidualHint {
  readonly hint_ref: Ref;
  readonly constraint_ref: Ref;
  readonly target_label: string;
  readonly source_estimate_ref?: Ref;
  readonly readiness: SpatialReadinessLevel | "missing";
  readonly confidence: number;
  readonly hint_summary: string;
}

interface NormalizedVerificationPolicy {
  readonly required_views: readonly CanonicalViewName[];
  readonly min_quality_score: number;
  readonly min_spatial_confidence: number;
  readonly require_alternate_view_for_occlusion_risk: boolean;
  readonly require_tight_sync: boolean;
  readonly max_selected_views: number;
  readonly include_inventory_only_views: boolean;
  readonly require_depth_for_container: boolean;
}

interface ConstraintViewProfile {
  readonly minimum_visual_evidence: string;
  readonly preferred_views: readonly CanonicalViewName[];
  readonly ambiguity_trigger: string;
}

const DEFAULT_POLICY: NormalizedVerificationPolicy = Object.freeze({
  required_views: freezeArray(["front_primary"] as readonly CanonicalViewName[]),
  min_quality_score: 0.55,
  min_spatial_confidence: 0.58,
  require_alternate_view_for_occlusion_risk: true,
  require_tight_sync: true,
  max_selected_views: 4,
  include_inventory_only_views: true,
  require_depth_for_container: false,
});

const CONSTRAINT_VIEW_PROFILES: Readonly<Record<VerificationConstraintType, ConstraintViewProfile>> = Object.freeze({
  exact_position_tolerance: Object.freeze({
    minimum_visual_evidence: "Target object and reference region visible.",
    preferred_views: freezeArray(["front_primary", "left_aux", "right_aux", "depth_primary"] as readonly CanonicalViewName[]),
    ambiguity_trigger: "Object edge hidden or reference obscured.",
  }),
  orientation_tolerance: Object.freeze({
    minimum_visual_evidence: "Orientation cues visible.",
    preferred_views: freezeArray(["front_primary", "left_aux", "right_aux", "wrist_or_mouth"] as readonly CanonicalViewName[]),
    ambiguity_trigger: "Symmetric object or hidden orientation marker.",
  }),
  on_top_relation: Object.freeze({
    minimum_visual_evidence: "Object and support contact region visible.",
    preferred_views: freezeArray(["left_aux", "right_aux", "front_primary"] as readonly CanonicalViewName[]),
    ambiguity_trigger: "Contact hidden by object or support edge.",
  }),
  inside_container: Object.freeze({
    minimum_visual_evidence: "Object and container boundary visible.",
    preferred_views: freezeArray(["wrist_or_mouth", "left_aux", "right_aux", "front_primary", "depth_primary"] as readonly CanonicalViewName[]),
    ambiguity_trigger: "Rim hides object bottom or object rests on rim.",
  }),
  adjacent_left_right_relation: Object.freeze({
    minimum_visual_evidence: "Both objects and reference frame visible.",
    preferred_views: freezeArray(["front_primary", "left_aux", "right_aux"] as readonly CanonicalViewName[]),
    ambiguity_trigger: "One object occluded or similar identity conflict.",
  }),
  stacked_relation: Object.freeze({
    minimum_visual_evidence: "Stack vertical ordering and stability visible.",
    preferred_views: freezeArray(["left_aux", "right_aux", "front_primary"] as readonly CanonicalViewName[]),
    ambiguity_trigger: "Top object hidden or shadow mimics contact.",
  }),
  tool_effect_verification: Object.freeze({
    minimum_visual_evidence: "Target before or after state and tool contact path visible.",
    preferred_views: freezeArray(["wrist_or_mouth", "left_aux", "right_aux", "front_primary", "verification_aux"] as readonly CanonicalViewName[]),
    ambiguity_trigger: "Tool blocks target or post-action target not visible.",
  }),
});

/**
 * Executable File 09 `VerificationViewAssembler`.
 */
export class VerificationViewAssembler {
  private readonly policy: NormalizedVerificationPolicy;

  public constructor(policy: VerificationPolicy = {}) {
    this.policy = mergePolicy(DEFAULT_POLICY, policy);
  }

  /**
   * Assembles final-state visual evidence for success-sensitive verification.
   */
  public assembleVerificationViewBundle(
    taskConstraints: readonly VerificationTaskConstraint[],
    cameraPackets: MultiViewObservationBundle,
    consensusReport: MultiViewConsensusReport,
    qualityReports: ViewQualityReportSet,
    spatialEstimateSet?: VisualSpatialEstimateSet,
    occlusionReport?: OcclusionReport,
    calibrationContext?: CalibrationPromptContext,
    verificationPolicy: VerificationPolicy = {},
  ): VerificationObservationBundle {
    const activePolicy = mergePolicy(this.policy, verificationPolicy);
    const issues: ValidationIssue[] = [];
    validateInputs(taskConstraints, cameraPackets, consensusReport, qualityReports, spatialEstimateSet, occlusionReport, calibrationContext, activePolicy, issues);

    const requiredRecords = buildRequiredViewRecords(taskConstraints, cameraPackets, activePolicy, occlusionReport);
    const requiredViews = uniqueSorted(requiredRecords.flatMap((record) => record.required_views));
    const relationObservations = buildRelationObservations(taskConstraints, consensusReport);
    const residualHints = buildResidualHints(taskConstraints, spatialEstimateSet, activePolicy, issues);
    const providedViews = buildProvidedViews(taskConstraints, cameraPackets, qualityReports, calibrationContext, requiredViews, relationObservations, activePolicy, issues);
    const inventoryViews = buildInventoryViews(cameraPackets, qualityReports, calibrationContext, providedViews, activePolicy);
    const risks = buildFalsePositiveRisks(taskConstraints, consensusReport, cameraPackets, providedViews, relationObservations, residualHints, occlusionReport, activePolicy, issues);
    const occlusionStatus = summarizeOcclusionStatus(providedViews, risks);
    appendBlockingRiskIssues(risks, issues);

    const decision = decideBundle(cameraPackets, taskConstraints, providedViews, requiredViews, risks, issues, activePolicy);
    const recommendedAction = chooseRecommendedAction(decision, risks, cameraPackets);
    const verificationBundleRef = makeRef("verification_bundle", cameraPackets.bundle_ref, consensusReport.consensus_ref, taskConstraints.map((constraint) => constraint.constraint_ref).join(":"));
    const readinessEvent = buildReadinessEvent(verificationBundleRef, decision, recommendedAction, taskConstraints, providedViews, requiredViews, risks);
    const spatialRefs = spatialEstimateSet?.estimates.map((estimate) => estimate.estimate_ref).sort() ?? [];
    const shell = {
      verificationBundleRef,
      sourceBundleRef: cameraPackets.bundle_ref,
      consensusRef: consensusReport.consensus_ref,
      spatialRef: spatialEstimateSet?.estimate_set_ref,
      constraints: taskConstraints.map((constraint) => [constraint.constraint_ref, constraint.constraint_type, constraint.target_label, constraint.reference_label]),
      requiredViews,
      providedViews: providedViews.map((view) => [view.source_view_name, view.status, view.quality_score, view.occlusion_status]),
      risks: risks.map((risk) => [risk.risk_kind, risk.severity, risk.resolved]),
      issues: issues.map((issue) => issue.code),
      decision,
    };

    return Object.freeze({
      schema_version: VERIFICATION_VIEW_ASSEMBLER_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md",
      verification_bundle_ref: verificationBundleRef,
      source_bundle_ref: cameraPackets.bundle_ref,
      consensus_ref: consensusReport.consensus_ref,
      spatial_estimate_set_ref: spatialEstimateSet?.estimate_set_ref,
      task_phase: cameraPackets.task_phase,
      target_constraint_refs: freezeArray(taskConstraints.map((constraint) => constraint.constraint_ref).sort()),
      constraints: freezeArray([...taskConstraints].sort(compareConstraints)),
      required_views: freezeArray(requiredRecords.sort(compareRequiredViewRecords)),
      provided_views: freezeArray(providedViews.sort(compareEvidenceViews)),
      inventory_views: freezeArray(inventoryViews.sort(compareEvidenceViews)),
      visual_relation_observations: freezeArray(relationObservations.sort(compareRelationObservations)),
      occlusion_status: occlusionStatus,
      residual_hints: freezeArray(residualHints.sort(compareResidualHints)),
      spatial_estimate_refs: freezeArray(spatialRefs),
      false_positive_risks: freezeArray(risks.sort(compareRisks)),
      readiness_event: readinessEvent,
      issues: freezeArray(issues),
      decision,
      recommended_action: recommendedAction,
      ok: decision === "ready_for_visual_verification" || decision === "ambiguous_reobserve_required",
      determinism_hash: computeDeterminismHash(shell),
      cognitive_visibility: "perception_verification_observation_bundle",
    });
  }
}

/**
 * Functional API for File 09 verification view assembly.
 */
export function assembleVerificationViewBundle(
  taskConstraints: readonly VerificationTaskConstraint[],
  cameraPackets: MultiViewObservationBundle,
  consensusReport: MultiViewConsensusReport,
  qualityReports: ViewQualityReportSet,
  verificationPolicy: VerificationPolicy = {},
  spatialEstimateSet?: VisualSpatialEstimateSet,
  occlusionReport?: OcclusionReport,
  calibrationContext?: CalibrationPromptContext,
): VerificationObservationBundle {
  return new VerificationViewAssembler(verificationPolicy).assembleVerificationViewBundle(
    taskConstraints,
    cameraPackets,
    consensusReport,
    qualityReports,
    spatialEstimateSet,
    occlusionReport,
    calibrationContext,
    verificationPolicy,
  );
}

function validateInputs(
  taskConstraints: readonly VerificationTaskConstraint[],
  cameraPackets: MultiViewObservationBundle,
  consensusReport: MultiViewConsensusReport,
  qualityReports: ViewQualityReportSet,
  spatialEstimateSet: VisualSpatialEstimateSet | undefined,
  occlusionReport: OcclusionReport | undefined,
  calibrationContext: CalibrationPromptContext | undefined,
  policy: NormalizedVerificationPolicy,
  issues: ValidationIssue[],
): void {
  if (HIDDEN_VERIFICATION_PATTERN.test(JSON.stringify({ taskConstraints, cameraPackets, consensusReport, qualityReports, spatialEstimateSet, occlusionReport, calibrationContext }))) {
    issues.push(makeIssue("error", "HiddenVerificationInputLeak", "$", "Verification evidence includes hidden simulator or backend-only identifiers.", "Rebuild verification input from declared camera packets, consensus objects, and visible perception evidence only."));
  }
  if (taskConstraints.length === 0) {
    issues.push(makeIssue("error", "NoTaskConstraints", "$.task_constraints", "Verification assembly requires at least one task constraint.", "Provide task goal constraints before entering visual verification."));
  }
  if (consensusReport.bundle_ref !== cameraPackets.bundle_ref) {
    issues.push(makeIssue("error", "BundleConsensusMismatch", "$.consensus_report.bundle_ref", "Consensus report was not built from the provided multi-view bundle.", "Reconcile consensus on the same synchronized camera bundle."));
  }
  if (qualityReports.bundle_ref !== cameraPackets.bundle_ref) {
    issues.push(makeIssue("error", "BundleQualityMismatch", "$.quality_reports.bundle_ref", "Quality report set does not match the multi-view bundle.", "Assess view quality on the same synchronized camera bundle."));
  }
  if (spatialEstimateSet !== undefined && spatialEstimateSet.bundle_ref !== cameraPackets.bundle_ref) {
    issues.push(makeIssue("error", "BundleSpatialMismatch", "$.spatial_estimate_set.bundle_ref", "Spatial estimates do not match the multi-view bundle.", "Estimate visual spatial cues from the same synchronized camera bundle."));
  }
  if (spatialEstimateSet !== undefined && spatialEstimateSet.consensus_ref !== consensusReport.consensus_ref) {
    issues.push(makeIssue("error", "BundleSpatialMismatch", "$.spatial_estimate_set.consensus_ref", "Spatial estimates do not match the consensus report.", "Use spatial estimates generated from the same consensus report."));
  }
  if (occlusionReport !== undefined && occlusionReport.bundle_ref !== cameraPackets.bundle_ref) {
    issues.push(makeIssue("error", "BundleOcclusionMismatch", "$.occlusion_report.bundle_ref", "Occlusion report does not match the multi-view bundle.", "Run occlusion reasoning on the same synchronized camera bundle."));
  }
  if (occlusionReport !== undefined && occlusionReport.consensus_ref !== consensusReport.consensus_ref) {
    issues.push(makeIssue("error", "BundleOcclusionMismatch", "$.occlusion_report.consensus_ref", "Occlusion report does not match the consensus report.", "Run occlusion reasoning from the same consensus state."));
  }
  if (calibrationContext !== undefined && calibrationContext.bundle_ref !== cameraPackets.bundle_ref) {
    issues.push(makeIssue("error", "BundleCalibrationMismatch", "$.calibration_context.bundle_ref", "Calibration context does not match the multi-view bundle.", "Assemble calibration context for the same synchronized camera bundle."));
  }
  if (policy.require_tight_sync && cameraPackets.sync_quality !== "tight") {
    issues.push(makeIssue("error", "DesynchronizedVerificationViews", "$.camera_packets.sync_quality", `Verification requires tight synchronization, but bundle sync quality is ${cameraPackets.sync_quality}.`, "Recapture a tight-sync verification bundle before success checking."));
  } else if (cameraPackets.sync_quality === "desynchronized") {
    issues.push(makeIssue("error", "DesynchronizedVerificationViews", "$.camera_packets.sync_quality", "Verification views are desynchronized.", "Recapture the final-state views with synchronized timestamps."));
  } else if (cameraPackets.sync_quality === "loose") {
    issues.push(makeIssue("warning", "DesynchronizedVerificationViews", "$.camera_packets.sync_quality", "Verification views have loose temporal skew.", "Prefer tight-sync recapture for success-sensitive checks."));
  }
}

function buildRequiredViewRecords(
  constraints: readonly VerificationTaskConstraint[],
  bundle: MultiViewObservationBundle,
  policy: NormalizedVerificationPolicy,
  occlusionReport?: OcclusionReport,
): VerificationRequiredViewRecord[] {
  return constraints.map((constraint) => {
    const profile = CONSTRAINT_VIEW_PROFILES[constraint.constraint_type];
    let requiredViews = firstAvailableByPreference(profile.preferred_views, bundle, 2);
    requiredViews = uniqueSorted([...policy.required_views, ...requiredViews]);
    if (constraint.constraint_type === "inside_container" && policy.require_depth_for_container && bundle.view_packets.depth_primary !== undefined) {
      requiredViews = uniqueSorted([...requiredViews, "depth_primary"]);
    }
    if (constraint.constraint_type === "tool_effect_verification" && bundle.view_packets.verification_aux !== undefined) {
      requiredViews = uniqueSorted([...requiredViews, "verification_aux"]);
    }
    if (policy.require_alternate_view_for_occlusion_risk && hasOcclusionRiskForConstraint(constraint, occlusionReport)) {
      requiredViews = ensureAlternateView(requiredViews, bundle);
    }
    return Object.freeze({
      constraint_ref: constraint.constraint_ref,
      constraint_type: constraint.constraint_type,
      required_views: freezeArray(requiredViews),
      minimum_visual_evidence: profile.minimum_visual_evidence,
      ambiguity_trigger: profile.ambiguity_trigger,
    });
  });
}

function buildRelationObservations(
  constraints: readonly VerificationTaskConstraint[],
  consensusReport: MultiViewConsensusReport,
): VerificationRelationObservation[] {
  const observations: VerificationRelationObservation[] = [];
  for (const constraint of constraints) {
    const object = findObjectForConstraint(consensusReport.consensus_objects, constraint);
    const expectedRelation = normalizeExpectedRelation(constraint);
    const relation = object?.spatial_relations.find((candidate) => relationMatches(candidate.relation, expectedRelation, constraint.reference_label, candidate.target_label));
    const evidenceViews = relation !== undefined ? relation.evidence_views : object?.supporting_view_names ?? [];
    const observationRef = makeRef("verification_relation", constraint.constraint_ref, expectedRelation, object?.consensus_object_ref ?? "missing_object");
    observations.push(Object.freeze({
      observation_ref: observationRef,
      constraint_ref: constraint.constraint_ref,
      target_label: constraint.target_label,
      relation: relation?.relation ?? expectedRelation,
      reference_label: constraint.reference_label,
      evidence_views: freezeArray(uniqueSorted(evidenceViews)),
      confidence: roundScore(relation?.confidence ?? (object !== undefined ? object.pose_confidence * 0.75 : 0)),
      observation_summary: relation?.summary ?? summarizeMissingRelation(constraint, object),
    }));
  }
  return observations;
}

function buildResidualHints(
  constraints: readonly VerificationTaskConstraint[],
  spatialEstimateSet: VisualSpatialEstimateSet | undefined,
  policy: NormalizedVerificationPolicy,
  issues: ValidationIssue[],
): VerificationResidualHint[] {
  return constraints.map((constraint) => {
    const estimate = spatialEstimateSet?.estimates.find((candidate) => labelsMatch(candidate.label, constraint.target_label));
    if (estimate === undefined) {
      issues.push(makeIssue("warning", "SpatialEstimateNotReady", `$.constraints.${constraint.constraint_ref}`, `No spatial estimate is available for ${constraint.target_label}.`, "Run visual spatial estimation or keep verification residuals qualitative."));
      return Object.freeze({
        hint_ref: makeRef("verification_residual", constraint.constraint_ref, "missing"),
        constraint_ref: constraint.constraint_ref,
        target_label: constraint.target_label,
        readiness: "missing",
        confidence: 0,
        hint_summary: "No visual spatial estimate is available; geometry verification must request reobserve or use another declared estimate.",
      });
    }
    if (estimate.uncertainty.confidence < policy.min_spatial_confidence || estimate.readiness !== "verification_candidate_ready") {
      issues.push(makeIssue("warning", "SpatialEstimateNotReady", `$.spatial_estimate_set.${estimate.estimate_ref}`, `Spatial estimate for ${estimate.label} is ${estimate.readiness} with confidence ${formatScore(estimate.uncertainty.confidence)}.`, "Improve view quality, depth, or relation evidence before relying on residual checks."));
    }
    return Object.freeze({
      hint_ref: makeRef("verification_residual", constraint.constraint_ref, estimate.estimate_ref),
      constraint_ref: constraint.constraint_ref,
      target_label: constraint.target_label,
      source_estimate_ref: estimate.estimate_ref,
      readiness: estimate.readiness,
      confidence: roundScore(estimate.uncertainty.confidence),
      hint_summary: estimate.geometry_handoff_summary,
    });
  });
}

function buildProvidedViews(
  constraints: readonly VerificationTaskConstraint[],
  bundle: MultiViewObservationBundle,
  qualityReports: ViewQualityReportSet,
  calibrationContext: CalibrationPromptContext | undefined,
  requiredViews: readonly CanonicalViewName[],
  relationObservations: readonly VerificationRelationObservation[],
  policy: NormalizedVerificationPolicy,
  issues: ValidationIssue[],
): VerificationEvidenceView[] {
  const views: VerificationEvidenceView[] = [];
  for (const viewName of requiredViews) {
    const packet = bundle.view_packets[viewName];
    const quality = qualityFor(qualityReports, viewName);
    const supportedConstraints = constraintsForView(constraints, relationObservations, viewName);
    const visibleRelations = relationsForView(relationObservations, viewName);
    const calibrationRef = calibrationFor(calibrationContext, viewName, packet)?.calibration_ref ?? packet?.calibration_ref;
    if (packet === undefined) {
      issues.push(makeIssue("error", "CriticalViewMissing", `$.required_views.${viewName}`, `Required verification view ${viewName} is missing.`, "Reobserve or recapture this view before success-sensitive verification."));
      views.push(makeEvidenceView(viewName, undefined, quality, "missing", supportedConstraints, visibleRelations, ["Required verification packet is missing."], calibrationRef));
      continue;
    }
    const status = evidenceStatusFor(packet, quality, policy);
    const occlusionNotes = occlusionNotesForQuality(quality);
    if (status === "degraded") {
      issues.push(makeIssue("warning", "SelectedViewLowQuality", `$.provided_views.${viewName}`, `Selected verification view ${viewName} has quality score ${formatScore(quality?.quality_score ?? 0)}.`, "Use a clearer view or reduce confidence in visual verification."));
    }
    if (status === "occluded") {
      issues.push(makeIssue("warning", "TargetOccluded", `$.provided_views.${viewName}`, `Selected verification view ${viewName} does not show the target relation clearly.`, "Request an alternate view that exposes the relation."));
    }
    views.push(makeEvidenceView(viewName, packet, quality, status, supportedConstraints, visibleRelations, occlusionNotes, calibrationRef));
  }
  return views.slice(0, Math.max(policy.max_selected_views, requiredViews.length));
}

function buildInventoryViews(
  bundle: MultiViewObservationBundle,
  qualityReports: ViewQualityReportSet,
  calibrationContext: CalibrationPromptContext | undefined,
  providedViews: readonly VerificationEvidenceView[],
  policy: NormalizedVerificationPolicy,
): VerificationEvidenceView[] {
  if (!policy.include_inventory_only_views) {
    return [];
  }
  const providedNames = new Set(providedViews.map((view) => view.source_view_name));
  const availableNames = Object.keys(bundle.view_packets) as CanonicalViewName[];
  const inventory: VerificationEvidenceView[] = [];
  for (const viewName of availableNames) {
    if (providedNames.has(viewName)) {
      continue;
    }
    const packet = bundle.view_packets[viewName];
    const quality = qualityFor(qualityReports, viewName);
    const calibrationRef = calibrationFor(calibrationContext, viewName, packet)?.calibration_ref ?? packet?.calibration_ref;
    inventory.push(makeEvidenceView(viewName, packet, quality, "inventory_only", [], [], ["Available but not required for this verification constraint set."], calibrationRef));
  }
  return inventory;
}

function buildFalsePositiveRisks(
  constraints: readonly VerificationTaskConstraint[],
  consensusReport: MultiViewConsensusReport,
  bundle: MultiViewObservationBundle,
  providedViews: readonly VerificationEvidenceView[],
  relationObservations: readonly VerificationRelationObservation[],
  residualHints: readonly VerificationResidualHint[],
  occlusionReport: OcclusionReport | undefined,
  policy: NormalizedVerificationPolicy,
  issues: ValidationIssue[],
): VerificationFalsePositiveRisk[] {
  const risks: VerificationFalsePositiveRisk[] = [];
  if (bundle.sync_quality === "desynchronized" || bundle.sync_quality === "loose") {
    risks.push(makeRisk("desynchronized_views", undefined, undefined, providedViews.map((view) => view.source_view_name), "blocking", "Verification views may represent different final-state moments.", "Recapture a tight-sync verification bundle.", false));
  }
  for (const constraint of constraints) {
    const selectedForConstraint = providedViews.filter((view) => view.supports_constraint_refs.includes(constraint.constraint_ref) || view.status === "missing");
    const visibleViews = selectedForConstraint.filter((view) => view.status === "selected").map((view) => view.source_view_name);
    const relationObservation = relationObservations.find((observation) => observation.constraint_ref === constraint.constraint_ref);
    const residual = residualHints.find((hint) => hint.constraint_ref === constraint.constraint_ref);
    const occlusions = occlusionsForConstraint(occlusionReport, constraint);
    risks.push(...risksForConstraintType(constraint, selectedForConstraint, relationObservation, residual, occlusions, policy));
    if (visibleViews.length < 2 && selectedForConstraint.some((view) => view.status === "occluded" || view.status === "degraded")) {
      risks.push(makeRisk("single_occluded_view", constraint, constraint.target_label, visibleViews, "blocking", "Only one usable view supports a constraint while another required view is occluded or degraded.", "Acquire an alternate view before visual success checking.", false));
    }
    if (relationObservation === undefined || relationObservation.confidence < 0.35 || relationObservation.evidence_views.length === 0) {
      risks.push(makeRisk("hidden_relation", constraint, constraint.target_label, visibleViews, constraint.critical === false ? "warning" : "blocking", "The target relation is not visibly grounded in selected evidence.", "Reobserve until the relation is visible in at least one selected view.", false));
      issues.push(makeIssue("warning", "TargetRelationHidden", `$.constraints.${constraint.constraint_ref}`, `Relation evidence for ${constraint.target_label} is hidden or weak.`, "Request an alternate view that exposes the required relation."));
    }
    if (residual !== undefined && residual.readiness !== "verification_candidate_ready") {
      risks.push(makeRisk("missing_reference_region", constraint, constraint.target_label, visibleViews, constraint.critical === false ? "warning" : "blocking", "Spatial residual support is below verification readiness.", "Collect clearer target and reference region evidence before residual evaluation.", false));
    }
  }
  risks.push(...identitySwapRisks(consensusReport.view_conflicts, providedViews));
  risks.push(...shadowRisks(consensusReport, providedViews));
  return dedupeRisks(risks);
}

function risksForConstraintType(
  constraint: VerificationTaskConstraint,
  views: readonly VerificationEvidenceView[],
  relationObservation: VerificationRelationObservation | undefined,
  residual: VerificationResidualHint | undefined,
  occlusions: readonly ReasonedOcclusionRecord[],
  policy: NormalizedVerificationPolicy,
): readonly VerificationFalsePositiveRisk[] {
  const risks: VerificationFalsePositiveRisk[] = [];
  const viewNames = views.map((view) => view.source_view_name);
  const hasSideOrWrist = views.some((view) => view.source_view_name === "left_aux" || view.source_view_name === "right_aux" || view.source_view_name === "wrist_or_mouth");
  const hasDepth = views.some((view) => view.depth_ref !== undefined || view.source_view_name === "depth_primary");
  const anyHidden = views.some((view) => view.occlusion_status === "hidden" || view.occlusion_status === "partial");
  if (constraint.constraint_type === "inside_container" && (!hasSideOrWrist || (policy.require_depth_for_container && !hasDepth) || anyHidden)) {
    risks.push(makeRisk("container_rim_confusion", constraint, constraint.target_label, viewNames, "blocking", "The object may appear inside the container while resting on the rim or being hidden by the rim.", "Require side, wrist, or declared depth evidence showing the object and container boundary.", false));
  }
  if ((constraint.constraint_type === "on_top_relation" || constraint.constraint_type === "stacked_relation") && anyHidden) {
    risks.push(makeRisk("shadow_boundary_confusion", constraint, constraint.target_label, viewNames, "warning", "Hidden contact or vertical ordering could let a shadow mimic support contact.", "Compare side and primary views with visible object boundaries.", false));
  }
  if (constraint.constraint_type === "tool_effect_verification" && (anyHidden || occlusions.some((record) => record.occlusion_kind === "tool" || record.occlusion_kind === "robot_self"))) {
    risks.push(makeRisk("gripper_or_tool_occlusion", constraint, constraint.target_label, viewNames, "blocking", "Tool, gripper, or body occlusion can hide the post-action target state.", "Verify after release or from an alternate camera where the target remains visible.", false));
  }
  if (constraint.requires_release_visible === true && anyHidden) {
    risks.push(makeRisk("gripper_or_tool_occlusion", constraint, constraint.target_label, viewNames, "blocking", "Final placement requires release visibility but selected views still hide the target.", "Capture a released-state view before checking success.", false));
  }
  if (constraint.requires_settle_check === true && relationObservation !== undefined && relationObservation.confidence < 0.8) {
    risks.push(makeRisk("temporary_instability", constraint, constraint.target_label, viewNames, "warning", "The object may be temporarily balanced and not stable.", "Wait for a settle interval and recheck contact or support evidence.", false));
  }
  if (residual !== undefined && residual.confidence >= policy.min_spatial_confidence && !anyHidden && relationObservation !== undefined && relationObservation.confidence >= 0.5) {
    return risks.map((risk) => ({ ...risk, resolved: risk.severity === "warning" }));
  }
  return risks;
}

function identitySwapRisks(conflicts: readonly ViewConflictRecord[], providedViews: readonly VerificationEvidenceView[]): readonly VerificationFalsePositiveRisk[] {
  return conflicts
    .filter((conflict) => conflict.conflict_kind === "identity_swap" || conflict.conflict_kind === "descriptor_mismatch")
    .map((conflict) => makeRisk(
      "similar_object_swap",
      undefined,
      conflict.label,
      uniqueSorted([...conflict.involved_views, ...providedViews.map((view) => view.source_view_name)]),
      conflict.severity,
      conflict.summary,
      "Use identity descriptors, phase continuity, and alternate-view comparison before accepting success.",
      false,
    ));
}

function shadowRisks(consensusReport: MultiViewConsensusReport, providedViews: readonly VerificationEvidenceView[]): readonly VerificationFalsePositiveRisk[] {
  const occlusions = consensusReport.occlusion_report.occlusions.filter((record) => record.occlusion_kind === "lighting_or_shadow");
  return occlusions.map((record) => makeRisk(
    "shadow_boundary_confusion",
    undefined,
    record.affected_label,
    uniqueSorted([...record.affected_views, ...providedViews.map((view) => view.source_view_name)]),
    record.confidence > 0.65 ? "blocking" : "warning",
    record.explanation,
    "Compare alternate views and require visible object boundaries.",
    false,
  ));
}

function makeEvidenceView(
  viewName: CanonicalViewName,
  packet: SynchronizedViewPacket | undefined,
  quality: ViewQualityReport | undefined,
  status: VerificationEvidenceStatus,
  supportsConstraintRefs: readonly Ref[],
  visibleRelations: readonly string[],
  occlusionNotes: readonly string[],
  calibrationRef?: Ref,
): VerificationEvidenceView {
  const occlusionStatus = occlusionStatusFor(status, quality);
  const evidenceRef = makeRef("verification_view", viewName, packet?.packet_ref ?? status, supportsConstraintRefs.join(":"));
  const shell = {
    evidenceRef,
    viewName,
    packet: packet?.packet_ref,
    status,
    quality: quality?.quality_score,
    visibility: quality?.target_visibility,
    constraints: supportsConstraintRefs,
  };
  return Object.freeze({
    evidence_ref: evidenceRef,
    source_view_name: viewName,
    source_camera_packet_ref: packet?.packet_ref,
    image_ref: packet?.image_ref,
    depth_ref: packet?.depth_ref,
    status,
    quality_score: quality?.quality_score,
    target_visibility: quality?.target_visibility,
    occlusion_status: occlusionStatus,
    selected_rationale: rationaleForEvidence(viewName, status, quality, visibleRelations),
    supports_constraint_refs: freezeArray([...supportsConstraintRefs].sort()),
    visible_relations: freezeArray([...visibleRelations].sort()),
    occlusion_notes: freezeArray([...occlusionNotes].sort()),
    calibration_ref: calibrationRef,
    timestamp_midpoint_s: packet?.midpoint_s,
    determinism_hash: computeDeterminismHash(shell),
  });
}

function makeRisk(
  kind: FalsePositiveRiskKind,
  constraint: VerificationTaskConstraint | undefined,
  targetLabel: string | undefined,
  sourceViews: readonly CanonicalViewName[],
  severity: "warning" | "blocking",
  description: string,
  requiredPrevention: string,
  resolved: boolean,
): VerificationFalsePositiveRisk {
  const riskRef = makeRef("verification_risk", kind, constraint?.constraint_ref ?? "bundle", targetLabel ?? "unknown", sourceViews.join(":"));
  return Object.freeze({
    risk_ref: riskRef,
    risk_kind: kind,
    constraint_ref: constraint?.constraint_ref,
    target_label: targetLabel,
    source_views: freezeArray(uniqueSorted(sourceViews)),
    severity,
    description,
    required_prevention: requiredPrevention,
    resolved,
  });
}

function buildReadinessEvent(
  bundleRef: Ref,
  decision: VerificationBundleDecision,
  recommendedAction: VerificationRecommendedAction,
  constraints: readonly VerificationTaskConstraint[],
  providedViews: readonly VerificationEvidenceView[],
  requiredViews: readonly CanonicalViewName[],
  risks: readonly VerificationFalsePositiveRisk[],
): VerificationReadinessEvent {
  const missing = requiredViews.filter((viewName) => providedViews.some((view) => view.source_view_name === viewName && view.status === "missing"));
  const blockingRisks = risks.filter((risk) => risk.severity === "blocking" && !risk.resolved).map((risk) => risk.risk_ref).sort();
  const ambiguousConstraintRefs = uniqueSorted(risks.filter((risk) => risk.constraint_ref !== undefined && !risk.resolved).map((risk) => risk.constraint_ref as Ref));
  const readyConstraintRefs = constraints.map((constraint) => constraint.constraint_ref).filter((constraintRef) => !ambiguousConstraintRefs.includes(constraintRef)).sort();
  const eventRef = makeRef("verification_readiness_event", bundleRef, decision, recommendedAction);
  return Object.freeze({
    event_ref: eventRef,
    bundle_ref: bundleRef,
    decision,
    recommended_action: recommendedAction,
    critical_views_missing: freezeArray(missing),
    blocking_risks: freezeArray(blockingRisks),
    ready_constraint_refs: freezeArray(readyConstraintRefs),
    ambiguous_constraint_refs: freezeArray(ambiguousConstraintRefs),
    summary: summarizeReadiness(decision, missing, blockingRisks, readyConstraintRefs, ambiguousConstraintRefs),
  });
}

function decideBundle(
  bundle: MultiViewObservationBundle,
  constraints: readonly VerificationTaskConstraint[],
  providedViews: readonly VerificationEvidenceView[],
  requiredViews: readonly CanonicalViewName[],
  risks: readonly VerificationFalsePositiveRisk[],
  issues: readonly ValidationIssue[],
  policy: NormalizedVerificationPolicy,
): VerificationBundleDecision {
  if (issues.some((issue) => issue.severity === "error" && issue.code === "HiddenVerificationInputLeak") || constraints.length === 0) {
    return "rejected";
  }
  if (bundle.sync_quality === "desynchronized" || (policy.require_tight_sync && bundle.sync_quality !== "tight") || risks.some((risk) => risk.risk_kind === "desynchronized_views" && risk.severity === "blocking" && !risk.resolved)) {
    return "recapture_required";
  }
  const missingCritical = requiredViews.some((viewName) => providedViews.some((view) => view.source_view_name === viewName && view.status === "missing"));
  const blockers = risks.some((risk) => risk.severity === "blocking" && !risk.resolved);
  const hidden = providedViews.some((view) => view.status === "occluded" || view.occlusion_status === "hidden");
  if (missingCritical || blockers || hidden || issues.some((issue) => issue.code === "TargetRelationHidden")) {
    return "ambiguous_reobserve_required";
  }
  return "ready_for_visual_verification";
}

function chooseRecommendedAction(
  decision: VerificationBundleDecision,
  risks: readonly VerificationFalsePositiveRisk[],
  bundle: MultiViewObservationBundle,
): VerificationRecommendedAction {
  if (decision === "rejected") {
    return "human_review";
  }
  if (decision === "recapture_required" || bundle.recommended_action === "recapture_tight_sync") {
    return "recapture_tight_sync";
  }
  if (risks.some((risk) => risk.severity === "blocking" && (risk.risk_kind === "gripper_or_tool_occlusion" || risk.risk_kind === "hidden_relation"))) {
    return "safe_hold";
  }
  if (decision === "ambiguous_reobserve_required") {
    return "reobserve";
  }
  return "continue";
}

function appendBlockingRiskIssues(risks: readonly VerificationFalsePositiveRisk[], issues: ValidationIssue[]): void {
  for (const risk of risks) {
    if (risk.severity === "blocking" && !risk.resolved) {
      issues.push(makeIssue("warning", "FalsePositiveRiskBlocking", `$.false_positive_risks.${risk.risk_ref}`, risk.description, risk.required_prevention));
    }
  }
}

function summarizeOcclusionStatus(
  providedViews: readonly VerificationEvidenceView[],
  risks: readonly VerificationFalsePositiveRisk[],
): VerificationOcclusionStatus {
  if (providedViews.some((view) => view.occlusion_status === "hidden") || risks.some((risk) => risk.risk_kind === "hidden_relation" && risk.severity === "blocking" && !risk.resolved)) {
    return "hidden";
  }
  if (providedViews.some((view) => view.occlusion_status === "partial") || risks.some((risk) => !risk.resolved)) {
    return "partial";
  }
  if (providedViews.some((view) => view.occlusion_status === "unknown")) {
    return "unknown";
  }
  return "fully_visible";
}

function evidenceStatusFor(
  packet: SynchronizedViewPacket,
  quality: ViewQualityReport | undefined,
  policy: NormalizedVerificationPolicy,
): VerificationEvidenceStatus {
  if (quality === undefined) {
    return packet.health_status === "healthy" ? "selected" : "degraded";
  }
  if (quality.target_visibility === "occluded" || quality.target_visibility === "not_in_frame") {
    return "occluded";
  }
  if (quality.quality_score < policy.min_quality_score || quality.recommended_use === "not_recommended" || packet.health_status !== "healthy") {
    return "degraded";
  }
  return "selected";
}

function occlusionStatusFor(
  status: VerificationEvidenceStatus,
  quality: ViewQualityReport | undefined,
): VerificationOcclusionStatus {
  if (status === "missing") {
    return "unknown";
  }
  if (quality?.target_visibility === "full") {
    return "fully_visible";
  }
  if (quality?.target_visibility === "partial" || quality?.target_visibility === "edge_only" || status === "degraded") {
    return "partial";
  }
  if (quality?.target_visibility === "occluded" || quality?.target_visibility === "not_in_frame" || status === "occluded") {
    return "hidden";
  }
  return "unknown";
}

function firstAvailableByPreference(
  preferredViews: readonly CanonicalViewName[],
  bundle: MultiViewObservationBundle,
  desiredCount: number,
): readonly CanonicalViewName[] {
  const available = preferredViews.filter((viewName) => bundle.view_packets[viewName] !== undefined);
  const selected = available.length > 0 ? available.slice(0, desiredCount) : preferredViews.slice(0, desiredCount);
  if (!selected.includes("front_primary")) {
    return uniqueSorted([...selected, "front_primary"]);
  }
  return uniqueSorted(selected);
}

function ensureAlternateView(
  requiredViews: readonly CanonicalViewName[],
  bundle: MultiViewObservationBundle,
): readonly CanonicalViewName[] {
  if (requiredViews.length >= 2) {
    return requiredViews;
  }
  const preferredAlternates: readonly CanonicalViewName[] = ["left_aux", "right_aux", "wrist_or_mouth", "depth_primary", "verification_aux", "rear_body"];
  const alternate = preferredAlternates.find((viewName) => !requiredViews.includes(viewName) && bundle.view_packets[viewName] !== undefined) ?? preferredAlternates.find((viewName) => !requiredViews.includes(viewName));
  return alternate === undefined ? requiredViews : uniqueSorted([...requiredViews, alternate]);
}

function hasOcclusionRiskForConstraint(
  constraint: VerificationTaskConstraint,
  occlusionReport: OcclusionReport | undefined,
): boolean {
  if (occlusionReport === undefined) {
    return false;
  }
  return occlusionReport.occlusions.some((record) => labelsMatch(record.affected_label, constraint.target_label) && (record.verification_response !== "clear_enough" || record.planning_response === "block_verification"));
}

function constraintsForView(
  constraints: readonly VerificationTaskConstraint[],
  relationObservations: readonly VerificationRelationObservation[],
  viewName: CanonicalViewName,
): readonly Ref[] {
  const refs = constraints
    .filter((constraint) => {
      const relation = relationObservations.find((observation) => observation.constraint_ref === constraint.constraint_ref);
      return relation === undefined || relation.evidence_views.length === 0 || relation.evidence_views.includes(viewName);
    })
    .map((constraint) => constraint.constraint_ref);
  return freezeArray(refs.sort());
}

function relationsForView(
  observations: readonly VerificationRelationObservation[],
  viewName: CanonicalViewName,
): readonly string[] {
  return observations
    .filter((observation) => observation.evidence_views.length === 0 || observation.evidence_views.includes(viewName))
    .map((observation) => `${observation.target_label}:${observation.relation}:${observation.reference_label ?? "scene"}`)
    .sort();
}

function occlusionNotesForQuality(quality: ViewQualityReport | undefined): readonly string[] {
  const notes: string[] = [];
  if (quality?.self_occlusion !== undefined) {
    notes.push(`self occlusion: ${quality.self_occlusion}`);
  }
  if (quality?.field_of_view_gap !== undefined) {
    notes.push(`field of view gap: ${quality.field_of_view_gap}`);
  }
  if (quality?.target_visibility !== undefined && quality.target_visibility !== "full") {
    notes.push(`target visibility: ${quality.target_visibility}`);
  }
  return freezeArray(notes);
}

function occlusionsForConstraint(
  occlusionReport: OcclusionReport | undefined,
  constraint: VerificationTaskConstraint,
): readonly ReasonedOcclusionRecord[] {
  return occlusionReport?.occlusions.filter((record) => labelsMatch(record.affected_label, constraint.target_label)) ?? [];
}

function findObjectForConstraint(
  objects: readonly ConsensusObject[],
  constraint: VerificationTaskConstraint,
): ConsensusObject | undefined {
  return objects.find((object) => labelsMatch(object.label, constraint.target_label));
}

function normalizeExpectedRelation(constraint: VerificationTaskConstraint): string {
  if (constraint.required_relation !== undefined && constraint.required_relation.trim().length > 0) {
    return normalizeLabel(constraint.required_relation);
  }
  switch (constraint.constraint_type) {
    case "exact_position_tolerance":
      return "aligned_with";
    case "orientation_tolerance":
      return "upright";
    case "on_top_relation":
      return "on_top_of";
    case "inside_container":
      return "inside";
    case "adjacent_left_right_relation":
      return "left_or_right_of";
    case "stacked_relation":
      return "on_top_of";
    case "tool_effect_verification":
      return "tool_effect_visible";
  }
}

function relationMatches(
  actualRelation: string,
  expectedRelation: string,
  referenceLabel: string | undefined,
  actualTargetLabel: string,
): boolean {
  const normalizedActual = normalizeLabel(actualRelation);
  const normalizedExpected = normalizeLabel(expectedRelation);
  const relationOk = normalizedActual === normalizedExpected || (normalizedExpected === "left_or_right_of" && (normalizedActual === "left_of" || normalizedActual === "right_of"));
  const targetOk = referenceLabel === undefined || labelsMatch(actualTargetLabel, referenceLabel);
  return relationOk && targetOk;
}

function summarizeMissingRelation(
  constraint: VerificationTaskConstraint,
  object: ConsensusObject | undefined,
): string {
  if (object === undefined) {
    return `No consensus object matched target label ${constraint.target_label}; visual relation is not grounded.`;
  }
  return `Consensus object ${object.label} has no visible relation matching ${normalizeExpectedRelation(constraint)}.`;
}

function rationaleForEvidence(
  viewName: CanonicalViewName,
  status: VerificationEvidenceStatus,
  quality: ViewQualityReport | undefined,
  visibleRelations: readonly string[],
): string {
  const relationSummary = visibleRelations.length > 0 ? `visible relations ${visibleRelations.join(", ")}` : "relation evidence pending";
  if (status === "missing") {
    return `${viewName} is required but absent from the synchronized bundle.`;
  }
  if (status === "inventory_only") {
    return `${viewName} is available as context but was not required by the active constraints.`;
  }
  const qualitySummary = quality === undefined ? "no quality report" : `quality ${formatScore(quality.quality_score)} and visibility ${quality.target_visibility}`;
  return `${viewName} selected for verification with ${qualitySummary}; ${relationSummary}.`;
}

function qualityFor(
  qualityReports: ViewQualityReportSet,
  viewName: CanonicalViewName,
): ViewQualityReport | undefined {
  return qualityReports.per_view_reports.find((report) => report.view_name === viewName);
}

function calibrationFor(
  calibrationContext: CalibrationPromptContext | undefined,
  viewName: CanonicalViewName,
  packet: SynchronizedViewPacket | undefined,
) {
  if (calibrationContext === undefined) {
    return undefined;
  }
  return calibrationContext.view_contexts.find((context) => context.canonical_view_name === viewName && (packet === undefined || context.packet_ref === undefined || context.packet_ref === packet.packet_ref));
}

function labelsMatch(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && normalizeLabel(a) === normalizeLabel(b);
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function dedupeRisks(risks: readonly VerificationFalsePositiveRisk[]): VerificationFalsePositiveRisk[] {
  const byKey = new Map<string, VerificationFalsePositiveRisk>();
  for (const risk of risks) {
    const key = `${risk.risk_kind}:${risk.constraint_ref ?? "bundle"}:${risk.target_label ?? "unknown"}:${risk.source_views.join(",")}`;
    const existing = byKey.get(key);
    if (existing === undefined || (existing.severity === "warning" && risk.severity === "blocking")) {
      byKey.set(key, risk);
    }
  }
  return [...byKey.values()];
}

function summarizeReadiness(
  decision: VerificationBundleDecision,
  missingViews: readonly CanonicalViewName[],
  blockingRisks: readonly Ref[],
  readyConstraintRefs: readonly Ref[],
  ambiguousConstraintRefs: readonly Ref[],
): string {
  if (decision === "ready_for_visual_verification") {
    return `${readyConstraintRefs.length} constraint(s) have selected final-state evidence and no unresolved blocking false-positive risks.`;
  }
  if (decision === "recapture_required") {
    return `Tight-sync recapture is required before verification; ${blockingRisks.length} blocking risk(s) remain.`;
  }
  if (decision === "rejected") {
    return "Verification bundle rejected due to invalid or hidden evidence input.";
  }
  return `Reobserve required; missing views: ${missingViews.join(", ") || "none"}; ambiguous constraints: ${ambiguousConstraintRefs.join(", ") || "none"}.`;
}

function compareConstraints(a: VerificationTaskConstraint, b: VerificationTaskConstraint): number {
  return a.constraint_ref.localeCompare(b.constraint_ref);
}

function compareRequiredViewRecords(a: VerificationRequiredViewRecord, b: VerificationRequiredViewRecord): number {
  return a.constraint_ref.localeCompare(b.constraint_ref);
}

function compareEvidenceViews(a: VerificationEvidenceView, b: VerificationEvidenceView): number {
  return a.source_view_name.localeCompare(b.source_view_name) || a.evidence_ref.localeCompare(b.evidence_ref);
}

function compareRelationObservations(a: VerificationRelationObservation, b: VerificationRelationObservation): number {
  return a.constraint_ref.localeCompare(b.constraint_ref) || a.observation_ref.localeCompare(b.observation_ref);
}

function compareResidualHints(a: VerificationResidualHint, b: VerificationResidualHint): number {
  return a.constraint_ref.localeCompare(b.constraint_ref) || a.hint_ref.localeCompare(b.hint_ref);
}

function compareRisks(a: VerificationFalsePositiveRisk, b: VerificationFalsePositiveRisk): number {
  return a.risk_kind.localeCompare(b.risk_kind) || (a.constraint_ref ?? "").localeCompare(b.constraint_ref ?? "") || a.risk_ref.localeCompare(b.risk_ref);
}

function mergePolicy(base: NormalizedVerificationPolicy, override: VerificationPolicy): NormalizedVerificationPolicy {
  return Object.freeze({
    required_views: freezeArray(override.required_views ?? base.required_views),
    min_quality_score: finiteOr(override.min_quality_score, base.min_quality_score),
    min_spatial_confidence: finiteOr(override.min_spatial_confidence, base.min_spatial_confidence),
    require_alternate_view_for_occlusion_risk: override.require_alternate_view_for_occlusion_risk ?? base.require_alternate_view_for_occlusion_risk,
    require_tight_sync: override.require_tight_sync ?? base.require_tight_sync,
    max_selected_views: Math.max(1, Math.floor(finiteOr(override.max_selected_views, base.max_selected_views))),
    include_inventory_only_views: override.include_inventory_only_views ?? base.include_inventory_only_views,
    require_depth_for_container: override.require_depth_for_container ?? base.require_depth_for_container,
  });
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function roundScore(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
}

function formatScore(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "") : "invalid";
}

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return freezeArray([...new Set(values)].sort());
}

function makeIssue(
  severity: ValidationSeverity,
  code: VerificationViewAssemblerIssueCode,
  path: string,
  message: string,
  remediation: string,
): ValidationIssue {
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
