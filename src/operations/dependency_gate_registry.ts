/**
 * Dependency gate registry.
 *
 * Blueprint: `architecture_docs/21_ROADMAP_WBS_DELIVERY_AND_PROJECT_OPERATIONS.md`
 * sections 21.7, 21.8, 21.11, 21.14, and 21.15.
 *
 * Gates make the delivery graph enforceable: each gate has required evidence,
 * review checklist items, owning workstreams, and a deterministic readiness
 * evaluator.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  OPERATIONS_BLUEPRINT_REF,
  OperationsContractError,
  buildOperationsValidationReport,
  freezeOperationsArray,
  makeOperationsRef,
  normalizeOperationsText,
  operationsIssue,
  operationsRouteForIssues,
  uniqueOperationsRefs,
  uniqueOperationsStrings,
  validateOperationsNonEmptyArray,
  validateOperationsRef,
  validateOperationsRefs,
  validateOperationsText,
} from "./milestone_registry";
import type { MilestoneRef, OperationsValidationReport } from "./milestone_registry";
import type { WorkstreamRef } from "./workstream_registry";

export const DEPENDENCY_GATE_REGISTRY_SCHEMA_VERSION = "mebsuta.operations.dependency_gate_registry.v1" as const;

export type DependencyGateRef = "G1" | "G2" | "G3" | "G4" | "G5" | "G6" | "G7" | "G8" | "G9" | "G10";
export type GateStatus = "green" | "amber" | "red" | "not_evaluated";

export interface DependencyGateInput {
  readonly gate_ref: DependencyGateRef;
  readonly gate_name: string;
  readonly required_before: string;
  readonly owner_workstream_refs: readonly WorkstreamRef[];
  readonly milestone_refs: readonly MilestoneRef[];
  readonly required_evidence_refs: readonly Ref[];
  readonly review_checklist: readonly string[];
}

export interface DependencyGate {
  readonly schema_version: typeof DEPENDENCY_GATE_REGISTRY_SCHEMA_VERSION;
  readonly gate_ref: DependencyGateRef;
  readonly gate_name: string;
  readonly required_before: string;
  readonly owner_workstream_refs: readonly WorkstreamRef[];
  readonly milestone_refs: readonly MilestoneRef[];
  readonly required_evidence_refs: readonly Ref[];
  readonly review_checklist: readonly string[];
  readonly determinism_hash: string;
}

export interface GateReadinessInput {
  readonly gate: DependencyGate;
  readonly available_evidence_refs: readonly Ref[];
  readonly unresolved_issue_refs: readonly Ref[];
}

export interface GateReadinessDecision {
  readonly gate_ref: DependencyGateRef;
  readonly status: GateStatus;
  readonly missing_evidence_refs: readonly Ref[];
  readonly unresolved_issue_refs: readonly Ref[];
  readonly reason: string;
  readonly determinism_hash: string;
}

/**
 * Builds an immutable dependency gate definition.
 */
export function buildDependencyGate(input: DependencyGateInput): DependencyGate {
  const gate = normalizeDependencyGate(input);
  const report = validateDependencyGate(gate);
  if (!report.ok) {
    throw new OperationsContractError("Dependency gate failed validation.", report.issues);
  }
  return gate;
}

export function normalizeDependencyGate(input: DependencyGateInput): DependencyGate {
  const base = {
    schema_version: DEPENDENCY_GATE_REGISTRY_SCHEMA_VERSION,
    gate_ref: input.gate_ref,
    gate_name: normalizeOperationsText(input.gate_name, 180),
    required_before: normalizeOperationsText(input.required_before, 320),
    owner_workstream_refs: freezeOperationsArray([...new Set(input.owner_workstream_refs)]),
    milestone_refs: freezeOperationsArray([...new Set(input.milestone_refs)]),
    required_evidence_refs: uniqueOperationsRefs(input.required_evidence_refs),
    review_checklist: uniqueOperationsStrings(input.review_checklist),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateDependencyGate(gate: DependencyGate): OperationsValidationReport {
  const issues: ValidationIssue[] = [];
  validateOperationsRef(gate.gate_ref, "$.gate_ref", issues);
  validateOperationsText(gate.gate_name, "$.gate_name", true, issues);
  validateOperationsText(gate.required_before, "$.required_before", true, issues);
  validateOperationsNonEmptyArray(gate.owner_workstream_refs, "$.owner_workstream_refs", "GateOwnersMissing", issues);
  validateOperationsNonEmptyArray(gate.milestone_refs, "$.milestone_refs", "GateMilestonesMissing", issues);
  validateOperationsNonEmptyArray(gate.required_evidence_refs, "$.required_evidence_refs", "GateEvidenceMissing", issues);
  validateOperationsNonEmptyArray(gate.review_checklist, "$.review_checklist", "GateChecklistMissing", issues);
  validateOperationsRefs(gate.required_evidence_refs, "$.required_evidence_refs", issues);
  gate.review_checklist.forEach((item, index) => validateOperationsText(item, `$.review_checklist[${index}]`, true, issues));
  return buildOperationsValidationReport(makeOperationsRef("dependency_gate_report", gate.gate_ref), issues, operationsRouteForIssues(issues));
}

export function evaluateGateReadiness(input: GateReadinessInput): GateReadinessDecision {
  const available = new Set(input.available_evidence_refs);
  const missing = input.gate.required_evidence_refs.filter((ref) => !available.has(ref));
  const status: GateStatus = missing.length > 0
    ? "red"
    : input.unresolved_issue_refs.length > 0
      ? "amber"
      : "green";
  const base = {
    gate_ref: input.gate.gate_ref,
    status,
    missing_evidence_refs: uniqueOperationsRefs(missing),
    unresolved_issue_refs: uniqueOperationsRefs(input.unresolved_issue_refs),
    reason: reasonForGateStatus(status, missing.length, input.unresolved_issue_refs.length),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function defaultDependencyGateRegistry(): readonly DependencyGate[] {
  return freezeOperationsArray([
    gate("G1", "Provenance Firewall Gate", "Any Gemini prompt uses simulated evidence.", ["WS-A", "WS-O"], ["M1", "M3"], ["artifact_envelope_governance", "provenance_classes", "simulation_blindness_checklist"]),
    gate("G2", "Sensor Packet Gate", "Perception and audio processing.", ["WS-C"], ["M1"], ["camera_packet_contract", "microphone_packet_contract", "sensor_provenance_policy"]),
    gate("G3", "Safety Validation Gate", "Any physical execution.", ["WS-O"], ["M2"], ["safety_policy_registry", "execution_safety_envelope", "safehold_policy"]),
    gate("G4", "Control Telemetry Gate", "Verification and Oops correction.", ["WS-H"], ["M2", "M4"], ["control_telemetry_contract", "runtime_anomaly_contract"]),
    gate("G5", "Verification Certificate Gate", "Memory verified writes and task completion.", ["WS-J"], ["M4", "M5"], ["verification_certificate_schema", "false_positive_guard", "replay_evidence_refs"]),
    gate("G6", "Memory Labeling Gate", "Memory retrieval enters Gemini prompts.", ["WS-L"], ["M5"], ["memory_label_policy", "staleness_policy", "contradiction_policy"]),
    gate("G7", "Oops Retry Gate", "Corrective execution.", ["WS-K", "WS-O"], ["M6"], ["oops_retry_budget_policy", "correction_safety_validator", "post_correction_verification"]),
    gate("G8", "TTS Redaction Gate", "Spoken monologue in runtime demos.", ["WS-N", "WS-O"], ["M7"], ["monologue_safety_filter", "tts_redaction_policy", "self_noise_suppression"]),
    gate("G9", "Tool Safety Gate", "Tool-use primitives.", ["WS-I", "WS-O"], ["M8"], ["tool_safety_envelope", "tool_effect_verification", "tool_collision_policy"]),
    gate("G10", "QA Truth Boundary Gate", "Benchmark comparison.", ["WS-P"], ["M9"], ["runtime_qa_boundary_guard", "benchmark_scorecard_contract", "release_readiness_report"]),
  ]);
}

function gate(
  gateRef: DependencyGateRef,
  gateName: string,
  requiredBefore: string,
  ownerWorkstreamRefs: readonly WorkstreamRef[],
  milestoneRefs: readonly MilestoneRef[],
  requiredEvidenceRefs: readonly Ref[],
): DependencyGate {
  return buildDependencyGate({
    gate_ref: gateRef,
    gate_name: gateName,
    required_before: requiredBefore,
    owner_workstream_refs: ownerWorkstreamRefs,
    milestone_refs: milestoneRefs,
    required_evidence_refs: requiredEvidenceRefs,
    review_checklist: [
      "Required architecture document section exists.",
      "Service of record is identified.",
      "Safety policy and failure route are defined where relevant.",
      "QA test case and observability evidence are defined.",
      "Traceability entry is linked.",
    ],
  });
}

function reasonForGateStatus(status: GateStatus, missingCount: number, unresolvedCount: number): string {
  if (status === "green") {
    return "All required gate evidence is present and no unresolved issues remain.";
  }
  if (status === "amber") {
    return `${unresolvedCount} unresolved issue refs require review before release confidence.`;
  }
  if (status === "red") {
    return `${missingCount} required evidence refs are missing.`;
  }
  return "Gate has not been evaluated.";
}

export const DEPENDENCY_GATE_REGISTRY_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: DEPENDENCY_GATE_REGISTRY_SCHEMA_VERSION,
  blueprint: OPERATIONS_BLUEPRINT_REF,
  sections: freezeOperationsArray(["21.7", "21.8", "21.11", "21.14", "21.15"]),
  component: "DependencyGateRegistry",
});
