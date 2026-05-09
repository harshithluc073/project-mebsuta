/**
 * Risk QA traceability matrix.
 *
 * Blueprint: `architecture_docs/22_RISK_REGISTER_AND_MITIGATION_ARCHITECTURE.md`
 * sections 22.10, 22.11, and 22.12.
 *
 * The matrix proves that risk families have QA controls, evidence classes, and
 * release gate links instead of remaining narrative-only governance items.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  RISK_BLUEPRINT_REF,
  RiskContractError,
  buildRiskValidationReport,
  freezeRiskArray,
  makeRiskRef,
  normalizeRiskText,
  riskIssue,
  riskRouteForIssues,
  uniqueRiskRefs,
  uniqueRiskStrings,
  validateRiskNonEmptyArray,
  validateRiskRef,
  validateRiskRefs,
  validateRiskText,
} from "./risk_register_entry";
import type { RiskCategory, RiskValidationReport } from "./risk_register_entry";

export const RISK_QA_TRACEABILITY_MATRIX_SCHEMA_VERSION = "mebsuta.risk.risk_qa_traceability_matrix.v1" as const;

export type QaControlKind = "contract_test" | "integration_test" | "scenario_benchmark" | "chaos_test" | "dashboard_alert" | "release_gate" | "traceability_scan";

export interface RiskQaTraceabilityRowInput {
  readonly trace_ref: Ref;
  readonly risk_family: string;
  readonly risk_category: RiskCategory;
  readonly risk_refs: readonly Ref[];
  readonly qa_control_kind: QaControlKind;
  readonly qa_control_refs: readonly Ref[];
  readonly evidence_artifact_refs: readonly Ref[];
  readonly release_gate_refs: readonly Ref[];
  readonly coverage_statement: string;
}

export interface RiskQaTraceabilityRow {
  readonly schema_version: typeof RISK_QA_TRACEABILITY_MATRIX_SCHEMA_VERSION;
  readonly trace_ref: Ref;
  readonly risk_family: string;
  readonly risk_category: RiskCategory;
  readonly risk_refs: readonly Ref[];
  readonly qa_control_kind: QaControlKind;
  readonly qa_control_refs: readonly Ref[];
  readonly evidence_artifact_refs: readonly Ref[];
  readonly release_gate_refs: readonly Ref[];
  readonly coverage_statement: string;
  readonly determinism_hash: string;
}

export interface RiskQaTraceabilityMatrix {
  readonly matrix_ref: Ref;
  readonly rows: readonly RiskQaTraceabilityRow[];
  readonly total_risk_refs: number;
  readonly total_release_gate_refs: number;
  readonly uncovered_risk_refs: readonly Ref[];
  readonly release_ready_coverage: boolean;
  readonly determinism_hash: string;
}

/**
 * Builds a traceability row connecting risk families to QA controls.
 */
export function buildRiskQaTraceabilityRow(input: RiskQaTraceabilityRowInput): RiskQaTraceabilityRow {
  const row = normalizeRiskQaTraceabilityRow(input);
  const report = validateRiskQaTraceabilityRow(row);
  if (!report.ok) {
    throw new RiskContractError("Risk QA traceability row failed validation.", report.issues);
  }
  return row;
}

export function normalizeRiskQaTraceabilityRow(input: RiskQaTraceabilityRowInput): RiskQaTraceabilityRow {
  const base = {
    schema_version: RISK_QA_TRACEABILITY_MATRIX_SCHEMA_VERSION,
    trace_ref: input.trace_ref,
    risk_family: normalizeRiskText(input.risk_family, 180),
    risk_category: input.risk_category,
    risk_refs: uniqueRiskRefs(input.risk_refs),
    qa_control_kind: input.qa_control_kind,
    qa_control_refs: uniqueRiskRefs(input.qa_control_refs),
    evidence_artifact_refs: uniqueRiskRefs(input.evidence_artifact_refs),
    release_gate_refs: uniqueRiskRefs(input.release_gate_refs),
    coverage_statement: normalizeRiskText(input.coverage_statement, 700),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateRiskQaTraceabilityRow(row: RiskQaTraceabilityRow): RiskValidationReport {
  const issues: ValidationIssue[] = [];
  validateRiskRef(row.trace_ref, "$.trace_ref", issues);
  validateRiskText(row.risk_family, "$.risk_family", true, issues);
  validateRiskNonEmptyArray(row.risk_refs, "$.risk_refs", "TraceRiskRefsMissing", issues);
  validateRiskNonEmptyArray(row.qa_control_refs, "$.qa_control_refs", "TraceQaControlsMissing", issues);
  validateRiskNonEmptyArray(row.evidence_artifact_refs, "$.evidence_artifact_refs", "TraceEvidenceMissing", issues);
  validateRiskNonEmptyArray(row.release_gate_refs, "$.release_gate_refs", "TraceReleaseGatesMissing", issues);
  validateRiskRefs(row.risk_refs, "$.risk_refs", issues);
  validateRiskRefs(row.qa_control_refs, "$.qa_control_refs", issues);
  validateRiskRefs(row.evidence_artifact_refs, "$.evidence_artifact_refs", issues);
  validateRiskRefs(row.release_gate_refs, "$.release_gate_refs", issues);
  validateRiskText(row.coverage_statement, "$.coverage_statement", true, issues);
  return buildRiskValidationReport(makeRiskRef("risk_qa_traceability_row_report", row.trace_ref), issues, riskRouteForIssues(issues));
}

export function buildRiskQaTraceabilityMatrix(matrixRef: Ref, rows: readonly RiskQaTraceabilityRow[], expectedRiskRefs: readonly Ref[] = []): RiskQaTraceabilityMatrix {
  const covered = new Set(rows.flatMap((row) => row.risk_refs));
  const uncovered = uniqueRiskRefs(expectedRiskRefs.filter((riskRef) => !covered.has(riskRef)));
  const releaseGates = uniqueRiskRefs(rows.flatMap((row) => row.release_gate_refs));
  const base = {
    matrix_ref: matrixRef,
    rows: freezeRiskArray(rows),
    total_risk_refs: covered.size,
    total_release_gate_refs: releaseGates.length,
    uncovered_risk_refs: uncovered,
    release_ready_coverage: uncovered.length === 0 && rows.every((row) => row.release_gate_refs.length > 0),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function defaultRiskQaTraceabilityRows(): readonly RiskQaTraceabilityRow[] {
  return freezeRiskArray([
    row("trace_hidden_truth", "Hidden truth", "R-FWL", ["R-001", "R-002"], "contract_test", ["provenance_contract_tests", "prompt_firewall_tests"], ["provenance_report", "prompt_audit_log"], ["G1", "G10"], "Restricted provenance must fail contract tests before release evidence is accepted."),
    row("trace_false_success", "False success", "R-VER", ["R-003", "R-016", "R-024", "R-027"], "scenario_benchmark", ["false_positive_scenarios", "certificate_replay_tests"], ["verification_certificate", "replay_bundle"], ["G5", "G10"], "Success claims require certificate replay and benchmark contradiction checks."),
    row("trace_safety", "Safety execution", "R-SAF", ["R-004", "R-011", "R-025", "R-032"], "release_gate", ["safety_release_gates", "runtime_monitor_chaos_tests"], ["safety_report", "safehold_event"], ["G3", "G9"], "Unsafe proposals and execution events must fail the safety gate."),
    row("trace_model_drift", "Model drift", "R-CGN", ["R-009", "R-010", "R-012", "R-014"], "contract_test", ["golden_prompt_regression_suite"], ["schema_validation_report"], ["G1"], "Prompt and response drift are tracked by schema and golden regression evidence."),
    row("trace_control", "Control instability", "R-CTL", ["R-021", "R-022"], "integration_test", ["ik_pd_unit_tests", "physics_disturbance_tests"], ["control_telemetry_report"], ["G4"], "IK and PD risks require deterministic telemetry and disturbance evidence."),
    row("trace_memory", "Memory contamination", "R-MEM", ["R-005", "R-033", "R-034"], "contract_test", ["memory_write_gate_tests", "hidden_truth_memory_tests"], ["memory_audit_report"], ["G6", "G10"], "Verified memory writes require certificate and provenance audit evidence."),
    row("trace_audio", "Audio misuse", "R-AUD", ["R-007", "R-035", "R-036", "R-037", "R-038"], "chaos_test", ["audio_only_success_tests", "tts_self_noise_tests"], ["audio_event_report"], ["G8"], "Audio is validated as an attention cue and cannot independently prove success or correction."),
    row("trace_observability", "Observability leak", "R-OBS", ["R-039", "R-040"], "dashboard_alert", ["tts_redaction_tests", "replay_completeness_tests"], ["redaction_audit", "replay_trace"], ["G8", "G10"], "Observability artifacts must preserve redaction and replay reconstruction evidence."),
    row("trace_operations", "Interface and schedule governance", "R-OPS", ["R-042", "R-043", "R-044", "R-046"], "traceability_scan", ["interface_drift_tests", "release_readiness_reviews"], ["dependency_gate_report", "traceability_scan"], ["G10"], "Program and interface risks are gated through dependency evidence and release readiness."),
  ]);
}

export function defaultRiskQaTraceabilityMatrix(expectedRiskRefs: readonly Ref[] = []): RiskQaTraceabilityMatrix {
  return buildRiskQaTraceabilityMatrix("risk_qa_traceability_matrix", defaultRiskQaTraceabilityRows(), expectedRiskRefs);
}

function row(traceRef: Ref, family: string, category: RiskCategory, riskRefs: readonly Ref[], controlKind: QaControlKind, controlRefs: readonly Ref[], evidenceRefs: readonly Ref[], gateRefs: readonly Ref[], statement: string): RiskQaTraceabilityRow {
  return buildRiskQaTraceabilityRow({
    trace_ref: traceRef,
    risk_family: family,
    risk_category: category,
    risk_refs: riskRefs,
    qa_control_kind: controlKind,
    qa_control_refs: controlRefs,
    evidence_artifact_refs: evidenceRefs,
    release_gate_refs: gateRefs,
    coverage_statement: statement,
  });
}

export const RISK_QA_TRACEABILITY_MATRIX_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: RISK_QA_TRACEABILITY_MATRIX_SCHEMA_VERSION,
  blueprint: RISK_BLUEPRINT_REF,
  sections: freezeRiskArray(["22.10", "22.11", "22.12"]),
  component: "RiskQaTraceabilityMatrix",
});
