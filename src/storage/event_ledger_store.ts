/**
 * Append-first event ledger foundation for PIT-B04.
 */

import type { ServiceEventEnvelope } from "../api/service_event_bus_contract";
import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref } from "../simulation/world_manifest";
import { freezeArray, freezeObject, makeStorageRef, uniqueStorageRefs, writeReport, type StorageWriteReport } from "./storage_contracts";

export const EVENT_LEDGER_STORE_SCHEMA_VERSION = "mebsuta.storage.event_ledger.v1" as const;

export interface EventLedgerEntry {
  readonly schema_version: typeof EVENT_LEDGER_STORE_SCHEMA_VERSION;
  readonly ledger_entry_ref: Ref;
  readonly sequence: number;
  readonly cursor_ref: Ref;
  readonly event: ServiceEventEnvelope;
  readonly replay_refs: readonly Ref[];
  readonly acknowledged: boolean;
  readonly determinism_hash: string;
}

export class EventLedgerStore {
  private readonly entries: EventLedgerEntry[] = [];
  private readonly seenEventRefs = new Set<Ref>();

  public append(event: ServiceEventEnvelope, replayRefs: readonly Ref[]): StorageWriteReport<EventLedgerEntry> {
    if (this.seenEventRefs.has(event.service_event_ref)) {
      return writeReport<EventLedgerEntry>(makeStorageRef("event_ledger_write", event.service_event_ref), "rejected", undefined, ["Duplicate service event ref rejected by idempotency gate."], [event.service_event_ref, ...event.audit_refs]);
    }
    if (replayRefs.length === 0) {
      return writeReport<EventLedgerEntry>(makeStorageRef("event_ledger_write", event.service_event_ref), "rejected", undefined, ["Event ledger entries require replay refs."], event.audit_refs);
    }
    const sequence = this.entries.length + 1;
    const base = {
      schema_version: EVENT_LEDGER_STORE_SCHEMA_VERSION,
      ledger_entry_ref: makeStorageRef("event_ledger_entry", sequence, event.service_event_ref),
      sequence,
      cursor_ref: makeStorageRef("event_cursor", sequence),
      event,
      replay_refs: uniqueStorageRefs(replayRefs),
      acknowledged: !event.acknowledgement_required,
    };
    const entry = freezeObject({ ...base, determinism_hash: computeDeterminismHash(base) });
    this.entries.push(entry);
    this.seenEventRefs.add(event.service_event_ref);
    return writeReport(makeStorageRef("event_ledger_write", event.service_event_ref), "accepted", entry, [], [event.service_event_ref, ...event.audit_refs, ...replayRefs]);
  }

  public acknowledge(eventRef: Ref): EventLedgerEntry | undefined {
    const index = this.entries.findIndex((entry) => entry.event.service_event_ref === eventRef);
    if (index < 0) {
      return undefined;
    }
    const current = this.entries[index];
    const base = { ...current, acknowledged: true };
    const updated = freezeObject({ ...base, determinism_hash: computeDeterminismHash(base) });
    this.entries[index] = updated;
    return updated;
  }

  public readFrom(sequence: number, limit = 100): readonly EventLedgerEntry[] {
    return freezeArray(this.entries.filter((entry) => entry.sequence > sequence).slice(0, limit));
  }

  public snapshot(): readonly EventLedgerEntry[] {
    return freezeArray([...this.entries]);
  }
}
