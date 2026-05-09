/**
 * Actuator limit catalog for Project Mebsuta embodiment models.
 *
 * Blueprint: `architecture_docs/05_EMBODIMENT_KINEMATICS_QUADRUPED_HUMANOID.md`
 * sections 5.3, 5.5, 5.6, 5.16, 5.19, and 5.20.
 *
 * This module is the executable actuator-limit authority consumed by control,
 * safety, manipulation, tool-use, and QA services. It resolves actuator command
 * interfaces, velocity caps, acceleration caps, effort/force envelopes, grip
 * ranges, saturation policies, and joint bindings from the active embodiment
 * model without exposing simulator world truth, backend handles, collision
 * geometry, or QA-only coordinates.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { EmbodimentKind, Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import { createEmbodimentModelRegistry, EmbodimentModelRegistry } from "./embodiment_model_registry";
import type { ActuatorLimitDescriptor, EmbodimentDescriptor, JointDescriptor, JointGroup } from "./embodiment_model_registry";

export const ACTUATOR_LIMIT_CATALOG_SCHEMA_VERSION = "mebsuta.actuator_limit_catalog.v1" as const;

const EPSILON = 1e-9;
const FORBIDDEN_DETAIL_PATTERN = /(engine|backend|scene_graph|world_truth|ground_truth|qa_|collision_mesh|simulator_seed|exact_com|world_pose|joint_handle|rigid_body_handle|physics_body)/i;

export type ActuatorCommandInterface = ActuatorLimitDescriptor["command_interfaces"][number];
export type SaturationPolicy = ActuatorLimitDescriptor["saturation_policy"];
export type ActuatorLimitConsumer = "pd_control" | "ik" | "trajectory" | "manipulation" | "locomotion" | "tool_use" | "safety" | "qa";
export type ActuatorCommandDecision = "accepted" | "clipped" | "rejected" | "safe_hold";

export type ActuatorLimitIssueCode =
  | "ActiveEmbodimentMissing"
  | "ActuatorRefInvalid"
  | "ActuatorLimitMissing"
  | "ActuatorLimitDuplicated"
  | "ActuatorLimitInvalid"
  | "ActuatorJointBindingMissing"
  | "ActuatorInterfaceInvalid"
  | "ActuatorSaturationPolicyInvalid"
  | "CommandInputInvalid"
  | "CommandInterfaceUnsupported"
  | "PositionCommandViolation"
  | "VelocityCommandViolation"
  | "AccelerationCommandViolation"
  | "EffortCommandViolation"
  | "GripCommandViolation"
  | "ToolStateCommandViolation"
  | "ForbiddenBodyDetail";

export interface ActuatorLimitCatalogConfig {
  readonly registry?: EmbodimentModelRegistry;
  readonly embodiment?: EmbodimentDescriptor;
  readonly active_embodiment_ref?: Ref;
}

export interface ActuatorLimitSelectionInput {
  readonly embodiment_ref?: Ref;
  readonly actuator_ref?: Ref;
  readonly target_joint_ref?: Ref;
  readonly actuator_group?: JointGroup;
  readonly command_interface?: ActuatorCommandInterface;
}

export interface ResolvedActuatorLimit {
  readonly schema_version: typeof ACTUATOR_LIMIT_CATALOG_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly actuator_ref: Ref;
  readonly target_joint_ref: Ref;
  readonly actuator_group: JointGroup;
  readonly target_joint_group?: JointGroup;
  readonly command_interfaces: readonly ActuatorCommandInterface[];
  readonly min_position?: number;
  readonly max_position?: number;
  readonly safe_min_position?: number;
  readonly safe_max_position?: number;
  readonly position_range?: number;
  readonly max_velocity: number;
  readonly max_effort: number;
  readonly max_acceleration: number;
  readonly saturation_policy: SaturationPolicy;
  readonly nominal_stop_time_s: number;
  readonly minimum_stop_distance: number;
  readonly supports_position: boolean;
  readonly supports_velocity: boolean;
  readonly supports_effort: boolean;
  readonly supports_grip_width: boolean;
  readonly supports_tool_state: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
}

export interface ActuatorGroupLimitSummary {
  readonly actuator_group: JointGroup;
  readonly actuator_count: number;
  readonly command_interfaces: readonly ActuatorCommandInterface[];
  readonly max_velocity: number;
  readonly max_effort: number;
  readonly max_acceleration: number;
  readonly saturation_policies: readonly SaturationPolicy[];
  readonly bound_joint_count: number;
}

export interface ActuatorLimitCatalogReport {
  readonly schema_version: typeof ACTUATOR_LIMIT_CATALOG_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly actuator_count: number;
  readonly position_actuator_count: number;
  readonly velocity_actuator_count: number;
  readonly effort_actuator_count: number;
  readonly grip_width_actuator_count: number;
  readonly tool_state_actuator_count: number;
  readonly actuator_limits: readonly ResolvedActuatorLimit[];
  readonly actuator_group_summaries: readonly ActuatorGroupLimitSummary[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly error_count: number;
  readonly warning_count: number;
  readonly hidden_fields_removed: readonly string[];
  readonly determinism_hash: string;
}

export interface ActuatorCommandInput {
  readonly embodiment_ref?: Ref;
  readonly actuator_ref: Ref;
  readonly interface: ActuatorCommandInterface;
  readonly consumer: ActuatorLimitConsumer;
  readonly position?: number;
  readonly velocity?: number;
  readonly acceleration?: number;
  readonly effort?: number;
  readonly grip_width?: number;
  readonly tool_state?: "candidate" | "attach" | "hold" | "release" | "expire";
  readonly previous_position?: number;
  readonly previous_velocity?: number;
  readonly delta_time_s?: number;
}

export interface ActuatorCommandLimitReport {
  readonly schema_version: typeof ACTUATOR_LIMIT_CATALOG_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly actuator_ref: Ref;
  readonly target_joint_ref: Ref;
  readonly interface: ActuatorCommandInterface;
  readonly consumer: ActuatorLimitConsumer;
  readonly saturation_policy: SaturationPolicy;
  readonly decision: ActuatorCommandDecision;
  readonly requested_position?: number;
  readonly limited_position?: number;
  readonly requested_velocity?: number;
  readonly limited_velocity?: number;
  readonly requested_acceleration?: number;
  readonly limited_acceleration?: number;
  readonly requested_effort?: number;
  readonly limited_effort?: number;
  readonly requested_grip_width?: number;
  readonly limited_grip_width?: number;
  readonly requested_tool_state?: ActuatorCommandInput["tool_state"];
  readonly accepted_tool_state?: ActuatorCommandInput["tool_state"];
  readonly inferred_velocity?: number;
  readonly inferred_acceleration?: number;
  readonly saturation_ratio: number;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
}

export interface ActuatorBatchCommandInput {
  readonly embodiment_ref?: Ref;
  readonly commands: readonly ActuatorCommandInput[];
  readonly consumer: ActuatorLimitConsumer;
}

export interface ActuatorBatchCommandReport {
  readonly schema_version: typeof ACTUATOR_LIMIT_CATALOG_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly command_count: number;
  readonly accepted_count: number;
  readonly clipped_count: number;
  readonly rejected_count: number;
  readonly safe_hold_count: number;
  readonly reports: readonly ActuatorCommandLimitReport[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly determinism_hash: string;
}

export interface CognitiveActuatorLimitSummary {
  readonly schema_version: typeof ACTUATOR_LIMIT_CATALOG_SCHEMA_VERSION;
  readonly embodiment_ref: Ref;
  readonly embodiment_kind: EmbodimentKind;
  readonly actuator_group_summaries: readonly string[];
  readonly command_interface_summary: readonly string[];
  readonly safety_summary: readonly string[];
  readonly hidden_fields_removed: readonly string[];
  readonly cognitive_visibility: "body_self_knowledge_without_simulator_world_truth";
  readonly determinism_hash: string;
}

export class ActuatorLimitCatalogError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "ActuatorLimitCatalogError";
    this.issues = issues;
  }
}

/**
 * Resolves actuator command envelopes and applies each actuator's declared
 * saturation policy before commands reach low-level control services.
 */
export class ActuatorLimitCatalog {
  private readonly registry: EmbodimentModelRegistry;
  private activeEmbodimentRef: Ref | undefined;

  public constructor(config: ActuatorLimitCatalogConfig = {}) {
    this.registry = config.registry ?? createEmbodimentModelRegistry(config.embodiment === undefined ? undefined : [config.embodiment]);
    this.activeEmbodimentRef = config.active_embodiment_ref ?? config.embodiment?.embodiment_id;
    if (this.activeEmbodimentRef !== undefined) {
      this.registry.selectActiveEmbodiment({ embodiment_ref: this.activeEmbodimentRef });
    }
  }

  /**
   * Selects the active embodiment and returns its actuator catalog.
   */
  public selectActiveEmbodiment(embodimentRef: Ref): ActuatorLimitCatalogReport {
    assertSafeRef(embodimentRef, "$.embodiment_ref");
    this.registry.selectActiveEmbodiment({ embodiment_ref: embodimentRef });
    this.activeEmbodimentRef = embodimentRef;
    return this.buildCatalogReport({ embodiment_ref: embodimentRef });
  }

  /**
   * Resolves actuator limits matching the optional selector and validates every
   * actuator against the active embodiment's joint table.
   */
  public buildCatalogReport(selection: ActuatorLimitSelectionInput = {}): ActuatorLimitCatalogReport {
    const model = this.requireEmbodiment(selection.embodiment_ref ?? this.requireActiveEmbodiment().embodiment_id);
    const issues: ValidationIssue[] = [];
    const selected = model.actuator_limits
      .filter((actuator) => selection.actuator_ref === undefined || actuator.actuator_ref === selection.actuator_ref)
      .filter((actuator) => selection.target_joint_ref === undefined || actuator.target_joint_ref === selection.target_joint_ref)
      .filter((actuator) => selection.actuator_group === undefined || actuator.actuator_group === selection.actuator_group)
      .filter((actuator) => selection.command_interface === undefined || actuator.command_interfaces.includes(selection.command_interface))
      .sort((a, b) => a.actuator_ref.localeCompare(b.actuator_ref));
    if (selection.actuator_ref !== undefined && selected.length === 0) {
      issues.push(makeIssue("error", "ActuatorLimitMissing", "$.actuator_ref", `Actuator ${selection.actuator_ref} is not declared.`, "Choose an actuator from the active embodiment model."));
    }
    const limits = freezeArray(selected.map((actuator) => resolveActuatorLimit(model, actuator, issues)));
    validateActuatorCatalogCoverage(model, limits, issues);
    const groupSummaries = buildGroupSummaries(limits);
    const base = {
      schema_version: ACTUATOR_LIMIT_CATALOG_SCHEMA_VERSION,
      embodiment_ref: model.embodiment_id,
      embodiment_kind: model.embodiment_kind,
      actuator_count: limits.length,
      position_actuator_count: limits.filter((limit) => limit.supports_position).length,
      velocity_actuator_count: limits.filter((limit) => limit.supports_velocity).length,
      effort_actuator_count: limits.filter((limit) => limit.supports_effort).length,
      grip_width_actuator_count: limits.filter((limit) => limit.supports_grip_width).length,
      tool_state_actuator_count: limits.filter((limit) => limit.supports_tool_state).length,
      actuator_limits: limits,
      actuator_group_summaries: groupSummaries,
      issues: freezeArray(issues),
      ok: !issues.some((issue) => issue.severity === "error"),
      error_count: issues.filter((issue) => issue.severity === "error").length,
      warning_count: issues.filter((issue) => issue.severity === "warning").length,
      hidden_fields_removed: hiddenFieldsRemoved(),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Requires one resolved actuator limit and throws if it is missing or invalid.
   */
  public requireActuatorLimit(actuatorRef: Ref, embodimentRef: Ref = this.requireActiveEmbodiment().embodiment_id): ResolvedActuatorLimit {
    assertSafeRef(actuatorRef, "$.actuator_ref");
    const report = this.buildCatalogReport({ embodiment_ref: embodimentRef, actuator_ref: actuatorRef });
    const limit = report.actuator_limits.find((candidate) => candidate.actuator_ref === actuatorRef);
    if (limit === undefined) {
      throw new ActuatorLimitCatalogError("Actuator limit is not declared for the embodiment.", [
        makeIssue("error", "ActuatorLimitMissing", "$.actuator_ref", `Actuator ${actuatorRef} is not available on ${embodimentRef}.`, "Choose a declared actuator from the active catalog."),
      ]);
    }
    if (!limit.ok) {
      throw new ActuatorLimitCatalogError("Actuator limit failed validation.", limit.issues);
    }
    return limit;
  }

  /**
   * Evaluates one actuator command and applies the actuator's saturation policy:
   * `clip_and_report` clips numeric values, `reject` rejects any violation, and
   * `safe_hold` converts violations into a safe-hold decision.
   */
  public evaluateActuatorCommand(input: ActuatorCommandInput): ActuatorCommandLimitReport {
    const limit = this.requireActuatorLimit(input.actuator_ref, input.embodiment_ref ?? this.requireActiveEmbodiment().embodiment_id);
    const issues: ValidationIssue[] = [];
    validateCommandInterface(limit, input.interface, issues);
    validateCommandShape(input, issues);

    const inferredVelocity = inferVelocity(input);
    const inferredAcceleration = inferAcceleration(input, inferredVelocity);
    const velocityForCheck = input.velocity ?? inferredVelocity;
    const accelerationForCheck = input.acceleration ?? inferredAcceleration;
    const positionBounds = boundsForPositionLikeCommand(limit);
    const requestedPosition = input.position;
    const requestedGrip = input.grip_width;
    const positionViolation = requestedPosition !== undefined && positionBounds !== undefined && (requestedPosition < positionBounds.min - EPSILON || requestedPosition > positionBounds.max + EPSILON);
    const gripViolation = requestedGrip !== undefined && positionBounds !== undefined && (requestedGrip < positionBounds.min - EPSILON || requestedGrip > positionBounds.max + EPSILON);
    const velocityViolation = velocityForCheck !== undefined && Math.abs(velocityForCheck) > limit.max_velocity + EPSILON;
    const accelerationViolation = accelerationForCheck !== undefined && Math.abs(accelerationForCheck) > limit.max_acceleration + EPSILON;
    const effortViolation = input.effort !== undefined && Math.abs(input.effort) > limit.max_effort + EPSILON;

    if (positionViolation) {
      issues.push(makeIssue("warning", "PositionCommandViolation", "$.position", `Actuator ${limit.actuator_ref} position command exceeds declared range.`, "Apply saturation policy before control."));
    }
    if (gripViolation) {
      issues.push(makeIssue("warning", "GripCommandViolation", "$.grip_width", `Actuator ${limit.actuator_ref} grip width command exceeds declared range.`, "Use the declared grip range."));
    }
    if (velocityViolation) {
      issues.push(makeIssue("warning", "VelocityCommandViolation", "$.velocity", `Actuator ${limit.actuator_ref} velocity command exceeds max velocity.`, "Reduce trajectory speed or lengthen interpolation time."));
    }
    if (accelerationViolation) {
      issues.push(makeIssue("warning", "AccelerationCommandViolation", "$.acceleration", `Actuator ${limit.actuator_ref} acceleration command exceeds max acceleration.`, "Smooth trajectory timing."));
    }
    if (effortViolation) {
      issues.push(makeIssue("warning", "EffortCommandViolation", "$.effort", `Actuator ${limit.actuator_ref} effort command exceeds max effort.`, "Reduce load, change posture, or safe-hold."));
    }
    if (input.interface === "tool_state" && input.tool_state === undefined) {
      issues.push(makeIssue("error", "ToolStateCommandViolation", "$.tool_state", "Tool-state commands require an explicit tool_state value.", "Provide candidate, attach, hold, release, or expire."));
    }

    const hasViolation = issues.some((issue) => issue.severity === "warning" || issue.severity === "error");
    const decision = decideCommand(limit.saturation_policy, issues);
    const shouldClip = decision === "clipped";
    const limitedPosition = requestedPosition === undefined ? undefined : clipPositionLike(requestedPosition, positionBounds, shouldClip);
    const limitedGrip = requestedGrip === undefined ? undefined : clipPositionLike(requestedGrip, positionBounds, shouldClip);
    const limitedVelocity = velocityForCheck === undefined ? undefined : clipSymmetric(velocityForCheck, limit.max_velocity, shouldClip);
    const limitedAcceleration = accelerationForCheck === undefined ? undefined : clipSymmetric(accelerationForCheck, limit.max_acceleration, shouldClip);
    const limitedEffort = input.effort === undefined ? undefined : clipSymmetric(input.effort, limit.max_effort, shouldClip);
    const saturationRatio = Math.max(
      requestedPosition === undefined || positionBounds === undefined ? 0 : overflowRatio(requestedPosition, positionBounds.min, positionBounds.max),
      requestedGrip === undefined || positionBounds === undefined ? 0 : overflowRatio(requestedGrip, positionBounds.min, positionBounds.max),
      velocityForCheck === undefined ? 0 : Math.max(0, Math.abs(velocityForCheck) / limit.max_velocity - 1),
      accelerationForCheck === undefined ? 0 : Math.max(0, Math.abs(accelerationForCheck) / limit.max_acceleration - 1),
      input.effort === undefined ? 0 : Math.max(0, Math.abs(input.effort) / limit.max_effort - 1),
    );

    const base = {
      schema_version: ACTUATOR_LIMIT_CATALOG_SCHEMA_VERSION,
      embodiment_ref: limit.embodiment_ref,
      actuator_ref: limit.actuator_ref,
      target_joint_ref: limit.target_joint_ref,
      interface: input.interface,
      consumer: input.consumer,
      saturation_policy: limit.saturation_policy,
      decision: hasViolation ? decision : "accepted" as const,
      requested_position: requestedPosition === undefined ? undefined : round6(requestedPosition),
      limited_position: limitedPosition === undefined ? undefined : round6(limitedPosition),
      requested_velocity: input.velocity === undefined ? undefined : round6(input.velocity),
      limited_velocity: limitedVelocity === undefined ? undefined : round6(limitedVelocity),
      requested_acceleration: input.acceleration === undefined ? undefined : round6(input.acceleration),
      limited_acceleration: limitedAcceleration === undefined ? undefined : round6(limitedAcceleration),
      requested_effort: input.effort === undefined ? undefined : round6(input.effort),
      limited_effort: limitedEffort === undefined ? undefined : round6(limitedEffort),
      requested_grip_width: requestedGrip === undefined ? undefined : round6(requestedGrip),
      limited_grip_width: limitedGrip === undefined ? undefined : round6(limitedGrip),
      requested_tool_state: input.tool_state,
      accepted_tool_state: input.interface === "tool_state" && decision !== "rejected" ? input.tool_state : undefined,
      inferred_velocity: inferredVelocity === undefined ? undefined : round6(inferredVelocity),
      inferred_acceleration: inferredAcceleration === undefined ? undefined : round6(inferredAcceleration),
      saturation_ratio: round6(saturationRatio),
      issues: freezeArray(issues),
      ok: decision === "accepted" || decision === "clipped",
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Evaluates a batch of actuator commands, preserving per-command saturation
   * decisions and returning a control-cycle aggregate.
   */
  public evaluateBatchCommand(input: ActuatorBatchCommandInput): ActuatorBatchCommandReport {
    const model = this.requireEmbodiment(input.embodiment_ref ?? this.requireActiveEmbodiment().embodiment_id);
    const reports = freezeArray(input.commands.map((command) => this.evaluateActuatorCommand({
      ...command,
      embodiment_ref: model.embodiment_id,
      consumer: command.consumer ?? input.consumer,
    })));
    const issues = freezeArray(reports.flatMap((report) => report.issues.map((issue) => Object.freeze({ ...issue, path: `$.commands.${report.actuator_ref}.${issue.path}` }))));
    const base = {
      schema_version: ACTUATOR_LIMIT_CATALOG_SCHEMA_VERSION,
      embodiment_ref: model.embodiment_id,
      command_count: reports.length,
      accepted_count: reports.filter((report) => report.decision === "accepted").length,
      clipped_count: reports.filter((report) => report.decision === "clipped").length,
      rejected_count: reports.filter((report) => report.decision === "rejected").length,
      safe_hold_count: reports.filter((report) => report.decision === "safe_hold").length,
      reports,
      issues,
      ok: reports.every((report) => report.ok),
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  /**
   * Builds a prompt-safe actuator self-limit summary with only body capability
   * and command-envelope information.
   */
  public buildCognitiveActuatorLimitSummary(embodimentRef: Ref = this.requireActiveEmbodiment().embodiment_id): CognitiveActuatorLimitSummary {
    const report = this.buildCatalogReport({ embodiment_ref: embodimentRef });
    assertNoForbiddenLeak(report);
    const base = {
      schema_version: ACTUATOR_LIMIT_CATALOG_SCHEMA_VERSION,
      embodiment_ref: report.embodiment_ref,
      embodiment_kind: report.embodiment_kind,
      actuator_group_summaries: freezeArray(report.actuator_group_summaries.map((summary) => sanitizeText(`${summary.actuator_group}: ${summary.actuator_count} actuators, max velocity ${round3(summary.max_velocity)}, max effort ${round3(summary.max_effort)}`)).sort()),
      command_interface_summary: freezeArray(report.actuator_limits.map((limit) => sanitizeText(`${limit.actuator_ref}: ${limit.command_interfaces.join(",")} saturation=${limit.saturation_policy}`)).sort()),
      safety_summary: freezeArray(report.actuator_limits.map((limit) => sanitizeText(`${limit.actuator_ref}: joint ${limit.target_joint_ref}, accel ${round3(limit.max_acceleration)}, effort ${round3(limit.max_effort)}`)).sort()),
      hidden_fields_removed: hiddenFieldsRemoved(),
      cognitive_visibility: "body_self_knowledge_without_simulator_world_truth" as const,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }

  private requireActiveEmbodiment(): EmbodimentDescriptor {
    if (this.activeEmbodimentRef !== undefined) {
      return this.registry.requireEmbodiment(this.activeEmbodimentRef);
    }
    const model = this.registry.requireActiveEmbodiment();
    this.activeEmbodimentRef = model.embodiment_id;
    return model;
  }

  private requireEmbodiment(embodimentRef: Ref): EmbodimentDescriptor {
    return this.registry.requireEmbodiment(embodimentRef);
  }
}

export function createActuatorLimitCatalog(config: ActuatorLimitCatalogConfig = {}): ActuatorLimitCatalog {
  return new ActuatorLimitCatalog(config);
}

function resolveActuatorLimit(model: EmbodimentDescriptor, actuator: ActuatorLimitDescriptor, sharedIssues: ValidationIssue[]): ResolvedActuatorLimit {
  const issues: ValidationIssue[] = [];
  validateActuatorLimit(model, actuator, issues);
  const joint = model.joints.find((candidate) => candidate.joint_ref === actuator.target_joint_ref);
  const minPosition = actuator.min_position ?? joint?.min_position;
  const maxPosition = actuator.max_position ?? joint?.max_position;
  const jointMargin = joint?.safety_margin ?? 0;
  const safeMin = minPosition === undefined ? undefined : minPosition + jointMargin;
  const safeMax = maxPosition === undefined ? undefined : maxPosition - jointMargin;
  const maxAcceleration = actuator.max_acceleration ?? actuator.max_velocity * 4;
  const minimumStopDistance = maxAcceleration <= EPSILON ? 0 : (actuator.max_velocity * actuator.max_velocity) / (2 * maxAcceleration);
  const interfaces = freezeArray([...actuator.command_interfaces].sort());
  const base = {
    schema_version: ACTUATOR_LIMIT_CATALOG_SCHEMA_VERSION,
    embodiment_ref: model.embodiment_id,
    embodiment_kind: model.embodiment_kind,
    actuator_ref: actuator.actuator_ref,
    target_joint_ref: actuator.target_joint_ref,
    actuator_group: actuator.actuator_group,
    target_joint_group: joint?.joint_group,
    command_interfaces: interfaces,
    min_position: minPosition === undefined ? undefined : round6(minPosition),
    max_position: maxPosition === undefined ? undefined : round6(maxPosition),
    safe_min_position: safeMin === undefined ? undefined : round6(safeMin),
    safe_max_position: safeMax === undefined ? undefined : round6(safeMax),
    position_range: minPosition === undefined || maxPosition === undefined ? undefined : round6(maxPosition - minPosition),
    max_velocity: round6(actuator.max_velocity),
    max_effort: round6(actuator.max_effort),
    max_acceleration: round6(maxAcceleration),
    saturation_policy: actuator.saturation_policy,
    nominal_stop_time_s: round6(maxAcceleration <= EPSILON ? 0 : actuator.max_velocity / maxAcceleration),
    minimum_stop_distance: round6(minimumStopDistance),
    supports_position: interfaces.includes("position"),
    supports_velocity: interfaces.includes("velocity"),
    supports_effort: interfaces.includes("effort"),
    supports_grip_width: interfaces.includes("grip_width"),
    supports_tool_state: interfaces.includes("tool_state"),
    issues: freezeArray(issues),
    ok: !issues.some((issue) => issue.severity === "error"),
  };
  sharedIssues.push(...issues);
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function validateActuatorLimit(model: EmbodimentDescriptor, actuator: ActuatorLimitDescriptor, issues: ValidationIssue[]): void {
  validateSafeRef(actuator.actuator_ref, issues, `$.actuator_limits.${actuator.actuator_ref}.actuator_ref`, "ActuatorRefInvalid");
  validateSafeRef(actuator.target_joint_ref, issues, `$.actuator_limits.${actuator.actuator_ref}.target_joint_ref`, "ActuatorJointBindingMissing");
  const joint = model.joints.find((candidate) => candidate.joint_ref === actuator.target_joint_ref);
  if (joint === undefined) {
    issues.push(makeIssue("error", "ActuatorJointBindingMissing", `$.actuator_limits.${actuator.actuator_ref}.target_joint_ref`, "Actuator target joint is not declared.", "Bind every actuator to a declared joint."));
  } else if (joint.joint_group !== actuator.actuator_group) {
    issues.push(makeIssue("warning", "ActuatorJointBindingMissing", `$.actuator_limits.${actuator.actuator_ref}.actuator_group`, "Actuator group differs from target joint group.", "Keep actuator group aligned with the driven joint group unless intentionally bridged."));
  }
  if (actuator.command_interfaces.length === 0) {
    issues.push(makeIssue("error", "ActuatorInterfaceInvalid", `$.actuator_limits.${actuator.actuator_ref}.command_interfaces`, "Actuator must expose at least one command interface.", "Declare position, velocity, effort, grip_width, or tool_state."));
  }
  for (const commandInterface of actuator.command_interfaces) {
    if (!["position", "velocity", "effort", "grip_width", "tool_state"].includes(commandInterface)) {
      issues.push(makeIssue("error", "ActuatorInterfaceInvalid", `$.actuator_limits.${actuator.actuator_ref}.command_interfaces`, `Unsupported command interface ${commandInterface}.`, "Use a supported actuator command interface."));
    }
  }
  if (actuator.min_position !== undefined && !Number.isFinite(actuator.min_position)) {
    issues.push(makeIssue("error", "ActuatorLimitInvalid", `$.actuator_limits.${actuator.actuator_ref}.min_position`, "Actuator min_position must be finite when provided.", "Use finite SI-unit bounds."));
  }
  if (actuator.max_position !== undefined && !Number.isFinite(actuator.max_position)) {
    issues.push(makeIssue("error", "ActuatorLimitInvalid", `$.actuator_limits.${actuator.actuator_ref}.max_position`, "Actuator max_position must be finite when provided.", "Use finite SI-unit bounds."));
  }
  if (actuator.min_position !== undefined && actuator.max_position !== undefined && actuator.min_position >= actuator.max_position) {
    issues.push(makeIssue("error", "ActuatorLimitInvalid", `$.actuator_limits.${actuator.actuator_ref}`, "Actuator min_position must be below max_position.", "Correct the position or grip envelope."));
  }
  if (!Number.isFinite(actuator.max_velocity) || actuator.max_velocity <= 0) {
    issues.push(makeIssue("error", "ActuatorLimitInvalid", `$.actuator_limits.${actuator.actuator_ref}.max_velocity`, "Actuator max velocity must be positive and finite.", "Use calibrated velocity limits."));
  }
  if (!Number.isFinite(actuator.max_effort) || actuator.max_effort <= 0) {
    issues.push(makeIssue("error", "ActuatorLimitInvalid", `$.actuator_limits.${actuator.actuator_ref}.max_effort`, "Actuator max effort must be positive and finite.", "Use calibrated force or torque limits."));
  }
  if (actuator.max_acceleration !== undefined && (!Number.isFinite(actuator.max_acceleration) || actuator.max_acceleration <= 0)) {
    issues.push(makeIssue("error", "ActuatorLimitInvalid", `$.actuator_limits.${actuator.actuator_ref}.max_acceleration`, "Actuator max acceleration must be positive and finite when provided.", "Use calibrated acceleration limits."));
  }
  if (!["clip_and_report", "reject", "safe_hold"].includes(actuator.saturation_policy)) {
    issues.push(makeIssue("error", "ActuatorSaturationPolicyInvalid", `$.actuator_limits.${actuator.actuator_ref}.saturation_policy`, "Unsupported actuator saturation policy.", "Use clip_and_report, reject, or safe_hold."));
  }
}

function validateActuatorCatalogCoverage(model: EmbodimentDescriptor, limits: readonly ResolvedActuatorLimit[], issues: ValidationIssue[]): void {
  const actuatorRefs = new Set<Ref>();
  for (const actuator of model.actuator_limits) {
    if (actuatorRefs.has(actuator.actuator_ref)) {
      issues.push(makeIssue("error", "ActuatorLimitDuplicated", "$.actuator_limits", `Duplicate actuator ${actuator.actuator_ref}.`, "Actuator refs must be unique."));
    }
    actuatorRefs.add(actuator.actuator_ref);
  }
  const boundJoints = new Set(limits.map((limit) => limit.target_joint_ref));
  for (const joint of model.joints) {
    if (!boundJoints.has(joint.joint_ref) && limits.length === model.actuator_limits.length) {
      issues.push(makeIssue("warning", "ActuatorLimitMissing", `$.joints.${joint.joint_ref}`, `Joint ${joint.joint_ref} has no actuator in the active catalog.`, "Bind every controllable joint to an actuator limit."));
    }
  }
}

function buildGroupSummaries(limits: readonly ResolvedActuatorLimit[]): readonly ActuatorGroupLimitSummary[] {
  const groups = new Map<JointGroup, ResolvedActuatorLimit[]>();
  for (const limit of limits) {
    const group = groups.get(limit.actuator_group) ?? [];
    group.push(limit);
    groups.set(limit.actuator_group, group);
  }
  return freezeArray([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, values]) => Object.freeze({
    actuator_group: group,
    actuator_count: values.length,
    command_interfaces: freezeArray([...new Set(values.flatMap((value) => value.command_interfaces))].sort()),
    max_velocity: round6(Math.max(...values.map((value) => value.max_velocity))),
    max_effort: round6(Math.max(...values.map((value) => value.max_effort))),
    max_acceleration: round6(Math.max(...values.map((value) => value.max_acceleration))),
    saturation_policies: freezeArray([...new Set(values.map((value) => value.saturation_policy))].sort()),
    bound_joint_count: new Set(values.map((value) => value.target_joint_ref)).size,
  })));
}

function validateCommandInterface(limit: ResolvedActuatorLimit, commandInterface: ActuatorCommandInterface, issues: ValidationIssue[]): void {
  if (!limit.command_interfaces.includes(commandInterface)) {
    issues.push(makeIssue("error", "CommandInterfaceUnsupported", "$.interface", `Actuator ${limit.actuator_ref} does not support ${commandInterface}.`, "Use one of the actuator's declared command interfaces."));
  }
}

function validateCommandShape(input: ActuatorCommandInput, issues: ValidationIssue[]): void {
  for (const [path, value] of [
    ["$.position", input.position],
    ["$.velocity", input.velocity],
    ["$.acceleration", input.acceleration],
    ["$.effort", input.effort],
    ["$.grip_width", input.grip_width],
    ["$.previous_position", input.previous_position],
    ["$.previous_velocity", input.previous_velocity],
    ["$.delta_time_s", input.delta_time_s],
  ] as const) {
    if (value !== undefined && !Number.isFinite(value)) {
      issues.push(makeIssue("error", "CommandInputInvalid", path, "Command numeric fields must be finite.", "Use finite SI-unit command values or omit the field."));
    }
  }
  if (input.interface === "position" && input.position === undefined) {
    issues.push(makeIssue("error", "CommandInputInvalid", "$.position", "Position interface requires a position command.", "Provide position."));
  }
  if (input.interface === "velocity" && input.velocity === undefined) {
    issues.push(makeIssue("error", "CommandInputInvalid", "$.velocity", "Velocity interface requires a velocity command.", "Provide velocity."));
  }
  if (input.interface === "effort" && input.effort === undefined) {
    issues.push(makeIssue("error", "CommandInputInvalid", "$.effort", "Effort interface requires an effort command.", "Provide effort."));
  }
  if (input.interface === "grip_width" && input.grip_width === undefined) {
    issues.push(makeIssue("error", "CommandInputInvalid", "$.grip_width", "Grip-width interface requires a grip width command.", "Provide grip_width."));
  }
  if (input.delta_time_s !== undefined && input.delta_time_s <= 0) {
    issues.push(makeIssue("error", "CommandInputInvalid", "$.delta_time_s", "delta_time_s must be positive when provided.", "Use positive elapsed time."));
  }
}

function decideCommand(policy: SaturationPolicy, issues: readonly ValidationIssue[]): ActuatorCommandDecision {
  if (!issues.some((issue) => issue.severity === "warning" || issue.severity === "error")) {
    return "accepted";
  }
  if (issues.some((issue) => issue.severity === "error")) {
    return policy === "safe_hold" ? "safe_hold" : "rejected";
  }
  if (policy === "clip_and_report") {
    return "clipped";
  }
  if (policy === "safe_hold") {
    return "safe_hold";
  }
  return "rejected";
}

function boundsForPositionLikeCommand(limit: ResolvedActuatorLimit): { readonly min: number; readonly max: number } | undefined {
  if (limit.safe_min_position !== undefined && limit.safe_max_position !== undefined && limit.safe_min_position < limit.safe_max_position) {
    return Object.freeze({ min: limit.safe_min_position, max: limit.safe_max_position });
  }
  if (limit.min_position !== undefined && limit.max_position !== undefined && limit.min_position < limit.max_position) {
    return Object.freeze({ min: limit.min_position, max: limit.max_position });
  }
  return undefined;
}

function clipPositionLike(value: number, bounds: { readonly min: number; readonly max: number } | undefined, enabled: boolean): number {
  if (!enabled || bounds === undefined) {
    return value;
  }
  return clamp(value, bounds.min, bounds.max);
}

function clipSymmetric(value: number, maxAbs: number, enabled: boolean): number {
  return enabled ? clamp(value, -maxAbs, maxAbs) : value;
}

function overflowRatio(value: number, min: number, max: number): number {
  if (value < min) {
    return (min - value) / Math.max(Math.abs(max - min), EPSILON);
  }
  if (value > max) {
    return (value - max) / Math.max(Math.abs(max - min), EPSILON);
  }
  return 0;
}

function inferVelocity(input: ActuatorCommandInput): number | undefined {
  if (input.position === undefined || input.previous_position === undefined || input.delta_time_s === undefined || input.delta_time_s <= EPSILON) {
    return undefined;
  }
  return (input.position - input.previous_position) / input.delta_time_s;
}

function inferAcceleration(input: ActuatorCommandInput, inferredVelocity: number | undefined): number | undefined {
  if (inferredVelocity === undefined || input.previous_velocity === undefined || input.delta_time_s === undefined || input.delta_time_s <= EPSILON) {
    return undefined;
  }
  return (inferredVelocity - input.previous_velocity) / input.delta_time_s;
}

function assertSafeRef(ref: Ref, path: string): void {
  const issues: ValidationIssue[] = [];
  validateSafeRef(ref, issues, path, "ActuatorRefInvalid");
  if (issues.length > 0) {
    throw new ActuatorLimitCatalogError("Reference is not safe for actuator limit use.", issues);
  }
}

function validateSafeRef(ref: Ref, issues: ValidationIssue[], path: string, code: ActuatorLimitIssueCode): void {
  if (typeof ref !== "string" || ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(makeIssue("error", code, path, "Reference must be a non-empty whitespace-free string.", "Use an opaque body-relative reference."));
  }
  if (ref === "W" || !isSafeText(ref)) {
    issues.push(makeIssue("error", "ForbiddenBodyDetail", path, "Reference contains forbidden simulator/backend detail.", "Use sanitized body, joint, or actuator refs."));
  }
}

function assertNoForbiddenLeak(report: ActuatorLimitCatalogReport): void {
  const issues: ValidationIssue[] = [];
  for (const limit of report.actuator_limits) {
    for (const value of [limit.actuator_ref, limit.target_joint_ref]) {
      if (!isSafeText(value) || value === "W") {
        issues.push(makeIssue("error", "ForbiddenBodyDetail", "$.actuator_limits", `Actuator limit field ${value} contains forbidden simulator detail.`, "Strip backend handles and world-truth refs before model-facing output."));
      }
    }
  }
  if (issues.length > 0) {
    throw new ActuatorLimitCatalogError("Actuator limit report contains forbidden simulator detail.", issues);
  }
}

function hiddenFieldsRemoved(): readonly string[] {
  return freezeArray(["simulator_world_frame_W", "backend_body_handles", "engine_joint_handles", "collision_mesh_refs", "exact_hidden_com", "qa_truth_refs"]);
}

function sanitizeText(value: string): string {
  return value.replace(FORBIDDEN_DETAIL_PATTERN, "hidden-detail").trim();
}

function isSafeText(value: string): boolean {
  return !FORBIDDEN_DETAIL_PATTERN.test(value);
}

function makeIssue(severity: ValidationSeverity, code: ActuatorLimitIssueCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
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

export const ACTUATOR_LIMIT_CATALOG_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: ACTUATOR_LIMIT_CATALOG_SCHEMA_VERSION,
  blueprint: "architecture_docs/05_EMBODIMENT_KINEMATICS_QUADRUPED_HUMANOID.md",
  sections: freezeArray(["5.3", "5.5", "5.6", "5.16", "5.19", "5.20"]),
  responsibilities: freezeArray([
    "resolve actuator command interfaces and joint bindings",
    "resolve torque, force, grip, velocity, and acceleration envelopes",
    "apply clip, reject, and safe-hold saturation policies",
    "validate actuator command batches before control execution",
    "publish cognitive-safe actuator capability summaries",
  ]),
});
