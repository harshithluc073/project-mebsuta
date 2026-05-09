/**
 * Oops verification bridge for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/14_OOPS_LOOP_CORRECTION_ENGINE.md`
 * sections 14.3, 14.4, 14.15, 14.19.6, 14.20.4, and 14.24.
 *
 * The bridge creates a File 13 verification request after correction execution.
 * The Oops Loop never self-certifies completion.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import type { VerificationRequest } from "../verification/verification_policy_registry";
import {
  OOPS_BLUEPRINT_REF,
  cleanOopsRef,
  freezeOopsArray,
  makeOopsIssue,
  makeOopsRef,
  uniqueOopsSorted,
  type OopsEpisode,
} from "./oops_intake_router";
import type { CandidateCorrectionPlan } from "./oops_intake_router";
import type { CorrectionExecutionResult } from "./correction_execution_monitor";

export const OOPS_VERIFICATION_BRIDGE_SCHEMA_VERSION = "mebsuta.oops_verification_bridge.v1" as const;

export type OopsVerificationBridgeDecision = "verification_request_ready" | "reobserve_required" | "safe_hold_required" | "rejected";

export interface CorrectionCompletionEvent {
  readonly completion_event_ref: Ref;
  readonly attempt_ref: Ref;
  readonly correction_plan_ref: Ref;
  readonly execution_result_ref: Ref;
  readonly completed_at_ms: number;
  readonly telemetry_refs: readonly Ref[];
  readonly expected_verification_refs: readonly Ref[];
}

export interface OopsVerificationBridgeRequest {
  readonly request_ref?: Ref;
  readonly episode: OopsEpisode;
  readonly candidate_plan: CandidateCorrectionPlan;
  readonly execution_result: CorrectionExecutionResult;
  readonly base_verification_request: VerificationRequest;
  readonly failed_constraint_refs: readonly Ref[];
  readonly preserved_constraint_refs: readonly Ref[];
  readonly completed_at_ms: number;
}

export interface OopsVerificationBridgeReport {
  readonly schema_version: typeof OOPS_VERIFICATION_BRIDGE_SCHEMA_VERSION;
  readonly blueprint_ref: typeof OOPS_BLUEPRINT_REF;
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly decision: OopsVerificationBridgeDecision;
  readonly completion_event?: CorrectionCompletionEvent;
  readonly verification_request?: VerificationRequest;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "oops_verification_bridge_report";
  readonly determinism_hash: string;
}

/**
 * Routes correction completion back to File 13 verification.
 */
export class OopsVerificationBridge {
  /**
   * Builds a post-correction verification request from execution outcome.
   */
  public createPostCorrectionVerificationRequest(request: OopsVerificationBridgeRequest): OopsVerificationBridgeReport {
    const issues: ValidationIssue[] = [];
    if (request.execution_result.result_kind === "unsafe_anomaly") {
      issues.push(makeOopsIssue("warning", "SafetyLimitExceeded", "$.execution_result", "Unsafe execution result requires SafeHold.", "Do not verify success until safety review."));
    }
    const decision = decide(request, issues);
    const event = decision === "verification_request_ready" || decision === "reobserve_required" ? buildCompletionEvent(request) : undefined;
    const verificationRequest = event === undefined ? undefined : buildVerificationRequest(request, event);
    const requestRef = cleanOopsRef(request.request_ref ?? makeOopsRef("oops_verification_bridge", request.episode.oops_episode_ref));
    const base = {
      schema_version: OOPS_VERIFICATION_BRIDGE_SCHEMA_VERSION,
      blueprint_ref: OOPS_BLUEPRINT_REF,
      report_ref: makeOopsRef("oops_verification_bridge_report", requestRef, decision),
      request_ref: requestRef,
      decision,
      completion_event: event,
      verification_request: verificationRequest,
      issues: freezeOopsArray(issues),
      ok: verificationRequest !== undefined && decision === "verification_request_ready",
      cognitive_visibility: "oops_verification_bridge_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function createOopsVerificationBridge(): OopsVerificationBridge {
  return new OopsVerificationBridge();
}

function buildCompletionEvent(request: OopsVerificationBridgeRequest): CorrectionCompletionEvent {
  return Object.freeze({
    completion_event_ref: makeOopsRef("correction_completion_event", request.execution_result.result_ref),
    attempt_ref: request.episode.attempt_records[request.episode.attempt_records.length - 1]?.attempt_ref ?? makeOopsRef("attempt", request.episode.oops_episode_ref),
    correction_plan_ref: request.candidate_plan.plan_ref,
    execution_result_ref: request.execution_result.result_ref,
    completed_at_ms: request.completed_at_ms,
    telemetry_refs: request.execution_result.telemetry_refs,
    expected_verification_refs: uniqueOopsSorted([...request.failed_constraint_refs, ...request.preserved_constraint_refs, ...request.candidate_plan.expected_postcondition_refs]),
  });
}

function buildVerificationRequest(request: OopsVerificationBridgeRequest, event: CorrectionCompletionEvent): VerificationRequest {
  return Object.freeze({
    ...request.base_verification_request,
    verification_request_ref: makeOopsRef("post_correction_verification", event.completion_event_ref),
    primitive_ref: request.candidate_plan.plan_ref,
    expected_postcondition_refs: uniqueOopsSorted([...request.base_verification_request.expected_postcondition_refs, ...event.expected_verification_refs]),
    controller_completion_summary: Object.freeze({
      ...request.base_verification_request.controller_completion_summary,
      completion_ref: event.completion_event_ref,
      trajectory_state: request.execution_result.result_kind === "completed" ? "completed" : "completed_with_warnings",
      telemetry_refs: event.telemetry_refs,
      anomaly_refs: request.execution_result.anomaly_refs,
      high_force_contact: request.execution_result.result_kind === "unsafe_anomaly",
    }),
  });
}

function decide(request: OopsVerificationBridgeRequest, issues: readonly ValidationIssue[]): OopsVerificationBridgeDecision {
  if (issues.some((issue) => issue.severity === "error")) return "rejected";
  if (request.execution_result.result_kind === "unsafe_anomaly") return "safe_hold_required";
  if (request.execution_result.result_kind === "timed_out" || request.execution_result.result_kind === "aborted") return "reobserve_required";
  return "verification_request_ready";
}
