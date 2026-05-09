/**
 * Export guard for PIT-B05 auth/security foundation.
 *
 * Blueprint: `production_readiness_docs/07_AUTH_SECURITY_AND_POLICY_PLAN.md`
 * sections 11, 14, 16, 17, 19, 21, and 23.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import type { ArtifactEnvelope, ApiVisibilityClass } from "../api/artifact_envelope";
import type { ProvenanceManifest } from "../api/provenance_manifest_contract";
import type { ActorContext } from "../auth/actor_context";
import {
  freezeAuthArray,
  makeAuthRef,
  uniqueAuthRefs,
  validateAuthRef,
} from "../auth/actor_context";
import { AuthorizationPolicyEngine, type AuthorizationDecisionRecord, type RuntimeQaBoundaryLabel } from "../auth/authorization_policy_engine";
import type { AuthPermission } from "../auth/role_permission_registry";
import { redactSecrets, type RedactionResult } from "./secret_redaction";

export const EXPORT_SECURITY_GUARD_SCHEMA_VERSION = "mebsuta.security.export_security_guard.v1" as const;

export type ExportKind = "runtime_replay" | "qa_report" | "restricted_artifact" | "telemetry" | "memory_evidence";
export type ExportDecisionKind = "approved" | "denied";

export interface ExportSecurityRequest {
  readonly export_request_ref: Ref;
  readonly actor: ActorContext;
  readonly export_kind: ExportKind;
  readonly destination_ref: Ref;
  readonly artifact_envelope: ArtifactEnvelope;
  readonly provenance_manifest: ProvenanceManifest;
  readonly payload_summary: string;
  readonly requested_at_ms: number;
  readonly policy_bundle_ref: Ref;
  readonly correlation_ref: Ref;
}

export interface ExportSecurityDecision {
  readonly schema_version: typeof EXPORT_SECURITY_GUARD_SCHEMA_VERSION;
  readonly export_decision_ref: Ref;
  readonly export_request_ref: Ref;
  readonly actor_ref: Ref;
  readonly export_kind: ExportKind;
  readonly destination_ref: Ref;
  readonly runtime_qa_boundary_label: RuntimeQaBoundaryLabel;
  readonly source_visibility_class: ApiVisibilityClass;
  readonly approved_visibility_class: ApiVisibilityClass;
  readonly decision: ExportDecisionKind;
  readonly reason: string;
  readonly authorization_decision: AuthorizationDecisionRecord;
  readonly redaction_result: RedactionResult;
  readonly audit_refs: readonly Ref[];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export class ExportSecurityGuard {
  private readonly authorizationEngine: AuthorizationPolicyEngine;

  public constructor(options: { readonly authorizationEngine?: AuthorizationPolicyEngine } = {}) {
    this.authorizationEngine = options.authorizationEngine ?? new AuthorizationPolicyEngine();
  }

  public evaluateExport(request: ExportSecurityRequest): ExportSecurityDecision {
    const issues = validateExportRequest(request);
    const boundaryLabel = labelFor(request.artifact_envelope.visibility_class, request.provenance_manifest.truth_boundary_status);
    const permission = permissionForExport(request.export_kind);
    const authz = this.authorizationEngine.evaluateAuthorization({
      request_ref: makeAuthRef("export_authz", request.export_request_ref),
      actor: request.actor,
      permission,
      subject_type: "export",
      subject_ref: request.artifact_envelope.artifact_ref,
      environment_scope: request.actor.environment_scopes[0] ?? "development",
      runtime_scope: request.actor.runtime_scopes[0] ?? "runtime",
      artifact_visibility_class: request.artifact_envelope.visibility_class,
      policy_bundle_ref: request.policy_bundle_ref,
      safety_state: "normal",
      runtime_qa_boundary_label: boundaryLabel,
      correlation_ref: request.correlation_ref,
    });
    const redaction = redactSecrets({
      input_ref: request.export_request_ref,
      text: request.payload_summary,
      audit_refs: [request.artifact_envelope.artifact_ref, request.provenance_manifest.provenance_manifest_ref],
    });
    const boundaryAllows = boundaryLabel !== "restricted_quarantine" || permission === "export:restricted_artifact";
    const approved = authz.decision === "allowed" && boundaryAllows && issues.every((issue) => issue.severity !== "error");
    const approvedVisibility = approved ? visibilityForExport(request.export_kind, request.artifact_envelope.visibility_class) : "restricted_quarantine";
    const base = {
      schema_version: EXPORT_SECURITY_GUARD_SCHEMA_VERSION,
      export_decision_ref: makeAuthRef("export_decision", request.export_request_ref, approved ? "approved" : "denied"),
      export_request_ref: request.export_request_ref,
      actor_ref: request.actor.actor_ref,
      export_kind: request.export_kind,
      destination_ref: request.destination_ref,
      runtime_qa_boundary_label: boundaryLabel,
      source_visibility_class: request.artifact_envelope.visibility_class,
      approved_visibility_class: approvedVisibility,
      decision: approved ? "approved" as const : "denied" as const,
      reason: approved ? "Export approved with authorization, redaction, destination, and audit refs." : denyReason(authz, boundaryAllows),
      authorization_decision: authz,
      redaction_result: redaction,
      audit_refs: uniqueAuthRefs([request.export_request_ref, authz.decision_ref, redaction.redaction_ref, request.artifact_envelope.artifact_ref, request.provenance_manifest.provenance_manifest_ref]),
      issues: freezeAuthArray(issues),
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function permissionForExport(kind: ExportKind): AuthPermission {
  switch (kind) {
    case "runtime_replay":
    case "telemetry":
    case "memory_evidence":
      return "export:runtime_replay";
    case "qa_report":
      return "export:qa_report";
    case "restricted_artifact":
      return "export:restricted_artifact";
  }
}

function validateExportRequest(request: ExportSecurityRequest): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateAuthRef(request.export_request_ref, "$.export_request_ref", issues);
  validateAuthRef(request.destination_ref, "$.destination_ref", issues);
  validateAuthRef(request.policy_bundle_ref, "$.policy_bundle_ref", issues);
  validateAuthRef(request.correlation_ref, "$.correlation_ref", issues);
  return freezeAuthArray(issues);
}

function labelFor(visibility: ApiVisibilityClass, truthStatus: ProvenanceManifest["truth_boundary_status"]): RuntimeQaBoundaryLabel {
  if (visibility === "restricted_quarantine" || truthStatus === "truth_boundary_violation") {
    return "restricted_quarantine";
  }
  if (visibility === "qa_offline" || truthStatus === "qa_truth_only") {
    return "qa";
  }
  if (visibility === "redacted") {
    return "redacted";
  }
  return "runtime";
}

function visibilityForExport(kind: ExportKind, source: ApiVisibilityClass): ApiVisibilityClass {
  if (kind === "qa_report") {
    return "qa_offline";
  }
  if (kind === "restricted_artifact") {
    return "restricted_quarantine";
  }
  return source === "runtime_cognitive" ? "redacted" : source;
}

function denyReason(authz: AuthorizationDecisionRecord, boundaryAllows: boolean): string {
  if (authz.decision !== "allowed") {
    return authz.reason;
  }
  if (!boundaryAllows) {
    return "Export boundary denies restricted quarantine material without restricted export permission.";
  }
  return "Export request failed validation.";
}

export const EXPORT_SECURITY_GUARD_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: EXPORT_SECURITY_GUARD_SCHEMA_VERSION,
  blueprint: "production_readiness_docs/07_AUTH_SECURITY_AND_POLICY_PLAN.md",
  sections: freezeAuthArray(["11", "14", "16", "17", "19", "21", "23"]),
  component: "ExportSecurityGuard",
});
