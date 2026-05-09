/**
 * Actuator application gateway for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/03_SIMULATION_AND_PHYSICS_ENGINE_ARCHITECTURE.md`
 * sections 3.3, 3.5, 3.9, 3.10, 3.17.2, 3.18.1, 3.19, and 3.20, with
 * actuator command contracts aligned to architecture files 04 and 11.
 *
 * The gateway is the only simulation-facing boundary that converts
 * deterministic control-stack actuator requests into physics-ready actuator
 * commands. It verifies validator approval, command freshness, ownership,
 * declared actuator and joint mappings, command-mode compatibility, safety
 * envelope limits, proportional-derivative effort estimates, and saturation
 * policy before physics can consume the command batch.
 */

import { ArticulatedBodyRegistry } from "./articulated_body_registry";
import { computeDeterminismHash } from "./world_manifest";
import type { ActuatorDescriptor, EmbodimentPhysicsDescriptor, JointDescriptor, JointGroup } from "./articulated_body_registry";
import type { ActuatorCommand, ActuatorCommandKind, CommandAuthorization } from "./physics_step_scheduler";
import type { Ref, ValidationIssue, ValidationSeverity } from "./world_manifest";

export const ACTUATOR_APPLICATION_GATEWAY_SCHEMA_VERSION = "mebsuta.actuator_application_gateway.v1" as const;
const DEFAULT_COMMAND_STALE_AFTER_TICKS = 1;
const DEFAULT_COMMAND_STALE_AFTER_S = 1 / 60;
const DEFAULT_IMPEDANCE_STIFFNESS_LIMIT = 2000;
const DEFAULT_IMPEDANCE_DAMPING_LIMIT = 200;
const DEFAULT_POSITION_DELTA_LIMIT_RAD = Math.PI;

export type GatewaySourceComponent =
  | "MotionPrimitiveExecutor"
  | "PDControlService"
  | "SafeHoldController"
  | "ReplayRecorder"
  | "GeminiRoboticsER"
  | "OperatorConsole"
  | "Unknown";

export type GatewayCommandMode = "position" | "velocity" | "torque" | "grip_force" | "impedance" | "hold";
export type GatewayApplicationStatus = "applied" | "delayed" | "rejected" | "saturated" | "safe_hold_required";
export type GatewayHealthStatus = "healthy" | "degraded" | "disabled";
export type GatewaySafetyMode = "normal" | "reduced_speed" | "safe_hold" | "emergency_stop";
export type SaturationFlag = "position_min" | "position_max" | "velocity" | "effort" | "stiffness" | "damping" | "safety_envelope";

export interface SafetyEnvelope {
  readonly safety_envelope_ref: Ref;
  readonly allowed_actuator_refs?: readonly Ref[];
  readonly allowed_joint_groups?: readonly JointGroup[];
  readonly max_position_delta_rad?: number;
  readonly max_velocity_rad_per_s?: number;
  readonly max_effort_n_m?: number;
  readonly max_stiffness_n_m_per_rad?: number;
  readonly max_damping_n_m_s_per_rad?: number;
  readonly stale_after_ticks?: number;
  readonly stale_after_s?: number;
  readonly allow_saturation_clipping: boolean;
  readonly safe_hold_on_saturation: boolean;
}

export interface RuntimeJointState {
  readonly joint_ref: Ref;
  readonly position_rad: number;
  readonly velocity_rad_per_s: number;
  readonly effort_n_m?: number;
  readonly health_status?: GatewayHealthStatus;
}

export interface GatewayRuntimeState {
  readonly current_tick: number;
  readonly current_time_s: number;
  readonly safety_mode: GatewaySafetyMode;
  readonly active_primitive_ref?: Ref;
  readonly command_owner_ref?: Ref;
  readonly joint_state_by_ref: Readonly<Record<Ref, RuntimeJointState>>;
}

export interface ControlStackActuatorCommand {
  readonly command_id: Ref;
  readonly approved_plan_ref?: Ref;
  readonly validation_decision_ref?: Ref;
  readonly safety_envelope_ref: Ref;
  readonly primitive_ref: Ref;
  readonly embodiment_ref: Ref;
  readonly actuator_id: Ref;
  readonly command_mode: GatewayCommandMode;
  readonly source_component: GatewaySourceComponent;
  readonly authorization: CommandAuthorization;
  readonly scheduled_tick: number;
  readonly target_timestamp_s: number;
  readonly issued_at_s: number;
  readonly expires_after_tick?: number;
  readonly priority?: number;
  readonly target_position_rad?: number;
  readonly target_velocity_rad_per_s?: number;
  readonly target_effort_n_m?: number;
  readonly stiffness_n_m_per_rad?: number;
  readonly damping_n_m_s_per_rad?: number;
}

export interface ActuatorApplicationGatewayConfig {
  readonly articulated_registry: ArticulatedBodyRegistry;
  readonly default_safety_envelope?: Partial<SafetyEnvelope>;
  readonly accepted_sources?: readonly GatewaySourceComponent[];
}

export interface ActuatorFeedbackPacket {
  readonly feedback_packet_id: Ref;
  readonly actuator_id: Ref;
  readonly command_ref: Ref;
  readonly joint_ref: Ref;
  readonly applied_status: GatewayApplicationStatus;
  readonly saturation_flags: readonly SaturationFlag[];
  readonly latency_ms: number;
  readonly health_status: GatewayHealthStatus;
  readonly message: string;
  readonly determinism_hash: string;
}

export interface GatewayRejection {
  readonly command_id: Ref;
  readonly reason_code: GatewayValidationCode;
  readonly message: string;
  readonly remediation: string;
}

export interface ActuatorApplicationRecord {
  readonly command_id: Ref;
  readonly actuator_id: Ref;
  readonly joint_ref: Ref;
  readonly command_kind: ActuatorCommandKind;
  readonly scheduled_tick: number;
  readonly application_tick: number;
  readonly target_position_rad?: number;
  readonly target_velocity_rad_per_s?: number;
  readonly target_effort_n_m?: number;
  readonly stiffness_n_m_per_rad?: number;
  readonly damping_n_m_s_per_rad?: number;
  readonly estimated_pd_effort_n_m?: number;
  readonly saturation_flags: readonly SaturationFlag[];
  readonly latency_ms: number;
  readonly determinism_hash: string;
}

export interface ActuatorApplicationGatewayReport {
  readonly schema_version: typeof ACTUATOR_APPLICATION_GATEWAY_SCHEMA_VERSION;
  readonly report_ref: Ref;
  readonly embodiment_ref: Ref;
  readonly application_tick: number;
  readonly timestamp_s: number;
  readonly physics_ready_commands: readonly ActuatorCommand[];
  readonly application_records: readonly ActuatorApplicationRecord[];
  readonly feedback_packets: readonly ActuatorFeedbackPacket[];
  readonly rejected_commands: readonly GatewayRejection[];
  readonly delayed_command_ids: readonly Ref[];
  readonly safe_hold_required: boolean;
  readonly issue_count: number;
  readonly issues: readonly ValidationIssue[];
  readonly cognitive_visibility: "runtime_control_and_qa_only";
  readonly determinism_hash: string;
}

export interface CognitiveSafeActuatorFeedbackSummary {
  readonly command_ref: Ref;
  readonly applied_status: GatewayApplicationStatus;
  readonly actuator_summary: "declared_actuator_feedback";
  readonly saturation_summary: "none" | "limit_reached" | "safety_hold_recommended";
  readonly health_status: GatewayHealthStatus;
  readonly prompt_safe_summary: string;
  readonly hidden_fields_removed: readonly string[];
}

export class ActuatorApplicationGatewayError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "ActuatorApplicationGatewayError";
    this.issues = issues;
  }
}

/**
 * Validates control-stack actuator commands and prepares scheduler input.
 *
 * The class performs no semantic planning and never mutates world state. Its
 * output is a deterministic batch of `ActuatorCommand` objects that the
 * `PhysicsStepScheduler` may apply at fixed tick boundaries.
 */
export class ActuatorApplicationGateway {
  private readonly acceptedSources: ReadonlySet<GatewaySourceComponent>;
  private readonly defaultEnvelope: SafetyEnvelope;

  public constructor(private readonly config: ActuatorApplicationGatewayConfig) {
    this.acceptedSources = new Set(config.accepted_sources ?? ["MotionPrimitiveExecutor", "PDControlService", "SafeHoldController", "ReplayRecorder"]);
    this.defaultEnvelope = Object.freeze({
      safety_envelope_ref: config.default_safety_envelope?.safety_envelope_ref ?? "default_actuator_safety_envelope",
      allowed_actuator_refs: freezeOptionalArray(config.default_safety_envelope?.allowed_actuator_refs),
      allowed_joint_groups: freezeOptionalArray(config.default_safety_envelope?.allowed_joint_groups),
      max_position_delta_rad: config.default_safety_envelope?.max_position_delta_rad ?? DEFAULT_POSITION_DELTA_LIMIT_RAD,
      max_velocity_rad_per_s: config.default_safety_envelope?.max_velocity_rad_per_s,
      max_effort_n_m: config.default_safety_envelope?.max_effort_n_m,
      max_stiffness_n_m_per_rad: config.default_safety_envelope?.max_stiffness_n_m_per_rad ?? DEFAULT_IMPEDANCE_STIFFNESS_LIMIT,
      max_damping_n_m_s_per_rad: config.default_safety_envelope?.max_damping_n_m_s_per_rad ?? DEFAULT_IMPEDANCE_DAMPING_LIMIT,
      stale_after_ticks: config.default_safety_envelope?.stale_after_ticks ?? DEFAULT_COMMAND_STALE_AFTER_TICKS,
      stale_after_s: config.default_safety_envelope?.stale_after_s ?? DEFAULT_COMMAND_STALE_AFTER_S,
      allow_saturation_clipping: config.default_safety_envelope?.allow_saturation_clipping ?? true,
      safe_hold_on_saturation: config.default_safety_envelope?.safe_hold_on_saturation ?? true,
    });
    validateSafetyEnvelope(this.defaultEnvelope);
  }

  /**
   * Converts a command batch into physics-ready actuator commands.
   *
   * Commands are processed in deterministic order by scheduled tick, priority,
   * and command id. Invalid commands become rejection records; future commands
   * become delayed ids; clipped commands become saturated feedback records.
   */
  public validateAndApplyActuatorBatch(input: {
    readonly embodiment_ref: Ref;
    readonly commands: readonly ControlStackActuatorCommand[];
    readonly safety_envelope?: Partial<SafetyEnvelope>;
    readonly runtime_state: GatewayRuntimeState;
  }): ActuatorApplicationGatewayReport {
    validateRuntimeState(input.runtime_state);
    const descriptor = this.config.articulated_registry.get(input.embodiment_ref);
    if (descriptor.embodiment_ref !== input.embodiment_ref) {
      throw new ActuatorApplicationGatewayError(`Embodiment ${input.embodiment_ref} is not active for actuator application.`, [
        makeIssue("error", "EmbodimentMismatch", "$.embodiment_ref", "Command batch embodiment does not match the registered descriptor.", "Route commands to the active embodiment only."),
      ]);
    }

    const envelope = this.mergeEnvelope(input.safety_envelope);
    const issues: ValidationIssue[] = [];
    const records: ActuatorApplicationRecord[] = [];
    const feedback: ActuatorFeedbackPacket[] = [];
    const rejected: GatewayRejection[] = [];
    const delayed: Ref[] = [];
    const physicsReady: ActuatorCommand[] = [];

    for (const command of [...input.commands].sort(compareGatewayCommands)) {
      const result = this.evaluateCommand(command, descriptor, envelope, input.runtime_state);
      issues.push(...result.issues);
      if (result.outcome === "rejected") {
        rejected.push(result.rejection);
        feedback.push(result.feedback);
        continue;
      }
      if (result.outcome === "delayed") {
        delayed.push(command.command_id);
        feedback.push(result.feedback);
        continue;
      }
      records.push(result.record);
      feedback.push(result.feedback);
      physicsReady.push(result.physics_command);
    }

    const safeHoldRequired = feedback.some((packet) => packet.applied_status === "safe_hold_required")
      || input.runtime_state.safety_mode === "safe_hold"
      || input.runtime_state.safety_mode === "emergency_stop";
    const reportBase = {
      schema_version: ACTUATOR_APPLICATION_GATEWAY_SCHEMA_VERSION,
      report_ref: `actuator_gateway_${input.embodiment_ref}_${input.runtime_state.current_tick}`,
      embodiment_ref: input.embodiment_ref,
      application_tick: input.runtime_state.current_tick,
      timestamp_s: input.runtime_state.current_time_s,
      physics_ready_commands: freezeArray(physicsReady),
      application_records: freezeArray(records),
      feedback_packets: freezeArray(feedback),
      rejected_commands: freezeArray(rejected),
      delayed_command_ids: freezeArray(delayed),
      safe_hold_required: safeHoldRequired,
      issue_count: issues.length,
      issues: freezeArray(issues),
      cognitive_visibility: "runtime_control_and_qa_only" as const,
    };

    return Object.freeze({
      ...reportBase,
      determinism_hash: computeDeterminismHash(reportBase),
    });
  }

  /**
   * Converts gateway feedback into a compact sensor-safe execution summary.
   *
   * Exact actuator ids, joint refs, command targets, limit values, and
   * determinism hashes are intentionally removed because they are internal
   * simulator and control details.
   */
  public redactFeedbackForCognition(packet: ActuatorFeedbackPacket): CognitiveSafeActuatorFeedbackSummary {
    const saturationSummary = packet.applied_status === "safe_hold_required"
      ? "safety_hold_recommended"
      : packet.saturation_flags.length > 0
        ? "limit_reached"
        : "none";
    return Object.freeze({
      command_ref: packet.command_ref,
      applied_status: packet.applied_status,
      actuator_summary: "declared_actuator_feedback",
      saturation_summary: saturationSummary,
      health_status: packet.health_status,
      prompt_safe_summary: buildPromptSafeFeedback(packet),
      hidden_fields_removed: freezeArray([
        "actuator_id",
        "joint_ref",
        "exact_target_values",
        "exact_limit_values",
        "determinism_hash",
      ]),
    });
  }

  private mergeEnvelope(override: Partial<SafetyEnvelope> | undefined): SafetyEnvelope {
    const envelope = Object.freeze({
      ...this.defaultEnvelope,
      ...(override ?? {}),
      safety_envelope_ref: override?.safety_envelope_ref ?? this.defaultEnvelope.safety_envelope_ref,
      allowed_actuator_refs: freezeOptionalArray(override?.allowed_actuator_refs ?? this.defaultEnvelope.allowed_actuator_refs),
      allowed_joint_groups: freezeOptionalArray(override?.allowed_joint_groups ?? this.defaultEnvelope.allowed_joint_groups),
      allow_saturation_clipping: override?.allow_saturation_clipping ?? this.defaultEnvelope.allow_saturation_clipping,
      safe_hold_on_saturation: override?.safe_hold_on_saturation ?? this.defaultEnvelope.safe_hold_on_saturation,
    });
    validateSafetyEnvelope(envelope);
    return envelope;
  }

  private evaluateCommand(
    command: ControlStackActuatorCommand,
    descriptor: EmbodimentPhysicsDescriptor,
    envelope: SafetyEnvelope,
    runtime: GatewayRuntimeState,
  ): CommandEvaluation {
    const validation = this.validateCommandEnvelope(command, descriptor, envelope, runtime);
    if (validation.blocking !== undefined) {
      const feedback = buildFeedback(command, validation.blocking.status, validation.blocking.flags, 0, "degraded", validation.blocking.message, descriptor);
      return Object.freeze({
        outcome: "rejected" as const,
        rejection: rejectCommand(command.command_id || "invalid_command", validation.blocking.code, validation.blocking.message, validation.blocking.remediation),
        feedback,
        issues: freezeArray(validation.issues),
      });
    }
    const actuator = requireActuator(descriptor, command.actuator_id);
    const joint = requireJoint(descriptor, actuator.joint_ref);
    const state = runtime.joint_state_by_ref[joint.joint_ref];
    const timing = classifyTiming(command, envelope, runtime);
    if (timing === "future") {
      return Object.freeze({
        outcome: "delayed" as const,
        feedback: buildFeedback(command, "delayed", [], Math.max(0, command.target_timestamp_s - runtime.current_time_s) * 1000, state?.health_status ?? "healthy", "Command is scheduled for a future physics tick.", descriptor),
        issues: freezeArray(validation.issues),
      });
    }
    if (timing === "expired") {
      const issue = makeIssue("error", "CommandStale", "$.target_timestamp_s", "Actuator command is older than the safety envelope permits.", "Issue a fresh control command for the current physics tick.");
      return Object.freeze({
        outcome: "rejected" as const,
        rejection: rejectCommand(command.command_id, "CommandStale", issue.message, issue.remediation),
        feedback: buildFeedback(command, "rejected", [], 0, "degraded", issue.message, descriptor),
        issues: freezeArray([...validation.issues, issue]),
      });
    }

    const normalized = normalizeTargets(command, actuator, joint, state, envelope);
    if (!isAcceptedNormalizedTarget(normalized)) {
      const issue = makeIssue(
        normalized.status === "safe_hold_required" ? "error" : "warning",
        normalized.status === "safe_hold_required" ? "ActuatorSaturated" : "TargetOutOfRange",
        "$.target_value",
        normalized.message,
        normalized.status === "safe_hold_required" ? "Enter safe-hold and inspect actuator load or command feasibility." : "Retarget within actuator and safety-envelope limits.",
      );
      return Object.freeze({
        outcome: "rejected" as const,
        rejection: rejectCommand(command.command_id, issue.code as GatewayValidationCode, issue.message, issue.remediation),
        feedback: buildFeedback(command, normalized.status, normalized.flags, computeLatencyMs(command, runtime), state?.health_status ?? "degraded", normalized.message, descriptor),
        issues: freezeArray([...validation.issues, issue]),
      });
    }

    const acceptedTarget = normalized;
    const commandKind = toSchedulerKind(command.command_mode);
    const physicsBase: ActuatorCommand = Object.freeze({
      command_id: command.command_id,
      target_actuator_ref: actuator.actuator_ref,
      source_component: command.source_component === "ReplayRecorder" ? "ReplayRecorder" : "ActuatorApplicationGateway",
      authorization: command.authorization,
      command_kind: commandKind,
      scheduled_tick: command.scheduled_tick,
      issued_at_s: command.issued_at_s,
      expires_after_tick: command.expires_after_tick,
      priority: command.priority ?? 0,
      target_position_rad: acceptedTarget.target_position_rad,
      target_velocity_rad_per_s: acceptedTarget.target_velocity_rad_per_s,
      target_effort_n_m: acceptedTarget.target_effort_n_m,
      stiffness_n_m_per_rad: acceptedTarget.stiffness_n_m_per_rad,
      damping_n_m_s_per_rad: acceptedTarget.damping_n_m_s_per_rad,
    });
    const recordBase = {
      command_id: command.command_id,
      actuator_id: actuator.actuator_ref,
      joint_ref: joint.joint_ref,
      command_kind: commandKind,
      scheduled_tick: command.scheduled_tick,
      application_tick: runtime.current_tick,
      target_position_rad: acceptedTarget.target_position_rad,
      target_velocity_rad_per_s: acceptedTarget.target_velocity_rad_per_s,
      target_effort_n_m: acceptedTarget.target_effort_n_m,
      stiffness_n_m_per_rad: acceptedTarget.stiffness_n_m_per_rad,
      damping_n_m_s_per_rad: acceptedTarget.damping_n_m_s_per_rad,
      estimated_pd_effort_n_m: acceptedTarget.estimated_pd_effort_n_m,
      saturation_flags: freezeArray(acceptedTarget.flags),
      latency_ms: computeLatencyMs(command, runtime),
    };
    const applicationStatus: GatewayApplicationStatus = acceptedTarget.flags.length > 0 ? "saturated" : "applied";
    return Object.freeze({
      outcome: "applied" as const,
      physics_command: physicsBase,
      record: Object.freeze({
        ...recordBase,
        determinism_hash: computeDeterminismHash(recordBase),
      }),
      feedback: buildFeedback(command, applicationStatus, acceptedTarget.flags, recordBase.latency_ms, state?.health_status ?? "healthy", acceptedTarget.message, descriptor),
      issues: freezeArray(validation.issues),
    });
  }

  private validateCommandEnvelope(
    command: ControlStackActuatorCommand,
    descriptor: EmbodimentPhysicsDescriptor,
    envelope: SafetyEnvelope,
    runtime: GatewayRuntimeState,
  ): { readonly issues: readonly ValidationIssue[]; readonly blocking?: BlockingCommandIssue } {
    const issues: ValidationIssue[] = [];
    validateRef(command.command_id, issues, "$.command_id", "CommandRefInvalid");
    validateRef(command.safety_envelope_ref, issues, "$.safety_envelope_ref", "SafetyEnvelopeMissing");
    validateRef(command.primitive_ref, issues, "$.primitive_ref", "PrimitiveRefMissing");
    validateRef(command.embodiment_ref, issues, "$.embodiment_ref", "EmbodimentMismatch");
    validateRef(command.actuator_id, issues, "$.actuator_id", "ActuatorUndeclared");
    validateNonNegativeInteger(command.scheduled_tick, issues, "$.scheduled_tick", "CommandStale");
    validateNonNegativeFinite(command.target_timestamp_s, issues, "$.target_timestamp_s", "CommandStale");
    validateNonNegativeFinite(command.issued_at_s, issues, "$.issued_at_s", "CommandStale");

    if (command.embodiment_ref !== descriptor.embodiment_ref) {
      return withBlocking(issues, "EmbodimentMismatch", "rejected", [], "Command embodiment does not match the active descriptor.", "Route commands to the active embodiment.");
    }
    if (command.approved_plan_ref === undefined || command.approved_plan_ref.trim().length === 0) {
      return withBlocking(issues, "MissingApprovalRef", "rejected", [], "Command lacks a validator-approved plan reference.", "Attach approved_plan_ref from validation before control execution.");
    }
    if (command.validation_decision_ref === undefined || command.validation_decision_ref.trim().length === 0) {
      return withBlocking(issues, "MissingApprovalRef", "rejected", [], "Command lacks a validation decision reference.", "Attach validation_decision_ref before actuator application.");
    }
    if (command.safety_envelope_ref !== envelope.safety_envelope_ref) {
      return withBlocking(issues, "SafetyEnvelopeMissing", "rejected", [], "Command safety envelope does not match the active envelope.", "Use the active safety_envelope_ref for this control interval.");
    }
    if (!this.acceptedSources.has(command.source_component) || command.source_component === "GeminiRoboticsER" || command.source_component === "Unknown") {
      return withBlocking(issues, "CommandSourceForbidden", "rejected", [], "Command source is not an approved deterministic control component.", "Route model intent through validators and deterministic control services.");
    }
    if (command.authorization !== "validator_approved" && command.authorization !== "replay_authorized") {
      return withBlocking(issues, "CommandUnauthorized", "rejected", [], "Command authorization is not valid for physics application.", "Use validator_approved or replay_authorized command provenance.");
    }
    if (runtime.safety_mode === "emergency_stop") {
      return withBlocking(issues, "EmergencyStopActive", "safe_hold_required", [], "Emergency stop is active; actuator motion is blocked.", "Clear the emergency stop only through safety authority.");
    }
    if (runtime.safety_mode === "safe_hold" && command.source_component !== "SafeHoldController" && command.command_mode !== "hold") {
      return withBlocking(issues, "SafeHoldActive", "safe_hold_required", [], "Safe-hold admits only hold commands from the safe-hold controller.", "Issue a hold command through SafeHoldController.");
    }
    if (runtime.command_owner_ref !== undefined && runtime.command_owner_ref !== command.primitive_ref) {
      return withBlocking(issues, "CommandOwnershipConflict", "safe_hold_required", [], "Command owner differs from the active primitive owner.", "Release the active command owner before issuing another primitive command.");
    }
    if (runtime.active_primitive_ref !== undefined && runtime.active_primitive_ref !== command.primitive_ref && command.source_component !== "SafeHoldController") {
      return withBlocking(issues, "CommandOwnershipConflict", "rejected", [], "Command primitive differs from runtime active primitive.", "Keep actuator commands bound to the active primitive.");
    }

    const actuator = descriptor.actuator_limit_table.find((candidate) => candidate.actuator_ref === command.actuator_id);
    if (actuator === undefined) {
      return withBlocking(issues, "ActuatorUndeclared", "rejected", [], "Actuator is not declared in the embodiment actuator table.", "Register actuator limits before command application.");
    }
    const joint = descriptor.joint_limit_table.find((candidate) => candidate.joint_ref === actuator.joint_ref);
    if (joint === undefined) {
      return withBlocking(issues, "JointUndeclared", "rejected", [], "Actuator joint is not declared in the embodiment joint table.", "Repair actuator-to-joint mapping.");
    }
    if (envelope.allowed_actuator_refs !== undefined && !envelope.allowed_actuator_refs.includes(actuator.actuator_ref)) {
      return withBlocking(issues, "SafetyEnvelopeViolation", "rejected", ["safety_envelope"], "Safety envelope does not allow this actuator.", "Use an envelope that explicitly includes the actuator.");
    }
    if (envelope.allowed_joint_groups !== undefined && !envelope.allowed_joint_groups.includes(joint.joint_group)) {
      return withBlocking(issues, "SafetyEnvelopeViolation", "rejected", ["safety_envelope"], "Safety envelope does not allow this joint group.", "Retarget to an allowed joint group or update the safety envelope.");
    }
    if (runtime.joint_state_by_ref[joint.joint_ref] === undefined) {
      return withBlocking(issues, "JointStateMissing", "rejected", [], "Runtime joint state is missing for the target actuator.", "Provide joint encoder state before PD or limit enforcement.");
    }
    if (!isModeSupported(command.command_mode, actuator)) {
      return withBlocking(issues, "UnsupportedCommandMode", "rejected", [], "Command mode is not supported by the declared actuator interface.", "Use the actuator command interface declared by the embodiment profile.");
    }

    const targetValidation = validateModeTarget(command);
    if (targetValidation !== undefined) {
      return withBlocking(issues, targetValidation.code, "rejected", [], targetValidation.message, targetValidation.remediation);
    }
    return Object.freeze({ issues: freezeArray(issues) });
  }
}

export function validateAndApplyActuatorCommand(
  actuatorCommand: ControlStackActuatorCommand,
  articulatedRegistry: ArticulatedBodyRegistry,
  safetyEnvelope: SafetyEnvelope,
  runtimeState: GatewayRuntimeState,
): ActuatorApplicationGatewayReport {
  return new ActuatorApplicationGateway({
    articulated_registry: articulatedRegistry,
    default_safety_envelope: safetyEnvelope,
  }).validateAndApplyActuatorBatch({
    embodiment_ref: actuatorCommand.embodiment_ref,
    commands: [actuatorCommand],
    runtime_state: runtimeState,
  });
}

function normalizeTargets(
  command: ControlStackActuatorCommand,
  actuator: ActuatorDescriptor,
  joint: JointDescriptor,
  state: RuntimeJointState | undefined,
  envelope: SafetyEnvelope,
): NormalizedTarget {
  const flags: SaturationFlag[] = [];
  const currentPosition = state?.position_rad ?? joint.home_position;
  const currentVelocity = state?.velocity_rad_per_s ?? 0;
  const positionBounds = [
    Math.max(actuator.position_limit[0], joint.limit.min_position),
    Math.min(actuator.position_limit[1], joint.limit.max_position),
  ] as const;
  const velocityLimit = minDefined(actuator.velocity_limit, joint.limit.max_velocity, envelope.max_velocity_rad_per_s);
  const effortLimit = minDefined(actuator.effort_limit, joint.limit.max_effort, envelope.max_effort_n_m);
  const stiffnessLimit = envelope.max_stiffness_n_m_per_rad ?? DEFAULT_IMPEDANCE_STIFFNESS_LIMIT;
  const dampingLimit = envelope.max_damping_n_m_s_per_rad ?? DEFAULT_IMPEDANCE_DAMPING_LIMIT;

  let position = command.target_position_rad;
  let velocity = command.target_velocity_rad_per_s;
  let effort = command.target_effort_n_m;
  let stiffness = command.stiffness_n_m_per_rad;
  let damping = command.damping_n_m_s_per_rad;

  if (command.command_mode === "hold") {
    position = currentPosition;
    velocity = 0;
  }
  if (position !== undefined) {
    const before = position;
    position = clamp(position, positionBounds[0], positionBounds[1]);
    if (position !== before) {
      flags.push(before < positionBounds[0] ? "position_min" : "position_max");
    }
    const deltaLimit = envelope.max_position_delta_rad ?? DEFAULT_POSITION_DELTA_LIMIT_RAD;
    const delta = position - currentPosition;
    if (Math.abs(delta) > deltaLimit) {
      position = currentPosition + Math.sign(delta) * deltaLimit;
      flags.push("safety_envelope");
    }
  }
  if (velocity !== undefined) {
    const clipped = clampAbs(velocity, velocityLimit);
    if (clipped !== velocity) {
      flags.push("velocity");
    }
    velocity = clipped;
  }
  if (effort !== undefined) {
    const clipped = clampAbs(effort, effortLimit);
    if (clipped !== effort) {
      flags.push("effort");
    }
    effort = clipped;
  }
  if (stiffness !== undefined) {
    const clipped = clamp(stiffness, 0, stiffnessLimit);
    if (clipped !== stiffness) {
      flags.push("stiffness");
    }
    stiffness = clipped;
  }
  if (damping !== undefined) {
    const clipped = clamp(damping, 0, dampingLimit);
    if (clipped !== damping) {
      flags.push("damping");
    }
    damping = clipped;
  }

  const estimatedPdEffort = position === undefined && velocity === undefined
    ? effort
    : clampAbs(
      (stiffness ?? joint.stiffness_n_m_per_rad ?? 0) * ((position ?? currentPosition) - currentPosition)
      + (damping ?? joint.damping_n_m_s_per_rad) * ((velocity ?? 0) - currentVelocity),
      effortLimit,
    );
  if (estimatedPdEffort !== undefined && Math.abs(estimatedPdEffort) >= effortLimit && effort === undefined) {
    flags.push("effort");
  }

  const uniqueFlags = uniqueFlagsOf(flags);
  if (uniqueFlags.length > 0 && actuator.saturation_policy === "safe_hold" && envelope.safe_hold_on_saturation) {
    return Object.freeze({
      status: "safe_hold_required" as const,
      flags: uniqueFlags,
      message: "Actuator command reached a limit that requires safe-hold.",
    });
  }
  if (uniqueFlags.length > 0 && (!envelope.allow_saturation_clipping || actuator.saturation_policy === "reject_command")) {
    return Object.freeze({
      status: "rejected" as const,
      flags: uniqueFlags,
      message: "Actuator command exceeds declared limits and clipping is not allowed.",
    });
  }

  return Object.freeze({
    status: uniqueFlags.length > 0 ? "saturated" as const : "applied" as const,
    target_position_rad: position,
    target_velocity_rad_per_s: velocity,
    target_effort_n_m: effort ?? estimatedPdEffort,
    stiffness_n_m_per_rad: stiffness,
    damping_n_m_s_per_rad: damping,
    estimated_pd_effort_n_m: estimatedPdEffort,
    flags: uniqueFlags,
    message: uniqueFlags.length > 0 ? "Actuator command clipped to declared limits." : "Actuator command accepted for physics application.",
  });
}

function buildFeedback(
  command: ControlStackActuatorCommand,
  status: GatewayApplicationStatus,
  flags: readonly SaturationFlag[],
  latencyMs: number,
  health: GatewayHealthStatus,
  message: string,
  descriptor: EmbodimentPhysicsDescriptor,
): ActuatorFeedbackPacket {
  const actuator = descriptor.actuator_limit_table.find((candidate) => candidate.actuator_ref === command.actuator_id);
  const packetBase = {
    feedback_packet_id: `actuator_feedback_${command.command_id}`,
    actuator_id: command.actuator_id,
    command_ref: command.command_id,
    joint_ref: actuator?.joint_ref ?? "unknown_joint",
    applied_status: status,
    saturation_flags: freezeArray(flags),
    latency_ms: roundMs(latencyMs),
    health_status: status === "rejected" || status === "safe_hold_required" ? "degraded" as const : health,
    message,
  };
  return Object.freeze({
    ...packetBase,
    determinism_hash: computeDeterminismHash(packetBase),
  });
}

function classifyTiming(command: ControlStackActuatorCommand, envelope: SafetyEnvelope, runtime: GatewayRuntimeState): "due" | "future" | "expired" {
  if (command.scheduled_tick > runtime.current_tick) {
    return "future";
  }
  const expiresAfterTick = command.expires_after_tick ?? (command.scheduled_tick + (envelope.stale_after_ticks ?? DEFAULT_COMMAND_STALE_AFTER_TICKS));
  const staleByTick = runtime.current_tick > expiresAfterTick;
  const staleAfterS = envelope.stale_after_s ?? DEFAULT_COMMAND_STALE_AFTER_S;
  const staleByTime = runtime.current_time_s - command.target_timestamp_s > staleAfterS;
  return staleByTick || staleByTime ? "expired" : "due";
}

function computeLatencyMs(command: ControlStackActuatorCommand, runtime: GatewayRuntimeState): number {
  return roundMs(Math.max(0, runtime.current_time_s - command.target_timestamp_s) * 1000);
}

function isModeSupported(mode: GatewayCommandMode, actuator: ActuatorDescriptor): boolean {
  if (mode === "hold") {
    return actuator.command_interface === "position" || actuator.command_interface === "impedance";
  }
  if (mode === "position") {
    return actuator.command_interface === "position" || actuator.command_interface === "impedance";
  }
  if (mode === "velocity") {
    return actuator.command_interface === "velocity" || actuator.command_interface === "impedance";
  }
  if (mode === "torque") {
    return actuator.command_interface === "effort" || actuator.command_interface === "impedance";
  }
  if (mode === "grip_force") {
    return actuator.command_interface === "grip" || actuator.command_interface === "effort";
  }
  return actuator.command_interface === "impedance";
}

function toSchedulerKind(mode: GatewayCommandMode): ActuatorCommandKind {
  if (mode === "position") {
    return "position_target";
  }
  if (mode === "velocity") {
    return "velocity_target";
  }
  if (mode === "torque" || mode === "grip_force") {
    return "effort_target";
  }
  if (mode === "hold") {
    return "hold_position";
  }
  return "impedance_target";
}

function validateModeTarget(command: ControlStackActuatorCommand): { readonly code: GatewayValidationCode; readonly message: string; readonly remediation: string } | undefined {
  if ((command.command_mode === "position" || command.command_mode === "hold") && command.command_mode !== "hold" && !Number.isFinite(command.target_position_rad)) {
    return Object.freeze({ code: "TargetInvalid", message: "Position command requires a finite target position.", remediation: "Provide target_position_rad in radians." });
  }
  if (command.command_mode === "velocity" && !Number.isFinite(command.target_velocity_rad_per_s)) {
    return Object.freeze({ code: "TargetInvalid", message: "Velocity command requires a finite target velocity.", remediation: "Provide target_velocity_rad_per_s." });
  }
  if ((command.command_mode === "torque" || command.command_mode === "grip_force") && !Number.isFinite(command.target_effort_n_m)) {
    return Object.freeze({ code: "TargetInvalid", message: "Effort command requires a finite target effort.", remediation: "Provide target_effort_n_m." });
  }
  if (command.command_mode === "impedance") {
    if (!Number.isFinite(command.target_position_rad) || !Number.isFinite(command.stiffness_n_m_per_rad) || !Number.isFinite(command.damping_n_m_s_per_rad)) {
      return Object.freeze({ code: "TargetInvalid", message: "Impedance command requires finite position, stiffness, and damping targets.", remediation: "Provide target_position_rad, stiffness_n_m_per_rad, and damping_n_m_s_per_rad." });
    }
    if ((command.stiffness_n_m_per_rad ?? 0) < 0 || (command.damping_n_m_s_per_rad ?? 0) < 0) {
      return Object.freeze({ code: "TargetInvalid", message: "Impedance stiffness and damping must be nonnegative.", remediation: "Use calibrated nonnegative impedance gains." });
    }
  }
  return undefined;
}

function isAcceptedNormalizedTarget(target: NormalizedTarget): target is AcceptedNormalizedTarget {
  return target.status === "applied" || target.status === "saturated";
}

function validateSafetyEnvelope(envelope: SafetyEnvelope): void {
  const issues: ValidationIssue[] = [];
  validateRef(envelope.safety_envelope_ref, issues, "$.safety_envelope_ref", "SafetyEnvelopeMissing");
  validateOptionalPositiveFinite(envelope.max_position_delta_rad, issues, "$.max_position_delta_rad", "SafetyEnvelopeInvalid");
  validateOptionalPositiveFinite(envelope.max_velocity_rad_per_s, issues, "$.max_velocity_rad_per_s", "SafetyEnvelopeInvalid");
  validateOptionalPositiveFinite(envelope.max_effort_n_m, issues, "$.max_effort_n_m", "SafetyEnvelopeInvalid");
  validateOptionalPositiveFinite(envelope.max_stiffness_n_m_per_rad, issues, "$.max_stiffness_n_m_per_rad", "SafetyEnvelopeInvalid");
  validateOptionalPositiveFinite(envelope.max_damping_n_m_s_per_rad, issues, "$.max_damping_n_m_s_per_rad", "SafetyEnvelopeInvalid");
  if (envelope.stale_after_ticks !== undefined && (!Number.isInteger(envelope.stale_after_ticks) || envelope.stale_after_ticks < 0)) {
    issues.push(makeIssue("error", "SafetyEnvelopeInvalid", "$.stale_after_ticks", "Stale tick tolerance must be a nonnegative integer.", "Use zero or a positive tick tolerance."));
  }
  if (envelope.stale_after_s !== undefined && (!Number.isFinite(envelope.stale_after_s) || envelope.stale_after_s < 0)) {
    issues.push(makeIssue("error", "SafetyEnvelopeInvalid", "$.stale_after_s", "Stale time tolerance must be nonnegative and finite.", "Use a finite time tolerance in seconds."));
  }
  if (issues.some((issue) => issue.severity === "error")) {
    throw new ActuatorApplicationGatewayError("Actuator safety envelope failed validation.", issues);
  }
}

function validateRuntimeState(runtime: GatewayRuntimeState): void {
  const issues: ValidationIssue[] = [];
  validateNonNegativeInteger(runtime.current_tick, issues, "$.current_tick", "RuntimeStateInvalid");
  validateNonNegativeFinite(runtime.current_time_s, issues, "$.current_time_s", "RuntimeStateInvalid");
  if (!["normal", "reduced_speed", "safe_hold", "emergency_stop"].includes(runtime.safety_mode)) {
    issues.push(makeIssue("error", "RuntimeStateInvalid", "$.safety_mode", "Runtime safety mode is unsupported.", "Use normal, reduced_speed, safe_hold, or emergency_stop."));
  }
  for (const [jointRef, state] of Object.entries(runtime.joint_state_by_ref)) {
    validateRef(jointRef, issues, "$.joint_state_by_ref", "RuntimeStateInvalid");
    validateRef(state.joint_ref, issues, `$.joint_state_by_ref.${jointRef}.joint_ref`, "RuntimeStateInvalid");
    validateFinite(state.position_rad, issues, `$.joint_state_by_ref.${jointRef}.position_rad`, "RuntimeStateInvalid");
    validateFinite(state.velocity_rad_per_s, issues, `$.joint_state_by_ref.${jointRef}.velocity_rad_per_s`, "RuntimeStateInvalid");
    if (state.effort_n_m !== undefined) {
      validateFinite(state.effort_n_m, issues, `$.joint_state_by_ref.${jointRef}.effort_n_m`, "RuntimeStateInvalid");
    }
    if (state.joint_ref !== jointRef) {
      issues.push(makeIssue("error", "RuntimeStateInvalid", `$.joint_state_by_ref.${jointRef}`, "Joint state key and payload ref differ.", "Use the same joint_ref in the record key and state payload."));
    }
  }
  if (issues.some((issue) => issue.severity === "error")) {
    throw new ActuatorApplicationGatewayError("Runtime state failed actuator gateway validation.", issues);
  }
}

function buildPromptSafeFeedback(packet: ActuatorFeedbackPacket): string {
  if (packet.applied_status === "safe_hold_required") {
    return "Actuator feedback recommends safe-hold before continuing motion.";
  }
  if (packet.applied_status === "rejected") {
    return "An actuator command was rejected by deterministic control safeguards.";
  }
  if (packet.applied_status === "saturated") {
    return "An actuator command reached a declared limit and was clipped by the controller.";
  }
  if (packet.applied_status === "delayed") {
    return "An actuator command is scheduled for a later control tick.";
  }
  return "An approved actuator command was accepted by the deterministic controller.";
}

function compareGatewayCommands(a: ControlStackActuatorCommand, b: ControlStackActuatorCommand): number {
  return a.scheduled_tick - b.scheduled_tick
    || (b.priority ?? 0) - (a.priority ?? 0)
    || a.command_id.localeCompare(b.command_id);
}

function requireActuator(descriptor: EmbodimentPhysicsDescriptor, actuatorRef: Ref): ActuatorDescriptor {
  const actuator = descriptor.actuator_limit_table.find((candidate) => candidate.actuator_ref === actuatorRef);
  if (actuator === undefined) {
    throw new ActuatorApplicationGatewayError(`Unknown actuator ref: ${actuatorRef}`, [
      makeIssue("error", "ActuatorUndeclared", "$.actuator_id", "Actuator is not declared.", "Register the actuator in the embodiment actuator table."),
    ]);
  }
  return actuator;
}

function requireJoint(descriptor: EmbodimentPhysicsDescriptor, jointRef: Ref): JointDescriptor {
  const joint = descriptor.joint_limit_table.find((candidate) => candidate.joint_ref === jointRef);
  if (joint === undefined) {
    throw new ActuatorApplicationGatewayError(`Unknown joint ref: ${jointRef}`, [
      makeIssue("error", "JointUndeclared", "$.joint_ref", "Joint is not declared.", "Register the joint in the embodiment joint table."),
    ]);
  }
  return joint;
}

function withBlocking(
  issues: ValidationIssue[],
  code: GatewayValidationCode,
  status: GatewayApplicationStatus,
  flags: readonly SaturationFlag[],
  message: string,
  remediation: string,
): { readonly issues: readonly ValidationIssue[]; readonly blocking: BlockingCommandIssue } {
  issues.push(makeIssue(status === "safe_hold_required" ? "error" : "error", code, "$.command", message, remediation));
  return Object.freeze({
    issues: freezeArray(issues),
    blocking: Object.freeze({ code, status, flags: freezeArray(flags), message, remediation }),
  });
}

function rejectCommand(commandId: Ref, reasonCode: GatewayValidationCode, message: string, remediation: string): GatewayRejection {
  return Object.freeze({
    command_id: commandId,
    reason_code: reasonCode,
    message,
    remediation,
  });
}

function minDefined(...values: readonly (number | undefined)[]): number {
  const finite = values.filter((value): value is number => Number.isFinite(value));
  return finite.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...finite);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampAbs(value: number, limit: number): number {
  if (!Number.isFinite(limit)) {
    return value;
  }
  return clamp(value, -Math.abs(limit), Math.abs(limit));
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function uniqueFlagsOf(flags: readonly SaturationFlag[]): readonly SaturationFlag[] {
  return freezeArray([...new Set(flags)]);
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

function freezeOptionalArray<T>(values: readonly T[] | undefined): readonly T[] | undefined {
  return values === undefined ? undefined : freezeArray(values);
}

function validateRef(value: string, issues: ValidationIssue[], path: string, code: GatewayValidationCode): void {
  if (typeof value !== "string" || value.trim().length === 0 || /\s/.test(value)) {
    issues.push(makeIssue("error", code, path, "Reference must be a non-empty whitespace-free string.", "Use an opaque trace ref without spaces."));
  }
}

function validateFinite(value: number, issues: ValidationIssue[], path: string, code: GatewayValidationCode): void {
  if (!Number.isFinite(value)) {
    issues.push(makeIssue("error", code, path, "Value must be finite.", "Provide a finite numeric value."));
  }
}

function validateNonNegativeFinite(value: number, issues: ValidationIssue[], path: string, code: GatewayValidationCode): void {
  if (!Number.isFinite(value) || value < 0) {
    issues.push(makeIssue("error", code, path, "Value must be nonnegative and finite.", "Provide a finite value greater than or equal to zero."));
  }
}

function validateNonNegativeInteger(value: number, issues: ValidationIssue[], path: string, code: GatewayValidationCode): void {
  if (!Number.isInteger(value) || value < 0) {
    issues.push(makeIssue("error", code, path, "Value must be a nonnegative integer.", "Provide an integer tick value."));
  }
}

function validateOptionalPositiveFinite(value: number | undefined, issues: ValidationIssue[], path: string, code: GatewayValidationCode): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    issues.push(makeIssue("error", code, path, "Value must be positive and finite when provided.", "Provide a positive finite limit or omit the field."));
  }
}

function makeIssue(severity: ValidationSeverity, code: GatewayValidationCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

type CommandEvaluation =
  | {
    readonly outcome: "applied";
    readonly physics_command: ActuatorCommand;
    readonly record: ActuatorApplicationRecord;
    readonly feedback: ActuatorFeedbackPacket;
    readonly issues: readonly ValidationIssue[];
  }
  | {
    readonly outcome: "delayed";
    readonly feedback: ActuatorFeedbackPacket;
    readonly issues: readonly ValidationIssue[];
  }
  | {
    readonly outcome: "rejected";
    readonly rejection: GatewayRejection;
    readonly feedback: ActuatorFeedbackPacket;
    readonly issues: readonly ValidationIssue[];
  };

interface BlockingCommandIssue {
  readonly code: GatewayValidationCode;
  readonly status: GatewayApplicationStatus;
  readonly flags: readonly SaturationFlag[];
  readonly message: string;
  readonly remediation: string;
}

type NormalizedTarget =
  | AcceptedNormalizedTarget
  | RejectedNormalizedTarget;

interface AcceptedNormalizedTarget {
  readonly status: "applied" | "saturated";
  readonly target_position_rad?: number;
  readonly target_velocity_rad_per_s?: number;
  readonly target_effort_n_m?: number;
  readonly stiffness_n_m_per_rad?: number;
  readonly damping_n_m_s_per_rad?: number;
  readonly estimated_pd_effort_n_m?: number;
  readonly flags: readonly SaturationFlag[];
  readonly message: string;
}

interface RejectedNormalizedTarget {
  readonly status: "rejected" | "safe_hold_required";
  readonly flags: readonly SaturationFlag[];
  readonly message: string;
}

type GatewayValidationCode =
  | "CommandRefInvalid"
  | "MissingApprovalRef"
  | "SafetyEnvelopeMissing"
  | "SafetyEnvelopeInvalid"
  | "CommandSourceForbidden"
  | "CommandUnauthorized"
  | "CommandStale"
  | "CommandOwnershipConflict"
  | "PrimitiveRefMissing"
  | "EmbodimentMismatch"
  | "ActuatorUndeclared"
  | "JointUndeclared"
  | "JointStateMissing"
  | "UnsupportedCommandMode"
  | "TargetInvalid"
  | "TargetOutOfRange"
  | "ActuatorSaturated"
  | "SafeHoldActive"
  | "EmergencyStopActive"
  | "SafetyEnvelopeViolation"
  | "RuntimeStateInvalid";
