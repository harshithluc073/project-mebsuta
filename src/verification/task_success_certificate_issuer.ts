/**
 * Task success certificate issuer for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md`
 * sections 13.2, 13.6.9, 13.10.12, 13.11.6, 13.12, 13.17, 13.20,
 * and 13.21.
 *
 * Certificates are immutable audit records. They capture constraint results,
 * evidence refs, route decisions, confidence, and truth-boundary status so a
 * verification outcome can be replayed without hidden simulator truth.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  freezeArray,
  makeIssue,
  makeRef,
  sanitizeRef,
  sanitizeText,
  uniqueSorted,
  validateSafeRef,
  type TruthBoundaryRecord,
  type VerificationRouteDecision,
} from "./verification_policy_registry";
import type { ConstraintAggregationReport, ConstraintVerificationResult } from "./constraint_result_aggregator";

export const TASK_SUCCESS_CERTIFICATE_ISSUER_SCHEMA_VERSION = "mebsuta.task_success_certificate_issuer.v1" as const;

export type TaskCertificateDecision = "issued" | "issued_non_success" | "blocked" | "rejected";
export type TaskCertificateResult = "success" | "failure_correctable" | "failure_unsafe" | "ambiguous" | "cannot_assess";

export interface TaskSuccessCertificate {
  readonly schema_version: typeof TASK_SUCCESS_CERTIFICATE_ISSUER_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md";
  readonly certificate_ref: Ref;
  readonly task_ref: Ref;
  readonly verification_request_ref: Ref;
  readonly primitive_ref: Ref;
  readonly result: TaskCertificateResult;
  readonly route_decision: VerificationRouteDecision;
  readonly confidence: number;
  readonly constraint_results: readonly ConstraintVerificationResult[];
  readonly evidence_refs: readonly Ref[];
  readonly policy_ref: Ref;
  readonly truth_boundary_status: TruthBoundaryRecord;
  readonly replay_refs: readonly Ref[];
  readonly issued_at_ms: number;
  readonly prompt_safe_summary: string;
  readonly determinism_hash: string;
}

export interface TaskSuccessCertificateRequest {
  readonly request_ref?: Ref;
  readonly task_ref: Ref;
  readonly verification_request_ref: Ref;
  readonly primitive_ref: Ref;
  readonly policy_ref: Ref;
  readonly aggregation_report: ConstraintAggregationReport;
  readonly truth_boundary_status: TruthBoundaryRecord;
  readonly replay_refs: readonly Ref[];
  readonly issued_at_ms: number;
}

export interface TaskSuccessCertificateIssuerReport {
  readonly schema_version: typeof TASK_SUCCESS_CERTIFICATE_ISSUER_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md";
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly decision: TaskCertificateDecision;
  readonly certificate?: TaskSuccessCertificate;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "task_success_certificate_issuer_report";
  readonly determinism_hash: string;
}

/**
 * Issues replayable verification certificates.
 */
export class TaskSuccessCertificateIssuer {
  /**
   * Creates a certificate after aggregation produces a route decision.
   */
  public issueTaskSuccessCertificate(request: TaskSuccessCertificateRequest): TaskSuccessCertificateIssuerReport {
    const issues: ValidationIssue[] = [];
    validateRequest(request, issues);
    const decision = decide(request, issues);
    const certificate = decision === "rejected" || decision === "blocked" ? undefined : buildCertificate(request);
    const requestRef = sanitizeRef(request.request_ref ?? makeRef("task_certificate_request", request.verification_request_ref));
    const base = {
      schema_version: TASK_SUCCESS_CERTIFICATE_ISSUER_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md" as const,
      report_ref: makeRef("task_certificate_issuer_report", requestRef, decision),
      request_ref: requestRef,
      decision,
      certificate,
      issues: freezeArray(issues),
      ok: certificate !== undefined,
      cognitive_visibility: "task_success_certificate_issuer_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function createTaskSuccessCertificateIssuer(): TaskSuccessCertificateIssuer {
  return new TaskSuccessCertificateIssuer();
}

function buildCertificate(request: TaskSuccessCertificateRequest): TaskSuccessCertificate {
  const result = certificateResultFor(request.aggregation_report);
  const evidenceRefs = uniqueSorted(request.aggregation_report.constraint_results.flatMap((resultItem) => resultItem.evidence_refs));
  const certificateRef = makeRef("task_success_certificate", request.task_ref, request.verification_request_ref, result);
  const base = {
    schema_version: TASK_SUCCESS_CERTIFICATE_ISSUER_SCHEMA_VERSION,
    blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md" as const,
    certificate_ref: certificateRef,
    task_ref: sanitizeRef(request.task_ref),
    verification_request_ref: sanitizeRef(request.verification_request_ref),
    primitive_ref: sanitizeRef(request.primitive_ref),
    result,
    route_decision: request.aggregation_report.route_decision,
    confidence: request.aggregation_report.confidence,
    constraint_results: request.aggregation_report.constraint_results,
    evidence_refs: evidenceRefs,
    policy_ref: sanitizeRef(request.policy_ref),
    truth_boundary_status: Object.freeze({
      ...request.truth_boundary_status,
      audit_refs: uniqueSorted(request.truth_boundary_status.audit_refs.map(sanitizeRef)),
      summary: sanitizeText(request.truth_boundary_status.summary),
    }),
    replay_refs: uniqueSorted(request.replay_refs.map(sanitizeRef)),
    issued_at_ms: request.issued_at_ms,
    prompt_safe_summary: sanitizeText(`Verification certificate ${result} routes task to ${request.aggregation_report.route_decision}.`),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function validateRequest(request: TaskSuccessCertificateRequest, issues: ValidationIssue[]): void {
  validateSafeRef(request.task_ref, "$.task_ref", "HiddenVerificationLeak", issues);
  validateSafeRef(request.verification_request_ref, "$.verification_request_ref", "HiddenVerificationLeak", issues);
  validateSafeRef(request.primitive_ref, "$.primitive_ref", "HiddenVerificationLeak", issues);
  validateSafeRef(request.policy_ref, "$.policy_ref", "HiddenVerificationLeak", issues);
  for (const ref of request.replay_refs) validateSafeRef(ref, "$.replay_refs", "HiddenVerificationLeak", issues);
  if (!Number.isFinite(request.issued_at_ms) || request.issued_at_ms < 0) {
    issues.push(makeIssue("error", "ToleranceInvalid", "$.issued_at_ms", "Certificate timestamp must be finite and nonnegative.", "Use monotonic runtime time."));
  }
  if (request.truth_boundary_status.status !== "runtime_embodied_only") {
    issues.push(makeIssue("error", "TruthBoundaryInvalid", "$.truth_boundary_status.status", "Certificates require a clean runtime truth boundary.", "Strip hidden truth before issuing."));
  }
  if (request.aggregation_report.constraint_results.length === 0) {
    issues.push(makeIssue("error", "ConstraintMissing", "$.aggregation_report.constraint_results", "Certificate must include at least one constraint result.", "Aggregate required constraints first."));
  }
}

function decide(request: TaskSuccessCertificateRequest, issues: readonly ValidationIssue[]): TaskCertificateDecision {
  if (issues.some((issue) => issue.severity === "error")) return "rejected";
  if (request.aggregation_report.decision === "rejected") return "blocked";
  return request.aggregation_report.decision === "success_ready" ? "issued" : "issued_non_success";
}

function certificateResultFor(report: ConstraintAggregationReport): TaskCertificateResult {
  if (report.decision === "success_ready") return "success";
  if (report.decision === "failure_correctable") return "failure_correctable";
  if (report.decision === "unsafe") return "failure_unsafe";
  if (report.decision === "ambiguous") return "ambiguous";
  return "cannot_assess";
}
