/**
 * Chaos injection record contract.
 *
 * Blueprint: `architecture_docs/20_QA_TESTING_CHAOS_AND_BENCHMARK_ARCHITECTURE.md`
 * sections 20.12, 20.16, 20.17, 20.20.3, and 20.22.
 *
 * The record documents injected stress, expected detection signals, route
 * expectations, forbidden outcomes, replay requirements, and observed response.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
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
  uniqueQaStrings,
  validateNonEmptyQaArray,
  validateQaRef,
  validateQaRefs,
  validateQaText,
} from "./test_case_spec";
import type { QaRoute, QaValidationReport } from "./test_case_spec";

export const CHAOS_INJECTION_RECORD_SCHEMA_VERSION = "mebsuta.qa.chaos_injection_record.v1" as const;

export type ChaosTargetSubsystem = "model_api" | "sensor" | "physics" | "control" | "memory" | "safety" | "event_bus" | "observability";
export type ChaosInjectionType = "timeout" | "dropout" | "delay" | "noise" | "contradiction" | "disturbance" | "malformed_artifact" | "threshold_breach";
export type ChaosInjectionTimePolicy = "before_plan" | "during_execution" | "during_verification" | "during_correction" | "during_memory_write" | "during_observability";
export type ChaosSeverityLevel = "c1" | "c2" | "c3" | "c4";
export type ChaosDetectionStatus = "detected" | "missed" | "late" | "not_applicable";

export interface ChaosInjectionRecordInput {
  readonly chaos_test_ref: Ref;
  readonly target_subsystem: ChaosTargetSubsystem;
  readonly injection_type: ChaosInjectionType;
  readonly injection_time_policy: ChaosInjectionTimePolicy;
  readonly severity_level: ChaosSeverityLevel;
  readonly expected_detection_signal: string;
  readonly expected_route: QaRoute;
  readonly forbidden_outcomes: readonly string[];
  readonly replay_requirements: readonly Ref[];
  readonly observed_detection_status: ChaosDetectionStatus;
  readonly observed_route?: QaRoute;
  readonly observed_artifact_refs?: readonly Ref[];
}

export interface ChaosInjectionRecord {
  readonly schema_version: typeof CHAOS_INJECTION_RECORD_SCHEMA_VERSION;
  readonly chaos_test_ref: Ref;
  readonly target_subsystem: ChaosTargetSubsystem;
  readonly injection_type: ChaosInjectionType;
  readonly injection_time_policy: ChaosInjectionTimePolicy;
  readonly severity_level: ChaosSeverityLevel;
  readonly expected_detection_signal: string;
  readonly expected_route: QaRoute;
  readonly forbidden_outcomes: readonly string[];
  readonly replay_requirements: readonly Ref[];
  readonly observed_detection_status: ChaosDetectionStatus;
  readonly observed_route?: QaRoute;
  readonly observed_artifact_refs: readonly Ref[];
  readonly release_blocking: boolean;
  readonly determinism_hash: string;
}

/**
 * Builds an immutable chaos record and derives release blocking state.
 */
export function buildChaosInjectionRecord(input: ChaosInjectionRecordInput): ChaosInjectionRecord {
  const record = normalizeChaosInjectionRecord(input);
  const report = validateChaosInjectionRecord(record);
  if (!report.ok) {
    throw new QaContractError("Chaos injection record failed validation.", report.issues);
  }
  return record;
}

export function normalizeChaosInjectionRecord(input: ChaosInjectionRecordInput): ChaosInjectionRecord {
  const base = {
    schema_version: CHAOS_INJECTION_RECORD_SCHEMA_VERSION,
    chaos_test_ref: input.chaos_test_ref,
    target_subsystem: input.target_subsystem,
    injection_type: input.injection_type,
    injection_time_policy: input.injection_time_policy,
    severity_level: input.severity_level,
    expected_detection_signal: normalizeQaText(input.expected_detection_signal, 360),
    expected_route: input.expected_route,
    forbidden_outcomes: uniqueQaStrings(input.forbidden_outcomes),
    replay_requirements: uniqueQaRefs(input.replay_requirements),
    observed_detection_status: input.observed_detection_status,
    observed_route: input.observed_route,
    observed_artifact_refs: uniqueQaRefs(input.observed_artifact_refs ?? []),
    release_blocking: derivesReleaseBlock(input.severity_level, input.observed_detection_status, input.expected_route, input.observed_route),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateChaosInjectionRecord(record: ChaosInjectionRecord): QaValidationReport {
  const issues: ValidationIssue[] = [];
  validateQaRef(record.chaos_test_ref, "$.chaos_test_ref", issues);
  validateQaText(record.expected_detection_signal, "$.expected_detection_signal", true, issues);
  validateNonEmptyQaArray(record.forbidden_outcomes, "$.forbidden_outcomes", "ForbiddenOutcomesMissing", issues);
  validateNonEmptyQaArray(record.replay_requirements, "$.replay_requirements", "ReplayRequirementsMissing", issues);
  validateQaRefs(record.replay_requirements, "$.replay_requirements", issues);
  validateQaRefs(record.observed_artifact_refs, "$.observed_artifact_refs", issues);
  for (const [index, outcome] of record.forbidden_outcomes.entries()) {
    validateQaText(outcome, `$.forbidden_outcomes[${index}]`, true, issues);
  }
  if ((record.severity_level === "c3" || record.severity_level === "c4") && record.observed_detection_status !== "detected") {
    issues.push(qaIssue("error", "HighSeverityChaosNotDetected", "$.observed_detection_status", "C3/C4 chaos must be detected.", "Route this scenario to safety and release review."));
  }
  if (record.observed_route !== undefined && record.observed_route !== record.expected_route) {
    issues.push(qaIssue(record.severity_level === "c1" ? "warning" : "error", "ChaosRouteMismatch", "$.observed_route", "Observed route differs from expected route.", "Review runtime route policy and replay artifacts."));
  }
  if (record.release_blocking && record.severity_level === "c1") {
    issues.push(qaIssue("warning", "LowSeverityReleaseBlockReview", "$.release_blocking", "C1 issues rarely block release alone.", "Confirm whether this low-severity case is intentionally blocking."));
  }
  return buildQaValidationReport(makeQaRef("chaos_injection_record_report", record.chaos_test_ref), issues, qaRouteForIssues(issues));
}

export function chaosSeverityRank(level: ChaosSeverityLevel): number {
  return level === "c4" ? 4 : level === "c3" ? 3 : level === "c2" ? 2 : 1;
}

function derivesReleaseBlock(level: ChaosSeverityLevel, detection: ChaosDetectionStatus, expectedRoute: QaRoute, observedRoute: QaRoute | undefined): boolean {
  const highSeverity = chaosSeverityRank(level) >= 3;
  const detectionFailed = detection === "missed" || detection === "late";
  const routeFailed = observedRoute !== undefined && observedRoute !== expectedRoute;
  return highSeverity && (detectionFailed || routeFailed);
}

export const CHAOS_INJECTION_RECORD_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: CHAOS_INJECTION_RECORD_SCHEMA_VERSION,
  blueprint: QA_BLUEPRINT_REF,
  sections: freezeQaArray(["20.12", "20.16", "20.17", "20.20.3", "20.22"]),
  component: "ChaosInjectionRecord",
});
