/**
 * Repair request contract for Project Mebsuta APIs.
 *
 * Blueprint: `architecture_docs/19_API_SERVICE_BOUNDARIES_AND_DATA_CONTRACTS.md`
 * sections 19.2.5, 19.8.3, 19.9, 19.10, and 19.12.
 *
 * Repair requests bound what can change, forbid goal/safety/truth-budget
 * mutations, and choose a terminal route when repair budget is exhausted.
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
  uniqueApiStrings,
  validateApiRef,
  validateApiRefArray,
  validateApiText,
  validateFiniteApiNumber,
} from "./artifact_envelope";
import type { ApiContractValidationReport, ApiRoute } from "./artifact_envelope";
import type { ContractErrorReport } from "./contract_error_report";

export const REPAIR_REQUEST_CONTRACT_SCHEMA_VERSION = "mebsuta.api.repair_request_contract.v1" as const;

export type RepairScope = "schema_fields" | "provenance_labels" | "fresh_evidence_refs" | "model_response_shape" | "feasibility_parameters" | "route_metadata";
export type ForbiddenRepairChange = "task_goal" | "safety_limits" | "hidden_truth_use" | "retry_budget_increase" | "verification_success_claim" | "service_of_record";

export interface RepairRequestContract {
  readonly schema_version: typeof REPAIR_REQUEST_CONTRACT_SCHEMA_VERSION;
  readonly repair_request_ref: Ref;
  readonly source_error_ref: Ref;
  readonly repair_scope: readonly RepairScope[];
  readonly forbidden_changes: readonly ForbiddenRepairChange[];
  readonly additional_context_refs: readonly Ref[];
  readonly repair_attempts_remaining: number;
  readonly terminal_route_if_failed: Extract<ApiRoute, "HumanReview" | "SafeHold" | "Reject">;
  readonly repair_instruction_summary: string;
  readonly determinism_hash: string;
}

/**
 * Creates a bounded repair request from a contract error report.
 */
export function buildRepairRequestContract(input: {
  readonly repair_request_ref: Ref;
  readonly source_error: ContractErrorReport;
  readonly repair_scope: readonly RepairScope[];
  readonly additional_context_refs?: readonly Ref[];
  readonly repair_attempts_remaining: number;
  readonly terminal_route_if_failed?: Extract<ApiRoute, "HumanReview" | "SafeHold" | "Reject">;
  readonly repair_instruction_summary: string;
}): RepairRequestContract {
  const terminal = input.terminal_route_if_failed ?? terminalRouteForError(input.source_error);
  const base = {
    schema_version: REPAIR_REQUEST_CONTRACT_SCHEMA_VERSION,
    repair_request_ref: input.repair_request_ref,
    source_error_ref: input.source_error.contract_error_ref,
    repair_scope: freezeApiArray([...new Set(input.repair_scope)]),
    forbidden_changes: freezeApiArray(["task_goal", "safety_limits", "hidden_truth_use", "retry_budget_increase", "verification_success_claim", "service_of_record"] as const),
    additional_context_refs: uniqueApiRefs(input.additional_context_refs ?? []),
    repair_attempts_remaining: input.repair_attempts_remaining,
    terminal_route_if_failed: terminal,
    repair_instruction_summary: compactApiText(input.repair_instruction_summary),
  };
  const request = Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  const report = validateRepairRequestContract(request);
  if (!report.ok) {
    throw new RepairRequestContractError("Repair request failed validation.", report.issues);
  }
  return request;
}

export function validateRepairRequestContract(request: RepairRequestContract): ApiContractValidationReport {
  const issues: ValidationIssue[] = [];
  validateApiRef(request.repair_request_ref, "$.repair_request_ref", issues);
  validateApiRef(request.source_error_ref, "$.source_error_ref", issues);
  validateApiRefArray(request.additional_context_refs, "$.additional_context_refs", issues);
  validateFiniteApiNumber(request.repair_attempts_remaining, "$.repair_attempts_remaining", 0, 100, issues);
  validateApiText(request.repair_instruction_summary, "$.repair_instruction_summary", true, issues);
  if (request.repair_scope.length === 0) {
    issues.push(apiIssue("error", "RepairScopeMissing", "$.repair_scope", "Repair scope must name at least one mutable field family.", "Attach a bounded repair scope."));
  }
  if (request.repair_attempts_remaining === 0 && request.terminal_route_if_failed === "Reject") {
    issues.push(apiIssue("warning", "RepairBudgetExhausted", "$.repair_attempts_remaining", "No repair attempts remain.", "Route terminally if another repair fails."));
  }
  return buildApiReport(makeApiRef("repair_request_validation", request.repair_request_ref), issues, issues.some((issue) => issue.severity === "error") ? "Reject" : "Continue");
}

export function consumeRepairAttempt(request: RepairRequestContract): RepairRequestContract {
  const nextRemaining = Math.max(0, request.repair_attempts_remaining - 1);
  const base = {
    ...request,
    repair_attempts_remaining: nextRemaining,
    additional_context_refs: uniqueApiRefs(request.additional_context_refs),
    repair_instruction_summary: compactApiText(request.repair_instruction_summary),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function repairRequestAllowsScope(request: RepairRequestContract, scope: RepairScope): boolean {
  return request.repair_attempts_remaining > 0 && request.repair_scope.includes(scope);
}

function terminalRouteForError(error: ContractErrorReport): Extract<ApiRoute, "HumanReview" | "SafeHold" | "Reject"> {
  if (error.recommended_route === "SafeHold" || error.error_severity === "critical") {
    return "SafeHold";
  }
  if (error.recommended_route === "HumanReview" || error.error_class === "model_failure") {
    return "HumanReview";
  }
  return "Reject";
}

export class RepairRequestContractError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "RepairRequestContractError";
    this.issues = freezeApiArray(issues);
  }
}

export const REPAIR_REQUEST_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: REPAIR_REQUEST_CONTRACT_SCHEMA_VERSION,
  blueprint: API_BLUEPRINT_REF,
  sections: freezeApiArray(["19.2.5", "19.8.3", "19.9", "19.10", "19.12"]),
  component: "RepairRequestContract",
});
