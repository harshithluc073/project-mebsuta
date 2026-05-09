/**
 * Review cadence scheduler.
 *
 * Blueprint: `architecture_docs/21_ROADMAP_WBS_DELIVERY_AND_PROJECT_OPERATIONS.md`
 * sections 21.9, 21.11, 21.13, 21.14, and 21.15.
 *
 * Review cadences define meeting purpose, required inputs, owner workstreams,
 * and deterministic next-occurrence scheduling for project operations.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  OPERATIONS_BLUEPRINT_REF,
  OperationsContractError,
  buildOperationsValidationReport,
  freezeOperationsArray,
  makeOperationsRef,
  normalizeOperationsText,
  operationsIssue,
  operationsRouteForIssues,
  uniqueOperationsRefs,
  uniqueOperationsStrings,
  validateOperationsNonEmptyArray,
  validateOperationsRef,
  validateOperationsRefs,
  validateOperationsText,
} from "./milestone_registry";
import type { OperationsValidationReport } from "./milestone_registry";
import type { WorkstreamRef } from "./workstream_registry";

export const REVIEW_CADENCE_SCHEDULER_SCHEMA_VERSION = "mebsuta.operations.review_cadence_scheduler.v1" as const;

export type ReviewMeetingKind = "architecture_review" | "safety_review" | "qa_triage" | "prompt_review" | "integration_review" | "risk_review" | "release_readiness_review";
export type CadenceRule = "weekly" | "weekly_and_pre_release" | "twice_weekly_active_build" | "biweekly_or_incident" | "before_milestone_exit";

export interface ReviewCadenceInput {
  readonly review_ref: Ref;
  readonly meeting_kind: ReviewMeetingKind;
  readonly cadence_rule: CadenceRule;
  readonly purpose: string;
  readonly owner_workstream_refs: readonly WorkstreamRef[];
  readonly required_input_refs: readonly Ref[];
  readonly required_input_descriptions: readonly string[];
}

export interface ReviewCadence {
  readonly schema_version: typeof REVIEW_CADENCE_SCHEDULER_SCHEMA_VERSION;
  readonly review_ref: Ref;
  readonly meeting_kind: ReviewMeetingKind;
  readonly cadence_rule: CadenceRule;
  readonly purpose: string;
  readonly owner_workstream_refs: readonly WorkstreamRef[];
  readonly required_input_refs: readonly Ref[];
  readonly required_input_descriptions: readonly string[];
  readonly determinism_hash: string;
}

export interface ReviewScheduleDecision {
  readonly review_ref: Ref;
  readonly scheduled_for_iso: string;
  readonly cadence_rule: CadenceRule;
  readonly missing_input_refs: readonly Ref[];
  readonly ready_for_review: boolean;
  readonly determinism_hash: string;
}

/**
 * Builds and validates a review cadence definition.
 */
export function buildReviewCadence(input: ReviewCadenceInput): ReviewCadence {
  const cadence = normalizeReviewCadence(input);
  const report = validateReviewCadence(cadence);
  if (!report.ok) {
    throw new OperationsContractError("Review cadence failed validation.", report.issues);
  }
  return cadence;
}

export function normalizeReviewCadence(input: ReviewCadenceInput): ReviewCadence {
  const base = {
    schema_version: REVIEW_CADENCE_SCHEDULER_SCHEMA_VERSION,
    review_ref: input.review_ref,
    meeting_kind: input.meeting_kind,
    cadence_rule: input.cadence_rule,
    purpose: normalizeOperationsText(input.purpose),
    owner_workstream_refs: freezeOperationsArray([...new Set(input.owner_workstream_refs)]),
    required_input_refs: uniqueOperationsRefs(input.required_input_refs),
    required_input_descriptions: uniqueOperationsStrings(input.required_input_descriptions),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateReviewCadence(cadence: ReviewCadence): OperationsValidationReport {
  const issues: ValidationIssue[] = [];
  validateOperationsRef(cadence.review_ref, "$.review_ref", issues);
  validateOperationsText(cadence.purpose, "$.purpose", true, issues);
  validateOperationsNonEmptyArray(cadence.owner_workstream_refs, "$.owner_workstream_refs", "ReviewOwnersMissing", issues);
  validateOperationsNonEmptyArray(cadence.required_input_refs, "$.required_input_refs", "ReviewInputsMissing", issues);
  validateOperationsNonEmptyArray(cadence.required_input_descriptions, "$.required_input_descriptions", "ReviewInputDescriptionsMissing", issues);
  validateOperationsRefs(cadence.required_input_refs, "$.required_input_refs", issues);
  cadence.required_input_descriptions.forEach((description, index) => validateOperationsText(description, `$.required_input_descriptions[${index}]`, true, issues));
  if (cadence.meeting_kind === "release_readiness_review" && cadence.cadence_rule !== "before_milestone_exit") {
    issues.push(operationsIssue("error", "ReleaseReviewCadenceInvalid", "$.cadence_rule", "Release readiness review must use the milestone-exit cadence.", "Set cadence rule to before_milestone_exit."));
  }
  return buildOperationsValidationReport(makeOperationsRef("review_cadence_report", cadence.review_ref), issues, operationsRouteForIssues(issues));
}

export function scheduleNextReview(cadence: ReviewCadence, fromIso: string, availableInputRefs: readonly Ref[]): ReviewScheduleDecision {
  const from = new Date(fromIso);
  const fromMs = Number.isFinite(from.getTime()) ? from.getTime() : 0;
  const scheduled = new Date(fromMs + cadenceIntervalMs(cadence.cadence_rule)).toISOString();
  const available = new Set(availableInputRefs);
  const missing = cadence.required_input_refs.filter((ref) => !available.has(ref));
  const base = {
    review_ref: cadence.review_ref,
    scheduled_for_iso: scheduled,
    cadence_rule: cadence.cadence_rule,
    missing_input_refs: uniqueOperationsRefs(missing),
    ready_for_review: missing.length === 0,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function defaultReviewCadences(): readonly ReviewCadence[] {
  return freezeOperationsArray([
    cadence("architecture_review", "architecture_review", "weekly", "Resolve contract and design decisions.", ["WS-A"], ["open_design_changes", "interface_diffs"], ["Open design changes", "Interface diffs"]),
    cadence("safety_review", "safety_review", "weekly_and_pre_release", "Review validators, SafeHold, and incidents.", ["WS-O"], ["safety_reports", "risk_updates"], ["Safety reports", "Risk updates"]),
    cadence("qa_triage", "qa_triage", "weekly", "Review failing tests and benchmark drift.", ["WS-P"], ["qa_reports", "replay_bundles"], ["QA reports", "Replay bundles"]),
    cadence("prompt_review", "prompt_review", "weekly", "Review Gemini output behavior.", ["WS-F"], ["prompt_regressions", "parse_failures"], ["Prompt regressions", "Parse failures"]),
    cadence("integration_review", "integration_review", "twice_weekly_active_build", "Coordinate cross-service dependencies.", ["WS-G", "WS-Q"], ["integration_status", "blockers"], ["Integration status", "Blockers"]),
    cadence("risk_review", "risk_review", "biweekly_or_incident", "Update risk register.", ["WS-Q"], ["risk_triggers", "mitigation_status"], ["Risk triggers", "Mitigation status"]),
    cadence("release_readiness_review", "release_readiness_review", "before_milestone_exit", "Decide milestone release readiness.", ["WS-Q", "WS-P"], ["gate_checklist", "scorecards"], ["Gate checklist", "Scorecards"]),
  ]);
}

function cadence(
  reviewRef: Ref,
  meetingKind: ReviewMeetingKind,
  cadenceRule: CadenceRule,
  purpose: string,
  ownerWorkstreamRefs: readonly WorkstreamRef[],
  requiredInputRefs: readonly Ref[],
  requiredInputDescriptions: readonly string[],
): ReviewCadence {
  return buildReviewCadence({
    review_ref: reviewRef,
    meeting_kind: meetingKind,
    cadence_rule: cadenceRule,
    purpose,
    owner_workstream_refs: ownerWorkstreamRefs,
    required_input_refs: requiredInputRefs,
    required_input_descriptions: requiredInputDescriptions,
  });
}

function cadenceIntervalMs(rule: CadenceRule): number {
  const day = 24 * 60 * 60 * 1000;
  switch (rule) {
    case "weekly":
    case "weekly_and_pre_release":
      return 7 * day;
    case "twice_weekly_active_build":
      return 3 * day + 12 * 60 * 60 * 1000;
    case "biweekly_or_incident":
      return 14 * day;
    case "before_milestone_exit":
      return 7 * day;
  }
}

export const REVIEW_CADENCE_SCHEDULER_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: REVIEW_CADENCE_SCHEDULER_SCHEMA_VERSION,
  blueprint: OPERATIONS_BLUEPRINT_REF,
  sections: freezeOperationsArray(["21.9", "21.11", "21.13", "21.14", "21.15"]),
  component: "ReviewCadenceScheduler",
});
