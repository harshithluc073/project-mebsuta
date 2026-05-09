/**
 * RBAC plus contextual ABAC authorization engine for PIT-B05.
 *
 * Blueprint: `production_readiness_docs/07_AUTH_SECURITY_AND_POLICY_PLAN.md`
 * sections 9, 10, 11, 13, 14, 15, 16, and 23.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  ACTOR_CONTEXT_SCHEMA_VERSION,
  freezeAuthArray,
  makeAuthRef,
  type ActorContext,
  type EnvironmentScope,
  type RuntimeScope,
  uniqueAuthRefs,
  validateAuthRef,
  validateSafeAuthText,
} from "./actor_context";
import {
  createDefaultRolePermissionRegistry,
  type AuthPermission,
  type PermissionGrant,
  type RolePermissionRegistry,
} from "./role_permission_registry";
import type { ServiceIdentityRegistry } from "./service_identity_registry";

export const AUTHORIZATION_POLICY_ENGINE_SCHEMA_VERSION = "mebsuta.auth.authorization_policy_engine.v1" as const;

export type AuthorizationSubjectType = "route" | "artifact" | "command" | "export" | "policy" | "secret" | "audit" | "qa_truth" | "safe_hold" | "release";
export type AuthorizationDecisionKind = "allowed" | "denied";
export type RuntimeQaBoundaryLabel = "runtime" | "qa" | "offline_replay" | "restricted_quarantine" | "redacted";

export interface AuthorizationRequest {
  readonly request_ref: Ref;
  readonly actor: ActorContext;
  readonly permission: AuthPermission;
  readonly subject_type: AuthorizationSubjectType;
  readonly subject_ref: Ref;
  readonly environment_scope: EnvironmentScope;
  readonly runtime_scope: RuntimeScope;
  readonly route_ref?: Ref;
  readonly artifact_visibility_class?: string;
  readonly scenario_ref?: Ref;
  readonly policy_bundle_ref: Ref;
  readonly safety_state: "normal" | "restricted" | "safe_hold" | "human_review";
  readonly runtime_qa_boundary_label: RuntimeQaBoundaryLabel;
  readonly correlation_ref: Ref;
}

export interface AuthorizationDecisionRecord {
  readonly schema_version: typeof AUTHORIZATION_POLICY_ENGINE_SCHEMA_VERSION;
  readonly decision_ref: Ref;
  readonly request_ref: Ref;
  readonly actor_ref: Ref;
  readonly actor_type: ActorContext["actor_type"];
  readonly permission: AuthPermission;
  readonly subject_type: AuthorizationSubjectType;
  readonly subject_ref: Ref;
  readonly environment_scope: EnvironmentScope;
  readonly runtime_scope: RuntimeScope;
  readonly runtime_qa_boundary_label: RuntimeQaBoundaryLabel;
  readonly policy_bundle_ref: Ref;
  readonly decision: AuthorizationDecisionKind;
  readonly reason: string;
  readonly matched_grant_refs: readonly Ref[];
  readonly audit_refs: readonly Ref[];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export class AuthorizationPolicyEngine {
  private readonly roleRegistry: RolePermissionRegistry;
  private readonly serviceRegistry?: ServiceIdentityRegistry;

  public constructor(options: { readonly roleRegistry?: RolePermissionRegistry; readonly serviceRegistry?: ServiceIdentityRegistry } = {}) {
    this.roleRegistry = options.roleRegistry ?? createDefaultRolePermissionRegistry();
    this.serviceRegistry = options.serviceRegistry;
  }

  public evaluateAuthorization(request: AuthorizationRequest): AuthorizationDecisionRecord {
    const issues = validateAuthorizationRequest(request);
    const grants = this.roleRegistry.resolveGrants(request.actor.role_refs);
    const matched = grants.filter((grant) => grantMatchesRequest(grant, request));
    const serviceAllowed = request.actor.actor_type !== "service" || serviceScopeAllows(request, this.serviceRegistry);
    const mfaAllowed = matched.some((grant) => !grant.requires_mfa || request.actor.mfa_verified);
    const humanAllowed = matched.some((grant) => !grant.requires_human_actor || request.actor.actor_type === "human");
    const boundaryAllowed = boundaryAllows(request);
    const safetyAllowed = safetyAllows(request);
    const allowed = issues.every((issue) => issue.severity !== "error")
      && matched.length > 0
      && serviceAllowed
      && mfaAllowed
      && humanAllowed
      && boundaryAllowed
      && safetyAllowed;
    const reason = authorizationReason(request, matched, serviceAllowed, mfaAllowed, humanAllowed, boundaryAllowed, safetyAllowed, allowed);
    const base = {
      schema_version: AUTHORIZATION_POLICY_ENGINE_SCHEMA_VERSION,
      decision_ref: makeAuthRef("authorization_decision", request.request_ref, allowed ? "allow" : "deny"),
      request_ref: request.request_ref,
      actor_ref: request.actor.actor_ref,
      actor_type: request.actor.actor_type,
      permission: request.permission,
      subject_type: request.subject_type,
      subject_ref: request.subject_ref,
      environment_scope: request.environment_scope,
      runtime_scope: request.runtime_scope,
      runtime_qa_boundary_label: request.runtime_qa_boundary_label,
      policy_bundle_ref: request.policy_bundle_ref,
      decision: allowed ? "allowed" as const : "denied" as const,
      reason,
      matched_grant_refs: uniqueAuthRefs(matched.map((grant) => grant.grant_ref)),
      audit_refs: uniqueAuthRefs([request.request_ref, request.correlation_ref, request.actor.session_ref, request.actor.service_principal_ref, request.policy_bundle_ref]),
      issues: freezeAuthArray(issues),
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function createDefaultAuthorizationPolicyEngine(): AuthorizationPolicyEngine {
  return new AuthorizationPolicyEngine();
}

function validateAuthorizationRequest(request: AuthorizationRequest): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateAuthRef(request.request_ref, "$.request_ref", issues);
  validateAuthRef(request.subject_ref, "$.subject_ref", issues);
  validateAuthRef(request.policy_bundle_ref, "$.policy_bundle_ref", issues);
  validateAuthRef(request.correlation_ref, "$.correlation_ref", issues);
  if (request.route_ref !== undefined) {
    validateAuthRef(request.route_ref, "$.route_ref", issues);
  }
  if (request.scenario_ref !== undefined) {
    validateAuthRef(request.scenario_ref, "$.scenario_ref", issues);
  }
  if (request.artifact_visibility_class !== undefined) {
    validateSafeAuthText(request.artifact_visibility_class, "$.artifact_visibility_class", true, issues);
  }
  return freezeAuthArray(issues);
}

function grantMatchesRequest(grant: PermissionGrant, request: AuthorizationRequest): boolean {
  return grant.permission === request.permission
    && grant.allowed_environment_scopes.includes(request.environment_scope)
    && grant.allowed_runtime_scopes.includes(request.runtime_scope)
    && request.actor.environment_scopes.includes(request.environment_scope)
    && request.actor.runtime_scopes.includes(request.runtime_scope);
}

function serviceScopeAllows(request: AuthorizationRequest, serviceRegistry: ServiceIdentityRegistry | undefined): boolean {
  const serviceRef = request.actor.service_principal_ref;
  if (serviceRef === undefined || serviceRegistry === undefined) {
    return false;
  }
  const principal = serviceRegistry.getServicePrincipal(serviceRef);
  if (principal === undefined || principal.status !== "active") {
    return false;
  }
  const routeAllowed = request.route_ref === undefined || principal.allowed_route_refs.includes(request.route_ref);
  const visibilityAllowed = request.artifact_visibility_class === undefined || principal.allowed_artifact_visibility_classes.includes(request.artifact_visibility_class);
  return routeAllowed
    && visibilityAllowed
    && principal.allowed_permissions.includes(request.permission)
    && principal.allowed_environment_scopes.includes(request.environment_scope)
    && principal.allowed_runtime_scopes.includes(request.runtime_scope);
}

function boundaryAllows(request: AuthorizationRequest): boolean {
  if (request.runtime_qa_boundary_label === "restricted_quarantine") {
    return request.permission === "artifact:review_quarantine" || request.permission === "export:restricted_artifact";
  }
  if (request.runtime_qa_boundary_label === "qa") {
    return request.runtime_scope === "qa" && (request.permission === "qa_truth:read_offline" || request.permission === "export:qa_report");
  }
  if (request.permission === "qa_truth:read_offline") {
    return false;
  }
  return true;
}

function safetyAllows(request: AuthorizationRequest): boolean {
  if (request.safety_state === "safe_hold" && request.permission === "command:exit_safe_hold_resume") {
    return request.actor.role_refs.includes("security_admin");
  }
  if (request.safety_state === "human_review" && request.permission.startsWith("command:")) {
    return request.permission === "command:pause_stop" || request.permission === "command:enter_safe_hold";
  }
  return true;
}

function authorizationReason(
  request: AuthorizationRequest,
  matched: readonly PermissionGrant[],
  serviceAllowed: boolean,
  mfaAllowed: boolean,
  humanAllowed: boolean,
  boundaryAllowed: boolean,
  safetyAllowed: boolean,
  allowed: boolean,
): string {
  if (allowed) {
    return `Authorization allowed for ${request.permission} on ${request.subject_ref}.`;
  }
  if (matched.length === 0) {
    return `No role grant authorizes ${request.permission} in ${request.environment_scope}/${request.runtime_scope}.`;
  }
  if (!serviceAllowed) {
    return "Service principal scope does not authorize the requested route, artifact, permission, or environment.";
  }
  if (!mfaAllowed) {
    return "Permission requires MFA-authenticated human context.";
  }
  if (!humanAllowed) {
    return "Permission requires a human actor context.";
  }
  if (!boundaryAllowed) {
    return "Runtime/QA boundary policy denies this subject for the actor scope.";
  }
  if (!safetyAllowed) {
    return "Safety state denies this command path.";
  }
  return "Authorization request failed validation.";
}

export const AUTHORIZATION_POLICY_ENGINE_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: AUTHORIZATION_POLICY_ENGINE_SCHEMA_VERSION,
  blueprint: "production_readiness_docs/07_AUTH_SECURITY_AND_POLICY_PLAN.md",
  sections: freezeAuthArray(["9", "10", "11", "13", "14", "15", "16", "23"]),
  component: "AuthorizationPolicyEngine",
  actor_context_schema: ACTOR_CONTEXT_SCHEMA_VERSION,
});
