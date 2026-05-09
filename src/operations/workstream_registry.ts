/**
 * Operations workstream registry.
 *
 * Blueprint: `architecture_docs/21_ROADMAP_WBS_DELIVERY_AND_PROJECT_OPERATIONS.md`
 * sections 21.4, 21.5, 21.10, 21.11, and 21.15.
 *
 * Workstreams define ownership, dependencies, consumers, RACI roles, and
 * milestone span so project operations can reason about delivery coverage.
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

export const WORKSTREAM_REGISTRY_SCHEMA_VERSION = "mebsuta.operations.workstream_registry.v1" as const;

export type WorkstreamRef =
  | "WS-A"
  | "WS-B"
  | "WS-C"
  | "WS-D"
  | "WS-E"
  | "WS-F"
  | "WS-G"
  | "WS-H"
  | "WS-I"
  | "WS-J"
  | "WS-K"
  | "WS-L"
  | "WS-M"
  | "WS-N"
  | "WS-O"
  | "WS-P"
  | "WS-Q";

export interface RaciAssignment {
  readonly responsible: string;
  readonly accountable: string;
  readonly consulted: readonly string[];
  readonly informed: readonly string[];
}

export interface WorkstreamDefinitionInput {
  readonly workstream_ref: WorkstreamRef;
  readonly workstream_name: string;
  readonly owner_category: string;
  readonly primary_scope: string;
  readonly critical_dependency_refs: readonly WorkstreamRef[];
  readonly primary_consumer_refs: readonly WorkstreamRef[];
  readonly milestone_span: readonly MilestoneRef[];
  readonly raci: RaciAssignment;
}

export interface WorkstreamDefinition {
  readonly schema_version: typeof WORKSTREAM_REGISTRY_SCHEMA_VERSION;
  readonly workstream_ref: WorkstreamRef;
  readonly workstream_name: string;
  readonly owner_category: string;
  readonly primary_scope: string;
  readonly critical_dependency_refs: readonly WorkstreamRef[];
  readonly primary_consumer_refs: readonly WorkstreamRef[];
  readonly milestone_span: readonly MilestoneRef[];
  readonly raci: RaciAssignment;
  readonly determinism_hash: string;
}

/**
 * Builds a typed workstream definition and validates ownership coverage.
 */
export function buildWorkstreamDefinition(input: WorkstreamDefinitionInput): WorkstreamDefinition {
  const definition = normalizeWorkstreamDefinition(input);
  const report = validateWorkstreamDefinition(definition);
  if (!report.ok) {
    throw new OperationsContractError("Workstream definition failed validation.", report.issues);
  }
  return definition;
}

export function normalizeWorkstreamDefinition(input: WorkstreamDefinitionInput): WorkstreamDefinition {
  const base = {
    schema_version: WORKSTREAM_REGISTRY_SCHEMA_VERSION,
    workstream_ref: input.workstream_ref,
    workstream_name: normalizeOperationsText(input.workstream_name, 180),
    owner_category: normalizeOperationsText(input.owner_category, 120),
    primary_scope: normalizeOperationsText(input.primary_scope),
    critical_dependency_refs: freezeOperationsArray([...new Set(input.critical_dependency_refs)]),
    primary_consumer_refs: freezeOperationsArray([...new Set(input.primary_consumer_refs)]),
    milestone_span: freezeOperationsArray([...new Set(input.milestone_span)]),
    raci: normalizeRaci(input.raci),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateWorkstreamDefinition(definition: WorkstreamDefinition): OperationsValidationReport {
  const issues: ValidationIssue[] = [];
  validateOperationsRef(definition.workstream_ref, "$.workstream_ref", issues);
  validateOperationsText(definition.workstream_name, "$.workstream_name", true, issues);
  validateOperationsText(definition.owner_category, "$.owner_category", true, issues);
  validateOperationsText(definition.primary_scope, "$.primary_scope", true, issues);
  validateOperationsNonEmptyArray(definition.milestone_span, "$.milestone_span", "WorkstreamMilestonesMissing", issues);
  validateOperationsRefs(definition.critical_dependency_refs, "$.critical_dependency_refs", issues);
  validateOperationsRefs(definition.primary_consumer_refs, "$.primary_consumer_refs", issues);
  validateRaci(definition.raci, "$.raci", issues);
  if (definition.critical_dependency_refs.includes(definition.workstream_ref)) {
    issues.push(operationsIssue("error", "WorkstreamSelfDependency", "$.critical_dependency_refs", "A workstream cannot depend on itself.", "Remove the self dependency."));
  }
  if (definition.primary_consumer_refs.includes(definition.workstream_ref)) {
    issues.push(operationsIssue("warning", "WorkstreamSelfConsumerReview", "$.primary_consumer_refs", "Self-consumption should be explicit only for internal platform loops.", "Confirm or remove the self consumer ref."));
  }
  return buildOperationsValidationReport(makeOperationsRef("workstream_definition_report", definition.workstream_ref), issues, operationsRouteForIssues(issues));
}

export function buildWorkstreamRegistry(inputs: readonly WorkstreamDefinitionInput[]): readonly WorkstreamDefinition[] {
  const registry = freezeOperationsArray(inputs.map(buildWorkstreamDefinition));
  const refs = new Set<WorkstreamRef>();
  for (const definition of registry) {
    if (refs.has(definition.workstream_ref)) {
      throw new OperationsContractError("Workstream registry contains duplicate refs.", [
        operationsIssue("error", "WorkstreamDuplicate", "$.workstreams", "Workstream refs must be unique.", "Remove or rename the duplicate workstream."),
      ]);
    }
    refs.add(definition.workstream_ref);
  }
  return registry;
}

export function defaultWorkstreamRegistry(): readonly WorkstreamDefinition[] {
  return buildWorkstreamRegistry([
    workstreamInput("WS-A", "Architecture And Contracts", "Systems Architecture", "Cross-document consistency, interfaces, traceability.", [], ["WS-P", "WS-Q"], ["M0", "M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8", "M9"]),
    workstreamInput("WS-B", "Simulation And Physics", "Simulation Engineering", "MuJoCo-first world, replay, contacts, disturbances.", ["WS-A"], ["WS-C", "WS-H", "WS-P"], ["M1", "M2", "M9"]),
    workstreamInput("WS-C", "Virtual Hardware", "Robotics Simulation", "Sensors, actuators, calibration, embodiment hardware abstraction.", ["WS-B"], ["WS-E", "WS-M", "WS-J"], ["M1", "M8"]),
    workstreamInput("WS-D", "Embodiment And Kinematics", "Robotics Controls", "Quadruped and humanoid models, frames, reach, gait, IK constraints.", ["WS-A"], ["WS-H", "WS-I"], ["M1", "M2", "M8"]),
    workstreamInput("WS-E", "Perception And Multi-View", "Perception Engineering", "Camera bundles, object hypotheses, occlusion, pose estimates.", ["WS-C"], ["WS-F", "WS-J", "WS-L"], ["M1", "M4", "M9"]),
    workstreamInput("WS-F", "Gemini Cognitive Layer", "AI Integration", "Model adapter, prompts, context budget, structured outputs.", ["WS-E", "WS-O"], ["WS-G", "WS-K", "WS-I"], ["M3", "M9"]),
    workstreamInput("WS-G", "Orchestration", "Agent Runtime", "State machine, event routing, task lifecycle.", ["WS-F", "WS-O"], ["WS-J", "WS-K"], ["M1", "M9"]),
    workstreamInput("WS-H", "Control Execution", "Controls Engineering", "IK, trajectory generation, PD profiles, telemetry.", ["WS-D", "WS-O"], ["WS-I", "WS-J", "WS-K"], ["M2", "M9"]),
    workstreamInput("WS-I", "Manipulation And Tool Primitives", "Robotics Manipulation", "Grasp, place, push, pull, and tool action contracts.", ["WS-H", "WS-O"], ["WS-J", "WS-K"], ["M2", "M8"]),
    workstreamInput("WS-J", "Verification", "QA/Robotics Reasoning", "Certificates, residuals, ambiguity, false-positive guard.", ["WS-E", "WS-H"], ["WS-G", "WS-L", "WS-K"], ["M4", "M9"]),
    workstreamInput("WS-K", "Oops Loop", "Agent Recovery", "Failure diagnosis, correction plans, retry budgets.", ["WS-F", "WS-H", "WS-J", "WS-O"], ["WS-G", "WS-L", "WS-P"], ["M6", "M9"]),
    workstreamInput("WS-L", "RAG Memory", "Memory/AI Systems", "Spatial memory, retrieval, staleness, contradiction.", ["WS-J", "WS-E"], ["WS-F", "WS-K"], ["M5", "M9"]),
    workstreamInput("WS-M", "Acoustic Embodiment", "Audio/Simulation", "Microphones, audio events, localization, routing.", ["WS-C"], ["WS-N", "WS-P"], ["M7", "M9"]),
    workstreamInput("WS-N", "Observability And TTS", "Developer Tools", "Monologue, TTS, dashboards, replay traces.", ["WS-F", "WS-M", "WS-O"], ["WS-Q", "WS-P"], ["M3", "M9"]),
    workstreamInput("WS-O", "Safety Guardrails", "Safety Engineering", "Validators, SafeHold, policies, audit.", ["WS-A"], ["WS-F", "WS-H", "WS-I", "WS-K", "WS-P"], ["M1", "M9"]),
    workstreamInput("WS-P", "QA And Benchmarks", "QA Engineering", "Tests, chaos, benchmark scoring, release gates.", ["WS-A", "WS-O"], ["WS-Q"], ["M0", "M9"]),
    workstreamInput("WS-Q", "Project Operations", "Program Management", "Cadence, risks, milestones, readiness, documentation.", ["WS-A", "WS-P"], [], ["M0", "M9"]),
  ]);
}

export function findWorkstreamByRef(registry: readonly WorkstreamDefinition[], ref: WorkstreamRef): WorkstreamDefinition | undefined {
  return registry.find((definition) => definition.workstream_ref === ref);
}

function workstreamInput(
  workstreamRef: WorkstreamRef,
  workstreamName: string,
  ownerCategory: string,
  primaryScope: string,
  criticalDependencyRefs: readonly WorkstreamRef[],
  primaryConsumerRefs: readonly WorkstreamRef[],
  milestoneSpan: readonly MilestoneRef[],
): WorkstreamDefinitionInput {
  return {
    workstream_ref: workstreamRef,
    workstream_name: workstreamName,
    owner_category: ownerCategory,
    primary_scope: primaryScope,
    critical_dependency_refs: criticalDependencyRefs,
    primary_consumer_refs: primaryConsumerRefs,
    milestone_span: milestoneSpan,
    raci: {
      responsible: ownerCategory,
      accountable: `${ownerCategory} Lead`,
      consulted: ["Systems Architecture", "QA Engineering"],
      informed: ["Program Management"],
    },
  };
}

function normalizeRaci(raci: RaciAssignment): RaciAssignment {
  return Object.freeze({
    responsible: normalizeOperationsText(raci.responsible, 120),
    accountable: normalizeOperationsText(raci.accountable, 120),
    consulted: freezeOperationsArray([...new Set(raci.consulted.map((item) => normalizeOperationsText(item, 120)).filter((item) => item.length > 0))]),
    informed: freezeOperationsArray([...new Set(raci.informed.map((item) => normalizeOperationsText(item, 120)).filter((item) => item.length > 0))]),
  });
}

function validateRaci(raci: RaciAssignment, path: string, issues: ValidationIssue[]): void {
  validateOperationsText(raci.responsible, `${path}.responsible`, true, issues);
  validateOperationsText(raci.accountable, `${path}.accountable`, true, issues);
  validateOperationsNonEmptyArray(raci.consulted, `${path}.consulted`, "RaciConsultedMissing", issues);
  validateOperationsNonEmptyArray(raci.informed, `${path}.informed`, "RaciInformedMissing", issues);
}

export const WORKSTREAM_REGISTRY_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: WORKSTREAM_REGISTRY_SCHEMA_VERSION,
  blueprint: OPERATIONS_BLUEPRINT_REF,
  sections: freezeOperationsArray(["21.4", "21.5", "21.10", "21.11", "21.15"]),
  component: "WorkstreamRegistry",
});
