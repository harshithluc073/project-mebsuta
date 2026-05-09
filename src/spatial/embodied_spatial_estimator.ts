/**
 * Embodied spatial estimator for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md`
 * sections 10.1, 10.3, 10.5, 10.6, 10.7, 10.14, 10.15, 10.16, and 10.17.
 *
 * This service converts File 09 visual spatial estimates, declared depth,
 * calibration, transform reports, contact evidence, proprioceptive priors, and
 * memory priors into uncertainty-labeled File 10 pose estimates in `W_hat` or
 * object-relative frames. It never queries simulator truth and always routes
 * final pose records through `PoseRepresentationService`.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type {
  Quaternion,
  Ref,
  TimestampInterval,
  Transform,
  ValidationIssue,
  ValidationSeverity,
  Vector3,
} from "../simulation/world_manifest";
import type { CalibrationPromptContext, CalibrationPromptViewContext } from "../perception/calibration_context_assembler";
import type {
  SpatialUncertainty,
  ViewSpatialCue,
  VisualSpatialEstimate,
  VisualSpatialEstimateSet,
} from "../perception/visual_spatial_estimator";
import type { GeometryProvenanceClass } from "./geometry_convention_registry";
import type { TransformResolutionReport } from "./frame_graph_service";
import {
  PoseRepresentationService,
} from "./pose_representation_service";
import type {
  CanonicalPoseEstimate,
  PoseEstimateInput,
  PosePositionUncertaintyInput,
  PoseRepresentationPolicy,
  PoseRepresentationReport,
} from "./pose_representation_service";

export const EMBODIED_SPATIAL_ESTIMATOR_SCHEMA_VERSION = "mebsuta.embodied_spatial_estimator.v1" as const;

const EPSILON = 1e-9;
const IDENTITY_QUATERNION: Quaternion = Object.freeze([0, 0, 0, 1]) as Quaternion;
const HIDDEN_ESTIMATE_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|qa_success|qa_label|qa_only|simulator truth|mesh_name|asset_id|benchmark_truth|oracle_pose)/i;

export type EmbodiedSpatialDecision = "estimated" | "estimated_with_warnings" | "not_ready" | "rejected";
export type EmbodiedSpatialRecommendedAction = "use_pose_estimates" | "use_for_search_only" | "reobserve" | "repair_calibration" | "repair_transform" | "repair_truth_boundary" | "safe_hold" | "human_review";
export type EmbodiedSpatialConsistencyStatus = "consistent" | "weakly_consistent" | "conflicting" | "insufficient";
export type EmbodiedSpatialInputKind = "visual_depth" | "visual_ray" | "contact" | "proprioception" | "memory_prior";
export type EmbodiedSpatialIssueCode =
  | "VisualEstimateSetInvalid"
  | "CalibrationContextInvalid"
  | "TransformReportInvalid"
  | "HiddenSpatialLeak"
  | "NoVisualEstimates"
  | "NoUsableCue"
  | "DepthUnavailable"
  | "CalibrationMissing"
  | "FrameTransformMissing"
  | "InputUncertaintyInvalid"
  | "MemoryConflict"
  | "ContactConflict"
  | "PoseCanonicalizationFailed"
  | "PolicyInvalid";

/**
 * Runtime policy for fusing embodied spatial evidence.
 */
export interface EmbodiedSpatialEstimatorPolicy {
  readonly target_frame_ref?: Ref;
  readonly allow_rgb_only_search_estimates?: boolean;
  readonly require_transform_to_target_frame?: boolean;
  readonly min_visual_confidence?: number;
  readonly min_depth_confidence?: number;
  readonly max_memory_prior_weight?: number;
  readonly max_contact_correction_m?: number;
  readonly conflict_distance_m?: number;
  readonly default_rgb_only_depth_m?: number;
  readonly pose_policy?: PoseRepresentationPolicy;
}

/**
 * Optional contact observation that can anchor or correct a visual estimate
 * when tactile evidence supports the same subject.
 */
export interface EmbodiedContactObservation {
  readonly contact_ref: Ref;
  readonly subject_ref: Ref;
  readonly frame_ref: Ref;
  readonly contact_point_m: Vector3;
  readonly contact_normal?: Vector3;
  readonly timestamp_interval: TimestampInterval;
  readonly confidence: number;
  readonly uncertainty_m: number;
  readonly evidence_refs: readonly Ref[];
}

/**
 * Optional proprioceptive prior for self-state or end-effector spatial
 * estimates.
 */
export interface EmbodiedProprioceptivePrior {
  readonly prior_ref: Ref;
  readonly subject_ref: Ref;
  readonly frame_ref: Ref;
  readonly position_m: Vector3;
  readonly orientation_xyzw?: Quaternion;
  readonly timestamp_interval: TimestampInterval;
  readonly confidence: number;
  readonly uncertainty_m: number;
  readonly evidence_refs: readonly Ref[];
}

/**
 * Staleness-aware spatial memory prior. It can support continuity and search,
 * but never overrides current visual/contact evidence.
 */
export interface EmbodiedSpatialMemoryPrior {
  readonly memory_ref: Ref;
  readonly subject_ref: Ref;
  readonly frame_ref: Ref;
  readonly position_m?: Vector3;
  readonly orientation_xyzw?: Quaternion;
  readonly confidence: number;
  readonly staleness_s: number;
  readonly uncertainty_m: number;
  readonly relation_hint?: string;
  readonly evidence_refs: readonly Ref[];
}

/**
 * One accepted or rejected fusion input.
 */
export interface EmbodiedSpatialFusionInputRecord {
  readonly input_ref: Ref;
  readonly input_kind: EmbodiedSpatialInputKind;
  readonly subject_ref: Ref;
  readonly source_frame_ref: Ref;
  readonly target_frame_ref: Ref;
  readonly accepted: boolean;
  readonly position_m?: Vector3;
  readonly confidence: number;
  readonly uncertainty_m: number;
  readonly rejection_reason?: string;
  readonly evidence_refs: readonly Ref[];
  readonly determinism_hash: string;
}

/**
 * Object-level fusion report matching File 10's estimate-fusion contract.
 */
export interface EmbodiedObjectPoseFusion {
  readonly fusion_ref: Ref;
  readonly subject_ref: Ref;
  readonly input_estimate_refs: readonly Ref[];
  readonly accepted_inputs: readonly EmbodiedSpatialFusionInputRecord[];
  readonly rejected_inputs: readonly EmbodiedSpatialFusionInputRecord[];
  readonly fused_pose_estimate_ref?: Ref;
  readonly canonical_pose?: CanonicalPoseEstimate;
  readonly uncertainty_summary: string;
  readonly consistency_status: EmbodiedSpatialConsistencyStatus;
  readonly recommended_reobserve?: string;
  readonly determinism_hash: string;
}

/**
 * Full estimator input.
 */
export interface EmbodiedSpatialEstimatorInput {
  readonly visual_estimate_set: VisualSpatialEstimateSet;
  readonly calibration_context: CalibrationPromptContext;
  readonly transform_reports?: readonly TransformResolutionReport[];
  readonly contact_observations?: readonly EmbodiedContactObservation[];
  readonly proprioceptive_priors?: readonly EmbodiedProprioceptivePrior[];
  readonly memory_priors?: readonly EmbodiedSpatialMemoryPrior[];
  readonly policy?: EmbodiedSpatialEstimatorPolicy;
}

/**
 * Full File 10 pose-estimate report.
 */
export interface EmbodiedSpatialEstimateReport {
  readonly schema_version: typeof EMBODIED_SPATIAL_ESTIMATOR_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md";
  readonly report_ref: Ref;
  readonly visual_estimate_set_ref: Ref;
  readonly calibration_context_ref: Ref;
  readonly target_frame_ref: Ref;
  readonly fusion_results: readonly EmbodiedObjectPoseFusion[];
  readonly pose_representation_report: PoseRepresentationReport;
  readonly decision: EmbodiedSpatialDecision;
  readonly recommended_action: EmbodiedSpatialRecommendedAction;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
  readonly cognitive_visibility: "spatial_embodied_estimate_report";
}

interface NormalizedPolicy {
  readonly target_frame_ref: Ref;
  readonly allow_rgb_only_search_estimates: boolean;
  readonly require_transform_to_target_frame: boolean;
  readonly min_visual_confidence: number;
  readonly min_depth_confidence: number;
  readonly max_memory_prior_weight: number;
  readonly max_contact_correction_m: number;
  readonly conflict_distance_m: number;
  readonly default_rgb_only_depth_m: number;
  readonly pose_policy: PoseRepresentationPolicy;
}

interface WeightedPoint {
  readonly record: EmbodiedSpatialFusionInputRecord;
  readonly weighted_position_m: Vector3;
  readonly weight: number;
}

const DEFAULT_POLICY: NormalizedPolicy = Object.freeze({
  target_frame_ref: "W_hat",
  allow_rgb_only_search_estimates: true,
  require_transform_to_target_frame: false,
  min_visual_confidence: 0.35,
  min_depth_confidence: 0.45,
  max_memory_prior_weight: 0.25,
  max_contact_correction_m: 0.08,
  conflict_distance_m: 0.18,
  default_rgb_only_depth_m: 1.5,
  pose_policy: Object.freeze({ default_usage: "planning" }),
});

/**
 * Executable File 10 `EmbodiedSpatialEstimator`.
 */
export class EmbodiedSpatialEstimator {
  private readonly policy: NormalizedPolicy;

  public constructor(policy: EmbodiedSpatialEstimatorPolicy = {}) {
    this.policy = mergePolicy(DEFAULT_POLICY, policy);
  }

  /**
   * Estimates object poses from visual evidence, calibration, transform
   * reports, contact evidence, proprioception, and memory priors. The output is
   * deterministic and contains both fusion audit records and canonical pose
   * estimates.
   */
  public estimateObjectPoseFromVisualEvidence(input: EmbodiedSpatialEstimatorInput): EmbodiedSpatialEstimateReport {
    const policy = mergePolicy(this.policy, input.policy ?? {});
    const issues: ValidationIssue[] = [];
    validateInputs(input, policy, issues);

    const fusionResults = input.visual_estimate_set.estimates.map((estimate, index) => fuseEstimate(estimate, index, input, policy, issues));
    const poseInputs = fusionResults
      .map((fusion) => fusionToPoseInput(fusion, input.visual_estimate_set, policy))
      .filter(isPoseEstimateInput);
    const poseReport = new PoseRepresentationService(policy.pose_policy).canonicalizePoseEstimates(poseInputs, policy.pose_policy);
    issues.push(...poseReport.issues.map((issue) => issue.severity === "error"
      ? makeIssue("error", "PoseCanonicalizationFailed", issue.path, issue.message, issue.remediation)
      : makeIssue("warning", "PoseCanonicalizationFailed", issue.path, issue.message, issue.remediation)));

    const fusedWithCanonical = attachCanonicalPoses(fusionResults, poseReport.canonical_poses);
    const decision = decideReport(fusedWithCanonical, poseReport, issues);
    const recommendedAction = chooseRecommendedAction(fusedWithCanonical, issues, decision);
    const reportRef = makeRef("embodied_spatial_estimate_report", input.visual_estimate_set.estimate_set_ref, decision);

    return Object.freeze({
      schema_version: EMBODIED_SPATIAL_ESTIMATOR_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md",
      report_ref: reportRef,
      visual_estimate_set_ref: input.visual_estimate_set.estimate_set_ref,
      calibration_context_ref: input.calibration_context.calibration_context_ref,
      target_frame_ref: policy.target_frame_ref,
      fusion_results: freezeArray(fusedWithCanonical),
      pose_representation_report: poseReport,
      decision,
      recommended_action: recommendedAction,
      issues: freezeArray(issues),
      ok: decision === "estimated" || decision === "estimated_with_warnings",
      determinism_hash: computeDeterminismHash({
        reportRef,
        visualEstimateSet: input.visual_estimate_set.estimate_set_ref,
        targetFrame: policy.target_frame_ref,
        fusions: fusedWithCanonical.map((fusion) => [fusion.fusion_ref, fusion.fused_pose_estimate_ref, fusion.consistency_status]),
        poseReport: poseReport.report_ref,
        decision,
        issueCodes: issues.map((issue) => issue.code).sort(),
      }),
      cognitive_visibility: "spatial_embodied_estimate_report",
    });
  }
}

/**
 * Functional API for File 10 embodied object-pose estimation.
 */
export function estimateObjectPoseFromVisualEvidence(input: EmbodiedSpatialEstimatorInput): EmbodiedSpatialEstimateReport {
  return new EmbodiedSpatialEstimator(input.policy).estimateObjectPoseFromVisualEvidence(input);
}

function fuseEstimate(
  estimate: VisualSpatialEstimate,
  index: number,
  input: EmbodiedSpatialEstimatorInput,
  policy: NormalizedPolicy,
  issues: ValidationIssue[],
): EmbodiedObjectPoseFusion {
  const path = `$.visual_estimate_set.estimates[${index}]`;
  validateNoHiddenText(`${estimate.estimate_ref} ${estimate.consensus_object_ref} ${estimate.label} ${estimate.geometry_handoff_summary}`, path, issues);
  const subjectRef = makeRef("object_pose_subject", estimate.consensus_object_ref);
  const visualRecords = estimate.view_cues.map((cue, cueIndex) => recordFromVisualCue(cue, cueIndex, estimate, input, policy, issues));
  const contactRecords = (input.contact_observations ?? [])
    .filter((contact) => matchesSubject(contact.subject_ref, estimate))
    .map((contact) => recordFromContact(contact, subjectRef, policy, input.transform_reports ?? [], issues));
  const proprioceptiveRecords = (input.proprioceptive_priors ?? [])
    .filter((prior) => matchesSubject(prior.subject_ref, estimate))
    .map((prior) => recordFromProprioception(prior, subjectRef, policy, input.transform_reports ?? [], issues));
  const memoryRecords = (input.memory_priors ?? [])
    .filter((prior) => matchesSubject(prior.subject_ref, estimate))
    .map((prior) => recordFromMemory(prior, subjectRef, policy, input.transform_reports ?? [], issues));
  const records = freezeArray([...visualRecords, ...contactRecords, ...proprioceptiveRecords, ...memoryRecords]);
  const accepted = records.filter((record) => record.accepted);
  const rejected = records.filter((record) => !record.accepted);
  const weighted = accepted.filter(hasPosition).map((record) => weightedPoint(record, policy));
  const fusedPosition = weighted.length === 0 ? undefined : weightedAverage(weighted);
  const consistency = classifyConsistency(weighted, estimate, accepted, rejected, policy, issues, path);
  const fusedPoseRef = fusedPosition === undefined ? undefined : makeRef("embodied_pose_estimate", estimate.consensus_object_ref, policy.target_frame_ref);
  const uncertainty = fusedPosition === undefined
    ? "insufficient metric evidence for pose"
    : summarizeFusionUncertainty(accepted, estimate.uncertainty, consistency);
  const recommendedReobserve = recommendationForFusion(estimate, accepted, rejected, consistency, policy);
  const fusionRef = makeRef("embodied_spatial_fusion", estimate.consensus_object_ref, policy.target_frame_ref, consistency);

  return Object.freeze({
    fusion_ref: fusionRef,
    subject_ref: subjectRef,
    input_estimate_refs: freezeArray(records.map((record) => record.input_ref).sort()),
    accepted_inputs: freezeArray(accepted.sort(compareInputRecords)),
    rejected_inputs: freezeArray(rejected.sort(compareInputRecords)),
    fused_pose_estimate_ref: fusedPoseRef,
    uncertainty_summary: uncertainty,
    consistency_status: consistency,
    recommended_reobserve: recommendedReobserve,
    determinism_hash: computeDeterminismHash({
      fusionRef,
      subjectRef,
      accepted: accepted.map((record) => [record.input_ref, record.confidence, record.uncertainty_m]),
      rejected: rejected.map((record) => [record.input_ref, record.rejection_reason]),
      fusedPosition,
      consistency,
    }),
  });
}

function recordFromVisualCue(
  cue: ViewSpatialCue,
  index: number,
  estimate: VisualSpatialEstimate,
  input: EmbodiedSpatialEstimatorInput,
  policy: NormalizedPolicy,
  issues: ValidationIssue[],
): EmbodiedSpatialFusionInputRecord {
  const subjectRef = makeRef("object_pose_subject", estimate.consensus_object_ref);
  const calibration = input.calibration_context.view_contexts.find((context) => context.canonical_view_name === cue.source_view_name);
  const sourceFrameRef = calibration?.mount_frame_ref ?? makeRef("view_frame", cue.source_view_name);
  const confidence = clamp01(cue.uncertainty.confidence * cue.quality_score);
  let point = cue.agent_frame_point_m ?? cue.camera_frame_point_m;
  let sourceFrame = cue.agent_frame_point_m === undefined ? sourceFrameRef : sourceFrameRef;
  if (point === undefined && cue.depth_m !== undefined) {
    point = scaleVector(cue.normalized_camera_ray, cue.depth_m);
  }
  if (point === undefined && policy.allow_rgb_only_search_estimates && estimate.representative_agent_point_m === undefined) {
    point = scaleVector(cue.agent_frame_ray ?? cue.normalized_camera_ray, policy.default_rgb_only_depth_m);
  }
  if (point === undefined && estimate.representative_agent_point_m !== undefined) {
    point = estimate.representative_agent_point_m;
    sourceFrame = policy.target_frame_ref;
  }

  const transformed = point === undefined
    ? undefined
    : transformPointToTarget(point, sourceFrame, policy.target_frame_ref, input.transform_reports ?? [], policy, issues, `$.view_cues[${index}]`);
  const depthUsable = cue.depth_status === "declared_depth_sample" ? confidence >= policy.min_depth_confidence : policy.allow_rgb_only_search_estimates;
  const accepted = transformed !== undefined && confidence >= policy.min_visual_confidence && depthUsable;
  const rejectionReason = accepted ? undefined : rejectionForVisualCue(cue, confidence, point, transformed, depthUsable, policy);
  return makeInputRecord({
    input_ref: makeRef("visual_spatial_input", estimate.estimate_ref, cue.cue_ref),
    input_kind: cue.depth_status === "declared_depth_sample" ? "visual_depth" : "visual_ray",
    subject_ref: subjectRef,
    source_frame_ref: sourceFrame,
    target_frame_ref: policy.target_frame_ref,
    accepted,
    position_m: transformed,
    confidence,
    uncertainty_m: cueUncertaintyMeters(cue.uncertainty),
    rejection_reason: rejectionReason,
    evidence_refs: [cue.cue_ref, cue.source_camera_packet_ref, estimate.estimate_ref],
  });
}

function recordFromContact(
  contact: EmbodiedContactObservation,
  subjectRef: Ref,
  policy: NormalizedPolicy,
  transforms: readonly TransformResolutionReport[],
  issues: ValidationIssue[],
): EmbodiedSpatialFusionInputRecord {
  validateTimedEvidence(contact.contact_ref, contact.timestamp_interval, contact.confidence, contact.uncertainty_m, "$.contact_observations", issues);
  const position = transformPointToTarget(contact.contact_point_m, contact.frame_ref, policy.target_frame_ref, transforms, policy, issues, "$.contact_observations");
  const accepted = position !== undefined && contact.confidence > 0 && contact.uncertainty_m <= policy.max_contact_correction_m;
  return makeInputRecord({
    input_ref: contact.contact_ref,
    input_kind: "contact",
    subject_ref: subjectRef,
    source_frame_ref: contact.frame_ref,
    target_frame_ref: policy.target_frame_ref,
    accepted,
    position_m: position,
    confidence: contact.confidence,
    uncertainty_m: contact.uncertainty_m,
    rejection_reason: accepted ? undefined : "contact evidence is missing transform, confidence, or has excessive correction uncertainty",
    evidence_refs: contact.evidence_refs,
  });
}

function recordFromProprioception(
  prior: EmbodiedProprioceptivePrior,
  subjectRef: Ref,
  policy: NormalizedPolicy,
  transforms: readonly TransformResolutionReport[],
  issues: ValidationIssue[],
): EmbodiedSpatialFusionInputRecord {
  validateTimedEvidence(prior.prior_ref, prior.timestamp_interval, prior.confidence, prior.uncertainty_m, "$.proprioceptive_priors", issues);
  const position = transformPointToTarget(prior.position_m, prior.frame_ref, policy.target_frame_ref, transforms, policy, issues, "$.proprioceptive_priors");
  const accepted = position !== undefined && prior.confidence > 0;
  return makeInputRecord({
    input_ref: prior.prior_ref,
    input_kind: "proprioception",
    subject_ref: subjectRef,
    source_frame_ref: prior.frame_ref,
    target_frame_ref: policy.target_frame_ref,
    accepted,
    position_m: position,
    confidence: prior.confidence,
    uncertainty_m: prior.uncertainty_m,
    rejection_reason: accepted ? undefined : "proprioceptive prior cannot be transformed into target frame",
    evidence_refs: prior.evidence_refs,
  });
}

function recordFromMemory(
  prior: EmbodiedSpatialMemoryPrior,
  subjectRef: Ref,
  policy: NormalizedPolicy,
  transforms: readonly TransformResolutionReport[],
  issues: ValidationIssue[],
): EmbodiedSpatialFusionInputRecord {
  validateNoHiddenText(`${prior.memory_ref} ${prior.subject_ref} ${prior.relation_hint ?? ""}`, "$.memory_priors", issues);
  const transformed = prior.position_m === undefined
    ? undefined
    : transformPointToTarget(prior.position_m, prior.frame_ref, policy.target_frame_ref, transforms, policy, issues, "$.memory_priors");
  const stalePenalty = prior.staleness_s > 1_800 ? 0.35 : prior.staleness_s > 300 ? 0.65 : 1;
  const confidence = clamp01(prior.confidence * stalePenalty);
  const accepted = transformed !== undefined && confidence > 0.1;
  return makeInputRecord({
    input_ref: prior.memory_ref,
    input_kind: "memory_prior",
    subject_ref: subjectRef,
    source_frame_ref: prior.frame_ref,
    target_frame_ref: policy.target_frame_ref,
    accepted,
    position_m: transformed,
    confidence,
    uncertainty_m: Math.max(prior.uncertainty_m, prior.staleness_s > 1_800 ? 0.25 : prior.uncertainty_m),
    rejection_reason: accepted ? undefined : "memory prior lacks current transformable position or is too stale",
    evidence_refs: prior.evidence_refs,
  });
}

function fusionToPoseInput(
  fusion: EmbodiedObjectPoseFusion,
  visualEstimateSet: VisualSpatialEstimateSet,
  policy: NormalizedPolicy,
): PoseEstimateInput | undefined {
  const acceptedPositions = fusion.accepted_inputs.filter(hasPosition);
  if (fusion.fused_pose_estimate_ref === undefined || acceptedPositions.length === 0) return undefined;
  const position = weightedAverage(acceptedPositions.map((record) => weightedPoint(record, policy)));
  const uncertaintyM = combinedUncertainty(acceptedPositions);
  const interval = timestampFromVisualSet(visualEstimateSet);
  const confidence = fusionConfidence(acceptedPositions, fusion.consistency_status);
  const provenance = provenanceForAcceptedInputs(acceptedPositions);
  const evidenceRefs = uniqueSorted(acceptedPositions.flatMap((record) => record.evidence_refs));
  const positionUncertainty: PosePositionUncertaintyInput = {
    isotropic_sigma_m: uncertaintyM,
    qualitative_class: uncertaintyM <= 0.02 ? "precise" : uncertaintyM <= 0.08 ? "bounded" : "broad",
    dominant_sources: acceptedPositions.map((record) => record.input_kind),
  };
  return Object.freeze({
    pose_ref: fusion.fused_pose_estimate_ref,
    frame_ref: policy.target_frame_ref,
    subject_ref: fusion.subject_ref,
    position_m: position,
    orientation: { kind: "qualitative" as const, relation: "unknown" as const, confidence: Math.min(0.5, confidence) },
    position_uncertainty: positionUncertainty,
    orientation_uncertainty: { ambiguity_class: "qualitative" as const, dominant_sources: ["visual_estimate"] as const },
    timestamp_interval: interval,
    provenance,
    evidence_refs: evidenceRefs,
    confidence,
    staleness_status: fusion.consistency_status === "conflicting" ? "contradicted" : "current",
    usage: "planning",
    summary: fusion.uncertainty_summary,
  });
}

function attachCanonicalPoses(
  fusions: readonly EmbodiedObjectPoseFusion[],
  canonicalPoses: readonly CanonicalPoseEstimate[],
): readonly EmbodiedObjectPoseFusion[] {
  return freezeArray(fusions.map((fusion) => {
    const canonical = canonicalPoses.find((pose) => pose.pose_ref === fusion.fused_pose_estimate_ref);
    return Object.freeze({
      ...fusion,
      canonical_pose: canonical,
    });
  }));
}

function transformPointToTarget(
  point: Vector3,
  sourceFrameRef: Ref,
  targetFrameRef: Ref,
  transforms: readonly TransformResolutionReport[],
  policy: NormalizedPolicy,
  issues: ValidationIssue[],
  path: string,
): Vector3 | undefined {
  if (sourceFrameRef === targetFrameRef) return freezeVector3(point);
  const report = transforms.find((item) => item.ok && item.source_frame_ref === sourceFrameRef && item.target_frame_ref === targetFrameRef)
    ?? transforms.find((item) => item.ok && item.target_frame_ref === targetFrameRef);
  if (report === undefined) {
    if (policy.require_transform_to_target_frame) {
      issues.push(makeIssue("error", "FrameTransformMissing", path, `No transform report maps ${sourceFrameRef} into ${targetFrameRef}.`, "Resolve transform before embodied spatial estimation."));
    } else {
      issues.push(makeIssue("warning", "FrameTransformMissing", path, `No transform report maps ${sourceFrameRef} into ${targetFrameRef}; preserving local estimate as target-frame approximate.`, "Attach a transform report for metric target-frame use."));
      return freezeVector3(point);
    }
    return undefined;
  }
  validateTransformReport(report, path, issues);
  if (!report.ok) return undefined;
  return transformPoint(report.transform_target_from_source, point);
}

function validateInputs(input: EmbodiedSpatialEstimatorInput, policy: NormalizedPolicy, issues: ValidationIssue[]): void {
  validateNoHiddenText(`${input.visual_estimate_set.estimate_set_ref} ${input.calibration_context.calibration_context_ref}`, "$.inputs", issues);
  if (!input.visual_estimate_set.ok) {
    issues.push(makeIssue("warning", "VisualEstimateSetInvalid", "$.visual_estimate_set.ok", "Visual spatial estimate set has warnings or is not fully OK.", "Use the report only for search or reobserve when visual readiness is weak."));
  }
  if (!input.calibration_context.ok) {
    issues.push(makeIssue("error", "CalibrationContextInvalid", "$.calibration_context.ok", "Calibration context is not valid for metric spatial estimation.", "Repair declared calibration before geometry conversion."));
  }
  if (input.visual_estimate_set.estimates.length === 0) {
    issues.push(makeIssue("error", "NoVisualEstimates", "$.visual_estimate_set.estimates", "Embodied spatial estimation requires at least one visual spatial estimate.", "Run visual spatial estimation before File 10 pose estimation."));
  }
  if (input.visual_estimate_set.calibration_context_ref !== input.calibration_context.calibration_context_ref) {
    issues.push(makeIssue("warning", "CalibrationContextInvalid", "$.calibration_context.calibration_context_ref", "Visual estimate set references a different calibration context.", "Use the calibration context that produced the visual spatial estimate set."));
  }
  if (policy.target_frame_ref.trim().length === 0 || HIDDEN_ESTIMATE_PATTERN.test(policy.target_frame_ref)) {
    issues.push(makeIssue("error", "PolicyInvalid", "$.policy.target_frame_ref", "Target frame ref must be safe and non-empty.", "Use W_hat or a declared object-relative target frame."));
  }
  for (const report of input.transform_reports ?? []) validateTransformReport(report, "$.transform_reports", issues);
}

function validateTransformReport(report: TransformResolutionReport, path: string, issues: ValidationIssue[]): void {
  if (!report.ok || report.decision === "rejected" || report.decision === "not_resolved") {
    issues.push(makeIssue("error", "TransformReportInvalid", `${path}.${report.resolution_ref}`, "Transform report is not resolved.", "Repair frame graph resolution before spatial estimation."));
  }
  if (report.provenance_chain.some((item) => item === "simulator_truth" || item === "qa_truth")) {
    issues.push(makeIssue("error", "TransformReportInvalid", `${path}.${report.resolution_ref}.provenance_chain`, "Transform report includes simulator or QA truth provenance.", "Use W_hat and sensor-derived transforms only."));
  }
}

function validateTimedEvidence(
  ref: Ref,
  interval: TimestampInterval,
  confidence: number,
  uncertaintyM: number,
  path: string,
  issues: ValidationIssue[],
): void {
  validateNoHiddenText(ref, path, issues);
  if (!Number.isFinite(interval.start_s) || !Number.isFinite(interval.end_s) || interval.end_s < interval.start_s) {
    issues.push(makeIssue("error", "VisualEstimateSetInvalid", `${path}.${ref}.timestamp_interval`, "Evidence timestamp interval must be finite and ordered.", "Use start_s <= end_s in seconds."));
  }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    issues.push(makeIssue("error", "InputUncertaintyInvalid", `${path}.${ref}.confidence`, "Evidence confidence must be in [0, 1].", "Use normalized confidence."));
  }
  if (!Number.isFinite(uncertaintyM) || uncertaintyM < 0) {
    issues.push(makeIssue("error", "InputUncertaintyInvalid", `${path}.${ref}.uncertainty_m`, "Evidence uncertainty must be finite and nonnegative.", "Use meters."));
  }
}

function classifyConsistency(
  points: readonly WeightedPoint[],
  estimate: VisualSpatialEstimate,
  accepted: readonly EmbodiedSpatialFusionInputRecord[],
  rejected: readonly EmbodiedSpatialFusionInputRecord[],
  policy: NormalizedPolicy,
  issues: ValidationIssue[],
  path: string,
): EmbodiedSpatialConsistencyStatus {
  if (points.length === 0) return "insufficient";
  const fused = weightedAverage(points);
  const maxResidual = Math.max(...points.map((point) => distance(point.record.position_m ?? fused, fused)));
  const hasDepthOrContact = accepted.some((record) => record.input_kind === "visual_depth" || record.input_kind === "contact" || record.input_kind === "proprioception");
  if (maxResidual > policy.conflict_distance_m) {
    issues.push(makeIssue("warning", "MemoryConflict", path, `Spatial evidence for ${estimate.label} diverges by ${formatNumber(maxResidual)} m.`, "Reobserve or prefer current visual/contact evidence over stale priors."));
    return "conflicting";
  }
  if (points.length === 1 || !hasDepthOrContact || rejected.length > accepted.length) return "weakly_consistent";
  return "consistent";
}

function recommendationForFusion(
  estimate: VisualSpatialEstimate,
  accepted: readonly EmbodiedSpatialFusionInputRecord[],
  rejected: readonly EmbodiedSpatialFusionInputRecord[],
  consistency: EmbodiedSpatialConsistencyStatus,
  policy: NormalizedPolicy,
): string | undefined {
  if (consistency === "insufficient") return `${estimate.label}: reobserve with calibration, depth, or transformable visual cues.`;
  if (consistency === "conflicting") return `${estimate.label}: recapture synchronized views and ignore stale priors until current evidence agrees.`;
  if (policy.require_transform_to_target_frame && accepted.some((record) => record.source_frame_ref !== policy.target_frame_ref)) return `${estimate.label}: resolve transform into ${policy.target_frame_ref}.`;
  if (rejected.some((record) => record.input_kind === "visual_ray" || record.input_kind === "visual_depth")) return `${estimate.label}: add depth or a second synchronized view to reduce visual uncertainty.`;
  return undefined;
}

function rejectionForVisualCue(
  cue: ViewSpatialCue,
  confidence: number,
  rawPoint: Vector3 | undefined,
  transformed: Vector3 | undefined,
  depthUsable: boolean,
  policy: NormalizedPolicy,
): string {
  if (rawPoint === undefined) return "visual cue lacks metric point and RGB-only fallback is disabled";
  if (transformed === undefined) return "visual cue cannot be transformed into target frame";
  if (confidence < policy.min_visual_confidence) return `visual confidence ${formatNumber(confidence)} below threshold ${formatNumber(policy.min_visual_confidence)}`;
  if (!depthUsable && cue.depth_status !== "declared_depth_sample") return "declared depth is unavailable for metric estimate";
  return "visual cue rejected by spatial estimate policy";
}

function makeInputRecord(input: Omit<EmbodiedSpatialFusionInputRecord, "determinism_hash">): EmbodiedSpatialFusionInputRecord {
  return Object.freeze({
    ...input,
    input_ref: sanitizeRef(input.input_ref),
    subject_ref: sanitizeRef(input.subject_ref),
    source_frame_ref: sanitizeRef(input.source_frame_ref),
    target_frame_ref: sanitizeRef(input.target_frame_ref),
    position_m: input.position_m === undefined ? undefined : freezeVector3(input.position_m),
    confidence: roundScore(input.confidence),
    uncertainty_m: round6(input.uncertainty_m),
    evidence_refs: freezeArray(input.evidence_refs.map(sanitizeRef).sort()),
    determinism_hash: computeDeterminismHash({
      inputRef: input.input_ref,
      kind: input.input_kind,
      subject: input.subject_ref,
      accepted: input.accepted,
      position: input.position_m,
      confidence: input.confidence,
      uncertainty: input.uncertainty_m,
      rejected: input.rejection_reason,
    }),
  });
}

function weightedPoint(record: EmbodiedSpatialFusionInputRecord, policy: NormalizedPolicy): WeightedPoint {
  const base = record.input_kind === "memory_prior"
    ? Math.min(policy.max_memory_prior_weight, record.confidence)
    : record.confidence;
  const uncertaintyPenalty = 1 / Math.max(record.uncertainty_m, 0.01);
  const weight = Math.max(EPSILON, base * uncertaintyPenalty);
  return Object.freeze({
    record,
    weighted_position_m: scaleVector(record.position_m ?? [0, 0, 0], weight),
    weight,
  });
}

function weightedAverage(points: readonly WeightedPoint[]): Vector3 {
  const totalWeight = points.reduce((sum, point) => sum + point.weight, 0);
  if (totalWeight <= EPSILON) return freezeVector3([0, 0, 0]);
  const summed = points.reduce<Vector3>((sum, point) => addVectors(sum, point.weighted_position_m), freezeVector3([0, 0, 0]));
  return scaleVector(summed, 1 / totalWeight);
}

function combinedUncertainty(records: readonly EmbodiedSpatialFusionInputRecord[]): number {
  if (records.length === 0) return 1;
  const inverseVariance = records.reduce((sum, record) => sum + 1 / Math.max(record.uncertainty_m * record.uncertainty_m, 0.0001), 0);
  const fusedSigma = Math.sqrt(1 / Math.max(inverseVariance, EPSILON));
  const conflictSpread = Math.max(0, ...records.filter(hasPosition).map((record, _, all) => distance(record.position_m, centroid(all.map((item) => item.position_m)))));
  return round6(Math.max(fusedSigma, conflictSpread * 0.5));
}

function centroid(points: readonly Vector3[]): Vector3 {
  if (points.length === 0) return freezeVector3([0, 0, 0]);
  return scaleVector(points.reduce<Vector3>((sum, point) => addVectors(sum, point), freezeVector3([0, 0, 0])), 1 / points.length);
}

function fusionConfidence(records: readonly EmbodiedSpatialFusionInputRecord[], consistency: EmbodiedSpatialConsistencyStatus): number {
  if (records.length === 0) return 0;
  const support = 1 - Math.exp(-records.length / 2);
  const average = records.reduce((sum, record) => sum + record.confidence, 0) / records.length;
  const consistencyScale = consistency === "consistent" ? 1 : consistency === "weakly_consistent" ? 0.75 : consistency === "conflicting" ? 0.35 : 0.2;
  return roundScore(average * support * consistencyScale);
}

function provenanceForAcceptedInputs(records: readonly EmbodiedSpatialFusionInputRecord[]): GeometryProvenanceClass {
  if (records.some((record) => record.input_kind === "contact")) return "contact_estimate";
  if (records.some((record) => record.input_kind === "proprioception")) return "proprioceptive_estimate";
  if (records.some((record) => record.input_kind === "visual_depth" || record.input_kind === "visual_ray")) return "visual_estimate";
  return "memory_prior";
}

function timestampFromVisualSet(set: VisualSpatialEstimateSet): TimestampInterval {
  return Object.freeze({
    start_s: 0,
    end_s: Math.max(0, set.estimates.length),
  });
}

function summarizeFusionUncertainty(
  accepted: readonly EmbodiedSpatialFusionInputRecord[],
  visualUncertainty: SpatialUncertainty,
  consistency: EmbodiedSpatialConsistencyStatus,
): string {
  const kinds = uniqueSorted(accepted.map((record) => record.input_kind));
  return `consistency=${consistency}; accepted=${accepted.length}; inputs=${kinds.join(",") || "none"}; fused_sigma_m=${formatNumber(combinedUncertainty(accepted))}; visual_basis=${visualUncertainty.basis.join(",") || "unspecified"}.`;
}

function cueUncertaintyMeters(uncertainty: SpatialUncertainty): number {
  return round6(Math.max(
    uncertainty.depth_sigma_m ?? 0,
    uncertainty.lateral_sigma_m ?? 0,
    uncertainty.angular_sigma_rad,
    uncertainty.pixel_sigma_px / 1000,
    0.02,
  ));
}

function transformPoint(transform: Transform, point: Vector3): Vector3 {
  const rotated = rotateVector(transform.orientation_xyzw, point);
  return freezeVector3([
    rotated[0] + transform.position_m[0],
    rotated[1] + transform.position_m[1],
    rotated[2] + transform.position_m[2],
  ]);
}

function rotateVector(orientation: Quaternion, vector: Vector3): Vector3 {
  const q = normalizeQuaternion(orientation);
  const v = freezeQuaternion([vector[0], vector[1], vector[2], 0]);
  const rotated = quaternionMultiply(quaternionMultiply(q, v), quaternionConjugate(q));
  return freezeVector3([rotated[0], rotated[1], rotated[2]]);
}

function quaternionMultiply(a: Quaternion, b: Quaternion): Quaternion {
  const ax = a[0];
  const ay = a[1];
  const az = a[2];
  const aw = a[3];
  const bx = b[0];
  const by = b[1];
  const bz = b[2];
  const bw = b[3];
  return freezeQuaternion([
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]);
}

function quaternionConjugate(value: Quaternion): Quaternion {
  return freezeQuaternion([-value[0], -value[1], -value[2], value[3]]);
}

function normalizeQuaternion(value: Quaternion): Quaternion {
  const length = Math.hypot(value[0], value[1], value[2], value[3]);
  if (length < EPSILON) return IDENTITY_QUATERNION;
  return freezeQuaternion([value[0] / length, value[1] / length, value[2] / length, value[3] / length]);
}

function decideReport(
  fusions: readonly EmbodiedObjectPoseFusion[],
  poseReport: PoseRepresentationReport,
  issues: readonly ValidationIssue[],
): EmbodiedSpatialDecision {
  if (issues.some((issue) => issue.code === "PolicyInvalid" || issue.code === "CalibrationContextInvalid" || issue.code === "HiddenSpatialLeak")) return "rejected";
  if (poseReport.canonical_poses.length === 0 || fusions.every((fusion) => fusion.consistency_status === "insufficient")) return "not_ready";
  if (issues.some((issue) => issue.severity === "error") || fusions.some((fusion) => fusion.consistency_status === "conflicting")) return "not_ready";
  return issues.length > 0 || fusions.some((fusion) => fusion.consistency_status === "weakly_consistent") ? "estimated_with_warnings" : "estimated";
}

function chooseRecommendedAction(
  fusions: readonly EmbodiedObjectPoseFusion[],
  issues: readonly ValidationIssue[],
  decision: EmbodiedSpatialDecision,
): EmbodiedSpatialRecommendedAction {
  if (decision === "estimated" && fusions.every((fusion) => fusion.canonical_pose?.confidence_class !== "search_only")) return "use_pose_estimates";
  if (issues.some((issue) => issue.code === "HiddenSpatialLeak")) return "repair_truth_boundary";
  if (issues.some((issue) => issue.code === "CalibrationContextInvalid" || issue.code === "CalibrationMissing")) return "repair_calibration";
  if (issues.some((issue) => issue.code === "TransformReportInvalid" || issue.code === "FrameTransformMissing")) return "repair_transform";
  if (fusions.some((fusion) => fusion.recommended_reobserve !== undefined || fusion.consistency_status === "insufficient" || fusion.consistency_status === "conflicting")) return "reobserve";
  if (fusions.some((fusion) => fusion.canonical_pose?.confidence_class === "search_only")) return "use_for_search_only";
  return decision === "rejected" ? "safe_hold" : "human_review";
}

function matchesSubject(subjectRef: Ref, estimate: VisualSpatialEstimate): boolean {
  const normalized = makeRef(subjectRef);
  return normalized === makeRef(estimate.consensus_object_ref)
    || normalized === makeRef("object_pose_subject", estimate.consensus_object_ref)
    || normalized === makeRef(estimate.label);
}

function hasPosition(record: EmbodiedSpatialFusionInputRecord): record is EmbodiedSpatialFusionInputRecord & { readonly position_m: Vector3 } {
  return record.position_m !== undefined;
}

function isPoseEstimateInput(value: PoseEstimateInput | undefined): value is PoseEstimateInput {
  return value !== undefined;
}

function compareInputRecords(a: EmbodiedSpatialFusionInputRecord, b: EmbodiedSpatialFusionInputRecord): number {
  return Number(b.accepted) - Number(a.accepted)
    || a.input_kind.localeCompare(b.input_kind)
    || a.input_ref.localeCompare(b.input_ref);
}

function validateNoHiddenText(value: string, path: string, issues: ValidationIssue[]): void {
  if (HIDDEN_ESTIMATE_PATTERN.test(value)) {
    issues.push(makeIssue("error", "HiddenSpatialLeak", path, "Spatial estimator input contains hidden simulator/backend/QA wording.", "Use sensor-derived refs, declared calibration, and W_hat estimates only."));
  }
}

function distance(a: Vector3, b: Vector3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function addVectors(a: Vector3, b: Vector3): Vector3 {
  return freezeVector3([a[0] + b[0], a[1] + b[1], a[2] + b[2]]);
}

function scaleVector(vector: Vector3, scale: number): Vector3 {
  return freezeVector3([vector[0] * scale, vector[1] * scale, vector[2] * scale]);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function roundScore(value: number): number {
  return Math.round(clamp01(value) * 1000) / 1000;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "") : "invalid";
}

function sanitizeRef(value: Ref): Ref {
  return makeRef(value);
}

function freezeVector3(value: readonly number[]): Vector3 {
  return Object.freeze([round6(value[0]), round6(value[1]), round6(value[2])]) as Vector3;
}

function freezeQuaternion(value: readonly number[]): Quaternion {
  return Object.freeze([round6(value[0]), round6(value[1]), round6(value[2]), round6(value[3])]) as Quaternion;
}

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return freezeArray([...new Set(values)].sort());
}

function mergePolicy(base: NormalizedPolicy, override: EmbodiedSpatialEstimatorPolicy): NormalizedPolicy {
  return Object.freeze({
    target_frame_ref: override.target_frame_ref ?? base.target_frame_ref,
    allow_rgb_only_search_estimates: override.allow_rgb_only_search_estimates ?? base.allow_rgb_only_search_estimates,
    require_transform_to_target_frame: override.require_transform_to_target_frame ?? base.require_transform_to_target_frame,
    min_visual_confidence: clamp01(override.min_visual_confidence ?? base.min_visual_confidence),
    min_depth_confidence: clamp01(override.min_depth_confidence ?? base.min_depth_confidence),
    max_memory_prior_weight: clamp01(override.max_memory_prior_weight ?? base.max_memory_prior_weight),
    max_contact_correction_m: positiveOrDefault(override.max_contact_correction_m, base.max_contact_correction_m),
    conflict_distance_m: positiveOrDefault(override.conflict_distance_m, base.conflict_distance_m),
    default_rgb_only_depth_m: positiveOrDefault(override.default_rgb_only_depth_m, base.default_rgb_only_depth_m),
    pose_policy: Object.freeze({ ...base.pose_policy, ...(override.pose_policy ?? {}) }),
  });
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function makeIssue(
  severity: ValidationSeverity,
  code: EmbodiedSpatialIssueCode,
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
