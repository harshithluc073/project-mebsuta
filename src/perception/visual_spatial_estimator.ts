/**
 * Visual spatial estimator for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md`
 * sections 9.3.1, 9.5.1, 9.12, 9.17, 9.20, and 9.21.
 *
 * The estimator converts sensor-derived image regions, declared calibration,
 * optional declared depth samples, and consensus object evidence into uncertain
 * 2D and optional 3D visual cues for File 10 geometry. It preserves the File 09
 * projection model without reaching for hidden simulator poses, object IDs,
 * segmentation truth, or backend world state.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, Transform, ValidationIssue, ValidationSeverity, Vector3 } from "../simulation/world_manifest";
import type { CameraIntrinsics } from "../virtual_hardware/virtual_hardware_manifest_registry";
import type { CalibrationPromptContext, CalibrationPromptViewContext } from "./calibration_context_assembler";
import type { ConsensusObject, MultiViewConsensusReport, PoseReadiness } from "./cross_view_consensus_engine";
import type { MultiViewObservationBundle, PerceptionTaskPhase, SynchronizedViewPacket } from "./multi_view_synchronizer";
import type { SpatialRelationKind, VisualImageRegion, VisualObjectHypothesis, PerViewObjectHypothesisSet } from "./object_hypothesis_service";
import type { CanonicalViewName } from "./view_name_registry";
import type { ViewQualityReport, ViewQualityReportSet } from "./view_quality_assessor";

export const VISUAL_SPATIAL_ESTIMATOR_SCHEMA_VERSION = "mebsuta.visual_spatial_estimator.v1" as const;

const HIDDEN_SPATIAL_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|segmentation truth|debug buffer|debug overlay|qa_success|qa_label|qa_only|simulator truth|mesh_name|asset_id)/i;

export type SpatialReadinessLevel =
  | "label_only"
  | "relation_ready"
  | "approach_ready"
  | "grasp_candidate_ready"
  | "verification_candidate_ready"
  | "not_ready";

export type SpatialEstimateDecision = "estimated" | "estimated_with_warnings" | "reobserve_required" | "rejected";
export type SpatialEstimatorAction = "continue" | "reobserve" | "recapture_tight_sync" | "safe_hold" | "human_review";
export type SpatialDepthStatus = "declared_depth_sample" | "declared_depth_unavailable" | "rgb_only";
export type SpatialCueKind = "object_center" | "region_extent" | "contact_region" | "placement_region" | "tool_affordance_region" | "relation_anchor";
export type VisualSpatialIssueCode =
  | "BundleRefMismatch"
  | "CalibrationBundleMismatch"
  | "ConsensusBundleMismatch"
  | "HiddenSpatialInputLeak"
  | "NoConsensusObjects"
  | "SourceViewMissing"
  | "CalibrationMissing"
  | "IntrinsicsMissing"
  | "RegionInvalid"
  | "DepthSampleInvalid"
  | "DepthQualityLow"
  | "EstimateNotReady";

/**
 * Depth sample derived from a declared depth-capable camera packet. The sample
 * is optional because File 09 permits RGB-only estimates when uncertainty stays
 * explicit.
 */
export interface DeclaredDepthSample {
  readonly sample_ref: Ref;
  readonly source_view_name: CanonicalViewName;
  readonly source_camera_packet_ref: Ref;
  readonly coordinate_space: "normalized_image" | "pixel_image";
  readonly x: number;
  readonly y: number;
  readonly depth_m: number;
  readonly confidence: number;
  readonly depth_quality?: "high" | "medium" | "low" | "hole_filled";
}

/**
 * Runtime policy for readiness thresholds and uncertainty scaling.
 */
export interface VisualSpatialEstimatorPolicy {
  readonly min_quality_for_geometry?: number;
  readonly min_depth_confidence?: number;
  readonly min_pose_confidence_for_approach?: number;
  readonly min_pose_confidence_for_grasp?: number;
  readonly min_pose_confidence_for_verification?: number;
  readonly max_depth_m?: number;
  readonly allow_rgb_only_estimates?: boolean;
}

/**
 * Pixel coordinate and normalized camera ray for a single view observation.
 */
export interface ViewSpatialCue {
  readonly cue_ref: Ref;
  readonly cue_kind: SpatialCueKind;
  readonly source_view_name: CanonicalViewName;
  readonly source_camera_packet_ref: Ref;
  readonly source_hypothesis_ref?: Ref;
  readonly source_region?: VisualImageRegion;
  readonly pixel_point: readonly [number, number];
  readonly normalized_image_point: readonly [number, number];
  readonly normalized_camera_ray: Vector3;
  readonly agent_frame_ray?: Vector3;
  readonly camera_frame_point_m?: Vector3;
  readonly agent_frame_point_m?: Vector3;
  readonly depth_status: SpatialDepthStatus;
  readonly depth_sample_ref?: Ref;
  readonly depth_m?: number;
  readonly angular_extent_rad?: readonly [number, number];
  readonly quality_score: number;
  readonly uncertainty: SpatialUncertainty;
  readonly determinism_hash: string;
}

/**
 * Object-relative relation cue consumed by planning, verification, and memory.
 */
export interface VisualSpatialRelationCue {
  readonly relation_cue_ref: Ref;
  readonly source_object_ref: Ref;
  readonly source_label: string;
  readonly relation: SpatialRelationKind;
  readonly target_label: string;
  readonly evidence_views: readonly CanonicalViewName[];
  readonly relation_is_visual: boolean;
  readonly confidence: number;
  readonly readiness_contribution: SpatialReadinessLevel;
  readonly uncertainty_note: string;
}

/**
 * Uncertainty record attached to each 2D or 3D estimate.
 */
export interface SpatialUncertainty {
  readonly pixel_sigma_px: number;
  readonly angular_sigma_rad: number;
  readonly depth_sigma_m?: number;
  readonly lateral_sigma_m?: number;
  readonly confidence: number;
  readonly basis: readonly string[];
}

/**
 * Per-object spatial estimate emitted by File 09.
 */
export interface VisualSpatialEstimate {
  readonly estimate_ref: Ref;
  readonly consensus_object_ref: Ref;
  readonly label: string;
  readonly task_phase: PerceptionTaskPhase;
  readonly readiness: SpatialReadinessLevel;
  readonly consensus_pose_readiness: PoseReadiness;
  readonly source_view_names: readonly CanonicalViewName[];
  readonly view_cues: readonly ViewSpatialCue[];
  readonly relation_cues: readonly VisualSpatialRelationCue[];
  readonly representative_agent_point_m?: Vector3;
  readonly representative_normalized_point?: readonly [number, number];
  readonly representative_view_name?: CanonicalViewName;
  readonly uncertainty: SpatialUncertainty;
  readonly geometry_handoff_summary: string;
  readonly recommended_action: SpatialEstimatorAction;
  readonly determinism_hash: string;
}

/**
 * Full spatial estimate set for one synchronized observation bundle.
 */
export interface VisualSpatialEstimateSet {
  readonly schema_version: typeof VISUAL_SPATIAL_ESTIMATOR_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md";
  readonly estimate_set_ref: Ref;
  readonly bundle_ref: Ref;
  readonly consensus_ref: Ref;
  readonly calibration_context_ref: Ref;
  readonly task_phase: PerceptionTaskPhase;
  readonly estimates: readonly VisualSpatialEstimate[];
  readonly omitted_object_refs: readonly Ref[];
  readonly readiness_summary: readonly SpatialReadinessSummaryRow[];
  readonly issues: readonly ValidationIssue[];
  readonly decision: SpatialEstimateDecision;
  readonly recommended_action: SpatialEstimatorAction;
  readonly ok: boolean;
  readonly determinism_hash: string;
  readonly cognitive_visibility: "perception_visual_spatial_estimate_set";
}

/**
 * Compact readiness row for dashboards and orchestrator gating.
 */
export interface SpatialReadinessSummaryRow {
  readonly readiness: SpatialReadinessLevel;
  readonly count: number;
  readonly labels: readonly string[];
}

interface NormalizedPolicy {
  readonly min_quality_for_geometry: number;
  readonly min_depth_confidence: number;
  readonly min_pose_confidence_for_approach: number;
  readonly min_pose_confidence_for_grasp: number;
  readonly min_pose_confidence_for_verification: number;
  readonly max_depth_m: number;
  readonly allow_rgb_only_estimates: boolean;
}

interface RegionCandidate {
  readonly object: ConsensusObject;
  readonly hypothesis?: VisualObjectHypothesis;
  readonly region: VisualImageRegion;
}

const DEFAULT_POLICY: NormalizedPolicy = Object.freeze({
  min_quality_for_geometry: 0.45,
  min_depth_confidence: 0.45,
  min_pose_confidence_for_approach: 0.52,
  min_pose_confidence_for_grasp: 0.62,
  min_pose_confidence_for_verification: 0.68,
  max_depth_m: 12,
  allow_rgb_only_estimates: true,
});

/**
 * Executable File 09 `VisualSpatialEstimator`.
 */
export class VisualSpatialEstimator {
  private readonly policy: NormalizedPolicy;

  public constructor(policy: VisualSpatialEstimatorPolicy = {}) {
    this.policy = mergePolicy(DEFAULT_POLICY, policy);
  }

  /**
   * Builds uncertainty-labeled 2D and optional 3D spatial cues from consensus,
   * declared calibration, synchronized view packets, and optional depth samples.
   */
  public estimateVisualSpatialCues(
    bundle: MultiViewObservationBundle,
    calibrationContext: CalibrationPromptContext,
    consensusReport: MultiViewConsensusReport,
    hypothesisSets: readonly PerViewObjectHypothesisSet[] = [],
    qualityReports?: ViewQualityReportSet,
    depthSamples: readonly DeclaredDepthSample[] = [],
    policy: VisualSpatialEstimatorPolicy = {},
  ): VisualSpatialEstimateSet {
    const activePolicy = mergePolicy(this.policy, policy);
    const issues: ValidationIssue[] = [];
    validateInputs(bundle, calibrationContext, consensusReport, hypothesisSets, qualityReports, depthSamples, activePolicy, issues);

    const regions = collectRegionCandidates(consensusReport, hypothesisSets);
    const estimates: VisualSpatialEstimate[] = [];
    const omitted: Ref[] = [];
    for (const object of consensusReport.consensus_objects) {
      const objectRegions = regions.filter((candidate) => candidate.object.consensus_object_ref === object.consensus_object_ref);
      const estimate = buildObjectEstimate(object, objectRegions, bundle, calibrationContext, qualityReports, consensusReport.pose_readiness, depthSamples, activePolicy, issues);
      if (estimate === undefined) {
        omitted.push(object.consensus_object_ref);
      } else {
        estimates.push(estimate);
      }
    }

    if (consensusReport.consensus_objects.length === 0) {
      issues.push(makeIssue("error", "NoConsensusObjects", "$.consensus_objects", "VisualSpatialEstimator requires at least one consensus object.", "Run cross-view consensus before spatial estimation."));
    }
    if (estimates.length === 0) {
      issues.push(makeIssue("warning", "EstimateNotReady", "$.estimates", "No object produced a geometry-ready visual spatial estimate.", "Reobserve with current image regions, calibration, and optional depth."));
    }

    const sortedEstimates = estimates.sort(compareEstimates);
    const decision = decideEstimation(sortedEstimates, issues);
    const recommendedAction = chooseRecommendedAction(decision, sortedEstimates, issues, consensusReport);
    const estimateSetRef = makeRef("visual_spatial_estimate_set", bundle.bundle_ref, consensusReport.consensus_ref, sortedEstimates.map((estimate) => estimate.estimate_ref).join(":"));
    const shell = {
      estimateSetRef,
      bundle: bundle.bundle_ref,
      consensus: consensusReport.consensus_ref,
      estimates: sortedEstimates.map((estimate) => [estimate.estimate_ref, estimate.readiness, estimate.representative_view_name]),
      omitted,
      issues: issues.map((issue) => issue.code),
    };

    return Object.freeze({
      schema_version: VISUAL_SPATIAL_ESTIMATOR_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md",
      estimate_set_ref: estimateSetRef,
      bundle_ref: bundle.bundle_ref,
      consensus_ref: consensusReport.consensus_ref,
      calibration_context_ref: calibrationContext.calibration_context_ref,
      task_phase: bundle.task_phase,
      estimates: freezeArray(sortedEstimates),
      omitted_object_refs: freezeArray(omitted.sort()),
      readiness_summary: summarizeReadiness(sortedEstimates),
      issues: freezeArray(issues),
      decision,
      recommended_action: recommendedAction,
      ok: decision !== "rejected",
      determinism_hash: computeDeterminismHash(shell),
      cognitive_visibility: "perception_visual_spatial_estimate_set",
    });
  }
}

/**
 * Functional API for File 09 visual spatial estimation.
 */
export function estimateVisualSpatialCues(
  bundle: MultiViewObservationBundle,
  calibrationContext: CalibrationPromptContext,
  consensusReport: MultiViewConsensusReport,
  hypothesisSets: readonly PerViewObjectHypothesisSet[] = [],
  qualityReports?: ViewQualityReportSet,
  depthSamples: readonly DeclaredDepthSample[] = [],
  policy: VisualSpatialEstimatorPolicy = {},
): VisualSpatialEstimateSet {
  return new VisualSpatialEstimator(policy).estimateVisualSpatialCues(bundle, calibrationContext, consensusReport, hypothesisSets, qualityReports, depthSamples, policy);
}

function buildObjectEstimate(
  object: ConsensusObject,
  regionCandidates: readonly RegionCandidate[],
  bundle: MultiViewObservationBundle,
  calibrationContext: CalibrationPromptContext,
  qualityReports: ViewQualityReportSet | undefined,
  consensusPoseReadiness: PoseReadiness,
  depthSamples: readonly DeclaredDepthSample[],
  policy: NormalizedPolicy,
  issues: ValidationIssue[],
): VisualSpatialEstimate | undefined {
  const viewCues: ViewSpatialCue[] = [];
  const regions = regionCandidates.length > 0 ? regionCandidates : fallbackRegionsForObject(object);
  for (const candidate of regions) {
    const cue = buildViewCue(candidate, bundle, calibrationContext, qualityReports, depthSamples, policy, issues);
    if (cue !== undefined) {
      viewCues.push(cue);
    }
  }
  if (viewCues.length === 0 && object.evidence_views.length > 0) {
    for (const evidence of object.evidence_views) {
      const cue = buildEvidenceOnlyCue(object, evidence.source_view_name, evidence.source_camera_packet_ref, bundle, calibrationContext, qualityReports, depthSamples, policy, issues);
      if (cue !== undefined) {
        viewCues.push(cue);
      }
    }
  }
  if (viewCues.length === 0) {
    return undefined;
  }

  const relationCues = object.spatial_relations.map((relation) => relationCueFrom(object, relation));
  const representativePoint = representativeAgentPoint(viewCues);
  const representative2d = representativeNormalizedPoint(viewCues);
  const representativeView = strongestCue(viewCues)?.source_view_name;
  const uncertainty = combineUncertainty(viewCues, relationCues, object);
  const readiness = classifyReadiness(object, viewCues, relationCues, consensusPoseReadiness, policy);
  const recommendedAction = actionForReadiness(readiness, viewCues, object);
  const estimateRef = makeRef("visual_spatial_estimate", object.consensus_object_ref, readiness, representativeView ?? "no_view");
  const shell = {
    estimateRef,
    object: object.consensus_object_ref,
    readiness,
    viewCues: viewCues.map((cue) => [cue.cue_ref, cue.depth_status, cue.depth_m]),
    relations: relationCues.map((cue) => [cue.relation, cue.target_label, cue.confidence]),
  };
  return Object.freeze({
    estimate_ref: estimateRef,
    consensus_object_ref: object.consensus_object_ref,
    label: object.label,
    task_phase: inferTaskPhaseFromReadiness(consensusPoseReadiness),
    readiness,
    consensus_pose_readiness: consensusPoseReadiness,
    source_view_names: freezeArray(uniqueSorted(viewCues.map((cue) => cue.source_view_name))),
    view_cues: freezeArray(viewCues.sort(compareViewCues)),
    relation_cues: freezeArray(relationCues.sort(compareRelationCues)),
    representative_agent_point_m: representativePoint,
    representative_normalized_point: representative2d,
    representative_view_name: representativeView,
    uncertainty,
    geometry_handoff_summary: summarizeEstimate(object, readiness, viewCues, relationCues, uncertainty),
    recommended_action: recommendedAction,
    determinism_hash: computeDeterminismHash(shell),
  });
}

function buildViewCue(
  candidate: RegionCandidate,
  bundle: MultiViewObservationBundle,
  calibrationContext: CalibrationPromptContext,
  qualityReports: ViewQualityReportSet | undefined,
  depthSamples: readonly DeclaredDepthSample[],
  policy: NormalizedPolicy,
  issues: ValidationIssue[],
): ViewSpatialCue | undefined {
  const region = candidate.region;
  const packet = bundle.view_packets[region.source_view_name];
  if (packet === undefined) {
    issues.push(makeIssue("warning", "SourceViewMissing", `$.regions.${region.source_view_name}`, `Spatial region for ${candidate.object.label} refers to missing view ${region.source_view_name}.`, "Reobserve the source view before geometry handoff."));
    return undefined;
  }
  const calibration = calibrationFor(calibrationContext, region.source_view_name, packet.packet_ref);
  if (calibration === undefined) {
    issues.push(makeIssue("warning", "CalibrationMissing", `$.calibration_context.${region.source_view_name}`, `Calibration context missing for ${region.source_view_name}.`, "Assemble declared calibration before visual spatial estimation."));
    return undefined;
  }
  const regionIssues = validateRegion(region, candidate.object.label);
  issues.push(...regionIssues);
  if (regionIssues.some((issue) => issue.severity === "error")) {
    return undefined;
  }
  const pixel = pixelPointFromRegion(region, calibration);
  return buildCueFromPoint(
    candidate.object,
    candidate.hypothesis?.hypothesis_ref,
    "object_center",
    region.source_view_name,
    packet,
    calibration,
    qualityFor(qualityReports, region.source_view_name),
    depthSamples,
    pixel,
    normalizedPointFromRegion(region, calibration),
    region,
    policy,
    issues,
  );
}

function buildEvidenceOnlyCue(
  object: ConsensusObject,
  viewName: CanonicalViewName,
  packetRef: Ref,
  bundle: MultiViewObservationBundle,
  calibrationContext: CalibrationPromptContext,
  qualityReports: ViewQualityReportSet | undefined,
  depthSamples: readonly DeclaredDepthSample[],
  policy: NormalizedPolicy,
  issues: ValidationIssue[],
): ViewSpatialCue | undefined {
  const packet = bundle.view_packets[viewName];
  if (packet === undefined || packet.packet_ref !== packetRef) {
    issues.push(makeIssue("warning", "SourceViewMissing", `$.evidence_views.${viewName}`, `Evidence view ${viewName} for ${object.label} is not present in the current bundle.`, "Use only current synchronized packet evidence for spatial estimates."));
    return undefined;
  }
  const calibration = calibrationFor(calibrationContext, viewName, packet.packet_ref);
  if (calibration === undefined) {
    issues.push(makeIssue("warning", "CalibrationMissing", `$.calibration_context.${viewName}`, `Declared calibration is missing for ${viewName}.`, "Assemble calibration context before spatial estimation."));
    return undefined;
  }
  const normalizedPoint = [0.5, 0.5] as const;
  const pixel = pixelPointFromNormalized(normalizedPoint, calibration);
  return buildCueFromPoint(object, undefined, "object_center", viewName, packet, calibration, qualityFor(qualityReports, viewName), depthSamples, pixel, normalizedPoint, undefined, policy, issues);
}

function buildCueFromPoint(
  object: ConsensusObject,
  sourceHypothesisRef: Ref | undefined,
  cueKind: SpatialCueKind,
  viewName: CanonicalViewName,
  packet: SynchronizedViewPacket,
  calibration: CalibrationPromptViewContext,
  quality: ViewQualityReport | undefined,
  depthSamples: readonly DeclaredDepthSample[],
  pixelPoint: readonly [number, number],
  normalizedImagePoint: readonly [number, number],
  sourceRegion: VisualImageRegion | undefined,
  policy: NormalizedPolicy,
  issues: ValidationIssue[],
): ViewSpatialCue {
  const intrinsics = calibration.camera_intrinsics;
  if (intrinsics === undefined) {
    issues.push(makeIssue("warning", "IntrinsicsMissing", `$.calibration_context.${viewName}.camera_intrinsics`, `Declared intrinsics are missing for ${viewName}; using normalized optical ray.`, "Declare camera intrinsics for metric angular estimates."));
  }
  const cameraRay = intrinsics === undefined
    ? normalizeVector([normalizedImagePoint[0] - 0.5, normalizedImagePoint[1] - 0.5, 1])
    : rayFromIntrinsics(pixelPoint, intrinsics);
  const agentRay = calibration.mount_transform === undefined ? undefined : rotateVector(calibration.mount_transform.orientation_xyzw, cameraRay);
  const depthSample = bestDepthSample(depthSamples, viewName, packet.packet_ref, normalizedImagePoint, pixelPoint, calibration, policy, issues);
  const depthStatus: SpatialDepthStatus = depthSample === undefined
    ? calibration.supports_depth || packet.depth_ref !== undefined ? "declared_depth_unavailable" : "rgb_only"
    : "declared_depth_sample";
  const cameraPoint = depthSample === undefined ? undefined : scaleVector(cameraRay, depthSample.depth_m);
  const agentPoint = cameraPoint === undefined || calibration.mount_transform === undefined ? undefined : transformPoint(calibration.mount_transform, cameraPoint);
  const qualityScore = quality?.quality_score ?? packet.confidence;
  const angularExtent = sourceRegion === undefined || intrinsics === undefined ? undefined : angularExtentForRegion(sourceRegion, calibration, intrinsics);
  const uncertainty = uncertaintyForCue(qualityScore, object.pose_confidence, depthSample, angularExtent, calibration, policy);
  const cueRef = makeRef("spatial_cue", object.consensus_object_ref, viewName, packet.packet_ref, sourceHypothesisRef ?? "consensus", sourceRegion === undefined ? "center" : stableRegionKey(sourceRegion));
  const shell = {
    cueRef,
    viewName,
    packet: packet.packet_ref,
    pixelPoint,
    normalizedImagePoint,
    cameraRay,
    depth: depthSample?.depth_m,
  };
  return Object.freeze({
    cue_ref: cueRef,
    cue_kind: cueKind,
    source_view_name: viewName,
    source_camera_packet_ref: packet.packet_ref,
    source_hypothesis_ref: sourceHypothesisRef,
    source_region: sourceRegion,
    pixel_point: freezeTuple2(pixelPoint),
    normalized_image_point: freezeTuple2(normalizedImagePoint),
    normalized_camera_ray: freezeVector(cameraRay),
    agent_frame_ray: agentRay === undefined ? undefined : freezeVector(agentRay),
    camera_frame_point_m: cameraPoint === undefined ? undefined : freezeVector(cameraPoint),
    agent_frame_point_m: agentPoint === undefined ? undefined : freezeVector(agentPoint),
    depth_status: depthStatus,
    depth_sample_ref: depthSample?.sample_ref,
    depth_m: depthSample?.depth_m,
    angular_extent_rad: angularExtent,
    quality_score: roundScore(qualityScore),
    uncertainty,
    determinism_hash: computeDeterminismHash(shell),
  });
}

function collectRegionCandidates(
  consensusReport: MultiViewConsensusReport,
  hypothesisSets: readonly PerViewObjectHypothesisSet[],
): readonly RegionCandidate[] {
  const hypotheses = new Map<Ref, VisualObjectHypothesis>();
  for (const set of hypothesisSets) {
    for (const hypothesis of set.hypotheses) {
      hypotheses.set(hypothesis.hypothesis_ref, hypothesis);
    }
  }
  const candidates: RegionCandidate[] = [];
  for (const object of consensusReport.consensus_objects) {
    for (const hypothesisRef of object.source_hypothesis_refs) {
      const hypothesis = hypotheses.get(hypothesisRef);
      if (hypothesis === undefined) {
        continue;
      }
      for (const region of hypothesis.image_regions) {
        candidates.push(Object.freeze({ object, hypothesis, region }));
      }
    }
  }
  return freezeArray(candidates.sort((a, b) =>
    a.object.consensus_object_ref.localeCompare(b.object.consensus_object_ref)
    || viewSortRank(a.region.source_view_name) - viewSortRank(b.region.source_view_name)
    || a.region.x - b.region.x
    || a.region.y - b.region.y));
}

function fallbackRegionsForObject(object: ConsensusObject): readonly RegionCandidate[] {
  return freezeArray(object.evidence_views.map((view) => Object.freeze({
    object,
    region: Object.freeze({
      source_view_name: view.source_view_name,
      source_camera_packet_ref: view.source_camera_packet_ref,
      coordinate_space: "normalized_image" as const,
      x: 0.25,
      y: 0.25,
      width: 0.5,
      height: 0.5,
      center_x: 0.5,
      center_y: 0.5,
      area_fraction: 0.25,
      region_summary: `broad central evidence region for ${object.label}; no tighter image region was supplied`,
    }),
  })));
}

function relationCueFrom(object: ConsensusObject, relation: ConsensusObject["spatial_relations"][number]): VisualSpatialRelationCue {
  const readinessContribution = relation.confidence >= 0.68 && relation.relation_is_visual ? "relation_ready" : "label_only";
  return Object.freeze({
    relation_cue_ref: makeRef("spatial_relation_cue", object.consensus_object_ref, relation.relation, relation.target_label, relation.evidence_views.join("_")),
    source_object_ref: object.consensus_object_ref,
    source_label: object.label,
    relation: relation.relation,
    target_label: relation.target_label,
    evidence_views: freezeArray(relation.evidence_views),
    relation_is_visual: relation.relation_is_visual,
    confidence: roundScore(relation.confidence),
    readiness_contribution: readinessContribution,
    uncertainty_note: relation.relation_is_visual
      ? `Visual relation ${relation.relation} to ${relation.target_label} is sensor-derived and confidence-labeled.`
      : `Relation ${relation.relation} to ${relation.target_label} is not direct visual proof and must be validated downstream.`,
  });
}

function pixelPointFromRegion(region: VisualImageRegion, calibration: CalibrationPromptViewContext): readonly [number, number] {
  if (region.coordinate_space === "pixel_image") {
    return freezeTuple2([round6(region.center_x), round6(region.center_y)]);
  }
  return pixelPointFromNormalized([region.center_x, region.center_y], calibration);
}

function pixelPointFromNormalized(point: readonly [number, number], calibration: CalibrationPromptViewContext): readonly [number, number] {
  const width = calibration.declared_resolution_px.width_px;
  const height = calibration.declared_resolution_px.height_px;
  return freezeTuple2([round6(clamp01(point[0]) * width), round6(clamp01(point[1]) * height)]);
}

function normalizedPointFromRegion(region: VisualImageRegion, calibration: CalibrationPromptViewContext): readonly [number, number] {
  if (region.coordinate_space === "normalized_image") {
    return freezeTuple2([clamp01(region.center_x), clamp01(region.center_y)]);
  }
  const width = Math.max(1, calibration.declared_resolution_px.width_px);
  const height = Math.max(1, calibration.declared_resolution_px.height_px);
  return freezeTuple2([clamp01(region.center_x / width), clamp01(region.center_y / height)]);
}

function rayFromIntrinsics(pixel: readonly [number, number], intrinsics: CameraIntrinsics): Vector3 {
  const fx = Math.max(1e-9, intrinsics.fx_px);
  const fy = Math.max(1e-9, intrinsics.fy_px);
  return normalizeVector([(pixel[0] - intrinsics.cx_px) / fx, (pixel[1] - intrinsics.cy_px) / fy, 1]);
}

function angularExtentForRegion(region: VisualImageRegion, calibration: CalibrationPromptViewContext, intrinsics: CameraIntrinsics): readonly [number, number] {
  const widthPx = region.coordinate_space === "pixel_image" ? region.width : region.width * calibration.declared_resolution_px.width_px;
  const heightPx = region.coordinate_space === "pixel_image" ? region.height : region.height * calibration.declared_resolution_px.height_px;
  const horizontal = 2 * Math.atan(Math.max(0, widthPx) / (2 * Math.max(1e-9, intrinsics.fx_px)));
  const vertical = 2 * Math.atan(Math.max(0, heightPx) / (2 * Math.max(1e-9, intrinsics.fy_px)));
  return freezeTuple2([round6(horizontal), round6(vertical)]);
}

function bestDepthSample(
  samples: readonly DeclaredDepthSample[],
  viewName: CanonicalViewName,
  packetRef: Ref,
  normalizedPoint: readonly [number, number],
  pixelPoint: readonly [number, number],
  calibration: CalibrationPromptViewContext,
  policy: NormalizedPolicy,
  issues: ValidationIssue[],
): DeclaredDepthSample | undefined {
  const candidates = samples.filter((sample) => sample.source_view_name === viewName && sample.source_camera_packet_ref === packetRef);
  let best: DeclaredDepthSample | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const sample of candidates) {
    const sampleIssues = validateDepthSample(sample, policy);
    issues.push(...sampleIssues);
    if (sampleIssues.some((issue) => issue.severity === "error")) {
      continue;
    }
    if (sample.confidence < policy.min_depth_confidence) {
      issues.push(makeIssue("warning", "DepthQualityLow", `$.depth_samples.${sample.sample_ref}.confidence`, `Depth sample ${sample.sample_ref} has low confidence ${formatScore(sample.confidence)}.`, "Use RGB-only uncertainty or recapture depth."));
      continue;
    }
    const samplePoint = sample.coordinate_space === "normalized_image"
      ? pixelPointFromNormalized([sample.x, sample.y], calibration)
      : freezeTuple2([sample.x, sample.y]);
    const distance = euclidean2(samplePoint, pixelPoint);
    const normalizedDistance = sample.coordinate_space === "normalized_image"
      ? euclidean2([sample.x, sample.y], normalizedPoint)
      : distance / Math.max(calibration.declared_resolution_px.width_px, calibration.declared_resolution_px.height_px);
    const score = distance + normalizedDistance * 100;
    if (score < bestDistance) {
      bestDistance = score;
      best = sample;
    }
  }
  return best;
}

function validateInputs(
  bundle: MultiViewObservationBundle,
  calibrationContext: CalibrationPromptContext,
  consensusReport: MultiViewConsensusReport,
  hypothesisSets: readonly PerViewObjectHypothesisSet[],
  qualityReports: ViewQualityReportSet | undefined,
  depthSamples: readonly DeclaredDepthSample[],
  policy: NormalizedPolicy,
  issues: ValidationIssue[],
): void {
  if (calibrationContext.bundle_ref !== bundle.bundle_ref) {
    issues.push(makeIssue("warning", "CalibrationBundleMismatch", "$.calibration_context.bundle_ref", "Calibration context does not match the active bundle.", "Assemble calibration context from the same synchronized bundle."));
  }
  if (consensusReport.bundle_ref !== bundle.bundle_ref) {
    issues.push(makeIssue("error", "ConsensusBundleMismatch", "$.consensus_report.bundle_ref", "Consensus report does not match the active bundle.", "Estimate spatial cues from matching consensus and bundle refs."));
  }
  if (qualityReports !== undefined && qualityReports.bundle_ref !== bundle.bundle_ref) {
    issues.push(makeIssue("warning", "BundleRefMismatch", "$.quality_reports.bundle_ref", "Quality report bundle differs from the active bundle.", "Use quality reports from the same synchronized bundle."));
  }
  if (hypothesisSets.some((set) => set.bundle_ref !== bundle.bundle_ref)) {
    issues.push(makeIssue("warning", "BundleRefMismatch", "$.hypothesis_sets.bundle_ref", "At least one hypothesis set differs from the active bundle.", "Use only current-bundle hypotheses for spatial estimates."));
  }
  if (policy.max_depth_m <= 0 || policy.min_depth_confidence < 0 || policy.min_quality_for_geometry < 0) {
    issues.push(makeIssue("error", "DepthSampleInvalid", "$.policy", "Spatial estimator policy thresholds must be positive or normalized.", "Provide finite non-negative thresholds and a positive max depth."));
  }
  if (HIDDEN_SPATIAL_PATTERN.test(JSON.stringify({ bundle, calibrationContext, consensusReport, hypothesisSets, qualityReports, depthSamples }))) {
    issues.push(makeIssue("error", "HiddenSpatialInputLeak", "$.inputs", "Spatial estimation inputs contain hidden simulator, backend, QA, debug, or object-ID evidence.", "Repair upstream perception records to declared sensor evidence only."));
  }
}

function validateRegion(region: VisualImageRegion, label: string): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const values = [region.x, region.y, region.width, region.height, region.center_x, region.center_y];
  if (!values.every(Number.isFinite) || region.width <= 0 || region.height <= 0) {
    issues.push(makeIssue("error", "RegionInvalid", `$.image_regions.${label}`, "Image region must contain finite positive dimensions.", "Normalize or repair visual image regions before spatial estimation."));
  }
  if (region.coordinate_space === "normalized_image") {
    if (region.x < 0 || region.y < 0 || region.x + region.width > 1 || region.y + region.height > 1 || region.center_x < 0 || region.center_x > 1 || region.center_y < 0 || region.center_y > 1) {
      issues.push(makeIssue("error", "RegionInvalid", `$.image_regions.${label}`, "Normalized image region must stay inside [0, 1].", "Clamp normalized image coordinates before spatial estimation."));
    }
  } else if (region.x < 0 || region.y < 0 || region.center_x < 0 || region.center_y < 0) {
    issues.push(makeIssue("error", "RegionInvalid", `$.image_regions.${label}`, "Pixel image region cannot contain negative coordinates.", "Use non-negative pixel image coordinates."));
  }
  return freezeArray(issues);
}

function validateDepthSample(sample: DeclaredDepthSample, policy: NormalizedPolicy): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (![sample.x, sample.y, sample.depth_m, sample.confidence].every(Number.isFinite) || sample.depth_m <= 0 || sample.depth_m > policy.max_depth_m) {
    issues.push(makeIssue("error", "DepthSampleInvalid", `$.depth_samples.${sample.sample_ref}`, "Depth sample requires finite positive depth within policy range.", "Use declared depth packets and reject holes or impossible metric values."));
  }
  if (sample.confidence < 0 || sample.confidence > 1) {
    issues.push(makeIssue("error", "DepthSampleInvalid", `$.depth_samples.${sample.sample_ref}.confidence`, "Depth confidence must be normalized to [0, 1].", "Normalize depth sample confidence."));
  }
  if (sample.coordinate_space === "normalized_image" && (sample.x < 0 || sample.x > 1 || sample.y < 0 || sample.y > 1)) {
    issues.push(makeIssue("error", "DepthSampleInvalid", `$.depth_samples.${sample.sample_ref}`, "Normalized depth sample coordinates must be inside [0, 1].", "Clamp or reject the sample."));
  }
  return freezeArray(issues);
}

function classifyReadiness(
  object: ConsensusObject,
  viewCues: readonly ViewSpatialCue[],
  relationCues: readonly VisualSpatialRelationCue[],
  consensusPoseReadiness: PoseReadiness,
  policy: NormalizedPolicy,
): SpatialReadinessLevel {
  const has3d = viewCues.some((cue) => cue.agent_frame_point_m !== undefined);
  const hasWristOrDepth = viewCues.some((cue) => cue.source_view_name === "wrist_or_mouth" || cue.source_view_name === "depth_primary" || cue.depth_status === "declared_depth_sample");
  const hasRelation = relationCues.some((cue) => cue.relation_is_visual && cue.confidence >= 0.55);
  const bestQuality = Math.max(...viewCues.map((cue) => cue.quality_score));
  if (bestQuality < policy.min_quality_for_geometry || object.status === "lost" || object.status === "occluded_or_out_of_view") {
    return object.identity_confidence > 0.3 ? "label_only" : "not_ready";
  }
  if (consensusPoseReadiness === "verification_ready" && object.pose_confidence >= policy.min_pose_confidence_for_verification && hasRelation) {
    return "verification_candidate_ready";
  }
  if ((consensusPoseReadiness === "manipulation_ready" || object.estimated_object_role === "target") && object.pose_confidence >= policy.min_pose_confidence_for_grasp && hasWristOrDepth) {
    return "grasp_candidate_ready";
  }
  if (has3d && object.pose_confidence >= policy.min_pose_confidence_for_approach) {
    return "approach_ready";
  }
  if (hasRelation || viewCues.length >= 2) {
    return "relation_ready";
  }
  return object.identity_confidence >= 0.3 ? "label_only" : "not_ready";
}

function actionForReadiness(readiness: SpatialReadinessLevel, viewCues: readonly ViewSpatialCue[], object: ConsensusObject): SpatialEstimatorAction {
  if (readiness === "not_ready") {
    return object.status === "lost" || object.status === "occluded_or_out_of_view" ? "reobserve" : "human_review";
  }
  if (viewCues.some((cue) => cue.depth_status === "declared_depth_unavailable") && (readiness === "grasp_candidate_ready" || readiness === "verification_candidate_ready")) {
    return "reobserve";
  }
  return "continue";
}

function decideEstimation(estimates: readonly VisualSpatialEstimate[], issues: readonly ValidationIssue[]): SpatialEstimateDecision {
  if (issues.some((issue) => issue.severity === "error")) {
    return "rejected";
  }
  if (estimates.length === 0 || estimates.every((estimate) => estimate.readiness === "not_ready" || estimate.readiness === "label_only")) {
    return "reobserve_required";
  }
  return issues.length > 0 || estimates.some((estimate) => estimate.readiness === "label_only") ? "estimated_with_warnings" : "estimated";
}

function chooseRecommendedAction(
  decision: SpatialEstimateDecision,
  estimates: readonly VisualSpatialEstimate[],
  issues: readonly ValidationIssue[],
  consensusReport: MultiViewConsensusReport,
): SpatialEstimatorAction {
  if (consensusReport.recommended_action === "safe_hold") {
    return "safe_hold";
  }
  if (consensusReport.recommended_action === "recapture_tight_sync") {
    return "recapture_tight_sync";
  }
  if (issues.some((issue) => issue.code === "HiddenSpatialInputLeak")) {
    return "human_review";
  }
  if (decision === "rejected") {
    return "human_review";
  }
  if (decision === "reobserve_required" || estimates.some((estimate) => estimate.recommended_action === "reobserve")) {
    return "reobserve";
  }
  return "continue";
}

function uncertaintyForCue(
  qualityScore: number,
  poseConfidence: number,
  depthSample: DeclaredDepthSample | undefined,
  angularExtent: readonly [number, number] | undefined,
  calibration: CalibrationPromptViewContext,
  policy: NormalizedPolicy,
): SpatialUncertainty {
  const qualityPenalty = 1 - clamp01(Math.min(qualityScore, poseConfidence));
  const resolutionScale = Math.max(calibration.declared_resolution_px.width_px, calibration.declared_resolution_px.height_px);
  const pixelSigma = round6(Math.max(1, resolutionScale * (0.0025 + qualityPenalty * 0.012)));
  const angularBase = angularExtent === undefined ? 0.04 : Math.max(angularExtent[0], angularExtent[1]) * 0.18;
  const angularSigma = round6(Math.max(0.002, angularBase + qualityPenalty * 0.03));
  const basis = [
    `quality_score=${formatScore(qualityScore)}`,
    `pose_confidence=${formatScore(poseConfidence)}`,
    depthSample === undefined ? "no_declared_depth_sample" : `depth_sample=${depthSample.sample_ref}`,
  ];
  if (depthSample === undefined) {
    return Object.freeze({
      pixel_sigma_px: pixelSigma,
      angular_sigma_rad: angularSigma,
      confidence: roundScore(Math.min(qualityScore, poseConfidence, policy.allow_rgb_only_estimates ? 0.62 : 0.35)),
      basis: freezeArray(basis),
    });
  }
  const depthQualityMultiplier = depthSample.depth_quality === "high" ? 0.035 : depthSample.depth_quality === "medium" || depthSample.depth_quality === undefined ? 0.06 : 0.11;
  const depthSigma = round6(Math.max(0.005, depthSample.depth_m * (depthQualityMultiplier + (1 - depthSample.confidence) * 0.08)));
  return Object.freeze({
    pixel_sigma_px: pixelSigma,
    angular_sigma_rad: angularSigma,
    depth_sigma_m: depthSigma,
    lateral_sigma_m: round6(Math.tan(angularSigma) * depthSample.depth_m + depthSigma * 0.15),
    confidence: roundScore(Math.min(qualityScore, poseConfidence, depthSample.confidence)),
    basis: freezeArray([...basis, `depth_quality=${depthSample.depth_quality ?? "medium"}`]),
  });
}

function combineUncertainty(
  cues: readonly ViewSpatialCue[],
  relationCues: readonly VisualSpatialRelationCue[],
  object: ConsensusObject,
): SpatialUncertainty {
  const bestCue = strongestCue(cues);
  const relationBonus = relationCues.some((cue) => cue.relation_is_visual && cue.confidence >= 0.7) ? 0.06 : 0;
  const confidence = roundScore(Math.max(0, (bestCue?.uncertainty.confidence ?? 0) + relationBonus));
  return Object.freeze({
    pixel_sigma_px: round6(weightedMean(cues.map((cue) => cue.uncertainty.pixel_sigma_px), cues.map((cue) => cue.quality_score))),
    angular_sigma_rad: round6(weightedMean(cues.map((cue) => cue.uncertainty.angular_sigma_rad), cues.map((cue) => cue.quality_score))),
    depth_sigma_m: optionalWeightedMean(cues.map((cue) => cue.uncertainty.depth_sigma_m), cues.map((cue) => cue.quality_score)),
    lateral_sigma_m: optionalWeightedMean(cues.map((cue) => cue.uncertainty.lateral_sigma_m), cues.map((cue) => cue.quality_score)),
    confidence,
    basis: freezeArray([
      `object_identity=${formatScore(object.identity_confidence)}`,
      `object_pose=${formatScore(object.pose_confidence)}`,
      `view_cues=${cues.length}`,
      `relation_cues=${relationCues.length}`,
    ]),
  });
}

function representativeAgentPoint(cues: readonly ViewSpatialCue[]): Vector3 | undefined {
  const points = cues.filter((cue): cue is ViewSpatialCue & { readonly agent_frame_point_m: Vector3 } => cue.agent_frame_point_m !== undefined);
  if (points.length === 0) {
    return undefined;
  }
  const weights = points.map((cue) => Math.max(0.001, cue.uncertainty.confidence));
  const total = weights.reduce((sum, value) => sum + value, 0);
  const x = points.reduce((sum, cue, index) => sum + cue.agent_frame_point_m[0] * (weights[index] ?? 1), 0) / total;
  const y = points.reduce((sum, cue, index) => sum + cue.agent_frame_point_m[1] * (weights[index] ?? 1), 0) / total;
  const z = points.reduce((sum, cue, index) => sum + cue.agent_frame_point_m[2] * (weights[index] ?? 1), 0) / total;
  return freezeVector([round6(x), round6(y), round6(z)]);
}

function representativeNormalizedPoint(cues: readonly ViewSpatialCue[]): readonly [number, number] | undefined {
  const cue = strongestCue(cues);
  return cue?.normalized_image_point;
}

function strongestCue(cues: readonly ViewSpatialCue[]): ViewSpatialCue | undefined {
  return [...cues].sort((a, b) =>
    b.uncertainty.confidence - a.uncertainty.confidence
    || Number(b.agent_frame_point_m !== undefined) - Number(a.agent_frame_point_m !== undefined)
    || viewSortRank(a.source_view_name) - viewSortRank(b.source_view_name))[0];
}

function summarizeEstimate(
  object: ConsensusObject,
  readiness: SpatialReadinessLevel,
  cues: readonly ViewSpatialCue[],
  relationCues: readonly VisualSpatialRelationCue[],
  uncertainty: SpatialUncertainty,
): string {
  const depthCount = cues.filter((cue) => cue.depth_status === "declared_depth_sample").length;
  const views = uniqueSorted(cues.map((cue) => cue.source_view_name)).join(",") || "none";
  const relations = relationCues.map((cue) => `${cue.relation}:${cue.target_label}`).join(",") || "none";
  return `${object.label} readiness=${readiness}; views=${views}; depth_samples=${depthCount}; relations=${relations}; uncertainty_confidence=${formatScore(uncertainty.confidence)}.`;
}

function summarizeReadiness(estimates: readonly VisualSpatialEstimate[]): readonly SpatialReadinessSummaryRow[] {
  const rows: SpatialReadinessSummaryRow[] = [];
  for (const readiness of readinessOrder()) {
    const matching = estimates.filter((estimate) => estimate.readiness === readiness);
    if (matching.length > 0) {
      rows.push(Object.freeze({
        readiness,
        count: matching.length,
        labels: freezeArray(matching.map((estimate) => estimate.label).sort()),
      }));
    }
  }
  return freezeArray(rows);
}

function calibrationFor(context: CalibrationPromptContext, viewName: CanonicalViewName, packetRef: Ref): CalibrationPromptViewContext | undefined {
  return context.view_contexts.find((view) => view.canonical_view_name === viewName && (view.packet_ref === undefined || view.packet_ref === packetRef));
}

function qualityFor(qualityReports: ViewQualityReportSet | undefined, viewName: CanonicalViewName): ViewQualityReport | undefined {
  return qualityReports?.per_view_reports.find((report) => report.view_name === viewName);
}

function transformPoint(transform: Transform, point: Vector3): Vector3 {
  const rotated = rotateVector(transform.orientation_xyzw, point);
  return freezeVector([
    round6(rotated[0] + transform.position_m[0]),
    round6(rotated[1] + transform.position_m[1]),
    round6(rotated[2] + transform.position_m[2]),
  ]);
}

function rotateVector(quaternion: readonly [number, number, number, number], vector: Vector3): Vector3 {
  const [qx, qy, qz, qw] = quaternion;
  const uv = cross([qx, qy, qz], vector);
  const uuv = cross([qx, qy, qz], uv);
  const scaledUv = scaleVector(uv, 2 * qw);
  const scaledUuv = scaleVector(uuv, 2);
  return freezeVector([
    round6(vector[0] + scaledUv[0] + scaledUuv[0]),
    round6(vector[1] + scaledUv[1] + scaledUuv[1]),
    round6(vector[2] + scaledUv[2] + scaledUuv[2]),
  ]);
}

function cross(a: Vector3, b: Vector3): Vector3 {
  return freezeVector([
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]);
}

function normalizeVector(vector: Vector3): Vector3 {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (!Number.isFinite(length) || length <= 1e-12) {
    return freezeVector([0, 0, 1]);
  }
  return freezeVector([round6(vector[0] / length), round6(vector[1] / length), round6(vector[2] / length)]);
}

function scaleVector(vector: Vector3, scalar: number): Vector3 {
  return freezeVector([round6(vector[0] * scalar), round6(vector[1] * scalar), round6(vector[2] * scalar)]);
}

function inferTaskPhaseFromReadiness(readiness: PoseReadiness): PerceptionTaskPhase {
  switch (readiness) {
    case "manipulation_ready":
      return "grasp";
    case "verification_ready":
      return "verify";
    case "planning_ready":
      return "planning";
    case "search_ready":
    case "not_ready":
      return "reobserve";
  }
}

function stableRegionKey(region: VisualImageRegion): string {
  return [region.source_view_name, region.coordinate_space, region.x, region.y, region.width, region.height, region.center_x, region.center_y].map(String).join("_");
}

function freezeTuple2(value: readonly [number, number]): readonly [number, number] {
  return Object.freeze([round6(value[0]), round6(value[1])] as const);
}

function freezeVector(value: readonly [number, number, number]): Vector3 {
  return Object.freeze([round6(value[0]), round6(value[1]), round6(value[2])] as const);
}

function euclidean2(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function weightedMean(values: readonly number[], weights: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  let total = 0;
  let weightTotal = 0;
  for (const [index, value] of values.entries()) {
    const weight = Math.max(0.001, weights[index] ?? 1);
    total += value * weight;
    weightTotal += weight;
  }
  return weightTotal <= 0 ? 0 : total / weightTotal;
}

function optionalWeightedMean(values: readonly (number | undefined)[], weights: readonly number[]): number | undefined {
  const pairs = values
    .map((value, index) => value === undefined ? undefined : { value, weight: weights[index] ?? 1 })
    .filter((item): item is { readonly value: number; readonly weight: number } => item !== undefined);
  if (pairs.length === 0) {
    return undefined;
  }
  return round6(weightedMean(pairs.map((item) => item.value), pairs.map((item) => item.weight)));
}

function compareEstimates(a: VisualSpatialEstimate, b: VisualSpatialEstimate): number {
  return readinessRank(b.readiness) - readinessRank(a.readiness)
    || b.uncertainty.confidence - a.uncertainty.confidence
    || a.label.localeCompare(b.label)
    || a.estimate_ref.localeCompare(b.estimate_ref);
}

function compareViewCues(a: ViewSpatialCue, b: ViewSpatialCue): number {
  return Number(b.agent_frame_point_m !== undefined) - Number(a.agent_frame_point_m !== undefined)
    || b.uncertainty.confidence - a.uncertainty.confidence
    || viewSortRank(a.source_view_name) - viewSortRank(b.source_view_name)
    || a.cue_ref.localeCompare(b.cue_ref);
}

function compareRelationCues(a: VisualSpatialRelationCue, b: VisualSpatialRelationCue): number {
  return b.confidence - a.confidence
    || a.relation.localeCompare(b.relation)
    || a.target_label.localeCompare(b.target_label)
    || a.relation_cue_ref.localeCompare(b.relation_cue_ref);
}

function readinessOrder(): readonly SpatialReadinessLevel[] {
  return freezeArray(["verification_candidate_ready", "grasp_candidate_ready", "approach_ready", "relation_ready", "label_only", "not_ready"] as const);
}

function readinessRank(readiness: SpatialReadinessLevel): number {
  return readinessOrder().length - readinessOrder().indexOf(readiness);
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

function mergePolicy(base: NormalizedPolicy, override: VisualSpatialEstimatorPolicy): NormalizedPolicy {
  return Object.freeze({
    min_quality_for_geometry: clamp01(override.min_quality_for_geometry ?? base.min_quality_for_geometry),
    min_depth_confidence: clamp01(override.min_depth_confidence ?? base.min_depth_confidence),
    min_pose_confidence_for_approach: clamp01(override.min_pose_confidence_for_approach ?? base.min_pose_confidence_for_approach),
    min_pose_confidence_for_grasp: clamp01(override.min_pose_confidence_for_grasp ?? base.min_pose_confidence_for_grasp),
    min_pose_confidence_for_verification: clamp01(override.min_pose_confidence_for_verification ?? base.min_pose_confidence_for_verification),
    max_depth_m: positiveOrDefault(override.max_depth_m, base.max_depth_m),
    allow_rgb_only_estimates: override.allow_rgb_only_estimates ?? base.allow_rgb_only_estimates,
  });
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return freezeArray([...new Set(values)].sort());
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function roundScore(value: number): number {
  return Math.round(clamp01(value) * 1000) / 1000;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function formatScore(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "") : "invalid";
}

function makeIssue(severity: ValidationSeverity, code: VisualSpatialIssueCode, path: string, message: string, remediation: string): ValidationIssue {
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
