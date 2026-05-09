/**
 * Contradiction manager for Project Mebsuta episodic spatial memory.
 *
 * Blueprint: `architecture_docs/15_RAG_EPISODIC_SPATIAL_MEMORY_ARCHITECTURE.md`
 * sections 15.4.1, 15.6.4, 15.11.4, 15.19.1, 15.20.3, and 15.24.
 *
 * The manager records conflicts between fresh embodied evidence and prior
 * memory without deleting prior history.
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
  roundMemoryNumber,
  roundMemoryScore,
  type MemoryEvidenceManifest,
  type MemoryRecordBase,
} from "./memory_write_gate";
import type { ObservedSpatialMemoryRecord, SpatialMemoryRecord } from "./spatial_record_builder";

export const CONTRADICTION_MANAGER_SCHEMA_VERSION = "mebsuta.contradiction_manager.v1" as const;

export type ContradictionType = "absent" | "moved" | "identity_mismatch" | "relation_mismatch" | "orientation_mismatch" | "unsafe_change";
export type RecommendedMemoryAction = "mark_stale" | "supersede" | "quarantine" | "archive" | "reobserve";
export type ContradictionDecision = "contradiction_recorded" | "no_conflict" | "needs_reobserve" | "quarantine_prior";

export interface FreshMemoryEvidence {
  readonly evidence_ref: Ref;
  readonly object_memory_ref?: Ref;
  readonly label?: string;
  readonly observed_region_ref?: Ref;
  readonly observed_position_m?: readonly [number, number, number];
  readonly relation_summary?: string;
  readonly identity_confidence: number;
  readonly absence_confidence?: number;
  readonly safety_change?: boolean;
  readonly evidence_refs: readonly Ref[];
  readonly summary: string;
}

export interface ContradictionMemoryRecord extends MemoryRecordBase {
  readonly record_class: "contradiction";
  readonly contradiction_record_ref: Ref;
  readonly prior_memory_record_refs: readonly Ref[];
  readonly current_evidence_refs: readonly Ref[];
  readonly contradiction_type: ContradictionType;
  readonly contradiction_strength: number;
  readonly recommended_memory_action: RecommendedMemoryAction;
  readonly current_evidence_summary: string;
  readonly requires_verification: boolean;
}

export interface MemoryContradictionUpdate {
  readonly prior_memory_record_ref: Ref;
  readonly next_lifecycle_state: "stale" | "contradicted" | "superseded" | "quarantined";
  readonly reason: string;
}

export interface ContradictionManagerRequest {
  readonly request_ref?: Ref;
  readonly prior_records: readonly SpatialMemoryRecord[];
  readonly current_evidence: readonly FreshMemoryEvidence[];
  readonly evidence_manifest: MemoryEvidenceManifest;
  readonly minimum_strength?: number;
}

export interface ContradictionManagerReport {
  readonly schema_version: typeof CONTRADICTION_MANAGER_SCHEMA_VERSION;
  readonly blueprint_ref: typeof MEMORY_BLUEPRINT_REF;
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly contradiction_records: readonly ContradictionMemoryRecord[];
  readonly prior_record_updates: readonly MemoryContradictionUpdate[];
  readonly decision: ContradictionDecision;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "contradiction_manager_report";
  readonly determinism_hash: string;
}

export class ContradictionManager {
  /**
   * Compares prior spatial memories with fresh embodied evidence.
   */
  public buildContradictionRecord(request: ContradictionManagerRequest): ContradictionManagerReport {
    const issues: ValidationIssue[] = [];
    validateRequest(request, issues);
    const threshold = clampStrength(request.minimum_strength ?? 0.42);
    const pairs = request.prior_records.flatMap((record) =>
      request.current_evidence.map((evidence) => evaluatePair(record, evidence)).filter((candidate) => candidate.strength >= threshold),
    );
    const records = pairs.map((pair) => toContradictionRecord(pair, request.evidence_manifest));
    const updates = records.flatMap(toPriorUpdates);
    const decision = decideContradiction(records, issues);
    const requestRef = cleanMemoryRef(request.request_ref ?? makeMemoryRef("contradiction_manager", request.evidence_manifest.provenance_manifest_ref));
    const base = {
      schema_version: CONTRADICTION_MANAGER_SCHEMA_VERSION,
      blueprint_ref: MEMORY_BLUEPRINT_REF,
      report_ref: makeMemoryRef("contradiction_manager_report", requestRef, decision),
      request_ref: requestRef,
      contradiction_records: freezeMemoryArray(records.sort((a, b) => b.contradiction_strength - a.contradiction_strength || a.contradiction_record_ref.localeCompare(b.contradiction_record_ref))),
      prior_record_updates: freezeMemoryArray(updates.sort((a, b) => a.prior_memory_record_ref.localeCompare(b.prior_memory_record_ref))),
      decision,
      issues: freezeMemoryArray(issues),
      ok: decision !== "quarantine_prior",
      cognitive_visibility: "contradiction_manager_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function buildContradictionRecord(request: ContradictionManagerRequest): ContradictionManagerReport {
  return new ContradictionManager().buildContradictionRecord(request);
}

interface PairEvaluation {
  readonly prior: SpatialMemoryRecord;
  readonly evidence: FreshMemoryEvidence;
  readonly type: ContradictionType;
  readonly strength: number;
  readonly action: RecommendedMemoryAction;
  readonly requiresVerification: boolean;
}

function evaluatePair(prior: SpatialMemoryRecord, evidence: FreshMemoryEvidence): PairEvaluation {
  const sameIdentity = identityMatches(prior, evidence);
  const absence = clampStrength(evidence.absence_confidence ?? 0);
  const distance = spatialDistance(prior, evidence);
  const movedStrength = distance === undefined ? 0 : clampStrength(distance / 0.5);
  const relationMismatch = relationConflict(prior, evidence);
  const safetyStrength = evidence.safety_change === true ? 0.92 : 0;
  const identityStrength = sameIdentity ? 0 : clampStrength(1 - evidence.identity_confidence);
  const candidates: readonly [ContradictionType, number][] = [
    ["unsafe_change", safetyStrength],
    ["absent", absence],
    ["moved", movedStrength],
    ["identity_mismatch", identityStrength],
    ["relation_mismatch", relationMismatch],
  ];
  const [type, strength] = [...candidates].sort((a, b) => b[1] - a[1])[0] ?? ["absent", 0];
  return Object.freeze({
    prior,
    evidence,
    type,
    strength: roundMemoryScore(strength),
    action: actionFor(type, strength, sameIdentity),
    requiresVerification: type !== "unsafe_change" && strength < 0.86,
  });
}

function toContradictionRecord(pair: PairEvaluation, manifest: MemoryEvidenceManifest): ContradictionMemoryRecord {
  const recordRef = makeMemoryRef("contradiction_memory", pair.prior.memory_record_ref, pair.evidence.evidence_ref, pair.type);
  const base = baseMemoryRecord(
    "contradiction",
    recordRef,
    manifest,
    "contradicted",
    "contradicted",
    Math.min(1, 0.4 + pair.strength * 0.5),
    contradictionSummary(pair),
    [pair.prior.memory_record_ref, pair.evidence.evidence_ref, ...pair.evidence.evidence_refs],
  );
  const recordBase = {
    ...base,
    record_class: "contradiction" as const,
    contradiction_record_ref: recordRef,
    prior_memory_record_refs: freezeMemoryArray([pair.prior.memory_record_ref]),
    current_evidence_refs: freezeMemoryArray([pair.evidence.evidence_ref, ...pair.evidence.evidence_refs].map(cleanMemoryRef).sort()),
    contradiction_type: pair.type,
    contradiction_strength: pair.strength,
    recommended_memory_action: pair.action,
    current_evidence_summary: cleanMemoryText(pair.evidence.summary),
    requires_verification: pair.requiresVerification,
  };
  return Object.freeze({ ...recordBase, determinism_hash: computeDeterminismHash(recordBase) });
}

function toPriorUpdates(record: ContradictionMemoryRecord): readonly MemoryContradictionUpdate[] {
  const next = record.recommended_memory_action === "quarantine"
    ? "quarantined"
    : record.recommended_memory_action === "supersede"
      ? "superseded"
      : record.contradiction_type === "absent" || record.requires_verification
        ? "stale"
        : "contradicted";
  return freezeMemoryArray(record.prior_memory_record_refs.map((ref) => Object.freeze({
    prior_memory_record_ref: ref,
    next_lifecycle_state: next,
    reason: cleanMemoryText(`${record.contradiction_type} contradiction ${record.contradiction_record_ref} requires ${record.recommended_memory_action}.`),
  })));
}

function validateRequest(request: ContradictionManagerRequest, issues: ValidationIssue[]): void {
  if (request.prior_records.length === 0) {
    issues.push(makeMemoryIssue("warning", "MemoryEvidenceMissing", "$.prior_records", "No prior records were available for contradiction comparison.", "Use retrieval output from spatial or semantic memory."));
  }
  if (request.current_evidence.length === 0) {
    issues.push(makeMemoryIssue("error", "MemoryEvidenceMissing", "$.current_evidence", "Contradiction comparison requires fresh embodied evidence.", "Attach current observation or verification evidence."));
  }
}

function decideContradiction(records: readonly ContradictionMemoryRecord[], issues: readonly ValidationIssue[]): ContradictionDecision {
  if (issues.some((issue) => issue.severity === "error")) return "quarantine_prior";
  if (records.length === 0) return "no_conflict";
  if (records.some((record) => record.requires_verification)) return "needs_reobserve";
  return "contradiction_recorded";
}

function identityMatches(prior: SpatialMemoryRecord, evidence: FreshMemoryEvidence): boolean {
  const priorDescriptor = prior.object_descriptor;
  if (evidence.object_memory_ref !== undefined && cleanMemoryRef(evidence.object_memory_ref) === priorDescriptor.object_memory_ref) return true;
  if (evidence.label === undefined) return evidence.identity_confidence >= 0.72;
  return normalizeLabel(evidence.label) === normalizeLabel(priorDescriptor.label) && evidence.identity_confidence >= 0.58;
}

function spatialDistance(prior: SpatialMemoryRecord, evidence: FreshMemoryEvidence): number | undefined {
  if (evidence.observed_position_m === undefined) return undefined;
  const priorPose = prior.record_class === "verified_spatial" ? prior.estimated_pose : (prior as ObservedSpatialMemoryRecord).estimated_pose_or_region;
  if (priorPose?.position_m === undefined) return undefined;
  return roundMemoryNumber(Math.hypot(
    priorPose.position_m[0] - evidence.observed_position_m[0],
    priorPose.position_m[1] - evidence.observed_position_m[1],
    priorPose.position_m[2] - evidence.observed_position_m[2],
  ));
}

function relationConflict(prior: SpatialMemoryRecord, evidence: FreshMemoryEvidence): number {
  if (evidence.relation_summary === undefined) return 0;
  const relationSurface = prior.record_class === "verified_spatial"
    ? prior.relation_records.map((relation) => relation.relation).join(" ")
    : prior.allowed_prompt_summary;
  return normalizeText(relationSurface).length > 0 && normalizeText(evidence.relation_summary) !== normalizeText(relationSurface) ? 0.52 : 0;
}

function actionFor(type: ContradictionType, strength: number, sameIdentity: boolean): RecommendedMemoryAction {
  if (type === "unsafe_change") return "quarantine";
  if (type === "moved" && strength >= 0.66 && sameIdentity) return "supersede";
  if (type === "identity_mismatch") return "reobserve";
  if (type === "absent" && strength >= 0.72) return "mark_stale";
  if (type === "relation_mismatch" || type === "orientation_mismatch") return "reobserve";
  return "archive";
}

function contradictionSummary(pair: PairEvaluation): string {
  return cleanMemoryText(`Prior memory ${pair.prior.memory_record_ref} conflicts with current evidence ${pair.evidence.evidence_ref}; type=${pair.type}; strength=${pair.strength}; current evidence is not converted into success.`);
}

function clampStrength(value: number): number {
  return roundMemoryScore(Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0);
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function normalizeText(value: string): string {
  return cleanMemoryText(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
