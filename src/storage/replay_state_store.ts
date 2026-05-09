/**
 * Replay bundle storage foundation for PIT-B04.
 */

import type { ReplayBundle } from "../observability/observability_event_emitter";
import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref } from "../simulation/world_manifest";
import { freezeArray, freezeObject, makeStorageRef, uniqueStorageRefs, writeReport, type StorageWriteReport } from "./storage_contracts";

export const REPLAY_STATE_STORE_SCHEMA_VERSION = "mebsuta.storage.replay_state_store.v1" as const;

export interface PersistedReplayRecord {
  readonly schema_version: typeof REPLAY_STATE_STORE_SCHEMA_VERSION;
  readonly replay_state_record_ref: Ref;
  readonly replay_bundle: ReplayBundle;
  readonly replay_refs: readonly Ref[];
  readonly redaction_manifest_ref: Ref;
  readonly complete_for_review: boolean;
  readonly determinism_hash: string;
}

export class ReplayStateStore {
  private readonly records = new Map<Ref, PersistedReplayRecord>();

  public persist(bundle: ReplayBundle, auditRefs: readonly Ref[]): StorageWriteReport<PersistedReplayRecord> {
    const reasons: string[] = [];
    if (bundle.event_refs.length === 0) {
      reasons.push("Replay bundle requires event refs.");
    }
    if (bundle.evidence_refs.length === 0) {
      reasons.push("Replay bundle requires evidence refs.");
    }
    if (bundle.completeness_score < 0.5) {
      reasons.push("Replay bundle completeness is below review threshold.");
    }
    if (reasons.length > 0) {
      return writeReport<PersistedReplayRecord>(makeStorageRef("replay_state_write", bundle.replay_bundle_ref), "rejected", undefined, reasons, auditRefs);
    }
    const base = {
      schema_version: REPLAY_STATE_STORE_SCHEMA_VERSION,
      replay_state_record_ref: makeStorageRef("replay_state_record", bundle.replay_bundle_ref),
      replay_bundle: bundle,
      replay_refs: uniqueStorageRefs([bundle.replay_bundle_ref, ...bundle.event_refs, ...bundle.evidence_refs]),
      redaction_manifest_ref: bundle.redaction_manifest_ref,
      complete_for_review: true,
    };
    const record = freezeObject({ ...base, determinism_hash: computeDeterminismHash(base) });
    this.records.set(record.replay_state_record_ref, record);
    return writeReport(makeStorageRef("replay_state_write", bundle.replay_bundle_ref), "accepted", record, [], [bundle.replay_bundle_ref, ...auditRefs]);
  }

  public list(): readonly PersistedReplayRecord[] {
    return freezeArray([...this.records.values()].sort((left, right) => left.replay_state_record_ref.localeCompare(right.replay_state_record_ref)));
  }
}
