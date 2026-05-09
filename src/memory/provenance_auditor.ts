/**
 * Provenance auditor for Project Mebsuta episodic spatial memory.
 *
 * Blueprint: `architecture_docs/15_RAG_EPISODIC_SPATIAL_MEMORY_ARCHITECTURE.md`
 * sections 15.2, 15.4.1, 15.6.1, 15.8, 15.9, 15.19.3, and 15.24.
 *
 * The auditor verifies that memory artifacts cite embodied evidence and do
 * not carry simulator, backend, debug, asset, or QA truth into runtime recall.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  HIDDEN_MEMORY_PATTERN,
  MEMORY_BLUEPRINT_REF,
  cleanMemoryRef,
  cleanMemoryText,
  freezeMemoryArray,
  makeMemoryIssue,
  makeMemoryRef,
  uniqueMemoryRefs,
  validateMemoryRef,
  type MemoryEvidenceManifest,
  type MemoryRecordBase,
  type MemoryTruthBoundaryStatus,
} from "./memory_write_gate";

export const PROVENANCE_AUDITOR_SCHEMA_VERSION = "mebsuta.provenance_auditor.v1" as const;

export type MemoryProvenanceSourceClass = "embodied_sensor" | "derived_embodied_estimate" | "verification_certificate" | "controller_telemetry" | "policy_config" | "qa_truth" | "unknown";
export type MemoryProvenanceDecision = "approved" | "approved_with_warnings" | "quarantine";

export interface MemoryProvenanceEvidenceRef {
  readonly evidence_ref: Ref;
  readonly source_class: MemoryProvenanceSourceClass;
  readonly prompt_safe_label: string;
  readonly timestamp_ms: number;
}

export interface MemoryProvenanceAuditRequest {
  readonly request_ref?: Ref;
  readonly record?: MemoryRecordBase;
  readonly evidence_manifest: MemoryEvidenceManifest;
  readonly evidence_refs: readonly MemoryProvenanceEvidenceRef[];
  readonly additional_text_surfaces?: readonly string[];
}

export interface MemoryProvenanceAuditReport {
  readonly schema_version: typeof PROVENANCE_AUDITOR_SCHEMA_VERSION;
  readonly blueprint_ref: typeof MEMORY_BLUEPRINT_REF;
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly provenance_manifest_ref: Ref;
  readonly audited_record_ref?: Ref;
  readonly truth_boundary_status: MemoryTruthBoundaryStatus;
  readonly allowed_evidence_refs: readonly Ref[];
  readonly blocked_evidence_refs: readonly Ref[];
  readonly decision: MemoryProvenanceDecision;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "memory_provenance_audit_report";
  readonly determinism_hash: string;
}

export class ProvenanceAuditor {
  /**
   * Audits a memory record or write manifest for embodied-only provenance.
   */
  public auditMemoryProvenance(request: MemoryProvenanceAuditRequest): MemoryProvenanceAuditReport {
    const issues: ValidationIssue[] = [];
    validateRequest(request, issues);
    const blocked = request.evidence_refs
      .filter((item) => item.source_class === "qa_truth" || item.source_class === "unknown" || HIDDEN_MEMORY_PATTERN.test(JSON.stringify(item)))
      .map((item) => item.evidence_ref);
    const allowed = request.evidence_refs
      .filter((item) => !blocked.includes(item.evidence_ref))
      .map((item) => item.evidence_ref);
    for (const ref of blocked) {
      issues.push(makeMemoryIssue("error", "MemoryTruthBoundaryBlocked", `$.evidence_refs.${ref}`, "Evidence reference is not runtime embodied evidence.", "Remove QA or unknown-source evidence before storage."));
    }
    const decision: MemoryProvenanceDecision = issues.some((issue) => issue.severity === "error")
      ? "quarantine"
      : issues.length > 0
        ? "approved_with_warnings"
        : "approved";
    const requestRef = cleanMemoryRef(request.request_ref ?? makeMemoryRef("memory_provenance_audit", request.evidence_manifest.provenance_manifest_ref));
    const base = {
      schema_version: PROVENANCE_AUDITOR_SCHEMA_VERSION,
      blueprint_ref: MEMORY_BLUEPRINT_REF,
      report_ref: makeMemoryRef("memory_provenance_audit_report", requestRef, decision),
      request_ref: requestRef,
      provenance_manifest_ref: cleanMemoryRef(request.evidence_manifest.provenance_manifest_ref),
      audited_record_ref: request.record?.memory_record_ref,
      truth_boundary_status: request.evidence_manifest.truth_boundary_status,
      allowed_evidence_refs: uniqueMemoryRefs(allowed),
      blocked_evidence_refs: uniqueMemoryRefs(blocked),
      decision,
      issues: freezeMemoryArray(issues),
      ok: decision !== "quarantine",
      cognitive_visibility: "memory_provenance_audit_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function auditMemoryProvenance(request: MemoryProvenanceAuditRequest): MemoryProvenanceAuditReport {
  return new ProvenanceAuditor().auditMemoryProvenance(request);
}

function validateRequest(request: MemoryProvenanceAuditRequest, issues: ValidationIssue[]): void {
  validateMemoryRef(request.evidence_manifest.provenance_manifest_ref, "$.evidence_manifest.provenance_manifest_ref", issues);
  for (const ref of [...request.evidence_manifest.source_event_refs, ...request.evidence_manifest.source_evidence_refs]) {
    validateMemoryRef(ref, "$.evidence_manifest.refs", issues);
  }
  if (request.evidence_manifest.truth_boundary_status !== "runtime_embodied_only") {
    issues.push(makeMemoryIssue("error", "MemoryTruthBoundaryBlocked", "$.evidence_manifest.truth_boundary_status", "Runtime memory provenance must be embodied-only.", "Keep QA and hidden truth outside runtime memory."));
  }
  if (request.evidence_refs.length === 0) {
    issues.push(makeMemoryIssue("error", "MemoryEvidenceMissing", "$.evidence_refs", "Provenance audit requires at least one evidence reference.", "Attach evidence refs from the upstream memory write candidate."));
  }
  for (const [index, evidence] of request.evidence_refs.entries()) {
    validateMemoryRef(evidence.evidence_ref, `$.evidence_refs[${index}].evidence_ref`, issues);
    if (!Number.isFinite(evidence.timestamp_ms) || evidence.timestamp_ms < 0) {
      issues.push(makeMemoryIssue("error", "MemorySchemaInvalid", `$.evidence_refs[${index}].timestamp_ms`, "Evidence timestamp must be finite and nonnegative.", "Use monotonic runtime timestamps."));
    }
    cleanMemoryText(evidence.prompt_safe_label);
  }
  const textSurface = JSON.stringify({
    record: request.record,
    manifest: request.evidence_manifest,
    evidence: request.evidence_refs,
    extra: request.additional_text_surfaces ?? [],
  });
  if (HIDDEN_MEMORY_PATTERN.test(textSurface)) {
    issues.push(makeMemoryIssue("error", "MemoryHiddenSourceLeak", "$.request", "Audit request contains hidden-source wording.", "Redact hidden-source strings before audit."));
  }
}
