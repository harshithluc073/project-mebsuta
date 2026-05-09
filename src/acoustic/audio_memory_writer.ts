/**
 * Acoustic memory write adapter.
 *
 * Blueprint: `architecture_docs/16_ACOUSTIC_EMBODIMENT_AUDIO_REASONING.md`
 * sections 16.12, 16.16.3, 16.18, 16.21, and 16.24, with write-gate
 * constraints from `architecture_docs/15_RAG_EPISODIC_SPATIAL_MEMORY_ARCHITECTURE.md`.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import { MemoryWriteGate, MemoryWriteDecision, MemoryWriteGateReport, MemoryWritePolicy } from "../memory/memory_write_gate";
import type { MemoryEvidenceManifest, MemorySourceArtifact } from "../memory/memory_write_gate";
import { AudioRoute, freezeArray, makeAcousticRef, uniqueRefs } from "./audio_sensor_bus";
import type { AudioRouteDecision, AudioRouteDecisionSet } from "./audio_reasoning_router";

export const AUDIO_MEMORY_WRITER_SCHEMA_VERSION = "mebsuta.audio_memory_writer.v1" as const;

export type AcousticMemoryClass = "acoustic_event_note" | "search_hint" | "failure_cue_memory" | "tool_contact_memory" | "safety_sound_memory";

export interface AcousticMemoryWriteRecord {
  readonly schema_version: typeof AUDIO_MEMORY_WRITER_SCHEMA_VERSION;
  readonly acoustic_memory_ref: Ref;
  readonly route_decision_ref: Ref;
  readonly acoustic_memory_class: AcousticMemoryClass;
  readonly memory_gate_report: MemoryWriteGateReport;
  readonly accepted: boolean;
  readonly limitations: readonly string[];
  readonly determinism_hash: string;
}

export interface AcousticMemoryWriteSet {
  readonly schema_version: typeof AUDIO_MEMORY_WRITER_SCHEMA_VERSION;
  readonly acoustic_memory_write_set_ref: Ref;
  readonly records: readonly AcousticMemoryWriteRecord[];
  readonly skipped_decision_refs: readonly Ref[];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface AcousticMemoryWriterPolicy {
  readonly memory_policy?: MemoryWritePolicy;
  readonly current_time_ms?: number;
}

export class AudioMemoryWriter {
  private readonly gate: MemoryWriteGate;
  private readonly memoryPolicy: MemoryWritePolicy;

  public constructor(policy: AcousticMemoryWriterPolicy = {}) {
    this.memoryPolicy = policy.memory_policy ?? { policy_ref: "memory_policy:file16:acoustic", min_observed_confidence: 0.32, max_pose_uncertainty_m: 1.5 };
    this.gate = new MemoryWriteGate(this.memoryPolicy);
  }

  /**
   * Writes acoustic cues through the File 15 memory write gate.
   */
  public writeAcousticMemory(decisionSet: AudioRouteDecisionSet, currentTimeMs = 0): AcousticMemoryWriteSet {
    const records: AcousticMemoryWriteRecord[] = [];
    const skipped: Ref[] = [];
    for (const decision of decisionSet.decisions) {
      if (!decision.memory_write_requested) {
        skipped.push(decision.route_decision_ref);
        continue;
      }
      records.push(this.writeOne(decision, currentTimeMs));
    }
    const base = {
      schema_version: AUDIO_MEMORY_WRITER_SCHEMA_VERSION,
      acoustic_memory_write_set_ref: makeAcousticRef("acoustic_memory_write_set", decisionSet.route_decision_set_ref, records.length),
      records: freezeArray(records),
      skipped_decision_refs: uniqueRefs(skipped),
      issues: decisionSet.issues,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }

  private writeOne(decision: AudioRouteDecision, currentTimeMs: number): AcousticMemoryWriteRecord {
    const memoryClass = memoryClassFor(decision.selected_route);
    const sourceArtifact: MemorySourceArtifact = Object.freeze({
      artifact_ref: makeAcousticRef("acoustic_memory_artifact", decision.route_decision_ref),
      requested_record_class: memoryClass === "search_hint" ? "search_hint" : memoryClass === "failure_cue_memory" ? "oops_episode" : memoryClass === "safety_sound_memory" ? "safety" : "acoustic_event",
      confidence: confidenceFor(decision),
      summary: `${decision.route_reason} Acoustic memory is a cue only and cannot certify spatial success.`,
      contradiction_refs: freezeArray([]),
    });
    const evidenceManifest: MemoryEvidenceManifest = Object.freeze({
      provenance_manifest_ref: makeAcousticRef("acoustic_provenance", decision.correlation_report_ref),
      source_event_refs: uniqueRefs([decision.correlation_report_ref, decision.route_decision_ref]),
      source_evidence_refs: uniqueRefs(decision.required_evidence_refs),
      source_kind: "acoustic_event",
      truth_boundary_status: "runtime_embodied_only",
      evidence_timestamp_ms: currentTimeMs,
      prompt_safe_summary: "Acoustic memory is stored as embodied sound context, search hint, or failure cue with explicit uncertainty.",
    });
    const gateReport = this.gate.evaluateMemoryWrite(sourceArtifact, evidenceManifest, this.memoryPolicy, currentTimeMs, makeAcousticRef("acoustic_memory_request", decision.route_decision_ref));
    const base = {
      schema_version: AUDIO_MEMORY_WRITER_SCHEMA_VERSION,
      acoustic_memory_ref: makeAcousticRef("acoustic_memory", decision.route_decision_ref, memoryClass),
      route_decision_ref: decision.route_decision_ref,
      acoustic_memory_class: memoryClass,
      memory_gate_report: gateReport,
      accepted: gateReport.ok,
      limitations: limitationsFor(decision.selected_route, gateReport.decision),
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function writeAcousticMemory(decisionSet: AudioRouteDecisionSet, currentTimeMs = 0, policy: AcousticMemoryWriterPolicy = {}): AcousticMemoryWriteSet {
  return new AudioMemoryWriter(policy).writeAcousticMemory(decisionSet, policy.current_time_ms ?? currentTimeMs);
}

function memoryClassFor(route: AudioRoute): AcousticMemoryClass {
  if (route === "reobserve") return "search_hint";
  if (route === "oops" || route === "verify") return "failure_cue_memory";
  if (route === "safe_hold" || route === "human_review") return "safety_sound_memory";
  return "acoustic_event_note";
}

function confidenceFor(decision: AudioRouteDecision): number {
  if (decision.selected_route === "safe_hold" || decision.selected_route === "oops") return 0.72;
  if (decision.selected_route === "verify" || decision.selected_route === "reobserve") return 0.58;
  if (decision.selected_route === "note") return 0.42;
  return 0.22;
}

function limitationsFor(route: AudioRoute, decision: MemoryWriteDecision): readonly string[] {
  return freezeArray([
    "audio_is_a_cue_not_spatial_proof",
    "source_identity_requires_visual_or_tactile_confirmation",
    route === "reobserve" ? "direction_is_search_prior_only" : "route_requires_downstream_evidence_review",
    decision.accepted ? "memory_visible_as_uncertain_context" : "memory_write_denied_or_quarantined",
  ]);
}
