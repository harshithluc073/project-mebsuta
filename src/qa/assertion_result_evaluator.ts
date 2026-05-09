/**
 * Assertion result evaluator.
 *
 * Blueprint: `architecture_docs/20_QA_TESTING_CHAOS_AND_BENCHMARK_ARCHITECTURE.md`
 * sections 20.4.2, 20.5.4, 20.6, 20.8 through 20.16, and 20.22.
 *
 * The evaluator converts deterministic observations into assertion records
 * with severity, evidence refs, remediation hints, and reproducible hashes.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
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
  validateFiniteQaNumber,
  validateNonEmptyQaArray,
  validateQaRef,
  validateQaRefs,
  validateQaText,
} from "./test_case_spec";
import type { QaOutcome, QaValidationReport } from "./test_case_spec";

export const ASSERTION_RESULT_EVALUATOR_SCHEMA_VERSION = "mebsuta.qa.assertion_result_evaluator.v1" as const;

export type AssertionCategory = "schema" | "safety" | "provenance" | "spatial" | "control" | "memory" | "prompt" | "route" | "benchmark" | "chaos" | "observability";
export type AssertionStatus = Extract<QaOutcome, "ok" | "fail" | "skip" | "warn">;

export interface AssertionResultInput {
  readonly assertion_ref: Ref;
  readonly test_run_ref: Ref;
  readonly assertion_category: AssertionCategory;
  readonly expected: string;
  readonly observed: string;
  readonly status: AssertionStatus;
  readonly severity: ValidationSeverity;
  readonly evidence_refs: readonly Ref[];
  readonly remediation_hint: string;
}

export interface AssertionResult {
  readonly schema_version: typeof ASSERTION_RESULT_EVALUATOR_SCHEMA_VERSION;
  readonly assertion_ref: Ref;
  readonly test_run_ref: Ref;
  readonly assertion_category: AssertionCategory;
  readonly expected: string;
  readonly observed: string;
  readonly status: AssertionStatus;
  readonly severity: ValidationSeverity;
  readonly evidence_refs: readonly Ref[];
  readonly remediation_hint: string;
  readonly determinism_hash: string;
}

export interface NumericAssertionInput {
  readonly assertion_ref: Ref;
  readonly test_run_ref: Ref;
  readonly assertion_category: AssertionCategory;
  readonly metric_name: string;
  readonly observed_value: number;
  readonly min_allowed?: number;
  readonly max_allowed?: number;
  readonly warn_below?: number;
  readonly warn_above?: number;
  readonly evidence_refs: readonly Ref[];
  readonly remediation_hint: string;
}

/**
 * Builds an immutable assertion result and enforces required evidence.
 */
export function buildAssertionResult(input: AssertionResultInput): AssertionResult {
  const result = normalizeAssertionResult(input);
  const report = validateAssertionResult(result);
  if (!report.ok) {
    throw new QaContractError("Assertion result failed validation.", report.issues);
  }
  return result;
}

export function normalizeAssertionResult(input: AssertionResultInput): AssertionResult {
  const base = {
    schema_version: ASSERTION_RESULT_EVALUATOR_SCHEMA_VERSION,
    assertion_ref: input.assertion_ref,
    test_run_ref: input.test_run_ref,
    assertion_category: input.assertion_category,
    expected: normalizeQaText(input.expected),
    observed: normalizeQaText(input.observed),
    status: input.status,
    severity: input.severity,
    evidence_refs: uniqueQaRefs(input.evidence_refs),
    remediation_hint: normalizeQaText(input.remediation_hint, 480),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateAssertionResult(result: AssertionResult): QaValidationReport {
  const issues: ValidationIssue[] = [];
  validateQaRef(result.assertion_ref, "$.assertion_ref", issues);
  validateQaRef(result.test_run_ref, "$.test_run_ref", issues);
  validateQaText(result.expected, "$.expected", true, issues);
  validateQaText(result.observed, "$.observed", true, issues);
  validateQaText(result.remediation_hint, "$.remediation_hint", result.status === "fail" || result.status === "warn", issues);
  validateQaRefs(result.evidence_refs, "$.evidence_refs", issues);
  if (result.status !== "skip") {
    validateNonEmptyQaArray(result.evidence_refs, "$.evidence_refs", "AssertionEvidenceMissing", issues);
  }
  if (result.status === "fail" && result.severity !== "error") {
    issues.push(qaIssue("warning", "FailAssertionSeverityReview", "$.severity", "Failing assertions should normally use error severity.", "Use error severity unless this is an advisory check."));
  }
  return buildQaValidationReport(makeQaRef("assertion_result_report", result.assertion_ref), issues, qaRouteForIssues(issues));
}

export function evaluateNumericAssertion(input: NumericAssertionInput): AssertionResult {
  const issues: ValidationIssue[] = [];
  validateFiniteQaNumber(input.observed_value, "$.observed_value", Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, issues);
  if (input.min_allowed !== undefined) {
    validateFiniteQaNumber(input.min_allowed, "$.min_allowed", Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, issues);
  }
  if (input.max_allowed !== undefined) {
    validateFiniteQaNumber(input.max_allowed, "$.max_allowed", Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, issues);
  }
  const belowHard = input.min_allowed !== undefined && input.observed_value < input.min_allowed;
  const aboveHard = input.max_allowed !== undefined && input.observed_value > input.max_allowed;
  const belowWarn = input.warn_below !== undefined && input.observed_value < input.warn_below;
  const aboveWarn = input.warn_above !== undefined && input.observed_value > input.warn_above;
  const status: AssertionStatus = issues.some((issue) => issue.severity === "error") || belowHard || aboveHard
    ? "fail"
    : belowWarn || aboveWarn
      ? "warn"
      : "ok";
  const expected = numericExpectation(input.min_allowed, input.max_allowed, input.warn_below, input.warn_above);
  const observed = `${input.metric_name}=${formatQaNumber(input.observed_value)}`;
  return buildAssertionResult({
    assertion_ref: input.assertion_ref,
    test_run_ref: input.test_run_ref,
    assertion_category: input.assertion_category,
    expected,
    observed,
    status,
    severity: status === "fail" ? "error" : status === "warn" ? "warning" : "warning",
    evidence_refs: input.evidence_refs,
    remediation_hint: input.remediation_hint,
  });
}

export function summarizeAssertionStatuses(results: readonly AssertionResult[]): Readonly<Record<AssertionStatus, number>> {
  const counts: Record<AssertionStatus, number> = { ok: 0, fail: 0, skip: 0, warn: 0 };
  for (const result of results) {
    counts[result.status] += 1;
  }
  return Object.freeze(counts);
}

function numericExpectation(minAllowed: number | undefined, maxAllowed: number | undefined, warnBelow: number | undefined, warnAbove: number | undefined): string {
  const clauses: string[] = [];
  if (minAllowed !== undefined) {
    clauses.push(`value >= ${formatQaNumber(minAllowed)}`);
  }
  if (maxAllowed !== undefined) {
    clauses.push(`value <= ${formatQaNumber(maxAllowed)}`);
  }
  if (warnBelow !== undefined) {
    clauses.push(`warn below ${formatQaNumber(warnBelow)}`);
  }
  if (warnAbove !== undefined) {
    clauses.push(`warn above ${formatQaNumber(warnAbove)}`);
  }
  return clauses.length === 0 ? "finite numeric value" : clauses.join("; ");
}

function formatQaNumber(value: number): string {
  return Number.isInteger(value) ? `${value}` : value.toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "");
}

export const ASSERTION_RESULT_EVALUATOR_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: ASSERTION_RESULT_EVALUATOR_SCHEMA_VERSION,
  blueprint: QA_BLUEPRINT_REF,
  sections: freezeQaArray(["20.4.2", "20.5.4", "20.6", "20.8", "20.9", "20.10", "20.11", "20.12", "20.13", "20.14", "20.15", "20.16", "20.22"]),
  component: "AssertionResultEvaluator",
});
