/**
 * Object hypothesis service for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md`
 * sections 9.3, 9.5.1, 9.6.3, 9.8.2, 9.9, 9.17, 9.18, 9.19,
 * and 9.20.
 *
 * This service converts Gemini `SceneUnderstandingResponse` payloads into
 * view-grounded `VisualObjectHypothesis` records. Every current-visible object
 * must cite current camera evidence, optional image regions must stay tied to a
 * source view, memory remains prior evidence only, and simulator/debug/backend
 * identifiers are rejected before hypotheses can reach consensus or planning.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import type { StructuredResponseEnvelope } from "../prompt_contracts/structured_response_contract";
import type { MultiViewObservationBundle, PerceptionTaskPhase, SynchronizedViewPacket } from "./multi_view_synchronizer";
import type { CanonicalViewName } from "./view_name_registry";
import type { ViewQualityReport, ViewQualityReportSet } from "./view_quality_assessor";
import type { CropRegionDefinition, SelectedVisualPromptMedia, VisualPromptPacketSection } from "./visual_prompt_packager";

export const OBJECT_HYPOTHESIS_SERVICE_SCHEMA_VERSION = "mebsuta.object_hypothesis_service.v1" as const;

const HIDDEN_OBJECT_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|segmentation truth|debug buffer|debug overlay|qa_success|qa_label|qa_only|simulator truth|mesh_name|asset_id)/i;
const OPAQUE_REF_PATTERN = /^[a-z0-9_.:-]{3,120}$/i;

export type VisualObjectRole = "target" | "support" | "container" | "obstacle" | "distractor" | "tool_candidate" | "unknown";
export type SpatialRelationKind = "near" | "inside" | "on_top_of" | "under" | "left_of" | "right_of" | "in_front_of" | "behind" | "touching" | "aligned_with" | "partially_occluding" | "reachable_side";
export type AffordanceKind = "graspable" | "pushable" | "container_like" | "tool_like" | "fragile_looking" | "slippery_looking" | "heavy_looking" | "hookable" | "rollable";
export type HypothesisLifecycleStatus = "candidate" | "visible_current" | "multi_view_supported" | "single_view_only" | "occluded_or_out_of_view" | "lost" | "verified_placed" | "rejected";
export type MemoryAlignmentStatus = "matches_prior" | "conflicts_with_prior" | "unknown" | "not_provided";
export type HypothesisCollectorDecision = "collected" | "collected_with_warnings" | "rejected";
export type HypothesisCollectorAction = "continue" | "repair_response" | "reobserve" | "safe_hold" | "human_review";
export type ObjectHypothesisIssueCode =
  | "SceneResponseContractMismatch"
  | "SceneResponseMissingPrimaryResult"
  | "VisibleHypothesesMissing"
  | "HypothesisLabelMissing"
  | "HypothesisDescriptionMissing"
  | "EvidenceViewMissing"
  | "EvidenceViewUnknown"
  | "EvidenceViewNotCurrent"
  | "ImageRegionInvalid"
  | "HiddenObjectIdentifierLeak"
  | "ConfidenceInvalid"
  | "LowConfidenceOverclaim"
  | "SingleViewPoseOverclaim"
  | "MemoryUsedAsCurrentEvidence"
  | "RelationshipEvidenceMissing"
  | "AffordanceEvidenceMissing"
  | "OcclusionReportMissing";

/**
 * Provenance policy for converting model scene responses into executable File
 * 09 hypotheses.
 */
export interface ObjectHypothesisProvenancePolicy {
  readonly require_current_view_evidence?: boolean;
  readonly require_region_for_attention_points?: boolean;
  readonly reject_hidden_identifiers?: boolean;
  readonly minimum_identity_confidence?: number;
  readonly minimum_pose_confidence?: number;
  readonly planning_confidence_threshold?: number;
  readonly allow_memory_only_hypotheses?: boolean;
}

/**
 * Input model for scene-understanding payloads before validation. The shape is
 * intentionally broad because Gemini output is validated after JSON parsing.
 */
export interface SceneUnderstandingResponsePayload {
  readonly visible_object_hypotheses?: readonly SceneObjectCandidate[];
  readonly object_relationships?: readonly SceneRelationshipCandidate[];
  readonly affordance_hypotheses?: readonly SceneAffordanceCandidate[];
  readonly occlusion_report?: unknown;
  readonly spatial_attention_points?: readonly SceneAttentionPointCandidate[];
  readonly memory_alignment?: unknown;
  readonly safety_relevant_observations?: readonly unknown[];
}

/**
 * Candidate object item from the scene-understanding response.
 */
export interface SceneObjectCandidate {
  readonly label?: unknown;
  readonly visual_description?: unknown;
  readonly evidence_views?: unknown;
  readonly image_regions?: unknown;
  readonly estimated_object_role?: unknown;
  readonly spatial_relations?: unknown;
  readonly affordance_hypotheses?: unknown;
  readonly pose_confidence?: unknown;
  readonly identity_confidence?: unknown;
  readonly confidence?: unknown;
  readonly ambiguity?: unknown;
  readonly tracking_status?: unknown;
  readonly memory_alignment?: unknown;
  readonly hypothesis_ref?: unknown;
}

/**
 * Candidate relationship item from the scene-understanding response.
 */
export interface SceneRelationshipCandidate {
  readonly source_label?: unknown;
  readonly target_label?: unknown;
  readonly relation?: unknown;
  readonly evidence_views?: unknown;
  readonly relation_is_visual?: unknown;
  readonly confidence?: unknown;
  readonly summary?: unknown;
}

/**
 * Candidate affordance item from the scene-understanding response.
 */
export interface SceneAffordanceCandidate {
  readonly object_label?: unknown;
  readonly affordance?: unknown;
  readonly evidence_views?: unknown;
  readonly confidence?: unknown;
  readonly rationale?: unknown;
}

/**
 * Candidate spatial attention item, usually emitted as normalized view regions.
 */
export interface SceneAttentionPointCandidate {
  readonly source_view_name?: unknown;
  readonly label?: unknown;
  readonly point?: unknown;
  readonly region?: unknown;
  readonly reason?: unknown;
  readonly confidence?: unknown;
}

/**
 * Source view or crop supporting one object hypothesis.
 */
export interface VisualEvidenceView {
  readonly source_view_name: CanonicalViewName;
  readonly source_camera_packet_ref: Ref;
  readonly media_ref?: Ref;
  readonly crop_ref?: Ref;
  readonly evidence_summary: string;
  readonly current_packet: boolean;
  readonly quality_score: number;
  readonly timestamp_midpoint_s: number;
}

/**
 * Image coordinate region attached to a specific source view.
 */
export interface VisualImageRegion {
  readonly source_view_name: CanonicalViewName;
  readonly source_camera_packet_ref: Ref;
  readonly coordinate_space: CropRegionDefinition["coordinate_space"];
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly center_x: number;
  readonly center_y: number;
  readonly area_fraction?: number;
  readonly region_summary: string;
}

/**
 * Object-object or object-environment relation grounded in visual evidence.
 */
export interface VisualSpatialRelation {
  readonly relation_ref: Ref;
  readonly relation: SpatialRelationKind;
  readonly target_label: string;
  readonly evidence_views: readonly CanonicalViewName[];
  readonly relation_is_visual: boolean;
  readonly confidence: number;
  readonly summary: string;
}

/**
 * Visual affordance hypothesis tied to an object and evidence view.
 */
export interface VisualAffordanceHypothesis {
  readonly affordance_ref: Ref;
  readonly affordance: AffordanceKind;
  readonly evidence_views: readonly CanonicalViewName[];
  readonly confidence: number;
  readonly rationale: string;
}

/**
 * File 09 object hypothesis produced by this service.
 */
export interface VisualObjectHypothesis {
  readonly hypothesis_ref: Ref;
  readonly label: string;
  readonly visual_description: string;
  readonly evidence_views: readonly VisualEvidenceView[];
  readonly image_regions: readonly VisualImageRegion[];
  readonly estimated_object_role: VisualObjectRole;
  readonly spatial_relations: readonly VisualSpatialRelation[];
  readonly affordance_hypotheses: readonly VisualAffordanceHypothesis[];
  readonly pose_confidence: number;
  readonly identity_confidence: number;
  readonly tracking_status: HypothesisLifecycleStatus;
  readonly memory_alignment: MemoryAlignmentStatus;
  readonly ambiguity_summary: string;
  readonly source_response_ref: Ref;
  readonly determinism_hash: string;
}

/**
 * Per-view grouping consumed by the later cross-view consensus engine.
 */
export interface PerViewObjectHypothesisGroup {
  readonly source_view_name: CanonicalViewName;
  readonly packet_ref: Ref;
  readonly hypotheses: readonly VisualObjectHypothesis[];
  readonly omitted_hypothesis_refs: readonly Ref[];
  readonly view_quality_score?: number;
}

/**
 * Full collection result from File 09 `collectObjectHypotheses`.
 */
export interface PerViewObjectHypothesisSet {
  readonly schema_version: typeof OBJECT_HYPOTHESIS_SERVICE_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md";
  readonly hypothesis_set_ref: Ref;
  readonly bundle_ref: Ref;
  readonly source_response_ref: Ref;
  readonly task_phase: PerceptionTaskPhase;
  readonly hypotheses: readonly VisualObjectHypothesis[];
  readonly per_view_hypotheses: readonly PerViewObjectHypothesisGroup[];
  readonly rejected_hypothesis_refs: readonly Ref[];
  readonly object_relationships_checked: boolean;
  readonly occlusion_report_present: boolean;
  readonly response_memory_alignment: MemoryAlignmentStatus;
  readonly recommended_action: HypothesisCollectorAction;
  readonly decision: HypothesisCollectorDecision;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
  readonly cognitive_visibility: "perception_object_hypothesis_set";
}

interface NormalizedPolicy {
  readonly require_current_view_evidence: boolean;
  readonly require_region_for_attention_points: boolean;
  readonly reject_hidden_identifiers: boolean;
  readonly minimum_identity_confidence: number;
  readonly minimum_pose_confidence: number;
  readonly planning_confidence_threshold: number;
  readonly allow_memory_only_hypotheses: boolean;
}

interface HypothesisBuildContext {
  readonly bundle: MultiViewObservationBundle;
  readonly promptPacket?: VisualPromptPacketSection;
  readonly qualityReports?: ViewQualityReportSet;
  readonly responseRef: Ref;
  readonly policy: NormalizedPolicy;
  readonly sceneRelationships: readonly SceneRelationshipCandidate[];
  readonly sceneAffordances: readonly SceneAffordanceCandidate[];
  readonly attentionPoints: readonly SceneAttentionPointCandidate[];
  readonly responseMemoryAlignment: MemoryAlignmentStatus;
}

const DEFAULT_POLICY: NormalizedPolicy = Object.freeze({
  require_current_view_evidence: true,
  require_region_for_attention_points: false,
  reject_hidden_identifiers: true,
  minimum_identity_confidence: 0.35,
  minimum_pose_confidence: 0.25,
  planning_confidence_threshold: 0.62,
  allow_memory_only_hypotheses: false,
});

/**
 * Executable File 09 `ObjectHypothesisService`.
 */
export class ObjectHypothesisService {
  private readonly policy: NormalizedPolicy;

  public constructor(policy: ObjectHypothesisProvenancePolicy = {}) {
    this.policy = mergePolicy(DEFAULT_POLICY, policy);
  }

  /**
   * Converts a structured scene-understanding response into view-grounded
   * object hypotheses with deterministic provenance and validation issues.
   */
  public collectObjectHypotheses(
    sceneResponse: unknown,
    bundle: MultiViewObservationBundle,
    provenancePolicy: ObjectHypothesisProvenancePolicy = {},
    promptPacket?: VisualPromptPacketSection,
    qualityReports?: ViewQualityReportSet,
  ): PerViewObjectHypothesisSet {
    const activePolicy = mergePolicy(this.policy, provenancePolicy);
    const issues: ValidationIssue[] = [];
    const envelope = readStructuredEnvelope(sceneResponse, issues);
    const payload = readScenePayload(envelope.payload, issues);
    const responseRef = envelope.response_ref;
    const responseMemoryAlignment = classifyMemoryAlignment(payload.memory_alignment);
    const context: HypothesisBuildContext = {
      bundle,
      promptPacket,
      qualityReports,
      responseRef,
      policy: activePolicy,
      sceneRelationships: payload.object_relationships ?? [],
      sceneAffordances: payload.affordance_hypotheses ?? [],
      attentionPoints: payload.spatial_attention_points ?? [],
      responseMemoryAlignment,
    };
    if (payload.visible_object_hypotheses === undefined || payload.visible_object_hypotheses.length === 0) {
      issues.push(makeIssue("error", "VisibleHypothesesMissing", "$.primary_result.visible_object_hypotheses", "SceneUnderstandingResponse did not provide visible object hypotheses.", "Repair the response so visible objects, explicit absence, or occlusion-driven uncertainty is reported."));
    }
    if (payload.occlusion_report === undefined) {
      issues.push(makeIssue("warning", "OcclusionReportMissing", "$.primary_result.occlusion_report", "SceneUnderstandingResponse lacks an occlusion report.", "Repair or reobserve when absence, blocked views, or crop limits matter."));
    }

    const accepted: VisualObjectHypothesis[] = [];
    const rejectedRefs: Ref[] = [];
    for (const [index, candidate] of (payload.visible_object_hypotheses ?? []).entries()) {
      const localIssues: ValidationIssue[] = [];
      const hypothesis = buildHypothesis(candidate, index, context, localIssues);
      issues.push(...localIssues);
      if (hypothesis === undefined || localIssues.some((issue) => issue.severity === "error")) {
        rejectedRefs.push(candidateRef(candidate, index, responseRef));
      } else {
        accepted.push(hypothesis);
      }
    }

    const perView = buildPerViewGroups(bundle, qualityReports, accepted, rejectedRefs);
    const setRef = makeRef("object_hypothesis_set", bundle.bundle_ref, responseRef, accepted.map((item) => item.hypothesis_ref).join(":"));
    const recommendedAction = chooseRecommendedAction(accepted, rejectedRefs, issues, bundle);
    const decision = decideCollection(accepted, issues);
    const shell = {
      setRef,
      bundle: bundle.bundle_ref,
      responseRef,
      accepted: accepted.map((item) => item.hypothesis_ref),
      rejectedRefs,
      issueCodes: issues.map((issue) => issue.code),
    };
    return Object.freeze({
      schema_version: OBJECT_HYPOTHESIS_SERVICE_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md",
      hypothesis_set_ref: setRef,
      bundle_ref: bundle.bundle_ref,
      source_response_ref: responseRef,
      task_phase: bundle.task_phase,
      hypotheses: freezeArray(accepted.sort(compareHypotheses)),
      per_view_hypotheses: freezeArray(perView),
      rejected_hypothesis_refs: freezeArray(uniqueSorted(rejectedRefs)),
      object_relationships_checked: payload.object_relationships !== undefined,
      occlusion_report_present: payload.occlusion_report !== undefined,
      response_memory_alignment: responseMemoryAlignment,
      recommended_action: recommendedAction,
      decision,
      issues: freezeArray(issues),
      ok: decision !== "rejected",
      determinism_hash: computeDeterminismHash(shell),
      cognitive_visibility: "perception_object_hypothesis_set",
    });
  }
}

/**
 * Functional API matching File 09's hypothesis-collection signature.
 */
export function collectObjectHypotheses(
  sceneResponse: unknown,
  bundle: MultiViewObservationBundle,
  provenancePolicy: ObjectHypothesisProvenancePolicy = {},
  promptPacket?: VisualPromptPacketSection,
  qualityReports?: ViewQualityReportSet,
): PerViewObjectHypothesisSet {
  return new ObjectHypothesisService(provenancePolicy).collectObjectHypotheses(sceneResponse, bundle, provenancePolicy, promptPacket, qualityReports);
}

function buildHypothesis(
  candidate: SceneObjectCandidate,
  index: number,
  context: HypothesisBuildContext,
  issues: ValidationIssue[],
): VisualObjectHypothesis | undefined {
  const label = readCleanText(candidate.label, `$.visible_object_hypotheses[${index}].label`, "HypothesisLabelMissing", issues);
  const visualDescription = readCleanText(candidate.visual_description, `$.visible_object_hypotheses[${index}].visual_description`, "HypothesisDescriptionMissing", issues);
  if (label === undefined || visualDescription === undefined) {
    return undefined;
  }
  const path = `$.visible_object_hypotheses[${index}]`;
  if (context.policy.reject_hidden_identifiers && hiddenTextDetected(candidate)) {
    issues.push(makeIssue("error", "HiddenObjectIdentifierLeak", path, `Hypothesis ${label} contains hidden simulator, backend, QA, or debug identifiers.`, "Repair the response using only human-readable visual descriptors and view evidence."));
    return undefined;
  }
  const evidenceViews = normalizeEvidenceViews(candidate.evidence_views, label, context, `${path}.evidence_views`, issues);
  const currentEvidence = evidenceViews.filter((view) => view.current_packet);
  if (context.policy.require_current_view_evidence && currentEvidence.length === 0) {
    issues.push(makeIssue("error", "EvidenceViewMissing", `${path}.evidence_views`, `Hypothesis ${label} lacks current view evidence.`, "Repair the response so every visible object cites a current canonical view or crop."));
  }
  const imageRegions = normalizeImageRegions(candidate.image_regions, context, `${path}.image_regions`, issues);
  const attentionRegions = regionsFromAttentionPoints(label, context, issues);
  const allRegions = freezeArray([...imageRegions, ...attentionRegions].sort(compareRegions));
  const relationships = normalizeRelations(label, context.sceneRelationships, evidenceViews, path, issues);
  const affordances = normalizeAffordances(label, candidate.affordance_hypotheses, context.sceneAffordances, evidenceViews, path, issues);
  const baseIdentity = confidenceFrom(candidate.identity_confidence ?? candidate.confidence, context.policy.minimum_identity_confidence, `${path}.identity_confidence`, issues);
  const basePose = confidenceFrom(candidate.pose_confidence ?? candidate.confidence, context.policy.minimum_pose_confidence, `${path}.pose_confidence`, issues);
  const qualityAdjustedIdentity = adjustConfidenceForEvidence(baseIdentity, evidenceViews, context, "identity", issues, path);
  const qualityAdjustedPose = adjustConfidenceForEvidence(basePose, evidenceViews, context, "pose", issues, path);
  const role = normalizeRole(candidate.estimated_object_role);
  const memoryAlignment = classifyMemoryAlignment(candidate.memory_alignment ?? context.responseMemoryAlignment);
  const trackingStatus = chooseTrackingStatus(candidate.tracking_status, evidenceViews, qualityAdjustedIdentity, qualityAdjustedPose, memoryAlignment, candidate.ambiguity);
  if (memoryAlignment !== "not_provided" && evidenceViews.length === 0 && !context.policy.allow_memory_only_hypotheses) {
    issues.push(makeIssue("error", "MemoryUsedAsCurrentEvidence", `${path}.memory_alignment`, `Hypothesis ${label} appears memory-only but is listed as current visual evidence.`, "Move memory-only evidence into prior context or reobserve the object."));
  }
  const hypothesisRef = stableHypothesisRef(candidate, index, context.responseRef, label, evidenceViews);
  const shell = {
    hypothesisRef,
    label,
    role,
    views: evidenceViews.map((view) => [view.source_view_name, view.source_camera_packet_ref, view.crop_ref]),
    regions: allRegions.map((region) => [region.source_view_name, region.x, region.y, region.width, region.height]),
    identity: qualityAdjustedIdentity,
    pose: qualityAdjustedPose,
    trackingStatus,
  };
  return Object.freeze({
    hypothesis_ref: hypothesisRef,
    label,
    visual_description: visualDescription,
    evidence_views: freezeArray([...evidenceViews].sort(compareEvidenceViews)),
    image_regions: allRegions,
    estimated_object_role: role,
    spatial_relations: freezeArray(relationships),
    affordance_hypotheses: freezeArray(affordances),
    pose_confidence: qualityAdjustedPose,
    identity_confidence: qualityAdjustedIdentity,
    tracking_status: trackingStatus,
    memory_alignment: memoryAlignment,
    ambiguity_summary: ambiguitySummary(candidate.ambiguity, evidenceViews, qualityAdjustedIdentity, qualityAdjustedPose),
    source_response_ref: context.responseRef,
    determinism_hash: computeDeterminismHash(shell),
  });
}

function normalizeEvidenceViews(
  rawEvidence: unknown,
  label: string,
  context: HypothesisBuildContext,
  path: string,
  issues: ValidationIssue[],
): readonly VisualEvidenceView[] {
  const entries = Array.isArray(rawEvidence) ? rawEvidence : rawEvidence === undefined ? [] : [rawEvidence];
  const views: VisualEvidenceView[] = [];
  for (const [index, entry] of entries.entries()) {
    const parsed = parseEvidenceView(entry);
    if (parsed.viewName === undefined) {
      issues.push(makeIssue("error", "EvidenceViewUnknown", `${path}[${index}]`, `Evidence view for ${label} is not a recognized canonical view.`, "Use a canonical File 09 view name such as front_primary or wrist_or_mouth."));
      continue;
    }
    const packet = context.bundle.view_packets[parsed.viewName];
    if (packet === undefined) {
      issues.push(makeIssue("error", "EvidenceViewNotCurrent", `${path}[${index}]`, `Evidence view ${parsed.viewName} for ${label} is not present in the current bundle.`, "Cite only current bundle views or request reobserve."));
      continue;
    }
    const selectedMedia = findPromptMedia(context.promptPacket, parsed.viewName, parsed.mediaRef, parsed.cropRef);
    const quality = qualityFor(context.qualityReports, parsed.viewName);
    views.push(Object.freeze({
      source_view_name: parsed.viewName,
      source_camera_packet_ref: packet.packet_ref,
      media_ref: selectedMedia?.media_ref ?? parsed.mediaRef,
      crop_ref: selectedMedia?.crop_ref ?? parsed.cropRef,
      evidence_summary: parsed.summary ?? `${label} is cited from ${parsed.viewName}.`,
      current_packet: true,
      quality_score: quality?.quality_score ?? packet.confidence,
      timestamp_midpoint_s: packet.midpoint_s,
    }));
  }
  return freezeArray(deduplicateEvidenceViews(views));
}

function parseEvidenceView(entry: unknown): {
  readonly viewName?: CanonicalViewName;
  readonly mediaRef?: Ref;
  readonly cropRef?: Ref;
  readonly summary?: string;
} {
  if (typeof entry === "string") {
    return Object.freeze({ viewName: canonicalViewFrom(entry) });
  }
  if (!isRecord(entry)) {
    return Object.freeze({});
  }
  const viewText = firstString(entry, ["source_view_name", "view_name", "canonical_view_name", "view"]);
  return Object.freeze({
    viewName: viewText === undefined ? undefined : canonicalViewFrom(viewText),
    mediaRef: firstString(entry, ["media_ref", "visual_media_ref", "image_ref"]),
    cropRef: firstString(entry, ["crop_ref"]),
    summary: firstString(entry, ["evidence_summary", "summary", "rationale"]),
  });
}

function normalizeImageRegions(
  rawRegions: unknown,
  context: HypothesisBuildContext,
  path: string,
  issues: ValidationIssue[],
): readonly VisualImageRegion[] {
  const entries = Array.isArray(rawRegions) ? rawRegions : rawRegions === undefined ? [] : [rawRegions];
  const regions: VisualImageRegion[] = [];
  for (const [index, entry] of entries.entries()) {
    const parsed = parseRegion(entry);
    if (parsed === undefined) {
      issues.push(makeIssue("error", "ImageRegionInvalid", `${path}[${index}]`, "Image region must include source view plus finite x, y, width, and height.", "Repair the response with view-specific normalized or pixel image coordinates."));
      continue;
    }
    const packet = context.bundle.view_packets[parsed.source_view_name];
    if (packet === undefined) {
      issues.push(makeIssue("error", "EvidenceViewNotCurrent", `${path}[${index}].source_view_name`, `Region source view ${parsed.source_view_name} is not current.`, "Use only source views from the active multi-view bundle."));
      continue;
    }
    const validationIssues = validateRegion(parsed, `${path}[${index}]`);
    issues.push(...validationIssues);
    if (validationIssues.some((issue) => issue.severity === "error")) {
      continue;
    }
    regions.push(Object.freeze({
      source_view_name: parsed.source_view_name,
      source_camera_packet_ref: packet.packet_ref,
      coordinate_space: parsed.coordinate_space,
      x: parsed.x,
      y: parsed.y,
      width: parsed.width,
      height: parsed.height,
      center_x: round6(parsed.x + parsed.width / 2),
      center_y: round6(parsed.y + parsed.height / 2),
      area_fraction: parsed.coordinate_space === "normalized_image" ? round6(parsed.width * parsed.height) : undefined,
      region_summary: parsed.region_summary,
    }));
  }
  return freezeArray(regions);
}

function parseRegion(entry: unknown): (Omit<VisualImageRegion, "source_camera_packet_ref" | "center_x" | "center_y" | "area_fraction">) | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }
  const viewText = firstString(entry, ["source_view_name", "view_name", "canonical_view_name", "view"]);
  const viewName = viewText === undefined ? undefined : canonicalViewFrom(viewText);
  if (viewName === undefined) {
    return undefined;
  }
  const region = isRecord(entry.region_definition) ? entry.region_definition : isRecord(entry.region) ? entry.region : entry;
  const x = numberFrom(region.x);
  const y = numberFrom(region.y);
  const width = numberFrom(region.width ?? region.w);
  const height = numberFrom(region.height ?? region.h);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return Object.freeze({
    source_view_name: viewName,
    coordinate_space: region.coordinate_space === "pixel_image" ? "pixel_image" : "normalized_image",
    x: round6(x),
    y: round6(y),
    width: round6(width),
    height: round6(height),
    region_summary: firstString(entry, ["region_summary", "summary", "reason"]) ?? `Region in ${viewName}.`,
  });
}

function regionsFromAttentionPoints(
  label: string,
  context: HypothesisBuildContext,
  issues: ValidationIssue[],
): readonly VisualImageRegion[] {
  const normalizedLabel = normalizeTextKey(label);
  const regions: VisualImageRegion[] = [];
  for (const [index, point] of context.attentionPoints.entries()) {
    if (normalizeTextKey(stringFrom(point.label) ?? "") !== normalizedLabel) {
      continue;
    }
    const sourceView = stringFrom(point.source_view_name);
    const viewName = sourceView === undefined ? undefined : canonicalViewFrom(sourceView);
    const packet = viewName === undefined ? undefined : context.bundle.view_packets[viewName];
    if (viewName === undefined || packet === undefined) {
      issues.push(makeIssue("warning", "ImageRegionInvalid", `$.spatial_attention_points[${index}]`, `Attention point for ${label} lacks a current source view.`, "Repair attention points with current canonical source views."));
      continue;
    }
    const region = point.region ?? point.point;
    const parsedRegion = parseAttentionRegion(region, viewName);
    if (parsedRegion === undefined) {
      if (context.policy.require_region_for_attention_points) {
        issues.push(makeIssue("error", "ImageRegionInvalid", `$.spatial_attention_points[${index}]`, `Attention point for ${label} is not a valid normalized region.`, "Use normalized x, y, width, and height for attention regions."));
      }
      continue;
    }
    regions.push(Object.freeze({
      source_view_name: viewName,
      source_camera_packet_ref: packet.packet_ref,
      coordinate_space: "normalized_image",
      x: parsedRegion.x,
      y: parsedRegion.y,
      width: parsedRegion.width,
      height: parsedRegion.height,
      center_x: round6(parsedRegion.x + parsedRegion.width / 2),
      center_y: round6(parsedRegion.y + parsedRegion.height / 2),
      area_fraction: round6(parsedRegion.width * parsedRegion.height),
      region_summary: stringFrom(point.reason) ?? `Attention region for ${label}.`,
    }));
  }
  return freezeArray(regions);
}

function parseAttentionRegion(region: unknown, viewName: CanonicalViewName): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | undefined {
  if (!isRecord(region)) {
    return undefined;
  }
  const x = numberFrom(region.x ?? region.u);
  const y = numberFrom(region.y ?? region.v);
  const width = numberFrom(region.width ?? region.w ?? 0.04);
  const height = numberFrom(region.height ?? region.h ?? 0.04);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  const candidate = Object.freeze({
    source_view_name: viewName,
    coordinate_space: "normalized_image" as const,
    x: round6(Math.max(0, x - width / 2)),
    y: round6(Math.max(0, y - height / 2)),
    width: round6(width),
    height: round6(height),
    region_summary: "attention point expanded to region",
  });
  return validateRegion(candidate, "$.attention_region").some((issue) => issue.severity === "error")
    ? undefined
    : Object.freeze({ x: candidate.x, y: candidate.y, width: candidate.width, height: candidate.height });
}

function validateRegion(
  region: Omit<VisualImageRegion, "source_camera_packet_ref" | "center_x" | "center_y" | "area_fraction">,
  path: string,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (![region.x, region.y, region.width, region.height].every(Number.isFinite) || region.width <= 0 || region.height <= 0) {
    issues.push(makeIssue("error", "ImageRegionInvalid", path, "Image region requires finite x, y, width, and height with positive area.", "Provide a valid image-space region."));
  }
  if (region.coordinate_space === "normalized_image" && (region.x < 0 || region.y < 0 || region.x + region.width > 1 || region.y + region.height > 1)) {
    issues.push(makeIssue("error", "ImageRegionInvalid", path, "Normalized image region must remain inside [0, 1] bounds.", "Clamp or recalculate normalized evidence coordinates."));
  }
  if (region.coordinate_space === "pixel_image" && (region.x < 0 || region.y < 0)) {
    issues.push(makeIssue("error", "ImageRegionInvalid", path, "Pixel image region cannot have negative origin.", "Provide non-negative pixel coordinates."));
  }
  return freezeArray(issues);
}

function normalizeRelations(
  label: string,
  relationships: readonly SceneRelationshipCandidate[],
  evidenceViews: readonly VisualEvidenceView[],
  path: string,
  issues: ValidationIssue[],
): readonly VisualSpatialRelation[] {
  const normalizedLabel = normalizeTextKey(label);
  const result: VisualSpatialRelation[] = [];
  for (const [index, relation] of relationships.entries()) {
    const source = normalizeTextKey(stringFrom(relation.source_label) ?? "");
    if (source !== normalizedLabel) {
      continue;
    }
    const target = cleanText(stringFrom(relation.target_label) ?? "unknown target");
    const relationKind = normalizeRelationKind(relation.relation);
    const viewNames = evidenceViewNames(relation.evidence_views, evidenceViews);
    if (viewNames.length === 0) {
      issues.push(makeIssue("warning", "RelationshipEvidenceMissing", `${path}.spatial_relations[${index}]`, `Relationship for ${label} lacks view evidence.`, "Attach the source view that visually supports the relationship."));
    }
    result.push(Object.freeze({
      relation_ref: makeRef("relation", label, relationKind, target, String(index)),
      relation: relationKind,
      target_label: target,
      evidence_views: freezeArray(viewNames),
      relation_is_visual: relation.relation_is_visual !== false,
      confidence: confidenceFrom(relation.confidence, 0.45, `${path}.spatial_relations[${index}].confidence`, issues),
      summary: cleanText(stringFrom(relation.summary) ?? `${label} is ${relationKind} ${target}.`),
    }));
  }
  return freezeArray(result.sort((a, b) => a.relation_ref.localeCompare(b.relation_ref)));
}

function normalizeAffordances(
  label: string,
  localAffordancesRaw: unknown,
  sceneAffordances: readonly SceneAffordanceCandidate[],
  evidenceViews: readonly VisualEvidenceView[],
  path: string,
  issues: ValidationIssue[],
): readonly VisualAffordanceHypothesis[] {
  const candidates = [
    ...normalizeLocalAffordanceCandidates(label, localAffordancesRaw),
    ...sceneAffordances.filter((item) => normalizeTextKey(stringFrom(item.object_label) ?? "") === normalizeTextKey(label)),
  ];
  const result: VisualAffordanceHypothesis[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const affordance = normalizeAffordance(candidate.affordance);
    const viewNames = evidenceViewNames(candidate.evidence_views, evidenceViews);
    if (viewNames.length === 0) {
      issues.push(makeIssue("warning", "AffordanceEvidenceMissing", `${path}.affordance_hypotheses[${index}]`, `Affordance ${affordance} for ${label} lacks view evidence.`, "Attach visual evidence views for affordance claims."));
    }
    result.push(Object.freeze({
      affordance_ref: makeRef("affordance", label, affordance, String(index)),
      affordance,
      evidence_views: freezeArray(viewNames),
      confidence: confidenceFrom(candidate.confidence, 0.45, `${path}.affordance_hypotheses[${index}].confidence`, issues),
      rationale: cleanText(stringFrom(candidate.rationale) ?? `${label} appears ${affordance}.`),
    }));
  }
  return freezeArray(deduplicateAffordances(result));
}

function normalizeLocalAffordanceCandidates(label: string, raw: unknown): readonly SceneAffordanceCandidate[] {
  const entries = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return freezeArray(entries.map((entry) => {
    if (typeof entry === "string") {
      return Object.freeze({ object_label: label, affordance: entry, rationale: `${label} appears ${entry}.` });
    }
    if (isRecord(entry)) {
      return Object.freeze({
        object_label: entry.object_label ?? label,
        affordance: entry.affordance ?? entry.kind ?? entry.label,
        evidence_views: entry.evidence_views,
        confidence: entry.confidence,
        rationale: entry.rationale ?? entry.summary,
      });
    }
    return Object.freeze({ object_label: label, affordance: "graspable", confidence: 0.35, rationale: `${label} affordance was underspecified.` });
  }));
}

function adjustConfidenceForEvidence(
  base: number,
  evidenceViews: readonly VisualEvidenceView[],
  context: HypothesisBuildContext,
  confidenceKind: "identity" | "pose",
  issues: ValidationIssue[],
  path: string,
): number {
  const viewCount = uniqueSorted(evidenceViews.map((view) => view.source_view_name)).length;
  const meanQuality = evidenceViews.length === 0 ? 0 : evidenceViews.reduce((sum, view) => sum + view.quality_score, 0) / evidenceViews.length;
  const syncMultiplier = syncConfidenceMultiplier(context.bundle.sync_quality);
  const viewMultiplier = confidenceKind === "pose"
    ? viewCount >= 2 ? 1 : 0.68
    : viewCount >= 2 ? 1 : 0.82;
  const qualityMultiplier = 0.45 + 0.55 * clamp01(meanQuality);
  const adjusted = roundScore(base * syncMultiplier * viewMultiplier * qualityMultiplier);
  if (confidenceKind === "pose" && viewCount <= 1 && base > context.policy.planning_confidence_threshold) {
    issues.push(makeIssue("warning", "SingleViewPoseOverclaim", `${path}.pose_confidence`, "Pose confidence is high while supported by one or zero current views.", "Downgrade pose confidence or request another view/depth evidence."));
  }
  if (base > context.policy.planning_confidence_threshold && adjusted < context.policy.planning_confidence_threshold) {
    issues.push(makeIssue("warning", "LowConfidenceOverclaim", `${path}.${confidenceKind}_confidence`, `${confidenceKind} confidence was downgraded by view quality, view count, or synchronization.`, "Keep uncertainty explicit before planning or verification."));
  }
  return adjusted;
}

function buildPerViewGroups(
  bundle: MultiViewObservationBundle,
  qualityReports: ViewQualityReportSet | undefined,
  hypotheses: readonly VisualObjectHypothesis[],
  rejectedRefs: readonly Ref[],
): readonly PerViewObjectHypothesisGroup[] {
  const groups: PerViewObjectHypothesisGroup[] = [];
  for (const [viewName, packet] of viewPacketEntries(bundle.view_packets)) {
    const visible = hypotheses.filter((hypothesis) => hypothesis.evidence_views.some((view) => view.source_view_name === viewName));
    const quality = qualityFor(qualityReports, viewName);
    groups.push(Object.freeze({
      source_view_name: viewName,
      packet_ref: packet.packet_ref,
      hypotheses: freezeArray(visible.sort(compareHypotheses)),
      omitted_hypothesis_refs: freezeArray(rejectedRefs),
      view_quality_score: quality?.quality_score,
    }));
  }
  return freezeArray(groups.sort((a, b) => viewSortRank(a.source_view_name) - viewSortRank(b.source_view_name)));
}

function readStructuredEnvelope(sceneResponse: unknown, issues: ValidationIssue[]): { readonly response_ref: Ref; readonly payload: unknown } {
  if (isRecord(sceneResponse) && sceneResponse.response_contract_id !== undefined) {
    const envelope = sceneResponse as unknown as StructuredResponseEnvelope;
    if (envelope.response_contract_id !== "SceneUnderstandingResponse") {
      issues.push(makeIssue("error", "SceneResponseContractMismatch", "$.response_contract_id", "ObjectHypothesisService requires SceneUnderstandingResponse.", "Route only File 07 scene-understanding responses into object hypothesis collection."));
    }
    return Object.freeze({
      response_ref: isRecord(sceneResponse) && typeof sceneResponse.task_state_ref === "string" ? makeRef("scene_response", sceneResponse.task_state_ref) : makeRef("scene_response", "structured"),
      payload: envelope.primary_result,
    });
  }
  if (isRecord(sceneResponse) && isRecord(sceneResponse.primary_result)) {
    return Object.freeze({
      response_ref: firstString(sceneResponse, ["response_ref", "task_state_ref"]) ?? makeRef("scene_response", "primary_result"),
      payload: sceneResponse.primary_result,
    });
  }
  return Object.freeze({
    response_ref: isRecord(sceneResponse) ? firstString(sceneResponse, ["response_ref", "task_state_ref"]) ?? makeRef("scene_response", "raw") : makeRef("scene_response", "unknown"),
    payload: sceneResponse,
  });
}

function readScenePayload(rawPayload: unknown, issues: ValidationIssue[]): SceneUnderstandingResponsePayload {
  if (!isRecord(rawPayload)) {
    issues.push(makeIssue("error", "SceneResponseMissingPrimaryResult", "$.primary_result", "Scene response primary_result must be an object.", "Repair the model response to the SceneUnderstandingResponse JSON contract."));
    return Object.freeze({});
  }
  return Object.freeze({
    visible_object_hypotheses: arrayOfRecords(rawPayload.visible_object_hypotheses) as readonly SceneObjectCandidate[],
    object_relationships: arrayOfRecords(rawPayload.object_relationships) as readonly SceneRelationshipCandidate[],
    affordance_hypotheses: arrayOfRecords(rawPayload.affordance_hypotheses) as readonly SceneAffordanceCandidate[],
    occlusion_report: rawPayload.occlusion_report,
    spatial_attention_points: arrayOfRecords(rawPayload.spatial_attention_points) as readonly SceneAttentionPointCandidate[],
    memory_alignment: rawPayload.memory_alignment,
    safety_relevant_observations: Array.isArray(rawPayload.safety_relevant_observations) ? rawPayload.safety_relevant_observations : undefined,
  });
}

function readCleanText(
  value: unknown,
  path: string,
  missingCode: "HypothesisLabelMissing" | "HypothesisDescriptionMissing",
  issues: ValidationIssue[],
): string | undefined {
  const text = stringFrom(value);
  if (text === undefined || text.trim().length === 0) {
    issues.push(makeIssue("error", missingCode, path, "Object hypothesis requires a non-empty human-readable label and visual description.", "Repair the response with visual labels and distinguishing descriptions."));
    return undefined;
  }
  const cleaned = cleanText(text);
  if (HIDDEN_OBJECT_PATTERN.test(cleaned)) {
    issues.push(makeIssue("error", "HiddenObjectIdentifierLeak", path, "Object text contains hidden simulator, backend, QA, or debug terminology.", "Use only human-readable visual descriptors."));
    return undefined;
  }
  return cleaned;
}

function confidenceFrom(value: unknown, fallback: number, path: string, issues: ValidationIssue[]): number {
  const numeric = numberFrom(value);
  if (numeric === undefined) {
    return clamp01(fallback);
  }
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) {
    issues.push(makeIssue("warning", "ConfidenceInvalid", path, "Confidence must be finite and normalized to [0, 1].", "Normalize confidence before object hypothesis collection."));
  }
  return clamp01(numeric);
}

function classifyMemoryAlignment(value: unknown): MemoryAlignmentStatus {
  const text = JSON.stringify(value ?? "").toLowerCase();
  if (text.length <= 2) {
    return "not_provided";
  }
  if (/conflict|contradict|moved|stale|different/.test(text)) {
    return "conflicts_with_prior";
  }
  if (/match|consistent|same|aligned|agrees/.test(text)) {
    return "matches_prior";
  }
  return "unknown";
}

function chooseTrackingStatus(
  rawStatus: unknown,
  evidenceViews: readonly VisualEvidenceView[],
  identityConfidence: number,
  poseConfidence: number,
  memoryAlignment: MemoryAlignmentStatus,
  ambiguity: unknown,
): HypothesisLifecycleStatus {
  const explicit = normalizeTrackingStatus(rawStatus);
  if (explicit !== undefined) {
    return explicit;
  }
  if (memoryAlignment === "conflicts_with_prior" && evidenceViews.length === 0) {
    return "lost";
  }
  if (evidenceViews.length === 0) {
    return "occluded_or_out_of_view";
  }
  if (identityConfidence < 0.45 || /ambiguous|uncertain|possible|maybe/i.test(JSON.stringify(ambiguity ?? ""))) {
    return "candidate";
  }
  if (evidenceViews.length >= 2 && poseConfidence >= 0.45) {
    return "multi_view_supported";
  }
  if (evidenceViews.length === 1) {
    return "single_view_only";
  }
  return "visible_current";
}

function chooseRecommendedAction(
  hypotheses: readonly VisualObjectHypothesis[],
  rejectedRefs: readonly Ref[],
  issues: readonly ValidationIssue[],
  bundle: MultiViewObservationBundle,
): HypothesisCollectorAction {
  if (issues.some((issue) => issue.code === "HiddenObjectIdentifierLeak")) {
    return "repair_response";
  }
  if (hypotheses.length === 0 && bundle.missing_views.some((view) => view.canonical_view_name === "front_primary")) {
    return "safe_hold";
  }
  if (hypotheses.length === 0 || issues.some((issue) => issue.code === "EvidenceViewMissing" || issue.code === "EvidenceViewNotCurrent" || issue.code === "OcclusionReportMissing")) {
    return "reobserve";
  }
  if (rejectedRefs.length > 0 || issues.some((issue) => issue.severity === "error")) {
    return "repair_response";
  }
  if (issues.some((issue) => issue.severity === "warning")) {
    return "human_review";
  }
  return "continue";
}

function decideCollection(hypotheses: readonly VisualObjectHypothesis[], issues: readonly ValidationIssue[]): HypothesisCollectorDecision {
  if (hypotheses.length === 0 || issues.some((issue) => issue.severity === "error")) {
    return "rejected";
  }
  return issues.length > 0 ? "collected_with_warnings" : "collected";
}

function evidenceViewNames(raw: unknown, fallback: readonly VisualEvidenceView[]): readonly CanonicalViewName[] {
  const parsed = normalizeEvidenceViews(raw, "relationship_or_affordance", {
    bundle: emptyBundleFromEvidence(fallback),
    responseRef: "relation",
    policy: DEFAULT_POLICY,
    sceneRelationships: [],
    sceneAffordances: [],
    attentionPoints: [],
    responseMemoryAlignment: "not_provided",
  }, "$.evidence_views", []);
  const names = parsed.length > 0 ? parsed.map((view) => view.source_view_name) : fallback.map((view) => view.source_view_name);
  return freezeArray(uniqueSorted(names));
}

function emptyBundleFromEvidence(evidenceViews: readonly VisualEvidenceView[]): MultiViewObservationBundle {
  const viewPackets: Partial<Record<CanonicalViewName, SynchronizedViewPacket>> = {};
  for (const view of evidenceViews) {
    viewPackets[view.source_view_name] = Object.freeze({
      canonical_view_name: view.source_view_name,
      packet_ref: view.source_camera_packet_ref,
      sensor_ref: makeRef("sensor", view.source_view_name),
      camera_role: "primary_egocentric",
      image_ref: makeRef("image", view.source_camera_packet_ref),
      timestamp_interval: Object.freeze({ start_s: view.timestamp_midpoint_s, end_s: view.timestamp_midpoint_s }),
      midpoint_s: view.timestamp_midpoint_s,
      offset_from_bundle_center_ms: 0,
      age_ms: 0,
      health_status: "healthy",
      packet_status: "captured",
      confidence: view.quality_score,
      calibration_ref: makeRef("calibration", view.source_view_name),
      determinism_hash: view.source_camera_packet_ref,
    });
  }
  return Object.freeze({
    schema_version: "mebsuta.multi_view_synchronizer.v1",
    blueprint_ref: "architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md",
    bundle_ref: "relation_evidence_bundle",
    task_phase: "observe",
    capture_interval: Object.freeze({ start_s: 0, end_s: 0 }),
    view_packets: Object.freeze(viewPackets),
    missing_views: freezeArray([]),
    view_inventory: freezeArray([]),
    sync_quality: "tight",
    max_temporal_skew_ms: 0,
    bundle_center_time_s: 0,
    calibration_context_ref: "relation_evidence_calibration",
    view_quality_report_ref: "relation_evidence_quality",
    provenance_summary: "temporary relation evidence view resolver",
    included_packet_refs: freezeArray(evidenceViews.map((view) => view.source_camera_packet_ref)),
    omitted_packet_refs: freezeArray([]),
    issues: freezeArray([]),
    ok: true,
    recommended_action: "continue",
    determinism_hash: "relation_evidence_bundle",
    cognitive_visibility: "perception_multi_view_observation_bundle",
  });
}

function viewPacketEntries(
  viewPackets: MultiViewObservationBundle["view_packets"],
): readonly (readonly [CanonicalViewName, SynchronizedViewPacket])[] {
  const entries: (readonly [CanonicalViewName, SynchronizedViewPacket])[] = [];
  for (const viewName of canonicalViewOrder()) {
    const packet = viewPackets[viewName];
    if (packet !== undefined) {
      entries.push([viewName, packet] as const);
    }
  }
  return freezeArray(entries);
}

function findPromptMedia(
  promptPacket: VisualPromptPacketSection | undefined,
  viewName: CanonicalViewName,
  mediaRef: Ref | undefined,
  cropRef: Ref | undefined,
): SelectedVisualPromptMedia | undefined {
  return promptPacket?.selected_media.find((media) =>
    media.source_view_name === viewName
    && (mediaRef === undefined || media.media_ref === mediaRef)
    && (cropRef === undefined || media.crop_ref === cropRef));
}

function qualityFor(qualityReports: ViewQualityReportSet | undefined, viewName: CanonicalViewName): ViewQualityReport | undefined {
  return qualityReports?.per_view_reports.find((report) => report.view_name === viewName);
}

function normalizeRole(value: unknown): VisualObjectRole {
  const text = normalizeTextKey(stringFrom(value) ?? "");
  if (text.includes("target")) {
    return "target";
  }
  if (text.includes("support")) {
    return "support";
  }
  if (text.includes("container")) {
    return "container";
  }
  if (text.includes("obstacle")) {
    return "obstacle";
  }
  if (text.includes("distractor")) {
    return "distractor";
  }
  if (text.includes("tool")) {
    return "tool_candidate";
  }
  return "unknown";
}

function normalizeRelationKind(value: unknown): SpatialRelationKind {
  const text = normalizeTextKey(stringFrom(value) ?? "");
  if (text.includes("inside")) return "inside";
  if (text.includes("top") || text.includes("on")) return "on_top_of";
  if (text.includes("under")) return "under";
  if (text.includes("left")) return "left_of";
  if (text.includes("right")) return "right_of";
  if (text.includes("front")) return "in_front_of";
  if (text.includes("behind") || text.includes("back")) return "behind";
  if (text.includes("touch") || text.includes("contact")) return "touching";
  if (text.includes("align")) return "aligned_with";
  if (text.includes("occlud")) return "partially_occluding";
  if (text.includes("reach")) return "reachable_side";
  return "near";
}

function normalizeAffordance(value: unknown): AffordanceKind {
  const text = normalizeTextKey(stringFrom(value) ?? "");
  if (text.includes("push")) return "pushable";
  if (text.includes("container")) return "container_like";
  if (text.includes("tool")) return "tool_like";
  if (text.includes("fragile")) return "fragile_looking";
  if (text.includes("slippery")) return "slippery_looking";
  if (text.includes("heavy")) return "heavy_looking";
  if (text.includes("hook")) return "hookable";
  if (text.includes("roll")) return "rollable";
  return "graspable";
}

function normalizeTrackingStatus(value: unknown): HypothesisLifecycleStatus | undefined {
  const text = normalizeTextKey(stringFrom(value) ?? "");
  const statuses: readonly HypothesisLifecycleStatus[] = ["candidate", "visible_current", "multi_view_supported", "single_view_only", "occluded_or_out_of_view", "lost", "verified_placed", "rejected"];
  return statuses.find((status) => status === text);
}

function syncConfidenceMultiplier(syncQuality: MultiViewObservationBundle["sync_quality"]): number {
  switch (syncQuality) {
    case "tight":
      return 1;
    case "acceptable":
      return 0.93;
    case "loose":
      return 0.72;
    case "desynchronized":
      return 0.35;
  }
}

function stableHypothesisRef(
  candidate: SceneObjectCandidate,
  index: number,
  responseRef: Ref,
  label: string,
  evidenceViews: readonly VisualEvidenceView[],
): Ref {
  const candidateProvided = stringFrom(candidate.hypothesis_ref);
  if (candidateProvided !== undefined && OPAQUE_REF_PATTERN.test(candidateProvided) && !HIDDEN_OBJECT_PATTERN.test(candidateProvided)) {
    return candidateProvided;
  }
  const digest = computeDeterminismHash({
    responseRef,
    index,
    label,
    evidence: evidenceViews.map((view) => [view.source_view_name, view.source_camera_packet_ref, view.crop_ref]),
  }).slice(0, 16);
  return makeRef("visual_hypothesis", label, digest);
}

function candidateRef(candidate: SceneObjectCandidate, index: number, responseRef: Ref): Ref {
  const provided = stringFrom(candidate.hypothesis_ref);
  return provided !== undefined && OPAQUE_REF_PATTERN.test(provided) ? provided : makeRef("rejected_hypothesis", responseRef, String(index));
}

function ambiguitySummary(ambiguity: unknown, evidenceViews: readonly VisualEvidenceView[], identityConfidence: number, poseConfidence: number): string {
  const explicit = stringFrom(ambiguity);
  if (explicit !== undefined && explicit.trim().length > 0) {
    return cleanText(explicit);
  }
  if (evidenceViews.length === 0) {
    return "No current view evidence; object cannot be treated as currently visible.";
  }
  if (evidenceViews.length === 1) {
    return `Single-view support from ${evidenceViews[0].source_view_name}; depth, pose, and containment remain uncertain.`;
  }
  if (identityConfidence < 0.5 || poseConfidence < 0.45) {
    return "Multi-view evidence exists but confidence remains limited by quality, occlusion, or similar-object ambiguity.";
  }
  return "No additional ambiguity reported beyond normal visual uncertainty.";
}

function hiddenTextDetected(value: unknown): boolean {
  return HIDDEN_OBJECT_PATTERN.test(JSON.stringify(value ?? ""));
}

function cleanText(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 600);
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
}

function firstString(record: Readonly<Record<string, unknown>>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = stringFrom(record[key]);
    if (value !== undefined && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function numberFrom(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayOfRecords(value: unknown): readonly Readonly<Record<string, unknown>>[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return freezeArray(value.filter(isRecord));
}

function canonicalViewFrom(value: string): CanonicalViewName | undefined {
  const normalized = normalizeTextKey(value);
  return canonicalViewOrder().find((view) => view === normalized);
}

function normalizeTextKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function canonicalViewOrder(): readonly CanonicalViewName[] {
  return freezeArray(["front_primary", "left_aux", "right_aux", "wrist_or_mouth", "rear_body", "depth_primary", "verification_aux"] as const);
}

function viewSortRank(viewName: CanonicalViewName): number {
  return canonicalViewOrder().indexOf(viewName);
}

function compareEvidenceViews(a: VisualEvidenceView, b: VisualEvidenceView): number {
  return viewSortRank(a.source_view_name) - viewSortRank(b.source_view_name)
    || (a.crop_ref ?? "").localeCompare(b.crop_ref ?? "")
    || a.source_camera_packet_ref.localeCompare(b.source_camera_packet_ref);
}

function compareRegions(a: VisualImageRegion, b: VisualImageRegion): number {
  return viewSortRank(a.source_view_name) - viewSortRank(b.source_view_name)
    || a.x - b.x
    || a.y - b.y
    || a.width - b.width
    || a.height - b.height;
}

function compareHypotheses(a: VisualObjectHypothesis, b: VisualObjectHypothesis): number {
  return b.identity_confidence - a.identity_confidence
    || b.pose_confidence - a.pose_confidence
    || a.label.localeCompare(b.label)
    || a.hypothesis_ref.localeCompare(b.hypothesis_ref);
}

function deduplicateEvidenceViews(views: readonly VisualEvidenceView[]): readonly VisualEvidenceView[] {
  const byKey = new Map<string, VisualEvidenceView>();
  for (const view of views) {
    byKey.set(`${view.source_view_name}:${view.source_camera_packet_ref}:${view.crop_ref ?? ""}`, view);
  }
  return freezeArray([...byKey.values()]);
}

function deduplicateAffordances(values: readonly VisualAffordanceHypothesis[]): readonly VisualAffordanceHypothesis[] {
  const byKey = new Map<string, VisualAffordanceHypothesis>();
  for (const value of values) {
    byKey.set(`${value.affordance}:${value.evidence_views.join(",")}`, value);
  }
  return freezeArray([...byKey.values()].sort((a, b) => a.affordance_ref.localeCompare(b.affordance_ref)));
}

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return freezeArray([...new Set(values)].sort());
}

function mergePolicy(base: NormalizedPolicy, override: ObjectHypothesisProvenancePolicy): NormalizedPolicy {
  return Object.freeze({
    require_current_view_evidence: override.require_current_view_evidence ?? base.require_current_view_evidence,
    require_region_for_attention_points: override.require_region_for_attention_points ?? base.require_region_for_attention_points,
    reject_hidden_identifiers: override.reject_hidden_identifiers ?? base.reject_hidden_identifiers,
    minimum_identity_confidence: clamp01(override.minimum_identity_confidence ?? base.minimum_identity_confidence),
    minimum_pose_confidence: clamp01(override.minimum_pose_confidence ?? base.minimum_pose_confidence),
    planning_confidence_threshold: clamp01(override.planning_confidence_threshold ?? base.planning_confidence_threshold),
    allow_memory_only_hypotheses: override.allow_memory_only_hypotheses ?? base.allow_memory_only_hypotheses,
  });
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

function makeIssue(severity: ValidationSeverity, code: ObjectHypothesisIssueCode, path: string, message: string, remediation: string): ValidationIssue {
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
