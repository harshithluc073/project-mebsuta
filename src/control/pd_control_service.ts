/**
 * PD control service for Project Mebsuta deterministic execution.
 *
 * Blueprint: `architecture_docs/11_CONTROL_LAYER_IK_PD_TRAJECTORY_ARCHITECTURE.md`
 * sections 11.3, 11.5, 11.6, 11.7, 11.10, 11.11, 11.14, 11.15, 11.16,
 * and 11.17.
 *
 * This service tracks shaped trajectory setpoints with classical
 * proportional-derivative control:
 *
 *   tau = K_p * (q_d - q) + K_d * (dq_d - dq)
 *
 * It selects the active setpoint at a finite control timestamp, computes
 * joint position and velocity errors, applies damping and effort bounds,
 * optionally validates each actuator command through the existing actuator
 * limit catalog, and emits runtime-only command descriptors plus compact
 * telemetry for execution monitoring, Oops-loop diagnosis, and QA replay.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type {
  Ref,
  TimestampInterval,
  ValidationIssue,
  ValidationSeverity,
} from "../simulation/world_manifest";
import type {
  ActuatorCommandInput,
  ActuatorCommandInterface,
  ActuatorCommandLimitReport,
} from "../embodiment/actuator_limit_catalog";
import type {
  ContactMode,
  PrimitivePhase,
  TrajectoryDescriptor,
  TrajectorySetpoint,
} from "./trajectory_shaping_service";

export const PD_CONTROL_SERVICE_SCHEMA_VERSION = "mebsuta.pd_control_service.v1" as const;

const EPSILON = 1e-9;
const HIDDEN_PD_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|qa_success|qa_label|qa_only|simulator truth|mesh_name|asset_id|benchmark_truth|oracle_pose)/i;

export type PDDeadlineStatus = "on_time" | "nearing_timeout" | "timed_out";
export type PDTrackingDecision = "tracking" | "tracking_with_warnings" | "saturated" | "safe_hold_required" | "rejected";
export type PDRecommendedAction = "send_actuator_commands" | "slow" | "pause" | "stabilize" | "safe_hold" | "repair_trajectory" | "human_review";
export type PDImmediateControlAction = "continue" | "slow" | "pause" | "stabilize" | "release" | "retreat" | "safe_hold";
export type PDAnomalyType = "slip" | "drop" | "overshoot" | "oscillation" | "collision" | "timeout" | "saturation" | "instability" | "tool_instability" | "sensor_loss";
export type PDAnomalySeverity = "notice" | "warning" | "error" | "critical";
export type PDCommandMode = "position" | "velocity" | "effort" | "grip_width" | "tool_state" | "hold";
export type PDControlIssueCode =
  | "InputMissing"
  | "TrajectoryInvalid"
  | "SetpointMissing"
  | "SensorFeedbackMissing"
  | "GainProfileInvalid"
  | "ControlTimingInvalid"
  | "EffortSaturation"
  | "VelocitySaturation"
  | "PositionErrorHigh"
  | "VelocityErrorHigh"
  | "OscillationDetected"
  | "ActuatorLimitRejected"
  | "DeadlineViolation"
  | "HiddenPDLeak"
  | "PolicyInvalid";

/**
 * Joint feedback sample from proprioception or actuator feedback.
 */
export interface PDJointFeedback {
  readonly joint_ref: Ref;
  readonly position: number;
  readonly velocity: number;
  readonly effort?: number;
  readonly feedback_ref?: Ref;
  readonly timestamp_s: number;
}

/**
 * Binding from a controlled joint to a declared actuator command interface.
 */
export interface PDActuatorBinding {
  readonly joint_ref: Ref;
  readonly actuator_ref: Ref;
  readonly command_interface: ActuatorCommandInterface;
  readonly command_mode: PDCommandMode;
  readonly command_scale?: number;
  readonly feedforward_effort?: number;
}

/**
 * Per-joint gain and saturation envelope used by PD tracking.
 */
export interface PDJointGain {
  readonly joint_ref: Ref;
  readonly kp: number;
  readonly kd: number;
  readonly max_effort: number;
  readonly max_velocity?: number;
  readonly max_position_error?: number;
  readonly max_velocity_error?: number;
  readonly effective_inertia?: number;
}

/**
 * Versioned PD gain profile.
 */
export interface PDGainProfile {
  readonly gain_profile_ref: Ref;
  readonly primitive_phase: PrimitivePhase;
  readonly contact_mode: ContactMode;
  readonly joint_gains: readonly PDJointGain[];
  readonly default_kp: number;
  readonly default_kd?: number;
  readonly default_max_effort: number;
  readonly default_max_velocity?: number;
  readonly damping_ratio?: number;
  readonly qa_status: "untested" | "simulation_validated" | "contact_validated" | "benchmark_approved";
}

/**
 * Runtime control policy for timing, saturation, and anomaly detection.
 */
export interface PDControlPolicy {
  readonly control_period_s?: number;
  readonly max_feedback_age_s?: number;
  readonly nearing_timeout_fraction?: number;
  readonly oscillation_history_window?: number;
  readonly overshoot_error_multiplier?: number;
  readonly saturation_warn_ratio?: number;
  readonly safe_hold_on_saturation?: boolean;
  readonly reject_hidden_identifiers?: boolean;
}

/**
 * Optional adapter into actuator-limit validation.
 */
export interface PDControlAdapters {
  readonly evaluateActuatorCommand?: (input: ActuatorCommandInput) => ActuatorCommandLimitReport;
}

/**
 * Input packet for File 11 `executePDTracking(...)`.
 */
export interface PDControlInput {
  readonly request_ref?: Ref;
  readonly work_order_ref: Ref;
  readonly trajectory: TrajectoryDescriptor;
  readonly gain_profile: PDGainProfile;
  readonly joint_feedback: readonly PDJointFeedback[];
  readonly actuator_bindings: readonly PDActuatorBinding[];
  readonly current_time_s: number;
  readonly issued_at_s?: number;
  readonly previous_tracking_errors?: readonly PDJointTrackingError[];
  readonly contact_state_summary?: string;
  readonly imu_stability_summary?: string;
  readonly adapters?: PDControlAdapters;
  readonly policy?: PDControlPolicy;
}

/**
 * Per-joint tracking error used for control and telemetry.
 */
export interface PDJointTrackingError {
  readonly joint_ref: Ref;
  readonly desired_position: number;
  readonly measured_position: number;
  readonly position_error: number;
  readonly desired_velocity: number;
  readonly measured_velocity: number;
  readonly velocity_error: number;
  readonly timestamp_s: number;
}

/**
 * Runtime actuator command prepared by PD control. The hardware gateway owns
 * final hardware application; this descriptor stays inside the control stack.
 */
export interface PDActuatorCommand {
  readonly command_ref: Ref;
  readonly actuator_ref: Ref;
  readonly joint_ref: Ref;
  readonly command_mode: PDCommandMode;
  readonly target_position?: number;
  readonly target_velocity?: number;
  readonly target_effort?: number;
  readonly target_grip_width?: number;
  readonly target_timestamp_s: number;
  readonly issued_at_s: number;
  readonly primitive_ref: Ref;
  readonly work_order_ref: Ref;
  readonly safety_envelope_ref?: Ref;
  readonly authorization: "validator_approved_control_stack";
  readonly determinism_hash: string;
}

/**
 * Saturation summary for cognitive-safe telemetry.
 */
export interface PDActuatorSaturationFlag {
  readonly actuator_ref: Ref;
  readonly joint_ref: Ref;
  readonly saturation_type: "effort" | "velocity" | "position" | "actuator_limit";
  readonly ratio: number;
  readonly action: "none" | "clipped" | "safe_hold_required" | "rejected";
}

/**
 * File 11 anomaly event emitted by the PD controller.
 */
export interface PDAnomalyEvent {
  readonly anomaly_ref: Ref;
  readonly anomaly_type: PDAnomalyType;
  readonly severity: PDAnomalySeverity;
  readonly trigger_signal: string;
  readonly active_primitive_ref: Ref;
  readonly telemetry_refs: readonly Ref[];
  readonly sensor_evidence_refs?: readonly Ref[];
  readonly immediate_control_action: PDImmediateControlAction;
  readonly oops_eligible: boolean;
  readonly human_review_required?: boolean;
  readonly determinism_hash: string;
}

/**
 * File 11 `ControlTelemetryPacket`.
 */
export interface ControlTelemetryPacket {
  readonly schema_version: typeof PD_CONTROL_SERVICE_SCHEMA_VERSION;
  readonly telemetry_ref: Ref;
  readonly work_order_ref: Ref;
  readonly primitive_ref: Ref;
  readonly timestamp_interval: TimestampInterval;
  readonly tracking_error_summary: string;
  readonly actuator_saturation_flags: readonly PDActuatorSaturationFlag[];
  readonly contact_state_summary?: string;
  readonly imu_stability_summary?: string;
  readonly deadline_status: PDDeadlineStatus;
  readonly anomaly_candidates: readonly PDAnomalyEvent[];
  readonly internal_solver_details?: never;
  readonly cognitive_visibility: "control_telemetry_packet";
  readonly determinism_hash: string;
}

/**
 * Full PD tracking report.
 */
export interface PDControlReport {
  readonly schema_version: typeof PD_CONTROL_SERVICE_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/11_CONTROL_LAYER_IK_PD_TRAJECTORY_ARCHITECTURE.md";
  readonly report_ref: Ref;
  readonly decision: PDTrackingDecision;
  readonly recommended_action: PDRecommendedAction;
  readonly commands: readonly PDActuatorCommand[];
  readonly telemetry_packet: ControlTelemetryPacket;
  readonly tracking_errors: readonly PDJointTrackingError[];
  readonly actuator_limit_reports: readonly ActuatorCommandLimitReport[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
  readonly cognitive_visibility: "pd_control_report";
}

interface NormalizedPDControlPolicy {
  readonly control_period_s: number;
  readonly max_feedback_age_s: number;
  readonly nearing_timeout_fraction: number;
  readonly oscillation_history_window: number;
  readonly overshoot_error_multiplier: number;
  readonly saturation_warn_ratio: number;
  readonly safe_hold_on_saturation: boolean;
  readonly reject_hidden_identifiers: boolean;
}

interface PDControlState {
  readonly activeSetpoints: readonly TrajectorySetpoint[];
  readonly trackingErrors: readonly PDJointTrackingError[];
  readonly commands: readonly PDActuatorCommand[];
  readonly actuatorLimitReports: readonly ActuatorCommandLimitReport[];
  readonly saturationFlags: readonly PDActuatorSaturationFlag[];
  readonly anomalies: readonly PDAnomalyEvent[];
  readonly deadlineStatus: PDDeadlineStatus;
}

const DEFAULT_POLICY: NormalizedPDControlPolicy = Object.freeze({
  control_period_s: 1 / 120,
  max_feedback_age_s: 0.1,
  nearing_timeout_fraction: 0.85,
  oscillation_history_window: 6,
  overshoot_error_multiplier: 2.5,
  saturation_warn_ratio: 0.85,
  safe_hold_on_saturation: true,
  reject_hidden_identifiers: true,
});

/**
 * Executable File 11 `PDControlService`.
 */
export class PDControlService {
  private readonly policy: NormalizedPDControlPolicy;

  public constructor(policy: PDControlPolicy = {}) {
    this.policy = mergePolicy(DEFAULT_POLICY, policy);
  }

  /**
   * Executes one deterministic PD tracking update for the active trajectory
   * timestamp and returns actuator command candidates plus telemetry.
   */
  public executePDTracking(input: PDControlInput): PDControlReport {
    const policy = mergePolicy(this.policy, input.policy ?? {});
    const issues: ValidationIssue[] = [];
    validatePolicy(policy, issues);
    validateInput(input, policy, issues);

    const requestRef = input.request_ref ?? makeRef("pd_tracking", input.work_order_ref, input.current_time_s.toString());
    const state = issues.some((issue) => issue.severity === "error")
      ? buildEmptyState(input)
      : buildControlState(input, policy, issues);
    const decision = decideTracking(state, issues, policy);
    const recommendedAction = chooseRecommendedAction(decision, state, issues);
    const telemetry = buildTelemetry(input, requestRef, state);
    const reportRef = makeRef("pd_control_report", requestRef, decision);

    return Object.freeze({
      schema_version: PD_CONTROL_SERVICE_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/11_CONTROL_LAYER_IK_PD_TRAJECTORY_ARCHITECTURE.md",
      report_ref: reportRef,
      decision,
      recommended_action: recommendedAction,
      commands: state.commands,
      telemetry_packet: telemetry,
      tracking_errors: state.trackingErrors,
      actuator_limit_reports: state.actuatorLimitReports,
      issues: freezeArray(issues),
      ok: decision === "tracking" || decision === "tracking_with_warnings",
      determinism_hash: computeDeterminismHash({
        reportRef,
        workOrder: input.work_order_ref,
        trajectory: input.trajectory.trajectory_ref,
        decision,
        commandRefs: state.commands.map((command) => command.command_ref),
        telemetry: telemetry.telemetry_ref,
        issueCodes: issues.map((issue) => issue.code).sort(),
      }),
      cognitive_visibility: "pd_control_report",
    });
  }
}

/**
 * Functional API for File 11 `executePDTracking(...)`.
 */
export function executePDTracking(input: PDControlInput): PDControlReport {
  return new PDControlService(input.policy).executePDTracking(input);
}

function buildControlState(
  input: PDControlInput,
  policy: NormalizedPDControlPolicy,
  issues: ValidationIssue[],
): PDControlState {
  const activeSetpoints = resolveActiveSetpoints(input.trajectory, input.current_time_s, issues);
  const trackingErrors = activeSetpoints.map((setpoint) => computeTrackingError(setpoint, input, issues));
  const commands = trackingErrors.map((error) => buildCommandForError(error, input, policy, issues)).filter(isPDActuatorCommand);
  const actuatorLimitReports = commands
    .map((command) => validateActuatorCommand(command, input))
    .filter(isActuatorCommandLimitReport);
  issues.push(...actuatorLimitReports.flatMap((report) => report.issues.map((issue) => Object.freeze({ ...issue, path: `$.actuator_limit_reports.${report.actuator_ref}.${issue.path}` }))));
  const saturationFlags = freezeArray([
    ...commands.flatMap((command) => saturationFlagsForCommand(command, input, policy)),
    ...actuatorLimitReports.filter((report) => report.decision !== "accepted").map(flagFromActuatorLimitReport),
  ]);
  const deadlineStatus = classifyDeadline(input, policy);
  const anomalies = detectAnomalies(input, trackingErrors, saturationFlags, deadlineStatus, policy);
  return Object.freeze({
    activeSetpoints,
    trackingErrors: freezeArray(trackingErrors),
    commands: freezeArray(commands),
    actuatorLimitReports: freezeArray(actuatorLimitReports),
    saturationFlags,
    anomalies,
    deadlineStatus,
  });
}

function resolveActiveSetpoints(
  trajectory: TrajectoryDescriptor,
  currentTimeS: number,
  issues: ValidationIssue[],
): readonly TrajectorySetpoint[] {
  const byJoint = new Map<Ref, TrajectorySetpoint[]>();
  for (const setpoint of trajectory.setpoint_profile) {
    const values = byJoint.get(setpoint.joint_ref) ?? [];
    values.push(setpoint);
    byJoint.set(setpoint.joint_ref, values);
  }
  const resolved: TrajectorySetpoint[] = [];
  for (const [jointRef, samples] of byJoint.entries()) {
    const ordered = [...samples].sort((a, b) => a.timestamp_s - b.timestamp_s);
    const sample = interpolateSetpoint(jointRef, ordered, currentTimeS);
    if (sample === undefined) {
      issues.push(makeIssue("error", "SetpointMissing", `$.trajectory.setpoint_profile.${jointRef}`, "No time-indexed setpoint is available for the control timestamp.", "Provide a finite trajectory profile covering the current time."));
    } else {
      resolved.push(sample);
    }
  }
  return freezeArray(resolved.sort((a, b) => a.joint_ref.localeCompare(b.joint_ref)));
}

function interpolateSetpoint(
  jointRef: Ref,
  ordered: readonly TrajectorySetpoint[],
  timeS: number,
): TrajectorySetpoint | undefined {
  if (ordered.length === 0) return undefined;
  if (timeS <= ordered[0].timestamp_s) return ordered[0];
  const last = ordered[ordered.length - 1];
  if (timeS >= last.timestamp_s) return last;
  const upperIndex = ordered.findIndex((sample) => sample.timestamp_s >= timeS);
  if (upperIndex <= 0) return ordered[0];
  const lower = ordered[upperIndex - 1];
  const upper = ordered[upperIndex];
  const span = Math.max(EPSILON, upper.timestamp_s - lower.timestamp_s);
  const alpha = clamp((timeS - lower.timestamp_s) / span, 0, 1);
  return Object.freeze({
    timestamp_s: round6(timeS),
    joint_ref: jointRef,
    position: round6(lerp(lower.position, upper.position, alpha)),
    velocity: round6(lerp(lower.velocity, upper.velocity, alpha)),
    acceleration: round6(lerp(lower.acceleration, upper.acceleration, alpha)),
    effort: lower.effort === undefined && upper.effort === undefined
      ? undefined
      : round6(lerp(lower.effort ?? 0, upper.effort ?? 0, alpha)),
  });
}

function computeTrackingError(
  setpoint: TrajectorySetpoint,
  input: PDControlInput,
  issues: ValidationIssue[],
): PDJointTrackingError {
  const feedback = input.joint_feedback.find((candidate) => candidate.joint_ref === setpoint.joint_ref);
  if (feedback === undefined) {
    issues.push(makeIssue("error", "SensorFeedbackMissing", `$.joint_feedback.${setpoint.joint_ref}`, "PD tracking requires measured joint feedback.", "Provide current position and velocity feedback before control."));
  }
  return Object.freeze({
    joint_ref: setpoint.joint_ref,
    desired_position: setpoint.position,
    measured_position: feedback?.position ?? setpoint.position,
    position_error: round6(setpoint.position - (feedback?.position ?? setpoint.position)),
    desired_velocity: setpoint.velocity,
    measured_velocity: feedback?.velocity ?? 0,
    velocity_error: round6(setpoint.velocity - (feedback?.velocity ?? 0)),
    timestamp_s: setpoint.timestamp_s,
  });
}

function buildCommandForError(
  error: PDJointTrackingError,
  input: PDControlInput,
  policy: NormalizedPDControlPolicy,
  issues: ValidationIssue[],
): PDActuatorCommand | undefined {
  const binding = input.actuator_bindings.find((candidate) => candidate.joint_ref === error.joint_ref);
  if (binding === undefined) {
    issues.push(makeIssue("error", "InputMissing", `$.actuator_bindings.${error.joint_ref}`, "No actuator binding exists for the tracked joint.", "Bind each controlled joint to a declared actuator."));
    return undefined;
  }
  const gain = resolveGain(error.joint_ref, input.gain_profile, issues);
  const rawEffort = gain.kp * error.position_error + gain.kd * error.velocity_error + (binding.feedforward_effort ?? 0);
  const targetEffort = clamp(rawEffort * (binding.command_scale ?? 1), -gain.max_effort, gain.max_effort);
  const velocityTarget = error.desired_velocity;
  const commandRef = makeRef("pd_command", input.work_order_ref, binding.actuator_ref, error.timestamp_s.toString());
  if (Math.abs(rawEffort) > gain.max_effort * policy.saturation_warn_ratio) {
    issues.push(makeIssue("warning", "EffortSaturation", `$.commands.${binding.actuator_ref}.effort`, "PD effort is near or beyond the configured effort limit.", "Slow the trajectory, lower gains, or enter safe-hold if repeated."));
  }
  if (gain.max_velocity !== undefined && Math.abs(velocityTarget) > gain.max_velocity * policy.saturation_warn_ratio) {
    issues.push(makeIssue("warning", "VelocitySaturation", `$.commands.${binding.actuator_ref}.velocity`, "Desired velocity is near or beyond the configured velocity limit.", "Slow the trajectory or reduce phase velocity caps."));
  }
  if (gain.max_position_error !== undefined && Math.abs(error.position_error) > gain.max_position_error) {
    issues.push(makeIssue("warning", "PositionErrorHigh", `$.tracking_errors.${error.joint_ref}.position_error`, "Position tracking error exceeds the gain profile threshold.", "Pause, slow, or replan if error persists."));
  }
  if (gain.max_velocity_error !== undefined && Math.abs(error.velocity_error) > gain.max_velocity_error) {
    issues.push(makeIssue("warning", "VelocityErrorHigh", `$.tracking_errors.${error.joint_ref}.velocity_error`, "Velocity tracking error exceeds the gain profile threshold.", "Increase damping or slow the trajectory."));
  }
  const command = {
    command_ref: commandRef,
    actuator_ref: binding.actuator_ref,
    joint_ref: error.joint_ref,
    command_mode: binding.command_mode,
    target_position: binding.command_mode === "position" ? error.desired_position : undefined,
    target_velocity: binding.command_mode === "velocity" || binding.command_mode === "position" ? velocityTarget : undefined,
    target_effort: binding.command_mode === "effort" || binding.command_mode === "position" || binding.command_mode === "velocity" ? targetEffort : undefined,
    target_grip_width: binding.command_mode === "grip_width" ? error.desired_position : undefined,
    target_timestamp_s: error.timestamp_s,
    issued_at_s: input.issued_at_s ?? input.current_time_s,
    primitive_ref: input.trajectory.primitive_phase,
    work_order_ref: input.work_order_ref,
    safety_envelope_ref: input.trajectory.abort_conditions.find((condition) => condition.includes("safety")),
    authorization: "validator_approved_control_stack" as const,
  };
  return Object.freeze({
    ...command,
    determinism_hash: computeDeterminismHash(command),
  });
}

function validateActuatorCommand(
  command: PDActuatorCommand,
  input: PDControlInput,
): ActuatorCommandLimitReport | undefined {
  const binding = input.actuator_bindings.find((candidate) => candidate.actuator_ref === command.actuator_ref);
  if (binding === undefined || input.adapters?.evaluateActuatorCommand === undefined) return undefined;
  const feedback = input.joint_feedback.find((candidate) => candidate.joint_ref === command.joint_ref);
  return input.adapters.evaluateActuatorCommand({
    actuator_ref: command.actuator_ref,
    interface: binding.command_interface,
    consumer: "pd_control",
    position: command.target_position,
    velocity: command.target_velocity,
    effort: command.target_effort,
    grip_width: command.target_grip_width,
    previous_position: feedback?.position,
    previous_velocity: feedback?.velocity,
    delta_time_s: Math.max(EPSILON, input.current_time_s - (feedback?.timestamp_s ?? input.current_time_s - DEFAULT_POLICY.control_period_s)),
  });
}

function saturationFlagsForCommand(
  command: PDActuatorCommand,
  input: PDControlInput,
  policy: NormalizedPDControlPolicy,
): readonly PDActuatorSaturationFlag[] {
  const gain = resolveGain(command.joint_ref, input.gain_profile, []);
  const flags: PDActuatorSaturationFlag[] = [];
  if (command.target_effort !== undefined && Math.abs(command.target_effort) >= gain.max_effort * policy.saturation_warn_ratio) {
    flags.push(makeSaturationFlag(command, "effort", Math.abs(command.target_effort) / Math.max(EPSILON, gain.max_effort), Math.abs(command.target_effort) > gain.max_effort ? "clipped" : "none"));
  }
  if (command.target_velocity !== undefined && gain.max_velocity !== undefined && Math.abs(command.target_velocity) >= gain.max_velocity * policy.saturation_warn_ratio) {
    flags.push(makeSaturationFlag(command, "velocity", Math.abs(command.target_velocity) / Math.max(EPSILON, gain.max_velocity), Math.abs(command.target_velocity) > gain.max_velocity ? "clipped" : "none"));
  }
  return freezeArray(flags);
}

function flagFromActuatorLimitReport(report: ActuatorCommandLimitReport): PDActuatorSaturationFlag {
  return Object.freeze({
    actuator_ref: report.actuator_ref,
    joint_ref: report.target_joint_ref,
    saturation_type: "actuator_limit",
    ratio: round6(report.saturation_ratio),
    action: report.decision === "safe_hold" ? "safe_hold_required" : report.decision === "rejected" ? "rejected" : report.decision === "clipped" ? "clipped" : "none",
  });
}

function detectAnomalies(
  input: PDControlInput,
  errors: readonly PDJointTrackingError[],
  saturationFlags: readonly PDActuatorSaturationFlag[],
  deadlineStatus: PDDeadlineStatus,
  policy: NormalizedPDControlPolicy,
): readonly PDAnomalyEvent[] {
  const telemetryRef = makeRef("control_telemetry", input.work_order_ref, input.current_time_s.toString());
  const anomalies: PDAnomalyEvent[] = [];
  if (deadlineStatus === "timed_out") {
    anomalies.push(makeAnomaly("timeout", "critical", "deadline_status=timed_out", input, telemetryRef, "safe_hold"));
  } else if (deadlineStatus === "nearing_timeout") {
    anomalies.push(makeAnomaly("timeout", "warning", "deadline_status=nearing_timeout", input, telemetryRef, "slow"));
  }
  if (saturationFlags.some((flag) => flag.action === "safe_hold_required" || flag.action === "rejected")) {
    anomalies.push(makeAnomaly("saturation", "error", "actuator_limit_rejected_or_safe_hold", input, telemetryRef, "safe_hold"));
  } else if (saturationFlags.length > 0) {
    anomalies.push(makeAnomaly("saturation", "warning", "actuator_saturation_near_limit", input, telemetryRef, policy.safe_hold_on_saturation ? "stabilize" : "slow"));
  }
  for (const error of errors) {
    if (isOscillating(error, input.previous_tracking_errors ?? [], policy)) {
      anomalies.push(makeAnomaly("oscillation", "warning", `tracking_error_sign_change:${error.joint_ref}`, input, telemetryRef, "slow"));
    }
    const gain = resolveGain(error.joint_ref, input.gain_profile, []);
    if (gain.max_position_error !== undefined && Math.abs(error.position_error) > gain.max_position_error * policy.overshoot_error_multiplier) {
      anomalies.push(makeAnomaly("overshoot", "error", `position_error_high:${error.joint_ref}`, input, telemetryRef, "pause"));
    }
  }
  return freezeArray(uniqueAnomalies(anomalies));
}

function buildTelemetry(
  input: PDControlInput,
  requestRef: Ref,
  state: PDControlState,
): ControlTelemetryPacket {
  const telemetryRef = makeRef("control_telemetry", requestRef);
  const interval = buildTelemetryInterval(input);
  const summary = summarizeTrackingErrors(state.trackingErrors);
  const base = {
    schema_version: PD_CONTROL_SERVICE_SCHEMA_VERSION,
    telemetry_ref: telemetryRef,
    work_order_ref: input.work_order_ref,
    primitive_ref: input.trajectory.primitive_phase,
    timestamp_interval: interval,
    tracking_error_summary: summary,
    actuator_saturation_flags: state.saturationFlags,
    contact_state_summary: input.contact_state_summary === undefined ? undefined : sanitizeText(input.contact_state_summary),
    imu_stability_summary: input.imu_stability_summary === undefined ? undefined : sanitizeText(input.imu_stability_summary),
    deadline_status: state.deadlineStatus,
    anomaly_candidates: state.anomalies,
    cognitive_visibility: "control_telemetry_packet" as const,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash({
      telemetryRef,
      interval,
      summary,
      saturation: state.saturationFlags,
      anomalies: state.anomalies.map((anomaly) => anomaly.anomaly_ref),
      deadline: state.deadlineStatus,
    }),
  });
}

function validateInput(
  input: PDControlInput,
  policy: NormalizedPDControlPolicy,
  issues: ValidationIssue[],
): void {
  validateSafeRef(input.work_order_ref, "$.work_order_ref", "InputMissing", policy, issues);
  validateSafeRef(input.trajectory.trajectory_ref, "$.trajectory.trajectory_ref", "TrajectoryInvalid", policy, issues);
  validateSafeRef(input.gain_profile.gain_profile_ref, "$.gain_profile.gain_profile_ref", "GainProfileInvalid", policy, issues);
  validateFinite(input.current_time_s, "$.current_time_s", "ControlTimingInvalid", issues);
  if (input.trajectory.setpoint_profile.length === 0) {
    issues.push(makeIssue("error", "TrajectoryInvalid", "$.trajectory.setpoint_profile", "PD control requires a non-empty trajectory profile.", "Shape a finite trajectory before PD tracking."));
  }
  if (input.actuator_bindings.length === 0) {
    issues.push(makeIssue("error", "InputMissing", "$.actuator_bindings", "PD control requires actuator bindings.", "Bind controlled joints to declared actuators."));
  }
  for (const [index, feedback] of input.joint_feedback.entries()) {
    validateSafeRef(feedback.joint_ref, `$.joint_feedback[${index}].joint_ref`, "SensorFeedbackMissing", policy, issues);
    validateFinite(feedback.position, `$.joint_feedback[${index}].position`, "SensorFeedbackMissing", issues);
    validateFinite(feedback.velocity, `$.joint_feedback[${index}].velocity`, "SensorFeedbackMissing", issues);
    validateFinite(feedback.timestamp_s, `$.joint_feedback[${index}].timestamp_s`, "SensorFeedbackMissing", issues);
    if (input.current_time_s - feedback.timestamp_s > policy.max_feedback_age_s) {
      issues.push(makeIssue("error", "SensorFeedbackMissing", `$.joint_feedback[${index}].timestamp_s`, "Joint feedback is stale for PD control.", "Refresh proprioceptive or actuator feedback before issuing commands."));
    }
  }
  for (const gain of input.gain_profile.joint_gains) {
    validateGain(gain, issues);
  }
}

function validatePolicy(policy: NormalizedPDControlPolicy, issues: ValidationIssue[]): void {
  for (const [path, value] of [
    ["$.policy.control_period_s", policy.control_period_s],
    ["$.policy.max_feedback_age_s", policy.max_feedback_age_s],
    ["$.policy.nearing_timeout_fraction", policy.nearing_timeout_fraction],
    ["$.policy.oscillation_history_window", policy.oscillation_history_window],
    ["$.policy.overshoot_error_multiplier", policy.overshoot_error_multiplier],
    ["$.policy.saturation_warn_ratio", policy.saturation_warn_ratio],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      issues.push(makeIssue("error", "PolicyInvalid", path, "PD control policy values must be positive finite numbers.", "Use positive finite policy values."));
    }
  }
  if (policy.nearing_timeout_fraction > 1 || policy.saturation_warn_ratio > 1) {
    issues.push(makeIssue("error", "PolicyInvalid", "$.policy.ratios", "Policy ratios must be in (0, 1].", "Use normalized warning ratios."));
  }
}

function validateGain(gain: PDJointGain, issues: ValidationIssue[]): void {
  for (const [path, value] of [
    [`$.gain_profile.joint_gains.${gain.joint_ref}.kp`, gain.kp],
    [`$.gain_profile.joint_gains.${gain.joint_ref}.kd`, gain.kd],
    [`$.gain_profile.joint_gains.${gain.joint_ref}.max_effort`, gain.max_effort],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || (path.endsWith(".max_effort") && value <= 0)) {
      issues.push(makeIssue("error", "GainProfileInvalid", path, "PD gains and effort limits must be finite nonnegative values, with positive effort limit.", "Use calibrated gain profile values."));
    }
  }
}

function resolveGain(jointRef: Ref, profile: PDGainProfile, issues: ValidationIssue[]): PDJointGain {
  const explicit = profile.joint_gains.find((gain) => gain.joint_ref === jointRef);
  const defaultKd = profile.default_kd ?? criticalDamping(profile.default_kp, 1, profile.damping_ratio ?? 1);
  const defaultGain: PDJointGain = Object.freeze({
    joint_ref: jointRef,
    kp: profile.default_kp,
    kd: defaultKd,
    max_effort: profile.default_max_effort,
    max_velocity: profile.default_max_velocity,
  });
  const gain: PDJointGain = explicit ?? defaultGain;
  if (explicit === undefined) {
    issues.push(makeIssue("warning", "GainProfileInvalid", `$.gain_profile.joint_gains.${jointRef}`, "Joint uses default PD gain profile.", "Declare joint-specific gains before benchmark approval."));
  }
  if (gain.kd <= EPSILON && gain.effective_inertia !== undefined) {
    return Object.freeze({ ...gain, kd: criticalDamping(gain.kp, gain.effective_inertia, profile.damping_ratio ?? 1) });
  }
  return gain;
}

function criticalDamping(kp: number, effectiveInertia: number, dampingRatio: number): number {
  return round6(Math.max(0, dampingRatio) * 2 * Math.sqrt(Math.max(0, kp) * Math.max(EPSILON, effectiveInertia)));
}

function decideTracking(
  state: PDControlState,
  issues: readonly ValidationIssue[],
  policy: NormalizedPDControlPolicy,
): PDTrackingDecision {
  if (issues.some((issue) => issue.severity === "error" && issue.code !== "EffortSaturation" && issue.code !== "VelocitySaturation")) return "rejected";
  if (state.deadlineStatus === "timed_out" || state.anomalies.some((anomaly) => anomaly.immediate_control_action === "safe_hold")) return "safe_hold_required";
  if (state.saturationFlags.some((flag) => flag.action === "safe_hold_required" || (policy.safe_hold_on_saturation && flag.ratio > 1))) return "safe_hold_required";
  if (state.saturationFlags.length > 0) return "saturated";
  return issues.some((issue) => issue.severity === "warning") || state.anomalies.length > 0 ? "tracking_with_warnings" : "tracking";
}

function chooseRecommendedAction(
  decision: PDTrackingDecision,
  state: PDControlState,
  issues: readonly ValidationIssue[],
): PDRecommendedAction {
  if (decision === "tracking") return "send_actuator_commands";
  if (decision === "safe_hold_required") return "safe_hold";
  if (decision === "saturated") return "stabilize";
  if (issues.some((issue) => issue.code === "TrajectoryInvalid" || issue.code === "SetpointMissing")) return "repair_trajectory";
  if (state.anomalies.some((anomaly) => anomaly.anomaly_type === "oscillation" || anomaly.anomaly_type === "overshoot")) return "slow";
  return decision === "tracking_with_warnings" ? "send_actuator_commands" : "human_review";
}

function classifyDeadline(input: PDControlInput, policy: NormalizedPDControlPolicy): PDDeadlineStatus {
  const elapsed = Math.max(0, input.current_time_s - input.trajectory.setpoint_profile[0]?.timestamp_s);
  const timeout = Math.max(policy.control_period_s, input.trajectory.duration_estimate_s);
  if (elapsed > timeout + policy.control_period_s) return "timed_out";
  if (elapsed >= timeout * policy.nearing_timeout_fraction) return "nearing_timeout";
  return "on_time";
}

function buildTelemetryInterval(input: PDControlInput): TimestampInterval {
  const end = Math.max(0, input.current_time_s);
  const start = Math.max(0, end - (input.policy?.control_period_s ?? DEFAULT_POLICY.control_period_s));
  return Object.freeze({ start_s: round6(start), end_s: round6(end) });
}

function summarizeTrackingErrors(errors: readonly PDJointTrackingError[]): string {
  if (errors.length === 0) return "no_tracking_errors_available";
  const maxPosition = Math.max(...errors.map((error) => Math.abs(error.position_error)));
  const maxVelocity = Math.max(...errors.map((error) => Math.abs(error.velocity_error)));
  return sanitizeText(`joints=${errors.length}; max_position_error=${formatNumber(maxPosition)}; max_velocity_error=${formatNumber(maxVelocity)}`);
}

function makeSaturationFlag(
  command: PDActuatorCommand,
  type: PDActuatorSaturationFlag["saturation_type"],
  ratio: number,
  action: PDActuatorSaturationFlag["action"],
): PDActuatorSaturationFlag {
  return Object.freeze({
    actuator_ref: command.actuator_ref,
    joint_ref: command.joint_ref,
    saturation_type: type,
    ratio: round6(ratio),
    action,
  });
}

function makeAnomaly(
  type: PDAnomalyType,
  severity: PDAnomalySeverity,
  trigger: string,
  input: PDControlInput,
  telemetryRef: Ref,
  action: PDImmediateControlAction,
): PDAnomalyEvent {
  const anomalyRef = makeRef("pd_anomaly", input.work_order_ref, type, trigger);
  const anomaly = {
    anomaly_ref: anomalyRef,
    anomaly_type: type,
    severity,
    trigger_signal: sanitizeText(trigger),
    active_primitive_ref: input.trajectory.primitive_phase,
    telemetry_refs: freezeArray([telemetryRef]),
    immediate_control_action: action,
    oops_eligible: severity !== "critical",
    human_review_required: severity === "critical" ? true : undefined,
  };
  return Object.freeze({
    ...anomaly,
    determinism_hash: computeDeterminismHash(anomaly),
  });
}

function isOscillating(
  error: PDJointTrackingError,
  previous: readonly PDJointTrackingError[],
  policy: NormalizedPDControlPolicy,
): boolean {
  const history = previous
    .filter((candidate) => candidate.joint_ref === error.joint_ref)
    .sort((a, b) => b.timestamp_s - a.timestamp_s)
    .slice(0, policy.oscillation_history_window);
  if (history.length < 3 || Math.abs(error.position_error) < EPSILON) return false;
  const signs = [error, ...history].map((item) => Math.sign(item.position_error)).filter((sign) => sign !== 0);
  let changes = 0;
  for (let i = 1; i < signs.length; i += 1) {
    if (signs[i] !== signs[i - 1]) changes += 1;
  }
  return changes >= Math.min(3, signs.length - 1);
}

function uniqueAnomalies(values: readonly PDAnomalyEvent[]): readonly PDAnomalyEvent[] {
  const byRef = new Map<Ref, PDAnomalyEvent>();
  for (const value of values) byRef.set(value.anomaly_ref, value);
  return freezeArray([...byRef.values()].sort((a, b) => a.anomaly_ref.localeCompare(b.anomaly_ref)));
}

function buildEmptyState(input: PDControlInput): PDControlState {
  return Object.freeze({
    activeSetpoints: freezeArray([]),
    trackingErrors: freezeArray([]),
    commands: freezeArray([]),
    actuatorLimitReports: freezeArray([]),
    saturationFlags: freezeArray([]),
    anomalies: freezeArray([makeAnomaly("sensor_loss", "error", "pd_input_invalid", input, makeRef("control_telemetry", input.work_order_ref), "pause")]),
    deadlineStatus: "on_time" as const,
  });
}

function validateSafeRef(
  value: Ref,
  path: string,
  code: PDControlIssueCode,
  policy: NormalizedPDControlPolicy,
  issues: ValidationIssue[],
): void {
  if (value.trim().length === 0 || /\s/u.test(value)) {
    issues.push(makeIssue("error", code, path, "Reference must be non-empty and whitespace-free.", "Use an opaque sanitized ref."));
  }
  if (policy.reject_hidden_identifiers && HIDDEN_PD_PATTERN.test(value)) {
    issues.push(makeIssue("error", "HiddenPDLeak", path, "PD control metadata contains hidden simulator/backend/QA wording.", "Strip hidden identifiers before command preparation."));
  }
}

function validateFinite(value: number, path: string, code: PDControlIssueCode, issues: ValidationIssue[]): void {
  if (!Number.isFinite(value)) {
    issues.push(makeIssue("error", code, path, "Numeric value must be finite.", "Use finite SI-unit values."));
  }
}

function mergePolicy(base: NormalizedPDControlPolicy, override: PDControlPolicy): NormalizedPDControlPolicy {
  return Object.freeze({
    control_period_s: positiveOrDefault(override.control_period_s, base.control_period_s),
    max_feedback_age_s: positiveOrDefault(override.max_feedback_age_s, base.max_feedback_age_s),
    nearing_timeout_fraction: clamp01(override.nearing_timeout_fraction ?? base.nearing_timeout_fraction),
    oscillation_history_window: Math.max(1, Math.round(positiveOrDefault(override.oscillation_history_window, base.oscillation_history_window))),
    overshoot_error_multiplier: positiveOrDefault(override.overshoot_error_multiplier, base.overshoot_error_multiplier),
    saturation_warn_ratio: clamp01(override.saturation_warn_ratio ?? base.saturation_warn_ratio),
    safe_hold_on_saturation: override.safe_hold_on_saturation ?? base.safe_hold_on_saturation,
    reject_hidden_identifiers: override.reject_hidden_identifiers ?? base.reject_hidden_identifiers,
  });
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? clamp(value, 0, 1) : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function lerp(a: number, b: number, alpha: number): number {
  return a + (b - a) * alpha;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "") : "invalid";
}

function sanitizeText(value: string): string {
  return value.trim().replace(/\s+/gu, "_").replace(HIDDEN_PD_PATTERN, "hidden-detail").slice(0, 180);
}

function isPDActuatorCommand(value: PDActuatorCommand | undefined): value is PDActuatorCommand {
  return value !== undefined;
}

function isActuatorCommandLimitReport(value: ActuatorCommandLimitReport | undefined): value is ActuatorCommandLimitReport {
  return value !== undefined;
}

function makeIssue(
  severity: ValidationSeverity,
  code: PDControlIssueCode,
  path: string,
  message: string,
  remediation: string,
): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function makeRef(...parts: readonly string[]): Ref {
  const normalized = parts
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "ref:empty";
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}
