/**
 * Service principal registry for PIT-B05 auth/security foundation.
 *
 * Blueprint: `production_readiness_docs/07_AUTH_SECURITY_AND_POLICY_PLAN.md`
 * sections 7.2, 7.3, 10, 15, and 23.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  ACTOR_CONTEXT_SCHEMA_VERSION,
  buildActorContext,
  freezeAuthArray,
  makeAuthRef,
  type ActorContext,
  type EnvironmentScope,
  type RuntimeScope,
  uniqueAuthRefs,
  validateAuthRef,
  validateFiniteAuthNumber,
  validateSafeAuthText,
} from "./actor_context";
import type { AuthPermission } from "./role_permission_registry";

export const SERVICE_IDENTITY_REGISTRY_SCHEMA_VERSION = "mebsuta.auth.service_identity_registry.v1" as const;

export type ServicePrincipalStatus = "active" | "rotation_due" | "revoked";

export interface ServicePrincipalRecordInput {
  readonly service_principal_ref: Ref;
  readonly owning_component_ref: Ref;
  readonly display_name: string;
  readonly allowed_route_refs: readonly Ref[];
  readonly allowed_artifact_visibility_classes: readonly string[];
  readonly allowed_permissions: readonly AuthPermission[];
  readonly allowed_environment_scopes: readonly EnvironmentScope[];
  readonly allowed_runtime_scopes: readonly RuntimeScope[];
  readonly credential_ref: Ref;
  readonly rotation_policy_ref: Ref;
  readonly last_rotated_at_ms: number;
  readonly policy_bundle_ref: Ref;
  readonly status?: ServicePrincipalStatus;
  readonly audit_refs?: readonly Ref[];
}

export interface ServicePrincipalRecord {
  readonly schema_version: typeof SERVICE_IDENTITY_REGISTRY_SCHEMA_VERSION;
  readonly service_principal_ref: Ref;
  readonly owning_component_ref: Ref;
  readonly display_name: string;
  readonly allowed_route_refs: readonly Ref[];
  readonly allowed_artifact_visibility_classes: readonly string[];
  readonly allowed_permissions: readonly AuthPermission[];
  readonly allowed_environment_scopes: readonly EnvironmentScope[];
  readonly allowed_runtime_scopes: readonly RuntimeScope[];
  readonly credential_ref: Ref;
  readonly rotation_policy_ref: Ref;
  readonly last_rotated_at_ms: number;
  readonly policy_bundle_ref: Ref;
  readonly status: ServicePrincipalStatus;
  readonly audit_refs: readonly Ref[];
  readonly determinism_hash: string;
}

export class ServiceIdentityRegistry {
  private readonly principals = new Map<Ref, ServicePrincipalRecord>();

  public registerServicePrincipal(input: ServicePrincipalRecordInput): ServicePrincipalRecord {
    const record = normalizeServicePrincipal(input);
    const issues = validateServicePrincipal(record);
    if (issues.some((issue) => issue.severity === "error")) {
      throw new ServiceIdentityRegistryError("Service principal failed validation.", issues);
    }
    this.principals.set(record.service_principal_ref, record);
    return record;
  }

  public getServicePrincipal(ref: Ref): ServicePrincipalRecord | undefined {
    return this.principals.get(ref);
  }

  public revokeServicePrincipal(ref: Ref, auditRef: Ref): ServicePrincipalRecord | undefined {
    const existing = this.principals.get(ref);
    if (existing === undefined) {
      return undefined;
    }
    const revoked = normalizeServicePrincipal({ ...existing, status: "revoked", audit_refs: [...existing.audit_refs, auditRef] });
    this.principals.set(ref, revoked);
    return revoked;
  }

  public buildServiceActorContext(servicePrincipalRef: Ref, nowMs: number): ActorContext {
    const principal = this.principals.get(servicePrincipalRef);
    if (principal === undefined || principal.status === "revoked") {
      throw new ServiceIdentityRegistryError("Service principal is not active.", freezeAuthArray([]));
    }
    return buildActorContext({
      actor_ref: makeAuthRef("actor", principal.service_principal_ref),
      actor_type: "service",
      display_name: principal.display_name,
      role_refs: ["service_principal"],
      environment_scopes: principal.allowed_environment_scopes,
      runtime_scopes: principal.allowed_runtime_scopes,
      service_principal_ref: principal.service_principal_ref,
      credential_ref: principal.credential_ref,
      authenticated_at_ms: nowMs,
      authentication_strength: "service_credential",
      audit_attribute_refs: [principal.policy_bundle_ref, ...principal.audit_refs],
    });
  }
}

export class ServiceIdentityRegistryError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "ServiceIdentityRegistryError";
    this.issues = freezeAuthArray(issues);
  }
}

export function normalizeServicePrincipal(input: ServicePrincipalRecordInput): ServicePrincipalRecord {
  const base = {
    schema_version: SERVICE_IDENTITY_REGISTRY_SCHEMA_VERSION,
    service_principal_ref: input.service_principal_ref,
    owning_component_ref: input.owning_component_ref,
    display_name: input.display_name,
    allowed_route_refs: uniqueAuthRefs(input.allowed_route_refs),
    allowed_artifact_visibility_classes: freezeAuthArray([...new Set(input.allowed_artifact_visibility_classes)]),
    allowed_permissions: freezeAuthArray([...new Set(input.allowed_permissions)]),
    allowed_environment_scopes: freezeAuthArray([...new Set(input.allowed_environment_scopes)]),
    allowed_runtime_scopes: freezeAuthArray([...new Set(input.allowed_runtime_scopes)]),
    credential_ref: input.credential_ref,
    rotation_policy_ref: input.rotation_policy_ref,
    last_rotated_at_ms: input.last_rotated_at_ms,
    policy_bundle_ref: input.policy_bundle_ref,
    status: input.status ?? "active",
    audit_refs: uniqueAuthRefs(input.audit_refs ?? []),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateServicePrincipal(record: ServicePrincipalRecord): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateAuthRef(record.service_principal_ref, "$.service_principal_ref", issues);
  validateAuthRef(record.owning_component_ref, "$.owning_component_ref", issues);
  validateAuthRef(record.credential_ref, "$.credential_ref", issues);
  validateAuthRef(record.rotation_policy_ref, "$.rotation_policy_ref", issues);
  validateAuthRef(record.policy_bundle_ref, "$.policy_bundle_ref", issues);
  validateSafeAuthText(record.display_name, "$.display_name", true, issues);
  validateFiniteAuthNumber(record.last_rotated_at_ms, "$.last_rotated_at_ms", 0, undefined, issues);
  if (record.allowed_permissions.length === 0 || record.allowed_environment_scopes.length === 0 || record.allowed_runtime_scopes.length === 0) {
    issues.push({ severity: "error", code: "ServicePrincipalScopeMissing", path: "$", message: "Service principal must have explicit permission, environment, and runtime scopes.", remediation: "Grant least-privilege scopes before activation." });
  }
  return freezeAuthArray(issues);
}

export const SERVICE_IDENTITY_REGISTRY_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: SERVICE_IDENTITY_REGISTRY_SCHEMA_VERSION,
  blueprint: "production_readiness_docs/07_AUTH_SECURITY_AND_POLICY_PLAN.md",
  sections: freezeAuthArray(["7.2", "7.3", "10", "15", "23"]),
  component: "ServiceIdentityRegistry",
  actor_context_schema: ACTOR_CONTEXT_SCHEMA_VERSION,
});
