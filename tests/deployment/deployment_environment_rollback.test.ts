import { describe, expect, it } from "vitest";

import {
  buildDeploymentManifest,
  buildDeploymentReadinessReport,
  normalizeBackupRestoreEvidenceReport,
  normalizeDeploymentEnvironmentProfile,
  normalizeRollbackEvidenceReport,
  normalizeSmokeEvidenceReport,
  validateDeploymentEnvironmentProfile,
  validateDeploymentReadinessReport,
  type DeploymentEnvironmentProfileInput,
  type DeploymentReadinessInput,
  type ProcessRoleDeploymentInput,
} from "../../src/deployment/deployment_environment_rollback";

describe("PIT-B13 deployment environments and rollback", () => {
  it("builds a go production readiness report when profile, manifest, smoke, backup/restore, and rollback evidence are green", () => {
    const report = buildDeploymentReadinessReport(greenInput());

    expect(report.decision).toBe("go");
    expect(report.no_go_conditions).toEqual([]);
    expect(report.conditional_go_conditions).toEqual([]);
    expect(report.environment_profile.runtime_mutation_allowed).toBe(true);
    expect(report.manifest.status).toBe("green");
    expect(report.manifest.missing_required_role_refs).toEqual([]);
    expect(report.smoke_evidence.status).toBe("green");
    expect(report.backup_restore_evidence.status).toBe("green");
    expect(report.rollback_evidence.status).toBe("green");
    expect(validateDeploymentReadinessReport(report).ok).toBe(true);
  });

  it("rejects runtime-capable environment profiles that mount QA-scoped stores", () => {
    const profile = normalizeDeploymentEnvironmentProfile({
      ...productionProfile(),
      environment: "staging",
      environment_ref: "env:staging:qa-scope-mounted",
      qa_scope_mounted: true,
    });

    const validation = validateDeploymentEnvironmentProfile(profile);

    expect(validation.ok).toBe(false);
    expect(validation.recommended_route).toBe("release_block");
    expect(validation.issues.map((issue) => issue.code)).toContain("DeploymentRuntimeQaScopeMounted");
  });

  it("marks release-candidate manifests red when required process roles are absent", () => {
    const environmentProfile = normalizeDeploymentEnvironmentProfile({
      ...productionProfile(),
      environment: "release_candidate",
      environment_ref: "env:release-candidate:pit-b13",
      allowed_process_roles: ["api_server", "runtime_worker", "background_worker", "frontend", "release_gate"],
    });

    const manifest = buildDeploymentManifest({
      manifest_ref: "manifest:pit-b13:release-candidate",
      environment_profile: environmentProfile,
      process_roles: [role("release_gate")],
      network_policy_refs: ["network:pit-b13:release-candidate"],
      storage_dependency_refs: environmentProfile.required_storage_refs,
      observability_refs: ["observability:pit-b13:release-candidate"],
    });

    expect(manifest.status).toBe("red");
    expect(manifest.missing_required_role_refs).toEqual(["api_server", "runtime_worker", "background_worker", "frontend"]);
    expect(manifest.disallowed_role_refs).toEqual([]);
  });

  it("records smoke evidence as red when required smoke refs are missing", () => {
    const smoke = normalizeSmokeEvidenceReport({
      ...greenInput().smoke_evidence,
      observed_smoke_refs: ["smoke:pit-b13:auth", "smoke:pit-b13:frontend"],
    });

    const report = buildDeploymentReadinessReport({
      ...greenInput(),
      smoke_evidence: {
        ...greenInput().smoke_evidence,
        observed_smoke_refs: ["smoke:pit-b13:auth", "smoke:pit-b13:frontend"],
      },
    });

    expect(smoke.status).toBe("red");
    expect(smoke.missing_smoke_refs).toEqual(["smoke:pit-b13:runtime-safehold", "smoke:pit-b13:event-stream"]);
    expect(report.decision).toBe("no_go");
    expect(report.no_go_conditions).toContain("deployment_smoke_red");
  });

  it("blocks rollback readiness when restore evidence or drain evidence is incomplete", () => {
    const backupRestore = normalizeBackupRestoreEvidenceReport({
      ...greenInput().backup_restore_evidence,
      observed_restore_refs: ["restore:pit-b13:event-ledger"],
    });
    const rollback = normalizeRollbackEvidenceReport({
      ...greenInput().rollback_evidence,
      observed_drain_refs: ["drain:pit-b13:safehold"],
    });
    const report = buildDeploymentReadinessReport({
      ...greenInput(),
      backup_restore_evidence: {
        ...greenInput().backup_restore_evidence,
        observed_restore_refs: ["restore:pit-b13:event-ledger"],
      },
      rollback_evidence: {
        ...greenInput().rollback_evidence,
        observed_drain_refs: ["drain:pit-b13:safehold"],
      },
    });

    expect(backupRestore.status).toBe("red");
    expect(backupRestore.missing_restore_refs).toEqual(["restore:pit-b13:artifact-store", "restore:pit-b13:memory-index"]);
    expect(rollback.status).toBe("red");
    expect(rollback.missing_drain_refs).toEqual(["drain:pit-b13:worker"]);
    expect(report.decision).toBe("no_go");
    expect(report.no_go_conditions).toContain("backup_restore_red");
    expect(report.no_go_conditions).toContain("rollback_readiness_red");
  });
});

function greenInput(): DeploymentReadinessInput {
  return {
    readiness_report_ref: "readiness:pit-b13:production",
    environment_profile: productionProfile(),
    manifest: {
      manifest_ref: "manifest:pit-b13:production",
      process_roles: [role("api_server"), role("runtime_worker"), role("background_worker"), role("frontend")],
      network_policy_refs: ["network:pit-b13:ingress", "network:pit-b13:egress"],
      storage_dependency_refs: ["storage:pit-b13:event-ledger", "storage:pit-b13:artifact-store", "storage:pit-b13:memory-index"],
      observability_refs: ["observability:pit-b13:logs", "observability:pit-b13:traces"],
    },
    smoke_evidence: {
      smoke_report_ref: "smoke:pit-b13:production",
      environment_ref: "env:production:pit-b13",
      required_smoke_refs: ["smoke:pit-b13:auth", "smoke:pit-b13:frontend", "smoke:pit-b13:runtime-safehold", "smoke:pit-b13:event-stream"],
      observed_smoke_refs: ["smoke:pit-b13:auth", "smoke:pit-b13:frontend", "smoke:pit-b13:runtime-safehold", "smoke:pit-b13:event-stream"],
    },
    backup_restore_evidence: {
      backup_restore_report_ref: "backup-restore:pit-b13:production",
      environment_ref: "env:production:pit-b13",
      required_backup_refs: ["backup:pit-b13:event-ledger", "backup:pit-b13:artifact-store", "backup:pit-b13:memory-index"],
      observed_backup_refs: ["backup:pit-b13:event-ledger", "backup:pit-b13:artifact-store", "backup:pit-b13:memory-index"],
      required_restore_refs: ["restore:pit-b13:event-ledger", "restore:pit-b13:artifact-store", "restore:pit-b13:memory-index"],
      observed_restore_refs: ["restore:pit-b13:event-ledger", "restore:pit-b13:artifact-store", "restore:pit-b13:memory-index"],
      schema_validation_refs: ["schema:pit-b13:restore"],
      replay_validation_refs: ["replay:pit-b13:restore"],
      boundary_validation_refs: ["boundary:pit-b13:runtime-qa-separation"],
    },
    rollback_evidence: {
      rollback_report_ref: "rollback:pit-b13:production",
      environment_ref: "env:production:pit-b13",
      current_artifact_ref: "artifact:pit-b13:current",
      rollback_target_artifact_ref: "artifact:pit-b12:previous",
      rollback_runbook_ref: "runbook:pit-b13:rollback",
      required_drain_refs: ["drain:pit-b13:safehold", "drain:pit-b13:worker"],
      observed_drain_refs: ["drain:pit-b13:safehold", "drain:pit-b13:worker"],
      preserved_evidence_refs: ["evidence:pit-b13:logs", "evidence:pit-b13:traces", "evidence:pit-b13:replay"],
    },
    operator_summary: "PIT-B13 deployment readiness evidence is complete for production review.",
  };
}

function productionProfile(): DeploymentEnvironmentProfileInput {
  return {
    environment_ref: "env:production:pit-b13",
    environment: "production",
    truth_scope: "runtime_embodied_only",
    allowed_process_roles: ["api_server", "runtime_worker", "background_worker", "frontend"],
    required_readiness_gates: ["liveness", "readiness", "runtime", "safety", "storage", "event", "model", "observability"],
    required_storage_refs: ["storage:pit-b13:event-ledger", "storage:pit-b13:artifact-store", "storage:pit-b13:memory-index"],
    required_reference_refs: ["config:pit-b13:production", "policy:pit-b13:safety"],
    runtime_mutation_allowed: true,
    qa_scope_mounted: false,
    operator_summary: "Production runtime deployment profile uses only embodied runtime evidence and isolated storage contracts.",
  };
}

function role(processRole: ProcessRoleDeploymentInput["process_role"]): ProcessRoleDeploymentInput {
  return {
    role_ref: `role:pit-b13:${processRole}`,
    process_role: processRole,
    artifact_ref: `artifact:pit-b13:${processRole}`,
    config_profile_ref: `config:pit-b13:${processRole}`,
    service_identity_ref: `identity:pit-b13:${processRole}`,
    readiness_gate_refs: processRole === "frontend" ? ["liveness", "readiness"] : ["liveness", "readiness", "observability"],
    health_probe_refs: [`health:pit-b13:${processRole}:ready`],
  };
}
