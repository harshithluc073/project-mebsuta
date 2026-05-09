/**
 * Spatial constraint evaluator for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md`
 * sections 10.3, 10.8, 10.9, 10.12, 10.14, 10.15, 10.16, and 10.17.
 *
 * This service evaluates normalized File 10 spatial constraints against
 * canonical pose estimates. It computes deterministic residual reports for
 * position, orientation, relative distance, signed projection, support,
 * containment, alignment, clearance, stability, and tool swept-volume checks
 * while preserving uncertainty, evidence, tolerance, frame, and correctability
 * metadata for verification, Oops-loop correction, and control handoff.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type {
  Quaternion,
  Ref,
  SignedAxis,
  ValidationIssue,
  ValidationSeverity,
  Vector3,
} from "../simulation/world_manifest";
import type {
  SpatialConstraintDescriptor,
  SpatialConstraintTargetValue,
  SpatialConstraintType,
  SpatialToleranceDescriptor,
  TargetFrameDescriptor,
} from "./cognitive_spatial_normalizer";
import type { CanonicalPoseEstimate } from "./pose_representation_service";

export const SPATIAL_CONSTRAINT_EVALUATOR_SCHEMA_VERSION = "mebsuta.spatial_constraint_evaluator.v1" as const;

const EPSILON = 1e-9;
const HIDDEN_SPATIAL_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|qa_success|qa_label|qa_only|simulator truth|mesh_name|asset_id|benchmark_truth|oracle_pose)/i;
const TRUTH_FRAME_PATTERN = /(^|[:_\s])(w|q_[a-z0-9_.:-]+|qa_truth)([:_\s]|$)/iu;
const ZERO_VECTOR: Vector3 = Object.freeze([0, 0, 0]) as Vector3;
const GRAVITY_UP: Vector3 = Object.freeze([0, 0, 1]) as Vector3;
const IDENTITY_QUATERNION: Quaternion = Object.freeze([0, 0, 0, 1]) as Quaternion;

export type SpatialResidualType =
  | "position"
  | "orientation"
  | "distance"
  | "projection"
  | "support"
  | "containment"
  | "clearance"
  | "stability"
  | "tool_envelope";

export type SpatialResidualResult = "pass" | "fail_correctable" | "fail_unsafe" | "ambiguous" | "cannot_assess";
export type SpatialResidualCorrectability = "correctable" | "needs_reobserve" | "needs_replan" | "unsafe" | "unknown";
export type SpatialConstraintEvaluatorDecision = "evaluated" | "evaluated_with_warnings" | "ambiguous" | "rejected";
export type SpatialConstraintEvaluatorRecommendedAction = "accept_constraint" | "correct" | "reobserve" | "replan" | "safe_hold" | "repair_constraint";
export type SpatialConstraintEvaluatorIssueCode =
  | "ConstraintMissing"
  | "PoseMissing"
  | "FrameMismatch"
  | "TargetFrameMissing"
  | "TargetValueMissing"
  | "ToleranceMissing"
  | "ToleranceInvalid"
  | "EvidenceMissing"
  | "UncertaintyExceedsTolerance"
  | "PoseStale"
  | "PoseContradicted"
  | "OrientationMissing"
  | "PositionMissing"
  | "SupportEvidenceMissing"
  | "ContainerBoundaryMissing"
  | "ClearanceEvidenceMissing"
  | "ToolEnvelopeMissing"
  | "HiddenSpatialLeak"
  | "TruthFrameBlocked"
  | "PolicyInvalid";

/**
 * Numeric residual uncertainty preserved with every residual report.
 */
export interface SpatialResidualUncertainty {
  readonly position_sigma_m?: number;
  readonly orientation_sigma_rad?: number;
  readonly uncertainty_gate: "passed" | "ambiguous" | "failed";
  readonly sources: readonly Ref[];
  readonly summary: string;
}

/**
 * Axis-aligned support surface inferred from declared perception or contact
 * evidence. Values are estimated geometry, not simulator truth.
 */
export interface SupportSurfaceEstimate {
  readonly support_ref: Ref;
  readonly anchor_ref: Ref;
  readonly frame_ref: Ref;
  readonly center_m: Vector3;
  readonly normal: Vector3;
  readonly half_extents_m: readonly [number, number];
  readonly height_m: number;
  readonly contact_tolerance_m: number;
  readonly evidence_refs: readonly Ref[];
}

/**
 * Axis-aligned container boundary inferred from visible/depth evidence.
 */
export interface ContainerBoundaryEstimate {
  readonly container_ref: Ref;
  readonly anchor_ref: Ref;
  readonly frame_ref: Ref;
  readonly min_m: Vector3;
  readonly max_m: Vector3;
  readonly rim_height_m?: number;
  readonly containment_margin_m: number;
  readonly evidence_refs: readonly Ref[];
}

/**
 * Estimated obstacle primitive used by clearance and tool-envelope checks.
 */
export interface ClearanceObstacleEstimate {
  readonly obstacle_ref: Ref;
  readonly frame_ref: Ref;
  readonly center_m: Vector3;
  readonly radius_m: number;
  readonly evidence_refs: readonly Ref[];
}

/**
 * Swept-volume sample set for a tool or end-effector motion.
 */
export interface ToolSweptVolumeEstimate {
  readonly swept_volume_ref: Ref;
  readonly subject_ref: Ref;
  readonly frame_ref: Ref;
  readonly sample_points_m: readonly Vector3[];
  readonly radius_m: number;
  readonly evidence_refs: readonly Ref[];
}

/**
 * Runtime policy for residual classification and safety routing.
 */
export interface SpatialConstraintEvaluatorPolicy {
  readonly reject_hidden_identifiers?: boolean;
  readonly require_evidence_refs?: boolean;
  readonly require_same_reference_frame?: boolean;
  readonly unsafe_clearance_multiplier?: number;
  readonly unsafe_support_multiplier?: number;
  readonly max_correctable_residual_multiplier?: number;
  readonly default_position_tolerance_m?: number;
  readonly default_orientation_tolerance_rad?: number;
  readonly default_distance_tolerance_m?: number;
  readonly default_clearance_margin_m?: number;
}

/**
 * Input packet for evaluating one or more normalized spatial constraints.
 */
export interface SpatialConstraintEvaluationInput {
  readonly evaluation_ref?: Ref;
  readonly constraint_descriptors: readonly SpatialConstraintDescriptor[];
  readonly pose_estimates: readonly CanonicalPoseEstimate[];
  readonly target_frames?: readonly TargetFrameDescriptor[];
  readonly support_surfaces?: readonly SupportSurfaceEstimate[];
  readonly container_boundaries?: readonly ContainerBoundaryEstimate[];
  readonly clearance_obstacles?: readonly ClearanceObstacleEstimate[];
  readonly tool_swept_volumes?: readonly ToolSweptVolumeEstimate[];
  readonly policy?: SpatialConstraintEvaluatorPolicy;
}

/**
 * File 10 residual report schema emitted for every evaluated constraint.
 */
export interface SpatialResidualReport {
  readonly schema_version: typeof SPATIAL_CONSTRAINT_EVALUATOR_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md";
  readonly residual_report_ref: Ref;
  readonly constraint_ref: Ref;
  readonly subject_pose_refs: readonly Ref[];
  readonly target_frame_ref?: Ref;
  readonly residual_type: SpatialResidualType;
  readonly residual_value?: number;
  readonly residual_direction?: Vector3 | string;
  readonly tolerance: SpatialToleranceDescriptor;
  readonly uncertainty: SpatialResidualUncertainty;
  readonly evidence_refs: readonly Ref[];
  readonly result: SpatialResidualResult;
  readonly correctability: SpatialResidualCorrectability;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
  readonly cognitive_visibility: "spatial_residual_report";
}

/**
 * Batch evaluation report for verifier, Oops-loop, and control consumers.
 */
export interface SpatialConstraintEvaluationReport {
  readonly schema_version: typeof SPATIAL_CONSTRAINT_EVALUATOR_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md";
  readonly evaluation_ref: Ref;
  readonly residual_reports: readonly SpatialResidualReport[];
  readonly rejected_constraint_refs: readonly Ref[];
  readonly decision: SpatialConstraintEvaluatorDecision;
  readonly recommended_action: SpatialConstraintEvaluatorRecommendedAction;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
  readonly cognitive_visibility: "spatial_constraint_evaluation_report";
}

interface NormalizedSpatialConstraintEvaluatorPolicy {
  readonly reject_hidden_identifiers: boolean;
  readonly require_evidence_refs: boolean;
  readonly require_same_reference_frame: boolean;
  readonly unsafe_clearance_multiplier: number;
  readonly unsafe_support_multiplier: number;
  readonly max_correctable_residual_multiplier: number;
  readonly default_position_tolerance_m: number;
  readonly default_orientation_tolerance_rad: number;
  readonly default_distance_tolerance_m: number;
  readonly default_clearance_margin_m: number;
}

interface EvaluationContext {
  readonly input: SpatialConstraintEvaluationInput;
  readonly policy: NormalizedSpatialConstraintEvaluatorPolicy;
  readonly poseByRef: ReadonlyMap<Ref, CanonicalPoseEstimate>;
  readonly poseBySubject: ReadonlyMap<Ref, CanonicalPoseEstimate>;
}

interface ConstraintEvaluationState {
  readonly constraint: SpatialConstraintDescriptor;
  readonly index: number;
  readonly subjectPoses: readonly CanonicalPoseEstimate[];
  readonly anchorPose?: CanonicalPoseEstimate;
  readonly targetPose?: CanonicalPoseEstimate;
  readonly targetFrame?: TargetFrameDescriptor;
  readonly targetPosition?: Vector3;
  readonly targetOrientation?: Quaternion;
  readonly toleranceValue: number;
  readonly residualType: SpatialResidualType;
  readonly issues: ValidationIssue[];
  readonly evidenceRefs: readonly Ref[];
  readonly uncertainty: SpatialResidualUncertainty;
}

interface NumericResidual {
  readonly value?: number;
  readonly direction?: Vector3 | string;
  readonly unsafe: boolean;
  readonly cannotAssess: boolean;
  readonly ambiguous: boolean;
}

const DEFAULT_POLICY: NormalizedSpatialConstraintEvaluatorPolicy = Object.freeze({
  reject_hidden_identifiers: true,
  require_evidence_refs: true,
  require_same_reference_frame: true,
  unsafe_clearance_multiplier: 2,
  unsafe_support_multiplier: 2.5,
  max_correctable_residual_multiplier: 8,
  default_position_tolerance_m: 0.03,
  default_orientation_tolerance_rad: 0.12,
  default_distance_tolerance_m: 0.04,
  default_clearance_margin_m: 0.05,
});

/**
 * Executable File 10 `SpatialConstraintEvaluator`.
 */
export class SpatialConstraintEvaluator {
  private readonly policy: NormalizedSpatialConstraintEvaluatorPolicy;

  public constructor(policy: SpatialConstraintEvaluatorPolicy = {}) {
    this.policy = mergePolicy(DEFAULT_POLICY, policy);
  }

  /**
   * Evaluates normalized spatial constraints against canonical poses and
   * returns residual reports with result, uncertainty, and correction metadata.
   */
  public evaluateSpatialConstraint(input: SpatialConstraintEvaluationInput): SpatialConstraintEvaluationReport {
    const policy = mergePolicy(this.policy, input.policy ?? {});
    const context = buildEvaluationContext(input, policy);
    const issues: ValidationIssue[] = [];
    validatePolicy(policy, issues);
    validateInputShell(input, policy, issues);

    const reports = input.constraint_descriptors.map((constraint, index) => evaluateOneConstraint(context, constraint, index));
    const residualReports = reports.filter(isSpatialResidualReport);
    const rejected = input.constraint_descriptors
      .filter((constraint) => !residualReports.some((report) => report.constraint_ref === constraint.constraint_ref))
      .map((constraint) => sanitizeRef(constraint.constraint_ref || "constraint_ref_missing"))
      .sort();
    const residualIssues = residualReports.flatMap((report) => report.issues);
    issues.push(...residualIssues);

    const decision = decideEvaluation(residualReports, rejected, issues);
    const recommendedAction = chooseRecommendedAction(residualReports, issues, decision);
    const evaluationRef = input.evaluation_ref === undefined
      ? makeRef("spatial_constraint_evaluation", input.constraint_descriptors.map((constraint) => constraint.constraint_ref).join(":"), decision)
      : sanitizeRef(input.evaluation_ref);

    return Object.freeze({
      schema_version: SPATIAL_CONSTRAINT_EVALUATOR_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md",
      evaluation_ref: evaluationRef,
      residual_reports: freezeArray(residualReports),
      rejected_constraint_refs: freezeArray(rejected),
      decision,
      recommended_action: recommendedAction,
      issues: freezeArray(issues),
      ok: decision === "evaluated" && residualReports.every((report) => report.result === "pass"),
      determinism_hash: computeDeterminismHash({
        evaluationRef,
        residuals: residualReports.map((report) => [report.residual_report_ref, report.result, report.residual_value]),
        rejected,
        decision,
        issueCodes: issues.map((issue) => issue.code).sort(),
      }),
      cognitive_visibility: "spatial_constraint_evaluation_report",
    });
  }
}

/**
 * Functional API matching the File 10 architecture signature.
 */
export function evaluateSpatialConstraint(input: SpatialConstraintEvaluationInput): SpatialConstraintEvaluationReport {
  return new SpatialConstraintEvaluator(input.policy).evaluateSpatialConstraint(input);
}

function evaluateOneConstraint(
  context: EvaluationContext,
  constraint: SpatialConstraintDescriptor,
  index: number,
): SpatialResidualReport | undefined {
  const issues: ValidationIssue[] = [];
  const state = resolveEvaluationState(context, constraint, index, issues);
  if (state === undefined) return undefined;

  const numericResidual = computeResidual(state, context);
  const result = classifyResidual(numericResidual, state, context.policy);
  const correctability = classifyCorrectability(numericResidual, result, state, context.policy);
  const residualReportRef = makeRef("spatial_residual_report", constraint.constraint_ref, state.residualType, result);
  const reportIssues = freezeArray([...state.issues, ...issues]);

  return Object.freeze({
    schema_version: SPATIAL_CONSTRAINT_EVALUATOR_SCHEMA_VERSION,
    blueprint_ref: "architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md",
    residual_report_ref: residualReportRef,
    constraint_ref: constraint.constraint_ref,
    subject_pose_refs: freezeArray(state.subjectPoses.map((pose) => pose.pose_ref).sort()),
    target_frame_ref: state.targetFrame?.target_frame_ref,
    residual_type: state.residualType,
    residual_value: numericResidual.value === undefined ? undefined : round6(numericResidual.value),
    residual_direction: numericResidual.direction,
    tolerance: constraint.tolerance,
    uncertainty: state.uncertainty,
    evidence_refs: state.evidenceRefs,
    result,
    correctability,
    issues: reportIssues,
    determinism_hash: computeDeterminismHash({
      residualReportRef,
      constraint: constraint.constraint_ref,
      subjects: state.subjectPoses.map((pose) => pose.pose_ref).sort(),
      target: state.targetFrame?.target_frame_ref,
      residualType: state.residualType,
      value: numericResidual.value,
      direction: numericResidual.direction,
      tolerance: constraint.tolerance,
      uncertainty: state.uncertainty,
      result,
      correctability,
      issueCodes: reportIssues.map((issue) => issue.code).sort(),
    }),
    cognitive_visibility: "spatial_residual_report",
  });
}

function resolveEvaluationState(
  context: EvaluationContext,
  constraint: SpatialConstraintDescriptor,
  index: number,
  sharedIssues: ValidationIssue[],
): ConstraintEvaluationState | undefined {
  const path = `$.constraint_descriptors[${index}]`;
  const issues: ValidationIssue[] = [];
  validateConstraintShell(constraint, path, context.policy, issues);
  const subjectPoses = constraint.subject_refs.map((ref) => findPose(ref, context)).filter(isCanonicalPoseEstimate);
  for (const [subjectIndex, subjectRef] of constraint.subject_refs.entries()) {
    if (!subjectPoses.some((pose) => pose.subject_ref === subjectRef || pose.pose_ref === subjectRef)) {
      issues.push(makeIssue("error", "PoseMissing", `${path}.subject_refs[${subjectIndex}]`, "Constraint subject has no canonical pose estimate.", "Reobserve or bind the subject ref to a current pose estimate."));
    }
  }

  const targetValue = constraint.target_value;
  const anchorPose = targetValue?.reference_anchor_ref === undefined ? undefined : findPose(targetValue.reference_anchor_ref, context);
  const targetPose = targetValue?.target_pose_ref === undefined ? undefined : findPose(targetValue.target_pose_ref, context);
  const targetFrame = findTargetFrame(constraint, targetValue, context);
  const targetPosition = resolveTargetPosition(targetValue, targetPose);
  const targetOrientation = resolveTargetOrientation(targetPose);
  const residualType = residualTypeForConstraint(constraint.constraint_type);
  const toleranceValue = toleranceForResidual(constraint.tolerance, residualType, context.policy);
  validateToleranceValue(toleranceValue, constraint.tolerance, `${path}.tolerance`, issues);
  validatePoseReadiness(subjectPoses, constraint, path, issues);
  validateFrameCompatibility(subjectPoses, anchorPose, targetPose, constraint, context.policy, path, issues);
  validateConstraintCompleteness(constraint, targetValue, targetPosition, targetOrientation, anchorPose, residualType, path, issues);
  const evidenceRefs = resolveEvidenceRefs(constraint, subjectPoses, anchorPose, targetPose, targetFrame, context, path, issues);
  const uncertainty = buildResidualUncertainty(subjectPoses, anchorPose, targetPose, constraint.tolerance, residualType, evidenceRefs);

  if (uncertainty.uncertainty_gate === "ambiguous") {
    issues.push(makeIssue("warning", "UncertaintyExceedsTolerance", `${path}.tolerance`, "Combined pose uncertainty exceeds the residual tolerance.", "Reobserve before accepting pass/fail as definitive."));
  }
  if (uncertainty.uncertainty_gate === "failed") {
    issues.push(makeIssue("error", "PoseContradicted", `${path}.pose_estimates`, "At least one required pose is contradicted.", "Reject this residual and reobserve the scene."));
  }

  sharedIssues.push(...issues);
  if (issues.some((issue) => issue.severity === "error" && isFatalIssue(issue.code))) return undefined;
  return Object.freeze({
    constraint,
    index,
    subjectPoses: freezeArray(subjectPoses),
    anchorPose,
    targetPose,
    targetFrame,
    targetPosition,
    targetOrientation,
    toleranceValue,
    residualType,
    issues,
    evidenceRefs,
    uncertainty,
  });
}

function computeResidual(state: ConstraintEvaluationState, context: EvaluationContext): NumericResidual {
  const subjectPose = state.subjectPoses[0];
  if (subjectPose === undefined) return cannotAssess("missing subject pose");

  switch (state.constraint.constraint_type) {
    case "position":
      return computePositionResidual(subjectPose, state.targetPosition);
    case "orientation":
      return computeOrientationResidual(subjectPose, state.targetOrientation);
    case "relative_distance":
      return computeRelativeDistanceResidual(subjectPose, state.anchorPose, state.constraint.target_value, state.toleranceValue);
    case "left_of":
    case "right_of":
      return computeProjectionResidual(subjectPose, state.anchorPose, state.constraint.target_value, state.constraint.constraint_type, state.toleranceValue);
    case "alignment":
      return computeAlignmentResidual(subjectPose, state.anchorPose, state.constraint.target_value, state.toleranceValue);
    case "on_top_of":
      return computeSupportResidual(subjectPose, state.anchorPose, state, context);
    case "inside":
      return computeContainmentResidual(subjectPose, state.anchorPose, state, context);
    case "clearance":
      return computeClearanceResidual(subjectPose, state, context);
    case "stability":
      return computeStabilityResidual(subjectPose);
    case "tool_envelope":
      return computeToolEnvelopeResidual(subjectPose, state, context);
    default:
      return cannotAssess("unsupported constraint type");
  }
}

function computePositionResidual(subjectPose: CanonicalPoseEstimate, targetPosition: Vector3 | undefined): NumericResidual {
  if (subjectPose.position_m === undefined || targetPosition === undefined) return cannotAssess("position unavailable");
  const delta = subtractVectors(subjectPose.position_m, targetPosition);
  return Object.freeze({
    value: vectorNorm(delta),
    direction: freezeVector3([-delta[0], -delta[1], -delta[2]]),
    unsafe: false,
    cannotAssess: false,
    ambiguous: false,
  });
}

function computeOrientationResidual(subjectPose: CanonicalPoseEstimate, targetOrientation: Quaternion | undefined): NumericResidual {
  const subjectOrientation = subjectPose.orientation?.quaternion_xyzw;
  if (subjectOrientation === undefined || targetOrientation === undefined) return cannotAssess("orientation unavailable");
  const angle = quaternionResidualAngle(subjectOrientation, targetOrientation);
  const direction = quaternionResidualVector(subjectOrientation, targetOrientation);
  return Object.freeze({ value: angle, direction, unsafe: false, cannotAssess: false, ambiguous: false });
}

function computeRelativeDistanceResidual(
  subjectPose: CanonicalPoseEstimate,
  anchorPose: CanonicalPoseEstimate | undefined,
  targetValue: SpatialConstraintTargetValue | undefined,
  toleranceValue: number,
): NumericResidual {
  if (subjectPose.position_m === undefined || anchorPose?.position_m === undefined) return cannotAssess("relative positions unavailable");
  const distance = distanceBetween(subjectPose.position_m, anchorPose.position_m);
  const range = targetValue?.distance_range_m;
  const lower = range?.[0] ?? 0;
  const upper = range?.[1] ?? toleranceValue;
  if (distance < lower) {
    return Object.freeze({
      value: lower - distance,
      direction: normalizeOrZero(subtractVectors(subjectPose.position_m, anchorPose.position_m)),
      unsafe: false,
      cannotAssess: false,
      ambiguous: false,
    });
  }
  if (distance > upper) {
    return Object.freeze({
      value: distance - upper,
      direction: normalizeOrZero(subtractVectors(anchorPose.position_m, subjectPose.position_m)),
      unsafe: false,
      cannotAssess: false,
      ambiguous: false,
    });
  }
  return zeroResidual("within declared distance range");
}

function computeProjectionResidual(
  subjectPose: CanonicalPoseEstimate,
  anchorPose: CanonicalPoseEstimate | undefined,
  targetValue: SpatialConstraintTargetValue | undefined,
  type: "left_of" | "right_of",
  toleranceValue: number,
): NumericResidual {
  if (subjectPose.position_m === undefined || anchorPose?.position_m === undefined) return cannotAssess("projection positions unavailable");
  const axis = axisVector(targetValue?.reference_axis ?? "y");
  const delta = subtractVectors(subjectPose.position_m, anchorPose.position_m);
  const signedProjection = dot(delta, axis);
  const requiredSeparation = toleranceValue;
  const residual = type === "left_of"
    ? Math.max(0, signedProjection + requiredSeparation)
    : Math.max(0, requiredSeparation - signedProjection);
  const correctionSign = type === "left_of" ? -1 : 1;
  return Object.freeze({
    value: residual,
    direction: residual <= EPSILON ? "projection relation satisfied" : scaleVector(axis, correctionSign * residual),
    unsafe: false,
    cannotAssess: false,
    ambiguous: false,
  });
}

function computeAlignmentResidual(
  subjectPose: CanonicalPoseEstimate,
  anchorPose: CanonicalPoseEstimate | undefined,
  targetValue: SpatialConstraintTargetValue | undefined,
  toleranceValue: number,
): NumericResidual {
  if (subjectPose.position_m === undefined || anchorPose?.position_m === undefined) return cannotAssess("alignment positions unavailable");
  const axis = normalizeOrZero(axisVector(targetValue?.reference_axis ?? "x"));
  const delta = subtractVectors(subjectPose.position_m, anchorPose.position_m);
  const along = scaleVector(axis, dot(delta, axis));
  const crossAxisDeviation = subtractVectors(delta, along);
  const residual = Math.max(0, vectorNorm(crossAxisDeviation) - toleranceValue);
  return Object.freeze({
    value: residual,
    direction: residual <= EPSILON ? "aligned within tolerance" : scaleVector(normalizeOrZero(crossAxisDeviation), -residual),
    unsafe: false,
    cannotAssess: false,
    ambiguous: false,
  });
}

function computeSupportResidual(
  subjectPose: CanonicalPoseEstimate,
  anchorPose: CanonicalPoseEstimate | undefined,
  state: ConstraintEvaluationState,
  context: EvaluationContext,
): NumericResidual {
  if (subjectPose.position_m === undefined || anchorPose?.position_m === undefined) return cannotAssess("support positions unavailable");
  const support = findSupportSurface(state, context);
  const supportHeight = support?.height_m ?? anchorPose.position_m[2];
  const contactTolerance = support?.contact_tolerance_m ?? state.toleranceValue;
  const horizontalResidual = support === undefined ? 0 : horizontalSupportResidual(subjectPose.position_m, support);
  const verticalResidual = Math.max(0, Math.abs(subjectPose.position_m[2] - supportHeight) - contactTolerance);
  const belowResidual = Math.max(0, supportHeight - subjectPose.position_m[2]);
  const residual = Math.max(horizontalResidual, verticalResidual, belowResidual);
  return Object.freeze({
    value: residual,
    direction: residual <= EPSILON ? "supported on top surface" : supportCorrectionDirection(subjectPose.position_m, support, supportHeight),
    unsafe: residual > state.toleranceValue * context.policy.unsafe_support_multiplier,
    cannotAssess: false,
    ambiguous: support === undefined,
  });
}

function computeContainmentResidual(
  subjectPose: CanonicalPoseEstimate,
  anchorPose: CanonicalPoseEstimate | undefined,
  state: ConstraintEvaluationState,
  context: EvaluationContext,
): NumericResidual {
  if (subjectPose.position_m === undefined) return cannotAssess("contained position unavailable");
  const container = findContainerBoundary(state, context);
  if (container === undefined) {
    const fallback = anchorPose?.position_m;
    if (fallback === undefined) return cannotAssess("container boundary unavailable");
    return Object.freeze({
      value: 0,
      direction: "container boundary missing; containment ambiguous",
      unsafe: false,
      cannotAssess: false,
      ambiguous: true,
    });
  }
  const margin = container.containment_margin_m;
  const residual = containmentOutsideDistance(subjectPose.position_m, container, margin);
  const direction = residual <= EPSILON ? "inside container bounds" : containmentCorrectionDirection(subjectPose.position_m, container, margin);
  return Object.freeze({ value: residual, direction, unsafe: false, cannotAssess: false, ambiguous: container.rim_height_m === undefined });
}

function computeClearanceResidual(
  subjectPose: CanonicalPoseEstimate,
  state: ConstraintEvaluationState,
  context: EvaluationContext,
): NumericResidual {
  if (subjectPose.position_m === undefined) return cannotAssess("clearance position unavailable");
  const obstacles = context.input.clearance_obstacles ?? [];
  if (obstacles.length === 0) return cannotAssess("clearance obstacles unavailable");
  const margin = clearanceMargin(state.constraint.tolerance, context.policy);
  const clearanceValues = obstacles.map((obstacle) => distanceBetween(subjectPose.position_m as Vector3, obstacle.center_m) - obstacle.radius_m);
  const minClearance = Math.min(...clearanceValues);
  const residual = Math.max(0, margin - minClearance);
  const nearest = obstacles[clearanceValues.indexOf(minClearance)];
  return Object.freeze({
    value: residual,
    direction: residual <= EPSILON ? "clearance margin satisfied" : normalizeOrZero(subtractVectors(subjectPose.position_m, nearest.center_m)),
    unsafe: residual > margin * context.policy.unsafe_clearance_multiplier,
    cannotAssess: false,
    ambiguous: false,
  });
}

function computeStabilityResidual(subjectPose: CanonicalPoseEstimate): NumericResidual {
  const subjectOrientation = subjectPose.orientation?.quaternion_xyzw;
  if (subjectOrientation === undefined) return cannotAssess("stability orientation unavailable");
  const objectUp = rotateVector(subjectOrientation, GRAVITY_UP);
  const angle = vectorAngle(objectUp, GRAVITY_UP);
  return Object.freeze({
    value: angle,
    direction: angle <= EPSILON ? "upright" : cross(objectUp, GRAVITY_UP),
    unsafe: angle > Math.PI / 3,
    cannotAssess: false,
    ambiguous: false,
  });
}

function computeToolEnvelopeResidual(
  subjectPose: CanonicalPoseEstimate,
  state: ConstraintEvaluationState,
  context: EvaluationContext,
): NumericResidual {
  const sweptVolume = findToolSweptVolume(state, context);
  const obstacles = context.input.clearance_obstacles ?? [];
  if (sweptVolume === undefined || obstacles.length === 0) return cannotAssess("tool swept volume or obstacles unavailable");
  const margin = clearanceMargin(state.constraint.tolerance, context.policy);
  let worstResidual = 0;
  let worstDirection: Vector3 | string = "tool envelope clearance satisfied";
  for (const samplePoint of sweptVolume.sample_points_m) {
    for (const obstacle of obstacles) {
      const clearance = distanceBetween(samplePoint, obstacle.center_m) - sweptVolume.radius_m - obstacle.radius_m;
      const residual = Math.max(0, margin - clearance);
      if (residual > worstResidual) {
        worstResidual = residual;
        worstDirection = normalizeOrZero(subtractVectors(samplePoint, obstacle.center_m));
      }
    }
  }
  if (subjectPose.position_m === undefined && sweptVolume.sample_points_m.length === 0) return cannotAssess("tool swept volume samples unavailable");
  return Object.freeze({
    value: worstResidual,
    direction: worstDirection,
    unsafe: worstResidual > margin * context.policy.unsafe_clearance_multiplier,
    cannotAssess: false,
    ambiguous: false,
  });
}

function classifyResidual(
  residual: NumericResidual,
  state: ConstraintEvaluationState,
  policy: NormalizedSpatialConstraintEvaluatorPolicy,
): SpatialResidualResult {
  if (residual.cannotAssess || residual.value === undefined || state.subjectPoses.length === 0) return "cannot_assess";
  if (state.uncertainty.uncertainty_gate === "failed") return "cannot_assess";
  if (residual.ambiguous || state.uncertainty.uncertainty_gate === "ambiguous" || state.issues.some((issue) => issue.severity === "warning" && issue.code === "EvidenceMissing")) return "ambiguous";
  if (residual.value <= state.toleranceValue + EPSILON) return "pass";
  if (residual.unsafe || state.constraint.safety_implications.length > 0 && residual.value > state.toleranceValue * policy.max_correctable_residual_multiplier) return "fail_unsafe";
  return "fail_correctable";
}

function classifyCorrectability(
  residual: NumericResidual,
  result: SpatialResidualResult,
  state: ConstraintEvaluationState,
  policy: NormalizedSpatialConstraintEvaluatorPolicy,
): SpatialResidualCorrectability {
  if (result === "pass") return "correctable";
  if (result === "cannot_assess") return state.issues.some((issue) => issue.code === "PoseMissing" || issue.code === "PositionMissing" || issue.code === "OrientationMissing") ? "needs_reobserve" : "unknown";
  if (result === "ambiguous") return "needs_reobserve";
  if (result === "fail_unsafe") return "unsafe";
  const value = residual.value ?? Number.POSITIVE_INFINITY;
  return value <= state.toleranceValue * policy.max_correctable_residual_multiplier ? "correctable" : "needs_replan";
}

function buildEvaluationContext(
  input: SpatialConstraintEvaluationInput,
  policy: NormalizedSpatialConstraintEvaluatorPolicy,
): EvaluationContext {
  const poseByRef = new Map<Ref, CanonicalPoseEstimate>();
  const poseBySubject = new Map<Ref, CanonicalPoseEstimate>();
  for (const pose of input.pose_estimates) {
    poseByRef.set(sanitizeRef(pose.pose_ref), pose);
    poseBySubject.set(sanitizeRef(pose.subject_ref), pose);
  }
  return Object.freeze({
    input,
    policy,
    poseByRef,
    poseBySubject,
  });
}

function findPose(ref: Ref, context: EvaluationContext): CanonicalPoseEstimate | undefined {
  const normalized = sanitizeRef(ref);
  return context.poseByRef.get(normalized) ?? context.poseBySubject.get(normalized);
}

function findTargetFrame(
  constraint: SpatialConstraintDescriptor,
  targetValue: SpatialConstraintTargetValue | undefined,
  context: EvaluationContext,
): TargetFrameDescriptor | undefined {
  const targetFrames = context.input.target_frames ?? [];
  return targetFrames.find((frame) =>
    frame.constraints.some((candidate) => candidate.constraint_ref === constraint.constraint_ref)
    || frame.target_frame_ref === targetValue?.target_pose_ref
    || frame.pose_or_relation.target_pose_ref === targetValue?.target_pose_ref
    || frame.anchor_refs.includes(targetValue?.reference_anchor_ref ?? "ref:missing"),
  );
}

function resolveTargetPosition(
  targetValue: SpatialConstraintTargetValue | undefined,
  targetPose: CanonicalPoseEstimate | undefined,
): Vector3 | undefined {
  return targetValue?.target_position_m ?? targetPose?.position_m;
}

function resolveTargetOrientation(targetPose: CanonicalPoseEstimate | undefined): Quaternion | undefined {
  return targetPose?.orientation?.quaternion_xyzw;
}

function buildResidualUncertainty(
  subjectPoses: readonly CanonicalPoseEstimate[],
  anchorPose: CanonicalPoseEstimate | undefined,
  targetPose: CanonicalPoseEstimate | undefined,
  tolerance: SpatialToleranceDescriptor,
  residualType: SpatialResidualType,
  evidenceRefs: readonly Ref[],
): SpatialResidualUncertainty {
  const poses = [...subjectPoses, anchorPose, targetPose].filter(isCanonicalPoseEstimate);
  const positionSigmas = poses.map((pose) => pose.uncertainty.position_sigma_m).filter(isNumber);
  const orientationSigmas = poses.map((pose) => pose.uncertainty.orientation_sigma_rad).filter(isNumber);
  const positionSigma = combineSigma(positionSigmas);
  const orientationSigma = combineSigma(orientationSigmas);
  const toleranceValue = toleranceForUncertainty(tolerance, residualType);
  const relevantSigma = residualType === "orientation" || residualType === "stability" ? orientationSigma : positionSigma;
  const contradicted = poses.some((pose) => pose.staleness_status === "contradicted");
  const stale = poses.some((pose) => pose.staleness_status === "stale");
  const exceedsTolerance = tolerance.uncertainty_must_be_below_tolerance && relevantSigma !== undefined && relevantSigma > toleranceValue;
  const gate = contradicted ? "failed" : stale || exceedsTolerance || evidenceRefs.length === 0 ? "ambiguous" : "passed";
  return Object.freeze({
    position_sigma_m: positionSigma,
    orientation_sigma_rad: orientationSigma,
    uncertainty_gate: gate,
    sources: freezeArray(poses.map((pose) => pose.pose_ref).sort()),
    summary: summarizeUncertainty(positionSigma, orientationSigma, toleranceValue, gate),
  });
}

function resolveEvidenceRefs(
  constraint: SpatialConstraintDescriptor,
  subjectPoses: readonly CanonicalPoseEstimate[],
  anchorPose: CanonicalPoseEstimate | undefined,
  targetPose: CanonicalPoseEstimate | undefined,
  targetFrame: TargetFrameDescriptor | undefined,
  context: EvaluationContext,
  path: string,
  issues: ValidationIssue[],
): readonly Ref[] {
  const refs = new Set<Ref>();
  for (const pose of subjectPoses) for (const ref of pose.evidence_refs) refs.add(sanitizeRef(ref));
  for (const ref of anchorPose?.evidence_refs ?? []) refs.add(sanitizeRef(ref));
  for (const ref of targetPose?.evidence_refs ?? []) refs.add(sanitizeRef(ref));
  for (const ref of targetFrame?.evidence_refs ?? []) refs.add(sanitizeRef(ref));
  for (const support of context.input.support_surfaces ?? []) for (const ref of support.evidence_refs) refs.add(sanitizeRef(ref));
  for (const boundary of context.input.container_boundaries ?? []) for (const ref of boundary.evidence_refs) refs.add(sanitizeRef(ref));
  for (const obstacle of context.input.clearance_obstacles ?? []) for (const ref of obstacle.evidence_refs) refs.add(sanitizeRef(ref));
  for (const volume of context.input.tool_swept_volumes ?? []) for (const ref of volume.evidence_refs) refs.add(sanitizeRef(ref));

  const evidence = [...refs].sort();
  if (context.policy.require_evidence_refs && evidence.length === 0) {
    issues.push(makeIssue("warning", "EvidenceMissing", `${path}.evidence_refs`, "Constraint residual has no declared evidence refs.", "Attach pose, depth, contact, boundary, obstacle, or tool evidence before certification."));
  }
  for (const requirement of constraint.evidence_requirements) {
    if (!evidence.some((ref) => ref.includes(sanitizeRef(requirement)))) {
      issues.push(makeIssue("warning", "EvidenceMissing", `${path}.evidence_requirements`, `Evidence requirement ${requirement} is not directly represented in evidence refs.`, "Include explicit evidence refs for every File 10 residual requirement."));
    }
  }
  return freezeArray(evidence);
}

function validateInputShell(
  input: SpatialConstraintEvaluationInput,
  policy: NormalizedSpatialConstraintEvaluatorPolicy,
  issues: ValidationIssue[],
): void {
  if (input.constraint_descriptors.length === 0) {
    issues.push(makeIssue("error", "ConstraintMissing", "$.constraint_descriptors", "SpatialConstraintEvaluator requires at least one constraint descriptor.", "Provide normalized constraints from CognitiveSpatialNormalizer."));
  }
  if (input.pose_estimates.length === 0) {
    issues.push(makeIssue("error", "PoseMissing", "$.pose_estimates", "SpatialConstraintEvaluator requires canonical pose estimates.", "Provide PoseRepresentationService output."));
  }
  const searchable = JSON.stringify(input);
  if (policy.reject_hidden_identifiers && HIDDEN_SPATIAL_PATTERN.test(searchable)) {
    issues.push(makeIssue("error", "HiddenSpatialLeak", "$", "Evaluation input contains hidden simulator/backend/QA wording.", "Strip hidden identifiers before residual evaluation."));
  }
  for (const [index, pose] of input.pose_estimates.entries()) {
    if (isTruthFrameRef(pose.frame_ref)) {
      issues.push(makeIssue("error", "TruthFrameBlocked", `$.pose_estimates[${index}].frame_ref`, "Pose estimate uses a simulator or QA truth frame.", "Use W_hat or another declared estimate frame."));
    }
  }
}

function validateConstraintShell(
  constraint: SpatialConstraintDescriptor,
  path: string,
  policy: NormalizedSpatialConstraintEvaluatorPolicy,
  issues: ValidationIssue[],
): void {
  validateSafeRef(constraint.constraint_ref, `${path}.constraint_ref`, "ConstraintMissing", issues);
  validateSafeRef(constraint.reference_frame, `${path}.reference_frame`, "TargetFrameMissing", issues);
  if (isTruthFrameRef(constraint.reference_frame)) {
    issues.push(makeIssue("error", "TruthFrameBlocked", `${path}.reference_frame`, "Constraint references a simulator or QA truth frame.", "Use declared estimated frames only."));
  }
  if (constraint.subject_refs.length === 0) {
    issues.push(makeIssue("error", "PoseMissing", `${path}.subject_refs`, "Constraint must reference at least one subject.", "Attach a subject ref that resolves to a canonical pose."));
  }
  for (const [index, ref] of constraint.subject_refs.entries()) validateSafeRef(ref, `${path}.subject_refs[${index}]`, "PoseMissing", issues);
  if (policy.reject_hidden_identifiers) validateNoHiddenText(JSON.stringify(constraint), path, issues);
}

function validatePoseReadiness(
  poses: readonly CanonicalPoseEstimate[],
  constraint: SpatialConstraintDescriptor,
  path: string,
  issues: ValidationIssue[],
): void {
  for (const pose of poses) {
    if (pose.staleness_status === "stale") {
      issues.push(makeIssue("warning", "PoseStale", `${path}.pose_estimates.${pose.pose_ref}`, "Pose estimate is stale for residual evaluation.", "Reobserve or downgrade certificate confidence."));
    }
    if (pose.staleness_status === "contradicted") {
      issues.push(makeIssue("error", "PoseContradicted", `${path}.pose_estimates.${pose.pose_ref}`, "Pose estimate is contradicted.", "Reject this residual and reobserve."));
    }
    if (pose.position_m === undefined && constraint.constraint_type !== "orientation" && constraint.constraint_type !== "stability") {
      issues.push(makeIssue("error", "PositionMissing", `${path}.pose_estimates.${pose.pose_ref}.position_m`, "Constraint requires a subject position estimate.", "Provide a canonical pose with position_m."));
    }
    if (pose.orientation?.quaternion_xyzw === undefined && (constraint.constraint_type === "orientation" || constraint.constraint_type === "stability")) {
      issues.push(makeIssue("error", "OrientationMissing", `${path}.pose_estimates.${pose.pose_ref}.orientation`, "Constraint requires a subject orientation quaternion.", "Provide a canonical pose with exact orientation."));
    }
  }
}

function validateFrameCompatibility(
  subjectPoses: readonly CanonicalPoseEstimate[],
  anchorPose: CanonicalPoseEstimate | undefined,
  targetPose: CanonicalPoseEstimate | undefined,
  constraint: SpatialConstraintDescriptor,
  policy: NormalizedSpatialConstraintEvaluatorPolicy,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!policy.require_same_reference_frame) return;
  const frameRefs = [...subjectPoses, anchorPose, targetPose]
    .filter(isCanonicalPoseEstimate)
    .map((pose) => pose.frame_ref);
  for (const frameRef of frameRefs) {
    if (frameRef !== constraint.reference_frame) {
      issues.push(makeIssue("error", "FrameMismatch", `${path}.reference_frame`, `Pose frame ${frameRef} does not match constraint frame ${constraint.reference_frame}.`, "Transform all poses into the declared constraint reference frame before residual evaluation."));
    }
  }
}

function validateConstraintCompleteness(
  constraint: SpatialConstraintDescriptor,
  targetValue: SpatialConstraintTargetValue | undefined,
  targetPosition: Vector3 | undefined,
  targetOrientation: Quaternion | undefined,
  anchorPose: CanonicalPoseEstimate | undefined,
  residualType: SpatialResidualType,
  path: string,
  issues: ValidationIssue[],
): void {
  if (targetValue === undefined && constraint.constraint_type !== "stability" && constraint.constraint_type !== "clearance" && constraint.constraint_type !== "tool_envelope") {
    issues.push(makeIssue("error", "TargetValueMissing", `${path}.target_value`, "Constraint requires target value metadata.", "Regenerate the normalized constraint with a target value."));
  }
  if (residualType === "position" && targetPosition === undefined) {
    issues.push(makeIssue("error", "TargetValueMissing", `${path}.target_value.target_position_m`, "Position residual requires a target position or target pose.", "Attach target_position_m or target_pose_ref."));
  }
  if (residualType === "orientation" && targetOrientation === undefined) {
    issues.push(makeIssue("error", "OrientationMissing", `${path}.target_value.target_pose_ref`, "Orientation residual requires a target pose with exact orientation.", "Attach a canonical target pose orientation."));
  }
  if ((constraint.constraint_type === "relative_distance" || constraint.constraint_type === "left_of" || constraint.constraint_type === "right_of" || constraint.constraint_type === "alignment" || constraint.constraint_type === "on_top_of" || constraint.constraint_type === "inside") && anchorPose === undefined) {
    issues.push(makeIssue("error", "PoseMissing", `${path}.target_value.reference_anchor_ref`, "Relation constraint requires an anchor pose.", "Bind reference_anchor_ref to a canonical pose estimate."));
  }
}

function validateToleranceValue(
  value: number,
  tolerance: SpatialToleranceDescriptor,
  path: string,
  issues: ValidationIssue[],
): void {
  const numbers = [tolerance.position_tolerance_m, tolerance.orientation_tolerance_rad, tolerance.distance_tolerance_m, tolerance.clearance_margin_m].filter(isNumber);
  if (numbers.length === 0 && tolerance.qualitative_threshold === undefined) {
    issues.push(makeIssue("error", "ToleranceMissing", path, "Constraint has no numeric or qualitative tolerance.", "Attach a File 10 tolerance profile."));
  }
  if (!Number.isFinite(value) || value <= 0 || numbers.some((candidate) => !Number.isFinite(candidate) || candidate <= 0)) {
    issues.push(makeIssue("error", "ToleranceInvalid", path, "Residual tolerance must be positive and finite.", "Use positive meters or radians."));
  }
}

function validatePolicy(policy: NormalizedSpatialConstraintEvaluatorPolicy, issues: ValidationIssue[]): void {
  for (const [path, value] of [
    ["$.policy.unsafe_clearance_multiplier", policy.unsafe_clearance_multiplier],
    ["$.policy.unsafe_support_multiplier", policy.unsafe_support_multiplier],
    ["$.policy.max_correctable_residual_multiplier", policy.max_correctable_residual_multiplier],
    ["$.policy.default_position_tolerance_m", policy.default_position_tolerance_m],
    ["$.policy.default_orientation_tolerance_rad", policy.default_orientation_tolerance_rad],
    ["$.policy.default_distance_tolerance_m", policy.default_distance_tolerance_m],
    ["$.policy.default_clearance_margin_m", policy.default_clearance_margin_m],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      issues.push(makeIssue("error", "PolicyInvalid", path, "Spatial evaluator policy thresholds must be positive finite numbers.", "Use positive residual thresholds."));
    }
  }
}

function validateSafeRef(value: Ref, path: string, code: SpatialConstraintEvaluatorIssueCode, issues: ValidationIssue[]): void {
  if (value.trim().length === 0 || /\s/u.test(value)) {
    issues.push(makeIssue("error", code, path, "Reference must be non-empty and whitespace-free.", "Use an opaque sanitized ref."));
  }
  validateNoHiddenText(value, path, issues);
}

function validateNoHiddenText(value: string, path: string, issues: ValidationIssue[]): void {
  if (HIDDEN_SPATIAL_PATTERN.test(value)) {
    issues.push(makeIssue("error", "HiddenSpatialLeak", path, "Spatial metadata contains hidden simulator/backend/QA wording.", "Remove hidden identifiers before residual evaluation."));
  }
}

function findSupportSurface(state: ConstraintEvaluationState, context: EvaluationContext): SupportSurfaceEstimate | undefined {
  const anchorRef = state.constraint.target_value?.reference_anchor_ref ?? state.anchorPose?.subject_ref;
  return (context.input.support_surfaces ?? []).find((surface) => surface.anchor_ref === anchorRef || surface.support_ref === anchorRef);
}

function findContainerBoundary(state: ConstraintEvaluationState, context: EvaluationContext): ContainerBoundaryEstimate | undefined {
  const anchorRef = state.constraint.target_value?.reference_anchor_ref ?? state.anchorPose?.subject_ref;
  const regionRef = state.constraint.target_value?.region_ref;
  return (context.input.container_boundaries ?? []).find((boundary) =>
    boundary.anchor_ref === anchorRef || boundary.container_ref === anchorRef || boundary.container_ref === regionRef,
  );
}

function findToolSweptVolume(state: ConstraintEvaluationState, context: EvaluationContext): ToolSweptVolumeEstimate | undefined {
  const subjectRefs = new Set(state.constraint.subject_refs);
  return (context.input.tool_swept_volumes ?? []).find((volume) => subjectRefs.has(volume.subject_ref) || subjectRefs.has(volume.swept_volume_ref));
}

function horizontalSupportResidual(point: Vector3, support: SupportSurfaceEstimate): number {
  const dx = Math.max(0, Math.abs(point[0] - support.center_m[0]) - support.half_extents_m[0]);
  const dy = Math.max(0, Math.abs(point[1] - support.center_m[1]) - support.half_extents_m[1]);
  return Math.hypot(dx, dy);
}

function supportCorrectionDirection(point: Vector3, support: SupportSurfaceEstimate | undefined, height: number): Vector3 | string {
  if (support === undefined) {
    return freezeVector3([0, 0, height - point[2]]);
  }
  const clampedX = clamp(point[0], support.center_m[0] - support.half_extents_m[0], support.center_m[0] + support.half_extents_m[0]);
  const clampedY = clamp(point[1], support.center_m[1] - support.half_extents_m[1], support.center_m[1] + support.half_extents_m[1]);
  return freezeVector3([clampedX - point[0], clampedY - point[1], height - point[2]]);
}

function containmentOutsideDistance(point: Vector3, container: ContainerBoundaryEstimate, margin: number): number {
  const min = addScalar(container.min_m, margin);
  const max = addScalar(container.max_m, -margin);
  const outside = freezeVector3([
    point[0] < min[0] ? min[0] - point[0] : point[0] > max[0] ? point[0] - max[0] : 0,
    point[1] < min[1] ? min[1] - point[1] : point[1] > max[1] ? point[1] - max[1] : 0,
    point[2] < min[2] ? min[2] - point[2] : point[2] > max[2] ? point[2] - max[2] : 0,
  ]);
  return vectorNorm(outside);
}

function containmentCorrectionDirection(point: Vector3, container: ContainerBoundaryEstimate, margin: number): Vector3 {
  const min = addScalar(container.min_m, margin);
  const max = addScalar(container.max_m, -margin);
  return freezeVector3([
    point[0] < min[0] ? min[0] - point[0] : point[0] > max[0] ? max[0] - point[0] : 0,
    point[1] < min[1] ? min[1] - point[1] : point[1] > max[1] ? max[1] - point[1] : 0,
    point[2] < min[2] ? min[2] - point[2] : point[2] > max[2] ? max[2] - point[2] : 0,
  ]);
}

function residualTypeForConstraint(type: SpatialConstraintType): SpatialResidualType {
  if (type === "relative_distance") return "distance";
  if (type === "left_of" || type === "right_of" || type === "alignment") return "projection";
  if (type === "on_top_of") return "support";
  if (type === "inside") return "containment";
  return type;
}

function toleranceForResidual(
  tolerance: SpatialToleranceDescriptor,
  residualType: SpatialResidualType,
  policy: NormalizedSpatialConstraintEvaluatorPolicy,
): number {
  if (residualType === "orientation" || residualType === "stability") return tolerance.orientation_tolerance_rad ?? policy.default_orientation_tolerance_rad;
  if (residualType === "clearance" || residualType === "tool_envelope") return clearanceMargin(tolerance, policy);
  if (residualType === "distance" || residualType === "projection") return tolerance.distance_tolerance_m ?? tolerance.position_tolerance_m ?? policy.default_distance_tolerance_m;
  return tolerance.position_tolerance_m ?? tolerance.distance_tolerance_m ?? policy.default_position_tolerance_m;
}

function toleranceForUncertainty(tolerance: SpatialToleranceDescriptor, residualType: SpatialResidualType): number {
  if (residualType === "orientation" || residualType === "stability") return tolerance.orientation_tolerance_rad ?? 0.12;
  if (residualType === "clearance" || residualType === "tool_envelope") return tolerance.clearance_margin_m ?? 0.05;
  return tolerance.position_tolerance_m ?? tolerance.distance_tolerance_m ?? 0.03;
}

function clearanceMargin(
  tolerance: SpatialToleranceDescriptor,
  policy: NormalizedSpatialConstraintEvaluatorPolicy,
): number {
  return tolerance.clearance_margin_m ?? tolerance.distance_tolerance_m ?? policy.default_clearance_margin_m;
}

function decideEvaluation(
  reports: readonly SpatialResidualReport[],
  rejected: readonly Ref[],
  issues: readonly ValidationIssue[],
): SpatialConstraintEvaluatorDecision {
  if (issues.some((issue) => issue.severity === "error" && (issue.code === "ConstraintMissing" || issue.code === "PolicyInvalid" || issue.code === "HiddenSpatialLeak" || issue.code === "TruthFrameBlocked"))) return "rejected";
  if (reports.length === 0 && rejected.length > 0) return "rejected";
  if (reports.some((report) => report.result === "cannot_assess" || report.result === "ambiguous") || issues.some((issue) => issue.severity === "warning")) return "ambiguous";
  if (reports.some((report) => report.result !== "pass") || rejected.length > 0 || issues.some((issue) => issue.severity === "error")) return "evaluated_with_warnings";
  return "evaluated";
}

function chooseRecommendedAction(
  reports: readonly SpatialResidualReport[],
  issues: readonly ValidationIssue[],
  decision: SpatialConstraintEvaluatorDecision,
): SpatialConstraintEvaluatorRecommendedAction {
  if (decision === "evaluated" && reports.every((report) => report.result === "pass")) return "accept_constraint";
  if (issues.some((issue) => issue.code === "HiddenSpatialLeak" || issue.code === "TruthFrameBlocked" || issue.code === "ToleranceInvalid" || issue.code === "FrameMismatch")) return "repair_constraint";
  if (reports.some((report) => report.result === "fail_unsafe" || report.correctability === "unsafe")) return "safe_hold";
  if (reports.some((report) => report.correctability === "needs_replan")) return "replan";
  if (reports.some((report) => report.result === "ambiguous" || report.result === "cannot_assess") || issues.some((issue) => issue.code === "PoseMissing" || issue.code === "EvidenceMissing" || issue.code === "UncertaintyExceedsTolerance")) return "reobserve";
  return "correct";
}

function isFatalIssue(code: string): boolean {
  return code === "HiddenSpatialLeak" || code === "TruthFrameBlocked" || code === "PolicyInvalid" || code === "ToleranceInvalid" || code === "FrameMismatch";
}

function cannotAssess(reason: string): NumericResidual {
  return Object.freeze({ value: undefined, direction: reason, unsafe: false, cannotAssess: true, ambiguous: false });
}

function zeroResidual(direction: string): NumericResidual {
  return Object.freeze({ value: 0, direction, unsafe: false, cannotAssess: false, ambiguous: false });
}

function quaternionResidualAngle(current: Quaternion, target: Quaternion): number {
  const relative = canonicalQuaternion(quaternionMultiply(target, quaternionConjugate(current)));
  return round6(2 * Math.atan2(vectorNorm([relative[0], relative[1], relative[2]]), Math.abs(relative[3])));
}

function quaternionResidualVector(current: Quaternion, target: Quaternion): Vector3 {
  const relative = canonicalQuaternion(quaternionMultiply(target, quaternionConjugate(current)));
  const angle = 2 * Math.atan2(vectorNorm([relative[0], relative[1], relative[2]]), Math.abs(relative[3]));
  const sign = relative[3] < 0 ? -1 : 1;
  const vectorPartNorm = Math.hypot(relative[0], relative[1], relative[2]);
  if (vectorPartNorm < EPSILON) return ZERO_VECTOR;
  return freezeVector3([
    sign * relative[0] * angle / vectorPartNorm,
    sign * relative[1] * angle / vectorPartNorm,
    sign * relative[2] * angle / vectorPartNorm,
  ]);
}

function rotateVector(quaternion: Quaternion, vector: Vector3): Vector3 {
  const vQuat: Quaternion = [vector[0], vector[1], vector[2], 0];
  const rotated = quaternionMultiply(quaternionMultiply(canonicalQuaternion(quaternion), vQuat), quaternionConjugate(canonicalQuaternion(quaternion)));
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

function axisVector(axis: SignedAxis | "gravity_up"): Vector3 {
  switch (axis) {
    case "x":
      return freezeVector3([1, 0, 0]);
    case "-x":
      return freezeVector3([-1, 0, 0]);
    case "y":
      return freezeVector3([0, 1, 0]);
    case "-y":
      return freezeVector3([0, -1, 0]);
    case "z":
    case "gravity_up":
      return freezeVector3([0, 0, 1]);
    case "-z":
      return freezeVector3([0, 0, -1]);
  }
}

function vectorAngle(a: Vector3, b: Vector3): number {
  const normProduct = Math.max(EPSILON, vectorNorm(a) * vectorNorm(b));
  return round6(Math.acos(clamp(dot(a, b) / normProduct, -1, 1)));
}

function distanceBetween(a: Vector3, b: Vector3): number {
  return vectorNorm(subtractVectors(a, b));
}

function subtractVectors(a: Vector3, b: Vector3): Vector3 {
  return freezeVector3([a[0] - b[0], a[1] - b[1], a[2] - b[2]]);
}

function addScalar(a: Vector3, scalar: number): Vector3 {
  return freezeVector3([a[0] + scalar, a[1] + scalar, a[2] + scalar]);
}

function scaleVector(a: Vector3, scalar: number): Vector3 {
  return freezeVector3([a[0] * scalar, a[1] * scalar, a[2] * scalar]);
}

function normalizeOrZero(value: Vector3): Vector3 {
  const norm = vectorNorm(value);
  return norm < EPSILON ? ZERO_VECTOR : freezeVector3([value[0] / norm, value[1] / norm, value[2] / norm]);
}

function dot(a: Vector3, b: Vector3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vector3, b: Vector3): Vector3 {
  return freezeVector3([
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]);
}

function vectorNorm(value: readonly number[]): number {
  return Math.sqrt(value.reduce((sum, component) => sum + component * component, 0));
}

function combineSigma(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  return round6(Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)));
}

function summarizeUncertainty(
  positionSigma: number | undefined,
  orientationSigma: number | undefined,
  toleranceValue: number,
  gate: SpatialResidualUncertainty["uncertainty_gate"],
): string {
  const position = positionSigma === undefined ? "position_sigma_m=unknown" : `position_sigma_m=${formatNumber(positionSigma)}`;
  const orientation = orientationSigma === undefined ? "orientation_sigma_rad=unknown" : `orientation_sigma_rad=${formatNumber(orientationSigma)}`;
  return `${position}; ${orientation}; tolerance_gate=${formatNumber(toleranceValue)}; uncertainty_gate=${gate}.`;
}

function isTruthFrameRef(ref: Ref): boolean {
  return ref === "W" || ref.startsWith("Q_") || TRUTH_FRAME_PATTERN.test(ref);
}

function isCanonicalPoseEstimate(value: CanonicalPoseEstimate | undefined): value is CanonicalPoseEstimate {
  return value !== undefined;
}

function isSpatialResidualReport(value: SpatialResidualReport | undefined): value is SpatialResidualReport {
  return value !== undefined;
}

function isNumber(value: number | undefined): value is number {
  return value !== undefined;
}

function mergePolicy(
  base: NormalizedSpatialConstraintEvaluatorPolicy,
  override: SpatialConstraintEvaluatorPolicy,
): NormalizedSpatialConstraintEvaluatorPolicy {
  return Object.freeze({
    reject_hidden_identifiers: override.reject_hidden_identifiers ?? base.reject_hidden_identifiers,
    require_evidence_refs: override.require_evidence_refs ?? base.require_evidence_refs,
    require_same_reference_frame: override.require_same_reference_frame ?? base.require_same_reference_frame,
    unsafe_clearance_multiplier: positiveOrDefault(override.unsafe_clearance_multiplier, base.unsafe_clearance_multiplier),
    unsafe_support_multiplier: positiveOrDefault(override.unsafe_support_multiplier, base.unsafe_support_multiplier),
    max_correctable_residual_multiplier: positiveOrDefault(override.max_correctable_residual_multiplier, base.max_correctable_residual_multiplier),
    default_position_tolerance_m: positiveOrDefault(override.default_position_tolerance_m, base.default_position_tolerance_m),
    default_orientation_tolerance_rad: positiveOrDefault(override.default_orientation_tolerance_rad, base.default_orientation_tolerance_rad),
    default_distance_tolerance_m: positiveOrDefault(override.default_distance_tolerance_m, base.default_distance_tolerance_m),
    default_clearance_margin_m: positiveOrDefault(override.default_clearance_margin_m, base.default_clearance_margin_m),
  });
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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

function makeIssue(
  severity: ValidationSeverity,
  code: SpatialConstraintEvaluatorIssueCode,
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
