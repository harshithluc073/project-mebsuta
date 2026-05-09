/**
 * Narrow auth and policy hook for PIT-B03 route admission.
 *
 * This is not the PIT-B05 auth subsystem. It is the minimal deny-by-default
 * route policy hook required by the backend API foundation.
 */

import type { RuntimeReadinessSnapshot } from "../runtime/runtime_readiness_snapshot";
import { freezeArray, makeServerRef, type ApiActorRole, type ApiRouteRequest, type BackendApiRoute } from "./api_contracts";

export const API_AUTH_POLICY_HOOK_SCHEMA_VERSION = "mebsuta.backend_api.auth_policy_hook.v1" as const;

export type ApiAuthorizationDecisionKind = "allowed" | "denied";

export interface ApiAuthorizationDecision {
  readonly schema_version: typeof API_AUTH_POLICY_HOOK_SCHEMA_VERSION;
  readonly decision_ref: string;
  readonly decision: ApiAuthorizationDecisionKind;
  readonly route: BackendApiRoute;
  readonly actor_role: ApiActorRole;
  readonly reason: string;
  readonly audit_refs: readonly string[];
}

export interface ApiAuthorizationContext {
  readonly readiness: RuntimeReadinessSnapshot;
  readonly mutates_runtime: boolean;
  readonly safety_sensitive: boolean;
}

const READ_ROUTES: ReadonlySet<BackendApiRoute> = new Set([
  "/api/v1/runtime/profile",
  "/api/v1/runtime/health",
  "/api/v1/runtime/readiness",
  "/api/v1/runtime/services",
  "/api/v1/events",
]);

const MUTATION_ROUTE_ROLES: Readonly<Record<BackendApiRoute, readonly ApiActorRole[]>> = Object.freeze({
  "/api/v1/runtime/profile": [],
  "/api/v1/runtime/health": [],
  "/api/v1/runtime/readiness": [],
  "/api/v1/runtime/services": [],
  "/api/v1/events": [],
  "/api/v1/scenarios/validate": roles("operator", "qa_engineer", "service_principal"),
  "/api/v1/scenarios/launch": roles("operator", "qa_engineer", "service_principal"),
  "/api/v1/operator-commands": roles("operator", "safety_operator", "service_principal"),
});

export function evaluateApiAuthorization(request: ApiRouteRequest, context: ApiAuthorizationContext): ApiAuthorizationDecision {
  const allowedRoles = READ_ROUTES.has(request.path)
    ? readRoles()
    : MUTATION_ROUTE_ROLES[request.path];
  const roleAllowed = allowedRoles.includes(request.context.actor_role);
  const readinessAllows = !context.mutates_runtime || context.readiness.readiness_state === "ready";
  const safetyAllows = !context.safety_sensitive || context.readiness.accepting_scenarios;
  const allowed = roleAllowed && readinessAllows && safetyAllows;
  const reason = !roleAllowed
    ? `Actor role ${request.context.actor_role} is not authorized for ${request.path}.`
    : !readinessAllows
      ? "Runtime readiness blocks mutating API route."
      : !safetyAllows
        ? "Runtime safety state blocks sensitive API route."
        : "Route admitted by PIT-B03 deny-by-default policy hook.";
  return Object.freeze({
    schema_version: API_AUTH_POLICY_HOOK_SCHEMA_VERSION,
    decision_ref: makeServerRef("api_authz", request.path, request.context.request_ref, allowed ? "allow" : "deny"),
    decision: allowed ? "allowed" : "denied",
    route: request.path,
    actor_role: request.context.actor_role,
    reason,
    audit_refs: freezeArray([request.context.request_ref, request.context.correlation_ref, ...request.context.policy_refs]),
  });
}

function readRoles(): readonly ApiActorRole[] {
  return roles("operator", "safety_operator", "qa_engineer", "developer", "auditor", "service_principal");
}

function roles(...items: readonly ApiActorRole[]): readonly ApiActorRole[] {
  return Object.freeze([...items]);
}
