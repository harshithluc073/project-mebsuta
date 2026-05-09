/**
 * Oops retry budget manager for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/14_OOPS_LOOP_CORRECTION_ENGINE.md`
 * sections 14.2.3, 14.4, 14.5, 14.13, 14.15.3, 14.19.7,
 * 14.20, 14.23, and 14.24.
 *
 * The manager enforces episode, repair, and reobserve budgets across failure
 * modes and certificate outcomes so correction cannot become unbounded.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import type { TaskSuccessCertificate } from "../verification/task_success_certificate_issuer";
import {
  OOPS_BLUEPRINT_REF,
  freezeOopsArray,
  makeOopsIssue,
  makeOopsRef,
  type OopsEpisode,
  type OopsFailureFamily,
  type OopsRetryBudget,
  type OopsRouteDecision,
  type OopsSafetyState,
} from "./oops_intake_router";

export const OOPS_RETRY_BUDGET_MANAGER_SCHEMA_VERSION = "mebsuta.oops_retry_budget_manager.v1" as const;

export type OopsRetryDecisionKind = "continue_correction" | "request_reobserve" | "safe_hold_required" | "human_review_required" | "complete";

export interface OopsRetryBudgetManagerRequest {
  readonly request_ref?: Ref;
  readonly episode: OopsEpisode;
  readonly latest_failure_mode?: OopsFailureFamily;
  readonly verification_certificate?: TaskSuccessCertificate;
  readonly safety_state: OopsSafetyState;
}

export interface OopsRetryBudgetReport {
  readonly schema_version: typeof OOPS_RETRY_BUDGET_MANAGER_SCHEMA_VERSION;
  readonly blueprint_ref: typeof OOPS_BLUEPRINT_REF;
  readonly report_ref: Ref;
  readonly request_ref: Ref;
  readonly decision: OopsRetryDecisionKind;
  readonly route_decision: OopsRouteDecision | "complete";
  readonly updated_retry_budget: OopsRetryBudget;
  readonly remaining_episode_attempts: number;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "oops_retry_budget_report";
  readonly determinism_hash: string;
}

/**
 * Applies episode-level correction budget accounting.
 */
export class OopsRetryBudgetManager {
  /**
   * Decides whether correction may continue after the latest outcome.
   */
  public updateRetryBudget(request: OopsRetryBudgetManagerRequest): OopsRetryBudgetReport {
    const issues: ValidationIssue[] = [];
    const updated = updateBudget(request);
    const remaining = Math.max(0, updated.maximum_episode_attempts - updated.episode_attempts_used);
    const decision = decide(request, updated, remaining, issues);
    const requestRef = request.request_ref ?? makeOopsRef("oops_retry_budget", request.episode.oops_episode_ref);
    const base = {
      schema_version: OOPS_RETRY_BUDGET_MANAGER_SCHEMA_VERSION,
      blueprint_ref: OOPS_BLUEPRINT_REF,
      report_ref: makeOopsRef("oops_retry_budget_report", requestRef, decision),
      request_ref: requestRef,
      decision,
      route_decision: routeFor(decision),
      updated_retry_budget: updated,
      remaining_episode_attempts: remaining,
      issues: freezeOopsArray(issues),
      ok: decision === "continue_correction" || decision === "request_reobserve" || decision === "complete",
      cognitive_visibility: "oops_retry_budget_report" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function createOopsRetryBudgetManager(): OopsRetryBudgetManager {
  return new OopsRetryBudgetManager();
}

function updateBudget(request: OopsRetryBudgetManagerRequest): OopsRetryBudget {
  const current = request.episode.current_retry_budget;
  const certificate = request.verification_certificate;
  return Object.freeze({
    episode_attempts_used: certificate?.result === "success" ? current.episode_attempts_used : current.episode_attempts_used + 1,
    maximum_episode_attempts: current.maximum_episode_attempts,
    repair_attempts_used: current.repair_attempts_used,
    maximum_repair_attempts: current.maximum_repair_attempts,
    reobserve_attempts_used: certificate?.result === "ambiguous" ? current.reobserve_attempts_used + 1 : current.reobserve_attempts_used,
    maximum_reobserve_attempts: current.maximum_reobserve_attempts,
  });
}

function decide(
  request: OopsRetryBudgetManagerRequest,
  budget: OopsRetryBudget,
  remaining: number,
  issues: ValidationIssue[],
): OopsRetryDecisionKind {
  if (request.verification_certificate?.result === "success") return "complete";
  if (request.safety_state === "safe_hold" || request.verification_certificate?.result === "failure_unsafe") return "safe_hold_required";
  if (remaining <= 0) {
    issues.push(makeOopsIssue("warning", "RetryBudgetExhausted", "$.updated_retry_budget", "Episode correction budget is exhausted.", "Escalate to human review."));
    return "human_review_required";
  }
  if (request.verification_certificate?.result === "ambiguous" || request.latest_failure_mode === "sensor_or_view_gap") {
    return budget.reobserve_attempts_used >= budget.maximum_reobserve_attempts ? "human_review_required" : "request_reobserve";
  }
  return "continue_correction";
}

function routeFor(decision: OopsRetryDecisionKind): OopsRouteDecision | "complete" {
  if (decision === "complete") return "complete";
  if (decision === "continue_correction") return "correct";
  if (decision === "request_reobserve") return "reobserve";
  if (decision === "safe_hold_required") return "safe_hold";
  return "human_review";
}
