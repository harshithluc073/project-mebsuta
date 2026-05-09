/**
 * Memory persistence foundation that delegates write authority to MemoryWriteGate.
 */

import { MemoryWriteGate, type MemoryEvidenceManifest, type MemorySourceArtifact, type MemoryWriteDecision, type MemoryWritePolicy } from "../memory/memory_write_gate";
import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref } from "../simulation/world_manifest";
import { freezeArray, freezeObject, makeStorageRef, uniqueStorageRefs, writeReport, type StorageWriteReport } from "./storage_contracts";

export const MEMORY_STATE_STORE_SCHEMA_VERSION = "mebsuta.storage.memory_state_store.v1" as const;

export interface PersistedMemoryDecisionRecord {
  readonly schema_version: typeof MEMORY_STATE_STORE_SCHEMA_VERSION;
  readonly memory_state_record_ref: Ref;
  readonly decision: MemoryWriteDecision;
  readonly provenance_manifest_ref: Ref;
  readonly replay_refs: readonly Ref[];
  readonly boundary_label: "runtime_memory" | "restricted_quarantine";
  readonly determinism_hash: string;
}

export class MemoryStateStore {
  private readonly gate: MemoryWriteGate;
  private readonly records = new Map<Ref, PersistedMemoryDecisionRecord>();

  public constructor(gate = new MemoryWriteGate()) {
    this.gate = gate;
  }

  public evaluateAndPersist(input: {
    readonly source_artifact: MemorySourceArtifact;
    readonly evidence_manifest: MemoryEvidenceManifest;
    readonly policy: MemoryWritePolicy;
    readonly current_time_ms: number;
    readonly replay_refs: readonly Ref[];
  }): StorageWriteReport<PersistedMemoryDecisionRecord> {
    const report = this.gate.evaluateMemoryWrite(input.source_artifact, input.evidence_manifest, input.policy, input.current_time_ms);
    if (!report.decision.accepted) {
      return writeReport<PersistedMemoryDecisionRecord>(makeStorageRef("memory_state_write", report.decision.decision_ref), "rejected", undefined, [report.decision.reason], [report.report_ref, report.decision.decision_ref, ...input.replay_refs]);
    }
    const base = {
      schema_version: MEMORY_STATE_STORE_SCHEMA_VERSION,
      memory_state_record_ref: makeStorageRef("memory_state_record", report.decision.decision_ref),
      decision: report.decision,
      provenance_manifest_ref: input.evidence_manifest.provenance_manifest_ref,
      replay_refs: uniqueStorageRefs(input.replay_refs),
      boundary_label: "runtime_memory" as const,
    };
    const record = freezeObject({ ...base, determinism_hash: computeDeterminismHash(base) });
    this.records.set(record.memory_state_record_ref, record);
    return writeReport(makeStorageRef("memory_state_write", report.decision.decision_ref), "accepted", record, [], [report.report_ref, report.decision.decision_ref, ...input.replay_refs]);
  }

  public list(): readonly PersistedMemoryDecisionRecord[] {
    return freezeArray([...this.records.values()].sort((left, right) => left.memory_state_record_ref.localeCompare(right.memory_state_record_ref)));
  }
}
