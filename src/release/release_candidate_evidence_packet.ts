/**
 * Release candidate evidence packet.
 *
 * Blueprint: `production_readiness_docs/14_CI_CD_RELEASE_GATE_PLAN.md`,
 * `production_readiness_docs/17_PRODUCTION_RISK_REGISTER.md`, and
 * `production_readiness_docs/18_FINAL_PRODUCTION_READINESS_CHECKLIST.md`.
 *
 * This PIT-B16 surface produces the final typed evidence packet from release
 * readiness, risk, dependency gate, milestone health, and owner sign-off
 * inputs. It is intentionally evidence-only and performs no deployment,
 * workflow, infrastructure, or environment mutation.
 */

import { evaluateGateReadiness } from "../operations/dependency_gate_registry";
import type { DependencyGate, DependencyGateRef, GateReadinessDecision, GateStatus } from "../operations/dependency_gate_registry";
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
} from "../operations/milestone_registry";
import type { OperationsValidationReport } from "../operations/milestone_registry";
import type { MilestoneHealthReport, MilestoneHealthStatus } from "../operations/milestone_health_report";
import type { ReleaseReadinessReport } from "../qa/release_readiness_report";
import { releaseGateReady } from "../risk/release_risk_gate_evaluator";
import type { ReleaseRiskGateReport } from "../risk/release_risk_gate_evaluator";
import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";

export const RELEASE_CANDIDATE_EVIDENCE_PACKET_SCHEMA_VERSION = "mebsuta.release.release_candidate_evidence_packet.v1" as const;

export const REQUIRED_RELEASE_SIGN_OFF_ROLES = freezeOperationsArray([
  "safety",
  "qa",
  "security",
  "operations",
  "production_engineering",
  "architecture",
  "program",
] as const);

export type ReleaseSignOffRole = typeof REQUIRED_RELEASE_SIGN_OFF_ROLES[number];
export type ReleaseSignOffStatus = "approved" | "approved_with_limitation" | "rejected" | "missing";
export type ReleasePacketDecision = "go" | "conditional_go" | "no_go";
export type ReleaseReadinessAggregationStatus = "green" | "conditional" | "red";

export interface ReleaseSignOffInput {
  readonly role: ReleaseSignOffRole;
  readonly signer_ref: Ref;
  readonly status: ReleaseSignOffStatus;
  readonly evidence_refs: readonly Ref[];
  readonly limitation_refs?: readonly Ref[];
  readonly signed_at_iso?: string;
  readonly summary: string;
}

export interface ReleaseSignOffRecord {
  readonly role: ReleaseSignOffRole;
  readonly signer_ref: Ref;
  readonly status: ReleaseSignOffStatus;
  readonly evidence_refs: readonly Ref[];
  readonly limitation_refs: readonly Ref[];
  readonly signed_at_iso: string | null;
  readonly summary: string;
  readonly determinism_hash: string;
}

export interface ReleaseReadinessAggregation {
  readonly status: ReleaseReadinessAggregationStatus;
  readonly decision: ReleaseReadinessReport["decision"];
  readonly red_gate_count: number;
  readonly conditional_gate_count: number;
  readonly no_go_conditions: readonly string[];
  readonly evidence_refs: readonly Ref[];
  readonly reason: string;
  readonly determinism_hash: string;
}

export interface DependencyGateClosureReport {
  readonly status: GateStatus;
  readonly expected_gate_refs: readonly DependencyGateRef[];
  readonly observed_gate_refs: readonly DependencyGateRef[];
  readonly missing_gate_refs: readonly DependencyGateRef[];
  readonly red_gate_refs: readonly DependencyGateRef[];
  readonly amber_gate_refs: readonly DependencyGateRef[];
  readonly closed_gate_refs: readonly DependencyGateRef[];
  readonly evidence_refs: readonly Ref[];
  readonly reason: string;
  readonly determinism_hash: string;
}

export interface MilestoneHealthSummary {
  readonly status: MilestoneHealthStatus;
  readonly release_decision: MilestoneHealthReport["release_decision"];
  readonly task_completion_ratio: number;
  readonly gate_green_ratio: number;
  readonly red_gate_count: number;
  readonly amber_gate_count: number;
  readonly evidence_refs: readonly Ref[];
  readonly reason: string;
  readonly determinism_hash: string;
}

export interface ReleaseSignOffCompleteness {
  readonly status: ReleaseSignOffStatus;
  readonly required_roles: readonly ReleaseSignOffRole[];
  readonly approved_roles: readonly ReleaseSignOffRole[];
  readonly conditional_roles: readonly ReleaseSignOffRole[];
  readonly rejected_roles: readonly ReleaseSignOffRole[];
  readonly missing_roles: readonly ReleaseSignOffRole[];
  readonly evidence_refs: readonly Ref[];
  readonly reason: string;
  readonly determinism_hash: string;
}

export interface ReleaseCandidateEvidencePacketInput {
  readonly packet_ref: Ref;
  readonly release_candidate_ref: Ref;
  readonly source_revision_ref: Ref;
  readonly generated_at_iso: string;
  readonly release_readiness_report: ReleaseReadinessReport;
  readonly release_risk_gate_report: ReleaseRiskGateReport;
  readonly dependency_gate_decisions: readonly GateReadinessDecision[];
  readonly milestone_health_report: MilestoneHealthReport;
  readonly sign_offs: readonly ReleaseSignOffInput[];
  readonly release_manifest_refs: readonly Ref[];
  readonly build_metadata_refs: readonly Ref[];
  readonly test_report_refs: readonly Ref[];
  readonly security_evidence_refs: readonly Ref[];
  readonly operations_evidence_refs: readonly Ref[];
  readonly rollback_evidence_refs: readonly Ref[];
  readonly operator_summary: string;
}

export interface ReleaseCandidateEvidencePacket {
  readonly schema_version: typeof RELEASE_CANDIDATE_EVIDENCE_PACKET_SCHEMA_VERSION;
  readonly packet_ref: Ref;
  readonly release_candidate_ref: Ref;
  readonly source_revision_ref: Ref;
  readonly generated_at_iso: string;
  readonly release_readiness: ReleaseReadinessAggregation;
  readonly release_risk_gate_report: ReleaseRiskGateReport;
  readonly dependency_gate_closure: DependencyGateClosureReport;
  readonly milestone_health: MilestoneHealthSummary;
  readonly sign_offs: readonly ReleaseSignOffRecord[];
  readonly sign_off_completeness: ReleaseSignOffCompleteness;
  readonly release_manifest_refs: readonly Ref[];
  readonly build_metadata_refs: readonly Ref[];
  readonly test_report_refs: readonly Ref[];
  readonly security_evidence_refs: readonly Ref[];
  readonly operations_evidence_refs: readonly Ref[];
  readonly rollback_evidence_refs: readonly Ref[];
  readonly no_go_conditions: readonly string[];
  readonly conditional_go_conditions: readonly string[];
  readonly decision: ReleasePacketDecision;
  readonly operator_summary: string;
  readonly determinism_hash: string;
}

/**
 * Builds dependency gate decisions from the G1-G10 gate registry and the
 * evidence refs available for the release candidate packet.
 */
export function evaluateReleaseCandidateDependencyGates(
  gates: readonly DependencyGate[],
  availableEvidenceRefs: readonly Ref[],
  issueRefsByGate: Readonly<Partial<Record<DependencyGateRef, readonly Ref[]>>> = {},
): readonly GateReadinessDecision[] {
  return freezeOperationsArray(gates.map((gate) => evaluateGateReadiness({
    gate,
    available_evidence_refs: availableEvidenceRefs,
    unresolved_issue_refs: issueRefsByGate[gate.gate_ref] ?? [],
  })));
}

/**
 * Builds and validates the final release candidate evidence packet.
 */
export function buildReleaseCandidateEvidencePacket(input: ReleaseCandidateEvidencePacketInput): ReleaseCandidateEvidencePacket {
  const releaseReadiness = aggregateReleaseReadiness(input.release_readiness_report);
  const dependencyGateClosure = summarizeDependencyGateClosure(input.dependency_gate_decisions);
  const milestoneHealth = summarizeMilestoneHealth(input.milestone_health_report);
  const signOffs = freezeOperationsArray(input.sign_offs.map(normalizeReleaseSignOff));
  const signOffCompleteness = summarizeSignOffCompleteness(signOffs);
  const noGoConditions = buildNoGoConditions(input.release_risk_gate_report, releaseReadiness, dependencyGateClosure, milestoneHealth, signOffCompleteness);
  const conditionalGoConditions = buildConditionalGoConditions(input.release_risk_gate_report, releaseReadiness, dependencyGateClosure, milestoneHealth, signOffCompleteness);
  const decision = deriveReleasePacketDecision(noGoConditions, conditionalGoConditions);
  const base = {
    schema_version: RELEASE_CANDIDATE_EVIDENCE_PACKET_SCHEMA_VERSION,
    packet_ref: input.packet_ref,
    release_candidate_ref: input.release_candidate_ref,
    source_revision_ref: input.source_revision_ref,
    generated_at_iso: input.generated_at_iso,
    release_readiness: releaseReadiness,
    release_risk_gate_report: input.release_risk_gate_report,
    dependency_gate_closure: dependencyGateClosure,
    milestone_health: milestoneHealth,
    sign_offs: signOffs,
    sign_off_completeness: signOffCompleteness,
    release_manifest_refs: uniqueOperationsRefs(input.release_manifest_refs),
    build_metadata_refs: uniqueOperationsRefs(input.build_metadata_refs),
    test_report_refs: uniqueOperationsRefs(input.test_report_refs),
    security_evidence_refs: uniqueOperationsRefs(input.security_evidence_refs),
    operations_evidence_refs: uniqueOperationsRefs(input.operations_evidence_refs),
    rollback_evidence_refs: uniqueOperationsRefs(input.rollback_evidence_refs),
    no_go_conditions: noGoConditions,
    conditional_go_conditions: conditionalGoConditions,
    decision,
    operator_summary: normalizeOperationsText(input.operator_summary, 1_000),
  };
  const packet = Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  assertValidReleaseCandidateEvidencePacket(packet);
  return packet;
}

export function validateReleaseCandidateEvidencePacket(packet: ReleaseCandidateEvidencePacket): OperationsValidationReport {
  const issues: ValidationIssue[] = [];
  validateOperationsRef(packet.packet_ref, "$.packet_ref", issues);
  validateOperationsRef(packet.release_candidate_ref, "$.release_candidate_ref", issues);
  validateOperationsRef(packet.source_revision_ref, "$.source_revision_ref", issues);
  validateOperationsText(packet.operator_summary, "$.operator_summary", true, issues);
  validateOperationsRefs(packet.release_manifest_refs, "$.release_manifest_refs", issues);
  validateOperationsRefs(packet.build_metadata_refs, "$.build_metadata_refs", issues);
  validateOperationsRefs(packet.test_report_refs, "$.test_report_refs", issues);
  validateOperationsRefs(packet.security_evidence_refs, "$.security_evidence_refs", issues);
  validateOperationsRefs(packet.operations_evidence_refs, "$.operations_evidence_refs", issues);
  validateOperationsRefs(packet.rollback_evidence_refs, "$.rollback_evidence_refs", issues);
  validateOperationsNonEmptyArray(packet.release_manifest_refs, "$.release_manifest_refs", "ReleaseManifestRefsMissing", issues);
  validateOperationsNonEmptyArray(packet.build_metadata_refs, "$.build_metadata_refs", "BuildMetadataRefsMissing", issues);
  validateOperationsNonEmptyArray(packet.test_report_refs, "$.test_report_refs", "TestReportRefsMissing", issues);
  validateOperationsNonEmptyArray(packet.security_evidence_refs, "$.security_evidence_refs", "SecurityEvidenceRefsMissing", issues);
  validateOperationsNonEmptyArray(packet.operations_evidence_refs, "$.operations_evidence_refs", "OperationsEvidenceRefsMissing", issues);
  validateOperationsNonEmptyArray(packet.rollback_evidence_refs, "$.rollback_evidence_refs", "RollbackEvidenceRefsMissing", issues);
  validateOperationsNonEmptyArray(packet.sign_offs, "$.sign_offs", "ReleaseSignOffsMissing", issues);
  packet.sign_offs.forEach((signOff, index) => validateReleaseSignOff(signOff, `$.sign_offs[${index}]`, issues));
  if (!Number.isFinite(new Date(packet.generated_at_iso).getTime())) {
    issues.push(operationsIssue("error", "ReleasePacketGeneratedAtInvalid", "$.generated_at_iso", "Release packet timestamp must be valid ISO-8601.", "Use the packet generation timestamp."));
  }
  if (packet.no_go_conditions.length > 0 && packet.decision !== "no_go") {
    issues.push(operationsIssue("error", "ReleasePacketNoGoMismatch", "$.decision", "No-go conditions require a no_go packet decision.", "Keep release candidate blocked until closure evidence is present."));
  }
  if (packet.conditional_go_conditions.length > 0 && packet.decision === "go") {
    issues.push(operationsIssue("error", "ReleasePacketConditionalMismatch", "$.decision", "Conditional conditions cannot produce an unconditional go.", "Resolve conditions or use conditional_go."));
  }
  if (packet.decision === "go" && packet.dependency_gate_closure.closed_gate_refs.length !== REQUIRED_DEPENDENCY_GATE_REFS.length) {
    issues.push(operationsIssue("error", "ReleasePacketMissingClosedDependencyGates", "$.dependency_gate_closure.closed_gate_refs", "Release candidate go requires all dependency gates closed.", "Attach G1-G10 green gate decisions."));
  }
  return buildOperationsValidationReport(makeOperationsRef("release_candidate_evidence_packet", packet.packet_ref), issues, operationsRouteForIssues(issues));
}

export function assertValidReleaseCandidateEvidencePacket(packet: ReleaseCandidateEvidencePacket): void {
  const validation = validateReleaseCandidateEvidencePacket(packet);
  if (!validation.ok) {
    throw new OperationsContractError("Release candidate evidence packet failed validation.", validation.issues);
  }
}

export function aggregateReleaseReadiness(report: ReleaseReadinessReport): ReleaseReadinessAggregation {
  const status: ReleaseReadinessAggregationStatus = report.decision === "go" && report.red_gate_count === 0 && report.conditional_gate_count === 0 && report.no_go_conditions.length === 0
    ? "green"
    : report.decision === "no_go" || report.red_gate_count > 0 || report.no_go_conditions.length > 0
      ? "red"
      : "conditional";
  const evidenceRefs = uniqueOperationsRefs([
    report.release_report_ref,
    ...report.benchmark_scorecard_refs,
    ...report.regression_report_refs,
    ...report.chaos_record_refs,
    ...report.gate_evidence.flatMap((gate) => gate.evidence_refs),
  ]);
  const base = {
    status,
    decision: report.decision,
    red_gate_count: report.red_gate_count,
    conditional_gate_count: report.conditional_gate_count,
    no_go_conditions: freezeOperationsArray(report.no_go_conditions),
    evidence_refs: evidenceRefs,
    reason: releaseReadinessReason(status, report),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function summarizeDependencyGateClosure(decisions: readonly GateReadinessDecision[]): DependencyGateClosureReport {
  const observedGateRefs = freezeOperationsArray([...new Set(decisions.map((decision) => decision.gate_ref))]);
  const missingGateRefs = freezeOperationsArray(REQUIRED_DEPENDENCY_GATE_REFS.filter((gateRef) => !observedGateRefs.includes(gateRef)));
  const redGateRefs = gateRefsByStatus(decisions, ["red"]);
  const amberGateRefs = gateRefsByStatus(decisions, ["amber", "not_evaluated"]);
  const closedGateRefs = gateRefsByStatus(decisions, ["green"]);
  const status: GateStatus = missingGateRefs.length > 0 || redGateRefs.length > 0
    ? "red"
    : amberGateRefs.length > 0
      ? "amber"
      : "green";
  const base = {
    status,
    expected_gate_refs: REQUIRED_DEPENDENCY_GATE_REFS,
    observed_gate_refs: observedGateRefs,
    missing_gate_refs: missingGateRefs,
    red_gate_refs: redGateRefs,
    amber_gate_refs: amberGateRefs,
    closed_gate_refs: closedGateRefs,
    evidence_refs: uniqueOperationsRefs(decisions.flatMap((decision) => [
      ...decision.missing_evidence_refs,
      ...decision.unresolved_issue_refs,
    ])),
    reason: dependencyClosureReason(status, missingGateRefs.length, redGateRefs.length, amberGateRefs.length),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function summarizeMilestoneHealth(report: MilestoneHealthReport): MilestoneHealthSummary {
  const base = {
    status: report.overall_health,
    release_decision: report.release_decision,
    task_completion_ratio: report.task_completion_ratio,
    gate_green_ratio: report.gate_green_ratio,
    red_gate_count: report.red_gate_count,
    amber_gate_count: report.amber_gate_count,
    evidence_refs: uniqueOperationsRefs([
      report.health_report_ref,
      ...report.qa_signal_refs,
      ...report.risk_refs,
      ...report.operational_readiness_refs,
      ...report.indicators.flatMap((indicator) => indicator.evidence_refs),
    ]),
    reason: milestoneHealthReason(report),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function summarizeSignOffCompleteness(signOffs: readonly ReleaseSignOffRecord[]): ReleaseSignOffCompleteness {
  const byRole = new Map(signOffs.map((signOff) => [signOff.role, signOff]));
  const missingRoles = freezeOperationsArray(REQUIRED_RELEASE_SIGN_OFF_ROLES.filter((role) => !byRole.has(role)));
  const approvedRoles = rolesWithStatus(signOffs, ["approved"]);
  const conditionalRoles = rolesWithStatus(signOffs, ["approved_with_limitation"]);
  const rejectedRoles = rolesWithStatus(signOffs, ["rejected"]);
  const status: ReleaseSignOffStatus = rejectedRoles.length > 0
    ? "rejected"
    : missingRoles.length > 0
      ? "missing"
      : conditionalRoles.length > 0
        ? "approved_with_limitation"
        : "approved";
  const base = {
    status,
    required_roles: REQUIRED_RELEASE_SIGN_OFF_ROLES,
    approved_roles: approvedRoles,
    conditional_roles: conditionalRoles,
    rejected_roles: rejectedRoles,
    missing_roles: missingRoles,
    evidence_refs: uniqueOperationsRefs(signOffs.flatMap((signOff) => [...signOff.evidence_refs, ...signOff.limitation_refs])),
    reason: signOffReason(status, missingRoles.length, rejectedRoles.length, conditionalRoles.length),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function deriveReleasePacketDecision(noGoConditions: readonly string[], conditionalGoConditions: readonly string[]): ReleasePacketDecision {
  if (noGoConditions.length > 0) {
    return "no_go";
  }
  if (conditionalGoConditions.length > 0) {
    return "conditional_go";
  }
  return "go";
}

const REQUIRED_DEPENDENCY_GATE_REFS = freezeOperationsArray(["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G10"] as const);

function normalizeReleaseSignOff(input: ReleaseSignOffInput): ReleaseSignOffRecord {
  const base = {
    role: input.role,
    signer_ref: input.signer_ref,
    status: input.status,
    evidence_refs: uniqueOperationsRefs(input.evidence_refs),
    limitation_refs: uniqueOperationsRefs(input.limitation_refs ?? []),
    signed_at_iso: input.signed_at_iso ?? null,
    summary: normalizeOperationsText(input.summary, 700),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function validateReleaseSignOff(signOff: ReleaseSignOffRecord, path: string, issues: ValidationIssue[]): void {
  validateOperationsRef(signOff.signer_ref, `${path}.signer_ref`, issues);
  validateOperationsRefs(signOff.evidence_refs, `${path}.evidence_refs`, issues);
  validateOperationsRefs(signOff.limitation_refs, `${path}.limitation_refs`, issues);
  validateOperationsText(signOff.summary, `${path}.summary`, true, issues);
  validateOperationsNonEmptyArray(signOff.evidence_refs, `${path}.evidence_refs`, "ReleaseSignOffEvidenceMissing", issues);
  if (signOff.status !== "missing" && signOff.signed_at_iso !== null && !Number.isFinite(new Date(signOff.signed_at_iso).getTime())) {
    issues.push(operationsIssue("error", "ReleaseSignOffTimeInvalid", `${path}.signed_at_iso`, "Sign-off time must be valid ISO-8601 when provided.", "Use the sign-off timestamp."));
  }
  if (signOff.status === "approved_with_limitation" && signOff.limitation_refs.length === 0) {
    issues.push(operationsIssue("error", "ReleaseSignOffLimitationRefsMissing", `${path}.limitation_refs`, "Limited sign-off requires limitation refs.", "Attach limitation evidence refs."));
  }
}

function buildNoGoConditions(
  riskGate: ReleaseRiskGateReport,
  readiness: ReleaseReadinessAggregation,
  dependencyClosure: DependencyGateClosureReport,
  milestoneHealth: MilestoneHealthSummary,
  signOffCompleteness: ReleaseSignOffCompleteness,
): readonly string[] {
  const conditions: string[] = [];
  if (readiness.status === "red") {
    conditions.push("release readiness aggregation is red.");
  }
  if (!releaseGateReady(riskGate)) {
    conditions.push(...riskGate.no_go_conditions.map((condition) => `risk gate no-go: ${condition}`));
  }
  if (dependencyClosure.status === "red") {
    conditions.push("dependency gate closure is red.");
  }
  if (milestoneHealth.status === "red" || milestoneHealth.release_decision === "blocked") {
    conditions.push("milestone health is blocked.");
  }
  if (signOffCompleteness.status === "rejected" || signOffCompleteness.status === "missing") {
    conditions.push("release sign-off completeness is not closed.");
  }
  return uniqueOperationsStrings(conditions);
}

function buildConditionalGoConditions(
  riskGate: ReleaseRiskGateReport,
  readiness: ReleaseReadinessAggregation,
  dependencyClosure: DependencyGateClosureReport,
  milestoneHealth: MilestoneHealthSummary,
  signOffCompleteness: ReleaseSignOffCompleteness,
): readonly string[] {
  const conditions: string[] = [];
  if (readiness.status === "conditional") {
    conditions.push("release readiness aggregation requires conditional review.");
  }
  if (riskGate.decision === "conditional_go") {
    conditions.push(...riskGate.conditional_go_conditions.map((condition) => `risk gate conditional: ${condition}`));
  }
  if (dependencyClosure.status === "amber") {
    conditions.push("dependency gate closure requires review.");
  }
  if (milestoneHealth.status === "amber" || milestoneHealth.release_decision === "conditional") {
    conditions.push("milestone health requires review.");
  }
  if (signOffCompleteness.status === "approved_with_limitation") {
    conditions.push("release sign-off completeness includes limitations.");
  }
  return uniqueOperationsStrings(conditions);
}

function releaseReadinessReason(status: ReleaseReadinessAggregationStatus, report: ReleaseReadinessReport): string {
  if (status === "green") {
    return "Release readiness report is go with no red or conditional gates.";
  }
  if (status === "red") {
    return `${report.red_gate_count} red gates and ${report.no_go_conditions.length} no-go conditions block release readiness.`;
  }
  return `${report.conditional_gate_count} release readiness gates require conditional review.`;
}

function dependencyClosureReason(status: GateStatus, missingCount: number, redCount: number, amberCount: number): string {
  if (status === "green") {
    return "All G1-G10 dependency gates are green.";
  }
  if (status === "red") {
    return `${missingCount} dependency gate refs are missing and ${redCount} dependency gates are red.`;
  }
  return `${amberCount} dependency gates require review.`;
}

function milestoneHealthReason(report: MilestoneHealthReport): string {
  if (report.overall_health === "green" && report.release_decision === "ready") {
    return "Milestone health is green and release decision is ready.";
  }
  if (report.overall_health === "red" || report.release_decision === "blocked") {
    return "Milestone health blocks release candidate approval.";
  }
  return "Milestone health requires release-owner review.";
}

function signOffReason(status: ReleaseSignOffStatus, missingCount: number, rejectedCount: number, conditionalCount: number): string {
  if (status === "approved") {
    return "All required release sign-off roles approved.";
  }
  if (status === "rejected") {
    return `${rejectedCount} required release sign-off roles rejected.`;
  }
  if (status === "missing") {
    return `${missingCount} required release sign-off roles are missing.`;
  }
  return `${conditionalCount} required release sign-off roles approved with limitations.`;
}

function gateRefsByStatus(decisions: readonly GateReadinessDecision[], statuses: readonly GateStatus[]): readonly DependencyGateRef[] {
  return freezeOperationsArray([...new Set(decisions.filter((decision) => statuses.includes(decision.status)).map((decision) => decision.gate_ref))]);
}

function rolesWithStatus(signOffs: readonly ReleaseSignOffRecord[], statuses: readonly ReleaseSignOffStatus[]): readonly ReleaseSignOffRole[] {
  return freezeOperationsArray([...new Set(signOffs.filter((signOff) => statuses.includes(signOff.status)).map((signOff) => signOff.role))]);
}

export const RELEASE_CANDIDATE_EVIDENCE_PACKET_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: RELEASE_CANDIDATE_EVIDENCE_PACKET_SCHEMA_VERSION,
  blueprint: OPERATIONS_BLUEPRINT_REF,
  readiness_plans: freezeOperationsArray([
    "production_readiness_docs/14_CI_CD_RELEASE_GATE_PLAN.md",
    "production_readiness_docs/17_PRODUCTION_RISK_REGISTER.md",
    "production_readiness_docs/18_FINAL_PRODUCTION_READINESS_CHECKLIST.md",
    "production_readiness_docs/19_PRODUCTION_IMPLEMENTATION_TRACKER.md",
  ]),
  component: "ReleaseCandidateEvidencePacket",
});
