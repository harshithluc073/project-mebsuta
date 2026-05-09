/**
 * Cognitive spatial normalizer for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md`
 * sections 10.1, 10.3, 10.4, 10.8, 10.9, 10.10, 10.14, 10.15,
 * 10.16, and 10.17.
 *
 * This service converts Gemini/task-parser spatial proposals into explicit,
 * validator-ready target frames and spatial constraints. It refuses simulator
 * truth leakage, requires frame labels, selects tolerance profiles, preserves
 * uncertainty/evidence, and rejects ambiguous reference axes before IK,
 * control, verification, or residual services consume the goal.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type {
  Ref,
  SignedAxis,
  TimestampInterval,
  ValidationIssue,
  ValidationSeverity,
  Vector3,
} from "../simulation/world_manifest";
import type {
  GeometryConventionProfile,
  GeometryTaskLanguageRule,
  GeometryToleranceClass,
  GeometryToleranceProfile,
} from "./geometry_convention_registry";
import type { CanonicalPoseEstimate, PoseUncertaintyClass } from "./pose_representation_service";

export const COGNITIVE_SPATIAL_NORMALIZER_SCHEMA_VERSION = "mebsuta.cognitive_spatial_normalizer.v1" as const;

const HIDDEN_SPATIAL_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|qa_success|qa_label|qa_only|simulator truth|mesh_name|asset_id|benchmark_truth|oracle_pose)/i;
const TRUTH_FRAME_PATTERN = /(^|[:_\s])(w|q_[a-z0-9_.:-]+|qa_truth)([:_\s]|$)/iu;

export type CognitiveSpatialTargetKind = "placement" | "approach" | "grasp" | "inspection" | "retreat" | "verification" | "tool_contact" | "safe_hold";
export type CognitiveSpatialProposalSource = "gemini_plan" | "human_instruction" | "task_template" | "validator_feedback" | "verification_policy";
export type SpatialConstraintType = "position" | "orientation" | "relative_distance" | "left_of" | "right_of" | "on_top_of" | "inside" | "alignment" | "clearance" | "stability" | "tool_envelope";
export type TargetFrameLifecycleState = "proposed" | "estimated" | "validator_ready" | "control_candidate" | "executed" | "verified" | "invalidated";
export type NormalizationDecision = "normalized" | "normalized_with_warnings" | "needs_clarification" | "rejected";
export type NormalizationRecommendedAction = "run_validators" | "reobserve" | "ask_clarification" | "repair_reference_frame" | "repair_tolerance" | "repair_truth_boundary" | "safe_hold";
export type ValidatorRequirement = "geometry" | "reach" | "collision" | "stability" | "ik" | "controller_feasibility" | "verification_view" | "contact" | "tool_swept_volume" | "memory_currentness";
export type CognitiveSpatialIssueCode =
  | "ProposalRefInvalid"
  | "HiddenSpatialLeak"
  | "TruthFrameBlocked"
  | "SubjectMissing"
  | "AnchorMissing"
  | "PoseMissing"
  | "PoseStale"
  | "ReferenceFrameMissing"
  | "AmbiguousReferenceAxis"
  | "ConstraintTypeInvalid"
  | "TargetValueMissing"
  | "ToleranceMissing"
  | "ToleranceInvalid"
  | "EvidenceMissing"
  | "UncertaintyExceedsTolerance"
  | "PolicyInvalid"
  | "NoSpatialProposals";

/**
 * Numeric or qualitative tolerance attached to a normalized constraint.
 */
export interface SpatialToleranceDescriptor {
  readonly tolerance_profile_ref: Ref;
  readonly tolerance_class: GeometryToleranceClass;
  readonly position_tolerance_m?: number;
  readonly orientation_tolerance_rad?: number;
  readonly distance_tolerance_m?: number;
  readonly clearance_margin_m?: number;
  readonly qualitative_threshold?: string;
  readonly uncertainty_must_be_below_tolerance: boolean;
}

/**
 * Target value for a normalized constraint. Relation constraints use explicit
 * axes and anchors; pose constraints carry frame-labeled position/orientation
 * fields.
 */
export interface SpatialConstraintTargetValue {
  readonly value_kind: "pose" | "relation" | "distance_range" | "region" | "axis" | "qualitative";
  readonly target_pose_ref?: Ref;
  readonly target_position_m?: Vector3;
  readonly target_orientation_ref?: Ref;
  readonly relation?: SpatialConstraintType;
  readonly reference_axis?: SignedAxis | "gravity_up";
  readonly reference_anchor_ref?: Ref;
  readonly distance_range_m?: readonly [number, number];
  readonly region_ref?: Ref;
  readonly qualitative_relation?: string;
}

/**
 * Gemini/task-parser proposal accepted by the normalizer.
 */
export interface CognitiveSpatialProposal {
  readonly proposal_ref: Ref;
  readonly task_ref?: Ref;
  readonly source: CognitiveSpatialProposalSource;
  readonly target_kind: CognitiveSpatialTargetKind;
  readonly subject_ref?: Ref;
  readonly subject_label?: string;
  readonly anchor_refs?: readonly Ref[];
  readonly anchor_labels?: readonly string[];
  readonly reference_frame_ref?: Ref;
  readonly relation?: SpatialConstraintType;
  readonly waypoint_m?: Vector3;
  readonly desired_pose_ref?: Ref;
  readonly desired_region_ref?: Ref;
  readonly distance_range_m?: readonly [number, number];
  readonly requested_axis?: SignedAxis | "gravity_up";
  readonly tolerance_class?: GeometryToleranceClass;
  readonly explicit_tolerance?: Partial<SpatialToleranceDescriptor>;
  readonly evidence_refs?: readonly Ref[];
  readonly safety_implications?: readonly string[];
  readonly natural_language_summary?: string;
}

/**
 * Runtime observation context that grounds proposal refs in current estimates.
 */
export interface CognitiveSpatialObservationContext {
  readonly context_ref: Ref;
  readonly convention_profile: GeometryConventionProfile;
  readonly pose_estimates: readonly CanonicalPoseEstimate[];
  readonly current_time_interval?: TimestampInterval;
  readonly default_reference_frame_ref?: Ref;
  readonly task_evidence_refs?: readonly Ref[];
}

/**
 * Normalizer policy for ambiguity handling and validator gating.
 */
export interface CognitiveSpatialNormalizerPolicy {
  readonly allow_default_reference_frame?: boolean;
  readonly default_reference_frame_ref?: Ref;
  readonly reject_hidden_identifiers?: boolean;
  readonly require_current_pose_for_precise_targets?: boolean;
  readonly require_explicit_tolerance?: boolean;
  readonly max_memory_pose_age_class?: "current" | "recent" | "stale";
  readonly min_pose_confidence_for_validator_ready?: number;
}

/**
 * Validator-ready spatial constraint descriptor.
 */
export interface SpatialConstraintDescriptor {
  readonly constraint_ref: Ref;
  readonly constraint_type: SpatialConstraintType;
  readonly subject_refs: readonly Ref[];
  readonly reference_frame: Ref;
  readonly target_value?: SpatialConstraintTargetValue;
  readonly tolerance: SpatialToleranceDescriptor;
  readonly evidence_requirements: readonly string[];
  readonly safety_implications: readonly string[];
  readonly source: CognitiveSpatialProposalSource;
  readonly residual_hint: string;
  readonly determinism_hash: string;
}

/**
 * File 10 target frame descriptor emitted by proposal normalization.
 */
export interface TargetFrameDescriptor {
  readonly target_frame_ref: Ref;
  readonly target_kind: CognitiveSpatialTargetKind;
  readonly anchor_refs: readonly Ref[];
  readonly reference_frame: Ref;
  readonly pose_or_relation: SpatialConstraintTargetValue;
  readonly tolerance_profile_ref: Ref;
  readonly evidence_refs: readonly Ref[];
  readonly uncertainty: TargetUncertaintyDescriptor;
  readonly validator_requirements: readonly ValidatorRequirement[];
  readonly lifecycle_state: TargetFrameLifecycleState;
  readonly constraints: readonly SpatialConstraintDescriptor[];
  readonly source_proposal_ref: Ref;
  readonly determinism_hash: string;
}

/**
 * Target uncertainty with an explicit validator-facing summary.
 */
export interface TargetUncertaintyDescriptor {
  readonly position_sigma_m?: number;
  readonly orientation_sigma_rad?: number;
  readonly uncertainty_class: PoseUncertaintyClass;
  readonly supporting_pose_refs: readonly Ref[];
  readonly ambiguity_reasons: readonly string[];
  readonly exceeds_tolerance: boolean;
  readonly summary: string;
}

/**
 * Full normalization report.
 */
export interface SpatialProposalNormalizationReport {
  readonly schema_version: typeof COGNITIVE_SPATIAL_NORMALIZER_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md";
  readonly normalization_ref: Ref;
  readonly context_ref: Ref;
  readonly normalized_target_frames: readonly TargetFrameDescriptor[];
  readonly rejected_proposal_refs: readonly Ref[];
  readonly decision: NormalizationDecision;
  readonly recommended_action: NormalizationRecommendedAction;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
  readonly cognitive_visibility: "spatial_proposal_normalization_report";
}

interface NormalizedPolicy {
  readonly allow_default_reference_frame: boolean;
  readonly default_reference_frame_ref: Ref;
  readonly reject_hidden_identifiers: boolean;
  readonly require_current_pose_for_precise_targets: boolean;
  readonly require_explicit_tolerance: boolean;
  readonly max_memory_pose_age_class: "current" | "recent" | "stale";
  readonly min_pose_confidence_for_validator_ready: number;
}

interface ResolvedProposal {
  readonly proposal: CognitiveSpatialProposal;
  readonly subject_refs: readonly Ref[];
  readonly anchor_refs: readonly Ref[];
  readonly reference_frame: Ref;
  readonly target_value: SpatialConstraintTargetValue;
  readonly tolerance: SpatialToleranceDescriptor;
  readonly evidence_refs: readonly Ref[];
  readonly uncertainty: TargetUncertaintyDescriptor;
  readonly constraints: readonly SpatialConstraintDescriptor[];
  readonly lifecycle_state: TargetFrameLifecycleState;
  readonly validator_requirements: readonly ValidatorRequirement[];
}

const DEFAULT_POLICY: NormalizedPolicy = Object.freeze({
  allow_default_reference_frame: true,
  default_reference_frame_ref: "W_hat",
  reject_hidden_identifiers: true,
  require_current_pose_for_precise_targets: true,
  require_explicit_tolerance: false,
  max_memory_pose_age_class: "recent",
  min_pose_confidence_for_validator_ready: 0.42,
});

/**
 * Executable File 10 `CognitiveSpatialNormalizer`.
 */
export class CognitiveSpatialNormalizer {
  private readonly policy: NormalizedPolicy;

  public constructor(policy: CognitiveSpatialNormalizerPolicy = {}) {
    this.policy = mergePolicy(DEFAULT_POLICY, policy);
  }

  /**
   * Converts cognitive spatial proposals into validator-ready target frames and
   * constraints with explicit frames, tolerances, uncertainty, and evidence.
   */
  public normalizeCognitiveSpatialProposal(
    proposals: readonly CognitiveSpatialProposal[],
    observationContext: CognitiveSpatialObservationContext,
    framePolicy: CognitiveSpatialNormalizerPolicy = {},
  ): SpatialProposalNormalizationReport {
    const policy = mergePolicy(this.policy, framePolicy);
    const issues: ValidationIssue[] = [];
    validateContext(observationContext, policy, issues);
    if (proposals.length === 0) {
      issues.push(makeIssue("error", "NoSpatialProposals", "$.proposals", "CognitiveSpatialNormalizer requires at least one spatial proposal.", "Provide Gemini, task template, human instruction, validator feedback, or verification policy proposals."));
    }

    const resolved = proposals
      .map((proposal, index) => resolveProposal(proposal, index, observationContext, policy, issues))
      .filter(isResolvedProposal);
    const targetFrames = resolved.map((item) => buildTargetFrame(item));
    const rejected = proposals
      .filter((proposal) => !targetFrames.some((frame) => frame.source_proposal_ref === sanitizeRef(proposal.proposal_ref)))
      .map((proposal) => sanitizeRef(proposal.proposal_ref || "proposal_ref_missing"))
      .sort();
    const decision = decideNormalization(targetFrames, rejected, issues);
    const recommendedAction = chooseRecommendedAction(issues, decision, targetFrames);
    const normalizationRef = makeRef("spatial_proposal_normalization", observationContext.context_ref, decision);

    return Object.freeze({
      schema_version: COGNITIVE_SPATIAL_NORMALIZER_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md",
      normalization_ref: normalizationRef,
      context_ref: observationContext.context_ref,
      normalized_target_frames: freezeArray(targetFrames),
      rejected_proposal_refs: freezeArray(rejected),
      decision,
      recommended_action: recommendedAction,
      issues: freezeArray(issues),
      ok: decision === "normalized" || decision === "normalized_with_warnings",
      determinism_hash: computeDeterminismHash({
        normalizationRef,
        context: observationContext.context_ref,
        targets: targetFrames.map((frame) => [frame.target_frame_ref, frame.lifecycle_state, frame.constraints.map((constraint) => constraint.constraint_type)]),
        rejected,
        issueCodes: issues.map((issue) => issue.code).sort(),
        decision,
      }),
      cognitive_visibility: "spatial_proposal_normalization_report",
    });
  }
}

/**
 * Functional API for File 10 cognitive proposal normalization.
 */
export function normalizeCognitiveSpatialProposal(
  proposals: readonly CognitiveSpatialProposal[],
  observationContext: CognitiveSpatialObservationContext,
  framePolicy: CognitiveSpatialNormalizerPolicy = {},
): SpatialProposalNormalizationReport {
  return new CognitiveSpatialNormalizer(framePolicy).normalizeCognitiveSpatialProposal(proposals, observationContext, framePolicy);
}

function resolveProposal(
  proposal: CognitiveSpatialProposal,
  index: number,
  context: CognitiveSpatialObservationContext,
  policy: NormalizedPolicy,
  issues: ValidationIssue[],
): ResolvedProposal | undefined {
  const path = `$.proposals[${index}]`;
  const localIssues: ValidationIssue[] = [];
  validateProposalShell(proposal, path, policy, localIssues);
  const subjectRefs = resolveSubjectRefs(proposal, context, path, localIssues);
  const anchorRefs = resolveAnchorRefs(proposal, context, path, localIssues);
  const relation = proposal.relation ?? inferRelation(proposal.natural_language_summary);
  const referenceFrame = resolveReferenceFrame(proposal, context, policy, relation, path, localIssues);
  const tolerance = resolveTolerance(proposal, relation, context.convention_profile, policy, path, localIssues);
  const evidenceRefs = resolveEvidenceRefs(proposal, context, subjectRefs, anchorRefs, path, localIssues);
  const targetValue = resolveTargetValue(proposal, relation, subjectRefs, anchorRefs, referenceFrame, context, path, localIssues);
  const uncertainty = buildTargetUncertainty(subjectRefs, anchorRefs, context, tolerance, path, localIssues);
  const validatorRequirements = chooseValidatorRequirements(proposal, relation, tolerance, uncertainty);
  const lifecycle = chooseLifecycleState(localIssues, uncertainty, evidenceRefs, validatorRequirements, policy);
  const constraints = buildConstraints(proposal, subjectRefs, anchorRefs, referenceFrame, targetValue, tolerance, evidenceRefs, validatorRequirements);

  issues.push(...localIssues);
  if (localIssues.some((issue) => issue.severity === "error")) return undefined;
  return Object.freeze({
    proposal,
    subject_refs: freezeArray(subjectRefs),
    anchor_refs: freezeArray(anchorRefs),
    reference_frame: referenceFrame,
    target_value: targetValue,
    tolerance,
    evidence_refs: freezeArray(evidenceRefs),
    uncertainty,
    constraints: freezeArray(constraints),
    lifecycle_state: lifecycle,
    validator_requirements: freezeArray(validatorRequirements),
  });
}

function buildTargetFrame(resolved: ResolvedProposal): TargetFrameDescriptor {
  const targetFrameRef = makeRef("target_frame", resolved.proposal.target_kind, resolved.proposal.proposal_ref);
  const shell = {
    targetFrameRef,
    anchors: resolved.anchor_refs,
    reference: resolved.reference_frame,
    relation: resolved.target_value,
    tolerance: resolved.tolerance,
    lifecycle: resolved.lifecycle_state,
    constraints: resolved.constraints.map((constraint) => constraint.constraint_ref),
  };
  return Object.freeze({
    target_frame_ref: targetFrameRef,
    target_kind: resolved.proposal.target_kind,
    anchor_refs: resolved.anchor_refs,
    reference_frame: resolved.reference_frame,
    pose_or_relation: resolved.target_value,
    tolerance_profile_ref: resolved.tolerance.tolerance_profile_ref,
    evidence_refs: resolved.evidence_refs,
    uncertainty: resolved.uncertainty,
    validator_requirements: resolved.validator_requirements,
    lifecycle_state: resolved.lifecycle_state,
    constraints: resolved.constraints,
    source_proposal_ref: sanitizeRef(resolved.proposal.proposal_ref),
    determinism_hash: computeDeterminismHash(shell),
  });
}

function buildConstraints(
  proposal: CognitiveSpatialProposal,
  subjectRefs: readonly Ref[],
  anchorRefs: readonly Ref[],
  referenceFrame: Ref,
  targetValue: SpatialConstraintTargetValue,
  tolerance: SpatialToleranceDescriptor,
  evidenceRefs: readonly Ref[],
  validatorRequirements: readonly ValidatorRequirement[],
): readonly SpatialConstraintDescriptor[] {
  const constraints: SpatialConstraintDescriptor[] = [];
  const primaryType = proposal.relation ?? constraintTypeForTargetKind(proposal.target_kind, targetValue);
  constraints.push(makeConstraint(primaryType, proposal, subjectRefs, anchorRefs, referenceFrame, targetValue, tolerance, evidenceRefs, validatorRequirements));
  if (proposal.target_kind === "tool_contact") {
    constraints.push(makeConstraint("tool_envelope", proposal, subjectRefs, anchorRefs, referenceFrame, { value_kind: "qualitative", qualitative_relation: "tool swept volume must stay clear of forbidden obstacles" }, tolerance, evidenceRefs, validatorRequirements));
  }
  if (proposal.safety_implications !== undefined && proposal.safety_implications.length > 0) {
    constraints.push(makeConstraint("clearance", proposal, subjectRefs, anchorRefs, referenceFrame, { value_kind: "qualitative", qualitative_relation: "safety clearance required by proposal" }, tolerance, evidenceRefs, validatorRequirements));
  }
  return freezeArray(constraints.sort((a, b) => a.constraint_ref.localeCompare(b.constraint_ref)));
}

function makeConstraint(
  constraintType: SpatialConstraintType,
  proposal: CognitiveSpatialProposal,
  subjectRefs: readonly Ref[],
  anchorRefs: readonly Ref[],
  referenceFrame: Ref,
  targetValue: SpatialConstraintTargetValue,
  tolerance: SpatialToleranceDescriptor,
  evidenceRefs: readonly Ref[],
  validatorRequirements: readonly ValidatorRequirement[],
): SpatialConstraintDescriptor {
  const constraintRef = makeRef("spatial_constraint", proposal.proposal_ref, constraintType);
  const safety = uniqueSorted([...(proposal.safety_implications ?? []), ...safetyForConstraint(constraintType)]);
  const evidenceRequirements = evidenceRequirementsForConstraint(constraintType, validatorRequirements);
  const shell = {
    constraintRef,
    type: constraintType,
    subjects: subjectRefs,
    anchors: anchorRefs,
    referenceFrame,
    targetValue,
    tolerance,
    evidenceRefs,
  };
  return Object.freeze({
    constraint_ref: constraintRef,
    constraint_type: constraintType,
    subject_refs: freezeArray(subjectRefs),
    reference_frame: referenceFrame,
    target_value: targetValue,
    tolerance,
    evidence_requirements: freezeArray(evidenceRequirements),
    safety_implications: freezeArray(safety),
    source: proposal.source,
    residual_hint: residualHintForConstraint(constraintType, targetValue, tolerance),
    determinism_hash: computeDeterminismHash(shell),
  });
}

function resolveSubjectRefs(
  proposal: CognitiveSpatialProposal,
  context: CognitiveSpatialObservationContext,
  path: string,
  issues: ValidationIssue[],
): readonly Ref[] {
  const refs = [
    ...(proposal.subject_ref === undefined ? [] : [proposal.subject_ref]),
    ...(proposal.subject_label === undefined ? [] : poseRefsForLabel(proposal.subject_label, context)),
  ].map(sanitizeRef);
  const unique = uniqueSorted(refs);
  if (unique.length === 0) {
    issues.push(makeIssue("error", "SubjectMissing", `${path}.subject_ref`, "Spatial proposal lacks a resolvable subject.", "Reference a current object, end effector, tool, support, or target pose."));
  }
  return freezeArray(unique);
}

function resolveAnchorRefs(
  proposal: CognitiveSpatialProposal,
  context: CognitiveSpatialObservationContext,
  path: string,
  issues: ValidationIssue[],
): readonly Ref[] {
  const refs = [
    ...(proposal.anchor_refs ?? []),
    ...(proposal.anchor_labels ?? []).flatMap((label) => poseRefsForLabel(label, context)),
  ].map(sanitizeRef);
  const unique = uniqueSorted(refs);
  const relation = proposal.relation ?? inferRelation(proposal.natural_language_summary);
  if (relationRequiresAnchor(relation) && unique.length === 0) {
    issues.push(makeIssue("error", "AnchorMissing", `${path}.anchor_refs`, "Relation proposal lacks a resolvable anchor.", "Attach an anchor object, support, body, tool, or task frame."));
  }
  return freezeArray(unique);
}

function resolveReferenceFrame(
  proposal: CognitiveSpatialProposal,
  context: CognitiveSpatialObservationContext,
  policy: NormalizedPolicy,
  relation: SpatialConstraintType | undefined,
  path: string,
  issues: ValidationIssue[],
): Ref {
  const requested = proposal.reference_frame_ref ?? context.default_reference_frame_ref ?? policy.default_reference_frame_ref;
  const relationRule = ruleForRelation(relation, context.convention_profile);
  if (proposal.reference_frame_ref === undefined && relationRule?.required_reference_frame === true && !policy.allow_default_reference_frame) {
    issues.push(makeIssue("error", "ReferenceFrameMissing", `${path}.reference_frame_ref`, relationRule.ambiguity_if_missing, "Provide an explicit reference frame for this relation."));
  }
  if (proposal.reference_frame_ref === undefined && relationRule?.required_reference_frame === true && policy.allow_default_reference_frame) {
    issues.push(makeIssue("warning", "AmbiguousReferenceAxis", `${path}.reference_frame_ref`, `No explicit reference frame supplied; defaulting to ${requested}.`, "Prefer explicit frame labels for left/right/front/behind/alignment relations."));
  }
  validateFrameRef(requested, `${path}.reference_frame_ref`, issues);
  return sanitizeRef(requested);
}

function resolveTolerance(
  proposal: CognitiveSpatialProposal,
  relation: SpatialConstraintType | undefined,
  profile: GeometryConventionProfile,
  policy: NormalizedPolicy,
  path: string,
  issues: ValidationIssue[],
): SpatialToleranceDescriptor {
  const toleranceClass = proposal.tolerance_class ?? toleranceClassForProposal(proposal, relation, profile);
  const profileTolerance = profile.tolerance_profiles.find((item) => item.tolerance_class === toleranceClass);
  if (profileTolerance === undefined) {
    issues.push(makeIssue("error", "ToleranceMissing", `${path}.tolerance_class`, `Tolerance class ${toleranceClass} is not registered.`, "Register the File 10 tolerance profile before normalization."));
    return fallbackTolerance(toleranceClass);
  }
  if (policy.require_explicit_tolerance && proposal.explicit_tolerance === undefined) {
    issues.push(makeIssue("error", "ToleranceMissing", `${path}.explicit_tolerance`, "Policy requires explicit tolerance for this proposal.", "Attach position, orientation, distance, clearance, or qualitative tolerance."));
  }
  const merged = Object.freeze({
    tolerance_profile_ref: sanitizeRef(proposal.explicit_tolerance?.tolerance_profile_ref ?? profileTolerance.tolerance_profile_ref),
    tolerance_class: proposal.explicit_tolerance?.tolerance_class ?? profileTolerance.tolerance_class,
    position_tolerance_m: positiveOrUndefined(proposal.explicit_tolerance?.position_tolerance_m ?? profileTolerance.position_tolerance_m),
    orientation_tolerance_rad: positiveOrUndefined(proposal.explicit_tolerance?.orientation_tolerance_rad ?? profileTolerance.orientation_tolerance_rad),
    distance_tolerance_m: positiveOrUndefined(proposal.explicit_tolerance?.distance_tolerance_m ?? profileTolerance.distance_tolerance_m),
    clearance_margin_m: positiveOrUndefined(proposal.explicit_tolerance?.clearance_margin_m ?? profileTolerance.clearance_margin_m),
    qualitative_threshold: proposal.explicit_tolerance?.qualitative_threshold,
    uncertainty_must_be_below_tolerance: proposal.explicit_tolerance?.uncertainty_must_be_below_tolerance ?? profileTolerance.uncertainty_must_be_below_tolerance,
  });
  validateTolerance(merged, path, issues);
  return merged;
}

function resolveEvidenceRefs(
  proposal: CognitiveSpatialProposal,
  context: CognitiveSpatialObservationContext,
  subjectRefs: readonly Ref[],
  anchorRefs: readonly Ref[],
  path: string,
  issues: ValidationIssue[],
): readonly Ref[] {
  const poseEvidence = [...subjectRefs, ...anchorRefs]
    .flatMap((ref) => poseForRef(ref, context)?.evidence_refs ?? []);
  const refs = uniqueSorted([...(proposal.evidence_refs ?? []), ...(context.task_evidence_refs ?? []), ...poseEvidence].map(sanitizeRef));
  if (refs.length === 0) {
    issues.push(makeIssue("error", "EvidenceMissing", `${path}.evidence_refs`, "Spatial proposal lacks evidence refs.", "Attach sensor, memory, task, contact, depth, or telemetry evidence."));
  }
  return freezeArray(refs);
}

function resolveTargetValue(
  proposal: CognitiveSpatialProposal,
  relation: SpatialConstraintType | undefined,
  subjectRefs: readonly Ref[],
  anchorRefs: readonly Ref[],
  referenceFrame: Ref,
  context: CognitiveSpatialObservationContext,
  path: string,
  issues: ValidationIssue[],
): SpatialConstraintTargetValue {
  const rule = ruleForRelation(relation, context.convention_profile);
  if (proposal.waypoint_m !== undefined) {
    validateVector3(proposal.waypoint_m, `${path}.waypoint_m`, issues);
    return Object.freeze({
      value_kind: "pose",
      target_pose_ref: proposal.desired_pose_ref === undefined ? undefined : sanitizeRef(proposal.desired_pose_ref),
      target_position_m: freezeVector3(proposal.waypoint_m),
    });
  }
  if (proposal.distance_range_m !== undefined) {
    validateDistanceRange(proposal.distance_range_m, `${path}.distance_range_m`, issues);
    return Object.freeze({
      value_kind: "distance_range",
      relation: "relative_distance",
      reference_anchor_ref: anchorRefs[0],
      distance_range_m: freezeArray([round6(proposal.distance_range_m[0]), round6(proposal.distance_range_m[1])]) as readonly [number, number],
    });
  }
  if (proposal.desired_region_ref !== undefined) {
    return Object.freeze({
      value_kind: "region",
      region_ref: sanitizeRef(proposal.desired_region_ref),
      relation,
      reference_anchor_ref: anchorRefs[0],
    });
  }
  if (relation !== undefined) {
    const axis = proposal.requested_axis ?? rule?.required_axis;
    if (axis === undefined && relationNeedsAxis(relation)) {
      issues.push(makeIssue("error", "AmbiguousReferenceAxis", `${path}.requested_axis`, `Relation ${relation} requires an explicit reference axis.`, "Attach requested_axis or use a convention task-language rule."));
    }
    return Object.freeze({
      value_kind: "relation",
      relation,
      reference_axis: axis,
      reference_anchor_ref: anchorRefs[0],
      qualitative_relation: proposal.natural_language_summary === undefined ? relation : sanitizeText(proposal.natural_language_summary),
    });
  }
  if (subjectRefs.length === 0) {
    issues.push(makeIssue("error", "TargetValueMissing", path, "Proposal lacks waypoint, relation, region, distance range, or resolvable subject.", "Provide an explicit spatial target value."));
  }
  return Object.freeze({
    value_kind: "qualitative",
    qualitative_relation: proposal.natural_language_summary === undefined ? `target_kind=${proposal.target_kind} in ${referenceFrame}` : sanitizeText(proposal.natural_language_summary),
  });
}

function buildTargetUncertainty(
  subjectRefs: readonly Ref[],
  anchorRefs: readonly Ref[],
  context: CognitiveSpatialObservationContext,
  tolerance: SpatialToleranceDescriptor,
  path: string,
  issues: ValidationIssue[],
): TargetUncertaintyDescriptor {
  const poses = [...subjectRefs, ...anchorRefs].map((ref) => poseForRef(ref, context)).filter(isPose);
  for (const ref of [...subjectRefs, ...anchorRefs]) {
    if (poseForRef(ref, context) === undefined) {
      issues.push(makeIssue("warning", "PoseMissing", `${path}.pose_estimates`, `No canonical pose found for ${ref}.`, "Reobserve or estimate the anchor before validator-ready normalization."));
    }
  }
  for (const pose of poses) {
    if (pose.staleness_status === "stale" || pose.staleness_status === "contradicted") {
      issues.push(makeIssue(pose.staleness_status === "contradicted" ? "error" : "warning", "PoseStale", `${path}.pose_estimates.${pose.pose_ref}`, `Pose ${pose.pose_ref} is ${pose.staleness_status}.`, "Reobserve before using stale or contradicted geometry."));
    }
  }
  const positionSigma = combineSigma(poses.map((pose) => pose.uncertainty.position_sigma_m).filter(isNumber));
  const orientationSigma = combineSigma(poses.map((pose) => pose.uncertainty.orientation_sigma_rad).filter(isNumber));
  const uncertaintyClass = chooseUncertaintyClass(poses, positionSigma);
  const toleranceLimit = tolerance.position_tolerance_m ?? tolerance.distance_tolerance_m ?? tolerance.clearance_margin_m;
  const exceedsTolerance = tolerance.uncertainty_must_be_below_tolerance && toleranceLimit !== undefined && positionSigma !== undefined && positionSigma > toleranceLimit;
  if (exceedsTolerance) {
    issues.push(makeIssue("warning", "UncertaintyExceedsTolerance", `${path}.uncertainty`, "Target uncertainty exceeds selected tolerance.", "Use broader tolerance, reobserve, or keep result ambiguous."));
  }
  const ambiguityReasons = poses
    .filter((pose) => pose.confidence_class === "search_only" || pose.staleness_status !== "current")
    .map((pose) => `${pose.pose_ref}:${pose.confidence_class}:${pose.staleness_status}`);
  return Object.freeze({
    position_sigma_m: positionSigma,
    orientation_sigma_rad: orientationSigma,
    uncertainty_class: uncertaintyClass,
    supporting_pose_refs: freezeArray(poses.map((pose) => pose.pose_ref).sort()),
    ambiguity_reasons: freezeArray(ambiguityReasons),
    exceeds_tolerance: exceedsTolerance,
    summary: summarizeUncertainty(positionSigma, orientationSigma, uncertaintyClass, exceedsTolerance, ambiguityReasons),
  });
}

function chooseValidatorRequirements(
  proposal: CognitiveSpatialProposal,
  relation: SpatialConstraintType | undefined,
  tolerance: SpatialToleranceDescriptor,
  uncertainty: TargetUncertaintyDescriptor,
): readonly ValidatorRequirement[] {
  const requirements = new Set<ValidatorRequirement>(["geometry"]);
  if (proposal.target_kind === "approach" || proposal.target_kind === "grasp" || proposal.target_kind === "placement" || proposal.target_kind === "tool_contact") {
    requirements.add("reach");
    requirements.add("collision");
    requirements.add("ik");
    requirements.add("controller_feasibility");
  }
  if (proposal.target_kind === "verification" || relation === "inside" || relation === "on_top_of" || tolerance.tolerance_class === "verification_visual") requirements.add("verification_view");
  if (relation === "on_top_of" || proposal.target_kind === "grasp" || proposal.target_kind === "tool_contact") requirements.add("contact");
  if (relation === "stability" || proposal.target_kind === "placement") requirements.add("stability");
  if (proposal.target_kind === "tool_contact") requirements.add("tool_swept_volume");
  if (uncertainty.ambiguity_reasons.some((reason) => /memory|search_only|stale/u.test(reason))) requirements.add("memory_currentness");
  return freezeArray([...requirements].sort());
}

function chooseLifecycleState(
  issues: readonly ValidationIssue[],
  uncertainty: TargetUncertaintyDescriptor,
  evidenceRefs: readonly Ref[],
  validatorRequirements: readonly ValidatorRequirement[],
  policy: NormalizedPolicy,
): TargetFrameLifecycleState {
  if (issues.some((issue) => issue.severity === "error")) return "invalidated";
  if (uncertainty.exceeds_tolerance || evidenceRefs.length === 0) return "estimated";
  if (uncertainty.ambiguity_reasons.length > 0) return "estimated";
  if (validatorRequirements.includes("ik") && (uncertainty.position_sigma_m ?? 1) <= 0.035 && policy.min_pose_confidence_for_validator_ready >= 0) return "control_candidate";
  return "validator_ready";
}

function validateContext(context: CognitiveSpatialObservationContext, policy: NormalizedPolicy, issues: ValidationIssue[]): void {
  validateSafeRef(context.context_ref, "$.context.context_ref", "ProposalRefInvalid", issues);
  validateFrameRef(policy.default_reference_frame_ref, "$.policy.default_reference_frame_ref", issues);
  if (context.convention_profile.blueprint_ref !== "architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md") {
    issues.push(makeIssue("error", "PolicyInvalid", "$.context.convention_profile", "Convention profile is not a File 10 geometry profile.", "Use GeometryConventionRegistry output from File 10."));
  }
  for (const pose of context.pose_estimates) {
    validateNoHiddenText(`${pose.pose_ref} ${pose.frame_ref} ${pose.subject_ref}`, "$.context.pose_estimates", policy, issues);
    if (isTruthFrameRef(pose.frame_ref)) {
      issues.push(makeIssue("error", "TruthFrameBlocked", `$.context.pose_estimates.${pose.pose_ref}.frame_ref`, "Context pose uses simulator or QA truth frame.", "Use W_hat or a declared estimated frame."));
    }
  }
}

function validateProposalShell(
  proposal: CognitiveSpatialProposal,
  path: string,
  policy: NormalizedPolicy,
  issues: ValidationIssue[],
): void {
  validateSafeRef(proposal.proposal_ref, `${path}.proposal_ref`, "ProposalRefInvalid", issues);
  validateNoHiddenText(JSON.stringify(proposal), path, policy, issues);
  if (proposal.reference_frame_ref !== undefined) validateFrameRef(proposal.reference_frame_ref, `${path}.reference_frame_ref`, issues);
  if (proposal.subject_ref !== undefined) validateSafeRef(proposal.subject_ref, `${path}.subject_ref`, "SubjectMissing", issues);
  for (const [index, anchor] of (proposal.anchor_refs ?? []).entries()) validateSafeRef(anchor, `${path}.anchor_refs[${index}]`, "AnchorMissing", issues);
  if (proposal.relation !== undefined && !isConstraintType(proposal.relation)) {
    issues.push(makeIssue("error", "ConstraintTypeInvalid", `${path}.relation`, "Proposal relation is not an approved File 10 constraint type.", "Use position, orientation, relative_distance, left_of, right_of, on_top_of, inside, alignment, clearance, stability, or tool_envelope."));
  }
}

function validateTolerance(tolerance: SpatialToleranceDescriptor, path: string, issues: ValidationIssue[]): void {
  const values = [tolerance.position_tolerance_m, tolerance.orientation_tolerance_rad, tolerance.distance_tolerance_m, tolerance.clearance_margin_m].filter(isNumber);
  if (values.length === 0 && tolerance.qualitative_threshold === undefined) {
    issues.push(makeIssue("error", "ToleranceMissing", `${path}.tolerance`, "Constraint tolerance must include numeric or qualitative threshold.", "Attach a File 10 tolerance profile or explicit tolerance."));
  }
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
    issues.push(makeIssue("error", "ToleranceInvalid", `${path}.tolerance`, "Tolerance numeric values must be positive finite values.", "Use positive meters or radians."));
  }
}

function validateDistanceRange(value: readonly [number, number], path: string, issues: ValidationIssue[]): void {
  if (!Number.isFinite(value[0]) || !Number.isFinite(value[1]) || value[0] < 0 || value[1] < value[0]) {
    issues.push(makeIssue("error", "TargetValueMissing", path, "Distance range must be finite, nonnegative, and ordered.", "Use [min_m, max_m]."));
  }
}

function validateVector3(value: Vector3, path: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(value) || value.length !== 3 || value.some((component) => !Number.isFinite(component))) {
    issues.push(makeIssue("error", "TargetValueMissing", path, "Waypoint must contain exactly three finite meter values.", "Use [x, y, z] in the declared reference frame."));
  }
}

function validateFrameRef(frameRef: Ref, path: string, issues: ValidationIssue[]): void {
  validateSafeRef(frameRef, path, "ReferenceFrameMissing", issues);
  if (isTruthFrameRef(frameRef)) {
    issues.push(makeIssue("error", "TruthFrameBlocked", path, "Reference frame uses simulator or QA truth.", "Use W_hat, body, object, target, tool, contact, or sensor-derived frames."));
  }
}

function validateSafeRef(value: Ref, path: string, code: CognitiveSpatialIssueCode, issues: ValidationIssue[]): void {
  if (value.trim().length === 0 || /\s/u.test(value)) {
    issues.push(makeIssue("error", code, path, "Reference must be non-empty and whitespace-free.", "Use an opaque sanitized ref."));
  }
  if (HIDDEN_SPATIAL_PATTERN.test(value)) {
    issues.push(makeIssue("error", "HiddenSpatialLeak", path, "Reference contains hidden simulator/backend/QA wording.", "Use local cognitive-safe refs."));
  }
}

function validateNoHiddenText(value: string, path: string, policy: NormalizedPolicy, issues: ValidationIssue[]): void {
  if (policy.reject_hidden_identifiers && HIDDEN_SPATIAL_PATTERN.test(value)) {
    issues.push(makeIssue("error", "HiddenSpatialLeak", path, "Spatial proposal contains hidden simulator/backend/QA wording.", "Remove hidden identifiers before normalization."));
  }
}

function inferRelation(summary: string | undefined): SpatialConstraintType | undefined {
  if (summary === undefined) return undefined;
  const normalized = summary.toLowerCase();
  if (/\bleft of\b|\bleft_of\b/u.test(normalized)) return "left_of";
  if (/\bright of\b|\bright_of\b/u.test(normalized)) return "right_of";
  if (/\bon top of\b|\bon_top_of\b/u.test(normalized)) return "on_top_of";
  if (/\binside\b|\bin\b/u.test(normalized)) return "inside";
  if (/\bnear\b|\bclose\b/u.test(normalized)) return "relative_distance";
  if (/\balign|aligned\b/u.test(normalized)) return "alignment";
  if (/\bupright|stable\b/u.test(normalized)) return "stability";
  if (/\bclear|avoid|away\b/u.test(normalized)) return "clearance";
  return undefined;
}

function ruleForRelation(relation: SpatialConstraintType | undefined, profile: GeometryConventionProfile): GeometryTaskLanguageRule | undefined {
  const term = relationToLanguageTerm(relation);
  return term === undefined ? undefined : profile.task_language_rules.find((rule) => rule.term === term);
}

function relationToLanguageTerm(relation: SpatialConstraintType | undefined): GeometryTaskLanguageRule["term"] | undefined {
  if (relation === "left_of" || relation === "right_of" || relation === "inside" || relation === "on_top_of") return relation;
  if (relation === "alignment") return "aligned";
  if (relation === "relative_distance") return "near";
  if (relation === "stability") return "upright";
  return undefined;
}

function toleranceClassForProposal(
  proposal: CognitiveSpatialProposal,
  relation: SpatialConstraintType | undefined,
  profile: GeometryConventionProfile,
): GeometryToleranceClass {
  const rule = ruleForRelation(relation, profile);
  if (rule !== undefined) return rule.default_tolerance_class;
  if (proposal.target_kind === "approach") return "approach";
  if (proposal.target_kind === "grasp") return "grasp_candidate";
  if (proposal.target_kind === "verification") return "verification_visual";
  if (proposal.target_kind === "tool_contact" || relation === "clearance" || relation === "tool_envelope") return "safety_clearance";
  if (proposal.target_kind === "placement") return "placement_standard";
  return "coarse_search";
}

function constraintTypeForTargetKind(kind: CognitiveSpatialTargetKind, targetValue: SpatialConstraintTargetValue): SpatialConstraintType {
  if (targetValue.value_kind === "pose") return "position";
  if (kind === "verification") return "position";
  if (kind === "tool_contact") return "tool_envelope";
  if (kind === "safe_hold" || kind === "retreat") return "clearance";
  return "position";
}

function relationRequiresAnchor(relation: SpatialConstraintType | undefined): boolean {
  return relation === "left_of" || relation === "right_of" || relation === "relative_distance" || relation === "on_top_of" || relation === "inside" || relation === "alignment" || relation === "clearance";
}

function relationNeedsAxis(relation: SpatialConstraintType): boolean {
  return relation === "left_of" || relation === "right_of" || relation === "alignment" || relation === "stability";
}

function poseRefsForLabel(label: string, context: CognitiveSpatialObservationContext): readonly Ref[] {
  const target = makeRef(label);
  return freezeArray(context.pose_estimates
    .filter((pose) => makeRef(pose.subject_ref) === target || makeRef(pose.pose_ref).includes(target))
    .map((pose) => pose.subject_ref)
    .sort());
}

function poseForRef(ref: Ref, context: CognitiveSpatialObservationContext): CanonicalPoseEstimate | undefined {
  const normalized = makeRef(ref);
  return context.pose_estimates.find((pose) => makeRef(pose.pose_ref) === normalized || makeRef(pose.subject_ref) === normalized);
}

function evidenceRequirementsForConstraint(
  constraintType: SpatialConstraintType,
  validatorRequirements: readonly ValidatorRequirement[],
): readonly string[] {
  const evidence = new Set<string>(["pose_estimate", "frame_label", "tolerance"]);
  if (constraintType === "inside") {
    evidence.add("container_boundary_estimate");
    evidence.add("rim_or_depth_view");
  }
  if (constraintType === "on_top_of") {
    evidence.add("support_surface_estimate");
    evidence.add("contact_or_depth_evidence");
  }
  if (constraintType === "left_of" || constraintType === "right_of" || constraintType === "alignment") evidence.add("reference_axis");
  if (validatorRequirements.includes("verification_view")) evidence.add("verification_view");
  if (validatorRequirements.includes("contact")) evidence.add("contact_evidence");
  if (validatorRequirements.includes("tool_swept_volume")) evidence.add("tool_geometry");
  return freezeArray([...evidence].sort());
}

function safetyForConstraint(constraintType: SpatialConstraintType): readonly string[] {
  if (constraintType === "clearance" || constraintType === "tool_envelope") return freezeArray(["collision_margin_required", "safe_hold_if_margin_unknown"]);
  if (constraintType === "stability" || constraintType === "on_top_of") return freezeArray(["stability_check_required"]);
  if (constraintType === "inside") return freezeArray(["containment_ambiguity_requires_reobserve"]);
  return freezeArray([]);
}

function residualHintForConstraint(
  constraintType: SpatialConstraintType,
  targetValue: SpatialConstraintTargetValue,
  tolerance: SpatialToleranceDescriptor,
): string {
  const position = tolerance.position_tolerance_m === undefined ? "" : ` position<=${formatNumber(tolerance.position_tolerance_m)}m`;
  const distanceValue = tolerance.distance_tolerance_m === undefined ? "" : ` distance<=${formatNumber(tolerance.distance_tolerance_m)}m`;
  if (constraintType === "left_of" || constraintType === "right_of") return `signed projection along ${targetValue.reference_axis ?? "reference_axis"} with${position || distanceValue || " explicit tolerance"}`;
  if (constraintType === "relative_distance") return `norm distance within ${targetValue.distance_range_m?.join("..") ?? "declared range"}m`;
  if (constraintType === "on_top_of") return "height/support/contact residual against support anchor";
  if (constraintType === "inside") return "containment residual against container boundary and rim evidence";
  if (constraintType === "orientation" || constraintType === "stability") return `angular residual${tolerance.orientation_tolerance_rad === undefined ? "" : `<=${formatNumber(tolerance.orientation_tolerance_rad)}rad`}`;
  if (constraintType === "clearance" || constraintType === "tool_envelope") return `minimum clearance${tolerance.clearance_margin_m === undefined ? "" : `>=${formatNumber(tolerance.clearance_margin_m)}m`}`;
  return `position residual${position}`;
}

function decideNormalization(
  targetFrames: readonly TargetFrameDescriptor[],
  rejected: readonly Ref[],
  issues: readonly ValidationIssue[],
): NormalizationDecision {
  if (issues.some((issue) => issue.code === "NoSpatialProposals" || issue.code === "HiddenSpatialLeak" || issue.code === "TruthFrameBlocked" || issue.code === "PolicyInvalid")) return "rejected";
  if (targetFrames.length === 0 && rejected.length > 0) return "rejected";
  if (issues.some((issue) => issue.code === "AmbiguousReferenceAxis" || issue.code === "ReferenceFrameMissing" || issue.code === "AnchorMissing" || issue.code === "SubjectMissing") && issues.some((issue) => issue.severity === "error")) return "needs_clarification";
  if (rejected.length > 0 || targetFrames.some((frame) => frame.lifecycle_state === "estimated") || issues.some((issue) => issue.severity === "warning")) return "normalized_with_warnings";
  return "normalized";
}

function chooseRecommendedAction(
  issues: readonly ValidationIssue[],
  decision: NormalizationDecision,
  targetFrames: readonly TargetFrameDescriptor[],
): NormalizationRecommendedAction {
  if (decision === "normalized" && targetFrames.every((frame) => frame.lifecycle_state === "validator_ready" || frame.lifecycle_state === "control_candidate")) return "run_validators";
  if (issues.some((issue) => issue.code === "HiddenSpatialLeak" || issue.code === "TruthFrameBlocked")) return "repair_truth_boundary";
  if (issues.some((issue) => issue.code === "ReferenceFrameMissing" || issue.code === "AmbiguousReferenceAxis")) return "repair_reference_frame";
  if (issues.some((issue) => issue.code === "ToleranceMissing" || issue.code === "ToleranceInvalid" || issue.code === "UncertaintyExceedsTolerance")) return "repair_tolerance";
  if (decision === "needs_clarification" || issues.some((issue) => issue.code === "SubjectMissing" || issue.code === "AnchorMissing" || issue.code === "TargetValueMissing")) return "ask_clarification";
  if (issues.some((issue) => issue.code === "PoseMissing" || issue.code === "PoseStale" || issue.code === "EvidenceMissing")) return "reobserve";
  return "safe_hold";
}

function fallbackTolerance(toleranceClass: GeometryToleranceClass): SpatialToleranceDescriptor {
  return Object.freeze({
    tolerance_profile_ref: makeRef("missing_tolerance_profile", toleranceClass),
    tolerance_class: toleranceClass,
    qualitative_threshold: "missing registered tolerance profile",
    uncertainty_must_be_below_tolerance: true,
  });
}

function combineSigma(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  return round6(Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)));
}

function chooseUncertaintyClass(poses: readonly CanonicalPoseEstimate[], positionSigma: number | undefined): PoseUncertaintyClass {
  if (poses.length === 0 || positionSigma === undefined) return "unknown";
  if (poses.some((pose) => pose.uncertainty.position_uncertainty_class === "qualitative")) return "qualitative";
  if (positionSigma <= 0.02) return "precise";
  if (positionSigma <= 0.08) return "bounded";
  return "broad";
}

function summarizeUncertainty(
  positionSigma: number | undefined,
  orientationSigma: number | undefined,
  uncertaintyClass: PoseUncertaintyClass,
  exceedsTolerance: boolean,
  ambiguityReasons: readonly string[],
): string {
  const position = positionSigma === undefined ? "position_sigma=unknown" : `position_sigma_m=${formatNumber(positionSigma)}`;
  const orientation = orientationSigma === undefined ? "orientation_sigma=unknown" : `orientation_sigma_rad=${formatNumber(orientationSigma)}`;
  const ambiguity = ambiguityReasons.length === 0 ? "ambiguity=none" : `ambiguity=${ambiguityReasons.join(",")}`;
  return `${uncertaintyClass}; ${position}; ${orientation}; exceeds_tolerance=${exceedsTolerance}; ${ambiguity}.`;
}

function isTruthFrameRef(ref: Ref): boolean {
  return ref === "W" || ref.startsWith("Q_") || TRUTH_FRAME_PATTERN.test(ref);
}

function isConstraintType(value: string): value is SpatialConstraintType {
  return ["position", "orientation", "relative_distance", "left_of", "right_of", "on_top_of", "inside", "alignment", "clearance", "stability", "tool_envelope"].includes(value);
}

function isResolvedProposal(value: ResolvedProposal | undefined): value is ResolvedProposal {
  return value !== undefined;
}

function isPose(value: CanonicalPoseEstimate | undefined): value is CanonicalPoseEstimate {
  return value !== undefined;
}

function isNumber(value: number | undefined): value is number {
  return value !== undefined;
}

function positiveOrUndefined(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? round6(value) : undefined;
}

function sanitizeRef(value: Ref): Ref {
  return makeRef(value);
}

function sanitizeText(value: string): string {
  return value.trim().replace(/\s+/gu, " ").replace(HIDDEN_SPATIAL_PATTERN, "hidden-detail").slice(0, 240);
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "") : "invalid";
}

function freezeVector3(value: readonly number[]): Vector3 {
  return Object.freeze([round6(value[0]), round6(value[1]), round6(value[2])]) as Vector3;
}

function mergePolicy(base: NormalizedPolicy, override: CognitiveSpatialNormalizerPolicy): NormalizedPolicy {
  return Object.freeze({
    allow_default_reference_frame: override.allow_default_reference_frame ?? base.allow_default_reference_frame,
    default_reference_frame_ref: override.default_reference_frame_ref ?? base.default_reference_frame_ref,
    reject_hidden_identifiers: override.reject_hidden_identifiers ?? base.reject_hidden_identifiers,
    require_current_pose_for_precise_targets: override.require_current_pose_for_precise_targets ?? base.require_current_pose_for_precise_targets,
    require_explicit_tolerance: override.require_explicit_tolerance ?? base.require_explicit_tolerance,
    max_memory_pose_age_class: override.max_memory_pose_age_class ?? base.max_memory_pose_age_class,
    min_pose_confidence_for_validator_ready: override.min_pose_confidence_for_validator_ready !== undefined && Number.isFinite(override.min_pose_confidence_for_validator_ready)
      ? Math.max(0, Math.min(1, override.min_pose_confidence_for_validator_ready))
      : base.min_pose_confidence_for_validator_ready,
  });
}

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return freezeArray([...new Set(values)].sort());
}

function makeIssue(
  severity: ValidationSeverity,
  code: CognitiveSpatialIssueCode,
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
