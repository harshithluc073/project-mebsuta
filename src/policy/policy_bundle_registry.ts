/**
 * Versioned policy bundle registry for PIT-B05.
 *
 * Blueprint: `production_readiness_docs/07_AUTH_SECURITY_AND_POLICY_PLAN.md`
 * sections 10, 16, 22, and 23.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  AUTH_SECURITY_BLUEPRINT_REF,
  authIssue,
  freezeAuthArray,
  makeAuthRef,
  type EnvironmentScope,
  type RuntimeScope,
  uniqueAuthRefs,
  validateAuthRef,
  validateSafeAuthText,
} from "../auth/actor_context";

export const POLICY_BUNDLE_REGISTRY_SCHEMA_VERSION = "mebsuta.policy.policy_bundle_registry.v1" as const;

export type PolicyDomain = "auth" | "runtime" | "qa" | "export" | "safety" | "release" | "secrets";

export interface PolicyBundleInput {
  readonly policy_bundle_ref: Ref;
  readonly version: string;
  readonly domains: readonly PolicyDomain[];
  readonly environment_scope: EnvironmentScope;
  readonly runtime_scope: RuntimeScope;
  readonly source_doc_refs: readonly Ref[];
  readonly policy_refs: readonly Ref[];
  readonly activated_at_ms: number;
}

export interface PolicyBundle {
  readonly schema_version: typeof POLICY_BUNDLE_REGISTRY_SCHEMA_VERSION;
  readonly policy_bundle_ref: Ref;
  readonly version: string;
  readonly domains: readonly PolicyDomain[];
  readonly environment_scope: EnvironmentScope;
  readonly runtime_scope: RuntimeScope;
  readonly source_doc_refs: readonly Ref[];
  readonly policy_refs: readonly Ref[];
  readonly activated_at_ms: number;
  readonly determinism_hash: string;
}

export class PolicyBundleRegistry {
  private readonly bundles = new Map<Ref, PolicyBundle>();

  public registerPolicyBundle(input: PolicyBundleInput): PolicyBundle {
    const bundle = normalizePolicyBundle(input);
    const issues = validatePolicyBundle(bundle);
    if (issues.some((issue) => issue.severity === "error")) {
      throw new PolicyBundleRegistryError("Policy bundle failed validation.", issues);
    }
    this.bundles.set(bundle.policy_bundle_ref, bundle);
    return bundle;
  }

  public resolvePolicyBundle(input: { readonly environment_scope: EnvironmentScope; readonly runtime_scope: RuntimeScope; readonly required_domains: readonly PolicyDomain[] }): PolicyBundle | undefined {
    const candidates = [...this.bundles.values()]
      .filter((bundle) =>
        bundle.environment_scope === input.environment_scope
        && bundle.runtime_scope === input.runtime_scope
        && input.required_domains.every((domain) => bundle.domains.includes(domain)),
      )
      .sort((left, right) => right.activated_at_ms - left.activated_at_ms || right.version.localeCompare(left.version));
    return candidates[0];
  }
}

export class PolicyBundleRegistryError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "PolicyBundleRegistryError";
    this.issues = freezeAuthArray(issues);
  }
}

export function normalizePolicyBundle(input: PolicyBundleInput): PolicyBundle {
  const base = {
    schema_version: POLICY_BUNDLE_REGISTRY_SCHEMA_VERSION,
    policy_bundle_ref: input.policy_bundle_ref,
    version: input.version.trim(),
    domains: freezeAuthArray([...new Set(input.domains)]),
    environment_scope: input.environment_scope,
    runtime_scope: input.runtime_scope,
    source_doc_refs: uniqueAuthRefs(input.source_doc_refs),
    policy_refs: uniqueAuthRefs(input.policy_refs),
    activated_at_ms: input.activated_at_ms,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validatePolicyBundle(bundle: PolicyBundle): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateAuthRef(bundle.policy_bundle_ref, "$.policy_bundle_ref", issues);
  validateSafeAuthText(bundle.version, "$.version", true, issues);
  if (bundle.domains.length === 0) {
    issues.push(authIssue("error", "PolicyDomainsMissing", "$.domains", "Policy bundle must include at least one domain.", "Attach auth, runtime, QA, export, safety, release, or secrets domain."));
  }
  if (bundle.policy_refs.length === 0 || bundle.source_doc_refs.length === 0) {
    issues.push(authIssue("error", "PolicyTraceabilityMissing", "$", "Policy bundle requires source docs and policy refs.", "Attach traceable docs and policy refs."));
  }
  return freezeAuthArray(issues);
}

export function createPitB05PolicyBundleRegistry(): PolicyBundleRegistry {
  const registry = new PolicyBundleRegistry();
  registry.registerPolicyBundle({
    policy_bundle_ref: "policy_bundle:pit-b05:auth-security:v1",
    version: "pit-b05.v1",
    domains: ["auth", "runtime", "qa", "export", "safety", "secrets"],
    environment_scope: "production",
    runtime_scope: "runtime",
    source_doc_refs: [AUTH_SECURITY_BLUEPRINT_REF, "architecture_docs/02_INFORMATION_FIREWALL_AND_EMBODIED_REALISM.md", "architecture_docs/18_SAFETY_GUARDRAILS_VALIDATION_AND_POLICY.md"],
    policy_refs: ["policy:pit-b05:rbac-abac", "policy:pit-b05:runtime-qa-boundary", "policy:pit-b05:secret-redaction", "policy:pit-b05:export-guard"],
    activated_at_ms: 5_005,
  });
  registry.registerPolicyBundle({
    policy_bundle_ref: "policy_bundle:pit-b05:qa-security:v1",
    version: "pit-b05.qa.v1",
    domains: ["auth", "qa", "export", "safety"],
    environment_scope: "qa",
    runtime_scope: "qa",
    source_doc_refs: [AUTH_SECURITY_BLUEPRINT_REF, "architecture_docs/02_INFORMATION_FIREWALL_AND_EMBODIED_REALISM.md"],
    policy_refs: ["policy:pit-b05:qa-offline-access", "policy:pit-b05:export-guard"],
    activated_at_ms: 5_006,
  });
  return registry;
}

export const POLICY_BUNDLE_REGISTRY_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: POLICY_BUNDLE_REGISTRY_SCHEMA_VERSION,
  blueprint: AUTH_SECURITY_BLUEPRINT_REF,
  sections: freezeAuthArray(["10", "16", "22", "23"]),
  component: "PolicyBundleRegistry",
  default_bundle_ref: makeAuthRef("policy_bundle", "pit-b05", "auth-security", "v1"),
});
