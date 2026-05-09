/**
 * Provenance manifest contract for Project Mebsuta service APIs.
 *
 * Blueprint: `architecture_docs/19_API_SERVICE_BOUNDARIES_AND_DATA_CONTRACTS.md`
 * sections 19.1, 19.4.2, 19.4.3, 19.9.5, 19.11, and 19.12.
 *
 * The manifest records source classes, truth-boundary status, cognitive,
 * memory, and QA visibility, and fail-closed routing for restricted data.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  API_BLUEPRINT_REF,
  apiIssue,
  buildApiReport,
  compactApiText,
  containsForbiddenApiText,
  freezeApiArray,
  makeApiRef,
  routeForIssues,
  uniqueApiRefs,
  uniqueApiStrings,
  validateApiRef,
  validateApiText,
} from "./artifact_envelope";
import type { ApiContractValidationReport, ApiVisibilityClass, TruthBoundaryStatus } from "./artifact_envelope";

export const PROVENANCE_MANIFEST_CONTRACT_SCHEMA_VERSION = "mebsuta.api.provenance_manifest_contract.v1" as const;

export type ProvenanceSourceClass = "embodied_sensor" | "derived_estimate" | "controller_telemetry" | "policy_config" | "memory" | "validator_output" | "qa_truth";
export type ProvenanceVisibility = "allowed" | "summarized" | "redacted" | "forbidden";
export type MemoryVisibility = "allowed" | "summary_only" | "forbidden";
export type QaVisibility = "not_allowed" | "offline_only" | "qa_report_only";

export interface ProvenanceManifestInput {
  readonly provenance_manifest_ref: Ref;
  readonly source_classes: readonly ProvenanceSourceClass[];
  readonly cognitive_visibility: ProvenanceVisibility;
  readonly memory_visibility: MemoryVisibility;
  readonly qa_visibility: QaVisibility;
  readonly truth_boundary_status: TruthBoundaryStatus;
  readonly source_artifact_refs: readonly Ref[];
  readonly policy_refs?: readonly Ref[];
  readonly audit_notes?: readonly string[];
}

export interface ProvenanceManifest {
  readonly schema_version: typeof PROVENANCE_MANIFEST_CONTRACT_SCHEMA_VERSION;
  readonly provenance_manifest_ref: Ref;
  readonly source_classes: readonly ProvenanceSourceClass[];
  readonly forbidden_source_detected: boolean;
  readonly cognitive_visibility: ProvenanceVisibility;
  readonly memory_visibility: MemoryVisibility;
  readonly qa_visibility: QaVisibility;
  readonly truth_boundary_status: TruthBoundaryStatus;
  readonly source_artifact_refs: readonly Ref[];
  readonly policy_refs: readonly Ref[];
  readonly audit_notes: readonly string[];
  readonly recommended_visibility_class: ApiVisibilityClass;
  readonly determinism_hash: string;
}

/**
 * Builds an immutable provenance manifest and rejects invalid source routing.
 */
export function buildProvenanceManifest(input: ProvenanceManifestInput): ProvenanceManifest {
  const manifest = normalizeProvenanceManifest(input);
  const report = validateProvenanceManifest(manifest);
  if (!report.ok) {
    throw new ProvenanceManifestContractError("Provenance manifest failed validation.", report.issues);
  }
  return manifest;
}

export function normalizeProvenanceManifest(input: ProvenanceManifestInput): ProvenanceManifest {
  const forbidden = input.source_classes.includes("qa_truth")
    || input.truth_boundary_status === "qa_truth_only"
    || input.truth_boundary_status === "truth_boundary_violation"
    || input.truth_boundary_status === "mixed_with_restricted_data"
    || input.audit_notes?.some(containsForbiddenApiText) === true;
  const base = {
    schema_version: PROVENANCE_MANIFEST_CONTRACT_SCHEMA_VERSION,
    provenance_manifest_ref: input.provenance_manifest_ref,
    source_classes: freezeApiArray([...new Set(input.source_classes)]),
    forbidden_source_detected: forbidden,
    cognitive_visibility: forbidden ? "forbidden" as const : input.cognitive_visibility,
    memory_visibility: forbidden && input.truth_boundary_status !== "runtime_memory_labeled" ? "forbidden" as const : input.memory_visibility,
    qa_visibility: input.qa_visibility,
    truth_boundary_status: input.truth_boundary_status,
    source_artifact_refs: uniqueApiRefs(input.source_artifact_refs),
    policy_refs: uniqueApiRefs(input.policy_refs ?? []),
    audit_notes: uniqueApiStrings(input.audit_notes ?? []),
    recommended_visibility_class: recommendedVisibility(input.truth_boundary_status, input.cognitive_visibility, input.qa_visibility, forbidden),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateProvenanceManifest(manifest: ProvenanceManifest): ApiContractValidationReport {
  const issues: ValidationIssue[] = [];
  validateApiRef(manifest.provenance_manifest_ref, "$.provenance_manifest_ref", issues);
  if (manifest.source_classes.length === 0) {
    issues.push(apiIssue("error", "ProvenanceSourcesMissing", "$.source_classes", "At least one source class is required.", "Attach embodied, policy, memory, validator, or QA source class."));
  }
  for (const [index, ref] of manifest.source_artifact_refs.entries()) {
    validateApiRef(ref, `$.source_artifact_refs[${index}]`, issues);
  }
  for (const [index, note] of manifest.audit_notes.entries()) {
    validateApiText(note, `$.audit_notes[${index}]`, false, issues);
  }
  if (manifest.truth_boundary_status === "runtime_embodied_only" && manifest.source_classes.includes("qa_truth")) {
    issues.push(apiIssue("error", "RuntimeBoundaryContainsQaTruth", "$.source_classes", "Runtime embodied status cannot contain QA truth.", "Move QA truth to an offline-only manifest."));
  }
  if (manifest.cognitive_visibility === "allowed" && manifest.forbidden_source_detected) {
    issues.push(apiIssue("error", "ForbiddenSourceCognitiveVisible", "$.cognitive_visibility", "Forbidden source cannot enter cognition.", "Redact, quarantine, or route to QA offline."));
  }
  if (manifest.truth_boundary_status === "truth_boundary_violation" && manifest.recommended_visibility_class !== "restricted_quarantine") {
    issues.push(apiIssue("error", "TruthBoundaryViolationNotQuarantined", "$.recommended_visibility_class", "Truth-boundary violations must be quarantined.", "Set restricted quarantine visibility."));
  }
  return buildApiReport(makeApiRef("provenance_manifest_report", manifest.provenance_manifest_ref), issues, routeForIssues(issues));
}

export function provenanceAllowsCognition(manifest: ProvenanceManifest): boolean {
  return manifest.cognitive_visibility === "allowed"
    && !manifest.forbidden_source_detected
    && (manifest.truth_boundary_status === "runtime_embodied_only" || manifest.truth_boundary_status === "runtime_policy_only" || manifest.truth_boundary_status === "runtime_memory_labeled");
}

export function provenanceAllowsMemoryWrite(manifest: ProvenanceManifest): boolean {
  return manifest.memory_visibility !== "forbidden"
    && !manifest.forbidden_source_detected
    && manifest.truth_boundary_status !== "qa_truth_only"
    && manifest.truth_boundary_status !== "truth_boundary_violation";
}

function recommendedVisibility(
  truthStatus: TruthBoundaryStatus,
  cognitiveVisibility: ProvenanceVisibility,
  qaVisibility: QaVisibility,
  forbidden: boolean,
): ApiVisibilityClass {
  if (truthStatus === "truth_boundary_violation" || forbidden && cognitiveVisibility === "forbidden") {
    return "restricted_quarantine";
  }
  if (truthStatus === "qa_truth_only" || qaVisibility !== "not_allowed") {
    return "qa_offline";
  }
  if (cognitiveVisibility === "allowed") {
    return "runtime_cognitive";
  }
  if (cognitiveVisibility === "redacted" || cognitiveVisibility === "summarized") {
    return "redacted";
  }
  return "runtime_deterministic";
}

export class ProvenanceManifestContractError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "ProvenanceManifestContractError";
    this.issues = freezeApiArray(issues);
  }
}

export const PROVENANCE_MANIFEST_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: PROVENANCE_MANIFEST_CONTRACT_SCHEMA_VERSION,
  blueprint: API_BLUEPRINT_REF,
  sections: freezeApiArray(["19.1", "19.4.2", "19.4.3", "19.9.5", "19.11", "19.12"]),
  component: "ProvenanceManifestContract",
});
