/**
 * Milestone health report.
 *
 * Blueprint: `architecture_docs/21_ROADMAP_WBS_DELIVERY_AND_PROJECT_OPERATIONS.md`
 * sections 21.6, 21.8, 21.11, 21.12, 21.14, and 21.15.
 *
 * The health report aggregates WBS status, dependency gates, release train
 * state, QA signals, risk links, and operational readiness into deterministic
 * milestone health indicators.
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
  validateOperationsRatio,
  validateOperationsRef,
  validateOperationsRefs,
  validateOperationsText,
} from "./milestone_registry";
import type { MilestoneRef, OperationsValidationReport } from "./milestone_registry";
import type { GateReadinessDecision } from "./dependency_gate_registry";
import type { ReleaseTrainPlan } from "./release_train_planner";
import type { WbsTask, WbsTaskStatus } from "./wbs_task_catalog";

export const MILESTONE_HEALTH_REPORT_SCHEMA_VERSION = "mebsuta.operations.milestone_health_report.v1" as const;

export type MilestoneHealthStatus = "green" | "amber" | "red";
export type HealthIndicatorKind = "dependency_burn_down" | "qa_failures" | "safety_incidents" | "prompt_drift" | "architecture_drift" | "integration_cadence";

export interface HealthIndicator {
  readonly indicator_ref: Ref;
  readonly indicator_kind: HealthIndicatorKind;
  readonly status: MilestoneHealthStatus;
  readonly healthy_signal: string;
  readonly concerning_signal: string;
  readonly evidence_refs: readonly Ref[];
}

export interface MilestoneHealthInput {
  readonly health_report_ref: Ref;
  readonly milestone_ref: MilestoneRef;
  readonly generated_at_iso: string;
  readonly wbs_tasks: readonly WbsTask[];
  readonly gate_decisions: readonly GateReadinessDecision[];
  readonly release_plan?: ReleaseTrainPlan;
  readonly qa_signal_refs: readonly Ref[];
  readonly risk_refs: readonly Ref[];
  readonly operational_readiness_refs: readonly Ref[];
  readonly indicators: readonly HealthIndicator[];
}

export interface MilestoneHealthReport {
  readonly schema_version: typeof MILESTONE_HEALTH_REPORT_SCHEMA_VERSION;
  readonly health_report_ref: Ref;
  readonly milestone_ref: MilestoneRef;
  readonly generated_at_iso: string;
  readonly task_completion_ratio: number;
  readonly gate_green_ratio: number;
  readonly red_gate_count: number;
  readonly amber_gate_count: number;
  readonly release_decision: "ready" | "conditional" | "blocked" | "not_planned";
  readonly qa_signal_refs: readonly Ref[];
  readonly risk_refs: readonly Ref[];
  readonly operational_readiness_refs: readonly Ref[];
  readonly indicators: readonly HealthIndicator[];
  readonly overall_health: MilestoneHealthStatus;
  readonly recommended_actions: readonly string[];
  readonly determinism_hash: string;
}

/**
 * Builds a milestone health report with deterministic ratios and actions.
 */
export function buildMilestoneHealthReport(input: MilestoneHealthInput): MilestoneHealthReport {
  const report = normalizeMilestoneHealthReport(input);
  const validation = validateMilestoneHealthReport(report);
  if (!validation.ok) {
    throw new OperationsContractError("Milestone health report failed validation.", validation.issues);
  }
  return report;
}

export function normalizeMilestoneHealthReport(input: MilestoneHealthInput): MilestoneHealthReport {
  const taskCompletion = ratio(countTasksByStatus(input.wbs_tasks, "complete"), input.wbs_tasks.length);
  const greenGates = input.gate_decisions.filter((gate) => gate.status === "green").length;
  const redGates = input.gate_decisions.filter((gate) => gate.status === "red").length;
  const amberGates = input.gate_decisions.filter((gate) => gate.status === "amber" || gate.status === "not_evaluated").length;
  const gateGreenRatio = ratio(greenGates, input.gate_decisions.length);
  const indicators = freezeOperationsArray(input.indicators.map(normalizeHealthIndicator));
  const releaseDecision: MilestoneHealthReport["release_decision"] = input.release_plan?.decision ?? "not_planned";
  const overall = deriveOverallHealth(taskCompletion, redGates, amberGates, indicators, input.release_plan?.decision);
  const base = {
    schema_version: MILESTONE_HEALTH_REPORT_SCHEMA_VERSION,
    health_report_ref: input.health_report_ref,
    milestone_ref: input.milestone_ref,
    generated_at_iso: input.generated_at_iso,
    task_completion_ratio: taskCompletion,
    gate_green_ratio: gateGreenRatio,
    red_gate_count: redGates,
    amber_gate_count: amberGates,
    release_decision: releaseDecision,
    qa_signal_refs: uniqueOperationsRefs(input.qa_signal_refs),
    risk_refs: uniqueOperationsRefs(input.risk_refs),
    operational_readiness_refs: uniqueOperationsRefs(input.operational_readiness_refs),
    indicators,
    overall_health: overall,
    recommended_actions: recommendedActions(overall, redGates, amberGates, input.risk_refs.length, taskCompletion),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateMilestoneHealthReport(report: MilestoneHealthReport): OperationsValidationReport {
  const issues: ValidationIssue[] = [];
  validateOperationsRef(report.health_report_ref, "$.health_report_ref", issues);
  validateOperationsRef(report.milestone_ref, "$.milestone_ref", issues);
  validateOperationsRatio(report.task_completion_ratio, "$.task_completion_ratio", issues);
  validateOperationsRatio(report.gate_green_ratio, "$.gate_green_ratio", issues);
  validateOperationsRefs(report.qa_signal_refs, "$.qa_signal_refs", issues);
  validateOperationsRefs(report.risk_refs, "$.risk_refs", issues);
  validateOperationsRefs(report.operational_readiness_refs, "$.operational_readiness_refs", issues);
  validateOperationsNonEmptyArray(report.indicators, "$.indicators", "HealthIndicatorsMissing", issues);
  validateOperationsNonEmptyArray(report.recommended_actions, "$.recommended_actions", "RecommendedActionsMissing", issues);
  report.indicators.forEach((indicator, index) => validateHealthIndicator(indicator, `$.indicators[${index}]`, issues));
  report.recommended_actions.forEach((action, index) => validateOperationsText(action, `$.recommended_actions[${index}]`, true, issues));
  if (!Number.isFinite(new Date(report.generated_at_iso).getTime())) {
    issues.push(operationsIssue("error", "HealthGeneratedAtInvalid", "$.generated_at_iso", "Health report timestamp must be valid ISO.", "Use an ISO-8601 timestamp."));
  }
  if (report.red_gate_count > 0 && report.overall_health !== "red") {
    issues.push(operationsIssue("error", "RedGateHealthMismatch", "$.overall_health", "Any red gate requires red milestone health.", "Set overall health to red until gates recover."));
  }
  return buildOperationsValidationReport(makeOperationsRef("milestone_health_report", report.health_report_ref), issues, operationsRouteForIssues(issues));
}

export function countTasksByStatus(tasks: readonly WbsTask[], status: WbsTaskStatus): number {
  return tasks.filter((task) => task.status === status).length;
}

export function defaultHealthIndicators(evidenceRefs: readonly Ref[] = []): readonly HealthIndicator[] {
  return freezeOperationsArray([
    indicator("dependency_burn_down", "green", "Gate blockers close weekly.", "Same blocker persists across reviews.", evidenceRefs),
    indicator("qa_failures", "green", "Failures reproduce and are assigned.", "Flaky or unreplayable failures.", evidenceRefs),
    indicator("safety_incidents", "green", "Incidents are detected early and routed correctly.", "Undetected unsafe behavior.", evidenceRefs),
    indicator("prompt_drift", "green", "Schema validity remains stable.", "Rising repair or rejection rate.", evidenceRefs),
    indicator("architecture_drift", "green", "Docs update with implementation changes.", "Implementation decisions are not reflected.", evidenceRefs),
    indicator("integration_cadence", "green", "Frequent small integration.", "Large integration wave near milestone exit.", evidenceRefs),
  ]);
}

function normalizeHealthIndicator(indicatorItem: HealthIndicator): HealthIndicator {
  return Object.freeze({
    indicator_ref: indicatorItem.indicator_ref,
    indicator_kind: indicatorItem.indicator_kind,
    status: indicatorItem.status,
    healthy_signal: normalizeOperationsText(indicatorItem.healthy_signal, 500),
    concerning_signal: normalizeOperationsText(indicatorItem.concerning_signal, 500),
    evidence_refs: uniqueOperationsRefs(indicatorItem.evidence_refs),
  });
}

function validateHealthIndicator(indicatorItem: HealthIndicator, path: string, issues: ValidationIssue[]): void {
  validateOperationsRef(indicatorItem.indicator_ref, `${path}.indicator_ref`, issues);
  validateOperationsText(indicatorItem.healthy_signal, `${path}.healthy_signal`, true, issues);
  validateOperationsText(indicatorItem.concerning_signal, `${path}.concerning_signal`, true, issues);
  validateOperationsRefs(indicatorItem.evidence_refs, `${path}.evidence_refs`, issues);
}

function deriveOverallHealth(taskCompletion: number, redGates: number, amberGates: number, indicators: readonly HealthIndicator[], releaseDecision: "ready" | "conditional" | "blocked" | undefined): MilestoneHealthStatus {
  if (redGates > 0 || indicators.some((item) => item.status === "red") || releaseDecision === "blocked") {
    return "red";
  }
  if (amberGates > 0 || taskCompletion < 0.85 || indicators.some((item) => item.status === "amber") || releaseDecision === "conditional") {
    return "amber";
  }
  return "green";
}

function recommendedActions(overall: MilestoneHealthStatus, redGates: number, amberGates: number, riskCount: number, taskCompletion: number): readonly string[] {
  const actions: string[] = [];
  if (redGates > 0) {
    actions.push("Resolve red dependency gates before release review.");
  }
  if (amberGates > 0) {
    actions.push("Review amber gates and assign owners.");
  }
  if (riskCount > 0) {
    actions.push("Review linked risks and mitigation status.");
  }
  if (taskCompletion < 0.85) {
    actions.push("Focus active work on incomplete WBS tasks.");
  }
  if (actions.length === 0 && overall === "green") {
    actions.push("Maintain cadence and prepare milestone evidence bundle.");
  }
  return uniqueOperationsStrings(actions);
}

function indicator(kind: HealthIndicatorKind, status: MilestoneHealthStatus, healthySignal: string, concerningSignal: string, evidenceRefs: readonly Ref[]): HealthIndicator {
  return {
    indicator_ref: makeOperationsRef("indicator", kind),
    indicator_kind: kind,
    status,
    healthy_signal: healthySignal,
    concerning_signal: concerningSignal,
    evidence_refs: evidenceRefs,
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator <= 0 ? 0 : Math.max(0, Math.min(1, numerator / denominator));
}

export const MILESTONE_HEALTH_REPORT_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: MILESTONE_HEALTH_REPORT_SCHEMA_VERSION,
  blueprint: OPERATIONS_BLUEPRINT_REF,
  sections: freezeOperationsArray(["21.6", "21.8", "21.11", "21.12", "21.14", "21.15"]),
  component: "MilestoneHealthReport",
});
