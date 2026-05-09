/**
 * QA test case specification contract.
 *
 * Blueprint: `architecture_docs/20_QA_TESTING_CHAOS_AND_BENCHMARK_ARCHITECTURE.md`
 * sections 20.2, 20.4.2, 20.5.1, 20.6, 20.7, 20.21, and 20.22.
 *
 * The contract defines executable metadata for a QA case while preserving the
 * runtime/QA truth boundary: offline truth may be referenced for scoring, but
 * it may never be routed into runtime cognition or runtime decision artifacts.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import {
  compactApiText,
  containsForbiddenApiText,
  freezeApiArray,
  makeApiRef,
  uniqueApiRefs,
  uniqueApiStrings,
} from "../api/artifact_envelope";

export const QA_BLUEPRINT_REF = "architecture_docs/20_QA_TESTING_CHAOS_AND_BENCHMARK_ARCHITECTURE.md" as const;
export const TEST_CASE_SPEC_SCHEMA_VERSION = "mebsuta.qa.test_case_spec.v1" as const;

export type QaLayer =
  | "static_architecture"
  | "schema_contract"
  | "unit"
  | "component"
  | "integration"
  | "scenario"
  | "chaos"
  | "benchmark"
  | "regression";

export type QaTruthUsage = "none" | "offline_only" | "forbidden";
export type QaOutcome = "ok" | "fail" | "skip" | "warn" | "blocked" | "needs_review";
export type QaRoute = "continue" | "repair" | "reobserve" | "oops" | "safe_hold" | "human_review" | "qa_failure" | "release_block";
export type QaEvidenceClass = "runtime_artifact" | "observability_timeline" | "replay_bundle" | "policy_ref" | "offline_truth" | "golden_baseline";

export interface QaValidationReport {
  readonly report_ref: Ref;
  readonly ok: boolean;
  readonly issue_count: number;
  readonly error_count: number;
  readonly warning_count: number;
  readonly recommended_route: QaRoute;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface AcceptanceCriterion {
  readonly criterion_ref: Ref;
  readonly description: string;
  readonly severity: ValidationSeverity;
  readonly required_evidence_classes: readonly QaEvidenceClass[];
}

export interface TestCaseSpecInput {
  readonly test_case_ref: Ref;
  readonly test_name: string;
  readonly test_layer: QaLayer;
  readonly subsystem_scope: readonly Ref[];
  readonly requirement_refs: readonly Ref[];
  readonly preconditions: readonly string[];
  readonly stimulus: string;
  readonly expected_runtime_behavior: readonly string[];
  readonly forbidden_runtime_behavior?: readonly string[];
  readonly qa_truth_usage: QaTruthUsage;
  readonly acceptance_criteria: readonly AcceptanceCriterion[];
  readonly audit_artifacts_required: readonly QaEvidenceClass[];
  readonly release_gate_refs?: readonly Ref[];
  readonly deterministic_seed_ref?: Ref;
}

export interface TestCaseSpec {
  readonly schema_version: typeof TEST_CASE_SPEC_SCHEMA_VERSION;
  readonly test_case_ref: Ref;
  readonly test_name: string;
  readonly test_layer: QaLayer;
  readonly subsystem_scope: readonly Ref[];
  readonly requirement_refs: readonly Ref[];
  readonly preconditions: readonly string[];
  readonly stimulus: string;
  readonly expected_runtime_behavior: readonly string[];
  readonly forbidden_runtime_behavior: readonly string[];
  readonly qa_truth_usage: QaTruthUsage;
  readonly acceptance_criteria: readonly AcceptanceCriterion[];
  readonly audit_artifacts_required: readonly QaEvidenceClass[];
  readonly release_gate_refs: readonly Ref[];
  readonly deterministic_seed_ref?: Ref;
  readonly determinism_hash: string;
}

/**
 * Builds an immutable QA test case and rejects cases that could leak offline
 * truth into runtime behavior.
 */
export function buildTestCaseSpec(input: TestCaseSpecInput): TestCaseSpec {
  const spec = normalizeTestCaseSpec(input);
  const report = validateTestCaseSpec(spec);
  if (!report.ok) {
    throw new QaContractError("QA test case spec failed validation.", report.issues);
  }
  return spec;
}

export function normalizeTestCaseSpec(input: TestCaseSpecInput): TestCaseSpec {
  const base = {
    schema_version: TEST_CASE_SPEC_SCHEMA_VERSION,
    test_case_ref: input.test_case_ref,
    test_name: normalizeQaText(input.test_name, 160),
    test_layer: input.test_layer,
    subsystem_scope: uniqueQaRefs(input.subsystem_scope),
    requirement_refs: uniqueQaRefs(input.requirement_refs),
    preconditions: uniqueQaStrings(input.preconditions),
    stimulus: normalizeQaText(input.stimulus),
    expected_runtime_behavior: uniqueQaStrings(input.expected_runtime_behavior),
    forbidden_runtime_behavior: uniqueQaStrings(input.forbidden_runtime_behavior ?? []),
    qa_truth_usage: input.qa_truth_usage,
    acceptance_criteria: freezeQaArray(input.acceptance_criteria.map(normalizeAcceptanceCriterion)),
    audit_artifacts_required: freezeQaArray([...new Set(input.audit_artifacts_required)]),
    release_gate_refs: uniqueQaRefs(input.release_gate_refs ?? []),
    deterministic_seed_ref: input.deterministic_seed_ref,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateTestCaseSpec(spec: TestCaseSpec): QaValidationReport {
  const issues: ValidationIssue[] = [];
  validateQaRef(spec.test_case_ref, "$.test_case_ref", issues);
  validateQaText(spec.test_name, "$.test_name", true, issues);
  validateNonEmptyQaArray(spec.subsystem_scope, "$.subsystem_scope", "SubsystemScopeMissing", issues);
  validateQaRefs(spec.subsystem_scope, "$.subsystem_scope", issues);
  validateNonEmptyQaArray(spec.requirement_refs, "$.requirement_refs", "RequirementRefsMissing", issues);
  validateQaRefs(spec.requirement_refs, "$.requirement_refs", issues);
  validateNonEmptyQaArray(spec.preconditions, "$.preconditions", "PreconditionsMissing", issues);
  validateNonEmptyQaArray(spec.expected_runtime_behavior, "$.expected_runtime_behavior", "ExpectedRuntimeBehaviorMissing", issues);
  validateNonEmptyQaArray(spec.acceptance_criteria, "$.acceptance_criteria", "AcceptanceCriteriaMissing", issues);
  validateNonEmptyQaArray(spec.audit_artifacts_required, "$.audit_artifacts_required", "AuditArtifactsMissing", issues);
  validateQaText(spec.stimulus, "$.stimulus", true, issues);
  validateOptionalQaRef(spec.deterministic_seed_ref, "$.deterministic_seed_ref", issues);
  for (const [index, criterion] of spec.acceptance_criteria.entries()) {
    validateAcceptanceCriterion(criterion, `$.acceptance_criteria[${index}]`, issues);
  }
  if (spec.qa_truth_usage === "offline_only" && spec.audit_artifacts_required.includes("offline_truth") === false) {
    issues.push(qaIssue("error", "OfflineTruthAuditMissing", "$.audit_artifacts_required", "Offline truth scoring requires an offline-truth audit artifact.", "Attach offline_truth to the required audit artifact classes."));
  }
  if (spec.qa_truth_usage === "forbidden" && spec.audit_artifacts_required.includes("offline_truth")) {
    issues.push(qaIssue("error", "ForbiddenTruthAuditConflict", "$.qa_truth_usage", "A truth-forbidden case cannot require offline-truth artifacts.", "Remove offline_truth or change the truth-usage policy."));
  }
  return buildQaValidationReport(makeQaRef("test_case_spec_report", spec.test_case_ref), issues, qaRouteForIssues(issues));
}

function normalizeAcceptanceCriterion(criterion: AcceptanceCriterion): AcceptanceCriterion {
  return Object.freeze({
    criterion_ref: criterion.criterion_ref,
    description: normalizeQaText(criterion.description),
    severity: criterion.severity,
    required_evidence_classes: freezeQaArray([...new Set(criterion.required_evidence_classes)]),
  });
}

function validateAcceptanceCriterion(criterion: AcceptanceCriterion, path: string, issues: ValidationIssue[]): void {
  validateQaRef(criterion.criterion_ref, `${path}.criterion_ref`, issues);
  validateQaText(criterion.description, `${path}.description`, true, issues);
  validateNonEmptyQaArray(criterion.required_evidence_classes, `${path}.required_evidence_classes`, "CriterionEvidenceMissing", issues);
}

export class QaContractError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "QaContractError";
    this.issues = freezeQaArray(issues);
  }
}

export function buildQaValidationReport(reportRef: Ref, issues: readonly ValidationIssue[], recommendedRoute: QaRoute): QaValidationReport {
  const frozenIssues = freezeQaArray(issues);
  const errorCount = frozenIssues.filter((issue) => issue.severity === "error").length;
  const warningCount = frozenIssues.length - errorCount;
  const base = {
    report_ref: reportRef,
    ok: errorCount === 0,
    issue_count: frozenIssues.length,
    error_count: errorCount,
    warning_count: warningCount,
    recommended_route: recommendedRoute,
    issues: frozenIssues,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function qaRouteForIssues(issues: readonly ValidationIssue[]): QaRoute {
  if (issues.some((issue) => issue.severity === "error" && /Truth|Unsafe|Release|Critical|Forbidden/.test(issue.code))) {
    return "release_block";
  }
  if (issues.some((issue) => issue.severity === "error")) {
    return "repair";
  }
  if (issues.some((issue) => issue.severity === "warning")) {
    return "continue";
  }
  return "continue";
}

export function qaIssue(severity: ValidationSeverity, code: string, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

export function validateQaRef(ref: Ref | undefined, path: string, issues: ValidationIssue[]): void {
  if (ref === undefined || ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(qaIssue("error", "QaRefInvalid", path, "Reference must be present, non-empty, and whitespace-free.", "Use a stable opaque ref."));
    return;
  }
  if (containsForbiddenQaText(ref)) {
    issues.push(qaIssue("error", "QaRefForbidden", path, "Reference contains boundary-restricted wording.", "Use an opaque ref that does not disclose internal truth."));
  }
}

export function validateOptionalQaRef(ref: Ref | undefined, path: string, issues: ValidationIssue[]): void {
  if (ref !== undefined) {
    validateQaRef(ref, path, issues);
  }
}

export function validateQaRefs(refs: readonly Ref[], path: string, issues: ValidationIssue[]): void {
  for (const [index, ref] of refs.entries()) {
    validateQaRef(ref, `${path}[${index}]`, issues);
  }
}

export function validateQaText(value: string, path: string, required: boolean, issues: ValidationIssue[]): void {
  if (required && value.trim().length === 0) {
    issues.push(qaIssue("error", "QaTextRequired", path, "Required QA text is empty.", "Provide concise QA contract text."));
  }
  if (containsForbiddenQaText(value)) {
    issues.push(qaIssue("error", "QaTextForbidden", path, "Text contains data forbidden by the runtime/QA boundary.", "Use embodied-evidence, policy, replay, or offline-report wording."));
  }
}

export function validateFiniteQaNumber(value: number, path: string, min: number, max: number | undefined, issues: ValidationIssue[]): void {
  if (!Number.isFinite(value) || value < min || (max !== undefined && value > max)) {
    issues.push(qaIssue("error", "QaNumberInvalid", path, "Numeric QA value is outside the allowed finite range.", "Recompute the value using deterministic QA arithmetic."));
  }
}

export function validateRatio(value: number, path: string, issues: ValidationIssue[]): void {
  validateFiniteQaNumber(value, path, 0, 1, issues);
}

export function validateNonEmptyQaArray<T>(items: readonly T[], path: string, code: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(items) || items.length === 0) {
    issues.push(qaIssue("error", code, path, "Array must contain at least one item.", "Attach the required QA contract entries."));
  }
}

export function containsForbiddenQaText(value: string): boolean {
  return containsForbiddenApiText(value) || /(qa[_ -]?truth[_ -]?to[_ -]?runtime|reward[_ -]?update|policy[_ -]?gradient|oracle[_ -]?answer|hidden[_ -]?label|exact[_ -]?simulator[_ -]?state)/i.test(value);
}

export function normalizeQaText(value: string, maxChars = 1200): string {
  return compactApiText(value, maxChars);
}

export function makeQaRef(...parts: readonly (string | number | undefined)[]): Ref {
  return makeApiRef("qa", ...parts);
}

export function uniqueQaRefs(items: readonly (Ref | undefined)[]): readonly Ref[] {
  return uniqueApiRefs(items);
}

export function uniqueQaStrings(items: readonly string[]): readonly string[] {
  return uniqueApiStrings(items);
}

export function freezeQaArray<T>(items: readonly T[]): readonly T[] {
  return freezeApiArray(items);
}

export const TEST_CASE_SPEC_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: TEST_CASE_SPEC_SCHEMA_VERSION,
  blueprint: QA_BLUEPRINT_REF,
  sections: freezeQaArray(["20.2", "20.4.2", "20.5.1", "20.6", "20.7", "20.21", "20.22"]),
  component: "TestCaseSpec",
});
