/**
 * Incident and release evidence stores for PIT-B04.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref } from "../simulation/world_manifest";
import { freezeArray, freezeObject, makeStorageRef, uniqueStorageRefs, writeReport, type StorageWriteReport } from "./storage_contracts";

export const INCIDENT_RELEASE_STORE_SCHEMA_VERSION = "mebsuta.storage.incident_release_store.v1" as const;

export type IncidentSeverity = "sev0" | "sev1" | "sev2" | "sev3";
export type ReleaseEvidenceDecision = "go" | "conditional_go" | "no_go";
export type RiskStateSeverity = "low" | "medium" | "high" | "critical";
export type RiskStateStatus = "open" | "mitigated" | "accepted";

export interface IncidentStateRecord {
  readonly schema_version: typeof INCIDENT_RELEASE_STORE_SCHEMA_VERSION;
  readonly incident_record_ref: Ref;
  readonly severity: IncidentSeverity;
  readonly incident_class: "storage" | "replay" | "memory" | "runtime_boundary" | "release_evidence";
  readonly summary: string;
  readonly evidence_refs: readonly Ref[];
  readonly audit_refs: readonly Ref[];
  readonly opened_at_ms: number;
  readonly determinism_hash: string;
}

export interface ReleaseEvidenceRecord {
  readonly schema_version: typeof INCIDENT_RELEASE_STORE_SCHEMA_VERSION;
  readonly release_record_ref: Ref;
  readonly decision: ReleaseEvidenceDecision;
  readonly evidence_refs: readonly Ref[];
  readonly replay_refs: readonly Ref[];
  readonly risk_refs: readonly Ref[];
  readonly audit_refs: readonly Ref[];
  readonly recorded_at_ms: number;
  readonly determinism_hash: string;
}

export interface RiskStateRecord {
  readonly schema_version: typeof INCIDENT_RELEASE_STORE_SCHEMA_VERSION;
  readonly risk_record_ref: Ref;
  readonly risk_class: "storage" | "replay" | "memory" | "runtime_boundary" | "release_evidence";
  readonly severity: RiskStateSeverity;
  readonly status: RiskStateStatus;
  readonly summary: string;
  readonly evidence_refs: readonly Ref[];
  readonly mitigation_refs: readonly Ref[];
  readonly audit_refs: readonly Ref[];
  readonly recorded_at_ms: number;
  readonly determinism_hash: string;
}

export class IncidentReleaseStore {
  private readonly incidents = new Map<Ref, IncidentStateRecord>();
  private readonly releases = new Map<Ref, ReleaseEvidenceRecord>();
  private readonly risks = new Map<Ref, RiskStateRecord>();

  public persistIncident(input: Omit<IncidentStateRecord, "schema_version" | "incident_record_ref" | "determinism_hash">): StorageWriteReport<IncidentStateRecord> {
    if (input.evidence_refs.length === 0 || input.audit_refs.length === 0) {
      return writeReport<IncidentStateRecord>(makeStorageRef("incident_write", input.incident_class, input.opened_at_ms), "rejected", undefined, ["Incident records require evidence refs and audit refs."], input.audit_refs);
    }
    const base = {
      schema_version: INCIDENT_RELEASE_STORE_SCHEMA_VERSION,
      incident_record_ref: makeStorageRef("incident_record", input.incident_class, input.opened_at_ms),
      ...input,
      evidence_refs: uniqueStorageRefs(input.evidence_refs),
      audit_refs: uniqueStorageRefs(input.audit_refs),
    };
    const record = freezeObject({ ...base, determinism_hash: computeDeterminismHash(base) });
    this.incidents.set(record.incident_record_ref, record);
    return writeReport(makeStorageRef("incident_write", record.incident_record_ref), "accepted", record, [], record.audit_refs);
  }

  public persistRisk(input: Omit<RiskStateRecord, "schema_version" | "risk_record_ref" | "determinism_hash">): StorageWriteReport<RiskStateRecord> {
    const reasons: string[] = [];
    if (input.evidence_refs.length === 0) {
      reasons.push("Risk records require evidence refs.");
    }
    if (input.audit_refs.length === 0) {
      reasons.push("Risk records require audit refs.");
    }
    if (reasons.length > 0) {
      return writeReport<RiskStateRecord>(makeStorageRef("risk_write", input.risk_class, input.recorded_at_ms), "rejected", undefined, reasons, input.audit_refs);
    }
    const base = {
      schema_version: INCIDENT_RELEASE_STORE_SCHEMA_VERSION,
      risk_record_ref: makeStorageRef("risk_record", input.risk_class, input.recorded_at_ms),
      ...input,
      evidence_refs: uniqueStorageRefs(input.evidence_refs),
      mitigation_refs: uniqueStorageRefs(input.mitigation_refs),
      audit_refs: uniqueStorageRefs(input.audit_refs),
    };
    const record = freezeObject({ ...base, determinism_hash: computeDeterminismHash(base) });
    this.risks.set(record.risk_record_ref, record);
    return writeReport(makeStorageRef("risk_write", record.risk_record_ref), "accepted", record, [], record.audit_refs);
  }

  public persistRelease(input: Omit<ReleaseEvidenceRecord, "schema_version" | "release_record_ref" | "determinism_hash">): StorageWriteReport<ReleaseEvidenceRecord> {
    const reasons: string[] = [];
    if (input.evidence_refs.length === 0) {
      reasons.push("Release records require evidence refs.");
    }
    if (input.replay_refs.length === 0) {
      reasons.push("Release records require replay refs.");
    }
    if (input.audit_refs.length === 0) {
      reasons.push("Release records require audit refs.");
    }
    if (reasons.length > 0) {
      return writeReport<ReleaseEvidenceRecord>(makeStorageRef("release_write", input.recorded_at_ms), "rejected", undefined, reasons, input.audit_refs);
    }
    const base = {
      schema_version: INCIDENT_RELEASE_STORE_SCHEMA_VERSION,
      release_record_ref: makeStorageRef("release_record", input.decision, input.recorded_at_ms),
      ...input,
      evidence_refs: uniqueStorageRefs(input.evidence_refs),
      replay_refs: uniqueStorageRefs(input.replay_refs),
      risk_refs: uniqueStorageRefs(input.risk_refs),
      audit_refs: uniqueStorageRefs(input.audit_refs),
    };
    const record = freezeObject({ ...base, determinism_hash: computeDeterminismHash(base) });
    this.releases.set(record.release_record_ref, record);
    return writeReport(makeStorageRef("release_write", record.release_record_ref), "accepted", record, [], record.audit_refs);
  }

  public listIncidents(): readonly IncidentStateRecord[] {
    return freezeArray([...this.incidents.values()].sort((left, right) => left.incident_record_ref.localeCompare(right.incident_record_ref)));
  }

  public listRisks(): readonly RiskStateRecord[] {
    return freezeArray([...this.risks.values()].sort((left, right) => left.risk_record_ref.localeCompare(right.risk_record_ref)));
  }

  public listReleases(): readonly ReleaseEvidenceRecord[] {
    return freezeArray([...this.releases.values()].sort((left, right) => left.release_record_ref.localeCompare(right.release_record_ref)));
  }
}
