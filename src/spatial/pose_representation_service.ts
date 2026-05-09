/**
 * Pose representation service for Project Mebsuta spatial geometry.
 *
 * Blueprint: `architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md`
 * sections 10.1, 10.3, 10.4, 10.5, 10.6, 10.8, 10.14, 10.16, and 10.17.
 *
 * This service owns the executable File 10 `PoseEstimate` contract. It
 * canonicalizes position, quaternion, rotation-matrix, axis-angle, qualitative
 * orientation, covariance, uncertainty, timestamp, provenance, confidence, and
 * staleness fields before downstream spatial estimation, target-frame,
 * residual, memory, verification, or control services consume poses.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type {
  Quaternion,
  Ref,
  TimestampInterval,
  ValidationIssue,
  ValidationSeverity,
  Vector3,
} from "../simulation/world_manifest";
import type { GeometryProvenanceClass, GeometryToleranceClass } from "./geometry_convention_registry";
import type { TransformResolutionReport } from "./frame_graph_service";
import type { PoseEstimateConfidenceClass, PoseStalenessStatus } from "./truth_estimate_boundary";

export const POSE_REPRESENTATION_SERVICE_SCHEMA_VERSION = "mebsuta.pose_representation_service.v1" as const;

const EPSILON = 1e-9;
const UNIT_TOLERANCE = 1e-6;
const MATRIX_TOLERANCE = 1e-5;
const HIDDEN_POSE_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|qa_success|qa_label|qa_only|simulator truth|mesh_name|asset_id|benchmark_truth|oracle_pose)/i;
const IDENTITY_QUATERNION: Quaternion = Object.freeze([0, 0, 0, 1]) as Quaternion;
const ZERO_VECTOR: Vector3 = Object.freeze([0, 0, 0]) as Vector3;

export type Matrix3 = readonly [Vector3, Vector3, Vector3];
export type PoseDecision = "canonicalized" | "canonicalized_with_warnings" | "not_ready" | "rejected";
export type PoseRecommendedAction = "use_pose" | "use_for_search_only" | "reobserve" | "repair_orientation" | "repair_uncertainty" | "repair_timestamp" | "repair_truth_boundary" | "safe_hold";
export type OrientationRepresentationKind = "quaternion_xyzw" | "rotation_matrix" | "axis_angle" | "qualitative";
export type PoseUsage = "cognition" | "planning" | "control" | "verification" | "memory" | "audit" | "qa";
export type PoseUncertaintyClass = "precise" | "bounded" | "broad" | "qualitative" | "unknown";
export type QualitativeOrientationRelation = "upright" | "inverted" | "sideways" | "facing_subject" | "aligned_to_axis" | "unknown";
export type PoseIssueCode =
  | "PoseRefInvalid"
  | "FrameRefInvalid"
  | "SubjectRefInvalid"
  | "TruthFrameBlocked"
  | "TruthProvenanceBlocked"
  | "PositionInvalid"
  | "OrientationInvalid"
  | "OrientationMatrixInvalid"
  | "OrientationMissing"
  | "PositionUncertaintyInvalid"
  | "OrientationUncertaintyInvalid"
  | "TimestampInvalid"
  | "ConfidenceInvalid"
  | "StalePose"
  | "EvidenceMissing"
  | "TransformReportInvalid"
  | "HiddenPoseLeak"
  | "NoPoseEstimates"
  | "PolicyInvalid";

/**
 * File 10 orientation input. Exact orientations may arrive as unit
 * quaternions, rotation matrices, or axis-angle. Qualitative relations are
 * allowed only when the caller declares that exact orientation is visually
 * ambiguous and no controller-ready orientation is being requested.
 */
export type PoseOrientationInput =
  | { readonly kind: "quaternion_xyzw"; readonly quaternion_xyzw: Quaternion }
  | { readonly kind: "rotation_matrix"; readonly rotation_matrix: Matrix3 }
  | { readonly kind: "axis_angle"; readonly axis: Vector3; readonly angle_rad: number }
  | { readonly kind: "qualitative"; readonly relation: QualitativeOrientationRelation; readonly reference_frame_ref?: Ref; readonly confidence: number };

/**
 * Position uncertainty may be represented as a covariance matrix, an isotropic
 * standard deviation, a tolerance class, or a qualitative label. Numeric
 * values are canonicalized into meters and covariance diagonals are validated.
 */
export interface PosePositionUncertaintyInput {
  readonly covariance_3x3_m2?: Matrix3;
  readonly isotropic_sigma_m?: number;
  readonly tolerance_class?: GeometryToleranceClass;
  readonly qualitative_class?: PoseUncertaintyClass;
  readonly dominant_sources?: readonly string[];
}

/**
 * Orientation uncertainty mirrors position uncertainty in radians and supports
 * angular covariance for control and residual math.
 */
export interface PoseOrientationUncertaintyInput {
  readonly covariance_3x3_rad2?: Matrix3;
  readonly angular_sigma_rad?: number;
  readonly ambiguity_class?: PoseUncertaintyClass;
  readonly dominant_sources?: readonly string[];
}

/**
 * File 10 pose estimate input. Every agent-facing estimate must carry frame,
 * subject, provenance, timestamp, confidence, and uncertainty; exact simulator
 * truth is rejected unless the usage is explicitly QA or audit.
 */
export interface PoseEstimateInput {
  readonly pose_ref: Ref;
  readonly frame_ref: Ref;
  readonly subject_ref: Ref;
  readonly position_m?: Vector3;
  readonly orientation?: PoseOrientationInput;
  readonly position_uncertainty: PosePositionUncertaintyInput;
  readonly orientation_uncertainty?: PoseOrientationUncertaintyInput;
  readonly timestamp_interval: TimestampInterval;
  readonly provenance: GeometryProvenanceClass;
  readonly evidence_refs: readonly Ref[];
  readonly transform_report?: TransformResolutionReport;
  readonly confidence: number;
  readonly staleness_status?: PoseStalenessStatus;
  readonly usage?: PoseUsage;
  readonly summary?: string;
}

/**
 * Runtime policy controlling pose canonicalization gates.
 */
export interface PoseRepresentationPolicy {
  readonly default_usage?: PoseUsage;
  readonly require_position_for_control?: boolean;
  readonly require_orientation_for_control?: boolean;
  readonly allow_qualitative_orientation_for_control?: boolean;
  readonly allow_truth_for_qa_or_audit?: boolean;
  readonly require_transform_report_ok?: boolean;
  readonly max_current_age_s?: number;
  readonly max_recent_age_s?: number;
  readonly max_control_position_sigma_m?: number;
  readonly max_control_orientation_sigma_rad?: number;
  readonly max_single_evidence_control_confidence?: number;
  readonly max_memory_confidence?: number;
}

/**
 * Canonical orientation with quaternion storage and optional explanation fields
 * retained for Gemini-facing or audit-visible payloads.
 */
export interface CanonicalPoseOrientation {
  readonly representation: OrientationRepresentationKind;
  readonly quaternion_xyzw?: Quaternion;
  readonly rotation_matrix?: Matrix3;
  readonly axis_angle?: { readonly axis: Vector3; readonly angle_rad: number };
  readonly qualitative_relation?: QualitativeOrientationRelation;
  readonly reference_frame_ref?: Ref;
  readonly normalized: boolean;
  readonly exact_orientation_available: boolean;
  readonly determinism_hash: string;
}

/**
 * Canonical uncertainty summary used by validators, memory, and control
 * handoff logic.
 */
export interface CanonicalPoseUncertainty {
  readonly position_covariance_3x3_m2?: Matrix3;
  readonly position_sigma_m?: number;
  readonly position_uncertainty_class: PoseUncertaintyClass;
  readonly orientation_covariance_3x3_rad2?: Matrix3;
  readonly orientation_sigma_rad?: number;
  readonly orientation_uncertainty_class?: PoseUncertaintyClass;
  readonly dominant_sources: readonly string[];
  readonly uncertainty_summary: string;
  readonly determinism_hash: string;
}

/**
 * Canonical File 10 pose estimate.
 */
export interface CanonicalPoseEstimate {
  readonly schema_version: typeof POSE_REPRESENTATION_SERVICE_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md";
  readonly pose_ref: Ref;
  readonly frame_ref: Ref;
  readonly subject_ref: Ref;
  readonly position_m?: Vector3;
  readonly orientation?: CanonicalPoseOrientation;
  readonly uncertainty: CanonicalPoseUncertainty;
  readonly timestamp_interval: TimestampInterval;
  readonly provenance: GeometryProvenanceClass;
  readonly evidence_refs: readonly Ref[];
  readonly transform_report_ref?: Ref;
  readonly confidence: number;
  readonly confidence_class: PoseEstimateConfidenceClass;
  readonly staleness_status: PoseStalenessStatus;
  readonly usage: PoseUsage;
  readonly control_ready: boolean;
  readonly verification_ready: boolean;
  readonly memory_write_ready: boolean;
  readonly notes: readonly string[];
  readonly determinism_hash: string;
  readonly cognitive_visibility: "spatial_pose_estimate";
}

/**
 * Batch canonicalization report.
 */
export interface PoseRepresentationReport {
  readonly schema_version: typeof POSE_REPRESENTATION_SERVICE_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md";
  readonly report_ref: Ref;
  readonly pose_count: number;
  readonly canonical_poses: readonly CanonicalPoseEstimate[];
  readonly rejected_pose_refs: readonly Ref[];
  readonly decision: PoseDecision;
  readonly recommended_action: PoseRecommendedAction;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
  readonly cognitive_visibility: "spatial_pose_representation_report";
}

/**
 * Pose residual request used by later residual and control bridge services.
 */
export interface PoseResidualRequest {
  readonly current_pose: CanonicalPoseEstimate;
  readonly target_pose: CanonicalPoseEstimate;
  readonly position_weight?: number;
  readonly orientation_weight?: number;
}

/**
 * File 10 position/orientation pose-error result.
 */
export interface PoseResidual {
  readonly residual_ref: Ref;
  readonly current_pose_ref: Ref;
  readonly target_pose_ref: Ref;
  readonly position_error_m?: Vector3;
  readonly position_error_norm_m?: number;
  readonly orientation_error_vector_rad?: Vector3;
  readonly orientation_error_angle_rad?: number;
  readonly weighted_pose_error?: readonly number[];
  readonly uncertainty_gate: "passed" | "ambiguous" | "failed";
  readonly notes: readonly string[];
  readonly determinism_hash: string;
}

interface NormalizedPoseRepresentationPolicy {
  readonly default_usage: PoseUsage;
  readonly require_position_for_control: boolean;
  readonly require_orientation_for_control: boolean;
  readonly allow_qualitative_orientation_for_control: boolean;
  readonly allow_truth_for_qa_or_audit: boolean;
  readonly require_transform_report_ok: boolean;
  readonly max_current_age_s: number;
  readonly max_recent_age_s: number;
  readonly max_control_position_sigma_m: number;
  readonly max_control_orientation_sigma_rad: number;
  readonly max_single_evidence_control_confidence: number;
  readonly max_memory_confidence: number;
}

const DEFAULT_POLICY: NormalizedPoseRepresentationPolicy = Object.freeze({
  default_usage: "planning",
  require_position_for_control: true,
  require_orientation_for_control: true,
  allow_qualitative_orientation_for_control: false,
  allow_truth_for_qa_or_audit: true,
  require_transform_report_ok: true,
  max_current_age_s: 0.5,
  max_recent_age_s: 5,
  max_control_position_sigma_m: 0.035,
  max_control_orientation_sigma_rad: 0.12,
  max_single_evidence_control_confidence: 0.62,
  max_memory_confidence: 0.45,
});

/**
 * Executable File 10 `PoseRepresentationService`.
 */
export class PoseRepresentationService {
  private readonly policy: NormalizedPoseRepresentationPolicy;

  public constructor(policy: PoseRepresentationPolicy = {}) {
    this.policy = mergePolicy(DEFAULT_POLICY, policy);
  }

  /**
   * Canonicalizes one or more File 10 pose estimates and emits deterministic
   * issue, readiness, confidence, and staleness metadata.
   */
  public canonicalizePoseEstimates(
    estimates: readonly PoseEstimateInput[],
    policy: PoseRepresentationPolicy = {},
  ): PoseRepresentationReport {
    const activePolicy = mergePolicy(this.policy, policy);
    const issues: ValidationIssue[] = [];
    validatePolicy(activePolicy, issues);
    if (estimates.length === 0) {
      issues.push(makeIssue("error", "NoPoseEstimates", "$.pose_estimates", "PoseRepresentationService requires at least one pose estimate.", "Provide pose estimates from perception, calibration, proprioception, contact, task, or memory."));
    }

    const canonical = estimates
      .map((estimate, index) => canonicalizeOne(estimate, index, activePolicy, issues))
      .filter(isCanonicalPoseEstimate);
    const rejected = estimates
      .filter((estimate) => !canonical.some((pose) => pose.pose_ref === estimate.pose_ref))
      .map((estimate) => sanitizeRef(estimate.pose_ref || "pose_ref_missing"))
      .sort();
    const decision = decideReport(canonical, rejected, issues);
    const recommendedAction = chooseRecommendedAction(canonical, issues, decision);
    const reportRef = makeRef("pose_representation_report", estimates.map((estimate) => estimate.pose_ref).join(":"), decision);

    return Object.freeze({
      schema_version: POSE_REPRESENTATION_SERVICE_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md",
      report_ref: reportRef,
      pose_count: estimates.length,
      canonical_poses: freezeArray(canonical),
      rejected_pose_refs: freezeArray(rejected),
      decision,
      recommended_action: recommendedAction,
      issues: freezeArray(issues),
      ok: decision === "canonicalized" || decision === "canonicalized_with_warnings",
      determinism_hash: computeDeterminismHash({
        reportRef,
        poses: canonical.map((pose) => [pose.pose_ref, pose.confidence_class, pose.staleness_status]),
        rejected,
        issueCodes: issues.map((issue) => issue.code).sort(),
        decision,
      }),
      cognitive_visibility: "spatial_pose_representation_report",
    });
  }

  /**
   * Computes File 10 position and orientation residuals between canonical poses.
   * The orientation error uses the vector part of the relative quaternion,
   * scaled by the signed shortest angular displacement.
   */
  public computePoseResidual(request: PoseResidualRequest): PoseResidual {
    const notes: string[] = [];
    const positionWeight = positiveOrDefault(request.position_weight, 1);
    const orientationWeight = positiveOrDefault(request.orientation_weight, 1);
    const positionError = request.current_pose.position_m !== undefined && request.target_pose.position_m !== undefined
      ? subtractVectors(request.target_pose.position_m, request.current_pose.position_m)
      : undefined;
    if (positionError === undefined) notes.push("position_error=unavailable");

    const orientationResidual = request.current_pose.orientation?.quaternion_xyzw !== undefined && request.target_pose.orientation?.quaternion_xyzw !== undefined
      ? quaternionOrientationError(request.current_pose.orientation.quaternion_xyzw, request.target_pose.orientation.quaternion_xyzw)
      : undefined;
    if (orientationResidual === undefined) notes.push("orientation_error=unavailable");

    const weighted = [
      ...(positionError === undefined ? [] : positionError.map((value) => round6(value * positionWeight))),
      ...(orientationResidual === undefined ? [] : orientationResidual.error_vector_rad.map((value) => round6(value * orientationWeight))),
    ];
    const uncertaintyGate = classifyResidualUncertainty(request.current_pose, request.target_pose, notes);
    const residualRef = makeRef("pose_residual", request.current_pose.pose_ref, request.target_pose.pose_ref);

    return Object.freeze({
      residual_ref: residualRef,
      current_pose_ref: request.current_pose.pose_ref,
      target_pose_ref: request.target_pose.pose_ref,
      position_error_m: positionError,
      position_error_norm_m: positionError === undefined ? undefined : round6(vectorNorm(positionError)),
      orientation_error_vector_rad: orientationResidual?.error_vector_rad,
      orientation_error_angle_rad: orientationResidual?.angle_rad,
      weighted_pose_error: weighted.length === 0 ? undefined : freezeArray(weighted),
      uncertainty_gate: uncertaintyGate,
      notes: freezeArray(notes),
      determinism_hash: computeDeterminismHash({
        residualRef,
        current: request.current_pose.pose_ref,
        target: request.target_pose.pose_ref,
        positionError,
        orientationResidual,
        uncertaintyGate,
      }),
    });
  }
}

/**
 * Functional API for File 10 pose canonicalization.
 */
export function canonicalizePoseEstimates(
  estimates: readonly PoseEstimateInput[],
  policy: PoseRepresentationPolicy = {},
): PoseRepresentationReport {
  return new PoseRepresentationService(policy).canonicalizePoseEstimates(estimates, policy);
}

/**
 * Functional API for File 10 pose residual computation.
 */
export function computePoseResidual(request: PoseResidualRequest): PoseResidual {
  return new PoseRepresentationService().computePoseResidual(request);
}

function canonicalizeOne(
  estimate: PoseEstimateInput,
  index: number,
  policy: NormalizedPoseRepresentationPolicy,
  issues: ValidationIssue[],
): CanonicalPoseEstimate | undefined {
  const basePath = `$.pose_estimates[${index}]`;
  const localIssues: ValidationIssue[] = [];
  const usage = estimate.usage ?? policy.default_usage;
  validateSafeRef(estimate.pose_ref, `${basePath}.pose_ref`, "PoseRefInvalid", localIssues);
  validateSafeRef(estimate.frame_ref, `${basePath}.frame_ref`, "FrameRefInvalid", localIssues);
  validateSafeRef(estimate.subject_ref, `${basePath}.subject_ref`, "SubjectRefInvalid", localIssues);
  validateNoHiddenText(`${estimate.pose_ref} ${estimate.frame_ref} ${estimate.subject_ref} ${estimate.summary ?? ""}`, basePath, localIssues);
  validatePosition(estimate.position_m, `${basePath}.position_m`, localIssues);
  validateTimestamp(estimate.timestamp_interval, `${basePath}.timestamp_interval`, localIssues);
  validateConfidence(estimate.confidence, `${basePath}.confidence`, localIssues);
  validateEvidence(estimate.evidence_refs, `${basePath}.evidence_refs`, localIssues);
  validateTruthBoundary(estimate, usage, policy, basePath, localIssues);
  validateTransformReport(estimate, policy, basePath, localIssues);

  const orientation = canonicalizeOrientation(estimate.orientation, usage, `${basePath}.orientation`, localIssues);
  validateUsageCompleteness(estimate, orientation, usage, policy, basePath, localIssues);
  const uncertainty = canonicalizeUncertainty(estimate, orientation, `${basePath}.uncertainty`, localIssues);
  const staleness = estimate.staleness_status ?? inferStaleness(estimate.timestamp_interval, policy);
  if (staleness === "stale" || staleness === "contradicted") {
    localIssues.push(makeIssue(staleness === "contradicted" ? "error" : "warning", "StalePose", `${basePath}.staleness_status`, "Pose estimate is stale or contradicted.", "Reobserve before using the pose as current geometry."));
  }

  issues.push(...localIssues);
  if (localIssues.some((issue) => issue.severity === "error")) return undefined;

  const boundedConfidence = boundConfidence(estimate, uncertainty, staleness, usage, policy, issues, basePath);
  const confidenceClass = classifyConfidence(boundedConfidence, uncertainty, staleness, usage);
  const controlReady = isControlReady(estimate, orientation, uncertainty, staleness, confidenceClass, usage, policy);
  const verificationReady = isVerificationReady(estimate, uncertainty, staleness, confidenceClass);
  const memoryWriteReady = boundedConfidence >= 0.5 && staleness !== "contradicted" && estimate.provenance !== "simulator_truth" && estimate.provenance !== "qa_truth";
  const notes = buildPoseNotes(estimate, uncertainty, staleness, confidenceClass, usage, controlReady, verificationReady);
  const poseRef = sanitizeRef(estimate.pose_ref);
  const canonical = {
    schema_version: POSE_REPRESENTATION_SERVICE_SCHEMA_VERSION,
    blueprint_ref: "architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md" as const,
    pose_ref: poseRef,
    frame_ref: sanitizeRef(estimate.frame_ref),
    subject_ref: sanitizeRef(estimate.subject_ref),
    position_m: estimate.position_m === undefined ? undefined : freezeVector3(estimate.position_m),
    orientation,
    uncertainty,
    timestamp_interval: freezeTimestamp(estimate.timestamp_interval),
    provenance: estimate.provenance,
    evidence_refs: freezeArray([...estimate.evidence_refs].map(sanitizeRef).sort()),
    transform_report_ref: estimate.transform_report?.resolution_ref,
    confidence: boundedConfidence,
    confidence_class: confidenceClass,
    staleness_status: staleness,
    usage,
    control_ready: controlReady,
    verification_ready: verificationReady,
    memory_write_ready: memoryWriteReady,
    notes: freezeArray(notes),
    cognitive_visibility: "spatial_pose_estimate" as const,
  };

  return Object.freeze({
    ...canonical,
    determinism_hash: computeDeterminismHash({
      pose: canonical.pose_ref,
      frame: canonical.frame_ref,
      subject: canonical.subject_ref,
      position: canonical.position_m,
      orientation: canonical.orientation,
      uncertainty: canonical.uncertainty,
      confidence: canonical.confidence,
      staleness: canonical.staleness_status,
      usage,
    }),
  });
}

function canonicalizeOrientation(
  input: PoseOrientationInput | undefined,
  usage: PoseUsage,
  path: string,
  issues: ValidationIssue[],
): CanonicalPoseOrientation | undefined {
  if (input === undefined) return undefined;
  if (input.kind === "qualitative") {
    validateConfidence(input.confidence, `${path}.confidence`, issues);
    validateNoHiddenText(`${input.relation} ${input.reference_frame_ref ?? ""}`, path, issues);
    const qualitative = Object.freeze({
      representation: "qualitative" as const,
      qualitative_relation: input.relation,
      reference_frame_ref: input.reference_frame_ref === undefined ? undefined : sanitizeRef(input.reference_frame_ref),
      normalized: true,
      exact_orientation_available: false,
      determinism_hash: "",
    });
    return Object.freeze({
      ...qualitative,
      determinism_hash: computeDeterminismHash(qualitative),
    });
  }

  const quaternion = orientationToQuaternion(input, path, issues);
  if (quaternion === undefined) return undefined;
  const matrix = quaternionToMatrix(quaternion);
  const axisAngle = quaternionToAxisAngle(quaternion);
  const base = {
    representation: input.kind,
    quaternion_xyzw: quaternion,
    rotation_matrix: matrix,
    axis_angle: axisAngle,
    normalized: true,
    exact_orientation_available: true,
  };
  if (usage === "cognition" && input.kind === "rotation_matrix") {
    issues.push(makeIssue("warning", "OrientationInvalid", path, "Rotation matrix was normalized into a quaternion for cognitive-safe pose storage.", "Store unit quaternion plus uncertainty for downstream pose consumers."));
  }
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function orientationToQuaternion(input: Exclude<PoseOrientationInput, { readonly kind: "qualitative" }>, path: string, issues: ValidationIssue[]): Quaternion | undefined {
  if (input.kind === "quaternion_xyzw") {
    return normalizeQuaternionWithIssue(input.quaternion_xyzw, path, issues);
  }
  if (input.kind === "axis_angle") {
    validateVector3(input.axis, `${path}.axis`, "OrientationInvalid", issues);
    if (!Number.isFinite(input.angle_rad)) {
      issues.push(makeIssue("error", "OrientationInvalid", `${path}.angle_rad`, "Axis-angle orientation requires a finite radian angle.", "Use finite radians."));
      return undefined;
    }
    const axisNorm = vectorNorm(input.axis);
    if (axisNorm < EPSILON) {
      issues.push(makeIssue("error", "OrientationInvalid", `${path}.axis`, "Axis-angle orientation requires a nonzero axis.", "Use a unit axis or provide a quaternion."));
      return undefined;
    }
    const half = input.angle_rad / 2;
    const scale = Math.sin(half) / axisNorm;
    return canonicalQuaternion([input.axis[0] * scale, input.axis[1] * scale, input.axis[2] * scale, Math.cos(half)]);
  }
  validateMatrix3(input.rotation_matrix, `${path}.rotation_matrix`, issues);
  if (issues.some((issue) => issue.path.startsWith(`${path}.rotation_matrix`) && issue.severity === "error")) return undefined;
  return matrixToQuaternion(input.rotation_matrix);
}

function canonicalizeUncertainty(
  estimate: PoseEstimateInput,
  orientation: CanonicalPoseOrientation | undefined,
  path: string,
  issues: ValidationIssue[],
): CanonicalPoseUncertainty {
  const positionCovariance = estimate.position_uncertainty.covariance_3x3_m2;
  if (positionCovariance !== undefined) validateCovariance(positionCovariance, `${path}.position_covariance_3x3_m2`, "PositionUncertaintyInvalid", issues);
  const positionSigma = derivePositionSigma(estimate.position_uncertainty, issues, path);
  const positionClass = estimate.position_uncertainty.qualitative_class ?? classifyUncertainty(positionSigma, estimate.position_uncertainty.tolerance_class);

  const orientationCovariance = estimate.orientation_uncertainty?.covariance_3x3_rad2;
  if (orientationCovariance !== undefined) validateCovariance(orientationCovariance, `${path}.orientation_covariance_3x3_rad2`, "OrientationUncertaintyInvalid", issues);
  const orientationSigma = deriveOrientationSigma(estimate.orientation_uncertainty, issues, path);
  if (orientation !== undefined && estimate.orientation_uncertainty === undefined && orientation.exact_orientation_available) {
    issues.push(makeIssue("error", "OrientationUncertaintyInvalid", `${path}.orientation_uncertainty`, "Exact orientation requires angular uncertainty or ambiguity metadata.", "Attach orientation uncertainty in radians or an ambiguity class."));
  }
  const orientationClass = estimate.orientation_uncertainty?.ambiguity_class ?? (orientation === undefined ? undefined : classifyUncertainty(orientationSigma, undefined));
  const dominantSources = uniqueSorted([
    ...(estimate.position_uncertainty.dominant_sources ?? []),
    ...(estimate.orientation_uncertainty?.dominant_sources ?? []),
  ].map((source) => sanitizeText(source)).filter((source) => source.length > 0));
  const shell = {
    positionCovariance,
    positionSigma,
    positionClass,
    orientationCovariance,
    orientationSigma,
    orientationClass,
    dominantSources,
  };

  return Object.freeze({
    position_covariance_3x3_m2: positionCovariance === undefined ? undefined : freezeMatrix3(positionCovariance),
    position_sigma_m: positionSigma,
    position_uncertainty_class: positionClass,
    orientation_covariance_3x3_rad2: orientationCovariance === undefined ? undefined : freezeMatrix3(orientationCovariance),
    orientation_sigma_rad: orientationSigma,
    orientation_uncertainty_class: orientationClass,
    dominant_sources: freezeArray(dominantSources),
    uncertainty_summary: summarizeUncertainty(positionSigma, positionClass, orientationSigma, orientationClass),
    determinism_hash: computeDeterminismHash(shell),
  });
}

function derivePositionSigma(input: PosePositionUncertaintyInput, issues: ValidationIssue[], path: string): number | undefined {
  if (input.isotropic_sigma_m !== undefined) {
    if (!Number.isFinite(input.isotropic_sigma_m) || input.isotropic_sigma_m < 0) {
      issues.push(makeIssue("error", "PositionUncertaintyInvalid", `${path}.position_uncertainty.isotropic_sigma_m`, "Position sigma must be finite and nonnegative.", "Use a nonnegative meter standard deviation."));
      return undefined;
    }
    return round6(input.isotropic_sigma_m);
  }
  if (input.covariance_3x3_m2 !== undefined) {
    const variance = Math.max(input.covariance_3x3_m2[0][0], input.covariance_3x3_m2[1][1], input.covariance_3x3_m2[2][2], 0);
    return round6(Math.sqrt(variance));
  }
  if (input.tolerance_class !== undefined || input.qualitative_class !== undefined) return undefined;
  issues.push(makeIssue("error", "PositionUncertaintyInvalid", `${path}.position_uncertainty`, "Position uncertainty is required as covariance, sigma, tolerance class, or qualitative class.", "Attach uncertainty before pose use."));
  return undefined;
}

function deriveOrientationSigma(input: PoseOrientationUncertaintyInput | undefined, issues: ValidationIssue[], path: string): number | undefined {
  if (input === undefined) return undefined;
  if (input.angular_sigma_rad !== undefined) {
    if (!Number.isFinite(input.angular_sigma_rad) || input.angular_sigma_rad < 0) {
      issues.push(makeIssue("error", "OrientationUncertaintyInvalid", `${path}.orientation_uncertainty.angular_sigma_rad`, "Orientation sigma must be finite and nonnegative.", "Use a nonnegative radian standard deviation."));
      return undefined;
    }
    return round6(input.angular_sigma_rad);
  }
  if (input.covariance_3x3_rad2 !== undefined) {
    const variance = Math.max(input.covariance_3x3_rad2[0][0], input.covariance_3x3_rad2[1][1], input.covariance_3x3_rad2[2][2], 0);
    return round6(Math.sqrt(variance));
  }
  if (input.ambiguity_class !== undefined) return undefined;
  issues.push(makeIssue("error", "OrientationUncertaintyInvalid", `${path}.orientation_uncertainty`, "Orientation uncertainty requires covariance, angular sigma, or ambiguity class.", "Attach angular uncertainty or declare qualitative ambiguity."));
  return undefined;
}

function validateUsageCompleteness(
  estimate: PoseEstimateInput,
  orientation: CanonicalPoseOrientation | undefined,
  usage: PoseUsage,
  policy: NormalizedPoseRepresentationPolicy,
  path: string,
  issues: ValidationIssue[],
): void {
  if (usage === "control" && policy.require_position_for_control && estimate.position_m === undefined) {
    issues.push(makeIssue("error", "PositionInvalid", `${path}.position_m`, "Control-facing pose requires a 3D position.", "Attach position in meters before control handoff."));
  }
  if (usage === "control" && policy.require_orientation_for_control && orientation === undefined) {
    issues.push(makeIssue("error", "OrientationMissing", `${path}.orientation`, "Control-facing pose requires orientation.", "Attach a unit quaternion, rotation matrix, or axis-angle orientation."));
  }
  if (usage === "control" && orientation?.representation === "qualitative" && !policy.allow_qualitative_orientation_for_control) {
    issues.push(makeIssue("error", "OrientationInvalid", `${path}.orientation`, "Qualitative orientation cannot be used for control.", "Reobserve or estimate exact orientation before IK or PD handoff."));
  }
}

function validateTruthBoundary(
  estimate: PoseEstimateInput,
  usage: PoseUsage,
  policy: NormalizedPoseRepresentationPolicy,
  path: string,
  issues: ValidationIssue[],
): void {
  const truthAllowed = policy.allow_truth_for_qa_or_audit && (usage === "qa" || usage === "audit");
  if (!truthAllowed && isTruthFrameRef(estimate.frame_ref)) {
    issues.push(makeIssue("error", "TruthFrameBlocked", `${path}.frame_ref`, "Pose references simulator or QA truth frame.", "Represent agent-facing geometry in W_hat or a declared estimate frame."));
  }
  if (!truthAllowed && (estimate.provenance === "simulator_truth" || estimate.provenance === "qa_truth")) {
    issues.push(makeIssue("error", "TruthProvenanceBlocked", `${path}.provenance`, "Pose uses simulator or QA truth provenance outside QA/audit usage.", "Use sensor, calibration, proprioception, contact, task, validator, or memory provenance."));
  }
}

function validateTransformReport(
  estimate: PoseEstimateInput,
  policy: NormalizedPoseRepresentationPolicy,
  path: string,
  issues: ValidationIssue[],
): void {
  if (estimate.transform_report === undefined) return;
  if (policy.require_transform_report_ok && !estimate.transform_report.ok) {
    issues.push(makeIssue("error", "TransformReportInvalid", `${path}.transform_report`, "Pose references an unresolved transform report.", "Repair frame graph or transform resolution before pose canonicalization."));
  }
  if (estimate.transform_report.target_frame_ref !== estimate.frame_ref && estimate.transform_report.source_frame_ref !== estimate.frame_ref) {
    issues.push(makeIssue("warning", "TransformReportInvalid", `${path}.transform_report.frame_ref`, "Transform report does not directly reference the pose frame.", "Attach the transform report that maps this pose into its declared frame."));
  }
}

function boundConfidence(
  estimate: PoseEstimateInput,
  uncertainty: CanonicalPoseUncertainty,
  staleness: PoseStalenessStatus,
  usage: PoseUsage,
  policy: NormalizedPoseRepresentationPolicy,
  issues: ValidationIssue[],
  path: string,
): number {
  const caps = [1];
  if (usage === "control" && estimate.evidence_refs.length <= 1) {
    caps.push(policy.max_single_evidence_control_confidence);
    issues.push(makeIssue("warning", "EvidenceMissing", `${path}.evidence_refs`, "Single-evidence pose confidence was capped for control use.", "Add synchronized view, depth, contact, or proprioceptive evidence before precise control."));
  }
  if (estimate.provenance === "memory_prior") caps.push(policy.max_memory_confidence);
  if (staleness === "stale") caps.push(0.34);
  if (staleness === "contradicted") caps.push(0.1);
  if ((uncertainty.position_sigma_m ?? 0) > 0.1 || (uncertainty.orientation_sigma_rad ?? 0) > 0.35) caps.push(0.5);
  if ((uncertainty.position_sigma_m ?? 0) > 0.25 || (uncertainty.orientation_sigma_rad ?? 0) > 0.8) caps.push(0.35);
  return roundScore(Math.min(clamp01(estimate.confidence), ...caps));
}

function classifyConfidence(
  confidence: number,
  uncertainty: CanonicalPoseUncertainty,
  staleness: PoseStalenessStatus,
  usage: PoseUsage,
): PoseEstimateConfidenceClass {
  if (confidence < 0.2 || staleness === "contradicted") return "unusable";
  if (staleness === "stale" || confidence < 0.42 || uncertainty.position_uncertainty_class === "unknown") return "search_only";
  if (usage === "control" && confidence >= 0.74 && (uncertainty.position_sigma_m ?? Number.POSITIVE_INFINITY) <= 0.035) return "control_candidate";
  if (usage === "verification" && confidence >= 0.68) return "verification_candidate";
  if ((usage === "memory" || usage === "verification") && confidence >= 0.82 && staleness === "current") return "certified_current";
  return "planning_candidate";
}

function isControlReady(
  estimate: PoseEstimateInput,
  orientation: CanonicalPoseOrientation | undefined,
  uncertainty: CanonicalPoseUncertainty,
  staleness: PoseStalenessStatus,
  confidenceClass: PoseEstimateConfidenceClass,
  usage: PoseUsage,
  policy: NormalizedPoseRepresentationPolicy,
): boolean {
  return usage === "control"
    && estimate.position_m !== undefined
    && orientation?.exact_orientation_available === true
    && staleness === "current"
    && confidenceClass === "control_candidate"
    && (uncertainty.position_sigma_m ?? Number.POSITIVE_INFINITY) <= policy.max_control_position_sigma_m
    && (uncertainty.orientation_sigma_rad ?? Number.POSITIVE_INFINITY) <= policy.max_control_orientation_sigma_rad;
}

function isVerificationReady(
  estimate: PoseEstimateInput,
  uncertainty: CanonicalPoseUncertainty,
  staleness: PoseStalenessStatus,
  confidenceClass: PoseEstimateConfidenceClass,
): boolean {
  return estimate.position_m !== undefined
    && staleness !== "contradicted"
    && confidenceClass !== "unusable"
    && uncertainty.position_uncertainty_class !== "unknown";
}

function classifyResidualUncertainty(current: CanonicalPoseEstimate, target: CanonicalPoseEstimate, notes: string[]): PoseResidual["uncertainty_gate"] {
  const currentSigma = current.uncertainty.position_sigma_m ?? 0;
  const targetSigma = target.uncertainty.position_sigma_m ?? 0;
  const combined = Math.hypot(currentSigma, targetSigma);
  if (current.staleness_status === "contradicted" || target.staleness_status === "contradicted") {
    notes.push("uncertainty_gate=failed_contradicted_pose");
    return "failed";
  }
  if (current.staleness_status === "stale" || target.staleness_status === "stale" || combined > 0.1) {
    notes.push(`uncertainty_gate=ambiguous_combined_sigma_m=${formatNumber(combined)}`);
    return "ambiguous";
  }
  notes.push(`uncertainty_gate=passed_combined_sigma_m=${formatNumber(combined)}`);
  return "passed";
}

function inferStaleness(interval: TimestampInterval, policy: NormalizedPoseRepresentationPolicy): PoseStalenessStatus {
  const age = Math.max(0, interval.end_s - interval.start_s);
  if (age <= policy.max_current_age_s) return "current";
  if (age <= policy.max_recent_age_s) return "recent";
  return "stale";
}

function buildPoseNotes(
  estimate: PoseEstimateInput,
  uncertainty: CanonicalPoseUncertainty,
  staleness: PoseStalenessStatus,
  confidenceClass: PoseEstimateConfidenceClass,
  usage: PoseUsage,
  controlReady: boolean,
  verificationReady: boolean,
): readonly string[] {
  return freezeArray([
    `usage=${usage}`,
    `provenance=${estimate.provenance}`,
    `staleness=${staleness}`,
    `confidence_class=${confidenceClass}`,
    `position_uncertainty=${uncertainty.position_uncertainty_class}`,
    uncertainty.position_sigma_m === undefined ? "position_sigma_m=not_numeric" : `position_sigma_m=${formatNumber(uncertainty.position_sigma_m)}`,
    uncertainty.orientation_sigma_rad === undefined ? "orientation_sigma_rad=not_numeric" : `orientation_sigma_rad=${formatNumber(uncertainty.orientation_sigma_rad)}`,
    `control_ready=${controlReady}`,
    `verification_ready=${verificationReady}`,
  ]);
}

function decideReport(
  canonical: readonly CanonicalPoseEstimate[],
  rejected: readonly Ref[],
  issues: readonly ValidationIssue[],
): PoseDecision {
  if (issues.some((issue) => issue.code === "NoPoseEstimates" || issue.code === "PolicyInvalid")) return "rejected";
  if (canonical.length === 0 && rejected.length > 0) return "rejected";
  if (rejected.length > 0 || issues.some((issue) => issue.severity === "error")) return "not_ready";
  return issues.length > 0 ? "canonicalized_with_warnings" : "canonicalized";
}

function chooseRecommendedAction(
  canonical: readonly CanonicalPoseEstimate[],
  issues: readonly ValidationIssue[],
  decision: PoseDecision,
): PoseRecommendedAction {
  if (decision === "canonicalized" && canonical.every((pose) => pose.confidence_class !== "search_only")) return "use_pose";
  if (issues.some((issue) => issue.code === "TruthFrameBlocked" || issue.code === "TruthProvenanceBlocked" || issue.code === "HiddenPoseLeak")) return "repair_truth_boundary";
  if (issues.some((issue) => issue.code === "OrientationInvalid" || issue.code === "OrientationMatrixInvalid" || issue.code === "OrientationMissing")) return "repair_orientation";
  if (issues.some((issue) => issue.code === "PositionUncertaintyInvalid" || issue.code === "OrientationUncertaintyInvalid" || issue.code === "ConfidenceInvalid")) return "repair_uncertainty";
  if (issues.some((issue) => issue.code === "TimestampInvalid" || issue.code === "StalePose")) return "reobserve";
  if (canonical.some((pose) => pose.confidence_class === "search_only")) return "use_for_search_only";
  return "safe_hold";
}

function validatePolicy(policy: NormalizedPoseRepresentationPolicy, issues: ValidationIssue[]): void {
  if (policy.max_current_age_s < 0 || policy.max_recent_age_s < policy.max_current_age_s) {
    issues.push(makeIssue("error", "PolicyInvalid", "$.policy", "Staleness thresholds must satisfy 0 <= current <= recent.", "Use ordered positive second thresholds."));
  }
  for (const [path, value] of [
    ["$.policy.max_control_position_sigma_m", policy.max_control_position_sigma_m],
    ["$.policy.max_control_orientation_sigma_rad", policy.max_control_orientation_sigma_rad],
    ["$.policy.max_single_evidence_control_confidence", policy.max_single_evidence_control_confidence],
    ["$.policy.max_memory_confidence", policy.max_memory_confidence],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      issues.push(makeIssue("error", "PolicyInvalid", path, "Pose policy numeric thresholds must be finite and nonnegative.", "Use finite nonnegative thresholds and confidence caps."));
    }
  }
}

function validateSafeRef(value: Ref, path: string, code: PoseIssueCode, issues: ValidationIssue[]): void {
  if (value.trim().length === 0 || /\s/u.test(value)) {
    issues.push(makeIssue("error", code, path, "Reference must be non-empty and whitespace-free.", "Use an opaque sanitized ref."));
    return;
  }
  validateNoHiddenText(value, path, issues);
}

function validateNoHiddenText(value: string, path: string, issues: ValidationIssue[]): void {
  if (HIDDEN_POSE_PATTERN.test(value)) {
    issues.push(makeIssue("error", "HiddenPoseLeak", path, "Pose metadata contains hidden simulator/backend/QA wording.", "Strip hidden identifiers before pose canonicalization."));
  }
}

function validatePosition(value: Vector3 | undefined, path: string, issues: ValidationIssue[]): void {
  if (value === undefined) return;
  validateVector3(value, path, "PositionInvalid", issues);
}

function validateVector3(value: Vector3, path: string, code: PoseIssueCode, issues: ValidationIssue[]): void {
  if (!Array.isArray(value) || value.length !== 3 || value.some((component) => !Number.isFinite(component))) {
    issues.push(makeIssue("error", code, path, "Vector3 must contain exactly three finite values.", "Use [x, y, z] with canonical File 10 units."));
  }
}

function validateTimestamp(interval: TimestampInterval, path: string, issues: ValidationIssue[]): void {
  if (!Number.isFinite(interval.start_s) || !Number.isFinite(interval.end_s) || interval.start_s < 0 || interval.end_s < interval.start_s) {
    issues.push(makeIssue("error", "TimestampInvalid", path, "Timestamp interval must be finite, nonnegative, and ordered.", "Use start_s >= 0 and end_s >= start_s."));
  }
}

function validateConfidence(value: number, path: string, issues: ValidationIssue[]): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    issues.push(makeIssue("error", "ConfidenceInvalid", path, "Confidence must be finite in [0, 1].", "Use normalized confidence."));
  }
}

function validateEvidence(value: readonly Ref[], path: string, issues: ValidationIssue[]): void {
  if (value.length === 0) {
    issues.push(makeIssue("error", "EvidenceMissing", path, "Pose estimate must include supporting evidence refs.", "Attach view, depth, contact, proprioception, task, or memory evidence."));
  }
  for (const [index, ref] of value.entries()) {
    validateSafeRef(ref, `${path}[${index}]`, "EvidenceMissing", issues);
  }
}

function validateMatrix3(value: Matrix3, path: string, issues: ValidationIssue[]): void {
  for (let row = 0; row < 3; row += 1) validateVector3(value[row], `${path}[${row}]`, "OrientationMatrixInvalid", issues);
  const rowsFinite = value.every((row) => row.every(Number.isFinite));
  if (!rowsFinite) return;
  const rowNorms = value.map(vectorNorm);
  const dot01 = dot(value[0], value[1]);
  const dot02 = dot(value[0], value[2]);
  const dot12 = dot(value[1], value[2]);
  const det = determinant3(value);
  const orthonormal = rowNorms.every((norm) => Math.abs(norm - 1) <= MATRIX_TOLERANCE)
    && Math.abs(dot01) <= MATRIX_TOLERANCE
    && Math.abs(dot02) <= MATRIX_TOLERANCE
    && Math.abs(dot12) <= MATRIX_TOLERANCE;
  if (!orthonormal || Math.abs(det - 1) > MATRIX_TOLERANCE) {
    issues.push(makeIssue("error", "OrientationMatrixInvalid", path, "Rotation matrix must be orthonormal with determinant +1.", "Re-orthonormalize the rotation or provide a unit quaternion."));
  }
}

function validateCovariance(value: Matrix3, path: string, code: PoseIssueCode, issues: ValidationIssue[]): void {
  for (let row = 0; row < 3; row += 1) validateVector3(value[row], `${path}[${row}]`, code, issues);
  if (!value.every((row) => row.every(Number.isFinite))) return;
  const symmetryError = Math.max(
    Math.abs(value[0][1] - value[1][0]),
    Math.abs(value[0][2] - value[2][0]),
    Math.abs(value[1][2] - value[2][1]),
  );
  const principalMinors = [
    value[0][0],
    value[1][1],
    value[2][2],
    value[0][0] * value[1][1] - value[0][1] * value[1][0],
    value[0][0] * value[2][2] - value[0][2] * value[2][0],
    value[1][1] * value[2][2] - value[1][2] * value[2][1],
    determinant3(value),
  ];
  if (symmetryError > MATRIX_TOLERANCE || principalMinors.some((minor) => minor < -MATRIX_TOLERANCE)) {
    issues.push(makeIssue("error", code, path, "Covariance must be symmetric positive semidefinite.", "Use a valid 3x3 covariance in squared canonical units."));
  }
}

function normalizeQuaternionWithIssue(value: Quaternion, path: string, issues: ValidationIssue[]): Quaternion | undefined {
  if (!Array.isArray(value) || value.length !== 4 || value.some((component) => !Number.isFinite(component))) {
    issues.push(makeIssue("error", "OrientationInvalid", path, "Quaternion must contain exactly four finite values.", "Use [x, y, z, w]."));
    return undefined;
  }
  const length = Math.hypot(value[0], value[1], value[2], value[3]);
  if (length < EPSILON) {
    issues.push(makeIssue("error", "OrientationInvalid", path, "Quaternion length must be nonzero.", "Use a normalized unit quaternion."));
    return undefined;
  }
  if (Math.abs(length - 1) > UNIT_TOLERANCE) {
    issues.push(makeIssue("warning", "OrientationInvalid", path, "Quaternion was normalized to unit length.", "Store unit quaternions to avoid downstream residual drift."));
  }
  return canonicalQuaternion([value[0] / length, value[1] / length, value[2] / length, value[3] / length]);
}

function matrixToQuaternion(matrix: Matrix3): Quaternion {
  const m00 = matrix[0][0];
  const m01 = matrix[0][1];
  const m02 = matrix[0][2];
  const m10 = matrix[1][0];
  const m11 = matrix[1][1];
  const m12 = matrix[1][2];
  const m20 = matrix[2][0];
  const m21 = matrix[2][1];
  const m22 = matrix[2][2];
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return canonicalQuaternion([(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s]);
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return canonicalQuaternion([0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]);
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return canonicalQuaternion([(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]);
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return canonicalQuaternion([(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]);
}

function quaternionToMatrix(quaternion: Quaternion): Matrix3 {
  const q = canonicalQuaternion(quaternion);
  const x = q[0];
  const y = q[1];
  const z = q[2];
  const w = q[3];
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  return freezeMatrix3([
    [1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy)],
    [2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx)],
    [2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)],
  ]);
}

function quaternionToAxisAngle(quaternion: Quaternion): { readonly axis: Vector3; readonly angle_rad: number } {
  const q = canonicalQuaternion(quaternion);
  const angle = 2 * Math.acos(clamp(q[3], -1, 1));
  const s = Math.sqrt(Math.max(0, 1 - q[3] * q[3]));
  const axis = s < EPSILON ? freezeVector3([1, 0, 0]) : freezeVector3([q[0] / s, q[1] / s, q[2] / s]);
  return Object.freeze({ axis, angle_rad: round6(angle) });
}

function quaternionOrientationError(current: Quaternion, target: Quaternion): { readonly error_vector_rad: Vector3; readonly angle_rad: number } {
  const relative = canonicalQuaternion(quaternionMultiply(target, quaternionConjugate(current)));
  const angle = 2 * Math.atan2(vectorNorm([relative[0], relative[1], relative[2]]), Math.abs(relative[3]));
  const sign = relative[3] < 0 ? -1 : 1;
  const vectorNormPart = Math.hypot(relative[0], relative[1], relative[2]);
  const axis = vectorNormPart < EPSILON ? ZERO_VECTOR : freezeVector3([relative[0] / vectorNormPart, relative[1] / vectorNormPart, relative[2] / vectorNormPart]);
  return Object.freeze({
    error_vector_rad: freezeVector3([axis[0] * angle * sign, axis[1] * angle * sign, axis[2] * angle * sign]),
    angle_rad: round6(angle),
  });
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
  return canonicalQuaternion([
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]);
}

function quaternionConjugate(value: Quaternion): Quaternion {
  return freezeQuaternion([-value[0], -value[1], -value[2], value[3]]);
}

function canonicalQuaternion(value: readonly number[]): Quaternion {
  const length = Math.hypot(value[0], value[1], value[2], value[3]);
  if (length < EPSILON) return IDENTITY_QUATERNION;
  const sign = value[3] < 0 ? -1 : 1;
  return freezeQuaternion([sign * value[0] / length, sign * value[1] / length, sign * value[2] / length, sign * value[3] / length]);
}

function classifyUncertainty(sigma: number | undefined, toleranceClass: GeometryToleranceClass | undefined): PoseUncertaintyClass {
  if (sigma === undefined) return toleranceClass === undefined ? "unknown" : "qualitative";
  if (sigma <= 0.02) return "precise";
  if (sigma <= 0.08) return "bounded";
  return "broad";
}

function summarizeUncertainty(
  positionSigma: number | undefined,
  positionClass: PoseUncertaintyClass,
  orientationSigma: number | undefined,
  orientationClass: PoseUncertaintyClass | undefined,
): string {
  const position = positionSigma === undefined ? positionClass : `${positionClass}: position sigma ${formatNumber(positionSigma)} m`;
  const orientation = orientationClass === undefined
    ? "orientation not supplied"
    : orientationSigma === undefined ? orientationClass : `${orientationClass}: orientation sigma ${formatNumber(orientationSigma)} rad`;
  return `${position}; ${orientation}.`;
}

function isTruthFrameRef(frameRef: Ref): boolean {
  return frameRef === "W" || frameRef.startsWith("Q_") || /(^|:)qa_truth(:|$)/iu.test(frameRef);
}

function isCanonicalPoseEstimate(value: CanonicalPoseEstimate | undefined): value is CanonicalPoseEstimate {
  return value !== undefined;
}

function mergePolicy(base: NormalizedPoseRepresentationPolicy, override: PoseRepresentationPolicy): NormalizedPoseRepresentationPolicy {
  return Object.freeze({
    default_usage: override.default_usage ?? base.default_usage,
    require_position_for_control: override.require_position_for_control ?? base.require_position_for_control,
    require_orientation_for_control: override.require_orientation_for_control ?? base.require_orientation_for_control,
    allow_qualitative_orientation_for_control: override.allow_qualitative_orientation_for_control ?? base.allow_qualitative_orientation_for_control,
    allow_truth_for_qa_or_audit: override.allow_truth_for_qa_or_audit ?? base.allow_truth_for_qa_or_audit,
    require_transform_report_ok: override.require_transform_report_ok ?? base.require_transform_report_ok,
    max_current_age_s: positiveOrDefault(override.max_current_age_s, base.max_current_age_s),
    max_recent_age_s: positiveOrDefault(override.max_recent_age_s, base.max_recent_age_s),
    max_control_position_sigma_m: positiveOrDefault(override.max_control_position_sigma_m, base.max_control_position_sigma_m),
    max_control_orientation_sigma_rad: positiveOrDefault(override.max_control_orientation_sigma_rad, base.max_control_orientation_sigma_rad),
    max_single_evidence_control_confidence: clamp01(override.max_single_evidence_control_confidence ?? base.max_single_evidence_control_confidence),
    max_memory_confidence: clamp01(override.max_memory_confidence ?? base.max_memory_confidence),
  });
}

function determinant3(matrix: Matrix3): number {
  const a = matrix[0];
  const b = matrix[1];
  const c = matrix[2];
  return a[0] * (b[1] * c[2] - b[2] * c[1])
    - a[1] * (b[0] * c[2] - b[2] * c[0])
    + a[2] * (b[0] * c[1] - b[1] * c[0]);
}

function dot(a: Vector3, b: Vector3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function vectorNorm(value: readonly number[]): number {
  return Math.sqrt(value.reduce((sum, component) => sum + component * component, 0));
}

function subtractVectors(target: Vector3, current: Vector3): Vector3 {
  return freezeVector3([target[0] - current[0], target[1] - current[1], target[2] - current[2]]);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? clamp(value, 0, 1) : 0;
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
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

function sanitizeText(value: string): string {
  return value.trim().replace(/\s+/gu, " ").replace(HIDDEN_POSE_PATTERN, "hidden-detail").slice(0, 240);
}

function freezeTimestamp(value: TimestampInterval): TimestampInterval {
  return Object.freeze({ start_s: round6(value.start_s), end_s: round6(value.end_s) });
}

function freezeVector3(value: readonly number[]): Vector3 {
  return Object.freeze([round6(value[0]), round6(value[1]), round6(value[2])]) as Vector3;
}

function freezeQuaternion(value: readonly number[]): Quaternion {
  return Object.freeze([round6(value[0]), round6(value[1]), round6(value[2]), round6(value[3])]) as Quaternion;
}

function freezeMatrix3(value: readonly [readonly number[], readonly number[], readonly number[]]): Matrix3 {
  return Object.freeze([
    freezeVector3(value[0]),
    freezeVector3(value[1]),
    freezeVector3(value[2]),
  ]) as Matrix3;
}

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return freezeArray([...new Set(values)].sort());
}

function makeIssue(
  severity: ValidationSeverity,
  code: PoseIssueCode,
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
