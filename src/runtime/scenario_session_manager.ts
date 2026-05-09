/**
 * Scenario admission guard for PIT-B02. It admits only when runtime readiness,
 * orchestration safety mode, execution gate status, and SafeHold state are
 * compatible with the service-boundary contract.
 */

import type { ExecutionGatekeeperReport } from "../orchestration/execution_gatekeeper";
import type { PrimaryState, RuntimeStateSnapshot } from "../orchestration/orchestration_state_machine";
import type { SafeHoldExitDecisionKind } from "../safety/safe_hold_state_manager";
import type { RuntimeConfig } from "./runtime_config";
import type { RuntimeReadinessSnapshot } from "./runtime_readiness_snapshot";

export const SCENARIO_SESSION_SCHEMA_VERSION = "mebsuta.scenario_session_manager.v1" as const;

export type ScenarioAdmissionDecision = "admitted" | "rejected";

export interface ScenarioAdmissionRequest {
  readonly scenario_ref: string;
  readonly task_ref: string;
  readonly requested_at_ms: number;
  readonly truth_boundary_status: "runtime_embodied_only" | "runtime_policy_only" | "runtime_memory_labeled";
  readonly operator_ref?: string;
}

export interface ScenarioAdmissionContext {
  readonly config: RuntimeConfig;
  readonly readiness: RuntimeReadinessSnapshot;
  readonly orchestration_snapshot: RuntimeStateSnapshot;
  readonly execution_gatekeeper_report?: Pick<ExecutionGatekeeperReport, "decision" | "error_count">;
  readonly active_safe_hold_ref?: string;
  readonly latest_safe_hold_exit_decision?: SafeHoldExitDecisionKind;
}

export interface ScenarioAdmissionRecord {
  readonly schema_version: typeof SCENARIO_SESSION_SCHEMA_VERSION;
  readonly admission_ref: string;
  readonly decision: ScenarioAdmissionDecision;
  readonly scenario_ref: string;
  readonly task_ref: string;
  readonly accepted_start_state?: PrimaryState;
  readonly blocked_reasons: readonly string[];
  readonly audit_refs: readonly string[];
  readonly decided_at_ms: number;
}

export class ScenarioSessionManager {
  private readonly records: ScenarioAdmissionRecord[] = [];

  public admitScenario(request: ScenarioAdmissionRequest, context: ScenarioAdmissionContext): ScenarioAdmissionRecord {
    const blockedReasons = admissionBlocks(request, context);
    const decision: ScenarioAdmissionDecision = blockedReasons.length === 0 ? "admitted" : "rejected";
    const record: ScenarioAdmissionRecord = Object.freeze({
      schema_version: SCENARIO_SESSION_SCHEMA_VERSION,
      admission_ref: makeRef("scenario_admission", request.scenario_ref, request.requested_at_ms),
      decision,
      scenario_ref: request.scenario_ref,
      task_ref: request.task_ref,
      accepted_start_state: decision === "admitted" ? context.orchestration_snapshot.primary_state : undefined,
      blocked_reasons: Object.freeze(blockedReasons),
      audit_refs: Object.freeze([
        context.readiness.runtime_ref,
        context.orchestration_snapshot.current_context_ref,
        ...(context.active_safe_hold_ref === undefined ? [] : [context.active_safe_hold_ref]),
      ]),
      decided_at_ms: request.requested_at_ms,
    });
    this.records.push(record);
    return record;
  }

  public auditRecords(): readonly ScenarioAdmissionRecord[] {
    return Object.freeze([...this.records]);
  }
}

function admissionBlocks(request: ScenarioAdmissionRequest, context: ScenarioAdmissionContext): string[] {
  const reasons: string[] = [];
  if (!isSafeRef(request.scenario_ref) || !isSafeRef(request.task_ref)) {
    reasons.push("Scenario and task refs must be stable boundary-safe refs.");
  }
  if (context.config.admission_requires_ready_runtime && context.readiness.readiness_state !== "ready") {
    reasons.push("Runtime readiness is not ready.");
  }
  if (!context.readiness.accepting_scenarios || context.readiness.stopping) {
    reasons.push("Runtime is not accepting new scenarios.");
  }
  if (request.truth_boundary_status !== "runtime_embodied_only" && request.truth_boundary_status !== "runtime_policy_only") {
    reasons.push("Scenario admission accepts only runtime-visible boundary status.");
  }
  if (context.config.admission_requires_normal_safety && context.orchestration_snapshot.safety_mode !== "Normal") {
    reasons.push(`Orchestration safety mode blocks admission: ${context.orchestration_snapshot.safety_mode}.`);
  }
  if (context.config.admission_requires_safe_hold_clear && context.active_safe_hold_ref !== undefined) {
    reasons.push("Active SafeHold blocks scenario admission.");
  }
  if (context.latest_safe_hold_exit_decision === "remain_in_safe_hold" || context.latest_safe_hold_exit_decision === "human_review_required") {
    reasons.push(`SafeHold exit decision blocks admission: ${context.latest_safe_hold_exit_decision}.`);
  }
  if (context.execution_gatekeeper_report !== undefined && context.execution_gatekeeper_report.decision !== "blocked") {
    reasons.push("Scenario admission cannot proceed while execution gatekeeper owns an actionable decision.");
  }
  if (context.orchestration_snapshot.primary_state === "Execute" || context.orchestration_snapshot.primary_state === "SafeHold") {
    reasons.push(`Primary state ${context.orchestration_snapshot.primary_state} cannot admit a new scenario.`);
  }
  return reasons;
}

function isSafeRef(ref: string): boolean {
  return ref.trim().length > 0 && !/\s/.test(ref) && !/(ground_truth|scene_graph|backend|hidden|qa_)/i.test(ref);
}

function makeRef(...parts: readonly (string | number)[]): string {
  return parts
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

