/**
 * Occlusion reasoner for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md`
 * sections 9.3, 9.5.1, 9.6.4, 9.10, 9.17, 9.18, 9.19, and 9.20.
 *
 * The reasoner turns view-quality signals, consensus objects, explicit view
 * conflicts, and body/tool occluder state into an executable `OcclusionReport`.
 * It keeps absence, occlusion, field-of-view gaps, low-quality evidence, and
 * missing views distinct so downstream planning and verification cannot mistake
 * unknown visual state for object absence or task success.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import type { CanonicalViewName } from "./view_name_registry";
import type { ViewQualityReport, ViewQualityReportSet } from "./view_quality_assessor";
import type {
  ConsensusObject,
  ConsensusOcclusionRecord,
  MultiViewConsensusReport,
  OcclusionKind,
  RecommendedNextView,
  ViewConflictRecord,
} from "./cross_view_consensus_engine";

export const OCCLUSION_REASONER_SCHEMA_VERSION = "mebsuta.occlusion_reasoner.v1" as const;

const HIDDEN_OCCLUSION_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|segmentation truth|debug buffer|debug overlay|qa_success|qa_label|qa_only|simulator truth|mesh_name|asset_id)/i;

export type OcclusionSeverity = "informational" | "degraded" | "blocking";
export type OcclusionDisposition = "clear_enough" | "ambiguous" | "reobserve_required" | "verification_blocked" | "safe_hold_required";
export type OcclusionRecommendedAction = "continue" | "downgrade_confidence" | "reobserve" | "recapture_tight_sync" | "safe_hold" | "human_review";
export type ReobserveMotionHint = "pan_or_tilt_camera" | "move_side_view" | "move_wrist_or_mouth_view" | "move_body_or_stance" | "release_or_move_tool" | "adjust_lighting" | "wait_for_settle" | "recapture_sync";
export type OcclusionReasonerIssueCode =
  | "ConsensusBundleMismatch"
  | "HiddenOcclusionLeak"
  | "MissingPrimaryView"
  | "ToolOccludesCriticalView"
  | "SelfOccludesCriticalView"
  | "TargetRelationHidden"
  | "ObjectAbsenceUnproven"
  | "LowQualityOcclusion"
  | "DesynchronizedOcclusionEvidence"
  | "ReobserveRequestMissing";

/**
 * State of the robot body, end effector, and tools that can block cameras.
 */
export interface BodyToolOcclusionState {
  readonly state_ref: Ref;
  readonly active_tool_ref?: Ref;
  readonly held_tool_label?: string;
  readonly tool_blocks_views?: readonly CanonicalViewName[];
  readonly self_occluding_parts?: readonly BodyPartOccluder[];
  readonly end_effector_occupancy?: readonly EndEffectorViewOccupancy[];
  readonly current_motion_state?: "stationary" | "moving" | "settling" | "unknown";
  readonly lighting_state?: "normal" | "low_light" | "glare" | "unknown";
}

/**
 * Robot body part likely to block an embodied camera.
 */
export interface BodyPartOccluder {
  readonly part_ref: Ref;
  readonly part_kind: "limb" | "gripper" | "mouth" | "tool" | "torso" | "head" | "body";
  readonly affected_views: readonly CanonicalViewName[];
  readonly confidence: number;
  readonly summary: string;
}

/**
 * View occupancy around the end effector, useful for grasp and placement
 * occlusion decisions.
 */
export interface EndEffectorViewOccupancy {
  readonly view_name: CanonicalViewName;
  readonly occupancy_fraction: number;
  readonly likely_blocker: "gripper" | "mouth" | "held_object" | "tool" | "target_object" | "unknown";
  readonly target_relation_hidden: boolean;
}

/**
 * Occlusion-reasoner policy thresholds.
 */
export interface OcclusionReasoningPolicy {
  readonly critical_views?: readonly CanonicalViewName[];
  readonly target_labels?: readonly string[];
  readonly max_occlusion_score_for_clear_view?: number;
  readonly min_quality_for_absence_claim?: number;
  readonly self_occlusion_block_threshold?: number;
  readonly tool_occlusion_block_threshold?: number;
  readonly require_alternate_view_for_tool?: boolean;
  readonly verification_requires_clear_relation?: boolean;
}

/**
 * Reasoned occlusion record with response routing.
 */
export interface ReasonedOcclusionRecord {
  readonly occlusion_ref: Ref;
  readonly occlusion_kind: OcclusionKind;
  readonly severity: OcclusionSeverity;
  readonly affected_label?: string;
  readonly affected_views: readonly CanonicalViewName[];
  readonly source_refs: readonly Ref[];
  readonly confidence: number;
  readonly absence_is_proven: false;
  readonly explanation: string;
  readonly planning_response: "allow_observe_only" | "allow_low_risk_approach" | "block_manipulation" | "block_verification" | "safe_hold";
  readonly verification_response: "clear_enough" | "ambiguous" | "cannot_assess";
  readonly oops_response: "record_possible_cause" | "not_oops_relevant";
}

/**
 * Concrete reobserve request emitted when evidence is insufficient.
 */
export interface OcclusionReobserveRequest {
  readonly request_ref: Ref;
  readonly requested_view: CanonicalViewName;
  readonly target_label?: string;
  readonly reason: string;
  readonly motion_hint: ReobserveMotionHint;
  readonly priority: number;
  readonly required_before: "planning" | "manipulation" | "verification" | "memory_write";
}

/**
 * Absence claim that is explicitly rejected because the view state is occluded,
 * degraded, missing, or otherwise not clear enough.
 */
export interface FalseAbsenceGuard {
  readonly guard_ref: Ref;
  readonly label: string;
  readonly blocked_views: readonly CanonicalViewName[];
  readonly reason: string;
  readonly required_evidence: readonly CanonicalViewName[];
}

/**
 * File 09 executable `OcclusionReport`.
 */
export interface OcclusionReport {
  readonly schema_version: typeof OCCLUSION_REASONER_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md";
  readonly occlusion_report_ref: Ref;
  readonly consensus_ref: Ref;
  readonly bundle_ref: Ref;
  readonly occlusions: readonly ReasonedOcclusionRecord[];
  readonly false_absence_guards: readonly FalseAbsenceGuard[];
  readonly reobserve_requests: readonly OcclusionReobserveRequest[];
  readonly blind_spot_views: readonly CanonicalViewName[];
  readonly verification_blockers: readonly string[];
  readonly planning_constraints: readonly string[];
  readonly disposition: OcclusionDisposition;
  readonly recommended_action: OcclusionRecommendedAction;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
  readonly cognitive_visibility: "perception_occlusion_report";
}

interface NormalizedPolicy {
  readonly critical_views: readonly CanonicalViewName[];
  readonly target_labels: readonly string[];
  readonly max_occlusion_score_for_clear_view: number;
  readonly min_quality_for_absence_claim: number;
  readonly self_occlusion_block_threshold: number;
  readonly tool_occlusion_block_threshold: number;
  readonly require_alternate_view_for_tool: boolean;
  readonly verification_requires_clear_relation: boolean;
}

const DEFAULT_POLICY: NormalizedPolicy = Object.freeze({
  critical_views: freezeArray(["front_primary"] as readonly CanonicalViewName[]),
  target_labels: freezeArray([] as readonly string[]),
  max_occlusion_score_for_clear_view: 0.42,
  min_quality_for_absence_claim: 0.7,
  self_occlusion_block_threshold: 0.58,
  tool_occlusion_block_threshold: 0.45,
  require_alternate_view_for_tool: true,
  verification_requires_clear_relation: true,
});

/**
 * Executable File 09 `OcclusionReasoner`.
 */
export class OcclusionReasoner {
  private readonly policy: NormalizedPolicy;

  public constructor(policy: OcclusionReasoningPolicy = {}) {
    this.policy = mergePolicy(DEFAULT_POLICY, policy);
  }

  /**
   * Builds a deterministic occlusion report from consensus, view-quality, and
   * body/tool occluder evidence.
   */
  public reasonAboutOcclusion(
    consensusReport: MultiViewConsensusReport,
    viewQualityReports: ViewQualityReportSet,
    bodyToolState: BodyToolOcclusionState = Object.freeze({ state_ref: "body_tool_state_unavailable" }),
    policy: OcclusionReasoningPolicy = {},
  ): OcclusionReport {
    const activePolicy = mergePolicy(this.policy, policy);
    const issues: ValidationIssue[] = [];
    validateInputs(consensusReport, viewQualityReports, bodyToolState, issues);

    const occlusions = deduplicateOcclusions([
      ...recordsFromConsensus(consensusReport, activePolicy),
      ...recordsFromQuality(viewQualityReports, activePolicy),
      ...recordsFromBodyToolState(bodyToolState, activePolicy),
      ...recordsFromObjects(consensusReport.consensus_objects, viewQualityReports, activePolicy),
      ...recordsFromConflicts(consensusReport.view_conflicts, activePolicy),
    ]);
    appendIssueSignals(occlusions, consensusReport, viewQualityReports, bodyToolState, activePolicy, issues);

    const falseAbsenceGuards = buildFalseAbsenceGuards(consensusReport, viewQualityReports, occlusions, activePolicy);
    const reobserveRequests = buildReobserveRequests(occlusions, falseAbsenceGuards, consensusReport, activePolicy);
    const blindSpotViews = uniqueSorted([
      ...consensusReport.occlusion_report.blind_spot_views,
      ...occlusions.flatMap((record) => record.severity === "blocking" || record.severity === "degraded" ? record.affected_views : []),
      ...viewQualityReports.missing_view_names,
    ]);
    if (needsReobserve(occlusions, falseAbsenceGuards, consensusReport) && reobserveRequests.length === 0) {
      issues.push(makeIssue("warning", "ReobserveRequestMissing", "$.reobserve_requests", "Occlusion risk requires reobserve but no request could be produced.", "Choose an embodied alternate view or recapture the primary view."));
    }
    const verificationBlockers = buildVerificationBlockers(occlusions, consensusReport, activePolicy);
    const planningConstraints = buildPlanningConstraints(occlusions, falseAbsenceGuards, consensusReport);
    const disposition = chooseDisposition(occlusions, verificationBlockers, reobserveRequests, consensusReport);
    const recommendedAction = chooseRecommendedAction(disposition, occlusions, issues, consensusReport);
    const reportRef = makeRef("occlusion_report", consensusReport.consensus_ref, bodyToolState.state_ref, occlusions.map((record) => record.occlusion_ref).join(":"));
    const sortedOcclusions: readonly ReasonedOcclusionRecord[] = freezeArray([...occlusions].sort(compareOcclusions));
    const sortedGuards: readonly FalseAbsenceGuard[] = freezeArray([...falseAbsenceGuards].sort((a: FalseAbsenceGuard, b: FalseAbsenceGuard) => a.guard_ref.localeCompare(b.guard_ref)));
    const sortedRequests: readonly OcclusionReobserveRequest[] = freezeArray([...reobserveRequests].sort(compareReobserveRequests));
    const shell = {
      reportRef,
      consensus: consensusReport.consensus_ref,
      occlusions: occlusions.map((record) => [record.occlusion_ref, record.occlusion_kind, record.severity]),
      guards: falseAbsenceGuards.map((guard) => guard.guard_ref),
      reobserve: reobserveRequests.map((request) => [request.requested_view, request.target_label]),
      disposition,
      issues: issues.map((issue) => issue.code),
    };
    return Object.freeze({
      schema_version: OCCLUSION_REASONER_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md",
      occlusion_report_ref: reportRef,
      consensus_ref: consensusReport.consensus_ref,
      bundle_ref: consensusReport.bundle_ref,
      occlusions: sortedOcclusions,
      false_absence_guards: sortedGuards,
      reobserve_requests: sortedRequests,
      blind_spot_views: freezeArray(blindSpotViews),
      verification_blockers: freezeArray(verificationBlockers),
      planning_constraints: freezeArray(planningConstraints),
      disposition,
      recommended_action: recommendedAction,
      issues: freezeArray(issues),
      ok: issues.every((issue) => issue.severity !== "error") && disposition !== "safe_hold_required",
      determinism_hash: computeDeterminismHash(shell),
      cognitive_visibility: "perception_occlusion_report",
    });
  }
}

/**
 * Functional API for File 09 occlusion reasoning.
 */
export function reasonAboutOcclusion(
  consensusReport: MultiViewConsensusReport,
  viewQualityReports: ViewQualityReportSet,
  bodyToolState: BodyToolOcclusionState = Object.freeze({ state_ref: "body_tool_state_unavailable" }),
  policy: OcclusionReasoningPolicy = {},
): OcclusionReport {
  return new OcclusionReasoner(policy).reasonAboutOcclusion(consensusReport, viewQualityReports, bodyToolState, policy);
}

function validateInputs(
  consensusReport: MultiViewConsensusReport,
  viewQualityReports: ViewQualityReportSet,
  bodyToolState: BodyToolOcclusionState,
  issues: ValidationIssue[],
): void {
  if (consensusReport.bundle_ref !== viewQualityReports.bundle_ref) {
    issues.push(makeIssue("error", "ConsensusBundleMismatch", "$.view_quality_reports.bundle_ref", "Consensus report and view quality report refer to different bundles.", "Run occlusion reasoning on matching File 09 bundle outputs."));
  }
  if (HIDDEN_OCCLUSION_PATTERN.test(JSON.stringify({ consensusReport, viewQualityReports, bodyToolState }))) {
    issues.push(makeIssue("error", "HiddenOcclusionLeak", "$.inputs", "Occlusion inputs contain hidden simulator, backend, QA, or debug identifiers.", "Repair upstream perception records to sensor-derived evidence only."));
  }
}

function recordsFromConsensus(consensusReport: MultiViewConsensusReport, policy: NormalizedPolicy): readonly ReasonedOcclusionRecord[] {
  const records: ReasonedOcclusionRecord[] = [];
  for (const source of consensusReport.occlusion_report.occlusions) {
    records.push(makeRecord({
      kind: source.occlusion_kind,
      label: source.affected_label,
      views: source.affected_views,
      sourceRefs: [source.occlusion_ref],
      confidence: source.confidence,
      severity: severityFromConsensus(source, policy),
      explanation: source.explanation,
    }));
  }
  for (const label of consensusReport.occlusion_report.absence_not_proven_labels) {
    const object = consensusReport.consensus_objects.find((candidate) => candidate.label === label);
    records.push(makeRecord({
      kind: "unknown",
      label,
      views: object?.missing_expected_views ?? consensusReport.occlusion_report.blind_spot_views,
      sourceRefs: object === undefined ? [consensusReport.consensus_ref] : [object.consensus_object_ref],
      confidence: 0.62,
      severity: object?.estimated_object_role === "target" ? "blocking" : "degraded",
      explanation: `${label} cannot be marked absent because current consensus reports occlusion, missing expected views, or weak evidence.`,
    }));
  }
  return freezeArray(records);
}

function recordsFromQuality(viewQualityReports: ViewQualityReportSet, policy: NormalizedPolicy): readonly ReasonedOcclusionRecord[] {
  const records: ReasonedOcclusionRecord[] = [];
  for (const report of viewQualityReports.per_view_reports) {
    if (report.health_status === "missing" || report.health_status === "stale") {
      records.push(makeRecord({
        kind: "field_of_view",
        views: [report.view_name],
        sourceRefs: [report.packet_ref ?? makeRef("quality", report.view_name)],
        confidence: 0.9,
        severity: policy.critical_views.includes(report.view_name) ? "blocking" : "degraded",
        explanation: `View ${report.view_name} is ${report.health_status}; visual absence from this view is unknown.`,
      }));
    }
    if (report.target_visibility === "occluded" || report.target_visibility === "edge_only" || report.target_visibility === "not_in_frame") {
      records.push(makeRecord({
        kind: report.target_visibility === "not_in_frame" ? "field_of_view" : inferQualityOcclusionKind(report),
        views: [report.view_name],
        sourceRefs: [report.packet_ref ?? makeRef("quality", report.view_name)],
        confidence: confidenceFromQuality(report),
        severity: severityFromQuality(report, policy),
        explanation: `View ${report.view_name} target visibility is ${report.target_visibility}; occlusion_score=${formatScore(report.occlusion_score)}; quality=${formatScore(report.quality_score)}.`,
      }));
    }
    if (report.self_occlusion !== undefined) {
      records.push(makeRecord({
        kind: /tool/i.test(report.self_occlusion) ? "tool" : "robot_self",
        views: [report.view_name],
        sourceRefs: [report.packet_ref ?? makeRef("quality", report.view_name, "self_occlusion")],
        confidence: Math.max(0.55, 1 - report.occlusion_score),
        severity: policy.critical_views.includes(report.view_name) ? "blocking" : "degraded",
        explanation: report.self_occlusion,
      }));
    }
    if (report.field_of_view_gap !== undefined) {
      records.push(makeRecord({
        kind: "field_of_view",
        views: [report.view_name],
        sourceRefs: [report.packet_ref ?? makeRef("quality", report.view_name, "fov_gap")],
        confidence: 0.72,
        severity: "degraded",
        explanation: report.field_of_view_gap,
      }));
    }
    if (report.exposure_level === "low_light" || report.exposure_level === "overexposed" || report.blur_level === "high" || report.blur_level === "unusable") {
      records.push(makeRecord({
        kind: report.motion_context === "object_moving" || report.motion_context === "camera_disturbed" ? "motion" : "lighting_or_shadow",
        views: [report.view_name],
        sourceRefs: [report.packet_ref ?? makeRef("quality", report.view_name, "degraded_image")],
        confidence: report.blur_level === "unusable" ? 0.9 : 0.58,
        severity: report.recommended_use === "not_recommended" ? "blocking" : "degraded",
        explanation: `View ${report.view_name} is degraded by blur=${report.blur_level}, exposure=${report.exposure_level}, motion=${report.motion_context ?? "none"}.`,
      }));
    }
  }
  return freezeArray(records);
}

function recordsFromBodyToolState(bodyToolState: BodyToolOcclusionState, policy: NormalizedPolicy): readonly ReasonedOcclusionRecord[] {
  const records: ReasonedOcclusionRecord[] = [];
  for (const part of bodyToolState.self_occluding_parts ?? []) {
    records.push(makeRecord({
      kind: part.part_kind === "tool" ? "tool" : "robot_self",
      views: part.affected_views,
      sourceRefs: [part.part_ref, bodyToolState.state_ref],
      confidence: clamp01(part.confidence),
      severity: part.affected_views.some((view) => policy.critical_views.includes(view)) && part.confidence >= policy.self_occlusion_block_threshold ? "blocking" : "degraded",
      explanation: part.summary,
    }));
  }
  for (const occupancy of bodyToolState.end_effector_occupancy ?? []) {
    if (occupancy.occupancy_fraction >= policy.self_occlusion_block_threshold || occupancy.target_relation_hidden) {
      records.push(makeRecord({
        kind: occupancy.likely_blocker === "tool" ? "tool" : occupancy.likely_blocker === "target_object" ? "object_object" : "robot_self",
        views: [occupancy.view_name],
        sourceRefs: [bodyToolState.state_ref],
        confidence: clamp01(occupancy.occupancy_fraction),
        severity: occupancy.target_relation_hidden || policy.critical_views.includes(occupancy.view_name) ? "blocking" : "degraded",
        explanation: `End effector occupancy in ${occupancy.view_name}: blocker=${occupancy.likely_blocker}; occupancy=${formatScore(occupancy.occupancy_fraction)}; relation_hidden=${occupancy.target_relation_hidden}.`,
      }));
    }
  }
  for (const viewName of bodyToolState.tool_blocks_views ?? []) {
    records.push(makeRecord({
      kind: "tool",
      label: bodyToolState.held_tool_label,
      views: [viewName],
      sourceRefs: [bodyToolState.active_tool_ref ?? bodyToolState.state_ref],
      confidence: 0.82,
      severity: policy.require_alternate_view_for_tool || policy.critical_views.includes(viewName) ? "blocking" : "degraded",
      explanation: `Held tool ${bodyToolState.held_tool_label ?? "unknown"} blocks ${viewName}; alternate view is required before tool action or verification.`,
    }));
  }
  if (bodyToolState.current_motion_state === "moving" || bodyToolState.current_motion_state === "settling") {
    records.push(makeRecord({
      kind: "motion",
      views: policy.critical_views,
      sourceRefs: [bodyToolState.state_ref],
      confidence: bodyToolState.current_motion_state === "moving" ? 0.72 : 0.48,
      severity: bodyToolState.current_motion_state === "moving" ? "degraded" : "informational",
      explanation: `Robot/body state is ${bodyToolState.current_motion_state}; visual relation checks should wait for settled evidence when precision matters.`,
    }));
  }
  if (bodyToolState.lighting_state === "low_light" || bodyToolState.lighting_state === "glare") {
    records.push(makeRecord({
      kind: "lighting_or_shadow",
      views: policy.critical_views,
      sourceRefs: [bodyToolState.state_ref],
      confidence: 0.58,
      severity: "degraded",
      explanation: `Lighting state is ${bodyToolState.lighting_state}; shadows or glare may mimic object boundaries.`,
    }));
  }
  return freezeArray(records);
}

function recordsFromObjects(
  objects: readonly ConsensusObject[],
  viewQualityReports: ViewQualityReportSet,
  policy: NormalizedPolicy,
): readonly ReasonedOcclusionRecord[] {
  const records: ReasonedOcclusionRecord[] = [];
  const targetLabels = new Set(policy.target_labels.map(normalizeLabel));
  for (const object of objects) {
    const isTarget = object.estimated_object_role === "target" || targetLabels.has(normalizeLabel(object.label));
    if (object.status === "single_view_supported" || object.status === "occluded_or_out_of_view" || object.missing_expected_views.length > 0) {
      records.push(makeRecord({
        kind: inferObjectOcclusionKind(object),
        label: object.label,
        views: object.missing_expected_views.length > 0 ? object.missing_expected_views : object.supporting_view_names,
        sourceRefs: [object.consensus_object_ref, ...object.source_hypothesis_refs],
        confidence: object.status === "occluded_or_out_of_view" ? 0.78 : 0.52,
        severity: isTarget || object.missing_expected_views.some((view) => policy.critical_views.includes(view)) ? "blocking" : "degraded",
        explanation: `${object.label} status=${object.status}; supporting_views=${object.supporting_view_names.join(",") || "none"}; missing_expected_views=${object.missing_expected_views.join(",") || "none"}.`,
      }));
    }
    const relationHidden = object.spatial_relations.some((relation) => /hidden|occlud|blocked|rim|under|behind/i.test(relation.summary));
    if (relationHidden) {
      records.push(makeRecord({
        kind: inferObjectOcclusionKind(object),
        label: object.label,
        views: object.supporting_view_names,
        sourceRefs: [object.consensus_object_ref],
        confidence: 0.66,
        severity: isTarget && policy.verification_requires_clear_relation ? "blocking" : "degraded",
        explanation: `${object.label} has a hidden or blocked relation in visual spatial relation evidence; verification must remain ambiguous.`,
      }));
    }
    const weakViews = object.supporting_view_names.filter((viewName) => {
      const report = viewQualityReports.per_view_reports.find((view) => view.view_name === viewName);
      return report !== undefined && (report.target_visibility === "partial" || report.target_visibility === "edge_only" || report.occlusion_score <= policy.max_occlusion_score_for_clear_view);
    });
    if (weakViews.length > 0) {
      records.push(makeRecord({
        kind: "object_object",
        label: object.label,
        views: weakViews,
        sourceRefs: [object.consensus_object_ref],
        confidence: 0.5,
        severity: isTarget ? "degraded" : "informational",
        explanation: `${object.label} is supported by weak or partial views: ${weakViews.join(", ")}.`,
      }));
    }
  }
  return freezeArray(records);
}

function recordsFromConflicts(conflicts: readonly ViewConflictRecord[], policy: NormalizedPolicy): readonly ReasonedOcclusionRecord[] {
  return freezeArray(conflicts
    .filter((conflict) => conflict.conflict_kind === "missing_in_expected_view" || conflict.conflict_kind === "pose_conflict" || conflict.conflict_kind === "low_quality_conflict" || conflict.conflict_kind === "desync_risk")
    .map((conflict) => makeRecord({
      kind: conflict.conflict_kind === "desync_risk" ? "motion" : conflict.conflict_kind === "pose_conflict" ? "field_of_view" : "unknown",
      label: conflict.label,
      views: conflict.involved_views.length > 0 ? conflict.involved_views : policy.critical_views,
      sourceRefs: [conflict.conflict_ref, ...conflict.involved_hypothesis_refs],
      confidence: conflict.severity === "blocking" ? 0.78 : 0.52,
      severity: conflict.severity === "blocking" ? "blocking" : "degraded",
      explanation: conflict.summary,
    })));
}

function appendIssueSignals(
  occlusions: readonly ReasonedOcclusionRecord[],
  consensusReport: MultiViewConsensusReport,
  viewQualityReports: ViewQualityReportSet,
  bodyToolState: BodyToolOcclusionState,
  policy: NormalizedPolicy,
  issues: ValidationIssue[],
): void {
  if (viewQualityReports.missing_view_names.includes("front_primary")) {
    issues.push(makeIssue("error", "MissingPrimaryView", "$.view_quality.missing_view_names", "Primary view is missing; action-bearing visual planning must not continue.", "Reobserve or safe-hold until front_primary is current."));
  }
  if (occlusions.some((record) => record.occlusion_kind === "tool" && record.severity === "blocking")) {
    issues.push(makeIssue("error", "ToolOccludesCriticalView", "$.body_tool_state", "A tool blocks a critical camera or target relation.", "Move/release tool or acquire alternate view before tool action or verification."));
  }
  if (occlusions.some((record) => record.occlusion_kind === "robot_self" && record.severity === "blocking")) {
    issues.push(makeIssue("warning", "SelfOccludesCriticalView", "$.body_tool_state", "Robot body or end effector blocks a critical view.", "Move the sensor/body/end effector or use an alternate embodied view."));
  }
  if (policy.verification_requires_clear_relation && consensusReport.pose_readiness === "verification_ready" && occlusions.some((record) => record.verification_response !== "clear_enough")) {
    issues.push(makeIssue("warning", "TargetRelationHidden", "$.consensus_report.pose_readiness", "Consensus says verification-ready while occlusion reasoning finds hidden or ambiguous target relation.", "Require alternate visual relation evidence before declaring success."));
  }
  if (occlusions.some((record) => record.occlusion_kind === "lighting_or_shadow" || record.occlusion_kind === "motion")) {
    issues.push(makeIssue("warning", "LowQualityOcclusion", "$.view_quality", "Low-quality visual conditions may hide or mimic object boundaries.", "Downgrade confidence or reobserve after lighting/motion improves."));
  }
  if (consensusReport.recommended_action === "recapture_tight_sync") {
    issues.push(makeIssue("warning", "DesynchronizedOcclusionEvidence", "$.consensus_report.recommended_action", "Consensus recommends tight-sync recapture; occlusion evidence may be temporally inconsistent.", "Recapture synchronized views before final verification or manipulation."));
  }
  if (HIDDEN_OCCLUSION_PATTERN.test(JSON.stringify(bodyToolState))) {
    issues.push(makeIssue("error", "HiddenOcclusionLeak", "$.body_tool_state", "Body/tool occlusion state contains hidden simulator or debug wording.", "Expose only prompt-safe body/tool occlusion summaries."));
  }
}

function buildFalseAbsenceGuards(
  consensusReport: MultiViewConsensusReport,
  viewQualityReports: ViewQualityReportSet,
  occlusions: readonly ReasonedOcclusionRecord[],
  policy: NormalizedPolicy,
): readonly FalseAbsenceGuard[] {
  const guards: FalseAbsenceGuard[] = [];
  const blockedViews = uniqueSorted([
    ...viewQualityReports.per_view_reports
      .filter((report) => report.quality_score < policy.min_quality_for_absence_claim || report.target_visibility !== "full")
      .map((report) => report.view_name),
    ...occlusions.flatMap((record) => record.affected_views),
  ]);
  for (const label of consensusReport.occlusion_report.absence_not_proven_labels) {
    guards.push(makeGuard(label, blockedViews, "Consensus report already marks absence as unproven.", requiredEvidenceForLabel(label, consensusReport, policy)));
  }
  for (const object of consensusReport.consensus_objects) {
    if (object.status !== "multi_view_supported" || object.missing_expected_views.length > 0 || object.pose_confidence < 0.45) {
      guards.push(makeGuard(object.label, uniqueSorted([...blockedViews, ...object.missing_expected_views]), `${object.label} has status=${object.status}, pose=${formatScore(object.pose_confidence)}, missing_views=${object.missing_expected_views.join(",") || "none"}.`, requiredEvidenceForObject(object, policy)));
    }
  }
  for (const targetLabel of policy.target_labels) {
    const existing = consensusReport.consensus_objects.find((object) => normalizeLabel(object.label) === normalizeLabel(targetLabel));
    if (existing === undefined) {
      guards.push(makeGuard(targetLabel, blockedViews, "Target label is not currently visible in consensus; absence cannot be inferred from occluded or degraded views.", policy.critical_views));
    }
  }
  return freezeArray(deduplicateGuards(guards));
}

function buildReobserveRequests(
  occlusions: readonly ReasonedOcclusionRecord[],
  guards: readonly FalseAbsenceGuard[],
  consensusReport: MultiViewConsensusReport,
  policy: NormalizedPolicy,
): readonly OcclusionReobserveRequest[] {
  const requests: OcclusionReobserveRequest[] = [];
  for (const record of occlusions.filter((item) => item.severity !== "informational")) {
    const requestedView = chooseRequestedView(record, consensusReport, policy);
    requests.push(Object.freeze({
      request_ref: makeRef("occlusion_reobserve", record.occlusion_ref, requestedView),
      requested_view: requestedView,
      target_label: record.affected_label,
      reason: record.explanation,
      motion_hint: motionHintFor(record, requestedView),
      priority: priorityFor(record, policy),
      required_before: record.verification_response === "cannot_assess" ? "verification" : record.planning_response === "block_manipulation" ? "manipulation" : "planning",
    }));
  }
  for (const guard of guards) {
    const view = chooseFirstView(guard.required_evidence, policy.critical_views);
    requests.push(Object.freeze({
      request_ref: makeRef("absence_guard_reobserve", guard.guard_ref, view),
      requested_view: view,
      target_label: guard.label,
      reason: guard.reason,
      motion_hint: motionHintForKind("field_of_view", view),
      priority: guard.label.length > 0 ? 82 : 60,
      required_before: "planning",
    }));
  }
  const consensusNext = consensusReport.recommended_next_view;
  if (consensusNext !== undefined) {
    requests.push(fromConsensusNextView(consensusNext));
  }
  return freezeArray(deduplicateRequests(requests));
}

function buildVerificationBlockers(
  occlusions: readonly ReasonedOcclusionRecord[],
  consensusReport: MultiViewConsensusReport,
  policy: NormalizedPolicy,
): readonly string[] {
  const blockers = occlusions
    .filter((record) => record.verification_response === "cannot_assess" || (policy.verification_requires_clear_relation && record.severity === "blocking"))
    .map((record) => `${record.affected_label ?? record.occlusion_kind}: ${record.explanation}`);
  if (consensusReport.pose_readiness === "not_ready" || consensusReport.pose_readiness === "search_ready") {
    blockers.push(`consensus_pose_readiness=${consensusReport.pose_readiness}`);
  }
  return freezeArray(uniqueSorted(blockers));
}

function buildPlanningConstraints(
  occlusions: readonly ReasonedOcclusionRecord[],
  guards: readonly FalseAbsenceGuard[],
  consensusReport: MultiViewConsensusReport,
): readonly string[] {
  const constraints = occlusions.map((record) => `${record.planning_response}: ${record.affected_label ?? record.occlusion_kind} via ${record.affected_views.join(",") || "unknown view"}`);
  for (const guard of guards) {
    constraints.push(`absence_not_proven: ${guard.label}; need ${guard.required_evidence.join(",") || "clear current evidence"}`);
  }
  if (consensusReport.recommended_next_view !== undefined) {
    constraints.push(`consensus_next_view: ${consensusReport.recommended_next_view.requested_view}; ${consensusReport.recommended_next_view.reason}`);
  }
  return freezeArray(uniqueSorted(constraints));
}

function makeRecord(input: {
  readonly kind: OcclusionKind;
  readonly label?: string;
  readonly views: readonly CanonicalViewName[];
  readonly sourceRefs: readonly Ref[];
  readonly confidence: number;
  readonly severity: OcclusionSeverity;
  readonly explanation: string;
}): ReasonedOcclusionRecord {
  const severity = input.severity;
  return Object.freeze({
    occlusion_ref: makeRef("occlusion", input.kind, input.label ?? "scene", input.views.join("_"), input.sourceRefs.join("_")),
    occlusion_kind: input.kind,
    severity,
    affected_label: input.label,
    affected_views: freezeArray(uniqueSorted(input.views)),
    source_refs: freezeArray(uniqueSorted(input.sourceRefs)),
    confidence: roundScore(input.confidence),
    absence_is_proven: false,
    explanation: sanitizeText(input.explanation),
    planning_response: planningResponseFor(input.kind, severity),
    verification_response: verificationResponseFor(input.kind, severity),
    oops_response: severity === "informational" ? "not_oops_relevant" : "record_possible_cause",
  });
}

function makeGuard(label: string, blockedViews: readonly CanonicalViewName[], reason: string, requiredEvidence: readonly CanonicalViewName[]): FalseAbsenceGuard {
  return Object.freeze({
    guard_ref: makeRef("false_absence_guard", label, blockedViews.join("_"), requiredEvidence.join("_")),
    label,
    blocked_views: freezeArray(uniqueSorted(blockedViews)),
    reason: sanitizeText(reason),
    required_evidence: freezeArray(uniqueSorted(requiredEvidence)),
  });
}

function fromConsensusNextView(nextView: RecommendedNextView): OcclusionReobserveRequest {
  return Object.freeze({
    request_ref: makeRef("consensus_next_view", nextView.request_ref),
    requested_view: nextView.requested_view,
    target_label: nextView.requested_crop_label,
    reason: nextView.reason,
    motion_hint: nextView.expected_resolution === "recapture_sync" ? "recapture_sync" : motionHintForKind("field_of_view", nextView.requested_view),
    priority: nextView.priority,
    required_before: nextView.expected_resolution === "verification_cross_check" ? "verification" : "planning",
  });
}

function severityFromConsensus(record: ConsensusOcclusionRecord, policy: NormalizedPolicy): OcclusionSeverity {
  if (record.affected_views.some((view) => policy.critical_views.includes(view)) && record.confidence >= 0.55) {
    return "blocking";
  }
  if (record.confidence >= 0.35) {
    return "degraded";
  }
  return "informational";
}

function severityFromQuality(report: ViewQualityReport, policy: NormalizedPolicy): OcclusionSeverity {
  if (policy.critical_views.includes(report.view_name) && (report.target_visibility === "occluded" || report.target_visibility === "not_in_frame" || report.recommended_use === "not_recommended")) {
    return "blocking";
  }
  if (report.target_visibility === "edge_only" || report.target_visibility === "partial" || report.quality_score < policy.min_quality_for_absence_claim) {
    return "degraded";
  }
  return "informational";
}

function confidenceFromQuality(report: ViewQualityReport): number {
  if (report.target_visibility === "occluded" || report.target_visibility === "not_in_frame") {
    return Math.max(0.72, 1 - report.occlusion_score);
  }
  if (report.target_visibility === "edge_only") {
    return 0.58;
  }
  return 0.42;
}

function inferQualityOcclusionKind(report: ViewQualityReport): OcclusionKind {
  if (report.self_occlusion !== undefined) {
    return /tool/i.test(report.self_occlusion) ? "tool" : "robot_self";
  }
  if (report.field_of_view_gap !== undefined || report.target_visibility === "not_in_frame") {
    return "field_of_view";
  }
  if (report.motion_context === "object_moving" || report.motion_context === "camera_disturbed") {
    return "motion";
  }
  if (report.exposure_level !== "normal") {
    return "lighting_or_shadow";
  }
  return "object_object";
}

function inferObjectOcclusionKind(object: ConsensusObject): OcclusionKind {
  const text = `${object.visual_description_summary} ${object.spatial_relations.map((relation) => relation.summary).join(" ")}`.toLowerCase();
  if (/tool/.test(text)) return "tool";
  if (/gripper|mouth|limb|self|body/.test(text)) return "robot_self";
  if (/container|rim|bowl|box/.test(text)) return "container_rim";
  if (/table|support|under|behind/.test(text)) return "table_or_support";
  if (/shadow|glare|light/.test(text)) return "lighting_or_shadow";
  if (/motion|blur|moving/.test(text)) return "motion";
  if (object.missing_expected_views.length > 0) return "field_of_view";
  return "object_object";
}

function planningResponseFor(kind: OcclusionKind, severity: OcclusionSeverity): ReasonedOcclusionRecord["planning_response"] {
  if (severity === "blocking") {
    return kind === "field_of_view" || kind === "lighting_or_shadow" || kind === "motion" ? "allow_observe_only" : "block_manipulation";
  }
  if (severity === "degraded") {
    return "allow_low_risk_approach";
  }
  return "allow_observe_only";
}

function verificationResponseFor(kind: OcclusionKind, severity: OcclusionSeverity): ReasonedOcclusionRecord["verification_response"] {
  if (severity === "blocking") {
    return "cannot_assess";
  }
  if (severity === "degraded" || kind === "lighting_or_shadow" || kind === "motion") {
    return "ambiguous";
  }
  return "clear_enough";
}

function chooseDisposition(
  occlusions: readonly ReasonedOcclusionRecord[],
  verificationBlockers: readonly string[],
  reobserveRequests: readonly OcclusionReobserveRequest[],
  consensusReport: MultiViewConsensusReport,
): OcclusionDisposition {
  if (occlusions.some((record) => record.occlusion_kind === "tool" && record.severity === "blocking") || consensusReport.recommended_action === "safe_hold") {
    return "safe_hold_required";
  }
  if (verificationBlockers.length > 0) {
    return "verification_blocked";
  }
  if (reobserveRequests.length > 0 || occlusions.some((record) => record.severity === "blocking")) {
    return "reobserve_required";
  }
  if (occlusions.some((record) => record.severity === "degraded")) {
    return "ambiguous";
  }
  return "clear_enough";
}

function chooseRecommendedAction(
  disposition: OcclusionDisposition,
  occlusions: readonly ReasonedOcclusionRecord[],
  issues: readonly ValidationIssue[],
  consensusReport: MultiViewConsensusReport,
): OcclusionRecommendedAction {
  if (issues.some((issue) => issue.severity === "error" && issue.code === "HiddenOcclusionLeak")) {
    return "human_review";
  }
  if (disposition === "safe_hold_required") {
    return "safe_hold";
  }
  if (consensusReport.recommended_action === "recapture_tight_sync" || issues.some((issue) => issue.code === "DesynchronizedOcclusionEvidence")) {
    return "recapture_tight_sync";
  }
  if (disposition === "reobserve_required" || disposition === "verification_blocked") {
    return "reobserve";
  }
  if (disposition === "ambiguous" || occlusions.some((record) => record.severity === "degraded")) {
    return "downgrade_confidence";
  }
  return "continue";
}

function needsReobserve(
  occlusions: readonly ReasonedOcclusionRecord[],
  guards: readonly FalseAbsenceGuard[],
  consensusReport: MultiViewConsensusReport,
): boolean {
  return guards.length > 0
    || consensusReport.recommended_next_view !== undefined
    || occlusions.some((record) => record.severity === "blocking" || record.verification_response === "cannot_assess");
}

function chooseRequestedView(record: ReasonedOcclusionRecord, consensusReport: MultiViewConsensusReport, policy: NormalizedPolicy): CanonicalViewName {
  if (record.occlusion_kind === "tool" || record.occlusion_kind === "robot_self") {
    return chooseAlternateView(record.affected_views, ["left_aux", "right_aux", "rear_body", "front_primary"]);
  }
  if (record.occlusion_kind === "object_object" || record.occlusion_kind === "container_rim" || record.occlusion_kind === "table_or_support") {
    return chooseAlternateView(record.affected_views, ["left_aux", "right_aux", "wrist_or_mouth", "depth_primary", "front_primary"]);
  }
  if (record.occlusion_kind === "motion") {
    return record.affected_views[0] ?? "front_primary";
  }
  if (record.occlusion_kind === "lighting_or_shadow") {
    return record.affected_views[0] ?? "front_primary";
  }
  return consensusReport.recommended_next_view?.requested_view ?? chooseFirstView(record.affected_views, policy.critical_views);
}

function chooseAlternateView(currentViews: readonly CanonicalViewName[], candidates: readonly CanonicalViewName[]): CanonicalViewName {
  for (const candidate of candidates) {
    if (!currentViews.includes(candidate)) {
      return candidate;
    }
  }
  return candidates[0] ?? "front_primary";
}

function chooseFirstView(primary: readonly CanonicalViewName[], fallback: readonly CanonicalViewName[]): CanonicalViewName {
  return primary[0] ?? fallback[0] ?? "front_primary";
}

function motionHintFor(record: ReasonedOcclusionRecord, requestedView: CanonicalViewName): ReobserveMotionHint {
  return motionHintForKind(record.occlusion_kind, requestedView);
}

function motionHintForKind(kind: OcclusionKind, requestedView: CanonicalViewName): ReobserveMotionHint {
  if (kind === "tool") return "release_or_move_tool";
  if (kind === "robot_self") return requestedView === "wrist_or_mouth" ? "move_wrist_or_mouth_view" : "move_body_or_stance";
  if (kind === "object_object" || kind === "container_rim" || kind === "table_or_support") return requestedView === "wrist_or_mouth" ? "move_wrist_or_mouth_view" : "move_side_view";
  if (kind === "lighting_or_shadow") return "adjust_lighting";
  if (kind === "motion") return "wait_for_settle";
  return "pan_or_tilt_camera";
}

function priorityFor(record: ReasonedOcclusionRecord, policy: NormalizedPolicy): number {
  const base = record.severity === "blocking" ? 90 : record.severity === "degraded" ? 65 : 35;
  const criticalBoost = record.affected_views.some((view) => policy.critical_views.includes(view)) ? 10 : 0;
  const verificationBoost = record.verification_response === "cannot_assess" ? 8 : 0;
  return Math.min(100, Math.round(base + criticalBoost + verificationBoost + record.confidence * 8));
}

function requiredEvidenceForLabel(label: string, consensusReport: MultiViewConsensusReport, policy: NormalizedPolicy): readonly CanonicalViewName[] {
  const object = consensusReport.consensus_objects.find((candidate) => normalizeLabel(candidate.label) === normalizeLabel(label));
  return object === undefined ? policy.critical_views : requiredEvidenceForObject(object, policy);
}

function requiredEvidenceForObject(object: ConsensusObject, policy: NormalizedPolicy): readonly CanonicalViewName[] {
  const views = new Set<CanonicalViewName>(policy.critical_views);
  for (const view of object.missing_expected_views) {
    views.add(view);
  }
  if (object.estimated_object_role === "target" || object.affordance_hypotheses.length > 0) {
    views.add("wrist_or_mouth");
  }
  if (object.pose_confidence < 0.5) {
    views.add("left_aux");
    views.add("right_aux");
  }
  return freezeArray([...views].sort((a, b) => viewSortRank(a) - viewSortRank(b)));
}

function deduplicateOcclusions(records: readonly ReasonedOcclusionRecord[]): readonly ReasonedOcclusionRecord[] {
  const byKey = new Map<string, ReasonedOcclusionRecord>();
  for (const record of records) {
    const key = `${record.occlusion_kind}:${record.affected_label ?? ""}:${record.affected_views.join(",")}:${record.source_refs.join(",")}`;
    const existing = byKey.get(key);
    if (existing === undefined || severityRank(record.severity) > severityRank(existing.severity) || record.confidence > existing.confidence) {
      byKey.set(key, record);
    }
  }
  return freezeArray([...byKey.values()]);
}

function deduplicateGuards(guards: readonly FalseAbsenceGuard[]): readonly FalseAbsenceGuard[] {
  const byLabel = new Map<string, FalseAbsenceGuard>();
  for (const guard of guards) {
    const key = normalizeLabel(guard.label);
    const existing = byLabel.get(key);
    if (existing === undefined || guard.required_evidence.length > existing.required_evidence.length) {
      byLabel.set(key, guard);
    }
  }
  return freezeArray([...byLabel.values()]);
}

function deduplicateRequests(requests: readonly OcclusionReobserveRequest[]): readonly OcclusionReobserveRequest[] {
  const byKey = new Map<string, OcclusionReobserveRequest>();
  for (const request of requests) {
    const key = `${request.requested_view}:${normalizeLabel(request.target_label ?? "")}:${request.required_before}`;
    const existing = byKey.get(key);
    if (existing === undefined || request.priority > existing.priority) {
      byKey.set(key, request);
    }
  }
  return freezeArray([...byKey.values()]);
}

function compareOcclusions(a: ReasonedOcclusionRecord, b: ReasonedOcclusionRecord): number {
  return severityRank(b.severity) - severityRank(a.severity)
    || b.confidence - a.confidence
    || a.occlusion_kind.localeCompare(b.occlusion_kind)
    || a.occlusion_ref.localeCompare(b.occlusion_ref);
}

function compareReobserveRequests(a: OcclusionReobserveRequest, b: OcclusionReobserveRequest): number {
  return b.priority - a.priority
    || viewSortRank(a.requested_view) - viewSortRank(b.requested_view)
    || a.request_ref.localeCompare(b.request_ref);
}

function severityRank(severity: OcclusionSeverity): number {
  switch (severity) {
    case "blocking":
      return 3;
    case "degraded":
      return 2;
    case "informational":
      return 1;
  }
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

function sanitizeText(value: string): string {
  const cleaned = value.trim().replace(/\s+/g, " ").slice(0, 700);
  return HIDDEN_OCCLUSION_PATTERN.test(cleaned) ? "Occlusion explanation redacted because it contained unsafe hidden-source wording." : cleaned;
}

function mergePolicy(base: NormalizedPolicy, override: OcclusionReasoningPolicy): NormalizedPolicy {
  return Object.freeze({
    critical_views: freezeArray(override.critical_views ?? base.critical_views),
    target_labels: freezeArray(override.target_labels ?? base.target_labels),
    max_occlusion_score_for_clear_view: clamp01(override.max_occlusion_score_for_clear_view ?? base.max_occlusion_score_for_clear_view),
    min_quality_for_absence_claim: clamp01(override.min_quality_for_absence_claim ?? base.min_quality_for_absence_claim),
    self_occlusion_block_threshold: clamp01(override.self_occlusion_block_threshold ?? base.self_occlusion_block_threshold),
    tool_occlusion_block_threshold: clamp01(override.tool_occlusion_block_threshold ?? base.tool_occlusion_block_threshold),
    require_alternate_view_for_tool: override.require_alternate_view_for_tool ?? base.require_alternate_view_for_tool,
    verification_requires_clear_relation: override.verification_requires_clear_relation ?? base.verification_requires_clear_relation,
  });
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

function formatScore(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "") : "invalid";
}

function makeIssue(severity: ValidationSeverity, code: OcclusionReasonerIssueCode, path: string, message: string, remediation: string): ValidationIssue {
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
