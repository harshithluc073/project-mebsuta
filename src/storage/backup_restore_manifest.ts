/**
 * Deterministic backup and restore manifest shape for PIT-B04.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref } from "../simulation/world_manifest";
import { freezeArray, freezeObject, makeStorageRef, uniqueStorageRefs } from "./storage_contracts";

export const BACKUP_RESTORE_MANIFEST_SCHEMA_VERSION = "mebsuta.storage.backup_restore_manifest.v1" as const;

export interface BackupManifest {
  readonly schema_version: typeof BACKUP_RESTORE_MANIFEST_SCHEMA_VERSION;
  readonly backup_manifest_ref: Ref;
  readonly environment_label: "local_validation" | "ci_validation" | "staging" | "release_candidate";
  readonly schema_refs: readonly Ref[];
  readonly artifact_refs: readonly Ref[];
  readonly event_refs: readonly Ref[];
  readonly replay_refs: readonly Ref[];
  readonly memory_refs: readonly Ref[];
  readonly incident_refs: readonly Ref[];
  readonly release_refs: readonly Ref[];
  readonly created_at_ms: number;
  readonly determinism_hash: string;
}

export interface RestoreValidationReport {
  readonly schema_version: typeof BACKUP_RESTORE_MANIFEST_SCHEMA_VERSION;
  readonly restore_report_ref: Ref;
  readonly backup_manifest_ref: Ref;
  readonly valid_for_replay_review: boolean;
  readonly valid_for_live_authority: false;
  readonly blocked_reasons: readonly string[];
  readonly determinism_hash: string;
}

export function buildBackupManifest(input: Omit<BackupManifest, "schema_version" | "backup_manifest_ref" | "determinism_hash">): BackupManifest {
  const base = {
    schema_version: BACKUP_RESTORE_MANIFEST_SCHEMA_VERSION,
    backup_manifest_ref: makeStorageRef("backup_manifest", input.environment_label, input.created_at_ms),
    environment_label: input.environment_label,
    schema_refs: uniqueStorageRefs(input.schema_refs),
    artifact_refs: uniqueStorageRefs(input.artifact_refs),
    event_refs: uniqueStorageRefs(input.event_refs),
    replay_refs: uniqueStorageRefs(input.replay_refs),
    memory_refs: uniqueStorageRefs(input.memory_refs),
    incident_refs: uniqueStorageRefs(input.incident_refs),
    release_refs: uniqueStorageRefs(input.release_refs),
    created_at_ms: input.created_at_ms,
  };
  return freezeObject({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateRestoreManifest(manifest: BackupManifest): RestoreValidationReport {
  const blockedReasons: string[] = [];
  if (manifest.schema_refs.length === 0) {
    blockedReasons.push("Restore requires schema refs.");
  }
  if (manifest.artifact_refs.length === 0 || manifest.event_refs.length === 0 || manifest.replay_refs.length === 0) {
    blockedReasons.push("Restore requires artifact, event, and replay refs.");
  }
  if (manifest.environment_label === "release_candidate" && manifest.release_refs.length === 0) {
    blockedReasons.push("Release-candidate restore requires release evidence refs.");
  }
  const base = {
    schema_version: BACKUP_RESTORE_MANIFEST_SCHEMA_VERSION,
    restore_report_ref: makeStorageRef("restore_validation", manifest.backup_manifest_ref),
    backup_manifest_ref: manifest.backup_manifest_ref,
    valid_for_replay_review: blockedReasons.length === 0,
    valid_for_live_authority: false as const,
    blocked_reasons: freezeArray(blockedReasons),
  };
  return freezeObject({ ...base, determinism_hash: computeDeterminismHash(base) });
}

