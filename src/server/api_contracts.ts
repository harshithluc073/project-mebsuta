/**
 * Backend API foundation contracts for PIT-B03.
 *
 * These contracts model the route layer without selecting a network framework.
 * They provide stable request context, response envelopes, route names, actor
 * roles, and operator-safe errors for future HTTP/SSE adapters.
 */

import type { ApiRoute } from "../api/artifact_envelope";
import type { CompatibilityDecision } from "../api/api_version_compatibility_guard";

export const BACKEND_API_CONTRACT_SCHEMA_VERSION = "mebsuta.backend_api.contracts.v1" as const;
export const BACKEND_API_VERSION = "1.0.0" as const;
export const FRONTEND_COMPATIBILITY_RANGE = "^1.0.0" as const;

export type ApiMethod = "GET" | "POST";
export type ApiActorRole = "operator" | "safety_operator" | "qa_engineer" | "developer" | "auditor" | "service_principal";
export type ApiSourceSurface = "operator_console" | "runtime_dashboard" | "qa_console" | "ci_contract_check" | "service_internal";

export type BackendApiRoute =
  | "/api/v1/runtime/profile"
  | "/api/v1/runtime/health"
  | "/api/v1/runtime/readiness"
  | "/api/v1/runtime/services"
  | "/api/v1/scenarios/validate"
  | "/api/v1/scenarios/launch"
  | "/api/v1/operator-commands"
  | "/api/v1/events";

export interface ApiRequestContext {
  readonly request_ref: string;
  readonly correlation_ref: string;
  readonly actor_ref: string;
  readonly actor_role: ApiActorRole;
  readonly source_surface: ApiSourceSurface;
  readonly api_version: string;
  readonly received_at_ms: number;
  readonly policy_refs: readonly string[];
}

export interface ApiRouteRequest<TBody = unknown> {
  readonly method: ApiMethod;
  readonly path: BackendApiRoute;
  readonly context: ApiRequestContext;
  readonly body?: TBody;
  readonly observed_unknown_field_refs?: readonly string[];
  readonly policy_change_refs?: readonly string[];
}

export type ApiResponseStatus = "ok" | "rejected" | "error";

export interface ApiErrorEnvelope {
  readonly error_ref: string;
  readonly error_class: "schema_invalid" | "unauthorized" | "version_incompatible" | "route_rejected" | "runtime_not_ready" | "safety_blocked";
  readonly recommended_route: ApiRoute;
  readonly human_message: string;
  readonly audit_refs: readonly string[];
}

export interface ApiResponseEnvelope<TData = unknown> {
  readonly schema_version: typeof BACKEND_API_CONTRACT_SCHEMA_VERSION;
  readonly api_version: typeof BACKEND_API_VERSION;
  readonly request_ref: string;
  readonly correlation_ref: string;
  readonly status: ApiResponseStatus;
  readonly status_code: 200 | 202 | 400 | 401 | 409 | 412 | 500;
  readonly data?: TData;
  readonly error?: ApiErrorEnvelope;
  readonly compatibility_decision: CompatibilityDecision;
  readonly audit_refs: readonly string[];
}

export function okResponse<TData>(
  request: ApiRouteRequest,
  statusCode: 200 | 202,
  data: TData,
  auditRefs: readonly string[],
  compatibilityDecision: CompatibilityDecision = "compatible",
): ApiResponseEnvelope<TData> {
  return Object.freeze({
    schema_version: BACKEND_API_CONTRACT_SCHEMA_VERSION,
    api_version: BACKEND_API_VERSION,
    request_ref: request.context.request_ref,
    correlation_ref: request.context.correlation_ref,
    status: "ok",
    status_code: statusCode,
    data,
    compatibility_decision: compatibilityDecision,
    audit_refs: freezeArray(auditRefs),
  });
}

export function rejectedResponse(
  request: ApiRouteRequest,
  statusCode: 400 | 401 | 409 | 412 | 500,
  error: ApiErrorEnvelope,
  compatibilityDecision: CompatibilityDecision = "compatible",
): ApiResponseEnvelope<never> {
  return Object.freeze({
    schema_version: BACKEND_API_CONTRACT_SCHEMA_VERSION,
    api_version: BACKEND_API_VERSION,
    request_ref: request.context.request_ref,
    correlation_ref: request.context.correlation_ref,
    status: statusCode === 500 ? "error" : "rejected",
    status_code: statusCode,
    error,
    compatibility_decision: compatibilityDecision,
    audit_refs: freezeArray(error.audit_refs),
  });
}

export function makeApiError(
  request: ApiRouteRequest,
  errorClass: ApiErrorEnvelope["error_class"],
  recommendedRoute: ApiRoute,
  humanMessage: string,
  auditRefs: readonly string[],
): ApiErrorEnvelope {
  return Object.freeze({
    error_ref: makeServerRef("api_error", request.path, request.context.request_ref, errorClass),
    error_class: errorClass,
    recommended_route: recommendedRoute,
    human_message: compactPublicText(humanMessage),
    audit_refs: freezeArray([request.context.request_ref, request.context.correlation_ref, ...auditRefs]),
  });
}

export function validateRequestContext(context: ApiRequestContext): readonly string[] {
  const issues: string[] = [];
  for (const [field, value] of [
    ["request_ref", context.request_ref],
    ["correlation_ref", context.correlation_ref],
    ["actor_ref", context.actor_ref],
  ] as const) {
    if (!isSafeRef(value)) {
      issues.push(`${field} must be a stable boundary-safe ref.`);
    }
  }
  if (context.api_version !== BACKEND_API_VERSION) {
    issues.push(`API version ${context.api_version} is not supported by this backend foundation.`);
  }
  return freezeArray(issues);
}

export function makeServerRef(...parts: readonly (string | number | undefined)[]): string {
  const normalized = parts
    .filter((part): part is string | number => part !== undefined)
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, "_")
    .replace(/[\\/]+/g, ":")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "server:empty";
}

export function compactPublicText(value: string, maxChars = 500): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return containsRestrictedApiText(compact)
    ? compact.replace(RESTRICTED_API_TEXT, "[redacted_api_content]").slice(0, maxChars)
    : compact.slice(0, maxChars);
}

export function containsRestrictedApiText(value: string): boolean {
  return RESTRICTED_API_TEXT.test(value);
}

export function isSafeRef(value: string): boolean {
  return value.trim().length > 0 && !/\s/.test(value) && !containsRestrictedApiText(value);
}

export function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

const RESTRICTED_API_TEXT = /(ground[_ -]?truth|scene[_ -]?graph|hidden[_ -]?pose|hidden[_ -]?state|object[_ -]?id|qa[_ -]?label|qa[_ -]?success|oracle|raw[_ -]?prompt|direct[_ -]?actuator|joint[_ -]?torque|override[_ -]?safety|disable[_ -]?safe[_ -]?hold|secret|password|token)/i;

