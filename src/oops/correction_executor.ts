/**
 * Correction executor for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/14_OOPS_LOOP_CORRECTION_ENGINE.md`
 * sections 14.4, 14.14, 14.17, 14.18, 14.19.6, and 14.24.
 *
 * The executor converts a validated candidate plan into a deterministic
 * primitive dispatch handle with bounded waypoints, limits, and stop criteria.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  OOPS_BLUEPRINT_REF,
  cleanOopsRef,
  freezeOopsArray,
  makeOopsIssue,
  makeOopsRef,
  uniqueOopsSorted,
  type CandidateCorrectionPlan,
} from "./oops_intake_router";
import type { SafetyValidationReport } from "./correction_safety_validator";
import type { FeasibilityValidationReport } from "./correction_feasibility_validator";

export const CORRECTION_EXECUTOR_SCHEMA_VERSION = "mebsuta.correction_executor.v1" as const;

export type CorrectionExecutionDispatchDecision = "dispatch_ready" | "dispatch_with_adjustments" | "blocked" | "rejected";

export interface CorrectionExecutionHandle {
  readonly execution_handle_ref: Ref;
  readonly source_plan_ref: Ref;
  readonly selected_primitive_ref: Ref;
  readonly waypoint_refs: readonly Ref[];
  readonly force_limit_n: number;
  readonly speed_limit_mps: number;
  readonly max_duration_ms: number;
  readonly stop_conditions: readonly string[];
  readonly telemetry_stream_ref: Ref;
  readonly determinism_hash: string;
}

export interface CorrectionExecutorRequest {
  readonly request_ref?: Ref;
  readonly candidate_plan: CandidateCorrectionPlan;
  readonly safety_report: SafetyValidationReport;
  readonly feasibility_report: FeasibilityValidationReport;
  readonly controller_profile_ref: Ref;
}

export interface CorrectionExecutorReport {
  readonly schema_version: typeof CORRECTION_EXECUTOR_SCHEMA_VERSION;
  readonly blueprint_ref: typeof OOPS_BLUEPRINT_REF;
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly decision: CorrectionExecutionDispatchDecision;
  readonly execution_handle?: CorrectionExecutionHandle;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "correction_executor_report";
  readonly determinism_hash: string;
}

/**
 * Dispatches validated correction plans to deterministic execution.
 */
export class CorrectionExecutor {
  /**
   * Creates an execution handle only when safety and feasibility agree.
   */
  public dispatchCorrection(request: CorrectionExecutorRequest): CorrectionExecutorReport {
    const issues: ValidationIssue[] = [];
    if (!request.safety_report.ok) issues.push(makeOopsIssue("error", "SafetyLimitExceeded", "$.safety_report", "Safety validation blocks dispatch.", "Repair safety first."));
    if (!request.feasibility_report.ok) issues.push(makeOopsIssue("error", "FeasibilityMissing", "$.feasibility_report", "Feasibility validation blocks dispatch.", "Repair feasibility first."));
    const decision: CorrectionExecutionDispatchDecision = issues.some((issue) => issue.severity === "error") ? "blocked" : request.feasibility_report.required_adjustments.length > 0 ? "dispatch_with_adjustments" : "dispatch_ready";
    const handle = decision === "blocked" ? undefined : buildHandle(request);
    const requestRef = cleanOopsRef(request.request_ref ?? makeOopsRef("correction_executor", request.candidate_plan.plan_ref));
    const base = {
      schema_version: CORRECTION_EXECUTOR_SCHEMA_VERSION,
      blueprint_ref: OOPS_BLUEPRINT_REF,
      report_ref: makeOopsRef("correction_executor_report", requestRef, decision),
      request_ref: requestRef,
      decision,
      execution_handle: handle,
      issues: freezeOopsArray(issues),
      ok: handle !== undefined,
      cognitive_visibility: "correction_executor_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function createCorrectionExecutor(): CorrectionExecutor {
  return new CorrectionExecutor();
}

function buildHandle(request: CorrectionExecutorRequest): CorrectionExecutionHandle {
  const selectedPrimitive = primitiveFor(request.candidate_plan);
  const handleRef = makeOopsRef("correction_execution_handle", request.candidate_plan.plan_ref, selectedPrimitive);
  const base = {
    execution_handle_ref: handleRef,
    source_plan_ref: request.candidate_plan.plan_ref,
    selected_primitive_ref: selectedPrimitive,
    waypoint_refs: uniqueOopsSorted(request.candidate_plan.waypoints.map((waypoint) => waypoint.waypoint_ref)),
    force_limit_n: Math.min(request.candidate_plan.force_limit_n, request.safety_report.restricted_force_limit_n),
    speed_limit_mps: Math.min(request.candidate_plan.speed_limit_mps, request.safety_report.restricted_speed_limit_mps),
    max_duration_ms: request.candidate_plan.max_duration_ms,
    stop_conditions: freezeOopsArray(request.candidate_plan.stop_conditions),
    telemetry_stream_ref: makeOopsRef("correction_telemetry_stream", handleRef, cleanOopsRef(request.controller_profile_ref)),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function primitiveFor(plan: CandidateCorrectionPlan): Ref {
  if (plan.correction_intent === "micro_adjust") return "primitive_micro_place_adjust";
  if (plan.correction_intent === "rotate_in_place") return "primitive_low_force_rotate";
  if (plan.correction_intent === "re_aim_tool") return "primitive_tool_reaim_contact";
  if (plan.correction_intent === "reposition_body") return "primitive_safe_body_reposition";
  if (plan.correction_intent === "regrasp_and_replace") return "primitive_regrasp_replace";
  return "primitive_reobserve_only";
}
