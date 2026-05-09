/**
 * View quality assessor for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md`
 * sections 9.3, 9.5.1, 9.6.2, 9.17, 9.18, 9.19, and 9.20.
 *
 * The assessor converts synchronized multi-view bundles into per-view quality
 * reports. It scores blur, exposure, occlusion, crop completeness, staleness,
 * resolution, sensor health, and synchronization impact so later prompt media
 * selection and verification logic can reduce confidence or request reobserve.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import type { CanonicalViewName } from "./view_name_registry";
import type { MultiViewObservationBundle, MultiViewSyncQuality, PerceptionTaskPhase, SynchronizedViewPacket } from "./multi_view_synchronizer";

export const VIEW_QUALITY_ASSESSOR_SCHEMA_VERSION = "mebsuta.view_quality_assessor.v1" as const;

export type ViewHealthStatus = "healthy" | "degraded" | "missing" | "stale";
export type BlurLevel = "none" | "low" | "medium" | "high" | "unusable";
export type ExposureLevel = "normal" | "low_light" | "overexposed" | "high_contrast";
export type TargetVisibility = "full" | "partial" | "edge_only" | "occluded" | "not_in_frame" | "unknown";
export type MotionContext = "robot_moving" | "object_moving" | "camera_stable" | "camera_disturbed";
export type RecommendedViewUse = "planning" | "grasp" | "verification" | "oops" | "memory" | "not_recommended";
export type QualityAction = "continue" | "reobserve" | "recapture" | "safe_hold" | "human_review";
export type ViewQualityIssueCode =
  | "BundleMissingViewPackets"
  | "RequiredViewQualityLow"
  | "CriticalViewMissing"
  | "BundleDesynchronized"
  | "ViewBlurHigh"
  | "ViewExposurePoor"
  | "TargetVisibilityInsufficient"
  | "CropCompletenessLow"
  | "ResolutionBelowMinimum"
  | "SensorHealthDegraded"
  | "SensorHealthStale";

/**
 * Optional image-derived indicators supplied by upstream vision preprocessing.
 * Values are normalized where possible and remain sensor-derived.
 */
export interface ViewImageQualityIndicators {
  readonly blur_variance_score?: number;
  readonly mean_luminance?: number;
  readonly contrast_ratio?: number;
  readonly occlusion_fraction?: number;
  readonly crop_completeness?: number;
  readonly target_bbox_fraction?: number;
  readonly self_occluder?: "limb" | "gripper" | "mouth" | "tool" | "body";
  readonly field_of_view_gap_likelihood?: number;
  readonly motion_context?: MotionContext;
}

/**
 * Task-side visual need. This is not simulator truth; it describes which views
 * and quality thresholds are needed for the current perception use.
 */
export interface TaskVisualNeed {
  readonly task_phase: PerceptionTaskPhase;
  readonly required_views?: readonly CanonicalViewName[];
  readonly critical_views?: readonly CanonicalViewName[];
  readonly minimum_quality_confidence?: number;
  readonly minimum_width_px?: number;
  readonly minimum_height_px?: number;
  readonly require_target_visible?: boolean;
  readonly require_depth_when_available?: boolean;
}

/**
 * Quality thresholds used by the deterministic scoring rules.
 */
export interface ViewQualityPolicy {
  readonly default_minimum_quality_confidence?: number;
  readonly blur_none_min_score?: number;
  readonly blur_low_min_score?: number;
  readonly blur_medium_min_score?: number;
  readonly luminance_low_threshold?: number;
  readonly luminance_high_threshold?: number;
  readonly contrast_high_threshold?: number;
  readonly occlusion_partial_threshold?: number;
  readonly occlusion_edge_threshold?: number;
  readonly occlusion_blocked_threshold?: number;
  readonly crop_minimum_completeness?: number;
  readonly minimum_target_bbox_fraction?: number;
}

/**
 * File 09 `ViewQualityReport` executable shape.
 */
export interface ViewQualityReport {
  readonly view_name: CanonicalViewName;
  readonly packet_ref?: Ref;
  readonly health_status: ViewHealthStatus;
  readonly blur_level: BlurLevel;
  readonly exposure_level: ExposureLevel;
  readonly target_visibility: TargetVisibility;
  readonly self_occlusion?: string;
  readonly field_of_view_gap?: string;
  readonly motion_context?: MotionContext;
  readonly quality_confidence: number;
  readonly recommended_use: RecommendedViewUse;
  readonly quality_score: number;
  readonly resolution_score: number;
  readonly staleness_score: number;
  readonly occlusion_score: number;
  readonly crop_completeness_score: number;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

/**
 * Bundle-level summary consumed by prompt media selection and verification.
 */
export interface ViewQualityReportSet {
  readonly schema_version: typeof VIEW_QUALITY_ASSESSOR_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md";
  readonly bundle_ref: Ref;
  readonly task_phase: PerceptionTaskPhase;
  readonly per_view_reports: readonly ViewQualityReport[];
  readonly bundle_quality_score: number;
  readonly usable_view_count: number;
  readonly missing_view_names: readonly CanonicalViewName[];
  readonly degraded_view_names: readonly CanonicalViewName[];
  readonly critical_view_failures: readonly CanonicalViewName[];
  readonly recommended_action: QualityAction;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
  readonly cognitive_visibility: "perception_view_quality_report_set";
}

const DEFAULT_POLICY: Required<ViewQualityPolicy> = Object.freeze({
  default_minimum_quality_confidence: 0.55,
  blur_none_min_score: 0.82,
  blur_low_min_score: 0.64,
  blur_medium_min_score: 0.42,
  luminance_low_threshold: 0.18,
  luminance_high_threshold: 0.92,
  contrast_high_threshold: 0.82,
  occlusion_partial_threshold: 0.18,
  occlusion_edge_threshold: 0.48,
  occlusion_blocked_threshold: 0.72,
  crop_minimum_completeness: 0.7,
  minimum_target_bbox_fraction: 0.015,
});

/**
 * Executable File 09 `ViewQualityAssessor`.
 */
export class ViewQualityAssessor {
  private readonly policy: Required<ViewQualityPolicy>;

  public constructor(policy: ViewQualityPolicy = {}) {
    this.policy = mergePolicy(DEFAULT_POLICY, policy);
  }

  /**
   * Scores all included and missing views in a synchronized bundle.
   */
  public assessViewQuality(
    multiViewBundle: MultiViewObservationBundle,
    taskVisualNeed: TaskVisualNeed,
    qualityPolicy: ViewQualityPolicy = {},
    indicators: Readonly<Partial<Record<CanonicalViewName, ViewImageQualityIndicators>>> = {},
  ): ViewQualityReportSet {
    const activePolicy = mergePolicy(this.policy, qualityPolicy);
    const issues: ValidationIssue[] = [];
    if (Object.keys(multiViewBundle.view_packets).length === 0) {
      issues.push(makeIssue("error", "BundleMissingViewPackets", "$.view_packets", "View quality assessment requires at least one synchronized view packet.", "Reobserve and provide a synchronized multi-view bundle."));
    }
    if (multiViewBundle.sync_quality === "desynchronized") {
      issues.push(makeIssue("error", "BundleDesynchronized", "$.sync_quality", "Desynchronized bundles cannot support reliable visual quality assessment.", "Recapture a tight or acceptable multi-view bundle."));
    }

    const requiredViews = freezeArray(taskVisualNeed.required_views ?? (["front_primary"] as readonly CanonicalViewName[]));
    const criticalViews = freezeArray(taskVisualNeed.critical_views ?? criticalViewsForPhase(taskVisualNeed.task_phase));
    const reports = buildReports(multiViewBundle, taskVisualNeed, indicators, activePolicy, requiredViews, criticalViews, issues);
    const usableReports = reports.filter((report) => report.recommended_use !== "not_recommended" && report.health_status !== "missing");
    const missingViewNames = reports.filter((report) => report.health_status === "missing").map((report) => report.view_name).sort();
    const degradedViewNames = reports.filter((report) => report.health_status === "degraded" || report.health_status === "stale" || report.quality_score < minimumQuality(taskVisualNeed, activePolicy)).map((report) => report.view_name).sort();
    const criticalViewFailures = reports
      .filter((report) => criticalViews.includes(report.view_name) && (report.health_status === "missing" || report.quality_score < minimumQuality(taskVisualNeed, activePolicy)))
      .map((report) => report.view_name)
      .sort();
    for (const viewName of criticalViewFailures) {
      issues.push(makeIssue("error", viewName === "front_primary" ? "CriticalViewMissing" : "RequiredViewQualityLow", `$.critical_views.${viewName}`, `Critical view ${viewName} is missing or below quality threshold.`, "Reobserve the named view before manipulation, verification, or prompt media selection."));
    }

    const bundleQualityScore = roundScore(usableReports.length === 0 ? 0 : usableReports.reduce((sum, report) => sum + report.quality_score, 0) / usableReports.length);
    const recommendedAction = chooseRecommendedAction(multiViewBundle.sync_quality, bundleQualityScore, minimumQuality(taskVisualNeed, activePolicy), missingViewNames, criticalViewFailures, issues);
    const shell = {
      bundle_ref: multiViewBundle.bundle_ref,
      task_phase: taskVisualNeed.task_phase,
      reports: reports.map((report) => [report.view_name, report.quality_score, report.health_status, report.recommended_use]),
      missing: missingViewNames,
      degraded: degradedViewNames,
      critical: criticalViewFailures,
      action: recommendedAction,
    };
    return Object.freeze({
      schema_version: VIEW_QUALITY_ASSESSOR_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md",
      bundle_ref: multiViewBundle.bundle_ref,
      task_phase: taskVisualNeed.task_phase,
      per_view_reports: freezeArray(reports),
      bundle_quality_score: bundleQualityScore,
      usable_view_count: usableReports.length,
      missing_view_names: freezeArray(missingViewNames),
      degraded_view_names: freezeArray(degradedViewNames),
      critical_view_failures: freezeArray(criticalViewFailures),
      recommended_action: recommendedAction,
      issues: freezeArray(issues),
      ok: issues.every((issue) => issue.severity !== "error") && bundleQualityScore >= minimumQuality(taskVisualNeed, activePolicy),
      determinism_hash: computeDeterminismHash(shell),
      cognitive_visibility: "perception_view_quality_report_set",
    });
  }
}

/**
 * Functional API matching File 09's quality-assessment signature.
 */
export function assessViewQuality(
  multiViewBundle: MultiViewObservationBundle,
  taskVisualNeed: TaskVisualNeed,
  qualityPolicy: ViewQualityPolicy = {},
  indicators: Readonly<Partial<Record<CanonicalViewName, ViewImageQualityIndicators>>> = {},
): ViewQualityReportSet {
  return new ViewQualityAssessor(qualityPolicy).assessViewQuality(multiViewBundle, taskVisualNeed, qualityPolicy, indicators);
}

function buildReports(
  bundle: MultiViewObservationBundle,
  taskNeed: TaskVisualNeed,
  indicators: Readonly<Partial<Record<CanonicalViewName, ViewImageQualityIndicators>>>,
  policy: Required<ViewQualityPolicy>,
  requiredViews: readonly CanonicalViewName[],
  criticalViews: readonly CanonicalViewName[],
  issues: ValidationIssue[],
): readonly ViewQualityReport[] {
  const reports: ViewQualityReport[] = [];
  const expectedViews = uniqueSorted([
    ...Object.keys(bundle.view_packets),
    ...bundle.missing_views.map((view) => view.canonical_view_name),
    ...requiredViews,
    ...criticalViews,
  ] as readonly CanonicalViewName[]);
  for (const viewName of expectedViews) {
    const packet = bundle.view_packets[viewName];
    const viewIndicators = indicators[viewName] ?? Object.freeze({});
    if (packet === undefined) {
      reports.push(buildMissingReport(viewName));
    } else {
      reports.push(buildPacketReport(viewName, packet, bundle.sync_quality, taskNeed, viewIndicators, policy, issues));
    }
  }
  return freezeArray(reports.sort((a, b) => viewSortRank(a.view_name) - viewSortRank(b.view_name)));
}

function buildPacketReport(
  viewName: CanonicalViewName,
  packet: SynchronizedViewPacket,
  syncQuality: MultiViewSyncQuality,
  taskNeed: TaskVisualNeed,
  indicators: ViewImageQualityIndicators,
  policy: Required<ViewQualityPolicy>,
  issues: ValidationIssue[],
): ViewQualityReport {
  const localIssues: ValidationIssue[] = [];
  const healthStatus = healthStatusFor(packet);
  const blurLevel = classifyBlur(indicators, packet);
  const exposureLevel = classifyExposure(indicators);
  const targetVisibility = classifyTargetVisibility(indicators, taskNeed.require_target_visible ?? false);
  const resolutionScore = scoreResolution(packet, taskNeed);
  const stalenessScore = scoreStaleness(packet);
  const occlusionScore = scoreOcclusion(targetVisibility, indicators);
  const cropScore = scoreCropCompleteness(indicators);
  const qualityScore = computeQualityScore(packet, syncQuality, healthStatus, blurLevel, exposureLevel, targetVisibility, resolutionScore, stalenessScore, cropScore);
  const recommendedUse = chooseRecommendedUse(taskNeed.task_phase, qualityScore, minimumQuality(taskNeed, policy), healthStatus, targetVisibility);
  appendPerViewIssues(viewName, packet, blurLevel, exposureLevel, targetVisibility, resolutionScore, cropScore, healthStatus, policy, taskNeed, localIssues);
  issues.push(...localIssues);
  const shell = {
    viewName,
    packet_ref: packet.packet_ref,
    healthStatus,
    blurLevel,
    exposureLevel,
    targetVisibility,
    qualityScore,
    recommendedUse,
  };
  return Object.freeze({
    view_name: viewName,
    packet_ref: packet.packet_ref,
    health_status: healthStatus,
    blur_level: blurLevel,
    exposure_level: exposureLevel,
    target_visibility: targetVisibility,
    self_occlusion: indicators.self_occluder === undefined ? undefined : `${indicators.self_occluder} blocks part of ${viewName}`,
    field_of_view_gap: fieldOfViewGap(indicators),
    motion_context: indicators.motion_context,
    quality_confidence: qualityScore,
    recommended_use: recommendedUse,
    quality_score: qualityScore,
    resolution_score: resolutionScore,
    staleness_score: stalenessScore,
    occlusion_score: occlusionScore,
    crop_completeness_score: cropScore,
    issues: freezeArray(localIssues),
    determinism_hash: computeDeterminismHash(shell),
  });
}

function buildMissingReport(viewName: CanonicalViewName): ViewQualityReport {
  const issue = makeIssue("error", viewName === "front_primary" ? "CriticalViewMissing" : "RequiredViewQualityLow", `$.view_packets.${viewName}`, `View ${viewName} is missing.`, "Reobserve and capture the missing view.");
  return Object.freeze({
    view_name: viewName,
    health_status: "missing",
    blur_level: "unusable",
    exposure_level: "normal",
    target_visibility: "unknown",
    quality_confidence: 0,
    recommended_use: "not_recommended",
    quality_score: 0,
    resolution_score: 0,
    staleness_score: 0,
    occlusion_score: 0,
    crop_completeness_score: 0,
    issues: freezeArray([issue]),
    determinism_hash: computeDeterminismHash({ viewName, missing: true }),
  });
}

function healthStatusFor(packet: SynchronizedViewPacket): ViewHealthStatus {
  if (packet.health_status === "missing") {
    return "missing";
  }
  if (packet.health_status === "stale") {
    return "stale";
  }
  if (packet.health_status === "degraded" || packet.packet_status === "degraded") {
    return "degraded";
  }
  return "healthy";
}

function classifyBlur(indicators: ViewImageQualityIndicators, packet: SynchronizedViewPacket): BlurLevel {
  const score = clamp01(indicators.blur_variance_score ?? packet.confidence);
  if (score >= DEFAULT_POLICY.blur_none_min_score) {
    return "none";
  }
  if (score >= DEFAULT_POLICY.blur_low_min_score) {
    return "low";
  }
  if (score >= DEFAULT_POLICY.blur_medium_min_score) {
    return "medium";
  }
  if (score > 0.18) {
    return "high";
  }
  return "unusable";
}

function classifyExposure(indicators: ViewImageQualityIndicators): ExposureLevel {
  const luminance = indicators.mean_luminance;
  const contrast = indicators.contrast_ratio;
  if (contrast !== undefined && contrast >= DEFAULT_POLICY.contrast_high_threshold) {
    return "high_contrast";
  }
  if (luminance !== undefined && luminance < DEFAULT_POLICY.luminance_low_threshold) {
    return "low_light";
  }
  if (luminance !== undefined && luminance > DEFAULT_POLICY.luminance_high_threshold) {
    return "overexposed";
  }
  return "normal";
}

function classifyTargetVisibility(indicators: ViewImageQualityIndicators, targetRequired: boolean): TargetVisibility {
  if (indicators.target_bbox_fraction !== undefined && indicators.target_bbox_fraction < DEFAULT_POLICY.minimum_target_bbox_fraction) {
    return "edge_only";
  }
  const occlusion = indicators.occlusion_fraction;
  if (occlusion === undefined) {
    return targetRequired ? "unknown" : "full";
  }
  if (occlusion >= DEFAULT_POLICY.occlusion_blocked_threshold) {
    return "occluded";
  }
  if (occlusion >= DEFAULT_POLICY.occlusion_edge_threshold) {
    return "edge_only";
  }
  if (occlusion >= DEFAULT_POLICY.occlusion_partial_threshold) {
    return "partial";
  }
  return "full";
}

function scoreResolution(packet: SynchronizedViewPacket, taskNeed: TaskVisualNeed): number {
  const minWidth = taskNeed.minimum_width_px ?? 320;
  const minHeight = taskNeed.minimum_height_px ?? 240;
  const widthRatio = packet.image_ref.length > 0 ? 1 : 0;
  const dimensionalScore = Math.min(1, Math.sqrt(Math.max(0, widthRatio)));
  const referenceScore = packet.packet_ref.length > 0 && packet.sensor_ref.length > 0 ? 1 : 0;
  const sizeScore = minWidth > 0 && minHeight > 0 ? dimensionalScore : 1;
  return roundScore(Math.min(sizeScore, referenceScore));
}

function scoreStaleness(packet: SynchronizedViewPacket): number {
  if (packet.health_status === "stale") {
    return 0.2;
  }
  if (packet.age_ms <= 33.334) {
    return 1;
  }
  if (packet.age_ms <= 100) {
    return 0.82;
  }
  if (packet.age_ms <= 250) {
    return 0.55;
  }
  return 0.25;
}

function scoreOcclusion(visibility: TargetVisibility, indicators: ViewImageQualityIndicators): number {
  const base: Readonly<Record<TargetVisibility, number>> = {
    full: 1,
    partial: 0.72,
    edge_only: 0.44,
    occluded: 0.16,
    not_in_frame: 0.05,
    unknown: 0.55,
  };
  const fieldGapPenalty = clamp01(1 - (indicators.field_of_view_gap_likelihood ?? 0) * 0.55);
  return roundScore(base[visibility] * fieldGapPenalty);
}

function scoreCropCompleteness(indicators: ViewImageQualityIndicators): number {
  return roundScore(clamp01(indicators.crop_completeness ?? 1));
}

function computeQualityScore(
  packet: SynchronizedViewPacket,
  syncQuality: MultiViewSyncQuality,
  healthStatus: ViewHealthStatus,
  blurLevel: BlurLevel,
  exposureLevel: ExposureLevel,
  targetVisibility: TargetVisibility,
  resolutionScore: number,
  stalenessScore: number,
  cropScore: number,
): number {
  const weighted =
    0.16 * packet.confidence
    + 0.13 * syncScore(syncQuality)
    + 0.14 * healthScore(healthStatus)
    + 0.13 * blurScore(blurLevel)
    + 0.1 * exposureScore(exposureLevel)
    + 0.14 * visibilityScore(targetVisibility)
    + 0.08 * resolutionScore
    + 0.07 * stalenessScore
    + 0.05 * cropScore;
  return roundScore(clamp01(weighted));
}

function appendPerViewIssues(
  viewName: CanonicalViewName,
  packet: SynchronizedViewPacket,
  blurLevel: BlurLevel,
  exposureLevel: ExposureLevel,
  targetVisibility: TargetVisibility,
  resolutionScore: number,
  cropScore: number,
  healthStatus: ViewHealthStatus,
  policy: Required<ViewQualityPolicy>,
  taskNeed: TaskVisualNeed,
  issues: ValidationIssue[],
): void {
  if (healthStatus === "degraded") {
    issues.push(makeIssue("warning", "SensorHealthDegraded", `$.views.${viewName}.health_status`, `View ${viewName} sensor health is degraded.`, "Lower confidence or reobserve before high-risk action."));
  }
  if (healthStatus === "stale") {
    issues.push(makeIssue("error", "SensorHealthStale", `$.views.${viewName}.health_status`, `View ${viewName} is stale.`, "Capture a current frame."));
  }
  if (blurLevel === "high" || blurLevel === "unusable") {
    issues.push(makeIssue(blurLevel === "unusable" ? "error" : "warning", "ViewBlurHigh", `$.views.${viewName}.blur_level`, `View ${viewName} blur level is ${blurLevel}.`, "Reobserve or use another view before visual reasoning."));
  }
  if (exposureLevel === "low_light" || exposureLevel === "overexposed") {
    issues.push(makeIssue("warning", "ViewExposurePoor", `$.views.${viewName}.exposure_level`, `View ${viewName} exposure is ${exposureLevel}.`, "Reposition, adjust lighting if available, or downgrade confidence."));
  }
  if ((taskNeed.require_target_visible ?? false) && (targetVisibility === "occluded" || targetVisibility === "edge_only" || targetVisibility === "unknown" || targetVisibility === "not_in_frame")) {
    issues.push(makeIssue("error", "TargetVisibilityInsufficient", `$.views.${viewName}.target_visibility`, `Target visibility in ${viewName} is ${targetVisibility}.`, "Request a better view before planning or verification."));
  }
  if (cropScore < policy.crop_minimum_completeness) {
    issues.push(makeIssue("warning", "CropCompletenessLow", `$.views.${viewName}.crop_completeness`, `View ${viewName} crop completeness is ${cropScore}.`, "Use a broader view or attach a broad-plus-focused crop pair."));
  }
  if (resolutionScore < 1 && packet.packet_ref.length > 0) {
    issues.push(makeIssue("warning", "ResolutionBelowMinimum", `$.views.${viewName}.resolution`, `View ${viewName} does not meet requested resolution evidence thresholds.`, "Recapture at declared camera resolution or lower the task visual need."));
  }
}

function chooseRecommendedUse(phase: PerceptionTaskPhase, score: number, minimum: number, health: ViewHealthStatus, visibility: TargetVisibility): RecommendedViewUse {
  if (score < minimum || health === "missing" || health === "stale" || visibility === "not_in_frame" || visibility === "occluded") {
    return "not_recommended";
  }
  switch (phase) {
    case "grasp":
    case "place":
    case "tool_assess":
      return "grasp";
    case "verify":
      return "verification";
    case "correct":
      return "oops";
    case "observe":
    case "reobserve":
    case "planning":
      return "planning";
  }
}

function chooseRecommendedAction(
  syncQuality: MultiViewSyncQuality,
  bundleQuality: number,
  minimum: number,
  missingViews: readonly CanonicalViewName[],
  criticalFailures: readonly CanonicalViewName[],
  issues: readonly ValidationIssue[],
): QualityAction {
  if (syncQuality === "desynchronized" || issues.some((issue) => issue.code === "SensorHealthStale")) {
    return "recapture";
  }
  if (criticalFailures.includes("front_primary")) {
    return "safe_hold";
  }
  if (criticalFailures.length > 0 || missingViews.length > 0 || bundleQuality < minimum) {
    return "reobserve";
  }
  if (issues.some((issue) => issue.severity === "error")) {
    return "human_review";
  }
  return "continue";
}

function criticalViewsForPhase(phase: PerceptionTaskPhase): readonly CanonicalViewName[] {
  switch (phase) {
    case "grasp":
    case "place":
    case "tool_assess":
      return freezeArray(["front_primary", "wrist_or_mouth"] as const);
    case "verify":
      return freezeArray(["front_primary", "verification_aux"] as const);
    case "correct":
      return freezeArray(["front_primary"] as const);
    case "observe":
    case "reobserve":
    case "planning":
      return freezeArray(["front_primary"] as const);
  }
}

function minimumQuality(taskNeed: TaskVisualNeed, policy: Required<ViewQualityPolicy>): number {
  return clamp01(taskNeed.minimum_quality_confidence ?? policy.default_minimum_quality_confidence);
}

function fieldOfViewGap(indicators: ViewImageQualityIndicators): string | undefined {
  const likelihood = indicators.field_of_view_gap_likelihood ?? 0;
  return likelihood >= 0.5 ? `likely field-of-view gap, likelihood=${roundScore(likelihood)}` : undefined;
}

function syncScore(syncQuality: MultiViewSyncQuality): number {
  const scores: Readonly<Record<MultiViewSyncQuality, number>> = {
    tight: 1,
    acceptable: 0.9,
    loose: 0.62,
    desynchronized: 0.22,
  };
  return scores[syncQuality];
}

function healthScore(status: ViewHealthStatus): number {
  const scores: Readonly<Record<ViewHealthStatus, number>> = {
    healthy: 1,
    degraded: 0.62,
    stale: 0.25,
    missing: 0,
  };
  return scores[status];
}

function blurScore(level: BlurLevel): number {
  const scores: Readonly<Record<BlurLevel, number>> = {
    none: 1,
    low: 0.84,
    medium: 0.58,
    high: 0.28,
    unusable: 0,
  };
  return scores[level];
}

function exposureScore(level: ExposureLevel): number {
  const scores: Readonly<Record<ExposureLevel, number>> = {
    normal: 1,
    low_light: 0.62,
    overexposed: 0.55,
    high_contrast: 0.76,
  };
  return scores[level];
}

function visibilityScore(visibility: TargetVisibility): number {
  const scores: Readonly<Record<TargetVisibility, number>> = {
    full: 1,
    partial: 0.72,
    edge_only: 0.42,
    occluded: 0.12,
    not_in_frame: 0,
    unknown: 0.5,
  };
  return scores[visibility];
}

function mergePolicy(base: Required<ViewQualityPolicy>, override: ViewQualityPolicy): Required<ViewQualityPolicy> {
  return Object.freeze({
    default_minimum_quality_confidence: override.default_minimum_quality_confidence ?? base.default_minimum_quality_confidence,
    blur_none_min_score: override.blur_none_min_score ?? base.blur_none_min_score,
    blur_low_min_score: override.blur_low_min_score ?? base.blur_low_min_score,
    blur_medium_min_score: override.blur_medium_min_score ?? base.blur_medium_min_score,
    luminance_low_threshold: override.luminance_low_threshold ?? base.luminance_low_threshold,
    luminance_high_threshold: override.luminance_high_threshold ?? base.luminance_high_threshold,
    contrast_high_threshold: override.contrast_high_threshold ?? base.contrast_high_threshold,
    occlusion_partial_threshold: override.occlusion_partial_threshold ?? base.occlusion_partial_threshold,
    occlusion_edge_threshold: override.occlusion_edge_threshold ?? base.occlusion_edge_threshold,
    occlusion_blocked_threshold: override.occlusion_blocked_threshold ?? base.occlusion_blocked_threshold,
    crop_minimum_completeness: override.crop_minimum_completeness ?? base.crop_minimum_completeness,
    minimum_target_bbox_fraction: override.minimum_target_bbox_fraction ?? base.minimum_target_bbox_fraction,
  });
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

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function roundScore(value: number): number {
  return Math.round(clamp01(value) * 1000) / 1000;
}

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return freezeArray([...new Set(values)].sort());
}

function makeIssue(severity: ValidationSeverity, code: ViewQualityIssueCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}
