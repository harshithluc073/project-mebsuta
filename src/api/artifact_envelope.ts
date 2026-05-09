/**
 * Global artifact envelope for Project Mebsuta service APIs.
 *
 * Blueprint: `architecture_docs/19_API_SERVICE_BOUNDARIES_AND_DATA_CONTRACTS.md`
 * sections 19.2, 19.4, 19.7, 19.8, 19.10, 19.11, and 19.12.
 *
 * This module defines the shared executable contract that every cross-service
 * artifact carries: stable refs, schema refs, service ownership, provenance,
 * validation state, visibility, policies, and audit replay links.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";

export const API_ARTIFACT_ENVELOPE_SCHEMA_VERSION = "mebsuta.api.artifact_envelope.v1" as const;
export const API_BLUEPRINT_REF = "architecture_docs/19_API_SERVICE_BOUNDARIES_AND_DATA_CONTRACTS.md" as const;

const FORBIDDEN_API_TEXT_PATTERN = /(backend|engine|scene[_ -]?graph|world[_ -]?truth|ground[_ -]?truth|hidden[_ -]?state|hidden[_ -]?pose|exact[_ -]?pose|object[_ -]?id|collision[_ -]?mesh|rigid[_ -]?body|physics[_ -]?body|qa[_ -]?label|qa[_ -]?success|oracle|benchmark[_ -]?truth|system prompt|developer prompt|chain[_ -]?of[_ -]?thought|scratchpad|raw prompt|raw model|direct actuator|raw actuator|ignore safety|override safety|disable safe[_ -]?hold|reinforcement learning|reward policy|policy gradient)/i;

export type ApiServiceRef =
  | "simulation_physics"
  | "visualization"
  | "sensor_bus"
  | "perception"
  | "gemini_adapter"
  | "prompt_contract"
  | "agent_orchestration"
  | "safety_guardrail"
  | "control_execution"
  | "manipulation_primitive"
  | "verification"
  | "oops_correction"
  | "rag_memory"
  | "acoustic"
  | "observability_tts"
  | "qa_scenario";

export type ArtifactType =
  | "scenario_spec"
  | "simulation_step"
  | "sensor_packet"
  | "sensor_bundle"
  | "perception_summary"
  | "audio_event"
  | "prompt_bundle"
  | "model_response"
  | "cognitive_plan"
  | "safety_validation_report"
  | "execution_command"
  | "control_telemetry"
  | "manipulation_primitive"
  | "verification_certificate"
  | "oops_episode"
  | "correction_plan"
  | "memory_record"
  | "tts_playback"
  | "safe_hold_state"
  | "route_decision"
  | "contract_error"
  | "repair_request"
  | "qa_scorecard";

export type ArtifactValidationStatus = "unvalidated" | "valid" | "rejected" | "repaired" | "quarantined";
export type ApiVisibilityClass = "runtime_cognitive" | "runtime_deterministic" | "developer_observability" | "qa_offline" | "restricted_quarantine" | "redacted";
export type TruthBoundaryStatus = "runtime_embodied_only" | "runtime_policy_only" | "runtime_memory_labeled" | "mixed_with_restricted_data" | "qa_truth_only" | "truth_boundary_violation";
export type ApiRoute = "Continue" | "Repair" | "Reobserve" | "Reject" | "Quarantine" | "SafeHold" | "HumanReview" | "QaFailure";

export interface ArtifactEnvelope {
  readonly artifact_ref: Ref;
  readonly artifact_type: ArtifactType;
  readonly schema_ref: Ref;
  readonly service_of_record: ApiServiceRef;
  readonly created_at_ms: number;
  readonly created_by_component: Ref;
  readonly task_ref?: Ref;
  readonly episode_ref?: Ref;
  readonly parent_artifact_refs: readonly Ref[];
  readonly provenance_manifest_ref: Ref;
  readonly policy_refs: readonly Ref[];
  readonly validation_status: ArtifactValidationStatus;
  readonly visibility_class: ApiVisibilityClass;
  readonly audit_replay_refs: readonly Ref[];
  readonly determinism_hash: string;
}

export interface ArtifactEnvelopeInput {
  readonly artifact_ref: Ref;
  readonly artifact_type: ArtifactType;
  readonly schema_ref: Ref;
  readonly service_of_record: ApiServiceRef;
  readonly created_at_ms: number;
  readonly created_by_component: Ref;
  readonly task_ref?: Ref;
  readonly episode_ref?: Ref;
  readonly parent_artifact_refs?: readonly Ref[];
  readonly provenance_manifest_ref: Ref;
  readonly policy_refs?: readonly Ref[];
  readonly validation_status?: ArtifactValidationStatus;
  readonly visibility_class: ApiVisibilityClass;
  readonly audit_replay_refs?: readonly Ref[];
}

export interface ApiContractValidationReport {
  readonly report_ref: Ref;
  readonly ok: boolean;
  readonly issue_count: number;
  readonly error_count: number;
  readonly warning_count: number;
  readonly recommended_route: ApiRoute;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface TaskContextContract {
  readonly task_ref: Ref;
  readonly task_goal_summary: string;
  readonly constraint_refs: readonly Ref[];
  readonly target_object_descriptors: readonly string[];
  readonly allowed_embodiment_refs: readonly Ref[];
  readonly active_policy_refs: readonly Ref[];
  readonly task_phase: "Observe" | "Plan" | "Validate" | "Execute" | "Verify" | "Correct" | "MemoryUpdate" | "SafeHold" | "HumanReview" | "Complete";
  readonly retry_context_ref?: Ref;
  readonly truth_boundary_status: TruthBoundaryStatus;
}

export interface ObservationContextContract {
  readonly observation_context_ref: Ref;
  readonly sensor_bundle_refs: readonly Ref[];
  readonly perception_summary_refs: readonly Ref[];
  readonly view_quality_refs: readonly Ref[];
  readonly audio_event_refs: readonly Ref[];
  readonly uncertainty_summary: string;
  readonly missing_evidence_report: string;
}

export interface CognitivePlanContract {
  readonly cognitive_plan_ref: Ref;
  readonly model_response_ref: Ref;
  readonly task_ref: Ref;
  readonly plan_intent_summary: string;
  readonly action_intents: readonly string[];
  readonly waypoint_intents: readonly string[];
  readonly required_preconditions: readonly string[];
  readonly expected_postconditions: readonly string[];
  readonly uncertainty_notes: readonly string[];
  readonly requested_additional_evidence: readonly string[];
  readonly validation_status: ArtifactValidationStatus;
}

export interface ExecutionCommandContract {
  readonly execution_command_ref: Ref;
  readonly validated_plan_ref: Ref;
  readonly primitive_ref: Ref;
  readonly ik_solution_ref?: Ref;
  readonly trajectory_plan_ref: Ref;
  readonly pd_profile_ref: Ref;
  readonly safety_envelope_ref: Ref;
  readonly abort_conditions: readonly string[];
  readonly verification_policy_ref: Ref;
}

export interface ResultRouteContract {
  readonly route_decision_ref: Ref;
  readonly source_artifact_ref: Ref;
  readonly current_state_ref: Ref;
  readonly next_state: ApiRoute | "Execute" | "Verify" | "Correct" | "MemoryUpdate" | "Complete";
  readonly reason_summary: string;
  readonly required_followup_artifacts: readonly Ref[];
  readonly safety_status: "normal" | "restricted" | "unsafe" | "safe_hold" | "human_review";
  readonly audit_refs: readonly Ref[];
  readonly determinism_hash: string;
}

/**
 * Builds an immutable artifact envelope after deterministic validation.
 */
export function buildArtifactEnvelope(input: ArtifactEnvelopeInput): ArtifactEnvelope {
  const envelope = normalizeArtifactEnvelope(input);
  const report = validateArtifactEnvelope(envelope);
  if (!report.ok) {
    throw new ApiContractValidationError("Artifact envelope failed validation.", report.issues);
  }
  return envelope;
}

/**
 * Validates the common File 19 artifact envelope rules.
 */
export function validateArtifactEnvelope(envelope: ArtifactEnvelope): ApiContractValidationReport {
  const issues: ValidationIssue[] = [];
  validateApiRef(envelope.artifact_ref, "$.artifact_ref", issues);
  validateApiRef(envelope.schema_ref, "$.schema_ref", issues);
  validateApiRef(envelope.created_by_component, "$.created_by_component", issues);
  validateApiRef(envelope.provenance_manifest_ref, "$.provenance_manifest_ref", issues);
  validateOptionalApiRef(envelope.task_ref, "$.task_ref", issues);
  validateOptionalApiRef(envelope.episode_ref, "$.episode_ref", issues);
  validateFiniteApiNumber(envelope.created_at_ms, "$.created_at_ms", 0, undefined, issues);
  validateApiRefArray(envelope.parent_artifact_refs, "$.parent_artifact_refs", issues);
  validateApiRefArray(envelope.policy_refs, "$.policy_refs", issues);
  validateApiRefArray(envelope.audit_replay_refs, "$.audit_replay_refs", issues);
  if (envelope.visibility_class === "runtime_cognitive" && (envelope.validation_status === "quarantined" || envelope.validation_status === "rejected")) {
    issues.push(apiIssue("error", "RuntimeCognitiveArtifactInvalid", "$.visibility_class", "Runtime-cognitive artifacts cannot be rejected or quarantined.", "Route rejected artifacts to restricted quarantine."));
  }
  if (envelope.visibility_class === "qa_offline" && envelope.service_of_record !== "qa_scenario") {
    issues.push(apiIssue("warning", "QaVisibilityOwnerReview", "$.service_of_record", "QA-offline visibility should normally be owned by QA scenario service.", "Confirm the service-of-record boundary."));
  }
  return buildApiReport(makeApiRef("artifact_envelope_report", envelope.artifact_ref), issues, routeForIssues(issues));
}

export function buildResultRouteContract(input: Omit<ResultRouteContract, "determinism_hash">): ResultRouteContract {
  const issues: ValidationIssue[] = [];
  validateApiRef(input.route_decision_ref, "$.route_decision_ref", issues);
  validateApiRef(input.source_artifact_ref, "$.source_artifact_ref", issues);
  validateApiRef(input.current_state_ref, "$.current_state_ref", issues);
  validateApiText(input.reason_summary, "$.reason_summary", true, issues);
  validateApiRefArray(input.required_followup_artifacts, "$.required_followup_artifacts", issues);
  validateApiRefArray(input.audit_refs, "$.audit_refs", issues);
  if (issues.some((issue) => issue.severity === "error")) {
    throw new ApiContractValidationError("Result route contract failed validation.", issues);
  }
  const base = {
    ...input,
    reason_summary: compactApiText(input.reason_summary),
    required_followup_artifacts: uniqueApiRefs(input.required_followup_artifacts),
    audit_refs: uniqueApiRefs(input.audit_refs),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export class ApiContractValidationError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "ApiContractValidationError";
    this.issues = freezeApiArray(issues);
  }
}

export function normalizeArtifactEnvelope(input: ArtifactEnvelopeInput): ArtifactEnvelope {
  const base = {
    artifact_ref: input.artifact_ref,
    artifact_type: input.artifact_type,
    schema_ref: input.schema_ref,
    service_of_record: input.service_of_record,
    created_at_ms: input.created_at_ms,
    created_by_component: input.created_by_component,
    task_ref: input.task_ref,
    episode_ref: input.episode_ref,
    parent_artifact_refs: uniqueApiRefs(input.parent_artifact_refs ?? []),
    provenance_manifest_ref: input.provenance_manifest_ref,
    policy_refs: uniqueApiRefs(input.policy_refs ?? []),
    validation_status: input.validation_status ?? "unvalidated",
    visibility_class: input.visibility_class,
    audit_replay_refs: uniqueApiRefs([...(input.audit_replay_refs ?? []), input.provenance_manifest_ref]),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function containsForbiddenApiText(value: string): boolean {
  return FORBIDDEN_API_TEXT_PATTERN.test(value);
}

export function compactApiText(value: string, maxChars = 900): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return containsForbiddenApiText(compact)
    ? compact.replace(FORBIDDEN_API_TEXT_PATTERN, "[redacted_api_boundary_content]").slice(0, maxChars)
    : compact.slice(0, maxChars);
}

export function validateApiText(value: string, path: string, required: boolean, issues: ValidationIssue[]): void {
  if (required && value.trim().length === 0) {
    issues.push(apiIssue("error", "ApiTextRequired", path, "Required API text is empty.", "Provide concise public contract text."));
  }
  if (containsForbiddenApiText(value)) {
    issues.push(apiIssue("error", "ApiTextForbidden", path, "Text contains data forbidden by the service boundary.", "Use prompt-safe embodied, policy, validation, or audit wording."));
  }
}

export function validateApiRef(ref: Ref | undefined, path: string, issues: ValidationIssue[]): void {
  if (ref === undefined || ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(apiIssue("error", "ApiRefInvalid", path, "Reference must be present, non-empty, and whitespace-free.", "Use a stable opaque reference."));
    return;
  }
  if (containsForbiddenApiText(ref)) {
    issues.push(apiIssue("error", "ApiRefForbidden", path, "Reference contains restricted boundary wording.", "Use an opaque ref without hidden runtime details."));
  }
}

export function validateOptionalApiRef(ref: Ref | undefined, path: string, issues: ValidationIssue[]): void {
  if (ref !== undefined) {
    validateApiRef(ref, path, issues);
  }
}

export function validateApiRefArray(refs: readonly Ref[], path: string, issues: ValidationIssue[]): void {
  for (const [index, ref] of refs.entries()) {
    validateApiRef(ref, `${path}[${index}]`, issues);
  }
}

export function validateFiniteApiNumber(value: number, path: string, min: number, max: number | undefined, issues: ValidationIssue[]): void {
  if (!Number.isFinite(value) || value < min || (max !== undefined && value > max)) {
    issues.push(apiIssue("error", "ApiNumberInvalid", path, "Numeric contract value is outside the allowed finite range.", "Clamp or recompute the value before publication."));
  }
}

export function apiIssue(severity: ValidationSeverity, code: string, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

export function buildApiReport(reportRef: Ref, issues: readonly ValidationIssue[], recommendedRoute: ApiRoute): ApiContractValidationReport {
  const frozenIssues = freezeApiArray(issues);
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

export function routeForIssues(issues: readonly ValidationIssue[]): ApiRoute {
  if (issues.some((issue) => issue.severity === "error" && /Forbidden|Violation|Quarantine|Qa/.test(issue.code))) {
    return "Quarantine";
  }
  if (issues.some((issue) => issue.severity === "error")) {
    return "Repair";
  }
  if (issues.length > 0) {
    return "Continue";
  }
  return "Continue";
}

export function makeApiRef(...parts: readonly (string | number | undefined)[]): Ref {
  const normalized = parts
    .filter((part): part is string | number => part !== undefined)
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "api:empty";
}

export function uniqueApiRefs(items: readonly (Ref | undefined)[]): readonly Ref[] {
  return freezeApiArray([...new Set(items.filter((item): item is Ref => item !== undefined && item.trim().length > 0))]);
}

export function uniqueApiStrings(items: readonly string[]): readonly string[] {
  return freezeApiArray([...new Set(items.map((item) => compactApiText(item)).filter((item) => item.length > 0))]);
}

export function freezeApiArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

export const ARTIFACT_ENVELOPE_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: API_ARTIFACT_ENVELOPE_SCHEMA_VERSION,
  blueprint: API_BLUEPRINT_REF,
  sections: freezeApiArray(["19.2", "19.4", "19.7", "19.8", "19.10", "19.11", "19.12"]),
  component: "ArtifactEnvelope",
});
