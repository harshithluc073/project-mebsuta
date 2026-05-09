/**
 * Actuator limit enforcer for Project Mebsuta deterministic control.
 *
 * Blueprint: `architecture_docs/11_CONTROL_LAYER_IK_PD_TRAJECTORY_ARCHITECTURE.md`
 * sections 11.3, 11.6, 11.7, 11.10, 11.11, 11.14, 11.15, 11.16,
 * and 11.17.
 *
 * This service is the last control-layer gate before actuator commands enter
 * the virtual hardware gateway. It consumes runtime-only PD command
 * candidates, applies declared actuator ranges, effort and velocity caps,
 * active safety-envelope bounds, stale/future timing checks, and saturation
 * policy. Accepted commands are emitted as `HardwareActuatorCommand` objects;
 * unsafe commands are clipped, rejected, or converted into a safe-hold
 * requirement without exposing simulator truth to cognitive systems.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type {
  Ref,
  ValidationIssue,
  ValidationSeverity,
} from "../simulation/world_manifest";
import type {
  ActuatorCommandInput,
  ActuatorCommandInterface,
  ActuatorCommandLimitReport,
  ResolvedActuatorLimit,
} from "../embodiment/actuator_limit_catalog";
import type {
  HardwareActuatorCommand,
  HardwareCommandAuthorization,
  HardwareCommandPriority,
  HardwareCommandTarget,
  HardwareGatewaySafetyMode,
  HardwareSafetyEnvelope,
} from "../virtual_hardware/actuator_command_gateway";
import type {
  ControlTelemetryPacket,
  PDActuatorCommand,
  PDActuatorSaturationFlag,
  PDCommandMode,
} from "./pd_control_service";

export const ACTUATOR_LIMIT_ENFORCER_SCHEMA_VERSION = "mebsuta.actuator_limit_enforcer.v1" as const;

const EPSILON = 1e-9;
const DEFAULT_STALE_AFTER_S = 0.25;
const DEFAULT_FUTURE_DELAY_TOLERANCE_S = 1 / 240;
const DEFAULT_POSITION_DELTA = Number.POSITIVE_INFINITY;
const HIDDEN_ACTUATOR_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|qa_success|qa_label|qa_only|simulator truth|mesh_name|asset_id|benchmark_truth|oracle_pose)/i;

export type ActuatorLimitEnforcementDecision =
  | "enforced"
  | "enforced_with_clipping"
  | "rejected"
  | "safe_hold_required";

export type ActuatorLimitRecommendedAction =
  | "submit_to_hardware_gateway"
  | "clip_and_submit"
  | "repair_command"
  | "slow_control"
  | "safe_hold"
  | "human_review";

export type EnforcedActuatorCommandDecision =
  | "accepted"
  | "clipped"
  | "rejected"
  | "safe_hold_required";

export type ActuatorLimitEnforcerIssueCode =
  | "NoActuatorCommands"
  | "ActuatorLimitMissing"
  | "ActuatorLimitDuplicated"
  | "ActuatorRefInvalid"
  | "JointRefInvalid"
  | "PrimitiveRefInvalid"
  | "WorkOrderRefInvalid"
  | "SafetyEnvelopeInvalid"
  | "ValidationDecisionMissing"
  | "CommandAuthorizationInvalid"
  | "CommandTimestampInvalid"
  | "CommandStale"
  | "CommandFutureDelayed"
  | "CommandModeUnsupported"
  | "CommandTargetMissing"
  | "CommandTargetInvalid"
  | "SafetyEnvelopeViolation"
  | "ActuatorSaturated"
  | "ActuatorFaulted"
  | "CatalogEvaluationFailed"
  | "ForbiddenControlDetail";

/**
 * Runtime actuator feedback used to enforce position deltas and health gates.
 */
export interface ActuatorRuntimeState {
  readonly actuator_ref: Ref;
  readonly position?: number;
  readonly velocity?: number;
  readonly effort?: number;
  readonly grip_width?: number;
  readonly last_command_timestamp_s?: number;
  readonly health_status: "nominal" | "degraded" | "faulted" | "unknown";
}

/**
 * Policy override for deployments that need stricter limits than the active
 * hardware safety envelope.
 */
export interface ActuatorLimitEnforcerPolicy {
  readonly allow_saturation_clipping?: boolean;
  readonly safe_hold_on_saturation?: boolean;
  readonly max_position_delta?: number;
  readonly max_velocity?: number;
  readonly max_effort?: number;
  readonly max_grip_width_delta?: number;
  readonly stale_after_s?: number;
  readonly future_delay_tolerance_s?: number;
  readonly reject_hidden_identifiers?: boolean;
  readonly priority?: HardwareCommandPriority;
}

/**
 * Optional adapter to reuse the embodiment actuator catalog's command evaluator
 * when the caller has an active catalog instance.
 */
export interface ActuatorLimitCatalogAdapter {
  readonly evaluateActuatorCommand: (input: ActuatorCommandInput) => ActuatorCommandLimitReport;
}

/**
 * File 11 actuator-limit enforcement request.
 */
export interface ActuatorLimitEnforcementInput {
  readonly request_ref?: Ref;
  readonly commands: readonly PDActuatorCommand[];
  readonly telemetry_packet: ControlTelemetryPacket;
  readonly actuator_limits: readonly ResolvedActuatorLimit[];
  readonly runtime_state_by_actuator?: Readonly<Record<Ref, ActuatorRuntimeState>>;
  readonly hardware_safety_envelope: HardwareSafetyEnvelope;
  readonly safety_mode: HardwareGatewaySafetyMode;
  readonly current_time_s: number;
  readonly validation_decision_ref: Ref;
  readonly expected_feedback_sensor_by_actuator?: Readonly<Record<Ref, Ref>>;
  readonly policy?: ActuatorLimitEnforcerPolicy;
  readonly adapters?: {
    readonly actuator_limit_catalog?: ActuatorLimitCatalogAdapter;
  };
}

/**
 * Sanitized command target retained for telemetry and gateway handoff.
 */
export interface EnforcedActuatorTarget {
  readonly position?: number;
  readonly velocity?: number;
  readonly effort?: number;
  readonly grip_width?: number;
  readonly tool_state_ref?: Ref;
  readonly tool_state_value?: "enabled" | "disabled" | "open" | "closed" | "activate" | "deactivate";
}

/**
 * Per-actuator result after catalog, envelope, and timing enforcement.
 */
export interface EnforcedActuatorCommand {
  readonly command_ref: Ref;
  readonly actuator_ref: Ref;
  readonly joint_ref: Ref;
  readonly command_mode: PDCommandMode;
  readonly decision: EnforcedActuatorCommandDecision;
  readonly target: EnforcedActuatorTarget;
  readonly target_timestamp_s: number;
  readonly issued_at_s: number;
  readonly primitive_ref: Ref;
  readonly work_order_ref: Ref;
  readonly actuator_limit_report?: ActuatorCommandLimitReport;
  readonly saturation_flags: readonly PDActuatorSaturationFlag[];
  readonly gateway_command?: HardwareActuatorCommand;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

/**
 * Aggregate File 11 report consumed by execution monitoring and QA replay.
 */
export interface ActuatorLimitEnforcementReport {
  readonly schema_version: typeof ACTUATOR_LIMIT_ENFORCER_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/11_CONTROL_LAYER_IK_PD_TRAJECTORY_ARCHITECTURE.md";
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly decision: ActuatorLimitEnforcementDecision;
  readonly recommended_action: ActuatorLimitRecommendedAction;
  readonly accepted_command_count: number;
  readonly clipped_command_count: number;
  readonly rejected_command_refs: readonly Ref[];
  readonly safe_hold_command_refs: readonly Ref[];
  readonly commands: readonly EnforcedActuatorCommand[];
  readonly gateway_commands: readonly HardwareActuatorCommand[];
  readonly actuator_limit_reports: readonly ActuatorCommandLimitReport[];
  readonly actuator_saturation_flags: readonly PDActuatorSaturationFlag[];
  readonly issues: readonly ValidationIssue[];
  readonly safe_hold_required: boolean;
  readonly ok: boolean;
  readonly cognitive_visibility: "runtime_control_limits_only";
  readonly determinism_hash: string;
}

interface NormalizedEnforcerPolicy {
  readonly allow_saturation_clipping: boolean;
  readonly safe_hold_on_saturation: boolean;
  readonly max_position_delta: number;
  readonly max_velocity?: number;
  readonly max_effort?: number;
  readonly max_grip_width_delta: number;
  readonly stale_after_s: number;
  readonly future_delay_tolerance_s: number;
  readonly reject_hidden_identifiers: boolean;
  readonly priority: HardwareCommandPriority;
}

interface TargetNormalizationResult {
  readonly target: EnforcedActuatorTarget;
  readonly changed: boolean;
  readonly saturation_flags: readonly PDActuatorSaturationFlag[];
  readonly issues: readonly ValidationIssue[];
}

/**
 * Enforces File 11 actuator limits and constructs gateway-ready commands.
 */
export class ActuatorLimitEnforcer {
  /**
   * Applies actuator, safety-envelope, saturation, and timing gates to one
   * control interval.
   */
  public enforce(input: ActuatorLimitEnforcementInput): ActuatorLimitEnforcementReport {
    const policy = normalizePolicy(input.hardware_safety_envelope, input.policy);
    const issues: ValidationIssue[] = [];
    const requestRef = sanitizeRef(input.request_ref ?? `actuator_limit_enforcement_${Math.round(input.current_time_s * 1_000_000)}`);
    validateInput(input, policy, issues);
    const limitsByActuator = indexActuatorLimits(input.actuator_limits, issues);
    const enforcedCommands = input.commands.map((command, index) => this.enforceCommand(input, command, index, limitsByActuator, policy));
    const commandIssues = enforcedCommands.flatMap((command) => command.issues);
    issues.push(...commandIssues);

    if (input.commands.length === 0) {
      issues.push(makeIssue("error", "NoActuatorCommands", "$.commands", "ActuatorLimitEnforcer requires at least one PD command candidate.", "Provide PDControlService commands for the active primitive."));
    }

    const gatewayCommands = freezeArray(enforcedCommands.flatMap((command) => command.gateway_command === undefined ? [] : [command.gateway_command]));
    const actuatorLimitReports = freezeArray(enforcedCommands.flatMap((command) => command.actuator_limit_report === undefined ? [] : [command.actuator_limit_report]));
    const rejectedCommandRefs = freezeArray(enforcedCommands.filter((command) => command.decision === "rejected").map((command) => command.command_ref));
    const safeHoldCommandRefs = freezeArray(enforcedCommands.filter((command) => command.decision === "safe_hold_required").map((command) => command.command_ref));
    const actuatorSaturationFlags = mergeSaturationFlags(input.telemetry_packet.actuator_saturation_flags, enforcedCommands.flatMap((command) => command.saturation_flags));
    const acceptedCommandCount = enforcedCommands.filter((command) => command.decision === "accepted" || command.decision === "clipped").length;
    const clippedCommandCount = enforcedCommands.filter((command) => command.decision === "clipped").length;
    const safeHoldRequired = safeHoldCommandRefs.length > 0 || issues.some((issue) => issue.severity === "error" && issue.code === "ActuatorFaulted");
    const decision = decideAggregate(enforcedCommands, issues, clippedCommandCount, safeHoldRequired);
    const base = {
      schema_version: ACTUATOR_LIMIT_ENFORCER_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/11_CONTROL_LAYER_IK_PD_TRAJECTORY_ARCHITECTURE.md" as const,
      report_ref: `actuator_limit_report_${computeDeterminismHash({
        requestRef,
        commandRefs: input.commands.map((command) => command.command_ref),
        currentTime: round6(input.current_time_s),
      })}`,
      request_ref: requestRef,
      decision,
      recommended_action: recommendAction(decision, issues),
      accepted_command_count: acceptedCommandCount,
      clipped_command_count: clippedCommandCount,
      rejected_command_refs: rejectedCommandRefs,
      safe_hold_command_refs: safeHoldCommandRefs,
      commands: freezeArray(enforcedCommands),
      gateway_commands: gatewayCommands,
      actuator_limit_reports: actuatorLimitReports,
      actuator_saturation_flags: actuatorSaturationFlags,
      issues: freezeArray(issues),
      safe_hold_required: safeHoldRequired,
      ok: decision === "enforced" || decision === "enforced_with_clipping",
      cognitive_visibility: "runtime_control_limits_only" as const,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  private enforceCommand(
    input: ActuatorLimitEnforcementInput,
    command: PDActuatorCommand,
    index: number,
    limitsByActuator: ReadonlyMap<Ref, ResolvedActuatorLimit>,
    policy: NormalizedEnforcerPolicy,
  ): EnforcedActuatorCommand {
    const issues: ValidationIssue[] = [];
    const limit = limitsByActuator.get(command.actuator_ref);
    const runtimeState = input.runtime_state_by_actuator?.[command.actuator_ref];
    validateCommand(command, index, input, policy, limit, runtimeState, issues);

    const catalogReport = limit === undefined
      ? undefined
      : evaluateCatalog(input.adapters?.actuator_limit_catalog, command, limit, runtimeState, input.current_time_s, issues);
    const targetResult = limit === undefined
      ? emptyTargetResult()
      : normalizeTarget(command, limit, runtimeState, input.hardware_safety_envelope, policy, issues);
    const saturationFlags = mergeSaturationFlags(flagsFromCatalogReport(command, catalogReport), targetResult.saturation_flags);
    const preliminaryDecision = decideCommand(command, catalogReport, targetResult, issues, input.safety_mode, policy);
    const gatewayCommand = preliminaryDecision === "accepted" || preliminaryDecision === "clipped"
      ? buildGatewayCommand(input, command, targetResult.target, preliminaryDecision === "clipped", policy)
      : undefined;
    const base = {
      command_ref: command.command_ref,
      actuator_ref: command.actuator_ref,
      joint_ref: command.joint_ref,
      command_mode: command.command_mode,
      decision: preliminaryDecision,
      target: targetResult.target,
      target_timestamp_s: round6(command.target_timestamp_s),
      issued_at_s: round6(command.issued_at_s),
      primitive_ref: command.primitive_ref,
      work_order_ref: command.work_order_ref,
      actuator_limit_report: catalogReport,
      saturation_flags: saturationFlags,
      gateway_command: gatewayCommand,
      issues: freezeArray(issues),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }
}

/**
 * Convenience function for callers that do not need a retained enforcer
 * instance.
 */
export function enforceActuatorLimits(input: ActuatorLimitEnforcementInput): ActuatorLimitEnforcementReport {
  return new ActuatorLimitEnforcer().enforce(input);
}

function normalizePolicy(envelope: HardwareSafetyEnvelope, override?: ActuatorLimitEnforcerPolicy): NormalizedEnforcerPolicy {
  return Object.freeze({
    allow_saturation_clipping: override?.allow_saturation_clipping ?? envelope.allow_saturation_clipping,
    safe_hold_on_saturation: override?.safe_hold_on_saturation ?? envelope.safe_hold_on_saturation,
    max_position_delta: finiteOrDefault(minDefined(override?.max_position_delta, envelope.max_position_delta), DEFAULT_POSITION_DELTA),
    max_velocity: minDefined(override?.max_velocity, envelope.max_velocity),
    max_effort: minDefined(override?.max_effort, envelope.max_effort),
    max_grip_width_delta: finiteOrDefault(override?.max_grip_width_delta, finiteOrDefault(envelope.max_position_delta, DEFAULT_POSITION_DELTA)),
    stale_after_s: finiteOrDefault(minDefined(override?.stale_after_s, envelope.stale_after_s), DEFAULT_STALE_AFTER_S),
    future_delay_tolerance_s: finiteOrDefault(minDefined(override?.future_delay_tolerance_s, envelope.future_delay_tolerance_s), DEFAULT_FUTURE_DELAY_TOLERANCE_S),
    reject_hidden_identifiers: override?.reject_hidden_identifiers ?? true,
    priority: override?.priority ?? "normal",
  });
}

function validateInput(input: ActuatorLimitEnforcementInput, policy: NormalizedEnforcerPolicy, issues: ValidationIssue[]): void {
  validateFinite(input.current_time_s, issues, "$.current_time_s", "CommandTimestampInvalid");
  validateRef(input.validation_decision_ref, issues, "$.validation_decision_ref", "ValidationDecisionMissing", policy.reject_hidden_identifiers);
  validateRef(input.hardware_safety_envelope.safety_envelope_ref, issues, "$.hardware_safety_envelope.safety_envelope_ref", "SafetyEnvelopeInvalid", policy.reject_hidden_identifiers);
  validateRef(input.hardware_safety_envelope.approved_plan_ref, issues, "$.hardware_safety_envelope.approved_plan_ref", "SafetyEnvelopeInvalid", policy.reject_hidden_identifiers);
  if (input.safety_mode === "emergency_stop") {
    issues.push(makeIssue("error", "SafetyEnvelopeViolation", "$.safety_mode", "Emergency stop is active; no PD actuator command may be forwarded.", "Keep hardware in safe-hold until safety authority clears the stop."));
  }
}

function indexActuatorLimits(limits: readonly ResolvedActuatorLimit[], issues: ValidationIssue[]): ReadonlyMap<Ref, ResolvedActuatorLimit> {
  const map = new Map<Ref, ResolvedActuatorLimit>();
  for (const limit of limits) {
    if (map.has(limit.actuator_ref)) {
      issues.push(makeIssue("error", "ActuatorLimitDuplicated", "$.actuator_limits", `Duplicate actuator limit for ${limit.actuator_ref}.`, "Provide one resolved actuator limit per actuator."));
    } else {
      map.set(limit.actuator_ref, limit);
    }
  }
  return map;
}

function validateCommand(
  command: PDActuatorCommand,
  index: number,
  input: ActuatorLimitEnforcementInput,
  policy: NormalizedEnforcerPolicy,
  limit: ResolvedActuatorLimit | undefined,
  runtimeState: ActuatorRuntimeState | undefined,
  issues: ValidationIssue[],
): void {
  const path = `$.commands.${index}`;
  validateRef(command.command_ref, issues, `${path}.command_ref`, "ActuatorRefInvalid", policy.reject_hidden_identifiers);
  validateRef(command.actuator_ref, issues, `${path}.actuator_ref`, "ActuatorRefInvalid", policy.reject_hidden_identifiers);
  validateRef(command.joint_ref, issues, `${path}.joint_ref`, "JointRefInvalid", policy.reject_hidden_identifiers);
  validateRef(command.primitive_ref, issues, `${path}.primitive_ref`, "PrimitiveRefInvalid", policy.reject_hidden_identifiers);
  validateRef(command.work_order_ref, issues, `${path}.work_order_ref`, "WorkOrderRefInvalid", policy.reject_hidden_identifiers);
  validateFinite(command.target_timestamp_s, issues, `${path}.target_timestamp_s`, "CommandTimestampInvalid");
  validateFinite(command.issued_at_s, issues, `${path}.issued_at_s`, "CommandTimestampInvalid");

  if (command.authorization !== "validator_approved_control_stack") {
    issues.push(makeIssue("error", "CommandAuthorizationInvalid", `${path}.authorization`, "PD actuator command lacks validator-approved control-stack authorization.", "Regenerate the command from PDControlService after plan validation."));
  }
  if (limit === undefined) {
    issues.push(makeIssue("error", "ActuatorLimitMissing", `${path}.actuator_ref`, `Actuator ${command.actuator_ref} has no resolved actuator limit.`, "Load ActuatorLimitCatalog before command enforcement."));
  } else if (limit.target_joint_ref !== command.joint_ref) {
    issues.push(makeIssue("error", "JointRefInvalid", `${path}.joint_ref`, "PD command joint does not match the actuator limit binding.", "Route the command through the actuator bound to this joint."));
  } else if (!modeSupported(limit, command.command_mode)) {
    issues.push(makeIssue("error", "CommandModeUnsupported", `${path}.command_mode`, `Actuator ${command.actuator_ref} does not support ${command.command_mode}.`, "Select a command interface declared by the active actuator limit catalog."));
  }

  if (input.hardware_safety_envelope.allowed_actuator_refs !== undefined && !input.hardware_safety_envelope.allowed_actuator_refs.includes(command.actuator_ref)) {
    issues.push(makeIssue("error", "SafetyEnvelopeViolation", `${path}.actuator_ref`, "Active safety envelope does not allow this actuator.", "Use only actuators admitted by the active validation envelope."));
  }
  if (command.safety_envelope_ref !== undefined && command.safety_envelope_ref !== input.hardware_safety_envelope.safety_envelope_ref) {
    issues.push(makeIssue("error", "SafetyEnvelopeInvalid", `${path}.safety_envelope_ref`, "PD command safety envelope differs from the active hardware envelope.", "Regenerate the command for the active envelope."));
  }
  if (input.current_time_s - command.issued_at_s > policy.stale_after_s + EPSILON) {
    issues.push(makeIssue("error", "CommandStale", `${path}.issued_at_s`, "PD actuator command is stale relative to the active control clock.", "Recompute PD control for the current tick."));
  }
  if (command.target_timestamp_s - input.current_time_s > policy.future_delay_tolerance_s + EPSILON) {
    issues.push(makeIssue("warning", "CommandFutureDelayed", `${path}.target_timestamp_s`, "PD actuator command target lies beyond the allowed future-delay tolerance.", "Reschedule the command inside the current control interval."));
  }
  if (runtimeState?.health_status === "faulted") {
    issues.push(makeIssue("error", "ActuatorFaulted", `${path}.actuator_ref`, "Runtime actuator state is faulted.", "Enter safe-hold and request actuator diagnostics before sending more motion commands."));
  }
}

function evaluateCatalog(
  adapter: ActuatorLimitCatalogAdapter | undefined,
  command: PDActuatorCommand,
  limit: ResolvedActuatorLimit,
  runtimeState: ActuatorRuntimeState | undefined,
  currentTimeS: number,
  issues: ValidationIssue[],
): ActuatorCommandLimitReport | undefined {
  if (adapter === undefined) {
    return undefined;
  }
  try {
    return adapter.evaluateActuatorCommand(buildCatalogInput(command, limit, runtimeState, currentTimeS));
  } catch (error: unknown) {
    issues.push(makeIssue("error", "CatalogEvaluationFailed", "$.adapters.actuator_limit_catalog", error instanceof Error ? error.message : "Actuator catalog evaluation failed.", "Repair the actuator catalog state before enforcing commands."));
    return undefined;
  }
}

function buildCatalogInput(command: PDActuatorCommand, limit: ResolvedActuatorLimit, runtimeState: ActuatorRuntimeState | undefined, currentTimeS: number): ActuatorCommandInput {
  const commandInterface = catalogInterfaceForMode(command.command_mode, limit);
  return Object.freeze({
    embodiment_ref: limit.embodiment_ref,
    actuator_ref: command.actuator_ref,
    interface: commandInterface,
    consumer: "pd_control",
    position: commandInterface === "position" ? command.target_position ?? runtimeState?.position : undefined,
    velocity: commandInterface === "velocity" ? command.target_velocity : command.target_velocity,
    effort: commandInterface === "effort" ? command.target_effort : command.target_effort,
    grip_width: commandInterface === "grip_width" ? command.target_grip_width ?? runtimeState?.grip_width : undefined,
    tool_state: commandInterface === "tool_state" ? (command.command_mode === "hold" ? "hold" : "candidate") : undefined,
    previous_position: runtimeState?.position,
    previous_velocity: runtimeState?.velocity,
    delta_time_s: runtimeState?.last_command_timestamp_s === undefined ? undefined : Math.max(EPSILON, currentTimeS - runtimeState.last_command_timestamp_s),
  });
}

function normalizeTarget(
  command: PDActuatorCommand,
  limit: ResolvedActuatorLimit,
  runtimeState: ActuatorRuntimeState | undefined,
  envelope: HardwareSafetyEnvelope,
  policy: NormalizedEnforcerPolicy,
  inheritedIssues: ValidationIssue[],
): TargetNormalizationResult {
  const issues: ValidationIssue[] = [];
  const flags: PDActuatorSaturationFlag[] = [];
  let changed = false;
  let target: EnforcedActuatorTarget = Object.freeze({});

  if (command.command_mode === "position") {
    const value = requireFiniteTarget(command.target_position, "$.target_position", "CommandTargetMissing", issues);
    const clipped = value === undefined ? undefined : clipPositionTarget(value, limit, runtimeState?.position, policy, command, flags, issues);
    changed = changed || (value !== undefined && clipped !== undefined && Math.abs(value - clipped) > EPSILON);
    target = Object.freeze({ position: clipped });
  } else if (command.command_mode === "velocity") {
    const value = requireFiniteTarget(command.target_velocity, "$.target_velocity", "CommandTargetMissing", issues);
    const maxVelocity = minDefined(limit.max_velocity, envelope.max_velocity, policy.max_velocity);
    const clipped = value === undefined ? undefined : clipSymmetricTarget(value, maxVelocity, "velocity", command, flags, issues);
    changed = changed || (value !== undefined && clipped !== undefined && Math.abs(value - clipped) > EPSILON);
    target = Object.freeze({ velocity: clipped });
  } else if (command.command_mode === "effort") {
    const value = requireFiniteTarget(command.target_effort, "$.target_effort", "CommandTargetMissing", issues);
    const maxEffort = minDefined(limit.max_effort, envelope.max_effort, policy.max_effort);
    const clipped = value === undefined ? undefined : clipSymmetricTarget(value, maxEffort, "effort", command, flags, issues);
    changed = changed || (value !== undefined && clipped !== undefined && Math.abs(value - clipped) > EPSILON);
    target = Object.freeze({ effort: clipped });
  } else if (command.command_mode === "grip_width") {
    const value = requireFiniteTarget(command.target_grip_width, "$.target_grip_width", "CommandTargetMissing", issues);
    const clipped = value === undefined ? undefined : clipGripTarget(value, limit, runtimeState?.grip_width, policy, command, flags, issues);
    changed = changed || (value !== undefined && clipped !== undefined && Math.abs(value - clipped) > EPSILON);
    target = Object.freeze({ grip_width: clipped });
  } else if (command.command_mode === "tool_state") {
    target = Object.freeze({
      tool_state_ref: command.command_ref,
      tool_state_value: "activate" as const,
    });
  } else {
    target = Object.freeze({
      position: round6(runtimeState?.position ?? command.target_position ?? 0),
      velocity: 0,
    });
  }

  inheritedIssues.push(...issues);
  return Object.freeze({
    target,
    changed,
    saturation_flags: freezeArray(flags),
    issues: freezeArray(issues),
  });
}

function requireFiniteTarget(
  value: number | undefined,
  path: string,
  code: ActuatorLimitEnforcerIssueCode,
  issues: ValidationIssue[],
): number | undefined {
  if (value === undefined) {
    issues.push(makeIssue("error", code, path, "Command mode requires a finite target value.", "Populate the target field that matches the command mode."));
    return undefined;
  }
  if (!Number.isFinite(value)) {
    issues.push(makeIssue("error", "CommandTargetInvalid", path, "Command target must be finite.", "Use finite SI-unit actuator targets."));
    return undefined;
  }
  return value;
}

function clipPositionTarget(
  value: number,
  limit: ResolvedActuatorLimit,
  currentPosition: number | undefined,
  policy: NormalizedEnforcerPolicy,
  command: PDActuatorCommand,
  flags: PDActuatorSaturationFlag[],
  issues: ValidationIssue[],
): number {
  const bounds = positionBounds(limit);
  let clipped = bounds === undefined ? value : clamp(value, bounds.min, bounds.max);
  if (bounds !== undefined && Math.abs(clipped - value) > EPSILON) {
    pushSaturation(command, "position", value, clipped, flags, issues);
  }
  if (currentPosition !== undefined && Number.isFinite(currentPosition) && Number.isFinite(policy.max_position_delta)) {
    const deltaClipped = clamp(clipped, currentPosition - policy.max_position_delta, currentPosition + policy.max_position_delta);
    if (Math.abs(deltaClipped - clipped) > EPSILON) {
      pushSaturation(command, "position", clipped, deltaClipped, flags, issues);
    }
    clipped = deltaClipped;
  }
  return round6(clipped);
}

function clipGripTarget(
  value: number,
  limit: ResolvedActuatorLimit,
  currentGripWidth: number | undefined,
  policy: NormalizedEnforcerPolicy,
  command: PDActuatorCommand,
  flags: PDActuatorSaturationFlag[],
  issues: ValidationIssue[],
): number {
  const bounds = positionBounds(limit);
  let clipped = bounds === undefined ? value : clamp(value, bounds.min, bounds.max);
  if (bounds !== undefined && Math.abs(clipped - value) > EPSILON) {
    pushSaturation(command, "actuator_limit", value, clipped, flags, issues);
  }
  if (currentGripWidth !== undefined && Number.isFinite(currentGripWidth) && Number.isFinite(policy.max_grip_width_delta)) {
    const deltaClipped = clamp(clipped, currentGripWidth - policy.max_grip_width_delta, currentGripWidth + policy.max_grip_width_delta);
    if (Math.abs(deltaClipped - clipped) > EPSILON) {
      pushSaturation(command, "actuator_limit", clipped, deltaClipped, flags, issues);
    }
    clipped = deltaClipped;
  }
  return round6(clipped);
}

function clipSymmetricTarget(
  value: number,
  maxAbs: number | undefined,
  saturationType: "velocity" | "effort",
  command: PDActuatorCommand,
  flags: PDActuatorSaturationFlag[],
  issues: ValidationIssue[],
): number {
  if (maxAbs === undefined || !Number.isFinite(maxAbs) || maxAbs <= EPSILON) {
    issues.push(makeIssue("error", "CommandTargetInvalid", `$.${saturationType}`, `Actuator ${saturationType} limit must be positive and finite.`, "Repair actuator and safety-envelope limit definitions."));
    return round6(value);
  }
  const clipped = clamp(value, -maxAbs, maxAbs);
  if (Math.abs(clipped - value) > EPSILON) {
    pushSaturation(command, saturationType, value, clipped, flags, issues);
  }
  return round6(clipped);
}

function pushSaturation(
  command: PDActuatorCommand,
  saturationType: PDActuatorSaturationFlag["saturation_type"],
  requested: number,
  clipped: number,
  flags: PDActuatorSaturationFlag[],
  issues: ValidationIssue[],
): void {
  const ratio = Math.abs(requested) <= EPSILON ? Math.abs(clipped - requested) : Math.abs((requested - clipped) / requested);
  flags.push(Object.freeze({
    actuator_ref: command.actuator_ref,
    joint_ref: command.joint_ref,
    saturation_type: saturationType,
    ratio: round6(ratio),
    action: "clipped",
  }));
  issues.push(makeIssue("warning", "ActuatorSaturated", `$.commands.${command.command_ref}`, `Actuator command exceeded ${saturationType} limits and was clipped.`, "Inspect trajectory speed, load, or safety-envelope bounds."));
}

function decideCommand(
  command: PDActuatorCommand,
  catalogReport: ActuatorCommandLimitReport | undefined,
  targetResult: TargetNormalizationResult,
  issues: readonly ValidationIssue[],
  safetyMode: HardwareGatewaySafetyMode,
  policy: NormalizedEnforcerPolicy,
): EnforcedActuatorCommandDecision {
  if (safetyMode === "emergency_stop" || safetyMode === "safe_hold") {
    return "safe_hold_required";
  }
  if (issues.some((issue) => issue.severity === "error" && issue.code === "ActuatorFaulted")) {
    return "safe_hold_required";
  }
  if (catalogReport?.decision === "safe_hold") {
    return "safe_hold_required";
  }
  if (targetResult.saturation_flags.length > 0 && policy.safe_hold_on_saturation) {
    return "safe_hold_required";
  }
  if (issues.some((issue) => issue.severity === "error")) {
    return "rejected";
  }
  if (catalogReport?.decision === "rejected") {
    return "rejected";
  }
  if (targetResult.saturation_flags.length > 0 && !policy.allow_saturation_clipping) {
    return "rejected";
  }
  if (catalogReport?.decision === "clipped" || targetResult.changed || command.target_timestamp_s < command.issued_at_s - EPSILON) {
    return "clipped";
  }
  return "accepted";
}

function buildGatewayCommand(
  input: ActuatorLimitEnforcementInput,
  command: PDActuatorCommand,
  target: EnforcedActuatorTarget,
  clipped: boolean,
  policy: NormalizedEnforcerPolicy,
): HardwareActuatorCommand {
  const authorization: HardwareCommandAuthorization = clipped ? "validator_approved" : "validator_approved";
  return Object.freeze({
    command_id: `hardware_command_${command.command_ref}`,
    approved_plan_ref: input.hardware_safety_envelope.approved_plan_ref,
    validation_decision_ref: input.validation_decision_ref,
    actuator_id: command.actuator_ref,
    command_mode: command.command_mode,
    target_value: toHardwareTarget(target),
    target_timestamp_s: round6(command.target_timestamp_s),
    issued_at_s: round6(input.current_time_s),
    safety_envelope_ref: input.hardware_safety_envelope.safety_envelope_ref,
    primitive_ref: command.primitive_ref,
    source_component: "pd_control_service",
    authorization,
    priority: policy.priority,
    expected_feedback_sensor_ref: input.expected_feedback_sensor_by_actuator?.[command.actuator_ref],
    command_visibility: "runtime_control_only",
  });
}

function toHardwareTarget(target: EnforcedActuatorTarget): HardwareCommandTarget {
  return Object.freeze({
    position: target.position,
    velocity: target.velocity,
    effort: target.effort,
    grip_width: target.grip_width,
    tool_state_ref: target.tool_state_ref,
    tool_state_value: target.tool_state_value,
  });
}

function flagsFromCatalogReport(command: PDActuatorCommand, report: ActuatorCommandLimitReport | undefined): readonly PDActuatorSaturationFlag[] {
  if (report === undefined || report.saturation_ratio <= EPSILON) {
    return freezeArray([]);
  }
  const action: PDActuatorSaturationFlag["action"] = report.decision === "safe_hold" ? "safe_hold_required" : report.decision === "rejected" ? "rejected" : report.decision === "clipped" ? "clipped" : "none";
  return freezeArray([Object.freeze({
    actuator_ref: command.actuator_ref,
    joint_ref: command.joint_ref,
    saturation_type: saturationTypeFromReport(report),
    ratio: round6(report.saturation_ratio),
    action,
  })]);
}

function saturationTypeFromReport(report: ActuatorCommandLimitReport): PDActuatorSaturationFlag["saturation_type"] {
  if (report.requested_effort !== undefined) {
    return "effort";
  }
  if (report.requested_velocity !== undefined || report.inferred_velocity !== undefined) {
    return "velocity";
  }
  if (report.requested_position !== undefined) {
    return "position";
  }
  return "actuator_limit";
}

function decideAggregate(
  commands: readonly EnforcedActuatorCommand[],
  issues: readonly ValidationIssue[],
  clippedCount: number,
  safeHoldRequired: boolean,
): ActuatorLimitEnforcementDecision {
  if (safeHoldRequired || commands.some((command) => command.decision === "safe_hold_required")) {
    return "safe_hold_required";
  }
  if (commands.length === 0 || commands.some((command) => command.decision === "rejected") || issues.some((issue) => issue.severity === "error")) {
    return "rejected";
  }
  if (clippedCount > 0) {
    return "enforced_with_clipping";
  }
  return "enforced";
}

function recommendAction(decision: ActuatorLimitEnforcementDecision, issues: readonly ValidationIssue[]): ActuatorLimitRecommendedAction {
  if (decision === "safe_hold_required") {
    return "safe_hold";
  }
  if (decision === "rejected") {
    return issues.some((issue) => issue.code === "ForbiddenControlDetail" || issue.code === "ValidationDecisionMissing")
      ? "human_review"
      : "repair_command";
  }
  if (decision === "enforced_with_clipping") {
    return issues.some((issue) => issue.code === "CommandFutureDelayed") ? "slow_control" : "clip_and_submit";
  }
  return "submit_to_hardware_gateway";
}

function modeSupported(limit: ResolvedActuatorLimit, mode: PDCommandMode): boolean {
  if (mode === "hold") {
    return limit.supports_position || limit.supports_velocity;
  }
  if (mode === "position") {
    return limit.supports_position;
  }
  if (mode === "velocity") {
    return limit.supports_velocity;
  }
  if (mode === "effort") {
    return limit.supports_effort;
  }
  if (mode === "grip_width") {
    return limit.supports_grip_width;
  }
  return limit.supports_tool_state;
}

function catalogInterfaceForMode(mode: PDCommandMode, limit: ResolvedActuatorLimit): ActuatorCommandInterface {
  if (mode !== "hold") {
    return mode;
  }
  if (limit.command_interfaces.includes("position")) {
    return "position";
  }
  if (limit.command_interfaces.includes("velocity")) {
    return "velocity";
  }
  return limit.command_interfaces[0] ?? "position";
}

function positionBounds(limit: ResolvedActuatorLimit): { readonly min: number; readonly max: number } | undefined {
  if (limit.safe_min_position !== undefined && limit.safe_max_position !== undefined && limit.safe_min_position < limit.safe_max_position) {
    return Object.freeze({ min: limit.safe_min_position, max: limit.safe_max_position });
  }
  if (limit.min_position !== undefined && limit.max_position !== undefined && limit.min_position < limit.max_position) {
    return Object.freeze({ min: limit.min_position, max: limit.max_position });
  }
  return undefined;
}

function mergeSaturationFlags(...flagGroups: readonly (readonly PDActuatorSaturationFlag[])[]): readonly PDActuatorSaturationFlag[] {
  const unique = new Map<string, PDActuatorSaturationFlag>();
  for (const flag of flagGroups.flat()) {
    const key = `${flag.actuator_ref}|${flag.joint_ref}|${flag.saturation_type}|${flag.action}|${round6(flag.ratio)}`;
    if (!unique.has(key)) {
      unique.set(key, Object.freeze({ ...flag, ratio: round6(flag.ratio) }));
    }
  }
  return freezeArray([...unique.values()].sort((a, b) => `${a.actuator_ref}:${a.saturation_type}:${a.action}`.localeCompare(`${b.actuator_ref}:${b.saturation_type}:${b.action}`)));
}

function emptyTargetResult(): TargetNormalizationResult {
  return Object.freeze({
    target: Object.freeze({}),
    changed: false,
    saturation_flags: freezeArray([]),
    issues: freezeArray([]),
  });
}

function validateRef(ref: Ref | undefined, issues: ValidationIssue[], path: string, code: ActuatorLimitEnforcerIssueCode, rejectHidden: boolean): void {
  if (ref === undefined || ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(makeIssue("error", code, path, "Reference must be a non-empty whitespace-free string.", "Use an opaque validated control reference."));
    return;
  }
  if (rejectHidden && HIDDEN_ACTUATOR_PATTERN.test(ref)) {
    issues.push(makeIssue("error", "ForbiddenControlDetail", path, "Reference contains hidden simulator or QA detail.", "Strip backend, simulator, and QA-truth identifiers from control-facing data."));
  }
}

function validateFinite(value: number, issues: ValidationIssue[], path: string, code: ActuatorLimitEnforcerIssueCode): void {
  if (!Number.isFinite(value)) {
    issues.push(makeIssue("error", code, path, "Numeric value must be finite.", "Use finite canonical SI-unit values."));
  }
}

function sanitizeRef(ref: Ref): Ref {
  return ref.replace(HIDDEN_ACTUATOR_PATTERN, "hidden-detail").trim();
}

function minDefined(...values: readonly (number | undefined)[]): number | undefined {
  const finiteValues = values.filter((value): value is number => value !== undefined && Number.isFinite(value));
  return finiteValues.length === 0 ? undefined : Math.min(...finiteValues);
}

function finiteOrDefault(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : value;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

function makeIssue(
  severity: ValidationSeverity,
  code: ActuatorLimitEnforcerIssueCode,
  path: string,
  message: string,
  remediation: string,
): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}
