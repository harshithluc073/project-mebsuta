/**
 * Risk signal catalog.
 *
 * Blueprint: `architecture_docs/22_RISK_REGISTER_AND_MITIGATION_ARCHITECTURE.md`
 * sections 22.6.1 and 22.6.2.
 *
 * Signals translate subsystem telemetry into risk triggers with thresholds,
 * dashboard panels, and linked risk refs.
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
  validateRiskNonEmptyArray,
  validateRiskRef,
  validateRiskRefs,
  validateRiskText,
} from "./risk_register_entry";
import type { RiskCategory, RiskValidationReport } from "./risk_register_entry";
import type { RiskSignalSource } from "./risk_monitoring_event";

export const RISK_SIGNAL_CATALOG_SCHEMA_VERSION = "mebsuta.risk.risk_signal_catalog.v1" as const;

export type RiskSignalMetricKind = "count" | "rate" | "ratio" | "latency_ms" | "confidence" | "score";
export type RiskDashboardPanel = "critical_boundary" | "verification_health" | "cognitive_health" | "control_safety" | "memory_integrity" | "oops_recovery" | "audio_reliability" | "release_gate_status";

export interface RiskSignalCatalogEntryInput {
  readonly signal_ref: Ref;
  readonly signal_name: string;
  readonly signal_source: RiskSignalSource;
  readonly risk_category: RiskCategory;
  readonly linked_risk_refs: readonly Ref[];
  readonly metric_kind: RiskSignalMetricKind;
  readonly threshold_value: number;
  readonly comparison: "greater_than" | "greater_or_equal" | "less_than" | "less_or_equal" | "equal";
  readonly dashboard_panel: RiskDashboardPanel;
  readonly response_hint: string;
}

export interface RiskSignalCatalogEntry {
  readonly schema_version: typeof RISK_SIGNAL_CATALOG_SCHEMA_VERSION;
  readonly signal_ref: Ref;
  readonly signal_name: string;
  readonly signal_source: RiskSignalSource;
  readonly risk_category: RiskCategory;
  readonly linked_risk_refs: readonly Ref[];
  readonly metric_kind: RiskSignalMetricKind;
  readonly threshold_value: number;
  readonly comparison: "greater_than" | "greater_or_equal" | "less_than" | "less_or_equal" | "equal";
  readonly dashboard_panel: RiskDashboardPanel;
  readonly response_hint: string;
  readonly determinism_hash: string;
}

export interface SignalEvaluation {
  readonly signal_ref: Ref;
  readonly observed_value: number;
  readonly triggered: boolean;
  readonly linked_risk_refs: readonly Ref[];
  readonly dashboard_panel: RiskDashboardPanel;
  readonly determinism_hash: string;
}

/**
 * Builds a validated signal definition for runtime or QA telemetry.
 */
export function buildRiskSignalCatalogEntry(input: RiskSignalCatalogEntryInput): RiskSignalCatalogEntry {
  const entry = normalizeRiskSignalCatalogEntry(input);
  const report = validateRiskSignalCatalogEntry(entry);
  if (!report.ok) {
    throw new RiskContractError("Risk signal catalog entry failed validation.", report.issues);
  }
  return entry;
}

export function normalizeRiskSignalCatalogEntry(input: RiskSignalCatalogEntryInput): RiskSignalCatalogEntry {
  const base = {
    schema_version: RISK_SIGNAL_CATALOG_SCHEMA_VERSION,
    signal_ref: input.signal_ref,
    signal_name: normalizeRiskText(input.signal_name, 180),
    signal_source: input.signal_source,
    risk_category: input.risk_category,
    linked_risk_refs: uniqueRiskRefs(input.linked_risk_refs),
    metric_kind: input.metric_kind,
    threshold_value: input.threshold_value,
    comparison: input.comparison,
    dashboard_panel: input.dashboard_panel,
    response_hint: normalizeRiskText(input.response_hint, 600),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateRiskSignalCatalogEntry(entry: RiskSignalCatalogEntry): RiskValidationReport {
  const issues: ValidationIssue[] = [];
  validateRiskRef(entry.signal_ref, "$.signal_ref", issues);
  validateRiskText(entry.signal_name, "$.signal_name", true, issues);
  validateRiskNonEmptyArray(entry.linked_risk_refs, "$.linked_risk_refs", "SignalRiskRefsMissing", issues);
  validateRiskRefs(entry.linked_risk_refs, "$.linked_risk_refs", issues);
  validateRiskText(entry.response_hint, "$.response_hint", true, issues);
  if (!Number.isFinite(entry.threshold_value)) {
    issues.push(riskIssue("error", "SignalThresholdInvalid", "$.threshold_value", "Signal threshold must be finite.", "Use a deterministic numeric threshold."));
  }
  return buildRiskValidationReport(makeRiskRef("risk_signal_report", entry.signal_ref), issues, riskRouteForIssues(issues));
}

export function evaluateRiskSignal(entry: RiskSignalCatalogEntry, observedValue: number): SignalEvaluation {
  const triggered = compareValue(observedValue, entry.threshold_value, entry.comparison);
  const base = {
    signal_ref: entry.signal_ref,
    observed_value: Number.isFinite(observedValue) ? observedValue : Number.NaN,
    triggered,
    linked_risk_refs: entry.linked_risk_refs,
    dashboard_panel: entry.dashboard_panel,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function defaultRiskSignalCatalog(): readonly RiskSignalCatalogEntry[] {
  return freezeRiskArray([
    signal("hidden_truth_prompt_rejection_count", "Hidden truth prompt rejection count", "provenance", "R-FWL", ["R-001", "R-002"], "count", 0, "greater_than", "critical_boundary", "Block prompt serialization and quarantine the artifact."),
    signal("success_without_certificate_count", "Completion without certificate count", "verification", "R-VER", ["R-003", "R-024", "R-027"], "count", 0, "greater_than", "critical_boundary", "Block completion route and open incident review."),
    signal("unsafe_proposal_rejection_rate", "Unsafe proposal rejection rate", "safety", "R-SAF", ["R-011", "R-032"], "rate", 0.05, "greater_than", "control_safety", "Escalate safety review and narrow correction scope."),
    signal("view_ambiguity_rate", "View ambiguity rate", "verification", "R-VER", ["R-010", "R-016", "R-028"], "rate", 0.25, "greater_than", "verification_health", "Replan views and tune sufficiency policy."),
    signal("memory_contamination_count", "Memory contamination count", "memory", "R-MEM", ["R-005", "R-033", "R-034"], "count", 0, "greater_than", "memory_integrity", "Quarantine memory and rebuild affected indexes."),
    signal("retry_budget_exhaustion_count", "Oops retry budget exhaustion count", "oops", "R-VER", ["R-029", "R-030"], "count", 0, "greater_than", "oops_recovery", "Terminate episode and route to HumanReview."),
    signal("audio_only_action_attempt_count", "Audio-only action attempt count", "audio", "R-AUD", ["R-007", "R-036"], "count", 0, "greater_than", "audio_reliability", "Block action and require visual or tactile evidence."),
    signal("release_blocker_count", "Release blocker count", "qa", "R-QA", ["R-027", "R-040", "R-043", "R-046"], "count", 0, "greater_than", "release_gate_status", "Keep release no-go until blockers are resolved."),
  ]);
}

function signal(
  signalRef: Ref,
  signalName: string,
  signalSource: RiskSignalSource,
  riskCategory: RiskCategory,
  linkedRiskRefs: readonly Ref[],
  metricKind: RiskSignalMetricKind,
  thresholdValue: number,
  comparison: RiskSignalCatalogEntry["comparison"],
  dashboardPanel: RiskDashboardPanel,
  responseHint: string,
): RiskSignalCatalogEntry {
  return buildRiskSignalCatalogEntry({
    signal_ref: signalRef,
    signal_name: signalName,
    signal_source: signalSource,
    risk_category: riskCategory,
    linked_risk_refs: linkedRiskRefs,
    metric_kind: metricKind,
    threshold_value: thresholdValue,
    comparison,
    dashboard_panel: dashboardPanel,
    response_hint: responseHint,
  });
}

function compareValue(observed: number, threshold: number, comparison: RiskSignalCatalogEntry["comparison"]): boolean {
  if (!Number.isFinite(observed) || !Number.isFinite(threshold)) {
    return false;
  }
  switch (comparison) {
    case "greater_than":
      return observed > threshold;
    case "greater_or_equal":
      return observed >= threshold;
    case "less_than":
      return observed < threshold;
    case "less_or_equal":
      return observed <= threshold;
    case "equal":
      return observed === threshold;
  }
}

export const RISK_SIGNAL_CATALOG_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: RISK_SIGNAL_CATALOG_SCHEMA_VERSION,
  blueprint: RISK_BLUEPRINT_REF,
  sections: freezeRiskArray(["22.6.1", "22.6.2"]),
  component: "RiskSignalCatalog",
});
