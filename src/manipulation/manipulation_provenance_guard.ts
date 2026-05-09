/**
 * Manipulation provenance guard for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md`
 * sections 12.3, 12.5, 12.13, 12.14, 12.16, and 12.17.
 *
 * This guard enforces the File 12 simulation-blind evidence boundary. It
 * admits only sensor-derived visual, tactile, force, proprioceptive, audio,
 * frame, residual, verifier, and validator evidence refs while rejecting
 * hidden execution handles, raw model actuation authority, and internal QA
 * truth as manipulation evidence.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type {
  Ref,
  ValidationIssue,
  ValidationSeverity,
} from "../simulation/world_manifest";

export const MANIPULATION_PROVENANCE_GUARD_SCHEMA_VERSION = "mebsuta.manipulation_provenance_guard.v1" as const;

const HIDDEN_PROVENANCE_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|qa_success|qa_label|qa_only|simulator truth|mesh_name|asset_id|benchmark_truth|oracle_pose|direct_actuator|raw_gemini_actuation)/i;

export type ManipulationEvidenceKind = "visual" | "contact" | "force" | "proprioception" | "imu" | "audio" | "target_frame" | "tool_frame" | "spatial_residual" | "control_telemetry" | "verification" | "validator";
export type ManipulationEvidenceSource = "sensor_runtime" | "estimator" | "validator" | "control_monitor" | "verification_pipeline" | "memory_advisory" | "model_text" | "internal_truth" | "unknown";
export type ManipulationProvenanceDecision = "admitted" | "admitted_with_warnings" | "quarantined" | "rejected";
export type ManipulationProvenanceAction = "use_evidence" | "use_with_caution" | "collect_sensor_evidence" | "quarantine_evidence" | "repair_provenance";
export type ManipulationProvenanceIssueCode =
  | "EvidenceMissing"
  | "EvidenceSourceRejected"
  | "EvidenceKindRejected"
  | "EvidenceRefInvalid"
  | "EvidenceTextHidden"
  | "EvidenceStale"
  | "MemoryEvidenceAdvisoryOnly";

export interface ManipulationEvidenceProvenanceEntry {
  readonly evidence_ref: Ref;
  readonly evidence_kind: ManipulationEvidenceKind;
  readonly source: ManipulationEvidenceSource;
  readonly produced_by_ref: Ref;
  readonly observed_at_s: number;
  readonly current_time_s: number;
  readonly confidence: number;
  readonly visible_to_cognition: boolean;
  readonly advisory_only?: boolean;
  readonly text_summary?: string;
}

export interface ManipulationProvenanceGuardPolicy {
  readonly max_evidence_age_s?: number;
  readonly min_confidence?: number;
  readonly allow_memory_advisory?: boolean;
  readonly allow_model_text_as_context?: boolean;
}

export interface ManipulationProvenanceGuardRequest {
  readonly request_ref?: Ref;
  readonly consumer_ref: Ref;
  readonly required_kinds: readonly ManipulationEvidenceKind[];
  readonly evidence: readonly ManipulationEvidenceProvenanceEntry[];
  readonly policy?: ManipulationProvenanceGuardPolicy;
}

export interface ManipulationProvenanceGuardReport {
  readonly schema_version: typeof MANIPULATION_PROVENANCE_GUARD_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md";
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly consumer_ref: Ref;
  readonly decision: ManipulationProvenanceDecision;
  readonly recommended_action: ManipulationProvenanceAction;
  readonly admitted_evidence_refs: readonly Ref[];
  readonly advisory_evidence_refs: readonly Ref[];
  readonly quarantined_evidence_refs: readonly Ref[];
  readonly missing_required_kinds: readonly ManipulationEvidenceKind[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "manipulation_provenance_guard_report";
  readonly determinism_hash: string;
}

interface NormalizedProvenancePolicy {
  readonly max_evidence_age_s: number;
  readonly min_confidence: number;
  readonly allow_memory_advisory: boolean;
  readonly allow_model_text_as_context: boolean;
}

/**
 * Validates manipulation evidence provenance before planner or verifier use.
 */
export class ManipulationProvenanceGuard {
  /**
   * Separates admitted evidence from advisory or quarantined evidence.
   */
  public guardManipulationProvenance(request: ManipulationProvenanceGuardRequest): ManipulationProvenanceGuardReport {
    const issues: ValidationIssue[] = [];
    const requestRef = sanitizeRef(request.request_ref ?? `manipulation_provenance_${computeDeterminismHash({
      consumer: request.consumer_ref,
      evidence: request.evidence.map((entry) => entry.evidence_ref),
    })}`);
    const policy = normalizePolicy(request.policy);
    validateRef(request.consumer_ref, "$.consumer_ref", "EvidenceRefInvalid", issues);
    const classified = request.evidence.map((entry, index) => classifyEntry(entry, index, policy, issues));
    const admitted = freezeArray(classified.filter((entry) => entry.classification === "admitted").map((entry) => entry.ref).sort());
    const advisory = freezeArray(classified.filter((entry) => entry.classification === "advisory").map((entry) => entry.ref).sort());
    const quarantined = freezeArray(classified.filter((entry) => entry.classification === "quarantined").map((entry) => entry.ref).sort());
    const admittedKinds = new Set(classified.filter((entry) => entry.classification === "admitted").map((entry) => entry.kind));
    const missingKinds = freezeArray(request.required_kinds.filter((kind) => !admittedKinds.has(kind)).sort());
    if (request.evidence.length === 0) {
      issues.push(makeIssue("error", "EvidenceMissing", "$.evidence", "Manipulation provenance guard requires evidence entries.", "Attach sensor-derived or validator-produced evidence."));
    }
    if (missingKinds.length > 0) {
      issues.push(makeIssue("warning", "EvidenceMissing", "$.required_kinds", `Missing required evidence kinds: ${missingKinds.join(", ")}.`, "Collect the required evidence classes before manipulation success routing."));
    }
    const decision = decide(admitted, advisory, quarantined, missingKinds, issues);
    const base = {
      schema_version: MANIPULATION_PROVENANCE_GUARD_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md" as const,
      report_ref: `manipulation_provenance_guard_report_${computeDeterminismHash({
        requestRef,
        decision,
        admitted,
        quarantined,
      })}`,
      request_ref: requestRef,
      consumer_ref: sanitizeRef(request.consumer_ref),
      decision,
      recommended_action: recommend(decision, missingKinds),
      admitted_evidence_refs: admitted,
      advisory_evidence_refs: advisory,
      quarantined_evidence_refs: quarantined,
      missing_required_kinds: missingKinds,
      issues: freezeArray(issues),
      ok: decision === "admitted" || decision === "admitted_with_warnings",
      cognitive_visibility: "manipulation_provenance_guard_report" as const,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }
}

export function createManipulationProvenanceGuard(): ManipulationProvenanceGuard {
  return new ManipulationProvenanceGuard();
}

function classifyEntry(
  entry: ManipulationEvidenceProvenanceEntry,
  index: number,
  policy: NormalizedProvenancePolicy,
  issues: ValidationIssue[],
): { readonly ref: Ref; readonly kind: ManipulationEvidenceKind; readonly classification: "admitted" | "advisory" | "quarantined" } {
  const localIssuesStart = issues.length;
  validateRef(entry.evidence_ref, `$.evidence.${index}.evidence_ref`, "EvidenceRefInvalid", issues);
  validateRef(entry.produced_by_ref, `$.evidence.${index}.produced_by_ref`, "EvidenceRefInvalid", issues);
  if (!Number.isFinite(entry.observed_at_s) || !Number.isFinite(entry.current_time_s) || entry.observed_at_s < 0 || entry.current_time_s < entry.observed_at_s) {
    issues.push(makeIssue("error", "EvidenceRefInvalid", `$.evidence.${index}.observed_at_s`, "Evidence timestamps must be finite, nonnegative, and ordered.", "Use monotonic evidence times."));
  }
  if (!Number.isFinite(entry.confidence) || entry.confidence < 0 || entry.confidence > 1) {
    issues.push(makeIssue("error", "EvidenceRefInvalid", `$.evidence.${index}.confidence`, "Evidence confidence must be in [0, 1].", "Normalize confidence before provenance evaluation."));
  }
  if (entry.text_summary !== undefined && HIDDEN_PROVENANCE_PATTERN.test(entry.text_summary)) {
    issues.push(makeIssue("error", "EvidenceTextHidden", `$.evidence.${index}.text_summary`, "Evidence text contains forbidden hidden execution detail.", "Use sensor-derived summaries only."));
  }
  const age = entry.current_time_s - entry.observed_at_s;
  if (age > policy.max_evidence_age_s) {
    issues.push(makeIssue("warning", "EvidenceStale", `$.evidence.${index}.observed_at_s`, "Evidence is stale for manipulation use.", "Refresh the sensor evidence or mark it advisory."));
  }
  if (entry.confidence < policy.min_confidence) {
    issues.push(makeIssue("warning", "EvidenceStale", `$.evidence.${index}.confidence`, "Evidence confidence is below manipulation policy.", "Collect stronger evidence before contact-sensitive decisions."));
  }
  if (entry.source === "internal_truth" || entry.source === "unknown") {
    issues.push(makeIssue("error", "EvidenceSourceRejected", `$.evidence.${index}.source`, "Evidence source is not allowed for manipulation authority.", "Use sensor runtime, estimator, validator, control monitor, or verification evidence."));
  }
  if (entry.source === "model_text" && !policy.allow_model_text_as_context) {
    issues.push(makeIssue("error", "EvidenceSourceRejected", `$.evidence.${index}.source`, "Model text is not manipulation evidence authority.", "Use model text only as non-authoritative context if policy permits."));
  }
  if (entry.source === "memory_advisory" || entry.advisory_only === true) {
    issues.push(makeIssue("warning", "MemoryEvidenceAdvisoryOnly", `$.evidence.${index}.source`, "Memory evidence is advisory and cannot authorize manipulation by itself.", "Pair memory evidence with current sensor evidence."));
    return Object.freeze({ ref: sanitizeRef(entry.evidence_ref), kind: entry.evidence_kind, classification: policy.allow_memory_advisory ? "advisory" : "quarantined" as const });
  }
  if (!entry.visible_to_cognition && (entry.evidence_kind === "visual" || entry.evidence_kind === "verification")) {
    issues.push(makeIssue("error", "EvidenceKindRejected", `$.evidence.${index}.visible_to_cognition`, "Cognition-visible manipulation evidence is required for visual or verification use.", "Use a sanitized visual or verification evidence packet."));
  }
  return Object.freeze({
    ref: sanitizeRef(entry.evidence_ref),
    kind: entry.evidence_kind,
    classification: issues.length === localIssuesStart ? "admitted" : issues.slice(localIssuesStart).some((issue) => issue.severity === "error") ? "quarantined" : "advisory",
  });
}

function decide(
  admitted: readonly Ref[],
  advisory: readonly Ref[],
  quarantined: readonly Ref[],
  missingKinds: readonly ManipulationEvidenceKind[],
  issues: readonly ValidationIssue[],
): ManipulationProvenanceDecision {
  if (issues.some((issue) => issue.severity === "error") && admitted.length === 0) return "rejected";
  if (quarantined.length > 0) return admitted.length > 0 ? "quarantined" : "rejected";
  if (admitted.length === 0) return "rejected";
  return advisory.length > 0 || missingKinds.length > 0 || issues.length > 0 ? "admitted_with_warnings" : "admitted";
}

function recommend(
  decision: ManipulationProvenanceDecision,
  missingKinds: readonly ManipulationEvidenceKind[],
): ManipulationProvenanceAction {
  if (decision === "admitted") return "use_evidence";
  if (decision === "admitted_with_warnings") return missingKinds.length > 0 ? "collect_sensor_evidence" : "use_with_caution";
  if (decision === "quarantined") return "quarantine_evidence";
  return "repair_provenance";
}

function normalizePolicy(policy: ManipulationProvenanceGuardPolicy | undefined): NormalizedProvenancePolicy {
  return Object.freeze({
    max_evidence_age_s: positiveOrDefault(policy?.max_evidence_age_s, 0.75),
    min_confidence: clamp(policy?.min_confidence ?? 0.5, 0, 1),
    allow_memory_advisory: policy?.allow_memory_advisory ?? true,
    allow_model_text_as_context: policy?.allow_model_text_as_context ?? false,
  });
}

function validateRef(ref: Ref, path: string, code: ManipulationProvenanceIssueCode, issues: ValidationIssue[]): void {
  if (ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(makeIssue("error", code, path, "Reference must be a non-empty whitespace-free string.", "Use opaque provenance refs."));
    return;
  }
  if (HIDDEN_PROVENANCE_PATTERN.test(ref)) {
    issues.push(makeIssue("error", "EvidenceRefInvalid", path, "Reference contains forbidden hidden execution detail.", "Use sensor-derived evidence refs only."));
  }
}

function sanitizeRef(ref: Ref): Ref {
  return ref.replace(HIDDEN_PROVENANCE_PATTERN, "hidden-detail").trim();
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value <= 0 ? fallback : value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

function makeIssue(
  severity: ValidationSeverity,
  code: ManipulationProvenanceIssueCode,
  path: string,
  message: string,
  remediation: string,
): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}
