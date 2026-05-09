/**
 * Operations incident and risk tooling contracts.
 *
 * Blueprints:
 * - `production_readiness_docs/16_OPERATIONS_RUNBOOK_AND_INCIDENT_RESPONSE.md`
 * - `production_readiness_docs/17_PRODUCTION_RISK_REGISTER.md`
 * - `architecture_docs/21_ROADMAP_WBS_DELIVERY_AND_PROJECT_OPERATIONS.md`
 * - `architecture_docs/22_RISK_REGISTER_AND_MITIGATION_ARCHITECTURE.md`
 *
 * This PIT-B14 surface validates incident lifecycle evidence, runbook
 * execution, on-call and review coverage, risk gate decisions, accepted
 * limitations, risk board projection, and release resumption readiness without
 * creating production APIs, storage, dashboards, or deployment resources.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import type { OperationalRunbook } from "./operational_runbook_registry";
import type { ReviewCadence, ReviewScheduleDecision } from "./review_cadence_scheduler";
import { scheduleNextReview } from "./review_cadence_scheduler";
import type { RiskRegisterEntry } from "../risk/risk_register_entry";
import type { ReleaseRiskGateReport } from "../risk/release_risk_gate_evaluator";
import { releaseGateReady } from "../risk/release_risk_gate_evaluator";

export const OPERATIONS_INCIDENT_RISK_TOOLING_SCHEMA_VERSION = "mebsuta.operations.incident_risk_tooling.v1" as const;

export type OperationsIncidentSeverity = "sev0" | "sev1" | "sev2" | "sev3";
export type OperationsIncidentStatus = "detected" | "classified" | "stabilized" | "evidence_preserved" | "mitigated" | "validated" | "closed";
export type OperationsIncidentRoute = "safe_hold" | "human_review" | "release_block" | "mitigate" | "monitor";
export type OperationsEvidenceStatus = "green" | "amber" | "red";
export type OperationsResumptionDecision = "resume" | "conditional_resume" | "blocked";
export type RiskAcceptanceDecision = "accepted" | "requires_review" | "rejected" | "expired";

export interface OperationsIncidentLifecycleInput {
  readonly incident_ref: Ref;
  readonly severity: OperationsIncidentSeverity;
  readonly status: OperationsIncidentStatus;
  readonly detected_at_iso: string;
  readonly owner_role_refs: readonly Ref[];
  readonly affected_surface_refs: readonly Ref[];
  readonly required_evidence_refs: readonly Ref[];
  readonly preserved_evidence_refs: readonly Ref[];
  readonly runbook_ref: Ref;
  readonly safehold_required: boolean;
  readonly safehold_evidence_refs: readonly Ref[];
  readonly release_impacting: boolean;
  readonly operator_summary: string;
}

export interface OperationsIncidentLifecycle {
  readonly schema_version: typeof OPERATIONS_INCIDENT_RISK_TOOLING_SCHEMA_VERSION;
  readonly incident_ref: Ref;
  readonly severity: OperationsIncidentSeverity;
  readonly status: OperationsIncidentStatus;
  readonly detected_at_iso: string;
  readonly owner_role_refs: readonly Ref[];
  readonly affected_surface_refs: readonly Ref[];
  readonly required_evidence_refs: readonly Ref[];
  readonly preserved_evidence_refs: readonly Ref[];
  readonly missing_evidence_refs: readonly Ref[];
  readonly runbook_ref: Ref;
  readonly safehold_required: boolean;
  readonly safehold_evidence_refs: readonly Ref[];
  readonly release_impacting: boolean;
  readonly route_decision: OperationsIncidentRoute;
  readonly closure_ready: boolean;
  readonly operator_summary: string;
  readonly determinism_hash: string;
}

export interface RunbookExecutionInput {
  readonly execution_ref: Ref;
  readonly incident_ref: Ref;
  readonly runbook: OperationalRunbook;
  readonly required_step_refs: readonly Ref[];
  readonly completed_step_refs: readonly Ref[];
  readonly evidence_refs: readonly Ref[];
  readonly reviewer_refs: readonly Ref[];
  readonly operator_summary: string;
}

export interface RunbookExecutionReport {
  readonly schema_version: typeof OPERATIONS_INCIDENT_RISK_TOOLING_SCHEMA_VERSION;
  readonly execution_ref: Ref;
  readonly incident_ref: Ref;
  readonly runbook_ref: Ref;
  readonly required_step_refs: readonly Ref[];
  readonly completed_step_refs: readonly Ref[];
  readonly missing_step_refs: readonly Ref[];
  readonly evidence_refs: readonly Ref[];
  readonly missing_runbook_evidence_refs: readonly Ref[];
  readonly reviewer_refs: readonly Ref[];
  readonly status: OperationsEvidenceStatus;
  readonly operator_summary: string;
  readonly determinism_hash: string;
}

export interface OnCallCoverageInput {
  readonly coverage_ref: Ref;
  readonly active_window_ref: Ref;
  readonly primary_responder_refs: readonly Ref[];
  readonly secondary_responder_refs: readonly Ref[];
  readonly escalation_owner_refs: readonly Ref[];
  readonly review_cadences: readonly ReviewCadence[];
  readonly available_review_input_refs: readonly Ref[];
  readonly scheduled_from_iso: string;
  readonly operator_summary: string;
}

export interface OnCallCoverageReport {
  readonly schema_version: typeof OPERATIONS_INCIDENT_RISK_TOOLING_SCHEMA_VERSION;
  readonly coverage_ref: Ref;
  readonly active_window_ref: Ref;
  readonly primary_responder_refs: readonly Ref[];
  readonly secondary_responder_refs: readonly Ref[];
  readonly escalation_owner_refs: readonly Ref[];
  readonly review_schedule_decisions: readonly ReviewScheduleDecision[];
  readonly missing_review_input_refs: readonly Ref[];
  readonly status: OperationsEvidenceStatus;
  readonly operator_summary: string;
  readonly determinism_hash: string;
}

export interface RiskAcceptanceInput {
  readonly acceptance_ref: Ref;
  readonly risk_ref: Ref;
  readonly owner_ref: Ref;
  readonly accepted_limitation_ref: Ref;
  readonly evidence_refs: readonly Ref[];
  readonly release_scope_refs: readonly Ref[];
  readonly expires_at_iso: string;
  readonly evaluated_at_iso: string;
  readonly revoked: boolean;
  readonly operator_summary: string;
}

export interface RiskAcceptanceRecord {
  readonly schema_version: typeof OPERATIONS_INCIDENT_RISK_TOOLING_SCHEMA_VERSION;
  readonly acceptance_ref: Ref;
  readonly risk_ref: Ref;
  readonly owner_ref: Ref;
  readonly accepted_limitation_ref: Ref;
  readonly evidence_refs: readonly Ref[];
  readonly release_scope_refs: readonly Ref[];
  readonly expires_at_iso: string;
  readonly evaluated_at_iso: string;
  readonly revoked: boolean;
  readonly decision: RiskAcceptanceDecision;
  readonly operator_summary: string;
  readonly determinism_hash: string;
}

export interface RiskBoardProjection {
  readonly schema_version: typeof OPERATIONS_INCIDENT_RISK_TOOLING_SCHEMA_VERSION;
  readonly projection_ref: Ref;
  readonly total_risk_count: number;
  readonly blocker_risk_refs: readonly Ref[];
  readonly accepted_risk_refs: readonly Ref[];
  readonly monitored_risk_refs: readonly Ref[];
  readonly stale_acceptance_refs: readonly Ref[];
  readonly release_blocker_count: number;
  readonly determinism_hash: string;
}

export interface ReleaseResumptionInput {
  readonly resumption_ref: Ref;
  readonly incident: OperationsIncidentLifecycleInput;
  readonly runbook_execution: RunbookExecutionInput;
  readonly on_call_coverage: OnCallCoverageInput;
  readonly release_risk_gate_report: ReleaseRiskGateReport;
  readonly risk_acceptances: readonly RiskAcceptanceInput[];
  readonly risk_register_entries: readonly RiskRegisterEntry[];
  readonly required_resumption_evidence_refs: readonly Ref[];
  readonly observed_resumption_evidence_refs: readonly Ref[];
  readonly operator_summary: string;
}

export interface ReleaseResumptionReport {
  readonly schema_version: typeof OPERATIONS_INCIDENT_RISK_TOOLING_SCHEMA_VERSION;
  readonly resumption_ref: Ref;
  readonly incident: OperationsIncidentLifecycle;
  readonly runbook_execution: RunbookExecutionReport;
  readonly on_call_coverage: OnCallCoverageReport;
  readonly release_risk_gate_report: ReleaseRiskGateReport;
  readonly risk_acceptances: readonly RiskAcceptanceRecord[];
  readonly risk_board_projection: RiskBoardProjection;
  readonly required_resumption_evidence_refs: readonly Ref[];
  readonly observed_resumption_evidence_refs: readonly Ref[];
  readonly missing_resumption_evidence_refs: readonly Ref[];
  readonly no_go_conditions: readonly string[];
  readonly conditional_conditions: readonly string[];
  readonly decision: OperationsResumptionDecision;
  readonly operator_summary: string;
  readonly determinism_hash: string;
}

export interface OperationsIncidentRiskValidationReport {
  readonly report_ref: Ref;
  readonly ok: boolean;
  readonly issue_count: number;
  readonly error_count: number;
  readonly warning_count: number;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export function executeOperationsIncidentRiskTooling(input: ReleaseResumptionInput): ReleaseResumptionReport {
  const incident = normalizeOperationsIncidentLifecycle(input.incident);
  const runbookExecution = normalizeRunbookExecutionReport(input.runbook_execution);
  const onCallCoverage = normalizeOnCallCoverageReport(input.on_call_coverage);
  const riskAcceptances = freezeOperationsIncidentArray(input.risk_acceptances.map(normalizeRiskAcceptanceRecord));
  const riskBoardProjection = projectRiskBoard(makeOperationsIncidentRef("risk_board", input.resumption_ref), input.risk_register_entries, riskAcceptances);
  const required = uniqueOperationsIncidentRefs(input.required_resumption_evidence_refs);
  const observed = uniqueOperationsIncidentRefs(input.observed_resumption_evidence_refs);
  const observedSet = new Set(observed);
  const missing = uniqueOperationsIncidentRefs(required.filter((ref) => !observedSet.has(ref)));
  const noGoConditions = buildNoGoConditions(incident, runbookExecution, onCallCoverage, input.release_risk_gate_report, riskBoardProjection, missing);
  const conditionalConditions = buildConditionalConditions(runbookExecution, onCallCoverage, riskAcceptances, input.release_risk_gate_report);
  const decision = deriveResumptionDecision(noGoConditions, conditionalConditions);
  const base = {
    schema_version: OPERATIONS_INCIDENT_RISK_TOOLING_SCHEMA_VERSION,
    resumption_ref: input.resumption_ref,
    incident,
    runbook_execution: runbookExecution,
    on_call_coverage: onCallCoverage,
    release_risk_gate_report: input.release_risk_gate_report,
    risk_acceptances: riskAcceptances,
    risk_board_projection: riskBoardProjection,
    required_resumption_evidence_refs: required,
    observed_resumption_evidence_refs: observed,
    missing_resumption_evidence_refs: missing,
    no_go_conditions: noGoConditions,
    conditional_conditions: conditionalConditions,
    decision,
    operator_summary: normalizeOperationsIncidentText(input.operator_summary, 900),
  };
  const report = Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  assertValidReleaseResumptionReport(report);
  return report;
}

export function normalizeOperationsIncidentLifecycle(input: OperationsIncidentLifecycleInput): OperationsIncidentLifecycle {
  const required = uniqueOperationsIncidentRefs(input.required_evidence_refs);
  const preserved = uniqueOperationsIncidentRefs(input.preserved_evidence_refs);
  const preservedSet = new Set(preserved);
  const missing = uniqueOperationsIncidentRefs(required.filter((ref) => !preservedSet.has(ref)));
  const routeDecision = routeIncident(input, missing);
  const closureReady = input.status === "closed" && missing.length === 0 && (!input.safehold_required || input.safehold_evidence_refs.length > 0);
  const base = {
    schema_version: OPERATIONS_INCIDENT_RISK_TOOLING_SCHEMA_VERSION,
    incident_ref: input.incident_ref,
    severity: input.severity,
    status: input.status,
    detected_at_iso: input.detected_at_iso,
    owner_role_refs: uniqueOperationsIncidentRefs(input.owner_role_refs),
    affected_surface_refs: uniqueOperationsIncidentRefs(input.affected_surface_refs),
    required_evidence_refs: required,
    preserved_evidence_refs: preserved,
    missing_evidence_refs: missing,
    runbook_ref: input.runbook_ref,
    safehold_required: input.safehold_required,
    safehold_evidence_refs: uniqueOperationsIncidentRefs(input.safehold_evidence_refs),
    release_impacting: input.release_impacting,
    route_decision: routeDecision,
    closure_ready: closureReady,
    operator_summary: normalizeOperationsIncidentText(input.operator_summary, 900),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function normalizeRunbookExecutionReport(input: RunbookExecutionInput): RunbookExecutionReport {
  const requiredSteps = uniqueOperationsIncidentRefs(input.required_step_refs);
  const completedSteps = uniqueOperationsIncidentRefs(input.completed_step_refs);
  const completedSet = new Set(completedSteps);
  const missingSteps = uniqueOperationsIncidentRefs(requiredSteps.filter((ref) => !completedSet.has(ref)));
  const evidenceRefs = uniqueOperationsIncidentRefs(input.evidence_refs);
  const evidenceSet = new Set(evidenceRefs);
  const missingRunbookEvidence = uniqueOperationsIncidentRefs(input.runbook.evidence_refs.filter((ref) => !evidenceSet.has(ref)));
  const status: OperationsEvidenceStatus = missingSteps.length > 0 || missingRunbookEvidence.length > 0
    ? "red"
    : input.reviewer_refs.length === 0
      ? "amber"
      : "green";
  const base = {
    schema_version: OPERATIONS_INCIDENT_RISK_TOOLING_SCHEMA_VERSION,
    execution_ref: input.execution_ref,
    incident_ref: input.incident_ref,
    runbook_ref: input.runbook.runbook_ref,
    required_step_refs: requiredSteps,
    completed_step_refs: completedSteps,
    missing_step_refs: missingSteps,
    evidence_refs: evidenceRefs,
    missing_runbook_evidence_refs: missingRunbookEvidence,
    reviewer_refs: uniqueOperationsIncidentRefs(input.reviewer_refs),
    status,
    operator_summary: normalizeOperationsIncidentText(input.operator_summary, 900),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function normalizeOnCallCoverageReport(input: OnCallCoverageInput): OnCallCoverageReport {
  const scheduleDecisions = freezeOperationsIncidentArray(input.review_cadences.map((cadence) => scheduleNextReview(cadence, input.scheduled_from_iso, input.available_review_input_refs)));
  const missingInputs = uniqueOperationsIncidentRefs(scheduleDecisions.flatMap((decision) => decision.missing_input_refs));
  const primary = uniqueOperationsIncidentRefs(input.primary_responder_refs);
  const secondary = uniqueOperationsIncidentRefs(input.secondary_responder_refs);
  const escalation = uniqueOperationsIncidentRefs(input.escalation_owner_refs);
  const status: OperationsEvidenceStatus = primary.length === 0 || escalation.length === 0 || missingInputs.length > 0
    ? "red"
    : secondary.length === 0
      ? "amber"
      : "green";
  const base = {
    schema_version: OPERATIONS_INCIDENT_RISK_TOOLING_SCHEMA_VERSION,
    coverage_ref: input.coverage_ref,
    active_window_ref: input.active_window_ref,
    primary_responder_refs: primary,
    secondary_responder_refs: secondary,
    escalation_owner_refs: escalation,
    review_schedule_decisions: scheduleDecisions,
    missing_review_input_refs: missingInputs,
    status,
    operator_summary: normalizeOperationsIncidentText(input.operator_summary, 900),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function normalizeRiskAcceptanceRecord(input: RiskAcceptanceInput): RiskAcceptanceRecord {
  const expiresMs = new Date(input.expires_at_iso).getTime();
  const evaluatedMs = new Date(input.evaluated_at_iso).getTime();
  const evidenceRefs = uniqueOperationsIncidentRefs(input.evidence_refs);
  const scopeRefs = uniqueOperationsIncidentRefs(input.release_scope_refs);
  const decision: RiskAcceptanceDecision = input.revoked
    ? "rejected"
    : !Number.isFinite(expiresMs) || !Number.isFinite(evaluatedMs)
      ? "requires_review"
      : expiresMs <= evaluatedMs
        ? "expired"
        : evidenceRefs.length === 0 || scopeRefs.length === 0
          ? "requires_review"
          : "accepted";
  const base = {
    schema_version: OPERATIONS_INCIDENT_RISK_TOOLING_SCHEMA_VERSION,
    acceptance_ref: input.acceptance_ref,
    risk_ref: input.risk_ref,
    owner_ref: input.owner_ref,
    accepted_limitation_ref: input.accepted_limitation_ref,
    evidence_refs: evidenceRefs,
    release_scope_refs: scopeRefs,
    expires_at_iso: input.expires_at_iso,
    evaluated_at_iso: input.evaluated_at_iso,
    revoked: input.revoked,
    decision,
    operator_summary: normalizeOperationsIncidentText(input.operator_summary, 700),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function projectRiskBoard(projectionRef: Ref, riskEntries: readonly RiskRegisterEntry[], acceptances: readonly RiskAcceptanceRecord[]): RiskBoardProjection {
  const acceptanceByRisk = new Map<Ref, RiskAcceptanceRecord>();
  for (const acceptance of acceptances) {
    acceptanceByRisk.set(acceptance.risk_ref, acceptance);
  }
  const blockerRiskRefs = uniqueOperationsIncidentRefs(riskEntries.filter((entry) => entry.current_status === "blocker" || (entry.no_go_condition && entry.current_status !== "retired")).map((entry) => entry.risk_ref));
  const acceptedRiskRefs = uniqueOperationsIncidentRefs(acceptances.filter((acceptance) => acceptance.decision === "accepted").map((acceptance) => acceptance.risk_ref));
  const staleAcceptanceRefs = uniqueOperationsIncidentRefs(acceptances.filter((acceptance) => acceptance.decision === "expired" || acceptance.decision === "rejected" || acceptance.decision === "requires_review").map((acceptance) => acceptance.acceptance_ref));
  const monitoredRiskRefs = uniqueOperationsIncidentRefs(riskEntries.filter((entry) => entry.current_status === "monitored" || acceptanceByRisk.get(entry.risk_ref)?.decision === "accepted").map((entry) => entry.risk_ref));
  const base = {
    schema_version: OPERATIONS_INCIDENT_RISK_TOOLING_SCHEMA_VERSION,
    projection_ref: projectionRef,
    total_risk_count: riskEntries.length,
    blocker_risk_refs: blockerRiskRefs,
    accepted_risk_refs: acceptedRiskRefs,
    monitored_risk_refs: monitoredRiskRefs,
    stale_acceptance_refs: staleAcceptanceRefs,
    release_blocker_count: blockerRiskRefs.length + staleAcceptanceRefs.length,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateReleaseResumptionReport(report: ReleaseResumptionReport): OperationsIncidentRiskValidationReport {
  const issues: ValidationIssue[] = [];
  validateOperationsIncidentRef(report.resumption_ref, "$.resumption_ref", issues);
  validateOperationsIncidentRef(report.incident.incident_ref, "$.incident.incident_ref", issues);
  validateOperationsIncidentText(report.operator_summary, "$.operator_summary", true, issues);
  validateOperationsIncidentRefs(report.required_resumption_evidence_refs, "$.required_resumption_evidence_refs", issues);
  validateOperationsIncidentRefs(report.observed_resumption_evidence_refs, "$.observed_resumption_evidence_refs", issues);
  if (report.no_go_conditions.length > 0 && report.decision !== "blocked") {
    issues.push(operationsIncidentIssue("error", "OperationsNoGoDecisionMismatch", "$.decision", "No-go operations conditions require blocked resumption.", "Keep release resumption blocked until no-go conditions are closed."));
  }
  if (report.conditional_conditions.length > 0 && report.decision === "resume") {
    issues.push(operationsIncidentIssue("error", "OperationsConditionalDecisionMismatch", "$.decision", "Conditional operations conditions cannot produce unconditional resumption.", "Use conditional_resume or close review conditions."));
  }
  if (report.incident.closure_ready && report.incident.status !== "closed") {
    issues.push(operationsIncidentIssue("error", "IncidentClosureStateMismatch", "$.incident.status", "Closure-ready incidents must be in closed status.", "Close the incident only after evidence validation."));
  }
  return buildOperationsIncidentValidationReport(makeOperationsIncidentRef("resumption_report", report.resumption_ref), issues);
}

export function assertValidReleaseResumptionReport(report: ReleaseResumptionReport): void {
  const validation = validateReleaseResumptionReport(report);
  if (!validation.ok) {
    throw new OperationsIncidentRiskContractError("Release resumption report failed validation.", validation.issues);
  }
}

export function deriveResumptionDecision(noGoConditions: readonly string[], conditionalConditions: readonly string[]): OperationsResumptionDecision {
  if (noGoConditions.length > 0) return "blocked";
  if (conditionalConditions.length > 0) return "conditional_resume";
  return "resume";
}

function routeIncident(input: OperationsIncidentLifecycleInput, missingEvidenceRefs: readonly Ref[]): OperationsIncidentRoute {
  if (input.severity === "sev0" || input.safehold_required) return "safe_hold";
  if (input.release_impacting || missingEvidenceRefs.length > 0) return "release_block";
  if (input.status === "validated" || input.status === "closed") return "monitor";
  if (input.severity === "sev1") return "human_review";
  return "mitigate";
}

function buildNoGoConditions(
  incident: OperationsIncidentLifecycle,
  runbookExecution: RunbookExecutionReport,
  onCallCoverage: OnCallCoverageReport,
  releaseRiskGateReport: ReleaseRiskGateReport,
  riskBoardProjection: RiskBoardProjection,
  missingResumptionEvidenceRefs: readonly Ref[],
): readonly string[] {
  const conditions: string[] = [];
  if (!incident.closure_ready) conditions.push("incident_lifecycle_not_closed");
  if (incident.route_decision === "safe_hold" && incident.safehold_evidence_refs.length === 0) conditions.push("safehold_evidence_missing");
  if (runbookExecution.status === "red") conditions.push("runbook_execution_red");
  if (onCallCoverage.status === "red") conditions.push("on_call_or_review_coverage_red");
  if (!releaseGateReady(releaseRiskGateReport)) conditions.push("release_risk_gate_not_green");
  if (riskBoardProjection.release_blocker_count > 0) conditions.push("risk_board_has_release_blockers");
  if (missingResumptionEvidenceRefs.length > 0) conditions.push("release_resumption_evidence_missing");
  return uniqueOperationsIncidentStrings(conditions);
}

function buildConditionalConditions(
  runbookExecution: RunbookExecutionReport,
  onCallCoverage: OnCallCoverageReport,
  riskAcceptances: readonly RiskAcceptanceRecord[],
  releaseRiskGateReport: ReleaseRiskGateReport,
): readonly string[] {
  const conditions: string[] = [];
  if (runbookExecution.status === "amber") conditions.push("runbook_execution_reviewer_missing");
  if (onCallCoverage.status === "amber") conditions.push("secondary_on_call_missing");
  if (riskAcceptances.some((acceptance) => acceptance.decision === "accepted")) conditions.push("accepted_limitations_require_monitoring");
  if (releaseRiskGateReport.decision === "conditional_go") conditions.push("release_risk_gate_conditional");
  return uniqueOperationsIncidentStrings(conditions);
}

export class OperationsIncidentRiskContractError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "OperationsIncidentRiskContractError";
    this.issues = freezeOperationsIncidentArray(issues);
  }
}

export function buildOperationsIncidentValidationReport(reportRef: Ref, issues: readonly ValidationIssue[]): OperationsIncidentRiskValidationReport {
  const frozenIssues = freezeOperationsIncidentArray(issues);
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

export function operationsIncidentIssue(severity: ValidationSeverity, code: string, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

export function validateOperationsIncidentRef(ref: Ref | undefined, path: string, issues: ValidationIssue[]): void {
  if (ref === undefined || ref.trim().length === 0 || /\s/u.test(ref)) {
    issues.push(operationsIncidentIssue("error", "OperationsIncidentRefInvalid", path, "Reference must be present, non-empty, and whitespace-free.", "Use a stable opaque operations incident ref."));
  }
}

export function validateOperationsIncidentRefs(refs: readonly Ref[], path: string, issues: ValidationIssue[]): void {
  refs.forEach((ref, index) => validateOperationsIncidentRef(ref, `${path}[${index}]`, issues));
}

export function validateOperationsIncidentText(value: string, path: string, required: boolean, issues: ValidationIssue[]): void {
  if (required && value.trim().length === 0) {
    issues.push(operationsIncidentIssue("error", "OperationsIncidentTextRequired", path, "Required operations incident text is empty.", "Provide concise evidence text."));
  }
  if (/reward\s*update|policy\s*gradient|ignore\s*safety/iu.test(value)) {
    issues.push(operationsIncidentIssue("error", "OperationsIncidentTextForbidden", path, "Operations incident text contains forbidden governance wording.", "Use no-RL and safety-preserving wording."));
  }
}

export function normalizeOperationsIncidentText(value: string, maxChars = 1000): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, maxChars);
}

export function makeOperationsIncidentRef(...parts: readonly (string | number | undefined)[]): Ref {
  const normalized = parts
    .filter((part): part is string | number => part !== undefined)
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return normalized.length > 0 ? `operations:${normalized}` : "operations:empty";
}

export function uniqueOperationsIncidentRefs(items: readonly (Ref | undefined)[]): readonly Ref[] {
  return freezeOperationsIncidentArray([...new Set(items.filter((item): item is Ref => item !== undefined && item.trim().length > 0))]);
}

export function uniqueOperationsIncidentStrings(items: readonly string[]): readonly string[] {
  return freezeOperationsIncidentArray([...new Set(items.map((item) => normalizeOperationsIncidentText(item)).filter((item) => item.length > 0))]);
}

export function freezeOperationsIncidentArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

export const OPERATIONS_INCIDENT_RISK_TOOLING_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: OPERATIONS_INCIDENT_RISK_TOOLING_SCHEMA_VERSION,
  operations_blueprints: freezeOperationsIncidentArray([
    "production_readiness_docs/16_OPERATIONS_RUNBOOK_AND_INCIDENT_RESPONSE.md",
    "production_readiness_docs/17_PRODUCTION_RISK_REGISTER.md",
    "architecture_docs/21_ROADMAP_WBS_DELIVERY_AND_PROJECT_OPERATIONS.md",
    "architecture_docs/22_RISK_REGISTER_AND_MITIGATION_ARCHITECTURE.md",
  ]),
  component: "OperationsIncidentRiskTooling",
});
