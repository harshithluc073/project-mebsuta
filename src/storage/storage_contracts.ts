/**
 * PIT-B04 data storage and state foundation contracts.
 *
 * The storage foundation is intentionally adapter-free: it defines durable
 * record shapes, replay refs, boundary labels, schema refs, and immutable
 * in-memory persistence semantics without choosing a database, deployment
 * manifest, auth system, operations workflow, or risk workflow.
 */

import { buildArtifactEnvelope, makeApiRef, type ApiVisibilityClass, type ArtifactEnvelope, type ArtifactEnvelopeInput } from "../api/artifact_envelope";
import type { ProvenanceManifest } from "../api/provenance_manifest_contract";
import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref } from "../simulation/world_manifest";

export const STORAGE_FOUNDATION_SCHEMA_VERSION = "mebsuta.storage.foundation.v1" as const;

export type StorageDomain =
  | "event_ledger"
  | "artifact_store"
  | "replay_store"
  | "memory_store"
  | "incident_store"
  | "release_store"
  | "backup_manifest";

export type StorageBoundaryLabel = "runtime" | "runtime_memory" | "developer_observability" | "qa_offline" | "restricted_quarantine" | "release_evidence";
export type StorageWriteDecision = "accepted" | "rejected";

export interface StorageRefBundle {
  readonly artifact_ref: Ref;
  readonly provenance_manifest_ref: Ref;
  readonly replay_refs: readonly Ref[];
  readonly audit_refs: readonly Ref[];
}

export interface StoredArtifactRecord {
  readonly schema_version: typeof STORAGE_FOUNDATION_SCHEMA_VERSION;
  readonly storage_record_ref: Ref;
  readonly domain: StorageDomain;
  readonly envelope: ArtifactEnvelope;
  readonly provenance_manifest: ProvenanceManifest;
  readonly boundary_label: StorageBoundaryLabel;
  readonly ref_bundle: StorageRefBundle;
  readonly stored_at_ms: number;
  readonly determinism_hash: string;
}

export interface StorageWriteReport<TRecord> {
  readonly schema_version: typeof STORAGE_FOUNDATION_SCHEMA_VERSION;
  readonly write_ref: Ref;
  readonly decision: StorageWriteDecision;
  readonly record?: TRecord;
  readonly rejected_reasons: readonly string[];
  readonly audit_refs: readonly Ref[];
  readonly determinism_hash: string;
}

export function buildStoredArtifactRecord(input: {
  readonly domain: StorageDomain;
  readonly envelope_input: ArtifactEnvelopeInput;
  readonly provenance_manifest: ProvenanceManifest;
  readonly boundary_label?: StorageBoundaryLabel;
  readonly replay_refs: readonly Ref[];
  readonly audit_refs: readonly Ref[];
  readonly stored_at_ms: number;
}): StoredArtifactRecord {
  const envelope = buildArtifactEnvelope({
    ...input.envelope_input,
    provenance_manifest_ref: input.provenance_manifest.provenance_manifest_ref,
    visibility_class: visibilityForBoundary(input.boundary_label ?? boundaryFromVisibility(input.envelope_input.visibility_class)),
    audit_replay_refs: [...(input.envelope_input.audit_replay_refs ?? []), ...input.replay_refs, ...input.audit_refs],
  });
  const boundary = input.boundary_label ?? boundaryFromVisibility(envelope.visibility_class);
  const refBundle = freezeObject({
    artifact_ref: envelope.artifact_ref,
    provenance_manifest_ref: envelope.provenance_manifest_ref,
    replay_refs: uniqueStorageRefs(input.replay_refs),
    audit_refs: uniqueStorageRefs([...input.audit_refs, ...envelope.audit_replay_refs]),
  });
  const base = {
    schema_version: STORAGE_FOUNDATION_SCHEMA_VERSION,
    storage_record_ref: makeStorageRef("storage_record", input.domain, envelope.artifact_ref),
    domain: input.domain,
    envelope,
    provenance_manifest: input.provenance_manifest,
    boundary_label: boundary,
    ref_bundle: refBundle,
    stored_at_ms: input.stored_at_ms,
  };
  return freezeObject({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function writeReport<TRecord>(
  writeRef: Ref,
  decision: StorageWriteDecision,
  record: TRecord | undefined,
  rejectedReasons: readonly string[],
  auditRefs: readonly Ref[],
): StorageWriteReport<TRecord> {
  const base = {
    schema_version: STORAGE_FOUNDATION_SCHEMA_VERSION,
    write_ref: cleanStorageRef(writeRef),
    decision,
    record,
    rejected_reasons: freezeArray(rejectedReasons),
    audit_refs: uniqueStorageRefs(auditRefs),
  };
  return freezeObject({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function boundaryFromVisibility(visibility: ApiVisibilityClass): StorageBoundaryLabel {
  switch (visibility) {
    case "runtime_cognitive":
    case "runtime_deterministic":
      return "runtime";
    case "developer_observability":
    case "redacted":
      return "developer_observability";
    case "qa_offline":
      return "qa_offline";
    case "restricted_quarantine":
      return "restricted_quarantine";
  }
}

export function visibilityForBoundary(boundary: StorageBoundaryLabel): ApiVisibilityClass {
  switch (boundary) {
    case "runtime":
      return "runtime_deterministic";
    case "runtime_memory":
      return "runtime_cognitive";
    case "developer_observability":
      return "developer_observability";
    case "qa_offline":
      return "qa_offline";
    case "restricted_quarantine":
      return "restricted_quarantine";
    case "release_evidence":
      return "developer_observability";
  }
}

export function makeStorageRef(...parts: readonly (string | number | undefined)[]): Ref {
  const normalized = parts
    .filter((part): part is string | number => part !== undefined)
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "storage:empty";
}

export function cleanStorageRef(value: Ref): Ref {
  return makeStorageRef(value);
}

export function uniqueStorageRefs(values: readonly (Ref | undefined)[]): readonly Ref[] {
  return freezeArray([...new Set(values.filter((value): value is Ref => value !== undefined && value.trim().length > 0).map(cleanStorageRef))].sort());
}

export function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

export function freezeObject<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

