/**
 * Artifact envelope and provenance manifest store for PIT-B04.
 */

import type { ArtifactEnvelopeInput } from "../api/artifact_envelope";
import type { ProvenanceManifest } from "../api/provenance_manifest_contract";
import type { Ref } from "../simulation/world_manifest";
import {
  buildStoredArtifactRecord,
  freezeArray,
  makeStorageRef,
  writeReport,
  type StorageBoundaryLabel,
  type StorageDomain,
  type StorageWriteReport,
  type StoredArtifactRecord,
} from "./storage_contracts";

export class ArtifactStateStore {
  private readonly records = new Map<Ref, StoredArtifactRecord>();

  public persist(input: {
    readonly domain: StorageDomain;
    readonly envelope_input: ArtifactEnvelopeInput;
    readonly provenance_manifest: ProvenanceManifest;
    readonly boundary_label?: StorageBoundaryLabel;
    readonly replay_refs: readonly Ref[];
    readonly audit_refs: readonly Ref[];
    readonly stored_at_ms: number;
  }): StorageWriteReport<StoredArtifactRecord> {
    const rejectedReasons = validateArtifactPersistInput(input);
    if (rejectedReasons.length > 0) {
      return writeReport<StoredArtifactRecord>(makeStorageRef("artifact_store_write", input.envelope_input.artifact_ref), "rejected", undefined, rejectedReasons, input.audit_refs);
    }
    const record = buildStoredArtifactRecord(input);
    this.records.set(record.envelope.artifact_ref, record);
    return writeReport(makeStorageRef("artifact_store_write", record.envelope.artifact_ref), "accepted", record, [], record.ref_bundle.audit_refs);
  }

  public get(artifactRef: Ref): StoredArtifactRecord | undefined {
    return this.records.get(artifactRef);
  }

  public list(): readonly StoredArtifactRecord[] {
    return freezeArray([...this.records.values()].sort((left, right) => left.storage_record_ref.localeCompare(right.storage_record_ref)));
  }
}

function validateArtifactPersistInput(input: {
  readonly envelope_input: ArtifactEnvelopeInput;
  readonly provenance_manifest: ProvenanceManifest;
  readonly replay_refs: readonly Ref[];
}): readonly string[] {
  const reasons: string[] = [];
  if (input.envelope_input.provenance_manifest_ref !== input.provenance_manifest.provenance_manifest_ref) {
    reasons.push("Artifact envelope provenance ref must match the stored provenance manifest.");
  }
  if (input.replay_refs.length === 0) {
    reasons.push("Storage records require at least one replay ref.");
  }
  if (input.provenance_manifest.truth_boundary_status === "qa_truth_only" && input.envelope_input.visibility_class !== "qa_offline") {
    reasons.push("QA-only provenance must use QA-offline artifact visibility.");
  }
  if (input.provenance_manifest.truth_boundary_status === "truth_boundary_violation" && input.envelope_input.visibility_class !== "restricted_quarantine") {
    reasons.push("Truth-boundary violations must be persisted in restricted quarantine.");
  }
  return freezeArray(reasons);
}
