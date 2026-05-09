/**
 * Service event bus contract for Project Mebsuta APIs.
 *
 * Blueprint: `architecture_docs/19_API_SERVICE_BOUNDARIES_AND_DATA_CONTRACTS.md`
 * sections 19.5, 19.6, 19.7.5, 19.9, 19.10, and 19.12.
 *
 * Events carry artifact envelopes across service boundaries with delivery
 * semantics, producer/consumer validation, ordering keys, and audit refs.
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
  validateApiRef,
  validateApiText,
} from "./artifact_envelope";
import type { ApiContractValidationReport, ApiServiceRef, ArtifactEnvelope, ArtifactType } from "./artifact_envelope";

export const SERVICE_EVENT_BUS_CONTRACT_SCHEMA_VERSION = "mebsuta.api.service_event_bus_contract.v1" as const;

export type ServiceEventClass =
  | "SimulationStepEvent"
  | "SensorPacketEvent"
  | "PerceptionUpdateEvent"
  | "AudioEventDetected"
  | "PromptRequestEvent"
  | "CognitiveResponseEvent"
  | "SafetyValidationEvent"
  | "ControlExecutionEvent"
  | "VerificationCertificateEvent"
  | "OopsEpisodeEvent"
  | "MemoryReadWriteEvent"
  | "TTSPlaybackEvent"
  | "SafeHoldEvent"
  | "ContractErrorEvent"
  | "RepairRequestEvent"
  | "QaScoreEvent";

export type DeliveryRequirement = "must_ack" | "ordered_within_key" | "time_synchronized_bundle" | "idempotent_by_source" | "best_effort" | "strict_for_safety";
export type ServiceEventPriority = "routine" | "important" | "safety_critical" | "qa_only";

export interface ServiceEventEnvelope {
  readonly service_event_ref: Ref;
  readonly event_class: ServiceEventClass;
  readonly producer_service: ApiServiceRef;
  readonly consumer_services: readonly ApiServiceRef[];
  readonly artifact_envelope: ArtifactEnvelope;
  readonly occurred_at_ms: number;
  readonly delivery_requirement: DeliveryRequirement;
  readonly priority: ServiceEventPriority;
  readonly ordering_key_ref?: Ref;
  readonly acknowledgement_required: boolean;
  readonly audit_refs: readonly Ref[];
  readonly determinism_hash: string;
}

/**
 * Builds a deterministic event envelope from an artifact envelope.
 */
export function buildServiceEventEnvelope(input: Omit<ServiceEventEnvelope, "determinism_hash">): ServiceEventEnvelope {
  const event = normalizeEvent(input);
  const report = validateServiceEventEnvelope(event);
  if (!report.ok) {
    throw new ServiceEventBusContractError("Service event envelope failed validation.", report.issues);
  }
  return event;
}

export function validateServiceEventEnvelope(event: ServiceEventEnvelope): ApiContractValidationReport {
  const issues: ValidationIssue[] = [];
  validateApiRef(event.service_event_ref, "$.service_event_ref", issues);
  validateApiRef(event.artifact_envelope.artifact_ref, "$.artifact_envelope.artifact_ref", issues);
  validateApiRef(event.ordering_key_ref ?? event.service_event_ref, "$.ordering_key_ref", issues);
  if (event.producer_service !== event.artifact_envelope.service_of_record) {
    issues.push(apiIssue("error", "EventProducerOwnerMismatch", "$.producer_service", "Event producer must match the artifact service of record.", "Publish through the owning service boundary."));
  }
  if (event.consumer_services.length === 0) {
    issues.push(apiIssue("warning", "EventConsumersMissing", "$.consumer_services", "Event has no declared consumers.", "Declare downstream service consumers."));
  }
  if (event.priority === "safety_critical" && (!event.acknowledgement_required || event.delivery_requirement === "best_effort")) {
    issues.push(apiIssue("error", "SafetyEventDeliveryInvalid", "$.delivery_requirement", "Safety-critical events require strict acknowledged delivery.", "Use must_ack or strict_for_safety delivery."));
  }
  if (event.delivery_requirement === "ordered_within_key" && event.ordering_key_ref === undefined) {
    issues.push(apiIssue("error", "OrderingKeyMissing", "$.ordering_key_ref", "Ordered events require an ordering key.", "Attach execution, task, or episode ordering key."));
  }
  return buildApiReport(makeApiRef("service_event_report", event.service_event_ref), issues, routeForIssues(issues));
}

export function eventClassForArtifact(artifactType: ArtifactType): ServiceEventClass {
  switch (artifactType) {
    case "simulation_step":
      return "SimulationStepEvent";
    case "sensor_packet":
    case "sensor_bundle":
      return "SensorPacketEvent";
    case "perception_summary":
      return "PerceptionUpdateEvent";
    case "audio_event":
      return "AudioEventDetected";
    case "prompt_bundle":
      return "PromptRequestEvent";
    case "model_response":
    case "cognitive_plan":
      return "CognitiveResponseEvent";
    case "safety_validation_report":
      return "SafetyValidationEvent";
    case "execution_command":
    case "control_telemetry":
      return "ControlExecutionEvent";
    case "verification_certificate":
      return "VerificationCertificateEvent";
    case "oops_episode":
    case "correction_plan":
      return "OopsEpisodeEvent";
    case "memory_record":
      return "MemoryReadWriteEvent";
    case "tts_playback":
      return "TTSPlaybackEvent";
    case "safe_hold_state":
      return "SafeHoldEvent";
    case "contract_error":
      return "ContractErrorEvent";
    case "repair_request":
      return "RepairRequestEvent";
    case "qa_scorecard":
    case "scenario_spec":
      return "QaScoreEvent";
    case "manipulation_primitive":
      return "ControlExecutionEvent";
    case "route_decision":
      return "SafetyValidationEvent";
  }
}

export function deliveryForEventClass(eventClass: ServiceEventClass): DeliveryRequirement {
  if (eventClass === "SafeHoldEvent" || eventClass === "SafetyValidationEvent" || eventClass === "ContractErrorEvent") {
    return "must_ack";
  }
  if (eventClass === "ControlExecutionEvent") {
    return "ordered_within_key";
  }
  if (eventClass === "SensorPacketEvent") {
    return "time_synchronized_bundle";
  }
  if (eventClass === "MemoryReadWriteEvent") {
    return "idempotent_by_source";
  }
  if (eventClass === "TTSPlaybackEvent") {
    return "strict_for_safety";
  }
  return "best_effort";
}

function normalizeEvent(input: Omit<ServiceEventEnvelope, "determinism_hash">): ServiceEventEnvelope {
  const summaryRefs = uniqueApiRefs([
    input.service_event_ref,
    input.artifact_envelope.artifact_ref,
    input.artifact_envelope.provenance_manifest_ref,
    ...input.audit_refs,
  ]);
  const base = {
    ...input,
    consumer_services: freezeApiArray([...new Set(input.consumer_services)]),
    audit_refs: summaryRefs,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export class ServiceEventBusContractError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "ServiceEventBusContractError";
    this.issues = freezeApiArray(issues);
  }
}

export const SERVICE_EVENT_BUS_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: SERVICE_EVENT_BUS_CONTRACT_SCHEMA_VERSION,
  blueprint: API_BLUEPRINT_REF,
  sections: freezeApiArray(["19.5", "19.6", "19.7.5", "19.9", "19.10", "19.12"]),
  component: "ServiceEventBusContract",
});
