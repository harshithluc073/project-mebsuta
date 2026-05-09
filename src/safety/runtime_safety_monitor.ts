/**
 * Runtime safety monitor for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/18_SAFETY_GUARDRAILS_VALIDATION_AND_POLICY.md`
 * sections 18.5.1, 18.6, 18.7.3, 18.13, 18.15.4, 18.16.2, 18.17.3, and 18.21.
 *
 * The monitor converts force, speed, contact, slip, visibility, tool, balance,
 * controller, and audio telemetry into deterministic runtime safety events and
 * route decisions.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  buildRiskFinding,
  buildValidationReport,
  clamp,
  freezeArray,
  makeIssue,
  makeSafetyRef,
  round6,
  uniqueRefs,
  validateFiniteNumber,
  validateRef,
  validateSafeText,
} from "./safety_policy_registry";
import type {
  ActiveSafetyPolicySet,
  ImmediateSafetyAction,
  RuntimeSafetyEvent,
  RuntimeSafetyEventClass,
  SafetyRoute,
  SafetyRouteDecision,
  SafetyRiskFinding,
  SafetyValidationReport,
  SafetyValidationRequest,
} from "./safety_policy_registry";

export const RUNTIME_SAFETY_MONITOR_SCHEMA_VERSION = "mebsuta.runtime_safety_monitor.v1" as const;

export interface RuntimeTelemetrySample {
  readonly telemetry_ref: Ref;
  readonly event_class: RuntimeSafetyEventClass;
  readonly measured_value: number;
  readonly threshold_value: number;
  readonly unit: string;
  readonly observed_at_ms: number;
  readonly evidence_refs: readonly Ref[];
  readonly summary: string;
}

export interface RuntimeSafetyEnvelope {
  readonly envelope_ref: Ref;
  readonly active_policy_set: ActiveSafetyPolicySet;
  readonly validation_request: SafetyValidationRequest;
  readonly sample_staleness_limit_ms: number;
}

export interface RuntimeSafetyMonitorReport {
  readonly runtime_monitor_report_ref: Ref;
  readonly runtime_events: readonly RuntimeSafetyEvent[];
  readonly validation_report: SafetyValidationReport;
  readonly route_decision: SafetyRouteDecision;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

/**
 * Watches execution telemetry and routes anomalies conservatively.
 */
export class RuntimeSafetyMonitor {
  public monitorRuntimeSafety(executionHandleRef: Ref, samples: readonly RuntimeTelemetrySample[], activeSafetyEnvelope: RuntimeSafetyEnvelope, nowMs: number): RuntimeSafetyMonitorReport {
    const issues: ValidationIssue[] = [];
    validateRef(executionHandleRef, "$.execution_handle_ref", issues);
    validateEnvelope(activeSafetyEnvelope, issues);
    const events = samples.map((sample, index) => buildRuntimeEvent(executionHandleRef, sample, index, activeSafetyEnvelope, nowMs, issues));
    const findings = events.filter((event) => event.immediate_action !== "Continue").map((event) => finding(activeSafetyEnvelope, event));
    const validationReport = buildValidationReport({
      request_ref: activeSafetyEnvelope.validation_request.safety_validation_request_ref,
      validator_ref: "safety_monitor:runtime",
      overall_decision: findings.some((item) => item.recommended_route === "SafeHold") ? "safe_hold_required" : findings.length > 0 ? "accepted_with_restrictions" : "accepted",
      risk_findings: findings,
      restriction_set: findings.length > 0 ? activeSafetyEnvelope.active_policy_set.default_restrictions : freezeArray([]),
      rejection_reasons: findings.filter((item) => item.risk_severity === "critical" || item.risk_severity === "blocking").map((item) => item.risk_description),
      required_additional_evidence: events.some((event) => event.event_class === "visibility" && event.immediate_action !== "Continue") ? freezeArray(["Restore required sensor visibility before resuming motion."]) : freezeArray([]),
      safe_alternative_hints: freezeArray(["Slow, pause, or enter SafeHold according to the runtime event severity."]),
      audit_refs: uniqueRefs([executionHandleRef, ...events.map((event) => event.runtime_safety_event_ref), ...samples.flatMap((sample) => sample.evidence_refs)]),
      issues,
    });
    const routeDecision = this.handleRuntimeSafetyEvent(events, activeSafetyEnvelope.validation_request);
    const base = {
      runtime_monitor_report_ref: makeSafetyRef("runtime_monitor_report", executionHandleRef, nowMs),
      runtime_events: freezeArray(events),
      validation_report: validationReport,
      route_decision: routeDecision,
      issues: freezeArray(issues),
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }

  public handleRuntimeSafetyEvent(runtimeSafetyEvents: readonly RuntimeSafetyEvent[], activeTaskState: SafetyValidationRequest): SafetyRouteDecision {
    const ordered = [...runtimeSafetyEvents].sort((left, right) => actionRank(right.immediate_action) - actionRank(left.immediate_action) || left.runtime_safety_event_ref.localeCompare(right.runtime_safety_event_ref));
    const dominant = ordered[0];
    const finalRoute: SafetyRoute = dominant === undefined
      ? "Continue"
      : dominant.immediate_action === "SafeHold" || dominant.immediate_action === "Abort"
        ? "SafeHold"
        : dominant.immediate_action === "Pause"
          ? "Reobserve"
          : dominant.immediate_action === "Slow"
            ? "ContinueRestricted"
            : "Continue";
    const base = {
      safety_route_decision_ref: makeSafetyRef("runtime_safety_route", activeTaskState.safety_validation_request_ref, finalRoute),
      source_report_refs: uniqueRefs(runtimeSafetyEvents.map((event) => event.runtime_safety_event_ref)),
      final_route: finalRoute,
      restriction_set_refs: freezeArray([]),
      blocked_artifact_refs: finalRoute === "SafeHold" ? freezeArray([activeTaskState.artifact_ref]) : freezeArray([]),
      human_readable_reason: dominant === undefined ? "Runtime safety monitor saw no anomaly." : dominant.measured_signal_summary,
      audit_replay_refs: uniqueRefs(runtimeSafetyEvents.flatMap((event) => [event.runtime_safety_event_ref, ...event.evidence_refs])),
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function createRuntimeSafetyMonitor(): RuntimeSafetyMonitor {
  return new RuntimeSafetyMonitor();
}

function validateEnvelope(envelope: RuntimeSafetyEnvelope, issues: ValidationIssue[]): void {
  validateRef(envelope.envelope_ref, "$.active_safety_envelope.envelope_ref", issues);
  validateFiniteNumber(envelope.sample_staleness_limit_ms, "$.active_safety_envelope.sample_staleness_limit_ms", 1, undefined, issues);
}

function buildRuntimeEvent(executionHandleRef: Ref, sample: RuntimeTelemetrySample, index: number, envelope: RuntimeSafetyEnvelope, nowMs: number, issues: ValidationIssue[]): RuntimeSafetyEvent {
  validateSample(sample, index, issues);
  const stale = nowMs - sample.observed_at_ms > envelope.sample_staleness_limit_ms;
  if (stale) {
    issues.push(makeIssue("warning", "RuntimeSafetySampleStale", `$.samples[${index}].observed_at_ms`, "Runtime telemetry sample is stale.", "Refresh telemetry or slow execution."));
  }
  const ratio = sample.threshold_value <= 0 ? Number.POSITIVE_INFINITY : sample.measured_value / sample.threshold_value;
  const action = chooseAction(sample, ratio, stale);
  const severity: RuntimeSafetyEvent["event_severity"] = action === "SafeHold" || action === "Abort" ? "critical" : action === "Pause" ? "high" : action === "Slow" ? "medium" : "low";
  const base = {
    runtime_safety_event_ref: makeSafetyRef("runtime_safety_event", executionHandleRef, sample.telemetry_ref, action),
    execution_handle_ref: executionHandleRef,
    event_class: sample.event_class,
    event_severity: severity,
    measured_signal_summary: `${sample.event_class} measured ${round6(sample.measured_value)} ${sample.unit} against ${round6(sample.threshold_value)} ${sample.unit}: ${sample.summary}`,
    threshold_ref: makeSafetyRef("runtime_threshold", envelope.envelope_ref, sample.event_class, sample.threshold_value),
    immediate_action: action,
    evidence_refs: uniqueRefs([sample.telemetry_ref, ...sample.evidence_refs]),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function validateSample(sample: RuntimeTelemetrySample, index: number, issues: ValidationIssue[]): void {
  const path = `$.samples[${index}]`;
  validateRef(sample.telemetry_ref, `${path}.telemetry_ref`, issues);
  validateSafeText(sample.summary, `${path}.summary`, true, issues);
  validateFiniteNumber(sample.measured_value, `${path}.measured_value`, 0, undefined, issues);
  validateFiniteNumber(sample.threshold_value, `${path}.threshold_value`, 0, undefined, issues);
  validateFiniteNumber(sample.observed_at_ms, `${path}.observed_at_ms`, 0, undefined, issues);
  for (const [evidenceIndex, ref] of sample.evidence_refs.entries()) {
    validateRef(ref, `${path}.evidence_refs[${evidenceIndex}]`, issues);
  }
}

function chooseAction(sample: RuntimeTelemetrySample, ratio: number, stale: boolean): ImmediateSafetyAction {
  if (stale && (sample.event_class === "visibility" || sample.event_class === "controller")) {
    return "Pause";
  }
  if (sample.event_class === "audio" && ratio >= 1.2) {
    return "Pause";
  }
  if (ratio >= 1.5 || sample.event_class === "force" && ratio >= 1 || sample.event_class === "contact" && ratio >= 1.25) {
    return "SafeHold";
  }
  if (ratio >= 1) {
    return "Pause";
  }
  if (ratio >= 0.75) {
    return "Slow";
  }
  return "Continue";
}

function finding(envelope: RuntimeSafetyEnvelope, event: RuntimeSafetyEvent): SafetyRiskFinding {
  const riskClass = event.event_class === "visibility" ? "occlusion" : event.event_class === "controller" ? "contact" : event.event_class === "slip" ? "contact" : event.event_class;
  return buildRiskFinding({
    risk_finding_ref: makeSafetyRef("risk_finding", event.runtime_safety_event_ref),
    risk_class: riskClass,
    risk_severity: event.event_severity === "critical" ? "critical" : event.event_severity === "high" ? "high" : "medium",
    risk_description: event.measured_signal_summary,
    evidence_refs: event.evidence_refs,
    policy_refs: envelope.active_policy_set.policy_precedence,
    recommended_restriction: envelope.active_policy_set.default_restrictions,
    recommended_route: event.immediate_action === "SafeHold" || event.immediate_action === "Abort" ? "SafeHold" : event.immediate_action === "Pause" ? "Reobserve" : "ContinueRestricted",
  });
}

function actionRank(action: ImmediateSafetyAction): number {
  switch (action) {
    case "SafeHold":
      return 5;
    case "Abort":
      return 4;
    case "Pause":
      return 3;
    case "Slow":
      return 2;
    case "Continue":
      return 1;
  }
}

export function normalizedRuntimeRisk(sample: RuntimeTelemetrySample): number {
  return sample.threshold_value <= 0 ? 1 : clamp(sample.measured_value / sample.threshold_value, 0, 2) / 2;
}

export const RUNTIME_SAFETY_MONITOR_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: RUNTIME_SAFETY_MONITOR_SCHEMA_VERSION,
  blueprint: "architecture_docs/18_SAFETY_GUARDRAILS_VALIDATION_AND_POLICY.md",
  sections: freezeArray(["18.5.1", "18.6", "18.7.3", "18.13", "18.15.4", "18.16.2", "18.17.3", "18.21"]),
  component: "RuntimeSafetyMonitor",
  determinism_hash: computeDeterminismHash("runtime safety monitor alignment"),
});
