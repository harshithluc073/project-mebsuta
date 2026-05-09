/**
 * Mitigation control registry.
 *
 * Blueprint: `architecture_docs/22_RISK_REGISTER_AND_MITIGATION_ARCHITECTURE.md`
 * sections 22.7.1, 22.7.2, 22.7.3, and 22.10.
 *
 * Controls are typed as preventive, detective, or corrective so release gates
 * can prove that each critical risk has a balanced mitigation stack.
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
import type { RiskValidationReport } from "./risk_register_entry";

export const MITIGATION_CONTROL_REGISTRY_SCHEMA_VERSION = "mebsuta.risk.mitigation_control_registry.v1" as const;

export type MitigationControlKind = "preventive" | "detective" | "corrective";
export type MitigationControlStatus = "planned" | "implemented" | "monitored" | "needs_repair" | "retired";

export interface MitigationControlInput {
  readonly control_ref: Ref;
  readonly control_name: string;
  readonly control_kind: MitigationControlKind;
  readonly mitigated_risk_refs: readonly Ref[];
  readonly control_mechanism: string;
  readonly evidence_refs: readonly Ref[];
  readonly owner_category: string;
  readonly status?: MitigationControlStatus;
}

export interface MitigationControl {
  readonly schema_version: typeof MITIGATION_CONTROL_REGISTRY_SCHEMA_VERSION;
  readonly control_ref: Ref;
  readonly control_name: string;
  readonly control_kind: MitigationControlKind;
  readonly mitigated_risk_refs: readonly Ref[];
  readonly control_mechanism: string;
  readonly evidence_refs: readonly Ref[];
  readonly owner_category: string;
  readonly status: MitigationControlStatus;
  readonly determinism_hash: string;
}

export interface MitigationCoverageReport {
  readonly report_ref: Ref;
  readonly risk_ref: Ref;
  readonly preventive_count: number;
  readonly detective_count: number;
  readonly corrective_count: number;
  readonly implemented_count: number;
  readonly balanced_coverage: boolean;
  readonly missing_control_kinds: readonly MitigationControlKind[];
  readonly determinism_hash: string;
}

/**
 * Builds an immutable mitigation control.
 */
export function buildMitigationControl(input: MitigationControlInput): MitigationControl {
  const controlItem = normalizeMitigationControl(input);
  const report = validateMitigationControl(controlItem);
  if (!report.ok) {
    throw new RiskContractError("Mitigation control failed validation.", report.issues);
  }
  return controlItem;
}

export function normalizeMitigationControl(input: MitigationControlInput): MitigationControl {
  const base = {
    schema_version: MITIGATION_CONTROL_REGISTRY_SCHEMA_VERSION,
    control_ref: input.control_ref,
    control_name: normalizeRiskText(input.control_name, 180),
    control_kind: input.control_kind,
    mitigated_risk_refs: uniqueRiskRefs(input.mitigated_risk_refs),
    control_mechanism: normalizeRiskText(input.control_mechanism, 900),
    evidence_refs: uniqueRiskRefs(input.evidence_refs),
    owner_category: normalizeRiskText(input.owner_category, 120),
    status: input.status ?? "planned",
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateMitigationControl(controlItem: MitigationControl): RiskValidationReport {
  const issues: ValidationIssue[] = [];
  validateRiskRef(controlItem.control_ref, "$.control_ref", issues);
  validateRiskText(controlItem.control_name, "$.control_name", true, issues);
  validateRiskNonEmptyArray(controlItem.mitigated_risk_refs, "$.mitigated_risk_refs", "ControlRiskRefsMissing", issues);
  validateRiskRefs(controlItem.mitigated_risk_refs, "$.mitigated_risk_refs", issues);
  validateRiskText(controlItem.control_mechanism, "$.control_mechanism", true, issues);
  validateRiskText(controlItem.owner_category, "$.owner_category", true, issues);
  if (controlItem.status === "implemented" || controlItem.status === "monitored") {
    validateRiskNonEmptyArray(controlItem.evidence_refs, "$.evidence_refs", "ImplementedControlEvidenceMissing", issues);
    validateRiskRefs(controlItem.evidence_refs, "$.evidence_refs", issues);
  }
  return buildRiskValidationReport(makeRiskRef("mitigation_control_report", controlItem.control_ref), issues, riskRouteForIssues(issues));
}

export function defaultMitigationControls(): readonly MitigationControl[] {
  return freezeRiskArray([
    control("provenance_firewall", "Provenance firewall", "preventive", ["R-001", "R-002", "R-005", "R-039"], "Rejects restricted source classes before prompts, memory, or monologue artifacts are emitted.", ["prompt_firewall_contract_tests"], "safety", "implemented"),
    control("prompt_contracts", "Prompt contracts", "preventive", ["R-009", "R-010", "R-011", "R-012"], "Constrains model input and output shape with schema validation and golden examples.", ["golden_prompt_suite"], "ai_integration", "implemented"),
    control("safety_validators", "Safety validators", "preventive", ["R-004", "R-007", "R-008", "R-011", "R-025", "R-032"], "Requires accepted safety reports before execution and correction routes.", ["safety_release_gates"], "safety", "implemented"),
    control("verification_certificates", "Verification certificates", "detective", ["R-003", "R-024", "R-027", "R-033"], "Requires multi-view evidence and residual summaries before task success or memory write.", ["verification_certificate_gate"], "verification", "implemented"),
    control("false_positive_guard", "False-positive guard", "detective", ["R-016", "R-027", "R-046"], "Blocks success when occlusion, view insufficiency, or residual uncertainty is high.", ["false_positive_scenarios"], "verification", "implemented"),
    control("memory_write_gate", "Memory write gate", "preventive", ["R-005", "R-033", "R-034"], "Requires valid certificates, staleness labels, and provenance before verified memory writes.", ["memory_write_gate_tests"], "memory", "implemented"),
    control("retry_budgets", "Retry budgets", "preventive", ["R-029", "R-043"], "Caps autonomous correction attempts and routes exhaustion to review.", ["oops_retry_budget_tests"], "recovery", "implemented"),
    control("tool_safety_envelope", "Tool safety envelope", "preventive", ["R-008", "R-025"], "Requires swept-volume and contact-point checks before tool primitives execute.", ["tool_use_safety_scenarios"], "manipulation", "implemented"),
    control("audio_route_policy", "Audio route policy", "preventive", ["R-035", "R-036", "R-038"], "Uses audio as an attention cue and blocks audio-only success or correction.", ["audio_only_success_tests"], "acoustic", "implemented"),
    control("incident_review", "Incident review", "corrective", ["R-001", "R-027", "R-032", "R-043", "R-046"], "Captures root cause, regression evidence, and release gate status after critical events.", ["incident_review_records"], "program_management", "planned"),
  ]);
}

export function analyzeMitigationCoverage(riskRef: Ref, controls: readonly MitigationControl[]): MitigationCoverageReport {
  const relevant = controls.filter((controlItem) => controlItem.mitigated_risk_refs.includes(riskRef) && controlItem.status !== "retired");
  const preventiveCount = relevant.filter((controlItem) => controlItem.control_kind === "preventive").length;
  const detectiveCount = relevant.filter((controlItem) => controlItem.control_kind === "detective").length;
  const correctiveCount = relevant.filter((controlItem) => controlItem.control_kind === "corrective").length;
  const missing = freezeRiskArray((["preventive", "detective", "corrective"] as const).filter((kind) => relevant.some((controlItem) => controlItem.control_kind === kind) === false));
  const base = {
    report_ref: makeRiskRef("mitigation_coverage", riskRef),
    risk_ref: riskRef,
    preventive_count: preventiveCount,
    detective_count: detectiveCount,
    corrective_count: correctiveCount,
    implemented_count: relevant.filter((controlItem) => controlItem.status === "implemented" || controlItem.status === "monitored").length,
    balanced_coverage: missing.length === 0,
    missing_control_kinds: missing,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function risksWithInsufficientCoverage(riskRefs: readonly Ref[], controls: readonly MitigationControl[]): readonly Ref[] {
  return uniqueRiskStrings(riskRefs.filter((riskRef) => analyzeMitigationCoverage(riskRef, controls).balanced_coverage === false));
}

function control(controlRef: Ref, controlName: string, controlKind: MitigationControlKind, mitigatedRiskRefs: readonly Ref[], mechanism: string, evidenceRefs: readonly Ref[], owner: string, status: MitigationControlStatus): MitigationControl {
  return buildMitigationControl({
    control_ref: controlRef,
    control_name: controlName,
    control_kind: controlKind,
    mitigated_risk_refs: mitigatedRiskRefs,
    control_mechanism: mechanism,
    evidence_refs: evidenceRefs,
    owner_category: owner,
    status,
  });
}

export const MITIGATION_CONTROL_REGISTRY_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: MITIGATION_CONTROL_REGISTRY_SCHEMA_VERSION,
  blueprint: RISK_BLUEPRINT_REF,
  sections: freezeRiskArray(["22.7.1", "22.7.2", "22.7.3", "22.10"]),
  component: "MitigationControlRegistry",
});
