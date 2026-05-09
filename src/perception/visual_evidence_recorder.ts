/**
 * Visual evidence recorder for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md`
 * sections 9.3.1, 9.5.1, 9.14, 9.16, 9.17, 9.18.4, 9.19, and 9.20.
 *
 * The recorder builds Oops Loop visual evidence bundles from declared camera
 * packets, task anomaly events, failure-focused crops, and optional
 * verification or consensus context. It preserves before/after evidence,
 * records absent or degraded evidence explicitly, emits memory-ready summaries
 * with provenance and staleness hooks, and blocks hidden simulator data from
 * entering the cognitive or audit path.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import type { CropRequest, CropRequestSet } from "./crop_and_zoom_planner";
import type { MultiViewConsensusReport, ViewConflictRecord } from "./cross_view_consensus_engine";
import type { MultiViewObservationBundle, PerceptionTaskPhase, SynchronizedViewPacket } from "./multi_view_synchronizer";
import type { CanonicalViewName } from "./view_name_registry";
import type { TargetVisibility, ViewHealthStatus, ViewQualityReport, ViewQualityReportSet } from "./view_quality_assessor";
import type { VerificationEvidenceView, VerificationObservationBundle } from "./verification_view_assembler";
import type { CropRegionDefinition } from "./visual_prompt_packager";

export const VISUAL_EVIDENCE_RECORDER_SCHEMA_VERSION = "mebsuta.visual_evidence_recorder.v1" as const;

const HIDDEN_VISUAL_EVIDENCE_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|segmentation truth|debug buffer|debug overlay|qa_success|qa_label|qa_only|simulator truth|mesh_name|asset_id)/i;

export type VisualAnomalyCategory = "missed_grasp" | "slip" | "drop" | "collision" | "overshoot" | "occluded_target" | "tool_deflection" | "unknown";
export type VisualAnomalySeverity = "low" | "medium" | "high" | "critical";
export type EvidenceTemporalRole = "before" | "during" | "after";
export type EvidenceFrameStatus = "included" | "missing" | "degraded" | "stale" | "occluded" | "context_only";
export type ObjectVisibilityChange = "visible" | "lost" | "occluded" | "dropped" | "moved" | "deformed" | "unknown";
export type VisualEvidenceDecision = "recorded" | "recorded_with_warnings" | "rejected";
export type VisualEvidenceRecommendedAction = "continue" | "reobserve" | "recapture" | "safe_hold" | "human_review";
export type RetentionClass = "oops_short_term" | "memory_candidate" | "audit_retained";
export type MissingEvidenceKind = "before_view" | "during_view" | "after_view" | "contact_crop" | "verification_context" | "quality_report";
export type VisualEvidenceIssueCode =
  | "HiddenVisualEvidenceLeak"
  | "AfterEvidenceMissing"
  | "BeforeEvidenceMissing"
  | "ContactCropMissing"
  | "ContactCropSourceMissing"
  | "ContactCropContextInsufficient"
  | "QualityReportMismatch"
  | "DesynchronizedEvidence"
  | "EvidencePolicyInvalid"
  | "VerificationBundleMismatch"
  | "ConsensusBundleMismatch"
  | "NoCurrentCameraEvidence";

/**
 * Runtime anomaly event produced by execution monitoring or orchestration. The
 * event is task-side telemetry and must not encode simulator-private object
 * identifiers or hidden success labels.
 */
export interface VisualAnomalyEvent {
  readonly anomaly_event_ref: Ref;
  readonly category: VisualAnomalyCategory;
  readonly detected_at_s: number;
  readonly task_phase: PerceptionTaskPhase;
  readonly severity: VisualAnomalySeverity;
  readonly summary: string;
  readonly target_label?: string;
  readonly tool_label?: string;
  readonly contact_site_ref?: Ref;
  readonly source_event_refs?: readonly Ref[];
  readonly telemetry_refs?: readonly Ref[];
  readonly audio_refs?: readonly Ref[];
}

/**
 * Recorder policy for Oops Loop evidence selection and retention.
 */
export interface VisualEvidencePolicy {
  readonly required_before_views?: readonly CanonicalViewName[];
  readonly required_after_views?: readonly CanonicalViewName[];
  readonly required_contact_views?: readonly CanonicalViewName[];
  readonly min_quality_score?: number;
  readonly max_views_per_temporal_role?: number;
  readonly retention_ttl_s?: number;
  readonly retain_audit_copy?: boolean;
  readonly include_memory_handoff?: boolean;
  readonly require_after_view?: boolean;
  readonly require_contact_crop_for_contact_events?: boolean;
  readonly hidden_source_action?: "reject" | "redact_with_issue";
}

/**
 * Normalized packet or missing-view record retained in a failure bundle.
 */
export interface VisualEvidenceFrameRecord {
  readonly evidence_ref: Ref;
  readonly temporal_role: EvidenceTemporalRole;
  readonly source_view_name: CanonicalViewName;
  readonly source_camera_packet_ref?: Ref;
  readonly image_ref?: Ref;
  readonly depth_ref?: Ref;
  readonly timestamp_midpoint_s?: number;
  readonly health_status?: ViewHealthStatus;
  readonly quality_score?: number;
  readonly target_visibility?: TargetVisibility;
  readonly evidence_status: EvidenceFrameStatus;
  readonly retention_class: RetentionClass;
  readonly retention_expires_at_s?: number;
  readonly provenance_summary: string;
  readonly evidence_summary: string;
  readonly determinism_hash: string;
}

/**
 * Failure-focused crop evidence around gripper, object, support, obstacle, or
 * tool contact regions.
 */
export interface ContactRegionCropEvidence {
  readonly evidence_ref: Ref;
  readonly crop_ref: Ref;
  readonly source_view_name: CanonicalViewName;
  readonly source_camera_packet_ref: Ref;
  readonly target_label?: string;
  readonly region_definition: CropRegionDefinition;
  readonly source_quality_score: number;
  readonly temporal_role: EvidenceTemporalRole;
  readonly context_preservation_ok: boolean;
  readonly retention_class: RetentionClass;
  readonly inclusion_reason: string;
  readonly determinism_hash: string;
}

/**
 * Explicit absence or degradation marker. Oops recovery must know which views
 * were desired but unavailable, stale, occluded, or not quality-scored.
 */
export interface MissingVisualEvidenceRecord {
  readonly missing_ref: Ref;
  readonly evidence_kind: MissingEvidenceKind;
  readonly temporal_role?: EvidenceTemporalRole;
  readonly canonical_view_name?: CanonicalViewName;
  readonly reason: string;
  readonly recommended_recovery: VisualEvidenceRecommendedAction;
}

/**
 * Visual diagnostic hint for the Oops coordinator. Hints are evidence-derived
 * and intentionally remain weaker than deterministic validation results.
 */
export interface VisualCauseHint {
  readonly hint_ref: Ref;
  readonly category: VisualAnomalyCategory;
  readonly source_refs: readonly Ref[];
  readonly confidence: number;
  readonly summary: string;
}

/**
 * Compact visual record suitable for later memory evidence construction.
 */
export interface VisualMemoryHandoffCandidate {
  readonly memory_candidate_ref: Ref;
  readonly source_failure_visual_bundle_ref: Ref;
  readonly anomaly_event_ref: Ref;
  readonly visual_descriptor: string;
  readonly source_views: readonly CanonicalViewName[];
  readonly confidence: number;
  readonly staleness_hint: string;
  readonly contradiction_links: readonly Ref[];
}

/**
 * File 09 failure visual evidence bundle for Oops Loop recovery and audit.
 */
export interface FailureVisualEvidenceBundle {
  readonly schema_version: typeof VISUAL_EVIDENCE_RECORDER_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md";
  readonly failure_visual_bundle_ref: Ref;
  readonly anomaly_event_ref: Ref;
  readonly anomaly_event: VisualAnomalyEvent;
  readonly before_views: readonly VisualEvidenceFrameRecord[];
  readonly during_views: readonly VisualEvidenceFrameRecord[];
  readonly after_views: readonly VisualEvidenceFrameRecord[];
  readonly contact_region_crops: readonly ContactRegionCropEvidence[];
  readonly object_visibility_change: ObjectVisibilityChange;
  readonly visual_cause_hints: readonly VisualCauseHint[];
  readonly view_quality_report_ref: Ref;
  readonly missing_evidence: readonly MissingVisualEvidenceRecord[];
  readonly provenance_summary: string;
  readonly retention_policy_summary: string;
  readonly memory_handoff_candidates: readonly VisualMemoryHandoffCandidate[];
  readonly source_bundle_refs: readonly Ref[];
  readonly source_verification_bundle_ref?: Ref;
  readonly source_consensus_ref?: Ref;
  readonly decision: VisualEvidenceDecision;
  readonly recommended_action: VisualEvidenceRecommendedAction;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
  readonly cognitive_visibility: "perception_failure_visual_evidence_bundle";
}

interface NormalizedVisualEvidencePolicy {
  readonly required_before_views: readonly CanonicalViewName[];
  readonly required_after_views: readonly CanonicalViewName[];
  readonly required_contact_views: readonly CanonicalViewName[];
  readonly min_quality_score: number;
  readonly max_views_per_temporal_role: number;
  readonly retention_ttl_s: number;
  readonly retain_audit_copy: boolean;
  readonly include_memory_handoff: boolean;
  readonly require_after_view: boolean;
  readonly require_contact_crop_for_contact_events: boolean;
  readonly hidden_source_action: "reject" | "redact_with_issue";
}

const DEFAULT_POLICY: NormalizedVisualEvidencePolicy = Object.freeze({
  required_before_views: freezeArray(["front_primary"] as readonly CanonicalViewName[]),
  required_after_views: freezeArray(["front_primary"] as readonly CanonicalViewName[]),
  required_contact_views: freezeArray(["wrist_or_mouth", "front_primary"] as readonly CanonicalViewName[]),
  min_quality_score: 0.42,
  max_views_per_temporal_role: 5,
  retention_ttl_s: 86_400,
  retain_audit_copy: true,
  include_memory_handoff: true,
  require_after_view: true,
  require_contact_crop_for_contact_events: true,
  hidden_source_action: "reject",
});

/**
 * Executable File 09 `VisualEvidenceRecorder`.
 */
export class VisualEvidenceRecorder {
  private readonly policy: NormalizedVisualEvidencePolicy;

  public constructor(policy: VisualEvidencePolicy = {}) {
    this.policy = mergePolicy(DEFAULT_POLICY, policy);
  }

  /**
   * Builds an Oops Loop visual evidence bundle from before/after camera
   * bundles, optional during bundles, and failure-focused crops.
   */
  public buildOopsVisualEvidence(
    anomalyEvent: VisualAnomalyEvent,
    beforePackets: MultiViewObservationBundle | undefined,
    afterPackets: MultiViewObservationBundle,
    contactCrops: readonly CropRequest[] | CropRequestSet = [],
    evidencePolicy: VisualEvidencePolicy = {},
    duringPackets: readonly MultiViewObservationBundle[] = [],
    viewQualityReports: readonly ViewQualityReportSet[] = [],
    verificationBundle?: VerificationObservationBundle,
    consensusReport?: MultiViewConsensusReport,
  ): FailureVisualEvidenceBundle {
    const activePolicy = mergePolicy(this.policy, evidencePolicy);
    const issues: ValidationIssue[] = [];
    validateInputs(anomalyEvent, beforePackets, afterPackets, contactCrops, duringPackets, viewQualityReports, verificationBundle, consensusReport, activePolicy, issues);

    const cropRequests = normalizeCropRequests(contactCrops);
    const beforeViews = buildFrameRecords(beforePackets, "before", activePolicy.required_before_views, viewQualityReports, anomalyEvent, activePolicy, issues);
    const duringViews = duringPackets.flatMap((bundle) => buildFrameRecords(bundle, "during", freezeArray([] as readonly CanonicalViewName[]), viewQualityReports, anomalyEvent, activePolicy, issues));
    const afterViews = buildFrameRecords(afterPackets, "after", activePolicy.required_after_views, viewQualityReports, anomalyEvent, activePolicy, issues);
    const contactRegionCrops = buildContactCropEvidence(cropRequests, beforePackets, afterPackets, duringPackets, anomalyEvent, activePolicy, issues);
    const verificationMissing = verificationBundle === undefined
      ? freezeArray([] as readonly MissingVisualEvidenceRecord[])
      : missingFromVerification(verificationBundle);
    const missingEvidence = freezeArray([
      ...missingFromFrameRecords(beforeViews, "before_view"),
      ...missingFromFrameRecords(duringViews, "during_view"),
      ...missingFromFrameRecords(afterViews, "after_view"),
      ...missingContactEvidence(anomalyEvent, contactRegionCrops, activePolicy),
      ...missingQualityReports(beforePackets, afterPackets, duringPackets, viewQualityReports),
      ...verificationMissing,
    ].sort(compareMissingRecords));

    const objectVisibilityChange = inferObjectVisibilityChange(anomalyEvent, afterViews, verificationBundle, consensusReport);
    const visualCauseHints = buildCauseHints(anomalyEvent, beforeViews, duringViews, afterViews, contactRegionCrops, verificationBundle, consensusReport);
    const sourceBundleRefs = bundleRefs(beforePackets, afterPackets, duringPackets);
    const bundleRef = makeRef("failure_visual_bundle", anomalyEvent.anomaly_event_ref, afterPackets.bundle_ref, sourceBundleRefs.join(":"));
    const memoryHandoffCandidates = activePolicy.include_memory_handoff
      ? buildMemoryHandoffCandidates(bundleRef, anomalyEvent, objectVisibilityChange, beforeViews, afterViews, contactRegionCrops, visualCauseHints, consensusReport)
      : freezeArray([] as readonly VisualMemoryHandoffCandidate[]);
    const decision = decideEvidenceBundle(afterViews, missingEvidence, issues, activePolicy);
    const recommendedAction = chooseRecommendedAction(decision, anomalyEvent, afterPackets, missingEvidence, issues);
    const provenanceSummary = summarizeProvenance(beforePackets, afterPackets, duringPackets, contactRegionCrops, verificationBundle, consensusReport);
    const retentionPolicySummary = summarizeRetention(activePolicy, anomalyEvent);
    const qualityReportRef = primaryQualityReportRef(afterPackets, viewQualityReports);
    const shell = {
      bundleRef,
      anomaly: [anomalyEvent.anomaly_event_ref, anomalyEvent.category, anomalyEvent.severity],
      sourceBundleRefs,
      before: beforeViews.map((view) => [view.source_view_name, view.evidence_status, view.source_camera_packet_ref]),
      during: duringViews.map((view) => [view.source_view_name, view.evidence_status, view.source_camera_packet_ref]),
      after: afterViews.map((view) => [view.source_view_name, view.evidence_status, view.source_camera_packet_ref]),
      crops: contactRegionCrops.map((crop) => [crop.crop_ref, crop.source_view_name, crop.temporal_role]),
      missing: missingEvidence.map((missing) => [missing.evidence_kind, missing.canonical_view_name, missing.temporal_role]),
      change: objectVisibilityChange,
      decision,
    };

    return Object.freeze({
      schema_version: VISUAL_EVIDENCE_RECORDER_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/09_PERCEPTION_MULTI_VIEW_VISION_ARCHITECTURE.md",
      failure_visual_bundle_ref: bundleRef,
      anomaly_event_ref: anomalyEvent.anomaly_event_ref,
      anomaly_event: sanitizeAnomalyEvent(anomalyEvent),
      before_views: freezeArray([...beforeViews].sort(compareFrameRecords)),
      during_views: freezeArray([...duringViews].sort(compareFrameRecords)),
      after_views: freezeArray([...afterViews].sort(compareFrameRecords)),
      contact_region_crops: freezeArray([...contactRegionCrops].sort(compareCropEvidence)),
      object_visibility_change: objectVisibilityChange,
      visual_cause_hints: freezeArray([...visualCauseHints].sort(compareCauseHints)),
      view_quality_report_ref: qualityReportRef,
      missing_evidence: missingEvidence,
      provenance_summary: provenanceSummary,
      retention_policy_summary: retentionPolicySummary,
      memory_handoff_candidates: memoryHandoffCandidates,
      source_bundle_refs: sourceBundleRefs,
      source_verification_bundle_ref: verificationBundle?.verification_bundle_ref,
      source_consensus_ref: consensusReport?.consensus_ref,
      decision,
      recommended_action: recommendedAction,
      issues: freezeArray(issues),
      ok: decision !== "rejected",
      determinism_hash: computeDeterminismHash(shell),
      cognitive_visibility: "perception_failure_visual_evidence_bundle",
    });
  }
}

/**
 * Functional API matching File 09's Oops visual evidence signature.
 */
export function buildOopsVisualEvidence(
  anomalyEvent: VisualAnomalyEvent,
  beforePackets: MultiViewObservationBundle | undefined,
  afterPackets: MultiViewObservationBundle,
  contactCrops: readonly CropRequest[] | CropRequestSet = [],
  evidencePolicy: VisualEvidencePolicy = {},
  duringPackets: readonly MultiViewObservationBundle[] = [],
  viewQualityReports: readonly ViewQualityReportSet[] = [],
  verificationBundle?: VerificationObservationBundle,
  consensusReport?: MultiViewConsensusReport,
): FailureVisualEvidenceBundle {
  return new VisualEvidenceRecorder(evidencePolicy).buildOopsVisualEvidence(
    anomalyEvent,
    beforePackets,
    afterPackets,
    contactCrops,
    evidencePolicy,
    duringPackets,
    viewQualityReports,
    verificationBundle,
    consensusReport,
  );
}

function validateInputs(
  anomalyEvent: VisualAnomalyEvent,
  beforePackets: MultiViewObservationBundle | undefined,
  afterPackets: MultiViewObservationBundle,
  contactCrops: readonly CropRequest[] | CropRequestSet,
  duringPackets: readonly MultiViewObservationBundle[],
  viewQualityReports: readonly ViewQualityReportSet[],
  verificationBundle: VerificationObservationBundle | undefined,
  consensusReport: MultiViewConsensusReport | undefined,
  policy: NormalizedVisualEvidencePolicy,
  issues: ValidationIssue[],
): void {
  if (policy.retention_ttl_s <= 0 || policy.max_views_per_temporal_role <= 0 || policy.min_quality_score < 0 || policy.min_quality_score > 1) {
    issues.push(makeIssue("error", "EvidencePolicyInvalid", "$.policy", "Visual evidence policy requires positive retention/view limits and a quality score in [0, 1].", "Provide finite retention, view count, and quality thresholds."));
  }
  const hiddenInput = { anomalyEvent, beforePackets, afterPackets, contactCrops, duringPackets, verificationBundle, consensusReport };
  if (HIDDEN_VISUAL_EVIDENCE_PATTERN.test(JSON.stringify(hiddenInput))) {
    const severity: ValidationSeverity = policy.hidden_source_action === "reject" ? "error" : "warning";
    issues.push(makeIssue(severity, "HiddenVisualEvidenceLeak", "$.inputs", "Visual evidence input includes hidden simulator, backend, QA, debug, or asset identifiers.", "Rebuild evidence from declared camera packets, visible crops, and public perception records only."));
  }
  if (Object.keys(afterPackets.view_packets).length === 0) {
    issues.push(makeIssue("error", "NoCurrentCameraEvidence", "$.after_packets.view_packets", "Oops evidence requires at least one current after-view camera packet.", "Capture after-views once the anomaly state stabilizes."));
  }
  if (beforePackets === undefined || Object.keys(beforePackets.view_packets).length === 0) {
    issues.push(makeIssue("warning", "BeforeEvidenceMissing", "$.before_packets", "Before-view evidence is absent for this anomaly.", "Retrieve pre-action evidence from the observation or verification ledger."));
  }
  if (afterPackets.sync_quality === "desynchronized" || duringPackets.some((bundle) => bundle.sync_quality === "desynchronized") || beforePackets?.sync_quality === "desynchronized") {
    issues.push(makeIssue("warning", "DesynchronizedEvidence", "$.sync_quality", "At least one evidence bundle is desynchronized.", "Recapture tight-sync views before making fine visual correction claims."));
  }
  const qualityRefs = new Set(viewQualityReports.map((report) => report.bundle_ref));
  for (const bundle of [beforePackets, afterPackets, ...duringPackets].filter(isBundle)) {
    if (qualityRefs.size > 0 && !qualityRefs.has(bundle.bundle_ref)) {
      issues.push(makeIssue("warning", "QualityReportMismatch", `$.view_quality_reports.${bundle.bundle_ref}`, `No supplied quality report matches bundle ${bundle.bundle_ref}.`, "Attach the matching File 09 view quality report for calibrated confidence."));
    }
  }
  if (verificationBundle !== undefined && verificationBundle.source_bundle_ref !== afterPackets.bundle_ref) {
    issues.push(makeIssue("warning", "VerificationBundleMismatch", "$.verification_bundle.source_bundle_ref", "Verification evidence does not reference the after-view bundle.", "Use the verification bundle assembled from the same final-state view capture."));
  }
  if (consensusReport !== undefined && ![beforePackets?.bundle_ref, afterPackets.bundle_ref, ...duringPackets.map((bundle) => bundle.bundle_ref)].includes(consensusReport.bundle_ref)) {
    issues.push(makeIssue("warning", "ConsensusBundleMismatch", "$.consensus_report.bundle_ref", "Consensus report does not match any visual evidence bundle.", "Use consensus from before, during, or after visual evidence only."));
  }
}

function buildFrameRecords(
  bundle: MultiViewObservationBundle | undefined,
  temporalRole: EvidenceTemporalRole,
  requiredViews: readonly CanonicalViewName[],
  qualityReports: readonly ViewQualityReportSet[],
  anomalyEvent: VisualAnomalyEvent,
  policy: NormalizedVisualEvidencePolicy,
  issues: ValidationIssue[],
): readonly VisualEvidenceFrameRecord[] {
  if (bundle === undefined) {
    return freezeArray(requiredViews.map((viewName) => missingFrameRecord(viewName, temporalRole, anomalyEvent, policy, "Required evidence bundle is absent.")));
  }
  const qualityReport = qualityReports.find((report) => report.bundle_ref === bundle.bundle_ref);
  const packetViews = Object.keys(bundle.view_packets) as CanonicalViewName[];
  const selectedViews = uniqueViews([
    ...requiredViews,
    ...packetViews.sort((a, b) => viewSortRank(a) - viewSortRank(b)),
  ]).slice(0, policy.max_views_per_temporal_role);
  const records = selectedViews.map((viewName) => {
    const packet = bundle.view_packets[viewName];
    const quality = qualityReport?.per_view_reports.find((report) => report.view_name === viewName);
    if (packet === undefined) {
      return missingFrameRecord(viewName, temporalRole, anomalyEvent, policy, `Required ${temporalRole} view ${viewName} is absent from bundle ${bundle.bundle_ref}.`);
    }
    return packetFrameRecord(packet, temporalRole, bundle, quality, anomalyEvent, policy);
  });
  for (const record of records) {
    if (record.evidence_status === "missing" && temporalRole === "after" && policy.require_after_view) {
      issues.push(makeIssue("error", "AfterEvidenceMissing", `$.${temporalRole}_views.${record.source_view_name}`, `Required after-view ${record.source_view_name} is missing.`, "Capture current after-views before Oops correction."));
    }
    if (record.evidence_status === "missing" && temporalRole === "before") {
      issues.push(makeIssue("warning", "BeforeEvidenceMissing", `$.${temporalRole}_views.${record.source_view_name}`, `Required before-view ${record.source_view_name} is missing.`, "Retrieve pre-action observation evidence when available."));
    }
  }
  return freezeArray(records);
}

function packetFrameRecord(
  packet: SynchronizedViewPacket,
  temporalRole: EvidenceTemporalRole,
  bundle: MultiViewObservationBundle,
  quality: ViewQualityReport | undefined,
  anomalyEvent: VisualAnomalyEvent,
  policy: NormalizedVisualEvidencePolicy,
): VisualEvidenceFrameRecord {
  const evidenceStatus = frameStatus(packet, quality, policy);
  const retentionClass = retentionClassFor(anomalyEvent, temporalRole, policy);
  const evidenceRef = makeRef("visual_evidence_frame", temporalRole, packet.canonical_view_name, packet.packet_ref, anomalyEvent.anomaly_event_ref);
  const shell = {
    evidenceRef,
    role: temporalRole,
    view: packet.canonical_view_name,
    packet: packet.packet_ref,
    quality: quality?.quality_score,
    status: evidenceStatus,
  };
  return Object.freeze({
    evidence_ref: evidenceRef,
    temporal_role: temporalRole,
    source_view_name: packet.canonical_view_name,
    source_camera_packet_ref: packet.packet_ref,
    image_ref: packet.image_ref,
    depth_ref: packet.depth_ref,
    timestamp_midpoint_s: packet.midpoint_s,
    health_status: quality?.health_status ?? normalizeHealth(packet.health_status),
    quality_score: quality?.quality_score ?? roundScore(packet.confidence),
    target_visibility: quality?.target_visibility,
    evidence_status: evidenceStatus,
    retention_class: retentionClass,
    retention_expires_at_s: retentionClass === "audit_retained" ? undefined : round6(anomalyEvent.detected_at_s + policy.retention_ttl_s),
    provenance_summary: `Declared ${temporalRole} camera packet ${packet.packet_ref} from ${packet.canonical_view_name}; sync=${bundle.sync_quality}; calibration=${packet.calibration_ref}.`,
    evidence_summary: summarizeFrame(packet, temporalRole, quality, evidenceStatus),
    determinism_hash: computeDeterminismHash(shell),
  });
}

function missingFrameRecord(
  viewName: CanonicalViewName,
  temporalRole: EvidenceTemporalRole,
  anomalyEvent: VisualAnomalyEvent,
  policy: NormalizedVisualEvidencePolicy,
  reason: string,
): VisualEvidenceFrameRecord {
  const evidenceRef = makeRef("visual_evidence_missing", temporalRole, viewName, anomalyEvent.anomaly_event_ref);
  return Object.freeze({
    evidence_ref: evidenceRef,
    temporal_role: temporalRole,
    source_view_name: viewName,
    evidence_status: "missing",
    retention_class: policy.retain_audit_copy ? "audit_retained" : "oops_short_term",
    retention_expires_at_s: policy.retain_audit_copy ? undefined : round6(anomalyEvent.detected_at_s + policy.retention_ttl_s),
    provenance_summary: `No declared ${temporalRole} packet was available for ${viewName}.`,
    evidence_summary: sanitizeText(reason),
    determinism_hash: computeDeterminismHash({ evidenceRef, temporalRole, viewName, missing: true }),
  });
}

function buildContactCropEvidence(
  crops: readonly CropRequest[],
  beforeBundle: MultiViewObservationBundle | undefined,
  afterBundle: MultiViewObservationBundle,
  duringBundles: readonly MultiViewObservationBundle[],
  anomalyEvent: VisualAnomalyEvent,
  policy: NormalizedVisualEvidencePolicy,
  issues: ValidationIssue[],
): readonly ContactRegionCropEvidence[] {
  const evidence: ContactRegionCropEvidence[] = [];
  for (const crop of crops) {
    const sourceBundle = findBundleForPacket(crop.source_camera_packet_ref, beforeBundle, afterBundle, duringBundles);
    if (sourceBundle === undefined) {
      issues.push(makeIssue("warning", "ContactCropSourceMissing", `$.contact_crops.${crop.crop_ref}`, `Contact crop ${crop.crop_ref} references a packet outside supplied evidence bundles.`, "Attach crops only from before, during, or after camera evidence."));
      continue;
    }
    if (!crop.context_preservation_ok) {
      issues.push(makeIssue("warning", "ContactCropContextInsufficient", `$.contact_crops.${crop.crop_ref}.context_preservation_ok`, `Contact crop ${crop.crop_ref} may be too tight for failure diagnosis.`, "Use a broad-plus-focused crop that preserves gripper, target, support, and obstacle context."));
    }
    evidence.push(toContactCropEvidence(crop, temporalRoleForBundle(sourceBundle, beforeBundle, afterBundle), anomalyEvent, policy));
  }
  return freezeArray(evidence);
}

function toContactCropEvidence(
  crop: CropRequest,
  temporalRole: EvidenceTemporalRole,
  anomalyEvent: VisualAnomalyEvent,
  policy: NormalizedVisualEvidencePolicy,
): ContactRegionCropEvidence {
  const evidenceRef = makeRef("contact_region_crop_evidence", temporalRole, crop.crop_ref, anomalyEvent.anomaly_event_ref);
  const retentionClass = retentionClassFor(anomalyEvent, temporalRole, policy);
  const shell = {
    evidenceRef,
    crop: crop.crop_ref,
    view: crop.source_view_name,
    role: temporalRole,
    quality: crop.source_quality_score,
    target: crop.target_label,
  };
  return Object.freeze({
    evidence_ref: evidenceRef,
    crop_ref: crop.crop_ref,
    source_view_name: crop.source_view_name,
    source_camera_packet_ref: crop.source_camera_packet_ref,
    target_label: crop.target_label,
    region_definition: crop.region_definition,
    source_quality_score: crop.source_quality_score,
    temporal_role: temporalRole,
    context_preservation_ok: crop.context_preservation_ok,
    retention_class: retentionClass,
    inclusion_reason: summarizeCropInclusion(crop, anomalyEvent),
    determinism_hash: computeDeterminismHash(shell),
  });
}

function missingFromFrameRecords(records: readonly VisualEvidenceFrameRecord[], evidenceKind: MissingEvidenceKind): readonly MissingVisualEvidenceRecord[] {
  return freezeArray(records
    .filter((record) => record.evidence_status === "missing" || record.evidence_status === "stale" || record.evidence_status === "occluded")
    .map((record) => Object.freeze({
      missing_ref: makeRef("missing_evidence", evidenceKind, record.temporal_role, record.source_view_name, record.evidence_status),
      evidence_kind: evidenceKind,
      temporal_role: record.temporal_role,
      canonical_view_name: record.source_view_name,
      reason: `${record.temporal_role} ${record.source_view_name} evidence status is ${record.evidence_status}.`,
      recommended_recovery: recoveryForFrameStatus(record.evidence_status),
    })));
}

function missingContactEvidence(
  anomalyEvent: VisualAnomalyEvent,
  crops: readonly ContactRegionCropEvidence[],
  policy: NormalizedVisualEvidencePolicy,
): readonly MissingVisualEvidenceRecord[] {
  if (!policy.require_contact_crop_for_contact_events || !requiresContactCrop(anomalyEvent) || crops.length > 0) {
    return freezeArray([] as readonly MissingVisualEvidenceRecord[]);
  }
  return freezeArray(policy.required_contact_views.map((viewName) => Object.freeze({
    missing_ref: makeRef("missing_evidence", "contact_crop", anomalyEvent.anomaly_event_ref, viewName),
    evidence_kind: "contact_crop" as const,
    temporal_role: "during" as const,
    canonical_view_name: viewName,
    reason: `Anomaly category ${anomalyEvent.category} needs a failure-focused contact crop from ${viewName}.`,
    recommended_recovery: "reobserve" as const,
  })));
}

function missingQualityReports(
  beforeBundle: MultiViewObservationBundle | undefined,
  afterBundle: MultiViewObservationBundle,
  duringBundles: readonly MultiViewObservationBundle[],
  qualityReports: readonly ViewQualityReportSet[],
): readonly MissingVisualEvidenceRecord[] {
  const qualityRefs = new Set(qualityReports.map((report) => report.bundle_ref));
  return freezeArray([beforeBundle, afterBundle, ...duringBundles]
    .filter(isBundle)
    .filter((bundle) => !qualityRefs.has(bundle.bundle_ref))
    .map((bundle) => Object.freeze({
      missing_ref: makeRef("missing_evidence", "quality_report", bundle.bundle_ref),
      evidence_kind: "quality_report" as const,
      reason: `No view quality report supplied for bundle ${bundle.bundle_ref}.`,
      recommended_recovery: "continue" as const,
    })));
}

function missingFromVerification(verificationBundle: VerificationObservationBundle): readonly MissingVisualEvidenceRecord[] {
  const missingViews = [
    ...verificationBundle.provided_views,
    ...verificationBundle.inventory_views,
  ].filter((view) => view.status === "missing" || view.status === "occluded");
  return freezeArray(missingViews.map((view) => Object.freeze({
    missing_ref: makeRef("missing_evidence", "verification_context", verificationBundle.verification_bundle_ref, view.source_view_name, view.status),
    evidence_kind: "verification_context" as const,
    temporal_role: "after" as const,
    canonical_view_name: view.source_view_name,
    reason: `Verification context marks ${view.source_view_name} as ${view.status}.`,
    recommended_recovery: view.status === "missing" ? "reobserve" as const : "safe_hold" as const,
  })));
}

function inferObjectVisibilityChange(
  anomalyEvent: VisualAnomalyEvent,
  afterViews: readonly VisualEvidenceFrameRecord[],
  verificationBundle: VerificationObservationBundle | undefined,
  consensusReport: MultiViewConsensusReport | undefined,
): ObjectVisibilityChange {
  if (anomalyEvent.category === "drop") return "dropped";
  if (anomalyEvent.category === "occluded_target") return "occluded";
  if (anomalyEvent.category === "collision" || anomalyEvent.category === "overshoot" || anomalyEvent.category === "tool_deflection") return "moved";
  const targetLabel = anomalyEvent.target_label;
  const consensusObject = targetLabel === undefined
    ? undefined
    : consensusReport?.consensus_objects.find((object) => labelsMatch(object.label, targetLabel));
  if (consensusObject?.status === "lost") return "lost";
  if (consensusObject?.status === "occluded_or_out_of_view") return "occluded";
  if (verificationBundle?.occlusion_status === "hidden") return "occluded";
  if (afterViews.some((view) => view.target_visibility === "full" || view.target_visibility === "partial")) return "visible";
  if (afterViews.some((view) => view.target_visibility === "not_in_frame")) return "lost";
  if (afterViews.some((view) => view.target_visibility === "occluded" || view.evidence_status === "occluded")) return "occluded";
  if (anomalyEvent.category === "slip") return "moved";
  return "unknown";
}

function buildCauseHints(
  anomalyEvent: VisualAnomalyEvent,
  beforeViews: readonly VisualEvidenceFrameRecord[],
  duringViews: readonly VisualEvidenceFrameRecord[],
  afterViews: readonly VisualEvidenceFrameRecord[],
  contactCrops: readonly ContactRegionCropEvidence[],
  verificationBundle: VerificationObservationBundle | undefined,
  consensusReport: MultiViewConsensusReport | undefined,
): readonly VisualCauseHint[] {
  const hints: VisualCauseHint[] = [];
  hints.push(categoryHint(anomalyEvent, beforeViews, duringViews, afterViews, contactCrops));
  for (const crop of contactCrops.filter((item) => !item.context_preservation_ok || item.source_quality_score < 0.5)) {
    hints.push(makeHint("unknown", [crop.evidence_ref], 0.48, `Contact crop ${crop.crop_ref} has limited context or low quality; correction should reobserve contact geometry.`));
  }
  if (verificationBundle !== undefined) {
    for (const risk of verificationBundle.false_positive_risks.filter((item) => !item.resolved)) {
      hints.push(makeHint(risk.risk_kind === "gripper_or_tool_occlusion" ? "occluded_target" : anomalyEvent.category, [risk.risk_ref], risk.severity === "blocking" ? 0.72 : 0.55, risk.description));
    }
  }
  if (consensusReport !== undefined) {
    for (const conflict of consensusReport.view_conflicts.filter(isBlockingConflict)) {
      hints.push(makeHint("unknown", [conflict.conflict_ref], 0.58, conflict.summary));
    }
  }
  return freezeArray(dedupeHints(hints));
}

function categoryHint(
  anomalyEvent: VisualAnomalyEvent,
  beforeViews: readonly VisualEvidenceFrameRecord[],
  duringViews: readonly VisualEvidenceFrameRecord[],
  afterViews: readonly VisualEvidenceFrameRecord[],
  contactCrops: readonly ContactRegionCropEvidence[],
): VisualCauseHint {
  const sourceRefs = [
    ...beforeViews,
    ...duringViews,
    ...afterViews,
  ].filter((view) => view.evidence_status !== "missing").map((view) => view.evidence_ref);
  const cropRefs = contactCrops.map((crop) => crop.evidence_ref);
  const visibilityPenalty = afterViews.some((view) => view.evidence_status === "occluded" || view.evidence_status === "missing") ? 0.16 : 0;
  const cropBoost = contactCrops.length > 0 ? 0.1 : 0;
  return makeHint(anomalyEvent.category, [...sourceRefs, ...cropRefs], roundScore(0.62 + cropBoost - visibilityPenalty), categorySummary(anomalyEvent, contactCrops.length));
}

function buildMemoryHandoffCandidates(
  bundleRef: Ref,
  anomalyEvent: VisualAnomalyEvent,
  visibilityChange: ObjectVisibilityChange,
  beforeViews: readonly VisualEvidenceFrameRecord[],
  afterViews: readonly VisualEvidenceFrameRecord[],
  contactCrops: readonly ContactRegionCropEvidence[],
  hints: readonly VisualCauseHint[],
  consensusReport: MultiViewConsensusReport | undefined,
): readonly VisualMemoryHandoffCandidate[] {
  const sourceViews = uniqueViews([...beforeViews, ...afterViews, ...contactCrops].map((item) => item.source_view_name));
  const contradictionLinks = consensusReport?.view_conflicts.map((conflict) => conflict.conflict_ref).sort() ?? [];
  const confidenceBase = averageScore(afterViews.map((view) => view.quality_score).filter(isNumber));
  const hintSummary = hints.slice(0, 2).map((hint) => hint.summary).join(" ");
  const descriptor = sanitizeText([
    anomalyEvent.target_label === undefined ? "Target unspecified" : `Target ${anomalyEvent.target_label}`,
    `visual change ${visibilityChange}`,
    `anomaly ${anomalyEvent.category}`,
    hintSummary,
  ].filter((part) => part.length > 0).join("; "));
  const candidateRef = makeRef("visual_memory_candidate", bundleRef, anomalyEvent.anomaly_event_ref, visibilityChange);
  return freezeArray([Object.freeze({
    memory_candidate_ref: candidateRef,
    source_failure_visual_bundle_ref: bundleRef,
    anomaly_event_ref: anomalyEvent.anomaly_event_ref,
    visual_descriptor: descriptor,
    source_views: sourceViews,
    confidence: roundScore(Math.max(0.2, Math.min(0.9, confidenceBase))),
    staleness_hint: stalenessHintFor(anomalyEvent, visibilityChange),
    contradiction_links: freezeArray(contradictionLinks),
  })]);
}

function decideEvidenceBundle(
  afterViews: readonly VisualEvidenceFrameRecord[],
  missingEvidence: readonly MissingVisualEvidenceRecord[],
  issues: readonly ValidationIssue[],
  policy: NormalizedVisualEvidencePolicy,
): VisualEvidenceDecision {
  if (issues.some((issue) => issue.severity === "error") || (policy.require_after_view && afterViews.every((view) => view.evidence_status === "missing"))) {
    return "rejected";
  }
  if (missingEvidence.length > 0 || issues.length > 0 || afterViews.some((view) => view.evidence_status !== "included" && view.evidence_status !== "context_only")) {
    return "recorded_with_warnings";
  }
  return "recorded";
}

function chooseRecommendedAction(
  decision: VisualEvidenceDecision,
  anomalyEvent: VisualAnomalyEvent,
  afterBundle: MultiViewObservationBundle,
  missingEvidence: readonly MissingVisualEvidenceRecord[],
  issues: readonly ValidationIssue[],
): VisualEvidenceRecommendedAction {
  if (issues.some((issue) => issue.code === "HiddenVisualEvidenceLeak" && issue.severity === "error")) return "human_review";
  if (afterBundle.sync_quality === "desynchronized") return "recapture";
  if (decision === "rejected") return anomalyEvent.severity === "critical" ? "safe_hold" : "reobserve";
  if (missingEvidence.some((missing) => missing.evidence_kind === "after_view" || missing.evidence_kind === "contact_crop")) return "reobserve";
  if (anomalyEvent.severity === "critical") return "safe_hold";
  return "continue";
}

function frameStatus(
  packet: SynchronizedViewPacket,
  quality: ViewQualityReport | undefined,
  policy: NormalizedVisualEvidencePolicy,
): EvidenceFrameStatus {
  const health = normalizeHealth(packet.health_status);
  if (health === "missing") return "missing";
  if (health === "stale") return "stale";
  if (quality?.target_visibility === "occluded" || quality?.target_visibility === "not_in_frame") return "occluded";
  const qualityScore = quality?.quality_score ?? packet.confidence;
  if (health === "degraded" || packet.packet_status === "degraded" || qualityScore < policy.min_quality_score) return "degraded";
  return "included";
}

function retentionClassFor(
  anomalyEvent: VisualAnomalyEvent,
  temporalRole: EvidenceTemporalRole,
  policy: NormalizedVisualEvidencePolicy,
): RetentionClass {
  if (policy.retain_audit_copy || anomalyEvent.severity === "critical") return "audit_retained";
  if (temporalRole === "after" && policy.include_memory_handoff) return "memory_candidate";
  return "oops_short_term";
}

function normalizeCropRequests(contactCrops: readonly CropRequest[] | CropRequestSet): readonly CropRequest[] {
  return "crop_requests" in contactCrops ? contactCrops.crop_requests : freezeArray(contactCrops);
}

function findBundleForPacket(
  packetRef: Ref,
  beforeBundle: MultiViewObservationBundle | undefined,
  afterBundle: MultiViewObservationBundle,
  duringBundles: readonly MultiViewObservationBundle[],
): MultiViewObservationBundle | undefined {
  return [beforeBundle, afterBundle, ...duringBundles].filter(isBundle).find((bundle) => Object.values(bundle.view_packets).some((packet) => packet?.packet_ref === packetRef));
}

function temporalRoleForBundle(
  bundle: MultiViewObservationBundle,
  beforeBundle: MultiViewObservationBundle | undefined,
  afterBundle: MultiViewObservationBundle,
): EvidenceTemporalRole {
  if (beforeBundle !== undefined && bundle.bundle_ref === beforeBundle.bundle_ref) return "before";
  if (bundle.bundle_ref === afterBundle.bundle_ref) return "after";
  return "during";
}

function requiresContactCrop(anomalyEvent: VisualAnomalyEvent): boolean {
  return anomalyEvent.category === "missed_grasp"
    || anomalyEvent.category === "slip"
    || anomalyEvent.category === "drop"
    || anomalyEvent.category === "collision"
    || anomalyEvent.category === "tool_deflection";
}

function summarizeFrame(
  packet: SynchronizedViewPacket,
  temporalRole: EvidenceTemporalRole,
  quality: ViewQualityReport | undefined,
  status: EvidenceFrameStatus,
): string {
  const qualityText = quality === undefined ? `packet confidence ${formatScore(packet.confidence)}` : `quality ${formatScore(quality.quality_score)}, visibility ${quality.target_visibility}`;
  return `${temporalRole} ${packet.canonical_view_name} evidence is ${status}; ${qualityText}.`;
}

function summarizeCropInclusion(crop: CropRequest, anomalyEvent: VisualAnomalyEvent): string {
  const target = crop.target_label === undefined ? "task region" : crop.target_label;
  return sanitizeText(`Crop ${crop.crop_ref} retained as ${crop.crop_reason} evidence for ${anomalyEvent.category}; target=${target}; context preserved=${crop.context_preservation_ok}.`);
}

function categorySummary(anomalyEvent: VisualAnomalyEvent, cropCount: number): string {
  const target = anomalyEvent.target_label === undefined ? "target" : anomalyEvent.target_label;
  switch (anomalyEvent.category) {
    case "missed_grasp":
      return `Missed grasp suspected around ${target}; compare end-effector closure area against object position using ${cropCount} contact crop(s).`;
    case "slip":
      return `Slip suspected for ${target}; compare before/after relative motion and contact patch stability.`;
    case "drop":
      return `Drop suspected for ${target}; after-views should localize the object lower, absent, or newly occluded.`;
    case "collision":
      return `Collision suspected near ${target}; inspect obstacle, swept contact, and displaced object evidence.`;
    case "overshoot":
      return `Overshoot suspected for ${target}; inspect final end-effector region beyond intended contact area.`;
    case "occluded_target":
      return `Target occlusion suspected for ${target}; absence must remain unknown until alternate view confirms state.`;
    case "tool_deflection":
      return `Tool deflection suspected for ${target}; inspect tool contact path, bend, rotation, and target visibility.`;
    case "unknown":
      return `Unknown visual anomaly recorded for ${target}; preserve before/after state and request focused diagnosis.`;
  }
}

function summarizeProvenance(
  beforeBundle: MultiViewObservationBundle | undefined,
  afterBundle: MultiViewObservationBundle,
  duringBundles: readonly MultiViewObservationBundle[],
  crops: readonly ContactRegionCropEvidence[],
  verificationBundle: VerificationObservationBundle | undefined,
  consensusReport: MultiViewConsensusReport | undefined,
): string {
  const bundles = bundleRefs(beforeBundle, afterBundle, duringBundles).join(", ");
  const extras = [
    verificationBundle === undefined ? undefined : `verification=${verificationBundle.verification_bundle_ref}`,
    consensusReport === undefined ? undefined : `consensus=${consensusReport.consensus_ref}`,
    crops.length > 0 ? `contact_crops=${crops.length}` : undefined,
  ].filter(isString).join("; ");
  return sanitizeText(`Sensor-derived visual evidence from declared camera bundles: ${bundles || "none"}.${extras.length > 0 ? ` ${extras}.` : ""}`);
}

function summarizeRetention(policy: NormalizedVisualEvidencePolicy, anomalyEvent: VisualAnomalyEvent): string {
  const audit = policy.retain_audit_copy || anomalyEvent.severity === "critical" ? "audit copy retained" : "no audit copy requested";
  const memory = policy.include_memory_handoff ? "memory handoff candidate emitted" : "memory handoff disabled";
  return `${audit}; short-term Oops TTL ${policy.retention_ttl_s}s; ${memory}.`;
}

function primaryQualityReportRef(afterBundle: MultiViewObservationBundle, reports: readonly ViewQualityReportSet[]): Ref {
  return reports.find((report) => report.bundle_ref === afterBundle.bundle_ref)?.bundle_ref ?? afterBundle.view_quality_report_ref;
}

function sanitizeAnomalyEvent(event: VisualAnomalyEvent): VisualAnomalyEvent {
  return Object.freeze({
    ...event,
    summary: sanitizeText(event.summary),
  });
}

function sanitizeText(value: string): string {
  const cleaned = value.trim().replace(/\s+/g, " ").slice(0, 800);
  return HIDDEN_VISUAL_EVIDENCE_PATTERN.test(cleaned) ? "Visual evidence text redacted because it contained hidden-source wording." : cleaned;
}

function makeHint(category: VisualAnomalyCategory, sourceRefs: readonly Ref[], confidence: number, summary: string): VisualCauseHint {
  const cleanSummary = sanitizeText(summary);
  const hintRef = makeRef("visual_cause_hint", category, sourceRefs.join(":"), cleanSummary.slice(0, 80));
  return Object.freeze({
    hint_ref: hintRef,
    category,
    source_refs: freezeArray([...sourceRefs].sort()),
    confidence: roundScore(confidence),
    summary: cleanSummary,
  });
}

function dedupeHints(hints: readonly VisualCauseHint[]): readonly VisualCauseHint[] {
  const byRef = new Map<Ref, VisualCauseHint>();
  for (const hint of hints) {
    const existing = byRef.get(hint.hint_ref);
    if (existing === undefined || existing.confidence < hint.confidence) {
      byRef.set(hint.hint_ref, hint);
    }
  }
  return freezeArray([...byRef.values()]);
}

function bundleRefs(
  beforeBundle: MultiViewObservationBundle | undefined,
  afterBundle: MultiViewObservationBundle,
  duringBundles: readonly MultiViewObservationBundle[],
): readonly Ref[] {
  return freezeArray([beforeBundle?.bundle_ref, ...duringBundles.map((bundle) => bundle.bundle_ref), afterBundle.bundle_ref].filter(isString).sort());
}

function recoveryForFrameStatus(status: EvidenceFrameStatus): VisualEvidenceRecommendedAction {
  if (status === "stale") return "recapture";
  if (status === "occluded") return "safe_hold";
  if (status === "missing") return "reobserve";
  return "continue";
}

function isBlockingConflict(conflict: ViewConflictRecord): boolean {
  return conflict.severity === "blocking";
}

function labelsMatch(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && normalizeLabel(a) === normalizeLabel(b);
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function normalizeHealth(status: SynchronizedViewPacket["health_status"]): ViewHealthStatus {
  if (status === "missing" || status === "stale" || status === "degraded") return status;
  return "healthy";
}

function averageScore(values: readonly number[]): number {
  if (values.length === 0) return 0.5;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stalenessHintFor(anomalyEvent: VisualAnomalyEvent, change: ObjectVisibilityChange): string {
  if (change === "lost" || change === "dropped" || change === "moved") {
    return `High staleness: ${anomalyEvent.target_label ?? "target"} state changed during ${anomalyEvent.category}.`;
  }
  if (change === "occluded") {
    return "Medium staleness: target state remains visually unresolved behind occlusion.";
  }
  return "Medium staleness: retain only until next successful observation or verification.";
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

function compareFrameRecords(a: VisualEvidenceFrameRecord, b: VisualEvidenceFrameRecord): number {
  return temporalRank(a.temporal_role) - temporalRank(b.temporal_role)
    || viewSortRank(a.source_view_name) - viewSortRank(b.source_view_name)
    || a.evidence_ref.localeCompare(b.evidence_ref);
}

function compareCropEvidence(a: ContactRegionCropEvidence, b: ContactRegionCropEvidence): number {
  return temporalRank(a.temporal_role) - temporalRank(b.temporal_role)
    || viewSortRank(a.source_view_name) - viewSortRank(b.source_view_name)
    || a.crop_ref.localeCompare(b.crop_ref);
}

function compareMissingRecords(a: MissingVisualEvidenceRecord, b: MissingVisualEvidenceRecord): number {
  return (a.temporal_role ?? "").localeCompare(b.temporal_role ?? "")
    || a.evidence_kind.localeCompare(b.evidence_kind)
    || (a.canonical_view_name ?? "").localeCompare(b.canonical_view_name ?? "")
    || a.missing_ref.localeCompare(b.missing_ref);
}

function compareCauseHints(a: VisualCauseHint, b: VisualCauseHint): number {
  return b.confidence - a.confidence || a.category.localeCompare(b.category) || a.hint_ref.localeCompare(b.hint_ref);
}

function temporalRank(role: EvidenceTemporalRole): number {
  const ranks: Readonly<Record<EvidenceTemporalRole, number>> = {
    before: 0,
    during: 1,
    after: 2,
  };
  return ranks[role];
}

function mergePolicy(base: NormalizedVisualEvidencePolicy, override: VisualEvidencePolicy): NormalizedVisualEvidencePolicy {
  return Object.freeze({
    required_before_views: freezeArray(override.required_before_views ?? base.required_before_views),
    required_after_views: freezeArray(override.required_after_views ?? base.required_after_views),
    required_contact_views: freezeArray(override.required_contact_views ?? base.required_contact_views),
    min_quality_score: clamp01(override.min_quality_score ?? base.min_quality_score),
    max_views_per_temporal_role: positiveIntOrDefault(override.max_views_per_temporal_role, base.max_views_per_temporal_role),
    retention_ttl_s: positiveOrDefault(override.retention_ttl_s, base.retention_ttl_s),
    retain_audit_copy: override.retain_audit_copy ?? base.retain_audit_copy,
    include_memory_handoff: override.include_memory_handoff ?? base.include_memory_handoff,
    require_after_view: override.require_after_view ?? base.require_after_view,
    require_contact_crop_for_contact_events: override.require_contact_crop_for_contact_events ?? base.require_contact_crop_for_contact_events,
    hidden_source_action: override.hidden_source_action ?? base.hidden_source_action,
  });
}

function isBundle(value: MultiViewObservationBundle | undefined): value is MultiViewObservationBundle {
  return value !== undefined;
}

function isNumber(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

function isString(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

function uniqueViews(values: readonly CanonicalViewName[]): readonly CanonicalViewName[] {
  return freezeArray([...new Set(values)].sort((a, b) => viewSortRank(a) - viewSortRank(b)));
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

function makeIssue(severity: ValidationSeverity, code: VisualEvidenceIssueCode, path: string, message: string, remediation: string): ValidationIssue {
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
