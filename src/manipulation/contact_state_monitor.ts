/**
 * Contact state monitor for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md`
 * sections 12.3, 12.7, 12.8, 12.9, 12.10, 12.11, 12.13, 12.15,
 * 12.16, and 12.17.
 *
 * This monitor turns contact, force, visual, audio, and proprioceptive samples
 * into a deterministic manipulation contact state. It uses hysteresis,
 * force-rate checks, visual corroboration, and finite settle windows so noisy
 * tactile flicker cannot be treated as confirmed grip, support, tool contact,
 * placement contact, slip, drop, or crush risk without corroborating evidence.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type {
  Ref,
  ValidationIssue,
  ValidationSeverity,
} from "../simulation/world_manifest";
import type { ManipulationContactExpectation } from "./manipulation_primitive_catalog";

export const CONTACT_STATE_MONITOR_SCHEMA_VERSION = "mebsuta.contact_state_monitor.v1" as const;

const HIDDEN_CONTACT_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|qa_success|qa_label|qa_only|simulator truth|mesh_name|asset_id|benchmark_truth|oracle_pose|direct_actuator|raw_gemini_actuation)/i;

export type ContactStateDecision = "stable" | "stable_with_warnings" | "ambiguous" | "slip_risk" | "drop_risk" | "crush_risk" | "unexpected_contact" | "sensor_fault";
export type ContactStateRecommendedAction = "continue_monitoring" | "hold_settle" | "reduce_force" | "regrasp_or_correct" | "release_or_safe_hold" | "reobserve_contact" | "repair_contact_inputs";
export type ContactStateIssueCode =
  | "SampleWindowEmpty"
  | "ContactSampleInvalid"
  | "ForceLimitExceeded"
  | "SlipCorroborated"
  | "DropCorroborated"
  | "UnexpectedContact"
  | "VisualCorroborationMissing"
  | "SensorFault"
  | "HiddenContactLeak";

export interface ManipulationContactSample {
  readonly sample_ref: Ref;
  readonly timestamp_s: number;
  readonly contact_site_ref: Ref;
  readonly contact_present: boolean;
  readonly expected_contact: boolean;
  readonly confidence: number;
  readonly force_n?: number;
  readonly slip_probability?: number;
  readonly contact_area_m2?: number;
  readonly evidence_kind: "tactile" | "force" | "proprioceptive" | "tool_tip" | "placement" | "support";
}

export interface ManipulationVisualContactEvidence {
  readonly evidence_ref: Ref;
  readonly timestamp_s: number;
  readonly subject_ref: Ref;
  readonly visible: boolean;
  readonly confidence: number;
  readonly relative_motion_m?: number;
  readonly deformation_score?: number;
  readonly occluded_by_effector?: boolean;
}

export interface ManipulationAudioContactEvidence {
  readonly evidence_ref: Ref;
  readonly timestamp_s: number;
  readonly cue: "impact" | "scrape" | "slip" | "drop" | "none" | "ambiguous";
  readonly confidence: number;
}

export interface ContactStateMonitorPolicy {
  readonly stable_window_s?: number;
  readonly min_contact_confidence?: number;
  readonly max_contact_gap_s?: number;
  readonly slip_probability_threshold?: number;
  readonly visual_motion_slip_m?: number;
  readonly visual_motion_drop_m?: number;
  readonly crush_force_ratio?: number;
}

export interface ContactStateMonitorRequest {
  readonly request_ref?: Ref;
  readonly primitive_ref: Ref;
  readonly expected_contact: ManipulationContactExpectation;
  readonly contact_samples: readonly ManipulationContactSample[];
  readonly visual_evidence?: readonly ManipulationVisualContactEvidence[];
  readonly audio_evidence?: readonly ManipulationAudioContactEvidence[];
  readonly current_time_s: number;
  readonly settle_window_s?: number;
  readonly max_force_n?: number;
  readonly policy?: ContactStateMonitorPolicy;
}

export interface ContactHysteresisSummary {
  readonly contact_window_s: number;
  readonly sample_count: number;
  readonly active_contact_fraction: number;
  readonly expected_contact_fraction: number;
  readonly longest_contact_gap_s: number;
  readonly mean_force_n: number;
  readonly max_force_n: number;
  readonly mean_slip_probability: number;
  readonly stable_contact: boolean;
  readonly force_within_limit: boolean;
}

export interface ContactStateMonitorReport {
  readonly schema_version: typeof CONTACT_STATE_MONITOR_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md";
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly primitive_ref: Ref;
  readonly decision: ContactStateDecision;
  readonly recommended_action: ContactStateRecommendedAction;
  readonly hysteresis: ContactHysteresisSummary;
  readonly corroborating_visual_refs: readonly Ref[];
  readonly corroborating_audio_refs: readonly Ref[];
  readonly contact_site_refs: readonly Ref[];
  readonly evidence_refs: readonly Ref[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "contact_state_monitor_report";
  readonly determinism_hash: string;
}

interface NormalizedContactPolicy {
  readonly stable_window_s: number;
  readonly min_contact_confidence: number;
  readonly max_contact_gap_s: number;
  readonly slip_probability_threshold: number;
  readonly visual_motion_slip_m: number;
  readonly visual_motion_drop_m: number;
  readonly crush_force_ratio: number;
}

/**
 * Evaluates manipulation contact using hysteresis and sensor corroboration.
 */
export class ContactStateMonitor {
  /**
   * Emits one deterministic contact-state report for the current primitive.
   */
  public monitorContactState(request: ContactStateMonitorRequest): ContactStateMonitorReport {
    const issues: ValidationIssue[] = [];
    const requestRef = sanitizeRef(request.request_ref ?? `contact_state_${computeDeterminismHash({
      primitive: request.primitive_ref,
      samples: request.contact_samples.map((sample) => sample.sample_ref),
    })}`);
    const policy = normalizePolicy(request.policy, request.settle_window_s);
    validateRequest(request, policy, issues);
    const samples = freezeArray([...request.contact_samples].sort((a, b) => a.timestamp_s - b.timestamp_s || a.sample_ref.localeCompare(b.sample_ref)));
    const hysteresis = computeHysteresis(samples, request.current_time_s, request.max_force_n, policy);
    const visualRefs = freezeArray((request.visual_evidence ?? [])
      .filter((evidence) => evidence.visible && evidence.confidence >= 0.5)
      .map((evidence) => sanitizeRef(evidence.evidence_ref))
      .sort());
    const audioRefs = freezeArray((request.audio_evidence ?? [])
      .filter((evidence) => evidence.cue !== "none" && evidence.confidence >= 0.45)
      .map((evidence) => sanitizeRef(evidence.evidence_ref))
      .sort());
    const decision = decideContact(request, hysteresis, visualRefs, audioRefs, policy, issues);
    const base = {
      schema_version: CONTACT_STATE_MONITOR_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md" as const,
      report_ref: `contact_state_monitor_report_${computeDeterminismHash({
        requestRef,
        decision,
        hysteresis,
      })}`,
      request_ref: requestRef,
      primitive_ref: sanitizeRef(request.primitive_ref),
      decision,
      recommended_action: recommend(decision, issues),
      hysteresis,
      corroborating_visual_refs: visualRefs,
      corroborating_audio_refs: audioRefs,
      contact_site_refs: freezeArray(uniqueSorted(samples.map((sample) => sanitizeRef(sample.contact_site_ref)))),
      evidence_refs: freezeArray(uniqueSorted([
        ...samples.map((sample) => sanitizeRef(sample.sample_ref)),
        ...visualRefs,
        ...audioRefs,
      ])),
      issues: freezeArray(issues),
      ok: decision === "stable" || decision === "stable_with_warnings",
      cognitive_visibility: "contact_state_monitor_report" as const,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }
}

export function createContactStateMonitor(): ContactStateMonitor {
  return new ContactStateMonitor();
}

function computeHysteresis(
  samples: readonly ManipulationContactSample[],
  currentTimeS: number,
  maxForceN: number | undefined,
  policy: NormalizedContactPolicy,
): ContactHysteresisSummary {
  if (samples.length === 0) {
    return Object.freeze({
      contact_window_s: 0,
      sample_count: 0,
      active_contact_fraction: 0,
      expected_contact_fraction: 0,
      longest_contact_gap_s: 0,
      mean_force_n: 0,
      max_force_n: 0,
      mean_slip_probability: 0,
      stable_contact: false,
      force_within_limit: true,
    });
  }
  const start = Math.max(0, currentTimeS - policy.stable_window_s);
  const windowed = samples.filter((sample) => sample.timestamp_s >= start && sample.timestamp_s <= currentTimeS);
  const considered = windowed.length === 0 ? samples.slice(-Math.min(samples.length, 4)) : windowed;
  const active = considered.filter((sample) => sample.contact_present && sample.confidence >= policy.min_contact_confidence);
  const expected = considered.filter((sample) => sample.expected_contact);
  const forces = considered.map((sample) => sample.force_n ?? 0);
  const slips = considered.map((sample) => sample.slip_probability ?? 0);
  const longestGap = longestContactGap(considered, policy);
  const meanForce = mean(forces);
  const forceMax = Math.max(0, ...forces);
  return Object.freeze({
    contact_window_s: round6(Math.max(0, currentTimeS - considered[0].timestamp_s)),
    sample_count: considered.length,
    active_contact_fraction: round6(active.length / considered.length),
    expected_contact_fraction: round6(expected.length / considered.length),
    longest_contact_gap_s: round6(longestGap),
    mean_force_n: round6(meanForce),
    max_force_n: round6(forceMax),
    mean_slip_probability: round6(mean(slips)),
    stable_contact: active.length / considered.length >= 0.72 && longestGap <= policy.max_contact_gap_s,
    force_within_limit: maxForceN === undefined || forceMax <= maxForceN * policy.crush_force_ratio,
  });
}

function decideContact(
  request: ContactStateMonitorRequest,
  hysteresis: ContactHysteresisSummary,
  visualRefs: readonly Ref[],
  audioRefs: readonly Ref[],
  policy: NormalizedContactPolicy,
  issues: ValidationIssue[],
): ContactStateDecision {
  const requiresContact = request.expected_contact !== "no_contact";
  const visualSlip = (request.visual_evidence ?? []).some((evidence) => (evidence.relative_motion_m ?? 0) >= policy.visual_motion_slip_m && evidence.confidence >= 0.5);
  const visualDrop = (request.visual_evidence ?? []).some((evidence) => (evidence.relative_motion_m ?? 0) >= policy.visual_motion_drop_m && evidence.confidence >= 0.5);
  const audioDrop = (request.audio_evidence ?? []).some((evidence) => evidence.cue === "drop" && evidence.confidence >= 0.55);
  const audioSlip = (request.audio_evidence ?? []).some((evidence) => evidence.cue === "slip" && evidence.confidence >= 0.5);
  if (request.contact_samples.length === 0) {
    issues.push(makeIssue("error", "SampleWindowEmpty", "$.contact_samples", "Contact monitor requires at least one current contact sample.", "Provide tactile, force, placement, support, or tool-tip contact evidence."));
    return "sensor_fault";
  }
  if (!hysteresis.force_within_limit) {
    issues.push(makeIssue("error", "ForceLimitExceeded", "$.contact_samples.force_n", "Contact force exceeds the configured manipulation envelope.", "Reduce force or enter safe hold."));
    return "crush_risk";
  }
  if (requiresContact && (visualDrop || audioDrop) && hysteresis.active_contact_fraction < 0.35) {
    issues.push(makeIssue("error", "DropCorroborated", "$.contact_samples", "Drop risk is corroborated by contact loss and visual or audio evidence.", "Release authority should stop and correction should capture evidence."));
    return "drop_risk";
  }
  if (requiresContact && hysteresis.mean_slip_probability >= policy.slip_probability_threshold && (visualSlip || audioSlip || visualRefs.length > 0)) {
    issues.push(makeIssue("warning", "SlipCorroborated", "$.contact_samples.slip_probability", "Slip risk is corroborated by contact and visual or audio evidence.", "Hold, reduce force, or regrasp with a changed strategy."));
    return "slip_risk";
  }
  if (!requiresContact && hysteresis.active_contact_fraction > 0.2) {
    issues.push(makeIssue("error", "UnexpectedContact", "$.expected_contact", "Contact was observed during a no-contact primitive.", "Stop the primitive and inspect the contact state."));
    return "unexpected_contact";
  }
  if (requiresContact && !hysteresis.stable_contact) {
    if (visualRefs.length === 0) {
      issues.push(makeIssue("warning", "VisualCorroborationMissing", "$.visual_evidence", "Contact state lacks stable tactile hysteresis and visual corroboration.", "Collect an alternate view or hold for the settle window."));
    }
    return "ambiguous";
  }
  return issues.length > 0 ? "stable_with_warnings" : "stable";
}

function validateRequest(request: ContactStateMonitorRequest, policy: NormalizedContactPolicy, issues: ValidationIssue[]): void {
  validateRef(request.primitive_ref, "$.primitive_ref", "HiddenContactLeak", issues);
  if (!Number.isFinite(request.current_time_s) || request.current_time_s < 0) {
    issues.push(makeIssue("error", "ContactSampleInvalid", "$.current_time_s", "Current time must be finite and nonnegative.", "Use monotonic execution time."));
  }
  if (policy.stable_window_s <= 0 || policy.max_contact_gap_s < 0) {
    issues.push(makeIssue("error", "ContactSampleInvalid", "$.policy", "Contact policy windows must be positive.", "Use physically meaningful timing windows."));
  }
  request.contact_samples.forEach((sample, index) => validateSample(sample, index, issues));
  for (const evidence of request.visual_evidence ?? []) validateRef(evidence.evidence_ref, "$.visual_evidence.evidence_ref", "HiddenContactLeak", issues);
  for (const evidence of request.audio_evidence ?? []) validateRef(evidence.evidence_ref, "$.audio_evidence.evidence_ref", "HiddenContactLeak", issues);
}

function validateSample(sample: ManipulationContactSample, index: number, issues: ValidationIssue[]): void {
  validateRef(sample.sample_ref, `$.contact_samples.${index}.sample_ref`, "HiddenContactLeak", issues);
  validateRef(sample.contact_site_ref, `$.contact_samples.${index}.contact_site_ref`, "HiddenContactLeak", issues);
  if (!Number.isFinite(sample.timestamp_s) || sample.timestamp_s < 0) {
    issues.push(makeIssue("error", "ContactSampleInvalid", `$.contact_samples.${index}.timestamp_s`, "Contact sample time must be finite and nonnegative.", "Use monotonic contact timestamps."));
  }
  if (!Number.isFinite(sample.confidence) || sample.confidence < 0 || sample.confidence > 1) {
    issues.push(makeIssue("error", "ContactSampleInvalid", `$.contact_samples.${index}.confidence`, "Contact confidence must be in [0, 1].", "Normalize contact confidence."));
  }
  if (sample.force_n !== undefined && (!Number.isFinite(sample.force_n) || sample.force_n < 0)) {
    issues.push(makeIssue("error", "ContactSampleInvalid", `$.contact_samples.${index}.force_n`, "Force estimates must be finite and nonnegative.", "Use calibrated force estimates."));
  }
}

function longestContactGap(samples: readonly ManipulationContactSample[], policy: NormalizedContactPolicy): number {
  const active = samples
    .filter((sample) => sample.contact_present && sample.confidence >= policy.min_contact_confidence)
    .sort((a, b) => a.timestamp_s - b.timestamp_s);
  if (active.length <= 1) return 0;
  let longest = 0;
  for (let index = 1; index < active.length; index += 1) {
    longest = Math.max(longest, active[index].timestamp_s - active[index - 1].timestamp_s);
  }
  return longest;
}

function recommend(decision: ContactStateDecision, issues: readonly ValidationIssue[]): ContactStateRecommendedAction {
  if (decision === "stable") return "continue_monitoring";
  if (decision === "stable_with_warnings" || decision === "ambiguous") return issues.some((issue) => issue.code === "VisualCorroborationMissing") ? "reobserve_contact" : "hold_settle";
  if (decision === "slip_risk") return "regrasp_or_correct";
  if (decision === "drop_risk" || decision === "unexpected_contact") return "release_or_safe_hold";
  if (decision === "crush_risk") return "reduce_force";
  return "repair_contact_inputs";
}

function normalizePolicy(policy: ContactStateMonitorPolicy | undefined, settleWindowS: number | undefined): NormalizedContactPolicy {
  return Object.freeze({
    stable_window_s: positiveOrDefault(settleWindowS ?? policy?.stable_window_s, 0.32),
    min_contact_confidence: clamp(policy?.min_contact_confidence ?? 0.58, 0, 1),
    max_contact_gap_s: positiveOrDefault(policy?.max_contact_gap_s, 0.18),
    slip_probability_threshold: clamp(policy?.slip_probability_threshold ?? 0.45, 0, 1),
    visual_motion_slip_m: positiveOrDefault(policy?.visual_motion_slip_m, 0.025),
    visual_motion_drop_m: positiveOrDefault(policy?.visual_motion_drop_m, 0.08),
    crush_force_ratio: positiveOrDefault(policy?.crush_force_ratio, 1.05),
  });
}

function validateRef(ref: Ref, path: string, code: ContactStateIssueCode, issues: ValidationIssue[]): void {
  if (ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(makeIssue("error", code, path, "Reference must be a non-empty whitespace-free string.", "Use opaque contact evidence refs."));
    return;
  }
  if (HIDDEN_CONTACT_PATTERN.test(ref)) {
    issues.push(makeIssue("error", "HiddenContactLeak", path, "Reference contains forbidden hidden execution detail.", "Use sensor-derived evidence refs only."));
  }
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sanitizeRef(ref: Ref): Ref {
  return ref.replace(HIDDEN_CONTACT_PATTERN, "hidden-detail").trim();
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value <= 0 ? fallback : value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function uniqueSorted<T extends string>(items: readonly T[]): readonly T[] {
  return freezeArray([...new Set(items)].sort());
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

function makeIssue(
  severity: ValidationSeverity,
  code: ContactStateIssueCode,
  path: string,
  message: string,
  remediation: string,
): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}
