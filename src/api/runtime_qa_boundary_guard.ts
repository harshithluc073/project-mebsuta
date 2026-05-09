/**
 * Runtime versus QA boundary guard for Project Mebsuta APIs.
 *
 * Blueprint: `architecture_docs/19_API_SERVICE_BOUNDARIES_AND_DATA_CONTRACTS.md`
 * sections 19.1, 19.2, 19.4, 19.9.5, 19.11, and 19.12.
 *
 * This guard enforces that QA truth, benchmark labels, exact simulator state,
 * and restricted diagnostics remain offline and never feed runtime cognition.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  API_BLUEPRINT_REF,
  apiIssue,
  buildApiReport,
  compactApiText,
  containsForbiddenApiText,
  freezeApiArray,
  makeApiRef,
  routeForIssues,
  uniqueApiRefs,
  uniqueApiStrings,
  validateApiRef,
  validateApiText,
} from "./artifact_envelope";
import type { ApiContractValidationReport, ApiRoute, ApiVisibilityClass, ArtifactEnvelope } from "./artifact_envelope";
import type { ProvenanceManifest } from "./provenance_manifest_contract";

export const RUNTIME_QA_BOUNDARY_GUARD_SCHEMA_VERSION = "mebsuta.api.runtime_qa_boundary_guard.v1" as const;

export type BoundaryDestination = "runtime_cognition" | "runtime_validator" | "runtime_controller" | "developer_dashboard" | "qa_harness" | "offline_replay";
export type QaBoundaryDecision = "allowed" | "allowed_with_redaction" | "quarantined" | "rejected";

export interface RuntimeQaBoundaryRequest {
  readonly boundary_request_ref: Ref;
  readonly destination: BoundaryDestination;
  readonly artifact_envelope: ArtifactEnvelope;
  readonly provenance_manifest: ProvenanceManifest;
  readonly payload_summary: string;
  readonly payload_keys: readonly string[];
}

export interface RuntimeQaBoundaryDecision {
  readonly boundary_decision_ref: Ref;
  readonly request_ref: Ref;
  readonly decision: QaBoundaryDecision;
  readonly recommended_route: ApiRoute;
  readonly approved_visibility_class: ApiVisibilityClass;
  readonly redacted_keys: readonly string[];
  readonly blocked_keys: readonly string[];
  readonly reason: string;
  readonly audit_refs: readonly Ref[];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

/**
 * Classifies whether an artifact may cross to a runtime or QA destination.
 */
export function evaluateRuntimeQaBoundary(request: RuntimeQaBoundaryRequest): RuntimeQaBoundaryDecision {
  const issues = validateBoundaryRequest(request);
  const restrictedKeys = request.payload_keys.filter((key) => containsForbiddenApiText(key));
  const runtimeDestination = request.destination === "runtime_cognition" || request.destination === "runtime_validator" || request.destination === "runtime_controller";
  const qaOnly = request.provenance_manifest.truth_boundary_status === "qa_truth_only" || request.artifact_envelope.visibility_class === "qa_offline";
  const violation = request.provenance_manifest.truth_boundary_status === "truth_boundary_violation" || request.provenance_manifest.forbidden_source_detected;
  const decision: QaBoundaryDecision = violation && runtimeDestination
    ? "quarantined"
    : qaOnly && runtimeDestination
      ? "rejected"
      : restrictedKeys.length > 0
        ? "allowed_with_redaction"
        : "allowed";
  const route: ApiRoute = decision === "quarantined" ? "Quarantine" : decision === "rejected" ? "Reject" : "Continue";
  const redactedKeys = decision === "allowed_with_redaction" ? restrictedKeys : freezeApiArray([]);
  const blockedKeys = decision === "quarantined" || decision === "rejected" ? restrictedKeys.length > 0 ? restrictedKeys : request.payload_keys : freezeApiArray([]);
  const base = {
    boundary_decision_ref: makeApiRef("runtime_qa_boundary", request.boundary_request_ref, decision),
    request_ref: request.boundary_request_ref,
    decision,
    recommended_route: route,
    approved_visibility_class: visibilityForDecision(decision, request.destination, request.artifact_envelope.visibility_class),
    redacted_keys: uniqueApiStrings(redactedKeys),
    blocked_keys: uniqueApiStrings(blockedKeys),
    reason: compactApiText(reasonForDecision(decision, request.destination)),
    audit_refs: uniqueApiRefs([request.boundary_request_ref, request.artifact_envelope.artifact_ref, request.provenance_manifest.provenance_manifest_ref]),
    issues: freezeApiArray(issues),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateRuntimeQaBoundaryDecision(decision: RuntimeQaBoundaryDecision): ApiContractValidationReport {
  const issues: ValidationIssue[] = [];
  validateApiRef(decision.boundary_decision_ref, "$.boundary_decision_ref", issues);
  validateApiRef(decision.request_ref, "$.request_ref", issues);
  validateApiText(decision.reason, "$.reason", true, issues);
  if (decision.decision === "allowed" && decision.blocked_keys.length > 0) {
    issues.push(apiIssue("error", "AllowedBoundaryHasBlockedKeys", "$.blocked_keys", "Allowed boundary decision cannot include blocked keys.", "Change the boundary decision or clear blocked keys."));
  }
  return buildApiReport(makeApiRef("runtime_qa_boundary_decision_report", decision.boundary_decision_ref), issues, routeForIssues(issues));
}

function validateBoundaryRequest(request: RuntimeQaBoundaryRequest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateApiRef(request.boundary_request_ref, "$.boundary_request_ref", issues);
  validateApiText(request.payload_summary, "$.payload_summary", false, issues);
  for (const [index, key] of request.payload_keys.entries()) {
    validateApiText(key, `$.payload_keys[${index}]`, true, issues);
  }
  if (request.destination === "runtime_cognition" && request.provenance_manifest.cognitive_visibility !== "allowed") {
    issues.push(apiIssue("error", "CognitiveDestinationNotAllowed", "$.destination", "Destination requires cognitive-visible provenance.", "Redact, summarize, or route away from runtime cognition."));
  }
  if (request.destination !== "qa_harness" && request.provenance_manifest.qa_visibility !== "not_allowed" && request.artifact_envelope.visibility_class === "qa_offline") {
    issues.push(apiIssue("error", "QaOfflineArtifactInRuntimePath", "$.artifact_envelope.visibility_class", "QA-offline artifacts cannot enter runtime paths.", "Keep QA artifacts in offline harness or replay."));
  }
  return issues;
}

function visibilityForDecision(decision: QaBoundaryDecision, destination: BoundaryDestination, current: ApiVisibilityClass): ApiVisibilityClass {
  if (decision === "quarantined") {
    return "restricted_quarantine";
  }
  if (destination === "qa_harness" || destination === "offline_replay") {
    return "qa_offline";
  }
  if (decision === "allowed_with_redaction") {
    return "redacted";
  }
  return current === "qa_offline" ? "developer_observability" : current;
}

function reasonForDecision(decision: QaBoundaryDecision, destination: BoundaryDestination): string {
  switch (decision) {
    case "allowed":
      return `Artifact is allowed for ${destination}.`;
    case "allowed_with_redaction":
      return `Artifact may enter ${destination} only after key redaction.`;
    case "quarantined":
      return `Artifact is quarantined before ${destination} due to truth-boundary risk.`;
    case "rejected":
      return `Artifact is rejected for ${destination} because QA-only data cannot enter runtime.`;
  }
}

export const RUNTIME_QA_BOUNDARY_GUARD_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: RUNTIME_QA_BOUNDARY_GUARD_SCHEMA_VERSION,
  blueprint: API_BLUEPRINT_REF,
  sections: freezeApiArray(["19.1", "19.2", "19.4", "19.9.5", "19.11", "19.12"]),
  component: "RuntimeQaBoundaryGuard",
});
