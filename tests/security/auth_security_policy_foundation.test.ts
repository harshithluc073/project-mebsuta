import { describe, expect, it } from "vitest";

import { buildArtifactEnvelope } from "../../src/api/artifact_envelope";
import { buildProvenanceManifest, normalizeProvenanceManifest } from "../../src/api/provenance_manifest_contract";
import { evaluateRuntimeQaBoundary } from "../../src/api/runtime_qa_boundary_guard";
import { buildActorContext } from "../../src/auth/actor_context";
import { AuthorizationPolicyEngine } from "../../src/auth/authorization_policy_engine";
import { ServiceIdentityRegistry } from "../../src/auth/service_identity_registry";
import { createPitB05PolicyBundleRegistry } from "../../src/policy/policy_bundle_registry";
import { PolicyDecisionRecorder } from "../../src/policy/policy_decision_recorder";
import { ExportSecurityGuard } from "../../src/security/export_security_guard";
import { buildSecretConfigRef, redactSecrets } from "../../src/security/secret_redaction";

describe("PIT-B05 auth security policy foundation", () => {
  it("denies unauthorized route, artifact, command, and export scopes", () => {
    const engine = new AuthorizationPolicyEngine();
    const auditor = actor("auditor", "runtime", "production");
    const operator = actor("operator", "runtime", "production");

    const route = engine.evaluateAuthorization(authRequest(auditor, "route:mutate_runtime", "route", "route:/api/v1/operator-commands"));
    const artifact = engine.evaluateAuthorization({ ...authRequest(operator, "qa_truth:read_offline", "qa_truth", "qa:truth:scorecard"), runtime_qa_boundary_label: "qa", runtime_scope: "runtime" });
    const command = engine.evaluateAuthorization({ ...authRequest(operator, "command:exit_safe_hold_resume", "command", "command:safehold:resume"), safety_state: "safe_hold" });
    const exportDecision = new ExportSecurityGuard({ authorizationEngine: engine }).evaluateExport({
      export_request_ref: "export:operator:qa",
      actor: operator,
      export_kind: "qa_report",
      destination_ref: "destination:qa-report",
      artifact_envelope: qaEnvelope(),
      provenance_manifest: qaProvenance(),
      payload_summary: "QA report export requested from runtime actor.",
      requested_at_ms: 6_000,
      policy_bundle_ref: "policy_bundle:pit-b05:qa-security:v1",
      correlation_ref: "correlation:export:qa",
    });

    expect(route.decision).toBe("denied");
    expect(artifact.decision).toBe("denied");
    expect(command.decision).toBe("denied");
    expect(exportDecision.decision).toBe("denied");
    expect(exportDecision.runtime_qa_boundary_label).toBe("qa");
  });

  it("registers least-privilege service identities and rejects revoked service actors", () => {
    const registry = new ServiceIdentityRegistry();
    registry.registerServicePrincipal({
      service_principal_ref: "service_principal:runtime_admission",
      owning_component_ref: "component:runtime_admission",
      display_name: "Runtime Admission Service",
      allowed_route_refs: ["route:/api/v1/scenarios/launch"],
      allowed_artifact_visibility_classes: ["runtime_deterministic"],
      allowed_permissions: ["route:mutate_runtime"],
      allowed_environment_scopes: ["production"],
      allowed_runtime_scopes: ["runtime"],
      credential_ref: "credential_ref:runtime_admission",
      rotation_policy_ref: "rotation_policy:quarterly",
      last_rotated_at_ms: 5_000,
      policy_bundle_ref: "policy_bundle:pit-b05:auth-security:v1",
      audit_refs: ["audit:service:runtime_admission"],
    });
    const actorContext = registry.buildServiceActorContext("service_principal:runtime_admission", 5_100);
    const engine = new AuthorizationPolicyEngine({ serviceRegistry: registry });
    const allowed = engine.evaluateAuthorization({
      ...authRequest(actorContext, "route:mutate_runtime", "route", "route:/api/v1/scenarios/launch"),
      route_ref: "route:/api/v1/scenarios/launch",
      artifact_visibility_class: "runtime_deterministic",
    });
    registry.revokeServicePrincipal("service_principal:runtime_admission", "audit:service:revoked");

    expect(allowed.decision).toBe("allowed");
    expect(() => registry.buildServiceActorContext("service_principal:runtime_admission", 5_200)).toThrow();
  });

  it("redacts secret values while preserving config refs only", () => {
    const config = buildSecretConfigRef({
      config_ref: "secret_config:gemini",
      category: "gemini_api",
      environment_ref: "environment:production",
      secret_store_ref: "secret_store:vault",
      credential_ref: "credential_ref:gemini_api",
      rotation_policy_ref: "rotation_policy:monthly",
      consumer_component_refs: ["component:gemini_adapter"],
      loaded_at_ms: 5_500,
    });
    const redaction = redactSecrets({
      input_ref: "redaction:prompt",
      text: "Use bearer abcdefghijklmnopqrstuvwxyz012345 and database url postgres://user:pass@host/db",
      config_refs: [config],
      audit_refs: ["audit:redaction"],
    });

    expect(redaction.redacted).toBe(true);
    expect(redaction.redacted_text).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    expect(redaction.redacted_text).not.toContain("postgres://user:pass@host/db");
    expect(redaction.audit_refs).toContain("secret_config:gemini");
    expect(JSON.stringify(config)).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
  });

  it("approves authorized runtime export with redaction and records signed policy decisions", () => {
    const developer = actor("developer", "developer_observability", "staging");
    const guard = new ExportSecurityGuard();
    const decision = guard.evaluateExport({
      export_request_ref: "export:runtime:replay",
      actor: developer,
      export_kind: "runtime_replay",
      destination_ref: "destination:developer-review",
      artifact_envelope: runtimeEnvelope(),
      provenance_manifest: runtimeProvenance(),
      payload_summary: "Replay export contains bearer service-secret-value-1234567890 and runtime evidence.",
      requested_at_ms: 6_100,
      policy_bundle_ref: "policy_bundle:pit-b05:auth-security:v1",
      correlation_ref: "correlation:runtime:export",
    });
    const recorder = new PolicyDecisionRecorder();
    const record = recorder.recordAuthorization(decision.authorization_decision, 6_101);

    expect(decision.decision).toBe("approved");
    expect(decision.redaction_result.redacted).toBe(true);
    expect(decision.runtime_qa_boundary_label).toBe("runtime");
    expect(record.signature_hash).toHaveLength(8);
    expect(record.runtime_qa_boundary_label).toBe("runtime");
  });

  it("resolves policy bundles and preserves runtime/QA boundary labels through guard decisions", () => {
    const bundles = createPitB05PolicyBundleRegistry();
    const runtimeBundle = bundles.resolvePolicyBundle({ environment_scope: "production", runtime_scope: "runtime", required_domains: ["auth", "export"] });
    const qaBoundary = evaluateRuntimeQaBoundary({
      boundary_request_ref: "boundary:qa:runtime",
      destination: "runtime_cognition",
      artifact_envelope: qaEnvelope(),
      provenance_manifest: qaProvenance(),
      payload_summary: "QA-only report must stay offline.",
      payload_keys: ["score_summary", "qa_label"],
    });

    expect(runtimeBundle?.policy_bundle_ref).toBe("policy_bundle:pit-b05:auth-security:v1");
    expect(qaBoundary.decision).toBe("quarantined");
    expect(qaBoundary.approved_visibility_class).toBe("restricted_quarantine");
    expect(qaBoundary.reason).toContain("truth-boundary risk");
  });
});

function actor(role: "operator" | "auditor" | "developer", runtimeScope: "runtime" | "developer_observability", environmentScope: "production" | "staging") {
  return buildActorContext({
    actor_ref: `actor:${role}`,
    actor_type: "human",
    display_name: `${role} test actor`,
    role_refs: [role],
    environment_scopes: [environmentScope],
    runtime_scopes: [runtimeScope],
    session_ref: `session:${role}`,
    authenticated_at_ms: 5_000,
    authentication_strength: "mfa",
    mfa_verified: true,
    audit_attribute_refs: [`audit:${role}`],
  });
}

function authRequest(actorContext: ReturnType<typeof actor>, permission: Parameters<AuthorizationPolicyEngine["evaluateAuthorization"]>[0]["permission"], subjectType: Parameters<AuthorizationPolicyEngine["evaluateAuthorization"]>[0]["subject_type"], subjectRef: string) {
  return {
    request_ref: `request:${permission.replace(/[^a-z0-9]+/gi, "-")}`,
    actor: actorContext,
    permission,
    subject_type: subjectType,
    subject_ref: subjectRef,
    environment_scope: actorContext.environment_scopes[0],
    runtime_scope: actorContext.runtime_scopes[0],
    policy_bundle_ref: "policy_bundle:pit-b05:auth-security:v1",
    safety_state: "normal" as const,
    runtime_qa_boundary_label: "runtime" as const,
    correlation_ref: `correlation:${subjectRef.replace(/[^a-z0-9]+/gi, "-")}`,
  };
}

function runtimeProvenance() {
  return buildProvenanceManifest({
    provenance_manifest_ref: "provenance:runtime:export",
    source_classes: ["embodied_sensor", "validator_output"],
    cognitive_visibility: "summarized",
    memory_visibility: "summary_only",
    qa_visibility: "not_allowed",
    truth_boundary_status: "runtime_embodied_only",
    source_artifact_refs: ["evidence:runtime"],
    policy_refs: ["policy:pit-b05:runtime-boundary"],
    audit_notes: ["Runtime export boundary test."],
  });
}

function runtimeEnvelope() {
  const provenance = runtimeProvenance();
  return buildArtifactEnvelope({
    artifact_ref: "artifact:runtime:export",
    artifact_type: "route_decision",
    schema_ref: "schema:runtime_export:v1",
    service_of_record: "agent_orchestration",
    created_at_ms: 6_000,
    created_by_component: "security:export_guard",
    provenance_manifest_ref: provenance.provenance_manifest_ref,
    visibility_class: "runtime_deterministic",
    validation_status: "valid",
    audit_replay_refs: ["audit:runtime:export"],
  });
}

function qaProvenance() {
  return normalizeProvenanceManifest({
    provenance_manifest_ref: "provenance:qa:report",
    source_classes: ["qa_truth"],
    cognitive_visibility: "forbidden",
    memory_visibility: "forbidden",
    qa_visibility: "offline_only",
    truth_boundary_status: "qa_truth_only",
    source_artifact_refs: ["evidence:qa:offline"],
    policy_refs: ["policy:pit-b05:qa-boundary"],
    audit_notes: ["Offline QA report."],
  });
}

function qaEnvelope() {
  const provenance = qaProvenance();
  return buildArtifactEnvelope({
    artifact_ref: "artifact:qa:report",
    artifact_type: "qa_scorecard",
    schema_ref: "schema:qa_report:v1",
    service_of_record: "qa_scenario",
    created_at_ms: 6_000,
    created_by_component: "qa:scorecard",
    provenance_manifest_ref: provenance.provenance_manifest_ref,
    visibility_class: "qa_offline",
    validation_status: "valid",
    audit_replay_refs: ["audit:qa:report"],
  });
}
