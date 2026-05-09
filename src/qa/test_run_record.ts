/**
 * QA test run record contract.
 *
 * Blueprint: `architecture_docs/20_QA_TESTING_CHAOS_AND_BENCHMARK_ARCHITECTURE.md`
 * sections 20.3, 20.4.2, 20.5.3, 20.20, and 20.22.
 *
 * A run record captures runtime artifacts, QA-only truth references, assertion
 * refs, timing, replay bundle identity, and final outcome without allowing
 * offline truth to become a runtime decision input.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  QA_BLUEPRINT_REF,
  QaContractError,
  buildQaValidationReport,
  freezeQaArray,
  makeQaRef,
  qaIssue,
  qaRouteForIssues,
  uniqueQaRefs,
  validateFiniteQaNumber,
  validateNonEmptyQaArray,
  validateOptionalQaRef,
  validateQaRef,
  validateQaRefs,
} from "./test_case_spec";
import type { QaOutcome, QaValidationReport } from "./test_case_spec";

export const TEST_RUN_RECORD_SCHEMA_VERSION = "mebsuta.qa.test_run_record.v1" as const;

export type TestRunStatus = QaOutcome;
export type RuntimeCollectionMode = "contract_stream" | "scenario_episode" | "golden_replay" | "chaos_run" | "benchmark_sweep";

export interface TestRunTiming {
  readonly start_time_ms: number;
  readonly end_time_ms: number;
  readonly duration_ms: number;
}

export interface TestRunRecordInput {
  readonly test_run_ref: Ref;
  readonly test_case_ref: Ref;
  readonly scenario_run_ref?: Ref;
  readonly collection_mode: RuntimeCollectionMode;
  readonly timing: Omit<TestRunTiming, "duration_ms">;
  readonly runtime_artifact_refs: readonly Ref[];
  readonly qa_truth_artifact_refs?: readonly Ref[];
  readonly assertion_result_refs: readonly Ref[];
  readonly replay_bundle_ref: Ref;
  readonly overall_status: TestRunStatus;
  readonly operator_note_refs?: readonly Ref[];
}

export interface TestRunRecord {
  readonly schema_version: typeof TEST_RUN_RECORD_SCHEMA_VERSION;
  readonly test_run_ref: Ref;
  readonly test_case_ref: Ref;
  readonly scenario_run_ref?: Ref;
  readonly collection_mode: RuntimeCollectionMode;
  readonly timing: TestRunTiming;
  readonly runtime_artifact_refs: readonly Ref[];
  readonly qa_truth_artifact_refs: readonly Ref[];
  readonly assertion_result_refs: readonly Ref[];
  readonly replay_bundle_ref: Ref;
  readonly overall_status: TestRunStatus;
  readonly operator_note_refs: readonly Ref[];
  readonly determinism_hash: string;
}

/**
 * Builds a run record and checks timing, replay, and artifact closure.
 */
export function buildTestRunRecord(input: TestRunRecordInput): TestRunRecord {
  const record = normalizeTestRunRecord(input);
  const report = validateTestRunRecord(record);
  if (!report.ok) {
    throw new QaContractError("Test run record failed validation.", report.issues);
  }
  return record;
}

export function normalizeTestRunRecord(input: TestRunRecordInput): TestRunRecord {
  const duration = Math.max(0, input.timing.end_time_ms - input.timing.start_time_ms);
  const base = {
    schema_version: TEST_RUN_RECORD_SCHEMA_VERSION,
    test_run_ref: input.test_run_ref,
    test_case_ref: input.test_case_ref,
    scenario_run_ref: input.scenario_run_ref,
    collection_mode: input.collection_mode,
    timing: Object.freeze({
      start_time_ms: input.timing.start_time_ms,
      end_time_ms: input.timing.end_time_ms,
      duration_ms: duration,
    }),
    runtime_artifact_refs: uniqueQaRefs(input.runtime_artifact_refs),
    qa_truth_artifact_refs: uniqueQaRefs(input.qa_truth_artifact_refs ?? []),
    assertion_result_refs: uniqueQaRefs(input.assertion_result_refs),
    replay_bundle_ref: input.replay_bundle_ref,
    overall_status: input.overall_status,
    operator_note_refs: uniqueQaRefs(input.operator_note_refs ?? []),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateTestRunRecord(record: TestRunRecord): QaValidationReport {
  const issues: ValidationIssue[] = [];
  validateQaRef(record.test_run_ref, "$.test_run_ref", issues);
  validateQaRef(record.test_case_ref, "$.test_case_ref", issues);
  validateOptionalQaRef(record.scenario_run_ref, "$.scenario_run_ref", issues);
  validateQaRef(record.replay_bundle_ref, "$.replay_bundle_ref", issues);
  validateQaRefs(record.runtime_artifact_refs, "$.runtime_artifact_refs", issues);
  validateQaRefs(record.qa_truth_artifact_refs, "$.qa_truth_artifact_refs", issues);
  validateQaRefs(record.assertion_result_refs, "$.assertion_result_refs", issues);
  validateQaRefs(record.operator_note_refs, "$.operator_note_refs", issues);
  validateNonEmptyQaArray(record.runtime_artifact_refs, "$.runtime_artifact_refs", "RuntimeArtifactsMissing", issues);
  validateNonEmptyQaArray(record.assertion_result_refs, "$.assertion_result_refs", "AssertionResultsMissing", issues);
  validateRunTiming(record.timing, "$.timing", issues);
  if (record.collection_mode === "benchmark_sweep" && record.qa_truth_artifact_refs.length === 0) {
    issues.push(qaIssue("warning", "BenchmarkTruthRefsMissing", "$.qa_truth_artifact_refs", "Benchmark sweeps normally require QA-only truth refs for scoring.", "Attach offline truth refs to the QA-only collection."));
  }
  if (record.overall_status === "ok" && record.assertion_result_refs.length === 0) {
    issues.push(qaIssue("error", "OkRunWithoutAssertions", "$.overall_status", "An ok run requires assertion evidence.", "Attach assertion result refs before marking the run ok."));
  }
  return buildQaValidationReport(makeQaRef("test_run_record_report", record.test_run_ref), issues, qaRouteForIssues(issues));
}

export function deriveRunStatus(assertionStatuses: readonly QaOutcome[]): TestRunStatus {
  if (assertionStatuses.length === 0) {
    return "blocked";
  }
  if (assertionStatuses.includes("fail")) {
    return "fail";
  }
  if (assertionStatuses.includes("blocked")) {
    return "blocked";
  }
  if (assertionStatuses.includes("needs_review")) {
    return "needs_review";
  }
  if (assertionStatuses.includes("warn")) {
    return "warn";
  }
  if (assertionStatuses.every((status) => status === "skip")) {
    return "skip";
  }
  return "ok";
}

function validateRunTiming(timing: TestRunTiming, path: string, issues: ValidationIssue[]): void {
  validateFiniteQaNumber(timing.start_time_ms, `${path}.start_time_ms`, 0, undefined, issues);
  validateFiniteQaNumber(timing.end_time_ms, `${path}.end_time_ms`, 0, undefined, issues);
  validateFiniteQaNumber(timing.duration_ms, `${path}.duration_ms`, 0, undefined, issues);
  if (timing.end_time_ms < timing.start_time_ms) {
    issues.push(qaIssue("error", "RunTimingOrderInvalid", path, "End time must be greater than or equal to start time.", "Use monotonic run timing from the same clock."));
  }
  if (Math.abs(timing.duration_ms - (timing.end_time_ms - timing.start_time_ms)) > 1e-9) {
    issues.push(qaIssue("error", "RunDurationMismatch", `${path}.duration_ms`, "Duration must equal end minus start.", "Recompute duration deterministically."));
  }
}

export const TEST_RUN_RECORD_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: TEST_RUN_RECORD_SCHEMA_VERSION,
  blueprint: QA_BLUEPRINT_REF,
  sections: freezeQaArray(["20.3", "20.4.2", "20.5.3", "20.20", "20.22"]),
  component: "TestRunRecord",
});
