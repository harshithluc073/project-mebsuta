/**
 * Framework-free backend API foundation for PIT-B03.
 *
 * The class acts as the production route contract core that future HTTP/SSE
 * adapters can wrap. It mounts runtime, readiness, service, scenario,
 * operator-command, and event-stream routes while enforcing version,
 * authorization, readiness, service-boundary, and event-bus contracts.
 */

import {
  evaluateApiVersionCompatibility,
  validateVersionCompatibilityDecision,
  type VersionedContractDescriptor,
} from "../api/api_version_compatibility_guard";
import { type ApiServiceRef } from "../api/artifact_envelope";
import { createDefaultServiceBoundaryRegistry } from "../api/service_boundary_registry";
import type { ScenarioAdmissionRequest } from "../runtime/scenario_session_manager";
import type { MebsutaRuntime } from "../runtime/mebsuta_runtime";
import {
  BACKEND_API_VERSION,
  FRONTEND_COMPATIBILITY_RANGE,
  makeApiError,
  okResponse,
  rejectedResponse,
  validateRequestContext,
  type ApiResponseEnvelope,
  type ApiRouteRequest,
} from "./api_contracts";
import { evaluateApiAuthorization } from "./auth_policy_hook";
import { BackendEventStream } from "./event_stream_server";
import { evaluateOperatorCommand, type OperatorCommandBody } from "./operator_command_authority";

export const API_SERVER_SCHEMA_VERSION = "mebsuta.backend_api.server.v1" as const;

export interface BackendApiServerServices {
  readonly runtime: MebsutaRuntime;
  readonly event_stream?: BackendEventStream;
}

export class BackendApiServer {
  private readonly runtime: MebsutaRuntime;
  private readonly eventStream: BackendEventStream;
  private readonly boundaryRegistry = createDefaultServiceBoundaryRegistry();

  public constructor(services: BackendApiServerServices) {
    this.runtime = services.runtime;
    this.eventStream = services.event_stream ?? new BackendEventStream();
  }

  public async handleRequest<TBody = unknown>(request: ApiRouteRequest<TBody>): Promise<ApiResponseEnvelope> {
    const contextIssues = validateRequestContext(request.context);
    const compatibility = this.evaluateCompatibility(request);
    if (compatibility.decision !== "compatible") {
      return rejectedResponse(
        request,
        412,
        makeApiError(request, "version_incompatible", compatibility.recommended_route, compatibility.reason, [compatibility.compatibility_decision_ref]),
        compatibility.decision,
      );
    }
    if (contextIssues.length > 0) {
      return rejectedResponse(
        request,
        400,
        makeApiError(request, "schema_invalid", compatibility.recommended_route, contextIssues.join(" "), [compatibility.compatibility_decision_ref]),
        compatibility.decision,
      );
    }

    const readiness = this.runtime.readiness(request.context.received_at_ms);
    const authz = evaluateApiAuthorization(request, routeAuthorizationContext(request.path, readiness));
    if (authz.decision !== "allowed") {
      return rejectedResponse(request, 401, makeApiError(request, "unauthorized", "Reject", authz.reason, [authz.decision_ref]));
    }

    switch (request.path) {
      case "/api/v1/runtime/profile":
        return okResponse(request, 200, {
          schema_version: API_SERVER_SCHEMA_VERSION,
          api_version: BACKEND_API_VERSION,
          frontend_compatibility_range: FRONTEND_COMPATIBILITY_RANGE,
          service_boundary_count: this.boundaryRegistry.listBoundaries().length,
          runtime_ref: readiness.runtime_ref,
          policy_refs: request.context.policy_refs,
        }, [authz.decision_ref, compatibility.compatibility_decision_ref]);
      case "/api/v1/runtime/health":
      case "/api/v1/runtime/readiness":
        return okResponse(request, 200, readiness, [authz.decision_ref, compatibility.compatibility_decision_ref, readiness.runtime_ref]);
      case "/api/v1/runtime/services":
        return okResponse(request, 200, this.boundaryRegistry.listBoundaries().map((boundary) => ({
          service_ref: boundary.service_ref,
          boundary_ref: boundary.boundary_ref,
          deterministic_authority: boundary.deterministic_authority,
          qa_truth_allowed: boundary.qa_truth_allowed,
          owned_artifact_types: boundary.owned_artifact_types,
        })), [authz.decision_ref, compatibility.compatibility_decision_ref]);
      case "/api/v1/scenarios/validate":
        return okResponse(request, 200, { route: "scenario_validation", readiness_state: readiness.readiness_state, accepting_scenarios: readiness.accepting_scenarios }, [authz.decision_ref, compatibility.compatibility_decision_ref]);
      case "/api/v1/scenarios/launch":
        return this.handleScenarioLaunch(request as ApiRouteRequest<ScenarioAdmissionRequest>, authz.decision_ref, compatibility.compatibility_decision_ref);
      case "/api/v1/operator-commands":
        return this.handleOperatorCommand(request as ApiRouteRequest<OperatorCommandBody>, authz.decision_ref, compatibility.compatibility_decision_ref);
      case "/api/v1/events":
        return okResponse(request, 200, {
          cursor: this.eventStream.cursor(),
          events: this.eventStream.readFrom(undefined, 100),
        }, [authz.decision_ref, compatibility.compatibility_decision_ref]);
    }
  }

  public publishEvent(input: {
    readonly artifact_ref: string;
    readonly artifact_type: Parameters<BackendEventStream["publish"]>[0]["artifact_type"];
    readonly service_of_record: ApiServiceRef;
    readonly consumer_services: readonly ApiServiceRef[];
    readonly occurred_at_ms: number;
    readonly audit_refs: readonly string[];
  }): void {
    this.eventStream.publish({
      artifact_ref: input.artifact_ref,
      artifact_type: input.artifact_type,
      service_of_record: input.service_of_record,
      consumer_services: input.consumer_services,
      created_at_ms: input.occurred_at_ms,
      visibility_class: "developer_observability",
      ordering_key_ref: input.artifact_ref,
      audit_refs: input.audit_refs,
    });
  }

  private handleScenarioLaunch(
    request: ApiRouteRequest<ScenarioAdmissionRequest>,
    authzRef: string,
    compatibilityRef: string,
  ): ApiResponseEnvelope {
    if (request.body === undefined) {
      return rejectedResponse(request, 400, makeApiError(request, "schema_invalid", "Reject", "Scenario launch body is required.", [authzRef, compatibilityRef]));
    }
    const admission = this.runtime.admitScenario(request.body, request.context.received_at_ms);
    if (admission.decision === "rejected") {
      return rejectedResponse(request, 409, makeApiError(request, "runtime_not_ready", "Reject", admission.blocked_reasons.join(" "), [authzRef, compatibilityRef, ...admission.audit_refs]));
    }
    this.eventStream.publish({
      artifact_ref: admission.admission_ref,
      artifact_type: "scenario_spec",
      service_of_record: "simulation_physics",
      created_at_ms: admission.decided_at_ms,
      visibility_class: "developer_observability",
      consumer_services: ["agent_orchestration", "observability_tts"],
      ordering_key_ref: admission.task_ref,
      audit_refs: admission.audit_refs,
    });
    return okResponse(request, 202, admission, [authzRef, compatibilityRef, ...admission.audit_refs]);
  }

  private handleOperatorCommand(
    request: ApiRouteRequest<OperatorCommandBody>,
    authzRef: string,
    compatibilityRef: string,
  ): ApiResponseEnvelope {
    const readiness = this.runtime.readiness(request.context.received_at_ms);
    const authz = evaluateApiAuthorization(request, routeAuthorizationContext(request.path, readiness));
    const command = evaluateOperatorCommand(request, authz, readiness);
    if (command.decision === "rejected") {
      return rejectedResponse(request, 409, makeApiError(request, "safety_blocked", "Reject", command.rejected_reasons.join(" "), [authzRef, compatibilityRef, ...command.audit_refs]));
    }
    this.eventStream.publish({
      artifact_ref: command.command_ref,
      artifact_type: command.command === "enter_safe_hold" ? "safe_hold_state" : "route_decision",
      service_of_record: command.command === "enter_safe_hold" ? "safety_guardrail" : "agent_orchestration",
      created_at_ms: command.decided_at_ms,
      visibility_class: "developer_observability",
      consumer_services: ["observability_tts", "safety_guardrail"],
      ordering_key_ref: command.command_ref,
      audit_refs: command.audit_refs,
    });
    return okResponse(request, 202, command, [authzRef, compatibilityRef, ...command.audit_refs]);
  }

  private evaluateCompatibility(request: ApiRouteRequest) {
    const artifactEnvelope = {
      artifact_ref: request.context.request_ref,
      artifact_type: "route_decision" as const,
      schema_ref: "schema:route-api:1",
      service_of_record: "agent_orchestration" as const,
      created_at_ms: request.context.received_at_ms,
      created_by_component: "api_route:route_layer",
      parent_artifact_refs: [],
      provenance_manifest_ref: "provenance:route-api-request",
      policy_refs: request.context.policy_refs,
      validation_status: "valid" as const,
      visibility_class: "developer_observability" as const,
      audit_replay_refs: [request.context.request_ref],
      determinism_hash: request.context.request_ref,
    };
    const descriptor = contractDescriptor("contract:route-api", "schema:route-api:1", BACKEND_API_VERSION, false);
    const consumer = contractDescriptor("contract:frontend-client", "schema:route-api:1", request.context.api_version, false);
    const decision = evaluateApiVersionCompatibility({
      compatibility_request_ref: `compatibility:${request.context.request_ref}`,
      artifact_envelope: artifactEnvelope,
      producer_contract: descriptor,
      consumer_contract: consumer,
      observed_unknown_field_refs: request.observed_unknown_field_refs ?? [],
      policy_change_refs: request.policy_change_refs ?? [],
    });
    const report = validateVersionCompatibilityDecision(decision);
    if (!report.ok) {
      throw new Error("API compatibility decision failed self-validation.");
    }
    return decision;
  }
}

function routeAuthorizationContext(path: string, readiness: ReturnType<MebsutaRuntime["readiness"]>) {
  const mutates = path === "/api/v1/scenarios/validate" || path === "/api/v1/scenarios/launch" || path === "/api/v1/operator-commands";
  return Object.freeze({
    readiness,
    mutates_runtime: mutates,
    safety_sensitive: path === "/api/v1/scenarios/launch" || path === "/api/v1/operator-commands",
  });
}

function contractDescriptor(
  contractRef: string,
  schemaRef: string,
  version: string,
  qaRegressionRequired: boolean,
): VersionedContractDescriptor {
  return Object.freeze({
    contract_ref: contractRef,
    schema_ref: schemaRef,
    semantic_version: version,
    compatibility_risk: "safety_policy",
    critical_field_refs: Object.freeze(["field:route_authority", "field:visibility_class", "field:safety_state"]),
    replay_migration_available: false,
    qa_regression_required: qaRegressionRequired,
  });
}
