/**
 * Role, permission, and scope registry for PIT-B05 authorization.
 *
 * Blueprint: `production_readiness_docs/07_AUTH_SECURITY_AND_POLICY_PLAN.md`
 * sections 8, 9, 10, 11, 14, and 23.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  AUTH_SECURITY_BLUEPRINT_REF,
  authIssue,
  freezeAuthArray,
  makeAuthRef,
  type AuthRole,
  type EnvironmentScope,
  type RuntimeScope,
  uniqueAuthRefs,
  validateAuthRef,
  validateSafeAuthText,
} from "./actor_context";

export const ROLE_PERMISSION_REGISTRY_SCHEMA_VERSION = "mebsuta.auth.role_permission_registry.v1" as const;

export type AuthActionFamily = "route" | "artifact" | "command" | "export" | "policy" | "secret" | "audit" | "qa_truth" | "safe_hold" | "release";
export type AuthPermission =
  | "route:read_runtime"
  | "route:mutate_runtime"
  | "route:developer_observability"
  | "artifact:read_runtime"
  | "artifact:read_restricted"
  | "artifact:review_quarantine"
  | "command:launch_scenario"
  | "command:pause_stop"
  | "command:enter_safe_hold"
  | "command:exit_safe_hold_reobserve"
  | "command:exit_safe_hold_resume"
  | "export:runtime_replay"
  | "export:qa_report"
  | "export:restricted_artifact"
  | "policy:manage"
  | "secret:manage_metadata"
  | "audit:read"
  | "qa_truth:read_offline"
  | "release:evaluate_gate";

export interface PermissionGrant {
  readonly grant_ref: Ref;
  readonly permission: AuthPermission;
  readonly action_family: AuthActionFamily;
  readonly allowed_environment_scopes: readonly EnvironmentScope[];
  readonly allowed_runtime_scopes: readonly RuntimeScope[];
  readonly requires_mfa: boolean;
  readonly requires_human_actor: boolean;
  readonly requires_audit: boolean;
  readonly policy_refs: readonly Ref[];
  readonly determinism_hash: string;
}

export interface RolePermissionProfile {
  readonly role_ref: AuthRole;
  readonly grants: readonly PermissionGrant[];
  readonly inherits_role_refs: readonly AuthRole[];
  readonly determinism_hash: string;
}

export class RolePermissionRegistry {
  private readonly profiles = new Map<AuthRole, RolePermissionProfile>();

  public registerRoleProfile(input: Omit<RolePermissionProfile, "determinism_hash">): RolePermissionProfile {
    const issues = validateRolePermissionProfile(input);
    if (issues.some((issue) => issue.severity === "error")) {
      throw new RolePermissionRegistryError("Role permission profile failed validation.", issues);
    }
    const profile = normalizeRolePermissionProfile(input);
    this.profiles.set(profile.role_ref, profile);
    return profile;
  }

  public getRoleProfile(role: AuthRole): RolePermissionProfile | undefined {
    return this.profiles.get(role);
  }

  public listRoleProfiles(): readonly RolePermissionProfile[] {
    const ordered = [...this.profiles.values()].sort((left, right) => left.role_ref.localeCompare(right.role_ref));
    return freezeAuthArray(ordered);
  }

  public resolveGrants(roles: readonly AuthRole[]): readonly PermissionGrant[] {
    const resolved = new Map<Ref, PermissionGrant>();
    const queue = [...roles];
    const seen = new Set<AuthRole>();
    while (queue.length > 0) {
      const role = queue.shift();
      if (role === undefined || seen.has(role)) {
        continue;
      }
      seen.add(role);
      const profile = this.profiles.get(role);
      if (profile === undefined) {
        continue;
      }
      for (const grant of profile.grants) {
        resolved.set(grant.grant_ref, grant);
      }
      queue.push(...profile.inherits_role_refs);
    }
    return freezeAuthArray([...resolved.values()].sort((left, right) => left.grant_ref.localeCompare(right.grant_ref)));
  }
}

export class RolePermissionRegistryError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "RolePermissionRegistryError";
    this.issues = freezeAuthArray(issues);
  }
}

export function createDefaultRolePermissionRegistry(): RolePermissionRegistry {
  const registry = new RolePermissionRegistry();
  for (const profile of defaultRoleProfiles()) {
    registry.registerRoleProfile(profile);
  }
  return registry;
}

export function permissionFamily(permission: AuthPermission): AuthActionFamily {
  return permission.split(":")[0] as AuthActionFamily;
}

export function buildPermissionGrant(input: Omit<PermissionGrant, "determinism_hash" | "action_family">): PermissionGrant {
  const base = {
    ...input,
    action_family: permissionFamily(input.permission),
    allowed_environment_scopes: freezeAuthArray(input.allowed_environment_scopes),
    allowed_runtime_scopes: freezeAuthArray(input.allowed_runtime_scopes),
    policy_refs: uniqueAuthRefs(input.policy_refs),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function normalizeRolePermissionProfile(input: Omit<RolePermissionProfile, "determinism_hash">): RolePermissionProfile {
  const base = {
    role_ref: input.role_ref,
    grants: freezeAuthArray(input.grants),
    inherits_role_refs: freezeAuthArray(input.inherits_role_refs),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function validateRolePermissionProfile(input: Omit<RolePermissionProfile, "determinism_hash">): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (input.role_ref === "anonymous" && input.grants.some((grant) => grant.permission !== "route:read_runtime")) {
    issues.push(authIssue("error", "AnonymousGrantInvalid", "$.grants", "Anonymous role can only receive public read bootstrap grants.", "Remove privileged grants from anonymous profile."));
  }
  for (const [index, grant] of input.grants.entries()) {
    validateAuthRef(grant.grant_ref, `$.grants[${index}].grant_ref`, issues);
    for (const [policyIndex, ref] of grant.policy_refs.entries()) {
      validateAuthRef(ref, `$.grants[${index}].policy_refs[${policyIndex}]`, issues);
    }
    validateSafeAuthText(grant.permission, `$.grants[${index}].permission`, true, issues);
    if (grant.allowed_environment_scopes.length === 0) {
      issues.push(authIssue("error", "GrantEnvironmentScopesMissing", `$.grants[${index}].allowed_environment_scopes`, "Grant must be environment-scoped.", "Attach at least one environment scope."));
    }
    if (grant.allowed_runtime_scopes.length === 0) {
      issues.push(authIssue("error", "GrantRuntimeScopesMissing", `$.grants[${index}].allowed_runtime_scopes`, "Grant must be runtime-scoped.", "Attach at least one runtime scope."));
    }
  }
  return freezeAuthArray(issues);
}

function grant(permission: AuthPermission, environments: readonly EnvironmentScope[], runtimes: readonly RuntimeScope[], options: { readonly mfa?: boolean; readonly human?: boolean } = {}): PermissionGrant {
  return buildPermissionGrant({
    grant_ref: makeAuthRef("grant", permission),
    permission,
    allowed_environment_scopes: environments,
    allowed_runtime_scopes: runtimes,
    requires_mfa: options.mfa ?? false,
    requires_human_actor: options.human ?? false,
    requires_audit: true,
    policy_refs: ["policy:pit-b05:rbac-abac"],
  });
}

function defaultRoleProfiles(): readonly Omit<RolePermissionProfile, "determinism_hash">[] {
  const nonProd: readonly EnvironmentScope[] = ["development", "staging", "qa", "benchmark", "release_candidate"];
  const allEnv: readonly EnvironmentScope[] = ["development", "staging", "production", "qa", "benchmark", "release_candidate"];
  const runtime: readonly RuntimeScope[] = ["runtime"];
  const qa: readonly RuntimeScope[] = ["qa"];
  const release: readonly RuntimeScope[] = ["release", "offline_replay"];
  return freezeAuthArray([
    { role_ref: "anonymous", grants: freezeAuthArray([grant("route:read_runtime", ["development"], runtime)]), inherits_role_refs: freezeAuthArray([]) },
    { role_ref: "demo_viewer", grants: freezeAuthArray([grant("route:read_runtime", nonProd, runtime), grant("artifact:read_runtime", nonProd, runtime)]), inherits_role_refs: freezeAuthArray([]) },
    {
      role_ref: "operator",
      grants: freezeAuthArray([
        grant("route:read_runtime", allEnv, runtime),
        grant("artifact:read_runtime", allEnv, runtime),
        grant("command:launch_scenario", allEnv, runtime, { human: true }),
        grant("command:pause_stop", allEnv, runtime, { human: true }),
        grant("command:enter_safe_hold", allEnv, runtime, { human: true }),
      ]),
      inherits_role_refs: freezeAuthArray([]),
    },
    {
      role_ref: "safety_operator",
      grants: freezeAuthArray([
        grant("command:exit_safe_hold_reobserve", allEnv, runtime, { human: true }),
        grant("artifact:review_quarantine", allEnv, ["runtime", "offline_replay"], { human: true }),
      ]),
      inherits_role_refs: freezeAuthArray(["operator"]),
    },
    {
      role_ref: "qa_engineer",
      grants: freezeAuthArray([
        grant("route:read_runtime", nonProd, qa),
        grant("qa_truth:read_offline", ["qa", "benchmark"], qa, { human: true }),
        grant("export:qa_report", ["qa", "benchmark", "release_candidate"], qa, { human: true }),
      ]),
      inherits_role_refs: freezeAuthArray([]),
    },
    {
      role_ref: "developer",
      grants: freezeAuthArray([
        grant("route:developer_observability", nonProd, ["developer_observability", "offline_replay"]),
        grant("export:runtime_replay", nonProd, ["developer_observability", "offline_replay"]),
      ]),
      inherits_role_refs: freezeAuthArray([]),
    },
    {
      role_ref: "release_owner",
      grants: freezeAuthArray([
        grant("release:evaluate_gate", ["release_candidate", "production"], release, { human: true }),
        grant("export:qa_report", ["release_candidate"], release, { human: true }),
      ]),
      inherits_role_refs: freezeAuthArray(["auditor"]),
    },
    {
      role_ref: "security_admin",
      grants: freezeAuthArray([
        grant("policy:manage", allEnv, ["runtime", "qa", "release"], { mfa: true, human: true }),
        grant("secret:manage_metadata", allEnv, ["runtime", "qa", "release"], { mfa: true, human: true }),
        grant("export:restricted_artifact", allEnv, ["runtime", "qa", "offline_replay"], { mfa: true, human: true }),
        grant("command:exit_safe_hold_resume", allEnv, runtime, { mfa: true, human: true }),
      ]),
      inherits_role_refs: freezeAuthArray(["safety_operator", "auditor"]),
    },
    {
      role_ref: "auditor",
      grants: freezeAuthArray([
        grant("audit:read", allEnv, ["runtime", "qa", "offline_replay", "release"]),
        grant("artifact:read_restricted", allEnv, ["offline_replay", "release"]),
      ]),
      inherits_role_refs: freezeAuthArray([]),
    },
    {
      role_ref: "service_principal",
      grants: freezeAuthArray([
        grant("route:read_runtime", allEnv, runtime),
        grant("route:mutate_runtime", allEnv, runtime),
        grant("command:pause_stop", allEnv, runtime),
        grant("command:enter_safe_hold", allEnv, runtime),
        grant("export:qa_report", ["qa", "benchmark"], qa),
      ]),
      inherits_role_refs: freezeAuthArray([]),
    },
  ]);
}

export const ROLE_PERMISSION_REGISTRY_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: ROLE_PERMISSION_REGISTRY_SCHEMA_VERSION,
  blueprint: AUTH_SECURITY_BLUEPRINT_REF,
  sections: freezeAuthArray(["8", "9", "10", "11", "14", "23"]),
  component: "RolePermissionRegistry",
});
