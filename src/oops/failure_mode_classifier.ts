/**
 * Failure mode classifier for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/14_OOPS_LOOP_CORRECTION_ENGINE.md`
 * sections 14.4, 14.7, 14.8, 14.15, 14.17, 14.19.3, and 14.22.
 *
 * The classifier maps Oops evidence bundles and residual signals to named
 * physical failure families with correction eligibility and confidence.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  OOPS_BLUEPRINT_REF,
  cleanOopsText,
  freezeOopsArray,
  makeOopsIssue,
  makeOopsRef,
  meanScore,
  uniqueOopsSorted,
  type CorrectionIntentKind,
  type OopsFailureFamily,
} from "./oops_intake_router";
import type { OopsEvidenceBundle } from "./evidence_bundle_builder";

export const FAILURE_MODE_CLASSIFIER_SCHEMA_VERSION = "mebsuta.failure_mode_classifier.v1" as const;

export type FailureModeDecision = "classified" | "classified_with_uncertainty" | "reobserve_required" | "safe_hold_required" | "rejected";
export type FailureCorrectability = "correctable" | "needs_reobserve" | "unsafe" | "human_review";

export interface FailureModeClassifierRequest {
  readonly request_ref?: Ref;
  readonly evidence_bundle: OopsEvidenceBundle;
  readonly primitive_context_ref?: Ref;
  readonly residual_direction_summaries?: readonly string[];
}

export interface FailureModeReport {
  readonly schema_version: typeof FAILURE_MODE_CLASSIFIER_SCHEMA_VERSION;
  readonly blueprint_ref: typeof OOPS_BLUEPRINT_REF;
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly decision: FailureModeDecision;
  readonly primary_failure_mode: OopsFailureFamily;
  readonly secondary_failure_modes: readonly OopsFailureFamily[];
  readonly correctability: FailureCorrectability;
  readonly preferred_correction_intent: CorrectionIntentKind;
  readonly confidence: number;
  readonly evidence_refs: readonly Ref[];
  readonly residual_direction_summaries: readonly string[];
  readonly reasoning_summary: string;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "oops_failure_mode_report";
  readonly determinism_hash: string;
}

/**
 * Classifies evidence-backed Oops failure modes.
 */
export class FailureModeClassifier {
  /**
   * Assigns a primary family and a bounded correction intent.
   */
  public classifyFailureMode(request: FailureModeClassifierRequest): FailureModeReport {
    const issues: ValidationIssue[] = [];
    if (request.evidence_bundle.evidence_strength === "insufficient") {
      issues.push(makeOopsIssue("warning", "EvidenceMissing", "$.evidence_bundle", "Evidence is insufficient for confident failure classification.", "Reobserve before physical correction."));
    }
    const signals = signalText(request);
    const primary = classifyPrimary(signals);
    const secondary = freezeOopsArray(classifySecondary(signals, primary));
    const correctability = correctabilityFor(primary, request.evidence_bundle, issues);
    const intent = intentFor(primary, correctability);
    const confidence = confidenceFor(primary, secondary, request.evidence_bundle);
    const decision = decide(primary, correctability, confidence, issues);
    const requestRef = request.request_ref ?? makeOopsRef("failure_mode", request.evidence_bundle.evidence_bundle_ref);
    const base = {
      schema_version: FAILURE_MODE_CLASSIFIER_SCHEMA_VERSION,
      blueprint_ref: OOPS_BLUEPRINT_REF,
      report_ref: makeOopsRef("failure_mode_report", requestRef, primary, decision),
      request_ref: requestRef,
      decision,
      primary_failure_mode: primary,
      secondary_failure_modes: secondary,
      correctability,
      preferred_correction_intent: intent,
      confidence,
      evidence_refs: uniqueOopsSorted([
        ...request.evidence_bundle.visual_evidence_refs,
        ...request.evidence_bundle.controller_telemetry_refs,
        ...request.evidence_bundle.spatial_residual_report_refs,
        ...request.evidence_bundle.tactile_contact_refs,
        ...request.evidence_bundle.audio_event_refs,
      ]),
      residual_direction_summaries: uniqueOopsSorted((request.residual_direction_summaries ?? request.evidence_bundle.spatial_residual_report_refs).map(cleanOopsText)),
      reasoning_summary: cleanOopsText(`Classified ${primary} with ${correctability} route from embodied evidence bundle ${request.evidence_bundle.evidence_bundle_ref}.`),
      issues: freezeOopsArray(issues),
      ok: decision === "classified" || decision === "classified_with_uncertainty",
      cognitive_visibility: "oops_failure_mode_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function createFailureModeClassifier(): FailureModeClassifier {
  return new FailureModeClassifier();
}

function signalText(request: FailureModeClassifierRequest): string {
  return [
    request.evidence_bundle.evidence_bundle_ref,
    ...request.evidence_bundle.spatial_residual_report_refs,
    ...request.evidence_bundle.controller_telemetry_refs,
    ...request.evidence_bundle.tactile_contact_refs,
    ...request.evidence_bundle.audio_event_refs,
    ...(request.residual_direction_summaries ?? []),
    request.primitive_context_ref ?? "",
  ].join(" ").toLowerCase();
}

function classifyPrimary(signals: string): OopsFailureFamily {
  if (/force|unsafe|collision|impact|high/iu.test(signals)) return "unsafe_contact";
  if (/wrong|identity|distractor/iu.test(signals)) return "wrong_object";
  if (/tool|sweep|aim/iu.test(signals)) return "tool_misalignment";
  if (/inside|container|rim|insert/iu.test(signals)) return "missed_insertion";
  if (/orient|rotate|yaw|pitch|roll/iu.test(signals)) return "rotation_error";
  if (/slip|drop|lost|fell/iu.test(signals)) return "slip_or_drop";
  if (/support|topple|stable|wobble/iu.test(signals)) return "stability_failure";
  if (/view|occlu|sensor|sync|ambiguous/iu.test(signals)) return "sensor_or_view_gap";
  if (/large|far|drift/iu.test(signals)) return "misplacement";
  if (/offset|left|right|forward|back|residual/iu.test(signals)) return "placement_offset";
  return "unknown";
}

function classifySecondary(signals: string, primary: OopsFailureFamily): readonly OopsFailureFamily[] {
  const candidates: OopsFailureFamily[] = [];
  for (const mode of ["placement_offset", "misplacement", "rotation_error", "slip_or_drop", "missed_insertion", "tool_misalignment", "wrong_object", "stability_failure", "sensor_or_view_gap", "unsafe_contact"] as const) {
    if (mode !== primary && signals.includes(mode.split("_")[0])) candidates.push(mode);
  }
  return candidates.slice(0, 3);
}

function correctabilityFor(
  mode: OopsFailureFamily,
  bundle: OopsEvidenceBundle,
  issues: ValidationIssue[],
): FailureCorrectability {
  if (mode === "unsafe_contact") return "unsafe";
  if (mode === "wrong_object" || mode === "unknown") return "human_review";
  if (mode === "sensor_or_view_gap" || bundle.missing_evidence_report !== undefined) return "needs_reobserve";
  if (bundle.evidence_strength === "insufficient") {
    issues.push(makeOopsIssue("warning", "EvidenceMissing", "$.evidence_strength", "Weak evidence constrains correction eligibility.", "Reobserve or use diagnosis-only route."));
    return "needs_reobserve";
  }
  return "correctable";
}

function intentFor(mode: OopsFailureFamily, correctability: FailureCorrectability): CorrectionIntentKind {
  if (correctability === "needs_reobserve") return "reobserve_only";
  if (correctability === "unsafe" || correctability === "human_review") return "human_review";
  if (mode === "placement_offset") return "micro_adjust";
  if (mode === "rotation_error") return "rotate_in_place";
  if (mode === "tool_misalignment") return "re_aim_tool";
  if (mode === "misplacement" || mode === "slip_or_drop") return "regrasp_and_replace";
  if (mode === "missed_insertion" || mode === "stability_failure") return "reposition_body";
  return "human_review";
}

function confidenceFor(primary: OopsFailureFamily, secondary: readonly OopsFailureFamily[], bundle: OopsEvidenceBundle): number {
  const primaryScore = primary === "unknown" ? 0.25 : primary === "sensor_or_view_gap" ? 0.55 : 0.82;
  const ambiguityPenalty = secondary.length > 1 ? 0.7 : 1;
  const strengthScore = bundle.evidence_strength === "strong" ? 1 : bundle.evidence_strength === "moderate" ? 0.78 : bundle.evidence_strength === "weak" ? 0.5 : 0.2;
  return meanScore([primaryScore, ambiguityPenalty, strengthScore, bundle.confidence]);
}

function decide(
  primary: OopsFailureFamily,
  correctability: FailureCorrectability,
  confidence: number,
  issues: readonly ValidationIssue[],
): FailureModeDecision {
  if (issues.some((issue) => issue.severity === "error")) return "rejected";
  if (correctability === "unsafe") return "safe_hold_required";
  if (correctability === "needs_reobserve") return "reobserve_required";
  if (confidence < 0.65 || primary === "unknown" || issues.length > 0) return "classified_with_uncertainty";
  return "classified";
}
