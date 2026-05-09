/**
 * Risk monitoring event.
 *
 * Blueprint: `architecture_docs/22_RISK_REGISTER_AND_MITIGATION_ARCHITECTURE.md`
 * sections 22.4.2, 22.6.1, 22.6.2, 22.8, and 22.9.2.
 *
 * Monitoring events capture observed trigger signals and deterministically route
 * them to continue, mitigation, SafeHold, HumanReview, or release blocking.
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
  validateRiskNonEmptyArray,
  validateRiskRef,
  validateRiskRefs,
  validateRiskText,
} from "./risk_register_entry";
import type { RiskSeverity, RiskValidationReport } from "./risk_register_entry";

export const RISK_MONITORING_EVENT_SCHEMA_VERSION = "mebsuta.risk.risk_monitoring_event.v1" as const;

export type RiskSignalSource = "prompt" | "provenance" | "perception" | "geometry" | "control" | "verification" | "oops" | "memory" | "audio" | "observability" | "qa" | "operations" | "safety";
export type RiskEventRouteDecision = "continue" | "mitigate" | "safe_hold" | "human_review" | "release_block";
export type PostEventAction = "test_added" | "policy_changed" | "doc_updated" | "bug_filed" | "artifact_quarantined" | "index_rebuilt" | "feature_gate_disabled" | "incident_review";

export interface RiskMonitoringEventInput {
  readonly risk_event_ref: Ref;
  readonly risk_ref: Ref;
  readonly event_time_iso: string;
  readonly trigger_signal: string;
  readonly signal_source: RiskSignalSource;
  readonly source_artifact_refs: readonly Ref[];
  readonly severity_at_detection: RiskSeverity;
  readonly route_decision?: RiskEventRouteDecision;
  readonly post_event_actions: readonly PostEventAction[];
  readonly operator_note?: string;
}

export interface RiskMonitoringEvent {
  readonly schema_version: typeof RISK_MONITORING_EVENT_SCHEMA_VERSION;
  readonly risk_event_ref: Ref;
  readonly risk_ref: Ref;
  readonly event_time_iso: string;
  readonly trigger_signal: string;
  readonly signal_source: RiskSignalSource;
  readonly source_artifact_refs: readonly Ref[];
  readonly severity_at_detection: RiskSeverity;
  readonly route_decision: RiskEventRouteDecision;
  readonly post_event_actions: readonly PostEventAction[];
  readonly operator_note: string;
  readonly determinism_hash: string;
}

/**
 * Builds an immutable monitoring event with a derived route when absent.
 */
export function buildRiskMonitoringEvent(input: RiskMonitoringEventInput): RiskMonitoringEvent {
  const event = normalizeRiskMonitoringEvent(input);
  const report = validateRiskMonitoringEvent(event);
  if (!report.ok) {
    throw new RiskContractError("Risk monitoring event failed validation.", report.issues);
  }
  return event;
}

export function normalizeRiskMonitoringEvent(input: RiskMonitoringEventInput): RiskMonitoringEvent {
  const base = {
    schema_version: RISK_MONITORING_EVENT_SCHEMA_VERSION,
    risk_event_ref: input.risk_event_ref,
    risk_ref: input.risk_ref,
    event_time_iso: input.event_time_iso,
    trigger_signal: normalizeRiskText(input.trigger_signal, 500),
    signal_source: input.signal_source,
    source_artifact_refs: freezeRiskArray([...new Set(input.source_artifact_refs)]),
    severity_at_detection: input.severity_at_detection,
    route_decision: input.route_decision ?? deriveRiskEventRoute(input.severity_at_detection, input.signal_source, input.trigger_signal),
    post_event_actions: freezeRiskArray([...new Set(input.post_event_actions)]),
    operator_note: normalizeRiskText(input.operator_note ?? "", 700),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateRiskMonitoringEvent(event: RiskMonitoringEvent): RiskValidationReport {
  const issues: ValidationIssue[] = [];
  validateRiskRef(event.risk_event_ref, "$.risk_event_ref", issues);
  validateRiskRef(event.risk_ref, "$.risk_ref", issues);
  validateRiskText(event.trigger_signal, "$.trigger_signal", true, issues);
  validateRiskRefs(event.source_artifact_refs, "$.source_artifact_refs", issues);
  validateRiskNonEmptyArray(event.source_artifact_refs, "$.source_artifact_refs", "RiskEventArtifactsMissing", issues);
  validateRiskNonEmptyArray(event.post_event_actions, "$.post_event_actions", "RiskEventActionsMissing", issues);
  if (!Number.isFinite(new Date(event.event_time_iso).getTime())) {
    issues.push(riskIssue("error", "RiskEventTimeInvalid", "$.event_time_iso", "Event time must be valid ISO-8601.", "Use an ISO timestamp captured at detection time."));
  }
  if (event.severity_at_detection === "critical" && event.route_decision !== "safe_hold" && event.route_decision !== "release_block") {
    issues.push(riskIssue("error", "CriticalEventRouteInvalid", "$.route_decision", "Critical events must route to SafeHold or release block.", "Escalate the event before continuing."));
  }
  return buildRiskValidationReport(makeRiskRef("risk_monitoring_event_report", event.risk_event_ref), issues, riskRouteForIssues(issues));
}

export function deriveRiskEventRoute(severity: RiskSeverity, signalSource: RiskSignalSource, triggerSignal: string): RiskEventRouteDecision {
  const normalized = triggerSignal.toLowerCase();
  if (severity === "critical" || /hidden|unsafe|contamination|false success|no-go|release block/u.test(normalized)) {
    return signalSource === "control" || signalSource === "safety" || signalSource === "oops" ? "safe_hold" : "release_block";
  }
  if (severity === "high") {
    return signalSource === "qa" || signalSource === "operations" ? "human_review" : "mitigate";
  }
  if (severity === "medium") {
    return "mitigate";
  }
  return "continue";
}

export function summarizeRiskEvents(events: readonly RiskMonitoringEvent[]): {
  readonly total_events: number;
  readonly release_block_count: number;
  readonly safe_hold_count: number;
  readonly human_review_count: number;
  readonly latest_event_time_iso?: string;
  readonly determinism_hash: string;
} {
  const sortedTimes = events.map((event) => event.event_time_iso).sort();
  const base = {
    total_events: events.length,
    release_block_count: events.filter((event) => event.route_decision === "release_block").length,
    safe_hold_count: events.filter((event) => event.route_decision === "safe_hold").length,
    human_review_count: events.filter((event) => event.route_decision === "human_review").length,
    latest_event_time_iso: sortedTimes.at(-1),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export const RISK_MONITORING_EVENT_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: RISK_MONITORING_EVENT_SCHEMA_VERSION,
  blueprint: RISK_BLUEPRINT_REF,
  sections: freezeRiskArray(["22.4.2", "22.6.1", "22.6.2", "22.8", "22.9.2"]),
  component: "RiskMonitoringEvent",
});
