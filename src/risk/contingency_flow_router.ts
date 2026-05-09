/**
 * Contingency flow router.
 *
 * Blueprint: `architecture_docs/22_RISK_REGISTER_AND_MITIGATION_ARCHITECTURE.md`
 * section 22.8.
 *
 * The router maps materialized risk events to deterministic contingency flows
 * such as quarantine, SafeHold, memory isolation, and release blocking.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  RISK_BLUEPRINT_REF,
  RiskContractError,
  buildRiskValidationReport,
  freezeRiskArray,
  makeRiskRef,
  normalizeRiskText,
  riskIssue,
  riskRouteForIssues,
  uniqueRiskRefs,
  uniqueRiskStrings,
  validateRiskNonEmptyArray,
  validateRiskRef,
  validateRiskRefs,
  validateRiskText,
} from "./risk_register_entry";
import type { RiskSeverity, RiskValidationReport } from "./risk_register_entry";
import type { RiskEventRouteDecision, RiskMonitoringEvent } from "./risk_monitoring_event";

export const CONTINGENCY_FLOW_ROUTER_SCHEMA_VERSION = "mebsuta.risk.contingency_flow_router.v1" as const;

export type ContingencyFlowKind = "hidden_truth_leak" | "false_success_certificate" | "unsafe_runtime_action" | "memory_contamination" | "retry_budget_exhaustion" | "release_governance";

export interface ContingencyFlowInput {
  readonly flow_ref: Ref;
  readonly flow_kind: ContingencyFlowKind;
  readonly handled_risk_refs: readonly Ref[];
  readonly ordered_steps: readonly string[];
  readonly terminal_route: RiskEventRouteDecision;
  readonly release_blocking: boolean;
  readonly evidence_required_refs: readonly Ref[];
}

export interface ContingencyFlow {
  readonly schema_version: typeof CONTINGENCY_FLOW_ROUTER_SCHEMA_VERSION;
  readonly flow_ref: Ref;
  readonly flow_kind: ContingencyFlowKind;
  readonly handled_risk_refs: readonly Ref[];
  readonly ordered_steps: readonly string[];
  readonly terminal_route: RiskEventRouteDecision;
  readonly release_blocking: boolean;
  readonly evidence_required_refs: readonly Ref[];
  readonly determinism_hash: string;
}

export interface ContingencyRouteDecision {
  readonly decision_ref: Ref;
  readonly risk_event_ref: Ref;
  readonly selected_flow_ref: Ref;
  readonly selected_flow_kind: ContingencyFlowKind;
  readonly terminal_route: RiskEventRouteDecision;
  readonly ordered_steps: readonly string[];
  readonly missing_evidence_refs: readonly Ref[];
  readonly release_blocking: boolean;
  readonly determinism_hash: string;
}

/**
 * Builds a validated contingency flow.
 */
export function buildContingencyFlow(input: ContingencyFlowInput): ContingencyFlow {
  const flow = normalizeContingencyFlow(input);
  const report = validateContingencyFlow(flow);
  if (!report.ok) {
    throw new RiskContractError("Contingency flow failed validation.", report.issues);
  }
  return flow;
}

export function normalizeContingencyFlow(input: ContingencyFlowInput): ContingencyFlow {
  const base = {
    schema_version: CONTINGENCY_FLOW_ROUTER_SCHEMA_VERSION,
    flow_ref: input.flow_ref,
    flow_kind: input.flow_kind,
    handled_risk_refs: uniqueRiskRefs(input.handled_risk_refs),
    ordered_steps: uniqueRiskStrings(input.ordered_steps),
    terminal_route: input.terminal_route,
    release_blocking: input.release_blocking,
    evidence_required_refs: uniqueRiskRefs(input.evidence_required_refs),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateContingencyFlow(flow: ContingencyFlow): RiskValidationReport {
  const issues: ValidationIssue[] = [];
  validateRiskRef(flow.flow_ref, "$.flow_ref", issues);
  validateRiskNonEmptyArray(flow.handled_risk_refs, "$.handled_risk_refs", "FlowRiskRefsMissing", issues);
  validateRiskRefs(flow.handled_risk_refs, "$.handled_risk_refs", issues);
  validateRiskNonEmptyArray(flow.ordered_steps, "$.ordered_steps", "FlowStepsMissing", issues);
  validateRiskRefs(flow.evidence_required_refs, "$.evidence_required_refs", issues);
  flow.ordered_steps.forEach((step, index) => validateRiskText(step, `$.ordered_steps[${index}]`, true, issues));
  if (flow.release_blocking && flow.terminal_route !== "release_block" && flow.terminal_route !== "safe_hold") {
    issues.push(riskIssue("error", "BlockingFlowRouteInvalid", "$.terminal_route", "Release-blocking flows must terminate in release block or SafeHold.", "Escalate the terminal route."));
  }
  return buildRiskValidationReport(makeRiskRef("contingency_flow_report", flow.flow_ref), issues, riskRouteForIssues(issues));
}

export function defaultContingencyFlows(): readonly ContingencyFlow[] {
  return freezeRiskArray([
    flow("hidden_truth_leak_flow", "hidden_truth_leak", ["R-001", "R-002"], ["Reject or quarantine the artifact.", "Block any pending prompt or execution route.", "Emit critical observability event.", "Mark QA run invalid.", "Add regression coverage before release review."], "release_block", true, ["provenance_report", "quarantine_record", "regression_test_ref"]),
    flow("false_success_certificate_flow", "false_success_certificate", ["R-003", "R-024", "R-027"], ["Link certificate, view bundle, residual report, and benchmark contradiction.", "Review false-positive class.", "Update guard or tolerance policy.", "Add golden scenario.", "Invalidate affected benchmark runs."], "release_block", true, ["certificate_ref", "view_bundle_ref", "benchmark_report_ref"]),
    flow("unsafe_runtime_action_flow", "unsafe_runtime_action", ["R-004", "R-008", "R-025", "R-032"], ["Enter SafeHold immediately.", "Announce stop reason through approved observability path.", "Preserve runtime evidence.", "Select HumanReview or controlled retreat.", "Add safety regression."], "safe_hold", true, ["safety_event_ref", "runtime_trace_ref", "review_record_ref"]),
    flow("memory_contamination_flow", "memory_contamination", ["R-005", "R-033", "R-034"], ["Quarantine the memory record.", "Invalidate related retrieval contexts.", "Rebuild affected indexes.", "Check influenced runtime decisions.", "Expand memory write gate tests."], "release_block", true, ["memory_record_ref", "audit_report_ref", "index_rebuild_ref"]),
    flow("retry_budget_exhaustion_flow", "retry_budget_exhaustion", ["R-029", "R-030"], ["Terminate correction episode.", "Preserve evidence bundle.", "Route to HumanReview.", "Attach retry budget report.", "Review recovery policy before resuming."], "human_review", false, ["oops_episode_ref", "retry_budget_report_ref"]),
    flow("release_governance_flow", "release_governance", ["R-040", "R-042", "R-043", "R-046"], ["Freeze release decision.", "Collect gate evidence.", "Resolve blockers or de-scope feature.", "Record leadership review if schedule pressure exists.", "Re-run readiness gate."], "release_block", true, ["release_readiness_report", "gate_evidence_bundle"]),
  ]);
}

export function routeRiskEventToContingency(event: RiskMonitoringEvent, flows: readonly ContingencyFlow[] = defaultContingencyFlows(), availableEvidenceRefs: readonly Ref[] = []): ContingencyRouteDecision {
  const selected = selectFlowForEvent(event, flows);
  const available = new Set(availableEvidenceRefs);
  const missing = selected.evidence_required_refs.filter((ref) => !available.has(ref));
  const base = {
    decision_ref: makeRiskRef("contingency_decision", event.risk_event_ref),
    risk_event_ref: event.risk_event_ref,
    selected_flow_ref: selected.flow_ref,
    selected_flow_kind: selected.flow_kind,
    terminal_route: severityRoute(event.severity_at_detection, selected.terminal_route),
    ordered_steps: selected.ordered_steps,
    missing_evidence_refs: uniqueRiskRefs(missing),
    release_blocking: selected.release_blocking || event.route_decision === "release_block",
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function selectFlowForEvent(event: RiskMonitoringEvent, flows: readonly ContingencyFlow[]): ContingencyFlow {
  return flows.find((flowItem) => flowItem.handled_risk_refs.includes(event.risk_ref)) ?? flows.find((flowItem) => flowItem.flow_kind === "release_governance") ?? defaultContingencyFlows()[5];
}

function severityRoute(severity: RiskSeverity, route: RiskEventRouteDecision): RiskEventRouteDecision {
  if (severity === "critical" && route === "continue") {
    return "release_block";
  }
  return route;
}

function flow(flowRef: Ref, kind: ContingencyFlowKind, risks: readonly Ref[], steps: readonly string[], terminalRoute: RiskEventRouteDecision, releaseBlocking: boolean, evidenceRefs: readonly Ref[]): ContingencyFlow {
  return buildContingencyFlow({
    flow_ref: flowRef,
    flow_kind: kind,
    handled_risk_refs: risks,
    ordered_steps: steps,
    terminal_route: terminalRoute,
    release_blocking: releaseBlocking,
    evidence_required_refs: evidenceRefs,
  });
}

export const CONTINGENCY_FLOW_ROUTER_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: CONTINGENCY_FLOW_ROUTER_SCHEMA_VERSION,
  blueprint: RISK_BLUEPRINT_REF,
  sections: freezeRiskArray(["22.8"]),
  component: "ContingencyFlowRouter",
});
