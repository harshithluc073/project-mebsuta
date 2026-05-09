/**
 * Physics health monitor for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/03_SIMULATION_AND_PHYSICS_ENGINE_ARCHITECTURE.md`
 * sections 3.3, 3.5, 3.10, 3.13, 3.15, 3.18, 3.19, 3.20, and 3.21.
 *
 * This monitor converts low-level timing, contact, snapshot, synchronization,
 * and replay signals into runtime health warnings and safe-hold triggers. It is
 * a non-cognitive QA/safety service: exact refs, physics hashes, impulses,
 * penetration depths, and solver diagnostics are internal truth and must not be
 * sent to Gemini Robotics-ER 1.6.
 */

import { computeDeterminismHash } from "./world_manifest";
import type { ContactEvent } from "./contact_solver_adapter";
import type { DisturbanceApplicationReport } from "./disturbance_injection_service";
import type { PhysicsStepReport } from "./physics_step_scheduler";
import type { PhysicsSynchronizationReport, SynchronizationIssueCode } from "./physics_state_synchronizer";
import type { ReplayDeterminismReport } from "./replay_recorder";
import type { ObjectRuntimeState, PhysicsWorldSnapshot } from "./simulation_world_service";
import type { Ref, ValidationIssue, ValidationSeverity, Vector3 } from "./world_manifest";

export const PHYSICS_HEALTH_MONITOR_SCHEMA_VERSION = "mebsuta.physics_health_monitor.v1" as const;
const DEFAULT_JITTER_WARNING_MS = 1.25;
const DEFAULT_JITTER_SAFE_HOLD_MS = 4.5;
const DEFAULT_CONTROL_LAG_WARNING_MS = 12;
const DEFAULT_CONTROL_LAG_SAFE_HOLD_MS = 40;
const DEFAULT_SENSOR_SYNC_WARNING_MS = 12;
const DEFAULT_RENDER_DELTA_WARNING_MS = 8;
const DEFAULT_AUDIO_LATENCY_WARNING_MS = 35;
const DEFAULT_PENETRATION_WARNING_M = 0.015;
const DEFAULT_PENETRATION_SAFE_HOLD_M = 0.05;
const DEFAULT_HIGH_IMPULSE_N_S = 2.5;
const DEFAULT_IMPOSSIBLE_IMPULSE_N_S = 7.5;
const DEFAULT_MAX_OBJECT_SPEED_M_PER_S = 8;
const DEFAULT_MAX_ANGULAR_SPEED_RAD_PER_S = 35;

export type PhysicsHealthStatus = "nominal" | "warning" | "degraded" | "safe_hold_required";
export type PhysicsHealthSeverity = "info" | "warning" | "high" | "critical";
export type PhysicsHealthFailureMode =
  | "contact_model_unrealistic"
  | "visualization_diverges_from_physics"
  | "physics_timestep_jitter"
  | "solver_divergence"
  | "debug_overlay_leak"
  | "undeclared_or_blocked_sensor_output"
  | "disturbance_too_severe"
  | "replay_mismatch"
  | "qa_truth_contamination"
  | "acoustic_source_id_leak"
  | "sensor_desynchronization"
  | "control_lag";
export type PhysicsHealthIssueCode =
  | "TimingJitterExceeded"
  | "ControlLagExceeded"
  | "SensorSyncSpreadTooLarge"
  | "RenderPhysicsMismatch"
  | "AudioTimingMismatch"
  | "ImpossibleImpulse"
  | "PenetrationExceeded"
  | "SolverDivergence"
  | "SnapshotInvalid"
  | "ReplayMismatch"
  | "QATruthContamination"
  | "DebugOverlayDetected"
  | "SourceRefNotRedacted"
  | "DisturbancePolicyViolation"
  | "PacketHealthBlocked";

export interface PhysicsHealthPolicy {
  readonly jitter_warning_ms: number;
  readonly jitter_safe_hold_ms: number;
  readonly control_lag_warning_ms: number;
  readonly control_lag_safe_hold_ms: number;
  readonly sensor_sync_warning_ms: number;
  readonly render_delta_warning_ms: number;
  readonly audio_latency_warning_ms: number;
  readonly penetration_warning_m: number;
  readonly penetration_safe_hold_m: number;
  readonly high_impulse_n_s: number;
  readonly impossible_impulse_n_s: number;
  readonly max_object_speed_m_per_s: number;
  readonly max_angular_speed_rad_per_s: number;
  readonly safe_hold_on_solver_divergence: boolean;
  readonly safe_hold_on_debug_overlay_leak: boolean;
  readonly safe_hold_on_qa_truth_contamination: boolean;
  readonly safe_hold_on_replay_mismatch: boolean;
}

export interface PhysicsHealthMonitorInput {
  readonly world_snapshot?: PhysicsWorldSnapshot;
  readonly step_reports?: readonly PhysicsStepReport[];
  readonly contact_events?: readonly ContactEvent[];
  readonly synchronization_reports?: readonly PhysicsSynchronizationReport[];
  readonly disturbance_reports?: readonly DisturbanceApplicationReport[];
  readonly replay_reports?: readonly ReplayDeterminismReport[];
  readonly qa_truth_destination_refs?: readonly Ref[];
  readonly policy?: Partial<PhysicsHealthPolicy>;
}

export interface PhysicsHealthMetricSnapshot {
  readonly max_jitter_ms: number;
  readonly max_control_lag_ms: number;
  readonly max_sensor_sync_spread_ms: number;
  readonly max_render_delta_ms: number;
  readonly max_audio_latency_ms: number;
  readonly max_contact_impulse_n_s: number;
  readonly max_penetration_depth_m: number;
  readonly max_object_speed_m_per_s: number;
  readonly max_angular_speed_rad_per_s: number;
  readonly dropped_step_count: number;
  readonly replay_mismatch_count: number;
  readonly blocked_sensor_packet_count: number;
  readonly determinism_hash: string;
}

export interface PhysicsHealthWarning {
  readonly warning_id: Ref;
  readonly failure_mode: PhysicsHealthFailureMode;
  readonly severity: PhysicsHealthSeverity;
  readonly issue_code: PhysicsHealthIssueCode;
  readonly source_ref: Ref;
  readonly detection_signal: string;
  readonly guardrail: string;
  readonly escalation: "none" | "monitor" | "recapture" | "safe_hold" | "qa_postmortem" | "firewall_incident";
  readonly safe_hold_required: boolean;
  readonly determinism_hash: string;
}

export interface PhysicsSafeHoldTrigger {
  readonly trigger_ref: Ref;
  readonly failure_mode: PhysicsHealthFailureMode;
  readonly source_warning_ref: Ref;
  readonly source_ref: Ref;
  readonly reason: string;
  readonly recommended_action: "pause_control" | "freeze_verification" | "quarantine_packet" | "qa_postmortem" | "human_review";
  readonly determinism_hash: string;
}

export interface PhysicsHealthReport {
  readonly schema_version: typeof PHYSICS_HEALTH_MONITOR_SCHEMA_VERSION;
  readonly report_ref: Ref;
  readonly health_status: PhysicsHealthStatus;
  readonly generated_for_world_ref?: Ref;
  readonly physics_tick?: number;
  readonly metric_snapshot: PhysicsHealthMetricSnapshot;
  readonly warnings: readonly PhysicsHealthWarning[];
  readonly safe_hold_triggers: readonly PhysicsSafeHoldTrigger[];
  readonly issue_count: number;
  readonly issues: readonly ValidationIssue[];
  readonly cognitive_visibility: "runtime_qa_validator_only";
  readonly determinism_hash: string;
}

export interface CognitiveSafePhysicsHealthSummary {
  readonly health_status: PhysicsHealthStatus;
  readonly safe_hold_required: boolean;
  readonly runtime_summary: "nominal" | "monitor_timing" | "recapture_sensors" | "safe_hold";
  readonly prompt_safe_summary: string;
  readonly hidden_fields_removed: readonly string[];
}

export class PhysicsHealthMonitorError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "PhysicsHealthMonitorError";
    this.issues = issues;
  }
}

/**
 * Aggregates physics health signals across one or more runtime boundaries.
 */
export class PhysicsHealthMonitor {
  private readonly defaultPolicy: PhysicsHealthPolicy;

  public constructor(defaultPolicy: Partial<PhysicsHealthPolicy> = {}) {
    this.defaultPolicy = mergePolicy(defaultPolicy);
  }

  public evaluatePhysicsHealth(input: PhysicsHealthMonitorInput): PhysicsHealthReport {
    const policy = mergePolicy({ ...this.defaultPolicy, ...(input.policy ?? {}) });
    validatePolicy(policy);
    const issues = validateInput(input);
    const warnings = [
      ...this.evaluateSnapshot(input.world_snapshot, policy),
      ...this.evaluateStepReports(input.step_reports ?? [], policy),
      ...this.evaluateContactEvents(input.contact_events ?? [], policy),
      ...this.evaluateSynchronizationReports(input.synchronization_reports ?? [], policy),
      ...this.evaluateDisturbanceReports(input.disturbance_reports ?? []),
      ...this.evaluateReplayReports(input.replay_reports ?? [], policy),
      ...this.evaluateQaTruthDestinations(input.qa_truth_destination_refs ?? [], policy),
    ].sort(compareWarnings);
    const safeHoldTriggers = warnings.filter((warning) => warning.safe_hold_required).map(createSafeHoldTrigger);
    const metricSnapshot = buildMetricSnapshot(input);
    const healthStatus = classifyHealthStatus(warnings, issues);
    const reportBase = {
      schema_version: PHYSICS_HEALTH_MONITOR_SCHEMA_VERSION,
      report_ref: `physics_health_${input.world_snapshot?.world_ref ?? "unknown_world"}_${input.world_snapshot?.physics_tick ?? "no_tick"}`,
      health_status: healthStatus,
      generated_for_world_ref: input.world_snapshot?.world_ref,
      physics_tick: input.world_snapshot?.physics_tick,
      metric_snapshot: metricSnapshot,
      warnings: freezeArray(warnings),
      safe_hold_triggers: freezeArray(safeHoldTriggers),
      issue_count: issues.length,
      issues: freezeArray(issues),
      cognitive_visibility: "runtime_qa_validator_only" as const,
    };
    return Object.freeze({
      ...reportBase,
      determinism_hash: computeDeterminismHash(reportBase),
    });
  }

  public assertNoSafeHold(report: PhysicsHealthReport): void {
    if (report.safe_hold_triggers.length > 0 || report.health_status === "safe_hold_required") {
      throw new PhysicsHealthMonitorError("Physics health monitor requested safe-hold.", report.issues);
    }
  }

  public redactForCognition(report: PhysicsHealthReport): CognitiveSafePhysicsHealthSummary {
    const safeHoldRequired = report.safe_hold_triggers.length > 0;
    const runtimeSummary: CognitiveSafePhysicsHealthSummary["runtime_summary"] = safeHoldRequired
      ? "safe_hold"
      : report.warnings.some((warning) => warning.failure_mode === "sensor_desynchronization" || warning.failure_mode === "visualization_diverges_from_physics")
        ? "recapture_sensors"
        : report.warnings.some((warning) => warning.failure_mode === "physics_timestep_jitter" || warning.failure_mode === "control_lag")
          ? "monitor_timing"
          : "nominal";
    return Object.freeze({
      health_status: report.health_status,
      safe_hold_required: safeHoldRequired,
      runtime_summary: runtimeSummary,
      prompt_safe_summary: promptSafeSummary(runtimeSummary),
      hidden_fields_removed: freezeArray([
        "report_ref",
        "generated_for_world_ref",
        "physics_tick",
        "metric_snapshot",
        "source_ref",
        "exact_impulse",
        "exact_penetration",
        "determinism_hash",
        "safe_hold_trigger_refs",
      ]),
    });
  }

  private evaluateSnapshot(snapshot: PhysicsWorldSnapshot | undefined, policy: PhysicsHealthPolicy): readonly PhysicsHealthWarning[] {
    if (snapshot === undefined) {
      return freezeArray([]);
    }
    const warnings: PhysicsHealthWarning[] = [];
    for (const object of snapshot.object_states) {
      const invalid = hasInvalidObjectState(object);
      if (invalid) {
        warnings.push(warning("solver_divergence", "critical", "SolverDivergence", object.object_ref, "Object state contains non-finite transform or velocity.", "Immediate safe-hold on solver divergence.", "qa_postmortem", policy.safe_hold_on_solver_divergence));
        continue;
      }
      const speed = vectorNorm(object.linear_velocity_m_per_s);
      const angularSpeed = vectorNorm(object.angular_velocity_rad_per_s);
      if (speed > policy.max_object_speed_m_per_s || angularSpeed > policy.max_angular_speed_rad_per_s) {
        warnings.push(warning("solver_divergence", "critical", "SolverDivergence", object.object_ref, "Object velocity exceeds configured physical envelope.", "Immediate safe-hold on exploding velocity.", "qa_postmortem", policy.safe_hold_on_solver_divergence));
      }
    }
    return freezeArray(warnings);
  }

  private evaluateStepReports(reports: readonly PhysicsStepReport[], policy: PhysicsHealthPolicy): readonly PhysicsHealthWarning[] {
    const warnings: PhysicsHealthWarning[] = [];
    for (const report of reports) {
      const timing = report.timing_health;
      if (timing.jitter_status === "safe_hold_required" || timing.jitter_ms >= policy.jitter_safe_hold_ms || timing.dropped_step_count > 0) {
        warnings.push(warning("physics_timestep_jitter", "high", "TimingJitterExceeded", report.step_report_id, "Physics step duration exceeded safe-hold threshold or dropped steps.", "Fixed-step health monitor requests safe-hold if control is affected.", "safe_hold", true));
      } else if (timing.jitter_status === "warning" || timing.jitter_ms >= policy.jitter_warning_ms) {
        warnings.push(warning("physics_timestep_jitter", "warning", "TimingJitterExceeded", report.step_report_id, "Physics step jitter exceeded warning threshold.", "Mark simulation health warning and monitor timing.", "monitor", false));
      }
      if (timing.control_lag_ms >= policy.control_lag_safe_hold_ms) {
        warnings.push(warning("control_lag", "high", "ControlLagExceeded", report.step_report_id, "Control lag exceeded safe-hold threshold.", "Pause control until command timing is healthy.", "safe_hold", true));
      } else if (timing.control_lag_ms >= policy.control_lag_warning_ms) {
        warnings.push(warning("control_lag", "warning", "ControlLagExceeded", report.step_report_id, "Control lag exceeded warning threshold.", "Monitor control latency before issuing more motion.", "monitor", false));
      }
    }
    return freezeArray(warnings);
  }

  private evaluateContactEvents(events: readonly ContactEvent[], policy: PhysicsHealthPolicy): readonly PhysicsHealthWarning[] {
    const warnings: PhysicsHealthWarning[] = [];
    for (const event of events) {
      const impulse = event.impulse_summary.normal_impulse_n_s;
      const penetration = event.impulse_summary.peak_penetration_depth_m;
      if (event.impulse_summary.impulse_category === "impossible" || impulse >= policy.impossible_impulse_n_s) {
        warnings.push(warning("solver_divergence", "critical", "ImpossibleImpulse", event.contact_event_id, "Contact impulse is physically impossible for the configured envelope.", "Immediate safe-hold on impossible impulse.", "qa_postmortem", true));
      } else if (impulse >= policy.high_impulse_n_s || event.safety_relevance === "safe_hold") {
        warnings.push(warning("solver_divergence", "high", "ImpossibleImpulse", event.contact_event_id, "High-energy contact requires safety review.", "Safe-hold if contact can affect control stability.", "safe_hold", event.safety_relevance === "safe_hold"));
      }
      if (penetration >= policy.penetration_safe_hold_m) {
        warnings.push(warning("solver_divergence", "critical", "PenetrationExceeded", event.contact_event_id, "Contact penetration exceeded solver divergence threshold.", "Immediate safe-hold and QA postmortem.", "qa_postmortem", true));
      } else if (penetration >= policy.penetration_warning_m) {
        warnings.push(warning("contact_model_unrealistic", "warning", "PenetrationExceeded", event.contact_event_id, "Contact penetration exceeded realism warning threshold.", "Flag scenario for material/contact calibration.", "monitor", false));
      }
      if (event.friction_diagnostic.regime === "dynamic_sliding" && event.contact_class === "resting_support") {
        warnings.push(warning("contact_model_unrealistic", "warning", "PenetrationExceeded", event.contact_event_id, "Resting support contact is sliding outside the static friction envelope.", "Flag contact model calibration before benchmark use.", "monitor", false));
      }
    }
    return freezeArray(warnings);
  }

  private evaluateSynchronizationReports(reports: readonly PhysicsSynchronizationReport[], policy: PhysicsHealthPolicy): readonly PhysicsHealthWarning[] {
    const warnings: PhysicsHealthWarning[] = [];
    for (const report of reports) {
      if (report.synchronization_status === "blocked" || report.blocked_packet_refs.length > 0) {
        warnings.push(warning("sensor_desynchronization", "high", "PacketHealthBlocked", report.report_ref, "Synchronized packet bundle contains blocked packets.", "Block sensor packet and recapture.", "recapture", false));
      }
      if (report.sensor_sync_spread_ms >= policy.sensor_sync_warning_ms) {
        warnings.push(warning("sensor_desynchronization", "warning", "SensorSyncSpreadTooLarge", report.report_ref, "Sensor timestamp spread exceeded health threshold.", "Mark bundle degraded or recapture.", "recapture", false));
      }
      if (report.render_physics_delta_ms >= policy.render_delta_warning_ms) {
        warnings.push(warning("visualization_diverges_from_physics", "high", "RenderPhysicsMismatch", report.report_ref, "Render packet timing diverged from physics snapshot.", "Freeze verification and investigate render/physics sync.", "recapture", false));
      }
      if (report.audio_event_latency_ms >= policy.audio_latency_warning_ms) {
        warnings.push(warning("sensor_desynchronization", "warning", "AudioTimingMismatch", report.report_ref, "Audio event latency exceeded health threshold.", "Lower audio confidence or regenerate microphone packet.", "monitor", false));
      }
      for (const issue of report.issues) {
        const code = issue.code as SynchronizationIssueCode;
        if (code === "DebugOverlayDetected") {
          warnings.push(warning("debug_overlay_leak", "critical", "DebugOverlayDetected", report.report_ref, "Debug overlay was detected in a cognitive-bound render path.", "Block cognitive frame and repair render policy.", "firewall_incident", policy.safe_hold_on_debug_overlay_leak));
        }
        if (code === "AudioSourceRefLeak") {
          warnings.push(warning("acoustic_source_id_leak", "high", "SourceRefNotRedacted", report.report_ref, "Audio packet retained backend source refs.", "Strip or reject packet before cognitive routing.", "firewall_incident", false));
        }
        if (code === "RenderPhysicsMismatch") {
          warnings.push(warning("visualization_diverges_from_physics", "high", "RenderPhysicsMismatch", report.report_ref, "Synchronizer reported render/physics mismatch.", "Freeze verification and investigate.", "recapture", false));
        }
      }
    }
    return freezeArray(warnings);
  }

  private evaluateDisturbanceReports(reports: readonly DisturbanceApplicationReport[]): readonly PhysicsHealthWarning[] {
    const warnings: PhysicsHealthWarning[] = [];
    for (const report of reports) {
      if (report.safe_hold_required) {
        warnings.push(warning("disturbance_too_severe", "high", "DisturbancePolicyViolation", report.report_ref, "Disturbance report requested safe-hold.", "Reject or safe-hold and route to QA review.", "safe_hold", true));
      }
      for (const rejected of report.rejected_disturbances) {
        warnings.push(warning("disturbance_too_severe", "warning", "DisturbancePolicyViolation", `${report.report_ref}_${rejected.disturbance_id}`, rejected.message, "Review disturbance schedule authorization and safety policy.", "monitor", false));
      }
    }
    return freezeArray(warnings);
  }

  private evaluateReplayReports(reports: readonly ReplayDeterminismReport[], policy: PhysicsHealthPolicy): readonly PhysicsHealthWarning[] {
    return freezeArray(reports
      .filter((report) => report.comparison_status !== "match")
      .map((report) => warning("replay_mismatch", report.comparison_status === "mismatch" ? "high" : "warning", "ReplayMismatch", report.determinism_report_ref, "Replay determinism markers diverged or trace is incomplete.", "Mark replay invalid and investigate timing or nondeterminism.", "qa_postmortem", policy.safe_hold_on_replay_mismatch && report.comparison_status === "mismatch")));
  }

  private evaluateQaTruthDestinations(destinations: readonly Ref[], policy: PhysicsHealthPolicy): readonly PhysicsHealthWarning[] {
    return freezeArray(destinations
      .filter((destination) => !["qa_report", "developer_debug", "regression_harness"].includes(destination))
      .map((destination) => warning("qa_truth_contamination", "critical", "QATruthContamination", destination, "QA truth destination is not isolated.", "Quarantine and safe-hold if active.", "firewall_incident", policy.safe_hold_on_qa_truth_contamination)));
  }
}

export function evaluatePhysicsHealth(input: PhysicsHealthMonitorInput): PhysicsHealthReport {
  return new PhysicsHealthMonitor(input.policy).evaluatePhysicsHealth(input);
}

function buildMetricSnapshot(input: PhysicsHealthMonitorInput): PhysicsHealthMetricSnapshot {
  const stepReports = input.step_reports ?? [];
  const contacts = input.contact_events ?? [];
  const syncReports = input.synchronization_reports ?? [];
  const snapshotObjects = input.world_snapshot?.object_states ?? [];
  const metricBase = {
    max_jitter_ms: round3(maxOrZero(stepReports.map((report) => report.timing_health.jitter_ms))),
    max_control_lag_ms: round3(Math.max(maxOrZero(stepReports.map((report) => report.timing_health.control_lag_ms)), maxOrZero(syncReports.map((report) => report.control_lag_ms)))),
    max_sensor_sync_spread_ms: round3(Math.max(maxOrZero(stepReports.map((report) => report.timing_health.sensor_sync_spread_ms)), maxOrZero(syncReports.map((report) => report.sensor_sync_spread_ms)))),
    max_render_delta_ms: round3(Math.max(maxOrZero(stepReports.map((report) => report.timing_health.render_physics_delta_ms)), maxOrZero(syncReports.map((report) => report.render_physics_delta_ms)))),
    max_audio_latency_ms: round3(Math.max(maxOrZero(stepReports.map((report) => report.timing_health.audio_event_latency_ms)), maxOrZero(syncReports.map((report) => report.audio_event_latency_ms)))),
    max_contact_impulse_n_s: round6(maxOrZero(contacts.map((event) => event.impulse_summary.normal_impulse_n_s))),
    max_penetration_depth_m: round6(maxOrZero(contacts.map((event) => event.impulse_summary.peak_penetration_depth_m))),
    max_object_speed_m_per_s: round6(maxOrZero(snapshotObjects.map((object) => vectorNorm(object.linear_velocity_m_per_s)))),
    max_angular_speed_rad_per_s: round6(maxOrZero(snapshotObjects.map((object) => vectorNorm(object.angular_velocity_rad_per_s)))),
    dropped_step_count: stepReports.reduce((sum, report) => sum + report.timing_health.dropped_step_count, 0),
    replay_mismatch_count: (input.replay_reports ?? []).filter((report) => report.comparison_status !== "match").length,
    blocked_sensor_packet_count: syncReports.reduce((sum, report) => sum + report.blocked_packet_refs.length, 0),
  };
  return Object.freeze({
    ...metricBase,
    determinism_hash: computeDeterminismHash(metricBase),
  });
}

function createSafeHoldTrigger(source: PhysicsHealthWarning): PhysicsSafeHoldTrigger {
  const triggerBase = {
    trigger_ref: `safe_hold_${source.warning_id}`,
    failure_mode: source.failure_mode,
    source_warning_ref: source.warning_id,
    source_ref: source.source_ref,
    reason: source.detection_signal,
    recommended_action: recommendedAction(source),
  };
  return Object.freeze({
    ...triggerBase,
    determinism_hash: computeDeterminismHash(triggerBase),
  });
}

function warning(
  failureMode: PhysicsHealthFailureMode,
  severity: PhysicsHealthSeverity,
  issueCode: PhysicsHealthIssueCode,
  sourceRef: Ref,
  detectionSignal: string,
  guardrail: string,
  escalation: PhysicsHealthWarning["escalation"],
  safeHoldRequired: boolean,
): PhysicsHealthWarning {
  const warningBase = {
    warning_id: `health_${issueCode}_${computeDeterminismHash([failureMode, sourceRef, detectionSignal]).slice(0, 10)}`,
    failure_mode: failureMode,
    severity,
    issue_code: issueCode,
    source_ref: sourceRef,
    detection_signal: detectionSignal,
    guardrail,
    escalation,
    safe_hold_required: safeHoldRequired,
  };
  return Object.freeze({
    ...warningBase,
    determinism_hash: computeDeterminismHash(warningBase),
  });
}

function recommendedAction(warning: PhysicsHealthWarning): PhysicsSafeHoldTrigger["recommended_action"] {
  if (warning.failure_mode === "visualization_diverges_from_physics" || warning.failure_mode === "sensor_desynchronization") {
    return "freeze_verification";
  }
  if (warning.failure_mode === "debug_overlay_leak" || warning.failure_mode === "qa_truth_contamination" || warning.failure_mode === "acoustic_source_id_leak") {
    return "quarantine_packet";
  }
  if (warning.failure_mode === "solver_divergence" || warning.failure_mode === "replay_mismatch") {
    return "qa_postmortem";
  }
  if (warning.failure_mode === "control_lag" || warning.failure_mode === "physics_timestep_jitter") {
    return "pause_control";
  }
  return "human_review";
}

function classifyHealthStatus(warnings: readonly PhysicsHealthWarning[], issues: readonly ValidationIssue[]): PhysicsHealthStatus {
  if (warnings.some((warningItem) => warningItem.safe_hold_required || warningItem.severity === "critical") || issues.some((issue) => issue.severity === "error")) {
    return "safe_hold_required";
  }
  if (warnings.some((warningItem) => warningItem.severity === "high")) {
    return "degraded";
  }
  if (warnings.length > 0 || issues.length > 0) {
    return "warning";
  }
  return "nominal";
}

function validateInput(input: PhysicsHealthMonitorInput): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (input.world_snapshot !== undefined) {
    if (!Number.isInteger(input.world_snapshot.physics_tick) || input.world_snapshot.physics_tick < 0) {
      issues.push(makeIssue("error", "SnapshotInvalid", "$.world_snapshot.physics_tick", "Physics snapshot tick must be a nonnegative integer.", "Use a SimulationWorldService snapshot."));
    }
    if (input.world_snapshot.cognitive_visibility !== "forbidden_to_cognition") {
      issues.push(makeIssue("error", "QATruthContamination", "$.world_snapshot.cognitive_visibility", "Physics snapshots must remain forbidden to cognition.", "Route only sensor evidence through the firewall."));
    }
  }
  return freezeArray(issues);
}

function hasInvalidObjectState(object: ObjectRuntimeState): boolean {
  return !vectorFinite(object.transform.position_m)
    || !vectorFinite(object.linear_velocity_m_per_s)
    || !vectorFinite(object.angular_velocity_rad_per_s)
    || object.transform.orientation_xyzw.some((value) => !Number.isFinite(value));
}

function mergePolicy(input: Partial<PhysicsHealthPolicy>): PhysicsHealthPolicy {
  return Object.freeze({
    jitter_warning_ms: input.jitter_warning_ms ?? DEFAULT_JITTER_WARNING_MS,
    jitter_safe_hold_ms: input.jitter_safe_hold_ms ?? DEFAULT_JITTER_SAFE_HOLD_MS,
    control_lag_warning_ms: input.control_lag_warning_ms ?? DEFAULT_CONTROL_LAG_WARNING_MS,
    control_lag_safe_hold_ms: input.control_lag_safe_hold_ms ?? DEFAULT_CONTROL_LAG_SAFE_HOLD_MS,
    sensor_sync_warning_ms: input.sensor_sync_warning_ms ?? DEFAULT_SENSOR_SYNC_WARNING_MS,
    render_delta_warning_ms: input.render_delta_warning_ms ?? DEFAULT_RENDER_DELTA_WARNING_MS,
    audio_latency_warning_ms: input.audio_latency_warning_ms ?? DEFAULT_AUDIO_LATENCY_WARNING_MS,
    penetration_warning_m: input.penetration_warning_m ?? DEFAULT_PENETRATION_WARNING_M,
    penetration_safe_hold_m: input.penetration_safe_hold_m ?? DEFAULT_PENETRATION_SAFE_HOLD_M,
    high_impulse_n_s: input.high_impulse_n_s ?? DEFAULT_HIGH_IMPULSE_N_S,
    impossible_impulse_n_s: input.impossible_impulse_n_s ?? DEFAULT_IMPOSSIBLE_IMPULSE_N_S,
    max_object_speed_m_per_s: input.max_object_speed_m_per_s ?? DEFAULT_MAX_OBJECT_SPEED_M_PER_S,
    max_angular_speed_rad_per_s: input.max_angular_speed_rad_per_s ?? DEFAULT_MAX_ANGULAR_SPEED_RAD_PER_S,
    safe_hold_on_solver_divergence: input.safe_hold_on_solver_divergence ?? true,
    safe_hold_on_debug_overlay_leak: input.safe_hold_on_debug_overlay_leak ?? true,
    safe_hold_on_qa_truth_contamination: input.safe_hold_on_qa_truth_contamination ?? true,
    safe_hold_on_replay_mismatch: input.safe_hold_on_replay_mismatch ?? false,
  });
}

function validatePolicy(policy: PhysicsHealthPolicy): void {
  const issues: ValidationIssue[] = [];
  validateNonNegative(policy.jitter_warning_ms, issues, "$.policy.jitter_warning_ms");
  validateNonNegative(policy.jitter_safe_hold_ms, issues, "$.policy.jitter_safe_hold_ms");
  validateNonNegative(policy.control_lag_warning_ms, issues, "$.policy.control_lag_warning_ms");
  validateNonNegative(policy.control_lag_safe_hold_ms, issues, "$.policy.control_lag_safe_hold_ms");
  validateNonNegative(policy.sensor_sync_warning_ms, issues, "$.policy.sensor_sync_warning_ms");
  validateNonNegative(policy.render_delta_warning_ms, issues, "$.policy.render_delta_warning_ms");
  validateNonNegative(policy.audio_latency_warning_ms, issues, "$.policy.audio_latency_warning_ms");
  validateNonNegative(policy.penetration_warning_m, issues, "$.policy.penetration_warning_m");
  validateNonNegative(policy.penetration_safe_hold_m, issues, "$.policy.penetration_safe_hold_m");
  validateNonNegative(policy.high_impulse_n_s, issues, "$.policy.high_impulse_n_s");
  validateNonNegative(policy.impossible_impulse_n_s, issues, "$.policy.impossible_impulse_n_s");
  validateNonNegative(policy.max_object_speed_m_per_s, issues, "$.policy.max_object_speed_m_per_s");
  validateNonNegative(policy.max_angular_speed_rad_per_s, issues, "$.policy.max_angular_speed_rad_per_s");
  if (policy.jitter_warning_ms > policy.jitter_safe_hold_ms) {
    issues.push(makeIssue("error", "TimingJitterExceeded", "$.policy", "Jitter warning threshold cannot exceed safe-hold threshold.", "Raise safe-hold threshold or lower warning threshold."));
  }
  if (policy.control_lag_warning_ms > policy.control_lag_safe_hold_ms) {
    issues.push(makeIssue("error", "ControlLagExceeded", "$.policy", "Control-lag warning threshold cannot exceed safe-hold threshold.", "Raise safe-hold threshold or lower warning threshold."));
  }
  if (policy.penetration_warning_m > policy.penetration_safe_hold_m) {
    issues.push(makeIssue("error", "PenetrationExceeded", "$.policy", "Penetration warning threshold cannot exceed safe-hold threshold.", "Raise safe-hold threshold or lower warning threshold."));
  }
  if (policy.high_impulse_n_s > policy.impossible_impulse_n_s) {
    issues.push(makeIssue("error", "ImpossibleImpulse", "$.policy", "High impulse threshold cannot exceed impossible impulse threshold.", "Raise impossible impulse threshold or lower high impulse threshold."));
  }
  if (issues.some((issue) => issue.severity === "error")) {
    throw new PhysicsHealthMonitorError("Physics health policy failed validation.", issues);
  }
}

function validateNonNegative(value: number, issues: ValidationIssue[], path: string): void {
  if (!Number.isFinite(value) || value < 0) {
    issues.push(makeIssue("error", "SolverDivergence", path, "Policy value must be nonnegative and finite.", "Use a calibrated finite nonnegative threshold."));
  }
}

function makeIssue(severity: ValidationSeverity, code: PhysicsHealthIssueCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function promptSafeSummary(summary: CognitiveSafePhysicsHealthSummary["runtime_summary"]): string {
  if (summary === "safe_hold") {
    return "Runtime physics health requires safe-hold before continuing.";
  }
  if (summary === "recapture_sensors") {
    return "Sensor timing or visualization health is degraded; recapture current evidence.";
  }
  if (summary === "monitor_timing") {
    return "Physics timing margin is low; continue only with monitoring.";
  }
  return "Physics health is nominal.";
}

function compareWarnings(a: PhysicsHealthWarning, b: PhysicsHealthWarning): number {
  return severityRank(b.severity) - severityRank(a.severity) || a.warning_id.localeCompare(b.warning_id);
}

function severityRank(severity: PhysicsHealthSeverity): number {
  if (severity === "critical") {
    return 4;
  }
  if (severity === "high") {
    return 3;
  }
  if (severity === "warning") {
    return 2;
  }
  return 1;
}

function vectorNorm(value: Vector3): number {
  return Math.sqrt(value[0] * value[0] + value[1] * value[1] + value[2] * value[2]);
}

function vectorFinite(value: Vector3): boolean {
  return value.every((component) => Number.isFinite(component));
}

function maxOrZero(values: readonly number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function round6(value: number): number {
  return Math.round(value * 1000000) / 1000000;
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}
