/**
 * Manipulation control planner for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md`
 * sections 12.3, 12.5, 12.7 through 12.11, 12.14, 12.15, 12.16, and
 * 12.17.
 *
 * This planner converts a validated File 12 primitive into deterministic
 * File 11 control work orders. It never accepts raw model authority; callers
 * must provide a successful primitive precondition report, current target
 * frames, bounded phase goals, and a safety envelope. The generated work order
 * carries target frame refs, IK seeds, trajectory phase specs, contact modes,
 * abort conditions, settle windows, force ramps, verification hooks, and
 * prompt-safe summaries for downstream orchestration.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type {
  Quaternion,
  Ref,
  ValidationIssue,
  ValidationSeverity,
  Vector3,
} from "../simulation/world_manifest";
import type {
  ContactMode,
  PrimitivePhase,
  TrajectorySafetyEnvelope,
  TrajectorySettleCondition,
} from "../control/trajectory_shaping_service";
import {
  createManipulationPrimitiveCatalog,
  ManipulationPrimitiveCatalog,
} from "./manipulation_primitive_catalog";
import type {
  ManipulationContactExpectation,
  ManipulationPrimitiveDescriptor,
  ManipulationVerificationHook,
} from "./manipulation_primitive_catalog";
import type { PrimitivePreconditionReport } from "./primitive_precondition_validator";

export const MANIPULATION_CONTROL_PLANNER_SCHEMA_VERSION = "mebsuta.manipulation_control_planner.v1" as const;

const HIDDEN_CONTROL_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|qa_success|qa_label|qa_only|simulator truth|mesh_name|asset_id|benchmark_truth|oracle_pose|direct_actuator|raw_gemini_actuation)/i;
const EPSILON = 1e-9;
const IDENTITY_QUATERNION: Quaternion = Object.freeze([0, 0, 0, 1]) as Quaternion;
const ZERO_VECTOR: Vector3 = Object.freeze([0, 0, 0]) as Vector3;

export type ManipulationControlPlannerDecision = "planned" | "planned_with_constraints" | "reobserve" | "safe_hold" | "rejected";
export type ManipulationControlPlannerAction = "handoff_to_trajectory" | "refresh_frames" | "collect_evidence" | "reduce_contact_speed" | "safe_hold" | "repair_plan";
export type ManipulationControlIssueCode =
  | "PreconditionsNotExecutable"
  | "TargetFrameMissing"
  | "PhaseGoalInvalid"
  | "SafetyEnvelopeInvalid"
  | "ControlProfileInvalid"
  | "HiddenControlLeak"
  | "ForceRampInvalid"
  | "SettleWindowInvalid";

export interface ManipulationPhaseGoal {
  readonly phase: PrimitivePhase;
  readonly target_frame_ref: Ref;
  readonly target_position_m: Vector3;
  readonly target_orientation_xyzw?: Quaternion;
  readonly approach_vector?: Vector3;
  readonly clearance_m?: number;
  readonly duration_hint_s?: number;
  readonly evidence_refs: readonly Ref[];
}

export interface ManipulationControlPlanningRequest {
  readonly request_ref?: Ref;
  readonly primitive_precondition_report: PrimitivePreconditionReport;
  readonly phase_goals: readonly ManipulationPhaseGoal[];
  readonly current_end_effector_frame_ref: Ref;
  readonly current_position_m: Vector3;
  readonly current_orientation_xyzw?: Quaternion;
  readonly safety_envelope: TrajectorySafetyEnvelope;
  readonly contact_expectation?: ManipulationContactExpectation;
  readonly max_force_n?: number;
  readonly expected_payload_kg?: number;
  readonly current_time_s?: number;
}

export interface ManipulationIkSeed {
  readonly seed_ref: Ref;
  readonly phase: PrimitivePhase;
  readonly target_frame_ref: Ref;
  readonly cartesian_position_m: Vector3;
  readonly cartesian_orientation_xyzw: Quaternion;
  readonly approach_axis: Vector3;
  readonly radial_distance_m: number;
  readonly yaw_hint_rad: number;
  readonly pitch_hint_rad: number;
  readonly determinism_hash: string;
}

export interface ManipulationForceRampStage {
  readonly stage_ref: Ref;
  readonly phase: PrimitivePhase;
  readonly start_force_n: number;
  readonly target_force_n: number;
  readonly duration_s: number;
  readonly stop_if_force_above_n: number;
}

export interface ManipulationTrajectoryPhaseSpec {
  readonly phase_ref: Ref;
  readonly phase: PrimitivePhase;
  readonly contact_mode: ContactMode;
  readonly target_frame_ref: Ref;
  readonly target_position_m: Vector3;
  readonly target_orientation_xyzw: Quaternion;
  readonly speed_scale: number;
  readonly max_contact_velocity_m_s?: number;
  readonly duration_s: number;
  readonly settle_condition?: TrajectorySettleCondition;
  readonly force_ramp: readonly ManipulationForceRampStage[];
  readonly abort_conditions: readonly string[];
  readonly evidence_refs: readonly Ref[];
  readonly determinism_hash: string;
}

export interface ManipulationControlWorkOrder {
  readonly schema_version: typeof MANIPULATION_CONTROL_PLANNER_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md";
  readonly work_order_ref: Ref;
  readonly source_precondition_report_ref: Ref;
  readonly primitive_ref: Ref;
  readonly primitive_name?: ManipulationPrimitiveDescriptor["primitive_name"];
  readonly phases: readonly ManipulationTrajectoryPhaseSpec[];
  readonly ik_seeds: readonly ManipulationIkSeed[];
  readonly verification_hook: ManipulationVerificationHook;
  readonly final_target_frame_ref?: Ref;
  readonly safety_envelope_ref: Ref;
  readonly prompt_safe_summary: string;
  readonly determinism_hash: string;
}

export interface ManipulationControlPlanningReport {
  readonly schema_version: typeof MANIPULATION_CONTROL_PLANNER_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md";
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly decision: ManipulationControlPlannerDecision;
  readonly recommended_action: ManipulationControlPlannerAction;
  readonly work_order?: ManipulationControlWorkOrder;
  readonly rejected_phase_refs: readonly Ref[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "manipulation_control_planning_report";
  readonly determinism_hash: string;
}

export interface ManipulationControlPlannerConfig {
  readonly primitive_catalog?: ManipulationPrimitiveCatalog;
  readonly default_phase_duration_s?: number;
  readonly default_settle_window_s?: number;
  readonly min_contact_duration_s?: number;
}

interface NormalizedPlannerPolicy {
  readonly default_phase_duration_s: number;
  readonly default_settle_window_s: number;
  readonly min_contact_duration_s: number;
}

/**
 * Converts an admitted primitive into a deterministic control work order.
 */
export class ManipulationControlPlanner {
  private readonly primitiveCatalog: ManipulationPrimitiveCatalog;
  private readonly policy: NormalizedPlannerPolicy;

  public constructor(config: ManipulationControlPlannerConfig = {}) {
    this.primitiveCatalog = config.primitive_catalog ?? createManipulationPrimitiveCatalog();
    this.policy = Object.freeze({
      default_phase_duration_s: positiveOrDefault(config.default_phase_duration_s, 0.8),
      default_settle_window_s: positiveOrDefault(config.default_settle_window_s, 0.35),
      min_contact_duration_s: positiveOrDefault(config.min_contact_duration_s, 0.25),
    });
  }

  /**
   * Builds phase specs, IK seeds, force ramps, and abort policies for the
   * admitted manipulation primitive.
   */
  public planManipulationControl(request: ManipulationControlPlanningRequest): ManipulationControlPlanningReport {
    const issues: ValidationIssue[] = [];
    const requestRef = sanitizeRef(request.request_ref ?? `manipulation_control_plan_${computeDeterminismHash({
      primitive: request.primitive_precondition_report.primitive_ref,
      report: request.primitive_precondition_report.report_ref,
      phaseCount: request.phase_goals.length,
    })}`);
    validateRequest(request, issues);
    const descriptor = resolveDescriptor(this.primitiveCatalog, request.primitive_precondition_report.primitive_ref, issues);
    const profile = descriptor?.control_phase_profile;
    const orderedGoals = orderGoals(request.phase_goals, profile?.phases ?? []);
    const phaseSpecs = freezeArray(orderedGoals.map((goal, index) => buildPhaseSpec(request, goal, descriptor, this.policy, index, issues)));
    const ikSeeds = freezeArray(orderedGoals.map((goal, index) => buildIkSeed(request, goal, index, issues)));
    const rejectedPhaseRefs = freezeArray(phaseSpecs
      .filter((phase) => phase.duration_s <= 0 || !Number.isFinite(phase.duration_s))
      .map((phase) => phase.phase_ref));
    const allIssues = freezeArray(issues);
    const decision = decide(allIssues, request, phaseSpecs, rejectedPhaseRefs);
    const workOrder = decision === "rejected" || decision === "safe_hold"
      ? undefined
      : buildWorkOrder(request, descriptor, phaseSpecs, ikSeeds);
    const base = {
      schema_version: MANIPULATION_CONTROL_PLANNER_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md" as const,
      report_ref: `manipulation_control_planning_report_${computeDeterminismHash({
        requestRef,
        decision,
        phases: phaseSpecs.map((phase) => phase.phase_ref),
      })}`,
      request_ref: requestRef,
      decision,
      recommended_action: recommend(decision, allIssues),
      work_order: workOrder,
      rejected_phase_refs: rejectedPhaseRefs,
      issues: allIssues,
      ok: workOrder !== undefined && (decision === "planned" || decision === "planned_with_constraints"),
      cognitive_visibility: "manipulation_control_planning_report" as const,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }
}

export function createManipulationControlPlanner(config: ManipulationControlPlannerConfig = {}): ManipulationControlPlanner {
  return new ManipulationControlPlanner(config);
}

function buildWorkOrder(
  request: ManipulationControlPlanningRequest,
  descriptor: ManipulationPrimitiveDescriptor | undefined,
  phases: readonly ManipulationTrajectoryPhaseSpec[],
  ikSeeds: readonly ManipulationIkSeed[],
): ManipulationControlWorkOrder {
  const finalTarget = phases.length === 0 ? undefined : phases[phases.length - 1].target_frame_ref;
  const primitiveName = descriptor?.primitive_name ?? request.primitive_precondition_report.primitive_ref;
  const base = {
    schema_version: MANIPULATION_CONTROL_PLANNER_SCHEMA_VERSION,
    blueprint_ref: "architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md" as const,
    work_order_ref: `manipulation_control_work_order_${computeDeterminismHash({
      preconditions: request.primitive_precondition_report.report_ref,
      primitive: request.primitive_precondition_report.primitive_ref,
      phases: phases.map((phase) => phase.phase_ref),
    })}`,
    source_precondition_report_ref: request.primitive_precondition_report.report_ref,
    primitive_ref: request.primitive_precondition_report.primitive_ref,
    primitive_name: descriptor?.primitive_name,
    phases,
    ik_seeds: ikSeeds,
    verification_hook: descriptor?.verification_hook ?? "none" as ManipulationVerificationHook,
    final_target_frame_ref: finalTarget,
    safety_envelope_ref: request.safety_envelope.safety_envelope_ref,
    prompt_safe_summary: sanitizeText(`${primitiveName} control work order contains ${phases.length} bounded phases with verification hook ${descriptor?.verification_hook ?? "none"}.`),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function buildPhaseSpec(
  request: ManipulationControlPlanningRequest,
  goal: ManipulationPhaseGoal,
  descriptor: ManipulationPrimitiveDescriptor | undefined,
  policy: NormalizedPlannerPolicy,
  index: number,
  issues: ValidationIssue[],
): ManipulationTrajectoryPhaseSpec {
  validateGoal(goal, index, issues);
  const contactMode = descriptor?.control_phase_profile.contact_mode ?? contactModeForPhase(goal.phase);
  const settleWindow = descriptor?.control_phase_profile.settle_window_s ?? policy.default_settle_window_s;
  const duration = computeDuration(request, goal, descriptor, contactMode, policy);
  const targetOrientation = canonicalQuaternion(goal.target_orientation_xyzw ?? request.current_orientation_xyzw ?? IDENTITY_QUATERNION);
  const forceRamp = buildForceRamp(request, goal.phase, descriptor, duration, issues);
  const settle = buildSettleCondition(goal, settleWindow, contactMode);
  const abortConditions = freezeArray(uniqueSorted([
    ...descriptor?.safety_stop_conditions ?? [],
    "target evidence stale",
    "unexpected contact class",
    "tracking residual diverges",
    "safety envelope revoked",
  ].map(sanitizeText)));
  const base = {
    phase_ref: `manipulation_phase_${index}_${goal.phase}_${sanitizeRef(goal.target_frame_ref)}`,
    phase: goal.phase,
    contact_mode: contactMode,
    target_frame_ref: sanitizeRef(goal.target_frame_ref),
    target_position_m: vector(goal.target_position_m, `$.phase_goals.${index}.target_position_m`, issues),
    target_orientation_xyzw: targetOrientation,
    speed_scale: round6(Math.min(descriptor?.control_phase_profile.speed_scale ?? 0.4, speedScaleFor(goal.phase, contactMode))),
    max_contact_velocity_m_s: descriptor?.control_phase_profile.max_contact_velocity_m_s ?? maxContactVelocity(contactMode),
    duration_s: duration,
    settle_condition: settle,
    force_ramp: forceRamp,
    abort_conditions: abortConditions,
    evidence_refs: freezeArray(uniqueSorted(goal.evidence_refs.map(sanitizeRef))),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function buildIkSeed(
  request: ManipulationControlPlanningRequest,
  goal: ManipulationPhaseGoal,
  index: number,
  issues: ValidationIssue[],
): ManipulationIkSeed {
  const target = vector(goal.target_position_m, `$.phase_goals.${index}.target_position_m`, issues);
  const current = vector(request.current_position_m, "$.current_position_m", issues);
  const delta = subtract(target, current);
  const radial = vectorNorm(delta);
  const axis = unit(goal.approach_vector ?? delta, fallbackAxis(goal.phase));
  const yaw = Math.atan2(axis[1], axis[0]);
  const pitch = Math.atan2(axis[2], Math.max(EPSILON, Math.hypot(axis[0], axis[1])));
  const base = {
    seed_ref: `ik_seed_${index}_${goal.phase}_${sanitizeRef(goal.target_frame_ref)}`,
    phase: goal.phase,
    target_frame_ref: sanitizeRef(goal.target_frame_ref),
    cartesian_position_m: target,
    cartesian_orientation_xyzw: canonicalQuaternion(goal.target_orientation_xyzw ?? request.current_orientation_xyzw ?? IDENTITY_QUATERNION),
    approach_axis: axis,
    radial_distance_m: round6(radial),
    yaw_hint_rad: round6(yaw),
    pitch_hint_rad: round6(pitch),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function buildForceRamp(
  request: ManipulationControlPlanningRequest,
  phase: PrimitivePhase,
  descriptor: ManipulationPrimitiveDescriptor | undefined,
  duration: number,
  issues: ValidationIssue[],
): readonly ManipulationForceRampStage[] {
  const forceTarget = clamp(request.max_force_n ?? defaultForceForPhase(phase, request.expected_payload_kg), 0, 250);
  if (!Number.isFinite(forceTarget) || forceTarget < 0) {
    issues.push(makeIssue("error", "ForceRampInvalid", "$.max_force_n", "Force target must be finite and nonnegative.", "Provide a bounded contact force limit."));
  }
  if (!contactPhase(phase, descriptor?.control_phase_profile.contact_mode ?? contactModeForPhase(phase))) {
    return freezeArray([]);
  }
  const rampDuration = round6(Math.max(0.08, duration * 0.35));
  const holdDuration = round6(Math.max(0.08, duration - rampDuration));
  return freezeArray([
    forceStage("initial_contact", phase, 0, forceTarget * 0.35, rampDuration, forceTarget * 0.65),
    forceStage("task_force", phase, forceTarget * 0.35, forceTarget, holdDuration, forceTarget * 1.12),
  ]);
}

function forceStage(ref: Ref, phase: PrimitivePhase, start: number, target: number, duration: number, stopAbove: number): ManipulationForceRampStage {
  return Object.freeze({
    stage_ref: `${ref}_${phase}`,
    phase,
    start_force_n: round6(start),
    target_force_n: round6(target),
    duration_s: round6(duration),
    stop_if_force_above_n: round6(stopAbove),
  });
}

function buildSettleCondition(goal: ManipulationPhaseGoal, settleWindow: number, contactMode: ContactMode): TrajectorySettleCondition | undefined {
  if (!requiresSettle(goal.phase, contactMode)) return undefined;
  return Object.freeze({
    settle_condition_ref: `settle_${goal.phase}_${sanitizeRef(goal.target_frame_ref)}`,
    required_window_s: round6(Math.max(0.12, settleWindow)),
    max_position_error_rad: contactMode === "placement" ? 0.015 : 0.03,
    max_velocity_rad_s: contactMode === "safe_hold" ? 0.015 : 0.04,
    contact_quiet_required: contactMode !== "free_space",
  });
}

function computeDuration(
  request: ManipulationControlPlanningRequest,
  goal: ManipulationPhaseGoal,
  descriptor: ManipulationPrimitiveDescriptor | undefined,
  contactMode: ContactMode,
  policy: NormalizedPlannerPolicy,
): number {
  const distance = vectorNorm(subtract(goal.target_position_m, request.current_position_m));
  const baseVelocity = contactPhase(goal.phase, contactMode) ? 0.08 : 0.22;
  const profileScale = Math.max(0.05, descriptor?.control_phase_profile.speed_scale ?? 0.4);
  const travelDuration = distance / Math.max(EPSILON, baseVelocity * profileScale);
  const hinted = goal.duration_hint_s ?? 0;
  const minimum = contactPhase(goal.phase, contactMode) ? policy.min_contact_duration_s : 0.12;
  return round6(Math.max(minimum, policy.default_phase_duration_s, hinted, travelDuration));
}

function validateRequest(request: ManipulationControlPlanningRequest, issues: ValidationIssue[]): void {
  validateRef(request.current_end_effector_frame_ref, "$.current_end_effector_frame_ref", "TargetFrameMissing", issues);
  validateRef(request.safety_envelope.safety_envelope_ref, "$.safety_envelope.safety_envelope_ref", "SafetyEnvelopeInvalid", issues);
  vector(request.current_position_m, "$.current_position_m", issues);
  canonicalQuaternion(request.current_orientation_xyzw ?? IDENTITY_QUATERNION);
  if (!request.primitive_precondition_report.ok || request.primitive_precondition_report.recommended_action !== "handoff_to_control") {
    issues.push(makeIssue("error", "PreconditionsNotExecutable", "$.primitive_precondition_report", "Primitive preconditions do not authorize control handoff.", "Resolve precondition gates before planning control."));
  }
  if (request.phase_goals.length === 0) {
    issues.push(makeIssue("error", "PhaseGoalInvalid", "$.phase_goals", "At least one phase goal is required.", "Provide target frames for the primitive control phases."));
  }
  if (request.safety_envelope.max_duration_s <= 0 || request.safety_envelope.timeout_s <= 0) {
    issues.push(makeIssue("error", "SafetyEnvelopeInvalid", "$.safety_envelope", "Safety envelope duration and timeout must be positive.", "Provide bounded execution limits."));
  }
}

function validateGoal(goal: ManipulationPhaseGoal, index: number, issues: ValidationIssue[]): void {
  validateRef(goal.target_frame_ref, `$.phase_goals.${index}.target_frame_ref`, "TargetFrameMissing", issues);
  vector(goal.target_position_m, `$.phase_goals.${index}.target_position_m`, issues);
  if (goal.approach_vector !== undefined) vector(goal.approach_vector, `$.phase_goals.${index}.approach_vector`, issues);
  if (goal.clearance_m !== undefined && (!Number.isFinite(goal.clearance_m) || goal.clearance_m < 0)) {
    issues.push(makeIssue("error", "PhaseGoalInvalid", `$.phase_goals.${index}.clearance_m`, "Clearance must be finite and nonnegative.", "Use a calibrated clearance distance."));
  }
  for (const ref of goal.evidence_refs) validateRef(ref, `$.phase_goals.${index}.evidence_refs`, "HiddenControlLeak", issues);
}

function resolveDescriptor(
  catalog: ManipulationPrimitiveCatalog,
  primitiveRef: Ref,
  issues: ValidationIssue[],
): ManipulationPrimitiveDescriptor | undefined {
  try {
    return catalog.requirePrimitive(primitiveRef);
  } catch (error: unknown) {
    issues.push(makeIssue("error", "ControlProfileInvalid", "$.primitive_precondition_report.primitive_ref", error instanceof Error ? error.message : "Primitive descriptor could not be resolved.", "Use a registered File 12 primitive ref."));
    return undefined;
  }
}

function decide(
  issues: readonly ValidationIssue[],
  request: ManipulationControlPlanningRequest,
  phases: readonly ManipulationTrajectoryPhaseSpec[],
  rejected: readonly Ref[],
): ManipulationControlPlannerDecision {
  if (issues.some((issue) => issue.severity === "error" && (issue.code === "PreconditionsNotExecutable" || issue.code === "SafetyEnvelopeInvalid"))) return "safe_hold";
  if (issues.some((issue) => issue.severity === "error") || rejected.length > 0 || phases.length === 0) return "rejected";
  if (request.primitive_precondition_report.decision === "reobserve") return "reobserve";
  return issues.length > 0 || request.primitive_precondition_report.issues.length > 0 ? "planned_with_constraints" : "planned";
}

function recommend(decision: ManipulationControlPlannerDecision, issues: readonly ValidationIssue[]): ManipulationControlPlannerAction {
  if (decision === "planned" || decision === "planned_with_constraints") return issues.some((issue) => issue.code === "ForceRampInvalid") ? "reduce_contact_speed" : "handoff_to_trajectory";
  if (decision === "reobserve") return "collect_evidence";
  if (decision === "safe_hold") return "safe_hold";
  if (issues.some((issue) => issue.code === "TargetFrameMissing")) return "refresh_frames";
  return "repair_plan";
}

function orderGoals(goals: readonly ManipulationPhaseGoal[], phases: readonly PrimitivePhase[]): readonly ManipulationPhaseGoal[] {
  const rank = new Map(phases.map((phase, index) => [phase, index] as const));
  return freezeArray([...goals].sort((a, b) => (rank.get(a.phase) ?? 99) - (rank.get(b.phase) ?? 99) || a.target_frame_ref.localeCompare(b.target_frame_ref)));
}

function contactModeForPhase(phase: PrimitivePhase): ContactMode {
  const table: Readonly<Record<PrimitivePhase, ContactMode>> = {
    approach: "free_space",
    pregrasp: "precontact",
    grasp: "grasp",
    lift: "carry",
    carry: "carry",
    place: "placement",
    release: "placement",
    retreat: "free_space",
    tool_contact: "tool_contact",
    safe_hold: "safe_hold",
  };
  return table[phase];
}

function speedScaleFor(phase: PrimitivePhase, mode: ContactMode): number {
  if (mode === "safe_hold") return 0.05;
  if (mode === "tool_contact") return 0.12;
  if (phase === "release" || phase === "place") return 0.18;
  if (contactPhase(phase, mode)) return 0.25;
  return 0.55;
}

function maxContactVelocity(mode: ContactMode): number | undefined {
  if (mode === "free_space") return undefined;
  if (mode === "tool_contact" || mode === "placement") return 0.025;
  if (mode === "safe_hold") return 0.01;
  return 0.05;
}

function requiresSettle(phase: PrimitivePhase, mode: ContactMode): boolean {
  return phase === "grasp" || phase === "lift" || phase === "place" || phase === "release" || phase === "tool_contact" || mode === "safe_hold";
}

function contactPhase(phase: PrimitivePhase, mode: ContactMode): boolean {
  return phase === "grasp" || phase === "lift" || phase === "carry" || phase === "place" || phase === "release" || phase === "tool_contact" || mode !== "free_space";
}

function defaultForceForPhase(phase: PrimitivePhase, payloadKg: number | undefined): number {
  const load = Math.max(0, payloadKg ?? 0.2) * 9.80665;
  if (phase === "grasp") return Math.max(8, load * 2.2);
  if (phase === "lift" || phase === "carry") return Math.max(10, load * 2.6);
  if (phase === "tool_contact") return 12;
  if (phase === "place" || phase === "release") return Math.max(4, load * 0.8);
  return 3;
}

function fallbackAxis(phase: PrimitivePhase): Vector3 {
  if (phase === "place" || phase === "release") return Object.freeze([0, 0, -1]) as Vector3;
  if (phase === "lift") return Object.freeze([0, 0, 1]) as Vector3;
  return Object.freeze([1, 0, 0]) as Vector3;
}

function vector(value: Vector3, path: string, issues: ValidationIssue[]): Vector3 {
  if (!Array.isArray(value) || value.length !== 3 || value.some((component) => !Number.isFinite(component))) {
    issues.push(makeIssue("error", "PhaseGoalInvalid", path, "Vector values must contain three finite meter components.", "Provide [x, y, z] in calibrated units."));
    return ZERO_VECTOR;
  }
  return Object.freeze([round6(value[0]), round6(value[1]), round6(value[2])]) as Vector3;
}

function canonicalQuaternion(value: Quaternion): Quaternion {
  const norm = Math.hypot(value[0], value[1], value[2], value[3]);
  if (!Number.isFinite(norm) || norm < EPSILON) return IDENTITY_QUATERNION;
  const sign = value[3] < 0 ? -1 : 1;
  return Object.freeze([
    round6((value[0] / norm) * sign),
    round6((value[1] / norm) * sign),
    round6((value[2] / norm) * sign),
    round6((value[3] / norm) * sign),
  ]) as Quaternion;
}

function subtract(a: Vector3, b: Vector3): Vector3 {
  return Object.freeze([round6(a[0] - b[0]), round6(a[1] - b[1]), round6(a[2] - b[2])]) as Vector3;
}

function unit(value: Vector3, fallback: Vector3): Vector3 {
  const norm = vectorNorm(value);
  if (norm < EPSILON) return fallback;
  return Object.freeze([round6(value[0] / norm), round6(value[1] / norm), round6(value[2] / norm)]) as Vector3;
}

function vectorNorm(value: Vector3): number {
  return Math.hypot(value[0], value[1], value[2]);
}

function validateRef(ref: Ref, path: string, code: ManipulationControlIssueCode, issues: ValidationIssue[]): void {
  if (ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(makeIssue("error", code, path, "Reference must be a non-empty whitespace-free string.", "Use opaque manipulation refs."));
    return;
  }
  if (HIDDEN_CONTROL_PATTERN.test(ref)) {
    issues.push(makeIssue("error", "HiddenControlLeak", path, "Reference contains forbidden hidden execution detail.", "Use sensor-derived and validator-approved refs only."));
  }
}

function sanitizeText(text: string): string {
  return text.replace(HIDDEN_CONTROL_PATTERN, "hidden-detail").replace(/\s+/g, " ").trim();
}

function sanitizeRef(ref: Ref): Ref {
  return ref.replace(HIDDEN_CONTROL_PATTERN, "hidden-detail").trim();
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value <= 0 ? fallback : value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function uniqueSorted<T extends string>(items: readonly T[]): readonly T[] {
  return freezeArray([...new Set(items)].sort());
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

function makeIssue(
  severity: ValidationSeverity,
  code: ManipulationControlIssueCode,
  path: string,
  message: string,
  remediation: string,
): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}
