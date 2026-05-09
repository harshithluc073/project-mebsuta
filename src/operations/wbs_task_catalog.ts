/**
 * Work breakdown structure task catalog.
 *
 * Blueprint: `architecture_docs/21_ROADMAP_WBS_DELIVERY_AND_PROJECT_OPERATIONS.md`
 * sections 21.5, 21.6, 21.7, 21.11, 21.14, and 21.15.
 *
 * The catalog converts WBS work packages and tasks into deterministic data so
 * planning, gate review, and health reporting can reason over dependencies.
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
import type { WorkstreamRef } from "./workstream_registry";

export const WBS_TASK_CATALOG_SCHEMA_VERSION = "mebsuta.operations.wbs_task_catalog.v1" as const;

export type WbsPackageRef =
  | "1.0"
  | "2.0"
  | "3.0"
  | "4.0"
  | "5.0"
  | "6.0"
  | "7.0"
  | "8.0"
  | "9.0"
  | "10.0"
  | "11.0"
  | "12.0"
  | "13.0"
  | "14.0"
  | "15.0"
  | "16.0";

export type WbsTaskStatus = "planned" | "active" | "complete" | "blocked" | "deferred";

export interface WbsTaskInput {
  readonly wbs_task_ref: Ref;
  readonly package_ref: WbsPackageRef;
  readonly task_title: string;
  readonly owning_workstream_ref: WorkstreamRef;
  readonly milestone_refs: readonly MilestoneRef[];
  readonly dependency_refs: readonly Ref[];
  readonly expected_challenge: string;
  readonly acceptance_criteria: readonly string[];
  readonly status?: WbsTaskStatus;
}

export interface WbsTask {
  readonly schema_version: typeof WBS_TASK_CATALOG_SCHEMA_VERSION;
  readonly wbs_task_ref: Ref;
  readonly package_ref: WbsPackageRef;
  readonly task_title: string;
  readonly owning_workstream_ref: WorkstreamRef;
  readonly milestone_refs: readonly MilestoneRef[];
  readonly dependency_refs: readonly Ref[];
  readonly expected_challenge: string;
  readonly acceptance_criteria: readonly string[];
  readonly status: WbsTaskStatus;
  readonly determinism_hash: string;
}

export interface WbsTaskCatalog {
  readonly schema_version: typeof WBS_TASK_CATALOG_SCHEMA_VERSION;
  readonly catalog_ref: Ref;
  readonly tasks: readonly WbsTask[];
  readonly package_count: number;
  readonly task_count: number;
  readonly determinism_hash: string;
}

/**
 * Builds a WBS task and validates milestone, owner, and acceptance data.
 */
export function buildWbsTask(input: WbsTaskInput): WbsTask {
  const task = normalizeWbsTask(input);
  const report = validateWbsTask(task);
  if (!report.ok) {
    throw new OperationsContractError("WBS task failed validation.", report.issues);
  }
  return task;
}

export function normalizeWbsTask(input: WbsTaskInput): WbsTask {
  const base = {
    schema_version: WBS_TASK_CATALOG_SCHEMA_VERSION,
    wbs_task_ref: input.wbs_task_ref,
    package_ref: input.package_ref,
    task_title: normalizeOperationsText(input.task_title, 220),
    owning_workstream_ref: input.owning_workstream_ref,
    milestone_refs: freezeOperationsArray([...new Set(input.milestone_refs)]),
    dependency_refs: uniqueOperationsRefs(input.dependency_refs),
    expected_challenge: normalizeOperationsText(input.expected_challenge),
    acceptance_criteria: freezeOperationsArray([...new Set(input.acceptance_criteria.map((item) => normalizeOperationsText(item, 500)).filter((item) => item.length > 0))]),
    status: input.status ?? "planned",
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateWbsTask(task: WbsTask): OperationsValidationReport {
  const issues: ValidationIssue[] = [];
  validateOperationsRef(task.wbs_task_ref, "$.wbs_task_ref", issues);
  validateOperationsRef(task.owning_workstream_ref, "$.owning_workstream_ref", issues);
  validateOperationsText(task.task_title, "$.task_title", true, issues);
  validateOperationsText(task.expected_challenge, "$.expected_challenge", true, issues);
  validateOperationsNonEmptyArray(task.milestone_refs, "$.milestone_refs", "WbsTaskMilestonesMissing", issues);
  validateOperationsNonEmptyArray(task.acceptance_criteria, "$.acceptance_criteria", "WbsTaskAcceptanceMissing", issues);
  validateOperationsRefs(task.dependency_refs, "$.dependency_refs", issues);
  for (const [index, criterion] of task.acceptance_criteria.entries()) {
    validateOperationsText(criterion, `$.acceptance_criteria[${index}]`, true, issues);
  }
  if (task.dependency_refs.includes(task.wbs_task_ref)) {
    issues.push(operationsIssue("error", "WbsTaskSelfDependency", "$.dependency_refs", "A WBS task cannot depend on itself.", "Remove the self dependency."));
  }
  return buildOperationsValidationReport(makeOperationsRef("wbs_task_report", task.wbs_task_ref), issues, operationsRouteForIssues(issues));
}

export function buildWbsTaskCatalog(catalogRef: Ref, inputs: readonly WbsTaskInput[]): WbsTaskCatalog {
  const tasks = freezeOperationsArray(inputs.map(buildWbsTask).sort((left, right) => left.wbs_task_ref.localeCompare(right.wbs_task_ref)));
  const refs = new Set<Ref>();
  const packages = new Set<WbsPackageRef>();
  for (const task of tasks) {
    if (refs.has(task.wbs_task_ref)) {
      throw new OperationsContractError("WBS task catalog contains duplicate task refs.", [
        operationsIssue("error", "WbsTaskDuplicate", "$.tasks", "WBS task refs must be unique.", "Remove or rename the duplicate task ref."),
      ]);
    }
    refs.add(task.wbs_task_ref);
    packages.add(task.package_ref);
  }
  const base = {
    schema_version: WBS_TASK_CATALOG_SCHEMA_VERSION,
    catalog_ref: catalogRef,
    tasks,
    package_count: packages.size,
    task_count: tasks.length,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function defaultWbsTaskCatalog(): WbsTaskCatalog {
  return buildWbsTaskCatalog(makeOperationsRef("default_wbs_catalog"), [
    task("1.1", "1.0", "Finalize architecture document set", "WS-A", ["M0"], [], "Maintaining detail consistency.", ["Files 00-24 are complete and indexed."]),
    task("1.3", "1.0", "Define artifact envelope governance", "WS-A", ["M0"], ["1.1"], "Cross-service agreement.", ["All artifacts map to envelope fields."]),
    task("2.2", "2.0", "Define world lifecycle contract", "WS-B", ["M1"], ["1.3"], "Replay consistency.", ["Scenario init, step, and reset contracts exist."]),
    task("3.1", "3.0", "Define camera sensor packet contract", "WS-C", ["M1"], ["2.2"], "Timing and calibration consistency.", ["Camera packets include provenance."]),
    task("4.1", "4.0", "Define synchronized multi-view bundle", "WS-E", ["M1", "M4"], ["3.1"], "Time skew handling.", ["Bundle schema is reviewed."]),
    task("5.1", "5.0", "Define model adapter boundary", "WS-F", ["M3"], ["4.1"], "Preview-model isolation.", ["Adapter contract is reviewed."]),
    task("6.1", "6.0", "Define state machine transitions", "WS-G", ["M1"], ["1.3"], "Route ambiguity.", ["Transition table is reviewed."]),
    task("7.1", "7.0", "Define IK solver contract", "WS-H", ["M2"], ["3.1"], "Feasibility and singularity handling.", ["IK response schema includes failure reasons."]),
    task("8.1", "8.0", "Define primitive catalog taxonomy", "WS-I", ["M2", "M8"], ["7.1"], "Avoiding direct motor commands.", ["Primitive taxonomy is versioned."]),
    task("9.1", "9.0", "Define verification certificate schema", "WS-J", ["M4"], ["4.1"], "Avoiding unsupported success.", ["Certificate schema requires evidence refs."]),
    task("10.1", "10.0", "Define Oops intake contract", "WS-K", ["M6"], ["9.1"], "Failure classification quality.", ["Oops intake includes evidence and safety refs."]),
    task("11.1", "11.0", "Define verified memory record", "WS-L", ["M5"], ["9.1"], "Memory as current truth risk.", ["Verified writes require certificates."]),
    task("12.1", "12.0", "Define microphone packet contract", "WS-M", ["M7"], ["3.1"], "Self-noise separation.", ["Audio packets include source labels."]),
    task("13.1", "13.0", "Define monologue event taxonomy", "WS-N", ["M3", "M7"], ["5.1"], "Unsupported certainty language.", ["Monologue events link to evidence refs."]),
    task("14.1", "14.0", "Define safety policy registry", "WS-O", ["M1"], ["1.3"], "Policy conflict resolution.", ["Safety policy priority is deterministic."]),
    task("15.1", "15.0", "Define QA contract suite", "WS-P", ["M0", "M9"], ["1.3"], "Truth-boundary discipline.", ["QA contracts separate runtime and offline truth."]),
    task("16.1", "16.0", "Define operating cadence", "WS-Q", ["M0", "M9"], ["15.1"], "Coordinating many workstreams.", ["Cadence and review inputs are defined."]),
  ]);
}

export function tasksForWorkstream(catalog: WbsTaskCatalog, workstreamRef: WorkstreamRef): readonly WbsTask[] {
  return freezeOperationsArray(catalog.tasks.filter((taskItem) => taskItem.owning_workstream_ref === workstreamRef));
}

export function tasksForMilestone(catalog: WbsTaskCatalog, milestoneRef: MilestoneRef): readonly WbsTask[] {
  return freezeOperationsArray(catalog.tasks.filter((taskItem) => taskItem.milestone_refs.includes(milestoneRef)));
}

function task(
  wbsTaskRef: Ref,
  packageRef: WbsPackageRef,
  taskTitle: string,
  owningWorkstreamRef: WorkstreamRef,
  milestoneRefs: readonly MilestoneRef[],
  dependencyRefs: readonly Ref[],
  expectedChallenge: string,
  acceptanceCriteria: readonly string[],
): WbsTaskInput {
  return {
    wbs_task_ref: wbsTaskRef,
    package_ref: packageRef,
    task_title: taskTitle,
    owning_workstream_ref: owningWorkstreamRef,
    milestone_refs: milestoneRefs,
    dependency_refs: dependencyRefs,
    expected_challenge: expectedChallenge,
    acceptance_criteria: acceptanceCriteria,
  };
}

export const WBS_TASK_CATALOG_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: WBS_TASK_CATALOG_SCHEMA_VERSION,
  blueprint: OPERATIONS_BLUEPRINT_REF,
  sections: freezeOperationsArray(["21.5", "21.6", "21.7", "21.11", "21.14", "21.15"]),
  component: "WbsTaskCatalog",
});
