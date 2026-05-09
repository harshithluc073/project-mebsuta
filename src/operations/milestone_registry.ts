/**
 * Project operations milestone registry.
 *
 * Blueprint: `architecture_docs/21_ROADMAP_WBS_DELIVERY_AND_PROJECT_OPERATIONS.md`
 * sections 21.2, 21.3, 21.6, 21.11, 21.14, and 21.15.
 *
 * This module turns the M0-M9 roadmap into typed data contracts and
 * deterministic validation helpers that downstream operations modules can use
 * without relying on ad hoc project-management text.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity } from "../simulation/world_manifest";

export const OPERATIONS_BLUEPRINT_REF = "architecture_docs/21_ROADMAP_WBS_DELIVERY_AND_PROJECT_OPERATIONS.md" as const;
export const MILESTONE_REGISTRY_SCHEMA_VERSION = "mebsuta.operations.milestone_registry.v1" as const;

export type OperationsRoute = "continue" | "repair" | "review" | "release_block";
export type MilestoneRef = "M0" | "M1" | "M2" | "M3" | "M4" | "M5" | "M6" | "M7" | "M8" | "M9";
export type MilestoneStatus = "planned" | "active" | "complete" | "blocked" | "deferred";
export type DeliveryPhaseRef = "phase_a" | "phase_b" | "phase_c" | "phase_d" | "phase_e" | "phase_f";

export interface OperationsValidationReport {
  readonly report_ref: Ref;
  readonly ok: boolean;
  readonly issue_count: number;
  readonly error_count: number;
  readonly warning_count: number;
  readonly recommended_route: OperationsRoute;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface DefinitionOfDoneCriterion {
  readonly criterion_ref: Ref;
  readonly description: string;
  readonly required: boolean;
}

export interface MilestoneDefinitionInput {
  readonly milestone_ref: MilestoneRef;
  readonly milestone_name: string;
  readonly primary_goal: string;
  readonly exit_theme: string;
  readonly phase_ref: DeliveryPhaseRef;
  readonly dependency_refs: readonly MilestoneRef[];
  readonly exit_criteria: readonly DefinitionOfDoneCriterion[];
  readonly status?: MilestoneStatus;
}

export interface MilestoneDefinition {
  readonly schema_version: typeof MILESTONE_REGISTRY_SCHEMA_VERSION;
  readonly milestone_ref: MilestoneRef;
  readonly milestone_name: string;
  readonly primary_goal: string;
  readonly exit_theme: string;
  readonly phase_ref: DeliveryPhaseRef;
  readonly dependency_refs: readonly MilestoneRef[];
  readonly exit_criteria: readonly DefinitionOfDoneCriterion[];
  readonly status: MilestoneStatus;
  readonly topological_order: number;
  readonly determinism_hash: string;
}

/**
 * Builds an immutable milestone definition and rejects malformed roadmap data.
 */
export function buildMilestoneDefinition(input: MilestoneDefinitionInput): MilestoneDefinition {
  const milestone = normalizeMilestoneDefinition(input);
  const report = validateMilestoneDefinition(milestone);
  if (!report.ok) {
    throw new OperationsContractError("Milestone definition failed validation.", report.issues);
  }
  return milestone;
}

export function normalizeMilestoneDefinition(input: MilestoneDefinitionInput): MilestoneDefinition {
  const base = {
    schema_version: MILESTONE_REGISTRY_SCHEMA_VERSION,
    milestone_ref: input.milestone_ref,
    milestone_name: normalizeOperationsText(input.milestone_name, 180),
    primary_goal: normalizeOperationsText(input.primary_goal),
    exit_theme: normalizeOperationsText(input.exit_theme),
    phase_ref: input.phase_ref,
    dependency_refs: freezeOperationsArray([...new Set(input.dependency_refs)]),
    exit_criteria: freezeOperationsArray(input.exit_criteria.map(normalizeDefinitionOfDoneCriterion)),
    status: input.status ?? "planned",
    topological_order: milestoneOrder(input.milestone_ref),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateMilestoneDefinition(milestone: MilestoneDefinition): OperationsValidationReport {
  const issues: ValidationIssue[] = [];
  validateOperationsRef(milestone.milestone_ref, "$.milestone_ref", issues);
  validateOperationsText(milestone.milestone_name, "$.milestone_name", true, issues);
  validateOperationsText(milestone.primary_goal, "$.primary_goal", true, issues);
  validateOperationsText(milestone.exit_theme, "$.exit_theme", true, issues);
  validateOperationsNonEmptyArray(milestone.exit_criteria, "$.exit_criteria", "MilestoneExitCriteriaMissing", issues);
  for (const [index, criterion] of milestone.exit_criteria.entries()) {
    validateDefinitionOfDoneCriterion(criterion, `$.exit_criteria[${index}]`, issues);
  }
  for (const dependency of milestone.dependency_refs) {
    if (milestoneOrder(dependency) >= milestone.topological_order) {
      issues.push(operationsIssue("error", "MilestoneDependencyOrderInvalid", "$.dependency_refs", "Milestone dependencies must come earlier in the roadmap graph.", "Move the dependency to an earlier milestone or revise the graph."));
    }
  }
  if (milestone.status === "complete" && milestone.exit_criteria.some((criterion) => criterion.required === false)) {
    issues.push(operationsIssue("warning", "CompleteMilestoneOptionalCriterionReview", "$.exit_criteria", "Complete milestones should keep optional criteria explicit.", "Confirm optional criteria are informational."));
  }
  return buildOperationsValidationReport(makeOperationsRef("milestone_definition_report", milestone.milestone_ref), issues, operationsRouteForIssues(issues));
}

export function buildMilestoneRegistry(inputs: readonly MilestoneDefinitionInput[]): readonly MilestoneDefinition[] {
  const registry = freezeOperationsArray(inputs.map(buildMilestoneDefinition).sort((left, right) => left.topological_order - right.topological_order));
  const refs = new Set<MilestoneRef>();
  for (const milestone of registry) {
    if (refs.has(milestone.milestone_ref)) {
      throw new OperationsContractError("Milestone registry contains duplicate refs.", [
        operationsIssue("error", "MilestoneDuplicate", "$.milestones", "Milestone refs must be unique.", "Remove or rename the duplicate milestone."),
      ]);
    }
    refs.add(milestone.milestone_ref);
  }
  return registry;
}

export function defaultMilestoneRegistry(): readonly MilestoneDefinition[] {
  return buildMilestoneRegistry([
    milestoneInput("M0", "Architecture Baseline", "Complete documentation, contracts, and traceability plan.", "Buildable blueprint.", "phase_a", []),
    milestoneInput("M1", "Simulation And Sensor Foundation", "Stable physics world and embodied sensor bus.", "Agent can perceive without god-mode.", "phase_b", ["M0"]),
    milestoneInput("M2", "Deterministic Control Foundation", "IK, trajectory, PD execution, and telemetry.", "Agent can move safely.", "phase_b", ["M1"]),
    milestoneInput("M3", "Gemini Cognitive Planning Slice", "Prompt-safe Gemini planning for simple tasks.", "Agent can reason from embodied observations.", "phase_c", ["M1"]),
    milestoneInput("M4", "Verification And Certificates", "Multi-view success, failure, and ambiguity certificates.", "Agent can know when task is done.", "phase_c", ["M2", "M3"]),
    milestoneInput("M5", "Memory And Object Permanence", "Verified RAG spatial memory.", "Agent can remember safely.", "phase_d", ["M4"]),
    milestoneInput("M6", "Oops Loop Recovery", "Deterministic correction after verified failure.", "Agent can recover from mistakes.", "phase_d", ["M2", "M4", "M5"]),
    milestoneInput("M7", "Acoustic And TTS Embodiment", "Audio reasoning and transparent monologue.", "Agent can hear and explain itself.", "phase_e", ["M1", "M3"]),
    milestoneInput("M8", "Tool Use And Complex Spatial Tasks", "Tool-assisted reach and multi-object arrangements.", "Agent can perform advanced tasks.", "phase_e", ["M6", "M7"]),
    milestoneInput("M9", "Hardening, Chaos, And Release Candidate", "Full QA, safety, replay, and benchmark readiness.", "Demo or research release candidate.", "phase_f", ["M4", "M5", "M8"]),
  ]);
}

export class OperationsContractError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "OperationsContractError";
    this.issues = freezeOperationsArray(issues);
  }
}

export function buildOperationsValidationReport(reportRef: Ref, issues: readonly ValidationIssue[], recommendedRoute: OperationsRoute): OperationsValidationReport {
  const frozenIssues = freezeOperationsArray(issues);
  const errorCount = frozenIssues.filter((issue) => issue.severity === "error").length;
  const warningCount = frozenIssues.length - errorCount;
  const base = {
    report_ref: reportRef,
    ok: errorCount === 0,
    issue_count: frozenIssues.length,
    error_count: errorCount,
    warning_count: warningCount,
    recommended_route: recommendedRoute,
    issues: frozenIssues,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function operationsRouteForIssues(issues: readonly ValidationIssue[]): OperationsRoute {
  if (issues.some((issue) => issue.severity === "error" && /Release|Dependency|Gate|Critical|NoGo/u.test(issue.code))) {
    return "release_block";
  }
  if (issues.some((issue) => issue.severity === "error")) {
    return "repair";
  }
  if (issues.some((issue) => issue.severity === "warning")) {
    return "review";
  }
  return "continue";
}

export function operationsIssue(severity: ValidationSeverity, code: string, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

export function validateOperationsRef(ref: Ref | undefined, path: string, issues: ValidationIssue[]): void {
  if (ref === undefined || ref.trim().length === 0 || /\s/u.test(ref)) {
    issues.push(operationsIssue("error", "OperationsRefInvalid", path, "Reference must be present, non-empty, and whitespace-free.", "Use a stable opaque operations ref."));
  }
}

export function validateOperationsRefs(refs: readonly Ref[], path: string, issues: ValidationIssue[]): void {
  for (const [index, ref] of refs.entries()) {
    validateOperationsRef(ref, `${path}[${index}]`, issues);
  }
}

export function validateOperationsText(value: string, path: string, required: boolean, issues: ValidationIssue[]): void {
  if (required && value.trim().length === 0) {
    issues.push(operationsIssue("error", "OperationsTextRequired", path, "Required operations text is empty.", "Provide concise delivery-governance text."));
  }
  if (/reward\s*update|policy\s*gradient|hidden\s*truth\s*to\s*runtime|ignore\s*safety/iu.test(value)) {
    issues.push(operationsIssue("error", "OperationsTextForbidden", path, "Operations text contains a forbidden project-governance phrase.", "Use no-RL and simulation-blind governance language."));
  }
}

export function validateOperationsNonEmptyArray<T>(items: readonly T[], path: string, code: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(items) || items.length === 0) {
    issues.push(operationsIssue("error", code, path, "Array must contain at least one item.", "Attach the required operations entries."));
  }
}

export function validateOperationsRatio(value: number, path: string, issues: ValidationIssue[]): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    issues.push(operationsIssue("error", "OperationsRatioInvalid", path, "Ratio must be finite and within [0, 1].", "Clamp or recompute the metric."));
  }
}

export function normalizeOperationsText(value: string, maxChars = 1000): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, maxChars);
}

export function makeOperationsRef(...parts: readonly (string | number | undefined)[]): Ref {
  const normalized = parts
    .filter((part): part is string | number => part !== undefined)
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return normalized.length > 0 ? normalized : "operations:empty";
}

export function uniqueOperationsRefs(items: readonly (Ref | undefined)[]): readonly Ref[] {
  return freezeOperationsArray([...new Set(items.filter((item): item is Ref => item !== undefined && item.trim().length > 0))]);
}

export function uniqueOperationsStrings(items: readonly string[]): readonly string[] {
  return freezeOperationsArray([...new Set(items.map((item) => normalizeOperationsText(item)).filter((item) => item.length > 0))]);
}

export function freezeOperationsArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

export function milestoneOrder(ref: MilestoneRef): number {
  return Number(ref.slice(1));
}

function milestoneInput(
  milestoneRef: MilestoneRef,
  milestoneName: string,
  primaryGoal: string,
  exitTheme: string,
  phaseRef: DeliveryPhaseRef,
  dependencyRefs: readonly MilestoneRef[],
): MilestoneDefinitionInput {
  return {
    milestone_ref: milestoneRef,
    milestone_name: milestoneName,
    primary_goal: primaryGoal,
    exit_theme: exitTheme,
    phase_ref: phaseRef,
    dependency_refs: dependencyRefs,
    exit_criteria: [
      { criterion_ref: makeOperationsRef(milestoneRef, "scope_complete"), description: "Planned scope is complete.", required: true },
      { criterion_ref: makeOperationsRef(milestoneRef, "safety_gates_green"), description: "Required safety gates are green or reviewed.", required: true },
      { criterion_ref: makeOperationsRef(milestoneRef, "traceability_current"), description: "Traceability is updated for milestone artifacts.", required: true },
    ],
  };
}

function normalizeDefinitionOfDoneCriterion(criterion: DefinitionOfDoneCriterion): DefinitionOfDoneCriterion {
  return Object.freeze({
    criterion_ref: criterion.criterion_ref,
    description: normalizeOperationsText(criterion.description, 500),
    required: criterion.required,
  });
}

function validateDefinitionOfDoneCriterion(criterion: DefinitionOfDoneCriterion, path: string, issues: ValidationIssue[]): void {
  validateOperationsRef(criterion.criterion_ref, `${path}.criterion_ref`, issues);
  validateOperationsText(criterion.description, `${path}.description`, true, issues);
}

export const MILESTONE_REGISTRY_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: MILESTONE_REGISTRY_SCHEMA_VERSION,
  blueprint: OPERATIONS_BLUEPRINT_REF,
  sections: freezeOperationsArray(["21.2", "21.3", "21.6", "21.11", "21.14", "21.15"]),
  component: "MilestoneRegistry",
});
