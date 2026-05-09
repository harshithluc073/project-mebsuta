/**
 * Disturbance injection service for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/03_SIMULATION_AND_PHYSICS_ENGINE_ARCHITECTURE.md`
 * sections 3.3, 3.5, 3.10, 3.14, 3.15, 3.17.6, 3.18.4, 3.19, and 3.20.
 *
 * This service selects scheduled, QA-authorized disturbances and converts them
 * into deterministic simulation effects: friction overrides, object pose and
 * velocity perturbations, audio emitters, sensor degradations, API timing
 * delays, physics anomaly records, replay markers, and safe-hold requests. The
 * disturbance script remains QA/replay-only; cognitive callers may receive only
 * sanitized effect summaries through `redactDisturbanceReportForCognition`.
 */

import { computeDeterminismHash } from "./world_manifest";
import type { MovementAcousticEvent } from "./acoustic_world_service";
import type { PhysicsWorldSnapshot } from "./simulation_world_service";
import type {
  DisturbanceEvent,
  DisturbanceSchedule,
  DisturbanceType,
  Quaternion,
  Ref,
  ReplaySeed,
  SafetyPolicy,
  Transform,
  ValidationIssue,
  ValidationSeverity,
  Vector3,
  WorldBounds,
} from "./world_manifest";

export const DISTURBANCE_INJECTION_SERVICE_SCHEMA_VERSION = "mebsuta.disturbance_injection_service.v1" as const;
const DEFAULT_SAFE_HOLD_IMPULSE_N_S = 6.5;
const DEFAULT_WARNING_IMPULSE_N_S = 2.5;
const DEFAULT_MAX_OBJECT_NUDGE_M = 0.35;
const DEFAULT_API_DELAY_MS = 750;
const DEFAULT_SENSOR_DROP_WINDOW_S = 0.12;
const DEFAULT_SLIP_FRICTION_SCALE = 0.28;
const DEFAULT_DROP_HEIGHT_M = 0.45;
const DEFAULT_OCCLUDER_SHIFT_M = 0.6;
const DEFAULT_AUDIO_SPEED_M_PER_S = 0.35;
const IDENTITY_QUATERNION: Quaternion = [0, 0, 0, 1];
const ZERO_VECTOR: Vector3 = [0, 0, 0];

export type DisturbanceTimingStatus = "due" | "future" | "missed";
export type DisturbanceApplicationStatus = "applied" | "deferred" | "rejected" | "safe_hold_required";
export type DisturbanceSeverity = "low" | "medium" | "high" | "critical";
export type DisturbanceEffectKind =
  | "friction_override"
  | "object_transform_patch"
  | "object_velocity_delta"
  | "occlusion_pose"
  | "audio_movement_event"
  | "physics_anomaly"
  | "sensor_fault"
  | "api_timing_delay";
export type SensorFaultKind = "drop_frame" | "noise_burst" | "latency_spike" | "occlusion_mask" | "missing_packet";
export type PhysicsAnomalyKind = "impossible_impulse" | "solver_jitter" | "penetration_spike" | "contact_glitch";
export type DisturbanceValidationCode =
  | "DisturbanceNotScheduled"
  | "DisturbanceUnauthorized"
  | "TargetUnavailable"
  | "SafetyPolicyViolation"
  | "ReplayMismatch"
  | "DisturbanceTooSevere"
  | "ScheduleInvalid"
  | "RuntimeStateInvalid"
  | "SnapshotInvalid";

export interface DisturbanceRuntimeState {
  readonly current_tick: number;
  readonly current_time_s: number;
  readonly active_task_ref?: Ref;
  readonly safety_mode: "normal" | "reduced_speed" | "safe_hold" | "emergency_stop";
  readonly qa_authorized_disturbance_ids?: readonly Ref[];
  readonly active_sensor_refs?: readonly Ref[];
}

export interface DisturbanceSafetyPolicy {
  readonly allow_unscheduled_disturbances: boolean;
  readonly allow_physics_glitch: boolean;
  readonly allow_api_timing_delay: boolean;
  readonly max_allowed_severity: DisturbanceSeverity;
  readonly safe_hold_on_high_severity: boolean;
  readonly safe_hold_impulse_threshold_n_s: number;
  readonly warning_impulse_threshold_n_s: number;
  readonly max_object_nudge_m: number;
  readonly max_api_delay_ms: number;
  readonly sensor_fault_window_s: number;
  readonly require_replay_seed_match: boolean;
}

export interface FrictionOverrideEffect {
  readonly effect_kind: "friction_override";
  readonly target_refs: readonly Ref[];
  readonly static_friction_scale: number;
  readonly dynamic_friction_scale: number;
  readonly duration_s: number;
}

export interface ObjectTransformPatchEffect {
  readonly effect_kind: "object_transform_patch";
  readonly object_ref: Ref;
  readonly original_transform: Transform;
  readonly disturbed_transform: Transform;
  readonly displacement_m: Vector3;
}

export interface ObjectVelocityDeltaEffect {
  readonly effect_kind: "object_velocity_delta";
  readonly object_ref: Ref;
  readonly linear_velocity_delta_m_per_s: Vector3;
  readonly angular_velocity_delta_rad_per_s: Vector3;
}

export interface OcclusionPoseEffect {
  readonly effect_kind: "occlusion_pose";
  readonly occluder_ref: Ref;
  readonly original_transform: Transform;
  readonly occlusion_transform: Transform;
  readonly expected_visual_effect: "partial_camera_occlusion" | "full_camera_occlusion" | "view_clutter";
}

export interface AudioMovementEffect {
  readonly effect_kind: "audio_movement_event";
  readonly movement_event: MovementAcousticEvent;
}

export interface PhysicsAnomalyEffect {
  readonly effect_kind: "physics_anomaly";
  readonly anomaly_kind: PhysicsAnomalyKind;
  readonly target_refs: readonly Ref[];
  readonly impulse_n_s: Vector3;
  readonly estimated_severity: DisturbanceSeverity;
}

export interface SensorFaultEffect {
  readonly effect_kind: "sensor_fault";
  readonly sensor_ref: Ref;
  readonly fault_kind: SensorFaultKind;
  readonly start_time_s: number;
  readonly end_time_s: number;
  readonly degradation_level: "minor" | "moderate" | "severe";
}

export interface ApiTimingDelayEffect {
  readonly effect_kind: "api_timing_delay";
  readonly affected_component_ref: Ref;
  readonly delay_ms: number;
  readonly expected_runtime_response: "continue" | "pause" | "safe_hold";
}

export type DisturbanceEffect =
  | FrictionOverrideEffect
  | ObjectTransformPatchEffect
  | ObjectVelocityDeltaEffect
  | OcclusionPoseEffect
  | AudioMovementEffect
  | PhysicsAnomalyEffect
  | SensorFaultEffect
  | ApiTimingDelayEffect;

export interface ReplayDisturbanceMarker {
  readonly replay_marker_ref: Ref;
  readonly disturbance_id: Ref;
  readonly replay_seed_ref?: Ref;
  readonly rng_draws: readonly number[];
  readonly physics_tick: number;
  readonly timestamp_s: number;
  readonly determinism_hash: string;
}

export interface DisturbanceApplicationRecord {
  readonly disturbance_id: Ref;
  readonly disturbance_type: DisturbanceType;
  readonly application_status: DisturbanceApplicationStatus;
  readonly timing_status: DisturbanceTimingStatus;
  readonly severity: DisturbanceSeverity;
  readonly safety_policy: SafetyPolicy;
  readonly target_internal_refs: readonly Ref[];
  readonly effect_kinds: readonly DisturbanceEffectKind[];
  readonly expected_sensor_effect?: string;
  readonly replay_marker: ReplayDisturbanceMarker;
  readonly safe_hold_required: boolean;
  readonly message: string;
  readonly determinism_hash: string;
}

export interface DisturbanceRejection {
  readonly disturbance_id: Ref;
  readonly reason_code: DisturbanceValidationCode;
  readonly message: string;
  readonly remediation: string;
}

export interface DisturbanceApplicationReport {
  readonly schema_version: typeof DISTURBANCE_INJECTION_SERVICE_SCHEMA_VERSION;
  readonly report_ref: Ref;
  readonly world_ref: Ref;
  readonly physics_tick: number;
  readonly timestamp_s: number;
  readonly applied_disturbances: readonly DisturbanceApplicationRecord[];
  readonly deferred_disturbance_ids: readonly Ref[];
  readonly rejected_disturbances: readonly DisturbanceRejection[];
  readonly scheduler_disturbance_batch: readonly DisturbanceEvent[];
  readonly effects: readonly DisturbanceEffect[];
  readonly safe_hold_required: boolean;
  readonly issue_count: number;
  readonly issues: readonly ValidationIssue[];
  readonly cognitive_visibility: "runtime_qa_validator_only";
  readonly determinism_hash: string;
}

export interface CognitiveSafeDisturbanceSummary {
  readonly runtime_status: "normal" | "degraded" | "safe_hold_required";
  readonly sensed_effect_summary: readonly string[];
  readonly safety_summary: "no_safety_effect" | "monitor" | "pause_or_reobserve" | "safe_hold";
  readonly hidden_fields_removed: readonly string[];
}

export interface DisturbanceInjectionServiceConfig {
  readonly schedule: DisturbanceSchedule;
  readonly replay_seed?: ReplaySeed;
  readonly safety_policy?: Partial<DisturbanceSafetyPolicy>;
  readonly world_bounds?: WorldBounds;
}

export class DisturbanceInjectionServiceError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "DisturbanceInjectionServiceError";
    this.issues = issues;
  }
}

/**
 * Selects and applies deterministic disturbance scripts for QA scenarios.
 *
 * The class never emits script details to model-facing callers. Its primary
 * report is intentionally runtime/QA-only and can be passed to the scheduler,
 * replay recorder, sensor services, or later physics health monitors.
 */
export class DisturbanceInjectionService {
  private readonly safetyPolicy: DisturbanceSafetyPolicy;
  private readonly eventsById: ReadonlyMap<Ref, DisturbanceEvent>;
  private readonly appliedIds: Set<Ref> = new Set();

  public constructor(private readonly config: DisturbanceInjectionServiceConfig) {
    const issues: ValidationIssue[] = [];
    validateSchedule(config.schedule, config.replay_seed, issues);
    this.safetyPolicy = Object.freeze({
      allow_unscheduled_disturbances: config.safety_policy?.allow_unscheduled_disturbances ?? false,
      allow_physics_glitch: config.safety_policy?.allow_physics_glitch ?? true,
      allow_api_timing_delay: config.safety_policy?.allow_api_timing_delay ?? true,
      max_allowed_severity: config.safety_policy?.max_allowed_severity ?? "high",
      safe_hold_on_high_severity: config.safety_policy?.safe_hold_on_high_severity ?? true,
      safe_hold_impulse_threshold_n_s: config.safety_policy?.safe_hold_impulse_threshold_n_s ?? DEFAULT_SAFE_HOLD_IMPULSE_N_S,
      warning_impulse_threshold_n_s: config.safety_policy?.warning_impulse_threshold_n_s ?? DEFAULT_WARNING_IMPULSE_N_S,
      max_object_nudge_m: config.safety_policy?.max_object_nudge_m ?? DEFAULT_MAX_OBJECT_NUDGE_M,
      max_api_delay_ms: config.safety_policy?.max_api_delay_ms ?? DEFAULT_API_DELAY_MS,
      sensor_fault_window_s: config.safety_policy?.sensor_fault_window_s ?? DEFAULT_SENSOR_DROP_WINDOW_S,
      require_replay_seed_match: config.safety_policy?.require_replay_seed_match ?? true,
    });
    validateSafetyPolicy(this.safetyPolicy, issues);
    if (issues.some((issue) => issue.severity === "error")) {
      throw new DisturbanceInjectionServiceError("Disturbance injection service configuration failed validation.", issues);
    }
    this.eventsById = new Map(config.schedule.events.map((event) => [event.disturbance_id, event] as const));
  }

  /**
   * Injects all disturbances due at the current runtime boundary.
   */
  public injectDueDisturbances(input: {
    readonly world_snapshot: PhysicsWorldSnapshot;
    readonly runtime_state: DisturbanceRuntimeState;
    readonly disturbance_ids?: readonly Ref[];
  }): DisturbanceApplicationReport {
    validateSnapshot(input.world_snapshot);
    validateRuntimeState(input.runtime_state);
    const selected = this.selectDisturbances(input.runtime_state, input.disturbance_ids);
    return this.buildReport(input.world_snapshot, input.runtime_state, selected);
  }

  /**
   * Injects one explicitly supplied scheduled disturbance.
   */
  public injectSimulationDisturbance(
    worldSnapshot: PhysicsWorldSnapshot,
    disturbanceEvent: DisturbanceEvent,
    runtimeState: DisturbanceRuntimeState,
    safetyPolicy: Partial<DisturbanceSafetyPolicy> = {},
  ): DisturbanceApplicationReport {
    validateSnapshot(worldSnapshot);
    validateRuntimeState(runtimeState);
    const priorPolicy = this.safetyPolicy;
    const mergedPolicy = Object.freeze({ ...priorPolicy, ...safetyPolicy });
    validateSafetyPolicy(mergedPolicy, []);
    const scheduled = this.eventsById.get(disturbanceEvent.disturbance_id);
    const selected = scheduled === undefined && !mergedPolicy.allow_unscheduled_disturbances
      ? [disturbanceEvent]
      : [scheduled ?? disturbanceEvent];
    return this.buildReport(worldSnapshot, runtimeState, selected, mergedPolicy);
  }

  /**
   * Redacts QA-only disturbance scripts into prompt-safe runtime effects.
   */
  public redactDisturbanceReportForCognition(report: DisturbanceApplicationReport): CognitiveSafeDisturbanceSummary {
    const safeHold = report.safe_hold_required;
    const summaries = report.applied_disturbances.map((record) => summarizeSensedEffect(record));
    const safetySummary: CognitiveSafeDisturbanceSummary["safety_summary"] = safeHold
      ? "safe_hold"
      : report.applied_disturbances.some((record) => record.severity === "high" || record.severity === "critical")
        ? "pause_or_reobserve"
        : report.applied_disturbances.some((record) => record.severity === "medium")
          ? "monitor"
          : "no_safety_effect";
    return Object.freeze({
      runtime_status: safeHold ? "safe_hold_required" : report.issue_count > 0 ? "degraded" : "normal",
      sensed_effect_summary: freezeArray(summaries),
      safety_summary: safetySummary,
      hidden_fields_removed: freezeArray([
        "disturbance_id",
        "disturbance_type",
        "target_internal_refs",
        "physical_effect",
        "replay_marker",
        "rng_draws",
        "scheduler_disturbance_batch",
        "effects.object_ref",
        "effects.sensor_ref",
        "effects.source_position_m",
        "determinism_hash",
      ]),
    });
  }

  private selectDisturbances(runtime: DisturbanceRuntimeState, disturbanceIds: readonly Ref[] | undefined): readonly DisturbanceEvent[] {
    if (disturbanceIds !== undefined) {
      return freezeArray(disturbanceIds.map((id) => this.eventsById.get(id)).filter(isDefined));
    }
    const due = this.config.schedule.events.filter((event) => !this.appliedIds.has(event.disturbance_id) && classifyTiming(event, runtime) === "due");
    return freezeArray(due.sort(compareDisturbances));
  }

  private buildReport(
    worldSnapshot: PhysicsWorldSnapshot,
    runtime: DisturbanceRuntimeState,
    disturbances: readonly DisturbanceEvent[],
    safetyPolicy: DisturbanceSafetyPolicy = this.safetyPolicy,
  ): DisturbanceApplicationReport {
    const issues: ValidationIssue[] = [];
    const records: DisturbanceApplicationRecord[] = [];
    const deferred: Ref[] = [];
    const rejected: DisturbanceRejection[] = [];
    const effects: DisturbanceEffect[] = [];
    const schedulerBatch: DisturbanceEvent[] = [];

    for (const disturbance of disturbances) {
      const outcome = this.evaluateDisturbance(disturbance, worldSnapshot, runtime, safetyPolicy);
      issues.push(...outcome.issues);
      if (outcome.record.application_status === "deferred") {
        deferred.push(disturbance.disturbance_id);
        records.push(outcome.record);
        continue;
      }
      if (outcome.record.application_status === "rejected") {
        rejected.push(outcome.rejection ?? reject(disturbance.disturbance_id, "SafetyPolicyViolation", outcome.record.message, "Review schedule authorization and safety policy."));
        records.push(outcome.record);
        continue;
      }
      records.push(outcome.record);
      effects.push(...outcome.effects);
      schedulerBatch.push(disturbance);
      this.appliedIds.add(disturbance.disturbance_id);
    }

    const safeHold = records.some((record) => record.safe_hold_required);
    const reportBase = {
      schema_version: DISTURBANCE_INJECTION_SERVICE_SCHEMA_VERSION,
      report_ref: `disturbance_report_${worldSnapshot.world_ref}_${runtime.current_tick}`,
      world_ref: worldSnapshot.world_ref,
      physics_tick: runtime.current_tick,
      timestamp_s: runtime.current_time_s,
      applied_disturbances: freezeArray(records),
      deferred_disturbance_ids: freezeArray(deferred),
      rejected_disturbances: freezeArray(rejected),
      scheduler_disturbance_batch: freezeArray(schedulerBatch),
      effects: freezeArray(effects),
      safe_hold_required: safeHold,
      issue_count: issues.length,
      issues: freezeArray(issues),
      cognitive_visibility: "runtime_qa_validator_only" as const,
    };
    return Object.freeze({
      ...reportBase,
      determinism_hash: computeDeterminismHash(reportBase),
    });
  }

  private evaluateDisturbance(
    event: DisturbanceEvent,
    snapshot: PhysicsWorldSnapshot,
    runtime: DisturbanceRuntimeState,
    policy: DisturbanceSafetyPolicy,
  ): {
    readonly record: DisturbanceApplicationRecord;
    readonly effects: readonly DisturbanceEffect[];
    readonly issues: readonly ValidationIssue[];
    readonly rejection?: DisturbanceRejection;
  } {
    const issues: ValidationIssue[] = [];
    const timing = classifyTiming(event, runtime);
    const marker = createReplayMarker(event, snapshot, runtime, this.config.replay_seed);
    const targetRefs = freezeArray(event.target_internal_refs ?? []);
    const seed = seededDraws(event, snapshot, runtime, this.config.replay_seed, 8);
    const replayIssue = validateReplaySeed(event, this.config.replay_seed);
    if (replayIssue !== undefined && policy.require_replay_seed_match) {
      issues.push(replayIssue);
    }
    if (!this.config.schedule.qa_authorized) {
      const issue = makeIssue("error", "DisturbanceUnauthorized", "$.schedule.qa_authorized", "Disturbance schedule is not QA-authorized.", "Authorize the schedule before runtime injection.");
      issues.push(issue);
      return this.rejectedRecord(event, timing, "Disturbance schedule is not QA-authorized.", marker, issues, "DisturbanceUnauthorized", issue.remediation);
    }
    if (!this.eventsById.has(event.disturbance_id) && !policy.allow_unscheduled_disturbances) {
      const issue = makeIssue("error", "DisturbanceNotScheduled", "$.disturbance_id", "Disturbance is not present in the scenario schedule.", "Add the disturbance to the scenario schedule or enable unscheduled QA mode.");
      issues.push(issue);
      return this.rejectedRecord(event, timing, "Disturbance is not scheduled for this scenario.", marker, issues, "DisturbanceNotScheduled", issue.remediation);
    }
    const authorized = runtime.qa_authorized_disturbance_ids === undefined || runtime.qa_authorized_disturbance_ids.includes(event.disturbance_id);
    if (!authorized) {
      const issue = makeIssue("error", "DisturbanceUnauthorized", "$.runtime_state.qa_authorized_disturbance_ids", "Runtime state does not authorize this disturbance id.", "Authorize the id for this run or skip injection.");
      issues.push(issue);
      return this.rejectedRecord(event, timing, "Runtime did not authorize disturbance injection.", marker, issues, "DisturbanceUnauthorized", issue.remediation);
    }
    if (timing === "future") {
      return this.deferredRecord(event, timing, marker, "Disturbance is scheduled for a future runtime boundary.");
    }
    if (timing === "missed") {
      const issue = makeIssue("error", "DisturbanceNotScheduled", "$.scheduled_time", "Disturbance schedule window has already elapsed.", "Replay from the original schedule window or reschedule the disturbance.");
      issues.push(issue);
      return this.rejectedRecord(event, timing, "Disturbance schedule window has elapsed.", marker, issues, "DisturbanceNotScheduled", issue.remediation);
    }
    if (replayIssue !== undefined && policy.require_replay_seed_match) {
      return this.rejectedRecord(event, timing, "Disturbance replay seed does not match the active replay seed.", marker, issues, "ReplayMismatch", replayIssue.remediation);
    }
    const targetIssue = validateTargets(event, snapshot, runtime);
    if (targetIssue !== undefined) {
      issues.push(targetIssue);
      return this.rejectedRecord(event, timing, "Disturbance target is unavailable.", marker, issues, "TargetUnavailable", targetIssue.remediation);
    }

    const effectResult = buildEffectsForDisturbance(event, snapshot, runtime, policy, seed);
    issues.push(...effectResult.issues);
    if (!policyAllows(event, effectResult.severity, policy)) {
      const issue = makeIssue("error", "DisturbanceTooSevere", "$.safety_policy", "Disturbance exceeds the active safety policy.", "Lower disturbance severity or run under explicit safe-hold QA policy.");
      issues.push(issue);
      return this.rejectedRecord(event, timing, "Disturbance exceeds active safety policy.", marker, issues, "DisturbanceTooSevere", issue.remediation);
    }
    const safeHold = shouldSafeHold(event, effectResult.severity, policy);
    const status: DisturbanceApplicationStatus = safeHold ? "safe_hold_required" : "applied";
    const recordBase = {
      disturbance_id: event.disturbance_id,
      disturbance_type: event.disturbance_type,
      application_status: status,
      timing_status: timing,
      severity: effectResult.severity,
      safety_policy: event.safety_policy,
      target_internal_refs: targetRefs,
      effect_kinds: freezeArray(effectResult.effects.map((effect) => effect.effect_kind)),
      expected_sensor_effect: event.expected_sensor_effect,
      replay_marker: marker,
      safe_hold_required: safeHold,
      message: safeHold ? "Disturbance applied and safe-hold is required by policy." : "Disturbance applied under deterministic QA control.",
    };
    return Object.freeze({
      record: Object.freeze({
        ...recordBase,
        determinism_hash: computeDeterminismHash(recordBase),
      }),
      effects: freezeArray(effectResult.effects),
      issues: freezeArray(issues),
    });
  }

  private rejectedRecord(
    event: DisturbanceEvent,
    timing: DisturbanceTimingStatus,
    message: string,
    marker: ReplayDisturbanceMarker,
    issues: readonly ValidationIssue[],
    code: DisturbanceValidationCode,
    remediation: string,
  ): {
    readonly record: DisturbanceApplicationRecord;
    readonly effects: readonly DisturbanceEffect[];
    readonly issues: readonly ValidationIssue[];
    readonly rejection: DisturbanceRejection;
  } {
    const recordBase = {
      disturbance_id: event.disturbance_id,
      disturbance_type: event.disturbance_type,
      application_status: "rejected" as const,
      timing_status: timing,
      severity: "low" as const,
      safety_policy: event.safety_policy,
      target_internal_refs: freezeArray(event.target_internal_refs ?? []),
      effect_kinds: freezeArray([] as DisturbanceEffectKind[]),
      expected_sensor_effect: event.expected_sensor_effect,
      replay_marker: marker,
      safe_hold_required: false,
      message,
    };
    return Object.freeze({
      record: Object.freeze({ ...recordBase, determinism_hash: computeDeterminismHash(recordBase) }),
      effects: freezeArray([]),
      issues: freezeArray(issues),
      rejection: reject(event.disturbance_id, code, message, remediation),
    });
  }

  private deferredRecord(
    event: DisturbanceEvent,
    timing: DisturbanceTimingStatus,
    marker: ReplayDisturbanceMarker,
    message: string,
  ): {
    readonly record: DisturbanceApplicationRecord;
    readonly effects: readonly DisturbanceEffect[];
    readonly issues: readonly ValidationIssue[];
  } {
    const recordBase = {
      disturbance_id: event.disturbance_id,
      disturbance_type: event.disturbance_type,
      application_status: "deferred" as const,
      timing_status: timing,
      severity: "low" as const,
      safety_policy: event.safety_policy,
      target_internal_refs: freezeArray(event.target_internal_refs ?? []),
      effect_kinds: freezeArray([] as DisturbanceEffectKind[]),
      expected_sensor_effect: event.expected_sensor_effect,
      replay_marker: marker,
      safe_hold_required: false,
      message,
    };
    return Object.freeze({
      record: Object.freeze({ ...recordBase, determinism_hash: computeDeterminismHash(recordBase) }),
      effects: freezeArray([]),
      issues: freezeArray([]),
    });
  }
}

export function injectSimulationDisturbance(
  schedule: DisturbanceSchedule,
  worldSnapshot: PhysicsWorldSnapshot,
  disturbanceEvent: DisturbanceEvent,
  runtimeState: DisturbanceRuntimeState,
  replaySeed?: ReplaySeed,
  safetyPolicy: Partial<DisturbanceSafetyPolicy> = {},
): DisturbanceApplicationReport {
  return new DisturbanceInjectionService({ schedule, replay_seed: replaySeed, safety_policy: safetyPolicy }).injectSimulationDisturbance(worldSnapshot, disturbanceEvent, runtimeState, safetyPolicy);
}

function buildEffectsForDisturbance(
  event: DisturbanceEvent,
  snapshot: PhysicsWorldSnapshot,
  runtime: DisturbanceRuntimeState,
  policy: DisturbanceSafetyPolicy,
  draws: readonly number[],
): { readonly effects: readonly DisturbanceEffect[]; readonly severity: DisturbanceSeverity; readonly issues: readonly ValidationIssue[] } {
  switch (event.disturbance_type) {
    case "slip":
      return buildSlipEffects(event, runtime, draws);
    case "drop":
      return buildDropEffects(event, snapshot, draws);
    case "occlusion":
      return buildOcclusionEffects(event, snapshot, draws);
    case "object_movement":
      return buildObjectMovementEffects(event, snapshot, policy, draws);
    case "audio":
      return buildAudioEffects(event, snapshot, runtime, draws);
    case "physics_glitch":
      return buildPhysicsGlitchEffects(event, policy, draws);
    case "sensor":
      return buildSensorFaultEffects(event, runtime, policy, draws);
    case "api_timing":
      return buildApiTimingEffects(event, policy, draws);
  }
}

function buildSlipEffects(
  event: DisturbanceEvent,
  runtime: DisturbanceRuntimeState,
  draws: readonly number[],
): { readonly effects: readonly DisturbanceEffect[]; readonly severity: DisturbanceSeverity; readonly issues: readonly ValidationIssue[] } {
  const durationS = round6(0.08 + draws[0] * 0.22);
  const scale = round6(DEFAULT_SLIP_FRICTION_SCALE + draws[1] * 0.18);
  const targets = freezeArray(event.target_internal_refs ?? ["active_grasp_contact"]);
  const effect: FrictionOverrideEffect = Object.freeze({
    effect_kind: "friction_override",
    target_refs: targets,
    static_friction_scale: scale,
    dynamic_friction_scale: round6(Math.max(0.05, scale * 0.85)),
    duration_s: durationS,
  });
  const movement = createMovementEvent(event, "self_motion", runtime, [0.02 + draws[2] * 0.04, -0.01 + draws[3] * 0.02, 0], "slide", "low", targets[0]);
  return Object.freeze({
    effects: freezeArray([effect, Object.freeze({ effect_kind: "audio_movement_event", movement_event: movement } as AudioMovementEffect)]),
    severity: "medium",
    issues: freezeArray([]),
  });
}

function buildDropEffects(
  event: DisturbanceEvent,
  snapshot: PhysicsWorldSnapshot,
  draws: readonly number[],
): { readonly effects: readonly DisturbanceEffect[]; readonly severity: DisturbanceSeverity; readonly issues: readonly ValidationIssue[] } {
  const objectRef = firstTarget(event);
  const object = requireObject(snapshot, objectRef);
  const drop = DEFAULT_DROP_HEIGHT_M * (0.75 + draws[0] * 0.75);
  const displacement: Vector3 = [0, 0, -drop];
  const disturbed = translateTransform(object.transform, displacement, snapshot);
  const patch: ObjectTransformPatchEffect = Object.freeze({
    effect_kind: "object_transform_patch",
    object_ref: objectRef,
    original_transform: object.transform,
    disturbed_transform: disturbed,
    displacement_m: freezeVector3(displacement),
  });
  const velocity: ObjectVelocityDeltaEffect = Object.freeze({
    effect_kind: "object_velocity_delta",
    object_ref: objectRef,
    linear_velocity_delta_m_per_s: freezeVector3([0, 0, -Math.sqrt(2 * 9.80665 * drop)]),
    angular_velocity_delta_rad_per_s: freezeVector3([(draws[1] - 0.5) * 2, (draws[2] - 0.5) * 2, (draws[3] - 0.5) * 2]),
  });
  const movement: AudioMovementEffect = Object.freeze({
    effect_kind: "audio_movement_event",
    movement_event: createMovementEvent(event, "disturbance", { current_tick: snapshot.physics_tick, current_time_s: snapshot.timestamp_s }, disturbed.position_m, "drop", "high", objectRef),
  });
  return Object.freeze({ effects: freezeArray([patch, velocity, movement]), severity: "high", issues: freezeArray([]) });
}

function buildOcclusionEffects(
  event: DisturbanceEvent,
  snapshot: PhysicsWorldSnapshot,
  draws: readonly number[],
): { readonly effects: readonly DisturbanceEffect[]; readonly severity: DisturbanceSeverity; readonly issues: readonly ValidationIssue[] } {
  const occluderRef = firstTarget(event);
  const occluder = requireObject(snapshot, occluderRef);
  const lateral = (draws[0] - 0.5) * DEFAULT_OCCLUDER_SHIFT_M;
  const forward = 0.2 + draws[1] * 0.35;
  const vertical = (draws[2] - 0.5) * 0.15;
  const displacement: Vector3 = [forward, lateral, vertical];
  const transform = translateTransform(occluder.transform, displacement, snapshot);
  const effect: OcclusionPoseEffect = Object.freeze({
    effect_kind: "occlusion_pose",
    occluder_ref: occluderRef,
    original_transform: occluder.transform,
    occlusion_transform: transform,
    expected_visual_effect: draws[3] > 0.72 ? "full_camera_occlusion" : draws[3] > 0.35 ? "partial_camera_occlusion" : "view_clutter",
  });
  return Object.freeze({ effects: freezeArray([effect]), severity: "medium", issues: freezeArray([]) });
}

function buildObjectMovementEffects(
  event: DisturbanceEvent,
  snapshot: PhysicsWorldSnapshot,
  policy: DisturbanceSafetyPolicy,
  draws: readonly number[],
): { readonly effects: readonly DisturbanceEffect[]; readonly severity: DisturbanceSeverity; readonly issues: readonly ValidationIssue[] } {
  const objectRef = firstTarget(event);
  const object = requireObject(snapshot, objectRef);
  const direction = normalizeVector([draws[0] - 0.5, draws[1] - 0.5, 0]);
  const magnitude = policy.max_object_nudge_m * (0.25 + draws[2] * 0.75);
  const displacement = scaleVector3(direction, magnitude);
  const transform = translateTransform(object.transform, displacement, snapshot);
  const patch: ObjectTransformPatchEffect = Object.freeze({
    effect_kind: "object_transform_patch",
    object_ref: objectRef,
    original_transform: object.transform,
    disturbed_transform: transform,
    displacement_m: freezeVector3(displacement),
  });
  const velocity: ObjectVelocityDeltaEffect = Object.freeze({
    effect_kind: "object_velocity_delta",
    object_ref: objectRef,
    linear_velocity_delta_m_per_s: freezeVector3(scaleVector3(direction, 0.2 + draws[3] * 0.5)),
    angular_velocity_delta_rad_per_s: freezeVector3([0, 0, (draws[4] - 0.5) * 1.5]),
  });
  return Object.freeze({ effects: freezeArray([patch, velocity]), severity: magnitude > policy.max_object_nudge_m * 0.7 ? "medium" : "low", issues: freezeArray([]) });
}

function buildAudioEffects(
  event: DisturbanceEvent,
  snapshot: PhysicsWorldSnapshot,
  runtime: DisturbanceRuntimeState,
  draws: readonly number[],
): { readonly effects: readonly DisturbanceEffect[]; readonly severity: DisturbanceSeverity; readonly issues: readonly ValidationIssue[] } {
  const targetRef = event.target_internal_refs?.[0];
  const source = targetRef === undefined ? randomPointNearWorldCenter(snapshot, draws) : requireObject(snapshot, targetRef).transform.position_m;
  const velocity: Vector3 = [(draws[0] - 0.5) * DEFAULT_AUDIO_SPEED_M_PER_S, (draws[1] - 0.5) * DEFAULT_AUDIO_SPEED_M_PER_S, (draws[2] - 0.5) * DEFAULT_AUDIO_SPEED_M_PER_S];
  const movement: MovementAcousticEvent = Object.freeze({
    movement_event_id: `movement_audio_${event.disturbance_id}`,
    source_kind: "disturbance",
    timestamp_s: runtime.current_time_s,
    physics_tick: runtime.current_tick,
    source_position_m: freezeVector3(source),
    velocity_m_per_s: freezeVector3(velocity),
    acceleration_m_per_s2: freezeVector3([0, 0, -9.80665 * (0.2 + draws[3])]),
    movement_class: draws[4] > 0.5 ? "drop" : "drag",
    intensity_hint: draws[5] > 0.65 ? "high" : "medium",
    internal_source_ref: targetRef,
    audio_profile_ref: "qa_hidden_audio_disturbance",
  });
  return Object.freeze({ effects: freezeArray([Object.freeze({ effect_kind: "audio_movement_event", movement_event: movement } as AudioMovementEffect)]), severity: "medium", issues: freezeArray([]) });
}

function buildPhysicsGlitchEffects(
  event: DisturbanceEvent,
  policy: DisturbanceSafetyPolicy,
  draws: readonly number[],
): { readonly effects: readonly DisturbanceEffect[]; readonly severity: DisturbanceSeverity; readonly issues: readonly ValidationIssue[] } {
  const magnitude = policy.warning_impulse_threshold_n_s + draws[0] * policy.safe_hold_impulse_threshold_n_s * 1.4;
  const direction = normalizeVector([draws[1] - 0.5, draws[2] - 0.5, draws[3] - 0.5]);
  const impulse = scaleVector3(direction, magnitude);
  const severity = magnitude >= policy.safe_hold_impulse_threshold_n_s ? "critical" : magnitude >= policy.warning_impulse_threshold_n_s ? "high" : "medium";
  const effect: PhysicsAnomalyEffect = Object.freeze({
    effect_kind: "physics_anomaly",
    anomaly_kind: draws[4] > 0.66 ? "impossible_impulse" : draws[4] > 0.33 ? "contact_glitch" : "solver_jitter",
    target_refs: freezeArray(event.target_internal_refs ?? []),
    impulse_n_s: freezeVector3(impulse),
    estimated_severity: severity,
  });
  return Object.freeze({ effects: freezeArray([effect]), severity, issues: freezeArray([]) });
}

function buildSensorFaultEffects(
  event: DisturbanceEvent,
  runtime: DisturbanceRuntimeState,
  policy: DisturbanceSafetyPolicy,
  draws: readonly number[],
): { readonly effects: readonly DisturbanceEffect[]; readonly severity: DisturbanceSeverity; readonly issues: readonly ValidationIssue[] } {
  const sensorRef = event.target_internal_refs?.[0] ?? runtime.active_sensor_refs?.[0] ?? "declared_sensor_unknown";
  const faultKinds: readonly SensorFaultKind[] = ["drop_frame", "noise_burst", "latency_spike", "occlusion_mask", "missing_packet"];
  const kind = faultKinds[Math.min(faultKinds.length - 1, Math.floor(draws[0] * faultKinds.length))];
  const level = draws[1] > 0.76 ? "severe" : draws[1] > 0.35 ? "moderate" : "minor";
  const window = policy.sensor_fault_window_s * (0.5 + draws[2]);
  const effect: SensorFaultEffect = Object.freeze({
    effect_kind: "sensor_fault",
    sensor_ref: sensorRef,
    fault_kind: kind,
    start_time_s: runtime.current_time_s,
    end_time_s: round6(runtime.current_time_s + window),
    degradation_level: level,
  });
  return Object.freeze({ effects: freezeArray([effect]), severity: level === "severe" ? "high" : level === "moderate" ? "medium" : "low", issues: freezeArray([]) });
}

function buildApiTimingEffects(
  event: DisturbanceEvent,
  policy: DisturbanceSafetyPolicy,
  draws: readonly number[],
): { readonly effects: readonly DisturbanceEffect[]; readonly severity: DisturbanceSeverity; readonly issues: readonly ValidationIssue[] } {
  const delay = Math.round(policy.max_api_delay_ms * (0.25 + draws[0] * 0.75));
  const affected = event.target_internal_refs?.[0] ?? "cognitive_orchestration_api";
  const severity: DisturbanceSeverity = delay > policy.max_api_delay_ms * 0.75 ? "high" : delay > policy.max_api_delay_ms * 0.45 ? "medium" : "low";
  const effect: ApiTimingDelayEffect = Object.freeze({
    effect_kind: "api_timing_delay",
    affected_component_ref: affected,
    delay_ms: delay,
    expected_runtime_response: severity === "high" ? "safe_hold" : severity === "medium" ? "pause" : "continue",
  });
  return Object.freeze({ effects: freezeArray([effect]), severity, issues: freezeArray([]) });
}

function classifyTiming(event: DisturbanceEvent, runtime: DisturbanceRuntimeState): DisturbanceTimingStatus {
  if ("start_s" in event.scheduled_time) {
    if (runtime.current_time_s < event.scheduled_time.start_s) {
      return "future";
    }
    if (runtime.current_time_s > event.scheduled_time.end_s) {
      return "missed";
    }
    return "due";
  }
  const trigger = event.scheduled_time.trigger.trim();
  if (trigger === "every_tick") {
    return "due";
  }
  if (trigger === "on_safe_hold") {
    return runtime.safety_mode === "safe_hold" || runtime.safety_mode === "emergency_stop" ? "due" : "future";
  }
  if (trigger.startsWith("tick:")) {
    const tick = Number(trigger.slice("tick:".length));
    if (!Number.isInteger(tick) || tick < 0) {
      return "missed";
    }
    return runtime.current_tick === tick ? "due" : runtime.current_tick < tick ? "future" : "missed";
  }
  if (trigger.startsWith("task:")) {
    const taskRef = trigger.slice("task:".length);
    return runtime.active_task_ref === taskRef ? "due" : "future";
  }
  return "future";
}

function createReplayMarker(event: DisturbanceEvent, snapshot: PhysicsWorldSnapshot, runtime: DisturbanceRuntimeState, replaySeed: ReplaySeed | undefined): ReplayDisturbanceMarker {
  const draws = seededDraws(event, snapshot, runtime, replaySeed, 4);
  const markerBase = {
    replay_marker_ref: `replay_disturbance_${event.disturbance_id}_${runtime.current_tick}`,
    disturbance_id: event.disturbance_id,
    replay_seed_ref: event.replay_seed_ref ?? replaySeed?.replay_seed_ref,
    rng_draws: freezeArray(draws),
    physics_tick: runtime.current_tick,
    timestamp_s: runtime.current_time_s,
  };
  return Object.freeze({
    ...markerBase,
    determinism_hash: computeDeterminismHash(markerBase),
  });
}

function seededDraws(event: DisturbanceEvent, snapshot: PhysicsWorldSnapshot, runtime: DisturbanceRuntimeState, replaySeed: ReplaySeed | undefined, count: number): readonly number[] {
  const seedMaterial = computeDeterminismHash({
    base_seed: replaySeed?.seed_u32 ?? 0x9e3779b9,
    generator: replaySeed?.generator ?? "xorshift32",
    event_id: event.disturbance_id,
    event_type: event.disturbance_type,
    snapshot_ref: snapshot.snapshot_ref,
    tick: runtime.current_tick,
  });
  let state = Number.parseInt(seedMaterial.slice(0, 8), 16) >>> 0;
  const draws: number[] = [];
  for (let index = 0; index < count; index += 1) {
    state = nextRandomState(state, replaySeed?.generator ?? "xorshift32");
    draws.push(round9(state / 0x100000000));
  }
  return freezeArray(draws);
}

function nextRandomState(state: number, generator: ReplaySeed["generator"]): number {
  if (generator === "splitmix32") {
    let z = (state + 0x9e3779b9) >>> 0;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  }
  if (generator === "pcg32") {
    return (Math.imul(state, 747796405) + 2891336453) >>> 0;
  }
  let x = state || 0x6d2b79f5;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return x >>> 0;
}

function validateReplaySeed(event: DisturbanceEvent, replaySeed: ReplaySeed | undefined): ValidationIssue | undefined {
  if (event.replay_seed_ref !== undefined && replaySeed !== undefined && event.replay_seed_ref !== replaySeed.replay_seed_ref) {
    return makeIssue("error", "ReplayMismatch", "$.replay_seed_ref", "Disturbance replay seed does not match active replay seed.", "Use the schedule replay seed or regenerate the disturbance schedule.");
  }
  return undefined;
}

function validateTargets(event: DisturbanceEvent, snapshot: PhysicsWorldSnapshot, runtime: DisturbanceRuntimeState): ValidationIssue | undefined {
  const targets = event.target_internal_refs ?? [];
  if (event.disturbance_type === "sensor" || event.disturbance_type === "api_timing" || event.disturbance_type === "physics_glitch" || event.disturbance_type === "slip") {
    return undefined;
  }
  if (targets.length === 0 && event.disturbance_type !== "audio") {
    return makeIssue("error", "TargetUnavailable", "$.target_internal_refs", "Disturbance requires at least one target internal ref.", "Attach a target object, occluder, or emitter ref.");
  }
  for (const target of targets) {
    if (snapshot.object_states.some((object) => object.object_ref === target)) {
      continue;
    }
    if (event.disturbance_type === "audio" || runtime.active_sensor_refs?.includes(target) === true) {
      continue;
    }
    return makeIssue("error", "TargetUnavailable", "$.target_internal_refs", `Target ${target} is not available in the current snapshot.`, "Use an object or sensor ref present at this runtime boundary.");
  }
  return undefined;
}

function policyAllows(event: DisturbanceEvent, severity: DisturbanceSeverity, policy: DisturbanceSafetyPolicy): boolean {
  if (event.disturbance_type === "physics_glitch" && !policy.allow_physics_glitch) {
    return false;
  }
  if (event.disturbance_type === "api_timing" && !policy.allow_api_timing_delay) {
    return false;
  }
  return severityRank(severity) <= severityRank(policy.max_allowed_severity) || shouldSafeHold(event, severity, policy);
}

function shouldSafeHold(event: DisturbanceEvent, severity: DisturbanceSeverity, policy: DisturbanceSafetyPolicy): boolean {
  if (event.safety_policy === "safe_hold_if_severe" && (severity === "high" || severity === "critical")) {
    return true;
  }
  return policy.safe_hold_on_high_severity && severity === "critical";
}

function severityRank(value: DisturbanceSeverity): number {
  if (value === "critical") {
    return 4;
  }
  if (value === "high") {
    return 3;
  }
  if (value === "medium") {
    return 2;
  }
  return 1;
}

function summarizeSensedEffect(record: DisturbanceApplicationRecord): string {
  if (record.application_status === "rejected") {
    return "A QA disturbance was rejected before affecting embodied evidence.";
  }
  if (record.disturbance_type === "slip") {
    return "Contact or visual evidence may indicate slipping.";
  }
  if (record.disturbance_type === "drop") {
    return "Camera or microphone evidence may indicate a dropped object.";
  }
  if (record.disturbance_type === "occlusion") {
    return "A camera view may be partially occluded and should be reobserved.";
  }
  if (record.disturbance_type === "object_movement") {
    return "A scene object may have moved and should be rediscovered through sensors.";
  }
  if (record.disturbance_type === "audio") {
    return "A microphone cue may indicate an event outside the current view.";
  }
  if (record.disturbance_type === "sensor") {
    return "A declared sensor may report degraded or missing evidence.";
  }
  if (record.disturbance_type === "api_timing") {
    return "Runtime timing may be delayed; pause or safe-hold if control freshness is affected.";
  }
  return "Physics health may be degraded and should be checked before continuing.";
}

function requireObject(snapshot: PhysicsWorldSnapshot, objectRef: Ref): { readonly object_ref: Ref; readonly transform: Transform } {
  const object = snapshot.object_states.find((candidate) => candidate.object_ref === objectRef);
  if (object === undefined) {
    throw new DisturbanceInjectionServiceError(`Disturbance target ${objectRef} is unavailable.`, [
      makeIssue("error", "TargetUnavailable", "$.target_internal_refs", "Target object is not present in the physics snapshot.", "Schedule the disturbance against an existing object ref."),
    ]);
  }
  return object;
}

function firstTarget(event: DisturbanceEvent): Ref {
  const target = event.target_internal_refs?.[0];
  if (target === undefined) {
    throw new DisturbanceInjectionServiceError(`Disturbance ${event.disturbance_id} has no target.`, [
      makeIssue("error", "TargetUnavailable", "$.target_internal_refs", "Disturbance requires a target ref.", "Attach a target_internal_refs entry."),
    ]);
  }
  return target;
}

function createMovementEvent(
  event: DisturbanceEvent,
  sourceKind: MovementAcousticEvent["source_kind"],
  runtime: Pick<DisturbanceRuntimeState, "current_tick" | "current_time_s">,
  sourcePosition: Vector3,
  movementClass: MovementAcousticEvent["movement_class"],
  intensity: MovementAcousticEvent["intensity_hint"],
  internalSourceRef?: Ref,
): MovementAcousticEvent {
  return Object.freeze({
    movement_event_id: `movement_${event.disturbance_id}_${runtime.current_tick}`,
    source_kind: sourceKind,
    timestamp_s: runtime.current_time_s,
    physics_tick: runtime.current_tick,
    source_position_m: freezeVector3(sourcePosition),
    velocity_m_per_s: freezeVector3([0.08, 0.02, movementClass === "drop" ? -0.9 : 0]),
    acceleration_m_per_s2: freezeVector3([0, 0, movementClass === "drop" ? -9.80665 : 0]),
    movement_class: movementClass,
    intensity_hint: intensity,
    internal_source_ref: internalSourceRef,
    audio_profile_ref: event.disturbance_type === "audio" ? "qa_audio_disturbance" : undefined,
  });
}

function randomPointNearWorldCenter(snapshot: PhysicsWorldSnapshot, draws: readonly number[]): Vector3 {
  if (snapshot.object_states.length > 0) {
    const index = Math.min(snapshot.object_states.length - 1, Math.floor(draws[0] * snapshot.object_states.length));
    return snapshot.object_states[index].transform.position_m;
  }
  return [draws[0] - 0.5, draws[1] - 0.5, draws[2] * 0.5];
}

function translateTransform(transform: Transform, displacement: Vector3, snapshot: PhysicsWorldSnapshot): Transform {
  return freezeTransform({
    frame_ref: transform.frame_ref,
    position_m: clampToWorld(addVector3(transform.position_m, displacement), snapshot),
    orientation_xyzw: transform.orientation_xyzw,
  });
}

function clampToWorld(position: Vector3, snapshot: PhysicsWorldSnapshot): Vector3 {
  void snapshot;
  return freezeVector3(position);
}

function compareDisturbances(a: DisturbanceEvent, b: DisturbanceEvent): number {
  return describeScheduledTime(a.scheduled_time).localeCompare(describeScheduledTime(b.scheduled_time)) || a.disturbance_id.localeCompare(b.disturbance_id);
}

function describeScheduledTime(value: DisturbanceEvent["scheduled_time"]): string {
  if ("start_s" in value) {
    return `${value.start_s.toFixed(6)}..${value.end_s.toFixed(6)}`;
  }
  return value.trigger;
}

function validateSchedule(schedule: DisturbanceSchedule, replaySeed: ReplaySeed | undefined, issues: ValidationIssue[]): void {
  validateRef(schedule.disturbance_schedule_ref, issues, "$.schedule.disturbance_schedule_ref", "ScheduleInvalid");
  if (!schedule.qa_authorized) {
    issues.push(makeIssue("error", "DisturbanceUnauthorized", "$.schedule.qa_authorized", "Disturbance schedule must be QA-authorized.", "Authorize the schedule before runtime injection."));
  }
  if (schedule.cognitive_disclosure !== "effects_only") {
    issues.push(makeIssue("error", "ScheduleInvalid", "$.schedule.cognitive_disclosure", "Disturbance schedule may disclose effects only.", "Set cognitive_disclosure to effects_only."));
  }
  const ids = new Set<Ref>();
  for (let index = 0; index < schedule.events.length; index += 1) {
    const event = schedule.events[index];
    const path = `$.schedule.events[${index}]`;
    validateRef(event.disturbance_id, issues, `${path}.disturbance_id`, "ScheduleInvalid");
    if (ids.has(event.disturbance_id)) {
      issues.push(makeIssue("error", "ScheduleInvalid", `${path}.disturbance_id`, "Disturbance ids must be unique.", "Rename one scheduled disturbance."));
    }
    ids.add(event.disturbance_id);
    if (!["slip", "drop", "occlusion", "object_movement", "audio", "physics_glitch", "sensor", "api_timing"].includes(event.disturbance_type)) {
      issues.push(makeIssue("error", "ScheduleInvalid", `${path}.disturbance_type`, "Disturbance type is unsupported.", "Use a declared disturbance type."));
    }
    if (event.physical_effect.trim().length === 0) {
      issues.push(makeIssue("error", "ScheduleInvalid", `${path}.physical_effect`, "Physical effect must be described for QA/replay.", "Provide a QA-only physical effect description."));
    }
    if ("start_s" in event.scheduled_time) {
      if (!Number.isFinite(event.scheduled_time.start_s) || !Number.isFinite(event.scheduled_time.end_s) || event.scheduled_time.start_s < 0 || event.scheduled_time.end_s < event.scheduled_time.start_s) {
        issues.push(makeIssue("error", "ScheduleInvalid", `${path}.scheduled_time`, "Scheduled interval must be finite, nonnegative, and ordered.", "Use start_s >= 0 and end_s >= start_s."));
      }
    } else if (event.scheduled_time.trigger.trim().length === 0) {
      issues.push(makeIssue("error", "ScheduleInvalid", `${path}.scheduled_time.trigger`, "Trigger must be non-empty.", "Use tick:N, task:ref, every_tick, or on_safe_hold."));
    }
    if (event.replay_seed_ref !== undefined && replaySeed !== undefined && event.replay_seed_ref !== replaySeed.replay_seed_ref) {
      issues.push(makeIssue("error", "ReplayMismatch", `${path}.replay_seed_ref`, "Disturbance replay seed does not match the supplied replay seed.", "Use the schedule replay seed."));
    }
  }
}

function validateSafetyPolicy(policy: DisturbanceSafetyPolicy, issues: ValidationIssue[]): void {
  validatePositiveFinite(policy.safe_hold_impulse_threshold_n_s, issues, "$.safety_policy.safe_hold_impulse_threshold_n_s", "SafetyPolicyViolation");
  validatePositiveFinite(policy.warning_impulse_threshold_n_s, issues, "$.safety_policy.warning_impulse_threshold_n_s", "SafetyPolicyViolation");
  validatePositiveFinite(policy.max_object_nudge_m, issues, "$.safety_policy.max_object_nudge_m", "SafetyPolicyViolation");
  validatePositiveFinite(policy.max_api_delay_ms, issues, "$.safety_policy.max_api_delay_ms", "SafetyPolicyViolation");
  validatePositiveFinite(policy.sensor_fault_window_s, issues, "$.safety_policy.sensor_fault_window_s", "SafetyPolicyViolation");
  if (policy.warning_impulse_threshold_n_s > policy.safe_hold_impulse_threshold_n_s) {
    issues.push(makeIssue("error", "SafetyPolicyViolation", "$.safety_policy", "Warning impulse threshold must not exceed safe-hold threshold.", "Lower warning threshold or raise safe-hold threshold."));
  }
}

function validateRuntimeState(runtime: DisturbanceRuntimeState): void {
  const issues: ValidationIssue[] = [];
  if (!Number.isInteger(runtime.current_tick) || runtime.current_tick < 0) {
    issues.push(makeIssue("error", "RuntimeStateInvalid", "$.current_tick", "Current tick must be a nonnegative integer.", "Use scheduler tick state."));
  }
  validateNonNegativeFinite(runtime.current_time_s, issues, "$.current_time_s", "RuntimeStateInvalid");
  if (!["normal", "reduced_speed", "safe_hold", "emergency_stop"].includes(runtime.safety_mode)) {
    issues.push(makeIssue("error", "RuntimeStateInvalid", "$.safety_mode", "Runtime safety mode is unsupported.", "Use normal, reduced_speed, safe_hold, or emergency_stop."));
  }
  if (issues.some((issue) => issue.severity === "error")) {
    throw new DisturbanceInjectionServiceError("Runtime state failed disturbance validation.", issues);
  }
}

function validateSnapshot(snapshot: PhysicsWorldSnapshot): void {
  const issues: ValidationIssue[] = [];
  validateRef(snapshot.snapshot_ref, issues, "$.snapshot_ref", "SnapshotInvalid");
  validateRef(snapshot.world_ref, issues, "$.world_ref", "SnapshotInvalid");
  if (!Number.isInteger(snapshot.physics_tick) || snapshot.physics_tick < 0) {
    issues.push(makeIssue("error", "SnapshotInvalid", "$.physics_tick", "Physics tick must be a nonnegative integer.", "Use snapshots emitted by SimulationWorldService."));
  }
  validateNonNegativeFinite(snapshot.timestamp_s, issues, "$.timestamp_s", "SnapshotInvalid");
  if (issues.some((issue) => issue.severity === "error")) {
    throw new DisturbanceInjectionServiceError("Physics snapshot failed disturbance validation.", issues);
  }
}

function reject(disturbanceId: Ref, reasonCode: DisturbanceValidationCode, message: string, remediation: string): DisturbanceRejection {
  return Object.freeze({
    disturbance_id: disturbanceId,
    reason_code: reasonCode,
    message,
    remediation,
  });
}

function validateRef(value: string, issues: ValidationIssue[], path: string, code: DisturbanceValidationCode): void {
  if (typeof value !== "string" || value.trim().length === 0 || /\s/.test(value)) {
    issues.push(makeIssue("error", code, path, "Reference must be a non-empty whitespace-free string.", "Use an opaque trace ref without spaces."));
  }
}

function validatePositiveFinite(value: number, issues: ValidationIssue[], path: string, code: DisturbanceValidationCode): void {
  if (!Number.isFinite(value) || value <= 0) {
    issues.push(makeIssue("error", code, path, "Value must be positive and finite.", "Provide a positive finite value."));
  }
}

function validateNonNegativeFinite(value: number, issues: ValidationIssue[], path: string, code: DisturbanceValidationCode): void {
  if (!Number.isFinite(value) || value < 0) {
    issues.push(makeIssue("error", code, path, "Value must be nonnegative and finite.", "Provide a nonnegative finite value."));
  }
}

function makeIssue(severity: ValidationSeverity, code: DisturbanceValidationCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function freezeTransform(transform: Transform): Transform {
  return Object.freeze({
    frame_ref: transform.frame_ref,
    position_m: freezeVector3(transform.position_m),
    orientation_xyzw: Object.freeze([transform.orientation_xyzw[0], transform.orientation_xyzw[1], transform.orientation_xyzw[2], transform.orientation_xyzw[3]]) as unknown as Quaternion,
  });
}

function freezeVector3(value: Vector3): Vector3 {
  return Object.freeze([round6(value[0]), round6(value[1]), round6(value[2])]) as unknown as Vector3;
}

function addVector3(a: Vector3, b: Vector3): Vector3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scaleVector3(value: Vector3, scalar: number): Vector3 {
  return [value[0] * scalar, value[1] * scalar, value[2] * scalar];
}

function vectorNorm(value: Vector3): number {
  return Math.sqrt(value[0] * value[0] + value[1] * value[1] + value[2] * value[2]);
}

function normalizeVector(value: Vector3): Vector3 {
  const norm = vectorNorm(value);
  if (norm < 1e-12) {
    return [1, 0, 0];
  }
  return [value[0] / norm, value[1] / norm, value[2] / norm];
}

function round6(value: number): number {
  return Math.round(value * 1000000) / 1000000;
}

function round9(value: number): number {
  return Math.round(value * 1000000000) / 1000000000;
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
