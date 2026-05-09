/**
 * Fixed-step physics scheduler for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/03_SIMULATION_AND_PHYSICS_ENGINE_ARCHITECTURE.md`
 * sections 3.3, 3.5, 3.10, 3.14, 3.15, 3.17.2, 3.18.1, 3.19, and 3.20.
 *
 * The scheduler owns deterministic tick ordering, fixed timestep enforcement,
 * command application boundaries, scheduled disturbance boundaries, timing
 * health reporting, and replay-compatible step markers. It intentionally
 * reports simulator-truth refs and determinism hashes only for runtime, QA,
 * replay, and validator consumers; model-facing callers must use
 * `redactPhysicsStepReportForCognition`.
 */

import { SimulationWorldService, SimulationWorldServiceError } from "./simulation_world_service";
import { computeDeterminismHash } from "./world_manifest";
import type { DisturbanceEvent, Ref, ValidationIssue, ValidationSeverity } from "./world_manifest";

export const PHYSICS_STEP_SCHEDULER_SCHEMA_VERSION = "mebsuta.physics_step_scheduler.v1" as const;
export const DEFAULT_SCHEDULER_HZ = 240;
const DEFAULT_DETERMINISM_WINDOW_TICKS = 256;

export type CommandAuthorization = "validator_approved" | "replay_authorized" | "rejected" | "unverified";
export type ActuatorCommandKind = "position_target" | "velocity_target" | "effort_target" | "impedance_target" | "hold_position";
export type StepJitterStatus = "within_tolerance" | "warning" | "safe_hold_required";
export type StepWarningCode =
  | "CommandUnauthorized"
  | "CommandStale"
  | "CommandDeferred"
  | "DisturbancePolicyViolation"
  | "DisturbanceDeferred"
  | "TimestepJitterExceeded"
  | "WorldPaused"
  | "ReplayMismatch";

export interface PhysicsStepPolicy {
  readonly physics_hz: number;
  readonly fixed_dt_s: number;
  readonly substeps_per_tick: number;
  readonly max_step_jitter_s: number;
  readonly command_stale_after_ticks: number;
  readonly reject_late_commands: boolean;
  readonly safe_hold_on_jitter: boolean;
  readonly allow_ready_world_start: boolean;
  readonly replay_mode: boolean;
  readonly determinism_window_ticks: number;
}

export interface ActuatorCommand {
  readonly command_id: Ref;
  readonly target_actuator_ref: Ref;
  readonly source_component: "ActuatorApplicationGateway" | "ReplayRecorder" | "MotionPrimitiveExecutor" | "PDControlService";
  readonly authorization: CommandAuthorization;
  readonly command_kind: ActuatorCommandKind;
  readonly scheduled_tick: number;
  readonly issued_at_s: number;
  readonly expires_after_tick?: number;
  readonly priority?: number;
  readonly target_position_rad?: number;
  readonly target_velocity_rad_per_s?: number;
  readonly target_effort_n_m?: number;
  readonly stiffness_n_m_per_rad?: number;
  readonly damping_n_m_s_per_rad?: number;
}

export interface RejectedStepItem {
  readonly ref: Ref;
  readonly reason_code: StepWarningCode;
  readonly message: string;
  readonly remediation: string;
}

export interface AppliedCommandRecord {
  readonly command_id: Ref;
  readonly target_actuator_ref: Ref;
  readonly command_kind: ActuatorCommandKind;
  readonly scheduled_tick: number;
  readonly applied_tick: number;
  readonly control_lag_ms: number;
  readonly priority: number;
  readonly determinism_hash: string;
}

export interface AppliedDisturbanceRecord {
  readonly disturbance_id: Ref;
  readonly disturbance_type: DisturbanceEvent["disturbance_type"];
  readonly applied_tick: number;
  readonly scheduled_window_s: string;
  readonly safety_policy: DisturbanceEvent["safety_policy"];
  readonly replay_seed_ref?: Ref;
  readonly determinism_hash: string;
}

export interface SchedulerClockReading {
  readonly observed_step_duration_s?: number;
  readonly sensor_sync_spread_s?: number;
  readonly render_physics_delta_s?: number;
  readonly audio_event_latency_s?: number;
}

export interface TimingHealthReport {
  readonly physics_step_mean_ms: number;
  readonly physics_step_max_ms: number;
  readonly control_lag_ms: number;
  readonly sensor_sync_spread_ms: number;
  readonly render_physics_delta_ms: number;
  readonly audio_event_latency_ms: number;
  readonly dropped_step_count: number;
  readonly jitter_ms: number;
  readonly jitter_status: StepJitterStatus;
  readonly determinism_hash: string;
}

export interface PhysicsStepInput {
  readonly actuator_command_batch: readonly ActuatorCommand[];
  readonly disturbance_batch: readonly DisturbanceEvent[];
  readonly step_policy?: Partial<PhysicsStepPolicy>;
  readonly clock_reading?: SchedulerClockReading;
  readonly qa_authorized_disturbance_ids?: readonly Ref[];
  readonly expected_replay_hash?: string;
}

export interface PhysicsStepReport {
  readonly schema_version: typeof PHYSICS_STEP_SCHEDULER_SCHEMA_VERSION;
  readonly step_report_id: Ref;
  readonly world_ref: Ref;
  readonly starting_tick: number;
  readonly completed_tick: number;
  readonly fixed_dt_s: number;
  readonly substep_dt_s: number;
  readonly substeps_executed: number;
  readonly applied_commands: readonly AppliedCommandRecord[];
  readonly rejected_commands: readonly RejectedStepItem[];
  readonly deferred_command_ids: readonly Ref[];
  readonly applied_disturbances: readonly AppliedDisturbanceRecord[];
  readonly rejected_disturbances: readonly RejectedStepItem[];
  readonly deferred_disturbance_ids: readonly Ref[];
  readonly timing_health: TimingHealthReport;
  readonly safety_relevant_warnings: readonly StepWarningCode[];
  readonly snapshot_ref: Ref;
  readonly world_state_hash: string;
  readonly determinism_hash: string;
  readonly cognitive_visibility: "forbidden_to_cognition";
}

export interface CognitiveSafeStepSummary {
  readonly step_status: "completed" | "completed_with_timing_warning" | "safe_hold_required";
  readonly timing_summary: "fixed_step_physics_internal";
  readonly command_summary: "actuator_commands_applied_at_tick_boundaries";
  readonly disturbance_summary: "disturbance_scripts_not_disclosed";
  readonly hidden_fields_removed: readonly string[];
}

export interface PhysicsStepSchedulerConfig {
  readonly default_policy?: Partial<PhysicsStepPolicy>;
  readonly max_timing_window_entries?: number;
}

export class PhysicsStepSchedulerError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "PhysicsStepSchedulerError";
    this.issues = issues;
  }
}

/**
 * Advances a `SimulationWorldService` one fixed physics tick at a time.
 *
 * The scheduler is deliberately deterministic: command and disturbance batches
 * are sorted by tick, priority, and ref before application, and all timing
 * reports are computed from explicit clock readings or the fixed timestep.
 */
export class PhysicsStepScheduler {
  private readonly defaultPolicy: Partial<PhysicsStepPolicy>;
  private readonly observedStepDurationsS: number[] = [];
  private readonly determinismWindow: string[] = [];
  private readonly maxTimingWindowEntries: number;

  public constructor(config: PhysicsStepSchedulerConfig = {}) {
    this.defaultPolicy = Object.freeze({ ...(config.default_policy ?? {}) });
    this.maxTimingWindowEntries = config.max_timing_window_entries ?? DEFAULT_DETERMINISM_WINDOW_TICKS;
    assertPositiveInteger(this.maxTimingWindowEntries, "max_timing_window_entries");
  }

  public reset(): void {
    this.observedStepDurationsS.splice(0, this.observedStepDurationsS.length);
    this.determinismWindow.splice(0, this.determinismWindow.length);
  }

  public createDefaultStepPolicy(physicsHz = DEFAULT_SCHEDULER_HZ): PhysicsStepPolicy {
    assertPositiveFinite(physicsHz, "physics_hz");
    const fixedDt = 1 / physicsHz;
    return Object.freeze({
      physics_hz: physicsHz,
      fixed_dt_s: fixedDt,
      substeps_per_tick: 1,
      max_step_jitter_s: Math.min(0.001, fixedDt * 0.25),
      command_stale_after_ticks: 1,
      reject_late_commands: true,
      safe_hold_on_jitter: true,
      allow_ready_world_start: true,
      replay_mode: false,
      determinism_window_ticks: DEFAULT_DETERMINISM_WINDOW_TICKS,
    });
  }

  public stepPhysicsWorld(world: SimulationWorldService, input: PhysicsStepInput): PhysicsStepReport {
    const baselineTiming = world.createTimingConfiguration();
    const policy = this.mergePolicy(baselineTiming.physics_hz, input.step_policy);
    validateStepPolicy(policy);
    this.ensureWorldIsSteppable(world, policy);

    const before = world.createSnapshot();
    const targetTick = before.physics_tick + 1;
    const targetTimeS = targetTick * policy.fixed_dt_s;
    const commandBoundary = this.partitionCommands(input.actuator_command_batch, targetTick, targetTimeS, policy);
    const disturbanceBoundary = this.partitionDisturbances(input.disturbance_batch, targetTick, targetTimeS, input.qa_authorized_disturbance_ids);
    const substepDt = policy.fixed_dt_s / policy.substeps_per_tick;

    world.advanceReferenceClock(1);
    const after = world.createSnapshot();

    const timingHealth = this.buildTimingHealth({
      observedStepDurationS: input.clock_reading?.observed_step_duration_s ?? policy.fixed_dt_s,
      policy,
      appliedCommands: commandBoundary.applied,
      clockReading: input.clock_reading,
      stateHash: after.determinism_hash,
    });

    const warnings = uniqueWarnings([
      ...commandBoundary.rejected.map((item) => item.reason_code),
      ...commandBoundary.deferred.map(() => "CommandDeferred" as const),
      ...disturbanceBoundary.rejected.map((item) => item.reason_code),
      ...disturbanceBoundary.deferred.map(() => "DisturbanceDeferred" as const),
      ...(timingHealth.jitter_status === "within_tolerance" ? [] : ["TimestepJitterExceeded" as const]),
    ]);

    if (timingHealth.jitter_status === "safe_hold_required") {
      world.pause("Physics scheduler entered safe-hold after timestep jitter exceeded tolerance.");
    }

    const reportBase = {
      schema_version: PHYSICS_STEP_SCHEDULER_SCHEMA_VERSION,
      step_report_id: `physics_step_${after.world_ref}_${after.physics_tick}`,
      world_ref: after.world_ref,
      starting_tick: before.physics_tick,
      completed_tick: after.physics_tick,
      fixed_dt_s: policy.fixed_dt_s,
      substep_dt_s: substepDt,
      substeps_executed: policy.substeps_per_tick,
      applied_commands: freezeReadonlyArray(commandBoundary.applied),
      rejected_commands: freezeReadonlyArray(commandBoundary.rejected),
      deferred_command_ids: freezeReadonlyArray(commandBoundary.deferred.map((command) => command.command_id)),
      applied_disturbances: freezeReadonlyArray(disturbanceBoundary.applied),
      rejected_disturbances: freezeReadonlyArray(disturbanceBoundary.rejected),
      deferred_disturbance_ids: freezeReadonlyArray(disturbanceBoundary.deferred.map((disturbance) => disturbance.disturbance_id)),
      timing_health: timingHealth,
      safety_relevant_warnings: freezeReadonlyArray(warnings),
      snapshot_ref: after.snapshot_ref,
      world_state_hash: after.determinism_hash,
      cognitive_visibility: "forbidden_to_cognition" as const,
    };

    const determinismHash = computeDeterminismHash({
      reportBase,
      prior_world_hash: before.determinism_hash,
      policy,
      command_ids: input.actuator_command_batch.map((command) => command.command_id).sort(),
      disturbance_ids: input.disturbance_batch.map((disturbance) => disturbance.disturbance_id).sort(),
    });

    if (input.expected_replay_hash !== undefined && input.expected_replay_hash !== determinismHash) {
      throw new PhysicsStepSchedulerError("Replay determinism marker mismatch.", [
        makeIssue("error", "ReplayMismatch", "$.expected_replay_hash", "Expected replay hash does not match computed step hash.", "Replay with the original manifest, command trace, disturbance trace, and step policy."),
      ]);
    }

    this.rememberDeterminismHash(determinismHash, policy.determinism_window_ticks);
    return Object.freeze({
      ...reportBase,
      determinism_hash: determinismHash,
    });
  }

  public getTimingWindow(): readonly number[] {
    return Object.freeze([...this.observedStepDurationsS]);
  }

  public getDeterminismWindow(): readonly string[] {
    return Object.freeze([...this.determinismWindow]);
  }

  private mergePolicy(physicsHz: number, override: Partial<PhysicsStepPolicy> | undefined): PhysicsStepPolicy {
    const base = this.createDefaultStepPolicy(physicsHz);
    const merged = {
      ...base,
      ...this.defaultPolicy,
      ...(override ?? {}),
    };
    const fixedDt = merged.fixed_dt_s ?? 1 / merged.physics_hz;
    return Object.freeze({
      ...merged,
      fixed_dt_s: fixedDt,
      physics_hz: merged.physics_hz,
    });
  }

  private ensureWorldIsSteppable(world: SimulationWorldService, policy: PhysicsStepPolicy): void {
    if (world.state === "WorldReady" && policy.allow_ready_world_start) {
      world.startStepping();
      return;
    }
    if (world.state === "WorldStepping" || world.state === "WorldReplay") {
      return;
    }
    throw new PhysicsStepSchedulerError(`World state ${world.state} cannot be stepped by PhysicsStepScheduler.`, [
      makeIssue("error", "WorldPaused", "$.lifecycle_state", "World must be ready, stepping, or replaying before scheduler execution.", "Initialize and start the simulation world before stepping."),
    ]);
  }

  private partitionCommands(
    commands: readonly ActuatorCommand[],
    targetTick: number,
    targetTimeS: number,
    policy: PhysicsStepPolicy,
  ): {
    readonly applied: readonly AppliedCommandRecord[];
    readonly rejected: readonly RejectedStepItem[];
    readonly deferred: readonly ActuatorCommand[];
  } {
    const applied: AppliedCommandRecord[] = [];
    const rejected: RejectedStepItem[] = [];
    const deferred: ActuatorCommand[] = [];

    for (const command of [...commands].sort(compareCommands)) {
      const validation = validateCommand(command);
      if (validation !== undefined) {
        rejected.push(validation);
        continue;
      }
      if (command.authorization !== "validator_approved" && command.authorization !== "replay_authorized") {
        rejected.push(rejectItem(command.command_id, "CommandUnauthorized", "Actuator command is not authorized for physics application.", "Route commands through the actuator gateway or replay recorder."));
        continue;
      }
      if (command.scheduled_tick > targetTick) {
        deferred.push(command);
        continue;
      }
      const expired = command.expires_after_tick !== undefined && targetTick > command.expires_after_tick;
      const stale = targetTick - command.scheduled_tick > policy.command_stale_after_ticks;
      if (expired || (stale && policy.reject_late_commands)) {
        rejected.push(rejectItem(command.command_id, "CommandStale", "Actuator command missed its allowed tick boundary.", "Reschedule the command against the next physics tick."));
        continue;
      }

      const controlLagS = Math.max(0, targetTimeS - command.issued_at_s);
      const recordBase = {
        command_id: command.command_id,
        target_actuator_ref: command.target_actuator_ref,
        command_kind: command.command_kind,
        scheduled_tick: command.scheduled_tick,
        applied_tick: targetTick,
        control_lag_ms: secondsToMilliseconds(controlLagS),
        priority: command.priority ?? 0,
      };
      applied.push(Object.freeze({
        ...recordBase,
        determinism_hash: computeDeterminismHash(recordBase),
      }));
    }

    return Object.freeze({
      applied: freezeReadonlyArray(applied),
      rejected: freezeReadonlyArray(rejected),
      deferred: freezeReadonlyArray(deferred),
    });
  }

  private partitionDisturbances(
    disturbances: readonly DisturbanceEvent[],
    targetTick: number,
    targetTimeS: number,
    authorizedIds: readonly Ref[] | undefined,
  ): {
    readonly applied: readonly AppliedDisturbanceRecord[];
    readonly rejected: readonly RejectedStepItem[];
    readonly deferred: readonly DisturbanceEvent[];
  } {
    const applied: AppliedDisturbanceRecord[] = [];
    const rejected: RejectedStepItem[] = [];
    const deferred: DisturbanceEvent[] = [];
    const authorized = authorizedIds === undefined ? undefined : new Set(authorizedIds);

    for (const disturbance of [...disturbances].sort(compareDisturbances)) {
      if (!isNonEmptyRef(disturbance.disturbance_id)) {
        rejected.push(rejectItem("invalid_disturbance", "DisturbancePolicyViolation", "Disturbance ref is invalid.", "Provide an opaque disturbance_id."));
        continue;
      }
      if (authorized !== undefined && !authorized.has(disturbance.disturbance_id)) {
        rejected.push(rejectItem(disturbance.disturbance_id, "DisturbancePolicyViolation", "Disturbance is not QA-authorized for this step.", "Authorize the disturbance in the scenario schedule before execution."));
        continue;
      }
      const timing = classifyDisturbanceTiming(disturbance, targetTick, targetTimeS);
      if (timing === "future") {
        deferred.push(disturbance);
        continue;
      }
      if (timing === "missed") {
        rejected.push(rejectItem(disturbance.disturbance_id, "DisturbanceDeferred", "Disturbance schedule is behind the current tick boundary.", "Replay from the original tick or reschedule the disturbance."));
        continue;
      }
      if (disturbance.safety_policy === "safe_hold_if_severe" && disturbance.disturbance_type === "physics_glitch") {
        rejected.push(rejectItem(disturbance.disturbance_id, "DisturbancePolicyViolation", "Severe physics glitch disturbances require an explicit safety manager handoff.", "Execute the disturbance through chaos testing with safe-hold authority."));
        continue;
      }

      const recordBase = {
        disturbance_id: disturbance.disturbance_id,
        disturbance_type: disturbance.disturbance_type,
        applied_tick: targetTick,
        scheduled_window_s: describeScheduledTime(disturbance.scheduled_time),
        safety_policy: disturbance.safety_policy,
        replay_seed_ref: disturbance.replay_seed_ref,
      };
      applied.push(Object.freeze({
        ...recordBase,
        determinism_hash: computeDeterminismHash(recordBase),
      }));
    }

    return Object.freeze({
      applied: freezeReadonlyArray(applied),
      rejected: freezeReadonlyArray(rejected),
      deferred: freezeReadonlyArray(deferred),
    });
  }

  private buildTimingHealth(input: {
    readonly observedStepDurationS: number;
    readonly policy: PhysicsStepPolicy;
    readonly appliedCommands: readonly AppliedCommandRecord[];
    readonly clockReading?: SchedulerClockReading;
    readonly stateHash: string;
  }): TimingHealthReport {
    assertNonNegativeFinite(input.observedStepDurationS, "observed_step_duration_s");
    this.observedStepDurationsS.push(input.observedStepDurationS);
    if (this.observedStepDurationsS.length > this.maxTimingWindowEntries) {
      this.observedStepDurationsS.splice(0, this.observedStepDurationsS.length - this.maxTimingWindowEntries);
    }

    const meanS = this.observedStepDurationsS.reduce((sum, value) => sum + value, 0) / this.observedStepDurationsS.length;
    const maxS = Math.max(...this.observedStepDurationsS);
    const jitterS = Math.abs(input.observedStepDurationS - input.policy.fixed_dt_s);
    const droppedStepCount = Math.max(0, Math.floor((input.observedStepDurationS + input.policy.max_step_jitter_s) / input.policy.fixed_dt_s) - 1);
    const jitterStatus: StepJitterStatus = jitterS <= input.policy.max_step_jitter_s
      ? "within_tolerance"
      : input.policy.safe_hold_on_jitter
        ? "safe_hold_required"
        : "warning";
    const controlLagMs = input.appliedCommands.length === 0
      ? 0
      : Math.max(...input.appliedCommands.map((command) => command.control_lag_ms));

    const reportBase = {
      physics_step_mean_ms: secondsToMilliseconds(meanS),
      physics_step_max_ms: secondsToMilliseconds(maxS),
      control_lag_ms: controlLagMs,
      sensor_sync_spread_ms: secondsToMilliseconds(input.clockReading?.sensor_sync_spread_s ?? 0),
      render_physics_delta_ms: secondsToMilliseconds(input.clockReading?.render_physics_delta_s ?? 0),
      audio_event_latency_ms: secondsToMilliseconds(input.clockReading?.audio_event_latency_s ?? 0),
      dropped_step_count: droppedStepCount,
      jitter_ms: secondsToMilliseconds(jitterS),
      jitter_status: jitterStatus,
    };

    return Object.freeze({
      ...reportBase,
      determinism_hash: computeDeterminismHash({ reportBase, state_hash: input.stateHash }),
    });
  }

  private rememberDeterminismHash(hash: string, windowSize: number): void {
    this.determinismWindow.push(hash);
    const maxEntries = Math.min(windowSize, this.maxTimingWindowEntries);
    if (this.determinismWindow.length > maxEntries) {
      this.determinismWindow.splice(0, this.determinismWindow.length - maxEntries);
    }
  }
}

export function stepPhysicsWorld(
  world: SimulationWorldService,
  actuatorCommandBatch: readonly ActuatorCommand[],
  disturbanceBatch: readonly DisturbanceEvent[],
  stepPolicy: Partial<PhysicsStepPolicy> = {},
): PhysicsStepReport {
  return new PhysicsStepScheduler().stepPhysicsWorld(world, {
    actuator_command_batch: actuatorCommandBatch,
    disturbance_batch: disturbanceBatch,
    step_policy: stepPolicy,
  });
}

export function redactPhysicsStepReportForCognition(report: PhysicsStepReport): CognitiveSafeStepSummary {
  const status = report.timing_health.jitter_status === "safe_hold_required"
    ? "safe_hold_required"
    : report.timing_health.jitter_status === "warning"
      ? "completed_with_timing_warning"
      : "completed";
  return Object.freeze({
    step_status: status,
    timing_summary: "fixed_step_physics_internal",
    command_summary: "actuator_commands_applied_at_tick_boundaries",
    disturbance_summary: "disturbance_scripts_not_disclosed",
    hidden_fields_removed: Object.freeze([
      "step_report_id",
      "world_ref",
      "applied_commands",
      "rejected_commands",
      "applied_disturbances",
      "rejected_disturbances",
      "snapshot_ref",
      "world_state_hash",
      "determinism_hash",
    ]),
  });
}

function validateStepPolicy(policy: PhysicsStepPolicy): void {
  const issues: ValidationIssue[] = [];
  if (!Number.isFinite(policy.physics_hz) || policy.physics_hz <= 0) {
    issues.push(makeIssue("error", "StepPolicyInvalid", "$.physics_hz", "Physics frequency must be positive.", "Use 240 Hz or an equivalent substep frequency."));
  }
  if (!Number.isFinite(policy.fixed_dt_s) || policy.fixed_dt_s <= 0) {
    issues.push(makeIssue("error", "StepPolicyInvalid", "$.fixed_dt_s", "Fixed timestep must be positive.", "Use 1 / physics_hz."));
  }
  if (Number.isFinite(policy.physics_hz) && Number.isFinite(policy.fixed_dt_s)) {
    const expectedDt = 1 / policy.physics_hz;
    if (Math.abs(policy.fixed_dt_s - expectedDt) > 1e-9) {
      issues.push(makeIssue("warning", "StepPolicyInvalid", "$.fixed_dt_s", "fixed_dt_s does not match 1 / physics_hz.", "Keep clock policy internally consistent for replay."));
    }
  }
  if (!Number.isInteger(policy.substeps_per_tick) || policy.substeps_per_tick <= 0) {
    issues.push(makeIssue("error", "StepPolicyInvalid", "$.substeps_per_tick", "Substeps per tick must be a positive integer.", "Use 1 or a deterministic subdivision count."));
  }
  if (!Number.isFinite(policy.max_step_jitter_s) || policy.max_step_jitter_s < 0) {
    issues.push(makeIssue("error", "StepPolicyInvalid", "$.max_step_jitter_s", "Jitter tolerance must be nonnegative.", "Use a finite tolerance such as 0.001 seconds."));
  }
  if (!Number.isInteger(policy.command_stale_after_ticks) || policy.command_stale_after_ticks < 0) {
    issues.push(makeIssue("error", "StepPolicyInvalid", "$.command_stale_after_ticks", "Command stale tolerance must be a nonnegative integer.", "Use 0 for exact tick application or 1 for one-tick tolerance."));
  }
  if (!Number.isInteger(policy.determinism_window_ticks) || policy.determinism_window_ticks <= 0) {
    issues.push(makeIssue("error", "StepPolicyInvalid", "$.determinism_window_ticks", "Determinism window must be a positive integer.", "Use a positive replay marker window."));
  }
  if (issues.some((issue) => issue.severity === "error")) {
    throw new PhysicsStepSchedulerError("Physics step policy failed validation.", issues);
  }
}

function validateCommand(command: ActuatorCommand): RejectedStepItem | undefined {
  if (!isNonEmptyRef(command.command_id) || !isNonEmptyRef(command.target_actuator_ref)) {
    return rejectItem(command.command_id || "invalid_command", "CommandUnauthorized", "Command or actuator ref is invalid.", "Use opaque non-empty refs without whitespace.");
  }
  if (!Number.isInteger(command.scheduled_tick) || command.scheduled_tick < 0) {
    return rejectItem(command.command_id, "CommandStale", "Command scheduled_tick must be a nonnegative integer.", "Schedule commands at explicit physics tick boundaries.");
  }
  if (!Number.isFinite(command.issued_at_s) || command.issued_at_s < 0) {
    return rejectItem(command.command_id, "CommandStale", "Command issued_at_s must be finite and nonnegative.", "Timestamp commands using the simulation clock.");
  }
  if (command.expires_after_tick !== undefined && (!Number.isInteger(command.expires_after_tick) || command.expires_after_tick < command.scheduled_tick)) {
    return rejectItem(command.command_id, "CommandStale", "Command expiration precedes its schedule.", "Set expires_after_tick at or after scheduled_tick.");
  }
  if (command.command_kind === "position_target" && !Number.isFinite(command.target_position_rad)) {
    return rejectItem(command.command_id, "CommandUnauthorized", "Position command requires target_position_rad.", "Provide a finite target joint angle.");
  }
  if (command.command_kind === "velocity_target" && !Number.isFinite(command.target_velocity_rad_per_s)) {
    return rejectItem(command.command_id, "CommandUnauthorized", "Velocity command requires target_velocity_rad_per_s.", "Provide a finite target joint velocity.");
  }
  if (command.command_kind === "effort_target" && !Number.isFinite(command.target_effort_n_m)) {
    return rejectItem(command.command_id, "CommandUnauthorized", "Effort command requires target_effort_n_m.", "Provide a finite actuator torque or force command.");
  }
  if (command.command_kind === "impedance_target") {
    if (!Number.isFinite(command.target_position_rad) || !Number.isFinite(command.stiffness_n_m_per_rad) || !Number.isFinite(command.damping_n_m_s_per_rad)) {
      return rejectItem(command.command_id, "CommandUnauthorized", "Impedance command requires position, stiffness, and damping.", "Provide finite impedance control parameters.");
    }
    if ((command.stiffness_n_m_per_rad ?? 0) < 0 || (command.damping_n_m_s_per_rad ?? 0) < 0) {
      return rejectItem(command.command_id, "CommandUnauthorized", "Impedance stiffness and damping must be nonnegative.", "Use calibrated nonnegative controller gains.");
    }
  }
  return undefined;
}

function classifyDisturbanceTiming(disturbance: DisturbanceEvent, targetTick: number, targetTimeS: number): "due" | "future" | "missed" {
  if ("start_s" in disturbance.scheduled_time) {
    if (targetTimeS < disturbance.scheduled_time.start_s) {
      return "future";
    }
    if (targetTimeS > disturbance.scheduled_time.end_s) {
      return "missed";
    }
    return "due";
  }
  const trigger = disturbance.scheduled_time.trigger.trim();
  if (trigger === "every_tick") {
    return "due";
  }
  if (trigger.startsWith("tick:")) {
    const tick = Number(trigger.slice("tick:".length));
    if (!Number.isInteger(tick) || tick < 0) {
      return "missed";
    }
    return tick === targetTick ? "due" : tick > targetTick ? "future" : "missed";
  }
  return "future";
}

function compareCommands(a: ActuatorCommand, b: ActuatorCommand): number {
  const tickDelta = a.scheduled_tick - b.scheduled_tick;
  if (tickDelta !== 0) {
    return tickDelta;
  }
  const priorityDelta = (b.priority ?? 0) - (a.priority ?? 0);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  return a.command_id.localeCompare(b.command_id);
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

function uniqueWarnings(values: readonly StepWarningCode[]): readonly StepWarningCode[] {
  return Object.freeze([...new Set(values)]);
}

function rejectItem(ref: Ref, reasonCode: StepWarningCode, message: string, remediation: string): RejectedStepItem {
  return Object.freeze({
    ref,
    reason_code: reasonCode,
    message,
    remediation,
  });
}

type SchedulerValidationCode = "StepPolicyInvalid" | "WorldPaused" | "ReplayMismatch";

function makeIssue(severity: ValidationSeverity, code: SchedulerValidationCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function secondsToMilliseconds(seconds: number): number {
  return Math.round(seconds * 1000000) / 1000;
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number.`);
  }
}

function assertNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a nonnegative finite number.`);
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
}

function isNonEmptyRef(value: string): boolean {
  return value.trim().length > 0 && !/\s/.test(value);
}

function freezeReadonlyArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

export { SimulationWorldServiceError };
