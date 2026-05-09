/**
 * Runtime contract test harness.
 *
 * Blueprint: `architecture_docs/20_QA_TESTING_CHAOS_AND_BENCHMARK_ARCHITECTURE.md`
 * sections 20.3, 20.6, 20.11, 20.17, 20.20, and 20.22.
 *
 * The harness executes deterministic contract validation across File 19 API
 * artifacts and QA assertions while respecting the runtime/QA truth boundary.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import { validateArtifactEnvelope } from "../api/artifact_envelope";
import type { ArtifactEnvelope, ApiContractValidationReport } from "../api/artifact_envelope";
import { validateProvenanceManifest } from "../api/provenance_manifest_contract";
import type { ProvenanceManifest } from "../api/provenance_manifest_contract";
import { validateRuntimeQaBoundaryDecision } from "../api/runtime_qa_boundary_guard";
import type { RuntimeQaBoundaryDecision } from "../api/runtime_qa_boundary_guard";
import {
  QA_BLUEPRINT_REF,
  QaContractError,
  buildQaValidationReport,
  freezeQaArray,
  makeQaRef,
  normalizeQaText,
  qaIssue,
  qaRouteForIssues,
  uniqueQaRefs,
  validateNonEmptyQaArray,
  validateQaRef,
  validateQaRefs,
  validateQaText,
  validateTestCaseSpec,
} from "./test_case_spec";
import type { QaOutcome, QaValidationReport, TestCaseSpec } from "./test_case_spec";
import { buildAssertionResult } from "./assertion_result_evaluator";
import type { AssertionResult } from "./assertion_result_evaluator";
import { buildTestRunRecord, deriveRunStatus, type TestRunRecord } from "./test_run_record";
import { buildReleaseReadinessReport, type ReleaseGateClass, type ReleaseGateEvidence, type ReleaseReadinessReport } from "./release_readiness_report";

export const RUNTIME_CONTRACT_TEST_HARNESS_SCHEMA_VERSION = "mebsuta.qa.runtime_contract_test_harness.v1" as const;
export const QA_CONTRACT_SURFACE_REPORT_SCHEMA_VERSION = "mebsuta.qa.contract_surface_report.v1" as const;

export type QaContractCoverageDomain =
  | "unit"
  | "contract"
  | "integration"
  | "runtime_qa_boundary"
  | "api"
  | "storage"
  | "auth"
  | "frontend"
  | "safety";

export type RuntimeContractArtifact =
  | { readonly kind: "artifact_envelope"; readonly value: ArtifactEnvelope }
  | { readonly kind: "provenance_manifest"; readonly value: ProvenanceManifest }
  | { readonly kind: "runtime_qa_boundary_decision"; readonly value: RuntimeQaBoundaryDecision };

export interface RuntimeContractHarnessInput {
  readonly harness_run_ref: Ref;
  readonly test_case_ref: Ref;
  readonly runtime_contract_artifacts: readonly RuntimeContractArtifact[];
  readonly required_artifact_refs: readonly Ref[];
  readonly forbidden_runtime_terms?: readonly string[];
}

export interface RuntimeContractHarnessResult {
  readonly schema_version: typeof RUNTIME_CONTRACT_TEST_HARNESS_SCHEMA_VERSION;
  readonly harness_run_ref: Ref;
  readonly test_case_ref: Ref;
  readonly assertion_results: readonly AssertionResult[];
  readonly contract_reports: readonly ApiContractValidationReport[];
  readonly missing_required_artifact_refs: readonly Ref[];
  readonly forbidden_term_hits: readonly string[];
  readonly overall_status: QaOutcome;
  readonly determinism_hash: string;
}

export interface QaContractSurfaceInput {
  readonly harness_run_ref: Ref;
  readonly test_case: TestCaseSpec;
  readonly runtime_contract_artifacts: readonly RuntimeContractArtifact[];
  readonly required_artifact_refs: readonly Ref[];
  readonly forbidden_runtime_terms?: readonly string[];
  readonly coverage_domains: readonly QaContractCoverageDomain[];
  readonly started_at_ms: number;
  readonly ended_at_ms: number;
  readonly replay_bundle_ref: Ref;
  readonly milestone_ref: Ref;
  readonly benchmark_scorecard_refs: readonly Ref[];
  readonly regression_report_refs?: readonly Ref[];
  readonly chaos_record_refs?: readonly Ref[];
  readonly operator_summary: string;
}

export interface QaContractSurfaceReport {
  readonly schema_version: typeof QA_CONTRACT_SURFACE_REPORT_SCHEMA_VERSION;
  readonly harness_run_ref: Ref;
  readonly test_case_ref: Ref;
  readonly coverage_domains: readonly QaContractCoverageDomain[];
  readonly test_case_validation_report: QaValidationReport;
  readonly harness_result: RuntimeContractHarnessResult;
  readonly test_run_record: TestRunRecord;
  readonly release_readiness_report: ReleaseReadinessReport;
  readonly runtime_qa_boundary_artifact_count: number;
  readonly boundary_protected: boolean;
  readonly overall_status: QaOutcome;
  readonly determinism_hash: string;
}

/**
 * Runs API contract validators and emits assertion records for the QA run.
 */
export function runRuntimeContractHarness(input: RuntimeContractHarnessInput): RuntimeContractHarnessResult {
  const reports = input.runtime_contract_artifacts.map(validateRuntimeArtifact);
  const observedRefs = collectArtifactRefs(input.runtime_contract_artifacts);
  const missing = input.required_artifact_refs.filter((ref) => !observedRefs.has(ref));
  const forbiddenHits = findForbiddenTermHits(input.runtime_contract_artifacts, input.forbidden_runtime_terms ?? []);
  const assertions = buildHarnessAssertions(input, reports, missing, forbiddenHits);
  const status = deriveHarnessStatus(assertions);
  const base = {
    schema_version: RUNTIME_CONTRACT_TEST_HARNESS_SCHEMA_VERSION,
    harness_run_ref: input.harness_run_ref,
    test_case_ref: input.test_case_ref,
    assertion_results: freezeQaArray(assertions),
    contract_reports: freezeQaArray(reports),
    missing_required_artifact_refs: uniqueQaRefs(missing),
    forbidden_term_hits: freezeQaArray(forbiddenHits),
    overall_status: status,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

/**
 * Executes a PIT-B10 contract surface and packages harness, run, and gate
 * evidence without invoking scenario benchmark or chaos execution.
 */
export function executeQaContractSurface(input: QaContractSurfaceInput): QaContractSurfaceReport {
  const testCaseValidation = validateTestCaseSpec(input.test_case);
  const harnessResult = runRuntimeContractHarness({
    harness_run_ref: input.harness_run_ref,
    test_case_ref: input.test_case.test_case_ref,
    runtime_contract_artifacts: input.runtime_contract_artifacts,
    required_artifact_refs: input.required_artifact_refs,
    forbidden_runtime_terms: input.forbidden_runtime_terms,
  });
  const assertionStatuses = [
    ...harnessResult.assertion_results.map((assertion) => assertion.status),
    testCaseValidation.ok ? "ok" as const : "fail" as const,
  ];
  const overallStatus = deriveRunStatus(assertionStatuses);
  const runtimeArtifactRefs = uniqueQaRefs([
    ...artifactRefs(input.runtime_contract_artifacts),
    ...harnessResult.contract_reports.map((report) => report.report_ref),
  ]);
  const testRunRecord = buildTestRunRecord({
    test_run_ref: input.harness_run_ref,
    test_case_ref: input.test_case.test_case_ref,
    collection_mode: "contract_stream",
    timing: {
      start_time_ms: input.started_at_ms,
      end_time_ms: input.ended_at_ms,
    },
    runtime_artifact_refs: runtimeArtifactRefs,
    qa_truth_artifact_refs: input.test_case.qa_truth_usage === "offline_only" ? input.test_case.audit_artifacts_required.filter((item) => item === "offline_truth").map((item) => makeQaRef(input.harness_run_ref, item)) : [],
    assertion_result_refs: harnessResult.assertion_results.map((assertion) => assertion.assertion_ref),
    replay_bundle_ref: input.replay_bundle_ref,
    overall_status: overallStatus,
  });
  const boundaryArtifactCount = input.runtime_contract_artifacts.filter((artifact) => artifact.kind === "runtime_qa_boundary_decision").length;
  const boundaryProtected = testCaseValidation.ok
    && boundaryArtifactCount > 0
    && harnessResult.forbidden_term_hits.length === 0
    && harnessResult.contract_reports.every((report) => report.error_count === 0);
  const releaseReadinessReport = buildReleaseReadinessReport({
    release_report_ref: makeQaRef(input.harness_run_ref, "contract_surface_release_readiness"),
    milestone_ref: input.milestone_ref,
    gate_evidence: buildGateEvidence(input, harnessResult, testCaseValidation, boundaryProtected),
    benchmark_scorecard_refs: input.benchmark_scorecard_refs,
    regression_report_refs: input.regression_report_refs ?? [],
    chaos_record_refs: input.chaos_record_refs ?? [],
    no_go_conditions: buildNoGoConditions(harnessResult, testCaseValidation, boundaryProtected),
    operator_summary: input.operator_summary,
  });
  const base = {
    schema_version: QA_CONTRACT_SURFACE_REPORT_SCHEMA_VERSION,
    harness_run_ref: input.harness_run_ref,
    test_case_ref: input.test_case.test_case_ref,
    coverage_domains: freezeQaArray([...new Set(input.coverage_domains)]),
    test_case_validation_report: testCaseValidation,
    harness_result: harnessResult,
    test_run_record: testRunRecord,
    release_readiness_report: releaseReadinessReport,
    runtime_qa_boundary_artifact_count: boundaryArtifactCount,
    boundary_protected: boundaryProtected,
    overall_status: overallStatus,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateRuntimeContractHarnessResult(result: RuntimeContractHarnessResult): QaValidationReport {
  const issues: ValidationIssue[] = [];
  validateQaRef(result.harness_run_ref, "$.harness_run_ref", issues);
  validateQaRef(result.test_case_ref, "$.test_case_ref", issues);
  validateNonEmptyQaArray(result.assertion_results, "$.assertion_results", "HarnessAssertionsMissing", issues);
  validateNonEmptyQaArray(result.contract_reports, "$.contract_reports", "HarnessContractReportsMissing", issues);
  validateQaRefs(result.missing_required_artifact_refs, "$.missing_required_artifact_refs", issues);
  for (const [index, hit] of result.forbidden_term_hits.entries()) {
    validateQaText(hit, `$.forbidden_term_hits[${index}]`, true, issues);
  }
  if (result.overall_status === "ok" && (result.missing_required_artifact_refs.length > 0 || result.forbidden_term_hits.length > 0)) {
    issues.push(qaIssue("error", "HarnessOkWithContractDefect", "$.overall_status", "Harness cannot be ok when required artifacts are missing or restricted terms are found.", "Set the harness status from assertion records."));
  }
  return buildQaValidationReport(makeQaRef("runtime_contract_harness_report", result.harness_run_ref), issues, qaRouteForIssues(issues));
}

export function assertValidRuntimeContractHarnessResult(result: RuntimeContractHarnessResult): void {
  const report = validateRuntimeContractHarnessResult(result);
  if (!report.ok) {
    throw new QaContractError("Runtime contract harness result failed validation.", report.issues);
  }
}

function validateRuntimeArtifact(artifact: RuntimeContractArtifact): ApiContractValidationReport {
  switch (artifact.kind) {
    case "artifact_envelope":
      return validateArtifactEnvelope(artifact.value);
    case "provenance_manifest":
      return validateProvenanceManifest(artifact.value);
    case "runtime_qa_boundary_decision":
      return validateRuntimeQaBoundaryDecision(artifact.value);
  }
}

function buildHarnessAssertions(
  input: RuntimeContractHarnessInput,
  reports: readonly ApiContractValidationReport[],
  missing: readonly Ref[],
  forbiddenHits: readonly string[],
): AssertionResult[] {
  const contractErrors = reports.reduce((sum, report) => sum + report.error_count, 0);
  return [
    buildAssertionResult({
      assertion_ref: makeQaRef(input.harness_run_ref, "api_contract_reports"),
      test_run_ref: input.harness_run_ref,
      assertion_category: "schema",
      expected: "all API contract reports contain zero errors",
      observed: `contract_error_count=${contractErrors}`,
      status: contractErrors === 0 ? "ok" : "fail",
      severity: contractErrors === 0 ? "warning" : "error",
      evidence_refs: reports.map((report) => report.report_ref),
      remediation_hint: "Repair invalid API contract artifacts before runtime integration.",
    }),
    buildAssertionResult({
      assertion_ref: makeQaRef(input.harness_run_ref, "required_artifact_closure"),
      test_run_ref: input.harness_run_ref,
      assertion_category: "route",
      expected: "all required runtime artifacts are present",
      observed: missing.length === 0 ? "missing_count=0" : `missing=${missing.join(",")}`,
      status: missing.length === 0 ? "ok" : "fail",
      severity: missing.length === 0 ? "warning" : "error",
      evidence_refs: input.required_artifact_refs.length === 0 ? [input.harness_run_ref] : input.required_artifact_refs,
      remediation_hint: "Attach required runtime artifacts or correct the test case scope.",
    }),
    buildAssertionResult({
      assertion_ref: makeQaRef(input.harness_run_ref, "runtime_term_boundary"),
      test_run_ref: input.harness_run_ref,
      assertion_category: "provenance",
      expected: "runtime artifacts contain no restricted QA terms",
      observed: forbiddenHits.length === 0 ? "restricted_term_hits=0" : `restricted_term_hits=${forbiddenHits.join(",")}`,
      status: forbiddenHits.length === 0 ? "ok" : "fail",
      severity: forbiddenHits.length === 0 ? "warning" : "error",
      evidence_refs: [input.harness_run_ref],
      remediation_hint: "Redact restricted terms or quarantine the runtime artifact.",
    }),
  ];
}

function deriveHarnessStatus(assertions: readonly AssertionResult[]): QaOutcome {
  if (assertions.some((assertion) => assertion.status === "fail")) {
    return "fail";
  }
  if (assertions.some((assertion) => assertion.status === "warn")) {
    return "warn";
  }
  return "ok";
}

function collectArtifactRefs(artifacts: readonly RuntimeContractArtifact[]): ReadonlySet<Ref> {
  const refs = new Set<Ref>();
  for (const artifact of artifacts) {
    switch (artifact.kind) {
      case "artifact_envelope":
        refs.add(artifact.value.artifact_ref);
        break;
      case "provenance_manifest":
        refs.add(artifact.value.provenance_manifest_ref);
        break;
      case "runtime_qa_boundary_decision":
        refs.add(artifact.value.boundary_decision_ref);
        break;
    }
  }
  return refs;
}

function artifactRefs(artifacts: readonly RuntimeContractArtifact[]): readonly Ref[] {
  return freezeQaArray([...collectArtifactRefs(artifacts)]);
}

function findForbiddenTermHits(artifacts: readonly RuntimeContractArtifact[], terms: readonly string[]): readonly string[] {
  if (terms.length === 0) {
    return freezeQaArray([]);
  }
  const serialized = artifacts.map((artifact) => normalizeQaText(JSON.stringify(artifact.value), 5000)).join("\n");
  return freezeQaArray(terms.filter((term) => term.length > 0 && serialized.includes(term)));
}

function buildGateEvidence(
  input: QaContractSurfaceInput,
  harnessResult: RuntimeContractHarnessResult,
  testCaseValidation: QaValidationReport,
  boundaryProtected: boolean,
): readonly ReleaseGateEvidence[] {
  const status = harnessResult.overall_status === "ok" && testCaseValidation.ok && boundaryProtected ? "green" as const : "red" as const;
  return freezeQaArray(input.coverage_domains.map((domain) => Object.freeze({
    gate_ref: makeQaRef(input.harness_run_ref, "gate", domain),
    gate_class: releaseGateClassFor(domain),
    status,
    evidence_refs: uniqueQaRefs([
      harnessResult.harness_run_ref,
      testCaseValidation.report_ref,
      ...harnessResult.assertion_results.map((assertion) => assertion.assertion_ref),
    ]),
    summary: gateSummaryFor(domain, status),
  })));
}

function releaseGateClassFor(domain: QaContractCoverageDomain): ReleaseGateClass {
  if (domain === "unit") return "unit_test";
  if (domain === "integration") return "integration";
  if (domain === "safety") return "safety";
  if (domain === "runtime_qa_boundary" || domain === "contract" || domain === "api" || domain === "storage" || domain === "auth" || domain === "frontend") return "architecture_contract";
  return "architecture_contract";
}

function gateSummaryFor(domain: QaContractCoverageDomain, status: "green" | "red"): string {
  return status === "green"
    ? `PIT-B10 ${domain} contract surface passed with runtime boundary evidence.`
    : `PIT-B10 ${domain} contract surface failed or lacks required runtime boundary evidence.`;
}

function buildNoGoConditions(
  harnessResult: RuntimeContractHarnessResult,
  testCaseValidation: QaValidationReport,
  boundaryProtected: boolean,
): readonly string[] {
  const conditions: string[] = [];
  if (!testCaseValidation.ok) {
    conditions.push("test_case_contract_invalid");
  }
  if (harnessResult.overall_status !== "ok") {
    conditions.push("runtime_contract_harness_failed");
  }
  if (!boundaryProtected) {
    conditions.push("runtime_qa_boundary_evidence_missing_or_failed");
  }
  return freezeQaArray(conditions);
}

export const RUNTIME_CONTRACT_TEST_HARNESS_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: RUNTIME_CONTRACT_TEST_HARNESS_SCHEMA_VERSION,
  blueprint: QA_BLUEPRINT_REF,
  sections: freezeQaArray(["20.3", "20.6", "20.11", "20.17", "20.20", "20.22"]),
  component: "RuntimeContractTestHarness",
});
