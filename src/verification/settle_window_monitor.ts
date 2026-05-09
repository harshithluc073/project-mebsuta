/**
 * Settle window monitor for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md`
 * sections 13.5, 13.6.2, 13.9.7, 13.10.4, 13.17, 13.18, and 13.19.
 *
 * The monitor verifies that final object state is stable long enough for a
 * success decision. It combines motion estimates, contact/tactile events, and
 * acoustic cues into deterministic stability evidence.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, Vector3 } from "../simulation/world_manifest";
import {
  freezeArray,
  makeIssue,
  makeRef,
  round6,
  sanitizeRef,
  scaleConfidence,
  validateSafeRef,
  vectorNorm,
  type VerificationPolicy,
} from "./verification_policy_registry";

export const SETTLE_WINDOW_MONITOR_SCHEMA_VERSION = "mebsuta.settle_window_monitor.v1" as const;

export type SettleWindowDecision = "stable" | "stable_with_warnings" | "motion_detected" | "unsafe_contact" | "insufficient_window" | "rejected";
export type SettleWindowAction = "continue_verification" | "extend_window" | "reobserve" | "safe_hold" | "repair_samples";

export interface SettleMotionSample {
  readonly sample_ref: Ref;
  readonly timestamp_ms: number;
  readonly estimated_position_m: Vector3;
  readonly position_sigma_m: number;
  readonly evidence_refs: readonly Ref[];
}

export interface SettleContactEvent {
  readonly event_ref: Ref;
  readonly timestamp_ms: number;
  readonly event_kind: "normal_release" | "slip" | "drop" | "impact" | "high_force" | "unknown_contact";
  readonly severity: "info" | "warning" | "unsafe";
  readonly evidence_refs: readonly Ref[];
}

export interface SettleWindowMonitorRequest {
  readonly request_ref?: Ref;
  readonly policy: VerificationPolicy;
  readonly target_ref: Ref;
  readonly window_start_ms: number;
  readonly window_end_ms: number;
  readonly motion_samples: readonly SettleMotionSample[];
  readonly contact_events?: readonly SettleContactEvent[];
}

export interface SettleWindowReport {
  readonly schema_version: typeof SETTLE_WINDOW_MONITOR_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md";
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly target_ref: Ref;
  readonly decision: SettleWindowDecision;
  readonly recommended_action: SettleWindowAction;
  readonly observed_duration_ms: number;
  readonly maximum_motion_m: number;
  readonly maximum_uncertainty_m: number;
  readonly contact_event_refs: readonly Ref[];
  readonly stability_confidence: number;
  readonly evidence_refs: readonly Ref[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "settle_window_report";
  readonly determinism_hash: string;
}

/**
 * Evaluates final-state stability over a policy-defined settle window.
 */
export class SettleWindowMonitor {
  /**
   * Classifies whether the object remained stable long enough.
   */
  public evaluateSettleWindow(request: SettleWindowMonitorRequest): SettleWindowReport {
    const issues: ValidationIssue[] = [];
    validateRequest(request, issues);
    const ordered = freezeArray([...request.motion_samples].sort((a, b) => a.timestamp_ms - b.timestamp_ms));
    const duration = Math.max(0, request.window_end_ms - request.window_start_ms);
    const maximumMotion = maxMotion(ordered);
    const maximumUncertainty = ordered.reduce((max, sample) => Math.max(max, sample.position_sigma_m), 0);
    const contactEvents = freezeArray([...(request.contact_events ?? [])].sort((a, b) => a.timestamp_ms - b.timestamp_ms));
    const decision = decide(request, duration, maximumMotion, maximumUncertainty, contactEvents, issues);
    const confidence = confidenceFor(request, duration, maximumMotion, maximumUncertainty, contactEvents, issues);
    const evidenceRefs = freezeArray([...ordered.flatMap((sample) => sample.evidence_refs), ...contactEvents.flatMap((event) => event.evidence_refs)].map(sanitizeRef).sort());
    const requestRef = sanitizeRef(request.request_ref ?? makeRef("settle_window", request.target_ref, request.window_start_ms.toString(), request.window_end_ms.toString()));
    const base = {
      schema_version: SETTLE_WINDOW_MONITOR_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/13_VERIFICATION_AND_TASK_SUCCESS_PIPELINE.md" as const,
      report_ref: makeRef("settle_window_report", requestRef, decision),
      request_ref: requestRef,
      target_ref: sanitizeRef(request.target_ref),
      decision,
      recommended_action: recommend(decision),
      observed_duration_ms: duration,
      maximum_motion_m: round6(maximumMotion),
      maximum_uncertainty_m: round6(maximumUncertainty),
      contact_event_refs: freezeArray(contactEvents.map((event) => sanitizeRef(event.event_ref))),
      stability_confidence: confidence,
      evidence_refs: evidenceRefs,
      issues: freezeArray(issues),
      ok: decision === "stable" || decision === "stable_with_warnings",
      cognitive_visibility: "settle_window_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function createSettleWindowMonitor(): SettleWindowMonitor {
  return new SettleWindowMonitor();
}

function validateRequest(request: SettleWindowMonitorRequest, issues: ValidationIssue[]): void {
  validateSafeRef(request.target_ref, "$.target_ref", "HiddenVerificationLeak", issues);
  if (!Number.isFinite(request.window_start_ms) || !Number.isFinite(request.window_end_ms) || request.window_end_ms < request.window_start_ms) {
    issues.push(makeIssue("error", "ToleranceInvalid", "$.window", "Settle window timestamps must be finite and ordered.", "Repair settle timing."));
  }
  if (request.motion_samples.length < 2) {
    issues.push(makeIssue("warning", "ViewPolicyMissing", "$.motion_samples", "At least two motion samples are needed to determine stability.", "Extend the settle window or collect another frame."));
  }
  for (const sample of request.motion_samples) {
    validateSafeRef(sample.sample_ref, "$.motion_samples.sample_ref", "HiddenVerificationLeak", issues);
    for (const ref of sample.evidence_refs) validateSafeRef(ref, "$.motion_samples.evidence_refs", "HiddenVerificationLeak", issues);
    if (!Number.isFinite(sample.timestamp_ms) || sample.position_sigma_m < 0 || !Number.isFinite(sample.position_sigma_m)) {
      issues.push(makeIssue("error", "ToleranceInvalid", "$.motion_samples", "Motion sample timing and uncertainty must be finite.", "Normalize motion samples before settle monitoring."));
    }
  }
  for (const event of request.contact_events ?? []) {
    validateSafeRef(event.event_ref, "$.contact_events.event_ref", "HiddenVerificationLeak", issues);
    for (const ref of event.evidence_refs) validateSafeRef(ref, "$.contact_events.evidence_refs", "HiddenVerificationLeak", issues);
  }
}

function decide(
  request: SettleWindowMonitorRequest,
  durationMs: number,
  maximumMotionM: number,
  maximumUncertaintyM: number,
  events: readonly SettleContactEvent[],
  issues: readonly ValidationIssue[],
): SettleWindowDecision {
  if (issues.some((issue) => issue.severity === "error")) return "rejected";
  if (events.some((event) => event.severity === "unsafe" || event.event_kind === "high_force")) return "unsafe_contact";
  if (durationMs < request.policy.settle_window_duration_ms || request.motion_samples.length < 2) return "insufficient_window";
  if (maximumMotionM > request.policy.tolerance_policy.stability_motion_tolerance_m || events.some((event) => event.event_kind === "slip" || event.event_kind === "drop" || event.event_kind === "impact")) return "motion_detected";
  if (maximumUncertaintyM > request.policy.tolerance_policy.position_tolerance_m * request.policy.tolerance_policy.maximum_uncertainty_ratio || issues.length > 0) return "stable_with_warnings";
  return "stable";
}

function recommend(decision: SettleWindowDecision): SettleWindowAction {
  if (decision === "stable" || decision === "stable_with_warnings") return "continue_verification";
  if (decision === "insufficient_window") return "extend_window";
  if (decision === "unsafe_contact") return "safe_hold";
  if (decision === "motion_detected") return "reobserve";
  return "repair_samples";
}

function maxMotion(samples: readonly SettleMotionSample[]): number {
  if (samples.length < 2) return 0;
  const first = samples[0].estimated_position_m;
  return samples.reduce((max, sample) => {
    const delta: Vector3 = [
      sample.estimated_position_m[0] - first[0],
      sample.estimated_position_m[1] - first[1],
      sample.estimated_position_m[2] - first[2],
    ];
    return Math.max(max, vectorNorm(delta));
  }, 0);
}

function confidenceFor(
  request: SettleWindowMonitorRequest,
  durationMs: number,
  maximumMotionM: number,
  maximumUncertaintyM: number,
  events: readonly SettleContactEvent[],
  issues: readonly ValidationIssue[],
): number {
  const durationScore = Math.min(1, durationMs / Math.max(1, request.policy.settle_window_duration_ms));
  const motionScore = 1 - Math.min(1, maximumMotionM / Math.max(1e-6, request.policy.tolerance_policy.stability_motion_tolerance_m * 2));
  const uncertaintyScore = 1 - Math.min(1, maximumUncertaintyM / Math.max(1e-6, request.policy.tolerance_policy.position_tolerance_m));
  const contactScore = events.some((event) => event.severity === "unsafe") ? 0 : events.some((event) => event.severity === "warning") ? 0.65 : 1;
  const issueScore = issues.some((issue) => issue.severity === "error") ? 0 : issues.length > 0 ? 0.75 : 1;
  return scaleConfidence(durationScore, motionScore, uncertaintyScore, contactScore, issueScore);
}
