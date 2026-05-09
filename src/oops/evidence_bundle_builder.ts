/**
 * Evidence bundle builder for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/14_OOPS_LOOP_CORRECTION_ENGINE.md`
 * sections 14.3, 14.4, 14.7, 14.19.2, 14.20, 14.22, and 14.24.
 *
 * This builder gathers embodied failure evidence for diagnosis: visual refs,
 * controller telemetry, tactile/contact traces, proprioception, audio cues,
 * residual reports, memory context, safety events, missing evidence, and a
 * clean truth-boundary record.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  OOPS_BLUEPRINT_REF,
  cleanOopsRef,
  cleanOopsText,
  freezeOopsArray,
  makeOopsIssue,
  makeOopsRef,
  meanScore,
  uniqueOopsSorted,
  validateOopsRef,
  type OopsEpisode,
  type OopsIssueCode,
  type OopsTrigger,
} from "./oops_intake_router";

export const EVIDENCE_BUNDLE_BUILDER_SCHEMA_VERSION = "mebsuta.evidence_bundle_builder.v1" as const;

export type OopsEvidenceDecision = "bundle_ready" | "bundle_constrained" | "reobserve_required" | "safe_hold_required" | "rejected";
export type OopsEvidenceAction = "diagnose_failure" | "diagnose_with_caution" | "collect_evidence" | "safe_hold" | "repair_evidence";
export type MissingEvidenceKind = "visual_failure_view" | "telemetry_symptom" | "tactile_contact" | "audio_confirmation" | "residual_direction" | "identity_crop" | "safety_state";

export interface OopsEvidenceBundleRequest {
  readonly request_ref?: Ref;
  readonly episode: OopsEpisode;
  readonly trigger: OopsTrigger;
  readonly visual_evidence_refs?: readonly Ref[];
  readonly controller_telemetry_refs?: readonly Ref[];
  readonly tactile_contact_refs?: readonly Ref[];
  readonly proprioception_refs?: readonly Ref[];
  readonly audio_event_refs?: readonly Ref[];
  readonly spatial_residual_report_refs?: readonly Ref[];
  readonly memory_context_refs?: readonly Ref[];
  readonly safety_event_refs?: readonly Ref[];
  readonly evidence_timestamp_ms: number;
}

export interface MissingEvidenceReport {
  readonly missing_report_ref: Ref;
  readonly missing_kinds: readonly MissingEvidenceKind[];
  readonly affected_constraint_refs: readonly Ref[];
  readonly recommended_collection: readonly string[];
}

export interface OopsEvidenceBundle {
  readonly schema_version: typeof EVIDENCE_BUNDLE_BUILDER_SCHEMA_VERSION;
  readonly blueprint_ref: typeof OOPS_BLUEPRINT_REF;
  readonly evidence_bundle_ref: Ref;
  readonly oops_episode_ref: Ref;
  readonly source_trigger_ref: Ref;
  readonly verification_certificate_ref?: Ref;
  readonly visual_evidence_refs: readonly Ref[];
  readonly visual_evidence_summary: string;
  readonly controller_telemetry_refs: readonly Ref[];
  readonly tactile_contact_refs: readonly Ref[];
  readonly proprioception_refs: readonly Ref[];
  readonly audio_event_refs: readonly Ref[];
  readonly spatial_residual_report_refs: readonly Ref[];
  readonly memory_context_refs: readonly Ref[];
  readonly safety_event_refs: readonly Ref[];
  readonly missing_evidence_report?: MissingEvidenceReport;
  readonly truth_boundary_status: "runtime_embodied_only";
  readonly evidence_strength: "strong" | "moderate" | "weak" | "insufficient";
  readonly confidence: number;
  readonly determinism_hash: string;
}

export interface OopsEvidenceBundleBuilderReport {
  readonly schema_version: typeof EVIDENCE_BUNDLE_BUILDER_SCHEMA_VERSION;
  readonly blueprint_ref: typeof OOPS_BLUEPRINT_REF;
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly decision: OopsEvidenceDecision;
  readonly recommended_action: OopsEvidenceAction;
  readonly bundle?: OopsEvidenceBundle;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "oops_evidence_bundle_builder_report";
  readonly determinism_hash: string;
}

/**
 * Builds prompt-safe, embodied Oops failure evidence bundles.
 */
export class EvidenceBundleBuilder {
  /**
   * Combines trigger and sensor references into a diagnosis-ready bundle.
   */
  public buildOopsEvidenceBundle(request: OopsEvidenceBundleRequest): OopsEvidenceBundleBuilderReport {
    const issues: ValidationIssue[] = [];
    validateRequest(request, issues);
    const missing = detectMissingEvidence(request);
    const decision = decide(request, missing, issues);
    const bundle = decision === "rejected" || decision === "safe_hold_required" ? undefined : buildBundle(request, missing);
    const requestRef = cleanOopsRef(request.request_ref ?? makeOopsRef("oops_evidence_request", request.episode.oops_episode_ref));
    const base = {
      schema_version: EVIDENCE_BUNDLE_BUILDER_SCHEMA_VERSION,
      blueprint_ref: OOPS_BLUEPRINT_REF,
      report_ref: makeOopsRef("oops_evidence_report", requestRef, decision),
      request_ref: requestRef,
      decision,
      recommended_action: actionFor(decision),
      bundle,
      issues: freezeOopsArray(issues),
      ok: bundle !== undefined && (decision === "bundle_ready" || decision === "bundle_constrained"),
      cognitive_visibility: "oops_evidence_bundle_builder_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function createEvidenceBundleBuilder(): EvidenceBundleBuilder {
  return new EvidenceBundleBuilder();
}

function validateRequest(request: OopsEvidenceBundleRequest, issues: ValidationIssue[]): void {
  validateOopsRef(request.episode.oops_episode_ref, "$.episode.oops_episode_ref", "HiddenOopsLeak", issues);
  validateOopsRef(request.trigger.trigger_ref, "$.trigger.trigger_ref", "HiddenOopsLeak", issues);
  for (const ref of allRefs(request)) validateOopsRef(ref, "$.evidence_refs", "HiddenOopsLeak", issues);
  if (!Number.isFinite(request.evidence_timestamp_ms) || request.evidence_timestamp_ms < 0) {
    issues.push(makeOopsIssue("error", "SchemaInvalid", "$.evidence_timestamp_ms", "Evidence timestamp must be finite and nonnegative.", "Use monotonic runtime time."));
  }
  if (request.episode.source_trigger_ref !== request.trigger.trigger_ref) {
    issues.push(makeOopsIssue("warning", "TriggerInvalid", "$.trigger", "Evidence trigger does not match the episode source trigger.", "Reconcile the Oops episode before diagnosis."));
  }
}

function detectMissingEvidence(request: OopsEvidenceBundleRequest): readonly MissingEvidenceKind[] {
  const missing: MissingEvidenceKind[] = [];
  if ((request.visual_evidence_refs ?? []).length === 0 && request.trigger.trigger_source !== "control") missing.push("visual_failure_view");
  if (request.trigger.trigger_source === "control" && (request.controller_telemetry_refs ?? []).length === 0) missing.push("telemetry_symptom");
  if ((request.trigger.trigger_class === "correctable_failure" || request.trigger.trigger_source === "manipulation") && (request.spatial_residual_report_refs ?? []).length === 0) missing.push("residual_direction");
  if (request.trigger.affected_object_descriptors.some((descriptor) => descriptor.confidence < 0.55)) missing.push("identity_crop");
  if (request.trigger.trigger_class === "unsafe_failure" && (request.safety_event_refs ?? []).length === 0) missing.push("safety_state");
  if (/slip|drop|contact|grasp/iu.test(request.trigger.affected_constraint_refs.join(":")) && (request.tactile_contact_refs ?? []).length === 0) missing.push("tactile_contact");
  return freezeOopsArray(missing);
}

function decide(request: OopsEvidenceBundleRequest, missing: readonly MissingEvidenceKind[], issues: readonly ValidationIssue[]): OopsEvidenceDecision {
  if (issues.some((issue) => issue.severity === "error")) return "rejected";
  if (request.trigger.trigger_class === "unsafe_failure" && (request.safety_event_refs ?? []).length > 0) return "safe_hold_required";
  if (missing.includes("visual_failure_view") || missing.includes("identity_crop")) return "reobserve_required";
  if (missing.length > 0 || issues.length > 0) return "bundle_constrained";
  return "bundle_ready";
}

function buildBundle(request: OopsEvidenceBundleRequest, missingKinds: readonly MissingEvidenceKind[]): OopsEvidenceBundle {
  const visual = uniqueOopsSorted([...(request.visual_evidence_refs ?? []), ...request.trigger.evidence_ref_candidates.filter((ref) => /view|image|camera|crop|visual/iu.test(ref))].map(cleanOopsRef));
  const telemetry = uniqueOopsSorted([...(request.controller_telemetry_refs ?? []), ...request.trigger.evidence_ref_candidates.filter((ref) => /telemetry|pd|control|residual/iu.test(ref))].map(cleanOopsRef));
  const residuals = uniqueOopsSorted([...(request.spatial_residual_report_refs ?? []), ...request.trigger.verification_handoff?.residual_direction_summaries ?? []].map(cleanOopsRef));
  const missingReport = missingKinds.length === 0 ? undefined : Object.freeze({
    missing_report_ref: makeOopsRef("oops_missing_evidence", request.episode.oops_episode_ref, missingKinds.join(":")),
    missing_kinds: freezeOopsArray(missingKinds),
    affected_constraint_refs: uniqueOopsSorted(request.trigger.affected_constraint_refs.map(cleanOopsRef)),
    recommended_collection: freezeOopsArray(missingKinds.map(collectionFor)),
  });
  const strength = strengthFor(visual.length, telemetry.length, residuals.length, missingKinds.length);
  const confidence = meanScore([visual.length > 0 ? 1 : 0.35, telemetry.length > 0 ? 0.85 : 0.5, residuals.length > 0 ? 0.9 : 0.45, missingKinds.length === 0 ? 1 : 0.55]);
  const bundleRef = makeOopsRef("oops_evidence_bundle", request.episode.oops_episode_ref, request.trigger.trigger_ref);
  const base = {
    schema_version: EVIDENCE_BUNDLE_BUILDER_SCHEMA_VERSION,
    blueprint_ref: OOPS_BLUEPRINT_REF,
    evidence_bundle_ref: bundleRef,
    oops_episode_ref: request.episode.oops_episode_ref,
    source_trigger_ref: request.trigger.trigger_ref,
    verification_certificate_ref: request.trigger.source_certificate?.certificate_ref,
    visual_evidence_refs: visual,
    visual_evidence_summary: cleanOopsText(summaryFor(visual.length, residuals.length, missingKinds)),
    controller_telemetry_refs: telemetry,
    tactile_contact_refs: uniqueOopsSorted((request.tactile_contact_refs ?? []).map(cleanOopsRef)),
    proprioception_refs: uniqueOopsSorted((request.proprioception_refs ?? []).map(cleanOopsRef)),
    audio_event_refs: uniqueOopsSorted((request.audio_event_refs ?? []).map(cleanOopsRef)),
    spatial_residual_report_refs: residuals,
    memory_context_refs: uniqueOopsSorted((request.memory_context_refs ?? []).map(cleanOopsRef)),
    safety_event_refs: uniqueOopsSorted((request.safety_event_refs ?? []).map(cleanOopsRef)),
    missing_evidence_report: missingReport,
    truth_boundary_status: "runtime_embodied_only" as const,
    evidence_strength: strength,
    confidence,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function actionFor(decision: OopsEvidenceDecision): OopsEvidenceAction {
  if (decision === "bundle_ready") return "diagnose_failure";
  if (decision === "bundle_constrained") return "diagnose_with_caution";
  if (decision === "reobserve_required") return "collect_evidence";
  if (decision === "safe_hold_required") return "safe_hold";
  return "repair_evidence";
}

function allRefs(request: OopsEvidenceBundleRequest): readonly Ref[] {
  return [
    ...(request.visual_evidence_refs ?? []),
    ...(request.controller_telemetry_refs ?? []),
    ...(request.tactile_contact_refs ?? []),
    ...(request.proprioception_refs ?? []),
    ...(request.audio_event_refs ?? []),
    ...(request.spatial_residual_report_refs ?? []),
    ...(request.memory_context_refs ?? []),
    ...(request.safety_event_refs ?? []),
  ];
}

function strengthFor(visualCount: number, telemetryCount: number, residualCount: number, missingCount: number): OopsEvidenceBundle["evidence_strength"] {
  if (missingCount > 1) return "insufficient";
  if (visualCount > 0 && residualCount > 0 && telemetryCount > 0) return "strong";
  if (visualCount > 0 && (residualCount > 0 || telemetryCount > 0)) return "moderate";
  return missingCount === 0 ? "weak" : "insufficient";
}

function collectionFor(kind: MissingEvidenceKind): string {
  if (kind === "visual_failure_view") return "collect synchronized view of target and failed relation";
  if (kind === "telemetry_symptom") return "attach controller residual and anomaly telemetry";
  if (kind === "tactile_contact") return "attach contact or tactile summary";
  if (kind === "audio_confirmation") return "attach relevant audio cue";
  if (kind === "residual_direction") return "attach spatial residual direction";
  if (kind === "identity_crop") return "collect distinguishing target crop";
  return "attach safety event summary";
}

function summaryFor(visualCount: number, residualCount: number, missing: readonly MissingEvidenceKind[]): string {
  return `Oops evidence has ${visualCount} visual ref(s), ${residualCount} residual ref(s), and ${missing.length} missing evidence kind(s).`;
}
