/**
 * Crop and zoom planner for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md`
 * sections 9.6.5, 9.8.1, 9.10, 9.11, 9.17, 9.18, 9.19, and 9.20.
 *
 * The planner selects task-relevant visual crops for Gemini-facing prompt
 * packets. It preserves source view, packet, coordinate region, margin, scale,
 * and surrounding context metadata; it pairs broad and focused evidence when
 * manipulation or verification needs it; and it drops duplicate low-value crops
 * before dropping required views or safety-critical crops.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import type { CanonicalViewName } from "./view_name_registry";
import type { MultiViewObservationBundle, PerceptionTaskPhase, SynchronizedViewPacket } from "./multi_view_synchronizer";
import type { ViewQualityReport, ViewQualityReportSet } from "./view_quality_assessor";
import type { CropReason, CropRegionDefinition, VisualAttentionRequest } from "./visual_prompt_packager";
import type {
  PerViewObjectHypothesisSet,
  VisualImageRegion,
  VisualObjectHypothesis,
} from "./object_hypothesis_service";
import type {
  ConsensusObject,
  MultiViewConsensusReport,
  RecommendedNextView,
} from "./cross_view_consensus_engine";
import type { OcclusionReport, OcclusionReobserveRequest } from "./occlusion_reasoner";

export const CROP_AND_ZOOM_PLANNER_SCHEMA_VERSION = "mebsuta.crop_and_zoom_planner.v1" as const;

const HIDDEN_CROP_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|segmentation truth|debug buffer|debug overlay|qa_success|qa_label|qa_only|simulator truth|mesh_name|asset_id)/i;

export type CropSelectionDecision = "planned" | "planned_with_warnings" | "rejected";
export type CropPlannerAction = "continue" | "reobserve" | "recapture" | "safe_hold" | "human_review";
export type CropPriorityClass = "required" | "high" | "normal" | "low";
export type CropPlannerIssueCode =
  | "BundleRefMismatch"
  | "HiddenCropInputLeak"
  | "CropBudgetInvalid"
  | "SourceViewMissing"
  | "SourceViewLowQuality"
  | "RegionInvalid"
  | "ContextMarginTooSmall"
  | "RequiredCropOmitted"
  | "NoCropsPlanned";

/**
 * Crop planning policy and budget.
 */
export interface CropAndZoomPolicy {
  readonly max_crop_count?: number;
  readonly max_estimated_tokens?: number;
  readonly crop_token_cost?: number;
  readonly required_view_names?: readonly CanonicalViewName[];
  readonly min_quality_for_crop?: number;
  readonly min_context_margin_fraction?: number;
  readonly broad_crop_scale?: number;
  readonly focused_crop_scale?: number;
  readonly include_broad_context_pair?: boolean;
}

/**
 * Optional external attention point supplied by a model response, validator, or
 * UI. Coordinates are normalized unless `region` says otherwise.
 */
export interface CropAttentionPoint {
  readonly attention_ref: Ref;
  readonly source_view_name: CanonicalViewName;
  readonly label?: string;
  readonly reason: CropReason;
  readonly priority: number;
  readonly point?: {
    readonly x: number;
    readonly y: number;
  };
  readonly region?: CropRegionDefinition;
  readonly required?: boolean;
}

/**
 * File 09 crop request with full source metadata.
 */
export interface CropRequest {
  readonly crop_ref: Ref;
  readonly source_view_name: CanonicalViewName;
  readonly source_camera_packet_ref: Ref;
  readonly crop_reason: CropReason;
  readonly target_hypothesis_ref?: Ref;
  readonly target_label?: string;
  readonly region_definition: CropRegionDefinition;
  readonly source_timestamp_midpoint_s: number;
  readonly source_quality_score: number;
  readonly priority: number;
  readonly priority_class: CropPriorityClass;
  readonly required: boolean;
  readonly estimated_token_cost: number;
  readonly context_preservation_ok: boolean;
  readonly paired_broad_crop_ref?: Ref;
  readonly prompt_attention_request: VisualAttentionRequest;
  readonly determinism_hash: string;
}

/**
 * Crop candidate dropped by budget, quality, duplication, or safety validation.
 */
export interface OmittedCropRequest {
  readonly crop_ref: Ref;
  readonly source_view_name?: CanonicalViewName;
  readonly target_label?: string;
  readonly reason: "budget_exceeded" | "duplicate_low_value" | "source_missing" | "low_quality_source" | "invalid_region";
  readonly rationale: string;
}

/**
 * File 09 crop request set consumed by visual prompt packaging.
 */
export interface CropRequestSet {
  readonly schema_version: typeof CROP_AND_ZOOM_PLANNER_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md";
  readonly crop_request_set_ref: Ref;
  readonly bundle_ref: Ref;
  readonly task_phase: PerceptionTaskPhase;
  readonly crop_requests: readonly CropRequest[];
  readonly visual_attention_requests: readonly VisualAttentionRequest[];
  readonly omitted_crops: readonly OmittedCropRequest[];
  readonly required_view_names: readonly CanonicalViewName[];
  readonly estimated_crop_tokens: number;
  readonly max_estimated_tokens: number;
  readonly decision: CropSelectionDecision;
  readonly recommended_action: CropPlannerAction;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
  readonly cognitive_visibility: "perception_crop_request_set";
}

interface NormalizedPolicy {
  readonly max_crop_count: number;
  readonly max_estimated_tokens: number;
  readonly crop_token_cost: number;
  readonly required_view_names: readonly CanonicalViewName[];
  readonly min_quality_for_crop: number;
  readonly min_context_margin_fraction: number;
  readonly broad_crop_scale: number;
  readonly focused_crop_scale: number;
  readonly include_broad_context_pair: boolean;
}

interface CropCandidate {
  readonly crop_ref: Ref;
  readonly source_view_name: CanonicalViewName;
  readonly packet: SynchronizedViewPacket;
  readonly crop_reason: CropReason;
  readonly target_hypothesis_ref?: Ref;
  readonly target_label?: string;
  readonly region_definition: CropRegionDefinition;
  readonly source_quality_score: number;
  readonly priority: number;
  readonly required: boolean;
  readonly estimated_token_cost: number;
  readonly context_note: string;
}

const DEFAULT_POLICY: NormalizedPolicy = Object.freeze({
  max_crop_count: 8,
  max_estimated_tokens: 7_000,
  crop_token_cost: 900,
  required_view_names: freezeArray(["front_primary"] as readonly CanonicalViewName[]),
  min_quality_for_crop: 0.42,
  min_context_margin_fraction: 0.1,
  broad_crop_scale: 1.65,
  focused_crop_scale: 1.12,
  include_broad_context_pair: true,
});

/**
 * Executable File 09 `CropAndZoomPlanner`.
 */
export class CropAndZoomPlanner {
  private readonly policy: NormalizedPolicy;

  public constructor(policy: CropAndZoomPolicy = {}) {
    this.policy = mergePolicy(DEFAULT_POLICY, policy);
  }

  /**
   * Plans context-preserving crop requests from current bundle evidence,
   * consensus objects, occlusion needs, and optional attention points.
   */
  public planCropAndZoomRequests(
    bundle: MultiViewObservationBundle,
    viewQualityReports: ViewQualityReportSet,
    consensusReport: MultiViewConsensusReport,
    occlusionReport: OcclusionReport,
    hypothesisSets: readonly PerViewObjectHypothesisSet[] = [],
    attentionPoints: readonly CropAttentionPoint[] = [],
    policy: CropAndZoomPolicy = {},
  ): CropRequestSet {
    const activePolicy = mergePolicy(this.policy, policy);
    const issues: ValidationIssue[] = [];
    validateInputs(bundle, viewQualityReports, consensusReport, occlusionReport, hypothesisSets, attentionPoints, activePolicy, issues);

    const candidates = [
      ...candidatesFromHypotheses(bundle, viewQualityReports, hypothesisSets, activePolicy, issues),
      ...candidatesFromConsensus(bundle, viewQualityReports, consensusReport, activePolicy, issues),
      ...candidatesFromOcclusion(bundle, viewQualityReports, occlusionReport, consensusReport, activePolicy, issues),
      ...candidatesFromAttention(bundle, viewQualityReports, attentionPoints, activePolicy, issues),
    ].sort(compareCandidates);
    const selection = selectCrops(candidates, activePolicy, issues);
    const cropRequests = selection.selected.map((candidate, index, selected) => toCropRequest(candidate, activePolicy, pairedBroadRef(candidate, selected)));
    if (cropRequests.length === 0) {
      issues.push(makeIssue("error", "NoCropsPlanned", "$.crop_requests", "CropAndZoomPlanner produced no usable crop requests.", "Provide current view evidence, object regions, or reobserve requests before crop planning."));
    }
    const estimatedTokens = cropRequests.reduce((sum, crop) => sum + crop.estimated_token_cost, 0);
    const decision = decideCropSelection(cropRequests, selection.omitted, issues);
    const recommendedAction = chooseRecommendedAction(decision, selection.omitted, issues, occlusionReport);
    const setRef = makeRef("crop_request_set", bundle.bundle_ref, cropRequests.map((crop) => crop.crop_ref).join(":"));
    const sortedCropRequests = [...cropRequests].sort(compareCropRequests);
    const sortedOmittedCrops = [...selection.omitted].sort(compareOmitted);
    const shell = {
      setRef,
      bundle: bundle.bundle_ref,
      crops: sortedCropRequests.map((crop) => [crop.crop_ref, crop.crop_reason, crop.source_view_name]),
      omitted: sortedOmittedCrops.map((crop) => [crop.crop_ref, crop.reason]),
      issues: issues.map((issue) => issue.code),
    };
    return Object.freeze({
      schema_version: CROP_AND_ZOOM_PLANNER_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md",
      crop_request_set_ref: setRef,
      bundle_ref: bundle.bundle_ref,
      task_phase: bundle.task_phase,
      crop_requests: freezeArray(sortedCropRequests),
      visual_attention_requests: freezeArray(sortedCropRequests.map((crop) => crop.prompt_attention_request)),
      omitted_crops: freezeArray(sortedOmittedCrops),
      required_view_names: activePolicy.required_view_names,
      estimated_crop_tokens: estimatedTokens,
      max_estimated_tokens: activePolicy.max_estimated_tokens,
      decision,
      recommended_action: recommendedAction,
      issues: freezeArray(issues),
      ok: decision !== "rejected",
      determinism_hash: computeDeterminismHash(shell),
      cognitive_visibility: "perception_crop_request_set",
    });
  }
}

/**
 * Functional API for File 09 crop planning.
 */
export function planCropAndZoomRequests(
  bundle: MultiViewObservationBundle,
  viewQualityReports: ViewQualityReportSet,
  consensusReport: MultiViewConsensusReport,
  occlusionReport: OcclusionReport,
  hypothesisSets: readonly PerViewObjectHypothesisSet[] = [],
  attentionPoints: readonly CropAttentionPoint[] = [],
  policy: CropAndZoomPolicy = {},
): CropRequestSet {
  return new CropAndZoomPlanner(policy).planCropAndZoomRequests(bundle, viewQualityReports, consensusReport, occlusionReport, hypothesisSets, attentionPoints, policy);
}

function candidatesFromHypotheses(
  bundle: MultiViewObservationBundle,
  quality: ViewQualityReportSet,
  sets: readonly PerViewObjectHypothesisSet[],
  policy: NormalizedPolicy,
  issues: ValidationIssue[],
): readonly CropCandidate[] {
  const candidates: CropCandidate[] = [];
  for (const set of sets) {
    for (const hypothesis of set.hypotheses) {
      const reason = reasonForHypothesis(hypothesis);
      const regions = hypothesis.image_regions.length > 0 ? hypothesis.image_regions : defaultRegionsForHypothesis(hypothesis);
      for (const region of regions) {
        const candidate = candidateFromRegion(bundle, quality, region, reason, hypothesis.hypothesis_ref, hypothesis.label, priorityForHypothesis(hypothesis), hypothesis.estimated_object_role === "target", policy, issues);
        if (candidate !== undefined) {
          candidates.push(candidate);
          if (policy.include_broad_context_pair && shouldPairBroadCrop(reason, hypothesis.pose_confidence)) {
            candidates.push(makeBroadPair(candidate, policy));
          }
        }
      }
    }
  }
  return freezeArray(candidates);
}

function candidatesFromConsensus(
  bundle: MultiViewObservationBundle,
  quality: ViewQualityReportSet,
  consensus: MultiViewConsensusReport,
  policy: NormalizedPolicy,
  issues: ValidationIssue[],
): readonly CropCandidate[] {
  const candidates: CropCandidate[] = [];
  for (const object of consensus.consensus_objects) {
    for (const viewName of priorityViewsForObject(object)) {
      const packet = bundle.view_packets[viewName];
      if (packet === undefined) {
        issues.push(makeIssue("warning", "SourceViewMissing", `$.consensus_objects.${object.consensus_object_ref}.supporting_view_names`, `Consensus object ${object.label} requests crop from missing view ${viewName}.`, "Reobserve the source view before crop packaging."));
        continue;
      }
      const sourceRegion = regionFromEvidence(object, viewName, policy.focused_crop_scale);
      candidates.push(makeCandidate(packet, qualityFor(quality, viewName), object.label, object.consensus_object_ref, reasonForConsensusObject(object), sourceRegion, priorityForConsensusObject(object), object.estimated_object_role === "target", policy, issues));
    }
  }
  const next = consensus.recommended_next_view;
  if (next !== undefined) {
    const packet = bundle.view_packets[next.requested_view];
    if (packet !== undefined) {
      candidates.push(makeCandidate(packet, qualityFor(quality, next.requested_view), next.requested_crop_label, undefined, reasonForNextView(next), defaultRegion(next.requested_view, policy.broad_crop_scale, "next-view crop keeps surrounding scene context"), next.priority + 8, true, policy, issues));
    }
  }
  return freezeArray(candidates);
}

function candidatesFromOcclusion(
  bundle: MultiViewObservationBundle,
  quality: ViewQualityReportSet,
  occlusionReport: OcclusionReport,
  consensusReport: MultiViewConsensusReport,
  policy: NormalizedPolicy,
  issues: ValidationIssue[],
): readonly CropCandidate[] {
  const candidates: CropCandidate[] = [];
  for (const request of occlusionReport.reobserve_requests) {
    const packet = bundle.view_packets[request.requested_view];
    if (packet === undefined) {
      issues.push(makeIssue("warning", "SourceViewMissing", `$.reobserve_requests.${request.request_ref}`, `Occlusion reobserve view ${request.requested_view} is not present in the current bundle.`, "Capture the requested view before crop planning."));
      continue;
    }
    const object = request.target_label === undefined ? undefined : consensusReport.consensus_objects.find((candidate) => normalizeLabel(candidate.label) === normalizeLabel(request.target_label ?? ""));
    const region = object === undefined ? defaultRegion(request.requested_view, policy.broad_crop_scale, request.reason) : regionFromEvidence(object, request.requested_view, policy.broad_crop_scale);
    candidates.push(makeCandidate(packet, qualityFor(quality, request.requested_view), request.target_label, object?.consensus_object_ref, reasonForRequiredBefore(request.required_before), region, request.priority + 12, true, policy, issues));
  }
  for (const guard of occlusionReport.false_absence_guards) {
    for (const viewName of guard.required_evidence) {
      const packet = bundle.view_packets[viewName];
      if (packet !== undefined) {
        candidates.push(makeCandidate(packet, qualityFor(quality, viewName), guard.label, undefined, "object_identification", defaultRegion(viewName, policy.broad_crop_scale, guard.reason), 84, true, policy, issues));
      }
    }
  }
  return freezeArray(candidates);
}

function candidatesFromAttention(
  bundle: MultiViewObservationBundle,
  quality: ViewQualityReportSet,
  points: readonly CropAttentionPoint[],
  policy: NormalizedPolicy,
  issues: ValidationIssue[],
): readonly CropCandidate[] {
  const candidates: CropCandidate[] = [];
  for (const point of points) {
    const packet = bundle.view_packets[point.source_view_name];
    if (packet === undefined) {
      issues.push(makeIssue("warning", "SourceViewMissing", `$.attention_points.${point.attention_ref}.source_view_name`, `Attention point view ${point.source_view_name} is missing.`, "Capture the source view before creating crop requests."));
      continue;
    }
    const region = point.region ?? regionFromPoint(point.point, point.source_view_name, policy.focused_crop_scale, `attention crop for ${point.label ?? point.reason}`);
    candidates.push(makeCandidate(packet, qualityFor(quality, point.source_view_name), point.label, point.attention_ref, point.reason, region, point.priority, point.required === true, policy, issues));
  }
  return freezeArray(candidates);
}

function candidateFromRegion(
  bundle: MultiViewObservationBundle,
  quality: ViewQualityReportSet,
  region: VisualImageRegion,
  reason: CropReason,
  targetRef: Ref,
  label: string,
  priority: number,
  required: boolean,
  policy: NormalizedPolicy,
  issues: ValidationIssue[],
): CropCandidate | undefined {
  const packet = bundle.view_packets[region.source_view_name];
  if (packet === undefined) {
    issues.push(makeIssue("warning", "SourceViewMissing", `$.image_regions.${region.source_view_name}`, `Image region for ${label} refers to missing view ${region.source_view_name}.`, "Use only current bundle views for crop planning."));
    return undefined;
  }
  const expanded = expandRegion(region, policy.focused_crop_scale, policy.min_context_margin_fraction, region.region_summary);
  return makeCandidate(packet, qualityFor(quality, region.source_view_name), label, targetRef, reason, expanded, priority, required, policy, issues);
}

function makeCandidate(
  packet: SynchronizedViewPacket,
  quality: ViewQualityReport | undefined,
  label: string | undefined,
  targetRef: Ref | undefined,
  reason: CropReason,
  region: CropRegionDefinition,
  priority: number,
  required: boolean,
  policy: NormalizedPolicy,
  issues: ValidationIssue[],
): CropCandidate {
  const sourceQuality = quality?.quality_score ?? packet.confidence;
  const validation = validateRegion(region, packet.canonical_view_name, policy);
  issues.push(...validation);
  if (sourceQuality < policy.min_quality_for_crop && !required) {
    issues.push(makeIssue("warning", "SourceViewLowQuality", `$.view_quality.${packet.canonical_view_name}`, `Source view ${packet.canonical_view_name} quality ${formatScore(sourceQuality)} is below crop threshold.`, "Prefer a clearer source view or reobserve."));
  }
  const cropRef = makeRef("crop", reason, packet.packet_ref, targetRef ?? label ?? "scene", stableRegionKey(region));
  return Object.freeze({
    crop_ref: cropRef,
    source_view_name: packet.canonical_view_name,
    packet,
    crop_reason: reason,
    target_hypothesis_ref: targetRef,
    target_label: label,
    region_definition: region,
    source_quality_score: sourceQuality,
    priority,
    required,
    estimated_token_cost: policy.crop_token_cost,
    context_note: region.retain_context_note,
  });
}

function selectCrops(
  candidates: readonly CropCandidate[],
  policy: NormalizedPolicy,
  issues: ValidationIssue[],
): { readonly selected: readonly CropCandidate[]; readonly omitted: readonly OmittedCropRequest[] } {
  const selected: CropCandidate[] = [];
  const omitted: OmittedCropRequest[] = [];
  let tokens = 0;
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const duplicateKey = `${candidate.source_view_name}:${candidate.crop_reason}:${candidate.target_label ?? candidate.target_hypothesis_ref ?? ""}:${stableRegionKey(candidate.region_definition)}`;
    if (seen.has(duplicateKey) && !candidate.required) {
      omitted.push(omit(candidate, "duplicate_low_value", "Duplicate low-value crop was dropped before required or higher-priority crops."));
      continue;
    }
    const invalid = validateRegion(candidate.region_definition, candidate.source_view_name, policy).some((issue) => issue.severity === "error");
    if (invalid) {
      omitted.push(omit(candidate, "invalid_region", "Crop region failed coordinate or context validation."));
      continue;
    }
    const overCount = selected.length >= policy.max_crop_count;
    const overBudget = tokens + candidate.estimated_token_cost > policy.max_estimated_tokens;
    if ((overCount || overBudget) && !candidate.required) {
      omitted.push(omit(candidate, "budget_exceeded", "Optional crop exceeded count or media-token budget."));
      continue;
    }
    if ((overCount || overBudget) && candidate.required) {
      issues.push(makeIssue("error", "RequiredCropOmitted", "$.crop_budget", `Required crop ${candidate.crop_ref} exceeds crop budget.`, "Increase crop budget or reduce required crop inputs."));
    }
    selected.push(candidate);
    seen.add(duplicateKey);
    tokens += candidate.estimated_token_cost;
  }
  return Object.freeze({ selected: freezeArray(selected), omitted: freezeArray(omitted) });
}

function toCropRequest(candidate: CropCandidate, policy: NormalizedPolicy, pairedBroadCropRef: Ref | undefined): CropRequest {
  const priorityClass = priorityClassFor(candidate);
  const attention: VisualAttentionRequest = Object.freeze({
    request_ref: candidate.crop_ref,
    source_view_name: candidate.source_view_name,
    crop_reason: candidate.crop_reason,
    priority: candidate.priority,
    required: candidate.required,
    target_hypothesis_ref: candidate.target_hypothesis_ref,
    region_definition: candidate.region_definition,
    summary_hint: `${candidate.crop_reason} crop for ${candidate.target_label ?? "scene"}; ${candidate.context_note}`,
    estimated_token_cost: candidate.estimated_token_cost,
  });
  const shell = {
    crop: candidate.crop_ref,
    packet: candidate.packet.packet_ref,
    reason: candidate.crop_reason,
    region: candidate.region_definition,
    target: candidate.target_hypothesis_ref ?? candidate.target_label,
  };
  return Object.freeze({
    crop_ref: candidate.crop_ref,
    source_view_name: candidate.source_view_name,
    source_camera_packet_ref: candidate.packet.packet_ref,
    crop_reason: candidate.crop_reason,
    target_hypothesis_ref: candidate.target_hypothesis_ref,
    target_label: candidate.target_label,
    region_definition: candidate.region_definition,
    source_timestamp_midpoint_s: candidate.packet.midpoint_s,
    source_quality_score: roundScore(candidate.source_quality_score),
    priority: candidate.priority,
    priority_class: priorityClass,
    required: candidate.required,
    estimated_token_cost: candidate.estimated_token_cost,
    context_preservation_ok: candidate.region_definition.margin_fraction >= policy.min_context_margin_fraction,
    paired_broad_crop_ref: pairedBroadCropRef,
    prompt_attention_request: attention,
    determinism_hash: computeDeterminismHash(shell),
  });
}

function defaultRegionsForHypothesis(hypothesis: VisualObjectHypothesis): readonly VisualImageRegion[] {
  return freezeArray(hypothesis.evidence_views.map((view) => Object.freeze({
    source_view_name: view.source_view_name,
    source_camera_packet_ref: view.source_camera_packet_ref,
    coordinate_space: "normalized_image" as const,
    x: 0.2,
    y: 0.2,
    width: 0.6,
    height: 0.6,
    center_x: 0.5,
    center_y: 0.5,
    area_fraction: 0.36,
    region_summary: `fallback broad region for ${hypothesis.label}; source evidence did not include a tighter region`,
  })));
}

function expandRegion(region: VisualImageRegion, scale: number, margin: number, contextNote: string): CropRegionDefinition {
  if (region.coordinate_space === "pixel_image") {
    const scaledWidth = region.width * scale;
    const scaledHeight = region.height * scale;
    return Object.freeze({
      coordinate_space: "pixel_image",
      x: round6(Math.max(0, region.center_x - scaledWidth / 2)),
      y: round6(Math.max(0, region.center_y - scaledHeight / 2)),
      width: round6(scaledWidth),
      height: round6(scaledHeight),
      margin_fraction: round6(Math.max(margin, (scale - 1) / 2)),
      scale_factor: round6(scale),
      retain_context_note: sanitizeText(contextNote),
    });
  }
  const scaledWidth = Math.min(1, region.width * scale + margin * 2);
  const scaledHeight = Math.min(1, region.height * scale + margin * 2);
  return Object.freeze({
    coordinate_space: "normalized_image",
    x: round6(clamp01(region.center_x - scaledWidth / 2)),
    y: round6(clamp01(region.center_y - scaledHeight / 2)),
    width: round6(Math.min(scaledWidth, 1 - clamp01(region.center_x - scaledWidth / 2))),
    height: round6(Math.min(scaledHeight, 1 - clamp01(region.center_y - scaledHeight / 2))),
    margin_fraction: round6(Math.max(margin, (scale - 1) / 2)),
    scale_factor: round6(scale),
    retain_context_note: sanitizeText(contextNote),
  });
}

function defaultRegion(viewName: CanonicalViewName, scale: number, contextNote: string): CropRegionDefinition {
  const base = viewName === "wrist_or_mouth"
    ? { x: 0.15, y: 0.15, width: 0.7, height: 0.7 }
    : { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
  return Object.freeze({
    coordinate_space: "normalized_image",
    ...base,
    margin_fraction: round6(Math.max(0.12, (scale - 1) / 3)),
    scale_factor: round6(scale),
    retain_context_note: sanitizeText(contextNote),
  });
}

function regionFromPoint(point: CropAttentionPoint["point"], viewName: CanonicalViewName, scale: number, contextNote: string): CropRegionDefinition {
  if (point === undefined) {
    return defaultRegion(viewName, scale, contextNote);
  }
  const width = viewName === "wrist_or_mouth" ? 0.34 : 0.28;
  const height = viewName === "wrist_or_mouth" ? 0.34 : 0.28;
  return Object.freeze({
    coordinate_space: "normalized_image",
    x: round6(clamp01(point.x - width / 2)),
    y: round6(clamp01(point.y - height / 2)),
    width: round6(Math.min(width, 1 - clamp01(point.x - width / 2))),
    height: round6(Math.min(height, 1 - clamp01(point.y - height / 2))),
    margin_fraction: 0.14,
    scale_factor: round6(scale),
    retain_context_note: sanitizeText(contextNote),
  });
}

function regionFromEvidence(object: ConsensusObject, viewName: CanonicalViewName, scale: number): CropRegionDefinition {
  const evidence = object.evidence_views.find((view) => view.source_view_name === viewName);
  const context = `${object.label} crop must preserve neighbor objects, support/contact surfaces, occluders, and alignment cues.`;
  if (evidence?.crop_ref !== undefined) {
    return defaultRegion(viewName, scale, context);
  }
  return defaultRegion(viewName, scale, context);
}

function makeBroadPair(candidate: CropCandidate, policy: NormalizedPolicy): CropCandidate {
  const broadRegion = candidate.region_definition.coordinate_space === "normalized_image"
    ? Object.freeze({
      ...candidate.region_definition,
      x: round6(Math.max(0, candidate.region_definition.x - 0.08)),
      y: round6(Math.max(0, candidate.region_definition.y - 0.08)),
      width: round6(Math.min(1, candidate.region_definition.width + 0.16)),
      height: round6(Math.min(1, candidate.region_definition.height + 0.16)),
      margin_fraction: round6(Math.max(candidate.region_definition.margin_fraction, policy.min_context_margin_fraction + 0.08)),
      scale_factor: round6(policy.broad_crop_scale),
      retain_context_note: `${candidate.region_definition.retain_context_note}; broad context pair preserves surroundings.`,
    })
    : Object.freeze({
      ...candidate.region_definition,
      margin_fraction: round6(Math.max(candidate.region_definition.margin_fraction, policy.min_context_margin_fraction + 0.08)),
      scale_factor: round6(policy.broad_crop_scale),
      retain_context_note: `${candidate.region_definition.retain_context_note}; broad context pair preserves surroundings.`,
    });
  return Object.freeze({
    ...candidate,
    crop_ref: makeRef(candidate.crop_ref, "broad_pair"),
    region_definition: broadRegion,
    priority: Math.max(0, candidate.priority - 18),
    required: false,
    context_note: broadRegion.retain_context_note,
  });
}

function pairedBroadRef(candidate: CropCandidate, selected: readonly CropCandidate[]): Ref | undefined {
  if (candidate.crop_ref.endsWith("broad_pair")) {
    return undefined;
  }
  return selected.find((item) => item.crop_ref === makeRef(candidate.crop_ref, "broad_pair"))?.crop_ref;
}

function validateInputs(
  bundle: MultiViewObservationBundle,
  quality: ViewQualityReportSet,
  consensus: MultiViewConsensusReport,
  occlusion: OcclusionReport,
  sets: readonly PerViewObjectHypothesisSet[],
  attentionPoints: readonly CropAttentionPoint[],
  policy: NormalizedPolicy,
  issues: ValidationIssue[],
): void {
  if (quality.bundle_ref !== bundle.bundle_ref || consensus.bundle_ref !== bundle.bundle_ref || occlusion.bundle_ref !== bundle.bundle_ref) {
    issues.push(makeIssue("error", "BundleRefMismatch", "$.bundle_ref", "Crop planning inputs must refer to the same multi-view bundle.", "Run crop planning against matching bundle, quality, consensus, and occlusion outputs."));
  }
  if (sets.some((set) => set.bundle_ref !== bundle.bundle_ref)) {
    issues.push(makeIssue("warning", "BundleRefMismatch", "$.hypothesis_sets.bundle_ref", "At least one hypothesis set differs from the active bundle.", "Use only current-bundle hypotheses for crop planning."));
  }
  if (policy.max_crop_count <= 0 || policy.max_estimated_tokens <= 0 || policy.crop_token_cost <= 0) {
    issues.push(makeIssue("error", "CropBudgetInvalid", "$.policy", "Crop count and token budgets must be positive.", "Provide positive finite crop budget values."));
  }
  if (HIDDEN_CROP_PATTERN.test(JSON.stringify({ bundle, consensus, occlusion, attentionPoints }))) {
    issues.push(makeIssue("error", "HiddenCropInputLeak", "$.inputs", "Crop planning inputs contain hidden simulator, backend, QA, or debug identifiers.", "Repair upstream perception records to sensor-derived evidence only."));
  }
}

function validateRegion(region: CropRegionDefinition, sourceView: CanonicalViewName, policy: NormalizedPolicy): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (![region.x, region.y, region.width, region.height, region.margin_fraction, region.scale_factor].every(Number.isFinite) || region.width <= 0 || region.height <= 0 || region.scale_factor <= 0 || region.margin_fraction < 0) {
    issues.push(makeIssue("error", "RegionInvalid", `$.region_definition.${sourceView}`, "Crop region requires finite positive width, height, and scale with non-negative margin.", "Normalize crop coordinates before packaging."));
  }
  if (region.coordinate_space === "normalized_image" && (region.x < 0 || region.y < 0 || region.x + region.width > 1 || region.y + region.height > 1)) {
    issues.push(makeIssue("error", "RegionInvalid", `$.region_definition.${sourceView}`, "Normalized crop region must remain inside [0, 1].", "Clamp or recompute normalized crop coordinates."));
  }
  if (region.coordinate_space === "pixel_image" && (region.x < 0 || region.y < 0)) {
    issues.push(makeIssue("error", "RegionInvalid", `$.region_definition.${sourceView}`, "Pixel crop region cannot have negative origin.", "Use non-negative pixel coordinates."));
  }
  if (region.margin_fraction < policy.min_context_margin_fraction) {
    issues.push(makeIssue("warning", "ContextMarginTooSmall", `$.region_definition.${sourceView}.margin_fraction`, "Crop margin is too small to preserve scene context.", "Use a broader crop so support surfaces, container rims, obstacles, and gripper contact remain visible."));
  }
  if (region.retain_context_note.trim().length === 0) {
    issues.push(makeIssue("warning", "ContextMarginTooSmall", `$.region_definition.${sourceView}.retain_context_note`, "Crop lacks context-retention note.", "Describe surrounding context preserved by the crop."));
  }
  return freezeArray(issues);
}

function qualityFor(quality: ViewQualityReportSet, viewName: CanonicalViewName): ViewQualityReport | undefined {
  return quality.per_view_reports.find((report) => report.view_name === viewName);
}

function reasonForHypothesis(hypothesis: VisualObjectHypothesis): CropReason {
  if (hypothesis.estimated_object_role === "tool_candidate" || hypothesis.affordance_hypotheses.some((item) => item.affordance === "tool_like" || item.affordance === "hookable")) return "tool_affordance";
  if (hypothesis.estimated_object_role === "target" && hypothesis.evidence_views.some((view) => view.source_view_name === "wrist_or_mouth")) return "grasp_inspection";
  if (hypothesis.spatial_relations.some((relation) => relation.relation === "inside" || relation.relation === "on_top_of" || relation.relation === "aligned_with")) return "placement_verification";
  if (hypothesis.tracking_status === "lost" || hypothesis.tracking_status === "occluded_or_out_of_view") return "failure_evidence";
  if (hypothesis.memory_alignment === "matches_prior") return "memory_write";
  return "object_identification";
}

function reasonForConsensusObject(object: ConsensusObject): CropReason {
  if (object.estimated_object_role === "tool_candidate" || object.affordance_hypotheses.some((item) => item.affordance === "tool_like" || item.affordance === "hookable")) return "tool_affordance";
  if (object.estimated_object_role === "target" && object.supporting_view_names.includes("wrist_or_mouth")) return "grasp_inspection";
  if (object.spatial_relations.some((relation) => relation.relation === "inside" || relation.relation === "on_top_of" || relation.relation === "aligned_with")) return "placement_verification";
  if (object.status === "lost" || object.status === "occluded_or_out_of_view") return "failure_evidence";
  return "object_identification";
}

function reasonForRequiredBefore(requiredBefore: OcclusionReobserveRequest["required_before"]): CropReason {
  if (requiredBefore === "verification") return "placement_verification";
  if (requiredBefore === "manipulation") return "grasp_inspection";
  if (requiredBefore === "memory_write") return "memory_write";
  return "object_identification";
}

function reasonForNextView(next: RecommendedNextView): CropReason {
  if (next.expected_resolution === "verification_cross_check") return "placement_verification";
  if (next.expected_resolution === "pose_estimate") return "grasp_inspection";
  if (next.expected_resolution === "occlusion_clearance") return "failure_evidence";
  return "object_identification";
}

function priorityForHypothesis(hypothesis: VisualObjectHypothesis): number {
  const roleBoost = hypothesis.estimated_object_role === "target" ? 32 : hypothesis.estimated_object_role === "tool_candidate" ? 24 : 0;
  const confidenceRisk = Math.round((1 - Math.min(hypothesis.identity_confidence, hypothesis.pose_confidence)) * 24);
  const viewBoost = hypothesis.evidence_views.some((view) => view.source_view_name === "wrist_or_mouth") ? 12 : 0;
  return 50 + roleBoost + confidenceRisk + viewBoost;
}

function priorityForConsensusObject(object: ConsensusObject): number {
  const statusBoost = object.status === "conflicted" || object.status === "single_view_supported" ? 24 : object.status === "multi_view_supported" ? 0 : 18;
  const roleBoost = object.estimated_object_role === "target" ? 30 : object.estimated_object_role === "tool_candidate" ? 22 : 0;
  return 48 + statusBoost + roleBoost + Math.round((1 - Math.min(object.identity_confidence, object.pose_confidence)) * 20);
}

function priorityViewsForObject(object: ConsensusObject): readonly CanonicalViewName[] {
  const preferred = [
    ...object.supporting_view_names,
    ...object.missing_expected_views,
  ];
  if (object.estimated_object_role === "target") preferred.unshift("front_primary");
  if (object.affordance_hypotheses.length > 0) preferred.unshift("wrist_or_mouth");
  return freezeArray([...uniqueSorted(preferred)].sort((a: CanonicalViewName, b: CanonicalViewName) => viewSortRank(a) - viewSortRank(b)).slice(0, 3));
}

function shouldPairBroadCrop(reason: CropReason, poseConfidence: number): boolean {
  return reason === "grasp_inspection" || reason === "placement_verification" || reason === "tool_affordance" || poseConfidence < 0.55;
}

function priorityClassFor(candidate: CropCandidate): CropPriorityClass {
  if (candidate.required) return "required";
  if (candidate.priority >= 82) return "high";
  if (candidate.priority >= 55) return "normal";
  return "low";
}

function decideCropSelection(crops: readonly CropRequest[], omitted: readonly OmittedCropRequest[], issues: readonly ValidationIssue[]): CropSelectionDecision {
  if (crops.length === 0 || issues.some((issue) => issue.severity === "error")) return "rejected";
  return omitted.length > 0 || issues.length > 0 ? "planned_with_warnings" : "planned";
}

function chooseRecommendedAction(decision: CropSelectionDecision, omitted: readonly OmittedCropRequest[], issues: readonly ValidationIssue[], occlusion: OcclusionReport): CropPlannerAction {
  if (occlusion.recommended_action === "safe_hold") return "safe_hold";
  if (issues.some((issue) => issue.code === "HiddenCropInputLeak")) return "human_review";
  if (occlusion.recommended_action === "recapture_tight_sync") return "recapture";
  if (decision === "rejected" || omitted.some((item) => item.reason === "source_missing")) return "reobserve";
  return "continue";
}

function omit(candidate: CropCandidate, reason: OmittedCropRequest["reason"], rationale: string): OmittedCropRequest {
  return Object.freeze({
    crop_ref: candidate.crop_ref,
    source_view_name: candidate.source_view_name,
    target_label: candidate.target_label,
    reason,
    rationale,
  });
}

function compareCandidates(a: CropCandidate, b: CropCandidate): number {
  return Number(b.required) - Number(a.required)
    || b.priority - a.priority
    || b.source_quality_score - a.source_quality_score
    || viewSortRank(a.source_view_name) - viewSortRank(b.source_view_name)
    || a.crop_ref.localeCompare(b.crop_ref);
}

function compareCropRequests(a: CropRequest, b: CropRequest): number {
  return Number(b.required) - Number(a.required)
    || b.priority - a.priority
    || viewSortRank(a.source_view_name) - viewSortRank(b.source_view_name)
    || a.crop_ref.localeCompare(b.crop_ref);
}

function compareOmitted(a: OmittedCropRequest, b: OmittedCropRequest): number {
  return (a.source_view_name ?? "").localeCompare(b.source_view_name ?? "")
    || a.reason.localeCompare(b.reason)
    || a.crop_ref.localeCompare(b.crop_ref);
}

function stableRegionKey(region: CropRegionDefinition): string {
  return [region.coordinate_space, region.x, region.y, region.width, region.height, region.scale_factor].map(String).join("_");
}

function sanitizeText(value: string): string {
  const cleaned = value.trim().replace(/\s+/g, " ").slice(0, 600);
  return HIDDEN_CROP_PATTERN.test(cleaned) ? "Crop context redacted because it contained hidden-source wording." : cleaned;
}

function mergePolicy(base: NormalizedPolicy, override: CropAndZoomPolicy): NormalizedPolicy {
  return Object.freeze({
    max_crop_count: positiveIntOrDefault(override.max_crop_count, base.max_crop_count),
    max_estimated_tokens: positiveOrDefault(override.max_estimated_tokens, base.max_estimated_tokens),
    crop_token_cost: positiveOrDefault(override.crop_token_cost, base.crop_token_cost),
    required_view_names: freezeArray(override.required_view_names ?? base.required_view_names),
    min_quality_for_crop: clamp01(override.min_quality_for_crop ?? base.min_quality_for_crop),
    min_context_margin_fraction: clamp01(override.min_context_margin_fraction ?? base.min_context_margin_fraction),
    broad_crop_scale: positiveOrDefault(override.broad_crop_scale, base.broad_crop_scale),
    focused_crop_scale: positiveOrDefault(override.focused_crop_scale, base.focused_crop_scale),
    include_broad_context_pair: override.include_broad_context_pair ?? base.include_broad_context_pair,
  });
}

function canonicalViewOrder(): readonly CanonicalViewName[] {
  return freezeArray(["front_primary", "left_aux", "right_aux", "wrist_or_mouth", "rear_body", "depth_primary", "verification_aux"] as const);
}

function viewSortRank(viewName: CanonicalViewName): number {
  return canonicalViewOrder().indexOf(viewName);
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return freezeArray([...new Set(values)].sort());
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

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function formatScore(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "") : "invalid";
}

function makeIssue(severity: ValidationSeverity, code: CropPlannerIssueCode, path: string, message: string, remediation: string): ValidationIssue {
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
