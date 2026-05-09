/**
 * Memory audit recorder for Project Mebsuta episodic memory.
 *
 * Blueprint: `architecture_docs/15_RAG_EPISODIC_SPATIAL_MEMORY_ARCHITECTURE.md`
 * sections 15.4.1, 15.8, 15.11, 15.19.3, 15.20.1, 15.23, and 15.24.
 *
 * The recorder creates deterministic audit trail entries for memory writes,
 * reads, updates, quarantine actions, decay updates, and prompt formatting.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  MEMORY_BLUEPRINT_REF,
  cleanMemoryRef,
  cleanMemoryText,
  freezeMemoryArray,
  makeMemoryIssue,
  makeMemoryRef,
  uniqueMemoryRefs,
} from "./memory_write_gate";

export const MEMORY_AUDIT_RECORDER_SCHEMA_VERSION = "mebsuta.memory_audit_recorder.v1" as const;

export type MemoryAuditEventKind = "write_decision" | "record_built" | "retrieval_read" | "prompt_context" | "contradiction_update" | "decay_update" | "quarantine" | "archive";

export interface MemoryAuditEventInput {
  readonly event_ref?: Ref;
  readonly event_kind: MemoryAuditEventKind;
  readonly memory_record_refs: readonly Ref[];
  readonly artifact_refs: readonly Ref[];
  readonly actor_ref: Ref;
  readonly timestamp_ms: number;
  readonly decision_summary: string;
  readonly replay_material_refs?: readonly Ref[];
}

export interface MemoryAuditEvent {
  readonly schema_version: typeof MEMORY_AUDIT_RECORDER_SCHEMA_VERSION;
  readonly blueprint_ref: typeof MEMORY_BLUEPRINT_REF;
  readonly audit_event_ref: Ref;
  readonly event_kind: MemoryAuditEventKind;
  readonly memory_record_refs: readonly Ref[];
  readonly artifact_refs: readonly Ref[];
  readonly actor_ref: Ref;
  readonly timestamp_ms: number;
  readonly decision_summary: string;
  readonly replay_material_refs: readonly Ref[];
  readonly cognitive_visibility: "memory_audit_event";
  readonly determinism_hash: string;
}

export interface MemoryAuditTrailReport {
  readonly schema_version: typeof MEMORY_AUDIT_RECORDER_SCHEMA_VERSION;
  readonly blueprint_ref: typeof MEMORY_BLUEPRINT_REF;
  readonly trail_ref: Ref;
  readonly audit_events: readonly MemoryAuditEvent[];
  readonly replay_ready: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "memory_audit_trail_report";
  readonly determinism_hash: string;
}

export class MemoryAuditRecorder {
  /**
   * Records one memory audit event with deterministic replay metadata.
   */
  public recordMemoryAuditEvent(input: MemoryAuditEventInput): MemoryAuditEvent {
    const eventRef = cleanMemoryRef(input.event_ref ?? makeMemoryRef("memory_audit_event", input.event_kind, input.timestamp_ms.toString(), input.actor_ref));
    const base = {
      schema_version: MEMORY_AUDIT_RECORDER_SCHEMA_VERSION,
      blueprint_ref: MEMORY_BLUEPRINT_REF,
      audit_event_ref: eventRef,
      event_kind: input.event_kind,
      memory_record_refs: uniqueMemoryRefs(input.memory_record_refs),
      artifact_refs: uniqueMemoryRefs(input.artifact_refs),
      actor_ref: cleanMemoryRef(input.actor_ref),
      timestamp_ms: input.timestamp_ms,
      decision_summary: cleanMemoryText(input.decision_summary),
      replay_material_refs: uniqueMemoryRefs(input.replay_material_refs ?? []),
      cognitive_visibility: "memory_audit_event" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }

  /**
   * Builds an ordered audit trail and validates replay coverage.
   */
  public buildAuditTrail(events: readonly MemoryAuditEventInput[], trailRef?: Ref): MemoryAuditTrailReport {
    const issues: ValidationIssue[] = [];
    validateInputs(events, issues);
    const auditEvents = events.map((event) => this.recordMemoryAuditEvent(event)).sort(compareEvents);
    const replayReady = auditEvents.length > 0 && auditEvents.every((event) => event.replay_material_refs.length > 0 || event.artifact_refs.length > 0);
    if (!replayReady) {
      issues.push(makeMemoryIssue("warning", "MemoryEvidenceMissing", "$.audit_events.replay_material_refs", "Some audit events lack replay material refs.", "Attach source artifacts or replay evidence refs for QA."));
    }
    const base = {
      schema_version: MEMORY_AUDIT_RECORDER_SCHEMA_VERSION,
      blueprint_ref: MEMORY_BLUEPRINT_REF,
      trail_ref: cleanMemoryRef(trailRef ?? makeMemoryRef("memory_audit_trail", auditEvents.map((event) => event.audit_event_ref).join(":") || "empty")),
      audit_events: freezeMemoryArray(auditEvents),
      replay_ready: replayReady,
      issues: freezeMemoryArray(issues),
      ok: !issues.some((issue) => issue.severity === "error"),
      cognitive_visibility: "memory_audit_trail_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function recordMemoryAuditEvent(input: MemoryAuditEventInput): MemoryAuditEvent {
  return new MemoryAuditRecorder().recordMemoryAuditEvent(input);
}

export function buildAuditTrail(events: readonly MemoryAuditEventInput[], trailRef?: Ref): MemoryAuditTrailReport {
  return new MemoryAuditRecorder().buildAuditTrail(events, trailRef);
}

function validateInputs(events: readonly MemoryAuditEventInput[], issues: ValidationIssue[]): void {
  if (events.length === 0) {
    issues.push(makeMemoryIssue("error", "MemoryEvidenceMissing", "$.events", "Audit trail requires at least one event.", "Record write, read, update, quarantine, or prompt events."));
  }
  for (const [index, event] of events.entries()) {
    if (!Number.isFinite(event.timestamp_ms) || event.timestamp_ms < 0) {
      issues.push(makeMemoryIssue("error", "MemorySchemaInvalid", `$.events[${index}].timestamp_ms`, "Audit event timestamp must be finite and nonnegative.", "Use monotonic runtime timestamps."));
    }
    if (event.memory_record_refs.length === 0 && event.artifact_refs.length === 0) {
      issues.push(makeMemoryIssue("warning", "MemoryEvidenceMissing", `$.events[${index}]`, "Audit event has no memory record or artifact refs.", "Attach at least one memory or artifact reference."));
    }
  }
}

function compareEvents(a: MemoryAuditEvent, b: MemoryAuditEvent): number {
  return a.timestamp_ms - b.timestamp_ms || a.audit_event_ref.localeCompare(b.audit_event_ref);
}
