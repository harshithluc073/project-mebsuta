/**
 * Risk review scheduler.
 *
 * Blueprint: `architecture_docs/22_RISK_REGISTER_AND_MITIGATION_ARCHITECTURE.md`
 * sections 22.9.1, 22.9.2, and 22.9.3.
 *
 * Review scheduling translates cadence rules and blocker signals into concrete
 * next-review decisions with required inputs and escalation flags.
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

export const RISK_REVIEW_SCHEDULER_SCHEMA_VERSION = "mebsuta.risk.risk_review_scheduler.v1" as const;

export type RiskReviewKind = "critical_risk_review" | "safety_risk_review" | "prompt_model_risk_review" | "qa_risk_review" | "program_risk_review" | "release_risk_review";
export type RiskReviewCadence = "weekly" | "weekly_and_incident" | "weekly_during_integration" | "biweekly" | "before_milestone_exit";

export interface RiskReviewDefinitionInput {
  readonly review_ref: Ref;
  readonly review_kind: RiskReviewKind;
  readonly cadence: RiskReviewCadence;
  readonly focus: string;
  readonly covered_categories: readonly RiskCategory[];
  readonly required_input_refs: readonly Ref[];
  readonly escalation_criteria: readonly string[];
}

export interface RiskReviewDefinition {
  readonly schema_version: typeof RISK_REVIEW_SCHEDULER_SCHEMA_VERSION;
  readonly review_ref: Ref;
  readonly review_kind: RiskReviewKind;
  readonly cadence: RiskReviewCadence;
  readonly focus: string;
  readonly covered_categories: readonly RiskCategory[];
  readonly required_input_refs: readonly Ref[];
  readonly escalation_criteria: readonly string[];
  readonly determinism_hash: string;
}

export interface RiskReviewScheduleDecision {
  readonly decision_ref: Ref;
  readonly review_ref: Ref;
  readonly scheduled_for_iso: string;
  readonly missing_input_refs: readonly Ref[];
  readonly ready_for_review: boolean;
  readonly escalation_required: boolean;
  readonly reason: string;
  readonly determinism_hash: string;
}

/**
 * Builds a risk review definition from the architecture cadence table.
 */
export function buildRiskReviewDefinition(input: RiskReviewDefinitionInput): RiskReviewDefinition {
  const definition = normalizeRiskReviewDefinition(input);
  const report = validateRiskReviewDefinition(definition);
  if (!report.ok) {
    throw new RiskContractError("Risk review definition failed validation.", report.issues);
  }
  return definition;
}

export function normalizeRiskReviewDefinition(input: RiskReviewDefinitionInput): RiskReviewDefinition {
  const base = {
    schema_version: RISK_REVIEW_SCHEDULER_SCHEMA_VERSION,
    review_ref: input.review_ref,
    review_kind: input.review_kind,
    cadence: input.cadence,
    focus: normalizeRiskText(input.focus, 500),
    covered_categories: freezeRiskArray([...new Set(input.covered_categories)]),
    required_input_refs: uniqueRiskRefs(input.required_input_refs),
    escalation_criteria: uniqueRiskStrings(input.escalation_criteria),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateRiskReviewDefinition(definition: RiskReviewDefinition): RiskValidationReport {
  const issues: ValidationIssue[] = [];
  validateRiskRef(definition.review_ref, "$.review_ref", issues);
  validateRiskText(definition.focus, "$.focus", true, issues);
  validateRiskNonEmptyArray(definition.covered_categories, "$.covered_categories", "ReviewCategoriesMissing", issues);
  validateRiskNonEmptyArray(definition.required_input_refs, "$.required_input_refs", "ReviewInputsMissing", issues);
  validateRiskNonEmptyArray(definition.escalation_criteria, "$.escalation_criteria", "ReviewEscalationMissing", issues);
  validateRiskRefs(definition.required_input_refs, "$.required_input_refs", issues);
  if (definition.review_kind === "release_risk_review" && definition.cadence !== "before_milestone_exit") {
    issues.push(riskIssue("error", "ReleaseRiskCadenceInvalid", "$.cadence", "Release risk review must occur before milestone exit.", "Use before_milestone_exit cadence."));
  }
  return buildRiskValidationReport(makeRiskRef("risk_review_definition_report", definition.review_ref), issues, riskRouteForIssues(issues));
}

export function scheduleRiskReview(definition: RiskReviewDefinition, fromIso: string, availableInputRefs: readonly Ref[], activeBlockerRefs: readonly Ref[] = []): RiskReviewScheduleDecision {
  const from = new Date(fromIso);
  const fromMs = Number.isFinite(from.getTime()) ? from.getTime() : 0;
  const scheduled = new Date(fromMs + cadenceMs(definition.cadence, activeBlockerRefs.length > 0)).toISOString();
  const available = new Set(availableInputRefs);
  const missing = definition.required_input_refs.filter((ref) => !available.has(ref));
  const escalation = activeBlockerRefs.length > 0 || definition.escalation_criteria.some((criterion) => /critical|release|hidden truth|unsafe/iu.test(criterion));
  const base = {
    decision_ref: makeRiskRef("risk_review_schedule", definition.review_ref),
    review_ref: definition.review_ref,
    scheduled_for_iso: scheduled,
    missing_input_refs: uniqueRiskRefs(missing),
    ready_for_review: missing.length === 0,
    escalation_required: escalation && activeBlockerRefs.length > 0,
    reason: reviewReason(missing.length, activeBlockerRefs.length),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function defaultRiskReviewDefinitions(): readonly RiskReviewDefinition[] {
  return freezeRiskArray([
    review("critical_risk_review", "critical_risk_review", "weekly_and_incident", "R-001 through R-008 and any active blockers.", ["R-FWL", "R-QA", "R-VER", "R-SAF", "R-MEM", "R-MAN"], ["critical_risk_register", "incident_reports"], ["Any critical risk becomes a blocker.", "Hidden truth reaches runtime cognition."]),
    review("safety_risk_review", "safety_risk_review", "weekly", "SafeHold, force, tool, retry, and audio safety.", ["R-SAF", "R-CTL", "R-MAN", "R-AUD"], ["safety_reports", "safehold_events"], ["Unsafe execution occurs after rejection."]),
    review("prompt_model_risk_review", "prompt_model_risk_review", "weekly_during_integration", "Gemini drift, schema failures, unsafe outputs, and latency.", ["R-CGN"], ["prompt_regression_report", "schema_failure_metrics"], ["Model output drift affects release candidate."]),
    review("qa_risk_review", "qa_risk_review", "weekly", "Benchmark false successes, flakiness, replay gaps, and truth-boundary evidence.", ["R-QA", "R-OBS", "R-VER"], ["qa_reports", "replay_bundles"], ["False success appears in a release candidate benchmark."]),
    review("program_risk_review", "program_risk_review", "biweekly", "Schedule, staffing, dependency gates, and governance pressure.", ["R-OPS"], ["dependency_gate_status", "workstream_status"], ["Schedule pressure attempts to skip gates."]),
    review("release_risk_review", "release_risk_review", "before_milestone_exit", "Go/no-go by unresolved risk and release gate state.", ["R-QA", "R-SAF", "R-OPS"], ["release_risk_gate_report", "mitigation_coverage_report"], ["Any release no-go condition remains open."]),
  ]);
}

function review(reviewRef: Ref, kind: RiskReviewKind, cadence: RiskReviewCadence, focus: string, categories: readonly RiskCategory[], inputRefs: readonly Ref[], escalationCriteria: readonly string[]): RiskReviewDefinition {
  return buildRiskReviewDefinition({
    review_ref: reviewRef,
    review_kind: kind,
    cadence,
    focus,
    covered_categories: categories,
    required_input_refs: inputRefs,
    escalation_criteria: escalationCriteria,
  });
}

function cadenceMs(cadence: RiskReviewCadence, urgent: boolean): number {
  const day = 24 * 60 * 60 * 1000;
  if (urgent) {
    return day;
  }
  switch (cadence) {
    case "weekly":
    case "weekly_and_incident":
    case "weekly_during_integration":
    case "before_milestone_exit":
      return 7 * day;
    case "biweekly":
      return 14 * day;
  }
}

function reviewReason(missingCount: number, blockerCount: number): string {
  if (blockerCount > 0) {
    return `${blockerCount} active blocker refs require expedited risk review.`;
  }
  if (missingCount > 0) {
    return `${missingCount} required input refs are missing before review readiness.`;
  }
  return "Required inputs are present and review can proceed on cadence.";
}

export const RISK_REVIEW_SCHEDULER_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: RISK_REVIEW_SCHEDULER_SCHEMA_VERSION,
  blueprint: RISK_BLUEPRINT_REF,
  sections: freezeRiskArray(["22.9.1", "22.9.2", "22.9.3"]),
  component: "RiskReviewScheduler",
});
