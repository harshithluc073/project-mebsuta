/**
 * Deployment environment and rollback readiness contracts.
 *
 * Blueprint: `production_readiness_docs/13_DEPLOYMENT_INFRASTRUCTURE_AND_ENVIRONMENTS.md`
 * sections 13.4, 13.5, 13.6, 13.7, 13.16, 13.19, 13.20, and 13.22.
 *
 * This PIT-B13 surface validates environment profiles, deployment manifests,
 * process-role readiness, smoke evidence, backup/restore evidence, and
 * rollback readiness without creating infrastructure, container, or workflow
 * assets.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";

export const DEPLOYMENT_ENVIRONMENT_ROLLBACK_SCHEMA_VERSION = "mebsuta.deployment.environment_rollback.v1" as const;

export type DeploymentEnvironment =
  | "local_development"
  | "ci_validation"
  | "qa_benchmark"
  | "staging"
  | "release_candidate"
  | "production"
  | "incident_replay"
  | "security_review";

export type DeploymentProcessRole = "api_server" | "runtime_worker" | "background_worker" | "qa_worker" | "replay_worker" | "release_gate" | "frontend";
export type DeploymentReadinessGate = "liveness" | "readiness" | "runtime" | "safety" | "storage" | "model" | "event" | "qa" | "release" | "observability";
export type DeploymentTruthScope = "runtime_embodied_only" | "qa_isolated" | "replay_restricted" | "security_restricted" | "local_sanitized";
export type DeploymentGateStatus = "green" | "amber" | "red";
export type DeploymentDecision = "go" | "conditional_go" | "no_go";
export type DeploymentRoute = "continue" | "review" | "release_block";

export interface DeploymentValidationReport {
  readonly report_ref: Ref;
  readonly ok: boolean;
  readonly issue_count: number;
  readonly error_count: number;
  readonly warning_count: number;
  readonly recommended_route: DeploymentRoute;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface DeploymentEnvironmentProfileInput {
  readonly environment_ref: Ref;
  readonly environment: DeploymentEnvironment;
  readonly truth_scope: DeploymentTruthScope;
  readonly allowed_process_roles: readonly DeploymentProcessRole[];
  readonly required_readiness_gates: readonly DeploymentReadinessGate[];
  readonly required_storage_refs: readonly Ref[];
  readonly required_reference_refs: readonly Ref[];
  readonly runtime_mutation_allowed: boolean;
  readonly qa_scope_mounted: boolean;
  readonly operator_summary: string;
}

export interface DeploymentEnvironmentProfile {
  readonly schema_version: typeof DEPLOYMENT_ENVIRONMENT_ROLLBACK_SCHEMA_VERSION;
  readonly environment_ref: Ref;
  readonly environment: DeploymentEnvironment;
  readonly truth_scope: DeploymentTruthScope;
  readonly allowed_process_roles: readonly DeploymentProcessRole[];
  readonly required_readiness_gates: readonly DeploymentReadinessGate[];
  readonly required_storage_refs: readonly Ref[];
  readonly required_reference_refs: readonly Ref[];
  readonly runtime_mutation_allowed: boolean;
  readonly qa_scope_mounted: boolean;
  readonly operator_summary: string;
  readonly determinism_hash: string;
}

export interface ProcessRoleDeploymentInput {
  readonly role_ref: Ref;
  readonly process_role: DeploymentProcessRole;
  readonly artifact_ref: Ref;
  readonly config_profile_ref: Ref;
  readonly service_identity_ref: Ref;
  readonly readiness_gate_refs: readonly DeploymentReadinessGate[];
  readonly health_probe_refs: readonly Ref[];
}

export interface ProcessRoleDeployment {
  readonly role_ref: Ref;
  readonly process_role: DeploymentProcessRole;
  readonly artifact_ref: Ref;
  readonly config_profile_ref: Ref;
  readonly service_identity_ref: Ref;
  readonly readiness_gate_refs: readonly DeploymentReadinessGate[];
  readonly health_probe_refs: readonly Ref[];
  readonly determinism_hash: string;
}

export interface DeploymentManifestInput {
  readonly manifest_ref: Ref;
  readonly environment_profile: DeploymentEnvironmentProfile;
  readonly process_roles: readonly ProcessRoleDeploymentInput[];
  readonly network_policy_refs: readonly Ref[];
  readonly storage_dependency_refs: readonly Ref[];
  readonly observability_refs: readonly Ref[];
}

export interface DeploymentManifest {
  readonly manifest_ref: Ref;
  readonly environment_ref: Ref;
  readonly process_roles: readonly ProcessRoleDeployment[];
  readonly network_policy_refs: readonly Ref[];
  readonly storage_dependency_refs: readonly Ref[];
  readonly observability_refs: readonly Ref[];
  readonly missing_required_role_refs: readonly DeploymentProcessRole[];
  readonly disallowed_role_refs: readonly DeploymentProcessRole[];
  readonly missing_storage_refs: readonly Ref[];
  readonly status: DeploymentGateStatus;
  readonly determinism_hash: string;
}

export interface SmokeEvidenceInput {
  readonly smoke_report_ref: Ref;
  readonly environment_ref: Ref;
  readonly required_smoke_refs: readonly Ref[];
  readonly observed_smoke_refs: readonly Ref[];
  readonly warning_refs?: readonly Ref[];
}

export interface SmokeEvidenceReport {
  readonly smoke_report_ref: Ref;
  readonly environment_ref: Ref;
  readonly required_smoke_refs: readonly Ref[];
  readonly observed_smoke_refs: readonly Ref[];
  readonly missing_smoke_refs: readonly Ref[];
  readonly warning_refs: readonly Ref[];
  readonly status: DeploymentGateStatus;
  readonly determinism_hash: string;
}

export interface BackupRestoreEvidenceInput {
  readonly backup_restore_report_ref: Ref;
  readonly environment_ref: Ref;
  readonly required_backup_refs: readonly Ref[];
  readonly observed_backup_refs: readonly Ref[];
  readonly required_restore_refs: readonly Ref[];
  readonly observed_restore_refs: readonly Ref[];
  readonly schema_validation_refs: readonly Ref[];
  readonly replay_validation_refs: readonly Ref[];
  readonly boundary_validation_refs: readonly Ref[];
}

export interface BackupRestoreEvidenceReport {
  readonly backup_restore_report_ref: Ref;
  readonly environment_ref: Ref;
  readonly required_backup_refs: readonly Ref[];
  readonly observed_backup_refs: readonly Ref[];
  readonly missing_backup_refs: readonly Ref[];
  readonly required_restore_refs: readonly Ref[];
  readonly observed_restore_refs: readonly Ref[];
  readonly missing_restore_refs: readonly Ref[];
  readonly schema_validation_refs: readonly Ref[];
  readonly replay_validation_refs: readonly Ref[];
  readonly boundary_validation_refs: readonly Ref[];
  readonly status: DeploymentGateStatus;
  readonly determinism_hash: string;
}

export interface RollbackEvidenceInput {
  readonly rollback_report_ref: Ref;
  readonly environment_ref: Ref;
  readonly current_artifact_ref: Ref;
  readonly rollback_target_artifact_ref: Ref;
  readonly rollback_runbook_ref: Ref;
  readonly required_drain_refs: readonly Ref[];
  readonly observed_drain_refs: readonly Ref[];
  readonly preserved_evidence_refs: readonly Ref[];
}

export interface RollbackEvidenceReport {
  readonly rollback_report_ref: Ref;
  readonly environment_ref: Ref;
  readonly current_artifact_ref: Ref;
  readonly rollback_target_artifact_ref: Ref;
  readonly rollback_runbook_ref: Ref;
  readonly required_drain_refs: readonly Ref[];
  readonly observed_drain_refs: readonly Ref[];
  readonly missing_drain_refs: readonly Ref[];
  readonly preserved_evidence_refs: readonly Ref[];
  readonly status: DeploymentGateStatus;
  readonly determinism_hash: string;
}

export interface DeploymentReadinessInput {
  readonly readiness_report_ref: Ref;
  readonly environment_profile: DeploymentEnvironmentProfileInput;
  readonly manifest: Omit<DeploymentManifestInput, "environment_profile">;
  readonly smoke_evidence: SmokeEvidenceInput;
  readonly backup_restore_evidence: BackupRestoreEvidenceInput;
  readonly rollback_evidence: RollbackEvidenceInput;
  readonly operator_summary: string;
}

export interface DeploymentReadinessReport {
  readonly schema_version: typeof DEPLOYMENT_ENVIRONMENT_ROLLBACK_SCHEMA_VERSION;
  readonly readiness_report_ref: Ref;
  readonly environment_profile: DeploymentEnvironmentProfile;
  readonly manifest: DeploymentManifest;
  readonly smoke_evidence: SmokeEvidenceReport;
  readonly backup_restore_evidence: BackupRestoreEvidenceReport;
  readonly rollback_evidence: RollbackEvidenceReport;
  readonly no_go_conditions: readonly string[];
  readonly conditional_go_conditions: readonly string[];
  readonly decision: DeploymentDecision;
  readonly operator_summary: string;
  readonly determinism_hash: string;
}

/**
 * Builds a deployment readiness report from environment, manifest, smoke,
 * backup/restore, and rollback evidence.
 */
export function buildDeploymentReadinessReport(input: DeploymentReadinessInput): DeploymentReadinessReport {
  const environmentProfile = buildDeploymentEnvironmentProfile(input.environment_profile);
  const manifest = buildDeploymentManifest({ ...input.manifest, environment_profile: environmentProfile });
  const smokeEvidence = normalizeSmokeEvidenceReport(input.smoke_evidence);
  const backupRestoreEvidence = normalizeBackupRestoreEvidenceReport(input.backup_restore_evidence);
  const rollbackEvidence = normalizeRollbackEvidenceReport(input.rollback_evidence);
  const noGoConditions = buildNoGoConditions(environmentProfile, manifest, smokeEvidence, backupRestoreEvidence, rollbackEvidence);
  const conditionalGoConditions = buildConditionalGoConditions(manifest, smokeEvidence, backupRestoreEvidence, rollbackEvidence);
  const decision = deriveDeploymentDecision(noGoConditions, conditionalGoConditions);
  const base = {
    schema_version: DEPLOYMENT_ENVIRONMENT_ROLLBACK_SCHEMA_VERSION,
    readiness_report_ref: input.readiness_report_ref,
    environment_profile: environmentProfile,
    manifest,
    smoke_evidence: smokeEvidence,
    backup_restore_evidence: backupRestoreEvidence,
    rollback_evidence: rollbackEvidence,
    no_go_conditions: noGoConditions,
    conditional_go_conditions: conditionalGoConditions,
    decision,
    operator_summary: normalizeDeploymentText(input.operator_summary, 900),
  };
  const report = Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  assertValidDeploymentReadinessReport(report);
  return report;
}

export function buildDeploymentEnvironmentProfile(input: DeploymentEnvironmentProfileInput): DeploymentEnvironmentProfile {
  const profile = normalizeDeploymentEnvironmentProfile(input);
  const validation = validateDeploymentEnvironmentProfile(profile);
  if (!validation.ok) {
    throw new DeploymentContractError("Deployment environment profile failed validation.", validation.issues);
  }
  return profile;
}

export function buildDeploymentManifest(input: DeploymentManifestInput): DeploymentManifest {
  const manifest = normalizeDeploymentManifest(input);
  const validation = validateDeploymentManifest(manifest);
  if (!validation.ok) {
    throw new DeploymentContractError("Deployment manifest failed validation.", validation.issues);
  }
  return manifest;
}

export function validateDeploymentReadinessReport(report: DeploymentReadinessReport): DeploymentValidationReport {
  const issues: ValidationIssue[] = [];
  validateDeploymentRef(report.readiness_report_ref, "$.readiness_report_ref", issues);
  validateDeploymentEnvironmentProfile(report.environment_profile).issues.forEach((issue) => issues.push(issue));
  validateDeploymentManifest(report.manifest).issues.forEach((issue) => issues.push(issue));
  validateSmokeEvidence(report.smoke_evidence, "$.smoke_evidence", issues);
  validateBackupRestoreEvidence(report.backup_restore_evidence, "$.backup_restore_evidence", issues);
  validateRollbackEvidence(report.rollback_evidence, "$.rollback_evidence", issues);
  validateDeploymentText(report.operator_summary, "$.operator_summary", true, issues);
  if (report.no_go_conditions.length > 0 && report.decision !== "no_go") {
    issues.push(deploymentIssue("error", "DeploymentNoGoDecisionMismatch", "$.decision", "No-go deployment conditions require no_go decision.", "Keep deployment blocked until no-go conditions are resolved."));
  }
  if (report.conditional_go_conditions.length > 0 && report.decision === "go") {
    issues.push(deploymentIssue("error", "DeploymentConditionalDecisionMismatch", "$.decision", "Conditional deployment conditions cannot produce go decision.", "Use conditional_go or resolve review conditions."));
  }
  return buildDeploymentValidationReport(makeDeploymentRef("deployment_readiness_report", report.readiness_report_ref), issues, deploymentRouteForIssues(issues));
}

export function assertValidDeploymentReadinessReport(report: DeploymentReadinessReport): void {
  const validation = validateDeploymentReadinessReport(report);
  if (!validation.ok) {
    throw new DeploymentContractError("Deployment readiness report failed validation.", validation.issues);
  }
}

export function normalizeDeploymentEnvironmentProfile(input: DeploymentEnvironmentProfileInput): DeploymentEnvironmentProfile {
  const base = {
    schema_version: DEPLOYMENT_ENVIRONMENT_ROLLBACK_SCHEMA_VERSION,
    environment_ref: input.environment_ref,
    environment: input.environment,
    truth_scope: input.truth_scope,
    allowed_process_roles: freezeDeploymentArray([...new Set(input.allowed_process_roles)]),
    required_readiness_gates: freezeDeploymentArray([...new Set(input.required_readiness_gates)]),
    required_storage_refs: uniqueDeploymentRefs(input.required_storage_refs),
    required_reference_refs: uniqueDeploymentRefs(input.required_reference_refs),
    runtime_mutation_allowed: input.runtime_mutation_allowed,
    qa_scope_mounted: input.qa_scope_mounted,
    operator_summary: normalizeDeploymentText(input.operator_summary, 700),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function normalizeDeploymentManifest(input: DeploymentManifestInput): DeploymentManifest {
  const roles = freezeDeploymentArray(input.process_roles.map(normalizeProcessRoleDeployment));
  const roleSet = new Set(roles.map((role) => role.process_role));
  const allowedSet = new Set(input.environment_profile.allowed_process_roles);
  const requiredRoles = requiredRolesForEnvironment(input.environment_profile);
  const missingRequiredRoles = freezeDeploymentArray(requiredRoles.filter((role) => !roleSet.has(role)));
  const disallowedRoles = freezeDeploymentArray([...roleSet].filter((role) => !allowedSet.has(role)));
  const storageDependencyRefs = uniqueDeploymentRefs(input.storage_dependency_refs);
  const storageSet = new Set(storageDependencyRefs);
  const missingStorageRefs = uniqueDeploymentRefs(input.environment_profile.required_storage_refs.filter((ref) => !storageSet.has(ref)));
  const status: DeploymentGateStatus = missingRequiredRoles.length > 0 || disallowedRoles.length > 0 || missingStorageRefs.length > 0
    ? "red"
    : roles.some((role) => role.health_probe_refs.length === 0)
      ? "amber"
      : "green";
  const base = {
    manifest_ref: input.manifest_ref,
    environment_ref: input.environment_profile.environment_ref,
    process_roles: roles,
    network_policy_refs: uniqueDeploymentRefs(input.network_policy_refs),
    storage_dependency_refs: storageDependencyRefs,
    observability_refs: uniqueDeploymentRefs(input.observability_refs),
    missing_required_role_refs: missingRequiredRoles,
    disallowed_role_refs: disallowedRoles,
    missing_storage_refs: missingStorageRefs,
    status,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function normalizeProcessRoleDeployment(input: ProcessRoleDeploymentInput): ProcessRoleDeployment {
  const base = {
    role_ref: input.role_ref,
    process_role: input.process_role,
    artifact_ref: input.artifact_ref,
    config_profile_ref: input.config_profile_ref,
    service_identity_ref: input.service_identity_ref,
    readiness_gate_refs: freezeDeploymentArray([...new Set(input.readiness_gate_refs)]),
    health_probe_refs: uniqueDeploymentRefs(input.health_probe_refs),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function normalizeSmokeEvidenceReport(input: SmokeEvidenceInput): SmokeEvidenceReport {
  const required = uniqueDeploymentRefs(input.required_smoke_refs);
  const observed = uniqueDeploymentRefs(input.observed_smoke_refs);
  const observedSet = new Set(observed);
  const missing = uniqueDeploymentRefs(required.filter((ref) => !observedSet.has(ref)));
  const warnings = uniqueDeploymentRefs(input.warning_refs ?? []);
  const status: DeploymentGateStatus = missing.length > 0 ? "red" : warnings.length > 0 ? "amber" : "green";
  const base = {
    smoke_report_ref: input.smoke_report_ref,
    environment_ref: input.environment_ref,
    required_smoke_refs: required,
    observed_smoke_refs: observed,
    missing_smoke_refs: missing,
    warning_refs: warnings,
    status,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function normalizeBackupRestoreEvidenceReport(input: BackupRestoreEvidenceInput): BackupRestoreEvidenceReport {
  const requiredBackups = uniqueDeploymentRefs(input.required_backup_refs);
  const observedBackups = uniqueDeploymentRefs(input.observed_backup_refs);
  const requiredRestores = uniqueDeploymentRefs(input.required_restore_refs);
  const observedRestores = uniqueDeploymentRefs(input.observed_restore_refs);
  const backupSet = new Set(observedBackups);
  const restoreSet = new Set(observedRestores);
  const missingBackups = uniqueDeploymentRefs(requiredBackups.filter((ref) => !backupSet.has(ref)));
  const missingRestores = uniqueDeploymentRefs(requiredRestores.filter((ref) => !restoreSet.has(ref)));
  const schemaRefs = uniqueDeploymentRefs(input.schema_validation_refs);
  const replayRefs = uniqueDeploymentRefs(input.replay_validation_refs);
  const boundaryRefs = uniqueDeploymentRefs(input.boundary_validation_refs);
  const missingValidation = schemaRefs.length === 0 || replayRefs.length === 0 || boundaryRefs.length === 0;
  const status: DeploymentGateStatus = missingBackups.length > 0 || missingRestores.length > 0 || missingValidation ? "red" : "green";
  const base = {
    backup_restore_report_ref: input.backup_restore_report_ref,
    environment_ref: input.environment_ref,
    required_backup_refs: requiredBackups,
    observed_backup_refs: observedBackups,
    missing_backup_refs: missingBackups,
    required_restore_refs: requiredRestores,
    observed_restore_refs: observedRestores,
    missing_restore_refs: missingRestores,
    schema_validation_refs: schemaRefs,
    replay_validation_refs: replayRefs,
    boundary_validation_refs: boundaryRefs,
    status,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function normalizeRollbackEvidenceReport(input: RollbackEvidenceInput): RollbackEvidenceReport {
  const requiredDrain = uniqueDeploymentRefs(input.required_drain_refs);
  const observedDrain = uniqueDeploymentRefs(input.observed_drain_refs);
  const observedDrainSet = new Set(observedDrain);
  const missingDrain = uniqueDeploymentRefs(requiredDrain.filter((ref) => !observedDrainSet.has(ref)));
  const preservedEvidence = uniqueDeploymentRefs(input.preserved_evidence_refs);
  const status: DeploymentGateStatus = missingDrain.length > 0 || preservedEvidence.length === 0 ? "red" : "green";
  const base = {
    rollback_report_ref: input.rollback_report_ref,
    environment_ref: input.environment_ref,
    current_artifact_ref: input.current_artifact_ref,
    rollback_target_artifact_ref: input.rollback_target_artifact_ref,
    rollback_runbook_ref: input.rollback_runbook_ref,
    required_drain_refs: requiredDrain,
    observed_drain_refs: observedDrain,
    missing_drain_refs: missingDrain,
    preserved_evidence_refs: preservedEvidence,
    status,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateDeploymentEnvironmentProfile(profile: DeploymentEnvironmentProfile): DeploymentValidationReport {
  const issues: ValidationIssue[] = [];
  validateDeploymentRef(profile.environment_ref, "$.environment_ref", issues);
  validateDeploymentNonEmptyArray(profile.allowed_process_roles, "$.allowed_process_roles", "DeploymentAllowedRolesMissing", issues);
  validateDeploymentNonEmptyArray(profile.required_readiness_gates, "$.required_readiness_gates", "DeploymentReadinessGatesMissing", issues);
  validateDeploymentNonEmptyArray(profile.required_reference_refs, "$.required_reference_refs", "DeploymentReferencesMissing", issues);
  validateDeploymentRefs(profile.required_storage_refs, "$.required_storage_refs", issues);
  validateDeploymentRefs(profile.required_reference_refs, "$.required_reference_refs", issues);
  validateDeploymentText(profile.operator_summary, "$.operator_summary", true, issues);
  if (profile.runtime_mutation_allowed) {
    for (const gate of ["safety", "storage", "event", "runtime", "observability"] as const) {
      if (!profile.required_readiness_gates.includes(gate)) {
        issues.push(deploymentIssue("error", "DeploymentRuntimeGateMissing", "$.required_readiness_gates", "Runtime mutation requires runtime, safety, storage, event, and observability readiness gates.", "Attach the required runtime mutation gates."));
      }
    }
  }
  if ((profile.environment === "production" || profile.environment === "staging" || profile.environment === "release_candidate") && profile.qa_scope_mounted) {
    issues.push(deploymentIssue("error", "DeploymentRuntimeQaScopeMounted", "$.qa_scope_mounted", "Runtime-capable deployment environments cannot mount QA-scoped stores or workers.", "Remove QA scope from the runtime-capable environment profile."));
  }
  if (profile.environment === "production" && profile.truth_scope !== "runtime_embodied_only") {
    issues.push(deploymentIssue("error", "DeploymentProductionTruthScopeInvalid", "$.truth_scope", "Production must use runtime embodied evidence only.", "Use runtime_embodied_only truth scope."));
  }
  if (profile.environment === "incident_replay" && profile.runtime_mutation_allowed) {
    issues.push(deploymentIssue("error", "DeploymentReplayMutationInvalid", "$.runtime_mutation_allowed", "Incident replay must be read-only.", "Disable runtime mutation for incident replay."));
  }
  return buildDeploymentValidationReport(makeDeploymentRef("environment_profile_report", profile.environment_ref), issues, deploymentRouteForIssues(issues));
}

export function validateDeploymentManifest(manifest: DeploymentManifest): DeploymentValidationReport {
  const issues: ValidationIssue[] = [];
  validateDeploymentRef(manifest.manifest_ref, "$.manifest_ref", issues);
  validateDeploymentRef(manifest.environment_ref, "$.environment_ref", issues);
  validateDeploymentNonEmptyArray(manifest.process_roles, "$.process_roles", "DeploymentProcessRolesMissing", issues);
  validateDeploymentNonEmptyArray(manifest.network_policy_refs, "$.network_policy_refs", "DeploymentNetworkPoliciesMissing", issues);
  validateDeploymentNonEmptyArray(manifest.storage_dependency_refs, "$.storage_dependency_refs", "DeploymentStorageDependenciesMissing", issues);
  validateDeploymentNonEmptyArray(manifest.observability_refs, "$.observability_refs", "DeploymentObservabilityRefsMissing", issues);
  validateDeploymentRefs(manifest.network_policy_refs, "$.network_policy_refs", issues);
  validateDeploymentRefs(manifest.storage_dependency_refs, "$.storage_dependency_refs", issues);
  validateDeploymentRefs(manifest.observability_refs, "$.observability_refs", issues);
  for (const [index, role] of manifest.process_roles.entries()) {
    validateProcessRoleDeployment(role, `$.process_roles[${index}]`, issues);
  }
  if (manifest.status === "green" && (manifest.missing_required_role_refs.length > 0 || manifest.disallowed_role_refs.length > 0 || manifest.missing_storage_refs.length > 0)) {
    issues.push(deploymentIssue("error", "DeploymentManifestGreenWithDefect", "$.status", "Manifest cannot be green with missing or disallowed role/storage evidence.", "Repair manifest status derivation."));
  }
  return buildDeploymentValidationReport(makeDeploymentRef("deployment_manifest_report", manifest.manifest_ref), issues, deploymentRouteForIssues(issues));
}

function validateProcessRoleDeployment(role: ProcessRoleDeployment, path: string, issues: ValidationIssue[]): void {
  validateDeploymentRef(role.role_ref, `${path}.role_ref`, issues);
  validateDeploymentRef(role.artifact_ref, `${path}.artifact_ref`, issues);
  validateDeploymentRef(role.config_profile_ref, `${path}.config_profile_ref`, issues);
  validateDeploymentRef(role.service_identity_ref, `${path}.service_identity_ref`, issues);
  validateDeploymentNonEmptyArray(role.readiness_gate_refs, `${path}.readiness_gate_refs`, "ProcessRoleReadinessGatesMissing", issues);
  validateDeploymentNonEmptyArray(role.health_probe_refs, `${path}.health_probe_refs`, "ProcessRoleHealthProbesMissing", issues);
  validateDeploymentRefs(role.health_probe_refs, `${path}.health_probe_refs`, issues);
}

function validateSmokeEvidence(report: SmokeEvidenceReport, path: string, issues: ValidationIssue[]): void {
  validateDeploymentRef(report.smoke_report_ref, `${path}.smoke_report_ref`, issues);
  validateDeploymentRef(report.environment_ref, `${path}.environment_ref`, issues);
  validateDeploymentNonEmptyArray(report.required_smoke_refs, `${path}.required_smoke_refs`, "SmokeRequirementsMissing", issues);
  validateDeploymentRefs(report.required_smoke_refs, `${path}.required_smoke_refs`, issues);
  validateDeploymentRefs(report.observed_smoke_refs, `${path}.observed_smoke_refs`, issues);
  validateDeploymentRefs(report.warning_refs, `${path}.warning_refs`, issues);
  if (report.status === "green" && report.missing_smoke_refs.length > 0) {
    issues.push(deploymentIssue("error", "SmokeGreenWithMissingEvidence", `${path}.status`, "Smoke evidence cannot be green with missing smoke refs.", "Attach missing smoke evidence refs."));
  }
}

function validateBackupRestoreEvidence(report: BackupRestoreEvidenceReport, path: string, issues: ValidationIssue[]): void {
  validateDeploymentRef(report.backup_restore_report_ref, `${path}.backup_restore_report_ref`, issues);
  validateDeploymentRef(report.environment_ref, `${path}.environment_ref`, issues);
  validateDeploymentNonEmptyArray(report.required_backup_refs, `${path}.required_backup_refs`, "BackupRequirementsMissing", issues);
  validateDeploymentNonEmptyArray(report.required_restore_refs, `${path}.required_restore_refs`, "RestoreRequirementsMissing", issues);
  validateDeploymentNonEmptyArray(report.schema_validation_refs, `${path}.schema_validation_refs`, "SchemaValidationRefsMissing", issues);
  validateDeploymentNonEmptyArray(report.replay_validation_refs, `${path}.replay_validation_refs`, "ReplayValidationRefsMissing", issues);
  validateDeploymentNonEmptyArray(report.boundary_validation_refs, `${path}.boundary_validation_refs`, "BoundaryValidationRefsMissing", issues);
  validateDeploymentRefs(report.required_backup_refs, `${path}.required_backup_refs`, issues);
  validateDeploymentRefs(report.observed_backup_refs, `${path}.observed_backup_refs`, issues);
  validateDeploymentRefs(report.required_restore_refs, `${path}.required_restore_refs`, issues);
  validateDeploymentRefs(report.observed_restore_refs, `${path}.observed_restore_refs`, issues);
  if (report.status === "green" && (report.missing_backup_refs.length > 0 || report.missing_restore_refs.length > 0)) {
    issues.push(deploymentIssue("error", "BackupRestoreGreenWithMissingEvidence", `${path}.status`, "Backup/restore evidence cannot be green with missing refs.", "Attach missing backup and restore refs."));
  }
}

function validateRollbackEvidence(report: RollbackEvidenceReport, path: string, issues: ValidationIssue[]): void {
  validateDeploymentRef(report.rollback_report_ref, `${path}.rollback_report_ref`, issues);
  validateDeploymentRef(report.environment_ref, `${path}.environment_ref`, issues);
  validateDeploymentRef(report.current_artifact_ref, `${path}.current_artifact_ref`, issues);
  validateDeploymentRef(report.rollback_target_artifact_ref, `${path}.rollback_target_artifact_ref`, issues);
  validateDeploymentRef(report.rollback_runbook_ref, `${path}.rollback_runbook_ref`, issues);
  validateDeploymentNonEmptyArray(report.required_drain_refs, `${path}.required_drain_refs`, "RollbackDrainRequirementsMissing", issues);
  validateDeploymentNonEmptyArray(report.preserved_evidence_refs, `${path}.preserved_evidence_refs`, "RollbackPreservedEvidenceMissing", issues);
  validateDeploymentRefs(report.required_drain_refs, `${path}.required_drain_refs`, issues);
  validateDeploymentRefs(report.observed_drain_refs, `${path}.observed_drain_refs`, issues);
  validateDeploymentRefs(report.preserved_evidence_refs, `${path}.preserved_evidence_refs`, issues);
  if (report.status === "green" && report.missing_drain_refs.length > 0) {
    issues.push(deploymentIssue("error", "RollbackGreenWithMissingDrain", `${path}.status`, "Rollback evidence cannot be green with missing drain refs.", "Attach drain, abort, or SafeHold evidence."));
  }
}

function buildNoGoConditions(
  profile: DeploymentEnvironmentProfile,
  manifest: DeploymentManifest,
  smoke: SmokeEvidenceReport,
  backupRestore: BackupRestoreEvidenceReport,
  rollback: RollbackEvidenceReport,
): readonly string[] {
  const conditions: string[] = [];
  if (profile.environment === "production" && profile.qa_scope_mounted) conditions.push("production_qa_scope_mounted");
  if (profile.environment === "production" && profile.truth_scope !== "runtime_embodied_only") conditions.push("production_truth_scope_invalid");
  if (manifest.status === "red") conditions.push("deployment_manifest_red");
  if (smoke.status === "red") conditions.push("deployment_smoke_red");
  if (backupRestore.status === "red") conditions.push("backup_restore_red");
  if (rollback.status === "red") conditions.push("rollback_readiness_red");
  return freezeDeploymentArray([...new Set(conditions)]);
}

function buildConditionalGoConditions(
  manifest: DeploymentManifest,
  smoke: SmokeEvidenceReport,
  backupRestore: BackupRestoreEvidenceReport,
  rollback: RollbackEvidenceReport,
): readonly string[] {
  const conditions: string[] = [];
  if (manifest.status === "amber") conditions.push("deployment_manifest_review");
  if (smoke.status === "amber") conditions.push("deployment_smoke_review");
  if (backupRestore.status === "amber") conditions.push("backup_restore_review");
  if (rollback.status === "amber") conditions.push("rollback_review");
  return freezeDeploymentArray([...new Set(conditions)]);
}

function deriveDeploymentDecision(noGoConditions: readonly string[], conditionalGoConditions: readonly string[]): DeploymentDecision {
  if (noGoConditions.length > 0) return "no_go";
  if (conditionalGoConditions.length > 0) return "conditional_go";
  return "go";
}

function requiredRolesForEnvironment(profile: DeploymentEnvironmentProfile): readonly DeploymentProcessRole[] {
  if (profile.environment === "production" || profile.environment === "staging") {
    return ["api_server", "runtime_worker", "background_worker", "frontend"];
  }
  if (profile.environment === "release_candidate") {
    return ["api_server", "runtime_worker", "background_worker", "frontend", "release_gate"];
  }
  if (profile.environment === "qa_benchmark") {
    return ["qa_worker", "replay_worker", "release_gate"];
  }
  if (profile.environment === "incident_replay") {
    return ["replay_worker"];
  }
  if (profile.environment === "ci_validation") {
    return ["release_gate"];
  }
  return ["api_server"];
}

export class DeploymentContractError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "DeploymentContractError";
    this.issues = freezeDeploymentArray(issues);
  }
}

export function buildDeploymentValidationReport(reportRef: Ref, issues: readonly ValidationIssue[], recommendedRoute: DeploymentRoute): DeploymentValidationReport {
  const frozenIssues = freezeDeploymentArray(issues);
  const errorCount = frozenIssues.filter((issue) => issue.severity === "error").length;
  const warningCount = frozenIssues.length - errorCount;
  const base = {
    report_ref: reportRef,
    ok: errorCount === 0,
    issue_count: frozenIssues.length,
    error_count: errorCount,
    warning_count: warningCount,
    recommended_route: recommendedRoute,
    issues: frozenIssues,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function deploymentRouteForIssues(issues: readonly ValidationIssue[]): DeploymentRoute {
  if (issues.some((issue) => issue.severity === "error")) return "release_block";
  if (issues.some((issue) => issue.severity === "warning")) return "review";
  return "continue";
}

export function deploymentIssue(severity: ValidationSeverity, code: string, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

export function validateDeploymentRef(ref: Ref | undefined, path: string, issues: ValidationIssue[]): void {
  if (ref === undefined || ref.trim().length === 0 || /\s/u.test(ref)) {
    issues.push(deploymentIssue("error", "DeploymentRefInvalid", path, "Reference must be present, non-empty, and whitespace-free.", "Use a stable opaque deployment ref."));
  }
}

export function validateDeploymentRefs(refs: readonly Ref[], path: string, issues: ValidationIssue[]): void {
  refs.forEach((ref, index) => validateDeploymentRef(ref, `${path}[${index}]`, issues));
}

export function validateDeploymentText(value: string, path: string, required: boolean, issues: ValidationIssue[]): void {
  if (required && value.trim().length === 0) {
    issues.push(deploymentIssue("error", "DeploymentTextRequired", path, "Required deployment text is empty.", "Provide concise deployment evidence text."));
  }
  if (/reward\s*update|policy\s*gradient|ignore\s*safety/iu.test(value)) {
    issues.push(deploymentIssue("error", "DeploymentTextForbidden", path, "Deployment text contains forbidden governance wording.", "Use no-RL and safety-preserving wording."));
  }
}

export function validateDeploymentNonEmptyArray<T>(items: readonly T[], path: string, code: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(items) || items.length === 0) {
    issues.push(deploymentIssue("error", code, path, "Array must contain at least one item.", "Attach the required deployment entries."));
  }
}

export function normalizeDeploymentText(value: string, maxChars = 1000): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, maxChars);
}

export function makeDeploymentRef(...parts: readonly (string | number | undefined)[]): Ref {
  const normalized = parts
    .filter((part): part is string | number => part !== undefined)
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return normalized.length > 0 ? normalized : "deployment:empty";
}

export function uniqueDeploymentRefs(items: readonly (Ref | undefined)[]): readonly Ref[] {
  return freezeDeploymentArray([...new Set(items.filter((item): item is Ref => item !== undefined && item.trim().length > 0))]);
}

export function freezeDeploymentArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

export const DEPLOYMENT_ENVIRONMENT_ROLLBACK_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: DEPLOYMENT_ENVIRONMENT_ROLLBACK_SCHEMA_VERSION,
  readiness_plan: "production_readiness_docs/13_DEPLOYMENT_INFRASTRUCTURE_AND_ENVIRONMENTS.md",
  sections: freezeDeploymentArray(["13.4", "13.5", "13.6", "13.7", "13.16", "13.19", "13.20", "13.22"]),
  component: "DeploymentEnvironmentRollback",
});
