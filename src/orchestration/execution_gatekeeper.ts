/**
 * Execution gatekeeper for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md`
 * sections 8.3, 8.9.8, 8.12, 8.14.2, 8.15, 8.16, and 8.17.
 *
 * This module implements the executable `ExecutionGatekeeper`. It is the hard
 * boundary between validated plans and physical execution: no primitive work
 * order is emitted until the approved plan, safety envelope, primitive catalog,
 * current precondition check, controller readiness report, monologue policy,
 * observation currency, and actuator command ownership are all cleared.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";
import type { ControlStackActuatorCommand, GatewayCommandMode } from "../simulation/actuator_application_gateway";
import type { LocomotionPrimitive, ManipulationPrimitive } from "../embodiment/embodiment_model_registry";
import type { ChainPlanarIKReport } from "../embodiment/kinematic_chain_registry";
import type { EmbodimentFeasibilityReport } from "../embodiment/embodiment_validation_adapter";
import type {
  OrchestrationEventEnvelope,
  PrimaryState,
  RuntimeStateSnapshot,
} from "./orchestration_state_machine";

export const EXECUTION_GATEKEEPER_SCHEMA_VERSION = "mebsuta.execution_gatekeeper.v1" as const;
export const EXECUTION_GATEKEEPER_VERSION = "1.0.0" as const;

const CONTRACT_TRACEABILITY_REF = "architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md#ExecutionGatekeeper" as const;
const DEFAULT_PRECONDITION_MAX_AGE_MS = 500;
const DEFAULT_OBSERVATION_MAX_AGE_MS = 5_000;
const DEFAULT_SEQUENCE_DEADLINE_MARGIN_MS = 250;
const FORBIDDEN_EXECUTION_TEXT_PATTERN = /(gemini_direct|raw_model|unvalidated|without validation|skip validation|ignore safety|override safety|developer_debug|backend|engine|scene_graph|world_truth|ground_truth|qa_|hidden state|direct actuator|joint torque stream|reinforcement learning|reward policy|policy gradient)/i;

export type ExecutionGateDecision = "work_order_ready" | "blocked" | "safe_hold_required" | "reobserve_required" | "human_review_required";
export type ExecutionGuardName =
  | "PlanApprovalGuard"
  | "SafetyEnvelopeGuard"
  | "PrimitiveKnownGuard"
  | "PreconditionRecheckGuard"
  | "ControllerReadinessGuard"
  | "MonologuePolicyGuard"
  | "ObservationCurrencyGuard"
  | "CommandOwnershipGuard";
export type ExecutionGuardStatus = "clear" | "warning" | "blocked" | "not_applicable";
export type ExecutionPrimitiveKind = ManipulationPrimitive | LocomotionPrimitive | "orient_sensor" | "observe_from_pose" | "hold_position";
export type ControllerReadinessStatus = "ready" | "ready_with_warnings" | "not_ready";
export type IKReadinessStatus = "feasible" | "feasible_with_margin_warning" | "not_required" | "infeasible" | "unsafe" | "ambiguous";
export type TrajectoryReadinessStatus = "ready" | "ready_with_warnings" | "not_ready" | "collision_risk" | "stale";
export type PDReadinessStatus = "ready" | "ready_with_warnings" | "not_ready" | "saturated";
export type MonologueExecutionStatus = "not_required" | "completed" | "skipped_by_policy" | "failed" | "interrupted" | "missing" | "mismatch";
export type ExecutionMonitorChannel = "joint_state" | "contact" | "force_torque" | "vision" | "audio" | "tracking_error" | "timeout" | "operator";

/**
 * A validator-approved primitive step. The gatekeeper does not invent or
 * reshape commands; it verifies that each command already carries validation,
 * safety, ownership, freshness, and actuator-envelope references.
 */
export interface ApprovedPrimitiveStep {
  readonly primitive_ref: Ref;
  readonly primitive_kind: ExecutionPrimitiveKind;
  readonly sequence_index: number;
  readonly end_effector_ref?: Ref;
  readonly target_chain_ref?: Ref;
  readonly controller_profile_ref: Ref;
  readonly expected_duration_ms: number;
  readonly deadline_ms?: number;
  readonly required_actuator_refs: readonly Ref[];
  readonly required_sensor_refs: readonly Ref[];
  readonly precondition_refs: readonly Ref[];
  readonly postcondition_refs: readonly Ref[];
  readonly actuator_commands: readonly ControlStackActuatorCommand[];
  readonly ik_report?: ChainPlanarIKReport;
  readonly embodiment_feasibility?: EmbodimentFeasibilityReport;
}

/**
 * Plan artifact admitted by deterministic validators. It must be a validation
 * result, not a raw model response, and its primitive sequence must already be
 * translated into deterministic control-stack commands.
 */
export interface ApprovedExecutionPlan {
  readonly approved_plan_ref: Ref;
  readonly validation_decision_ref: Ref;
  readonly validator_handoff_ref: Ref;
  readonly task_ref: Ref;
  readonly embodiment_ref: Ref;
  readonly latest_observation_ref: Ref;
  readonly validation_status: "approved" | "approved_with_warnings" | "rejected" | "stale" | "unknown";
  readonly approved_at_ms: number;
  readonly expires_at_ms?: number;
  readonly action_bearing: boolean;
  readonly requires_monologue: boolean;
  readonly validator_confidence: number;
  readonly primitive_sequence: readonly ApprovedPrimitiveStep[];
  readonly provenance_refs: readonly Ref[];
  readonly safety_notes: readonly string[];
}

/**
 * Motion safety envelope supplied by validation and safety systems before
 * execution. It carries speed, force, workspace, tool, retry, and monitoring
 * constraints used by File 08 pre-execution guards.
 */
export interface ExecutionSafetyEnvelope {
  readonly safety_envelope_ref: Ref;
  readonly approved_plan_ref: Ref;
  readonly issued_at_ms: number;
  readonly stale_after_ms: number;
  readonly allowed_primitive_refs: readonly Ref[];
  readonly allowed_actuator_refs: readonly Ref[];
  readonly allowed_tool_refs?: readonly Ref[];
  readonly workspace_envelope_ref: Ref;
  readonly max_linear_speed_mps: number;
  readonly max_angular_speed_rad_s: number;
  readonly max_contact_force_n: number;
  readonly max_joint_effort_n_m: number;
  readonly retry_limit: number;
  readonly require_contact_monitoring: boolean;
  readonly require_tracking_monitoring: boolean;
  readonly safe_hold_on_violation: boolean;
}

/**
 * Fresh body and scene precondition check taken immediately before execution.
 */
export interface ExecutionPreconditionCheck {
  readonly check_ref: Ref;
  readonly observation_ref: Ref;
  readonly body_state_ref: Ref;
  readonly checked_at_ms: number;
  readonly max_age_ms?: number;
  readonly object_state_changed: boolean;
  readonly gripper_state_changed: boolean;
  readonly support_unstable: boolean;
  readonly critical_sensor_stale: boolean;
  readonly active_contacts_valid: boolean;
  readonly required_precondition_refs: readonly Ref[];
  readonly satisfied_precondition_refs: readonly Ref[];
  readonly issue_refs: readonly Ref[];
}

/**
 * Controller-stack readiness record. IK, trajectory generation, PD control,
 * actuator health, and monitor availability are evaluated before the work
 * order can be released.
 */
export interface ControllerReadinessReport {
  readonly readiness_ref: Ref;
  readonly controller_profile_ref: Ref;
  readonly evaluated_at_ms: number;
  readonly status: ControllerReadinessStatus;
  readonly ik_status: IKReadinessStatus;
  readonly trajectory_status: TrajectoryReadinessStatus;
  readonly pd_status: PDReadinessStatus;
  readonly controller_available: boolean;
  readonly actuator_saturation_predicted: boolean;
  readonly trajectory_ref?: Ref;
  readonly ik_report_refs: readonly Ref[];
  readonly required_monitor_channels: readonly ExecutionMonitorChannel[];
  readonly available_monitor_channels: readonly ExecutionMonitorChannel[];
  readonly issue_refs: readonly Ref[];
}

/**
 * Monologue routing state. Speech never approves execution, but required
 * monologue completion or an explicit skip policy is checked before motion.
 */
export interface MonologueExecutionGate {
  readonly policy_ref: Ref;
  readonly required: boolean;
  readonly status: MonologueExecutionStatus;
  readonly speech_ref?: Ref;
  readonly completed_at_ms?: number;
  readonly allow_skip_when_noncritical: boolean;
  readonly safety_interruption_active: boolean;
  readonly expected_plan_ref: Ref;
}

/**
 * Control policy used to schedule a primitive sequence into the deterministic
 * control layer after all pre-execution guards are clear.
 */
export interface ExecutionControlPolicy {
  readonly control_policy_ref: Ref;
  readonly command_owner_ref: Ref;
  readonly schedule_start_tick: number;
  readonly schedule_start_time_s: number;
  readonly max_sequence_duration_ms: number;
  readonly command_stale_after_ms: number;
  readonly allowed_command_modes: readonly GatewayCommandMode[];
  readonly monitor_channels: readonly ExecutionMonitorChannel[];
  readonly safe_hold_primitive_ref: Ref;
  readonly allow_monologue_skip: boolean;
}

/**
 * Current execution authority state. The snapshot is optional so tests can
 * evaluate the gatekeeper with a compact command-ownership record.
 */
export interface ExecutionRuntimeContext {
  readonly runtime_ref: Ref;
  readonly current_time_ms: number;
  readonly current_time_s: number;
  readonly current_tick: number;
  readonly primary_state: PrimaryState;
  readonly safety_mode: RuntimeStateSnapshot["safety_mode"];
  readonly active_primitive_ref?: Ref;
  readonly command_owner_state?: PrimaryState;
  readonly latest_observation_ref?: Ref;
  readonly observation_age_ms?: number;
  readonly snapshot?: RuntimeStateSnapshot;
}

/**
 * Request matching File 08's `enterExecuteState` architecture signature with
 * the extra runtime facts needed for deterministic pre-execution guards.
 */
export interface ExecuteStateEntryRequest {
  readonly approved_plan: ApprovedExecutionPlan;
  readonly safety_envelope: ExecutionSafetyEnvelope;
  readonly control_policy: ExecutionControlPolicy;
  readonly precondition_check: ExecutionPreconditionCheck;
  readonly controller_readiness: ControllerReadinessReport;
  readonly monologue_gate: MonologueExecutionGate;
  readonly runtime_context: ExecutionRuntimeContext;
}

export interface ExecutionGuardResult {
  readonly guard_name: ExecutionGuardName;
  readonly status: ExecutionGuardStatus;
  readonly blocking: boolean;
  readonly safe_hold_required: boolean;
  readonly reobserve_required: boolean;
  readonly human_review_required: boolean;
  readonly reason: string;
  readonly evidence_refs: readonly Ref[];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface PrimitiveExecutionWorkOrder {
  readonly schema_version: typeof EXECUTION_GATEKEEPER_SCHEMA_VERSION;
  readonly work_order_ref: Ref;
  readonly approved_plan_ref: Ref;
  readonly validation_decision_ref: Ref;
  readonly safety_envelope_ref: Ref;
  readonly control_policy_ref: Ref;
  readonly command_owner_ref: Ref;
  readonly embodiment_ref: Ref;
  readonly primitive_sequence: readonly ApprovedPrimitiveStep[];
  readonly actuator_command_batch: readonly ControlStackActuatorCommand[];
  readonly required_monitor_channels: readonly ExecutionMonitorChannel[];
  readonly schedule_start_tick: number;
  readonly schedule_start_time_s: number;
  readonly sequence_deadline_ms: number;
  readonly safe_hold_primitive_ref: Ref;
  readonly audit_event: OrchestrationEventEnvelope;
  readonly cognitive_visibility: "runtime_control_and_validator_only";
  readonly determinism_hash: string;
}

export interface ExecutionGatekeeperReport {
  readonly schema_version: typeof EXECUTION_GATEKEEPER_SCHEMA_VERSION;
  readonly gatekeeper_version: typeof EXECUTION_GATEKEEPER_VERSION;
  readonly decision: ExecutionGateDecision;
  readonly work_order?: PrimitiveExecutionWorkOrder;
  readonly guard_results: readonly ExecutionGuardResult[];
  readonly issue_count: number;
  readonly error_count: number;
  readonly warning_count: number;
  readonly issues: readonly ValidationIssue[];
  readonly traceability_ref: typeof CONTRACT_TRACEABILITY_REF;
  readonly determinism_hash: string;
}

export class ExecutionGatekeeperError extends Error {
  public readonly report: ExecutionGatekeeperReport;

  public constructor(message: string, report: ExecutionGatekeeperReport) {
    super(message);
    this.name = "ExecutionGatekeeperError";
    this.report = report;
  }
}

/**
 * Deterministic File 08 execution-entry gate. It emits a work order only when
 * every pre-execution guard is clear or warning-only.
 */
export class ExecutionGatekeeper {
  /**
   * File 08 entry action for Execute. Callers that require diagnostics should
   * use `evaluateExecuteState`; this convenience API throws when motion is not
   * authorized.
   */
  public enterExecuteState(
    approvedPlan: ApprovedExecutionPlan,
    safetyEnvelope: ExecutionSafetyEnvelope,
    controlPolicy: ExecutionControlPolicy,
    preconditionCheck: ExecutionPreconditionCheck,
    controllerReadiness: ControllerReadinessReport,
    monologueGate: MonologueExecutionGate,
    runtimeContext: ExecutionRuntimeContext,
  ): PrimitiveExecutionWorkOrder {
    const report = this.evaluateExecuteState({
      approved_plan: approvedPlan,
      safety_envelope: safetyEnvelope,
      control_policy: controlPolicy,
      precondition_check: preconditionCheck,
      controller_readiness: controllerReadiness,
      monologue_gate: monologueGate,
      runtime_context: runtimeContext,
    });
    if (report.work_order === undefined) {
      throw new ExecutionGatekeeperError(`Execution request blocked: ${report.decision}.`, report);
    }
    return report.work_order;
  }

  /**
   * Evaluates the full pre-execution guard stack and returns an auditable
   * decision. This method never dispatches commands or mutates runtime state.
   */
  public evaluateExecuteState(request: ExecuteStateEntryRequest): ExecutionGatekeeperReport {
    const structuralIssues = validateRequestShape(request);
    const guards = freezeArray([
      planApprovalGuard(request),
      safetyEnvelopeGuard(request),
      primitiveKnownGuard(request),
      preconditionRecheckGuard(request),
      controllerReadinessGuard(request),
      monologuePolicyGuard(request),
      observationCurrencyGuard(request),
      commandOwnershipGuard(request),
    ]);
    const issues = freezeArray([...structuralIssues, ...guards.flatMap((guard) => guard.issues)]);
    const decision = chooseDecision(guards, issues);
    const workOrder = decision === "work_order_ready" ? buildWorkOrder(request, guards) : undefined;
    return makeReport(decision, workOrder, guards, issues);
  }
}

function planApprovalGuard(request: ExecuteStateEntryRequest): ExecutionGuardResult {
  const issues: ValidationIssue[] = [];
  const plan = request.approved_plan;
  const nowMs = request.runtime_context.current_time_ms;
  const approved = plan.validation_status === "approved" || plan.validation_status === "approved_with_warnings";
  if (!approved) {
    issues.push(issue("error", "PlanNotApproved", "$.approved_plan.validation_status", "Execution requires an approved validation decision.", "Route the plan through Validate before Execute."));
  }
  if (!plan.action_bearing) {
    issues.push(issue("error", "PlanNotActionBearing", "$.approved_plan.action_bearing", "Execute requires an action-bearing plan.", "Use Observe, Verify, or Monologue for non-motion work."));
  }
  if (plan.primitive_sequence.length === 0) {
    issues.push(issue("error", "PrimitiveSequenceMissing", "$.approved_plan.primitive_sequence", "Approved plan has no primitive sequence.", "Validate a deterministic primitive sequence before execution."));
  }
  if (plan.expires_at_ms !== undefined && plan.expires_at_ms <= nowMs) {
    issues.push(issue("error", "ApprovedPlanExpired", "$.approved_plan.expires_at_ms", "Approved plan is stale for execution.", "Revalidate against current observation and body state."));
  }
  if (!sameRef(plan.approved_plan_ref, request.safety_envelope.approved_plan_ref) || !sameRef(plan.approved_plan_ref, request.monologue_gate.expected_plan_ref)) {
    issues.push(issue("error", "PlanReferenceMismatch", "$.approved_plan.approved_plan_ref", "Plan, safety envelope, and monologue gate must reference the same approved plan.", "Rebuild execution inputs from the same validation decision."));
  }
  if (plan.validator_confidence < 0.5 || !Number.isFinite(plan.validator_confidence)) {
    issues.push(issue("error", "ValidatorConfidenceTooLow", "$.approved_plan.validator_confidence", "Validator confidence is too low for physical execution.", "Reobserve, revalidate, or request human review."));
  }
  return guard("PlanApprovalGuard", issues, "Approved plan, validation decision, and action-bearing primitive sequence are available.", [plan.approved_plan_ref, plan.validation_decision_ref, plan.validator_handoff_ref, ...plan.provenance_refs], { humanReviewOnError: true });
}

function safetyEnvelopeGuard(request: ExecuteStateEntryRequest): ExecutionGuardResult {
  const issues: ValidationIssue[] = [];
  const envelope = request.safety_envelope;
  const nowMs = request.runtime_context.current_time_ms;
  const primitiveRefs = request.approved_plan.primitive_sequence.map((step) => step.primitive_ref);
  const commandActuatorRefs = request.approved_plan.primitive_sequence.flatMap((step) => [
    ...step.required_actuator_refs,
    ...step.actuator_commands.map((command) => command.actuator_id),
  ]);
  if (envelope.stale_after_ms <= 0 || envelope.issued_at_ms + envelope.stale_after_ms <= nowMs) {
    issues.push(issue("error", "SafetyEnvelopeStale", "$.safety_envelope", "Safety envelope is missing freshness for current execution.", "Refresh safety approval immediately before dispatch."));
  }
  if (envelope.max_linear_speed_mps <= 0 || envelope.max_angular_speed_rad_s <= 0 || envelope.max_contact_force_n <= 0 || envelope.max_joint_effort_n_m <= 0) {
    issues.push(issue("error", "SafetyEnvelopeLimitMissing", "$.safety_envelope", "Safety envelope must include finite speed, force, and effort limits.", "Attach speed, force, and effort limits from SafetyManager."));
  }
  if (envelope.retry_limit < 0 || Number.isInteger(envelope.retry_limit) === false) {
    issues.push(issue("error", "SafetyEnvelopeRetryInvalid", "$.safety_envelope.retry_limit", "Retry limit must be a finite non-negative integer.", "Use a bounded retry policy."));
  }
  const disallowedPrimitives = primitiveRefs.filter((ref) => !envelope.allowed_primitive_refs.includes(ref));
  if (disallowedPrimitives.length > 0) {
    issues.push(issue("error", "PrimitiveOutsideSafetyEnvelope", "$.safety_envelope.allowed_primitive_refs", `Primitive refs outside envelope: ${disallowedPrimitives.join(", ")}.`, "Regenerate safety envelope for the validated primitive sequence."));
  }
  const disallowedActuators = unique(commandActuatorRefs).filter((ref) => !envelope.allowed_actuator_refs.includes(ref));
  if (disallowedActuators.length > 0) {
    issues.push(issue("error", "ActuatorOutsideSafetyEnvelope", "$.safety_envelope.allowed_actuator_refs", `Actuator refs outside envelope: ${disallowedActuators.join(", ")}.`, "Use only actuators admitted by the safety envelope."));
  }
  if (!envelope.require_tracking_monitoring) {
    issues.push(issue("warning", "TrackingMonitorNotRequired", "$.safety_envelope.require_tracking_monitoring", "Tracking monitoring is disabled for an execution request.", "Enable tracking error monitoring for physical primitives unless a validator justified otherwise."));
  }
  return guard("SafetyEnvelopeGuard", issues, "Safety envelope contains current speed, force, workspace, primitive, actuator, and retry limits.", [envelope.safety_envelope_ref, envelope.workspace_envelope_ref, ...primitiveRefs]);
}

function primitiveKnownGuard(request: ExecuteStateEntryRequest): ExecutionGuardResult {
  const issues: ValidationIssue[] = [];
  const allowedModes = new Set(request.control_policy.allowed_command_modes);
  const primitiveRefs = new Set<Ref>();
  for (const [index, step] of request.approved_plan.primitive_sequence.entries()) {
    const path = `$.approved_plan.primitive_sequence[${index}]`;
    if (primitiveRefs.has(step.primitive_ref)) {
      issues.push(issue("error", "PrimitiveRefDuplicated", `${path}.primitive_ref`, "Primitive refs must be unique inside an execution sequence.", "Create stable per-step primitive refs."));
    }
    primitiveRefs.add(step.primitive_ref);
    if (step.sequence_index !== index) {
      issues.push(issue("error", "PrimitiveSequenceIndexInvalid", `${path}.sequence_index`, "Primitive sequence indexes must be contiguous and deterministic.", "Sort and renumber the validated primitive sequence."));
    }
    if (step.expected_duration_ms <= 0 || !Number.isFinite(step.expected_duration_ms)) {
      issues.push(issue("error", "PrimitiveDurationInvalid", `${path}.expected_duration_ms`, "Primitive duration must be positive and finite.", "Attach a control-profile duration estimate."));
    }
    if (step.actuator_commands.length === 0 && step.primitive_kind !== "hold_position") {
      issues.push(issue("error", "PrimitiveCommandsMissing", `${path}.actuator_commands`, "Executable primitives require deterministic actuator commands.", "Translate the validated primitive into control-stack commands."));
    }
    if (step.embodiment_feasibility !== undefined && !step.embodiment_feasibility.ok) {
      issues.push(issue("error", "EmbodimentFeasibilityRejected", `${path}.embodiment_feasibility`, "Embodiment validation did not admit the primitive.", "Replan, reobserve, or use ToolAssess."));
    }
    if (step.ik_report !== undefined && !step.ik_report.feasible) {
      issues.push(issue("error", "PrimitiveIKInfeasible", `${path}.ik_report`, "IK report is not feasible for this primitive.", "Regenerate the primitive with reachable body-relative targets."));
    }
    for (const command of step.actuator_commands) {
      validateCommandForPrimitive(command, step, request, allowedModes, issues, `${path}.actuator_commands`);
    }
  }
  return guard("PrimitiveKnownGuard", issues, "Primitive sequence is deterministic, embodiment-admitted, IK-checked, and translated into validator-approved actuator commands.", Array.from(primitiveRefs));
}

function preconditionRecheckGuard(request: ExecuteStateEntryRequest): ExecutionGuardResult {
  const issues: ValidationIssue[] = [];
  const check = request.precondition_check;
  const nowMs = request.runtime_context.current_time_ms;
  const maxAgeMs = check.max_age_ms ?? DEFAULT_PRECONDITION_MAX_AGE_MS;
  if (nowMs - check.checked_at_ms > maxAgeMs || nowMs < check.checked_at_ms) {
    issues.push(issue("error", "PreconditionCheckStale", "$.precondition_check.checked_at_ms", "Precondition check is not current enough for execution.", "Recheck body state, object state, contacts, and sensors immediately before dispatch."));
  }
  if (!sameRef(check.observation_ref, request.approved_plan.latest_observation_ref)) {
    issues.push(issue("error", "PreconditionObservationMismatch", "$.precondition_check.observation_ref", "Precondition check does not reference the latest validated observation.", "Reobserve or revalidate before execution."));
  }
  if (check.object_state_changed) {
    issues.push(issue("error", "ObjectMovedBeforeExecution", "$.precondition_check.object_state_changed", "Target or obstacle state changed after validation.", "Reobserve and revalidate the plan."));
  }
  if (check.gripper_state_changed) {
    issues.push(issue("error", "GripperStateChangedBeforeExecution", "$.precondition_check.gripper_state_changed", "End effector state changed after validation.", "Recheck grasp/contact state and revalidate."));
  }
  if (check.support_unstable) {
    issues.push(issue("error", "SupportUnstableBeforeExecution", "$.precondition_check.support_unstable", "Support or posture is unstable.", "Stabilize or enter SafeHold."));
  }
  if (check.critical_sensor_stale) {
    issues.push(issue("error", "CriticalSensorStale", "$.precondition_check.critical_sensor_stale", "A critical execution sensor is stale.", "Refresh sensor evidence before execution."));
  }
  if (!check.active_contacts_valid) {
    issues.push(issue("warning", "ActiveContactsUncertain", "$.precondition_check.active_contacts_valid", "Active contacts are not fully confirmed.", "Use cautious control or recheck contact evidence."));
  }
  const missingPreconditions = check.required_precondition_refs.filter((ref) => !check.satisfied_precondition_refs.includes(ref));
  if (missingPreconditions.length > 0) {
    issues.push(issue("error", "RequiredPreconditionUnsatisfied", "$.precondition_check.satisfied_precondition_refs", `Unsatisfied preconditions: ${missingPreconditions.join(", ")}.`, "Satisfy or revalidate required preconditions."));
  }
  return guard("PreconditionRecheckGuard", issues, "Fresh body, object, sensor, support, and contact preconditions are current for execution.", [check.check_ref, check.observation_ref, check.body_state_ref, ...check.issue_refs], { reobserveOnError: true });
}

function controllerReadinessGuard(request: ExecuteStateEntryRequest): ExecutionGuardResult {
  const issues: ValidationIssue[] = [];
  const readiness = request.controller_readiness;
  const requiredChannels = new Set<ExecutionMonitorChannel>([
    ...readiness.required_monitor_channels,
    ...request.control_policy.monitor_channels,
    ...(request.safety_envelope.require_contact_monitoring ? ["contact" as const] : []),
    ...(request.safety_envelope.require_tracking_monitoring ? ["tracking_error" as const] : []),
  ]);
  if (readiness.status === "not_ready" || !readiness.controller_available) {
    issues.push(issue("error", "ControllerUnavailable", "$.controller_readiness.status", "Controller profile is not ready for execution.", "Start or repair the deterministic controller stack before dispatch."));
  }
  if (readiness.ik_status === "infeasible" || readiness.ik_status === "unsafe" || readiness.ik_status === "ambiguous") {
    issues.push(issue("error", "IKReadinessRejected", "$.controller_readiness.ik_status", "IK readiness is not safe for execution.", "Replan or validate a reachable target."));
  }
  if (readiness.trajectory_status === "not_ready" || readiness.trajectory_status === "collision_risk" || readiness.trajectory_status === "stale") {
    issues.push(issue("error", "TrajectoryReadinessRejected", "$.controller_readiness.trajectory_status", "Trajectory readiness does not allow execution.", "Regenerate or revalidate trajectory before dispatch."));
  }
  if (readiness.pd_status === "not_ready" || readiness.pd_status === "saturated" || readiness.actuator_saturation_predicted) {
    issues.push(issue("error", "ControllerSaturationPredicted", "$.controller_readiness.pd_status", "Controller or actuator saturation is predicted.", "Reduce speed, effort, payload, or choose another primitive."));
  }
  const missingChannels = Array.from(requiredChannels).filter((channel) => !readiness.available_monitor_channels.includes(channel));
  if (missingChannels.length > 0) {
    issues.push(issue("error", "ExecutionMonitorMissing", "$.controller_readiness.available_monitor_channels", `Missing monitor channels: ${missingChannels.join(", ")}.`, "Enable required telemetry, contact, vision, audio, or timeout monitors."));
  }
  return guard("ControllerReadinessGuard", issues, "IK, trajectory, PD control, actuator saturation, and monitor channels are ready.", [readiness.readiness_ref, readiness.controller_profile_ref, ...readiness.ik_report_refs, ...readiness.issue_refs]);
}

function monologuePolicyGuard(request: ExecuteStateEntryRequest): ExecutionGuardResult {
  const issues: ValidationIssue[] = [];
  const gate = request.monologue_gate;
  if (gate.safety_interruption_active) {
    issues.push(issue("error", "MonologueSafetyInterruptionActive", "$.monologue_gate.safety_interruption_active", "Safety interruption is active during monologue gate.", "Enter SafeHold before any motion."));
  }
  if (request.approved_plan.requires_monologue || gate.required) {
    const completed = gate.status === "completed";
    const skipped = gate.status === "skipped_by_policy" && gate.allow_skip_when_noncritical && request.control_policy.allow_monologue_skip;
    if (!completed && !skipped) {
      issues.push(issue("error", "RequiredMonologueIncomplete", "$.monologue_gate.status", "Required monologue did not complete and was not policy-skipped.", "Complete, explicitly skip under policy, or enter SafeHold."));
    }
  }
  if (gate.status === "failed" || gate.status === "interrupted" || gate.status === "mismatch") {
    issues.push(issue("error", "MonologuePolicyRejected", "$.monologue_gate.status", "Monologue state result is incompatible with execution.", "Reassess speech policy or SafeHold before motion."));
  }
  return guard("MonologuePolicyGuard", issues, "Monologue is complete, not required, or explicitly skipped by policy; speech never grants safety approval.", [gate.policy_ref, gate.expected_plan_ref, gate.speech_ref].filter(isRef));
}

function observationCurrencyGuard(request: ExecuteStateEntryRequest): ExecutionGuardResult {
  const issues: ValidationIssue[] = [];
  const latest = request.runtime_context.latest_observation_ref ?? request.runtime_context.snapshot?.latest_observation_ref;
  const ageMs = request.runtime_context.observation_age_ms ?? 0;
  if (!sameRef(latest, request.approved_plan.latest_observation_ref)) {
    issues.push(issue("error", "ExecutionObservationMismatch", "$.runtime_context.latest_observation_ref", "Runtime observation does not match the validated plan observation.", "Reobserve and revalidate before execution."));
  }
  if (ageMs > DEFAULT_OBSERVATION_MAX_AGE_MS || ageMs < 0) {
    issues.push(issue("error", "ExecutionObservationStale", "$.runtime_context.observation_age_ms", "Observation is stale for Execute.", "Refresh embodied observation before dispatch."));
  }
  return guard("ObservationCurrencyGuard", issues, "Runtime observation is current and matches the validator-approved plan.", [request.approved_plan.latest_observation_ref, latest].filter(isRef), { reobserveOnError: true });
}

function commandOwnershipGuard(request: ExecuteStateEntryRequest): ExecutionGuardResult {
  const issues: ValidationIssue[] = [];
  const context = request.runtime_context;
  const ownerState = context.command_owner_state ?? context.snapshot?.command_owner_state;
  const activePrimitiveRef = context.active_primitive_ref ?? context.snapshot?.active_primitive_ref;
  const firstPrimitiveRef = request.approved_plan.primitive_sequence[0]?.primitive_ref;
  const sourceStateOk = context.primary_state === "Validate" || context.primary_state === "Monologue" || context.primary_state === "Execute";
  if (!sourceStateOk) {
    issues.push(issue("error", "ExecuteSourceStateInvalid", "$.runtime_context.primary_state", `Execution cannot be authorized from ${context.primary_state}.`, "Use the File 08 transition table before entering Execute."));
  }
  if (context.safety_mode === "Blocked" || context.safety_mode === "SafeHoldRequired" || context.safety_mode === "AbortRequired") {
    issues.push(issue("error", "SafetyModeBlocksExecution", "$.runtime_context.safety_mode", "Current safety mode blocks actuator ownership.", "Resolve safety state or remain in SafeHold."));
  }
  if (ownerState !== undefined && ownerState !== "Execute" && ownerState !== "SafeHold") {
    issues.push(issue("error", "CommandOwnershipConflict", "$.runtime_context.command_owner_state", `Actuator ownership is held by ${ownerState}.`, "Wait for the active owner to release actuators or enter SafeHold."));
  }
  if (activePrimitiveRef !== undefined && firstPrimitiveRef !== undefined && !sameRef(activePrimitiveRef, firstPrimitiveRef)) {
    issues.push(issue("error", "ActivePrimitiveConflict", "$.runtime_context.active_primitive_ref", "Another primitive is active.", "Do not start a new primitive until ownership is released."));
  }
  return guard("CommandOwnershipGuard", issues, "Execute or SafeHold can own actuators and no conflicting primitive is active.", [context.runtime_ref, request.control_policy.command_owner_ref, activePrimitiveRef, firstPrimitiveRef].filter(isRef), { safeHoldOnError: true });
}

function validateCommandForPrimitive(
  command: ControlStackActuatorCommand,
  step: ApprovedPrimitiveStep,
  request: ExecuteStateEntryRequest,
  allowedModes: ReadonlySet<GatewayCommandMode>,
  issues: ValidationIssue[],
  path: string,
): void {
  validateRef(command.command_id, `${path}.command_id`, issues);
  if (command.authorization !== "validator_approved") {
    issues.push(issue("error", "CommandNotValidatorApproved", `${path}.authorization`, "Actuator command lacks validator approval.", "Only validator-approved commands may enter Execute."));
  }
  if (command.source_component !== "MotionPrimitiveExecutor" && command.source_component !== "PDControlService") {
    issues.push(issue("error", "CommandSourceRejected", `${path}.source_component`, "Execute accepts deterministic motion or PD controller command sources only.", "Route commands through the control stack."));
  }
  if (!sameRef(command.approved_plan_ref, request.approved_plan.approved_plan_ref)) {
    issues.push(issue("error", "CommandPlanRefMismatch", `${path}.approved_plan_ref`, "Command does not reference the approved plan.", "Rebuild command from the approved primitive sequence."));
  }
  if (!sameRef(command.validation_decision_ref, request.approved_plan.validation_decision_ref)) {
    issues.push(issue("error", "CommandValidationRefMismatch", `${path}.validation_decision_ref`, "Command validation decision ref does not match the approved plan.", "Use the validator decision that approved this primitive sequence."));
  }
  if (!sameRef(command.safety_envelope_ref, request.safety_envelope.safety_envelope_ref)) {
    issues.push(issue("error", "CommandSafetyEnvelopeMismatch", `${path}.safety_envelope_ref`, "Command safety envelope ref does not match the active envelope.", "Regenerate commands against the active envelope."));
  }
  if (!sameRef(command.primitive_ref, step.primitive_ref)) {
    issues.push(issue("error", "CommandPrimitiveRefMismatch", `${path}.primitive_ref`, "Command primitive ref does not match the step.", "Attach commands to their validated primitive step."));
  }
  if (!allowedModes.has(command.command_mode)) {
    issues.push(issue("error", "CommandModeNotAllowed", `${path}.command_mode`, `Command mode ${command.command_mode} is not allowed by control policy.`, "Use a control-policy admitted command mode."));
  }
  if (!step.required_actuator_refs.includes(command.actuator_id)) {
    issues.push(issue("error", "CommandActuatorNotDeclaredForPrimitive", `${path}.actuator_id`, "Command actuator is not declared for this primitive.", "Update primitive actuator requirements or regenerate commands."));
  }
  if (command.issued_at_s > request.runtime_context.current_time_s) {
    issues.push(issue("error", "CommandIssuedInFuture", `${path}.issued_at_s`, "Command issue time is in the future relative to runtime.", "Use the current runtime clock."));
  }
  const ageMs = Math.max(0, request.runtime_context.current_time_s - command.issued_at_s) * 1000;
  if (ageMs > request.control_policy.command_stale_after_ms) {
    issues.push(issue("error", "CommandStaleBeforeExecution", `${path}.issued_at_s`, "Command is stale before execution start.", "Regenerate command batch immediately before dispatch."));
  }
  if (command.scheduled_tick < request.runtime_context.current_tick) {
    issues.push(issue("error", "CommandScheduledInPast", `${path}.scheduled_tick`, "Command scheduled tick is already in the past.", "Reschedule the primitive sequence."));
  }
}

function validateRequestShape(request: ExecuteStateEntryRequest): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateRef(request.approved_plan.approved_plan_ref, "$.approved_plan.approved_plan_ref", issues);
  validateRef(request.approved_plan.validation_decision_ref, "$.approved_plan.validation_decision_ref", issues);
  validateRef(request.approved_plan.validator_handoff_ref, "$.approved_plan.validator_handoff_ref", issues);
  validateRef(request.safety_envelope.safety_envelope_ref, "$.safety_envelope.safety_envelope_ref", issues);
  validateRef(request.control_policy.control_policy_ref, "$.control_policy.control_policy_ref", issues);
  validateRef(request.precondition_check.check_ref, "$.precondition_check.check_ref", issues);
  validateRef(request.controller_readiness.readiness_ref, "$.controller_readiness.readiness_ref", issues);
  validateRef(request.monologue_gate.policy_ref, "$.monologue_gate.policy_ref", issues);
  validateRef(request.runtime_context.runtime_ref, "$.runtime_context.runtime_ref", issues);
  for (const [index, note] of request.approved_plan.safety_notes.entries()) {
    if (FORBIDDEN_EXECUTION_TEXT_PATTERN.test(note)) {
      issues.push(issue("error", "UnsafeExecutionNote", `$.approved_plan.safety_notes[${index}]`, "Safety note contains execution-boundary forbidden wording.", "Use validator-safe summaries only."));
    }
  }
  if (request.control_policy.max_sequence_duration_ms <= 0 || !Number.isFinite(request.control_policy.max_sequence_duration_ms)) {
    issues.push(issue("error", "ControlPolicyDurationInvalid", "$.control_policy.max_sequence_duration_ms", "Control policy must bound sequence duration.", "Attach a finite execution duration limit."));
  }
  if (request.control_policy.schedule_start_tick < request.runtime_context.current_tick) {
    issues.push(issue("error", "ControlPolicyStartTickInvalid", "$.control_policy.schedule_start_tick", "Schedule start tick cannot be earlier than runtime tick.", "Reschedule from current tick or later."));
  }
  return freezeArray(issues);
}

function chooseDecision(guards: readonly ExecutionGuardResult[], issues: readonly ValidationIssue[]): ExecutionGateDecision {
  if (guards.some((guard) => guard.human_review_required)) {
    return "human_review_required";
  }
  if (guards.some((guard) => guard.safe_hold_required)) {
    return "safe_hold_required";
  }
  if (guards.some((guard) => guard.reobserve_required)) {
    return "reobserve_required";
  }
  if (guards.some((guard) => guard.blocking) || issues.some((item) => item.severity === "error")) {
    return "blocked";
  }
  return "work_order_ready";
}

function buildWorkOrder(request: ExecuteStateEntryRequest, guards: readonly ExecutionGuardResult[]): PrimitiveExecutionWorkOrder {
  const commandBatch = request.approved_plan.primitive_sequence.flatMap((step) => step.actuator_commands);
  const monitorChannels = unique([
    ...request.control_policy.monitor_channels,
    ...request.controller_readiness.required_monitor_channels,
    ...request.controller_readiness.available_monitor_channels.filter((channel) => channel === "timeout" || channel === "operator"),
  ]);
  const sequenceDeadlineMs = request.runtime_context.current_time_ms
    + Math.min(
      request.control_policy.max_sequence_duration_ms,
      request.approved_plan.primitive_sequence.reduce((sum, step) => sum + (step.deadline_ms ?? step.expected_duration_ms + DEFAULT_SEQUENCE_DEADLINE_MARGIN_MS), 0),
    );
  const auditEvent = makeAuditEvent(request, commandBatch);
  const base = {
    schema_version: EXECUTION_GATEKEEPER_SCHEMA_VERSION,
    work_order_ref: makeRef("primitive_execution_work_order", request.approved_plan.approved_plan_ref, request.control_policy.schedule_start_tick),
    approved_plan_ref: request.approved_plan.approved_plan_ref,
    validation_decision_ref: request.approved_plan.validation_decision_ref,
    safety_envelope_ref: request.safety_envelope.safety_envelope_ref,
    control_policy_ref: request.control_policy.control_policy_ref,
    command_owner_ref: request.control_policy.command_owner_ref,
    embodiment_ref: request.approved_plan.embodiment_ref,
    primitive_sequence: freezeArray(request.approved_plan.primitive_sequence),
    actuator_command_batch: freezeArray(commandBatch),
    required_monitor_channels: freezeArray(monitorChannels),
    schedule_start_tick: request.control_policy.schedule_start_tick,
    schedule_start_time_s: request.control_policy.schedule_start_time_s,
    sequence_deadline_ms: sequenceDeadlineMs,
    safe_hold_primitive_ref: request.control_policy.safe_hold_primitive_ref,
    audit_event: auditEvent,
    cognitive_visibility: "runtime_control_and_validator_only" as const,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash({ ...base, guard_hashes: guards.map((guard) => guard.determinism_hash) }),
  });
}

function makeAuditEvent(request: ExecuteStateEntryRequest, commands: readonly ControlStackActuatorCommand[]): OrchestrationEventEnvelope {
  const base = {
    event_ref: makeRef("event", "primitive_started", request.approved_plan.approved_plan_ref, request.control_policy.schedule_start_tick),
    event_type: "PrimitiveStarted" as const,
    event_family: "execution" as const,
    severity: "info" as const,
    session_ref: request.runtime_context.snapshot?.session_ref ?? makeRef("session", request.runtime_context.runtime_ref),
    task_ref: request.approved_plan.task_ref,
    source_state_ref: "Execute" as const,
    context_ref: request.runtime_context.snapshot?.current_context_ref ?? request.runtime_context.runtime_ref,
    payload_refs: freezeArray([
      request.approved_plan.approved_plan_ref,
      request.approved_plan.validation_decision_ref,
      request.safety_envelope.safety_envelope_ref,
      request.precondition_check.check_ref,
      request.controller_readiness.readiness_ref,
      ...request.approved_plan.primitive_sequence.map((step) => step.primitive_ref),
      ...commands.map((command) => command.command_id),
    ]),
    provenance_classes: freezeArray(["validator", "safety", "controller", "telemetry"] as const),
    occurred_at_ms: request.runtime_context.current_time_ms,
    human_summary: "Primitive execution work order admitted by ExecutionGatekeeper pre-execution guards.",
    target_state_hint: "Execute" as const,
    plan_ref: request.approved_plan.approved_plan_ref,
    primitive_ref: request.approved_plan.primitive_sequence[0]?.primitive_ref,
    validation_approved: true,
    monologue_required: request.approved_plan.requires_monologue,
  };
  return Object.freeze(base);
}

function makeReport(
  decision: ExecutionGateDecision,
  workOrder: PrimitiveExecutionWorkOrder | undefined,
  guards: readonly ExecutionGuardResult[],
  issues: readonly ValidationIssue[],
): ExecutionGatekeeperReport {
  const errorCount = issues.filter((item) => item.severity === "error").length;
  const warningCount = issues.filter((item) => item.severity === "warning").length;
  const base = {
    schema_version: EXECUTION_GATEKEEPER_SCHEMA_VERSION,
    gatekeeper_version: EXECUTION_GATEKEEPER_VERSION,
    decision,
    work_order: workOrder,
    guard_results: freezeArray(guards),
    issue_count: issues.length,
    error_count: errorCount,
    warning_count: warningCount,
    issues: freezeArray(issues),
    traceability_ref: CONTRACT_TRACEABILITY_REF,
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function guard(
  name: ExecutionGuardName,
  issues: readonly ValidationIssue[],
  clearReason: string,
  evidenceRefs: readonly Ref[],
  options: { readonly safeHoldOnError?: boolean; readonly reobserveOnError?: boolean; readonly humanReviewOnError?: boolean } = {},
): ExecutionGuardResult {
  const hasError = issues.some((item) => item.severity === "error");
  const hasWarning = issues.some((item) => item.severity === "warning");
  const base = {
    guard_name: name,
    status: hasError ? "blocked" as const : hasWarning ? "warning" as const : "clear" as const,
    blocking: hasError,
    safe_hold_required: hasError && options.safeHoldOnError === true,
    reobserve_required: hasError && options.reobserveOnError === true,
    human_review_required: hasError && options.humanReviewOnError === true,
    reason: hasError ? issues.filter((item) => item.severity === "error").map((item) => item.message).join(" ") : clearReason,
    evidence_refs: freezeArray(unique(evidenceRefs.filter(isRef))),
    issues: freezeArray(issues),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function validateRef(ref: Ref | undefined, path: string, issues: ValidationIssue[]): void {
  if (ref === undefined || ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(issue("error", "ReferenceInvalid", path, "Reference must be present, non-empty, and whitespace-free.", "Use a stable opaque reference."));
    return;
  }
  if (FORBIDDEN_EXECUTION_TEXT_PATTERN.test(ref)) {
    issues.push(issue("error", "ReferenceForbiddenForExecutionGate", path, "Reference contains forbidden execution-boundary wording.", "Use an opaque validator or runtime reference."));
  }
}

function sameRef(left: Ref | undefined, right: Ref | undefined): boolean {
  return left !== undefined && right !== undefined && left === right;
}

function isRef(value: Ref | undefined): value is Ref {
  return value !== undefined && value.trim().length > 0;
}

function unique<T extends string>(items: readonly T[]): readonly T[] {
  return freezeArray([...new Set(items)]);
}

function makeRef(...parts: readonly (string | number | undefined)[]): Ref {
  const normalized = parts
    .filter((part): part is string | number => part !== undefined)
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "ref:empty";
}

function issue(severity: ValidationSeverity, code: string, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

export const EXECUTION_GATEKEEPER_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: EXECUTION_GATEKEEPER_SCHEMA_VERSION,
  blueprint: "architecture_docs/08_AGENT_STATE_MACHINE_AND_ORCHESTRATION.md",
  sections: freezeArray(["8.3", "8.9.8", "8.12", "8.14.2", "8.15", "8.16", "8.17"]),
  traceability_ref: CONTRACT_TRACEABILITY_REF,
  pre_execution_guards: freezeArray([
    "PlanApprovalGuard",
    "SafetyEnvelopeGuard",
    "PrimitiveKnownGuard",
    "PreconditionRecheckGuard",
    "ControllerReadinessGuard",
    "MonologuePolicyGuard",
    "ObservationCurrencyGuard",
    "CommandOwnershipGuard",
  ] as readonly ExecutionGuardName[]),
});
