/**
 * Correction execution monitor for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/14_OOPS_LOOP_CORRECTION_ENGINE.md`
 * sections 14.4, 14.14.4, 14.19.6, 14.20.4, 14.21, and 14.24.
 *
 * The monitor watches controller telemetry, elapsed time, residual drift, and
 * contact anomalies during correction execution.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import { OOPS_BLUEPRINT_REF, cleanOopsRef, freezeOopsArray, makeOopsIssue, makeOopsRef, meanScore, uniqueOopsSorted } from "./oops_intake_router";
import type { CorrectionExecutionHandle } from "./correction_executor";

export const CORRECTION_EXECUTION_MONITOR_SCHEMA_VERSION = "mebsuta.correction_execution_monitor.v1" as const;

export type CorrectionExecutionResultKind = "completed" | "completed_with_warnings" | "aborted" | "unsafe_anomaly" | "timed_out";

export interface CorrectionTelemetrySample {
  readonly sample_ref: Ref;
  readonly timestamp_ms: number;
  readonly position_error_m: number;
  readonly force_n: number;
  readonly speed_mps: number;
  readonly anomaly_refs: readonly Ref[];
}

export interface CorrectionExecutionMonitorRequest {
  readonly request_ref?: Ref;
  readonly execution_handle: CorrectionExecutionHandle;
  readonly telemetry_samples: readonly CorrectionTelemetrySample[];
  readonly current_time_ms: number;
}

export interface CorrectionExecutionResult {
  readonly schema_version: typeof CORRECTION_EXECUTION_MONITOR_SCHEMA_VERSION;
  readonly blueprint_ref: typeof OOPS_BLUEPRINT_REF;
  readonly result_ref: Ref;
  readonly execution_handle_ref: Ref;
  readonly result_kind: CorrectionExecutionResultKind;
  readonly telemetry_refs: readonly Ref[];
  readonly anomaly_refs: readonly Ref[];
  readonly max_position_error_m: number;
  readonly max_force_n: number;
  readonly max_speed_mps: number;
  readonly confidence: number;
  readonly prompt_safe_summary: string;
  readonly determinism_hash: string;
}

export interface CorrectionExecutionMonitorReport {
  readonly schema_version: typeof CORRECTION_EXECUTION_MONITOR_SCHEMA_VERSION;
  readonly blueprint_ref: typeof OOPS_BLUEPRINT_REF;
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly result: CorrectionExecutionResult;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "correction_execution_monitor_report";
  readonly determinism_hash: string;
}

/**
 * Monitors correction execution and emits completion or anomaly results.
 */
export class CorrectionExecutionMonitor {
  /**
   * Classifies the execution stream against handle limits.
   */
  public monitorCorrectionExecution(request: CorrectionExecutionMonitorRequest): CorrectionExecutionMonitorReport {
    const issues: ValidationIssue[] = [];
    if (request.telemetry_samples.length === 0) {
      issues.push(makeOopsIssue("warning", "EvidenceMissing", "$.telemetry_samples", "Execution monitor has no telemetry samples.", "Attach controller telemetry before closing correction."));
    }
    const result = buildResult(request, issues);
    const requestRef = cleanOopsRef(request.request_ref ?? makeOopsRef("correction_execution_monitor", request.execution_handle.execution_handle_ref));
    const base = {
      schema_version: CORRECTION_EXECUTION_MONITOR_SCHEMA_VERSION,
      blueprint_ref: OOPS_BLUEPRINT_REF,
      report_ref: makeOopsRef("correction_execution_monitor_report", requestRef, result.result_kind),
      request_ref: requestRef,
      result,
      issues: freezeOopsArray(issues),
      ok: result.result_kind === "completed" || result.result_kind === "completed_with_warnings",
      cognitive_visibility: "correction_execution_monitor_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function createCorrectionExecutionMonitor(): CorrectionExecutionMonitor {
  return new CorrectionExecutionMonitor();
}

function buildResult(request: CorrectionExecutionMonitorRequest, issues: readonly ValidationIssue[]): CorrectionExecutionResult {
  const samples = [...request.telemetry_samples].sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  const elapsed = samples.length === 0 ? 0 : request.current_time_ms - samples[0].timestamp_ms;
  const maxForce = Math.max(0, ...samples.map((sample) => sample.force_n));
  const maxSpeed = Math.max(0, ...samples.map((sample) => sample.speed_mps));
  const maxError = Math.max(0, ...samples.map((sample) => sample.position_error_m));
  const anomalies = uniqueOopsSorted(samples.flatMap((sample) => sample.anomaly_refs).map(cleanOopsRef));
  const kind = resultKind(request, elapsed, maxForce, maxSpeed, anomalies, issues);
  const confidence = meanScore([samples.length > 0 ? 1 : 0.25, maxForce <= request.execution_handle.force_limit_n ? 1 : 0.2, maxSpeed <= request.execution_handle.speed_limit_mps ? 1 : 0.35, anomalies.length === 0 ? 1 : 0.45]);
  const base = {
    schema_version: CORRECTION_EXECUTION_MONITOR_SCHEMA_VERSION,
    blueprint_ref: OOPS_BLUEPRINT_REF,
    result_ref: makeOopsRef("correction_execution_result", request.execution_handle.execution_handle_ref, kind),
    execution_handle_ref: request.execution_handle.execution_handle_ref,
    result_kind: kind,
    telemetry_refs: uniqueOopsSorted(samples.map((sample) => cleanOopsRef(sample.sample_ref))),
    anomaly_refs: anomalies,
    max_position_error_m: maxError,
    max_force_n: maxForce,
    max_speed_mps: maxSpeed,
    confidence,
    prompt_safe_summary: `Correction execution ${kind} with ${anomalies.length} anomaly ref(s).`,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function resultKind(
  request: CorrectionExecutionMonitorRequest,
  elapsedMs: number,
  maxForce: number,
  maxSpeed: number,
  anomalies: readonly Ref[],
  issues: readonly ValidationIssue[],
): CorrectionExecutionResultKind {
  if (maxForce > request.execution_handle.force_limit_n * 1.1 || anomalies.some((ref) => /unsafe|collision|force/iu.test(ref))) return "unsafe_anomaly";
  if (elapsedMs > request.execution_handle.max_duration_ms) return "timed_out";
  if (maxSpeed > request.execution_handle.speed_limit_mps * 1.1) return "aborted";
  return issues.length > 0 || anomalies.length > 0 ? "completed_with_warnings" : "completed";
}
