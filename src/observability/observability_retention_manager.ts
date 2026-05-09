/**
 * Observability retention manager for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/17_INTERNAL_MONOLOGUE_TTS_OBSERVABILITY.md`
 * sections 17.4.1, 17.12.4, 17.16, 17.18.2, and 17.19.
 *
 * The manager applies deterministic retention rules that keep safety,
 * verification, replay, and redaction audit records while reducing routine
 * low-risk observability volume.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref } from "../simulation/world_manifest";
import {
  freezeArray,
  makeObservabilityRef,
  severityRank,
  uniqueRefs,
} from "./observability_event_emitter";
import type {
  ObservabilityEvent,
  RedactionReport,
  ReplayBundle,
  RetentionAction,
  RetentionActionReport,
} from "./observability_event_emitter";

export const OBSERVABILITY_RETENTION_MANAGER_SCHEMA_VERSION = "mebsuta.observability_retention_manager.v1" as const;

export interface RetentionPolicy {
  readonly retention_policy_ref: Ref;
  readonly routine_ttl_ms: number;
  readonly archive_after_ms: number;
  readonly preserve_safety_and_verification: boolean;
  readonly preserve_redaction_audits: boolean;
  readonly preserve_replay_bundles: boolean;
}

export interface RetentionCandidate {
  readonly record_ref: Ref;
  readonly event?: ObservabilityEvent;
  readonly redaction_report?: RedactionReport;
  readonly replay_bundle?: ReplayBundle;
  readonly recorded_at_ms: number;
  readonly raw_payload_refs?: readonly Ref[];
}

/**
 * Applies retention policy to observability records without mutating storage.
 */
export class ObservabilityRetentionManager {
  public applyObservabilityRetention(records: readonly RetentionCandidate[], retentionPolicy: RetentionPolicy, nowMs: number): RetentionActionReport {
    const retained: Ref[] = [];
    const summarized: Ref[] = [];
    const archived: Ref[] = [];
    const deletedRaw: Ref[] = [];
    const audit: Ref[] = [];

    for (const record of records) {
      const action = chooseAction(record, retentionPolicy, nowMs);
      if (action === "retain_full") {
        retained.push(record.record_ref);
      } else if (action === "summarize") {
        summarized.push(record.record_ref);
        deletedRaw.push(...(record.raw_payload_refs ?? []));
      } else if (action === "archive") {
        archived.push(record.record_ref);
      } else {
        deletedRaw.push(record.record_ref, ...(record.raw_payload_refs ?? []));
      }
      audit.push(...auditRefs(record, retentionPolicy));
    }

    const base = {
      retention_report_ref: makeObservabilityRef("retention_report", retentionPolicy.retention_policy_ref, nowMs),
      policy_ref: retentionPolicy.retention_policy_ref,
      retained_refs: uniqueRefs(retained),
      summarized_refs: uniqueRefs(summarized),
      archived_refs: uniqueRefs(archived),
      deleted_raw_refs: uniqueRefs(deletedRaw),
      preserved_audit_refs: uniqueRefs(audit),
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

function chooseAction(record: RetentionCandidate, policy: RetentionPolicy, nowMs: number): RetentionAction {
  const age = Math.max(0, nowMs - record.recorded_at_ms);
  if (policy.preserve_safety_and_verification && isSafetyCritical(record)) {
    return age >= policy.archive_after_ms ? "archive" : "retain_full";
  }
  if (policy.preserve_redaction_audits && record.redaction_report?.audit_required === true) {
    return age >= policy.archive_after_ms ? "archive" : "retain_full";
  }
  if (policy.preserve_replay_bundles && record.replay_bundle !== undefined) {
    return age >= policy.archive_after_ms ? "archive" : "retain_full";
  }
  if (age >= policy.archive_after_ms) {
    return "delete_raw_keep_manifest";
  }
  if (age >= policy.routine_ttl_ms) {
    return "summarize";
  }
  return "retain_full";
}

function isSafetyCritical(record: RetentionCandidate): boolean {
  const event = record.event;
  if (event === undefined) {
    return false;
  }
  return event.event_class === "safety"
    || event.event_class === "verification"
    || severityRank(event.severity) >= severityRank("error");
}

function auditRefs(record: RetentionCandidate, policy: RetentionPolicy): readonly Ref[] {
  const refs: Ref[] = [];
  if (policy.preserve_safety_and_verification && record.event !== undefined && isSafetyCritical(record)) {
    refs.push(record.event.observability_event_ref, ...record.event.artifact_refs);
  }
  if (policy.preserve_redaction_audits && record.redaction_report !== undefined) {
    refs.push(record.redaction_report.redaction_report_ref, ...record.redaction_report.blocked_claim_refs, ...record.redaction_report.rewritten_claim_refs);
  }
  if (policy.preserve_replay_bundles && record.replay_bundle !== undefined) {
    refs.push(record.replay_bundle.replay_bundle_ref, ...record.replay_bundle.evidence_refs);
  }
  return freezeArray(refs);
}

export const OBSERVABILITY_RETENTION_MANAGER_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: OBSERVABILITY_RETENTION_MANAGER_SCHEMA_VERSION,
  blueprint: "architecture_docs/17_INTERNAL_MONOLOGUE_TTS_OBSERVABILITY.md",
  sections: freezeArray(["17.4.1", "17.12.4", "17.16", "17.18.2", "17.19"]),
  component: "ObservabilityRetentionManager",
});
