/**
 * Operational runbook registry.
 *
 * Blueprint: `architecture_docs/21_ROADMAP_WBS_DELIVERY_AND_PROJECT_OPERATIONS.md`
 * sections 21.8, 21.9, 21.11, 21.13, and 21.15.
 *
 * Runbooks and dashboards make operational readiness explicit: each artifact
 * declares audience, required content, evidence refs, and owner workstreams.
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
import type { OperationsValidationReport } from "./milestone_registry";
import type { WorkstreamRef } from "./workstream_registry";

export const OPERATIONAL_RUNBOOK_REGISTRY_SCHEMA_VERSION = "mebsuta.operations.operational_runbook_registry.v1" as const;

export type RunbookKind = "scenario" | "safety" | "qa" | "prompt" | "memory" | "oops" | "demo";
export type DashboardKind = "runtime" | "safety" | "qa" | "prompt" | "memory" | "release";

export interface OperationalRunbookInput {
  readonly runbook_ref: Ref;
  readonly runbook_kind: RunbookKind;
  readonly owner_workstream_refs: readonly WorkstreamRef[];
  readonly required_sections: readonly string[];
  readonly evidence_refs: readonly Ref[];
  readonly readiness_notes: readonly string[];
}

export interface OperationalDashboardInput {
  readonly dashboard_ref: Ref;
  readonly dashboard_kind: DashboardKind;
  readonly audience: string;
  readonly purpose: string;
  readonly source_artifact_refs: readonly Ref[];
  readonly alert_signal_refs: readonly Ref[];
}

export interface OperationalRunbook {
  readonly schema_version: typeof OPERATIONAL_RUNBOOK_REGISTRY_SCHEMA_VERSION;
  readonly runbook_ref: Ref;
  readonly runbook_kind: RunbookKind;
  readonly owner_workstream_refs: readonly WorkstreamRef[];
  readonly required_sections: readonly string[];
  readonly evidence_refs: readonly Ref[];
  readonly readiness_notes: readonly string[];
  readonly determinism_hash: string;
}

export interface OperationalDashboard {
  readonly schema_version: typeof OPERATIONAL_RUNBOOK_REGISTRY_SCHEMA_VERSION;
  readonly dashboard_ref: Ref;
  readonly dashboard_kind: DashboardKind;
  readonly audience: string;
  readonly purpose: string;
  readonly source_artifact_refs: readonly Ref[];
  readonly alert_signal_refs: readonly Ref[];
  readonly determinism_hash: string;
}

export interface OperationalReadinessRegistry {
  readonly schema_version: typeof OPERATIONAL_RUNBOOK_REGISTRY_SCHEMA_VERSION;
  readonly registry_ref: Ref;
  readonly runbooks: readonly OperationalRunbook[];
  readonly dashboards: readonly OperationalDashboard[];
  readonly determinism_hash: string;
}

/**
 * Builds a runbook record with required readiness evidence.
 */
export function buildOperationalRunbook(input: OperationalRunbookInput): OperationalRunbook {
  const runbook = normalizeOperationalRunbook(input);
  const report = validateOperationalRunbook(runbook);
  if (!report.ok) {
    throw new OperationsContractError("Operational runbook failed validation.", report.issues);
  }
  return runbook;
}

export function buildOperationalDashboard(input: OperationalDashboardInput): OperationalDashboard {
  const dashboard = normalizeOperationalDashboard(input);
  const report = validateOperationalDashboard(dashboard);
  if (!report.ok) {
    throw new OperationsContractError("Operational dashboard failed validation.", report.issues);
  }
  return dashboard;
}

export function buildOperationalReadinessRegistry(registryRef: Ref, runbooks: readonly OperationalRunbookInput[], dashboards: readonly OperationalDashboardInput[]): OperationalReadinessRegistry {
  const base = {
    schema_version: OPERATIONAL_RUNBOOK_REGISTRY_SCHEMA_VERSION,
    registry_ref: registryRef,
    runbooks: freezeOperationsArray(runbooks.map(buildOperationalRunbook)),
    dashboards: freezeOperationsArray(dashboards.map(buildOperationalDashboard)),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateOperationalRunbook(runbook: OperationalRunbook): OperationsValidationReport {
  const issues: ValidationIssue[] = [];
  validateOperationsRef(runbook.runbook_ref, "$.runbook_ref", issues);
  validateOperationsNonEmptyArray(runbook.owner_workstream_refs, "$.owner_workstream_refs", "RunbookOwnersMissing", issues);
  validateOperationsNonEmptyArray(runbook.required_sections, "$.required_sections", "RunbookSectionsMissing", issues);
  validateOperationsNonEmptyArray(runbook.evidence_refs, "$.evidence_refs", "RunbookEvidenceMissing", issues);
  validateOperationsRefs(runbook.evidence_refs, "$.evidence_refs", issues);
  runbook.required_sections.forEach((section, index) => validateOperationsText(section, `$.required_sections[${index}]`, true, issues));
  runbook.readiness_notes.forEach((note, index) => validateOperationsText(note, `$.readiness_notes[${index}]`, false, issues));
  if (runbook.runbook_kind === "safety" && runbook.required_sections.some((section) => /safehold/iu.test(section)) === false) {
    issues.push(operationsIssue("error", "SafetyRunbookSafeHoldMissing", "$.required_sections", "Safety runbook must document SafeHold meanings and review steps.", "Add SafeHold operational section."));
  }
  return buildOperationsValidationReport(makeOperationsRef("operational_runbook_report", runbook.runbook_ref), issues, operationsRouteForIssues(issues));
}

export function validateOperationalDashboard(dashboard: OperationalDashboard): OperationsValidationReport {
  const issues: ValidationIssue[] = [];
  validateOperationsRef(dashboard.dashboard_ref, "$.dashboard_ref", issues);
  validateOperationsText(dashboard.audience, "$.audience", true, issues);
  validateOperationsText(dashboard.purpose, "$.purpose", true, issues);
  validateOperationsNonEmptyArray(dashboard.source_artifact_refs, "$.source_artifact_refs", "DashboardSourcesMissing", issues);
  validateOperationsNonEmptyArray(dashboard.alert_signal_refs, "$.alert_signal_refs", "DashboardAlertsMissing", issues);
  validateOperationsRefs(dashboard.source_artifact_refs, "$.source_artifact_refs", issues);
  validateOperationsRefs(dashboard.alert_signal_refs, "$.alert_signal_refs", issues);
  return buildOperationsValidationReport(makeOperationsRef("operational_dashboard_report", dashboard.dashboard_ref), issues, operationsRouteForIssues(issues));
}

export function defaultOperationalReadinessRegistry(): OperationalReadinessRegistry {
  return buildOperationalReadinessRegistry(
    makeOperationsRef("default_operational_readiness"),
    [
      runbook("scenario_runbook", "scenario", ["WS-P", "WS-Q"], ["Scenario start procedure", "Embodiment selection", "Output review"], ["scenario_spec", "replay_bundle"]),
      runbook("safety_runbook", "safety", ["WS-O", "WS-Q"], ["SafeHold meanings", "Recovery options", "Review steps"], ["safety_report", "safehold_state"]),
      runbook("qa_runbook", "qa", ["WS-P"], ["Scorecard interpretation", "Failure replay", "Regression review"], ["benchmark_scorecard", "regression_report"]),
      runbook("prompt_runbook", "prompt", ["WS-F"], ["Prompt contract versions", "Repair behavior", "Model limitations"], ["prompt_contract", "model_version_record"]),
      runbook("memory_runbook", "memory", ["WS-L"], ["Memory record classes", "Staleness labels", "Contradiction handling"], ["memory_record", "contradiction_report"]),
      runbook("oops_runbook", "oops", ["WS-K"], ["Failure categories", "Retry behavior", "Escalation"], ["oops_episode", "retry_budget"]),
      runbook("demo_runbook", "demo", ["WS-Q", "WS-N"], ["Supported tasks", "Known limitations", "Expected monologue"], ["release_plan", "monologue_event"]),
    ],
    [
      dashboard("runtime_dashboard", "runtime", "Operators and developers", "Current state, sensors, plan, execution, and verification.", ["state_timeline", "sensor_bundle"], ["safehold_event", "route_block"]),
      dashboard("safety_dashboard", "safety", "Safety engineers", "SafeHold, validators, force/contact, and blocked plans.", ["safety_report", "runtime_monitor"], ["force_threshold", "unsafe_route"]),
      dashboard("qa_dashboard", "qa", "QA engineers", "Test results, scorecards, and replay packages.", ["test_run_record", "benchmark_scorecard"], ["red_gate", "regression_drift"]),
      dashboard("prompt_dashboard", "prompt", "AI integration", "Prompt validity, model latency, and repair rate.", ["prompt_bundle", "model_response"], ["schema_error", "latency_band"]),
      dashboard("memory_dashboard", "memory", "Memory engineers", "Writes, retrievals, contradictions, and staleness.", ["memory_record", "retrieval_trace"], ["contamination", "stale_use"]),
      dashboard("release_dashboard", "release", "Program management", "Gate status, risks, and milestone progress.", ["release_plan", "milestone_health"], ["red_gate", "schedule_risk"]),
    ],
  );
}

function normalizeOperationalRunbook(input: OperationalRunbookInput): OperationalRunbook {
  const base = {
    schema_version: OPERATIONAL_RUNBOOK_REGISTRY_SCHEMA_VERSION,
    runbook_ref: input.runbook_ref,
    runbook_kind: input.runbook_kind,
    owner_workstream_refs: freezeOperationsArray([...new Set(input.owner_workstream_refs)]),
    required_sections: uniqueOperationsStrings(input.required_sections),
    evidence_refs: uniqueOperationsRefs(input.evidence_refs),
    readiness_notes: uniqueOperationsStrings(input.readiness_notes),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function normalizeOperationalDashboard(input: OperationalDashboardInput): OperationalDashboard {
  const base = {
    schema_version: OPERATIONAL_RUNBOOK_REGISTRY_SCHEMA_VERSION,
    dashboard_ref: input.dashboard_ref,
    dashboard_kind: input.dashboard_kind,
    audience: normalizeOperationsText(input.audience, 180),
    purpose: normalizeOperationsText(input.purpose),
    source_artifact_refs: uniqueOperationsRefs(input.source_artifact_refs),
    alert_signal_refs: uniqueOperationsRefs(input.alert_signal_refs),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function runbook(
  runbookRef: Ref,
  runbookKind: RunbookKind,
  ownerWorkstreamRefs: readonly WorkstreamRef[],
  requiredSections: readonly string[],
  evidenceRefs: readonly Ref[],
): OperationalRunbookInput {
  return {
    runbook_ref: runbookRef,
    runbook_kind: runbookKind,
    owner_workstream_refs: ownerWorkstreamRefs,
    required_sections: requiredSections,
    evidence_refs: evidenceRefs,
    readiness_notes: ["Keep linked evidence current before milestone review."],
  };
}

function dashboard(
  dashboardRef: Ref,
  dashboardKind: DashboardKind,
  audience: string,
  purpose: string,
  sourceArtifactRefs: readonly Ref[],
  alertSignalRefs: readonly Ref[],
): OperationalDashboardInput {
  return {
    dashboard_ref: dashboardRef,
    dashboard_kind: dashboardKind,
    audience,
    purpose,
    source_artifact_refs: sourceArtifactRefs,
    alert_signal_refs: alertSignalRefs,
  };
}

export const OPERATIONAL_RUNBOOK_REGISTRY_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: OPERATIONAL_RUNBOOK_REGISTRY_SCHEMA_VERSION,
  blueprint: OPERATIONS_BLUEPRINT_REF,
  sections: freezeOperationsArray(["21.8", "21.9", "21.11", "21.13", "21.15"]),
  component: "OperationalRunbookRegistry",
});
