/**
 * Release train planner.
 *
 * Blueprint: `architecture_docs/21_ROADMAP_WBS_DELIVERY_AND_PROJECT_OPERATIONS.md`
 * sections 21.3, 21.6, 21.7, 21.8, 21.11, and 21.15.
 *
 * The planner maps release types to required dependency gates, milestone
 * windows, readiness evidence, and deterministic go/no-go style outcomes.
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
  validateOperationsNonEmptyArray,
  validateOperationsRef,
  validateOperationsRefs,
  validateOperationsText,
} from "./milestone_registry";
import type { MilestoneRef, OperationsValidationReport } from "./milestone_registry";
import type { DependencyGateRef, GateReadinessDecision } from "./dependency_gate_registry";

export const RELEASE_TRAIN_PLANNER_SCHEMA_VERSION = "mebsuta.operations.release_train_planner.v1" as const;

export type ReleaseType = "architecture_draft" | "foundation_prototype" | "cognitive_slice" | "verification_demo" | "recovery_demo" | "full_feature_demo" | "release_candidate";
export type ReleaseTrainDecision = "ready" | "conditional" | "blocked";

export interface ReleaseTrainPlanInput {
  readonly release_plan_ref: Ref;
  readonly release_type: ReleaseType;
  readonly milestone_window: readonly MilestoneRef[];
  readonly candidate_artifact_refs: readonly Ref[];
  readonly gate_decisions: readonly GateReadinessDecision[];
  readonly known_limitation_refs?: readonly Ref[];
}

export interface ReleaseTrainPlan {
  readonly schema_version: typeof RELEASE_TRAIN_PLANNER_SCHEMA_VERSION;
  readonly release_plan_ref: Ref;
  readonly release_type: ReleaseType;
  readonly milestone_window: readonly MilestoneRef[];
  readonly required_gate_refs: readonly DependencyGateRef[];
  readonly candidate_artifact_refs: readonly Ref[];
  readonly gate_decisions: readonly GateReadinessDecision[];
  readonly known_limitation_refs: readonly Ref[];
  readonly missing_gate_refs: readonly DependencyGateRef[];
  readonly decision: ReleaseTrainDecision;
  readonly reason: string;
  readonly determinism_hash: string;
}

/**
 * Builds a release train plan and evaluates required gate coverage.
 */
export function buildReleaseTrainPlan(input: ReleaseTrainPlanInput): ReleaseTrainPlan {
  const plan = normalizeReleaseTrainPlan(input);
  const report = validateReleaseTrainPlan(plan);
  if (!report.ok) {
    throw new OperationsContractError("Release train plan failed validation.", report.issues);
  }
  return plan;
}

export function normalizeReleaseTrainPlan(input: ReleaseTrainPlanInput): ReleaseTrainPlan {
  const requiredGateRefs = requiredGatesForReleaseType(input.release_type);
  const gateDecisionMap = new Map(input.gate_decisions.map((decision) => [decision.gate_ref, decision]));
  const missingGateRefs = requiredGateRefs.filter((gateRef) => !gateDecisionMap.has(gateRef));
  const decision = deriveReleaseTrainDecision(requiredGateRefs, input.gate_decisions, missingGateRefs);
  const base = {
    schema_version: RELEASE_TRAIN_PLANNER_SCHEMA_VERSION,
    release_plan_ref: input.release_plan_ref,
    release_type: input.release_type,
    milestone_window: freezeOperationsArray([...new Set(input.milestone_window)]),
    required_gate_refs: requiredGateRefs,
    candidate_artifact_refs: uniqueOperationsRefs(input.candidate_artifact_refs),
    gate_decisions: freezeOperationsArray(input.gate_decisions),
    known_limitation_refs: uniqueOperationsRefs(input.known_limitation_refs ?? []),
    missing_gate_refs: freezeOperationsArray(missingGateRefs),
    decision,
    reason: releaseReason(decision, missingGateRefs.length, input.gate_decisions.filter((gate) => gate.status === "red").length),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateReleaseTrainPlan(plan: ReleaseTrainPlan): OperationsValidationReport {
  const issues: ValidationIssue[] = [];
  validateOperationsRef(plan.release_plan_ref, "$.release_plan_ref", issues);
  validateOperationsNonEmptyArray(plan.milestone_window, "$.milestone_window", "ReleaseMilestoneWindowMissing", issues);
  validateOperationsNonEmptyArray(plan.required_gate_refs, "$.required_gate_refs", "ReleaseRequiredGatesMissing", issues);
  validateOperationsNonEmptyArray(plan.candidate_artifact_refs, "$.candidate_artifact_refs", "ReleaseArtifactsMissing", issues);
  validateOperationsRefs(plan.candidate_artifact_refs, "$.candidate_artifact_refs", issues);
  validateOperationsRefs(plan.known_limitation_refs, "$.known_limitation_refs", issues);
  validateOperationsText(plan.reason, "$.reason", true, issues);
  if (plan.missing_gate_refs.length > 0 && plan.decision !== "blocked") {
    issues.push(operationsIssue("error", "ReleaseMissingGateNotBlocked", "$.decision", "Missing required gates must block the release train.", "Set decision to blocked or attach gate decisions."));
  }
  if (plan.gate_decisions.some((gate) => gate.status === "red") && plan.decision !== "blocked") {
    issues.push(operationsIssue("error", "ReleaseRedGateNotBlocked", "$.decision", "Red gate decisions must block the release train.", "Resolve the gate or keep release blocked."));
  }
  return buildOperationsValidationReport(makeOperationsRef("release_train_plan_report", plan.release_plan_ref), issues, operationsRouteForIssues(issues));
}

export function requiredGatesForReleaseType(releaseType: ReleaseType): readonly DependencyGateRef[] {
  const gates: Readonly<Record<ReleaseType, readonly DependencyGateRef[]>> = {
    architecture_draft: ["G1"],
    foundation_prototype: ["G1", "G2", "G3", "G4"],
    cognitive_slice: ["G1", "G2", "G3", "G4"],
    verification_demo: ["G1", "G2", "G3", "G4", "G5"],
    recovery_demo: ["G1", "G2", "G3", "G4", "G5", "G7"],
    full_feature_demo: ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9"],
    release_candidate: ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G10"],
  };
  return freezeOperationsArray(gates[releaseType]);
}

function deriveReleaseTrainDecision(requiredGateRefs: readonly DependencyGateRef[], decisions: readonly GateReadinessDecision[], missingGateRefs: readonly DependencyGateRef[]): ReleaseTrainDecision {
  const relevant = decisions.filter((decision) => requiredGateRefs.includes(decision.gate_ref));
  if (missingGateRefs.length > 0 || relevant.some((decision) => decision.status === "red")) {
    return "blocked";
  }
  if (relevant.some((decision) => decision.status === "amber" || decision.status === "not_evaluated")) {
    return "conditional";
  }
  return "ready";
}

function releaseReason(decision: ReleaseTrainDecision, missingGateCount: number, redGateCount: number): string {
  if (decision === "ready") {
    return "All required release gates are green and candidate artifacts are recorded.";
  }
  if (decision === "conditional") {
    return "One or more release gates require review before milestone exit.";
  }
  return `Release train is blocked by ${missingGateCount} missing gate decisions and ${redGateCount} red gate decisions.`;
}

export const RELEASE_TRAIN_PLANNER_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: RELEASE_TRAIN_PLANNER_SCHEMA_VERSION,
  blueprint: OPERATIONS_BLUEPRINT_REF,
  sections: freezeOperationsArray(["21.3", "21.6", "21.7", "21.8", "21.11", "21.15"]),
  component: "ReleaseTrainPlanner",
});
