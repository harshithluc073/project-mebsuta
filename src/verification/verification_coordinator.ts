/**
 * Verification coordinator for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md`
 * sections 13.3, 13.5, 13.6, 13.10, 13.11, 13.12, 13.14, 13.15,
 * 13.16, 13.17, and 13.20.
 *
 * This coordinator owns the File 13 lifecycle from request admission through
 * policy resolution, evidence planning, assessment aggregation, certificate
 * issuance, memory gating, Oops routing, ambiguity routing, and telemetry.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import { AmbiguityResolver, type AmbiguityResolverReport } from "./ambiguity_resolver";
import { ConstraintResultAggregator, type ConstraintAggregationReport } from "./constraint_result_aggregator";
import { FalsePositiveGuard, type FalsePositiveRiskReport } from "./false_positive_guard";
import { MemoryCommitGate, type MemoryCommitGateReport, type VerifiedSpatialMemoryCandidate } from "./memory_commit_gate";
import { OopsHandoffRouter, type OopsHandoffRouterReport } from "./oops_handoff_router";
import { SettleWindowMonitor, type SettleWindowMonitorRequest, type SettleWindowReport } from "./settle_window_monitor";
import { SpatialResidualEvaluator, type SpatialResidualEvaluationReport } from "./spatial_residual_evaluator";
import { TaskSuccessCertificateIssuer, type TaskSuccessCertificateIssuerReport } from "./task_success_certificate_issuer";
import { VerificationPolicyRegistry, freezeArray, makeIssue, makeRef, sanitizeRef, uniqueSorted, type VerificationRequest, type VerificationRouteDecision } from "./verification_policy_registry";
import type { VerificationPolicyRegistryReport } from "./verification_policy_registry";
import { VerificationTelemetryRecorder, type VerificationTelemetryRecorderReport } from "./verification_telemetry_recorder";
import { VerificationViewRequester, type AvailableVerificationSensor, type VerificationOcclusionHint, type VerificationViewRequesterReport } from "./verification_view_requester";
import { ViewSufficiencyEvaluator, type ViewSufficiencyReport } from "./view_sufficiency_evaluator";
import { VisualVerificationAdapter, type VisualConstraintAssessment, type VisualVerificationAdapterReport } from "./visual_verification_adapter";
import type { VerificationObservationBundle } from "../perception/verification_view_assembler";
import type { SpatialResidualReport } from "../spatial/spatial_constraint_evaluator";

export const VERIFICATION_COORDINATOR_SCHEMA_VERSION = "mebsuta.verification_coordinator.v1" as const;

export type VerificationCoordinatorDecision = "complete" | "reobserve" | "correct" | "safe_hold" | "human_review" | "rejected";

export interface VerificationCoordinatorRequest {
  readonly request_ref?: Ref;
  readonly verification_request: VerificationRequest;
  readonly available_sensors: readonly AvailableVerificationSensor[];
  readonly occlusion_hints?: readonly VerificationOcclusionHint[];
  readonly observation_bundle?: VerificationObservationBundle;
  readonly residual_reports: readonly SpatialResidualReport[];
  readonly settle_window_request?: Omit<SettleWindowMonitorRequest, "policy">;
  readonly model_response_ref?: Ref;
  readonly model_constraint_assessments?: readonly VisualConstraintAssessment[];
  readonly memory_candidates?: readonly VerifiedSpatialMemoryCandidate[];
  readonly current_time_ms: number;
}

export interface VerificationCoordinatorReport {
  readonly schema_version: typeof VERIFICATION_COORDINATOR_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md";
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly decision: VerificationCoordinatorDecision;
  readonly route_decision: VerificationRouteDecision;
  readonly policy_report: VerificationPolicyRegistryReport;
  readonly view_report?: VerificationViewRequesterReport;
  readonly settle_report?: SettleWindowReport;
  readonly sufficiency_report?: ViewSufficiencyReport;
  readonly visual_report?: VisualVerificationAdapterReport;
  readonly spatial_report?: SpatialResidualEvaluationReport;
  readonly false_positive_report?: FalsePositiveRiskReport;
  readonly aggregation_report?: ConstraintAggregationReport;
  readonly certificate_report?: TaskSuccessCertificateIssuerReport;
  readonly ambiguity_report?: AmbiguityResolverReport;
  readonly oops_report?: OopsHandoffRouterReport;
  readonly memory_report?: MemoryCommitGateReport;
  readonly telemetry_report?: VerificationTelemetryRecorderReport;
  readonly artifact_refs: readonly Ref[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "verification_coordinator_report";
  readonly determinism_hash: string;
}

/**
 * Coordinates the complete File 13 verification lifecycle.
 */
export class VerificationCoordinator {
  public constructor(
    private readonly policyRegistry = new VerificationPolicyRegistry(),
    private readonly viewRequester = new VerificationViewRequester(),
    private readonly settleMonitor = new SettleWindowMonitor(),
    private readonly sufficiencyEvaluator = new ViewSufficiencyEvaluator(),
    private readonly visualAdapter = new VisualVerificationAdapter(),
    private readonly spatialEvaluator = new SpatialResidualEvaluator(),
    private readonly falsePositiveGuard = new FalsePositiveGuard(),
    private readonly aggregator = new ConstraintResultAggregator(),
    private readonly certificateIssuer = new TaskSuccessCertificateIssuer(),
    private readonly ambiguityResolver = new AmbiguityResolver(),
    private readonly oopsRouter = new OopsHandoffRouter(),
    private readonly memoryGate = new MemoryCommitGate(),
    private readonly telemetryRecorder = new VerificationTelemetryRecorder(),
  ) {}

  /**
   * Executes the deterministic verification lifecycle for one request.
   */
  public coordinateVerification(request: VerificationCoordinatorRequest): VerificationCoordinatorReport {
    const issues: ValidationIssue[] = [];
    const requestRef = sanitizeRef(request.request_ref ?? makeRef("verification_coordinator", request.verification_request.verification_request_ref));
    const policyReport = this.policyRegistry.resolveVerificationPolicy(request.verification_request);
    issues.push(...policyReport.issues);
    if (policyReport.policy === undefined) return this.rejected(requestRef, policyReport, issues);

    const viewReport = this.viewRequester.planVerificationViews({
      verification_request: request.verification_request,
      policy: policyReport.policy,
      available_sensors: request.available_sensors,
      occlusion_hints: request.occlusion_hints,
    });
    issues.push(...viewReport.issues);
    if (viewReport.view_plan === undefined) return this.rejected(requestRef, policyReport, issues, viewReport);

    const settleReport = request.settle_window_request === undefined ? undefined : this.settleMonitor.evaluateSettleWindow({
      ...request.settle_window_request,
      policy: policyReport.policy,
    });
    if (settleReport !== undefined) issues.push(...settleReport.issues);

    const sufficiencyReport = this.sufficiencyEvaluator.evaluateViewSufficiency({
      policy: policyReport.policy,
      view_plan: viewReport.view_plan,
      observation_bundle: request.observation_bundle,
      external_evidence_refs: request.verification_request.expected_postcondition_refs,
    });
    issues.push(...sufficiencyReport.issues);

    const visualReport = this.visualAdapter.prepareVisualVerification({
      verification_request: request.verification_request,
      policy: policyReport.policy,
      sufficiency_report: sufficiencyReport,
      model_response_ref: request.model_response_ref,
      model_status: request.model_constraint_assessments === undefined ? "not_invoked" : "completed",
      model_constraint_assessments: request.model_constraint_assessments,
    });
    issues.push(...visualReport.issues);

    const spatialReport = this.spatialEvaluator.evaluateSpatialResiduals({
      policy: policyReport.policy,
      residual_reports: request.residual_reports,
      extra_evidence_refs: sufficiencyReport.evidence_refs,
    });
    issues.push(...spatialReport.issues);

    const falsePositiveReport = this.falsePositiveGuard.evaluateFalsePositiveRisk({
      policy: policyReport.policy,
      sufficiency_report: sufficiencyReport,
      visual_assessment: visualReport.assessment,
      spatial_report: spatialReport,
      settle_report: settleReport,
      memory_candidate_refs: request.memory_candidates?.map((candidate) => candidate.candidate_ref),
    });
    issues.push(...falsePositiveReport.issues);

    const aggregationReport = this.aggregator.aggregateConstraintResults({
      policy: policyReport.policy,
      sufficiency_report: sufficiencyReport,
      visual_assessment: visualReport.assessment,
      spatial_report: spatialReport,
      false_positive_report: falsePositiveReport,
      settle_report: settleReport,
    });
    issues.push(...aggregationReport.issues);

    const certificateReport = this.certificateIssuer.issueTaskSuccessCertificate({
      task_ref: request.verification_request.task_ref,
      verification_request_ref: request.verification_request.verification_request_ref,
      primitive_ref: request.verification_request.primitive_ref,
      policy_ref: policyReport.policy.policy_ref,
      aggregation_report: aggregationReport,
      truth_boundary_status: request.verification_request.truth_boundary_status,
      replay_refs: this.artifactRefs(policyReport, viewReport, settleReport, sufficiencyReport, visualReport, spatialReport, falsePositiveReport, aggregationReport),
      issued_at_ms: request.current_time_ms,
    });
    issues.push(...certificateReport.issues);

    const ambiguityReport = aggregationReport.route_decision === "reobserve" ? this.ambiguityResolver.resolveAmbiguity({
      policy: policyReport.policy,
      aggregation_report: aggregationReport,
      sufficiency_report: sufficiencyReport,
      visual_assessment: visualReport.assessment,
    }) : undefined;

    const oopsReport = this.oopsRouter.routeOopsHandoff({
      policy: policyReport.policy,
      aggregation_report: aggregationReport,
      certificate: certificateReport.certificate,
      spatial_report: spatialReport,
      controller_completion_summary: request.verification_request.controller_completion_summary,
      safety_policy_ref: request.verification_request.safety_policy_ref,
    });

    const memoryReport = this.memoryGate.authorizeMemoryCommit({
      certificate: certificateReport.certificate,
      memory_policy: policyReport.policy.memory_policy,
      candidates: request.memory_candidates ?? [],
      current_time_ms: request.current_time_ms,
    });

    const artifactRefs = this.artifactRefs(policyReport, viewReport, settleReport, sufficiencyReport, visualReport, spatialReport, falsePositiveReport, aggregationReport, certificateReport, ambiguityReport, oopsReport, memoryReport);
    const telemetryReport = this.telemetryRecorder.recordVerificationTelemetry({
      task_ref: request.verification_request.task_ref,
      timestamp_ms: request.current_time_ms,
      artifact_refs: artifactRefs,
      evidence_refs: uniqueSorted([...sufficiencyReport.evidence_refs, ...spatialReport.evidence_refs]),
      certificate_ref: certificateReport.certificate?.certificate_ref,
      route_decision: aggregationReport.route_decision,
      confidence: aggregationReport.confidence,
      latency_ms: Math.max(0, policyReport.policy.maximum_verification_latency_ms - policyReport.policy.maximum_verification_latency_ms / 2),
      notes: [aggregationReport.decision],
    });

    const decision = coordinatorDecisionFor(aggregationReport.route_decision, issues);
    const base = {
      schema_version: VERIFICATION_COORDINATOR_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md" as const,
      report_ref: makeRef("verification_coordinator_report", requestRef, decision),
      request_ref: requestRef,
      decision,
      route_decision: aggregationReport.route_decision,
      policy_report: policyReport,
      view_report: viewReport,
      settle_report: settleReport,
      sufficiency_report: sufficiencyReport,
      visual_report: visualReport,
      spatial_report: spatialReport,
      false_positive_report: falsePositiveReport,
      aggregation_report: aggregationReport,
      certificate_report: certificateReport,
      ambiguity_report: ambiguityReport,
      oops_report: oopsReport,
      memory_report: memoryReport,
      telemetry_report: telemetryReport,
      artifact_refs: artifactRefs,
      issues: freezeArray(issues),
      ok: decision === "complete",
      cognitive_visibility: "verification_coordinator_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }

  private rejected(
    requestRef: Ref,
    policyReport: VerificationPolicyRegistryReport,
    issues: readonly ValidationIssue[],
    viewReport?: VerificationViewRequesterReport,
  ): VerificationCoordinatorReport {
    const localIssues = freezeArray([...issues, makeIssue("error", "ConstraintMissing", "$.verification_lifecycle", "Verification lifecycle could not create required policy or view artifacts.", "Repair request inputs before retrying.")]);
    const base = {
      schema_version: VERIFICATION_COORDINATOR_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md" as const,
      report_ref: makeRef("verification_coordinator_report", requestRef, "rejected"),
      request_ref: requestRef,
      decision: "rejected" as const,
      route_decision: "human_review" as const,
      policy_report: policyReport,
      view_report: viewReport,
      artifact_refs: freezeArray([policyReport.report_ref, viewReport?.report_ref].filter(isRef)),
      issues: localIssues,
      ok: false,
      cognitive_visibility: "verification_coordinator_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }

  private artifactRefs(...items: readonly ({ readonly report_ref?: Ref } | undefined)[]): readonly Ref[] {
    return uniqueSorted(items.flatMap((item) => item?.report_ref === undefined ? [] : [item.report_ref]));
  }
}

export function createVerificationCoordinator(): VerificationCoordinator {
  return new VerificationCoordinator();
}

function coordinatorDecisionFor(route: VerificationRouteDecision, issues: readonly ValidationIssue[]): VerificationCoordinatorDecision {
  if (issues.some((issue) => issue.severity === "error")) return "rejected";
  if (route === "complete" || route === "memory_only") return "complete";
  if (route === "reobserve") return "reobserve";
  if (route === "correct") return "correct";
  if (route === "safe_hold") return "safe_hold";
  return "human_review";
}

function isRef(value: Ref | undefined): value is Ref {
  return value !== undefined;
}
