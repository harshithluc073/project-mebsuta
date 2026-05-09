/**
 * Scenario benchmark specification contract.
 *
 * Blueprint: `architecture_docs/20_QA_TESTING_CHAOS_AND_BENCHMARK_ARCHITECTURE.md`
 * sections 20.4.2, 20.5.2, 20.8, 20.9, 20.12, 20.17, 20.18, and 20.22.
 *
 * A scenario benchmark binds fixed or swept seeds, task goals, disturbances,
 * offline scoring metrics, and runtime certificate requirements without
 * exposing simulator-only data to runtime cognition.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  QA_BLUEPRINT_REF,
  QaContractError,
  buildQaValidationReport,
  freezeQaArray,
  makeQaRef,
  normalizeQaText,
  qaIssue,
  qaRouteForIssues,
  uniqueQaRefs,
  uniqueQaStrings,
  validateFiniteQaNumber,
  validateNonEmptyQaArray,
  validateOptionalQaRef,
  validateQaRef,
  validateQaRefs,
  validateQaText,
} from "./test_case_spec";
import type { QaValidationReport } from "./test_case_spec";

export const SCENARIO_BENCHMARK_SPEC_SCHEMA_VERSION = "mebsuta.qa.scenario_benchmark_spec.v1" as const;

export type RandomSeedPolicy = "fixed" | "randomized" | "sweep" | "adversarial";
export type BenchmarkEmbodimentProfile = "quadruped" | "humanoid" | "dual_embodiment";
export type OfflineMetricClass = "task_completion" | "spatial_precision" | "safety" | "robustness" | "efficiency" | "transparency" | "boundary_integrity" | "memory_quality" | "audio_routing" | "tool_use";
export type ScoringPolicyKind = "weighted_sum" | "critical_gate_first" | "threshold_band" | "regression_delta";

export interface ScenarioTaskGoal {
  readonly task_goal_ref: Ref;
  readonly goal_summary: string;
  readonly target_refs: readonly Ref[];
  readonly ordered_step_index: number;
}

export interface ScenarioSuccessConstraint {
  readonly constraint_ref: Ref;
  readonly constraint_kind: "spatial" | "semantic" | "safety" | "memory" | "audio" | "tool" | "verification";
  readonly description: string;
  readonly tolerance_m?: number;
  readonly tolerance_rad?: number;
  readonly required_certificate_ref?: Ref;
}

export interface ScenarioDisturbanceProfile {
  readonly disturbance_profile_ref: Ref;
  readonly categories: readonly ("model_api" | "sensor" | "physics" | "control" | "memory" | "safety" | "event_bus" | "observability")[];
  readonly description: string;
  readonly expected_runtime_route: string;
}

export interface RuntimeCertificateRequirement {
  readonly requirement_ref: Ref;
  readonly certificate_type: "verification_success" | "verification_failure" | "ambiguity" | "safe_hold" | "oops_recovery";
  readonly required_evidence_refs: readonly Ref[];
  readonly forbids_memory_only_evidence: boolean;
}

export interface ScoringPolicy {
  readonly scoring_policy_ref: Ref;
  readonly scoring_kind: ScoringPolicyKind;
  readonly metric_weights: Readonly<Record<OfflineMetricClass, number>>;
  readonly critical_violation_penalty: number;
  readonly release_threshold: number;
}

export interface ScenarioBenchmarkSpecInput {
  readonly scenario_benchmark_ref: Ref;
  readonly scenario_name: string;
  readonly scenario_version: string;
  readonly random_seed_policy: RandomSeedPolicy;
  readonly world_setup_ref: Ref;
  readonly embodiment_profile_refs: readonly BenchmarkEmbodimentProfile[];
  readonly task_sequence: readonly ScenarioTaskGoal[];
  readonly success_constraints: readonly ScenarioSuccessConstraint[];
  readonly disturbance_profile?: ScenarioDisturbanceProfile;
  readonly offline_truth_metrics: readonly OfflineMetricClass[];
  readonly runtime_certificate_requirements: readonly RuntimeCertificateRequirement[];
  readonly scoring_policy: ScoringPolicy;
  readonly golden_baseline_ref?: Ref;
}

export interface ScenarioBenchmarkSpec {
  readonly schema_version: typeof SCENARIO_BENCHMARK_SPEC_SCHEMA_VERSION;
  readonly scenario_benchmark_ref: Ref;
  readonly scenario_name: string;
  readonly scenario_version: string;
  readonly random_seed_policy: RandomSeedPolicy;
  readonly world_setup_ref: Ref;
  readonly embodiment_profile_refs: readonly BenchmarkEmbodimentProfile[];
  readonly task_sequence: readonly ScenarioTaskGoal[];
  readonly success_constraints: readonly ScenarioSuccessConstraint[];
  readonly disturbance_profile?: ScenarioDisturbanceProfile;
  readonly offline_truth_metrics: readonly OfflineMetricClass[];
  readonly runtime_certificate_requirements: readonly RuntimeCertificateRequirement[];
  readonly scoring_policy: ScoringPolicy;
  readonly golden_baseline_ref?: Ref;
  readonly determinism_hash: string;
}

/**
 * Builds an immutable benchmark spec and validates its scoring contract.
 */
export function buildScenarioBenchmarkSpec(input: ScenarioBenchmarkSpecInput): ScenarioBenchmarkSpec {
  const spec = normalizeScenarioBenchmarkSpec(input);
  const report = validateScenarioBenchmarkSpec(spec);
  if (!report.ok) {
    throw new QaContractError("Scenario benchmark spec failed validation.", report.issues);
  }
  return spec;
}

export function normalizeScenarioBenchmarkSpec(input: ScenarioBenchmarkSpecInput): ScenarioBenchmarkSpec {
  const base = {
    schema_version: SCENARIO_BENCHMARK_SPEC_SCHEMA_VERSION,
    scenario_benchmark_ref: input.scenario_benchmark_ref,
    scenario_name: normalizeQaText(input.scenario_name, 180),
    scenario_version: normalizeQaText(input.scenario_version, 80),
    random_seed_policy: input.random_seed_policy,
    world_setup_ref: input.world_setup_ref,
    embodiment_profile_refs: freezeQaArray([...new Set(input.embodiment_profile_refs)]),
    task_sequence: freezeQaArray(input.task_sequence.map(normalizeTaskGoal).sort((a, b) => a.ordered_step_index - b.ordered_step_index)),
    success_constraints: freezeQaArray(input.success_constraints.map(normalizeConstraint)),
    disturbance_profile: input.disturbance_profile === undefined ? undefined : normalizeDisturbanceProfile(input.disturbance_profile),
    offline_truth_metrics: freezeQaArray([...new Set(input.offline_truth_metrics)]),
    runtime_certificate_requirements: freezeQaArray(input.runtime_certificate_requirements.map(normalizeCertificateRequirement)),
    scoring_policy: normalizeScoringPolicy(input.scoring_policy),
    golden_baseline_ref: input.golden_baseline_ref,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateScenarioBenchmarkSpec(spec: ScenarioBenchmarkSpec): QaValidationReport {
  const issues: ValidationIssue[] = [];
  validateQaRef(spec.scenario_benchmark_ref, "$.scenario_benchmark_ref", issues);
  validateQaText(spec.scenario_name, "$.scenario_name", true, issues);
  validateQaText(spec.scenario_version, "$.scenario_version", true, issues);
  validateQaRef(spec.world_setup_ref, "$.world_setup_ref", issues);
  validateOptionalQaRef(spec.golden_baseline_ref, "$.golden_baseline_ref", issues);
  validateNonEmptyQaArray(spec.embodiment_profile_refs, "$.embodiment_profile_refs", "EmbodimentProfilesMissing", issues);
  validateNonEmptyQaArray(spec.task_sequence, "$.task_sequence", "TaskSequenceMissing", issues);
  validateNonEmptyQaArray(spec.success_constraints, "$.success_constraints", "SuccessConstraintsMissing", issues);
  validateNonEmptyQaArray(spec.offline_truth_metrics, "$.offline_truth_metrics", "OfflineMetricsMissing", issues);
  validateNonEmptyQaArray(spec.runtime_certificate_requirements, "$.runtime_certificate_requirements", "RuntimeCertificateRequirementsMissing", issues);
  validateTaskOrdering(spec.task_sequence, issues);
  spec.task_sequence.forEach((goal, index) => validateTaskGoal(goal, `$.task_sequence[${index}]`, issues));
  spec.success_constraints.forEach((constraint, index) => validateConstraint(constraint, `$.success_constraints[${index}]`, issues));
  spec.runtime_certificate_requirements.forEach((requirement, index) => validateCertificateRequirement(requirement, `$.runtime_certificate_requirements[${index}]`, issues));
  validateScoringPolicy(spec.scoring_policy, "$.scoring_policy", issues);
  if (spec.disturbance_profile !== undefined) {
    validateDisturbanceProfile(spec.disturbance_profile, "$.disturbance_profile", issues);
  }
  if (spec.random_seed_policy !== "fixed" && spec.golden_baseline_ref === undefined) {
    issues.push(qaIssue("warning", "NonFixedSeedWithoutBaseline", "$.golden_baseline_ref", "Non-fixed seed benchmarks should bind to a golden baseline for drift review.", "Attach a golden baseline reference."));
  }
  return buildQaValidationReport(makeQaRef("scenario_benchmark_spec_report", spec.scenario_benchmark_ref), issues, qaRouteForIssues(issues));
}

export function scoringWeightTotal(policy: ScoringPolicy): number {
  return Object.values(policy.metric_weights).reduce((sum, value) => sum + value, 0);
}

function normalizeTaskGoal(goal: ScenarioTaskGoal): ScenarioTaskGoal {
  return Object.freeze({
    task_goal_ref: goal.task_goal_ref,
    goal_summary: normalizeQaText(goal.goal_summary),
    target_refs: uniqueQaRefs(goal.target_refs),
    ordered_step_index: goal.ordered_step_index,
  });
}

function normalizeConstraint(constraint: ScenarioSuccessConstraint): ScenarioSuccessConstraint {
  return Object.freeze({
    constraint_ref: constraint.constraint_ref,
    constraint_kind: constraint.constraint_kind,
    description: normalizeQaText(constraint.description),
    tolerance_m: constraint.tolerance_m,
    tolerance_rad: constraint.tolerance_rad,
    required_certificate_ref: constraint.required_certificate_ref,
  });
}

function normalizeDisturbanceProfile(profile: ScenarioDisturbanceProfile): ScenarioDisturbanceProfile {
  return Object.freeze({
    disturbance_profile_ref: profile.disturbance_profile_ref,
    categories: freezeQaArray([...new Set(profile.categories)]),
    description: normalizeQaText(profile.description),
    expected_runtime_route: normalizeQaText(profile.expected_runtime_route, 240),
  });
}

function normalizeCertificateRequirement(requirement: RuntimeCertificateRequirement): RuntimeCertificateRequirement {
  return Object.freeze({
    requirement_ref: requirement.requirement_ref,
    certificate_type: requirement.certificate_type,
    required_evidence_refs: uniqueQaRefs(requirement.required_evidence_refs),
    forbids_memory_only_evidence: requirement.forbids_memory_only_evidence,
  });
}

function normalizeScoringPolicy(policy: ScoringPolicy): ScoringPolicy {
  return Object.freeze({
    scoring_policy_ref: policy.scoring_policy_ref,
    scoring_kind: policy.scoring_kind,
    metric_weights: Object.freeze({ ...policy.metric_weights }),
    critical_violation_penalty: policy.critical_violation_penalty,
    release_threshold: policy.release_threshold,
  });
}

function validateTaskGoal(goal: ScenarioTaskGoal, path: string, issues: ValidationIssue[]): void {
  validateQaRef(goal.task_goal_ref, `${path}.task_goal_ref`, issues);
  validateQaText(goal.goal_summary, `${path}.goal_summary`, true, issues);
  validateQaRefs(goal.target_refs, `${path}.target_refs`, issues);
  validateNonEmptyQaArray(goal.target_refs, `${path}.target_refs`, "TaskGoalTargetsMissing", issues);
  if (!Number.isInteger(goal.ordered_step_index) || goal.ordered_step_index < 0) {
    issues.push(qaIssue("error", "TaskGoalOrderInvalid", `${path}.ordered_step_index`, "Task order index must be a nonnegative integer.", "Assign deterministic task ordering from zero upward."));
  }
}

function validateConstraint(constraint: ScenarioSuccessConstraint, path: string, issues: ValidationIssue[]): void {
  validateQaRef(constraint.constraint_ref, `${path}.constraint_ref`, issues);
  validateQaText(constraint.description, `${path}.description`, true, issues);
  validateOptionalQaRef(constraint.required_certificate_ref, `${path}.required_certificate_ref`, issues);
  if (constraint.tolerance_m !== undefined) {
    validateFiniteQaNumber(constraint.tolerance_m, `${path}.tolerance_m`, 0, 10, issues);
  }
  if (constraint.tolerance_rad !== undefined) {
    validateFiniteQaNumber(constraint.tolerance_rad, `${path}.tolerance_rad`, 0, Math.PI * 2, issues);
  }
}

function validateDisturbanceProfile(profile: ScenarioDisturbanceProfile, path: string, issues: ValidationIssue[]): void {
  validateQaRef(profile.disturbance_profile_ref, `${path}.disturbance_profile_ref`, issues);
  validateNonEmptyQaArray(profile.categories, `${path}.categories`, "DisturbanceCategoriesMissing", issues);
  validateQaText(profile.description, `${path}.description`, true, issues);
  validateQaText(profile.expected_runtime_route, `${path}.expected_runtime_route`, true, issues);
}

function validateCertificateRequirement(requirement: RuntimeCertificateRequirement, path: string, issues: ValidationIssue[]): void {
  validateQaRef(requirement.requirement_ref, `${path}.requirement_ref`, issues);
  validateQaRefs(requirement.required_evidence_refs, `${path}.required_evidence_refs`, issues);
  validateNonEmptyQaArray(requirement.required_evidence_refs, `${path}.required_evidence_refs`, "CertificateEvidenceMissing", issues);
  if (!requirement.forbids_memory_only_evidence && requirement.certificate_type === "verification_success") {
    issues.push(qaIssue("error", "MemoryOnlySuccessAllowed", `${path}.forbids_memory_only_evidence`, "Verification success cannot allow memory-only evidence.", "Require fresh runtime evidence for success certificates."));
  }
}

function validateScoringPolicy(policy: ScoringPolicy, path: string, issues: ValidationIssue[]): void {
  validateQaRef(policy.scoring_policy_ref, `${path}.scoring_policy_ref`, issues);
  const total = scoringWeightTotal(policy);
  if (Math.abs(total - 1) > 1e-9) {
    issues.push(qaIssue("error", "ScoringWeightsNotNormalized", `${path}.metric_weights`, "Scoring weights must sum to exactly 1 within deterministic tolerance.", "Normalize metric weights before release scoring."));
  }
  for (const [metric, value] of Object.entries(policy.metric_weights)) {
    validateFiniteQaNumber(value, `${path}.metric_weights.${metric}`, 0, 1, issues);
  }
  validateFiniteQaNumber(policy.critical_violation_penalty, `${path}.critical_violation_penalty`, 0, Number.POSITIVE_INFINITY, issues);
  validateFiniteQaNumber(policy.release_threshold, `${path}.release_threshold`, 0, 1, issues);
}

function validateTaskOrdering(goals: readonly ScenarioTaskGoal[], issues: ValidationIssue[]): void {
  const seen = new Set<number>();
  for (const goal of goals) {
    if (seen.has(goal.ordered_step_index)) {
      issues.push(qaIssue("error", "TaskOrderDuplicate", "$.task_sequence", "Task order indexes must be unique.", "Assign a unique ordered_step_index to each task goal."));
    }
    seen.add(goal.ordered_step_index);
  }
}

export const SCENARIO_BENCHMARK_SPEC_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: SCENARIO_BENCHMARK_SPEC_SCHEMA_VERSION,
  blueprint: QA_BLUEPRINT_REF,
  sections: freezeQaArray(["20.4.2", "20.5.2", "20.8", "20.9", "20.12", "20.17", "20.18", "20.22"]),
  component: "ScenarioBenchmarkSpec",
});
