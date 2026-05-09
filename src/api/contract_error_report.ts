/**
 * Contract error report for Project Mebsuta APIs.
 *
 * Blueprint: `architecture_docs/19_API_SERVICE_BOUNDARIES_AND_DATA_CONTRACTS.md`
 * sections 19.2.5, 19.8.1, 19.8.2, 19.9.5, 19.10, 19.11, and 19.12.
 *
 * Contract errors fail closed into repair, reobserve, reject, quarantine,
 * SafeHold, HumanReview, or QA-failure routes with audit-preserving refs.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  API_BLUEPRINT_REF,
  apiIssue,
  buildApiReport,
  compactApiText,
  freezeApiArray,
  makeApiRef,
  uniqueApiRefs,
  validateApiRef,
  validateApiRefArray,
  validateApiText,
} from "./artifact_envelope";
import type { ApiContractValidationReport, ApiRoute } from "./artifact_envelope";

export const CONTRACT_ERROR_REPORT_SCHEMA_VERSION = "mebsuta.api.contract_error_report.v1" as const;

export type ContractErrorClass = "schema_invalid" | "provenance_violation" | "stale_evidence" | "ambiguous_evidence" | "safety_violation" | "feasibility_failure" | "model_failure" | "sensor_failure" | "memory_contradiction" | "qa_mismatch";
export type ContractErrorSeverity = "low" | "medium" | "high" | "critical";

export interface ContractErrorReport {
  readonly schema_version: typeof CONTRACT_ERROR_REPORT_SCHEMA_VERSION;
  readonly contract_error_ref: Ref;
  readonly source_artifact_ref: Ref;
  readonly error_class: ContractErrorClass;
  readonly error_severity: ContractErrorSeverity;
  readonly violated_contract_ref: Ref;
  readonly human_readable_reason: string;
  readonly repair_possible: boolean;
  readonly recommended_route: ApiRoute;
  readonly audit_refs: readonly Ref[];
  readonly determinism_hash: string;
}

/**
 * Builds a contract error report and derives a fail-closed route when omitted.
 */
export function buildContractErrorReport(input: Omit<ContractErrorReport, "schema_version" | "recommended_route" | "determinism_hash"> & {
  readonly recommended_route?: ApiRoute;
}): ContractErrorReport {
  const route = input.recommended_route ?? routeForContractError(input.error_class, input.error_severity, input.repair_possible);
  const base = {
    schema_version: CONTRACT_ERROR_REPORT_SCHEMA_VERSION,
    contract_error_ref: input.contract_error_ref,
    source_artifact_ref: input.source_artifact_ref,
    error_class: input.error_class,
    error_severity: input.error_severity,
    violated_contract_ref: input.violated_contract_ref,
    human_readable_reason: compactApiText(input.human_readable_reason),
    repair_possible: input.repair_possible,
    recommended_route: route,
    audit_refs: uniqueApiRefs([input.source_artifact_ref, input.violated_contract_ref, ...input.audit_refs]),
  };
  const report = Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  const validation = validateContractErrorReport(report);
  if (!validation.ok) {
    throw new ContractErrorReportError("Contract error report failed validation.", validation.issues);
  }
  return report;
}

export function validateContractErrorReport(report: ContractErrorReport): ApiContractValidationReport {
  const issues: ValidationIssue[] = [];
  validateApiRef(report.contract_error_ref, "$.contract_error_ref", issues);
  validateApiRef(report.source_artifact_ref, "$.source_artifact_ref", issues);
  validateApiRef(report.violated_contract_ref, "$.violated_contract_ref", issues);
  validateApiText(report.human_readable_reason, "$.human_readable_reason", true, issues);
  validateApiRefArray(report.audit_refs, "$.audit_refs", issues);
  if (!report.repair_possible && report.recommended_route === "Repair") {
    issues.push(apiIssue("error", "RepairRouteInvalid", "$.recommended_route", "Repair route cannot be recommended when repair is not permitted.", "Use reject, SafeHold, HumanReview, or QA failure."));
  }
  if (report.error_severity === "critical" && (report.recommended_route === "Continue" || report.recommended_route === "Repair")) {
    issues.push(apiIssue("error", "CriticalErrorRouteTooWeak", "$.recommended_route", "Critical errors require a terminal or review route.", "Use SafeHold, HumanReview, Quarantine, or QA failure."));
  }
  return buildApiReport(makeApiRef("contract_error_report_validation", report.contract_error_ref), issues, report.recommended_route);
}

export function routeForContractError(errorClass: ContractErrorClass, severity: ContractErrorSeverity, repairPossible: boolean): ApiRoute {
  if (errorClass === "qa_mismatch") {
    return "QaFailure";
  }
  if (errorClass === "provenance_violation") {
    return severity === "critical" ? "SafeHold" : "Quarantine";
  }
  if (errorClass === "safety_violation") {
    return severity === "critical" || severity === "high" ? "SafeHold" : "Reject";
  }
  if (errorClass === "stale_evidence" || errorClass === "ambiguous_evidence" || errorClass === "sensor_failure") {
    return "Reobserve";
  }
  if (errorClass === "model_failure" || errorClass === "schema_invalid" || errorClass === "feasibility_failure") {
    return repairPossible ? "Repair" : "Reject";
  }
  if (errorClass === "memory_contradiction") {
    return "Reobserve";
  }
  return severity === "critical" ? "HumanReview" : "Reject";
}

export class ContractErrorReportError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "ContractErrorReportError";
    this.issues = freezeApiArray(issues);
  }
}

export const CONTRACT_ERROR_REPORT_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: CONTRACT_ERROR_REPORT_SCHEMA_VERSION,
  blueprint: API_BLUEPRINT_REF,
  sections: freezeApiArray(["19.2.5", "19.8.1", "19.8.2", "19.9.5", "19.10", "19.11", "19.12"]),
  component: "ContractErrorReport",
});
