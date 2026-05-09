/**
 * Performance reliability hardening contracts.
 *
 * Blueprints:
 * - `production_readiness_docs/15_PERFORMANCE_SCALING_AND_RELIABILITY_PLAN.md`
 * - `production_readiness_docs/12_OBSERVABILITY_LOGGING_TELEMETRY_PLAN.md`
 * - `production_readiness_docs/16_OPERATIONS_RUNBOOK_AND_INCIDENT_RESPONSE.md`
 * - `architecture_docs/20_QA_TESTING_CHAOS_AND_BENCHMARK_ARCHITECTURE.md`
 *
 * This PIT-B15 surface packages performance budgets, load and soak evidence,
 * timeout/backpressure/degradation behavior, and reliability evidence as typed
 * release-gate contracts. It does not create load runners, CI workflows,
 * deployment resources, or release-candidate packets.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";

export const PERFORMANCE_RELIABILITY_HARDENING_SCHEMA_VERSION = "mebsuta.performance.reliability_hardening.v1" as const;

export type PerformanceSubsystem =
  | "frontend"
  | "api"
  | "runtime"
  | "physics"
  | "control"
  | "model_queue"
  | "storage"
  | "event_stream"
  | "observability"
  | "qa_worker"
  | "replay_worker";

export type PerformanceBudgetClass =
  | "hard_safety_deadline"
  | "release_blocking_latency"
  | "degradation_threshold"
  | "operator_experience_budget"
  | "background_budget"
  | "offline_qa_budget";

export type PerformanceMetricKind =
  | "latency_ms"
  | "freshness_ms"
  | "jitter_ms"
  | "queue_depth"
  | "timeout_count"
  | "error_rate"
  | "replay_completeness_ratio"
  | "resource_utilization_ratio";

export type PerformanceEvidenceStatus = "green" | "amber" | "red";
export type PerformanceReleaseDecision = "go" | "conditional_go" | "no_go";
export type DegradationRoute = "continue" | "degrade_visible" | "shed_background" | "reobserve" | "human_review" | "safe_hold" | "release_block";

export interface PerformanceBudgetInput {
  readonly budget_ref: Ref;
  readonly subsystem: PerformanceSubsystem;
  readonly budget_class: PerformanceBudgetClass;
  readonly metric_kind: PerformanceMetricKind;
  readonly threshold_value: number;
  readonly warning_value?: number;
  readonly required_evidence_refs: readonly Ref[];
  readonly operator_summary: string;
}

export interface PerformanceBudget {
  readonly schema_version: typeof PERFORMANCE_RELIABILITY_HARDENING_SCHEMA_VERSION;
  readonly budget_ref: Ref;
  readonly subsystem: PerformanceSubsystem;
  readonly budget_class: PerformanceBudgetClass;
  readonly metric_kind: PerformanceMetricKind;
  readonly threshold_value: number;
  readonly warning_value?: number;
  readonly required_evidence_refs: readonly Ref[];
  readonly operator_summary: string;
  readonly determinism_hash: string;
}

export interface LatencyObservationInput {
  readonly observation_ref: Ref;
  readonly budget_ref: Ref;
  readonly observed_value: number;
  readonly sample_count: number;
  readonly evidence_refs: readonly Ref[];
  readonly operator_summary: string;
}

export interface LatencyBudgetEvaluation {
  readonly observation_ref: Ref;
  readonly budget_ref: Ref;
  readonly observed_value: number;
  readonly sample_count: number;
  readonly evidence_refs: readonly Ref[];
  readonly missing_evidence_refs: readonly Ref[];
  readonly status: PerformanceEvidenceStatus;
  readonly determinism_hash: string;
}

export interface LoadSoakEvidenceInput {
  readonly load_report_ref: Ref;
  readonly expected_session_count: number;
  readonly observed_session_count: number;
  readonly expected_duration_min: number;
  readonly observed_duration_min: number;
  readonly queue_saturation_events: number;
  readonly replay_completeness_ratio: number;
  readonly evidence_refs: readonly Ref[];
  readonly operator_summary: string;
}

export interface LoadSoakEvidenceReport {
  readonly load_report_ref: Ref;
  readonly expected_session_count: number;
  readonly observed_session_count: number;
  readonly expected_duration_min: number;
  readonly observed_duration_min: number;
  readonly queue_saturation_events: number;
  readonly replay_completeness_ratio: number;
  readonly evidence_refs: readonly Ref[];
  readonly status: PerformanceEvidenceStatus;
  readonly determinism_hash: string;
}

export interface TimeoutBackpressureInput {
  readonly backpressure_report_ref: Ref;
  readonly queue_ref: Ref;
  readonly max_queue_depth: number;
  readonly observed_queue_depth: number;
  readonly timeout_count: number;
  readonly retry_suppression_count: number;
  readonly load_shed_refs: readonly Ref[];
  readonly operator_summary: string;
}

export interface TimeoutBackpressureReport {
  readonly backpressure_report_ref: Ref;
  readonly queue_ref: Ref;
  readonly max_queue_depth: number;
  readonly observed_queue_depth: number;
  readonly timeout_count: number;
  readonly retry_suppression_count: number;
  readonly load_shed_refs: readonly Ref[];
  readonly status: PerformanceEvidenceStatus;
  readonly route: DegradationRoute;
  readonly determinism_hash: string;
}

export interface DegradationEvidenceInput {
  readonly degradation_ref: Ref;
  readonly trigger_ref: Ref;
  readonly observed_route: DegradationRoute;
  readonly expected_routes: readonly DegradationRoute[];
  readonly operator_visible: boolean;
  readonly evidence_preserved: boolean;
  readonly safety_preserved: boolean;
  readonly evidence_refs: readonly Ref[];
  readonly operator_summary: string;
}

export interface DegradationEvidenceReport {
  readonly degradation_ref: Ref;
  readonly trigger_ref: Ref;
  readonly observed_route: DegradationRoute;
  readonly expected_routes: readonly DegradationRoute[];
  readonly operator_visible: boolean;
  readonly evidence_preserved: boolean;
  readonly safety_preserved: boolean;
  readonly evidence_refs: readonly Ref[];
  readonly status: PerformanceEvidenceStatus;
  readonly determinism_hash: string;
}

export interface ReliabilityEvidenceInput {
  readonly reliability_report_ref: Ref;
  readonly safety_ack_rate: number;
  readonly replay_completeness_ratio: number;
  readonly audit_preservation_ratio: number;
  readonly boundary_violation_count: number;
  readonly unsafe_action_count: number;
  readonly memory_contamination_count: number;
  readonly evidence_refs: readonly Ref[];
  readonly operator_summary: string;
}

export interface ReliabilityEvidenceReport {
  readonly reliability_report_ref: Ref;
  readonly safety_ack_rate: number;
  readonly replay_completeness_ratio: number;
  readonly audit_preservation_ratio: number;
  readonly boundary_violation_count: number;
  readonly unsafe_action_count: number;
  readonly memory_contamination_count: number;
  readonly evidence_refs: readonly Ref[];
  readonly status: PerformanceEvidenceStatus;
  readonly determinism_hash: string;
}

export interface PerformanceReliabilityHardeningInput {
  readonly hardening_report_ref: Ref;
  readonly budgets: readonly PerformanceBudgetInput[];
  readonly latency_observations: readonly LatencyObservationInput[];
  readonly load_soak_evidence: LoadSoakEvidenceInput;
  readonly timeout_backpressure: TimeoutBackpressureInput;
  readonly degradation_evidence: readonly DegradationEvidenceInput[];
  readonly reliability_evidence: ReliabilityEvidenceInput;
  readonly operator_summary: string;
}

export interface PerformanceReliabilityHardeningReport {
  readonly schema_version: typeof PERFORMANCE_RELIABILITY_HARDENING_SCHEMA_VERSION;
  readonly hardening_report_ref: Ref;
  readonly budgets: readonly PerformanceBudget[];
  readonly latency_evaluations: readonly LatencyBudgetEvaluation[];
  readonly load_soak_evidence: LoadSoakEvidenceReport;
  readonly timeout_backpressure: TimeoutBackpressureReport;
  readonly degradation_evidence: readonly DegradationEvidenceReport[];
  readonly reliability_evidence: ReliabilityEvidenceReport;
  readonly no_go_conditions: readonly string[];
  readonly conditional_go_conditions: readonly string[];
  readonly decision: PerformanceReleaseDecision;
  readonly operator_summary: string;
  readonly determinism_hash: string;
}

export interface PerformanceReliabilityValidationReport {
  readonly report_ref: Ref;
  readonly ok: boolean;
  readonly issue_count: number;
  readonly error_count: number;
  readonly warning_count: number;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export function executePerformanceReliabilityHardening(input: PerformanceReliabilityHardeningInput): PerformanceReliabilityHardeningReport {
  const budgets = freezePerformanceArray(input.budgets.map(buildPerformanceBudget));
  const budgetByRef = new Map(budgets.map((budget) => [budget.budget_ref, budget]));
  const latencyEvaluations = freezePerformanceArray(input.latency_observations.map((observation) => evaluateLatencyBudget(observation, budgetByRef.get(observation.budget_ref))));
  const loadSoakEvidence = normalizeLoadSoakEvidence(input.load_soak_evidence);
  const timeoutBackpressure = normalizeTimeoutBackpressure(input.timeout_backpressure);
  const degradationEvidence = freezePerformanceArray(input.degradation_evidence.map(normalizeDegradationEvidence));
  const reliabilityEvidence = normalizeReliabilityEvidence(input.reliability_evidence);
  const noGoConditions = buildNoGoConditions(latencyEvaluations, loadSoakEvidence, timeoutBackpressure, degradationEvidence, reliabilityEvidence);
  const conditionalGoConditions = buildConditionalGoConditions(latencyEvaluations, loadSoakEvidence, timeoutBackpressure, degradationEvidence, reliabilityEvidence);
  const decision = derivePerformanceDecision(noGoConditions, conditionalGoConditions);
  const base = {
    schema_version: PERFORMANCE_RELIABILITY_HARDENING_SCHEMA_VERSION,
    hardening_report_ref: input.hardening_report_ref,
    budgets,
    latency_evaluations: latencyEvaluations,
    load_soak_evidence: loadSoakEvidence,
    timeout_backpressure: timeoutBackpressure,
    degradation_evidence: degradationEvidence,
    reliability_evidence: reliabilityEvidence,
    no_go_conditions: noGoConditions,
    conditional_go_conditions: conditionalGoConditions,
    decision,
    operator_summary: normalizePerformanceText(input.operator_summary, 900),
  };
  const report = Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  assertValidPerformanceReliabilityHardeningReport(report);
  return report;
}

export function buildPerformanceBudget(input: PerformanceBudgetInput): PerformanceBudget {
  const base = {
    schema_version: PERFORMANCE_RELIABILITY_HARDENING_SCHEMA_VERSION,
    budget_ref: input.budget_ref,
    subsystem: input.subsystem,
    budget_class: input.budget_class,
    metric_kind: input.metric_kind,
    threshold_value: input.threshold_value,
    warning_value: input.warning_value,
    required_evidence_refs: uniquePerformanceRefs(input.required_evidence_refs),
    operator_summary: normalizePerformanceText(input.operator_summary, 700),
  };
  const budget = Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  const validation = validatePerformanceBudget(budget);
  if (!validation.ok) {
    throw new PerformanceReliabilityContractError("Performance budget failed validation.", validation.issues);
  }
  return budget;
}

export function evaluateLatencyBudget(input: LatencyObservationInput, budget: PerformanceBudget | undefined): LatencyBudgetEvaluation {
  const evidenceRefs = uniquePerformanceRefs(input.evidence_refs);
  const missing = budget === undefined ? ["budget:missing"] : uniquePerformanceRefs(budget.required_evidence_refs.filter((ref) => !evidenceRefs.includes(ref)));
  const status: PerformanceEvidenceStatus = budget === undefined || missing.length > 0 || input.observed_value > budget.threshold_value || input.sample_count <= 0
    ? "red"
    : budget.warning_value !== undefined && input.observed_value > budget.warning_value
      ? "amber"
      : "green";
  const base = {
    observation_ref: input.observation_ref,
    budget_ref: input.budget_ref,
    observed_value: input.observed_value,
    sample_count: input.sample_count,
    evidence_refs: evidenceRefs,
    missing_evidence_refs: missing,
    status,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function normalizeLoadSoakEvidence(input: LoadSoakEvidenceInput): LoadSoakEvidenceReport {
  const status: PerformanceEvidenceStatus = input.observed_session_count < input.expected_session_count ||
    input.observed_duration_min < input.expected_duration_min ||
    input.queue_saturation_events > 0 ||
    input.replay_completeness_ratio < 0.95 ||
    input.evidence_refs.length === 0
    ? "red"
    : input.replay_completeness_ratio < 0.99
      ? "amber"
      : "green";
  const base = {
    load_report_ref: input.load_report_ref,
    expected_session_count: input.expected_session_count,
    observed_session_count: input.observed_session_count,
    expected_duration_min: input.expected_duration_min,
    observed_duration_min: input.observed_duration_min,
    queue_saturation_events: input.queue_saturation_events,
    replay_completeness_ratio: clampRatio(input.replay_completeness_ratio),
    evidence_refs: uniquePerformanceRefs(input.evidence_refs),
    status,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function normalizeTimeoutBackpressure(input: TimeoutBackpressureInput): TimeoutBackpressureReport {
  const status: PerformanceEvidenceStatus = input.observed_queue_depth > input.max_queue_depth || input.timeout_count > 0
    ? "red"
    : input.retry_suppression_count > 0 || input.load_shed_refs.length > 0
      ? "amber"
      : "green";
  const route: DegradationRoute = status === "red"
    ? "release_block"
    : status === "amber"
      ? "shed_background"
      : "continue";
  const base = {
    backpressure_report_ref: input.backpressure_report_ref,
    queue_ref: input.queue_ref,
    max_queue_depth: input.max_queue_depth,
    observed_queue_depth: input.observed_queue_depth,
    timeout_count: input.timeout_count,
    retry_suppression_count: input.retry_suppression_count,
    load_shed_refs: uniquePerformanceRefs(input.load_shed_refs),
    status,
    route,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function normalizeDegradationEvidence(input: DegradationEvidenceInput): DegradationEvidenceReport {
  const expectedRouteMatched = input.expected_routes.includes(input.observed_route);
  const status: PerformanceEvidenceStatus = !expectedRouteMatched || !input.safety_preserved || !input.evidence_preserved || input.evidence_refs.length === 0
    ? "red"
    : !input.operator_visible
      ? "amber"
      : "green";
  const base = {
    degradation_ref: input.degradation_ref,
    trigger_ref: input.trigger_ref,
    observed_route: input.observed_route,
    expected_routes: freezePerformanceArray([...new Set(input.expected_routes)]),
    operator_visible: input.operator_visible,
    evidence_preserved: input.evidence_preserved,
    safety_preserved: input.safety_preserved,
    evidence_refs: uniquePerformanceRefs(input.evidence_refs),
    status,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function normalizeReliabilityEvidence(input: ReliabilityEvidenceInput): ReliabilityEvidenceReport {
  const status: PerformanceEvidenceStatus = input.safety_ack_rate < 1 ||
    input.replay_completeness_ratio < 0.95 ||
    input.audit_preservation_ratio < 1 ||
    input.boundary_violation_count > 0 ||
    input.unsafe_action_count > 0 ||
    input.memory_contamination_count > 0 ||
    input.evidence_refs.length === 0
    ? "red"
    : input.replay_completeness_ratio < 0.99
      ? "amber"
      : "green";
  const base = {
    reliability_report_ref: input.reliability_report_ref,
    safety_ack_rate: clampRatio(input.safety_ack_rate),
    replay_completeness_ratio: clampRatio(input.replay_completeness_ratio),
    audit_preservation_ratio: clampRatio(input.audit_preservation_ratio),
    boundary_violation_count: input.boundary_violation_count,
    unsafe_action_count: input.unsafe_action_count,
    memory_contamination_count: input.memory_contamination_count,
    evidence_refs: uniquePerformanceRefs(input.evidence_refs),
    status,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validatePerformanceReliabilityHardeningReport(report: PerformanceReliabilityHardeningReport): PerformanceReliabilityValidationReport {
  const issues: ValidationIssue[] = [];
  validatePerformanceRef(report.hardening_report_ref, "$.hardening_report_ref", issues);
  validatePerformanceText(report.operator_summary, "$.operator_summary", true, issues);
  report.budgets.forEach((budget, index) => validatePerformanceBudgetInto(budget, `$.budgets[${index}]`, issues));
  if (report.budgets.length === 0) {
    issues.push(performanceIssue("error", "PerformanceBudgetsMissing", "$.budgets", "At least one performance budget is required.", "Attach subsystem budgets before evaluating reliability."));
  }
  if (report.no_go_conditions.length > 0 && report.decision !== "no_go") {
    issues.push(performanceIssue("error", "PerformanceNoGoDecisionMismatch", "$.decision", "No-go performance conditions require no_go decision.", "Keep release blocked until red evidence is resolved."));
  }
  if (report.conditional_go_conditions.length > 0 && report.decision === "go") {
    issues.push(performanceIssue("error", "PerformanceConditionalDecisionMismatch", "$.decision", "Conditional performance conditions cannot produce go decision.", "Use conditional_go or resolve amber evidence."));
  }
  return buildPerformanceValidationReport(makePerformanceRef("hardening_report", report.hardening_report_ref), issues);
}

export function assertValidPerformanceReliabilityHardeningReport(report: PerformanceReliabilityHardeningReport): void {
  const validation = validatePerformanceReliabilityHardeningReport(report);
  if (!validation.ok) {
    throw new PerformanceReliabilityContractError("Performance reliability hardening report failed validation.", validation.issues);
  }
}

export function validatePerformanceBudget(budget: PerformanceBudget): PerformanceReliabilityValidationReport {
  const issues: ValidationIssue[] = [];
  validatePerformanceBudgetInto(budget, "$", issues);
  return buildPerformanceValidationReport(makePerformanceRef("budget", budget.budget_ref), issues);
}

export function derivePerformanceDecision(noGoConditions: readonly string[], conditionalGoConditions: readonly string[]): PerformanceReleaseDecision {
  if (noGoConditions.length > 0) return "no_go";
  if (conditionalGoConditions.length > 0) return "conditional_go";
  return "go";
}

function buildNoGoConditions(
  latency: readonly LatencyBudgetEvaluation[],
  loadSoak: LoadSoakEvidenceReport,
  timeoutBackpressure: TimeoutBackpressureReport,
  degradations: readonly DegradationEvidenceReport[],
  reliability: ReliabilityEvidenceReport,
): readonly string[] {
  const conditions: string[] = [];
  if (latency.some((item) => item.status === "red")) conditions.push("performance_budget_red");
  if (loadSoak.status === "red") conditions.push("load_soak_evidence_red");
  if (timeoutBackpressure.status === "red") conditions.push("timeout_backpressure_red");
  if (degradations.some((item) => item.status === "red")) conditions.push("degradation_route_red");
  if (reliability.status === "red") conditions.push("reliability_evidence_red");
  return uniquePerformanceStrings(conditions);
}

function buildConditionalGoConditions(
  latency: readonly LatencyBudgetEvaluation[],
  loadSoak: LoadSoakEvidenceReport,
  timeoutBackpressure: TimeoutBackpressureReport,
  degradations: readonly DegradationEvidenceReport[],
  reliability: ReliabilityEvidenceReport,
): readonly string[] {
  const conditions: string[] = [];
  if (latency.some((item) => item.status === "amber")) conditions.push("performance_budget_review");
  if (loadSoak.status === "amber") conditions.push("load_soak_review");
  if (timeoutBackpressure.status === "amber") conditions.push("backpressure_degraded_mode_review");
  if (degradations.some((item) => item.status === "amber")) conditions.push("degradation_visibility_review");
  if (reliability.status === "amber") conditions.push("reliability_replay_review");
  return uniquePerformanceStrings(conditions);
}

function validatePerformanceBudgetInto(budget: PerformanceBudget, path: string, issues: ValidationIssue[]): void {
  validatePerformanceRef(budget.budget_ref, `${path}.budget_ref`, issues);
  validatePerformanceText(budget.operator_summary, `${path}.operator_summary`, true, issues);
  validatePerformanceRefs(budget.required_evidence_refs, `${path}.required_evidence_refs`, issues);
  if (budget.required_evidence_refs.length === 0) {
    issues.push(performanceIssue("error", "BudgetEvidenceMissing", `${path}.required_evidence_refs`, "Budget evaluation requires evidence refs.", "Attach telemetry, replay, benchmark, or release evidence refs."));
  }
  if (!Number.isFinite(budget.threshold_value) || budget.threshold_value < 0) {
    issues.push(performanceIssue("error", "BudgetThresholdInvalid", `${path}.threshold_value`, "Budget threshold must be finite and nonnegative.", "Use a finite threshold value."));
  }
  if (budget.warning_value !== undefined && (!Number.isFinite(budget.warning_value) || budget.warning_value < 0 || budget.warning_value > budget.threshold_value)) {
    issues.push(performanceIssue("error", "BudgetWarningInvalid", `${path}.warning_value`, "Budget warning must be finite, nonnegative, and no greater than threshold.", "Set warning at or below the release threshold."));
  }
  if (budget.budget_class === "hard_safety_deadline" && budget.metric_kind !== "latency_ms" && budget.metric_kind !== "jitter_ms") {
    issues.push(performanceIssue("error", "SafetyDeadlineMetricInvalid", `${path}.metric_kind`, "Hard safety deadlines must evaluate latency or jitter.", "Use latency_ms or jitter_ms for safety deadlines."));
  }
}

export class PerformanceReliabilityContractError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "PerformanceReliabilityContractError";
    this.issues = freezePerformanceArray(issues);
  }
}

export function buildPerformanceValidationReport(reportRef: Ref, issues: readonly ValidationIssue[]): PerformanceReliabilityValidationReport {
  const frozenIssues = freezePerformanceArray(issues);
  const errorCount = frozenIssues.filter((issue) => issue.severity === "error").length;
  const warningCount = frozenIssues.length - errorCount;
  const base = {
    report_ref: reportRef,
    ok: errorCount === 0,
    issue_count: frozenIssues.length,
    error_count: errorCount,
    warning_count: warningCount,
    issues: frozenIssues,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function performanceIssue(severity: ValidationSeverity, code: string, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

export function validatePerformanceRef(ref: Ref | undefined, path: string, issues: ValidationIssue[]): void {
  if (ref === undefined || ref.trim().length === 0 || /\s/u.test(ref)) {
    issues.push(performanceIssue("error", "PerformanceRefInvalid", path, "Reference must be present, non-empty, and whitespace-free.", "Use a stable opaque performance ref."));
  }
}

export function validatePerformanceRefs(refs: readonly Ref[], path: string, issues: ValidationIssue[]): void {
  refs.forEach((ref, index) => validatePerformanceRef(ref, `${path}[${index}]`, issues));
}

export function validatePerformanceText(value: string, path: string, required: boolean, issues: ValidationIssue[]): void {
  if (required && value.trim().length === 0) {
    issues.push(performanceIssue("error", "PerformanceTextRequired", path, "Required performance text is empty.", "Provide concise performance evidence text."));
  }
  if (/reward\s*update|policy\s*gradient|ignore\s*safety/iu.test(value)) {
    issues.push(performanceIssue("error", "PerformanceTextForbidden", path, "Performance text contains forbidden governance wording.", "Use no-RL and safety-preserving wording."));
  }
}

export function normalizePerformanceText(value: string, maxChars = 1000): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, maxChars);
}

export function makePerformanceRef(...parts: readonly (string | number | undefined)[]): Ref {
  const normalized = parts
    .filter((part): part is string | number => part !== undefined)
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return normalized.length > 0 ? `performance:${normalized}` : "performance:empty";
}

export function uniquePerformanceRefs(items: readonly (Ref | undefined)[]): readonly Ref[] {
  return freezePerformanceArray([...new Set(items.filter((item): item is Ref => item !== undefined && item.trim().length > 0))]);
}

export function uniquePerformanceStrings(items: readonly string[]): readonly string[] {
  return freezePerformanceArray([...new Set(items.map((item) => normalizePerformanceText(item)).filter((item) => item.length > 0))]);
}

export function freezePerformanceArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

function clampRatio(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

export const PERFORMANCE_RELIABILITY_HARDENING_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: PERFORMANCE_RELIABILITY_HARDENING_SCHEMA_VERSION,
  blueprints: freezePerformanceArray([
    "production_readiness_docs/15_PERFORMANCE_SCALING_AND_RELIABILITY_PLAN.md",
    "production_readiness_docs/12_OBSERVABILITY_LOGGING_TELEMETRY_PLAN.md",
    "production_readiness_docs/16_OPERATIONS_RUNBOOK_AND_INCIDENT_RESPONSE.md",
    "architecture_docs/20_QA_TESTING_CHAOS_AND_BENCHMARK_ARCHITECTURE.md",
  ]),
  component: "PerformanceReliabilityHardening",
});
