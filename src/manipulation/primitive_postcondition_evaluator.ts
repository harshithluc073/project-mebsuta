/**
 * Primitive postcondition evaluator for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md`
 * sections 12.3, 12.5, 12.7 through 12.11, 12.13, 12.14, 12.15,
 * 12.16, and 12.17.
 *
 * This evaluator checks what must be true after a manipulation primitive:
 * approach region reached, contact acquired, object held, lift settled, carry
 * stable, placement candidate reached, release settled, retreat clear, or tool
 * effect observed. It combines the primitive descriptor, control work order,
 * contact state, visual state, residual summaries, and retry policy into a
 * deterministic routing report for verification, correction, reobservation,
 * or safe hold.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type {
  Ref,
  ValidationIssue,
  ValidationSeverity,
} from "../simulation/world_manifest";
import type { SpatialResidualReport } from "../spatial/spatial_constraint_evaluator";
import {
  createManipulationPrimitiveCatalog,
  ManipulationPrimitiveCatalog,
} from "./manipulation_primitive_catalog";
import type {
  ManipulationPrimitiveDescriptor,
  ManipulationVerificationHook,
} from "./manipulation_primitive_catalog";
import type { ContactStateMonitorReport } from "./contact_state_monitor";
import type { ManipulationControlWorkOrder } from "./manipulation_control_planner";

export const PRIMITIVE_POSTCONDITION_EVALUATOR_SCHEMA_VERSION = "mebsuta.primitive_postcondition_evaluator.v1" as const;

const HIDDEN_POSTCONDITION_PATTERN = /(backend|engine|scene_graph|world_truth|ground_truth|collision_mesh|rigid_body_handle|physics_body|joint_handle|object_id|exact_com|world_pose|qa_success|qa_label|qa_only|simulator truth|mesh_name|asset_id|benchmark_truth|oracle_pose|direct_actuator|raw_gemini_actuation)/i;

export type PrimitivePostconditionDecision = "complete" | "verification_required" | "ambiguous" | "correct_required" | "safe_hold_required" | "rejected";
export type PrimitivePostconditionAction = "advance_or_verify" | "route_to_verification" | "collect_more_evidence" | "route_to_correct" | "safe_hold" | "repair_result_packet";
export type PrimitivePostconditionIssueCode =
  | "PrimitiveResultInvalid"
  | "ControlWorkOrderInvalid"
  | "ContactStateRejected"
  | "VisualEvidenceMissing"
  | "ResidualOutOfTolerance"
  | "VerificationEvidenceBlocked"
  | "RetryBudgetExceeded"
  | "HiddenPostconditionLeak";

export interface PrimitiveExecutionOutcome {
  readonly outcome_ref: Ref;
  readonly primitive_ref: Ref;
  readonly started_at_s: number;
  readonly ended_at_s: number;
  readonly execution_status: "completed" | "completed_with_warnings" | "interrupted" | "timed_out" | "aborted";
  readonly telemetry_refs: readonly Ref[];
  readonly observed_displacement_m?: number;
  readonly final_pose_residual_m?: number;
  readonly final_orientation_residual_rad?: number;
}

export interface PrimitivePostconditionVisualState {
  readonly evidence_ref: Ref;
  readonly subject_ref: Ref;
  readonly visible: boolean;
  readonly confidence: number;
  readonly occluded_by_effector: boolean;
  readonly relation_residual_m?: number;
}

export interface PrimitivePostconditionEvaluationRequest {
  readonly request_ref?: Ref;
  readonly primitive_result: PrimitiveExecutionOutcome;
  readonly control_work_order: ManipulationControlWorkOrder;
  readonly contact_state_report?: ContactStateMonitorReport;
  readonly visual_states: readonly PrimitivePostconditionVisualState[];
  readonly residual_reports?: readonly SpatialResidualReport[];
  readonly verification_view_available: boolean;
  readonly retry_budget_remaining: number;
  readonly current_time_s?: number;
}

export interface PrimitivePostconditionCheck {
  readonly check_ref: Ref;
  readonly name: "execution_status" | "control_alignment" | "contact_state" | "visual_state" | "spatial_residual" | "verification_readiness" | "retry_budget";
  readonly status: "satisfied" | "warning" | "failed" | "not_applicable";
  readonly evidence_refs: readonly Ref[];
  readonly summary: string;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface PrimitivePostconditionReport {
  readonly schema_version: typeof PRIMITIVE_POSTCONDITION_EVALUATOR_SCHEMA_VERSION;
  readonly blueprint_ref: "architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md";
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly primitive_ref: Ref;
  readonly primitive_name?: ManipulationPrimitiveDescriptor["primitive_name"];
  readonly decision: PrimitivePostconditionDecision;
  readonly recommended_action: PrimitivePostconditionAction;
  readonly verification_hook: ManipulationVerificationHook;
  readonly checks: readonly PrimitivePostconditionCheck[];
  readonly residual_report_refs: readonly Ref[];
  readonly contact_report_ref?: Ref;
  readonly visual_evidence_refs: readonly Ref[];
  readonly retry_budget_remaining: number;
  readonly prompt_safe_summary: string;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "primitive_postcondition_report";
  readonly determinism_hash: string;
}

export interface PrimitivePostconditionEvaluatorConfig {
  readonly primitive_catalog?: ManipulationPrimitiveCatalog;
  readonly max_position_residual_m?: number;
  readonly max_orientation_residual_rad?: number;
  readonly min_visual_confidence?: number;
}

interface NormalizedPostconditionPolicy {
  readonly max_position_residual_m: number;
  readonly max_orientation_residual_rad: number;
  readonly min_visual_confidence: number;
}

/**
 * Evaluates primitive completion against File 12 postconditions.
 */
export class PrimitivePostconditionEvaluator {
  private readonly primitiveCatalog: ManipulationPrimitiveCatalog;
  private readonly policy: NormalizedPostconditionPolicy;

  public constructor(config: PrimitivePostconditionEvaluatorConfig = {}) {
    this.primitiveCatalog = config.primitive_catalog ?? createManipulationPrimitiveCatalog();
    this.policy = Object.freeze({
      max_position_residual_m: positiveOrDefault(config.max_position_residual_m, 0.035),
      max_orientation_residual_rad: positiveOrDefault(config.max_orientation_residual_rad, 0.16),
      min_visual_confidence: clamp(config.min_visual_confidence ?? 0.55, 0, 1),
    });
  }

  /**
   * Checks execution, contact, visual, residual, verification, and retry
   * postconditions for one completed primitive.
   */
  public evaluatePrimitivePostconditions(request: PrimitivePostconditionEvaluationRequest): PrimitivePostconditionReport {
    const issues: ValidationIssue[] = [];
    const requestRef = sanitizeRef(request.request_ref ?? `primitive_postconditions_${computeDeterminismHash({
      primitive: request.primitive_result.primitive_ref,
      outcome: request.primitive_result.outcome_ref,
    })}`);
    const descriptor = resolveDescriptor(this.primitiveCatalog, request.primitive_result.primitive_ref, issues);
    const checks = freezeArray([
      executionCheck(request, issues),
      controlCheck(request, issues),
      contactCheck(request, descriptor),
      visualCheck(request, descriptor, this.policy),
      residualCheck(request, descriptor, this.policy),
      verificationCheck(request, descriptor),
      retryCheck(request),
    ]);
    const allIssues = freezeArray([...issues, ...checks.flatMap((check) => check.issues)]);
    const decision = decidePostconditions(descriptor, checks, allIssues);
    const visualRefs = freezeArray(uniqueSorted(request.visual_states.map((state) => sanitizeRef(state.evidence_ref))));
    const residualRefs = freezeArray(uniqueSorted((request.residual_reports ?? []).map((report) => sanitizeRef(report.residual_report_ref))));
    const base = {
      schema_version: PRIMITIVE_POSTCONDITION_EVALUATOR_SCHEMA_VERSION,
      blueprint_ref: "architecture_docs/12_MANIPULATION_GRASP_PLACE_TOOL_PRIMITIVES.md" as const,
      report_ref: `primitive_postcondition_report_${computeDeterminismHash({
        requestRef,
        decision,
        checks: checks.map((check) => `${check.name}:${check.status}`),
      })}`,
      request_ref: requestRef,
      primitive_ref: sanitizeRef(request.primitive_result.primitive_ref),
      primitive_name: descriptor?.primitive_name,
      decision,
      recommended_action: recommend(decision),
      verification_hook: descriptor?.verification_hook ?? "none" as ManipulationVerificationHook,
      checks,
      residual_report_refs: residualRefs,
      contact_report_ref: request.contact_state_report?.report_ref,
      visual_evidence_refs: visualRefs,
      retry_budget_remaining: Math.max(0, request.retry_budget_remaining),
      prompt_safe_summary: sanitizeText(`${descriptor?.primitive_name ?? request.primitive_result.primitive_ref} postconditions ${decision}; verification hook ${descriptor?.verification_hook ?? "none"}.`),
      issues: allIssues,
      ok: decision === "complete" || decision === "verification_required",
      cognitive_visibility: "primitive_postcondition_report" as const,
    };
    return Object.freeze({
      ...base,
      determinism_hash: computeDeterminismHash(base),
    });
  }
}

export function createPrimitivePostconditionEvaluator(config: PrimitivePostconditionEvaluatorConfig = {}): PrimitivePostconditionEvaluator {
  return new PrimitivePostconditionEvaluator(config);
}

function executionCheck(request: PrimitivePostconditionEvaluationRequest, issues: ValidationIssue[]): PrimitivePostconditionCheck {
  const localIssues: ValidationIssue[] = [];
  validateRef(request.primitive_result.outcome_ref, "$.primitive_result.outcome_ref", "PrimitiveResultInvalid", localIssues);
  validateRef(request.primitive_result.primitive_ref, "$.primitive_result.primitive_ref", "PrimitiveResultInvalid", localIssues);
  for (const ref of request.primitive_result.telemetry_refs) validateRef(ref, "$.primitive_result.telemetry_refs", "HiddenPostconditionLeak", localIssues);
  if (request.primitive_result.ended_at_s < request.primitive_result.started_at_s || request.primitive_result.started_at_s < 0) {
    localIssues.push(makeIssue("error", "PrimitiveResultInvalid", "$.primitive_result", "Execution interval must be finite, nonnegative, and ordered.", "Repair primitive outcome timing."));
  }
  if (request.primitive_result.execution_status === "aborted" || request.primitive_result.execution_status === "timed_out") {
    localIssues.push(makeIssue("error", "PrimitiveResultInvalid", "$.primitive_result.execution_status", "Primitive did not finish inside the execution envelope.", "Route to correction or safe hold."));
  } else if (request.primitive_result.execution_status === "interrupted" || request.primitive_result.execution_status === "completed_with_warnings") {
    localIssues.push(makeIssue("warning", "PrimitiveResultInvalid", "$.primitive_result.execution_status", "Primitive finished with warnings or interruption.", "Require corroborating contact and visual evidence."));
  }
  issues.push(...localIssues);
  return check("execution_status", statusFrom(localIssues), [request.primitive_result.outcome_ref, ...request.primitive_result.telemetry_refs], localIssues.length === 0 ? "Execution outcome is bounded and ordered." : "Execution outcome needs routing.", localIssues);
}

function controlCheck(request: PrimitivePostconditionEvaluationRequest, issues: ValidationIssue[]): PrimitivePostconditionCheck {
  const localIssues: ValidationIssue[] = [];
  if (request.control_work_order.primitive_ref !== request.primitive_result.primitive_ref) {
    localIssues.push(makeIssue("error", "ControlWorkOrderInvalid", "$.control_work_order.primitive_ref", "Control work order primitive does not match the execution outcome.", "Evaluate matching primitive work orders only."));
  }
  if (request.control_work_order.phases.length === 0) {
    localIssues.push(makeIssue("error", "ControlWorkOrderInvalid", "$.control_work_order.phases", "Control work order has no trajectory phases.", "Generate bounded phase specs before evaluating completion."));
  }
  issues.push(...localIssues);
  return check("control_alignment", statusFrom(localIssues), [request.control_work_order.work_order_ref], localIssues.length === 0 ? "Control work order aligns with primitive result." : "Control work order is inconsistent.", localIssues);
}

function contactCheck(
  request: PrimitivePostconditionEvaluationRequest,
  descriptor: ManipulationPrimitiveDescriptor | undefined,
): PrimitivePostconditionCheck {
  const localIssues: ValidationIssue[] = [];
  const required = requiresContact(descriptor);
  const report = request.contact_state_report;
  if (required && report === undefined) {
    localIssues.push(makeIssue("warning", "ContactStateRejected", "$.contact_state_report", "Manipulation postcondition needs contact-state evidence.", "Run ContactStateMonitor before final postcondition routing."));
  } else if (report !== undefined && !report.ok) {
    localIssues.push(makeIssue(report.decision === "crush_risk" || report.decision === "drop_risk" ? "error" : "warning", "ContactStateRejected", "$.contact_state_report.decision", `Contact monitor returned ${report.decision}.`, "Route contact failure to correction or safe hold."));
  }
  return check("contact_state", required ? statusFrom(localIssues) : "not_applicable", [report?.report_ref], localIssues.length === 0 ? "Contact postcondition is satisfied or not required." : "Contact postcondition is not fully satisfied.", localIssues);
}

function visualCheck(
  request: PrimitivePostconditionEvaluationRequest,
  descriptor: ManipulationPrimitiveDescriptor | undefined,
  policy: NormalizedPostconditionPolicy,
): PrimitivePostconditionCheck {
  const localIssues: ValidationIssue[] = [];
  for (const state of request.visual_states) {
    validateRef(state.evidence_ref, "$.visual_states.evidence_ref", "HiddenPostconditionLeak", localIssues);
    validateRef(state.subject_ref, "$.visual_states.subject_ref", "HiddenPostconditionLeak", localIssues);
  }
  const needsVisual = descriptor?.verification_hook !== "none" || descriptor?.required_sensor_evidence.includes("verification_view") === true || descriptor?.required_sensor_evidence.includes("target_visibility") === true;
  const visible = request.visual_states.some((state) => state.visible && state.confidence >= policy.min_visual_confidence);
  const blocked = request.visual_states.some((state) => state.occluded_by_effector && state.confidence >= 0.45);
  if (needsVisual && !visible) {
    localIssues.push(makeIssue("warning", "VisualEvidenceMissing", "$.visual_states", "Required postcondition view is missing or low confidence.", "Collect an alternate view before success routing."));
  }
  if (needsVisual && blocked) {
    localIssues.push(makeIssue("warning", "VerificationEvidenceBlocked", "$.visual_states.occluded_by_effector", "Postcondition view is blocked by the effector or tool.", "Retreat or switch view before verification."));
  }
  return check("visual_state", needsVisual ? statusFrom(localIssues) : "not_applicable", request.visual_states.map((state) => state.evidence_ref), localIssues.length === 0 ? "Visual postcondition evidence is usable." : "Visual postcondition evidence is incomplete or blocked.", localIssues);
}

function residualCheck(
  request: PrimitivePostconditionEvaluationRequest,
  descriptor: ManipulationPrimitiveDescriptor | undefined,
  policy: NormalizedPostconditionPolicy,
): PrimitivePostconditionCheck {
  const localIssues: ValidationIssue[] = [];
  const ownResidualM = request.primitive_result.final_pose_residual_m;
  const ownResidualRad = request.primitive_result.final_orientation_residual_rad;
  if (ownResidualM !== undefined && ownResidualM > policy.max_position_residual_m) {
    localIssues.push(makeIssue("warning", "ResidualOutOfTolerance", "$.primitive_result.final_pose_residual_m", "Final position residual exceeds manipulation tolerance.", "Route to correction or verification."));
  }
  if (ownResidualRad !== undefined && ownResidualRad > policy.max_orientation_residual_rad) {
    localIssues.push(makeIssue("warning", "ResidualOutOfTolerance", "$.primitive_result.final_orientation_residual_rad", "Final orientation residual exceeds manipulation tolerance.", "Route to correction or verification."));
  }
  for (const report of request.residual_reports ?? []) {
    if (report.result === "fail_unsafe") {
      localIssues.push(makeIssue("error", "ResidualOutOfTolerance", "$.residual_reports", "Spatial residual is unsafe for manipulation success.", "Enter safe hold or correction."));
    } else if (report.result === "fail_correctable" || report.result === "ambiguous" || report.result === "cannot_assess") {
      localIssues.push(makeIssue("warning", "ResidualOutOfTolerance", "$.residual_reports", "Spatial residual is not satisfied.", "Verify, correct, or reobserve before task completion."));
    }
  }
  const required = descriptor?.verification_hook === "placement_candidate" || descriptor?.verification_hook === "release_settled" || descriptor?.verification_hook === "tool_effect_verified";
  return check("spatial_residual", required || localIssues.length > 0 ? statusFrom(localIssues) : "not_applicable", (request.residual_reports ?? []).map((report) => report.residual_report_ref), localIssues.length === 0 ? "Spatial residual postconditions are within tolerance or deferred to verification." : "Spatial residuals require follow-up.", localIssues);
}

function verificationCheck(
  request: PrimitivePostconditionEvaluationRequest,
  descriptor: ManipulationPrimitiveDescriptor | undefined,
): PrimitivePostconditionCheck {
  const localIssues: ValidationIssue[] = [];
  const needsVerification = descriptor?.verification_hook !== undefined && descriptor.verification_hook !== "none";
  if (needsVerification && !request.verification_view_available) {
    localIssues.push(makeIssue("warning", "VerificationEvidenceBlocked", "$.verification_view_available", "Verification view is not currently available.", "Retreat, release-settle, or collect an alternate view."));
  }
  return check("verification_readiness", needsVerification ? statusFrom(localIssues) : "not_applicable", [], needsVerification ? "Verification hook is ready or explicitly constrained." : "Primitive has no verification hook.", localIssues);
}

function retryCheck(request: PrimitivePostconditionEvaluationRequest): PrimitivePostconditionCheck {
  const localIssues: ValidationIssue[] = [];
  if (request.retry_budget_remaining < 0) {
    localIssues.push(makeIssue("error", "RetryBudgetExceeded", "$.retry_budget_remaining", "Retry budget is negative.", "Repair retry accounting before correction routing."));
  } else if (request.retry_budget_remaining === 0 && request.primitive_result.execution_status !== "completed") {
    localIssues.push(makeIssue("warning", "RetryBudgetExceeded", "$.retry_budget_remaining", "Retry budget is exhausted after a non-clean outcome.", "Require changed strategy, human review, or safe hold."));
  }
  return check("retry_budget", statusFrom(localIssues), [], localIssues.length === 0 ? "Retry budget can support bounded routing." : "Retry budget constrains correction.", localIssues);
}

function decidePostconditions(
  descriptor: ManipulationPrimitiveDescriptor | undefined,
  checks: readonly PrimitivePostconditionCheck[],
  issues: readonly ValidationIssue[],
): PrimitivePostconditionDecision {
  if (issues.some((issue) => issue.severity === "error" && (issue.code === "PrimitiveResultInvalid" || issue.code === "ControlWorkOrderInvalid"))) return "rejected";
  if (issues.some((issue) => issue.severity === "error" && (issue.code === "ResidualOutOfTolerance" || issue.code === "ContactStateRejected"))) return "safe_hold_required";
  if (checks.some((item) => item.status === "failed")) return "correct_required";
  if (descriptor?.verification_hook !== undefined && descriptor.verification_hook !== "none") return checks.some((item) => item.status === "warning") ? "ambiguous" : "verification_required";
  return issues.length > 0 ? "ambiguous" : "complete";
}

function recommend(decision: PrimitivePostconditionDecision): PrimitivePostconditionAction {
  if (decision === "complete") return "advance_or_verify";
  if (decision === "verification_required") return "route_to_verification";
  if (decision === "ambiguous") return "collect_more_evidence";
  if (decision === "correct_required") return "route_to_correct";
  if (decision === "safe_hold_required") return "safe_hold";
  return "repair_result_packet";
}

function requiresContact(descriptor: ManipulationPrimitiveDescriptor | undefined): boolean {
  return descriptor === undefined
    || descriptor.admission_class === "contact_motion"
    || descriptor.admission_class === "load_bearing_motion"
    || descriptor.admission_class === "tool_motion"
    || descriptor.primitive_name === "release_object";
}

function resolveDescriptor(
  catalog: ManipulationPrimitiveCatalog,
  primitiveRef: Ref,
  issues: ValidationIssue[],
): ManipulationPrimitiveDescriptor | undefined {
  try {
    return catalog.requirePrimitive(primitiveRef);
  } catch (error: unknown) {
    issues.push(makeIssue("error", "PrimitiveResultInvalid", "$.primitive_result.primitive_ref", error instanceof Error ? error.message : "Primitive descriptor could not be resolved.", "Use a registered File 12 primitive ref."));
    return undefined;
  }
}

function check(
  name: PrimitivePostconditionCheck["name"],
  status: PrimitivePostconditionCheck["status"],
  refs: readonly (Ref | undefined)[],
  summary: string,
  issues: readonly ValidationIssue[],
): PrimitivePostconditionCheck {
  const cleanRefs = freezeArray(uniqueSorted(refs.filter((ref): ref is Ref => ref !== undefined).map(sanitizeRef)));
  const base = {
    check_ref: `postcondition_${name}_${computeDeterminismHash({ refs: cleanRefs, status })}`,
    name,
    status,
    evidence_refs: cleanRefs,
    summary: sanitizeText(summary),
    issues: freezeArray(issues),
  };
  return Object.freeze({
    ...base,
    determinism_hash: computeDeterminismHash(base),
  });
}

function statusFrom(issues: readonly ValidationIssue[]): PrimitivePostconditionCheck["status"] {
  if (issues.some((issue) => issue.severity === "error")) return "failed";
  return issues.length > 0 ? "warning" : "satisfied";
}

function validateRef(ref: Ref, path: string, code: PrimitivePostconditionIssueCode, issues: ValidationIssue[]): void {
  if (ref.trim().length === 0 || /\s/.test(ref)) {
    issues.push(makeIssue("error", code, path, "Reference must be a non-empty whitespace-free string.", "Use opaque postcondition refs."));
    return;
  }
  if (HIDDEN_POSTCONDITION_PATTERN.test(ref)) {
    issues.push(makeIssue("error", "HiddenPostconditionLeak", path, "Reference contains forbidden hidden execution detail.", "Use sensor-derived and validator-approved refs only."));
  }
}

function sanitizeText(text: string): string {
  return text.replace(HIDDEN_POSTCONDITION_PATTERN, "hidden-detail").replace(/\s+/g, " ").trim();
}

function sanitizeRef(ref: Ref): Ref {
  return ref.replace(HIDDEN_POSTCONDITION_PATTERN, "hidden-detail").trim();
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value <= 0 ? fallback : value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function uniqueSorted<T extends string>(items: readonly T[]): readonly T[] {
  return freezeArray([...new Set(items)].sort());
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

function makeIssue(
  severity: ValidationSeverity,
  code: PrimitivePostconditionIssueCode,
  path: string,
  message: string,
  remediation: string,
): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}
