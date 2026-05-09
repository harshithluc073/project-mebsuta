/**
 * Spatial record builder for Project Mebsuta episodic spatial memory.
 *
 * Blueprint: `architecture_docs/15_RAG_EPISODIC_SPATIAL_MEMORY_ARCHITECTURE.md`
 * sections 15.4.1, 15.5, 15.6.2, 15.6.3, 15.9, 15.14, 15.19.1, and 15.20.1.
 *
 * The builder creates canonical verified and observed spatial records without
 * exposing hidden simulator state or treating memory as current truth.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  MEMORY_BLUEPRINT_REF,
  baseMemoryRecord,
  cleanMemoryRef,
  cleanMemoryText,
  freezeMemoryArray,
  makeMemoryIssue,
  makeMemoryRef,
  roundMemoryScore,
  type MemoryEvidenceManifest,
  type MemoryPoseEstimate,
  type MemoryRecordBase,
  type MemoryWriteDecision,
} from "./memory_write_gate";

export const SPATIAL_RECORD_BUILDER_SCHEMA_VERSION = "mebsuta.spatial_record_builder.v1" as const;

export type SpatialMemoryAllowedUse = "search_hint" | "planning_prior" | "inspection_candidate";
export type SpatialMemoryOcclusionStatus = "clear" | "partial" | "heavy" | "unknown";

export interface ObjectMemoryDescriptor {
  readonly object_memory_ref: Ref;
  readonly label: string;
  readonly descriptor_summary: string;
  readonly visual_descriptor_refs: readonly Ref[];
  readonly tactile_descriptor_refs?: readonly Ref[];
  readonly acoustic_descriptor_refs?: readonly Ref[];
}

export interface SpatialRelationMemoryRecord {
  readonly relation_ref: Ref;
  readonly relation: string;
  readonly target_ref: Ref;
  readonly reference_ref?: Ref;
  readonly confidence: number;
  readonly evidence_refs: readonly Ref[];
}

export interface VerifiedSpatialMemoryRecord extends MemoryRecordBase {
  readonly record_class: "verified_spatial";
  readonly object_memory_ref: Ref;
  readonly object_descriptor: ObjectMemoryDescriptor;
  readonly estimated_pose?: MemoryPoseEstimate;
  readonly pose_uncertainty_m?: number;
  readonly frame_ref?: Ref;
  readonly relation_records: readonly SpatialRelationMemoryRecord[];
  readonly verification_certificate_ref: Ref;
  readonly spatial_residual_report_refs: readonly Ref[];
  readonly visual_descriptor_refs: readonly Ref[];
  readonly last_verified_at_ms: number;
  readonly validity_region_ref?: Ref;
}

export interface ObservedSpatialMemoryRecord extends MemoryRecordBase {
  readonly record_class: "observed_spatial" | "search_hint";
  readonly object_hypothesis_ref: Ref;
  readonly object_descriptor: ObjectMemoryDescriptor;
  readonly estimated_pose_or_region?: MemoryPoseEstimate;
  readonly pose_uncertainty_m: number;
  readonly view_evidence_refs: readonly Ref[];
  readonly occlusion_status: SpatialMemoryOcclusionStatus;
  readonly identity_confidence: number;
  readonly observation_limitations: readonly string[];
  readonly allowed_use: SpatialMemoryAllowedUse;
}

export type SpatialMemoryRecord = VerifiedSpatialMemoryRecord | ObservedSpatialMemoryRecord;

export interface VerifiedSpatialRecordInput {
  readonly decision: MemoryWriteDecision;
  readonly evidence_manifest: MemoryEvidenceManifest;
  readonly object_descriptor: ObjectMemoryDescriptor;
  readonly pose?: MemoryPoseEstimate;
  readonly relation_records?: readonly SpatialRelationMemoryRecord[];
  readonly verification_certificate_ref: Ref;
  readonly spatial_residual_report_refs?: readonly Ref[];
  readonly validity_region_ref?: Ref;
}

export interface ObservedSpatialRecordInput {
  readonly decision: MemoryWriteDecision;
  readonly evidence_manifest: MemoryEvidenceManifest;
  readonly object_hypothesis_ref: Ref;
  readonly object_descriptor: ObjectMemoryDescriptor;
  readonly pose_or_region?: MemoryPoseEstimate;
  readonly view_evidence_refs: readonly Ref[];
  readonly occlusion_status: SpatialMemoryOcclusionStatus;
  readonly identity_confidence: number;
  readonly observation_limitations: readonly string[];
  readonly allowed_use: SpatialMemoryAllowedUse;
}

export interface SpatialRecordBuilderReport {
  readonly schema_version: typeof SPATIAL_RECORD_BUILDER_SCHEMA_VERSION;
  readonly blueprint_ref: typeof MEMORY_BLUEPRINT_REF;
  readonly report_ref: Ref;
  readonly records: readonly SpatialMemoryRecord[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "spatial_record_builder_report";
  readonly determinism_hash: string;
}

export class SpatialRecordBuilder {
  /**
   * Builds one certificate-authorized spatial memory record.
   */
  public buildVerifiedSpatialRecord(input: VerifiedSpatialRecordInput): VerifiedSpatialMemoryRecord {
    const issues: ValidationIssue[] = [];
    validateDecision(input.decision, "write_verified_spatial", issues);
    if (input.decision.action !== "write_verified_spatial") {
      issues.push(makeMemoryIssue("error", "MemoryCertificateMissing", "$.decision.action", "Verified record input must come from a verified write decision.", "Evaluate the write candidate through MemoryWriteGate first."));
    }
    const memoryRef = makeMemoryRef("verified_spatial_memory", input.object_descriptor.object_memory_ref, input.verification_certificate_ref);
    const base = baseMemoryRecord(
      "verified_spatial",
      memoryRef,
      input.evidence_manifest,
      issues.some((issue) => issue.severity === "error") ? "quarantined" : "verified",
      issues.some((issue) => issue.severity === "error") ? "quarantined" : "active",
      0,
      promptSummary(input.object_descriptor.label, "verified", input.pose, input.relation_records ?? []),
      [input.decision.decision_ref, input.verification_certificate_ref, ...input.decision.accepted_evidence_refs],
    );
    const recordBase = {
      ...base,
      record_class: "verified_spatial" as const,
      object_memory_ref: cleanMemoryRef(input.object_descriptor.object_memory_ref),
      object_descriptor: freezeDescriptor(input.object_descriptor),
      estimated_pose: freezePose(input.pose),
      pose_uncertainty_m: input.pose?.uncertainty_m,
      frame_ref: input.pose?.frame_ref,
      relation_records: freezeMemoryArray((input.relation_records ?? []).map(freezeRelation)),
      verification_certificate_ref: cleanMemoryRef(input.verification_certificate_ref),
      spatial_residual_report_refs: freezeMemoryArray((input.spatial_residual_report_refs ?? []).map(cleanMemoryRef).sort()),
      visual_descriptor_refs: freezeMemoryArray(input.object_descriptor.visual_descriptor_refs.map(cleanMemoryRef).sort()),
      last_verified_at_ms: input.evidence_manifest.evidence_timestamp_ms,
      validity_region_ref: input.validity_region_ref === undefined ? undefined : cleanMemoryRef(input.validity_region_ref),
    };
    return Object.freeze({ ...recordBase, determinism_hash: computeDeterminismHash(recordBase) });
  }

  /**
   * Builds one lower-authority observed spatial memory record.
   */
  public buildObservedSpatialRecord(input: ObservedSpatialRecordInput): ObservedSpatialMemoryRecord {
    const issues: ValidationIssue[] = [];
    validateDecision(input.decision, "write_observed_spatial", issues);
    const confidence = roundMemoryScore(input.identity_confidence);
    const recordClass: ObservedSpatialMemoryRecord["record_class"] = input.allowed_use === "search_hint" ? "search_hint" : "observed_spatial";
    const memoryRef = makeMemoryRef(recordClass, input.object_hypothesis_ref, input.object_descriptor.object_memory_ref);
    const base = baseMemoryRecord(
      recordClass,
      memoryRef,
      input.evidence_manifest,
      confidence >= 0.68 ? "high_observed" : confidence >= 0.46 ? "medium_observed" : "low_hypothesis",
      input.allowed_use === "search_hint" ? "fresh" : "active",
      stalenessSeed(input.occlusion_status, input.pose_or_region?.uncertainty_m ?? 1),
      promptSummary(input.object_descriptor.label, input.allowed_use, input.pose_or_region, []),
      [input.decision.decision_ref, ...input.decision.accepted_evidence_refs],
    );
    const recordBase = {
      ...base,
      record_class: recordClass,
      object_hypothesis_ref: cleanMemoryRef(input.object_hypothesis_ref),
      object_descriptor: freezeDescriptor(input.object_descriptor),
      estimated_pose_or_region: freezePose(input.pose_or_region),
      pose_uncertainty_m: input.pose_or_region?.uncertainty_m ?? 1,
      view_evidence_refs: freezeMemoryArray(input.view_evidence_refs.map(cleanMemoryRef).sort()),
      occlusion_status: input.occlusion_status,
      identity_confidence: confidence,
      observation_limitations: freezeMemoryArray(input.observation_limitations.map(cleanMemoryText).sort()),
      allowed_use: input.allowed_use,
    };
    return Object.freeze({ ...recordBase, determinism_hash: computeDeterminismHash(recordBase) });
  }

  /**
   * Packages verified and observed outputs into an auditable builder report.
   */
  public report(records: readonly SpatialMemoryRecord[], issues: readonly ValidationIssue[] = []): SpatialRecordBuilderReport {
    const base = {
      schema_version: SPATIAL_RECORD_BUILDER_SCHEMA_VERSION,
      blueprint_ref: MEMORY_BLUEPRINT_REF,
      report_ref: makeMemoryRef("spatial_record_builder_report", records.map((record) => record.memory_record_ref).join(":") || "empty"),
      records: freezeMemoryArray([...records].sort((a, b) => a.memory_record_ref.localeCompare(b.memory_record_ref))),
      issues: freezeMemoryArray(issues),
      ok: records.length > 0 && !issues.some((issue) => issue.severity === "error"),
      cognitive_visibility: "spatial_record_builder_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function buildVerifiedSpatialRecord(input: VerifiedSpatialRecordInput): VerifiedSpatialMemoryRecord {
  return new SpatialRecordBuilder().buildVerifiedSpatialRecord(input);
}

export function buildObservedSpatialRecord(input: ObservedSpatialRecordInput): ObservedSpatialMemoryRecord {
  return new SpatialRecordBuilder().buildObservedSpatialRecord(input);
}

function validateDecision(decision: MemoryWriteDecision, requiredAction: MemoryWriteDecision["action"], issues: ValidationIssue[]): void {
  if (!decision.accepted || decision.action !== requiredAction) {
    issues.push(makeMemoryIssue("error", "MemorySchemaInvalid", "$.decision", "Record builder received an incompatible write decision.", "Use a MemoryWriteGate decision matching the requested record type."));
  }
}

function promptSummary(label: string, authority: string, pose: MemoryPoseEstimate | undefined, relations: readonly SpatialRelationMemoryRecord[]): string {
  const poseText = pose?.position_m === undefined ? "pose is not asserted" : `estimated in ${pose.frame_ref} with uncertainty_m=${pose.uncertainty_m}`;
  const relationText = relations.length === 0 ? "no relation claims" : `relations=${relations.map((relation) => relation.relation).join(",")}`;
  return cleanMemoryText(`${label} memory authority=${authority}; ${poseText}; ${relationText}; current perception is still required before action.`);
}

function stalenessSeed(occlusionStatus: SpatialMemoryOcclusionStatus, uncertainty: number): number {
  const occlusionPenalty = occlusionStatus === "clear" ? 0.05 : occlusionStatus === "partial" ? 0.18 : occlusionStatus === "heavy" ? 0.34 : 0.28;
  return roundMemoryScore(occlusionPenalty + Math.min(0.5, Math.max(0, uncertainty)));
}

function freezeDescriptor(descriptor: ObjectMemoryDescriptor): ObjectMemoryDescriptor {
  return Object.freeze({
    object_memory_ref: cleanMemoryRef(descriptor.object_memory_ref),
    label: cleanMemoryText(descriptor.label),
    descriptor_summary: cleanMemoryText(descriptor.descriptor_summary),
    visual_descriptor_refs: freezeMemoryArray(descriptor.visual_descriptor_refs.map(cleanMemoryRef).sort()),
    tactile_descriptor_refs: descriptor.tactile_descriptor_refs === undefined ? undefined : freezeMemoryArray(descriptor.tactile_descriptor_refs.map(cleanMemoryRef).sort()),
    acoustic_descriptor_refs: descriptor.acoustic_descriptor_refs === undefined ? undefined : freezeMemoryArray(descriptor.acoustic_descriptor_refs.map(cleanMemoryRef).sort()),
  });
}

function freezePose(pose: MemoryPoseEstimate | undefined): MemoryPoseEstimate | undefined {
  if (pose === undefined) return undefined;
  return Object.freeze({
    frame_ref: cleanMemoryRef(pose.frame_ref),
    position_m: pose.position_m,
    orientation_xyzw: pose.orientation_xyzw,
    region_ref: pose.region_ref === undefined ? undefined : cleanMemoryRef(pose.region_ref),
    uncertainty_m: pose.uncertainty_m,
    relation_refs: freezeMemoryArray(pose.relation_refs.map(cleanMemoryRef).sort()),
  });
}

function freezeRelation(relation: SpatialRelationMemoryRecord): SpatialRelationMemoryRecord {
  return Object.freeze({
    relation_ref: cleanMemoryRef(relation.relation_ref),
    relation: cleanMemoryText(relation.relation),
    target_ref: cleanMemoryRef(relation.target_ref),
    reference_ref: relation.reference_ref === undefined ? undefined : cleanMemoryRef(relation.reference_ref),
    confidence: roundMemoryScore(relation.confidence),
    evidence_refs: freezeMemoryArray(relation.evidence_refs.map(cleanMemoryRef).sort()),
  });
}
