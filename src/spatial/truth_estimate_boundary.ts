/**
 * Truth-estimate boundary for Project Mebsuta spatial geometry.
 *
 * Blueprint: `architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md`
 * sections 10.1, 10.3, 10.4, 10.5, 10.6, 10.14, 10.16, and 10.17.
 *
 * This boundary is the executable guard that keeps simulator truth `W`, QA
 * truth frames, backend identities, and exact hidden poses outside
 * cognitive-facing geometry. It converts only properly framed, uncertain,
 * timestamped, provenance-labeled estimates into safe spatial evidence.
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
import type { GeometryProvenanceClass } from "./geometry_convention_registry";
import type { RegisteredFrameGraph, TransformResolutionReport } from "./frame_graph_service";

export const TRUTH_ESTIMATE_BOUNDARY_SCHEMA_VERSION = "mebsuta.truth_estimate_boundary.v1" as const;

const HIDDEN_TRUTH_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|qa_success|qa_label|qa_only|simulator truth|mesh_name|asset_id|benchmark_truth|oracle_pose)/i;
const HIDDEN_KEY_PATTERN = /(^|_)(backend|engine|scene_graph|world_truth|ground_truth|truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|qa_success|qa_label|qa_only|mesh_name|asset_id|benchmark_truth|oracle_pose)(_|$)/i;

export type BoundaryDestination = "cognition" | "memory" | "verification" | "control" | "audit" | "qa";
export type BoundaryDecision = "approved" | "approved_with_redactions" | "quarantined" | "rejected";
export type BoundaryRecommendedAction = "forward_estimate" | "forward_redacted_estimate" | "reobserve" | "repair_provenance" | "repair_frame" | "quarantine_for_audit" | "safe_hold";
export type PoseEstimateConfidenceClass = "unusable" | "search_only" | "planning_candidate" | "control_candidate" | "verification_candidate" | "certified_current";
export type PoseStalenessStatus = "current" | "recent" | "stale" | "contradicted" | "unknown";
export type BoundaryFindingKind =
  | "truth_frame"
  | "truth_provenance"
  | "hidden_identifier"
  | "missing_uncertainty"
  | "missing_timestamp"
  | "missing_confidence"
  | "stale_estimate"
  | "overprecise_estimate"
  | "payload_redaction";
export type TruthEstimateBoundaryIssueCode =
  | "TruthFrameBlocked"
  | "TruthProvenanceBlocked"
  | "HiddenTruthLeak"
  | "EstimateFrameInvalid"
  | "EstimateUncertaintyMissing"
  | "EstimateTimestampMissing"
  | "EstimateConfidenceInvalid"
  | "EstimateStale"
  | "OverpreciseEstimate"
  | "PayloadQuarantined"
  | "NoBoundarySurfaces"
  | "BoundaryPolicyInvalid";

/**
 * Boundary policy used when classifying spatial payloads.
 */
export interface TruthEstimateBoundaryPolicy {
  readonly hidden_source_action?: "reject" | "redact_with_issue" | "quarantine";
  readonly require_w_hat_for_cognition?: boolean;
  readonly require_timestamp_for_estimates?: boolean;
  readonly require_uncertainty_for_estimates?: boolean;
  readonly max_current_age_s?: number;
  readonly max_recent_age_s?: number;
  readonly max_single_view_control_confidence?: number;
  readonly max_memory_only_confidence?: number;
  readonly max_stale_confidence?: number;
  readonly redaction_token?: string;
}

/**
 * File 10 pose estimate shape at the truth-estimate boundary. It intentionally
 * mirrors the architecture schema before the later PoseRepresentationService
 * owns richer pose APIs.
 */
export interface BoundaryPoseEstimate {
  readonly pose_ref: Ref;
  readonly frame_ref: Ref;
  readonly subject_ref: Ref;
  readonly position_m?: Vector3;
  readonly orientation_xyzw?: Quaternion;
  readonly position_uncertainty_m?: number;
  readonly orientation_uncertainty_rad?: number;
  readonly timestamp_interval?: TimestampInterval;
  readonly provenance: GeometryProvenanceClass;
  readonly evidence_refs: readonly Ref[];
  readonly source_view_refs?: readonly Ref[];
  readonly confidence: number;
  readonly staleness_status?: PoseStalenessStatus;
  readonly cognitive_visibility?: "agent_estimate_with_uncertainty" | "self_state" | "declared_calibration" | "forbidden_truth";
  readonly summary?: string;
}

/**
 * Geometry payload to classify before it crosses the truth-estimate boundary.
 */
export interface TruthEstimateBoundarySurface {
  readonly surface_ref: Ref;
  readonly destination: BoundaryDestination;
  readonly payload: unknown;
  readonly pose_estimates?: readonly BoundaryPoseEstimate[];
  readonly transform_reports?: readonly TransformResolutionReport[];
  readonly registered_frame_graph?: RegisteredFrameGraph;
  readonly timestamp_interval?: TimestampInterval;
  readonly declared_provenance?: readonly GeometryProvenanceClass[];
  readonly declared_frame_refs?: readonly Ref[];
}

/**
 * Boundary finding used for audit and repair routing.
 */
export interface TruthEstimateBoundaryFinding {
  readonly finding_ref: Ref;
  readonly surface_ref: Ref;
  readonly finding_kind: BoundaryFindingKind;
  readonly path: string;
  readonly severity: "warning" | "blocking";
  readonly summary: string;
  readonly remediation: string;
}

/**
 * Approved estimate record with confidence bounded by uncertainty, provenance,
 * view support, and staleness.
 */
export interface BoundaryApprovedPoseEstimate {
  readonly pose_ref: Ref;
  readonly frame_ref: Ref;
  readonly subject_ref: Ref;
  readonly position_m?: Vector3;
  readonly orientation_xyzw?: Quaternion;
  readonly position_uncertainty_m?: number;
  readonly orientation_uncertainty_rad?: number;
  readonly timestamp_interval?: TimestampInterval;
  readonly provenance: GeometryProvenanceClass;
  readonly evidence_refs: readonly Ref[];
  readonly confidence: number;
  readonly confidence_class: PoseEstimateConfidenceClass;
  readonly staleness_status: PoseStalenessStatus;
  readonly boundary_notes: readonly string[];
  readonly determinism_hash: string;
}

/**
 * Sanitized spatial payload approved for a non-QA destination.
 */
export interface BoundaryApprovedSurface {
  readonly approved_surface_ref: Ref;
  readonly source_surface_ref: Ref;
  readonly destination: BoundaryDestination;
  readonly payload: unknown;
  readonly approved_pose_estimates: readonly BoundaryApprovedPoseEstimate[];
  readonly redacted_paths: readonly string[];
  readonly blocked_paths: readonly string[];
  readonly determinism_hash: string;
}

/**
 * Quarantine envelope for rejected or unsafe truth-bearing geometry.
 */
export interface BoundaryQuarantineRecord {
  readonly quarantine_ref: Ref;
  readonly source_surface_ref: Ref;
  readonly destination: BoundaryDestination;
  readonly reason: string;
  readonly blocked_paths: readonly string[];
  readonly recommended_repair: string;
  readonly determinism_hash: string;
}

/**
 * Full File 10 boundary report.
 */
export interface TruthEstimateBoundaryReport {
  readonly schema_version: typeof TRUTH_ESTIMATE_BOUNDARY_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md";
  readonly boundary_report_ref: Ref;
  readonly surface_count: number;
  readonly approved_surfaces: readonly BoundaryApprovedSurface[];
  readonly quarantined_surfaces: readonly BoundaryQuarantineRecord[];
  readonly findings: readonly TruthEstimateBoundaryFinding[];
  readonly decision: BoundaryDecision;
  readonly recommended_action: BoundaryRecommendedAction;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
  readonly cognitive_visibility: "spatial_truth_estimate_boundary_report";
}

interface NormalizedBoundaryPolicy {
  readonly hidden_source_action: "reject" | "redact_with_issue" | "quarantine";
  readonly require_w_hat_for_cognition: boolean;
  readonly require_timestamp_for_estimates: boolean;
  readonly require_uncertainty_for_estimates: boolean;
  readonly max_current_age_s: number;
  readonly max_recent_age_s: number;
  readonly max_single_view_control_confidence: number;
  readonly max_memory_only_confidence: number;
  readonly max_stale_confidence: number;
  readonly redaction_token: string;
}

interface SurfaceClassification {
  readonly surface: TruthEstimateBoundarySurface;
  readonly payload: unknown;
  readonly approved_pose_estimates: readonly BoundaryApprovedPoseEstimate[];
  readonly findings: readonly TruthEstimateBoundaryFinding[];
  readonly redacted_paths: readonly string[];
  readonly blocked_paths: readonly string[];
  readonly quarantine: boolean;
}

interface SanitizationState {
  readonly surface: TruthEstimateBoundarySurface;
  readonly policy: NormalizedBoundaryPolicy;
  readonly findings: TruthEstimateBoundaryFinding[];
  readonly redacted_paths: string[];
  readonly blocked_paths: string[];
}

const DEFAULT_POLICY: NormalizedBoundaryPolicy = Object.freeze({
  hidden_source_action: "redact_with_issue",
  require_w_hat_for_cognition: true,
  require_timestamp_for_estimates: true,
  require_uncertainty_for_estimates: true,
  max_current_age_s: 0.5,
  max_recent_age_s: 5,
  max_single_view_control_confidence: 0.62,
  max_memory_only_confidence: 0.45,
  max_stale_confidence: 0.34,
  redaction_token: "[redacted geometry truth]",
});

/**
 * Executable File 10 `TruthEstimateBoundary`.
 */
export class TruthEstimateBoundary {
  private readonly policy: NormalizedBoundaryPolicy;

  public constructor(policy: TruthEstimateBoundaryPolicy = {}) {
    this.policy = mergePolicy(DEFAULT_POLICY, policy);
  }

  /**
   * Classifies and sanitizes geometry surfaces before cognitive, memory,
   * verification, or control use.
   */
  public enforceBoundary(
    surfaces: readonly TruthEstimateBoundarySurface[],
    policy: TruthEstimateBoundaryPolicy = {},
  ): TruthEstimateBoundaryReport {
    const activePolicy = mergePolicy(this.policy, policy);
    const issues: ValidationIssue[] = [];
    validatePolicy(activePolicy, issues);
    if (surfaces.length === 0) {
      issues.push(makeIssue("error", "NoBoundarySurfaces", "$.surfaces", "TruthEstimateBoundary requires at least one geometry surface.", "Provide pose estimates, transform reports, or spatial payloads for classification."));
    }

    const classified = surfaces.map((surface) => classifySurface(surface, activePolicy, issues));
    const approved = classified.filter((item) => !item.quarantine).map(toApprovedSurface);
    const quarantined = classified.filter((item) => item.quarantine).map(toQuarantineRecord);
    const findings = classified.flatMap((item) => item.findings).sort(compareFindings);
    appendFindingIssues(findings, issues);
    const decision = decideBoundary(approved, quarantined, findings, issues, activePolicy);
    const recommendedAction = chooseRecommendedAction(decision, findings, issues);
    const reportRef = makeRef("truth_estimate_boundary_report", surfaces.map((surface) => surface.surface_ref).join(":"), decision);
    const shell = {
      reportRef,
      surfaces: surfaces.map((surface) => [surface.surface_ref, surface.destination]),
      approved: approved.map((surface) => surface.approved_surface_ref),
      quarantined: quarantined.map((surface) => surface.quarantine_ref),
      findings: findings.map((finding) => [finding.finding_kind, finding.path, finding.severity]),
      decision,
    };

    return Object.freeze({
      schema_version: TRUTH_ESTIMATE_BOUNDARY_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/10_SPATIAL_GEOMETRY_COORDINATE_FRAMES_CONSTRAINTS.md",
      boundary_report_ref: reportRef,
      surface_count: surfaces.length,
      approved_surfaces: freezeArray(approved),
      quarantined_surfaces: freezeArray(quarantined),
      findings: freezeArray(findings),
      decision,
      recommended_action: recommendedAction,
      issues: freezeArray(issues),
      ok: decision === "approved" || decision === "approved_with_redactions",
      determinism_hash: computeDeterminismHash(shell),
      cognitive_visibility: "spatial_truth_estimate_boundary_report",
    });
  }
}

/**
 * Functional API for File 10 truth-estimate boundary enforcement.
 */
export function enforceTruthEstimateBoundary(
  surfaces: readonly TruthEstimateBoundarySurface[],
  policy: TruthEstimateBoundaryPolicy = {},
): TruthEstimateBoundaryReport {
  return new TruthEstimateBoundary(policy).enforceBoundary(surfaces, policy);
}

function classifySurface(
  surface: TruthEstimateBoundarySurface,
  policy: NormalizedBoundaryPolicy,
  issues: ValidationIssue[],
): SurfaceClassification {
  validateSurfaceShell(surface, issues);
  const state: SanitizationState = {
    surface,
    policy,
    findings: [],
    redacted_paths: [],
    blocked_paths: [],
  };
  const payload = sanitizePayload(surface.payload, "$.payload", state);
  validateDeclaredFrames(surface, state);
  validateDeclaredProvenance(surface, state);
  validateTransformReports(surface, state);
  const approvedPoseEstimates = freezeArray((surface.pose_estimates ?? [])
    .map((estimate, index) => classifyPoseEstimate(estimate, index, surface, policy, state))
    .filter(isApprovedPoseEstimate));
  const hasBlocking = state.findings.some((finding) => finding.severity === "blocking");
  const quarantine = policy.hidden_source_action === "quarantine"
    ? state.findings.length > 0
    : policy.hidden_source_action === "reject" && hasBlocking;

  return Object.freeze({
    surface,
    payload,
    approved_pose_estimates: approvedPoseEstimates,
    findings: freezeArray(state.findings),
    redacted_paths: freezeArray(uniqueSorted(state.redacted_paths)),
    blocked_paths: freezeArray(uniqueSorted(state.blocked_paths)),
    quarantine,
  });
}

function classifyPoseEstimate(
  estimate: BoundaryPoseEstimate,
  index: number,
  surface: TruthEstimateBoundarySurface,
  policy: NormalizedBoundaryPolicy,
  state: SanitizationState,
): BoundaryApprovedPoseEstimate | undefined {
  const path = `$.pose_estimates[${index}]`;
  validateSafeRef(estimate.pose_ref, `${path}.pose_ref`, state);
  validateSafeRef(estimate.frame_ref, `${path}.frame_ref`, state);
  validateSafeRef(estimate.subject_ref, `${path}.subject_ref`, state);
  validateVector3(estimate.position_m, `${path}.position_m`, state);
  validateQuaternion(estimate.orientation_xyzw, `${path}.orientation_xyzw`, state);
  validateTimestamp(estimate.timestamp_interval, `${path}.timestamp_interval`, state);
  validateUnitInterval(estimate.confidence, `${path}.confidence`, state);

  if (isTruthFrameRef(estimate.frame_ref) || estimate.cognitive_visibility === "forbidden_truth") {
    addFinding(state, "truth_frame", `${path}.frame_ref`, "blocking", "Pose estimate references a simulator or QA truth frame.", "Convert the geometry into W_hat or an object-relative estimate before cognitive use.");
  }
  if (isTruthProvenance(estimate.provenance) && surface.destination !== "qa" && surface.destination !== "audit") {
    addFinding(state, "truth_provenance", `${path}.provenance`, "blocking", "Pose estimate uses simulator or QA truth provenance for a non-QA destination.", "Use sensor-derived, calibration, proprioceptive, contact, task, or memory provenance.");
  }
  if (policy.require_w_hat_for_cognition && surface.destination === "cognition" && !isCognitiveSafeFrame(estimate.frame_ref)) {
    addFinding(state, "truth_frame", `${path}.frame_ref`, "blocking", "Cognitive-facing pose estimate must be in W_hat or a declared non-truth derived frame.", "Route simulator truth through an agent-estimated W_hat transform with uncertainty.");
  }
  if (policy.require_timestamp_for_estimates && estimate.timestamp_interval === undefined) {
    addFinding(state, "missing_timestamp", `${path}.timestamp_interval`, "blocking", "Pose estimate lacks the timestamp interval required for staleness checks.", "Attach observation or estimate timing in seconds.");
  }
  if (policy.require_uncertainty_for_estimates && estimate.position_uncertainty_m === undefined && estimate.orientation_uncertainty_rad === undefined) {
    addFinding(state, "missing_uncertainty", `${path}.uncertainty`, "blocking", "Pose estimate lacks position or orientation uncertainty.", "Attach uncertainty before using the estimate for planning, verification, memory, or control.");
  }
  if (estimate.position_uncertainty_m !== undefined && (!Number.isFinite(estimate.position_uncertainty_m) || estimate.position_uncertainty_m < 0)) {
    addFinding(state, "missing_uncertainty", `${path}.position_uncertainty_m`, "blocking", "Position uncertainty must be finite and nonnegative.", "Use a calibrated nonnegative uncertainty in meters.");
  }
  if (estimate.orientation_uncertainty_rad !== undefined && (!Number.isFinite(estimate.orientation_uncertainty_rad) || estimate.orientation_uncertainty_rad < 0)) {
    addFinding(state, "missing_uncertainty", `${path}.orientation_uncertainty_rad`, "blocking", "Orientation uncertainty must be finite and nonnegative.", "Use a calibrated nonnegative uncertainty in radians.");
  }
  if (!isSafeText(`${estimate.pose_ref} ${estimate.frame_ref} ${estimate.subject_ref} ${estimate.summary ?? ""}`)) {
    addFinding(state, "hidden_identifier", path, "blocking", "Pose estimate contains hidden simulator/backend/QA wording.", "Strip hidden identifiers before boundary approval.");
  }

  const localBlockers = state.findings.filter((finding) => finding.path.startsWith(path) && finding.severity === "blocking");
  if (localBlockers.length > 0) return undefined;
  const staleness = estimate.staleness_status ?? inferStaleness(estimate.timestamp_interval, surface.timestamp_interval, policy);
  const boundedConfidence = boundedConfidenceForEstimate(estimate, surface, staleness, policy, state, path);
  const confidenceClass = classifyConfidence(boundedConfidence, estimate, staleness, surface.destination);
  const notes = buildBoundaryNotes(estimate, boundedConfidence, staleness, confidenceClass);
  const shell = {
    pose: estimate.pose_ref,
    frame: estimate.frame_ref,
    subject: estimate.subject_ref,
    position: estimate.position_m,
    orientation: estimate.orientation_xyzw,
    confidence: boundedConfidence,
    staleness,
    provenance: estimate.provenance,
  };
  return Object.freeze({
    pose_ref: estimate.pose_ref,
    frame_ref: estimate.frame_ref,
    subject_ref: estimate.subject_ref,
    position_m: estimate.position_m === undefined ? undefined : freezeVector3(estimate.position_m),
    orientation_xyzw: estimate.orientation_xyzw === undefined ? undefined : freezeQuaternion(estimate.orientation_xyzw),
    position_uncertainty_m: estimate.position_uncertainty_m === undefined ? undefined : round6(estimate.position_uncertainty_m),
    orientation_uncertainty_rad: estimate.orientation_uncertainty_rad === undefined ? undefined : round6(estimate.orientation_uncertainty_rad),
    timestamp_interval: estimate.timestamp_interval,
    provenance: estimate.provenance,
    evidence_refs: freezeArray([...estimate.evidence_refs].sort()),
    confidence: boundedConfidence,
    confidence_class: confidenceClass,
    staleness_status: staleness,
    boundary_notes: freezeArray(notes),
    determinism_hash: computeDeterminismHash(shell),
  });
}

function sanitizePayload(value: unknown, path: string, state: SanitizationState): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (!HIDDEN_TRUTH_PATTERN.test(value)) return value.trim().replace(/\s+/gu, " ");
    addFinding(state, "payload_redaction", path, state.policy.hidden_source_action === "reject" ? "blocking" : "warning", "Payload text contained hidden truth wording.", "Rewrite payload from sensor-derived estimates only.");
    state.redacted_paths.push(path);
    return state.policy.redaction_token;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol" || typeof value === "function") {
    state.blocked_paths.push(path);
    addFinding(state, "payload_redaction", path, "warning", "Non-data payload value was removed at the truth-estimate boundary.", "Use JSON-compatible geometry payloads.");
    return undefined;
  }
  if (Array.isArray(value)) {
    return freezeArray(value
      .map((item, index) => sanitizePayload(item, `${path}[${index}]`, state))
      .filter((item) => item !== undefined));
  }
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Readonly<Record<string, unknown>>).sort()) {
    const childPath = `${path}.${key}`;
    if (HIDDEN_KEY_PATTERN.test(key)) {
      state.blocked_paths.push(childPath);
      addFinding(state, "hidden_identifier", childPath, "blocking", `Hidden truth field ${key} was blocked.`, "Remove hidden simulator, QA, or backend fields before spatial use.");
      continue;
    }
    const child = sanitizePayload((value as Readonly<Record<string, unknown>>)[key], childPath, state);
    if (child !== undefined) output[key] = child;
  }
  return Object.freeze(output);
}

function validateDeclaredFrames(surface: TruthEstimateBoundarySurface, state: SanitizationState): void {
  for (const [index, frameRef] of (surface.declared_frame_refs ?? []).entries()) {
    validateSafeRef(frameRef, `$.declared_frame_refs[${index}]`, state);
    if (isTruthFrameRef(frameRef) && surface.destination !== "qa" && surface.destination !== "audit") {
      addFinding(state, "truth_frame", `$.declared_frame_refs[${index}]`, "blocking", "Surface declares a simulator or QA truth frame for a non-QA destination.", "Use W_hat or sensor-derived frame refs.");
    }
  }
  for (const frame of surface.registered_frame_graph?.forbidden_frame_refs ?? []) {
    if (surface.destination !== "qa" && surface.destination !== "audit") {
      addFinding(state, "truth_frame", `$.registered_frame_graph.forbidden_frame_refs.${frame}`, "blocking", "Registered graph contains forbidden truth frames for a non-QA destination.", "Remove truth-only frames before forwarding geometry.");
    }
  }
}

function validateDeclaredProvenance(surface: TruthEstimateBoundarySurface, state: SanitizationState): void {
  for (const [index, provenance] of (surface.declared_provenance ?? []).entries()) {
    if (isTruthProvenance(provenance) && surface.destination !== "qa" && surface.destination !== "audit") {
      addFinding(state, "truth_provenance", `$.declared_provenance[${index}]`, "blocking", "Surface declares simulator or QA truth provenance for a non-QA destination.", "Convert to an agent-estimated provenance chain before forwarding.");
    }
  }
}

function validateTransformReports(surface: TruthEstimateBoundarySurface, state: SanitizationState): void {
  for (const [index, report] of (surface.transform_reports ?? []).entries()) {
    const path = `$.transform_reports[${index}]`;
    if (isTruthFrameRef(report.source_frame_ref) || isTruthFrameRef(report.target_frame_ref)) {
      addFinding(state, "truth_frame", `${path}.frame_ref`, "blocking", "Transform report references a truth-only frame.", "Resolve transforms through W_hat or estimate-relative frames.");
    }
    if (report.provenance_chain.some(isTruthProvenance) && surface.destination !== "qa" && surface.destination !== "audit") {
      addFinding(state, "truth_provenance", `${path}.provenance_chain`, "blocking", "Transform chain contains truth-only provenance.", "Use declared calibration, proprioception, visual estimates, contact estimates, task evidence, or memory priors.");
    }
    if (!report.ok || report.decision === "not_resolved" || report.decision === "rejected") {
      addFinding(state, "missing_uncertainty", `${path}.decision`, "blocking", "Unresolved transform report cannot cross the truth-estimate boundary.", "Repair frame graph registration or transform resolution before forwarding.");
    }
  }
}

function boundedConfidenceForEstimate(
  estimate: BoundaryPoseEstimate,
  surface: TruthEstimateBoundarySurface,
  staleness: PoseStalenessStatus,
  policy: NormalizedBoundaryPolicy,
  state: SanitizationState,
  path: string,
): number {
  const caps = [1];
  const sourceViewCount = estimate.source_view_refs?.length ?? 0;
  if (sourceViewCount <= 1 && (surface.destination === "control" || surface.destination === "verification")) {
    caps.push(policy.max_single_view_control_confidence);
    addFinding(state, "overprecise_estimate", `${path}.source_view_refs`, "warning", "Single-view estimate confidence was capped for control or verification use.", "Add synchronized multi-view, depth, or contact support before precise use.");
  }
  if (estimate.provenance === "memory_prior") caps.push(policy.max_memory_only_confidence);
  if (staleness === "stale" || staleness === "contradicted") {
    caps.push(policy.max_stale_confidence);
    addFinding(state, "stale_estimate", `${path}.staleness_status`, staleness === "contradicted" ? "blocking" : "warning", "Stale or contradicted estimate cannot be treated as current geometry.", "Reobserve current scene before target-frame or control use.");
  }
  const uncertainty = estimate.position_uncertainty_m ?? estimate.orientation_uncertainty_rad ?? 0;
  if (uncertainty > 0.1) caps.push(0.5);
  if (uncertainty > 0.25) caps.push(0.35);
  return roundScore(Math.min(clamp01(estimate.confidence), ...caps));
}

function classifyConfidence(
  confidence: number,
  estimate: BoundaryPoseEstimate,
  staleness: PoseStalenessStatus,
  destination: BoundaryDestination,
): PoseEstimateConfidenceClass {
  if (confidence < 0.2 || staleness === "contradicted") return "unusable";
  if (estimate.provenance === "memory_prior" || staleness === "stale" || confidence < 0.42) return "search_only";
  if (destination === "control" && confidence >= 0.74 && estimate.position_uncertainty_m !== undefined && estimate.position_uncertainty_m <= 0.035) return "control_candidate";
  if (destination === "verification" && confidence >= 0.68) return "verification_candidate";
  if (destination === "memory" && confidence >= 0.78 && staleness === "current") return "certified_current";
  return "planning_candidate";
}

function inferStaleness(
  estimateInterval: TimestampInterval | undefined,
  surfaceInterval: TimestampInterval | undefined,
  policy: NormalizedBoundaryPolicy,
): PoseStalenessStatus {
  if (estimateInterval === undefined || surfaceInterval === undefined) return "unknown";
  const age = Math.max(0, surfaceInterval.end_s - estimateInterval.end_s);
  if (age <= policy.max_current_age_s) return "current";
  if (age <= policy.max_recent_age_s) return "recent";
  return "stale";
}

function buildBoundaryNotes(
  estimate: BoundaryPoseEstimate,
  confidence: number,
  staleness: PoseStalenessStatus,
  confidenceClass: PoseEstimateConfidenceClass,
): readonly string[] {
  const notes = [
    `provenance=${estimate.provenance}`,
    `staleness=${staleness}`,
    `confidence_class=${confidenceClass}`,
    `bounded_confidence=${formatScore(confidence)}`,
    estimate.position_uncertainty_m === undefined ? "position_uncertainty=not_supplied" : `position_uncertainty_m=${formatScore(estimate.position_uncertainty_m)}`,
    estimate.orientation_uncertainty_rad === undefined ? "orientation_uncertainty=not_supplied" : `orientation_uncertainty_rad=${formatScore(estimate.orientation_uncertainty_rad)}`,
  ];
  return freezeArray(notes);
}

function toApprovedSurface(classified: SurfaceClassification): BoundaryApprovedSurface {
  const approvedRef = makeRef("truth_boundary_approved", classified.surface.surface_ref, classified.surface.destination);
  const shell = {
    approvedRef,
    source: classified.surface.surface_ref,
    destination: classified.surface.destination,
    poses: classified.approved_pose_estimates.map((estimate) => [estimate.pose_ref, estimate.confidence, estimate.confidence_class]),
    redacted: classified.redacted_paths,
    blocked: classified.blocked_paths,
  };
  return Object.freeze({
    approved_surface_ref: approvedRef,
    source_surface_ref: classified.surface.surface_ref,
    destination: classified.surface.destination,
    payload: classified.payload,
    approved_pose_estimates: classified.approved_pose_estimates,
    redacted_paths: classified.redacted_paths,
    blocked_paths: classified.blocked_paths,
    determinism_hash: computeDeterminismHash(shell),
  });
}

function toQuarantineRecord(classified: SurfaceClassification): BoundaryQuarantineRecord {
  const blockedPaths = uniqueSorted([...classified.blocked_paths, ...classified.redacted_paths, ...classified.findings.filter((finding) => finding.severity === "blocking").map((finding) => finding.path)]);
  const quarantineRef = makeRef("truth_boundary_quarantine", classified.surface.surface_ref, classified.surface.destination);
  return Object.freeze({
    quarantine_ref: quarantineRef,
    source_surface_ref: classified.surface.surface_ref,
    destination: classified.surface.destination,
    reason: "Geometry surface carried truth-only frames, truth provenance, hidden identifiers, or incomplete estimate metadata.",
    blocked_paths: freezeArray(blockedPaths),
    recommended_repair: "Rebuild the payload from W_hat, declared calibration, proprioception, visual/contact estimates, task evidence, or staleness-aware memory with explicit uncertainty and timestamps.",
    determinism_hash: computeDeterminismHash({ quarantineRef, blockedPaths }),
  });
}

function decideBoundary(
  approved: readonly BoundaryApprovedSurface[],
  quarantined: readonly BoundaryQuarantineRecord[],
  findings: readonly TruthEstimateBoundaryFinding[],
  issues: readonly ValidationIssue[],
  policy: NormalizedBoundaryPolicy,
): BoundaryDecision {
  if (issues.some((issue) => issue.code === "NoBoundarySurfaces" || issue.code === "BoundaryPolicyInvalid")) return "rejected";
  if (policy.hidden_source_action === "reject" && findings.some((finding) => finding.severity === "blocking")) return "rejected";
  if (quarantined.length > 0 && approved.length === 0) return "quarantined";
  if (quarantined.length > 0 || findings.length > 0 || issues.some((issue) => issue.severity === "warning")) return "approved_with_redactions";
  return "approved";
}

function chooseRecommendedAction(
  decision: BoundaryDecision,
  findings: readonly TruthEstimateBoundaryFinding[],
  issues: readonly ValidationIssue[],
): BoundaryRecommendedAction {
  if (decision === "approved") return "forward_estimate";
  if (decision === "approved_with_redactions" && findings.every((finding) => finding.severity === "warning")) return "forward_redacted_estimate";
  if (findings.some((finding) => finding.finding_kind === "truth_frame")) return "repair_frame";
  if (findings.some((finding) => finding.finding_kind === "truth_provenance" || finding.finding_kind === "hidden_identifier")) return "repair_provenance";
  if (findings.some((finding) => finding.finding_kind === "missing_timestamp" || finding.finding_kind === "stale_estimate")) return "reobserve";
  if (decision === "quarantined" || issues.some((issue) => issue.code === "PayloadQuarantined")) return "quarantine_for_audit";
  return "safe_hold";
}

function appendFindingIssues(findings: readonly TruthEstimateBoundaryFinding[], issues: ValidationIssue[]): void {
  for (const finding of findings) {
    const code = issueCodeForFinding(finding);
    issues.push(makeIssue(finding.severity === "blocking" ? "error" : "warning", code, finding.path, finding.summary, finding.remediation));
  }
}

function issueCodeForFinding(finding: TruthEstimateBoundaryFinding): TruthEstimateBoundaryIssueCode {
  if (finding.finding_kind === "truth_frame") return "TruthFrameBlocked";
  if (finding.finding_kind === "truth_provenance") return "TruthProvenanceBlocked";
  if (finding.finding_kind === "hidden_identifier" || finding.finding_kind === "payload_redaction") return "HiddenTruthLeak";
  if (finding.finding_kind === "missing_uncertainty") return "EstimateUncertaintyMissing";
  if (finding.finding_kind === "missing_timestamp") return "EstimateTimestampMissing";
  if (finding.finding_kind === "missing_confidence") return "EstimateConfidenceInvalid";
  if (finding.finding_kind === "stale_estimate") return "EstimateStale";
  return "OverpreciseEstimate";
}

function validateSurfaceShell(surface: TruthEstimateBoundarySurface, issues: ValidationIssue[]): void {
  if (surface.surface_ref.trim().length === 0 || /\s/u.test(surface.surface_ref)) {
    issues.push(makeIssue("error", "EstimateFrameInvalid", "$.surface_ref", "Surface ref must be non-empty and whitespace-free.", "Use an opaque boundary surface reference."));
  }
  validateTimestamp(surface.timestamp_interval, "$.timestamp_interval", {
    surface,
    policy: DEFAULT_POLICY,
    findings: [],
    redacted_paths: [],
    blocked_paths: [],
  });
}

function validatePolicy(policy: NormalizedBoundaryPolicy, issues: ValidationIssue[]): void {
  if (policy.max_current_age_s < 0 || policy.max_recent_age_s < policy.max_current_age_s || policy.redaction_token.trim().length === 0) {
    issues.push(makeIssue("error", "BoundaryPolicyInvalid", "$.policy", "Boundary policy age thresholds must be ordered and redaction token must be non-empty.", "Use 0 <= max_current_age_s <= max_recent_age_s and a visible redaction token."));
  }
  for (const [path, value] of [
    ["$.policy.max_single_view_control_confidence", policy.max_single_view_control_confidence],
    ["$.policy.max_memory_only_confidence", policy.max_memory_only_confidence],
    ["$.policy.max_stale_confidence", policy.max_stale_confidence],
  ] as const) {
    if (value < 0 || value > 1 || !Number.isFinite(value)) {
      issues.push(makeIssue("error", "BoundaryPolicyInvalid", path, "Confidence caps must be finite values in [0, 1].", "Use normalized confidence caps."));
    }
  }
}

function validateSafeRef(value: Ref, path: string, state: SanitizationState): void {
  if (value.trim().length === 0 || /\s/u.test(value)) {
    addFinding(state, "hidden_identifier", path, "blocking", "Reference must be non-empty and whitespace-free.", "Use an opaque sanitized ref.");
  }
  if (!isSafeText(value)) {
    addFinding(state, "hidden_identifier", path, "blocking", "Reference contains hidden simulator/backend/QA wording.", "Strip hidden identifiers before boundary classification.");
  }
}

function validateVector3(value: Vector3 | undefined, path: string, state: SanitizationState): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length !== 3 || value.some((component) => !Number.isFinite(component))) {
    addFinding(state, "missing_uncertainty", path, "blocking", "Position vector must contain exactly three finite meter values.", "Use [x, y, z] meters.");
  }
}

function validateQuaternion(value: Quaternion | undefined, path: string, state: SanitizationState): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length !== 4 || value.some((component) => !Number.isFinite(component))) {
    addFinding(state, "missing_uncertainty", path, "blocking", "Orientation quaternion must contain exactly four finite values.", "Use normalized [x, y, z, w].");
    return;
  }
  const length = Math.hypot(value[0], value[1], value[2], value[3]);
  if (length < 1e-9 || Math.abs(length - 1) > 1e-6) {
    addFinding(state, "missing_uncertainty", path, "blocking", "Orientation quaternion must be unit length.", "Normalize orientation before boundary approval.");
  }
}

function validateTimestamp(interval: TimestampInterval | undefined, path: string, state: SanitizationState): void {
  if (interval === undefined) return;
  if (!Number.isFinite(interval.start_s) || !Number.isFinite(interval.end_s) || interval.end_s < interval.start_s) {
    addFinding(state, "missing_timestamp", path, "blocking", "Timestamp interval must contain finite ordered seconds.", "Use start_s <= end_s.");
  }
}

function validateUnitInterval(value: number, path: string, state: SanitizationState): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    addFinding(state, "missing_confidence", path, "blocking", "Confidence must be a finite value in [0, 1].", "Use normalized estimate confidence.");
  }
}

function addFinding(
  state: SanitizationState,
  kind: BoundaryFindingKind,
  path: string,
  severity: "warning" | "blocking",
  summary: string,
  remediation: string,
): void {
  const findingRef = makeRef("truth_boundary_finding", state.surface.surface_ref, kind, path);
  state.findings.push(Object.freeze({
    finding_ref: findingRef,
    surface_ref: state.surface.surface_ref,
    finding_kind: kind,
    path,
    severity,
    summary,
    remediation,
  }));
  if (severity === "blocking") state.blocked_paths.push(path);
}

function isTruthFrameRef(frameRef: Ref): boolean {
  return frameRef === "W" || frameRef.startsWith("Q_") || /(^|:)qa_truth(:|$)/i.test(frameRef);
}

function isCognitiveSafeFrame(frameRef: Ref): boolean {
  return frameRef === "W_hat" || (!isTruthFrameRef(frameRef) && !HIDDEN_TRUTH_PATTERN.test(frameRef));
}

function isTruthProvenance(provenance: GeometryProvenanceClass): boolean {
  return provenance === "simulator_truth" || provenance === "qa_truth";
}

function isSafeText(value: string): boolean {
  return !HIDDEN_TRUTH_PATTERN.test(value);
}

function isApprovedPoseEstimate(value: BoundaryApprovedPoseEstimate | undefined): value is BoundaryApprovedPoseEstimate {
  return value !== undefined;
}

function compareFindings(a: TruthEstimateBoundaryFinding, b: TruthEstimateBoundaryFinding): number {
  return Number(b.severity === "blocking") - Number(a.severity === "blocking")
    || a.surface_ref.localeCompare(b.surface_ref)
    || a.path.localeCompare(b.path)
    || a.finding_ref.localeCompare(b.finding_ref);
}

function mergePolicy(base: NormalizedBoundaryPolicy, override: TruthEstimateBoundaryPolicy): NormalizedBoundaryPolicy {
  return Object.freeze({
    hidden_source_action: override.hidden_source_action ?? base.hidden_source_action,
    require_w_hat_for_cognition: override.require_w_hat_for_cognition ?? base.require_w_hat_for_cognition,
    require_timestamp_for_estimates: override.require_timestamp_for_estimates ?? base.require_timestamp_for_estimates,
    require_uncertainty_for_estimates: override.require_uncertainty_for_estimates ?? base.require_uncertainty_for_estimates,
    max_current_age_s: positiveOrDefault(override.max_current_age_s, base.max_current_age_s),
    max_recent_age_s: positiveOrDefault(override.max_recent_age_s, base.max_recent_age_s),
    max_single_view_control_confidence: clamp01(override.max_single_view_control_confidence ?? base.max_single_view_control_confidence),
    max_memory_only_confidence: clamp01(override.max_memory_only_confidence ?? base.max_memory_only_confidence),
    max_stale_confidence: clamp01(override.max_stale_confidence ?? base.max_stale_confidence),
    redaction_token: override.redaction_token?.trim() || base.redaction_token,
  });
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
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

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return freezeArray([...new Set(values)].sort());
}

function freezeVector3(value: readonly number[]): Vector3 {
  return Object.freeze([round6(value[0]), round6(value[1]), round6(value[2])]) as Vector3;
}

function freezeQuaternion(value: readonly number[]): Quaternion {
  return Object.freeze([round6(value[0]), round6(value[1]), round6(value[2]), round6(value[3])]) as Quaternion;
}

function makeIssue(
  severity: ValidationSeverity,
  code: TruthEstimateBoundaryIssueCode,
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
    .replace(/[^a-z0-9_.:[\]-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "ref:empty";
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}
