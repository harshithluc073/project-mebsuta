/**
 * Memory write gate for Project Mebsuta episodic spatial memory.
 *
 * Blueprint: `architecture_docs/15_RAG_EPISODIC_SPATIAL_MEMORY_ARCHITECTURE.md`
 * sections 15.2, 15.4, 15.5, 15.6, 15.8, 15.9, 15.19, 15.20, and 15.24.
 *
 * The gate is the executable File 15 boundary that keeps runtime memory
 * simulation-blind, certificate-aware, and explicit about uncertainty.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Quaternion, Ref, ValidationIssue, ValidationSeverity, Vector3 } from "../simulation/world_manifest";

export const MEMORY_WRITE_GATE_SCHEMA_VERSION = "mebsuta.memory_write_gate.v1" as const;
export const MEMORY_BLUEPRINT_REF = "architecture_docs/15_RAG_EPISODIC_SPATIAL_MEMORY_ARCHITECTURE.md" as const;

export const HIDDEN_MEMORY_PATTERN =
  /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|qa_success|qa_label|qa_only|simulator truth|mesh_name|asset_id|benchmark_truth|oracle_pose|debug_buffer|debug_overlay)/i;

export type MemoryRecordClass =
  | "verified_spatial"
  | "observed_spatial"
  | "search_hint"
  | "contradiction"
  | "task_episode"
  | "oops_episode"
  | "tool_use"
  | "acoustic_event"
  | "safety";

export type MemoryLifecycleState = "candidate" | "active" | "fresh" | "stale" | "contradicted" | "superseded" | "archived" | "quarantined";
export type MemoryConfidenceClass = "verified" | "high_observed" | "medium_observed" | "low_hypothesis" | "contradicted" | "quarantined";
export type MemoryTruthBoundaryStatus = "runtime_embodied_only" | "contains_forbidden_truth" | "qa_boundary";
export type MemoryRetrievalAudience = "cognition" | "perception" | "verification" | "oops_loop" | "audit" | "qa";
export type MemoryWriteAction = "write_verified_spatial" | "write_observed_spatial" | "write_contradiction" | "write_episode" | "quarantine" | "reject";
export type MemoryIssueCode =
  | "MemoryPolicyInvalid"
  | "MemoryEvidenceMissing"
  | "MemoryCertificateMissing"
  | "MemoryCertificateWeak"
  | "MemoryEvidenceStale"
  | "MemoryPoseUncertain"
  | "MemoryTruthBoundaryBlocked"
  | "MemoryHiddenSourceLeak"
  | "MemorySchemaInvalid";

export interface MemoryRetrievalPermissions {
  readonly cognitive: boolean;
  readonly perception: boolean;
  readonly verification: boolean;
  readonly oops_loop: boolean;
  readonly audit: boolean;
  readonly qa: boolean;
}

export interface MemoryRecordBase {
  readonly memory_record_ref: Ref;
  readonly record_class: MemoryRecordClass;
  readonly created_at_ms: number;
  readonly source_event_refs: readonly Ref[];
  readonly source_evidence_refs: readonly Ref[];
  readonly provenance_manifest_ref: Ref;
  readonly truth_boundary_status: MemoryTruthBoundaryStatus;
  readonly confidence_class: MemoryConfidenceClass;
  readonly lifecycle_state: MemoryLifecycleState;
  readonly staleness_score: number;
  readonly retrieval_permissions: MemoryRetrievalPermissions;
  readonly audit_replay_refs: readonly Ref[];
  readonly allowed_prompt_summary: string;
  readonly determinism_hash: string;
}

export interface MemoryPoseEstimate {
  readonly frame_ref: Ref;
  readonly position_m?: Vector3;
  readonly orientation_xyzw?: Quaternion;
  readonly region_ref?: Ref;
  readonly uncertainty_m: number;
  readonly relation_refs: readonly Ref[];
}

export interface MemoryEvidenceManifest {
  readonly provenance_manifest_ref: Ref;
  readonly source_event_refs: readonly Ref[];
  readonly source_evidence_refs: readonly Ref[];
  readonly source_kind: "verification_certificate" | "perception_observation" | "oops_episode" | "acoustic_event" | "safety_event" | "tool_event";
  readonly truth_boundary_status: MemoryTruthBoundaryStatus;
  readonly evidence_timestamp_ms: number;
  readonly prompt_safe_summary: string;
}

export interface MemorySourceArtifact {
  readonly artifact_ref: Ref;
  readonly requested_record_class: MemoryRecordClass;
  readonly confidence: number;
  readonly certificate_ref?: Ref;
  readonly pose?: MemoryPoseEstimate;
  readonly summary: string;
  readonly contradiction_refs?: readonly Ref[];
}

export interface MemoryWritePolicy {
  readonly policy_ref: Ref;
  readonly min_verified_confidence?: number;
  readonly min_observed_confidence?: number;
  readonly max_pose_uncertainty_m?: number;
  readonly max_evidence_age_ms?: number;
  readonly allow_observed_writes?: boolean;
  readonly allow_contradiction_writes?: boolean;
  readonly allow_episode_writes?: boolean;
  readonly quarantine_hidden_sources?: boolean;
}

export interface MemoryWriteDecision {
  readonly schema_version: typeof MEMORY_WRITE_GATE_SCHEMA_VERSION;
  readonly blueprint_ref: typeof MEMORY_BLUEPRINT_REF;
  readonly decision_ref: Ref;
  readonly source_artifact_ref: Ref;
  readonly action: MemoryWriteAction;
  readonly target_record_class: MemoryRecordClass;
  readonly accepted: boolean;
  readonly confidence_class: MemoryConfidenceClass;
  readonly lifecycle_state: MemoryLifecycleState;
  readonly accepted_evidence_refs: readonly Ref[];
  readonly blocked_fields: readonly string[];
  readonly required_followup: "none" | "reobserve" | "verify" | "audit" | "human_review";
  readonly reason: string;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
  readonly cognitive_visibility: "memory_write_decision";
}

export interface MemoryWriteGateReport {
  readonly schema_version: typeof MEMORY_WRITE_GATE_SCHEMA_VERSION;
  readonly blueprint_ref: typeof MEMORY_BLUEPRINT_REF;
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly decision: MemoryWriteDecision;
  readonly ok: boolean;
  readonly determinism_hash: string;
  readonly cognitive_visibility: "memory_write_gate_report";
}

interface NormalizedMemoryWritePolicy {
  readonly policy_ref: Ref;
  readonly min_verified_confidence: number;
  readonly min_observed_confidence: number;
  readonly max_pose_uncertainty_m: number;
  readonly max_evidence_age_ms: number;
  readonly allow_observed_writes: boolean;
  readonly allow_contradiction_writes: boolean;
  readonly allow_episode_writes: boolean;
  readonly quarantine_hidden_sources: boolean;
}

const DEFAULT_POLICY: NormalizedMemoryWritePolicy = Object.freeze({
  policy_ref: "memory_policy:file15:default",
  min_verified_confidence: 0.82,
  min_observed_confidence: 0.46,
  max_pose_uncertainty_m: 0.08,
  max_evidence_age_ms: 9000,
  allow_observed_writes: true,
  allow_contradiction_writes: true,
  allow_episode_writes: true,
  quarantine_hidden_sources: true,
});

export class MemoryWriteGate {
  private readonly policy: NormalizedMemoryWritePolicy;

  public constructor(policy: MemoryWritePolicy = { policy_ref: DEFAULT_POLICY.policy_ref }) {
    this.policy = mergeMemoryWritePolicy(DEFAULT_POLICY, policy);
  }

  /**
   * Evaluates a candidate runtime memory update against File 15 gates.
   */
  public evaluateMemoryWrite(
    sourceArtifact: MemorySourceArtifact,
    evidenceManifest: MemoryEvidenceManifest,
    memoryPolicy: MemoryWritePolicy = { policy_ref: this.policy.policy_ref },
    currentTimeMs = evidenceManifest.evidence_timestamp_ms,
    requestRef?: Ref,
  ): MemoryWriteGateReport {
    const policy = mergeMemoryWritePolicy(this.policy, memoryPolicy);
    const issues: ValidationIssue[] = [];
    validateWriteInputs(sourceArtifact, evidenceManifest, policy, currentTimeMs, issues);
    const decision = decideMemoryWrite(sourceArtifact, evidenceManifest, policy, currentTimeMs, issues);
    const safeRequestRef = cleanMemoryRef(requestRef ?? makeMemoryRef("memory_write_request", sourceArtifact.artifact_ref));
    const base = {
      schema_version: MEMORY_WRITE_GATE_SCHEMA_VERSION,
      blueprint_ref: MEMORY_BLUEPRINT_REF,
      report_ref: makeMemoryRef("memory_write_gate_report", safeRequestRef, decision.action),
      request_ref: safeRequestRef,
      decision,
      ok: decision.accepted,
      cognitive_visibility: "memory_write_gate_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function evaluateMemoryWrite(
  sourceArtifact: MemorySourceArtifact,
  evidenceManifest: MemoryEvidenceManifest,
  memoryPolicy: MemoryWritePolicy,
  currentTimeMs = evidenceManifest.evidence_timestamp_ms,
): MemoryWriteGateReport {
  return new MemoryWriteGate(memoryPolicy).evaluateMemoryWrite(sourceArtifact, evidenceManifest, memoryPolicy, currentTimeMs);
}

function decideMemoryWrite(
  sourceArtifact: MemorySourceArtifact,
  evidenceManifest: MemoryEvidenceManifest,
  policy: NormalizedMemoryWritePolicy,
  currentTimeMs: number,
  issues: readonly ValidationIssue[],
): MemoryWriteDecision {
  const fatal = issues.some((issue) => issue.severity === "error");
  const hidden = issues.some((issue) => issue.code === "MemoryHiddenSourceLeak" || issue.code === "MemoryTruthBoundaryBlocked");
  const ageMs = Math.max(0, currentTimeMs - evidenceManifest.evidence_timestamp_ms);
  const baseConfidence = clamp01(sourceArtifact.confidence);
  const confidenceClass = confidenceClassFor(baseConfidence, sourceArtifact.requested_record_class, hidden);
  const stale = ageMs > policy.max_evidence_age_ms;
  const uncertainPose = sourceArtifact.pose !== undefined && sourceArtifact.pose.uncertainty_m > policy.max_pose_uncertainty_m;
  const missingCertificate = sourceArtifact.requested_record_class === "verified_spatial" && sourceArtifact.certificate_ref === undefined;
  const action = actionFor(sourceArtifact, policy, fatal, hidden, stale, uncertainPose, missingCertificate, baseConfidence);
  const accepted = action !== "reject" && action !== "quarantine";
  const lifecycleState: MemoryLifecycleState = hidden ? "quarantined" : sourceArtifact.requested_record_class === "contradiction" ? "contradicted" : stale ? "stale" : "active";
  const blockedFields = blockedFieldsFor(action, hidden, uncertainPose, stale, missingCertificate);
  const decisionBase = {
    schema_version: MEMORY_WRITE_GATE_SCHEMA_VERSION,
    blueprint_ref: MEMORY_BLUEPRINT_REF,
    decision_ref: makeMemoryRef("memory_write_decision", sourceArtifact.artifact_ref, action),
    source_artifact_ref: cleanMemoryRef(sourceArtifact.artifact_ref),
    action,
    target_record_class: sourceArtifact.requested_record_class,
    accepted,
    confidence_class: hidden ? "quarantined" as const : confidenceClass,
    lifecycle_state: lifecycleState,
    accepted_evidence_refs: accepted ? uniqueMemoryRefs([...evidenceManifest.source_evidence_refs, ...(sourceArtifact.certificate_ref === undefined ? [] : [sourceArtifact.certificate_ref])]) : freezeMemoryArray([]),
    blocked_fields: freezeMemoryArray(blockedFields),
    required_followup: followupFor(action, stale, uncertainPose, missingCertificate),
    reason: reasonFor(action, sourceArtifact, stale, uncertainPose, missingCertificate),
    issues: freezeMemoryArray(issues),
    cognitive_visibility: "memory_write_decision" as const,
  };
  return Object.freeze({ ...decisionBase, determinism_hash: computeDeterminismHash(decisionBase) });
}

function actionFor(
  sourceArtifact: MemorySourceArtifact,
  policy: NormalizedMemoryWritePolicy,
  fatal: boolean,
  hidden: boolean,
  stale: boolean,
  uncertainPose: boolean,
  missingCertificate: boolean,
  confidence: number,
): MemoryWriteAction {
  if (hidden && policy.quarantine_hidden_sources) return "quarantine";
  if (fatal || stale || uncertainPose || missingCertificate) return "reject";
  if (sourceArtifact.requested_record_class === "verified_spatial") return confidence >= policy.min_verified_confidence ? "write_verified_spatial" : "reject";
  if (sourceArtifact.requested_record_class === "observed_spatial" || sourceArtifact.requested_record_class === "search_hint") {
    return policy.allow_observed_writes && confidence >= policy.min_observed_confidence ? "write_observed_spatial" : "reject";
  }
  if (sourceArtifact.requested_record_class === "contradiction") return policy.allow_contradiction_writes ? "write_contradiction" : "reject";
  if (sourceArtifact.requested_record_class === "task_episode" || sourceArtifact.requested_record_class === "oops_episode") return policy.allow_episode_writes ? "write_episode" : "reject";
  return confidence >= policy.min_observed_confidence ? "write_episode" : "reject";
}

function validateWriteInputs(
  sourceArtifact: MemorySourceArtifact,
  evidenceManifest: MemoryEvidenceManifest,
  policy: NormalizedMemoryWritePolicy,
  currentTimeMs: number,
  issues: ValidationIssue[],
): void {
  validatePolicy(policy, issues);
  validateMemoryRef(sourceArtifact.artifact_ref, "$.source_artifact.artifact_ref", issues);
  validateMemoryRef(evidenceManifest.provenance_manifest_ref, "$.evidence_manifest.provenance_manifest_ref", issues);
  for (const ref of [...evidenceManifest.source_event_refs, ...evidenceManifest.source_evidence_refs]) validateMemoryRef(ref, "$.evidence_manifest.refs", issues);
  if (!Number.isFinite(currentTimeMs) || currentTimeMs < 0 || !Number.isFinite(evidenceManifest.evidence_timestamp_ms) || evidenceManifest.evidence_timestamp_ms < 0) {
    issues.push(makeMemoryIssue("error", "MemorySchemaInvalid", "$.time", "Memory time fields must be finite nonnegative milliseconds.", "Use monotonic runtime timestamps."));
  }
  if (evidenceManifest.source_evidence_refs.length === 0) {
    issues.push(makeMemoryIssue("error", "MemoryEvidenceMissing", "$.evidence_manifest.source_evidence_refs", "A memory write requires embodied evidence references.", "Attach camera, audio, contact, controller, or certificate evidence."));
  }
  if (sourceArtifact.requested_record_class === "verified_spatial" && sourceArtifact.certificate_ref === undefined) {
    issues.push(makeMemoryIssue("error", "MemoryCertificateMissing", "$.source_artifact.certificate_ref", "Verified spatial memory requires a certificate reference.", "Route verified writes through the verification certificate boundary."));
  }
  if (sourceArtifact.requested_record_class === "verified_spatial" && sourceArtifact.confidence < policy.min_verified_confidence) {
    issues.push(makeMemoryIssue("warning", "MemoryCertificateWeak", "$.source_artifact.confidence", "Verified memory confidence is below policy threshold.", "Reobserve or keep a lower authority record class."));
  }
  if (sourceArtifact.pose !== undefined && sourceArtifact.pose.uncertainty_m > policy.max_pose_uncertainty_m) {
    issues.push(makeMemoryIssue("error", "MemoryPoseUncertain", "$.source_artifact.pose.uncertainty_m", "Pose uncertainty exceeds the memory write policy.", "Refresh pose evidence before spatial memory storage."));
  }
  if (currentTimeMs - evidenceManifest.evidence_timestamp_ms > policy.max_evidence_age_ms) {
    issues.push(makeMemoryIssue("error", "MemoryEvidenceStale", "$.evidence_manifest.evidence_timestamp_ms", "Evidence is outside the memory freshness window.", "Reobserve before creating runtime memory."));
  }
  if (evidenceManifest.truth_boundary_status !== "runtime_embodied_only") {
    issues.push(makeMemoryIssue("error", "MemoryTruthBoundaryBlocked", "$.evidence_manifest.truth_boundary_status", "Runtime memory accepts only embodied evidence.", "Separate QA or hidden truth material from memory inputs."));
  }
  const text = JSON.stringify({ sourceArtifact, evidenceManifest });
  if (HIDDEN_MEMORY_PATTERN.test(text)) {
    issues.push(makeMemoryIssue("error", "MemoryHiddenSourceLeak", "$.inputs", "Memory input contains hidden simulator, backend, debug, asset, or QA wording.", "Redact hidden-source wording before memory storage."));
  }
}

function validatePolicy(policy: NormalizedMemoryWritePolicy, issues: ValidationIssue[]): void {
  if (policy.min_verified_confidence < policy.min_observed_confidence || policy.max_pose_uncertainty_m <= 0 || policy.max_evidence_age_ms <= 0) {
    issues.push(makeMemoryIssue("error", "MemoryPolicyInvalid", "$.memory_policy", "Memory policy thresholds must be ordered and positive.", "Use observed <= verified confidence and positive freshness and uncertainty limits."));
  }
}

function blockedFieldsFor(action: MemoryWriteAction, hidden: boolean, uncertainPose: boolean, stale: boolean, missingCertificate: boolean): readonly string[] {
  return freezeMemoryArray([
    hidden ? "input_payload" : undefined,
    uncertainPose ? "pose" : undefined,
    stale ? "source_evidence_refs" : undefined,
    missingCertificate ? "certificate_ref" : undefined,
    action === "write_observed_spatial" ? "verification_claims" : undefined,
  ].filter(isString));
}

function followupFor(action: MemoryWriteAction, stale: boolean, uncertainPose: boolean, missingCertificate: boolean): MemoryWriteDecision["required_followup"] {
  if (action === "quarantine") return "audit";
  if (missingCertificate) return "verify";
  if (stale || uncertainPose) return "reobserve";
  if (action === "reject") return "human_review";
  return "none";
}

function reasonFor(action: MemoryWriteAction, sourceArtifact: MemorySourceArtifact, stale: boolean, uncertainPose: boolean, missingCertificate: boolean): string {
  if (action === "quarantine") return "Memory input crossed the File 15 truth boundary and was quarantined.";
  if (missingCertificate) return "Verified spatial memory was denied because no certificate reference was present.";
  if (stale) return "Memory write was denied because the source evidence is stale.";
  if (uncertainPose) return "Memory write was denied because pose uncertainty is too high.";
  if (action === "reject") return `Memory write for ${sourceArtifact.requested_record_class} did not satisfy policy gates.`;
  return `Memory write accepted as ${sourceArtifact.requested_record_class}; memory remains prior context only.`;
}

function confidenceClassFor(confidence: number, recordClass: MemoryRecordClass, hidden: boolean): MemoryConfidenceClass {
  if (hidden) return "quarantined";
  if (recordClass === "contradiction") return "contradicted";
  if (recordClass === "verified_spatial") return "verified";
  if (confidence >= 0.68) return "high_observed";
  if (confidence >= 0.46) return "medium_observed";
  return "low_hypothesis";
}

export function defaultMemoryPermissions(recordClass: MemoryRecordClass, confidenceClass: MemoryConfidenceClass, lifecycleState: MemoryLifecycleState): MemoryRetrievalPermissions {
  const blocked = confidenceClass === "quarantined" || lifecycleState === "quarantined" || lifecycleState === "archived";
  const currentStateBlocked = lifecycleState === "contradicted" || confidenceClass === "contradicted";
  return Object.freeze({
    cognitive: !blocked && !currentStateBlocked,
    perception: !blocked,
    verification: !blocked && recordClass !== "search_hint",
    oops_loop: !blocked,
    audit: true,
    qa: true,
  });
}

export function baseMemoryRecord(
  recordClass: MemoryRecordClass,
  memoryRecordRef: Ref,
  evidenceManifest: MemoryEvidenceManifest,
  confidenceClass: MemoryConfidenceClass,
  lifecycleState: MemoryLifecycleState,
  stalenessScore: number,
  allowedPromptSummary: string,
  auditReplayRefs: readonly Ref[],
): MemoryRecordBase {
  const base = {
    memory_record_ref: cleanMemoryRef(memoryRecordRef),
    record_class: recordClass,
    created_at_ms: evidenceManifest.evidence_timestamp_ms,
    source_event_refs: uniqueMemoryRefs(evidenceManifest.source_event_refs),
    source_evidence_refs: uniqueMemoryRefs(evidenceManifest.source_evidence_refs),
    provenance_manifest_ref: cleanMemoryRef(evidenceManifest.provenance_manifest_ref),
    truth_boundary_status: evidenceManifest.truth_boundary_status,
    confidence_class: confidenceClass,
    lifecycle_state: lifecycleState,
    staleness_score: roundMemoryScore(stalenessScore),
    retrieval_permissions: defaultMemoryPermissions(recordClass, confidenceClass, lifecycleState),
    audit_replay_refs: uniqueMemoryRefs(auditReplayRefs),
    allowed_prompt_summary: cleanMemoryText(allowedPromptSummary),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function mergeMemoryWritePolicy(base: NormalizedMemoryWritePolicy, override: MemoryWritePolicy): NormalizedMemoryWritePolicy {
  return Object.freeze({
    policy_ref: cleanMemoryRef(override.policy_ref || base.policy_ref),
    min_verified_confidence: clamp01(override.min_verified_confidence ?? base.min_verified_confidence),
    min_observed_confidence: clamp01(override.min_observed_confidence ?? base.min_observed_confidence),
    max_pose_uncertainty_m: positiveOrDefault(override.max_pose_uncertainty_m, base.max_pose_uncertainty_m),
    max_evidence_age_ms: positiveOrDefault(override.max_evidence_age_ms, base.max_evidence_age_ms),
    allow_observed_writes: override.allow_observed_writes ?? base.allow_observed_writes,
    allow_contradiction_writes: override.allow_contradiction_writes ?? base.allow_contradiction_writes,
    allow_episode_writes: override.allow_episode_writes ?? base.allow_episode_writes,
    quarantine_hidden_sources: override.quarantine_hidden_sources ?? base.quarantine_hidden_sources,
  });
}

export function cleanMemoryText(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ").slice(0, 1200);
  return HIDDEN_MEMORY_PATTERN.test(normalized) ? "Memory text redacted at the File 15 truth boundary." : normalized;
}

export function cleanMemoryRef(value: Ref): Ref {
  return makeMemoryRef(value);
}

export function makeMemoryRef(...parts: readonly string[]): Ref {
  const normalized = parts
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "ref:empty";
}

export function validateMemoryRef(value: Ref, path: string, issues: ValidationIssue[]): void {
  if (value.trim().length === 0 || /\s/u.test(value)) {
    issues.push(makeMemoryIssue("error", "MemorySchemaInvalid", path, "Reference must be non-empty and whitespace-free.", "Use an opaque sanitized reference."));
  }
  if (HIDDEN_MEMORY_PATTERN.test(value)) {
    issues.push(makeMemoryIssue("error", "MemoryHiddenSourceLeak", path, "Reference contains hidden simulator, backend, debug, asset, or QA wording.", "Replace it with a runtime-safe memory reference."));
  }
}

export function makeMemoryIssue(severity: ValidationSeverity, code: MemoryIssueCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

export function uniqueMemoryRefs(values: readonly Ref[]): readonly Ref[] {
  return freezeMemoryArray([...new Set(values.map(cleanMemoryRef))].sort());
}

export function freezeMemoryArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

export function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

export function roundMemoryScore(value: number): number {
  return Math.round(clamp01(value) * 1000) / 1000;
}

export function roundMemoryNumber(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function scoreAgeFreshness(ageMs: number, staleAfterMs: number): number {
  if (!Number.isFinite(ageMs) || !Number.isFinite(staleAfterMs) || staleAfterMs <= 0) return 0;
  return roundMemoryScore(1 - Math.min(1, Math.max(0, ageMs / staleAfterMs)));
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function isString(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}
