import { describe, expect, it } from "vitest";

import { buildArtifactEnvelope, makeApiRef } from "../../src/api/artifact_envelope";
import { buildProvenanceManifest } from "../../src/api/provenance_manifest_contract";
import { buildServiceEventEnvelope } from "../../src/api/service_event_bus_contract";
import { ObservabilityEventEmitter } from "../../src/observability/observability_event_emitter";
import { ReplayTraceAssembler } from "../../src/observability/replay_trace_assembler";
import { ArtifactStateStore } from "../../src/storage/artifact_state_store";
import { buildBackupManifest, validateRestoreManifest } from "../../src/storage/backup_restore_manifest";
import { EventLedgerStore } from "../../src/storage/event_ledger_store";
import { IncidentReleaseStore } from "../../src/storage/incident_release_store";
import { MemoryStateStore } from "../../src/storage/memory_state_store";
import { ReplayStateStore } from "../../src/storage/replay_state_store";

describe("PIT-B04 data storage and state foundation", () => {
  it("preserves artifact envelope, provenance, replay refs, and runtime boundary labels", () => {
    const store = new ArtifactStateStore();
    const provenance = buildRuntimeProvenance("provenance:artifact");
    const written = store.persist({
      domain: "artifact_store",
      envelope_input: {
        artifact_ref: "artifact:runtime:route",
        artifact_type: "route_decision",
        schema_ref: "schema:route:v1",
        service_of_record: "agent_orchestration",
        created_at_ms: 1_000,
        created_by_component: "storage:artifact_store",
        provenance_manifest_ref: provenance.provenance_manifest_ref,
        visibility_class: "runtime_deterministic",
        validation_status: "valid",
      },
      provenance_manifest: provenance,
      replay_refs: ["replay:route"],
      audit_refs: ["audit:route"],
      stored_at_ms: 1_001,
    });

    expect(written.decision).toBe("accepted");
    expect(written.record?.envelope.provenance_manifest_ref).toBe("provenance:artifact");
    expect(written.record?.ref_bundle.replay_refs).toContain("replay:route");
    expect(written.record?.boundary_label).toBe("runtime");
  });

  it("stores ordered event ledger entries and rejects duplicate event refs", () => {
    const ledger = new EventLedgerStore();
    const event = buildRuntimeEvent("event:ledger:one", "artifact:ledger:one");

    const first = ledger.append(event, ["replay:event:one"]);
    const duplicate = ledger.append(event, ["replay:event:one"]);

    expect(first.decision).toBe("accepted");
    expect(first.record?.sequence).toBe(1);
    expect(duplicate.decision).toBe("rejected");
    expect(ledger.readFrom(0)).toHaveLength(1);
  });

  it("rejects unsafe or unverified memory writes through the memory write gate", () => {
    const store = new MemoryStateStore();
    const rejected = store.evaluateAndPersist({
      source_artifact: {
        artifact_ref: "memory:verified:no-certificate",
        requested_record_class: "verified_spatial",
        confidence: 0.95,
        summary: "Object was seen through embodied observation.",
      },
      evidence_manifest: {
        provenance_manifest_ref: "provenance:memory:verified",
        source_event_refs: ["event:memory"],
        source_evidence_refs: ["evidence:camera"],
        source_kind: "verification_certificate",
        truth_boundary_status: "runtime_embodied_only",
        evidence_timestamp_ms: 2_000,
        prompt_safe_summary: "Embodied evidence only.",
      },
      policy: { policy_ref: "memory_policy:storage:test" },
      current_time_ms: 2_001,
      replay_refs: ["replay:memory"],
    });
    const unsafe = store.evaluateAndPersist({
      source_artifact: {
        artifact_ref: "memory:unsafe",
        requested_record_class: "observed_spatial",
        confidence: 0.8,
        summary: "Contains object_id style restricted wording.",
      },
      evidence_manifest: {
        provenance_manifest_ref: "provenance:memory:unsafe",
        source_event_refs: ["event:memory:unsafe"],
        source_evidence_refs: ["evidence:memory:unsafe"],
        source_kind: "perception_observation",
        truth_boundary_status: "contains_forbidden_truth",
        evidence_timestamp_ms: 2_000,
        prompt_safe_summary: "Unsafe source should be blocked.",
      },
      policy: { policy_ref: "memory_policy:storage:test" },
      current_time_ms: 2_001,
      replay_refs: ["replay:memory:unsafe"],
    });

    expect(rejected.decision).toBe("rejected");
    expect(rejected.rejected_reasons[0]).toContain("certificate");
    expect(unsafe.decision).toBe("rejected");
    expect(store.list()).toHaveLength(0);
  });

  it("persists replay records and validates backup/restore manifests for review-only recovery", () => {
    const emitter = new ObservabilityEventEmitter();
    const event = emitter.emitObservabilityEvent({
      artifact_ref: "artifact:replay",
      event_time_ms: 3_000,
      event_class: "memory",
      subsystem_ref: "memory:storage",
      severity: "info",
      summary: "Memory decision preserved with replay evidence.",
      artifact_refs: ["evidence:replay"],
      task_ref: "task:replay",
      provenance_status: "memory",
    });
    const bundle = new ReplayTraceAssembler().assembleReplayTrace("task:replay", { start_ms: 2_999, end_ms: 3_001 }, { task_ref: "task:replay", timeline_events: [event] }, {
      visibility_mode: "developer",
      include_qa_events: false,
      preserve_safety_events: true,
    });
    const replayStore = new ReplayStateStore();
    const replayWrite = replayStore.persist(bundle, ["audit:replay"]);
    const manifest = buildBackupManifest({
      environment_label: "release_candidate",
      schema_refs: ["schema:storage:v1"],
      artifact_refs: ["artifact:replay"],
      event_refs: [event.observability_event_ref],
      replay_refs: [bundle.replay_bundle_ref],
      memory_refs: ["memory:decision"],
      incident_refs: ["incident:storage"],
      release_refs: ["release:evidence"],
      created_at_ms: 3_100,
    });
    const restore = validateRestoreManifest(manifest);

    expect(replayWrite.decision).toBe("accepted");
    expect(replayWrite.record?.complete_for_review).toBe(true);
    expect(restore.valid_for_replay_review).toBe(true);
    expect(restore.valid_for_live_authority).toBe(false);
  });

  it("retains risk, incident, and release audit refs without creating operations workflows", () => {
    const store = new IncidentReleaseStore();
    const incident = store.persistIncident({
      severity: "sev1",
      incident_class: "storage",
      summary: "Storage replay evidence lag detected and preserved for review.",
      evidence_refs: ["evidence:incident"],
      audit_refs: ["audit:incident"],
      opened_at_ms: 4_000,
    });
    const risk = store.persistRisk({
      risk_class: "storage",
      severity: "high",
      status: "open",
      summary: "Storage replay evidence lag has a mitigation ref and preserved audit evidence.",
      evidence_refs: ["evidence:risk"],
      mitigation_refs: ["mitigation:storage"],
      audit_refs: ["audit:risk"],
      recorded_at_ms: 4_050,
    });
    const release = store.persistRelease({
      decision: "conditional_go",
      evidence_refs: ["evidence:release"],
      replay_refs: ["replay:release"],
      risk_refs: ["risk:storage"],
      audit_refs: ["audit:release"],
      recorded_at_ms: 4_100,
    });

    expect(incident.decision).toBe("accepted");
    expect(incident.record?.audit_refs).toContain("audit:incident");
    expect(risk.decision).toBe("accepted");
    expect(risk.record?.mitigation_refs).toContain("mitigation:storage");
    expect(store.listRisks()).toHaveLength(1);
    expect(release.decision).toBe("accepted");
    expect(release.record?.replay_refs).toContain("replay:release");
  });
});

function buildRuntimeProvenance(ref: string) {
  return buildProvenanceManifest({
    provenance_manifest_ref: ref,
    source_classes: ["embodied_sensor", "validator_output"],
    cognitive_visibility: "summarized",
    memory_visibility: "summary_only",
    qa_visibility: "not_allowed",
    truth_boundary_status: "runtime_embodied_only",
    source_artifact_refs: ["evidence:camera"],
    policy_refs: ["policy:storage:test"],
    audit_notes: ["Runtime storage boundary test."],
  });
}

function buildRuntimeEvent(eventRef: string, artifactRef: string) {
  const envelope = buildArtifactEnvelope({
    artifact_ref: artifactRef,
    artifact_type: "memory_record",
    schema_ref: makeApiRef("schema", "memory_record", "v1"),
    service_of_record: "rag_memory",
    created_at_ms: 1_500,
    created_by_component: "storage:event_ledger",
    provenance_manifest_ref: "provenance:event",
    visibility_class: "runtime_cognitive",
    validation_status: "valid",
    audit_replay_refs: ["audit:event"],
  });
  return buildServiceEventEnvelope({
    service_event_ref: eventRef,
    event_class: "MemoryReadWriteEvent",
    producer_service: "rag_memory",
    consumer_services: ["agent_orchestration", "observability_tts"],
    artifact_envelope: envelope,
    occurred_at_ms: 1_501,
    delivery_requirement: "idempotent_by_source",
    priority: "routine",
    ordering_key_ref: "ordering:memory",
    acknowledgement_required: false,
    audit_refs: ["audit:event"],
  });
}
