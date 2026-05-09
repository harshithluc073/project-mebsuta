/**
 * Visual prompt packager for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md`
 * sections 9.3, 9.5.1, 9.6.1, 9.6.2, 9.8.1, 9.11, 9.17, 9.18,
 * 9.19, and 9.20.
 *
 * The packager is the File 09 bridge from synchronized camera evidence to
 * Gemini-facing prompt inputs. It selects full views, crop requests, view
 * inventory, quality summaries, declared calibration summaries, task visual
 * objectives, and prior-memory notes under a finite media budget while keeping
 * simulator internals and debug evidence out of the cognitive packet.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import type {
  CognitivePromptPacketSection,
  PromptPacketSectionKind,
  PromptProvenanceLabel,
} from "../prompt_contracts/cognitive_prompt_packet_contract";
import type { CalibrationPromptContext, CalibrationPromptViewContext } from "./calibration_context_assembler";
import type { MultiViewInventoryRecord, MultiViewObservationBundle, PerceptionTaskPhase, SynchronizedViewPacket } from "./multi_view_synchronizer";
import type { CanonicalViewName } from "./view_name_registry";
import type { ViewQualityReport, ViewQualityReportSet } from "./view_quality_assessor";

export const VISUAL_PROMPT_PACKAGER_SCHEMA_VERSION = "mebsuta.visual_prompt_packager.v1" as const;

const DEFAULT_FULL_VIEW_TOKEN_COST = 1_450;
const DEFAULT_CROP_TOKEN_COST = 920;
const DEFAULT_SUMMARY_TOKEN_COST = 180;
const DEFAULT_MEDIA_BUDGET_TOKENS = 8_000;
const DEFAULT_MAX_SELECTED_VIEWS = 4;
const DEFAULT_MAX_SELECTED_CROPS = 5;
const HIDDEN_VISUAL_EVIDENCE_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|segmentation truth|debug buffer|debug overlay|qa_success|qa_label|qa_only|simulator truth)/i;

export type VisualMediaKind = "full_view" | "crop" | "summary_only";
export type CropReason = "object_identification" | "grasp_inspection" | "placement_verification" | "tool_affordance" | "failure_evidence" | "memory_write";
export type RegionCoordinateSpace = "normalized_image" | "pixel_image";
export type VisualPromptDecision = "packaged" | "packaged_with_warnings" | "rejected";
export type VisualPromptRecommendedAction = "continue" | "reobserve" | "recapture" | "safe_hold" | "human_review";
export type OmittedVisualMediaReason = "budget_exceeded" | "quality_too_low" | "source_missing" | "invalid_crop" | "duplicate_low_value" | "unsafe_source";
export type VisualPromptIssueCode =
  | "BundleQualityRefMismatch"
  | "BundleCalibrationRefMismatch"
  | "PromptContractMissing"
  | "OutputContractMissing"
  | "MediaBudgetInvalid"
  | "DesynchronizedBundle"
  | "PrimaryViewUnavailable"
  | "RequiredViewUnavailable"
  | "RequiredMediaExceedsBudget"
  | "AllMediaOmitted"
  | "CropSourceMissing"
  | "CropRegionInvalid"
  | "CropContextTooTight"
  | "ViewQualityTooLow"
  | "HiddenVisualEvidenceLeak"
  | "DebugEvidenceLeak"
  | "CalibrationContextMissing";

/**
 * Image region requested by a planner, validator, or visual attention policy.
 * Normalized coordinates are in [0, 1]; pixel coordinates must be non-negative.
 */
export interface CropRegionDefinition {
  readonly coordinate_space: RegionCoordinateSpace;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly margin_fraction: number;
  readonly scale_factor: number;
  readonly retain_context_note: string;
}

/**
 * Optional crop request from task attention, verification, Oops recovery, or
 * memory-write policy. The source view and region remain explicit provenance.
 */
export interface VisualAttentionRequest {
  readonly request_ref: Ref;
  readonly source_view_name: CanonicalViewName;
  readonly crop_reason: CropReason;
  readonly priority: number;
  readonly required?: boolean;
  readonly target_hypothesis_ref?: Ref;
  readonly region_definition: CropRegionDefinition;
  readonly summary_hint?: string;
  readonly estimated_token_cost?: number;
}

/**
 * Task context that becomes prompt-visible File 09 visual objective text.
 */
export interface VisualPromptTaskContext {
  readonly task_state_ref: Ref;
  readonly task_phase: PerceptionTaskPhase;
  readonly task_visual_objective: string;
  readonly prompt_contract_ref: Ref;
  readonly output_contract_ref?: Ref;
  readonly required_views?: readonly CanonicalViewName[];
  readonly memory_visual_priors?: readonly string[];
  readonly embodiment_viewpoint_context?: string;
  readonly validator_notes?: readonly string[];
}

/**
 * Finite media selection budget for full views and crops.
 */
export interface VisualMediaBudget {
  readonly max_media_tokens?: number;
  readonly max_selected_views?: number;
  readonly max_selected_crops?: number;
  readonly full_view_token_cost?: number;
  readonly crop_token_cost?: number;
  readonly summary_token_cost?: number;
  readonly reserve_tokens?: number;
}

/**
 * Deterministic selection policy for File 09 prompt packaging.
 */
export interface VisualPromptPackagingPolicy {
  readonly min_quality_for_full_view?: number;
  readonly min_quality_for_crop?: number;
  readonly require_primary_view?: boolean;
  readonly forbid_desynchronized_bundle?: boolean;
  readonly allow_loose_sync_for_observation?: boolean;
  readonly include_low_quality_inventory?: boolean;
}

/**
 * Prompt-facing view inventory row. Missing and degraded views are kept visible
 * so downstream reasoning cannot overstate certainty.
 */
export interface VisualPromptViewInventoryRow {
  readonly canonical_view_name: CanonicalViewName;
  readonly status: MultiViewInventoryRecord["status"] | "quality_only";
  readonly packet_ref?: Ref;
  readonly source_sensor_ref?: Ref;
  readonly quality_score?: number;
  readonly health_status?: ViewQualityReport["health_status"];
  readonly target_visibility?: ViewQualityReport["target_visibility"];
  readonly calibration_ref?: Ref;
  readonly prompt_safe_summary: string;
  readonly prompt_include_status: "media_selected" | "inventory_only" | "missing_or_unusable";
}

/**
 * Selected image evidence or crop that can be attached to a Gemini request.
 */
export interface SelectedVisualPromptMedia {
  readonly media_ref: Ref;
  readonly media_kind: VisualMediaKind;
  readonly source_view_name: CanonicalViewName;
  readonly source_camera_packet_ref: Ref;
  readonly image_ref: Ref;
  readonly depth_ref?: Ref;
  readonly crop_ref?: Ref;
  readonly crop_reason?: CropReason;
  readonly target_hypothesis_ref?: Ref;
  readonly region_definition?: CropRegionDefinition;
  readonly quality_score: number;
  readonly priority: number;
  readonly required: boolean;
  readonly estimated_tokens: number;
  readonly selected_rationale: string;
  readonly calibration_context_ref?: Ref;
  readonly timestamp_midpoint_s: number;
  readonly prompt_safe_summary: string;
  readonly determinism_hash: string;
}

/**
 * Media candidate that was not selected, with explicit reason for audit and
 * repair/reobserve routing.
 */
export interface OmittedVisualPromptMedia {
  readonly media_ref: Ref;
  readonly source_view_name?: CanonicalViewName;
  readonly reason: OmittedVisualMediaReason;
  readonly rationale: string;
}

/**
 * Compact summaries used by File 07 prompt-packet sections.
 */
export interface VisualPromptSectionBundle {
  readonly current_observation_section: CognitivePromptPacketSection;
  readonly media_attachments_section: CognitivePromptPacketSection;
  readonly output_contract_section: CognitivePromptPacketSection;
  readonly uncertainty_section: CognitivePromptPacketSection;
  readonly telemetry_section: CognitivePromptPacketSection;
  readonly memory_context_section?: CognitivePromptPacketSection;
  readonly embodiment_context_section?: CognitivePromptPacketSection;
}

/**
 * Final File 09 `VisualPromptPacketSection` emitted by the packager.
 */
export interface VisualPromptPacketSection {
  readonly schema_version: typeof VISUAL_PROMPT_PACKAGER_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md";
  readonly packet_ref: Ref;
  readonly bundle_ref: Ref;
  readonly task_state_ref: Ref;
  readonly prompt_contract_ref: Ref;
  readonly output_contract_ref?: Ref;
  readonly decision: VisualPromptDecision;
  readonly selected_media: readonly SelectedVisualPromptMedia[];
  readonly omitted_media: readonly OmittedVisualPromptMedia[];
  readonly view_inventory: readonly VisualPromptViewInventoryRow[];
  readonly prompt_sections: VisualPromptSectionBundle;
  readonly estimated_media_tokens: number;
  readonly media_budget_tokens: number;
  readonly required_views_satisfied: readonly CanonicalViewName[];
  readonly missing_required_views: readonly CanonicalViewName[];
  readonly recommended_action: VisualPromptRecommendedAction;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
  readonly cognitive_visibility: "perception_visual_prompt_packet_section";
}

interface CandidateMedia {
  readonly media_ref: Ref;
  readonly media_kind: VisualMediaKind;
  readonly source_view_name: CanonicalViewName;
  readonly packet: SynchronizedViewPacket;
  readonly crop_request?: VisualAttentionRequest;
  readonly quality_report?: ViewQualityReport;
  readonly calibration_context?: CalibrationPromptViewContext;
  readonly priority: number;
  readonly required: boolean;
  readonly estimated_tokens: number;
  readonly quality_score: number;
  readonly rationale: string;
}

interface NormalizedBudget {
  readonly max_media_tokens: number;
  readonly max_selected_views: number;
  readonly max_selected_crops: number;
  readonly full_view_token_cost: number;
  readonly crop_token_cost: number;
  readonly summary_token_cost: number;
  readonly reserve_tokens: number;
}

interface NormalizedPolicy {
  readonly min_quality_for_full_view: number;
  readonly min_quality_for_crop: number;
  readonly require_primary_view: boolean;
  readonly forbid_desynchronized_bundle: boolean;
  readonly allow_loose_sync_for_observation: boolean;
  readonly include_low_quality_inventory: boolean;
}

const DEFAULT_POLICY: NormalizedPolicy = Object.freeze({
  min_quality_for_full_view: 0.52,
  min_quality_for_crop: 0.48,
  require_primary_view: true,
  forbid_desynchronized_bundle: true,
  allow_loose_sync_for_observation: true,
  include_low_quality_inventory: true,
});

/**
 * Executable File 09 `VisualPromptPackager`.
 */
export class VisualPromptPackager {
  private readonly policy: NormalizedPolicy;

  public constructor(policy: VisualPromptPackagingPolicy = {}) {
    this.policy = mergePolicy(DEFAULT_POLICY, policy);
  }

  /**
   * Selects Gemini-facing views and crops under a media budget, then emits
   * prompt sections compatible with the File 07 prompt-packet contract.
   */
  public selectVisualPromptMedia(
    multiViewBundle: MultiViewObservationBundle,
    qualityReports: ViewQualityReportSet,
    calibrationContext: CalibrationPromptContext,
    taskContext: VisualPromptTaskContext,
    mediaBudget: VisualMediaBudget = {},
    attentionRequests: readonly VisualAttentionRequest[] = [],
    policy: VisualPromptPackagingPolicy = {},
  ): VisualPromptPacketSection {
    const activePolicy = mergePolicy(this.policy, policy);
    const budget = normalizeBudget(mediaBudget);
    const issues: ValidationIssue[] = [
      ...validateSourceAlignment(multiViewBundle, qualityReports, calibrationContext),
      ...validateTaskContext(taskContext),
      ...validateBudget(budget),
      ...validateSyncQuality(multiViewBundle, taskContext, activePolicy),
      ...scanPromptVisibleText(taskContext, qualityReports, calibrationContext),
    ];
    const requiredViews = requiredViewsForTask(taskContext, activePolicy);
    const viewInventory = buildViewInventory(multiViewBundle, qualityReports, calibrationContext, activePolicy);
    const candidates = buildCandidates(multiViewBundle, qualityReports, calibrationContext, taskContext, budget, attentionRequests, activePolicy, issues);
    const selection = selectCandidates(candidates, budget, issues);
    const selectedMedia = selection.selected.map((candidate) => selectedMediaFromCandidate(candidate, calibrationContext));
    const omittedMedia = [...selection.omitted, ...omissionsForMissingSources(attentionRequests, multiViewBundle)].sort(compareOmissions);
    const selectedViews = uniqueSorted(selectedMedia.map((media) => media.source_view_name));
    const missingRequiredViews = requiredViews.filter((viewName) => !selectedViews.includes(viewName) || isViewUnusable(viewName, viewInventory));
    for (const viewName of missingRequiredViews) {
      issues.push(makeIssue(viewName === "front_primary" ? "error" : "warning", viewName === "front_primary" ? "PrimaryViewUnavailable" : "RequiredViewUnavailable", `$.required_views.${viewName}`, `Required view ${viewName} is not available as selected prompt media.`, "Recapture or reobserve the required view before relying on visual reasoning."));
    }
    if (selectedMedia.length === 0) {
      issues.push(makeIssue("error", "AllMediaOmitted", "$.selected_media", "No visual media survived quality, safety, and budget selection.", "Reobserve with at least one current cognitive-safe camera packet."));
    }
    const estimatedMediaTokens = selectedMedia.reduce((sum, media) => sum + media.estimated_tokens, 0);
    const promptSections = buildPromptSections(taskContext, multiViewBundle, qualityReports, calibrationContext, viewInventory, selectedMedia, omittedMedia, estimatedMediaTokens, budget.max_media_tokens);
    const recommendedAction = chooseRecommendedAction(multiViewBundle, qualityReports, missingRequiredViews, issues);
    const decision = decidePackaging(issues, omittedMedia);
    const packetRef = makeRef("visual_prompt_packet", taskContext.task_state_ref, multiViewBundle.bundle_ref, taskContext.prompt_contract_ref);
    const shell = {
      packetRef,
      bundle: multiViewBundle.bundle_ref,
      task: taskContext.task_state_ref,
      selected: selectedMedia.map((media) => media.media_ref),
      omitted: omittedMedia.map((media) => [media.media_ref, media.reason]),
      requiredViews,
      missingRequiredViews,
      issues: issues.map((issue) => issue.code),
    };
    return Object.freeze({
      schema_version: VISUAL_PROMPT_PACKAGER_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md",
      packet_ref: packetRef,
      bundle_ref: multiViewBundle.bundle_ref,
      task_state_ref: taskContext.task_state_ref,
      prompt_contract_ref: taskContext.prompt_contract_ref,
      output_contract_ref: taskContext.output_contract_ref,
      decision,
      selected_media: freezeArray(selectedMedia),
      omitted_media: freezeArray(omittedMedia),
      view_inventory: freezeArray(mergeSelectionIntoInventory(viewInventory, selectedViews)),
      prompt_sections: promptSections,
      estimated_media_tokens: estimatedMediaTokens,
      media_budget_tokens: budget.max_media_tokens,
      required_views_satisfied: freezeArray(requiredViews.filter((viewName) => !missingRequiredViews.includes(viewName))),
      missing_required_views: freezeArray(missingRequiredViews),
      recommended_action: recommendedAction,
      issues: freezeArray(issues),
      ok: decision !== "rejected",
      determinism_hash: computeDeterminismHash(shell),
      cognitive_visibility: "perception_visual_prompt_packet_section",
    });
  }
}

/**
 * Functional API matching File 09's media-selection signature.
 */
export function selectVisualPromptMedia(
  multiViewBundle: MultiViewObservationBundle,
  qualityReports: ViewQualityReportSet,
  calibrationContext: CalibrationPromptContext,
  taskContext: VisualPromptTaskContext,
  mediaBudget: VisualMediaBudget = {},
  attentionRequests: readonly VisualAttentionRequest[] = [],
  policy: VisualPromptPackagingPolicy = {},
): VisualPromptPacketSection {
  return new VisualPromptPackager(policy).selectVisualPromptMedia(multiViewBundle, qualityReports, calibrationContext, taskContext, mediaBudget, attentionRequests, policy);
}

function buildCandidates(
  bundle: MultiViewObservationBundle,
  qualityReports: ViewQualityReportSet,
  calibrationContext: CalibrationPromptContext,
  taskContext: VisualPromptTaskContext,
  budget: NormalizedBudget,
  attentionRequests: readonly VisualAttentionRequest[],
  policy: NormalizedPolicy,
  issues: ValidationIssue[],
): readonly CandidateMedia[] {
  const candidates: CandidateMedia[] = [];
  const requiredViews = new Set(requiredViewsForTask(taskContext, policy));
  for (const [viewName, packet] of viewPacketEntries(bundle.view_packets)) {
    const report = qualityFor(qualityReports, viewName);
    const calibration = calibrationFor(calibrationContext, viewName, packet.packet_ref);
    const qualityScore = report?.quality_score ?? packet.confidence;
    const required = requiredViews.has(viewName);
    if (isUnsafePacket(packet, report, calibration)) {
      issues.push(makeIssue("error", "DebugEvidenceLeak", `$.view_packets.${viewName}`, `View ${viewName} contains unsafe debug or non-sensor wording.`, "Recapture clean sensor-derived media before prompt packaging."));
      continue;
    }
    if (qualityScore < policy.min_quality_for_full_view && !required) {
      candidates.push(summaryOnlyCandidate(viewName, packet, report, calibration, budget.summary_token_cost));
      continue;
    }
    if (qualityScore < policy.min_quality_for_full_view && required) {
      issues.push(makeIssue("warning", "ViewQualityTooLow", `$.view_quality.${viewName}`, `Required view ${viewName} has low quality score ${formatNumber(qualityScore)}.`, "Include inventory uncertainty and request reobserve before high-risk planning."));
    }
    candidates.push(Object.freeze({
      media_ref: makeRef("visual_media", "full", packet.packet_ref),
      media_kind: "full_view",
      source_view_name: viewName,
      packet,
      quality_report: report,
      calibration_context: calibration,
      priority: viewPriority(viewName, taskContext.task_phase) + qualityScore * 20 + (required ? 35 : 0),
      required,
      estimated_tokens: budget.full_view_token_cost,
      quality_score: qualityScore,
      rationale: `Selected ${viewName} full view for ${taskContext.task_phase} objective with quality ${formatNumber(qualityScore)}.`,
    }));
  }
  for (const request of attentionRequests) {
    const packet = bundle.view_packets[request.source_view_name];
    const report = qualityFor(qualityReports, request.source_view_name);
    const validationIssues = validateCropRequest(request, packet, report, policy);
    issues.push(...validationIssues);
    if (packet === undefined || validationIssues.some((issue) => issue.severity === "error")) {
      continue;
    }
    const calibration = calibrationFor(calibrationContext, request.source_view_name, packet.packet_ref);
    const qualityScore = report?.quality_score ?? packet.confidence;
    candidates.push(Object.freeze({
      media_ref: makeRef("visual_media", "crop", request.request_ref, packet.packet_ref),
      media_kind: "crop",
      source_view_name: request.source_view_name,
      packet,
      crop_request: request,
      quality_report: report,
      calibration_context: calibration,
      priority: request.priority + cropReasonPriority(request.crop_reason) + qualityScore * 12 + (request.required === true ? 35 : 0),
      required: request.required === true,
      estimated_tokens: request.estimated_token_cost ?? budget.crop_token_cost,
      quality_score: qualityScore,
      rationale: `Selected ${request.crop_reason} crop from ${request.source_view_name}; crop keeps ${request.region_definition.retain_context_note}.`,
    }));
  }
  return freezeArray(candidates.sort(compareCandidates));
}

function selectCandidates(
  candidates: readonly CandidateMedia[],
  budget: NormalizedBudget,
  issues: ValidationIssue[],
): { readonly selected: readonly CandidateMedia[]; readonly omitted: readonly OmittedVisualPromptMedia[] } {
  const usableBudget = Math.max(0, budget.max_media_tokens - budget.reserve_tokens);
  let usedTokens = 0;
  let selectedViewCount = 0;
  let selectedCropCount = 0;
  const selected: CandidateMedia[] = [];
  const omitted: OmittedVisualPromptMedia[] = [];
  const selectedFullViews = new Set<CanonicalViewName>();
  for (const candidate of candidates) {
    const limitReached = candidate.media_kind === "full_view"
      ? selectedViewCount >= budget.max_selected_views
      : candidate.media_kind === "crop"
        ? selectedCropCount >= budget.max_selected_crops
        : false;
    const wouldExceedBudget = usedTokens + candidate.estimated_tokens > usableBudget;
    if (!candidate.required && limitReached) {
      omitted.push(omit(candidate, "duplicate_low_value", "Selection count limit reached for this media kind."));
      continue;
    }
    if (!candidate.required && wouldExceedBudget) {
      omitted.push(omit(candidate, "budget_exceeded", "Optional visual media exceeded the remaining media budget."));
      continue;
    }
    if (candidate.required && wouldExceedBudget) {
      issues.push(makeIssue("error", "RequiredMediaExceedsBudget", "$.media_budget", `Required visual media ${candidate.media_ref} exceeds the media budget.`, "Increase media budget or reduce required media before model invocation."));
    }
    if (candidate.media_kind === "crop" && selectedFullViews.has(candidate.source_view_name) && candidate.required !== true && candidate.priority < 85) {
      omitted.push(omit(candidate, "duplicate_low_value", "Low-priority crop omitted because the source full view is already selected."));
      continue;
    }
    selected.push(candidate);
    usedTokens += candidate.estimated_tokens;
    if (candidate.media_kind === "full_view") {
      selectedViewCount += 1;
      selectedFullViews.add(candidate.source_view_name);
    }
    if (candidate.media_kind === "crop") {
      selectedCropCount += 1;
    }
  }
  return Object.freeze({
    selected: freezeArray(selected),
    omitted: freezeArray(omitted),
  });
}

function selectedMediaFromCandidate(candidate: CandidateMedia, calibrationContext: CalibrationPromptContext): SelectedVisualPromptMedia {
  const crop = candidate.crop_request;
  const base = {
    media_ref: candidate.media_ref,
    kind: candidate.media_kind,
    view: candidate.source_view_name,
    packet: candidate.packet.packet_ref,
    crop: crop?.request_ref,
    quality: candidate.quality_score,
  };
  return Object.freeze({
    media_ref: candidate.media_ref,
    media_kind: candidate.media_kind,
    source_view_name: candidate.source_view_name,
    source_camera_packet_ref: candidate.packet.packet_ref,
    image_ref: candidate.packet.image_ref,
    depth_ref: candidate.packet.depth_ref,
    crop_ref: crop?.request_ref,
    crop_reason: crop?.crop_reason,
    target_hypothesis_ref: crop?.target_hypothesis_ref,
    region_definition: crop?.region_definition,
    quality_score: roundScore(candidate.quality_score),
    priority: roundScore(candidate.priority / 100),
    required: candidate.required,
    estimated_tokens: candidate.estimated_tokens,
    selected_rationale: candidate.rationale,
    calibration_context_ref: candidate.calibration_context?.calibration_ref ?? calibrationContext.calibration_context_ref,
    timestamp_midpoint_s: candidate.packet.midpoint_s,
    prompt_safe_summary: promptSafeMediaSummary(candidate),
    determinism_hash: computeDeterminismHash(base),
  });
}

function buildPromptSections(
  taskContext: VisualPromptTaskContext,
  bundle: MultiViewObservationBundle,
  qualityReports: ViewQualityReportSet,
  calibrationContext: CalibrationPromptContext,
  inventory: readonly VisualPromptViewInventoryRow[],
  selectedMedia: readonly SelectedVisualPromptMedia[],
  omittedMedia: readonly OmittedVisualPromptMedia[],
  estimatedMediaTokens: number,
  mediaBudgetTokens: number,
): VisualPromptSectionBundle {
  const observationContent = [
    `Visual objective: ${taskContext.task_visual_objective}`,
    `Task phase: ${taskContext.task_phase}; bundle=${bundle.bundle_ref}; sync=${bundle.sync_quality}; max_skew_ms=${formatNumber(bundle.max_temporal_skew_ms)}.`,
    `View inventory: ${inventory.map((row) => `${row.canonical_view_name}:${row.status}:${row.prompt_include_status}`).join("; ") || "none"}.`,
    `Quality: bundle_score=${formatNumber(qualityReports.bundle_quality_score)}; degraded=${qualityReports.degraded_view_names.join(",") || "none"}; missing=${qualityReports.missing_view_names.join(",") || "none"}.`,
    `Calibration: ${calibrationContext.calibration_summary}`,
  ].join("\n");
  const mediaContent = [
    `Selected media refs: ${selectedMedia.map((media) => `${media.media_ref}(${media.source_view_name},${media.media_kind})`).join("; ") || "none"}.`,
    `Omitted media refs: ${omittedMedia.map((media) => `${media.media_ref}:${media.reason}`).join("; ") || "none"}.`,
    `Estimated media tokens: ${estimatedMediaTokens}/${mediaBudgetTokens}.`,
  ].join("\n");
  const uncertaintyContent = [
    "Every visual claim must cite a selected view or inventory row.",
    "Treat single-view depth, pose, and containment judgments as weaker than multi-view or declared-depth evidence.",
    "Absence in an occluded, missing, stale, or low-quality view is unknown, not proof of absence.",
  ].join("\n");
  const telemetryContent = [
    `schema=${VISUAL_PROMPT_PACKAGER_SCHEMA_VERSION}`,
    `task_state_ref=${taskContext.task_state_ref}`,
    `bundle_ref=${bundle.bundle_ref}`,
    `quality_report_ref=${bundle.view_quality_report_ref}`,
    `calibration_context_ref=${calibrationContext.calibration_context_ref}`,
  ].join("; ");
  return Object.freeze({
    current_observation_section: makeSection("CurrentObservation", "Current multi-view observation", observationContent, "sensor_visual_current", bundle.bundle_ref, "required", 98),
    media_attachments_section: makeSection("MediaAttachments", "Selected visual media", mediaContent, "sensor_visual_current", bundle.bundle_ref, "conditional", 96),
    output_contract_section: makeSection("OutputContractInstruction", "Visual output contract", `Use output contract ${taskContext.output_contract_ref ?? "SceneUnderstandingResponse"} with prompt contract ${taskContext.prompt_contract_ref}.`, "schema_instruction", taskContext.prompt_contract_ref, "required", 94),
    uncertainty_section: makeSection("UncertaintyInstruction", "Visual uncertainty rules", uncertaintyContent, "schema_instruction", bundle.bundle_ref, "required", 92),
    telemetry_section: makeSection("TelemetryLabels", "Visual prompt telemetry", telemetryContent, "telemetry_label", bundle.bundle_ref, "required", 80),
    memory_context_section: buildMemorySection(taskContext),
    embodiment_context_section: buildEmbodimentSection(taskContext),
  });
}

function buildViewInventory(
  bundle: MultiViewObservationBundle,
  qualityReports: ViewQualityReportSet,
  calibrationContext: CalibrationPromptContext,
  policy: NormalizedPolicy,
): readonly VisualPromptViewInventoryRow[] {
  const rows: VisualPromptViewInventoryRow[] = [];
  const seen = new Set<CanonicalViewName>();
  for (const record of bundle.view_inventory) {
    const quality = qualityFor(qualityReports, record.canonical_view_name);
    const calibration = calibrationFor(calibrationContext, record.canonical_view_name, record.packet_ref);
    const includeStatus = record.status === "missing" || quality?.recommended_use === "not_recommended"
      ? "missing_or_unusable"
      : "inventory_only";
    if (policy.include_low_quality_inventory || includeStatus !== "missing_or_unusable") {
      rows.push(Object.freeze({
        canonical_view_name: record.canonical_view_name,
        status: record.status,
        packet_ref: record.packet_ref,
        source_sensor_ref: record.sensor_ref,
        quality_score: quality?.quality_score,
        health_status: quality?.health_status,
        target_visibility: quality?.target_visibility,
        calibration_ref: calibration?.calibration_ref,
        prompt_safe_summary: inventorySummary(record.canonical_view_name, record.reason, quality, calibration),
        prompt_include_status: includeStatus,
      }));
    }
    seen.add(record.canonical_view_name);
  }
  for (const quality of qualityReports.per_view_reports) {
    if (!seen.has(quality.view_name)) {
      rows.push(Object.freeze({
        canonical_view_name: quality.view_name,
        status: "quality_only",
        packet_ref: quality.packet_ref,
        quality_score: quality.quality_score,
        health_status: quality.health_status,
        target_visibility: quality.target_visibility,
        calibration_ref: calibrationFor(calibrationContext, quality.view_name, quality.packet_ref)?.calibration_ref,
        prompt_safe_summary: `Quality-only row for ${quality.view_name}: health=${quality.health_status}, visibility=${quality.target_visibility}, score=${formatNumber(quality.quality_score)}.`,
        prompt_include_status: quality.recommended_use === "not_recommended" ? "missing_or_unusable" : "inventory_only",
      }));
    }
  }
  return freezeArray(rows.sort((a, b) => viewSortRank(a.canonical_view_name) - viewSortRank(b.canonical_view_name)));
}

function mergeSelectionIntoInventory(
  rows: readonly VisualPromptViewInventoryRow[],
  selectedViews: readonly CanonicalViewName[],
): readonly VisualPromptViewInventoryRow[] {
  const selected = new Set(selectedViews);
  return freezeArray(rows.map((row) => selected.has(row.canonical_view_name)
    ? Object.freeze({ ...row, prompt_include_status: "media_selected" as const })
    : row));
}

function validateSourceAlignment(
  bundle: MultiViewObservationBundle,
  qualityReports: ViewQualityReportSet,
  calibrationContext: CalibrationPromptContext,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (qualityReports.bundle_ref !== bundle.bundle_ref) {
    issues.push(makeIssue("error", "BundleQualityRefMismatch", "$.quality_reports.bundle_ref", "View quality report does not refer to the selected multi-view bundle.", "Run quality assessment against the same synchronized bundle."));
  }
  if (calibrationContext.bundle_ref !== bundle.bundle_ref) {
    issues.push(makeIssue("error", "BundleCalibrationRefMismatch", "$.calibration_context.bundle_ref", "Calibration context does not refer to the selected multi-view bundle.", "Assemble calibration context against the same synchronized bundle."));
  }
  if (bundle.calibration_context_ref !== calibrationContext.calibration_context_ref) {
    issues.push(makeIssue("warning", "BundleCalibrationRefMismatch", "$.bundle.calibration_context_ref", "Bundle seed calibration ref differs from the assembled calibration context ref.", "Refresh the bundle reference after calibration assembly when strict identity is required."));
  }
  return freezeArray(issues);
}

function validateTaskContext(taskContext: VisualPromptTaskContext): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (taskContext.prompt_contract_ref.trim().length === 0) {
    issues.push(makeIssue("error", "PromptContractMissing", "$.prompt_contract_ref", "Visual prompt packaging requires a File 07 prompt contract ref.", "Attach the resolved prompt contract before packaging visual evidence."));
  }
  if ((taskContext.output_contract_ref ?? "SceneUnderstandingResponse").trim().length === 0) {
    issues.push(makeIssue("error", "OutputContractMissing", "$.output_contract_ref", "Visual prompt packaging requires an output contract ref.", "Attach the expected structured response contract."));
  }
  return freezeArray(issues);
}

function validateBudget(budget: NormalizedBudget): readonly ValidationIssue[] {
  if (budget.max_media_tokens <= 0 || budget.full_view_token_cost <= 0 || budget.crop_token_cost <= 0 || budget.summary_token_cost <= 0) {
    return freezeArray([makeIssue("error", "MediaBudgetInvalid", "$.media_budget", "Media budget and token costs must be positive.", "Provide positive finite media token budget values.")]);
  }
  return freezeArray([]);
}

function validateSyncQuality(
  bundle: MultiViewObservationBundle,
  taskContext: VisualPromptTaskContext,
  policy: NormalizedPolicy,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (bundle.sync_quality === "desynchronized" && policy.forbid_desynchronized_bundle) {
    issues.push(makeIssue("error", "DesynchronizedBundle", "$.sync_quality", "Desynchronized visual bundles cannot be packaged for Gemini visual reasoning.", "Recapture a tight or acceptable multi-view bundle."));
  }
  if (bundle.sync_quality === "loose" && !policy.allow_loose_sync_for_observation && taskContext.task_phase !== "observe" && taskContext.task_phase !== "reobserve") {
    issues.push(makeIssue("warning", "DesynchronizedBundle", "$.sync_quality", "Loose synchronization is weak for action-bearing visual reasoning.", "Use only for low-risk observation or recapture tighter views."));
  }
  return freezeArray(issues);
}

function scanPromptVisibleText(
  taskContext: VisualPromptTaskContext,
  qualityReports: ViewQualityReportSet,
  calibrationContext: CalibrationPromptContext,
): readonly ValidationIssue[] {
  const textSurfaces = [
    taskContext.task_visual_objective,
    ...(taskContext.memory_visual_priors ?? []),
    taskContext.embodiment_viewpoint_context ?? "",
    ...(taskContext.validator_notes ?? []),
    qualityReports.issues.map((issue) => `${issue.code} ${issue.message}`).join(" "),
    calibrationContext.calibration_summary,
  ].join("\n");
  if (HIDDEN_VISUAL_EVIDENCE_PATTERN.test(textSurfaces)) {
    return freezeArray([makeIssue("error", "HiddenVisualEvidenceLeak", "$.prompt_visible_text", "Prompt-visible visual text contains simulator, debug, QA, or backend evidence wording.", "Sanitize task, memory, calibration, or validator text to sensor-derived evidence only.")]);
  }
  return freezeArray([]);
}

function validateCropRequest(
  request: VisualAttentionRequest,
  packet: SynchronizedViewPacket | undefined,
  quality: ViewQualityReport | undefined,
  policy: NormalizedPolicy,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (packet === undefined) {
    issues.push(makeIssue(request.required === true ? "error" : "warning", "CropSourceMissing", `$.attention_requests.${request.request_ref}.source_view_name`, `Crop request ${request.request_ref} refers to missing view ${request.source_view_name}.`, "Reobserve the source view or drop the crop request."));
    return freezeArray(issues);
  }
  if (quality !== undefined && quality.quality_score < policy.min_quality_for_crop) {
    issues.push(makeIssue(request.required === true ? "error" : "warning", "ViewQualityTooLow", `$.attention_requests.${request.request_ref}.source_view_name`, `Crop source ${request.source_view_name} quality is ${formatNumber(quality.quality_score)}.`, "Recapture or use a higher-quality alternate view."));
  }
  const regionIssues = validateRegion(request.region_definition, request.request_ref);
  issues.push(...regionIssues);
  if (request.region_definition.margin_fraction < 0.06) {
    issues.push(makeIssue("warning", "CropContextTooTight", `$.attention_requests.${request.request_ref}.region_definition.margin_fraction`, "Crop margin is too small to preserve relation context.", "Use a broader crop so support surfaces, container rims, gripper, and obstacles remain visible."));
  }
  return freezeArray(issues);
}

function validateRegion(region: CropRegionDefinition, requestRef: Ref): readonly ValidationIssue[] {
  const finite = [region.x, region.y, region.width, region.height, region.margin_fraction, region.scale_factor].every(Number.isFinite);
  const issues: ValidationIssue[] = [];
  if (!finite || region.width <= 0 || region.height <= 0 || region.margin_fraction < 0 || region.scale_factor <= 0) {
    issues.push(makeIssue("error", "CropRegionInvalid", `$.attention_requests.${requestRef}.region_definition`, "Crop region values must be finite with positive width, height, and scale.", "Normalize the crop request before media packaging."));
  }
  if (region.coordinate_space === "normalized_image") {
    const x2 = region.x + region.width;
    const y2 = region.y + region.height;
    if (region.x < 0 || region.y < 0 || x2 > 1 || y2 > 1) {
      issues.push(makeIssue("error", "CropRegionInvalid", `$.attention_requests.${requestRef}.region_definition`, "Normalized crop region must stay within [0, 1] image bounds.", "Clamp or recompute normalized crop coordinates."));
    }
  }
  if (region.retain_context_note.trim().length === 0) {
    issues.push(makeIssue("warning", "CropContextTooTight", `$.attention_requests.${requestRef}.region_definition.retain_context_note`, "Crop request lacks a context-retention note.", "Name the surrounding scene context the crop must retain."));
  }
  return freezeArray(issues);
}

function omissionsForMissingSources(
  attentionRequests: readonly VisualAttentionRequest[],
  bundle: MultiViewObservationBundle,
): readonly OmittedVisualPromptMedia[] {
  return freezeArray(attentionRequests
    .filter((request) => bundle.view_packets[request.source_view_name] === undefined)
    .map((request) => Object.freeze({
      media_ref: makeRef("visual_media", "crop", request.request_ref),
      source_view_name: request.source_view_name,
      reason: "source_missing" as const,
      rationale: `Crop request ${request.request_ref} omitted because ${request.source_view_name} is absent from the bundle.`,
    })));
}

function summaryOnlyCandidate(
  viewName: CanonicalViewName,
  packet: SynchronizedViewPacket,
  report: ViewQualityReport | undefined,
  calibration: CalibrationPromptViewContext | undefined,
  tokenCost: number,
): CandidateMedia {
  const qualityScore = report?.quality_score ?? packet.confidence;
  return Object.freeze({
    media_ref: makeRef("visual_media", "summary", packet.packet_ref),
    media_kind: "summary_only",
    source_view_name: viewName,
    packet,
    quality_report: report,
    calibration_context: calibration,
    priority: viewPriority(viewName, packet.camera_role === "wrist_or_gripper" ? "grasp" : "observe") + qualityScore * 8,
    required: false,
    estimated_tokens: tokenCost,
    quality_score: qualityScore,
    rationale: `Included inventory summary for low-quality ${viewName}; image media is not relied on.`,
  });
}

function requiredViewsForTask(taskContext: VisualPromptTaskContext, policy: NormalizedPolicy): readonly CanonicalViewName[] {
  const base = new Set<CanonicalViewName>(taskContext.required_views ?? []);
  if (policy.require_primary_view) {
    base.add("front_primary");
  }
  switch (taskContext.task_phase) {
    case "grasp":
    case "place":
    case "tool_assess":
      base.add("wrist_or_mouth");
      break;
    case "verify":
      base.add("verification_aux");
      break;
    case "observe":
    case "reobserve":
    case "planning":
    case "correct":
      break;
  }
  return freezeArray([...base].sort((a, b) => viewSortRank(a) - viewSortRank(b)));
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

function qualityFor(qualityReports: ViewQualityReportSet, viewName: CanonicalViewName): ViewQualityReport | undefined {
  return qualityReports.per_view_reports.find((report) => report.view_name === viewName);
}

function calibrationFor(
  calibrationContext: CalibrationPromptContext,
  viewName: CanonicalViewName,
  packetRef: Ref | undefined,
): CalibrationPromptViewContext | undefined {
  return calibrationContext.view_contexts.find((context) =>
    context.canonical_view_name === viewName && (packetRef === undefined || context.packet_ref === undefined || context.packet_ref === packetRef));
}

function isUnsafePacket(
  packet: SynchronizedViewPacket,
  quality: ViewQualityReport | undefined,
  calibration: CalibrationPromptViewContext | undefined,
): boolean {
  return HIDDEN_VISUAL_EVIDENCE_PATTERN.test(JSON.stringify({
    image_ref: packet.image_ref,
    depth_ref: packet.depth_ref,
    quality_summary: quality?.issues.map((issue) => issue.message),
    calibration_summary: calibration?.prompt_safe_summary,
  }));
}

function selectedMediaKinds(media: readonly SelectedVisualPromptMedia[], kind: VisualMediaKind): readonly SelectedVisualPromptMedia[] {
  return freezeArray(media.filter((item) => item.media_kind === kind));
}

function isViewUnusable(viewName: CanonicalViewName, inventory: readonly VisualPromptViewInventoryRow[]): boolean {
  const row = inventory.find((item) => item.canonical_view_name === viewName);
  return row === undefined || row.prompt_include_status === "missing_or_unusable";
}

function chooseRecommendedAction(
  bundle: MultiViewObservationBundle,
  qualityReports: ViewQualityReportSet,
  missingRequiredViews: readonly CanonicalViewName[],
  issues: readonly ValidationIssue[],
): VisualPromptRecommendedAction {
  if (missingRequiredViews.includes("front_primary") || issues.some((issue) => issue.code === "AllMediaOmitted")) {
    return "safe_hold";
  }
  if (bundle.sync_quality === "desynchronized" || qualityReports.recommended_action === "recapture") {
    return "recapture";
  }
  if (missingRequiredViews.length > 0 || qualityReports.recommended_action === "reobserve") {
    return "reobserve";
  }
  if (issues.some((issue) => issue.severity === "error")) {
    return "human_review";
  }
  return "continue";
}

function decidePackaging(issues: readonly ValidationIssue[], omittedMedia: readonly OmittedVisualPromptMedia[]): VisualPromptDecision {
  if (issues.some((issue) => issue.severity === "error")) {
    return "rejected";
  }
  return issues.length > 0 || omittedMedia.length > 0 ? "packaged_with_warnings" : "packaged";
}

function buildMemorySection(taskContext: VisualPromptTaskContext): CognitivePromptPacketSection | undefined {
  const priors = taskContext.memory_visual_priors ?? [];
  if (priors.length === 0) {
    return undefined;
  }
  const content = priors.map((prior, index) => `Memory prior ${index + 1}: ${prior}`).join("\n");
  return makeSection("MemoryContext", "Visual memory priors", `${content}\nMemory priors are fallible and current views are authoritative.`, "memory_prior", taskContext.task_state_ref, "optional", 50);
}

function buildEmbodimentSection(taskContext: VisualPromptTaskContext): CognitivePromptPacketSection | undefined {
  if (taskContext.embodiment_viewpoint_context === undefined || taskContext.embodiment_viewpoint_context.trim().length === 0) {
    return undefined;
  }
  return makeSection("EmbodimentContext", "Embodiment viewpoint context", taskContext.embodiment_viewpoint_context, "embodiment_self_knowledge", taskContext.task_state_ref, "conditional", 70);
}

function makeSection(
  kind: PromptPacketSectionKind,
  title: string,
  content: string,
  provenanceLabel: PromptProvenanceLabel,
  sourceRef: Ref,
  requirement: CognitivePromptPacketSection["requirement"],
  priorityRank: number,
): CognitivePromptPacketSection {
  return Object.freeze({
    section_ref: makeRef("visual_section", kind, sourceRef),
    section_kind: kind,
    title,
    content,
    provenance_label: provenanceLabel,
    source_ref: sourceRef,
    requirement,
    priority_rank: priorityRank,
    estimated_tokens: estimateTextTokens(`${title}\n${content}`),
    telemetry_label: makeRef("telemetry", "visual_prompt", kind, sourceRef),
  });
}

function inventorySummary(
  viewName: CanonicalViewName,
  reason: string,
  quality: ViewQualityReport | undefined,
  calibration: CalibrationPromptViewContext | undefined,
): string {
  const qualitySummary = quality === undefined
    ? "quality unavailable"
    : `quality=${formatNumber(quality.quality_score)}, health=${quality.health_status}, visibility=${quality.target_visibility}`;
  const calibrationSummary = calibration === undefined
    ? "declared calibration unavailable"
    : calibration.prompt_safe_summary;
  return `${viewName}: ${reason}; ${qualitySummary}; ${calibrationSummary}`;
}

function promptSafeMediaSummary(candidate: CandidateMedia): string {
  const crop = candidate.crop_request;
  if (crop === undefined) {
    return `${candidate.source_view_name} ${candidate.media_kind} from packet ${candidate.packet.packet_ref}; quality=${formatNumber(candidate.quality_score)}; ${candidate.rationale}`;
  }
  return `${candidate.source_view_name} crop ${crop.request_ref} for ${crop.crop_reason}; source packet=${candidate.packet.packet_ref}; quality=${formatNumber(candidate.quality_score)}; context=${crop.region_definition.retain_context_note}`;
}

function omit(candidate: CandidateMedia, reason: OmittedVisualMediaReason, rationale: string): OmittedVisualPromptMedia {
  return Object.freeze({
    media_ref: candidate.media_ref,
    source_view_name: candidate.source_view_name,
    reason,
    rationale,
  });
}

function viewPriority(viewName: CanonicalViewName, phase: PerceptionTaskPhase): number {
  const phaseWeights: Readonly<Record<PerceptionTaskPhase, Partial<Record<CanonicalViewName, number>>>> = {
    observe: { front_primary: 90, left_aux: 72, right_aux: 72, depth_primary: 62, wrist_or_mouth: 52, rear_body: 38, verification_aux: 45 },
    reobserve: { front_primary: 92, left_aux: 78, right_aux: 78, depth_primary: 66, wrist_or_mouth: 65, rear_body: 42, verification_aux: 58 },
    planning: { front_primary: 92, left_aux: 76, right_aux: 76, depth_primary: 70, wrist_or_mouth: 68, rear_body: 35, verification_aux: 54 },
    grasp: { wrist_or_mouth: 96, front_primary: 90, depth_primary: 78, left_aux: 70, right_aux: 70, verification_aux: 55, rear_body: 34 },
    place: { wrist_or_mouth: 94, front_primary: 90, verification_aux: 82, depth_primary: 76, left_aux: 72, right_aux: 72, rear_body: 34 },
    verify: { verification_aux: 96, front_primary: 92, left_aux: 78, right_aux: 78, wrist_or_mouth: 70, depth_primary: 70, rear_body: 42 },
    correct: { front_primary: 94, wrist_or_mouth: 86, left_aux: 80, right_aux: 80, verification_aux: 76, depth_primary: 70, rear_body: 55 },
    tool_assess: { wrist_or_mouth: 94, front_primary: 88, left_aux: 76, right_aux: 76, verification_aux: 64, depth_primary: 66, rear_body: 46 },
  };
  return phaseWeights[phase][viewName] ?? 40;
}

function cropReasonPriority(reason: CropReason): number {
  const priorities: Readonly<Record<CropReason, number>> = {
    object_identification: 14,
    grasp_inspection: 25,
    placement_verification: 24,
    tool_affordance: 22,
    failure_evidence: 26,
    memory_write: 8,
  };
  return priorities[reason];
}

function compareCandidates(a: CandidateMedia, b: CandidateMedia): number {
  const requiredDelta = Number(b.required) - Number(a.required);
  if (requiredDelta !== 0) {
    return requiredDelta;
  }
  const fullViewDelta = Number(b.media_kind === "full_view") - Number(a.media_kind === "full_view");
  if (fullViewDelta !== 0) {
    return fullViewDelta;
  }
  const priorityDelta = b.priority - a.priority;
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  const qualityDelta = b.quality_score - a.quality_score;
  if (qualityDelta !== 0) {
    return qualityDelta;
  }
  return a.media_ref.localeCompare(b.media_ref);
}

function compareOmissions(a: OmittedVisualPromptMedia, b: OmittedVisualPromptMedia): number {
  return (a.source_view_name ?? "").localeCompare(b.source_view_name ?? "") || a.media_ref.localeCompare(b.media_ref);
}

function normalizeBudget(budget: VisualMediaBudget): NormalizedBudget {
  return Object.freeze({
    max_media_tokens: positiveOrDefault(budget.max_media_tokens, DEFAULT_MEDIA_BUDGET_TOKENS),
    max_selected_views: Math.max(1, Math.floor(positiveOrDefault(budget.max_selected_views, DEFAULT_MAX_SELECTED_VIEWS))),
    max_selected_crops: Math.max(0, Math.floor(positiveOrDefault(budget.max_selected_crops, DEFAULT_MAX_SELECTED_CROPS))),
    full_view_token_cost: positiveOrDefault(budget.full_view_token_cost, DEFAULT_FULL_VIEW_TOKEN_COST),
    crop_token_cost: positiveOrDefault(budget.crop_token_cost, DEFAULT_CROP_TOKEN_COST),
    summary_token_cost: positiveOrDefault(budget.summary_token_cost, DEFAULT_SUMMARY_TOKEN_COST),
    reserve_tokens: Math.max(0, budget.reserve_tokens ?? 0),
  });
}

function mergePolicy(base: NormalizedPolicy, override: VisualPromptPackagingPolicy): NormalizedPolicy {
  return Object.freeze({
    min_quality_for_full_view: clamp01(override.min_quality_for_full_view ?? base.min_quality_for_full_view),
    min_quality_for_crop: clamp01(override.min_quality_for_crop ?? base.min_quality_for_crop),
    require_primary_view: override.require_primary_view ?? base.require_primary_view,
    forbid_desynchronized_bundle: override.forbid_desynchronized_bundle ?? base.forbid_desynchronized_bundle,
    allow_loose_sync_for_observation: override.allow_loose_sync_for_observation ?? base.allow_loose_sync_for_observation,
    include_low_quality_inventory: override.include_low_quality_inventory ?? base.include_low_quality_inventory,
  });
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

function estimateTextTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function makeIssue(severity: ValidationSeverity, code: VisualPromptIssueCode, path: string, message: string, remediation: string): ValidationIssue {
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

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
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

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "") : "invalid";
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}
