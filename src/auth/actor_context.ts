/**
 * Canonical actor context for PIT-B05 auth/security foundation.
 *
 * Blueprint: `production_readiness_docs/07_AUTH_SECURITY_AND_POLICY_PLAN.md`
 * sections 7, 8, 10, 16, 17, and 23.
 *
 * Actor context is the immutable identity envelope attached to authorization,
 * export, policy, and audit decisions. It deliberately stores credential
 * references and provider subjects, never raw tokens or secret values.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";

export const ACTOR_CONTEXT_SCHEMA_VERSION = "mebsuta.auth.actor_context.v1" as const;
export const AUTH_SECURITY_BLUEPRINT_REF = "production_readiness_docs/07_AUTH_SECURITY_AND_POLICY_PLAN.md" as const;

const FORBIDDEN_AUTH_TEXT_PATTERN = /(password|token[_ -]?value|bearer\s+|api[_ -]?key|private[_ -]?key|session[_ -]?cookie|client[_ -]?secret|ground[_ -]?truth|scene[_ -]?graph|hidden[_ -]?pose|qa[_ -]?success|oracle|raw[_ -]?prompt|chain[_ -]?of[_ -]?thought)/i;

export type ActorType = "anonymous" | "human" | "service" | "ci" | "system";
export type AuthRole =
  | "anonymous"
  | "demo_viewer"
  | "operator"
  | "safety_operator"
  | "qa_engineer"
  | "developer"
  | "release_owner"
  | "security_admin"
  | "auditor"
  | "service_principal";
export type EnvironmentScope = "development" | "staging" | "production" | "qa" | "benchmark" | "release_candidate";
export type RuntimeScope = "runtime" | "qa" | "offline_replay" | "developer_observability" | "release";
export type AuthenticationStrength = "none" | "single_factor" | "mfa" | "service_credential" | "ci_attestation" | "system_internal";

export interface ActorContextInput {
  readonly actor_ref: Ref;
  readonly actor_type: ActorType;
  readonly display_name: string;
  readonly provider_subject_ref?: Ref;
  readonly organization_ref?: Ref;
  readonly role_refs: readonly AuthRole[];
  readonly environment_scopes: readonly EnvironmentScope[];
  readonly runtime_scopes: readonly RuntimeScope[];
  readonly scenario_scope_refs?: readonly Ref[];
  readonly artifact_scope_refs?: readonly Ref[];
  readonly session_ref?: Ref;
  readonly service_principal_ref?: Ref;
  readonly credential_ref?: Ref;
  readonly authenticated_at_ms: number;
  readonly authentication_strength: AuthenticationStrength;
  readonly mfa_verified?: boolean;
  readonly audit_attribute_refs?: readonly Ref[];
}

export interface ActorContext {
  readonly schema_version: typeof ACTOR_CONTEXT_SCHEMA_VERSION;
  readonly actor_ref: Ref;
  readonly actor_type: ActorType;
  readonly display_name: string;
  readonly provider_subject_ref?: Ref;
  readonly organization_ref?: Ref;
  readonly role_refs: readonly AuthRole[];
  readonly environment_scopes: readonly EnvironmentScope[];
  readonly runtime_scopes: readonly RuntimeScope[];
  readonly scenario_scope_refs: readonly Ref[];
  readonly artifact_scope_refs: readonly Ref[];
  readonly session_ref?: Ref;
  readonly service_principal_ref?: Ref;
  readonly credential_ref?: Ref;
  readonly authenticated_at_ms: number;
  readonly authentication_strength: AuthenticationStrength;
  readonly mfa_verified: boolean;
  readonly audit_attribute_refs: readonly Ref[];
  readonly determinism_hash: string;
}

export class ActorContextValidationError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "ActorContextValidationError";
    this.issues = freezeAuthArray(issues);
  }
}

export function buildActorContext(input: ActorContextInput): ActorContext {
  const actor = normalizeActorContext(input);
  const issues = validateActorContext(actor);
  if (issues.some((issue) => issue.severity === "error")) {
    throw new ActorContextValidationError("Actor context failed validation.", issues);
  }
  return actor;
}

export function normalizeActorContext(input: ActorContextInput): ActorContext {
  const base = {
    schema_version: ACTOR_CONTEXT_SCHEMA_VERSION,
    actor_ref: input.actor_ref,
    actor_type: input.actor_type,
    display_name: compactAuthText(input.display_name),
    provider_subject_ref: input.provider_subject_ref,
    organization_ref: input.organization_ref,
    role_refs: uniqueAuthStrings(input.role_refs),
    environment_scopes: uniqueAuthStrings(input.environment_scopes),
    runtime_scopes: uniqueAuthStrings(input.runtime_scopes),
    scenario_scope_refs: uniqueAuthRefs(input.scenario_scope_refs ?? []),
    artifact_scope_refs: uniqueAuthRefs(input.artifact_scope_refs ?? []),
    session_ref: input.session_ref,
    service_principal_ref: input.service_principal_ref,
    credential_ref: input.credential_ref,
    authenticated_at_ms: input.authenticated_at_ms,
    authentication_strength: input.authentication_strength,
    mfa_verified: input.mfa_verified ?? false,
    audit_attribute_refs: uniqueAuthRefs(input.audit_attribute_refs ?? []),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateActorContext(actor: ActorContext): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateAuthRef(actor.actor_ref, "$.actor_ref", issues);
  validateOptionalAuthRef(actor.provider_subject_ref, "$.provider_subject_ref", issues);
  validateOptionalAuthRef(actor.organization_ref, "$.organization_ref", issues);
  validateOptionalAuthRef(actor.session_ref, "$.session_ref", issues);
  validateOptionalAuthRef(actor.service_principal_ref, "$.service_principal_ref", issues);
  validateOptionalAuthRef(actor.credential_ref, "$.credential_ref", issues);
  validateSafeAuthText(actor.display_name, "$.display_name", true, issues);
  validateFiniteAuthNumber(actor.authenticated_at_ms, "$.authenticated_at_ms", 0, undefined, issues);

  if (actor.role_refs.length === 0) {
    issues.push(authIssue("error", "ActorRolesMissing", "$.role_refs", "Actor context must carry at least one role.", "Attach anonymous or scoped roles explicitly."));
  }
  if (actor.environment_scopes.length === 0) {
    issues.push(authIssue("error", "ActorEnvironmentScopesMissing", "$.environment_scopes", "Actor must be environment-scoped.", "Attach at least one environment scope."));
  }
  if (actor.runtime_scopes.length === 0) {
    issues.push(authIssue("error", "ActorRuntimeScopesMissing", "$.runtime_scopes", "Actor must be runtime-scoped.", "Attach at least one runtime scope."));
  }
  if (actor.actor_type === "service" && actor.service_principal_ref === undefined) {
    issues.push(authIssue("error", "ServicePrincipalRefMissing", "$.service_principal_ref", "Service actors require a service principal ref.", "Build service actors from the service identity registry."));
  }
  if (actor.actor_type === "anonymous" && actor.role_refs.some((role) => role !== "anonymous")) {
    issues.push(authIssue("error", "AnonymousRoleEscalation", "$.role_refs", "Anonymous actors cannot carry privileged roles.", "Use only the anonymous role for unauthenticated requests."));
  }
  return freezeAuthArray(issues);
}

export function containsForbiddenAuthText(value: string): boolean {
  return FORBIDDEN_AUTH_TEXT_PATTERN.test(value);
}

export function compactAuthText(value: string, maxChars = 900): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return containsForbiddenAuthText(compact)
    ? compact.replace(FORBIDDEN_AUTH_TEXT_PATTERN, "[redacted_auth_boundary_content]").slice(0, maxChars)
    : compact.slice(0, maxChars);
}

export function validateSafeAuthText(value: string, path: string, required: boolean, issues: ValidationIssue[]): void {
  if (required && value.trim().length === 0) {
    issues.push(authIssue("error", "AuthTextRequired", path, "Required auth text is empty.", "Provide concise boundary-safe text."));
  }
  if (containsForbiddenAuthText(value)) {
    issues.push(authIssue("error", "AuthTextForbidden", path, "Auth text contains credential, hidden-truth, prompt, or QA-truth content.", "Use refs and redacted summaries only."));
  }
}

export function validateAuthRef(ref: Ref | undefined, path: string, issues: ValidationIssue[]): void {
  if (ref === undefined || ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(authIssue("error", "AuthRefInvalid", path, "Reference must be present, non-empty, and whitespace-free.", "Use an opaque stable ref."));
    return;
  }
  if (containsForbiddenAuthText(ref)) {
    issues.push(authIssue("error", "AuthRefForbidden", path, "Reference contains restricted auth or boundary wording.", "Use an opaque ref without secrets or hidden truth."));
  }
}

export function validateOptionalAuthRef(ref: Ref | undefined, path: string, issues: ValidationIssue[]): void {
  if (ref !== undefined) {
    validateAuthRef(ref, path, issues);
  }
}

export function validateFiniteAuthNumber(value: number, path: string, min: number, max: number | undefined, issues: ValidationIssue[]): void {
  if (!Number.isFinite(value) || value < min || (max !== undefined && value > max)) {
    issues.push(authIssue("error", "AuthNumberInvalid", path, "Numeric auth value is outside the allowed finite range.", "Use a finite nonnegative timestamp or policy value."));
  }
}

export function authIssue(severity: ValidationSeverity, code: string, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

export function makeAuthRef(...parts: readonly (string | number | undefined)[]): Ref {
  const normalized = parts
    .filter((part): part is string | number => part !== undefined)
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "auth:empty";
}

export function uniqueAuthRefs(items: readonly (Ref | undefined)[]): readonly Ref[] {
  return freezeAuthArray([...new Set(items.filter((item): item is Ref => item !== undefined && item.trim().length > 0))]);
}

export function uniqueAuthStrings<T extends string>(items: readonly T[]): readonly T[] {
  return freezeAuthArray([...new Set(items.filter((item) => item.trim().length > 0))]);
}

export function freezeAuthArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

export const ACTOR_CONTEXT_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: ACTOR_CONTEXT_SCHEMA_VERSION,
  blueprint: AUTH_SECURITY_BLUEPRINT_REF,
  sections: freezeAuthArray(["7", "8", "10", "16", "17", "23"]),
  component: "ActorContext",
});
