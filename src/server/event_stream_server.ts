/**
 * Ordered in-process event stream foundation for PIT-B03.
 */

import { buildArtifactEnvelope, makeApiRef, type ApiServiceRef, type ArtifactType } from "../api/artifact_envelope";
import { buildServiceEventEnvelope, deliveryForEventClass, eventClassForArtifact, type ServiceEventEnvelope } from "../api/service_event_bus_contract";
import { createDefaultServiceBoundaryRegistry } from "../api/service_boundary_registry";
import { freezeArray, makeServerRef } from "./api_contracts";

export const EVENT_STREAM_SERVER_SCHEMA_VERSION = "mebsuta.backend_api.event_stream.v1" as const;

export interface EventStreamPublishRequest {
  readonly artifact_ref: string;
  readonly artifact_type: ArtifactType;
  readonly service_of_record: ApiServiceRef;
  readonly created_at_ms: number;
  readonly visibility_class: "runtime_deterministic" | "developer_observability" | "qa_offline" | "restricted_quarantine" | "redacted";
  readonly consumer_services: readonly ApiServiceRef[];
  readonly ordering_key_ref?: string;
  readonly audit_refs: readonly string[];
}

export interface EventStreamCursor {
  readonly cursor_ref: string;
  readonly last_sequence: number;
}

export class BackendEventStream {
  private readonly registry = createDefaultServiceBoundaryRegistry();
  private readonly events: ServiceEventEnvelope[] = [];

  public publish(request: EventStreamPublishRequest): ServiceEventEnvelope {
    const envelope = buildArtifactEnvelope({
      artifact_ref: request.artifact_ref,
      artifact_type: request.artifact_type,
      schema_ref: makeApiRef("schema", request.artifact_type, "v1"),
      service_of_record: request.service_of_record,
      created_at_ms: request.created_at_ms,
      created_by_component: "api_route:event_stream",
      provenance_manifest_ref: makeApiRef("provenance", request.artifact_ref),
      visibility_class: request.visibility_class,
      validation_status: request.visibility_class === "restricted_quarantine" ? "quarantined" : "valid",
      audit_replay_refs: request.audit_refs,
    });
    const ownership = this.registry.validateEnvelopeOwnership(envelope, request.consumer_services);
    if (ownership.decision !== "owner_confirmed") {
      throw new Error(`Event artifact ownership rejected: ${ownership.decision}.`);
    }
    const eventClass = eventClassForArtifact(request.artifact_type);
    const delivery = deliveryForEventClass(eventClass);
    const sequence = this.events.length + 1;
    const event = buildServiceEventEnvelope({
      service_event_ref: makeServerRef("service_event", sequence, request.artifact_ref),
      event_class: eventClass,
      producer_service: request.service_of_record,
      consumer_services: request.consumer_services,
      artifact_envelope: envelope,
      occurred_at_ms: request.created_at_ms,
      delivery_requirement: delivery,
      priority: eventClass === "SafeHoldEvent" || eventClass === "SafetyValidationEvent" ? "safety_critical" : request.visibility_class === "qa_offline" ? "qa_only" : "routine",
      ordering_key_ref: request.ordering_key_ref ?? makeServerRef("ordering", request.artifact_ref),
      acknowledgement_required: delivery === "must_ack" || delivery === "strict_for_safety",
      audit_refs: request.audit_refs,
    });
    this.events.push(event);
    return event;
  }

  public readFrom(cursor: EventStreamCursor | undefined, limit = 100): readonly ServiceEventEnvelope[] {
    const after = cursor?.last_sequence ?? 0;
    return freezeArray(this.events.slice(after, after + limit));
  }

  public cursor(): EventStreamCursor {
    return Object.freeze({
      cursor_ref: makeServerRef("event_cursor", this.events.length),
      last_sequence: this.events.length,
    });
  }
}
