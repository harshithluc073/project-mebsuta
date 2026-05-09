/**
 * Service handoff protocol for Project Mebsuta APIs.
 *
 * Blueprint: `architecture_docs/19_API_SERVICE_BOUNDARIES_AND_DATA_CONTRACTS.md`
 * sections 19.2, 19.6, 19.7, 19.8, 19.9, and 19.12.
 *
 * This protocol validates source and destination services, required artifacts,
 * route decisions, and fail-closed routing before cross-service work continues.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  API_BLUEPRINT_REF,
  apiIssue,
  buildApiReport,
  buildResultRouteContract,
  compactApiText,
  freezeApiArray,
  makeApiRef,
  routeForIssues,
  uniqueApiRefs,
  validateApiRef,
  validateApiRefArray,
  validateApiText,
} from "./artifact_envelope";
import type { ApiContractValidationReport, ApiRoute, ApiServiceRef, ArtifactEnvelope, ResultRouteContract } from "./artifact_envelope";
import type { ServiceEventEnvelope } from "./service_event_bus_contract";

export const SERVICE_HANDOFF_PROTOCOL_SCHEMA_VERSION = "mebsuta.api.service_handoff_protocol.v1" as const;

export type HandoffDecision = "accepted" | "accepted_with_restrictions" | "repair_required" | "reobserve_required" | "rejected" | "safe_hold_required" | "human_review_required";

export interface ServiceHandoffRequest {
  readonly handoff_request_ref: Ref;
  readonly source_service: ApiServiceRef;
  readonly destination_service: ApiServiceRef;
  readonly source_event: ServiceEventEnvelope;
  readonly carried_artifacts: readonly ArtifactEnvelope[];
  readonly required_artifact_refs: readonly Ref[];
  readonly policy_refs: readonly Ref[];
  readonly reason_summary: string;
}

export interface ServiceHandoffDecision {
  readonly handoff_decision_ref: Ref;
  readonly request_ref: Ref;
  readonly decision: HandoffDecision;
  readonly route_contract: ResultRouteContract;
  readonly accepted_artifact_refs: readonly Ref[];
  readonly missing_artifact_refs: readonly Ref[];
  readonly rejected_artifact_refs: readonly Ref[];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

/**
 * Evaluates a cross-service handoff and returns the deterministic route.
 */
export function evaluateServiceHandoff(request: ServiceHandoffRequest): ServiceHandoffDecision {
  const issues = validateHandoffRequest(request);
  const carriedRefs = new Set(request.carried_artifacts.map((artifact) => artifact.artifact_ref));
  const missing = request.required_artifact_refs.filter((ref) => !carriedRefs.has(ref));
  const rejected = request.carried_artifacts
    .filter((artifact) => artifact.validation_status === "rejected" || artifact.validation_status === "quarantined")
    .map((artifact) => artifact.artifact_ref);
  if (missing.length > 0) {
    issues.push(apiIssue("error", "HandoffArtifactsMissing", "$.required_artifact_refs", "Required handoff artifacts are missing.", "Attach the required artifact envelopes before handoff."));
  }
  if (rejected.length > 0) {
    issues.push(apiIssue("error", "HandoffCarriesRejectedArtifact", "$.carried_artifacts", "Handoff carries rejected or quarantined artifacts.", "Repair, reobserve, or quarantine before destination service work."));
  }
  const decision = decideHandoff(issues, request);
  const route = routeForDecision(decision);
  const routeContract = buildResultRouteContract({
    route_decision_ref: makeApiRef("handoff_route", request.handoff_request_ref, decision),
    source_artifact_ref: request.source_event.artifact_envelope.artifact_ref,
    current_state_ref: makeApiRef("service", request.source_service),
    next_state: route,
    reason_summary: request.reason_summary,
    required_followup_artifacts: missing,
    safety_status: route === "SafeHold" ? "safe_hold" : route === "HumanReview" ? "human_review" : decision === "accepted_with_restrictions" ? "restricted" : "normal",
    audit_refs: uniqueApiRefs([request.handoff_request_ref, request.source_event.service_event_ref, ...request.policy_refs]),
  });
  const base = {
    handoff_decision_ref: makeApiRef("handoff_decision", request.handoff_request_ref, decision),
    request_ref: request.handoff_request_ref,
    decision,
    route_contract: routeContract,
    accepted_artifact_refs: decision === "accepted" || decision === "accepted_with_restrictions" ? uniqueApiRefs(request.carried_artifacts.map((artifact) => artifact.artifact_ref)) : freezeApiArray([]),
    missing_artifact_refs: uniqueApiRefs(missing),
    rejected_artifact_refs: uniqueApiRefs(rejected),
    issues: freezeApiArray(issues),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateServiceHandoffDecision(decision: ServiceHandoffDecision): ApiContractValidationReport {
  const issues: ValidationIssue[] = [];
  validateApiRef(decision.handoff_decision_ref, "$.handoff_decision_ref", issues);
  validateApiRef(decision.request_ref, "$.request_ref", issues);
  if ((decision.decision === "accepted" || decision.decision === "accepted_with_restrictions") && decision.missing_artifact_refs.length > 0) {
    issues.push(apiIssue("error", "AcceptedHandoffMissingArtifacts", "$.missing_artifact_refs", "Accepted handoff cannot have missing artifacts.", "Repair the handoff decision."));
  }
  return buildApiReport(makeApiRef("handoff_decision_report", decision.handoff_decision_ref), issues, routeForIssues(issues));
}

function validateHandoffRequest(request: ServiceHandoffRequest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateApiRef(request.handoff_request_ref, "$.handoff_request_ref", issues);
  validateApiText(request.reason_summary, "$.reason_summary", true, issues);
  validateApiRefArray(request.required_artifact_refs, "$.required_artifact_refs", issues);
  validateApiRefArray(request.policy_refs, "$.policy_refs", issues);
  if (request.source_service !== request.source_event.producer_service) {
    issues.push(apiIssue("error", "HandoffSourceMismatch", "$.source_service", "Handoff source must match event producer.", "Route handoff from the producing service."));
  }
  if (!request.source_event.consumer_services.includes(request.destination_service)) {
    issues.push(apiIssue("warning", "DestinationNotDeclaredConsumer", "$.destination_service", "Destination service is not declared as an event consumer.", "Add destination to event consumers or reroute."));
  }
  return issues;
}

function decideHandoff(issues: readonly ValidationIssue[], request: ServiceHandoffRequest): HandoffDecision {
  if (issues.some((issue) => issue.code.includes("Rejected") || issue.code.includes("Quarantine"))) {
    return "safe_hold_required";
  }
  if (issues.some((issue) => issue.severity === "error" && issue.code.includes("Missing"))) {
    return "repair_required";
  }
  if (issues.some((issue) => issue.severity === "error")) {
    return "rejected";
  }
  if (request.source_event.priority === "safety_critical" && request.destination_service === "agent_orchestration") {
    return "accepted_with_restrictions";
  }
  return issues.length > 0 ? "accepted_with_restrictions" : "accepted";
}

function routeForDecision(decision: HandoffDecision): ApiRoute {
  switch (decision) {
    case "accepted":
    case "accepted_with_restrictions":
      return "Continue";
    case "repair_required":
      return "Repair";
    case "reobserve_required":
      return "Reobserve";
    case "safe_hold_required":
      return "SafeHold";
    case "human_review_required":
      return "HumanReview";
    case "rejected":
      return "Reject";
  }
}

export const SERVICE_HANDOFF_PROTOCOL_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: SERVICE_HANDOFF_PROTOCOL_SCHEMA_VERSION,
  blueprint: API_BLUEPRINT_REF,
  sections: freezeApiArray(["19.2", "19.6", "19.7", "19.8", "19.9", "19.12"]),
  component: "ServiceHandoffProtocol",
});
