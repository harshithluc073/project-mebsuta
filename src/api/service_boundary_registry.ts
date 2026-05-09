/**
 * Service boundary registry for Project Mebsuta APIs.
 *
 * Blueprint: `architecture_docs/19_API_SERVICE_BOUNDARIES_AND_DATA_CONTRACTS.md`
 * sections 19.2, 19.3, 19.6, 19.7, 19.10, and 19.12.
 *
 * The registry maps artifact classes to a single service of record and validates
 * that service ownership does not drift across cross-service handoffs.
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
import type { ApiContractValidationReport, ApiServiceRef, ArtifactEnvelope, ArtifactType } from "./artifact_envelope";

export const SERVICE_BOUNDARY_REGISTRY_SCHEMA_VERSION = "mebsuta.api.service_boundary_registry.v1" as const;

export interface ServiceBoundaryDefinition {
  readonly service_ref: ApiServiceRef;
  readonly boundary_ref: Ref;
  readonly primary_responsibilities: readonly string[];
  readonly does_not_own: readonly string[];
  readonly owned_artifact_types: readonly ArtifactType[];
  readonly allowed_consumers: readonly ApiServiceRef[];
  readonly boundary_rule_refs: readonly Ref[];
  readonly deterministic_authority: boolean;
  readonly qa_truth_allowed: boolean;
  readonly determinism_hash: string;
}

export interface ServiceOwnershipDecision {
  readonly decision_ref: Ref;
  readonly artifact_ref: Ref;
  readonly artifact_type: ArtifactType;
  readonly declared_service: ApiServiceRef;
  readonly service_of_record: ApiServiceRef;
  readonly decision: "owner_confirmed" | "owner_mismatch" | "unregistered_artifact_type";
  readonly consumer_service_refs: readonly ApiServiceRef[];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

/**
 * Deterministic registry for File 19 service-of-record checks.
 */
export class ServiceBoundaryRegistry {
  private readonly boundaries = new Map<ApiServiceRef, ServiceBoundaryDefinition>();
  private readonly artifactOwners = new Map<ArtifactType, ApiServiceRef>();

  public registerBoundary(definition: Omit<ServiceBoundaryDefinition, "determinism_hash">): ServiceBoundaryDefinition {
    const normalized = normalizeBoundary(definition);
    const report = validateBoundary(normalized);
    if (!report.ok) {
      throw new ServiceBoundaryRegistryError("Service boundary definition failed validation.", report.issues);
    }
    this.boundaries.set(normalized.service_ref, normalized);
    for (const artifactType of normalized.owned_artifact_types) {
      this.artifactOwners.set(artifactType, normalized.service_ref);
    }
    return normalized;
  }

  public getBoundary(serviceRef: ApiServiceRef): ServiceBoundaryDefinition | undefined {
    return this.boundaries.get(serviceRef);
  }

  public serviceOfRecord(artifactType: ArtifactType): ApiServiceRef | undefined {
    return this.artifactOwners.get(artifactType);
  }

  public validateEnvelopeOwnership(envelope: ArtifactEnvelope, consumerServiceRefs: readonly ApiServiceRef[]): ServiceOwnershipDecision {
    const issues: ValidationIssue[] = [];
    const owner = this.artifactOwners.get(envelope.artifact_type);
    const decision: ServiceOwnershipDecision["decision"] = owner === undefined
      ? "unregistered_artifact_type"
      : owner === envelope.service_of_record
        ? "owner_confirmed"
        : "owner_mismatch";
    if (owner === undefined) {
      issues.push(apiIssue("error", "ArtifactOwnerMissing", "$.artifact_type", "No service of record is registered for this artifact type.", "Register the artifact owner before publication."));
    } else if (owner !== envelope.service_of_record) {
      issues.push(apiIssue("error", "ArtifactOwnerMismatch", "$.service_of_record", "Declared service does not own this artifact type.", "Use the registered service of record."));
    }
    for (const [index, serviceRef] of consumerServiceRefs.entries()) {
      if (!this.boundaries.has(serviceRef)) {
        issues.push(apiIssue("warning", "ConsumerBoundaryMissing", `$.consumer_service_refs[${index}]`, "Consumer service is not registered.", "Register the consumer boundary for complete auditability."));
      }
    }
    const base = {
      decision_ref: makeApiRef("service_ownership_decision", envelope.artifact_ref, decision),
      artifact_ref: envelope.artifact_ref,
      artifact_type: envelope.artifact_type,
      declared_service: envelope.service_of_record,
      service_of_record: owner ?? envelope.service_of_record,
      decision,
      consumer_service_refs: freezeApiArray(consumerServiceRefs),
      issues: freezeApiArray(issues),
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }

  public listBoundaries(): readonly ServiceBoundaryDefinition[] {
    return freezeApiArray([...this.boundaries.values()].sort((left, right) => left.service_ref.localeCompare(right.service_ref)));
  }
}

export function createDefaultServiceBoundaryRegistry(): ServiceBoundaryRegistry {
  const registry = new ServiceBoundaryRegistry();
  for (const boundary of defaultBoundaryDefinitions()) {
    registry.registerBoundary(boundary);
  }
  return registry;
}

function normalizeBoundary(definition: Omit<ServiceBoundaryDefinition, "determinism_hash">): ServiceBoundaryDefinition {
  const base = {
    ...definition,
    primary_responsibilities: uniqueApiStrings(definition.primary_responsibilities),
    does_not_own: uniqueApiStrings(definition.does_not_own),
    owned_artifact_types: freezeApiArray([...new Set(definition.owned_artifact_types)]),
    allowed_consumers: freezeApiArray([...new Set(definition.allowed_consumers)]),
    boundary_rule_refs: uniqueApiRefs(definition.boundary_rule_refs),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function validateBoundary(definition: ServiceBoundaryDefinition): ApiContractValidationReport {
  const issues: ValidationIssue[] = [];
  validateApiRef(definition.boundary_ref, "$.boundary_ref", issues);
  for (const [index, text] of definition.primary_responsibilities.entries()) {
    validateApiText(text, `$.primary_responsibilities[${index}]`, true, issues);
  }
  for (const [index, text] of definition.does_not_own.entries()) {
    validateApiText(text, `$.does_not_own[${index}]`, true, issues);
  }
  if (definition.owned_artifact_types.length === 0) {
    issues.push(apiIssue("warning", "BoundaryOwnsNoArtifacts", "$.owned_artifact_types", "Boundary owns no artifact types.", "Confirm that this is a pure consumer service."));
  }
  return buildApiReport(makeApiRef("service_boundary_report", definition.service_ref), issues, routeForIssues(issues));
}

function defaultBoundaryDefinitions(): readonly Omit<ServiceBoundaryDefinition, "determinism_hash">[] {
  return freezeApiArray([
    boundary("simulation_physics", ["simulation_step", "scenario_spec"], ["sensor_bus", "control_execution", "qa_scenario"], true, true),
    boundary("sensor_bus", ["sensor_packet", "sensor_bundle"], ["perception", "acoustic", "observability_tts"], true, false),
    boundary("perception", ["perception_summary"], ["agent_orchestration", "verification", "rag_memory", "observability_tts"], false, false),
    boundary("acoustic", ["audio_event"], ["agent_orchestration", "verification", "oops_correction", "safety_guardrail"], false, false),
    boundary("gemini_adapter", ["prompt_bundle", "model_response"], ["prompt_contract", "agent_orchestration", "observability_tts"], false, false),
    boundary("prompt_contract", ["cognitive_plan"], ["agent_orchestration", "safety_guardrail", "oops_correction"], true, false),
    boundary("agent_orchestration", ["route_decision"], ["safety_guardrail", "control_execution", "observability_tts"], true, false),
    boundary("safety_guardrail", ["safety_validation_report", "safe_hold_state"], ["agent_orchestration", "control_execution", "observability_tts"], true, false),
    boundary("control_execution", ["execution_command", "control_telemetry"], ["simulation_physics", "verification", "safety_guardrail"], true, false),
    boundary("manipulation_primitive", ["manipulation_primitive"], ["control_execution", "verification", "oops_correction"], true, false),
    boundary("verification", ["verification_certificate"], ["agent_orchestration", "rag_memory", "oops_correction", "observability_tts"], true, false),
    boundary("oops_correction", ["oops_episode", "correction_plan"], ["gemini_adapter", "safety_guardrail", "control_execution"], true, false),
    boundary("rag_memory", ["memory_record"], ["agent_orchestration", "gemini_adapter", "observability_tts"], true, false),
    boundary("observability_tts", ["tts_playback"], ["acoustic", "qa_scenario"], false, false),
    boundary("qa_scenario", ["qa_scorecard", "contract_error", "repair_request"], ["observability_tts"], true, true),
  ]);
}

function boundary(
  serviceRef: ApiServiceRef,
  artifactTypes: readonly ArtifactType[],
  consumers: readonly ApiServiceRef[],
  deterministicAuthority: boolean,
  qaTruthAllowed: boolean,
): Omit<ServiceBoundaryDefinition, "determinism_hash"> {
  return {
    service_ref: serviceRef,
    boundary_ref: makeApiRef("service_boundary", serviceRef),
    primary_responsibilities: freezeApiArray([`${serviceRef} owns canonical creation for its declared artifact types.`]),
    does_not_own: freezeApiArray(["Responsibilities outside the declared service boundary remain with their service of record."]),
    owned_artifact_types: freezeApiArray(artifactTypes),
    allowed_consumers: freezeApiArray(consumers),
    boundary_rule_refs: freezeApiArray([makeApiRef("boundary_rule", serviceRef, "service_of_record")]),
    deterministic_authority: deterministicAuthority,
    qa_truth_allowed: qaTruthAllowed,
  };
}

export class ServiceBoundaryRegistryError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "ServiceBoundaryRegistryError";
    this.issues = freezeApiArray(issues);
  }
}

export const SERVICE_BOUNDARY_REGISTRY_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: SERVICE_BOUNDARY_REGISTRY_SCHEMA_VERSION,
  blueprint: API_BLUEPRINT_REF,
  sections: freezeApiArray(["19.2", "19.3", "19.6", "19.7", "19.10", "19.12"]),
  component: "ServiceBoundaryRegistry",
});
