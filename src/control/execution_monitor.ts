/**
 * Execution monitor for Project Mebsuta deterministic control.
 *
 * Blueprint: `architecture_docs/11_CONTROL_LAYER_IK_PD_TRAJECTORY_ARCHITECTURE.md`
 * sections 11.7.6, 11.7.7, 11.11, 11.12, 11.15, 11.16, and 11.17.
 *
 * This module consumes File 11 control telemetry plus optional structured
 * contact, IMU, visual, audio, tracking, and actuator-enforcement evidence.
 * It classifies primitive progress and emits compact, deterministic anomaly
 * events for Oops Loop handoff, verification routing, and safe-hold admission.
 * It intentionally exposes only runtime control evidence and opaque evidence
 * references; simulator truth, QA labels, backend handles, and hidden solver
 * detail are rejected before report construction.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type {
  Ref,
  ValidationIssue,
  ValidationSeverity,
} from "../simulation/world_manifest";
import type {
  ActuatorLimitEnforcementReport,
} from "./actuator_limit_enforcer";
import type {
  ControlTelemetryPacket,
  PDActuatorSaturationFlag,
  PDAnomalyEvent,
  PDAnomalySeverity,
  PDAnomalyType,
  PDDeadlineStatus,
  PDImmediateControlAction,
} from "./pd_control_service";

export const EXECUTION_MONITOR_SCHEMA_VERSION = "mebsuta.execution_monitor.v1" as const;

const EPSILON = 1e-9;
const DEFAULT_ERROR_TOLERANCE = 0.015;
const DEFAULT_VELOCITY_TOLERANCE = 0.04;
const DEFAULT_SETTLE_WINDOW_S = 0.25;
const DEFAULT_MAX_SENSOR_AGE_S = 0.35;
const DEFAULT_NEAR_DEADLINE_FRACTION = 0.8;
const DEFAULT_OSCILLATION_MIN_SIGN_CHANGES = 4;
const DEFAULT_OSCILLATION_NON_DECAY_RATIO = 0.75;
const DEFAULT_DIVERGENCE_RATIO = 1.25;
const DEFAULT_STALL_IMPROVEMENT_RATIO = 0.08;
const DEFAULT_OVERSHOOT_MULTIPLIER = 1.5;
const DEFAULT_SATURATION_RATIO = 0.92;
const DEFAULT_SATURATION_MIN_COUNT = 2;
const DEFAULT_SLIP_PROBABILITY = 0.62;
const DEFAULT_TANGENTIAL_FORCE_RATIO = 0.55;
const DEFAULT_RELATIVE_MOTION_M_S = 0.025;
const DEFAULT_CONTACT_FORCE_N = 18;
const DEFAULT_COLLISION_FORCE_N = 45;
const DEFAULT_IMPACT_CONFIDENCE = 0.7;
const DEFAULT_TILT_WARNING_RAD = 0.45;
const DEFAULT_TILT_CRITICAL_RAD = 0.7;
const DEFAULT_ANGULAR_VELOCITY_WARNING_RAD_S = 2.2;
const DEFAULT_TOOL_ERROR_RAD = 0.35;
const HIDDEN_EXECUTION_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|qa_success|qa_label|qa_only|simulator truth|mesh_name|asset_id|benchmark_truth|oracle_pose)/i;

export type ExecutionProgressClassification =
  | "progressing_nominally"
  | "progressing_slowly"
  | "stalled"
  | "diverging"
  | "contact_established"
  | "contact_unexpected"
  | "settled"
  | "ambiguous";

export type ExecutionMonitorDecision =
  | "continue"
  | "continue_cautiously"
  | "complete"
  | "correct"
  | "reobserve"
  | "safe_hold";

export type ExecutionMonitorIssueCode =
  | "TelemetryMissing"
  | "TelemetryInvalid"
  | "TimingInvalid"
  | "TrackingSampleInvalid"
  | "ContactEvidenceInvalid"
  | "ImuEvidenceInvalid"
  | "VisualEvidenceInvalid"
  | "AudioEvidenceInvalid"
  | "RequiredSensorMissing"
  | "SensorEvidenceStale"
  | "SensorConflict"
  | "AnomalyDetected"
  | "HiddenExecutionLeak"
  | "PolicyInvalid";

export type AcousticCueClass = "impact" | "hard_impact" | "collision" | "drop" | "scrape" | "slip" | "ambiguous";

/**
 * Structured joint or end-effector tracking sample used for trend detection.
 * Signed errors allow real overshoot and oscillation detection instead of
 * depending on natural-language telemetry summaries.
 */
export interface ExecutionTrackingSample {
  readonly sample_ref: Ref;
  readonly telemetry_ref?: Ref;
  readonly joint_ref?: Ref;
  readonly end_effector_ref?: Ref;
  readonly timestamp_s: number;
  readonly signed_position_error: number;
  readonly signed_velocity_error?: number;
  readonly end_effector_error_m?: number;
  readonly position_tolerance: number;
  readonly velocity_tolerance?: number;
}

/**
 * Contact or force evidence packet from gripper, hand, mouth, foot, or tool
 * sensors.
 */
export interface ExecutionContactEvidence {
  readonly evidence_ref: Ref;
  readonly timestamp_s: number;
  readonly contact_present: boolean;
  readonly expected_contact: boolean;
  readonly contact_force_n?: number;
  readonly normal_force_n?: number;
  readonly tangential_force_n?: number;
  readonly slip_probability?: number;
  readonly relative_motion_m_s?: number;
  readonly held_object_ref?: Ref;
  readonly tool_ref?: Ref;
  readonly confidence: number;
}

/**
 * IMU stability evidence summarized in body-relative control terms.
 */
export interface ExecutionImuEvidence {
  readonly evidence_ref: Ref;
  readonly timestamp_s: number;
  readonly tilt_rad: number;
  readonly angular_velocity_rad_s: number;
  readonly linear_acceleration_m_s2?: number;
  readonly support_confidence?: number;
  readonly confidence: number;
}

/**
 * Visual status used to disambiguate drops, sensor loss, tool instability, and
 * object-motion anomalies.
 */
export interface ExecutionVisualStatus {
  readonly evidence_ref: Ref;
  readonly timestamp_s: number;
  readonly subject_ref: Ref;
  readonly visible: boolean;
  readonly confidence: number;
  readonly expected_visible?: boolean;
  readonly relative_displacement_m?: number;
  readonly downward_motion_m_s?: number;
  readonly tool_pose_error_rad?: number;
  readonly occlusion_ratio?: number;
}

/**
 * Runtime audio cue, usually from File 16 acoustic embodied reasoning.
 */
export interface ExecutionAudioCue {
  readonly evidence_ref: Ref;
  readonly timestamp_s: number;
  readonly cue_class: AcousticCueClass;
  readonly confidence: number;
  readonly impact_energy?: number;
}

/**
 * Deadline and settle policy supplied by orchestration or the active primitive.
 */
export interface ExecutionDeadlinePolicy {
  readonly primitive_started_at_s: number;
  readonly primitive_timeout_s: number;
  readonly settle_window_s?: number;
  readonly near_deadline_fraction?: number;
  readonly max_sensor_age_s?: number;
}

/**
 * Tunable thresholds for File 11 monitor concepts. Defaults are conservative
 * and are intended for deterministic simulation and QA replay.
 */
export interface ExecutionMonitorPolicy {
  readonly max_sensor_age_s?: number;
  readonly settle_window_s?: number;
  readonly default_position_tolerance?: number;
  readonly default_velocity_tolerance?: number;
  readonly oscillation_min_sign_changes?: number;
  readonly oscillation_non_decay_ratio?: number;
  readonly divergence_ratio?: number;
  readonly stall_improvement_ratio?: number;
  readonly overshoot_error_multiplier?: number;
  readonly saturation_warn_ratio?: number;
  readonly saturation_min_count?: number;
  readonly slip_probability_threshold?: number;
  readonly tangential_force_ratio_threshold?: number;
  readonly relative_motion_threshold_m_s?: number;
  readonly contact_force_warning_n?: number;
  readonly collision_force_n?: number;
  readonly impact_confidence_threshold?: number;
  readonly tilt_warning_rad?: number;
  readonly tilt_critical_rad?: number;
  readonly angular_velocity_warning_rad_s?: number;
  readonly tool_pose_error_rad?: number;
  readonly reject_hidden_identifiers?: boolean;
}

/**
 * File 11 monitor request.
 */
export interface ExecutionMonitorInput {
  readonly request_ref?: Ref;
  readonly telemetry_window: readonly ControlTelemetryPacket[];
  readonly current_time_s: number;
  readonly active_primitive_ref?: Ref;
  readonly tracking_samples?: readonly ExecutionTrackingSample[];
  readonly contact_evidence?: readonly ExecutionContactEvidence[];
  readonly imu_evidence?: readonly ExecutionImuEvidence[];
  readonly visual_status?: readonly ExecutionVisualStatus[];
  readonly audio_cues?: readonly ExecutionAudioCue[];
  readonly actuator_enforcement_report?: ActuatorLimitEnforcementReport;
  readonly deadline_policy?: ExecutionDeadlinePolicy;
  readonly required_sensor_refs?: readonly Ref[];
  readonly policy?: ExecutionMonitorPolicy;
}

/**
 * Trend summary derived from structured tracking samples or telemetry summary
 * fallback values.
 */
export interface ExecutionTrackingTrend {
  readonly sample_count: number;
  readonly latest_abs_error: number;
  readonly earliest_abs_error: number;
  readonly mean_first_half_error: number;
  readonly mean_second_half_error: number;
  readonly error_tolerance: number;
  readonly velocity_tolerance: number;
  readonly sign_change_count: number;
  readonly decreasing: boolean;
  readonly diverging: boolean;
  readonly stalled: boolean;
  readonly overshoot: boolean;
  readonly oscillating: boolean;
  readonly settled: boolean;
}

/**
 * Aggregate execution-monitor report for orchestrator routing and Oops evidence.
 */
export interface ExecutionMonitorReport {
  readonly schema_version: typeof EXECUTION_MONITOR_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/11_CONTROL_LAYER_IK_PD_TRAJECTORY_ARCHITECTURE.md";
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly active_primitive_ref: Ref;
  readonly decision: ExecutionMonitorDecision;
  readonly progress_classification: ExecutionProgressClassification;
  readonly immediate_control_action: PDImmediateControlAction;
  readonly tracking_trend: ExecutionTrackingTrend;
  readonly anomaly_events: readonly PDAnomalyEvent[];
  readonly inherited_anomaly_events: readonly PDAnomalyEvent[];
  readonly telemetry_refs: readonly Ref[];
  readonly sensor_evidence_refs: readonly Ref[];
  readonly actuator_saturation_flags: readonly PDActuatorSaturationFlag[];
  readonly deadline_status: PDDeadlineStatus;
  readonly settle_window_satisfied: boolean;
  readonly safe_hold_required: boolean;
  readonly oops_eligible: boolean;
  readonly human_review_required: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "control_execution_monitor_packet";
  readonly determinism_hash: string;
}

interface NormalizedExecutionPolicy {
  readonly max_sensor_age_s: number;
  readonly settle_window_s: number;
  readonly default_position_tolerance: number;
  readonly default_velocity_tolerance: number;
  readonly oscillation_min_sign_changes: number;
  readonly oscillation_non_decay_ratio: number;
  readonly divergence_ratio: number;
  readonly stall_improvement_ratio: number;
  readonly overshoot_error_multiplier: number;
  readonly saturation_warn_ratio: number;
  readonly saturation_min_count: number;
  readonly slip_probability_threshold: number;
  readonly tangential_force_ratio_threshold: number;
  readonly relative_motion_threshold_m_s: number;
  readonly contact_force_warning_n: number;
  readonly collision_force_n: number;
  readonly impact_confidence_threshold: number;
  readonly tilt_warning_rad: number;
  readonly tilt_critical_rad: number;
  readonly angular_velocity_warning_rad_s: number;
  readonly tool_pose_error_rad: number;
  readonly reject_hidden_identifiers: boolean;
}

interface AnomalyDraft {
  readonly anomaly_type: PDAnomalyType;
  readonly severity: PDAnomalySeverity;
  readonly trigger_signal: string;
  readonly sensor_evidence_refs: readonly Ref[];
  readonly immediate_control_action: PDImmediateControlAction;
  readonly oops_eligible: boolean;
  readonly human_review_required?: boolean;
}

/**
 * Classifies execution progress and creates File 11 anomaly events.
 */
export class ExecutionMonitor {
  /**
   * Evaluates one execution-monitor tick from telemetry and sensor evidence.
   */
  public monitor(input: ExecutionMonitorInput): ExecutionMonitorReport {
    const policy = normalizePolicy(input.policy, input.deadline_policy);
    const issues: ValidationIssue[] = [];
    const sortedTelemetry = sortTelemetry(input.telemetry_window);
    const telemetryRefs = freezeArray(sortedTelemetry.map((packet) => packet.telemetry_ref));
    const latestTelemetry = sortedTelemetry[sortedTelemetry.length - 1];
    const activePrimitiveRef = sanitizeRef(input.active_primitive_ref ?? latestTelemetry?.primitive_ref ?? "unknown_primitive");
    const requestRef = sanitizeRef(input.request_ref ?? `execution_monitor_${activePrimitiveRef}_${Math.round(input.current_time_s * 1_000_000)}`);

    validateInput(input, policy, issues);
    const trackingTrend = computeTrackingTrend(input, sortedTelemetry, policy);
    const saturationFlags = collectSaturationFlags(sortedTelemetry, input.actuator_enforcement_report);
    const inheritedAnomalies = freezeArray(sortedTelemetry.flatMap((packet) => packet.anomaly_candidates));
    const drafts = [
      ...detectTrackingAnomalies(trackingTrend),
      ...detectDeadlineAnomalies(input, sortedTelemetry),
      ...detectSaturationAnomalies(saturationFlags, input.actuator_enforcement_report, policy),
      ...detectContactAnomalies(input.contact_evidence ?? [], input.visual_status ?? [], input.audio_cues ?? [], policy),
      ...detectImuAnomalies(input.imu_evidence ?? [], policy),
      ...detectVisualAnomalies(input.visual_status ?? [], input.contact_evidence ?? [], policy),
      ...detectAudioAnomalies(input.audio_cues ?? [], input.contact_evidence ?? [], policy),
      ...detectSensorLoss(input, policy),
    ];
    const anomalyEvents = materializeAnomalies(drafts, activePrimitiveRef, telemetryRefs, requestRef);
    const allAnomalies = mergeAnomalyEvents(inheritedAnomalies, anomalyEvents);
    const sensorEvidenceRefs = collectSensorEvidenceRefs(input, anomalyEvents);
    const deadlineStatus = deriveDeadlineStatus(input, sortedTelemetry);
    const settleWindowSatisfied = trackingTrend.settled && noBlockingAnomaly(allAnomalies);
    const progressClassification = classifyProgress(input, trackingTrend, allAnomalies, saturationFlags, deadlineStatus, settleWindowSatisfied);
    const immediateControlAction = chooseImmediateAction(progressClassification, allAnomalies);
    const safeHoldRequired = immediateControlAction === "safe_hold" || input.actuator_enforcement_report?.safe_hold_required === true;
    const decision = decideMonitor(progressClassification, immediateControlAction, allAnomalies, settleWindowSatisfied);
    const humanReviewRequired = allAnomalies.some((event) => event.human_review_required === true || event.severity === "critical");
    const base = {
      schema_version: EXECUTION_MONITOR_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/11_CONTROL_LAYER_IK_PD_TRAJECTORY_ARCHITECTURE.md" as const,
      report_ref: `execution_monitor_report_${computeDeterminismHash({
        requestRef,
        telemetryRefs,
        currentTime: round6(input.current_time_s),
        anomalyCount: allAnomalies.length,
      })}`,
      request_ref: requestRef,
      active_primitive_ref: activePrimitiveRef,
      decision,
      progress_classification: progressClassification,
      immediate_control_action: immediateControlAction,
      tracking_trend: trackingTrend,
      anomaly_events: allAnomalies,
      inherited_anomaly_events: inheritedAnomalies,
      telemetry_refs: telemetryRefs,
      sensor_evidence_refs: sensorEvidenceRefs,
      actuator_saturation_flags: saturationFlags,
      deadline_status: deadlineStatus,
      settle_window_satisfied: settleWindowSatisfied,
      safe_hold_required: safeHoldRequired,
      oops_eligible: allAnomalies.some((event) => event.oops_eligible),
      human_review_required: humanReviewRequired,
      issues: freezeArray([
        ...issues,
        ...allAnomalies.map((event) => makeIssue(event.severity === "notice" ? "warning" : event.severity === "critical" ? "error" : event.severity, "AnomalyDetected", "$.anomaly_events", `${event.anomaly_type} detected from ${event.trigger_signal}.`, "Route according to immediate_control_action and preserve supporting telemetry.")),
      ]),
      ok: decision === "continue" || decision === "continue_cautiously" || decision === "complete",
      cognitive_visibility: "control_execution_monitor_packet" as const,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }
}

/**
 * Convenience function for callers that do not need a retained monitor.
 */
export function monitorExecution(input: ExecutionMonitorInput): ExecutionMonitorReport {
  return new ExecutionMonitor().monitor(input);
}

function normalizePolicy(policy: ExecutionMonitorPolicy | undefined, deadline: ExecutionDeadlinePolicy | undefined): NormalizedExecutionPolicy {
  return Object.freeze({
    max_sensor_age_s: positiveOrDefault(policy?.max_sensor_age_s ?? deadline?.max_sensor_age_s, DEFAULT_MAX_SENSOR_AGE_S),
    settle_window_s: positiveOrDefault(policy?.settle_window_s ?? deadline?.settle_window_s, DEFAULT_SETTLE_WINDOW_S),
    default_position_tolerance: positiveOrDefault(policy?.default_position_tolerance, DEFAULT_ERROR_TOLERANCE),
    default_velocity_tolerance: positiveOrDefault(policy?.default_velocity_tolerance, DEFAULT_VELOCITY_TOLERANCE),
    oscillation_min_sign_changes: integerOrDefault(policy?.oscillation_min_sign_changes, DEFAULT_OSCILLATION_MIN_SIGN_CHANGES),
    oscillation_non_decay_ratio: positiveOrDefault(policy?.oscillation_non_decay_ratio, DEFAULT_OSCILLATION_NON_DECAY_RATIO),
    divergence_ratio: positiveOrDefault(policy?.divergence_ratio, DEFAULT_DIVERGENCE_RATIO),
    stall_improvement_ratio: positiveOrDefault(policy?.stall_improvement_ratio, DEFAULT_STALL_IMPROVEMENT_RATIO),
    overshoot_error_multiplier: positiveOrDefault(policy?.overshoot_error_multiplier, DEFAULT_OVERSHOOT_MULTIPLIER),
    saturation_warn_ratio: positiveOrDefault(policy?.saturation_warn_ratio, DEFAULT_SATURATION_RATIO),
    saturation_min_count: integerOrDefault(policy?.saturation_min_count, DEFAULT_SATURATION_MIN_COUNT),
    slip_probability_threshold: boundedOrDefault(policy?.slip_probability_threshold, DEFAULT_SLIP_PROBABILITY),
    tangential_force_ratio_threshold: positiveOrDefault(policy?.tangential_force_ratio_threshold, DEFAULT_TANGENTIAL_FORCE_RATIO),
    relative_motion_threshold_m_s: positiveOrDefault(policy?.relative_motion_threshold_m_s, DEFAULT_RELATIVE_MOTION_M_S),
    contact_force_warning_n: positiveOrDefault(policy?.contact_force_warning_n, DEFAULT_CONTACT_FORCE_N),
    collision_force_n: positiveOrDefault(policy?.collision_force_n, DEFAULT_COLLISION_FORCE_N),
    impact_confidence_threshold: boundedOrDefault(policy?.impact_confidence_threshold, DEFAULT_IMPACT_CONFIDENCE),
    tilt_warning_rad: positiveOrDefault(policy?.tilt_warning_rad, DEFAULT_TILT_WARNING_RAD),
    tilt_critical_rad: positiveOrDefault(policy?.tilt_critical_rad, DEFAULT_TILT_CRITICAL_RAD),
    angular_velocity_warning_rad_s: positiveOrDefault(policy?.angular_velocity_warning_rad_s, DEFAULT_ANGULAR_VELOCITY_WARNING_RAD_S),
    tool_pose_error_rad: positiveOrDefault(policy?.tool_pose_error_rad, DEFAULT_TOOL_ERROR_RAD),
    reject_hidden_identifiers: policy?.reject_hidden_identifiers ?? true,
  });
}

function validateInput(input: ExecutionMonitorInput, policy: NormalizedExecutionPolicy, issues: ValidationIssue[]): void {
  validateFinite(input.current_time_s, issues, "$.current_time_s", "TimingInvalid");
  if (input.telemetry_window.length === 0) {
    issues.push(makeIssue("error", "TelemetryMissing", "$.telemetry_window", "ExecutionMonitor requires at least one control telemetry packet.", "Provide ControlTelemetryPacket output from PDControlService."));
  }
  for (const packet of input.telemetry_window) {
    validateRef(packet.telemetry_ref, issues, "$.telemetry_window.telemetry_ref", "TelemetryInvalid", policy.reject_hidden_identifiers);
    validateRef(packet.primitive_ref, issues, "$.telemetry_window.primitive_ref", "TelemetryInvalid", policy.reject_hidden_identifiers);
    validateFinite(packet.timestamp_interval.start_s, issues, "$.telemetry_window.timestamp_interval.start_s", "TimingInvalid");
    validateFinite(packet.timestamp_interval.end_s, issues, "$.telemetry_window.timestamp_interval.end_s", "TimingInvalid");
    if (packet.timestamp_interval.end_s < packet.timestamp_interval.start_s - EPSILON) {
      issues.push(makeIssue("error", "TelemetryInvalid", "$.telemetry_window.timestamp_interval", "Telemetry interval end must not precede start.", "Emit ordered telemetry windows."));
    }
  }
  for (const sample of input.tracking_samples ?? []) {
    validateRef(sample.sample_ref, issues, "$.tracking_samples.sample_ref", "TrackingSampleInvalid", policy.reject_hidden_identifiers);
    validateFinite(sample.timestamp_s, issues, "$.tracking_samples.timestamp_s", "TrackingSampleInvalid");
    validateFinite(sample.signed_position_error, issues, "$.tracking_samples.signed_position_error", "TrackingSampleInvalid");
    validatePositive(sample.position_tolerance, issues, "$.tracking_samples.position_tolerance", "TrackingSampleInvalid");
  }
  for (const evidence of input.contact_evidence ?? []) {
    validateEvidenceRefAndTime(evidence.evidence_ref, evidence.timestamp_s, input.current_time_s, policy, issues, "$.contact_evidence", "ContactEvidenceInvalid");
    validateConfidence(evidence.confidence, issues, "$.contact_evidence.confidence", "ContactEvidenceInvalid");
  }
  for (const evidence of input.imu_evidence ?? []) {
    validateEvidenceRefAndTime(evidence.evidence_ref, evidence.timestamp_s, input.current_time_s, policy, issues, "$.imu_evidence", "ImuEvidenceInvalid");
    validateFinite(evidence.tilt_rad, issues, "$.imu_evidence.tilt_rad", "ImuEvidenceInvalid");
    validateFinite(evidence.angular_velocity_rad_s, issues, "$.imu_evidence.angular_velocity_rad_s", "ImuEvidenceInvalid");
    validateConfidence(evidence.confidence, issues, "$.imu_evidence.confidence", "ImuEvidenceInvalid");
  }
  for (const status of input.visual_status ?? []) {
    validateEvidenceRefAndTime(status.evidence_ref, status.timestamp_s, input.current_time_s, policy, issues, "$.visual_status", "VisualEvidenceInvalid");
    validateRef(status.subject_ref, issues, "$.visual_status.subject_ref", "VisualEvidenceInvalid", policy.reject_hidden_identifiers);
    validateConfidence(status.confidence, issues, "$.visual_status.confidence", "VisualEvidenceInvalid");
  }
  for (const cue of input.audio_cues ?? []) {
    validateEvidenceRefAndTime(cue.evidence_ref, cue.timestamp_s, input.current_time_s, policy, issues, "$.audio_cues", "AudioEvidenceInvalid");
    validateConfidence(cue.confidence, issues, "$.audio_cues.confidence", "AudioEvidenceInvalid");
  }
}

function computeTrackingTrend(
  input: ExecutionMonitorInput,
  telemetry: readonly ControlTelemetryPacket[],
  policy: NormalizedExecutionPolicy,
): ExecutionTrackingTrend {
  const samples = input.tracking_samples !== undefined && input.tracking_samples.length > 0
    ? [...input.tracking_samples].sort((a, b) => a.timestamp_s - b.timestamp_s)
    : samplesFromTelemetrySummaries(telemetry, policy);
  if (samples.length === 0) {
    return freezeTrend({
      sample_count: 0,
      latest_abs_error: 0,
      earliest_abs_error: 0,
      mean_first_half_error: 0,
      mean_second_half_error: 0,
      error_tolerance: policy.default_position_tolerance,
      velocity_tolerance: policy.default_velocity_tolerance,
      sign_change_count: 0,
      decreasing: false,
      diverging: false,
      stalled: false,
      overshoot: false,
      oscillating: false,
      settled: false,
    });
  }

  const absErrors = samples.map((sample) => Math.abs(sample.signed_position_error));
  const latest = samples[samples.length - 1];
  const earliestAbs = absErrors[0];
  const latestAbs = absErrors[absErrors.length - 1];
  const split = Math.max(1, Math.floor(absErrors.length / 2));
  const firstMean = mean(absErrors.slice(0, split));
  const secondMean = mean(absErrors.slice(split));
  const signChanges = countSignChanges(samples.map((sample) => sample.signed_position_error));
  const tolerance = positiveOrDefault(latest.position_tolerance, policy.default_position_tolerance);
  const velocityTolerance = positiveOrDefault(latest.velocity_tolerance, policy.default_velocity_tolerance);
  const latestVelocityAbs = latest.signed_velocity_error === undefined ? 0 : Math.abs(latest.signed_velocity_error);
  const decreasing = secondMean < firstMean - tolerance * 0.1;
  const diverging = samples.length >= 2 && latestAbs > Math.max(tolerance, earliestAbs) * policy.divergence_ratio;
  const improvement = firstMean <= EPSILON ? 0 : (firstMean - secondMean) / firstMean;
  const stalled = samples.length >= 3 && latestAbs > tolerance && improvement < policy.stall_improvement_ratio && !diverging;
  const overshoot = samples.length >= 2 && crossedZero(samples.map((sample) => sample.signed_position_error)) && latestAbs > tolerance * policy.overshoot_error_multiplier;
  const oscillating = signChanges >= policy.oscillation_min_sign_changes && latestAbs >= Math.max(tolerance, earliestAbs * policy.oscillation_non_decay_ratio);
  const windowStart = latest.timestamp_s - policy.settle_window_s;
  const settleSamples = samples.filter((sample) => sample.timestamp_s >= windowStart);
  const settled = settleSamples.length > 0
    && settleSamples.every((sample) => Math.abs(sample.signed_position_error) <= positiveOrDefault(sample.position_tolerance, tolerance) + EPSILON)
    && settleSamples.every((sample) => sample.signed_velocity_error === undefined || Math.abs(sample.signed_velocity_error) <= positiveOrDefault(sample.velocity_tolerance, velocityTolerance) + EPSILON)
    && latestVelocityAbs <= velocityTolerance + EPSILON;

  return freezeTrend({
    sample_count: samples.length,
    latest_abs_error: round6(latestAbs),
    earliest_abs_error: round6(earliestAbs),
    mean_first_half_error: round6(firstMean),
    mean_second_half_error: round6(secondMean),
    error_tolerance: round6(tolerance),
    velocity_tolerance: round6(velocityTolerance),
    sign_change_count: signChanges,
    decreasing,
    diverging,
    stalled,
    overshoot,
    oscillating,
    settled,
  });
}

function detectTrackingAnomalies(trend: ExecutionTrackingTrend): readonly AnomalyDraft[] {
  const drafts: AnomalyDraft[] = [];
  if (trend.overshoot) {
    drafts.push(draft("overshoot", "warning", `tracking error crossed target and remains ${formatNumber(trend.latest_abs_error)} above tolerance ${formatNumber(trend.error_tolerance)}`, [], "slow", true));
  }
  if (trend.oscillating) {
    drafts.push(draft("oscillation", trend.latest_abs_error > trend.error_tolerance * 3 ? "error" : "warning", `tracking error sign changed ${trend.sign_change_count} times without decay`, [], trend.latest_abs_error > trend.error_tolerance * 3 ? "safe_hold" : "pause", true, trend.latest_abs_error > trend.error_tolerance * 4));
  }
  if (trend.diverging) {
    drafts.push(draft("instability", "error", `tracking error diverged from ${formatNumber(trend.earliest_abs_error)} to ${formatNumber(trend.latest_abs_error)}`, [], "safe_hold", true));
  }
  return freezeArray(drafts);
}

function detectDeadlineAnomalies(input: ExecutionMonitorInput, telemetry: readonly ControlTelemetryPacket[]): readonly AnomalyDraft[] {
  const status = deriveDeadlineStatus(input, telemetry);
  if (status === "timed_out") {
    return freezeArray([draft("timeout", "error", "primitive deadline timed out before execution settled", [], "pause", true)]);
  }
  return freezeArray([]);
}

function detectSaturationAnomalies(
  flags: readonly PDActuatorSaturationFlag[],
  enforcement: ActuatorLimitEnforcementReport | undefined,
  policy: NormalizedExecutionPolicy,
): readonly AnomalyDraft[] {
  const activeFlags = flags.filter((flag) => flag.action !== "none" || flag.ratio >= policy.saturation_warn_ratio);
  if (activeFlags.length < policy.saturation_min_count && enforcement?.safe_hold_required !== true) {
    return freezeArray([]);
  }
  const safeHold = enforcement?.safe_hold_required === true || activeFlags.some((flag) => flag.action === "safe_hold_required" || flag.action === "rejected");
  const refs = activeFlags.map((flag) => `actuator_${flag.actuator_ref}`);
  return freezeArray([draft("saturation", safeHold ? "error" : "warning", `${activeFlags.length} actuator saturation flags active`, refs, safeHold ? "safe_hold" : "slow", true)]);
}

function detectContactAnomalies(
  contacts: readonly ExecutionContactEvidence[],
  visuals: readonly ExecutionVisualStatus[],
  audio: readonly ExecutionAudioCue[],
  policy: NormalizedExecutionPolicy,
): readonly AnomalyDraft[] {
  const drafts: AnomalyDraft[] = [];
  const latestContacts = latestByRef(contacts, (item) => item.held_object_ref ?? item.tool_ref ?? item.evidence_ref);
  for (const contact of latestContacts) {
    const refs = [contact.evidence_ref];
    const normal = Math.max(Math.abs(contact.normal_force_n ?? contact.contact_force_n ?? 0), EPSILON);
    const tangential = Math.abs(contact.tangential_force_n ?? 0);
    const tangentialRatio = tangential / normal;
    const relativeMotion = Math.abs(contact.relative_motion_m_s ?? 0);
    const slipByProbability = (contact.slip_probability ?? 0) >= policy.slip_probability_threshold;
    const slipByForce = contact.contact_present && tangentialRatio >= policy.tangential_force_ratio_threshold && relativeMotion >= policy.relative_motion_threshold_m_s;
    if (contact.expected_contact && contact.contact_present && contact.confidence > 0.4 && (slipByProbability || slipByForce)) {
      drafts.push(draft("slip", "warning", `contact slip evidence ratio=${formatNumber(tangentialRatio)} relative_motion=${formatNumber(relativeMotion)}`, refs, "pause", true));
    }
    if (!contact.expected_contact && contact.contact_present && (contact.contact_force_n ?? 0) >= policy.contact_force_warning_n) {
      drafts.push(draft("collision", (contact.contact_force_n ?? 0) >= policy.collision_force_n ? "error" : "warning", `unexpected contact force ${formatNumber(contact.contact_force_n ?? 0)} N`, refs, (contact.contact_force_n ?? 0) >= policy.collision_force_n ? "safe_hold" : "pause", true));
    }
    if (contact.expected_contact && !contact.contact_present && contact.held_object_ref !== undefined) {
      const visualDrop = visuals.some((status) => status.subject_ref === contact.held_object_ref && ((status.visible === false && status.expected_visible !== false) || (status.downward_motion_m_s ?? 0) > policy.relative_motion_threshold_m_s));
      const impact = audio.some((cue) => (cue.cue_class === "drop" || cue.cue_class === "impact" || cue.cue_class === "hard_impact") && cue.confidence >= policy.impact_confidence_threshold);
      if (visualDrop || impact) {
        drafts.push(draft("drop", "error", `held object ${contact.held_object_ref} lost contact with supporting drop evidence`, [...refs, ...visuals.map((status) => status.evidence_ref), ...audio.map((cue) => cue.evidence_ref)], "safe_hold", true));
      }
    }
    if (contact.tool_ref !== undefined && contact.contact_present && relativeMotion >= policy.relative_motion_threshold_m_s * 2) {
      drafts.push(draft("tool_instability", "warning", `tool ${contact.tool_ref} contact moved ${formatNumber(relativeMotion)} m/s relative to grasp`, refs, "pause", true));
    }
  }
  return freezeArray(drafts);
}

function detectImuAnomalies(imus: readonly ExecutionImuEvidence[], policy: NormalizedExecutionPolicy): readonly AnomalyDraft[] {
  const latestImu = latestByRef(imus, (item) => item.evidence_ref);
  const drafts: AnomalyDraft[] = [];
  for (const imu of latestImu) {
    const tilt = Math.abs(imu.tilt_rad);
    const angularVelocity = Math.abs(imu.angular_velocity_rad_s);
    if (tilt >= policy.tilt_critical_rad || angularVelocity >= policy.angular_velocity_warning_rad_s * 1.5) {
      drafts.push(draft("instability", "critical", `IMU tilt ${formatNumber(tilt)} rad or angular velocity ${formatNumber(angularVelocity)} rad/s is critical`, [imu.evidence_ref], "safe_hold", true, true));
    } else if (tilt >= policy.tilt_warning_rad || angularVelocity >= policy.angular_velocity_warning_rad_s) {
      drafts.push(draft("instability", "warning", `IMU stability margin is low: tilt=${formatNumber(tilt)} angular_velocity=${formatNumber(angularVelocity)}`, [imu.evidence_ref], "stabilize", true));
    }
  }
  return freezeArray(drafts);
}

function detectVisualAnomalies(
  visuals: readonly ExecutionVisualStatus[],
  contacts: readonly ExecutionContactEvidence[],
  policy: NormalizedExecutionPolicy,
): readonly AnomalyDraft[] {
  const drafts: AnomalyDraft[] = [];
  for (const status of latestByRef(visuals, (item) => item.subject_ref)) {
    if (status.expected_visible !== false && !status.visible && status.confidence >= 0.4) {
      const relatedHeldObject = contacts.some((contact) => contact.held_object_ref === status.subject_ref && contact.expected_contact);
      drafts.push(draft(relatedHeldObject ? "drop" : "sensor_loss", relatedHeldObject ? "error" : "warning", `visual status lost expected subject ${status.subject_ref}`, [status.evidence_ref], relatedHeldObject ? "safe_hold" : "pause", true));
    }
    if ((status.tool_pose_error_rad ?? 0) >= policy.tool_pose_error_rad) {
      drafts.push(draft("tool_instability", "warning", `tool pose error ${formatNumber(status.tool_pose_error_rad ?? 0)} rad exceeds monitor threshold`, [status.evidence_ref], "pause", true));
    }
  }
  return freezeArray(drafts);
}

function detectAudioAnomalies(
  cues: readonly ExecutionAudioCue[],
  contacts: readonly ExecutionContactEvidence[],
  policy: NormalizedExecutionPolicy,
): readonly AnomalyDraft[] {
  const drafts: AnomalyDraft[] = [];
  for (const cue of cues.filter((item) => item.confidence >= policy.impact_confidence_threshold)) {
    if (cue.cue_class === "collision" || cue.cue_class === "hard_impact") {
      drafts.push(draft("collision", "warning", `audio ${cue.cue_class} cue indicates impact during control`, [cue.evidence_ref], "pause", true));
    }
    if (cue.cue_class === "drop" || (cue.cue_class === "impact" && contacts.some((contact) => contact.expected_contact && !contact.contact_present))) {
      drafts.push(draft("drop", "error", "audio impact cue supports drop during held-object control", [cue.evidence_ref], "safe_hold", true));
    }
    if (cue.cue_class === "slip" || cue.cue_class === "scrape") {
      drafts.push(draft("slip", "warning", `audio ${cue.cue_class} cue supports contact instability`, [cue.evidence_ref], "pause", true));
    }
  }
  return freezeArray(drafts);
}

function detectSensorLoss(input: ExecutionMonitorInput, policy: NormalizedExecutionPolicy): readonly AnomalyDraft[] {
  const required = input.required_sensor_refs ?? [];
  if (required.length === 0) {
    return freezeArray([]);
  }
  const currentRefs = new Set(collectAllSensorEvidenceRefs(input));
  const missing = required.filter((ref) => !currentRefs.has(ref));
  if (missing.length === 0) {
    return freezeArray([]);
  }
  return freezeArray([draft("sensor_loss", missing.length === required.length ? "error" : "warning", `required sensor evidence missing: ${missing.join(",")}`, missing, missing.length === required.length ? "safe_hold" : "pause", true, missing.length === required.length)]);
}

function classifyProgress(
  input: ExecutionMonitorInput,
  trend: ExecutionTrackingTrend,
  anomalies: readonly PDAnomalyEvent[],
  saturationFlags: readonly PDActuatorSaturationFlag[],
  deadlineStatus: PDDeadlineStatus,
  settled: boolean,
): ExecutionProgressClassification {
  if (anomalies.some((event) => event.anomaly_type === "collision")) {
    return "contact_unexpected";
  }
  if (anomalies.some((event) => event.anomaly_type === "sensor_loss") && anomalies.some((event) => event.anomaly_type === "slip" || event.anomaly_type === "drop")) {
    return "ambiguous";
  }
  if (anomalies.some((event) => event.severity === "critical" || event.immediate_control_action === "safe_hold" || event.anomaly_type === "oscillation" || event.anomaly_type === "instability")) {
    return "diverging";
  }
  if (settled) {
    return "settled";
  }
  if ((input.contact_evidence ?? []).some((contact) => contact.expected_contact && contact.contact_present && contact.confidence > 0.5)) {
    return "contact_established";
  }
  if (trend.diverging) {
    return "diverging";
  }
  if (trend.stalled) {
    return "stalled";
  }
  if (deadlineStatus === "nearing_timeout" || saturationFlags.some((flag) => flag.action !== "none") || anomalies.length > 0) {
    return "progressing_slowly";
  }
  return trend.decreasing || trend.sample_count === 0 ? "progressing_nominally" : "stalled";
}

function chooseImmediateAction(classification: ExecutionProgressClassification, anomalies: readonly PDAnomalyEvent[]): PDImmediateControlAction {
  if (anomalies.some((event) => event.immediate_control_action === "safe_hold" || event.severity === "critical")) {
    return "safe_hold";
  }
  if (anomalies.some((event) => event.immediate_control_action === "release")) {
    return "release";
  }
  if (classification === "diverging" || classification === "contact_unexpected") {
    return "pause";
  }
  if (classification === "stalled" || classification === "ambiguous") {
    return "pause";
  }
  if (classification === "progressing_slowly") {
    return "slow";
  }
  if (classification === "settled") {
    return "continue";
  }
  if (classification === "contact_established") {
    return "stabilize";
  }
  return "continue";
}

function decideMonitor(
  classification: ExecutionProgressClassification,
  action: PDImmediateControlAction,
  anomalies: readonly PDAnomalyEvent[],
  settled: boolean,
): ExecutionMonitorDecision {
  if (action === "safe_hold") {
    return "safe_hold";
  }
  if (settled && noBlockingAnomaly(anomalies)) {
    return "complete";
  }
  if (classification === "ambiguous" || anomalies.some((event) => event.anomaly_type === "sensor_loss")) {
    return "reobserve";
  }
  if (action === "pause" || anomalies.some((event) => event.oops_eligible && event.severity !== "notice")) {
    return "correct";
  }
  if (action === "slow" || action === "stabilize") {
    return "continue_cautiously";
  }
  return "continue";
}

function deriveDeadlineStatus(input: ExecutionMonitorInput, telemetry: readonly ControlTelemetryPacket[]): PDDeadlineStatus {
  if (telemetry.some((packet) => packet.deadline_status === "timed_out")) {
    return "timed_out";
  }
  if (telemetry.some((packet) => packet.deadline_status === "nearing_timeout")) {
    return "nearing_timeout";
  }
  const deadline = input.deadline_policy;
  if (deadline === undefined) {
    return "on_time";
  }
  const elapsed = Math.max(0, input.current_time_s - deadline.primitive_started_at_s);
  if (elapsed >= deadline.primitive_timeout_s - EPSILON) {
    return "timed_out";
  }
  const nearFraction = deadline.near_deadline_fraction ?? DEFAULT_NEAR_DEADLINE_FRACTION;
  return elapsed >= deadline.primitive_timeout_s * nearFraction ? "nearing_timeout" : "on_time";
}

function materializeAnomalies(
  drafts: readonly AnomalyDraft[],
  primitiveRef: Ref,
  telemetryRefs: readonly Ref[],
  requestRef: Ref,
): readonly PDAnomalyEvent[] {
  const unique = new Map<string, AnomalyDraft>();
  for (const item of drafts) {
    const key = `${item.anomaly_type}|${item.severity}|${item.immediate_control_action}|${item.trigger_signal}`;
    if (!unique.has(key)) {
      unique.set(key, item);
    }
  }
  const events = [...unique.values()].map((item, index) => {
    const eventRef = `execution_anomaly_${computeDeterminismHash({ requestRef, index, item, primitiveRef, telemetryRefs })}`;
    const base = {
      anomaly_ref: eventRef,
      anomaly_type: item.anomaly_type,
      severity: item.severity,
      trigger_signal: item.trigger_signal,
      active_primitive_ref: primitiveRef,
      telemetry_refs: telemetryRefs,
      sensor_evidence_refs: item.sensor_evidence_refs.length === 0 ? undefined : item.sensor_evidence_refs,
      immediate_control_action: item.immediate_control_action,
      oops_eligible: item.oops_eligible,
      human_review_required: item.human_review_required,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  });
  return freezeArray(events);
}

function mergeAnomalyEvents(inherited: readonly PDAnomalyEvent[], generated: readonly PDAnomalyEvent[]): readonly PDAnomalyEvent[] {
  const byKey = new Map<string, PDAnomalyEvent>();
  for (const event of [...inherited, ...generated]) {
    const key = `${event.anomaly_type}|${event.severity}|${event.trigger_signal}|${event.immediate_control_action}`;
    if (!byKey.has(key)) {
      byKey.set(key, event);
    }
  }
  return freezeArray([...byKey.values()].sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.anomaly_type.localeCompare(b.anomaly_type)));
}

function collectSaturationFlags(
  telemetry: readonly ControlTelemetryPacket[],
  enforcement: ActuatorLimitEnforcementReport | undefined,
): readonly PDActuatorSaturationFlag[] {
  const flags = telemetry.flatMap((packet) => packet.actuator_saturation_flags);
  const enforcementFlags = enforcement?.actuator_saturation_flags ?? [];
  const byKey = new Map<string, PDActuatorSaturationFlag>();
  for (const flag of [...flags, ...enforcementFlags]) {
    const key = `${flag.actuator_ref}|${flag.joint_ref}|${flag.saturation_type}|${flag.action}|${round6(flag.ratio)}`;
    if (!byKey.has(key)) {
      byKey.set(key, Object.freeze({ ...flag, ratio: round6(flag.ratio) }));
    }
  }
  return freezeArray([...byKey.values()]);
}

function collectSensorEvidenceRefs(input: ExecutionMonitorInput, anomalies: readonly PDAnomalyEvent[]): readonly Ref[] {
  return freezeArray([...new Set([
    ...collectAllSensorEvidenceRefs(input),
    ...anomalies.flatMap((event) => event.sensor_evidence_refs ?? []),
  ])].sort());
}

function collectAllSensorEvidenceRefs(input: ExecutionMonitorInput): readonly Ref[] {
  return [
    ...(input.contact_evidence ?? []).map((item) => item.evidence_ref),
    ...(input.imu_evidence ?? []).map((item) => item.evidence_ref),
    ...(input.visual_status ?? []).map((item) => item.evidence_ref),
    ...(input.audio_cues ?? []).map((item) => item.evidence_ref),
  ];
}

function samplesFromTelemetrySummaries(telemetry: readonly ControlTelemetryPacket[], policy: NormalizedExecutionPolicy): readonly ExecutionTrackingSample[] {
  const samples = telemetry.flatMap((packet) => {
    const magnitude = extractErrorMagnitude(packet.tracking_error_summary);
    if (magnitude === undefined) {
      return [];
    }
    return [Object.freeze({
      sample_ref: `summary_sample_${packet.telemetry_ref}`,
      telemetry_ref: packet.telemetry_ref,
      timestamp_s: packet.timestamp_interval.end_s,
      signed_position_error: magnitude,
      signed_velocity_error: undefined,
      position_tolerance: policy.default_position_tolerance,
      velocity_tolerance: policy.default_velocity_tolerance,
    })];
  });
  return freezeArray(samples);
}

function extractErrorMagnitude(summary: string): number | undefined {
  const matches = [...summary.matchAll(/(?:position|pose|tracking|residual|error)[_\s:-]*([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/gi)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));
  if (matches.length === 0) {
    return undefined;
  }
  return matches.reduce((maxValue, value) => Math.abs(value) > Math.abs(maxValue) ? value : maxValue, matches[0]);
}

function sortTelemetry(telemetry: readonly ControlTelemetryPacket[]): readonly ControlTelemetryPacket[] {
  return freezeArray([...telemetry].sort((a, b) => a.timestamp_interval.end_s - b.timestamp_interval.end_s));
}

function latestByRef<T>(items: readonly T[], refOf: (item: T) => Ref): readonly T[] {
  const byRef = new Map<Ref, T>();
  const timeOf = (item: T): number => {
    if ("timestamp_s" in Object(item)) {
      const candidate = (item as { readonly timestamp_s?: number }).timestamp_s;
      return candidate === undefined ? 0 : candidate;
    }
    return 0;
  };
  for (const item of items) {
    const ref = refOf(item);
    const existing = byRef.get(ref);
    if (existing === undefined || timeOf(item) >= timeOf(existing)) {
      byRef.set(ref, item);
    }
  }
  return freezeArray([...byRef.values()]);
}

function draft(
  anomalyType: PDAnomalyType,
  severity: PDAnomalySeverity,
  triggerSignal: string,
  sensorEvidenceRefs: readonly Ref[],
  immediateControlAction: PDImmediateControlAction,
  oopsEligible: boolean,
  humanReviewRequired?: boolean,
): AnomalyDraft {
  return Object.freeze({
    anomaly_type: anomalyType,
    severity,
    trigger_signal: triggerSignal,
    sensor_evidence_refs: freezeArray(sensorEvidenceRefs),
    immediate_control_action: immediateControlAction,
    oops_eligible: oopsEligible,
    human_review_required: humanReviewRequired,
  });
}

function noBlockingAnomaly(anomalies: readonly PDAnomalyEvent[]): boolean {
  return anomalies.every((event) => event.severity === "notice" || event.immediate_control_action === "continue");
}

function severityRank(severity: PDAnomalySeverity): number {
  if (severity === "critical") return 4;
  if (severity === "error") return 3;
  if (severity === "warning") return 2;
  return 1;
}

function freezeTrend(trend: ExecutionTrackingTrend): ExecutionTrackingTrend {
  return Object.freeze(trend);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function countSignChanges(values: readonly number[]): number {
  let count = 0;
  let previous = 0;
  for (const value of values) {
    const sign = Math.abs(value) <= EPSILON ? 0 : Math.sign(value);
    if (sign !== 0 && previous !== 0 && sign !== previous) {
      count += 1;
    }
    if (sign !== 0) {
      previous = sign;
    }
  }
  return count;
}

function crossedZero(values: readonly number[]): boolean {
  return countSignChanges(values) > 0;
}

function validateEvidenceRefAndTime(
  ref: Ref,
  timestampS: number,
  currentTimeS: number,
  policy: NormalizedExecutionPolicy,
  issues: ValidationIssue[],
  path: string,
  code: ExecutionMonitorIssueCode,
): void {
  validateRef(ref, issues, `${path}.evidence_ref`, code, policy.reject_hidden_identifiers);
  validateFinite(timestampS, issues, `${path}.timestamp_s`, code);
  if (Number.isFinite(timestampS) && currentTimeS - timestampS > policy.max_sensor_age_s + EPSILON) {
    issues.push(makeIssue("warning", "SensorEvidenceStale", `${path}.timestamp_s`, "Sensor evidence is stale for the current control tick.", "Refresh contact, IMU, visual, or audio evidence before high-risk control."));
  }
}

function validateRef(ref: Ref | undefined, issues: ValidationIssue[], path: string, code: ExecutionMonitorIssueCode, rejectHidden: boolean): void {
  if (ref === undefined || ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(makeIssue("error", code, path, "Reference must be a non-empty whitespace-free string.", "Use opaque runtime telemetry or evidence references."));
    return;
  }
  if (rejectHidden && HIDDEN_EXECUTION_PATTERN.test(ref)) {
    issues.push(makeIssue("error", "HiddenExecutionLeak", path, "Reference contains hidden simulator, backend, or QA detail.", "Strip hidden implementation and QA-truth identifiers from monitor inputs."));
  }
}

function validateFinite(value: number, issues: ValidationIssue[], path: string, code: ExecutionMonitorIssueCode): void {
  if (!Number.isFinite(value)) {
    issues.push(makeIssue("error", code, path, "Numeric value must be finite.", "Use finite canonical control units."));
  }
}

function validatePositive(value: number, issues: ValidationIssue[], path: string, code: ExecutionMonitorIssueCode): void {
  validateFinite(value, issues, path, code);
  if (Number.isFinite(value) && value <= 0) {
    issues.push(makeIssue("error", code, path, "Numeric value must be positive.", "Use a positive monitor threshold or tolerance."));
  }
}

function validateConfidence(value: number, issues: ValidationIssue[], path: string, code: ExecutionMonitorIssueCode): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    issues.push(makeIssue("error", code, path, "Confidence must be finite in [0, 1].", "Normalize evidence confidence before monitor ingestion."));
  }
}

function sanitizeRef(ref: Ref): Ref {
  return ref.replace(HIDDEN_EXECUTION_PATTERN, "hidden-detail").trim();
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value <= 0 ? fallback : value;
}

function integerOrDefault(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value <= 0 ? fallback : Math.max(1, Math.round(value));
}

function boundedOrDefault(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value < 0 || value > 1 ? fallback : value;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function formatNumber(value: number): string {
  return round6(value).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

function makeIssue(
  severity: ValidationSeverity,
  code: ExecutionMonitorIssueCode,
  path: string,
  message: string,
  remediation: string,
): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}
