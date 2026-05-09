/**
 * API version compatibility guard for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/19_API_SERVICE_BOUNDARIES_AND_DATA_CONTRACTS.md`
 * sections 19.2.4, 19.10, 19.11, and 19.12.
 *
 * The guard compares producer and consumer schema contracts, rejects unknown
 * critical fields that affect safety, and records migration requirements.
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
  routeForIssues,
  uniqueApiRefs,
  uniqueApiStrings,
  validateApiRef,
  validateApiText,
} from "./artifact_envelope";
import type { ApiContractValidationReport, ApiRoute, ArtifactEnvelope } from "./artifact_envelope";

export const API_VERSION_COMPATIBILITY_GUARD_SCHEMA_VERSION = "mebsuta.api.version_compatibility_guard.v1" as const;

export type CompatibilityRisk = "prompt_contract" | "safety_policy" | "verification_policy" | "sensor_schema" | "memory_schema" | "controller_profile" | "embodiment_profile" | "qa_scenario";
export type CompatibilityDecision = "compatible" | "compatible_with_migration" | "regression_required" | "rejected";

export interface VersionedContractDescriptor {
  readonly contract_ref: Ref;
  readonly schema_ref: Ref;
  readonly semantic_version: string;
  readonly compatibility_risk: CompatibilityRisk;
  readonly critical_field_refs: readonly Ref[];
  readonly replay_migration_available: boolean;
  readonly qa_regression_required: boolean;
}

export interface VersionCompatibilityRequest {
  readonly compatibility_request_ref: Ref;
  readonly artifact_envelope: ArtifactEnvelope;
  readonly producer_contract: VersionedContractDescriptor;
  readonly consumer_contract: VersionedContractDescriptor;
  readonly observed_unknown_field_refs: readonly Ref[];
  readonly policy_change_refs: readonly Ref[];
}

export interface VersionCompatibilityDecision {
  readonly compatibility_decision_ref: Ref;
  readonly request_ref: Ref;
  readonly decision: CompatibilityDecision;
  readonly recommended_route: ApiRoute;
  readonly migration_required: boolean;
  readonly qa_regression_required: boolean;
  readonly blocked_field_refs: readonly Ref[];
  readonly replay_migration_refs: readonly Ref[];
  readonly reason: string;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

/**
 * Evaluates schema/version compatibility between producer and consumer.
 */
export function evaluateApiVersionCompatibility(request: VersionCompatibilityRequest): VersionCompatibilityDecision {
  const issues = validateCompatibilityRequest(request);
  const producerMajor = majorVersion(request.producer_contract.semantic_version);
  const consumerMajor = majorVersion(request.consumer_contract.semantic_version);
  const majorMismatch = producerMajor !== consumerMajor;
  const unknownCritical = request.observed_unknown_field_refs.filter((ref) => request.producer_contract.critical_field_refs.includes(ref));
  const policyChanged = request.policy_change_refs.length > 0;
  const decision: CompatibilityDecision = unknownCritical.length > 0
    ? "rejected"
    : majorMismatch && request.producer_contract.replay_migration_available
      ? "compatible_with_migration"
      : majorMismatch
        ? "regression_required"
        : policyChanged || request.consumer_contract.qa_regression_required || request.producer_contract.qa_regression_required
          ? "regression_required"
          : "compatible";
  const route: ApiRoute = decision === "rejected" ? "Reject" : decision === "regression_required" ? "HumanReview" : "Continue";
  const base = {
    compatibility_decision_ref: makeApiRef("api_version_compatibility", request.compatibility_request_ref, decision),
    request_ref: request.compatibility_request_ref,
    decision,
    recommended_route: route,
    migration_required: decision === "compatible_with_migration",
    qa_regression_required: decision === "regression_required" || policyChanged,
    blocked_field_refs: uniqueApiRefs(unknownCritical),
    replay_migration_refs: request.producer_contract.replay_migration_available ? uniqueApiRefs([request.producer_contract.contract_ref, request.consumer_contract.contract_ref]) : freezeApiArray([]),
    reason: compactApiText(reasonForCompatibility(decision, majorMismatch, unknownCritical.length, policyChanged)),
    issues: freezeApiArray(issues),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateVersionCompatibilityDecision(decision: VersionCompatibilityDecision): ApiContractValidationReport {
  const issues: ValidationIssue[] = [];
  validateApiRef(decision.compatibility_decision_ref, "$.compatibility_decision_ref", issues);
  validateApiRef(decision.request_ref, "$.request_ref", issues);
  validateApiText(decision.reason, "$.reason", true, issues);
  if (decision.decision === "compatible" && (decision.migration_required || decision.qa_regression_required || decision.blocked_field_refs.length > 0)) {
    issues.push(apiIssue("error", "CompatibleDecisionHasBlockingMetadata", "$.decision", "Compatible decision cannot carry migration, regression, or blocked-field requirements.", "Downgrade the compatibility decision."));
  }
  return buildApiReport(makeApiRef("api_version_compatibility_decision_report", decision.compatibility_decision_ref), issues, routeForIssues(issues));
}

function validateCompatibilityRequest(request: VersionCompatibilityRequest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateApiRef(request.compatibility_request_ref, "$.compatibility_request_ref", issues);
  validateDescriptor(request.producer_contract, "$.producer_contract", issues);
  validateDescriptor(request.consumer_contract, "$.consumer_contract", issues);
  for (const [index, ref] of request.observed_unknown_field_refs.entries()) {
    validateApiRef(ref, `$.observed_unknown_field_refs[${index}]`, issues);
  }
  for (const [index, ref] of request.policy_change_refs.entries()) {
    validateApiRef(ref, `$.policy_change_refs[${index}]`, issues);
  }
  if (request.artifact_envelope.schema_ref !== request.producer_contract.schema_ref) {
    issues.push(apiIssue("error", "ArtifactSchemaProducerMismatch", "$.artifact_envelope.schema_ref", "Artifact schema must match the producer contract schema.", "Migrate or regenerate the artifact envelope."));
  }
  return issues;
}

function validateDescriptor(descriptor: VersionedContractDescriptor, path: string, issues: ValidationIssue[]): void {
  validateApiRef(descriptor.contract_ref, `${path}.contract_ref`, issues);
  validateApiRef(descriptor.schema_ref, `${path}.schema_ref`, issues);
  validateApiText(descriptor.semantic_version, `${path}.semantic_version`, true, issues);
  if (!/^\d+\.\d+\.\d+$/.test(descriptor.semantic_version)) {
    issues.push(apiIssue("error", "SemanticVersionInvalid", `${path}.semantic_version`, "Semantic version must use major.minor.patch numeric form.", "Use a version such as 1.0.0."));
  }
  for (const [index, ref] of descriptor.critical_field_refs.entries()) {
    validateApiRef(ref, `${path}.critical_field_refs[${index}]`, issues);
  }
}

function majorVersion(version: string): number {
  const [major] = version.split(".");
  const parsed = Number(major);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : -1;
}

function reasonForCompatibility(decision: CompatibilityDecision, majorMismatch: boolean, unknownCriticalCount: number, policyChanged: boolean): string {
  if (decision === "rejected") {
    return `Rejected compatibility: ${unknownCriticalCount} unknown critical fields affect service behavior.`;
  }
  if (decision === "compatible_with_migration") {
    return "Compatible with replay migration because major versions differ and migration is available.";
  }
  if (decision === "regression_required") {
    return majorMismatch || policyChanged ? "QA regression is required for version or policy change." : "QA regression is required by contract descriptor.";
  }
  return "Producer and consumer contracts are compatible.";
}

export const API_VERSION_COMPATIBILITY_GUARD_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: API_VERSION_COMPATIBILITY_GUARD_SCHEMA_VERSION,
  blueprint: API_BLUEPRINT_REF,
  sections: freezeApiArray(["19.2.4", "19.10", "19.11", "19.12"]),
  component: "ApiVersionCompatibilityGuard",
});
