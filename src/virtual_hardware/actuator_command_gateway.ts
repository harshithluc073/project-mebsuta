/**
 * Actuator command gateway for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/04_VIRTUAL_HARDWARE_SENSOR_ACTUATOR_SPEC.md`
 * sections 4.3, 4.11.3, 4.11.4, 4.12, 4.15.6, 4.16.2, 4.17, and 4.18.
 *
 * The gateway is the virtual hardware command boundary. It accepts only
 * validator-approved deterministic control-stack commands, verifies that the
 * target actuator is declared in the active hardware manifest, enforces the
 * active safety envelope and declared actuator limits, rejects Gemini-direct
 * and developer-debug sources, and emits actuator feedback that can be turned
 * into embodied virtual hardware packets by `VirtualHardwareAdapter`.
 */

import type {
  ActuatorFeedbackPacket as SimulationActuatorFeedbackPacket,
  GatewayApplicationStatus,
  GatewayHealthStatus,
  SaturationFlag,
} from "../simulation/actuator_application_gateway";
import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import {
  VIRTUAL_HARDWARE_MANIFEST_REGISTRY_SCHEMA_VERSION,
  VirtualHardwareManifestRegistry,
} from "./virtual_hardware_manifest_registry";
import type {
  ActuatorCommandSource,
  ActuatorDescriptor,
  ActuatorLimitEnvelope,
  VirtualHardwareManifest,
} from "./virtual_hardware_manifest_registry";

export const ACTUATOR_COMMAND_GATEWAY_SCHEMA_VERSION = "mebsuta.actuator_command_gateway.v1" as const;

const DEFAULT_COMMAND_STALE_AFTER_S = 0.25;
const DEFAULT_FUTURE_DELAY_TOLERANCE_S = 1 / 240;
const DEFAULT_SAFE_HOLD_STALE_AFTER_S = 0.05;
const DEFAULT_AUDIO_COMMAND_BYTES = 262_144;
const DEFAULT_TOOL_STATE_BYTES = 32_768;

export type HardwareCommandMode = "position" | "velocity" | "effort" | "grip_width" | "audio_stream" | "tool_state" | "hold";
export type HardwareGatewayDecision = "applied" | "delayed" | "rejected" | "saturated" | "safe_hold_required";
export type HardwareGatewaySafetyMode = "normal" | "reduced_speed" | "safe_hold" | "emergency_stop";
export type HardwareCommandAuthorization = "validator_approved" | "replay_authorized" | "safe_hold_authorized" | "unauthorized";
export type HardwareCommandPriority = "low" | "normal" | "high" | "safety";
export type HardwareCommandVisibility = "runtime_control_only";

export type ActuatorGatewayIssueCode =
  | "ActuatorUndeclared"
  | "MissingApprovalRef"
  | "MissingSafetyEnvelope"
  | "CommandSourceForbidden"
  | "CommandUnauthorized"
  | "CommandStale"
  | "CommandDelayed"
  | "CommandModeUnsupported"
  | "TargetInvalid"
  | "TargetOutOfRange"
  | "ActuatorSaturated"
  | "RuntimeStateInvalid"
  | "SafetyEnvelopeViolation"
  | "EmergencyStopActive"
  | "SafeHoldActive"
  | "CommandOwnershipConflict"
  | "SimulationBoundaryRejected"
  | "SimulationBoundaryUnavailable";

/**
 * Mode-specific target payload. Numeric targets use manifest calibration
 * units: radians or meters for position, unit per second for velocity, and
 * calibrated effort units for effort or grip force.
 */
export interface HardwareCommandTarget {
  readonly position?: number;
  readonly velocity?: number;
  readonly effort?: number;
  readonly grip_width?: number;
  readonly audio_stream_ref?: Ref;
  readonly tool_state_ref?: Ref;
  readonly tool_state_value?: "enabled" | "disabled" | "open" | "closed" | "activate" | "deactivate";
}

/**
 * Low-level command emitted by deterministic control services.
 */
export interface HardwareActuatorCommand {
  readonly command_id: Ref;
  readonly approved_plan_ref?: Ref;
  readonly validation_decision_ref?: Ref;
  readonly actuator_id: Ref;
  readonly command_mode: HardwareCommandMode;
  readonly target_value: HardwareCommandTarget;
  readonly target_timestamp_s: number;
  readonly issued_at_s: number;
  readonly safety_envelope_ref: Ref;
  readonly primitive_ref: Ref;
  readonly source_component: ActuatorCommandSource;
  readonly authorization: HardwareCommandAuthorization;
  readonly priority?: HardwareCommandPriority;
  readonly expected_feedback_sensor_ref?: Ref;
  readonly command_visibility: HardwareCommandVisibility;
}

/**
 * Active safety envelope supplied by validation and safety systems.
 */
export interface HardwareSafetyEnvelope {
  readonly safety_envelope_ref: Ref;
  readonly approved_plan_ref: Ref;
  readonly allowed_actuator_refs?: readonly Ref[];
  readonly max_position_delta?: number;
  readonly max_velocity?: number;
  readonly max_effort?: number;
  readonly stale_after_s?: number;
  readonly future_delay_tolerance_s?: number;
  readonly max_audio_command_bytes?: number;
  readonly max_tool_state_bytes?: number;
  readonly allow_saturation_clipping: boolean;
  readonly safe_hold_on_saturation: boolean;
}

/**
 * Runtime command state used by the gateway to reject stale, conflicting, or
 * unsafe commands before any simulation boundary receives them.
 */
export interface HardwareGatewayRuntimeState {
  readonly runtime_state_ref: Ref;
  readonly current_time_s: number;
  readonly safety_mode: HardwareGatewaySafetyMode;
  readonly active_primitive_ref?: Ref;
  readonly command_owner_ref?: Ref;
  readonly actuator_state_by_ref: Readonly<Record<Ref, HardwareActuatorRuntimeState>>;
}

export interface HardwareActuatorRuntimeState {
  readonly actuator_id: Ref;
  readonly position?: number;
  readonly velocity?: number;
  readonly effort?: number;
  readonly health_status: GatewayHealthStatus;
}

/**
 * Sanitized command that may cross into the simulation actuator boundary.
 */
export interface HardwareSimulationBoundaryCommand {
  readonly boundary_command_id: Ref;
  readonly command_ref: Ref;
  readonly actuator_id: Ref;
  readonly command_mode: Exclude<HardwareCommandMode, "hold">;
  readonly target_value: HardwareCommandTarget;
  readonly target_timestamp_s: number;
  readonly primitive_ref: Ref;
  readonly approved_plan_ref: Ref;
  readonly safety_envelope_ref: Ref;
  readonly source_component: "ActuatorCommandGateway";
  readonly determinism_hash: string;
}

export interface SimulationActuatorBoundaryRequest {
  readonly request_id: Ref;
  readonly manifest_id: Ref;
  readonly runtime_state_ref: Ref;
  readonly commands: readonly HardwareSimulationBoundaryCommand[];
  readonly determinism_hash: string;
}

export interface SimulationActuatorBoundaryResult {
  readonly accepted_command_refs: readonly Ref[];
  readonly rejected_command_refs: readonly Ref[];
  readonly delayed_command_refs?: readonly Ref[];
  readonly issues?: readonly ValidationIssue[];
}

export type SimulationActuatorBoundary = (request: SimulationActuatorBoundaryRequest) => SimulationActuatorBoundaryResult;

export interface HardwareCommandApplicationRecord {
  readonly command_id: Ref;
  readonly actuator_id: Ref;
  readonly command_mode: HardwareCommandMode;
  readonly application_status: HardwareGatewayDecision;
  readonly target_timestamp_s: number;
  readonly application_time_s: number;
  readonly normalized_target: HardwareCommandTarget;
  readonly saturation_flags: readonly SaturationFlag[];
  readonly latency_ms: number;
  readonly determinism_hash: string;
}

export interface HardwareGatewayRejection {
  readonly command_id: Ref;
  readonly reason_code: ActuatorGatewayIssueCode;
  readonly message: string;
  readonly remediation: string;
}

export interface HardwareActuatorCommandApplicationReport {
  readonly schema_version: typeof ACTUATOR_COMMAND_GATEWAY_SCHEMA_VERSION;
  readonly report_ref: Ref;
  readonly manifest_id: Ref;
  readonly runtime_state_ref: Ref;
  readonly timestamp_s: number;
  readonly accepted_boundary_commands: readonly HardwareSimulationBoundaryCommand[];
  readonly application_records: readonly HardwareCommandApplicationRecord[];
  readonly feedback_packets: readonly SimulationActuatorFeedbackPacket[];
  readonly rejected_commands: readonly HardwareGatewayRejection[];
  readonly delayed_command_ids: readonly Ref[];
  readonly safe_hold_required: boolean;
  readonly issue_count: number;
  readonly issues: readonly ValidationIssue[];
  readonly cognitive_visibility: "runtime_control_and_qa_only";
  readonly determinism_hash: string;
}

export interface ActuatorCommandGatewayConfig {
  readonly registry: VirtualHardwareManifestRegistry;
  readonly manifest_id: Ref;
  readonly simulation_boundary?: SimulationActuatorBoundary;
  readonly accepted_sources?: readonly Exclude<ActuatorCommandSource, "gemini_direct" | "developer_debug">[];
  readonly default_safety_envelope?: Partial<HardwareSafetyEnvelope>;
}

export class ActuatorCommandGatewayError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "ActuatorCommandGatewayError";
    this.issues = issues;
  }
}

/**
 * Validates and dispatches deterministic actuator commands.
 */
export class ActuatorCommandGateway {
  private readonly manifest: VirtualHardwareManifest;
  private readonly acceptedSources: ReadonlySet<ActuatorCommandSource>;
  private readonly defaultEnvelope: HardwareSafetyEnvelope;
  private readonly reports = new Map<Ref, HardwareActuatorCommandApplicationReport>();

  public constructor(private readonly config: ActuatorCommandGatewayConfig) {
    this.manifest = config.registry.requireManifest(config.manifest_id);
    this.acceptedSources = new Set(config.accepted_sources ?? [
      "plan_validation_service",
      "motion_primitive_executor",
      "pd_control_service",
      "safety_controller",
    ]);
    this.defaultEnvelope = createSafetyEnvelope(config.default_safety_envelope);
    validateSafetyEnvelope(this.defaultEnvelope);
  }

  /**
   * Validates a batch, dispatches accepted commands to the optional simulation
   * actuator boundary, and returns feedback packets for downstream virtual
   * hardware feedback conversion.
   */
  public validateAndApplyActuatorCommands(input: {
    readonly actuator_commands: readonly HardwareActuatorCommand[];
    readonly safety_envelope?: Partial<HardwareSafetyEnvelope>;
    readonly runtime_state: HardwareGatewayRuntimeState;
  }): HardwareActuatorCommandApplicationReport {
    validateRuntimeState(input.runtime_state);
    const envelope = mergeSafetyEnvelope(this.defaultEnvelope, input.safety_envelope);
    validateSafetyEnvelope(envelope);

    const issues: ValidationIssue[] = [];
    const acceptedCommands: HardwareSimulationBoundaryCommand[] = [];
    const records: HardwareCommandApplicationRecord[] = [];
    const feedbackPackets: SimulationActuatorFeedbackPacket[] = [];
    const rejectedCommands: HardwareGatewayRejection[] = [];
    const delayedCommandIds: Ref[] = [];

    for (const command of [...input.actuator_commands].sort(compareCommands)) {
      const evaluation = this.evaluateCommand(command, envelope, input.runtime_state);
      issues.push(...evaluation.issues);
      feedbackPackets.push(evaluation.feedback_packet);

      if (evaluation.outcome === "rejected") {
        rejectedCommands.push(evaluation.rejection);
        continue;
      }
      if (evaluation.outcome === "delayed") {
        delayedCommandIds.push(command.command_id);
        continue;
      }
      acceptedCommands.push(evaluation.boundary_command);
      records.push(evaluation.application_record);
    }

    const boundaryIssues: ValidationIssue[] = [];
    const boundaryFeedback = this.dispatchToSimulationBoundary(acceptedCommands, input.runtime_state, boundaryIssues);
    issues.push(...boundaryIssues);
    const acceptedAfterBoundary = filterBoundaryAccepted(acceptedCommands, boundaryFeedback);
    const rejectedAfterBoundary = new Set(boundaryFeedback?.rejected_command_refs ?? []);
    const finalFeedbackPackets = feedbackPackets.map((packet) => {
      if (!rejectedAfterBoundary.has(packet.command_ref)) {
        return packet;
      }
      return buildFeedbackPacket({
        command_id: packet.command_ref,
        actuator_id: packet.actuator_id,
        joint_ref: packet.joint_ref,
        status: "rejected",
        saturation_flags: [],
        latency_ms: packet.latency_ms,
        health_status: "degraded",
        message: "Simulation actuator boundary rejected the command after virtual hardware validation.",
      });
    });
    const safeHoldRequired = input.runtime_state.safety_mode === "emergency_stop"
      || input.runtime_state.safety_mode === "safe_hold"
      || finalFeedbackPackets.some((packet) => packet.applied_status === "safe_hold_required");
    const reportRef = `actuator_command_gateway_${this.config.manifest_id}_${Math.round(input.runtime_state.current_time_s * 1000)}`;
    const reportBase = {
      schema_version: ACTUATOR_COMMAND_GATEWAY_SCHEMA_VERSION,
      report_ref: reportRef,
      manifest_id: this.config.manifest_id,
      runtime_state_ref: input.runtime_state.runtime_state_ref,
      timestamp_s: input.runtime_state.current_time_s,
      accepted_boundary_commands: freezeArray(acceptedAfterBoundary),
      application_records: freezeArray(records.filter((record) => !rejectedAfterBoundary.has(record.command_id))),
      feedback_packets: freezeArray(finalFeedbackPackets),
      rejected_commands: freezeArray([
        ...rejectedCommands,
        ...[...rejectedAfterBoundary].map((commandRef) => rejectCommand(commandRef, "SimulationBoundaryRejected", "Simulation actuator boundary rejected the command.", "Inspect physics actuator state and retry through validation.")),
      ]),
      delayed_command_ids: freezeArray([...delayedCommandIds, ...(boundaryFeedback?.delayed_command_refs ?? [])].sort()),
      safe_hold_required: safeHoldRequired,
      issue_count: issues.length,
      issues: freezeArray(issues),
      cognitive_visibility: "runtime_control_and_qa_only" as const,
    };
    const report: HardwareActuatorCommandApplicationReport = Object.freeze({
      ...reportBase,
      determinism_hash: computeDeterminismHash(reportBase),
    });
    this.reports.set(report.report_ref, report);
    return report;
  }

  /**
   * Convenience wrapper for the architecture-level single-command signature.
   */
  public validateAndApplyActuatorCommand(
    actuatorCommand: HardwareActuatorCommand,
    safetyEnvelope: Partial<HardwareSafetyEnvelope>,
    runtimeState: HardwareGatewayRuntimeState,
  ): HardwareActuatorCommandApplicationReport {
    return this.validateAndApplyActuatorCommands({
      actuator_commands: [actuatorCommand],
      safety_envelope: safetyEnvelope,
      runtime_state: runtimeState,
    });
  }

  public getReport(reportRef: Ref): HardwareActuatorCommandApplicationReport | undefined {
    return this.reports.get(reportRef);
  }

  public listReportRefs(): readonly Ref[] {
    return freezeArray([...this.reports.keys()].sort());
  }

  private evaluateCommand(
    command: HardwareActuatorCommand,
    envelope: HardwareSafetyEnvelope,
    runtime: HardwareGatewayRuntimeState,
  ): CommandEvaluation {
    const validation = this.validateCommand(command, envelope, runtime);
    if (validation.blocking !== undefined) {
      return Object.freeze({
        outcome: "rejected" as const,
        rejection: rejectCommand(command.command_id || "invalid_command", validation.blocking.code, validation.blocking.message, validation.blocking.remediation),
        feedback_packet: buildFeedbackPacket({
          command_id: command.command_id || "invalid_command",
          actuator_id: command.actuator_id || "unknown_actuator",
          joint_ref: validation.blocking.joint_ref ?? "unknown_target",
          status: validation.blocking.status,
          saturation_flags: validation.blocking.saturation_flags,
          latency_ms: 0,
          health_status: validation.blocking.status === "safe_hold_required" ? "disabled" : "degraded",
          message: validation.blocking.message,
        }),
        issues: freezeArray(validation.issues),
      });
    }

    const actuator = requireActuator(this.manifest, command.actuator_id);
    const runtimeState = runtime.actuator_state_by_ref[actuator.actuator_id];
    const timing = classifyCommandTiming(command, envelope, runtime);
    if (timing === "delayed") {
      return Object.freeze({
        outcome: "delayed" as const,
        feedback_packet: buildFeedbackPacket({
          command_id: command.command_id,
          actuator_id: actuator.actuator_id,
          joint_ref: actuator.target_ref,
          status: "delayed",
          saturation_flags: [],
          latency_ms: Math.max(0, command.target_timestamp_s - runtime.current_time_s) * 1000,
          health_status: runtimeState?.health_status ?? "healthy",
          message: "Actuator command is scheduled for a future application time.",
        }),
        issues: freezeArray([...validation.issues, makeIssue("warning", "CommandDelayed", "$.target_timestamp_s", "Command target time is later than the current runtime time.", "Hold the command until it becomes due.")]),
      });
    }
    if (timing === "stale") {
      const issue = makeIssue("error", "CommandStale", "$.target_timestamp_s", "Actuator command is stale for the active safety envelope.", "Issue a fresh command from the deterministic control stack.");
      return Object.freeze({
        outcome: "rejected" as const,
        rejection: rejectCommand(command.command_id, "CommandStale", issue.message, issue.remediation),
        feedback_packet: buildFeedbackPacket({
          command_id: command.command_id,
          actuator_id: actuator.actuator_id,
          joint_ref: actuator.target_ref,
          status: "rejected",
          saturation_flags: [],
          latency_ms: 0,
          health_status: "degraded",
          message: issue.message,
        }),
        issues: freezeArray([...validation.issues, issue]),
      });
    }

    const normalized = normalizeCommandTarget(command, actuator, envelope, runtimeState);
    if (normalized.status === "rejected" || normalized.status === "safe_hold_required") {
      const issue = makeIssue(
        normalized.status === "safe_hold_required" ? "error" : "warning",
        normalized.status === "safe_hold_required" ? "ActuatorSaturated" : "TargetOutOfRange",
        "$.target_value",
        normalized.message,
        normalized.status === "safe_hold_required" ? "Enter safe-hold and inspect actuator load before continuing." : "Retarget within declared actuator and safety limits.",
      );
      return Object.freeze({
        outcome: "rejected" as const,
        rejection: rejectCommand(command.command_id, issue.code as ActuatorGatewayIssueCode, issue.message, issue.remediation),
        feedback_packet: buildFeedbackPacket({
          command_id: command.command_id,
          actuator_id: actuator.actuator_id,
          joint_ref: actuator.target_ref,
          status: normalized.status,
          saturation_flags: normalized.saturation_flags,
          latency_ms: computeLatencyMs(command, runtime),
          health_status: normalized.status === "safe_hold_required" ? "disabled" : "degraded",
          message: normalized.message,
        }),
        issues: freezeArray([...validation.issues, issue]),
      });
    }

    const boundaryCommand = buildBoundaryCommand(command, actuator, normalized.target);
    const applicationStatus: GatewayApplicationStatus = normalized.saturation_flags.length > 0 ? "saturated" : "applied";
    const latencyMs = computeLatencyMs(command, runtime);
    const recordBase = {
      command_id: command.command_id,
      actuator_id: actuator.actuator_id,
      command_mode: command.command_mode,
      application_status: applicationStatus,
      target_timestamp_s: command.target_timestamp_s,
      application_time_s: runtime.current_time_s,
      normalized_target: normalized.target,
      saturation_flags: freezeArray(normalized.saturation_flags),
      latency_ms: latencyMs,
    };
    return Object.freeze({
      outcome: "applied" as const,
      boundary_command: boundaryCommand,
      application_record: Object.freeze({
        ...recordBase,
        determinism_hash: computeDeterminismHash(recordBase),
      }),
      feedback_packet: buildFeedbackPacket({
        command_id: command.command_id,
        actuator_id: actuator.actuator_id,
        joint_ref: actuator.target_ref,
        status: applicationStatus,
        saturation_flags: normalized.saturation_flags,
        latency_ms: latencyMs,
        health_status: runtimeState?.health_status ?? "healthy",
        message: normalized.message,
      }),
      issues: freezeArray(validation.issues),
    });
  }

  private validateCommand(
    command: HardwareActuatorCommand,
    envelope: HardwareSafetyEnvelope,
    runtime: HardwareGatewayRuntimeState,
  ): { readonly issues: readonly ValidationIssue[]; readonly blocking?: BlockingCommandIssue } {
    const issues: ValidationIssue[] = [];
    validateRef(command.command_id, issues, "$.command_id", "TargetInvalid");
    validateRef(command.actuator_id, issues, "$.actuator_id", "ActuatorUndeclared");
    validateRef(command.safety_envelope_ref, issues, "$.safety_envelope_ref", "MissingSafetyEnvelope");
    validateRef(command.primitive_ref, issues, "$.primitive_ref", "TargetInvalid");
    validateFinite(command.target_timestamp_s, issues, "$.target_timestamp_s", "CommandStale");
    validateFinite(command.issued_at_s, issues, "$.issued_at_s", "CommandStale");

    if (command.command_visibility !== "runtime_control_only") {
      return withBlocking(issues, "CommandUnauthorized", "rejected", [], "Command visibility is not restricted to runtime control.", "Keep actuator commands outside cognitive-facing channels.");
    }
    if (command.approved_plan_ref === undefined || command.approved_plan_ref.trim().length === 0) {
      return withBlocking(issues, "MissingApprovalRef", "rejected", [], "Command lacks an approved plan reference.", "Attach approved_plan_ref from PlanValidationService.");
    }
    if (command.approved_plan_ref !== envelope.approved_plan_ref) {
      return withBlocking(issues, "MissingApprovalRef", "rejected", [], "Command approved plan ref does not match the active safety envelope.", "Use the same validation decision and envelope for this control interval.");
    }
    if (command.validation_decision_ref === undefined || command.validation_decision_ref.trim().length === 0) {
      return withBlocking(issues, "MissingApprovalRef", "rejected", [], "Command lacks validation decision provenance.", "Attach validation_decision_ref before actuator application.");
    }
    if (command.safety_envelope_ref !== envelope.safety_envelope_ref) {
      return withBlocking(issues, "MissingSafetyEnvelope", "rejected", [], "Command safety envelope does not match the active envelope.", "Retarget command through the active safety envelope.");
    }
    if (!this.acceptedSources.has(command.source_component) || command.source_component === "gemini_direct" || command.source_component === "developer_debug") {
      return withBlocking(issues, "CommandSourceForbidden", "safe_hold_required", [], "Command source is forbidden by actuator hardware policy.", "Route Gemini intent through validation, motion primitives, PD control, or safety control.");
    }
    if (command.authorization !== "validator_approved" && command.authorization !== "replay_authorized" && command.authorization !== "safe_hold_authorized") {
      return withBlocking(issues, "CommandUnauthorized", "rejected", [], "Command authorization is not valid for actuator application.", "Use validator_approved, replay_authorized, or safe_hold_authorized provenance.");
    }
    if (runtime.safety_mode === "emergency_stop") {
      return withBlocking(issues, "EmergencyStopActive", "safe_hold_required", [], "Emergency stop is active; actuator motion is blocked.", "Clear emergency stop only through safety authority.");
    }
    if (runtime.safety_mode === "safe_hold" && command.source_component !== "safety_controller" && command.command_mode !== "hold") {
      return withBlocking(issues, "SafeHoldActive", "safe_hold_required", [], "Safe-hold admits only hold commands through the safety controller.", "Issue a hold command from safety_controller.");
    }
    if (runtime.active_primitive_ref !== undefined && runtime.active_primitive_ref !== command.primitive_ref && command.source_component !== "safety_controller") {
      return withBlocking(issues, "CommandOwnershipConflict", "rejected", [], "Command primitive differs from the active runtime primitive.", "Bind actuator commands to the active primitive.");
    }
    if (runtime.command_owner_ref !== undefined && runtime.command_owner_ref !== command.primitive_ref && command.source_component !== "safety_controller") {
      return withBlocking(issues, "CommandOwnershipConflict", "safe_hold_required", [], "Command owner differs from the active primitive owner.", "Release or complete the active owner before issuing another command.");
    }

    const actuator = this.manifest.actuator_inventory.find((candidate) => candidate.actuator_id === command.actuator_id);
    if (actuator === undefined) {
      return withBlocking(issues, "ActuatorUndeclared", "rejected", [], "Command target actuator is not declared in the virtual hardware manifest.", "Register the actuator before command application.");
    }
    if (envelope.allowed_actuator_refs !== undefined && !envelope.allowed_actuator_refs.includes(actuator.actuator_id)) {
      return withBlocking(issues, "SafetyEnvelopeViolation", "rejected", [], "Safety envelope does not allow this actuator.", "Use an envelope that explicitly includes the target actuator.");
    }
    if (!actuator.command_source_policy.includes(command.source_component)) {
      return withBlocking(issues, "CommandSourceForbidden", "safe_hold_required", [], "Actuator command source is not allowed by the actuator descriptor.", "Update actuator policy or route through an approved deterministic source.");
    }
    if (!isModeSupported(command.command_mode, actuator)) {
      return withBlocking(issues, "CommandModeUnsupported", "rejected", [], "Command mode is not supported by the declared actuator interfaces.", "Use one of the actuator command interfaces in the manifest.");
    }
    if (runtime.actuator_state_by_ref[actuator.actuator_id] === undefined) {
      return withBlocking(issues, "RuntimeStateInvalid", "rejected", [], "Runtime actuator state is missing for the target actuator.", "Provide actuator feedback or declared default state before command application.");
    }

    const targetIssue = validateModeTarget(command);
    if (targetIssue !== undefined) {
      return withBlocking(issues, targetIssue.code, "rejected", [], targetIssue.message, targetIssue.remediation);
    }
    return Object.freeze({ issues: freezeArray(issues) });
  }

  private dispatchToSimulationBoundary(
    commands: readonly HardwareSimulationBoundaryCommand[],
    runtime: HardwareGatewayRuntimeState,
    issues: ValidationIssue[],
  ): SimulationActuatorBoundaryResult | undefined {
    if (commands.length === 0) {
      return undefined;
    }
    if (this.config.simulation_boundary === undefined) {
      issues.push(makeIssue("warning", "SimulationBoundaryUnavailable", "$.simulation_boundary", "No simulation actuator boundary is configured; commands were validated but not dispatched.", "Provide a simulation boundary function in production runtime."));
      return Object.freeze({
        accepted_command_refs: commands.map((command) => command.command_ref),
        rejected_command_refs: freezeArray([]),
      });
    }
    const requestBase = {
      request_id: `simulation_actuator_boundary_${this.config.manifest_id}_${Math.round(runtime.current_time_s * 1000)}`,
      manifest_id: this.config.manifest_id,
      runtime_state_ref: runtime.runtime_state_ref,
      commands: freezeArray(commands),
    };
    const result = this.config.simulation_boundary(Object.freeze({
      ...requestBase,
      determinism_hash: computeDeterminismHash(requestBase),
    }));
    issues.push(...(result.issues ?? []));
    return result;
  }
}

export function createActuatorCommandGateway(config: ActuatorCommandGatewayConfig): ActuatorCommandGateway {
  return new ActuatorCommandGateway(config);
}

export function validateAndApplyActuatorCommand(
  actuatorCommand: HardwareActuatorCommand,
  config: ActuatorCommandGatewayConfig,
  safetyEnvelope: Partial<HardwareSafetyEnvelope>,
  runtimeState: HardwareGatewayRuntimeState,
): HardwareActuatorCommandApplicationReport {
  return new ActuatorCommandGateway(config).validateAndApplyActuatorCommand(actuatorCommand, safetyEnvelope, runtimeState);
}

function createSafetyEnvelope(override: Partial<HardwareSafetyEnvelope> | undefined): HardwareSafetyEnvelope {
  return Object.freeze({
    safety_envelope_ref: override?.safety_envelope_ref ?? "default_virtual_hardware_safety_envelope",
    approved_plan_ref: override?.approved_plan_ref ?? "default_approved_plan_ref",
    allowed_actuator_refs: freezeOptionalArray(override?.allowed_actuator_refs),
    max_position_delta: override?.max_position_delta,
    max_velocity: override?.max_velocity,
    max_effort: override?.max_effort,
    stale_after_s: override?.stale_after_s ?? DEFAULT_COMMAND_STALE_AFTER_S,
    future_delay_tolerance_s: override?.future_delay_tolerance_s ?? DEFAULT_FUTURE_DELAY_TOLERANCE_S,
    max_audio_command_bytes: override?.max_audio_command_bytes ?? DEFAULT_AUDIO_COMMAND_BYTES,
    max_tool_state_bytes: override?.max_tool_state_bytes ?? DEFAULT_TOOL_STATE_BYTES,
    allow_saturation_clipping: override?.allow_saturation_clipping ?? true,
    safe_hold_on_saturation: override?.safe_hold_on_saturation ?? true,
  });
}

function mergeSafetyEnvelope(base: HardwareSafetyEnvelope, override: Partial<HardwareSafetyEnvelope> | undefined): HardwareSafetyEnvelope {
  return Object.freeze({
    ...base,
    ...(override ?? {}),
    safety_envelope_ref: override?.safety_envelope_ref ?? base.safety_envelope_ref,
    approved_plan_ref: override?.approved_plan_ref ?? base.approved_plan_ref,
    allowed_actuator_refs: freezeOptionalArray(override?.allowed_actuator_refs ?? base.allowed_actuator_refs),
    allow_saturation_clipping: override?.allow_saturation_clipping ?? base.allow_saturation_clipping,
    safe_hold_on_saturation: override?.safe_hold_on_saturation ?? base.safe_hold_on_saturation,
  });
}

function normalizeCommandTarget(
  command: HardwareActuatorCommand,
  actuator: ActuatorDescriptor,
  envelope: HardwareSafetyEnvelope,
  runtimeState: HardwareActuatorRuntimeState | undefined,
): NormalizedTarget {
  const flags: SaturationFlag[] = [];
  const limits = actuator.limit_envelope;
  const currentPosition = runtimeState?.position ?? 0;
  let target = command.target_value;

  if (command.command_mode === "hold") {
    target = Object.freeze({ position: currentPosition, velocity: 0 });
  }
  if (target.position !== undefined || target.grip_width !== undefined) {
    const value = target.position ?? target.grip_width ?? currentPosition;
    const clipped = clipPosition(value, currentPosition, limits, envelope, flags);
    target = Object.freeze({
      ...target,
      position: target.position !== undefined ? clipped : target.position,
      grip_width: target.grip_width !== undefined ? clipped : target.grip_width,
    });
  }
  if (target.velocity !== undefined) {
    target = Object.freeze({
      ...target,
      velocity: clipAbs(target.velocity, minDefined(limits.max_velocity, envelope.max_velocity), "velocity", flags),
    });
  }
  if (target.effort !== undefined) {
    target = Object.freeze({
      ...target,
      effort: clipAbs(target.effort, minDefined(limits.max_effort, envelope.max_effort), "effort", flags),
    });
  }

  const uniqueFlags = freezeArray([...new Set(flags)].sort());
  if (uniqueFlags.length > 0 && envelope.safe_hold_on_saturation) {
    return Object.freeze({
      status: "safe_hold_required",
      target,
      saturation_flags: uniqueFlags,
      message: "Actuator target reached a declared or safety-envelope limit that requires safe-hold.",
    });
  }
  if (uniqueFlags.length > 0 && !envelope.allow_saturation_clipping) {
    return Object.freeze({
      status: "rejected",
      target,
      saturation_flags: uniqueFlags,
      message: "Actuator target exceeds declared limits and clipping is disabled.",
    });
  }
  return Object.freeze({
    status: uniqueFlags.length > 0 ? "saturated" : "applied",
    target,
    saturation_flags: uniqueFlags,
    message: uniqueFlags.length > 0 ? "Actuator target clipped to declared hardware limits." : "Actuator command accepted by the virtual hardware gateway.",
  });
}

function clipPosition(
  value: number,
  currentPosition: number,
  limits: ActuatorLimitEnvelope,
  envelope: HardwareSafetyEnvelope,
  flags: SaturationFlag[],
): number {
  let clipped = value;
  if (limits.min_position !== undefined && clipped < limits.min_position) {
    clipped = limits.min_position;
    flags.push("position_min");
  }
  if (limits.max_position !== undefined && clipped > limits.max_position) {
    clipped = limits.max_position;
    flags.push("position_max");
  }
  if (envelope.max_position_delta !== undefined) {
    const delta = clipped - currentPosition;
    if (Math.abs(delta) > envelope.max_position_delta) {
      clipped = currentPosition + Math.sign(delta) * envelope.max_position_delta;
      flags.push("safety_envelope");
    }
  }
  return clipped;
}

function clipAbs(value: number, limit: number | undefined, flag: SaturationFlag, flags: SaturationFlag[]): number {
  if (limit === undefined || Math.abs(value) <= limit) {
    return value;
  }
  flags.push(flag);
  return Math.sign(value) * limit;
}

function buildBoundaryCommand(
  command: HardwareActuatorCommand,
  actuator: ActuatorDescriptor,
  target: HardwareCommandTarget,
): HardwareSimulationBoundaryCommand {
  const commandMode = command.command_mode === "hold" ? "position" : command.command_mode;
  const base = {
    boundary_command_id: `vh_boundary_${command.command_id}`,
    command_ref: command.command_id,
    actuator_id: actuator.actuator_id,
    command_mode: commandMode,
    target_value: target,
    target_timestamp_s: command.target_timestamp_s,
    primitive_ref: command.primitive_ref,
    approved_plan_ref: command.approved_plan_ref ?? "missing_approved_plan_ref",
    safety_envelope_ref: command.safety_envelope_ref,
    source_component: "ActuatorCommandGateway" as const,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function buildFeedbackPacket(input: {
  readonly command_id: Ref;
  readonly actuator_id: Ref;
  readonly joint_ref: Ref;
  readonly status: GatewayApplicationStatus;
  readonly saturation_flags: readonly SaturationFlag[];
  readonly latency_ms: number;
  readonly health_status: GatewayHealthStatus;
  readonly message: string;
}): SimulationActuatorFeedbackPacket {
  const base = {
    feedback_packet_id: `vh_actuator_feedback_${input.command_id}`,
    actuator_id: input.actuator_id,
    command_ref: input.command_id,
    joint_ref: input.joint_ref,
    applied_status: input.status,
    saturation_flags: freezeArray(input.saturation_flags),
    latency_ms: roundMs(input.latency_ms),
    health_status: input.status === "rejected" || input.status === "safe_hold_required" ? "degraded" as const : input.health_status,
    message: input.message,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function filterBoundaryAccepted(
  commands: readonly HardwareSimulationBoundaryCommand[],
  boundaryResult: SimulationActuatorBoundaryResult | undefined,
): readonly HardwareSimulationBoundaryCommand[] {
  if (boundaryResult === undefined) {
    return commands;
  }
  const accepted = new Set(boundaryResult.accepted_command_refs);
  return freezeArray(commands.filter((command) => accepted.has(command.command_ref)));
}

function classifyCommandTiming(command: HardwareActuatorCommand, envelope: HardwareSafetyEnvelope, runtime: HardwareGatewayRuntimeState): "due" | "delayed" | "stale" {
  const futureTolerance = envelope.future_delay_tolerance_s ?? DEFAULT_FUTURE_DELAY_TOLERANCE_S;
  if (command.target_timestamp_s - runtime.current_time_s > futureTolerance) {
    return "delayed";
  }
  const staleAfter = runtime.safety_mode === "safe_hold" ? DEFAULT_SAFE_HOLD_STALE_AFTER_S : (envelope.stale_after_s ?? DEFAULT_COMMAND_STALE_AFTER_S);
  if (runtime.current_time_s - command.target_timestamp_s > staleAfter) {
    return "stale";
  }
  return "due";
}

function computeLatencyMs(command: HardwareActuatorCommand, runtime: HardwareGatewayRuntimeState): number {
  return roundMs(Math.max(0, runtime.current_time_s - command.target_timestamp_s) * 1000);
}

function isModeSupported(mode: HardwareCommandMode, actuator: ActuatorDescriptor): boolean {
  if (mode === "hold") {
    return actuator.command_interfaces.includes("position") || actuator.command_interfaces.includes("velocity");
  }
  if (mode === "position") {
    return actuator.command_interfaces.includes("position");
  }
  if (mode === "velocity") {
    return actuator.command_interfaces.includes("velocity");
  }
  if (mode === "effort") {
    return actuator.command_interfaces.includes("effort");
  }
  if (mode === "grip_width") {
    return actuator.command_interfaces.includes("grip_width");
  }
  if (mode === "audio_stream") {
    return actuator.command_interfaces.includes("audio_stream");
  }
  return actuator.command_interfaces.includes("tool_state");
}

function validateModeTarget(command: HardwareActuatorCommand): { readonly code: ActuatorGatewayIssueCode; readonly message: string; readonly remediation: string } | undefined {
  const target = command.target_value;
  if (command.command_mode === "position" && !Number.isFinite(target.position)) {
    return Object.freeze({ code: "TargetInvalid", message: "Position command requires a finite target position.", remediation: "Provide target_value.position." });
  }
  if (command.command_mode === "velocity" && !Number.isFinite(target.velocity)) {
    return Object.freeze({ code: "TargetInvalid", message: "Velocity command requires a finite target velocity.", remediation: "Provide target_value.velocity." });
  }
  if (command.command_mode === "effort" && !Number.isFinite(target.effort)) {
    return Object.freeze({ code: "TargetInvalid", message: "Effort command requires a finite target effort.", remediation: "Provide target_value.effort." });
  }
  if (command.command_mode === "grip_width" && !Number.isFinite(target.grip_width)) {
    return Object.freeze({ code: "TargetInvalid", message: "Gripper command requires a finite grip width target.", remediation: "Provide target_value.grip_width." });
  }
  if (command.command_mode === "audio_stream" && (target.audio_stream_ref === undefined || target.audio_stream_ref.trim().length === 0)) {
    return Object.freeze({ code: "TargetInvalid", message: "Speaker command requires an audio stream reference.", remediation: "Provide target_value.audio_stream_ref from an approved audio renderer." });
  }
  if (command.command_mode === "tool_state" && (target.tool_state_ref === undefined || target.tool_state_ref.trim().length === 0 || target.tool_state_value === undefined)) {
    return Object.freeze({ code: "TargetInvalid", message: "Tool command requires a tool state ref and value.", remediation: "Provide target_value.tool_state_ref and target_value.tool_state_value." });
  }
  return undefined;
}

function requireActuator(manifest: VirtualHardwareManifest, actuatorId: Ref): ActuatorDescriptor {
  const actuator = manifest.actuator_inventory.find((candidate) => candidate.actuator_id === actuatorId);
  if (actuator === undefined) {
    throw new ActuatorCommandGatewayError("Actuator is not declared.", [
      makeIssue("error", "ActuatorUndeclared", "$.actuator_id", `Actuator ${actuatorId} is not declared in manifest ${manifest.manifest_id}.`, "Register actuator hardware before issuing commands."),
    ]);
  }
  return actuator;
}

function rejectCommand(commandId: Ref, reasonCode: ActuatorGatewayIssueCode, message: string, remediation: string): HardwareGatewayRejection {
  return Object.freeze({
    command_id: commandId,
    reason_code: reasonCode,
    message,
    remediation,
  });
}

function withBlocking(
  issues: ValidationIssue[],
  code: ActuatorGatewayIssueCode,
  status: GatewayApplicationStatus,
  saturationFlags: readonly SaturationFlag[],
  message: string,
  remediation: string,
  jointRef?: Ref,
): { readonly issues: readonly ValidationIssue[]; readonly blocking: BlockingCommandIssue } {
  issues.push(makeIssue(status === "safe_hold_required" || status === "rejected" ? "error" : "warning", code, "$", message, remediation));
  return Object.freeze({
    issues: freezeArray(issues),
    blocking: Object.freeze({
      code,
      status,
      saturation_flags: freezeArray(saturationFlags),
      message,
      remediation,
      joint_ref: jointRef,
    }),
  });
}

function compareCommands(a: HardwareActuatorCommand, b: HardwareActuatorCommand): number {
  const priority = priorityRank(b.priority ?? "normal") - priorityRank(a.priority ?? "normal");
  if (priority !== 0) {
    return priority;
  }
  const time = a.target_timestamp_s - b.target_timestamp_s;
  if (time !== 0) {
    return time;
  }
  return a.command_id.localeCompare(b.command_id);
}

function priorityRank(priority: HardwareCommandPriority): number {
  switch (priority) {
    case "safety":
      return 3;
    case "high":
      return 2;
    case "normal":
      return 1;
    case "low":
      return 0;
  }
}

function validateSafetyEnvelope(envelope: HardwareSafetyEnvelope): void {
  const issues: ValidationIssue[] = [];
  validateRef(envelope.safety_envelope_ref, issues, "$.safety_envelope_ref", "MissingSafetyEnvelope");
  validateRef(envelope.approved_plan_ref, issues, "$.approved_plan_ref", "MissingApprovalRef");
  validateOptionalPositive(envelope.max_position_delta, issues, "$.max_position_delta", "SafetyEnvelopeViolation");
  validateOptionalPositive(envelope.max_velocity, issues, "$.max_velocity", "SafetyEnvelopeViolation");
  validateOptionalPositive(envelope.max_effort, issues, "$.max_effort", "SafetyEnvelopeViolation");
  validateOptionalPositive(envelope.stale_after_s, issues, "$.stale_after_s", "SafetyEnvelopeViolation");
  validateOptionalPositive(envelope.future_delay_tolerance_s, issues, "$.future_delay_tolerance_s", "SafetyEnvelopeViolation");
  if (issues.some((issue) => issue.severity === "error")) {
    throw new ActuatorCommandGatewayError("Safety envelope failed actuator command gateway validation.", issues);
  }
}

function validateRuntimeState(runtime: HardwareGatewayRuntimeState): void {
  const issues: ValidationIssue[] = [];
  validateRef(runtime.runtime_state_ref, issues, "$.runtime_state_ref", "RuntimeStateInvalid");
  validateFinite(runtime.current_time_s, issues, "$.current_time_s", "RuntimeStateInvalid");
  if (!["normal", "reduced_speed", "safe_hold", "emergency_stop"].includes(runtime.safety_mode)) {
    issues.push(makeIssue("error", "RuntimeStateInvalid", "$.safety_mode", "Runtime safety mode is unsupported.", "Use normal, reduced_speed, safe_hold, or emergency_stop."));
  }
  for (const [actuatorRef, state] of Object.entries(runtime.actuator_state_by_ref)) {
    validateRef(actuatorRef, issues, "$.actuator_state_by_ref", "RuntimeStateInvalid");
    validateRef(state.actuator_id, issues, `$.actuator_state_by_ref.${actuatorRef}.actuator_id`, "RuntimeStateInvalid");
    if (actuatorRef !== state.actuator_id) {
      issues.push(makeIssue("error", "RuntimeStateInvalid", `$.actuator_state_by_ref.${actuatorRef}`, "Actuator state key and payload actuator_id differ.", "Use matching actuator refs."));
    }
    validateOptionalFinite(state.position, issues, `$.actuator_state_by_ref.${actuatorRef}.position`, "RuntimeStateInvalid");
    validateOptionalFinite(state.velocity, issues, `$.actuator_state_by_ref.${actuatorRef}.velocity`, "RuntimeStateInvalid");
    validateOptionalFinite(state.effort, issues, `$.actuator_state_by_ref.${actuatorRef}.effort`, "RuntimeStateInvalid");
  }
  if (issues.some((issue) => issue.severity === "error")) {
    throw new ActuatorCommandGatewayError("Runtime state failed actuator command gateway validation.", issues);
  }
}

function validateRef(value: string | undefined, issues: ValidationIssue[], path: string, code: ActuatorGatewayIssueCode): void {
  if (typeof value !== "string" || value.trim().length === 0 || /\s/.test(value)) {
    issues.push(makeIssue("error", code, path, "Reference must be a non-empty whitespace-free string.", "Use an opaque runtime reference."));
  }
}

function validateFinite(value: number | undefined, issues: ValidationIssue[], path: string, code: ActuatorGatewayIssueCode): void {
  if (!Number.isFinite(value)) {
    issues.push(makeIssue("error", code, path, "Value must be finite.", "Provide a finite numeric value."));
  }
}

function validateOptionalFinite(value: number | undefined, issues: ValidationIssue[], path: string, code: ActuatorGatewayIssueCode): void {
  if (value !== undefined && !Number.isFinite(value)) {
    issues.push(makeIssue("error", code, path, "Optional numeric value must be finite when provided.", "Remove the value or provide a finite number."));
  }
}

function validateOptionalPositive(value: number | undefined, issues: ValidationIssue[], path: string, code: ActuatorGatewayIssueCode): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    issues.push(makeIssue("error", code, path, "Optional limit must be finite and nonnegative when provided.", "Use a calibrated nonnegative limit."));
  }
}

function minDefined(...values: readonly (number | undefined)[]): number | undefined {
  const finite = values.filter((value): value is number => value !== undefined && Number.isFinite(value));
  if (finite.length === 0) {
    return undefined;
  }
  return Math.min(...finite);
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function makeIssue(severity: ValidationSeverity, code: ActuatorGatewayIssueCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

function freezeOptionalArray<T>(values: readonly T[] | undefined): readonly T[] | undefined {
  return values === undefined ? undefined : freezeArray(values);
}

interface BlockingCommandIssue {
  readonly code: ActuatorGatewayIssueCode;
  readonly status: GatewayApplicationStatus;
  readonly saturation_flags: readonly SaturationFlag[];
  readonly message: string;
  readonly remediation: string;
  readonly joint_ref?: Ref;
}

type CommandEvaluation =
  | {
    readonly outcome: "applied";
    readonly boundary_command: HardwareSimulationBoundaryCommand;
    readonly application_record: HardwareCommandApplicationRecord;
    readonly feedback_packet: SimulationActuatorFeedbackPacket;
    readonly issues: readonly ValidationIssue[];
  }
  | {
    readonly outcome: "delayed";
    readonly feedback_packet: SimulationActuatorFeedbackPacket;
    readonly issues: readonly ValidationIssue[];
  }
  | {
    readonly outcome: "rejected";
    readonly rejection: HardwareGatewayRejection;
    readonly feedback_packet: SimulationActuatorFeedbackPacket;
    readonly issues: readonly ValidationIssue[];
  };

type NormalizedTarget =
  | {
    readonly status: "applied" | "saturated";
    readonly target: HardwareCommandTarget;
    readonly saturation_flags: readonly SaturationFlag[];
    readonly message: string;
  }
  | {
    readonly status: "rejected" | "safe_hold_required";
    readonly target: HardwareCommandTarget;
    readonly saturation_flags: readonly SaturationFlag[];
    readonly message: string;
  };

export const ACTUATOR_COMMAND_GATEWAY_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: VIRTUAL_HARDWARE_MANIFEST_REGISTRY_SCHEMA_VERSION,
  actuator_command_gateway_schema_version: ACTUATOR_COMMAND_GATEWAY_SCHEMA_VERSION,
  blueprint: "architecture_docs/04_VIRTUAL_HARDWARE_SENSOR_ACTUATOR_SPEC.md",
  sections: freezeArray(["4.11.3", "4.11.4", "4.15.6", "4.16.2", "4.17", "4.18"]),
});
